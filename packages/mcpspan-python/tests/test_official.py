"""instrument() on the official MCP SDK, through a real client, in memory.

Runs against whichever major version is installed: `uv run --group mcp1`
for v1, `--group mcp2` for v2. Over stdio, the same ground is covered by the
conformance suite in `conformance/`.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

import pytest

pytest.importorskip("mcp")

import anyio
from mcp.types import CallToolResult, Implementation

import mcpspan
from mcpspan._track import set_capture_parameter_names, set_event_sink, set_server_version
from mcpspan._types import ToolCallEvent

try:
    # Each version's names exist only in that version, so only one of these
    # two branches type-checks against whichever is installed.
    from mcp.server.fastmcp import Context  # type: ignore[attr-defined, unused-ignore]
    from mcp.server.fastmcp import FastMCP as Server  # type: ignore[attr-defined, unused-ignore]

    VERSION = 1
except ImportError:
    from mcp.server.mcpserver import Context  # type: ignore[no-redef, unused-ignore]
    from mcp.server.mcpserver import MCPServer as Server  # type: ignore[no-redef, unused-ignore]

    VERSION = 2

try:
    # v2 only: the result a tool returns to ask the client for input.
    from mcp_types import InputRequiredResult
except ImportError:
    InputRequiredResult = None  # type: ignore[assignment, misc, unused-ignore]


@asynccontextmanager
async def connect(
    server: Any, name: str = "claude-code", mode: str = "legacy"
) -> AsyncIterator[Any]:
    """A client connected to the server in memory, calling itself `name`."""
    info = Implementation(name=name, version="1.0.0")

    if VERSION == 1:
        from mcp.shared.memory import (  # type: ignore[attr-defined, unused-ignore]
            create_connected_server_and_client_session,
        )

        async with create_connected_server_and_client_session(server, client_info=info) as client:
            yield client
    else:
        from mcp import Client  # type: ignore[attr-defined, unused-ignore]

        async with Client(server, client_info=info, mode=mode) as client:
            yield client


def run(server: Any, *calls: tuple[str, dict[str, Any]], **options: str) -> list[Any]:
    async def go() -> list[Any]:
        results = []
        async with connect(server, **options) as client:
            for name, arguments in calls:
                try:
                    results.append(await client.call_tool(name, arguments))
                except Exception as error:
                    results.append(error)
        return results

    return anyio.run(go)


class ConformanceError(Exception):
    pass


def build(register: Callable[[Any], None] | None = None) -> Any:
    server = Server("test")

    @server.tool()
    def ok() -> str:
        return "ok"

    @server.tool()
    async def reported_error() -> CallToolResult:
        return CallToolResult.model_validate(
            {"content": [{"type": "text", "text": "No flights found"}], "isError": True}
        )

    @server.tool()
    def throws() -> str:
        raise ConformanceError("boom")

    @server.tool()
    def typed(destination: str, passengers: float) -> str:
        return destination

    @server.tool()
    @mcpspan.exclude
    def excluded(depth: float) -> str:
        return "ok"

    if register is not None:
        register(server)

    return server


@pytest.fixture
def events() -> list[ToolCallEvent]:
    return []


def instrumented(server: Any, events: list[ToolCallEvent]) -> Any:
    mcpspan.instrument(server)
    # After instrument(), which without a key configures nothing and would
    # otherwise switch this sink off again.
    set_event_sink(events.append)
    return server


def by_tool(events: list[ToolCallEvent]) -> dict[str, ToolCallEvent]:
    return {event["toolName"]: event for event in events}


def test_measures_tools_registered_before_and_after(events: list[ToolCallEvent]) -> None:
    server = instrumented(build(), events)

    @server.tool()
    def later() -> str:
        return "later"

    run(server, ("ok", {}), ("later", {}))

    assert [event["toolName"] for event in events] == ["ok", "later"]
    assert all(event["success"] for event in events)


def test_records_each_kind_of_outcome(events: list[ToolCallEvent]) -> None:
    server = instrumented(build(), events)

    results = run(server, ("reported_error", {}), ("throws", {}))

    recorded = by_tool(events)
    assert recorded["reported_error"]["errorSource"] == "result"
    assert recorded["reported_error"]["errorMessage"] == "No flights found"
    assert recorded["throws"]["errorSource"] == "exception"
    assert recorded["throws"]["errorType"] == "ConformanceError"
    assert recorded["throws"]["errorMessage"] == "boom"
    # The client still gets its error, as it would without mcpspan.
    assert all(getattr(result, "is_error", None) or result.isError for result in results)


def test_records_refused_calls_without_a_message(events: list[ToolCallEvent]) -> None:
    server = instrumented(build(), events)

    run(server, ("typed", {"destination": "WAW", "passengers": "two"}), ("no_such_tool", {}))

    recorded = by_tool(events)
    assert recorded["typed"]["errorSource"] == "arguments"
    assert "errorMessage" not in recorded["typed"]
    assert recorded["no_such_tool"]["errorSource"] == "unknown_tool"


def test_records_parameter_types_of_a_refused_call_and_no_value(
    events: list[ToolCallEvent],
) -> None:
    server = instrumented(build(), events)
    set_capture_parameter_names(True)

    run(server, ("typed", {"dest": "secret", "passengers": "two"}))

    assert events[0]["parameters"] == {"dest": "string", "passengers": "string"}
    assert "secret" not in repr(events)


def test_leaves_an_excluded_tool_out_even_when_refused(events: list[ToolCallEvent]) -> None:
    server = instrumented(build(), events)

    run(server, ("excluded", {"depth": 1}), ("excluded", {"depth": "deep"}), ("ok", {}))

    assert [event["toolName"] for event in events] == ["ok"]


def test_the_client_and_one_session_per_connection(events: list[ToolCallEvent]) -> None:
    server = instrumented(build(), events)

    run(server, ("ok", {}), ("typed", {}), ("no_such_tool", {}), name="Claude Desktop")

    assert {event["clientType"] for event in events} == {"claude"}
    assert {event["clientName"] for event in events} == {"Claude Desktop"}
    sessions = {event.get("sessionId") for event in events}
    assert len(sessions) == 1 and None not in sessions


def test_a_second_server_is_a_second_session(events: list[ToolCallEvent]) -> None:
    first = instrumented(build(), events)
    second = instrumented(build(), events)

    run(first, ("ok", {}))
    run(second, ("ok", {}))

    assert len({event["sessionId"] for event in events}) == 2


def test_a_tool_asking_for_the_context_still_gets_it(events: list[ToolCallEvent]) -> None:
    def register(server: Any) -> None:
        @server.tool()
        async def whoami(ctx: Context) -> str:  # type: ignore[type-arg, unused-ignore]
            return type(ctx).__name__

    server = instrumented(build(register), events)

    [result] = run(server, ("whoami", {}))

    assert result.content[0].text == "Context"
    assert events[0]["success"] is True


def test_a_tool_tracked_by_hand_and_instrumented_counts_once(events: list[ToolCallEvent]) -> None:
    def register(server: Any) -> None:
        server.add_tool(mcpspan.track("by_hand", lambda: "ok"), name="by_hand")

    server = instrumented(build(register), events)
    mcpspan.instrument(server)
    set_event_sink(events.append)

    run(server, ("by_hand", {}), ("ok", {}))

    assert [event["toolName"] for event in events] == ["by_hand", "ok"]


def test_unconfigured_the_server_works_and_nothing_is_recorded() -> None:
    server = mcpspan.instrument(build())

    [result] = run(server, ("ok", {}))

    assert result.content[0].text == "ok"


@pytest.mark.skipif(VERSION == 1, reason="v1 speaks the 2025 protocol only")
def test_on_2026_the_client_comes_from_each_request(events: list[ToolCallEvent]) -> None:
    server = instrumented(build(), events)

    run(server, ("ok", {}), ("typed", {}), name="cursor-vscode", mode="auto")

    assert [event["clientType"] for event in events] == ["cursor", "cursor"]
    assert [event["clientName"] for event in events] == ["cursor-vscode", "cursor-vscode"]


def test_instrument_never_raises_and_leaves_an_unknown_object_alone(
    capsys: pytest.CaptureFixture[str],
) -> None:
    thing = object()

    assert mcpspan.instrument(thing, debug=True) is thing
    captured = capsys.readouterr()
    assert "nothing was instrumented" in captured.err
    assert captured.out == ""


def test_prints_nothing_on_standard_output(capsys: pytest.CaptureFixture[str]) -> None:
    server = mcpspan.instrument(build(), api_key="k", endpoint="http://127.0.0.1:9", debug=True)

    run(server, ("ok", {}), ("throws", {}), ("typed", {}))
    mcpspan.shutdown()

    assert capsys.readouterr().out == ""


def test_raises_no_warning_of_its_own_in_the_host(events: list[ToolCallEvent]) -> None:
    import warnings

    server = instrumented(build(), events)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        run(server, ("ok", {}), ("reported_error", {}), ("throws", {}), ("typed", {}))

    ours = [warning for warning in caught if "/mcpspan/" in warning.filename.replace("\\", "/")]
    assert ours == []


def interim_server() -> Any:
    server = Server("interim")

    @server.tool()
    async def confirm() -> InputRequiredResult:
        return InputRequiredResult.model_validate(
            {
                "inputRequests": {
                    "q": {
                        "method": "elicitation/create",
                        "params": {
                            "message": "Sure?",
                            "requestedSchema": {"type": "object", "properties": {}},
                        },
                    }
                }
            }
        )

    return server


@pytest.mark.skipif(VERSION == 1, reason="v1 has no interim results")
@pytest.mark.parametrize(("mode", "recorded"), [("legacy", [("result", False)]), ("auto", [])])
def test_an_interim_result_counts_only_when_it_reaches_the_client_as_an_error(
    events: list[ToolCallEvent], mode: str, recorded: list[tuple[str, bool]]
) -> None:
    server = instrumented(interim_server(), events)

    run(server, ("confirm", {}), mode=mode)

    assert [(event.get("errorSource"), event["success"]) for event in events] == recorded


def test_resources_and_prompts_are_recorded_by_what_they_are(events: list[ToolCallEvent]) -> None:
    """Contract, 3.5: a fixed resource by its URI, a templated read by its
    template and never the address asked for, a missing one by its scheme; a
    prompt by name, refused, missing or raising."""
    server = build()

    @server.resource("config://app")
    def config() -> str:
        return "ok"

    @server.resource("trips://{id}")
    def trip(id: str) -> str:
        return "ok"

    @server.prompt()
    def plan_trip(destination: str) -> str:
        return destination

    @server.prompt()
    def broken_prompt() -> str:
        raise ConformanceError("boom")

    instrumented(server, events)
    set_capture_parameter_names(True)

    async def go() -> None:
        async with connect(server, name="cursor") as client:
            await client.read_resource("config://app")
            await client.read_resource("trips://secret-4412")
            with contextlib.suppress(Exception):
                await client.read_resource("db://customers/lovelace")
            await client.get_prompt("plan_trip", {"destination": "Lisbon"})
            refused: tuple[tuple[str, dict[str, str]], ...] = (
                ("plan_trip", {}),
                ("translate", {}),
                ("broken_prompt", {}),
            )
            for name, arguments in refused:
                with contextlib.suppress(Exception):
                    await client.get_prompt(name, arguments)

    anyio.run(go)
    set_capture_parameter_names(False)

    assert [(e.get("kind"), e["toolName"], e.get("errorSource")) for e in events] == [
        ("resource", "config://app", None),
        ("resource", "trips://{id}", None),
        ("resource", "db://", "unknown_resource"),
        ("prompt", "plan_trip", None),
        ("prompt", "plan_trip", "arguments"),
        ("prompt", "translate", "unknown_prompt"),
        ("prompt", "broken_prompt", "exception"),
    ]
    assert events[1].get("parameters") == {"id": "string"}
    assert events[6].get("errorType") == "ConformanceError"
    assert "lovelace" not in repr(events) and "Lisbon" not in repr(events)
    assert all(e["clientType"] == "cursor" for e in events)


def _versioned(server: Any, version: str) -> Any:
    """Gives a built server a version, where each major version keeps it."""
    inner = getattr(server, "_lowlevel_server", None) or server._mcp_server
    inner.version = version
    return server


def test_versions_of_the_server_and_the_client(events: list[ToolCallEvent]) -> None:
    server = instrumented(_versioned(build(), "3.1.4"), events)

    run(server, ("ok", {}), ("no_such_tool", {}))

    assert [(event.get("serverVersion"), event.get("clientVersion")) for event in events] == [
        ("3.1.4", "1.0.0"),
        ("3.1.4", "1.0.0"),
    ]


def test_a_version_given_to_the_sdk_wins_over_the_servers_own(events: list[ToolCallEvent]) -> None:
    server = instrumented(_versioned(build(), "3.1.4"), events)
    set_server_version("a1b2c3d")
    try:
        run(server, ("ok", {}))
    finally:
        set_server_version(None)

    assert events[0].get("serverVersion") == "a1b2c3d"
