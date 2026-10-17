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

/** A window somebody chose by its dates, rather than one of the above. */
export const CUSTOM = 'custom';

export type RangeKey = (typeof RANGES)[number]['key'] | typeof CUSTOM;

/**
 * Between a custom window's two instants in the address: `range=<from>..<to>`.
 *
 * One parameter rather than two, so every link that already carries `range`
 * from page to page carries a chosen window too, without learning about it.
 */
const SEPARATOR = '..';

const HOUR_MS = 60 * 60 * 1000;

export interface ResolvedRange {
  key: RangeKey;
  /** For a named window, its name; for a custom one, undefined, and the page shows its dates. */
  label: string | undefined;
  /** Start of the window, as the API wants it. */
  from: string;
  /** End of a custom window; a named one runs up to now. */
  to: string | undefined;
  /** The window as query parameters for the API: from, and to when it has one. */
  window: { from: string; to?: string };
  /** The window of the same length just before this one, to compare against. */
  previous: { from: string; to: string };
  /** How that earlier window is named in a sentence: "the 24 hours before". */
  previousLabel: string;
}

/** The value of `range` for a window between two instants. */
export function customRangeValue(from: Date, to: Date): string {
  return `${from.toISOString()}${SEPARATOR}${to.toISOString()}`;
}

/** The two instants of a custom `range` value, or undefined when it is not one that makes sense. */
export function parseCustomRange(value: string | undefined): { from: Date; to: Date } | undefined {
  if (value === undefined || !value.includes(SEPARATOR)) return undefined;

  const [fromText, toText] = value.split(SEPARATOR);
  const from = new Date(fromText ?? '');
  const to = new Date(toText ?? '');

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from.getTime() >= to.getTime()) {
    return undefined;
  }

  return { from, to };
}

/** "the 3 days before", "the 5 hours before", or "the period before" for a length that is neither. */
function lengthBefore(lengthMs: number): string {
  const hours = lengthMs / HOUR_MS;

  if (Number.isInteger(hours / 24)) return hours === 24 ? 'the day before' : `the ${hours / 24} days before`;
  if (Number.isInteger(hours)) return hours === 1 ? 'the hour before' : `the ${hours} hours before`;

  return 'the period before';
}

/**
 * Reads the window out of an address, falling back rather than refusing.
 *
 * An unfamiliar value means somebody edited the URL or followed a link from a
 * newer version; showing them a day of data is a better answer than an error
 * page about a query parameter.
 */
export function resolveRange(value: string | undefined): ResolvedRange {
  const custom = parseCustomRange(value);

  if (custom !== undefined) {
    const length = custom.to.getTime() - custom.from.getTime();
    const from = custom.from.toISOString();
    const to = custom.to.toISOString();

    return {
      key: CUSTOM,
      label: undefined,
      from,
      to,
      window: { from, to },
      previous: { from: new Date(custom.from.getTime() - length).toISOString(), to: from },
      previousLabel: lengthBefore(length),
    };
  }

  const range = RANGES.find((candidate) => candidate.key === value) ?? RANGES[0];

  const length = range.hours * HOUR_MS;
  const from = new Date(Date.now() - length).toISOString();

  return {
    key: range.key,
    label: range.label,
    from,
    to: undefined,
    window: { from },
    previous: { from: new Date(Date.now() - 2 * length).toISOString(), to: from },
    previousLabel: `the ${range.label.replace(/^Last /, '')} before`,
  };
}
