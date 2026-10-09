import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { shutdown } from './config.js';
import { instrument } from './instrument.js';
import { exclude } from './track.js';
import type { ToolCallEvent } from './types.js';

/**
 * What instrument() records from a real MCP server driven by a real client:
 * calls the server refuses before any handler runs, and the session each
 * call belongs to.
 *
 * A stand-in server would only prove that the code matches what its author
 * believed the SDK does. The point here is what the SDK actually does: where
 * it validates, what it answers, and which context object it passes along.
 */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await shutdown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connected(
  setup: (server: McpServer) => void,
  options: { captureParameterNames?: boolean; serverVersion?: string } = {},
  serverOptions: ConstructorParameters<typeof McpServer>[1] = undefined,
): Promise<Client> {
  const server = new McpServer({ name: 'flights', version: '1.0.0' }, serverOptions);
  instrument(server, { apiKey: 'key-123', endpoint: 'https://ingest.example.com', ...options });
  setup(server);

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-code', version: '2.0.0' });

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return client;
}

async function delivered(): Promise<ToolCallEvent[]> {
  await shutdown();

  return fetchMock.mock.calls.flatMap(
    (call) =>
      (JSON.parse((call[1] as RequestInit).body as string) as { events: ToolCallEvent[] }).events,
  );
}

function searchTool(server: McpServer, handler = vi.fn(async () => ok())): typeof handler {
  server.registerTool(
    'search_flights',
    { inputSchema: { destination: z.string(), passengers: z.number() } },
    handler,
  );

  return handler;
}

function ok() {
  return { content: [{ type: 'text' as const, text: 'ok' }] };
}

describe('a call with arguments the schema refuses', () => {
  it('is recorded as a failure of that tool, from its arguments', async () => {
    const client = await connected((server) => searchTool(server));

    const result = await client.callTool({
      name: 'search_flights',
      arguments: { destination: 'WAW', passengers: 'two' },
    });

    // The client still gets exactly what the server said.
    expect(result.isError).toBe(true);

    const [event] = await delivered();

    expect(event).toMatchObject({
      toolName: 'search_flights',
      success: false,
      errorSource: 'arguments',
      clientType: 'claude-code',
    });
  });

  it('counts arguments over the element limit of the server as refused too, naming none', async () => {
    const client = await connected((server) => searchTool(server), {}, { maxToolInputElements: 3 });

    const result = await client.callTool({
      name: 'search_flights',
      arguments: { destination: 'WAW', passengers: 2, extra: [1, 2, 3, 4] },
    });

    expect(result.isError).toBe(true);
    const [event] = await delivered();
    expect(event).toMatchObject({ toolName: 'search_flights', success: false, errorSource: 'arguments' });
    expect(event).not.toHaveProperty('invalidArguments');
  });

  it('never reached the handler, and is counted once', async () => {
    let handler: ReturnType<typeof vi.fn> | undefined;
    const client = await connected((server) => {
      handler = searchTool(server);
    });

    await client.callTool({ name: 'search_flights', arguments: { destination: 'WAW' } });

    expect(handler).not.toHaveBeenCalled();
    expect(await delivered()).toHaveLength(1);
  });

  it('sends no message, since a validator may quote the value back', async () => {
    const client = await connected((server) => {
      server.registerTool(
        'book',
        { inputSchema: { cabin: z.enum(['economy', 'business']) } },
        async () => ok(),
      );
    });

    await client.callTool({ name: 'book', arguments: { cabin: 'secret-cabin-value' } });

    const [event] = await delivered();

    expect(event?.errorMessage).toBeUndefined();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('secret-cabin-value');
  });

  it('records the names and types that were sent, when asked to, and no values', async () => {
    const client = await connected((server) => searchTool(server), {
      captureParameterNames: true,
    });

    await client.callTool({
      name: 'search_flights',
      arguments: { dest: 'secret-destination', passengers: 2 },
    });

    const [event] = await delivered();

    // This is what makes the failure useful: the agent said "dest".
    expect(event?.parameters).toEqual({ dest: 'string', passengers: 'number' });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('secret-destination');
  });
});

describe('a call to a tool the server does not have', () => {
  it('is recorded under the name that was asked for', async () => {
    const client = await connected((server) => searchTool(server));

    const result = await client.callTool({ name: 'book_hotel', arguments: {} });

    expect(result.isError).toBe(true);
    expect(await delivered()).toEqual([
      expect.objectContaining({
        toolName: 'book_hotel',
        success: false,
        errorSource: 'unknown_tool',
      }),
    ]);
  });

  it('counts a disabled tool the same way, since the client cannot see it either', async () => {
    const client = await connected((server) => {
      const registered = server.registerTool('legacy_search', {}, async () => ok());
      registered.disable();
    });

    await client.callTool({ name: 'legacy_search', arguments: {} });

    expect(await delivered()).toEqual([
      expect.objectContaining({ toolName: 'legacy_search', errorSource: 'unknown_tool' }),
    ]);
  });
});

