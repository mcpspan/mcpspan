"""The README's Python samples, checked against the package.

The README is the first thing a reader runs. Each sample must parse, and
every `mcpspan.<name>` it uses must exist, so a rename that misses the
documentation fails here rather than on somebody else's machine.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import mcpspan

README = Path(__file__).resolve().parent.parent / "README.md"


def samples() -> list[str]:
    return re.findall(r"```python\n(.*?)```", README.read_text(encoding="utf-8"), re.DOTALL)


def test_there_are_samples() -> None:
    assert len(samples()) >= 5


def test_every_sample_parses_and_uses_only_what_exists() -> None:
    for sample in samples():
        tree = ast.parse(sample)
        used = {
            node.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "mcpspan"
        }
        missing = {name for name in used if not hasattr(mcpspan, name)}
        assert missing == set(), f"README uses mcpspan.{missing}"


def test_every_option_in_the_table_is_accepted() -> None:
    import inspect

    table = re.findall(r"^\| `(\w+)` \|", README.read_text(encoding="utf-8"), re.MULTILINE)
    accepted = set(inspect.signature(mcpspan.instrument).parameters) - {"server"}

    assert set(table) == accepted
    assert set(table) == set(inspect.signature(mcpspan.configure).parameters)
