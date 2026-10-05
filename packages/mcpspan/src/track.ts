import { randomUUID } from 'node:crypto';

import { currentCall } from './call.js';
import { type ClientInfo, clientName, detectClient } from './client.js';
import {
  describeErrorResult,
  describeException,
  isErrorResult,
  MAX_NAME_LENGTH,
  truncate,
} from './failure.js';
import { markExcluded, markHandler } from './marks.js';
import { describeParameters } from './parameters.js';
import type { ErrorSource, ToolCallEvent } from './types.js';
import { SDK_VERSION } from './version.js';

type EventSink = (event: ToolCallEvent) => void;

let sink: EventSink | undefined;
let captureParameterNames = false;
let configuredServerVersion: string | undefined;

/** The API takes a version of at most this many characters; longer is cut rather than lose the batch. */
const MAX_VERSION_LENGTH = 100;

/**
 * Records every call under this version, whatever the server gives itself.
 *
 * Internal: set by configuration from its `serverVersion` setting.
 */
export function setServerVersion(version: string | undefined): void {
  configuredServerVersion = version;
}

/**
 * Who called and which version answered, as every kind of event carries it.
 * In one place, so a tool call, a refusal and a resource read cannot drift.
 */
function identity(
  client: ClientInfo | undefined,
  serverVersion: string | undefined,
): Pick<ToolCallEvent, 'clientType' | 'clientName' | 'clientVersion' | 'serverVersion'> {
  const name = clientName(client);
  const clientVersion = client?.version?.trim();
  const version = configuredServerVersion ?? serverVersion;

  return {
    clientType: detectClient(client),
    ...(name !== undefined && { clientName: name }),
    ...(clientVersion ? { clientVersion: truncate(clientVersion, MAX_VERSION_LENGTH) } : {}),
    ...(version ? { serverVersion: truncate(version, MAX_VERSION_LENGTH) } : {}),
  };
}

/**
 * Turns on recording of parameter names and types.
 *
 * Off unless a developer asks for it, and even then values are never read.
 *
 * Internal, not part of the package's public API.
 */
export function setCaptureParameterNames(enabled: boolean): void {
  captureParameterNames = enabled;
}

/**
 * Points recorded events somewhere, or nowhere.
 *
 * Passing `undefined` turns collection off: wrapped handlers then run through
 * an early return, without a timestamp, an identifier or an event ever being
 * built. That is the state an unconfigured SDK sits in, and it has to cost
 * nothing.
 *
 * Internal: this is how configuration attaches a reporter to the wrapper, and
 * how tests observe what a wrapped call produced. It is not part of the
 * package's public API.
 */
