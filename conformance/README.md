# Conformance

Checks an mcpspan SDK against [the SDK contract](../docs/sdk-contract.md). The
same suite runs against every SDK, whatever its language: each ships a small
adapter, and the suite drives it as a real MCP client while standing in for
the ingest API.

```sh
pnpm --filter mcpspan build
pnpm --filter @mcpspan/conformance test
```

That runs the TypeScript adapter. For another one, give the command that
starts it. The Python SDK's, with the MCP SDK it runs on installed by uv
(`uv sync --group mcp2` in `packages/mcpspan-python`):

```sh
CONFORMANCE_ADAPTER="[\"$PWD/packages/mcpspan-python/.venv/bin/python\", \"adapters/python/server.py\"]" \
  pnpm --filter @mcpspan/conformance test
```

From the repository root. A relative path in the command would start from
this directory, where the adapter runs.

Every case is named after the section of the contract it checks, so a failure
says which rule was broken.

### Protocol revisions

MCP has two protocol revisions in use: 2025-11-25, with an `initialize`
handshake and sessions, and 2026-07-28, where the client names itself on
every request and there is no session. The suite speaks 2025-11-25 unless
told otherwise:

```sh
CONFORMANCE_ADAPTER='["node", "adapters/typescript-v2/server.mjs"]' \
CONFORMANCE_PROTOCOL=2026 \
  pnpm --filter @mcpspan/conformance test
```

An SDK should pass on every revision the MCP SDK it builds on speaks. CI runs
the TypeScript SDK three ways: on v1 of the official MCP SDK, which speaks
2025-11-25 only, and on v2 over both revisions. It runs the Python SDK five
ways: on v1 of the official Python MCP SDK, and on v2 and on FastMCP over both
revisions. It runs the Go SDK four ways: on the official Go SDK and on mcp-go,
over both revisions, the .NET SDK two ways, on the official C# SDK over
both, the JVM SDK once, on the official Java SDK over 2025-11-25, the only
revision it speaks, the Rust SDK two ways, on rmcp over both, the Ruby SDK two ways, on the
official `mcp` gem over both, and the PHP SDK three ways: on Laravel MCP over
both, and on the official PHP MCP SDK over 2025-11-25, since it speaks
2026-07-28 over HTTP only. A Go adapter is built first, and the suite runs the
binary:

```sh
(cd conformance/adapters/go-mcpsdk && go build -o adapter .)
CONFORMANCE_ADAPTER='["adapters/go-mcpsdk/adapter"]' \
  pnpm --filter @mcpspan/conformance test
```

On 2026-07-28 the suite's client checks the protocol version on the
connection itself. Left to its defaults, v2 of the TypeScript client would ask
a second, throwaway server process first, and that process announces itself
too (contract, 3.4). The cases are written against one connection being one
process, so the suite keeps it that way.

## Writing an adapter

An adapter is an MCP server over stdio, instrumented with the SDK under test.
It reads its configuration from the environment:

| Variable | Meaning |
|---|---|
| `MCPSPAN_API_KEY` | Pass to the SDK as the key. Absent in the case that checks an SDK with no key does nothing. |
| `MCPSPAN_ENDPOINT` | Pass to the SDK as the endpoint. The suite's fake ingest API. |
| `CONFORMANCE_FLUSH_MS` | The SDK's delivery interval, in milliseconds. Usually 200. |
| `CONFORMANCE_CAPTURE_PARAMETERS` | `1` to turn on recording parameter names and types, `0` to leave it off. |
| `CONFORMANCE_CAPTURE_ERROR_MESSAGES` | `0` to turn off sending error messages, `1` to leave the SDK's default, which sends them. |
| `MCPSPAN_SERVER_VERSION` | Read by the SDK itself, not by the adapter. Set in the case that checks it wins over the server's own version (contract, 3.6). |

The server names itself `conformance`, version `1.0.0`, the way the MCP SDK
lets a server declare its version (contract, 3.6); the client connects as
version `2.3.4`.

It registers these tools, with the SDK's ordinary instrumentation:

| Tool | Input | Does |
|---|---|---|
| `early` | none | Returns `ok`. Registered before the server is instrumented; every other tool after. |
| `ok` | none | Returns the text `ok`. |
| `reported_error` | none | Returns the text `No flights found` with `isError: true`. |
| `throws` | none | Throws an error whose type is `ConformanceError` and message `boom`. In Go, returns one. In Rust, returns `ErrorData::internal_error("boom")`, which has no type of its own; run the suite with `CONFORMANCE_EXCEPTION_TYPE=InternalError`, the name the Rust SDK gives its code. |
| `typed` | `destination`: string, `passengers`: number, both required | Returns `ok`. |
| `excluded` | `depth`: number | Returns `ok`, and is left out through the SDK's way of excluding a tool. |
| `long_` followed by 295 `x` | none | Returns `ok`. Its name is longer than the API takes. |
| `large` | none | Returns a text of 100,000 `x`, for the response size (contract, 3.7). |

And these resources and prompts (contract, 3.5):

| Resource or prompt | Does |
|---|---|
| resource `config://app` | Returns the text `ok`. |
| resource template `trips://{id}` | Returns the text `ok`. |
| resource `broken://status` | Throws `ConformanceError` with the message `boom`, as `throws` does. |
| prompt `plan_trip` | Takes `destination`, required, and returns one message. Refused without it where the MCP SDK checks required arguments, or where the prompt does so itself, as a Laravel prompt does. |
| prompt `broken_prompt` | Throws `ConformanceError` with the message `boom`, as `throws` does. |

It exits when its standard input closes, the way an MCP server does when its
client leaves, and does nothing else: no output of its own on standard out,
which carries the protocol.