describe('what stays as it was', () => {
  it('records a successful call once, from the handler', async () => {
    const client = await connected((server) => searchTool(server));

    await client.callTool({
      name: 'search_flights',
      arguments: { destination: 'WAW', passengers: 2 },
    });

    expect(await delivered()).toEqual([
      expect.objectContaining({ toolName: 'search_flights', success: true }),
    ]);
  });

  it('records an error the handler reported as from the result, not as a refusal', async () => {
    const client = await connected((server) =>
      searchTool(
        server,
        vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'sold out' }], isError: true })),
      ),
    );

    await client.callTool({
      name: 'search_flights',
      arguments: { destination: 'WAW', passengers: 2 },
    });

    expect(await delivered()).toEqual([
      expect.objectContaining({ success: false, errorSource: 'result', errorMessage: 'sold out' }),
    ]);
  });

  it('records a handler that threw as an exception, once', async () => {
    const client = await connected((server) =>
      searchTool(
        server,
        vi.fn(async () => {
          throw new TypeError('boom');
        }),
      ),
    );

    await client.callTool({
      name: 'search_flights',
      arguments: { destination: 'WAW', passengers: 2 },
    });

    expect(await delivered()).toEqual([
      expect.objectContaining({ errorSource: 'exception', errorType: 'TypeError' }),
    ]);
  });

  it('leaves an excluded tool out, even when its arguments are refused', async () => {
    const client = await connected((server) => {
      server.registerTool(
        'health_check',
        { inputSchema: { depth: z.number() } },
        exclude(async () => ok()),
      );
    });

    await client.callTool({ name: 'health_check', arguments: { depth: 'deep' } });

    expect(await delivered()).toEqual([]);
  });

  it('does not touch other requests', async () => {
    const client = await connected((server) => searchTool(server));

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['search_flights']);
    expect(await delivered()).toEqual([]);
  });
});

