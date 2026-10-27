import { createHash, randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool, getPool } from '../db.ts';
import { isPublicAddress } from '../oauth-clients.ts';
import { acceptableRedirectUri } from '../oauth.ts';

/**
 * Signing in to /mcp with OAuth, as claude.ai or Claude Code does it: find the
 * metadata, register, send the person to the dashboard to say yes, trade the
 * code for tokens, ask /mcp, refresh. And the ways that must not work.
 */

const ORIGIN = 'https://api.mcpspan.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/** Client documents "on the internet", keyed by their address. */
const documents = new Map<string, unknown>();

const app = createApp({
  oauth: {
    dashboardUrl: 'https://app.mcpspan.test/',
    fetchClientDocument: async (url) => {
      if (!documents.has(url.href)) throw new Error('not found');

      return documents.get(url.href);
    },
  },
});

let account: TestAccount;

const call = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init);

const form = (values: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(values).toString(),
});

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');

  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(metadata: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const response = await call('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...metadata,
    }),
  });

  expect(response.status).toBe(201);

  return (await response.json()) as Record<string, string>;
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-from-the-app',
    resource: `${ORIGIN}/mcp`,
    scope: 'read',
    ...extra,
  };
}

/** The dashboard asking on the person's behalf, as the consent page will. */
async function consent(params: Record<string, string>, approve = true, cookie = account.cookie) {
  const response = await call('/v1/oauth/authorize', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ params, approve }),
  });

  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

async function codeFor(clientId: string, challenge: string): Promise<string> {
  const { body } = await consent(authorizeParams(clientId, challenge));
  const back = new URL(body['redirect'] as string);

  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('state-from-the-app');

  return back.searchParams.get('code') as string;
}

