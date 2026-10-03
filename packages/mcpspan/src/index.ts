/**
 * Analytics for MCP servers.
 *
 * The usual integration is one line at startup:
 *
 * ```ts
 * import { instrument } from 'mcpspan';
 *
 * const server = new McpServer({ name: 'flights', version: '1.0.0' });
 * instrument(server, { apiKey: process.env.MCPSPAN_API_KEY });
 * ```
 *
 * Every tool on the server is measured, registered before that line or
 * after. Without an API key nothing is collected and nothing is sent.
 */

export { configure, shutdown, type McpspanConfig } from './config.js';
export { instrument } from './instrument.js';
export { exclude, track } from './track.js';
export type { ClientType, ErrorSource, ToolCallEvent } from './types.js';
