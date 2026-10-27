import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

/**
 * mcpspan's MCP server at /mcp, asked by a real MCP client over HTTP, the way
 * Claude Code or Cursor connect to a URL.
 */

const app = createApp();
let account: TestAccount;
let token: string;

/** The app in this process, reached as a client reaches it over the network. */
const viaApp: typeof fetch = async (input, init) => app.request(String(input), init);

async function connect(bearer: string = token): Promise<Client> {
  const client = new Client({ name: 'claude-code', version: '2.1.4' });

  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://mcpspan.test/mcp'), {
      fetch: viaApp,
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    }),
  );

  return client;
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount({ serverName: 'Flights' });
  await seedEvents(account.serverId, [
    { toolName: 'search', occurredAt: new Date(Date.now() - 10 * 60 * 1000) },
    { toolName: 'book', occurredAt: new Date(Date.now() - 5 * 60 * 1000), success: false, errorSource: 'exception' },
  ]);

  const made = await app.request('/v1/tokens', {
    method: 'POST',
    headers: { cookie: account.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Remote' }),
  });

  token = ((await made.json()) as { token: string }).token;
});

afterAll(async () => {
  await closePool();
});

describe('/mcp', () => {
  it('lists the same tools as mcpspan-mcp', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toContain('list_servers');
    expect(tools).toHaveLength(11);
    expect(client.getServerVersion()?.name).toBe('mcpspan');

    await client.close();
  });

  it("answers from the token owner's servers", async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'get_overview', arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(text)).toMatchObject({ server: 'Flights', totalCalls: 2, failedCalls: 1 });

    await client.close();
  });

  it('turns away a request without a token, saying how to get one', async () => {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer\b/);
    expect(((await response.json()) as { error: string }).error).toContain('Settings → Read tokens');
  });

  it('turns away a revoked or made-up token', async () => {
    await expect(connect('mcpspan_read_not-a-real-token')).rejects.toThrow();

    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
      body: '{}',
    });

    // A server's key writes events; it never reads, here or anywhere.
    expect(response.status).toBe(401);
  });
});
