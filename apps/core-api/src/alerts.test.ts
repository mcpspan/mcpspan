import { createServer, type Server } from 'node:http';

import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../test/fixtures.ts';
import { evaluateAlerts, sendWebhook, type WebhookPayload } from './alerts.ts';
import { closePool, getPool } from './db.ts';
import { createAlertRoutes } from './routes/alerts.ts';

let account: TestAccount;
let sent: { url: string; payload: WebhookPayload }[];
let status: number;

/** Stands in for the network: records what would have been posted. */
const send = async (url: string, payload: WebhookPayload): Promise<number> => {
  sent.push({ url, payload });
  return status;
};

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function addWebhook(url = 'https://hooks.example.com/abc'): Promise<void> {
  await getPool().query(
    `INSERT INTO alert_webhooks (user_id, url, created_at) VALUES ($1, $2, now() - interval '1 day')`,
    [account.userId, url],
  );
}

async function addRule(
  rule: {
    kind: 'error_rate' | 'silence';
    threshold?: number;
    windowMinutes: number;
    minCalls?: number;
    toolNames?: string[];
  },
  serverId = account.serverId,
): Promise<string> {
  const created = await getPool().query<{ id: string }>(
    `INSERT INTO alert_rules (server_id, kind, threshold, window_minutes, min_calls, tool_names)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      serverId,
      rule.kind,
      rule.threshold ?? null,
      rule.windowMinutes,
      rule.minCalls ?? 1,
      rule.toolNames ?? null,
    ],
  );

  return created.rows[0]?.id as string;
}

/** Puts a rule's whole-server state at firing, as if a check had seen it. */
async function markFiring(ruleId: string, target = ''): Promise<void> {
  await getPool().query(
    `INSERT INTO alert_states (rule_id, target, state, changed_at) VALUES ($1, $2, 'firing', now())`,
    [ruleId, target],
  );
}

async function firingTargets(ruleId: string): Promise<string[]> {
  const result = await getPool().query<{ target: string }>(
    `SELECT target FROM alert_states WHERE rule_id = $1 AND state = 'firing' ORDER BY target`,
    [ruleId],
  );

  return result.rows.map((row) => row.target);
}

async function spike(): Promise<void> {
  // Thirty failures and five successes in the last few minutes.
  await seedEvents(account.serverId, [
    ...Array.from({ length: 30 }, (_, i) => ({
      success: false,
      errorSource: 'exception',
      occurredAt: minutesFromNow(-5 + i * 0.1),
    })),
    ...Array.from({ length: 5 }, () => ({ occurredAt: minutesFromNow(-2) })),
  ]);
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount({ serverName: 'Flights' });
  sent = [];
  status = 200;
});

afterAll(async () => {
  await closePool();
});

describe('an error-rate rule', () => {
  it('sends exactly one notification for one spike, however often it is checked', async () => {
    await addWebhook();
    await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15, minCalls: 10 });
    await spike();

    for (let check = 0; check < 5; check += 1) await evaluateAlerts(new Date(), send);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({
      event: 'firing',
      server: { id: account.serverId, name: 'Flights' },
      rule: { kind: 'error_rate', threshold: 0.2, windowMinutes: 15 },
    });
    expect(sent[0]?.payload.value).toBeCloseTo(30 / 35, 5);
  });

  it('says so, once, when it is over', async () => {
    await addWebhook();
    await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15, minCalls: 10 });
    await spike();

    await evaluateAlerts(new Date(), send);
    // Half an hour on, the window holds nothing: the incident is over.
    await evaluateAlerts(minutesFromNow(30), send);
    await evaluateAlerts(minutesFromNow(31), send);

    expect(sent.map((entry) => entry.payload.event)).toEqual(['firing', 'resolved']);
  });

  it('needs enough calls to judge by', async () => {
    await addWebhook();
    await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15, minCalls: 50 });
    await spike();

    await evaluateAlerts(new Date(), send);

    expect(sent).toEqual([]);
  });

  it('does not count calls to tools that do not exist', async () => {
    await addWebhook();
    await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15, minCalls: 1 });
    await seedEvents(account.serverId, [
      { success: false, errorSource: 'unknown_tool', occurredAt: minutesFromNow(-1) },
      { occurredAt: minutesFromNow(-1) },
    ]);

    await evaluateAlerts(new Date(), send);

    expect(sent).toEqual([]);
  });

  it('writes a sentence Slack and Discord can show as it is', async () => {
    await addWebhook();
    await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15, minCalls: 10 });
    await spike();

    await evaluateAlerts(new Date(), send);

    const payload = sent[0]?.payload;
    expect(payload?.text).toBe(
      'mcpspan: Flights: 86% of calls failed over the last 15 minutes, at or above the 20% threshold.',
    );
    expect(payload?.content).toBe(payload?.text);
  });
});

describe('a silence rule', () => {
  it('fires when a server that used to report goes quiet, and resolves when it is back', async () => {
    await addWebhook();
    await addRule({ kind: 'silence', windowMinutes: 60 });
    await seedEvents(account.serverId, [{ occurredAt: minutesFromNow(-120) }]);

    await evaluateAlerts(new Date(), send);
    await seedEvents(account.serverId, [{ occurredAt: new Date() }]);
    await evaluateAlerts(new Date(), send);

    expect(sent.map((entry) => entry.payload.event)).toEqual(['firing', 'resolved']);
    expect(sent[0]?.payload.text).toBe('mcpspan: Flights has had no calls for 1 hour.');
  });

  it('stays quiet about a server that has never reported', async () => {
    await addWebhook();
    await addRule({ kind: 'silence', windowMinutes: 60 });

    await evaluateAlerts(new Date(), send);

    expect(sent).toEqual([]);
  });
});

describe('delivery', () => {
  it('records a change of state even with nowhere to send it, and never sends it later', async () => {
    await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15, minCalls: 10 });
    await spike();

    await evaluateAlerts(new Date(), send);

    const events = await getPool().query('SELECT kind FROM alert_events');
    expect(events.rows).toEqual([{ kind: 'firing' }]);

    // A webhook added afterwards is not sent news of an incident from before it.
    await getPool().query(`INSERT INTO alert_webhooks (user_id, url) VALUES ($1, $2)`, [
      account.userId,
      'https://hooks.example.com/abc',
    ]);
    await evaluateAlerts(new Date(), send);

    expect(sent).toEqual([]);
  });

  it('tries a failing webhook a few times, then stops and says why', async () => {
    await addWebhook();
    await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15, minCalls: 10 });
    await spike();
    status = 500;

    for (let check = 0; check < 6; check += 1) await evaluateAlerts(new Date(), send);

    expect(sent).toHaveLength(3);

    const event = await getPool().query<{ delivered_at: Date | null; last_error: string }>(
      'SELECT delivered_at, last_error FROM alert_events',
    );
    expect(event.rows[0]).toEqual({ delivered_at: null, last_error: 'The webhook answered 500' });

    const hook = await getPool().query<{ last_status: number }>(
      'SELECT last_status FROM alert_webhooks',
    );
    expect(hook.rows[0]?.last_status).toBe(500);
  });

  it('leaves a disabled rule alone', async () => {
    await addWebhook();
    const id = await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15 });
    await getPool().query('UPDATE alert_rules SET enabled = false WHERE id = $1', [id]);
    await spike();

    await evaluateAlerts(new Date(), send);

    expect(sent).toEqual([]);
  });

  it('sends once when two processes check at the same moment', async () => {
    await addWebhook();
    await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15, minCalls: 10 });
    await spike();

    await Promise.all([evaluateAlerts(new Date(), send), evaluateAlerts(new Date(), send)]);
    await evaluateAlerts(new Date(), send);

    expect(sent).toHaveLength(1);
  });
});

describe('sendWebhook', () => {
  let receiver: Server;
  let received: { body: string; agent: string | undefined }[];

  beforeEach(async () => {
    received = [];
    receiver = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        received.push({ body, agent: request.headers['user-agent'] });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  });

  it('posts the payload as JSON over the real network', async () => {
    const address = receiver.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const answered = await sendWebhook(`http://127.0.0.1:${port}/hook`, {
      text: 'hello',
      content: 'hello',
      event: 'test',
      server: null,
      rule: null,
      value: null,
      occurredAt: new Date().toISOString(),
    });

    await new Promise<void>((resolve) => receiver.close(() => resolve()));

    expect(answered).toBe(204);
    expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({ text: 'hello', event: 'test' });
    expect(received[0]?.agent).toMatch(/^mcpspan-alerts\//);
  });
});

