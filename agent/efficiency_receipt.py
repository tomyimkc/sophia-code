"""Standalone, JSON-safe efficiency receipts and scorecards.

The module intentionally has no dependencies on the rest of Sophia.  Missing
measurements are represented as ``Unknown`` rather than silently becoming zero.
"""
from __future__ import annotations

from dataclasses import MISSING, dataclass, field, fields, is_dataclass
import json
import math
import re
from typing import Any, Iterable, Mapping


@dataclass(frozen=True)
class Unknown:
    """An explicitly unavailable measurement."""
    reason: str = "not measured"

    def as_dict(self) -> dict[str, str | None]:
        return {"status": "unknown", "value": None, "reason": self.reason}


def unknown(reason: str = "not measured") -> Unknown:
    return Unknown(reason)


Value = Any
SCHEMA_VERSION = "1.0.0"


@dataclass
class JoinIds:
    route: Value = None
    context: Value = None
    retrieval: Value = None
    model: Value = None
    tool: Value = None
    gate: Value = None
    final: Value = None
    task_id: Value = None
    claim_id: Value = None
    evidence_id: Value = None
    budget_id: Value = None
    correlation_id: Value = None
    _unknown_fields: dict[str, Value] = field(default_factory=dict, repr=False, compare=False)

    def __post_init__(self) -> None:
        _validate_fields(self, {f.name: "identifier" for f in fields(self) if not f.name.startswith("_")})


@dataclass
class ModelEfficiency:
    provider: Value = None
    model: Value = None
    attempt: Value = None
    tokenizer_estimate_tokens: Value = None
    tokenizer_actual_tokens: Value = None
    cache_read_tokens: Value = None
    cache_write_tokens: Value = None
    input_tokens: Value = None
    output_tokens: Value = None
    cost: Value = None
    latency_ms: Value = None
    retry_count: Value = None
    timeout: Value = None
    critical_path_timings: dict[str, Value] = field(default_factory=dict)
    _unknown_fields: dict[str, Value] = field(default_factory=dict, repr=False, compare=False)

    def __post_init__(self) -> None:
        _validate_fields(self)


@dataclass
class ThesisMetrics:
    claim_support: Value = None
    citation_precision: Value = None
    citation_recall: Value = None
    entailment: Value = None
    abstention: Value = None
    calibration: Value = None
    _unknown_fields: dict[str, Value] = field(default_factory=dict, repr=False, compare=False)

    def __post_init__(self) -> None:
        _validate_fields(self)


@dataclass
class BrainstormingMetrics:
    semantic_cluster_count: Value = None  # supplied by caller; never inferred here
    duplicate_rate: Value = None
    novelty_score: Value = None
    coverage_score: Value = None
    usefulness_score: Value = None
    effective_n: Value = None
    _unknown_fields: dict[str, Value] = field(default_factory=dict, repr=False, compare=False)

    def __post_init__(self) -> None:
        _validate_fields(self)


