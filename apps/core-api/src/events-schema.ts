import { z } from 'zod';

/**
 * Upper bounds on the text an event may carry.
 *
 * Generous rather than exact. The SDK already truncates these, so anything
 * near a limit came from somewhere else, and the point is to stop one event
 * carrying a megabyte rather than to second-guess a version of the SDK that
 * has not been written yet.
 */
const LIMITS = {
  kind: 20,
  toolName: 200,
  errorType: 200,
  errorMessage: 2_000,
  clientType: 50,
  clientName: 200,
  version: 100,
  sdkVersion: 50,
  parameterName: 200,
  parameterType: 50,
  parameterCount: 100,
} as const;

/**
 * One tool call, as the SDK reports it.
 *
 * Strict about shape, lenient about vocabulary. Fields whose values are a list
 * today and a longer list tomorrow - the client type, the error source - are
 * accepted as bounded text rather than as a fixed set. The SDK and this API
 * are versioned separately and upgraded separately, and a newer SDK reporting
 * a client we have not heard of must not have its batch refused: a refusal is
 * final, so the developer would lose those events for good over a name.
 *
 * The event carries no server. That comes from the API key, and accepting one
 * here would be accepting instructions about whose data this is from whoever
 * happens to be sending it.
 */
export const toolCallEventSchema = z.object({
  id: z.uuid(),

  /**
   * What was called: a tool, or a resource read, or a prompt got. Absent on
   * events from SDKs that measured tools alone, which is what those were.
   *
   * Open, like the client type: a kind this API does not know yet is taken
   * rather than refused, and left unstored, so a newer SDK never loses a
   * whole batch over it. The response's `stored` count shows the difference.
   */
  kind: z.string().max(LIMITS.kind).optional(),

  /** The name of what was called, whatever its kind: kept as toolName, which is what it was first. */
  toolName: z.string().min(1).max(LIMITS.toolName),

  // Finite and not negative: a duration cannot be either, and one that slipped
  // through would quietly poison every average computed from this column.
  durationMs: z.number().finite().nonnegative(),

  success: z.boolean(),

  errorSource: z.string().max(LIMITS.clientType).optional(),
  errorType: z.string().max(LIMITS.errorType).optional(),
  errorMessage: z.string().max(LIMITS.errorMessage).optional(),

  clientType: z.string().min(1).max(LIMITS.clientType),
  clientName: z.string().max(LIMITS.clientName).optional(),
  // As the client and the server each give themselves in the handshake.
  clientVersion: z.string().max(LIMITS.version).optional(),
  serverVersion: z.string().max(LIMITS.version).optional(),
  // Size of the answer in bytes (contract, 3.7); the content itself is never sent.
  responseBytes: z.number().int().min(0).max(2_147_483_647).optional(),
  // The tool's definition as the server listed it, fingerprinted (contract, 3.8).
  definitionHash: z.string().max(64).optional(),
  // The arguments were the previous call's to the same tool in the session (contract, 3.9).
  repeated: z.boolean().optional(),

  // Any valid instant is accepted, including implausible ones. This clock
  // belongs to the reporting machine and is sometimes wrong, and rejecting the
  // batch would cost a developer their data over a misconfigured host. The row
  // also records when we received it, which is what makes skew visible.
  timestamp: z.iso.datetime({ offset: true }),

  sdkVersion: z.string().min(1).max(LIMITS.sdkVersion),

  // A random identifier the SDK makes per connection. A UUID and nothing
  // else, so it cannot be used to carry anything about who is calling.
  sessionId: z.uuid().optional(),

  parameters: z
    .record(z.string().max(LIMITS.parameterName), z.string().max(LIMITS.parameterType))
    .refine((value) => Object.keys(value).length <= LIMITS.parameterCount, {
      message: `Too many parameters, at most ${LIMITS.parameterCount}`,
    })
    .optional(),
});

export type ToolCallEventInput = z.infer<typeof toolCallEventSchema>;

/** A batch, as the SDK posts it. */
export const eventBatchSchema = z.object({
  events: z.array(toolCallEventSchema),
});

/**
 * Turns a validation failure into something a developer can act on.
 *
 * Says which event and which field, because a batch holds a hundred of them
 * and "invalid request body" would leave someone comparing their payload to a
 * schema by eye.
 */
export function describeIssues(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
    message: issue.message,
  }));
}
