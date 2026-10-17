import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, createApiKey, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { requireApiKey, type AuthVariables } from '../auth.ts';
import { closePool, getPool } from '../db.ts';

let account: TestAccount;

async function call(
  path: string,
  init: RequestInit = {},
  cookie: string | null = account.cookie,
): Promise<Response> {
  return createApp().request(`/v1/servers${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie === null ? {} : { cookie }),
    },
  });
}

const list = (cookie?: string | null) => call('', {}, cookie === undefined ? account.cookie : cookie);

const create = (name: unknown, cookie?: string | null) =>
  call('', { method: 'POST', body: JSON.stringify({ name }) }, cookie === undefined ? account.cookie : cookie);

const regenerate = (serverId: string, cookie?: string | null) =>
  call(`/${serverId}/key`, { method: 'POST' }, cookie === undefined ? account.cookie : cookie);

const rename = (serverId: string, name: unknown) =>
  call(`/${serverId}`, { method: 'PATCH', body: JSON.stringify({ name }) });

const remove = (serverId: string, cookie?: string | null) =>
  call(`/${serverId}`, { method: 'DELETE' }, cookie === undefined ? account.cookie : cookie);

const deleteData = (serverId: string, body: Record<string, unknown>, cookie?: string | null) =>
  call(
    `/${serverId}/data/delete`,
    { method: 'POST', body: JSON.stringify(body) },
    cookie === undefined ? account.cookie : cookie,
  );

/** Calls a table holds for a server; an hourly summary counts what each of its rows stands for. */
async function countFor(table: string, serverId: string): Promise<number> {
  const counted = table.endsWith('_hourly') ? 'calls' : '1';
  const result = await getPool().query<{ c: string }>(
    `SELECT coalesce(sum(${counted}), 0) AS c FROM ${table} WHERE server_id = $1`,
    [serverId],
  );

  return Number(result.rows[0]?.c);
}

async function refreshRollups(): Promise<void> {
  for (const rollup of ['tool_calls_hourly', 'resource_calls_hourly', 'prompt_calls_hourly']) {
    await getPool().query(`CALL refresh_continuous_aggregate('${rollup}', NULL, NULL)`);
  }
}

/** Whether a key still opens the ingest endpoint. */
async function keyWorks(key: string): Promise<boolean> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('/probe', requireApiKey());
  app.get('/probe', (c) => c.json({ ok: true }));

  const response = await app.request('/probe', { headers: { authorization: `Bearer ${key}` } });

  return response.status === 200;
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount({ serverName: 'Flights' });
});

afterAll(async () => {
  await closePool();
});

describe('listing servers', () => {
  it('says what exists', async () => {
    await expect((await list()).json()).resolves.toEqual({
      servers: [
        {
          id: account.serverId,
          name: 'Flights',
          createdAt: expect.any(String),
          hasActiveKey: true,
        },
      ],
    });
  });

  it('never returns a key, because nothing can', async () => {
    // Only a hash is stored. A list that appeared to hand keys back would be
    // either a lie or a much worse design.
    expect(JSON.stringify(await (await list()).json())).not.toContain(account.key);
  });

  it('shows nothing belonging to somebody else', async () => {
    const stranger = await createAccount();

    const body = (await (await list()).json()) as { servers: { id: string }[] };

    expect(body.servers.map((s) => s.id)).not.toContain(stranger.serverId);
  });

  it('still lists a server whose key was revoked, and says the key is gone', async () => {
    const revoked = await createApiKey({ userId: account.userId, revoked: true });

    const body = (await (await list()).json()) as {
      servers: { id: string; hasActiveKey: boolean }[];
    };

    expect(body.servers.find((s) => s.id === revoked.serverId)?.hasActiveKey).toBe(false);
  });

  it.each([
    ['without a session', null],
    ['with an API key instead of a session', 'placeholder'],
  ])('refuses %s', async (label, cookie) => {
    const sent = label.includes('API key') ? `mcpspan_session=${account.key}` : cookie;

    expect((await list(sent)).status).toBe(401);
  });
});

describe('adding a server', () => {
  it('creates it with a key, and shows the key exactly once', async () => {
    const response = await create('Bookings');

    expect(response.status).toBe(201);

    const body = (await response.json()) as { server: { id: string; name: string }; apiKey: string };

    expect(body.server.name).toBe('Bookings');
    expect(body.apiKey).toMatch(/^mcps_/);
    expect(await keyWorks(body.apiKey)).toBe(true);
  });

  it('keeps the servers apart, each with its own key', async () => {
    const created = (await (await create('Bookings')).json()) as {
      server: { id: string };
      apiKey: string;
    };

    expect(created.server.id).not.toBe(account.serverId);
    expect(await keyWorks(account.key)).toBe(true);
    expect(await keyWorks(created.apiKey)).toBe(true);
  });

  it('lists both afterwards, oldest first', async () => {
    await create('Bookings');

    const body = (await (await list()).json()) as { servers: { name: string }[] };

    expect(body.servers.map((s) => s.name)).toEqual(['Flights', 'Bookings']);
  });

  it.each([
    ['nothing at all', undefined],
    ['an empty name', '   '],
    ['something that is not text', 42],
    ['a name nobody could read', 'x'.repeat(200)],
  ])('refuses %s', async (_label, name) => {
    expect((await create(name)).status).toBe(400);
  });

  it('refuses without a session', async () => {
    expect((await create('Bookings', null)).status).toBe(401);
  });
});

describe('replacing a key', () => {
  it('hands over a new one that works', async () => {
    const body = (await (await regenerate(account.serverId)).json()) as { apiKey: string };

    expect(body.apiKey).not.toBe(account.key);
    expect(await keyWorks(body.apiKey)).toBe(true);
  });

  it('stops the old one working straight away', async () => {
    // No grace period. A key is replaced because it may have leaked, and a
    // window in which the suspect credential still works is the opposite of
    // the point.
    await regenerate(account.serverId);

    expect(await keyWorks(account.key)).toBe(false);
  });

  it('keeps the same server, so the history does not disappear', async () => {
    const body = (await (await regenerate(account.serverId)).json()) as { serverId: string };

    expect(body.serverId).toBe(account.serverId);
  });

  it('keeps the name', async () => {
    await regenerate(account.serverId);

    const servers = (await (await list()).json()) as { servers: { name: string }[] };

    expect(servers.servers[0]?.name).toBe('Flights');
  });

  it('leaves exactly one live key behind', async () => {
    await regenerate(account.serverId);
    await regenerate(account.serverId);

    const live = await getPool().query(
      'SELECT count(*) AS c FROM api_keys WHERE server_id = $1 AND revoked_at IS NULL',
      [account.serverId],
    );

    expect(Number((live.rows[0] as { c: string }).c)).toBe(1);
  });

  it('keeps the revoked one on record rather than deleting it', async () => {
    // A key that wrote events for six months has to stay explainable after it
    // stops working.
    await regenerate(account.serverId);

    const revoked = await getPool().query(
      'SELECT count(*) AS c FROM api_keys WHERE server_id = $1 AND revoked_at IS NOT NULL',
      [account.serverId],
    );

    expect(Number((revoked.rows[0] as { c: string }).c)).toBe(1);
  });

  it('names the server it replaces, with several to choose from', async () => {
    const second = (await (await create('Bookings')).json()) as { server: { id: string } };

    await regenerate(second.server.id);

    // The first server's key is untouched, which is the whole reason the
    // server is named in the path rather than guessed at.
    expect(await keyWorks(account.key)).toBe(true);
  });

  it('touches nothing belonging to somebody else', async () => {
    const stranger = await createAccount();

    expect((await regenerate(stranger.serverId)).status).toBe(404);
    expect(await keyWorks(stranger.key)).toBe(true);
  });

  it('refuses without a session', async () => {
    expect((await regenerate(account.serverId, null)).status).toBe(401);
  });
});

describe('renaming a server', () => {
  it('changes the name everywhere at once', async () => {
    expect((await rename(account.serverId, 'Flight search')).status).toBe(200);

    const servers = (await (await list()).json()) as { servers: { name: string }[] };

    expect(servers.servers[0]?.name).toBe('Flight search');
  });

  it('refuses a name nobody could read', async () => {
    expect((await rename(account.serverId, '')).status).toBe(400);
  });

  it('refuses one belonging to somebody else', async () => {
    const stranger = await createAccount();

    expect((await rename(stranger.serverId, 'Mine now')).status).toBe(404);
  });
});

describe('deleting what a server recorded', () => {
  async function seeded(): Promise<void> {
    await seedEvents(account.serverId, [
      { kind: 'tool', toolName: 'kept_before', occurredAt: '2026-01-05T09:30:00Z' },
      { kind: 'tool', toolName: 'leaked', occurredAt: '2026-01-05T10:15:00Z' },
      { kind: 'resource', toolName: 'file:///leaked', occurredAt: '2026-01-05T10:20:00Z' },
      { kind: 'tool', toolName: 'kept_same_hour', occurredAt: '2026-01-05T10:50:00Z' },
      { kind: 'tool', toolName: 'kept_after', occurredAt: '2026-01-06T12:00:00Z' },
    ]);
    await refreshRollups();
  }

  const range = { from: '2026-01-05T10:00:00Z', to: '2026-01-05T10:30:00Z' };

  it('says first how many calls it would take, and takes none', async () => {
    await seeded();

    const response = await deleteData(account.serverId, { ...range, dryRun: true });

    await expect(response.json()).resolves.toEqual({ calls: 2, deleted: false });
    expect(await countFor('tool_calls', account.serverId)).toBe(4);
  });

  it('takes the calls in the range and their place in the hourly summaries, and nothing else', async () => {
    await seeded();

    const response = await deleteData(account.serverId, range);

    await expect(response.json()).resolves.toEqual({ calls: 2, deleted: true });
    const names = await getPool().query<{ tool_name: string }>(
      'SELECT tool_name FROM tool_calls WHERE server_id = $1 ORDER BY occurred_at',
      [account.serverId],
    );
    expect(names.rows.map((row) => row.tool_name)).toEqual(['kept_before', 'kept_same_hour', 'kept_after']);
    expect(await countFor('resource_calls', account.serverId)).toBe(0);
    // The 10:00 hour is counted again from what is left of it: one call, not three.
    expect(await countFor('tool_calls_hourly', account.serverId)).toBe(3);
    expect(await countFor('resource_calls_hourly', account.serverId)).toBe(0);
    expect(await keyWorks(account.key)).toBe(true);
  });

  it('takes everything with no range, and keeps the server', async () => {
    await seeded();

    await expect((await deleteData(account.serverId, {})).json()).resolves.toEqual({ calls: 5, deleted: true });
    expect(await countFor('tool_calls', account.serverId)).toBe(0);
    expect(await countFor('tool_calls_hourly', account.serverId)).toBe(0);
    const servers = (await (await list()).json()) as { servers: { id: string }[] };
    expect(servers.servers.map((s) => s.id)).toEqual([account.serverId]);
  });

  it("refuses a range that ends before it starts, and another account's server", async () => {
    const other = await createAccount();

    expect((await deleteData(account.serverId, { from: range.to, to: range.from })).status).toBe(400);
    expect((await deleteData(account.serverId, { from: 'yesterday' })).status).toBe(400);
    expect((await deleteData(other.serverId, {})).status).toBe(404);
    expect((await deleteData(account.serverId, {}, null)).status).toBe(401);
  });
});

describe('removing a server', () => {
  it('takes its key and everything it recorded with it', async () => {
    const created = (await (await create('Bookings')).json()) as { server: { id: string } };
    const serverId = created.server.id;

    await seedEvents(serverId, [
      { kind: 'tool', toolName: 'doomed', occurredAt: '2026-01-05T10:00:00Z' },
      { kind: 'resource', toolName: 'file:///doomed', occurredAt: '2026-01-05T10:00:00Z' },
      { kind: 'prompt', toolName: 'doomed', occurredAt: '2026-01-05T10:00:00Z' },
    ]);
    await getPool().query(
      `INSERT INTO tool_listings (id, server_id, occurred_at, client_type, sdk_version, tool_names, definition_hashes, definition_bytes)
       VALUES (gen_random_uuid(), $1, now(), 'claude', '0.1.0', '{doomed}', '{abc}', '{10}')`,
      [serverId],
    );

    expect((await remove(serverId)).status).toBe(204);

    for (const table of [
      'tool_calls',
      'resource_calls',
      'prompt_calls',
      'tool_listings',
      // Rebuilt, not just marked stale: these buckets are months old.
      'tool_calls_hourly',
      'resource_calls_hourly',
      'prompt_calls_hourly',
    ]) {
      const left = await getPool().query(`SELECT count(*) AS c FROM ${table} WHERE server_id = $1`, [serverId]);

      expect({ table, left: Number((left.rows[0] as { c: string }).c) }).toEqual({ table, left: 0 });
    }
  });

  it('leaves the other servers alone', async () => {
    const created = (await (await create('Bookings')).json()) as { server: { id: string } };

    await remove(created.server.id);

    expect(await keyWorks(account.key)).toBe(true);

    const servers = (await (await list()).json()) as { servers: { id: string }[] };

    expect(servers.servers.map((s) => s.id)).toEqual([account.serverId]);
  });

  it('refuses to remove the last one', async () => {
    // An account with no servers has no key, no way to make one from the
    // interface, and no way back except the command line. That is not a corner
    // anybody should reach by clicking.
    const response = await remove(account.serverId);

    expect(response.status).toBe(409);
    expect(await keyWorks(account.key)).toBe(true);
  });

  it('refuses one belonging to somebody else', async () => {
    const stranger = await createAccount();
    await create('Bookings');

    expect((await remove(stranger.serverId)).status).toBe(404);
    expect(await keyWorks(stranger.key)).toBe(true);
  });

  it('refuses without a session', async () => {
    await create('Bookings');

    expect((await remove(account.serverId, null)).status).toBe(401);
  });
});