@dataclass
class EfficiencyReceipt:
    """One end-to-end observation, suitable for persistence or transport.

    ``metadata`` carries operational controls (for example memory TTL and replay
    policy) without pretending they are measured model quality or hidden reasoning.
    """
    run_id: Value = None
    correlation_id: Value = None
    join_ids: JoinIds = field(default_factory=JoinIds)
    model_efficiency: ModelEfficiency = field(default_factory=ModelEfficiency)
    thesis_metrics: ThesisMetrics = field(default_factory=ThesisMetrics)
    brainstorming_metrics: BrainstormingMetrics = field(default_factory=BrainstormingMetrics)
    swarm_id: Value = None
    metadata: dict[str, Value] = field(default_factory=dict)
    extra: dict[str, Value] = field(default_factory=dict)
    # Transport fields from newer producers are retained without becoming part
    # of this schema.  Known fields always win when the mapping is serialized.
    _unknown_transport_fields: dict[str, Value] = field(default_factory=dict, repr=False, compare=False)

    def __post_init__(self) -> None:
        _validate_fields(self)

    def to_dict(self, *, redact: bool = True) -> dict[str, Any]:
        encoded = {
            str(key): _json_safe(value, redact=redact, key=str(key), preserve_null=True)
            for key, value in sorted(self._unknown_transport_fields.items(), key=lambda item: str(item[0]))
        }
        encoded.update(_json_safe(self, redact=redact, skip_fields={"_unknown_transport_fields"}))
        encoded["schemaVersion"] = SCHEMA_VERSION
        return encoded

    def to_json(self, *, redact: bool = True, **kwargs: Any) -> str:
        kwargs.setdefault("sort_keys", True)
        return json.dumps(self.to_dict(redact=redact), **kwargs)

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "EfficiencyReceipt":
        """Build a lossless receipt from versioned JSON-like transport data.

        Both the transport camelCase names and the internal snake_case names are
        accepted.  ``null`` is retained for identifiers, while ``null`` in a
        measurement position is decoded as :class:`Unknown`.
        """
        if not isinstance(data, Mapping):
            raise TypeError("receipt data must be a mapping")
        def get(mapping: Mapping[str, Any], name: str, default: Any = None) -> Any:
            snake_present = name in mapping
            camel_name = _camel(name)
            camel_present = camel_name in mapping
            if snake_present and camel_present and mapping[name] != mapping[camel_name]:
                raise ValueError(f"conflicting aliases for {name}: {name!r} and {camel_name!r}")
            if snake_present:
                return mapping[name]
            return mapping.get(camel_name, default)

        schema_version = get(data, "schema_version", _MISSING)
        if schema_version is not _MISSING and schema_version != SCHEMA_VERSION:
            raise ValueError(f"unsupported schemaVersion: {schema_version!r}")

        def build(typ: Any, key: str) -> Any:
            raw = get(data, key, {})
            if raw is None:
                raw = {}
            if not isinstance(raw, Mapping):
                raise TypeError(f"{key} must be a mapping")
            values: dict[str, Any] = {}
            known = {f.name for f in fields(typ) if not f.name.startswith("_")}
            unknown_fields = {
                str(k): _decode(v, measurement=False)
                for k, v in raw.items()
                if str(k) not in known and str(k) not in {_camel(name) for name in known}
            }
            for f in fields(typ):
                if f.name.startswith("_"):
                    continue
                raw_value = get(raw, f.name, _MISSING)
                is_identifier = typ is JoinIds or (typ is EfficiencyReceipt and f.name in {"run_id", "correlation_id", "swarm_id"})
                if raw_value is _MISSING:
                    if f.default_factory is not MISSING:
                        values[f.name] = f.default_factory()
                    elif f.default is not MISSING and f.default is not None:
                        values[f.name] = f.default
                    else:
                        values[f.name] = Unknown()
                else:
                    measurement = _is_measurement_field(typ, f.name)
                    if typ is ModelEfficiency and f.name == "critical_path_timings":
                        if not isinstance(raw_value, Mapping):
                            raise ValueError("critical_path_timings must be a mapping")
                        values[f.name] = {
                            str(item_key): _decode(
                                item_value,
                                measurement=str(item_key) in _KNOWN_CRITICAL_PATH_TIMINGS,
                            )
                            for item_key, item_value in raw_value.items()
                        }
                    else:
                        values[f.name] = _decode(raw_value, identifier=is_identifier, measurement=measurement)
            values["_unknown_fields"] = unknown_fields
            return typ(**values)

        extra = get(data, "extra", {})
        if not isinstance(extra, Mapping):
            raise TypeError("extra must be a mapping")
        known_transport = {"schemaVersion", "schema_version", "runId", "run_id", "joinIds", "join_ids",
                           "modelEfficiency", "model_efficiency", "thesisMetrics", "thesis_metrics",
                           "brainstormingMetrics", "brainstorming_metrics", "swarmId", "swarm_id", "correlationId", "correlation_id", "metadata", "extra"}
        unknown_transport = {
            str(key): _decode(value, measurement=False)
            for key, value in data.items() if str(key) not in known_transport
        }
        return cls(
            run_id=_decode(get(data, "run_id"), identifier=True),
            correlation_id=_decode(get(data, "correlation_id"), identifier=True),
            join_ids=build(JoinIds, "join_ids"),
            model_efficiency=build(ModelEfficiency, "model_efficiency"),
            thesis_metrics=build(ThesisMetrics, "thesis_metrics"),
            brainstorming_metrics=build(BrainstormingMetrics, "brainstorming_metrics"),
            swarm_id=_decode(get(data, "swarm_id"), identifier=True),
            metadata=_decode(dict(get(data, "metadata", {}) or {}), measurement=False),
            extra=_decode(dict(extra), measurement=False),
            _unknown_transport_fields=unknown_transport,
        )


