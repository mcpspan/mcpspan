from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ._failure import MAX_NAME_LENGTH, truncate

MAX_DESCRIBED_PARAMETERS = 50
"""Most parameters described for a single call.

A bound rather than a guess at what is reasonable: a tool taking a very wide
object should not be able to turn one event into a large one.
"""


def _describe_type(value: Any) -> str:
    """Names the shape of a value without touching what is in it.

    Deliberately coarse, and in JSON's vocabulary so a Python server and a
    TypeScript one describe the same call the same way. Anything finer starts
    describing content.
    """
    if value is None:
        return "null"
    # Before the number check: in Python a bool is an int.
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, Mapping):
        return "object"
    if isinstance(value, (list, tuple)):
        return "array"

    return truncate(type(value).__name__, 50)


def describe_parameters(arguments: Any) -> dict[str, str] | None:
    """Lists the parameters a tool was called with, by name and type only.

    Values never leave the handler. This exists so a developer can see that
    `search_flights` is being called with `destination` but never with
    `departure_date`, without any of the answers reaching a server.
    """
    if not isinstance(arguments, Mapping):
        return None

    described: dict[str, str] = {}

    for name, value in arguments.items():
        if len(described) >= MAX_DESCRIBED_PARAMETERS:
            break
        # A name over the API's limit would have the whole batch refused.
        described[truncate(str(name), MAX_NAME_LENGTH)] = _describe_type(value)

    return described or None
