# mcpspan

Analytics for MCP servers. Find out which of your tools get called, by which
client, how long they take, and which ones fail.

Your own logs tell you a tool ran. This tells you whether it was Claude,
Cursor, or something you have not heard of, how that call compares to the
other nine hundred, and whether the failures are your handler breaking or your
tool politely saying no.

## Install

```sh
npm install mcpspan
```

Needs Node 18 or newer. No dependencies.

## Use

One line, anywhere before the server starts:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { instrument } from 'mcpspan';

const server = new McpServer({ name: 'flights', version: '1.0.0' });

instrument(server, {
  apiKey: process.env.MCPSPAN_API_KEY,
  endpoint: 'http://localhost:6271', // your mcpspan installation
});

// Register tools exactly as you would without this.
server.registerTool('search_flights', { inputSchema }, async (params) => {
  return { content: [{ type: 'text', text: 'Found 3 flights' }] };
});
```

Every tool on the server is measured, whether it was registered before that
line or after. Nothing about how you write them changes, and the wrapper hands
back whatever your handler returned, exceptions included.

### On v2 of the MCP SDK

Both major versions of the official TypeScript SDK are supported, v1
(`@modelcontextprotocol/sdk`) and v2 (`@modelcontextprotocol/server`), and
both protocol revisions v2 speaks, 2025-11-25 and 2026-07-28.

v2 usually builds the server for you: `createMcpHandler` builds a fresh one
for every HTTP request, and `serveStdio` builds one when the client connects.
Configure mcpspan once when the process starts, and instrument each server
the SDK builds:

```ts
import * as mcp from '@modelcontextprotocol/server';
import { configure, instrument } from 'mcpspan';

// Once, as the process starts, so the dashboard sees the server come up.
configure({ apiKey: process.env.MCPSPAN_API_KEY, endpoint: process.env.MCPSPAN_ENDPOINT });

