import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiKey, resetDatabase, type TestApiKey } from '../../test/fixtures.ts';
import { closePool, getPool } from '../db.ts';
import { IngestRateLimiter } from '../rate-limit.ts';
import { RefusalLog } from '../refusals.ts';
import { createEventRoutes } from './events.ts';

let apiKey: TestApiKey;
let clock = 1_000_000;

/** An app whose limit a test can reach, and whose clock it can move. */
function appWith(eventsPerSecond: number, burst: number) {
  const limiter = new IngestRateLimiter(eventsPerSecond, burst, () => clock);
  const refusals = new RefusalLog();
  const app = new Hono();
  app.route('/v1', createEventRoutes(limiter, refusals));

  return { app, limiter, refusals };
}

function event(): Record<string, unknown> {
  return {
    id: randomUUID(),
    toolName: 'search_flights',
    durationMs: 42.5,
    success: true,
    clientType: 'claude',
    timestamp: new Date().toISOString(),
    sdkVersion: '0.1.0',
  };
}

async function send(app: Hono, count: number): Promise<Response> {
  return app.request('/v1/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: Array.from({ length: count }, event) }),
  });
}

beforeEach(async () => {
  await resetDatabase();
  apiKey = await createApiKey();
  clock = 1_000_000;
});

afterAll(async () => {
  await closePool();
});

describe('a server writing faster than it is allowed to', () => {
  it('accepts what fits in the burst', async () => {
    const { app } = appWith(10, 50);

    expect((await send(app, 50)).status).toBe(202);
  });

  it('answers 429 once the allowance is spent', async () => {
    const { app } = appWith(10, 50);

    await send(app, 50);

    expect((await send(app, 10)).status).toBe(429);
  });

  it('says how long to wait, in the standard header', async () => {
    const { app } = appWith(10, 50);

    await send(app, 50);
    const refused = await send(app, 20);

    expect(refused.headers.get('Retry-After')).toBe('2');
  });

  it('writes nothing it refused', async () => {
    // The point of refusing. A 429 that had already stored half the batch
    // would leave the sender retrying events that are in the table.
    const { app } = appWith(10, 50);

    await send(app, 50);
    await send(app, 20);

    const stored = await getPool().query<{ c: string }>(
      'SELECT count(*) AS c FROM tool_calls WHERE server_id = $1',
      [apiKey.serverId],
    );

    expect(Number(stored.rows[0]?.c)).toBe(50);
  });

  it('lets it through again after the wait it asked for', async () => {
    const { app } = appWith(10, 50);

    await send(app, 50);
    const refused = await send(app, 20);

    clock += Number(refused.headers.get('Retry-After')) * 1000;

    expect((await send(app, 20)).status).toBe(202);
  });

  it('explains itself rather than answering with a bare status', async () => {
    const { app } = appWith(10, 50);

    await send(app, 50);
    const refused = await send(app, 10);

    await expect(refused.json()).resolves.toEqual({
      error: expect.stringContaining('Too many events'),
    });
  });

  it('still tells a spent server its body was unreadable', async () => {
    // The limit is charged after the batch is counted, so a malformed body is
    // answered as malformed rather than as too fast. Telling somebody to slow
    // down when their request would never have worked sends them off fixing
    // the wrong thing.
    const { app } = appWith(10, 50);

    await send(app, 50);

    const refused = await app.request('/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      body: 'this is not JSON at all',
    });

    expect(refused.status).toBe(400);
  });

  it('does not slow down anybody else', async () => {
    const { app } = appWith(10, 50);
    const other = await createApiKey();

    await send(app, 50);

    const theirs = await app.request('/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${other.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [event()] }),
    });

    expect(theirs.status).toBe(202);
  });

  it('counts the refusals for the installation to look at', async () => {
    const { app, refusals } = appWith(10, 50);

    await send(app, 50);
    await send(app, 10);
    await send(app, 10);

    expect(await refusals.counts([apiKey.serverId])).toEqual([
      expect.objectContaining({ serverId: apiKey.serverId, reason: 'rate_limited', requests: 2 }),
    ]);
  });
});
