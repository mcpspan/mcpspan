"""The conformance adapter for the Python SDK, on the official MCP SDK.

Runs on either major version: v1 serves tools through FastMCP, v2 through
MCPServer, and v2 answers both the 2025 and the 2026-07-28 protocol on one
stdio connection. Which is installed decides which is used.
"""

import os

import mcpspan

try:
    from mcp.server.fastmcp import FastMCP as Server  # v1
except ImportError:
    from mcp.server.mcpserver import MCPServer as Server  # v2

from mcp.types import CallToolResult


class ConformanceError(Exception):
    pass


try:
    server = Server("conformance", version="1.0.0")  # v2 takes the server's version
except TypeError:
    # v1's FastMCP takes none, and its handshake names the mcp package's own
    # version instead. A developer who wants theirs sets it where v1 keeps it.
    server = Server("conformance")
    server._mcp_server.version = "1.0.0"


@server.tool()
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


@server.tool()
def ok() -> str:
    return "ok"


@server.tool()
def large() -> str:
    return "x" * 100_000


@server.tool()
def reported_error() -> CallToolResult:
    return CallToolResult.model_validate(
        {"content": [{"type": "text", "text": "No flights found"}], "isError": True}
    )


@server.tool()
def throws() -> str:
    raise ConformanceError("boom")


@server.tool()
def typed(destination: str, passengers: float) -> str:
    return "ok"


@server.tool()
@mcpspan.exclude
def excluded(depth: float) -> str:
    return "ok"


def long_named() -> str:
    return "ok"


server.add_tool(long_named, name="long_" + "x" * 295)


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


@server.prompt()
def plan_trip(destination: str) -> str:
    return f"Plan a trip to {destination}"


@server.prompt()
def broken_prompt() -> str:
    raise ConformanceError("boom")

server.run()
