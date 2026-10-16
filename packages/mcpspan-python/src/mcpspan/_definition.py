"""Tool definitions as the server lists them, fingerprinted (contract, 3.8).

Rewording a description can change how agents use a tool more than a change
to its code. The fingerprint is taken from the answer to `tools/list`, what an
agent actually read, and sent with every call to the tool, so the dashboard
can mark when a definition changed. Kept for the process: one process reports
to one server, and a listing on one connection describes the same tools as on
any other.
"""

from __future__ import annotations

import contextlib
import hashlib
from collections.abc import Iterable, Mapping
from typing import Any, NamedTuple

_listed: dict[str, str] = {}

# Each tool's input schema as last listed, to tell which arguments a refusal
# was over (contract, 3.10).
_schemas: dict[str, Any] = {}

_HASHED = ("name", "title", "description", "inputSchema")

_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def definition_of(tool_name: str) -> str | None:
    """The latest fingerprint listed for a tool, if any listing in this process named it."""
    return _listed.get(tool_name)


def schema_of(tool_name: str) -> Any:
    """The latest input schema listed for a tool, if any listing in this process named it."""
    return _schemas.get(tool_name)


class ListedDefinition(NamedTuple):
    """A tool as a listing described it (contract, 3.11)."""

    name: str
    definition_hash: str
    definition_bytes: int


def note_listing(tools: Iterable[Any]) -> list[ListedDefinition]:
    """Notes every tool in a listing: wire dicts, or models of them, and returns
    them in its order, each with its fingerprint and size. Never raises."""
    found: list[ListedDefinition] = []
    with contextlib.suppress(Exception):
        for tool in tools:
            wire = _wire(tool)
            if wire is None or not isinstance(wire.get("name"), str):
                continue
            name = wire["name"]
            written = fingerprint(wire)
            if written is not None:
                _listed[name] = written[0]
                found.append(ListedDefinition(name, written[0], written[1]))
            _schemas[name] = wire.get("inputSchema")
    return found


def forget_listings() -> None:
    """For tests: forgets every listing."""
    _listed.clear()
    _schemas.clear()


def definition_hash(tool: Mapping[str, Any]) -> str | None:
    """The first 16 hex characters of the SHA-256 of the canonical name, title,
    description and input schema; None for a definition that cannot be written so."""
    written = fingerprint(tool)
    return written[0] if written is not None else None


def fingerprint(tool: Mapping[str, Any]) -> tuple[str, int] | None:
    """The fingerprint, and the size in UTF-8 bytes of the canonical JSON it is
    taken from (contract, 3.11); None for a definition that cannot be written so."""
    hashed = {field: tool[field] for field in _HASHED if tool.get(field) is not None}
    try:
        written = _canonical(hashed).encode("utf-8")
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(written).hexdigest()[:16], len(written)


def _wire(tool: Any) -> Mapping[str, Any] | None:
    """A listed tool in the wire's own spelling, whatever shape the SDK keeps it in."""
    if isinstance(tool, Mapping):
        return tool
    to_mcp = getattr(tool, "to_mcp_tool", None)
    if callable(to_mcp):
        tool = to_mcp()
    dump = getattr(tool, "model_dump", None)
    if callable(dump):
        wire = dump(mode="json", by_alias=True, exclude_none=True)
        return wire if isinstance(wire, Mapping) else None
    return None


def canonical(value: Any) -> str:
    """Sorted keys, no whitespace, minimal escaping: the same text in every SDK.
    Raises on what JSON cannot hold."""
    return _canonical(value)


def _canonical(value: Any) -> str:
    """Sorted keys, no whitespace, minimal escaping: the same text in every SDK."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("not a JSON number")
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, str):
        return _text(value)
    if isinstance(value, Mapping):
        keys = sorted(value)
        return "{" + ",".join(f"{_text(str(key))}:{_canonical(value[key])}" for key in keys) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    raise TypeError(f"cannot fingerprint {type(value).__name__}")


def _text(value: str) -> str:
    out = ['"']
    for character in value:
        escaped = _ESCAPES.get(character)
        if escaped is not None:
            out.append(escaped)
        elif ord(character) < 0x20:
            out.append(f"\\u{ord(character):04x}")
        else:
            out.append(character)
    out.append('"')
    return "".join(out)
