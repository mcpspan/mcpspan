import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedDefinition, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';
import { getToolDetails } from '../tool-details.ts';

let account: TestAccount;

async function get<T>(path: string, status = 200): Promise<T> {
  const response = await createApp().request(`/v1/dashboard/${path}`, {
    headers: { cookie: account.cookie },
  });

  expect(response.status).toBe(status);

  return (await response.json()) as T;
}

function ago(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

interface Details {
  toolName: string;
  failures: { errorSource: string; calls: number }[];
  messages: { message: string; errorSource: string | null; calls: number }[];
  parameters: { name: string; types: string[]; calls: number }[];
  callsWithParameters: number;
  sampled: boolean;
  responseSizes: { measured: number; medianBytes: number; p95Bytes: number; maxBytes: number } | null;
  definitionChanges: { at: string }[];
  repeats: { repeated: number; of: number };
  refusedArguments: { refused: number; unnamed: number; arguments: { name: string; calls: number }[] };
  before: {
    problems: number;
    predecessors: { before: string | null; beforeKind: string | null; clientType: string; repeats: number; failures: number }[];
    hasMore: boolean;
  };
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();

  // Hours ago and minutes ago, so every figure is checked where it comes
  // from the hourly rollup as well as where it comes from raw rows.
  for (const occurredAt of [ago(180), ago(5)]) {
    await seedEvents(account.serverId, [
      {
        toolName: 'search',
        occurredAt,
        parameters: { destination: 'string', passengers: 'number' },
      },
      {
        toolName: 'search',
        occurredAt,
        parameters: { destination: 'string', passengers: 'string' },
      },
      {
        toolName: 'search',
        success: false,
        errorSource: 'arguments',
        occurredAt,
        parameters: { dest: 'string' },
      },
      {
        toolName: 'search',
        success: false,
        errorSource: 'result',
        errorMessage: 'No flights found',
        occurredAt,
      },
      { toolName: 'book', success: false, errorSource: 'exception', errorMessage: 'boom', occurredAt },
    ]);
  }

  await seedEvents(account.serverId, [
    {
      toolName: 'search',
      success: false,
      errorSource: 'exception',
      errorType: 'TypeError',
      errorMessage: 'Cannot read properties of undefined',
      occurredAt: ago(2),
    },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe("a tool's own page", () => {
  it('shows exactly what its row in the tool table shows, for the same window', async () => {
    const { tools } = await get<{ tools: { toolName: string; calls: number; errors: number }[] }>(
      'tools',
    );
    const row = tools.find((tool) => tool.toolName === 'search');
    const summary = await get<{ totalCalls: number; failedCalls: number }>(
      'summary?toolName=search',
    );
    const { failures } = await get<Details>('tool-details?toolName=search');

    expect(row).toMatchObject({ calls: 9, errors: 5 });
    expect(summary).toMatchObject({ totalCalls: row?.calls, failedCalls: row?.errors });
    expect(failures.reduce((sum, share) => sum + share.calls, 0)).toBe(row?.errors);
  });

  it('splits failures by how they happened, commonest first', async () => {
    const { failures } = await get<Details>('tool-details?toolName=search');

    expect(failures).toEqual([
      { errorSource: 'arguments', calls: 2 },
      { errorSource: 'result', calls: 2 },
      { errorSource: 'exception', calls: 1 },
    ]);
  });

  it('lists what it said when it failed, commonest first, and only its own', async () => {
    const { messages } = await get<Details>('tool-details?toolName=search');

    expect(messages).toEqual([
      expect.objectContaining({ message: 'No flights found', errorSource: 'result', calls: 2 }),
      expect.objectContaining({
        message: 'Cannot read properties of undefined',
        errorSource: 'exception',
        calls: 1,
      }),
    ]);
  });

  it('lists the parameter names agents sent, with every type they arrived as', async () => {
    const { parameters, callsWithParameters } = await get<Details>(
      'tool-details?toolName=search',
    );

    expect(callsWithParameters).toBe(6);
    expect(parameters).toEqual([
      { name: 'destination', types: ['string'], calls: 4 },
      // A number that sometimes arrives as a string: an agent guessing.
      { name: 'passengers', types: ['number', 'string'], calls: 4 },
      // A name the schema does not have, from the refused calls.
      { name: 'dest', types: ['string'], calls: 2 },
    ]);
  });

  it('says when parameter names are not being recorded at all', async () => {
    const { parameters, callsWithParameters } = await get<Details>('tool-details?toolName=book');

    expect(parameters).toEqual([]);
    expect(callsWithParameters).toBe(0);
  });

  it('says how large its answers were, over the calls that reported a size', async () => {
    const sizes = [...Array.from({ length: 19 }, (_, i) => 1000 + i), 250_000];
    await seedEvents(
      account.serverId,
      sizes.map((responseBytes) => ({ toolName: 'export_trip', responseBytes, occurredAt: ago(10) })),
    );
    // A call without a size (an older SDK, or an exception) is left out, and another tool's sizes are its own.
    await seedEvents(account.serverId, [
      { toolName: 'export_trip', occurredAt: ago(10) },
      { toolName: 'get_weather', responseBytes: 9_999_999, occurredAt: ago(10) },
    ]);

    const details = await get<Details>('tool-details?toolName=export_trip');

    expect(details.responseSizes).toEqual({ measured: 20, medianBytes: 1009, p95Bytes: 1018, maxBytes: 250_000 });
  });

  it('has no sizes to show when no call reported one', async () => {
    const details = await get<Details>('tool-details?toolName=search');

    expect(details.responseSizes).toBeNull();
  });

  it('marks where a new definition began, not where recording began, and not a definition coming back', async () => {
    // Recording began long ago; changed twice in the window, then rolled back to the first one.
    const first = ago(120);
    const second = ago(60);
    await seedDefinition(account.serverId, 'search', 'aaaaaaaaaaaaaaaa', ago(60 * 24 * 30), ago(5));
    await seedDefinition(account.serverId, 'search', 'bbbbbbbbbbbbbbbb', first, ago(60));
    await seedDefinition(account.serverId, 'search', 'cccccccccccccccc', second, ago(30));
    // Another tool's change is its own.
    await seedDefinition(account.serverId, 'book', 'aaaaaaaaaaaaaaaa', ago(60 * 24 * 30));
    await seedDefinition(account.serverId, 'book', 'dddddddddddddddd', ago(90));

    const { definitionChanges } = await get<Details>('tool-details?toolName=search');

    expect(definitionChanges).toEqual([{ at: first.toISOString() }, { at: second.toISOString() }]);
  });

  it('shows no change for a tool whose first definition was seen in the window', async () => {
    await seedDefinition(account.serverId, 'search', 'aaaaaaaaaaaaaaaa', ago(30));

    const { definitionChanges } = await get<Details>('tool-details?toolName=search');

    expect(definitionChanges).toEqual([]);
  });

  it('counts the calls an agent repeated with the same arguments, out of the calls read', async () => {
    await seedEvents(account.serverId, [
      { toolName: 'export_trip', occurredAt: ago(10) },
      { toolName: 'export_trip', occurredAt: ago(9), repeated: true },
      { toolName: 'export_trip', occurredAt: ago(8), repeated: true },
      { toolName: 'get_weather', occurredAt: ago(8), repeated: true },
    ]);

    const { repeats } = await get<Details>('tool-details?toolName=export_trip');

    expect(repeats).toEqual({ repeated: 2, of: 3 });
  });

  it('counts which declared arguments refusals were over, and the refusals that named none', async () => {
    const refused = { success: false, errorSource: 'arguments' };
    await seedEvents(account.serverId, [
      { toolName: 'book_flight', occurredAt: ago(10), ...refused, invalidArguments: ['passengers'] },
      { toolName: 'book_flight', occurredAt: ago(9), ...refused, invalidArguments: ['date', 'passengers'] },
      { toolName: 'book_flight', occurredAt: ago(8), ...refused },
      { toolName: 'book_flight', occurredAt: ago(7) },
      { toolName: 'search_flights', occurredAt: ago(7), ...refused, invalidArguments: ['passengers'] },
    ]);

    const { refusedArguments } = await get<Details>('tool-details?toolName=book_flight');

    expect(refusedArguments).toEqual({
      refused: 3,
      unnamed: 1,
      arguments: [
        { name: 'passengers', calls: 2 },
        { name: 'date', calls: 1 },
      ],
    });
  });

  it('counts nothing for a tool no call was refused for', async () => {
    await seedEvents(account.serverId, [{ toolName: 'ok', occurredAt: ago(5) }]);

    const { refusedArguments } = await get<Details>('tool-details?toolName=ok');

    expect(refusedArguments).toEqual({ refused: 0, unnamed: 0, arguments: [] });
  });

  it('says which call came right before a repeated or failed call, by client', async () => {
    const claude = randomUUID();
    const cursor = randomUUID();
    await seedEvents(account.serverId, [
      // The click did not land: the agent lists the elements again, then the next try fails outright.
      { toolName: 'list_elements', occurredAt: ago(20), sessionId: claude },
      { toolName: 'click', occurredAt: ago(19), sessionId: claude },
      { toolName: 'list_elements', occurredAt: ago(18), sessionId: claude, repeated: true },
      { toolName: 'click', occurredAt: ago(17), sessionId: claude },
      { toolName: 'list_elements', occurredAt: ago(16), sessionId: claude, success: false, errorSource: 'exception' },
      // Another client, failing on its first call; and a call with no session, which cannot be placed.
      { toolName: 'list_elements', occurredAt: ago(15), sessionId: cursor, clientType: 'cursor', success: false, errorSource: 'result' },
      { toolName: 'list_elements', occurredAt: ago(14), success: false, errorSource: 'result' },
    ]);

    const { before } = await get<Details>('tool-details?toolName=list_elements');

    expect(before).toEqual({
      problems: 3,
      predecessors: [
        { before: 'click', beforeKind: 'tool', clientType: 'claude', repeats: 1, failures: 1 },
        { before: null, beforeKind: null, clientType: 'cursor', repeats: 0, failures: 1 },
      ],
      hasMore: false,
    });
  });

  it('narrows what came right before to one client, orders it, and pages it', async () => {
    const claude = randomUUID();
    const cursor = randomUUID();
    await seedEvents(account.serverId, [
      { toolName: 'click', occurredAt: ago(20), sessionId: claude },
      { toolName: 'list_elements', occurredAt: ago(19), sessionId: claude, repeated: true },
      { toolName: 'scroll', occurredAt: ago(18), sessionId: claude },
      { toolName: 'list_elements', occurredAt: ago(17), sessionId: claude, success: false, errorSource: 'result' },
      { toolName: 'scroll', occurredAt: ago(16), sessionId: claude },
      { toolName: 'list_elements', occurredAt: ago(15), sessionId: claude, success: false, errorSource: 'result' },
      { toolName: 'click', occurredAt: ago(14), sessionId: cursor, clientType: 'cursor' },
      { toolName: 'list_elements', occurredAt: ago(13), sessionId: cursor, clientType: 'cursor', repeated: true },
    ]);
    type Before = { before: { problems: number; hasMore: boolean; predecessors: { before: string; clientType: string }[] } };
    const rows = (body: Before) => body.before.predecessors.map((row) => `${row.before}/${row.clientType}`);

    expect(rows(await get<Before>('tool-details?toolName=list_elements'))).toEqual(['scroll/claude', 'click/claude', 'click/cursor']);
    expect(rows(await get<Before>('tool-details?toolName=list_elements&beforeSort=repeats'))).toEqual(['click/claude', 'click/cursor', 'scroll/claude']);
    const cursorOnly = await get<Before>('tool-details?toolName=list_elements&beforeClient=cursor');
    expect(rows(cursorOnly)).toEqual(['click/cursor']);
    expect(cursorOnly.before.problems).toBe(1);
    const paged = await get<Before>('tool-details?toolName=list_elements&beforeLimit=1&beforeOffset=1');
    expect(rows(paged)).toEqual(['click/claude']);
    expect(paged.before.hasMore).toBe(true);
    await get('tool-details?toolName=list_elements&beforeSort=newest', 400);
  });

  it('needs to be told which tool', async () => {
    await get('tool-details', 400);
  });

  it('reads the newest calls when there are too many, and says so', async () => {
    const range = { from: ago(60 * 24), to: new Date() };

    const all = await getToolDetails(account.serverId, 'search', range, 9);
    const newest = await getToolDetails(account.serverId, 'search', range, 5);

    expect(all.sampled).toBe(false);
    expect(newest.sampled).toBe(true);
    // The five newest: the crash, then the four from five minutes ago.
    expect(newest.callsWithParameters).toBe(3);
    // Counts by source still cover the whole window.
    expect(newest.failures.reduce((sum, share) => sum + share.calls, 0)).toBe(5);
  });
});
