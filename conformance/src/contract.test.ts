import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLIENT_VERSION,
  connect,
  type Connection,
  eventually,
  EXCEPTION_TYPE,
  type McpClient,
  SERVER_VERSION,
} from './adapter.ts';
import { definitionHash } from './definition.ts';
import { FakeIngest } from './ingest.ts';

/**
 * docs/sdk-contract.md, case by case.
 *
 * Each case names the section it checks, so a failure says which rule an SDK
 * broke. The adapter under test is a real MCP server over stdio, driven here
 * by a real MCP client, reporting to a fake ingest API that records every
 * request and answers however the case needs.
 */

const KEY = 'mcps_conformance_key';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_TOOL = `long_${'x'.repeat(295)}`;

const EVENT_FIELDS = new Set([
  'id',
  'kind',
  'toolName',
  'durationMs',
  'success',
  'errorSource',
  'errorType',
  'errorMessage',
  'clientType',
  'clientName',
  'clientVersion',
  'serverVersion',
  'responseBytes',
  'definitionHash',
  'repeated',
  'timestamp',
  'sdkVersion',
  'sessionId',
  'parameters',
]);

let ingest: FakeIngest;
let endpoint: string;
let open: Connection[] = [];

async function start(options: Omit<Parameters<typeof connect>[0], 'endpoint'> = {}) {
  const connection = await connect({ endpoint, apiKey: KEY, ...options });
  open.push(connection);
  return connection;
}

/**
 * How long a case waits after its calls before leaving: several delivery
 * intervals at the 200 ms the suite configures.
 *
 * So that every case but the one about shutting down (6.6) is delivered by
 * the ordinary interval. Otherwise an SDK that lost its final flush would fail
 * nearly every case at once, and the failure would say nothing about which
 * rule it broke.
 */
const SETTLE_MS = 1_000;

/**
 * Calls tools, waits for delivery, then leaves the way a client does and
 * waits for the adapter to exit. `leaveAtOnce` skips the wait, for the case
 * that is about what happens on leaving.
 */
async function run(
  connection: Connection,
  calls: { name: string; arguments?: Record<string, unknown> }[],
  options: { leaveAtOnce?: boolean } = {},
): Promise<void> {
  for (const call of calls) {
    // A server may answer a call to a missing tool with a protocol error
    // rather than an error result - v2 of the official SDK does - and the
    // client throws it. Either way the call was made, which is what counts.
    await connection.client.callTool(call).catch(() => undefined);
  }
  if (options.leaveAtOnce !== true) await new Promise((done) => setTimeout(done, SETTLE_MS));
  await connection.close();
  open = open.filter((candidate) => candidate !== connection);
}

/** Events from tool calls, leaving out the announcement's empty batch. */
function events(): Record<string, unknown>[] {
  return ingest.accepted;
}

function only(name: string): Record<string, unknown> {
  const matching = events().filter((event) => event['toolName'] === name);
  expect(matching, `events for ${name}`).toHaveLength(1);
  return matching[0] as Record<string, unknown>;
}

beforeEach(async () => {
  ingest = new FakeIngest();
  endpoint = await ingest.start();
});

afterEach(async () => {
  for (const connection of open) await connection.close();
  open = [];
  await ingest.stop();
});

describe('2. Configuration', () => {
  it('does nothing at all without an API key', async () => {
    const connection = await connect({ endpoint });
    open.push(connection);

    await run(connection, [{ name: 'ok' }, { name: 'throws' }]);

    expect(ingest.requests).toEqual([]);
  });

  it('with a key and no endpoint, collects nothing and says once what is missing', async () => {
    const connection = await connect({ apiKey: 'mk_conformance' });
    open.push(connection);

    const answer = await connection.client.callTool({ name: 'ok' });
    await run(connection, [{ name: 'ok' }, { name: 'throws' }]);

    expect(answer.isError).not.toBe(true);
    expect(ingest.requests).toEqual([]);
    const lines = connection.stderr().split('\n').filter((line) => line.includes('MCPSPAN_ENDPOINT'));
    expect(lines).toHaveLength(1);
  });
});

