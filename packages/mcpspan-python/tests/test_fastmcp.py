"""instrument() on FastMCP (the `fastmcp` package), through its own client.

Runs with `uv run --group fastmcp`. Over stdio, the conformance suite in
`conformance/` covers the same ground.
"""

from __future__ import annotations

import contextlib
from typing import Any

import pytest

pytest.importorskip("fastmcp")

import anyio
from fastmcp import Client, Context, FastMCP
from fastmcp.tools import InputRequiredToolResult, ToolResult
from mcp.types import Implementation
from mcp_types import InputRequiredResult

import mcpspan
from mcpspan._track import set_capture_parameter_names, set_event_sink
from mcpspan._types import ToolCallEvent


class ConformanceError(Exception):
    pass


def build() -> FastMCP:
    server = FastMCP("test")

    @server.tool
    def ok() -> str:
        return "ok"

    @server.tool
    async def reported_error() -> ToolResult:
        return ToolResult(content="No flights found", is_error=True)

    @server.tool
    def throws() -> str:
        raise ConformanceError("boom")

    @server.tool
    def typed(destination: str, passengers: float) -> str:
        return destination

    @server.tool
    @mcpspan.exclude
    def excluded(depth: float) -> str:
        return "ok"

    @server.tool
    async def whoami(ctx: Context) -> str:
        return type(ctx).__name__

    return server


def instrumented(server: FastMCP, events: list[ToolCallEvent]) -> FastMCP:
    mcpspan.instrument(server)
    set_event_sink(events.append)
    return server


def run(
    server: FastMCP, *calls: tuple[str, dict[str, Any]], name: str = "claude-code"
) -> list[Any]:
    async def go() -> list[Any]:
        results: list[Any] = []
        client = Client(server, client_info=Implementation(name=name, version="1.0.0"))
        async with client:
            for tool, arguments in calls:
                results.append(await client.call_tool(tool, arguments, raise_on_error=False))
        return results

    return anyio.run(go)


def by_tool(events: list[ToolCallEvent]) -> dict[str, ToolCallEvent]:
    return {event["toolName"]: event for event in events}


def test_records_each_kind_of_outcome() -> None:
    events: list[ToolCallEvent] = []
    server = instrumented(build(), events)

    results = run(server, ("ok", {}), ("reported_error", {}), ("throws", {}))

    recorded = by_tool(events)
    assert recorded["ok"]["success"] is True
    assert recorded["reported_error"]["errorSource"] == "result"
    assert recorded["reported_error"]["errorMessage"] == "No flights found"
    assert recorded["throws"]["errorSource"] == "exception"
    assert recorded["throws"]["errorType"] == "ConformanceError"
    assert recorded["throws"]["errorMessage"] == "boom"
    assert [result.is_error for result in results] == [False, True, True]


def test_records_refused_calls_without_a_message() -> None:
    events: list[ToolCallEvent] = []
    server = instrumented(build(), events)

    run(server, ("typed", {"destination": "WAW", "passengers": "two"}), ("no_such_tool", {}))

    recorded = by_tool(events)
    assert recorded["typed"]["errorSource"] == "arguments"
    assert "errorMessage" not in recorded["typed"]
    assert recorded["no_such_tool"]["errorSource"] == "unknown_tool"
    assert "errorMessage" not in recorded["no_such_tool"]


def test_records_names_and_types_and_never_a_value() -> None:
    events: list[ToolCallEvent] = []
    server = instrumented(build(), events)
    set_capture_parameter_names(True)

    run(server, ("typed", {"destination": "secret", "passengers": 2}))

    assert events[0]["parameters"] == {"destination": "string", "passengers": "number"}
    assert "secret" not in repr(events)


def test_leaves_an_excluded_tool_out_even_when_refused() -> None:
    events: list[ToolCallEvent] = []
    server = instrumented(build(), events)

    run(server, ("excluded", {"depth": 1}), ("excluded", {"depth": "deep"}), ("ok", {}))

    assert [event["toolName"] for event in events] == ["ok"]


def test_the_client_and_one_session_per_connection() -> None:
    events: list[ToolCallEvent] = []
    server = instrumented(build(), events)

    run(server, ("ok", {}), ("typed", {}), ("no_such_tool", {}), name="cursor-vscode")

    assert {event["clientType"] for event in events} == {"cursor"}
    assert {event["clientName"] for event in events} == {"cursor-vscode"}
    sessions = {event.get("sessionId") for event in events}
    assert len(sessions) == 1 and None not in sessions


def test_a_tool_asking_for_the_context_still_gets_it() -> None:
    events: list[ToolCallEvent] = []
    server = instrumented(build(), events)

    [result] = run(server, ("whoami", {}))

    assert result.content[0].text == "Context"


def test_instrumenting_twice_counts_once() -> None:
    events: list[ToolCallEvent] = []
    server = instrumented(build(), events)
    mcpspan.instrument(server)
    set_event_sink(events.append)

    run(server, ("ok", {}))

    assert len(events) == 1


def test_unconfigured_the_server_works_and_nothing_is_recorded() -> None:
    server = mcpspan.instrument(build())

    [result] = run(server, ("ok", {}))

    assert result.content[0].text == "ok"


@pytest.mark.parametrize(("mode", "recorded"), [("legacy", [("result", False)]), ("auto", [])])
def test_an_interim_result_counts_only_when_it_reaches_the_client_as_an_error(
    mode: str, recorded: list[tuple[str, bool]]
) -> None:
    events: list[ToolCallEvent] = []
    server = FastMCP("interim")

    @server.tool
    async def confirm() -> InputRequiredToolResult:
        return InputRequiredToolResult(
            InputRequiredResult.model_validate(
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
        )

    instrumented(server, events)

    async def go() -> None:
        async with Client(server, mode=mode) as client:
            with contextlib.suppress(Exception):
                await client.call_tool("confirm", {}, raise_on_error=False)

    anyio.run(go)

    assert [(event.get("errorSource"), event["success"]) for event in events] == recorded


def test_resources_and_prompts_are_recorded_by_what_they_are(events: list[ToolCallEvent]) -> None:
    """Contract, 3.5, through FastMCP's middleware."""
    server = build()

    @server.resource("config://app")
    def config() -> str:
        return "ok"

    @server.resource("trips://{id}")
    def trip(id: str) -> str:
        return "ok"

    @server.prompt
    def plan_trip(destination: str) -> str:
        return destination

    @server.prompt
    def broken_prompt() -> str:
        raise ConformanceError("boom")

    instrumented(server, events)
    set_capture_parameter_names(True)

    async def go() -> None:
        async with Client(server) as client:
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
