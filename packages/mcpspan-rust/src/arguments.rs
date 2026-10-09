//! Which top-level arguments of a refused call did not match the tool's input schema (contract, 3.10).
//!
//! The server's own refusal is not read: each validation library words it differently, and some quote the value the
//! agent sent. The arguments are checked here instead, against the schema the server listed, by a small set of rules
//! that never fail what they do not understand. Only names the schema declares come out, so nothing the client made
//! up, and no value, is sent.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

use crate::definition::canonical_text;

/// Names sent at most, per call.
const MAX_NAMES: usize = 20;

/// The declared names whose arguments fail the schema, sorted, at most twenty. Arguments that are absent are checked
/// as an empty object.
pub(crate) fn invalid_arguments(schema: &Value, arguments: Option<&Map<String, Value>>) -> Vec<String> {
    let Value::Object(rules) = schema else {
        return Vec::new();
    };
    let empty = Map::new();
    let values = arguments.unwrap_or(&empty);

    let mut names = BTreeSet::new();
    if let Some(Value::Array(required)) = rules.get("required") {
        for name in required.iter().filter_map(Value::as_str) {
            if !values.contains_key(name) {
                names.insert(name.to_owned());
            }
        }
    }
    if let Some(Value::Object(properties)) = rules.get("properties") {
        for (name, rule) in properties {
            if let Some(value) = values.get(name)
                && !matches(rule, value)
            {
                names.insert(name.clone());
            }
        }
    }
    names.into_iter().take(MAX_NAMES).collect()
}

/// Whether a value passes a schema under the checks the contract lists, and only those.
fn matches(schema: &Value, value: &Value) -> bool {
    let rules = match schema {
        Value::Bool(allowed) => return *allowed,
        Value::Object(rules) => rules,
        _ => return true,
    };

    match rules.get("type") {
        Some(Value::String(kind)) if !is_type(kind, value) => return false,
        Some(Value::Array(kinds))
            if kinds.iter().all(Value::is_string)
                && !kinds.iter().filter_map(Value::as_str).any(|kind| is_type(kind, value)) =>
        {
            return false;
        }
        _ => {}
    }

    if let Some(Value::Array(allowed)) = rules.get("enum") {
        let sent = canonical_text(value);
        if !allowed
            .iter()
            .any(|option| sent.is_some() && canonical_text(option) == sent)
        {
            return false;
        }
    }
    if let Some(constant) = rules.get("const") {
        let sent = canonical_text(value);
        if sent.is_none() || canonical_text(constant) != sent {
            return false;
        }
    }

    let bound = |name: &str| rules.get(name).and_then(number_of);
    if let Some(number) = number_of(value)
        && (bound("minimum").is_some_and(|minimum| number < minimum)
            || bound("maximum").is_some_and(|maximum| number > maximum)
            || bound("exclusiveMinimum").is_some_and(|above| number <= above)
            || bound("exclusiveMaximum").is_some_and(|below| number >= below))
    {
        return false;
    }

    match value {
        Value::String(text) => {
            // Code points: a character outside the BMP is one.
            let length = text.chars().count() as f64;
            if bound("minLength").is_some_and(|shortest| length < shortest)
                || bound("maxLength").is_some_and(|longest| length > longest)
            {
                return false;
            }
        }
        Value::Array(items) => {
            let count = items.len() as f64;
            if bound("minItems").is_some_and(|fewest| count < fewest)
                || bound("maxItems").is_some_and(|most| count > most)
            {
                return false;
            }
            if let Some(each @ (Value::Object(_) | Value::Bool(_))) = rules.get("items")
                && !items.iter().all(|item| matches(each, item))
            {
                return false;
            }
        }
        Value::Object(object) => {
            if let Some(Value::Array(required)) = rules.get("required")
                && required
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|name| !object.contains_key(name))
            {
                return false;
            }
            if let Some(Value::Object(properties)) = rules.get("properties")
                && properties
                    .iter()
                    .any(|(name, rule)| object.get(name).is_some_and(|item| !matches(rule, item)))
            {
                return false;
            }
        }
        _ => {}
    }

    true
}

fn is_type(kind: &str, value: &Value) -> bool {
    match kind {
        "string" => value.is_string(),
        "number" => number_of(value).is_some(),
        "integer" => number_of(value).is_some_and(|number| number == number.trunc()),
        "boolean" => value.is_boolean(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        // A type this list does not know is not checked.
        _ => true,
    }
}

fn number_of(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_shared_cases_as_every_sdk_does() {
        let shared: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/argument-checks.json"
        )))
        .unwrap();
        for case in shared["cases"].as_array().unwrap() {
            let arguments = case["arguments"].as_object();
            let found = if case["arguments"].is_null() || arguments.is_some() {
                invalid_arguments(&case["schema"], arguments)
            } else {
                // Arguments that are not an object give no names; rmcp only ever hands over an object.
                Vec::new()
            };
            let expected: Vec<String> = serde_json::from_value(case["invalid"].clone()).unwrap();
            assert_eq!(found, expected, "{}", case["case"]);
        }
    }

    #[test]
    fn finds_nothing_without_a_schema() {
        let arguments = serde_json::json!({"passengers": 2});
        assert!(invalid_arguments(&Value::Null, arguments.as_object()).is_empty());
    }
}
