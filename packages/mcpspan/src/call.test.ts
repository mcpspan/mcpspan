import { describe, expect, it } from 'vitest';

import { currentCall, withCall } from './call.js';

describe('withCall', () => {
  it('holds the call context only while the call starts', () => {
    const seen = withCall({ sessionId: 's-1', client: { name: 'claude-code' } }, () => currentCall());

    expect(seen).toEqual({ sessionId: 's-1', client: { name: 'claude-code' } });
    expect(currentCall()).toBeUndefined();
  });

  it('puts the previous one back even when the call throws', () => {
    withCall({ sessionId: 'outer' }, () => {
      expect(() =>
        withCall({ sessionId: 'inner' }, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');

      expect(currentCall()?.sessionId).toBe('outer');
    });
  });
});
