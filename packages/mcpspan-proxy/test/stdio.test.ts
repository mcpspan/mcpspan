import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { ToolCallEvent } from '../../mcpspan/src/types.js';
import { parse } from '../src/args.js';
import { run } from '../src/cli.js';
import { LineSplitter } from '../src/lines.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));

interface Received {
  headers: IncomingHttpHeaders;
  events: ToolCallEvent[];
}

let ingest: Server | undefined;
afterEach(() => new Promise<void>((done) => (ingest === undefined ? done() : ingest.close(() => done()))));

/** A stand-in for mcpspan's ingest API, keeping every batch it is sent. */
async function listen(): Promise<{ endpoint: string; batches: Received[] }> {
  const batches: Received[] = [];
  ingest = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      batches.push({ headers: request.headers, events: JSON.parse(body).events });
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((done) => ingest?.listen(0, '127.0.0.1', done));
  return { endpoint: `http://127.0.0.1:${(ingest.address() as AddressInfo).port}`, batches };
}

const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_flights', arguments: { to: 'LIS' } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_flights', arguments: {} } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cancel_flight' } },
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'whoami' } },
];

/**
 * The proxy in front of the fixture, as a client would drive it: the messages
 * written to its stdin in awkward pieces, then stdin closed.
 */
async function proxy(env: Record<string, string>, argv: string[] = ['--', process.execPath, FIXTURE]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => (written += chunk.toString()));
  const said: string[] = [];

  const running = run(argv, { input, output, env: { PATH: process.env['PATH'] ?? '', ...env }, out: () => undefined, say: (message) => said.push(message) });

  const text = messages.map((message) => `${JSON.stringify(message)}\n`).join('');
  // Split mid-message and mid-character, as pipes do.
  const bytes = Buffer.from(text.replace('LIS', 'Łódź'));
  for (let at = 0; at < bytes.length; at += 37) input.write(bytes.subarray(at, at + 37));
  // Wait for the last answer before closing, as a client would.
  await new Promise<void>((done) => {
    const check = () => (written.includes('"id":6') ? done() : setTimeout(check, 10));
    check();
  });
  input.end();

  const code = await running;
  return { code, written, said };
}

describe('over stdio', () => {
  it('passes every byte through both ways, and reports the calls', async () => {
    const { endpoint, batches } = await listen();
    const { code, written, said } = await proxy({ MCPSPAN_API_KEY: 'key-1', MCPSPAN_ENDPOINT: endpoint });

    expect(code).toBe(0);
    expect(said).toEqual([]);
    // What the server wrote, as it wrote it: the line that is not JSON included.
    expect(written).toContain('starting flights\n');
    expect(written).toContain('3 flights to Łódź');

    expect(batches[0]?.events).toEqual([]);
    expect(batches[0]?.headers).toMatchObject({ authorization: 'Bearer key-1', 'user-agent': expect.stringMatching(/^mcpspan\/\d+\.\d+\.\d+ \(proxy\)$/) });

    const events = batches.flatMap((batch) => batch.events);
    expect(events.map((event) => [event.kind ?? 'tool', event.toolName, event.success, event.errorSource])).toEqual([
      ['listing', 'tools/list', true, undefined],
      ['tool', 'search_flights', true, undefined],
      ['tool', 'search_flights', false, 'arguments'],
      ['tool', 'cancel_flight', false, 'unknown_tool'],
      ['tool', 'whoami', true, undefined],
    ]);
    expect(new Set(events.map((event) => event.sessionId)).size).toBe(1);
    expect(events[1]).toMatchObject({ clientName: 'claude-code', serverVersion: '1.4.0', sdkVersion: expect.stringMatching(/^proxy /) });
    expect(events[2]?.invalidArguments).toEqual(['to']);
  });

  it('keeps the API key from the server, so an SDK inside it does not count the calls again', async () => {
    const { endpoint } = await listen();
    const { written } = await proxy({ MCPSPAN_API_KEY: 'key-1', MCPSPAN_ENDPOINT: endpoint });

    expect(written).toContain('\\"key\\":null');
  });

  it('passes everything through and reports nothing without an API key', async () => {
    const { endpoint, batches } = await listen();
    const { code, written, said } = await proxy({ MCPSPAN_ENDPOINT: endpoint });

    expect(code).toBe(0);
    expect(written).toContain('3 flights to Łódź');
    expect(said).toEqual([]);
    expect(batches).toEqual([]);
  });

  it('says once that nothing is collected with a key and no endpoint', async () => {
    const { said } = await proxy({ MCPSPAN_API_KEY: 'key-1' });
    expect(said).toEqual([expect.stringContaining('Set MCPSPAN_ENDPOINT')]);
  });

  it("leaves with the server's exit code, and its arguments as given", async () => {
    const { code, written } = await proxy({ FIXTURE_EXIT: '5' }, ['--', process.execPath, FIXTURE, '--debug', '--', 'x']);

    expect(code).toBe(5);
    expect(written).toContain('[\\"--debug\\",\\"--\\",\\"x\\"]');
  });

  it('says why a server could not start, and leaves as one that crashed did', async () => {
    const said: string[] = [];
    const io = { input: new PassThrough(), output: new PassThrough(), out: () => undefined, say: (message: string) => said.push(message) };

    expect(await run(['--', 'mcpspan-no-such-command'], { ...io, env: { PATH: process.env['PATH'] ?? '' } })).toBe(127);
    expect(said).toEqual(['mcpspan-proxy: could not start the server: no such command "mcpspan-no-such-command".']);

    expect(await run(['--', process.execPath, FIXTURE], { ...io, env: { FIXTURE_MODE: 'crash' } })).toBe(3);
  });
});

