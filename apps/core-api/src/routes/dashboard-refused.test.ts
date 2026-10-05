import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

/**
 * Calls the MCP server refused before any handler ran.
 *
 * Two kinds, treated differently on purpose. Bad arguments are a failure of a
 * real tool and count against it like any other. A call to a tool that does
 * not exist belongs to no tool, so it stays out of every figure about tools
 * and is listed on its own.
 *
 * Seeded both hours ago and minutes ago, so the answer is checked where it
 * comes from the hourly rollup as well as where it comes from raw rows.
 */
let account: TestAccount;

async function get<T>(path: string): Promise<T> {
  const response = await createApp().request(`/v1/dashboard/${path}`, {
    headers: { cookie: account.cookie },
  });

  expect(response.status).toBe(200);

  return (await response.json()) as T;
}

function ago(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();

  for (const occurredAt of [ago(180), ago(5)]) {
    await seedEvents(account.serverId, [
      { toolName: 'search_flights', occurredAt },
      { toolName: 'search_flights', success: false, errorSource: 'arguments', occurredAt },
      { toolName: 'book_hotel', success: false, errorSource: 'unknown_tool', occurredAt },
    ]);
  }

  await seedEvents(account.serverId, [
    { toolName: 'book_hotel', success: false, errorSource: 'unknown_tool', occurredAt: ago(2) },
    { toolName: 'cancel', success: false, errorSource: 'unknown_tool', occurredAt: ago(1) },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('bad arguments', () => {
  it('count against the tool they were meant for', async () => {
    const { tools } = await get<{ tools: { toolName: string; calls: number; errors: number }[] }>(
      'tools',
    );

    expect(tools).toEqual([
      expect.objectContaining({ toolName: 'search_flights', calls: 4, errors: 2 }),
    ]);
  });

  it('count in the summary, since the agent saw them fail', async () => {
    const summary = await get<{ totalCalls: number; failedCalls: number }>('summary');

    expect(summary).toMatchObject({ totalCalls: 4, failedCalls: 2 });
  });

  it('can be filtered to on their own', async () => {
    const { failures } = await get<{ failures: { errorSource: string }[] }>(
      'errors?errorSource=arguments',
    );

    expect(failures).toHaveLength(2);
  });
});

describe('calls to tools that do not exist', () => {
  it('stay out of the tool ranking', async () => {
    const { tools } = await get<{ tools: { toolName: string }[] }>('tools');

    expect(tools.map((tool) => tool.toolName)).toEqual(['search_flights']);
  });

  it('stay out of the summary and the count of tools', async () => {
    const summary = await get<{ totalCalls: number; uniqueTools: number }>('summary');

    expect(summary).toMatchObject({ totalCalls: 4, uniqueTools: 1 });
  });

  it('stay out of the chart, which has to add up to the summary', async () => {
    const { points } = await get<{ points: { calls: number }[] }>('timeseries');

    expect(points.reduce((sum, point) => sum + point.calls, 0)).toBe(4);
  });

  it('are not offered as a tool to filter by', async () => {
    const { tools } = await get<{ tools: string[] }>('filters');

    expect(tools).toEqual(['search_flights']);
  });

  it('are listed on their own, most asked for first', async () => {
    const { tools } = await get<{
      tools: { toolName: string; calls: number; lastCalledAt: string }[];
    }>('unknown-tools');

    expect(tools).toEqual([
      {
        toolName: 'book_hotel',
        calls: 3,
        lastCalledAt: expect.any(String),
        closest: null,
        afterwards: null,
        clients: [{ clientType: 'claude', calls: 3 }],
      },
      {
        toolName: 'cancel',
        calls: 1,
        lastCalledAt: expect.any(String),
        closest: null,
        afterwards: null,
        clients: [{ clientType: 'claude', calls: 1 }],
      },
    ]);
    expect(Date.parse(tools[0]?.lastCalledAt ?? '')).toBeGreaterThan(ago(3).getTime());
  });

  it('name the tool they most likely meant, when one is close', async () => {
    await seedEvents(account.serverId, [
      { toolName: 'search_flight', success: false, errorSource: 'unknown_tool', occurredAt: ago(1) },
      { toolName: 'flightSearch', success: false, errorSource: 'unknown_tool', occurredAt: ago(1) },
    ]);

    const { tools } = await get<{ tools: { toolName: string; closest: string | null }[] }>('unknown-tools');
    const closest = Object.fromEntries(tools.map((tool) => [tool.toolName, tool.closest]));

    expect(closest).toEqual({
      search_flight: 'search_flights',
      flightSearch: 'search_flights',
      // Nothing like it: a wrong hint is worse than none.
      book_hotel: null,
      cancel: null,
    });
  });

  it('say which clients asked, most first', async () => {
    await seedEvents(account.serverId, [
      { toolName: 'cancel', success: false, errorSource: 'unknown_tool', clientType: 'cursor', occurredAt: ago(1) },
      { toolName: 'cancel', success: false, errorSource: 'unknown_tool', clientType: 'cursor', occurredAt: ago(1) },
      // Outside the window: not counted.
      { toolName: 'cancel', success: false, errorSource: 'unknown_tool', clientType: 'chatgpt', occurredAt: ago(60 * 24 * 40) },
    ]);

    const { tools } = await get<{ tools: { toolName: string; clients: { clientType: string; calls: number }[] }[] }>(
      'unknown-tools',
    );

    expect(tools.find((tool) => tool.toolName === 'cancel')?.clients).toEqual([
      { clientType: 'cursor', calls: 2 },
      { clientType: 'claude', calls: 1 },
    ]);
  });

  it('say what the agent did next in the same session', async () => {
    const renamed = '00000000-0000-4000-8000-0000000000a1';
    const stuck = '00000000-0000-4000-8000-0000000000a2';
    const at = (seconds: number) => new Date(Date.now() - 60_000 + seconds * 1000);
    await seedEvents(account.serverId, [
      // Went on to the right tool.
      { toolName: 'search_flight', success: false, errorSource: 'unknown_tool', sessionId: renamed, occurredAt: at(0) },
      { toolName: 'search_flights', sessionId: renamed, occurredAt: at(2) },
      // Asked again, then gave up.
      { toolName: 'search_flight', success: false, errorSource: 'unknown_tool', sessionId: stuck, occurredAt: at(0) },
      { toolName: 'search_flight', success: false, errorSource: 'unknown_tool', sessionId: stuck, occurredAt: at(1) },
      // No session to follow: left out.
      { toolName: 'search_flight', success: false, errorSource: 'unknown_tool', occurredAt: at(3) },
    ]);

    const { tools } = await get<{
      tools: { toolName: string; afterwards: { called: unknown[]; again: number; stopped: number } | null }[];
    }>('unknown-tools');

    expect(tools.find((tool) => tool.toolName === 'search_flight')?.afterwards).toEqual({
      called: [{ kind: 'tool', name: 'search_flights', calls: 1 }],
      again: 1,
      stopped: 1,
    });
  });

  it('follow the agent to a resource or a prompt as well', async () => {
    const session = '00000000-0000-4000-8000-0000000000a3';
    await seedEvents(account.serverId, [
      { toolName: 'trip_plan', success: false, errorSource: 'unknown_tool', sessionId: session, occurredAt: ago(1) },
      { kind: 'prompt', toolName: 'plan_trip', sessionId: session, occurredAt: new Date(ago(1).getTime() + 1000) },
    ]);

    const { tools } = await get<{ tools: { toolName: string; afterwards: { called: unknown[] } | null }[] }>(
      'unknown-tools',
    );

    expect(tools.find((tool) => tool.toolName === 'trip_plan')?.afterwards?.called).toEqual([
      { kind: 'prompt', name: 'plan_trip', calls: 1 },
    ]);
  });

  it('do not suggest a name only ever called as a missing one', async () => {
    await seedEvents(account.serverId, [
      { toolName: 'book_hotels', success: false, errorSource: 'unknown_tool', occurredAt: ago(1) },
    ]);

    const { tools } = await get<{ tools: { toolName: string; closest: string | null }[] }>('unknown-tools');

    expect(tools.find((tool) => tool.toolName === 'book_hotels')?.closest).toBeNull();
  });

  it('appear in the list of failures, call by call', async () => {
    const { failures } = await get<{ failures: { toolName: string }[] }>(
      'errors?errorSource=unknown_tool',
    );

    expect(failures.map((failure) => failure.toolName)).toEqual([
      'cancel',
      'book_hotel',
      'book_hotel',
      'book_hotel',
    ]);
  });
});
