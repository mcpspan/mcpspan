# mcpspan for the JVM

Analytics for MCP servers. Find out which of your tools get called, by which
client, how long they take, and which ones fail.

Your own logs tell you a tool ran. This tells you whether it was Claude,
Cursor, or something you have not heard of, how that call compares to the
other nine hundred, and whether the failures are your tool breaking or your
tool politely saying no.

## Install

For a server built on the official MCP Java SDK, `io.modelcontextprotocol.sdk`,
from Java or Kotlin:

```kotlin
dependencies {
    implementation("com.mcpspan:mcpspan-java-sdk:0.5.0")
}
```

Needs Java 17 or newer and the MCP Java SDK 2.0 or newer. The core,
`com.mcpspan:mcpspan`, has no dependencies at all.

## Use

Instrument the transport, and build the server on it as always:

```java
McpSyncServer server = McpServer
    .sync(McpSpanJavaSdk.instrument(
        new StdioServerTransportProvider(McpJsonDefaults.getMapper()),
        McpSpanOptions.builder()
            .apiKey(System.getenv("MCPSPAN_API_KEY"))
            .endpoint("http://localhost:6271") // your mcpspan installation
            .build()))
    .serverInfo("flights", "1.0.0")
    .tools(searchFlights)
    .build();
```

Every tool on the server is measured, whether it was given to the builder or
added later with `addTool`. Nothing about how you write tools changes, and each
tool returns and throws exactly what it did before.

A stdio transport starts reading the moment the server is built. Instrumenting
the transport hooks each session as it is created, so no call is missed.
A server on another transport, such as streamable HTTP, can be instrumented
once built instead:

```java
McpSpanJavaSdk.instrument(server);
```

With no API key given, it is read from `MCPSPAN_API_KEY`.

### Sessions and clients

Calls are grouped into sessions when there is a connection to group them by:
a stdio process, or an HTTP transport that hands out session IDs.

The client is read from the handshake of the session a call arrived on, and
from the call itself on the 2026-07-28 protocol once the MCP Java SDK speaks
it.

### Without a key

If there is no key, nothing is collected, nothing is sent, and no thread is
started. That makes it safe to leave in place in tests, in CI, and in a fork
somebody is only reading.

### One tool at a time

For a server `instrument` does not cover, wrap the tool's specification:

```java
server.addTool(McpSpanJavaSdk.track(searchFlights));
```

A tracked tool on an instrumented server is counted once.

### Leaving a tool out

```java
McpServer.sync(transport).tools(McpSpanJavaSdk.exclude(healthCheck));
```

For tools called by machinery rather than by an agent. A health check polled
every few seconds outnumbers everything a person does and drags the whole
server's error rate and response time towards its own. The name is read from
the tool itself, so a rename carries the exclusion along.

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

The MCP Java SDK does not check a prompt's required arguments, so a prompt
got without one is whatever its handler makes of it, not a refusal.

### Versions

Every call carries the version of the server that answered it, so the
dashboard marks where each release began and compares it with the one before.
There is nothing to add: it is the version the server gives itself,
`McpServer.sync(transport).serverInfo("flights", "1.4.0")`. To record a
commit or a deploy instead, set `serverVersion` (or `MCPSPAN_SERVER_VERSION`).
The client's version is recorded beside its name.

### Shutting down

What is queued is delivered as the JVM shuts down, so most servers need
nothing here. If yours has its own shutdown path and you want to be explicit:

```java
McpSpan.shutdown();
```

A process killed outright runs nothing after that, and the last few seconds
of calls go with it.

## Two kinds of failure

MCP asks tools to report their own errors inside the result, with `isError`
set, so the model can see what went wrong. An exception is the deviation from
that, and usually means the tool broke.

Both are recorded, and each event says which happened, with the exception's
class for the second: a `BookingException` is recorded as
`BookingException`, as your tool threw it.

### And two that never reach your tool

Calls the server refuses on its own are recorded too: arguments that fail the
tool's input schema, and names it has no tool for. A refused call carries no
message, because validation text can quote back what the agent sent. Whether a
call reached your tool is observed directly, not read from the server's
wording.

For a refusal of arguments, the SDK also says which ones. It checks what the
agent sent against the input schema your server listed, in your process, and
records the top-level arguments that did not match, by the names the schema
declares, so the tool's page can show that 29 refusals were all `passengers`.
Values are never sent, and neither is a name the agent made up. It works from
the latest `tools/list` your server answered in the same process; a refusal
before any listing names nothing.

