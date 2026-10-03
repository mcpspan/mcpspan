import { clientFor, serverVersionOf } from './client.js';
import { describeException } from './failure.js';
import { sessionFor } from './session.js';
import { isRecording, recordPrimitiveCall } from './track.js';

/**
 * Resource reads and prompt gets (contract, 3.5).
 *
 * Measured at the request handler, where tool calls' refusals are seen too:
 * the official SDK answers `resources/read` and `prompts/get` itself, finding
 * the resource or prompt and handing the request to the developer's callback.
 * What was asked for is resolved against the server's own registry before the
 * request runs, which is what names it and says whether it exists. Both major
 * versions keep that registry in the same private fields; if a version moves
 * them, everything read is named by its scheme and counted as unknown, which
 * is wrong in a way the dashboard shows at once rather than quietly.
 */

type AnyFunction = (...args: never[]) => unknown;

interface PrimitiveRequest {
  method?: unknown;
  params?: { uri?: unknown; name?: unknown; arguments?: unknown };
}

interface Resolved {
  kind: 'resource' | 'prompt';
  /** The registered URI or template, the prompt's name, or the scheme of an unknown address. */
  name: string;
  exists: boolean;
  /** A prompt's arguments or a template's variables, for names and types only. */
  arguments: unknown;
}

export const PRIMITIVE_METHODS = ['resources/read', 'prompts/get'] as const;

function isPrimitiveMethod(method: unknown): boolean {
  return method === 'resources/read' || method === 'prompts/get';
}

/**
 * Whether an MCP SDK refused a prompt's arguments before its callback ran:
 * invalid params, in the words both major versions use (v1 prefixes them with
 * `MCP error -32602: `). A callback's own error with that code and other words
 * is left as the exception it is.
 */
function refusedArguments(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };

  return code === -32602 && typeof message === 'string' && message.includes('Invalid arguments for prompt');
}

/** The scheme of an address, which is all of an unknown one that may be kept: `db://`. */
export function schemeOf(uri: string): string {
  const colon = uri.indexOf(':');
  const scheme = colon > 0 ? uri.slice(0, colon) : '';

  return /^[a-z][a-z0-9+.-]*$/i.test(scheme) ? `${scheme}://` : 'unknown://';
}

function resolve(server: object, request: PrimitiveRequest): Resolved | undefined {
  const registry = server as {
    _registeredResources?: Record<string, { enabled?: unknown }>;
    _registeredResourceTemplates?: Record<
      string,
      { enabled?: unknown; resourceTemplate?: { uriTemplate?: { match?: (uri: string) => unknown } } }
    >;
    _registeredPrompts?: Record<string, { enabled?: unknown }>;
  };

  if (request.method === 'prompts/get') {
    const name = request.params?.name;
    if (typeof name !== 'string') return undefined;
    const prompt = registry._registeredPrompts?.[name];

    return { kind: 'prompt', name, exists: prompt !== undefined && prompt.enabled !== false, arguments: request.params?.arguments };
  }

  const uri = request.params?.uri;
  if (typeof uri !== 'string') return undefined;

  // The SDK looks an address up as the URL parser writes it back.
  let normalised = uri;
  try {
    normalised = new URL(uri).toString();
  } catch {
    // An address the SDK will refuse; it is looked up as sent, and not found.
  }

  const fixed = registry._registeredResources?.[normalised];
  if (fixed !== undefined) {
    return { kind: 'resource', name: normalised, exists: fixed.enabled !== false, arguments: undefined };
  }

  for (const template of Object.values(registry._registeredResourceTemplates ?? {})) {
    const uriTemplate = template.resourceTemplate?.uriTemplate;
    const variables = uriTemplate?.match?.(normalised);
    if (variables !== null && variables !== undefined) {
      return {
        kind: 'resource',
        name: String(uriTemplate),
        exists: template.enabled !== false,
        arguments: variables,
      };
    }
  }

  return { kind: 'resource', name: schemeOf(uri), exists: false, arguments: undefined };
}

/**
 * Wraps the handler the server installed for `resources/read` or
 * `prompts/get`. What it answers or throws goes back unchanged; this only
 * looks at it on its way past.
 */
export function watchPrimitive(handler: AnyFunction, server: object): AnyFunction {
  return async function watchedPrimitiveHandler(
    this: unknown,
    request: PrimitiveRequest,
    context: unknown,
  ): Promise<unknown> {
    const call = (handler as (...a: unknown[]) => unknown).bind(this, request, context);

    if (!isRecording() || !isPrimitiveMethod(request?.method)) return call();

    let resolved: Resolved | undefined;
    const timestamp = new Date().toISOString();
    const startedAt = performance.now();
    try {
      resolved = resolve(server, request);
    } catch {
      resolved = undefined;
    }
    if (resolved === undefined) return call();

    const record = (outcome: { success: boolean; errorSource?: 'exception' | 'arguments' | 'unknown_resource' | 'unknown_prompt'; error?: unknown }): void => {
      try {
        const exception = outcome.errorSource === 'exception' ? describeException(outcome.error) : undefined;
        recordPrimitiveCall({
          kind: resolved.kind,
          name: resolved.name,
          success: outcome.success,
          ...(outcome.errorSource !== undefined && { errorSource: outcome.errorSource }),
          ...(exception !== undefined && { errorType: exception.errorType }),
          ...(exception?.errorMessage !== undefined && { errorMessage: exception.errorMessage }),
          arguments: resolved.arguments,
          timestamp,
          durationMs: performance.now() - startedAt,
          sessionId: typeof context === 'object' && context !== null ? sessionFor(server, context) : undefined,
          client: clientFor(server, typeof context === 'object' && context !== null ? context : undefined),
          serverVersion: serverVersionOf(server),
        });
      } catch {
        // Looking at a call must never change it.
      }
    };

    let result: unknown;
    try {
      result = await call();
    } catch (error) {
      if (!resolved.exists) {
        record({ success: false, errorSource: resolved.kind === 'prompt' ? 'unknown_prompt' : 'unknown_resource' });
      } else if (resolved.kind === 'prompt' && refusedArguments(error)) {
        record({ success: false, errorSource: 'arguments' });
      } else {
        record({ success: false, errorSource: 'exception', error });
      }
      throw error;
    }

    // An interim answer asking the client for more settles nothing; the retry does.
    const interim =
      typeof result === 'object' && result !== null && (result as { resultType?: unknown }).resultType === 'input_required';
    if (!interim) record({ success: true });

    return result;
  };
}
