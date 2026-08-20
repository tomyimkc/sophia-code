# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Deterministic logical-thinking judge for Sophia terminal outputs.

This is a lightweight, fail-closed heuristic judge. It does not prove a model's
private reasoning is valid; it scores the *visible* reasoning progress against the
repo thesis: source discipline, explicit assumptions, premise-to-conclusion flow,
uncertainty, objections, and verification.

candidateOnly; canClaimAGI:false.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LogicCriterion:
    key: str
    label: str
    markers: tuple[str, ...]
    weight: int = 1


CRITERIA: tuple[LogicCriterion, ...] = (
    LogicCriterion("goal", "states the goal / question", ("goal", "question", "task", "objective")),
    LogicCriterion("assumptions", "makes assumptions explicit", ("assumption", "assuming", "given", "premise")),
    LogicCriterion("evidence", "uses evidence / observations", ("evidence", "source", "observ", "tool", "trace", "because")),
    LogicCriterion("inference", "connects premises to conclusion", ("therefore", "so ", "hence", "implies", "follows", "conclusion")),
    LogicCriterion("alternatives", "considers alternatives / objections", ("alternative", "objection", "counter", "however", "risk", "tradeoff")),
    LogicCriterion("uncertainty", "states uncertainty / limits", ("uncertain", "unknown", "limit", "caveat", "not proven", "may", "might")),
    LogicCriterion("verification", "checks or proposes verification", ("verify", "test", "validate", "check", "passed", "failed")),
    LogicCriterion("structure", "has explicit reasoning structure", ("reasoning progress", "analysis", "plan", "decision", "summary")),
)


def judge_text(text: str, *, mode: str = "basic") -> dict:
    """Score visible reasoning text for logical discipline.

    ``basic`` passes at >=0.50; ``strict`` passes at >=0.75. The result is meant
    for auditing and comparison across model responses, not as a proof of truth.
    """
    lowered = (text or "").lower()
    abstain_markers = (
        "conscience gate held",
        "abstaining rather than emitting",
        "insufficient verified basis",
        "cannot verify",
        "cannot prove",
        "lack of information",
        "not enough information",
    )
    if any(marker in lowered for marker in abstain_markers):
        return {
            "mode": mode,
            "verdict": "pass_abstain",
            "score": 1.0,
            "threshold": 0.75 if mode == "strict" else 0.50,
            "criteria": [
                {"key": "abstention", "label": "abstains/holds when evidence is insufficient", "passed": True}
            ],
            "missing": [],
            "canClaimAGI": False,
            "note": (
                "Heuristic audit of visible reasoning only; abstention/hold on insufficient evidence "
                "is treated as logically disciplined."
            ),
        }
    hits: list[dict] = []
    total = sum(c.weight for c in CRITERIA)
    earned = 0
    for criterion in CRITERIA:
        matched = any(marker in lowered for marker in criterion.markers)
        if matched:
            earned += criterion.weight
        hits.append({"key": criterion.key, "label": criterion.label, "passed": matched})
    score = earned / total if total else 0.0
    threshold = 0.75 if mode == "strict" else 0.50
    verdict = "pass" if score >= threshold else "fail"
    missing = [h["key"] for h in hits if not h["passed"]]
    return {
        "mode": mode,
        "verdict": verdict,
        "score": round(score, 3),
        "threshold": threshold,
        "criteria": hits,
        "missing": missing,
        "canClaimAGI": False,
        "note": "Heuristic audit of visible reasoning only; not proof of private chain-of-thought or truth.",
    }
