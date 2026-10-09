//! The one configuration a process runs with, and recording calls under it.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Instant, SystemTime};

use serde_json::{Map, Value};

use crate::event::Event;
use crate::options::{Options, Resolved};
use crate::reporter::Reporter;
use crate::text;
use crate::transport::{self, Sender};

struct Running {
    reporter: Arc<Reporter>,
    settings: Resolved,
    generation: u64,
}

struct Global {
    running: Option<Running>,
    generation: u64,
}

/// Whether the missing endpoint has been mentioned in this process: once is enough.
pub(crate) static SAID_NO_ENDPOINT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

static GLOBAL: Mutex<Global> = Mutex::new(Global {
    running: None,
    generation: 0,
});

fn global() -> MutexGuard<'static, Global> {
    GLOBAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Delivers what is queued when it goes out of scope. Returned by [`configure`](crate::configure); keep it alive
/// for as long as the server runs, usually by binding it in `main`:
///
/// ```no_run
/// let _mcpspan = mcpspan::configure(mcpspan::Options::default());
/// ```
///
/// Rust runs nothing when a process ends, so without this what is queued when `main` returns is lost. Binding it
/// to `_` drops it at once, and stops collecting there and then.
#[must_use = "collecting stops when the guard is dropped; bind it, as `let _mcpspan = ...`"]
pub struct Guard {
    generation: Option<u64>,
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(generation) = self.generation {
            stop(Some(generation));
        }
    }
}

impl std::fmt::Debug for Guard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Guard").finish_non_exhaustive()
    }
}

/// Starts collecting, or stops if there is no key to collect with.
///
/// Called again with the same settings, it changes nothing and returns a guard that does nothing, so a server
/// built per request can call it every time. Different settings replace the running configuration, delivering
/// what it held. It never panics: it runs as a server starts, and a mistyped setting must not be why a server
/// fails to.
pub fn configure(options: Options) -> Guard {
    configure_with(options, None)
}

pub(crate) fn configure_with(options: Options, send: Option<Sender>) -> Guard {
    let started = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(options, send)));
    Guard {
        generation: started.ok().flatten(),
    }
}

fn start(options: Options, send: Option<Sender>) -> Option<u64> {
    let next = Resolved::from(&options);

    let previous = {
        let mut global = global();
        if global.running.as_ref().is_some_and(|running| running.settings == next) {
            return None;
        }
        global.running.take()
    };
    if let Some(previous) = previous {
        previous.reporter.stop();
    }

    // No key is a normal state, in development and CI, and not reported.
    if next.api_key.is_empty() {
        return None;
    }

    // Said unasked, as a refused key is: without it the data goes nowhere and nothing tells anyone. A test's own
    // delivery stands in for the endpoint.
    if next.endpoint.is_empty() && send.is_none() {
        if !SAID_NO_ENDPOINT.swap(true, std::sync::atomic::Ordering::Relaxed) {
            match &next.on_diagnostic {
                Some(callback) => callback(crate::options::NO_ENDPOINT),
                None => eprintln!("{}", crate::options::NO_ENDPOINT),
            }
        }
        return None;
    }

    let send = send.unwrap_or_else(|| transport::http_sender(&next.endpoint, &next.api_key));
    let reporter = Arc::new(Reporter::new(
        next.endpoint.clone(),
        send,
        next.flush_interval,
        next.max_batch_size,
        next.max_queue_size,
        next.debug,
        next.on_diagnostic.clone(),
    ));

    let generation = {
        let mut global = global();
        global.generation += 1;
        let generation = global.generation;
        global.running = Some(Running {
            reporter: Arc::clone(&reporter),
            settings: next,
            generation,
        });
        generation
    };
    // In the background: startup does not wait for the network.
    reporter.start();
    Some(generation)
}

/// Starts collecting with settings from the environment, as [`instrument`](crate::instrument) does when nothing
/// was configured. No guard: an instrumented stdio server delivers what is queued as its client leaves.
pub(crate) fn configure_from_environment() {
    let _ = std::panic::catch_unwind(|| start(Options::default(), None));
}

