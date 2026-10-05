# mcpspan for Ruby

Analytics for MCP servers. Find out which of your tools get called, by which
client, how long they take, and which ones fail.

Your own logs tell you a tool ran. This tells you whether it was Claude,
Cursor, or something you have not heard of, how that call compares to the
other nine hundred, and whether the failures are your tool breaking or your
tool politely saying no.

## Install

```sh
bundle add mcpspan
```

For a server built on the official Ruby MCP SDK, the `mcp` gem, 1.6 or newer.
Needs Ruby 3.2 or newer. Nothing else: delivery uses the standard library.

## Use

One line, after the server is built:

```ruby
server = MCP::Server.new(name: "flights", tools: [SearchFlights, BookFlight])
McpSpan.instrument(server, api_key: ENV["MCPSPAN_API_KEY"], endpoint: "http://localhost:6271")

MCP::Server::Transports::StdioTransport.new(server).open
```

Every tool on the server is measured, whether it was given to the server or
added later with `define_tool`. Nothing about how you write tools changes,
and each tool returns and raises exactly what it did before.

Over streamable HTTP, instrument the server you hand the transport:

```ruby
transport = MCP::Server::Transports::StreamableHTTPTransport.new(McpSpan.instrument(server))
```

With no `api_key`, it is read from `MCPSPAN_API_KEY`.

### Sessions and clients

Calls are grouped into sessions when there is a connection to group them by:
a stdio process, or an HTTP transport that hands out session IDs. A stateless
HTTP endpoint, and every endpoint on the 2026-07-28 protocol, which dropped
sessions, records calls without one.

The client is read from the call itself on 2026-07-28, where each request
names its client, and from the handshake on 2025-11-25.

A tool that asks the client for more before it can finish is one call however
many round trips that takes.

### Without a key

If there is no key, nothing is collected, nothing is sent, and no thread is
started. That makes it safe to leave in place in tests, in CI, and in a fork
somebody is only reading.

### One tool at a time

For a server `instrument` does not cover, track the tool class:

```ruby
McpSpan.track(SearchFlights)
```

A tracked tool on an instrumented server is counted once.

### Leaving a tool out

```ruby
McpSpan.exclude(HealthCheck)
```

For tools called by machinery rather than by an agent. A health check polled
every few seconds outnumbers everything a person does and drags the whole
server's error rate and response time towards its own. The mark sits on the
tool class, so a rename carries it along. A tool made with `define_tool` has
no class of its own, and is left out by name:

```ruby
server.define_tool(name: McpSpan.exclude("health_check")) { MCP::Tool::Response.new([]) }
```

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

Resources and templates defined as classes, and ones answered by your own
`resources_read_handler`, are named alike.

### Versions

Every call carries the version of the server that answered it, so the
dashboard marks where each release began and compares it with the one before.
There is nothing to add: it is the version the server gives itself,
`MCP::Server.new(name: "flights", version: "1.4.0")`. A server that gives none
is announced by the gem as `0.1.0`, and recorded so. To record a commit or a
deploy instead, set `server_version` (or `MCPSPAN_SERVER_VERSION`). The
client's version is recorded beside its name.

### Shutting down

What is queued is delivered as the program exits, so most servers need
nothing here. If yours has its own shutdown path and you want to be explicit:

```ruby
McpSpan.shutdown
```

A process killed outright runs nothing after that, and the last few seconds
of calls go with it.

## Two kinds of failure

MCP asks tools to report their own errors inside the result, with `error: true`
on the `MCP::Tool::Response`, so the model can see what went wrong. An
exception is the deviation from that, and usually means the tool broke.

Both are recorded, and each event says which happened, with the exception's
class for the second: a `BookingError` is recorded as `BookingError`, as your
tool raised it, though the MCP SDK hands the client a generic internal error.

### And two that never reach your tool

Calls the server refuses on its own are recorded too: arguments that are
missing or fail the tool's input schema, and names it has no tool for. A
refused call carries no message, because validation text can quote back what
the agent sent. Whether a call reached your tool is observed directly, not
read from the server's wording.

## Privacy

**Parameter values never leave your process.** Not by default, not in any
mode, not in debug.

What is collected: the tool name, how long it took, whether it succeeded, the
error type and a truncated message when it did not, how large the answer was
in bytes (its size only, never its content), which client called, and the SDK
version. For a resource or a prompt, the same, under the name it was
registered with: never the address a client read, only its template or, for
an address the server does not have, its scheme.

Optionally, parameter *names and types*:

```ruby
McpSpan.instrument(server, capture_parameter_names: true)
```

That records `{"destination": "string", "passengers": "number"}`, in JSON's
vocabulary, as the client sent them. Knowing `search_flights` is always
called with `destination` and never with `departure_date` tells you your tool
description is not landing. Knowing which destination tells you nothing you
needed, and puts your users' data somewhere it does not belong.

## Self-hosting

```ruby
McpSpan.instrument(server, endpoint: "https://mcpspan.example.com")
```

Or set `MCPSPAN_ENDPOINT`. There is no default: events go only where you point
them. With a key and no endpoint, nothing is collected, and the SDK says so
once on standard error.

When it starts with a key, the SDK sends one empty batch to say it is there.
That is how the dashboard's Status page tells a server nobody has used yet
from one pointed at the wrong address, and how a wrong key is reported when
your server starts rather than at its first tool call.

## It will not break your server

- Delivery runs on a thread of its own. A tool call returns without waiting
  on the network. A forked worker, as Puma's are, starts delivering on its own
  at its first call.
- A failure to send never reaches your code, and nothing here raises over a
  setting. Retryable failures wait and try again with a widening gap; a
  refused key switches collection off and says so once on standard error.
- The queue is bounded. An unreachable endpoint cannot grow it until your
  process runs out of memory.
- Nothing is ever written to standard output, which carries the MCP protocol
  on a stdio server. Diagnostics go to standard error.
- The MCP SDK has one `around_request` slot, and it is yours: mcpspan leaves
  it alone. It hooks two private methods of the one server it instruments
  instead, and if a version of the MCP SDK renames them, instrumenting leaves
  the server as it was.

## Options

Keywords of `McpSpan.instrument` and `McpSpan.configure`.

| Option | Default | What it does |
|---|---|---|
| `api_key` | `MCPSPAN_API_KEY` | Identifies your server. Without it, nothing is collected. |
| `endpoint` | `MCPSPAN_ENDPOINT`; none | Your mcpspan installation. Nothing is collected without it. |
| `capture_parameter_names` | `false` | Records parameter names and types, never values. |
| `server_version` | `MCPSPAN_SERVER_VERSION`, then the server's own | The version to record calls under: a release, a tag, a commit. |
| `debug` | `false` | Writes delivery diagnostics to standard error. |
| `on_diagnostic` | - | Receives diagnostics instead. Implies `debug`. |
| `flush_on_exit` | `true` | Delivers what is queued as the program exits. |
| `flush_interval` | `5` seconds | How long a partly filled batch waits. |
| `max_batch_size` | `100` | Events per request. Reaching it sends early. |
| `max_queue_size` | `10000` | Events held while delivery is failing. |

Configuring again with the same settings changes nothing.

## Developing

```sh
bundle install
bundle exec rake
```

The SDK follows [the contract every mcpspan SDK
follows](../../docs/sdk-contract.md), checked by the suite in
[`conformance/`](../../conformance/README.md).

## Licence

MIT.