describe('/v1/alerts', () => {
  function app(): Hono {
    const built = new Hono();
    built.route('/v1/alerts', createAlertRoutes(send));
    return built;
  }

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return app().request(`/v1/alerts${path}`, {
      method,
      headers: {
        cookie: account.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('creates a rule on a server the account owns', async () => {
    const response = await call('POST', '/rules', {
      serverId: account.serverId,
      kind: 'error_rate',
      threshold: 0.2,
      windowMinutes: 15,
    });

    expect(response.status).toBe(201);

    const { rules } = (await (await call('GET', '')).json()) as { rules: unknown[] };
    expect(rules).toEqual([
      expect.objectContaining({ kind: 'error_rate', threshold: 0.2, minCalls: 10, firing: false }),
    ]);
  });

  it("refuses a rule on another account's server", async () => {
    const other = await createAccount();

    const response = await call('POST', '/rules', {
      serverId: other.serverId,
      kind: 'silence',
      windowMinutes: 60,
    });

    expect(response.status).toBe(404);
  });

  it.each([
    [{ kind: 'latency', windowMinutes: 15 }, 'kind'],
    [{ kind: 'error_rate', threshold: 20, windowMinutes: 15 }, 'threshold'],
    [{ kind: 'error_rate', threshold: 0.2, windowMinutes: 2000 }, 'windowMinutes'],
    [{ kind: 'silence', windowMinutes: 0 }, 'windowMinutes'],
  ])('refuses %j, naming %s', async (rule, field) => {
    const response = await call('POST', '/rules', { serverId: account.serverId, ...rule });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(field);
  });

  it('starts a changed rule again from ok', async () => {
    const id = await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15 });
    await markFiring(id);

    expect((await call('PATCH', `/rules/${id}`, { threshold: 0.5 })).status).toBe(200);

    const rule = await getPool().query('SELECT threshold FROM alert_rules WHERE id = $1', [id]);
    expect(rule.rows[0]).toEqual({ threshold: 0.5 });
    expect(await firingTargets(id)).toEqual([]);
  });

  it('accepts only http and https webhook addresses', async () => {
    expect((await call('PUT', '/webhook', { url: 'ftp://example.com/x' })).status).toBe(400);
    expect((await call('PUT', '/webhook', { url: 'not a url' })).status).toBe(400);
    expect((await call('PUT', '/webhook', { url: 'https://hooks.slack.com/services/x' })).status).toBe(
      200,
    );
  });

  it('sends a test notification and says how it went', async () => {
    await call('PUT', '/webhook', { url: 'https://hooks.example.com/abc' });
    status = 404;

    const outcome = (await (await call('POST', '/webhook/test')).json()) as Record<string, unknown>;

    expect(outcome).toEqual({ ok: false, status: 404, error: 'The webhook answered 404' });
    expect(sent[0]?.payload.event).toBe('test');

    const { webhook } = (await (await call('GET', '')).json()) as { webhook: unknown };
    expect(webhook).toMatchObject({ lastStatus: 404, lastError: 'The webhook answered 404' });
  });
});

describe('choosing what is sent', () => {
  it('sends only the start when the rule asks for starts only, and keeps the end on record', async () => {
    await addWebhook();
    const id = await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15, minCalls: 10 });
    await getPool().query('UPDATE alert_rules SET notify_resolved = false WHERE id = $1', [id]);
    await spike();

    await evaluateAlerts(new Date(), send);
    await evaluateAlerts(minutesFromNow(30), send);

    expect(sent.map((entry) => entry.payload.event)).toEqual(['firing']);

    const events = await getPool().query('SELECT kind FROM alert_events ORDER BY occurred_at');
    expect(events.rows).toEqual([{ kind: 'firing' }, { kind: 'resolved' }]);
  });

  it('can be switched without clearing a firing alert', async () => {
    const id = await addRule({ kind: 'error_rate', threshold: 0.2, windowMinutes: 15 });
    await markFiring(id);

    const response = await createAlertRoutes(send).request(`/rules/${id}`, {
      method: 'PATCH',
      headers: { cookie: account.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ notifyResolved: false }),
    });

    expect(response.status).toBe(200);

    const rule = await getPool().query('SELECT notify_resolved FROM alert_rules WHERE id = $1', [
      id,
    ]);
    expect(rule.rows[0]).toEqual({ notify_resolved: false });
    expect(await firingTargets(id)).toEqual(['']);
  });
});

