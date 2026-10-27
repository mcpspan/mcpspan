import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { User } from './accounts.ts';
import { getPool } from './db.ts';

/**
 * OAuth for mcpspan's MCP server: the apps that may ask, the codes a person's
 * browser carries back to them, and the tokens they then hold.
 *
 * Everything a token can do is read, as a read token can; the only scope is
 * `read`. Tokens and codes are 32 random bytes made here, kept by SHA-256
 * hash, as sessions and read tokens are.
 */

export const ACCESS_TOKEN_PREFIX = 'mcpspan_oauth_';
export const REFRESH_TOKEN_PREFIX = 'mcpspan_refresh_';
export const SCOPE = 'read';

export const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_DAYS = 30;
const CODE_SECONDS = 5 * 60;

/** A registered app nobody ever finished signing in with is forgotten after this. */
const UNUSED_CLIENT_DAYS = 30;

/** How long a fetched client document is believed before it is fetched again. */
export const CLIENT_DOCUMENT_HOURS = 24;

const MAX_REDIRECT_URIS = 10;
const MAX_NAME_LENGTH = 100;
const MAX_URI_LENGTH = 2000;

export interface OAuthClient {
  /** This installation's own id for the app. */
  id: string;
  /** What the app sends. */
  clientId: string;
  name: string;
  clientUri: string | null;
  redirectUris: string[];
  /** Whether it has to prove itself with a secret at the token endpoint. */
  confidential: boolean;
  registered: boolean;
  fetchedAt: Date | null;
}

/** An OAuth error, as RFC 6749 names them, with words for a person. */
export interface OAuthFailure {
  error: string;
  description: string;
}

const fail = (error: string, description: string): OAuthFailure => ({ error, description });

export function isFailure(value: unknown): value is OAuthFailure {
  return typeof value === 'object' && value !== null && 'error' in value && 'description' in value;
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function secret(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

// --- Where answers may go -------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether an app may name this as where its answer goes: https anywhere, http
 * only back to the same machine (RFC 8252), or an app's own scheme such as
 * `cursor://` - never one a browser would run or read from disk.
 */
export function acceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_URI_LENGTH) return false;

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.hash !== '' || value.includes('#')) return false;

  const scheme = url.protocol.slice(0, -1).toLowerCase();

  if (scheme === 'https') return url.hostname !== '';
  if (scheme === 'http') return LOOPBACK.has(url.hostname);

  // An app's own scheme: RFC 8252 asks for reverse domain names, which not
  // every client follows, so any scheme a browser does not handle itself.
  return !['javascript', 'data', 'file', 'blob', 'about', 'vbscript', 'ftp', 'ws', 'wss'].includes(scheme);
}

/**
 * Whether `asked` is one of the app's addresses. Exactly, except that a
 * loopback address may come back on any port, which a desktop app picks when
 * it starts listening (RFC 8252, 7.3).
 */
export function redirectMatches(client: OAuthClient, asked: string): boolean {
  if (client.redirectUris.includes(asked)) return true;

  let url: URL;

  try {
    url = new URL(asked);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) return false;

  return client.redirectUris.some((registered) => {
    try {
      const known = new URL(registered);

      known.port = url.port;

      return known.protocol === 'http:' && LOOPBACK.has(known.hostname) && known.href === url.href;
    } catch {
      return false;
    }
  });
}

// --- Apps -----------------------------------------------------------------

interface ClientMetadata {
  name: string;
  clientUri: string | null;
  redirectUris: string[];
}

/**
 * What an app says about itself, in a registration or its own document,
 * checked: where answers go, what it is called, and that it only asks for
 * what this server does.
 */
