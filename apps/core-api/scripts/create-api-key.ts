/**
 * Issues an API key from the command line.
 *
 * Exists so that trying the SDK against a local backend does not require going
 * through the dashboard, and does not require writing SQL by hand either.
 *
 * The key is attached to the account if there is one, which in a self-hosted
 * installation means the only one. Without an account the server it creates
 * still accepts events; it simply appears nowhere until somebody registers.
 *
 *   pnpm --filter @mcpspan/core-api key:create "My server" me@example.com
 */
import { issueApiKey } from '../src/api-key.ts';
import { closePool, getPool } from '../src/db.ts';
import { createServer } from '../src/servers.ts';

const [serverName = 'Local server', ownerEmail = 'local@example.com'] = process.argv.slice(2);

try {
  const account = await getPool().query<{ id: string; email: string }>(
    'SELECT id, email FROM users ORDER BY created_at LIMIT 1',
  );
  const owner = account.rows[0];

  const server = await createServer(owner?.id ?? null, serverName);
  const { key } = await issueApiKey({
    serverId: server.id,
    ownerEmail: owner?.email ?? ownerEmail,
    ...(owner === undefined ? {} : { userId: owner.id }),
  });

  console.log(`\nServer:  ${server.name}  (${server.id})`);
  console.log(`API key: ${key}`);
  console.log(
    owner === undefined
      ? '\nNo account exists yet, so this server is not shown in the dashboard.'
      : `\nAttached to ${owner.email}.`,
  );
  console.log('\nThis is the only time the key is shown. Only its hash is stored.\n');
} catch (error) {
  console.error(
    `Could not create the key: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
