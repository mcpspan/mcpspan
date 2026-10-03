import { getPool } from './db.ts';

/**
 * How often one server's contact is written down.
 *
 * The status page needs "is this SDK reaching us", not a record of every
 * batch, and a busy server sends one every few seconds. A minute is fresh
 * enough to answer that and keeps it to one small write per server per minute.
 */
const WRITE_EVERY_MS = 60_000;

/**
 * An SDK names itself in the User-Agent as `mcpspan/<version> (<language>)`,
 * the language being optional. See docs/sdk-contract.md.
 */
const SDK_AGENT = /^mcpspan\/([\w.+-]{1,50})(?:\s|$)/;

interface Written {
  at: number;
  version: string | null;
}

/**
 * Remembers when each server's SDK last reached the ingest endpoint.
 *
 * Fed by every request that carried a valid key, including the empty batch the
 * SDK sends when it starts. Only authenticated requests get here, so the map
 * holds at most one entry per server, whoever is sending.
 *
 * The write is never awaited by the request. Telling the status page about a
 * contact is not worth making the SDK wait, and not worth failing its batch
 * over when the database is having a moment.
 */
export class ContactLog {
  private readonly written = new Map<string, Written>();

  private readonly now: () => number;

  // Assigned in the body: Node strips types from this file, and a parameter
  // property emits code.
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Notes a contact, writing it down if the last write is old or the SDK
   * version changed. Returns the write, for tests; callers do not wait on it.
   */
  touch(serverId: string, userAgent: string | undefined): Promise<void> {
    const at = this.now();
    const version = userAgent?.match(SDK_AGENT)?.[1] ?? null;
    const previous = this.written.get(serverId);

    // A new version is written at once, even inside the minute: a redeploy is
    // exactly when somebody opens the status page to check it took.
    if (
      previous !== undefined &&
      at - previous.at < WRITE_EVERY_MS &&
      (version === null || version === previous.version)
    ) {
      return Promise.resolve();
    }

    this.written.set(serverId, { at, version: version ?? previous?.version ?? null });

    return getPool()
      .query(
        `UPDATE servers
         SET last_contact_at = $2,
             last_sdk_version = COALESCE($3, last_sdk_version)
         WHERE id = $1`,
        [serverId, new Date(at), version],
      )
      .then(
        () => undefined,
        () => {
          // Forgotten, so the next request tries again rather than waiting
          // out a minute that was never written.
          this.written.delete(serverId);
        },
      );
  }
}

/** The log the running API writes to. */
export const contactLog = new ContactLog();
