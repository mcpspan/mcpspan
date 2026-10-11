/** Everything the dashboard keeps in the address. */
export type Params = Record<string, string | undefined>;

/**
 * Builds a link that changes one thing and leaves the rest alone.
 *
 * Every control on these pages works this way, which is what lets them be
 * combined: narrowing to a tool must not silently reset the window, and
 * sorting a table must not drop the filter somebody just applied.
 *
 * A value of undefined removes the parameter, so the same function both sets
 * a filter and clears it.
 */
export function withParams(current: Params, changes: Params): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries({ ...current, ...changes })) {
    if (value !== undefined && value !== '') query.set(key, value);
  }

  const search = query.toString();

  // A bare "?" is a valid link but leaves a stray character in the address
  // bar, which looks like something went wrong.
  return search.length > 0 ? `?${search}` : '?';
}

/**
 * Where each paged list keeps its place in the address.
 *
 * One name per list rather than a shared "page", because several lists sit on
 * one page and paging one must not move the others.
 */
export const PAGING_PARAMS = [
  'before',
  'after',
  'toolsOffset',
  'unknownOffset',
  'clientsOffset',
  'sessionsOffset',
  'transitionsOffset',
  'messagesOffset',
  'parametersOffset',
  'beforeOffset',
  'eventsOffset',
] as const;

/**
 * The address without any list's place in it.
 *
 * For controls that change what a list holds - the window, a filter, the
 * server, the order. The old place would point somewhere in a different
 * list, most likely past its end, and show an empty page that looks like no
 * data.
 */
export function withoutPaging(current: Params): Params {
  const kept: Params = { ...current };

  for (const name of PAGING_PARAMS) delete kept[name];

  return kept;
}

/** Reads a list's offset from the address, treating anything odd as the start. */
export function offsetParam(current: Params, name: (typeof PAGING_PARAMS)[number]): number {
  const value = Number(current[name]);

  return Number.isInteger(value) && value > 0 ? value : 0;
}
