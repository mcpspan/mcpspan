/**
 * What the numbers that recur across the dashboard mean, in one place, so a column explained in one card is
 * explained the same way in every other.
 */
export const EXPLAIN = {
  errors:
    'The share of calls that failed: an error the tool reported, an exception it threw, or arguments the server refused. Calls to names the server does not have are counted apart.',
  median:
    'How long calls took: half of them were faster than the median. p95 under it: 95 in 100 were faster, so it shows the slow tail the median hides.',
  firstSeen: 'When mcpspan first saw a call answered by this version, in the data still kept.',
} as const;
