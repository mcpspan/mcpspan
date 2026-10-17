import { getPool } from './db.ts';
import { CALL_TABLES } from './rollup.ts';
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
 * The servers a session reaches, oldest first.
 *
 * Read from the servers table rather than from keys. Those are two different
 * questions: a server whose only key has been revoked still exists and still
 * holds everything it ever recorded, and answering from keys made it vanish
 * from the interface while its events sat in the table.
 */
export async function listServers(serverIds: readonly string[]): Promise<ServerRecord[]> {
  const result = await getPool().query<ServerRow>(
    `SELECT s.id, s.name, s.created_at,
            EXISTS (
              SELECT 1 FROM api_keys k
              WHERE k.server_id = s.id AND k.revoked_at IS NULL
            ) AS has_active_key
     FROM servers s
     WHERE s.id = ANY($1::uuid[])
     ORDER BY s.created_at, s.id`,
    [serverIds],
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

/** Renames a server. False when the session reaches none by that identifier. */
export async function renameServer(
  serverIds: readonly string[],
  serverId: string,
  name: string,
): Promise<boolean> {
  if (!serverIds.includes(serverId)) return false;

  const result = await getPool().query(`UPDATE servers SET name = $2 WHERE id = $1`, [
    serverId,
    cleanName(name),
  ]);

  return (result.rowCount ?? 0) > 0;
}

/**
 * Removes a server, its keys and everything it recorded.
 *
 * Keys go with it through a foreign key. Calls and tool listings do not: they
 * live in hypertables that a foreign key cannot reach across, so they are
 * deleted here, every kind of them, in the same transaction, and the hourly
 * rollups are rebuilt afterwards.
 *
 * That rebuild is the expensive part and it is deliberate. Deleting raw rows
 * only marks the rollup's buckets as stale, and the refresh policy looks back
 * seven days, so anything older would keep answering with figures for a server
 * that no longer exists. Somebody who deletes a server means it.
 */
export async function deleteServer(
  serverIds: readonly string[],
  serverId: string,
): Promise<boolean> {
  if (!serverIds.includes(serverId)) return false;

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    const found = await client.query(`SELECT 1 FROM servers WHERE id = $1 FOR UPDATE`, [serverId]);

    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    for (const { raw } of Object.values(CALL_TABLES)) {
      await client.query(`DELETE FROM ${raw} WHERE server_id = $1`, [serverId]);
    }
    await client.query('DELETE FROM tool_listings WHERE server_id = $1', [serverId]);
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
  for (const { rollup } of Object.values(CALL_TABLES)) {
    try {
      await getPool().query(`CALL refresh_continuous_aggregate('${rollup}', NULL, NULL)`);
    } catch (error) {
      console.error(
        `mcpspan core-api deleted the server but could not rebuild ${rollup}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return true;
}

/** A stretch of time to delete in. Either end left out reaches as far as the data does. */
export interface DataRange {
  from: Date | null;
  to: Date | null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Deletes what one server recorded in a range, keeping the server and its key.
 *
 * For a call that should not have been recorded, such as an error message
 * carrying a token, and for clearing out test traffic. Takes the calls of
 * every kind and the tool listings, and the definitions and versions seen
 * only inside the range; a definition also seen outside it is still true of
 * the server and stays.
 *
 * The hourly summaries are rebuilt over the range, widened to whole hours.
 * Within an hour the range cuts through, what stays outside it is counted
 * again from the calls that are left, while those are still kept; past that
 * the hour goes with the range. With dryRun nothing is deleted and the count
 * says what would be.
 *
 * Returns how many calls it took (or would take), or undefined for a server
 * the caller cannot reach. Not taken off any monthly count: what was
 * received was received.
 */
export async function deleteServerData(
  serverIds: readonly string[],
  serverId: string,
  range: DataRange,
  options: { dryRun?: boolean } = {},
): Promise<number | undefined> {
  if (!serverIds.includes(serverId)) return undefined;

  const within = (column: string) =>
    `${column} >= coalesce($2::timestamptz, '-infinity') AND ${column} < coalesce($3::timestamptz, 'infinity')`;
  const params = [serverId, range.from, range.to];
  const client = await getPool().connect();
  let calls = 0;

  try {
    await client.query('BEGIN');

    for (const { raw } of Object.values(CALL_TABLES)) {
      const result = options.dryRun
        ? await client.query<{ c: string }>(
            `SELECT count(*) AS c FROM ${raw} WHERE server_id = $1 AND ${within('occurred_at')}`,
            params,
          )
        : await client.query(`DELETE FROM ${raw} WHERE server_id = $1 AND ${within('occurred_at')}`, params);

      calls += options.dryRun ? Number(result.rows[0]?.c ?? 0) : (result.rowCount ?? 0);
    }

    if (options.dryRun) {
      await client.query('ROLLBACK');
      return calls;
    }

    await client.query(`DELETE FROM tool_listings WHERE server_id = $1 AND ${within('occurred_at')}`, params);

    for (const table of ['tool_definitions', 'server_versions']) {
      await client.query(
        `DELETE FROM ${table} WHERE server_id = $1 AND ${within('first_seen_at')} AND ${within('last_seen_at')}`,
        params,
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const from = range.from === null ? null : new Date(Math.floor(range.from.getTime() / HOUR_MS) * HOUR_MS);
  const to = range.to === null ? null : new Date(Math.ceil(range.to.getTime() / HOUR_MS) * HOUR_MS);

  // Outside the transaction, as in deleteServer: a continuous aggregate
  // cannot be refreshed inside one.
  for (const { rollup } of Object.values(CALL_TABLES)) {
    try {
      await getPool().query(
        `CALL refresh_continuous_aggregate('${rollup}', $1::timestamptz, $2::timestamptz)`,
        [from, to],
      );
    } catch (error) {
      console.error(
        `mcpspan core-api deleted the calls but could not rebuild ${rollup}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return calls;
}

/** Reads a range from a request, or says what is wrong with it. */
export function parseDataRange(from: unknown, to: unknown): DataRange | { error: string } {
  const read = (value: unknown): Date | null | 'invalid' => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return 'invalid';

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? 'invalid' : date;
  };
  const range = { from: read(from), to: read(to) };

  if (range.from === 'invalid' || range.to === 'invalid') return { error: 'Send from and to as dates' };
  if (range.from !== null && range.to !== null && range.from.getTime() >= range.to.getTime()) {
    return { error: 'The range has to end after it starts' };
  }

  return { from: range.from, to: range.to };
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
