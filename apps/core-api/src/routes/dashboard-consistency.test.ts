import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, createApiKey, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

/**
 * Every dashboard route, checked together.
 *
 * The frontend treats these interchangeably: one range picker, one server,
 * a request to each. Testing them as a set is what stops the next one from
 * arriving with its own spelling of the same question, which is the kind of
 * drift that is obvious in a diff and invisible afterwards. A new route joins
 * the list below, and every rule here applies to it at once.
 */
const ROUTES = [
  'summary',
  'timeseries',
  'tools',
  'errors',
  'unknown-tools',
  'sessions',
  'transitions',
  'latency',
  'clients',
  'resources-and-prompts',
  'calls',
  'versions',
] as const;

let server: TestAccount;

async function get(path: string, token: string | null = server.cookie): Promise<Response> {
  return createApp().request(path, {
    headers: token === null ? {} : { cookie: token },
  });
}

beforeEach(async () => {
  await resetDatabase();
  server = await createAccount();
  await seedEvents(server.serverId, [
    { occurredAt: new Date(Date.now() - 10 * 60 * 1000) },
    { occurredAt: new Date(Date.now() - 5 * 60 * 1000), success: false, errorSource: 'exception' },
  ]);
});

afterAll(async () => {
  await closePool();
});

/**
 * Asks every route the same question and returns the answers by route.
 *
 * One setup for all of them rather than one each: the behaviour under test is
 * shared code, and what is being checked is that every route is wired to it.
 * Answers come back keyed by route, so a failure still names the one that
 * broke.
 */
async function askEvery(
  query: string,
  token: string | null = server.cookie,
): Promise<Record<string, { status: number; body: unknown }>> {
  const answers = await Promise.all(
    ROUTES.map(async (route) => {
      const response = await get(`/v1/dashboard/${route}${query}`, token);
      return [route, { status: response.status, body: await response.json() }] as const;
    }),
  );

  return Object.fromEntries(answers);
}

function statuses(answers: Record<string, { status: number }>): Record<string, number> {
  return Object.fromEntries(Object.entries(answers).map(([route, answer]) => [route, answer.status]));
}

function everyRoute<T>(value: T): Record<string, T> {
  return Object.fromEntries(ROUTES.map((route) => [route, value]));
}

describe('every dashboard route', () => {
  it('answers without any parameters at all', async () => {
    expect(statuses(await askEvery(''))).toEqual(everyRoute(200));
  });

  it('accepts serverId, from and to under those names', async () => {
    const query = `?serverId=${server.serverId}&from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z`;

    expect(statuses(await askEvery(query))).toEqual(everyRoute(200));
  });

  it('reports back the window it used', async () => {
    const answers = await askEvery('');
    const ranges = Object.fromEntries(
      Object.entries(answers).map(([route, answer]) => [
        route,
        (answer.body as { range?: unknown }).range,
      ]),
    );

    expect(ranges).toEqual(
      everyRoute({
        from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
  });

  it('refuses without a session, with an error object', async () => {
    const answers = await askEvery('', null);

    expect(answers).toEqual(everyRoute({ status: 401, body: { error: expect.any(String) } }));
  });

  it('is not opened by an API key', async () => {
    expect(statuses(await askEvery('', server.key))).toEqual(everyRoute(401));
  });

  it('refuses a server out of reach, with an error object', async () => {
    const answers = await askEvery('?serverId=00000000-0000-0000-0000-000000000000');

    expect(answers).toEqual(everyRoute({ status: 403, body: { error: expect.any(String) } }));
  });

  it.each([
    ['from is not a date', '?from=yesterday'],
    ['to is not a date', '?to=soon'],
    ['the window runs backwards', '?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z'],
  ])('refuses when %s, with an error object', async (_label, query) => {
    const answers = await askEvery(query);

    expect(answers).toEqual(everyRoute({ status: 400, body: { error: expect.any(String) } }));
  });
});

describe('another server on the same installation', () => {
  it('changes nothing any route shows for this one', async () => {
    const query = `?serverId=${server.serverId}&from=${new Date(Date.now() - 3600_000).toISOString()}&to=${new Date().toISOString()}`;
    const before = await askEvery(query);

    // Every kind of call, failed and refused ones too, in a session of its own.
    const theirs = await createApiKey();
    const at = new Date(Date.now() - 7 * 60 * 1000);
    const sessionId = '5b1a3f0e-6a1c-4c7e-9a52-0d7f3c2e8b41';
    await seedEvents(theirs.serverId, [
      { toolName: 'their_tool', occurredAt: at, clientType: 'cursor', clientName: 'their-client', sessionId },
      { toolName: 'their_tool', occurredAt: at, success: false, errorSource: 'exception', sessionId },
      { toolName: 'their_missing', occurredAt: at, success: false, errorSource: 'unknown_tool', sessionId },
      { kind: 'resource', toolName: 'theirs://{id}', occurredAt: at, sessionId },
      { kind: 'prompt', toolName: 'their_prompt', occurredAt: at, success: false, errorSource: 'unknown_prompt', sessionId },
    ]);

    expect(await askEvery(query)).toEqual(before);
  });
});

describe('the routes agreeing with each other', () => {
  it('give the same answer to the same bad question', async () => {
    const responses = await Promise.all(
      ROUTES.map((route) => get(`/v1/dashboard/${route}?from=nonsense`)),
    );

    const shapes = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        keys: Object.keys((await response.json()) as object),
      })),
    );

    expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(1);
  });

  it('agree on how many calls failed', async () => {
    const summary = (await (await get('/v1/dashboard/summary')).json()) as {
      totalCalls: number;
      failedCalls: number;
    };
    const tools = (await (await get('/v1/dashboard/tools')).json()) as {
      tools: { calls: number; errors: number }[];
    };
    const errors = (await (await get('/v1/dashboard/errors')).json()) as { failures: unknown[] };
    const timeseries = (await (await get('/v1/dashboard/timeseries')).json()) as {
      points: { calls: number; errors: number }[];
    };

    const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

    // Four views of one window. A developer comparing a card against a chart
    // against a table has every right to expect the same number, and nothing
    // erodes trust in a dashboard faster than finding out they do not match.
    expect(sum(tools.tools.map((tool) => tool.calls))).toBe(summary.totalCalls);
    expect(sum(timeseries.points.map((point) => point.calls))).toBe(summary.totalCalls);
    expect(sum(tools.tools.map((tool) => tool.errors))).toBe(summary.failedCalls);
    expect(sum(timeseries.points.map((point) => point.errors))).toBe(summary.failedCalls);
    expect(errors.failures).toHaveLength(summary.failedCalls);
  });
});
