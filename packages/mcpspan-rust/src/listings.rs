//! The listings already sent for each session, so the same answer to `tools/list` is sent once per session
//! (contract, 3.11). A client lists the tools at the start of a session and often again; the count that matters is
//! the sessions that were shown the tools, not how often they asked.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

/// Sessions kept, the oldest forgotten first.
const MAX_SESSIONS: usize = 10_000;

#[derive(Default)]
struct Sent {
    signatures: HashMap<String, HashSet<String>>,
    order: VecDeque<String>,
}

fn sent() -> &'static Mutex<Sent> {
    static SENT: OnceLock<Mutex<Sent>> = OnceLock::new();
    SENT.get_or_init(Mutex::default)
}

/// Whether a listing is new for its session, noting it as sent. A listing with no session always is.
pub(crate) fn first(session: Option<&str>, signature: &str) -> bool {
    let Some(session) = session else { return true };
    let Ok(mut sent) = sent().lock() else { return true };
    if let Some(signatures) = sent.signatures.get_mut(session) {
        return signatures.insert(signature.to_owned());
    }
    sent.signatures
        .insert(session.to_owned(), HashSet::from([signature.to_owned()]));
    sent.order.push_back(session.to_owned());
    if sent.order.len() > MAX_SESSIONS
        && let Some(oldest) = sent.order.pop_front()
    {
        sent.signatures.remove(&oldest);
    }
    true
}
