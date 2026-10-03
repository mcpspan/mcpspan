import { describe, expect, it } from 'vitest';

import { describeParameters, MAX_DESCRIBED_PARAMETERS } from './parameters.js';

describe('describeParameters', () => {
  it('names each parameter and its type', () => {
    expect(
      describeParameters([{ destination: 'Lisbon', passengers: 2, flexible: true }]),
    ).toEqual({ destination: 'string', passengers: 'number', flexible: 'boolean' });
  });

  it.each([
    ['a string', 'Lisbon', 'string'],
    ['a number', 2, 'number'],
    ['a boolean', true, 'boolean'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['an array', [1, 2], 'array'],
    ['an object', { nested: true }, 'object'],
  ])('describes %s', (_label, value, expected) => {
    expect(describeParameters([{ field: value }])).toEqual({ field: expected });
  });

  it('separates arrays from objects, which typeof does not', () => {
    expect(describeParameters([{ tags: ['a'] }])).toEqual({ tags: 'array' });
  });

  it('reads only the first argument, since the rest belong to the protocol', () => {
    expect(describeParameters([{ destination: 'Lisbon' }, { requestId: 'abc' }])).toEqual({
      destination: 'string',
    });
  });

  it('caps how many parameters one event can describe', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`field${index}`, index]),
    );

    expect(Object.keys(describeParameters([wide]) ?? {})).toHaveLength(MAX_DESCRIBED_PARAMETERS);
  });

  it.each([
    ['there are no arguments', []],
    ['the argument is a string', ['Lisbon']],
    ['the argument is a number', [42]],
    ['the argument is null', [null]],
    ['the argument is undefined', [undefined]],
    ['the argument is an array', [[1, 2]]],
    ['the object is empty', [{}]],
  ])('returns nothing when %s', (_label, args) => {
    expect(describeParameters(args)).toBeUndefined();
  });
});

describe('describeParameters and privacy', () => {
  it('keeps no values at all', () => {
    const described = describeParameters([
      { apiKey: 'sk-live-secret', email: 'someone@example.com', amount: 4_200 },
    ]);

    const serialised = JSON.stringify(described);
    expect(serialised).not.toContain('sk-live-secret');
    expect(serialised).not.toContain('someone@example.com');
    expect(serialised).not.toContain('4200');
  });

  it('does not reveal a value through its length', () => {
    const short = describeParameters([{ password: 'a' }]);
    const long = describeParameters([{ password: 'a'.repeat(500) }]);

    expect(short).toEqual(long);
  });

  it('does not descend into nested objects', () => {
    const described = describeParameters([{ user: { ssn: '123-45-6789' } }]);

    expect(described).toEqual({ user: 'object' });
    expect(JSON.stringify(described)).not.toContain('ssn');
  });
});
