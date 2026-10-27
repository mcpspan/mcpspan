import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { createApi } from 'mcpspan-mcp/src/api.ts';
import { buildServer } from 'mcpspan-mcp/src/server.ts';

import { bearerToken } from '../auth.ts';
import { userForReadToken } from '../read-tokens.ts';

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
 * `api` is the app this is mounted in, given lazily because it is still being
 * built when this is.
 */
export function createMcpRoutes(api: () => { fetch: (request: Request) => Response | Promise<Response> }): Hono {
  const viaApp: typeof fetch = async (input, init) => api().fetch(new Request(input, init));

  const mcp = createMcpHandler(({ authInfo }) =>
    buildServer(createApi({ token: authInfo?.token, url: IN_PROCESS, fetch: viaApp })),
  );

  const routes = new Hono();

  routes.all('/', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const owner = token === undefined ? undefined : await userForReadToken(token);

    // Turned away before the MCP exchange starts, as the MCP authorization
    // spec has it: a client that sees 401 knows to ask for credentials.
    if (token === undefined || owner === undefined) {
      c.header('www-authenticate', `Bearer error="invalid_token"`);

      return c.json(
        {
          error:
            token === undefined
              ? 'Send a read token: Authorization: Bearer mcpspan_read_... Make one in mcpspan under Settings → Read tokens.'
              : 'Invalid or revoked read token. Make a new one in mcpspan under Settings → Read tokens.',
        },
        401,
      );
    }

    return mcp.fetch(c.req.raw, { authInfo: { token, clientId: 'read-token', scopes: ['read'] } });
  });

  return routes;
}
