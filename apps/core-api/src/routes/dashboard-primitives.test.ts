import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

let account: TestAccount;

interface Stats {
  name: string;
  calls: number;
  errors: number;
  errorRate: number;
  durationMs: { mean: number | null; p50: number | null; p95: number | null };
}

interface Body {
  resources: Stats[];
  prompts: Stats[];
  unknownResources: { name: string; calls: number; closest: string | null }[];
  unknownPrompts: { name: string; calls: number; closest: string | null }[];
}

async function get(query = ''): Promise<Body> {
  const response = await createApp().request(`/v1/dashboard/resources-and-prompts${query}`, {
    headers: { cookie: account.cookie },
  });
  expect(response.status).toBe(200);

  return (await response.json()) as Body;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();
  await seedEvents(account.serverId, [
    { kind: 'resource', toolName: 'trips://{id}', durationMs: 4, clientType: 'claude-code' },
    { kind: 'resource', toolName: 'trips://{id}', durationMs: 6, clientType: 'cursor' },
    { kind: 'resource', toolName: 'trips://{id}', success: false, errorSource: 'exception', clientType: 'cursor' },
    // Days ago, so the answer has to come through the rollup as well as the raw rows.
    { kind: 'resource', toolName: 'config://app', occurredAt: hoursAgo(5 * 24), clientType: 'cursor' },
    { kind: 'resource', toolName: 'db://', success: false, errorSource: 'unknown_resource' },
    { kind: 'resource', toolName: 'db://', success: false, errorSource: 'unknown_resource' },
    { kind: 'prompt', toolName: 'plan_trip', durationMs: 2 },
    { kind: 'prompt', toolName: 'plan_trip', success: false, errorSource: 'arguments' },
    { kind: 'prompt', toolName: 'translate', success: false, errorSource: 'unknown_prompt' },
    // A tool call, which belongs to none of this.
    { toolName: 'book_flight' },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/resources-and-prompts', () => {
  it('ranks resources and prompts like tools, apart from them and from each other', async () => {
    const body = await get(`?from=${hoursAgo(7 * 24).toISOString()}&to=${new Date().toISOString()}`);

    expect(body.resources.map((resource) => [resource.name, resource.calls, resource.errors])).toEqual([
      ['trips://{id}', 3, 1],
      ['config://app', 1, 0],
    ]);
    expect(body.prompts.map((prompt) => [prompt.name, prompt.calls, prompt.errors])).toEqual([['plan_trip', 2, 1]]);
    expect(body.resources[0]?.durationMs.p50).toEqual(expect.any(Number));
  });

  it('keeps what was asked for and not there out of the ranking, and lists it', async () => {
    const body = await get();

    expect(body.resources.map((resource) => resource.name)).not.toContain('db://');
    expect(body.unknownResources).toMatchObject([{ name: 'db://', calls: 2 }]);
    expect(body.unknownPrompts).toMatchObject([{ name: 'translate', calls: 1 }]);
  });

  it('names the prompt a missing one most likely meant, and never guesses for a resource', async () => {
    await seedEvents(account.serverId, [
      { kind: 'prompt', toolName: 'plan_trips', success: false, errorSource: 'unknown_prompt' },
      // Recorded by its scheme alone, so there is nothing to compare.
      { kind: 'resource', toolName: 'trips://', success: false, errorSource: 'unknown_resource' },
    ]);

    const body = await get();

    expect(Object.fromEntries(body.unknownPrompts.map((prompt) => [prompt.name, prompt.closest]))).toEqual({
      plan_trips: 'plan_trip',
      translate: null,
    });
    expect(body.unknownResources.every((resource) => resource.closest === null)).toBe(true);
  });

  it('narrows to one client', async () => {
    const body = await get('?clientType=claude-code');

    expect(body.resources).toMatchObject([{ name: 'trips://{id}', calls: 1 }]);
    expect(body.prompts).toEqual([]);
  });

  it('leaves the tool views as they were', async () => {
    const response = await createApp().request('/v1/dashboard/tools', { headers: { cookie: account.cookie } });
    const { tools } = (await response.json()) as { tools: { toolName: string }[] };

    expect(tools.map((tool) => tool.toolName)).toEqual(['book_flight']);
  });
});

describe('failures and exports, for every kind of call', () => {
  async function raw(path: string): Promise<Response> {
    return createApp().request(`/v1/dashboard/${path}`, { headers: { cookie: account.cookie } });
  }

  beforeEach(async () => {
    await seedEvents(account.serverId, [{ toolName: 'book_flight', success: false, errorSource: 'exception' }]);
  });

  it('lists failed reads and gets beside failed tool calls, each marked as what it is', async () => {
    const { failures } = (await (await raw('errors')).json()) as { failures: { kind: string; toolName: string }[] };

    expect(failures.map((failure) => `${failure.kind} ${failure.toolName}`).sort()).toEqual([
      'prompt plan_trip',
      'prompt translate',
      'resource db://',
      'resource db://',
      'resource trips://{id}',
      'tool book_flight',
    ]);
  });

  it('narrows to one tool when a tool is asked for', async () => {
    const { failures } = (await (await raw('errors?toolName=book_flight')).json()) as { failures: { kind: string }[] };

    expect(failures.map((failure) => failure.kind)).toEqual(['tool']);
  });

  it('exports every kind of call, with the kind in a column of its own', async () => {
    const lines = (await (await raw('export/calls?format=csv')).text()).trim().split('\r\n');

    // Counted from the end: the columns before it hold free text with commas.
    const header = lines[0]?.split(',') ?? [];
    const fromEnd = header.length - header.indexOf('kind');
    const kinds = lines.slice(1).map((line) => line.split(',').at(-fromEnd));
    expect(kinds.filter((kind) => kind === 'tool')).toHaveLength(2);
    // config://app was read five days ago, before the window.
    expect(kinds.filter((kind) => kind === 'resource')).toHaveLength(5);
    expect(kinds.filter((kind) => kind === 'prompt')).toHaveLength(3);
  });
});
