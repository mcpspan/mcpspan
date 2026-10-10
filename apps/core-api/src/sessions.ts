import { getPool } from './db.ts';
import { CALL_TABLES, type CallKind } from './rollup.ts';

const KINDS = Object.keys(CALL_TABLES) as CallKind[];
import { type Cursor, encodeCursor, type Page, takePage } from './paging.ts';
import type { TimeRange } from './time-range.ts';

/**
 * How many of the newest calls in a window the session views look at.
 *
 * Grouping calls into sessions, or pairing each with the one before it, has
 * to read every row it covers; nothing about it can be summed ahead of time
 * the way counts are. A month of a busy server is tens of millions of rows,
 * and a page that reads all of them before drawing gets slower every week it
 * runs. The newest hundred thousand are read instead, backwards along the
 * existing (server_id, occurred_at) index, so the cost stays the same however
 * much there is. Responses say when this happened.
 */
const MAX_SCANNED_CALLS = 100_000;

/** Sessions on one page, newest first. */
const MAX_SESSIONS = 50;

/** Transitions on one page, commonest first. */
const MAX_TRANSITIONS = 30;

/** Calls on one page of a session, in order. */
const MAX_SESSION_CALLS = 500;

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  calls: number;
  failures: number;
  /** Distinct tools called, refused names included. */
  tools: number;
  /** Calls that repeated the previous call's arguments to the same tool: an agent looping (contract, 3.9). */
  repeated: number;
  clientType: string;
  clientName: string | null;
}

export interface SessionCall {
  id: string;
  occurredAt: string;
  /** A tool call, a resource read or a prompt got. */
  kind: CallKind;
  /** What was called: a tool's name, a resource's URI or template, a prompt's name. */
  toolName: string;
  success: boolean;
  errorSource: string | null;
  errorType: string | null;
  errorMessage: string | null;
  durationMs: number;
  clientType: string;
  clientName: string | null;
  /** Its arguments were the previous call's to the same tool in this session (contract, 3.9). */
  repeated: boolean;
}

export interface Transition {
  /** What was called just before, or null when this call opened its session. */
  from: string | null;
  fromKind: CallKind | null;
  to: string;
  toKind: CallKind;
  calls: number;
  /** How many of those followed a failed call. */
  afterFailure: number;
}

/**
 * The newest calls in the window that belong to a session, as a subquery.
 *
 * Calls without a session - recorded through track() alone, or by an SDK from
 * before sessions - cannot be placed in one, and are left out.
 */
function recentCalls(
  params: unknown[],
  serverId: string,
  range: TimeRange,
  maxScanned: number,
): string {
  params.push(serverId, range.from, range.to, maxScanned);
  const at = params.length - 3;

  // Each table's newest rows first, from its own index, then the newest of
  // those: an agent's session is its tool calls, resource reads and prompt
  // gets in one order.
  const newest = (kind: CallKind) => {
    const table = CALL_TABLES[kind];
    return `(SELECT id, session_id, occurred_at, ${table.name} AS tool_name, '${kind}' AS kind,
             success, error_source, duration_ms, client_type, client_name, repeated
      FROM ${table.raw}
      WHERE server_id = $${at}
        AND occurred_at >= $${at + 1}
        AND occurred_at < $${at + 2}
        AND session_id IS NOT NULL
      ORDER BY occurred_at DESC
      LIMIT $${at + 3})`;
  };

  return `(
    SELECT * FROM (${KINDS.map(newest).join(' UNION ALL ')}) AS every_kind
    ORDER BY occurred_at DESC
    LIMIT $${at + 3}
  ) AS recent`;
}

