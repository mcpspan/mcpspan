import { randomUUID } from 'node:crypto';

import { createSession, SESSION_COOKIE } from '../src/accounts.ts';
import { hashApiKey } from '../src/auth.ts';
import { CALL_TABLES, type CallKind } from '../src/rollup.ts';
import { getPool } from '../src/db.ts';
import { hashPassword } from '../src/passwords.ts';

/** Empties every table, so each test starts from a known state. */
export async function resetDatabase(): Promise<void> {
  await getPool().query('TRUNCATE tool_calls, resource_calls, prompt_calls, api_keys, sessions, users CASCADE');
}

export interface TestApiKey {
  key: string;
  serverId: string;
  serverName: string;
  /** Set when the key was created for an account. */
  userId?: string;
}

export interface TestAccount extends TestApiKey {
  userId: string;
  email: string;
  /** Ready to put in a Cookie header. */
  cookie: string;
}

/**
 * An account with a server, signed in.
 *
 * What almost every dashboard test needs: the views are for a person reading
 * their own telemetry, so a test without an account is testing a state that
 * cannot happen.
 */
export async function createAccount(
  options: { email?: string; serverName?: string } = {},
): Promise<TestAccount> {
  const email = options.email ?? `tester-${randomUUID()}@example.com`;

  const user = await getPool().query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, await hashPassword('a reasonably long passphrase')],
  );

  const userId = user.rows[0]?.id as string;
  const key = await createApiKey({
    userId,
    ...(options.serverName === undefined ? {} : { serverName: options.serverName }),
  });
  const { token } = await createSession(userId);

  return { ...key, userId, email, cookie: `${SESSION_COOKIE}=${token}` };
}

/**
 * Writes an API key the way registration eventually will.
 *
 * Returns the key in the clear, which only ever happens at the moment of
 * creation: after this the database holds nothing but its hash.
 */
export async function createApiKey(
  options: { revoked?: boolean; serverName?: string; userId?: string } = {},
): Promise<TestApiKey> {
  const key = `mcps_test_${randomUUID()}`;
  const serverName = options.serverName ?? 'Test server';

  // The server first: a key points at one rather than describing it, and the
  // foreign key will not let it be otherwise.
  const server = await getPool().query<{ id: string }>(
    `INSERT INTO servers (user_id, name) VALUES ($1, $2) RETURNING id`,
    [options.userId ?? null, serverName],
  );
  const serverId = server.rows[0]?.id as string;

  await getPool().query(
    `INSERT INTO api_keys (key_hash, server_id, owner_email, revoked_at, user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      hashApiKey(key),
      serverId,
      'tester@example.com',
      options.revoked === true ? new Date() : null,
      options.userId ?? null,
    ],
  );

  return {
    key,
    serverId,
    serverName,
    ...(options.userId === undefined ? {} : { userId: options.userId }),
  };
}

export interface EventSeed {
  /** Chosen by the test when it needs to ask for this call by id. */
  id?: string;
  /** A tool call unless said otherwise; resources and prompts go to tables of their own. */
  kind?: CallKind;
  /** A tool's name, a resource's URI or template, a prompt's name. */
  toolName?: string;
  durationMs?: number;
  success?: boolean;
  errorSource?: string;
  errorType?: string;
  errorMessage?: string;
  clientType?: string;
  clientName?: string;
  occurredAt?: Date | string;
  sessionId?: string;
  parameters?: Record<string, string>;
  serverVersion?: string;
  clientVersion?: string;
}

/**
 * Writes tool calls straight into the table.
 *
 * Aggregation tests need events at chosen times with chosen outcomes, and
 * getting there through the SDK would mean waiting on a queue and accepting
 * whatever clock it read. The ingest path has its own tests; these are about
 * what the numbers come out as.
 */
export async function seedEvents(serverId: string, seeds: readonly EventSeed[]): Promise<void> {
  for (const seed of seeds) {
    const table = CALL_TABLES[seed.kind ?? 'tool'];
    await getPool().query(
      `INSERT INTO ${table.raw} (
         id, server_id, occurred_at, ${table.name}, duration_ms, success,
         error_source, error_type, error_message, client_type, client_name, sdk_version,
         session_id, parameters, server_version, client_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        seed.id ?? randomUUID(),
        serverId,
        seed.occurredAt ?? new Date(),
        seed.toolName ?? 'search_flights',
        seed.durationMs ?? 10,
        seed.success ?? true,
        seed.errorSource ?? null,
        seed.errorType ?? null,
        seed.errorMessage ?? null,
        seed.clientType ?? 'claude',
        seed.clientName ?? null,
        '0.1.0',
        seed.sessionId ?? null,
        seed.parameters === undefined ? null : JSON.stringify(seed.parameters),
        seed.serverVersion ?? null,
        seed.clientVersion ?? null,
      ],
    );

    // As ingest keeps it: when each version was first and last seen.
    if (seed.serverVersion !== undefined) {
      await getPool().query(
        `INSERT INTO server_versions (server_id, version, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (server_id, version) DO UPDATE SET
           first_seen_at = LEAST(server_versions.first_seen_at, EXCLUDED.first_seen_at),
           last_seen_at = GREATEST(server_versions.last_seen_at, EXCLUDED.last_seen_at)`,
        [serverId, seed.serverVersion, seed.occurredAt ?? new Date()],
      );
    }
  }

  await refreshRollup();
}

/**
 * Brings the hourly rollup up to date with what was just seeded.
 *
 * In a running installation a policy does this every half hour, and it is
 * never needed for the present: events arrive seconds after they happen, which
 * puts them past the materialization watermark, where reads pick them up from
 * the raw table without waiting for anything.
 *
 * Seeded events are the opposite case by design. They carry timestamps hours
 * or days old, which lands them behind the watermark, in buckets the view
 * already considers settled. TimescaleDB records that those buckets are stale
 * and corrects them on the next refresh; without this call a test would read
 * the state before its own setup and fail for a reason that has nothing to do
 * with what it was testing.
 */
async function refreshRollup(): Promise<void> {
  for (const { rollup } of Object.values(CALL_TABLES)) {
    await getPool().query(`CALL refresh_continuous_aggregate('${rollup}', NULL, NULL)`);
  }
}
