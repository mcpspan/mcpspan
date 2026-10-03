//! A stand-in for the ingest API, and a server to instrument.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{ClientCapabilities, ClientConfig, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use serde_json::Value;

/// A status to answer with, and a Retry-After to send with it.
type Answer = (u16, Option<String>);

/// One request the ingest API received.
#[derive(Debug, Clone)]
pub struct Received {
    pub authorization: String,
    pub user_agent: String,
    pub body: Value,
}

/// The ingest API, on a local port, answering with the statuses it is given and then 202.
#[derive(Clone)]
pub struct Ingest {
    pub endpoint: String,
    received: Arc<Mutex<Vec<Received>>>,
    answers: Arc<Mutex<VecDeque<Answer>>>,
}

impl Ingest {
    pub fn start() -> Ingest {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let ingest = Ingest {
            endpoint: format!("http://{}", listener.local_addr().unwrap()),
            received: Arc::default(),
            answers: Arc::default(),
        };
        let serving = ingest.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let serving = serving.clone();
                std::thread::spawn(move || serving.serve(stream));
            }
        });
        ingest
    }

    fn serve(&self, stream: std::net::TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut stream = stream;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let (mut length, mut authorization, mut user_agent) = (0, String::new(), String::new());
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                let header = header.trim_end();
                if header.is_empty() {
                    break;
                }
                let (name, value) = header.split_once(':').unwrap();
                match name.to_ascii_lowercase().as_str() {
                    "content-length" => length = value.trim().parse().unwrap(),
                    "authorization" => authorization = value.trim().to_owned(),
                    "user-agent" => user_agent = value.trim().to_owned(),
                    _ => {}
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let (status, retry_after) = self.answers.lock().unwrap().pop_front().unwrap_or((202, None));
            self.received.lock().unwrap().push(Received {
                authorization,
                user_agent,
                body: serde_json::from_slice(&body).unwrap(),
            });
            let retry_after = retry_after
                .map(|value| format!("Retry-After: {value}\r\n"))
                .unwrap_or_default();
            let answer = format!("HTTP/1.1 {status} X\r\nContent-Length: 2\r\n{retry_after}\r\n{{}}");
            if stream.write_all(answer.as_bytes()).is_err() {
                return;
            }
        }
    }

    /// Answers the next request with this status.
    pub fn answer(&self, status: u16, retry_after: Option<&str>) {
        self.answers
            .lock()
            .unwrap()
            .push_back((status, retry_after.map(str::to_owned)));
    }

    pub fn requests(&self) -> Vec<Received> {
        self.received.lock().unwrap().clone()
    }

    /// Every event received, announcement aside.
    pub fn events(&self) -> Vec<Value> {
        self.requests()
            .into_iter()
            .flat_map(|request| request.body["events"].as_array().cloned().unwrap_or_default())
            .collect()
    }

    pub fn only(&self, tool: &str) -> Value {
        let matching: Vec<Value> = self
            .events()
            .into_iter()
            .filter(|event| event["toolName"] == tool)
            .collect();
        assert_eq!(matching.len(), 1, "events for {tool}: {matching:?}");
        matching.into_iter().next().unwrap()
    }

    /// Waits until the ingest API has received this many requests.
    pub fn wait_for_requests(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.requests().len() < count {
            assert!(
                Instant::now() < deadline,
                "expected {count} requests, got {:?}",
                self.requests()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// One test at a time: the SDK's configuration belongs to the process.
pub fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    mcpspan::shutdown();
    guard
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct Search {
    pub destination: String,
    pub passengers: f64,
}

#[derive(Debug, Clone)]
pub struct Flights {
    tool_router: ToolRouter<Self>,
}

impl Flights {
    pub fn new() -> Self {
        Flights {
            tool_router: Self::tool_router(),
        }
    }

    pub fn with_router(tool_router: ToolRouter<Self>) -> Self {
        Flights { tool_router }
    }
}

#[tool_router(vis = "pub")]
impl Flights {
    #[tool(description = "Answers ok")]
    pub async fn ok(&self) -> String {
        "ok".into()
    }

    #[tool(description = "Reports an error in its result")]
    pub async fn reported_error(&self) -> Result<String, String> {
        Err("No flights found".into())
    }

    #[tool(description = "Fails with a protocol error")]
    pub async fn throws(&self) -> Result<String, ErrorData> {
        Err(ErrorData::internal_error("boom", None))
    }

    #[tool(description = "Panics")]
    pub async fn panics(&self) -> String {
        panic!("seat map unavailable")
    }

    #[tool(description = "Takes typed arguments")]
    pub async fn search_flights(&self, Parameters(search): Parameters<Search>) -> String {
        format!("{} for {}", search.destination, search.passengers)
    }

    #[tool(description = "Polled by a load balancer")]
    pub async fn health_check(&self) -> String {
        "ok".into()
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Flights {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("flights", "1.4.0"))
    }
}

/// A client that names itself as this.
pub fn client(name: &str) -> ClientConfig {
    ClientConfig::new(ClientCapabilities::default(), Implementation::new(name, "1.0.0"))
}