## Privacy

**Parameter values never leave your process.** Not by default, not in any
mode, not in debug.

What is collected: the tool name, how long it took, whether it succeeded, the
error type and a truncated message when it did not, how large the answer was
in bytes (its size only, never its content), whether it repeated the previous
call's arguments to the same tool in its session (compared in your process;
the arguments, or any digest of them, never leave it), a fingerprint of the
tool's definition as your server lists it (its name, title, description and
input schema, hashed, so the dashboard can mark when you changed it), for a call your
server refused for its arguments the names of those that did not match the
tool's schema (never what was sent), which
client called, and the SDK version. For a resource or a prompt, the same, under the name it was
registered with: never the address a client read, only its template or, for
an address the server does not have, its scheme.

Optionally, parameter *names and types*:

```java
McpSpanOptions.builder().captureParameterNames(true).build();
```

That records `{"destination": "string", "passengers": "number"}`, in JSON's
vocabulary, as the client sent them. Knowing `search_flights` is always
called with `destination` and never with `departureDate` tells you your tool
description is not landing. Knowing which destination tells you nothing you
needed, and puts your users' data somewhere it does not belong.

Error messages are sent, cut short, because they are usually what says why a
call failed. If your tools can fail with text you would not send anywhere, as
a tool that runs commands or reads files might quote a path or a token, turn
them off:

```java
McpSpanOptions.builder().captureErrorMessages(false).build();
```

Every failure is still recorded, with where it came from and the exception's
type. Only the text is left out.

## Self-hosting

```java
McpSpanOptions.builder().endpoint("https://mcpspan.example.com").build();
```

Or set `MCPSPAN_ENDPOINT`. There is no default: events go only where you point
them. With a key and no endpoint, nothing is collected, and the SDK says so
once on standard error.

When it starts with a key, the SDK sends one empty batch to say it is there.
That is how the dashboard's Status page tells a server nobody has used yet
from one pointed at the wrong address, and how a wrong key is reported when
your server starts rather than at its first tool call.

## It will not break your server

- Delivery runs on a daemon thread of its own. A tool call returns without
  waiting on the network, and the thread never keeps a JVM running.
- A failure to send never reaches your code, and nothing here throws over a
  setting. Retryable failures wait and try again with a widening gap; a
  refused key switches collection off and says so once on standard error.
- The queue is bounded. An unreachable endpoint cannot grow it until your
  process runs out of memory.
- Nothing is ever written to standard output, which carries the MCP protocol
  on a stdio server. Diagnostics go to standard error.
- The MCP Java SDK has no hook for tool calls, so mcpspan reaches into two
  private places of it, as the other mcpspan SDKs do in theirs. If a version
  moves them, instrumenting finds nothing and leaves the server as it was.

## Options

Set on `McpSpanOptions.builder()`, given to `instrument` or
`McpSpan.configure`.

| Option | Default | What it does |
|---|---|---|
| `apiKey` | `MCPSPAN_API_KEY` | Identifies your server. Without it, nothing is collected. |
| `endpoint` | `MCPSPAN_ENDPOINT`; none | Your mcpspan installation. Nothing is collected without it. |
| `captureParameterNames` | `false` | Records parameter names and types, never values. |
| `captureErrorMessages` | `true` | Sends the text of a failure, cut short. Off sends that it failed and how, without the text. |
| `serverVersion` | `MCPSPAN_SERVER_VERSION`, then the server's own | The version to record calls under: a release, a tag, a commit. |
| `debug` | `false` | Writes delivery diagnostics to standard error. |
| `onDiagnostic` | - | Receives diagnostics instead. Implies `debug`. |
| `flushOnExit` | `true` | Delivers what is queued as the JVM shuts down. |
| `flushInterval` | 5 seconds | How long a partly filled batch waits. |
| `maxBatchSize` | `100` | Events per request. Reaching it sends early. |
| `maxQueueSize` | `10000` | Events held while delivery is failing. |

Configuring again with the same settings changes nothing.

## Developing

```sh
./gradlew build
```

The SDK follows [the contract every mcpspan SDK
follows](../../docs/sdk-contract.md), checked by the suite in
[`conformance/`](../../conformance/README.md).

## Licence

MIT.
