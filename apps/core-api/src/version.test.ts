import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function versionOf(path: string): string {
  return (
    JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version: string }
  ).version;
}

describe('the Core API and dashboard versions', () => {
  it('move together', () => {
    // Released as one installation from one repository, and the Status page
    // shows both side by side. Two different numbers there should mean two
    // different builds are running, never that somebody bumped one file.
    expect(versionOf('../../core-dashboard/package.json')).toBe(versionOf('../package.json'));
  });
});
