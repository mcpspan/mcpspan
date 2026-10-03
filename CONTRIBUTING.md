# Contributing

Thanks for looking. This is a short file on purpose: how to get it running,
what the tests expect, and the few rules that are not obvious from reading the
code.

## Getting set up

You need Node 24, pnpm 12, and Docker. The database runs in a container; the
applications run from the repository.

```sh
pnpm install
cp .env.example .env          # then put `openssl rand -hex 32` in API_KEY_SECRET
docker compose up -d db
pnpm --filter @mcpspan/core-api migrate
```

Then, in two terminals:

```sh
pnpm --filter @mcpspan/core-api dev        # http://localhost:6271
pnpm --filter @mcpspan/core-dashboard dev  # http://localhost:6270
```

The first visit to the dashboard offers to create the account.

To run the whole thing in containers instead, see the [README](README.md).

## Checks

```sh
pnpm --filter mcpspan build   # first: the API's tests import the built SDK
pnpm test                     # SDK unit tests, plus the API's integration tests
pnpm typecheck
```

The API's tests want a database. They create one of their own, separate from
the development database, so `docker compose up -d db` is the only setup they
need. They run against real PostgreSQL rather than a mock, because the
aggregation queries lean on TimescaleDB specifics that a mock would happily
get wrong.

The SDK has one more:

```sh
pnpm --filter mcpspan check:readme   # its README's samples must compile
```

The Python SDK uses [uv](https://docs.astral.sh/uv/). Its tests run against
one MCP SDK at a time, chosen by dependency group: `mcp1`, `mcp2` or
`fastmcp`.

```sh
cd packages/mcpspan-python
uv sync --group mcp2
uv run --group mcp2 pytest
uv run --group mcp2 mypy
uv run ruff check && uv run ruff format --check
```

The Go SDK is three modules tied together by `go.work`:

```sh
cd packages/mcpspan-go
go test ./... ./mcpsdk/... ./mcpgo/...
go vet ./... ./mcpsdk/... ./mcpgo/...
```

The JVM SDK builds with Gradle, warnings as errors, javadoc included:

```sh
cd packages/mcpspan-jvm
./gradlew build
```

The .NET SDK builds with warnings as errors:

```sh
cd packages/mcpspan-dotnet
dotnet test
```

The Rust SDK, with clippy's warnings as errors, as CI runs it:

```sh
cd packages/mcpspan-rust
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The Ruby SDK, tests and RuboCop together:

```sh
cd packages/mcpspan-ruby
bundle install
bundle exec rake
```

The PHP SDK, with PHPStan and php-cs-fixer:

```sh
cd packages/mcpspan-php
composer install
composer test && composer analyse && composer lint
```

Everything here also runs in CI, on every push and pull request.

To try it by hand: `packages/mcpspan/examples/smoke.ts` sends a few calls
through the SDK with no MCP server involved, the quickest check that an
installation works end to end; `packages/mcpspan/examples/test-server.ts` is a
real instrumented MCP server to point the Inspector or Claude Desktop at; and
`apps/core-api/scripts/benchmark-rollup.ts` measures the dashboard's queries
on a million generated calls. Each says how to run it at the top.

## Where things live

| | |
|---|---|
| `packages/mcpspan` | The TypeScript SDK. Published to npm, so its public API is a commitment. |
| `packages/mcpspan-python` | The Python SDK, the same commitment on PyPI. |
| `packages/mcpspan-go` | The Go SDK: a core without dependencies, and a module per MCP SDK. |
| `packages/mcpspan-dotnet` | The .NET SDK, published to NuGet as `McpSpan`. |
| `packages/mcpspan-jvm` | The JVM SDK: a core without dependencies, and a module per MCP SDK. |
| `packages/mcpspan-rust` | The Rust SDK, the crate `mcpspan` on crates.io, for rmcp. |
| `packages/mcpspan-ruby` | The Ruby SDK, the gem `mcpspan`, for the `mcp` gem. |
| `packages/mcpspan-php` | The PHP SDK, `mcpspan/mcpspan` on Packagist, for Laravel MCP and `mcp/sdk`. |
| `apps/core-api` | Ingest and aggregation. Runs TypeScript directly, no build step. |
| `apps/core-dashboard` | Next, App Router. Everything renders on the server unless it cannot. |
| `docs/sdk-contract.md` | What every SDK must do, in any language. Read it before changing what the SDK sends or how. |
| `conformance` | Checks an SDK against that contract, in any language, through a small adapter. |

## Rules that are easy to break by accident

**The SDK must never break somebody's server.** It is a library inside another
developer's process. A failure to reach the network, a malformed option, a
wrapped handler that throws: none of it may surface in their code or stop
their server from starting. If a change can raise an exception into a caller,
it is the wrong change.

**Parameter values never leave the process.** Names and types may be recorded,
when the user turns that on. Values never are, in no mode, not even in debug.
A change that puts an argument into an event is not a feature to be discussed;
it is a bug.

**Diagnostics go to stderr, never stdout.** On an MCP stdio transport, stdout
carries the protocol. A stray `console.log` or `print` corrupts it.

**A failed tool call has two shapes.** MCP asks tools to report their own
errors inside the result with `isError` set; a thrown exception is the
deviation. Both count, and each event records which happened. Code that
watches only for exceptions reports a correctly written server as flawless.

**Server identity comes from the API key, never from the request body.** If a
client could name its own server, it could write into somebody else's data.

## Backups

`scripts/backup.sh` and `scripts/restore.sh`. The restore path is not the
obvious one: a TimescaleDB database keeps its own catalog with circular foreign
keys between the tables describing hypertables and continuous aggregates, so a
plain `pg_restore` fails on ordering. The scripts wrap it in
`timescaledb_pre_restore()` and `timescaledb_post_restore()`, which is what
makes the rollup and its policies come back rather than arriving as an ordinary
view with no schedule.

## Sending a change

Open an issue first if it is a feature or a change of behaviour, so nobody
writes something that was never going to be merged. Small fixes can go
straight to a pull request.

- One change per pull request.
- Tests for anything that can regress, in the same commit as the change.
- Commit messages say why, not what. The diff already says what.
- Comments in the code are for the reasoning that the code cannot show:
  why this approach and not the obvious one, what breaks if it changes back.

If you find a security problem, please do not open a public issue. Report it
privately instead.

## Licence

MIT. Contributions are accepted under the same licence.
