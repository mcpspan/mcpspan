import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configure, isCollecting, NO_ENDPOINT, shutdown } from './config.js';
import { track } from './track.js';

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env['MCPSPAN_API_KEY'];
  // Every test that collects needs somewhere to send; there is no default.
  process.env['MCPSPAN_ENDPOINT'] = 'https://ingest.example.com';
});

afterEach(async () => {
  await shutdown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Requests that carried events, leaving out the announcement.
 *
 * Every configure() with a key also sends one empty batch at startup, which
 * has its own tests. These are about what happens to recorded tool calls.
 */
function batches(): unknown[][] {
  return fetchMock.mock.calls.filter(
    (call) =>
      (JSON.parse((call[1] as RequestInit).body as string) as { events: unknown[] }).events
        .length > 0,
  );
}

function requestUrl(): string {
  return fetchMock.mock.calls[0]?.[0] as string;
}

function requestHeaders(): Record<string, string> {
  return (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
}

describe('configure without an API key', () => {
  it('does not start collecting', () => {
    configure();

    expect(isCollecting()).toBe(false);
  });

  it('leaves the handler working normally', () => {
    configure();

    expect(track('add', (a: number, b: number) => a + b)(2, 3)).toBe(5);
  });

  it('sends nothing at all', async () => {
    configure();

    track('search', () => null)();
    await shutdown();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does no work at all, not even work it would throw away', () => {
    configure();
    const now = vi.spyOn(performance, 'now');

    track('search', () => null)();

    // Not even the clock is read: the wrapper returns before any of it.
    expect(now).not.toHaveBeenCalled();
  });

  it('stays quiet about it, because having no key is normal', () => {
    configure();

    expect(warn).not.toHaveBeenCalled();
  });

  it('still lets exceptions through', () => {
    configure();

    expect(() =>
      track('explode', () => {
        throw new Error('boom');
      })(),
    ).toThrow('boom');
  });

  it('treats a blank key as no key', () => {
    configure({ apiKey: '   ' });

    expect(isCollecting()).toBe(false);
  });
});

describe('configure with an API key', () => {
  it('starts collecting', () => {
    configure({ apiKey: 'key-123' });

    expect(isCollecting()).toBe(true);
  });

  it('delivers recorded calls', async () => {
    configure({ apiKey: 'key-123', endpoint: 'https://ingest.example.com' });

    track('search', () => null)();
    await shutdown();

    expect(requestUrl()).toBe('https://ingest.example.com/v1/events');
    expect(requestHeaders()['authorization']).toBe('Bearer key-123');
  });

  it('reads the key from the environment', () => {
    process.env['MCPSPAN_API_KEY'] = 'from-env';

    configure();

    expect(isCollecting()).toBe(true);
  });

  it('prefers an explicit key over the environment', async () => {
    process.env['MCPSPAN_API_KEY'] = 'from-env';
    configure({ apiKey: 'explicit' });

    track('search', () => null)();
    await shutdown();

    expect(requestHeaders()['authorization']).toBe('Bearer explicit');
  });

  it('reads the endpoint from the environment', async () => {
    process.env['MCPSPAN_ENDPOINT'] = 'https://self-hosted.example.com';
    configure({ apiKey: 'key-123' });

    track('search', () => null)();
    await shutdown();

    expect(requestUrl()).toBe('https://self-hosted.example.com/v1/events');
  });

  it('with a key and no endpoint, sends nowhere and says so once', async () => {
    delete process.env['MCPSPAN_ENDPOINT'];
    // A fresh copy of the module: whether it has spoken is kept per process.
    vi.resetModules();
    const fresh = await import('./config.js');
    const said: string[] = [];
    const onDiagnostic = (message: string) => said.push(message);

    fresh.configure({ apiKey: 'key-123', onDiagnostic });
    fresh.configure({ apiKey: 'key-123', onDiagnostic });
    fresh.configure({ apiKey: 'key-123' });

    expect(fresh.isCollecting()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(said).toEqual([NO_ENDPOINT]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('configure called more than once', () => {
  it('replaces the previous configuration', async () => {
    configure({ apiKey: 'first', endpoint: 'https://first.example.com' });
    configure({ apiKey: 'second', endpoint: 'https://second.example.com' });

    track('search', () => null)();
    await shutdown();

    expect(batches().map((call) => call[0])).toEqual(['https://second.example.com/v1/events']);
  });

  it('stops collecting when reconfigured without a key', () => {
    configure({ apiKey: 'first' });

    configure();

    expect(isCollecting()).toBe(false);
  });
});

describe('configure with bad options', () => {
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
  ])('ignores a %s batch size instead of throwing', (_label, maxBatchSize) => {
    expect(() => configure({ apiKey: 'key-123', maxBatchSize })).not.toThrow();
    expect(isCollecting()).toBe(true);
  });

  it('accepts a sensible value', async () => {
    configure({ apiKey: 'key-123', maxBatchSize: 2, maxQueueSize: 10, flushIntervalMs: 60_000 });

    const search = track('search', () => null);
    search();
    search();

    // Two events reach the configured batch size, which flushes without
    // waiting for the interval.
    await shutdown();
    expect(batches()).toHaveLength(1);
  });

  it('explains what it ignored when debug is on', () => {
    configure({ apiKey: 'key-123', maxBatchSize: -5, debug: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxBatchSize'));
  });

  it('says nothing when debug is off', () => {
    configure({ apiKey: 'key-123', maxBatchSize: -5 });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('configure and parameter capture', () => {
  function deliveredEvent(): Record<string, unknown> {
    const body = JSON.parse((batches()[0]?.[1] as RequestInit).body as string) as {
      events: Record<string, unknown>[];
    };
    return body.events[0] as Record<string, unknown>;
  }

  it('records no parameters unless asked', async () => {
    configure({ apiKey: 'key-123' });

    track('charge', (_p: { apiKey: string }) => null)({ apiKey: 'sk-live-secret' });
    await shutdown();

    expect(deliveredEvent()['parameters']).toBeUndefined();
  });

  it('records names and types when asked', async () => {
    configure({ apiKey: 'key-123', captureParameterNames: true });

    track('charge', (_p: { apiKey: string }) => null)({ apiKey: 'sk-live-secret' });
    await shutdown();

    expect(deliveredEvent()['parameters']).toEqual({ apiKey: 'string' });
  });

  it('sends no parameter value over the wire, in either mode', async () => {
    configure({ apiKey: 'key-123', captureParameterNames: true });

    track('charge', (_p: { apiKey: string }) => null)({ apiKey: 'sk-live-secret' });
    await shutdown();

    expect((batches()[0]?.[1] as RequestInit).body).not.toContain('sk-live-secret');
  });

  it('turns capture back off when reconfigured without it', async () => {
    configure({ apiKey: 'key-123', captureParameterNames: true });
    configure({ apiKey: 'key-123' });

    track('charge', (_p: { apiKey: string }) => null)({ apiKey: 'sk-live-secret' });
    await shutdown();

    expect(deliveredEvent()['parameters']).toBeUndefined();
  });
});

describe('configure and error messages', () => {
  function deliveredEvent(): Record<string, unknown> {
    const body = JSON.parse((batches()[0]?.[1] as RequestInit).body as string) as {
      events: Record<string, unknown>[];
    };
    return body.events[0] as Record<string, unknown>;
  }

  it('sends the text of a failure by default', async () => {
    configure({ apiKey: 'key-123' });

    expect(() =>
      track('run', () => {
        throw new Error('cannot read /home/me/.aws/credentials');
      })(),
    ).toThrow();
    await shutdown();

    expect(deliveredEvent()['errorMessage']).toBe('cannot read /home/me/.aws/credentials');
  });

  it('leaves the text out when told to, and keeps how the call failed', async () => {
    configure({ apiKey: 'key-123', captureErrorMessages: false });

    expect(() =>
      track('run', () => {
        throw new TypeError('cannot read /home/me/.aws/credentials');
      })(),
    ).toThrow();
    await shutdown();

    const event = deliveredEvent();
    expect(event).toMatchObject({ success: false, errorSource: 'exception', errorType: 'TypeError' });
    expect(event).not.toHaveProperty('errorMessage');
    expect((batches()[0]?.[1] as RequestInit).body).not.toContain('credentials');
  });

  it('counts a change of the setting as a new configuration', async () => {
    configure({ apiKey: 'key-123', captureErrorMessages: false });
    configure({ apiKey: 'key-123' });

    expect(() =>
      track('run', () => {
        throw new Error('boom');
      })(),
    ).toThrow();
    await shutdown();

    expect(deliveredEvent()['errorMessage']).toBe('boom');
  });
});

describe('configure and diagnostics', () => {
  it('sends diagnostics to the callback instead of stderr', async () => {
    const messages: string[] = [];
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    configure({ apiKey: 'key-123', onDiagnostic: (message) => messages.push(message) });

    track('search', () => null)();
    await shutdown();

    expect(messages.some((message) => message.includes('delivery failed'))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not need debug to be set as well', async () => {
    const messages: string[] = [];
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    configure({ apiKey: 'key-123', onDiagnostic: (message) => messages.push(message) });

    track('search', () => null)();
    await shutdown();

    expect(messages).not.toHaveLength(0);
  });

  it('survives a callback that throws', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    configure({
      apiKey: 'key-123',
      onDiagnostic: () => {
        throw new Error('logger is broken');
      },
    });

    track('search', () => null)();

    await expect(shutdown()).resolves.toBeUndefined();
  });
});

describe('configure and process exit', () => {
  function exitListeners(): number {
    return process.listenerCount('beforeExit');
  }

  it('arranges a final delivery by default', () => {
    const before = exitListeners();

    configure({ apiKey: 'key-123' });

    expect(exitListeners()).toBe(before + 1);
  });

  it('leaves the process alone when asked not to', () => {
    const before = exitListeners();

    configure({ apiKey: 'key-123', flushOnExit: false });

    expect(exitListeners()).toBe(before);
  });

  it('adds only one listener however often it is configured', () => {
    const before = exitListeners();

    configure({ apiKey: 'key-123' });
    configure({ apiKey: 'key-456' });
    configure({ apiKey: 'key-789' });

    expect(exitListeners()).toBe(before + 1);
  });

  it('tidies up after itself on shutdown', async () => {
    const before = exitListeners();
    configure({ apiKey: 'key-123' });

    await shutdown();

    expect(exitListeners()).toBe(before);
  });

  it('adds nothing when there is no API key', () => {
    const before = exitListeners();

    configure();

    expect(exitListeners()).toBe(before);
  });
});

describe('shutdown', () => {
  it('delivers what was still queued', async () => {
    configure({ apiKey: 'key-123' });
    track('search', () => null)();

    await shutdown();

    expect(batches()).toHaveLength(1);
  });

  it('stops collecting', async () => {
    configure({ apiKey: 'key-123' });

    await shutdown();

    expect(isCollecting()).toBe(false);
  });

  it('is safe to call when nothing was configured', async () => {
    await expect(shutdown()).resolves.toBeUndefined();
  });
});

describe('the announcement at startup', () => {
  /**
   * Gives the background announcement time to finish, for the one case that
   * checks something did not happen and so has no condition to wait on.
   *
   * A few milliseconds rather than one turn of the event loop: one turn is
   * enough today and would stop being enough the moment the delivery path
   * gained another await, failing a test for a reason unrelated to it.
   */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  function announcements(): unknown[][] {
    return fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit).body === JSON.stringify({ events: [] }),
    );
  }

  it('sends one empty batch as soon as a key is configured', async () => {
    configure({ apiKey: 'key-123', endpoint: 'https://ingest.example.com' });
    await vi.waitFor(() => expect(announcements()).toHaveLength(1));

    // Before any tool is called: that is the point. It tells the installation
    // the key and the address work while nobody has used the server yet.
    expect(announcements()).toHaveLength(1);
    expect(announcements()[0]?.[0]).toBe('https://ingest.example.com/v1/events');
    expect(
      ((announcements()[0]?.[1] as RequestInit).headers as Record<string, string>)[
        'authorization'
      ],
    ).toBe('Bearer key-123');
  });

  it('does not make startup wait for the network', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    // A host that never answers. configure() still returns at once.
    configure({ apiKey: 'key-123' });

    expect(isCollecting()).toBe(true);
  });

  it('reports a refused key at startup and stops collecting', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    configure({ apiKey: 'wrong-key' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected the API key'));

    track('search', () => null)();
    await shutdown();

    // Nothing after the refusal: the key will not start working on its own.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('is not retried, and costs nothing visible, when the endpoint is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    configure({ apiKey: 'key-123' });
    await settle();

    expect(announcements()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();

    // The events themselves are unaffected and go out as usual.
    track('search', () => null)();
    await shutdown();

    expect(batches()).toHaveLength(1);
  });

  it('says it could not announce when debug is on', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    configure({ apiKey: 'key-123', debug: true });

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not announce')),
    );
  });
});
