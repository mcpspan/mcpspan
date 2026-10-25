import { readFile } from 'node:fs/promises';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { Target } from './args.js';
import { VERSION } from './version.js';

export interface Listing {
  /** The server's name and version from the handshake; none for a listing read from a file. */
  server?: { name: string; version: string };
  /** The tools as the server sent them, unchecked: checking them is the point. */
  tools: unknown[];
}

/** The server could not be checked: it did not start, did not answer, or answered with something else than tools. */
export class ListingError extends Error {
  constructor(
    message: string,
    /** The last of what a server started here wrote to stderr, which usually says why it stopped. */
    readonly stderr?: string,
  ) {
    super(message);
  }
}

/** Takes any answer as it is. The client's own check would refuse the whole listing over one broken tool. */
const UNCHECKED = { '~standard': { version: 1, vendor: 'mcpspan-lint', validate: (value: unknown) => ({ value }) } } as const;

/** A server that keeps handing out cursors would page forever. */
const MAX_PAGES = 100;
const STDERR_KEPT = 4_000;

export async function fetchListing(target: Target, timeoutMs: number): Promise<Listing> {
  if (target.kind === 'file') return readListing(target.path);

  const stderr: string[] = [];
  const transport =
    target.kind === 'stdio'
      ? stdio(target, stderr)
      : new StreamableHTTPClientTransport(target.url, { requestInit: { headers: target.headers } });
  const client = new Client({ name: 'mcpspan-lint', version: VERSION });
  const failed = (message: string) => new ListingError(message, tail(stderr));

  try {
    await withTimeout(client.connect(transport), timeoutMs, () =>
      failed(`The server did not finish the handshake within ${timeoutMs / 1000} seconds.`),
    ).catch((error: unknown) => {
      throw error instanceof ListingError ? error : failed(`Could not connect: ${reason(error)}`);
    });

    const info = client.getServerVersion();
    const server = info === undefined ? undefined : { name: info.name, version: info.version };

    if (client.getServerCapabilities()?.tools === undefined) return { ...(server ? { server } : {}), tools: [] };

    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = await withTimeout(
        client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, UNCHECKED),
        timeoutMs,
        () => failed(`The server did not list its tools within ${timeoutMs / 1000} seconds.`),
      ).catch((error: unknown) => {
        throw error instanceof ListingError ? error : failed(`tools/list failed: ${reason(error)}`);
      });

      const result = answer as { tools?: unknown; nextCursor?: unknown };
      if (!Array.isArray(result?.tools)) throw failed('The server answered tools/list without a list of tools.');
      tools.push(...result.tools);

      if (typeof result.nextCursor !== 'string' || result.nextCursor === '') {
        return { ...(server ? { server } : {}), tools };
      }
      cursor = result.nextCursor;
    }

    throw failed(`The server was still handing out pages after ${MAX_PAGES}.`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** A server started here, with this environment, its stderr kept rather than mixed into the report. */
function stdio(target: { command: string; args: string[] }, stderr: string[]): StdioClientTransport {
  // The whole environment, not the SDK's short list of safe variables: the server
  // being checked is the user's own, and may need its keys and settings to start.
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({ command: target.command, args: target.args, env, stderr: 'pipe' });

  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));

  return transport;
}

async function readListing(path: string): Promise<Listing> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ListingError(`Could not read ${path}: ${reason(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ListingError(`${path} is not JSON.`);
  }

  // A saved answer, its result alone, or just the list of tools.
  const tools = Array.isArray(value) ? value : pick(value, 'tools') ?? pick(pick(value, 'result'), 'tools');
  if (!Array.isArray(tools)) throw new ListingError(`${path} holds no list of tools: expected a tools/list answer or an array.`);

  return { tools };
}

function pick(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, timedOut: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timedOut()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(chunks: string[]): string | undefined {
  const text = chunks.join('').trim();

  return text === '' ? undefined : text.slice(-STDERR_KEPT);
}
