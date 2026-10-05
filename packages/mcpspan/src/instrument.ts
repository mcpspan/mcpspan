import { withCall } from './call.js';
import { clientFor, serverVersionOf } from './client.js';
import { configure, isCollecting, type McpspanConfig } from './config.js';
import { noteListing } from './definition.js';
import { describeErrorResult, formatError, isErrorResult } from './failure.js';
import { isExcluded, isMarked } from './marks.js';
import { PRIMITIVE_METHODS, watchPrimitive } from './primitives.js';
import { sessionFor } from './session.js';
import { isRecording, recordRefusedCall, track } from './track.js';
import type { ErrorSource } from './types.js';

/**
 * Methods an MCP server registers tools through.
 *
 * `registerTool` is the current one, in both major versions of the official
 * SDK. `tool` is deprecated in v1 and gone from v2, but it is what most v1
 * servers written so far actually call, and instrumenting only the modern
 * name would silently miss them.
 */
const REGISTRATION_METHODS = ['registerTool', 'tool'] as const;

type AnyFunction = (...args: never[]) => unknown;

interface ServerLike {
  server?: {
    setRequestHandler?: AnyFunction;
    /**
     * Where the protocol layer keeps its handlers, by method, in both major
     * versions of the official SDK. Not public API, and read only to find a
     * handler installed before instrument() ran; see interceptToolCalls.
     */
    _requestHandlers?: unknown;
  };
}

/**
 * The inner servers whose `tools/call` handler is already watched, so a
 * second instrument() on the same server does not watch it twice.
 */
const intercepted = new WeakSet<object>();

/** Marks a wrapped method, so instrumenting the same server twice is harmless. */
const INSTRUMENTED = Symbol.for('mcpspan.instrumented');

/** What was registered under one name, as far as refusals need to know. */
interface ToolEntry {
  excluded: boolean;
  /** What the server handed back from registration. Carries `enabled`. */
  registered: unknown;
}

/** The tools each instrumented server registered, by name. */
const registries = new WeakMap<object, Map<string, ToolEntry>>();

/**
 * Request contexts whose call reached a tool handler.
 *
 * The server hands the same context object to the request handler and to the
 * tool handler it calls, so a call whose context is not in here by the time
 * the request is answered never got as far as the handler: the server refused
 * it on its own. A weak set, so contexts leave with their requests.
 */
const reachedHandler = new WeakSet<object>();

/**
 * Request contexts whose handler last answered with an interim
 * `input_required` result (the 2026-07-28 protocol's way to ask the client for
 * more). `track` does not count that answer, because the retry that follows is
 * the call that completes. But where the SDK cannot serve the interim answer -
 * a stateless 2025-era endpoint has no way to put a question to the client -
 * it turns it into an error for the client instead, after the handler has
 * returned, and without this the call would be counted nowhere at all.
 */
const endedInterim = new WeakSet<object>();

/**
 * Records every tool a server registers from this point on.
 *
 * This is the whole integration:
 *
 * ```ts
 * const server = new McpServer({ name: 'flights', version: '1.0.0' });
 * instrument(server, { apiKey: process.env.MCPSPAN_API_KEY });
 * ```
 *
 * Tools registered afterwards are wrapped as they are registered, and tools
 * registered before it are wrapped where they already are, so nothing about
 * how they are declared, or where this line sits, has to change.
 *
 * **Never throws.** An unfamiliar server object, or one with no registration
 * method at all, leaves the server exactly as it was and collects nothing. A
 * telemetry library that can stop somebody's server from starting has failed
 * at the only thing it truly must not do.
 */
export function instrument<TServer extends object>(
  server: TServer,
  config?: McpspanConfig,
): TServer {
  const debug = config?.debug ?? false;

  try {
    // Given a config, apply it. Given none, only set things up if nothing has
    // been set up yet - otherwise calling configure() first and instrument()
    // second would silently undo the first call, and there would be no way to
    // tell from the outside why the dashboard stayed empty.
    if (config !== undefined || !isCollecting()) {
      configure(config ?? {});
    }

    const registry = registries.get(server) ?? new Map<string, ToolEntry>();
    registries.set(server, registry);

    wrapRegistration(server, registry, debug);
    wrapRegistered(server, registry);
    interceptToolCalls(server, registry);
  } catch (error) {
    if (debug) {
      console.error(`mcpspan: could not instrument this server (${formatError(error)})`);
    }
  }

  return server;
}

