"""Versioned, deterministic transport adapter for Sophia receipt schemas.

This module intentionally depends only on the standard library.  It translates
public objects into a stable wire envelope without changing their persistence
formats.
"""
from __future__ import annotations

from dataclasses import fields, is_dataclass
import json
import math
import re
from typing import Any, Mapping

SCHEMA_VERSION = 1

class ProtocolError(ValueError):
    pass

class UnknownMeasurement:
    def __init__(self, reason: str = "not measured") -> None:
        self.reason = str(reason)
    def __eq__(self, other: object) -> bool:
        return isinstance(other, UnknownMeasurement) and self.reason == other.reason
    def __repr__(self) -> str:
        return f"UnknownMeasurement({self.reason!r})"

class Unlimited:
    def __eq__(self, other: object) -> bool:
        return isinstance(other, Unlimited)
    def __repr__(self) -> str:
        return "Unlimited()"

UNKNOWN = "$unknown"
UNLIMITED = "$unlimited"
_SECRET_KEY = re.compile(r"(?:prompt|content|reasoning|assignment|secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|authorization|raw[_-]?(?:arg|result))", re.I)
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
_ASSIGNMENT = re.compile(r"(?i)\b(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|authorization)\s*[:=]\s*([^,;\s]+)")
_URL_CREDS = re.compile(r"([a-z][a-z0-9+.-]*://)[^/@\s]+@", re.I)
_URL_QUERY = re.compile(r"(?i)([?&](?:secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|authorization)=)[^&#\s]+")

_ID_FIELDS = {"runId", "requestId", "sessionId", "taskId", "claimId", "evidenceId", "budgetId"}


def unknown(reason: str = "not measured") -> dict[str, Any]:
    return {"$type": UNKNOWN, "reason": str(reason)}

def unlimited() -> dict[str, str]:
    return {"$type": UNLIMITED}


def _redact(value: Any, key: str = "") -> Any:
    if _SECRET_KEY.search(key):
        return "[REDACTED]"
    if isinstance(value, str):
        value = _BEARER.sub("Bearer [REDACTED]", value)
        value = _URL_CREDS.sub(r"\1[REDACTED]@", value)
        value = _URL_QUERY.sub(r"\1[REDACTED]", value)
        return _ASSIGNMENT.sub(r"\1=[REDACTED]", value)
    if isinstance(value, Mapping):
        return {str(k): _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_redact(v, key) for v in sorted(value, key=str)] if isinstance(value, set) else [_redact(v, key) for v in value]
    return value


def json_safe(value: Any, *, key: str = "", measurement: bool = False, redact: bool = True) -> Any:
    """Recursively convert values to strict JSON primitives."""
    if redact:
        value = _redact(value, key)
    if isinstance(value, UnknownMeasurement):
        return unknown(value.reason)
    if isinstance(value, Unlimited):
        return unlimited()
    if value is None:
        return None
    if isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        return unknown("non-finite measurement" if measurement else "non-finite value")
    if isinstance(value, Mapping):
        return {str(k): json_safe(v, key=str(k), measurement=measurement, redact=redact) for k, v in sorted(value.items(), key=lambda x: str(x[0]))}
    if isinstance(value, (list, tuple, set)):
        seq = sorted(value, key=str) if isinstance(value, set) else value
        return [json_safe(v, key=key, measurement=measurement, redact=redact) for v in seq]
    if is_dataclass(value):
        return {camel(f.name): json_safe(getattr(value, f.name), key=camel(f.name), measurement=measurement, redact=redact) for f in fields(value) if not f.name.startswith("_")}
    if hasattr(value, "value") and isinstance(value.value, (str, int, float)):
        return json_safe(value.value, key=key, measurement=measurement, redact=redact)
    if hasattr(value, "__dict__"):
        return json_safe(vars(value), key=key, measurement=measurement, redact=redact)
    return str(value)


def camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def _value(obj: Any, name: str, default: Any = None) -> Any:
    snake = name[0].lower() + re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), name[1:])
    has_c = isinstance(obj, Mapping) and name in obj
    has_s = isinstance(obj, Mapping) and snake in obj
    if has_c and has_s and obj[name] != obj[snake]:
        raise ProtocolError(f"conflicting aliases for {name}")
    if has_c: return obj[name]
    if has_s: return obj[snake]
    return getattr(obj, snake, getattr(obj, name, default))


def _ids(obj: Any) -> dict[str, Any]:
    return {name: json_safe(_value(obj, name), key=name) for name in sorted(_ID_FIELDS)}


