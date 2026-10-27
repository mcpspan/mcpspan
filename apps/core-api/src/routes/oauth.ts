import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';

import { type AccountStore, selfHostedAccounts } from '../accounts.ts';
import {
  type OAuthClient,
  type OAuthFailure,
  SCOPE,
  clientSecretMatches,
  disconnectApp,
  exchangeCode,
  isFailure,
  issueCode,
  listConnectedApps,
  parseClientMetadata,
  redirectHost,
  redirectMatches,
  refreshTokens,
  registerClient,
  revokeToken,
} from '../oauth.ts';
import { type FetchClientDocument, findClient } from '../oauth-clients.ts';
import { requireSession, type SessionVariables } from '../session.ts';

/**
 * Signing in to mcpspan's MCP server from an MCP client, with OAuth 2.1 as the
 * MCP authorization spec asks: metadata to find everything by, registration,
 * and the token endpoint, on the API's public address; the page where the
 * person signs in and says yes is the dashboard's (its address is
 * `dashboardUrl`), which asks the routes at /v1/oauth.
 */
export interface OAuthOptions {
  /** The dashboard as people reach it, which hosts the page that asks them. */
  dashboardUrl: string;
  /** Replaced in tests, which have no apps on the internet to fetch. */
  fetchClientDocument?: FetchClientDocument;
}

