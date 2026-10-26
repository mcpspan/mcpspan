import { randomUUID } from 'node:crypto';

import { invalidArguments } from '../../mcpspan/src/arguments.js';
import { clientName, type ClientInfo } from '../../mcpspan/src/client.js';
import { definitionOf, noteListing, schemaOf } from '../../mcpspan/src/definition.js';
import {
  describeErrorResult,
  isErrorResult,
  MAX_EXCEPTION_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  truncate,
} from '../../mcpspan/src/failure.js';
import { firstListing } from '../../mcpspan/src/listings.js';
import { describeParameters } from '../../mcpspan/src/parameters.js';
import { noteArguments } from '../../mcpspan/src/repeats.js';
import { responseBytes } from '../../mcpspan/src/track.js';
import type { ErrorSource, ToolCallEvent } from '../../mcpspan/src/types.js';

import { Catalog, schemeOf } from './catalog.js';
import { SDK_VERSION } from './version.js';

/**
 * Turns the messages between a client and an MCP server into mcpspan events.
 *
 * The SDKs measure inside the server, where they see each handler run. The
 * proxy sees only the JSON-RPC going past, and works out the same events from
 * it: a request and the answer to it are one call. What it cannot see it does
 * not guess:
 *
 * - A tool that throws and one that returns an error look alike once the
 *   server's MCP SDK has turned the exception into an answer, so a failure
 *   is `result` unless it came back as a protocol error, and no event has an
 *   `errorType`.
 * - Whether a call reached its handler is not visible. A failed call to a
 *   tool the server did not list is `unknown_tool`; one whose arguments fail
 *   the listed schema (contract, 3.10) is `arguments`.
 *
 * Messages are looked at, never changed, and nothing here may throw into the
 * traffic: a message the observer cannot read is let past unrecorded.
 */

export interface ObserverOptions {
  /** Where events go. */
  record: (event: ToolCallEvent) => void;
  /** The version to record calls under, over the one the server gives itself (contract, 3.6). */
  serverVersion?: string | undefined;
  /** Tools left out of the numbers entirely (contract, 3.3). */
  exclude?: readonly string[] | undefined;
  /** Names and types of the arguments, never values (contract, 5). Off unless asked for. */
  captureParameterNames?: boolean | undefined;
  /** The text of a failure. On unless turned off. */
  captureErrorMessages?: boolean | undefined;
}

/** Requests waiting for their answer, per connection; past this the oldest is forgotten. */
const MAX_PENDING = 1_000;

/** Tools in a listing beyond this are left out (contract, 3.11). */
const MAX_LISTED_TOOLS = 500;

/** The API takes a version of at most this many characters. */
const MAX_VERSION_LENGTH = 100;

/** Where a request on the 2026-07-28 protocol names its client. */
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/** Where a result on the 2026-07-28 protocol names its server. */
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

/** JSON-RPC's code for invalid params: how MCP SDKs refuse arguments, and some of them unknown tools. */
const INVALID_PARAMS = -32602;

/** MCP's code for a resource that does not exist. */
const RESOURCE_NOT_FOUND = -32002;

const OBSERVED_METHODS = new Set([
  'tools/call',
  'tools/list',
  'resources/read',
  'resources/list',
  'resources/templates/list',
  'prompts/get',
  'prompts/list',
  'initialize',
  'server/discover',
]);

type Params = Record<string, unknown>;

interface Pending {
  method: string;
  params: Params;
  timestamp: string;
  startedAt: number;
  client: ClientInfo | undefined;
  repeated: boolean;
}

interface Outcome {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export class Observer {
  readonly catalog = new Catalog();
  /** The version the server gave itself in its latest handshake. */
  private announcedVersion: string | undefined;
  private readonly excluded: ReadonlySet<string>;

  constructor(private readonly options: ObserverOptions) {
    this.excluded = new Set(options.exclude ?? []);
  }

  /**
   * One connection between a client and the server. `sessionId` is the
   * session its calls are grouped under (contract, 8), made by whoever opens
   * the connection; absent where calls have none.
   */
  connection(sessionId?: string): Connection {
    return new Connection(this, sessionId);
  }

