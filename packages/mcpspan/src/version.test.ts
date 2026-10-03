import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SDK_VERSION } from './version.js';

describe('SDK_VERSION', () => {
  it('matches the published package version', () => {
    // Telemetry and the User-Agent report SDK_VERSION, so a drift here would
    // attribute events to a version that was never released.
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(SDK_VERSION).toBe(pkg.version);
  });
});
