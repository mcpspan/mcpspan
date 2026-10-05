import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApiError,
  getAlerts,
  getClients,
  getDiagnostics,
  getFailures,
  getLatency,
  getResourcesAndPrompts,
  getSessionCalls,
  getSessions,
  getSummary,
  getTimeseries,
  getToolDetails,
  getTools,
  getTransitions,
  getUnknownTools,
  getVersions,
  getCalls,
} from '../../core-dashboard/src/lib/api.ts';
import { createAccount, createApiKey, resetDatabase, seedEvents, type TestAccount } from '../test/fixtures.ts';
import { createApp } from './app.ts';
import { closePool, getPool } from './db.ts';

/**
 * The dashboard's API client against a real Core API.
 *
 * The client writes out the response shapes rather than importing them,
 * because the two are deployed separately and a shared type would promise an
 * agreement that does not exist. This is what keeps that honest: unit tests on
 * either side check what their author imagined, and only a request over a
 * socket checks what the other end actually sends.
 */
let server: ServerType;
let account: TestAccount;

beforeAll(async () => {
  server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: createApp().fetch, port: 0 }, () => resolve(started));
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  process.env['CORE_API_URL'] = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env['CORE_API_URL'];
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount({ serverName: 'Contract server' });

  await seedEvents(account.serverId, [
    { toolName: 'search_flights', durationMs: 20, occurredAt: minutesAgo(30) },
    { toolName: 'search_flights', durationMs: 40, occurredAt: minutesAgo(20) },
    {
      toolName: 'book_flight',
      durationMs: 900,
      success: false,
      errorSource: 'exception',
      errorType: 'TypeError',
      errorMessage: 'bad input',
      clientName: 'Claude Desktop',
      occurredAt: minutesAgo(10),
    },
  ]);
});

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

/**
 * Points the client at a stand-in that answers however a test needs.
 *
 * For the cases where the real API cannot produce the answer under test: it
 * shares this process and this environment, so it cannot be made to disagree
 * with the client about a token it reads from the same variable.
 */
async function serveOnce(handler: () => Response): Promise<{ stop: () => Promise<void> }> {
  const previous = process.env['CORE_API_URL'];
  const stub = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: handler, port: 0 }, () => resolve(started));
  });

  const address = stub.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.env['CORE_API_URL'] = `http://127.0.0.1:${port}`;

  return {
    stop: async () => {
      process.env['CORE_API_URL'] = previous;
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    },
  };
}

describe('an account with several servers', () => {
  it('shows the first server, the one the switcher shows as chosen, when none is named', async () => {
    // A second server, added later: it comes second in the switcher.
    const second = await createApiKey({ userId: account.userId, serverName: 'Second' });
    await seedEvents(second.serverId, [{ toolName: 'theirs', occurredAt: minutesAgo(5) }]);

    expect((await getSummary(account.cookie)).totalCalls).toBe(3);
    expect((await getSummary(account.cookie, { serverId: second.serverId })).totalCalls).toBe(1);
  });
});

describe('getSummary', () => {
  it('parses the headline numbers', async () => {
    const summary = await getSummary(account.cookie);

    expect(summary).toMatchObject({
      totalCalls: 3,
      failedCalls: 1,
      uniqueTools: 2,
      range: { from: expect.any(String), to: expect.any(String) },
    });
    expect(summary.errorRate).toBeCloseTo(1 / 3, 5);
  });

  it('parses the three latency figures', async () => {
    const { durationMs } = await getSummary(account.cookie);

    // The mean is exact: it comes from a sum and a count, both of which
    // survive being rolled up.
    expect(durationMs.mean).toBeCloseTo(320, 0);

    // The percentiles come from a latency histogram rather than a sort of the
    // raw rows, so they land inside the step holding the call at that rank
    // rather than on its exact duration. Three calls of 20, 40 and 900 ms put
    // the median call at 40, which the ladder brackets between 30 and 45.
    // Asserting the exact 40 would be asserting an implementation this step
    // deliberately gave up.
    expect(durationMs.p50).toBeGreaterThanOrEqual(30);
    expect(durationMs.p50).toBeLessThanOrEqual(45);
    expect(typeof durationMs.p95).toBe('number');
  });
});

