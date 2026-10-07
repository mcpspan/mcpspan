# mcpspan for Go

Analytics for MCP servers. Find out which of your tools get called, by which
client, how long they take, and which ones fail.

Your own logs tell you a tool ran. This tells you whether it was Claude,
Cursor, or something you have not heard of, how that call compares to the
other nine hundred, and whether the failures are your tool breaking or your
tool politely saying no.

## Install

Pick the package for the MCP SDK your server is built on. Each pulls in
only that SDK; the core has no dependencies at all.

```sh
# The official SDK, github.com/modelcontextprotocol/go-sdk
go get github.com/mcpspan/mcpspan/packages/mcpspan-go/mcpsdk

# mcp-go, github.com/mark3labs/mcp-go
go get github.com/mcpspan/mcpspan/packages/mcpspan-go/mcpgo
```

Needs Go 1.25 or newer (1.25.5 for mcp-go), and go-sdk 1.8+ or mcp-go 1.1+.

## Use

One line, and one deferred call:

```go
package main

import (
	"context"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	mcpspan "github.com/mcpspan/mcpspan/packages/mcpspan-go"
	"github.com/mcpspan/mcpspan/packages/mcpspan-go/mcpsdk"
)

func main() {
	server := mcp.NewServer(&mcp.Implementation{Name: "flights", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "search_flights"}, searchFlights)

	mcpsdk.Instrument(server, mcpspan.Config{
		APIKey:   os.Getenv("MCPSPAN_API_KEY"),
		Endpoint: "http://localhost:6271", // your mcpspan installation
	})
	defer mcpspan.Shutdown(context.Background())

	_ = server.Run(context.Background(), &mcp.StdioTransport{})
}
```

On mcp-go it is the same, from the other package:

```go
s := server.NewMCPServer("flights", "1.0.0", server.WithInputSchemaValidation())
mcpgo.Instrument(s, mcpspan.Config{APIKey: os.Getenv("MCPSPAN_API_KEY"), Endpoint: os.Getenv("MCPSPAN_ENDPOINT")})
defer mcpspan.Shutdown(context.Background())
```

Every tool on the server is measured, whether it was registered before that
line or after. Nothing about how you write tools changes, and your handlers
return exactly what they did before.

**Defer `Shutdown`.** Go runs nothing when `main` returns, so events still
queued then are lost unless `Shutdown` delivers them first. A stdio server's
`Run` returns when its client leaves, which is exactly when that matters.

With an empty `APIKey`, it is read from `MCPSPAN_API_KEY`.

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

If there is no key, nothing is collected, nothing is sent, and no goroutine
is started. That makes it safe to leave in place in tests, in CI, and in a
fork somebody is only reading.

### One tool at a time

For a server `Instrument` does not cover, wrap the handler:

```go
mcp.AddTool(server, &mcp.Tool{Name: "search_flights"}, mcpsdk.TrackFor(searchFlights))
s.AddTool(mcp.NewTool("search_flights"), mcpgo.Track(searchFlights))
```

`mcpsdk.Track` takes an untyped `mcp.ToolHandler`, `TrackFor` a typed one. A
tracked handler on an instrumented server is counted once.

### Leaving a tool out

```go
mcp.AddTool(server, mcpsdk.Exclude(&mcp.Tool{Name: "health_check"}), health)
s.AddTool(mcpgo.Exclude(mcp.NewTool("health_check")), health)
```

For tools called by machinery rather than by an agent. A health check polled
every few seconds outnumbers everything a person does and drags the whole
server's error rate and response time towards its own.

`Exclude` wraps the tool's definition rather than taking a name, so the name
is written once and a rename carries the exclusion with it. It leaves the
tool out by that name on every server in the process.

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

The official Go SDK does not check a prompt's required arguments, so a prompt
got without one is whatever its handler makes of it, not a refusal.

### Versions

Every call carries the version of the server that answered it, so the
dashboard marks where each release began and compares it with the one before.
There is nothing to add: it is the version the server gives itself,
`mcp.NewServer(&mcp.Implementation{Name: "flights", Version: "1.4.0"}, nil)` or
`server.NewMCPServer("flights", "1.4.0")`. To record a commit or a deploy
instead, set `ServerVersion` (or `MCPSPAN_SERVER_VERSION`). The client's
version is recorded beside its name.

