import { randomBytes } from 'node:crypto';

import { hashApiKey } from './auth.ts';
import { getPool } from './db.ts';
import type { PoolClient } from 'pg';

/**
 * How a key announces itself.
 *
 * A fixed, recognisable start matters more than it looks. Secret scanners
 * match on prefixes, so a key pasted into a public repository can be spotted
 * and reported rather than sitting there; and a developer staring at a config
 * file can tell at a glance which of five opaque strings is ours.
 */
const KEY_PREFIX = 'mcps_';

/** Bytes of randomness behind each key. */
const KEY_BYTES = 32;

export interface IssuedKey {
  /** The key itself. Returned here and never again: only its hash is kept. */
  key: string;
  serverId: string;
}

/**
 * Creates a key for a server that already exists, and returns it in the clear,
 * once.
 *
 * The server is named here rather than created, which is the whole point of it
 * having a row: a replacement key points at the same server, so everything
 * recorded before the swap stays where the dashboard can see it. Before, a key
 * carried the server's name itself, and two keys for one server could disagree
 * about what it was called.
 */
export async function issueApiKey(options: {
  serverId: string;
  ownerEmail: string;
  /** Absent for keys minted from the command line before anyone registered. */
  userId?: string;
  /** Lets a caller run this inside a transaction it already opened. */
  client?: PoolClient;
}): Promise<IssuedKey> {
  const key = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;
  const runner = options.client ?? getPool();

  const result = await runner.query<{ server_id: string }>(
    `INSERT INTO api_keys (key_hash, owner_email, user_id, server_id)
     VALUES ($1, $2, $3, $4)
     RETURNING server_id`,
    [hashApiKey(key), options.ownerEmail, options.userId ?? null, options.serverId],
  );

  const row = result.rows[0];

  if (!row) throw new Error('Could not create the API key');

  return { key, serverId: row.server_id };
}