describe('getTimeseries', () => {
  it('parses the points and the bucket width', async () => {
    const timeseries = await getTimeseries(account.cookie);

    expect(timeseries.bucketSeconds).toBeGreaterThan(0);
    expect(timeseries.points.length).toBeGreaterThan(0);
    expect(timeseries.points[0]).toEqual({
      time: expect.any(String),
      calls: expect.any(Number),
      errors: expect.any(Number),
    });
  });

  it('adds up to what the summary reported', async () => {
    const [{ points }, summary] = await Promise.all([getTimeseries(account.cookie), getSummary(account.cookie)]);

    expect(points.reduce((total, point) => total + point.calls, 0)).toBe(summary.totalCalls);
  });
});

describe('getTools', () => {
  it('parses the ranking', async () => {
    const { tools } = await getTools(account.cookie);

    expect(tools.map((tool) => tool.toolName)).toEqual(['search_flights', 'book_flight']);
    expect(tools[0]).toMatchObject({
      calls: 2,
      errors: 0,
      errorRate: 0,
      // Mean exact, percentiles estimated from the histogram: same trade as
      // the summary above, same reason.
      durationMs: { mean: 30, p50: expect.any(Number), p95: expect.any(Number) },
    });
    // Two calls, 20 and 40 ms. The median call is the 20, which the ladder
    // brackets between 12 and 20.
    expect(tools[0]?.durationMs.p50).toBeGreaterThanOrEqual(12);
    expect(tools[0]?.durationMs.p50).toBeLessThanOrEqual(20);
  });
});

describe('getFailures', () => {
  it('parses the failure detail', async () => {
    const { failures, limit } = await getFailures(account.cookie);

    expect(limit).toBe(50);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      toolName: 'book_flight',
      errorSource: 'exception',
      errorType: 'TypeError',
      errorMessage: 'bad input',
      clientName: 'Claude Desktop',
      durationMs: 900,
    });
  });

  it('passes a limit through', async () => {
    expect((await getFailures(account.cookie, { limit: 5 })).limit).toBe(5);
  });
});

describe('getUnknownTools', () => {
  it('parses the names agents asked for', async () => {
    await seedEvents(account.serverId, [
      { toolName: 'book_hotel', success: false, errorSource: 'unknown_tool', occurredAt: minutesAgo(3) },
    ]);

    const { tools } = await getUnknownTools(account.cookie);

    expect(tools).toEqual([
      { toolName: 'book_hotel', calls: 1, lastCalledAt: expect.any(String), closest: null },
    ]);
  });
});

describe('page information', () => {
  it('comes back on every list that can outgrow a screen', async () => {
    const [tools, failures, unknown, sessions, transitions, clients] = await Promise.all([
      getTools(account.cookie),
      getFailures(account.cookie),
      getUnknownTools(account.cookie),
      getSessions(account.cookie),
      getTransitions(account.cookie),
      getClients(account.cookie),
    ]);

    expect(tools).toMatchObject({ offset: 0, limit: 200, total: 2, hasMore: false });
    expect(failures.nextCursor).toBeNull();
    expect(unknown).toMatchObject({ offset: 0, limit: 50, hasMore: false });
    expect(sessions).toMatchObject({ offset: 0, limit: 50, hasMore: false });
    expect(transitions).toMatchObject({ offset: 0, limit: 30, hasMore: false });
    expect(clients).toMatchObject({ offset: 0, limit: 12, total: 1, hasMore: false });
  });
});

describe('getAlerts', () => {
  it('parses the alert settings', async () => {
    expect(await getAlerts(account.cookie)).toEqual({
      webhook: null,
      rules: [],
      events: [],
      eventsOffset: 0,
      eventsHaveMore: false,
    });

    await getPool().query(`INSERT INTO alert_webhooks (user_id, url) VALUES ($1, $2)`, [
      account.userId,
      'https://hooks.example.com/abc',
    ]);
    const rule = await getPool().query<{ id: string }>(
      `INSERT INTO alert_rules (server_id, kind, threshold, window_minutes, min_calls)
       VALUES ($1, 'error_rate', 0.2, 15, 10) RETURNING id`,
      [account.serverId],
    );
    await getPool().query(
      `INSERT INTO alert_events (rule_id, kind, value) VALUES ($1, 'firing', 0.5)`,
      [rule.rows[0]?.id],
    );

    const alerts = await getAlerts(account.cookie);

    expect(alerts.webhook).toEqual({
      url: 'https://hooks.example.com/abc',
      lastAttemptAt: null,
      lastStatus: null,
      lastError: null,
    });
    expect(alerts.rules).toEqual([
      {
        id: rule.rows[0]?.id,
        serverId: account.serverId,
        serverName: 'Contract server',
        toolNames: null,
        kind: 'error_rate',
        threshold: 0.2,
        windowMinutes: 15,
        minCalls: 10,
        enabled: true,
        notifyResolved: true,
        firing: false,
        firingTools: [],
      },
    ]);
    expect(alerts.events).toEqual([
      {
        id: expect.any(String),
        ruleId: rule.rows[0]?.id,
        serverName: 'Contract server',
        toolName: null,
        ruleKind: 'error_rate',
        kind: 'firing',
        value: 0.5,
        occurredAt: expect.any(String),
        deliveredAt: null,
        error: null,
        notWanted: false,
      },
    ]);
  });
});

