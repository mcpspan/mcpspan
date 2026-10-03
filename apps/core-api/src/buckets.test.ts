import { describe, expect, it } from 'vitest';

import { chooseBucketSeconds } from './buckets.ts';

function windowOf(hours: number): { from: Date; to: Date } {
  const to = new Date('2026-09-18T00:00:00.000Z');

  return { from: new Date(to.getTime() - hours * 60 * 60 * 1000), to };
}

describe('chooseBucketSeconds', () => {
  it.each([
    ['an hour', 1, 60],
    ['a day', 24, 3_600],
    ['a week', 24 * 7, 6 * 3_600],
    ['a month', 24 * 30, 24 * 3_600],
    ['a year', 24 * 365, 7 * 24 * 3_600],
  ])('buckets %s into steps people think in', (_label, hours, expected) => {
    expect(chooseBucketSeconds(windowOf(hours))).toBe(expected);
  });

  it.each([1, 6, 24, 24 * 7, 24 * 30, 24 * 90, 24 * 365])(
    'keeps a %i hour window to a readable number of points',
    (hours) => {
      const { from, to } = windowOf(hours);
      const points = (to.getTime() - from.getTime()) / 1000 / chooseBucketSeconds({ from, to });

      // Below this a chart has nothing to say; above it a line turns into a
      // smear.
      expect(points).toBeGreaterThan(1);
      expect(points).toBeLessThanOrEqual(60);
    },
  );

  it('takes the widest step for a window longer than any of them suits', () => {
    // Past a year or so the ladder runs out and the point count creeps above
    // the target. Widening further would mean buckets measured in seasons,
    // which answers nothing, so the count is allowed to drift instead.
    const { from, to } = windowOf(24 * 365 * 5);

    expect(chooseBucketSeconds({ from, to })).toBe(30 * 24 * 3_600);
  });
});
