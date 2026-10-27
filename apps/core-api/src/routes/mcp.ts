import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createApi } from 'mcpspan-mcp/src/api.ts';
import { buildServer } from 'mcpspan-mcp/src/server.ts';

import { bearerToken } from '../auth.ts';
import { ACCESS_TOKEN_PREFIX, SCOPE, userForAccessToken } from '../oauth.ts';
import { userForReadToken } from '../read-tokens.ts';
import { mcpResource, resourceMetadataUrl } from './oauth.ts';

/** What the in-process questions are addressed to. Never resolved: they go straight to the app. */
const IN_PROCESS = 'http://mcpspan.internal';

/**
 * mcpspan's own MCP server, over HTTP: the tools of mcpspan-mcp, for clients
 * that connect to a URL rather than start a command.
 *
 * Each tool asks this same API, in process, with the caller's token, through
 * the very routes that answer the dashboard and the local mcpspan-mcp. So the
 * token reaches exactly what it reaches there, and nothing here decides
 * access on its own.
 *
 * It takes a read token, or, where `oauth` is on, an access token from
 * signing in through the client (routes/oauth.ts).
 *
 * `api` is the app this is mounted in, given lazily because it is still being
 * built when this is.
 */
export function createMcpRoutes(
  api: () => { fetch: (request: Request) => Response | Promise<Response> },
  { oauth = false }: { oauth?: boolean } = {},
): Hono {
  const viaApp: typeof fetch = async (input, init) => api().fetch(new Request(input, init));

  const mcp = createMcpHandler(({ authInfo }) =>
    buildServer(createApi({ token: authInfo?.token, url: IN_PROCESS, fetch: viaApp })),
  );

  const routes = new Hono();

  // For clients in a browser. Bearer tokens only, no cookies, so any origin
  // may ask; it still needs a token to get anything.
  routes.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'],
      exposeHeaders: ['www-authenticate', 'mcp-session-id', 'mcp-protocol-version'],
    }),
  );

  routes.all('/', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const owner =
      token === undefined
        ? undefined
        : token.startsWith(ACCESS_TOKEN_PREFIX)
          ? await userForAccessToken(token)
          : await userForReadToken(token);

    // A token made for another MCP server is not one for this one (RFC 8707).
    const elsewhere =
      owner !== undefined && 'resource' in owner && owner.resource !== null && owner.resource !== mcpResource(c.req.raw);

    // Turned away before the MCP exchange starts, as the MCP authorization
    // spec has it: the 401 names where to sign in, which is how a client
    // such as claude.ai knows to open the sign-in page.
    if (token === undefined || owner === undefined || elsewhere) {
      const signIn = oauth ? `resource_metadata="${resourceMetadataUrl(c.req.raw)}", scope="${SCOPE}"` : '';
      const problem = token === undefined ? '' : 'error="invalid_token"';

      c.header('www-authenticate', `Bearer ${[signIn, problem].filter((part) => part !== '').join(', ')}`.trim());

      return c.json(
        {
          error:
            token === undefined
              ? oauth
                ? 'Sign in: connect this MCP server in your client and it opens the mcpspan sign-in page, or send a read token (Authorization: Bearer mcpspan_read_...) from Settings → Read tokens.'
                : 'Send a read token: Authorization: Bearer mcpspan_read_... Make one in mcpspan under Settings → Read tokens.'
              : 'Invalid, expired or revoked token. Sign in again, or make a new read token in mcpspan under Settings → Read tokens.',
        },
        401,
      );
    }

    return mcp.fetch(c.req.raw, {
      authInfo: { token, clientId: token.startsWith(ACCESS_TOKEN_PREFIX) ? 'oauth' : 'read-token', scopes: [SCOPE] },
    });
  });

  return routes;
}
