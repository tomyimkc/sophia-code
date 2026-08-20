# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Deep Think for Sophia Code: creative→logical review of an agent answer.

Second-stage deliberation that runs at high/ultra effort — ALWAYS, with no
per-effort episode count (the former ``_EPISODES_PER_EFFORT`` 0/3/7 cost dial
was removed). It replaces the Schoenfeld episode review with a two-path editorial
review that improves the final answer without imposing a harness-owned format:

Pipeline (same model throughout, every pass tools-free):

  1. DIGEST   — assemble the run transcript (goal, per-step tool/ok/output,
                final answer) as the deliberation substrate.
  2. CREATE   — a divergent/creative pass proposes candidate improvements and
                corrections to the draft answer (breadth-first, no self-censoring).
  3. CRITIQUE — a logical/thesis pass stress-tests the candidates against the
                task's constraints and the evidence in the transcript.
  4. CONVERGE — a synthesis pass reconciles the creative proposals with the
                logical critique into the final user-facing answer, preserving
                the model's natural structure and voice where they are sound.

Everything is visible-reasoning only — never hidden chain-of-thought.
candidateOnly; canClaimAGI stays false. stdlib only.
"""
from __future__ import annotations

import re
from typing import Any

_CONFIDENCE_RE = re.compile(r"confidence\s*[:=]\s*(\d{1,3})\s*/\s*100", re.IGNORECASE)

#: Bound on how much of each debate leg's text is carried into the next prompt.
_MAX_LEG_CHARS = 2500

#: The three debate stages, in order (used for event/telemetry labels).
STAGES = ("creative", "logical", "converge")


def _effective_request(*, prompt: str = "", effective_request: str = "") -> str:
    """Prefer the current effective request while keeping old callers compatible."""
    return (effective_request or prompt).strip()


def _context_block(continuation_context: str, max_context_chars: int) -> str:
    context = re.sub(r"\s+", " ", continuation_context or "").strip()[:max_context_chars]
    return f"\n\nCONTINUATION CONTEXT:\n{context}" if context else ""


def run_digest(*, goal: str = "", effective_request: str = "",
               continuation_context: str = "", steps: list[dict[str, Any]], final_text: str,
               max_step_chars: int = 220, max_final_chars: int = 3000,
               max_context_chars: int = 1200) -> str:
    """Assemble a bounded transcript around the current effective request."""
    request = _effective_request(prompt=goal, effective_request=effective_request)
    lines = [f"EFFECTIVE REQUEST: {request}", ""]
    if continuation_context:
        context = re.sub(r"\s+", " ", continuation_context).strip()[:max_context_chars]
        lines += [f"CONTINUATION CONTEXT:\n{context}", ""]
    if steps:
        lines.append("TOOL STEPS:")
        for idx, step in enumerate(steps, 1):
            tool = step.get("tool", "?")
            ok = "ok" if step.get("ok") else "FAILED"
            args = step.get("args") or {}
            preview = args.get("path") or args.get("command") or args.get("pattern") or ""
            output = re.sub(r"\s+", " ", str(step.get("output") or step.get("error") or "")).strip()
            lines.append(f"  {idx}. {tool} [{ok}] {preview} — {output[:max_step_chars]}")
    else:
        lines.append("TOOL STEPS: (none — answered directly)")
    lines += ["", f"FINAL ANSWER:\n{final_text[:max_final_chars]}"]
    return "\n".join(lines)


def creative_prompt(*, prompt: str = "", effective_request: str = "", digest: str,
                    continuation_context: str = "", max_context_chars: int = 1200) -> str:
    """Divergent pass: propose candidate improvements to the draft answer."""
    request = _effective_request(prompt=prompt, effective_request=effective_request)
    return (
        "You are the CREATIVE editorial reviewer of an AI coding agent's completed "
        "run. Think DIVERGENTLY: propose candidate improvements, corrections, or "
        "clarifications to its draft final answer. Be breadth-first and evidence-aware. "
        "Do not turn completed work into a future plan, and include keeping the draft "
        "substantially as-is when it already answers the request well.\n\n"
        f"EFFECTIVE REQUEST: {request}\n\nRUN TRANSCRIPT:\n{digest}"
        f"{_context_block(continuation_context, max_context_chars)}\n\n"
        "Reply with a short numbered list of 2-5 candidate edits or editorial choices "
        "(one line each, no preamble). This is internal review, not the user-facing answer."
    )


def logical_prompt(*, prompt: str = "", effective_request: str = "", digest: str,
                   candidates: str, continuation_context: str = "",
                   max_context_chars: int = 1200) -> str:
    """Thesis/critic pass: stress-test the candidates against constraints + evidence."""
    request = _effective_request(prompt=prompt, effective_request=effective_request)
    return (
        "You are the LOGICAL editorial reviewer of an AI coding agent's completed "
        "run. A creative pass proposed candidate edits to the draft final answer. "
        "Stress-test each edit against the effective request, tool evidence, completion "
        "state, and claim boundaries. Reject edits that invent work, erase verified "
        "results, change a completed task into a next-step recommendation, or impose "
        "formatting the user did not request.\n\n"
        f"EFFECTIVE REQUEST: {request}\n\nRUN TRANSCRIPT:\n{digest}"
        f"{_context_block(continuation_context, max_context_chars)}\n\n"
        f"CREATIVE EDIT CANDIDATES:\n{candidates}\n\n"
        "Reply with a brief internal critique identifying only evidence-backed edits "
        "that improve the answer. Say explicitly when preserving the draft is strongest."
    )


def converge_prompt(*, prompt: str = "", effective_request: str = "", digest: str,
                    candidates: str, critique: str, response_style: str = "adaptive",
                    exact_output: bool = False, continuation_context: str = "",
                    max_context_chars: int = 1200) -> str:
    """Style-aware final-answer edit; creative and logical legs stay internal."""
    from agent.response_style import final_presentation_policy, resolve_response_style

    request = _effective_request(prompt=prompt, effective_request=effective_request)
    presentation = final_presentation_policy(
        resolve_response_style(request, response_style), exact_output=exact_output
    )
    return (
        "You are the FINAL ANSWER editor for an AI coding agent's completed run. "
        "A creative reviewer proposed candidate edits and a logical reviewer checked "
        "them against the evidence. Produce the best final answer to the operator's "
        "effective request—not a meta-review and not a recommendation for what the "
        "agent should do next.\n\n"
        f"EFFECTIVE REQUEST: {request}\n\nRUN TRANSCRIPT:\n{digest}"
        f"{_context_block(continuation_context, max_context_chars)}\n\n"
        f"CREATIVE EDIT CANDIDATES:\n{candidates}\n\nLOGICAL EDIT REVIEW:\n{critique}\n\n"
        "Return ONLY the final user-facing answer. Preserve the draft answer's natural "
        "Markdown structure, voice, level of detail, verified results, and completion "
        "state wherever they are sound; make only evidence-backed corrections. Do not "
        "mention this deliberation or the harness. Do not impose a fixed `Decision`, "
        "`Why`, `Caveat`, `Reasoning progress`, `Confidence`, or `中文摘要` template. "
        "Use headings or labels only when the effective request calls for them or they "
        "are genuinely useful to the answer itself.\n\n"
        f"{presentation}"
    )


def should_replace_primary(*, primary_text: str, conclusion_text: str,
                           exact_output: bool = False, conclusion_ok: bool = True) -> bool:
    """Return whether a deep-think conclusion may safely replace the primary answer."""
    return bool(conclusion_ok and not exact_output and (conclusion_text or "").strip())


def choose_final_text(*, primary_text: str, conclusion_text: str,
                      exact_output: bool = False, conclusion_ok: bool = True) -> str:
    """Choose the conclusion when usable, otherwise fail open to the primary answer."""
    if should_replace_primary(
        primary_text=primary_text,
        conclusion_text=conclusion_text,
        exact_output=exact_output,
        conclusion_ok=conclusion_ok,
    ):
        return conclusion_text
    return primary_text


def clip_leg(text: str, max_chars: int = _MAX_LEG_CHARS) -> str:
    """Bound a debate leg's text before feeding it into the next prompt."""
    return re.sub(r"\s+", " ", (text or "")).strip()[:max_chars]


def extract_confidence(text: str) -> str:
    """Pull a `Confidence: N/100` marker out of the synthesis, if present."""
    match = _CONFIDENCE_RE.search(text or "")
    return f"{int(match.group(1))}/100" if match else ""
