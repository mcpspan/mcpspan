import { type CallRecord, listCalls } from './calls.ts';
import { closestName } from './closest.ts';
import { getPool } from './db.ts';
import { type Filters, UNKNOWN_TOOL } from './filters.ts';
import { type Cursor, type Page, takePage } from './paging.ts';
import {
  CALL_TABLES,
  type CallKind,
  estimatePercentile,
  type Histogram,
  histogramSums,
  LATENCY_THRESHOLDS,
  readHistogram,
  splitWindow,
  splitWindowForBucket,
  unifiedCallSource,
} from './rollup.ts';
import type { TimeRange } from './time-range.ts';

/**
 * Most clients reported in a summary.
 *
 * Enough to answer "who calls this" without turning a summary into a list.
 * The full breakdown, if anybody wants one, is a view of its own.
 */
const MAX_SUMMARY_CLIENTS = 5;

interface ClientShare {
  clientType: string;
  calls: number;
}

export interface Summary {
  totalCalls: number;
  failedCalls: number;
  /** Failed over total, between 0 and 1. Zero when nothing was called. */
  errorRate: number;
  durationMs: {
    mean: number | null;
    p50: number | null;
    p95: number | null;
  };
  uniqueTools: number;

  /**
   * Where the calls came from, busiest first.
   *
   * One of the few things a developer cannot find out any other way. Their own
   * logs show that a tool ran; only this says whether it was Claude, Cursor,
   * or something nobody has heard of yet.
   */
  clients: ClientShare[];
}

interface SummaryRow extends Record<string, unknown> {
  total_calls: string;
  failed_calls: string;
  duration_sum: string | null;
  unique_tools: string;
}

/**
 * The headline numbers for one server over one window.
 *
 * Latency is reported three ways on purpose. A mean is the number people ask
 * for and the one that misleads them: a handful of slow calls drag it
 * somewhere no individual call ever was, so a server can look twice as slow as
 * anything a user experienced. The median says what a typical call cost, and
 * the ninety-fifth percentile says what the unlucky twentieth felt, which is
 * usually the one worth fixing.
 *
 * Percentiles are read from the rollup's latency histogram rather than sorted
 * out of the raw rows. That was the earlier approach and it was right while
 * the table was small; at a year of traffic it means sorting hundreds of
 * millions of rows to draw one card. The estimate is within the width of the
 * histogram bucket the answer lands in, which a test pins down, and the ladder
 * is narrow where tool calls actually are.
 */
export async function getSummary(
  serverId: string,
  range: TimeRange,
  filters: Filters = {},
): Promise<Summary> {
  const params: unknown[] = [];
  const source = unifiedCallSource(params, serverId, splitWindow(range), filters);

  const result = await getPool().query<SummaryRow>(
    `SELECT
       coalesce(sum(calls), 0) AS total_calls,
       coalesce(sum(calls) FILTER (WHERE NOT success), 0) AS failed_calls,
       sum(duration_sum) AS duration_sum,
       count(DISTINCT tool_name) AS unique_tools,
       ${histogramSums()}
     FROM ${source}`,
    params,
  );

  const row = result.rows[0];
  const totalCalls = Number(row?.total_calls ?? 0);
  const failedCalls = Number(row?.failed_calls ?? 0);
  const histogram: Histogram = row === undefined ? [] : readHistogram(row);

  return {
    totalCalls,
    failedCalls,
    errorRate: errorRate(failedCalls, totalCalls),
    durationMs: {
      mean: totalCalls > 0 ? Number(row?.duration_sum ?? 0) / totalCalls : null,
      p50: estimatePercentile(histogram, totalCalls, 0.5),
      p95: estimatePercentile(histogram, totalCalls, 0.95),
    },
    uniqueTools: Number(row?.unique_tools ?? 0),
    clients: await getClientShares(serverId, range, filters),
  };
}

/**
 * Which clients called, busiest first.
 *
 * A separate query rather than another column on the summary: one row per
 * client does not fit alongside one row of totals, and grouping twice in one
 * statement would cost more to read than the second trip costs to make.
 *
 * Ties break by name, so a list of equals does not reorder between refreshes.
 */
