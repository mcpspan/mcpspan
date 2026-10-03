import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node18',

  // No maps in the published tarball, of either kind.
  //
  // They are only useful pointing at sources, and `files` ships `dist` alone.
  // Declaration maps reference `src` by path and would lead an editor nowhere;
  // JS maps embed their sources instead, which works but costs 112 kB against
  // a 33 kB package - three quarters of an install that every MCP server using
  // this would carry. The sources are MIT and a click away in the repo.
  //
  // tsdown turns sourcemaps on implicitly when tsconfig enables
  // `declarationMap`, so that is switched off alongside this rather than left
  // to contradict it.
  sourcemap: false,
});
