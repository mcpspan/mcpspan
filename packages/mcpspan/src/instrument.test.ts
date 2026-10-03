import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configure, shutdown } from './config.js';
import { instrument } from './instrument.js';
import { exclude, track } from './track.js';
import type { ToolCallEvent } from './types.js';

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

/** A stand-in for McpServer, matching the shapes the real one exposes. */
type Handler = (...args: unknown[]) => unknown;

function fakeServer(clientName?: string) {
  const registered: { name: string; handler: Handler }[] = [];

  return {
    registered,
    server: {
      getClientVersion: () => (clientName ? { name: clientName, version: '1.0.0' } : undefined),
    },
    registerTool(name: string, _config: unknown, handler: Handler) {
      registered.push({ name, handler });
      return { name };
    },
    tool(name: string, ...rest: unknown[]) {
      registered.push({ name, handler: rest.at(-1) as Handler });
      return { name };
    },
  };
}

async function delivered(): Promise<ToolCallEvent[]> {
  await shutdown();

  return fetchMock.mock.calls.flatMap(
    (call) => (JSON.parse((call[1] as RequestInit).body as string) as { events: ToolCallEvent[] }).events,
  );
}

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

describe('instrument', () => {
  it('returns the same server it was given', () => {
    const server = fakeServer();

    expect(instrument(server, { apiKey: 'key-123' })).toBe(server);
  });

  it.each([
    ['registerTool', (server: ReturnType<typeof fakeServer>) => server.registerTool('search_flights', {}, () => 'result')],
    ['the deprecated tool method', (server: ReturnType<typeof fakeServer>) => server.tool('search_flights', () => 'result')],
    [
      'the longer overloads, where the handler comes after a schema',
      (server: ReturnType<typeof fakeServer>) => server.tool('search_flights', 'a description', { city: 'string' }, () => 'result'),
    ],
  ])('records tools registered through %s', async (_shape, register) => {
    const server = fakeServer();
    instrument(server, { apiKey: 'key-123' });

    register(server);
    server.registered[0]?.handler();

    expect((await delivered())[0]?.toolName).toBe('search_flights');
  });

  it('passes the registration through to the real method, with a handler that works as written', () => {
    const server = fakeServer();
    const registerTool = vi.spyOn(server, 'registerTool');
    instrument(server, { apiKey: 'key-123' });

    server.registerTool('add', { title: 'Add' }, (...args: unknown[]) => (args[0] as number) + (args[1] as number));

    expect(registerTool).toHaveBeenCalledWith('add', { title: 'Add' }, expect.any(Function));
    expect(server.registered[0]?.handler(2, 3)).toBe(5);
  });

  it('records the client the server reports', async () => {
    const server = fakeServer('Claude Desktop');
    instrument(server, { apiKey: 'key-123' });

    server.registerTool('search', {}, () => null);
    server.registered[0]?.handler();

    expect((await delivered())[0]?.clientType).toBe('claude');
  });

  it('produces the same event as wrapping the handler by hand', async () => {
    const server = fakeServer('cursor');
    instrument(server, { apiKey: 'key-123' });

    // Both registered on the server, one wrapped by hand: that is how track()
    // is used beside instrument(), and both learn the client from the call.
    server.registerTool('search', {}, () => 'result');
    server.registerTool('search', {}, track('search', () => 'result'));
    server.registered[0]?.handler();
    server.registered[1]?.handler();

    const [viaInstrument, viaTrack] = await delivered();
    expect(shapeOf(viaInstrument)).toEqual(shapeOf(viaTrack));
  });

  it('does nothing when there is no API key', async () => {
    const server = fakeServer();
    instrument(server);

    server.registerTool('search', {}, () => null);
    server.registered[0]?.handler();

    expect(await delivered()).toHaveLength(0);
  });
});

