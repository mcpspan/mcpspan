import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiKey, resetDatabase, type TestApiKey } from '../../test/fixtures.ts';
import { closePool } from '../db.ts';

// Storage is replaced wholesale rather than by breaking the database, so the
// failure is exactly the one being tested and arrives in milliseconds.
const insertEvents = vi.hoisted(() => vi.fn());
vi.mock('../events-store.ts', () => ({ insertEvents }));

const { createApp } = await import('../app.ts');

let apiKey: TestApiKey;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetDatabase();
  apiKey = await createApiKey();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closePool();
});

async function post(): Promise<Response> {
  return createApp().request('/v1/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.key}` },
    body: JSON.stringify({
      events: [
        {
          id: randomUUID(),
          toolName: 'search_flights',
          durationMs: 42.5,
          success: true,
          clientType: 'claude',
          timestamp: '2026-09-17T10:00:00.000Z',
          sdkVersion: '0.1.0',
        },
      ],
    }),
  });
}

describe('when the database will not take the batch', () => {
  beforeEach(() => {
    insertEvents.mockRejectedValue(new Error('connection terminated unexpectedly'));
  });

  it('answers 503, the status the SDK retries', async () => {
    // 500 would read as a verdict on the batch and the SDK would drop it. This
    // is the difference between a database hiccup costing nothing and costing
    // a developer their data.
    expect((await post()).status).toBe(503);
  });

  it('invites the caller back rather than explaining our plumbing', async () => {
    const body = (await (await post()).json()) as { error: string };

    expect(body.error).toMatch(/try again/i);
    expect(body.error).not.toContain('connection terminated');
  });

  it('records the real reason where an operator can find it', async () => {
    await post();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('connection terminated unexpectedly'),
    );
  });
});
