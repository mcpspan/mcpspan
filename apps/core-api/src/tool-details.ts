import { getPool } from './db.ts';
import { type Page, takePage } from './paging.ts';
import { splitWindow, unifiedCallSource } from './rollup.ts';
import type { TimeRange } from './time-range.ts';

/**
 * How many of a tool's newest calls the message and parameter lists read.
 *
 * Both have to look at raw rows, since neither a message nor a set of
 * parameter names survives into the hourly rollup. Reading the newest ones
 * backwards along the (server_id, tool_name, occurred_at) index keeps the cost
 * the same however busy the tool is; responses say when this happened.
 */
const MAX_SCANNED_TOOL_CALLS = 100_000;

/** Distinct messages on one page. */
const MAX_MESSAGES = 10;

/** Distinct parameter names on one page. */
const MAX_PARAMETERS = 50;

interface FailureShare {
  errorSource: string;
  calls: number;
}

interface FailureMessage {
  message: string;
  errorSource: string | null;
  calls: number;
  lastAt: string;
}

interface ParameterUse {
  name: string;
  /** Types it arrived as, commonest first. More than one usually means an agent guessing. */
  types: string[];
  /** Calls that carried it, out of `callsWithParameters`. */
  calls: number;
}

/** How large the tool's answers were (contract, 3.7), over the calls that reported a size. */
interface ResponseSizes {
  /** Calls with a size; SDKs from before 0.2.0 send none. */
  measured: number;
  medianBytes: number;
  p95Bytes: number;
  maxBytes: number;
}

export interface ToolDetails {
  /** Failures by how they happened, from the same source as every other count. */
  failures: FailureShare[];
  messages: FailureMessage[];
  parameters: ParameterUse[];
  /** Calls read for parameters that had any recorded. Zero means capture is off. */
  callsWithParameters: number;
  /** True when the tool had more calls in the window than were read for the lists. */
  sampled: boolean;
  messagesHaveMore: boolean;
  parametersHaveMore: boolean;
  /** Null when no call in the window reported a size. */
  responseSizes: ResponseSizes | null;
}

/**
 * What the per-tool page adds to the figures the overview already has.
 *
 * The headline numbers and the chart are not here: the page asks the summary
 * and timeseries endpoints for them, narrowed to the tool, so they come from
 * the very same queries as the row in the tool table and cannot disagree
 * with it.
 */
export async function getToolDetails(
  serverId: string,
  toolName: string,
  range: TimeRange,
  /** Lowered by tests, which cannot seed a hundred thousand rows each. */
  maxScanned: number = MAX_SCANNED_TOOL_CALLS,
  pages: { messages: Page; parameters: Page } = {
    messages: { offset: 0, limit: MAX_MESSAGES },
    parameters: { offset: 0, limit: MAX_PARAMETERS },
  },
): Promise<ToolDetails> {
  const [failures, messages, parameters, sampled, sizes] = await Promise.all([
    failureShares(serverId, toolName, range),
    failureMessages(serverId, toolName, range, maxScanned, pages.messages),
    parameterUse(serverId, toolName, range, maxScanned, pages.parameters),
    wasSampled(serverId, toolName, range, maxScanned),
    responseSizes(serverId, toolName, range, maxScanned),
  ]);

  return {
    failures,
    messages: messages.items,
    messagesHaveMore: messages.hasMore,
    parameters: parameters.parameters,
    parametersHaveMore: parameters.hasMore,
    callsWithParameters: parameters.callsWithParameters,
    sampled,
    responseSizes: sizes,
  };
}

/**
 * Median, 95th percentile and largest answer, over the newest calls in the
 * window: sizes are kept on raw rows only, like versions, and a percentile
 * over the newest hundred thousand calls is as telling as over all of them.
 */
async function responseSizes(
  serverId: string,
  toolName: string,
  range: TimeRange,
  maxScanned: number,
): Promise<ResponseSizes | null> {
  const result = await getPool().query<{ measured: string; median: number | null; p95: number | null; max: number | null }>(
    `SELECT count(*) AS measured,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY response_bytes) AS median,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY response_bytes) AS p95,
            max(response_bytes) AS max
     FROM (
       SELECT response_bytes
       FROM tool_calls
       WHERE server_id = $1 AND tool_name = $2 AND occurred_at >= $3 AND occurred_at < $4
         AND response_bytes IS NOT NULL
       ORDER BY occurred_at DESC
       LIMIT $5
     ) AS newest`,
    [serverId, toolName, range.from, range.to, maxScanned],
  );

  const row = result.rows[0];
  if (row === undefined || Number(row.measured) === 0 || row.median === null || row.p95 === null || row.max === null) {
    return null;
  }
  return { measured: Number(row.measured), medianBytes: row.median, p95Bytes: row.p95, maxBytes: row.max };
}

/** Failures by source, from the rollup and the raw edges like the rest of the counts. */
async function failureShares(
  serverId: string,
  toolName: string,
  range: TimeRange,
): Promise<FailureShare[]> {
  const params: unknown[] = [];
  const source = unifiedCallSource(params, serverId, splitWindow(range), { toolName });

  const result = await getPool().query<{ error_source: string | null; calls: string }>(
    `SELECT error_source, coalesce(sum(calls), 0) AS calls
     FROM ${source}
     WHERE NOT success
     GROUP BY error_source
     ORDER BY calls DESC, error_source`,
    params,
  );

  return result.rows.map((row) => ({
    // A failure with no source came from an SDK that predates recording one.
    errorSource: row.error_source ?? 'unknown',
    calls: Number(row.calls),
  }));
}

