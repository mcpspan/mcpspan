import { describe, expect, it } from 'vitest';

import {
  addHistograms,
  estimatePercentile,
  LATENCY_THRESHOLDS,
  splitWindow,
} from './rollup.ts';

/** Counts each duration into the cumulative buckets, the way the rollup does. */
function histogramOf(durations: readonly number[]): number[] {
  return LATENCY_THRESHOLDS.map((threshold) => durations.filter((d) => d <= threshold).length);
}

/**
 * The measurement at a rank, which is what the histogram approximates.
 *
 * Not `percentile_cont`, which interpolates between the two measurements
 * either side of the rank and so can report a duration nothing took. A test
 * below covers where the two part company.
 */
function measurementAtRank(durations: readonly number[], quantile: number): number {
  const sorted = [...durations].sort((a, b) => a - b);

  return sorted[Math.floor(quantile * (sorted.length - 1))] ?? 0;
}

/** Width of the ladder step a value falls in, which is how far an estimate may be out. */
function bucketWidthAt(value: number): number {
  let lower = 0;

  for (const threshold of LATENCY_THRESHOLDS) {
    if (value <= threshold) return threshold - lower;
    lower = threshold;
  }

  return Infinity;
}

describe('estimatePercentile', () => {
  it('returns null for an empty window rather than zero', () => {
    // Zero would read as "every call was instant", which is a different claim
    // from "nothing was called".
    expect(estimatePercentile(histogramOf([]), 0, 0.5)).toBeNull();
  });

  it('reads a single call back as itself, to within its bucket', () => {
    const estimate = estimatePercentile(histogramOf([42]), 1, 0.5);

    expect(estimate).not.toBeNull();
    expect(Math.abs((estimate ?? 0) - 42)).toBeLessThanOrEqual(bucketWidthAt(42));
  });

  it.each([
    ['uniform across the fast range', Array.from({ length: 1000 }, (_, i) => (i % 500) + 1)],
    ['clustered under 10ms', Array.from({ length: 1000 }, (_, i) => 1 + (i % 9))],
    ['bimodal, cache hit and miss', Array.from({ length: 1000 }, (_, i) => (i % 10 < 7 ? 3 : 400))],
    ['heavy tail', Array.from({ length: 1000 }, (_, i) => (i < 950 ? 20 : 3000))],
  ])('stays within one step of the measurement at that rank: %s', (_label, durations) => {
    const histogram = histogramOf(durations);

    for (const quantile of [0.5, 0.95]) {
      const actual = measurementAtRank(durations, quantile);
      const estimate = estimatePercentile(histogram, durations.length, quantile);

      expect(estimate).not.toBeNull();
      // The bound claimed in rollup.ts, checked rather than asserted in prose.
      expect(Math.abs((estimate ?? 0) - actual)).toBeLessThanOrEqual(bucketWidthAt(actual));
    }
  });

  it('follows the real measurements where percentile_cont invents one', () => {
    // Nine hundred and fifty calls at 20 ms, fifty at 3 s, and nothing
    // between. percentile_cont interpolates across the gap and answers around
    // 170 ms, which no call took and which nobody can act on. This reports a
    // figure from the fast group, where the call at that rank actually is.
    const durations = [
      ...Array.from({ length: 950 }, () => 20),
      ...Array.from({ length: 50 }, () => 3000),
    ];

    const estimate = estimatePercentile(histogramOf(durations), durations.length, 0.95);

    expect(estimate).toBeGreaterThan(12);
    expect(estimate).toBeLessThanOrEqual(20);
  });

  it('reports a floor rather than a guess above the last threshold', () => {
    const slow = Array.from({ length: 100 }, () => 60_000);
    const last = LATENCY_THRESHOLDS[LATENCY_THRESHOLDS.length - 1];

    // Nothing in the histogram distinguishes 11 seconds from a minute, so the
    // honest answer is the edge of what is known.
    expect(estimatePercentile(histogramOf(slow), slow.length, 0.95)).toBe(last);
  });

  it('is unchanged by splitting the same calls across two histograms', () => {
    // This is what makes the rollup usable at all: an hour and the next hour
    // have to add up to the two hours together.
    const first = [1, 4, 9, 30, 200];
    const second = [2, 7, 80, 400, 900];

    const combined = addHistograms(histogramOf(first), histogramOf(second));
    const whole = histogramOf([...first, ...second]);

    expect(combined).toEqual(whole);
  });
});

describe('splitWindow', () => {
  const at = (iso: string) => new Date(iso);

  it('reads whole hours from the rollup and the ragged ends from raw rows', () => {
    const split = splitWindow({ from: at('2026-09-24T10:17:00Z'), to: at('2026-09-24T18:42:00Z') });

    expect(split.useRollup).toBe(true);
    expect(split.rollupFrom.toISOString()).toBe('2026-09-24T11:00:00.000Z');
    expect(split.rollupTo.toISOString()).toBe('2026-09-24T18:00:00.000Z');
    expect(split.edges).toEqual([
      { from: at('2026-09-24T10:17:00Z'), to: at('2026-09-24T11:00:00Z') },
      { from: at('2026-09-24T18:00:00Z'), to: at('2026-09-24T18:42:00Z') },
    ]);
  });

  it('leaves no edges when the window is already whole hours', () => {
    const split = splitWindow({ from: at('2026-09-24T10:00:00Z'), to: at('2026-09-24T18:00:00Z') });

    expect(split.useRollup).toBe(true);
    expect(split.edges).toEqual([]);
  });

  it('gives up on the rollup when no whole hour is covered', () => {
    // Crosses an hour boundary but contains none of it, so there is nothing
    // for the rollup to answer and the detour would only cost a second query.
    const split = splitWindow({ from: at('2026-09-24T10:40:00Z'), to: at('2026-09-24T11:20:00Z') });

    expect(split.useRollup).toBe(false);
    expect(split.edges).toHaveLength(1);
    expect(split.edges[0]?.from.toISOString()).toBe('2026-09-24T10:40:00.000Z');
    expect(split.edges[0]?.to.toISOString()).toBe('2026-09-24T11:20:00.000Z');
  });

  it('covers the window exactly, with no gap and no overlap', () => {
    // The property that matters: whatever the split, every instant in the
    // window is counted once. A gap loses calls, an overlap doubles them.
    const from = at('2026-09-24T10:17:00Z');
    const to = at('2026-09-24T18:42:00Z');
    const split = splitWindow({ from, to });

    const covered = [
      ...split.edges.map((e) => [e.from.getTime(), e.to.getTime()] as const),
      [split.rollupFrom.getTime(), split.rollupTo.getTime()] as const,
    ].sort((a, b) => a[0] - b[0]);

    expect(covered[0]?.[0]).toBe(from.getTime());
    expect(covered[covered.length - 1]?.[1]).toBe(to.getTime());

    for (let i = 1; i < covered.length; i++) {
      expect(covered[i]?.[0]).toBe(covered[i - 1]?.[1]);
    }
  });
});