describe('3.1 Tool calls that reach a handler', () => {
  it('records a success', async () => {
    await run(await start(), [{ name: 'ok' }]);

    const event = only('ok');
    expect(event['success']).toBe(true);
    expect(event).not.toHaveProperty('errorSource');
  });

  it('records a result marked isError as a failure from the result', async () => {
    await run(await start(), [{ name: 'reported_error' }]);

    expect(only('reported_error')).toMatchObject({
      success: false,
      errorSource: 'result',
      errorMessage: 'No flights found',
    });
  });

  it('records a thrown error as an exception, and the client still gets its error', async () => {
    const connection = await start();
    // An error result in most MCP SDKs; a protocol error in some, as mcp-go
    // answers a Go handler's error. Either way the client is told.
    const toldOfError = await connection.client
      .callTool({ name: 'throws' })
      .then((result) => result.isError === true, () => true);
    await run(connection, []);

    expect(toldOfError).toBe(true);
    expect(only('throws')).toMatchObject({
      success: false,
      errorSource: 'exception',
      errorType: EXCEPTION_TYPE,
      errorMessage: 'boom',
    });
  });
});

describe('3.1 Tools registered before instrumentation', () => {
  it('records a call to a tool registered before the SDK instrumented the server', async () => {
    await run(await start(), [{ name: 'early' }]);

    expect(only('early')).toMatchObject({ success: true });
  });
});

describe('3.2 Calls the server refuses', () => {
  it('records refused arguments under the tool, with no message', async () => {
    await run(await start(), [
      { name: 'typed', arguments: { destination: 'WAW', passengers: 'two' } },
    ]);

    const event = only('typed');
    expect(event).toMatchObject({ success: false, errorSource: 'arguments' });
    expect(event).not.toHaveProperty('errorMessage');
  });

  it('records a call to a tool the server lacks, under the name asked for', async () => {
    await run(await start(), [{ name: 'no_such_tool' }]);

    expect(only('no_such_tool')).toMatchObject({ success: false, errorSource: 'unknown_tool' });
  });
});

describe('3.3 Tools left out', () => {
  it('records nothing for an excluded tool, not even a refused call', async () => {
    await run(await start(), [
      { name: 'excluded', arguments: { depth: 1 } },
      { name: 'excluded', arguments: { depth: 'deep' } },
      { name: 'ok' },
    ]);

    expect(events().map((event) => event['toolName'])).toEqual(['ok']);
  });
});

describe('3.4 The announcement', () => {
  it('sends one empty batch at start, before any tool is called', async () => {
    const connection = await start();

    await eventually('the announcement', () => ingest.requests.length > 0);

    expect(ingest.requests[0]?.events).toEqual([]);
    expect(JSON.parse(ingest.requests[0]?.raw ?? '')).toEqual({ events: [] });
    await run(connection, []);
    expect(ingest.requests.filter((request) => request.events.length === 0)).toHaveLength(1);
  });
});