/** The newest calls of one tool in the window, as a subquery. */
function newestCalls(
  params: unknown[],
  serverId: string,
  toolName: string,
  range: TimeRange,
  maxScanned: number,
  failedOnly: boolean,
): string {
  params.push(serverId, toolName, range.from, range.to, maxScanned);
  const at = params.length - 4;

  return `(
    SELECT occurred_at, success, error_source, error_message, parameters
    FROM tool_calls
    WHERE server_id = $${at}
      AND tool_name = $${at + 1}
      AND occurred_at >= $${at + 2}
      AND occurred_at < $${at + 3}
      ${failedOnly ? 'AND NOT success' : ''}
    ORDER BY occurred_at DESC
    LIMIT $${at + 4}
  ) AS newest`;
}

/**
 * The commonest things this tool said when it failed.
 *
 * Grouped by the exact text. Messages that differ only by an identifier they
 * quote will not group, which is a reason to write error messages without
 * them - the model reading them gains nothing from an order number either.
 */
async function failureMessages(
  serverId: string,
  toolName: string,
  range: TimeRange,
  maxScanned: number,
  page: Page,
): Promise<{ items: FailureMessage[]; hasMore: boolean }> {
  const params: unknown[] = [];
  const source = newestCalls(params, serverId, toolName, range, maxScanned, true);
  params.push(page.limit + 1, page.offset);

  const result = await getPool().query<{
    message: string;
    error_source: string | null;
    calls: string;
    last_at: Date;
  }>(
    `SELECT error_message AS message, error_source, count(*) AS calls,
            max(occurred_at) AS last_at
     FROM ${source}
     WHERE error_message IS NOT NULL
     GROUP BY error_message, error_source
     ORDER BY calls DESC, last_at DESC, error_message
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const { items, hasMore } = takePage(result.rows, page);

  return {
    hasMore,
    items: items.map((row) => ({
      message: row.message,
      errorSource: row.error_source,
      calls: Number(row.calls),
      lastAt: row.last_at.toISOString(),
    })),
  };
}

/**
 * Which parameter names agents actually send, and as what.
 *
 * Only names and types are ever stored, and only when the developer turned
 * that on. Set against the schema, this is where a description that is not
 * landing shows up: a name the schema does not have, a required one that is
 * often missing, a number that keeps arriving as a string.
 */
async function parameterUse(
  serverId: string,
  toolName: string,
  range: TimeRange,
  maxScanned: number,
  page: Page,
): Promise<{ parameters: ParameterUse[]; callsWithParameters: number; hasMore: boolean }> {
  const params: unknown[] = [];
  const source = newestCalls(params, serverId, toolName, range, maxScanned, false);
  params.push(page.limit + 1, page.offset);

  const result = await getPool().query<{
    name: string;
    types: string[];
    calls: string;
    with_parameters: string;
  }>(
    `WITH described AS (
       SELECT parameters FROM ${source} WHERE parameters IS NOT NULL
     ),
     pairs AS (
       SELECT entry.key AS name, entry.value AS type, count(*) AS calls
       FROM described, jsonb_each_text(described.parameters) AS entry
       GROUP BY entry.key, entry.value
     )
     SELECT name,
            array_agg(type ORDER BY calls DESC, type) AS types,
            sum(calls) AS calls,
            (SELECT count(*) FROM described) AS with_parameters
     FROM pairs
     GROUP BY name
     ORDER BY sum(calls) DESC, name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const { items, hasMore } = takePage(result.rows, page);

  // Counted separately as well, so a tool whose calls carried an empty set of
  // parameters still reports that capture is on.
  const withParameters =
    result.rows[0] === undefined
      ? await countWithParameters(serverId, toolName, range, maxScanned)
      : Number(result.rows[0].with_parameters);

  return {
    hasMore,
    parameters: items.map((row) => ({
      name: row.name,
      types: row.types,
      calls: Number(row.calls),
    })),
    callsWithParameters: withParameters,
  };
}

async function countWithParameters(
  serverId: string,
  toolName: string,
  range: TimeRange,
  maxScanned: number,
): Promise<number> {
  const params: unknown[] = [];
  const source = newestCalls(params, serverId, toolName, range, maxScanned, false);

  const result = await getPool().query<{ calls: string }>(
    `SELECT count(*) AS calls FROM ${source} WHERE parameters IS NOT NULL`,
    params,
  );

  return Number(result.rows[0]?.calls ?? 0);
}

async function wasSampled(
  serverId: string,
  toolName: string,
  range: TimeRange,
  maxScanned: number,
): Promise<boolean> {
  const result = await getPool().query<{ more: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM tool_calls
       WHERE server_id = $1 AND tool_name = $2 AND occurred_at >= $3 AND occurred_at < $4
       OFFSET $5 LIMIT 1
     ) AS more`,
    [serverId, toolName, range.from, range.to, maxScanned],
  );

  return result.rows[0]?.more === true;
}
