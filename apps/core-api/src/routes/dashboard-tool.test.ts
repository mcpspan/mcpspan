import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
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
