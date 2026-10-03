from __future__ import annotations

from collections import deque
from collections.abc import Sequence

from ._types import ToolCallEvent

DEFAULT_MAX_QUEUE_SIZE = 10_000
"""How many events are held before the oldest start being discarded.

The queue has to be bounded: if the ingest endpoint is unreachable while tools
keep being called, an unbounded one grows until the host process runs out of
memory. At ten calls per second this covers roughly seventeen minutes of
downtime, long enough to survive a backend restart.
"""


class EventQueue:
    """Events waiting to be sent, oldest first. Not thread-safe on its own."""

    def __init__(self, max_size: int = DEFAULT_MAX_QUEUE_SIZE) -> None:
        if max_size < 1:
            raise ValueError(f"max_size must be a positive integer, received {max_size}")
        self.max_size = max_size
        self.dropped = 0
        self._events: deque[ToolCallEvent] = deque()

    def __len__(self) -> int:
        return len(self._events)

    def add(self, event: ToolCallEvent) -> None:
        """Queues an event, discarding the oldest when full.

        Newest wins on purpose: once the backend comes back, a developer wants
        to see what their server is doing now, not what it did when the outage
        started.
        """
        if len(self._events) >= self.max_size:
            self._events.popleft()
            self.dropped += 1
        self._events.append(event)

    def drain(self, limit: int | None = None) -> list[ToolCallEvent]:
        """Removes and returns up to `limit` events, oldest first, or all of them."""
        count = len(self._events) if limit is None else min(limit, len(self._events))

        return [self._events.popleft() for _ in range(count)]

    def restore(self, events: Sequence[ToolCallEvent]) -> None:
        """Puts a batch that failed to deliver back in front, where it came from.

        If that overflows the queue, the oldest go as usual - which may be the
        ones just restored, since an outage long enough to fill the queue has
        already made them the least interesting events held.
        """
        self._events.extendleft(reversed(events))

        while len(self._events) > self.max_size:
            self._events.popleft()
            self.dropped += 1

    def clear(self) -> None:
        self._events.clear()
