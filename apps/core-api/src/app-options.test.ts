import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, createApiKey, resetDatabase, type TestAccount } from '../test/fixtures.ts';
import { type AccountStore, selfHostedAccounts } from './accounts.ts';
import type { Admission, AdmissionRequest, Usage } from './admission.ts';
import { createApp } from './app.ts';
import { closePool, getPool } from './db.ts';

let account: TestAccount;

function event(): Record<string, unknown> {
  return {
    id: randomUUID(),
    toolName: 'search_flights',
    durationMs: 42.5,
    success: true,
    clientType: 'unknown',
    timestamp: new Date().toISOString(),
    sdkVersion: '0.7.0',
  };
}

async function send(app: ReturnType<typeof createApp>, count = 2): Promise<Response> {
  return app.request('/v1/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: Array.from({ length: count }, event) }),
  });
}

async function storedCalls(): Promise<number> {
  const result = await getPool().query<{ count: string }>('SELECT count(*) FROM tool_calls');

  return Number(result.rows[0]?.count ?? 0);
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();
});

afterAll(async () => {
  await closePool();
});

describe('admission', () => {
  it('is asked about each batch, with its server and size', async () => {
    const asked: AdmissionRequest[] = [];
    const app = createApp({
      admission: async (request) => {
        asked.push(request);
        return { allowed: true };
      },
    });

    expect((await send(app, 3)).status).toBe(202);
    expect(asked).toEqual([{ serverId: account.serverId, events: 3 }]);
  });

  it('answers 429 with Retry-After when the batch may come back, and stores nothing', async () => {
    const app = createApp({
      admission: async () => ({ allowed: false, error: 'Come back later', retryAfterSeconds: 30 }),
    });

    const response = await send(app);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    await expect(response.json()).resolves.toEqual({ error: 'Come back later' });
    expect(await storedCalls()).toBe(0);
  });

  it('answers 402, never 403, when the batch is turned away for good', async () => {
    // A 403 would make the SDK stop for the life of its process (contract, 6.4).
    const app = createApp({
      admission: async () => ({ allowed: false, error: 'Over the monthly allowance' }),
    });

    const response = await send(app);

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({ error: 'Over the monthly allowance' });
    expect(await storedCalls()).toBe(0);
  });

  it('is not reached by a request without a valid key', async () => {
    let asked = false;
    const admission: Admission = async () => {
      asked = true;
      return { allowed: true };
    };

    const response = await createApp({ admission }).request('/v1/events', {
      method: 'POST',
      headers: { authorization: 'Bearer mcps_not_a_key', 'content-type': 'application/json' },
      body: JSON.stringify({ events: [event()] }),
    });

    expect(response.status).toBe(401);
    expect(asked).toBe(false);
  });

  it('lets everything through when left out', async () => {
    expect((await send(createApp(), 2)).status).toBe(202);
    expect(await storedCalls()).toBe(2);
  });
});

