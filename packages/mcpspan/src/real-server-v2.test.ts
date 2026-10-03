import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  acceptedContent,
  createMcpHandler,
  InMemoryTransport,
  inputRequired,
  McpServer,
} from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { shutdown } from './config.js';
import { instrument } from './instrument.js';
import { exclude } from './track.js';
import type { ToolCallEvent } from './types.js';

/**
 * instrument() on v2 of the official TypeScript SDK, over both protocol eras.
 *
 * v2 changed three things this depends on: it installs its tools/call handler
 * in the McpServer constructor when the server declares the tools capability,
 * it answers a call to a missing tool with a protocol error rather than an
 * error result, and on the 2026-07-28 protocol there is no initialize
 * handshake and no session - a client names itself on every request, and an
 * HTTP server builds a fresh McpServer for each one.
 *
 * Every case below runs in three setups: a 2025-era connection held in
 * process, a 2025-era stateless HTTP endpoint, and a 2026-07-28 HTTP endpoint.
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

const ok = () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

/** The server a developer would write, built fresh wherever the SDK asks for one. */
function buildServer(options: { capture?: boolean; instrumentLast?: boolean } = {}): McpServer {
  // The tools capability declared up front, as v2's own examples do, which
  // is what installs tools/call before instrument() runs.
  const server = new McpServer(
    { name: 'flights', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  const instrumentIt = () =>
    instrument(server, {
      apiKey: 'key-123',
      endpoint: 'https://ingest.example.com',
      captureParameterNames: options.capture ?? false,
    });

  if (options.instrumentLast !== true) instrumentIt();

  server.registerTool(
    'search',
    { inputSchema: z.object({ destination: z.string(), passengers: z.number() }) },
    async () => ok(),
  );
  server.registerTool(
    'health',
    { inputSchema: z.object({ depth: z.number() }) },
    exclude(async () => ok()),
  );
  server.registerTool('legacy', {}, async () => ok()).disable();
  server.registerTool(
    'book',
    { inputSchema: z.object({ flight: z.string() }) },
    async (_args, ctx) => {
      // Asks the client to confirm before booking, the 2026-07-28 way. On a
      // 2025-era connection the SDK serves the same request with a real
      // elicitation and calls the handler again with the answer.
      const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm');

      if (confirmed === undefined) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: 'Book it?',
              requestedSchema: {
                type: 'object',
                properties: { yes: { type: 'boolean' } },
                required: ['yes'],
              },
            }),
          },
        });
      }

      return ok();
    },
  );

  if (options.instrumentLast === true) instrumentIt();

  return server;
}

type Setup = 'in-process 2025' | 'stateless HTTP 2025' | 'HTTP 2026-07-28';

/** Connects a real v2 client, as `clientName`, in the given setup. */
async function connect(
  setup: Setup,
  options: { capture?: boolean; instrumentLast?: boolean } = {},
): Promise<Client> {
  const client = new Client(
    { name: 'claude-code', version: '2.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      ...(setup === 'HTTP 2026-07-28'
        ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
        : {}),
    },
  );

  // Answers the booking's confirmation, whichever way the SDK asks for it.
  client.setRequestHandler('elicitation/create', async () => ({
    action: 'accept',
    content: { yes: true },
  }));

  if (setup === 'in-process 2025') {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer(options).connect(serverSide);
    await client.connect(clientSide);
  } else {
    const handler = createMcpHandler(() => buildServer(options));
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
  }

  return client;
}

async function delivered(): Promise<ToolCallEvent[]> {
  await shutdown();

  return fetchMock.mock.calls.flatMap(
    (call) =>
      (JSON.parse((call[1] as RequestInit).body as string) as { events: ToolCallEvent[] }).events,
  );
}

function announcements(): number {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit).body === JSON.stringify({ events: [] }),
  ).length;
}

const SETUPS: Setup[] = ['in-process 2025', 'stateless HTTP 2025', 'HTTP 2026-07-28'];

