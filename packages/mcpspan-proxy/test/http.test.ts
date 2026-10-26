import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { forgetListings } from '../../mcpspan/src/definition.js';
import { forgetListingsSent } from '../../mcpspan/src/listings.js';
import { forgetArguments } from '../../mcpspan/src/repeats.js';
import type { ToolCallEvent } from '../../mcpspan/src/types.js';
import { type HttpProxy, startHttp } from '../src/http.js';
import { Observer } from '../src/observer.js';

let events: ToolCallEvent[];
const closing: (() => Promise<void>)[] = [];

beforeEach(() => {
  events = [];
  forgetListings();
  forgetListingsSent();
  forgetArguments();
});

afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closing.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function proxyTo(upstream: string, observe = true): Promise<HttpProxy> {
  const observer = observe ? new Observer({ record: (event) => events.push(event) }) : undefined;
  const proxy = await startHttp({ upstream: new URL(upstream), host: '127.0.0.1', port: 0 }, observer, () => undefined);
  closing.push(() => proxy.close());
  return proxy;
}

function tools(server: { registerTool: (...args: never[]) => unknown }): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  register('search_flights', { description: 'Finds flights.', inputSchema: { to: z.string() } }, async ({ to }: { to: string }) => ({
    content: [{ type: 'text', text: `3 flights to ${to}` }],
  }));
  register('book_flight', { description: 'Books a seat.' }, async () => ({ isError: true, content: [{ type: 'text', text: 'No seats left.' }] }));
}

/** A 2025-era server with sessions, as most HTTP servers on v1 of the official SDK are written. */
async function sessionServer(options: { json: boolean }): Promise<string> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer(async (request, response) => {
    const header = request.headers['mcp-session-id'];
    let transport = typeof header === 'string' ? transports.get(header) : undefined;
    if (transport === undefined) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: options.json,
        onsessioninitialized: (id) => void transports.set(id, transport as StreamableHTTPServerTransport),
      });
      const mcp = new McpServerV1({ name: 'flights', version: '1.4.0' });
      tools(mcp as never);
      await mcp.connect(transport);
    }
    await transport.handleRequest(request, response);
  });
  return `${await listen(server)}/mcp`;
}

/** A stateless server on v2 of the official SDK: both protocol eras, no sessions, a server per request. */
async function statelessServer(): Promise<string> {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'flights', version: '2.0.0' }, { capabilities: { tools: {} } });
    tools(mcp as never);
    return mcp;
  });
  const server = createServer(async (request, response) => {
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await read(request);
    const answer = await handler.fetch(
      new Request(`http://${request.headers.host}${request.url}`, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        ...(body !== undefined && { body }),
      }),
    );
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
  });
  return `${await listen(server)}/mcp`;
}

function read(request: IncomingMessage): Promise<Buffer> {
  return new Promise((done) => {
    const parts: Buffer[] = [];
    request.on('data', (chunk: Buffer) => parts.push(chunk));
    request.on('end', () => done(Buffer.concat(parts)));
  });
}

