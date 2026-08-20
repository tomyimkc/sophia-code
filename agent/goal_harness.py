# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Autonomous goal-continuation harness.

Runs the tool loop, then asks a strict LLM judge whether the user's GOAL is
``achieved`` / ``awaiting_input`` / ``unachievable`` / still ``in_progress``
(with a confidence). If in progress, it SELF-GENERATES a continuation prompt
that restates the original goal + progress + what remains, carries the
conversation memory forward, and loops — until the goal is achieved, paused for
operator input, confidently unachievable, or a hard safety bound trips.

This generalises ``agent_loop``'s within-one-process auto-continuation across
SEPARATE ``run_agent_loop`` calls (each a "chat"), with an external judge.

Fail-closed / no-overclaim discipline:
  * The judge is conservative — ``achieved``/``unachievable`` only fire at or
    above their confidence thresholds; a malformed judge verdict defaults to
    ``in_progress`` with confidence 0 (so it can never falsely declare success —
    the loop just keeps going, bounded).
  * Hard bounds (max continuations, aggregate ExecutionBudget, wall-clock
    deadline) and a NO-PROGRESS detector guarantee termination: a model that
    keeps failing the same step (e.g. an abstract that won't extract) is stopped
    and reported ``unachievable (no_progress)`` rather than looping forever.
  * Every result carries ``candidateOnly: true, canClaimAGI: false``.

The harness only ever calls tools THROUGH ``run_agent_loop`` (which enforces the
permission approver + delivery gate); it never mutates state itself.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from agent.agent_loop import run_agent_loop

# Terminal goal statuses.
STATUS_ACHIEVED = "achieved"
STATUS_AWAITING_INPUT = "awaiting_input"
STATUS_UNACHIEVABLE = "unachievable"
STATUS_IN_PROGRESS = "in_progress"
STATUS_BOUND_HIT = "bound_hit"
STATUS_CANCELLED = "cancelled"

_JSON_RE = re.compile(r"\{.*\}", re.S)
_EXPLICIT_OPERATOR_INPUT_RE = re.compile(
    r"(?:"
    r"\b(?:blocked|waiting|awaiting|need(?:s|ed)?|require(?:s|d)?|missing)\b"
    r".{0,140}\b(?:user|operator|owner)(?:[- ]only)?\b"
    r".{0,140}\b(?:input|action|answer|approval|authori[sz]ation|confirmation|"
    r"credential|login|log in|sign in|declaration|url|upload|provide|supply)\b"
    r"|"
    r"\b(?:user|operator|owner)(?:[- ]only)?\b"
    r".{0,140}\b(?:must|needs? to|has to|should|can)\b"
    r".{0,140}\b(?:approve|authori[sz]e|confirm|provide|supply|upload|sign in|"
    r"log in|authenticate|answer)\b"
    r")",
    re.I | re.S,
)
_MISSING_OPERATOR_PREREQUISITE_RE = re.compile(
    r"(?:"
    r"\b(?:no|without|missing|absent|not authenticated|not logged in|"
    r"has not been provided|have not been provided|is not available|"
    r"are not available)\b"
    r".{0,180}\b(?:credential|authenticated session|authentication|login|"
    r"api key|access token|approval|authori[sz]ation|eligibility declaration|"
    r"personal declaration|public (?:video )?url|owner-supplied|user-supplied)\b"
    r"|"
    r"\brequired to resume\b.{0,220}\b(?:sign in|log in|authenticate|approve|"
    r"authori[sz]e|confirm|provide|supply|upload)\b"
    r")",
    re.I | re.S,
)


def _extract_json(text: str) -> dict | None:
    """Leniently pull the first JSON object out of a model reply (fenced or bare).

    Returns ``None`` on any failure — callers default every field (fail-closed).
    Mirrors the repo convention (agent/wiki_librarian.py, agent/ssil_proposer.py).
    """
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    raw = fence.group(1) if fence else None
    if raw is None:
        m = _JSON_RE.search(text)
        raw = m.group(0) if m else None
    if raw is None:
        return None
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None


def _clamp01(x: Any) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(v):
        return 0.0
    return max(0.0, min(1.0, v))


def _atomic_write_json(path: Path, obj: dict) -> None:
    """Best-effort atomic JSON write (temp + os.replace). Never raises."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001 - persistence is optional, never fatal
        pass


def _default_state_path(goal_id: str) -> Path:
    from agent.runtime_paths import user_state_dir
    return user_state_dir() / "goal_state" / f"{goal_id}.json"


_JUDGE_SYSTEM = (
    "You are a strict, honest goal-status judge for an autonomous agent. Decide "
    "whether the user's goal is ACHIEVED, AWAITING_INPUT, UNACHIEVABLE, or still "
    "IN_PROGRESS based ONLY on the evidence in the latest report. Be conservative: "
    "mark 'achieved' ONLY if the evidence clearly and fully satisfies the goal. "
    "Mark 'awaiting_input' when the work can continue after an operator supplies "
    "information or performs an owner-only action, including login/authentication, "
    "credentials, personal declarations, approval/authorization, a required URL or "
    "upload, or another manual external action. This is a paused, resumable goal, "
    "not a failure. Mark 'unachievable' ONLY if the goal is clearly impossible even "
    "after reasonable operator input and no alternative exists. Otherwise mark "
    "'in_progress' and say what remains. Do NOT reward effort; judge the outcome. "
    "Output ONLY a JSON object, no prose."
)


def _awaiting_input_reason(*, remaining: str, report: str, evidence: str) -> str:
    """Return the actionable operator-input block, or an empty string.

    The judge contract is the primary classifier. This deterministic backstop
    protects continuity when a provider still uses the older three-state
    vocabulary and calls an explicit owner-only prerequisite "unachievable".
    Patterns are intentionally strict: a generic failed tool or inaccessible
    source remains unachievable/in-progress unless the report names an operator
    action or a user-supplied prerequisite.
    """
    text = "\n".join(
        part.strip() for part in (remaining, report, evidence)
        if part and part.strip()
    )
    if not text:
        return ""
    if not (
        _EXPLICIT_OPERATOR_INPUT_RE.search(text)
        or _MISSING_OPERATOR_PREREQUISITE_RE.search(text)
    ):
        return ""
    # The raw report may contain operator-supplied URLs, credentials, tokens, or
    # other private material. It is detection-only and must never become the
    # durable reason echoed into goal-state JSON or the TUI.
    for part in (remaining, evidence):
        candidate = (part or "").strip()
        if candidate:
            return candidate[:1000]
    return "operator input is required before the goal can continue"


def assess_goal_status(goal: str, report: str, *, tools_used: list[str],
                       attempt: int, client: Any,
                       failed_approaches: list[str] | None = None) -> dict:
    """Ask the judge for {status, confidence, remaining, evidence}.

    Fail-closed: any error or malformed verdict -> ``in_progress`` with
    confidence 0.0, which can never trigger a terminal 'achieved'/'unachievable'
    (the loop continues, bounded by the harness).
    """
    fallback = {"status": STATUS_IN_PROGRESS, "confidence": 0.0,
                "remaining": "goal status could not be verified", "evidence": ""}
    user = (
        f"GOAL:\n{goal}\n\n"
        f"ATTEMPT NUMBER: {attempt}\n"
        f"TOOLS USED SO FAR: {', '.join(sorted(set(tools_used))) or 'none'}\n"
        + (f"APPROACHES THAT ALREADY FAILED: {', '.join(failed_approaches)}\n"
           if failed_approaches else "")
        + f"\nLATEST REPORT FROM THE AGENT:\n{(report or '').strip()[:4000]}\n\n"
        "Output JSON: {\"status\": \"achieved\"|\"awaiting_input\"|"
        "\"unachievable\"|\"in_progress\", "
        "\"confidence\": 0.0-1.0, \"remaining\": \"<what remains or why unachievable>\", "
        "\"evidence\": \"<brief evidence>\"}"
    )
    try:
        res = client.generate_messages(
            [{"role": "system", "content": _JUDGE_SYSTEM},
             {"role": "user", "content": user}],
            tools=None,
        )
    except Exception:  # noqa: BLE001 - a broken judge yields no verdict, not a crash
        return fallback
    if getattr(res, "ok", True) is False:
        return fallback
    parsed = _extract_json(getattr(res, "text", "") or "")
    if not parsed:
        return fallback
    status = str(parsed.get("status") or "").strip().lower()
    if status not in (
        STATUS_ACHIEVED,
        STATUS_AWAITING_INPUT,
        STATUS_UNACHIEVABLE,
        STATUS_IN_PROGRESS,
    ):
        status = STATUS_IN_PROGRESS
    remaining = str(parsed.get("remaining") or "").strip()[:1000]
    evidence = str(parsed.get("evidence") or "").strip()[:1000]
    waiting_reason = _awaiting_input_reason(
        remaining=remaining,
        report=report,
        evidence=evidence,
    )
    if waiting_reason:
        # Explicit operator prerequisites contradict both "achieved" and
        # terminal "unachievable". Pause instead of falsely completing/failing.
        status = STATUS_AWAITING_INPUT
        remaining = waiting_reason
    return {
        "status": status,
        "confidence": _clamp01(parsed.get("confidence")),
        "remaining": remaining,
        "evidence": evidence,
    }


# Action cues that suggest a multi-step, tool-using goal worth an LLM triage.
# Phrase-level on purpose; "what … hasn't" / "difference between" catch the
# comparative research shape without flagging plain chitchat.
_GOAL_CUE_RE = re.compile(
    r"\b(find|search|research|fetch|get|locate|fix|repair|solve|build|implement|"
    r"create|write|compose|compare|analy[sz]e|investigate|debug|refactor|generate|"
    r"extract|review|audit|set ?up|make|add|update|upgrade|improve|optimi[sz]e|"
    r"design|plan|summariz|report|install|configure|deploy|migrate|verify|"
    r"figure out|work out|latest|current version|technical report|what technique|"
    r"difference between|what .* hasn'?t|how do i)\b",
    re.I,
)


def looks_like_goal_candidate(prompt: str) -> bool:
    """Cheap local pre-filter deciding whether a prompt is worth an LLM goal-triage.

    Trivial prompts — greetings, thanks, very short chitchat with no action cue
    ("hi", "hello", "ok", "what is 2+2") — skip the triage entirely, so a slow
    local model is NOT hit with an extra call just to answer "hi". Anything
    substantial (longer) or carrying an action cue goes to the LLM triage.
    Conservative: when in doubt, triage (never miss a real goal).
    """
    text = (prompt or "").strip()
    if not text:
        return False
    words = text.split()
    if len(words) <= 6 and not _GOAL_CUE_RE.search(text):
        return False
    return True


_TRIAGE_SYSTEM = (
    "You decide whether a user's request is a MULTI-STEP GOAL that needs "
    "autonomous tool-using iteration to achieve, or a SIMPLE REQUEST that one "
    "direct answer satisfies.\n"
    "Multi-step goals (is_goal=true): research / find / locate / fetch / compare / "
    "fix / build / implement, or 'get the latest X and summarize it' style tasks "
    "that may need several tool calls, could fail partway, and need retrying.\n"
    "Simple requests (is_goal=false): greetings, single facts, definitions, "
    "explanations, opinions, chitchat, arithmetic, 'what is N', or code "
    "explanations that need no external lookup.\n"
    "When unsure, prefer is_goal=false. Also restate the precise goal clearly. "
    "Output ONLY a JSON object, no prose."
)


def triage_goal(prompt: str, *, client: Any) -> dict:
    """Decide whether ``prompt`` is an autonomous multi-step goal, and extract it.

    Returns ``{is_goal, goal, confidence, reason}``. Fail-closed: any error or
    malformed verdict -> ``is_goal=False`` (do a normal single run — never
    accidentally launch the autonomous loop). The extracted ``goal`` defaults to
    the original prompt. This is what lets a normal prompt engage the goal loop
    automatically, with no ``/goal`` command.
    """
    fallback = {"is_goal": False, "goal": prompt, "confidence": 0.0,
                "reason": "triage unavailable — treating as a normal request"}
    user = (
        f"USER REQUEST:\n{prompt}\n\n"
        "Output JSON: {\"is_goal\": true|false, \"goal\": \"<the precise goal "
        "restated clearly; same as the request if it is already a clear goal>\", "
        "\"confidence\": 0.0-1.0, \"reason\": \"<brief why>\"}"
    )
    try:
        res = client.generate_messages(
            [{"role": "system", "content": _TRIAGE_SYSTEM},
             {"role": "user", "content": user}],
            tools=None,
        )
    except Exception:  # noqa: BLE001 - a broken triage yields a normal run, not a crash
        return fallback
    if getattr(res, "ok", True) is False:
        return fallback
    parsed = _extract_json(getattr(res, "text", "") or "")
    if not parsed:
        return fallback
    goal = str(parsed.get("goal") or "").strip() or prompt
    return {
        "is_goal": bool(parsed.get("is_goal")),
        "goal": goal[:1000],
        "confidence": _clamp01(parsed.get("confidence")),
        "reason": str(parsed.get("reason") or "").strip()[:300],
    }


# --------------------------------------------------------------------------- #
# Session-level goal accumulation
# --------------------------------------------------------------------------- #
def _session_goal_path(session: str) -> Path:
    """Per-session accumulated-goal record, so the goal compounds across prompts
    in the same chat and survives restarts."""
    from agent.runtime_paths import user_state_dir
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(session or "default")) or "default"
    return user_state_dir() / "goal_state" / f"session-{safe}.json"


def load_session_goal(session: str) -> dict | None:
    """Load the session's accumulated-goal record, or ``None``. Fail-closed: a
    corrupt/missing record yields ``None`` (start fresh), never a crash."""
    try:
        obj = json.loads(_session_goal_path(session).read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) and obj.get("goal") else None
    except Exception:  # noqa: BLE001 - persistence is optional
        return None


def save_session_goal(session: str, goal: str, *, meta: dict | None = None) -> Path:
    """Persist the session's accumulated goal (atomic write). Returns the path."""
    rec: dict = {
        "schema": "sophia.session_goal.v1",
        "candidateOnly": True, "canClaimAGI": False,
        "session": str(session or "default"),
        "goal": goal,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if meta:
        rec.update({k: v for k, v in meta.items() if k not in ("schema", "goal", "session")})
    path = _session_goal_path(session)
    _atomic_write_json(path, rec)
    return path


_ACCUMULATE_SYSTEM = (
    "You maintain a running, ACCUMULATED goal for an ongoing work session. Given "
    "the prior accumulated goal (if any), its status, and the user's NEW request, "
    "produce the updated accumulated goal.\n"
    "- No prior goal: the accumulated goal is the new request, restated clearly.\n"
    "- New request EXTENDS or ADDS to the prior goal: combine them into one "
    "accumulated goal that includes everything still outstanding.\n"
    "- New request is a brand-new, unrelated topic: the accumulated goal is the "
    "new request alone (it supersedes the prior goal).\n"
    "- DROP any prior part whose status shows it is already achieved/done.\n"
    "Restate the accumulated goal clearly and concisely. Output ONLY a JSON object."
)


def accumulate_goal(prior_goal: str | None, new_prompt: str, *, client: Any,
                    prior_status: str | None = None) -> dict:
    """Merge the prior accumulated session goal with a new request -> updated goal.

    Returns ``{goal, continues_prior, confidence, reason}``. Fail-closed: any
    error or malformed verdict falls back to a simple join (prior + new), or just
    the new request when there is no prior — accumulation never crashes a run.
    """
    prior_goal = (prior_goal or "").strip()
    fallback_goal = f"{prior_goal} | {new_prompt}".strip(" |") if prior_goal else new_prompt
    fallback = {"goal": fallback_goal, "continues_prior": bool(prior_goal),
                "confidence": 0.0, "reason": "accumulation unavailable — goals joined"}
    user = (
        f"PRIOR ACCUMULATED GOAL: {prior_goal or '(none)'}\n"
        + (f"PRIOR GOAL STATUS: {prior_status}\n" if prior_status else "")
        + f"NEW REQUEST: {new_prompt}\n\n"
        "Output JSON: {\"goal\": \"<the updated accumulated goal>\", "
        "\"continues_prior\": true|false, \"confidence\": 0.0-1.0, \"reason\": \"<brief>\"}"
    )
    try:
        res = client.generate_messages(
            [{"role": "system", "content": _ACCUMULATE_SYSTEM},
             {"role": "user", "content": user}],
            tools=None,
        )
    except Exception:  # noqa: BLE001 - a broken accumulator joins goals, not a crash
        return fallback
    if getattr(res, "ok", True) is False:
        return fallback
    parsed = _extract_json(getattr(res, "text", "") or "")
    if not parsed:
        return fallback
    goal = str(parsed.get("goal") or "").strip() or fallback_goal
    continues = parsed.get("continues_prior")
    return {
        "goal": goal[:2000],
        "continues_prior": bool(continues) if continues is not None else bool(prior_goal),
        "confidence": _clamp01(parsed.get("confidence")),
        "reason": str(parsed.get("reason") or "").strip()[:300],
    }


def build_continuation_prompt(goal: str, *, attempt: int, success_tools: list[str],
                              findings: str, last_report: str, remaining: str,
                              failed_approaches: list[str]) -> str:
    """Self-generated continuation prompt that restates the ORIGINAL goal."""
    lines = [
        "You are continuing work toward a goal across multiple turns. The full "
        + "memory of prior turns is carried in this conversation.",
        "",
        f"ORIGINAL GOAL (unchanged — this is what you must achieve):{os.linesep}{goal}",
        "",
        f"PROGRESS SO FAR (this is continuation attempt {attempt}):",
        f"- Tools that have succeeded: {', '.join(sorted(set(success_tools))) or 'none yet'}",
    ]
    if findings:
        lines.append(f"- Key findings: {findings}")
    if failed_approaches:
        lines.append(f"- Approaches that FAILED (do NOT repeat them): "
                     f"{'; '.join(failed_approaches)}")
    lines += [
        f"- Last report: {(last_report or '').strip()[:1200]}",
        "",
        "ASSESSMENT OF WHAT REMAINS:",
        remaining or "(judge gave no specific remainder — infer the next step)",
        "",
        "INSTRUCTIONS:",
        "- Continue working toward the ORIGINAL GOAL. Act on it; do not restate it.",
        "- CALL tools to make progress. Prefer a DIFFERENT approach than the ones "
        + "that failed.",
        "- If you now have enough to fully satisfy the goal, give the complete "
        + "final answer.",
        "- If you determine the goal is genuinely unachievable with the available "
        + "tools/evidence, say so explicitly and explain why.",
        "- If progress requires login, credentials, personal declarations, approval, "
        + "a required URL/upload, or another action only the operator can perform, "
        + "state the exact requested input/action and stop as awaiting operator input.",
    ]
    return "\n".join(lines)


def _step_signature(steps: list[dict]) -> tuple[frozenset, str]:
    """(set of successful tool names, last error) — used for no-progress detection."""
    ok_tools = frozenset(
        s.get("tool") for s in steps
        if s.get("ok") and (s.get("output") or "").strip()
    )
    last_err = ""
    for s in reversed(steps):
        if not s.get("ok") and (s.get("error") or "").strip():
            last_err = (s.get("error") or "")[:160]
            break
    return ok_tools, last_err


@dataclass
class GoalLoopResult:
    goal: str
    status: str                       # achieved | awaiting_input | unachievable | bound_hit | cancelled
    reason: str                       # human-readable why it stopped
    confidence: float                 # judge confidence in the terminal status
    continuations: int                # number of run_agent_loop calls made
    attempts: list[dict] = field(default_factory=list)
    final_text: str = ""
    messages: list[dict] = field(default_factory=list)   # final carried history
    goal_id: str = ""
    state_path: str = ""
    candidateOnly: bool = True
    canClaimAGI: bool = False

    def to_dict(self) -> dict:
        return {
            "schema": "sophia.goal_loop_result.v1",
            "candidateOnly": self.candidateOnly,
            "canClaimAGI": self.canClaimAGI,
            "goal": self.goal, "status": self.status, "reason": self.reason,
            "confidence": self.confidence, "continuations": self.continuations,
            "attempts": self.attempts, "finalText": self.final_text,
            "goalId": self.goal_id, "statePath": self.state_path,
        }


def run_goal_loop(
    goal: str,
    *,
    client: Any,
    ctx: Any,
    judge_client: Any | None = None,
    on_event: Callable[[dict], None] | None = None,
    history: "list[dict] | None" = None,
    budget: Any | None = None,
    max_continuations: int = 8,
    max_steps_per_run: int = 12,
    max_parallel_tools: int = 1,
    achieved_threshold: float = 0.8,
    unachievable_threshold: float = 0.8,
    max_no_progress: int = 3,
    system_extra: str = "",
    show_thinking: bool = False,
    enable_tools: bool = True,
    steering_consumer: Callable[[], list[str]] | None = None,
    response_style: str = "adaptive",
    raw_user_turn: str | None = None,
    current_task: str | None = None,
    cancel_check: Callable[[], bool] | None = None,
    goal_id: str | None = None,
    state_path: "str | Path | None" = None,
    trace_dir: "str | Path | None" = None,
) -> GoalLoopResult:
    """Run the autonomous goal-continuation loop. See module docstring."""
    judge_client = judge_client or client
    gid = goal_id or f"goal-{int(time.time())}"
    spath = Path(state_path) if state_path else _default_state_path(gid)
    tdir = Path(trace_dir) if trace_dir else None

    def emit(ev: dict) -> None:
        if on_event:
            try:
                on_event({**ev, "goalId": gid})
            except Exception:  # noqa: BLE001 - a sink failure never stops the loop
                pass

    max_continuations = max(1, int(max_continuations))
    max_no_progress = max(1, int(max_no_progress))

    emit({"type": "goal_start", "goal": goal, "maxContinuations": max_continuations,
          "achievedThreshold": achieved_threshold,
          "unachievableThreshold": unachievable_threshold})

    carryover: list[dict] | None = list(history) if history else None
    attempts: list[dict] = []
    cumulative_ok_tools: set[str] = set()
    failed_approaches: list[str] = []
    findings = ""
    stagnant = 0
    last_report = ""
    terminal_conf = 0.0
    terminal_remaining = ""
    final_text = ""

    for attempt in range(1, max_continuations + 1):
        if cancel_check is not None and cancel_check():
            terminal_status, terminal_reason = STATUS_CANCELLED, "cancelled by operator"
            break
        if budget is not None and budget.snapshot().cancelled:
            terminal_status, terminal_reason = STATUS_CANCELLED, "execution budget cancelled"
            break

        prompt = goal if attempt == 1 else build_continuation_prompt(
            goal, attempt=attempt, success_tools=sorted(cumulative_ok_tools),
            findings=findings, last_report=last_report,
            remaining=(attempts[-1]["remaining"] if attempts else ""),
            failed_approaches=failed_approaches,
        )
        trace_path = None
        if tdir is not None:
            tdir.mkdir(parents=True, exist_ok=True)
            trace_path = str(tdir / f"{gid}-attempt-{attempt}.jsonl")

        res = run_agent_loop(
            prompt, client=client, ctx=ctx, history=carryover, on_event=on_event,
            max_steps=max_steps_per_run, system_extra=system_extra,
            show_thinking=show_thinking, enable_tools=enable_tools,
            steering_consumer=steering_consumer, budget=budget,
            max_parallel_tools=max_parallel_tools,
            response_style=response_style,
            raw_user_turn=raw_user_turn if attempt == 1 else None,
            current_task=current_task if attempt == 1 else None,
            trace_path=trace_path, post_tool_continuity=True,
        )
        final_text = res.final_text or ""
        last_report = final_text
        carryover = res.messages  # carry the full transcript to the next "chat"

        ok_tools, last_err = _step_signature(res.steps)
        new_tools = set(ok_tools)
        grew = bool(new_tools - cumulative_ok_tools)
        cumulative_ok_tools |= new_tools
        if last_err and last_err not in failed_approaches:
            failed_approaches.append(last_err)
            failed_approaches = failed_approaches[-6:]

        verdict = assess_goal_status(
            goal, final_text, tools_used=sorted(cumulative_ok_tools),
            attempt=attempt, client=judge_client, failed_approaches=failed_approaches,
        )
        status, conf = verdict["status"], verdict["confidence"]
        emit({"type": "goal_status", "attempt": attempt, "status": status,
              "confidence": conf, "remaining": verdict["remaining"],
              "toolsUsed": sorted(cumulative_ok_tools)})

        attempt_rec = {
            "attempt": attempt, "ok": bool(res.ok), "status": status,
            "confidence": conf, "remaining": verdict["remaining"],
            "evidence": verdict["evidence"],
            "tools": sorted({s.get("tool") for s in res.steps if s.get("tool")}),
            "newTools": sorted(new_tools - cumulative_ok_tools | new_tools),
            "report": final_text[:800], "tracePath": trace_path,
        }
        attempts.append(attempt_rec)
        if verdict["remaining"]:
            findings = (findings + " | " + verdict["remaining"])[-1500:] if findings else verdict["remaining"]

        # Persist goal-state after every attempt (memory carry-over / resumability).
        _atomic_write_json(spath, {
            "schema": "sophia.goal_state.v1", "candidateOnly": True, "canClaimAGI": False,
            "goalId": gid, "goal": goal, "status": status, "confidence": conf,
            "continuations": attempt, "attempts": attempts,
            "cumulativeTools": sorted(cumulative_ok_tools),
            "failedApproaches": failed_approaches,
            "lastContinuationPrompt": prompt if attempt > 1 else None,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })

        # --- Termination decisions (fail-closed, confidence-gated) --- #
        if status == STATUS_ACHIEVED and conf >= achieved_threshold:
            terminal_status, terminal_reason, terminal_conf = (
                STATUS_ACHIEVED, f"judge: goal achieved (confidence {conf:.2f})", conf)
            break
        if status == STATUS_AWAITING_INPUT:
            terminal_status, terminal_reason, terminal_conf = (
                STATUS_AWAITING_INPUT,
                f"awaiting operator input: "
                f"{verdict['remaining'] or 'operator action is required'}",
                conf,
            )
            terminal_remaining = verdict["remaining"]
            break
        if status == STATUS_UNACHIEVABLE and conf >= unachievable_threshold:
            terminal_status, terminal_reason, terminal_conf = (
                STATUS_UNACHIEVABLE,
                f"judge: goal unachievable (confidence {conf:.2f}): {verdict['remaining']}",
                conf)
            break
        # No-progress safety bound: stop a model stuck repeating failing steps.
        if not grew:
            stagnant += 1
        else:
            stagnant = 0
        if stagnant >= max_no_progress and status != STATUS_ACHIEVED:
            terminal_status = STATUS_UNACHIEVABLE
            terminal_reason = (
                f"no progress for {stagnant} consecutive attempts "
                f"(no new successful tool; last error: {last_err or 'n/a'}) — "
                "stopping rather than looping forever")
            terminal_conf = conf
            break
        # Budget exhaustion between runs.
        if budget is not None:
            snap = budget.snapshot()
            if snap.cancelled:
                terminal_status, terminal_reason = STATUS_CANCELLED, "execution budget cancelled"
                break

        if attempt < max_continuations:
            emit({"type": "goal_continuation", "attempt": attempt,
                  "nextAttempt": attempt + 1, "remaining": verdict["remaining"]})
    else:
        terminal_status = STATUS_BOUND_HIT
        terminal_reason = f"reached max_continuations={max_continuations} without resolution"

    emit({"type": f"goal_{terminal_status}", "status": terminal_status,
          "reason": terminal_reason, "confidence": terminal_conf,
          "continuations": len(attempts), "finalText": final_text[:500],
          **({"remaining": terminal_remaining, "awaitingInput": True}
             if terminal_status == STATUS_AWAITING_INPUT else {})})

    result = GoalLoopResult(
        goal=goal, status=terminal_status, reason=terminal_reason,
        confidence=terminal_conf, continuations=len(attempts), attempts=attempts,
        final_text=final_text, messages=carryover or [], goal_id=gid,
        state_path=str(spath),
    )
    _atomic_write_json(spath, {**result.to_dict(), "messages": None})
    return result


__all__ = [
    "GoalLoopResult", "run_goal_loop", "assess_goal_status", "triage_goal",
    "looks_like_goal_candidate", "accumulate_goal", "load_session_goal",
    "save_session_goal", "build_continuation_prompt", "STATUS_ACHIEVED",
    "STATUS_AWAITING_INPUT", "STATUS_UNACHIEVABLE", "STATUS_IN_PROGRESS",
    "STATUS_BOUND_HIT", "STATUS_CANCELLED",
]
