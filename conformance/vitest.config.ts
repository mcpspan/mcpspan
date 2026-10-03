import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each case starts a process and waits on real timers.
    testTimeout: 30_000,
    // One adapter process at a time keeps timing checks honest.
    fileParallelism: false,
    // A case may be run again, each time with a fresh adapter, where an MCP SDK
    // is known to stall on its own under load. Off unless asked for, so an
    // SDK's own failure is never hidden by default.
    retry: Number(process.env['CONFORMANCE_RETRY'] ?? 0),
  },
});
