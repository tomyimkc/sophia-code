# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Structured-output discipline for tool calls and belief writes (Stage D).

Reliable agentic behaviour requires that every tool call / belief-graph write be
*well-formed before it reaches dispatch*. There are two layers:

  1. **Syntactic validity (always-on, dependency-free).** A small JSON-Schema
     validator (a decidable subset of draft-07: type, required, enum, minLength,
     minItems, items, properties, additionalProperties) checks a parsed object.
     This runs in CI with no third-party packages and is the cheap first line.

  2. **Constrained decoding bridge (optional).** A GBNF grammar emitter so a
     llama.cpp / KoboldCpp tier can *guarantee* schema-valid JSON at generation
     time (MLX lacks native grammar enforcement). The bridge is best-effort and
     covers the object/enum/string fragment Sophia's schemas use.

Critically — and matching the repo's fail-closed discipline — **syntactic
validity is necessary, not sufficient**: a schema-valid object can still carry a
hallucinated value, so the gateway's semantic verifier still runs afterwards.
This module never *accepts* content; it only *rejects malformed structure early*.
"""

from __future__ import annotations

import json
from typing import Any

from agent.runtime_paths import resource_path

SCHEMA_DIR = resource_path("schemas")


# ----------------------------------------------------------------------------- #
# Schema loading
# ----------------------------------------------------------------------------- #
def load_schema(name: str) -> dict:
    """Load a bundled schema by file name (with or without .json)."""
    fname = name if name.endswith(".json") else f"{name}.schema.json"
    path = SCHEMA_DIR / fname
    if not path.exists():
        raise FileNotFoundError(f"schema not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


# ----------------------------------------------------------------------------- #
# Layer 1 — syntactic validation (dependency-free subset of JSON Schema)
# ----------------------------------------------------------------------------- #
def validate(instance: "Any", schema: dict, *, _path: str = "$") -> "list[str]":
    """Validate ``instance`` against ``schema``. Returns a list of error strings
    (empty == valid). Supports the keyword subset the Sophia schemas use."""
    errors: list = []
    t = schema.get("type")
    if t and not _type_ok(instance, t):
        errors.append(f"{_path}: expected type {t}, got {type(instance).__name__}")
        return errors  # type mismatch makes deeper checks meaningless

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{_path}: {instance!r} not in enum {schema['enum']}")

    if t == "string" and isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{_path}: string shorter than minLength {schema['minLength']}")

    if t in {"integer", "number"} and isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{_path}: number below minimum {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{_path}: number above maximum {schema['maximum']}")

    if t == "array" and isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{_path}: array shorter than minItems {schema['minItems']}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{_path}: array longer than maxItems {schema['maxItems']}")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(instance):
                errors.extend(validate(item, item_schema, _path=f"{_path}[{i}]"))

    if t == "object" and isinstance(instance, dict):
        for req in schema.get("required", []):
            if req not in instance:
                errors.append(f"{_path}: missing required property {req!r}")
        props = schema.get("properties", {})
        for key, val in instance.items():
            if key in props:
                errors.extend(validate(val, props[key], _path=f"{_path}.{key}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{_path}: additional property {key!r} not allowed")
    return errors


def is_valid(instance: "Any", schema: dict) -> bool:
    return not validate(instance, schema)


def validate_tool_call(call: "Any") -> "list[str]":
    """Validate a parsed gateway tool call against the bundled schema."""
    return validate(call, load_schema("gateway_call"))


def validate_belief_write(write: "Any") -> "list[str]":
    """Validate a parsed belief-graph write against the bundled schema."""
    return validate(write, load_schema("belief_write"))


def parse_and_validate(raw: str, schema: dict) -> "tuple[Any, list[str]]":
    """Parse ``raw`` JSON then validate. A parse failure is itself an error
    (fail-closed: malformed JSON is never silently treated as empty)."""
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, [f"$: invalid JSON ({exc})"]
    return obj, validate(obj, schema)


def _type_ok(instance: "Any", t: str) -> bool:
    return {
        "object": isinstance(instance, dict),
        "array": isinstance(instance, list),
        "string": isinstance(instance, str),
        "integer": isinstance(instance, int) and not isinstance(instance, bool),
        "number": isinstance(instance, (int, float)) and not isinstance(instance, bool),
        "boolean": isinstance(instance, bool),
        "null": instance is None,
    }.get(t, True)


# ----------------------------------------------------------------------------- #
# Layer 2 — GBNF grammar emitter (constrained-decoding bridge)
# ----------------------------------------------------------------------------- #
_GBNF_PRELUDE = (
    "ws ::= [ \\t\\n]*\n"
    "string ::= \"\\\"\" ([^\"\\\\] | \"\\\\\" .)* \"\\\"\"\n"
    "number ::= \"-\"? [0-9]+ (\".\" [0-9]+)?\n"
    "boolean ::= \"true\" | \"false\"\n"
)


def schema_to_gbnf(schema: dict, *, root: str = "root") -> str:
    """Emit a GBNF grammar that constrains generation to objects matching the
    ``required``/``properties``/``enum`` fragment of ``schema``.

    Best-effort: covers the object-of-typed-scalars-and-arrays shape Sophia uses
    for tool calls and belief writes. A llama.cpp/KoboldCpp server can load the
    returned grammar to *guarantee* well-formed JSON at decode time. For shapes
    outside the supported fragment, callers should fall back to Layer-1 validation.
    """
    rules: list = [_GBNF_PRELUDE.rstrip("\n")]
    rules.append(f"{root} ::= {_obj_rule(schema, rules)}")
    return "\n".join(rules) + "\n"


def _obj_rule(schema: dict, rules: list) -> str:
    props = schema.get("properties", {})
    required = schema.get("required", list(props.keys()))
    # Emit required properties in order, joined by a comma terminal. Deterministic
    # and simple: each member is  "key" ws ":" ws <value>  and members are
    # separated by  ws "," ws .
    members: list = []
    for key in required:
        sub = props.get(key, {})
        members.append(f'"\\"{key}\\"" ws ":" ws {_value_rule(sub)}')
    if not members:
        return '"{" ws "}"'
    body = ' ws "," ws '.join(members)
    return f'"{{" ws {body} ws "}}"'


def _value_rule(sub: dict) -> str:
    if "enum" in sub:
        opts = " | ".join(f'"\\"{v}\\""' for v in sub["enum"])
        return f"({opts})"
    t = sub.get("type")
    if t == "string":
        return "string"
    if t == "integer" or t == "number":
        return "number"
    if t == "boolean":
        return "boolean"
    if t == "array":
        item = _value_rule(sub.get("items", {"type": "string"}))
        return f'"[" ws ({item} (ws "," ws {item})*)? ws "]"'
    if t == "object":
        return '"{" ws "}"'  # opaque nested object; Layer-1 validates contents
    return "string"


__all__ = [
    "load_schema",
    "validate",
    "is_valid",
    "validate_tool_call",
    "validate_belief_write",
    "parse_and_validate",
    "schema_to_gbnf",
    "SCHEMA_DIR",
]