describe('sessions', () => {
  it('puts every call on one connection in one session, refused or not', async () => {
    const client = await connected((server) => searchTool(server));

    await client.callTool({ name: 'search_flights', arguments: { destination: 'WAW', passengers: 2 } });
    await client.callTool({ name: 'search_flights', arguments: { destination: 'WAW' } });
    await client.callTool({ name: 'book_hotel', arguments: {} });

    const sessions = (await delivered()).map((event) => event.sessionId);

    expect(sessions).toHaveLength(3);
    expect(new Set(sessions).size).toBe(1);
    expect(sessions[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives two connections two sessions', async () => {
    const first = await connected((server) => searchTool(server));
    const second = await connected((server) => searchTool(server));

    await first.callTool({ name: 'search_flights', arguments: { destination: 'WAW', passengers: 1 } });
    await second.callTool({ name: 'search_flights', arguments: { destination: 'WAW', passengers: 1 } });

    const sessions = (await delivered()).map((event) => event.sessionId);

    expect(new Set(sessions).size).toBe(2);
  });
});

describe('tools registered before instrument()', () => {
  async function registeredFirst(setup: (server: McpServer) => void): Promise<Client> {
    const server = new McpServer({ name: 'flights', version: '1.0.0' });
    setup(server);
    instrument(server, { apiKey: 'key-123', endpoint: 'https://ingest.example.com' });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-code', version: '2.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    return client;
  }

  it('are measured like the ones after, refusals included', async () => {
    const handler = vi.fn(async () => ok());
    const client = await registeredFirst((server) => searchTool(server, handler));

    await client.callTool({ name: 'search_flights', arguments: { destination: 'WAW', passengers: 2 } });
    await client.callTool({ name: 'search_flights', arguments: { destination: 'WAW' } });

    const events = await delivered();
    expect(events.map((event) => [event.toolName, event.success, event.errorSource])).toEqual([
      ['search_flights', true, undefined],
      ['search_flights', false, 'arguments'],
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events[0]?.sessionId).toBe(events[1]?.sessionId);
  });

  it('leave an excluded one out', async () => {
    const client = await registeredFirst((server) => {
      server.registerTool('health_check', {}, exclude(async () => ok()));
    });

    await client.callTool({ name: 'health_check', arguments: {} });

    expect(await delivered()).toEqual([]);
  });

  it('are counted once when instrument() runs twice', async () => {
    const client = await registeredFirst((server) => {
      searchTool(server);
      instrument(server);
    });

    await client.callTool({ name: 'search_flights', arguments: { destination: 'WAW', passengers: 2 } });

    expect(await delivered()).toHaveLength(1);
  });
});

describe('resources and prompts (contract, 3.5)', () => {
  const contents = (uri: URL) => ({ contents: [{ uri: uri.href, text: 'ok' }] });

  it('names a fixed resource by its address and a templated one by its template', async () => {
    const client = await connected(
      (server) => {
        server.registerResource('config', 'config://app', {}, async (uri) => contents(uri));
        server.registerResource(
          'trip',
          new ResourceTemplate('trips://{id}', { list: undefined }),
          {},
          async (uri) => contents(uri),
        );
      },
      { captureParameterNames: true },
    );

    await client.readResource({ uri: 'config://app' });
    await client.readResource({ uri: 'trips://secret-4412' });
    const events = await delivered();

    expect(events.map((event) => [event.kind, event.toolName, event.success])).toEqual([
      ['resource', 'config://app', true],
      ['resource', 'trips://{id}', true],
    ]);
    expect(events[1]?.parameters).toEqual({ id: 'string' });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('secret-4412');
  });

  it('keeps no more than the scheme of an address the server does not have', async () => {
    const client = await connected((server) => {
      server.registerResource('config', 'config://app', {}, async (uri) => contents(uri));
    });

    await expect(client.readResource({ uri: 'db://customers/lovelace' })).rejects.toThrow();
    const [event] = await delivered();

    expect(event).toMatchObject({ kind: 'resource', toolName: 'db://', success: false, errorSource: 'unknown_resource' });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('lovelace');
  });

  it('tells a refused prompt, a missing one and one that throws apart', async () => {
    class PlanningError extends Error {
      override name = 'PlanningError';
    }
    const client = await connected((server) => {
      server.registerPrompt('plan_trip', { argsSchema: { destination: z.string() } }, ({ destination }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: destination } }],
      }));
      server.registerPrompt('broken', {}, () => {
        throw new PlanningError('no planner');
      });
    });

    await client.getPrompt({ name: 'plan_trip', arguments: { destination: 'Lisbon' } });
    await expect(client.getPrompt({ name: 'plan_trip', arguments: {} })).rejects.toThrow();
    await expect(client.getPrompt({ name: 'translate' })).rejects.toThrow();
    await expect(client.getPrompt({ name: 'broken' })).rejects.toThrow();
    const events = await delivered();

    expect(events.map((event) => [event.toolName, event.errorSource ?? 'ok', event.errorType])).toEqual([
      ['plan_trip', 'ok', undefined],
      ['plan_trip', 'arguments', undefined],
      ['translate', 'unknown_prompt', undefined],
      ['broken', 'exception', 'PlanningError'],
    ]);
    expect(events.every((event) => event.kind === 'prompt')).toBe(true);
  });

  it('measures resources and prompts registered before instrument() as well', async () => {
    const server = new McpServer({ name: 'flights', version: '1.0.0' });
    server.registerResource('config', 'config://app', {}, async (uri) => contents(uri));
    server.registerPrompt('plan_trip', {}, () => ({ messages: [] }));
    instrument(server, { apiKey: 'key-123', endpoint: 'https://ingest.example.com' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cursor', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    await client.readResource({ uri: 'config://app' });
    await client.getPrompt({ name: 'plan_trip' });
    await client.listResources();
    await client.listPrompts();
    const events = await delivered();

    expect(events.map((event) => [event.kind, event.toolName, event.clientType])).toEqual([
      ['resource', 'config://app', 'cursor'],
      ['prompt', 'plan_trip', 'cursor'],
    ]);
  });
});

describe('versions (contract, 3.6)', () => {
  it('records the version the server gives itself and the one the client gives itself, on every kind of event', async () => {
    const client = await connected((server) => {
      searchTool(server);
      server.registerPrompt('plan_trip', {}, () => ({ messages: [] }));
    });

    await client.callTool({ name: 'search_flights', arguments: { destination: 'LIS', passengers: 1 } });
    await client.callTool({ name: 'no_such_tool', arguments: {} }).catch(() => undefined);
    await client.getPrompt({ name: 'plan_trip' });

    const events = await delivered();
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event).toMatchObject({ serverVersion: '1.0.0', clientVersion: '2.0.0' });
    }
  });

  it('prefers the version it was given, such as a commit, to the one the server gives itself', async () => {
    const client = await connected((server) => searchTool(server), { serverVersion: 'a1b2c3d' });

    await client.callTool({ name: 'search_flights', arguments: { destination: 'LIS', passengers: 1 } });

    expect((await delivered())[0]?.serverVersion).toBe('a1b2c3d');
  });
});
