# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Versioned control-loop contracts shared by AGI mode and A2A execution.

The contracts expose decisions and receipts, not private chain-of-thought.
They are deliberately small enough for local models to emit reliably and
strict enough for deterministic code to enforce safety and progress gates.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping

from agent.acceptance_contract import (
    AcceptanceContract,
    AcceptanceCriterion,
    criteria_to_legacy_strings,
)

CONTROL_SCHEMA = "sophia.control-loop.v1"


class LoopRoute(str, Enum):
    AUTO = "auto"
    FAST = "fast"
    DELIBERATIVE = "deliberative"
    CRITICAL = "critical"


class CorrectionAction(str, Enum):
    CONTINUE = "continue"
    RETRY = "retry"
    REPLAN = "replan"
    ROLLBACK = "rollback"
    COMPENSATE = "compensate"
    ESCALATE = "escalate"
    PAUSE = "pause"
    ABSTAIN = "abstain"


_ACTION_CLASS_RANK = {
    "reason": 0,
    "read": 0,
    "local_mutation": 1,
    "external_mutation": 2,
}


_CRITICAL_PATTERNS = (
    r"\bdelete\b",
    r"\bdestroy\b",
    r"\berase\b",
    r"\bdrop\s+(?:the\s+)?(?:database|table|index)\b",
    r"\bdeploy\b",
    r"\brelease\b",
    r"\bpublish\b",
    r"\bpush\b",
    r"\bmerge\b",
    r"\bpurchase\b",
    r"\bpayment\b",
    r"\bcharge\b",
    r"\bcredential\b",
    r"\bsecret\b",
    r"\btoken\b",
    r"\bsend\s+(?:an?\s+)?(?:email|message)\b",
    r"\bproduction\b",
    r"\bbranch protection\b",
    r"\bchmod\b",
    r"\bchown\b",
    r"\binstall\s+(?:system|globally)\b",
)

_DELIBERATIVE_PATTERNS = (
    r"\bimplement\b",
    r"\bdebug\b",
    r"\bfix\b",
    r"\brefactor\b",
    r"\bresearch\b",
    r"\binvestigate\b",
    r"\bcompare\b",
    r"\bdesign\b",
    r"\barchitect\b",
    r"\bplan\b",
    r"\bbenchmark\b",
    r"\bmigrate\b",
    r"\btest\b",
    r"\bverify\b",
    r"\bmultiple\b",
    r"\blong[- ]?running\b",
)


def normalize_route(value: Any) -> str:
    text = str(value or LoopRoute.AUTO.value).strip().lower()
    return text if text in {item.value for item in LoopRoute} else LoopRoute.AUTO.value


def classify_route(goal: str, requested: str = LoopRoute.AUTO.value) -> tuple[str, str]:
    """Select a route with a deterministic no-downgrade safety floor."""

    requested_route = normalize_route(requested)
    normalized = " ".join(str(goal or "").lower().split())
    critical_match = next(
        (pattern for pattern in _CRITICAL_PATTERNS if re.search(pattern, normalized)),
        "",
    )
    if critical_match:
        return LoopRoute.CRITICAL.value, f"critical-pattern:{critical_match}"
    if requested_route == LoopRoute.CRITICAL.value:
        return requested_route, "operator-requested-critical"
    if requested_route == LoopRoute.DELIBERATIVE.value:
        return requested_route, "operator-requested-deliberative"
    deliberative_match = next(
        (
            pattern
            for pattern in _DELIBERATIVE_PATTERNS
            if re.search(pattern, normalized)
        ),
        "",
    )
    if deliberative_match:
        # An operator may request fast, but non-trivial work retains a
        # deliberative floor. Only the controller can make the route safer.
        return LoopRoute.DELIBERATIVE.value, (
            f"deliberative-pattern:{deliberative_match}"
        )
    if requested_route == LoopRoute.FAST.value:
        return requested_route, "operator-requested-fast"
    word_count = len(normalized.split())
    if word_count <= 24 and not any(ch in normalized for ch in ("\n", ";", "&&")):
        return LoopRoute.FAST.value, "bounded-low-complexity-input"
    return LoopRoute.DELIBERATIVE.value, "default-nontrivial-route"