export function parseClientMetadata(
  body: unknown,
  { forDocument = false }: { forDocument?: boolean } = {},
): (ClientMetadata & { authMethod: string }) | OAuthFailure {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('invalid_client_metadata', 'Send the client metadata as a JSON object.');
  }

  const fields = body as Record<string, unknown>;
  const uris = fields['redirect_uris'];

  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return fail('invalid_redirect_uri', `redirect_uris must list between 1 and ${MAX_REDIRECT_URIS} addresses.`);
  }

  const bad = uris.find((uri) => !acceptableRedirectUri(uri));

  if (bad !== undefined) {
    return fail(
      'invalid_redirect_uri',
      `${String(bad)} cannot receive an answer: use https, http to localhost, or the app's own scheme, without a fragment.`,
    );
  }

  const grants = fields['grant_types'] ?? ['authorization_code'];
  const responses = fields['response_types'] ?? ['code'];

  // An app may list more ways in than this server offers (Claude's own
  // document does); what counts is that the one offered here is among them.
  // The rest are simply never granted.
  if (
    !Array.isArray(grants) ||
    !grants.includes('authorization_code') ||
    !Array.isArray(responses) ||
    !responses.includes('code')
  ) {
    return fail(
      'invalid_client_metadata',
      'The app must be able to sign in with the authorization_code grant and the code response, the way offered here.',
    );
  }

  // A document cannot hold a secret everybody can read, so an app known by
  // one is always public (it proves itself with PKCE alone).
  const authMethod = forDocument ? 'none' : (fields['token_endpoint_auth_method'] ?? 'client_secret_basic');

  if (authMethod !== 'none' && authMethod !== 'client_secret_basic' && authMethod !== 'client_secret_post') {
    return fail(
      'invalid_client_metadata',
      'token_endpoint_auth_method must be none, client_secret_basic or client_secret_post.',
    );
  }

  const rawName = typeof fields['client_name'] === 'string' ? fields['client_name'].trim() : '';
  // Control characters out, so a name cannot pretend to be two lines of the page.
  const name = rawName.replace(/\p{Cc}/gu, '').slice(0, MAX_NAME_LENGTH);
  const clientUri = fields['client_uri'];

  return {
    name: name === '' ? 'An unnamed app' : name,
    clientUri:
      typeof clientUri === 'string' && clientUri.length <= MAX_URI_LENGTH && /^https:\/\//i.test(clientUri)
        ? clientUri
        : null,
    redirectUris: uris as string[],
    authMethod: authMethod as string,
  };
}

/**
 * An app registering itself (RFC 7591). A secret only when it asked to keep
 * one, returned in the clear this once.
 */
