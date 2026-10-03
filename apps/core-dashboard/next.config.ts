import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const config: NextConfig = {
  // Surfaces problems here rather than in somebody's deployment.
  reactStrictMode: true,

  // Emits a self-contained server with only the modules actually reached, so
  // the container image does not have to carry a workspace node_modules tree.
  // With pnpm that is not merely a size question: its node_modules is a forest
  // of symlinks into a store outside this directory, which does not survive
  // being copied into an image.
  output: 'standalone',

  // Tracing starts at the monorepo root rather than this package, so files
  // pulled in from elsewhere in the workspace are followed instead of missed.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),

  // The version is shown in the interface, so a self-hoster reporting a
  // problem can say which build they are looking at.
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env['npm_package_version'] ?? '0.0.0',
  },
};

export default config;
