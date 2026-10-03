/**
 * How fast one server may write, measured in events rather than in requests.
 *
 * Requests are the wrong unit. A batch may carry a thousand events, so a limit
 * of ten requests a second permits ten thousand rows a second, and a limit
 * tight enough to stop that would refuse a server sending one perfectly
 * ordinary batch every five seconds.
 *
 * A token bucket, so a burst is allowed and a sustained flood is not. That
 * matters here more than it usually does: the SDK holds events while it cannot
 * reach us, up to ten thousand of them, and delivers the backlog as fast as it
 * can once we answer again. A limit with no burst allowance would meet a
 * recovering server with refusals for minutes.
 *
 * Kept in memory, per process. A self-hosted installation runs one API, so
 * this is the whole picture; a second instance would get its own allowance,
 * which is worth knowing before putting two behind a load balancer.
 */

import { MAX_EVENTS_PER_BATCH } from './limits.ts';

/** Events per second a server may sustain. Ten times a busy server's traffic. */
const DEFAULT_EVENTS_PER_SECOND = 100;

/**
 * Events a server may deliver at once after being idle or cut off.
 *
 * Twice the SDK's own queue, so a server coming back from an outage empties
 * its backlog in one go rather than being metered through it.
 */
const DEFAULT_BURST_EVENTS = 20_000;

/**
 * Smallest burst that is coherent with what the API accepts.
 *
 * A bucket never holds more than its burst, so a batch larger than the burst
 * can never be paid for no matter how long anybody waits. The API accepts
 * batches of up to MAX_EVENTS_PER_BATCH, so a smaller burst than that creates
 * requests that are permanently refused: the SDK treats 429 as worth retrying,
 * backs off to a minute, and retries forever while its queue fills and starts
 * dropping. Nothing reports an error. The events simply never arrive.
 *
 * Found by sending forty events against a burst of ten and watching all forty
 * fail to arrive, which is why this floor exists rather than a comment warning
 * somebody not to do that.
 */
export const MIN_BURST_EVENTS = MAX_EVENTS_PER_BATCH;

/** How long an untouched bucket is kept before being forgotten. */
const IDLE_EVICTION_MS = 60 * 60 * 1000;

interface Bucket {
  /** Events' worth of allowance left, fractional between refills. */
  tokens: number;
  lastRefill: number;
  lastSeen: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Whole seconds until the request could succeed. Only meaningful when refused. */
  retryAfterSeconds: number;
}

export class IngestRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  private readonly eventsPerSecond: number;
  private readonly burst: number;
  private readonly now: () => number;

  // Fields declared and assigned rather than written as constructor parameter
  // properties. Node runs this file by stripping types, which cannot do
  // anything that emits code, and a parameter property does. It typechecks and
  // it passes under a test runner that transpiles properly; it simply refuses
  // to start the actual server.
  constructor(
    eventsPerSecond: number = DEFAULT_EVENTS_PER_SECOND,
    burst: number = DEFAULT_BURST_EVENTS,
    /** Injected so tests can move time without waiting for it. */
    now: () => number = Date.now,
  ) {
    this.eventsPerSecond = eventsPerSecond;
    this.burst = burst;
    this.now = now;
  }

  /**
   * Charges a batch against a server's allowance.
   *
   * An empty batch still costs one, because a request that does nothing is
   * still a request somebody has to answer.
   */
  charge(serverId: string, events: number): RateLimitVerdict {
    const bucket = this.refill(serverId);
    const cost = Math.max(1, events);

    if (bucket.tokens < cost) {
      return {
        allowed: false,
        // Rounded up, and never below a second: a Retry-After of zero invites
        // an immediate retry that would be refused again.
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((cost - bucket.tokens) / this.eventsPerSecond),
        ),
      };
    }

    bucket.tokens -= cost;

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Forgets buckets nobody has touched, so a long-lived process does not accumulate them. */
  evictIdle(): void {
    const cutoff = this.now() - IDLE_EVICTION_MS;

    for (const [serverId, bucket] of this.buckets) {
      if (bucket.lastSeen < cutoff) this.buckets.delete(serverId);
    }
  }

  /** Only for tests: the number of buckets being tracked. */
  get size(): number {
    return this.buckets.size;
  }

  private refill(serverId: string): Bucket {
    const at = this.now();
    const existing = this.buckets.get(serverId);

    if (existing === undefined) {
      // A server we have not seen starts full, which is what makes the first
      // batch after a deployment go through.
      const created: Bucket = { tokens: this.burst, lastRefill: at, lastSeen: at };
      this.buckets.set(serverId, created);

      return created;
    }

    const elapsedSeconds = Math.max(0, at - existing.lastRefill) / 1000;

    existing.tokens = Math.min(this.burst, existing.tokens + elapsedSeconds * this.eventsPerSecond);
    existing.lastRefill = at;
    existing.lastSeen = at;

    return existing;
  }
}

/**
 * The limiter the running API uses.
 *
 * One per process, created from the environment. A value that makes no sense
 * is refused out loud rather than clamped, for the same reason retention is:
 * somebody who typed it meant something, and a silent correction leaves them
 * believing a limit that is not there.
 */
export const ingestRateLimiter = new IngestRateLimiter(
  readPositive('MCPSPAN_INGEST_EVENTS_PER_SECOND', DEFAULT_EVENTS_PER_SECOND),
  readPositive('MCPSPAN_INGEST_BURST_EVENTS', DEFAULT_BURST_EVENTS, MIN_BURST_EVENTS),
);

function readPositive(variable: string, fallback: number, minimum = 0): number {
  const raw = process.env[variable]?.trim();

  if (raw === undefined || raw.length === 0) return fallback;

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    console.error(
      `mcpspan core-api ignoring ${variable}=${raw}, which is not a positive number. Keeping ${fallback}.`,
    );

    return fallback;
  }

  if (value < minimum) {
    console.error(
      `mcpspan core-api ignoring ${variable}=${value}: a burst below ${minimum} is smaller than the largest batch this API accepts, so such a batch could never be delivered however long its sender waited. Keeping ${fallback}.`,
    );

    return fallback;
  }

  return value;
}
