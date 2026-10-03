import { describe, expect, it } from 'vitest';

import { LoginThrottle } from './login-throttle.ts';

describe('LoginThrottle', () => {
  it('lets ten wrong passwords through in a minute and holds the next until the first is a minute old', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);

    for (let i = 0; i < 10; i++) {
      expect(throttle.retryAfterSeconds()).toBe(0);
      throttle.recordFailure();
      now += 1000;
    }

    expect(throttle.retryAfterSeconds()).toBe(50);
    now = 60_001;
    expect(throttle.retryAfterSeconds()).toBe(0);
  });
});
