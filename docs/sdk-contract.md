# The mcpspan SDK contract

What every mcpspan SDK does, in any language, and what the ingest API expects
from it. The TypeScript SDK in `packages/mcpspan` is the reference and follows
this document without exceptions; an SDK in another language is correct when it
does too.

The words MUST, MUST NOT, SHOULD and MAY are used as in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

Contract version 1.

---

## 1. The first rule

An SDK runs inside somebody else's MCP server. Everything below gives way to
this:

- An SDK MUST NOT raise an error, reject a promise, or panic into the host's
  code. Not from configuration, not from recording a call, not from delivery.
- An SDK MUST NOT change what a tool returns, or whether it throws, or what
  the client receives.
- An SDK MUST NOT make a tool call wait on the network. Recording is an append
  to memory; delivery happens elsewhere.
- An SDK MUST NOT write to standard output. On the stdio transport, stdout
  carries the MCP protocol, and a stray line corrupts it. Diagnostics go to
  standard error, or to a logger the developer supplies.
- An SDK MUST bound its memory. Events waiting for delivery are capped (see
  6.3), however long the ingest API is unreachable.
- An SDK MUST NOT keep a process alive that would otherwise exit. Timers are
  unreferenced, or the language's equivalent.
- An SDK SHOULD have no dependencies beyond the language's standard library
  and the official MCP SDK it instruments.

## 2. Configuration

| Setting | Source, in order | Meaning |
|---|---|---|
| API key | explicit option, then `MCPSPAN_API_KEY` | Identifies the server the events belong to. |
| Endpoint | explicit option, then `MCPSPAN_ENDPOINT` | Base URL of the ingest API, without a path: the user's own installation. There is no default. |
| Server version | explicit option, then `MCPSPAN_SERVER_VERSION`, then the version the server gives itself (3.6) | What `serverVersion` says: a release, a tag, a commit. |

- With no API key, an SDK MUST do nothing at all: no network, no timers, no
  measuring. Wrapped handlers MUST behave exactly as unwrapped ones. This is a
  normal state, for development and CI, and MUST NOT be reported as a problem.
- With an API key and no endpoint, an SDK MUST do nothing at all either, and
  MUST say so once on standard error, naming `MCPSPAN_ENDPOINT`, diagnostics
  on or not: a key means
  somebody meant to collect, and without the line their data would silently
  go nowhere. There is no default endpoint because mcpspan runs where its
  user runs it: an SDK that sent anywhere by default would send data off the
  user's machine without their asking.
- A malformed option MUST fall back to its default, and MAY be reported on
  standard error when diagnostics are on. It MUST NOT stop the server starting.
- The delivery interval (6.2) and recording parameter names (5) MUST be
  settable. The conformance suite needs both, and so do developers.
- Configuring again with the same settings MUST change nothing: no second
  announcement (3.4), no new queue, nothing queued dropped. MCP SDKs that
  build a server per request or per connection lead developers to configure
  there, and every request would otherwise start the SDK over. Different
  settings MAY replace the running SDK.
- Where the MCP SDK builds servers lazily, an SDK's documentation SHOULD show
  configuring once when the process starts and instrumenting each server as
  it is built, so the announcement goes out at start.

What an SDK looks like to a developer - its operations, settings, package
and documentation - is the same in every language too, and set out in
section 13.

Whether an SDK follows this contract is checked by the suite in
[`conformance/`](../conformance/README.md), which runs against any SDK through
a small adapter.

## 3. What is measured

### 3.1 Tool calls that reach a handler

An SDK wraps each tool handler the server registers. For every call it
records one event, when the call settles:

- The handler returned a result with `isError: true`: a failure, `errorSource`
  `result`. MCP asks tools to report errors this way, so this is the ordinary
  failure, not the exception.
- The handler threw, or its promise rejected: a failure, `errorSource`
  `exception`. The error MUST propagate to the caller unchanged.
- Otherwise: a success.

An SDK that only watched for exceptions would report a correctly written
server as never failing. Both forms MUST be recorded.

Duration is measured from the call to the settling of its result, on a
monotonic clock.

On the 2026-07-28 protocol a handler can answer with an interim result
(`resultType: "input_required"`), asking the client for input and to call
again. That answer MUST NOT be recorded; the call is recorded when a final
result settles it. Where the MCP SDK turns an interim result into an error
because the transport cannot carry the question (the TypeScript MCP SDK does
this on a stateless 2025-11-25 HTTP endpoint), that is a failure with
`errorSource` `result`, since it is what the model saw.

An SDK MUST measure every tool on a server it instruments, whether the tool
was registered before instrumentation or after. Where it goes, and where the
developer puts that line, should not decide what is counted.

### 3.2 Calls the server refuses before any handler runs

The official MCP SDKs validate arguments against a tool's schema, and look the
tool up, before calling a handler. A refusal reaches the model as an error
result or, for a missing tool in some MCP SDKs (the TypeScript MCP SDK from
v2), as a protocol error. Where the MCP SDK allows it, an SDK SHOULD record
both kinds, however they are delivered:

- The tool exists and is enabled, and the arguments were refused:
  `errorSource` `arguments`, under that tool's name.
- The server has no enabled tool by that name: `errorSource` `unknown_tool`,
  under the name that was asked for.

