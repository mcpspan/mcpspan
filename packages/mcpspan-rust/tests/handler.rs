//! An instrumented server is the server it wraps, method for method.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;

/// The methods declared at the trait's own level of indentation in a block of Rust source.
fn methods(source: &str, indent: &str) -> BTreeSet<String> {
    source
        .lines()
        .filter_map(|line| {
            let line = line.strip_prefix(indent)?;
            line.strip_prefix("fn ").or_else(|| line.strip_prefix("async fn "))
        })
        .map(|rest| {
            rest.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                .next()
                .unwrap()
                .to_owned()
        })
        .collect()
}

/// The source of the rmcp this crate was built against, wherever cargo put it.
fn rmcp_source() -> PathBuf {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let output = Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--manifest-path"])
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
        .output()
        .unwrap();
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let rmcp = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|package| package["name"] == "rmcp")
        .unwrap();
    PathBuf::from(rmcp["manifest_path"].as_str().unwrap())
        .parent()
        .unwrap()
        .join("src/handler/server.rs")
}

/// A method rmcp adds to `ServerHandler` comes with a default, so leaving it out of the wrapper still compiles,
/// and a server's own version of it would silently stop running once instrumented.
#[test]
fn every_method_is_passed_on() {
    let rmcp = std::fs::read_to_string(rmcp_source()).unwrap();
    let start = rmcp
        .find("macro_rules! server_handler_methods")
        .expect("rmcp declares its methods in a macro");
    let end = start + rmcp[start..].find("\n}\n").unwrap();
    let declared = methods(&rmcp[start..end], "        ");
    assert!(declared.contains("call_tool") && declared.len() > 20, "{declared:?}");

    let ours = methods(include_str!("../src/handler.rs"), "    ");
    let missing: Vec<_> = declared.difference(&ours).collect();
    assert!(
        missing.is_empty(),
        "rmcp's ServerHandler has methods the wrapper does not pass on: {missing:?}"
    );
}
