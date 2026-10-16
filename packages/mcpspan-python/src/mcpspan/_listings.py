"""The listings already sent for each session, so the same answer to
`tools/list` is sent once per session (contract, 3.11). A client lists the
tools at the start of a session and often again; the count that matters is the
sessions that were shown the tools, not how often they asked.
"""

from __future__ import annotations

from collections import OrderedDict

# Sessions kept, the oldest forgotten first.
_MAX_SESSIONS = 10_000

_sent: OrderedDict[str, set[str]] = OrderedDict()


def first_listing(session_id: str | None, signature: str) -> bool:
    """Whether a listing is new for its session, noting it as sent. A listing
    with no session is always new: there is nothing to tell its repeats apart by."""
    if session_id is None:
        return True

    seen = _sent.pop(session_id, set())
    if signature in seen:
        _sent[session_id] = seen
        return False

    seen.add(signature)
    _sent[session_id] = seen
    if len(_sent) > _MAX_SESSIONS:
        _sent.popitem(last=False)
    return True


def forget_listings_sent() -> None:
    """For tests: forgets every listing sent."""
    _sent.clear()