  /**
   * @internal The version the server gives itself: in the answer to
   * `initialize`, or on the 2026-07-28 protocol in a result's `_meta`.
   */
  noteServerInfo(result: unknown): void {
    if (!isObject(result)) return;
    const meta = isObject(result['_meta']) ? result['_meta'] : {};
    const info = isObject(result['serverInfo']) ? result['serverInfo'] : meta[SERVER_INFO_META_KEY];
    const version = isObject(info) ? info['version'] : undefined;
    if (typeof version === 'string' && version.trim().length > 0) this.announcedVersion = version.trim();
  }

  /** @internal */
  isExcluded(name: string): boolean {
    return this.excluded.has(name);
  }

  /** @internal Sends one event, with what every event carries. */
  emit(
    pending: Pending,
    sessionId: string | undefined,
    fields: Omit<ToolCallEvent, 'id' | 'clientType' | 'timestamp' | 'sdkVersion' | 'durationMs'> & { durationMs?: number },
  ): void {
    const name = clientName(pending.client);
    const clientVersion = pending.client?.version?.trim();
    const serverVersion = this.options.serverVersion?.trim() || this.announcedVersion;
    const { errorMessage, ...rest } = fields;

    try {
      this.options.record({
        id: randomUUID(),
        durationMs: performance.now() - pending.startedAt,
        clientType: 'unknown',
        ...(name !== undefined && { clientName: name }),
        ...(clientVersion ? { clientVersion: truncate(clientVersion, MAX_VERSION_LENGTH) } : {}),
        ...(serverVersion ? { serverVersion: truncate(serverVersion, MAX_VERSION_LENGTH) } : {}),
        timestamp: pending.timestamp,
        sdkVersion: SDK_VERSION,
        ...(sessionId !== undefined && { sessionId }),
        ...rest,
        ...(errorMessage !== undefined && this.options.captureErrorMessages !== false && { errorMessage }),
      });
    } catch {
      // Recording a call must never disturb the call.
    }
  }

  /** @internal */
  parameters(args: unknown): { parameters?: Record<string, string> } {
    if (this.options.captureParameterNames !== true) return {};
    const parameters = describeParameters([args]);
    return parameters === undefined ? {} : { parameters };
  }
}

export class Connection {
  private readonly pending = new Map<string, Pending>();
  /** The client as it named itself in the handshake. */
  private client: ClientInfo | undefined;

  constructor(
    private readonly observer: Observer,
    /** Settable: over HTTP a connection gets its session only when the server answers the handshake with one. */
    public sessionId: string | undefined,
  ) {}

  /** A message (or a batch of them) the client sent to the server. */
  fromClient(message: unknown): void {
    try {
      for (const one of Array.isArray(message) ? message : [message]) this.request(one);
    } catch {
      // A message the observer cannot read goes past unrecorded.
    }
  }

  /** A message (or a batch of them) the server sent to the client. */
  fromServer(message: unknown): void {
    try {
      for (const one of Array.isArray(message) ? message : [message]) this.answer(one);
    } catch {
      // A message the observer cannot read goes past unrecorded.
    }
  }

  /** The connection ended: requests still waiting will not be answered on it. */
  close(): void {
    this.pending.clear();
  }

