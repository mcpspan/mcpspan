import { formatError } from './failure.js';
import { DEFAULT_MAX_QUEUE_SIZE, EventQueue } from './queue.js';
import { sendEvents, TransportError, type TransportConfig } from './transport.js';
import type { ToolCallEvent } from './types.js';

/** How long events wait before a partly filled batch is sent anyway. */
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/**
 * Largest number of events in a single request.
 *
 * Reaching it also triggers an immediate flush, so a busy server does not sit
 * on a full queue waiting for the interval. At the measured worst case of
 * 595 B per event this keeps a request around 60 kB.
 */
export const DEFAULT_MAX_BATCH_SIZE = 100;

/** Delay before the first retry, doubling with each further failure. */
export const INITIAL_RETRY_DELAY_MS = 1_000;

/** Ceiling for the retry delay, so a long outage settles into steady polling. */
export const MAX_RETRY_DELAY_MS = 60_000;

/**
 * How long to wait before attempting delivery again.
 *
 * Doubles per consecutive failure up to a ceiling, then spreads each client's
 * attempt across the second half of that window. The spread matters once many
 * servers report to the same endpoint: without it they would all have failed
 * at the same moment, and would all come back at the same moment, turning one
 * outage into a second one at the point of recovery.
 */
export function computeBackoffMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    MAX_RETRY_DELAY_MS,
    INITIAL_RETRY_DELAY_MS * 2 ** (consecutiveFailures - 1),
  );

  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export interface ReporterOptions extends TransportConfig {
  /** Overrides {@link DEFAULT_FLUSH_INTERVAL_MS}. */
  flushIntervalMs?: number;

  /** Overrides {@link DEFAULT_MAX_BATCH_SIZE}. */
  maxBatchSize?: number;

  /** Overrides {@link DEFAULT_MAX_QUEUE_SIZE}. */
  maxQueueSize?: number;

  /** Writes delivery diagnostics to stderr. Off by default. */
  debug?: boolean;

  /** Receives diagnostics instead of stderr. */
  onDiagnostic?: (message: string) => void;
}

/**
 * Collects events and delivers them in the background.
 *
 * `record` is the only method a tool call touches, and it does nothing beyond
 * appending to an in-memory queue: the calling handler returns to the agent
 * without waiting on the network. Delivery happens on an interval, or as soon
 * as a full batch has accumulated, whichever comes first.
 *
 * Nothing that happens during delivery is allowed to surface anywhere near the
 * developer's code. A failure is contained, logged when asked for, and either
 * retried or abandoned depending on whether repeating it could ever work.
 */
export class EventReporter {
  private readonly queue: EventQueue;
  private readonly transport: TransportConfig;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly debug: boolean;
  private readonly onDiagnostic: ((message: string) => void) | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  private consecutiveFailures = 0;
  private nextAttemptAt = 0;

  /** Discards already mentioned, so the same loss is not reported twice. */
  private reportedDrops = 0;

  /** Set when the endpoint rejected our credentials, which no retry can fix. */
  private rejected = false;

