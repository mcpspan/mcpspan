import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';
import { getLostAgents } from '../sessions.ts';

let account: TestAccount;

async function get<T>(path: string, status = 200): Promise<T> {
  const response = await createApp().request(`/v1/dashboard/${path}`, {
    headers: { cookie: account.cookie },
  });

  expect(response.status).toBe(status);

  return (await response.json()) as T;
}

/** Seconds ago, so calls within a session keep a clear order. */
function ago(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

interface Lost {
  sessions: Record<string, number>;
  tools: {
    toolName: string;
    failures: number;
    recovered: number;
    meanRetries: number | null;
    wentElsewhere: number;
    insteadMostOften: { name: string; kind: string; times: number } | null;
    endedOnIt: number;
    looped: number;
    undecided: number;
  }[];
  sampled: boolean;
  hasMore: boolean;
}

const refused = { success: false, errorSource: 'arguments' } as const;

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();

  const [retried, gaveUpOnBooking, looping, clean, recent, missing, twice] = Array.from({ length: 7 }, () =>
    randomUUID(),
  );

  await seedEvents(account.serverId, [
    // Refused twice, the second time with the same arguments, then right.
    { sessionId: retried, toolName: 'book', ...refused, occurredAt: ago(7200), clientType: 'claude-code' },
    { sessionId: retried, toolName: 'book', ...refused, repeated: true, occurredAt: ago(7190), clientType: 'claude-code' },
    { sessionId: retried, toolName: 'book', occurredAt: ago(7180), clientType: 'claude-code' },
    { sessionId: retried, toolName: 'search', occurredAt: ago(7170), clientType: 'claude-code' },

    // Refused, then searched instead, and carried on from there.
    { sessionId: gaveUpOnBooking, toolName: 'book', ...refused, occurredAt: ago(7000), clientType: 'cursor' },
    { sessionId: gaveUpOnBooking, toolName: 'search', occurredAt: ago(6990), clientType: 'cursor' },

    // Failed, asked again with the same arguments, and stopped there.
    { sessionId: looping, toolName: 'check_in', success: false, errorSource: 'result', occurredAt: ago(6000) },
    { sessionId: looping, toolName: 'check_in', success: false, errorSource: 'result', repeated: true, occurredAt: ago(5990) },

    { sessionId: clean, toolName: 'search', occurredAt: ago(5000) },

    // A minute ago: whatever comes of it has not come yet.
    { sessionId: recent, toolName: 'book', ...refused, occurredAt: ago(60) },

    // A name the server does not have, then the one it does.
    { sessionId: missing, toolName: 'searchFlights', success: false, errorSource: 'unknown_tool', occurredAt: ago(4000) },
    { sessionId: missing, toolName: 'search', occurredAt: ago(3990) },

    // Stuck twice on the same tool: once put right, then left.
    { sessionId: twice, toolName: 'book', ...refused, occurredAt: ago(3000) },
    { sessionId: twice, toolName: 'book', occurredAt: ago(2990) },
    { sessionId: twice, toolName: 'book', ...refused, occurredAt: ago(2980) },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/lost', () => {
  it('says what became of each session, by the worst that happened in it', async () => {
    const { sessions, sampled } = await get<Lost>('lost');

    expect(sessions).toEqual({
      clean: 1,
      recovered: 1,
      wentElsewhere: 2,
      looped: 0,
      endedOnFailure: 2,
      undecided: 1,
    });
    expect(sampled).toBe(false);
  });

  it('counts a failure and the retries straight after it as one time stuck, and says what came of it', async () => {
    const { tools } = await get<Lost>('lost');

    expect(tools).toEqual([
      {
        toolName: 'book',
        failures: 5,
        recovered: 2,
        // Two retries once, one the other time.
        meanRetries: 1.5,
        wentElsewhere: 1,
        insteadMostOften: { name: 'search', kind: 'tool', times: 1 },
        endedOnIt: 1,
        looped: 1,
        undecided: 1,
      },
      {
        toolName: 'check_in',
        failures: 1,
        recovered: 0,
        meanRetries: null,
        wentElsewhere: 0,
        insteadMostOften: null,
        endedOnIt: 1,
        looped: 1,
        undecided: 0,
      },
    ]);
  });

  it('leaves names the server does not have to their own view', async () => {
    const { tools } = await get<Lost>('lost');

    expect(tools.map((tool) => tool.toolName)).not.toContain('searchFlights');
  });

  it('ranks first the tools sessions ended on or looped at', async () => {
    const lost = randomUUID();
    // Three sessions stopped on a failure of a tool that otherwise fails little.
    await seedEvents(
      account.serverId,
      [1, 2, 3].map((n) => ({
        sessionId: n === 1 ? lost : randomUUID(),
        toolName: 'pay',
        success: false,
        errorSource: 'exception',
        occurredAt: ago(9000 + n),
      })),
    );

    const { tools } = await get<Lost>('lost');

    expect(tools.map((tool) => tool.toolName)).toEqual(['pay', 'book', 'check_in']);
  });

  it("narrows to a client's sessions, and to one tool", async () => {
    const cursor = await get<Lost>('lost?clientType=cursor');

    expect(cursor.sessions).toEqual({
      clean: 0,
      recovered: 0,
      wentElsewhere: 1,
      looped: 0,
      endedOnFailure: 0,
      undecided: 0,
    });
    expect(cursor.tools).toEqual([expect.objectContaining({ toolName: 'book', failures: 1, wentElsewhere: 1 })]);

    const checkIn = await get<Lost>('lost?toolName=check_in');

    expect(checkIn.tools.map((tool) => tool.toolName)).toEqual(['check_in']);
  });

  it('pages the tools', async () => {
    const first = await get<Lost>('lost?limit=1');
    const second = await get<Lost>('lost?limit=1&offset=1');

    expect(first.tools.map((tool) => tool.toolName)).toEqual(['book']);
    expect(first.hasMore).toBe(true);
    expect(second.tools.map((tool) => tool.toolName)).toEqual(['check_in']);
    expect(second.hasMore).toBe(false);
  });

  it('never reads a session as ended when the window was cut right after its failure', async () => {
    // The window ends a second after the last call of the session stuck twice.
    const to = new Date(ago(2979).getTime());
    const from = new Date(to.getTime() - 3_600_000);

    const { tools } = await getLostAgents(account.serverId, { from, to });

    expect(tools.find((tool) => tool.toolName === 'book')).toEqual(
      expect.objectContaining({ failures: 2, recovered: 1, endedOnIt: 0, undecided: 1 }),
    );
  });

  it('says when it read only the newest calls', async () => {
    const range = { from: ago(86_400), to: new Date() };

    expect((await getLostAgents(account.serverId, range, 15)).sampled).toBe(false);
    expect((await getLostAgents(account.serverId, range, 14)).sampled).toBe(true);
  });
});
