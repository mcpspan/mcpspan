# mcpspan for PHP

Analytics for MCP servers. Find out which of your tools get called, by which
client, how long they take, and which ones fail.

Your own logs tell you a tool ran. This tells you whether it was Claude,
Cursor, or something you have not heard of, how that call compares to the
other nine hundred, and whether the failures are your tool breaking or your
tool politely saying no.

## Install

```sh
composer require mcpspan/mcpspan
```

For a server built on Laravel MCP, `laravel/mcp` 1.0 or newer, or on the
official PHP MCP SDK, `mcp/sdk` 0.8 or newer. Needs PHP 8.2 or newer.
Nothing else: delivery uses PHP's own HTTP streams.

## Use

On Laravel MCP there is nothing to write. Set the key and your mcpspan
installation in `.env`:

```sh
MCPSPAN_API_KEY=mcps_...
MCPSPAN_ENDPOINT=http://localhost:6271
```

The package's service provider instruments every MCP server the application
resolves, local and web alike. Other settings go in `config/mcpspan.php`:

```sh
php artisan vendor:publish --tag=mcpspan-config
```

On the official PHP MCP SDK, one line on the builder, before `build()`:

```php
$server = McpSdk::instrument(Server::builder(), [
    'apiKey' => getenv('MCPSPAN_API_KEY'),
    'endpoint' => 'http://localhost:6271', // your mcpspan installation
])
    ->setServerInfo('flights', '1.0.0')
    ->addTool(SearchFlights::class, 'search_flights')
    ->build();
```

Every tool on the server is measured, whether it was added before that line or
after, or registered once the server runs. Nothing about how you write tools
changes, and each tool returns and throws exactly what it did before. Call it
after any `setReferenceHandler()` of your own.

With no `apiKey`, it is read from `MCPSPAN_API_KEY`, and with no `endpoint`,
from `MCPSPAN_ENDPOINT`.

### Sessions and clients

Calls are grouped into sessions when there is a connection to group them by:
a stdio process, or an HTTP transport that hands out session IDs. Laravel
MCP's HTTP endpoints keep no sessions, and neither does the 2026-07-28
protocol, so calls there are recorded without one.

The client is read from the call itself on 2026-07-28, where each request
names its client, and from the handshake on 2025-11-25 where the connection
keeps it.

A tool that asks the client for more before it can finish is one call however
many round trips that takes.

### Without a key

If there is no key, nothing is collected, nothing is sent, and no process is
started. That makes it safe to leave in place in tests, in CI, and in a fork
somebody is only reading.

### One tool at a time

For a server neither integration covers, wrap the tool's handler:

```php
$search = McpSpan::track('search_flights', fn (string $destination): string => searchFlights($destination));
```

A tracked handler on an instrumented server is counted once.

### Leaving a tool out

```php
#[Exclude]
final class HealthCheck extends Tool
{
    // ...
}
```

For tools called by machinery rather than by an agent. A health check polled
every few seconds outnumbers everything a person does and drags the whole
server's error rate and response time towards its own. The attribute sits on
the tool's class, method or function, so a rename carries it along. A tool
with none of its own is left out by name:

```php
$builder->addTool(fn (): string => 'ok', McpSpan::exclude('health_check'));
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

On Laravel MCP and on the official PHP MCP SDK alike. A Laravel prompt checks
its own arguments, as a tool does: a `ValidationException` from it is refused
arguments.

### Versions

Every call carries the version of the server that answered it, so the
dashboard marks where each release began and compares it with the one before.
There is nothing to add: it is the version the server gives itself, with
`setServerInfo('flights', '1.4.0')` on the MCP SDK's builder, or
`protected string $version = '1.4.0';` (or `#[Version('1.4.0')]`) on a Laravel
MCP server. To record a commit or a deploy instead, set `serverVersion` (or
`MCPSPAN_SERVER_VERSION`). The client's version is recorded beside its name.

### Shutting down

What is queued is delivered as the program ends, so most servers need nothing
here. If yours has its own shutdown path and you want to be explicit:

```php
McpSpan::shutdown();
```

A process killed outright runs nothing after that, and the last few seconds
of calls go with it.

## Two kinds of failure

MCP asks tools to report their own errors inside the result, as
`Response::error()` in Laravel or `CallToolResult::error()` in the MCP SDK,
so the model can see what went wrong. An exception is the deviation from
that, and usually means the tool broke.