/// Delivers what is queued now, and carries on collecting.
pub(crate) fn flush() {
    let reporter = global().running.as_ref().map(|running| Arc::clone(&running.reporter));
    if let Some(reporter) = reporter {
        reporter.flush();
    }
}

/// Stops collecting and delivers what is queued, ignoring any wait for a retry: it is the last chance these events
/// get. It blocks while it delivers, for at most a few seconds when the endpoint does not answer.
///
/// Dropping the [`Guard`] from [`configure`] does the same, which is what most programs need.
pub fn shutdown() {
    let _ = std::panic::catch_unwind(|| stop(None));
}

fn stop(generation: Option<u64>) {
    let running = {
        let mut global = global();
        let current = global.running.as_ref().map(|running| running.generation);
        if generation.is_some() && generation != current {
            return;
        }
        global.running.take()
    };
    if let Some(running) = running {
        running.reporter.stop();
    }
}

/// Whether an API key is configured and calls are being recorded.
pub fn collecting() -> bool {
    global().running.is_some()
}

/// What an integration knows about one tool call as it starts.
pub(crate) struct Call {
    /// None for a tool call; `resource` or `prompt` otherwise (contract, 3.5).
    pub kind: Option<&'static str>,
    pub tool_name: String,
    pub parameters: Option<Map<String, Value>>,
    pub client_name: Option<String>,
    pub client_version: Option<String>,
    /// The one the SDK was told, or else the one the server gives itself.
    pub server_version: Option<String>,
    pub session_id: Option<String>,
    /// The arguments were the previous call's to the same tool in this session (contract, 3.9).
    pub repeated: bool,
    /// Which declared arguments fail the tool's schema, found as the call arrives, since the request is handed on;
    /// sent only if the server refuses them (contract, 3.10).
    pub invalid_arguments: Vec<String>,
    pub started: Instant,
    pub timestamp: SystemTime,
}

/// How a call ended.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Outcome {
    Success,
    Result {
        message: String,
    },
    Exception {
        error_type: String,
        message: String,
    },
    Arguments,
    UnknownTool,
    /// A resource or a prompt the server does not have: `unknown_resource` or `unknown_prompt`.
    Unknown(&'static str),
}

/// Notes the start of a call, or `None` when nothing is being recorded. The clock is read first.
pub(crate) fn begin(
    tool_name: &str,
    arguments: Option<&Map<String, Value>>,
    client: Option<&rmcp::model::Implementation>,
    server_version: Option<&str>,
    session_id: Option<String>,
) -> Option<Call> {
    let started = Instant::now();
    let timestamp = SystemTime::now();
    let (capture, configured) = {
        let global = global();
        let settings = &global.running.as_ref()?.settings;
        (settings.capture, settings.server_version.clone())
    };
    Some(Call {
        kind: None,
        tool_name: tool_name.to_owned(),
        parameters: if capture {
            text::describe_parameters(arguments)
        } else {
            None
        },
        client_name: client.map(|info| info.name.clone()),
        client_version: client.map(|info| info.version.clone()),
        server_version: if configured.is_empty() {
            server_version.map(str::to_owned)
        } else {
            Some(configured)
        },
        session_id,
        repeated: false,
        invalid_arguments: crate::definition::invalid_arguments_of(tool_name, arguments),
        started,
        timestamp,
    })
}

/// The largest size an event carries; anything larger is sent as this (contract, 3.7).
const MAX_RESPONSE_BYTES: u64 = 2_147_483_647;

/// Size of an answer in bytes of its compact JSON, as rmcp writes it, or `None` when it cannot be written. The JSON
/// is counted and dropped; nothing of it is kept or sent.
pub(crate) fn response_bytes<T: serde::Serialize>(answer: &T) -> Option<u64> {
    serde_json::to_vec(answer)
        .ok()
        .map(|json| (json.len() as u64).min(MAX_RESPONSE_BYTES))
}

