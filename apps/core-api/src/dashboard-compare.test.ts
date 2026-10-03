import { describe, expect, it } from 'vitest';

import {
  compareCalls,
  compareDuration,
  compareErrorRate,
} from '../../core-dashboard/src/lib/compare.ts';

/**
 * How the dashboard words a change against the window before.
 *
 * Tested from here because this package is the one with a test runner, the
 * same way the contract test reaches into the dashboard's API client.
 */
describe('compareCalls', () => {
  it('says how many more or fewer, as a share', () => {
    expect(compareCalls(120, 100)).toEqual({ direction: 'up', tone: 'neutral', text: '20% more' });
    expect(compareCalls(75, 100)).toEqual({ direction: 'down', tone: 'neutral', text: '25% fewer' });
  });

  it('never calls a change in traffic good or bad', () => {
    expect(compareCalls(10, 100)?.tone).toBe('neutral');
    expect(compareCalls(1000, 100)?.tone).toBe('neutral');
  });

  it('says nothing, rather than infinity, when there was nothing before', () => {
    expect(compareCalls(61, 0)).toBeNull();
  });

  it('keeps a small change from rounding away to nothing', () => {
    expect(compareCalls(1005, 1000)?.text).toBe('0.5% more');
  });

  it('calls a change too small to matter no change', () => {
    expect(compareCalls(10_001, 10_000)?.direction).toBe('flat');
  });
});

describe('compareErrorRate', () => {
  it('counts in percentage points, not in a share of a share', () => {
    // One error in a hundred to two is one point, not a hundred percent.
    expect(compareErrorRate({ rate: 0.02, calls: 100 }, { rate: 0.01, calls: 100 })).toEqual({
      direction: 'up',
      tone: 'bad',
      text: '1.0 pts higher',
    });
  });

  it('calls fewer errors good', () => {
    expect(compareErrorRate({ rate: 0.01, calls: 100 }, { rate: 0.05, calls: 100 })?.tone).toBe(
      'good',
    );
  });

  it('says nothing when either window had no calls to have a rate', () => {
    expect(compareErrorRate({ rate: 0.5, calls: 2 }, { rate: 0, calls: 0 })).toBeNull();
    expect(compareErrorRate({ rate: 0, calls: 0 }, { rate: 0.5, calls: 2 })).toBeNull();
  });
});

describe('compareDuration', () => {
  it('calls slower bad and faster good', () => {
    expect(compareDuration(120, 100)).toEqual({ direction: 'up', tone: 'bad', text: '20% slower' });
    expect(compareDuration(50, 100)).toEqual({ direction: 'down', tone: 'good', text: '50% faster' });
  });

  it('treats a few percent as the estimate settling, not a change', () => {
    // Durations come from a histogram, so small moves are noise.
    expect(compareDuration(103, 100)?.direction).toBe('flat');
  });

  it('says nothing when either window has no duration', () => {
    expect(compareDuration(40, null)).toBeNull();
    expect(compareDuration(null, 40)).toBeNull();
  });
});
