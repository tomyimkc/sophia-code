# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Deterministic completion authority for AGI Mode and A2A.

Models may propose answers, evidence, and success language. This module decides
whether a run is complete, whether it may be resumed, and whether a required
completion marker may appear in the operator-facing text.

candidateOnly: true
canClaimAGI: false
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from agent.acceptance_contract import (
    AcceptanceCriterion,
    CriterionStatus,
)

SCHEMA = "sophia.completion_gate.v1"

COMPLETION_MARKERS = (
    "GROUNDING_COMPLETE",
    "AUDIT_COMPLETE",
    "TASK_COMPLETE",
    "RESUME_AUDIT_COMPLETE",
    "RECONCILED_REVIEW_COMPLETE",
    "SOLO_REVIEW_COMPLETE",
    "ATTRIBUTION_CHECK_COMPLETE",
    "ONTOLOGY_BOUNDARY_COMPLETE",
    "IDENTITY_CHECK_COMPLETE",
    "STATEFUL_TOOL_FLOW_COMPLETE",
    "PROVIDER_WAIT_AUDIT_COMPLETE",
    "PERMISSION_PATH_COMPLETE",
)

PATH_LINE_RE = re.compile(
    r"(?<![A-Za-z0-9_/])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)"
    r"(?::(\d+)\b|\s+(\d+):(\d+))"
)

_MARKER_LINE_RE = re.compile(
    r"^\s*(?:" + "|".join(re.escape(marker) for marker in COMPLETION_MARKERS) + r")\s*$",
    re.MULTILINE,
)

_MANDATORY_LINE_RE = re.compile(r"(?im)^\s*mandatory\s*:\s*(.+?)\s*$")

DETERMINISTIC_CONTRACT_SCHEMA = "sophia.deterministic_acceptance.v1"

_OUTPUT_CHECK_TYPES = {
    "contains",
    "contains_any",
    "exact_text",
    "line_count",
    "not_contains",
    "regex",
}
_TOOL_CHECK_TYPES = {
    "duplicate_tool_calls_at_most",
    "tool_at_least",
    "tool_at_most",
    "tool_exact",
}
_SUPPORTED_DETERMINISTIC_CHECK_TYPES = {
    *_OUTPUT_CHECK_TYPES,
    *_TOOL_CHECK_TYPES,
    "files_touched_subset",
    "route_equals",
    "route_in",
}


@dataclass(frozen=True)
class CompletionDecision:
    ok: bool
    incomplete: bool
    resumable: bool
    orchestration_status: str
    task_status: str
    verification_status: str
    reason: str
    missing: tuple[str, ...]
    candidateOnly: bool = True
    canClaimAGI: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "candidateOnly": self.candidateOnly,
            "canClaimAGI": self.canClaimAGI,
            "ok": self.ok,
            "incomplete": self.incomplete,
            "resumable": self.resumable,
            "orchestrationStatus": self.orchestration_status,
            "taskStatus": self.task_status,
            "verificationStatus": self.verification_status,
            "reason": self.reason,
            "missing": list(self.missing),
        }


def required_markers(prompt: str) -> tuple[str, ...]:
    text = str(prompt or "")
    return tuple(marker for marker in COMPLETION_MARKERS if marker in text)


def output_predicates(prompt: str, text: str) -> dict[str, bool]:
    """Return named deterministic predicates implied by the operator prompt."""
    prompt_text = str(prompt or "")
    body = str(text or "")
    predicates: dict[str, bool] = {}
    needs_citation = bool(
        required_markers(prompt_text)
        and any(marker in prompt_text for marker in ("GROUNDING_COMPLETE",))
    ) or bool(
        re.search(r"exact line(?: range)?|path:line|:\d+", prompt_text, re.I)
        and re.search(r"\.(?:py|ts|tsx|js|json|md)\b", prompt_text, re.I)
    )
    if needs_citation:
        predicates["path_line_citation"] = bool(PATH_LINE_RE.search(body))
    return predicates


