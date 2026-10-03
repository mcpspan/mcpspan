/**
 * Drives the SDK against a running Core API, without an MCP server involved.
 *
 * The shortest way to find out whether a self-hosted install works end to
 * end: if these calls show up on the dashboard, the SDK, the network, the
 * ingest endpoint and the database are all doing their jobs, and anything
 * still broken is somewhere in the MCP layer above.
 *
 *   MCPSPAN_API_KEY=mcps_... node examples/smoke.ts [endpoint]
 *
 * Run it from this package's directory. The SDK is imported from the built
 * output, so run `pnpm build` first.
 */
import { configure, exclude, instrument, shutdown, track } from '../dist/index.mjs';

const endpoint = process.argv[2] ?? process.env['MCPSPAN_ENDPOINT'] ?? 'http://localhost:6271';
const apiKey = process.env['MCPSPAN_API_KEY'];

if (apiKey === undefined || apiKey.length === 0) {
  console.error('Set MCPSPAN_API_KEY to a key from your dashboard, then run this again.');
  process.exit(1);
}

/** Stands in for a tool that actually does something. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A result shaped the way MCP expects one. */
function reply(text: string, isError?: boolean): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError === undefined ? {} : { isError }) };
}

configure({ apiKey, endpoint, captureParameterNames: true });

// Half the calls go through track() by hand and half through a server wrapped
// by instrument(), because the point of this script is to find out whether
// both routes arrive - not whether one of them does.
const searchByHand = track('search_flights', async (params: { destination: string }) => {
  await sleep(10 + Math.random() * 60);

  return reply(`Found 3 flights to ${params.destination}`);
});

const registered: Record<string, (...args: never[]) => unknown> = {};
const server = {
  registerTool(name: string, _config: unknown, handler: (...args: never[]) => unknown) {
    registered[name] = handler;
  },
};

instrument(server);

server.registerTool('book_flight', {}, async (params: { flightId: string }) => {
  await sleep(200 + Math.random() * 900);

  // The MCP way of reporting a failure: an answer, not an exception.
  return params.flightId === 'sold-out'
    ? reply('No seats left on that flight', true)
    : reply('Booked');
});

server.registerTool('cancel_flight', {}, async () => {
  await sleep(20);

  // The other way: a handler that breaks.
  throw new TypeError('bookingId is required');
});

// Left out of the numbers on purpose, to show that it works: a health check
// polled by machinery would otherwise outnumber everything a person did.
server.registerTool('health_check', {}, exclude(() => reply('ok')));

const cities = ['Lisbon', 'Tokyo', 'Reykjavik', 'Cairo'];
let calls = 0;
let failures = 0;

for (let i = 0; i < 30; i += 1) {
  await searchByHand({ destination: cities[i % cities.length] as string });
  calls += 1;

  if (i % 3 === 0) {
    await (registered['book_flight'] as (p: unknown) => Promise<unknown>)({
      flightId: i % 9 === 0 ? 'sold-out' : `flight-${i}`,
    });
    calls += 1;
    if (i % 9 === 0) failures += 1;
  }

  if (i % 7 === 0) {
    try {
      await (registered['cancel_flight'] as () => Promise<unknown>)();
    } catch {
      // Thrown on purpose. The SDK records it and lets it through, which is
      // the behaviour being demonstrated.
    }
    calls += 1;
    failures += 1;
  }

  // Never counted, never sent.
  (registered['health_check'] as () => unknown)();
}

// Without this the last partly filled batch would leave with the process.
await shutdown();

console.log(`Sent ${calls} calls, ${failures} of them failures, to ${endpoint}.`);
console.log('Open the dashboard: they should be there within a few seconds.');
