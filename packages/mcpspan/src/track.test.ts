import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withCall } from './call.js';
import { MAX_EXCEPTION_MESSAGE_LENGTH, MAX_RESULT_MESSAGE_LENGTH } from './failure.js';
import { setCaptureParameterNames, setEventSink, track } from './track.js';
import type { ToolCallEvent } from './types.js';
import { SDK_VERSION } from './version.js';

let events: ToolCallEvent[];

function only(): ToolCallEvent {
  expect(events).toHaveLength(1);
  return events[0] as ToolCallEvent;
}

/** A tool result shaped the way MCP expects one. */
function toolResult(text: string, isError?: boolean): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    ...(isError !== undefined && { isError }),
  };
}

beforeEach(() => {
  events = [];
  setEventSink((event) => events.push(event));
});

afterEach(() => {
  setEventSink(() => {});
  setCaptureParameterNames(false);
  vi.restoreAllMocks();
});

describe('track keeps the handler intact', () => {
  it('returns what a synchronous handler returned', () => {
    expect(track('add', (a: number, b: number) => a + b)(2, 3)).toBe(5);
  });

  it('returns what an asynchronous handler resolved with', async () => {
    await expect(track('fetch_user', async (id: string) => ({ id }))('u1')).resolves.toEqual({
      id: 'u1',
    });
  });

  it('returns an error result untouched', async () => {
    const result = toolResult('No flights found', true);

    await expect(track('search', async () => result)()).resolves.toBe(result);
  });

  it('passes every argument through untouched', () => {
    const handler = vi.fn();

    track('many_args', handler)({ a: 1 }, 'two', 3);

    expect(handler).toHaveBeenCalledWith({ a: 1 }, 'two', 3);
  });

  it('keeps the handler bound to its object', () => {
    const tool = {
      name: 'weather',
      describe(this: { name: string }) {
        return this.name;
      },
    };
    tool.describe = track('describe', tool.describe);

    expect(tool.describe()).toBe('weather');
  });

  it('lets a synchronous throw through unchanged', () => {
    const failure = new Error('boom');

    expect(() =>
      track('explode', () => {
        throw failure;
      })(),
    ).toThrow(failure);
  });

  it('lets a rejection through unchanged', async () => {
    const failure = new Error('boom');

    await expect(
      track('explode', async () => {
        throw failure;
      })(),
    ).rejects.toBe(failure);
  });

  it('survives a sink that throws', () => {
    setEventSink(() => {
      throw new Error('sink is broken');
    });

    expect(track('add', (a: number, b: number) => a + b)(2, 3)).toBe(5);
  });
});

describe('track timing', () => {
  it('records when the call started', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T08:30:00.000Z'));

    track('search_flights', () => null)();

    expect(only().timestamp).toBe('2026-09-17T08:30:00.000Z');
    vi.useRealTimers();
  });

  it('measures a synchronous handler', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_042.5);

    track('slow', () => null)();

    expect(only().durationMs).toBe(42.5);
  });

  it('measures an asynchronous handler until its promise settles', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);

    await track('slow', async () => {
      await Promise.resolve();
      return null;
    })();

    expect(only().durationMs).toBe(250);
  });

  it('does not stop the clock when the promise is created', async () => {
    let resolveHandler: () => void = () => {};
    const pending = track('slow', () => new Promise<void>((resolve) => (resolveHandler = resolve)))();

    expect(events).toHaveLength(0);

    resolveHandler();
    await pending;
    expect(events).toHaveLength(1);
  });

  it('reports a plausible duration for a real delay', async () => {
    await track('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    })();

    expect(only().durationMs).toBeGreaterThanOrEqual(20);
    expect(only().durationMs).toBeLessThan(500);
  });
});

describe('track on success', () => {
  it('marks the call as successful', () => {
    track('search', () => toolResult('Found 3 flights'))();

    expect(only().success).toBe(true);
  });

  it('leaves error fields empty', () => {
    track('search', () => toolResult('Found 3 flights'))();

    expect(only().errorSource).toBeUndefined();
    expect(only().errorType).toBeUndefined();
    expect(only().errorMessage).toBeUndefined();
  });

  it('does not read isError: false as a failure', () => {
    track('search', () => toolResult('Found 3 flights', false))();

    expect(only().success).toBe(true);
  });

  it('treats a plain value as a success', () => {
    track('add', () => 5)();

    expect(only().success).toBe(true);
  });

  it('treats null as a success rather than tripping over it', () => {
    track('noop', () => null)();

    expect(only().success).toBe(true);
  });
});