def _safe_json(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        if isinstance(value, Mapping):
            return {str(key): _safe_json(item) for key, item in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_safe_json(item) for item in value]
        return str(value)


def _bounded_text(value: Any, limit: int = 2000) -> str:
    return str(value or "").strip()[:limit]


def _bounded_list(value: Any, *, maximum: int = 12, limit: int = 1000) -> list[str]:
    if not isinstance(value, list):
        return []
    return [
        _bounded_text(item, limit)
        for item in value
        if _bounded_text(item, limit)
    ][:maximum]


@dataclass(frozen=True)
class GoalContract:
    goal_id: str
    objective: str
    acceptance_criteria: tuple[str, ...]
    evidence_requirements: tuple[str, ...]
    allowed_action_classes: tuple[str, ...]
    prohibited_action_classes: tuple[str, ...]
    budgets: Mapping[str, int]
    stop_conditions: tuple[str, ...]
    route: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": CONTROL_SCHEMA,
            "goalId": self.goal_id,
            "objective": self.objective,
            "acceptanceCriteria": list(self.acceptance_criteria),
            "evidenceRequirements": list(self.evidence_requirements),
            "allowedActionClasses": list(self.allowed_action_classes),
            "prohibitedActionClasses": list(self.prohibited_action_classes),
            "budgets": dict(self.budgets),
            "stopConditions": list(self.stop_conditions),
            "route": self.route,
        }

    def to_v2_contract(self) -> AcceptanceContract:
        return AcceptanceContract(
            criteria=tuple(
                AcceptanceCriterion(
                    criterion_id=f"C{index + 1:02d}",
                    requirement=criterion,
                    mandatory=True,
                    verifier_type="semantic",
                    predicate={},
                    required_evidence=(),
                    source="explicit",
                )
                for index, criterion in enumerate(self.acceptance_criteria)
            )
        )


def make_goal_contract(
    goal: str,
    *,
    route: str,
    max_cycles: int,
    wall_clock_sec: int,
    max_steps_per_action: int,
    success_criteria: Iterable[str] = (),
) -> GoalContract:
    objective = _bounded_text(goal, 8000)
    goal_id = hashlib.sha256(objective.encode("utf-8")).hexdigest()[:24]
    criteria = tuple(item for item in (_bounded_text(v, 1000) for v in success_criteria) if item)
    if not criteria:
        criteria = ("The requested outcome is supported by inspectable evidence.",)
    return GoalContract(
        goal_id=goal_id,
        objective=objective,
        acceptance_criteria=criteria,
        evidence_requirements=(
            "Every executed action has an outcome receipt.",
            "Completion evidence is deterministic or independently verified.",
        ),
        allowed_action_classes=("read", "reason", "local_mutation", "external_mutation"),
        prohibited_action_classes=("unapproved_critical_action", "self_promotion"),
        budgets={
            "maxCycles": max(1, int(max_cycles)),
            "wallClockSec": max(1, int(wall_clock_sec)),
            "maxStepsPerAction": max(1, int(max_steps_per_action)),
        },
        stop_conditions=(
            "goal_verified",
            "operator_stop",
            "authorization_required",
            "budget_exhausted",
            "repeated_no_progress",
            "unsafe_or_unachievable",
        ),
        route=normalize_route(route),
    )


def goal_contract_v2_from_legacy(
    contract: GoalContract | Mapping[str, Any],
) -> AcceptanceContract:
    """Migrate a v1 GoalContract without changing its acceptance strings."""
    if isinstance(contract, GoalContract):
        return contract.to_v2_contract()
    return AcceptanceContract.from_mapping(contract)


