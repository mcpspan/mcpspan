import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { clearBadgeCache, describe as describeBadge } from '../badges.ts';
import { closePool } from '../db.ts';

let account: TestAccount;

const app = () => createApp();

async function enable(owner: TestAccount = account): Promise<string> {
  const response = await app().request(`/v1/servers/${owner.serverId}/badge`, {
    method: 'POST',
    headers: { cookie: owner.cookie },
  });

  expect(response.status).toBe(200);

  return ((await response.json()) as { badgeId: string }).badgeId;
}

async function json(badgeId: string, metric: string): Promise<{ message: string; color: string }> {
  return (await (await app().request(`/badge/${badgeId}/${metric}.json`)).json()) as { message: string; color: string };
}

beforeEach(async () => {
  await resetDatabase();
  clearBadgeCache();
  account = await createAccount({ serverName: 'Flights' });

  const ago = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

  await seedEvents(account.serverId, [
    ...Array.from({ length: 9 }, (_, i) => ({ occurredAt: ago(i + 1), durationMs: 200 })),
    { occurredAt: ago(30), success: false, errorSource: 'exception', durationMs: 200 },
    // Older than a week: not counted.
    { occurredAt: ago(24 * 8) },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('a public badge', () => {
  it("shows the last week's figures once switched on", async () => {
    const badgeId = await enable();

    expect(await json(badgeId, 'calls')).toMatchObject({ message: '10 calls/week' });
    expect(await json(badgeId, 'success')).toMatchObject({ message: '90.0% success', color: '#dfb317' });
    expect((await json(badgeId, 'latency')).message).toMatch(/^p50 \d+ ms$/);
  });

  it('is an image a README can show, kept for five minutes', async () => {
    const badgeId = await enable();
    const response = await app().request(`/badge/${badgeId}/calls.svg`);
    const svg = await response.text();

    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(svg).toContain('<svg');
    expect(svg).toContain('mcpspan');
    expect(svg).toContain('10 calls/week');
    expect(svg).toContain("Reported by this server's own mcpspan");
    expect(svg).not.toContain('erified');
  });

  it('says "no data" for an address nobody has, without failing', async () => {
    for (const badgeId of ['AAAAAAAAAAAAAAAAAAAAAA', 'short', '<script>']) {
      const response = await app().request(`/badge/${encodeURIComponent(badgeId)}/calls.svg`);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('no data');
    }
  });

  it('stops at once when switched off, and at its old address when moved', async () => {
    const first = await enable();
    await json(first, 'calls');

    const second = await enable();

    expect(second).not.toBe(first);
    expect((await json(first, 'calls')).message).toBe('no data');
    expect((await json(second, 'calls')).message).toBe('10 calls/week');

    const off = await app().request(`/v1/servers/${account.serverId}/badge`, {
      method: 'DELETE',
      headers: { cookie: account.cookie },
    });

    expect(off.status).toBe(204);
    expect((await json(second, 'calls')).message).toBe('no data');
  });

  it('is in the server list while on', async () => {
    const badgeId = await enable();
    const listed = (await (
      await app().request('/v1/servers', { headers: { cookie: account.cookie } })
    ).json()) as { servers: { badgeId: string | null }[] };

    expect(listed.servers[0]?.badgeId).toBe(badgeId);
  });

  it("cannot be switched on for somebody else's server, or with a read token", async () => {
    const other = await createAccount();
    const theirs = await app().request(`/v1/servers/${account.serverId}/badge`, {
      method: 'POST',
      headers: { cookie: other.cookie },
    });

    expect(theirs.status).toBe(404);

    const made = await app().request('/v1/tokens', {
      method: 'POST',
      headers: { cookie: account.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Agent' }),
    });
    const { token } = (await made.json()) as { token: string };
    const byToken = await app().request(`/v1/servers/${account.serverId}/badge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(byToken.status).toBe(403);
  });

  it('names only calls, success and latency', async () => {
    const badgeId = await enable();

    expect((await app().request(`/badge/${badgeId}/errors.svg`)).status).toBe(404);
    expect((await app().request(`/badge/${badgeId}/calls.png`)).status).toBe(404);
  });
});

describe('what a badge says', () => {
  it.each([
    ['calls', 0, 0, null, '0 calls/week'],
    ['success', 0, 0, null, 'no calls yet'],
    ['calls', 999, 0, null, '999 calls/week'],
    ['calls', 12_400, 0, null, '12.4k calls/week'],
    ['calls', 250_000, 0, null, '250k calls/week'],
    ['calls', 3_000_000, 0, null, '3M calls/week'],
    ['success', 100, 0, null, '100% success'],
    ['success', 100_000, 0.00001, null, '99.9% success'],
    ['success', 100, 0.25, null, '75.0% success'],
    ['latency', 10, 0, 182.4, 'p50 182 ms'],
    ['latency', 10, 0, 1250, 'p50 1.3 s'],
  ] as const)('%s with %d calls, rate %d, p50 %s: %s', (metric, calls, rate, p50, message) => {
    expect(describeBadge(metric, calls, rate, p50).message).toBe(message);
  });
});