@dataclass
class EfficiencyScorecard:
    runs: int
    measured: dict[str, int]
    totals: dict[str, Value]
    means: dict[str, Value]

    def to_dict(self) -> dict[str, Any]:
        return _json_safe(self)


def aggregate(receipts: Iterable[EfficiencyReceipt]) -> EfficiencyScorecard:
    """Aggregate receipts deterministically, preserving missingness.

    Token/cost/latency/retry fields are totals; quality and rate fields are means.
    Ordering is sorted by field name, so equivalent input permutations serialize
    identically.
    """
    items = list(receipts)
    numeric: dict[str, list[float]] = {}
    total_names = {"cache_read_tokens", "cache_write_tokens", "input_tokens", "output_tokens", "cost", "latency_ms", "retry_count"}
    for receipt in items:
        groups = [("model", receipt.model_efficiency), ("thesis", receipt.thesis_metrics), ("brainstorming", receipt.brainstorming_metrics)]
        for prefix, obj in groups:
            for f in fields(obj):
                value = getattr(obj, f.name)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
                    numeric.setdefault(f"{prefix}.{f.name}", []).append(float(value))
    totals: dict[str, Value] = {}
    means: dict[str, Value] = {}
    metric_names = {
        f"model.{f.name}" for f in fields(ModelEfficiency)
        if f.name != "critical_path_timings"
    } | {f"thesis.{f.name}" for f in fields(ThesisMetrics)} | {f"brainstorming.{f.name}" for f in fields(BrainstormingMetrics)}
    measured = {name: len(numeric.get(name, [])) for name in sorted(metric_names | set(numeric))}
    for name in sorted(metric_names | set(numeric)):
        values = numeric.get(name, [])
        target = totals if name.rsplit(".", 1)[-1] in total_names else means
        if values:
            ordered = sorted(values)
            value = math.fsum(ordered) if target is totals else math.fsum(ordered) / len(ordered)
            # Normalize only an ulp-sized artifact; preserve legitimate precision.
            nearest = round(value)
            cleaned = float(nearest) if math.isclose(value, nearest, rel_tol=0.0, abs_tol=math.ulp(value) * 2) else value
            target[name] = _number(cleaned)
            if isinstance(target[name], float):
                target[name] = round(target[name], 12)
        else:
            target[name] = unknown("not measured in any run").as_dict()
    return EfficiencyScorecard(len(items), measured, totals, means)


@dataclass(frozen=True)
class SwarmNetBenefit:
    quality_delta: Value
    added_cost: Value
    added_latency_ms: Value
    latency_weight: Value
    net_benefit: Value

    def to_dict(self) -> dict[str, Any]:
        # Scorecards use internal metric names; retain those names for callers.
        return {
            f.name: _json_safe(getattr(self, f.name), preserve_null=True)
            for f in fields(self)
        }


