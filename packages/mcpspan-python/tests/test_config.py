from __future__ import annotations

import subprocess
import sys
import textwrap
import threading

import pytest

import mcpspan
from mcpspan import _config
from mcpspan._config import is_collecting
from mcpspan._reporter import EventReporter

from .test_reporter import eventually
from .test_transport import Ingest


def delivery_threads() -> list[threading.Thread]:
    return [thread for thread in threading.enumerate() if thread.name == "mcpspan-delivery"]


def test_does_nothing_at_all_without_a_key() -> None:
    before = len(delivery_threads())
    mcpspan.configure()

    assert not is_collecting()
    assert len(delivery_threads()) == before


def test_reads_the_key_and_endpoint_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    ingest = Ingest()
    monkeypatch.setenv("MCPSPAN_API_KEY", "env-key")
    monkeypatch.setenv("MCPSPAN_ENDPOINT", ingest.url)

    mcpspan.configure()
    eventually(lambda: len(ingest.requests) == 1)

    assert ingest.requests[0]["headers"]["Authorization"] == "Bearer env-key"
    ingest.server.shutdown()


def test_the_same_settings_again_change_nothing() -> None:
    mcpspan.configure(api_key="k", endpoint="http://127.0.0.1:9")
    first = _config._reporter

    mcpspan.configure(api_key="k", endpoint="http://127.0.0.1:9")

    assert _config._reporter is first


def test_different_settings_replace_the_running_ones() -> None:
    mcpspan.configure(api_key="k", endpoint="http://127.0.0.1:9")
    first = _config._reporter

    mcpspan.configure(api_key="other", endpoint="http://127.0.0.1:9")

    assert _config._reporter is not first
    assert isinstance(_config._reporter, EventReporter)


def test_a_malformed_option_falls_back_and_never_raises(capsys: pytest.CaptureFixture[str]) -> None:
    ingest = Ingest()
    mcpspan.configure(
        api_key="k",
        endpoint=ingest.url,
        flush_interval=-1,
        max_batch_size="many",  # type: ignore[arg-type]
        debug=True,
    )

    assert is_collecting()
    captured = capsys.readouterr()
    assert "ignoring flush_interval=-1" in captured.err
    assert "ignoring max_batch_size='many'" in captured.err
    assert captured.out == ""
    eventually(lambda: len(ingest.requests) == 1)
    ingest.server.shutdown()


def test_shutdown_stops_collecting() -> None:
    mcpspan.configure(api_key="k", endpoint="http://127.0.0.1:9")
    mcpspan.shutdown()

    assert not is_collecting()


def run_script(body: str, endpoint: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(body)],
        env={"MCPSPAN_API_KEY": "k", "MCPSPAN_ENDPOINT": endpoint, "PATH": ""},
        capture_output=True,
        text=True,
        timeout=30,
    )


RECORD_AND_LEAVE = """
    import mcpspan

    mcpspan.configure(flush_interval=600{extra})
    tool = mcpspan.track("ok", lambda: "ok")
    tool()
"""


def test_sends_what_is_queued_when_the_process_ends() -> None:
    ingest = Ingest()

    finished = run_script(RECORD_AND_LEAVE.format(extra=""), ingest.url)

    assert finished.returncode == 0
    assert finished.stdout == ""
    assert [
        event["toolName"] for request in ingest.requests for event in request["body"]["events"]
    ] == ["ok"]
    ingest.server.shutdown()


def test_leaves_the_exit_alone_when_asked() -> None:
    ingest = Ingest()

    run_script(RECORD_AND_LEAVE.format(extra=", flush_on_exit=False"), ingest.url)

    assert all(request["body"]["events"] == [] for request in ingest.requests)
    ingest.server.shutdown()


def test_with_a_key_and_no_endpoint_collects_nothing_and_says_so_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mcpspan import _config

    monkeypatch.setattr(_config, "_said_no_endpoint", False)
    said: list[str] = []

    mcpspan.configure(api_key="k", on_diagnostic=said.append)
    mcpspan.configure(api_key="k", on_diagnostic=said.append)

    assert not is_collecting()
    assert said == [_config.NO_ENDPOINT]
    assert "MCPSPAN_ENDPOINT" in said[0]


def _failed_call(**settings: object) -> dict[str, object]:
    """Configures with the settings, makes one call that raises, and returns its event."""
    ingest = Ingest()
    mcpspan.configure(api_key="k", endpoint=ingest.url, **settings)  # type: ignore[arg-type]

    @mcpspan.track("run")
    def run() -> None:
        raise PermissionError("cannot read /home/me/.aws/credentials")

    with pytest.raises(PermissionError):
        run()
    mcpspan.shutdown()
    ingest.server.shutdown()

    events: list[dict[str, object]] = [
        event for request in ingest.requests for event in request["body"]["events"]
    ]
    assert len(events) == 1
    return events[0]


def test_sends_the_text_of_a_failure_by_default() -> None:
    assert _failed_call()["errorMessage"] == "cannot read /home/me/.aws/credentials"


def test_leaves_the_text_out_when_told_to_and_keeps_how_the_call_failed() -> None:
    event = _failed_call(capture_error_messages=False)

    assert event["success"] is False
    assert event["errorSource"] == "exception"
    assert event["errorType"] == "PermissionError"
    assert "errorMessage" not in event
