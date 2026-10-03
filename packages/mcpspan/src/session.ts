import { randomUUID } from 'node:crypto';

/**
 * Which conversation a tool call belongs to.
 *
 * A single call says little; the order of them says how an agent actually uses
 * a server - that it always searches before it books, or pages through a list
 * three times, or retries the same call after an error. That needs calls
 * grouped by the connection they arrived on.
 *
 * The identifier is ours, random, and made fresh for each connection. It is
 * deliberately not the transport's own session identifier, which travels in
 * HTTP headers and would let anyone holding the server's logs join our events
 * to them. Nothing in it says anything about who is on the other end.
 */

/** Connections remembered per server. Past this the oldest is forgotten. */
const MAX_SESSIONS_PER_SERVER = 1_000;

/** Per server instance, the transport's session key mapped to our identifier. */
const sessions = new WeakMap<object, Map<string, string>>();

/**
 * Our identifier for the connection a request arrived on, or none.
 *
 * - The transport names a session (HTTP with sessions, on the 2025 protocol):
 *   one identifier per transport session.
 * - HTTP without one (a stateless server, and every server on the 2026-07-28
 *   protocol, which removed sessions): none. Each request there may reach a
 *   fresh server instance, and calling each call its own session would fill
 *   the session views with sessions of one call that no agent had.
 * - Anything else - stdio, an in-process transport - is one connection for
 *   the life of the server instance, so the instance is the session. On the
 *   2026 protocol over stdio the official SDK pins one instance per
 *   connection, which keeps this true.
 *
 * The request context is the MCP SDK's own: `extra` in v1, `ctx` in v2. Both
 * put the transport session at `sessionId`; v1 marks an HTTP request with
 * `requestInfo`, v2 with `http`.
 */
export function sessionFor(server: object, context: unknown): string | undefined {
  const request = (context ?? {}) as {
    sessionId?: unknown;
    requestInfo?: unknown;
    http?: unknown;
  };
  const transportSession = request.sessionId;

  const overHttp = request.requestInfo !== undefined || request.http !== undefined;

  if (typeof transportSession !== 'string' && overHttp) return undefined;

  const key = typeof transportSession === 'string' ? transportSession : '';

  let known = sessions.get(server);

  if (known === undefined) {
    known = new Map();
    sessions.set(server, known);
  }

  const existing = known.get(key);

  if (existing !== undefined) {
    // Moved to the back, so the ones forgotten first are the ones idle longest.
    known.delete(key);
    known.set(key, existing);

    return existing;
  }

  const created = randomUUID();
  known.set(key, created);

  if (known.size > MAX_SESSIONS_PER_SERVER) {
    const oldest = known.keys().next().value;
    if (oldest !== undefined) known.delete(oldest);
  }

  return created;
}
