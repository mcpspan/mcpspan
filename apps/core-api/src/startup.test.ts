import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { TEST_DATABASE_URL } from '../test/database.ts';

/** How long to give a process that is expected to stop on its own. */
const PATIENCE_MS = 10_000;

/**
 * Starts the API in a real process and reports how it went.
 *
 * These checks live in the entry file and end in `process.exit`, so there is
 * no honest way to exercise them from inside the test runner. They are also
 * the first thing anyone self-hosting meets when a setting is missing, which
 * makes them worth the cost of spawning something.
 *
 * A run that is supposed to keep serving is stopped as soon as it has said
 * everything the test is waiting for, rather than after a fixed wait. Tests
 * that sit out a timeout to prove a process did not die are how a suite ends
 * up taking minutes.
 */
function boot(
  env: Record<string, string | undefined>,
  expected: string[] = [],
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['src/index.ts'], { env: { ...process.env, ...env } });
    let output = '';
    let settled = false;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(patience);
      child.kill();
      resolve({ code, output });
    };

    const patience = setTimeout(() => finish(0), PATIENCE_MS);

    const collect = (chunk: Buffer): void => {
      output += chunk.toString();

      if (expected.length > 0 && expected.every((phrase) => output.includes(phrase))) {
        finish(0);
      }
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', (code) => finish(code ?? 1));
  });
}

const workingEnv = {
  DATABASE_URL: TEST_DATABASE_URL,
  API_KEY_SECRET: 'test-secret-not-used-anywhere-real',
  PORT: '4399',
};

describe('starting without a signing secret', () => {
  it('stops rather than serving', async () => {
    const { code } = await boot({ ...workingEnv, API_KEY_SECRET: undefined });

    // Serving without it means refusing every request, which reads as a broken
    // key rather than a missing setting.
    expect(code).toBe(1);
  });

  it('says how to produce one', async () => {
    const { output } = await boot({ ...workingEnv, API_KEY_SECRET: undefined });

    expect(output).toContain('openssl rand -hex 32');
  });
});

describe('starting with a port that is not one', () => {
  it.each([
    ['not a number', 'http'],
    ['zero', '0'],
    ['above the range', '70000'],
  ])('stops when PORT is %s', async (_label, port) => {
    const { code } = await boot({ ...workingEnv, PORT: port });

    expect(code).toBe(1);
  });

  it('repeats back what it was given', async () => {
    const { output } = await boot({ ...workingEnv, PORT: 'http' });

    expect(output).toContain('http');
  });
});

describe('starting with everything it needs', () => {
  it('serves, says where, and reports reaching the database', async () => {
    const { output } = await boot(workingEnv, ['listening on', 'connected to the database']);

    expect(output).toContain('listening on');
    expect(output).toContain('connected to the database');
  });

  it('keeps running when the database is unreachable', async () => {
    const { output } = await boot(
      { ...workingEnv, DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/nothing' },
      ['listening on', 'cannot reach the database'],
    );

    // Under Compose the API regularly starts first. Exiting here would turn a
    // few ordinary seconds of waiting into a restart loop.
    expect(output).toContain('listening on');
    expect(output).toContain('cannot reach the database');
  });
});
