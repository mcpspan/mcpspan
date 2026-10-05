//! One tool call, in the shape the ingest API takes.

use serde_json::{Map, Value};

/// One tool call. Parameter values are never part of it.
#[derive(Debug, Clone)]
pub(crate) struct Event {
    pub id: String,
    /// None for a tool call; `resource` or `prompt` otherwise (contract, 3.5).
    pub kind: Option<&'static str>,
    pub tool_name: String,
    pub duration_ms: f64,
    pub success: bool,
    pub error_source: Option<&'static str>,
    pub error_type: Option<String>,
    pub error_message: Option<String>,
    pub client_type: &'static str,
    pub client_name: Option<String>,
    pub client_version: Option<String>,
    pub server_version: Option<String>,
    /// Size of the answer, when there was one (contract, 3.7).
    pub response_bytes: Option<u64>,
    pub timestamp: String,
    pub session_id: Option<String>,
    pub parameters: Option<Map<String, Value>>,
}

/// How a failed call announced itself, as the contract names it.
pub(crate) mod source {
    pub const RESULT: &str = "result";
    pub const EXCEPTION: &str = "exception";
    pub const ARGUMENTS: &str = "arguments";
    pub const UNKNOWN_TOOL: &str = "unknown_tool";
}

impl Event {
    /// The event as JSON, leaving absent fields out rather than sending them as null.
    pub(crate) fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), self.id.clone().into());
        if let Some(kind) = self.kind {
            object.insert("kind".into(), kind.into());
        }
        object.insert("toolName".into(), self.tool_name.clone().into());
        object.insert("durationMs".into(), self.duration_ms.into());
        object.insert("success".into(), self.success.into());
        let mut optional = |name: &str, value: Option<Value>| {
            if let Some(value) = value {
                object.insert(name.into(), value);
            }
        };
        optional("errorSource", self.error_source.map(Value::from));
        optional("errorType", self.error_type.clone().map(Value::from));
        optional("errorMessage", self.error_message.clone().map(Value::from));
        optional("clientType", Some(self.client_type.into()));
        optional("clientName", self.client_name.clone().map(Value::from));
        optional("clientVersion", self.client_version.clone().map(Value::from));
        optional("serverVersion", self.server_version.clone().map(Value::from));
        optional("responseBytes", self.response_bytes.map(Value::from));
        optional("timestamp", Some(self.timestamp.clone().into()));
        optional("sdkVersion", Some(crate::VERSION.into()));
        optional("sessionId", self.session_id.clone().map(Value::from));
        optional("parameters", self.parameters.clone().map(Value::Object));
        Value::Object(object)
    }
}

/// The body of one batch.
pub(crate) fn batch(events: &[Event]) -> String {
    let events: Vec<Value> = events.iter().map(Event::to_json).collect();
    serde_json::json!({ "events": events }).to_string()
}