async function getClientShares(
  serverId: string,
  range: TimeRange,
  filters: Filters,
): Promise<ClientShare[]> {
  const params: unknown[] = [];
  const source = unifiedCallSource(params, serverId, splitWindow(range), filters);
  params.push(MAX_SUMMARY_CLIENTS);

  const result = await getPool().query<{ client_type: string; calls: string }>(
    `SELECT client_type, coalesce(sum(calls), 0) AS calls
     FROM ${source}
     GROUP BY client_type
     ORDER BY calls DESC, client_type ASC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({ clientType: row.client_type, calls: Number(row.calls) }));
}

export interface TimeseriesPoint {
  /** Start of the bucket, as an ISO 8601 timestamp. */
  time: string;
  calls: number;
  errors: number;
}

interface TimeseriesRow {
  bucket: Date;
  calls: string;
  errors: string;
}

/**
 * Calls and failures over a window, in even steps.
 *
 * Buckets with nothing in them are returned as zeroes rather than left out.
 * Without that a chart draws a straight line from the last call before a quiet
 * night to the first one after it, and a server that did nothing for eight
 * hours looks exactly like one that was busy throughout.
 */
export async function getTimeseries(
  serverId: string,
  range: TimeRange,
  bucketSeconds: number,
  filters: Filters = {},
): Promise<TimeseriesPoint[]> {
  const params: unknown[] = [];
  const split = splitWindowForBucket(range, bucketSeconds);
  const source = unifiedCallSource(params, serverId, split, filters, bucketSeconds);
  params.push(bucketSeconds);

  const result = await getPool().query<TimeseriesRow>(
    `SELECT
       time_bucket(make_interval(secs => $${params.length}::double precision), bucket) AS bucket,
       coalesce(sum(calls), 0) AS calls,
       coalesce(sum(calls) FILTER (WHERE NOT success), 0) AS errors
     FROM ${source}
     GROUP BY 1
     ORDER BY 1`,
    params,
  );

  return fillGaps(result.rows, range, bucketSeconds);
}

/**
 * Puts the empty buckets back, which the database no longer does for us.
 *
 * This used to be `time_bucket_gapfill`. That function is not in every
 * TimescaleDB build, and it cannot be applied over the union of the rollup and
 * the raw edges, which is where the numbers now come from. Doing it here costs
 * a loop over at most sixty points and removes a dependency on which variant of
 * the database somebody installed.
 *
 * It still has to happen. Without it a chart draws a straight line from the
 * last call before a quiet night to the first one after it, and a server that
 * did nothing for eight hours looks exactly like one that was busy throughout.
 */
function fillGaps(
  rows: readonly TimeseriesRow[],
  range: TimeRange,
  bucketSeconds: number,
): TimeseriesPoint[] {
  const width = bucketSeconds * 1000;
  const found = new Map<number, TimeseriesRow>();

  for (const row of rows) found.set(row.bucket.getTime(), row);

  // Buckets are aligned to the epoch, the same way time_bucket aligns them, so
  // a point keeps the same position whatever window it is asked about.
  const first = Math.floor(range.from.getTime() / width) * width;
  const points: TimeseriesPoint[] = [];

  for (let at = first; at < range.to.getTime(); at += width) {
    const row = found.get(at);

    points.push({
      time: new Date(at).toISOString(),
      calls: Number(row?.calls ?? 0),
      errors: Number(row?.errors ?? 0),
    });
  }

  return points;
}

/**
 * Most tools one ranking returns.
 *
 * Far above what any real server registers, and there so that a response stays
 * a response rather than becoming a download.
 */
const MAX_RANKED_TOOLS = 200;

export interface ToolStats {
  toolName: string;
  calls: number;
  errors: number;
  errorRate: number;
  durationMs: {
    mean: number | null;
    p50: number | null;
    p95: number | null;
  };
}

interface ToolRow extends Record<string, unknown> {
  tool_name: string;
  calls: string;
  errors: string;
  duration_sum: string | null;
}

/**
 * Tools ranked by how often they were called.
 *
 * Each one carries its own error rate and timings, because a server's overall
 * numbers hide the thing worth acting on: a server at two percent errors and
 * forty milliseconds looks healthy right up until you notice that one tool in
 * nine accounts for all of it.
 *
 * Ties are broken by name. Without that PostgreSQL is free to order equal
 * counts however it likes, and a table would shuffle itself between refreshes
 * for no reason a reader could see.
 */
/**
 * How a tool ranking may be ordered.
 *
 * Ordering happens here rather than in SQL because two of the three numbers
 * being ordered by no longer exist in the database: the median comes out of a
 * histogram, and the error rate out of two sums. A ranking of at most a few
 * hundred tools is nothing to sort in memory, and keeping it here means one
 * definition of each ordering instead of one in SQL and another in a test.
 *
 * Ties break by name in every case. Without that, equal values come back in
 * whatever order the database felt like, and a table reshuffles itself between
 * refreshes for no reason a reader can see.
 */
const TOOL_SORTS = {
  calls: (a: ToolStats, b: ToolStats) => b.calls - a.calls,
  // Rate rather than count: one failure in two matters more than ten in a
  // thousand, and ordering by the raw number would bury it under the busiest
  // tool on the server.
  errors: (a: ToolStats, b: ToolStats) => b.errorRate - a.errorRate,
  duration: (a: ToolStats, b: ToolStats) => (b.durationMs.p50 ?? 0) - (a.durationMs.p50 ?? 0),
  name: () => 0,
} as const;

export type ToolSort = keyof typeof TOOL_SORTS;

export function isToolSort(value: string): value is ToolSort {
  return value in TOOL_SORTS;
}

export async function getToolStats(
  serverId: string,
  range: TimeRange,
  filters: Filters = {},
  sort: ToolSort = 'calls',
  /** Resources and prompts are ranked the same way, from tables of their own. */
  kind: CallKind = 'tool',
): Promise<ToolStats[]> {
  const params: unknown[] = [];
  const source = unifiedCallSource(params, serverId, splitWindow(range), filters, undefined, kind);

  const result = await getPool().query<ToolRow>(
    `SELECT
       tool_name,
       coalesce(sum(calls), 0) AS calls,
       coalesce(sum(calls) FILTER (WHERE NOT success), 0) AS errors,
       sum(duration_sum) AS duration_sum,
       ${histogramSums()}
     FROM ${source}
     GROUP BY tool_name`,
    params,
  );

  const tools = result.rows.map((row) => {
    const calls = Number(row.calls);
    const errors = Number(row.errors);
    const histogram = readHistogram(row);

    return {
      toolName: row.tool_name,
      calls,
      errors,
      errorRate: errorRate(errors, calls),
      durationMs: {
        mean: calls > 0 ? Number(row.duration_sum ?? 0) / calls : null,
        p50: estimatePercentile(histogram, calls, 0.5),
        p95: estimatePercentile(histogram, calls, 0.95),
      },
    };
  });

  return tools
    .sort((a, b) => TOOL_SORTS[sort](a, b) || a.toolName.localeCompare(b.toolName))
    .slice(0, MAX_RANKED_TOOLS);
}

/** How many failures come back when the caller does not say. */
export const DEFAULT_ERROR_LIMIT = 50;

/** How many can be asked for at most. */
export const MAX_ERROR_LIMIT = 200;

/** A failed call, as the failure list shows it: the same record as any call's. */
export type FailedCall = CallRecord;

/**
 * The most recent failures, newest first, of every kind.
 *
 * Individual calls rather than counts, because this is the view somebody opens
 * when a number elsewhere has already told them something is wrong and they
 * want to know what it said.
 */
export async function getRecentFailures(
  serverId: string,
  range: TimeRange,
  limit: number,
  filters: Filters = {},
  /** Where the previous page ended; the next page starts just older than it. */
  before?: Cursor,
): Promise<{ failures: FailedCall[]; nextCursor: string | null }> {
  const { calls, nextCursor } = await listCalls(
    serverId,
    range,
    Math.min(limit, MAX_ERROR_LIMIT),
    filters,
    before,
    { outcome: 'failed' },
  );

  return { failures: calls, nextCursor };
}

/**
 * Failures over attempts, in one place.
 *
 * Both the summary and the per-tool table report this, and two copies of a
 * division are two chances to disagree about what an empty window means. A
 * quiet server has an error rate of zero, not of nothing.
 */
function errorRate(errors: number, calls: number): number {
  return calls === 0 ? 0 : errors / calls;
}

export interface FilterOptions {
  tools: string[];
  clients: string[];
}

/**
 * What can be filtered on, for the window as a whole.
 *
 * Deliberately ignores the filters in force. A list of choices that narrowed
 * itself to the choice already made would be a one-way door: pick a tool, and
 * the only tool left to pick is that one.
 */
export async function getFilterOptions(
  serverId: string,
  range: TimeRange,
): Promise<FilterOptions> {
  const result = await getPool().query<{ tool_name: string; client_type: string }>(
    `SELECT DISTINCT tool_name, client_type
     FROM tool_calls
     WHERE server_id = $1
       AND occurred_at >= $2
       AND occurred_at < $3
       AND error_source IS DISTINCT FROM $4`,
    [serverId, range.from, range.to, UNKNOWN_TOOL],
  );

  return {
    tools: [...new Set(result.rows.map((row) => row.tool_name))].sort(),
    clients: [...new Set(result.rows.map((row) => row.client_type))].sort(),
  };
}

export interface UnknownTool {
  toolName: string;
  calls: number;
  lastCalledAt: string;
  /**
   * The server's own name this most likely meant, when one is close: a typo,
   * words in another order, a rename. Never for a resource, which is recorded
   * by its scheme alone and so has nothing to compare.
   */
  closest: string | null;
  /**
   * Who asked, most first. A name only one client keeps reaching for is a
   * different signal from one every client wants: that client's habit, or
   * something the server is missing.
   */
  clients: { clientType: string; calls: number }[];
}

/** How far back a name counts as one the server has, for suggesting it. */
const KNOWN_NAMES_DAYS = 30;

/** Names on one page. A client inventing names in a loop should not become one long page. */
export const MAX_UNKNOWN_TOOLS = 50;

/**
 * Tool names agents called that the server does not have, most asked for first.
 *
 * Usually a tool renamed or removed while a client still held the old list,
 * sometimes a model reaching for something it expected to exist. Either way
 * it says what somebody wanted from the server and could not get.
 *
 * Read from the raw rows, which the failures index covers. These are rare by
 * nature, and within the retention window is as far back as they are useful.
 */
export async function getUnknownTools(
  serverId: string,
  range: TimeRange,
  page: Page = { offset: 0, limit: MAX_UNKNOWN_TOOLS },
  /**
   * Resources and prompts asked for and not found, likewise. A resource is
   * named by the scheme of the address asked for, which is all the SDKs
   * record of it: the rest came from the client, and may be data.
   */
  kind: CallKind = 'tool',
): Promise<{ tools: UnknownTool[]; hasMore: boolean }> {
  const table = CALL_TABLES[kind];
  const result = await getPool().query<{ tool_name: string; calls: string; last_at: Date }>(
    `SELECT ${table.name} AS tool_name, count(*) AS calls, max(occurred_at) AS last_at
     FROM ${table.raw}
     WHERE server_id = $1
       AND occurred_at >= $2
       AND occurred_at < $3
       AND NOT success
       AND error_source = $4
     GROUP BY ${table.name}
     ORDER BY calls DESC, tool_name ASC
     LIMIT $5 OFFSET $6`,
    [serverId, range.from, range.to, table.unknown, page.limit + 1, page.offset],
  );

  const { items, hasMore } = takePage(result.rows, page);
  const names = items.map((row) => row.tool_name);
  const [known, clients] = await Promise.all([
    names.length === 0 || kind === 'resource' ? [] : knownNames(serverId, kind),
    names.length === 0 ? new Map<string, UnknownTool['clients']>() : askedBy(serverId, range, kind, names),
  ]);

  return {
    tools: items.map((row) => ({
      toolName: row.tool_name,
      calls: Number(row.calls),
      lastCalledAt: row.last_at.toISOString(),
      closest: closestName(row.tool_name, known),
      clients: clients.get(row.tool_name) ?? [],
    })),
    hasMore,
  };
}

/** Which clients asked for each of these missing names, most first. */
async function askedBy(
  serverId: string,
  range: TimeRange,
  kind: CallKind,
  names: string[],
): Promise<Map<string, UnknownTool['clients']>> {
  const table = CALL_TABLES[kind];
  const result = await getPool().query<{ name: string; client_type: string; calls: string }>(
    `SELECT ${table.name} AS name, client_type, count(*) AS calls
     FROM ${table.raw}
     WHERE server_id = $1
       AND occurred_at >= $2
       AND occurred_at < $3
       AND NOT success
       AND error_source = $4
       AND ${table.name} = ANY($5)
     GROUP BY ${table.name}, client_type
     ORDER BY calls DESC, client_type ASC`,
    [serverId, range.from, range.to, table.unknown, names],
  );

  const byName = new Map<string, UnknownTool['clients']>();
  for (const row of result.rows) {
    const list = byName.get(row.name) ?? [];
    list.push({ clientType: row.client_type, calls: Number(row.calls) });
    byName.set(row.name, list);
  }

  return byName;
}

/**
 * The names the server has: those called lately other than as a missing one.
 *
 * The SDKs send no list of what a server registers, so this is what calls
 * show. From the rollup for the last month, and from the raw rows for the
 * last two hours, which the rollup may not have reached yet: a tool renamed a
 * moment ago is the likeliest match for the old name still being asked for.
 */
async function knownNames(serverId: string, kind: CallKind): Promise<string[]> {
  const table = CALL_TABLES[kind];
  const result = await getPool().query<{ name: string }>(
    `SELECT ${table.name} AS name FROM ${table.rollup}
     WHERE server_id = $1
       AND bucket >= now() - make_interval(days => $3)
       AND error_source IS DISTINCT FROM $2
     UNION
     SELECT ${table.name} FROM ${table.raw}
     WHERE server_id = $1
       AND occurred_at >= now() - interval '2 hours'
       AND error_source IS DISTINCT FROM $2
     LIMIT 1000`,
    [serverId, table.unknown, KNOWN_NAMES_DAYS],
  );

  return result.rows.map((row) => row.name);
}

export interface LatencyBucket {
  /** Exclusive lower bound, in milliseconds. Zero for the first bucket. */
  fromMs: number;
  /** Inclusive upper bound, or null for everything past the last threshold. */
  toMs: number | null;
  calls: number;
}

/**
 * How call durations are spread, bucket by bucket.
 *
 * A median and a p95 hide a distribution with two humps. A tool that answers
 * seventy percent of calls from a cache and sends thirty to the network has a
 * median somewhere in between that no call ever took, and looks like one
 * middling tool when it is two different ones.
 *
 * Read from the same latency histogram the percentiles come from, so the two
 * cannot disagree. Its steps are about half again wider each time, which is
 * what makes the counts per step a fair picture on a logarithmic axis: a hump
 * at 15 ms and one at 400 ms come out the same shape.
 */
export async function getLatencyDistribution(
  serverId: string,
  range: TimeRange,
  filters: Filters = {},
): Promise<{ totalCalls: number; buckets: LatencyBucket[] }> {
  const params: unknown[] = [];
  const source = unifiedCallSource(params, serverId, splitWindow(range), filters);

  const result = await getPool().query<Record<string, unknown> & { total_calls: string }>(
    `SELECT coalesce(sum(calls), 0) AS total_calls, ${histogramSums()}
     FROM ${source}`,
    params,
  );

  const row = result.rows[0];
  const totalCalls = Number(row?.total_calls ?? 0);
  const cumulative = row === undefined ? [] : readHistogram(row);

  const buckets: LatencyBucket[] = [];
  let lower = 0;
  let below = 0;

  for (const [index, threshold] of LATENCY_THRESHOLDS.entries()) {
    const reached = cumulative[index] ?? 0;
    buckets.push({ fromMs: lower, toMs: threshold, calls: reached - below });
    lower = threshold;
    below = reached;
  }

  // Everything slower than the last threshold, which the histogram does not
  // count on its own but the total does.
  buckets.push({ fromMs: lower, toMs: null, calls: Math.max(0, totalCalls - below) });

  return { totalCalls, buckets };
}
