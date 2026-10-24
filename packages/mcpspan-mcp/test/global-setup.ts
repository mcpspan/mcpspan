import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';

import { TEST_DATABASE_URL } from './database.ts';

const run = promisify(execFile);

/** The core API, whose migrations make the schema these tests read through. */
const core = fileURLToPath(new URL('../../../apps/core-api/', import.meta.url));

/**
 * A database of this suite's own, on the current schema: the core's suite
 * empties its tables between cases, and `pnpm -r test` may run both at once.
 */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);

  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });

  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount === 0) await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } finally {
    await client.end();
  }

  await run('./node_modules/.bin/node-pg-migrate', ['up'], {
    cwd: core,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
