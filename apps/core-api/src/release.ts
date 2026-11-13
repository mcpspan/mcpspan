import { getPool } from './db.ts';
import { UNKNOWN_TOOL } from './filters.ts';
import { getLostAgents, type SessionOutcomes } from './sessions.ts';
import type { TimeRange } from './time-range.ts';

/** How long after a release the report looks: a week says what a release did, and the week before is still in raw retention. */
const MAX_REPORT_MS = 7 * 24 * 60 * 60 * 1000;

/** Fewer calls than this on either side, and the report gives the numbers without a verdict. */
export const MIN_CALLS_FOR_VERDICT = 50;

/** The same for one tool's row. */
const MIN_TOOL_CALLS_FOR_VERDICT = 20;

/** An error rate this many points higher is a change worth naming, if it is not chance. */
const ERROR_RATE_POINTS = 0.01;

/** How sure a difference in error rate must be, as a z-score: about 1 in 100 by chance. */
const Z_SCORE = 2.58;

/** p95 this much slower, and at least `SLOWER_MS`, is slower. */
const SLOWER_RATIO = 1.25;
const SLOWER_MS = 50;

/** A definition seen first this soon before a version's first call came with it: the SDK reports both at once, give or take a listing. */
const DEFINITION_LEAD_MS = 10 * 60 * 1000;

/** A client whose share of calls moved by this many points changes what the numbers mean. */
const CLIENT_SHIFT_POINTS = 0.2;

/** More rows than a report has room for. */
const MAX_TOOLS = 100;
const MAX_NEW_FAILURES = 20;

export type Verdict = 'worse' | 'same' | 'better' | 'too-early' | 'first';

export interface ReleaseSide {
  calls: number;
  errors: number;
  errorRate: number;
  durationMs: { p50: number | null; p95: number | null };
}

export interface ReleaseTool {
  toolName: string;
  /** Null when the previous version had no calls to it in the period compared. */
  before: (ReleaseSide & { refused: number }) | null;
  after: (ReleaseSide & { refused: number }) | null;
  verdict: Verdict;
  /** Its name, description or schema changed with this version. */
  definitionChanged: boolean;
}

export interface NewFailure {
  toolName: string;
  errorSource: string | null;
  errorType: string | null;
  calls: number;
  firstAt: string;
}

export interface ReleaseReport {
  version: string;
  /** The version it is compared with, the one seen first before it. */
  previous: string | null;
  /** When this version answered its first call. */
  releasedAt: string;
  /** The two periods compared: the same length, either side of the release. */
  before: { from: string; to: string } | null;
  after: { from: string; to: string };
  verdict: Verdict;
  overall: { before: ReleaseSide | null; after: ReleaseSide };
  /** Worst change first. */
  tools: ReleaseTool[];
  /** Kinds of failure the previous version did not have. */
  newFailures: NewFailure[];
  /** What became of sessions in each period, from every version that answered them. */
  agents: { before: SessionOutcomes | null; after: SessionOutcomes };
  /** Share of calls by client in each period, and whether it moved enough to matter. */
  clients: { clientType: string; before: number; after: number }[];
  clientsShifted: boolean;
  /** Calls in the period after the release that another version answered: a partly upgraded fleet. */
  otherVersionCalls: number;
}

interface Window {
  version: string;
  range: TimeRange;
}

/**
 * Did a release make things worse: one server version against the one before it.
 *
 * The new version's calls from its first one, for up to a week or until a newer
 * version arrived, against the previous version's calls over a period just as
 * long right before it. The same length either side keeps the traffic and the
 * time of day alike, so a difference is the release's rather than the calendar's.
 *
 * Null when the server has never reported that version, or any version.
 */
