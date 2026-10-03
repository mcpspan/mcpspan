import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAccount,
  createApiKey,
  resetDatabase,
  seedEvents,
  type TestAccount,
} from '../../test/fixtures.ts';
import { closePool, getPool } from '../db.ts';
import type { Diagnostics } from '../diagnostics.ts';
import { ContactLog } from '../contacts.ts';
import { IngestRateLimiter } from '../rate-limit.ts';
import { RefusalLog } from '../refusals.ts';
import { CHANGED_AT_KEY } from '../secret-check.ts';
import { createDiagnosticsRoutes } from './diagnostics.ts';
import { createEventRoutes } from './events.ts';

let account: TestAccount;
let refusals: RefusalLog;
let contacts: ContactLog;
let app: Hono;

/** Ingest and diagnostics sharing one log, the way the running API has them. */
function build(): Hono {
  const built = new Hono();
  built.route('/v1', createEventRoutes(new IngestRateLimiter(), refusals, contacts));
  built.route('/v1/diagnostics', createDiagnosticsRoutes(refusals));

  return built;
}

async function diagnostics(cookie = account.cookie): Promise<Diagnostics> {
  const response = await app.request('/v1/diagnostics', { headers: { cookie } });

  expect(response.status).toBe(200);

  return (await response.json()) as Diagnostics;
}

async function ingest(
  key: string | undefined,
  body: unknown = { events: [] },
  userAgent?: string,
): Promise<Response> {
  return app.request('/v1/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...(userAgent === undefined ? {} : { 'user-agent': userAgent }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDatabase();
  await getPool().query('DELETE FROM settings');
  account = await createAccount({ serverName: 'Flights' });
  refusals = new RefusalLog();
  contacts = new ContactLog();
  app = build();
});

afterAll(async () => {
  await closePool();
});