def _public(obj: Any, omit: set[str] = set()) -> dict[str, Any]:
    raw = vars(obj) if hasattr(obj, "__dict__") else (dict(obj) if isinstance(obj, Mapping) else {})
    return {camel(str(k)): json_safe(v, key=camel(str(k))) for k, v in raw.items() if str(k) not in omit and not str(k).startswith("_")}


def task_node(value: Any) -> dict[str, Any]:
    out = _public(value)
    out.update(_ids(value))
    return out

def task_event(value: Any) -> dict[str, Any]:
    return {"event": json_safe(_value(value, "event")), "previousState": json_safe(_value(value, "previousState")), "node": task_node(_value(value, "node"))}

def task_snapshot(value: Any) -> dict[str, Any]:
    return json_safe(value)

def budget_snapshot(value: Any) -> dict[str, Any]:
    out = _public(value)
    for field in ("limits", "committed", "reserved", "remaining", "correlation"):
        v = _value(value, field)
        if v is not None:
            out[camel(field)] = json_safe(v, measurement=field in {"limits", "committed", "reserved", "remaining"})
    # None on a budget axis means unlimited, not absent.
    if isinstance(out.get("limits"), Mapping):
        out["limits"] = {k: (unlimited() if v is None else v) for k, v in out["limits"].items()}
    if isinstance(out.get("remaining"), Mapping):
        out["remaining"] = {k: (unlimited() if v is None else v) for k, v in out["remaining"].items()}
    return out

def claim(value: Any) -> dict[str, Any]:
    allowed = ("claimId", "text", "createdAt", "runId", "requestId", "taskId", "retrievalId", "modelCallId")
    return {k: json_safe(_value(value, k), key=k) for k in allowed}

def evidence(value: Any) -> dict[str, Any]:
    allowed = ("evidenceId", "claimId", "sourceUrl", "sourceId", "quote", "span", "retrievalRank", "retrievedAt", "freshness", "provenance", "relation", "verifierVerdict", "verifierScore", "verifierMethod", "conflicts", "citationCompleteness", "abstention", "evidenceHash", "runId", "taskId", "requestId", "retrievalId", "modelCallId")
    return {k: json_safe(_value(value, k), key=k, measurement=k in {"verifierScore", "citationCompleteness"}) for k in allowed}

def efficiency_receipt(value: Any) -> dict[str, Any]:
    if hasattr(value, "to_dict"):
        value = value.to_dict()
    return json_safe(value, measurement=True)


def envelope(kind: str, payload: Any, **ids: Any) -> dict[str, Any]:
    if not isinstance(kind, str) or not kind or any(not isinstance(v, (str, type(None))) for v in ids.values()):
        raise ProtocolError("invalid envelope kind or identifiers")
    bad = set(ids) - {x[0].lower() + x[1:] for x in _ID_FIELDS}
    if bad: raise ProtocolError(f"unknown envelope identifiers: {sorted(bad)}")
    body = {"schemaVersion": SCHEMA_VERSION, "kind": kind, "payload": json_safe(payload)}
    body.update({k: v for k, v in sorted(ids.items()) if v is not None})
    return body


def serialize(value: Mapping[str, Any]) -> str:
    return json.dumps(json_safe(value), allow_nan=False, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

def _reject_nonfinite_constant(value: str) -> Any:
    raise ValueError(f"non-finite JSON constant: {value}")


def deserialize(data: str | bytes) -> dict[str, Any]:
    try:
        value = json.loads(data, parse_constant=_reject_nonfinite_constant)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ProtocolError("invalid JSON") from exc
    if not isinstance(value, dict): raise ProtocolError("envelope must be an object")
    if type(value.get("schemaVersion")) is not int or value["schemaVersion"] != SCHEMA_VERSION: raise ProtocolError("unsupported schemaVersion")
    if not isinstance(value.get("kind"), str) or not value["kind"]: raise ProtocolError("invalid envelope kind")
    if "payload" not in value: raise ProtocolError("envelope payload is required")
    for key in _ID_FIELDS:
        if key in value and value[key] is not None and not isinstance(value[key], str): raise ProtocolError(f"{key} must be string or null")
    return value

__all__ = ["SCHEMA_VERSION", "ProtocolError", "UnknownMeasurement", "Unlimited", "unknown", "unlimited", "json_safe", "envelope", "serialize", "deserialize", "task_node", "task_event", "task_snapshot", "budget_snapshot", "claim", "evidence", "efficiency_receipt"]
