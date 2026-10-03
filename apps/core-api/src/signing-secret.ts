import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Where the API key signing secret comes from: `API_KEY_SECRET` when set,
 * otherwise a file the API makes itself on first start.
 *
 * The file is what lets `docker compose up -d` be the whole installation: no
 * `.env` to copy and no command to generate a secret with, which not every
 * machine has. It lives on its own volume rather than in the database, so a
 * copy of the database alone still cannot be used to make keys that verify.
 * Losing it while keeping the database makes every key unverifiable, which the
 * API reports at start (see secret-check.ts) rather than failing silently.
 *
 * Returns what to use, or a reason there is none. Sets `API_KEY_SECRET` for
 * the rest of the process, so everything reading it sees the same value.
 */
export function loadSigningSecret(
  env: NodeJS.ProcessEnv = process.env,
): { secret: string; generated: boolean } | { problem: string } {
  const given = env['API_KEY_SECRET']?.trim();
  if (given) return { secret: given, generated: false };

  const file = env['MCPSPAN_SECRET_FILE']?.trim();
  if (!file) {
    return {
      problem:
        'API_KEY_SECRET is not set. Generate one with: openssl rand -hex 32, and put it in .env',
    };
  }

  try {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored) {
      env['API_KEY_SECRET'] = stored;
      return { secret: stored, generated: false };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { problem: `Could not read the signing secret from ${file}: ${describe(error)}` };
    }
  }

  const secret = randomBytes(32).toString('hex');
  try {
    // Created only if absent, and readable by nobody else.
    writeFileSync(file, `${secret}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Two starts racing: the other one wrote it first, and its secret is the one.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadSigningSecret(env);

    return { problem: `Could not store a new signing secret in ${file}: ${describe(error)}` };
  }

  env['API_KEY_SECRET'] = secret;
  return { secret, generated: true };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