async function tokens(clientId: string): Promise<Record<string, string | number>> {
  const { verifier, challenge } = pkce();
  const code = await codeFor(clientId, challenge);
  const response = await call(
    '/oauth/token',
    form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');

  return (await response.json()) as Record<string, string | number>;
}

beforeEach(async () => {
  await resetDatabase();
  documents.clear();
  account = await createAccount({ serverName: 'Flights' });
  await seedEvents(account.serverId, [{ toolName: 'search', occurredAt: new Date(Date.now() - 10 * 60 * 1000) }]);
});

afterAll(async () => {
  await closePool();
});

describe('finding the way in', () => {
  it('answers /mcp without a token with where to sign in', async () => {
    const response = await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="read"`,
    );
  });

  it('names the authorization server for /mcp', async () => {
    const metadata = await (await call('/.well-known/oauth-protected-resource/mcp')).json();

    expect(metadata).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ['read'] });
  });

  it('describes the authorization server, with the consent page on the dashboard', async () => {
    const metadata = (await (await call('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;

    expect(metadata).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: 'https://app.mcpspan.test/oauth/authorize',
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });

  it('takes the scheme a proxy in front says the request came over', async () => {
    const response = await app.request('http://api.mcpspan.test/.well-known/oauth-authorization-server', {
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(((await response.json()) as { issuer: string }).issuer).toBe('https://api.mcpspan.test');
  });

  it('lets browser clients read the metadata', async () => {
    const response = await call('/.well-known/oauth-authorization-server', { headers: { origin: 'https://inspector.test' } });

    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('is not there at all without OAuth set up', async () => {
    const plain = createApp();

    expect((await plain.request('/.well-known/oauth-authorization-server')).status).toBe(404);

    const response = await plain.request('/mcp', { method: 'POST', body: '{}' });

    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });
});

describe('signing in, start to finish', () => {
  it('ends with /mcp answering from the account, through a real MCP client', async () => {
    const { client_id: clientId } = await register();
    const issued = await tokens(clientId as string);

    expect(issued).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read' });
    expect(String(issued['access_token'])).toMatch(/^mcpspan_oauth_/);
    expect(String(issued['refresh_token'])).toMatch(/^mcpspan_refresh_/);

    const client = new Client({ name: 'claude-ai', version: '1.0.0' });

    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        fetch: async (input, init) => app.request(String(input), init),
        requestInit: { headers: { authorization: `Bearer ${String(issued['access_token'])}` } },
      }),
    );

    const result = await client.callTool({ name: 'list_servers', arguments: {} });

    expect((result.content as { text: string }[])[0]?.text).toContain('Flights');
    await client.close();
  });

  it('shows the person which app asks and where the answer goes', async () => {
    const { client_id: clientId } = await register();
    const query = new URLSearchParams(authorizeParams(clientId as string, pkce().challenge));
    const response = await call(`/v1/oauth/authorize?${query}`, { headers: { cookie: account.cookie } });

    expect(await response.json()).toEqual({
      client: { name: 'Claude', clientUri: null, redirectHost: 'claude.ai' },
      scope: 'read',
      account: { email: account.email },
    });
  });

  it('tells the app when the person says no', async () => {
    const { client_id: clientId } = await register();
    const { body } = await consent(authorizeParams(clientId as string, pkce().challenge), false);
    const back = new URL(body['redirect'] as string);

    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('refreshes, forgives an app retrying a refresh at once, and ends everything when one is used again later', async () => {
    const { client_id: clientId } = await register();
    const first = await tokens(clientId as string);
    const refresh = (token: unknown) =>
      call('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: String(token), client_id: clientId as string }));

    const second = (await (await refresh(first['refresh_token'])).json()) as Record<string, string>;

    expect(second['access_token']).toMatch(/^mcpspan_oauth_/);
    expect(second['refresh_token']).not.toBe(first['refresh_token']);

    // The first refresh token again at once: an app retrying, so it still works.
    expect((await refresh(first['refresh_token'])).status).toBe(200);

    // Later than the allowance: copied, so the grant ends, new tokens and all.
    await getPool().query(`UPDATE oauth_tokens SET used_at = now() - interval '5 minutes' WHERE used_at IS NOT NULL`);

    expect((await refresh(first['refresh_token'])).status).toBe(400);
    expect((await refresh(second['refresh_token'])).status).toBe(400);

    const mcp = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${second['access_token']}` }, body: '{}' });

    expect(mcp.status).toBe(401);
  });

  it('lists the app in Settings and disconnects it there', async () => {
    const { client_id: clientId } = await register();
    const issued = await tokens(clientId as string);
    const listed = (await (await call('/v1/oauth/apps', { headers: { cookie: account.cookie } })).json()) as {
      apps: { id: string; name: string; redirectHost: string }[];
    };

    expect(listed.apps).toMatchObject([{ name: 'Claude', redirectHost: 'claude.ai' }]);

    const removed = await call(`/v1/oauth/apps/${listed.apps[0]?.id}`, { method: 'DELETE', headers: { cookie: account.cookie } });

    expect(removed.status).toBe(204);

    const mcp = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${String(issued['access_token'])}` }, body: '{}' });

    expect(mcp.status).toBe(401);
  });

  it('revokes on the app\'s request', async () => {
    const { client_id: clientId } = await register();
    const issued = await tokens(clientId as string);

    expect((await call('/oauth/revoke', form({ token: String(issued['refresh_token']), client_id: clientId as string }))).status).toBe(200);

    const mcp = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${String(issued['access_token'])}` }, body: '{}' });

    expect(mcp.status).toBe(401);
  });

  it('works for an app known by its metadata document', async () => {
    const clientId = 'https://app.example.com/oauth/client.json';

    documents.set(clientId, { client_id: clientId, client_name: 'Example IDE', redirect_uris: [REDIRECT] });

    const issued = await tokens(clientId);

    expect(String(issued['access_token'])).toMatch(/^mcpspan_oauth_/);
  });

  it("takes an app that lists more ways in than are offered, as Claude's document does", async () => {
    const clientId = 'https://claude.example/oauth/client.json';

    documents.set(clientId, {
      client_id: clientId,
      client_name: 'Claude',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
      response_types: ['code', 'id_token'],
      token_endpoint_auth_method: 'none',
    });

    expect(String((await tokens(clientId))['access_token'])).toMatch(/^mcpspan_oauth_/);
  });

  it('turns away an app that cannot sign in the way offered here', async () => {
    const clientId = 'https://implicit.example/client.json';

    documents.set(clientId, { client_id: clientId, redirect_uris: [REDIRECT], grant_types: ['implicit'], response_types: ['token'] });

    const { body } = await consent(authorizeParams(clientId, pkce().challenge));

    expect(body['error']).toBe('invalid_client');
  });

  it('makes a confidential app prove itself with its secret', async () => {
    const registered = await register({ token_endpoint_auth_method: 'client_secret_basic' });
    const { verifier, challenge } = pkce();
    const code = await codeFor(registered['client_id'] as string, challenge);
    const exchange = (authorization: string) =>
      call('/oauth/token', {
        ...form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization },
      });
    const basic = (secret: string) => `Basic ${Buffer.from(`${registered['client_id']}:${secret}`).toString('base64')}`;

    expect((await exchange(basic('wrong'))).status).toBe(401);
    expect((await exchange(basic(registered['client_secret'] as string))).status).toBe(200);
  });
});

