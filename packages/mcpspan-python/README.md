# mcpspan for Python

Analytics for MCP servers. Find out which of your tools get called, by which
client, how long they take, and which ones fail.

Your own logs tell you a tool ran. This tells you whether it was Claude,
Cursor, or something you have not heard of, how that call compares to the
other nine hundred, and whether the failures are your tool breaking or your
tool politely saying no.

## Install

```sh
pip install mcpspan
```

Needs Python 3.10 or newer. No dependencies. Works with the official MCP SDK,
`mcp` 1.30+ (`FastMCP`) and 2.2+ (`MCPServer`), and with FastMCP 4+ (the
`fastmcp` package).

## Use

One line, anywhere before the server starts:

```python
import os

import mcpspan
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("flights")


@mcp.tool()
def search_flights(destination: str) -> str:
    return f"Found 3 flights to {destination}"


mcpspan.instrument(
    mcp,
    api_key=os.environ.get("MCPSPAN_API_KEY"),
    endpoint="http://localhost:6271",  # your mcpspan installation
)

if __name__ == "__main__":
    mcp.run()
```

Every tool on the server is measured, whether it was registered before that
line or after. Nothing about how you write tools changes: the schema the
server builds from your function is untouched, and your tool returns and
raises exactly what it did before.

The same line works on v2 of the MCP SDK and on FastMCP:

```python
from mcp.server.mcpserver import MCPServer

mcp = MCPServer("flights")
mcpspan.instrument(mcp)
```

```python
from fastmcp import FastMCP

mcp = FastMCP("flights")
mcpspan.instrument(mcp)
```

With no `api_key` given, it is read from `MCPSPAN_API_KEY`.

### Sessions and clients

Calls are grouped into sessions when there is a connection to group them by:
a stdio process, or an HTTP transport that hands out session IDs. A stateless
HTTP endpoint, and every endpoint on the 2026-07-28 protocol, which dropped
sessions, records calls without one.

The client is read from the call itself on 2026-07-28, where each request
names its client, and from the handshake on 2025-11-25. A stateless
2025-11-25 HTTP endpoint has no handshake to read, so its calls are recorded
with an unknown client rather than a guessed one.

A tool that asks the client for more before it can finish is one call however
many round trips that takes. The interim answer asking for input is not
counted; the one that ends the call is.

### Without a key

If there is no key, nothing is collected and nothing is sent, and no thread is
started. Wrapped tools return before reading the clock. That makes it safe to
leave in place in tests, in CI, and in a fork somebody is only reading.

### One tool at a time

If your server is not one of the above, or you want to pick tools by hand:

```python
import mcpspan

mcpspan.configure()  # reads MCPSPAN_API_KEY and MCPSPAN_ENDPOINT


@mcpspan.track("search_flights")
async def search_flights(destination: str) -> str:
    return f"Flights to {destination}"
```

`track` keeps the function's signature, name and docstring, so a server
builds the same schema from it. A function tracked by hand and then
registered on an instrumented server is counted once.

### Leaving a tool out

```python
@mcp.tool()
@mcpspan.exclude
def health_check() -> str:
    return "ok"
```

For tools called by machinery rather than by an agent. A health check polled
every few seconds outnumbers everything a person does and drags the whole
server's error rate and response time towards its own. Put `exclude` below
the server's decorator, so the server registers the marked function.

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

On the official MCP SDK and on FastMCP alike.

### Versions

Every call carries the version of the server that answered it, so the
dashboard marks where each release began and compares it with the one before.
There is nothing to add: it is the version the server gives itself,
`MCPServer("flights", version="1.4.0")` on v2 of the MCP SDK or
`FastMCP("flights", version="1.4.0")`. v1's `FastMCP` takes no version, so
there, or to record a commit or a deploy instead, set `server_version` (or
`MCPSPAN_SERVER_VERSION`). The client's version is recorded beside its name.

### Shutting down

Queued events are delivered as the interpreter exits, so most servers need
nothing here. If yours has its own shutdown path and you want to be explicit:

```python
mcpspan.shutdown()
```

It blocks for as long as that last delivery takes, a few seconds at most. A
process killed outright (`kill -9`, a container stopped without notice) runs
nothing after that, and the last few seconds of calls go with it.

Forked workers, as under gunicorn, keep collecting: each starts its own
delivery on its first call.

## Two kinds of failure

MCP asks tools to report their own errors inside the result, with `isError`
set, so the model can see what went wrong. A raised exception is the deviation
from that, and usually means the tool broke.