/** The longest body any OAuth request needs. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The API as the outside reaches it: the scheme a proxy in front says it was
 * asked over, and the host it was asked for. Everything this server says
 * about its own addresses is built from it, so the metadata matches whatever
 * address a client used, behind a proxy or not.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwarded === 'https' || forwarded === 'http' ? forwarded : url.protocol.slice(0, -1);

  return `${scheme}://${url.host}`;
}

export const mcpResource = (request: Request): string => `${publicOrigin(request)}/mcp`;
export const resourceMetadataUrl = (request: Request): string =>
  `${publicOrigin(request)}/.well-known/oauth-protected-resource/mcp`;

/** The public half: metadata, registration, tokens, revocation. */
export function createOAuthRoutes({ dashboardUrl, fetchClientDocument }: OAuthOptions): Hono {
  const app = new Hono();
  const dashboard = dashboardUrl.replace(/\/+$/, '');

  // Clients in a browser (the MCP Inspector, web IDEs) read these from other
  // origins. Nothing here takes a cookie, so allowing every origin gives a
  // page nothing it could not get with curl.
  const open = cors({ origin: '*', allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version'] });

  app.use('/.well-known/*', open);
  app.use('/oauth/*', open);
  app.use('/oauth/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(oauthError('invalid_request', 'Request too large.'), 413) }));

  // Protected Resource Metadata (RFC 9728): which authorization server signs
  // people in to /mcp. Under the path-suffixed address the 401 from /mcp
  // names, and at the root for clients that only look there.
  const protectedResource = (request: Request) => ({
    resource: mcpResource(request),
    authorization_servers: [publicOrigin(request)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'mcpspan',
    resource_documentation: 'https://mcpspan.com/docs/mcp-server/',
  });

  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResource(c.req.raw)));
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResource(c.req.raw)));

  // Authorization Server Metadata (RFC 8414).
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = publicOrigin(c.req.raw);
    const authMethods = ['none', 'client_secret_basic', 'client_secret_post'];

    return c.json({
      issuer: origin,
      authorization_endpoint: `${dashboard}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: authMethods,
      revocation_endpoint_auth_methods_supported: authMethods,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      service_documentation: 'https://mcpspan.com/docs/mcp-server/',
    });
  });

  // Dynamic Client Registration (RFC 7591).
  app.post('/oauth/register', async (c) => {
    const metadata = parseClientMetadata(await c.req.json().catch(() => undefined));

    if (isFailure(metadata)) return c.json(oauthError(metadata.error, metadata.description), 400);

    const { client, clientSecret, issuedAt } = await registerClient(metadata);

    c.header('cache-control', 'no-store');

    return c.json(
      {
        client_id: client.clientId,
        ...(clientSecret === undefined ? {} : { client_secret: clientSecret, client_secret_expires_at: 0 }),
        client_id_issued_at: issuedAt,
        client_name: client.name,
        ...(client.clientUri === null ? {} : { client_uri: client.clientUri }),
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: metadata.authMethod,
        scope: SCOPE,
      },
      201,
    );
  });

  app.post('/oauth/token', async (c) => {
    c.header('cache-control', 'no-store');
    c.header('pragma', 'no-cache');

    const form = await readForm(c.req.raw);
    const client = await authenticateClient(c.req.raw, form, fetchClientDocument);

    if (isFailure(client)) return c.json(oauthError(client.error, client.description), 401);

    const grantType = form.get('grant_type');
    let issued;

    if (grantType === 'authorization_code') {
      const code = form.get('code');

      if (code === null) return c.json(oauthError('invalid_request', 'code is missing.'), 400);

      issued = await exchangeCode({
        client,
        code,
        redirectUri: form.get('redirect_uri') ?? undefined,
        codeVerifier: form.get('code_verifier') ?? undefined,
        resource: mcpResource(c.req.raw),
        askedResource: form.get('resource') ?? undefined,
      });
    } else if (grantType === 'refresh_token') {
      const refresh = form.get('refresh_token');

      if (refresh === null) return c.json(oauthError('invalid_request', 'refresh_token is missing.'), 400);

      issued = await refreshTokens(client, refresh);
    } else {
      return c.json(oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.'), 400);
    }

    if (isFailure(issued)) return c.json(oauthError(issued.error, issued.description), 400);

    return c.json(issued);
  });

  // Token revocation (RFC 7009): always 200, so it says nothing about which tokens exist.
  app.post('/oauth/revoke', async (c) => {
    const form = await readForm(c.req.raw);
    const client = await authenticateClient(c.req.raw, form, fetchClientDocument);

    if (isFailure(client)) return c.json(oauthError(client.error, client.description), 401);

    const token = form.get('token');

    if (token !== null) await revokeToken(client, token);

    return c.body(null, 200);
  });

  return app;
}

/**
 * The dashboard's half, behind a browser session: checking what an app asks
 * before the person is asked, giving the code once they say yes, and the
 * apps they connected, to see and disconnect.
 */
export function createOAuthAccountRoutes(
  accounts: AccountStore = selfHostedAccounts,
  { fetchClientDocument }: Pick<OAuthOptions, 'fetchClientDocument'> = {},
) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireSession(accounts));

  /** What the app asks, checked, and what to show the person about it. */
  app.get('/authorize', async (c) => {
    const checked = await checkAuthorization(new URL(c.req.url).searchParams, fetchClientDocument);

    if ('failure' in checked) return c.json(checked.failure, 400);

    return c.json({
      client: {
        name: checked.client.name,
        clientUri: checked.client.clientUri,
        redirectHost: redirectHost(checked.redirectUri),
      },
      scope: SCOPE,
      // Who is about to say yes, in case it is not who they think.
      account: { email: c.get('session').email },
    });
  });

  /** The person's answer. Either way the reply says where to send their browser. */
  app.post('/authorize', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { params?: unknown; approve?: unknown } | undefined;
    const params = new URLSearchParams(
      typeof body?.params === 'object' && body.params !== null
        ? Object.entries(body.params as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          )
        : [],
    );
    const checked = await checkAuthorization(params, fetchClientDocument);

    if ('failure' in checked) return c.json(checked.failure, 400);

    if (body?.approve !== true) {
      return c.json({ redirect: answer(checked.redirectUri, { error: 'access_denied', state: checked.state }) });
    }

    const code = await issueCode({
      userId: c.get('session').userId,
      client: checked.client,
      redirectUri: checked.redirectUri,
      codeChallenge: checked.codeChallenge,
      resource: checked.resource,
    });

    return c.json({ redirect: answer(checked.redirectUri, { code, state: checked.state }) });
  });

  app.get('/apps', async (c) => c.json({ apps: await listConnectedApps(c.get('session').userId) }));

  app.delete('/apps/:grantId', async (c) => {
    const ended = await disconnectApp(c.get('session').userId, c.req.param('grantId'));

    return ended ? c.body(null, 204) : c.json({ error: 'No such connected app' }, 404);
  });

  return app;
}

interface CheckedAuthorization {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  resource: string | undefined;
  state: string | undefined;
}

/**
 * An authorization request, checked as RFC 6749 and OAuth 2.1 have it. While
 * the app or its address is in doubt, the person is told and nothing is sent
 * anywhere; once both are known, the app is told what was wrong instead.
 */
async function checkAuthorization(
  params: URLSearchParams,
  fetchClientDocument: FetchClientDocument | undefined,
): Promise<CheckedAuthorization | { failure: OAuthFailure & { redirect?: string } }> {
  const client = await findClient(params.get('client_id') ?? undefined, fetchClientDocument);

  if (isFailure(client)) return { failure: client };

  const asked = params.get('redirect_uri');
  const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);

  if (redirectUri === undefined || !redirectMatches(client, redirectUri)) {
    return {
      failure: {
        error: 'invalid_request',
        description: `${client.name} asked to send the answer to an address it did not register.`,
      },
    };
  }

  const stateParam = params.get('state');
  const state = stateParam === null ? undefined : stateParam.slice(0, 1000);
  const back = (error: string, description: string) => ({
    failure: { error, description, redirect: answer(redirectUri, { error, error_description: description, state }) },
  });

  if (params.get('response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code is offered.');

  const codeChallenge = params.get('code_challenge');

  if (codeChallenge === null || !/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge) || params.get('code_challenge_method') !== 'S256') {
    return back('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.');
  }

  const resource = params.get('resource') ?? undefined;

  if (resource !== undefined && !/^https?:\/\/[^/?#]+\/mcp\/?$/.test(resource)) {
    return back('invalid_target', "Tokens are issued only for this installation's MCP server, at /mcp.");
  }

  return { client, redirectUri, codeChallenge, resource, state };
}

/** Where the person's browser goes next: the app's address with the answer added. */
function answer(redirectUri: string, values: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  return url.toString();
}

function oauthError(error: string, description: string) {
  return { error, error_description: description };
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get('content-type') ?? '';

  try {
    if (type.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;

      return new URLSearchParams(
        Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    }

    return new URLSearchParams(await request.text());
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Which app is asking: by HTTP Basic, by client_secret in the body, or by
 * client_id alone for an app without a secret, which then proves itself with
 * PKCE or by holding the token it presents.
 */
async function authenticateClient(
  request: Request,
  form: URLSearchParams,
  fetchClientDocument: FetchClientDocument | undefined,
): Promise<OAuthClient | OAuthFailure> {
  let clientId = form.get('client_id') ?? undefined;
  let secret = form.get('client_secret') ?? undefined;
  const basic = request.headers.get('authorization')?.match(/^Basic\s+(.+)$/i)?.[1];

  if (basic !== undefined) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');

    if (colon > 0) {
      try {
        clientId = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      } catch {
        return { error: 'invalid_client', description: 'The Basic credentials are not URL-encoded correctly.' };
      }
    }
  }

  const client = await findClient(clientId, fetchClientDocument);

  if (isFailure(client)) return client;

  if (!(await clientSecretMatches(client, secret))) {
    return { error: 'invalid_client', description: 'The client secret is missing or wrong.' };
  }

  return client;
}
