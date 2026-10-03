import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

let server: TestAccount;

async function get(path: string): Promise<Response> {
  return createApp().request(path, { headers: { cookie: server.cookie } });
}

async function body<T>(path: string): Promise<T> {
  return (await (await get(path)).json()) as T;
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

beforeEach(async () => {
  await resetDatabase();
  server = await createAccount();

  await seedEvents(server.serverId, [
    { toolName: 'search', clientType: 'claude', durationMs: 10, occurredAt: minutesAgo(50) },
    { toolName: 'search', clientType: 'claude', durationMs: 20, occurredAt: minutesAgo(40) },
    { toolName: 'search', clientType: 'cursor', durationMs: 30, occurredAt: minutesAgo(30) },
    {
      toolName: 'book',
      clientType: 'claude',
      durationMs: 900,
      success: false,
      errorSource: 'exception',
      errorType: 'TypeError',
      occurredAt: minutesAgo(20),
    },
    {
      toolName: 'book',
      clientType: 'cursor',
      durationMs: 800,
      success: false,
      errorSource: 'result',
      errorMessage: 'No seats',
      occurredAt: minutesAgo(10),
    },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('filtering by tool', () => {
  it('narrows the summary', async () => {
    const summary = await body<{ totalCalls: number; failedCalls: number }>(
      '/v1/dashboard/summary?toolName=book',
    );

    expect(summary).toMatchObject({ totalCalls: 2, failedCalls: 2 });
  });

  it('narrows the chart', async () => {
    const { points } = await body<{ points: { calls: number }[] }>(
      '/v1/dashboard/timeseries?toolName=search',
    );

    expect(points.reduce((total, point) => total + point.calls, 0)).toBe(3);
  });

  it('narrows the ranking to that tool alone', async () => {
    const { tools } = await body<{ tools: { toolName: string }[] }>(
      '/v1/dashboard/tools?toolName=book',
    );

    expect(tools.map((tool) => tool.toolName)).toEqual(['book']);
  });

  it('narrows the failure list', async () => {
    const { failures } = await body<{ failures: { toolName: string }[] }>(
      '/v1/dashboard/errors?toolName=book',
    );

    expect(failures).toHaveLength(2);
  });

  it('answers emptily for a tool that was never called', async () => {
    // A reasonable question with a boring answer, not an error.
    const summary = await body<{ totalCalls: number }>('/v1/dashboard/summary?toolName=nonexistent');

    expect(summary.totalCalls).toBe(0);
  });
});

describe('filtering by client', () => {
  it('narrows the summary', async () => {
    expect(
      await body<{ totalCalls: number }>('/v1/dashboard/summary?clientType=cursor'),
    ).toMatchObject({ totalCalls: 2 });
  });

  it('narrows the ranking', async () => {
    const { tools } = await body<{ tools: { toolName: string; calls: number }[] }>(
      '/v1/dashboard/tools?clientType=claude',
    );

    expect(tools).toEqual([
      expect.objectContaining({ toolName: 'search', calls: 2 }),
      expect.objectContaining({ toolName: 'book', calls: 1 }),
    ]);
  });

  it('combines with a tool filter rather than replacing it', async () => {
    expect(
      await body<{ totalCalls: number }>('/v1/dashboard/summary?toolName=search&clientType=cursor'),
    ).toMatchObject({ totalCalls: 1 });
  });
});

describe('filtering failures by how they failed', () => {
  it('shows only the handlers that threw', async () => {
    const { failures } = await body<{ failures: { errorSource: string }[] }>(
      '/v1/dashboard/errors?errorSource=exception',
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.errorSource).toBe('exception');
  });

  it('shows only the failures a tool reported', async () => {
    const { failures } = await body<{ failures: { errorMessage: string }[] }>(
      '/v1/dashboard/errors?errorSource=result',
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.errorMessage).toBe('No seats');
  });
});

describe('sorting the tool ranking', () => {
  it('leads with the busiest by default', async () => {
    const { tools, sort } = await body<{ tools: { toolName: string }[]; sort: string }>(
      '/v1/dashboard/tools',
    );

    expect(sort).toBe('calls');
    expect(tools[0]?.toolName).toBe('search');
  });

  it('leads with the worst error rate when asked', async () => {
    const { tools } = await body<{ tools: { toolName: string }[] }>(
      '/v1/dashboard/tools?sort=errors',
    );

    expect(tools[0]?.toolName).toBe('book');
  });

  it('sorts by rate rather than count, so a quiet broken tool still surfaces', async () => {
    // `search` has three calls and no failures; `book` has two and both fail.
    // By raw count of errors they are close, by rate they are not.
    const { tools } = await body<{ tools: { toolName: string; errorRate: number }[] }>(
      '/v1/dashboard/tools?sort=errors',
    );

    expect(tools[0]?.errorRate).toBe(1);
  });

  it('leads with the slowest when asked', async () => {
    const { tools } = await body<{ tools: { toolName: string }[] }>(
      '/v1/dashboard/tools?sort=duration',
    );

    expect(tools[0]?.toolName).toBe('book');
  });

  it('sorts by name when asked', async () => {
    const { tools } = await body<{ tools: { toolName: string }[] }>(
      '/v1/dashboard/tools?sort=name',
    );

    expect(tools.map((tool) => tool.toolName)).toEqual(['book', 'search']);
  });

  it('refuses a sort it does not have', async () => {
    // Refused rather than silently falling back, because a table quietly
    // ordered by something else than the header says is worse than an error.
    expect((await get('/v1/dashboard/tools?sort=popularity')).status).toBe(400);
  });
});

describe('filters that cannot be used', () => {
  it('refuses a value long enough to be an attack', async () => {
    expect((await get(`/v1/dashboard/summary?toolName=${'x'.repeat(500)}`)).status).toBe(400);
  });

  it('ignores an empty filter rather than matching nothing', async () => {
    expect(await body<{ totalCalls: number }>('/v1/dashboard/summary?toolName=')).toMatchObject({
      totalCalls: 5,
    });
  });

  it('treats a tool name with a quote in it as a name, not as SQL', async () => {
    const response = await get("/v1/dashboard/summary?toolName=' OR 1=1 --");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalCalls: 0 });
  });
});
