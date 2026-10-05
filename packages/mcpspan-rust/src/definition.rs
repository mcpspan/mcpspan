//! Tool definitions as the server lists them, fingerprinted (contract, 3.8).
//!
//! Rewording a description can change how agents use a tool more than a change to its code. The fingerprint is
//! taken from the answer to `tools/list`, what an agent actually read, and sent with every call to the tool. Kept for
//! the process: one process reports to one server.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use sha2::{Digest, Sha256};

fn listed() -> &'static Mutex<HashMap<String, String>> {
    static LISTED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    LISTED.get_or_init(Mutex::default)
}

/// The latest fingerprint listed for a tool, or `None` when no listing in this process named it.
pub(crate) fn definition_of(tool_name: &str) -> Option<String> {
    listed().lock().ok()?.get(tool_name).cloned()
}

/// Notes every tool in a listing, as rmcp writes it to the client. Never panics.
pub(crate) fn note_listing(tools: &[rmcp::model::Tool]) {
    for tool in tools {
        let Ok(wire) = serde_json::to_value(tool) else { continue };
        let Some(name) = wire.get("name").and_then(Value::as_str) else {
            continue;
        };
        if let Some(hash) = definition_hash(&wire)
            && let Ok(mut listed) = listed().lock()
        {
            listed.insert(name.to_owned(), hash);
        }
    }
}

/// The first 16 hex characters of the SHA-256 of the tool's name, title, description and input schema, as
/// canonical JSON; `None` for a definition that cannot be written so.
pub(crate) fn definition_hash(tool: &Value) -> Option<String> {
    let mut hashed = serde_json::Map::new();
    for field in ["name", "title", "description", "inputSchema"] {
        if let Some(value) = tool.get(field).filter(|value| !value.is_null()) {
            hashed.insert(field.to_owned(), value.clone());
        }
    }
    let mut text = String::new();
    canonical(&mut text, &Value::Object(hashed))?;
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::new();
    for byte in &digest[..8] {
        let _ = write!(hex, "{byte:02x}");
    }
    Some(hex)
}

/// Sorted keys, no whitespace, minimal escaping: the same text in every SDK.
fn canonical(text: &mut String, value: &Value) -> Option<()> {
    match value {
        Value::Null => text.push_str("null"),
        Value::Bool(flag) => text.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                let _ = write!(text, "{integer}");
            } else if let Some(integer) = number.as_u64() {
                let _ = write!(text, "{integer}");
            } else {
                let float = number.as_f64()?;
                if float.fract() == 0.0 && float.abs() < 1e15 {
                    let _ = write!(text, "{}", float as i64);
                } else {
                    let _ = write!(text, "{float}");
                }
            }
        }
        Value::String(string) => quoted(text, string),
        Value::Array(items) => {
            text.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    text.push(',');
                }
                canonical(text, item)?;
            }
            text.push(']');
        }
        Value::Object(object) => {
            // Sorted here: serde_json keeps insertion order when another crate turns that on.
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            text.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    text.push(',');
                }
                quoted(text, key);
                text.push(':');
                canonical(text, &object[key])?;
            }
            text.push('}');
        }
    }
    Some(())
}

fn quoted(text: &mut String, value: &str) {
    text.push('"');
    for character in value.chars() {
        match character {
            '"' => text.push_str("\\\""),
            '\\' => text.push_str("\\\\"),
            '\u{8}' => text.push_str("\\b"),
            '\u{c}' => text.push_str("\\f"),
            '\n' => text.push_str("\\n"),
            '\r' => text.push_str("\\r"),
            '\t' => text.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                let _ = write!(text, "\\u{:04x}", control as u32);
            }
            other => text.push(other),
        }
    }
    text.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_the_shared_cases_as_every_sdk_does() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/definition-hashes.json"
        ))
        .expect("shared cases");
        let shared: Value = serde_json::from_str(&raw).expect("JSON");
        for case in shared["cases"].as_array().expect("cases") {
            assert_eq!(
                definition_hash(&case["tool"]).as_deref(),
                case["hash"].as_str(),
                "{}",
                case["case"]
            );
        }
    }
}
