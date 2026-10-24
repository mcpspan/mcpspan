import { defineConfig } from 'vitest/config';

import { TEST_DATABASE_URL } from './test/database.ts';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      API_KEY_SECRET: 'test-secret-not-used-anywhere-real',
    },
    // One database for every file.
    fileParallelism: false,
  },
});
