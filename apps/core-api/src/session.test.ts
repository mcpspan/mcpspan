import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, createApiKey, resetDatabase, type TestAccount } from '../test/fixtures.ts';
import { sweepExpiredSessions } from './accounts.ts';
import { closePool, getPool } from './db.ts';
import { requireSession, resolveServerId, type SessionVariables } from './session.ts';

/** A route that reports what the session let through. */
function guardedApp() {
  const app = new Hono<{ Variables: SessionVariables }>();
  app.use('/dashboard', requireSession());
  app.get('/dashboard', (c) => {
    const resolved = resolveServerId(c);

    return 'error' in resolved
      ? c.json({ error: resolved.error }, resolved.status)
      : c.json({ serverId: resolved.serverId, email: c.get('session').email });
  });

  return app;
}

let account: TestAccount;

async function get(path: string, cookie: string | null = account.cookie): Promise<Response> {
  return guardedApp().request(path, { headers: cookie === null ? {} : { cookie } });
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();
});

afterAll(async () => {
  await closePool();
});

describe('requireSession', () => {
  it('lets a signed-in browser through', async () => {
    expect((await get('/dashboard')).status).toBe(200);
  });

  it('says who is asking', async () => {
    await expect((await get('/dashboard')).json()).resolves.toMatchObject({
      email: account.email,
    });
  });

  it.each([
    ['no cookie is sent', null],
    ['the cookie is empty', 'mcpspan_session='],
    ['the token is invented', 'mcpspan_session=not-a-real-token'],
    ['it is some other cookie', 'something_else=value'],
  ])('refuses when %s', async (_label, cookie) => {
    expect((await get('/dashboard', cookie)).status).toBe(401);
  });

  it('is not opened by an API key', async () => {
    // Two credentials for two different things. A key leaked from a server's
    // environment must not also open that server's dashboard.
    expect((await get('/dashboard', `mcpspan_session=${account.key}`)).status).toBe(401);
  });

  it('refuses a session that has expired', async () => {
    await getPool().query("UPDATE sessions SET expires_at = now() - interval '1 day'");

    expect((await get('/dashboard')).status).toBe(401);
  });

  it('refuses a session that was signed out', async () => {
    await getPool().query('DELETE FROM sessions');

    expect((await get('/dashboard')).status).toBe(401);
  });
});

describe('resolveServerId with one server', () => {
  it('needs no parameter, since there is nothing to choose between', async () => {
    await expect((await get('/dashboard')).json()).resolves.toMatchObject({
      serverId: account.serverId,
    });
  });

  it('accepts that server named explicitly', async () => {
    await expect(
      (await get(`/dashboard?serverId=${account.serverId}`)).json(),
    ).resolves.toMatchObject({ serverId: account.serverId });
  });
});

describe('resolveServerId with several servers', () => {
  it('asks which one', async () => {
    await createApiKey({ userId: account.userId });

    const response = await get('/dashboard');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('serverId'),
    });
  });

  it('answers for the one that was named', async () => {
    const second = await createApiKey({ userId: account.userId });

    await expect((await get(`/dashboard?serverId=${second.serverId}`)).json()).resolves.toMatchObject(
      { serverId: second.serverId },
    );
  });
});

describe('resolveServerId for a server out of reach', () => {
  it('refuses one the session does not cover', async () => {
    expect((await get('/dashboard?serverId=00000000-0000-0000-0000-000000000000')).status).toBe(403);
  });

  it('refuses a server belonging to somebody else', async () => {
    // The whole point of the change: one account cannot read another's
    // telemetry by naming its server.
    const stranger = await createAccount();

    expect((await get(`/dashboard?serverId=${stranger.serverId}`)).status).toBe(403);
  });

  it('still reaches a server whose only key was revoked', async () => {
    // Revoking a credential stops a server writing. It does not unsay what the
    // server already recorded, and it used to: reachability was read from
    // unrevoked keys, so replacing a key in two steps made a server disappear
    // from the dashboard while every event it had sent sat in the table.
    const revoked = await createApiKey({ userId: account.userId, revoked: true });

    expect((await get(`/dashboard?serverId=${revoked.serverId}`)).status).toBe(200);
  });

  it('answers the same way whether it is missing or out of bounds', async () => {
    const stranger = await createAccount();

    const missing = await get('/dashboard?serverId=00000000-0000-0000-0000-000000000000');
    const foreign = await get(`/dashboard?serverId=${stranger.serverId}`);

    await expect(missing.json()).resolves.toEqual(await foreign.json());
  });
});

describe('resolveServerId with nothing reporting yet', () => {
  it('explains what to do rather than showing an empty dashboard', async () => {
    // No servers at all, which is what an account looks like before anything
    // has been connected.
    await getPool().query('DELETE FROM api_keys');
    await getPool().query('DELETE FROM servers');

    const response = await get('/dashboard');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('API key'),
    });
  });
});

describe('keys that belong to nobody', () => {
  it('are invisible to every account', async () => {
    // Keys minted from the command line before accounts existed have no owner.
    // They keep accepting telemetry; their events simply wait to be claimed
    // rather than showing up for whoever signs up first.
    const orphan = await createApiKey();

    expect((await get(`/dashboard?serverId=${orphan.serverId}`)).status).toBe(403);
  });
});

describe('sweepExpiredSessions', () => {
  it('deletes sessions that have run out and keeps the live one', async () => {
    await getPool().query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES (sha256('stale'::bytea), $1, now() - interval '1 minute')`,
      [account.userId],
    );

    expect(await sweepExpiredSessions()).toBe(1);
    expect((await get('/dashboard')).status).toBe(200);
  });
});
