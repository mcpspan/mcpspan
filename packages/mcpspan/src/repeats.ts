import { createHash } from 'node:crypto';

import { canonical } from './definition.js';

/**
 * Whether a call repeats the previous call to the same tool in the same
 * session (contract, 3.9): an agent stuck in a loop.
 *
 * Only the answer leaves the process. Kept here is a SHA-256 of the canonical
 * arguments of the latest call per session and tool, never sent: a digest of
 * a short identifier or an enumerated value is found by trying every one.
 */

/** Session and tool pairs kept, the oldest forgotten first. */
const MAX_KEPT = 10_000;

const latest = new Map<string, string>();

/**
 * Notes a call's arguments, as the client sent them, and says whether they are
 * the previous call's to the same tool in the same session. Never throws: an
 * argument object that cannot be written down is never a repeat.
 */
export function noteArguments(sessionId: string, toolName: string, args: unknown): boolean {
  try {
    const digest = createHash('sha256')
      .update(canonical(args ?? {}), 'utf8')
      .digest('hex');
    const key = `${sessionId}\u0000${toolName}`;
    const previous = latest.get(key);

    // Delete first, so this pair is now the newest and the last to be forgotten.
    latest.delete(key);
    latest.set(key, digest);
    if (latest.size > MAX_KEPT) {
      const oldest = latest.keys().next().value;
      if (oldest !== undefined) latest.delete(oldest);
    }

    return previous === digest;
  } catch {
    return false;
  }
}

/** For tests: forgets every call. */
export function forgetArguments(): void {
  latest.clear();
}