describe('3.5 Resources and prompts', () => {
  /** Does what the case asks of the client, then waits for delivery and leaves, as run() does. */
  async function act(connection: Connection, ...steps: ((client: McpClient) => Promise<unknown>)[]): Promise<void> {
    for (const step of steps) {
      // A missing resource or prompt comes back as a protocol error, which the client throws.
      await step(connection.client).catch(() => undefined);
    }
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    await connection.close();
    open = open.filter((candidate) => candidate !== connection);
  }

  /** Every byte the SDK sent, for checks that a value appears nowhere in it. */
  function everythingSent(): string {
    return ingest.requests.map((request) => request.raw).join('\n');
  }

  it('records a read of a resource at a fixed address, named by that address', async () => {
    await act(await start(), (client) => client.readResource({ uri: 'config://app' }));

    expect(only('config://app')).toMatchObject({ kind: 'resource', success: true });
  });

  it('names a read through a template by the template, never by the address asked for', async () => {
    await act(await start({ captureParameters: true }), (client) =>
      client.readResource({ uri: 'trips://secret-4412' }),
    );

    expect(only('trips://{id}')).toMatchObject({ kind: 'resource', success: true, parameters: { id: 'string' } });
    expect(everythingSent()).not.toContain('secret-4412');
  });

  it('names a read of a resource the server lacks by its scheme alone', async () => {
    await act(await start(), (client) => client.readResource({ uri: 'db://customers/lovelace' }));

    const event = only('db://');
    expect(event).toMatchObject({ kind: 'resource', success: false, errorSource: 'unknown_resource' });
    expect(event).not.toHaveProperty('errorMessage');
    expect(everythingSent()).not.toContain('lovelace');
  });

  it('records a resource that throws as an exception', async () => {
    await act(await start(), (client) => client.readResource({ uri: 'broken://status' }));

    expect(only('broken://status')).toMatchObject({
      kind: 'resource',
      success: false,
      errorSource: 'exception',
      errorType: EXCEPTION_TYPE,
      errorMessage: 'boom',
    });
  });

  it('records a prompt got, with its arguments named and typed when asked, never their values', async () => {
    await act(await start({ captureParameters: true }), (client) =>
      client.getPrompt({ name: 'plan_trip', arguments: { destination: 'Lisbon-4412' } }),
    );

    expect(only('plan_trip')).toMatchObject({ kind: 'prompt', success: true, parameters: { destination: 'string' } });
    expect(everythingSent()).not.toContain('Lisbon-4412');
  });

  it('records a prompt got without an argument it requires as the server answered it', async () => {
    // Most MCP SDKs refuse it before the prompt's function runs, and that is
    // refused arguments. Some (the official Go SDK) leave required arguments
    // to the prompt's own handler; then there was no refusal, and recording
    // one would be recording something the client never saw.
    let refused = false;
    await act(await start(), (client) =>
      client.getPrompt({ name: 'plan_trip', arguments: {} }).catch((error: unknown) => {
        refused = true;
        throw error;
      }),
    );

    const event = only('plan_trip');
    if (refused) {
      expect(event).toMatchObject({ kind: 'prompt', success: false, errorSource: 'arguments' });
      expect(event).not.toHaveProperty('errorMessage');
    } else {
      expect(event).toMatchObject({ kind: 'prompt', success: true });
    }
  });

  it('records a prompt the server lacks under the name asked for', async () => {
    await act(await start(), (client) => client.getPrompt({ name: 'translate' }));

    expect(only('translate')).toMatchObject({ kind: 'prompt', success: false, errorSource: 'unknown_prompt' });
  });

  it('records a prompt that throws as an exception', async () => {
    await act(await start(), (client) => client.getPrompt({ name: 'broken_prompt' }));

    expect(only('broken_prompt')).toMatchObject({
      kind: 'prompt',
      success: false,
      errorSource: 'exception',
      errorType: EXCEPTION_TYPE,
      errorMessage: 'boom',
    });
  });

  it('records no listing, and marks a tool call as a tool or not at all', async () => {
    await act(
      await start(),
      (client) => client.listResources(),
      (client) => client.listPrompts(),
      (client) => client.callTool({ name: 'ok' }),
    );

    expect(events()).toHaveLength(1);
    expect(only('ok')['kind'] ?? 'tool').toBe('tool');
  });

  it('puts a read and a get in the session of the connection they came on', async () => {
    await act(
      await start({ clientName: 'cursor' }),
      (client) => client.callTool({ name: 'ok' }),
      (client) => client.readResource({ uri: 'config://app' }),
      (client) => client.getPrompt({ name: 'plan_trip', arguments: { destination: 'Lisbon' } }),
    );

    expect(events()).toHaveLength(3);
    expect(new Set(events().map((event) => event['sessionId'])).size).toBe(1);
    expect(events().every((event) => event['clientType'] === 'cursor')).toBe(true);
  });
});