describe('a usage meter', () => {
  function post(app: ReturnType<typeof createApp>, events: Record<string, unknown>[]) {
    return app.request('/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  }

  it('is told what was stored, and a batch sent again counts once', async () => {
    const told: Usage[] = [];
    const app = createApp({ usage: async (usage) => void told.push(usage) });
    const batch = [event(), event(), event()];

    expect((await post(app, batch)).status).toBe(202);
    expect((await post(app, batch)).status).toBe(202);

    expect(told).toEqual([{ serverId: account.serverId, stored: 3 }]);
  });

  it('does not make the SDK send a stored batch again when counting fails', async () => {
    const app = createApp({
      usage: async () => {
        throw new Error('counter unavailable');
      },
    });

    expect((await post(app, [event()])).status).toBe(202);
    expect(await storedCalls()).toBe(1);
  });
});

describe('an account store', () => {
  it('decides which servers the dashboard reaches', async () => {
    // A server created by somebody else, reached through a rule other than
    // ownership: what a shared organisation would look like.
    const other = await createApiKey({ serverName: 'Shared server' });
    const accounts: AccountStore = {
      ...selfHostedAccounts,
      serverIdsFor: async (userId) => [
        ...(await selfHostedAccounts.serverIdsFor(userId)),
        other.serverId,
      ],
    };

    const response = await createApp({ accounts }).request('/v1/servers', {
      headers: { cookie: account.cookie },
    });
    const body = (await response.json()) as { servers: { name: string }[] };

    expect(body.servers.map((server) => server.name)).toEqual(['Test server', 'Shared server']);

    const summary = await createApp({ accounts }).request(
      `/v1/dashboard/summary?serverId=${other.serverId}`,
      { headers: { cookie: account.cookie } },
    );

    expect(summary.status).toBe(200);
  });

  it('keeps out a server it does not list, even one the user created', async () => {
    const accounts: AccountStore = { ...selfHostedAccounts, serverIdsFor: async () => [] };
    const app = createApp({ accounts });

    const summary = await app.request(`/v1/dashboard/summary?serverId=${account.serverId}`, {
      headers: { cookie: account.cookie },
    });
    const renamed = await app.request(`/v1/servers/${account.serverId}`, {
      method: 'PATCH',
      headers: { cookie: account.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Taken over' }),
    });

    expect(summary.status).toBe(403);
    expect(renamed.status).toBe(404);
  });

  it('decides which servers alert rules may watch', async () => {
    const other = await createApiKey({ serverName: 'Shared server' });
    const accounts: AccountStore = {
      ...selfHostedAccounts,
      serverIdsFor: async () => [other.serverId],
    };
    const app = createApp({ accounts });
    const rule = (serverId: string) =>
      app.request('/v1/alerts/rules', {
        method: 'POST',
        headers: { cookie: account.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ serverId, kind: 'silence', windowMinutes: 60 }),
      });

    const shared = await rule(other.serverId);
    const own = await rule(account.serverId);
    const { id } = (await shared.json()) as { id: string };
    const listed = (await (
      await app.request('/v1/alerts', { headers: { cookie: account.cookie } })
    ).json()) as { rules: { id: string }[] };
    const removed = await app.request(`/v1/alerts/rules/${id}`, {
      method: 'DELETE',
      headers: { cookie: account.cookie },
    });

    expect(shared.status).toBe(201);
    expect(own.status).toBe(404);
    expect(listed.rules.map((listedRule) => listedRule.id)).toEqual([id]);
    expect(removed.status).toBe(204);
  });

  it('decides who may register and sign in', async () => {
    const accounts: AccountStore = {
      ...selfHostedAccounts,
      isRegistrationOpen: async () => true,
      authenticate: async () => undefined,
    };
    const app = createApp({ accounts });

    const status = await app.request('/v1/auth/status');
    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: 'a reasonably long passphrase' }),
    });

    await expect(status.json()).resolves.toMatchObject({ registrationOpen: true });
    expect(login.status).toBe(401);
  });

  it('explains a registration it refuses by a rule of its own', async () => {
    const accounts: AccountStore = {
      ...selfHostedAccounts,
      register: async () => ({ ok: false, reason: 'refused', message: 'Use a longer password' }),
    };

    const response = await createApp({ accounts }).request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'short' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Use a longer password' });
  });

  it('may refuse another server, and nothing is created', async () => {
    const accounts: AccountStore = {
      ...selfHostedAccounts,
      serverRefusal: async () => 'Your plan covers one server',
    };

    const response = await createApp({ accounts }).request('/v1/servers', {
      method: 'POST',
      headers: { cookie: account.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Second server' }),
    });
    const servers = await getPool().query('SELECT 1 FROM servers WHERE user_id = $1', [account.userId]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Your plan covers one server' });
    expect(servers.rowCount).toBe(1);
  });

  it('says why before a server is named, with the list', async () => {
    const refusing: AccountStore = {
      ...selfHostedAccounts,
      serverRefusal: async () => 'Your plan covers one server',
    };
    const request = { headers: { cookie: account.cookie } };

    const refused = await createApp({ accounts: refusing }).request('/v1/servers', request);
    const selfHosted = await createApp().request('/v1/servers', request);

    await expect(refused.json()).resolves.toMatchObject({ addRefusal: 'Your plan covers one server' });
    await expect(selfHosted.json()).resolves.toMatchObject({ addRefusal: null });
  });
});

describe('a webhook sender', () => {
  it('is what a test notification goes through', async () => {
    const sent: string[] = [];
    const app = createApp({
      webhooks: async (url) => {
        sent.push(url);
        return 204;
      },
    });
    const headers = { cookie: account.cookie, 'content-type': 'application/json' };

    await app.request('/v1/alerts/webhook', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ url: 'https://hooks.example.com/mcpspan' }),
    });
    const response = await app.request('/v1/alerts/webhook/test', { method: 'POST', headers });

    await expect(response.json()).resolves.toMatchObject({ ok: true, status: 204 });
    expect(sent).toEqual(['https://hooks.example.com/mcpspan']);
  });
});
