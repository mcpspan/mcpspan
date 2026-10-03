import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDatabase } from '../test/fixtures.ts';
import { closePool, getPool } from './db.ts';
import { CHANGED_AT_KEY, checkSigningSecret, fingerprintOf } from './secret-check.ts';

async function storedFingerprint(): Promise<string | undefined> {
  const result = await getPool().query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'api_key_secret_fingerprint'",
  );

  return result.rows[0]?.value;
}

beforeEach(async () => {
  await resetDatabase();
  await getPool().query('DELETE FROM settings');
});

afterAll(async () => {
  await closePool();
});

describe('fingerprintOf', () => {
  it('gives the same answer for the same secret', () => {
    expect(fingerprintOf('a-secret')).toBe(fingerprintOf('a-secret'));
  });

  it('gives a different one for a different secret', () => {
    expect(fingerprintOf('a-secret')).not.toBe(fingerprintOf('another-secret'));
  });

  it('does not contain the secret', () => {
    // Stored beside the data it protects, so it has to be safe to read.
    expect(fingerprintOf('hunter2-is-the-secret')).not.toContain('hunter2');
  });
});

describe('checkSigningSecret', () => {
  it('records the secret in use the first time it runs', async () => {
    await checkSigningSecret('first-secret');

    expect(await storedFingerprint()).toBe(fingerprintOf('first-secret'));
  });

  it('says nothing when the secret has not changed', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {});

    await checkSigningSecret('steady-secret');
    await checkSigningSecret('steady-secret');

    expect(complained).not.toHaveBeenCalled();

    complained.mockRestore();
  });

  it('says so, loudly and specifically, when it has', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {});

    await checkSigningSecret('the-original');
    await checkSigningSecret('a-different-one');

    expect(complained).toHaveBeenCalledOnce();

    const said = String(complained.mock.calls[0]?.[0]);

    // The three things somebody needs: what is wrong, what it costs them, and
    // what to do. A bare "secret mismatch" would leave them guessing at all
    // three while every one of their servers reports nothing.
    expect(said).toContain('API_KEY_SECRET');
    expect(said).toContain('can no longer be verified');
    expect(said).toContain('.env');

    complained.mockRestore();
  });

  it('counts the keys the change just broke', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { createApiKey } = await import('../test/fixtures.ts');
    await createApiKey();
    await createApiKey();

    await checkSigningSecret('the-original');
    await checkSigningSecret('a-different-one');

    expect(String(complained.mock.calls[0]?.[0])).toContain('2 API keys');

    complained.mockRestore();
  });

  it('warns once per change rather than on every restart', async () => {
    // Somebody who rotated the secret on purpose has been told. Repeating it
    // at every start would train them to ignore the log, which is where the
    // next thing they need to read will also be.
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {});

    await checkSigningSecret('the-original');
    await checkSigningSecret('a-different-one');
    await checkSigningSecret('a-different-one');
    await checkSigningSecret('a-different-one');

    expect(complained).toHaveBeenCalledOnce();

    complained.mockRestore();
  });

  it('notices a change back to a secret used before', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {});

    await checkSigningSecret('the-original');
    await checkSigningSecret('a-different-one');
    await checkSigningSecret('the-original');

    // Twice: once for each change. Returning to an earlier secret is still a
    // change from what the database was last built with.
    expect(complained).toHaveBeenCalledTimes(2);

    complained.mockRestore();
  });

  it('remembers when it changed, for the diagnostics view', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {});

    await checkSigningSecret('the-original');
    expect(await changedAt()).toBeUndefined();

    await checkSigningSecret('a-different-one');
    expect(await changedAt()).toBeDefined();

    complained.mockRestore();
  });

  it('records no change on a first start, however many keys already exist', async () => {
    // An installation upgraded to a version with this check has keys and no
    // fingerprint. Calling that a change would report every key as broken.
    const { createApiKey } = await import('../test/fixtures.ts');
    await createApiKey();

    await checkSigningSecret('the-original');

    expect(await changedAt()).toBeUndefined();
  });
});

async function changedAt(): Promise<string | undefined> {
  const result = await getPool().query<{ value: string }>(
    'SELECT value FROM settings WHERE key = $1',
    [CHANGED_AT_KEY],
  );

  return result.rows[0]?.value;
}
