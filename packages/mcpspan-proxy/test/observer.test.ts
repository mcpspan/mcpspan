import { beforeEach, describe, expect, it } from 'vitest';

import { definitionHash, forgetListings } from '../../mcpspan/src/definition.js';
import { forgetListingsSent } from '../../mcpspan/src/listings.js';
import { forgetArguments } from '../../mcpspan/src/repeats.js';
import type { ToolCallEvent } from '../../mcpspan/src/types.js';
import { type Connection, Observer, type ObserverOptions } from '../src/observer.js';

const search = {
  name: 'search_flights',
  description: 'Finds flights between two airports.',
  inputSchema: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' }, seats: { type: 'integer', minimum: 1 } },
    required: ['from', 'to'],
  },
};
const book = { name: 'book_flight', description: 'Books a seat.', inputSchema: { type: 'object' } };

let events: ToolCallEvent[];
let nextId: number;

beforeEach(() => {
  events = [];
  nextId = 1;
  forgetListings();
  forgetListingsSent();
  forgetArguments();
});

function observe(options: Partial<ObserverOptions> = {}): Observer {
  return new Observer({ record: (event) => events.push(event), ...options });
}

/** One request from the client and the server's answer to it. */
function exchange(connection: Connection, method: string, params: object, answer: object): void {
  const id = nextId++;
  connection.fromClient({ jsonrpc: '2.0', id, method, params });
  connection.fromServer({ jsonrpc: '2.0', id, ...answer });
}

const call = (connection: Connection, name: string, args: object | undefined, answer: object) =>
  exchange(connection, 'tools/call', { name, ...(args !== undefined && { arguments: args }) }, answer);

const ok = { result: { content: [{ type: 'text', text: 'Found 3 flights.' }] } };
const failed = (text: string) => ({ result: { isError: true, content: [{ type: 'text', text }] } });
const protocolError = (code: number, message: string) => ({ error: { code, message } });

/** A connection that has been through the handshake and listed the tools. */
function started(observer: Observer, sessionId: string | null = 'session-1', tools: object[] = [search, book]): Connection {
  const connection = observer.connection(sessionId ?? undefined);
  exchange(
    connection,
    'initialize',
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } },
    { result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'flights', version: '1.4.0' } } },
  );
  connection.fromClient({ jsonrpc: '2.0', method: 'notifications/initialized' });
  exchange(connection, 'tools/list', {}, { result: { tools } });
  events = [];
  return connection;
}

