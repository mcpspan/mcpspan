# mcpspan for .NET

Analytics for MCP servers. Find out which of your tools get called, by which
client, how long they take, and which ones fail.

Your own logs tell you a tool ran. This tells you whether it was Claude,
Cursor, or something you have not heard of, how that call compares to the
other nine hundred, and whether the failures are your tool breaking or your
tool politely saying no.

## Install

```sh
dotnet add package McpSpan
```

Needs .NET 8 or newer (tested on 8, 9 and 10) and the official MCP C# SDK,
`ModelContextProtocol` 2.2 or newer. Nothing else.

## Use

One call on the server builder:

```csharp
using McpSpan;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly()
    .WithMcpSpan(new McpSpanOptions
    {
        ApiKey = Environment.GetEnvironmentVariable("MCPSPAN_API_KEY"),
        Endpoint = "http://localhost:6271", // your mcpspan installation
    });

await builder.Build().RunAsync();
```

Every tool on the server is measured, whether it was added before that call
or after. Nothing about how you write tools changes, and each tool returns
and throws exactly what it did before.

A server created with `McpServer.Create` rather than through dependency
injection is instrumented through its options:

```csharp
var options = McpSpanSdk.Instrument(new McpServerOptions { ToolCollection = tools });
```

With no `ApiKey`, it is read from `MCPSPAN_API_KEY`.

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

If there is no key, nothing is collected, nothing is sent, and no background
work is started. That makes it safe to leave in place in tests, in CI, and in
a fork somebody is only reading.

### One tool at a time

A server answering `tools/call` with a handler of its own, rather than tools
the SDK knows, can have that handler measured:

```csharp
builder.Services.AddMcpServer()
    .WithCallToolHandler(McpSpanSdk.Track(async (request, cancellationToken) => await Answer(request)));
```

A tracked handler on an instrumented server is counted once.

### Leaving a tool out

```csharp
[McpServerTool(Name = "health_check"), McpSpanExclude]
public static string HealthCheck() => "ok";
```

For tools called by machinery rather than by an agent. A health check polled
every few seconds outnumbers everything a person does and drags the whole
server's error rate and response time towards its own. The attribute sits on
the tool itself, so a rename carries it along.

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
`AddMcpServer(o => o.ServerInfo = new() { Name = "flights", Version = "1.4.0" })`.
To record a commit or a deploy instead, set `ServerVersion` (or
`MCPSPAN_SERVER_VERSION`). The client's version is recorded beside its name.

### Shutting down

What is queued is delivered as the process exits, so most servers need
nothing here. If yours has its own shutdown path and you want to be explicit:

```csharp
await McpSpanSdk.ShutdownAsync();
```

A process killed outright runs nothing after that, and the last few seconds
of calls go with it.

## Two kinds of failure

MCP asks tools to report their own errors inside the result, with `IsError`
set, so the model can see what went wrong. An exception is the deviation from
that, and usually means the tool broke.

Both are recorded, and each event says which happened, with the exception's
type for the second: a `BookingException` is recorded as `BookingException`,
as your tool threw it, before the MCP SDK turns it into an error result.

### And two that never reach your tool

Calls the server refuses on its own are recorded too: arguments the SDK
cannot bind to the tool's parameters, and names it has no tool for. A refused
call carries no message, because that text can name what the agent sent.

Whether a call reached your tool is read from where its exception came from:
one thrown while the SDK bound the arguments never passed through your code;
one your tool threw, even an `ArgumentException`, did.

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

```csharp
builder.Services.AddMcpServer()
    .WithMcpSpan(new McpSpanOptions { CaptureParameterNames = true });
```

That records `{"destination": "string", "passengers": "number"}`, in JSON's
vocabulary, as the client sent them. Knowing `search_flights` is always
called with `destination` and never with `departureDate` tells you your tool
description is not landing. Knowing which destination tells you nothing you
needed, and puts your users' data somewhere it does not belong.

## Self-hosting

```csharp
builder.Services.AddMcpServer()
    .WithMcpSpan(new McpSpanOptions { Endpoint = "https://mcpspan.example.com" });
```

Or set `MCPSPAN_ENDPOINT`. There is no default: events go only where you point
them. With a key and no endpoint, nothing is collected, and the SDK says so
once on standard error.

When it starts with a key, the SDK sends one empty batch to say it is there.
That is how the dashboard's Status page tells a server nobody has used yet
from one pointed at the wrong address, and how a wrong key is reported when
your server starts rather than at its first tool call.

## It will not break your server

- Delivery runs in the background on the thread pool. A tool call returns
  without waiting on the network, and nothing mcpspan starts keeps a process
  running.
- A failure to send never reaches your code, and `Configure`, `Instrument`,
  `WithMcpSpan` and `ShutdownAsync` never throw over a setting. Retryable
  failures wait and try again with a widening gap; a refused key switches
  collection off and says so once on standard error.
- The queue is bounded. An unreachable endpoint cannot grow it until your
  process runs out of memory.
- Nothing is ever written to standard output, which carries the MCP protocol
  on a stdio server. Diagnostics go to standard error.

## Options

Properties of `McpSpanOptions`, given to `WithMcpSpan`, `Instrument` or
`McpSpanSdk.Configure`.

| Option | Default | What it does |
|---|---|---|
| `ApiKey` | `MCPSPAN_API_KEY` | Identifies your server. Without it, nothing is collected. |
| `Endpoint` | `MCPSPAN_ENDPOINT`; none | Your mcpspan installation. Nothing is collected without it. |
| `CaptureParameterNames` | `false` | Records parameter names and types, never values. |
| `ServerVersion` | `MCPSPAN_SERVER_VERSION`, then the server's own | The version to record calls under: a release, a tag, a commit. |
| `Debug` | `false` | Writes delivery diagnostics to standard error. |
| `OnDiagnostic` | - | Receives diagnostics instead. Implies `Debug`. |
| `FlushOnExit` | `true` | Delivers what is queued as the process exits. |
| `FlushInterval` | 5 seconds | How long a partly filled batch waits. |
| `MaxBatchSize` | `100` | Events per request. Reaching it sends early. |
| `MaxQueueSize` | `10000` | Events held while delivery is failing. |

Configuring again with the same settings changes nothing.

## Developing

```sh
dotnet test
```

The SDK follows [the contract every mcpspan SDK
follows](../../docs/sdk-contract.md), checked by the suite in
[`conformance/`](../../conformance/README.md).

## Licence

MIT.
