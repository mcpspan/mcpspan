//! Collecting events and delivering them from a thread of its own.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::event::Event;
use crate::transport::{Failure, Sender};

pub(crate) const DEFAULT_FLUSH_INTERVAL: Duration = Duration::from_secs(5);
pub(crate) const DEFAULT_MAX_BATCH_SIZE: usize = 100;
pub(crate) const DEFAULT_MAX_QUEUE_SIZE: usize = 10_000;

/// Where diagnostics go: the developer's callback, or standard error.
pub(crate) type Diagnostic = Arc<dyn Fn(&str) + Send + Sync>;

/// The wait after the n-th consecutive failure: doubling to a ceiling, spread over its second half.
pub(crate) fn backoff(failures: u32, random: f64) -> Duration {
    let ceiling = (1_000.0 * 2f64.powi(failures.saturating_sub(1).min(16) as i32)).min(60_000.0);
    Duration::from_millis((ceiling / 2.0 + random * ceiling / 2.0) as u64)
}

struct State {
    queue: VecDeque<Event>,
    dropped: usize,
    reported_drops: usize,
    failures: u32,
    next_attempt: Option<Instant>,
    woken: bool,
    stopped: bool,
    rejected: bool,
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    // One delivery at a time, so the same events are never posted twice.
    sending: Mutex<()>,
    send: Sender,
    endpoint: String,
    flush_interval: Duration,
    max_batch_size: usize,
    max_queue_size: usize,
    debug: bool,
    on_diagnostic: Option<Diagnostic>,
}

/// Collects events and delivers them from a thread of its own.
///
/// `record` is the only method a tool call touches, and it only appends to memory under a lock: the call returns
/// without waiting on the network, whatever async runtime the server runs on. A Rust program ends when `main`
/// returns, whatever threads are still running, so this one never keeps it alive.
pub(crate) struct Reporter {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic elsewhere while holding the lock leaves the data as it was; carrying on is safer than panicking.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Reporter {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        endpoint: String,
        send: Sender,
        flush_interval: Duration,
        max_batch_size: usize,
        max_queue_size: usize,
        debug: bool,
        on_diagnostic: Option<Diagnostic>,
    ) -> Self {
        Reporter {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    queue: VecDeque::new(),
                    dropped: 0,
                    reported_drops: 0,
                    failures: 0,
                    next_attempt: None,
                    woken: false,
                    stopped: false,
                    rejected: false,
                }),
                wake: Condvar::new(),
                sending: Mutex::new(()),
                send,
                endpoint,
                flush_interval,
                max_batch_size,
                max_queue_size,
                debug,
                on_diagnostic,
            }),
            thread: Mutex::new(None),
        }
    }

    /// Starts delivery, announcing the server first (contract, 3.4).
    pub(crate) fn start(&self) {
        let shared = Arc::clone(&self.shared);
        let spawned = thread::Builder::new()
            .name("mcpspan-delivery".into())
            .spawn(move || shared.run());
        if let Ok(handle) = spawned {
            *lock(&self.thread) = Some(handle);
        }
    }

    /// Queues an event and returns at once.
    pub(crate) fn record(&self, event: Event) {
        let mut state = lock(&self.shared.state);
        if state.stopped || state.rejected {
            return;
        }
        if state.queue.len() >= self.shared.max_queue_size {
            state.queue.pop_front();
            state.dropped += 1;
        }
        state.queue.push_back(event);
        if state.queue.len() >= self.shared.max_batch_size {
            state.woken = true;
            self.shared.wake.notify_one();
        }
    }

    /// Delivers what is queued now, ignoring any retry delay, and carries on.
    pub(crate) fn flush(&self) {
        self.shared.deliver(true);
    }

    /// Stops delivery and makes a final attempt at what is queued, ignoring any retry delay: this is the last
    /// chance these events get. A delivery already under way is waited for, rather than its events posted twice.
    pub(crate) fn stop(&self) {
        {
            let mut state = lock(&self.shared.state);
            state.stopped = true;
            state.woken = true;
        }
        self.shared.wake.notify_one();
        if let Some(handle) = lock(&self.thread).take() {
            let _ = handle.join();
        }
        self.shared.deliver(true);
    }
}