describe('tool calls', () => {
  it('records a call that succeeded, with who called and which version answered', () => {
    const connection = started(observe());
    call(connection, 'search_flights', { from: 'WAW', to: 'LIS' }, ok);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      toolName: 'search_flights',
      durationMs: expect.any(Number),
      success: true,
      clientType: 'unknown',
      clientName: 'claude-code',
      clientVersion: '2.1.0',
      serverVersion: '1.4.0',
      timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      sdkVersion: expect.stringMatching(/^proxy \d+\.\d+\.\d+$/),
      sessionId: 'session-1',
      responseBytes: JSON.stringify(ok.result).length,
      definitionHash: definitionHash(search),
    });
  });

  it('records an error the tool returned, with its text unless told not to', () => {
    call(started(observe()), 'book_flight', {}, failed('No seats left on that flight.'));
    expect(events[0]).toMatchObject({ success: false, errorSource: 'result', errorMessage: 'No seats left on that flight.' });
    expect(events[0]?.errorType).toBeUndefined();
    expect(events[0]?.responseBytes).toBeGreaterThan(0);

    events = [];
    call(started(observe({ captureErrorMessages: false }), 'session-2'), 'book_flight', {}, failed('No seats left.'));
    expect(events[0]).toMatchObject({ success: false, errorSource: 'result' });
    expect(events[0]).not.toHaveProperty('errorMessage');
  });

  it('records a protocol error as an exception, with its message and no type', () => {
    call(started(observe()), 'book_flight', {}, protocolError(-32603, 'Internal error: database is down'));

    expect(events[0]).toMatchObject({ success: false, errorSource: 'exception', errorMessage: 'Internal error: database is down' });
    expect(events[0]).not.toHaveProperty('errorType');
    expect(events[0]).not.toHaveProperty('responseBytes');
  });

  it('calls a failed call to a tool the server did not list unknown, however it came back', () => {
    const connection = started(observe());
    call(connection, 'cancel_flight', {}, failed('Tool cancel_flight not found'));
    call(connection, 'cancel_flight', {}, protocolError(-32602, 'Tool cancel_flight not found'));

    expect(events.map((event) => event.errorSource)).toEqual(['unknown_tool', 'unknown_tool']);
    expect(events[0]).not.toHaveProperty('errorMessage');
    expect(events[0]).not.toHaveProperty('definitionHash');
  });

  it('does not call a tool unknown before the server has listed its tools', () => {
    const connection = observe().connection('session-1');
    call(connection, 'cancel_flight', {}, failed('Something went wrong.'));

    expect(events[0]).toMatchObject({ errorSource: 'result' });
  });

  it('calls a failure over arguments that break the listed schema a refusal, naming them and not quoting it', () => {
    const connection = started(observe());
    call(connection, 'search_flights', { from: 'WAW', seats: 0 }, failed('Input validation error: seats must be >= 1, got 0'));
    call(connection, 'book_flight', { x: 1 }, protocolError(-32602, 'Invalid arguments for tool book_flight'));

    expect(events[0]).toMatchObject({
      success: false,
      errorSource: 'arguments',
      invalidArguments: ['seats', 'to'],
      definitionHash: definitionHash(search),
    });
    expect(events[0]).not.toHaveProperty('errorMessage');
    expect(events[0]).not.toHaveProperty('responseBytes');
    expect(events[1]).toMatchObject({ errorSource: 'arguments' });
    expect(events[1]).not.toHaveProperty('invalidArguments');
  });

  it('records nothing for an answer that settles nothing yet, or a call cancelled', () => {
    const connection = started(observe());
    call(connection, 'book_flight', {}, { result: { resultType: 'input_required', inputRequests: {} } });
    call(connection, 'book_flight', {}, { result: { task: { taskId: 't1', status: 'working' } } });

    connection.fromClient({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'book_flight' } });
    connection.fromClient({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
    connection.fromServer({ jsonrpc: '2.0', id: 99, result: { content: [] } });

    expect(events).toEqual([]);
  });

  it('marks a call with the same arguments as the previous one to that tool in the session', () => {
    const connection = started(observe());
    call(connection, 'search_flights', { from: 'WAW', to: 'LIS' }, ok);
    call(connection, 'search_flights', { to: 'LIS', from: 'WAW' }, ok);
    call(connection, 'search_flights', { from: 'WAW', to: 'OPO' }, ok);
    call(connection, 'search_flights', { from: 'WAW', to: 'OPO', requestState: 'x' }, ok);

    expect(events.map((event) => event.repeated)).toEqual([undefined, true, undefined, undefined]);
  });

  it('marks no repeats, and sends no session, on a connection without one', () => {
    const connection = started(observe(), null);
    call(connection, 'search_flights', { from: 'WAW', to: 'LIS' }, ok);
    call(connection, 'search_flights', { from: 'WAW', to: 'LIS' }, ok);

    expect(events.map((event) => event.repeated)).toEqual([undefined, undefined]);
    expect(events[0]).not.toHaveProperty('sessionId');
  });

  it('records argument names and types only when asked, never values', () => {
    call(started(observe()), 'search_flights', { from: 'WAW', to: 'LIS', seats: 2 }, ok);
    expect(events[0]).not.toHaveProperty('parameters');

    events = [];
    call(started(observe({ captureParameterNames: true }), 'session-2'), 'search_flights', { from: 'WAW', seats: 2 }, ok);
    expect(events[0]?.parameters).toEqual({ from: 'string', seats: 'number' });
  });

  it('leaves out excluded tools entirely', () => {
    const connection = observe({ exclude: ['book_flight'] }).connection('session-1');
    exchange(connection, 'tools/list', {}, { result: { tools: [search, book] } });
    call(connection, 'book_flight', {}, ok);
    call(connection, 'book_flight', {}, failed('No.'));

    expect(events).toHaveLength(1);
    expect(events[0]?.listedTools?.map((tool) => tool.name)).toEqual(['search_flights']);
  });

  it('takes the version given over the one the server gives itself', () => {
    call(started(observe({ serverVersion: 'abc123' })), 'book_flight', {}, ok);
    expect(events[0]?.serverVersion).toBe('abc123');
  });

  it('reads the client from each request on the 2026-07-28 protocol', () => {
    const connection = observe().connection('session-1');
    connection.fromClient({
      jsonrpc: '2.0',
      id: 'a',
      method: 'tools/call',
      params: { name: 'book_flight', _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'cursor', version: '3.0' } } },
    });
    connection.fromServer({ jsonrpc: '2.0', id: 'a', result: { content: [] } });

    expect(events[0]).toMatchObject({ clientName: 'cursor', clientVersion: '3.0' });
  });
});

