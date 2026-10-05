// The conformance adapter for the TypeScript SDK, on v2 of the official MCP
// SDK. Served with serveStdio, which answers both the 2025 and the 2026-07-28
// protocol on one stdio connection, building the server through a factory -
// the way v2 serves, and so the way instrument() has to cope with.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { configure, exclude, instrument } from 'mcpspan';
import { z } from 'zod';

class ConformanceError extends Error {
  name = 'ConformanceError';
}

const text = (value) => ({ content: [{ type: 'text', text: value }] });

// Configured once, when the process starts. serveStdio builds the server
// lazily, on the connection's first request, so configuring inside the
// factory would start the SDK - and send its announcement - only then.
configure({
  ...(process.env.MCPSPAN_API_KEY === undefined ? {} : { apiKey: process.env.MCPSPAN_API_KEY }),
  endpoint: process.env.MCPSPAN_ENDPOINT,
  flushIntervalMs: Number(process.env.CONFORMANCE_FLUSH_MS ?? 200),
  captureParameterNames: process.env.CONFORMANCE_CAPTURE_PARAMETERS === '1',
});

function buildServer() {
  // The tools capability declared up front, as v2's own examples do.
  const server = new McpServer(
    { name: 'conformance', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // Before instrument(), as the contract requires an SDK to measure too.
  server.registerTool('early', {}, async () => text('ok'));

  // No configuration here: it was given once, above.
  instrument(server);

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
    { inputSchema: z.object({ destination: z.string(), passengers: z.number() }) },
    async () => text('ok'),
  );
  server.registerTool(
    'excluded',
    { inputSchema: z.object({ depth: z.number() }) },
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
  server.registerPrompt('plan_trip', { argsSchema: z.object({ destination: z.string() }) }, ({ destination }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Plan a trip to ${destination}` } }],
  }));
  server.registerPrompt('broken_prompt', {}, () => {
    throw new ConformanceError('boom');
  });

  return server;
}

serveStdio(buildServer);
