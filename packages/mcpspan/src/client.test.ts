import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { clientName, detectClient } from './client.js';

/** The contract's table as cases, shared by every SDK's tests (conformance/client-types.json). */
const table = (
  JSON.parse(readFileSync(new URL('../../../conformance/client-types.json', import.meta.url), 'utf8')) as {
    cases: [string | null, string][];
  }
).cases;

describe('detectClient', () => {
  it.each(table)('reads %j as %s', (name, expected) => {
    expect(detectClient(name === null ? undefined : { name })).toBe(expected);
  });

  it.each([
    ['null was passed', null],
    ['there is no name', {}],
  ])('reports unknown when %s', (_label, info) => {
    expect(detectClient(info)).toBe('unknown');
  });
});

describe('clientName', () => {
  it('keeps the name exactly as reported', () => {
    expect(clientName({ name: 'Claude Desktop' })).toBe('Claude Desktop');
  });

  it('trims surrounding whitespace', () => {
    expect(clientName({ name: '  cursor  ' })).toBe('cursor');
  });

  it.each([
    ['nothing was passed', undefined],
    ['null was passed', null],
    ['there is no name', {}],
    ['the name is whitespace', { name: '   ' }],
  ])('returns nothing when %s', (_label, info) => {
    expect(clientName(info)).toBeUndefined();
  });
});

describe('clientName with a name longer than the API takes', () => {
  it('cuts it, since the client chooses it and the API would refuse the batch', () => {
    expect(clientName({ name: 'c'.repeat(500) })?.length).toBe(200);
  });
});