describe.each(SETUPS)('v2 of the SDK, %s', (setup) => {
  it('records a call that reached its handler, once', async () => {
    const client = await connect(setup);

    await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 2 } });

    expect(await delivered()).toEqual([
      expect.objectContaining({ toolName: 'search', success: true }),
    ]);
  });

  it('records the version the server and the client each give themselves (contract, 3.6)', async () => {
    const client = await connect(setup);

    await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 2 } });
    await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 'two' } });

    const events = await delivered();
    expect(events).toHaveLength(2);
    for (const event of events) {
      // On a stateless 2025 endpoint nothing names the client, so nothing gives its version either.
      expect(event).toMatchObject({
        serverVersion: '1.0.0',
        ...(setup === 'stateless HTTP 2025' ? {} : { clientVersion: '2.0.0' }),
      });
    }
  });

  it('records refused arguments, though tools/call was installed before instrument()', async () => {
    const client = await connect(setup);

    const result = await client.callTool({
      name: 'search',
      arguments: { destination: 'WAW', passengers: 'two' },
    });

    expect(result.isError).toBe(true);
    expect(await delivered()).toEqual([
      expect.objectContaining({ toolName: 'search', success: false, errorSource: 'arguments' }),
    ]);
  });

  it('records a call to a missing tool, which v2 answers with a protocol error', async () => {
    const client = await connect(setup);

    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(
      /not found/,
    );

    expect(await delivered()).toEqual([
      expect.objectContaining({ toolName: 'no_such_tool', errorSource: 'unknown_tool' }),
    ]);
  });

  it('records a call to a disabled tool the same way', async () => {
    const client = await connect(setup);

    await expect(client.callTool({ name: 'legacy', arguments: {} })).rejects.toThrow(/disabled/);

    expect(await delivered()).toEqual([
      expect.objectContaining({ toolName: 'legacy', errorSource: 'unknown_tool' }),
    ]);
  });

  it('leaves an excluded tool out, refused or not', async () => {
    const client = await connect(setup);

    await client.callTool({ name: 'health', arguments: { depth: 1 } });
    await client.callTool({ name: 'health', arguments: { depth: 'deep' } });

    expect(await delivered()).toEqual([]);
  });

  it('counts a call that asked the client for more as one call, however it ends', async () => {
    const client = await connect(setup);

    const result = await client.callTool({ name: 'book', arguments: { flight: 'LO1' } });

    if (setup === 'stateless HTTP 2025') {
      // A stateless 2025-era endpoint cannot put a question to the client,
      // so the SDK answers with an error. The agent saw it fail; so do we.
      expect(result.isError).toBe(true);
      expect(await delivered()).toEqual([
        expect.objectContaining({ toolName: 'book', success: false, errorSource: 'result' }),
      ]);
    } else {
      expect(result.isError).not.toBe(true);
      expect(await delivered()).toEqual([
        expect.objectContaining({ toolName: 'book', success: true }),
      ]);
    }
  });

  it('records names and types of what was sent, and no values', async () => {
    const client = await connect(setup, { capture: true });

    await client.callTool({
      name: 'search',
      arguments: { destination: 'secret-destination', passengers: 2 },
    });

    const [event] = await delivered();
    expect(event?.parameters).toEqual({ destination: 'string', passengers: 'number' });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('secret-destination');
  });

  it('announces itself once, however many server instances the SDK builds', async () => {
    const client = await connect(setup);

    for (let call = 0; call < 5; call += 1) {
      await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 1 } });
    }
    await delivered();

    expect(announcements()).toBe(1);
  });
});

describe('the client, per protocol era', () => {
  it('is read from the handshake on a 2025-era connection', async () => {
    const client = await connect('in-process 2025');
    await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 1 } });

    expect(await delivered()).toEqual([
      expect.objectContaining({ clientType: 'claude-code', clientName: 'claude-code' }),
    ]);
  });

  it('is read from each request on the 2026-07-28 protocol, which has no handshake', async () => {
    const client = await connect('HTTP 2026-07-28');
    await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 1 } });

    expect(await delivered()).toEqual([
      expect.objectContaining({ clientType: 'claude-code', clientName: 'claude-code' }),
    ]);
  });

  it('is unknown on a stateless 2025-era endpoint, where nothing names it', async () => {
    // Each request reaches a fresh server that never saw the handshake, and
    // 2025-era requests do not name their client. Unknown, rather than the
    // client of some other connection.
    const client = await connect('stateless HTTP 2025');
    await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 1 } });

    expect(await delivered()).toEqual([expect.objectContaining({ clientType: 'unknown' })]);
  });
});

describe('sessions, per setup', () => {
  it('puts a held connection in one session', async () => {
    const client = await connect('in-process 2025');
    await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 1 } });
    await client.callTool({ name: 'no_such_tool', arguments: {} }).catch(() => undefined);

    const sessions = new Set((await delivered()).map((event) => event.sessionId));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(['stateless HTTP 2025', 'HTTP 2026-07-28'] as const)(
    'gives none to calls over %s, which has no connection to group them by',
    async (setup) => {
      const client = await connect(setup);
      await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 1 } });
      await client.callTool({ name: 'no_such_tool', arguments: {} }).catch(() => undefined);

      const events = await delivered();
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.sessionId === undefined)).toBe(true);
    },
  );
});

describe.each<Setup>(['in-process 2025', 'stateless HTTP 2025', 'HTTP 2026-07-28'])(
  'tools registered before instrument(), %s',
  (setup) => {
    it('are measured like the ones after, refusals and exclusions included', async () => {
      const client = await connect(setup, { instrumentLast: true });

      await client.callTool({ name: 'search', arguments: { destination: 'WAW', passengers: 2 } });
      await client.callTool({ name: 'search', arguments: { destination: 'WAW' } }).catch(() => {});
      await client.callTool({ name: 'health', arguments: { depth: 1 } });
      await client.callTool({ name: 'book', arguments: { flight: 'LO1' } });

      const events = await delivered();
      expect(events.map((event) => [event.toolName, event.success, event.errorSource])).toEqual([
        ['search', true, undefined],
        ['search', false, 'arguments'],
        // A stateless 2025 endpoint cannot ask for the confirmation, and the
        // client gets an error in its place.
        setup === 'stateless HTTP 2025' ? ['book', false, 'result'] : ['book', true, undefined],
      ]);
    });
  },
);