  constructor(options: ReporterOptions) {
    this.queue = new EventQueue(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
    this.transport = {
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    };
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.debug = options.debug ?? false;
    this.onDiagnostic = options.onDiagnostic;
  }

  /** How many events are waiting to be delivered. */
  get queueSize(): number {
    return this.queue.size;
  }

  /**
   * Queues an event for delivery and returns immediately.
   *
   * Synchronous and non-blocking by contract: this sits on the path of every
   * tool call, so anything slower would show up as latency in the developer's
   * own product.
   */
  record(event: ToolCallEvent): void {
    if (this.stopped || this.rejected) return;

    this.queue.add(event);
    this.startTimer();

    if (this.queue.size >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /**
   * Tells the ingest API this process has started, before any tool is called.
   *
   * An empty batch, sent once. It carries nothing, but it proves the endpoint
   * and the key work, which is otherwise unknowable until the first tool call:
   * a server nobody has used yet and a server pointed at the wrong address
   * look identical from the dashboard. It also means a wrong key is reported
   * when the server starts, rather than whenever somebody first calls a tool.
   *
   * An empty batch rather than a new endpoint, because every version of the
   * ingest API has accepted one, so this works against an installation older
   * than the SDK talking to it.
   *
   * Never retried and never rejects. Missing the announcement costs a line on
   * a status page, and the first real batch says the same thing anyway.
   */
  async announce(): Promise<void> {
    if (this.stopped || this.rejected) return;

    try {
      await sendEvents([], this.transport);
    } catch (error) {
      const status = error instanceof TransportError ? error.status : undefined;

      if (status === 401 || status === 403) {
        this.reject(status);
        return;
      }

      this.log(
        `mcpspan: could not announce this server to ${this.transport.endpoint} ` +
          `(${formatError(error)}). ` +
          'Events will still be delivered once it answers.',
      );
    }
  }

  /**
   * Delivers everything queued, in batches.
   *
   * Does nothing while a retry delay is still running. Concurrent calls join
   * the flush already in progress rather than starting a second one, so the
   * same events are never posted twice.
   */
  flush(): Promise<void> {
    return this.runFlush(false);
  }

  /**
   * Stops background delivery and makes a final attempt at whatever is queued.
   *
   * Ignores any pending retry delay: this is the last chance these events get,
   * and without it the final partly filled batch dies with the process - which
   * on a short-lived stdio server can mean most of a session.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    await this.runFlush(true);
  }

  private runFlush(force: boolean): Promise<void> {
    if (this.rejected) return Promise.resolve();
    if (!force && Date.now() < this.nextAttemptAt) return Promise.resolve();

    this.inFlight ??= this.drainQueue().finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  private async drainQueue(): Promise<void> {
    this.reportDrops();

    while (this.queue.size > 0) {
      const batch = this.queue.drain(this.maxBatchSize);

      try {
        await sendEvents(batch, this.transport);
        this.onDelivered();
      } catch (error) {
        this.onFailed(batch, error);
        return;
      }
    }
  }

  /**
   * Mentions events the queue had to throw away since the last time we looked.
   *
   * A full queue means the dashboard is about to under-report, and a developer
   * chasing a discrepancy has no other way to find that out. Counting drops
   * without ever saying so would make the count a decoration.
   */
  private reportDrops(): void {
    const dropped = this.queue.droppedCount - this.reportedDrops;
    if (dropped <= 0) return;

    this.reportedDrops = this.queue.droppedCount;
    this.log(`mcpspan: discarded ${dropped} events, the queue was full`);
  }

  private onDelivered(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
  }

  private onFailed(batch: readonly ToolCallEvent[], error: unknown): void {
    const retryable = error instanceof TransportError ? error.retryable : true;
    const status = error instanceof TransportError ? error.status : undefined;

    if (status === 401 || status === 403) {
      this.reject(status);
      return;
    }

    if (retryable) {
      this.queue.restore(batch);
    } else {
      // Resending a batch the server called malformed would be refused the
      // same way every time. Drop these and keep collecting the rest.
      this.log(`mcpspan: dropped ${batch.length} events, rejected as ${String(status)}`);
    }

    this.consecutiveFailures += 1;
    // The longer of the two: our own backoff, which spreads many clients out,
    // and what the server asked for, which is when it expects to have room.
    // Retrying sooner than asked only earns another refusal.
    const asked = error instanceof TransportError ? (error.retryAfterMs ?? 0) : 0;
    const backoff = computeBackoffMs(this.consecutiveFailures);
    this.nextAttemptAt = Date.now() + Math.max(backoff, asked);
    this.log(`mcpspan: delivery failed (${formatError(error)}), attempt ${this.consecutiveFailures}`);
  }

  /**
   * Gives up on a key the endpoint refused.
   *
   * The key will be refused identically until the developer changes it and
   * restarts, so keeping events for it only wastes their memory. This one
   * warns without being asked: a silent SDK that collects nothing because of a
   * mistyped key is the worst way for someone to spend an afternoon.
   */
  private reject(status: number): void {
    if (this.rejected) return;

    this.rejected = true;
    this.clearTimer();
    this.queue.drain();
    this.warn(
      `mcpspan: the ingest endpoint rejected the API key (HTTP ${status}). ` +
        'Telemetry is now disabled for this process.',
    );
  }

  private startTimer(): void {
    if (this.timer !== undefined || this.stopped || this.rejected) return;

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    // A pending interval keeps Node alive. An MCP server talking over stdio is
    // expected to exit when its client disconnects, and a telemetry timer must
    // not be the reason it hangs around instead.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;

    clearInterval(this.timer);
    this.timer = undefined;
  }

  private log(message: string): void {
    if (this.debug) this.warn(message);
  }

  /**
   * The developer's own logger if they gave us one, otherwise stderr.
   *
   * Never stdout. On a stdio transport stdout carries the MCP protocol itself,
   * so a stray line printed there does not just look untidy - it corrupts the
   * stream and breaks the developer's server.
   */
  private warn(message: string): void {
    try {
      if (this.onDiagnostic) {
        this.onDiagnostic(message);
        return;
      }

      console.error(message);
    } catch {
      // Even reporting a problem must not become one.
    }
  }
}