export const handler = mcp.createMcpHandler(() => {
  const server = new mcp.McpServer(
    { name: 'flights', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  instrument(server);

  server.registerTool('search_flights', {}, async () => {
    return { content: [{ type: 'text', text: 'Found 3 flights' }] };
  });

  return server;
});
```

Instrumenting a fresh server costs a few property lookups, and passing the
same options to `instrument` on every request is also fine: settings that
have not changed are left alone rather than started over.

### Sessions and clients

Calls are grouped into sessions when there is a connection to group them by:
a stdio process, or an HTTP transport that hands out session IDs. A stateless
HTTP endpoint, and every endpoint on the 2026-07-28 protocol, which dropped
sessions, records calls without one.

The client is read from the call itself on 2026-07-28, where each request
names its client, and from the handshake on 2025-11-25. A stateless 2025-11-25
HTTP endpoint builds a new server for each request, which never saw the
handshake, so its calls are recorded with an unknown client rather than a
guessed one.

A tool that asks the client for more before it can finish, such as a
confirmation, is one call however many round trips that takes. The interim
answer asking for input is not counted; the one that ends the call is. Where
the transport cannot put the question to the client and the SDK answers with
an error instead, that is recorded as the tool's failure, since it is what the
agent saw.

### Without a key

If `apiKey` is missing, nothing is collected and nothing is sent. Wrapped
handlers return before reading the clock, so an SDK nobody configured costs
what an SDK nobody installed costs. That makes it safe to leave in place in
tests, in CI, and in a fork somebody is only reading.

### One tool at a time

If your server is not an `McpServer`, or you want to pick tools by hand:

```ts
import { configure, track } from 'mcpspan';

configure({ apiKey: process.env.MCPSPAN_API_KEY, endpoint: process.env.MCPSPAN_ENDPOINT });

const search = track('search_flights', async (params: { destination: string }) => {
  return { content: [{ type: 'text', text: `Flights to ${params.destination}` }] };
});
```

`track` returns a function with the same signature as the one you gave it.

### Leaving a tool out

```ts
import { exclude } from 'mcpspan';

server.registerTool('health_check', {}, exclude(async () => {
  return { content: [{ type: 'text', text: 'ok' }] };
}));
```

For tools called by machinery rather than by an agent. A health check polled
every few seconds outnumbers everything a person does and drags the whole
server's error rate and response time towards its own.

It takes no tool name on purpose: a name written twice can drift during a
rename, and the exclusion would quietly stop applying.

### Resources and prompts

Reads of your resources and gets of your prompts are measured too, with
nothing to add: each is one event, in the same session and from the same
client as the tool calls around it, and the dashboard shows them in a card of
their own and in each session's timeline. Listings are not recorded.

A resource at a fixed address is named by that address. One read through a
template is named by the template, `trips://{id}`, never by the address the
client asked for, which can carry a user's data; the template's variables are
its parameters, by name only. A read of an address the server has nothing for
is named by its scheme alone, `db://`. A prompt is named by its name, and its
arguments are its parameters, as a tool's are.

### Versions

Every call carries the version of the server that answered it, so the
dashboard marks where each release began and compares it with the one before.
There is nothing to add: it is the version the server gives itself,
`new McpServer({ name: 'flights', version: '1.4.0' })`. To record a commit or
a deploy instead, set `serverVersion` (or `MCPSPAN_SERVER_VERSION`). The
client's version is recorded beside its name.

### Shutting down

Queued events are delivered when the process winds down, so most servers need
nothing here. If yours has its own shutdown path and you want to be explicit:

```ts
import { shutdown } from 'mcpspan';

await shutdown();
```

A process killed outright by a signal is the exception - nothing runs after
that - and the last few seconds of calls go with it.

## Two kinds of failure

MCP asks tools to report their own errors inside the result, with `isError`
set, so the model can see what went wrong. A thrown exception is the deviation
from that, and usually means the handler broke.

Both are recorded, and each event says which happened. The distinction is the
useful one: "no flights found" is a tool working as written, while a
`TypeError` is something to fix. A library watching only for exceptions would
report a correctly written server as having no errors at all.

### And two that never reach your handler

With `instrument`, calls the server refuses on its own are recorded too:
arguments its schema rejects, and names it has no enabled tool for. The first
reaches the model as an ordinary error result, the second as an error result
on v1 of the MCP SDK and a protocol error on v2. Bad arguments are the
commonest way an agent fails, so leaving them out would make a server look
healthier than it is to the agents using it.

A refused call carries no message, because the server's validation text can
quote back what the agent sent. With `captureParameterNames` on, it carries the
names and types of the arguments instead, which is what shows the agent wrote
`dest` where the schema says `destination`. Tools passed through `exclude` stay
out of this as well.

## Privacy

**Parameter values never leave your process.** Not by default, not in any
mode, not in debug.

What is collected: the tool name, how long it took, whether it succeeded, the
error type and a truncated message when it did not, which client called, and
the SDK version. For a resource or a prompt, the same, under the name it was
registered with: never the address a client read, only its template or, for
an address the server does not have, its scheme.

Optionally, parameter *names and types*:

```ts
instrument(server, {
  apiKey: process.env.MCPSPAN_API_KEY,
  captureParameterNames: true,
});
```

That records `{ destination: 'string', passengers: 'number' }`. Knowing
`search_flights` is always called with `destination` and never with
`departureDate` tells you your tool description is not landing. Knowing which
destination tells you nothing you needed, and puts your users' data somewhere
it does not belong.

Types stay coarse and carry no length, because the distance between "a 34
character string" and "a credit card number" is shorter than it looks. Nested
objects are named but not opened.

## Self-hosting

Point it at your own installation:

```ts
instrument(server, {
  apiKey: process.env.MCPSPAN_API_KEY,
  endpoint: 'https://mcpspan.example.com',
});
```

Or set `MCPSPAN_ENDPOINT`. Both `apiKey` and `endpoint` fall back to
`MCPSPAN_API_KEY` and `MCPSPAN_ENDPOINT`, so a server can be instrumented with
no configuration in code at all.

There is no default: events go only where you point them. With a key and no
endpoint, nothing is collected, and the SDK says so once on standard error.

When it starts with a key, the SDK sends one empty batch to say it is there.
That is how the dashboard's Status page tells a server nobody has used yet
from one pointed at the wrong address, and how a wrong key is reported when
your server starts rather than at its first tool call. It is sent once, in the
background, and never retried.

## It will not break your server

That is the first rule, and everything below follows from it.

- Delivery happens in the background. A tool call returns without waiting on
  the network.
- A failure to send is never raised into your code. Retryable failures wait
  and try again with a widening gap; a refused key switches collection off
  rather than buffering events forever.
- The queue is bounded. An unreachable endpoint cannot grow it until your
  process runs out of memory.
- Diagnostics go to stderr, never stdout - on a stdio transport, stdout
  carries the MCP protocol itself.
- `configure` and `instrument` never throw. A mistyped option falls back to
  its default rather than stopping your server from starting.

## Options

| Option | Default | What it does |
|---|---|---|
| `apiKey` | `MCPSPAN_API_KEY` | Identifies your server. Without it, nothing is collected. |
| `endpoint` | `MCPSPAN_ENDPOINT`; none | Your mcpspan installation. Nothing is collected without it. |
| `captureParameterNames` | `false` | Records parameter names and types, never values. |
| `serverVersion` | `MCPSPAN_SERVER_VERSION`, then the server's own | The version to record calls under: a release, a tag, a commit. |
| `debug` | `false` | Writes delivery diagnostics to stderr. |
| `onDiagnostic` | - | Receives diagnostics instead of stderr. Implies `debug`. |
| `flushOnExit` | `true` | Delivers what is queued as the process ends. |
| `flushIntervalMs` | `5000` | How long a partly filled batch waits. |
| `maxBatchSize` | `100` | Events per request. Reaching it sends early. |
| `maxQueueSize` | `10000` | Events held while delivery is failing. |

## Licence

MIT.
