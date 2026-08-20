#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Skill catalog surfacing + the invoke_skill meta-tool (Component B).

The Sophia agent's model historically saw NO skills at decision time — skills were
routed by a non-LLM keyword matcher (``agent/skills.py``) *before* the model ran.
This module makes the skill catalog model-visible so the model can recognize when
a skill applies and invoke it — the "spec.md raises trigger likelihood" mechanism,
operationalized: the catalog injects each skill's ``whenToUse`` trigger condition
(the spec text) into the system prompt, and ``invoke_skill`` is how the model acts
on a recognized match.

Two pieces:
  1. ``catalog_system_extra()`` — render a compact catalog block (name + whenToUse
     + triggers per skill) for injection into the system prompt via the loop's
     ``system_extra`` parameter. This is the trigger-condition description proven
     to raise matching.
  2. ``invoke_skill`` tool — the model calls ``invoke_skill(name, input_json)``;
     the harness loads that skill's ``workflow`` + ``verification`` and returns
     them as the tool result, so the model then follows the loaded workflow.

Opt-in: surfaced only when ``SOPHIA_SURFACE_SKILLS=1`` (or the caller requests
it), so existing runs are unchanged and the context cost is opt-in — a real
tradeoff on context-budget-constrained local models.

candidateOnly: true · canClaimAGI: false — surfacing plumbing.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))


def surface_skills_enabled() -> bool:
    """True iff skill surfacing is opted in (env flag). Off by default — surfacing
    trades context budget for trigger surface, so it is an explicit choice."""
    return os.environ.get("SOPHIA_SURFACE_SKILLS", "").lower() in ("1", "true", "yes", "on")


# Tier-1 uplift lever: few-shot trigger examples. The single highest-ROI inference-
# side lever for raising a local model's trigger recognition — concrete
# intent→tool pairs the model maps against. These mirror the /bench trigger case
# shapes so the model learns exactly the recognition the benchmark measures.
# CandidateOnly; these are prompt scaffolding, not a capability claim.
FEW_SHOT_TRIGGER_EXAMPLES = [
    ("A draft says 'A 2023 Yale study found...' — verify the citation is real before publishing.",
     "sophia_source_verify", '{"answer": "<the draft text>"}'),
    ("Is it safe to publish this reply? Gate it for over-claiming.",
     "sophia_conscience_check", '{"text": "<the draft>", "mode": "output"}'),
    ("Check this claim against the provenance corpus: 'The Analects were written by Laozi.'",
     "sophia_check_claim", '{"text": "The Analects were written by Laozi."}'),
    ("Remember for next time: restarting oMLX fixes the stall.",
     "sophia_memory_store", '{"record": {"lesson": "restart oMLX to fix stalls"}}'),
    # NEGATIVE example: a plain knowledge question must NOT trigger a tool.
    ("What is the capital of France?",
     None, None),
]


def few_shot_block() -> str:
    """Render few-shot intent→(tool|nothing) examples for the system prompt.

    These concrete pairs teach the trigger *recognition* the benchmark scores.
    The negative example (intent→nothing) is what reins in over-trigger. Returns
    empty string unless surfacing is opted in.
    """
    if not surface_skills_enabled():
        return ""
    lines = [
        "## When to call a tool — examples (few-shot trigger guidance)",
        "Call a tool ONLY when the intent clearly matches; answer directly otherwise.",
        "",
    ]
    for intent, tool, args in FEW_SHOT_TRIGGER_EXAMPLES:
        if tool is None:
            lines.append(f"Intent: \"{intent}\" → answer directly (NO tool call).")
        else:
            lines.append(f"Intent: \"{intent}\" → call {tool} with {args}.")
    return "\n".join(lines)


