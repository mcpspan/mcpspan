from __future__ import annotations

from collections.abc import Iterator

import pytest

import mcpspan
from mcpspan._track import set_capture_parameter_names, set_event_sink
from mcpspan._types import ToolCallEvent


@pytest.fixture(autouse=True)
def _isolated(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Every test starts unconfigured, whatever the machine's environment holds."""
    monkeypatch.delenv("MCPSPAN_API_KEY", raising=False)
    monkeypatch.delenv("MCPSPAN_ENDPOINT", raising=False)
    yield
    mcpspan.shutdown()
    set_event_sink(None)
    set_capture_parameter_names(False)


@pytest.fixture
def events() -> list[ToolCallEvent]:
    """What wrapped calls record, without a reporter or a network."""
    recorded: list[ToolCallEvent] = []
    set_event_sink(recorded.append)
    return recorded
