import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import pg from 'pg';

const run = promisify(execFile);

/**
 * Where integration tests write.
 *
 * A database of its own, never the one a developer is looking at: these tests
 * empty the tables between cases, and doing that to somebody's working data
 * would be a memorable way to lose an afternoon.
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://mcpspan:mcpspan@localhost:6272/mcpspan_test';

/**
 * Creates the test database if this machine does not have one yet.
 *
 * `docker compose up -d db` creates the application's database and nothing
 * else, so on a fresh clone the first `pnpm test` would fail on a missing
 * database rather than on anything to do with the code. Creating it here keeps
 * that prerequisite with the suite that needs it, instead of adding an empty
 * database named "test" to every self-hosted installation.
 */
async function createTestDatabaseIfMissing(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);

  // Connecting to the maintenance database, because CREATE DATABASE cannot be
  // run from inside the database it is creating.
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });

  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    // Identifiers cannot be parameterised, so the name is quoted instead. It
    // comes from a URL this repository controls, not from user input.
    if (existing.rowCount === 0) await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } finally {
    await client.end();
  }
}

/**
 * Brings the test database up to the current schema.
 *
 * Runs the same migrations as production rather than a hand-written schema
 * kept alongside them. A test schema that drifts from the real one tests the
 * wrong thing, and does it convincingly.
 */
export async function migrateTestDatabase(): Promise<void> {
  await createTestDatabaseIfMissing();

  await run('./node_modules/.bin/node-pg-migrate', ['up'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
