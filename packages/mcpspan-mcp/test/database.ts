/** Where this suite writes: never the database a developer is looking at, nor the core suite's. */
export const TEST_DATABASE_URL =
  process.env['MCP_TEST_DATABASE_URL'] ?? 'postgres://mcpspan:mcpspan@localhost:6272/mcpspan_mcp_test';
