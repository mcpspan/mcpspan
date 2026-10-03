import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeBackoffMs,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_BATCH_SIZE,
  EventReporter,
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  type ReporterOptions,
} from './reporter.js';
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from './transport.js';
import type { ToolCallEvent } from './types.js';

const options: ReporterOptions = {
  endpoint: 'https://ingest.example.com',
  apiKey: 'test-key',
};

let counter = 0;

function makeEvent(): ToolCallEvent {
  counter += 1;
  return {
    id: `event-${counter}`,
    toolName: 'search_flights',
    durationMs: 42,
    success: true,
    clientType: 'claude',
    timestamp: '2026-09-17T12:00:00.000Z',
    sdkVersion: '0.0.0',
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function sentBatches(): ToolCallEvent[][] {
  return fetchMock.mock.calls.map(
    (call) => (JSON.parse((call[1] as RequestInit).body as string) as { events: ToolCallEvent[] }).events,
  );
}

beforeEach(() => {
  counter = 0;
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('EventReporter', () => {
  it('queues an event without sending it straight away', () => {
    const reporter = new EventReporter(options);

    reporter.record(makeEvent());

    expect(reporter.queueSize).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns from record before delivery happens', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const reporter = new EventReporter({ ...options, maxBatchSize: 1 });

    // If record awaited delivery, this line could not run while fetch is
    // still pending.
    reporter.record(makeEvent());
    const recordReturned = true;

    expect(recordReturned).toBe(true);
    resolveFetch(new Response(null, { status: 202 }));
    await reporter.flush();
  });

  it('delivers everything queued on flush', async () => {
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());
    reporter.record(makeEvent());

    await reporter.flush();

    expect(sentBatches()).toHaveLength(1);
    expect(sentBatches()[0]).toHaveLength(2);
    expect(reporter.queueSize).toBe(0);
  });

  it('flushes as soon as a full batch has accumulated', async () => {
    const reporter = new EventReporter({ ...options, maxBatchSize: 2 });

    reporter.record(makeEvent());
    expect(fetchMock).not.toHaveBeenCalled();

    reporter.record(makeEvent());
    await reporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('flushes a partly filled batch once the interval elapses', async () => {
    vi.useFakeTimers();
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_FLUSH_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('splits a backlog into batches instead of one oversized request', async () => {
    const reporter = new EventReporter({ ...options, maxBatchSize: 2 });

    for (let i = 0; i < 5; i += 1) reporter.record(makeEvent());
    await reporter.flush();

    expect(sentBatches().map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it('does not start a second flush while one is running', async () => {
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());

    const [first, second] = [reporter.flush(), reporter.flush()];
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on the remaining batches once one fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const reporter = new EventReporter({ ...options, maxBatchSize: 1 });

    for (let i = 0; i < 4; i += 1) reporter.record(makeEvent());
    await reporter.flush();

    // Hammering an endpoint that just failed wastes the developer's bandwidth
    // on something that is not going to work this second.
    expect(fetchMock.mock.calls.length).toBeLessThan(4);
  });

  it('never lets a delivery failure escape', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());

    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  it('sends what is left when stopped', async () => {
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());

    await reporter.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reporter.queueSize).toBe(0);
  });

  it('ignores events recorded after being stopped', async () => {
    const reporter = new EventReporter(options);
    await reporter.stop();

    reporter.record(makeEvent());

    expect(reporter.queueSize).toBe(0);
  });

  it('stops the interval so the process can exit', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());

    await reporter.stop();

    expect(clearSpy).toHaveBeenCalled();
  });

  it('keeps its timer from holding the process open', () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as unknown as ReturnType<
      typeof setInterval
    >);

    new EventReporter(options).record(makeEvent());

    expect(unref).toHaveBeenCalled();
  });

  it('defaults to a bounded batch size', () => {
    expect(DEFAULT_MAX_BATCH_SIZE).toBe(100);
  });
});

describe('computeBackoffMs', () => {
  it('doubles the window with each consecutive failure', () => {
    const highest = (failures: number) => computeBackoffMs(failures, () => 1);

    expect(highest(1)).toBe(INITIAL_RETRY_DELAY_MS);
    expect(highest(2)).toBe(INITIAL_RETRY_DELAY_MS * 2);
    expect(highest(3)).toBe(INITIAL_RETRY_DELAY_MS * 4);
  });

  it('stops growing at the ceiling', () => {
    expect(computeBackoffMs(50, () => 1)).toBe(MAX_RETRY_DELAY_MS);
  });

  it('never waits less than half the window, so a retry is always a pause', () => {
    expect(computeBackoffMs(1, () => 0)).toBe(INITIAL_RETRY_DELAY_MS / 2);
  });

  it('spreads attempts across the window', () => {
    const delays = new Set(Array.from({ length: 50 }, () => computeBackoffMs(5)));

    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('EventReporter recovering from failures', () => {
  it('puts a retryable batch back in the queue instead of losing it', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());
    reporter.record(makeEvent());

    await reporter.flush();

    expect(reporter.queueSize).toBe(2);
  });

  it('delivers the restored events once the endpoint recovers', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());
    await reporter.flush();

    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await reporter.stop();

    expect(reporter.queueSize).toBe(0);
    expect(sentBatches().at(-1)).toHaveLength(1);
  });

  it('keeps the original order when a batch is restored', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const reporter = new EventReporter({ ...options, maxBatchSize: 1 });
    reporter.record(makeEvent());
    await reporter.flush();
    reporter.record(makeEvent());

    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await reporter.stop();

    const delivered = sentBatches().slice(1).flat();
    expect(delivered.map((event) => event.id)).toEqual(['event-1', 'event-2']);
  });

  it('discards a batch the server called malformed', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());

    await reporter.flush();

    expect(reporter.queueSize).toBe(0);
  });

  it('waits before trying again after a failure', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());
    await reporter.flush();

    await reporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tries again once the delay has passed', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());
    await reporter.flush();

    vi.advanceTimersByTime(MAX_RETRY_DELAY_MS);
    await reporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores the delay when stopping, since it is the last chance', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());
    await reporter.flush();

    await reporter.stop();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('EventReporter told to wait', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits at least as long as Retry-After asks, beyond its own backoff', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
    );
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());
    await reporter.flush();

    // Past the SDK's own first backoff, well short of what the server asked.
    vi.advanceTimersByTime(5_000);
    await reporter.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(26_000);
    await reporter.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');

  it('reads whole seconds', () => {
    expect(parseRetryAfter('12', now)).toBe(12_000);
  });

  it('reads a date', () => {
    expect(parseRetryAfter('Sat, 26 Sep 2026 10:00:20 GMT', now)).toBe(20_000);
  });

  it('ignores what it cannot read, and a date already past counts as now', () => {
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('Sat, 26 Sep 2026 09:00:00 GMT', now)).toBe(0);
  });

  it('does not follow a server that asks for a day', () => {
    expect(parseRetryAfter('86400', now)).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe('EventReporter with a refused API key', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('gives up rather than buffering events that can never be delivered', async () => {
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());

    await reporter.flush();
    reporter.record(makeEvent());

    expect(reporter.queueSize).toBe(0);
  });

  it('stops contacting the endpoint', async () => {
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());
    await reporter.flush();

    reporter.record(makeEvent());
    await reporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a forbidden key the same as a rejected one', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());
    await reporter.flush();

    reporter.record(makeEvent());
    await reporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected the API key'));
  });

  it('says so on stderr even when debug is off', async () => {
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());

    await reporter.flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected the API key'));
  });
});

