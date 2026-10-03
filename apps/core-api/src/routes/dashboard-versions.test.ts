import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool, getPool } from '../db.ts';

let account: TestAccount;

async function get<T>(path: string): Promise<T> {
  const response = await createApp().request(`/v1/dashboard/${path}`, { headers: { cookie: account.cookie } });
  expect(response.status).toBe(200);

  return (await response.json()) as T;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

interface Versions {
  versions: {
    version: string;
    firstSeenAt: string;
    calls: number;
    errors: number;
    durationMs: { p50: number | null; p95: number | null };
  }[];
  unversionedCalls: number;
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();
  await seedEvents(account.serverId, [
    // 1.3.0 has been running for days; 1.4.0 arrived six hours ago and is slower.
    { toolName: 'search', serverVersion: '1.3.0', occurredAt: hoursAgo(72), durationMs: 10 },
    { toolName: 'search', serverVersion: '1.3.0', occurredAt: hoursAgo(10), durationMs: 10 },
    { toolName: 'search', serverVersion: '1.3.0', occurredAt: hoursAgo(8), durationMs: 20 },
    { toolName: 'search', serverVersion: '1.4.0', occurredAt: hoursAgo(6), durationMs: 100 },
    { toolName: 'search', serverVersion: '1.4.0', occurredAt: hoursAgo(4), durationMs: 300, success: false, errorSource: 'exception' },
    { toolName: 'book', serverVersion: '1.4.0', occurredAt: hoursAgo(2), durationMs: 200 },
    // From an SDK that reports no version.
    { toolName: 'search', occurredAt: hoursAgo(1) },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/versions', () => {
  it('compares the versions in the window, newest first, and counts calls with none', async () => {
    const { versions, unversionedCalls } = await get<Versions>('versions');

    expect(versions.map((v) => [v.version, v.calls, v.errors])).toEqual([
      ['1.4.0', 3, 1],
      ['1.3.0', 2, 0],
    ]);
    expect(versions[0]?.durationMs.p50).toBe(200);
    expect(unversionedCalls).toBe(1);
  });

  it('says when a version was first seen ever, not only in the window', async () => {
    const { versions } = await get<Versions>('versions');
    const old = versions.find((v) => v.version === '1.3.0');

    expect(Date.parse(old?.firstSeenAt ?? '')).toBeLessThan(hoursAgo(48).getTime());
  });

  it('narrows with the filters the rest of the page uses', async () => {
    const { versions } = await get<Versions>('versions?toolName=book');

    expect(versions.map((v) => [v.version, v.calls])).toEqual([['1.4.0', 1]]);
  });
});

describe('versions on calls', () => {
  it('lists and narrows calls by the version that answered them', async () => {
    const { calls } = await get<{ calls: { toolName: string; serverVersion: string | null }[] }>(
      'calls?serverVersion=1.4.0',
    );

    expect(calls.map((call) => call.toolName)).toEqual(['book', 'search', 'search']);
    expect(calls.every((call) => call.serverVersion === '1.4.0')).toBe(true);
  });
});

describe('versions at ingest', () => {
  it('stores both versions and notes when each server version was seen, even from a resent batch', async () => {
    const at = new Date().toISOString();
    const event = {
      id: randomUUID(),
      toolName: 'search',
      durationMs: 1,
      success: true,
      clientType: 'claude',
      timestamp: at,
      sdkVersion: '0.1.0',
      serverVersion: '2.0.0',
      clientVersion: '1.2.3',
    };
    const post = () =>
      createApp().request('/v1/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.key}` },
        body: JSON.stringify({ events: [event] }),
      });

    await getPool().query('DELETE FROM server_versions');
    expect((await post()).status).toBe(202);
    await getPool().query('DELETE FROM server_versions');
    // The same batch again, as an SDK resends one whose answer it missed: nothing new is stored, and the version is still noted.
    expect((await post()).status).toBe(202);

    const call = await get<{ call: { serverVersion: string; clientVersion: string } }>(`calls/${event.id}`);
    expect(call.call).toMatchObject({ serverVersion: '2.0.0', clientVersion: '1.2.3' });
    const noted = await getPool().query('SELECT version FROM server_versions WHERE server_id = $1', [account.serverId]);
    expect(noted.rows.map((row: { version: string }) => row.version)).toEqual(['2.0.0']);
  });
});
