// The conformance adapter for mcpspan-proxy: the proxy over stdio, in front
// of the TypeScript reference adapter on v2 of the official MCP SDK. The
// proxy keeps MCPSPAN_API_KEY from the server it runs, so the SDK in that
// adapter collects nothing, and every event the suite sees is the proxy's.
//
// Run the suite with CONFORMANCE_PROXY=1, for what a proxy cannot see (see
// FROM_OUTSIDE in src/adapter.ts). Build the proxy first (pnpm --filter mcpspan-proxy build). The suite's
// settings become the proxy's options; the excluded tool is named, since a
// proxy cannot see the SDK's mark on it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const proxy = fileURLToPath(new URL('../../../packages/mcpspan-proxy/dist/index.mjs', import.meta.url));
const server = fileURLToPath(new URL('../typescript-v2/server.mjs', import.meta.url));

const options = [
  '--exclude',
  'excluded',
  '--flush-interval',
  String(Number(process.env.CONFORMANCE_FLUSH_MS ?? 200) / 1000),
  ...(process.env.CONFORMANCE_CAPTURE_PARAMETERS === '1' ? ['--parameter-names'] : []),
  ...(process.env.CONFORMANCE_CAPTURE_ERROR_MESSAGES === '0' ? ['--no-error-messages'] : []),
];

const child = spawn(process.execPath, [proxy, ...options, '--', process.execPath, server], { stdio: 'inherit' });
// The suite stops an adapter with a signal at times; it goes to the proxy, which passes it on.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('close', (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
