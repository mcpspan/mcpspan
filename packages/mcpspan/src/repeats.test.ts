import { afterEach, describe, expect, it } from 'vitest';

import { forgetArguments, noteArguments } from './repeats.js';

afterEach(() => forgetArguments());

describe('noteArguments (contract, 3.9)', () => {
  it('says a call repeats the previous one to the same tool in the same session, whatever the key order', () => {
    expect(noteArguments('s1', 'search', { to: 'WAW', n: 2 })).toBe(false);
    expect(noteArguments('s1', 'search', { n: 2, to: 'WAW' })).toBe(true);
    expect(noteArguments('s1', 'search', { to: 'KRK', n: 2 })).toBe(false);
  });

  it('keeps tools and sessions apart, and takes no arguments as an empty object', () => {
    noteArguments('s1', 'search', { to: 'WAW' });
    expect(noteArguments('s1', 'book', { to: 'WAW' })).toBe(false);
    expect(noteArguments('s2', 'search', { to: 'WAW' })).toBe(false);
    expect(noteArguments('s1', 'list', undefined)).toBe(false);
    expect(noteArguments('s1', 'list', {})).toBe(true);
  });

  it('never calls arguments it cannot write down a repeat', () => {
    expect(noteArguments('s1', 'odd', { n: Number.NaN })).toBe(false);
    expect(noteArguments('s1', 'odd', { n: Number.NaN })).toBe(false);
  });

  it('forgets the oldest pairs past its bound, and only undercounts for it', () => {
    noteArguments('first', 'search', { to: 'WAW' });
    for (let i = 0; i < 10_000; i++) noteArguments(`s${i}`, 'search', {});
    expect(noteArguments('first', 'search', { to: 'WAW' })).toBe(false);
  });
});
