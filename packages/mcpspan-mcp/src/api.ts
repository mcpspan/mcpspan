/**
 * Reading from mcpspan with a read token.
 *
 * The same endpoints the dashboard reads, through the same checks: the token
 * stands for the person who made it, and the API answers it exactly as it
 * answers their browser, for reading only.
 */

/** The hosted service, which a self-hosted installation replaces with MCPSPAN_URL. */
export const DEFAULT_URL = 'https://api.mcpspan.com';

/** How long one question may take before the agent is told it did not come back. */
const TIMEOUT_MS = 30_000;

/** A failure worded for the agent, and through it the person, to act on. */
export class ApiError extends Error {
  override name = 'ApiError';
}

export type Query = Record<string, string | number | undefined>;

export interface Api {
  get<T>(path: string, query?: Query): Promise<T>;
}

export interface ApiSettings {
  /** MCPSPAN_READ_TOKEN. Undefined when it is not set, which every question then explains. */
  token: string | undefined;
  /** MCPSPAN_URL, or the hosted service. */
  url: string;
  /** Replaced in tests, which answer from the API in process. */
  fetch?: typeof fetch;
}

export function createApi({ token, url, fetch: send = fetch }: ApiSettings): Api {
  const base = url.replace(/\/+$/, '');

  return {
    async get<T>(path: string, query: Query = {}): Promise<T> {
      if (token === undefined || token.trim().length === 0) {
        throw new ApiError(
          'MCPSPAN_READ_TOKEN is not set. Make a read token in mcpspan, under Settings → Read tokens, and give it to this MCP server.',
        );
      }

      const target = new URL(`${base}${path}`);

      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) target.searchParams.set(key, String(value));
      }

      let response: Response;

      try {
        response = await send(target, {
          headers: { authorization: `Bearer ${token.trim()}`, accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new ApiError(`Could not reach mcpspan at ${base}. Check MCPSPAN_URL and that the installation is running.`);
      }

      const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      const said = typeof body?.['error'] === 'string' ? body['error'] : undefined;

      if (response.ok && body !== undefined) return body as T;

      switch (response.status) {
        case 401:
          throw new ApiError(
            'mcpspan refused the read token: it was revoked or mistyped. Make a new one under Settings → Read tokens.',
          );
        case 404:
          // A route the API does not have: an installation from before read
          // tokens, or an address that is not mcpspan's API at all.
          throw new ApiError(
            said?.startsWith('No route') === true || said === undefined
              ? `${base} does not answer read tokens. It needs mcpspan 0.9.0 or newer, and MCPSPAN_URL must be the address your MCP servers report to.`
              : said,
          );
        case 429:
          throw new ApiError(said ?? 'Too many questions at once. Wait a minute and ask again.');
        case 503:
          throw new ApiError(said ?? 'mcpspan cannot reach its database right now. Try again shortly.');
        default:
          throw new ApiError(said ?? `mcpspan answered ${response.status}.`);
      }
    },
  };
}
