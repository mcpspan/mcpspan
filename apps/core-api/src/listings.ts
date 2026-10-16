import { getPool } from './db.ts';
import type { TimeRange } from './time-range.ts';

/** One tool as the sessions in a period were shown it (contract, 3.11). */
export interface ListedToolStats {
  name: string;
  /** Sessions shown the tool. */
  sessions: number;
  /** Of those, the sessions that called it. */
  usedSessions: number;
  /** Calls to it in the period, from any session or none. */
  calls: number;
  /** Size of its definition as last listed, in UTF-8 bytes of canonical JSON. */
  bytes: number;
  /** Whether the latest listing still has it. */
  listed: boolean;
}

export interface ToolListing {
  /** Sessions shown the server's tools in the period. */
  sessions: number;
  /** The latest listing: how many tools, and their definitions' size together. */
  latest: { tools: number; bytes: number; at: string } | null;
  /** Tools the latest listing has that no session shown them called. */
  neverUsed: number;
  /** How many tools were listed in the period, on every page. */
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  /** One page of them, in the order asked for. */
  tools: ListedToolStats[];
}

/** How the tools can be ordered: the least used first, the largest first, or by name. */
export const LISTING_ORDERS = {
  'least-used': 'coalesce(u.sessions, 0)::float / p.sessions, p.sessions DESC, p.name',
  largest: 'p.bytes DESC, p.name',
  name: 'p.name',
} as const;

export type ListingOrder = keyof typeof LISTING_ORDERS;

/**
 * What agents were shown and what they used (contract, 3.11): for each tool
 * listed in the period, how many sessions were shown it and how many of those
 * called it, and how large its definition is. A session's listing and its
 * calls are matched by the session; calls with no session count only in
 * `calls`. A listing without a session counts as a session of its own.
 */
export async function getToolListing(
  serverId: string,
  range: TimeRange,
  clientType?: string,
  page: { order?: ListingOrder; offset?: number; limit?: number } = {},
): Promise<ToolListing> {
  const order = LISTING_ORDERS[page.order ?? 'least-used'];
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 1_000;
  const params: unknown[] = [serverId, range.from, range.to];
  let client = '';
  if (clientType !== undefined) {
    params.push(clientType);
    client = `AND client_type = $${params.length}`;
  }

  const result = await getPool().query<{
    name: string;
    sessions: string;
    used_sessions: string;
    calls: string;
    bytes: number;
    listed: boolean;
    all_sessions: string;
  }>(
    `WITH listings AS (
       SELECT id, session_id, occurred_at, tool_names, definition_bytes
       FROM tool_listings
       WHERE server_id = $1 AND occurred_at >= $2 AND occurred_at < $3 ${client}
     ),
     latest AS (
       SELECT tool_names FROM listings ORDER BY occurred_at DESC LIMIT 1
     ),
     shown AS (
       SELECT coalesce(l.session_id, l.id) AS session, l.session_id, t.name, t.bytes, l.occurred_at
       FROM listings l, unnest(l.tool_names, l.definition_bytes) AS t (name, bytes)
     ),
     per_tool AS (
       SELECT name,
              count(DISTINCT session) AS sessions,
              (array_agg(bytes ORDER BY occurred_at DESC))[1] AS bytes
       FROM shown
       GROUP BY name
     ),
     called AS (
       SELECT DISTINCT session_id, tool_name AS name
       FROM tool_calls
       WHERE server_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND session_id IS NOT NULL ${client}
     ),
     used AS (
       SELECT s.name, count(DISTINCT s.session_id) AS sessions
       FROM (SELECT DISTINCT session_id, name FROM shown WHERE session_id IS NOT NULL) s
       JOIN called c USING (session_id, name)
       GROUP BY s.name
     ),
     calls AS (
       SELECT tool_name AS name, count(*) AS calls
       FROM tool_calls
       WHERE server_id = $1 AND occurred_at >= $2 AND occurred_at < $3 ${client}
       GROUP BY tool_name
     )
     SELECT p.name, p.sessions, coalesce(u.sessions, 0) AS used_sessions, coalesce(c.calls, 0) AS calls,
            p.bytes, p.name = ANY (coalesce((SELECT tool_names FROM latest), '{}'::text[])) AS listed,
            (SELECT count(DISTINCT session) FROM shown) AS all_sessions
     FROM per_tool p
     LEFT JOIN used u USING (name)
     LEFT JOIN calls c USING (name)
     ORDER BY ${order}`,
    params,
  );

  const all = result.rows.map((row) => ({
    name: row.name,
    sessions: Number(row.sessions),
    usedSessions: Number(row.used_sessions),
    calls: Number(row.calls),
    bytes: row.bytes,
    listed: row.listed,
  }));

  const latest = await getPool().query<{ tools: number; bytes: string; at: Date }>(
    `SELECT cardinality(tool_names) AS tools,
            (SELECT coalesce(sum(b), 0) FROM unnest(definition_bytes) AS b) AS bytes,
            occurred_at AS at
     FROM tool_listings
     WHERE server_id = $1 AND occurred_at >= $2 AND occurred_at < $3 ${client}
     ORDER BY occurred_at DESC
     LIMIT 1`,
    params,
  );
  const last = latest.rows[0];

  // Paged here rather than in SQL: the list is one row per tool, and the counts above need all of it.
  return {
    sessions: Number(result.rows[0]?.all_sessions ?? 0),
    latest: last === undefined ? null : { tools: last.tools, bytes: Number(last.bytes), at: last.at.toISOString() },
    neverUsed: all.filter((tool) => tool.listed && tool.usedSessions === 0).length,
    total: all.length,
    offset,
    limit,
    hasMore: offset + limit < all.length,
    tools: all.slice(offset, offset + limit),
  };
}
