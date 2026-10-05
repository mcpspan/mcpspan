//! Measuring the tools of an rmcp server.

use std::any::Any;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};

use rmcp::handler::server::tool::{DynCallToolHandler, ToolCallContext, ToolRoute};
use rmcp::model::{CallToolRequestParams, CallToolResponse, CallToolResult, ErrorCode, JsonObject, Tool};
use rmcp::service::{MaybeSendFuture, RequestContext};
use rmcp::{ErrorData, RoleServer, ServerHandler};

use crate::collector::{self, Call, Outcome};
use crate::text;

/// The text rmcp gives arguments it could not deserialize into a tool's parameters, before any tool code runs.
/// rmcp keeps its own copy private; the conformance suite fails if the two ever differ.
const ARGUMENTS_REFUSED: &str = "failed to deserialize parameters:";
/// What rmcp's tool router answers for a tool it does not have, or has disabled.
const UNKNOWN_TOOL: &str = "tool not found";
/// Connections remembered per server over HTTP. Past it the oldest is forgotten.
const MAX_SESSIONS: usize = 1_000;

/// Marks a request an instrumented server is measuring, so a tracked tool inside it counts nothing twice.
#[derive(Clone, Copy)]
struct Measured;

/// A tool's name, for [`Instrumented::exclude`]: the [`Tool`] itself, as `#[tool]` generates it with
/// `Self::<tool>_tool_attr()`, or the name as text.
pub trait ToolName {
    /// The name the tool is called by.
    fn tool_name(&self) -> &str;
}

impl ToolName for Tool {
    fn tool_name(&self) -> &str {
        &self.name
    }
}

impl ToolName for str {
    fn tool_name(&self) -> &str {
        self
    }
}

impl ToolName for String {
    fn tool_name(&self) -> &str {
        self
    }
}

impl<T: ToolName + ?Sized> ToolName for &T {
    fn tool_name(&self) -> &str {
        (**self).tool_name()
    }
}

/// An rmcp server with its tools measured. Made by [`instrument`]; serve it as the server it wraps.
pub struct Instrumented<S> {
    pub(crate) inner: S,
    excluded: HashSet<String>,
    // Our own identifier for the connection, made at its first call.
    session: OnceLock<String>,
    // Over HTTP, one of ours per transport session, never derived from it.
    http_sessions: Mutex<(HashMap<String, String>, VecDeque<String>)>,
    over_http: std::sync::atomic::AtomicBool,
    // The version the server gives itself, read from `get_info` at its first call.
    server_version: OnceLock<Option<String>>,
}

/// Measures every tool on an rmcp server, whether it was added before this call or after.
///
/// ```no_run
/// # use rmcp::{ServerHandler, ServiceExt};
/// # #[derive(Clone)] struct Flights;
/// # impl ServerHandler for Flights {}
/// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
/// let _mcpspan = mcpspan::configure(mcpspan::Options::default());
/// let server = mcpspan::instrument(Flights).serve(rmcp::transport::stdio()).await?;
/// server.waiting().await?;
/// # Ok(()) }
/// ```
///
/// Without [`configure`](crate::configure) first, the settings are read from the environment. Each tool returns
/// and fails exactly as it did before, and every other request passes through untouched.
pub fn instrument<S: ServerHandler>(server: S) -> Instrumented<S> {
    if !collector::collecting() {
        collector::configure_from_environment();
    }
    Instrumented {
        inner: server,
        excluded: HashSet::new(),
        session: OnceLock::new(),
        http_sessions: Mutex::new((HashMap::new(), VecDeque::new())),
        over_http: std::sync::atomic::AtomicBool::new(false),
        server_version: OnceLock::new(),
    }
}

impl<S> Instrumented<S> {
    /// Leaves a tool out: its calls, refused ones included, are not recorded.
    ///
    /// ```ignore
    /// mcpspan::instrument(Flights::new()).exclude(Flights::health_check_tool_attr())
    /// ```
    ///
    /// For tools called by machinery rather than by an agent, such as a health check, which would otherwise drag
    /// the whole server's error rate and response time towards its own.
    pub fn exclude(mut self, tool: impl ToolName) -> Self {
        self.excluded.insert(tool.tool_name().to_owned());
        self
    }

    /// The server this wraps.
    pub fn inner(&self) -> &S {
        &self.inner
    }

