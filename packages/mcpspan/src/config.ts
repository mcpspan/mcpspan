import { EventReporter, type ReporterOptions } from './reporter.js';
import { setCaptureParameterNames, setEventSink, setServerVersion } from './track.js';
import type { ToolCallEvent } from './types.js';

/**
 * Said when there is a key and nowhere to send: somebody meant to collect.
 * There is no default endpoint, since mcpspan runs wherever its user runs it,
 * and a default would send their data somewhere they did not choose.
 */
export const NO_ENDPOINT =
  'mcpspan: an API key is set but no endpoint, so nothing is collected. Set MCPSPAN_ENDPOINT (or the endpoint option) to your mcpspan installation, for example http://localhost:6271.';

/** Whether NO_ENDPOINT has been said in this process: once is enough. */
let saidNoEndpoint = false;

export interface McpspanConfig {
  /**
   * Key identifying the server these events belong to.
   *
   * Falls back to `MCPSPAN_API_KEY`. Without either, the SDK collects nothing.
   */
  apiKey?: string;

  /**
   * Base URL of the ingest API.
   *
   * Falls back to `MCPSPAN_ENDPOINT`. There is no default: without either,
   * the SDK collects nothing and says so once.
   */
  endpoint?: string;

  /**
   * The version to record calls under: a release, a tag, a commit.
   *
   * Falls back to `MCPSPAN_SERVER_VERSION`, then to the version the MCP server
   * gives itself (`new McpServer({ name, version })`), which is usually all
   * that is needed. The dashboard marks where each version began.
   */
  serverVersion?: string;

  /** Writes delivery diagnostics to stderr. Off by default. */
  debug?: boolean;

  /**
   * Receives diagnostics instead of stderr.
   *
   * For servers with their own logger, so our messages arrive in the same
   * stream and the same format as everything else. Implies `debug`.
   *
   * A callback that throws is ignored: a problem with reporting a problem
   * cannot be allowed to become one.
   */
  onDiagnostic?: (message: string) => void;

  /**
   * Sends whatever is queued when the process is about to exit.
   *
   * On by default. Without it the last partly filled batch dies with the
   * process, and on a stdio server that lives as long as one conversation
   * that can be most of a session.
   *
   * The hook runs when Node's event loop empties. It does not keep the
   * process alive, does not intercept signals, and does not interfere with a
   * server's own shutdown handling.
   */
  flushOnExit?: boolean;

  /** How long a partly filled batch waits before being sent anyway. */
  flushIntervalMs?: number;

  /** Largest number of events in a single request. */
  maxBatchSize?: number;

  /** Largest number of events held while delivery is failing. */
  maxQueueSize?: number;

  /**
   * Records which parameters a tool was called with, by name and type only.
   *
   * Off by default. Values are never read, in this mode or any other: the name
   * of this option is the whole promise. Turning it on tells you that
   * `search_flights` is always called with `destination` and never with
   * `departureDate`, which usually means a tool description is not landing.
   */
  captureParameterNames?: boolean;

  /**
   * Sends the text of a failure: what a tool returned with `isError`, cut to
   * 200 characters, or an exception's message, cut to 500.
   *
   * On by default, since that text is usually what says why a call failed.
   * Turn it off when your tools can fail with something you would not send
   * anywhere, as one that runs commands or reads files might quote a path or
   * a token. Every failure is still recorded, with where it came from and
   * the exception's type; only the text is left out.
   */
  captureErrorMessages?: boolean;
}

let reporter: EventReporter | undefined;
let exitHook: (() => void) | undefined;

/**
 * What the running reporter was configured with, to recognise the same
 * configuration arriving again.
 */
let active: { settings: string; onDiagnostic: McpspanConfig['onDiagnostic'] } | undefined;

/**
 * Starts collecting, or stops if there is nothing to collect with.
 *
 * Calling this again with a different configuration replaces the previous
 * one, sending whatever the old one still held. Calling it again with the same
 * configuration changes nothing. That is the common case, not an edge: an HTTP
 * server that builds a fresh MCP server for every request - the stateless
 * pattern, and how v2 of the official SDK serves the 2026-07-28 protocol -
 * calls instrument() on each of them, and starting over each time would
 * announce the server once per request and throw away the batching.
 *
 * **Never throws.** This runs inside a developer's server during startup, so a
 * mistyped option must not be the reason their server fails to boot. Bad
 * values are reported on stderr and replaced with defaults.
 */
