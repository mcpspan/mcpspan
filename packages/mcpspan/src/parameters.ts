import { MAX_NAME_LENGTH, truncate } from './failure.js';

/**
 * Most parameters described for a single call.
 *
 * A bound rather than a guess at what is reasonable: a tool taking a very wide
 * object should not be able to turn one event into a large one.
 */
export const MAX_DESCRIBED_PARAMETERS = 50;

/**
 * Names the shape of a value without touching what is in it.
 *
 * Deliberately coarse. Anything finer starts describing content, and the
 * distance between "this is a 34 character string" and "this is a credit card
 * number" is shorter than it looks.
 */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';

  return typeof value;
}

/**
 * Lists the parameters a tool was called with, by name and type only.
 *
 * Values never leave the handler. This exists so a developer can see that
 * `search_flights` is being called with `destination` but never with
 * `departureDate`, which is a real debugging need, without any of the answers
 * to those parameters reaching a server.
 *
 * Only the first argument is read, which is where MCP puts a tool's parameter
 * object. Anything else in the signature belongs to the protocol, not the
 * tool.
 */
export function describeParameters(args: readonly unknown[]): Record<string, string> | undefined {
  const [params] = args;

  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return undefined;
  }

  const described: Record<string, string> = {};
  let count = 0;

  for (const [name, value] of Object.entries(params)) {
    if (count >= MAX_DESCRIBED_PARAMETERS) break;

    // A name over the API's limit would have the whole batch refused.
    described[truncate(name, MAX_NAME_LENGTH)] = describeType(value);
    count += 1;
  }

  return count > 0 ? described : undefined;
}