function wrapRegistration(
  server: object,
  registry: Map<string, ToolEntry>,
  debug: boolean,
): void {
  const target = server as Record<string, unknown>;
  let wrapped = false;

  for (const method of REGISTRATION_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    if ((original as unknown as Record<symbol, unknown>)[INSTRUMENTED] === true) {
      wrapped = true;
      continue;
    }

    target[method] = createWrapper(original as AnyFunction, server, registry);
    wrapped = true;
  }

  if (!wrapped && debug) {
    console.error(
      'mcpspan: this server has no registerTool or tool method, so nothing was instrumented',
    );
  }
}

/**
 * Measures tools the server already had when instrument() ran.
 *
 * Both major versions of the official SDK keep registered tools by name, and
 * give each an `update` that swaps its handler: `update({ callback })` is
 * public API, and in v2 it also rebuilds what actually calls the handler, so
 * replacing the field alone would change nothing there. Only finding the
 * tools reads the SDK's private registry; if a version moves it, tools
 * registered before instrument() go unmeasured, as they did before.
 *
 * Swapping a handler on a connected server makes the SDK tell the client
 * the tool list changed. It did not, and a client lists the same tools again.
 */
function wrapRegistered(server: object, registry: Map<string, ToolEntry>): void {
  const tools = (server as { _registeredTools?: unknown })._registeredTools;

  if (typeof tools !== 'object' || tools === null) return;

  for (const [name, tool] of Object.entries(tools as Record<string, unknown>)) {
    // Already seen, by this instrument() or an earlier one on the same server.
    if (registry.has(name)) continue;

    const entry = tool as { handler?: unknown; update?: unknown } | null;
    const handler = entry?.handler;

    // A task tool's handler is an object, not a function, and is left alone,
    // as it is when registered afterwards.
    if (typeof handler !== 'function' || typeof entry?.update !== 'function') continue;

    try {
      if (isExcluded(handler)) {
        registry.set(name, { excluded: true, registered: tool });
        continue;
      }

      const tracked = isMarked(handler) ? handler : track(name, handler as AnyFunction);
      (entry.update as (updates: { callback: unknown }) => void).call(entry, {
        callback: noteReached(tracked as AnyFunction, server),
      });
      registry.set(name, { excluded: false, registered: tool });
    } catch {
      // A tool that cannot be wrapped runs unmeasured, and otherwise as before.
    }
  }
}

/**
 * Wraps a registration method without needing to know its overloads.
 *
 * Both `tool` and `registerTool` have several shapes - with a description,
 * with a schema, with annotations - and across every one of them the name is
 * the first argument and the handler is the last. Leaning on that is far
 * sturdier than trying to work out which overload was called, and it survives
 * the SDK adding another.
 */
function createWrapper(
  original: AnyFunction,
  server: object,
  registry: Map<string, ToolEntry>,
): AnyFunction {
  const wrapper = function instrumentedRegistration(this: unknown, ...args: unknown[]): unknown {
    const name = args[0];
    const lastIndex = args.length - 1;
    const handler = args[lastIndex];

    if (typeof name !== 'string' || typeof handler !== 'function' || lastIndex < 1) {
      // Not a shape we recognise. Register it exactly as asked and stay out of
      // the way.
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    }

    if (isExcluded(handler)) {
      // Set aside by exclude(): never counted, not even when the server
      // refuses a call to it.
      const registered = (original as (...a: unknown[]) => unknown).apply(this, args);
      registry.set(name, { excluded: true, registered });

      return registered;
    }

    // Already wrapped by track() is left as it is: wrapping it again would
    // count every call to it twice.
    const tracked = isMarked(handler) ? handler : track(name, handler as AnyFunction);

    const instrumented = [...args];
    instrumented[lastIndex] = noteReached(tracked as AnyFunction, server);

    const registered = (original as (...a: unknown[]) => unknown).apply(this, instrumented);
    registry.set(name, { excluded: false, registered });

    return registered;
  };

  Object.defineProperty(wrapper, INSTRUMENTED, { value: true });

  return wrapper as AnyFunction;
}