def _canonical_tool_key(step: Mapping[str, Any]) -> str:
    payload = {
        "tool": step.get("tool") or step.get("name"),
        "args": step.get("args") or step.get("arguments") or {},
    }
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def duplicate_equivalent_tool_calls(steps: Iterable[Mapping[str, Any]]) -> int:
    """Count repeated normalized tool+argument calls after their first attempt."""
    counts: dict[str, int] = {}
    duplicates = 0
    for step in steps:
        key = _canonical_tool_key(step)
        counts[key] = counts.get(key, 0) + 1
        if counts[key] > 1:
            duplicates += 1
    return duplicates


def _deterministic_check(
    check: Mapping[str, Any],
    *,
    final_text: str,
    steps: tuple[Mapping[str, Any], ...],
    files_touched: tuple[str, ...],
    route: str,
) -> tuple[bool, Any, Any]:
    ctype = str(check.get("type") or "")
    expected = check.get("value")
    if ctype == "contains":
        actual = str(expected or "") in final_text
        return actual, expected, actual
    if ctype == "contains_any":
        values = tuple(str(item) for item in check.get("values") or ())
        actual = [item for item in values if item in final_text]
        return bool(actual), list(values), actual
    if ctype == "not_contains":
        actual = str(expected or "") not in final_text
        return actual, expected, actual
    if ctype == "regex":
        pattern = str(check.get("pattern") or "")
        actual = bool(re.search(pattern, final_text, re.MULTILINE))
        return actual, pattern, actual
    if ctype == "exact_text":
        normalized = final_text.strip()
        target = str(expected or "").strip()
        return normalized == target, target, normalized
    if ctype == "line_count":
        actual = len(final_text.strip().splitlines()) if final_text.strip() else 0
        target = int(check.get("count", expected if expected is not None else 0))
        return actual == target, target, actual
    if ctype == "tool_at_least":
        actual = len(steps)
        target = int(check.get("count") or 1)
        return actual >= target, target, actual
    if ctype == "tool_at_most":
        actual = len(steps)
        target = int(check.get("count") or 0)
        return actual <= target, target, actual
    if ctype == "tool_exact":
        actual = len(steps)
        target = int(check.get("count") or 0)
        return actual == target, target, actual
    if ctype == "duplicate_tool_calls_at_most":
        actual = duplicate_equivalent_tool_calls(steps)
        target = int(check.get("count") or 0)
        return actual <= target, target, actual
    if ctype == "files_touched_subset":
        allowed = {str(item) for item in check.get("allowed") or ()}
        actual = sorted(set(files_touched))
        return set(actual).issubset(allowed), sorted(allowed), actual
    if ctype == "route_equals":
        target = str(expected or "")
        return route == target, target, route
    if ctype == "route_in":
        allowed_routes = tuple(str(item) for item in check.get("values") or ())
        return route in allowed_routes, list(allowed_routes), route
    raise ValueError(f"unsupported deterministic check type {ctype!r}")


