import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiKey, resetDatabase } from '../test/fixtures.ts';
import { closePool, getPool } from './db.ts';
import { RefusalLog } from './refusals.ts';

async function storedRows(): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    'SELECT count(*) AS count FROM ingest_refusals',
  );

  return Number(result.rows[0]?.count);
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('RefusalLog', () => {
  it('reports what it counted before anything is flushed', async () => {
    // The view has to be current to the request. Somebody who just fixed a key
    // and looks again should not be reading a figure from ten seconds ago.
    const { serverId } = await createApiKey();
    const log = new RefusalLog();

    log.record('revoked_key', serverId);
    log.record('revoked_key', serverId);

    expect(await log.counts([serverId])).toEqual([
      expect.objectContaining({ serverId, reason: 'revoked_key', requests: 2 }),
    ]);
    expect(await storedRows()).toBe(0);
  });

  it('adds to the stored totals rather than replacing them', async () => {
    const { serverId } = await createApiKey();
    const log = new RefusalLog();

    log.record('rate_limited', serverId);
    await log.flush();
    log.record('rate_limited', serverId);
    log.record('rate_limited', serverId);
    await log.flush();

    expect(await log.counts([serverId])).toEqual([
      expect.objectContaining({ reason: 'rate_limited', requests: 3 }),
    ]);
  });

  it('merges stored and unflushed counts into one line', async () => {
    const { serverId } = await createApiKey();
    const log = new RefusalLog();

    log.record('invalid_batch', serverId);
    await log.flush();
    log.record('invalid_batch', serverId);

    expect(await log.counts([serverId])).toEqual([
      expect.objectContaining({ reason: 'invalid_batch', requests: 2 }),
    ]);
  });

  it('keeps one row per reason for requests that named no server', async () => {
    // Anybody can send a made-up key. However many do, it is one counter,
    // not one row per attempt.
    const log = new RefusalLog();

    for (let flush = 0; flush < 3; flush += 1) {
      log.record('unknown_key');
      await log.flush();
    }

    expect(await storedRows()).toBe(1);
    expect(await log.counts([])).toEqual([
      expect.objectContaining({ serverId: null, reason: 'unknown_key', requests: 3 }),
    ]);
  });

  it('drops counts for a server deleted before they were written, and keeps the rest', async () => {
    const gone = await createApiKey();
    const kept = await createApiKey();
    const log = new RefusalLog();

    log.record('revoked_key', gone.serverId);
    log.record('revoked_key', kept.serverId);
    await getPool().query('DELETE FROM servers WHERE id = $1', [gone.serverId]);

    await log.flush();

    // The deleted server's count cannot be written anywhere, and retrying it
    // forever would hold every other count up behind it.
    expect(await storedRows()).toBe(1);
    expect(await log.counts([kept.serverId])).toEqual([
      expect.objectContaining({ serverId: kept.serverId, requests: 1 }),
    ]);
  });

  it('only answers about the servers it is asked about', async () => {
    const mine = await createApiKey();
    const theirs = await createApiKey();
    const log = new RefusalLog();

    log.record('revoked_key', mine.serverId);
    log.record('revoked_key', theirs.serverId);
    await log.flush();
    log.record('rate_limited', theirs.serverId);

    const counts = await log.counts([mine.serverId]);

    expect(counts.map((count) => count.serverId)).toEqual([mine.serverId]);
  });

  it('newest first, since the latest refusal is the one that explains the present', async () => {
    let clock = Date.parse('2026-09-01T10:00:00Z');
    const { serverId } = await createApiKey();
    const log = new RefusalLog(() => new Date(clock));

    log.record('rate_limited', serverId);
    clock += 60_000;
    log.record('revoked_key', serverId);

    expect((await log.counts([serverId])).map((count) => count.reason)).toEqual([
      'revoked_key',
      'rate_limited',
    ]);
  });
});
