from __future__ import annotations

from typing import Literal, TypedDict

ErrorSource = Literal["result", "exception", "arguments", "unknown_tool"]
"""How a failed tool call announced itself.

`result` is a result the tool marked with `isError`, which MCP treats as the
ordinary way to report a problem. `exception` is a handler that raised. The
other two never reach a handler: the server refused the arguments, or has no
tool by that name.
"""


class _RequiredEventFields(TypedDict):
    id: str
    toolName: str
    durationMs: float
    success: bool
    clientType: Literal["unknown"]
    """Always `unknown`: the mcpspan server decides the client from `clientName`
    (contract, 7). Sent only because servers released before 2026-10-15 refuse an
    event without it."""
    timestamp: str
    sdkVersion: str


class ListedTool(TypedDict):
    """One tool in a listing (contract, 3.11): its name, fingerprint and size.
    Never its definition."""

    name: str
    definitionHash: str
    definitionBytes: int


class ToolCallEvent(_RequiredEventFields, total=False):
    """A single tool call, in the shape the ingest API takes.

    Field names follow the wire format, not Python's conventions, so an event
    goes out exactly as it is built. Parameter values are never part of it.
    """

    kind: str
    errorSource: str
    errorType: str
    errorMessage: str
    clientName: str
    clientVersion: str
    serverVersion: str
    responseBytes: int
    definitionHash: str
    repeated: bool
    invalidArguments: list[str]
    listedTools: list[ListedTool]
    sessionId: str
    parameters: dict[str, str]