Both are recorded, and each event says which happened, with the exception's
class for the second: a `BookingException` is recorded as `BookingException`,
as your tool threw it, though both MCP SDKs hand the client a generic error.

### And two that never reach your tool

Calls the server refuses are recorded too: arguments it will not take, and
names it has no tool for. A refused call carries no message, because
validation text can quote back what the agent sent.

The MCP SDK checks arguments against the tool's schema before the tool runs,
and mcpspan sees directly whether the tool was reached. Laravel leaves the
checking to the tool, with `$request->validate()`, so there a call refused
with Laravel's `ValidationException` is the refusal: a type Laravel documents
for exactly that.

## Privacy

**Parameter values never leave your process.** Not by default, not in any
mode, not in debug.

What is collected: the tool name, how long it took, whether it succeeded, the
error type and a truncated message when it did not, which client called, and
the SDK version. For a resource or a prompt, the same, under the name it was
registered with: never the address a client read, only its template or, for
an address the server does not have, its scheme.

Optionally, parameter *names and types*:

```php
McpSpan::configure(['captureParameterNames' => true]);
```

That records `{"destination": "string", "passengers": "number"}`, in JSON's
vocabulary, as the client sent them. Knowing `search_flights` is always
called with `destination` and never with `departure_date` tells you your tool
description is not landing. Knowing which destination tells you nothing you
needed, and puts your users' data somewhere it does not belong.

## Self-hosting

```php
McpSpan::configure(['endpoint' => 'https://mcpspan.example.com']);
```

Or set `MCPSPAN_ENDPOINT`. There is no default: events go only where you point
them. With a key and no endpoint, nothing is collected, and the SDK says so
once on standard error.

When a long-running server starts with a key, the SDK sends one empty batch
to say it is there. That is how the dashboard's Status page tells a server
nobody has used yet from one pointed at the wrong address, and how a wrong
key is reported when your server starts rather than at its first tool call.
PHP that serves one request per process has no start to speak of, and says
nothing until a tool is called.

## It will not break your server

- A tool call never waits on the network. A long-running server, on stdio or
  under Octane or RoadRunner, hands its events to a small PHP process of its
  own, which batches and delivers them. PHP that serves one request per
  process, as under PHP-FPM, delivers at the end of the request, after
  Laravel and Symfony have sent the response.
- A failure to send never reaches your code, and nothing here throws over a
  setting. Retryable failures wait and try again with a widening gap; a
  refused key switches collection off and says so once on standard error.
- The queue is bounded. An unreachable endpoint cannot grow it until your
  process runs out of memory.
- Nothing is ever written to standard output, which carries the MCP protocol
  on a stdio server. Diagnostics go to standard error.
- Both integrations go through the MCP SDK's own extension points: Laravel
  MCP's `addMethod()`, and the MCP SDK builder's request and reference
  handlers. The one thing read past them, the MCP SDK builder's assembled
  parts, is checked by a test; if a version moves it, instrumenting leaves
  the server as it was.

## Options

Keys of the array given to `McpSpan::configure`, `McpSdk::instrument` or
`config/mcpspan.php`.

| Option | Default | What it does |
|---|---|---|
| `apiKey` | `MCPSPAN_API_KEY` | Identifies your server. Without it, nothing is collected. |
| `endpoint` | `MCPSPAN_ENDPOINT`; none | Your mcpspan installation. Nothing is collected without it. |
| `captureParameterNames` | `false` | Records parameter names and types, never values. |
| `serverVersion` | `MCPSPAN_SERVER_VERSION`, then the server's own | The version to record calls under: a release, a tag, a commit. |
| `debug` | `false` | Writes delivery diagnostics to standard error. |
| `onDiagnostic` | - | Receives diagnostics instead. Implies `debug`. |
| `flushOnExit` | `true` | Delivers what is queued as the program ends. |
| `flushInterval` | `5` seconds | How long a partly filled batch waits. |
| `maxBatchSize` | `100` | Events per request. Reaching it sends early. |
| `maxQueueSize` | `10000` | Events held while delivery is failing. |

Configuring again with the same settings changes nothing.

## Developing

```sh
composer install
composer test
composer analyse
composer lint
```

The SDK follows [the contract every mcpspan SDK
follows](../../docs/sdk-contract.md), checked by the suite in
[`conformance/`](../../conformance/README.md).

## Licence

MIT.