describe('GET /v1/diagnostics', () => {
  it('is only for somebody signed in', async () => {
    const response = await app.request('/v1/diagnostics');

    expect(response.status).toBe(401);
  });

  describe('a server nothing has arrived from', () => {
    it('says so, rather than showing zeroes', async () => {
      const [server] = (await diagnostics()).servers;

      expect(server).toMatchObject({
        id: account.serverId,
        name: 'Flights',
        lastEvent: null,
        lastContact: null,
      });
    });
  });

  describe('a server whose SDK has started but not been used', () => {
    it('shows the contact, which is what tells it apart from a wrong address', async () => {
      // What the SDK sends at startup: an empty batch, named in the User-Agent.
      expect((await ingest(account.key, { events: [] }, 'mcpspan/0.1.0')).status).toBe(202);

      // The write is not awaited by the request, by design, so wait for it here.
      await vi.waitFor(async () => {
        const [server] = (await diagnostics()).servers;

        expect(server?.lastEvent).toBeNull();
        expect(server?.lastContact).toEqual({ at: expect.any(String), sdkVersion: '0.1.0' });
      });
    });

    it('does not count a refused key as contact', async () => {
      await getPool().query('UPDATE api_keys SET revoked_at = now() WHERE server_id = $1', [
        account.serverId,
      ]);

      await ingest(account.key, { events: [] }, 'mcpspan/0.1.0');
      // Give a write the chance to happen, if anything had started one.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect((await diagnostics()).servers[0]?.lastContact).toBeNull();
    });
  });

  describe('a server that is reporting', () => {
    it('gives the newest call and the SDK that sent it', async () => {
      await seedEvents(account.serverId, [
        { occurredAt: new Date(Date.now() - 3_600_000) },
        { occurredAt: new Date(Date.now() - 60_000) },
      ]);

      const [server] = (await diagnostics()).servers;

      expect(server?.lastEvent?.sdkVersion).toBe('0.1.0');
      expect(Date.parse(server?.lastEvent?.occurredAt ?? '')).toBeGreaterThan(
        Date.now() - 120_000,
      );
    });
  });

  describe('a server whose replaced key is still in use', () => {
    it('names the server the old key belonged to', async () => {
      await getPool().query('UPDATE api_keys SET revoked_at = now() WHERE server_id = $1', [
        account.serverId,
      ]);

      expect((await ingest(account.key)).status).toBe(401);

      expect((await diagnostics()).refusals).toEqual([
        expect.objectContaining({ serverId: account.serverId, reason: 'revoked_key', requests: 1 }),
      ]);
    });

    it('gives the sender the same answer as for a key that never existed', async () => {
      // Only the owner learns which one it was. The sender learning it would
      // confirm which keys once existed.
      await getPool().query('UPDATE api_keys SET revoked_at = now() WHERE server_id = $1', [
        account.serverId,
      ]);

      const revoked = await ingest(account.key);
      const invented = await ingest('mcps_never_issued');

      expect(await revoked.json()).toEqual(await invented.json());
    });
  });

  describe('refusals that name no server', () => {
    it('counts invented keys and missing ones apart', async () => {
      await ingest('mcps_never_issued');
      await ingest('mcps_never_issued_either');
      await ingest(undefined);

      const counts = (await diagnostics()).refusals;

      expect(counts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ serverId: null, reason: 'unknown_key', requests: 2 }),
          expect.objectContaining({ serverId: null, reason: 'missing_key', requests: 1 }),
        ]),
      );
    });
  });

  it('counts a malformed batch against the server that sent it', async () => {
    await ingest(account.key, { events: [{ id: randomUUID() }] });

    expect((await diagnostics()).refusals).toEqual([
      expect.objectContaining({ serverId: account.serverId, reason: 'invalid_batch' }),
    ]);
  });

  it("leaves out another account's servers", async () => {
    const other = await createAccount();
    await getPool().query('UPDATE api_keys SET revoked_at = now() WHERE server_id = $1', [
      other.serverId,
    ]);
    await ingest(other.key);

    const seen = await diagnostics();

    expect(seen.servers.map((server) => server.id)).toEqual([account.serverId]);
    expect(seen.refusals).toEqual([]);
  });

  describe('the signing secret', () => {
    it('is not mentioned while it has never changed', async () => {
      expect((await diagnostics()).signingSecret).toBeNull();
    });

    it('names the servers whose live key was issued before it changed', async () => {
      await getPool().query(
        `INSERT INTO settings (key, value) VALUES ($1, (now() + interval '1 second')::text)`,
        [CHANGED_AT_KEY],
      );

      expect((await diagnostics()).signingSecret).toMatchObject({ staleServerIds: [account.serverId] });
    });

    it('does not count keys issued after it, which were hashed with the new one', async () => {
      await getPool().query(
        `INSERT INTO settings (key, value) VALUES ($1, (now() - interval '1 hour')::text)`,
        [CHANGED_AT_KEY],
      );

      expect((await diagnostics()).signingSecret).toMatchObject({ staleServerIds: [] });
    });
  });

  it('describes storage and retention', async () => {
    const oldest = new Date(Date.now() - 2 * 86_400_000);
    await seedEvents(account.serverId, [{ occurredAt: oldest }, {}]);

    const { storage } = await diagnostics();

    expect(storage.databaseBytes).toBeGreaterThan(0);
    expect(storage.oldestEventAt).toBe(oldest.toISOString());
    expect(storage.retentionDays).toBeGreaterThan(0);
    expect(storage.rollupRetentionDays).toBeGreaterThan(0);
  });

  it('reports the versions of the parts it can see', async () => {
    const own = (
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;

    const { versions } = await diagnostics();

    expect(versions.api).toBe(own);
    expect(versions.postgres).toMatch(/^\d+/);
    expect(versions.timescaledb).toMatch(/^\d+\.\d+/);
  });

  it('keeps an orphaned server out of every account', async () => {
    // A key minted from the command line before anyone registered belongs to
    // no account, and its refusals should not surface in one.
    const orphan = await createApiKey({ revoked: true });
    await ingest(orphan.key);

    expect((await diagnostics()).refusals).toEqual([]);
  });
});
