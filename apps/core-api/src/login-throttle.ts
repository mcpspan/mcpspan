/**
 * How many wrong passwords the installation takes in a minute.
 *
 * Counted for the whole installation rather than per address. There is one
 * account, so the only person signing in is its owner, and the address is not
 * something this API can know: sign-in arrives through the dashboard, often
 * behind a tunnel or a proxy, so every request comes from the same place, and
 * a header naming the real one can be written by whoever sends the request.
 *
 * The cost is that somebody guessing without pause also keeps the owner from
 * signing in anew while they do; a browser already signed in is unaffected, and
 * restarting the API clears the count. Kept in memory, per process, as the
 * ingest limit is.
 */

/** Wrong passwords allowed in a window. */
const MAX_FAILURES = 10;
const WINDOW_MS = 60 * 1000;

export class LoginThrottle {
  private failures: number[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Whole seconds until a password will be checked again, or 0 when it will be now. */
  retryAfterSeconds(): number {
    this.forget();
    if (this.failures.length < MAX_FAILURES) return 0;

    const oldest = this.failures[0] ?? this.now();

    return Math.max(1, Math.ceil((oldest + WINDOW_MS - this.now()) / 1000));
  }

  recordFailure(): void {
    this.forget();
    this.failures.push(this.now());
  }

  /** Only for tests. */
  reset(): void {
    this.failures = [];
  }

  private forget(): void {
    const cutoff = this.now() - WINDOW_MS;
    this.failures = this.failures.filter((at) => at > cutoff);
  }
}

/** The one the running API uses. */
export const loginThrottle = new LoginThrottle();
