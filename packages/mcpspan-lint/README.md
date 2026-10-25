# mcpspan-lint

Check an MCP server's tool definitions before agents see them. It lists what
makes a client refuse a tool and what makes an agent pick the wrong one or
guess its arguments, and how many tokens the definitions take in every
session. No account and nothing to install.

```sh
npx mcpspan-lint -- node dist/server.js
```

```
flights 1.2.0: 4 tools, about 239 tokens of definitions in every session

search_flights
  error    required-unknown              "date" is required but not among the arguments, so no call can satisfy it.
  warning  argument-description-missing  to: No description: the agent guesses what this argument means from its name.

book flight
  error    name-invalid                  The name must be 1 to 128 letters, digits, underscores, hyphens or dots, with no spaces.

getBooking
  warning  description-short             The description says little more than the name. Say what the tool does, what it returns, and when to use it.
  warning  names-alike                   Named alike: getBooking, get_booking. An agent can easily call one for the other.

2 errors, 3 warnings
```

## Point it at your server

A server on stdio: its command after `--`, as you would run it. It gets your
environment, so keys and settings it needs to start are there.

```sh
npx mcpspan-lint -- node dist/server.js
npx mcpspan-lint -- uv run server.py
npx mcpspan-lint -- ./target/release/my-server --stdio
```

A server already running over HTTP, with any header it needs:

```sh
npx mcpspan-lint https://example.com/mcp
npx mcpspan-lint --header "Authorization: Bearer $TOKEN" https://example.com/mcp
```

A `tools/list` answer saved to a file, as a whole JSON-RPC answer, its result,
or just the array of tools:

```sh
npx mcpspan-lint --file tools.json
```

Needs Node 20 or newer. Only the tool list is read: no tool is called.

## In CI

It exits 1 when the definitions have errors, 0 when they have only warnings
or nothing, and 2 when it could not check the server at all. `--strict` fails
on warnings too.

```yaml
- run: npx mcpspan-lint -- node dist/server.js
```

`--json` prints the report as JSON instead, for other tools to read.

## Options

| Option | |
|---|---|
| `--header "Name: value"` | Send this header to an HTTP server. Repeat for more. |
| `--file <path>` | Check a saved `tools/list` answer instead of a server. |
| `--json` | Print the report as JSON. |
| `--strict` | Fail on warnings too, not only on errors. |
| `--timeout <seconds>` | How long to wait for the server. 30 when left out. |

## What it checks

Errors break something: a client refuses the listing or the tool, or no call
can match its schema.

| Rule | |
|---|---|
| `name-missing` | A tool without a name. |
| `name-invalid` | A name outside the specification: 1 to 128 letters, digits, `_`, `-` or `.`. |
| `name-duplicate` | Two tools with one name. |
| `schema-missing` | No input schema. A tool with no arguments still needs `{"type": "object"}`. |
| `schema-not-object` | An input schema that is not `"type": "object"`. |
| `schema-invalid` | Properties, `required`, a type or an argument's schema that is not valid JSON Schema. |
| `required-unknown` | A required argument that is not among the arguments. |

Warnings make the agent choose worse or guess.

| Rule | |
|---|---|
| `name-not-portable` | Dots in a name, or more than 64 characters: some clients refuse them. |
| `names-alike` | Names that differ only in case or separators, such as `getUser` and `get_user`. |
| `description-missing` | No description. |
| `description-short` | A description of a word or two, or one that repeats the name. |
| `description-long` | A description over 1,200 characters. |
| `description-duplicate` | Two tools with the same description. |
| `argument-description-missing` | An argument without a description. |
| `argument-type-missing` | An argument without a type, enum, const or reference. |
| `argument-open-object` | An object argument with no properties, which could hold anything. |
| `too-many-tools` | More than 40 tools. |
| `listing-large` | Definitions over 10,000 tokens together. |

Arguments inside objects and lists are checked too, named by their path, such
as `passenger.name` or `legs[].date`.

Tokens are estimated at four bytes a token of each tool's name, title,
description and input schema, as [mcpspan](https://mcpspan.com) counts them.
mcpspan also shows, once your server is live, which tools agents were shown
and never called.

## Licence

MIT
