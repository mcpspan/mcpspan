import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

let account: TestAccount;

interface Distribution {
  totalCalls: number;
  buckets: { fromMs: number; toMs: number | null; calls: number }[];
}

async function get(path: string): Promise<Distribution> {
  const response = await createApp().request(`/v1/dashboard/${path}`, {
    headers: { cookie: account.cookie },
  });

  expect(response.status).toBe(200);

  return (await response.json()) as Distribution;
}

function ago(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/latency', () => {
  it('shows two humps where there are two, which a median would hide', async () => {
    // Seventy calls from a cache near 15 ms, thirty over the network near
    // 400 ms, half of them hours ago so the rollup is read as well.
    const seeds = [
      ...Array.from({ length: 70 }, (_, i) => ({ durationMs: 13 + (i % 5), toolName: 'search' })),
      ...Array.from({ length: 30 }, (_, i) => ({ durationMs: 350 + i * 3, toolName: 'search' })),
    ].map((seed, i) => ({ ...seed, occurredAt: i % 2 === 0 ? ago(180) : ago(5) }));
    await seedEvents(account.serverId, seeds);

    const { totalCalls, buckets } = await get('latency');
    const counts = buckets.map((bucket) => bucket.calls);
    const peaks = counts.filter(
      (count, i) => count > 0 && count >= (counts[i - 1] ?? 0) && count > (counts[i + 1] ?? 0),
    );

    expect(totalCalls).toBe(100);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(100);
    expect(peaks).toHaveLength(2);

    const between = buckets.filter((b) => b.fromMs >= 30 && (b.toMs ?? Infinity) <= 250);
    expect(between.every((b) => b.calls === 0)).toBe(true);
  });

  it('keeps calls slower than the last step, in a bucket with no upper bound', async () => {
    await seedEvents(account.serverId, [{ durationMs: 25_000 }, { durationMs: 5 }]);

    const { buckets } = await get('latency');

    expect(buckets.at(-1)).toEqual({ fromMs: 10_000, toMs: null, calls: 1 });
    expect(buckets[0]).toEqual({ fromMs: 0, toMs: 1, calls: 0 });
  });

  it('narrows to one tool with the usual filter', async () => {
    await seedEvents(account.serverId, [
      { toolName: 'search', durationMs: 10 },
      { toolName: 'book', durationMs: 900 },
    ]);

    const { totalCalls, buckets } = await get('latency?toolName=book');

    expect(totalCalls).toBe(1);
    expect(buckets.find((b) => b.calls > 0)).toMatchObject({ fromMs: 600, toMs: 1000 });
  });

  it('answers an empty window with empty buckets, not an error', async () => {
    const { totalCalls, buckets } = await get('latency');

    expect(totalCalls).toBe(0);
    expect(buckets.every((b) => b.calls === 0)).toBe(true);
  });
});
