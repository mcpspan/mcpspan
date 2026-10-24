# mcpspan-mcp

Ask your AI agent about your MCP servers. Claude Code, Cursor or any other MCP
client answers from your mcpspan numbers:

- *Which tools failed most this week, and why?*
- *How does 1.4.1 compare with 1.4.0?*
- *What do agents ask for that my server does not have?*
- *Does Cursor fail more often than Claude?*
- *Which tools are agents shown but never call?*

It reads with a token that sees what you see in the dashboard and changes
nothing. It sends nothing anywhere but your mcpspan.

## Try it on the demo

No account needed: the [live demo](https://demo.mcpspan.com) answers any
token. In Claude Code:

```sh
claude mcp add mcpspan-demo \
  -e MCPSPAN_READ_TOKEN=demo \
  -e MCPSPAN_URL=https://demo-api.mcpspan.com \
  -- npx -y mcpspan-mcp
```

Then ask about the demo's server, Flights: *what went wrong in the last day?*

## Get a token

In mcpspan, open **Settings → Read tokens** and make one. It is shown once,
already filled into the lines below, ready to copy.

## Add it to your agent

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

## Settings

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

A token can be revoked at any time under **Settings → Read tokens**; the agent
loses access at once.

## Licence

MIT