/**
 * Remembers that a call got as far as its handler, and tells `track` which
 * connection and client it came from.
 *
 * The context is the last argument whatever the tool's shape: `(args, extra)`
 * for a tool with a schema, `(extra)` for one without; `ctx` in place of
 * `extra` in v2 of the official SDK.
 */
function noteReached(handler: AnyFunction, server: object): AnyFunction {
  return function reachedToolHandler(this: unknown, ...args: unknown[]): unknown {
    const context = args.at(-1);
    const run = () => (handler as (...a: unknown[]) => unknown).apply(this, args);
    const hasContext = typeof context === 'object' && context !== null;

    if (hasContext) reachedHandler.add(context);

    const sessionId = hasContext ? sessionFor(server, context) : undefined;
    const client = clientFor(server, hasContext ? context : undefined);
    const serverVersion = serverVersionOf(server);

    const result = withCall(
      {
        ...(sessionId !== undefined && { sessionId }),
        ...(client !== undefined && { client }),
        ...(serverVersion !== undefined && { serverVersion }),
      },
      run,
    );

    if (hasContext) noteInterim(context, result);

    return result;
  };
}

/** Keeps `endedInterim` in step with how the handler's latest answer ended. */
function noteInterim(context: object, result: unknown): void {
  const settle = (value: unknown): void => {
    const interim =
      typeof value === 'object' &&
      value !== null &&
      (value as { resultType?: unknown }).resultType === 'input_required';

    if (interim) endedInterim.add(context);
    else endedInterim.delete(context);
  };

  if (result instanceof Promise) {
    // Observed, not awaited: the caller gets the handler's own promise, and a
    // rejection here is the caller's to handle, not ours.
    result.then(settle, () => endedInterim.delete(context));
  } else {
    settle(result);
  }
}

/**
 * Sees the calls a server refuses before any handler runs.
 *
 * Wrapping handlers only sees calls that reach them. An MCP server validates
 * arguments against the tool's schema first, and answers a call to a tool it
 * does not have, and both come back to the model as ordinary error results.
 * Bad arguments are the commonest way an agent fails, and none of it was
 * counted: a server's error rate read lower than what agents experienced.
 *
 * Hooks the request handler the server installs for `tools/call`, the layer
 * that answers the client. Every handler set on the connection passes through
 * here, and all but that one are handed over untouched.
 */
function interceptToolCalls(server: object, registry: Map<string, ToolEntry>): void {
  const inner = (server as ServerLike).server;
  const original = inner?.setRequestHandler;

  if (inner === undefined || typeof original !== 'function') return;
  if (intercepted.has(inner)) return;

  intercepted.add(inner);

  // A handler already installed. v2 of the official SDK installs `tools/call`
  // in the McpServer constructor when the server declares the tools
  // capability, which its own examples do, so by the time instrument() runs
  // there is nothing left to catch on the way in. The installed handler is
  // wrapped where the protocol layer keeps it instead. That store is private
  // to the SDK; if a version moves it, this finds nothing and refused calls
  // go uncounted on those servers, which is the safe way for it to fail.
  const handlers = inner._requestHandlers;

  if (handlers instanceof Map) {
    for (const method of ['tools/call', 'tools/list', ...PRIMITIVE_METHODS]) {
      const installed: unknown = handlers.get(method);
      if (typeof installed === 'function') handlers.set(method, watch(installed as AnyFunction, server, registry));
    }
  }

  const wrapped = function instrumentedSetRequestHandler(
    this: unknown,
    schema: unknown,
    handler: unknown,
  ): unknown {
    const replacement =
      typeof handler === 'function' ? watch(handler as AnyFunction, server, registry) : handler;

    return (original as (...a: unknown[]) => unknown).call(this, schema, replacement);
  };

  Object.defineProperty(wrapped, INSTRUMENTED, { value: true });
  inner.setRequestHandler = wrapped as AnyFunction;
}

