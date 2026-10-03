/**
 * Client application a tool call originated from, as far as the transport
 * allows us to tell.
 *
 * Over stdio the client is usually invisible to the server, which yields
 * `unknown`. `other` is different: a client did identify itself, we just do
 * not recognise it.
 */
export type ClientType =
  | 'claude'
  | 'claude-code'
  | 'cursor'
  | 'chatgpt'
  | 'mcp-inspector'
  | 'other'
  | 'unknown';

/**
 * How a failed tool call announced itself.
 *
 * MCP asks tools to report their own failures inside the result, with
 * `isError` set, so that the model can see what went wrong. A thrown exception
 * is the deviation from that, and usually means the handler crashed rather
 * than failing on purpose. Keeping the two apart lets a developer tell a
 * handled business error from a bug.
 *
 * The other two never reach a handler. The server refuses them itself, and
 * the model sees that refusal like any other error result.
 */
export type ErrorSource =
  | 'result'
  | 'exception'
  /** Refused by the server's schema validation before the handler ran. */
  | 'arguments'
  /** A tool name the server does not have, or has disabled. */
  | 'unknown_tool'
  /** A resource address the server has nothing registered for. */
  | 'unknown_resource'
  /** A prompt name the server does not have, or has disabled. */
  | 'unknown_prompt';

/** What an event is about: a tool call, a resource read, or a prompt got. */
type CallKind = 'tool' | 'resource' | 'prompt';

/**
 * A single tool invocation recorded by the SDK.
 *
 * The event carries no server identity on purpose. The ingest API derives that
 * from the API key the batch was sent with, so a caller cannot attribute tool
 * calls to a server it does not own.
 *
 * Parameter values are never part of an event, in any mode.
 */
export interface ToolCallEvent {
  /**
   * Identifies this call for as long as it takes to reach storage.
   *
   * A batch that times out after the server has already written it gets resent,
   * so ingest needs a way to recognise a replay and drop it. Without this, a
   * flaky network inflates the very numbers the product exists to report.
   */
  id: string;

  /** Absent for a tool call; `resource` or `prompt` for the others (contract, 3.5). */
  kind?: Exclude<CallKind, 'tool'>;

  /**
   * Name the tool was registered under; for a resource, its registered URI or
   * URI template; for a prompt, its name.
   */
  toolName: string;

  /** How long the call took, in milliseconds. May be fractional. */
  durationMs: number;

  /** False when the call was refused, the handler threw, or it returned `isError`. */
  success: boolean;

  /** Which failure path this call took. Absent on success. */
  errorSource?: ErrorSource;

  /** Constructor name of a thrown error, for example `TypeError`. Absent otherwise. */
  errorType?: string;

  /** Error message, truncated to a bounded length. Absent on success. */
  errorMessage?: string;

  /** Where the call came from, or `unknown` when nothing identified itself. */
  clientType: ClientType;

  /**
   * The name the client reported, as it reported it.
   *
   * Turns an unrecognised client into a lead rather than a dead end: a
   * dashboard showing forty percent `other` is useless if nobody can find out
   * what `other` was. This is an application's self-description, the MCP
   * equivalent of a User-Agent, and says nothing about whoever is using it.
   */
  clientName?: string;

  /** The version the client gives itself, as it gives it. */
  clientVersion?: string;

  /**
   * The version of the server that answered: the `serverVersion` setting, or
   * the version the MCP server gives itself.
   */
  serverVersion?: string;

  /** When the call started, as an ISO 8601 timestamp. */
  timestamp: string;

  /** Version of the mcpspan package that produced the event. */
  sdkVersion: string;

  /**
   * The connection this call arrived on, as a random identifier made by the
   * SDK. Absent for calls recorded through `track` alone, which has no way to
   * see the connection.
   */
  sessionId?: string;

  /**
   * Parameter names mapped to their types, when a developer opted in.
   *
   * Absent by default, and never contains a value. Seeing that
   * `search_flights` is always called with `destination` and never with
   * `departureDate` tells a developer their tool description is not landing;
   * seeing which destination tells them nothing they needed and puts their
   * users' data somewhere it does not belong.
   */
  parameters?: Record<string, string>;
}
