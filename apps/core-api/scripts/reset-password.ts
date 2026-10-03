/**
 * Gives the account a new password, for whoever runs the installation and has
 * forgotten it. Every browser signed in is signed out.
 *
 *   docker compose exec api node scripts/reset-password.ts
 */
import { resetPassword } from '../src/accounts.ts';
import { closePool } from '../src/db.ts';

try {
  const reset = await resetPassword();

  if (reset === undefined) {
    console.log('\nNo account exists yet. Open the dashboard to create it.\n');
  } else {
    console.log(`\nAccount:  ${reset.email}`);
    console.log(`Password: ${reset.password}`);
    console.log('\nThis is the only time it is shown. Every session has been signed out.\n');
  }
} catch (error) {
  console.error(
    `Could not reset the password: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
