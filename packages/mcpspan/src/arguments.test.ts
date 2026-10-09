import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { invalidArguments } from './arguments.js';

const shared = JSON.parse(readFileSync(new URL('../../../conformance/argument-checks.json', import.meta.url), 'utf8')) as {
  cases: { case: string; schema: unknown; arguments: unknown; invalid: string[] }[];
};

describe('invalidArguments (contract, 3.10)', () => {
  it.each(shared.cases.map((entry) => [entry.case, entry.schema, entry.arguments, entry.invalid] as const))(
    'finds %s as every SDK does',
    (_name, schema, args, invalid) => {
      expect(invalidArguments(schema, args)).toEqual(invalid);
    },
  );

  it('finds nothing without a schema', () => {
    expect(invalidArguments(undefined, { passengers: 2 })).toEqual([]);
  });
});
