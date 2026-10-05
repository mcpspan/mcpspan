//! Analytics for MCP servers: which tools are called, by which client, how long they take, and which ones fail.
//!
//! Instrumenting an [rmcp](https://docs.rs/rmcp) server is one line:
//!
//! ```no_run
//! # use rmcp::{ServerHandler, ServiceExt};
//! # #[derive(Clone)] struct Flights;
//! # impl ServerHandler for Flights {}
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let _mcpspan = mcpspan::configure(mcpspan::Options::default());
//! let server = mcpspan::instrument(Flights).serve(rmcp::transport::stdio()).await?;
//! server.waiting().await?;
//! # Ok(()) }
//! ```
//!
//! Without an API key nothing is collected and nothing is sent. Parameter values never leave the process.

mod collector;
mod definition;
mod event;
mod handler;
mod instrument;
mod options;
mod primitives;
mod repeats;
mod reporter;
mod text;
mod transport;

pub use collector::{Guard, collecting, configure, shutdown};
pub use instrument::{Instrumented, ToolName, instrument, track};
pub use options::Options;

/// The SDK's own version, reported with every event.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