def evaluate_deterministic_contract(
    contract: Mapping[str, Any] | None,
    *,
    final_text: str,
    steps: Iterable[Mapping[str, Any]] = (),
    files_touched: Iterable[str] = (),
    route: str = "",
) -> dict[str, Any]:
    """Evaluate a host-authored, model-invisible deterministic acceptance contract.

    Circular checks such as ``bridge_ok`` remain the outer harness's authority
    and are deliberately not accepted here. A receipt is completion-sufficient
    only when the host explicitly marks it sufficient and every required check
    is supported and passes.
    """
    raw = dict(contract or {})
    raw_checks = raw.get("checks")
    checks = list(raw_checks) if isinstance(raw_checks, (list, tuple)) else []
    step_rows = tuple(step for step in steps if isinstance(step, Mapping))
    touched = tuple(str(item) for item in files_touched if str(item))
    rows: list[dict[str, Any]] = []
    unsupported_required: list[str] = []
    for index, raw_check in enumerate(checks):
        if not isinstance(raw_check, Mapping):
            continue
        check = dict(raw_check)
        ctype = str(check.get("type") or "")
        required = bool(check.get("required", True))
        if ctype not in _SUPPORTED_DETERMINISTIC_CHECK_TYPES:
            if required:
                unsupported_required.append(ctype or f"check-{index}")
            rows.append(
                {
                    "index": index,
                    "type": ctype,
                    "required": required,
                    "supported": False,
                    "passed": False if required else None,
                    "expected": None,
                    "actual": None,
                }
            )
            continue
        passed, expected, actual = _deterministic_check(
            check,
            final_text=str(final_text or ""),
            steps=step_rows,
            files_touched=touched,
            route=str(route or ""),
        )
        rows.append(
            {
                "index": index,
                "type": ctype,
                "required": required,
                "supported": True,
                "passed": bool(passed),
                "expected": expected,
                "actual": actual,
            }
        )
    required_rows = [row for row in rows if row["required"]]
    failed = [
        f"{row['index']}:{row['type']}"
        for row in required_rows
        if row.get("passed") is not True
    ]
    passed = bool(required_rows) and not failed
    sufficient = bool(raw.get("sufficient")) and passed and not unsupported_required
    output_status = {
        f"contract_{row['index']}_{row['type']}": bool(row["passed"])
        for row in required_rows
        if row["type"] in _OUTPUT_CHECK_TYPES
    }
    policy_violations = [
        {
            "tool": str(step.get("tool") or step.get("name") or ""),
            "errorType": str(
                step.get("errorType")
                or step.get("error_type")
                or step.get("status")
                or ""
            ),
        }
        for step in step_rows
        if str(
            step.get("errorType")
            or step.get("error_type")
            or step.get("status")
            or ""
        )
        in {"duplicate_tool_call_denied", "tool_policy_denied"}
    ]
    return {
        "schema": DETERMINISTIC_CONTRACT_SCHEMA,
        "candidateOnly": True,
        "canClaimAGI": False,
        "source": str(raw.get("source") or ""),
        "passed": passed,
        "sufficient": sufficient,
        "deterministicEvidence": sufficient,
        "checks": rows,
        "failedRequired": failed,
        "unsupportedRequired": unsupported_required,
        "outputPredicates": output_status,
        "toolCalls": len(step_rows),
        "duplicateEquivalentToolCalls": duplicate_equivalent_tool_calls(step_rows),
        "toolPolicyViolations": policy_violations,
    }


def render_tool_receipt_failure(
    receipt: Mapping[str, Any],
    *,
    fallback_text: str = "",
) -> str:
    """Replace a count-contradicting model report with authoritative receipts."""
    failed_types = {
        str(row.get("type") or "")
        for row in receipt.get("checks") or ()
        if isinstance(row, Mapping)
        and bool(row.get("required", True))
        and row.get("passed") is not True
    }
    if not failed_types.intersection(_TOOL_CHECK_TYPES) and not receipt.get(
        "toolPolicyViolations"
    ):
        return str(fallback_text or "")
    failed = ", ".join(str(item) for item in receipt.get("failedRequired") or ())
    return "\n".join(
        [
            "INCOMPLETE: deterministic tool-receipt contract failed.",
            f"ACTUAL_TOOL_CALLS={int(receipt.get('toolCalls') or 0)}",
            "DUPLICATE_EQUIVALENT_TOOL_CALLS="
            f"{int(receipt.get('duplicateEquivalentToolCalls') or 0)}",
            f"FAILED_PREDICATES={failed or 'tool_policy'}",
        ]
    )


