/** How far back a request reaches when it does not say. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TimeRange {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

/**
 * Reads the window a dashboard request is asking about.
 *
 * Two instants rather than a named period like "7d". The frontend's range
 * selector is a presentation choice, and baking its vocabulary into the API
 * would mean a new endpoint version the first time somebody wants a fortnight,
 * or last Tuesday. Working out the instants is the caller's job; honouring
 * them is ours.
 *
 * The window is half open: from is included, to is not. Adjacent ranges then
 * tile without an event landing in both, which is what keeps two charts side
 * by side from disagreeing about a total.
 */
export function parseTimeRange(query: {
  from?: string | undefined;
  to?: string | undefined;
}): TimeRange | { error: string } {
  const to = query.to === undefined ? new Date() : new Date(query.to);

  if (Number.isNaN(to.getTime())) {
    return { error: `'to' is not a date: ${query.to ?? ''}` };
  }

  const from =
    query.from === undefined ? new Date(to.getTime() - DEFAULT_WINDOW_MS) : new Date(query.from);

  if (Number.isNaN(from.getTime())) {
    return { error: `'from' is not a date: ${query.from ?? ''}` };
  }

  if (from >= to) {
    return { error: "'from' must be earlier than 'to'" };
  }

  return { from, to };
}
