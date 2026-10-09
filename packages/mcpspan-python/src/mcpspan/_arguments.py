"""Which top-level arguments of a refused call did not match the tool's input
schema (contract, 3.10).

The server's own refusal is not read: each validation library words it
differently, and some quote the value the agent sent. The arguments are
checked here instead, against the schema the server listed, by a small set of
rules that never fail what they do not understand. Only names the schema
declares come out, so nothing the client made up, and no value, is sent.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from ._definition import canonical

# Names sent at most, per call.
_MAX_NAMES = 20


def invalid_arguments(schema: Any, arguments: Any) -> list[str]:
    """The declared names whose arguments fail the schema, sorted, at most
    twenty. Never raises."""
    try:
        if not isinstance(schema, Mapping):
            return []
        values = {} if arguments is None else arguments
        if not isinstance(values, Mapping):
            return []

        names: set[str] = set()
        required = schema.get("required")
        if isinstance(required, list):
            names.update(name for name in required if isinstance(name, str) and name not in values)
        properties = schema.get("properties")
        if isinstance(properties, Mapping):
            for name, rule in properties.items():
                if isinstance(name, str) and name in values and not _matches(rule, values[name]):
                    names.add(name)

        return sorted(names)[:_MAX_NAMES]
    except Exception:
        return []


def _matches(schema: Any, value: Any) -> bool:
    """Whether a value passes a schema under the checks the contract lists, and only those."""
    if schema is False:
        return False
    if not isinstance(schema, Mapping):
        return True

    kind = schema.get("type")
    if isinstance(kind, str) and not _is_type(kind, value):
        return False
    if (
        isinstance(kind, list)
        and all(isinstance(name, str) for name in kind)
        and not any(_is_type(name, value) for name in kind)
    ):
        return False

    allowed = schema.get("enum")
    if isinstance(allowed, list):
        sent = canonical(value)
        if not any(canonical(option) == sent for option in allowed):
            return False
    if "const" in schema and canonical(schema["const"]) != canonical(value):
        return False

    if _is_number(value):
        if _is_number(schema.get("minimum")) and value < schema["minimum"]:
            return False
        if _is_number(schema.get("maximum")) and value > schema["maximum"]:
            return False
        if _is_number(schema.get("exclusiveMinimum")) and value <= schema["exclusiveMinimum"]:
            return False
        if _is_number(schema.get("exclusiveMaximum")) and value >= schema["exclusiveMaximum"]:
            return False

    if isinstance(value, str):
        # A Python string's length is already in code points.
        if _is_number(schema.get("minLength")) and len(value) < schema["minLength"]:
            return False
        if _is_number(schema.get("maxLength")) and len(value) > schema["maxLength"]:
            return False

    if isinstance(value, list):
        if _is_number(schema.get("minItems")) and len(value) < schema["minItems"]:
            return False
        if _is_number(schema.get("maxItems")) and len(value) > schema["maxItems"]:
            return False
        items = schema.get("items")
        if (isinstance(items, (Mapping, bool))) and not all(
            _matches(items, item) for item in value
        ):
            return False

    if isinstance(value, Mapping):
        required = schema.get("required")
        if isinstance(required, list) and any(
            isinstance(name, str) and name not in value for name in required
        ):
            return False
        properties = schema.get("properties")
        if isinstance(properties, Mapping):
            for name, rule in properties.items():
                if name in value and not _matches(rule, value[name]):
                    return False

    return True


def _is_type(kind: str, value: Any) -> bool:
    if kind == "string":
        return isinstance(value, str)
    if kind == "number":
        return _is_number(value)
    if kind == "integer":
        return _is_number(value) and float(value).is_integer()
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "object":
        return isinstance(value, Mapping)
    if kind == "array":
        return isinstance(value, list)
    if kind == "null":
        return value is None
    # A type this list does not know is not checked.
    return True


def _is_number(value: Any) -> bool:
    """A JSON number: an int or a finite float, and never a bool, which Python counts as an int."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)
