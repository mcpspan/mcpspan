import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // A command, not a library: nothing imports it, so no declarations.
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: false,
});
