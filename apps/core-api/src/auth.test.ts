import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiKey, resetDatabase } from '../test/fixtures.ts';
import { type AuthVariables, hashApiKey, requireApiKey } from './auth.ts';
import { closePool } from './db.ts';

/** A route that exists only to report what the middleware let through. */
function guardedApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('/guarded', requireApiKey());
  app.get('/guarded', (c) => c.json({ server: c.get('server') }));

  return app;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('requireApiKey with a usable key', () => {
  it('lets the request through', async () => {
    const { key } = await createApiKey();

    const response = await guardedApp().request('/guarded', {
      headers: { authorization: `Bearer ${key}` },
    });

    expect(response.status).toBe(200);
  });

  it('attaches the server the key belongs to', async () => {
    const { key, serverId, serverName } = await createApiKey({ serverName: 'Flights' });

    const response = await guardedApp().request('/guarded', {
      headers: { authorization: `Bearer ${key}` },
    });

    await expect(response.json()).resolves.toEqual({ server: { serverId, serverName } });
  });

  it('accepts the scheme in any casing', async () => {
    const { key } = await createApiKey();

    const response = await guardedApp().request('/guarded', {
      headers: { authorization: `bearer ${key}` },
    });

    expect(response.status).toBe(200);
  });

  it('tolerates extra spacing around the key', async () => {
    const { key } = await createApiKey();

    const response = await guardedApp().request('/guarded', {
      headers: { authorization: `Bearer   ${key}  ` },
    });

    expect(response.status).toBe(200);
  });
});

describe('requireApiKey without a usable key', () => {
  it.each([
    ['there is no header', undefined],
    ['the header is empty', ''],
    ['the scheme is missing', 'some-key'],
    ['the scheme is wrong', 'Basic some-key'],
    ['there is nothing after Bearer', 'Bearer'],
    ['the key is only spaces', 'Bearer    '],
  ])('refuses when %s', async (_label, authorization) => {
    const response = await guardedApp().request('/guarded', {
      headers: authorization === undefined ? {} : { authorization },
    });

    expect(response.status).toBe(401);
  });

  it('refuses a key that was never issued', async () => {
    const response = await guardedApp().request('/guarded', {
      headers: { authorization: 'Bearer mcps_test_never-existed' },
    });

    expect(response.status).toBe(401);
  });

  it('refuses a key that has been revoked', async () => {
    const { key } = await createApiKey({ revoked: true });

    const response = await guardedApp().request('/guarded', {
      headers: { authorization: `Bearer ${key}` },
    });

    expect(response.status).toBe(401);
  });

  it('answers the same way whether a key is unknown or revoked', async () => {
    // Telling them apart would confirm which keys once existed, and the
    // difference helps nobody who is allowed to be here.
    const { key } = await createApiKey({ revoked: true });

    const revoked = await guardedApp().request('/guarded', {
      headers: { authorization: `Bearer ${key}` },
    });
    const unknown = await guardedApp().request('/guarded', {
      headers: { authorization: 'Bearer mcps_test_never-existed' },
    });

    await expect(revoked.json()).resolves.toEqual(await unknown.json());
  });

  it('says how to send the key when none was sent', async () => {
    const response = await guardedApp().request('/guarded');

    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('Authorization: Bearer'),
    });
  });
});

describe('hashApiKey', () => {
  it('is deterministic, so a key can be looked up rather than searched for', () => {
    expect(hashApiKey('some-key')).toEqual(hashApiKey('some-key'));
  });

  it('gives different keys different hashes', () => {
    expect(hashApiKey('one')).not.toEqual(hashApiKey('two'));
  });

  it('never stores the key itself', () => {
    expect(hashApiKey('super-secret-key').toString('utf8')).not.toContain('super-secret-key');
  });

  it('refuses to run without a configured secret', () => {
    const saved = process.env['API_KEY_SECRET'];
    delete process.env['API_KEY_SECRET'];

    try {
      expect(() => hashApiKey('some-key')).toThrow(/API_KEY_SECRET is not set/);
    } finally {
      process.env['API_KEY_SECRET'] = saved;
    }
  });
});
