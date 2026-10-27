# mcpspan-mcp

Ask your AI agent about your MCP servers. Claude Code, Cursor or any other MCP
client answers from your mcpspan numbers:

- *Which tools failed most this week, and why?*
- *How does 1.4.1 compare with 1.4.0?*
- *What do agents ask for that my server does not have?*
- *Does Cursor fail more often than Claude?*
- *Which tools are agents shown but never call?*

It sees what you see in the dashboard and changes nothing. It sends nothing
anywhere but your mcpspan.

There are two ways to add it: by address, which needs nothing installed, or
as a command your agent starts.

## Try it on the demo

No account needed: the [live demo](https://demo.mcpspan.com) answers any
token. In Claude Code:

```sh
claude mcp add --transport http mcpspan-demo https://demo-api.mcpspan.com/mcp \
  --header "Authorization: Bearer demo"
```

Then ask about the demo's server, Flights: *what went wrong in the last day?*

## By address

The MCP server runs inside mcpspan itself, at `/mcp` on its API. Add that
address to your agent, and the first time it connects it opens mcpspan in your
browser: sign in, check which app is asking, and allow it. Nothing to copy.

### mcpspan Cloud

The address is `https://api.mcpspan.com/mcp`.

| Agent | How |
|---|---|
| claude.ai, Claude Desktop, the Claude apps | Settings → Connectors → Browse connectors, find mcpspan, and Connect. Or Add custom connector, with the address. |
| ChatGPT | In its connector settings (developer mode), a new connector with the address, signing in with OAuth. |
| Claude Code | `claude mcp add --transport http mcpspan https://api.mcpspan.com/mcp`, then `/mcp` in Claude Code to sign in. |
| Cursor | In `mcp.json`: `{"mcpServers": {"mcpspan": {"url": "https://api.mcpspan.com/mcp"}}}` |
| VS Code | In `.vscode/mcp.json`: `{"servers": {"mcpspan": {"type": "http", "url": "https://api.mcpspan.com/mcp"}}}` |
| Others | Whatever they call a remote, HTTP or Streamable HTTP server, with the address. |

The apps you allowed are listed in **Settings → Connected apps**, where one
click disconnects an app and ends its access at once.

An agent that cannot sign in with OAuth can send a read token instead (see
[Get a token](#get-a-token)), as a header:

```sh
claude mcp add --transport http mcpspan https://api.mcpspan.com/mcp \
  --header "Authorization: Bearer mcpspan_read_..."
```

### Self-hosted

The address is your API's, the one your MCP servers report to, with `/mcp`:
`http://localhost:6271/mcp` on the machine itself. Agents on that machine, such
as Claude Code or Cursor, connect as above.

An app that connects from elsewhere, such as claude.ai or ChatGPT, needs that
address on HTTPS and reachable from the internet, and the API told where people
open your dashboard, since that is where it sends them to allow it: set
`MCPSPAN_DASHBOARD_URL` in `.env`, for instance `https://mcpspan.example.com`.

Needs mcpspan 0.13.0 or newer.

## As a command

The same tools, started by your agent with `npx`, reading with a read token.
For agents that only start commands, or to keep it on your machine.

### Get a token

In mcpspan, open **Settings → Read tokens** and make one. It is shown once,
already filled into the lines below, ready to copy.

### mcpspan Cloud

Claude Code:

```sh
claude mcp add mcpspan -e MCPSPAN_READ_TOKEN=mcpspan_read_... -- npx -y mcpspan-mcp
```

Cursor, Claude Desktop, Windsurf and others, in their MCP settings:

```json
{
  "mcpServers": {
    "mcpspan": {
      "command": "npx",
      "args": ["-y", "mcpspan-mcp"],
      "env": { "MCPSPAN_READ_TOKEN": "mcpspan_read_..." }
    }
  }
}
```

### Self-hosted

The same, with the address your MCP servers report to:

```sh
claude mcp add mcpspan \
  -e MCPSPAN_READ_TOKEN=mcpspan_read_... \
  -e MCPSPAN_URL=http://localhost:6271 \
  -- npx -y mcpspan-mcp
```

```json
{
  "mcpServers": {
    "mcpspan": {
      "command": "npx",
      "args": ["-y", "mcpspan-mcp"],
      "env": {
        "MCPSPAN_READ_TOKEN": "mcpspan_read_...",
        "MCPSPAN_URL": "http://localhost:6271"
      }
    }
  }
}
```

Needs mcpspan 0.9.0 or newer. If the agent reaches your installation over the
internet, put HTTPS in front of it: the token travels with every question.

### Settings

| Variable | |
|---|---|
| `MCPSPAN_READ_TOKEN` | The read token. Required. |
| `MCPSPAN_URL` | Your installation's API, for self-hosted mcpspan. `https://api.mcpspan.com` when left out. |

Needs Node 20 or newer.

## Tools

Every tool only reads. Each takes the server by name or id (left out when the
account has one) and a window: `days` back from now (7 when left out), or
`from` and `to`.

| Tool | Answers |
|---|---|
| `list_servers` | The servers the account reports on. |
| `get_overview` | Calls, failures, error rate, response times and clients. |
| `list_tools` | Tools ranked by calls, errors, response time or name. |
| `get_tool` | One tool: why it failed, refused arguments, answer sizes, definition changes, repeats, and the call before each failure. |
| `list_errors` | The latest failed calls, with the kind of failure and the message. |
| `list_unknown_tools` | Tools agents asked for that the server lacks, the closest one it has, and what the agent did next. |
| `list_clients` | Each client's calls, error rate and response times. |
| `compare_versions` | The server's releases side by side. |
| `get_tool_listing` | What agents were shown: tools never used, and what their definitions cost. |
| `list_sessions` | Recent sessions, with failures and repeated calls. |
| `get_session` | One session's calls, in order. |

A token can be revoked at any time under **Settings → Read tokens**, and an app
disconnected under **Settings → Connected apps**; either loses access at once.

## Licence

MIT
