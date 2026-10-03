from __future__ import annotations

from typing import cast

from mcpspan._queue import EventQueue
from mcpspan._types import ToolCallEvent


def event(index: int) -> ToolCallEvent:
    return cast(ToolCallEvent, {"id": str(index)})


def ids(events: list[ToolCallEvent]) -> list[str]:
    return [item["id"] for item in events]


def test_drops_the_oldest_when_full() -> None:
    queue = EventQueue(max_size=3)
    for index in range(5):
        queue.add(event(index))

    assert ids(queue.drain()) == ["2", "3", "4"]
    assert queue.dropped == 2


def test_drains_in_batches_oldest_first() -> None:
    queue = EventQueue()
    for index in range(5):
        queue.add(event(index))

    assert ids(queue.drain(2)) == ["0", "1"]
    assert ids(queue.drain(10)) == ["2", "3", "4"]
    assert queue.drain() == []


def test_restores_a_failed_batch_in_front_and_stays_bounded() -> None:
    queue = EventQueue(max_size=4)
    queue.add(event(3))
    queue.restore([event(0), event(1), event(2)])
    assert ids(queue.drain()) == ["0", "1", "2", "3"]

    queue.add(event(9))
    queue.restore([event(5), event(6), event(7), event(8)])
    assert ids(queue.drain()) == ["6", "7", "8", "9"]
    assert queue.dropped == 1
