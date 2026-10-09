//! The conformance adapter for the Rust SDK, on rmcp: an MCP server over stdio with the tools the suite calls.

use std::time::Duration;

use rmcp::handler::server::router::prompt::PromptRouter;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    Implementation, ListResourceTemplatesResult, ListResourcesResult, PaginatedRequestParams,
    PromptMessage, ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource,
    ResourceContents, ResourceTemplate, Role, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt, prompt, prompt_handler, prompt_router, tool,
    tool_handler, tool_router,
};

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct Typed {
    #[allow(dead_code)]
    destination: String,
    #[allow(dead_code)]
    passengers: f64,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct Depth {
    #[allow(dead_code)]
    depth: Option<f64>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct PlanTrip {
    destination: String,
}

#[derive(Clone)]
struct Adapter {
    tool_router: ToolRouter<Self>,
    prompt_router: PromptRouter<Self>,
}

// Prompts (contract, 3.5): one with a required argument, and one that fails.
#[prompt_router]
impl Adapter {
    #[prompt]
    async fn plan_trip(&self, Parameters(trip): Parameters<PlanTrip>) -> Vec<PromptMessage> {
        vec![PromptMessage::new_text(
            Role::User,
            format!("Plan a trip to {}", trip.destination),
        )]
    }

    #[prompt]
    async fn broken_prompt(&self) -> Result<Vec<PromptMessage>, ErrorData> {
        Err(ErrorData::internal_error("boom", None))
    }
}

// A Rust server's tools are part of it before it can be instrumented at all, `early` among them: there is no
// registering one afterwards, and nothing for the case to tell apart.
#[tool_router]
impl Adapter {
    #[tool]
    async fn early(&self) -> String {
        "ok".into()
    }

    #[tool]
    async fn ok(&self) -> String {
        "ok".into()
    }

    #[tool]
    async fn large(&self) -> String {
        "x".repeat(100_000)
    }

    #[tool]
    async fn reported_error(&self) -> Result<String, String> {
        Err("No flights found".into())
    }

    /// A Rust tool fails exceptionally with an ErrorData, named by its code.
    #[tool]
    async fn throws(&self) -> Result<String, ErrorData> {
        Err(ErrorData::internal_error("boom", None))
    }

    #[tool]
    async fn typed(&self, Parameters(_): Parameters<Typed>) -> String {
        "ok".into()
    }

    #[tool]
    async fn excluded(&self, Parameters(_): Parameters<Depth>) -> String {
        "ok".into()
    }

    #[tool(
        name = "long_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    )]
    async fn long(&self) -> String {
        "ok".into()
    }
}

// Resources (contract, 3.5): one at a fixed address, one read through a template, one that fails. An rmcp
// server answers reads and lists them itself.
#[tool_handler(router = self.tool_router)]
#[prompt_handler(router = self.prompt_router)]
impl ServerHandler for Adapter {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_prompts()
                .build(),
        )
        .with_server_info(Implementation::new("conformance", "1.0.0"))
    }

    async fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::with_all_items(vec![
            Resource::new("config://app", "config"),
            Resource::new("broken://status", "broken"),
        ]))
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
        match request.uri.as_str() {
            "broken://status" => Err(ErrorData::internal_error("boom", None)),
            uri if uri == "config://app" || uri.starts_with("trips://") => {
                Ok(ReadResourceResult::new(vec![ResourceContents::text("ok", uri)]).into())
            }
            uri => Err(ErrorData::resource_not_found(
                format!("no resource at {uri}"),
                None,
            )),
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let flush_ms = std::env::var("CONFORMANCE_FLUSH_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
        .unwrap_or(200);
    let capture = std::env::var("CONFORMANCE_CAPTURE_PARAMETERS").as_deref() == Ok("1");
    let messages = std::env::var("CONFORMANCE_CAPTURE_ERROR_MESSAGES").as_deref() != Ok("0");

    // The key and the endpoint come from MCPSPAN_API_KEY and MCPSPAN_ENDPOINT.
    let _mcpspan = mcpspan::configure(
        mcpspan::Options::default()
            .flush_interval(Duration::from_millis(flush_ms))
            .capture_parameter_names(capture)
            .capture_error_messages(messages),
    );

    let server = mcpspan::instrument(Adapter {
        tool_router: Adapter::tool_router(),
        prompt_router: Adapter::prompt_router(),
    })
    .exclude(Adapter::excluded_tool_attr())
    .serve(rmcp::transport::stdio())
    .await?;
    server.waiting().await?;
    Ok(())
}
