import type { TimeRange } from './time-range.ts';

/**
 * Most points a chart gets.
 *
 * Chosen for reading rather than for resolution. Past this a line chart turns
 * into a smear, and the bucket widths that land under it are the ones people
 * already think in: a day of traffic comes out hourly, a week in six hour
 * steps, a month in days.
 */
const MAX_POINTS = 60;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Widths worth showing an axis in, smallest first. */
const LADDER = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 6 * HOUR, DAY, 7 * DAY] as const;

/**
 * Used for windows longer than anything on the ladder suits.
 *
 * Past a year or so the point count creeps above the target. Widening further
 * would mean buckets measured in seasons, which answers nothing, so the count
 * is allowed to drift instead.
 */
const WIDEST = 30 * DAY;

/**
 * Picks how wide a bucket should be for a given window.
 *
 * Derived rather than asked for. A caller choosing badly gets a chart with one
 * point or with a thousand, and neither is a thing anyone wanted; the window
 * they asked about already says everything needed to choose well.
 */
export function chooseBucketSeconds(range: TimeRange): number {
  const windowSeconds = (range.to.getTime() - range.from.getTime()) / 1000;

  return LADDER.find((width) => windowSeconds / width <= MAX_POINTS) ?? WIDEST;
}