describe('EventReporter logging', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('stays quiet about an unreachable endpoint by default', async () => {
    const reporter = new EventReporter(options);
    reporter.record(makeEvent());

    await reporter.flush();

    expect(warn).not.toHaveBeenCalled();
  });

  it('explains itself when debug is on', async () => {
    const reporter = new EventReporter({ ...options, debug: true });
    reporter.record(makeEvent());

    await reporter.flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('delivery failed'));
  });

  it('says when the queue had to throw events away', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    const reporter = new EventReporter({ ...options, maxQueueSize: 1, maxBatchSize: 10, debug: true });

    reporter.record(makeEvent());
    reporter.record(makeEvent());
    await reporter.flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('discarded 1 events'));
  });

  it('does not repeat a discard it already reported', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    const reporter = new EventReporter({ ...options, maxQueueSize: 1, maxBatchSize: 10, debug: true });
    reporter.record(makeEvent());
    reporter.record(makeEvent());
    await reporter.flush();

    reporter.record(makeEvent());
    await reporter.flush();

    const discards = warn.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('discarded'),
    );
    expect(discards).toHaveLength(1);
  });

  it('writes diagnostics to stderr, never stdout', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reporter = new EventReporter({ ...options, debug: true });
    reporter.record(makeEvent());

    await reporter.flush();

    // On a stdio transport stdout carries the MCP protocol itself.
    expect(stdout).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    stdout.mockRestore();
  });
});
