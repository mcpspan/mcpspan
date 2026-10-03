from __future__ import annotations

import asyncio
import inspect
from typing import Any

import pytest

import mcpspan
from mcpspan._call import CallState, current_call
from mcpspan._client import ClientInfo
from mcpspan._track import set_capture_parameter_names, set_event_sink
from mcpspan._types import ToolCallEvent
from mcpspan._version import SDK_VERSION


def only(events: list[ToolCallEvent]) -> ToolCallEvent:
    assert len(events) == 1
    return events[0]


class ConformanceError(Exception):
    pass


def test_returns_what_the_function_returned(events: list[ToolCallEvent]) -> None:
    def plus(a: int, b: int) -> int:
        return a + b

    add = mcpspan.track("add", plus)

    assert add(2, 3) == 5
    event = only(events)
    assert event["toolName"] == "add"
    assert event["success"] is True
    assert "errorSource" not in event
    assert event["sdkVersion"] == SDK_VERSION
    assert event["clientType"] == "unknown"
    assert "sessionId" not in event
    assert event["timestamp"].endswith("Z")


def test_keeps_the_signature_name_and_docstring() -> None:
    def search(destination: str, passengers: int = 1) -> str:
        """Finds flights."""
        return destination

    tracked = mcpspan.track("search", search)

    assert tracked.__name__ == "search"
    assert tracked.__doc__ == "Finds flights."
    assert inspect.signature(tracked) == inspect.signature(search)


def test_works_as_a_decorator(events: list[ToolCallEvent]) -> None:
    @mcpspan.track("ping")
    def ping() -> str:
        return "pong"

    assert ping() == "pong"
    assert only(events)["toolName"] == "ping"


def test_records_a_raised_error_and_raises_it_unchanged(events: list[ToolCallEvent]) -> None:
    error = ConformanceError("boom")

    def fail() -> None:
        raise error

    with pytest.raises(ConformanceError) as raised:
        mcpspan.track("fail", fail)()

    assert raised.value is error
    assert only(events) | {} == {
        **only(events),
        "success": False,
        "errorSource": "exception",
        "errorType": "ConformanceError",
        "errorMessage": "boom",
    }


def test_records_a_result_marked_is_error(events: list[ToolCallEvent]) -> None:
    result = {"content": [{"type": "text", "text": "No flights found"}], "isError": True}

    assert mcpspan.track("search", lambda: result)() is result
    event = only(events)
    assert event["success"] is False
    assert event["errorSource"] == "result"
    assert event["errorMessage"] == "No flights found"


def test_measures_an_async_function_when_it_settles(events: list[ToolCallEvent]) -> None:
    async def slow() -> str:
        await asyncio.sleep(0.05)
        return "done"

    tracked = mcpspan.track("slow", slow)

    assert inspect.iscoroutinefunction(tracked)
    assert asyncio.run(tracked()) == "done"
    assert only(events)["durationMs"] >= 45


def test_records_an_async_error(events: list[ToolCallEvent]) -> None:
    async def fail() -> None:
        raise ValueError("nope")

    with pytest.raises(ValueError):
        asyncio.run(mcpspan.track("fail", fail)())

    assert only(events)["errorType"] == "ValueError"


def test_waits_for_what_a_plain_function_hands_back_to_await(events: list[ToolCallEvent]) -> None:
    async def later() -> str:
        return "done"

    def hand_back() -> Any:
        return later()

    tracked = mcpspan.track("later", hand_back)

    assert asyncio.run(tracked()) == "done"
    assert only(events)["success"] is True


def test_does_not_count_an_interim_answer(events: list[ToolCallEvent]) -> None:
    mcpspan.track("ask", lambda: {"resultType": "input_required"})()

    assert events == []


def test_costs_nothing_and_records_nothing_unconfigured() -> None:
    set_event_sink(None)

    assert mcpspan.track("ok", lambda: "ok")() == "ok"


def test_tracking_twice_counts_once(events: list[ToolCallEvent]) -> None:
    def ok() -> str:
        return "ok"

    tracked = mcpspan.track("ok", ok)

    assert mcpspan.track("ok", tracked) is tracked
    tracked()
    assert len(events) == 1


def test_exclude_returns_the_function_as_given() -> None:
    def health() -> str:
        return "ok"

    assert mcpspan.exclude(health) is health


def test_cuts_a_long_tool_name(events: list[ToolCallEvent]) -> None:
    mcpspan.track("n" * 300, lambda: None)()

    assert len(only(events)["toolName"]) == 200


def test_records_parameter_names_and_types_only_when_asked(events: list[ToolCallEvent]) -> None:
    def book(destination: str, passengers: int) -> str:
        return "ok"

    tracked = mcpspan.track("book", book)
    tracked(destination="secret", passengers=2)
    set_capture_parameter_names(True)
    tracked(destination="secret", passengers=2)

    assert "parameters" not in events[0]
    assert events[1]["parameters"] == {"destination": "string", "passengers": "number"}
    assert "secret" not in repr(events)


def test_takes_the_session_client_and_arguments_of_the_call(events: list[ToolCallEvent]) -> None:
    call = CallState(session_id="s-1", client=ClientInfo("cursor", "1"), arguments={"q": "x"})
    set_capture_parameter_names(True)

    def search(**_: str) -> str:
        return "ok"

    tracked = mcpspan.track("search", search)

    token = current_call.set(call)
    try:
        tracked(q="converted")
    finally:
        current_call.reset(token)

    event = only(events)
    assert event["sessionId"] == "s-1"
    assert event["clientType"] == "cursor"
    assert event["clientName"] == "cursor"
    assert event["parameters"] == {"q": "string"}
    assert call.reached


def test_keeps_the_client_of_an_async_call_that_finishes_after_another_starts(
    events: list[ToolCallEvent],
) -> None:
    async def slow() -> str:
        await asyncio.sleep(0.05)
        return "ok"

    tracked_slow = mcpspan.track("search", slow)
    tracked_fast = mcpspan.track("book", lambda: "ok")

    async def as_client(name: str, run: Any) -> Any:
        current_call.set(CallState(session_id=None, client=ClientInfo(name, None), arguments=None))
        result = run()
        return await result if inspect.isawaitable(result) else result

    async def both() -> None:
        await asyncio.gather(
            as_client("cursor", tracked_slow), as_client("claude-code", tracked_fast)
        )

    asyncio.run(both())

    assert [(event["toolName"], event["clientType"]) for event in events] == [
        ("book", "claude-code"),
        ("search", "cursor"),
    ]


def test_a_failing_sink_never_reaches_the_tool() -> None:
    def broken(event: ToolCallEvent) -> None:
        raise RuntimeError("sink")

    set_event_sink(broken)

    assert mcpspan.track("ok", lambda: "ok")() == "ok"


def test_a_result_that_raises_when_read_still_goes_back(events: list[ToolCallEvent]) -> None:
    class Hostile:
        def __getattr__(self, name: str) -> Any:
            raise RuntimeError("do not touch")

    hostile = Hostile()

    assert mcpspan.track("odd", lambda: hostile)() is hostile


def test_an_exception_that_cannot_be_printed_is_still_raised(events: list[ToolCallEvent]) -> None:
    class Unprintable(Exception):
        def __str__(self) -> str:
            raise RuntimeError("no")

    def fail() -> None:
        raise Unprintable

    with pytest.raises(Unprintable):
        mcpspan.track("fail", fail)()
