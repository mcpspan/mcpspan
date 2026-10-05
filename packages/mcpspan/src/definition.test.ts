import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { definitionHash, definitionOf, forgetListings, noteListing } from './definition.js';

const shared = JSON.parse(readFileSync(new URL('../../../conformance/definition-hashes.json', import.meta.url), 'utf8')) as {
  cases: { case: string; tool: Record<string, unknown>; hash: string }[];
};

afterEach(() => forgetListings());

describe('definitionHash (contract, 3.8)', () => {
  it.each(shared.cases.map((entry) => [entry.case, entry.tool, entry.hash] as const))(
    'fingerprints %s as every SDK does',
    (_name, tool, hash) => {
      expect(definitionHash(tool)).toBe(hash);
    },
  );

  it('keeps the latest listed fingerprint of each tool, and ignores what it cannot read', () => {
    noteListing({ tools: [{ name: 'a', description: 'one' }, { name: 'b' }] });
    noteListing({ tools: [{ name: 'a', description: 'two' }, { description: 'nameless' }] });
    noteListing(null);
    noteListing({ tools: 'not a list' });

    expect(definitionOf('a')).toBe(definitionHash({ name: 'a', description: 'two' }));
    expect(definitionOf('b')).toBe(definitionHash({ name: 'b' }));
    expect(definitionOf('c')).toBeUndefined();
  });
});
