/**
 * Where to go after signing in, when it was asked for: only ever the page
 * where an MCP client is waiting for somebody to say yes (views/authorize).
 *
 * Nothing else, so a link to the sign-in page cannot be made to send somebody
 * anywhere once they have signed in.
 */
export function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4000) return undefined;
  if (!value.startsWith('/oauth/authorize?') || /[\\\r\n]/.test(value)) return undefined;

  return value;
}
