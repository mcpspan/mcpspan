import { McpServer } from '@modelcontextprotocol/server';

import type { Api } from './api.js';
import { registerTools } from './tools.js';
import { VERSION } from './version.js';

/** The MCP server, answering from one mcpspan account through its read token. */
export function buildServer(api: Api): McpServer {
  const server = new McpServer(
    { name: 'mcpspan', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Answers questions about the user's MCP servers from mcpspan: calls, failures, response times, clients, releases and sessions. Every tool reads; none changes anything. Start with list_servers when the account may have several.",
    },
  );

  registerTools(server, api);

  return server;
}
