<p align="center">
  <img src="docs/logo.svg" width="88" height="88" alt="">
</p>

<h1 align="center">mcpspan</h1>

<p align="center">
  <strong>Open-source, self-hosted analytics for MCP servers.</strong><br>
  See which tools, resources and prompts get used, by which client,<br>
  how fast they answer, and why they fail.
</p>

Add one line to your MCP server, run the dashboard with `docker compose up`,
and nothing ever leaves your machine.

**[See the live demo](https://demo.mcpspan.com)**, with sample data: nothing to
install.

![mcpspan overview: calls over time with release markers, tools by calls and errors, versions compared](https://raw.githubusercontent.com/mcpspan/.github/main/assets/screenshot-overview.png)

## Features

- **Every call, from every client.** Tool calls, resource reads and prompt
  gets, with the client that made them: Claude, Claude Code, Cursor, VS Code,
  Codex, ChatGPT and the rest.
- **Response times that mean something.** Median and 95th percentile per tool,
  and the full distribution, so a cache hit and a slow path do not hide
  inside one average.
- **Answer sizes.** How large each tool's answers are, typical and largest:
  a tool that now and then returns megabytes fills the agent's context while
  looking fine on every latency chart.
- **What agents are shown.** Every session starts by reading the definitions
  of all your tools, called or not. See how many tokens that list costs, and
  which tools agents were shown in hundreds of sessions and never called.
- **Failures, told apart.** A handler that threw, a tool that answered with an
  error, arguments the server refused and which of them were wrong, and tools
  that agents asked for but your server does not have: which clients asked,
  the closest name you do have, and what the agent did next.
- **Sessions.** Each connection's calls, step by step, as the agent made them,
  with the calls an agent repeated with the same arguments marked: a loop
  that looks fine one call at a time. A tool's page says which call came
  right before it repeated or failed, by client.
- **Releases.** Every call carries the version of your server that answered
  it; the charts mark where each release began and compare it with the one
  before. A tool's own chart also marks where its description or input schema
  changed, since rewording a description can change how agents use a tool
  more than a change to its code.
- **Alerts** to Slack, Discord or any webhook, when errors climb or a server
  goes quiet, for a whole server or one tool.
- **Your data, yours to take.** CSV and NDJSON exports of anything you can
  see, and forwarding to OpenTelemetry for Grafana, Datadog, Honeycomb and the
  like.
- **Private by design.** Parameter values never leave your server's process,
  and nothing is sent anywhere you did not set up yourself. Error messages,
  which a tool that runs commands can fill with anything, can be turned off.

<table>
  <tr>
    <td width="50%"><strong>Every call</strong>, of every kind, filtered by outcome<br><img src="https://raw.githubusercontent.com/mcpspan/.github/main/assets/screenshot-calls.png" alt="The list of calls"></td>
    <td width="50%"><strong>Failures, told apart</strong>, with what went wrong<br><img src="https://raw.githubusercontent.com/mcpspan/.github/main/assets/screenshot-errors.png" alt="Failed calls"></td>
  </tr>
  <tr>
    <td><strong>Sessions</strong>, step by step<br><img src="https://raw.githubusercontent.com/mcpspan/.github/main/assets/screenshot-session.png" alt="One session's calls in order"></td>
    <td><strong>One call</strong>, and everything recorded about it<br><img src="https://raw.githubusercontent.com/mcpspan/.github/main/assets/screenshot-call.png" alt="A failed call in detail"></td>
  </tr>
</table>

## Ask your agent

Claude Code, Cursor or any other MCP client can answer from your mcpspan
numbers: *which tools failed most this week, and why?*, *how does 1.4.1
compare with 1.4.0?* Make a read token in Settings and add
[mcpspan-mcp](packages/mcpspan-mcp/README.md) to your agent. It only reads.

## Badges

Show in your server's README how much it is used and how well it answers:

![mcpspan: 12.4k calls/week](https://mcpspan.com/img/badges/calls.svg)
![mcpspan: 99.2% success](https://mcpspan.com/img/badges/success.svg)
![mcpspan: p50 84 ms](https://mcpspan.com/img/badges/latency.svg)

Calls, success rate and median response time over the last week, switched on
per server in Settings. [How they work](docs/badges.md).

## Lint your tool definitions

Before you ship, check what makes a client refuse a tool or an agent pick the
wrong one. No account needed:

```sh
npx mcpspan-lint -- node dist/server.js
```

[What it checks](packages/mcpspan-lint/README.md).

## Quick start

You need Docker.

```sh
git clone https://github.com/mcpspan/mcpspan.git
cd mcpspan
docker compose up -d
```

Open **http://localhost:6270** and create your account. You get an API key
for your first server, and the Settings page shows the line to add to it, in
its language.

## Connect your MCP server

TypeScript, on the official MCP SDK:

```sh
npm install mcpspan
```

```ts
import { instrument } from 'mcpspan';

instrument(server, {
  apiKey: process.env.MCPSPAN_API_KEY,
  endpoint: 'http://localhost:6271', // your mcpspan installation
});
```

Register your tools as you always have: every one is measured, and each
returns and fails exactly as it did before.

Eight languages, the same features in each:

| Language | MCP SDKs | Install | Guide |
|---|---|---|---|
| TypeScript | official SDK, v1 and v2 | `npm install mcpspan` | [packages/mcpspan](packages/mcpspan/README.md) |
| Python | official SDK, FastMCP | `pip install mcpspan` | [packages/mcpspan-python](packages/mcpspan-python/README.md) |
| Go | official Go SDK, mcp-go | `go get github.com/mcpspan/mcpspan/packages/mcpspan-go/mcpsdk` | [packages/mcpspan-go](packages/mcpspan-go/README.md) |
| C# / .NET | official C# SDK | `dotnet add package McpSpan` | [packages/mcpspan-dotnet](packages/mcpspan-dotnet/README.md) |
| Java / Kotlin | official Java SDK | `com.mcpspan:mcpspan-java-sdk` | [packages/mcpspan-jvm](packages/mcpspan-jvm/README.md) |
| Rust | rmcp | `cargo add mcpspan` | [packages/mcpspan-rust](packages/mcpspan-rust/README.md) |
| Ruby | official Ruby SDK | `gem install mcpspan` | [packages/mcpspan-ruby](packages/mcpspan-ruby/README.md) |
| PHP | Laravel MCP, official PHP SDK | `composer require mcpspan/mcpspan` | [packages/mcpspan-php](packages/mcpspan-php/README.md) |

Every SDK behaves the same way, set out in [one contract](docs/sdk-contract.md)
and checked by [one test suite](conformance/README.md) in every language.

### Without changing your code

Any MCP server, in any language, can run behind the proxy instead. In your
client's MCP settings, in front of the server's own command:

```sh
npx mcpspan-proxy -- node dist/server.js
```

Or in front of a server over HTTP, with clients pointed at the proxy:

```sh
docker run -p 6273:6273 -e MCPSPAN_API_KEY -e MCPSPAN_ENDPOINT ghcr.io/mcpspan/proxy http://flights:3000/mcp
```

It sees nearly all an SDK does; [what it does not](packages/mcpspan-proxy/README.md#what-it-sees).

## Running it

Settings are optional: copy `.env.example` to `.env` to change ports, how long
data is kept, or the address your MCP servers reach the API at.
[docs/self-hosting.md](docs/self-hosting.md) covers the rest: the account and
password reset, several servers, settings, exports, OpenTelemetry, and
backups.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT. See [LICENSE](LICENSE).
