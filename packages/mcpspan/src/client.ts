import { MAX_NAME_LENGTH, truncate } from './failure.js';
import type { ClientType } from './types.js';

/**
 * How a connected client described itself.
 *
 * On the 2025 protocol a client announces a name and version once, in the
 * `initialize` handshake; on the 2026-07-28 protocol it repeats them in every
 * request's `_meta`. See `clientFor` for where each is read.
 */
export interface ClientInfo {
  name?: string;
  version?: string;
}

/**
 * Names we recognise, matched as substrings of what a client reports.
 *
 * Substring rather than exact: clients append platform and channel suffixes to
 * their names, and an exact list would quietly rot into a table of `other`
 * with every release someone else ships. That is not a hypothetical - the
 * official Inspector reports itself as `inspector-cli`, which an exact list
 * of the obvious names would have missed on the first try.
 *
 * Order matters. More specific entries come first, so a client calling itself
 * "claude-code" is not read as plain Claude.
 */
const KNOWN_CLIENTS: readonly (readonly [pattern: string, type: ClientType])[] = [
  // Measured: Claude Code 2.1 sends `claude-code`. It has to sit above the
  // plain Claude entry, which would otherwise swallow it.
  ['claude-code', 'claude-code'],
  ['claude code', 'claude-code'],
  ['claude', 'claude'],
  ['cursor', 'cursor'],
  ['chatgpt', 'chatgpt'],
  ['openai', 'chatgpt'],
  // Measured: the official Inspector 2.7 sends `inspector-cli`, which is why
  // matching on a substring is not a stylistic preference.
  ['inspector', 'mcp-inspector'],
];

/**
 * Works out which application a tool call came from.
 *
 * Returns `unknown` when nothing identified itself: a call not made through
 * `instrument`, or a request that named no client. A name we
 * do not have in the table gives `other` - the client is there, we just have
 * not met it.
 */
export function detectClient(info?: ClientInfo | null): ClientType {
  const name = info?.name?.trim().toLowerCase();
  if (!name) return 'unknown';

  for (const [pattern, type] of KNOWN_CLIENTS) {
    if (name.includes(pattern)) return type;
  }

  return 'other';
}

/**
 * The name a client reported, as it reported it.
 *
 * Kept alongside the recognised type so an unfamiliar client is a lead rather
 * than a dead end: a dashboard showing forty percent `other` is useless if
 * nobody can find out what `other` was. This is an application's own
 * self-description, the MCP equivalent of a User-Agent, and carries nothing
 * about whoever is using it.
 */
export function clientName(info?: ClientInfo | null): string | undefined {
  const name = info?.name?.trim();

  // The client chooses its own name, and the API refuses a batch holding one
  // over this length. Cut, so one unusual client cannot lose everyone's data.
  return name && name.length > 0 ? truncate(name, MAX_NAME_LENGTH) : undefined;
}

/**
 * Where a request on the 2026-07-28 protocol names its client. There is no
 * `initialize` handshake on that revision; a client identifies itself on every
 * request instead, in the request's `_meta`.
 */
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

interface RequestContextLike {
  /** v1 of the official SDK: the request's `_meta`. */
  _meta?: Record<string, unknown>;
  /** v2: the request's `_meta`, and the validated per-request envelope. */
  mcpReq?: { _meta?: Record<string, unknown>; envelope?: Record<string, unknown> };
}

interface ServerLike {
  server?: { getClientVersion?: () => ClientInfo | undefined };
}

/**
 * The client that sent one call, from what the MCP server knows about it.
 *
 * On the 2026-07-28 protocol the request says so itself, and that is read
 * first. Otherwise it comes from the `initialize` handshake, held by the
 * server instance the call arrived on - that instance, not whichever server
 * was instrumented last, because one process can serve several clients at
 * once.
 *
 * A stateless HTTP server on the 2025 protocol may build a fresh instance for
 * each request, one that never saw the handshake, and there nothing names the
 * client at all. The call is recorded as coming from an unknown client rather
 * than from a guess.
 */
export function clientFor(server: object, context: unknown): ClientInfo | undefined {
  const request = (context ?? {}) as RequestContextLike;
  const declared =
    request.mcpReq?.envelope?.[CLIENT_INFO_META_KEY] ??
    request.mcpReq?._meta?.[CLIENT_INFO_META_KEY] ??
    request._meta?.[CLIENT_INFO_META_KEY];

  if (isClientInfo(declared)) return declared;

  try {
    return (server as ServerLike).server?.getClientVersion?.();
  } catch {
    // A server that cannot say is a client we do not know, not a failure.
    return undefined;
  }
}

/**
 * The version an MCP server gives itself, as it was built: `new McpServer({
 * name, version })`. Both major versions of the official SDK keep it in the
 * same private field of the protocol-level server; if a version moves it, calls
 * go without one rather than with a guess.
 */
export function serverVersionOf(server: object): string | undefined {
  try {
    const inner = (server as { server?: { _serverInfo?: { version?: unknown } } }).server;
    const own = (server as { _serverInfo?: { version?: unknown } })._serverInfo;
    const version = inner?._serverInfo?.version ?? own?.version;

    return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isClientInfo(value: unknown): value is ClientInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    (typeof (value as ClientInfo).name === 'string' ||
      typeof (value as ClientInfo).version === 'string')
  );
}
