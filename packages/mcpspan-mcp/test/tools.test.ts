import { createApp } from '@mcpspan/core-api/src/app.ts';
import { closePool } from '@mcpspan/core-api/src/db.ts';
import { createAccount, resetDatabase, seedEvents, type TestAccount } from '@mcpspan/core-api/test/fixtures.ts';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../src/api.ts';
import { buildServer } from '../src/server.ts';

/**
 * The MCP server against the real API: an account, a token made the way the
 * dashboard makes it, and an MCP client asking each tool as an agent would.
 */

const app = createApp();
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
let account: TestAccount;
let token: string;

/** The API in this process, reached as the MCP server reaches it over HTTP. */
const viaApp: typeof fetch = async (input, init) => app.request(String(input), init);

async function connect(settings: { token?: string | undefined; fetch?: typeof fetch } = {}): Promise<Client> {
  const api = createApi({
    token: 'token' in settings ? settings.token : token,
    url: 'http://mcpspan.test/',
    fetch: settings.fetch ?? viaApp,
  });
  const client = new Client({ name: 'claude-code', version: '2.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await buildServer(api).connect(serverSide);
  await client.connect(clientSide);

  return client;
}

async function ask(
  name: string,
  args: Record<string, unknown> = {},
  client?: Client,
): Promise<{ data: Record<string, unknown>; text: string; isError: boolean }> {
  const result = await (client ?? (await connect())).callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';

  return {
    text,
    isError: result.isError === true,
    data: result.isError === true ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount({ serverName: 'Flights' });

  const ago = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

  await seedEvents(account.serverId, [
    { toolName: 'search', clientType: 'claude-code', occurredAt: ago(50), sessionId: SESSION, serverVersion: '1.0.0' },
    { toolName: 'search', clientType: 'claude-code', occurredAt: ago(40), sessionId: SESSION, serverVersion: '1.1.0' },
    {
      toolName: 'book',
      clientType: 'cursor',
      occurredAt: ago(30),
      success: false,
      errorSource: 'exception',
      errorType: 'TimeoutError',
      errorMessage: 'Upstream timed out',
      serverVersion: '1.1.0',
    },
    { toolName: 'serch', clientType: 'cursor', occurredAt: ago(20), success: false, errorSource: 'unknown_tool' },
  ]);

  const made = await app.request('/v1/tokens', {
    method: 'POST',
    headers: { cookie: account.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Agent' }),
  });

  token = ((await made.json()) as { token: string }).token;
});

afterAll(async () => {
  await closePool();
});

describe('the tools', () => {
  it('are all there, and all say they only read', async () => {
    const { tools } = await (await connect()).listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'compare_versions',
      'get_overview',
      'get_session',
      'get_tool',
      'get_tool_listing',
      'list_clients',
      'list_errors',
      'list_servers',
      'list_sessions',
      'list_tools',
      'list_unknown_tools',
    ]);

    for (const tool of tools) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
  });

  it('list the servers', async () => {
    const { data } = await ask('list_servers');

    expect(data['servers']).toEqual([
      { id: account.serverId, name: 'Flights', createdAt: expect.any(String) },
    ]);
  });

  it('give an overview of the one server, without naming it', async () => {
    const { data } = await ask('get_overview');

    // The call to a tool the server lacks is counted apart, by list_unknown_tools.
    expect(data).toMatchObject({ server: 'Flights', totalCalls: 3, failedCalls: 1 });
    expect(data['window']).toEqual({ from: expect.any(String), to: expect.any(String) });
  });

  it('rank the tools, and narrow them to a client', async () => {
    const all = await ask('list_tools', { sort: 'calls' });
    const cursor = await ask('list_tools', { client: 'cursor' });

    expect((all.data['tools'] as { toolName: string }[])[0]?.toolName).toBe('search');
    expect((cursor.data['tools'] as { toolName: string }[]).map((t) => t.toolName)).toEqual(['book']);
  });

  it("tell why a tool's calls failed", async () => {
    const { data } = await ask('get_tool', { tool: 'book' });

    expect(data['failures']).toEqual([{ errorSource: 'exception', calls: 1 }]);
    expect(data['messages']).toEqual([
      expect.objectContaining({ message: 'Upstream timed out', calls: 1 }),
    ]);
  });

  it('list the failed calls, newest first', async () => {
    const { data } = await ask('list_errors');
    const failures = data['failures'] as Record<string, unknown>[];

    expect(failures.map((call) => call['toolName'])).toEqual(['serch', 'book']);
    expect(failures[1]).toMatchObject({ clientType: 'cursor', errorType: 'TimeoutError', errorMessage: 'Upstream timed out' });
    expect(failures[1]).not.toHaveProperty('id');
  });

  it('name the tools agents asked for and the server lacks', async () => {
    const { data } = await ask('list_unknown_tools');

    expect(data['tools']).toEqual([expect.objectContaining({ toolName: 'serch', closest: 'search' })]);
  });

  it('compare the clients', async () => {
    const { data } = await ask('list_clients');
    const clients = data['clients'] as { clientType: string; totalCalls: number; errorRate: number }[];

    expect(clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientType: 'claude-code', totalCalls: 2, errorRate: 0 }),
        expect.objectContaining({ clientType: 'cursor', totalCalls: 1, errorRate: 1 }),
      ]),
    );
  });

  it('compare the versions', async () => {
    const { data } = await ask('compare_versions');

    expect((data['versions'] as { version: string }[]).map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
  });

  it('read what agents were shown', async () => {
    const { data, isError } = await ask('get_tool_listing');

    expect(isError).toBe(false);
    expect(data).toMatchObject({ server: 'Flights', tools: [] });
  });

  it('list the sessions, and walk through one', async () => {
    const sessions = await ask('list_sessions');

    expect(sessions.data['sessions']).toEqual([expect.objectContaining({ sessionId: SESSION, calls: 2 })]);

    const one = await ask('get_session', { session: SESSION });

    expect((one.data['calls'] as { toolName: string }[]).map((call) => call.toolName)).toEqual(['search', 'search']);
  });
});

