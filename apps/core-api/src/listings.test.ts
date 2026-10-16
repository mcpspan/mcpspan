import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, createApiKey, resetDatabase, type TestApiKey } from '../test/fixtures.ts';
import { createApp } from './app.ts';
import { closePool, getPool } from './db.ts';
import { getToolListing } from './listings.ts';

let apiKey: TestApiKey;

beforeEach(async () => {
  await resetDatabase();
  apiKey = await createApiKey();
});

afterAll(async () => {
  await closePool();
});

const NOW = Date.now();
const range = { from: new Date(NOW - 24 * 60 * 60 * 1000), to: new Date(NOW + 60 * 1000) };

function at(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60 * 1000).toISOString();
}

function listing(sessionId: string | undefined, tools: [string, number][], minutesAgo = 10): Record<string, unknown> {
  return {
    id: randomUUID(),
    kind: 'listing',
    toolName: 'tools/list',
    durationMs: 0,
    success: true,
    clientType: 'unknown',
    clientName: 'cursor-vscode',
    timestamp: at(minutesAgo),
    sdkVersion: '0.7.0',
    ...(sessionId !== undefined && { sessionId }),
    listedTools: tools.map(([name, bytes]) => ({ name, definitionHash: `${name}-hash`, definitionBytes: bytes })),
  };
}

function call(sessionId: string | undefined, toolName: string): Record<string, unknown> {
  return {
    id: randomUUID(),
    toolName,
    durationMs: 5,
    success: true,
    clientType: 'unknown',
    clientName: 'cursor-vscode',
    timestamp: at(5),
    sdkVersion: '0.7.0',
    ...(sessionId !== undefined && { sessionId }),
  };
}

async function post(events: Record<string, unknown>[]): Promise<{ accepted: number; stored: number }> {
  const response = await createApp().request('/v1/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.key}` },
    body: JSON.stringify({ events }),
  });
  expect(response.status).toBe(202);
  return (await response.json()) as { accepted: number; stored: number };
}

describe('listings (contract, 3.11)', () => {
  it('orders by size or name, and pages', async () => {
    await post([listing(randomUUID(), [['b_small', 100], ['a_large', 900], ['c_middle', 500]])]);

    const largest = await getToolListing(apiKey.serverId, range, undefined, { order: 'largest', offset: 0, limit: 2 });
    expect(largest.tools.map((tool) => tool.name)).toEqual(['a_large', 'c_middle']);
    expect(largest).toMatchObject({ total: 3, hasMore: true, neverUsed: 3 });

    const byName = await getToolListing(apiKey.serverId, range, undefined, { order: 'name', offset: 2, limit: 2 });
    expect(byName.tools.map((tool) => tool.name)).toEqual(['c_middle']);
    expect(byName.hasMore).toBe(false);
  });

  it('refuses an order it does not know', async () => {
    const account = await createAccount();
    const response = await createApp().request(`/v1/dashboard/listing?listingOrder=random&serverId=${account.serverId}`, {
      headers: { cookie: account.cookie },
    });
    expect(response.status).toBe(400);
  });

  it('counts the sessions shown each tool and those of them that called it, the least used first', async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const tools: [string, number][] = [
      ['search_flights', 900],
      ['book_flight', 400],
      ['export_report', 1200],
    ];
    await post([
      listing(a, tools, 30),
      listing(b, tools, 20),
      listing(c, tools.slice(0, 2), 10),
      call(a, 'search_flights'),
      call(a, 'search_flights'),
      call(b, 'search_flights'),
      call(b, 'book_flight'),
      // A call with no session counts as a call, not as a session that used the tool.
      call(undefined, 'book_flight'),
    ]);

    const result = await getToolListing(apiKey.serverId, range);

    expect(result.sessions).toBe(3);
    expect(result.latest).toMatchObject({ tools: 2, bytes: 1300 });
    // export_report is no longer listed, so it is not counted as never used.
    expect(result).toMatchObject({ neverUsed: 0, total: 3, offset: 0, hasMore: false });
    expect(result.tools).toEqual([
      { name: 'export_report', sessions: 2, usedSessions: 0, calls: 0, bytes: 1200, listed: false },
      { name: 'book_flight', sessions: 3, usedSessions: 1, calls: 2, bytes: 400, listed: true },
      { name: 'search_flights', sessions: 3, usedSessions: 2, calls: 3, bytes: 900, listed: true },
    ]);
  });

  it('stores a redelivered listing once, and keeps no definition text', async () => {
    const event = listing(randomUUID(), [['search_flights', 900]]);

    expect(await post([event])).toEqual({ accepted: 1, stored: 1 });
    expect(await post([event])).toEqual({ accepted: 1, stored: 0 });

    const rows = await getPool().query('SELECT tool_names, definition_hashes, definition_bytes, client_type FROM tool_listings');
    expect(rows.rows).toEqual([
      { tool_names: ['search_flights'], definition_hashes: ['search_flights-hash'], definition_bytes: [900], client_type: 'cursor' },
    ]);
  });

  it('knows the definition of a tool listed and never called', async () => {
    await post([listing(randomUUID(), [['export_report', 1200]])]);

    const definitions = await getPool().query('SELECT tool_name, hash FROM tool_definitions');
    expect(definitions.rows).toEqual([{ tool_name: 'export_report', hash: 'export_report-hash' }]);
  });

  it('narrows to one client', async () => {
    await post([listing(randomUUID(), [['search_flights', 900]])]);

    expect((await getToolListing(apiKey.serverId, range, 'cursor')).sessions).toBe(1);
    expect(await getToolListing(apiKey.serverId, range, 'claude')).toMatchObject({ sessions: 0, latest: null, total: 0, tools: [] });
  });
});
