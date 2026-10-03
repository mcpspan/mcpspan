from __future__ import annotations

from mcpspan._parameters import MAX_DESCRIBED_PARAMETERS, describe_parameters


def test_names_and_json_types_only() -> None:
    described = describe_parameters(
        {
            "destination": "secret",
            "passengers": 2,
            "price": 9.5,
            "direct": True,
            "stops": ["a"],
            "filters": {"k": "v"},
            "note": None,
        }
    )
    assert described == {
        "destination": "string",
        "passengers": "number",
        "price": "number",
        "direct": "boolean",
        "stops": "array",
        "filters": "object",
        "note": "null",
    }
    assert "secret" not in repr(described)


def test_other_types_by_their_python_name() -> None:
    assert describe_parameters({"when": b"x"}) == {"when": "bytes"}


def test_nothing_for_no_parameters_or_not_a_mapping() -> None:
    assert describe_parameters({}) is None
    assert describe_parameters(["a"]) is None
    assert describe_parameters(None) is None


def test_bounded_in_count_and_name_length() -> None:
    many = describe_parameters({f"p{index}": 1 for index in range(80)}) or {}
    assert len(many) == MAX_DESCRIBED_PARAMETERS

    long = describe_parameters({"n" * 400: 1}) or {}
    assert all(len(name) <= 200 for name in long)
