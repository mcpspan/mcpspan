//! What the SDK needs to know.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use crate::reporter::{DEFAULT_FLUSH_INTERVAL, DEFAULT_MAX_BATCH_SIZE, DEFAULT_MAX_QUEUE_SIZE, Diagnostic};

/// Where telemetry goes unless the developer points it elsewhere.
/// Said when there is a key and nowhere to send: somebody meant to collect. There is no default endpoint, since
/// mcpspan runs wherever its user runs it, and a default would send their data somewhere they did not choose.
pub(crate) const NO_ENDPOINT: &str = "mcpspan: an API key is set but no endpoint, so nothing is collected. Set \
    MCPSPAN_ENDPOINT (or the endpoint option) to your mcpspan installation, for example http://localhost:6271.";

/// The API takes at most this many events in one request.
const MAX_EVENTS_PER_REQUEST: usize = 1_000;

/// Settings for [`configure`](crate::configure). Nothing is collected without a key and an endpoint, each read
/// from the environment when not set here; the rest is optional:
///
/// ```
/// use std::time::Duration;
///
/// let options = mcpspan::Options::default()
///     .api_key("mcps_...")
///     .endpoint("http://localhost:6271")
///     .capture_parameter_names(true)
///     .flush_interval(Duration::from_secs(10));
/// ```
#[derive(Clone)]
pub struct Options {
    pub(crate) api_key: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) capture_parameter_names: bool,
    pub(crate) server_version: Option<String>,
    pub(crate) debug: bool,
    pub(crate) on_diagnostic: Option<Diagnostic>,
    pub(crate) flush_interval: Duration,
    pub(crate) max_batch_size: usize,
    pub(crate) max_queue_size: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            api_key: None,
            endpoint: None,
            capture_parameter_names: false,
            server_version: None,
            debug: false,
            on_diagnostic: None,
            flush_interval: DEFAULT_FLUSH_INTERVAL,
            max_batch_size: DEFAULT_MAX_BATCH_SIZE,
            max_queue_size: DEFAULT_MAX_QUEUE_SIZE,
        }
    }
}

impl Options {
    /// Identifies the server. Falls back to `MCPSPAN_API_KEY`; without either, nothing is collected.
    pub fn api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    /// The base URL of your mcpspan installation. Falls back to `MCPSPAN_ENDPOINT`. There is no default: without
    /// either, nothing is collected, and the SDK says so once.
    pub fn endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = Some(endpoint.into());
        self
    }

    /// Records which parameters a tool was called with, by name and JSON type. Values are never read. Off by
    /// default.
    pub fn capture_parameter_names(mut self, capture: bool) -> Self {
        self.capture_parameter_names = capture;
        self
    }

    /// The version to record calls under: a release, a tag, a commit. Falls back to `MCPSPAN_SERVER_VERSION`,
    /// then the version the server gives itself in `get_info`.
    pub fn server_version(mut self, version: impl Into<String>) -> Self {
        self.server_version = Some(version.into());
        self
    }

    /// Writes delivery diagnostics to standard error. Off by default.
    pub fn debug(mut self, debug: bool) -> Self {
        self.debug = debug;
        self
    }

    /// Receives diagnostics instead of standard error, and implies [`debug`](Options::debug).
    pub fn on_diagnostic(mut self, callback: impl Fn(&str) + Send + Sync + 'static) -> Self {
        self.on_diagnostic = Some(Arc::new(callback));
        self
    }

    /// How long a partly filled batch waits. 5 seconds by default.
    pub fn flush_interval(mut self, interval: Duration) -> Self {
        self.flush_interval = interval;
        self
    }

    /// Events per request, 100 by default. Reaching it sends early.
    pub fn max_batch_size(mut self, size: usize) -> Self {
        self.max_batch_size = size;
        self
    }

    /// Events held while delivery is failing, 10,000 by default.
    pub fn max_queue_size(mut self, size: usize) -> Self {
        self.max_queue_size = size;
        self
    }
}

impl fmt::Debug for Options {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The key is a secret, and Debug output ends up in logs.
        f.debug_struct("Options")
            .field("api_key", &self.api_key.as_ref().map(|_| "<set>"))
            .field("endpoint", &self.endpoint)
            .field("capture_parameter_names", &self.capture_parameter_names)
            .field("server_version", &self.server_version)
            .field("debug", &self.debug)
            .field("on_diagnostic", &self.on_diagnostic.as_ref().map(|_| "<set>"))
            .field("flush_interval", &self.flush_interval)
            .field("max_batch_size", &self.max_batch_size)
            .field("max_queue_size", &self.max_queue_size)
            .finish()
    }
}

/// The settings in force once the environment and the defaults have had their say.
#[derive(Clone)]
pub(crate) struct Resolved {
    pub api_key: String,
    pub endpoint: String,
    pub capture: bool,
    /// Empty when the server's own version is the one to record.
    pub server_version: String,
    pub debug: bool,
    pub on_diagnostic: Option<Diagnostic>,
    pub flush_interval: Duration,
    pub max_batch_size: usize,
    pub max_queue_size: usize,
}

impl PartialEq for Resolved {
    fn eq(&self, other: &Self) -> bool {
        let same_callback = match (&self.on_diagnostic, &other.on_diagnostic) {
            (None, None) => true,
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            _ => false,
        };
        same_callback
            && self.api_key == other.api_key
            && self.endpoint == other.endpoint
            && self.capture == other.capture
            && self.server_version == other.server_version
            && self.debug == other.debug
            && self.flush_interval == other.flush_interval
            && self.max_batch_size == other.max_batch_size
            && self.max_queue_size == other.max_queue_size
    }
}

fn first_set(values: impl IntoIterator<Item = Option<String>>) -> String {
    values
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_owned())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

impl Resolved {
    pub(crate) fn from(options: &Options) -> Self {
        let debug = options.debug || options.on_diagnostic.is_some();
        let env = |name: &str| std::env::var(name).ok();
        let warn = |message: String| {
            if debug {
                match &options.on_diagnostic {
                    Some(callback) => callback(&message),
                    None => eprintln!("{message}"),
                }
            }
        };

        // A malformed setting falls back to its default, and says so when asked.
        let flush_interval = if options.flush_interval.is_zero() {
            warn("mcpspan: ignoring flush_interval of zero, expected a positive duration".into());
            DEFAULT_FLUSH_INTERVAL
        } else {
            options.flush_interval
        };
        let positive = |name: &str, value: usize, default: usize| {
            if value == 0 {
                warn(format!("mcpspan: ignoring {name}=0, expected a positive value"));
                default
            } else {
                value
            }
        };

        Resolved {
            api_key: first_set([options.api_key.clone(), env("MCPSPAN_API_KEY")]),
            // Empty when there is none; there is no default.
            endpoint: first_set([options.endpoint.clone(), env("MCPSPAN_ENDPOINT")]),
            capture: options.capture_parameter_names,
            server_version: first_set([options.server_version.clone(), env("MCPSPAN_SERVER_VERSION")]),
            debug,
            on_diagnostic: options.on_diagnostic.clone(),
            flush_interval,
            max_batch_size: positive("max_batch_size", options.max_batch_size, DEFAULT_MAX_BATCH_SIZE)
                .min(MAX_EVENTS_PER_REQUEST),
            max_queue_size: positive("max_queue_size", options.max_queue_size, DEFAULT_MAX_QUEUE_SIZE),
        }
    }
}
