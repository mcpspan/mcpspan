from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from mcpspan._definition import definition_hash, definition_of, forget_listings, note_listing

SHARED = json.loads(
    (Path(__file__).parents[3] / "conformance" / "definition-hashes.json").read_text(
        encoding="utf-8"
    )
)["cases"]


@pytest.fixture(autouse=True)
def _forget() -> Any:
    yield
    forget_listings()


@pytest.mark.parametrize("case", SHARED, ids=[case["case"] for case in SHARED])
def test_fingerprints_the_shared_cases_as_every_sdk_does(case: dict[str, Any]) -> None:
    assert definition_hash(case["tool"]) == case["hash"]


def test_keeps_the_latest_listed_fingerprint_of_each_tool() -> None:
    class Listed:
        def model_dump(self, **_: Any) -> dict[str, Any]:
            return {"name": "b", "inputSchema": {"type": "object"}}

    note_listing([{"name": "a", "description": "one"}, Listed()])
    note_listing([{"name": "a", "description": "two"}, {"description": "nameless"}, object()])

    assert definition_of("a") == definition_hash({"name": "a", "description": "two"})
    assert definition_of("b") == definition_hash({"name": "b", "inputSchema": {"type": "object"}})
    assert definition_of("c") is None
