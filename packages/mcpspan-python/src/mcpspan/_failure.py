from __future__ import annotations

from collections.abc import Mapping
from typing import Any

MAX_EXCEPTION_MESSAGE_LENGTH = 500
"""Longest message kept from a raised exception.

Exception messages are written by developers for developers, so they are
mostly safe to keep and mostly worth reading in full.
"""

MAX_RESULT_MESSAGE_LENGTH = 200
"""Longest message kept from a result marked as an error.

Shorter than the exception limit on purpose. This text was written for a
language model to read, so it is far more likely than an exception message to
quote back whatever the user asked about.
"""

MAX_NAME_LENGTH = 200
"""Longest text the ingest API takes in a name-like field: a tool, an error
type, a client, a parameter.

The API refuses a whole batch when any one field is over its limit, so an
over-long value would take every other event in its batch down with it. These
values come from outside the developer's control - a client names itself, an
exception names its own class - so they are cut here rather than trusted.
"""


def truncate(text: str, limit: int) -> str:
    """Cuts text to a limit, leaving a visible sign that something was removed."""
    return text if len(text) <= limit else f"{text[: limit - 3]}..."


def format_error(error: BaseException) -> str:
    """Renders an exception as one readable line, for diagnostics."""
    return f"{type(error).__name__}: {error}"


def _field(value: Any, *names: str) -> Any:
    """Reads the first of several spellings of a field, from a model or a dict.

    The official MCP SDK names result fields in camel case in v1 (`isError`)
    and in snake case in v2 (`is_error`), and a tool may also return a plain
    dict in the wire's own spelling. Callers list the v2 spelling first: v2
    keeps the old name as a deprecated alias whose every read warns, and those
    warnings would land in the developer's logs.
    """
    for name in names:
        if isinstance(value, Mapping):
            if name in value:
                return value[name]
        elif hasattr(value, name):
            return getattr(value, name)

    return None


def is_error_result(result: Any) -> bool:
    """Whether a tool reported its own failure through the result.

    MCP asks tools to answer with `isError` rather than raising, so that the
    model can see what went wrong and react. A wrapper that only watched for
    exceptions would record a correctly written server as never failing.
    """
    return _field(result, "is_error", "isError") is True


_INTERIM_TYPES = ("InputRequiredResult", "InputRequiredToolResult")


def is_input_required(result: Any) -> bool:
    """A result the 2026-07-28 protocol calls interim: the tool needs more input first."""
    # The official SDK's result type, and FastMCP's subclass of its own.
    if any(cls.__name__ in _INTERIM_TYPES for cls in type(result).__mro__):
        return True

    return bool(_field(result, "result_type", "resultType") == "input_required")


def describe_error_result(result: Any) -> str | None:
    """Pulls a short description out of a tool result that reported an error.

    Reads only text blocks. Images and binary attachments carry no message
    worth storing, and copying them anywhere would be indefensible.
    """
    content = _field(result, "content")
    if not isinstance(content, (list, tuple)):
        return None

    texts = [
        text
        for block in content
        if _field(block, "type") == "text" and isinstance(text := _field(block, "text"), str)
    ]
    joined = " ".join(texts).strip()

    return truncate(joined, MAX_RESULT_MESSAGE_LENGTH) if joined else None


def describe_exception(error: BaseException) -> tuple[str, str | None]:
    """The class name and message of a raised exception, cut to their limits."""
    message = str(error)

    return (
        truncate(type(error).__name__, MAX_NAME_LENGTH),
        truncate(message, MAX_EXCEPTION_MESSAGE_LENGTH) if message else None,
    )