def strip_completion_markers(text: str) -> str:
    cleaned = _MARKER_LINE_RE.sub("", str(text or ""))
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def finalize_completion_markers(
    text: str,
    *,
    prompt: str,
    additional_predicates: Mapping[str, Any] | None = None,
) -> tuple[str, dict[str, bool]]:
    """Append or withhold required markers after deterministic predicates."""
    markers = required_markers(prompt)
    predicates = output_predicates(prompt, strip_completion_markers(text))
    for key, value in (additional_predicates or {}).items():
        if isinstance(value, Mapping):
            passed = value.get("passed", value.get("ok"))
            predicates[str(key)] = passed is True
        else:
            predicates[str(key)] = value is True
    if not markers:
        return str(text or ""), predicates
    body = strip_completion_markers(text)
    missing = tuple(name for name, passed in predicates.items() if not passed)
    if missing:
        lines = ["MISSING_CONTRACT:"]
        lines.extend(f"- {name}" for name in missing)
        return f"{body}\n\n" + "\n".join(lines) if body else "\n".join(lines), predicates
    # One authorized marker: the first required marker named in the prompt.
    suffix = markers[0]
    if body:
        return f"{body}\n{suffix}", predicates
    return suffix, predicates


def compile_initial_criteria(
    goal: str,
    extra: Iterable[Any] = (),
) -> tuple[AcceptanceCriterion, ...]:
    """Compile immutable initial criteria from the operator goal."""
    items: list[AcceptanceCriterion] = []
    seen: set[str] = set()

    def _add(
        value: str,
        *,
        source: str = "explicit",
        verifier_type: str = "semantic",
        predicate: Mapping[str, Any] | None = None,
        required_evidence: Iterable[str] = (),
        mandatory: bool = True,
    ) -> None:
        text = str(value or "").strip()
        if not text:
            return
        key = text.casefold()
        if key in seen:
            return
        seen.add(key)
        items.append(
            AcceptanceCriterion(
                criterion_id=f"C{len(items) + 1:02d}",
                requirement=text[:1000],
                mandatory=mandatory,
                verifier_type=verifier_type,
                predicate=dict(predicate or {}),
                required_evidence=tuple(required_evidence),
                source=source,
            )
        )

    for item in extra:
        if isinstance(item, AcceptanceCriterion):
            value = item
            if value.criterion_id in seen:
                continue
            seen.add(value.criterion_id)
            items.append(value)
        else:
            _add(str(item), source="explicit")
    goal_text = str(goal or "")
    for match in _MANDATORY_LINE_RE.finditer(goal_text):
        _add(match.group(1), source="explicit", verifier_type="source")
    for marker in required_markers(goal_text):
        _add(
            f"Authorized marker {marker} is appended only after output "
            "predicates pass.",
            source="machine",
            verifier_type="output_regex",
            predicate={"marker": marker},
        )
    if output_predicates(goal_text, ""):
        _add(
            "Citations use path:line form (file:line).",
            source="machine",
            verifier_type="output_regex",
            predicate={"kind": "path_line_citation"},
            required_evidence=("path:line",),
        )
    if not items:
        _add(
            "The requested outcome is supported by inspectable evidence.",
            source="machine",
            verifier_type="deterministic",
        )
    return tuple(items)


def propose_criteria_amendments(
    existing: Iterable[AcceptanceCriterion | str],
    proposed: Iterable[str],
) -> tuple[tuple[AcceptanceCriterion, ...], tuple[dict[str, Any], ...]]:
    """Keep existing criteria; record new items as non-mandatory proposals."""
    kept = tuple(
        item
        if isinstance(item, AcceptanceCriterion)
        else AcceptanceCriterion(
            criterion_id=f"C{index + 1:02d}",
            requirement=str(item).strip(),
            mandatory=True,
            verifier_type="semantic",
            predicate={},
            required_evidence=(),
            source="explicit",
        )
        for index, item in enumerate(existing)
        if (
            item.requirement.strip()
            if isinstance(item, AcceptanceCriterion)
            else str(item).strip()
        )
    )
    existing_keys = {
        item.requirement.casefold()
        for item in kept
    }
    existing_ids = {item.criterion_id for item in kept}
    amendments: list[dict[str, Any]] = []
    for raw in proposed:
        text = str(raw or "").strip()[:1000]
        if not text or text.casefold() in existing_keys:
            continue
        existing_keys.add(text.casefold())
        criterion_id = f"C{len(kept) + len(amendments) + 1:02d}"
        while criterion_id in existing_ids:
            criterion_id = f"C{len(kept) + len(amendments) + 2:02d}"
        amendments.append(
            {
                "criterionId": criterion_id,
                "requirement": text,
                "status": "proposed",
                "mandatory": False,
                "source": "planner_proposed",
            }
        )
    return kept, tuple(amendments)


