from __future__ import annotations

import sys
from collections.abc import Callable
from typing import Any, TypeVar

from ._config import configure, is_collecting
from ._failure import format_error
from ._fastmcp import instrument_fastmcp
from ._official import instrument_official

S = TypeVar("S")


def instrument(
    server: S,
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    debug: bool | None = None,
    on_diagnostic: Callable[[str], object] | None = None,
    flush_on_exit: bool | None = None,
    flush_interval: float | None = None,
    max_batch_size: int | None = None,
    max_queue_size: int | None = None,
    capture_parameter_names: bool | None = None,
    server_version: str | None = None,
) -> S:
    """Measures every tool on an MCP server, and returns the server.

        mcp = FastMCP("flights")
        mcpspan.instrument(mcp, api_key=os.environ["MCPSPAN_API_KEY"])

    Works with the official MCP SDK's `FastMCP` (v1) and `MCPServer` (v2),
    and with FastMCP from version 4 (the `fastmcp` package).
    Tools registered before this call and after it are both measured, and
    nothing about how they are declared has to change.

    Settings are those of `configure()`. Given any, they are applied; given
    none, the SDK is configured from the environment unless `configure()` was
    called already, so calling that first and this second keeps the first.

    Never raises. An unfamiliar server is left exactly as it was, and says so
    on standard error when `debug` is on. A telemetry library that can stop
    somebody's server from starting has failed at the one thing it must not.
    """
    settings: dict[str, Any] = {
        key: value
        for key, value in {
            "api_key": api_key,
            "endpoint": endpoint,
            "debug": debug,
            "on_diagnostic": on_diagnostic,
            "flush_on_exit": flush_on_exit,
            "flush_interval": flush_interval,
            "max_batch_size": max_batch_size,
            "max_queue_size": max_queue_size,
            "capture_parameter_names": capture_parameter_names,
            "server_version": server_version,
        }.items()
        if value is not None
    }

    try:
        if settings or not is_collecting():
            configure(**settings)

        known = instrument_fastmcp(server) or instrument_official(server)
        if not known and debug:
            print(
                f"mcpspan: {type(server).__name__} is not a server mcpspan knows, "
                "so nothing was instrumented",
                file=sys.stderr,
            )
    except Exception as error:
        if debug:
            print(
                f"mcpspan: could not instrument this server ({format_error(error)})",
                file=sys.stderr,
            )

    return server
