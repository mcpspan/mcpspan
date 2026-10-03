import { readFileSync } from 'node:fs';

import { getPool } from './db.ts';
import { openTelemetryTargets } from './otel.ts';
import type { RefusalCount, RefusalLog } from './refusals.ts';
import { currentRetentionDays } from './retention.ts';
import { CHANGED_AT_KEY } from './secret-check.ts';
import { listServers, type ServerRecord } from './servers.ts';

/**
 * This API's version, read once from its own package.json.
 *
 * Read from the file rather than imported, so it works the same whether Node
 * is stripping types from the repository or running inside the image, where
 * the file sits beside the sources.
 */
export const API_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

interface LastEvent {
  /** When the call happened, by the reporting machine's clock. */
  occurredAt: string;
  /** When it reached us, by ours. */
  receivedAt: string;
  sdkVersion: string;
}

interface LastContact {
  /** When the SDK last reached us with this server's key, to within a minute. */
  at: string;
  /** Null when whatever reached us did not name itself as our SDK. */
  sdkVersion: string | null;
}

interface ServerHealth extends ServerRecord {
  /** The most recent call recorded, or null if nothing within retention. */
  lastEvent: LastEvent | null;
  /**
   * The SDK reaching us at all, tool call or not. It announces itself when it
   * starts, so this is set before anything has been called.
   */
  lastContact: LastContact | null;
}

export interface Diagnostics {
  versions: {
    api: string;
    postgres: string;
    timescaledb: string | null;
  };
  storage: {
    databaseBytes: number;
    oldestEventAt: string | null;
    retentionDays: number | null;
    rollupRetentionDays: number | null;
    /** Where calls are forwarded as well, over OTLP; null when they are not. */
    openTelemetry: string[] | null;
  };
  /**
   * Set once API_KEY_SECRET has changed under this database. `staleServerIds`
   * are the account's servers whose live key was issued before that, and so
   * can no longer be verified.
   */
  signingSecret: { changedAt: string; staleServerIds: string[] } | null;
  servers: ServerHealth[];
  refusals: RefusalCount[];
}

/**
 * Everything needed to tell why a dashboard is empty.
 *
 * An empty dashboard looks the same whether nothing has called a tool, the SDK
 * points somewhere else, its key is refused, or the database is gone. Each of
 * those leaves a different trace, and this gathers them in one place. The last
 * one leaves none here, since this needs the database to answer: it is told
 * apart by this request failing with a 503 that says so.
 *
 * Storage and versions describe the installation rather than the account.
 * A self-hosted install has one account, so that is the same thing; a hosted
 * version would have to leave them out.
 */
export async function getDiagnostics(
  userId: string,
  serverIds: readonly string[],
  refusals: RefusalLog,
): Promise<Diagnostics> {
  const pool = getPool();

  // All at once. None depends on another, and this page is most often opened
  // by somebody who already suspects something is slow or broken.
  const [
    versions,
    size,
    oldest,
    retention,
    rollupRetention,
    secret,
    servers,
    lastEvents,
    contacts,
    counts,
  ] = await Promise.all([
    pool.query<{ postgres: string; timescaledb: string | null }>(
      `SELECT current_setting('server_version') AS postgres,
              (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') AS timescaledb`,
    ),
    pool.query<{ bytes: string }>(`SELECT pg_database_size(current_database()) AS bytes`),
    // Ordered by the column the hypertable is partitioned on, so this reads
    // the first row of the oldest chunk rather than scanning.
    pool.query<{ occurred_at: Date }>(
      `SELECT occurred_at FROM tool_calls ORDER BY occurred_at LIMIT 1`,
    ),
    currentRetentionDays('tool_calls'),
    currentRetentionDays('tool_calls_hourly'),
    signingSecretChange(serverIds),
    listServers(userId),
    lastEventPerServer(serverIds),
    lastContactPerServer(serverIds),
    refusals.counts(serverIds),
  ]);

  const version = versions.rows[0];

  return {
    versions: {
      api: API_VERSION,
      postgres: version?.postgres ?? 'unknown',
      timescaledb: version?.timescaledb ?? null,
    },
    storage: {
      databaseBytes: Number(size.rows[0]?.bytes ?? 0),
      oldestEventAt: oldest.rows[0]?.occurred_at.toISOString() ?? null,
      retentionDays: retention ?? null,
      rollupRetentionDays: rollupRetention ?? null,
      openTelemetry: openTelemetryTargets(),
    },
    signingSecret: secret,
    servers: servers.map((server) => ({
      ...server,
      lastEvent: lastEvents.get(server.id) ?? null,
      lastContact: contacts.get(server.id) ?? null,
    })),
    refusals: counts,
  };
}

/** When each server's SDK last reached us, from the servers table itself. */
async function lastContactPerServer(
  serverIds: readonly string[],
): Promise<Map<string, LastContact>> {
  const result = await getPool().query<{
    id: string;
    last_contact_at: Date;
    last_sdk_version: string | null;
  }>(
    `SELECT id, last_contact_at, last_sdk_version
     FROM servers
     WHERE id = ANY($1::uuid[]) AND last_contact_at IS NOT NULL`,
    [serverIds],
  );

  return new Map(
    result.rows.map((row) => [
      row.id,
      { at: row.last_contact_at.toISOString(), sdkVersion: row.last_sdk_version },
    ]),
  );
}

/** The newest call per server, one index probe each. */
async function lastEventPerServer(serverIds: readonly string[]): Promise<Map<string, LastEvent>> {
  const result = await getPool().query<{
    server_id: string;
    occurred_at: Date;
    received_at: Date;
    sdk_version: string;
  }>(
    `SELECT s.id AS server_id, last.occurred_at, last.received_at, last.sdk_version
     FROM unnest($1::uuid[]) AS s (id)
     CROSS JOIN LATERAL (
       SELECT occurred_at, received_at, sdk_version
       FROM tool_calls t
       WHERE t.server_id = s.id
       ORDER BY occurred_at DESC
       LIMIT 1
     ) AS last`,
    [serverIds],
  );

  return new Map(
    result.rows.map((row) => [
      row.server_id,
      {
        occurredAt: row.occurred_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
        sdkVersion: row.sdk_version,
      },
    ]),
  );
}

/**
 * When the signing secret changed, and which servers' live keys it broke.
 *
 * Counted rather than guessed: a key issued before the change was hashed with
 * the old secret, and one issued after with the new, so the creation time
 * says exactly which ones can no longer be verified.
 */
async function signingSecretChange(
  serverIds: readonly string[],
): Promise<Diagnostics['signingSecret']> {
  const result = await getPool().query<{ changed_at: Date; stale_server_ids: string[] }>(
    `SELECT st.value::timestamptz AS changed_at,
            ARRAY(
              SELECT DISTINCT k.server_id FROM api_keys k
              WHERE k.server_id = ANY($2::uuid[])
                AND k.revoked_at IS NULL
                AND k.created_at < st.value::timestamptz
            ) AS stale_server_ids
     FROM settings st
     WHERE st.key = $1`,
    [CHANGED_AT_KEY, serverIds],
  );

  const row = result.rows[0];

  return row === undefined
    ? null
    : { changedAt: row.changed_at.toISOString(), staleServerIds: row.stale_server_ids };
}
