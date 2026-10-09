//! The SDK on a real rmcp server, called through a real rmcp client.

// Each test has a runtime of its own, and holds the lock only to keep other tests out of the process-wide
// configuration while it runs.
#![allow(clippy::await_holding_lock)]

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{Flights, Ingest, client, serial};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::CallToolRequestParams;
use rmcp::service::{RoleClient, RunningService};
use rmcp::{ServiceExt, model::ClientConfig};
use serde_json::json;

fn options(ingest: &Ingest) -> mcpspan::Options {
    mcpspan::Options::default()
        .api_key("mk_test")
        .endpoint(&ingest.endpoint)
        .flush_interval(Duration::from_secs(3600))
}

/// Serves `server` in memory and connects a client to it.
async fn connect<S: rmcp::Service<rmcp::RoleServer>>(
    server: S,
    name: &str,
) -> (RunningService<RoleClient, ClientConfig>, tokio::task::JoinHandle<()>) {
    let (server_transport, client_transport) = tokio::io::duplex(1 << 16);
    let serving = tokio::spawn(async move {
        if let Ok(running) = server.serve(server_transport).await {
            let _ = running.waiting().await;
        }
    });
    (client(name).serve(client_transport).await.unwrap(), serving)
}

async fn call(connection: &RunningService<RoleClient, ClientConfig>, name: &'static str, arguments: serde_json::Value) {
    let mut params = CallToolRequestParams::new(name);
    if let serde_json::Value::Object(arguments) = arguments {
        params = params.with_arguments(arguments);
    }
    // A refused call may come back as a protocol error; it was made either way.
    let _ = connection.call_tool(params).await;
}

/// Closes the connection and waits for the server to finish with it.
async fn leave(connection: RunningService<RoleClient, ClientConfig>, serving: tokio::task::JoinHandle<()>) {
    let _ = connection.cancel().await;
    let _ = serving.await;
}

#[tokio::test(flavor = "multi_thread")]
async fn records_every_kind_of_call() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = mcpspan::configure(options(&ingest).capture_parameter_names(true));

    let server = mcpspan::instrument(Flights::new()).exclude(Flights::health_check_tool_attr());
    let (connection, serving) = connect(server, "claude-code").await;
    call(&connection, "ok", json!({})).await;
    call(&connection, "reported_error", json!({})).await;
    call(&connection, "throws", json!({})).await;
    call(
        &connection,
        "search_flights",
        json!({"destination": "LIS", "passengers": 2}),
    )
    .await;
    call(&connection, "search_flights", json!({"destination": 7})).await;
    call(&connection, "no_such_tool", json!({})).await;
    call(&connection, "health_check", json!({})).await;
    leave(connection, serving).await;
    drop(guard);

    let ok = ingest.only("ok");
    assert_eq!(ok["success"], true);
    assert_eq!(ok["clientType"], "claude-code");
    assert_eq!(ok["clientName"], "claude-code");
    assert_eq!(ok["sdkVersion"], mcpspan::VERSION);
    assert!(ok.get("errorSource").is_none());

    let reported = ingest.only("reported_error");
    assert_eq!(reported["errorSource"], "result");
    assert_eq!(reported["errorMessage"], "No flights found");

    let thrown = ingest.only("throws");
    assert_eq!(thrown["errorSource"], "exception");
    assert_eq!(thrown["errorType"], "InternalError");
    assert_eq!(thrown["errorMessage"], "boom");

    let searches: Vec<_> = ingest
        .events()
        .into_iter()
        .filter(|event| event["toolName"] == "search_flights")
        .collect();
    assert_eq!(searches.len(), 2);
    assert_eq!(searches[0]["success"], true);
    assert_eq!(
        searches[0]["parameters"],
        json!({"destination": "string", "passengers": "number"})
    );
    assert_eq!(searches[1]["errorSource"], "arguments");
    assert!(
        searches[1].get("errorMessage").is_none(),
        "a refusal carries no message"
    );

    let unknown = ingest.only("no_such_tool");
    assert_eq!(unknown["errorSource"], "unknown_tool");
    assert!(unknown.get("errorMessage").is_none());

    assert!(ingest.events().iter().all(|event| event["toolName"] != "health_check"));

    // One connection, one session, ours.
    let events = ingest.events();
    let session = events[0]["sessionId"].as_str().unwrap();
    assert_eq!(session.len(), 36);
    assert!(events.iter().all(|event| event["sessionId"] == session));
}

