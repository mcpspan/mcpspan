import { createHash, randomBytes } from 'node:crypto';

import type { User } from './accounts.ts';
import { getPool } from './db.ts';

/**
 * How a read token announces itself.
 *
 * Unlike a server's key (mcps_), and spelled out, so neither a secret scanner
 * nor a person can take one for the other: a key writes a server's events, a
 * token reads everything its owner can see.
 */
export const READ_TOKEN_PREFIX = 'mcpspan_read_';

/** How many tokens one account may hold. Plenty for every machine and tool somebody uses. */
export const MAX_READ_TOKENS = 20;

/** The longest name a token may have. */
const MAX_NAME_LENGTH = 100;

export interface ReadTokenRecord {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The tokens one account holds, oldest first. Never the tokens themselves: only their hashes are kept. */
export async function listReadTokens(userId: string): Promise<ReadTokenRecord[]> {
  const result = await getPool().query<{
    id: string;
    name: string;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT id, name, created_at, last_used_at
     FROM read_tokens
     WHERE user_id = $1
     ORDER BY created_at, id`,
    [userId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  }));
}

/** A token's name as given, or why it cannot be one. */
export function parseTokenName(value: unknown): { name: string } | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: 'Give the token a name' };
  }

  const name = value.trim();

  if (name.length > MAX_NAME_LENGTH) {
    return { error: `A token's name can be at most ${MAX_NAME_LENGTH} characters` };
  }

  return { name };
}

/**
 * Makes a token for an account and returns it in the clear, once; or says
 * why not, when the account already holds as many as it may.
 */
export async function issueReadToken(
  userId: string,
  name: string,
): Promise<{ token: string; record: ReadTokenRecord } | { error: string }> {
  const token = `${READ_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

  // The count and the insert in one statement, so two made at once cannot
  // both slip under the limit.
  const result = await getPool().query<{ id: string; name: string; created_at: Date }>(
    `INSERT INTO read_tokens (token_hash, user_id, name)
     SELECT $1, $2, $3
     WHERE (SELECT count(*) FROM read_tokens WHERE user_id = $2) < $4
     RETURNING id, name, created_at`,
    [hashReadToken(token), userId, name, MAX_READ_TOKENS],
  );

  const row = result.rows[0];

  if (!row) {
    return { error: `An account can hold at most ${MAX_READ_TOKENS} read tokens. Revoke one first.` };
  }

  return {
    token,
    record: { id: row.id, name: row.name, createdAt: row.created_at.toISOString(), lastUsedAt: null },
  };
}

/**
 * Ends a token at once. Deleted rather than marked: nothing is ever told
 * apart by a token that no longer works, unlike a server's key.
 */
export async function revokeReadToken(userId: string, tokenId: string): Promise<boolean> {
  // Same answer for a token that is not there and one that is somebody else's.
  if (!UUID.test(tokenId)) return false;

  const result = await getPool().query('DELETE FROM read_tokens WHERE id = $1 AND user_id = $2', [
    tokenId,
    userId,
  ]);

  return (result.rowCount ?? 0) > 0;
}

/**
 * Who a token belongs to, if anybody, noting that it was used.
 *
 * The note is written at most once a minute per token, so an agent asking
 * question after question does not turn every read into a write.
 */
export async function userForReadToken(token: string): Promise<User | undefined> {
  if (!token.startsWith(READ_TOKEN_PREFIX)) return undefined;

  const result = await getPool().query<{ token_id: string; id: string; email: string; stale: boolean }>(
    `SELECT t.id AS token_id, u.id, u.email,
            t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute' AS stale
     FROM read_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1`,
    [hashReadToken(token)],
  );

  const row = result.rows[0];

  if (!row) return undefined;

  if (row.stale) {
    await getPool().query('UPDATE read_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]);
  }

  return { id: row.id, email: row.email };
}

function hashReadToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
