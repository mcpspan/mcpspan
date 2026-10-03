import { createHmac } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

import { getPool } from './db.ts';
import type { RefusalLog } from './refusals.ts';

/** What an authenticated request carries onwards. */
interface AuthenticatedServer {
  serverId: string;
  serverName: string;
}

export interface AuthVariables {
  server: AuthenticatedServer;
}

/**
 * Turns an API key into what the database stores.
 *
 * HMAC rather than a password hash: see the api_keys migration for why. The
 * secret is read on every call rather than captured once, so that a test or a
 * self-hoster changing it does not have to restart to see the effect.
 */
export function hashApiKey(key: string): Buffer {
  return createHmac('sha256', requireSecret()).update(key).digest();
}

/**
 * Reads the API key from the request and refuses anything it cannot place.
 *
 * On success the server the key belongs to is attached to the request, and
 * everything downstream reads it from there. That is the point: the server is
 * decided by the credential, never by the payload, so no caller can file tool
 * calls against a server that is not theirs.
 */
export function requireApiKey(
  /** Where refusals are counted, so the installation can say why a server is quiet. */
  refusals?: RefusalLog,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const key = bearerToken(c.req.header('authorization'));

    if (key === undefined) {
      refusals?.record('missing_key');

      return c.json({ error: 'Missing API key. Send it as: Authorization: Bearer <key>' }, 401);
    }

    const found = await findKey(key);

    if (found === undefined || found.revoked) {
      // Told apart here, for the owner's diagnostics, and nowhere else. A
      // replaced key still in use is the commonest reason a server goes
      // quiet, and it names the server it belonged to, so its owner can be
      // told which deployment to fix.
      if (found === undefined) {
        refusals?.record('unknown_key');
      } else {
        refusals?.record('revoked_key', found.server.serverId);
      }

      // One message for "no such key" and for "revoked". Telling them apart
      // would confirm which keys once existed, and neither answer helps anyone
      // holding a key they are allowed to use.
      return c.json({ error: 'Invalid or revoked API key' }, 401);
    }

    c.set('server', found.server);

    await next();
  };
}

/**
 * Looks a key up by its hash, whether or not it still works.
 *
 * One index probe per request, the same as when only live keys were looked
 * for: revoked keys are found by the same unique index, and knowing that a key
 * was revoked, rather than never issued, is what lets the owner be told a
 * deployment is still using an old one.
 *
 * No cache yet: the SDK batches, so a busy server authenticates once every few
 * seconds rather than once per tool call, and a cache would add a window in
 * which a revoked key still works.
 */
async function findKey(
  key: string,
): Promise<{ server: AuthenticatedServer; revoked: boolean } | undefined> {
  // Joined, because the name now belongs to the server rather than to the
  // credential. Two keys for one server used to be able to disagree about what
  // it was called.
  const result = await getPool().query<{
    server_id: string;
    server_name: string;
    revoked: boolean;
  }>(
    `SELECT k.server_id, s.name AS server_name, k.revoked_at IS NOT NULL AS revoked
     FROM api_keys k
     JOIN servers s ON s.id = k.server_id
     WHERE k.key_hash = $1`,
    [hashApiKey(key)],
  );

  const row = result.rows[0];

  return row
    ? { server: { serverId: row.server_id, serverName: row.server_name }, revoked: row.revoked }
    : undefined;
}

/** Pulls the credential out of an Authorization header, whatever its casing. */
function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  return token && token.length > 0 ? token : undefined;
}

function requireSecret(): string {
  const secret = process.env['API_KEY_SECRET']?.trim();

  if (!secret) {
    throw new Error(
      'API_KEY_SECRET is not set. Generate one with: openssl rand -hex 32, and put it in .env',
    );
  }

  return secret;
}
