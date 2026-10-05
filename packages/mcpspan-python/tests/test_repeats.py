from __future__ import annotations

from typing import Any

import pytest

from mcpspan._repeats import MAX_KEPT, continues_earlier_call, forget_arguments, note_arguments


@pytest.fixture(autouse=True)
def _forget() -> Any:
    yield
    forget_arguments()


def test_says_a_call_repeats_the_previous_one_whatever_the_key_order() -> None:
    assert note_arguments("s1", "search", {"to": "WAW", "n": 2}) is False
    assert note_arguments("s1", "search", {"n": 2, "to": "WAW"}) is True
    assert note_arguments("s1", "search", {"to": "KRK", "n": 2}) is False


def test_keeps_tools_and_sessions_apart_and_takes_no_arguments_as_an_empty_object() -> None:
    note_arguments("s1", "search", {"to": "WAW"})
    assert note_arguments("s1", "book", {"to": "WAW"}) is False
    assert note_arguments("s2", "search", {"to": "WAW"}) is False
    assert note_arguments("s1", "list", None) is False
    assert note_arguments("s1", "list", {}) is True


def test_never_calls_arguments_it_cannot_write_down_a_repeat() -> None:
    assert note_arguments("s1", "odd", {"n": object()}) is False
    assert note_arguments("s1", "odd", {"n": object()}) is False


def test_forgets_the_oldest_pairs_past_its_bound() -> None:
    note_arguments("first", "search", {"to": "WAW"})
    for i in range(MAX_KEPT):
        note_arguments(f"s{i}", "search", {})
    assert note_arguments("first", "search", {"to": "WAW"}) is False


def test_knows_a_retry_answering_an_interim_question() -> None:
    class Params:
        input_responses = "answered"
        request_state = None

    assert continues_earlier_call(Params()) is True
    assert continues_earlier_call({"requestState": "abc"}) is True
    assert continues_earlier_call({"arguments": {}}) is False
    assert continues_earlier_call(None) is False
