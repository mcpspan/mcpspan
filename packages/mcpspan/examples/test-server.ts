/**
 * A real MCP server with fake tools, instrumented.
 *
 * Exists to be driven by something that speaks MCP properly - the Inspector,
 * or Claude Desktop - so that the SDK is exercised against the official
 * server implementation rather than a stand-in written to match what we
 * expected it to do.
 *
 * The tools return fixed answers. What is being tested is the measuring, not
 * the flying.
 *
 *   MCPSPAN_API_KEY=mcps_... node examples/test-server.ts
 *
 * Add it to a client's configuration with that variable set, plus
 * MCPSPAN_ENDPOINT if the Core API is not on localhost:6271.
 *
 * On the ordinary shutdown path - a client closing this process's input - the
 * SDK delivers whatever is still queued before the process ends, even if the
 * send interval has not come round. A process killed outright by a signal is
 * the exception: nothing runs after that, here or anywhere else, and the last
 * few seconds of calls go with it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { exclude, instrument } from '../dist/index.mjs';

const server = new McpServer({ name: 'mcpspan-test-flights', version: '1.0.0' });

// One line, before any tool is registered. Everything below is written the
// way it would be without this, which is the claim being tested.
instrument(server, {
  ...(process.env['MCPSPAN_API_KEY'] === undefined
    ? {}
    : { apiKey: process.env['MCPSPAN_API_KEY'] }),
  ...(process.env['MCPSPAN_ENDPOINT'] === undefined
    ? {}
    : { endpoint: process.env['MCPSPAN_ENDPOINT'] }),
  captureParameterNames: true,
  // Diagnostics go to stderr. On stdio, stdout carries the protocol itself.
  debug: process.env['MCPSPAN_DEBUG'] === '1',
});

server.registerTool(
  'search_flights',
  {
    title: 'Search flights',
    description: 'Find flights to a destination. Returns made-up results.',
    inputSchema: {
      destination: z.string().describe('City to fly to'),
      passengers: z.number().int().min(1).max(9).optional(),
    },
  },
  async ({ destination, passengers = 1 }) => {
    await pause(20, 120);

    return text(
      `3 flights to ${destination} for ${passengers} passenger${passengers === 1 ? '' : 's'}: ` +
        'LH1234 09:15, AF5678 13:40, BA9012 19:05',
    );
  },
);

server.registerTool(
  'book_flight',
  {
    title: 'Book a flight',
    description: 'Book a flight by its code. Try SOLDOUT to see a failure.',
    inputSchema: { flightNumber: z.string().describe('Flight code, such as LH1234') },
  },
  async ({ flightNumber }) => {
    // Deliberately slow, so the latency percentiles have something to say.
    await pause(300, 1_400);

    // The MCP way of reporting a failure: an answer the model can read, not
    // an exception. This is the path a wrapper watching only for throws would
    // record as a success.
    return flightNumber.toUpperCase() === 'SOLDOUT'
      ? text(`No seats left on ${flightNumber}`, true)
      : text(`Booked ${flightNumber}. Reference QX7T2.`);
  },
);

server.registerTool(
  'cancel_booking',
  {
    title: 'Cancel a booking',
    description: 'Cancel by reference. Always throws, on purpose.',
    inputSchema: { reference: z.string() },
  },
  () => {
    // The other kind of failure: a handler that breaks. The SDK records it
    // and lets the exception through, which is what the client should see.
    throw new TypeError('Booking references must be six characters');
  },
);

server.registerTool(
  'health_check',
  { title: 'Health check', description: 'Polled by machinery. Not measured.' },
  // Wrapped in exclude, so instrument leaves it alone. A check polled every
  // few seconds would otherwise outnumber everything a person did and drag
  // the whole server's numbers towards its own.
  exclude(async () => text('ok')),
);

function text(body: string, isError?: boolean) {
  return {
    content: [{ type: 'text' as const, text: body }],
    ...(isError === undefined ? {} : { isError }),
  };
}

/** Stands in for work, so the timings are not all zero. */
function pause(min: number, max: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

await server.connect(new StdioServerTransport());
