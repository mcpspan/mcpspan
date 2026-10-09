from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from mcpspan._arguments import invalid_arguments

SHARED: list[dict[str, Any]] = json.loads(
    (Path(__file__).parents[3] / "conformance" / "argument-checks.json").read_text(encoding="utf-8")
)["cases"]


@pytest.mark.parametrize("case", SHARED, ids=[case["case"] for case in SHARED])
def test_finds_the_shared_cases_as_every_sdk_does(case: dict[str, Any]) -> None:
    assert invalid_arguments(case["schema"], case["arguments"]) == case["invalid"]


def test_finds_nothing_without_a_schema() -> None:
    assert invalid_arguments(None, {"passengers": 2}) == []
