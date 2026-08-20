# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""One-worker contract evaluation and targeted gap-closure loop.

This is an experimental PR 2 seam.  It deliberately does not create another
orchestration framework: the caller injects one worker function, while this
module owns criterion targeting, deterministic completion, and bounded gap
waves.

candidateOnly: true
canClaimAGI: false
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from agent.acceptance_contract import (
    AcceptanceContract,
    CriterionLedger,
    CriterionStatus,
    strict_complete,
)
from agent.completion_gate import (
    finalize_completion_markers,
    output_predicates,
)


SCHEMA = "sophia.completeness_loop.v1"


@dataclass(frozen=True)
class GapTask:
    task_id: str
    criteria_covered: tuple[str, ...]
    instruction: str
    allowed_tools: tuple[str, ...] = ()
    max_model_calls: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "criteriaCovered": list(self.criteria_covered),
            "instruction": self.instruction,
            "allowedTools": list(self.allowed_tools),
            "maxModelCalls": self.max_model_calls,
        }


@dataclass
class CompletenessResult:
    mode: str
    ok: bool
    incomplete: bool
    resumable: bool
    final_text: str
    calls: int
    waves: int
    contract: AcceptanceContract
    ledger: CriterionLedger
    gap_tasks: list[GapTask] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "candidateOnly": True,
            "canClaimAGI": False,
            "mode": self.mode,
            "ok": self.ok,
            "incomplete": self.incomplete,
            "resumable": self.resumable,
            "finalText": self.final_text,
            "calls": self.calls,
            "waves": self.waves,
            "reason": self.reason,
            "contract": self.contract.to_dict(),
            "ledger": self.ledger.to_dict(),
            "gapTasks": [task.to_dict() for task in self.gap_tasks],
            "events": list(self.events),
        }


Worker = Callable[[str, tuple[str, ...], int], Mapping[str, Any]]
Oracle = Callable[
    [AcceptanceContract, Mapping[str, Any], str], Mapping[str, Any]
]


def _text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _ids(value: Any) -> tuple[str, ...]:
    if isinstance(value, str):
        return (_text(value, 80),) if _text(value, 80) else ()
    if not isinstance(value, Iterable):
        return ()
    return tuple(dict.fromkeys(_text(item, 80) for item in value if _text(item, 80)))


def _ingest(
    ledger: CriterionLedger,
    result: Mapping[str, Any],
    *,
    default_ids: tuple[str, ...] = (),
) -> None:
    covered = _ids(result.get("criteriaCovered")) or default_ids
    evidence = tuple(
        _text(item, 2000)
        for item in result.get("evidence") or result.get("artifacts") or ()
        if _text(item, 2000)
    )
    verified = set(_ids(result.get("verified")))
    failed = set(_ids(result.get("failed")))
    unknown = set(_ids(result.get("unknown")))
    contradicted = set(_ids(result.get("contradicted")))
    missing = set(_ids(result.get("missing")))
    status = _text(result.get("status"), 80).lower()
    # A first worker may report criterion IDs through status buckets without
    # repeating them in criteriaCovered. Those IDs are still claims about the
    # contract and must be ingested; otherwise the first pass is discarded and
    # gap closure fans out over criteria the worker already addressed.
    covered = tuple(
        dict.fromkeys(
            [
                *covered,
                *verified,
                *failed,
                *unknown,
                *contradicted,
                *missing,
            ]
        )
    )
    for criterion_id in covered:
        if criterion_id not in ledger.criteria:
            continue
        if criterion_id in contradicted:
            next_status = CriterionStatus.CONTRADICTED
        elif criterion_id in failed:
            next_status = CriterionStatus.FAILED
        elif criterion_id in verified or status in {"verified", "achieved", "pass"}:
            next_status = CriterionStatus.VERIFIED
        elif criterion_id in unknown or criterion_id in missing:
            next_status = CriterionStatus.UNKNOWN
        else:
            next_status = CriterionStatus.EVIDENCED if evidence else CriterionStatus.UNKNOWN
        if evidence:
            ledger.attach_evidence(criterion_id, evidence)
        if next_status is not CriterionStatus.WAIVED:
            ledger.set_status(criterion_id, next_status, evidence=evidence)
    for criterion_id in failed:
        if criterion_id in ledger.criteria:
            ledger.set_status(criterion_id, CriterionStatus.FAILED, reason="oracle failed criterion")
    for criterion_id in unknown | missing:
        if criterion_id in ledger.criteria and ledger.entry(criterion_id).status not in {
            CriterionStatus.VERIFIED,
            CriterionStatus.WAIVED,
        }:
            ledger.set_status(criterion_id, CriterionStatus.UNKNOWN, reason="criterion remains unresolved")
    writes = _ids(result.get("writes") or result.get("filesTouched"))
    if writes:
        ledger.mark_write(writes)
    for side_effect in result.get("prohibitedSideEffects") or ():
        ledger.record_side_effect(_text(side_effect, 2000))


