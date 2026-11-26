import { getPool } from './db.ts';
import { MIN_RETENTION_DAYS } from './retention.ts';

/** What the migration sets: past the rollup's seven-day refresh window and the chunk being written. */
export const DEFAULT_COMPRESS_AFTER_DAYS = 14;

const VARIABLE = 'MCPSPAN_COMPRESS_AFTER_DAYS';

/** Every table the migration compresses: the raw calls of each kind and the listings. */
const TABLES = ['tool_calls', 'resource_calls', 'prompt_calls', 'tool_listings'] as const;

/**
 * Brings the compression policies in line with MCPSPAN_COMPRESS_AFTER_DAYS.
 *
 * Like retention, a setting rather than a schema change. 0 turns compression
 * off for what is still to come: what is compressed already stays so, and
 * reads as before, since decompressing it all would hand back the disk the
 * installation may not have.
 *
 * Skipped on a TimescaleDB without compression, where the migration left the
 * tables as they were, and never fatal.
 */
export async function reconcileCompression(): Promise<void> {
  const license = await getPool().query<{ license: string | null }>(
    `SELECT current_setting('timescaledb.license', true) AS license`,
  );
  if (license.rows[0]?.license !== 'timescale') return;

  const wanted = readDays();

  for (const table of TABLES) {
    try {
      const current = await currentCompressAfterDays(table);
      if (current === wanted) continue;

      if (current !== undefined) {
        await getPool().query(`SELECT remove_compression_policy($1)`, [table]);
      }
      if (wanted !== undefined) {
        await getPool().query(
          `SELECT add_compression_policy($1, compress_after => make_interval(days => $2))`,
          [table, wanted],
        );
      }

      console.log(
        wanted === undefined
          ? `mcpspan core-api no longer compresses ${table}`
          : `mcpspan core-api compresses ${table} after ${wanted} days`,
      );
    } catch (error) {
      console.error(
        `mcpspan core-api could not set compression for ${table}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** After how many days a table's chunks are compressed, or undefined when they are not. */
export async function currentCompressAfterDays(table: string): Promise<number | undefined> {
  const result = await getPool().query<{ days: string | null }>(
    `SELECT extract(epoch FROM (config->>'compress_after')::interval) / 86400 AS days
     FROM timescaledb_information.jobs
     WHERE proc_name = 'policy_compression'
       AND hypertable_name = $1`,
    [table],
  );

  const days = result.rows[0]?.days;

  return days === null || days === undefined ? undefined : Number(days);
}

/**
 * The days asked for, undefined for off.
 *
 * Not below the retention floor: younger chunks are the ones still being
 * written and recounted into the rollup, and compressing them would have
 * every late call and every refresh decompress them again.
 */
function readDays(): number | undefined {
  const raw = process.env[VARIABLE]?.trim();

  if (raw === undefined || raw.length === 0) return DEFAULT_COMPRESS_AFTER_DAYS;

  const days = Number(raw);

  if (days === 0) return undefined;

  if (!Number.isInteger(days) || days < 0) {
    console.error(
      `mcpspan core-api ignoring ${VARIABLE}=${raw}, which is not a whole number of days. Keeping ${DEFAULT_COMPRESS_AFTER_DAYS}.`,
    );
    return DEFAULT_COMPRESS_AFTER_DAYS;
  }

  if (days < MIN_RETENTION_DAYS) {
    console.error(
      `mcpspan core-api ignoring ${VARIABLE}=${days}: under ${MIN_RETENTION_DAYS} days it would compress the calls still being written and counted into the hourly summaries. Keeping ${DEFAULT_COMPRESS_AFTER_DAYS}.`,
    );
    return DEFAULT_COMPRESS_AFTER_DAYS;
  }

  return days;
}
