import { getPool } from './db.ts';
import { type Filters, UNKNOWN_TOOL } from './filters.ts';
import { splitWindowForBucket, unifiedCallSource } from './rollup.ts';
import type { TimeRange } from './time-range.ts';

/**
 * Clients returned at most, across every page. The SDK folds client names
 * into a short list of types, so this is a ceiling against something sending
 * invented ones, not a number anybody reaches.
 */
const MAX_CLIENTS = 500;

interface ClientOverTime {
  clientType: string;
  /** Calls in the window. */
  calls: number;
  /**
   * The start of the hour this client was first seen on this server, ever,
   * within the rollup's two years. Hour-precise, because that is what the
   * rollup keeps.
   */
  firstSeenAt: string;
  /** The start of the hour it was last seen in. */
  lastSeenAt: string;
  /** Calls per bucket, aligned with `times`. */
  points: number[];
}

export interface ClientsOverTime {
  bucketSeconds: number;
  /** Start of each bucket, shared by every client's points. */
  times: string[];
  clients: ClientOverTime[];
}

/**
 * Which clients call a server, and how that changes across a window.
 *
 * The summary says who is busiest now. This says who arrived, who left, and
 * how the traffic moved between them, which is how a developer finds out a
 * new agent started using their server or an old one stopped.
 *
 * First and last seen are read from the whole of the rollup rather than the
 * window, since "new" means new to the server, not new to the last day.
 */
export async function getClientsOverTime(
  serverId: string,
  range: TimeRange,
  bucketSeconds: number,
  filters: Filters = {},
): Promise<ClientsOverTime> {
  const params: unknown[] = [];
  const source = unifiedCallSource(
    params,
    serverId,
    splitWindowForBucket(range, bucketSeconds),
    filters,
    bucketSeconds,
  );
  params.push(bucketSeconds);

  const [perBucket, lifetime] = await Promise.all([
    getPool().query<{ bucket: Date; client_type: string; calls: string }>(
      `SELECT time_bucket(make_interval(secs => $${params.length}::double precision), bucket)
                AS bucket,
              client_type,
              coalesce(sum(calls), 0) AS calls
       FROM ${source}
       GROUP BY 1, 2`,
      params,
    ),
    // Unknown tools are left out here as everywhere else a tool is counted,
    // so a client that only ever asked for tools that do not exist is not
    // reported as a client of this server.
    getPool().query<{ client_type: string; first_seen: Date; last_seen: Date }>(
      `SELECT client_type, min(bucket) AS first_seen, max(bucket) AS last_seen
       FROM tool_calls_hourly
       WHERE server_id = $1 AND error_source IS DISTINCT FROM $2
       GROUP BY client_type`,
      [serverId, UNKNOWN_TOOL],
    ),
  ]);

  const width = bucketSeconds * 1000;
  const first = Math.floor(range.from.getTime() / width) * width;
  const times: string[] = [];

  for (let at = first; at < range.to.getTime(); at += width) {
    times.push(new Date(at).toISOString());
  }

  const index = new Map(times.map((time, position) => [Date.parse(time), position]));
  const seen = new Map(lifetime.rows.map((row) => [row.client_type, row]));
  const byClient = new Map<string, number[]>();

  for (const row of perBucket.rows) {
    const position = index.get(row.bucket.getTime());
    if (position === undefined) continue;

    const points = byClient.get(row.client_type) ?? times.map(() => 0);
    points[position] = (points[position] ?? 0) + Number(row.calls);
    byClient.set(row.client_type, points);
  }

  const clients = [...byClient.entries()]
    .map(([clientType, points]) => {
      const lifetimeRow = seen.get(clientType);

      return {
        clientType,
        calls: points.reduce((sum, value) => sum + value, 0),
        // A client in the window is always in the rollup, whose recent part
        // is read live. Falling back to the window is only for safety.
        firstSeenAt: (lifetimeRow?.first_seen ?? range.from).toISOString(),
        lastSeenAt: (lifetimeRow?.last_seen ?? range.to).toISOString(),
        points,
      };
    })
    .filter((client) => client.calls > 0)
    .sort((a, b) => b.calls - a.calls || a.clientType.localeCompare(b.clientType))
    .slice(0, MAX_CLIENTS);

  return { bucketSeconds, times, clients };
}
