/**
 * How many wrong passwords one account takes in a minute.
 *
 * Counted per address signed in to, not per address signing in: sign-in
 * arrives through the dashboard, often behind a tunnel or a proxy, so every
 * request comes from the same place, and a header naming the real one can be
 * written by whoever sends the request.
 *
 * Per account rather than for the whole installation, so somebody guessing at
 * one account does not keep everybody else from signing in. The cost is that
 * they keep that one account's owner from signing in anew while they guess; a
 * browser already signed in is unaffected, and restarting the API clears the
 * count. Kept in memory, per process, as the ingest limit is.
 */

/** Wrong passwords allowed in a window. */
const MAX_FAILURES = 10;
const WINDOW_MS = 60 * 1000;

/** Past this many accounts with failures, old ones are cleared on the next failure. */
const SWEEP_ABOVE = 1000;

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Whole seconds until a password for this account will be checked again, or 0 when it will be now. */
  retryAfterSeconds(account: string): number {
    const recent = this.recent(account);
    if (recent.length < MAX_FAILURES) return 0;

    const oldest = recent[0] ?? this.now();

    return Math.max(1, Math.ceil((oldest + WINDOW_MS - this.now()) / 1000));
  }

  recordFailure(account: string): void {
    if (this.failures.size > SWEEP_ABOVE) {
      for (const key of [...this.failures.keys()]) this.recent(key);
    }

    this.failures.set(keyFor(account), [...this.recent(account), this.now()]);
  }

  /** Only for tests. */
  reset(): void {
    this.failures.clear();
  }

  /** Failures still inside the window, forgetting the account once it has none. */
  private recent(account: string): number[] {
    const key = keyFor(account);
    const cutoff = this.now() - WINDOW_MS;
    const recent = (this.failures.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length === 0) this.failures.delete(key);
    else this.failures.set(key, recent);

    return recent;
  }
}

/** The same address however it was typed. */
function keyFor(account: string): string {
  return account.trim().toLowerCase();
}

/** The one the running API uses. */
export const loginThrottle = new LoginThrottle();