describe('getClients', () => {
  it('parses each client over time', async () => {
    const { bucketSeconds, times, clients } = await getClients(account.cookie);

    expect(bucketSeconds).toBeGreaterThan(0);
    expect(clients).toEqual([
      {
        clientType: 'claude',
        calls: 3,
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
        points: expect.any(Array),
      },
    ]);
    expect(clients[0]?.points).toHaveLength(times.length);
  });
});

describe('getLatency', () => {
  it('parses the distribution', async () => {
    const { totalCalls, buckets } = await getLatency(account.cookie);

    expect(totalCalls).toBe(3);
    expect(buckets[0]).toEqual({ fromMs: 0, toMs: 1, calls: 0 });
    expect(buckets.at(-1)).toEqual({ fromMs: 10_000, toMs: null, calls: 0 });
    expect(buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(3);
  });
});

describe('getToolDetails', () => {
  it('parses what the tool page adds', async () => {
    const details = await getToolDetails(account.cookie, { toolName: 'book_flight' });

    expect(details).toEqual({
      range: { from: expect.any(String), to: expect.any(String) },
      toolName: 'book_flight',
      failures: [{ errorSource: 'exception', calls: 1 }],
      messages: [
        { message: 'bad input', errorSource: 'exception', calls: 1, lastAt: expect.any(String) },
      ],
      parameters: [],
      callsWithParameters: 0,
      sampled: false,
      messagesOffset: 0,
      messagesHaveMore: false,
      parametersOffset: 0,
      parametersHaveMore: false,
    });
  });
});

describe('the session views', () => {
  const sessionId = '6f1f1b1e-1c4e-4f7a-9d55-0a7b5b2f9c11';

  beforeEach(async () => {
    await seedEvents(account.serverId, [
      { sessionId, toolName: 'search_flights', occurredAt: minutesAgo(8) },
      { sessionId, toolName: 'book_flight', success: false, errorSource: 'arguments', occurredAt: minutesAgo(7) },
    ]);
  });

  it('parses the session list', async () => {
    const { sessions, sampled } = await getSessions(account.cookie);

    expect(sampled).toBe(false);
    expect(sessions).toEqual([
      {
        sessionId,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        calls: 2,
        failures: 1,
        tools: 2,
        clientType: 'claude',
        clientName: null,
      },
    ]);
  });

  it('parses one session', async () => {
    const { calls } = await getSessionCalls(account.cookie, sessionId);

    expect(calls[1]).toEqual({
      id: expect.any(String),
      occurredAt: expect.any(String),
      kind: 'tool',
      toolName: 'book_flight',
      success: false,
      errorSource: 'arguments',
      errorType: null,
      errorMessage: null,
      durationMs: 10,
      clientType: expect.any(String),
      clientName: expect.toBeOneOf([null, expect.any(String)]),
    });
  });

  it('parses the transitions', async () => {
    const { transitions } = await getTransitions(account.cookie);

    expect(transitions).toContainEqual({
      from: 'search_flights',
      fromKind: 'tool',
      to: 'book_flight',
      toKind: 'tool',
      calls: 1,
      afterFailure: 0,
    });
  });
});

describe('getVersions and versions on calls', () => {
  it('parses the versions and the versions a call carries', async () => {
    await seedEvents(account.serverId, [
      { toolName: 'search_flights', serverVersion: '1.4.0', clientVersion: '2.1.0', occurredAt: minutesAgo(5) },
    ]);

    const { versions, unversionedCalls } = await getVersions(account.cookie);
    expect(versions).toEqual([
      {
        version: '1.4.0',
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
        calls: 1,
        errors: 0,
        errorRate: 0,
        durationMs: { p50: expect.any(Number), p95: expect.any(Number) },
      },
    ]);
    expect(unversionedCalls).toBe(3);

    const { calls } = await getCalls(account.cookie, { serverVersion: '1.4.0' });
    expect(calls[0]).toMatchObject({ serverVersion: '1.4.0', clientVersion: '2.1.0' });
  });
});

describe('getResourcesAndPrompts', () => {
  beforeEach(async () => {
    await resetDatabase();
    account = await createAccount();
    await seedEvents(account.serverId, [
      { kind: 'resource', toolName: 'users://{id}/profile', durationMs: 4 },
      { kind: 'resource', toolName: 'users://{id}/profile', success: false, errorSource: 'exception', errorType: 'Gone' },
      { kind: 'resource', toolName: 'db://', success: false, errorSource: 'unknown_resource' },
      { kind: 'prompt', toolName: 'summarise', durationMs: 2 },
      { kind: 'prompt', toolName: 'translate', success: false, errorSource: 'unknown_prompt' },
    ]);
  });

  it('parses the ranking and what was asked for and not there', async () => {
    const body = await getResourcesAndPrompts(account.cookie);

    expect(body.resources).toEqual([
      {
        name: 'users://{id}/profile',
        calls: 2,
        errors: 1,
        errorRate: 0.5,
        durationMs: { mean: expect.any(Number), p50: expect.any(Number), p95: expect.any(Number) },
      },
    ]);
    expect(body.prompts.map((prompt) => prompt.name)).toEqual(['summarise']);
    expect(body.unknownResources).toEqual([
      { name: 'db://', calls: 1, lastCalledAt: expect.any(String), closest: null },
    ]);
    expect(body.unknownPrompts.map((prompt) => prompt.name)).toEqual(['translate']);
  });
});

describe('getDiagnostics', () => {
  it('parses the state of the installation', async () => {
    const diagnostics = await getDiagnostics(account.cookie);

    expect(diagnostics).toMatchObject({
      versions: { api: expect.any(String), postgres: expect.any(String) },
      storage: { databaseBytes: expect.any(Number), oldestEventAt: expect.any(String) },
      signingSecret: null,
      refusals: [],
    });
    expect(diagnostics.servers).toEqual([
      expect.objectContaining({
        id: account.serverId,
        name: 'Contract server',
        hasActiveKey: true,
        lastEvent: {
          occurredAt: expect.any(String),
          receivedAt: expect.any(String),
          sdkVersion: '0.1.0',
        },
        // Seeded straight into the table, so no SDK ever made contact.
        lastContact: null,
      }),
    ]);
  });
});

describe('the query the client sends', () => {
  it('narrows to a window', async () => {
    const summary = await getSummary(account.cookie, {
      from: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    });

    expect(summary.totalCalls).toBe(1);
  });

  it('names a server', async () => {
    expect((await getSummary(account.cookie, { serverId: account.serverId })).totalCalls).toBe(3);
  });
});

describe('what the client does with a refusal', () => {
  it('reports a session the API does not know as unauthenticated', async () => {
    const error = await getSummary('mcpspan_session=made-up').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isUnauthenticated).toBe(true);
  });

  it('refuses to ask at all without a session', async () => {
    // Sent without one, the answer would be 401 and read as "your session
    // expired" when in fact none was ever passed along.
    const error = (await getSummary(undefined).catch((caught: unknown) => caught)) as ApiError;

    expect(error.status).toBe(401);
  });

  it('copes with a refusal that is not JSON', async () => {
    const broken = await serveOnce(() => new Response('<html>502</html>', { status: 502 }));

    try {
      const error = (await getSummary(account.cookie).catch((caught: unknown) => caught)) as ApiError;

      expect(error.status).toBe(502);
      expect(error.message).toContain('502');
    } finally {
      await broken.stop();
    }
  });

  it('repeats what the API said, since it words its refusals usefully', async () => {
    const error = (await getSummary(account.cookie, {
      serverId: '00000000-0000-0000-0000-000000000000',
    }).catch((caught: unknown) => caught)) as ApiError;

    expect(error.status).toBe(403);
    expect(error.message).toBe('No such server');
  });

  it('says where it tried to reach when nothing answers', async () => {
    const saved = process.env['CORE_API_URL'];
    process.env['CORE_API_URL'] = 'http://127.0.0.1:1';

    const error = (await getSummary(account.cookie).catch((caught: unknown) => caught)) as ApiError;

    expect(error.message).toContain('127.0.0.1:1');
    process.env['CORE_API_URL'] = saved;
  });


});