def _apply_oracle_predicates(
    contract: AcceptanceContract,
    result: Mapping[str, Any],
) -> None:
    predicates = result.get("outputPredicates")
    if isinstance(predicates, Mapping):
        contract.output_predicates.update(
            {str(key): value for key, value in predicates.items()}
        )


def _renderer_owned_criterion(criterion: Any) -> bool:
    return (
        getattr(criterion, "verifier_type", "") == "output_regex"
        and bool(getattr(criterion, "predicate", {}))
    )


def _update_renderer_owned_criteria(
    contract: AcceptanceContract,
    ledger: CriterionLedger,
    *,
    prompt: str,
    text: str,
) -> None:
    predicates = output_predicates(prompt, text)
    citation_passed = all(predicates.values()) if predicates else True
    for entry in ledger.entries.values():
        if (
            entry.criterion.verifier_type != "output_regex"
            or not (
                entry.criterion.predicate.get("marker")
                or entry.criterion.predicate.get("kind")
                == "path_line_citation"
            )
        ):
            continue
        if citation_passed:
            ledger.set_status(
                entry.criterion.criterion_id,
                CriterionStatus.VERIFIED,
                evidence=("completion renderer authorization",),
                reason="marker is renderer-owned and deterministic predicates passed",
            )
        elif entry.status is CriterionStatus.VERIFIED:
            ledger.set_status(
                entry.criterion.criterion_id,
                CriterionStatus.STALE,
                reason="renderer predicate no longer passes",
            )


def _gap_task(
    contract: AcceptanceContract,
    ledger: CriterionLedger,
    criterion_id: str,
    wave: int,
) -> GapTask:
    criterion = contract.criterion(criterion_id)
    instruction = (
        f"Repair only acceptance criterion {criterion_id}: {criterion.requirement}. "
        "Return criterion-level evidence and do not claim unrelated completion."
    )
    if criterion.verifier_type == "output_regex" or criterion.required_evidence == ():
        allowed_tools: tuple[str, ...] = ()
    else:
        allowed_tools = tuple(criterion.required_evidence)
    return GapTask(
        task_id=f"GAP-{criterion_id}-{wave}",
        criteria_covered=(criterion_id,),
        instruction=instruction,
        allowed_tools=allowed_tools,
        max_model_calls=1,
    )


