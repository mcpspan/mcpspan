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

  // The pages themselves live in a workspace package, shipped as TypeScript
  // source rather than built output, so this app compiles them.
  transpilePackages: ['@mcpspan/dashboard-ui'],

  // Never shown inside another site's frame, where a page laid over it could
  // trick somebody into clicking; files are taken as the type they are sent as;
  // other sites are not told which page a link was followed from.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },

  // The version is shown in the interface, so a self-hoster reporting a
  // problem can say which build they are looking at.
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env['npm_package_version'] ?? '0.0.0',
  },
};

export default config;