Both are recorded, and each event says which happened, with the exception's
class name for the second: "no flights found" is a tool working as written,
while a `KeyError` is something to fix. On FastMCP, a `ToolError` you raise
on purpose is recorded as `ToolError`; anything else your tool raises is
recorded as itself, not as the error FastMCP wraps it in.

### And two that never reach your tool

Calls the server refuses on its own are recorded too: arguments that fail
validation, and names it has no tool for. Both reach the model as error
results. Bad arguments are the commonest way an agent fails, so leaving them
out would make a server look healthier than it is to the agents using it.

A refused call carries no message, because the validation text can quote back
what the agent sent. With `capture_parameter_names` on, it carries the names
and types of the arguments instead, which is what shows the agent wrote
`dest` where the schema says `destination`. Tools passed through `exclude`
stay out of this as well.

## Privacy

**Parameter values never leave your process.** Not by default, not in any
mode, not in debug.

What is collected: the tool name, how long it took, whether it succeeded, the
error type and a truncated message when it did not, how large the answer was
in bytes (its size only, never its content), whether it repeated the previous
call's arguments to the same tool in its session (compared in your process;
the arguments, or any digest of them, never leave it), a fingerprint of the
tool's definition as your server lists it (its name, title, description and
input schema, hashed, so the dashboard can mark when you changed it), which
client called, and the SDK version. For a resource or a prompt, the same, under the name it was
registered with: never the address a client read, only its template or, for
an address the server does not have, its scheme.

Optionally, parameter *names and types*:

```python
mcpspan.instrument(mcp, capture_parameter_names=True)
```

That records `{"destination": "string", "passengers": "number"}`, in JSON's
vocabulary, as the client sent them. Knowing `search_flights` is always
called with `destination` and never with `departure_date` tells you your
tool description is not landing. Knowing which destination tells you nothing
you needed, and puts your users' data somewhere it does not belong.

## Self-hosting

Point it at your own installation:

```python
mcpspan.instrument(mcp, endpoint="https://mcpspan.example.com")
```

Or set `MCPSPAN_ENDPOINT`. There is no default: events go only where you point
them. With a key and no endpoint, nothing is collected, and the SDK says so
once on standard error.

When it starts with a key, the SDK sends one empty batch to say it is there.
That is how the dashboard's Status page tells a server nobody has used yet
from one pointed at the wrong address, and how a wrong key is reported when
your server starts rather than at its first tool call.

## It will not break your server

- Delivery happens on a background thread of its own, whether your server is
  synchronous, on asyncio or on trio. A tool call returns without waiting on
  the network, and the thread never keeps a process alive.
- A failure to send is never raised into your code. Retryable failures wait
  and try again with a widening gap; a refused key switches collection off
  and says so once on standard error.
- The queue is bounded. An unreachable endpoint cannot grow it until your
  process runs out of memory.
- Nothing is ever written to standard output, which carries the MCP protocol
  on a stdio server. Diagnostics go to standard error.
- `configure`, `instrument` and `shutdown` never raise. A mistyped option
  falls back to its default rather than stopping your server from starting.

## Options

Given to `instrument` or `configure`.

| Option | Default | What it does |
|---|---|---|
| `api_key` | `MCPSPAN_API_KEY` | Identifies your server. Without it, nothing is collected. |
| `endpoint` | `MCPSPAN_ENDPOINT`; none | Your mcpspan installation. Nothing is collected without it. |
| `capture_parameter_names` | `False` | Records parameter names and types, never values. |
| `server_version` | `MCPSPAN_SERVER_VERSION`, then the server's own | The version to record calls under: a release, a tag, a commit. |
| `debug` | `False` | Writes delivery diagnostics to standard error. |
| `on_diagnostic` | - | Receives diagnostics instead. Implies `debug`. |
| `flush_on_exit` | `True` | Delivers what is queued as the interpreter exits. |
| `flush_interval` | `5.0` | Seconds a partly filled batch waits. |
| `max_batch_size` | `100` | Events per request. Reaching it sends early. |
| `max_queue_size` | `10000` | Events held while delivery is failing. |

Calling `configure` or `instrument` again with the same settings changes
nothing, so a server built per request can pass them every time.

## Developing

```sh
uv sync --group mcp2        # or mcp1, or fastmcp: the MCP SDK the tests run against
uv run --group mcp2 pytest
uv run --group mcp2 mypy
uv run ruff check && uv run ruff format --check
```

The SDK follows [the contract every mcpspan SDK
follows](../../docs/sdk-contract.md), checked by the suite in
[`conformance/`](../../conformance/README.md).

## Licence

MIT.
