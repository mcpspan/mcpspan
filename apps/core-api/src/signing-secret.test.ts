import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSigningSecret } from './signing-secret.ts';

function directory(): string {
  return mkdtempSync(join(tmpdir(), 'mcpspan-secret-'));
}

describe('loadSigningSecret', () => {
  it('uses API_KEY_SECRET when it is set, and touches no file', () => {
    const file = join(directory(), 'secret');

    expect(loadSigningSecret({ API_KEY_SECRET: ' given ', MCPSPAN_SECRET_FILE: file })).toEqual({
      secret: 'given',
      generated: false,
    });
    expect(() => statSync(file)).toThrow();
  });

  it('makes one on first start, keeps it to itself, and reads the same one after', () => {
    const file = join(directory(), 'secret');
    const env: NodeJS.ProcessEnv = { MCPSPAN_SECRET_FILE: file };

    const first = loadSigningSecret(env);
    const again = loadSigningSecret({ MCPSPAN_SECRET_FILE: file });

    expect(first).toMatchObject({ generated: true });
    expect('secret' in first && first.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toEqual({ secret: 'secret' in first ? first.secret : '', generated: false });
    expect(env['API_KEY_SECRET']).toBe('secret' in first ? first.secret : undefined);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reads a stored one as it is', () => {
    const file = join(directory(), 'secret');
    writeFileSync(file, 'stored\n');

    expect(loadSigningSecret({ MCPSPAN_SECRET_FILE: file })).toEqual({ secret: 'stored', generated: false });
    expect(readFileSync(file, 'utf8')).toBe('stored\n');
  });

  it('says what to do with neither a secret nor a place to keep one', () => {
    expect(loadSigningSecret({})).toEqual({ problem: expect.stringContaining('API_KEY_SECRET') });
  });

  it('says so when the place cannot be written', () => {
    const file = join(directory(), 'missing', 'secret');

    expect(loadSigningSecret({ MCPSPAN_SECRET_FILE: file })).toEqual({
      problem: expect.stringContaining(file),
    });
  });
});