impl Shared {
    fn run(&self) {
        self.announce();
        loop {
            {
                let mut state = lock(&self.state);
                let deadline = Instant::now() + self.flush_interval;
                while !state.woken && !state.stopped && !state.rejected {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    state = self
                        .wake
                        .wait_timeout(state, deadline - now)
                        .map(|(guard, _)| guard)
                        .unwrap_or_else(|poisoned| poisoned.into_inner().0);
                }
                state.woken = false;
                if state.stopped || state.rejected {
                    return;
                }
            }
            self.deliver(false);
        }
    }

    fn announce(&self) {
        match (self.send)(&[]) {
            Ok(()) => {}
            Err(Failure {
                status: Some(status @ (401 | 403)),
                ..
            }) => self.reject(status),
            Err(failure) => self.log(&format!(
                "mcpspan: could not announce this server to {} ({}). Events will still be delivered once it answers.",
                self.endpoint, failure.message
            )),
        }
    }

    fn deliver(&self, force: bool) {
        {
            let state = lock(&self.state);
            let waiting = state.next_attempt.is_some_and(|at| Instant::now() < at);
            if state.rejected || (!force && waiting) {
                return;
            }
        }
        let _sending = lock(&self.sending);
        self.report_drops();
        loop {
            let batch: Vec<Event> = {
                let mut state = lock(&self.state);
                if state.rejected {
                    return;
                }
                let take = state.queue.len().min(self.max_batch_size);
                state.queue.drain(..take).collect()
            };
            if batch.is_empty() {
                return;
            }
            match (self.send)(&batch) {
                Ok(()) => {
                    let mut state = lock(&self.state);
                    state.failures = 0;
                    state.next_attempt = None;
                }
                Err(failure) => {
                    self.failed(batch, failure);
                    return;
                }
            }
        }
    }

    fn report_drops(&self) {
        let dropped = {
            let mut state = lock(&self.state);
            let dropped = state.dropped - state.reported_drops;
            state.reported_drops = state.dropped;
            dropped
        };
        if dropped > 0 {
            self.log(&format!("mcpspan: discarded {dropped} events, the queue was full"));
        }
    }

    fn failed(&self, batch: Vec<Event>, failure: Failure) {
        if let Some(status @ (401 | 403)) = failure.status {
            self.reject(status);
            return;
        }
        let dropped = batch.len();
        let attempt = {
            let mut state = lock(&self.state);
            if failure.retryable {
                for event in batch.into_iter().rev() {
                    state.queue.push_front(event);
                }
                while state.queue.len() > self.max_queue_size {
                    state.queue.pop_front();
                    state.dropped += 1;
                }
            }
            state.failures += 1;
            // The longer of our own backoff and what the API asked for.
            let wait = backoff(state.failures, random()).max(failure.retry_after);
            state.next_attempt = Some(Instant::now() + wait);
            state.failures
        };
        if !failure.retryable {
            // Refused the same way every time: dropped, and collecting goes on.
            self.log(&format!(
                "mcpspan: dropped {dropped} events, rejected as {}",
                failure.status.unwrap_or_default()
            ));
        }
        self.log(&format!(
            "mcpspan: delivery failed ({}), attempt {attempt}",
            failure.message
        ));
    }

    /// Gives up on a key the endpoint refused, and says so once even with diagnostics off: a silent SDK collecting
    /// nothing because of a mistyped key is the worst way to spend an afternoon.
    fn reject(&self, status: u16) {
        {
            let mut state = lock(&self.state);
            if state.rejected {
                return;
            }
            state.rejected = true;
            state.queue.clear();
        }
        self.wake.notify_one();
        self.warn(&format!(
            "mcpspan: the ingest endpoint rejected the API key (HTTP {status}). Telemetry is now disabled for this process."
        ));
    }

    fn log(&self, message: &str) {
        if self.debug {
            self.warn(message);
        }
    }

    /// The developer's callback if given, otherwise standard error. Never standard output: on the stdio transport
    /// it carries the MCP protocol, and a stray line there breaks the server.
    fn warn(&self, message: &str) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &self.on_diagnostic {
            Some(callback) => callback(message),
            None => eprintln!("{message}"),
        }));
    }
}