@dataclass(frozen=True)
class ExpectedObservation:
    observation_id: str
    description: str
    comparator: str = "semantic"
    target: Any = None
    evidence_source: str = "observer"
    required: bool = True
    confidence: float = 0.5

    @classmethod
    def from_mapping(
        cls, value: Mapping[str, Any], index: int
    ) -> "ExpectedObservation":
        comparator = _bounded_text(value.get("comparator") or "semantic", 80).lower()
        return cls(
            observation_id=_bounded_text(
                value.get("id") or f"expectation-{index + 1}", 100
            ),
            description=_bounded_text(
                value.get("description")
                or value.get("expectation")
                or value.get("target")
                or "expected outcome",
                1000,
            ),
            comparator=comparator,
            target=_safe_json(value.get("target")),
            evidence_source=_bounded_text(
                value.get("evidenceSource") or value.get("evidence_source") or "observer",
                200,
            ),
            required=value.get("required") is not False,
            confidence=_clamp01(value.get("confidence"), fallback=0.5),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.observation_id,
            "description": self.description,
            "comparator": self.comparator,
            "target": _safe_json(self.target),
            "evidenceSource": self.evidence_source,
            "required": self.required,
            "confidence": self.confidence,
        }


@dataclass(frozen=True)
class ActionContract:
    action_id: str
    goal_id: str
    strategy_id: str
    title: str
    action: str
    action_class: str
    route: str
    preconditions: tuple[str, ...]
    expected_observations: tuple[ExpectedObservation, ...]
    risk: float
    reversibility: float
    uncertainty: float
    idempotency_key: str
    rollback: str
    compensation: str
    authorization_required: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": CONTROL_SCHEMA,
            "actionId": self.action_id,
            "goalId": self.goal_id,
            "strategyId": self.strategy_id,
            "title": self.title,
            "action": self.action,
            "actionClass": self.action_class,
            "route": self.route,
            "preconditions": list(self.preconditions),
            "expectedObservations": [
                expectation.to_dict() for expectation in self.expected_observations
            ],
            "risk": self.risk,
            "reversibility": self.reversibility,
            "uncertainty": self.uncertainty,
            "idempotencyKey": self.idempotency_key,
            "rollback": self.rollback,
            "compensation": self.compensation,
            "authorizationRequired": self.authorization_required,
        }


def infer_action_class(action: str) -> str:
    normalized = " ".join(str(action or "").lower().split())
    if any(re.search(pattern, normalized) for pattern in _CRITICAL_PATTERNS):
        return "external_mutation"
    if re.search(
        r"\b(write|edit|create|update|patch|modify|refactor|implement|fix)\b",
        normalized,
    ):
        return "local_mutation"
    if re.search(r"\b(read|inspect|search|query|check|list|compare|analy[sz]e)\b", normalized):
        return "read"
    return "reason"


def normalize_action_class(declared: Any, action: str) -> str:
    """Apply a deterministic no-downgrade floor to a model-declared class."""

    inferred = infer_action_class(action)
    normalized = _bounded_text(declared, 80).lower()
    if normalized not in _ACTION_CLASS_RANK:
        return inferred
    if _ACTION_CLASS_RANK[inferred] > _ACTION_CLASS_RANK[normalized]:
        return inferred
    return normalized


def action_risk_floor(action_class: str) -> float:
    """Return the minimum planning risk for a deterministically classified action."""

    if action_class == "external_mutation":
        return 0.75
    if action_class == "local_mutation":
        return 0.25
    return 0.0