describe('3.6 Versions', () => {
  it('says which version of the server answered, as the server gives itself', async () => {
    await run(await start(), [{ name: 'ok' }]);

    expect(only('ok')['serverVersion']).toBe(SERVER_VERSION);
  });

  it('prefers a version the SDK was given to the one the server gives itself', async () => {
    await run(await start({ serverVersion: 'release-2026.09.28' }), [{ name: 'ok' }]);

    expect(only('ok')['serverVersion']).toBe('release-2026.09.28');
  });

  it("records the client's version as the client gives it", async () => {
    await run(await start(), [{ name: 'ok' }, { name: 'no_such_tool' }]);

    expect(events().map((event) => event['clientVersion'])).toEqual([CLIENT_VERSION, CLIENT_VERSION]);
  });
});

describe('3.7 Response size', () => {
  /** What the large tool answers with: its text alone, before the result's own wrapping. */
  const LARGE = 100_000;

  it('measures every answer, from a few bytes to a large one', async () => {
    await run(await start(), [{ name: 'ok' }, { name: 'reported_error' }, { name: 'large' }]);

    const ok = only('ok')['responseBytes'];
    expect(Number.isInteger(ok) && (ok as number) > 0 && (ok as number) < 1000, String(ok)).toBe(true);
    expect(only('reported_error')['responseBytes']).toEqual(expect.any(Number));
    // The text plus a little JSON around it; or twice the text, from a server that sends it as
    // structured content too (FastMCP does, for a tool typed as returning a string). What the client got.
    const large = only('large')['responseBytes'] as number;
    const near = (target: number) => large >= target && large < target + 1000;
    expect(near(LARGE) || near(2 * LARGE), String(large)).toBe(true);
  });

  it('has nothing to measure when no answer came back', async () => {
    await run(await start(), [
      { name: 'throws' },
      { name: 'typed', arguments: { destination: 'WAW', passengers: 'two' } },
      { name: 'no_such_tool' },
    ]);

    for (const name of ['throws', 'typed', 'no_such_tool']) expect(only(name)).not.toHaveProperty('responseBytes');
  });

  it('measures what a resource read and a prompt get answered too', async () => {
    const connection = await start();
    // As in 3.5: a client may refuse the answer's shape, which does not change what the server sent.
    await connection.client.readResource({ uri: 'config://app' }).catch(() => undefined);
    await connection.client.getPrompt({ name: 'plan_trip', arguments: { destination: 'Lisbon' } }).catch(() => undefined);
    await run(connection, []);

    expect(only('config://app')['responseBytes']).toEqual(expect.any(Number));
    expect(only('plan_trip')['responseBytes']).toEqual(expect.any(Number));
  });
});

describe('3.8 Tool definitions', () => {
  it('fingerprints the shared cases as every SDK must', () => {
    const shared = JSON.parse(readFileSync(new URL('../definition-hashes.json', import.meta.url), 'utf8')) as {
      cases: { case: string; tool: Record<string, unknown>; hash: string }[];
    };

    for (const { case: name, tool, hash } of shared.cases) expect(definitionHash(tool), name).toBe(hash);
  });

  it('marks each call with the fingerprint of the tool as the server listed it', async () => {
    const connection = await start();
    const { tools } = await connection.client.listTools();
    await run(connection, [{ name: 'ok' }, { name: 'ok' }, { name: 'typed', arguments: { destination: 'WAW', passengers: 2 } }]);

    const listed = (name: string) => definitionHash(tools.find((tool) => tool['name'] === name) ?? {});
    const ok = events().filter((event) => event['toolName'] === 'ok');
    expect(ok.map((event) => event['definitionHash'])).toEqual([listed('ok'), listed('ok')]);
    expect(only('typed')['definitionHash']).toBe(listed('typed'));
    expect(listed('ok')).not.toBe(listed('typed'));
  });

  it('fingerprints no unknown tool, resource or prompt', async () => {
    const connection = await start();
    await connection.client.listTools();
    await connection.client.readResource({ uri: 'config://app' }).catch(() => undefined);
    await connection.client.getPrompt({ name: 'plan_trip', arguments: { destination: 'Lisbon' } }).catch(() => undefined);
    await run(connection, [{ name: 'no_such_tool' }]);

    for (const name of ['no_such_tool', 'config://app', 'plan_trip']) expect(only(name)).not.toHaveProperty('definitionHash');
  });
});

