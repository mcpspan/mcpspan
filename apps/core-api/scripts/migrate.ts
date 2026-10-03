/**
 * Runs database migrations with the repository's .env loaded.
 *
 * The obvious spelling, `node ./node_modules/.bin/node-pg-migrate up`, does
 * not work: pnpm writes that entry as a shell shim, so Node is handed a shell
 * script and fails to parse line two of it. The shim runs perfectly well on
 * its own, but then nothing has loaded .env and the migration has no database
 * to connect to.
 *
 * So Node starts, reads .env, and hands over. The child inherits the
 * environment, which is the only reason this file exists.
 *
 *   pnpm --filter @mcpspan/core-api migrate
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync('./node_modules/.bin/node-pg-migrate', process.argv.slice(2), {
  stdio: 'inherit',
});

if (result.error !== undefined) {
  console.error(`Could not start node-pg-migrate: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
