# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Deterministic resolution of a user's plain continuation request.

This module deliberately does not mutate or interpret the agent loop.  Callers
supply the current unfinished goal (if any) and a bounded transcript; resolution
returns the instruction to resume and where it came from.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

DEFAULT_MAX_MESSAGES = 64
DEFAULT_MAX_INSTRUCTION_CHARS = 8_000
_METADATA_KEY = "continuation"

_PLAIN_CONTINUATION = re.compile(
    r"^(?:(?:please|kindly)\s+)?(?:continue|go\s+on|keep\s+going|proceed|resume)[.!?]*$",
    re.IGNORECASE,
)
_INTERNAL_USER_PREFIXES = (
    "[tool:",
    "[auto-compacted ",
    "[auto-continue ",
    "[post-tool ",
    "[post_tool_",
    "the last tool `",
    "you just received output from `",
    "you announced an action but did not call a tool.",
    "this resumed task requires a fresh",
    "your latest report explicitly says",
    "stop narrating.",
    "original goal:",  # team/deep-think synthesis wrapper, not an operator turn
    # Conservative recovery instruction synthesized by this module after the
    # explicit operator goal was compacted out of the bounded transcript. It is
    # execution guidance, not a durable objective that may outrank later
    # transcript evidence.
    "continue the most recent unfinished operator objective represented in this session.",
)
_MUTABLE_STATE_SIGNAL_RE = re.compile(
    r"\b(?:monitor|watch|poll|track|status|pull request|pr\s*#?\d+|ci|"
    r"workflow|job|deploy(?:ed|ment|ing)?|release[sd]?|build|check(?:s)?)\b",
    re.IGNORECASE,
)
_MUTABLE_STATE_TIME_RE = re.compile(
    r"\b(?:current|latest|today|now|still|pending|open|closed|running|"
    r"merged?|deployed?|released?|completed?|finished?)\b",
    re.IGNORECASE,
)
_MUTABLE_STATE_SUBJECT_RE = re.compile(
    r"\b(?:state|status|version|branch|commit|issue|pull request|pr\s*#?\d+|"
    r"ci|check(?:s)?|workflow|job|build|deployment|release|process|session)\b",
    re.IGNORECASE,
)
SESSION_CONTEXT_CONTINUATION = (
    "Continue the most recent unfinished operator objective represented in this "
    "session. Treat prior assistant summaries and synthetic auto-continue or "
    "conclusion prompts as historical evidence, not authoritative current state. "
    "Inspect the recent transcript and tool evidence, refresh any mutable external "
    "state with tools before repeating status claims, and keep working until the "
    "objective is complete or genuinely blocked."
)


@dataclass(frozen=True)
class ContinuationResolution:
    """A resolved instruction and the precedence tier that supplied it."""

    instruction: str
    source: str
    requires_live_refresh: bool = False


def is_plain_continuation(text: object) -> bool:
    """Return whether *text* is only a narrow natural-language continuation.

    Slash commands and prompts containing any additional instruction are not
    continuations.  They remain ordinary user requests for the caller to handle.
    """
    if not isinstance(text, str):
        return False
    candidate = " ".join(text.strip().split())
    return bool(candidate) and not candidate.startswith("/") and bool(
        _PLAIN_CONTINUATION.fullmatch(candidate)
    )


def add_continuation_metadata(
    message: Mapping[str, Any], *, instruction: str
) -> dict[str, Any]:
    """Return a copied message with additive, unfulfilled continuation metadata."""
    copied = dict(message)
    metadata = dict(copied.get("metadata") or {})
    metadata[_METADATA_KEY] = {"instruction": instruction.strip(), "fulfilled": False}
    copied["metadata"] = metadata
    return copied


def mark_continuation_fulfilled(message: Mapping[str, Any]) -> dict[str, Any]:
    """Return a copied message whose existing continuation metadata is fulfilled."""
    copied = dict(message)
    metadata = dict(copied.get("metadata") or {})
    continuation = metadata.get(_METADATA_KEY)
    if isinstance(continuation, Mapping):
        continuation = dict(continuation)
        continuation["fulfilled"] = True
        metadata[_METADATA_KEY] = continuation
        copied["metadata"] = metadata
    return copied


def _bounded_instruction(value: object, max_chars: int) -> str | None:
    if not isinstance(value, str):
        return None
    instruction = value.strip()
    if not instruction or len(instruction) > max_chars:
        return None
    return instruction


