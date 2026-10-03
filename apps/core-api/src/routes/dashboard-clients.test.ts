import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

let account: TestAccount;

interface Clients {
  bucketSeconds: number;
  times: string[];
  clients: {
    clientType: string;
    calls: number;
    firstSeenAt: string;
    lastSeenAt: string;
    points: number[];
  }[];
}

async function get<T>(path: string): Promise<T> {
  const response = await createApp().request(`/v1/dashboard/${path}`, {
    headers: { cookie: account.cookie },
  });

  expect(response.status).toBe(200);

  return (await response.json()) as T;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();

  await seedEvents(account.serverId, [
    // Claude has used this server for days and still does.
    { clientType: 'claude-code', occurredAt: hoursAgo(72) },
    { clientType: 'claude-code', occurredAt: hoursAgo(20) },
    { clientType: 'claude-code', occurredAt: hoursAgo(1) },
    // Cursor turned up two hours ago.
    { clientType: 'cursor', occurredAt: hoursAgo(2) },
    { clientType: 'cursor', occurredAt: hoursAgo(1) },
    // ChatGPT called once, a day ago, and has not been back.
    { clientType: 'chatgpt', occurredAt: hoursAgo(20) },
    // Something that only ever asked for a tool this server does not have.
    { clientType: 'other', success: false, errorSource: 'unknown_tool', occurredAt: hoursAgo(1) },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/clients', () => {
  it('gives each client its calls, bucket by bucket, on the same axis as the chart', async () => {
    const clients = await get<Clients>('clients');
    const timeseries = await get<{ points: { time: string }[] }>('timeseries');

    expect(clients.times).toEqual(timeseries.points.map((point) => point.time));
    expect(clients.clients.map((client) => [client.clientType, client.calls])).toEqual([
      ['claude-code', 2],
      ['cursor', 2],
      ['chatgpt', 1],
    ]);

    for (const client of clients.clients) {
      expect(client.points).toHaveLength(clients.times.length);
      expect(client.points.reduce((sum, value) => sum + value, 0)).toBe(client.calls);
    }
  });

  it('agrees with the summary on who called and how much', async () => {
    const { clients } = await get<Clients>('clients');
    const summary = await get<{ clients: { clientType: string; calls: number }[] }>('summary');

    expect(clients.map(({ clientType, calls }) => ({ clientType, calls }))).toEqual(
      summary.clients,
    );
  });

  it('knows a client is new to the server, not just to the window', async () => {
    const { clients } = await get<Clients>('clients');
    const byType = new Map(clients.map((client) => [client.clientType, client]));
    const windowStart = hoursAgo(24).getTime();

    expect(Date.parse(byType.get('claude-code')?.firstSeenAt ?? '')).toBeLessThan(windowStart);
    expect(Date.parse(byType.get('cursor')?.firstSeenAt ?? '')).toBeGreaterThan(windowStart);
  });

  it('knows when a client was last seen', async () => {
    const { clients } = await get<Clients>('clients');
    const chatgpt = clients.find((client) => client.clientType === 'chatgpt');

    expect(Date.parse(chatgpt?.lastSeenAt ?? '')).toBeLessThan(hoursAgo(19).getTime());
    expect(chatgpt?.points.at(-1)).toBe(0);
  });

  it('leaves out a client that only asked for tools that do not exist', async () => {
    const { clients } = await get<Clients>('clients');

    expect(clients.map((client) => client.clientType)).not.toContain('other');
  });
});
