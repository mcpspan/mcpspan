"""The conformance adapter for the Python SDK, on FastMCP (the `fastmcp` package).

FastMCP answers both the 2025 and the 2026-07-28 protocol on one stdio
connection.
"""

import os

from fastmcp import FastMCP
from fastmcp.tools import ToolResult

import mcpspan


class ConformanceError(Exception):
    pass


server = FastMCP("conformance", version="1.0.0")


@server.tool
def early() -> str:
    # Registered before instrument(), as the contract requires an SDK to
    # measure too.
    return "ok"


mcpspan.instrument(
    server,
    endpoint=os.environ.get("MCPSPAN_ENDPOINT"),
    flush_interval=int(os.environ.get("CONFORMANCE_FLUSH_MS", "200")) / 1000,
    capture_parameter_names=os.environ.get("CONFORMANCE_CAPTURE_PARAMETERS") == "1",
    capture_error_messages=os.environ.get("CONFORMANCE_CAPTURE_ERROR_MESSAGES") != "0",
)


@server.tool
def ok() -> str:
    return "ok"


@server.tool
def large() -> str:
    return "x" * 100_000


@server.tool
def reported_error() -> ToolResult:
    return ToolResult(content="No flights found", is_error=True)


@server.tool
def throws() -> str:
    raise ConformanceError("boom")


@server.tool
def typed(destination: str, passengers: float) -> str:
    return "ok"


@server.tool
@mcpspan.exclude
def excluded(depth: float) -> str:
    return "ok"


@server.tool(name="long_" + "x" * 295)
def long_named() -> str:
    return "ok"


# Resources and prompts (contract, 3.5): one resource at a fixed address, one
# read through a template, one that raises; a prompt with a required argument,
# and one that raises.
@server.resource("config://app")
def config() -> str:
    return "ok"


@server.resource("trips://{id}")
def trip(id: str) -> str:
    return "ok"


@server.resource("broken://status")
def broken_resource() -> str:
    raise ConformanceError("boom")


@server.prompt
def plan_trip(destination: str) -> str:
    return f"Plan a trip to {destination}"


@server.prompt
def broken_prompt() -> str:
    raise ConformanceError("boom")


server.run(show_banner=False)