def swarm_net_benefit(quality_delta: Value, added_cost: Value, added_latency_ms: Value, *, latency_weight: Value = 0.0) -> SwarmNetBenefit:
    """Return quality improvement per unit added cost/latency.

    ``latency_weight`` converts milliseconds into cost-equivalent units.  If any
    input is unavailable, or the denominator is non-positive, the result is
    explicitly unknown.
    """
    vals = (quality_delta, added_cost, added_latency_ms, latency_weight)
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v)) for v in vals):
        result: Value = unknown("net benefit inputs not measured")
    elif float(added_cost) < 0 or float(added_latency_ms) < 0 or float(latency_weight) < 0:
        result = unknown("cost, latency, and latency weight must be nonnegative")
    else:
        denominator = float(added_cost) + float(latency_weight) * float(added_latency_ms)
        result = _number(float(quality_delta) / denominator) if denominator > 0 else unknown("no added cost or latency")
    return SwarmNetBenefit(quality_delta, added_cost, added_latency_ms, latency_weight, result)


_SECRET_KEY = re.compile(r"(?:api[_-]?key|token|secret|password|authorization|credential)", re.I)
_SECRET_VALUE = re.compile(r"(?i)\b(?:sk-[A-Za-z0-9_-]+|bearer\s+[A-Za-z0-9._-]+)\b")
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(?P<label>\b(?:api[_-]?key|token|secret|password|authorization|credential)\b)"
    r"(?P<separator>\s*[:=]\s*)(?P<value>\"[^\"]*\"|'[^']*'|[^\s,;}]+(?:\s+[^\s,;}]+)*(?=\s*(?:[,;}]|$)))"
)


def _redact_string(value: str) -> str:
    """Redact secret-shaped values while retaining surrounding explanation."""
    value = _SECRET_ASSIGNMENT.sub(
        lambda match: f"{match.group('label')}{match.group('separator')}[REDACTED]",
        value,
    )
    return _SECRET_VALUE.sub("[REDACTED]", value)


_MISSING = object()


def _camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(part.title() for part in parts[1:])


_KNOWN_CRITICAL_PATH_TIMINGS = {
    "retrieve_ms",
    "decode_ms",
}


def _validate_fields(obj: Any, overrides: Mapping[str, str] | None = None) -> None:
    """Reject invalid built-in numeric domains; callers must use Unknown for missing values."""
    for f in fields(obj):
        name = f.name
        if name.startswith("_"):
            continue
        value = getattr(obj, name)
        if isinstance(value, Unknown) or value is None:
            continue
        domain = (overrides or {}).get(name)
        if domain == "identifier":
            if not isinstance(value, str) or not value:
                raise ValueError(f"{name} must be a nonempty string")
            continue
        if isinstance(obj, EfficiencyReceipt) and name in {"run_id", "correlation_id", "swarm_id"}:
            if not isinstance(value, str) or not value:
                raise ValueError(f"{name} must be a nonempty string")
            continue
        if isinstance(obj, ModelEfficiency):
            if name == "timeout":
                if not isinstance(value, bool):
                    raise ValueError("timeout must be boolean or Unknown")
                continue
            if name == "critical_path_timings":
                _validate_numeric_mapping(value, nonnegative=True)
                continue
            domain = "nonnegative" if name in {"attempt", "tokenizer_estimate_tokens", "tokenizer_actual_tokens", "cache_read_tokens", "cache_write_tokens", "input_tokens", "output_tokens", "cost", "latency_ms", "retry_count"} else None
        elif isinstance(obj, ThesisMetrics):
            domain = "probability"
        elif isinstance(obj, BrainstormingMetrics):
            domain = "probability" if name.endswith("_rate") or name.endswith("_score") else "nonnegative"
        if domain:
            _validate_number(value, domain, name)


def _validate_numeric_mapping(value: Mapping[str, Any], *, nonnegative: bool) -> None:
    if not isinstance(value, Mapping):
        raise ValueError("critical_path_timings must be a mapping")
    for key, item in value.items():
        if isinstance(item, Unknown) or item is None:
            continue
        # Unknown future timing payloads are intentionally opaque extensions.
        if isinstance(item, (Mapping, list, tuple)):
            continue
        _validate_number(item, "nonnegative" if nonnegative else "finite", str(key))


