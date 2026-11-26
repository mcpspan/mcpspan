import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../test/fixtures.ts';
import { createApp } from './app.ts';
import { closePool, getPool } from './db.ts';
import { deleteServer, deleteServerData } from './servers.ts';

const DAY = 24 * 60 * 60 * 1000;
const monthAgo = new Date(Date.now() - 30 * DAY);

let account: TestAccount;

/** Compresses every chunk of the table old enough for the policy, as its job would. */
async function compressOld(table: string): Promise<number> {
  const result = await getPool().query<{ n: string }>(
    `SELECT count(compress_chunk(chunk, true)) AS n FROM show_chunks($1, older_than => INTERVAL '14 days') AS chunk`,
    [table],
  );

  return Number(result.rows[0]?.n ?? 0);
}

async function storedCalls(serverId: string): Promise<number> {
  const result = await getPool().query<{ n: string }>('SELECT count(*) AS n FROM tool_calls WHERE server_id = $1', [
    serverId,
  ]);

  return Number(result.rows[0]?.n);
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();
  await seedEvents(
    account.serverId,
    Array.from({ length: 20 }, (_, i) => ({ toolName: 'search', occurredAt: new Date(monthAgo.getTime() + i * 1000) })),
  );
});

afterAll(async () => {
  await closePool();
});

describe('compressed calls', () => {
  it('are compressed after two weeks, every kind of call and the listings', async () => {
    const result = await getPool().query<{ hypertable_name: string; days: string }>(
      `SELECT hypertable_name, extract(epoch FROM (config->>'compress_after')::interval) / 86400 AS days
       FROM timescaledb_information.jobs
       WHERE proc_name = 'policy_compression'
       ORDER BY hypertable_name`,
    );

    expect(result.rows.map((row) => [row.hypertable_name, Number(row.days)])).toEqual([
      ['prompt_calls', 14],
      ['resource_calls', 14],
      ['tool_calls', 14],
      ['tool_listings', 14],
    ]);
    expect(await compressOld('tool_calls')).toBeGreaterThan(0);
    expect(await storedCalls(account.serverId)).toBe(20);
  });

  it('take a call that arrives late, once however often it is sent', async () => {
    await compressOld('tool_calls');
    const event = {
      id: randomUUID(),
      toolName: 'search',
      durationMs: 12,
      success: true,
      clientType: 'unknown',
      timestamp: new Date(monthAgo.getTime() + 60_000).toISOString(),
      sdkVersion: '0.8.2',
    };

    for (let i = 0; i < 2; i += 1) {
      const response = await createApp().request('/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [event] }),
      });
      expect(response.status).toBe(202);
    }

    expect(await storedCalls(account.serverId)).toBe(21);
  });

  it("can be deleted, a range of them or a whole server's", async () => {
    await compressOld('tool_calls');

    expect(
      await deleteServerData([account.serverId], account.serverId, {
        from: monthAgo,
        to: new Date(monthAgo.getTime() + 10_000),
      }),
    ).toBe(10);
    expect(await storedCalls(account.serverId)).toBe(10);

    expect(await deleteServer([account.serverId], account.serverId)).toBe(true);
    expect(await storedCalls(account.serverId)).toBe(0);
  });

  it('can be changed in any number, with TimescaleDB stopping no statement over how many it decompresses', async () => {
    const result = await getPool().query<{ limit: string }>(
      "SELECT current_setting('timescaledb.max_tuples_decompressed_per_dml_transaction') AS limit",
    );

    expect(result.rows[0]?.limit).toBe('0');
  });
});
