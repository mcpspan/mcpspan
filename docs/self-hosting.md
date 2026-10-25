# Running mcpspan

Everything about running your own installation, past the quick start in the
[README](../README.md).

## The account

There is no default login or password. The first visit offers to create the
account, with the email and password you choose. Registration closes once it
exists, so nobody can wander in behind you. A password is checked at most ten
times a minute.

Change the password under Settings. Forgot it? On the machine running
mcpspan:

```sh
docker compose exec api node scripts/reset-password.ts
```

It prints a new password once and signs out every browser.

## More than one server

Add as many as you run. Each gets its own key and its own data, and a switcher
appears in the header once there are two. Settings is where they are named,
given new keys, or removed - removing one deletes everything it recorded, so
the last one cannot be removed at all.

To delete only part of what a server recorded, such as an error message that
carried something it should not have, or a burst of test traffic, use Delete
data in Settings: pick the server and the last hour, day, week or month, two
dates, or everything. It says how many calls that is before anything goes,
and keeps the server and its key.

## Ports

| | | |
|---|---|---|
| Dashboard | 6270 | What you open |
| Core API | 6271 | Where the SDK sends events |
| Database | 6272 | Bound to localhost, for your own tools |

6270 is MCP on a telephone keypad. Deliberately not 3000 or 8080: whoever runs
this is already running an MCP server of their own, and those ports are
usually taken. Change them in `.env` if they collide anyway.

## Settings

Everything is optional and lives in `.env`, which `.env.example` explains
setting by setting. The ones that matter:

| Setting | What it does |
|---|---|
| `API_KEY_SECRET` | Signs API keys. Made by the API on first start when empty; set it only to supply your own, and never change it after issuing keys. |
| `MCPSPAN_INGEST_URL` | The address of the Core API as the outside world reaches it. Leave it unset while everything is on one machine. Set it once the stack is somewhere else, and the setup snippet in the dashboard follows. |
| `MCPSPAN_RETENTION_DAYS` | How long raw events are kept. 90 by default, and not settable below 8. |
| `MCPSPAN_BIND_ADDRESS` | Where the dashboard and the API listen. Every interface by default, so MCP servers elsewhere can reach the API; `127.0.0.1` keeps both to this machine. |
| `MCPSPAN_INGEST_EVENTS_PER_SECOND` | How fast one server may write. 100 by default, which is ten times a busy one. |

Settings are read when a page renders, so changing one is a restart rather
than a rebuild.

### What it keeps, and for how long

Every call is stored twice: once as itself, and once inside an hourly summary
that carries the counts, the durations and a latency histogram. The summary is
what the charts read, which is why a year of traffic still draws in the time it
takes to draw a day.

Raw events are dropped after `MCPSPAN_RETENTION_DAYS`, which starts at 90. The
summary is kept for two years. Nothing has to be pruned by hand, and nothing
grows without a bound.

The one thing to know: a percentile over a window longer than an hour is read
from that histogram rather than sorted out of the raw calls, so it lands inside
the step containing the call at that rank rather than on its exact duration.

## The signing secret

The API signs keys with a secret it makes on first start and keeps on its own
Docker volume, `mcpspan-api-data`. Back that volume up with the database, and
keep the two together: with the database and without it, the keys stored in
the database can no longer be checked. To supply your own secret instead, set
`API_KEY_SECRET` in `.env` before the first start.

## Asking an AI agent

Claude Code, Cursor or any other MCP client can answer questions about your
servers from this installation: which tools failed this week and why, how a
release compares with the one before, what agents ask for that a server does
not have. It does so through [mcpspan-mcp](../packages/mcpspan-mcp/README.md),
an MCP server that reads with a token.

1. In the dashboard, Settings, Read tokens: make one. It is shown once, already
   filled into the command for Claude Code and the settings for other clients.
2. Paste that into your agent. It points the agent at the address your MCP
   servers report to (`MCPSPAN_INGEST_URL`), as `MCPSPAN_URL`.

A token reads what you see in the dashboard and changes nothing: not servers,
keys, alerts or other tokens. Revoke it in the same place and it stops working
at once. If the agent reaches the API over the internet rather than on your
own network, put HTTPS in front of it: the token travels with every question.

## Badges

A server can show its figures in its README: calls in the last week, the share
that succeeded, and the median response time, as badges like the ones for
builds and downloads. In Settings, Badges: switch them on for a server, tick
the ones you want, and paste the line shown into the README.

Badges are off until you switch them on, and say nothing but those figures.
They are served from the address your MCP servers report to
(`MCPSPAN_INGEST_URL`) and GitHub fetches them from there, so they show in a
README only if that address is reachable from the internet. Switching them off,
or giving them a new address, stops the old one at once: it shows "no data".

The figures are what the server's SDK sent, and the badge says so. More, with
examples and the shields.io format, in [Badges](badges.md).

## Getting your data out

Every view that lists something has a download link: the tool table as CSV,
and every call in the current window and filter as CSV or as one JSON object a
line. The same exports are API endpoints, so a script can take them too, with
a read token from Settings:

```sh
curl -H "authorization: Bearer $MCPSPAN_READ_TOKEN" -o calls.ndjson \
  'http://localhost:6271/v1/dashboard/export/calls?format=ndjson&from=2026-09-01T00:00:00Z'
```

`from` and `to` take any instant, and `toolName`, `clientType` and
`errorSource` narrow the export the way they narrow the dashboard. Exports are
streamed, so a large one does not have to fit in memory on either end. Raw
calls go back as far as `MCPSPAN_RETENTION_DAYS`.

The database itself is on port 6272 of the machine running the stack, for
anything the exports do not cover.

### Into OpenTelemetry

If your dashboards already live in Grafana, Datadog, Honeycomb or anything
else that takes OpenTelemetry, the Core API can forward every call there as it
arrives: one span per call and a duration histogram, named as OpenTelemetry's
conventions for MCP servers name them (`mcp.method.name`, `gen_ai.tool.name`,
`mcp.server.operation.duration` and the rest). Set the standard variable in
`.env`:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
```

It speaks OTLP over HTTP, port 4318 on an OpenTelemetry Collector, not gRPC.
`OTEL_EXPORTER_OTLP_HEADERS` carries a vendor's key, and
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and
`OTEL_METRIC_EXPORT_INTERVAL` work as they do everywhere else. Inside the
stack, `localhost` is the API's own container: give the collector's address as
the API sees it.

What goes out is what is stored, and nothing more: no parameter values, and a
resource by the URI or template your server registered, never by the address a
client asked for. Each MCP server is a service of its own, named as in the
dashboard. The spans stand on their own rather than inside your server's
traces; the session id is what ties a session's calls together. The
conventions are still marked experimental upstream, so a name may change with
them.

## Backing it up

```sh
./scripts/backup.sh
```

Writes a compressed dump into `backups/`. The database keeps serving while it
runs, so this is safe from a scheduled job.

API keys are stored as hashes of a signing secret, so a database restored
beside a different secret has a complete set of keys that all refuse to
authenticate. The secret the API made itself is written beside the dump, as
`<dump>.secret`, and put back by the restore; keep the two together, and
private. If you set `API_KEY_SECRET` in `.env` yourself, keep `.env` with the
dump instead. The API notices a mismatch at startup and says so, but it is
cheaper to not need telling.

To restore:

```sh
docker compose down
docker compose up -d db
./scripts/restore.sh backups/mcpspan-20260924T125710Z.dump
docker compose up -d
```

The database service starts alone on purpose. Bringing the whole stack up first
would run migrations and start accepting events, and restoring on top of that
is how two versions of the truth end up in one table.
