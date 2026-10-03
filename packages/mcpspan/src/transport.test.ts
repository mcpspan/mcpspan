import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildEventsUrl,
  DEFAULT_TIMEOUT_MS,
  sendEvents,
  TransportError,
  type TransportConfig,
} from './transport.js';
import type { ToolCallEvent } from './types.js';
import { SDK_VERSION } from './version.js';

const config: TransportConfig = {
  endpoint: 'https://ingest.example.com',
  apiKey: 'test-key',
};

function makeEvent(): ToolCallEvent {
  return {
    id: '6f1e8c2a-9b3d-4e7f-a1c2-000000000001',
    toolName: 'search_flights',
    durationMs: 42,
    success: true,
    clientType: 'claude',
    timestamp: '2026-09-16T12:00:00.000Z',
    sdkVersion: SDK_VERSION,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was never called');
  return { url: call[0] as string, init: call[1] as RequestInit };
}

describe('buildEventsUrl', () => {
  it('appends the events path to the endpoint', () => {
    expect(buildEventsUrl('https://ingest.example.com')).toBe(
      'https://ingest.example.com/v1/events',
    );
  });

  it('does not double the separator when the endpoint ends in a slash', () => {
    expect(buildEventsUrl('https://ingest.example.com///')).toBe(
      'https://ingest.example.com/v1/events',
    );
  });

  it('keeps a path prefix, so the API can live behind one', () => {
    expect(buildEventsUrl('https://example.com/mcpspan')).toBe(
      'https://example.com/mcpspan/v1/events',
    );
  });
});

describe('sendEvents', () => {
  it('posts the batch to the events endpoint', async () => {
    await sendEvents([makeEvent()], config);

    const { url, init } = lastRequest();
    expect(url).toBe('https://ingest.example.com/v1/events');
    expect(init.method).toBe('POST');
  });

  it('carries the API key as a bearer token', async () => {
    await sendEvents([makeEvent()], config);

    expect(lastRequest().init.headers).toMatchObject({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    });
  });

  it('identifies itself and its version', async () => {
    await sendEvents([makeEvent()], config);

    expect(lastRequest().init.headers).toMatchObject({
      'user-agent': `mcpspan/${SDK_VERSION} (typescript)`,
    });
  });

  it('wraps the batch in an events property', async () => {
    const event = makeEvent();

    await sendEvents([event], config);

    expect(JSON.parse(lastRequest().init.body as string)).toEqual({ events: [event] });
  });

  it('sends an empty batch as an empty list rather than refusing', async () => {
    await sendEvents([], config);

    expect(JSON.parse(lastRequest().init.body as string)).toEqual({ events: [] });
  });

  it('abandons the request after the default timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await sendEvents([makeEvent()], config);

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });

  it('honours a configured timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await sendEvents([makeEvent()], { ...config, timeoutMs: 250 });

    expect(timeoutSpy).toHaveBeenCalledWith(250);
    timeoutSpy.mockRestore();
  });

  it('reports an unreachable host as retryable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const error = await sendEvents([makeEvent()], config).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).retryable).toBe(true);
    expect((error as TransportError).status).toBeUndefined();
  });

  it.each([408, 429, 500, 503])('treats %i as retryable', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    const error = (await sendEvents([makeEvent()], config).catch(
      (caught: unknown) => caught,
    )) as TransportError;

    expect(error).toBeInstanceOf(TransportError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(status);
  });

  it.each([400, 401, 403, 413])('treats %i as final', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    const error = (await sendEvents([makeEvent()], config).catch(
      (caught: unknown) => caught,
    )) as TransportError;

    expect(error).toBeInstanceOf(TransportError);
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(status);
  });

  it('keeps the original failure as the cause', async () => {
    const cause = new TypeError('fetch failed');
    fetchMock.mockRejectedValue(cause);

    const error = (await sendEvents([makeEvent()], config).catch(
      (caught: unknown) => caught,
    )) as TransportError;

    expect(error.cause).toBe(cause);
  });
});