def has_actionable_remaining_work(
    *,
    status: str,
    remaining: Iterable[str] = (),
    reason: str = "",
    budget_exhausted: bool = False,
    operator_denied: bool = False,
    evidence_unavailable: bool = False,
    unverifiable: bool = False,
) -> bool:
    """Return whether a non-success run has a concrete next step."""
    normalized = str(status or "").strip().lower()
    reason_text = str(reason or "")
    remaining_items = tuple(
        str(item).strip() for item in remaining if str(item).strip()
    )
    if operator_denied or normalized == "cancelled":
        return False
    if budget_exhausted or normalized == "bound_hit":
        return False
    if evidence_unavailable or "evidence is unavailable" in reason_text.casefold():
        return False
    if unverifiable or normalized == "unachievable":
        return False
    if normalized == "achieved":
        return False
    if normalized in {"awaiting_input", "paused", "interrupted"}:
        return True
    if normalized == "failed":
        return True
    if remaining_items:
        return True
    if normalized == "candidate_complete":
        return "independent verification" in reason_text.casefold() or bool(
            remaining_items
        )
    return False


def decide_completion(
    *,
    controller_status: str,
    deterministic_pass: bool | None = None,
    semantic_status: str = "",
    output_predicates_pass: bool = True,
    remaining: Iterable[str] = (),
    reason: str = "",
    budget_exhausted: bool = False,
    operator_denied: bool = False,
    evidence_unavailable: bool = False,
    unverifiable: bool = False,
    orchestration_done: bool = True,
    contract_complete: bool | None = None,
) -> CompletionDecision:
    """Map controller + predicate state onto the product completion contract."""
    status = str(controller_status or "").strip().lower()
    remaining_items = tuple(
        str(item).strip() for item in remaining if str(item).strip()
    )
    orchestration_status = "completed" if orchestration_done else "running"
    if not output_predicates_pass:
        resumable = has_actionable_remaining_work(
            status="candidate_complete",
            remaining=remaining_items or ("failed output contract",),
            reason=reason,
            budget_exhausted=budget_exhausted,
            operator_denied=operator_denied,
            evidence_unavailable=evidence_unavailable,
            unverifiable=unverifiable,
        )
        return CompletionDecision(
            ok=False,
            incomplete=True,
            resumable=resumable,
            orchestration_status=orchestration_status,
            task_status="incomplete",
            verification_status="failed_output_contract",
            reason=reason or "output contract failed",
            missing=remaining_items or ("output_contract",),
        )
    if deterministic_pass is False:
        resumable = has_actionable_remaining_work(
            status="candidate_complete",
            remaining=remaining_items or ("failed deterministic predicate",),
            reason=reason,
            budget_exhausted=budget_exhausted,
            operator_denied=operator_denied,
            evidence_unavailable=evidence_unavailable,
            unverifiable=unverifiable,
        )
        return CompletionDecision(
            ok=False,
            incomplete=True,
            resumable=resumable,
            orchestration_status=orchestration_status,
            task_status="incomplete",
            verification_status="failed_deterministic",
            reason=reason or "deterministic predicate failed",
            missing=remaining_items or ("deterministic_predicate",),
        )
    if contract_complete is False:
        resumable = has_actionable_remaining_work(
            status=status or "candidate_complete",
            remaining=remaining_items or ("acceptance contract incomplete",),
            reason=reason,
            budget_exhausted=budget_exhausted,
            operator_denied=operator_denied,
            evidence_unavailable=evidence_unavailable,
            unverifiable=unverifiable,
        )
        return CompletionDecision(
            ok=False,
            incomplete=True,
            resumable=resumable,
            orchestration_status=orchestration_status,
            task_status="incomplete",
            verification_status="acceptance_contract_incomplete",
            reason=reason or "mandatory acceptance criteria remain unresolved",
            missing=remaining_items or ("acceptance_contract",),
        )
    if (
        deterministic_pass is True
        and output_predicates_pass
        and contract_complete is not False
        and not operator_denied
        and status not in {"cancelled", "unachievable", "failed"}
    ):
        return CompletionDecision(
            ok=True,
            incomplete=False,
            resumable=False,
            orchestration_status=orchestration_status,
            task_status="complete",
            verification_status="verified_deterministic",
            reason=reason or "completion-sufficient deterministic predicates passed",
            missing=(),
        )
    if status == "achieved" and output_predicates_pass and deterministic_pass is not False:
        return CompletionDecision(
            ok=True,
            incomplete=False,
            resumable=False,
            orchestration_status=orchestration_status,
            task_status="complete",
            verification_status="verified",
            reason=reason or "all required predicates passed",
            missing=(),
        )
    resumable = has_actionable_remaining_work(
        status=status,
        remaining=remaining_items,
        reason=reason,
        budget_exhausted=budget_exhausted,
        operator_denied=operator_denied,
        evidence_unavailable=evidence_unavailable,
        unverifiable=unverifiable or status == "unachievable",
    )
    verification = {
        "candidate_complete": "candidate_only",
        "awaiting_input": "awaiting_input",
        "paused": "paused",
        "unachievable": "unachievable",
        "bound_hit": "budget_exhausted",
        "cancelled": "cancelled",
        "failed": "failed",
    }.get(status, status or "incomplete")
    return CompletionDecision(
        ok=False,
        incomplete=True,
        resumable=resumable,
        orchestration_status=orchestration_status,
        task_status="incomplete",
        verification_status=verification,
        reason=reason or status,
        missing=remaining_items,
    )