def run_completeness_loop(
    goal: str,
    *,
    contract: AcceptanceContract,
    worker: Worker,
    mode: str = "contract_solo",
    max_gap_waves: int = 0,
    initial_text: str = "",
    oracle: Oracle | None = None,
    initial_allowed_tools: tuple[str, ...] = (),
) -> CompletenessResult:
    """Run one worker, optionally followed by at most two targeted gap waves."""
    normalized_mode = _text(mode, 80).lower()
    if normalized_mode not in {"contract_solo", "contract_gap_closure"}:
        raise ValueError("mode must be contract_solo or contract_gap_closure")
    if normalized_mode == "contract_gap_closure":
        max_gap_waves = min(2, max(0, int(max_gap_waves or 2)))
    else:
        max_gap_waves = 0
    ledger = CriterionLedger(contract)
    events: list[dict[str, Any]] = [
        {"type": "completion_contract", "criteria": [row.to_dict() for row in contract.criteria]},
        {"type": "criterion_ledger", "summary": ledger.summary()},
    ]
    calls = 0
    gap_tasks: list[GapTask] = []
    first = dict(worker(goal, initial_allowed_tools, 1) or {})
    calls += 1
    text = _text(first.get("finalText") or first.get("text"))
    if oracle is not None:
        first = {
            **first,
            **dict(oracle(contract, first, text) or {}),
        }
        _apply_oracle_predicates(contract, first)
    _ingest(ledger, first)
    _update_renderer_owned_criteria(
        contract, ledger, prompt=goal, text=text
    )
    events.append({"type": "completion_decision", "strict": strict_complete(contract, ledger)})
    waves = 0
    while not strict_complete(contract, ledger) and waves < max_gap_waves:
        raw_unresolved = ledger.unresolved_mandatory()
        renderer_unresolved = [
            criterion_id
            for criterion_id in raw_unresolved
            if _renderer_owned_criterion(ledger.entry(criterion_id).criterion)
        ]
        unresolved = tuple(
            criterion_id
            for criterion_id in raw_unresolved
            if not _renderer_owned_criterion(ledger.entry(criterion_id).criterion)
        ) + tuple(renderer_unresolved[:1])
        if not unresolved:
            break
        waves += 1
        renderer_ids = tuple(
            criterion_id
            for criterion_id in unresolved
            if _renderer_owned_criterion(ledger.entry(criterion_id).criterion)
        )
        ordinary_ids = tuple(
            criterion_id for criterion_id in unresolved if criterion_id not in renderer_ids
        )
        current_tasks: list[GapTask] = []
        if renderer_ids:
            first = contract.criterion(renderer_ids[0])
            current_tasks.append(
                GapTask(
                    task_id=f"GAP-{renderer_ids[0]}-{waves}",
                    criteria_covered=renderer_ids,
                    instruction=(
                        "Repair only the output contract criteria "
                        f"{', '.join(renderer_ids)}: "
                        + "; ".join(
                            contract.criterion(item).requirement
                            for item in renderer_ids
                        )
                        + ". Return the corrected output with no unrelated claims."
                    ),
                    allowed_tools=(),
                    max_model_calls=1,
                )
            )
        current_tasks.extend(
            _gap_task(contract, ledger, criterion_id, waves)
            for criterion_id in ordinary_ids
        )
        gap_tasks.extend(current_tasks)
        events.append({
            "type": "completion_gap_start",
            "wave": waves,
            "criteria": list(unresolved),
            "tasks": [task.to_dict() for task in current_tasks],
        })
        for task in current_tasks:
            result = dict(
                worker(task.instruction, task.allowed_tools, task.max_model_calls) or {}
            )
            calls += 1
            text = _text(result.get("finalText") or result.get("text")) or text
            if oracle is not None:
                result = {
                    **result,
                    **dict(oracle(contract, result, text) or {}),
                }
                _apply_oracle_predicates(contract, result)
            _ingest(ledger, result, default_ids=task.criteria_covered)
            _update_renderer_owned_criteria(
                contract, ledger, prompt=goal, text=text
            )
        events.append({
            "type": "completion_gap_end",
            "wave": waves,
            "summary": ledger.summary(),
        })
    passed = strict_complete(contract, ledger)
    rendered, predicates = finalize_completion_markers(text or initial_text, prompt=goal)
    if not passed:
        reason = "mandatory acceptance criteria remain unresolved"
        if ledger.prohibited_side_effects():
            reason = "prohibited side effect recorded"
        return CompletenessResult(
            mode=normalized_mode,
            ok=False,
            incomplete=True,
            resumable=bool(ledger.unresolved_mandatory()) and waves < max_gap_waves,
            final_text=rendered,
            calls=calls,
            waves=waves,
            contract=contract,
            ledger=ledger,
            gap_tasks=gap_tasks,
            events=events,
            reason=reason,
        )
    events.append({
        "type": "completion_decision",
        "strict": True,
        "outputPredicates": predicates,
    })
    return CompletenessResult(
        mode=normalized_mode,
        ok=True,
        incomplete=False,
        resumable=False,
        final_text=rendered,
        calls=calls,
        waves=waves,
        contract=contract,
        ledger=ledger,
        gap_tasks=gap_tasks,
        events=events,
        reason="all mandatory criteria verified",
    )


__all__ = ["CompletenessResult", "GapTask", "run_completeness_loop"]
