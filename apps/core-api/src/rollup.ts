import { filterClause, type Filters, UNKNOWN_PROMPT, UNKNOWN_RESOURCE, UNKNOWN_TOOL } from './filters.ts';
import type { TimeRange } from './time-range.ts';

/**
 * Latency thresholds the hourly rollup counts against, ascending.
 *
 * Must match the columns in the rollup view exactly. A test asserts that it
 * does, because the two live in different files and a threshold added to one
 * and not the other would not fail anywhere else: percentiles would simply
 * start being wrong, quietly, for older data only.
 *
 * Roughly half again between steps, all the way up. An estimate cannot be out
 * by more than the width of the step it lands in, so a constant ratio means a
 * constant relative error rather than one that collapses at the fast end and
 * blows out at the slow end. A coarser ladder was tried first and reported a
 * median of 40 ms as 25 ms, which is within its bound and still wrong enough
 * for somebody to notice.
 */
export const LATENCY_THRESHOLDS = [
  1, 2, 3, 5, 8, 12, 20, 30, 45, 65, 100, 150, 250, 400, 600, 1000, 1500, 2500, 4000, 6000, 10_000,
] as const;

/**
 * Where each kind of call is kept. Tools have the original table; resource
 * reads and prompt gets have tables of their own, shaped the same way, so that
 * the tool table's rollup and its history were left untouched when they came
 * (see the migration that made them). Every query below reads one of these.
 */
export const CALL_TABLES = {
  tool: { raw: 'tool_calls', rollup: 'tool_calls_hourly', name: 'tool_name', unknown: UNKNOWN_TOOL },
  resource: { raw: 'resource_calls', rollup: 'resource_calls_hourly', name: 'name', unknown: UNKNOWN_RESOURCE },
  prompt: { raw: 'prompt_calls', rollup: 'prompt_calls_hourly', name: 'name', unknown: UNKNOWN_PROMPT },
} as const;

export type CallKind = keyof typeof CALL_TABLES;

/** Column name the rollup uses for a threshold. */
export function thresholdColumn(threshold: number): string {
  return `d_le_${threshold}`;
}

/**
 * The rollup's histogram columns, as they appear when reading the view.
 *
 * Generated rather than written out, so the list cannot drift from the
 * thresholds it is supposed to describe.
 */
function histogramColumns(prefix = ''): string {
  return LATENCY_THRESHOLDS.map((t) => `${prefix}${thresholdColumn(t)}`).join(', ');
}

/** The same histogram, summed, for aggregating rollup rows further. */
export function histogramSums(): string {
  return LATENCY_THRESHOLDS.map(
    (t) => `coalesce(sum(${thresholdColumn(t)}), 0) AS ${thresholdColumn(t)}`,
  ).join(',\n       ');
}

/** The same histogram computed from raw rows, for the partial hours at a window's edges. */
function histogramFromRaw(): string {
  return LATENCY_THRESHOLDS.map(
    (t) => `count(*) FILTER (WHERE duration_ms <= ${t}) AS ${thresholdColumn(t)}`,
  ).join(',\n       ');
}

/** Cumulative counts, one per threshold, in the same order. */
export type Histogram = readonly number[];

export function readHistogram(row: Record<string, unknown>): Histogram {
  return LATENCY_THRESHOLDS.map((t) => Number(row[thresholdColumn(t)] ?? 0));
}

/** Adds two histograms, for combining a rollup's middle with a window's raw edges. */
export function addHistograms(a: Histogram, b: Histogram): Histogram {
  return a.map((value, index) => value + (b[index] ?? 0));
}

/**
 * Reads a percentile out of cumulative bucket counts.
 *
 * The counts are cumulative, so the bucket a rank falls in is the first one
 * whose count reaches it. Inside that bucket the position is interpolated
 * linearly between its lower and upper threshold, which assumes calls are
 * spread evenly across it. They are not, but the error is bounded: the answer
 * is always inside the step holding the call at that rank, so it is within one
 * step of the real measurement.
 *
 * Against `percentile_cont` the two can differ by more than that, and the
 * reason is worth knowing. That function interpolates between the two
 * measurements either side of the rank, so on a sharply split distribution -
 * nine hundred calls at 20 ms and fifty at 3 s - it reports something near
 * 170 ms, a duration no call ever took. This returns a value in the step where
 * the real measurement sits. The tests below pin both behaviours down, because
 * the difference shows up on a dashboard and somebody will ask about it.
 *
 * Above the last threshold there is no upper bound to interpolate towards, so
 * the last threshold is returned and the answer is a floor. A dashboard saying
 * "at least 10 seconds" for a p95 is not misleading; anybody seeing it has a
 * problem that a more precise number would not change.
 *
 * Returns null for an empty window, which is different from zero.
 */
export function estimatePercentile(
  histogram: Histogram,
  total: number,
  quantile: number,
): number | null {
  if (total <= 0) return null;

  // Nearest-rank, one-based, matching how percentile_cont picks its position.
  const rank = quantile * (total - 1);

  let lowerThreshold = 0;
  let lowerCount = 0;

  for (const [index, threshold] of LATENCY_THRESHOLDS.entries()) {
    const count = histogram[index] ?? 0;

    if (count > rank) {
      const withinBucket = count - lowerCount;

      // Everything in this bucket sits at one value as far as we can tell,
      // which happens when a single call lands here.
      if (withinBucket <= 0) return threshold;

      const position = (rank - lowerCount) / withinBucket;
      return lowerThreshold + (threshold - lowerThreshold) * position;
    }

    lowerThreshold = threshold;
    lowerCount = count;
  }

  // Past the last threshold: a floor rather than a guess.
  return LATENCY_THRESHOLDS[LATENCY_THRESHOLDS.length - 1] ?? null;
}