describe('track on a result marked as an error', () => {
  it('records it as a failure even though nothing was thrown', async () => {
    await track('search', async () => toolResult('No flights found', true))();

    expect(only().success).toBe(false);
  });

  it('says the failure came from the result', async () => {
    await track('search', async () => toolResult('No flights found', true))();

    expect(only().errorSource).toBe('result');
  });

  it('keeps the message the tool reported', async () => {
    await track('search', async () => toolResult('No flights found', true))();

    expect(only().errorMessage).toBe('No flights found');
  });

  it('has no error type, because nothing was thrown', async () => {
    await track('search', async () => toolResult('No flights found', true))();

    expect(only().errorType).toBeUndefined();
  });

  it('truncates a long message harder than an exception message', async () => {
    await track('search', async () => toolResult('x'.repeat(1_000), true))();

    expect(only().errorMessage).toHaveLength(MAX_RESULT_MESSAGE_LENGTH);
  });

  it('copes with an error result carrying no text', async () => {
    await track('search', async () => ({ content: [], isError: true }))();

    expect(only().success).toBe(false);
    expect(only().errorMessage).toBeUndefined();
  });
});

describe('track on a thrown exception', () => {
  it('records it as a failure', () => {
    expect(() =>
      track('explode', () => {
        throw new TypeError('bad input');
      })(),
    ).toThrow();

    expect(only().success).toBe(false);
  });

  it('says the failure came from an exception', () => {
    expect(() =>
      track('explode', () => {
        throw new TypeError('bad input');
      })(),
    ).toThrow();

    expect(only().errorSource).toBe('exception');
  });

  it('keeps the error type and message', () => {
    expect(() =>
      track('explode', () => {
        throw new TypeError('bad input');
      })(),
    ).toThrow();

    expect(only().errorType).toBe('TypeError');
    expect(only().errorMessage).toBe('bad input');
  });

  it('records a rejection the same way', async () => {
    await expect(
      track('explode', async () => {
        throw new RangeError('out of range');
      })(),
    ).rejects.toThrow();

    expect(only().errorSource).toBe('exception');
    expect(only().errorType).toBe('RangeError');
  });

  it('truncates a very long message', () => {
    expect(() =>
      track('explode', () => {
        throw new Error('x'.repeat(2_000));
      })(),
    ).toThrow();

    expect(only().errorMessage).toHaveLength(MAX_EXCEPTION_MESSAGE_LENGTH);
  });

  it('copes with a handler that throws something that is not an Error', () => {
    expect(() =>
      track('explode', () => {
        throw 'just a string';
      })(),
    ).toThrow();

    expect(only().success).toBe(false);
    expect(only().errorMessage).toBe('just a string');
  });
});

describe('track event shape', () => {
  it('gives every call its own identifier', () => {
    const tracked = track('search', () => null);

    tracked();
    tracked();

    expect(events[0]?.id).not.toBe(events[1]?.id);
  });

  it('records the tool name and SDK version', () => {
    track('search_flights', () => null)();

    expect(only().toolName).toBe('search_flights');
    expect(only().sdkVersion).toBe(SDK_VERSION);
  });

  it('records a call exactly once', async () => {
    await track('once', async () => 'done')();

    expect(events).toHaveLength(1);
  });

  it('never carries the arguments it was called with', () => {
    track('search', (_secret: string) => null)('hunter2');

    expect(JSON.stringify(only())).not.toContain('hunter2');
  });
});

