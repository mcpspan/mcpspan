import type { ToolCallEvent } from './types.js';
import { SDK_VERSION } from './version.js';

/** Path the ingest API accepts batches on, appended to the configured endpoint. */
const EVENTS_PATH = '/v1/events';

/** How long a single delivery attempt may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface TransportConfig {
  /** Base URL of the ingest API, without the events path. */
  endpoint: string;

  /** API key identifying the server these events belong to. */
  apiKey: string;

  /** Overrides {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * A delivery attempt that did not succeed.
 *
 * `retryable` says whether sending the same batch again could plausibly work.
 * A refused API key or a malformed payload will be refused identically every
 * time, so repeating those attempts only burns the developer's bandwidth.
 */
export class TransportError extends Error {
  override readonly name = 'TransportError';

  /** HTTP status the ingest API answered with, absent when the request never completed. */
  readonly status: number | undefined;

  readonly retryable: boolean;

  /** How long the ingest API asked to be left alone, from `Retry-After`, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { status?: number; retryable: boolean; cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Whether a batch rejected with this status is worth sending again.
 *
 * Retry on the statuses that describe a passing condition: the server asked us
 * to slow down, timed the request out, or failed on its own side. Anything else
 * in the 4xx range is a verdict on the request itself and will not change.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Joins the configured endpoint with the events path, tolerating a trailing slash. */
export function buildEventsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}${EVENTS_PATH}`;
}

/**
 * Delivers one batch of events to the ingest API.
 *
 * Throws {@link TransportError} on any outcome that is not an accepted batch.
 * Callers are expected to decide what to do about that; this function neither
 * retries nor swallows.
 */
export async function sendEvents(
  events: readonly ToolCallEvent[],
  config: TransportConfig,
): Promise<void> {
  const url = buildEventsUrl(config.endpoint);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        // The language in brackets, as the contract asks, so an installation
        // with servers in several can tell their SDKs apart.
        'user-agent': `mcpspan/${SDK_VERSION} (typescript)`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // Unreachable host, DNS failure, connection reset, or our own timeout.
    // All of them describe the moment rather than the batch, so all retry.
    throw new TransportError(`Failed to reach ${url}`, { retryable: true, cause });
  }

  if (!response.ok) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

    throw new TransportError(`Ingest API rejected the batch with ${response.status}`, {
      status: response.status,
      retryable: isRetryableStatus(response.status),
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    });
  }
}

/**
 * Longest wait a `Retry-After` is followed to.
 *
 * A server asking for longer is either wrong or unwell, and a telemetry queue
 * that stops for a day on its word loses the day. Past this the SDK waits
 * this long and asks again.
 */
export const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Reads `Retry-After`, in either of its forms: whole seconds, or a date.
 *
 * Undefined when absent or unreadable, which leaves the SDK's own backoff to
 * decide.
 */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;

  const trimmed = header.trim();
  let ms: number;

  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }

  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}
