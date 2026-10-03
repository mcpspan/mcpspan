import { getPool } from './db.ts';

/**
 * Why the ingest endpoint turned a request away.
 *
 * Each one points at a different fix, which is the whole reason they are kept
 * apart: a key that was replaced wants a redeploy, a key nobody recognises
 * wants a look at the signing secret, and a server being slowed down wants
 * nothing at all.
 */
export type RefusalReason =
  /** No Authorization header, or an empty one. */
  | 'missing_key'
  /** A key this installation has no record of. */
  | 'unknown_key'
  /** A key that belonged to a server and has since been replaced or revoked. */
  | 'revoked_key'
  /** More bytes, or more events, than one batch may carry. */
  | 'too_large'
  /** Not JSON, or not the shape of a batch. */
  | 'invalid_batch'
  /** Over the server's rate limit. The SDK keeps the batch and sends it again. */
  | 'rate_limited'
  /** Accepted, then not written. The SDK keeps the batch and sends it again. */
  | 'storage_failed';

export interface RefusalCount {
  /** Absent when the request never identified a server. */
  serverId: string | null;
  reason: RefusalReason;
  requests: number;
  lastAt: string;
}

interface Pending {
  serverId: string | null;
  reason: RefusalReason;
  requests: number;
  lastAt: Date;
}

/** PostgreSQL's code for a foreign key that points at nothing. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Counts refused ingest requests, and writes the counts down now and then.
 *
 * Recording happens in memory, on the request path, and never waits for the
 * database. That matters for two reasons. A refusal is often the cheapest
 * answer this API gives, and one anybody on the network can ask for by sending
 * a made-up key: turning each into a write would let them turn it into load
 * on the database. And some refusals happen precisely because the database is
 * unwell, when waiting on it would be the worst thing to do.
 *
 * The counts are flushed on a timer instead. What has not been flushed yet is
 * still included when the counts are read, so the view is current to the
 * request, and what a restart loses is at most one interval's worth.
 *
 * Memory stays bounded without any eviction: entries are keyed by server and
 * reason, and a server only appears once its key has been verified, so the
 * number of entries is the number of servers times a handful of reasons, no
 * matter who is sending what.
 */
export class RefusalLog {
  private pending = new Map<string, Pending>();

  private readonly now: () => Date;

  // Assigned in the body rather than declared as a parameter property: Node
  // runs this file by stripping types, and a parameter property emits code.
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  record(reason: RefusalReason, serverId: string | null = null): void {
    const key = `${serverId ?? ''}:${reason}`;
    const existing = this.pending.get(key);
    const at = this.now();

    if (existing === undefined) {
      this.pending.set(key, { serverId, reason, requests: 1, lastAt: at });
    } else {
      existing.requests += 1;
      existing.lastAt = at;
    }
  }

  /**
   * Adds what has been counted since the last flush to the stored totals.
   *
   * Taken out of the pending set before the first write, so requests refused
   * while this runs start a fresh count instead of being written twice. If a
   * write fails the rest is put back for next time, since the database being
   * away is exactly the moment these counts are worth keeping.
   */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;

    const batch = [...this.pending.values()];
    this.pending = new Map();

    for (const [index, entry] of batch.entries()) {
      try {
        await getPool().query(
          `INSERT INTO ingest_refusals (server_id, reason, requests, last_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT ON CONSTRAINT ingest_refusals_key DO UPDATE SET
             requests = ingest_refusals.requests + EXCLUDED.requests,
             last_at = GREATEST(ingest_refusals.last_at, EXCLUDED.last_at)`,
          [entry.serverId, entry.reason, entry.requests, entry.lastAt],
        );
      } catch (error) {
        // The server was deleted between the refusal and the flush. Its
        // counts went with it, which is what deleting a server means, and
        // retrying would fail the same way forever and hold up every other
        // entry behind it.
        if (codeOf(error) === FOREIGN_KEY_VIOLATION) continue;

        for (const unwritten of batch.slice(index)) this.restore(unwritten);

        throw error;
      }
    }
  }

  /**
   * Stored totals plus anything not yet flushed.
   *
   * Scoped to the servers asked about, plus the refusals that named no server
   * at all. Those belong to the installation rather than to any account; on a
   * self-hosted install with one account that is the same thing, and a hosted
   * version would need to keep them to itself.
   */
  async counts(serverIds: readonly string[]): Promise<RefusalCount[]> {
    const stored = await getPool().query<{
      server_id: string | null;
      reason: RefusalReason;
      requests: string;
      last_at: Date;
    }>(
      `SELECT server_id, reason, requests, last_at
       FROM ingest_refusals
       WHERE server_id IS NULL OR server_id = ANY($1::uuid[])`,
      [serverIds],
    );

    const merged = new Map<string, Pending>();

    for (const row of stored.rows) {
      merged.set(`${row.server_id ?? ''}:${row.reason}`, {
        serverId: row.server_id,
        reason: row.reason,
        requests: Number(row.requests),
        lastAt: row.last_at,
      });
    }

    for (const [key, entry] of this.pending) {
      if (entry.serverId !== null && !serverIds.includes(entry.serverId)) continue;

      const existing = merged.get(key);

      merged.set(
        key,
        existing === undefined
          ? { ...entry }
          : {
              ...existing,
              requests: existing.requests + entry.requests,
              lastAt: entry.lastAt > existing.lastAt ? entry.lastAt : existing.lastAt,
            },
      );
    }

    return [...merged.values()]
      .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
      .map((entry) => ({
        serverId: entry.serverId,
        reason: entry.reason,
        requests: entry.requests,
        lastAt: entry.lastAt.toISOString(),
      }));
  }

  private restore(entry: Pending): void {
    const key = `${entry.serverId ?? ''}:${entry.reason}`;
    const existing = this.pending.get(key);

    if (existing === undefined) {
      this.pending.set(key, entry);
    } else {
      existing.requests += entry.requests;
      if (entry.lastAt > existing.lastAt) existing.lastAt = entry.lastAt;
    }
  }
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** The log the running API writes to. One per process, like the rate limiter. */
export const refusalLog = new RefusalLog();
