# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Adaptive response-presentation policy, separate from agent work policy.

The helpers classify only the current effective request. They do not weaken tool,
safety, permission, verification, or no-overclaim requirements.
"""
from __future__ import annotations

import re
from typing import Literal

ResponseStyle = Literal["adaptive", "concise", "explanatory", "structured"]
ResolvedResponseStyle = Literal["concise", "explanatory", "structured"]

_STYLES = frozenset({"adaptive", "concise", "explanatory", "structured"})
_EXACT_OUTPUT_PATTERNS = (
    # A literal follows ``exactly`` (often after a colon); no extra prose may be
    # added even when the request omits the redundant words "nothing else".
    re.compile(r"\b(?:reply|respond|output|return|print|emit|give)\b[^\n.]{0,40}\bexactly\s*:\s*\S[^\n.]*$", re.I),
    re.compile(r"\b(?:reply|respond|say|output|return|print|emit|give)\b[^\n.]{0,80}\bexactly\b(?:\s+with)?[^\n.]{1,100}\.?$", re.I),
    re.compile(r"\b(?:reply|respond|output|return|print|emit|give)\b[^\n.]{0,80}\bexactly\b[^\n.]{0,80}\b(?:nothing else|only)\b", re.I),
    re.compile(r"\b(?:reply|respond|output|return|print|emit|give)\b[^\n.]{0,60}\b(?:only|just)\b[^\n.]{0,80}\b(?:no markdown|nothing else|without (?:an? )?(?:explanation|commentary|preamble))\b", re.I),
    # A terminal-style assignment literal is itself an explicit answer shape.
    # Require immediate sentence termination so requests such as "report
    # `KEY=value` and explain why" keep normal presentation.
    re.compile(
        r"\b(?:report|return|output|print|emit)\s+"
        r"`[A-Za-z][A-Za-z0-9_.-]*=[^`\r\n]+`\s*"
        r"(?:[.!?]\s*)?(?:do not modify files\.?\s*)?$",
        re.I,
    ),
    re.compile(
        r"\b(?:return|output|print|emit|give)\s+exactly\s+(?:one|1)\s+line\b"
        r"[^\r\n]*(?:do not modify files\.?\s*)?$",
        re.I,
    ),
)


def is_exact_output_request(current_request: str) -> bool:
    """Detect explicit output-shape constraints in the current request only.

    Detection is intentionally conservative: words such as ``exact`` or ``only``
    alone do not suppress normal final presentation.
    """
    text = " ".join((current_request or "").split())
    return bool(text and any(pattern.search(text) for pattern in _EXACT_OUTPUT_PATTERNS))


def resolve_response_style(current_request: str, requested: str | None = "adaptive") -> ResolvedResponseStyle:
    """Resolve an explicit style or adapt presentation to the current request."""
    style = (requested or "adaptive").strip().lower()
    if style not in _STYLES:
        style = "adaptive"
    if style != "adaptive":
        return style  # type: ignore[return-value]

    text = " ".join((current_request or "").lower().split())
    if is_exact_output_request(current_request) or re.search(
        r"\b(?:brief|briefly|concise|one (?:word|sentence|line)|short answer)\b", text
    ):
        return "concise"
    if re.search(r"\b(?:compare|trade-?offs?|options|plan|steps|checklist|table|migration)\b", text):
        return "structured"
    if re.search(r"\b(?:explain|why|how|teach|walk me through|reason)\b", text):
        return "explanatory"
    return "concise"


def working_policy() -> str:
    """Style-neutral execution requirements that always remain in force."""
    return (
        "## Working policy\n\n"
        "Solve and verify the task before presenting it. Preserve all safety, permission, "
        "tool-use, evidence, and no-overclaim requirements regardless of response style. "
        "Presentation preferences never change what work is required or what may be claimed."
    )


def final_presentation_policy(style: str, *, exact_output: bool = False) -> str:
    """Return final-answer guidance without imposing visible global boilerplate."""
    if exact_output:
        return (
            "## Final presentation policy\n\n"
            "Exact-output request detected. Preserve the requested output exactly. Do not add "
            "headings, explanations, confidence labels, preambles, or trailing commentary."
        )
    resolved = resolve_response_style("", style)
    guidance = {
        "concise": "Lead with the outcome and include only the details needed to use or verify it.",
        "explanatory": "Lead with the outcome, then explain the key reasoning and evidence in clear prose.",
        "structured": "Lead with the outcome, then organize material with useful sections or lists.",
    }[resolved]
    return (
        "## Final presentation policy\n\n"
        f"Use the {resolved} presentation style. {guidance} "
        "Do not add a fixed reasoning or confidence section unless the current request requires one."
    )


__all__ = [
    "ResponseStyle",
    "ResolvedResponseStyle",
    "is_exact_output_request",
    "resolve_response_style",
    "working_policy",
    "final_presentation_policy",
]
