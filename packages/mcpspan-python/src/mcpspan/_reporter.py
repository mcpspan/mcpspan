from __future__ import annotations

import contextlib
import os
import random
import sys
import threading
import time
from collections.abc import Callable, Sequence

from ._failure import format_error
from ._queue import DEFAULT_MAX_QUEUE_SIZE, EventQueue
from ._transport import DEFAULT_TIMEOUT, TransportError, send_events
from ._types import ToolCallEvent

DEFAULT_FLUSH_INTERVAL = 5.0
"""Seconds a partly filled batch waits before being sent anyway."""

DEFAULT_MAX_BATCH_SIZE = 100
"""Events in a single request. Reaching it sends at once, without the interval."""

INITIAL_RETRY_DELAY = 1.0
MAX_RETRY_DELAY = 60.0


def compute_backoff(failures: int, rand: Callable[[], float] = random.random) -> float:
    """Seconds to wait after the n-th consecutive failure.

    Doubles up to a ceiling, then spreads the attempt across the second half
    of that window. Without the spread, many servers reporting to one endpoint
    all fail at the same moment and all come back at the same moment, turning
    one outage into a second one at recovery.
    """
    ceiling = min(MAX_RETRY_DELAY, INITIAL_RETRY_DELAY * 2.0 ** (failures - 1))

    return ceiling / 2 + rand() * (ceiling / 2)


Sender = Callable[[Sequence[ToolCallEvent]], None]


