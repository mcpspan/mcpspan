import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import type { Readable, Writable } from 'node:stream';

import { LineSplitter, parseLine } from './lines.js';
import type { Observer } from './observer.js';

export interface StdioIo {
  /** What the client writes: the proxy's own stdin. */
  input: Readable;
  /** Where the server's answers go: the proxy's own stdout. */
  output: Writable;
  env: NodeJS.ProcessEnv;
  say: (message: string) => void;
}

/** Signals passed on to the server, which decides how to end. */
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Runs the server with its stdin and stdout passed through this process, and
 * its stderr left as it is. Every byte goes on unchanged and first; the
 * observer reads a copy, line by line. Resolves with the exit code to leave
 * with: the server's own, or 128 and its signal's number.
 *
 * One process is one connection, so one session (contract, 8).
 */
export function runStdio(command: string, args: readonly string[], observer: Observer | undefined, io: StdioIo): Promise<number> {
  // The proxy reports this server's calls. An mcpspan SDK inside the server, if it has one, would report them again.
  const env = { ...io.env };
  delete env['MCPSPAN_API_KEY'];

  const child = spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
    // npx, uvx and the like are .cmd files on Windows, which only a shell runs.
    shell: process.platform === 'win32',
  });

  const connection = observer?.connection(randomUUID());
  if (connection !== undefined) {
    const fromClient = new LineSplitter((line) => connection.fromClient(parseLine(line)));
    const fromServer = new LineSplitter((line) => connection.fromServer(parseLine(line)));
    io.input.on('data', (chunk: Buffer) => fromClient.push(chunk));
    child.stdout.on('data', (chunk: Buffer) => fromServer.push(chunk));
  }

  io.input.pipe(child.stdin);
  child.stdout.pipe(io.output, { end: false });
  // A server that has gone away while the client still writes: its exit says the rest.
  child.stdin.on('error', () => undefined);

  const forward = (signal: NodeJS.Signals) => () => {
    child.kill(signal);
  };
  const handlers = FORWARDED.map((signal) => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);

  return new Promise((resolve) => {
    const finish = (code: number) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      io.input.unpipe(child.stdin);
      connection?.close();
      resolve(code);
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      io.say(
        error.code === 'ENOENT'
          ? `mcpspan-proxy: could not start the server: no such command "${command}".`
          : `mcpspan-proxy: could not start the server: ${error.message}`,
      );
      finish(127);
    });

    // After its output is closed too, so everything it wrote has been passed on.
    child.on('close', (code, signal) => {
      finish(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)));
    });
  });
}
