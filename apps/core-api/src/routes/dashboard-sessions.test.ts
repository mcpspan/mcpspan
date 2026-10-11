import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';
import { getSessions, getTransitions } from '../sessions.ts';

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

interface Transition {
  from: string | null;
  fromKind?: string | null;
  to: string;
  toKind?: string;
  calls: number;
  afterFailure: number;
}

const first = randomUUID();
const second = randomUUID();

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();

  // One agent searches, books, and books again after the booking failed.
  // Another searches, pages the list twice, then books.
  await seedEvents(account.serverId, [
    { sessionId: first, toolName: 'search', occurredAt: ago(600), clientType: 'claude-code' },
    {
      sessionId: first,
      toolName: 'book',
      success: false,
      errorSource: 'arguments',
      occurredAt: ago(590),
      clientType: 'claude-code',
    },
    { sessionId: first, toolName: 'book', occurredAt: ago(580), clientType: 'claude-code' },
    { sessionId: second, toolName: 'search', occurredAt: ago(300), clientType: 'cursor' },
    { sessionId: second, toolName: 'list_items', occurredAt: ago(290), clientType: 'cursor' },
    // The same page asked for again: the SDK marks it repeated (contract, 3.9).
    { sessionId: second, toolName: 'list_items', occurredAt: ago(280), clientType: 'cursor', repeated: true },
    { sessionId: second, toolName: 'book', occurredAt: ago(270), clientType: 'cursor' },
    // Recorded without a session: through track() alone, or an older SDK.
    { toolName: 'search', occurredAt: ago(100) },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/sessions', () => {
  it('lists sessions newest first, with what happened in each', async () => {
    const { sessions, sampled } = await get<{
      sessions: {
        sessionId: string;
        calls: number;
        failures: number;
        tools: number;
        repeated: number;
        clientType: string;
      }[];
      sampled: boolean;
    }>('sessions');

    expect(sessions).toEqual([
      expect.objectContaining({ sessionId: second, calls: 4, failures: 0, tools: 3, repeated: 1, clientType: 'cursor' }),
      expect.objectContaining({
        sessionId: first,
        calls: 3,
        failures: 1,
        tools: 2,
        repeated: 0,
        clientType: 'claude-code',
      }),
    ]);
    expect(sampled).toBe(false);
  });

  it('narrows to a client, to sessions that called a tool, and to those with failures or repeats', async () => {
    const ids = async (query: string) =>
      (await get<{ sessions: { sessionId: string }[] }>(`sessions?${query}`)).sessions.map((s) => s.sessionId);

    expect(await ids('clientType=cursor')).toEqual([second]);
    expect(await ids('toolName=list_items')).toEqual([second]);
    expect(await ids('with=failures')).toEqual([first]);
    expect(await ids('with=repeats')).toEqual([second]);
    expect(await ids('with=failures&clientType=cursor')).toEqual([]);
    await get('sessions?with=everything', 400);
  });

  it('leaves out calls that belong to no session', async () => {
    const { sessions } = await get<{ sessions: { calls: number }[] }>('sessions');

    expect(sessions.reduce((sum, session) => sum + session.calls, 0)).toBe(7);
  });
});

describe('/v1/dashboard/sessions/:sessionId', () => {
  it('gives the calls in the order they happened', async () => {
    const { calls } = await get<{ calls: { toolName: string; success: boolean; errorSource: string | null }[] }>(
      `sessions/${first}`,
    );

    expect(calls.map((call) => [call.toolName, call.success, call.errorSource])).toEqual([
      ['search', true, null],
      ['book', false, 'arguments'],
      ['book', true, null],
    ]);
  });

  it('marks the call that repeated the one before it', async () => {
    const { calls } = await get<{ calls: { toolName: string; repeated: boolean }[] }>(`sessions/${second}`);

    expect(calls.map((call) => call.repeated)).toEqual([false, false, true, false]);
  });

  it('reads only the window it is given', async () => {
    const from = ago(595).toISOString();
    const to = ago(575).toISOString();

    const { calls } = await get<{ calls: unknown[] }>(`sessions/${first}?from=${from}&to=${to}`);

    expect(calls).toHaveLength(2);
  });

  it("does not show another server's session", async () => {
    const other = await createAccount();
    const theirs = randomUUID();
    await seedEvents(other.serverId, [{ sessionId: theirs, occurredAt: ago(60) }]);

    const { calls } = await get<{ calls: unknown[] }>(`sessions/${theirs}`);

    expect(calls).toEqual([]);
  });

  it('refuses an identifier that is not a UUID', async () => {
    await get('sessions/not-a-session', 400);
  });
});

