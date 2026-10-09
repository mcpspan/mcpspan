// The conformance adapter for the TypeScript SDK.
//
// An MCP server over stdio, instrumented with the SDK and configured from the
// environment the way conformance/README.md describes. Every SDK ships one of
// these with the same tools, and the suite drives it as a real MCP client.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { exclude, instrument } from 'mcpspan';
import { z } from 'zod';

class ConformanceError extends Error {
  name = 'ConformanceError';
}

const server = new McpServer({ name: 'conformance', version: '1.0.0' });

const text = (value) => ({ content: [{ type: 'text', text: value }] });

// Before instrument(), as the contract requires an SDK to measure too.
server.registerTool('early', {}, async () => text('ok'));

instrument(server, {
  // Passed through as found: an absent key is one of the cases under test.
  ...(process.env.MCPSPAN_API_KEY === undefined ? {} : { apiKey: process.env.MCPSPAN_API_KEY }),
  endpoint: process.env.MCPSPAN_ENDPOINT,
  flushIntervalMs: Number(process.env.CONFORMANCE_FLUSH_MS ?? 200),
  captureParameterNames: process.env.CONFORMANCE_CAPTURE_PARAMETERS === '1',
  captureErrorMessages: process.env.CONFORMANCE_CAPTURE_ERROR_MESSAGES !== '0',
});

server.registerTool('ok', {}, async () => text('ok'));
server.registerTool('large', {}, async () => text('x'.repeat(100_000)));

server.registerTool('reported_error', {}, async () => ({
  ...text('No flights found'),
  isError: true,
}));

server.registerTool('throws', {}, async () => {
  throw new ConformanceError('boom');
});

server.registerTool(
  'typed',
  { inputSchema: { destination: z.string(), passengers: z.number() } },
  async () => text('ok'),
);

server.registerTool(
  'excluded',
  { inputSchema: { depth: z.number() } },
  exclude(async () => text('ok')),
);

server.registerTool(`long_${'x'.repeat(295)}`, {}, async () => text('ok'));

// Resources and prompts (contract, 3.5): one resource at a fixed address, one
// read through a template, one that throws; a prompt with a required
// argument, and one that throws.
server.registerResource('config', 'config://app', {}, async (uri) => ({
  contents: [{ uri: uri.href, text: 'ok' }],
}));
server.registerResource('trip', new ResourceTemplate('trips://{id}', { list: undefined }), {}, async (uri) => ({
  contents: [{ uri: uri.href, text: 'ok' }],
}));
server.registerResource('broken', 'broken://status', {}, async () => {
  throw new ConformanceError('boom');
});
server.registerPrompt('plan_trip', { argsSchema: { destination: z.string() } }, ({ destination }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Plan a trip to ${destination}` } }],
}));
server.registerPrompt('broken_prompt', {}, () => {
  throw new ConformanceError('boom');
});

await server.connect(new StdioServerTransport());
