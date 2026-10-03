"""Handlers that instrumentation should leave alone.

Two situations land here. A handler already wrapped by `track` is marked so
that instrumenting the whole server afterwards does not count every call
twice. A handler passed through `exclude` is marked so that it is never
counted at all.

Weak sets rather than attributes on the functions: these are the developer's
own functions, and a telemetry library has no business writing onto them.
"""

from __future__ import annotations

import contextlib
import weakref
from typing import Any

_marked: weakref.WeakSet[Any] = weakref.WeakSet()
_excluded: weakref.WeakSet[Any] = weakref.WeakSet()


def _add(marks: weakref.WeakSet[Any], handler: Any) -> None:
    # A callable that cannot be weakly referenced cannot be marked. It is then
    # treated like any other handler, which is the safe side to err on.
    with contextlib.suppress(TypeError):
        marks.add(handler)


def mark_handler(handler: Any) -> None:
    """Records that this handler must not be wrapped again."""
    _add(_marked, handler)


def is_marked(handler: Any) -> bool:
    """Whether this handler is already tracked or excluded."""
    try:
        return handler in _marked
    except TypeError:
        return False


def mark_excluded(handler: Any) -> None:
    _add(_excluded, handler)
    mark_handler(handler)


def is_excluded(handler: Any) -> bool:
    try:
        return handler in _excluded
    except TypeError:
        return False
