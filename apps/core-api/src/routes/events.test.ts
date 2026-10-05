import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiKey, resetDatabase, type TestApiKey } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool, getPool } from '../db.ts';
import { MAX_EVENTS_PER_BATCH } from '../limits.ts';

let apiKey: TestApiKey;

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    toolName: 'search_flights',
    durationMs: 42.5,
    success: true,
    clientType: 'claude',
    timestamp: '2026-09-17T10:00:00.000Z',
    sdkVersion: '0.1.0',
    ...overrides,
  };
}

async function post(
  body: unknown,
  options: { key?: string | null } = {},
): Promise<Response> {
  const key = options.key === undefined ? apiKey.key : options.key;

  return createApp().request('/v1/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDatabase();
  apiKey = await createApiKey();
});

afterAll(async () => {
  await closePool();
});

async function storedRows(): Promise<Record<string, unknown>[]> {
  const result = await getPool().query('SELECT * FROM tool_calls ORDER BY occurred_at');

  return result.rows as Record<string, unknown>[];
}

describe('POST /v1/events', () => {
  it('accepts a well formed batch', async () => {
    const response = await post({ events: [event(), event()] });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: 2, stored: 2 });
  });

  it('accepts an empty batch without complaint', async () => {
    const response = await post({ events: [] });

    expect(response.status).toBe(202);
    expect(await storedRows()).toHaveLength(0);
  });
});

describe('what reaches the database', () => {
  it('stores every event in the batch', async () => {
    await post({ events: [event(), event(), event()] });

    expect(await storedRows()).toHaveLength(3);
  });

  it('stores the fields the SDK reported', async () => {
    const sent = event({
      toolName: 'book_flight',
      durationMs: 123.5,
      success: false,
      errorSource: 'exception',
      errorType: 'TypeError',
      errorMessage: 'bad input',
      clientType: 'cursor',
      clientName: 'cursor-vscode',
      sdkVersion: '0.2.0',
      parameters: { destination: 'string' },
      responseBytes: 48_213,
    });

    await post({ events: [sent] });

    expect(await storedRows()).toEqual([
      expect.objectContaining({
        id: sent['id'],
        tool_name: 'book_flight',
        duration_ms: 123.5,
        success: false,
        error_source: 'exception',
        error_type: 'TypeError',
        error_message: 'bad input',
        client_type: 'cursor',
        client_name: 'cursor-vscode',
        sdk_version: '0.2.0',
        parameters: { destination: 'string' },
        response_bytes: 48_213,
      }),
    ]);
  });

  it('leaves optional fields empty when the SDK sent none', async () => {
    await post({ events: [event()] });

    expect(await storedRows()).toEqual([
      expect.objectContaining({
        error_source: null,
        error_type: null,
        error_message: null,
        client_name: null,
        parameters: null,
        response_bytes: null,
      }),
    ]);
  });

  it('attributes events to the server the key belongs to', async () => {
    await post({ events: [event()] });

    expect((await storedRows())[0]?.['server_id']).toBe(apiKey.serverId);
  });

  it('ignores a server named in the payload', async () => {
    const other = await createApiKey();

    await post({ events: [event({ serverId: other.serverId })] });

    // The key decides whose data this is. Anything else would let one caller
    // file tool calls against somebody else's server.
    expect((await storedRows())[0]?.['server_id']).toBe(apiKey.serverId);
  });

  it('records when it received the batch, alongside when the call happened', async () => {
    await post({ events: [event({ timestamp: '2020-01-01T00:00:00.000Z' })] });

    const row = (await storedRows())[0];
    expect(row?.['occurred_at']).toEqual(new Date('2020-01-01T00:00:00.000Z'));
    expect(row?.['received_at']).not.toEqual(row?.['occurred_at']);
  });
});

describe('a batch delivered twice', () => {
  it('succeeds the second time as well', async () => {
    const events = [event(), event()];
    await post({ events });

    const response = await post({ events });

    expect(response.status).toBe(202);
  });

  it('leaves the database exactly as it was', async () => {
    const events = [event(), event()];
    await post({ events });

    await post({ events });

    expect(await storedRows()).toHaveLength(2);
  });

  it('reports that it stored nothing new', async () => {
    const events = [event(), event()];
    await post({ events });

    const response = await post({ events });

    await expect(response.json()).resolves.toEqual({ accepted: 2, stored: 0 });
  });

  it('drops a copy repeated inside a single batch', async () => {
    const repeated = event();

    const response = await post({ events: [repeated, repeated] });

    // Verified rather than assumed: PostgreSQL treats a conflict against a row
    // inserted earlier in the same statement the same way as one against a row
    // that was already there.
    await expect(response.json()).resolves.toEqual({ accepted: 2, stored: 1 });
    expect(await storedRows()).toHaveLength(1);
  });

  it('still stores the events it has not seen before', async () => {
    const first = event();
    await post({ events: [first] });

    const response = await post({ events: [first, event()] });

    await expect(response.json()).resolves.toEqual({ accepted: 2, stored: 1 });
    expect(await storedRows()).toHaveLength(2);
  });
});

describe('POST /v1/events without a usable key', () => {
  it.each([
    ['no key is sent', null],
    ['the key is unknown', 'mcps_test_never-existed'],
  ])('refuses when %s', async (_label, key) => {
    const response = await post({ events: [event()] }, { key });

    expect(response.status).toBe(401);
  });
});

