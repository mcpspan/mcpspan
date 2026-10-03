import { createHash, randomBytes } from 'node:crypto';

import { getPool } from './db.ts';
import { hashPassword, verifyPassword } from './passwords.ts';

/** How long a browser stays signed in. */
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** The cookie the session token travels in. */
export const SESSION_COOKIE = 'mcpspan_session';

export interface User {
  id: string;
  email: string;
}

export type RegisterResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'closed' | 'taken' | 'invalid-email' | 'empty-password' };

/**
 * Whether anybody has signed up yet.
 *
 * Registration on a self-hosted install is a first-run step, not a standing
 * invitation: an instance that keeps accepting sign-ups hands its telemetry to
 * whoever finds the address.
 */
export async function isRegistrationOpen(): Promise<boolean> {
  const result = await getPool().query<{ count: string }>('SELECT count(*) FROM users');

  return Number(result.rows[0]?.count ?? 0) === 0;
}

/** Deliberately loose; see the sign-in form for why. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function register(email: string, password: string): Promise<RegisterResult> {
  const normalised = email.trim().toLowerCase();

  if (!LOOKS_LIKE_EMAIL.test(normalised)) return { ok: false, reason: 'invalid-email' };
  // Any password will do: on a self-hosted install it is the owner's to choose.
  if (password.length === 0) return { ok: false, reason: 'empty-password' };
  if (!(await isRegistrationOpen())) return { ok: false, reason: 'closed' };

  try {
    const result = await getPool().query<{ id: string; email: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [normalised, await hashPassword(password)],
    );

    const row = result.rows[0];

    return row ? { ok: true, user: row } : { ok: false, reason: 'taken' };
  } catch (error) {
    // Two sign-ups racing each other: the unique index decides, and the loser
    // is told the address is taken rather than shown a server error.
    if (isUniqueViolation(error)) return { ok: false, reason: 'taken' };

    throw error;
  }
}

/**
 * Checks a sign-in.
 *
 * An unknown address and a wrong password take the same path and produce the
 * same answer. Skipping the hash for an address that does not exist would
 * make it answer faster, and that difference is enough to find out which
 * addresses have accounts.
 */
export async function authenticate(email: string, password: string): Promise<User | undefined> {
  const result = await getPool().query<{ id: string; email: string; password_hash: string }>(
    'SELECT id, email, password_hash FROM users WHERE email = $1',
    [email.trim().toLowerCase()],
  );

  const row = result.rows[0];
  const stored = row?.password_hash ?? DUMMY_HASH;
  const matches = await verifyPassword(password, stored);

  return row && matches ? { id: row.id, email: row.email } : undefined;
}

/**
 * A hash to compare against when no account exists.
 *
 * Real in shape and impossible to match, so the work of checking a password
 * happens whether or not the address is known.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: 'wrong-password' | 'empty-password' };

/**
 * Changes the password of somebody signed in, who has to know the current one:
 * a browser left signed in is not enough to lock its owner out.
 *
 * Every other session ends, so a browser somewhere else signed in with the old
 * password goes with it; the one making the change stays signed in.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepToken: string,
): Promise<ChangePasswordResult> {
  const result = await getPool().query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );
  const stored = result.rows[0]?.password_hash ?? DUMMY_HASH;

  if (!(await verifyPassword(currentPassword, stored))) {
    return { ok: false, reason: 'wrong-password' };
  }
  if (newPassword.length === 0) return { ok: false, reason: 'empty-password' };

  await getPool().query(
    `WITH updated AS (
       UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id
     )
     DELETE FROM sessions WHERE user_id IN (SELECT id FROM updated) AND token_hash <> $3`,
    [userId, await hashPassword(newPassword), hashToken(keepToken)],
  );

  return { ok: true };
}

/**
 * Gives the account a new password, made here, and signs it out everywhere.
 *
 * For whoever runs the installation and has forgotten the password: there is
 * no mail to send a link with, and whoever can run a command on the server
 * owns its data anyway. The password is made rather than asked for so it never
 * passes through a command line or a shell history, and every session ends so
 * a browser somebody else left signed in goes with the old password. None
 * when there is no account yet.
 */
export async function resetPassword(): Promise<{ email: string; password: string } | undefined> {
  const password = randomBytes(18).toString('base64url');

  const result = await getPool().query<{ email: string }>(
    `WITH owner AS (
       SELECT id FROM users ORDER BY created_at LIMIT 1
     ), updated AS (
       UPDATE users SET password_hash = $1
       FROM owner
       WHERE users.id = owner.id
       RETURNING users.id, users.email
     ), ended AS (
       DELETE FROM sessions WHERE user_id IN (SELECT id FROM updated)
     )
     SELECT email FROM updated`,
    [await hashPassword(password)],
  );

  const row = result.rows[0];

  return row && { email: row.email, password };
}

export interface IssuedSession {
  /** Goes to the browser. Never stored. */
  token: string;
  expiresAt: Date;
}

export async function createSession(userId: string): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

  await getPool().query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), userId, expiresAt],
  );

  return { token, expiresAt };
}

/** Who a session token belongs to, if it is still good for anything. */
export async function userForSession(token: string): Promise<User | undefined> {
  const result = await getPool().query<{ id: string; email: string }>(
    `SELECT users.id, users.email
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1
       AND sessions.expires_at > now()`,
    [hashToken(token)],
  );

  return result.rows[0];
}

/** Ends one session. What signing out does. */
export async function endSession(token: string): Promise<void> {
  await getPool().query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/**
 * Removes sessions that have run out.
 *
 * Expired rows are already refused on the way in, so this is housekeeping
 * rather than security: without it the table only ever grows.
 */
export async function sweepExpiredSessions(): Promise<number> {
  const result = await getPool().query('DELETE FROM sessions WHERE expires_at <= now()');

  return result.rowCount ?? 0;
}

/**
 * Plain SHA-256, with no secret mixed in.
 *
 * Unlike an API key, a session token is ours: it is generated here from 32
 * random bytes, never chosen by a person, and never seen outside this system.
 * There is nothing to guess and no word list to defend against, so the hash is
 * only there to keep the stored form from being usable.
 */
function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
