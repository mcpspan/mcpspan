import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type EventSeed, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool, getPool } from '../db.ts';
import { compare, type ReleaseReport } from '../release.ts';

let account: TestAccount;

async function get<T>(path: string, status = 200): Promise<T> {
  const response = await createApp().request(`/v1/dashboard/${path}`, {
    headers: { cookie: account.cookie },
  });

  expect(response.status).toBe(status);

  return (await response.json()) as T;
}

const HOUR = 60 * 60 * 1000;

/** The new version's first call, a day ago, so the report compares a day either side. */
const released = new Date(Date.now() - 24 * HOUR);

function at(offsetMs: number): Date {
  return new Date(released.getTime() + offsetMs);
}

/** `count` calls spread over the hours from `fromHours` to `toHours` around the release. */
function calls(count: number, fromHours: number, toHours: number, seed: EventSeed): EventSeed[] {
  return Array.from({ length: count }, (_, i) => ({
    ...seed,
    occurredAt: at((fromHours + ((toHours - fromHours) * (i + 0.5)) / count) * HOUR),
  }));
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();

  const refused = { success: false, errorSource: 'arguments', errorType: 'ValidationError' } as const;

  await seedEvents(account.serverId, [
    // Before: 1.0.0, booking refused now and then.
    ...calls(100, -20, -1, { toolName: 'search', serverVersion: '1.0.0', durationMs: 40 }),
    ...calls(57, -20, -1, { toolName: 'book', serverVersion: '1.0.0', durationMs: 100 }),
    ...calls(3, -20, -1, { toolName: 'book', serverVersion: '1.0.0', durationMs: 100, ...refused }),
    // The first call from 1.1.0 is the release.
    { toolName: 'search', serverVersion: '1.1.0', durationMs: 40, occurredAt: released },
    ...calls(99, 1, 20, { toolName: 'search', serverVersion: '1.1.0', durationMs: 40 }),
    ...calls(40, 1, 20, { toolName: 'book', serverVersion: '1.1.0', durationMs: 100 }),
    ...calls(15, 1, 20, { toolName: 'book', serverVersion: '1.1.0', durationMs: 100, ...refused }),
    ...calls(5, 1, 20, {
      toolName: 'book',
      serverVersion: '1.1.0',
      durationMs: 100,
      success: false,
      errorSource: 'result',
      errorType: 'Timeout',
    }),
    ...calls(5, 1, 20, { toolName: 'cancel', serverVersion: '1.1.0' }),
    // A replica still on the old version.
    ...calls(10, 1, 20, { toolName: 'search', serverVersion: '1.0.0', durationMs: 40 }),
  ]);

  // book's description changed with 1.1.0; search's did not.
  await getPool().query(
    `INSERT INTO tool_definitions (server_id, tool_name, hash, first_seen_at, last_seen_at) VALUES
       ($1, 'book', 'a', $2, $3), ($1, 'book', 'b', $3, now()), ($1, 'search', 's', $2, now())`,
    [account.serverId, at(-48 * HOUR), released],
  );
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/release', () => {
  it('compares the newest version with the one before it, over periods as long as each other', async () => {
    const report = await get<ReleaseReport>('release');

    expect(report.version).toBe('1.1.0');
    expect(report.previous).toBe('1.0.0');
    expect(report.releasedAt).toBe(released.toISOString());
    expect(report.before!.to).toBe(report.after.from);
    expect(new Date(report.after.to).getTime() - new Date(report.after.from).getTime()).toBe(
      new Date(report.before!.to).getTime() - new Date(report.before!.from).getTime(),
    );
    expect(report.overall.before).toMatchObject({ calls: 160, errors: 3 });
    expect(report.overall.after).toMatchObject({ calls: 165, errors: 20 });
    expect(report.verdict).toBe('worse');
    expect(report.otherVersionCalls).toBe(10);
  });

  it('puts the tools that got worse first, and says whose definition changed', async () => {
    const { tools } = await get<ReleaseReport>('release');

    expect(tools.map((tool) => [tool.toolName, tool.verdict, tool.definitionChanged])).toEqual([
      ['book', 'worse', true],
      ['cancel', 'too-early', false],
      ['search', 'same', false],
    ]);
    expect(tools[0]!.before).toMatchObject({ calls: 60, errors: 3, refused: 3 });
    expect(tools[0]!.after).toMatchObject({ calls: 60, errors: 20, refused: 15 });
    expect(tools[1]!.before).toBeNull();
  });

  it('names the kinds of failure the previous version did not have', async () => {
    const { newFailures } = await get<ReleaseReport>('release');

    expect(newFailures).toEqual([
      { toolName: 'book', errorSource: 'result', errorType: 'Timeout', calls: 5, firstAt: expect.any(String) },
    ]);
  });

  it('says what became of sessions, and how the clients split, either side', async () => {
    const report = await get<ReleaseReport>('release');

    expect(report.agents.before).not.toBeNull();
    expect(report.agents.after).toBeDefined();
    expect(report.clients).toEqual([{ clientType: 'claude', before: 1, after: 1 }]);
    expect(report.clientsShifted).toBe(false);
  });

  it('reports an older version up to the one that replaced it, and the first one without a verdict', async () => {
    const report = await get<ReleaseReport>('release?version=1.0.0');

    expect(report.previous).toBeNull();
    expect(report.before).toBeNull();
    expect(report.verdict).toBe('first');
    expect(report.after.to).toBe(released.toISOString());
    expect(report.tools).toEqual([]);
  });

  it('narrows to one client', async () => {
    const report = await get<ReleaseReport>('release?clientType=cursor');

    expect(report.overall.after.calls).toBe(0);
    expect(report.verdict).toBe('too-early');
  });

  it('says so when the version is not known', async () => {
    const { error } = await get<{ error: string }>('release?version=9.9.9', 404);

    expect(error).toBe('No version 9.9.9 on this server');
  });
});

describe('compare', () => {
  const side = (calls: number, errors: number, p95: number) => ({
    calls,
    errors,
    errorRate: errors / calls,
    durationMs: { p50: p95 / 2, p95 },
  });

  it('gives no verdict on too few calls', () => {
    expect(compare(side(40, 0, 100), side(1000, 500, 100), 50)).toBe('too-early');
  });

  it('calls a rise in errors chance when it could be', () => {
    expect(compare(side(100, 2, 100), side(100, 4, 100), 50)).toBe('same');
  });

  it('calls a clear rise in errors worse, and a fall better', () => {
    expect(compare(side(1000, 10, 100), side(1000, 50, 100), 50)).toBe('worse');
    expect(compare(side(1000, 50, 100), side(1000, 10, 100), 50)).toBe('better');
  });

  it('calls the slowest calls a quarter slower worse, but not a few milliseconds', () => {
    expect(compare(side(1000, 10, 400), side(1000, 10, 600), 50)).toBe('worse');
    expect(compare(side(1000, 10, 40), side(1000, 10, 60), 50)).toBe('same');
  });
});
