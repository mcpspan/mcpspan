/**
 * Handlers that instrumentation should leave alone.
 *
 * Two different situations land here. A handler already wrapped by `track` is
 * marked so that wrapping a whole server afterwards does not count every call
 * twice. A handler passed through `exclude` is marked so that it is never
 * counted at all.
 *
 * A weak set rather than a property on the function itself: these are the
 * developer's own functions, and a telemetry library has no business writing
 * anything onto them. Entries disappear with the handlers they refer to.
 */
const marked = new WeakSet<object>();

/** Records that this function should not be wrapped again. */
export function markHandler<T extends object>(handler: T): T {
  marked.add(handler);

  return handler;
}

/** Whether this function has already been spoken for. */
export function isMarked(handler: unknown): boolean {
  return typeof handler === 'function' && marked.has(handler);
}

/**
 * Handlers passed through `exclude`, as opposed to already tracked.
 *
 * The difference only matters for calls the server refuses before any handler
 * runs: a call to a tracked tool with bad arguments is counted, while one to
 * an excluded tool is not, in that form or any other.
 */
const excluded = new WeakSet<object>();

export function markExcluded<T extends object>(handler: T): T {
  excluded.add(handler);

  return markHandler(handler);
}

export function isExcluded(handler: unknown): boolean {
  return typeof handler === 'function' && excluded.has(handler);
}