  private request(message: unknown): void {
    if (!isObject(message) || typeof message['method'] !== 'string') return;
    const method = message['method'];
    const params = isObject(message['params']) ? message['params'] : {};

    if (method === 'notifications/cancelled') {
      // A cancelled request is answered, if at all, with nothing worth counting.
      const id = params['requestId'];
      if (isId(id)) this.pending.delete(key(id));
      return;
    }

    const id = message['id'];
    if (!isId(id) || !OBSERVED_METHODS.has(method)) return;

    if (method === 'initialize' && isObject(params['clientInfo'])) {
      this.client = clientInfo(params['clientInfo']) ?? this.client;
    }
    const meta = isObject(params['_meta']) ? params['_meta'] : {};
    const client = clientInfo(meta[CLIENT_INFO_META_KEY]) ?? this.client;

    this.pending.set(key(id), {
      method,
      params,
      timestamp: new Date().toISOString(),
      startedAt: performance.now(),
      client,
      repeated: method === 'tools/call' && this.repeats(params),
    });
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  /** Whether a call repeats the previous one to the same tool in this session (contract, 3.9). */
  private repeats(params: Params): boolean {
    const name = params['name'];
    if (this.sessionId === undefined || typeof name !== 'string') return false;
    // An answer to an interim result's question continues the call that asked.
    if (params['inputResponses'] !== undefined || params['requestState'] !== undefined) return false;

    return noteArguments(this.sessionId, name, params['arguments']);
  }

  private answer(message: unknown): void {
    if (!isObject(message) || message['method'] !== undefined) return;
    const id = message['id'];
    if (!isId(id)) return;

    const pending = this.pending.get(key(id));
    if (pending === undefined) return;
    this.pending.delete(key(id));

    const outcome: Outcome = 'error' in message && isObject(message['error'])
      ? { error: message['error'] }
      : { result: message['result'] };

    this.observer.noteServerInfo(outcome.result);

    switch (pending.method) {
      case 'tools/list':
        this.listing(pending, outcome.result);
        return;
      case 'resources/list':
      case 'resources/templates/list':
      case 'prompts/list':
        this.learn(pending, outcome.result);
        return;
      case 'tools/call':
        this.toolCall(pending, outcome);
        return;
      case 'resources/read':
        this.resourceRead(pending, outcome);
        return;
      case 'prompts/get':
        this.promptGet(pending, outcome);
        return;
    }
  }

  /** Notes the tools listed (contract, 3.8) and records the listing (3.11). */
  private listing(pending: Pending, result: unknown): void {
    if (!isObject(result)) return;
    const { firstPage, lastPage } = pages(pending, result);
    const listed = noteListing(result);
    this.observer.catalog.tools.learn(names(result['tools'], 'name'), firstPage, lastPage);

    const listedTools = listed
      .filter((tool) => !this.observer.isExcluded(tool.name))
      .slice(0, MAX_LISTED_TOOLS)
      .map((tool) => ({ ...tool, name: truncate(tool.name, MAX_NAME_LENGTH) }));
    const signature = listedTools.map((tool) => `${tool.name}\u0000${tool.definitionHash}`).join('\u0000');
    if (!firstListing(this.sessionId, signature)) return;

    this.observer.emit(pending, this.sessionId, {
      kind: 'listing',
      toolName: 'tools/list',
      durationMs: 0,
      success: true,
      listedTools,
    });
  }

  private learn(pending: Pending, result: unknown): void {
    if (!isObject(result)) return;
    const { firstPage, lastPage } = pages(pending, result);
    const catalog = this.observer.catalog;

    if (pending.method === 'prompts/list') catalog.prompts.learn(names(result['prompts'], 'name'), firstPage, lastPage);
    if (pending.method === 'resources/list') catalog.resources.learn(names(result['resources'], 'uri'), firstPage, lastPage);
    if (pending.method === 'resources/templates/list') {
      catalog.learnTemplates(names(result['resourceTemplates'], 'uriTemplate'), firstPage, lastPage);
    }
  }

  private toolCall(pending: Pending, outcome: Outcome): void {
    const name = pending.params['name'];
    if (typeof name !== 'string' || this.observer.isExcluded(name)) return;
    if (outcome.result !== undefined && settlesNothing(outcome.result)) return;

    const args = pending.params['arguments'];
    const common = {
      toolName: truncate(name, MAX_NAME_LENGTH),
      ...this.observer.parameters(args),
      ...(pending.repeated && { repeated: true }),
    };
    const failed = outcome.error !== undefined || isErrorResult(outcome.result);

    if (!failed) {
      this.observer.emit(pending, this.sessionId, { ...common, success: true, ...size(outcome.result), ...definition(name) });
      return;
    }

    const tools = this.observer.catalog.tools;
    if (tools.known && !tools.has(name)) {
      this.observer.emit(pending, this.sessionId, { ...common, success: false, errorSource: 'unknown_tool' });
      return;
    }

    // A refusal carries no message: a validator's can quote the value sent (contract, 3.2).
    const refused = invalidArguments(schemaOf(name), args).map((argument) => truncate(argument, MAX_NAME_LENGTH));
    if (refused.length > 0 || outcome.error?.code === INVALID_PARAMS) {
      this.observer.emit(pending, this.sessionId, {
        ...common,
        success: false,
        errorSource: 'arguments',
        ...definition(name),
        ...(refused.length > 0 && { invalidArguments: refused }),
      });
      return;
    }

    if (outcome.error !== undefined) {
      this.observer.emit(pending, this.sessionId, { ...common, success: false, ...protocolError(outcome.error), ...definition(name) });
      return;
    }

    const errorMessage = describeErrorResult(outcome.result);
    this.observer.emit(pending, this.sessionId, {
      ...common,
      success: false,
      errorSource: 'result',
      ...(errorMessage !== undefined && { errorMessage }),
      ...size(outcome.result),
      ...definition(name),
    });
  }

  private resourceRead(pending: Pending, outcome: Outcome): void {
    const uri = pending.params['uri'];
    if (typeof uri !== 'string') return;
    if (outcome.result !== undefined && settlesNothing(outcome.result)) return;

    const resolved = this.observer.catalog.resolveResource(uri);
    const common = { kind: 'resource' as const, ...this.observer.parameters(resolved.variables) };

    if (outcome.error === undefined) {
      this.observer.emit(pending, this.sessionId, { ...common, toolName: truncate(resolved.name, MAX_NAME_LENGTH), success: true, ...size(outcome.result) });
      return;
    }

    if (outcome.error.code === RESOURCE_NOT_FOUND || resolved.exists === false) {
      // Named by its scheme alone: the address a client asked for can hold a user's data (contract, 3.5).
      this.observer.emit(pending, this.sessionId, { kind: 'resource', toolName: schemeOf(uri), success: false, errorSource: 'unknown_resource' });
      return;
    }

    this.observer.emit(pending, this.sessionId, {
      ...common,
      toolName: truncate(resolved.name, MAX_NAME_LENGTH),
      success: false,
      ...protocolError(outcome.error),
    });
  }

  private promptGet(pending: Pending, outcome: Outcome): void {
    const name = pending.params['name'];
    if (typeof name !== 'string') return;
    if (outcome.result !== undefined && settlesNothing(outcome.result)) return;

    const common = { kind: 'prompt' as const, toolName: truncate(name, MAX_NAME_LENGTH), ...this.observer.parameters(pending.params['arguments']) };

    if (outcome.error === undefined) {
      this.observer.emit(pending, this.sessionId, { ...common, success: true, ...size(outcome.result) });
      return;
    }

    const prompts = this.observer.catalog.prompts;
    let errorSource: ErrorSource | undefined;
    if (prompts.known && !prompts.has(name)) errorSource = 'unknown_prompt';
    else if (outcome.error.code === INVALID_PARAMS) errorSource = 'arguments';

    this.observer.emit(pending, this.sessionId, {
      ...common,
      success: false,
      ...(errorSource === undefined ? protocolError(outcome.error) : { errorSource }),
    });
  }
}

/** Which page of a list an answer is: the first has no cursor in its request, the last none in its answer. */
function pages(pending: Pending, result: Params): { firstPage: boolean; lastPage: boolean } {
  return {
    firstPage: pending.params['cursor'] === undefined,
    lastPage: typeof result['nextCursor'] !== 'string',
  };
}

/** The string field `field` of each object in a list. */
function names(list: unknown, field: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => (isObject(item) && typeof item[field] === 'string' ? [item[field]] : []));
}

/**
 * An answer that settles nothing yet: an interim result asking the client for
 * input (2026-07-28), or a task the client will poll. The call is recorded
 * when something settles it, as the SDKs do (contract, 3.1).
 */
function settlesNothing(result: unknown): boolean {
  return isObject(result) && (result['resultType'] === 'input_required' || isObject(result['task']));
}

/** A protocol error as a failure: `exception`, since the server raised it rather than answered. */
function protocolError(error: { message?: unknown }): { errorSource: ErrorSource; errorMessage?: string } {
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  return {
    errorSource: 'exception',
    ...(message.length > 0 && { errorMessage: truncate(message, MAX_EXCEPTION_MESSAGE_LENGTH) }),
  };
}

function size(result: unknown): { responseBytes?: number } {
  const bytes = responseBytes(result);
  return bytes === undefined ? {} : { responseBytes: bytes };
}

function definition(name: string): { definitionHash?: string } {
  const hash = definitionOf(name);
  return hash === undefined ? {} : { definitionHash: hash };
}

function clientInfo(value: unknown): ClientInfo | undefined {
  if (!isObject(value)) return undefined;
  const { name, version } = value;
  if (typeof name !== 'string' && typeof version !== 'string') return undefined;
  return {
    ...(typeof name === 'string' && { name }),
    ...(typeof version === 'string' && { version }),
  };
}

function isId(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

/** Keeps `1` and `"1"` apart: JSON-RPC does. */
function key(id: string | number): string {
  return `${typeof id}:${id}`;
}

function isObject(value: unknown): value is Params {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
