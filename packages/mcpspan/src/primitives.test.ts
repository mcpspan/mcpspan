import { describe, expect, it } from 'vitest';

import { schemeOf } from './primitives.js';

describe('schemeOf', () => {
  it('keeps the scheme of an address and nothing after it', () => {
    expect(schemeOf('db://customers/4412')).toBe('db://');
    expect(schemeOf('file:///home/ada/contract.pdf')).toBe('file://');
    expect(schemeOf('urn:isbn:0451450523')).toBe('urn://');
  });

  it('names an address with no scheme it can trust as unknown', () => {
    expect(schemeOf('customers/4412')).toBe('unknown://');
    expect(schemeOf('4412:secret')).toBe('unknown://');
    expect(schemeOf('')).toBe('unknown://');
  });
});