describe('track and parameter privacy', () => {
  const secrets = { apiKey: 'sk-live-secret', email: 'someone@example.com' };

  it('records no parameters by default', () => {
    track('charge', (_params: typeof secrets) => null)(secrets);

    expect(only().parameters).toBeUndefined();
  });

  it('lets no value through by default', () => {
    track('charge', (_params: typeof secrets) => null)(secrets);

    expect(JSON.stringify(only())).not.toContain('sk-live-secret');
  });

  it('records names and types once asked to', () => {
    setCaptureParameterNames(true);

    track('charge', (_params: typeof secrets) => null)(secrets);

    expect(only().parameters).toEqual({ apiKey: 'string', email: 'string' });
  });

  it('still lets no value through in that mode', () => {
    setCaptureParameterNames(true);

    track('charge', (_params: typeof secrets) => null)(secrets);

    const serialised = JSON.stringify(only());
    expect(serialised).not.toContain('sk-live-secret');
    expect(serialised).not.toContain('someone@example.com');
  });

  it('records the parameters of a failed call too', () => {
    setCaptureParameterNames(true);

    expect(() =>
      track('charge', (_params: typeof secrets) => {
        throw new Error('declined');
      })(secrets),
    ).toThrow();

    expect(only().parameters).toEqual({ apiKey: 'string', email: 'string' });
  });

  it('leaves parameters out when a tool takes none', () => {
    setCaptureParameterNames(true);

    track('ping', () => null)();

    expect(only().parameters).toBeUndefined();
  });
});

describe('track and the client that sent the call', () => {
  it('records the client the call arrived with', () => {
    const tracked = track('search', () => null);

    withCall({ client: { name: 'Claude Desktop', version: '1.2.0' } }, () => tracked());

    expect(only().clientType).toBe('claude');
    expect(only().clientName).toBe('Claude Desktop');
  });

  it('keeps the reported name of a client it does not recognise', () => {
    const tracked = track('search', () => null);

    withCall({ client: { name: 'windsurf' } }, () => tracked());

    expect(only().clientType).toBe('other');
    expect(only().clientName).toBe('windsurf');
  });

  it('records unknown for a call that did not come through instrument', () => {
    track('search', () => null)();

    expect(only().clientType).toBe('unknown');
    expect(only().clientName).toBeUndefined();
  });

  it('records each call with its own client', () => {
    const tracked = track('search', () => null);

    withCall({ client: { name: 'cursor' } }, () => tracked());
    withCall({ client: { name: 'claude-code' } }, () => tracked());

    expect(events.map((event) => event.clientType)).toEqual(['cursor', 'claude-code']);
  });

  it('keeps the client of an async call that finishes after another has started', async () => {
    let finish: () => void = () => {};
    const slow = track('search', () => new Promise<null>((resolve) => (finish = () => resolve(null))));
    const fast = track('book', () => null);

    const pending = withCall({ client: { name: 'cursor' } }, () => slow());
    withCall({ client: { name: 'claude-code' } }, () => fast());
    finish();
    await pending;

    expect(events.map((event) => [event.toolName, event.clientType])).toEqual([
      ['book', 'claude-code'],
      ['search', 'cursor'],
    ]);
  });
});

describe('track measures the answer (contract, 3.7)', () => {
  it('counts the bytes of the result as compact JSON, multi-byte characters included', async () => {
    const result = toolResult('Zażółć gęślą jaźń ✈️');
    await track('search', async () => result)();

    expect(only().responseBytes).toBe(Buffer.byteLength(JSON.stringify(result), 'utf8'));
  });

  it('measures an error result too', () => {
    track('search', () => toolResult('No flights found', true))();

    expect(only().responseBytes).toBe(Buffer.byteLength(JSON.stringify(toolResult('No flights found', true))));
  });

  it('has nothing to measure when the handler threw', () => {
    expect(() =>
      track('search', () => {
        throw new Error('down');
      })(),
    ).toThrow();

    expect(only()).not.toHaveProperty('responseBytes');
  });

  it('records the call without a size when the answer cannot be encoded', () => {
    const cyclic: Record<string, unknown> = { content: [] };
    cyclic['self'] = cyclic;
    track('search', () => cyclic)();

    expect(only().success).toBe(true);
    expect(only()).not.toHaveProperty('responseBytes');
  });

  it('sends the size and never the content', () => {
    track('search', () => toolResult('secret-4412'))();

    expect(JSON.stringify(only())).not.toContain('secret-4412');
  });
});
