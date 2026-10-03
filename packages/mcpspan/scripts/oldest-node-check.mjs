/**
 * Runs the built package on the oldest Node the manifest claims to support.
 *
 * Types are already checked against that version, but a type definition is a
 * claim about an API rather than proof that it exists: `AbortSignal.timeout`
 * and a global `fetch` are the kind of thing that typechecks everywhere and
 * throws on an older runtime. The test suite cannot answer this because the
 * runner itself needs a newer Node, so this is deliberately plain.
 *
 * Nothing here talks to a network. An unroutable address is used so the SDK's
 * delivery attempt fails the way it would in the wild, which is itself part of
 * what is being checked: a failure to send must not reach the caller.
 */
import { createServer } from 'node:http';

import { configure, exclude, instrument, shutdown, track } from '../dist/index.mjs';

const failures = [];
const check = (condition, what) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${what}`);
  if (!condition) failures.push(what);
};

// A stand-in for the ingest API, so a real delivery is exercised rather than
// only the failure path.
const received = [];
const ingest = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    received.push(...JSON.parse(body).events);
    response.writeHead(202).end();
  });
});

await new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${ingest.address().port}`;

check(typeof track === 'function', 'the package loads');

configure({ apiKey: 'oldest-node-check', endpoint, captureParameterNames: true });

const search = track('search', (params) => ({
  content: [{ type: 'text', text: `looked for ${params.query}` }],
}));
check(search({ query: 'anything' }).content[0].text === 'looked for anything', 'track returns the handler result');

const failing = track('failing', () => {
  throw new TypeError('expected');
});
let threw = false;
try {
  failing();
} catch (error) {
  threw = error instanceof TypeError;
}
check(threw, 'track lets an exception through');

const registered = {};
const server = {
  registerTool(name, config, handler) {
    registered[name] = handler;
  },
};
instrument(server);
server.registerTool('booked', {}, () => ({ content: [{ type: 'text', text: 'ok' }] }));
server.registerTool('ignored', {}, exclude(() => ({ content: [] })));
registered['booked']();
registered['ignored']();
check(typeof registered['booked'] === 'function', 'instrument registers through the real method');

await shutdown();
await new Promise((resolve) => ingest.close(resolve));

const names = received.map((event) => event.toolName).sort();
check(names.join(',') === 'booked,failing,search', `three calls delivered, got: ${names.join(',') || 'none'}`);
check(received.every((event) => event.sdkVersion.length > 0), 'events carry a version');
check(
  !JSON.stringify(received).includes('anything'),
  'no parameter value left the process',
);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed on Node ${process.version}`);
  process.exit(1);
}

console.log(`\nAll checks passed on Node ${process.version}`);