def apply_decision_to_result(result: Any, decision: CompletionDecision) -> Any:
    """Stamp a loop result with the completion decision. Never upgrades ok."""
    result.ok = bool(decision.ok)
    result.incomplete = bool(decision.incomplete)
    if hasattr(result, "resumable"):
        result.resumable = bool(decision.resumable)
    else:
        try:
            result.resumable = bool(decision.resumable)
        except Exception:  # noqa: BLE001 - SimpleNamespace always accepts
            pass
    result.incomplete_reason = (
        decision.verification_status if decision.incomplete else ""
    )
    result.orchestration_status = decision.orchestration_status
    result.task_status = decision.task_status
    result.verification_status = decision.verification_status
    return result


def remaining_from_mapping(value: Any) -> tuple[str, ...]:
    if isinstance(value, str) and value.strip():
        return (value.strip(),)
    if isinstance(value, Mapping):
        items = []
        for key in ("remaining", "missing", "failed", "unknown"):
            raw = value.get(key)
            if isinstance(raw, str) and raw.strip():
                items.append(raw.strip())
            elif isinstance(raw, (list, tuple)):
                items.extend(str(item).strip() for item in raw if str(item).strip())
        return tuple(items)
    if isinstance(value, (list, tuple)):
        return tuple(str(item).strip() for item in value if str(item).strip())
    return ()


__all__ = [
    "COMPLETION_MARKERS",
    "DETERMINISTIC_CONTRACT_SCHEMA",
    "CompletionDecision",
    "PATH_LINE_RE",
    "SCHEMA",
    "apply_decision_to_result",
    "compile_initial_criteria",
    "decide_completion",
    "duplicate_equivalent_tool_calls",
    "evaluate_deterministic_contract",
    "finalize_completion_markers",
    "has_actionable_remaining_work",
    "output_predicates",
    "propose_criteria_amendments",
    "remaining_from_mapping",
    "render_tool_receipt_failure",
    "required_markers",
    "strip_completion_markers",
]
