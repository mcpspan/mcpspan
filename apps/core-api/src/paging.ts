/**
 * Pages through lists that can outgrow one screen.
 *
 * Two kinds, chosen by what the list is. A ranking - tools by calls, the
 * commonest messages - is a bounded, computed list, and is paged by offset.
 * A stream of recorded rows - failures, the calls in a session - only grows,
 * and is paged by a cursor on its sort key: an offset there would make page
 * two hundred read the two hundred pages before it every time.
 */

export interface Page {
  offset: number;
  limit: number;
}

/** Furthest an offset may go. Rankings are bounded well below this. */
const MAX_OFFSET = 100_000;

/**
 * Reads `offset` and `limit` from a request, under a name prefix when one
 * page shows several lists, like a tool's messages and its parameters.
 */
export function parsePage(
  read: (name: string) => string | undefined,
  defaults: { limit: number; max: number },
  prefix = '',
): Page | { error: string } {
  const offsetName = prefix === '' ? 'offset' : `${prefix}Offset`;
  const limitName = prefix === '' ? 'limit' : `${prefix}Limit`;
  const offset = wholeNumber(read(offsetName), 0);
  const limit = wholeNumber(read(limitName), defaults.limit);

  if (offset === undefined || offset > MAX_OFFSET) {
    return { error: `'${offsetName}' must be a whole number from 0 to ${MAX_OFFSET}` };
  }

  if (limit === undefined || limit < 1 || limit > defaults.max) {
    return { error: `'${limitName}' must be a whole number from 1 to ${defaults.max}` };
  }

  return { offset, limit };
}

/** One page of a list fetched a row long, and whether that extra row existed. */
export function takePage<T>(rows: readonly T[], page: Page): { items: T[]; hasMore: boolean } {
  return { items: rows.slice(0, page.limit), hasMore: rows.length > page.limit };
}

function wholeNumber(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);

  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A position in a stream of rows ordered by time, then id.
 *
 * The time is kept as PostgreSQL's own text for it. A JavaScript Date keeps
 * milliseconds and the column keeps microseconds, so a cursor made from a Date
 * lands just before the row it came from and the next page repeats it.
 */
export interface Cursor {
  at: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString('base64url');
}

/** Reads a cursor, or undefined when it is not one this API made. */
export function decodeCursor(raw: string | undefined): Cursor | undefined | { error: string } {
  if (raw === undefined || raw === '') return undefined;

  try {
    const [at, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown[];

    if (
      typeof at === 'string' &&
      typeof id === 'string' &&
      !Number.isNaN(Date.parse(at)) &&
      /^[0-9a-f-]{36}$/i.test(id)
    ) {
      return { at, id };
    }
  } catch {
    // Falls through to the refusal below.
  }

  return { error: 'That page marker is not one this API gave out' };
}