/** The rollup's bucket width. Anything narrower has to come from raw rows. */
const ROLLUP_BUCKET_SECONDS = 60 * 60;

/**
 * How a window is split between the rollup and the raw table.
 *
 * The rollup holds whole hours. A window almost never starts or ends on one,
 * because it is usually "the last day" counted back from this instant, so
 * asking the rollup for the window as given would silently drop a partial hour
 * at each end. A summary that ignores the call somebody made a minute ago is
 * worse than a slow one: it reads as the product being broken.
 *
 * So the middle comes from the rollup and the two partial hours come from raw
 * rows. Both edges are at most an hour of data and sit at the ends of the
 * range, where the index makes them cheap.
 *
 * `useRollup` is false when there is no whole hour to read, which is any window
 * shorter than about two hours. Those are small enough to answer from raw rows
 * without the detour.
 */
export interface RollupWindow {
  useRollup: boolean;
  /** First whole hour covered by the rollup, inclusive. */
  rollupFrom: Date;
  /** End of the last whole hour, exclusive. */
  rollupTo: Date;
  /** The partial hours left over, to read from raw rows. Empty when there are none. */
  edges: TimeRange[];
}

export function splitWindow(range: TimeRange): RollupWindow {
  const rollupFrom = ceilToHour(range.from);
  const rollupTo = floorToHour(range.to);

  if (rollupTo.getTime() <= rollupFrom.getTime()) {
    return { useRollup: false, rollupFrom, rollupTo, edges: [range] };
  }

  const edges: TimeRange[] = [];

  if (range.from.getTime() < rollupFrom.getTime()) {
    edges.push({ from: range.from, to: rollupFrom });
  }

  if (rollupTo.getTime() < range.to.getTime()) {
    edges.push({ from: rollupTo, to: range.to });
  }

  return { useRollup: true, rollupFrom, rollupTo, edges };
}

/**
 * The same split, refused when the chart wants steps narrower than an hour.
 *
 * The rollup cannot answer below its own bucket width. A three hour window
 * asks for five minute steps and still contains whole hours, so the plain
 * split would happily offer a rollup that can only produce one point per hour.
 */
export function splitWindowForBucket(range: TimeRange, bucketSeconds: number): RollupWindow {
  const split = splitWindow(range);

  if (bucketSeconds < ROLLUP_BUCKET_SECONDS) {
    return { useRollup: false, rollupFrom: split.rollupFrom, rollupTo: split.rollupTo, edges: [range] };
  }

  return split;
}

const HOUR_MS = 60 * 60 * 1000;

function floorToHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

function ceilToHour(at: Date): Date {
  return new Date(Math.ceil(at.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * One SQL source covering a window, whichever side of the split each part
 * comes from.
 *
 * Every caller wants the same thing: rows carrying an hour, the dimensions,
 * a count, a duration sum and a histogram. The rollup already stores exactly
 * that; the raw table can be made to produce it. Putting the union here means
 * the four dashboard queries aggregate over one shape and none of them has to
 * know a rollup exists.
 *
 * The raw side buckets to the hour as well, so an outer query can widen both
 * sides together. An hour never straddles a wider bucket's boundary, so the
 * two always land in the same place.
 */
export function unifiedCallSource(
  params: unknown[],
  serverId: string,
  split: RollupWindow,
  filters: Filters,
  /**
   * How wide to bucket the raw side. Only matters when the rollup is not in
   * play: then these rows are the whole answer and have to arrive at the width
   * the caller asked for. Alongside the rollup they stay hourly, because the
   * rollup's own rows are, and an outer query widens both together.
   */
  rawBucketSeconds: number = ROLLUP_BUCKET_SECONDS,
  /** Which kind of call; the rows come back with the name as tool_name whatever the kind. */
  kind: CallKind = 'tool',
): string {
  const rawBucket = split.useRollup ? ROLLUP_BUCKET_SECONDS : rawBucketSeconds;
  const parts: string[] = [];
  const table = CALL_TABLES[kind];
  const clause = { includeErrorSource: true, nameColumn: table.name, unknownSource: table.unknown };

  if (split.useRollup) {
    const rollupParams: unknown[] = [serverId, split.rollupFrom, split.rollupTo];
    const offset = params.length;
    params.push(...rollupParams);
    const where = filterClause(filters, params, clause);

    parts.push(`
      SELECT bucket, ${table.name} AS tool_name, client_type, success, error_source,
             calls, duration_sum, ${histogramColumns()}
      FROM ${table.rollup}
      WHERE server_id = $${offset + 1}
        AND bucket >= $${offset + 2}
        AND bucket < $${offset + 3}
        ${where}`);
  }

  for (const edge of split.edges) {
    const offset = params.length;
    params.push(serverId, edge.from, edge.to);
    const where = filterClause(filters, params, clause);

    parts.push(`
      SELECT time_bucket(make_interval(secs => ${rawBucket}), occurred_at) AS bucket,
             ${table.name} AS tool_name, client_type, success, error_source,
             count(*) AS calls, sum(duration_ms) AS duration_sum,
             ${histogramFromRaw()}
      FROM ${table.raw}
      WHERE server_id = $${offset + 1}
        AND occurred_at >= $${offset + 2}
        AND occurred_at < $${offset + 3}
        ${where}
      GROUP BY bucket, ${table.name}, client_type, success, error_source`);
  }

  // Aliased `unified` and not `calls`: the union has a column of that name,
  // and PostgreSQL resolving `calls` to the table rather than the column is
  // not the kind of mistake that announces itself.
  return `(${parts.join('\n      UNION ALL\n')}) AS unified`;
}