/// Builds the event for a finished call and queues it. It never blocks on the network.
pub(crate) fn record(call: Call, outcome: Outcome) {
    record_answered(call, outcome, None);
}

/// As [`record`], for a call that answered: `response_bytes` is the answer's size (contract, 3.7).
pub(crate) fn record_answered(call: Call, outcome: Outcome, response_bytes: Option<u64>) {
    let duration_ms = call.started.elapsed().as_secs_f64() * 1_000.0;
    let Some((reporter, capture_error_messages)) = global()
        .running
        .as_ref()
        .map(|running| (Arc::clone(&running.reporter), running.settings.capture_error_messages))
    else {
        return;
    };

    let (success, error_source, error_type, error_message) = match outcome {
        Outcome::Success => (true, None, None, None),
        Outcome::Result { message } => (false, Some(crate::event::source::RESULT), None, Some(message)),
        Outcome::Exception { error_type, message } => (
            false,
            Some(crate::event::source::EXCEPTION),
            Some(error_type),
            Some(message),
        ),
        Outcome::Arguments => (false, Some(crate::event::source::ARGUMENTS), None, None),
        Outcome::UnknownTool => (false, Some(crate::event::source::UNKNOWN_TOOL), None, None),
        Outcome::Unknown(source) => (false, Some(source), None, None),
    };

    reporter.record(Event {
        id: uuid::Uuid::new_v4().to_string(),
        kind: call.kind,
        tool_name: text::truncate(&call.tool_name, text::MAX_NAME),
        duration_ms,
        success,
        error_source,
        error_type: error_type.map(|kind| text::truncate(&kind, text::MAX_NAME)),
        // The text of a failure, unless the developer chose to send none (contract, 5).
        error_message: error_message.filter(|message| capture_error_messages && !message.is_empty()),
        client_type: text::client_type(call.client_name.as_deref()),
        client_name: text::client_name(call.client_name.as_deref()),
        client_version: text::version(call.client_version.as_deref()),
        server_version: text::version(call.server_version.as_deref()),
        response_bytes,
        // A tool the server has, refused arguments included: often the schema is why.
        definition_hash: if call.kind.is_none() && error_source != Some(crate::event::source::UNKNOWN_TOOL) {
            crate::definition::definition_of(&call.tool_name)
        } else {
            None
        },
        repeated: call.kind.is_none() && call.repeated,
        invalid_arguments: if call.kind.is_none() && error_source == Some(crate::event::source::ARGUMENTS) {
            call.invalid_arguments
                .iter()
                .map(|name| text::truncate(name, text::MAX_NAME))
                .collect()
        } else {
            Vec::new()
        },
        timestamp: transport::iso8601(call.timestamp),
        session_id: call.session_id,
        parameters: call.parameters,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_an_answer_as_compact_json() {
        let answer = serde_json::json!({ "content": [{ "type": "text", "text": "Zażółć ✈️" }] });
        assert_eq!(response_bytes(&answer), Some(answer.to_string().len() as u64));
    }

    #[test]
    fn with_a_key_and_no_endpoint_collects_nothing_and_says_so_once() {
        // The environment is read as it is; the check needs it without an endpoint.
        if std::env::var("MCPSPAN_ENDPOINT").is_ok_and(|value| !value.trim().is_empty()) {
            return;
        }
        SAID_NO_ENDPOINT.store(false, std::sync::atomic::Ordering::Relaxed);
        let said = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = Arc::clone(&said);
        let options = Options::default()
            .api_key("k")
            .on_diagnostic(move |message| log.lock().unwrap().push(message.to_owned()));

        let first = configure(options.clone());
        let second = configure(options);

        assert!(!collecting());
        assert_eq!(*said.lock().unwrap(), vec![crate::options::NO_ENDPOINT.to_owned()]);
        drop((first, second));
    }
}
