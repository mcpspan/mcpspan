"""Which conversation a tool call belongs to.

A single call says little; the order of them says how an agent actually uses a
server. That needs calls grouped by the connection they arrived on.

The identifier is ours, random, and made fresh for each connection. It is
deliberately not the transport's own session identifier, which travels in HTTP
headers and would let anyone holding the server's logs join our events to
them.
"""

from __future__ import annotations

import threading
import uuid
import weakref
from collections import OrderedDict
from collections.abc import Mapping
from typing import Any

MAX_SESSIONS_PER_SERVER = 1_000
"""Connections remembered per server. Past this the oldest idle one is forgotten."""

_sessions: weakref.WeakKeyDictionary[Any, OrderedDict[str, str]] = weakref.WeakKeyDictionary()
_lock = threading.Lock()


def _transport_session(request_context: Any) -> tuple[bool, str | None]:
    """Whether the request came over HTTP, and the transport session it named.

    The official MCP SDK puts the HTTP request on the request context, and
    nothing there on stdio. A transport session travels in the
    `Mcp-Session-Id` header.
    """
    request = getattr(request_context, "request", None)
    headers = getattr(request, "headers", None)

    if request is None or headers is None:
        return False, None

    value = headers.get("mcp-session-id") if isinstance(headers, Mapping) else None

    return True, value if isinstance(value, str) and value else None


def session_for(server: Any, request_context: Any) -> str | None:
    """Our identifier for the connection a request arrived on, or none.

    - Over HTTP with a transport session (the 2025 protocol, stateful): one
      identifier per transport session.
    - Over HTTP without one (a stateless endpoint, and every endpoint on the
      2026-07-28 protocol, which has no sessions): none. Each request there
      may reach a fresh server, and calling each call its own session would
      fill the session views with sessions of one call no agent had.
    - Anything else - stdio, an in-memory transport - is one connection for
      the life of the server, so the server is the session.
    """
    try:
        over_http, transport_session = _transport_session(request_context)
    except Exception:
        return None

    if over_http and transport_session is None:
        return None

    key = transport_session or ""

    try:
        with _lock:
            known = _sessions.get(server)
            if known is None:
                known = OrderedDict()
                _sessions[server] = known

            existing = known.get(key)
            if existing is not None:
                # Moved to the back, so the ones forgotten first are idle longest.
                known.move_to_end(key)
                return existing

            created = str(uuid.uuid4())
            known[key] = created
            if len(known) > MAX_SESSIONS_PER_SERVER:
                known.popitem(last=False)

            return created
    except TypeError:
        # A server that cannot be weakly referenced has nowhere to keep this.
        return None