describe('the messages themselves', () => {
  it('pairs answers by id, keeping 1 and "1" apart', () => {
    const connection = started(observe());
    connection.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_flights' } });
    connection.fromClient({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'book_flight' } });
    connection.fromServer({ jsonrpc: '2.0', id: '1', result: { content: [] } });
    connection.fromServer({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [] } });

    expect(events.map((event) => [event.toolName, event.success])).toEqual([
      ['book_flight', true],
      ['search_flights', false],
    ]);
  });

  it('reads batches, and lets past what it cannot read without a sound', () => {
    const connection = started(observe());
    connection.fromClient([
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'book_flight' } },
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'search_flights' } },
    ]);
    connection.fromServer([
      { jsonrpc: '2.0', id: 7, result: {} },
      { jsonrpc: '2.0', id: 8, result: {} },
    ]);

    for (const junk of [null, 'text', 42, [], [null], { id: 7 }, { method: 5 }, { jsonrpc: '2.0', id: {}, method: 'tools/call' }]) {
      expect(() => connection.fromClient(junk)).not.toThrow();
      expect(() => connection.fromServer(junk)).not.toThrow();
    }
    expect(events).toHaveLength(2);
  });

  it('leaves alone what the server asks the client, and the client answers', () => {
    const connection = started(observe());
    connection.fromClient({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'book_flight' } });
    // The server asks the client something under the same id, and the client answers it.
    connection.fromServer({ jsonrpc: '2.0', id: 5, method: 'elicitation/create', params: {} });
    connection.fromClient({ jsonrpc: '2.0', id: 5, result: { action: 'accept' } });
    expect(events).toEqual([]);

    connection.fromServer({ jsonrpc: '2.0', id: 5, result: { content: [] } });
    expect(events).toHaveLength(1);
  });

  it('forgets what was waiting when the connection closes', () => {
    const connection = started(observe());
    connection.fromClient({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'book_flight' } });
    connection.close();
    connection.fromServer({ jsonrpc: '2.0', id: 3, result: {} });

    expect(events).toEqual([]);
  });
});

describe('listings', () => {
  it('records what the server listed, once per session for the same answer', () => {
    const observer = observe();
    const connection = observer.connection('session-1');
    exchange(connection, 'tools/list', {}, { result: { tools: [search, book] } });
    exchange(connection, 'tools/list', {}, { result: { tools: [search, book] } });
    exchange(connection, 'tools/list', {}, { result: { tools: [search] } });
    exchange(observer.connection('session-2'), 'tools/list', {}, { result: { tools: [search, book] } });

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: 'listing', toolName: 'tools/list', durationMs: 0, success: true, sessionId: 'session-1' });
    expect(events[0]?.listedTools).toEqual([
      { name: 'search_flights', definitionHash: definitionHash(search), definitionBytes: expect.any(Number) },
      { name: 'book_flight', definitionHash: definitionHash(book), definitionBytes: expect.any(Number) },
    ]);
  });

  it('records a listing in pages as a listing per page, and knows the tools only once the last has come', () => {
    const connection = observe().connection('session-1');
    exchange(connection, 'tools/list', {}, { result: { tools: [search], nextCursor: 'p2' } });
    call(connection, 'book_flight', {}, failed('Failed.'));
    exchange(connection, 'tools/list', { cursor: 'p2' }, { result: { tools: [book] } });
    call(connection, 'cancel_flight', {}, failed('Not found.'));
    call(connection, 'search_flights', {}, failed('Failed.'));

    expect(events.map((event) => event.kind ?? event.errorSource)).toEqual(['listing', 'result', 'listing', 'unknown_tool', 'arguments']);
  });

  it('forgets a tool the server stopped listing', () => {
    const connection = started(observe());
    exchange(connection, 'tools/list', {}, { result: { tools: [search] } });
    events = [];
    call(connection, 'book_flight', {}, failed('Not found.'));

    expect(events[0]?.errorSource).toBe('unknown_tool');
  });
});

