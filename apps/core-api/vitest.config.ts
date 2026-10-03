import { defineConfig } from 'vitest/config';

import { TEST_DATABASE_URL } from './test/database.ts';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      // Fixed rather than random: key hashes are deterministic, so a value that
      // changed between runs would make a key written by one test unreadable to
      // the next.
      API_KEY_SECRET: 'test-secret-not-used-anywhere-real',
    },
    // These tests share one database. Running files in parallel would have them
    // truncating tables out from under each other.
    fileParallelism: false,

    // Some tests start the API as a real process, which is the only honest way
    // to exercise the checks that end in process.exit.
    testTimeout: 15_000,

    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Covered by startup.test.ts, which runs it as its own process. The
        // coverage tool cannot see into that, and leaving it in would report a
        // tested file as untouched.
        'src/index.ts',
      ],
    },
  },
});