export async function registerClient(
  metadata: ClientMetadata & { authMethod: string },
): Promise<{ client: OAuthClient; clientSecret: string | undefined; issuedAt: number }> {
  const pool = getPool();

  // Registering costs nothing and anybody may; registrations that never led
  // to a single grant are cleared as new ones arrive.
  await pool.query(
    `DELETE FROM oauth_clients c
     WHERE c.registered AND c.created_at < now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)`,
    [UNUSED_CLIENT_DAYS],
  );

  const clientId = `mcpspan_client_${randomBytes(16).toString('base64url')}`;
  const clientSecret = metadata.authMethod === 'none' ? undefined : secret('mcpspan_secret_');

  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO oauth_clients (client_id, secret_hash, name, client_uri, redirect_uris, registered)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id, created_at`,
    [clientId, clientSecret === undefined ? null : hash(clientSecret), metadata.name, metadata.clientUri, metadata.redirectUris],
  );

  const row = result.rows[0] as { id: string; created_at: Date };

  return {
    client: {
      id: row.id,
      clientId,
      name: metadata.name,
      clientUri: metadata.clientUri,
      redirectUris: metadata.redirectUris,
      confidential: clientSecret !== undefined,
      registered: true,
      fetchedAt: null,
    },
    clientSecret,
    issuedAt: Math.floor(row.created_at.getTime() / 1000),
  };
}

interface ClientRow {
  id: string;
  client_id: string;
  secret_hash: Buffer | null;
  name: string;
  client_uri: string | null;
  redirect_uris: string[];
  registered: boolean;
  fetched_at: Date | null;
}

function toClient(row: ClientRow): OAuthClient {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    clientUri: row.client_uri,
    redirectUris: row.redirect_uris,
    confidential: row.secret_hash !== null,
    registered: row.registered,
    fetchedAt: row.fetched_at,
  };
}

export async function storedClient(clientId: string): Promise<OAuthClient | undefined> {
  const result = await getPool().query<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
  const row = result.rows[0];

  return row === undefined ? undefined : toClient(row);
}

/** Keeps what an app's document says, as of now, under the document's address. */
export async function rememberClientDocument(clientId: string, metadata: ClientMetadata): Promise<OAuthClient> {
  const result = await getPool().query<ClientRow>(
    `INSERT INTO oauth_clients (client_id, name, client_uri, redirect_uris, registered, fetched_at)
     VALUES ($1, $2, $3, $4, false, now())
     ON CONFLICT (client_id) DO UPDATE
       SET name = EXCLUDED.name, client_uri = EXCLUDED.client_uri,
           redirect_uris = EXCLUDED.redirect_uris, fetched_at = now()
     RETURNING *`,
    [clientId, metadata.name, metadata.clientUri, metadata.redirectUris],
  );

  return toClient(result.rows[0] as ClientRow);
}

/** Whether an app that has a secret gave the right one. */
export async function clientSecretMatches(client: OAuthClient, given: string | undefined): Promise<boolean> {
  if (!client.confidential) return true;
  if (given === undefined) return false;

  const result = await getPool().query<{ secret_hash: Buffer }>('SELECT secret_hash FROM oauth_clients WHERE id = $1', [
    client.id,
  ]);
  const stored = result.rows[0]?.secret_hash;

  return stored !== undefined && stored !== null && timingSafeEqual(stored, hash(given));
}

// --- Codes and tokens -------------------------------------------------------

/** PKCE: the verifier the app kept, against the challenge it sent first (S256 only). */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;

  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);

  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** A code for the browser to carry back, after the person said yes. */
export async function issueCode(details: {
  userId: string;
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  resource: string | undefined;
}): Promise<string> {
  const code = secret();

  await getPool().query(
    `INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
    [
      hash(code),
      details.userId,
      details.client.id,
      details.redirectUri,
      details.codeChallenge,
      SCOPE,
      details.resource ?? null,
      CODE_SECONDS,
    ],
  );

  return code;
}

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(grantId: string): Promise<IssuedTokens> {
  const access = secret(ACCESS_TOKEN_PREFIX);
  const refresh = secret(REFRESH_TOKEN_PREFIX);

  await getPool().query(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES
       ($1, $3, 'access', now() + make_interval(secs => $4)),
       ($2, $3, 'refresh', now() + make_interval(days => $5))`,
    [hash(access), hash(refresh), grantId, ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_DAYS],
  );

  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: SCOPE };
}

async function endGrant(grantId: string): Promise<void> {
  await getPool().query('UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [grantId]);
  await getPool().query('DELETE FROM oauth_tokens WHERE grant_id = $1', [grantId]);
}

/**
 * A code traded for tokens: once, by the app it was made for, from the
 * address it was sent to, with the PKCE verifier, for this MCP server.
 */
export async function exchangeCode(request: {
  client: OAuthClient;
  code: string;
  redirectUri: string | undefined;
  codeVerifier: string | undefined;
  /** This server's /mcp, as the outside reaches it. */
  resource: string;
  /** The resource the app named now, if any. */
  askedResource: string | undefined;
}): Promise<IssuedTokens | OAuthFailure> {
  const pool = getPool();
  const result = await pool.query<{
    user_id: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string | null;
    expired: boolean;
    grant_id: string | null;
  }>(
    `SELECT user_id, client_id, redirect_uri, code_challenge, resource, expires_at < now() AS expired, grant_id
     FROM oauth_codes WHERE code_hash = $1`,
    [hash(request.code)],
  );
  const row = result.rows[0];
  const invalid = fail('invalid_grant', 'The code is not valid: it expired, was used already, or was made for another app.');

  if (row === undefined || row.client_id !== request.client.id) return invalid;

  // A second use is a copied code: whatever the first use made ends too.
  if (row.grant_id !== null) {
    await endGrant(row.grant_id);

    return invalid;
  }

  if (row.expired) return invalid;
  if (request.redirectUri !== row.redirect_uri) {
    return fail('invalid_grant', 'redirect_uri must be the one the code was asked for.');
  }
  if (request.codeVerifier === undefined || !verifierMatches(request.codeVerifier, row.code_challenge)) {
    return fail('invalid_grant', 'code_verifier does not match the code_challenge sent with the authorization request.');
  }

  for (const named of [row.resource, request.askedResource]) {
    if (named !== null && named !== undefined && named.replace(/\/+$/, '') !== request.resource) {
      return fail('invalid_target', `This authorization server only issues tokens for ${request.resource}.`);
    }
  }

  const grant = await pool.query<{ id: string }>(
    `INSERT INTO oauth_grants (user_id, client_id, scope, resource, last_used_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [row.user_id, row.client_id, SCOPE, request.resource],
  );
  const grantId = (grant.rows[0] as { id: string }).id;

  // Claimed only if still unclaimed, so two exchanges racing for one code
  // cannot both win.
  const claimed = await pool.query('UPDATE oauth_codes SET grant_id = $1 WHERE code_hash = $2 AND grant_id IS NULL', [
    grantId,
    hash(request.code),
  ]);

  if (claimed.rowCount !== 1) {
    await pool.query('DELETE FROM oauth_grants WHERE id = $1', [grantId]);

    return invalid;
  }

  // Codes are worth keeping only as long as a copy could still turn up.
  await pool.query(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'`);

  return issueTokens(grantId);
}

/**
 * How long after a refresh token is swapped it still works, once more each
 * time it is presented: an app that sent two refreshes at once, or lost the
 * answer to the first and asked again, keeps its connection. Later than this,
 * a second use is a copied token (below). The same allowance Auth0 and Okta
 * call a reuse interval.
 */
const REFRESH_REUSE_SECONDS = 60;

/**
 * A refresh token swapped for new tokens. It works once: presented again after
 * the brief allowance above, it was copied, and the whole grant ends (RFC
 * 9700, 4.14.2).
 */
export async function refreshTokens(client: OAuthClient, refreshToken: string): Promise<IssuedTokens | OAuthFailure> {
  const pool = getPool();
  const invalid = fail('invalid_grant', 'The refresh token is not valid: it expired, was used already, or was revoked.');

  if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return invalid;

  const result = await pool.query<{
    grant_id: string;
    client_id: string;
    expired: boolean;
    used: boolean;
    recently_used: boolean;
    revoked: boolean;
  }>(
    `SELECT t.grant_id, g.client_id, t.expires_at < now() AS expired, t.used_at IS NOT NULL AS used,
            t.used_at > now() - make_interval(secs => $2) AS recently_used,
            g.revoked_at IS NOT NULL AS revoked
     FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
     WHERE t.token_hash = $1 AND t.kind = 'refresh'`,
    [hash(refreshToken), REFRESH_REUSE_SECONDS],
  );
  const row = result.rows[0];

  if (row === undefined || row.client_id !== client.id || row.revoked || row.expired) return invalid;

  if (row.used) {
    if (row.recently_used) return issueTokens(row.grant_id);

    await endGrant(row.grant_id);

    return invalid;
  }

  const swapped = await pool.query(
    `UPDATE oauth_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL`,
    [hash(refreshToken)],
  );

  // Another request swapped it a moment ago: within the allowance, so this one gets tokens too.
  if (swapped.rowCount !== 1) return issueTokens(row.grant_id);

  // Tokens that can no longer be used, cleared as new ones are made.
  await pool.query(
    `DELETE FROM oauth_tokens WHERE grant_id = $1 AND (expires_at < now() OR (kind = 'refresh' AND used_at < now() - interval '1 day'))`,
    [row.grant_id],
  );

  return issueTokens(row.grant_id);
}

/** RFC 7009: ends the grant a token of this app's belongs to. Silent about tokens it does not know. */
export async function revokeToken(client: OAuthClient, token: string): Promise<void> {
  await getPool().query(
    `UPDATE oauth_grants g SET revoked_at = now()
     FROM oauth_tokens t
     WHERE t.token_hash = $1 AND t.grant_id = g.id AND g.client_id = $2 AND g.revoked_at IS NULL`,
    [hash(token), client.id],
  );
  await getPool().query(
    `DELETE FROM oauth_tokens WHERE grant_id IN (
       SELECT g.id FROM oauth_grants g WHERE g.client_id = $1 AND g.revoked_at IS NOT NULL)`,
    [client.id],
  );
}

/**
 * Who an access token reads for, if anybody, noting the grant was used (at
 * most once a minute), and which MCP server it was made for.
 */
export async function userForAccessToken(token: string): Promise<(User & { resource: string | null }) | undefined> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return undefined;

  const result = await getPool().query<{
    grant_id: string;
    id: string;
    email: string;
    resource: string | null;
    stale: boolean;
  }>(
    `SELECT g.id AS grant_id, u.id, u.email, g.resource,
            g.last_used_at IS NULL OR g.last_used_at < now() - interval '1 minute' AS stale
     FROM oauth_tokens t
     JOIN oauth_grants g ON g.id = t.grant_id
     JOIN users u ON u.id = g.user_id
     WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > now() AND g.revoked_at IS NULL`,
    [hash(token)],
  );
  const row = result.rows[0];

  if (row === undefined) return undefined;

  if (row.stale) await getPool().query('UPDATE oauth_grants SET last_used_at = now() WHERE id = $1', [row.grant_id]);

  return { id: row.id, email: row.email, resource: row.resource };
}

// --- Connected apps, for the person ------------------------------------------

export interface ConnectedApp {
  id: string;
  name: string;
  clientUri: string | null;
  /** Where its answers go, which tells two apps of one name apart. */
  redirectHost: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listConnectedApps(userId: string): Promise<ConnectedApp[]> {
  const result = await getPool().query<{
    id: string;
    name: string;
    client_uri: string | null;
    redirect_uris: string[];
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT g.id, c.name, c.client_uri, c.redirect_uris, g.created_at, g.last_used_at
     FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
     WHERE g.user_id = $1 AND g.revoked_at IS NULL
     ORDER BY g.created_at, g.id`,
    [userId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    clientUri: row.client_uri,
    redirectHost: redirectHost(row.redirect_uris[0]),
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  }));
}

/** What a person reads to know where an answer goes: a host, or an app's own scheme. */
export function redirectHost(uri: string | undefined): string | null {
  if (uri === undefined) return null;

  try {
    const url = new URL(uri);

    return url.host === '' ? `${url.protocol}//` : url.host;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function disconnectApp(userId: string, grantId: string): Promise<boolean> {
  if (!UUID.test(grantId)) return false;

  const result = await getPool().query(
    'UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [grantId, userId],
  );

  if (result.rowCount !== 1) return false;

  await getPool().query('DELETE FROM oauth_tokens WHERE grant_id = $1', [grantId]);

  return true;
}
