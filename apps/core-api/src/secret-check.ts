import { createHmac } from 'node:crypto';

import { getPool } from './db.ts';

/** Where the fingerprint lives, and what is hashed to produce it. */
const SETTING_KEY = 'api_key_secret_fingerprint';

/**
 * When the secret last changed under this database. Written only on a change,
 * never on first start, so an installation that has always had one secret has
 * no entry and no key is ever wrongly reported as broken.
 */
export const CHANGED_AT_KEY = 'api_key_secret_changed_at';
const CANARY = 'mcpspan api key secret fingerprint v1';

/**
 * A value derived from the secret that reveals nothing about it.
 *
 * An HMAC of a fixed string, so two installations with the same secret produce
 * the same fingerprint and nobody holding the fingerprint can work backwards
 * to the secret. It is stored beside the data it protects, which is safe for
 * the same reason storing a password hash is.
 */
export function fingerprintOf(secret: string): string {
  return createHmac('sha256', secret).update(CANARY).digest('hex');
}

/**
 * Notices when the signing secret has changed under an existing database.
 *
 * API keys are stored as HMACs of API_KEY_SECRET. Change it and every key in
 * the database becomes unverifiable at once, while the keys themselves look
 * perfectly fine and the API answers each one with the same flat refusal it
 * gives an invented key. Nothing says why. Every server goes quiet and the
 * person running it has no thread to pull.
 *
 * This is not hypothetical and it is not rare: it is what a restore does when
 * the dump is brought back without the .env beside it, which is the single
 * easiest mistake to make with a backup.
 *
 * A warning rather than a refusal to start. Somebody deliberately rotating the
 * secret and reissuing keys is doing a reasonable thing, and a dashboard that
 * will not open is a poor way to be told about it.
 */
export async function checkSigningSecret(secret: string): Promise<void> {
  const fingerprint = fingerprintOf(secret);

  const stored = await getPool().query<{ value: string }>(
    'SELECT value FROM settings WHERE key = $1',
    [SETTING_KEY],
  );

  const previous = stored.rows[0]?.value;

  if (previous === undefined) {
    // First start, or an installation from before this check existed. Record
    // what is in use now; there is nothing yet to compare against.
    await getPool().query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [SETTING_KEY, fingerprint],
    );

    return;
  }

  if (previous === fingerprint) return;

  const keys = await getPool().query<{ count: string }>(
    'SELECT count(*) AS count FROM api_keys WHERE revoked_at IS NULL',
  );
  const affected = Number(keys.rows[0]?.count ?? 0);

  console.error(
    `mcpspan core-api: API_KEY_SECRET is not the one this database was built with. ` +
      `${affected} API key${affected === 1 ? '' : 's'} in it can no longer be verified, and ` +
      `every server using one will be refused without being told why. If this follows a ` +
      `restore, put back the .env that came with the dump. If you changed it on purpose, ` +
      `generate a new key for each server and redeploy.`,
  );

  // Recorded either way, so the warning is given once per change rather than
  // on every restart forever. Somebody who meant it should not be nagged, and
  // somebody who did not has already been told.
  await getPool().query(
    `UPDATE settings SET value = $2, updated_at = now() WHERE key = $1`,
    [SETTING_KEY, fingerprint],
  );

  // For the diagnostics view, which outlives the log line above: every key
  // issued before this moment was hashed with the old secret and cannot work.
  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ($1, now()::text)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [CHANGED_AT_KEY],
  );
}
