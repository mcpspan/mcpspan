import { getPool } from './db.ts';
import type { PoolClient } from 'pg';

/** Longest a server name may be. Long enough to describe one, short enough to fit a menu. */
const MAX_SERVER_NAME = 80;

export interface ServerRecord {
  id: string;
  name: string;
  createdAt: string;
  /** Whether a key exists that can still write to it. */
  hasActiveKey: boolean;
}

interface ServerRow {
  id: string;
  name: string;
  created_at: Date;
  has_active_key: boolean;
}

/**
 * Every server an account owns, oldest first.
 *
 * Read from the servers table rather than from keys. Those are two different
 * questions: a server whose only key has been revoked still exists and still
 * holds everything it ever recorded, and answering from keys made it vanish
 * from the interface while its events sat in the table.
 */
export async function listServers(userId: string): Promise<ServerRecord[]> {
  const result = await getPool().query<ServerRow>(
    `SELECT s.id, s.name, s.created_at,
            EXISTS (
              SELECT 1 FROM api_keys k
              WHERE k.server_id = s.id AND k.revoked_at IS NULL
            ) AS has_active_key
     FROM servers s
     WHERE s.user_id = $1
     ORDER BY s.created_at, s.id`,
    [userId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    hasActiveKey: row.has_active_key,
  }));
}

/**
 * Creates a server for an account, or without one.
 *
 * The owner is optional because the command line tool can mint a key before
 * anyone has registered. Such a server accepts events and appears in no
 * interface until an account adopts it.
 */
export async function createServer(
  userId: string | null,
  name: string,
  client?: PoolClient,
): Promise<{ id: string; name: string }> {
  const runner = client ?? getPool();

  const result = await runner.query<{ id: string; name: string }>(
    `INSERT INTO servers (user_id, name) VALUES ($1, $2) RETURNING id, name`,
    [userId, cleanName(name)],
  );

  const row = result.rows[0];

  if (!row) throw new Error('Could not create the server');

  return row;
}

/** Renames a server. False when the account does not own one by that identifier. */
export async function renameServer(
  userId: string,
  serverId: string,
  name: string,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE servers SET name = $3 WHERE id = $2 AND user_id = $1`,
    [userId, serverId, cleanName(name)],
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Removes a server, its keys and everything it recorded.
 *
 * Keys go with it through a foreign key. Events do not: they live in a
 * hypertable that a foreign key cannot reach across, so they are deleted here,
 * in the same transaction, and the hourly rollup is rebuilt afterwards.
 *
 * That rebuild is the expensive part and it is deliberate. Deleting raw rows
 * only marks the rollup's buckets as stale, and the refresh policy looks back
 * seven days, so anything older would keep answering with figures for a server
 * that no longer exists. Somebody who deletes a server means it.
 */
export async function deleteServer(userId: string, serverId: string): Promise<boolean> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    const owned = await client.query(`SELECT 1 FROM servers WHERE id = $1 AND user_id = $2`, [
      serverId,
      userId,
    ]);

    if (owned.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    await client.query('DELETE FROM tool_calls WHERE server_id = $1', [serverId]);
    await client.query('DELETE FROM servers WHERE id = $1', [serverId]);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Outside the transaction, because a continuous aggregate cannot be
  // refreshed inside one. If this fails the deletion still stands; the rollup
  // catches up on its own schedule for recent buckets, and a line on stderr
  // says why an old one might still show figures.
  try {
    await getPool().query(`CALL refresh_continuous_aggregate('tool_calls_hourly', NULL, NULL)`);
  } catch (error) {
    console.error(
      `mcpspan core-api deleted the server but could not rebuild the rollup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return true;
}

/** Whether an account owns a server, for the routes that act on one by name. */
export async function ownsServer(userId: string, serverId: string): Promise<boolean> {
  const result = await getPool().query(`SELECT 1 FROM servers WHERE id = $1 AND user_id = $2`, [
    serverId,
    userId,
  ]);

  return (result.rowCount ?? 0) > 0;
}

/**
 * Reads a name from a request, or says what is wrong with it.
 *
 * Returned as a value rather than thrown: a name somebody typed is input, and
 * input being wrong is an answer the caller gives back, not an exception.
 */
export function parseServerName(value: unknown): { name: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'Send a name for the server' };

  const name = value.trim();

  if (name.length === 0) return { error: 'The server needs a name' };
  if (name.length > MAX_SERVER_NAME) {
    return { error: `That name is too long, at most ${MAX_SERVER_NAME} characters` };
  }

  return { name };
}

function cleanName(name: string): string {
  return name.trim().slice(0, MAX_SERVER_NAME);
}