def make_action_contract(
    *,
    run_id: str,
    cycle: int,
    goal_contract: GoalContract,
    strategy: Mapping[str, Any],
) -> ActionContract:
    strategy_id = _bounded_text(strategy.get("id") or f"strategy-{cycle}", 100)
    action = _bounded_text(
        strategy.get("nextAction") or strategy.get("next_action"), 4000
    )
    action_id = f"{run_id}:c{cycle}:{strategy_id}"
    expected_raw = strategy.get("expectedObservations")
    expected = tuple(
        ExpectedObservation.from_mapping(item, index)
        for index, item in enumerate(expected_raw if isinstance(expected_raw, list) else [])
        if isinstance(item, Mapping)
    )
    if not expected:
        prediction = _bounded_text(strategy.get("prediction"), 1500)
        expected = (
            ExpectedObservation(
                observation_id="reported-outcome",
                description=prediction or "The bounded action reports an observable outcome.",
                comparator="semantic",
                target=prediction or None,
                evidence_source="observer",
                required=True,
                confidence=0.5,
            ),
        )
    route = normalize_route(goal_contract.route)
    action_class = normalize_action_class(strategy.get("actionClass"), action)
    authorization_required = (
        route == LoopRoute.CRITICAL.value or action_class == "external_mutation"
    )
    idempotency_key = hashlib.sha256(action_id.encode("utf-8")).hexdigest()[:32]
    return ActionContract(
        action_id=action_id,
        goal_id=goal_contract.goal_id,
        strategy_id=strategy_id,
        title=_bounded_text(strategy.get("title"), 240),
        action=action,
        action_class=action_class,
        route=route,
        preconditions=tuple(_bounded_list(strategy.get("preconditions"), maximum=8)),
        expected_observations=expected,
        risk=max(
            _clamp01(strategy.get("risk")),
            action_risk_floor(action_class),
        ),
        reversibility=_clamp01(strategy.get("reversibility")),
        uncertainty=_clamp01(strategy.get("uncertainty")),
        idempotency_key=idempotency_key,
        rollback=_bounded_text(strategy.get("rollback"), 2000),
        compensation=_bounded_text(strategy.get("compensation"), 2000),
        authorization_required=authorization_required,
    )


@dataclass(frozen=True)
class DiscrepancyItem:
    observation_id: str
    status: str
    magnitude: float
    confidence: float
    evidence_level: str
    required: bool
    expected: Any
    actual: Any
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "observationId": self.observation_id,
            "status": self.status,
            "magnitude": self.magnitude,
            "confidence": self.confidence,
            "evidenceLevel": self.evidence_level,
            "required": self.required,
            "expected": _safe_json(self.expected),
            "actual": _safe_json(self.actual),
            "detail": self.detail,
        }


@dataclass(frozen=True)
class DiscrepancyVector:
    action_id: str
    items: tuple[DiscrepancyItem, ...]

    @property
    def has_failures(self) -> bool:
        return any(item.required and item.status == "fail" for item in self.items)

    @property
    def has_unknowns(self) -> bool:
        return any(item.required and item.status == "unknown" for item in self.items)

    @property
    def deterministic_progress(self) -> bool:
        return (
            self.all_required_passed
            and any(
                item.required
                and item.status == "pass"
                and item.evidence_level == "deterministic"
                for item in self.items
            )
        )

    @property
    def all_required_passed(self) -> bool:
        required = [item for item in self.items if item.required]
        return bool(required) and all(item.status == "pass" for item in required)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": CONTROL_SCHEMA,
            "actionId": self.action_id,
            "items": [item.to_dict() for item in self.items],
            "hasFailures": self.has_failures,
            "hasUnknowns": self.has_unknowns,
            "hasAnyFailures": any(item.status == "fail" for item in self.items),
            "hasAnyUnknowns": any(item.status == "unknown" for item in self.items),
            "deterministicProgress": self.deterministic_progress,
            "allRequiredPassed": self.all_required_passed,
        }


