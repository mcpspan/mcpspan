import type { ToolCallEvent } from './types.js';

/**
 * How many events the buffer holds before it starts discarding.
 *
 * The buffer has to be bounded: if the ingest endpoint is unreachable while
 * tools keep being called, an unbounded buffer grows until the host process
 * runs out of memory, and taking down the developer's server is the one thing
 * this SDK must never do.
 *
 * The bound is a ceiling rather than a reservation. While ingest is healthy
 * the queue drains every few seconds and holds a few dozen events, so the
 * figure below only matters during an outage - which is exactly when we want
 * the headroom. A measured event costs 233 B when it succeeds and 595 B when
 * it carries a unique error message, putting the worst case here under 6 MB.
 *
 * At ten calls per second that covers roughly seventeen minutes of downtime,
 * which is long enough to survive a backend restart or a network blip. A
 * thousand would cover a hundred seconds, and lose data during an ordinary
 * deploy.
 */
export const DEFAULT_MAX_QUEUE_SIZE = 10_000;

/**
 * In-memory buffer of events waiting to be sent.
 *
 * This holds events and nothing else. Deciding when to send them, and sending
 * them, belongs to the flush mechanism that drains the queue.
 */
export class EventQueue {
  /** Capacity at which the oldest buffered event starts being discarded. */
  readonly maxSize: number;

  private events: ToolCallEvent[] = [];
  private dropped = 0;

  constructor(maxSize: number = DEFAULT_MAX_QUEUE_SIZE) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new TypeError(`maxSize must be a positive integer, received ${maxSize}`);
    }
    this.maxSize = maxSize;
  }

  /** How many events are currently buffered. */
  get size(): number {
    return this.events.length;
  }

  /** How many events have been discarded because the buffer was full. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Buffers an event, discarding the oldest one when the buffer is full.
   *
   * Newest wins on purpose: once the backend comes back, a developer wants to
   * see what their server is doing now, not a snapshot frozen at the moment
   * the outage started.
   */
  add(event: ToolCallEvent): void {
    if (this.events.length >= this.maxSize) {
      this.events.shift();
      this.dropped += 1;
    }
    this.events.push(event);
  }

  /**
   * Removes and returns buffered events, oldest first.
   *
   * Without a limit this empties the queue. With one it takes at most that
   * many, which is what keeps a backlog from being posted as a single huge
   * request: after an outage the queue can hold thousands of events, and one
   * request carrying all of them would be refused for size and thrown away
   * whole.
   */
  drain(limit?: number): ToolCallEvent[] {
    if (limit === undefined || limit >= this.events.length) {
      const drained = this.events;
      this.events = [];
      return drained;
    }

    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError(`limit must be a positive integer, received ${limit}`);
    }

    return this.events.splice(0, limit);
  }

  /**
   * Puts a batch that failed to deliver back at the front of the queue.
   *
   * These events are older than anything queued since, so they go ahead of it
   * and keep the stream in order. If that pushes the queue past capacity the
   * usual rule still applies and the oldest go - which may well be the ones
   * just restored, because an outage long enough to overflow the queue has
   * already made them the least interesting events we hold.
   */
  restore(events: readonly ToolCallEvent[]): void {
    if (events.length === 0) return;

    // concat rather than unshift(...events): spreading a large batch as
    // arguments risks blowing the call stack.
    this.events = (events as ToolCallEvent[]).concat(this.events);

    const overflow = this.events.length - this.maxSize;
    if (overflow > 0) {
      this.events.splice(0, overflow);
      this.dropped += overflow;
    }
  }
}
