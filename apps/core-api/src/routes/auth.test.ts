import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { resetPassword, SESSION_COOKIE, userForSession } from '../accounts.ts';
import { resetDatabase } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { loginThrottle } from '../login-throttle.ts';
import { closePool, getPool } from '../db.ts';

const GOOD_PASSWORD = 'a reasonably long passphrase';

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return createApp().request(`/v1/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Pulls the session token out of a Set-Cookie header. */
function sessionToken(response: Response): string | undefined {
  return response.headers
    .get('set-cookie')
    ?.split(';')[0]
    ?.split('=')
    .slice(1)
    .join('=');
}

beforeEach(async () => {
  loginThrottle.reset();
  await resetDatabase();
  await getPool().query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('registering the first account', () => {
  it('creates it', async () => {
    const response = await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      user: { email: 'me@example.com' },
    });
  });

  it('hands over an API key, since that is what somebody came for', async () => {
    const body = (await (
      await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD })
    ).json()) as { apiKey: string; serverId: string };

    expect(body.apiKey).toMatch(/^mcps_/);
    expect(body.serverId).toEqual(expect.any(String));
  });

  it('signs the browser in at the same time', async () => {
    const response = await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD });

    const token = sessionToken(response);
    expect(token).toBeDefined();
    await expect(userForSession(token as string)).resolves.toMatchObject({
      email: 'me@example.com',
    });
  });

  it('keeps the session cookie away from scripts and other sites', async () => {
    const response = await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD });
    const header = response.headers.get('set-cookie') ?? '';

    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
  });

  it('stores the address lowercased, so one person cannot become two accounts', async () => {
    await post('/register', { email: 'Me@Example.COM', password: GOOD_PASSWORD });

    const result = await getPool().query<{ email: string }>('SELECT email FROM users');
    expect(result.rows[0]?.email).toBe('me@example.com');
  });

  it('never stores the password', async () => {
    await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD });

    const result = await getPool().query<{ password_hash: string }>(
      'SELECT password_hash FROM users',
    );
    expect(result.rows[0]?.password_hash).not.toContain('passphrase');
  });
});

describe('registering when an account already exists', () => {
  beforeEach(async () => {
    await post('/register', { email: 'first@example.com', password: GOOD_PASSWORD });
  });

  it('is refused', async () => {
    // A self-hosted instance that keeps accepting sign-ups hands its telemetry
    // to whoever finds the address.
    const response = await post('/register', { email: 'second@example.com', password: GOOD_PASSWORD });

    expect(response.status).toBe(403);
  });

  it('says to sign in instead', async () => {
    const response = await post('/register', { email: 'second@example.com', password: GOOD_PASSWORD });

    await expect(response.json()).resolves.toEqual({ error: expect.stringContaining('Sign in') });
  });

  it('is reported as closed', async () => {
    const response = await createApp().request('/v1/auth/status');

    await expect(response.json()).resolves.toMatchObject({ registrationOpen: false });
  });
});

describe('registering with details that will not do', () => {
  it.each([
    ['the address is not one', { email: 'nope', password: GOOD_PASSWORD }],
    ['the password is empty', { email: 'me@example.com', password: '' }],
  ])('refuses when %s', async (_label, body) => {
    expect((await post('/register', body)).status).toBe(400);
  });

  it.each([
    ['nothing is sent', {}],
    ['the password is missing', { email: 'me@example.com' }],
    ['the password is not text', { email: 'me@example.com', password: 12345 }],
  ])('refuses when %s', async (_label, body) => {
    expect((await post('/register', body)).status).toBe(400);
  });

  it('takes a short password: the owner chooses', async () => {
    expect((await post('/register', { email: 'me@example.com', password: 'abc' })).status).toBe(201);
  });

  it('creates nothing when it refuses', async () => {
    await post('/register', { email: 'me@example.com', password: '' });

    const result = await getPool().query('SELECT 1 FROM users');
    expect(result.rowCount).toBe(0);
  });
});

describe('signing in', () => {
  beforeEach(async () => {
    await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD });
    await getPool().query('DELETE FROM sessions');
  });

  it('works with the right details', async () => {
    const response = await post('/login', { email: 'me@example.com', password: GOOD_PASSWORD });

    expect(response.status).toBe(200);
    expect(sessionToken(response)).toBeDefined();
  });

  it('ignores the case of the address', async () => {
    expect((await post('/login', { email: 'ME@EXAMPLE.COM', password: GOOD_PASSWORD })).status).toBe(
      200,
    );
  });

  it.each([
    ['the password is wrong', { email: 'me@example.com', password: 'not the passphrase' }],
    ['there is no such account', { email: 'nobody@example.com', password: GOOD_PASSWORD }],
  ])('refuses when %s', async (_label, body) => {
    expect((await post('/login', body)).status).toBe(401);
  });

  it('answers the same way whether the account exists or the password was wrong', async () => {
    // Telling them apart is a way to find out who has an account here.
    const wrongPassword = await post('/login', {
      email: 'me@example.com',
      password: 'not the passphrase',
    });
    const noAccount = await post('/login', {
      email: 'nobody@example.com',
      password: GOOD_PASSWORD,
    });

    expect(wrongPassword.status).toBe(noAccount.status);
    await expect(wrongPassword.json()).resolves.toEqual(await noAccount.json());
  });

  it('issues a session that can be looked up', async () => {
    const token = sessionToken(await post('/login', {
      email: 'me@example.com',
      password: GOOD_PASSWORD,
    })) as string;

    await expect(userForSession(token)).resolves.toMatchObject({ email: 'me@example.com' });
  });
});

describe('signing out', () => {
  it('ends the session rather than only forgetting it', async () => {
    const token = sessionToken(
      await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD }),
    ) as string;

    await post('/logout', {}, `${SESSION_COOKIE}=${token}`);

    // A copied cookie must stop working too, which is the whole reason
    // sessions live in the database.
    await expect(userForSession(token)).resolves.toBeUndefined();
  });

  it('clears the cookie', async () => {
    const token = sessionToken(
      await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD }),
    ) as string;

    const response = await post('/logout', {}, `${SESSION_COOKIE}=${token}`);

    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('is harmless without a session', async () => {
    expect((await post('/logout', {})).status).toBe(200);
  });
});

describe('resetting a forgotten password from the server', () => {
  it('lets the new password in and the old one no more', async () => {
    await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD });

    const reset = await resetPassword();

    expect(reset?.email).toBe('me@example.com');
    expect(reset?.password.length).toBeGreaterThanOrEqual(24);
    expect((await post('/login', { email: 'me@example.com', password: reset?.password })).status).toBe(200);
    expect((await post('/login', { email: 'me@example.com', password: GOOD_PASSWORD })).status).toBe(401);
  });

  it('signs out every browser signed in with the old one', async () => {
    const token = sessionToken(await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD }));

    await resetPassword();

    expect(await userForSession(token ?? '')).toBeUndefined();
  });

  it('makes a different password each time', async () => {
    await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD });

    expect((await resetPassword())?.password).not.toBe((await resetPassword())?.password);
  });

  it('does nothing before there is an account', async () => {
    expect(await resetPassword()).toBeUndefined();
  });
});

describe('changing the password when signed in', () => {
  const NEW_PASSWORD = 'another long passphrase';

  async function signedUp(): Promise<string> {
    const token = sessionToken(await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD }));

    return `${SESSION_COOKIE}=${token}`;
  }

  function change(currentPassword: string, newPassword: string, cookie?: string): Promise<Response> {
    return post('/password', { currentPassword, newPassword }, cookie);
  }

  it('takes the new one and refuses the old one from then on', async () => {
    const cookie = await signedUp();

    expect((await change(GOOD_PASSWORD, NEW_PASSWORD, cookie)).status).toBe(200);
    expect((await post('/login', { email: 'me@example.com', password: NEW_PASSWORD })).status).toBe(200);
    expect((await post('/login', { email: 'me@example.com', password: GOOD_PASSWORD })).status).toBe(401);
  });

  it('keeps this browser signed in and signs every other one out', async () => {
    const cookie = await signedUp();
    const elsewhere = sessionToken(await post('/login', { email: 'me@example.com', password: GOOD_PASSWORD }));

    await change(GOOD_PASSWORD, NEW_PASSWORD, cookie);

    expect(await userForSession(cookie.split('=').slice(1).join('='))).toBeDefined();
    expect(await userForSession(elsewhere ?? '')).toBeUndefined();
  });

  it('needs the current password, so a browser left open cannot lock its owner out', async () => {
    const cookie = await signedUp();

    expect((await change('not it at all', NEW_PASSWORD, cookie)).status).toBe(403);
    expect((await post('/login', { email: 'me@example.com', password: GOOD_PASSWORD })).status).toBe(200);
  });

  it('takes any new one but an empty one', async () => {
    const cookie = await signedUp();

    expect((await change(GOOD_PASSWORD, '', cookie)).status).toBe(400);
    expect((await change(GOOD_PASSWORD, 'abc', cookie)).status).toBe(200);
  });

  it('is refused without a session', async () => {
    await signedUp();

    expect((await change(GOOD_PASSWORD, NEW_PASSWORD)).status).toBe(401);
  });
});

describe('guessing passwords', () => {
  beforeEach(async () => {
    await post('/register', { email: 'me@example.com', password: GOOD_PASSWORD });
  });

  it('stops checking after ten wrong ones, even the right one, and says when to come back', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post('/login', { email: 'me@example.com', password: `guess ${i}` })).status).toBe(401);
    }

    const refused = await post('/login', { email: 'me@example.com', password: GOOD_PASSWORD });

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('does not count signing in with the right one', async () => {
    for (let i = 0; i < 15; i++) {
      expect((await post('/login', { email: 'me@example.com', password: GOOD_PASSWORD })).status).toBe(200);
    }
  });
});
