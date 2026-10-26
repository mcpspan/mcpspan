// A bare stdio MCP server: one JSON-RPC message per line, answered by hand.
//
// FIXTURE_MODE: "ok" (default), "crash" (exit 3 at once, saying why on stderr).
// Writes a line that is not JSON before the handshake's answer, as servers that log to stdout do.
import { createInterface } from 'node:readline';

if (process.env.FIXTURE_MODE === 'crash') {
  process.stderr.write('FLIGHTS_API_KEY is not set\n');
  process.exit(3);
}

const tools = [
  { name: 'search_flights', description: 'Finds flights.', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] } },
  { name: 'whoami', description: 'Says what it was started with.', inputSchema: { type: 'object' } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const { id, method, params } = message;

  if (method === 'initialize') {
    process.stdout.write('starting flights\n');
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'flights', version: '1.4.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call' && params.name === 'search_flights') {
    const to = params.arguments?.to;
    send({ jsonrpc: '2.0', id, result: typeof to === 'string' ? { content: [{ type: 'text', text: `3 flights to ${to}` }] } : { isError: true, content: [{ type: 'text', text: 'to is required' }] } });
  } else if (method === 'tools/call' && params.name === 'whoami') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ args: process.argv.slice(2), key: process.env.MCPSPAN_API_KEY ?? null }) }] } });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Tool ${params?.name} not found` } });
  }
});

process.stdin.on('end', () => process.exit(Number(process.env.FIXTURE_EXIT ?? 0)));
