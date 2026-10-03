/**
 * Longest error message kept from a thrown exception.
 *
 * Exception messages are written by developers for developers, so they are
 * mostly safe to keep and mostly worth reading in full.
 */
export const MAX_EXCEPTION_MESSAGE_LENGTH = 500;

/**
 * Longest error message kept from a result marked as an error.
 *
 * Shorter than the exception limit on purpose. This text was written for a
 * language model to read, so it is far more likely than an exception message
 * to quote back whatever the user asked about.
 */
export const MAX_RESULT_MESSAGE_LENGTH = 200;

/**
 * Longest text the ingest API takes in a name-like field: a tool, an error
 * type, a client, a parameter.
 *
 * The API refuses a whole batch when any one field is over its limit, so an
 * over-long value would take every other event in its batch down with it.
 * These values come from outside the developer's control - a client names
 * itself, an exception names its own class - so they are cut here, before
 * they can, rather than trusted to be short.
 */
export const MAX_NAME_LENGTH = 200;

/** Renders any thrown value as one readable line, for diagnostics. */
export function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Cuts text to a limit, leaving a visible sign that something was removed. */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

/**
 * Whether a tool reported its own failure through the result.
 *
 * MCP asks tools to answer with `isError` rather than throwing, so that the
 * model can see what went wrong and react. A wrapper that only watched for
 * exceptions would record a correctly written server as having no errors at
 * all.
 */
export function isErrorResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

interface TextBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * Pulls a short description out of a tool result that reported an error.
 *
 * Reads only text blocks. Images and binary attachments carry no message
 * worth storing, and copying them anywhere would be indefensible.
 */
export function describeErrorResult(result: unknown): string | undefined {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .filter(
      (block): block is TextBlock & { text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as TextBlock).type === 'text' &&
        typeof (block as TextBlock).text === 'string',
    )
    .map((block) => block.text)
    .join(' ')
    .trim();

  return text.length > 0 ? truncate(text, MAX_RESULT_MESSAGE_LENGTH) : undefined;
}

/** Names and summarises a thrown value, whatever it turned out to be. */
export function describeException(error: unknown): {
  errorType: string;
  errorMessage: string | undefined;
} {
  if (error instanceof Error) {
    return {
      errorType: truncate(error.name, MAX_NAME_LENGTH),
      errorMessage:
        error.message.length > 0
          ? truncate(error.message, MAX_EXCEPTION_MESSAGE_LENGTH)
          : undefined,
    };
  }

  // Nothing stops a handler from throwing a string, a number, or nothing at
  // all, and a telemetry library is the last place that should be surprised
  // by it.
  return {
    errorType: typeof error,
    errorMessage: truncate(String(error), MAX_EXCEPTION_MESSAGE_LENGTH),
  };
}