/** Whether the window held more calls than were read. */
async function wasSampled(
  serverId: string,
  range: TimeRange,
  maxScanned: number,
): Promise<boolean> {
  const result = await getPool().query<{ more: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM (${KINDS.map(
         (kind) => `SELECT occurred_at FROM ${CALL_TABLES[kind].raw}
                    WHERE server_id = $1 AND occurred_at >= $2 AND occurred_at < $3
                      AND session_id IS NOT NULL`,
       ).join(' UNION ALL ')}) AS every_kind
       OFFSET $4 LIMIT 1
     ) AS more`,
    [serverId, range.from, range.to, maxScanned],
  );

  return result.rows[0]?.more === true;
}

/** The most recent sessions in a window, newest first. */
export async function getSessions(
  serverId: string,
  range: TimeRange,
  /** Lowered by tests, which cannot seed a hundred thousand rows each. */
  maxScanned: number = MAX_SCANNED_CALLS,
  page: Page = { offset: 0, limit: MAX_SESSIONS },
): Promise<{ sessions: SessionSummary[]; sampled: boolean; hasMore: boolean }> {
  const params: unknown[] = [];
  const source = recentCalls(params, serverId, range, maxScanned);
  params.push(page.limit + 1, page.offset);

  const [result, sampled] = await Promise.all([
    getPool().query<{
      session_id: string;
      started_at: Date;
      ended_at: Date;
      calls: string;
      failures: string;
      tools: string;
      repeated: string;
      client_type: string;
      client_name: string | null;
    }>(
      `SELECT session_id,
              min(occurred_at) AS started_at,
              max(occurred_at) AS ended_at,
              count(*) AS calls,
              count(*) FILTER (WHERE NOT success) AS failures,
              count(DISTINCT tool_name) FILTER (WHERE kind = 'tool') AS tools,
              count(*) FILTER (WHERE repeated) AS repeated,
              -- One connection has one client, so any row says which.
              min(client_type) AS client_type,
              min(client_name) AS client_name
       FROM ${source}
       GROUP BY session_id
       ORDER BY ended_at DESC, session_id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    wasSampled(serverId, range, maxScanned),
  ]);

  const { items, hasMore } = takePage(result.rows, page);

  return {
    hasMore,
    sessions: items.map((row) => ({
      sessionId: row.session_id,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at.toISOString(),
      calls: Number(row.calls),
      failures: Number(row.failures),
      tools: Number(row.tools),
      repeated: Number(row.repeated),
      clientType: row.client_type,
      clientName: row.client_name,
    })),
    sampled,
  };
}

/**
 * One session's calls, in the order they happened.
 *
 * Read within a window rather than by the session alone, because there is no
 * index on the session: the list that links here knows when the session
 * started and ended, and passes that, so only that span of the server's rows
 * is read.
 */
export async function getSessionCalls(
  serverId: string,
  sessionId: string,
  range: TimeRange,
  /** Where the previous page ended; this one starts just after it. */
  after?: Cursor,
): Promise<{ calls: SessionCall[]; nextCursor: string | null }> {
  const params: unknown[] = [serverId, sessionId, range.from, range.to];
  let resume = '';

  if (after !== undefined) {
    params.push(after.at, after.id);
    resume = `AND (occurred_at, id) > ($5::timestamptz, $6)`;
  }

  params.push(MAX_SESSION_CALLS + 1);

  const result = await getPool().query<{
    id: string;
    occurred_at: Date;
    cursor_at: string;
    tool_name: string;
    kind: CallKind;
    success: boolean;
    error_source: string | null;
    error_type: string | null;
    error_message: string | null;
    duration_ms: number;
    client_type: string;
    client_name: string | null;
    repeated: boolean | null;
  }>(
    `SELECT id, occurred_at, occurred_at::text AS cursor_at, tool_name, kind, success,
            error_source, error_type, error_message, duration_ms, client_type, client_name, repeated
     FROM (${KINDS.map(
       (kind) => `SELECT id, occurred_at, ${CALL_TABLES[kind].name} AS tool_name, '${kind}' AS kind,
                         success, error_source, error_type, error_message, duration_ms,
                         client_type, client_name, repeated
                  FROM ${CALL_TABLES[kind].raw}
                  WHERE server_id = $1
                    AND session_id = $2
                    AND occurred_at >= $3
                    AND occurred_at < $4`,
     ).join(' UNION ALL ')}) AS every_kind
     WHERE true
       ${resume}
     ORDER BY occurred_at, id
     LIMIT $${params.length}`,
    params,
  );

  const rows = result.rows.slice(0, MAX_SESSION_CALLS);
  const last = rows.at(-1);

  return {
    nextCursor:
      result.rows.length > MAX_SESSION_CALLS && last !== undefined
        ? encodeCursor({ at: last.cursor_at, id: last.id })
        : null,
    calls: rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      kind: row.kind,
      toolName: row.tool_name,
      success: row.success,
      errorSource: row.error_source,
      errorType: row.error_type,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      clientType: row.client_type,
      clientName: row.client_name,
      repeated: row.repeated === true,
    })),
  };
}

/**
 * Which tool follows which, across every session in the window.
 *
 * Pairs rather than longer chains, because pairs are what the questions worth
 * asking come down to: `search` is nearly always followed by `book` (so maybe
 * they are one tool), `list_items` by `list_items` (so paging is too small),
 * a failed call by the same call again (so its error message is not telling
 * the agent what to change). Longer chains multiply into so many distinct
 * paths that none of them is common enough to read anything into.
 *
 * Refused calls are included, since an agent retrying after its arguments were
 * rejected is exactly the pattern worth seeing.
 */
