import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

let server: TestAccount;

async function get(path: string, token: string | null = server.cookie): Promise<Response> {
  return createApp().request(path, {
    headers: token === null ? {} : { cookie: token },
  });
}

async function summary(query = ''): Promise<Record<string, unknown>> {
  const response = await get(`/v1/dashboard/summary${query}`);

  return (await response.json()) as Record<string, unknown>;
}

/** An instant inside the default window, so seeded events are always in range. */
function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

beforeEach(async () => {
  await resetDatabase();
  server = await createAccount();
});

afterAll(async () => {
  await closePool();
});

// What every dashboard route refuses in the same way - no session, an API key
// in place of one, a window that cannot be read, a server out of reach - is
// checked once for all of them in dashboard-consistency.test.ts. This file is
// about what each route answers.

describe('GET /v1/dashboard/summary counting calls', () => {
  it('counts what happened in the window', async () => {
    await seedEvents(server.serverId, [
      { occurredAt: minutesAgo(30) },
      { occurredAt: minutesAgo(20) },
      { occurredAt: minutesAgo(10) },
    ]);

    expect(await summary()).toMatchObject({ totalCalls: 3, failedCalls: 0, errorRate: 0 });
  });

  it('counts failures whichever way they were reported', async () => {
    await seedEvents(server.serverId, [
      { occurredAt: minutesAgo(30) },
      { occurredAt: minutesAgo(20), success: false, errorSource: 'result' },
      { occurredAt: minutesAgo(10), success: false, errorSource: 'exception' },
      { occurredAt: minutesAgo(5) },
    ]);

    expect(await summary()).toMatchObject({ totalCalls: 4, failedCalls: 2, errorRate: 0.5 });
  });

  it('counts the distinct tools that were called', async () => {
    await seedEvents(server.serverId, [
      { toolName: 'search_flights', occurredAt: minutesAgo(30) },
      { toolName: 'search_flights', occurredAt: minutesAgo(20) },
      { toolName: 'book_flight', occurredAt: minutesAgo(10) },
    ]);

    expect(await summary()).toMatchObject({ uniqueTools: 2 });
  });

  it('reports zeroes rather than blanks for a quiet server', async () => {
    expect(await summary()).toMatchObject({
      totalCalls: 0,
      failedCalls: 0,
      errorRate: 0,
      uniqueTools: 0,
      durationMs: { mean: null, p50: null, p95: null },
    });
  });
});