/**
 * Watches a request handler for the calls this SDK records: tool calls, and
 * resource reads and prompt gets (see primitives.ts). Each watcher looks at
 * the request's method when it arrives and passes anything else straight on,
 * so the handler for any other method runs exactly as it did.
 */
function watch(handler: AnyFunction, server: object, registry: Map<string, ToolEntry>): AnyFunction {
  return watchListing(watchPrimitive(watchToolCalls(handler, server, registry), server));
}

/** Notes the tools a `tools/list` answer describes, for the fingerprint each call carries (contract, 3.8). */
function watchListing(handler: AnyFunction): AnyFunction {
  return async function watchedListing(this: unknown, request: { method?: unknown }, ...rest: unknown[]): Promise<unknown> {
    const result: unknown = await (handler as (...a: unknown[]) => unknown).call(this, request, ...rest);
    if (request?.method === 'tools/list' && isRecording()) noteListing(result);
    return result;
  };
}

interface ToolCallRequest {
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

function watchToolCalls(
  handler: AnyFunction,
  server: object,
  registry: Map<string, ToolEntry>,
): AnyFunction {
  return async function watchedRequestHandler(
    this: unknown,
    request: ToolCallRequest,
    context: unknown,
  ): Promise<unknown> {
    const call = (handler as (...a: unknown[]) => unknown).bind(this, request, context);

    if (!isRecording() || request?.method !== 'tools/call') return call();

    const timestamp = new Date().toISOString();
    const startedAt = performance.now();

    const noteRefusal = (message: string | undefined): void => {
      try {
        const reached =
          typeof context === 'object' && context !== null && reachedHandler.has(context);
        const name = request.params?.name;

        if (typeof name !== 'string') return;

        if (reached) {
          // The handler ran and asked the client for more, and the server
          // could not ask: the client got an error, from a call the handler
          // side left uncounted on purpose.
          if (endedInterim.has(context as object)) {
            recordRefusedCall({
              toolName: name,
              errorSource: 'result',
              ...(message !== undefined && { errorMessage: message }),
              arguments: request.params?.arguments,
              timestamp,
              durationMs: performance.now() - startedAt,
              sessionId: sessionFor(server, context),
              client: clientFor(server, context),
              serverVersion: serverVersionOf(server),
            });
          }

          return;
        }

        const errorSource = classifyRefusal(registry.get(name), message);

        if (errorSource === undefined) return;

        recordRefusedCall({
          toolName: name,
          errorSource,
          arguments: request.params?.arguments,
          timestamp,
          durationMs: performance.now() - startedAt,
          sessionId: sessionFor(server, context),
          client: clientFor(server, context),
          serverVersion: serverVersionOf(server),
        });
      } catch {
        // Looking at a refusal must never change it.
      }
    };

    // Whatever the server answers or throws goes back unchanged. This only
    // looks at it on its way past.
    let result: unknown;

    try {
      result = await call();
    } catch (error) {
      // v2 of the official SDK answers a call to a tool it does not have, or
      // has disabled, with a protocol error rather than an error result, so
      // the refusal arrives here instead.
      noteRefusal(error instanceof Error ? error.message : undefined);
      throw error;
    }

    if (isErrorResult(result)) noteRefusal(describeErrorResult(result));

    return result;
  };
}

/**
 * Names the reason a call never reached its handler, or declines to guess.
 *
 * Which tool it was decides most of it: one we registered and is enabled was
 * refused over its arguments; one we never saw, or that is disabled, does not
 * exist as far as the client is concerned. The server's wording is checked as
 * well, so that anything else refused on the way - a misconfigured task tool,
 * a tool renamed after registration - is left out rather than miscounted. If
 * that wording ever changes, the effect is that fewer refusals are recorded,
 * never that the wrong ones are.
 */
function classifyRefusal(
  entry: ToolEntry | undefined,
  message: string | undefined,
): ErrorSource | undefined {
  if (entry?.excluded === true) return undefined;

  const registered = entry?.registered as { enabled?: unknown } | undefined;
  const enabled = entry !== undefined && registered?.enabled !== false;
  const text = message ?? '';

  if (enabled) return /validation/i.test(text) ? 'arguments' : undefined;

  return /not found|disabled/i.test(text) ? 'unknown_tool' : undefined;
}
