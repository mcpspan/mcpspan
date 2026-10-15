import { describe, expect, it } from 'vitest';

import { clientName } from './client.js';

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
