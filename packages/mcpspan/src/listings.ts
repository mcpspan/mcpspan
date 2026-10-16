/**
 * The listings already sent for each session, so the same answer to
 * `tools/list` is sent once per session (contract, 3.11). A client lists the
 * tools at the start of a session and often again; the count that matters is
 * the sessions that were shown the tools, not how often they asked.
 */

/** Sessions kept, the oldest forgotten first. */
const MAX_SESSIONS = 10_000;

const sent = new Map<string, Set<string>>();

/**
 * Whether a listing is new for its session, noting it as sent. A listing with
 * no session is always new: there is nothing to tell its repeats apart by.
 */
export function firstListing(sessionId: string | undefined, signature: string): boolean {
  if (sessionId === undefined) return true;

  const seen = sent.get(sessionId) ?? new Set<string>();
  if (seen.has(signature)) return false;

  // Delete first, so this session is now the newest and the last to be forgotten.
  sent.delete(sessionId);
  seen.add(signature);
  sent.set(sessionId, seen);
  if (sent.size > MAX_SESSIONS) {
    const oldest = sent.keys().next().value;
    if (oldest !== undefined) sent.delete(oldest);
  }

  return true;
}

/** For tests: forgets every listing sent. */
export function forgetListingsSent(): void {
  sent.clear();
}