describe('instrument on an unfamiliar server', () => {
  it('does not throw when the object has no registration method, and says nothing unless asked', () => {
    expect(() => instrument({}, { apiKey: 'key-123' })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('says so when debug is on', () => {
    instrument({}, { apiKey: 'key-123', debug: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nothing was instrumented'));
  });

  it('copes with a server that cannot report its client', async () => {
    const server = {
      server: {
        getClientVersion: () => {
          throw new Error('not connected');
        },
      },
      registerTool(_name: string, _config: unknown, handler: () => unknown) {
        this.handler = handler;
        return {};
      },
      handler: (() => null) as () => unknown,
    };
    instrument(server, { apiKey: 'key-123' });

    server.registerTool('search', {}, () => null);
    server.handler();

    expect((await delivered())[0]?.clientType).toBe('unknown');
  });

  it('registers a handler it cannot recognise without wrapping it', () => {
    const original = vi.fn();
    const server = { registerTool: original as (...args: unknown[]) => unknown };
    instrument(server, { apiKey: 'key-123' });

    server.registerTool('search', {}, 'not a function');

    // Passed straight through: a registration we cannot read is still a
    // registration the developer meant to make.
    expect(original).toHaveBeenCalledWith('search', {}, 'not a function');
  });

  it('does not wrap a name that is not a string', () => {
    const original = vi.fn();
    const server = { registerTool: original as (...args: unknown[]) => unknown };
    instrument(server, { apiKey: 'key-123' });

    const handler = () => null;
    server.registerTool(42, handler);

    expect(original).toHaveBeenCalledWith(42, handler);
  });
});

describe('instrument and existing configuration', () => {
  it('does not undo a configure that came before it', async () => {
    configure({ apiKey: 'key-123', endpoint: 'https://configured.example.com' });
    const server = fakeServer();

    instrument(server);

    server.registerTool('search', {}, () => null);
    server.registered[0]?.handler();
    expect(await delivered()).toHaveLength(1);
  });

  it('applies a config it was given, replacing an earlier one', async () => {
    configure({ apiKey: 'first', endpoint: 'https://first.example.com' });
    const server = fakeServer();

    instrument(server, { apiKey: 'second', endpoint: 'https://second.example.com' });

    server.registerTool('search', {}, () => null);
    server.registered[0]?.handler();
    const events = await delivered();

    expect(events).toHaveLength(1);
    // Every request that carried events went to the second endpoint. The
    // first configuration still announced itself on the way out, which is
    // not a tool call and not what this is about.
    const withEvents = fetchMock.mock.calls.filter((call) =>
      ((call[1] as RequestInit).body as string).includes('"toolName"'),
    );
    expect(withEvents.map((call) => call[0])).toEqual(['https://second.example.com/v1/events']);
  });

  it('configures from the environment when given nothing', async () => {
    process.env['MCPSPAN_API_KEY'] = 'from-env';
    const server = fakeServer();

    instrument(server);

    server.registerTool('search', {}, () => null);
    server.registered[0]?.handler();
    expect(await delivered()).toHaveLength(1);
  });
});

describe('instrument on a server it cannot modify', () => {
  it('does not throw, and leaves the frozen server working', () => {
    const server = Object.freeze({ registerTool: () => 'registered' });

    expect(() => instrument(server, { apiKey: 'key-123' })).not.toThrow();
    expect(server.registerTool()).toBe('registered');
  });

  it('says what went wrong when debug is on', () => {
    instrument(Object.freeze({ registerTool: () => ({}) }), { apiKey: 'key-123', debug: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not instrument'));
  });
});

describe('instrument and handlers already spoken for', () => {
  it('records a handler wrapped by track once, not twice', async () => {
    const server = fakeServer();
    instrument(server, { apiKey: 'key-123' });

    server.registerTool('search', {}, track('search', () => null));
    server.registered[0]?.handler();

    expect((await delivered()).map((event) => event.toolName)).toEqual(['search']);
  });

  it('leaves an excluded handler working exactly as written', () => {
    const server = fakeServer();
    instrument(server, { apiKey: 'key-123' });
    const original = () => 'ok';

    server.registerTool('health_check', {}, exclude(original));

    expect(server.registered[0]?.handler).toBe(original);
    expect(server.registered[0]?.handler()).toBe('ok');
  });

  it('records nothing for an excluded handler, and keeps recording the tools around it', async () => {
    const server = fakeServer();
    instrument(server, { apiKey: 'key-123' });

    server.registerTool('health_check', {}, exclude(() => 'ok'));
    server.registerTool('search', {}, () => null);
    server.registered[0]?.handler();
    server.registered[1]?.handler();

    expect((await delivered()).map((event) => event.toolName)).toEqual(['search']);
  });
});

describe('exclude on its own', () => {
  it('hands the handler straight back', () => {
    const handler = () => 'ok';

    expect(exclude(handler)).toBe(handler);
  });

  it('does nothing when nothing is instrumenting', async () => {
    configure({ apiKey: 'key-123' });
    const handler = exclude(() => 'ok');

    handler();

    expect(await delivered()).toHaveLength(0);
  });
});

describe('instrument called twice', () => {
  it('does not wrap the same method again', async () => {
    const server = fakeServer();
    instrument(server, { apiKey: 'key-123' });
    instrument(server, { apiKey: 'key-123' });

    server.registerTool('search', {}, () => null);
    server.registered[0]?.handler();

    // A second wrap would report the same call twice.
    expect(await delivered()).toHaveLength(1);
  });
});

/** Everything about an event except the parts that are meant to differ. */
function shapeOf(event: ToolCallEvent | undefined): Record<string, unknown> {
  const { id: _id, durationMs: _duration, timestamp: _timestamp, ...rest } = event ?? ({} as ToolCallEvent);

  return rest;
}