describe('3.9 Repeated calls', () => {
  const WAW = { destination: 'WAW', passengers: 2 };

  /** Each event's `repeated`, in the order the calls were made. */
  function repeats(): unknown[] {
    return events().map((event) => event['repeated']);
  }

  it('marks a call with the same arguments as the previous call to the same tool in the session', async () => {
    await run(await start(), [
      { name: 'typed', arguments: WAW },
      { name: 'typed', arguments: { passengers: 2, destination: 'WAW' } },
      { name: 'typed', arguments: { destination: 'KRK', passengers: 2 } },
      { name: 'ok' },
      { name: 'typed', arguments: { destination: 'KRK', passengers: 2 } },
    ]);

    // The same object in another key order is the same arguments; another tool in between changes nothing.
    expect(repeats()).toEqual([undefined, true, undefined, undefined, true]);
  });

  it('marks a refused call repeated as well: the same bad arguments, or the same unknown tool', async () => {
    await run(await start(), [
      { name: 'typed', arguments: { destination: 'WAW', passengers: 'two' } },
      { name: 'typed', arguments: { destination: 'WAW', passengers: 'two' } },
      { name: 'no_such_tool', arguments: { q: 1 } },
      { name: 'no_such_tool', arguments: { q: 1 } },
    ]);

    expect(repeats()).toEqual([undefined, true, undefined, true]);
  });

  it('never compares calls from two sessions', async () => {
    await run(await start(), [{ name: 'typed', arguments: WAW }]);
    await run(await start(), [{ name: 'typed', arguments: WAW }]);

    expect(repeats()).toEqual([undefined, undefined]);
  });

  it('sends whether a call repeated, and nothing of its arguments', async () => {
    const secret = { destination: 'secret-4412', passengers: 7 };
    await run(await start(), [
      { name: 'typed', arguments: secret },
      { name: 'typed', arguments: secret },
    ]);

    const sent = ingest.requests.map((request) => request.raw).join('\n');
    expect(repeats()).toEqual([undefined, true]);
    expect(sent).not.toContain('secret-4412');
    // Not even a digest of them, in any of the usual encodings.
    for (const text of ['{"destination":"secret-4412","passengers":7}', '{"passengers":7,"destination":"secret-4412"}']) {
      const digest = createHash('sha256').update(text).digest();
      for (const encoded of [digest.toString('hex'), digest.toString('base64'), digest.toString('hex').slice(0, 16)]) {
        expect(sent).not.toContain(encoded);
      }
    }
  });
});