#[tokio::test(flavor = "multi_thread")]
async fn records_a_panic_and_lets_it_unwind() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = mcpspan::configure(options(&ingest));

    let (connection, serving) = connect(mcpspan::instrument(Flights::new()), "cursor").await;
    // rmcp answers nothing for a tool that panicked, as it does without mcpspan.
    let answer = tokio::time::timeout(
        Duration::from_millis(500),
        connection.call_tool(CallToolRequestParams::new("panics")),
    )
    .await;
    assert!(answer.is_err(), "the panic reached rmcp unchanged");
    leave(connection, serving).await;
    drop(guard);

    let event = ingest.only("panics");
    assert_eq!(event["errorSource"], "exception");
    assert_eq!(event["errorType"], "panic");
    assert_eq!(event["errorMessage"], "seat map unavailable");
    assert_eq!(event["clientType"], "cursor");
}

#[tokio::test(flavor = "multi_thread")]
async fn separate_connections_are_separate_sessions() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = mcpspan::configure(options(&ingest));

    for name in ["first", "second"] {
        let (connection, serving) = connect(mcpspan::instrument(Flights::new()), name).await;
        call(&connection, "ok", json!({})).await;
        leave(connection, serving).await;
    }
    drop(guard);

    let events = ingest.events();
    assert_eq!(events.len(), 2);
    assert_ne!(events[0]["sessionId"], events[1]["sessionId"]);
    assert_eq!(events[0]["clientName"], "first");
    assert_eq!(events[1]["clientName"], "second");
}