describe('POST /v1/events with a body it cannot use', () => {
  it('refuses a body that is not JSON', async () => {
    const response = await post('not json at all');

    expect(response.status).toBe(400);
  });

  it('refuses a batch with a broken event', async () => {
    const response = await post({ events: [event({ durationMs: -1 })] });

    expect(response.status).toBe(400);
  });

  it.each([-1, 1.5, 2_147_483_648])('refuses a response size of %s', async (responseBytes) => {
    const response = await post({ events: [event({ responseBytes })] });

    expect(response.status).toBe(400);
  });

  it('says which event and which field', async () => {
    const response = await post({ events: [event(), event({ durationMs: -1 })] });

    await expect(response.json()).resolves.toEqual({
      error: 'Invalid batch',
      issues: [{ field: 'events.1.durationMs', message: expect.any(String) }],
    });
  });
});

describe('POST /v1/events with too much in it', () => {
  it('refuses more events than the limit allows', async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => event());

    const response = await post({ events });

    expect(response.status).toBe(413);
  });

  it('says what the limit is and what arrived', async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => event());

    const response = await post({ events });

    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining(String(MAX_EVENTS_PER_BATCH)),
    });
  });

  it('accepts a batch exactly at the limit', async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH }, () => event());

    const response = await post({ events });

    expect(response.status).toBe(202);
  });

  it('refuses an oversized body before parsing it', async () => {
    const response = await createApp().request('/v1/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey.key}`,
        // Claimed rather than sent: the guard has to act on the declaration,
        // since acting on the payload means having already received it.
        'content-length': String(10 * 1024 * 1024),
      },
      body: JSON.stringify({ events: [event()] }),
    });

    expect(response.status).toBe(413);
  });
});

describe('resources and prompts', () => {
  async function rows(table: string): Promise<Record<string, unknown>[]> {
    return (await getPool().query(`SELECT * FROM ${table}`)).rows as Record<string, unknown>[];
  }

  it('stores each kind of call in its own table', async () => {
    const response = await post({
      events: [
        event({ toolName: 'search_flights' }),
        event({ kind: 'tool', toolName: 'book_flight' }),
        event({ kind: 'resource', toolName: 'trips://{id}', parameters: { id: 'string' } }),
        event({ kind: 'prompt', toolName: 'plan_trip' }),
      ],
    });

    await expect(response.json()).resolves.toEqual({ accepted: 4, stored: 4 });
    expect((await storedRows()).map((row) => row['tool_name'])).toEqual(
      expect.arrayContaining(['search_flights', 'book_flight']),
    );
    expect(await rows('resource_calls')).toMatchObject([{ name: 'trips://{id}', parameters: { id: 'string' } }]);
    expect(await rows('prompt_calls')).toMatchObject([{ name: 'plan_trip' }]);
  });

  it('takes a kind it does not know without refusing the batch, and stores the rest', async () => {
    const response = await post({ events: [event(), event({ kind: 'sampling' })] });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: 2, stored: 1 });
  });

  it('drops a resource read delivered twice, as it does a tool call', async () => {
    const read = event({ kind: 'resource', toolName: 'trips://{id}' });
    await post({ events: [read] });
    const again = await post({ events: [read] });

    await expect(again.json()).resolves.toEqual({ accepted: 1, stored: 0 });
  });
});

describe('tool definitions (contract, 3.8)', () => {
  async function definitions(): Promise<{ tool_name: string; hash: string; first: string; last: string }[]> {
    const result = await getPool().query(
      `SELECT tool_name, hash, first_seen_at::text AS first, last_seen_at::text AS last
       FROM tool_definitions ORDER BY tool_name, first_seen_at`,
    );
    return result.rows as { tool_name: string; hash: string; first: string; last: string }[];
  }

  it('keeps when each definition of each tool was first and last seen', async () => {
    await post({
      events: [
        event({ definitionHash: 'aaaaaaaaaaaaaaaa', timestamp: '2026-09-17T10:00:00.000Z' }),
        event({ definitionHash: 'aaaaaaaaaaaaaaaa', timestamp: '2026-09-17T12:00:00.000Z' }),
        event({ definitionHash: 'bbbbbbbbbbbbbbbb', timestamp: '2026-09-17T13:00:00.000Z' }),
        event({ toolName: 'book_flight', definitionHash: 'aaaaaaaaaaaaaaaa', timestamp: '2026-09-17T11:00:00.000Z' }),
      ],
    });
    // A batch resent, and an older call arriving late, only widen what is known.
    await post({ events: [event({ definitionHash: 'aaaaaaaaaaaaaaaa', timestamp: '2026-09-17T09:00:00.000Z' })] });

    expect(await definitions()).toEqual([
      { tool_name: 'book_flight', hash: 'aaaaaaaaaaaaaaaa', first: '2026-09-17 11:00:00+00', last: '2026-09-17 11:00:00+00' },
      { tool_name: 'search_flights', hash: 'aaaaaaaaaaaaaaaa', first: '2026-09-17 09:00:00+00', last: '2026-09-17 12:00:00+00' },
      { tool_name: 'search_flights', hash: 'bbbbbbbbbbbbbbbb', first: '2026-09-17 13:00:00+00', last: '2026-09-17 13:00:00+00' },
    ]);
  });

  it('ignores a fingerprint on anything but a call to a tool the server has', async () => {
    const response = await post({
      events: [
        event({ kind: 'resource', toolName: 'trips://{id}', definitionHash: 'aaaaaaaaaaaaaaaa' }),
        event({ success: false, errorSource: 'unknown_tool', toolName: 'ghost', definitionHash: 'aaaaaaaaaaaaaaaa' }),
      ],
    });

    expect(response.status).toBe(202);
    expect(await definitions()).toEqual([]);
  });

  it('refuses a fingerprint longer than 64 characters', async () => {
    const response = await post({ events: [event({ definitionHash: 'a'.repeat(65) })] });

    expect(response.status).toBe(400);
  });
});
