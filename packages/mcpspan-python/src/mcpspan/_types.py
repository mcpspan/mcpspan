from __future__ import annotations

from typing import Literal, TypedDict

ClientType = Literal[
    "claude",
    "claude-code",
    "cursor",
    "chatgpt",
    "mcp-inspector",
    "other",
    "unknown",
]
"""Client application a tool call came from.

`other` means a client named itself and the name is not one we recognise;
`unknown` means nothing named a client at all.
"""

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
    clientType: str
    timestamp: str
    sdkVersion: str


class ToolCallEvent(_RequiredEventFields, total=False):
    """A single tool call, in the shape the ingest API takes.

    Field names follow the wire format, not Python's conventions, so an event
    goes out exactly as it is built. Parameter values are never part of it.
    """

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
    sessionId: str
    parameters: dict[str, str]