def _clamp01(value: Any, *, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(number) or math.isinf(number):
        return fallback
    return max(0.0, min(1.0, number))


def _compare(comparator: str, target: Any, actual: Any) -> tuple[str, float]:
    if actual is None:
        return "unknown", 1.0
    if comparator in {"bool", "boolean", "equals", "eq"}:
        passed = actual == target
        return ("pass", 0.0) if passed else ("fail", 1.0)
    if comparator == "contains":
        passed = str(target) in str(actual)
        return ("pass", 0.0) if passed else ("fail", 1.0)
    if comparator == "nonempty":
        passed = bool(str(actual).strip())
        return ("pass", 0.0) if passed else ("fail", 1.0)
    if comparator in {"numeric_gte", "gte"}:
        try:
            expected_num, actual_num = float(target), float(actual)
        except (TypeError, ValueError):
            return "unknown", 1.0
        if actual_num >= expected_num:
            return "pass", 0.0
        scale = max(abs(expected_num), 1.0)
        return "fail", min(1.0, abs(expected_num - actual_num) / scale)
    if comparator in {"numeric_lte", "lte"}:
        try:
            expected_num, actual_num = float(target), float(actual)
        except (TypeError, ValueError):
            return "unknown", 1.0
        if actual_num <= expected_num:
            return "pass", 0.0
        scale = max(abs(expected_num), 1.0)
        return "fail", min(1.0, abs(actual_num - expected_num) / scale)
    if comparator in {"exit_code", "zero_exit"}:
        try:
            passed = int(actual) == int(target if target is not None else 0)
        except (TypeError, ValueError):
            return "unknown", 1.0
        return ("pass", 0.0) if passed else ("fail", 1.0)
    return "unknown", 1.0


def _normalize_tool_name(value: Any) -> str:
    text = str(value or "").strip().lower().strip("`'\"<>[]{}")
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", text)).strip("_")


def _matching_tool_steps(
    requested: str,
    steps: Iterable[Mapping[str, Any]],
) -> tuple[list[Mapping[str, Any]], str]:
    requested_name = _normalize_tool_name(requested)
    if not requested_name:
        return [], "empty tool receipt name"
    rows = [
        (step, _normalize_tool_name(step.get("tool") or step.get("name")))
        for step in steps
    ]
    exact = [step for step, name in rows if name == requested_name]
    if exact:
        return exact, requested_name

    # Models occasionally copy the schema placeholder literally (``tool:<read>``)
    # or use a generic operation family instead of the concrete runtime name
    # (``read`` versus ``read_file``). Accept that alias only when it resolves to
    # one unambiguous concrete tool name; never guess between multiple tools.
    aliases = [
        (step, name)
        for step, name in rows
        if requested_name in name.split("_")
    ]
    concrete_names = {name for _, name in aliases if name}
    if len(concrete_names) == 1:
        return [step for step, _ in aliases], next(iter(concrete_names))
    if len(concrete_names) > 1:
        return [], (
            f"ambiguous tool alias {requested_name}: "
            + ", ".join(sorted(concrete_names))
        )
    return [], f"no receipt for tool {requested_name}"


def _observer_scalar_is_grounded(candidate: Any, receipt: Any) -> bool:
    """Return whether a normalized observer value occurs in a tool receipt.

    The observer may extract a scalar from a larger deterministic receipt, but
    it may not create evidence. This check deliberately accepts only scalar
    values and requires a literal receipt match before the extracted value is
    eligible for a deterministic comparator.
    """

    if candidate is None or isinstance(candidate, (Mapping, list, tuple, set)):
        return False
    if receipt == candidate:
        return True
    if receipt is None:
        return False
    if isinstance(candidate, bool):
        needle = "true" if candidate else "false"
    else:
        needle = str(candidate).strip()
    if not needle:
        return False
    haystack = (
        json.dumps(_safe_json(receipt), ensure_ascii=False)
        if not isinstance(receipt, str)
        else receipt
    )
    return bool(
        re.search(
            rf"(?<![\w.+-]){re.escape(needle)}(?![\w.+-])",
            haystack,
        )
    )


def _receipt_for_source(
    source: str,
    *,
    action_ok: bool,
    steps: Iterable[Mapping[str, Any]],
    observer_checks: Mapping[str, Mapping[str, Any]],
    observation_id: str,
) -> tuple[Any, str, str]:
    normalized = str(source or "observer").strip()
    if normalized in {"action", "action.ok"}:
        return bool(action_ok), "deterministic", "worker action status"
    if normalized.startswith("tool:"):
        requested = normalized.split(":", 1)[1]
        matches, resolved = _matching_tool_steps(requested, steps)
        if not matches:
            return None, "deterministic", resolved
        step = matches[-1]
        if "exitCode" in step:
            return step.get("exitCode"), "deterministic", f"tool receipt {resolved}"
        if "exit_code" in step:
            return step.get("exit_code"), "deterministic", f"tool receipt {resolved}"
        if "output" in step:
            return step.get("output"), "deterministic", f"tool receipt {resolved}"
        return bool(step.get("ok")), "deterministic", f"tool receipt {resolved}"
    check = observer_checks.get(observation_id)
    if check:
        return check.get("actual"), "semantic", _bounded_text(
            check.get("evidence") or "observer-reported check", 500
        )
    return None, "semantic", "observer did not report a matching check"


def compute_discrepancy_vector(
    action: ActionContract,
    *,
    observation: Mapping[str, Any],
    action_ok: bool,
    steps: Iterable[Mapping[str, Any]],
) -> DiscrepancyVector:
    checks_raw = observation.get("checks")
    checks = {
        _bounded_text(item.get("id"), 100): item
        for item in (checks_raw if isinstance(checks_raw, list) else [])
        if isinstance(item, Mapping) and _bounded_text(item.get("id"), 100)
    }
    items: list[DiscrepancyItem] = []
    step_list = list(steps)
    for expected in action.expected_observations:
        actual, evidence_level, evidence_detail = _receipt_for_source(
            expected.evidence_source,
            action_ok=action_ok,
            steps=step_list,
            observer_checks=checks,
            observation_id=expected.observation_id,
        )
        status, magnitude = _compare(expected.comparator, expected.target, actual)
        if (
            expected.evidence_source.startswith("tool:")
            and expected.comparator != "semantic"
            and status != "pass"
        ):
            check = checks.get(expected.observation_id)
            extracted = check.get("actual") if check else None
            extracted_status, extracted_magnitude = _compare(
                expected.comparator,
                expected.target,
                extracted,
            )
            if (
                extracted_status == "pass"
                and _observer_scalar_is_grounded(extracted, actual)
            ):
                actual = extracted
                status = extracted_status
                magnitude = extracted_magnitude
                evidence_detail = (
                    f"{evidence_detail}; observer scalar extraction grounded "
                    "in deterministic receipt"
                )
        if expected.comparator == "semantic":
            check = checks.get(expected.observation_id)
            check_status = _bounded_text(check.get("status") if check else "", 20).lower()
            status = check_status if check_status in {"pass", "fail", "unknown"} else "unknown"
            magnitude = 0.0 if status == "pass" else 1.0
        items.append(
            DiscrepancyItem(
                observation_id=expected.observation_id,
                status=status,
                magnitude=magnitude,
                confidence=expected.confidence,
                evidence_level=evidence_level,
                required=expected.required,
                expected=expected.target,
                actual=actual,
                detail=evidence_detail,
            )
        )
    return DiscrepancyVector(action_id=action.action_id, items=tuple(items))


def choose_correction(
    vector: DiscrepancyVector,
    *,
    action_ok: bool,
    route: str,
    rollback: str = "",
    compensation: str = "",
) -> CorrectionAction:
    if not action_ok:
        return CorrectionAction.RETRY if normalize_route(route) == LoopRoute.FAST.value else CorrectionAction.REPLAN
    if vector.has_failures:
        if rollback:
            return CorrectionAction.ROLLBACK
        if compensation:
            return CorrectionAction.COMPENSATE
        return CorrectionAction.REPLAN
    if vector.has_unknowns:
        return CorrectionAction.ESCALATE if normalize_route(route) == LoopRoute.CRITICAL.value else CorrectionAction.REPLAN
    return CorrectionAction.CONTINUE


__all__ = [
    "ActionContract",
    "CONTROL_SCHEMA",
    "CorrectionAction",
    "DiscrepancyItem",
    "DiscrepancyVector",
    "ExpectedObservation",
    "GoalContract",
    "LoopRoute",
    "choose_correction",
    "classify_route",
    "compute_discrepancy_vector",
    "action_risk_floor",
    "infer_action_class",
    "make_action_contract",
    "make_goal_contract",
    "normalize_action_class",
    "normalize_route",
]
