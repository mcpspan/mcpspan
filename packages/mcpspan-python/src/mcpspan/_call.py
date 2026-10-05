from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from ._client import ClientInfo


@dataclass
class CallState:
    """What instrumentation knows about the tool call now running.

    `track` wraps the developer's function and sees only its arguments. Which
    connection the call arrived on, which client sent it, and the arguments as
    the client sent them are known one layer out, where the MCP server looks
    the tool up. They reach the function's wrapper through a context variable,
    which follows the call into the task or worker thread that runs it and is
    never shared with a concurrent call.

    `reached` is set by the wrapper, so the layer outside knows whether the
    call got as far as the tool or was refused before it.
    """

    session_id: str | None
    client: ClientInfo | None
    arguments: Any
    server_version: str | None = None
    reached: bool = False
    interim: bool = False
    repeated: bool = False
    """The arguments are the previous call's to the same tool in this session (contract, 3.9)."""


current_call: ContextVar[CallState | None] = ContextVar("mcpspan_call", default=None)


MODERN_PROTOCOL = "2026-07-28"
"""The first protocol revision on which a tool can ask the client for input."""


def cannot_ask(request_context: Any) -> bool:
    """Whether the connection is on a protocol with no way to ask for input.

    There, an interim `input_required` result cannot be delivered, and the MCP
    SDK answers the client with an error in its place: v2 of the official SDK
    and FastMCP both do. Revisions are dates, so they compare as text.
    """
    version = getattr(getattr(request_context, "session", None), "protocol_version", None)

    return isinstance(version, str) and version < MODERN_PROTOCOL