export function setEventSink(next: EventSink | undefined): void {
  sink = next;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/**
 * Wraps a tool handler so its calls are recorded.
 *
 * The returned function keeps the handler's exact signature, including its
 * `this`, and passes the result back untouched. Whatever the handler is to the
 * code around it, the wrapper has to be indistinguishable - the moment using
 * this changes how a tool behaves, it stops being an observability library and
 * becomes a liability.
 *
 * Synchronous handlers are measured as they return. Asynchronous ones are
 * measured when their promise settles, since the time a tool takes is the time
 * the agent waits for it, not the time spent building the promise.
 *
 * Failure is recognised in both of its MCP forms: a result the tool marked
 * with `isError`, which the specification treats as the ordinary way to report
 * a problem, and a thrown exception, which usually means the handler broke.
 *
 * Arguments are never read. Nothing a caller passes to a tool reaches an
 * event.
 */
export function track<TArgs extends unknown[], TResult>(
  toolName: string,
  handler: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  // Cut once, here, rather than on every call. A name the API would refuse
  // would take every other event in its batch with it.
  const recordedName = truncate(toolName, MAX_TOOL_NAME_LENGTH);

  return markHandler(function tracked(this: unknown, ...args: TArgs): TResult {
    // Without somewhere to send events there is no reason to build one. An SDK
    // nobody configured should be indistinguishable from an SDK nobody
    // installed.
    const active = sink;
    if (active === undefined) return handler.apply(this, args);

    // First, before the handler can run anything else. A call that arrived
    // through instrument() carries its own session and client; track() used
    // on its own has neither.
    const call = currentCall();
    const session = call?.sessionId;
    const timestamp = new Date().toISOString();
    // Monotonic, so a clock adjustment mid-call cannot produce a negative or
    // wildly inflated duration.
    const startedAt = performance.now();
    let recorded = false;

    const emit = (outcome: Partial<ToolCallEvent> & { success: boolean }): void => {
      if (recorded) return;
      recorded = true;

      const parameters = captureParameterNames ? describeParameters(args) : undefined;

      try {
        active({
          id: randomUUID(),
          toolName: recordedName,
          durationMs: performance.now() - startedAt,
          ...identity(call?.client, call?.serverVersion),
          ...(parameters !== undefined && { parameters }),
          timestamp,
          sdkVersion: SDK_VERSION,
          ...(session !== undefined && { sessionId: session }),
          ...outcome,
        });
      } catch {
        // Recording a call must never be able to disturb the call itself.
      }
    };

    const settle = (value: unknown): void => {
      // An interim answer on the 2026-07-28 protocol, asking the client for
      // more before the tool can finish. The client retries the call with
      // what was asked for, and that retry is the call that completes; this
      // one is not counted, or one call would show as two.
      if (isInputRequired(value)) {
        recorded = true;
        return;
      }

      const size = responseBytes(value);
      const measured = size === undefined ? {} : { responseBytes: size };

      if (!isErrorResult(value)) {
        emit({ success: true, ...measured });
        return;
      }

      const errorMessage = describeErrorResult(value);
      emit({
        success: false,
        errorSource: 'result',
        ...(errorMessage !== undefined && { errorMessage }),
        ...measured,
      });
    };

    const fail = (error: unknown): void => {
      const { errorType, errorMessage } = describeException(error);
      emit({
        success: false,
        errorSource: 'exception',
        errorType,
        ...(errorMessage !== undefined && { errorMessage }),
      });
    };

    let result: TResult;
    try {
      result = handler.apply(this, args);
    } catch (error) {
      fail(error);
      throw error;
    }

    if (isPromiseLike(result)) {
      return result.then(
        (value) => {
          settle(value);
          return value;
        },
        (error: unknown) => {
          fail(error);
          throw error;
        },
      ) as TResult;
    }

    settle(result);
    return result;
  });
}

/**
 * Keeps a tool out of the numbers entirely.
 *
 * The counterpart to {@link track}: where that one records a handler, this one
 * marks it so that wrapping the server never touches it.
 *
 * ```ts
 * server.registerTool('health_check', schema, exclude(handler));
 * ```
 *
 * Meant for tools that are called by machinery rather than by an agent - a
 * health check polled every few seconds would outnumber everything a person
 * actually did, and would drag the error rate and response time of the whole
 * server towards its own.
 *
 * Takes no tool name on purpose. A name repeated here could drift from the
 * real one during a rename, and the exclusion would quietly stop applying.
 *
 * Does nothing on its own: without instrumentation there was nothing about to
 * record this handler anyway. The handler is returned exactly as given.
 */
export function exclude<THandler extends (...args: never[]) => unknown>(
  handler: THandler,
): THandler {
  return markExcluded(handler);
}

/** Longest tool name recorded, for handlers and refused calls alike. */
const MAX_TOOL_NAME_LENGTH = MAX_NAME_LENGTH;

/**
 * Records a call the MCP server answered without a handler's own result: one
 * it turned away before any handler ran, or one whose handler asked the client
 * for more when the server had no way to ask.
 *
 * A refusal carries no message on purpose. The server's text for a refusal is written
 * by a validation library, not by the developer, and some versions quote the
 * offending argument back - "received 'xyz'" - which would put a parameter
 * value into an event. Names and types of what was sent are recorded instead,
 * when the developer asked for them, since those are what say which argument
 * the agent got wrong.
 */
export function recordRefusedCall(refused: {
  toolName: string;
  errorSource: ErrorSource;
  /**
   * Text the SDK itself wrote, never a validator's: those can quote the value
   * the agent sent. Absent for refusals, as the note above says.
   */
  errorMessage?: string;
  /** The request's arguments object. Only names and types are ever read from it. */
  arguments: unknown;
  timestamp: string;
  durationMs: number;
  sessionId: string | undefined;
  client: ClientInfo | undefined;
  /** The version the server gives itself. */
  serverVersion?: string | undefined;
}): void {
  const active = sink;
  if (active === undefined) return;

  try {
    const parameters = captureParameterNames ? describeParameters([refused.arguments]) : undefined;

    active({
      id: randomUUID(),
      toolName: truncate(refused.toolName, MAX_TOOL_NAME_LENGTH),
      durationMs: refused.durationMs,
      success: false,
      errorSource: refused.errorSource,
      ...(refused.errorMessage !== undefined && { errorMessage: refused.errorMessage }),
      ...identity(refused.client, refused.serverVersion),
      ...(parameters !== undefined && { parameters }),
      timestamp: refused.timestamp,
      sdkVersion: SDK_VERSION,
      ...(refused.sessionId !== undefined && { sessionId: refused.sessionId }),
    });
  } catch {
    // Recording a refusal must never disturb the answer the client gets.
  }
}

/**
 * Records a resource read or a prompt got (contract, 3.5), however it ended.
 *
 * Built here beside tool calls so the two cannot drift: the same client, the
 * same session, the same limits, the same rule that arguments are described by
 * name and type and never kept.
 */
export function recordPrimitiveCall(call: {
  kind: 'resource' | 'prompt';
  name: string;
  success: boolean;
  errorSource?: ErrorSource;
  errorType?: string;
  errorMessage?: string;
  /** A prompt's arguments, or a template's variables. Only names and types are read. */
  arguments: unknown;
  timestamp: string;
  durationMs: number;
  sessionId: string | undefined;
  client: ClientInfo | undefined;
  /** The version the server gives itself. */
  serverVersion?: string | undefined;
  /** Size of the answer, when there was one (contract, 3.7). */
  responseBytes?: number | undefined;
}): void {
  const active = sink;
  if (active === undefined) return;

  try {
    const parameters = captureParameterNames ? describeParameters([call.arguments]) : undefined;

    active({
      id: randomUUID(),
      kind: call.kind,
      toolName: truncate(call.name, MAX_TOOL_NAME_LENGTH),
      durationMs: call.durationMs,
      success: call.success,
      ...(call.errorSource !== undefined && { errorSource: call.errorSource }),
      ...(call.errorType !== undefined && { errorType: call.errorType }),
      ...(call.errorMessage !== undefined && { errorMessage: call.errorMessage }),
      ...identity(call.client, call.serverVersion),
      ...(parameters !== undefined && { parameters }),
      timestamp: call.timestamp,
      sdkVersion: SDK_VERSION,
      ...(call.sessionId !== undefined && { sessionId: call.sessionId }),
      ...(call.responseBytes !== undefined && { responseBytes: call.responseBytes }),
    });
  } catch {
    // Recording must never disturb the answer the client gets.
  }
}

/** Whether anything is currently collecting, so callers can skip the work entirely. */
export function isRecording(): boolean {
  return sink !== undefined;
}

/** The largest size an event carries; anything larger is sent as this (contract, 3.7). */
const MAX_RESPONSE_BYTES = 2_147_483_647;

/**
 * Size of an answer, in bytes of its compact JSON (contract, 3.7), or undefined
 * when it cannot be encoded. The JSON is counted and dropped: nothing of it is
 * kept or sent.
 */
export function responseBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : Math.min(Buffer.byteLength(json, 'utf8'), MAX_RESPONSE_BYTES);
  } catch {
    // A result with a cycle or a BigInt in it cannot be measured; the call is recorded without it.
    return undefined;
  }
}

/** A result the 2026-07-28 protocol calls interim: the tool needs more input first. */
function isInputRequired(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { resultType?: unknown }).resultType === 'input_required'
  );
}