export function configure(config: McpspanConfig = {}): void {
  const settings = describeSettings(config);

  if (
    reporter !== undefined &&
    active !== undefined &&
    active.settings === settings &&
    active.onDiagnostic === config.onDiagnostic
  ) {
    return;
  }

  active = undefined;
  const previous = reporter;
  reporter = undefined;
  setEventSink(undefined);
  setCaptureParameterNames(false);
  setServerVersion(undefined);
  removeExitHook();
  if (previous) void previous.stop();

  const debug = config.debug ?? config.onDiagnostic !== undefined;
  const apiKey = firstNonEmpty(config.apiKey, process.env['MCPSPAN_API_KEY']);

  // No key is a normal state, not a mistake: someone evaluating the package,
  // or running a server in CI, should be able to leave it out and have the SDK
  // do nothing at all. Saying so out loud on every boot would be noise.
  if (apiKey === undefined) return;

  const endpoint = firstNonEmpty(config.endpoint, process.env['MCPSPAN_ENDPOINT']);

  if (endpoint === undefined) {
    if (!saidNoEndpoint) {
      saidNoEndpoint = true;
      // Said unasked, as a refused key is: without it the data goes nowhere
      // and nothing tells anyone.
      try {
        (config.onDiagnostic ?? console.error)(NO_ENDPOINT);
      } catch {
        // A throwing callback is the developer's, not a reason to fail startup.
      }
    }
    return;
  }

  const options: ReporterOptions = {
    apiKey,
    endpoint,
    debug,
    ...(config.onDiagnostic !== undefined && { onDiagnostic: config.onDiagnostic }),
  };
  assignPositive(options, 'flushIntervalMs', config.flushIntervalMs, debug);
  assignPositive(options, 'maxBatchSize', config.maxBatchSize, debug);
  assignPositive(options, 'maxQueueSize', config.maxQueueSize, debug);

  reporter = new EventReporter(options);
  active = { settings, onDiagnostic: config.onDiagnostic };
  setCaptureParameterNames(config.captureParameterNames ?? false);
  setServerVersion(firstNonEmpty(config.serverVersion, process.env['MCPSPAN_SERVER_VERSION']));
  const captureErrorMessages = config.captureErrorMessages ?? true;
  setEventSink((event) => reporter?.record(captureErrorMessages ? event : withoutErrorMessage(event)));

  if (config.flushOnExit ?? true) installExitHook();

  // In the background. Startup does not wait for the network, and the call
  // cannot fail in a way that reaches the developer's code.
  void reporter.announce();
}

/**
 * Arranges one last delivery attempt as the process winds down.
 *
 * `beforeExit` fires when the event loop has emptied and Node is about to
 * leave. Scheduling work there is allowed and keeps the process alive just
 * long enough to finish it. Signals and explicit exits are deliberately not
 * intercepted: those belong to the server, and a telemetry library reaching
 * into them would be overstepping.
 */
function installExitHook(): void {
  if (exitHook !== undefined) return;

  exitHook = () => {
    void shutdown();
  };

  process.once('beforeExit', exitHook);
}

function removeExitHook(): void {
  if (exitHook === undefined) return;

  process.removeListener('beforeExit', exitHook);
  exitHook = undefined;
}

/**
 * Stops collecting and makes a final attempt to deliver what is queued.
 *
 * Worth calling from a server's own shutdown path. Without it the last partly
 * filled batch dies with the process, which on a short-lived stdio server can
 * be most of a session.
 */
export async function shutdown(): Promise<void> {
  const current = reporter;
  reporter = undefined;
  active = undefined;
  setEventSink(undefined);
  setCaptureParameterNames(false);
  setServerVersion(undefined);
  removeExitHook();

  await current?.stop();
}

/** Whether the SDK is currently recording tool calls. */
export function isCollecting(): boolean {
  return reporter !== undefined;
}

/**
 * Everything a configuration decides, resolved the way configure() resolves
 * it, as one comparable string. The key and endpoint are read through the
 * environment fallbacks, so the same effective setup compares equal however it
 * was spelt. The diagnostic callback is compared separately, by identity.
 */
function describeSettings(config: McpspanConfig): string {
  return JSON.stringify([
    firstNonEmpty(config.apiKey, process.env['MCPSPAN_API_KEY']) ?? null,
    firstNonEmpty(config.endpoint, process.env['MCPSPAN_ENDPOINT']) ?? null,
    config.debug ?? null,
    config.flushOnExit ?? true,
    config.flushIntervalMs ?? null,
    config.maxBatchSize ?? null,
    config.maxQueueSize ?? null,
    config.captureParameterNames ?? false,
    config.captureErrorMessages ?? true,
    firstNonEmpty(config.serverVersion, process.env['MCPSPAN_SERVER_VERSION']) ?? null,
  ]);
}

/** The event as it is, less the text of its failure (contract, 5). */
function withoutErrorMessage(event: ToolCallEvent): ToolCallEvent {
  if (event.errorMessage === undefined) return event;
  const { errorMessage: _left, ...rest } = event;
  return rest;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }

  return undefined;
}

type NumericOption = 'flushIntervalMs' | 'maxBatchSize' | 'maxQueueSize';

function assignPositive(
  options: ReporterOptions,
  name: NumericOption,
  value: number | undefined,
  debug: boolean,
): void {
  if (value === undefined) return;

  if (!Number.isInteger(value) || value < 1) {
    if (debug) {
      console.error(`mcpspan: ignoring ${name}=${String(value)}, expected a positive integer`);
    }
    return;
  }

  options[name] = value;
}