    fn session_for(&self, context: &RequestContext<RoleServer>) -> Option<String> {
        let Some(parts) = context.extensions.get::<http::request::Parts>() else {
            // No HTTP request behind it: stdio, or another transport of one connection.
            return Some(self.session.get_or_init(|| uuid::Uuid::new_v4().to_string()).clone());
        };
        self.over_http.store(true, std::sync::atomic::Ordering::Relaxed);
        // Without a transport session (stateless, and every endpoint on 2026-07-28), no session: a server may be
        // built per request, and each call would be a session of its own.
        let transport = parts.headers.get("mcp-session-id")?.to_str().ok()?;
        let mut guard = self
            .http_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (ids, order) = &mut *guard;
        if let Some(id) = ids.get(transport) {
            return Some(id.clone());
        }
        if order.len() >= MAX_SESSIONS
            && let Some(oldest) = order.pop_front()
        {
            ids.remove(&oldest);
        }
        let id = uuid::Uuid::new_v4().to_string();
        ids.insert(transport.to_owned(), id.clone());
        order.push_back(transport.to_owned());
        Some(id)
    }
}

impl<S> Drop for Instrumented<S> {
    /// A stdio server ends when its client leaves, and the process with it: what is queued goes now.
    fn drop(&mut self) {
        if self.session.get().is_some() && !self.over_http.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = catch_unwind(collector::flush);
        }
    }
}

impl<S: ServerHandler> Instrumented<S> {
    pub(crate) fn begin(
        &self,
        name: &str,
        arguments: Option<&JsonObject>,
        context: &RequestContext<RoleServer>,
    ) -> Option<Call> {
        if self.excluded.contains(name) || !collector::collecting() {
            return None;
        }
        catch_unwind(AssertUnwindSafe(|| {
            let server_version = self
                .server_version
                .get_or_init(|| server_version_of(&self.inner.get_info()));
            collector::begin(
                name,
                arguments,
                context.client_info().as_ref(),
                server_version.as_deref(),
                self.session_for(context),
            )
        }))
        .ok()
        .flatten()
    }

    /// Calls the server's own `call_tool`, and records how it went.
    pub(crate) fn measure(
        &self,
        request: CallToolRequestParams,
        mut context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, ErrorData>> + MaybeSendFuture + '_ {
        context.extensions.insert(Measured);
        let call = self.begin(&request.name, request.arguments.as_ref(), &context);
        let answer = self.inner.call_tool(request, context);
        async move {
            let Some(call) = call else {
                return answer.await;
            };
            settle(call, CatchUnwind(Box::pin(answer)).await)
        }
    }
}

/// Records how a call ended, and hands back its answer, or its panic, unchanged.
fn settle(
    call: Call,
    answer: Result<Result<CallToolResponse, ErrorData>, Box<dyn Any + Send>>,
) -> Result<CallToolResponse, ErrorData> {
    match answer {
        Ok(result) => {
            if let Some(outcome) = from_response(&result) {
                // Only an answer the tool gave: arguments rmcp refused come back as a result too.
                let size = match (&result, &outcome) {
                    (Ok(CallToolResponse::Complete(answer)), Outcome::Success | Outcome::Result { .. }) => {
                        collector::response_bytes(answer)
                    }
                    _ => None,
                };
                collector::record_answered(call, outcome, size);
            }
            result
        }
        Err(panic) => {
            collector::record(call, from_panic(&*panic));
            resume_unwind(panic)
        }
    }
}

/// Measures one tool, for a server [`instrument`] does not cover:
///
/// ```ignore
/// let router = ToolRouter::new().with_route(mcpspan::track(Flights::search_flights_tool_route()));
/// ```
///
/// On an instrumented server a tracked tool is counted once.
pub fn track<S: Send + Sync + 'static>(mut route: ToolRoute<S>) -> ToolRoute<S> {
    let inner = Arc::clone(&route.call);
    let tracked: Arc<DynCallToolHandler<S>> = Arc::new(move |context: ToolCallContext<'_, S>| {
        let call = if context.request_context.extensions.get::<Measured>().is_some() || !collector::collecting() {
            None
        } else {
            catch_unwind(AssertUnwindSafe(|| {
                let client = context.request_context.client_info();
                // Recorded by hand, the call cannot see its connection, and carries no session, nor the server's
                // own version: only one the SDK was told.
                collector::begin(context.name(), context.arguments.as_ref(), client.as_ref(), None, None)
            }))
            .ok()
            .flatten()
        };
        let answer = inner(context);
        let Some(call) = call else {
            return answer;
        };
        Box::pin(async move { settle(call, CatchUnwind(answer).await) })
    });
    route.call = tracked;
    route
}

/// The version a server gives itself, unless it gave none: rmcp then fills in its own name and version.
fn server_version_of(info: &rmcp::model::ServerConfig) -> Option<String> {
    (info.server_info.name != "rmcp").then(|| info.server_info.version.clone())
}