describe('servers and windows', () => {
  it('find a server by name or id, and ask which when there are several', async () => {
    const second = await app.request('/v1/servers', {
      method: 'POST',
      headers: { cookie: account.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hotels' }),
    });
    expect(second.status).toBe(201);

    const unnamed = await ask('get_overview');
    const byName = await ask('get_overview', { server: 'flights' });
    const byId = await ask('get_overview', { server: account.serverId });
    const missing = await ask('get_overview', { server: 'Trains' });

    expect(unnamed).toMatchObject({ isError: true });
    expect(unnamed.text).toContain('Flights, Hotels');
    expect(byName.data).toMatchObject({ server: 'Flights', totalCalls: 3 });
    expect(byId.data).toMatchObject({ server: 'Flights', totalCalls: 3 });
    expect(missing.text).toContain('No server called "Trains"');
  });

  it('look only as far back as asked', async () => {
    const { data } = await ask('get_overview', { from: new Date(Date.now() - 35 * 60 * 1000).toISOString() });

    expect(data).toMatchObject({ totalCalls: 1 });
  });
});

describe('when something is wrong', () => {
  it('says how to get a token when none is set', async () => {
    const result = await ask('list_servers', {}, await connect({ token: undefined }));

    expect(result.isError).toBe(true);
    expect(result.text).toContain('MCPSPAN_READ_TOKEN is not set');
  });

  it('says a revoked token is revoked', async () => {
    const result = await ask('list_servers', {}, await connect({ token: 'mcpspan_read_revoked' }));

    expect(result.isError).toBe(true);
    expect(result.text).toContain('revoked or mistyped');
  });

  it('says an installation from before read tokens needs updating', async () => {
    const old: typeof fetch = async () => Response.json({ error: 'No route for GET /v1/servers' }, { status: 404 });
    const result = await ask('list_servers', {}, await connect({ fetch: old }));

    expect(result.text).toContain('needs mcpspan 0.9.0 or newer');
  });

  it('says where it could not reach', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const result = await ask('list_servers', {}, await connect({ fetch: down }));

    expect(result.text).toContain('Could not reach mcpspan at http://mcpspan.test');
  });
});
