import { getPool } from './db.ts';
import { UNKNOWN_TOOL } from './filters.ts';
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
  /** Only the sessions of this client: one connection has one client, so this keeps sessions whole. */
  clientType?: string,
): string {
  params.push(serverId, range.from, range.to, maxScanned);
  const at = params.length - 3;
  let client = '';
  if (clientType !== undefined) {
    params.push(clientType);
    client = `AND client_type = $${params.length}`;
  }

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
        ${client}
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

/** What the session list can be narrowed to. */
export interface SessionFilters {
  clientType?: string | undefined;
  /** Sessions that called this tool at least once. */
  toolName?: string | undefined;
  /** Sessions with at least one failed call, or one repeated call. */
  with?: 'failures' | 'repeats' | undefined;
}

/** The most recent sessions in a window, newest first. */
export async function getSessions(
  serverId: string,
  range: TimeRange,
  /** Lowered by tests, which cannot seed a hundred thousand rows each. */
  maxScanned: number = MAX_SCANNED_CALLS,
  page: Page = { offset: 0, limit: MAX_SESSIONS },
  filters: SessionFilters = {},
): Promise<{ sessions: SessionSummary[]; sampled: boolean; hasMore: boolean }> {
  const params: unknown[] = [];
  const source = recentCalls(params, serverId, range, maxScanned, filters.clientType);
  const having: string[] = [];
  if (filters.toolName !== undefined) {
    params.push(filters.toolName);
    having.push(`bool_or(kind = 'tool' AND tool_name = $${params.length})`);
  }
  if (filters.with === 'failures') having.push('bool_or(NOT success)');
  if (filters.with === 'repeats') having.push('bool_or(repeated IS TRUE)');
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
       ${having.length === 0 ? '' : `HAVING ${having.join(' AND ')}`}
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
  /** The client's sessions only; and, given a tool, only the steps into or out of it. */
  filters: Pick<SessionFilters, 'clientType' | 'toolName'> = {},
): Promise<{ transitions: Transition[]; sampled: boolean; hasMore: boolean }> {
  const params: unknown[] = [];
  const source = recentCalls(params, serverId, range, maxScanned, filters.clientType);
  let touching = '';
  if (filters.toolName !== undefined) {
    params.push(filters.toolName);
    const tool = `$${params.length}`;
    touching = `WHERE (to_tool = ${tool} AND to_kind = 'tool') OR (from_tool = ${tool} AND from_kind = 'tool')`;
  }
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
       ${touching}
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

/** Rows on one page. */
const MAX_PREDECESSORS = 20;

export type PredecessorSort = 'all' | 'repeats' | 'failures';

/** Fixed fragments, chosen by name: nothing from the request reaches the SQL. */
const PREDECESSOR_ORDER: Record<PredecessorSort, string> = {
  all: 'count(*) DESC',
  repeats: 'count(*) FILTER (WHERE repeated IS TRUE) DESC, count(*) DESC',
  failures: 'count(*) FILTER (WHERE NOT success) DESC, count(*) DESC',
};

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
  options: {
    clientType?: string | undefined;
    /** Commonest first by both, or by repeats alone, or by failures alone. */
    sort?: PredecessorSort;
    page?: Page;
  } = {},
): Promise<{ predecessors: ProblemPredecessor[]; problems: number; hasMore: boolean }> {
  const page = options.page ?? { offset: 0, limit: MAX_PREDECESSORS };
  const params: unknown[] = [];
  const source = recentCalls(params, serverId, range, maxScanned, options.clientType);
  params.push(toolName, page.limit + 1, page.offset);
  const tool = params.length - 2;
  const order = PREDECESSOR_ORDER[options.sort ?? 'all'];

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
     ORDER BY ${order}, before_tool NULLS LAST, before_kind, client_type
     LIMIT $${tool + 1} OFFSET $${tool + 2}`,
    params,
  );
  const { items, hasMore } = takePage(result.rows, page);

  return {
    problems: Number(result.rows[0]?.problems ?? 0),
    hasMore,
    predecessors: items.map((row) => ({
      before: row.before_tool,
      beforeKind: row.before_kind,
      clientType: row.client_type,
      repeats: Number(row.repeats),
      failures: Number(row.failures),
    })),
  };
}


/**
 * How long a session has to stay quiet after a failure before the failure is
 * read as where it ended. Sooner than that, the agent may still be working.
 */
const QUIET_AFTER_FAILURE = '30 minutes';

/** Tools on one page of where agents get lost. */
const MAX_LOST_TOOLS = 10;

/**
 * What became of the sessions in the window, each by the worst that happened
 * in it. Every session with a call read counts in exactly one of these.
 */
export interface SessionOutcomes {
  /** No call failed. */
  clean: number;
  /** Every failure was followed by the same tool succeeding. */
  recovered: number;
  /** After a failure the agent went on with another tool, and the session carried on. */
  wentElsewhere: number;
  /** An agent sent the same arguments again after a failure, and never got that tool to succeed. */
  looped: number;
  /** The session stopped on a failure, and nothing came for half an hour after it. */
  endedOnFailure: number;
  /** A failure too recent to tell what became of it. */
  undecided: number;
}

/** One tool where agents got stuck: what they did after it failed. */
export interface LostTool {
  toolName: string;
  /**
   * Times an agent hit a failure of this tool. A failure and the retries of
   * the same tool straight after it count once, so ten attempts that end in
   * a success are one time stuck, not ten.
   */
  failures: number;
  /** Of those, the times the same tool then succeeded. */
  recovered: number;
  /** Retries it took, on average, when the tool then succeeded. */
  meanRetries: number | null;
  /** Times the agent went on with something else without the tool succeeding. */
  wentElsewhere: number;
  /** What it went to most often instead, of any kind. */
  insteadMostOften: { name: string; kind: CallKind; times: number } | null;
  /** Times the session stopped on it. */
  endedOnIt: number;
  /** Times any retry repeated the arguments before it (contract, 3.9), whatever came of it. */
  looped: number;
  /** Times too recent to tell. */
  undecided: number;
}

/**
 * Each time a tool failed in a session, and what the agent did about it, as a
 * subquery over the newest session calls.
 *
 * A time stuck starts at a failed tool call that does not continue a failing
 * run of the same tool, and takes in the calls to that tool straight after
 * it, up to and including the first that succeeds. What follows decides its
 * outcome: that success, another call (anything else), or nothing. Nothing is
 * read as the session ending there only once the window has gone quiet for
 * QUIET_AFTER_FAILURE after it, since a session cut by the window's end, or
 * still going, would otherwise look like one an agent gave up on.
 */
function timesStuck(params: unknown[], source: string, range: TimeRange): string {
  params.push(range.to, UNKNOWN_TOOL);
  const to = params.length - 1;
  const unknown = params.length;

  return `(
    WITH ordered AS (
      SELECT *,
             lag(tool_name) OVER calls_in_order AS before_name,
             lag(kind) OVER calls_in_order AS before_kind,
             lag(success) OVER calls_in_order AS before_succeeded,
             lead(tool_name) OVER calls_in_order AS next_name,
             lead(kind) OVER calls_in_order AS next_kind
      FROM ${source}
      WINDOW calls_in_order AS (PARTITION BY session_id ORDER BY occurred_at, id)
    ),
    numbered AS (
      SELECT *,
             sum(CASE WHEN before_name = tool_name AND before_kind = kind THEN 0 ELSE 1 END)
               OVER calls_in_order AS run,
             sum(CASE WHEN kind = 'tool' AND NOT success
                       AND (before_name IS DISTINCT FROM tool_name
                            OR before_kind IS DISTINCT FROM kind
                            OR before_succeeded)
                      THEN 1 ELSE 0 END)
               OVER calls_in_order AS stuck
      FROM ordered
      WINDOW calls_in_order AS (PARTITION BY session_id ORDER BY occurred_at, id)
    ),
    placed AS (
      SELECT *,
             first_value(run) OVER since_stuck AS stuck_run,
             coalesce(sum(success::int) OVER (since_stuck ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
               AS successes_before
      FROM numbered
      WHERE stuck > 0
      WINDOW since_stuck AS (PARTITION BY session_id, stuck ORDER BY occurred_at, id)
    ),
    times AS (
      SELECT session_id,
             min(tool_name) AS tool_name,
             min(client_type) AS client_type,
             bool_or(error_source = $${unknown}) AS unknown_tool,
             count(*) - 1 AS retries,
             bool_or(success) AS recovered,
             bool_or(repeated IS TRUE) AS looped,
             (array_agg(next_name ORDER BY occurred_at DESC, id DESC))[1] AS next_name,
             (array_agg(next_kind ORDER BY occurred_at DESC, id DESC))[1] AS next_kind,
             max(occurred_at) AS last_at
      FROM placed
      WHERE run = stuck_run AND successes_before = 0
      GROUP BY session_id, stuck
    )
    SELECT *,
           CASE WHEN recovered THEN 'recovered'
                WHEN next_name IS NOT NULL THEN 'elsewhere'
                WHEN last_at < $${to}::timestamptz - interval '${QUIET_AFTER_FAILURE}' THEN 'ended'
                ELSE 'undecided'
           END AS outcome
    FROM times
  ) AS stuck_times`;
}

/**
 * Where agents get lost: what became of each session, and the tools where
 * they got stuck, worst first - those that sessions ended on or looped at
 * most, then those that failed agents most often.
 *
 * Names that are not tools of the server are left out of the tools, having
 * their own view, but count towards what became of a session.
 */
export async function getLostAgents(
  serverId: string,
  range: TimeRange,
  /** Lowered by tests, like the ones above. */
  maxScanned: number = MAX_SCANNED_CALLS,
  page: Page = { offset: 0, limit: MAX_LOST_TOOLS },
  /** The client's sessions only; given a tool, only that tool's row. */
  filters: Pick<SessionFilters, 'clientType' | 'toolName'> = {},
): Promise<{ sessions: SessionOutcomes; tools: LostTool[]; sampled: boolean; hasMore: boolean }> {
  const sessionParams: unknown[] = [];
  const sessionSource = recentCalls(sessionParams, serverId, range, maxScanned, filters.clientType);
  const sessionStuck = timesStuck(sessionParams, sessionSource, range);
  const allParams: unknown[] = [];
  const allSource = recentCalls(allParams, serverId, range, maxScanned, filters.clientType);

  const [sessions, stuck, tools, sampled] = await Promise.all([
    getPool().query<{ sessions: string }>(
      `SELECT count(DISTINCT session_id) AS sessions FROM ${allSource}`,
      allParams,
    ),
    getPool().query<{ outcome: keyof SessionOutcomes; sessions: string }>(
      `SELECT outcome, count(*) AS sessions
       FROM (
         SELECT CASE WHEN bool_or(outcome = 'ended') THEN 'endedOnFailure'
                     WHEN bool_or(looped AND NOT recovered AND outcome <> 'undecided') THEN 'looped'
                     WHEN bool_or(outcome = 'undecided') THEN 'undecided'
                     WHEN bool_or(outcome = 'elsewhere') THEN 'wentElsewhere'
                     ELSE 'recovered'
                END AS outcome
         FROM ${sessionStuck}
         GROUP BY session_id
       ) AS by_session
       GROUP BY outcome`,
      sessionParams,
    ),
    stuckBy('tool_name', serverId, range, maxScanned, filters, page),
    wasSampled(serverId, range, maxScanned),
  ]);

  const outcomes: SessionOutcomes = {
    clean: 0,
    recovered: 0,
    wentElsewhere: 0,
    looped: 0,
    endedOnFailure: 0,
    undecided: 0,
  };
  for (const row of stuck.rows) outcomes[row.outcome] = Number(row.sessions);
  const troubled = stuck.rows.reduce((sum, row) => sum + Number(row.sessions), 0);
  outcomes.clean = Number(sessions.rows[0]?.sessions ?? 0) - troubled;

  const { items, hasMore } = takePage(tools, page);

  return {
    sessions: outcomes,
    tools: items.map(({ group, ...tool }) => ({ toolName: group, ...tool })),
    sampled,
    hasMore,
  };
}

/** Clients on the tool page's split, the most stuck first. */
const MAX_LOST_CLIENTS = 20;

/** What agents did after one tool failed, as a whole and by the client they ran in. */
export interface ToolAfterFailure {
  tool: Omit<LostTool, 'toolName'> | null;
  clients: (Omit<LostTool, 'toolName'> & { clientType: string })[];
  sampled: boolean;
}

/**
 * After one tool fails: the times agents got stuck at it and what came of
 * them, then the same by client. Clients differ more here than anywhere: one
 * reads the error and fixes its arguments, another sends them again.
 */
export async function getToolAfterFailure(
  serverId: string,
  range: TimeRange,
  toolName: string,
  /** Lowered by tests, like the ones above. */
  maxScanned: number = MAX_SCANNED_CALLS,
): Promise<ToolAfterFailure> {
  const [whole, clients, sampled] = await Promise.all([
    stuckBy('tool_name', serverId, range, maxScanned, { toolName }, { offset: 0, limit: 1 }),
    stuckBy('client_type', serverId, range, maxScanned, { toolName }, { offset: 0, limit: MAX_LOST_CLIENTS }),
    wasSampled(serverId, range, maxScanned),
  ]);

  const tool = whole[0];

  return {
    tool: tool === undefined ? null : withoutGroup(tool),
    clients: clients.slice(0, MAX_LOST_CLIENTS).map(({ group, ...rest }) => ({ clientType: group, ...rest })),
    sampled,
  };
}

function withoutGroup<T extends { group: unknown }>({ group: _group, ...rest }: T): Omit<T, 'group'> {
  return rest;
}

/**
 * The times stuck, grouped by tool or by client, worst first: the most ended
 * on or looped at, then the most stuck. One row past the page is fetched, to
 * tell whether there is more.
 */
async function stuckBy(
  group: 'tool_name' | 'client_type',
  serverId: string,
  range: TimeRange,
  maxScanned: number,
  filters: Pick<SessionFilters, 'clientType' | 'toolName'>,
  page: Page,
): Promise<(Omit<LostTool, 'toolName'> & { group: string })[]> {
  const params: unknown[] = [];
  const source = recentCalls(params, serverId, range, maxScanned, filters.clientType);
  const stuck = timesStuck(params, source, range);
  let onlyTool = '';
  if (filters.toolName !== undefined) {
    params.push(filters.toolName);
    onlyTool = `AND tool_name = $${params.length}`;
  }
  params.push(page.limit + 1, page.offset);

  const result = await getPool().query<{
    grouped: string;
    failures: string;
    recovered: string;
    mean_retries: string | null;
    elsewhere: string;
    ended: string;
    looped: string;
    undecided: string;
    instead_name: string | null;
    instead_kind: CallKind | null;
    instead_times: string | null;
  }>(
    `WITH stuck AS (SELECT *, ${group} AS grouped FROM ${stuck} WHERE NOT unknown_tool ${onlyTool}),
     instead AS (
       SELECT grouped, next_name, next_kind, count(*) AS times,
              row_number() OVER (PARTITION BY grouped ORDER BY count(*) DESC, next_name, next_kind) AS rank
       FROM stuck
       WHERE outcome = 'elsewhere'
       GROUP BY grouped, next_name, next_kind
     ),
     grouped AS (
       SELECT grouped,
              count(*) AS failures,
              count(*) FILTER (WHERE outcome = 'recovered') AS recovered,
              avg(retries) FILTER (WHERE outcome = 'recovered') AS mean_retries,
              count(*) FILTER (WHERE outcome = 'elsewhere') AS elsewhere,
              count(*) FILTER (WHERE outcome = 'ended') AS ended,
              count(*) FILTER (WHERE looped) AS looped,
              count(*) FILTER (WHERE outcome = 'undecided') AS undecided
       FROM stuck
       GROUP BY grouped
     )
     SELECT grouped.*, instead.next_name AS instead_name, instead.next_kind AS instead_kind,
            instead.times AS instead_times
     FROM grouped
     LEFT JOIN instead ON instead.grouped = grouped.grouped AND instead.rank = 1
     ORDER BY grouped.ended + grouped.looped DESC, grouped.failures DESC, grouped.grouped
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    group: row.grouped,
    failures: Number(row.failures),
    recovered: Number(row.recovered),
    meanRetries: row.mean_retries === null ? null : Number(row.mean_retries),
    wentElsewhere: Number(row.elsewhere),
    insteadMostOften:
      row.instead_name === null || row.instead_kind === null
        ? null
        : { name: row.instead_name, kind: row.instead_kind, times: Number(row.instead_times) },
    endedOnIt: Number(row.ended),
    looped: Number(row.looped),
    undecided: Number(row.undecided),
  }));
}
