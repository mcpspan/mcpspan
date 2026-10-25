// A bare MCP server over stdio, speaking JSON-RPC by hand so it can list tools
// no real SDK would let through. FIXTURE_TOOLS holds them, two to a page;
// FIXTURE_MODE makes it crash or hang instead.
import { createInterface } from 'node:readline';

const tools = JSON.parse(process.env.FIXTURE_TOOLS ?? '[]');
const mode = process.env.FIXTURE_MODE ?? 'ok';

if (mode === 'crash') {
  process.stderr.write('Error: FLIGHTS_API_KEY is not set\n');
  process.exit(1);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || mode === 'hang') return;

  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: mode === 'no-tools' ? {} : { tools: {} },
        serverInfo: { name: process.env.FIXTURE_NAME ?? 'fixture', version: process.env.FIXTURE_VERSION ?? '1.0.0' },
      },
    });
  } else if (message.method === 'tools/list') {
    const start = Number(message.params?.cursor ?? 0);
    const next = start + 2;
    send({ id: message.id, result: { tools: tools.slice(start, next), ...(next < tools.length ? { nextCursor: String(next) } : {}) } });
  } else {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