describe('resources and prompts', () => {
  function listed(observer: Observer): Connection {
    const connection = observer.connection('session-1');
    exchange(connection, 'resources/list', {}, { result: { resources: [{ uri: 'config://app', name: 'config' }] } });
    exchange(connection, 'resources/templates/list', {}, {
      result: { resourceTemplates: [{ uriTemplate: 'users://{id}/profile', name: 'profile' }, { uriTemplate: 'file:///{+path}', name: 'files' }] },
    });
    exchange(connection, 'prompts/list', {}, { result: { prompts: [{ name: 'summarise' }] } });
    return connection;
  }
  const read = (connection: Connection, uri: string, answer: object) => exchange(connection, 'resources/read', { uri }, answer);
  const get = (connection: Connection, name: string, args: object, answer: object) =>
    exchange(connection, 'prompts/get', { name, arguments: args }, answer);
  const contents = { result: { contents: [{ uri: 'x', text: 'hello' }] } };

  it('names a read by the fixed address or the template, never the address asked for', () => {
    const connection = listed(observe({ captureParameterNames: true }));
    read(connection, 'config://app', contents);
    read(connection, 'users://4412/profile', contents);
    read(connection, 'file:///home/ada/contract.pdf', contents);

    expect(events.map((event) => [event.kind, event.toolName, event.success])).toEqual([
      ['resource', 'config://app', true],
      ['resource', 'users://{id}/profile', true],
      ['resource', 'file:///{+path}', true],
    ]);
    expect(events[1]?.parameters).toEqual({ id: 'string' });
    expect(events[0]?.responseBytes).toBe(JSON.stringify(contents.result).length);
  });

  it('names a read of something the server does not have by its scheme', () => {
    const connection = listed(observe());
    read(connection, 'db://customers/4412', protocolError(-32602, 'Resource db://customers/4412 not found'));
    read(connection, 'users://4412/settings', protocolError(-32002, 'Resource not found'));

    expect(events.map((event) => [event.toolName, event.errorSource])).toEqual([
      ['db://', 'unknown_resource'],
      ['users://', 'unknown_resource'],
    ]);
    expect(JSON.stringify(events)).not.toContain('4412');
  });

  it('names a read by its scheme while the server has listed nothing, and fails it as an exception', () => {
    const connection = observe().connection('session-1');
    read(connection, 'users://4412/profile', contents);
    read(connection, 'users://4412/profile', protocolError(-32603, 'Database is down'));

    expect(events.map((event) => [event.toolName, event.success, event.errorSource])).toEqual([
      ['users://', true, undefined],
      ['users://', false, 'exception'],
    ]);
  });

  it('records prompts got, refused or unknown', () => {
    const connection = listed(observe({ captureParameterNames: true }));
    get(connection, 'summarise', { text: 'long' }, { result: { messages: [] } });
    get(connection, 'summarise', {}, protocolError(-32602, 'Invalid arguments for prompt summarise'));
    get(connection, 'translate', {}, protocolError(-32602, 'Prompt translate not found'));
    get(connection, 'summarise', { text: 'x' }, protocolError(-32603, 'Model unavailable'));

    expect(events.map((event) => [event.kind, event.toolName, event.success, event.errorSource])).toEqual([
      ['prompt', 'summarise', true, undefined],
      ['prompt', 'summarise', false, 'arguments'],
      ['prompt', 'translate', false, 'unknown_prompt'],
      ['prompt', 'summarise', false, 'exception'],
    ]);
    expect(events[0]?.parameters).toEqual({ text: 'string' });
    expect(events[3]?.errorMessage).toBe('Model unavailable');
  });
});

describe('before the server has listed anything', () => {
  it("tells a refusal by the official MCP SDKs' own words, and leaves other failures as they are", () => {
    const connection = observe().connection('session-1');
    call(connection, 'cancel_flight', {}, protocolError(-32602, 'MCP error -32602: Tool cancel_flight not found'));
    call(connection, 'cancel_flight', {}, failed('Tool cancel_flight is disabled'));
    call(connection, 'book_flight', {}, failed('Input validation error: Invalid arguments for tool book_flight'));
    call(connection, 'book_flight', {}, protocolError(-32602, 'Invalid params'));
    call(connection, 'book_flight', {}, failed('Flight not available.'));
    exchange(connection, 'resources/read', { uri: 'db://customers/1' }, protocolError(-32602, 'Resource db://customers/1 not found'));
    exchange(connection, 'prompts/get', { name: 'translate' }, protocolError(-32602, 'Prompt translate not found'));

    expect(events.map((event) => [event.toolName, event.errorSource])).toEqual([
      ['cancel_flight', 'unknown_tool'],
      ['cancel_flight', 'unknown_tool'],
      ['book_flight', 'arguments'],
      ['book_flight', 'arguments'],
      ['book_flight', 'result'],
      ['db://', 'unknown_resource'],
      ['translate', 'unknown_prompt'],
    ]);
  });

  it('goes by the list, not the words, once there is one', () => {
    const connection = started(observe());
    call(connection, 'book_flight', {}, failed('Seat not found.'));

    expect(events[0]?.errorSource).toBe('result');
  });
});