/** A step between two tool calls, as the transitions list has it. */
function step(from: string | null, to: string, calls: number, afterFailure: number): Transition {
  return { from, fromKind: from === null ? null : 'tool', to, toKind: 'tool', calls, afterFailure };
}

describe('/v1/dashboard/transitions', () => {
  it('counts which tool follows which', async () => {
    const { transitions } = await get<{ transitions: Transition[] }>('transitions');

    expect(transitions).toEqual(
      expect.arrayContaining([
        step(null, 'search', 2, 0),
        step('search', 'book', 1, 0),
        step('search', 'list_items', 1, 0),
        step('list_items', 'list_items', 1, 0),
        step('list_items', 'book', 1, 0),
      ]),
    );
  });

  it('says when a call followed a failure, which is what a retry looks like', async () => {
    const { transitions } = await get<{ transitions: Transition[] }>('transitions');

    expect(transitions).toContainEqual(step('book', 'book', 1, 1));
  });

  it("narrows to a client's sessions, and to the steps into or out of a tool", async () => {
    const pairs = async (query: string) =>
      (await get<{ transitions: Transition[] }>(`transitions?${query}`)).transitions.map((t) => `${t.from}>${t.to}`).sort();

    expect(await pairs('clientType=claude-code')).toEqual(['book>book', 'null>search', 'search>book']);
    expect(await pairs('toolName=list_items')).toEqual(['list_items>book', 'list_items>list_items', 'search>list_items']);
  });

  it('never pairs calls across sessions', async () => {
    const { transitions } = await get<{ transitions: Transition[] }>('transitions');

    // The first session ends in book and the second opens with search. Joined,
    // they would make a book-to-search step that no agent took.
    expect(transitions.find((t) => t.from === 'book' && t.to === 'search')).toBeUndefined();
    expect(transitions.reduce((sum, t) => sum + t.calls, 0)).toBe(7);
  });
});

describe('resources and prompts in a session', () => {
  const third = randomUUID();

  beforeEach(async () => {
    // An agent gets a prompt, reads a resource, then calls a tool.
    await seedEvents(account.serverId, [
      { sessionId: third, kind: 'prompt', toolName: 'plan_trip', occurredAt: ago(60), clientType: 'cursor' },
      { sessionId: third, kind: 'resource', toolName: 'trips://{id}', occurredAt: ago(50), clientType: 'cursor' },
      { sessionId: third, toolName: 'book', occurredAt: ago(40), clientType: 'cursor' },
    ]);
  });

  it('shows every kind of call in order, each named as what it is', async () => {
    const { calls } = await get<{ calls: { kind: string; toolName: string }[] }>(
      `sessions/${third}`,
    );

    expect(calls.map((call) => [call.kind, call.toolName])).toEqual([
      ['prompt', 'plan_trip'],
      ['resource', 'trips://{id}'],
      ['tool', 'book'],
    ]);
  });

  it('counts every call in a session, and only tools as tools', async () => {
    const { sessions } = await get<{ sessions: { sessionId: string; calls: number; tools: number }[] }>('sessions');
    const session = sessions.find((candidate) => candidate.sessionId === third);

    expect(session).toMatchObject({ calls: 3, tools: 1 });
  });

  it('follows an agent from a prompt to a resource to a tool', async () => {
    const { transitions } = await get<{ transitions: Transition[] }>('transitions');

    expect(transitions).toEqual(
      expect.arrayContaining([
        { from: null, fromKind: null, to: 'plan_trip', toKind: 'prompt', calls: 1, afterFailure: 0 },
        { from: 'plan_trip', fromKind: 'prompt', to: 'trips://{id}', toKind: 'resource', calls: 1, afterFailure: 0 },
        { from: 'trips://{id}', fromKind: 'resource', to: 'book', toKind: 'tool', calls: 1, afterFailure: 0 },
      ]),
    );
  });
});

describe('a window with more calls than are read', () => {
  const range = { from: ago(3600), to: new Date() };

  it('reads the newest calls and says it stopped there', async () => {
    // Four read of seven: the second session, whole.
    const { sessions, sampled } = await getSessions(account.serverId, range, 4);

    expect(sampled).toBe(true);
    expect(sessions.map((session) => session.sessionId)).toEqual([second]);
  });

  it('says nothing was left out when nothing was', async () => {
    expect((await getTransitions(account.serverId, range, 7)).sampled).toBe(false);
    expect((await getTransitions(account.serverId, range, 6)).sampled).toBe(true);
  });
});
