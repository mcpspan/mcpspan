import { getPool } from './db.ts';
import { filterClause, type Filters } from './filters.ts';
import type { TimeRange } from './time-range.ts';

/** More versions than anyone compares at once; the newest are the ones asked about. */
const MAX_VERSIONS = 20;

export interface VersionStats {
  version: string;
  /** When this version was first seen on this server, ever: before the window, for one already running. */
  firstSeenAt: string;
  /** The last call from it in the window. */
  lastSeenAt: string;
  calls: number;
  errors: number;
  errorRate: number;
  durationMs: { p50: number | null; p95: number | null };
}

/**
 * Tool calls in a window by the version of the server that answered them,
 * newest version first.
 *
 * From the raw rows, which the hourly rollup does not group by version, so
 * the percentiles are exact. A version is the one the server gives itself in
 * its handshake, or the one its SDK was told; calls from SDKs that send none
 * are counted apart, so a partly upgraded fleet says so.
 */
export async function getVersions(
  serverId: string,
  range: TimeRange,
  filters: Filters,
): Promise<{ versions: VersionStats[]; unversionedCalls: number }> {
  const params: unknown[] = [serverId, range.from, range.to];
  const where = filterClause(filters, params);
  params.push(MAX_VERSIONS);

  const result = await getPool().query<{
    version: string | null;
    first_seen_at: Date | null;
    last_seen_at: Date;
    calls: string;
    errors: string;
    p50: number | null;
    p95: number | null;
  }>(
    `WITH windowed AS (
       SELECT server_version AS version,
              count(*) AS calls,
              count(*) FILTER (WHERE NOT success) AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
              max(occurred_at) AS last_seen_at
       FROM tool_calls
       WHERE server_id = $1
         AND occurred_at >= $2
         AND occurred_at < $3
         ${where}
       GROUP BY server_version
     )
     SELECT windowed.*, known.first_seen_at
     FROM windowed
     LEFT JOIN server_versions AS known
       ON known.server_id = $1 AND known.version = windowed.version
     ORDER BY windowed.version IS NULL, known.first_seen_at DESC NULLS LAST
     LIMIT $${params.length}`,
    params,
  );

  let unversionedCalls = 0;
  const versions: VersionStats[] = [];

  for (const row of result.rows) {
    const calls = Number(row.calls);
    if (row.version === null) {
      unversionedCalls = calls;
      continue;
    }
    const errors = Number(row.errors);
    versions.push({
      version: row.version,
      firstSeenAt: (row.first_seen_at ?? row.last_seen_at).toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      calls,
      errors,
      errorRate: calls === 0 ? 0 : errors / calls,
      durationMs: { p50: row.p50, p95: row.p95 },
    });
  }

  return { versions, unversionedCalls };
}