/// A number in [0, 1) that differs between processes and calls, for spreading retries; nothing depends on its
/// quality.
fn random() -> f64 {
    let bits = uuid::Uuid::new_v4().as_u128() >> 75;
    bits as f64 / (1u128 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Event;

    fn event(name: &str) -> Event {
        Event {
            id: name.into(),
            kind: None,
            tool_name: name.into(),
            duration_ms: 1.0,
            success: true,
            error_source: None,
            error_type: None,
            error_message: None,
            client_type: "unknown",
            client_name: None,
            client_version: None,
            server_version: None,
            timestamp: "2026-01-01T00:00:00.000Z".into(),
            session_id: None,
            parameters: None,
        }
    }

    type Sent = Arc<Mutex<Vec<Vec<String>>>>;

    /// A reporter whose deliveries are answered, in turn, by `answers`, then succeed; and what each carried.
    fn reporter(answers: Vec<Option<Failure>>, batch: usize, queue: usize) -> (Reporter, Sent) {
        let sent: Sent = Arc::default();
        let log = Arc::clone(&sent);
        let answers = Mutex::new(VecDeque::from(answers));
        let send: Sender = Box::new(move |events: &[Event]| {
            log.lock()
                .unwrap()
                .push(events.iter().map(|event| event.tool_name.clone()).collect());
            match answers.lock().unwrap().pop_front().flatten() {
                Some(failure) => Err(failure),
                None => Ok(()),
            }
        });
        let reporter = Reporter::new(
            "test".into(),
            send,
            Duration::from_secs(3600),
            batch,
            queue,
            false,
            None,
        );
        (reporter, sent)
    }

    fn failure(status: u16, retryable: bool, retry_after: Duration) -> Option<Failure> {
        Some(Failure {
            message: format!("{status}"),
            status: Some(status),
            retryable,
            retry_after,
        })
    }

    #[test]
    fn splits_what_is_queued_into_batches() {
        let (reporter, sent) = reporter(vec![], 2, 100);
        for name in ["a", "b", "c"] {
            reporter.record(event(name));
        }
        reporter.flush();
        assert_eq!(*sent.lock().unwrap(), vec![vec!["a", "b"], vec!["c"]]);
    }

    #[test]
    fn keeps_a_batch_that_may_succeed_later_and_waits_before_trying_again() {
        let (reporter, sent) = reporter(vec![failure(503, true, Duration::ZERO)], 100, 100);
        reporter.record(event("a"));
        reporter.flush();
        reporter.shared.deliver(false);
        assert_eq!(sent.lock().unwrap().len(), 1, "not tried again within the backoff");

        reporter.flush();
        assert_eq!(*sent.lock().unwrap(), vec![vec!["a"], vec!["a"]]);
    }

    #[test]
    fn waits_as_long_as_retry_after_asks() {
        let (reporter, _) = reporter(vec![failure(429, true, Duration::from_secs(120))], 100, 100);
        reporter.record(event("a"));
        reporter.flush();
        let next = reporter.shared.state.lock().unwrap().next_attempt.unwrap();
        assert!(next >= Instant::now() + Duration::from_secs(119));
    }

    #[test]
    fn drops_a_batch_refused_as_malformed_and_carries_on() {
        let (reporter, sent) = reporter(vec![failure(400, false, Duration::ZERO)], 100, 100);
        reporter.record(event("a"));
        reporter.flush();
        reporter.record(event("b"));
        reporter.flush();
        assert_eq!(*sent.lock().unwrap(), vec![vec!["a"], vec!["b"]]);
    }

    #[test]
    fn a_full_queue_drops_the_oldest() {
        let (reporter, sent) = reporter(vec![], 100, 2);
        for name in ["a", "b", "c"] {
            reporter.record(event(name));
        }
        reporter.flush();
        assert_eq!(*sent.lock().unwrap(), vec![vec!["b", "c"]]);
    }

    #[test]
    fn a_full_batch_is_sent_without_waiting_for_the_interval() {
        let (reporter, sent) = reporter(vec![], 2, 100);
        reporter.start();
        reporter.record(event("a"));
        reporter.record(event("b"));
        let deadline = Instant::now() + Duration::from_secs(5);
        while sent.lock().unwrap().len() < 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            *sent.lock().unwrap(),
            vec![vec![], vec!["a", "b"]],
            "the announcement, then the batch"
        );
        reporter.stop();
    }

    #[test]
    fn backoff_doubles_to_a_ceiling_within_the_spread() {
        assert_eq!(backoff(1, 0.0), Duration::from_millis(500));
        assert_eq!(backoff(1, 1.0), Duration::from_secs(1));
        assert_eq!(backoff(3, 1.0), Duration::from_secs(4));
        assert_eq!(backoff(30, 1.0), Duration::from_secs(60));
    }
}
