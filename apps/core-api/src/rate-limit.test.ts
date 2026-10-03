import { describe, expect, it } from 'vitest';

import { MAX_EVENTS_PER_BATCH } from './limits.ts';
import { IngestRateLimiter, MIN_BURST_EVENTS } from './rate-limit.ts';

/** A limiter whose clock the test moves, so nothing here waits for real time. */
function limiter(eventsPerSecond = 10, burst = 100) {
  let now = 1_000_000;

  return {
    limiter: new IngestRateLimiter(eventsPerSecond, burst, () => now),
    advance(seconds: number) {
      now += seconds * 1000;
    },
  };
}

const SERVER = 'server-a';

describe('IngestRateLimiter', () => {
  it('lets a server through the first time it is ever seen', () => {
    // A bucket that started empty would refuse the first batch after every
    // deployment, which is the one moment somebody is watching.
    const { limiter: rate } = limiter();

    expect(rate.charge(SERVER, 50).allowed).toBe(true);
  });

  it('allows a burst up to the bucket size', () => {
    const { limiter: rate } = limiter(10, 100);

    expect(rate.charge(SERVER, 100).allowed).toBe(true);
  });

  it('refuses what goes past it', () => {
    const { limiter: rate } = limiter(10, 100);

    rate.charge(SERVER, 100);

    expect(rate.charge(SERVER, 1).allowed).toBe(false);
  });

  it('charges by the event, not by the request', () => {
    // The whole point. One request can carry a thousand events, so counting
    // requests would permit a thousand times the traffic the limit names.
    const { limiter: rate } = limiter(10, 100);

    for (let i = 0; i < 10; i++) rate.charge(SERVER, 10);

    expect(rate.charge(SERVER, 1).allowed).toBe(false);
  });

  it('charges an empty batch as one, because answering it still costs something', () => {
    const { limiter: rate } = limiter(10, 3);

    expect(rate.charge(SERVER, 0).allowed).toBe(true);
    expect(rate.charge(SERVER, 0).allowed).toBe(true);
    expect(rate.charge(SERVER, 0).allowed).toBe(true);
    expect(rate.charge(SERVER, 0).allowed).toBe(false);
  });

  it('refills over time at the rate it was given', () => {
    const { limiter: rate, advance } = limiter(10, 100);

    rate.charge(SERVER, 100);
    advance(5);

    expect(rate.charge(SERVER, 50).allowed).toBe(true);
  });

  it('does not refill past the burst it is allowed', () => {
    // Otherwise an idle server would accumulate an unbounded allowance and
    // arrive able to write as much as it liked.
    const { limiter: rate, advance } = limiter(10, 100);

    advance(3600);

    expect(rate.charge(SERVER, 101).allowed).toBe(false);
    expect(rate.charge(SERVER, 100).allowed).toBe(true);
  });

  it('says how long to wait, and never says zero', () => {
    const { limiter: rate } = limiter(10, 100);

    rate.charge(SERVER, 100);
    const verdict = rate.charge(SERVER, 20);

    expect(verdict.allowed).toBe(false);
    // Twenty events at ten a second is two seconds. A zero here would invite
    // an immediate retry that would be refused again.
    expect(verdict.retryAfterSeconds).toBe(2);
  });

  it('waiting as long as it said is enough', () => {
    const { limiter: rate, advance } = limiter(10, 100);

    rate.charge(SERVER, 100);
    const refused = rate.charge(SERVER, 20);

    advance(refused.retryAfterSeconds);

    expect(rate.charge(SERVER, 20).allowed).toBe(true);
  });

  it('keeps servers apart', () => {
    const { limiter: rate } = limiter(10, 100);

    rate.charge(SERVER, 100);

    // One noisy server must not silence everybody else's.
    expect(rate.charge('server-b', 100).allowed).toBe(true);
  });

  it('forgets servers that stopped reporting', () => {
    const { limiter: rate, advance } = limiter(10, 100);

    rate.charge(SERVER, 1);
    expect(rate.size).toBe(1);

    advance(2 * 60 * 60);
    rate.evictIdle();

    expect(rate.size).toBe(0);
  });

  it('keeps servers that are still reporting', () => {
    const { limiter: rate, advance } = limiter(10, 100);

    rate.charge(SERVER, 1);
    advance(2 * 60 * 60);
    rate.charge(SERVER, 1);
    rate.evictIdle();

    expect(rate.size).toBe(1);
  });

  it('can always eventually pay for the largest batch the API accepts', () => {
    // The flaw this floor exists for. A bucket never holds more than its
    // burst, so a batch larger than the burst can never be paid for however
    // long anybody waits. The SDK retries a 429 forever, its queue fills, and
    // the events never arrive with nothing reporting an error. Found by
    // sending forty events against a burst of ten and watching all forty
    // vanish.
    const { limiter: rate, advance } = limiter(1, MIN_BURST_EVENTS);

    rate.charge(SERVER, MIN_BURST_EVENTS);
    expect(rate.charge(SERVER, MAX_EVENTS_PER_BATCH).allowed).toBe(false);

    // However long it takes, waiting is enough. That is the whole property.
    advance(MIN_BURST_EVENTS);

    expect(rate.charge(SERVER, MAX_EVENTS_PER_BATCH).allowed).toBe(true);
  });

  it('lets a recovering server deliver a full backlog in one go', () => {
    // What this bucket size is for. The SDK holds up to ten thousand events
    // while it cannot reach us and delivers them as fast as it can once it
    // can. Metering that would meet a recovering server with refusals for
    // minutes, for traffic it already earned the right to send.
    const { limiter: rate } = limiter(100, 20_000);

    for (let batch = 0; batch < 100; batch++) {
      expect(rate.charge(SERVER, 100).allowed).toBe(true);
    }
  });
});