## Two kinds of failure

MCP asks tools to report their own errors inside the result, with `IsError`
set, so the model can see what went wrong. A handler returning a Go error is
the deviation from that, and usually means something broke.

Both are recorded, and each event says which happened, with the error's type
for the second: `*BookingError` is recorded as `BookingError`, and an error
wrapped with `%w` as what it wraps. Errors from `errors.New` or `fmt.Errorf`
have no type of their own and are recorded as `error`.

### And two that never reach your handler

Calls the server refuses on its own are recorded too: arguments that fail
validation, and names it has no tool for. A refused call carries no message,
because the validation text can quote back what the agent sent.

- On the official SDK, a refusal of arguments arrives looking like any other
  error result, and is recognised by the wording the SDK gives it. Wrapping
  a handler in `Track` removes any doubt: a call that reached a tracked
  handler is never counted as refused.
- On mcp-go, arguments are validated only with
  `server.WithInputSchemaValidation()`. Without it, nothing is refused and
  there is nothing to record.

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

```go
mcpsdk.Instrument(server, mcpspan.Config{CaptureParameterNames: true})
```

That records `{"destination": "string", "passengers": "number"}`, in JSON's
vocabulary, as the client sent them. Knowing `search_flights` is always
called with `destination` and never with `departure_date` tells you your
tool description is not landing. Knowing which destination tells you nothing
you needed, and puts your users' data somewhere it does not belong.

## Self-hosting

```go
mcpsdk.Instrument(server, mcpspan.Config{Endpoint: "https://mcpspan.example.com"})
```

Or set `MCPSPAN_ENDPOINT`. There is no default: events go only where you point
them. With a key and no endpoint, nothing is collected, and the SDK says so
once on standard error.

When it starts with a key, the SDK sends one empty batch to say it is there.
That is how the dashboard's Status page tells a server nobody has used yet
from one pointed at the wrong address, and how a wrong key is reported when
your server starts rather than at its first tool call.

## It will not break your server

- Delivery happens on a goroutine of its own. A tool call returns without
  waiting on the network, and the goroutine never keeps a program running.
- A failure to send never reaches your code, and nothing mcpspan does can
  panic into it. Retryable failures wait and try again with a widening gap;
  a refused key switches collection off and says so once on standard error.
- The queue is bounded. An unreachable endpoint cannot grow it until your
  process runs out of memory.
- Nothing is ever written to standard output, which carries the MCP protocol
  on a stdio server. Diagnostics go to standard error.

## Options

Fields of `mcpspan.Config`, given to `Instrument` or `mcpspan.Configure`.

| Field | Default | What it does |
|---|---|---|
| `APIKey` | `MCPSPAN_API_KEY` | Identifies your server. Without it, nothing is collected. |
| `Endpoint` | `MCPSPAN_ENDPOINT`; none | Your mcpspan installation. Nothing is collected without it. |
| `CaptureParameterNames` | `false` | Records parameter names and types, never values. |
| `ServerVersion` | `MCPSPAN_SERVER_VERSION`, then the server's own | The version to record calls under: a release, a tag, a commit. |
| `Debug` | `false` | Writes delivery diagnostics to standard error. |
| `OnDiagnostic` | - | Receives diagnostics instead. Implies `Debug`. |
| `FlushInterval` | `5s` | How long a partly filled batch waits. |
| `MaxBatchSize` | `100` | Events per request. Reaching it sends early. |
| `MaxQueueSize` | `10000` | Events held while delivery is failing. |

There is no `FlushOnExit`, as there is in the other SDKs: Go has no way to
run code as a program ends, which is what `defer mcpspan.Shutdown` is for.

Configuring again with the same settings changes nothing, so a server built
per request can pass them every time.

## Developing

Three modules, tied together by `go.work`: the core here, `mcpsdk` and
`mcpgo`.

```sh
go test ./... ./mcpsdk/... ./mcpgo/...
go vet ./... ./mcpsdk/... ./mcpgo/...
```

The SDK follows [the contract every mcpspan SDK
follows](../../docs/sdk-contract.md), checked by the suite in
[`conformance/`](../../conformance/README.md).

## Licence

MIT.
