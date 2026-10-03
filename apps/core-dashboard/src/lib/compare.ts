/**
 * How a figure moved against the window before it.
 *
 * "61 calls" says little on its own; "20% more than the day before" says
 * whether anything is happening. Each comparison is worded rather than only
 * coloured, so it reads the same to somebody who cannot tell the colours
 * apart, and each knows which way is good: fewer errors and faster answers
 * are, while fewer calls is only a fact.
 *
 * Kept free of imports: the API package's tests import this file directly.
 */

type ChangeTone = 'good' | 'bad' | 'neutral';

export interface Change {
  direction: 'up' | 'down' | 'flat';
  tone: ChangeTone;
  /** The movement in words, for example "20% more" or "3.1 pts higher". */
  text: string;
}

/**
 * Below this relative change a figure is called unchanged.
 *
 * Wider for durations, which are read from a latency histogram whose steps are
 * about half as wide again as the one below: a median moving by a few percent
 * is the estimate settling in a step, not the tool changing.
 */
const FLAT_COUNT = 0.005;
const FLAT_DURATION = 0.05;

/** Below this many percentage points an error rate is called unchanged. */
const FLAT_RATE_POINTS = 0.05;

const UNCHANGED: Change = { direction: 'flat', tone: 'neutral', text: 'No change' };

/**
 * Calls against calls. Null when the earlier window had none, since any
 * percentage over nothing is infinite and says nothing.
 */
export function compareCalls(current: number, previous: number): Change | null {
  if (previous === 0) return null;

  const relative = (current - previous) / previous;

  if (Math.abs(relative) < FLAT_COUNT) return UNCHANGED;

  return {
    direction: relative > 0 ? 'up' : 'down',
    // More calls is not better and fewer is not worse. It is a fact about
    // traffic, and colouring it would be a claim about it.
    tone: 'neutral',
    text: `${percent(relative)} ${relative > 0 ? 'more' : 'fewer'}`,
  };
}

/**
 * Error rate against error rate, in percentage points.
 *
 * Points rather than a relative change: going from one error in a hundred to
 * two is "1 pt higher", which is what happened, and not "100% higher", which
 * sounds like a fire. Null when either window had no calls to have a rate.
 */
export function compareErrorRate(
  current: { rate: number; calls: number },
  previous: { rate: number; calls: number },
): Change | null {
  if (current.calls === 0 || previous.calls === 0) return null;

  const points = (current.rate - previous.rate) * 100;

  if (Math.abs(points) < FLAT_RATE_POINTS) return UNCHANGED;

  return {
    direction: points > 0 ? 'up' : 'down',
    tone: points > 0 ? 'bad' : 'good',
    text: `${Math.abs(points).toFixed(1)} pts ${points > 0 ? 'higher' : 'lower'}`,
  };
}

/** A duration against a duration. Null when either window has none. */
export function compareDuration(current: number | null, previous: number | null): Change | null {
  if (current === null || previous === null || previous === 0) return null;

  const relative = (current - previous) / previous;

  if (Math.abs(relative) < FLAT_DURATION) return UNCHANGED;

  return {
    direction: relative > 0 ? 'up' : 'down',
    tone: relative > 0 ? 'bad' : 'good',
    text: `${percent(relative)} ${relative > 0 ? 'slower' : 'faster'}`,
  };
}

function percent(relative: number): string {
  const value = Math.abs(relative) * 100;

  // Whole percent past ten, one decimal below, so a small change does not
  // round away to zero and a large one does not pretend to precision.
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
}