/// How a `tools/call` answered, or `None` for an answer that does not settle the call: an interim result asking
/// the client for input, or a task the client polls for the result.
fn from_response(answer: &Result<CallToolResponse, ErrorData>) -> Option<Outcome> {
    match answer {
        Ok(CallToolResponse::Complete(result)) => Some(from_result(result)),
        Ok(_) => None,
        Err(error) => Some(from_error(error)),
    }
}

fn from_result(result: &CallToolResult) -> Outcome {
    if result.is_error != Some(true) {
        return Outcome::Success;
    }
    let texts: Vec<&str> = result
        .content
        .iter()
        .filter_map(|block| block.as_text())
        .map(|t| t.text.as_str())
        .collect();
    // rmcp turns arguments it cannot deserialize into an error result with this text, before the tool runs.
    if let [only] = texts.as_slice()
        && only.starts_with(ARGUMENTS_REFUSED)
    {
        return Outcome::Arguments;
    }
    // Only text is read: images and binary content carry nothing worth storing.
    Outcome::Result {
        message: text::truncate(texts.join(" ").trim(), text::MAX_RESULT_MESSAGE),
    }
}

fn from_error(error: &ErrorData) -> Outcome {
    if error.code == ErrorCode::INVALID_PARAMS {
        if error.message == UNKNOWN_TOOL {
            return Outcome::UnknownTool;
        }
        // A tracked tool sees the refusal before the router turns it into a result.
        if error.message.starts_with(ARGUMENTS_REFUSED) {
            return Outcome::Arguments;
        }
    }
    Outcome::Exception {
        error_type: error_type(error.code),
        message: text::truncate(&error.message, text::MAX_EXCEPTION_MESSAGE),
    }
}

/// A Rust tool fails exceptionally with an [`ErrorData`], which has no type of its own to name; its code says
/// what kind of failure it is.
pub(crate) fn error_type(code: ErrorCode) -> String {
    match code {
        ErrorCode::PARSE_ERROR => "ParseError".into(),
        ErrorCode::INVALID_REQUEST => "InvalidRequest".into(),
        ErrorCode::METHOD_NOT_FOUND => "MethodNotFound".into(),
        ErrorCode::INVALID_PARAMS => "InvalidParams".into(),
        ErrorCode::INTERNAL_ERROR => "InternalError".into(),
        ErrorCode::RESOURCE_NOT_FOUND => "ResourceNotFound".into(),
        ErrorCode(code) => format!("ErrorData({code})"),
    }
}

pub(crate) fn from_panic(panic: &(dyn Any + Send)) -> Outcome {
    let message = panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or_default();
    Outcome::Exception {
        error_type: "panic".into(),
        message: text::truncate(message, text::MAX_EXCEPTION_MESSAGE),
    }
}

/// A future that reports a panic while polling it, rather than unwinding through the caller: the call is
/// recorded, and the panic then resumed unchanged.
pub(crate) struct CatchUnwind<F>(pub(crate) F);

impl<F: Future + Unpin> Future for CatchUnwind<F> {
    type Output = Result<F::Output, Box<dyn Any + Send>>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let future = Pin::new(&mut self.0);
        match catch_unwind(AssertUnwindSafe(|| future.poll(cx))) {
            Ok(Poll::Pending) => Poll::Pending,
            Ok(Poll::Ready(output)) => Poll::Ready(Ok(output)),
            Err(panic) => Poll::Ready(Err(panic)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::ContentBlock;

    #[test]
    fn classifies_what_rmcp_answers() {
        let refused = CallToolResult::error(vec![ContentBlock::text(
            "failed to deserialize parameters: missing field",
        )]);
        assert_eq!(from_result(&refused), Outcome::Arguments);

        let reported = CallToolResult::error(vec![ContentBlock::text("No flights found")]);
        assert_eq!(
            from_result(&reported),
            Outcome::Result {
                message: "No flights found".into()
            }
        );

        assert_eq!(
            from_error(&ErrorData::invalid_params("tool not found", None)),
            Outcome::UnknownTool
        );
        assert_eq!(
            from_error(&ErrorData::internal_error("boom", None)),
            Outcome::Exception {
                error_type: "InternalError".into(),
                message: "boom".into()
            }
        );
        assert_eq!(
            from_error(&ErrorData::new(ErrorCode(-32001), "slow", None)),
            Outcome::Exception {
                error_type: "ErrorData(-32001)".into(),
                message: "slow".into()
            }
        );
    }
}