describe('a rule on one tool', () => {
  it('fires for that tool, and names it', async () => {
    await addWebhook();
    await addRule({
      kind: 'error_rate',
      threshold: 0.2,
      windowMinutes: 15,
      minCalls: 10,
      toolNames: ['search_flights'],
    });
    await spike();

    await evaluateAlerts(new Date(), send);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.rule?.toolName).toBe('search_flights');
    expect(sent[0]?.payload.text).toContain('Flights, search_flights: 86% of calls failed');
  });

  it('ignores a spike on another tool', async () => {
    await addWebhook();
    await addRule({
      kind: 'error_rate',
      threshold: 0.2,
      windowMinutes: 15,
      minCalls: 1,
      toolNames: ['book_flight'],
    });
    await spike();
    await seedEvents(account.serverId, [{ toolName: 'book_flight', occurredAt: minutesFromNow(-1) }]);

    await evaluateAlerts(new Date(), send);

    expect(sent).toEqual([]);
  });

  it('notices one tool going unused while the server stays busy', async () => {
    await addWebhook();
    await addRule({ kind: 'silence', windowMinutes: 60, toolNames: ['book_flight'] });
    await seedEvents(account.serverId, [
      { toolName: 'book_flight', occurredAt: minutesFromNow(-180) },
      { toolName: 'search_flights', occurredAt: minutesFromNow(-1) },
    ]);

    await evaluateAlerts(new Date(), send);

    expect(sent.map((entry) => entry.payload.text)).toEqual([
      'mcpspan: Flights, book_flight has had no calls for 1 hour.',
    ]);
  });

  it('is created and listed through the API', async () => {
    const routes = createAlertRoutes(send);
    const headers = { cookie: account.cookie, 'content-type': 'application/json' };

    const created = await routes.request('/rules', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serverId: account.serverId,
        toolNames: ['search_flights', 'book_flight'],
        kind: 'silence',
        windowMinutes: 60,
      }),
    });

    expect(created.status).toBe(201);

    const listed = (await (await routes.request('/', { headers })).json()) as {
      rules: { toolNames: string[] | null }[];
    };
    expect(listed.rules.map((rule) => rule.toolNames)).toEqual([['book_flight', 'search_flights']]);
  });
});

