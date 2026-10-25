import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parse } from '../src/args.js';
import { run } from '../src/cli.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));

const good = { name: 'search_flights', description: 'Finds flights between two airports, cheapest first.', inputSchema: { type: 'object' } };
const broken = { name: 'book flight', description: 'Books a seat on a flight found earlier.', inputSchema: { type: 'string' } };
const vague = { name: 'cancel_booking', description: 'Cancel.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } };

/** One run, with what it printed. */
async function lintWith(argv: string[], env: Record<string, string> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let out = '';
  let err = '';
  try {
    const code = await run(argv, { out: (t) => (out += t), err: (t) => (err += t), color: false });
    return { code, out, err };
  } finally {
    process.env = saved;
  }
}

const overStdio = (tools: unknown[], extra: string[] = [], mode = 'ok') =>
  lintWith([...extra, '--', process.execPath, FIXTURE], { FIXTURE_TOOLS: JSON.stringify(tools), FIXTURE_MODE: mode });

describe('over stdio', () => {
  it('reports each tool with what is wrong in it, and fails on errors', async () => {
    const { code, out } = await overStdio([good, broken, vague]);

    expect(code).toBe(1);
    expect(out).toContain('fixture 1.0.0: 3 tools, about');
    expect(out).toMatch(/book flight\n {2}error {4}name-invalid/);
    expect(out).toContain('schema-not-object');
    expect(out).toMatch(/cancel_booking\n {2}warning {2}description-short/);
    expect(out).toContain('id: No description');
    expect(out).not.toContain('search_flights\n');
    expect(out).toContain('2 errors, 2 warnings');
  });

  it('reads every page of the listing', async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({ ...good, name: `tool_${i}`, description: `${good.description} ${i}` }));
    const { code, out } = await overStdio(tools);

    expect(code).toBe(0);
    expect(out).toContain('5 tools');
    expect(out).toContain('Nothing to fix.');
  });

  it('passes with warnings, and fails on them with --strict', async () => {
    expect((await overStdio([good, vague])).code).toBe(0);
    expect((await overStdio([good, vague], ['--strict'])).code).toBe(1);
  });

  it('prints JSON with --json', async () => {
    const { out } = await overStdio([broken], ['--json']);
    const report = JSON.parse(out);

    expect(report).toMatchObject({ server: { name: 'fixture', version: '1.0.0' }, tools: 1, errors: 2, warnings: 0 });
    expect(report.findings.map((f: { rule: string }) => f.rule)).toEqual(['name-invalid', 'schema-not-object']);
  });

  it('says so when the server offers no tools', async () => {
    const { code, out } = await overStdio([], [], 'no-tools');

    expect(code).toBe(0);
    expect(out).toContain('The server offers no tools');
  });

  it('shows what a server that will not start wrote, and exits 2', async () => {
    const { code, out, err } = await overStdio([], [], 'crash');

    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain('mcpspan-lint: Could not connect');
    expect(err).toContain('FLIGHTS_API_KEY is not set');
  });

  it('gives up on a server that does not answer', async () => {
    const { code, err } = await overStdio([], ['--timeout', '0.5'], 'hang');

    expect(code).toBe(2);
    expect(err).toContain('did not finish the handshake within 0.5 seconds');
  });
});

describe('over HTTP', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server === undefined ? done() : server.close(() => done()))));

  /** A bare Streamable HTTP server answering in JSON, refusing anybody without the expected token. */
  async function listen(tools: unknown[]): Promise<string> {
    server = createServer((request, response) => {
      if (request.method !== 'POST') return void response.writeHead(405).end();
      if (request.headers.authorization !== 'Bearer secret') return void response.writeHead(401).end();

      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        const message = JSON.parse(body);
        if (message.id === undefined) return void response.writeHead(202).end();

        const result =
          message.method === 'initialize'
            ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '2.0.0' } }
            : { tools };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
    });
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));

    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  }

  it('checks a running server, sending the headers given', async () => {
    const url = await listen([good, broken]);
    const { code, out } = await lintWith(['--header', 'Authorization: Bearer secret', url]);

    expect(code).toBe(1);
    expect(out).toContain('remote 2.0.0: 2 tools');
    expect(out).toContain('name-invalid');
  });

  it('exits 2 when the server refuses it', async () => {
    const url = await listen([good]);
    const { code, err } = await lintWith([url]);

    expect(code).toBe(2);
    expect(err).toContain('mcpspan-lint: Could not connect');
  });
});

describe('from a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpspan-lint-'));
  const save = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };

  it.each([
    ['a JSON-RPC answer', { jsonrpc: '2.0', id: 1, result: { tools: [broken] } }],
    ['a result', { tools: [broken] }],
    ['a list of tools', [broken]],
  ])('reads %s', async (_name, value) => {
    const { code, out } = await lintWith(['--file', save('listing.json', value)]);

    expect(code).toBe(1);
    expect(out).toContain('The listing: 1 tool');
    expect(out).toContain('name-invalid');
  });

  it('exits 2 on a file that is not a listing', async () => {
    expect((await lintWith(['--file', save('bad.json', 'not json')])).err).toContain('is not JSON');
    expect((await lintWith(['--file', save('other.json', { servers: [] })])).err).toContain('holds no list of tools');
    expect((await lintWith(['--file', join(dir, 'missing.json')])).code).toBe(2);
  });
});

describe('the command line', () => {
  it('takes a command after --, keeping its own flags as its own', () => {
    expect(parse(['--strict', '--', 'node', 'server.js', '--json'])).toEqual({
      ok: true,
      options: { target: { kind: 'stdio', command: 'node', args: ['server.js', '--json'] }, json: false, strict: true, timeoutMs: 30_000 },
    });
  });

  it('takes a URL with headers, and a timeout', () => {
    const parsed = parse(['https://example.com/mcp', '--header', 'X-Key: a:b', '--timeout', '5']);

    expect(parsed).toMatchObject({ ok: true, options: { target: { kind: 'http', headers: { 'X-Key': 'a:b' } }, timeoutMs: 5_000 } });
  });

  it.each([
    [[], 'Say which server'],
    [['https://a.example', '--', 'node'], 'one server at a time'],
    [['https://a.example', 'https://b.example'], 'one server at a time'],
    [['server.js'], 'not an http or https URL'],
    [['https://a.example', '--header', 'nocolon'], '"Name: value"'],
    [['--header', 'A: b', '--', 'node'], 'only for a server checked over HTTP'],
    [['https://a.example', '--timeout', 'soon'], 'number of seconds'],
    [['--nope'], "Unknown option '--nope'"],
  ])('refuses %j', async (argv, message) => {
    const { code, err } = await lintWith(argv);

    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(err).toContain('Usage:');
  });

  it('shows help and the version', async () => {
    expect(await lintWith(['--help'])).toMatchObject({ code: 0, out: expect.stringContaining('Usage:') });
    expect(await lintWith(['-v'])).toMatchObject({ code: 0, out: expect.stringMatching(/^\d+\.\d+\.\d+\n$/) });
  });
});