export async function getReleaseReport(
  serverId: string,
  options: { version?: string; clientType?: string; now?: Date } = {},
): Promise<ReleaseReport | null> {
  const known = await getPool().query<{ version: string; first_seen_at: Date }>(
    `SELECT version, first_seen_at FROM server_versions WHERE server_id = $1 ORDER BY first_seen_at DESC`,
    [serverId],
  );

  const index =
    options.version === undefined ? 0 : known.rows.findIndex((row) => row.version === options.version);
  const current = known.rows[index];

  if (current === undefined) return null;

  const previous = known.rows[index + 1];
  const newer = known.rows[index - 1];
  const releasedAt = current.first_seen_at;
  const now = options.now ?? new Date();
  const end = Math.min(now.getTime(), releasedAt.getTime() + MAX_REPORT_MS, newer?.first_seen_at.getTime() ?? Infinity);
  // A clock that put the first call ahead of now still gives a period, if an empty one.
  const length = Math.max(end - releasedAt.getTime(), 0);
  const afterRange = { from: releasedAt, to: new Date(releasedAt.getTime() + length) };
  const beforeRange = { from: new Date(releasedAt.getTime() - length), to: releasedAt };
  const after: Window = { version: current.version, range: afterRange };
  const before: Window | undefined =
    previous === undefined ? undefined : { version: previous.version, range: beforeRange };
  const clientType = options.clientType;

  const [overallAfter, overallBefore, tools, newFailures, definitions, clients, others, agentsAfter, agentsBefore] =
    await Promise.all([
      side(serverId, after, clientType),
      before === undefined ? undefined : side(serverId, before, clientType),
      before === undefined ? [] : toolSides(serverId, before, after, clientType),
      before === undefined ? [] : failuresNew(serverId, before, after, clientType),
      before === undefined ? new Set<string>() : changedDefinitions(serverId, releasedAt, afterRange.to),
      clientShares(serverId, before?.range, afterRange),
      otherVersionCalls(serverId, after, clientType),
      outcomes(serverId, afterRange, clientType),
      before === undefined ? undefined : outcomes(serverId, beforeRange, clientType),
    ]);

  const rows: ReleaseTool[] = tools.map((tool) => ({
    ...tool,
    verdict: compare(tool.before, tool.after, MIN_TOOL_CALLS_FOR_VERDICT),
    definitionChanged: definitions.has(tool.toolName),
  }));
  rows.sort((a, b) => severity(b) - severity(a) || a.toolName.localeCompare(b.toolName));

  return {
    version: current.version,
    previous: previous?.version ?? null,
    releasedAt: releasedAt.toISOString(),
    before: before === undefined ? null : describe(beforeRange),
    after: describe(afterRange),
    verdict: overallBefore === undefined ? 'first' : compare(overallBefore, overallAfter, MIN_CALLS_FOR_VERDICT),
    overall: { before: overallBefore ?? null, after: overallAfter },
    tools: rows.slice(0, MAX_TOOLS),
    newFailures,
    agents: { before: agentsBefore ?? null, after: agentsAfter },
    clients,
    clientsShifted: before !== undefined && clients.some((c) => Math.abs(c.after - c.before) >= CLIENT_SHIFT_POINTS),
    otherVersionCalls: others,
  };
}

/**
 * Worse, better or the same: worse when errors rose by more than chance and a
 * point, or the slowest calls slowed by a quarter; better the other way round.
 * Errors decide before time, so a release that fails faster is not better.
 */
export function compare(before: ReleaseSide | null, after: ReleaseSide | null, minCalls: number): Verdict {
  if (before === null || after === null || before.calls < minCalls || after.calls < minCalls) return 'too-early';

  const errors = errorChange(before, after);
  if (errors !== 0) return errors > 0 ? 'worse' : 'better';

  const [was, now] = [before.durationMs.p95, after.durationMs.p95];
  if (was !== null && now !== null) {
    if (now >= was * SLOWER_RATIO && now - was >= SLOWER_MS) return 'worse';
    // Faster is better only when it does not fail more: quicker errors are no improvement.
    const failsMore = after.errorRate - before.errorRate >= ERROR_RATE_POINTS;
    if (!failsMore && was >= now * SLOWER_RATIO && was - now >= SLOWER_MS) return 'better';
  }

  return 'same';
}

