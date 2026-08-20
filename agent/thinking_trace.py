# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Thinking trace — an append-only, OTel-GenAI-aligned log of every LLM call's reasoning.

The harness already logs *decisions* (plan/step/critic/reflect → ``agent_runs/*.jsonl``).
This module adds the missing layer the operator actually asked for: the model's own
**thinking steps** — the reasoning tokens (Claude adaptive/extended thinking, DeepSeek/GLM
``reasoning_content``, ``<think>`` tags) that flow through ``agent.model.ModelClient.generate``
but were previously discarded. Because ``generate`` is the single choke point every LLM call
passes through, one sink here captures planner, step, reflect, and synthesis calls alike.

What this is — and is NOT
-------------------------
The captured reasoning is the model's *stated* chain of thought. The 2025-26 literature
(FaithCoT-Bench arXiv:2510.04040; Anthropic's CoT-monitorability work) shows stated CoT is
often *unfaithful* — a post-hoc rationalization, not the real cause of the answer. So this
trace is **evidence to be probed** (see :mod:`agent.faithfulness_probe`), never a ground-truth
record of how the model decided. The decision trace (``agent_runs``) is the ground truth of
what the system *did*; this is the softer signal of what it *said it was thinking*.

Schema (camelCase; the OTel GenAI semantic-convention name is given in parentheses)
-----------------------------------------------------------------------------------
``ts`` · ``traceId`` (trace_id) · ``spanId`` (span_id) · ``parentSpanId`` (parent_span_id)
``kind`` ("llm_call" | "a2a_message") · ``role`` · ``provider`` (gen_ai.system)
``model`` (gen_ai.request.model) · ``promptTokens`` (gen_ai.usage.input_tokens)
``completionTokens`` (gen_ai.usage.output_tokens) · ``reasoningTokens`` · ``finishReason``
(gen_ai.response.finish_reasons) · ``latencySec`` · ``costUsd`` · ``ok`` · ``error``.
Truncated-SHA-256 hashes (``systemHash``/``userHash``/``answerHash``/``reasoningHash`` — the
first 16 hex chars / 64 bits, enough to dedup/correlate without storing text) are ALWAYS
written; the verbatim text fields (``system``/``user``/``answer``/``reasoning``) are written ONLY when
``SOPHIA_CAPTURE_THINKING`` is set — so by default the trace is privacy-light (sizes + hashes)
and turns into a full reasoning record only when a run explicitly opts in.

Discipline (matches every ``agent/*`` module): offline, no third-party dep, fail-open (a
trace write must never break a generation), and deterministic given an injected trace id.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from agent.config import MEMORY_DIR

THINKING_DIR = MEMORY_DIR / "thinking"

# Current (traceId, parentSpanId) for nesting LLM-call spans under an agent step / A2A task.
# Default is empty; set_context() / trace_scope() populate it for the duration of a run.
_CTX: "ContextVar[tuple[str, str | None]]" = ContextVar("sophia_thinking_ctx", default=("", None))
_SPAN_SEQ = [0]  # process-global monotonic span counter (unique span ids within a process)
_DEFAULT_TRACE_ID: "str | None" = None  # memoized so the no-context default is STABLE per process


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _capture_verbatim() -> bool:
    """Store the raw text (system/user/answer/reasoning), not just hashes + sizes."""
    return (os.environ.get("SOPHIA_CAPTURE_THINKING") or "").strip().lower() in {"1", "true", "yes", "on"}


def _hash(text: str) -> str:
    """Truncated SHA-256 (first 16 hex chars / 64 bits) — enough to dedup/correlate
    without storing the text; NOT a full digest (see the module docstring)."""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:16]


def current_trace_id() -> str:
    tid, _ = _CTX.get()
    if tid:
        return tid
    env = (os.environ.get("SOPHIA_TRACE_ID") or "").strip()
    if env:
        return env
    # Memoize the generated default so EVERY call returns the same id — otherwise a fresh
    # uuid per call would scatter one run's spans across many files and break correlation.
    global _DEFAULT_TRACE_ID
    if _DEFAULT_TRACE_ID is None:
        _DEFAULT_TRACE_ID = "proc-" + uuid.uuid4().hex[:12]
    return _DEFAULT_TRACE_ID


def set_context(trace_id: str | None = None, parent_span_id: str | None = None) -> None:
    """Set the active trace/span context so subsequent records nest correctly.

    Pass an explicit ``trace_id`` to tie a run's LLM calls and A2A messages together
    (e.g. the harness task id, or a swarm parent id). Prefer :func:`trace_scope` when the
    context should be restored afterwards (it resets on exit)."""
    tid = (trace_id or current_trace_id())
    _CTX.set((tid, parent_span_id))


@contextmanager
def trace_scope(trace_id: str | None = None, parent_span_id: str | None = None) -> "Iterator[str]":
    """Set the trace context for the duration of a block, then RESTORE the prior context.

    Use around a delegation/swarm so its trace id does not leak into later, unrelated LLM
    calls or A2A spans in the same process (the context var is process-global)."""
    tid = trace_id or current_trace_id()
    token = _CTX.set((tid, parent_span_id))
    try:
        yield tid
    finally:
        _CTX.reset(token)


def _next_span_id() -> str:
    _SPAN_SEQ[0] += 1
    return f"sp{_SPAN_SEQ[0]:06d}"


def _trace_path(runs_dir: Path | None = None, trace_id: str | None = None) -> Path:
    base = runs_dir or THINKING_DIR
    return base / f"{trace_id or current_trace_id()}.jsonl"


def _write(record: dict[str, Any], runs_dir: Path | None = None, trace_id: str | None = None) -> None:
    # Use the record's OWN traceId for the filename so the span and its file never disagree.
    path = _trace_path(runs_dir, trace_id or record.get("traceId"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def record_generation(system: str, user: str, result: Any, *, role: str = "", runs_dir: Path | None = None) -> dict[str, Any]:
    """Write one ``llm_call`` span for a completed generation. ``result`` is a
    :class:`agent.model.ModelResult` (duck-typed so tests can pass a stub)."""
    tid, parent = _CTX.get()
    answer = getattr(result, "text", "") or ""
    reasoning = getattr(result, "reasoning_text", "") or ""
    record: dict[str, Any] = {
        "ts": _now(),
        "kind": "llm_call",
        "traceId": tid or current_trace_id(),
        "spanId": _next_span_id(),
        "parentSpanId": parent,
        "role": role,
        "provider": getattr(result, "provider", ""),
        "model": getattr(result, "model", ""),
        "ok": bool(getattr(result, "ok", True)),
        "error": getattr(result, "error", None),
        "promptTokens": getattr(result, "prompt_tokens", 0),
        "completionTokens": getattr(result, "completion_tokens", 0),
        "reasoningTokens": getattr(result, "reasoning_tokens", 0),
        "finishReason": getattr(result, "finish_reason", None),
        "costUsd": round(getattr(result, "cost_usd", 0.0) or 0.0, 6),
        "latencySec": round(getattr(result, "latency_sec", 0.0) or 0.0, 3),
        "systemHash": _hash(system),
        "userHash": _hash(user),
        "answerHash": _hash(answer),
        "reasoningHash": _hash(reasoning),
        "hasReasoning": bool(reasoning),
    }
    if _capture_verbatim():
        record.update({"system": system, "user": user, "answer": answer, "reasoning": reasoning})
    _write(record, runs_dir)
    return record


def record_lifecycle(*, event: str, run_id: str = "", session: str = "",
                     request_id: str = "", status: str = "", metadata: dict[str, Any] | None = None,
                     runs_dir: Path | None = None) -> dict[str, Any]:
    """Write a correlated lifecycle record without raw prompt/tool/reasoning payloads."""
    blocked = {"prompt", "prompts", "args", "arguments", "reasoning", "tool", "tool_args",
               "raw", "content", "response", "secret", "token"}
    def safe(value: Any, key: str = "") -> Any:
        if key.casefold() in blocked:
            return "[redacted]"
        if isinstance(value, dict):
            return {str(k): safe(v, str(k)) for k, v in value.items()
                    if str(k).casefold() not in blocked}
        if isinstance(value, (list, tuple)):
            return [safe(v, key) for v in value]
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        return str(value)
    record: dict[str, Any] = {
        "ts": _now(), "kind": "lifecycle", "event": str(event),
        "traceId": current_trace_id(), "spanId": _next_span_id(),
        "runId": str(run_id), "session": str(session), "requestId": str(request_id),
        "status": str(status),
    }
    if metadata:
        record["metadata"] = safe(metadata)
    _write(record, runs_dir)
    return record


def record_a2a_message(
    *,
    sender: str,
    receiver: str,
    prompt: str,
    response: str = "",
    ok: bool = True,
    gate: str | None = None,
    cost_usd: float = 0.0,
    kind: str = "delegate",
    runs_dir: Path | None = None,
) -> dict[str, Any]:
    """Write one ``a2a_message`` span — an inter-agent prompt+response in swarm/A2A mode.

    ``kind`` distinguishes the leg: ``delegate`` (parent→child task), ``result`` (child→parent
    answer), ``synthesis`` (reduce), or ``peer`` (networked A2A). ``gate`` carries the trust
    verdict (accept/abstain/block) when the message crossed a gate boundary."""
    tid, parent = _CTX.get()
    record: dict[str, Any] = {
        "ts": _now(),
        "kind": "a2a_message",
        "a2aKind": kind,
        "traceId": tid or current_trace_id(),
        "spanId": _next_span_id(),
        "parentSpanId": parent,
        "sender": sender,
        "receiver": receiver,
        "ok": bool(ok),
        "gate": gate,
        "costUsd": round(cost_usd or 0.0, 6),
        "promptHash": _hash(prompt),
        "responseHash": _hash(response),
    }
    if _capture_verbatim():
        record.update({"prompt": prompt, "response": response})
    _write(record, runs_dir)
    return record


def a2a_logging_enabled() -> bool:
    """A2A/swarm message logging rides the same opt-in switch as the thinking trace."""
    return bool((os.environ.get("SOPHIA_THINKING_LOG") or "").strip())


def maybe_record_a2a(**kwargs: Any) -> None:
    """Fail-open, opt-in wrapper for :func:`record_a2a_message` — a no-op unless
    SOPHIA_THINKING_LOG is set, and never raises into the swarm/A2A hot path."""
    if not a2a_logging_enabled():
        return
    try:
        if "runs_dir" not in kwargs:
            raw = (os.environ.get("SOPHIA_THINKING_LOG") or "").strip()
            if raw and raw.lower() not in {"1", "true", "yes", "on"}:
                kwargs["runs_dir"] = Path(raw)
        record_a2a_message(**kwargs)
    except Exception:  # noqa: BLE001
        pass


def sink_from_env() -> "Callable[[str, str, Any], None] | None":
    """Return a ``(system, user, result) -> None`` sink for ModelClient, honoring
    SOPHIA_THINKING_LOG (a directory path, or "1"/"on" for the default location)."""
    raw = (os.environ.get("SOPHIA_THINKING_LOG") or "").strip()
    if not raw:
        return None
    runs_dir = THINKING_DIR if raw.lower() in {"1", "true", "yes", "on"} else Path(raw)

    def _sink(system: str, user: str, result: Any) -> None:
        record_generation(system, user, result, role="generate", runs_dir=runs_dir)

    return _sink
