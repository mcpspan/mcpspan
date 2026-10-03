import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client as ClientV2 } from '@modelcontextprotocol/client';
import { StdioClientTransport as StdioClientTransportV2 } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The command that starts the adapter under test.
 *
 * From CONFORMANCE_ADAPTER, as a JSON array, so another language's adapter
 * runs under the same suite: `["python", "adapters/python/server.py"]`.
 * Relative paths are from the conformance directory.
 */
function adapterCommand(): { command: string; args: string[] } {
  const configured = process.env['CONFORMANCE_ADAPTER'];
  const parts = configured === undefined
    ? ['node', 'adapters/typescript/server.mjs']
    : (JSON.parse(configured) as string[]);
  const [command, ...args] = parts;

  if (command === undefined) throw new Error('CONFORMANCE_ADAPTER names no command');

  return { command, args };
}

/**
 * Which protocol the suite's client speaks, from CONFORMANCE_PROTOCOL.
 *
 * `2025` (the default) is a v1 client and the `initialize` handshake. `2026`
 * is a v2 client pinned to the 2026-07-28 revision, which has no handshake
 * and no session: the client names itself on every request, and an SDK that
 * only read the handshake would not know who called.
 */
const PROTOCOL = process.env['CONFORMANCE_PROTOCOL'] === '2026' ? '2026' : '2025';

/**
 * The type the adapter's `throws` tool fails with. `ConformanceError` in every
 * language with exception or error types; Rust's MCP SDK fails a tool with an
 * `ErrorData`, which has a code but no type, and the Rust SDK names it by the
 * code (`InternalError`).
 */
export const EXCEPTION_TYPE = process.env['CONFORMANCE_EXCEPTION_TYPE'] ?? 'ConformanceError';

/**
 * The v2 stdio transport, made to probe the protocol version in place.
 *
 * On its own base transport, a v2 client asks `server/discover` of a
 * disposable second server process, then starts the real one. That probe is
 * a real process and, correctly, announces itself (contract, 3.4), so one
 * connection would reach the fake ingest API as two processes' worth of
 * requests, and whether the probe announces before it is killed depends on
 * how fast the SDK under test starts. Any subclass makes the client probe on
 * the connection itself, which keeps one connection to one process, the unit
 * every case here is written against.
 */
class InPlaceProbeTransport extends StdioClientTransportV2 {}

/** The version the suite's client gives itself: not the adapters' own 1.0.0, so the two cannot be mistaken. */
export const CLIENT_VERSION = '2.3.4';

/** The version every adapter's server gives itself in its handshake. */
export const SERVER_VERSION = '1.0.0';

/** What the cases need of a client, whichever SDK version it comes from. */
export interface McpClient {
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{ isError?: boolean; content?: unknown }>;
  readResource(params: { uri: string }): Promise<unknown>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<unknown>;
  listResources(): Promise<unknown>;
  listPrompts(): Promise<unknown>;
  close(): Promise<void>;
}

export interface Connection {
  client: McpClient;
  /** What the adapter wrote to standard error so far. */
  stderr: () => string;
  close: () => Promise<void>;
}

/**
 * Starts the adapter and connects to it as a real MCP client would.
 *
 * `clientName` is what the client calls itself in the handshake, which is
 * what the SDK derives the client type from.
 */
export async function connect(options: {
  /** Left out to check an SDK given a key and nowhere to send (2). */
  endpoint?: string;
  apiKey?: string;
  clientName?: string;
  captureParameters?: boolean;
  flushMs?: number;
  /** Given to the SDK as MCPSPAN_SERVER_VERSION, which wins over the server's own (3.6). */
  serverVersion?: string;
}): Promise<Connection> {
  const { command, args } = adapterCommand();
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    ...(options.endpoint === undefined ? {} : { MCPSPAN_ENDPOINT: options.endpoint }),
    CONFORMANCE_FLUSH_MS: String(options.flushMs ?? 200),
    CONFORMANCE_CAPTURE_PARAMETERS: options.captureParameters === true ? '1' : '0',
    ...(options.apiKey === undefined ? {} : { MCPSPAN_API_KEY: options.apiKey }),
    ...(options.serverVersion === undefined ? {} : { MCPSPAN_SERVER_VERSION: options.serverVersion }),
  };

  const identity = { name: options.clientName ?? 'conformance-client', version: CLIENT_VERSION };
  let stderr = '';
  let client: McpClient;

  if (PROTOCOL === '2026') {
    const transport = new InPlaceProbeTransport({ command, args, env, cwd: root, stderr: 'pipe' });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const modern = new ClientV2(identity, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
    await modern.connect(transport);
    client = modern as unknown as McpClient;
  } else {
    const transport = new StdioClientTransport({ command, args, env, cwd: root, stderr: 'pipe' });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const legacy = new Client(identity);
    await legacy.connect(transport);
    client = legacy as unknown as McpClient;
  }

  return {
    client,
    stderr: () => stderr,
    // Closing ends the adapter's standard input, the way a real client
    // leaving does, and gives it two seconds to exit on its own.
    close: () => client.close(),
  };
}

/** Waits until a condition holds, or fails the case with what it was waiting for. */
export async function eventually(
  what: string,
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
