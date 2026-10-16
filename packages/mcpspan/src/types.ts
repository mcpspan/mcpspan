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

/** What an event is about: a tool call, a resource read, a prompt got, or the tools the server listed. */
type CallKind = 'tool' | 'resource' | 'prompt' | 'listing';

/** One tool in a listing (contract, 3.11): its name, fingerprint and size. Never its definition. */
export interface ListedTool {
  name: string;
  definitionHash: string;
  /** UTF-8 bytes of the canonical JSON the fingerprint is taken from. */
  definitionBytes: number;
}

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

  /** Absent for a tool call; `resource` or `prompt` for the others (contract, 3.5), `listing` for a listing (3.11). */
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

  /**
   * Always `unknown`. The mcpspan server decides which client made the call from
   * `clientName` (contract, 7); this is sent only because servers released
   * before 2026-10-15 refuse an event without it.
   */
  clientType: 'unknown';

  /**
   * The name the client reported, as it reported it.
   *
   * The mcpspan server tells clients apart by it. This is an application's
   * self-description, the MCP equivalent of a User-Agent, and says nothing
   * about whoever is using it.
   */
  clientName?: string;

  /** The version the client gives itself, as it gives it. */
  clientVersion?: string;

  /**
   * The version of the server that answered: the `serverVersion` setting, or
   * the version the MCP server gives itself.
   */
  serverVersion?: string;

  /**
   * Size of the answer, in bytes of compact JSON (contract, 3.7). Only when the
   * call returned one; the content is counted, never kept.
   */
  responseBytes?: number;

  /** The tool's definition as last listed, fingerprinted (contract, 3.8). */
  definitionHash?: string;
  /** For refused arguments: which ones did not match the tool's schema, by declared name (contract, 3.10). */
  invalidArguments?: string[];

  /** On a listing: the tools the server listed, in its order (contract, 3.11). */
  listedTools?: ListedTool[];

  /** The arguments are the previous call's to the same tool in this session (contract, 3.9). */
  repeated?: boolean;

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