class EventReporter:
    """Collects events and delivers them from a background thread.

    `record` is the only method a tool call touches, and it only appends to
    memory under a lock: the tool returns without waiting on the network.

    A thread rather than a task on the server's event loop. A server may be
    synchronous, run on asyncio or on trio, or be several processes forked
    from one; a thread of our own delivers the same way under all of them and
    never competes with the server's own work for its loop. The thread is a
    daemon, so it never keeps a process alive that would otherwise exit.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        flush_interval: float = DEFAULT_FLUSH_INTERVAL,
        max_batch_size: int = DEFAULT_MAX_BATCH_SIZE,
        max_queue_size: int = DEFAULT_MAX_QUEUE_SIZE,
        timeout: float = DEFAULT_TIMEOUT,
        debug: bool = False,
        on_diagnostic: Callable[[str], object] | None = None,
        sender: Sender | None = None,
    ) -> None:
        self.endpoint = endpoint
        self._flush_interval = flush_interval
        self._max_batch_size = max_batch_size
        self._timeout = timeout
        self._debug = debug
        self._on_diagnostic = on_diagnostic
        self._send: Sender = sender or (
            lambda events: send_events(events, endpoint=endpoint, api_key=api_key, timeout=timeout)
        )

        self._queue = EventQueue(max_queue_size)
        self._init_sync()

        self._stopped = False
        self._rejected = False
        self._failures = 0
        self._next_attempt_at = 0.0
        self._reported_drops = 0
        self._pid = os.getpid()

    def _init_sync(self) -> None:
        # Guards the queue and the counters.
        self._lock = threading.Lock()
        # One delivery at a time, so the same events are never posted twice.
        self._send_lock = threading.Lock()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Starts delivery, announcing the server first (contract, 3.4)."""
        self._start_thread(announce=True)

    def record(self, event: ToolCallEvent) -> None:
        """Queues an event and returns at once."""
        if self._stopped or self._rejected:
            return

        if self._pid != os.getpid():
            self._after_fork()

        with self._lock:
            self._queue.add(event)
            full = len(self._queue) >= self._max_batch_size

        if self._thread is None:
            self._start_thread(announce=False)
        if full:
            self._wake.set()

    def stop(self) -> None:
        """Stops delivery and makes a final attempt at whatever is queued.

        Ignores any retry delay in progress: this is the last chance these
        events get. Waits for a delivery already under way rather than posting
        its events a second time.
        """
        self._stopped = True
        self._wake.set()
        self._deliver(force=True)

    def _after_fork(self) -> None:
        """Starts over in a forked child, which inherited no running thread.

        What was queued belongs to the parent, which still holds and delivers
        it; sending it from here as well would count it twice. The locks may
        have been held at the moment of the fork, so they are made anew.
        """
        self._pid = os.getpid()
        self._init_sync()
        self._queue.clear()
        self._queue.dropped = 0
        self._reported_drops = 0

    def _start_thread(self, *, announce: bool) -> None:
        if self._stopped or self._rejected:
            return

        with self._lock:
            if self._thread is not None:
                return
            self._thread = threading.Thread(
                target=self._run, args=(announce,), name="mcpspan-delivery", daemon=True
            )

        # No new threads, as when the interpreter is already shutting down.
        # Events stay queued for the final delivery at exit.
        with contextlib.suppress(RuntimeError):
            self._thread.start()

    def _run(self, announce: bool) -> None:
        try:
            if announce:
                self._announce()

            while not self._stopped and not self._rejected:
                self._wake.wait(self._flush_interval)
                self._wake.clear()
                if self._stopped:
                    return
                self._deliver(force=False)
        except Exception as error:
            # Nothing here may escape into the host, not even from a thread.
            self._log(f"mcpspan: delivery stopped ({format_error(error)})")

    def _announce(self) -> None:
        """One empty batch, once, so the dashboard knows this server started.

        It proves the key and the endpoint work before anyone calls a tool,
        and reports a wrong key at startup. Never retried.
        """
        try:
            self._send([])
        except TransportError as error:
            if error.status in (401, 403):
                self._reject(error.status)
                return
            self._log(
                f"mcpspan: could not announce this server to {self.endpoint} ({error}). "
                "Events will still be delivered once it answers."
            )
        except Exception as error:
            self._log(f"mcpspan: could not announce this server ({format_error(error)})")

    def _deliver(self, *, force: bool) -> None:
        if self._rejected:
            return
        if not force and time.monotonic() < self._next_attempt_at:
            return

        # A final delivery waits for one already under way, for as long as a
        # request can take, then goes ahead regardless.
        acquired = self._send_lock.acquire(timeout=self._timeout + 1 if force else -1)

        try:
            self._report_drops()

            while not self._rejected:
                with self._lock:
                    batch = self._queue.drain(self._max_batch_size)
                if not batch:
                    return

                try:
                    self._send(batch)
                except TransportError as error:
                    self._on_failed(batch, error)
                    return
                except Exception as error:
                    self._on_failed(batch, TransportError(format_error(error), retryable=True))
                    return

                self._failures = 0
                self._next_attempt_at = 0.0
        finally:
            if acquired:
                self._send_lock.release()

    def _report_drops(self) -> None:
        with self._lock:
            dropped = self._queue.dropped - self._reported_drops
            self._reported_drops = self._queue.dropped

        if dropped > 0:
            self._log(f"mcpspan: discarded {dropped} events, the queue was full")

    def _on_failed(self, batch: list[ToolCallEvent], error: TransportError) -> None:
        if error.status in (401, 403):
            self._reject(error.status)
            return

        if error.retryable:
            with self._lock:
                self._queue.restore(batch)
        else:
            # Resending a batch the API called malformed would be refused the
            # same way every time. Drop these and keep collecting the rest.
            self._log(f"mcpspan: dropped {len(batch)} events, rejected as {error.status}")

        self._failures += 1
        # The longer of our own backoff and what the API asked for: retrying
        # sooner than asked only earns another refusal.
        wait = max(compute_backoff(self._failures), error.retry_after or 0.0)
        self._next_attempt_at = time.monotonic() + wait
        self._log(f"mcpspan: delivery failed ({error}), attempt {self._failures}")

    def _reject(self, status: int | None) -> None:
        """Gives up on a key the endpoint refused.

        The key will be refused identically until the developer changes it
        and restarts. This warns without being asked: a silent SDK collecting
        nothing because of a mistyped key is the worst way to spend an
        afternoon.
        """
        if self._rejected:
            return

        self._rejected = True
        self._wake.set()
        with self._lock:
            self._queue.clear()
        self._warn(
            f"mcpspan: the ingest endpoint rejected the API key (HTTP {status}). "
            "Telemetry is now disabled for this process."
        )

    def _log(self, message: str) -> None:
        if self._debug:
            self._warn(message)

    def _warn(self, message: str) -> None:
        """The developer's own callback if given, otherwise standard error.

        Never standard output: on the stdio transport it carries the MCP
        protocol, and a stray line there breaks the server.
        """
        try:
            if self._on_diagnostic is not None:
                self._on_diagnostic(message)
                return
            print(message, file=sys.stderr, flush=True)
        except Exception:
            # Even reporting a problem must not become one.
            pass
