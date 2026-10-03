from __future__ import annotations

import atexit
import os
import sys
import threading
from collections.abc import Callable
from typing import Any

from ._reporter import EventReporter
from ._track import set_capture_parameter_names, set_event_sink, set_server_version

NO_ENDPOINT = (
    "mcpspan: an API key is set but no endpoint, so nothing is collected. "
    "Set MCPSPAN_ENDPOINT (or the endpoint option) to your mcpspan installation, "
    "for example http://localhost:6271."
)
"""Said when there is a key and nowhere to send: somebody meant to collect.

There is no default endpoint, since mcpspan runs wherever its user runs it,
and a default would send their data somewhere they did not choose.
"""

_lock = threading.RLock()
_reporter: EventReporter | None = None
_active: tuple[tuple[Any, ...], Callable[[str], object] | None] | None = None
_exit_hook_installed = False
_fork_hook_installed = False
_said_no_endpoint = False


def _first_non_empty(*values: str | None) -> str | None:
    for value in values:
        if value is not None and value.strip():
            return value.strip()

    return None


def _positive(name: str, value: Any, debug: bool, *, integer: bool) -> Any:
    """The value if it is usable, otherwise None and, when asked, a note why."""
    if value is None:
        return None

    kinds: tuple[type, ...] = (int,) if integer else (int, float)
    usable = isinstance(value, kinds) and not isinstance(value, bool)
    if not usable or value <= 0:
        if debug:
            expected = "a positive integer" if integer else "a positive number"
            print(f"mcpspan: ignoring {name}={value!r}, expected {expected}", file=sys.stderr)
        return None

    return value


def configure(
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    debug: bool | None = None,
    on_diagnostic: Callable[[str], object] | None = None,
    flush_on_exit: bool = True,
    flush_interval: float | None = None,
    max_batch_size: int | None = None,
    max_queue_size: int | None = None,
    capture_parameter_names: bool = False,
    server_version: str | None = None,
) -> None:
    """Starts collecting, or stops if there is nothing to collect with.

    - `api_key`: falls back to `MCPSPAN_API_KEY`. Without either the SDK
      does nothing at all, which is the normal state in development and CI.
    - `endpoint`: base URL of the ingest API; falls back to
      `MCPSPAN_ENDPOINT`. There is no default: without either, nothing is
      collected, and the SDK says so once.
    - `debug`: delivery diagnostics on standard error. `on_diagnostic`
      receives them instead, and implies `debug`.
    - `flush_on_exit`: send what is queued when the interpreter exits.
    - `flush_interval`: seconds a partly filled batch waits (default 5).
    - `max_batch_size`, `max_queue_size`: events per request (100) and held
      while delivery fails (10,000).
    - `capture_parameter_names`: record which parameters a tool was called
      with, by name and type. Off by default; values are never read.
    - `server_version`: the version to record calls under, a release or a
      commit; falls back to `MCPSPAN_SERVER_VERSION`, then to the version the
      server gives itself. The dashboard marks where each version began.

    Calling it again with the same settings changes nothing. That is the
    common case: a server built per request configures on every request, and
    starting over each time would announce the server once per request.
    Different settings replace the running configuration, sending what the
    old one held.

    Never raises. It runs during a server's startup, and a mistyped option
    must not be why a server fails to boot.
    """
    try:
        _configure(
            api_key=api_key,
            endpoint=endpoint,
            debug=debug,
            on_diagnostic=on_diagnostic,
            flush_on_exit=flush_on_exit,
            flush_interval=flush_interval,
            max_batch_size=max_batch_size,
            max_queue_size=max_queue_size,
            capture_parameter_names=capture_parameter_names,
            server_version=server_version,
        )
    except Exception as error:
        if debug:
            print(f"mcpspan: could not configure ({error})", file=sys.stderr)


