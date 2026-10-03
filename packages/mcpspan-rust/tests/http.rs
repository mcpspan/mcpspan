//! Sessions over streamable HTTP, where a connection is a transport session or nothing at all.

// Each test has a runtime of its own, and holds the lock only to keep other tests out of the process-wide
// configuration while it runs.
#![allow(clippy::await_holding_lock)]

mod common;

use std::time::Duration;

use common::{Flights, Ingest, serial};
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};

/// Serves Flights over HTTP, instrumented once per session as rmcp builds them, and returns its address.
async fn serve(sessions: bool) -> String {
    let mut config = StreamableHttpServerConfig::default();
    config.legacy_session_mode = sessions;
    config.sse_keep_alive = None;
    let service = StreamableHttpService::new(
        || Ok(mcpspan::instrument(Flights::new())),
        LocalSessionManager::default().into(),
        config,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, axum::Router::new().nest_service("/mcp", service)).await;
    });
    format!("http://{address}/mcp")
}

async fn two_calls(url: &str) {
    let client = ().serve(StreamableHttpClientTransport::from_uri(url.to_owned())).await.unwrap();
    for _ in 0..2 {
        client.call_tool(CallToolRequestParams::new("ok")).await.unwrap();
    }
    let _ = client.cancel().await;
}

fn configure(ingest: &Ingest) -> mcpspan::Guard {
    mcpspan::configure(
        mcpspan::Options::default()
            .api_key("mk_test")
            .endpoint(&ingest.endpoint)
            .flush_interval(Duration::from_secs(3600)),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transport_session_is_one_session_of_ours() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = configure(&ingest);

    let url = serve(true).await;
    two_calls(&url).await;
    two_calls(&url).await;
    drop(guard);

    let sessions: Vec<_> = ingest
        .events()
        .iter()
        .map(|event| event["sessionId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(sessions.len(), 4);
    assert_eq!(sessions[0], sessions[1]);
    assert_eq!(sessions[2], sessions[3]);
    assert_ne!(sessions[0], sessions[2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_transport_session_there_is_none() {
    let _serial = serial();
    let ingest = Ingest::start();
    let guard = configure(&ingest);

    two_calls(&serve(false).await).await;
    drop(guard);

    let events = ingest.events();
    assert_eq!(events.len(), 2);
    assert!(
        events.iter().all(|event| event.get("sessionId").is_none()),
        "{events:?}"
    );
}