async function connect(url: string, options: { protocol?: '2026-07-28' } = {}): Promise<Client> {
  const client = new Client(
    { name: 'claude-code', version: '2.1.0' },
    options.protocol === undefined ? {} : { versionNegotiation: { mode: { pin: options.protocol } } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  closing.push(() => client.close());
  return client;
}

/** Lists, calls one tool that works, one that fails and one that does not exist. */
async function use(client: Client): Promise<void> {
  await client.listTools();
  await client.callTool({ name: 'search_flights', arguments: { to: 'LIS' } });
  await client.callTool({ name: 'book_flight', arguments: {} });
  await client.callTool({ name: 'cancel_flight', arguments: {} }).catch(() => undefined);
}

const summary = () => events.map((event) => [event.kind ?? 'tool', event.toolName, event.success, event.errorSource]);

describe.each([
  ['answering in JSON', true],
  ['answering in event streams', false],
])('a server with sessions, %s', (_name, json) => {
  it('reports every call, in one session per client, under an identifier of its own', async () => {
    const upstream = await sessionServer({ json });
    const proxy = await proxyTo(upstream);
    const url = `${proxy.url}/mcp`;

    const first = await connect(url);
    await use(first);
    const second = await connect(url);
    await second.callTool({ name: 'search_flights', arguments: { to: 'OPO' } });

    expect(summary()).toEqual([
      ['listing', 'tools/list', true, undefined],
      ['tool', 'search_flights', true, undefined],
      ['tool', 'book_flight', false, 'result'],
      ['tool', 'cancel_flight', false, 'unknown_tool'],
      ['tool', 'search_flights', true, undefined],
    ]);
    expect(events[1]).toMatchObject({ clientName: 'claude-code', clientVersion: '2.1.0', serverVersion: '1.4.0', responseBytes: expect.any(Number) });
    expect(events[2]?.errorMessage).toBe('No seats left.');

    const sessions = events.map((event) => event.sessionId);
    expect(new Set(sessions.slice(0, 4)).size).toBe(1);
    expect(sessions[4]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessions[4]).not.toBe(sessions[0]);
    // Not the server's own session id, which travels in headers and logs.
    expect(sessions[0]).not.toBe((first.transport as StreamableHTTPClientTransport).sessionId);
  });
});

describe('a stateless server', () => {
  it.each([[undefined], ['2026-07-28' as const]])('reports calls without a session, on protocol %s', async (protocol) => {
    const proxy = await proxyTo(await statelessServer());
    await use(await connect(`${proxy.url}/mcp`, protocol === undefined ? {} : { protocol }));

    expect(summary()).toEqual([
      ['listing', 'tools/list', true, undefined],
      ['tool', 'search_flights', true, undefined],
      ['tool', 'book_flight', false, 'result'],
      ['tool', 'cancel_flight', false, 'unknown_tool'],
    ]);
    expect(events.every((event) => event.sessionId === undefined)).toBe(true);
    expect(events[1]).toMatchObject({ serverVersion: '2.0.0' });
    // As the SDKs: on 2025 a stateless server's calls have no handshake behind them, so no client.
    expect(events[1]?.clientName).toBe(protocol === undefined ? undefined : 'claude-code');
  });
});

describe('passing through', () => {
  /** A server answering by hand, keeping what it was sent. */
  async function rawServer(answer: (request: IncomingMessage, body: Buffer) => { status: number; headers: Record<string, string>; body: Buffer }) {
    const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer(async (request, response) => {
      const body = await read(request);
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: body.toString() });
      const { status, headers, body: out } = answer(request, body);
      response.writeHead(status, headers).end(out);
    });
    return { url: await listen(server), seen };
  }

  it('passes requests and answers on as they are, compressed answers included, with the server as Host', async () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    const upstream = await rawServer((_request, body) => ({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-custom': 'kept' },
      body: gzipSync(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body.toString()).id, result })),
    }));
    const proxy = await proxyTo(upstream.url);

    const sent = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping' } });
    const response = await fetch(`${proxy.url}/mcp?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t', accept: 'application/json, text/event-stream' },
      body: sent,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-custom')).toBe('kept');
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result });
    expect(upstream.seen[0]).toMatchObject({
      method: 'POST',
      url: '/mcp?x=1',
      body: sent,
      headers: { host: new URL(upstream.url).host, authorization: 'Bearer t', 'x-forwarded-host': new URL(proxy.url).host },
    });
    expect(summary()).toEqual([['tool', 'ping', true, undefined]]);
  });

  it('passes on what is not MCP without reading it', async () => {
    const upstream = await rawServer(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"issuer":"x"}') }));
    const proxy = await proxyTo(upstream.url);

    const response = await fetch(`${proxy.url}/.well-known/oauth-protected-resource`);

    expect(await response.text()).toBe('{"issuer":"x"}');
    expect(events).toEqual([]);
  });

  it('answers 502 when the server cannot be reached', async () => {
    const proxy = await proxyTo('http://127.0.0.1:1');
    const response = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('could not reach the MCP server');
  });

  it('only passes through without an observer', async () => {
    const proxy = await proxyTo(await statelessServer(), false);
    await use(await connect(`${proxy.url}/mcp`));

    expect(events).toEqual([]);
  });
});