#[tokio::test(flavor = "multi_thread")]
async fn records_the_servers_own_version_and_the_clients() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = mcpspan::configure(options(&ingest));

    let (connection, serving) = connect(mcpspan::instrument(Flights::new()), "cursor").await;
    call(&connection, "ok", json!({})).await;
    call(&connection, "no_such_tool", json!({})).await;
    leave(connection, serving).await;
    drop(guard);

    let events = ingest.events();
    assert_eq!(events.len(), 2);
    for event in &events {
        assert_eq!(event["serverVersion"], "1.4.0");
        assert_eq!(event["clientVersion"], "1.0.0");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_no_error_message_when_told_not_to_and_still_says_how_each_call_failed() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = mcpspan::configure(options(&ingest).capture_error_messages(false));

    let (connection, serving) = connect(mcpspan::instrument(Flights::new()), "cursor").await;
    call(&connection, "reported_error", json!({})).await;
    call(&connection, "throws", json!({})).await;
    leave(connection, serving).await;
    drop(guard);

    let reported = ingest.only("reported_error");
    assert_eq!(reported["errorSource"], "result");
    assert!(reported.get("errorMessage").is_none());
    let thrown = ingest.only("throws");
    assert_eq!(thrown["errorSource"], "exception");
    assert_eq!(thrown["errorType"], "InternalError");
    assert!(thrown.get("errorMessage").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_version_set_for_the_sdk_wins_over_the_servers_own() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = mcpspan::configure(options(&ingest).server_version("abc123"));

    let (connection, serving) = connect(mcpspan::instrument(Flights::new()), "cursor").await;
    call(&connection, "ok", json!({})).await;
    leave(connection, serving).await;
    drop(guard);

    assert_eq!(ingest.events()[0]["serverVersion"], "abc123");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tracked_tool_counts_once_on_an_instrumented_server() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = mcpspan::configure(options(&ingest));

    let tracked = || {
        let mut router = Flights::tool_router();
        let route = router.map.remove("ok").unwrap();
        router.add_route(mcpspan::track(route));
        router
    };
    let (connection, serving) = connect(mcpspan::instrument(Flights::with_router(tracked())), "a").await;
    call(&connection, "ok", json!({})).await;
    leave(connection, serving).await;

    // Tracked alone, with no instrumented server around it: measured, with no session to put it in.
    let router: ToolRouter<Flights> = tracked();
    let (connection, serving) = connect(Flights::with_router(router), "b").await;
    call(&connection, "ok", json!({})).await;
    leave(connection, serving).await;
    drop(guard);

    let events = ingest.events();
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(events[0]["sessionId"].is_string());
    assert!(events[1].get("sessionId").is_none());
    assert_eq!(events[1]["clientName"], "b");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_key_does_nothing() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = mcpspan::configure(mcpspan::Options::default().endpoint(&ingest.endpoint));
    assert!(!mcpspan::collecting());

    let (connection, serving) = connect(mcpspan::instrument(Flights::new()), "a").await;
    call(&connection, "ok", json!({})).await;
    call(&connection, "throws", json!({})).await;
    leave(connection, serving).await;
    drop(guard);

    std::thread::sleep(Duration::from_millis(100));
    assert!(ingest.requests().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn announces_itself_and_identifies_the_sdk() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = mcpspan::configure(options(&ingest));
    ingest.wait_for_requests(1);

    let announcement = &ingest.requests()[0];
    assert_eq!(announcement.body, json!({"events": []}));
    assert_eq!(announcement.authorization, "Bearer mk_test");
    assert_eq!(announcement.user_agent, format!("mcpspan/{} (rust)", mcpspan::VERSION));

    // The same settings again change nothing: no second announcement.
    let again = mcpspan::configure(options(&ingest));
    drop(again);
    assert!(mcpspan::collecting(), "a guard that started nothing stops nothing");
    drop(guard);
    assert!(!mcpspan::collecting());
    assert_eq!(ingest.requests().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_key_stops_collecting_and_says_so_once() {
    for status in [401, 403] {
        let _serial = serial();
        let ingest = Ingest::start();
        ingest.answer(status, None);
        let said = Arc::new(Mutex::new(Vec::<String>::new()));
        let heard = Arc::clone(&said);
        // Not debug: a refused key is said even so.
        let guard = mcpspan::configure(
            options(&ingest).on_diagnostic(move |message| heard.lock().unwrap().push(message.to_owned())),
        );
        ingest.wait_for_requests(1);
        std::thread::sleep(Duration::from_millis(100));

        let (connection, serving) = connect(mcpspan::instrument(Flights::new()), "a").await;
        call(&connection, "ok", json!({})).await;
        leave(connection, serving).await;
        drop(guard);

        assert_eq!(ingest.requests().len(), 1, "nothing sent after a {status}");
        let said = said.lock().unwrap();
        let refusals: Vec<_> = said
            .iter()
            .filter(|message| message.contains("rejected the API key"))
            .collect();
        assert_eq!(refusals.len(), 1, "{said:?}");
        assert!(refusals[0].contains(&status.to_string()));
    }
}

mod primitives {
    use super::*;
    use rmcp::handler::server::router::prompt::PromptRouter;
    use rmcp::model::{
        GetPromptRequestParams, ListResourceTemplatesResult, ListResourcesResult, PaginatedRequestParams,
        PromptMessage, ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource, ResourceContents,
        ResourceTemplate, Role, ServerCapabilities, ServerConfig,
    };
    use rmcp::service::RequestContext;
    use rmcp::{ErrorData, RoleServer, ServerHandler, prompt, prompt_handler, prompt_router};

    #[derive(Clone)]
    struct Library {
        prompt_router: PromptRouter<Self>,
    }

    #[prompt_router]
    impl Library {
        #[prompt]
        async fn plan_trip(&self) -> Vec<PromptMessage> {
            vec![PromptMessage::new_text(Role::User, "ok")]
        }

        #[prompt]
        async fn broken(&self) -> Result<Vec<PromptMessage>, ErrorData> {
            Err(ErrorData::internal_error("no planner", None))
        }
    }

    #[prompt_handler(router = self.prompt_router)]
    impl ServerHandler for Library {
        fn get_info(&self) -> ServerConfig {
            ServerConfig::new(
                ServerCapabilities::builder()
                    .enable_resources()
                    .enable_prompts()
                    .build(),
            )
        }

        async fn list_resources(
            &self,
            _: Option<PaginatedRequestParams>,
            _: RequestContext<RoleServer>,
        ) -> Result<ListResourcesResult, ErrorData> {
            Ok(ListResourcesResult::with_all_items(vec![Resource::new(
                "config://app",
                "config",
            )]))
        }

        async fn list_resource_templates(
            &self,
            _: Option<PaginatedRequestParams>,
            _: RequestContext<RoleServer>,
        ) -> Result<ListResourceTemplatesResult, ErrorData> {
            Ok(ListResourceTemplatesResult::with_all_items(vec![
                ResourceTemplate::new("trips://{id}", "trip"),
            ]))
        }

        async fn read_resource(
            &self,
            request: ReadResourceRequestParams,
            _: RequestContext<RoleServer>,
        ) -> Result<ReadResourceResponse, ErrorData> {
            if request.uri == "config://app" || request.uri.starts_with("trips://") {
                Ok(ReadResourceResult::new(vec![ResourceContents::text("ok", request.uri)]).into())
            } else {
                Err(ErrorData::resource_not_found("not here", None))
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn records_each_read_and_get_by_what_it_is() {
        let _serial = serial();
        let ingest = Ingest::start();
        let guard = mcpspan::configure(options(&ingest).capture_parameter_names(true));

        let library = Library {
            prompt_router: Library::prompt_router(),
        };
        let (connection, serving) = connect(mcpspan::instrument(library), "cursor").await;
        for uri in ["config://app", "trips://secret-4412", "db://customers/lovelace"] {
            let _ = connection.read_resource(ReadResourceRequestParams::new(uri)).await;
        }
        for name in ["plan_trip", "translate", "broken"] {
            let _ = connection.get_prompt(GetPromptRequestParams::new(name)).await;
        }
        let _ = connection.list_resources(None).await;
        leave(connection, serving).await;
        drop(guard);

        let events = ingest.events();
        let got: Vec<(String, String, String)> = events
            .iter()
            .map(|event| {
                (
                    event["kind"].as_str().unwrap_or_default().to_owned(),
                    event["toolName"].as_str().unwrap_or_default().to_owned(),
                    event["errorSource"].as_str().unwrap_or("-").to_owned(),
                )
            })
            .collect();
        let expected: Vec<(String, String, String)> = [
            ("resource", "config://app", "-"),
            ("resource", "trips://{id}", "-"),
            ("resource", "db://", "unknown_resource"),
            ("prompt", "plan_trip", "-"),
            ("prompt", "translate", "unknown_prompt"),
            ("prompt", "broken", "exception"),
        ]
        .iter()
        .map(|(a, b, c)| ((*a).to_owned(), (*b).to_owned(), (*c).to_owned()))
        .collect();
        assert_eq!(got, expected);
        assert_eq!(events[1]["parameters"], json!({"id": "string"}));
        assert!(events.iter().all(|event| event["clientType"] == "cursor"));
        // It gives itself no version, and rmcp's own name and version in its place are not the server's.
        assert!(events.iter().all(|event| event.get("serverVersion").is_none()));
        assert!(!serde_json::to_string(&events).unwrap().contains("lovelace"));
    }
}
