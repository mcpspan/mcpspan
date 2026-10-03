//! The README's code, compiled against the crate. `readme_matches_the_samples` fails if the two drift apart.

#![allow(dead_code, unused_variables, clippy::diverging_sub_expression)]

use rmcp::handler::server::router::tool::{ToolRoute, ToolRouter};
use rmcp::transport::stdio;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ServerHandler, ServiceExt, handler::server::wrapper::Parameters, tool, tool_handler, tool_router};

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct Search {
    destination: String,
}

#[derive(Clone)]
struct Flights {
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl Flights {
    fn new() -> Self {
        Flights {
            tool_router: Self::tool_router(),
        }
    }

    #[tool]
    async fn search_flights(&self, Parameters(search): Parameters<Search>) -> String {
        search.destination
    }

    #[tool]
    async fn health_check(&self) -> String {
        "ok".into()
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Flights {}

mod use_stdio {
    use super::*;

    #[tokio::main]
    async fn main() -> Result<(), Box<dyn std::error::Error>> {
        // Your mcpspan installation; the key is read from MCPSPAN_API_KEY.
        let _mcpspan = mcpspan::configure(mcpspan::Options::default().endpoint("http://localhost:6271"));

        let server = mcpspan::instrument(Flights::new()).serve(stdio()).await?;
        server.waiting().await?;
        Ok(())
    }
}

fn use_http() {
    let service = StreamableHttpService::new(
        || Ok(mcpspan::instrument(Flights::new())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );
}

fn one_tool_at_a_time() {
    let router = ToolRouter::new().with_route(mcpspan::track(ToolRoute::new(
        Flights::search_flights_tool_attr(),
        Flights::search_flights,
    )));
}

fn leaving_a_tool_out() {
    let server = mcpspan::instrument(Flights::new()).exclude(Flights::health_check_tool_attr());
}

fn shutting_down() {
    mcpspan::shutdown();
}

fn privacy() {
    let options = mcpspan::Options::default().capture_parameter_names(true);
}

fn self_hosting() {
    let options = mcpspan::Options::default().endpoint("https://mcpspan.example.com");
}

#[test]
fn readme_matches_the_samples() {
    fn lines(text: &str) -> Vec<&str> {
        text.lines().map(str::trim).collect()
    }
    let readme = include_str!("../README.md");
    let samples = lines(include_str!("samples.rs"));
    let blocks: Vec<&str> = readme
        .split("```rust\n")
        .skip(1)
        .map(|rest| rest.split("```").next().unwrap())
        .collect();
    assert_eq!(blocks.len(), 7, "every Rust block in the README has a sample here");
    for block in blocks {
        let block = lines(block.trim_end());
        assert!(
            samples.windows(block.len()).any(|window| window == block.as_slice()),
            "not in tests/samples.rs:\n{}",
            block.join("\n")
        );
    }
}
