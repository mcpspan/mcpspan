//! Whether a call repeats the previous call to the same tool in the same session (contract, 3.9): an agent stuck in
//! a loop.
//!
//! Only the answer leaves the process. Kept here is a SHA-256 of the canonical arguments of the latest call per
//! session and tool, never sent: a digest of a short identifier or an enumerated value is found by trying every one.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Session and tool pairs kept, the oldest forgotten first.
pub(crate) const MAX_KEPT: usize = 10_000;

#[derive(Default)]
struct Kept {
    /// The digest of each pair's latest arguments, and when it was last noted.
    latest: HashMap<(String, String), ([u8; 32], u64)>,
    clock: u64,
}

fn kept() -> &'static Mutex<Kept> {
    static KEPT: OnceLock<Mutex<Kept>> = OnceLock::new();
    KEPT.get_or_init(Mutex::default)
}

/// Notes a call's arguments, as the client sent them, and says whether they are the previous call's to the same tool
/// in the same session. Arguments that cannot be written down are never a repeat.
pub(crate) fn note_arguments(session_id: &str, tool_name: &str, arguments: Option<&Map<String, Value>>) -> bool {
    let value = Value::Object(arguments.cloned().unwrap_or_default());
    let Some(text) = crate::definition::canonical_text(&value) else {
        return false;
    };
    let digest: [u8; 32] = Sha256::digest(text.as_bytes()).into();

    let Ok(mut kept) = kept().lock() else {
        return false;
    };
    kept.clock += 1;
    let now = kept.clock;
    let previous = kept
        .latest
        .insert((session_id.to_owned(), tool_name.to_owned()), (digest, now));
    if kept.latest.len() > MAX_KEPT {
        // The oldest tenth at once, so forgetting costs a sort now and then rather than a scan on every call.
        let mut ages: Vec<u64> = kept.latest.values().map(|(_, at)| *at).collect();
        ages.sort_unstable();
        let cutoff = ages[MAX_KEPT / 10];
        kept.latest.retain(|_, (_, at)| *at > cutoff);
    }
    previous.is_some_and(|(earlier, _)| earlier == digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(json: &str) -> Map<String, Value> {
        serde_json::from_str(json).expect("JSON object")
    }

    #[test]
    fn tells_a_repeat_whatever_the_key_order_and_forgets_the_oldest_past_its_bound() {
        assert!(!note_arguments("r1", "search", Some(&args(r#"{"to":"WAW","n":2}"#))));
        assert!(note_arguments("r1", "search", Some(&args(r#"{"n":2,"to":"WAW"}"#))));
        assert!(!note_arguments("r1", "search", Some(&args(r#"{"to":"KRK","n":2}"#))));
        assert!(!note_arguments("r1", "book", Some(&args(r#"{"to":"KRK","n":2}"#))));
        assert!(!note_arguments("r2", "search", Some(&args(r#"{"to":"KRK","n":2}"#))));
        assert!(!note_arguments("r1", "list", None));
        assert!(note_arguments("r1", "list", Some(&Map::new())));

        // One test, not two: the pairs are kept for the whole process, and a second test filling them past the
        // bound while this one runs would forget what it had just noted.
        note_arguments("oldest", "search", Some(&args(r#"{"to":"WAW"}"#)));
        for i in 0..MAX_KEPT {
            note_arguments(&format!("bound{i}"), "search", None);
        }
        assert!(!note_arguments("oldest", "search", Some(&args(r#"{"to":"WAW"}"#))));
    }
}