def _validate_number(value: Any, domain: str, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    # Non-finite measurements are preserved as explicit Unknown at transport
    # time; domain checks apply only to finite numeric observations.
    if not math.isfinite(float(value)):
        return
    number = float(value)
    if domain == "nonnegative" and number < 0:
        raise ValueError(f"{name} must be nonnegative")
    if domain == "probability" and not 0 <= number <= 1:
        raise ValueError(f"{name} must be in [0, 1]")


def _is_measurement_field(typ: Any, name: str) -> bool:
    if typ is ModelEfficiency:
        return name in {
            "attempt", "tokenizer_estimate_tokens", "tokenizer_actual_tokens",
            "cache_read_tokens", "cache_write_tokens", "input_tokens", "output_tokens",
            "cost", "latency_ms", "retry_count", "timeout",
        }
    return typ in {ThesisMetrics, BrainstormingMetrics}


def _decode(value: Any, *, identifier: bool = False, measurement: bool = False) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return Unknown("non-finite measurement") if measurement else Unknown("non-finite value")
    if value is None:
        return None if identifier or not measurement else Unknown()
    if isinstance(value, Mapping):
        if measurement and value.get("status") == "unknown":
            if identifier or value.get("value") is not None or not isinstance(value.get("reason"), str):
                raise ValueError("malformed unknown marker")
            return Unknown(value["reason"])
        return {str(k): _decode(v, measurement=measurement) for k, v in value.items()}
    if isinstance(value, list):
        return [_decode(v, measurement=measurement) for v in value]
    return value


def _json_safe(value: Any, *, redact: bool = True, key: str = "", preserve_null: bool = False, skip_fields: set[str] | None = None) -> Any:
    if isinstance(value, Unknown):
        return {
            "status": "unknown",
            "value": None,
            "reason": _redact_string(value.reason) if redact else value.reason,
        }
    if is_dataclass(value):
        result: dict[str, Any] = {}
        extensions = getattr(value, "_unknown_fields", {})
        for raw_key, raw_value in sorted(extensions.items(), key=lambda item: str(item[0])):
            item_key = str(raw_key)
            result[item_key] = (
                "[REDACTED]"
                if redact and _SECRET_KEY.search(item_key)
                else _json_safe(raw_value, redact=redact, key=item_key, preserve_null=True)
            )
        for f in fields(value):
            if skip_fields and f.name in skip_fields or f.name.startswith("_"):
                continue
            field_value = getattr(value, f.name)
            # Identifiers intentionally retain nullability; missing measurements
            # use the explicit Unknown marker instead.
            preserve_field_null = (
                isinstance(value, JoinIds)
                or isinstance(value, EfficiencyReceipt)
                or not _is_measurement_field(type(value), f.name)
            )
            encoded = _json_safe(
                field_value,
                redact=redact,
                key=f.name,
                preserve_null=preserve_field_null,
            )
            result[_camel(f.name)] = encoded
        return result
    if isinstance(value, Mapping):
        encoded: dict[str, Any] = {}
        for raw_key, raw_value in sorted(value.items(), key=lambda item: str(item[0])):
            item_key = str(raw_key)
            encoded[item_key] = (
                "[REDACTED]"
                if redact and _SECRET_KEY.search(item_key)
                else _json_safe(raw_value, redact=redact, key=item_key, preserve_null=preserve_null)
            )
        return encoded
    if isinstance(value, (list, tuple)):
        return [_json_safe(v, redact=redact, key=key, preserve_null=preserve_null) for v in value]
    if isinstance(value, set):
        return [_json_safe(v, redact=redact, key=key, preserve_null=preserve_null) for v in sorted(value, key=str)]
    if isinstance(value, str):
        return _redact_string(value) if redact else value
    if value is None:
        return None if preserve_null else Unknown().as_dict()
    if isinstance(value, float):
        return value if math.isfinite(value) else Unknown("non-finite value").as_dict()
    if isinstance(value, (bool, int, str)):
        return value
    return str(value)


def _number(value: float) -> int | float:
    return int(value) if value.is_integer() else value