Whether a call reached its handler MUST be decided by something the SDK
observes directly (the TypeScript SDK marks the request context the MCP SDK
passes to both the request handler and the tool handler), or by distinct
exception types an MCP SDK documents for the refusals it makes before any
handler runs (FastMCP's `NotFoundError` and `ValidationError`), not by
parsing the text of the refusal. The text MAY be checked as well, so that a
refusal of some other kind is left out rather than miscounted.

One exception, where the MCP SDK leaves nothing else: the official Go SDK
hands a refusal of arguments to middleware as an ordinary error result, its
validator's error flattened into text, and offers no way to see whether a
handler ran. The Go SDK recognises it by the fixed prefix the MCP SDK writes
(`validating "arguments"`), only when a tracked handler did not show the call
reached it, and the conformance suite fails if that prefix ever changes.

Rust's rmcp leaves the same: it deserializes a tool's arguments inside the
tool's own handler, turns a failure into an error result reading `failed to
deserialize parameters:`, and answers a missing tool with an invalid-params
error reading `tool not found`. The Rust SDK recognises both by that text, with
the error code where there is one, and the conformance suite fails if either
ever changes (16).

A refused call carries no `errorMessage`. Validation libraries can quote the
offending value back, and that value is a parameter value (see 5).

### 3.3 Tools left out

An SDK MUST offer a way to leave a tool out entirely, for tools called by
machinery rather than agents, such as health checks. A tool left out produces
no events, including for refused calls to it.

### 3.4 The announcement

When configured with a key, an SDK MUST send one empty batch
(`{"events": []}`) once, in the background, as soon as it starts. It proves
that the key and the endpoint work before anyone calls a tool, which is how
the dashboard tells an unused server from one pointed at the wrong address.

- It MUST NOT delay startup and MUST NOT be retried.
- A 401 or 403 answer to it MUST be handled as in 6.4, so a wrong key is
  reported at startup.
- Any other failure MAY be reported when diagnostics are on, and is otherwise
  ignored.

The announcement is per process. A client may start a server process only to
probe it and stop it again: v2 of the TypeScript MCP SDK does this over stdio
before a 2026-07-28 connection, asking a throwaway process `server/discover`.
That process is a real start, and announces like any other; the API treats
an announcement as a sign of life, so a second one costs nothing.

### 3.5 Resources and prompts

Besides calling tools, a client reads resources (`resources/read`) and gets
prompts (`prompts/get`). An SDK SHOULD record both, with `kind` set to
`resource` or `prompt`, as it records tool calls: one event when the request
settles, timed the same way, in the same session, from the same client. Lists
(`resources/list`, `prompts/list`, `resources/templates/list`) and
subscriptions are not recorded: they are how a client finds its way, not use.

What is recorded as the name MUST NOT carry anything the client supplied
beyond the name itself, since a resource's address can hold a user's data
(`file:///home/ada/contract.pdf`, `db://customers/4412`):

- A resource the server registered at a fixed URI is named by that URI: the
  developer wrote it, and it names no one.
- A resource read through a URI template is named by the **template**
  (`users://{id}/profile`), never by the URI the client asked for. The
  template's variables are its parameters (5): their names, when recording
  parameter names is on, and never their values. They are all `string`.
- A prompt is named by its name. Its arguments are its parameters, as a tool's
  are.
- A read of a resource the server does not have is `unknown_resource`, named
  by the **scheme** of the address asked for (`db://`), which is all of it an
  SDK may keep. A get of a prompt the server does not have is `unknown_prompt`,
  named as asked.
- A prompt got without an argument it requires, refused before its handler
  runs, is `arguments`, as for tools.
- Otherwise a handler that throws is `exception`, and one that returns is a
  success: neither a resource nor a prompt has an error result of its own.

Where an MCP SDK offers no way to tell these apart, or no way to see the
request at all, an SDK MAY leave resources or prompts unrecorded, and says so
in the section on where it stands.

### 3.6 Versions

Every event SHOULD say which version of the server answered it, so the
dashboard can mark where a release began and compare one with the one
before. `serverVersion` is the server version setting (2) when given, and
otherwise the version the server gives itself in its handshake, which every
MCP server declares (`serverInfo.version`). Reading that is the default,
because it needs nothing from the developer: the version is already in the
code that builds the server. The setting is for a version worth more than
that one, a commit or a deploy, and for MCP SDKs that keep the server's own
version out of reach.

`clientVersion` is the version the client gives itself, read from where its
name is read (7): each request on 2026-07-28, the handshake before that.

Neither is ever made up. A server or client that names no version sends
none. Where the MCP SDK fills in a placeholder for a server that gave none,
and the SDK can tell, the placeholder is left out: it is not the server's,
and one that follows the MCP SDK's own version would mark every upgrade of
it as a release. Where the placeholder is stored like any version given, it
is what the server announces, and is recorded.

Where each SDK reads the server's own version:

| SDK | From | Left out |
|---|---|---|
| TypeScript | the MCP SDK's private `_serverInfo`, on v1 and v2 | |
| Python | `version` of `MCPServer` (v2) and of FastMCP, else of the low-level server | v1's `FastMCP`, which takes none and announces the `mcp` package's own |
| Go | the private `impl.Version` (official SDK) and `version` (mcp-go), by reflection; a test fails if either moves | |
| .NET | `ServerOptions.ServerInfo.Version`, public | |
| JVM | `McpAsyncServer.getServerInfo().version()`, public | |
| Rust | `get_info().server_info.version`, read at the first call | rmcp's own name and version, its default; a tool tracked alone cannot see the server |
| Ruby | `MCP::Server#version` (the gem's default, `0.1.0`, is recorded) | |
| PHP | the MCP SDK builder's private `serverInfo`; Laravel MCP's `$version` or `#[Version]` (its default, `0.0.1`, is recorded) | an MCP SDK server never given `setServerInfo`, announced as `dev` |

### 3.7 Response size

A tool that now and then answers with megabytes fills the client's context and
looks fine on every latency chart. So an event SHOULD say how large the answer
was: `responseBytes`, the length in bytes of the call's result (the JSON-RPC
`result` the server sends back) encoded as compact UTF-8 JSON by the
language's usual JSON encoder.

- Only for a call that returned an answer: a success, or a failure the result
  reported (`errorSource` `result`). Absent for exceptions and refusals, which
  send an error rather than a result, and for answers that settle nothing yet
  (an interim result asking the client for input, a task the client polls).
- The size is all that is taken. The content is encoded to be counted and not
  kept, read or sent; privacy (5) is unchanged.
- Encoders differ a little between languages (escaping, an absent field against
  a null one), so the same answer can count a few bytes apart in two SDKs. The
  figure is for spotting an answer ten or a thousand times larger than usual,
  not for billing.
- It is what the client got, whatever wrote it: an SDK that adds the text again
  as structured content (FastMCP does, for a tool typed as returning a string)
  sends twice the bytes, and that is the size recorded.
- Over 2,147,483,647 bytes it is sent as that number.

### 3.8 Tool definitions

Rewording a tool's description can change how often agents call it, and how
well, more than a change to its code. So a tool call SHOULD carry
`definitionHash`, a fingerprint of the tool as the server lists it, which
lets the dashboard mark when a tool's definition changed.

- Taken from the server's answer to `tools/list`, as it goes to the client:
  what an agent actually read. An SDK keeps the latest fingerprint listed for
  each tool, for the life of the process, and sends it with each call to that
  tool, including one whose arguments the server refused. A call to a tool no
  listing in this process named has none.
- The fingerprint covers the tool's `name`, `title`, `description` and
  `inputSchema`, those of them present. Other fields (annotations, the output
  schema, `_meta`) are left out: they change what a client may do, not what a
  model reads first.
- Those fields are written as one JSON object in canonical form: keys sorted
  by their characters (all keys in MCP's own schemas are ASCII, so code point
  and UTF-16 order agree), no whitespace, strings escaping only `"`, `\` and
  control characters (`\b`, `\f`, `\n`, `\r`, `\t` as such, the rest as
  `\u00XX` in lower case), everything else as is in UTF-8, integers without a
  fraction, `true`, `false`, `null` as such. The fingerprint is the first 16
  characters of the SHA-256 of its UTF-8 bytes, in lower-case hex. A number
  with a fraction is written as the language writes it; schemas rarely hold
  one, and an SDK that writes it differently only marks one change on the day
  the server moves to it.
- Every SDK MUST give the same fingerprint for the same definition, checked
  by the cases in `conformance/definition-hashes.json`: moving a server from
  one SDK to another must not look like a change.
- Not for resource reads, prompt gets, or calls the server refused as unknown.

### 3.9 Repeated calls

An agent stuck in a loop calls the same tool with the same arguments again
and again, and each call looks fine on its own. So a tool call SHOULD carry
`repeated: true` when its arguments are the same as those of the previous
call to the same tool in the same session (8).

- Arguments are compared as the client sent them, before any validation, so
  the same bad arguments sent twice are a repeat. Two argument objects are
  the same when their canonical JSON (3.8) is.
- The comparison is made in the process and only its outcome leaves it. The
  SDK keeps, for each session and tool, a SHA-256 of the canonical arguments
  of the latest call, and nothing else; no digest, no value, no part of one
  is ever sent. A digest is not private on its own (a short identifier or an
  enumerated value can be found by trying every candidate), which is why it
  never leaves.
- What is kept is bounded: an SDK keeps at most 10,000 session and tool
  pairs, forgetting the oldest first. A pair forgotten makes its next call
  look new, which only ever undercounts.
- Every tool call counts, those the server refused included (an agent
  retrying the same unknown tool or the same bad arguments is the commonest
  loop). Not resource reads or prompt gets, and not a call without a session,
  which cannot be told apart from another client's.
- A call whose parameters carry `inputResponses` or `requestState` answers
  an interim result's question (2026-07-28) and continues the call that
  asked; it is neither compared nor kept, so the call it completes is not
  counted as its own repeat.
- `repeated` is absent rather than false on any other call.

### 3.10 Which arguments were refused

A refusal of arguments says that an agent got a tool's input wrong, not
where. So a call refused with `errorSource` `arguments` SHOULD carry
`invalidArguments`: the names of the top-level arguments that did not match
the tool's input schema. Twenty-nine refusals of `book_flight`, all of them
`passengers`, point at one sentence of its description.

- The SDK finds them itself, checking the arguments as the client sent them
  against the `inputSchema` of the tool's latest listing (3.8). It does not
  read the server's refusal: each validation library words it differently,
  and some quote the value back.
- Only a name the schema declares is ever sent: a key of its `properties`,
  or a name in its `required`. An argument the schema does not have is
  never named, since its name came from the client and could be anything,
  a value included. Values are read in the process and never leave it.
- A name is reported when it is in `required` and absent from the arguments,
  or present with a value that fails its property's schema. A schema fails a
  value under these checks only (a schema of `false` fails every value, one
  of `true` none):
  - `type`, one name or a list of them: `string`, `number` (any number),
    `integer` (a number with no fraction, `2.0` included), `boolean`,
    `object`, `array`, `null`. A boolean is not a number.
  - `enum` and `const`: the value equals one of the listed values, or the
    one given, compared by canonical JSON (3.8).
  - On a number: `minimum`, `maximum`, and `exclusiveMinimum` and
    `exclusiveMaximum` given as numbers.
  - On a string: `minLength` and `maxLength`, counted in code points. On an
    array: `minItems` and `maxItems`.
  - On an object: `required`, and `properties`, each present property
    checked against its own schema. On an array: `items` given as one
    schema, each element checked against it.
  Nothing else is checked: not `$ref`, `anyOf`, `oneOf`, `allOf`, `not`,
  `pattern`, `format` or `additionalProperties`, and not a keyword whose
  value is not of the kind it takes. What is not checked never fails, so an
  SDK can name fewer arguments than were wrong, never one that was right.
- Arguments that are absent or `null` are checked as an empty object;
  arguments that are not an object give no names.
- Names are sorted as keys are in 3.8, at most 20 are sent, and each is cut
  to 200 characters. When the checks find nothing, because the refusal was
  over something they leave out or because no listing in this process named
  the tool, the field is absent and the call is still recorded as refused.
- Every SDK MUST find the same names for the same schema and arguments,
  checked by the cases in `conformance/argument-checks.json`.
- Only on tool calls refused with `errorSource` `arguments`.

## 4. The event

A batch is a JSON object with one field, `events`, an array of these:

| Field | Type | Required | Limit | Meaning |
|---|---|---|---|---|
| `id` | UUID string | yes | | Made by the SDK, once per event. Makes redelivery harmless: the API stores an event once. |
| `kind` | string | no | 20 characters | `tool`, `resource` or `prompt` (3.5). Absent means `tool`, which is what SDKs from before 3.5 measured. |
| `toolName` | string | yes | 1 to 200 characters | What was called: the tool's registered name, or the name asked for in an `unknown_tool` refusal; for a resource or a prompt, its name as 3.5 sets out. Named for tools, which came first. |
| `durationMs` | number | yes | finite, at least 0 | Fractional milliseconds. |
| `success` | boolean | yes | | |
| `errorSource` | string | when `success` is false | 50 characters | `result`, `exception`, `arguments` or `unknown_tool`; `unknown_resource` or `unknown_prompt` for 3.5. MUST be absent on success. |
| `errorType` | string | no | 200 characters | For `exception`: the error's class or kind, such as `TypeError`. |
| `errorMessage` | string | no | see below | For `result`: the text of the result, 200 characters at most. For `exception`: the error's message, 500 at most. Absent for refused calls, and on every event when the developer turned off capturing error messages (5). |
| `clientType` | string | yes | 1 to 50 characters | One of the values in 7. |
| `clientName` | string | no | 200 characters | The client's own name, as sent (see 7). |
| `clientVersion` | string | no | 100 characters | The client's own version, as sent (3.6). |
| `serverVersion` | string | no | 100 characters | The version of the server that answered (3.6). |
| `responseBytes` | integer | no | 0 to 2,147,483,647 | Size of the answer, in bytes (3.7). |
| `definitionHash` | string | no | 64 characters | The tool's definition, as listed, fingerprinted (3.8). |
| `repeated` | boolean | no | | `true` when the call's arguments are the previous call's to the same tool in the same session (3.9); absent otherwise. |
| `invalidArguments` | array of strings | no | 20 entries, each 1 to 200 characters | Which top-level arguments of a refused call did not match the tool's schema, by the names the schema declares (3.10). |
| `timestamp` | string | yes | ISO 8601 with an offset | When the call started, by the reporting machine's clock. |
| `sdkVersion` | string | yes | 1 to 50 characters | The SDK's own version. |
| `sessionId` | UUID string | no | | See 8. |
| `parameters` | object of string to string | no | 100 entries; names 200, types 50 characters | See 5. |

- Text over its limit MUST be cut by the SDK before sending. The API refuses a
  whole batch when any one field is over, so one over-long name would lose
  every other event beside it. Names come from outside the developer's control
  (a client names itself, an exception names its class), so this is not
  hypothetical. The TypeScript SDK cuts with a trailing `...`.
- The API is strict about shape and lengths and lenient about vocabulary. A
  `clientType` or `errorSource` it does not know is stored, not refused, so a
  newer SDK can add one without its events being lost.
- Fields not listed here MUST NOT be sent. The API drops fields it does not
  know without refusing the batch, so a misspelt field is lost silently rather
  than reported: an SDK cannot rely on the API to catch it, and its own tests
  have to.

## 5. Privacy

- **Parameter values MUST NOT leave the process.** Not in any mode, not in
  debug, not in an error message the SDK builds.
- Parameter names and types MAY be recorded, and only when the developer
  turns that on (off by default). Only the top-level keys of the arguments
  object are read, at most 50 of them. The type is one of `string`,
  `number`, `boolean`, `object`, `array`, `null`, or the language's name for
  anything else.
- Result content other than text MUST NOT be read. For a failed result, the
  text blocks are joined and cut to 200 characters: that text was written for
  a model to read and is the most likely to quote what the user asked, which
  is why it is kept shorter than an exception's.
- Error messages are sent by default, cut as 4 sets out, and MUST NOT be
  sent at all when the developer turns capturing them off: then no event
  carries `errorMessage`, whatever wrote it. A tool that runs commands or
  reads files can fail with text that quotes a path, a token or a line of
  configuration, and a developer who knows their tools do that needs one
  switch rather than a promise to be careful. Everything else about a
  failure is still sent: that it failed, its `errorSource`, and its
  `errorType`, which is the name of a class or kind, not text. Leaving it on
  by default keeps what most servers need to see why a call failed; the
  README says how to turn it off and why one might.
- An answer MAY be encoded to measure its size (3.7), and MUST then be
  dropped: the size is all that leaves the process.
- Arguments MAY be checked against the tool's schema to tell which were
  refused (3.10), and only the names the schema declares are sent.
- Arguments MAY be digested to tell a repeated call (3.9), and the digest
  MUST stay in the process: only whether the call repeated the previous one
  is sent.
- An SDK MUST NOT record anything that identifies a person: no IP address, no
  user identifier, no transport session identifier (see 8).
- The address a client read MUST NOT be recorded, only the URI or template
  the server registered, or the scheme of an address it does not have (3.5).

## 6. Delivery

### 6.1 The request

```
POST {endpoint}/v1/events
Authorization: Bearer {api key}
Content-Type: application/json
User-Agent: mcpspan/{sdk version} ({language})
```

The language is lower case: `typescript`, `python`, `go`. The API reads the
version from this header to show which SDK a server runs.

A batch is accepted with `202` and a body of
`{"accepted": <events received>, "stored": <events newly stored>}`. The two
differ when events were redelivered.

### 6.2 Batching

| | TypeScript default |
|---|---|
| Send a partly filled batch after | 5 seconds |
| Events per request | 100, sent at once when reached |
| Events held while delivery is failing | 10,000 |
| One request may take | 10 seconds |

The API accepts up to 1,000 events and 4 MB per request. An SDK MUST stay
within both.

### 6.3 A full queue

When the queue is full, the oldest events are dropped to make room. An SDK
SHOULD report how many it dropped when diagnostics are on.

### 6.4 Answers

| Answer | What the SDK does |
|---|---|
| `202` | Done. Resets the backoff. |
| `401`, `403` | The key is refused and will be refused again. Stop collecting for the life of the process, drop what is queued, and say so on standard error once, **even with diagnostics off**: a silent SDK with a wrong key is the worst afternoon a developer can have. |
| `408`, `429`, `5xx`, no answer | Keep the batch and retry later (6.5). |
| Any other `4xx`, such as `400` or `413` | The batch will be refused the same way every time. Drop it, keep collecting, report it when diagnostics are on. |

### 6.5 Retrying

- The delay after the n-th consecutive failure is drawn evenly from
  `[c/2, c]`, where `c = min(60 s, 1 s × 2^(n-1))`. The spread matters once
  many servers report to one endpoint: without it they all come back at once
  and cause a second outage.
- When the API sends `Retry-After`, in seconds or as a date, the SDK MUST wait
  at least that long, and MAY cap what it follows at 5 minutes.
- While a delay runs, new events are queued, not sent.

### 6.6 Shutting down

- An SDK MUST offer an explicit shutdown that sends what is queued, ignoring
  any delay in progress, because it is the last chance.
- An SDK SHOULD also send what is queued when the process ends on its own
  (in Node, `beforeExit`; in Python, `atexit`), since a stdio server often
  lives as long as one conversation. Where the language has no such hook, as
  Go does not, its documentation MUST show the explicit shutdown where the
  program ends (`defer mcpspan.Shutdown(ctx)` in `main`).
- An SDK MUST NOT intercept signals or the server's own exit handling.

## 7. Client types

The client's name is read per call, from the first of these that has one:

1. The request itself. On the 2026-07-28 protocol every request carries its
   client in `_meta["io.modelcontextprotocol/clientInfo"]`.
2. The initialize handshake of the connection the call arrived on, on
   2025-11-25.

It MUST NOT be taken from any other connection. Where neither is available,
as on a stateless 2025-11-25 HTTP endpoint that builds a server per request,
the client is unknown. Concurrent calls from different clients MUST each carry
their own.

`clientType` is derived from that name by case-insensitive substring match,
first match wins:

| Name contains | `clientType` |
|---|---|
| `claude-code` or `claude code` | `claude-code` |
| `claude` | `claude` |
| `cursor` | `cursor` |
| `chatgpt` or `openai` | `chatgpt` |
| `inspector` | `mcp-inspector` |
| anything else | `other` |
| no name known | `unknown` |

The order matters: `claude-code` must be tested before `claude`. The raw name
goes in `clientName` as well, so a client with no entry here is still
identifiable.

The table's cases are in `conformance/client-types.json`, and every SDK's unit
tests read that one file.

## 8. Sessions

`sessionId` groups the calls made over one connection, which is what lets the
dashboard show what an agent did in what order.

- It is a random UUID the SDK makes, one per server instance and transport
  session. Over stdio that is one per process. Over HTTP it follows the
  transport's own session.
- Over HTTP without a transport session, a call MUST carry no `sessionId`.
  That is a stateless endpoint, and every endpoint on the 2026-07-28
  protocol, which has no sessions. The server instance is not a stand-in
  there: MCP SDKs build one per request, which would make every call a
  session of its own.
- It MUST NOT be the transport's session identifier, or be derived from it.
  That identifier travels in HTTP headers, and anyone with the server's logs
  could join them to these events.
- An SDK MAY forget the oldest idle sessions once it tracks many (TypeScript:
  1,000 per server instance).
- Calls recorded in a way that cannot see the connection, such as wrapping a
  single function by hand, carry no `sessionId`.

## 9. Changing this contract

- Adding an optional field, or a new value to an open vocabulary, is a minor
  change. The API accepts it before SDKs send it.
- Removing a field, tightening a limit, or changing what a field means is a
  new contract version, and the API keeps accepting the old one.

## 10. Where the TypeScript SDK stood

Writing this down against the code found two places where it did not follow
what the API needs, both now fixed, and supporting v2 of the TypeScript MCP
SDK and the 2026-07-28 protocol found four more, and writing the Python SDK
one, listed after them:

- **Names were not all cut to the API's limits.** A tool name, an exception's
  class name, a client's name or a parameter name over 200 characters had the
  whole batch refused, losing every other event in it. All are now cut.
- **`Retry-After` was ignored.** The SDK retried on its own backoff alone, so a
  rate-limited server was asked again before it was ready. It now waits at
  least as long as asked.
- **Refused calls went unseen on v2 of the MCP SDK.** v2 installs its
  `tools/call` handler when the server is built, before the SDK is told about
  it, and answers a missing tool with a protocol error. The SDK now wraps a
  handler already installed and records refusals delivered either way.
- **Every request announced itself again.** With a server built per request,
  configuring per request started the SDK over each time. Identical settings
  are now a no-op (2).
- **Stateless HTTP invented sessions.** Each per-request server became a
  session of one call. Such calls now carry none (8).
- **The client was one per process.** The handshake of the last server
  instrumented named every call, so an HTTP server holding one server
  instance per client credited the newest client with everyone's calls, and
  on 2026-07-28, which has no handshake, no call had a client. The client is
  now read per call (7).
- **Tools registered before `instrument` went unmeasured.** Only
  registration was wrapped, so a server whose tools were declared before the
  line that instruments it reported nothing for them. Tools already
  registered are now wrapped where they are, through the MCP SDK's public
  `update({ callback })`. Found while bringing the Python SDK level with this
  one, where decorators before that line are the usual shape.

One known divergence, kept on purpose:

- **The announcement (3.4) can hold a short-lived process open.** A request in
  flight keeps Node's event loop running until it answers or times out, up to
  10 seconds against an address that never answers, and Node offers no way to
  unreference a `fetch`. It only matters to a script that configures the SDK
  and ends within those seconds; an MCP server lives far longer. Refusing the
  announcement would cost the dashboard its only way to tell an unused server
  from a misconfigured one, which is worth more.

Known limits, not divergences:

- Refused calls (3.2) are seen through the MCP SDK's request handler, so a tool
  renamed after registration has its refused calls left out, and an output
  schema failure after a handler succeeded is recorded as a success.
- A handler registered through an API the SDK does not wrap (for the
  TypeScript MCP SDK, `registerToolTask`) is not measured.
- On a stateless 2025-11-25 HTTP endpoint the client is unknown (7): nothing
  in such a request names it.
- Resources and prompts (3.5) are measured at the MCP SDK's request
  handlers, and named from the registries both major versions keep in the
  same private fields. If a version moves them, every read is named by its
  scheme and counted as unknown: wrong in a way the dashboard shows at once,
  never a leaked address.
- Refused arguments are told from other errors a handler never saw by the
  MCP SDK's wording: `Input validation error` from the schema, and, from
  1.32.0 and 2.3.0, `Invalid arguments for tool` from the `maxToolInputElements`
  limit, which refuses a call before the schema runs. A limit refusal names no
  argument (3.10): the check finds nothing wrong with any one of them.

## 11. Where the Python SDK stands

`packages/mcpspan-python` passes the conformance suite on v1 and v2 of the
official MCP SDK and on FastMCP, on every protocol revision each speaks. How
it meets the parts of this contract a language decides:

- **Delivery** runs on a daemon thread of its own, so it works the same under
  a synchronous server, asyncio or trio, and never keeps a process alive. The
  final delivery (6.6) runs from `atexit`. A forked child, as under gunicorn,
  starts delivery over on its first event and leaves the parent's queue to
  the parent.
- **The official MCP SDK** is instrumented through its tool manager, the one
  object every `tools/call` passes through in both major versions. It is
  private to the MCP SDK; if a version moves it, `instrument` finds nothing
  and leaves the server as it was.
- **FastMCP** is instrumented through its public middleware. A tool failure
  arrives there as a `ToolError` caused by what the tool raised, and the
  cause is what is recorded.
- **Parameter types** are named in JSON's vocabulary, from the arguments as
  the client sent them, so a Python and a TypeScript server describe the same
  call the same way.
- **Resources and prompts** (3.5) are measured through the resource and
  prompt managers, private as the tool manager is, on both major versions;
  FastMCP's through its middleware. A missing prompt argument is refused by
  the prompt's render, before its function runs, and recorded as such.

Known limits:

- A call the client cancels while it runs is not recorded: cancellation in
  Python is a `BaseException`, and the SDK records only what a tool returns
  or an ordinary exception it raises.
- On FastMCP, a tool that itself raises FastMCP's `ValidationError` is
  recorded as refused arguments (3.2), since that type is how FastMCP marks a
  refusal.
- On a stateless 2025-11-25 HTTP endpoint the client is unknown (7), as in
  every SDK.

## 12. Where the Go SDK stands

`packages/mcpspan-go` passes the conformance suite on the official Go SDK
(`github.com/modelcontextprotocol/go-sdk`) and on mcp-go
(`github.com/mark3labs/mcp-go`), on both protocol revisions. It is three
modules: a core with no dependencies, and one per MCP SDK, so a server pulls
in only the SDK it uses.

- **Delivery** runs on a goroutine, which never keeps a Go program running.
  Go has no hook for a program's end, so the final delivery (6.6) is
  `Shutdown`, which the documentation has `main` defer.
- **The official Go SDK** is instrumented through its receiving middleware,
  which every request passes through. `CallToolResult.GetError` gives back
  the error a handler returned, so its type and message are recorded as
  they were. A missing tool is a protocol error with the invalid-params
  code. Refused arguments are recognised as section 3.2 describes.
- **mcp-go** is instrumented through its tool middleware, which sees only
  calls that reach a handler, and its hooks, which see every call: one the
  hooks saw that never reached the middleware was refused. A missing tool is
  `server.ErrToolNotFound`. mcp-go answers a Go error from a handler with a
  protocol error, not an error result; that is recorded as an exception all
  the same.
- **Tools left out** (3.3) are named by their definition, `Exclude(tool)`,
  since a Go function cannot be marked. The name is written once, in the
  tool, and the exclusion applies to that name on every server in the
  process.
- **Error types** are the Go type's own name without package or pointer,
  taken from the first error in the chain that has one; errors from
  `errors.New` and `fmt.Errorf` are `error`.
- **Resources and prompts** (3.5). The official Go SDK keeps its resources,
  templates and prompts private, so the middleware asks the server for its
  lists, through the same handler chain, and names the call from them (at
  most 20 pages, so a vast catalogue costs a bounded lookup). It does not
  check a prompt's required arguments, so there is no refusal to record
  there: the handler decides. mcp-go lists its resources and prompts
  publicly but not its templates, which are read, under the server's own
  lock and never written, from where it keeps them; if a version moves them,
  a templated read is named by its scheme, and a test fails first.

Known limits:

- mcpspan never recovers a panic from a handler; it goes on exactly as it
  would without mcpspan. It is recorded only where the MCP SDK itself turns
  it into an error.
- On mcp-go, arguments are refused only when the server enables
  `WithInputSchemaValidation`; without it there is no refusal to record.
- On the official Go SDK, a handler whose own error begins with
  `validating "arguments"` is counted as refused arguments unless it is
  wrapped in `Track`.

## 13. The public API, in every language

A developer who has used mcpspan in one language should find it in another
without reading the manual. Every SDK offers the same operations, with the
same meaning, named as that language names things.

### 13.1 Operations

| Operation | Meaning |
|---|---|
| instrument | Given an MCP server, measures every tool on it, registered before or after (3.1). Takes the settings of configure, optionally. Returns the server, or plugs into how the MCP SDK builds one. Never fails. |
| configure | Applies settings (2). The same settings again change nothing. |
| shutdown | Stops collecting and delivers what is queued (6.6). |
| track | Measures one tool handler, for a server instrument does not cover. On an instrumented server it counts nothing twice. |
| exclude | Leaves one tool out, refused calls included (3.3), without repeating its name where the language allows it. |

| | TypeScript | Python | Go | C# | Java | Rust | Ruby | PHP |
|---|---|---|---|---|---|---|---|---|
| instrument | `instrument(server, config?)` | `mcpspan.instrument(server, **settings)` | `mcpsdk.Instrument(server, cfg...)`, `mcpgo.Instrument(s, cfg...)` | `.WithMcpSpan(options?)` on the server builder, `McpSpanSdk.Instrument(serverOptions)` | `McpSpanJavaSdk.instrument(transport, options?)`, `McpSpanJavaSdk.instrument(server, options?)` | `mcpspan::instrument(server)` | `McpSpan.instrument(server, **settings)` | nothing on Laravel MCP; `McpSdk::instrument($builder, $settings?)` |
| configure | `configure(config)` | `mcpspan.configure(**settings)` | `mcpspan.Configure(cfg)` | `McpSpanSdk.Configure(options)` | `McpSpan.configure(options)` | `let _mcpspan = mcpspan::configure(options)` | `McpSpan.configure(**settings)` | `McpSpan::configure($settings)` |
| shutdown | `await shutdown()` | `mcpspan.shutdown()` | `defer mcpspan.Shutdown(ctx)` | `await McpSpanSdk.ShutdownAsync()` | `McpSpan.shutdown()` | the guard `configure` returns, dropped; `mcpspan::shutdown()` | `McpSpan.shutdown` | `McpSpan::shutdown()` |
| track | `track(name, handler)` | `@mcpspan.track(name)` | `mcpsdk.Track(h)`, `mcpsdk.TrackFor(h)`, `mcpgo.Track(h)` | `McpSpanSdk.Track(handler)` | `McpSpanJavaSdk.track(tool)` | `mcpspan::track(route)` | `McpSpan.track(ToolClass)` | `McpSpan::track($name, $handler)` |
| exclude | `exclude(handler)` | `@mcpspan.exclude` | `mcpsdk.Exclude(tool)`, `mcpgo.Exclude(tool)` | `[McpSpanExclude]` on the tool | `McpSpanJavaSdk.exclude(tool)` | `.exclude(Server::tool_tool_attr())` on the instrumented server | `McpSpan.exclude(ToolClass)`, `McpSpan.exclude("name")` for `define_tool` | `#[Exclude]` on the tool, `McpSpan::exclude($name)` |

### 13.2 Settings

The same settings, the same defaults and the same environment variables
everywhere, named in the language's own case:

| Setting | Default |
|---|---|
| api key | `MCPSPAN_API_KEY` |
| endpoint | `MCPSPAN_ENDPOINT`; none, and nothing is collected without it |
| server version | `MCPSPAN_SERVER_VERSION`, then the version the server gives itself |
| capture parameter names | off |
| capture error messages | on |
| debug | off |
| on diagnostic | none; implies debug |
| flush on exit | on, where the language can run code as a process ends; absent where it cannot (Go, Rust) |
| flush interval | 5 seconds, in the language's own unit of time |
| max batch size | 100 |
| max queue size | 10,000 |

Where a setting's default is on and the language gives an unset field its
zero value, as Go does a `bool`, the setting is named the other way round,
so that leaving it unset keeps the default: `OmitErrorMessages`.

### 13.3 Shape

- **Packages.** The package is called `mcpspan` wherever the registry allows
  it, in the registry's own case (`McpSpan` on NuGet). Where the language
  makes a type of the same name awkward to reach, the entry point is named as
  that language's other SDKs name theirs (`McpSpanSdk`, as `SentrySdk`). Where a language has more than one MCP SDK in wide use, the SDK is a
  core with no dependencies and one package per MCP SDK, so a server pulls in
  only the MCP SDK it already has. Where the language loads code only as it
  is used, as PHP does, one package with an integration per MCP SDK and no
  dependencies of its own does the same (18).
- **Version.** Every SDK reports its own version in its events and in its
  User-Agent, `mcpspan/<version> (<language>)`.
- **Documentation.** Every SDK's README has the same sections, in the same
  order: Install, Use, Sessions and clients, Without a key, One tool at a
  time, Leaving a tool out, Resources and prompts, Versions, Shutting down (or why a
  deferred shutdown is needed), Two kinds of failure, Privacy, Self-hosting, It will not break
  your server, Options, Developing. Its code samples are checked against the
  package by a test.
- **Checks.** Every SDK has unit tests, tests against each MCP SDK it
  instruments through a real client, a conformance adapter per MCP SDK, and
  CI running all of them on the oldest and newest runtime it supports.

## 14. Where the .NET SDK stands

`packages/mcpspan-dotnet` (NuGet `McpSpan`) passes the conformance suite on
the official MCP C# SDK, `ModelContextProtocol`, on both protocol revisions.

- **Instrumentation** is a call-tool filter, the MCP SDK's public extension
  point, added by `.WithMcpSpan()` on the server builder or
  `McpSpanSdk.Instrument` on the options. It runs inside the MCP SDK's own
  error handling, so a tool's exception reaches it as thrown, before it is
  turned into an error result.
- **Refused arguments** (3.2): the MCP SDK does not validate arguments
  against the schema; it binds them to the tool's parameters and throws a
  `JsonException` or `ArgumentException` when it cannot. Whether a call
  reached the tool is observed directly, from the exception's stack trace:
  one thrown while binding never passed through the tool's own assembly, one
  the tool threw did. A tool whose method cannot be found is taken to have
  run.
- **A missing tool** is an `McpProtocolException` with the invalid-params
  code, and no tool matched.
- **Tools left out** (3.3) carry `[McpSpanExclude]`, read from the metadata
  the MCP SDK keeps for each tool.
- **Delivery** runs on the thread pool, which keeps no process alive; the
  final delivery (6.6) runs on `ProcessExit`.
- The MCP SDK refuses tool names over 128 characters, so the conformance
  adapter's long-named tool is built as a custom `McpServerTool`.
- **Resources and prompts** (3.5) are read-resource and get-prompt filters,
  public like the tool filter. The MCP SDK matches the request before its
  filters run and hands them the match (`MatchedPrimitive`), which names the
  call without reading the address the client sent.

Known limits:

- A cancelled call is not recorded, as in the Python SDK.
- A tool whose code the JIT inlined entirely into the MCP SDK's own invoker
  would leave no frame of its assembly, and a `JsonException` or
  `ArgumentException` it threw would then be counted as refused arguments.

## 15. Where the JVM SDK stands

`packages/mcpspan-jvm` is a core with no dependencies (`com.mcpspan:mcpspan`)
and `com.mcpspan:mcpspan-java-sdk` for the official MCP Java SDK, usable from
Java and Kotlin alike. It passes the conformance suite on 2025-11-25, the only
revision the MCP Java SDK speaks so far.

- **No hook in the MCP SDK.** The MCP Java SDK has no middleware, filter or
  hook for tool calls. The SDK wraps each tool's handler where the server keeps
  it, in place and without telling any client, and replaces the `tools/call`
  request handler the server gives its sessions, to see calls refused before a
  tool runs. Both are private to the MCP SDK; if a version moves them,
  instrumenting finds nothing and changes nothing.
- **Instrumenting the transport.** A stdio transport starts reading as the
  server is built, so instrumenting the server afterwards leaves a window in
  which a fast client's first calls pass unmeasured. The transport is
  instrumented instead (`McpServer.sync(McpSpanJavaSdk.instrument(transport))`),
  each session as it is created, before it reads its first message. A server on
  a transport that creates sessions only as clients arrive, such as streamable
  HTTP, may be instrumented once built.
- **Refusals** (3.2) are observed directly: a call whose tool never ran and
  that came back as an error result was refused by input validation, the only
  answer the MCP SDK gives before a tool runs; an invalid-params error for a
  tool the server does not have is a missing tool.
- **Delivery** runs on a daemon thread; the final delivery (6.6) runs from a
  JVM shutdown hook, which runs on an orderly exit and on SIGTERM alike, and
  changes nothing about when the JVM exits beyond the few seconds it takes.
- **Resources and prompts** (3.5) are watched from the same session request
  handlers, and named from the server's own records, kept privately beside
  its tools. Templates are matched with the MCP SDK's own template manager.
  The MCP SDK does not check a prompt's required arguments, so there is no
  refusal to record there.

Known limits:

- The 2026-07-28 protocol waits on the MCP Java SDK.
- A stateless server (`McpStatelessSyncServer`) is not instrumented.
- The MCP Java SDK 2.0.1's stdio server can stop answering altogether under
  heavy CPU load, with no mcpspan in the process (reproduced with its own
  transport alone, in a few of every ten loaded runs). CI runs the conformance
  suite for it with retries (`CONFORMANCE_RETRY`), and the unit tests that drive
  a real server once more on failure, so the SDK's stall does not read as a
  failure of this contract. Those tests talk to the server over operating
  system pipes: `java.io.PipedInputStream` gives up once the thread that last
  wrote to it has ended, and the server writes from pooled threads, which
  looked like the same stall and was not.

## 16. Where the Rust SDK stands

`packages/mcpspan-rust` (crate `mcpspan`) passes the conformance suite on
rmcp, the official Rust MCP SDK, on both protocol revisions.

- **Instrumentation** wraps the server: `mcpspan::instrument(server)` is a
  `ServerHandler` that hands every method to the one it wraps and measures
  `call_tool`. rmcp's streamable HTTP server takes a `ServerHandler`, not any
  `Service`, so the wrapper is one too. A method rmcp adds to the trait comes
  with a default, and a wrapper that left it out would compile and silently
  stop the server's own from running; a test reads the trait from the rmcp in
  use and fails if the wrapper misses one, and CI runs it against the newest
  rmcp as well as the locked one.
- **Settings are a builder** (`Options::default().api_key(...)`), so a setting
  added later breaks nobody's code.
- **Exceptions.** A Rust tool fails exceptionally with an `Err(ErrorData)`,
  which rmcp sends as a protocol error. It has a code and no type of its own,
  so `errorType` is the code's name (`InternalError`, `InvalidParams`), or
  `ErrorData(<code>)` for a code of the server's own. A tool that panics is
  recorded with `errorType` `panic` and its message, and the panic is then
  resumed unchanged. The conformance adapter's `throws` returns
  `ErrorData::internal_error`, and the suite takes the type it expects from
  `CONFORMANCE_EXCEPTION_TYPE`.
- **Refusals** (3.2) are recognised by rmcp's own wording, as set out there.
- **Tools left out** (3.3) are named by the `Tool` that `#[tool]` generates
  (`Server::health_check_tool_attr()`), or by name.
- **Delivery** runs on a thread of its own, with a blocking HTTP client, so it
  works under any async runtime and never blocks one. Rust runs nothing when
  a process ends, so the final delivery (6.6) is the guard `configure`
  returns, dropped at the end of `main`, or `mcpspan::shutdown()`. An
  instrumented stdio server also delivers what is queued when its client
  leaves, since the process ends with it.
- **Resources and prompts** (3.5). rmcp keeps no registry: a server answers
  reads and gets in its own `ServerHandler`. Before one runs, the wrapper asks
  the server for its lists, through the methods it answers a client's listing
  with (at most 20 pages), and names the call from them. A prompt whose
  arguments rmcp's prompt router could not take is recognised by its wording,
  as tools' refusals are.

Known limits:

- A call answered with a task (`CreateTaskResult`, the tasks extension) is not
  recorded: its outcome arrives later, through `tasks/get`.
- rmcp's `local` feature, which drops the `Send` bounds, is not supported.

## 17. Where the Ruby SDK stands

`packages/mcpspan-ruby` (gem `mcpspan`, module `McpSpan`) passes the
conformance suite on the official Ruby MCP SDK, the `mcp` gem, on both
protocol revisions. It has no dependencies: delivery uses `Net::HTTP`.

- **No hook in the MCP SDK for the call itself.** The gem's one
  `around_request` slot belongs to the developer and sees neither arguments
  nor result. Instrumenting prepends a module to the one server's singleton
  class, taking the place of two private methods: `call_tool`, which sees the
  whole call, and `call_tool_with_args`, which the gem calls only once the
  arguments have passed its checks. If a version of the gem renames either,
  instrumenting leaves the server as it was, and a test fails; CI keeps no
  lockfile, so it runs against the newest gem.
- **Refusals** (3.2) are observed directly: an error result from a call that
  never reached `call_tool_with_args` was refused (missing or invalid
  arguments), and a call to a name the server has no tool for, looked up
  before the call, is a missing tool.
- **Exceptions.** The gem hands the client a generic internal error and keeps
  what the tool raised; its class is recorded.
- **Nothing it touches may fail a call.** The gem autoloads its HTTP
  transport, which needs the rack gem a stdio server need not have, so
  classes the SDK only compares against are named, never referenced, and the
  hooks rescue `ScriptError` as well as `StandardError`. The conformance suite
  found this: the first adapter, with no rack installed, crashed on its first
  call.
- **Delivery** runs on a thread of its own; the final delivery (6.6) runs from
  `at_exit`. A forked worker (Puma, Unicorn) inherits the queue but not the
  thread, so the SDK notices the new process at its first call and starts
  delivering there.
- The gem refuses tool names over 128 characters where they are set, so the
  conformance adapter's long-named tool overrides `name_value`.
- **Resources and prompts** (3.5) are hooked the same way, on three more
  private methods: `read_resource_contents`, which runs the server's read
  handler (the gem's own, or one set with `resources_read_handler`),
  `get_prompt`, and `call_prompt_template_with_args`, reached only once the
  gem's check for missing arguments has passed. A read is named from the
  server's own records, so one answered by a developer's handler is named as
  well as one the gem answers. A gem without these methods leaves resources
  and prompts unrecorded and tools measured.

Known limits:

- A cancelled call is not recorded, as in the Python and .NET SDKs.
- A tool that asks the client for input on a 2025-11-25 connection runs again
  once the answer comes back, through the gem's own shim; the call is recorded
  once, timed from that final run.
- `track` cannot see a connection or a client, and records neither.

## 18. Where the PHP SDK stands

`packages/mcpspan-php` (Composer `mcpspan/mcpspan`, namespace `McpSpan`)
passes the conformance suite on Laravel MCP, on both protocol revisions, and
on the official PHP MCP SDK, `mcp/sdk`, on 2025-11-25: that SDK speaks
2026-07-28 over HTTP only, where a test covers it.

- **One package.** PHP loads a class only when it is used, so both
  integrations live in the one package, with the MCP SDKs as suggestions, not
  dependencies: a server pulls in nothing it does not already have, which is
  what 13.3 asks of separate packages. Packagist also takes one package per
  repository, and one package is one split to publish.
- **Delivery without threads.** A long-running server (stdio, Octane,
  RoadRunner) starts a small PHP process of its own with `proc_open` and hands
  it one event per line through a pipe it never blocks on; the worker batches,
  retries and announces as every SDK does, and takes its settings, the key
  among them, through that pipe, never its command line. It has no standard
  output of the server's, so it cannot corrupt the protocol. At the end, the
  server asks it for a final delivery and waits a few seconds for it (6.6).
  PHP that serves one request per process (PHP-FPM) delivers at the end of the
  request instead, from a shutdown function, which Laravel and Symfony run
  after the response has gone. There is no start there to announce, so no
  announcement is sent (3.4 cannot apply). Where a worker cannot be started,
  a long-running server delivers from its own process, on a tool call's time.
- **Laravel MCP** needs no code: the package's service provider instruments
  every MCP server the container resolves, through the server's own
  `addMethod()`, and configures from `config/mcpspan.php` at the first server,
  not at boot, so an artisan command that serves no MCP starts nothing. Laravel
  checks arguments inside the tool, with `$request->validate()`, so refused
  arguments (3.2) are a `ValidationException`, a type Laravel documents for
  exactly that. Laravel's HTTP transport keeps no sessions and no handshake,
  so calls there have no session and, on 2025-11-25, no client.
- **The official PHP MCP SDK** is instrumented on its builder, through its own
  extension points: a `tools/call` handler the SDK consults before its own on
  both revisions, which hands every call to the SDK's handler, and a reference
  handler around the SDK's, which sees whether a call reached its tool and
  what the tool threw (the SDK answers a thrown exception with an error that
  names no class). Refusals are observed directly: no tool by that name in the
  registry is a missing tool, an error before the tool was reached is refused
  arguments. The one private part read is the builder's assembled parts, to
  find the SDK's handler and registry; a test fails if it moves.
- **Resources and prompts** (3.5) take the same routes: `resources/read` and
  `prompts/get` handlers on the official SDK, named from its registry, and
  swapped methods on Laravel MCP, named by Laravel's own lookup. The official
  SDK refuses a prompt without an argument it requires inside its reference
  handler, before the prompt runs, so that refusal is told from the
  arguments the prompt's registration requires. Laravel leaves a prompt to
  check its own arguments, as a tool does: a `ValidationException` from a
  prompt is refused arguments.

Known limits:

- A tool that suspends on the official SDK (asking the client for input) is
  timed across the wait.
- `track` cannot see a connection or a client, and records neither.
- The worker needs `proc_open` and the command-line PHP binary; hosts that
  disable it fall back to delivering from the server's process.
