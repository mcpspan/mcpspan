# mcpspan-proxy

[mcpspan](https://mcpspan.com) analytics for an MCP server without changing
its code. The proxy runs in front of the server, passes everything between it
and the client through unchanged, and reports the calls it sees: which tools
are called, by which client, how fast, and how they fail.

For a server you cannot or would rather not change: one in a language without
an mcpspan SDK, one you did not write, or one you want to try mcpspan on
first. Where you can add an SDK, it sees a little more (see
[What it sees](#what-it-sees)).

## A server over stdio

In your client's MCP settings, put the proxy in front of the server's own
command, after `--`:

```sh
npx mcpspan-proxy -- node dist/server.js
npx mcpspan-proxy -- uv run server.py
npx mcpspan-proxy -- ./target/release/my-server --stdio
```

with your API key and the address of your mcpspan in the environment. In
Claude Code, for example:

```json
{
  "mcpServers": {
    "flights": {
      "command": "npx",
      "args": ["-y", "mcpspan-proxy", "--", "node", "/path/to/dist/server.js"],
      "env": {
        "MCPSPAN_API_KEY": "your-key",
        "MCPSPAN_ENDPOINT": "https://api.mcpspan.com"
      }
    }
  }
}
```

`MCPSPAN_ENDPOINT` is `https://api.mcpspan.com` on mcpspan Cloud, or your own
installation's address when you run it yourself. The server gets the rest of
the environment as before. Needs Node 20 or newer.

## A server over HTTP

Run the proxy with the server's address, and point clients at the proxy
instead:

```sh
npx mcpspan-proxy http://localhost:3000/mcp
```

It listens on port 6273 (`--port` to change it), and passes every request to
the same path on the server. In Docker:

```sh
docker run -p 6273:6273 -e MCPSPAN_API_KEY -e MCPSPAN_ENDPOINT \
  ghcr.io/mcpspan/proxy http://flights:3000/mcp
```

Answers stream through as the server sends them, and each client session the
server opens is a session in mcpspan. Headers go through too, the
`Authorization` a client sends among them; the server sees its own address as
the `Host`, and where the request came from in `X-Forwarded-For`.

## Settings

The API key, endpoint and version come from the environment, as for the SDKs:

| Variable | |
|---|---|
| `MCPSPAN_API_KEY` | The server's key, from Settings in mcpspan. Without it the proxy passes everything through and reports nothing. |
| `MCPSPAN_ENDPOINT` | Your mcpspan: `https://api.mcpspan.com` on Cloud, your installation's address when you run it yourself. |
| `MCPSPAN_SERVER_VERSION` | The version to record calls under, when the one the server gives itself is not the one you want. |

| Option | |
|---|---|
| `--exclude <tool>` | Leave a tool out of the numbers, such as a health check. Repeat for more. |
| `--parameter-names` | Record the names and types of the arguments a tool is called with, never their values. |
| `--no-error-messages` | Leave out the text of failures, for tools that can fail with something you would not send anywhere. |
| `--flush-interval <seconds>` | How long a batch of calls waits before it is sent. 5 when left out. |
| `--port <port>` | Over HTTP: where to listen. 6273 when left out. |
| `--host <address>` | Over HTTP: the address to listen on. `127.0.0.1` when left out, `0.0.0.0` in the Docker image. |
| `--debug` | Write delivery problems to stderr. |

The server does not get `MCPSPAN_API_KEY`: if it has an mcpspan SDK of its
own, that SDK stays quiet rather than count every call a second time.

## What it sees

The proxy sees what the server and the client say to each other, and records
from it what an SDK does: tool calls, resources and prompts, the client, the
server's version, sessions, response sizes, the tools the server lists and
how large their definitions are, repeated calls, and which arguments a refused
call got wrong. Values never leave it, as with the SDKs.

An SDK inside the server sees two things the proxy cannot:

- **Exceptions.** A tool that throws reaches the client as an error the MCP
  SDK makes of it, so the proxy records it as an error the tool returned, with
  its message and without the exception's type.
- **What the server has, before the client asks.** The proxy learns the
  server's tools, resources and prompts from the lists the client asks for, as
  clients do before using them. A resource read before its list is named by
  its scheme alone (`db://`), since the address itself can hold a user's
  data.

Both are checked: the SDKs' own conformance suite runs through the proxy on
every change.

## Licence

MIT