describe('what must not work', () => {
  it('a code without its PKCE verifier, or with another one', async () => {
    const { client_id: clientId } = await register();
    const { challenge } = pkce();
    const code = await codeFor(clientId as string, challenge);
    const response = await call(
      '/oauth/token',
      form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId as string, code_verifier: pkce().verifier }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('a code used twice, which also ends what the first use made', async () => {
    const { client_id: clientId } = await register();
    const { verifier, challenge } = pkce();
    const code = await codeFor(clientId as string, challenge);
    const exchange = () =>
      call('/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId as string, code_verifier: verifier }));

    const first = (await (await exchange()).json()) as { access_token: string };

    expect((await exchange()).status).toBe(400);

    const mcp = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${first.access_token}` }, body: '{}' });

    expect(mcp.status).toBe(401);
  });

  it("a code traded by another app than the one it was made for", async () => {
    const { client_id: clientId } = await register();
    const { client_id: other } = await register({ client_name: 'Other' });
    const { verifier, challenge } = pkce();
    const code = await codeFor(clientId as string, challenge);
    const response = await call(
      '/oauth/token',
      form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: other as string, code_verifier: verifier }),
    );

    expect(response.status).toBe(400);
  });

  it('a token for another MCP server', async () => {
    const { client_id: clientId } = await register();
    const { verifier, challenge } = pkce();
    const code = await codeFor(clientId as string, challenge);
    const response = await call(
      '/oauth/token',
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId as string,
        code_verifier: verifier,
        resource: 'https://elsewhere.test/mcp',
      }),
    );

    expect(((await response.json()) as { error: string }).error).toBe('invalid_target');
  });

  it('an answer sent to an address the app did not register, without telling that address anything', async () => {
    const { client_id: clientId } = await register();
    const { status, body } = await consent(
      authorizeParams(clientId as string, pkce().challenge, { redirect_uri: 'https://attacker.test/callback' }),
    );

    expect(status).toBe(400);
    expect(body['redirect']).toBeUndefined();
  });

  it('an authorization request without PKCE, told to the app', async () => {
    const { client_id: clientId } = await register();
    const params = authorizeParams(clientId as string, pkce().challenge);

    delete params['code_challenge'];

    const { status, body } = await consent(params);

    expect(status).toBe(400);
    expect(new URL(body['redirect'] as string).searchParams.get('error')).toBe('invalid_request');
  });

  it('an unknown app', async () => {
    const { status, body } = await consent(authorizeParams('mcpspan_client_nobody', pkce().challenge));

    expect(status).toBe(400);
    expect(body['error']).toBe('invalid_client');
  });

  it('a document that names another client_id than its address', async () => {
    const clientId = 'https://app.example.com/oauth/client.json';

    documents.set(clientId, { client_id: 'https://evil.test/client.json', client_name: 'Example', redirect_uris: [REDIRECT] });

    const { body } = await consent(authorizeParams(clientId, pkce().challenge));

    expect(body['error']).toBe('invalid_client');
  });

  it('saying yes without being signed in', async () => {
    const { client_id: clientId } = await register();
    const { status } = await consent(authorizeParams(clientId as string, pkce().challenge), true, 'mcpspan_session=nobody');

    expect(status).toBe(401);
  });

  it('a read token or an OAuth token saying yes for its owner', async () => {
    const { client_id: clientId } = await register();
    const issued = await tokens(clientId as string);
    const response = await call('/v1/oauth/authorize', {
      method: 'POST',
      headers: { authorization: `Bearer ${String(issued['access_token'])}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params: authorizeParams(clientId as string, pkce().challenge), approve: true }),
    });

    expect(response.status).toBe(401);
  });

  it('registering an address a browser would run or read from disk', async () => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'http://example.com/cb', 'https://x.test/cb#frag']) {
      expect(acceptableRedirectUri(uri)).toBe(false);
    }

    for (const uri of ['https://claude.ai/cb', 'http://localhost:33418/callback', 'http://127.0.0.1/cb', 'cursor://anysphere.cursor-mcp/oauth']) {
      expect(acceptableRedirectUri(uri)).toBe(true);
    }
  });

  it('fetching a client document from inside the network', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '172.17.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(address)).toBe(false);
    }

    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
});

describe('a desktop app on a loopback address', () => {
  it('may come back on another port than it registered', async () => {
    const { client_id: clientId } = await register({ redirect_uris: ['http://127.0.0.1/callback'] });
    const { body } = await consent(
      authorizeParams(clientId as string, pkce().challenge, { redirect_uri: 'http://127.0.0.1:53682/callback' }),
    );

    expect(new URL(body['redirect'] as string).port).toBe('53682');
  });
});
