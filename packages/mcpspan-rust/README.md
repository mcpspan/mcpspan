# mcpspan for Rust

Analytics for MCP servers. Find out which of your tools get called, by which
client, how long they take, and which ones fail.

Your own logs tell you a tool ran. This tells you whether it was Claude,
Cursor, or something you have not heard of, how that call compares to the
other nine hundred, and whether the failures are your tool breaking or your
tool politely saying no.

## Install

```sh
cargo add mcpspan
```

For a server built on the official Rust MCP SDK, `rmcp` 3.4 or newer. Needs
Rust 1.88 or newer, as rmcp does.

## Use

Configure once in `main`, and wrap the server where you serve it:

```rust
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Your mcpspan installation; the key is read from MCPSPAN_API_KEY.
    let _mcpspan = mcpspan::configure(mcpspan::Options::default().endpoint("http://localhost:6271"));

    let server = mcpspan::instrument(Flights::new()).serve(stdio()).await?;
    server.waiting().await?;
    Ok(())
}
```

Every tool on the server is measured. Nothing about how you write tools
changes, each tool returns and fails exactly as it did before, and every other
request passes through untouched.

Over streamable HTTP, wrap the server in the function that builds one per
session:

```rust
let service = StreamableHttpService::new(
    || Ok(mcpspan::instrument(Flights::new())),
    LocalSessionManager::default().into(),
    StreamableHttpServerConfig::default(),
);
```

With no `api_key`, it is read from `MCPSPAN_API_KEY`, and with no `endpoint`,
from `MCPSPAN_ENDPOINT`.

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

For a server `instrument` does not cover, wrap the tool's route:

```rust
let router = ToolRouter::new().with_route(mcpspan::track(ToolRoute::new(
    Flights::search_flights_tool_attr(),
    Flights::search_flights,
)));
```

A tracked tool on an instrumented server is counted once.

### Leaving a tool out

```rust
let server = mcpspan::instrument(Flights::new()).exclude(Flights::health_check_tool_attr());
```

For tools called by machinery rather than by an agent. A health check polled
every few seconds outnumbers everything a person does and drags the whole
server's error rate and response time towards its own. The tool is named by
what `#[tool]` generates for it, so a rename carries the exclusion along.

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

rmcp keeps no registry of its own, so the names come from your server's own
`list_resources`, `list_resource_templates` and `list_prompts`: a resource
your server reads but does not list is named by its scheme.

### Versions

Every call carries the version of the server that answered it, so the
dashboard marks where each release began and compares it with the one before.
There is nothing to add: it is the version the server gives itself in
`get_info`, `.with_server_info(Implementation::new("flights", "1.4.0"))`, or
the crate's own version when `#[tool_handler(name = "flights")]` builds it.
To record a commit or a deploy instead, set `server_version` (or
`MCPSPAN_SERVER_VERSION`). The client's version is recorded beside its name.
A tool tracked on its own, on a server that is not instrumented, cannot see
the server, so its calls carry only a version set this way.

### Shutting down

Rust runs nothing when a process ends, so what is still queued when `main`
returns would be lost. That is what the guard `configure` returns is for:
when it goes out of scope at the end of `main`, it delivers what is queued.
Keep it bound to a name; `let _ = ...` drops it at once.

A stdio server also delivers what is queued as its client leaves. To be
explicit somewhere else, as in a shutdown path of your own:

```rust
mcpspan::shutdown();
```

A process killed outright runs nothing after that, and the last few seconds
of calls go with it.

## Two kinds of failure

MCP asks tools to report their own errors inside the result, with `is_error`
set, so the model can see what went wrong. A tool returning
`Result<String, String>` does that with its `Err`. Failing the call itself,
with an `Err(ErrorData)`, is the deviation from that, and usually means the
tool broke.

Both are recorded, and each event says which happened. An `ErrorData` has a
code but no type of its own, so it is named by its code: an
`ErrorData::internal_error` is recorded as `InternalError`, and a code of your
own as `ErrorData(-32001)`. A tool that panics is recorded as `panic`, with
its message, and the panic then carries on exactly as it would have.

### And two that never reach your tool

Calls the server refuses on its own are recorded too: arguments rmcp cannot
deserialize into the tool's parameters, and names it has no tool for. A
refused call carries no message, because that text can quote back what the
agent sent.

rmcp says which is which only in its wording, so that is what is read, and
the conformance suite this SDK is checked against fails if a new rmcp ever
words them differently.

## Privacy

**Parameter values never leave your process.** Not by default, not in any
mode, not in debug.

What is collected: the tool name, how long it took, whether it succeeded, the
error type and a truncated message when it did not, which client called, and
the SDK version. For a resource or a prompt, the same, under the name it was
registered with: never the address a client read, only its template or, for
an address the server does not have, its scheme.

Optionally, parameter *names and types*:

```rust
let options = mcpspan::Options::default().capture_parameter_names(true);
```

That records `{"destination": "string", "passengers": "number"}`, in JSON's
vocabulary, as the client sent them. Knowing `search_flights` is always
called with `destination` and never with `departure_date` tells you your tool
description is not landing. Knowing which destination tells you nothing you
needed, and puts your users' data somewhere it does not belong.

## Self-hosting

```rust
let options = mcpspan::Options::default().endpoint("https://mcpspan.example.com");
```

Or set `MCPSPAN_ENDPOINT`. There is no default: events go only where you point
them. With a key and no endpoint, nothing is collected, and the SDK says so
once on standard error.

A plain `http://` endpoint on a private network needs no TLS, and
`default-features = false` leaves the TLS stack out of your build.

When it starts with a key, the SDK sends one empty batch to say it is there.
That is how the dashboard's Status page tells a server nobody has used yet
from one pointed at the wrong address, and how a wrong key is reported when
your server starts rather than at its first tool call.

## It will not break your server

- Delivery runs on a thread of its own, whatever async runtime the server
  uses. A tool call returns without waiting on the network, and the thread
  never keeps a process running.
- A failure to send never reaches your code, and nothing here panics over a
  setting. Retryable failures wait and try again with a widening gap; a
  refused key switches collection off and says so once on standard error.
- The queue is bounded. An unreachable endpoint cannot grow it until your
  process runs out of memory.
- Nothing is ever written to standard output, which carries the MCP protocol
  on a stdio server. Diagnostics go to standard error.
- An instrumented server hands every method of rmcp's `ServerHandler` to
  yours. A test fails if rmcp adds one it does not.

## Options

Set on `mcpspan::Options::default()`, given to `configure`.

| Option | Default | What it does |
|---|---|---|
| `api_key` | `MCPSPAN_API_KEY` | Identifies your server. Without it, nothing is collected. |
| `endpoint` | `MCPSPAN_ENDPOINT`; none | Your mcpspan installation. Nothing is collected without it. |
| `capture_parameter_names` | `false` | Records parameter names and types, never values. |
| `server_version` | `MCPSPAN_SERVER_VERSION`, then the server's own | The version to record calls under: a release, a tag, a commit. |
| `debug` | `false` | Writes delivery diagnostics to standard error. |
| `on_diagnostic` | - | Receives diagnostics instead. Implies `debug`. |
| `flush_interval` | 5 seconds | How long a partly filled batch waits. |
| `max_batch_size` | `100` | Events per request. Reaching it sends early. |
| `max_queue_size` | `10000` | Events held while delivery is failing. |

Configuring again with the same settings changes nothing.

## Developing

```sh
cargo test
```

The SDK follows [the contract every mcpspan SDK
follows](../../docs/sdk-contract.md), checked by the suite in
[`conformance/`](../../conformance/README.md).

## Licence

MIT.