def _continuation_metadata(message: Mapping[str, Any]) -> tuple[str | None, bool]:
    metadata = message.get("metadata")
    if not isinstance(metadata, Mapping):
        return None, False
    continuation = metadata.get(_METADATA_KEY)
    if not isinstance(continuation, Mapping):
        return None, False
    instruction = continuation.get("instruction")
    return (instruction if isinstance(instruction, str) else None,
            continuation.get("fulfilled") is True)


def _is_internal_user_content(content: str) -> bool:
    lowered = content.strip().lower()
    if lowered.startswith(_INTERNAL_USER_PREFIXES):
        return True
    # goal_harness.build_continuation_prompt() persists its prompt as a user-role
    # turn because the model must act on it. That makes it part of the auditable
    # transcript, but it is still kernel control text, not a new operator
    # request. Match the stable structure rather than one exact sentence so
    # harmless wording changes cannot make a wrapper authoritative again.
    if (
        lowered.startswith(
            "you are continuing work toward a goal across multiple turns."
        )
        and "\noriginal goal" in lowered
        and "\nprogress so far" in lowered
        and "\ninstructions:" in lowered
    ):
        return True
    return (
        lowered.startswith("active request:")
        and "\nyou executed " in lowered
        and "do not call more tools" in lowered
    )


def _requires_live_refresh(
    instruction: str, messages: Sequence[Mapping[str, Any]],
) -> bool:
    del messages  # reserved for future evidence-based refinement
    return bool(
        _MUTABLE_STATE_SIGNAL_RE.search(instruction)
        or (
            _MUTABLE_STATE_TIME_RE.search(instruction)
            and _MUTABLE_STATE_SUBJECT_RE.search(instruction)
        )
    )


def _has_resumable_session_context(messages: Sequence[Mapping[str, Any]]) -> bool:
    """Whether bounded history proves real work exists despite losing its goal.

    Auto-compaction can fold the only explicit operator objective into a
    synthetic summary. Tool feedback remains auditable evidence that the session
    was doing work, so a bare continuation should recover with a conservative
    session-context instruction instead of becoming the literal word "resume".
    """
    for message in messages:
        role = str(message.get("role") or "")
        content = str(message.get("content") or "").strip()
        if role == "tool" and content:
            return True
        if role != "user":
            continue
        lowered = content.lower()
        if lowered.startswith("[tool:") or lowered.startswith("[auto-compacted "):
            return True
    return False


def fulfill_latest_continuation(
    messages: Sequence[Mapping[str, Any]], *, instruction: str
) -> list[dict[str, Any]]:
    """Mark the newest matching continuation turn fulfilled.

    The running loop adds unfulfilled metadata before model/tool work begins, so
    cancellation remains resumable. The bridge calls this only after a terminal
    successful outcome; copying the list keeps caller-owned history immutable.
    """
    target = instruction.strip()
    copied = [dict(message) for message in messages]
    if not target:
        return copied
    for idx in range(len(copied) - 1, -1, -1):
        stored, fulfilled = _continuation_metadata(copied[idx])
        if stored == target and not fulfilled:
            copied[idx] = mark_continuation_fulfilled(copied[idx])
            break
    return copied


def _is_substantive_user_message(message: Mapping[str, Any]) -> bool:
    if message.get("role") != "user":
        return False
    content = str(message.get("content") or "").strip()
    if not content or is_plain_continuation(content):
        return False
    return not _is_internal_user_content(content)


def continuation_system_guidance(resolution: ContinuationResolution) -> str:
    """Return authoritative execution guidance for a resolved continuation."""
    refresh = (
        "- The task refers to mutable external state. Before repeating any prior "
        "status claim, use an appropriate read-only tool to refresh that state in "
        "this run. A prior assistant answer is not current evidence.\n"
        if resolution.requires_live_refresh
        else
        "- Verify what remains from current repository/session evidence instead of "
        "echoing the previous assistant answer.\n"
    )
    return (
        "\nContinuation contract:\n"
        f"- The operator's bare continuation resolves to: {resolution.instruction!r}.\n"
        "- Synthetic auto-continue, post-tool, and forced-conclusion turns are "
        "kernel control messages, never operator objectives.\n"
        f"{refresh}"
        "- Continue tool use until the objective is complete or genuinely blocked. "
        "If an execution slice ends first, report it as incomplete and resumable; "
        "do not present a checkpoint as successful completion.\n"
    )