/** 1 when errors rose beyond chance, -1 when they fell, 0 otherwise: a two-proportion z-test. */
function errorChange(before: ReleaseSide, after: ReleaseSide): number {
  const difference = after.errorRate - before.errorRate;
  if (Math.abs(difference) < ERROR_RATE_POINTS) return 0;

  const pooled = (before.errors + after.errors) / (before.calls + after.calls);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / before.calls + 1 / after.calls));
  if (spread === 0 || Math.abs(difference) / spread < Z_SCORE) return 0;

  return Math.sign(difference);
}

/** Worse first, then the ones too early to call that have calls only now, then by how many more errors. */
function severity(tool: ReleaseTool): number {
  const rank = { worse: 3, 'too-early': 1, same: 0, better: -1, first: 0 }[tool.verdict];
  const rise = (tool.after?.errorRate ?? 0) - (tool.before?.errorRate ?? 0);

  return rank * 10 + rise + (tool.definitionChanged ? 0.5 : 0);
}

function describe(range: TimeRange): { from: string; to: string } {
  return { from: range.from.toISOString(), to: range.to.toISOString() };
}

const SIDE_COLUMNS = `count(*) AS calls,
       count(*) FILTER (WHERE NOT success) AS errors,
       count(*) FILTER (WHERE error_source = 'arguments') AS refused,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95`;

interface SideRow {
  calls: string;
  errors: string;
  refused: string;
  p50: number | null;
  p95: number | null;
}

function toSide(row: SideRow): ReleaseSide & { refused: number } {
  const calls = Number(row.calls);
  const errors = Number(row.errors);

  return {
    calls,
    errors,
    errorRate: calls === 0 ? 0 : errors / calls,
    durationMs: { p50: row.p50, p95: row.p95 },
    refused: Number(row.refused),
  };
}

/** One version's calls in its period: the WHERE clause and its parameters. */
function scope(params: unknown[], serverId: string, window: Window, clientType: string | undefined): string {
  params.push(serverId, window.range.from, window.range.to, window.version);
  const at = params.length;
  let clause = `server_id = $${at - 3} AND occurred_at >= $${at - 2} AND occurred_at < $${at - 1}
       AND server_version = $${at} AND error_source IS DISTINCT FROM '${UNKNOWN_TOOL}'`;

  if (clientType !== undefined) {
    params.push(clientType);
    clause += ` AND client_type = $${params.length}`;
  }

  return clause;
}

async function side(serverId: string, window: Window, clientType: string | undefined): Promise<ReleaseSide> {
  const params: unknown[] = [];
  const result = await getPool().query<SideRow>(
    `SELECT ${SIDE_COLUMNS} FROM tool_calls WHERE ${scope(params, serverId, window, clientType)}`,
    params,
  );
  const { refused: _, ...overall } = toSide(result.rows[0]!);

  return overall;
}

/** Each tool on either side, matched by name. */
async function toolSides(
  serverId: string,
  before: Window,
  after: Window,
  clientType: string | undefined,
): Promise<Omit<ReleaseTool, 'verdict' | 'definitionChanged'>[]> {
  const params: unknown[] = [];
  const beforeScope = scope(params, serverId, before, clientType);
  const afterScope = scope(params, serverId, after, clientType);
  const result = await getPool().query<{ tool_name: string; side: 'before' | 'after' } & SideRow>(
    `SELECT tool_name, 'before' AS side, ${SIDE_COLUMNS} FROM tool_calls WHERE ${beforeScope} GROUP BY tool_name
     UNION ALL
     SELECT tool_name, 'after' AS side, ${SIDE_COLUMNS} FROM tool_calls WHERE ${afterScope} GROUP BY tool_name`,
    params,
  );

  const byTool = new Map<string, Omit<ReleaseTool, 'verdict' | 'definitionChanged'>>();
  for (const row of result.rows) {
    const tool = byTool.get(row.tool_name) ?? { toolName: row.tool_name, before: null, after: null };
    tool[row.side] = toSide(row);
    byTool.set(row.tool_name, tool);
  }

  return [...byTool.values()];
}

