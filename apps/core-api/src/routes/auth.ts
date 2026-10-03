import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import {
  authenticate,
  changePassword,
  createSession,
  endSession,
  isRegistrationOpen,
  register,
  SESSION_COOKIE,
  userForSession,
} from '../accounts.ts';
import { issueApiKey } from '../api-key.ts';
import { loginThrottle, type LoginThrottle } from '../login-throttle.ts';
import { createServer } from '../servers.ts';

interface Credentials {
  email?: unknown;
  password?: unknown;
  serverName?: unknown;
}

/**
 * Signing up, in, and out.
 *
 * Registration is a first-run step rather than a standing invitation: a
 * self-hosted instance that keeps accepting sign-ups hands its telemetry to
 * whoever finds the address.
 */
export function createAuthRoutes(throttle: LoginThrottle = loginThrottle) {
  const app = new Hono();

  /** Lets the sign-in page know whether to offer signing up at all. */
  app.get('/status', async (c) => {
    const [open, signedIn] = await Promise.all([
      isRegistrationOpen(),
      currentUser(c.req.header('cookie')),
    ]);

    return c.json({ registrationOpen: open, signedIn: signedIn !== undefined });
  });

  app.post('/register', async (c) => {
    const body = await readCredentials(c.req.raw);

    if (body === undefined) return c.json({ error: 'Send an email and a password' }, 400);

    const result = await register(body.email, body.password);

    if (!result.ok) return c.json({ error: explainRegistration(result.reason) }, refusalStatus(result.reason));

    // The first key comes with the account. Somebody who has just signed up
    // wants to connect a server, and making them find a second button first
    // is a step with nothing behind it.
    const server = await createServer(
      result.user.id,
      typeof body.serverName === 'string' && body.serverName.trim().length > 0
        ? body.serverName.trim()
        : 'My server',
    );

    const key = await issueApiKey({
      serverId: server.id,
      ownerEmail: result.user.email,
      userId: result.user.id,
    });

    await startSession(c, result.user.id);

    // The only time the key is readable. After this the database holds a hash.
    return c.json({ user: result.user, apiKey: key.key, serverId: key.serverId }, 201);
  });

  app.post('/login', async (c) => {
    const body = await readCredentials(c.req.raw);

    if (body === undefined) return c.json({ error: 'Send an email and a password' }, 400);

    // Refused before the password is checked, right or wrong: checking it and
    // answering differently would tell a guesser when they had it.
    const wait = throttle.retryAfterSeconds();
    if (wait > 0) return tooManyTries(c, wait);

    const user = await authenticate(body.email, body.password);

    if (user === undefined) {
      throttle.recordFailure();

      // One answer for a wrong password and for an address with no account.
      // Telling them apart is a way to find out who has an account here.
      return c.json({ error: 'Those details do not match an account' }, 401);
    }

    await startSession(c, user.id);

    return c.json({ user });
  });

  app.post('/password', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token === undefined ? undefined : await userForSession(token);

    if (token === undefined || user === undefined) return c.json({ error: 'Sign in first' }, 401);

    const body = (await c.req.json().catch(() => undefined)) as
      | { currentPassword?: unknown; newPassword?: unknown }
      | undefined;

    if (typeof body?.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      return c.json({ error: 'Send the current password and a new one' }, 400);
    }

    // The current password is a password to guess like any other.
    const wait = throttle.retryAfterSeconds();
    if (wait > 0) return tooManyTries(c, wait);

    const result = await changePassword(user.id, body.currentPassword, body.newPassword, token);

    if (!result.ok && result.reason === 'wrong-password') throttle.recordFailure();
    if (!result.ok) {
      return result.reason === 'wrong-password'
        ? c.json({ error: 'That is not the current password' }, 403)
        : c.json({ error: 'Enter a new password' }, 400);
    }

    return c.json({ ok: true });
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);

    // Ended in the database, not just forgotten by the browser. Clearing the
    // cookie alone leaves a copied token working until it expires.
    if (token !== undefined) await endSession(token);

    deleteCookie(c, SESSION_COOKIE, { path: '/' });

    return c.json({ ok: true });
  });

  return app;
}

function tooManyTries(c: Context, seconds: number) {
  c.header('Retry-After', String(seconds));

  return c.json({ error: `Too many wrong passwords. Try again in ${seconds} seconds.` }, 429);
}

async function startSession(c: Context, userId: string): Promise<void> {
  const { token, expiresAt } = await createSession(userId);

  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    // Unreadable to scripts, so a cross-site scripting hole in the dashboard
    // cannot hand somebody's session to another page.
    httpOnly: true,
    // Sent on ordinary navigation but not on requests another site makes,
    // which is what stops a link somewhere else acting as this user.
    sameSite: 'Lax',
    // Only over HTTPS when the request arrived that way. Insisting on it
    // unconditionally would break every install running on localhost.
    secure: isSecureRequest(c.req.raw),
    expires: expiresAt,
  });
}

function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');

  return forwarded === 'https' || new URL(request.url).protocol === 'https:';
}

async function currentUser(cookieHeader: string | undefined) {
  const token = cookieHeader
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === SESSION_COOKIE)?.[1];

  return token === undefined ? undefined : userForSession(token);
}

async function readCredentials(
  request: Request,
): Promise<{ email: string; password: string; serverName?: string } | undefined> {
  const body = (await request.json().catch(() => undefined)) as Credentials | undefined;

  if (typeof body?.email !== 'string' || typeof body.password !== 'string') return undefined;

  return {
    email: body.email,
    password: body.password,
    ...(typeof body.serverName === 'string' ? { serverName: body.serverName } : {}),
  };
}

function explainRegistration(reason: 'closed' | 'taken' | 'invalid-email' | 'empty-password'): string {
  switch (reason) {
    case 'closed':
      return 'This installation already has an account. Sign in instead.';
    case 'taken':
      return 'That email address is already registered';
    case 'invalid-email':
      return 'That does not look like an email address';
    case 'empty-password':
      return 'Enter a password';
  }
}

function refusalStatus(reason: 'closed' | 'taken' | 'invalid-email' | 'empty-password'): 400 | 403 | 409 {
  if (reason === 'closed') return 403;
  if (reason === 'taken') return 409;

  return 400;
}