def build_continuation_context(
    messages: Sequence[Mapping[str, Any]], *, effective_request: str,
    max_messages: int = 12, max_chars: int = DEFAULT_MAX_INSTRUCTION_CHARS,
) -> list[dict[str, Any]]:
    """Build a bounded lane/debate context without stale instruction wrappers.

    The effective request is authoritative and always first. Keep only recent
    genuine user requests and assistant outcomes; omit tool blobs, internal
    continuation/synthesis prompts, and system instructions. This is deliberately
    smaller than canonical coordinator history so fan-out does not multiply stale
    prompt authority or unbounded token cost.
    """
    request = _bounded_instruction(effective_request, max_chars)
    if request is None or max_messages <= 0 or max_chars <= 0:
        return []
    selected: list[dict[str, Any]] = []
    used = len(request)
    for message in reversed(list(messages)[-max_messages:]):
        role = str(message.get("role") or "")
        content = str(message.get("content") or "").strip()
        if role == "user":
            if not _is_substantive_user_message(message):
                continue
        elif role == "assistant":
            if not content or content.startswith("[deep-think conclusion]"):
                continue
        else:
            continue
        remaining = max_chars - used
        if remaining <= 0:
            break
        clipped = content[: min(remaining, 1200)]
        if not clipped:
            continue
        selected.append({"role": role, "content": clipped})
        used += len(clipped)
    selected.reverse()
    return [
        {"role": "user", "content": f"Active request: {request}"},
        *selected,
    ]


def resolve_continuation(
    prompt: object,
    messages: Sequence[Mapping[str, Any]],
    *,
    unfinished_goal: str | None = None,
    max_messages: int = DEFAULT_MAX_MESSAGES,
    max_instruction_chars: int = DEFAULT_MAX_INSTRUCTION_CHARS,
) -> ContinuationResolution | None:
    """Resolve a plain continuation using fixed precedence and bounded history.

    Precedence is current unfinished goal, newest unfulfilled transcript metadata,
    then newest substantive user request.  A fulfilled metadata instruction is a
    tombstone: an exact matching stale goal/request is never reactivated.
    """
    if not is_plain_continuation(prompt) or max_messages <= 0 or max_instruction_chars <= 0:
        return None

    bounded = list(messages[-max_messages:])
    fulfilled: set[str] = set()
    fulfilled_cutoff = -1
    metadata_candidate: str | None = None
    for idx in range(len(bounded) - 1, -1, -1):
        message = bounded[idx]
        instruction, is_fulfilled = _continuation_metadata(message)
        instruction = _bounded_instruction(instruction, max_instruction_chars)
        if instruction is None or _is_internal_user_content(instruction):
            continue
        if is_fulfilled:
            fulfilled.add(instruction)
            if fulfilled_cutoff < 0:
                # A fulfilled continuation consumes the conversation before it.
                # Future plain "continue" requests may resume a NEWER request,
                # but must not walk farther back to stale tasks or formatting
                # constraints that predate the completed run.
                fulfilled_cutoff = idx
        elif (idx > fulfilled_cutoff
              and metadata_candidate is None
              and instruction not in fulfilled):
            metadata_candidate = instruction

    goal = _bounded_instruction(unfinished_goal, max_instruction_chars)
    if goal is not None and _is_internal_user_content(goal):
        goal = None
    if goal is not None and goal not in fulfilled:
        return ContinuationResolution(
            goal,
            "unfinished_goal",
            _requires_live_refresh(goal, bounded),
        )
    if metadata_candidate is not None:
        return ContinuationResolution(
            metadata_candidate,
            "transcript_metadata",
            _requires_live_refresh(metadata_candidate, bounded),
        )

    for message in reversed(bounded[fulfilled_cutoff + 1:]):
        if not _is_substantive_user_message(message):
            continue
        instruction = _bounded_instruction(message.get("content"), max_instruction_chars)
        if instruction is not None and instruction not in fulfilled:
            return ContinuationResolution(
                instruction,
                "latest_user_request",
                _requires_live_refresh(instruction, bounded),
            )
    if fulfilled_cutoff < 0 and _has_resumable_session_context(bounded):
        return ContinuationResolution(
            SESSION_CONTEXT_CONTINUATION,
            "session_context",
            True,
        )
    return None