export async function getTransitions(
  serverId: string,
  range: TimeRange,
  /** Lowered by tests, like the one above. */
  maxScanned: number = MAX_SCANNED_CALLS,
  page: Page = { offset: 0, limit: MAX_TRANSITIONS },
): Promise<{ transitions: Transition[]; sampled: boolean; hasMore: boolean }> {
  const params: unknown[] = [];
  const source = recentCalls(params, serverId, range, maxScanned);
  params.push(page.limit + 1, page.offset);

  const [result, sampled] = await Promise.all([
    getPool().query<{
      from_tool: string | null;
      from_kind: CallKind | null;
      to_tool: string;
      to_kind: CallKind;
      calls: string;
      after_failure: string;
    }>(
      `SELECT from_tool, from_kind, to_tool, to_kind,
              count(*) AS calls,
              count(*) FILTER (WHERE previous_failed) AS after_failure
       FROM (
         SELECT tool_name AS to_tool,
                kind AS to_kind,
                lag(tool_name) OVER calls_in_order AS from_tool,
                lag(kind) OVER calls_in_order AS from_kind,
                NOT coalesce(lag(success) OVER calls_in_order, true) AS previous_failed
         FROM ${source}
         WINDOW calls_in_order AS (PARTITION BY session_id ORDER BY occurred_at, id)
       ) AS paired
       GROUP BY from_tool, from_kind, to_tool, to_kind
       ORDER BY calls DESC, from_tool NULLS FIRST, from_kind NULLS FIRST, to_tool, to_kind
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    wasSampled(serverId, range, maxScanned),
  ]);

  const { items, hasMore } = takePage(result.rows, page);

  return {
    hasMore,
    transitions: items.map((row) => ({
      from: row.from_tool,
      fromKind: row.from_kind,
      to: row.to_tool,
      toKind: row.to_kind,
      calls: Number(row.calls),
      afterFailure: Number(row.after_failure),
    })),
    sampled,
  };
}

/** What came right before a tool's repeated or failed calls, from one client. */
export interface ProblemPredecessor {
  /** The call just before, in the same session; null when nothing before it was read. */
  before: string | null;
  beforeKind: CallKind | null;
  clientType: string;
  /** Of the calls this one preceded: those that repeated the previous call's arguments (contract, 3.9). */
  repeats: number;
  /** And those that failed, refused ones included. A call can be both. */
  failures: number;
}

/** Rows shown at most. */
const MAX_PREDECESSORS = 20;

/**
 * For one tool's calls that repeated or failed, which call came right before
 * each in its session, by client: `list_elements` failing after `click`, or
 * repeated after it, says the click did not land. Read from the same newest
 * session calls as the transitions, so a session cut by the window's start
 * shows its first call read as having nothing before it.
 */
export async function getProblemPredecessors(
  serverId: string,
  toolName: string,
  range: TimeRange,
  maxScanned: number = MAX_SCANNED_CALLS,
): Promise<{ predecessors: ProblemPredecessor[]; problems: number }> {
  const params: unknown[] = [];
  const source = recentCalls(params, serverId, range, maxScanned);
  params.push(toolName, MAX_PREDECESSORS);
  const tool = params.length - 1;

  const result = await getPool().query<{
    before_tool: string | null;
    before_kind: CallKind | null;
    client_type: string;
    repeats: string;
    failures: string;
    problems: string;
  }>(
    `WITH paired AS (
       SELECT tool_name, kind, success, repeated, client_type,
              lag(tool_name) OVER calls_in_order AS before_tool,
              lag(kind) OVER calls_in_order AS before_kind
       FROM ${source}
       WINDOW calls_in_order AS (PARTITION BY session_id ORDER BY occurred_at, id)
     ),
     problems AS (
       SELECT * FROM paired
       WHERE kind = 'tool' AND tool_name = $${tool} AND (repeated IS TRUE OR NOT success)
     )
     SELECT before_tool, before_kind, client_type,
            count(*) FILTER (WHERE repeated IS TRUE) AS repeats,
            count(*) FILTER (WHERE NOT success) AS failures,
            (SELECT count(*) FROM problems) AS problems
     FROM problems
     GROUP BY before_tool, before_kind, client_type
     ORDER BY count(*) DESC, before_tool NULLS LAST, before_kind, client_type
     LIMIT $${tool + 1}`,
    params,
  );

  return {
    problems: Number(result.rows[0]?.problems ?? 0),
    predecessors: result.rows.map((row) => ({
      before: row.before_tool,
      beforeKind: row.before_kind,
      clientType: row.client_type,
      repeats: Number(row.repeats),
      failures: Number(row.failures),
    })),
  };
}