/** Failures by tool and kind that the new version had and the previous one did not, the most frequent first. */
async function failuresNew(
  serverId: string,
  before: Window,
  after: Window,
  clientType: string | undefined,
): Promise<NewFailure[]> {
  const params: unknown[] = [];
  const beforeScope = scope(params, serverId, before, clientType);
  const afterScope = scope(params, serverId, after, clientType);
  params.push(MAX_NEW_FAILURES);
  const result = await getPool().query<{
    tool_name: string;
    error_source: string | null;
    error_type: string | null;
    calls: string;
    first_at: Date;
  }>(
    `SELECT tool_name, error_source, error_type, count(*) AS calls, min(occurred_at) AS first_at
     FROM tool_calls AS now
     WHERE ${afterScope} AND NOT success
       AND NOT EXISTS (
         SELECT 1 FROM tool_calls
         WHERE ${beforeScope} AND NOT success
           AND tool_name = now.tool_name
           AND error_source IS NOT DISTINCT FROM now.error_source
           AND error_type IS NOT DISTINCT FROM now.error_type
       )
     GROUP BY tool_name, error_source, error_type
     ORDER BY calls DESC, tool_name
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    toolName: row.tool_name,
    errorSource: row.error_source,
    errorType: row.error_type,
    calls: Number(row.calls),
    firstAt: row.first_at.toISOString(),
  }));
}

/** Tools given a definition with this version that replaced one they had before it. */
async function changedDefinitions(serverId: string, releasedAt: Date, until: Date): Promise<Set<string>> {
  const result = await getPool().query<{ tool_name: string }>(
    `SELECT DISTINCT fresh.tool_name
     FROM tool_definitions AS fresh
     WHERE fresh.server_id = $1
       AND fresh.first_seen_at >= $2 AND fresh.first_seen_at < $3
       AND EXISTS (
         SELECT 1 FROM tool_definitions AS old
         WHERE old.server_id = $1 AND old.tool_name = fresh.tool_name AND old.first_seen_at < $2
       )`,
    [serverId, new Date(releasedAt.getTime() - DEFINITION_LEAD_MS), until],
  );

  return new Set(result.rows.map((row) => row.tool_name));
}

/** Each client's share of tool calls in each period, from every version, the largest now first. */
async function clientShares(
  serverId: string,
  before: TimeRange | undefined,
  after: TimeRange,
): Promise<ReleaseReport['clients']> {
  const result = await getPool().query<{ client_type: string; before: string; after: string }>(
    `SELECT client_type,
            count(*) FILTER (WHERE occurred_at < $3) AS before,
            count(*) FILTER (WHERE occurred_at >= $3) AS after
     FROM tool_calls
     WHERE server_id = $1 AND occurred_at >= $2 AND occurred_at < $4
       AND error_source IS DISTINCT FROM '${UNKNOWN_TOOL}'
     GROUP BY client_type`,
    [serverId, before?.from ?? after.from, after.from, after.to],
  );

  const totals = result.rows.reduce(
    (sum, row) => ({ before: sum.before + Number(row.before), after: sum.after + Number(row.after) }),
    { before: 0, after: 0 },
  );

  return result.rows
    .map((row) => ({
      clientType: row.client_type,
      before: totals.before === 0 ? 0 : Number(row.before) / totals.before,
      after: totals.after === 0 ? 0 : Number(row.after) / totals.after,
    }))
    .sort((a, b) => b.after - a.after || b.before - a.before || a.clientType.localeCompare(b.clientType));
}

async function otherVersionCalls(serverId: string, after: Window, clientType: string | undefined): Promise<number> {
  const params: unknown[] = [serverId, after.range.from, after.range.to, after.version];
  let clause = '';
  if (clientType !== undefined) {
    params.push(clientType);
    clause = `AND client_type = $${params.length}`;
  }
  const result = await getPool().query<{ calls: string }>(
    `SELECT count(*) AS calls FROM tool_calls
     WHERE server_id = $1 AND occurred_at >= $2 AND occurred_at < $3
       AND server_version IS DISTINCT FROM $4 ${clause}`,
    params,
  );

  return Number(result.rows[0]?.calls ?? 0);
}

async function outcomes(serverId: string, range: TimeRange, clientType: string | undefined): Promise<SessionOutcomes> {
  const lost = await getLostAgents(serverId, range, undefined, { offset: 0, limit: 1 }, { clientType });

  return lost.sessions;
}
