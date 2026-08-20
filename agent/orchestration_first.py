# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Deterministic pre-run orchestration and safe native-tool batching.

The interactive TUI used to spend provider calls deciding whether a prompt was
a goal, then (for a new goal) another call merging it with an empty prior goal,
and sometimes a third call deciding whether to use team lanes.  Those calls did
not do the user's work.  This module makes the cheap decisions locally before
the first provider call, keeps ordinary substantive work in the inner agent
loop, and reserves model-backed goal assessment for explicit long-horizon work.

The batching rule is deliberately conservative:

* only known idempotent read tools may share a batch;
* mutations and unknown/plugin tools form serial barriers;
* semantically duplicate reads stay serial so the per-run cache can collapse them;
* result order always remains model order.

candidateOnly; canClaimAGI:false — orchestration plumbing, not a capability
claim or measured efficiency result.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Sequence

from agent.tool_loop_efficiency import PARALLEL_READ_TOOLS, call_signature

DEFAULT_PARALLEL_TOOLS = 4
MAX_PARALLEL_TOOLS = 4

_LIST_LEAD_RE = re.compile(r"^\s*(?:[-*]|\d+[.)])\s+", re.MULTILINE)
_ENUMERATION_RE = re.compile(
    r"\b(?:compare|contrast|research|inspect|review|audit|check|summari[sz]e)\s+"
    r"([^.\n]{1,240})",
    re.IGNORECASE,
)
_SEPARATOR_RE = re.compile(r"\s*(?:,|;|\band\b|\bversus\b|\bvs\.?\b)\s*", re.IGNORECASE)
_ACTION_CLAUSE_RE = re.compile(
    r"\b(?:implement|write|build|research|inspect|review|audit|test|verify|compare|"
    r"document|update|fix|analyse|analyze)\b",
    re.IGNORECASE,
)
_EXPLANATION_PREFIX_RE = re.compile(
    r"^\s*(?:can|could|would|will)?\s*(?:you\s+)?(?:explain|define|translate|"
    r"paraphrase|summari[sz]e|what\s+(?:does|is|are)|what'?s\s+the\s+meaning)",
    re.IGNORECASE,
)
_EXPLANATION_TASK_RE = re.compile(
    r"^\s*(?:can|could|would|will)?\s*(?:you\s+)?(?:explain|define|translate|"
    r"paraphrase|summari[sz]e)\b",
    re.IGNORECASE,
)
_NEGATED_DURABLE_ACTION_START_RE = re.compile(
    r"\b(?:do not|don'?t|never)\s+(?:keep|continue|carry on|work|persist|retry|"
    r"monitor|watch|check)\b",
    re.IGNORECASE,
)
_CLAUSE_BOUNDARY_RE = re.compile(
    r"[,;:.!?\n]+|\b(?:but|and(?:\s+then)?|then|however|instead|also|now)\b",
    re.IGNORECASE,
)
_DURABLE_COMMAND_START_RE = re.compile(
    r"^(?:please\s+)?(?:"
    r"keep(?:\s+(?:going|working))?|continue|carry\s+on|persist|retry|monitor|"
    r"watch|check|resume|work|run|fix|implement|build|test|verify|deploy|"
    r"complete|finish|(?:do\s+not|don'?t|never)\s+stop|"
    r"(?:over|across|through)\s+(?:multiple|several|successive)\s+"
    r"(?:attempts?|sessions?|turns?|runs?)"
    r")\b",
    re.IGNORECASE,
)
_SEQUENTIAL_CUE_RE = re.compile(
    r"\b(?:first\b[^.\n]{0,160}\bthen\b|then\b|after(?:wards)?\b|"
    r"before\b|once\b[^.\n]{0,100}\b(?:then|run|test|verify|report)\b|"
    r"in dependency order|same (?:file|module|implementation|code|target)|"
    r"(?:implement|edit|modify|fix|build|write)\b[^.\n]{0,120}\band\s+"
    r"(?:run|test|verify|report)\b)",
    re.IGNORECASE,
)
_SUBSTANTIVE_CUE_RE = re.compile(
    r"\b(find|search|research|fetch|get|locate|fix|repair|solve|build|implement|"
    r"create|write|compose|compare|analy[sz]e|investigate|debug|refactor|generate|"
    r"extract|review|audit|set ?up|make|add|update|upgrade|improve|optimi[sz]e|"
    r"design|plan|summariz|report|install|configure|deploy|migrate|verify|"
    r"figure out|work out|latest|current version|technical report|what technique|"
    r"difference between|what .* hasn'?t|how do i)\b",
    re.IGNORECASE,
)
_LONG_HORIZON_CUE_RE = re.compile(
    r"(?:"
    r"\b(?:keep|continue|carry on|persist|retry|monitor|watch|check)\b"
    r"[^.\n]{0,100}\buntil\b|"
    r"\bkeep going\b[^.\n]{0,100}\bunless\b|"
    r"(?:do not|don'?t|never)\s+stop\b[^.\n]{0,100}\buntil\b|"
    r"\b(?:over|across|through)\s+(?:multiple|several|successive)\s+"
    r"(?:attempts?|sessions?|turns?|runs?)\b|"
    r"\b(?:resume|continue)\s+(?:this|the|my|our)\s+(?:goal|task|work)\b|"
    r"\b(?:persist|keep going)\s+until\b|"
    r"\buntil\s+(?:it|this|that|the (?:task|goal|work|job|issue|bug|fix|"
    r"implementation|migration|deployment|run|process))\s+(?:is|has|passes?|"
    r"succeeds?|completes?|finishes?|merges?|works?|resolves?)\b|"
    r"(?:until|unless)\s+(?:done|complete|completed|finished|fixed|resolved|"
    r"successful|verified|merged)\b"
    r")",
    re.IGNORECASE,
)
_TEAM_CUE_RE = re.compile(
    r"\b(compare|contrast|both\b.*\band\b|and also|as well as|multiple "
    r"(?:independent )?(?:tasks?|parts?|items?|targets?|sources?)|several "
    r"(?:independent )?(?:tasks?|parts?|items?|targets?|sources?)|"
    r"various|each of|every (?:task|part|item|target|source|file|module|option)|"
    r"parallel|simultaneously|in parallel|alternatives?|"
    r"pros and cons|trade-?offs?|different (?:approaches|ways|methods|options)|"
    r"on one hand|research .* and)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class OrchestrationDecision:
    """One deterministic decision made before any provider call."""

    goal_candidate: bool
    team_candidate: bool
    team_lanes: int
    max_parallel_tools: int
    reason: str
    # Appended with a default to preserve the original exported constructor:
    # OrchestrationDecision(goal, team, lanes, workers, reason).
    substantive_task: bool = False


def looks_like_substantive_task(prompt: str) -> bool:
    text = (prompt or "").strip()
    return bool(
        text
        and (
            len(text.split()) > 6
            or _SUBSTANTIVE_CUE_RE.search(text)
            or _EXPLANATION_TASK_RE.search(text)
            or _NEGATED_DURABLE_ACTION_START_RE.search(text)
            or looks_like_long_horizon_goal(text)
        )
    )


def _starts_affirmative_durable_clause(text: str) -> bool:
    candidate = text.lstrip()
    return bool(
        _DURABLE_COMMAND_START_RE.match(candidate)
        # Every long-horizon cue is bounded to a short local phrase. Limiting
        # this probe keeps a boundary scan linear even on hostile long prompts.
        and _LONG_HORIZON_CUE_RE.search(candidate[:256])
    )


def _after_authoritative_clause_boundary(text: str, start: int) -> str:
    """Return a later affirmative durable clause, or ``""``.

    A comma/colon/question mark is a boundary only when what follows starts a
    new durable command. This avoids splitting object lists such as
    ``"don't monitor A, B until done"`` while preserving
    ``"explain X, but keep working until done"``.
    """
    for boundary in _CLAUSE_BOUNDARY_RE.finditer(text, start):
        remainder = text[boundary.end():]
        if _starts_affirmative_durable_clause(remainder):
            return remainder
    return ""


def _authoritative_durable_text(text: str) -> str:
    """Remove explanatory/negated clauses without hiding later commands."""
    candidate = text
    explanation = _EXPLANATION_PREFIX_RE.match(candidate)
    if explanation:
        candidate = _after_authoritative_clause_boundary(
            candidate, explanation.end())

    negated = _NEGATED_DURABLE_ACTION_START_RE.search(candidate)
    if negated:
        remainder = _after_authoritative_clause_boundary(
            candidate, negated.end())
        candidate = candidate[:negated.start()] + remainder
    return candidate


def looks_like_long_horizon_goal(prompt: str) -> bool:
    """Return whether the user explicitly asks for durable/repeated execution.

    Ordinary coding, research, inspection, and testing requests are substantive
    tasks, but the inner agent loop already handles them.  Automatic outer goal
    mode is reserved for explicit persistence/retry/resume language because it
    adds a completion-judge provider call after every attempt.
    """
    text = (prompt or "").strip()
    if not text:
        return False
    candidate = _authoritative_durable_text(text)
    return bool(candidate.strip() and _LONG_HORIZON_CUE_RE.search(candidate))


def looks_like_goal_candidate(prompt: str) -> bool:
    """Backward-compatible alias for substantive-task classification."""
    return looks_like_substantive_task(prompt)


def looks_like_team_candidate(prompt: str) -> bool:
    text = (prompt or "").strip()
    if not looks_like_substantive_task(text):
        return False
    if looks_like_long_horizon_goal(text) and re.search(
        r"\bacross\s+(?:multiple|several|successive)\s+"
        r"(?:attempts?|sessions?|turns?|runs?)\b",
        text,
        re.IGNORECASE,
    ):
        return False
    # Length alone is never a reason to multiply provider/tool calls. A long
    # inspect -> edit -> test request is often one dependency chain over shared
    # files. Require an explicit parallelism/comparison cue; false negatives
    # merely stay solo, while false positives risk conflicting writes.
    if _SEQUENTIAL_CUE_RE.search(text):
        return False
    return bool(_TEAM_CUE_RE.search(text))


def effective_parallel_tools(
    requested: int | None = None,
    *,
    env_value: str | None = None,
    hard_cap: int = MAX_PARALLEL_TOOLS,
) -> int:
    """Return a bounded tool-worker count; ``0`` means disable (serial).

    ``env_value`` is injectable so tests never mutate process state.  When it is
    omitted the ordinary ``SOPHIA_MAX_PARALLEL_TOOLS`` override is read.
    Garbage fails open to the requested/default value, then the hard cap still
    bounds concurrency.
    """
    fallback = DEFAULT_PARALLEL_TOOLS if requested is None else requested
    raw = os.environ.get("SOPHIA_MAX_PARALLEL_TOOLS") if env_value is None else env_value
    value = fallback
    if raw not in (None, ""):
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = fallback
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = DEFAULT_PARALLEL_TOOLS
    if value <= 1:
        return 1
    return max(1, min(int(hard_cap), value))


def _parallel_part_count(prompt: str) -> int:
    """Estimate independent prompt parts without asking a model.

    This is routing only, not semantic task decomposition.  It deliberately
    under-counts ambiguous prose: false negatives cost parallelism; false
    positives multiply provider calls and can create conflicting writes.
    """
    text = (prompt or "").strip()
    if not text:
        return 1

    list_items = _LIST_LEAD_RE.findall(text)
    if len(list_items) >= 2:
        return min(4, len(list_items))

    match = _ENUMERATION_RE.search(text)
    if match:
        subject = re.split(
            r"\b(?:technical reports?|release notes?|documentation|and report|and summar)\b",
            match.group(1),
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0]
        parts = [p.strip(" `\"'()") for p in _SEPARATOR_RE.split(subject) if p.strip(" `\"'()")]
        if 2 <= len(parts) <= 12:
            return min(4, len(parts))

    clauses = [
        clause.strip()
        for clause in re.split(r"[,;]|\band\b|\bthen\b", text, flags=re.IGNORECASE)
        if clause.strip()
    ]
    actionable = sum(1 for clause in clauses if _ACTION_CLAUSE_RE.search(clause))
    return min(4, actionable) if actionable >= 2 else 2


def decide_orchestration(
    prompt: str,
    *,
    auto_goal: bool,
    auto_team: bool | None,
    requested_parallel_tools: int | None = None,
) -> OrchestrationDecision:
    """Choose goal/team/tool concurrency once, locally, before model execution."""
    substantive = looks_like_substantive_task(prompt)
    goal_candidate = bool(
        auto_goal
        and substantive
        and looks_like_long_horizon_goal(prompt)
    )
    team_candidate = bool(
        auto_team is True
        and substantive
        and looks_like_team_candidate(prompt)
    )
    team_lanes = _parallel_part_count(prompt) if team_candidate else 1
    max_parallel = (
        effective_parallel_tools(requested_parallel_tools)
        if substantive
        else 1
    )
    reason = (
        f"parallel task ({team_lanes} independent parts)"
        if team_candidate
        else "long-horizon goal"
        if goal_candidate
        else "substantive task"
        if substantive
        else "simple request"
    )
    return OrchestrationDecision(
        goal_candidate=goal_candidate,
        team_candidate=team_candidate,
        team_lanes=team_lanes,
        max_parallel_tools=max_parallel,
        reason=reason,
        substantive_task=substantive,
    )


def partition_tool_calls(
    calls: Sequence[tuple[str, dict[str, Any]]],
) -> list[list[tuple[str, dict[str, Any]]]]:
    """Partition model-order calls into safe parallel-read batches.

    Every non-read (including unknown plugin tools) is a serial barrier.  A
    duplicate semantic signature also closes the current batch and remains serial
    so the loop's read cache can serve it after the first call completes.
    """
    batches: list[list[tuple[str, dict[str, Any]]]] = []
    parallel: list[tuple[str, dict[str, Any]]] = []
    signatures: set[str] = set()

    def flush() -> None:
        nonlocal parallel, signatures
        if parallel:
            batches.append(parallel)
            parallel = []
            signatures = set()

    for name, raw_args in calls:
        args = raw_args if isinstance(raw_args, dict) else {}
        call = (name, args)
        if name not in PARALLEL_READ_TOOLS:
            flush()
            batches.append([call])
            continue
        signature = call_signature(name, args)
        if signature in signatures:
            flush()
            batches.append([call])
            continue
        parallel.append(call)
        signatures.add(signature)
    flush()
    return batches

__all__ = [
    "DEFAULT_PARALLEL_TOOLS",
    "MAX_PARALLEL_TOOLS",
    "OrchestrationDecision",
    "decide_orchestration",
    "effective_parallel_tools",
    "looks_like_goal_candidate",
    "looks_like_long_horizon_goal",
    "looks_like_substantive_task",
    "looks_like_team_candidate",
    "partition_tool_calls",
]
