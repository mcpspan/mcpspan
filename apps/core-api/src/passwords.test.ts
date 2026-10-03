import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './passwords.ts';

describe('hashPassword', () => {
  it('never stores the password', async () => {
    expect(await hashPassword('correct horse battery staple')).not.toContain('horse');
  });

  it('gives the same password a different hash each time', async () => {
    // A shared salt would let one lookup table crack every account at once,
    // and would reveal which users picked the same password.
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('records the settings it used, so they can be raised later', async () => {
    expect(await hashPassword('anything')).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password', async () => {
    const stored = await hashPassword('correct horse battery staple');

    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
  });

  it.each([
    ['a different password', 'wrong horse battery staple'],
    ['the same password with different case', 'Correct Horse Battery Staple'],
    ['a prefix of it', 'correct horse'],
    ['nothing', ''],
  ])('refuses %s', async (_label, attempt) => {
    const stored = await hashPassword('correct horse battery staple');

    await expect(verifyPassword(attempt, stored)).resolves.toBe(false);
  });

  it.each([
    ['empty', ''],
    ['not a hash at all', 'hello'],
    ['missing fields', 'scrypt$32768$8'],
    ['an algorithm we do not use', 'bcrypt$32768$8$1$c2FsdA$aGFzaA'],
    ['a cost that is not a number', 'scrypt$lots$8$1$c2FsdA$aGFzaA'],
  ])('refuses rather than failing on a stored value that is %s', async (_label, stored) => {
    // A row corrupted by hand should refuse a sign-in, not raise a server
    // error announcing that something is wrong with that account.
    await expect(verifyPassword('anything', stored)).resolves.toBe(false);
  });

  it('reads settings from the hash rather than assuming the current ones', async () => {
    // What makes raising the cost possible later: a hash written under weaker
    // settings still verifies, because the settings travel with it.
    const weak = 'scrypt$1024$8$1$';
    const stored = (await hashPassword('secret')).replace(/^scrypt\$\d+\$8\$1\$/, weak);

    // The digest no longer matches those settings, so it must refuse - but by
    // answering false, not by throwing.
    await expect(verifyPassword('secret', stored)).resolves.toBe(false);
  });
});
