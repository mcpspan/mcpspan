import { describe, expect, it } from 'vitest';

import { LoginThrottle } from './login-throttle.ts';

describe('LoginThrottle', () => {
  it('lets ten wrong passwords through in a minute and holds the next until the first is a minute old', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);

    for (let i = 0; i < 10; i++) {
      expect(throttle.retryAfterSeconds('me@example.com')).toBe(0);
      throttle.recordFailure('me@example.com');
      now += 1000;
    }

    expect(throttle.retryAfterSeconds('me@example.com')).toBe(50);
    now = 60_001;
    expect(throttle.retryAfterSeconds('me@example.com')).toBe(0);
  });

  it('counts each account on its own, however its address is typed', () => {
    const throttle = new LoginThrottle(() => 0);

    for (let i = 0; i < 10; i++) throttle.recordFailure(' Me@Example.com');

    expect(throttle.retryAfterSeconds('me@example.com')).toBe(60);
    expect(throttle.retryAfterSeconds('someone@example.com')).toBe(0);
  });
});
