from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Sequence
from typing import cast

import pytest

from mcpspan._reporter import EventReporter, compute_backoff
from mcpspan._transport import TransportError
from mcpspan._types import ToolCallEvent


def event(index: int) -> ToolCallEvent:
    return cast(ToolCallEvent, {"id": str(index)})


def eventually(condition: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


class Sender:
    """Records every batch and answers from a script, then with success."""

    def __init__(self, *answers: Exception | None) -> None:
        self.batches: list[tuple[float, list[str]]] = []
        self.answers = list(answers)
        self.lock = threading.Lock()

    def __call__(self, events: Sequence[ToolCallEvent]) -> None:
        with self.lock:
            self.batches.append((time.monotonic(), [item["id"] for item in events]))
            answer = self.answers.pop(0) if self.answers else None
        if answer is not None:
            raise answer

    @property
    def with_events(self) -> list[list[str]]:
        return [ids for _, ids in self.batches if ids]


def reporter(sender: Sender, **options: object) -> EventReporter:
    settings: dict[str, object] = {"flush_interval": 0.05, **options}
    return EventReporter(endpoint="http://ingest", api_key="k", sender=sender, **settings)  # type: ignore[arg-type]


def test_backoff_doubles_to_a_ceiling_within_the_spread() -> None:
    assert compute_backoff(1, lambda: 0) == 0.5
    assert compute_backoff(1, lambda: 1) == 1
    assert compute_backoff(3, lambda: 1) == 4
    assert compute_backoff(30, lambda: 1) == 60


def test_announces_once_with_an_empty_batch() -> None:
    sender = Sender()
    subject = reporter(sender)
    subject.start()

    eventually(lambda: len(sender.batches) == 1)
    time.sleep(0.2)
    assert [ids for _, ids in sender.batches] == [[]]
    subject.stop()


def test_delivers_on_the_interval_without_blocking_the_caller() -> None:
    sender = Sender()
    subject = reporter(sender)
    subject.start()

    started = time.perf_counter()
    subject.record(event(1))
    assert time.perf_counter() - started < 0.01

    eventually(lambda: sender.with_events == [["1"]])
    subject.stop()


def test_a_full_batch_goes_at_once() -> None:
    sender = Sender()
    subject = reporter(sender, flush_interval=60, max_batch_size=2)
    subject.start()

    subject.record(event(1))
    subject.record(event(2))

    eventually(lambda: sender.with_events == [["1", "2"]], timeout=2)
    subject.stop()


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_key_stops_for_good_and_says_so_unasked(
    status: int, capsys: pytest.CaptureFixture[str]
) -> None:
    sender = Sender(TransportError("no", status=status, retryable=False))
    subject = reporter(sender)
    subject.start()
    # Until the refusal is handled, not only sent.
    eventually(lambda: subject._rejected)

    subject.record(event(1))
    subject.stop()

    assert len(sender.batches) == 1
    captured = capsys.readouterr()
    assert f"HTTP {status}" in captured.err
    assert captured.out == ""


def test_drops_a_malformed_batch_and_keeps_collecting() -> None:
    sender = Sender(None, TransportError("bad", status=400, retryable=False))
    subject = reporter(sender)
    subject.start()

    subject.record(event(1))
    eventually(lambda: sender.with_events == [["1"]])
    # Past the backoff that followed the refusal.
    time.sleep(1.1)
    subject.record(event(2))
    eventually(lambda: sender.with_events == [["1"], ["2"]])
    subject.stop()


def test_keeps_a_batch_through_a_passing_failure() -> None:
    sender = Sender(None, TransportError("down", status=503, retryable=True))
    subject = reporter(sender)
    subject.start()

    subject.record(event(1))
    eventually(lambda: sender.with_events == [["1"], ["1"]], timeout=3)
    subject.stop()


def test_waits_at_least_as_long_as_retry_after_asks() -> None:
    sender = Sender(None, TransportError("busy", status=429, retryable=True, retry_after=1.5))
    subject = reporter(sender)
    subject.start()

    subject.record(event(1))
    eventually(lambda: len(sender.with_events) == 2, timeout=4)
    first, second = [at for at, ids in sender.batches if ids]
    assert second - first >= 1.45
    subject.stop()


def test_stop_delivers_what_is_queued_despite_a_delay() -> None:
    sender = Sender(None, TransportError("down", status=500, retryable=True))
    subject = reporter(sender, flush_interval=60, max_batch_size=1)
    subject.start()

    subject.record(event(1))
    eventually(lambda: sender.with_events == [["1"]])
    subject.record(event(2))
    subject.stop()

    # The refused batch again, then the rest, one per request at this batch size.
    assert sender.with_events == [["1"], ["1"], ["2"]]


def test_says_nothing_about_passing_trouble_unless_asked(
    capsys: pytest.CaptureFixture[str],
) -> None:
    sender = Sender(TransportError("down", retryable=True))
    subject = reporter(sender)
    subject.start()
    eventually(lambda: len(sender.batches) == 1)
    subject.stop()

    assert capsys.readouterr() == ("", "")


def test_diagnostics_go_to_the_developer_callback() -> None:
    notes: list[str] = []
    sender = Sender(TransportError("down", retryable=True))
    subject = reporter(sender, debug=True, on_diagnostic=notes.append)
    subject.start()
    eventually(lambda: len(notes) == 1)
    subject.stop()

    assert "could not announce" in notes[0]


def test_reports_discarded_events_when_asked() -> None:
    notes: list[str] = []
    sender = Sender()
    subject = reporter(
        sender, flush_interval=60, max_queue_size=2, debug=True, on_diagnostic=notes.append
    )

    for index in range(5):
        subject.record(event(index))
    subject.stop()

    assert sender.with_events == [["3", "4"]]
    assert "discarded 3 events" in notes[0]


def test_a_forked_child_starts_over_without_the_parents_events() -> None:
    sender = Sender()
    subject = reporter(sender, flush_interval=60)
    subject.record(event(1))

    # What a fork looks like from inside: another process id, no thread.
    subject._pid = os.getpid() + 1
    subject.record(event(2))
    subject.stop()

    assert sender.with_events == [["2"]]


def test_the_delivery_thread_does_not_keep_a_process_alive() -> None:
    sender = Sender()
    subject = reporter(sender)
    subject.start()

    threads = [thread for thread in threading.enumerate() if thread.name == "mcpspan-delivery"]
    assert threads and all(thread.daemon for thread in threads)
    subject.stop()
