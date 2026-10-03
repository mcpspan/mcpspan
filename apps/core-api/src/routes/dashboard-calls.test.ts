import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

let account: TestAccount;
const session = randomUUID();

async function get(path: string): Promise<Response> {
  return createApp().request(`/v1/dashboard/${path}`, { headers: { cookie: account.cookie } });
}

interface Call {
  id: string;
  kind: string;
  toolName: string;
  success: boolean;
  sessionId: string | null;
}

async function calls(query = ''): Promise<{ calls: Call[]; nextCursor: string | null }> {
  const response = await get(`calls${query}`);
  expect(response.status).toBe(200);

  return (await response.json()) as { calls: Call[]; nextCursor: string | null };
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();
  await seedEvents(account.serverId, [
    { toolName: 'search', occurredAt: minutesAgo(50), sessionId: session, parameters: { city: 'string' } },
    { toolName: 'book', success: false, errorSource: 'exception', occurredAt: minutesAgo(40), sessionId: session },
    { kind: 'resource', toolName: 'trips://{id}', occurredAt: minutesAgo(30) },
    { kind: 'prompt', toolName: 'plan_trip', success: false, errorSource: 'arguments', occurredAt: minutesAgo(20) },
    { toolName: 'ghost', success: false, errorSource: 'unknown_tool', occurredAt: minutesAgo(10) },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/calls', () => {
  it('lists every call of every kind, newest first', async () => {
    const { calls: all } = await calls();

    expect(all.map((call) => `${call.kind} ${call.toolName}`)).toEqual([
      'tool ghost',
      'prompt plan_trip',
      'resource trips://{id}',
      'tool book',
      'tool search',
    ]);
    expect(all.at(-1)).toMatchObject({ success: true, sessionId: session });
  });

  it('narrows by outcome and by kind', async () => {
    expect((await calls('?outcome=succeeded')).calls.map((call) => call.toolName)).toEqual(['trips://{id}', 'search']);
    expect((await calls('?outcome=failed')).calls).toHaveLength(3);
    expect((await calls('?kind=prompt')).calls.map((call) => call.toolName)).toEqual(['plan_trip']);
  });

  it('pages from where the last page ended', async () => {
    const first = await calls('?limit=2');
    const second = await calls(`?limit=2&before=${encodeURIComponent(first.nextCursor ?? '')}`);

    expect(first.calls.map((call) => call.toolName)).toEqual(['ghost', 'plan_trip']);
    expect(second.calls.map((call) => call.toolName)).toEqual(['trips://{id}', 'book']);
  });

  it('refuses an outcome or a kind it does not know', async () => {
    expect((await get('calls?outcome=maybe')).status).toBe(400);
    expect((await get('calls?kind=widget')).status).toBe(400);
  });
});

describe('/v1/dashboard/calls/:id', () => {
  it('gives one call with everything recorded about it', async () => {
    const search = (await calls('?toolName=search')).calls[0];
    const response = await get(`calls/${search?.id}`);
    const { call } = (await response.json()) as { call: Record<string, unknown> };

    expect(call).toMatchObject({
      id: search?.id,
      kind: 'tool',
      toolName: 'search',
      success: true,
      sessionId: session,
      parameters: { city: 'string' },
      sdkVersion: expect.any(String),
      receivedAt: expect.any(String),
    });
  });

  it("answers 404 for a call that is not there or is another server's", async () => {
    const other = await createAccount();
    const theirs = randomUUID();
    await seedEvents(other.serverId, [{ id: theirs, toolName: 'theirs' }]);

    expect((await get(`calls/${randomUUID()}`)).status).toBe(404);
    expect((await get(`calls/${theirs}`)).status).toBe(404);
    expect((await get('calls/not-an-id')).status).toBe(400);
  });
});
