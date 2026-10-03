//! Limits the ingest API enforces, client detection, and parameter description.

use serde_json::{Map, Value};

/// A tool, an error type, a client, a parameter name. The API refuses a whole batch over it.
pub(crate) const MAX_NAME: usize = 200;
/// Written by developers for developers: mostly safe to keep, and worth reading in full.
pub(crate) const MAX_EXCEPTION_MESSAGE: usize = 500;
/// Written for a model to read, so more likely to quote what the user asked.
pub(crate) const MAX_RESULT_MESSAGE: usize = 200;
/// A release, a tag, a commit: the server's or the client's.
pub(crate) const MAX_VERSION: usize = 100;
/// Bounds one call's description, so a very wide object cannot make a large event.
pub(crate) const MAX_DESCRIBED_PARAMETERS: usize = 50;

/// Cuts text to a limit in characters, never splitting one, with a visible sign of the cut.
pub(crate) fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(limit - 3).collect();
    cut.push_str("...");
    cut
}

// claude-code before claude, which would otherwise swallow it. The official
// Inspector sends inspector-cli, which is why names are matched as substrings.
const KNOWN_CLIENTS: &[(&str, &str)] = &[
    ("claude-code", "claude-code"),
    ("claude code", "claude-code"),
    ("claude", "claude"),
    ("cursor", "cursor"),
    ("chatgpt", "chatgpt"),
    ("openai", "chatgpt"),
    ("inspector", "mcp-inspector"),
];

/// The client type, from the name a client reported: substring match, first match wins.
pub(crate) fn client_type(name: Option<&str>) -> &'static str {
    let lower = name.unwrap_or_default().trim().to_lowercase();
    if lower.is_empty() {
        return "unknown";
    }
    KNOWN_CLIENTS
        .iter()
        .find(|(pattern, _)| lower.contains(pattern))
        .map_or("other", |(_, client)| client)
}

/// The name as reported, cut to what the API takes, or none.
pub(crate) fn client_name(name: Option<&str>) -> Option<String> {
    let trimmed = name.unwrap_or_default().trim();
    (!trimmed.is_empty()).then(|| truncate(trimmed, MAX_NAME))
}

/// A version as reported, cut to what the API takes, or none.
pub(crate) fn version(version: Option<&str>) -> Option<String> {
    let trimmed = version.unwrap_or_default().trim();
    (!trimmed.is_empty()).then(|| truncate(trimmed, MAX_VERSION))
}

/// The top-level parameters by name and JSON type, never a value, or none when there are none.
pub(crate) fn describe_parameters(arguments: Option<&Map<String, Value>>) -> Option<Map<String, Value>> {
    let arguments = arguments.filter(|a| !a.is_empty())?;
    Some(
        arguments
            .iter()
            .take(MAX_DESCRIBED_PARAMETERS)
            .map(|(name, value)| {
                let kind = match value {
                    Value::Null => "null",
                    Value::Bool(_) => "boolean",
                    Value::Number(_) => "number",
                    Value::String(_) => "string",
                    Value::Array(_) => "array",
                    Value::Object(_) => "object",
                };
                (truncate(name, MAX_NAME), Value::from(kind))
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truncate_marks_a_cut_and_keeps_characters_whole() {
        assert_eq!(truncate("abc", 5), "abc");
        assert_eq!(truncate("abcdefgh", 5), "ab...");
        let cut = truncate(&"ż".repeat(300), 200);
        assert_eq!(cut.chars().count(), 200);
        assert!(cut.ends_with("..."));
    }

    /// The contract's table as cases, shared by every SDK's tests (conformance/client-types.json).
    #[test]
    fn detects_the_contract_table() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/client-types.json");
        let table: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(cases.len() > 10);
        for case in cases {
            let name = case[0].as_str();
            assert_eq!(client_type(name), case[1].as_str().unwrap(), "{name:?}");
        }
    }

    #[test]
    fn keeps_the_client_name_but_cuts_it() {
        assert_eq!(client_name(Some(" cursor ")).as_deref(), Some("cursor"));
        assert_eq!(client_name(Some(&"c".repeat(400))).unwrap().chars().count(), 200);
        assert_eq!(client_name(Some(" ")), None);
    }

    #[test]
    fn keeps_a_version_but_cuts_it() {
        assert_eq!(version(Some(" 1.4.0 ")).as_deref(), Some("1.4.0"));
        assert_eq!(version(Some(&"v".repeat(300))).unwrap().chars().count(), MAX_VERSION);
        assert_eq!(version(Some("")), None);
    }

    #[test]
    fn describes_parameters_by_name_and_json_type_only() {
        let arguments = json!({"destination": "secret", "passengers": 2, "direct": true,
            "stops": [], "filters": {}, "note": null});
        let described = describe_parameters(arguments.as_object()).unwrap();
        assert_eq!(
            Value::Object(described.clone()),
            json!({"destination": "string", "passengers": "number", "direct": "boolean",
                "stops": "array", "filters": "object", "note": "null"})
        );
        assert!(!Value::Object(described).to_string().contains("secret"));
        assert_eq!(describe_parameters(Some(&Map::new())), None);
    }

    #[test]
    fn bounds_the_parameters_described() {
        let wide: Map<String, Value> = (0..80).map(|i| (format!("p{i}"), json!(i))).collect();
        assert_eq!(
            describe_parameters(Some(&wide)).unwrap().len(),
            MAX_DESCRIBED_PARAMETERS
        );
    }
}