describe('a rule on several tools', () => {
  it('judges each on its own and names the one that broke', async () => {
    await addWebhook();
    const id = await addRule({
      kind: 'error_rate',
      threshold: 0.2,
      windowMinutes: 15,
      minCalls: 5,
      toolNames: ['book_flight', 'search_flights'],
    });
    await spike();
    // Healthy, and busy enough to be judged.
    await seedEvents(
      account.serverId,
      Array.from({ length: 10 }, () => ({ toolName: 'book_flight', occurredAt: minutesFromNow(-1) })),
    );

    await evaluateAlerts(new Date(), send);
    await evaluateAlerts(new Date(), send);

    expect(sent.map((entry) => entry.payload.rule?.toolName)).toEqual(['search_flights']);
    expect(await firingTargets(id)).toEqual(['search_flights']);
  });

  it('sends one message per tool when several break at once', async () => {
    await addWebhook();
    await addRule({
      kind: 'silence',
      windowMinutes: 60,
      toolNames: ['book_flight', 'cancel_flight', 'search_flights'],
    });
    await seedEvents(account.serverId, [
      { toolName: 'book_flight', occurredAt: minutesFromNow(-180) },
      { toolName: 'cancel_flight', occurredAt: minutesFromNow(-180) },
      { toolName: 'search_flights', occurredAt: minutesFromNow(-1) },
    ]);

    await evaluateAlerts(new Date(), send);

    expect(sent.map((entry) => entry.payload.rule?.toolName).sort()).toEqual([
      'book_flight',
      'cancel_flight',
    ]);
  });

  it('starts again from ok when its list of tools changes', async () => {
    const id = await addRule({
      kind: 'silence',
      windowMinutes: 60,
      toolNames: ['book_flight'],
    });
    await markFiring(id, 'book_flight');

    const response = await createAlertRoutes(send).request(`/rules/${id}`, {
      method: 'PATCH',
      headers: { cookie: account.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ toolNames: ['search_flights'] }),
    });

    expect(response.status).toBe(200);
    expect(await firingTargets(id)).toEqual([]);
  });

  it('refuses a list that is not a list of names', async () => {
    const response = await createAlertRoutes(send).request('/rules', {
      method: 'POST',
      headers: { cookie: account.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId: account.serverId,
        toolNames: ['ok', 42],
        kind: 'silence',
        windowMinutes: 60,
      }),
    });

    expect(response.status).toBe(400);
  });
});

describe('the alert history', () => {
  it('pages', async () => {
    const id = await addRule({ kind: 'silence', windowMinutes: 60 });
    await getPool().query(
      `INSERT INTO alert_events (rule_id, kind, occurred_at)
       SELECT $1, 'firing', now() - i * interval '1 minute' FROM generate_series(1, 25) i`,
      [id],
    );

    const routes = createAlertRoutes(send);
    const read = async (query: string) =>
      (await (
        await routes.request(`/${query}`, { headers: { cookie: account.cookie } })
      ).json()) as { events: unknown[]; eventsHaveMore: boolean };

    const first = await read('');
    const second = await read('?eventsOffset=20');

    expect(first.events).toHaveLength(20);
    expect(first.eventsHaveMore).toBe(true);
    expect(second.events).toHaveLength(5);
    expect(second.eventsHaveMore).toBe(false);
  });
});
