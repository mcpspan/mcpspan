/**
 * The windows the dashboard offers.
 *
 * Named here and turned into instants at the edge, so the address bar stays
 * readable and the API keeps taking two timestamps. Somebody pasting a link
 * into a message sends "the last week", not a pair of dates that stopped
 * meaning that an hour later.
 */
export const RANGES = [
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '30d', label: 'Last 30 days', hours: 24 * 30 },
] as const;

export type RangeKey = (typeof RANGES)[number]['key'];

export interface ResolvedRange {
  key: RangeKey;
  label: string;
  /** Start of the window, as the API wants it. */
  from: string;
  /** The window of the same length just before this one, to compare against. */
  previous: { from: string; to: string };
  /** How that earlier window is named in a sentence: "the 24 hours before". */
  previousLabel: string;
}

/**
 * Reads the window out of an address, falling back rather than refusing.
 *
 * An unfamiliar value means somebody edited the URL or followed a link from a
 * newer version; showing them a day of data is a better answer than an error
 * page about a query parameter.
 */
export function resolveRange(value: string | undefined): ResolvedRange {
  const range = RANGES.find((candidate) => candidate.key === value) ?? RANGES[0];

  const length = range.hours * 60 * 60 * 1000;
  const from = Date.now() - length;

  return {
    key: range.key,
    label: range.label,
    from: new Date(from).toISOString(),
    previous: { from: new Date(from - length).toISOString(), to: new Date(from).toISOString() },
    previousLabel: `the ${range.label.replace(/^Last /, '')} before`,
  };
}