def _configure(
    *,
    api_key: str | None,
    endpoint: str | None,
    debug: bool | None,
    on_diagnostic: Callable[[str], object] | None,
    flush_on_exit: bool,
    flush_interval: float | None,
    max_batch_size: int | None,
    max_queue_size: int | None,
    capture_parameter_names: bool,
    server_version: str | None,
) -> None:
    global _reporter, _active, _said_no_endpoint

    key = _first_non_empty(api_key, os.environ.get("MCPSPAN_API_KEY"))
    url = _first_non_empty(endpoint, os.environ.get("MCPSPAN_ENDPOINT"))
    version = _first_non_empty(server_version, os.environ.get("MCPSPAN_SERVER_VERSION"))
    settings = (
        key,
        url,
        debug,
        flush_on_exit,
        flush_interval,
        max_batch_size,
        max_queue_size,
        capture_parameter_names,
        version,
    )

    with _lock:
        if _reporter is not None and _active == (settings, on_diagnostic):
            return

        previous = _reporter
        _stop_collecting()
        if previous is not None:
            previous.stop()

        verbose = debug if debug is not None else on_diagnostic is not None

        # No key is a normal state, not a mistake. Saying so on every start
        # would be noise.
        if key is None:
            return

        if url is None:
            # Said unasked, as a refused key is: without it the data goes
            # nowhere and nothing tells anyone.
            if not _said_no_endpoint:
                _said_no_endpoint = True
                try:
                    if on_diagnostic is not None:
                        on_diagnostic(NO_ENDPOINT)
                    else:
                        print(NO_ENDPOINT, file=sys.stderr)
                except Exception:
                    pass
            return

        options: dict[str, Any] = {}
        interval = _positive("flush_interval", flush_interval, verbose, integer=False)
        if interval is not None:
            options["flush_interval"] = float(interval)
        batch = _positive("max_batch_size", max_batch_size, verbose, integer=True)
        if batch is not None:
            # The API takes at most 1,000 events per request.
            options["max_batch_size"] = min(batch, 1_000)
        queue = _positive("max_queue_size", max_queue_size, verbose, integer=True)
        if queue is not None:
            options["max_queue_size"] = queue

        reporter = EventReporter(
            endpoint=url,
            api_key=key,
            debug=verbose,
            on_diagnostic=on_diagnostic,
            **options,
        )
        _reporter = reporter
        _active = (settings, on_diagnostic)
        set_capture_parameter_names(capture_parameter_names)
        set_server_version(version)
        set_event_sink(reporter.record)

        if flush_on_exit:
            _install_exit_hook()
        _install_fork_hook()

        # In the background: startup does not wait for the network.
        reporter.start()


def _stop_collecting() -> None:
    global _reporter, _active
    _reporter = None
    _active = None
    set_event_sink(None)
    set_capture_parameter_names(False)
    set_server_version(None)


def shutdown() -> None:
    """Stops collecting and makes a final attempt to deliver what is queued.

    Worth calling from a server's own shutdown path. Without it, and with
    `flush_on_exit` off, the last partly filled batch dies with the process.
    Blocks for as long as that delivery takes, at most a few seconds.
    """
    try:
        with _lock:
            previous = _reporter
            _stop_collecting()
        if previous is not None:
            previous.stop()
    except Exception:
        pass


def is_collecting() -> bool:
    """Whether the SDK is currently recording tool calls."""
    return _reporter is not None


def _on_exit() -> None:
    # Only when this configuration asked for it: a later configure() may have
    # turned it off, and atexit offers no way to ask which one registered.
    active = _active
    if active is not None and active[0][3]:
        shutdown()


def _install_exit_hook() -> None:
    """Arranges one last delivery as the interpreter exits.

    atexit runs once the program's own code is done, including on the normal
    end of a stdio server when its client leaves. It does not intercept
    signals and does not change how or when the server exits.
    """
    global _exit_hook_installed
    if not _exit_hook_installed:
        atexit.register(_on_exit)
        _exit_hook_installed = True


def _install_fork_hook() -> None:
    """Keeps a forked worker (gunicorn, multiprocessing) collecting.

    A child inherits no threads. The reporter notices the new process on its
    own when the next event arrives; this only makes sure the configuration
    lock was not inherited in a held state.
    """
    global _fork_hook_installed
    if _fork_hook_installed or not hasattr(os, "register_at_fork"):
        return

    def reset_lock() -> None:
        global _lock
        _lock = threading.RLock()

    os.register_at_fork(after_in_child=reset_lock)
    _fork_hook_installed = True
