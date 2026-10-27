import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';

/**
 * Signing in to /mcp with the official MCP SDK's own OAuth client, the code
 * many MCP clients run: discovery from the 401, registration or a client
 * document, PKCE, the code exchange, refreshing. If the SDK can sign in, the
 * server speaks the spec as clients read it, not only as these tests do.
 */

const ORIGIN = 'https://api.mcpspan.test';
const documents = new Map<string, unknown>();
const app = createApp({
  oauth: {
    dashboardUrl: 'https://app.mcpspan.test',
    fetchClientDocument: async (url) => {
      if (!documents.has(url.href)) throw new Error('not found');

      return documents.get(url.href);
    },
  },
});
const viaApp: typeof fetch = async (input, init) => app.request(String(input), init);

let account: TestAccount;

/** An MCP client's own store: what it registered as, its tokens, and where it was sent to sign in. */
function provider(options: { redirect: string; documentUrl?: string }) {
  const store: { client?: unknown; tokens?: unknown; verifier?: string; sentTo?: URL } = {};
  const implementation: OAuthClientProvider = {
    get redirectUrl() {
      return options.redirect;
    },
    ...(options.documentUrl === undefined ? {} : { clientMetadataUrl: options.documentUrl }),
    get clientMetadata() {
      return {
        client_name: 'SDK client',
        redirect_uris: [options.redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    clientInformation: () => store.client as never,
    saveClientInformation: (info) => {
      store.client = info;
    },
    tokens: () => store.tokens as never,
    saveTokens: (tokens) => {
      store.tokens = tokens;
    },
    redirectToAuthorization: (url) => {
      store.sentTo = url;
    },
    saveCodeVerifier: (verifier) => {
      store.verifier = verifier;
    },
    codeVerifier: () => store.verifier as string,
  };

  return { implementation, store };
}

/** The person on the dashboard's page saying yes, which the browser would carry back to the client. */
async function sayYes(sentTo: URL): Promise<URLSearchParams> {
  expect(sentTo.origin + sentTo.pathname).toBe('https://app.mcpspan.test/oauth/authorize');

  const response = await app.request(`${ORIGIN}/v1/oauth/authorize`, {
    method: 'POST',
    headers: { cookie: account.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ params: Object.fromEntries(sentTo.searchParams), approve: true }),
  });
  const { redirect } = (await response.json()) as { redirect: string };

  return new URL(redirect).searchParams;
}

async function signInAndAsk(options: { redirect: string; documentUrl?: string }) {
  const { implementation, store } = provider(options);
  const transport = () => new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: implementation, fetch: viaApp });
  const first = new Client({ name: 'sdk', version: '1.0.0' });
  const signingIn = transport();

  await expect(first.connect(signingIn)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(store.sentTo).toBeDefined();

  await signingIn.finishAuth(await sayYes(store.sentTo as URL));

  const client = new Client({ name: 'sdk', version: '1.0.0' });

  await client.connect(transport());

  const result = await client.callTool({ name: 'list_servers', arguments: {} });

  await client.close();

  return { text: (result.content as { text: string }[])[0]?.text ?? '', store };
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

describe('the MCP SDK signing in', () => {
  it('registers itself (DCR), as Claude Code, ChatGPT and Cursor do, and reads', async () => {
    const { text, store } = await signInAndAsk({ redirect: 'http://localhost:33418/callback' });

    expect(text).toContain('Flights');
    expect(store.sentTo?.searchParams.get('resource')).toBe(`${ORIGIN}/mcp`);
    expect(store.sentTo?.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it("is known by a client document (CIMD), as claude.ai is, and reads", async () => {
    const documentUrl = 'https://client.example/oauth/metadata.json';

    documents.set(documentUrl, {
      client_id: documentUrl,
      client_name: 'SDK client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });

    const { text, store } = await signInAndAsk({ redirect: 'https://client.example/callback', documentUrl });

    expect(text).toContain('Flights');
    expect(store.sentTo?.searchParams.get('client_id')).toBe(documentUrl);
  });
});