describe('4. The event', () => {
  it('carries every required field, well formed, and nothing else', async () => {
    await run(await start({ clientName: 'claude-code' }), [
      { name: 'ok' },
      { name: 'reported_error' },
    ]);

    for (const event of events()) {
      expect(Object.keys(event).every((key) => EVENT_FIELDS.has(key)), JSON.stringify(event)).toBe(
        true,
      );
      expect(event['id']).toMatch(UUID);
      expect(typeof event['toolName']).toBe('string');
      expect(Number.isFinite(event['durationMs'])).toBe(true);
      expect(event['durationMs'] as number).toBeGreaterThanOrEqual(0);
      expect(typeof event['success']).toBe('boolean');
      expect(event['clientType']).toBe('claude-code');
      expect(event['clientName']).toBe('claude-code');
      expect(String(event['timestamp'])).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/);
      expect(String(event['sdkVersion']).length).toBeGreaterThan(0);
    }
  });

  it('gives every event its own id', async () => {
    await run(await start(), [{ name: 'ok' }, { name: 'ok' }, { name: 'ok' }]);

    expect(new Set(events().map((event) => event['id'])).size).toBe(3);
  });

  it('cuts a tool name over 200 characters rather than losing the batch', async () => {
    await run(await start(), [{ name: 'ok' }, { name: LONG_TOOL }]);

    const names = events().map((event) => String(event['toolName']));
    expect(names).toContain('ok');
    expect(names.every((name) => name.length <= 200)).toBe(true);
    expect(names.some((name) => name.startsWith('long_'))).toBe(true);
  });

  it("cuts a client's name over 200 characters", async () => {
    await run(await start({ clientName: `c${'x'.repeat(400)}` }), [{ name: 'ok' }]);

    expect(String(only('ok')['clientName']).length).toBeLessThanOrEqual(200);
  });
});

describe('5. Privacy', () => {
  it('records no parameters unless asked to', async () => {
    await run(await start(), [
      { name: 'typed', arguments: { destination: 'secret-destination', passengers: 2 } },
    ]);

    expect(only('typed')).not.toHaveProperty('parameters');
    expect(ingest.requests.some((request) => request.raw.includes('secret-destination'))).toBe(
      false,
    );
  });

  it('records names and types when asked, and never a value', async () => {
    await run(await start({ captureParameters: true }), [
      { name: 'typed', arguments: { destination: 'secret-destination', passengers: 2 } },
      { name: 'typed', arguments: { dest: 'secret-refused', passengers: 'two' } },
    ]);

    const [accepted, refused] = events();
    expect(accepted?.['parameters']).toEqual({ destination: 'string', passengers: 'number' });
    expect(refused?.['parameters']).toEqual({ dest: 'string', passengers: 'string' });
    expect(ingest.requests.some((request) => /secret-/.test(request.raw))).toBe(false);
  });
});

describe('6.1 The request', () => {
  it('posts JSON to /v1/events with the key and a User-Agent naming the SDK', async () => {
    await run(await start(), [{ name: 'ok' }]);

    for (const request of ingest.requests) {
      expect(request.method).toBe('POST');
      expect(request.path).toBe('/v1/events');
      expect(request.headers['authorization']).toBe(`Bearer ${KEY}`);
      expect(request.headers['content-type']).toMatch(/^application\/json/);
      expect(request.headers['user-agent']).toMatch(/^mcpspan\/[\w.+-]+( \([a-z]+\))?$/);
    }
  });
});

