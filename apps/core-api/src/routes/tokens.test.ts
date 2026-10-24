import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool, getPool } from '../db.ts';
import { MAX_READ_TOKENS } from '../read-tokens.ts';

let account: TestAccount;

async function request(path: string, init: RequestInit & { cookie?: string; token?: string } = {}): Promise<Response> {
  const { cookie, token, ...rest } = init;

  return createApp().request(path, {
    ...rest,
    headers: {
      ...(rest.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie === undefined ? {} : { cookie }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
}

async function makeToken(owner: TestAccount = account, name = 'Laptop'): Promise<{ id: string; token: string }> {
  const response = await request('/v1/tokens', {
    method: 'POST',
    body: JSON.stringify({ name }),
    cookie: owner.cookie,
  });

  expect(response.status).toBe(201);

  return (await response.json()) as { id: string; token: string };
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount({ serverName: 'Flights' });
  await seedEvents(account.serverId, [
    { occurredAt: new Date(Date.now() - 10 * 60 * 1000) },
    { occurredAt: new Date(Date.now() - 5 * 60 * 1000), success: false, errorSource: 'exception' },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('making and revoking tokens', () => {
  it('shows a new token once, and only its name and dates after that', async () => {
    const made = await makeToken();

    expect(made.token).toMatch(/^mcpspan_read_[A-Za-z0-9_-]{43}$/);

    const listed = (await (await request('/v1/tokens', { cookie: account.cookie })).json()) as {
      tokens: Record<string, unknown>[];
    };

    expect(listed.tokens).toEqual([
      { id: made.id, name: 'Laptop', createdAt: expect.any(String), lastUsedAt: null },
    ]);
  });

  it('wants a name, and not an endless one', async () => {
    for (const name of [undefined, '', '   ', 7, 'x'.repeat(101)]) {
      const response = await request('/v1/tokens', {
        method: 'POST',
        body: JSON.stringify({ name }),
        cookie: account.cookie,
      });

      expect(response.status).toBe(400);
    }
  });

  it('stops at the limit', async () => {
    for (let i = 0; i < MAX_READ_TOKENS; i++) await makeToken(account, `Token ${i}`);

    const response = await request('/v1/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'One too many' }),
      cookie: account.cookie,
    });

    expect(response.status).toBe(409);
  });

  it('stops a revoked token at once', async () => {
    const { id, token } = await makeToken();

    expect((await request('/v1/dashboard/summary', { token })).status).toBe(200);
    expect((await request(`/v1/tokens/${id}`, { method: 'DELETE', cookie: account.cookie })).status).toBe(204);
    expect((await request('/v1/dashboard/summary', { token })).status).toBe(401);
  });

  it("cannot revoke somebody else's token", async () => {
    const other = await createAccount();
    const { id, token } = await makeToken(other);

    expect((await request(`/v1/tokens/${id}`, { method: 'DELETE', cookie: account.cookie })).status).toBe(404);
    expect((await request(`/v1/tokens/not-a-uuid`, { method: 'DELETE', cookie: account.cookie })).status).toBe(404);
    expect((await request('/v1/dashboard/summary', { token })).status).toBe(200);
  });

  it('goes with the account', async () => {
    const { token } = await makeToken();

    await getPool().query('DELETE FROM users WHERE id = $1', [account.userId]);

    expect((await request('/v1/dashboard/summary', { token })).status).toBe(401);
  });

  it('notes when a token was last used', async () => {
    const { token } = await makeToken();

    await request('/v1/dashboard/summary', { token });

    const listed = (await (await request('/v1/tokens', { cookie: account.cookie })).json()) as {
      tokens: { lastUsedAt: string | null }[];
    };

    expect(listed.tokens[0]?.lastUsedAt).toEqual(expect.any(String));
  });
});

describe('what a token reads', () => {
  it('gets the same answer as the dashboard from every dashboard route', async () => {
    const { token } = await makeToken();
    const routes = [
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
      'listing',
      'filters',
    ];
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    for (const route of routes) {
      const path = `/v1/dashboard/${route}?from=${from}&to=${to}`;
      const byBrowser = await request(path, { cookie: account.cookie });
      const byToken = await request(path, { token });

      expect(byToken.status, route).toBe(200);
      expect(await byToken.json(), route).toEqual(await byBrowser.json());
    }
  });

  it('lists the servers, and reads the diagnostics', async () => {
    const { token } = await makeToken();
    const servers = (await (await request('/v1/servers', { token })).json()) as { servers: { name: string }[] };

    expect(servers.servers.map((s) => s.name)).toEqual(['Flights']);
    expect((await request('/v1/diagnostics', { token })).status).toBe(200);
  });

  it("does not reach somebody else's server", async () => {
    const other = await createAccount();
    const { token } = await makeToken(other);

    expect((await request(`/v1/dashboard/summary?serverId=${account.serverId}`, { token })).status).toBe(403);
  });

  it('is refused for an unknown token, and for a server key in its place', async () => {
    expect((await request('/v1/dashboard/summary', { token: 'mcpspan_read_nothing' })).status).toBe(401);
    expect((await request('/v1/dashboard/summary', { token: account.key })).status).toBe(401);
  });
});

describe('what a token cannot do', () => {
  it('changes nothing', async () => {
    const { token } = await makeToken();
    const attempts: [string, RequestInit][] = [
      ['/v1/servers', { method: 'POST', body: JSON.stringify({ name: 'Another' }) }],
      [`/v1/servers/${account.serverId}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) }],
      [`/v1/servers/${account.serverId}/key`, { method: 'POST' }],
      [`/v1/servers/${account.serverId}`, { method: 'DELETE' }],
    ];

    for (const [path, init] of attempts) {
      expect((await request(path, { ...init, token })).status, `${init.method} ${path}`).toBe(403);
    }

    const servers = (await (await request('/v1/servers', { cookie: account.cookie })).json()) as {
      servers: { id: string; name: string; hasActiveKey: boolean }[];
    };

    expect(servers.servers).toEqual([
      expect.objectContaining({ id: account.serverId, name: 'Flights', hasActiveKey: true }),
    ]);
  });

  it('opens nothing but the numbers: not alerts, tokens or the account', async () => {
    const { token } = await makeToken();

    expect((await request('/v1/alerts', { token })).status).toBe(401);
    expect((await request('/v1/tokens', { token })).status).toBe(401);
    expect(
      (
        await request('/v1/tokens', { method: 'POST', body: JSON.stringify({ name: 'Copy' }), token })
      ).status,
    ).toBe(401);
    expect(
      (
        await request('/v1/auth/password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
          token,
        })
      ).status,
    ).toBe(401);
  });
});
