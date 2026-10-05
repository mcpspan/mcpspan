"""Whether a call repeats the previous call to the same tool in the same
session (contract, 3.9): an agent stuck in a loop.

Only the answer leaves the process. Kept here is a SHA-256 of the canonical
arguments of the latest call per session and tool, never sent: a digest of a
short identifier or an enumerated value is found by trying every one.
"""

from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from typing import Any

from ._definition import canonical

MAX_KEPT = 10_000
"""Session and tool pairs kept, the oldest forgotten first."""

_latest: OrderedDict[tuple[str, str], str] = OrderedDict()
_lock = threading.Lock()


def note_arguments(session_id: str, tool_name: str, arguments: Any) -> bool:
    """Notes a call's arguments, as the client sent them, and says whether they
    are the previous call's to the same tool in the same session. Never raises:
    arguments that cannot be written down are never a repeat."""
    try:
        digest = hashlib.sha256(
            canonical({} if arguments is None else arguments).encode("utf-8")
        ).hexdigest()
    except Exception:
        return False

    key = (session_id, tool_name)
    with _lock:
        previous = _latest.pop(key, None)
        _latest[key] = digest
        if len(_latest) > MAX_KEPT:
            _latest.popitem(last=False)
    return previous == digest


def continues_earlier_call(source: Any) -> bool:
    """Whether a call answers an interim result's question (2026-07-28): it then
    continues that call, and is neither compared nor kept."""
    for name in ("input_responses", "request_state", "inputResponses", "requestState"):
        try:
            value = source.get(name) if isinstance(source, dict) else getattr(source, name, None)
        except Exception:
            value = None
        if value is not None:
            return True
    return False


def forget_arguments() -> None:
    """For tests: forgets every call."""
    with _lock:
        _latest.clear()