describe('6.2 Batching', () => {
  it('keeps every request within the limits the API takes', async () => {
    const connection = await start();
    for (let call = 0; call < 250; call += 1) await connection.client.callTool({ name: 'ok' });
    await run(connection, []);

    expect(events()).toHaveLength(250);
    for (const request of ingest.requests) {
      expect(request.events.length).toBeLessThanOrEqual(1000);
      expect(Buffer.byteLength(request.raw)).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });
});

describe('6.4 Answers', () => {
  it.each([401, 403])('stops for good on %i, and says so on standard error', async (status) => {
    ingest.answerWith(() => ({ status }));

    // Whatever reaches the fake first - the announcement, or a batch if an
    // SDK has none - is refused, and nothing may follow it.
    const connection = await start();
    await connection.client.callTool({ name: 'ok' });
    await eventually('the first refusal', () => ingest.requests.length > 0);
    for (let call = 0; call < 5; call += 1) await connection.client.callTool({ name: 'ok' });
    const stderr = connection.stderr;
    await run(connection, []);

    expect(ingest.requests).toHaveLength(1);
    expect(stderr().length).toBeGreaterThan(0);
  });

  it('drops a batch refused with 400 and keeps collecting', async () => {
    // Everything with events in it is refused until the third such request.
    let withEvents = 0;
    ingest.answerWith((_index, received) => {
      if (received.events.length === 0) return { status: 202 };
      withEvents += 1;
      return { status: withEvents === 1 ? 400 : 202 };
    });

    const connection = await start();
    await connection.client.callTool({ name: 'reported_error' });
    await eventually('the refused batch', () => withEvents === 1);
    await run(connection, [{ name: 'ok' }]);

    // The refused event is not sent again; the later one arrives.
    expect(ingest.sent.filter((event) => event['toolName'] === 'reported_error')).toHaveLength(1);
    expect(events().map((event) => event['toolName'])).toEqual(['ok']);
  });

  it.each([408, 429, 500, 503])('keeps a batch refused with %i and delivers it later', async (status) => {
    let withEvents = 0;
    ingest.answerWith((_index, received) => {
      if (received.events.length === 0) return { status: 202 };
      withEvents += 1;
      return { status: withEvents === 1 ? status : 202 };
    });

    const connection = await start();
    await connection.client.callTool({ name: 'ok' });
    await eventually('the retry', () => withEvents >= 2);
    await run(connection, []);

    const [first, second] = ingest.requests.filter((request) => request.events.length > 0);
    // The same events, by id, so redelivery is harmless.
    expect(second?.events.map((event) => event['id'])).toEqual(
      first?.events.map((event) => event['id']),
    );
  });
});

describe('6.5 Retrying', () => {
  it('waits at least as long as Retry-After asks', async () => {
    let withEvents = 0;
    ingest.answerWith((_index, received) => {
      if (received.events.length === 0) return { status: 202 };
      withEvents += 1;
      return withEvents === 1
        ? { status: 429, headers: { 'retry-after': '3' } }
        : { status: 202 };
    });

    const connection = await start();
    await connection.client.callTool({ name: 'ok' });
    await eventually('the retry', () => withEvents >= 2, 15_000);

    const [refused, retried] = ingest.requests.filter((request) => request.events.length > 0);
    expect((retried?.at ?? 0) - (refused?.at ?? 0)).toBeGreaterThanOrEqual(2_900);
    await run(connection, []);
  });
});

describe('6.6 Shutting down', () => {
  it('sends what is queued when the client leaves, without waiting for the interval', async () => {
    // An interval far longer than the case: only the exit can deliver these.
    const connection = await start({ flushMs: 600_000 });

    await run(connection, [{ name: 'ok' }, { name: 'reported_error' }], { leaveAtOnce: true });

    expect(events().map((event) => event['toolName']).sort()).toEqual(['ok', 'reported_error']);
  });
});

describe('7. Client types', () => {
  // The table itself is in client-types.json, which every SDK's unit tests
  // read. What only a real connection shows is that the name the client sent
  // reaches the table, and reaches the event as sent.
  it.each([
    ['Claude Desktop', 'claude'],
    ['someone-new', 'other'],
  ])('reads %s as %s, and keeps the name as sent', async (name, type) => {
    await run(await start({ clientName: name }), [{ name: 'ok' }]);

    expect(only('ok')).toMatchObject({ clientType: type, clientName: name });
  });
});

describe('8. Sessions', () => {
  it('puts one connection in one session, refused calls included', async () => {
    await run(await start(), [
      { name: 'ok' },
      { name: 'reported_error' },
      { name: 'typed', arguments: {} },
      { name: 'no_such_tool' },
    ]);

    const sessions = new Set(events().map((event) => event['sessionId']));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(UUID);
  });

  it('gives a second connection a session of its own', async () => {
    await run(await start(), [{ name: 'ok' }]);
    await run(await start(), [{ name: 'ok' }]);

    expect(new Set(events().map((event) => event['sessionId'])).size).toBe(2);
  });
});
