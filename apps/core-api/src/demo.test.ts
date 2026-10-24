import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../test/fixtures.ts';
import { createApp } from './app.ts';
import { closePool, getPool } from './db.ts';
import { DEMO_READS_PER_MINUTE, demoOnly } from './demo.ts';

let account: TestAccount;
let clock = 0;
let demo: ReturnType<typeof demoOnly>;

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount({ serverName: 'Flights' });
  await seedEvents(account.serverId, [{ occurredAt: new Date(Date.now() - 10 * 60 * 1000) }]);
  clock = Date.now();
  demo = demoOnly(createApp(), () => clock);
});

afterAll(async () => {
  await closePool();
});

describe('a public demo', () => {
  it('shows the demo account to a visitor with no session', async () => {
    const servers = await demo.request('/v1/servers');
    const summary = await demo.request('/v1/dashboard/summary');

    expect(servers.status).toBe(200);
    expect(((await servers.json()) as { servers: { name: string }[] }).servers.map((s) => s.name)).toEqual(['Flights']);
    expect(((await summary.json()) as { totalCalls: number }).totalCalls).toBe(1);
  });

  it('reads as the demo account whatever credential came along, so any read token works', async () => {
    for (const headers of [
      { authorization: 'Bearer demo' } as Record<string, string>,
      { authorization: 'Bearer mcpspan_read_whatever' },
      { cookie: 'mcpspan_session=stale' },
    ]) {
      expect((await demo.request('/v1/dashboard/summary', { headers })).status).toBe(200);
    }
  });

  it('opens what a token never could, for reading: the account is sample data', async () => {
    expect((await demo.request('/v1/alerts')).status).toBe(200);
  });

  it('changes nothing', async () => {
    const attempts: [string, string][] = [
      ['POST', '/v1/servers'],
      ['DELETE', `/v1/servers/${account.serverId}`],
      ['POST', `/v1/servers/${account.serverId}/key`],
      ['POST', `/v1/servers/${account.serverId}/data/delete`],
      ['POST', `/v1/servers/${account.serverId}/badge`],
      ['POST', '/v1/tokens'],
      ['PUT', '/v1/alerts/webhook'],
      ['POST', '/v1/auth/login'],
      ['POST', '/v1/auth/register'],
      ['POST', '/v1/auth/password'],
      ['POST', '/v1/auth/logout'],
    ];

    for (const [method, path] of attempts) {
      const response = await demo.request(path, {
        method,
        headers: { cookie: account.cookie, 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status, `${method} ${path}`).toBe(403);
      expect(((await response.json()) as { error: string }).error).toContain('live demo');
    }

    const servers = await getPool().query('SELECT count(*)::int AS n FROM servers');
    expect(servers.rows[0]?.n).toBe(1);
  });

  it('still takes events, which is how the sample data keeps coming', async () => {
    const response = await demo.request('/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            id: crypto.randomUUID(),
            toolName: 'search_flights',
            durationMs: 12,
            success: true,
            clientType: 'claude',
            timestamp: new Date().toISOString(),
            sdkVersion: '0.8.1',
          },
        ],
      }),
    });

    expect(response.status).toBe(202);
  });

  it('limits each visitor from outside, and never its own dashboard', async () => {
    const outside = { 'cf-connecting-ip': '203.0.113.7' };

    for (let i = 0; i < DEMO_READS_PER_MINUTE; i++) {
      expect((await demo.request('/health', { headers: outside })).status).toBe(200);
    }

    const over = await demo.request('/health', { headers: outside });

    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('60');
    expect((await demo.request('/health', { headers: { 'cf-connecting-ip': '203.0.113.8' } })).status).toBe(200);
    expect((await demo.request('/health')).status).toBe(200);

    clock += 60_000;
    expect((await demo.request('/health', { headers: outside })).status).toBe(200);
  });

  it('keeps one session for every visitor, and renews it before it runs out', async () => {
    await demo.request('/v1/servers');
    await demo.request('/v1/servers');

    const count = async () =>
      ((await getPool().query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [account.userId])).rows[0]
        ?.n as number);
    const before = await count();

    clock += 30 * 24 * 60 * 60 * 1000;
    await demo.request('/v1/servers');

    expect(await count()).toBe(before + 1);
  });

  it('says so when there is no account to show yet', async () => {
    await resetDatabase();

    expect((await demoOnly(createApp()).request('/v1/servers')).status).toBe(503);
  });
});
