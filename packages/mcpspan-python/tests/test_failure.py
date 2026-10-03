from __future__ import annotations

from mcpspan._failure import (
    MAX_EXCEPTION_MESSAGE_LENGTH,
    MAX_RESULT_MESSAGE_LENGTH,
    describe_error_result,
    describe_exception,
    is_error_result,
    is_input_required,
    truncate,
)


class Model:
    def __init__(self, **fields: object) -> None:
        self.__dict__.update(fields)


def test_truncate_leaves_short_text_alone_and_marks_a_cut() -> None:
    assert truncate("abc", 5) == "abc"
    assert truncate("abcdefgh", 5) == "ab..."
    assert len(truncate("x" * 300, 200)) == 200


def test_reads_is_error_in_every_spelling() -> None:
    assert is_error_result({"isError": True})
    assert is_error_result(Model(isError=True))  # v1 of the MCP SDK
    assert is_error_result(Model(is_error=True))  # v2
    assert not is_error_result({"isError": False})
    assert not is_error_result("text")
    assert not is_error_result(None)


def test_joins_text_blocks_only_and_cuts_them() -> None:
    result = {
        "isError": True,
        "content": [
            {"type": "text", "text": "No flights"},
            {"type": "image", "data": "aGVsbG8="},
            Model(type="text", text="found"),
        ],
    }
    assert describe_error_result(result) == "No flights found"

    long = {"content": [{"type": "text", "text": "x" * 1000}]}
    assert len(describe_error_result(long) or "") == MAX_RESULT_MESSAGE_LENGTH


def test_no_message_without_text() -> None:
    assert describe_error_result({"content": []}) is None
    assert describe_error_result({"content": "not a list"}) is None


def test_describes_an_exception_by_class_and_message() -> None:
    class ConformanceError(Exception):
        pass

    assert describe_exception(ConformanceError("boom")) == ("ConformanceError", "boom")
    assert describe_exception(ValueError()) == ("ValueError", None)
    _, message = describe_exception(RuntimeError("m" * 1000))
    assert len(message or "") == MAX_EXCEPTION_MESSAGE_LENGTH


def test_recognises_an_interim_result() -> None:
    class InputRequiredResult:
        pass

    assert is_input_required(InputRequiredResult())
    assert is_input_required({"resultType": "input_required"})
    assert not is_input_required({"resultType": "complete"})
