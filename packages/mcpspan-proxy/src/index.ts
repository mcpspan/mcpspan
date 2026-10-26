#!/usr/bin/env node
import { run } from './cli.js';

// Never stdout for anything of the proxy's own: on stdio it carries the protocol.
const code = await run(process.argv.slice(2), {
  input: process.stdin,
  output: process.stdout,
  env: process.env,
  out: (text) => process.stdout.write(text),
  say: (message) => process.stderr.write(`${message}\n`),
});

// Exited rather than left to wind down: a client that keeps its end open would keep this process alive.
// After stdout has taken everything the server wrote.
process.stdout.write('', () => process.exit(code));
