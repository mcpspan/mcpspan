import type { ClientInfo } from './client.js';

/**
 * What `instrument` knows about the call now starting, handed to `track`.
 *
 * `track` wraps the developer's handler and sees only its arguments. Which
 * connection the call arrived on, and which client sent it, are known one
 * layer out, where the MCP server hands the request to the handler. They are
 * passed in here, per call, rather than kept anywhere shared: one process can
 * serve several clients at once, and a value shared between their calls would
 * sooner or later be the other client's.
 */
export interface CallContext {
  /** Our identifier for the connection, or absent when the call has none. */
  sessionId?: string;
  /** The client that sent this call, as it named itself. */
  client?: ClientInfo;
  /** The version the server this call arrived on gives itself. */
  serverVersion?: string;
  /** The call's arguments are the previous call's to the same tool in this session (contract, 3.9). */
  repeated?: boolean;
}

let current: CallContext | undefined;

/**
 * Runs a handler with its call context known to `track`.
 *
 * `track` reads the context synchronously, as the call begins, before anything
 * the handler does could start another call, so a plain variable is exact here
 * and needs nothing like async context tracking.
 */
export function withCall<T>(call: CallContext, run: () => T): T {
  const previous = current;
  current = call;

  try {
    return run();
  } finally {
    current = previous;
  }
}

/** The context of the call now starting, if it arrived through `instrument`. */
export function currentCall(): CallContext | undefined {
  return current;
}