describe('GET /v1/dashboard/summary reporting where calls came from', () => {
  it('ranks the clients that called', async () => {
    await seedEvents(server.serverId, [
      { clientType: 'claude', occurredAt: minutesAgo(30) },
      { clientType: 'claude', occurredAt: minutesAgo(25) },
      { clientType: 'claude', occurredAt: minutesAgo(20) },
      { clientType: 'cursor', occurredAt: minutesAgo(15) },
    ]);

    expect(await summary()).toMatchObject({
      clients: [
        { clientType: 'claude', calls: 3 },
        { clientType: 'cursor', calls: 1 },
      ],
    });
  });

  it('counts clients it does not recognise rather than hiding them', async () => {
    await seedEvents(server.serverId, [
      { clientType: 'other', occurredAt: minutesAgo(20) },
      { clientType: 'unknown', occurredAt: minutesAgo(10) },
    ]);

    // A dashboard reporting forty percent "other" is only useful if it admits
    // to the forty percent.
    expect((await summary())['clients']).toEqual([
      { clientType: 'other', calls: 1 },
      { clientType: 'unknown', calls: 1 },
    ]);
  });

  it('returns an empty list for a quiet server', async () => {
    expect((await summary())['clients']).toEqual([]);
  });

  it('counts only what happened in the window', async () => {
    await seedEvents(server.serverId, [
      { clientType: 'claude', occurredAt: minutesAgo(10) },
      { clientType: 'cursor', occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    ]);

    expect((await summary())['clients']).toEqual([{ clientType: 'claude', calls: 1 }]);
  });
});

describe('GET /v1/dashboard/summary reporting latency', () => {
  it('reports the mean, the median and the ninety-fifth percentile', async () => {
    // Ninety quick calls and ten slow ones: the shape that makes a mean on its
    // own misleading. A typical call took 10 ms and an unlucky one took 1000,
    // while the mean lands at 109, which is a figure no call ever took.
    await seedEvents(server.serverId, [
      ...Array.from({ length: 90 }, () => ({ durationMs: 10, occurredAt: minutesAgo(30) })),
      ...Array.from({ length: 10 }, () => ({ durationMs: 1_000, occurredAt: minutesAgo(30) })),
    ]);

    const { durationMs } = (await summary()) as { durationMs: Record<string, number> };

    // The mean is exact. The percentiles come from a latency histogram, so
    // each lands inside the step containing the true answer rather than on it.
    // This distribution is the hardest case for that: ninety calls at one
    // value and ten at another, with nothing in between for the histogram to
    // learn the shape from. The conclusion a reader draws is the same either
    // way, which is the point of reporting them at all.
    expect(durationMs.p50).toBeGreaterThan(8);
    expect(durationMs.p50).toBeLessThanOrEqual(12);
    expect(durationMs.p95).toBeGreaterThan(600);
    expect(durationMs.p95).toBeLessThanOrEqual(1_000);
    expect(durationMs.mean).toBeCloseTo(109, 0);
  });

  it('shows a percentile above the median when the tail is slow', async () => {
    await seedEvents(server.serverId, [
      ...Array.from({ length: 90 }, () => ({ durationMs: 10, occurredAt: minutesAgo(30) })),
      ...Array.from({ length: 10 }, () => ({ durationMs: 1_000, occurredAt: minutesAgo(30) })),
    ]);

    const { durationMs } = (await summary()) as { durationMs: Record<string, number> };

    // The whole reason for reporting three numbers: on this data the mean
    // alone would say the server is eleven times slower than it usually is,
    // and hide that one call in ten is a hundred times worse than that.
    expect(durationMs.p95).toBeGreaterThan(durationMs.p50 as number);
    expect(durationMs.mean).toBeGreaterThan(durationMs.p50 as number);
  });
});

describe('GET /v1/dashboard/summary and its window', () => {
  it('leaves out what happened before it', async () => {
    await seedEvents(server.serverId, [
      { occurredAt: minutesAgo(10) },
      { occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    ]);

    expect(await summary()).toMatchObject({ totalCalls: 1 });
  });

  it('honours a window it was given', async () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await seedEvents(server.serverId, [{ occurredAt: minutesAgo(10) }, { occurredAt: old }]);

    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    expect(await summary(`?from=${from}`)).toMatchObject({ totalCalls: 2 });
  });

  it('says back what window it used', async () => {
    const from = '2026-09-01T00:00:00.000Z';
    const to = '2026-09-02T00:00:00.000Z';

    expect(await summary(`?from=${from}&to=${to}`)).toMatchObject({ range: { from, to } });
  });

  it('excludes the closing instant, so neighbouring windows do not both claim an event', async () => {
    const boundary = new Date('2026-09-02T00:00:00.000Z');
    await seedEvents(server.serverId, [{ occurredAt: boundary }]);

    const before = await summary('?from=2026-09-01T00:00:00.000Z&to=2026-09-02T00:00:00.000Z');
    const after = await summary('?from=2026-09-02T00:00:00.000Z&to=2026-09-03T00:00:00.000Z');

    expect(before).toMatchObject({ totalCalls: 0 });
    expect(after).toMatchObject({ totalCalls: 1 });
  });
});

describe('GET /v1/dashboard/timeseries', () => {
  const to = '2026-09-18T00:00:00.000Z';
  const from = '2026-09-17T00:00:00.000Z';
  const day = `?from=${from}&to=${to}`;

  async function points(query = day): Promise<{ time: string; calls: number; errors: number }[]> {
    const body = (await (await get(`/v1/dashboard/timeseries${query}`)).json()) as {
      points: { time: string; calls: number; errors: number }[];
    };

    return body.points;
  }

  it('groups calls into the bucket they happened in', async () => {
    await seedEvents(server.serverId, [
      { occurredAt: '2026-09-17T09:10:00.000Z' },
      { occurredAt: '2026-09-17T09:50:00.000Z' },
      { occurredAt: '2026-09-17T11:30:00.000Z' },
    ]);

    const byTime = new Map((await points()).map((point) => [point.time, point.calls]));
    expect(byTime.get('2026-09-17T09:00:00.000Z')).toBe(2);
    expect(byTime.get('2026-09-17T11:00:00.000Z')).toBe(1);
  });

  it('counts failures alongside calls, not instead of them', async () => {
    await seedEvents(server.serverId, [
      { occurredAt: '2026-09-17T09:10:00.000Z' },
      { occurredAt: '2026-09-17T09:20:00.000Z', success: false, errorSource: 'exception' },
    ]);

    const bucket = (await points()).find((point) => point.time === '2026-09-17T09:00:00.000Z');
    expect(bucket).toEqual({ time: '2026-09-17T09:00:00.000Z', calls: 2, errors: 1 });
  });

  it('returns a point for every bucket, including the quiet ones', async () => {
    await seedEvents(server.serverId, [{ occurredAt: '2026-09-17T09:10:00.000Z' }]);

    // Without this a chart draws a straight line across a quiet night, and a
    // server that did nothing looks exactly like one that was busy throughout.
    expect(await points()).toHaveLength(24);
  });

  it('shows zero for a bucket nothing happened in', async () => {
    await seedEvents(server.serverId, [{ occurredAt: '2026-09-17T09:10:00.000Z' }]);

    const quiet = (await points()).find((point) => point.time === '2026-09-17T03:00:00.000Z');
    expect(quiet).toEqual({ time: '2026-09-17T03:00:00.000Z', calls: 0, errors: 0 });
  });

  it('returns points in order, since a chart draws them in the order it gets them', async () => {
    await seedEvents(server.serverId, [
      { occurredAt: '2026-09-17T18:00:00.000Z' },
      { occurredAt: '2026-09-17T02:00:00.000Z' },
    ]);

    const times = (await points()).map((point) => point.time);
    expect(times).toEqual([...times].sort());
  });

  it('says how wide its buckets are, since the caller did not choose', async () => {
    const body = (await (await get(`/v1/dashboard/timeseries${day}`)).json()) as {
      bucketSeconds: number;
    };

    expect(body.bucketSeconds).toBe(3_600);
  });

  it('widens the buckets for a longer window', async () => {
    const body = (await (
      await get('/v1/dashboard/timeseries?from=2026-08-19T00:00:00.000Z&to=2026-09-18T00:00:00.000Z')
    ).json()) as { bucketSeconds: number };

    expect(body.bucketSeconds).toBe(24 * 3_600);
  });
});

describe('GET /v1/dashboard/tools', () => {
  interface Tool {
    toolName: string;
    calls: number;
    errors: number;
    errorRate: number;
    durationMs: { mean: number | null; p50: number | null; p95: number | null };
  }

  async function tools(query = ''): Promise<Tool[]> {
    const body = (await (await get(`/v1/dashboard/tools${query}`)).json()) as { tools: Tool[] };

    return body.tools;
  }

  it('ranks tools by how often they were called', async () => {
    await seedEvents(server.serverId, [
      ...Array.from({ length: 3 }, () => ({ toolName: 'search', occurredAt: minutesAgo(10) })),
      ...Array.from({ length: 5 }, () => ({ toolName: 'book', occurredAt: minutesAgo(10) })),
      { toolName: 'cancel', occurredAt: minutesAgo(10) },
    ]);

    expect((await tools()).map((tool) => tool.toolName)).toEqual(['book', 'search', 'cancel']);
  });

  it('breaks ties by name, so a table does not reshuffle between refreshes', async () => {
    await seedEvents(server.serverId, [
      { toolName: 'zebra', occurredAt: minutesAgo(10) },
      { toolName: 'alpha', occurredAt: minutesAgo(10) },
      { toolName: 'middle', occurredAt: minutesAgo(10) },
    ]);

    expect((await tools()).map((tool) => tool.toolName)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('gives each tool its own error rate', async () => {
    await seedEvents(server.serverId, [
      { toolName: 'healthy', occurredAt: minutesAgo(10) },
      { toolName: 'healthy', occurredAt: minutesAgo(10) },
      { toolName: 'broken', occurredAt: minutesAgo(10), success: false, errorSource: 'exception' },
      { toolName: 'broken', occurredAt: minutesAgo(10) },
    ]);

    const byName = new Map((await tools()).map((tool) => [tool.toolName, tool]));
    expect(byName.get('healthy')).toMatchObject({ calls: 2, errors: 0, errorRate: 0 });
    expect(byName.get('broken')).toMatchObject({ calls: 2, errors: 1, errorRate: 0.5 });
  });

  it('gives each tool its own timings', async () => {
    await seedEvents(server.serverId, [
      { toolName: 'quick', durationMs: 5, occurredAt: minutesAgo(10) },
      { toolName: 'quick', durationMs: 15, occurredAt: minutesAgo(10) },
      { toolName: 'slow', durationMs: 900, occurredAt: minutesAgo(10) },
      { toolName: 'slow', durationMs: 1_100, occurredAt: minutesAgo(10) },
    ]);

    const byName = new Map((await tools()).map((tool) => [tool.toolName, tool]));
    expect(byName.get('quick')?.durationMs.mean).toBe(10);
    expect(byName.get('slow')?.durationMs.mean).toBe(1_000);
  });

  it('shows the one bad tool a healthy overall figure would hide', async () => {
    // Ninety fine calls and ten that all failed in one place: the server looks
    // like ten percent errors, and the table says where every one of them is.
    await seedEvents(server.serverId, [
      ...Array.from({ length: 90 }, () => ({ toolName: 'search', occurredAt: minutesAgo(10) })),
      ...Array.from({ length: 10 }, () => ({
        toolName: 'book',
        success: false,
        errorSource: 'exception',
        occurredAt: minutesAgo(10),
      })),
    ]);

    const byName = new Map((await tools()).map((tool) => [tool.toolName, tool]));
    expect(byName.get('search')?.errorRate).toBe(0);
    expect(byName.get('book')?.errorRate).toBe(1);
  });

  it('returns an empty list for a server nothing has reported for', async () => {
    expect(await tools()).toEqual([]);
  });

  it('counts only what happened in the window', async () => {
    await seedEvents(server.serverId, [
      { toolName: 'search', occurredAt: minutesAgo(10) },
      { toolName: 'search', occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    ]);

    expect((await tools())[0]).toMatchObject({ toolName: 'search', calls: 1 });
  });
});

describe('GET /v1/dashboard/errors', () => {
  interface Failure {
    id: string;
    occurredAt: string;
    toolName: string;
    durationMs: number;
    errorSource: string | null;
    errorType: string | null;
    errorMessage: string | null;
    clientType: string;
    clientName: string | null;
  }

  async function failures(query = ''): Promise<Failure[]> {
    const body = (await (await get(`/v1/dashboard/errors${query}`)).json()) as {
      failures: Failure[];
    };

    return body.failures;
  }

  it('returns only the calls that failed', async () => {
    await seedEvents(server.serverId, [
      { toolName: 'fine', occurredAt: minutesAgo(10) },
      { toolName: 'broken', occurredAt: minutesAgo(9), success: false, errorSource: 'exception' },
    ]);

    expect((await failures()).map((failure) => failure.toolName)).toEqual(['broken']);
  });

  it('puts the newest first, since that is the one being chased', async () => {
    await seedEvents(server.serverId, [
      { toolName: 'oldest', occurredAt: minutesAgo(30), success: false },
      { toolName: 'newest', occurredAt: minutesAgo(1), success: false },
      { toolName: 'middle', occurredAt: minutesAgo(15), success: false },
    ]);

    expect((await failures()).map((failure) => failure.toolName)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
  });

  it('carries the detail somebody opened this view for', async () => {
    await seedEvents(server.serverId, [
      {
        toolName: 'book_flight',
        durationMs: 250,
        success: false,
        errorSource: 'exception',
        errorType: 'TypeError',
        errorMessage: 'bad input',
        clientType: 'cursor',
        clientName: 'cursor-vscode',
        occurredAt: minutesAgo(5),
      },
    ]);

    expect((await failures())[0]).toMatchObject({
      toolName: 'book_flight',
      durationMs: 250,
      errorSource: 'exception',
      errorType: 'TypeError',
      errorMessage: 'bad input',
      clientType: 'cursor',
      clientName: 'cursor-vscode',
    });
  });

  it('includes failures a tool reported rather than threw', async () => {
    await seedEvents(server.serverId, [
      {
        toolName: 'search',
        success: false,
        errorSource: 'result',
        errorMessage: 'No flights found',
        occurredAt: minutesAgo(5),
      },
    ]);

    expect((await failures())[0]).toMatchObject({
      errorSource: 'result',
      errorType: null,
      errorMessage: 'No flights found',
    });
  });

  it('returns nothing for a server that has not failed', async () => {
    await seedEvents(server.serverId, [{ occurredAt: minutesAgo(10) }]);

    expect(await failures()).toEqual([]);
  });

  it('stops at fifty by default', async () => {
    await seedEvents(
      server.serverId,
      Array.from({ length: 60 }, (_, i) => ({
        success: false,
        occurredAt: minutesAgo(60 - i),
      })),
    );

    expect(await failures()).toHaveLength(50);
  });

  it('honours a smaller limit', async () => {
    await seedEvents(
      server.serverId,
      Array.from({ length: 10 }, (_, i) => ({ success: false, occurredAt: minutesAgo(10 - i) })),
    );

    expect(await failures('?limit=3')).toHaveLength(3);
  });

  it('orders consistently when failures share an instant', async () => {
    const sameMoment = minutesAgo(5);
    await seedEvents(
      server.serverId,
      Array.from({ length: 5 }, () => ({ success: false, occurredAt: sameMoment })),
    );

    // Batched telemetry makes shared timestamps common. Two identical queries
    // answering in different orders would make a list jump around.
    const first = (await failures()).map((failure) => failure.id);
    const second = (await failures()).map((failure) => failure.id);
    expect(first).toEqual(second);
  });

  it.each([
    ['not a number', '?limit=lots'],
    ['zero', '?limit=0'],
    ['negative', '?limit=-5'],
    ['above the ceiling', '?limit=5000'],
  ])('refuses a limit that is %s', async (_label, query) => {
    // Quietly capping instead would show two hundred rows to somebody who
    // asked for a thousand, and look like a server with two hundred failures.
    expect((await get(`/v1/dashboard/errors${query}`)).status).toBe(400);
  });
});
