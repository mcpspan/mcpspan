import { serve, type ServerType } from '@hono/node-server';
import { configure, instrument, shutdown, track } from 'mcpspan';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetDatabase } from '../test/fixtures.ts';
import { issueApiKey } from './api-key.ts';
import { createServer } from './servers.ts';
import { createApp } from './app.ts';
import { closePool, getPool } from './db.ts';

/**
 * The SDK talking to the API over a real socket, into a real database.
 *
 * Unit tests on both sides can agree with what each author imagined and still
 * disagree with each other. This is the only test that proves the contract
 * holds: the package a developer installs, posting over HTTP, to the server
 * they are running, arriving as rows.
 */
let server: ServerType;
let endpoint: string;

beforeAll(async () => {
  server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: createApp().fetch, port: 0 }, () => resolve(started));
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  endpoint = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  await shutdown();
});

async function storedRows(): Promise<Record<string, unknown>[]> {
  const result = await getPool().query('SELECT * FROM tool_calls ORDER BY tool_name');

  return result.rows as Record<string, unknown>[];
}

async function connectSdk(options: Record<string, unknown> = {}): Promise<{ serverId: string }> {
  const server = await createServer(null, 'Integration server');
  const { key, serverId } = await issueApiKey({
    serverId: server.id,
    ownerEmail: 'integration@example.com',
  });

  configure({ apiKey: key, endpoint, ...options });

  return { serverId };
}

describe('an event travelling from the SDK to the database', () => {
  it('arrives once the queue is flushed', async () => {
    await connectSdk();

    track('search_flights', () => 'result')();
    await shutdown();

    expect(await storedRows()).toHaveLength(1);
  });

  it('keeps what the SDK measured', async () => {
    await connectSdk();

    track('search_flights', () => 'result')();
    await shutdown();

    const row = (await storedRows())[0];
    expect(row?.['tool_name']).toBe('search_flights');
    expect(row?.['success']).toBe(true);
    expect(Number(row?.['duration_ms'])).toBeGreaterThanOrEqual(0);
    expect(row?.['sdk_version']).toEqual(expect.any(String));
  });

  it('is attributed to the server the key belongs to', async () => {
    const { serverId } = await connectSdk();

    track('search_flights', () => 'result')();
    await shutdown();

    expect((await storedRows())[0]?.['server_id']).toBe(serverId);
  });
});

describe('both shapes of failure surviving the trip', () => {
  it('records a tool that reported its own error', async () => {
    await connectSdk();

    await track('search_flights', async () => ({
      content: [{ type: 'text', text: 'No flights found' }],
      isError: true,
    }))();
    await shutdown();

    const row = (await storedRows())[0];
    expect(row?.['success']).toBe(false);
    expect(row?.['error_source']).toBe('result');
    expect(row?.['error_message']).toBe('No flights found');
  });

  it('records a handler that threw, and still lets the exception through', async () => {
    await connectSdk();

    const failing = track('book_flight', () => {
      throw new TypeError('bad input');
    });

    expect(() => failing()).toThrow('bad input');
    await shutdown();

    const row = (await storedRows())[0];
    expect(row?.['success']).toBe(false);
    expect(row?.['error_source']).toBe('exception');
    expect(row?.['error_type']).toBe('TypeError');
  });
});

describe('a whole server instrumented at once', () => {
  it('records the tools registered after instrument', async () => {
    const { key, serverId } = await issueApiKey({
      serverId: (await createServer(null, 'Instrumented server')).id,
      ownerEmail: 'integration@example.com',
    });

    const registered: Record<string, () => unknown> = {};
    const mcpServer = {
      server: { getClientVersion: () => ({ name: 'Claude Desktop', version: '1.0.0' }) },
      registerTool(name: string, _config: unknown, handler: () => unknown) {
        registered[name] = handler;
      },
    };

    instrument(mcpServer, { apiKey: key, endpoint });
    mcpServer.registerTool('search_flights', {}, () => 'result');
    registered['search_flights']?.();
    await shutdown();

    const row = (await storedRows())[0];
    expect(row?.['server_id']).toBe(serverId);
    expect(row?.['client_type']).toBe('claude');
    expect(row?.['client_name']).toBe('Claude Desktop');
  });
});

describe('the privacy promise, checked at the far end', () => {
  it('stores no parameter values by default', async () => {
    await connectSdk();

    track('charge', (_p: { apiKey: string }) => 'ok')({ apiKey: 'sk-live-secret' });
    await shutdown();

    const row = (await storedRows())[0];
    expect(row?.['parameters']).toBeNull();
    expect(JSON.stringify(row)).not.toContain('sk-live-secret');
  });

  it('stores names and types when asked, and still no values', async () => {
    await connectSdk({ captureParameterNames: true });

    track('charge', (_p: { apiKey: string }) => 'ok')({ apiKey: 'sk-live-secret' });
    await shutdown();

    const row = (await storedRows())[0];
    expect(row?.['parameters']).toEqual({ apiKey: 'string' });
    expect(JSON.stringify(row)).not.toContain('sk-live-secret');
  });
});

describe('a batch the SDK sends more than once', () => {
  it('does not double count', async () => {
    const { key } = await issueApiKey({
      serverId: (await createServer(null, 'Retrying server')).id,
      ownerEmail: 'integration@example.com',
    });
    configure({ apiKey: key, endpoint });

    track('search_flights', () => 'result')();
    await shutdown();

    // The same events again, as a redelivery after a lost acknowledgement.
    const rows = await storedRows();
    const first = rows[0];
    const response = await fetch(`${endpoint}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        events: [
          {
            id: first?.['id'],
            toolName: first?.['tool_name'],
            durationMs: Number(first?.['duration_ms']),
            success: first?.['success'],
            clientType: first?.['client_type'],
            timestamp: (first?.['occurred_at'] as Date).toISOString(),
            sdkVersion: first?.['sdk_version'],
          },
        ],
      }),
    });

    await expect(response.json()).resolves.toEqual({ accepted: 1, stored: 0 });
    expect(await storedRows()).toHaveLength(1);
  });
});

describe('names longer than the API takes', () => {
  it('are cut by the SDK, so the batch and everything else in it arrives', async () => {
    await connectSdk({ captureParameterNames: true });

    const long = 'x'.repeat(500);
    class Failure extends Error {
      override name = 'E'.repeat(500);
    }

    track('ordinary_tool', () => 'fine')();
    track(long, (_params: Record<string, number>) => 'fine')({ [long]: 1 });
    expect(() =>
      track('throwing_tool', () => {
        throw new Failure('boom');
      })(),
    ).toThrow('boom');
    await shutdown();

    const rows = await storedRows();

    // Before, one over-long name had the whole batch refused and all three lost.
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => String(row['tool_name']).length).sort((a, b) => a - b)).toEqual([
      13,
      13,
      200,
    ]);
    expect(String(rows.find((row) => row['error_type'] !== null)?.['error_type']).length).toBe(200);
    const parameters = rows.find((row) => row['parameters'] !== null)?.['parameters'] as object;
    expect(Object.keys(parameters)[0]?.length).toBe(200);
  });
});
