from __future__ import annotations

from collections.abc import Mapping
from typing import Any, NamedTuple

from ._failure import MAX_NAME_LENGTH, truncate
from ._types import ClientType


class ClientInfo(NamedTuple):
    """How a client described itself: its name and version, as sent.

    On the 2025 protocol a client says this once, in the `initialize`
    handshake; on the 2026-07-28 protocol it repeats it in every request's
    `_meta`.
    """

    name: str | None
    version: str | None


_KNOWN_CLIENTS: tuple[tuple[str, ClientType], ...] = (
    # Measured: Claude Code sends `claude-code`. It has to come before the
    # plain Claude entry, which would otherwise swallow it.
    ("claude-code", "claude-code"),
    ("claude code", "claude-code"),
    ("claude", "claude"),
    ("cursor", "cursor"),
    ("chatgpt", "chatgpt"),
    ("openai", "chatgpt"),
    # Measured: the official Inspector sends `inspector-cli`, which is why
    # names are matched as substrings.
    ("inspector", "mcp-inspector"),
)
"""Names we recognise, matched as substrings of what a client reports, first
match wins. The same table as every other mcpspan SDK (contract, section 7)."""


def detect_client(info: ClientInfo | None) -> ClientType:
    """Which application a tool call came from, as far as its name tells."""
    name = (info.name or "").strip().lower() if info is not None else ""
    if not name:
        return "unknown"

    for pattern, client_type in _KNOWN_CLIENTS:
        if pattern in name:
            return client_type

    return "other"


def client_name(info: ClientInfo | None) -> str | None:
    """The name a client reported, cut to what the API takes.

    Kept alongside the recognised type so an unfamiliar client is a lead
    rather than a dead end. The client chooses its own name, and one over the
    API's limit would lose every event in its batch.
    """
    name = (info.name or "").strip() if info is not None else ""

    return truncate(name, MAX_NAME_LENGTH) if name else None


CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo"
"""Where a request on the 2026-07-28 protocol names its client."""


def _read(value: Any, *names: str) -> Any:
    """The first of several spellings of a field, on a model or in a dict."""
    for name in names:
        if isinstance(value, Mapping):
            if name in value:
                return value[name]
        else:
            found = getattr(value, name, None)
            if found is not None:
                return found

    return None


def _as_client_info(value: Any) -> ClientInfo | None:
    name = _read(value, "name")
    version = _read(value, "version")

    if not isinstance(name, str) and not isinstance(version, str):
        return None

    return ClientInfo(
        name if isinstance(name, str) else None,
        version if isinstance(version, str) else None,
    )


def _declared_in_meta(meta: Any) -> Any:
    """The client a request's `_meta` names, whatever form `_meta` takes.

    v2 of the official MCP SDK hands `_meta` over as a dict. v1 keeps it as a
    model, with keys it does not know among its extra fields.
    """
    if meta is None:
        return None
    if isinstance(meta, Mapping):
        return meta.get(CLIENT_INFO_META_KEY)

    extra = getattr(meta, "model_extra", None)

    return extra.get(CLIENT_INFO_META_KEY) if isinstance(extra, Mapping) else None


def client_from_request(request_context: Any) -> ClientInfo | None:
    """The client that sent one request, from the MCP SDK's request context.

    The request itself is read first: on the 2026-07-28 protocol it names its
    client. Otherwise the handshake of the connection the request arrived on,
    and never any other connection's. A stateless HTTP endpoint on the 2025
    protocol has neither, and its calls are recorded with an unknown client
    rather than a guess.

    Every read is defensive. Knowing the client is a convenience; a request
    context of an unexpected shape leaves it unknown and nothing else.
    """
    if request_context is None:
        return None

    try:
        # `meta` first. v2 of the official SDK may keep only part of `_meta`
        # there, and the request's raw `params` still hold all of it.
        params = getattr(request_context, "params", None)
        for meta in (
            getattr(request_context, "meta", None),
            params.get("_meta") if isinstance(params, Mapping) else None,
        ):
            declared = _as_client_info(_declared_in_meta(meta))
            if declared is not None:
                return declared

        # v2 keeps the handshake on the connection; v1, and v2 as well, on the
        # session. `clientInfo` in v1, `client_info` in v2.
        for holder in ("connection", "session"):
            params = _read(getattr(request_context, holder, None), "client_params")
            info = _as_client_info(_read(params, "clientInfo", "client_info"))
            if info is not None:
                return info
    except Exception:
        return None

    return None