[adapters/typescript/server.mjs](adapters/typescript/server.mjs) is the
reference, and [adapters/typescript-v2/server.mjs](adapters/typescript-v2/server.mjs)
the same on v2 of the official MCP SDK.
[adapters/python/server.py](adapters/python/server.py) runs on either major
version of the official Python MCP SDK, and
[adapters/python-fastmcp/server.py](adapters/python-fastmcp/server.py) on
FastMCP. [adapters/go-mcpsdk](adapters/go-mcpsdk/main.go) and
[adapters/go-mcpgo](adapters/go-mcpgo/main.go) are the Go SDK's, on the
official Go SDK and on mcp-go, and end with `mcpspan.Shutdown`, since Go has
no hook for a program's end. [adapters/dotnet](adapters/dotnet/Program.cs) is
the .NET SDK's; build it with `dotnet build -c Release -o out` and run
`["dotnet", "adapters/dotnet/out/Adapter.dll"]`. The MCP C# SDK refuses tool
names over 128 characters, so its long-named tool is a custom
`McpServerTool`. [adapters/java](adapters/java/src/main/java/adapter/Main.java)
is the JVM SDK's: `../../../packages/mcpspan-jvm/gradlew installDist` there,
then `["adapters/java/build/install/adapter/bin/adapter"]`. CI runs it with
`CONFORMANCE_RETRY=2`, which runs a failed case again with a fresh adapter:
the MCP Java SDK's stdio server can stall under load on its own. It gives every tool
at build time, as a Java server does, and allows the long name with
`strictToolNameValidation(false)`.

[adapters/php-mcpsdk](adapters/php-mcpsdk/server.php) and
[adapters/php-laravel](adapters/php-laravel/app/Mcp/ConformanceServer.php)
are the PHP SDK's: `composer update` in each, then
`["php", "adapters/php-mcpsdk/server.php"]` or
`["php", "adapters/php-laravel/artisan", "mcp:start", "conformance"]`. The
Laravel one is the smallest Laravel application that serves MCP, and names
mcpspan nowhere: the package's service provider does the work, with the
suite's settings in `config/mcpspan.php`.

[adapters/ruby](adapters/ruby/server.rb) is the Ruby SDK's, on the `mcp`
gem: `bundle install` there, then `["ruby", "adapters/ruby/server.rb"]`. The
suite passes an adapter nothing but `PATH`, so the adapter names its own
Gemfile. The gem refuses tool names over 128 characters where they are set,
so the long-named tool overrides `name_value`.

[adapters/rust](adapters/rust/src/main.rs) is the Rust SDK's, on rmcp:
`cargo build --release` there, then
`["adapters/rust/target/release/adapter"]`. A Rust server's tools are part of
it before it can be wrapped at all, so `early` is no different from the rest.

Where the MCP SDK builds the server lazily or once per request, as v2's
`serveStdio` and `createMcpHandler` do, configure mcpspan when the process
starts, not in the code that builds the server. The suite expects the
announcement at start, before any call arrives, as a real deployment should
send it.

## How it was checked

A suite that passes against a correct SDK proves little on its own. Each of
these was introduced into the TypeScript SDK in turn, and later into the
Python, Go, .NET, JVM, Rust, Ruby and PHP SDKs, and each failed the one case named, and no
other, in all of them:

| Broken | Case that failed |
|---|---|
| Tool names not cut to 200 characters | 4, cuts a tool name over 200 characters |
| A refused key does not stop the SDK | 6.4, stops for good on 401 and on 403 |
| `Retry-After` ignored | 6.5, waits at least as long as Retry-After asks |
| No announcement | 3.4, sends one empty batch at start |
| Parameter values sent instead of types | 5, records names and types when asked, and never a value |
| Nothing sent when the process ends | 6.6, sends what is queued when the client leaves |
| Tools registered before instrumenting left alone | 3.1, records a call to a tool registered before the SDK instrumented the server |

Particular to the Rust SDK, which reads rmcp's wording (contract, 3.2):

| Broken | Case that failed |
|---|---|
| rmcp's text for refused arguments changes | 3.2, records refused arguments under the tool, with no message |
| rmcp's text for a missing tool changes | 3.2, records a call to a tool the server lacks, under the name asked for |

Particular to the Ruby SDK, which observes refusals directly:

| Broken | Case that failed |
|---|---|
| Reaching the tool not noted | 3.1, records a result marked isError as a failure from the result; records a thrown error as an exception |
| A missing tool not looked up | 3.2, records a call to a tool the server lacks, under the name asked for |

Particular to the PHP SDK:

| Broken | Case that failed |
|---|---|
| Reaching the tool not noted (official SDK) | 3.1, records a thrown error as an exception |
| A missing tool not looked up (official SDK) | 3.2, records a call to a tool the server lacks |
| Laravel's ValidationException not read as refused arguments | 3.2, records refused arguments under the tool |
| A missing tool not recognised (Laravel) | 3.2, records a call to a tool the server lacks |

For resources and prompts (contract, 3.5), in every SDK and on every MCP SDK
it instruments:

| Broken | Case that failed |
|---|---|
| A templated read named by the address asked for | 3.5, names a read through a template by the template |
| An unknown read named by the whole address | 3.5, names a read of a resource the server lacks by its scheme alone |

And where the SDK itself tells refusals apart (Ruby, PHP):

| Broken | Case that failed |
|---|---|
| A missing prompt not looked up | 3.5, records a prompt the server lacks under the name asked for |
| Reaching the prompt not noted (Ruby), its required arguments not read (official PHP SDK), Laravel's ValidationException not read | 3.5, records a prompt got without an argument it requires, or records a prompt that throws as an exception |