describe('lines', () => {
  it('splits at newlines across chunks, and skips a line over the limit', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line), 10);
    splitter.push(Buffer.from('ab'));
    splitter.push(Buffer.from('c\r\n\nlonger than ten'));
    splitter.push(Buffer.from(' bytes\nok\n'));

    expect(lines).toEqual(['abc', 'ok']);
  });
});

describe('the command line', () => {
  it('takes the options before -- and the command after it', () => {
    expect(parse(['--exclude', 'health', '--parameter-names', '--', 'uv', 'run', 'server.py', '--exclude', 'x'])).toEqual({
      ok: true,
      options: {
        target: { kind: 'stdio', command: 'uv', args: ['run', 'server.py', '--exclude', 'x'] },
        exclude: ['health'],
        captureParameterNames: true,
        captureErrorMessages: true,
        debug: false,
      },
    });
    expect(parse(['--no-error-messages', '--', 'node', 's.js'])).toMatchObject({ ok: true, options: { captureErrorMessages: false } });
  });

  it('takes a URL, where to listen, and the address from the environment', () => {
    expect(parse(['http://localhost:3000/mcp'])).toMatchObject({ ok: true, options: { target: { kind: 'http', host: '127.0.0.1', port: 6273 } } });
    expect(parse(['--port', '8080', 'https://example.com/mcp'], { MCPSPAN_PROXY_HOST: '0.0.0.0' })).toMatchObject({
      ok: true,
      options: { target: { kind: 'http', host: '0.0.0.0', port: 8080 } },
    });
    expect(parse(['--host', '::1', 'http://a.example'], { MCPSPAN_PROXY_HOST: '0.0.0.0' })).toMatchObject({ ok: true, options: { target: { host: '::1' } } });
  });

  it.each([
    [[], 'its command after --, or its URL'],
    [['--'], 'its command after --, or its URL'],
    [['node', 'server.js'], 'mcpspan-proxy -- node'],
    [['server.js'], 'mcpspan-proxy -- server.js'],
    [['ftp://a.example'], 'not an http or https URL'],
    [['http://a.example', 'http://b.example'], 'one server at a time'],
    [['http://a.example', '--', 'node'], 'one server at a time'],
    [['--port', 'x', 'http://a.example'], 'port number'],
    [['--port', '1', '--', 'node'], 'for a server over HTTP'],
    [['--nope', '--', 'node'], "Unknown option '--nope'"],
  ])('refuses %j', async (argv, message) => {
    const said: string[] = [];
    const code = await run(argv, { input: new PassThrough(), output: new PassThrough(), env: {}, out: () => undefined, say: (text) => said.push(text) });

    expect(code).toBe(2);
    expect(said.join('')).toContain(message);
  });
});
