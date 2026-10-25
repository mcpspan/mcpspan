#!/usr/bin/env node
import { run } from './cli.js';

const color = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  color,
});