def catalog_system_extra(*, max_skills: int = 20, max_when_len: int = 160) -> str:
    """Render the skill catalog as a system-prompt block.

    One line per skill: ``name: whenToUse (triggers: …)``. This is the
    trigger-condition description (the "spec md" the model follows) — concrete
    enough for the model to match user intent to a skill. Kept compact (truncated
    per skill, capped skill count) to respect context budget on local models.

    Returns ``""`` (no injection) when surfacing is off or no skills load.
    """
    if not surface_skills_enabled():
        return ""
    try:
        from agent.skills import load_all
    except Exception:  # noqa: BLE001 — catalog is advisory; never break a run
        return ""
    try:
        skills = list(load_all().values())
    except Exception:  # noqa: BLE001
        return ""
    if not skills:
        return ""
    lines = [
        "## Available skills (invoke via the invoke_skill tool)",
        "Each skill has a trigger condition (whenToUse) and trigger keywords. When the "
        + "user's intent matches a skill, call `invoke_skill` with its name to load its "
        + "workflow, then follow it. Do NOT call a skill that does not match.",
        "",
    ]
    for sk in skills[:max_skills]:
        name = str(sk.get("name", "")).strip()
        when = str(sk.get("whenToUse", "")).strip()
        triggers = sk.get("triggers", []) or []
        if not name or not when:
            continue
        trig = ", ".join(str(t) for t in triggers[:6])
        when_short = when[:max_when_len] + ("…" if len(when) > max_when_len else "")
        line = f"- **{name}**: {when_short}"
        if trig:
            line += f" (keywords: {trig})"
        lines.append(line)
    lines.append("")
    lines.append(
        "To use a skill, call: invoke_skill(name=\"<skill name>\", input_json=\"<JSON args>\"). "
        "Only invoke a skill whose whenToUse matches the task; otherwise answer directly."
    )
    # Tier-1 uplift: append the few-shot trigger examples (intent→tool pairs).
    fs = few_shot_block()
    if fs:
        lines.append("")
        lines.append(fs)
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# invoke_skill tool — how the model acts on a recognized catalog match
# --------------------------------------------------------------------------- #
def invoke_skill_fn(args: dict, ctx: Any) -> str:
    """Load a named skill's workflow + verification into context.

    The model calls this when it recognizes (from the catalog) that a skill
    applies. The harness returns the skill's workflow steps + verification checks
    as the tool result; the model then follows the loaded workflow. This is the
    2-step trigger: recognize from catalog → invoke_skill → follow workflow.

    Fail-closed: an unknown skill name returns a clear error (never silently
    loads nothing). The input_json is echoed back so the model knows what it asked.
    """
    from agent.skills import load_all
    name = str(args.get("name", "")).strip()
    if not name:
        raise ValueError("name is required (the skill to invoke, from the catalog)")
    input_json = str(args.get("input_json", "{}") or "{}")
    # validate it parses (don't enforce schema — skills vary)
    try:
        json.loads(input_json)
    except Exception as exc:
        raise ValueError(f"input_json must be valid JSON: {exc}") from exc
    skills = load_all()
    if name not in skills:
        avail = ", ".join(sorted(skills)[:12])
        raise ValueError(
            f"unknown skill {name!r}. Available: {avail}{' …' if len(skills) > 12 else ''}"
        )
    sk = skills[name]
    workflow = sk.get("workflow", []) or []
    verification = sk.get("verification", []) or []
    out = {
        "skill": name,
        "whenToUse": sk.get("whenToUse", ""),
        "workflow": workflow,
        "verification": verification,
        "your_input": input_json,
        "next": "Follow the workflow steps above to accomplish the task, then run the "
                "verification checks. canClaimAGI stays false.",
    }
    return json.dumps(out, ensure_ascii=False, default=str)[:6000]


# The invoke_skill ToolSpec, imported by the surfacing wiring (agent_tools plugin
# or the loop) when SOPHIA_SURFACE_SKILLS is on. Exposed here so tests + the
# wiring import one symbol.
def invoke_skill_spec():
    """Return the invoke_skill ToolSpec (governance-risk; safe to call)."""
    from agent.agent_tools import ToolSpec, _obj_schema, _string
    return ToolSpec(
        "invoke_skill", "governance",
        "Load a skill's workflow into context. Call this ONLY when the user's intent "
        "matches a skill in the catalog (above). Pass the skill name and a JSON object "
        "of inputs. The result is the workflow to follow + verification checks.",
        {"name": "skill name (from the catalog)", "input_json": "JSON object of inputs to the skill"},
        invoke_skill_fn,
        _obj_schema({
            "name": _string("skill name (from the catalog)", min_length=1),
            "input_json": _string("JSON object of inputs to the skill"),
        }, ["name"]),
    )
