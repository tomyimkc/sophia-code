# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""The Sophia Agents tool-use loop — the OpenClaw/Hermes-style engine.

Given a goal and a model client, repeatedly ask the model what to do. If it emits a
tool call, execute it (permission-gated + secret-redacted via ``agent.agent_tools``)
and feed the result back; when it stops calling tools, apply the selected
final-answer delivery policy and return it. General harness callers retain the
Phase-0 floor; Sophia Code can explicitly select off, advisory report, floor, or
strict enforcement. Every hop is traced to JSONL.

Protocol is text-based and provider-agnostic by default. Endpoints explicitly
marked as requiring native tool transcripts (DS4/Pulsar) instead receive their
assistant ``tool_calls`` turn and bound ``role=tool`` results on continuation;
that wire-only transcript is not persisted as session history. A text-protocol
model calls a tool by emitting a JSON object::

    {"tool": "read_file", "args": {"path": "agent/harness.py"}}

Any assistant turn with no parseable tool call is taken as the final answer. Cross-
turn memory is carried by passing the returned ``messages`` back in as ``history``
(the REPL does this), so a session is a running conversation.

candidateOnly; canClaimAGI:false — capability plumbing wrapped in Sophia's gate.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from agent.agent_tools import (
    ToolContext,
    all_tools,
    execute_tool,
    tool_function_schemas,
    tool_specs_text,
)
from agent import epistemic_status
from agent.edition import edition_skips_conscience_gate
from agent.harness import AgentResult
from tools.redact_secrets import redact as _redact_secrets
from agent.execution_budget import BudgetRejected, ExecutionBudget, RejectionReason, Usage
from agent.orchestration_first import partition_tool_calls
from agent.tool_loop_efficiency import (
    FEEDBACK_CHAR_CAP,
    EfficiencyTracker,
    budget_feedback,
)
from agent.sophia_harness import (
    compile_system_prompt,
    failure_recall_system_extra,
    lessons_from_run,
    write_process_log,
)
from agent.personal_harness import (
    PERSONAL_TOOL_NAMES,
    PersonalHarnessConfig,
    load_harness_config,
    prepare_harness_selection,
    write_harness_receipt,
)

AGENT_SYSTEM = """You are Sophia Agents, a careful terminal coding agent working in \
the repository rooted at {root}.

You accomplish the user's goal by using tools, one step at a time. To use a tool, \
reply with ONE JSON object and nothing else:
  {{"tool": "<name>", "args": {{...}}}}
When you have finished, reply with your final answer as plain prose (NO JSON object).

{tools}

Rules:
- Investigate with read-only tools before you write or run anything.
- Make the smallest change that accomplishes the goal; do not invent requirements.
- The Sophia bridge has already published this run's Goal to the UI. A Goal is
  not a callable tool: when the operator asks to create or publish one, treat
  that UI Goal as already created. Do not search for a `goal` shell command or
  emulate Goal creation with another tool; use only the listed tools for the
  remaining requested work.
- Never claim a result you did not verify. This project's discipline is \
canClaimAGI:false and no-overclaim — state uncertainty plainly.
- Do not use web_fetch as a search engine and do not fetch Google/Bing homepages.
  Use web_fetch only for a specific source URL supplied by the user or clearly
  needed as evidence; for subjective/chat prompts, answer directly.
- Follow the current final-presentation policy. Do not force a fixed reasoning
  section, confidence label, or other harness boilerplate unless the user's
  request or selected response style calls for it.
- Follow Sophia's logical-thinking discipline: Socratic assumption checks,
  Aristotelian premise-to-conclusion clarity, Confucian rectification of names
  (do not merge lineages), Daoist humility/abstention under uncertainty,
  Peircean abduction labelled as hypothesis, Humean causal caution, Kantian
  boundary-setting, and Wittgensteinian term-use clarification.
- write_file / edit_file / bash may require operator approval; if a tool is denied, \
adapt or explain what you would need.{extra}"""

# Tool execution liveness is deliberately separate from provider_wait in
# code_bridge.py: a model call and an offline repository traversal are different
# blocking domains. The event payload is closed and content-free — no args,
# paths, patterns, output, prompts, or credentials.
TOOL_WAIT_INTERVAL_SEC = 20.0
TOOL_WAIT_MAX_EVENTS = 16
TOOL_WAIT_POLL_SEC = 0.25


@dataclass
class AgentLoopResult:
    goal: str
    final_text: str
    ok: bool
    steps: list[dict] = field(default_factory=list)      # one per executed tool call
    messages: list[dict] = field(default_factory=list)    # full transcript (carry as history)
    gated: bool = False                                   # True if the delivery gate downgraded
    trace_path: str = ""
    model_error: str | None = None                        # set when the model transport itself failed
    correlation: dict[str, str] = field(default_factory=dict)
    epistemic: dict = field(default_factory=dict)         # what the gate actually checked
    # Summed across every model call this run made (main-loop turns, nudges,
    # auto-continue, and the conclusion pass). ``None`` — not 0 — means the
    # client never reported the field at all (see ``_accumulate_usage``), so a
    # caller can show "unavailable" instead of a fabricated zero.
    cost_usd: float | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    # A bounded execution slice may end with a useful checkpoint report while
    # the operator's objective is still explicitly unfinished. That is not a
    # successful terminal answer; callers keep it resumable and must not emit a
    # succeeded receipt.
    incomplete: bool = False
    incomplete_reason: str | None = None
    # ``None`` preserves the legacy contract: an incomplete result that did
    # not classify its stop is resumable. Completion authority stamps an
    # explicit bool when a bound/denied/unverifiable stop has no safe next step.
    resumable: bool | None = None


# --------------------------------------------------------------------------- #
# Parsing the model's action
# --------------------------------------------------------------------------- #
def _iter_json_objects(text: str):
    """Yield candidate JSON-object substrings: fenced ```json blocks first, then any
    brace-balanced span. Handles nested braces (tool args that are objects)."""
    for m in re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL):
        yield m
    depth, start = 0, None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                yield text[start: i + 1]
                start = None


def parse_action(text: str) -> tuple[str, Any, Any]:
    """Return ("tool", name, args) if the model asked for a tool, else ("final", text, None)."""
    for candidate in _iter_json_objects(text):
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            if "tool" in obj and isinstance(obj.get("tool"), str):
                args = obj.get("args") or obj.get("arguments") or {}
                return ("tool", obj["tool"], args if isinstance(args, dict) else {})
            if "final" in obj:
                return ("final", str(obj["final"]), None)
    return ("final", text.strip(), None)


def _visible_assistant_prose(text: Any) -> bool:
    """Whether *text* should be painted in the live TUI as assistant prose.

    Synthetic placeholders like ``[native tool calls: N]`` are for the model
    transcript only and must not appear as empty-looking chat rows.
    """
    body = str(text or "").strip()
    if not body:
        return False
    if body.startswith("[native tool calls"):
        return False
    if body.startswith("[incomplete native"):
        return False
    return True


def _native_tool_call(call: dict) -> tuple[str, dict]:
    """Normalize a provider-native tool/function call to ``(name, args)``.

    ``agent.model`` surfaces Anthropic calls as ``{"name": ..., "arguments":
    dict}`` and OpenAI-compatible calls as ``{"name": ..., "arguments":
    "<json>"}``. Nested OpenAI ``function.{name,arguments}`` is also accepted.
    Malformed arguments fail closed to an empty dict; empty names are returned
    as ``""`` so the loop can drop incomplete parallel slots (common on local
    Qwen/vLLM multi-tool batches) instead of executing ``unknown tool ''``.
    """
    if not isinstance(call, dict):
        return "", {}
    fn = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = str(call.get("name") or fn.get("name") or "").strip()
    raw_args = call.get("arguments")
    if raw_args is None:
        raw_args = call.get("input")
    if raw_args is None:
        raw_args = fn.get("arguments") if fn else {}
    if raw_args is None:
        raw_args = {}
    if isinstance(raw_args, str):
        try:
            parsed = json.loads(raw_args) if raw_args.strip() else {}
        except json.JSONDecodeError:
            # Some local models wrap args as a bare path string; map to path when
            # the tool is path-oriented so a second turn can still recover.
            parsed = {"path": raw_args.strip()} if raw_args.strip() and name in {
                "read_file", "write_file", "edit_file", "list_dir", "outline", "glob",
            } else {}
        args = parsed if isinstance(parsed, dict) else {}
    elif isinstance(raw_args, dict):
        args = raw_args
    else:
        args = {}
    return name, args


def _native_tool_transcript_call(
    call: dict,
) -> tuple[tuple[str, dict] | None, dict | None, dict | None]:
    """Validate one strict OpenAI-compatible tool call.

    DS4 continuation messages bind every tool result to the assistant call by
    ID. Unlike the provider-agnostic compatibility parser above, this path
    never guesses malformed arguments or drops a missing identifier: either it
    returns both an executable ``(name, args)`` pair and an exact wire call, or
    it returns an audit reason and nothing is executed.
    """
    if not isinstance(call, dict):
        return None, None, {"tool": "", "reason": "invalid_tool_call"}
    fn = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = str(call.get("name") or fn.get("name") or "").strip()
    call_id = str(call.get("id") or fn.get("id") or "").strip()
    if not name:
        return None, None, {"tool": "", "toolCallId": call_id, "reason": "empty_tool_name"}
    if not call_id:
        return None, None, {"tool": name, "reason": "missing_tool_call_id"}

    raw_args = call.get("arguments")
    if raw_args is None:
        raw_args = call.get("input")
    if raw_args is None:
        raw_args = fn.get("arguments")
    if isinstance(raw_args, str):
        if not raw_args.strip():
            return None, None, {
                "tool": name,
                "toolCallId": call_id,
                "reason": "missing_tool_arguments",
            }
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError:
            return None, None, {
                "tool": name,
                "toolCallId": call_id,
                "reason": "invalid_arguments_json",
            }
        if not isinstance(parsed, dict):
            return None, None, {
                "tool": name,
                "toolCallId": call_id,
                "reason": "arguments_not_object",
            }
        args = parsed
        arguments_json = raw_args
    elif isinstance(raw_args, dict):
        args = raw_args
        arguments_json = json.dumps(raw_args, ensure_ascii=False, separators=(",", ":"))
    else:
        return None, None, {
            "tool": name,
            "toolCallId": call_id,
            "reason": "missing_tool_arguments",
        }

    wire_call = {
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": arguments_json,
        },
    }
    return (name, args), wire_call, None


def _filter_native_calls(calls: list[tuple[str, dict]]) -> tuple[list[tuple[str, dict]], list[dict]]:
    """Drop empty-name native tool slots; return (valid, skipped_audit).

    Local Qwen/vLLM with parallel tool-calls often emits extra empty slots
    (``name=""``, ``args={}``) alongside real calls. Executing those pollutes
    the transcript with ``unknown tool ''`` and steers the model into a failure
    spiral. Schema-invalid calls with a real name are still executed so the tool
    layer can return structured, retryable errors the model can correct.
    """
    valid: list[tuple[str, dict]] = []
    skipped: list[dict] = []
    for name, args in calls:
        if not name:
            skipped.append({"tool": "", "reason": "empty_tool_name", "args": args})
            continue
        valid.append((name, args if isinstance(args, dict) else {}))
    return valid, skipped


#: Explicit override for the short native-tool-calling protocol (see
#: ``_use_short_tool_protocol``). ``1``/``true``/``yes``/``on`` forces the short
#: form for any resolved provider; ``0``/``false``/``no``/``off`` forces the
#: full prose form even on a local native-tool model. Unset (the default)
#: auto-detects from the resolved provider's own capability manifest.
_SHORT_TOOL_PROTOCOL_ENV = "SOPHIA_SHORT_TOOL_PROTOCOL"


def _use_short_tool_protocol(client: Any, *, native_tools_present: bool) -> bool:
    """True when this run should send ``SHORT_TOOL_PROTOCOL`` instead of the
    full per-tool prose block.

    Reproduced 5/5 against ``vllm:mlx-community--Qwen3-4B-Instruct-2507-4bit``
    (the small local model this environment ships): Sophia's full system
    prompt duplicates every tool's name/description/parameters in prose on top
    of the native ``tools=`` schema the transport already sends, and that
    model's tool-call emission degrades to malformed or empty calls with both
    present. A transport that received no native schema at all
    (``native_tools_present=False`` — the text-JSON fallback) still needs the
    full prose; it has no schema to fall back on.

    Gated to LOCAL providers by default, via the same capability manifest
    (``agent.model.provider_capabilities`` / ``is_local_model``) that already
    decides other cloud-vs-local feature gates elsewhere in this codebase:
    there is no reproduction showing the redundant prose hurts a cloud or
    frontier API model, so shrinking their prompt on a guess would risk silently
    changing tool-selection behavior on a path this fix does not own. Codex CLI
    is the measured exception: its structured-envelope adapter receives the
    same native schema out of band, and duplicating the full prose inflated the
    one-tool smoke prompt while the old transport ignored the schema entirely.
    ``SOPHIA_SHORT_TOOL_PROTOCOL=1``/``0`` lets an operator force either
    direction (e.g. to test a cloud model under the short form, or to keep the
    full form on a local model that turns out to need it).
    """
    override = (os.environ.get(_SHORT_TOOL_PROTOCOL_ENV) or "").strip().lower()
    if override in {"1", "true", "yes", "on"}:
        return True
    if override in {"0", "false", "no", "off"}:
        return False
    if not native_tools_present:
        return False
    primary = getattr(client, "primary", None)
    if primary is None:
        return False
    try:
        from agent.model import provider_capabilities

        caps = provider_capabilities(primary)
    except Exception:
        # A capability-manifest failure (unresolvable spec, exotic test double)
        # must never block the run; fall back to the always-safe full form.
        return False
    return bool(caps.tools and (caps.local or caps.transport == "codex"))


def _auto_compact_enabled() -> bool:
    raw = (os.environ.get("SOPHIA_AUTO_COMPACT") or "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


#: Fraction of a model's context window to fill before compacting.
#:
#: 80% is not arbitrary: it is the threshold the grok CLI itself uses
#: (``auto_compact_threshold_percent: 80`` in its model cache), so a Sophia
#: session and a bare grok session agree about when a conversation is full.
#: The remaining 20% is headroom for the system prompt, reasoning, and the
#: generation itself — none of which are in the history being measured.
AUTO_COMPACT_WINDOW_FRACTION = 0.80

#: Used only when the model declares no window. Sized for local Qwen3.6-35B at
#: native 256K on the Spark (vLLM --max-model-len 262144). It is a floor for the
#: UNKNOWN case, never a ceiling for a model that told us its real size — that
#: conflation is what capped a 500K model at 200K.
AUTO_COMPACT_FALLBACK_TOKENS = 200_000


def _auto_compact_budget(context_window: int | None = None) -> int:
    """Token budget for the *whole* message list the model sees.

    Derived from the ACTIVE model's window rather than fixed, because a constant
    is wrong in both directions: it wasted 60% of grok-4.5's 500K window, and it
    would overflow a 32K model. Precedence:

      1. ``SOPHIA_AUTO_COMPACT_TOKENS`` — an explicit operator override wins.
      2. ``context_window * AUTO_COMPACT_WINDOW_FRACTION`` when the model
         declares a window (see ``ModelConfig.context_window``).
      3. ``AUTO_COMPACT_FALLBACK_TOKENS`` when it does not.

    Set ``SOPHIA_AUTO_COMPACT=0`` to disable compaction entirely.
    """
    raw = os.environ.get("SOPHIA_AUTO_COMPACT_TOKENS")
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value

    if context_window and context_window > 0:
        return max(1, int(context_window * AUTO_COMPACT_WINDOW_FRACTION))
    return AUTO_COMPACT_FALLBACK_TOKENS


def _estimate_messages_tokens(messages: list[dict]) -> int:
    from agent.context_manager import estimate_tokens

    total = 0
    for message in messages:
        # Native continuation turns carry material outside ``content``. Count
        # those fields so DS4 tool arguments/reasoning cannot silently bypass
        # the same context budget applied to the persisted transcript.
        if (
            message.get("role") == "tool"
            or message.get("tool_calls")
            or message.get("reasoning_content")
        ):
            rendered = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        else:
            rendered = str(message.get("content") or "")
        total += estimate_tokens(rendered)
    return total


def _compact_messages(messages: list[dict], *, budget_tokens: int | None = None,
                      context_window: int | None = None) -> tuple[list[dict], dict]:
    """Auto-compact a growing tool-use transcript under a token budget.

    Keeps the system prompt and the most recent turns intact; folds older
    assistant/tool turns into a single auditable ``[auto-compacted …]`` user
    message via deterministic head+tail elision (no model call). Returns
    ``(messages, audit)`` — ``audit`` is empty when no compaction ran.
    """
    from agent.context_manager import estimate_tokens, head_tail_compress

    budget = budget_tokens if budget_tokens is not None else _auto_compact_budget(context_window)
    if not messages or not _auto_compact_enabled():
        return messages, {}
    total = _estimate_messages_tokens(messages)
    if total <= budget:
        return messages, {}

    system = [m for m in messages if m.get("role") == "system"][:1]
    rest = [m for m in messages if m.get("role") != "system"]
    try:
        keep_recent = max(2, int(os.environ.get("SOPHIA_COMPACT_KEEP_RECENT", "8")))
    except ValueError:
        keep_recent = 8

    if len(rest) <= keep_recent:
        # Still over budget: compress large tool-result payloads in place.
        compressed: list[dict] = []
        for m in rest:
            content = str(m.get("content") or "")
            is_tool_feedback = (
                m.get("role") == "tool"
                or (m.get("role") == "user" and content.startswith("[tool:"))
            )
            if is_tool_feedback and estimate_tokens(content) > 800:
                compressed.append({
                    **m,
                    "content": head_tail_compress(content, 600, counter=estimate_tokens),
                })
            else:
                compressed.append(m)
        out = system + compressed
        return out, {
            "compacted": True,
            "mode": "in_place_tool_trim",
            "beforeTokens": total,
            "afterTokens": _estimate_messages_tokens(out),
            "budgetTokens": budget,
            # Carried so a client can say "19% of 500K" instead of a bare token
            # count. None when the model declares no window — the UI then shows
            # no percentage rather than one computed against a guess.
            "contextWindow": context_window or None,
        }

    tail_start = len(rest) - keep_recent
    # OpenAI-compatible role=tool messages are invalid without their preceding
    # assistant tool_calls turn. If the nominal boundary lands inside a native
    # result batch, move it back to the owning assistant message.
    while tail_start > 0 and rest[tail_start].get("role") == "tool":
        tail_start -= 1
    head, tail = rest[:tail_start], rest[tail_start:]
    parts: list[str] = []
    for m in head:
        role = str(m.get("role") or "?")
        content = str(m.get("content") or "")
        if role == "user" and content.startswith("[tool:"):
            # Keep tool name + short body so the model still sees what ran.
            first_line, _, body = content.partition("\n")
            body_preview = body.strip().replace("\n", " ")
            if len(body_preview) > 280:
                body_preview = body_preview[:280] + "…"
            parts.append(f"{first_line} {body_preview}".strip())
        elif role == "tool":
            preview = content.replace("\n", " ").strip()
            if len(preview) > 280:
                preview = preview[:280] + "…"
            parts.append(f"[tool:{m.get('name') or '?'}] {preview}".strip())
        elif role == "assistant":
            preview = content.replace("\n", " ").strip()
            if len(preview) > 180:
                preview = preview[:180] + "…"
            parts.append(f"[assistant] {preview}")
        else:
            preview = content.replace("\n", " ").strip()
            if len(preview) > 180:
                preview = preview[:180] + "…"
            parts.append(f"[{role}] {preview}")

    summary_budget = max(400, budget // 5)
    summary = (
        "[auto-compacted earlier transcript — older tool turns elided for context budget; "
        "recent turns below are intact]\n"
        + "\n".join(parts)
    )
    if estimate_tokens(summary) > summary_budget:
        summary = head_tail_compress(summary, summary_budget, counter=estimate_tokens)

    out = system + [{"role": "user", "content": summary}] + tail
    # If still over, trim tool payloads in the recent tail too.
    if _estimate_messages_tokens(out) > budget:
        trimmed_tail: list[dict] = []
        for m in tail:
            content = str(m.get("content") or "")
            is_tool_feedback = (
                m.get("role") == "tool"
                or (m.get("role") == "user" and content.startswith("[tool:"))
            )
            if is_tool_feedback and estimate_tokens(content) > 600:
                trimmed_tail.append({
                    **m,
                    "content": head_tail_compress(content, 500, counter=estimate_tokens),
                })
            else:
                trimmed_tail.append(m)
        out = system + [{"role": "user", "content": summary}] + trimmed_tail

    return out, {
        "compacted": True,
        "mode": "fold_older_turns",
        "beforeTokens": total,
        "afterTokens": _estimate_messages_tokens(out),
        "budgetTokens": budget,
        # See the in_place_tool_trim audit above.
        "contextWindow": context_window or None,
        "foldedTurns": len(head),
        "keptRecent": len(tail),
    }


# --------------------------------------------------------------------------- #
# Trace + gate
# --------------------------------------------------------------------------- #
def _default_trace_path() -> str:
    from agent import harness as _h
    d = Path(_h.RUNS_DIR) / "agent_loop"
    d.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    return str(d / f"loop-{stamp}.jsonl")


def _safe_event(event: dict) -> dict:
    """Return an event safe to emit or persist without exposing secret-shaped values."""
    try:
        return json.loads(_redact_secrets(json.dumps(event, ensure_ascii=False)))
    except (TypeError, json.JSONDecodeError):
        return {"type": str(event.get("type") or "event"), "error": "event redaction failed"}


_CONCLUSION_EVIDENCE_MAX_STEPS = 12
_CONCLUSION_EVIDENCE_MAX_CHARS = 24_000
_CONCLUSION_EVIDENCE_MIN_STEP_CHARS = 1_200
_CONCLUSION_EVIDENCE_MAX_STEP_CHARS = 4_000


def _head_tail_evidence(text: str, limit: int) -> str:
    """Keep both ends of one tool result inside a deterministic bound.

    Source reads often place a function signature near the beginning and the
    decisive return/error branch near the end. Prefix-only clipping hid that
    second half from the reserved answer-only call even though the worker had
    already read it.
    """
    value = str(text or "").strip()
    if len(value) <= limit:
        return value
    marker = f"\n… [middle omitted: {len(value) - limit} chars] …\n"
    remaining = max(0, limit - len(marker))
    head = remaining // 2
    tail = remaining - head
    return value[:head] + marker + (value[-tail:] if tail else "")


def _read_batch_conclusion_evidence(text: str, limit: int) -> str:
    """Compact every read_batch child instead of retaining only the first row."""
    try:
        payload = json.loads(str(text or ""))
    except (TypeError, json.JSONDecodeError):
        return _head_tail_evidence(text, limit)
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        return _head_tail_evidence(text, limit)

    rows = [row for row in payload["results"] if isinstance(row, dict)]
    if not rows:
        return _head_tail_evidence(text, limit)
    header = (
        f"read_batch count={payload.get('count', len(rows))} "
        f"workers={payload.get('workers', 1)}"
    )
    row_budget = max(
        240,
        (limit - len(header) - (len(rows) * 80)) // len(rows),
    )
    rendered = [header]
    for row in rows:
        body = row.get("output") if row.get("ok") else row.get("error")
        rendered.append(
            f"[{row.get('index', '?')}:{row.get('tool', 'tool')} "
            f"{'ok' if row.get('ok') else 'failed'}]\n"
            + _head_tail_evidence(str(body or ""), row_budget)
        )
    return _head_tail_evidence("\n\n".join(rendered), limit)


def _conclusion_tool_evidence(
        steps: list[dict[str, Any]],
        feedback_cap: int | None,
) -> str:
    """Build a bounded but source-usable digest for the final answer call."""
    selected = list(steps[-_CONCLUSION_EVIDENCE_MAX_STEPS:])
    if not selected:
        return "(no tool calls)"
    requested = int(feedback_cap or 0)
    total_cap = min(
        _CONCLUSION_EVIDENCE_MAX_CHARS,
        requested if requested > 0 else FEEDBACK_CHAR_CAP,
    )
    per_step = max(
        _CONCLUSION_EVIDENCE_MIN_STEP_CHARS,
        min(
            _CONCLUSION_EVIDENCE_MAX_STEP_CHARS,
            total_cap // len(selected),
        ),
    )
    evidence: list[str] = []
    first_index = max(1, len(steps) - len(selected) + 1)
    for index, step in enumerate(selected, start=first_index):
        status = "ok" if step.get("ok") else "failed"
        tool = str(step.get("tool") or "tool")
        body = str(step.get("output") or step.get("error") or "").strip()
        excerpt = (
            _read_batch_conclusion_evidence(body, per_step)
            if tool == "read_batch"
            else _head_tail_evidence(body, per_step)
        )
        evidence.append(
            f"{index}. {tool} [{status}]"
            + (f"\n{excerpt}" if excerpt else "")
        )
    return _head_tail_evidence("\n\n".join(evidence), total_cap)


def _trace(trace_path: str, event: dict) -> None:
    try:
        with open(trace_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(), **_safe_event(event)}) + "\n")
    except Exception:
        # Tracing is best-effort bookkeeping; it must not crash the agent loop.
        pass


def _parliament_disagreement(decision: Any) -> float | None:
    """The moral parliament's variance across theories, when it ran.

    Reported instead of a confidence scalar: the human-factors literature finds
    a bare confidence number can increase over-reliance, while disagreement is
    both rarer and more actionable.
    """
    conscience = getattr(decision, "conscience", None)
    if not isinstance(conscience, dict):
        return None
    for key in ("moralParliament", "parliament", "moral"):
        node = conscience.get(key)
        if isinstance(node, dict) and isinstance(node.get("variance"), (int, float)):
            return float(node["variance"])
    return None


def _gate_final(
    text: str,
    trace_path: str,
    *,
    goal: str = "",
    steps: list[dict] | None = None,
    report_context: dict | None = None,
    conscience_strict: bool | None = None,
    conscience_mode: str | None = None,
) -> tuple[str, bool, bool, dict]:
    """Apply the selected final-answer delivery policy. Returns
    (final_text, ok, downgraded, epistemic_status).

    Sophia Code can select ``off``, ``report``, ``floor``, or ``strict``.
    Callers that omit ``conscience_mode`` retain the legacy harness behavior:
    the hard-prohibition floor runs and ``conscience_strict`` controls Tier 2.
    The status records exactly what ran so an advisory or disabled policy cannot
    be mistaken for a successful strict verification.
    """
    r = AgentResult(task_id="agent-loop", ok=True, final_text=text, steps=[], failures=[],
                    cost_usd=0.0, latency_sec=0.0, trace_path=trace_path)
    if edition_skips_conscience_gate():
        status = epistemic_status.EpistemicStatus(
            state="delivered_open_edition",
            label="Sophia Code",
            detail=(
                "Open edition does not ship the Conscience delivery gate. "
                "Tool permissions and candidateOnly/canClaimAGI constraints are unchanged."
            ),
            severity="notice",
            floorChecked=False,
            uncertaintyChecked=False,
            strictGateArmed=False,
            checks={"delivery": "open-edition", "operatorSelected": False},
        )
        return text, True, False, status.to_dict()
    from agent.conscience_runtime import apply_delivery_gate, gate_enabled
    raw_mode = str(conscience_mode or "").strip().casefold()
    if raw_mode in {"off", "report", "floor", "strict"}:
        mode = raw_mode
    else:
        mode = "strict" if gate_enabled(conscience_strict) else "floor"
    strict = mode in {"report", "strict"}
    advisory = mode == "report"
    seen: dict = {}

    def _observe(decision: Any) -> None:
        seen["decision"] = decision

    context = {
        "request": goal,
        "steps": list(steps or []),
        **dict(report_context or {}),
    }
    if mode == "off":
        status = epistemic_status.EpistemicStatus(
            state="delivered_gate_off",
            label="Conscience off",
            detail=(
                "The operator disabled Sophia's final-text conscience and "
                "provenance evaluation for this run. Tool permissions and "
                "candidateOnly/canClaimAGI constraints are unchanged."
            ),
            severity="caution",
            floorChecked=False,
            uncertaintyChecked=False,
            strictGateArmed=False,
            checks={"delivery": "off", "operatorSelected": True},
        )
        return text, True, False, status.to_dict()
    gated = apply_delivery_gate(
        r,
        strict=strict,
        advisory=advisory,
        observer=_observe,
        report_context=context,
    )
    downgraded = gated.final_text != text
    saw_decision = "decision" in seen
    decision = seen.get("decision")
    verdict = "gate_error" if (saw_decision and decision is None) else str(
        getattr(decision, "verdict", "") or "")
    if advisory:
        would_withhold = bool(
            decision is None
            or getattr(decision, "allowed", False) is not True
        )
        status = epistemic_status.EpistemicStatus(
            state="delivered_advisory",
            label="Conscience advisory",
            detail=(
                "Sophia evaluated the final text and recorded an advisory "
                "verdict, but report mode never withholds the answer."
            ),
            severity="caution" if would_withhold else "notice",
            verdict=verdict,
            floorChecked=decision is not None,
            uncertaintyChecked=decision is not None,
            strictGateArmed=False,
            disagreement=_parliament_disagreement(decision),
            reason=str(getattr(decision, "reason", "") or ""),
            checks={
                "delivery": "advisory",
                "operatorSelected": True,
                "wouldWithhold": would_withhold,
                "evaluationError": decision is None,
            },
        )
    else:
        status = epistemic_status.describe(
            verdict=verdict,
            gated=downgraded,
            strict=strict,
            empty=not text.strip(),
            disagreement=_parliament_disagreement(decision),
            reason=str(getattr(decision, "reason", "") or ""),
        )
    return gated.final_text, gated.ok, downgraded, status.to_dict()


# --------------------------------------------------------------------------- #
# Loop-continuity detector
# --------------------------------------------------------------------------- #
# Narrow narration markers — the baseline guard, active on EVERY path. A genuine
# short answer ("done.") matches none of these and passes through.
_NARRATION_MARKERS = ("##", "next", "now let", "remaining", "demonstrate",
                      "read_file", "write_file", "bash", "list_dir",
                      "grep", "glob", "edit_file", "continuing",
                      "tool 1", "tool 2", "tool 3", "tool 4", "tool 5")
# Forward-looking intent phrases — used ONLY when post_tool_continuity is on.
# Phrase-level on purpose: "try to" / "trying to" catch a announced future action
# but NOT the past-tense "I tried X" that appears in genuine final answers.
# "let me" is the classic weak-model bail ("Let me try fetching ..." with no tool
# call) that the narrow markers miss.
_INTENT_MARKERS = ("let me", "let's", "lets ", "i'll", "i will", "i can now",
                   "going to", "next i", "now i", "try to", "trying to",
                   "i need to", "i should", "instead,", "alternatively",
                   "different method", "another method", "with a different",
                   "a different way", "one more")
# A failed tool whose error matches these is a PERMISSION denial, which must be
# surfaced and allowed to finalize — not auto-recovered into a retry loop.
_DENIAL_MARKERS = ("not approved", "denied", "denial", "permission", "not permitted")
_INTERNAL_LOOP_NUDGE_PREFIXES = (
    "[auto-continue ",
    "the last tool `",
    "you just received output from `",
    "you announced an action but did not call a tool",
    "this resumed task requires a fresh",
    "your latest report explicitly says",
    "stop narrating",
)
_REPEAT_UNIT_MIN_CHARS = 60
_REPEAT_RESPONSE_MIN_CHARS = 800


def _is_internal_loop_nudge(text: str) -> bool:
    """True for user-role steering turns synthesized by this loop.

    These turns are useful only inside the in-flight model dialogue. They are not
    operator requests and must not regain authority when a persisted session is
    resumed.
    """
    normalized = (text or "").strip().casefold()
    if not normalized:
        return False
    if normalized.startswith(_INTERNAL_LOOP_NUDGE_PREFIXES):
        return True
    return (
        normalized.startswith("active request:")
        and "\nyou executed " in normalized
    )


_UNFINISHED_REPORT_MARKERS = (
    "remains open",
    "still open",
    "still in progress",
    "still pending",
    "not yet complete",
    "not yet finished",
    "has not completed",
    "hasn't completed",
    "waiting for",
    "blocked until",
    "work remains",
    "objective remains",
)
_LONG_HORIZON_TASK_MARKERS = (
    " until ",
    "monitor ",
    "watch ",
    "keep working",
    "keep going",
    "continue ",
    "finish ",
    "complete ",
    "merge",
    "deploy",
    "all checks",
)
_NEGATED_REMAINING_WORK_RE = re.compile(
    r"\b(?:(?:no|zero)\s+(?:work|objective|tasks?|steps?)|nothing)\s+remains?\b",
    re.IGNORECASE,
)


def _explicitly_unfinished_status(text: str, task: str) -> bool:
    """Whether a final report admits a long-horizon objective is unfinished."""
    report = _NEGATED_REMAINING_WORK_RE.sub(
        " ", f" {str(text or '').strip().casefold()} "
    )
    active = f" {str(task or '').strip().casefold()} "
    if not any(marker in report for marker in _UNFINISHED_REPORT_MARKERS):
        return False
    return any(marker in active for marker in _LONG_HORIZON_TASK_MARKERS)


def _has_successful_refresh_step(steps: list[dict[str, Any]]) -> bool:
    """Whether this run obtained any successful fresh tool evidence.

    Tool risk and semantics are already enforced at execution time. Here the
    important fail-closed distinction is success: a denied, malformed, timed-out,
    or budget-exhausted call cannot make a stale status answer current.
    """
    return any(bool(step.get("ok")) for step in steps)


def _degenerate_response_reason(text: str) -> str:
    """Return a bounded diagnostic when one response repeats itself heavily.

    Local reasoning models can fill their whole generation budget by copying the
    same multi-paragraph deliberation dozens of times. Exact paragraph repetition
    is intentionally used instead of semantic similarity: it catches the measured
    failure without rejecting legitimate answers that revisit a topic in different
    words.
    """
    raw = (text or "").strip()
    if len(raw) < _REPEAT_RESPONSE_MIN_CHARS:
        return ""
    units = [
        re.sub(r"\s+", " ", part).strip().casefold()
        for part in re.split(r"\n\s*\n+", raw)
    ]
    units = [unit for unit in units if len(unit) >= _REPEAT_UNIT_MIN_CHARS]
    if len(units) < 4:
        return ""
    counts: dict[str, int] = {}
    for unit in units:
        counts[unit] = counts.get(unit, 0) + 1
    max_repeat = max(counts.values(), default=1)
    repeated_chars = sum((count - 1) * len(unit) for unit, count in counts.items())
    unit_chars = sum(len(unit) for unit in units)
    repeated_fraction = repeated_chars / max(1, unit_chars)
    if max_repeat >= 3 and repeated_chars >= 400 and repeated_fraction >= 0.25:
        return (
            f"repeated paragraph up to {max_repeat}x "
            f"({repeated_fraction:.0%} duplicate paragraph content)"
        )
    return ""


def _clean_persisted_history(history: "list[dict] | None") -> tuple[list[dict], int]:
    """Drop rejected loop turns and repetitive model artifacts from resume history."""
    source = list(history or [])
    cleaned: list[dict] = []
    dropped = 0
    for index, message in enumerate(source):
        role = str(message.get("role") or "")
        content = str(message.get("content") or "")
        if role == "user" and _is_internal_loop_nudge(content):
            dropped += 1
            continue
        if role == "assistant":
            if not content.strip():
                dropped += 1
                continue
            next_message = source[index + 1] if index + 1 < len(source) else {}
            rejected_by_nudge = (
                str(next_message.get("role") or "") == "user"
                and _is_internal_loop_nudge(str(next_message.get("content") or ""))
            )
            if rejected_by_nudge or _degenerate_response_reason(content):
                dropped += 1
                continue
        cleaned.append(dict(message))
    return cleaned, dropped


def _continuation_nudge_kind(text: str, steps: list[dict], *,
                             post_tool_continuity: bool, nudged_index: int) -> str:
    """Decide whether a model ``final`` (text with NO tool call) should be nudged
    back into the loop, and how. Returns one of:

      ``""``          accept the final (break)
      ``"recover"``   the last tool FAILED (not a denial) — retry or recover
      ``"use_data"``  a successful tool returned data the model hasn't used yet
      ``"intent"``    the model announced a future action without calling a tool
      ``"narration"`` the model is describing steps instead of acting (narrow)

    The grounded tool-boundary signals (``recover``/``use_data``) and the broad
    text signal (``intent``) require ``post_tool_continuity``; the narrow
    ``narration`` signal applies on every path, so default-off callers keep the
    historical behaviour exactly. Single-shot safety is enforced by the caller
    (``iteration < ceiling - 1``), not here.
    """
    low = text.lower()
    last = steps[-1] if steps else None
    fresh_boundary = bool(steps) and (len(steps) - 1) != nudged_index
    if post_tool_continuity and last is not None and fresh_boundary:
        if last.get("ok") and (last.get("output") or "").strip():
            return "use_data"
        err = (last.get("error") or "").lower()
        if not last.get("ok") and not any(m in err for m in _DENIAL_MARKERS):
            return "recover"
    if post_tool_continuity and last is not None and not fresh_boundary:
        # The interactive path already gave the model one opportunity to use
        # this exact tool result. A complete final report commonly names the
        # tool(s) it used and can be longer than 200 characters; treating that
        # report as narration reopens a completed task and can induce repeated
        # idempotent calls. Preserve the narrow future-action guard, but accept
        # a grounded report after the one post-tool continuation chance.
        if any(m in low for m in _INTENT_MARKERS):
            return "intent"
        return ""
    if post_tool_continuity and any(m in low for m in _INTENT_MARKERS):
        return "intent"
    if len(text) > 200 or any(m in low for m in _NARRATION_MARKERS):
        return "narration"
    return ""


_TOOL_UNAVAILABLE_MARKERS = (
    "no tools were available",
    "tools were unavailable",
    "no callable",
    "tools are unavailable",
    "terminal tools were not available",
    "could not execute the commands",
    "i cannot execute",
    "i can't execute",
)


def _claims_tools_are_unavailable(text: str) -> bool:
    """Recognize a recoverable provider prose fallback.

    OpenAI-compatible reasoning models can return a refusal-style paragraph
    even when Sophia supplied native tool schemas. Treat only these narrow
    markers as a protocol miss; ordinary capability explanations remain final
    answers.
    """
    lowered = str(text or "").casefold()
    return any(marker in lowered for marker in _TOOL_UNAVAILABLE_MARKERS)


def _prompt_requires_initial_tool(goal: str) -> bool:
    """Detect explicit operator requests that cannot be satisfied by prose."""
    low = str(goal or "").casefold()
    markers = (
        "run pwd", "git status", "execute the command", "terminal",
        "create a goal", "goal named", "to-do", "todo", "mark it",
        "publish a goal", "publish one",
    )
    return any(marker in low for marker in markers)


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #
def run_agent_loop(
    goal: str,
    *,
    client: Any,
    ctx: ToolContext,
    history: "list[dict] | None" = None,
    on_event: Callable[[dict], None] | None = None,
    max_steps: int = 12,
    system_extra: str = "",
    trace_path: "str | None" = None,
    show_thinking: bool = False,
    enable_tools: bool = True,
    steering_consumer: Callable[[], list[str]] | None = None,
    budget: ExecutionBudget | None = None,
    max_parallel_tools: int = 1,
    post_tool_continuity: bool = False,
    allow_continuation_nudges: bool = True,
    max_continuations: int | None = None,
    raw_user_turn: str | None = None,
    current_task: str | None = None,
    response_style: str = "adaptive",
    gate_report_context: dict | None = None,
    max_model_calls: int | None = None,
    reserve_final_model_call: bool = False,
    tool_feedback_cap: int | None = None,
    require_live_refresh: bool = False,
    require_initial_tool: bool = False,
    defer_delivery_gate: bool = False,
    continue_unfinished_objective: bool = True,
) -> AgentLoopResult:
    """Run the tool-use loop for one goal.

    ``history`` continues a conversation. ``steering_consumer`` is polled only at
    safe iteration boundaries (after a completed model/tool iteration, before the
    next model request); returned prompts are appended once as ordinary user turns.

    ``max_continuations`` widens the auto-continue ceiling (total iterations =
    ``max_steps * (max_continuations + 1)``). ``None`` keeps the default of 3
    (the tight 4×max_steps cap suited to slow, loop-prone LOCAL models); cloud
    callers pass a high value for effectively-unlimited tool calls. The
    ``max_steps == 1`` single-shot contract always wins (exactly one iteration).

    ``require_initial_tool`` is deliberately narrow: a caller that has already
    established that its task needs repository or system evidence can require
    the first turn to use one of the native tools exposed to this loop. It does
    not expand the tool scope, and the normal ``auto`` policy is restored as
    soon as that first provider call completes.

    ``defer_delivery_gate`` is reserved for an internal orchestration artifact
    that is not itself delivered to the operator. The caller must later pass a
    separate, operator-facing synthesis through the ordinary delivery gate.
    This does not disable tool permissions, tracing, budgets, or error handling.

    ``continue_unfinished_objective`` controls the long-horizon status detector.
    Interactive monitor/deploy/merge tasks keep it enabled. Bounded internal
    workflow reports disable it because a specialist may correctly list
    unresolved product risks or future work while still having completed the
    assigned analysis; treating those report sections as an instruction to run
    the same worker again creates needless provider calls.

    ``allow_continuation_nudges`` is disabled by structured workflow controller
    passes. Their terminal ``WORKFLOW_DECISION`` legitimately contains words
    such as "dispatch", "review", and "next stage"; treating that machine
    decision as narrated future intent reopens a completed controller pass and
    can spend several slow cloud calls repeating the same decision.
    """
    tp = trace_path or _default_trace_path()
    if max_parallel_tools < 1:
        raise ValueError("max_parallel_tools must be >= 1")
    if max_model_calls is not None and max_model_calls < 1:
        raise ValueError("max_model_calls must be >= 1")
    if reserve_final_model_call and (
        max_model_calls is None or max_model_calls < 2
    ):
        raise ValueError(
            "reserve_final_model_call requires max_model_calls >= 2"
        )
    correlation = budget.snapshot().correlation.to_dict() if budget is not None else {}
    if getattr(ctx, "client", None) is None:  # expose the client to LLM-using ext tools (delegate…)
        ctx.client = client

    def emit(ev: dict) -> None:
        if correlation:
            ev = {**correlation, **ev}
        safe_event = _safe_event(ev)
        _trace(tp, safe_event)
        if on_event:
            try:
                on_event(safe_event)
            except Exception:
                # A UI/event sink failure must not interrupt tool execution.
                pass

    # Tool-loop efficiency: budget large results, cache idempotent reads, and
    # nudge the model when it stalls on unproductive calls. All fail-open and
    # env-tunable: SOPHIA_TOOL_FEEDBACK_CAP (0 disables the cap),
    # SOPHIA_TOOL_NO_PROGRESS (0 disables the nudge), SOPHIA_TOOL_CACHE=0
    # disables the read cache.
    def _env_int(name: str, default: int) -> int:
        try:
            return int(os.environ.get(name, "") or default)
        except (TypeError, ValueError):
            return default

    _feedback_cap = (
        int(tool_feedback_cap)
        if tool_feedback_cap is not None
        else _env_int("SOPHIA_TOOL_FEEDBACK_CAP", 12000)
    )
    _efficiency = EfficiencyTracker(
        no_progress_threshold=_env_int("SOPHIA_TOOL_NO_PROGRESS", 3),
        cache_enabled=os.environ.get("SOPHIA_TOOL_CACHE", "1") != "0",
    )
    model_calls = 0

    def execute_with_liveness(name: str, args: dict):
        if TOOL_WAIT_INTERVAL_SEC <= 0 or TOOL_WAIT_MAX_EVENTS <= 0:
            return execute_tool(name, args, ctx)
        done = threading.Event()
        started = time.monotonic()
        max_wait_sec = TOOL_WAIT_INTERVAL_SEC * TOOL_WAIT_MAX_EVENTS

        def notify() -> None:
            next_at = TOOL_WAIT_INTERVAL_SEC
            for sequence in range(1, TOOL_WAIT_MAX_EVENTS + 1):
                while not done.wait(TOOL_WAIT_POLL_SEC):
                    if budget is not None and budget.snapshot().cancelled:
                        return
                    elapsed = time.monotonic() - started
                    if elapsed < next_at:
                        continue
                    emit({
                        "type": "tool_wait",
                        "tool": name,
                        "sequence": sequence,
                        "elapsedSec": round(elapsed, 3),
                        "maxWaitSec": round(max_wait_sec, 3),
                    })
                    next_at += TOOL_WAIT_INTERVAL_SEC
                    break
                if done.is_set():
                    return

        notifier = threading.Thread(
            target=notify,
            name="agent-loop-tool-wait",
            daemon=True,
        )
        notifier.start()
        try:
            return execute_tool(name, args, ctx)
        finally:
            done.set()
            notifier.join(timeout=max(TOOL_WAIT_POLL_SEC * 2, 0.1))

    def reserve_model_call(prompt_tokens: int):
        nonlocal model_calls
        if max_model_calls is not None and model_calls >= max_model_calls:
            raise BudgetRejected(RejectionReason.PARENT, "model call limit reached")
        estimate = Usage(input_tokens=max(1, prompt_tokens), output_tokens=1)
        if budget is not None and budget.effective_remaining().usd is not None:
            from agent.model import estimate_cost_detail

            configs = [
                config
                for config in [
                    getattr(client, "primary", None),
                    *list(getattr(client, "fallbacks", []) or []),
                ]
                if config is not None
            ]
            if not configs:
                raise BudgetRejected(RejectionReason.USD, "model pricing configuration unavailable")
            retries = max(1, int(getattr(client, "retries", 1) or 1))
            estimated_usd = 0.0
            estimated_input = 0
            estimated_output = 0
            for config in configs:
                model = str(getattr(config, "model", "") or "")
                max_tokens = max(1, int(getattr(config, "max_tokens", 0) or 0))
                cost = estimate_cost_detail(model, estimate.input_tokens, max_tokens)
                if not cost.known:
                    raise BudgetRejected(RejectionReason.USD, f"unknown pricing for {model or 'model'}")
                estimated_usd += cost.usd * retries
                estimated_input += estimate.input_tokens * retries
                estimated_output += max_tokens * retries
            estimate = Usage(
                usd=estimated_usd,
                input_tokens=estimated_input,
                output_tokens=estimated_output,
            )
        lease = budget.reserve(estimate) if budget is not None else None
        model_calls += 1
        return lease

    def run_tool(name: str, args: dict, *, track_efficiency: bool = True):
        # Per-run read cache: serve semantically equivalent idempotent reads without
        # re-executing (and without a budget lease — a cache hit uses no
        # resources). The repeat is still tracked so the no-progress nudge fires
        # if the model keeps repeating itself.
        cached = _efficiency.cached_output(name, args)
        if cached is not None:
            from agent.agent_tools import ToolResult
            emit({"type": "tool_cache_hit", "tool": name})
            result = ToolResult(True, name,
                                output="[cached — equivalent to an earlier call this run]\n" + cached)
            if track_efficiency:
                _efficiency.record(name, args, True, cached)
            return result
        lease = None
        try:
            if budget is not None:
                lease = budget.reserve(Usage(tool_calls=1))
                if name == "delegate":
                    # Delegation synchronously enters a child loop under this
                    # budget. Release the parent's concurrency slot first or a
                    # max_concurrency=1 budget waits on its own active lease.
                    lease.commit(Usage(tool_calls=1))
                    lease = None
            result = execute_with_liveness(name, args)
            if budget is not None and budget.snapshot().cancelled:
                if lease is not None:
                    lease.refund()
                    lease = None
                emit({"type": "tool_cancelled", "tool": name})
                from agent.agent_tools import ToolResult
                return ToolResult(
                    False, name, error="tool execution cancelled",
                    error_type="cancelled", retryable=False,
                )
            if lease is not None:
                lease.commit(Usage(tool_calls=1))
            if track_efficiency:
                _efficiency.record(name, args, result.ok, result.output)
            return result
        except BudgetRejected as exc:
            if lease is not None:
                lease.refund()
            if exc.reason is RejectionReason.CANCELLED:
                emit({"type": "tool_cancelled", "tool": name})
                from agent.agent_tools import ToolResult
                return ToolResult(
                    False, name, error="tool execution cancelled",
                    error_type="cancelled", retryable=False,
                )
            emit({"type": "budget_error", "reason": exc.reason.value,
                  "error": f"execution budget exhausted ({exc.reason.value})"})
            from agent.agent_tools import ToolResult
            return ToolResult(False, name, error=f"execution budget exhausted ({exc.reason.value})",
                              error_type="budget_exhausted", retryable=False)
        except Exception:
            if lease is not None:
                lease.refund()
            raise

    # Running per-turn total for AgentLoopResult.cost_usd/prompt_tokens/
    # completion_tokens (see the dataclass docstring). Updated from every model
    # call this run makes, independent of whether an ExecutionBudget lease
    # exists — the budget-lease bookkeeping above records an admitted/estimated
    # figure for accounting, while this always records what the client itself
    # reported, which is what a caller displaying real per-turn cost wants.
    usage_cost_usd: float | None = None
    usage_prompt_tokens: int | None = None
    usage_completion_tokens: int | None = None

    def _accumulate_usage(result: Any) -> None:
        nonlocal usage_cost_usd, usage_prompt_tokens, usage_completion_tokens
        # ``hasattr`` — not the value — decides whether a field is reported: a
        # real ``ModelResult`` always carries ``cost_usd`` (0.0 for a genuinely
        # free local call, a fact worth keeping), while an offline test double
        # that never set the attribute has reported nothing. Conflating the two
        # would show a fabricated "$0.00" for a client this loop has no cost
        # data for at all, instead of leaving the field unavailable.
        if hasattr(result, "cost_usd"):
            usage_cost_usd = (usage_cost_usd or 0.0) + max(0.0, float(getattr(result, "cost_usd", 0.0) or 0.0))
        if hasattr(result, "prompt_tokens"):
            usage_prompt_tokens = (usage_prompt_tokens or 0) + max(0, int(getattr(result, "prompt_tokens", 0) or 0))
        if hasattr(result, "completion_tokens"):
            usage_completion_tokens = (
                (usage_completion_tokens or 0) + max(0, int(getattr(result, "completion_tokens", 0) or 0))
            )

    primary_config = getattr(client, "primary", None)
    try:
        from agent.model import is_local_model

        local_model = bool(primary_config is not None and is_local_model(primary_config))
    except Exception:  # noqa: BLE001 - profile selection must never block a run
        local_model = False
    context_window = getattr(primary_config, "context_window", None)
    try:
        personal_config = load_harness_config(Path(ctx.root))
    except Exception:  # noqa: BLE001 - malformed optional config fails closed
        personal_config = PersonalHarnessConfig()

    scope = getattr(ctx, "allowed_tools", None)
    if not personal_config.enabled:
        # The new personal tools are opt-in. Materialize the historical
        # unrestricted scope minus those tools so classic runs cannot write or
        # retrieve personal state merely because a plugin was discovered.
        if scope is None:
            scope = set(all_tools()) - set(PERSONAL_TOOL_NAMES)
            ctx.allowed_tools = scope
        else:
            scope = set(scope) - set(PERSONAL_TOOL_NAMES)
            ctx.allowed_tools = scope
    else:
        disabled_personal_tools: set[str] = set()
        if not personal_config.memory_enabled:
            disabled_personal_tools.update(
                {
                    "personal_memory_search",
                    "personal_memory_write",
                    "personal_memory_write_sensitive",
                }
            )
        elif personal_config.memory_sensitive.casefold() not in {
            "ask_encrypt",
            "ask-encrypt",
            "encrypt",
        }:
            disabled_personal_tools.add("personal_memory_write_sensitive")
        if not personal_config.artifacts_enabled:
            disabled_personal_tools.add("personal_artifact_stage")
        if disabled_personal_tools:
            if scope is None:
                scope = set(all_tools()) - disabled_personal_tools
            else:
                scope = set(scope) - disabled_personal_tools
            ctx.allowed_tools = scope
    # Native schemas are recomputed per-iteration below for the actual
    # ``tools=`` request (scope never changes mid-run, so this is a cheap,
    # side-effect-free duplicate); this first pass only decides which system
    # prompt to build, before any model call happens.
    _short_tool_protocol = _use_short_tool_protocol(
        client, native_tools_present=bool(enable_tools and tool_function_schemas(scope))
    )
    if not enable_tools:
        tools_text = "Available tools: none for this run. Answer directly; do not emit tool-call JSON."
    elif _short_tool_protocol:
        # Unused by build_system_prompt when short_tool_protocol=True — skip
        # rendering the full per-tool prose block this path exists to drop.
        tools_text = ""
    else:
        tools_text = tool_specs_text(scope)
    recall = failure_recall_system_extra(Path(ctx.root), goal)
    task_authority = ""
    if current_task:
        literal = (raw_user_turn or goal).strip()
        task_authority = (
            "\nCurrent-turn authority:\n"
            f'- The operator literally entered: {json.dumps(literal, ensure_ascii=False)}.\n'
            f'- For this run it resolves to the active task: {json.dumps(current_task, ensure_ascii=False)}.\n'
            "- Execute the active task above. Earlier turns are background evidence, not "
            "automatically active formatting or exact-output instructions. Carry an earlier "
            "constraint forward only when it belongs to this still-unfinished active task.\n"
        )
    goal_ui_guidance = ""
    active_request = (current_task or goal).casefold()
    if any(marker in active_request for marker in (
        "create a goal", "create goal", "publish a goal", "publish goal",
        "goal named", "goal titled",
    )):
        goal_ui_guidance = (
            "\nGoal-panel boundary:\n"
            "- Sophia already published this run's Goal to the UI before the "
            "model turn. A Goal is not a callable tool.\n"
            "- Treat the requested Goal as created. Do not look for a `goal` "
            "shell command or emulate Goal creation with another tool; execute "
            "only the remaining requested work.\n"
        )
    try:
        harness_selection = prepare_harness_selection(
            config=personal_config,
            request=current_task or goal,
            root=Path(ctx.root),
            history=history or (),
            session=str(getattr(ctx, "session_name", "") or "default"),
            local=local_model,
            manual_skill=getattr(ctx, "manual_skill_name", None),
            user_text=raw_user_turn if raw_user_turn is not None else goal,
        )
    except Exception:  # noqa: BLE001 - personalization is optional, not load-bearing
        from agent.personal_harness import HarnessSelection, research_route

        harness_selection = HarnessSelection(
            "",
            (),
            (),
            (),
            research_route(current_task or goal, enabled=False),
            (),
            (),
        )
    prompt_extra = "\n\n".join(
        block.strip()
        for block in (
            system_extra,
            task_authority,
            goal_ui_guidance,
            harness_selection.prompt_extra,
            recall,
        )
        if block and block.strip()
    )
    compiled_system = compile_system_prompt(
        root=ctx.root,
        tools=tools_text,
        extra=prompt_extra,
        response_style=response_style,
        current_request=current_task or goal,
        short_tool_protocol=_short_tool_protocol,
        prompt_profile=(
            "local" if personal_config.enabled and local_model
            else "cloud" if personal_config.enabled
            else "classic"
        ),
        prompt_budget_tokens=(
            personal_config.prompt_budget_local
            if personal_config.enabled and local_model
            else personal_config.prompt_budget_cloud
            if personal_config.enabled
            else None
        ),
        context_window=context_window,
    )
    system = compiled_system.text
    harness_receipt_path: Path | None = None
    try:
        harness_receipt_path = write_harness_receipt(
            session=str(getattr(ctx, "session_name", "") or "default"),
            run_id=str(getattr(ctx, "run_id", "") or f"run-{int(time.time() * 1000)}"),
            root=Path(ctx.root),
            local=local_model,
            config=personal_config,
            selection=harness_selection,
            prompt_receipt=compiled_system.receipt.to_dict(),
        )
    except Exception:  # noqa: BLE001 - receipt failures never block execution
        harness_receipt_path = None
    persisted_turn = raw_user_turn if raw_user_turn is not None else goal
    persisted_message: dict[str, Any] = {"role": "user", "content": persisted_turn}
    if current_task:
        from agent.continuation import add_continuation_metadata, is_plain_continuation
        if is_plain_continuation(persisted_turn):
            # Persist an unfulfilled tombstone before any model/tool work starts.
            # Cancellation therefore remains resumable; the bridge marks this
            # fulfilled only after a successful terminal outcome.
            persisted_message = add_continuation_metadata(
                persisted_message, instruction=current_task)
    cleaned_history, dropped_history_turns = _clean_persisted_history(history)
    if cleaned_history:
        # Continue an existing conversation: keep prior turns, refresh the system turn.
        messages = [{"role": "system", "content": system}]
        messages += [m for m in cleaned_history if m.get("role") != "system"]
        messages.append(persisted_message)
    else:
        messages = [
            {"role": "system", "content": system},
            persisted_message,
        ]
    # Session history remains provider-agnostic and safe to persist. A separate
    # in-memory transcript is activated only after a DS4-style native tool turn;
    # it retains assistant tool IDs/reasoning and role=tool results solely for
    # subsequent requests in this run.
    wire_messages: list[dict] | None = None
    wire_persisted_cursor = len(messages)
    native_transcript_required = bool(
        getattr(getattr(client, "primary", None), "requires_native_tool_transcript", False)
    )

    # Live reference to the running transcript so the bridge can persist the
    # partial conversation when a run is cancelled mid-stream (code_bridge
    # _execute_run's _RunCancelled handler reads it). Appended in place everywhere
    # below, so it always reflects the latest completed turns; re-pointed after
    # auto-compaction reassigns `messages`. Only the top-level interactive run is
    # persisted — the bridge sets ctx.session_name solely there, never on subagents.
    try:
        ctx._live_messages = messages  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - tracking is best-effort, never breaks the run
        pass

    emit({"type": "goal", "goal": goal, "root": str(ctx.root), "permission": ctx.permission})
    if personal_config.enabled:
        emit({
            "type": "harness_context",
            "profile": personal_config.profile,
            "modelClass": "local" if local_model else "cloud",
            "selectedSkills": [row.get("name") for row in harness_selection.skills],
            "memoryHits": len(harness_selection.memory_hits),
            "memoryWrites": list(harness_selection.memory_writes),
            "pastChatHits": len(harness_selection.chat_hits),
            "research": harness_selection.research,
            "receiptPath": str(harness_receipt_path) if harness_receipt_path else "",
            "candidateOnly": True,
            "canClaimAGI": False,
        })
        emit({"type": "prompt_receipt", **compiled_system.receipt.to_dict()})
    if _short_tool_protocol:
        emit({"type": "tool_protocol", "form": "short"})
    if dropped_history_turns:
        emit({
            "type": "history_loop_noise_dropped",
            "turns": dropped_history_turns,
        })
    steps: list[dict] = []
    final_text = ""
    from agent.response_style import is_exact_output_request
    exact_output = is_exact_output_request(current_task or goal)
    # Set when the loop exhausts its iteration ceiling without the model ever
    # emitting a tool-free final answer. Forces the conclusion pass below so a
    # long run still ends with a real report instead of the bare placeholder.
    hit_ceiling = False
    # A degenerate response is never fed back into model history. One clean,
    # bounded conclusion pass gets the original request plus tool evidence only.
    force_conclusion_reason = ""
    terminal_model_error: str | None = None
    incomplete = False
    incomplete_reason: str | None = None
    nudges = 0
    refresh_nudges = 0
    # Index of the tool step we already offered a post-tool continuation chance
    # for, so each tool-result boundary gets at most ONE extra turn. Only used
    # when post_tool_continuity is enabled by the caller (e.g. the TUI run path).
    post_tool_nudged_at = -1
    # Count of aggressive continuity nudges (recover/use_data/intent) issued, so
    # a weak model that keeps announcing actions without calling tools can't be
    # nudged indefinitely — capped small to bound extra latency on local models.
    continuity_nudges = 0
    # Auto-continuation: the loop runs up to max_steps * (1 + continuations)
    # iterations. At every max_steps boundary, if no final answer yet, inject
    # a "continue" prompt — the full message history carries over so the model
    # sees what it already did. Total ceiling: 4 * max_steps (96 for default 24).
    #
    # max_steps == 1 is the single-shot contract (PTY approval gates, TDD plan
    # intermediate steps, subagent single-shot calls, cli one-shot runs): the
    # caller expects EXACTLY one tool iteration. Auto-continuing it would turn a
    # hard cap into a batch size and re-request approvals the caller never grants.
    # Disable the 4x expansion only for that one value; max_steps >= 2 keeps the
    # batch-size behavior #1671 intended (its test asserts 4x at max_steps=3).
    #
    # Otherwise the ceiling is model-aware via max_continuations: LOCAL models
    # (oMLX/ollama/vLLM) leave it None and keep the tight 3-continuation cap
    # (4×max_steps) that bounds slow, loop-prone on-device inference; CLOUD
    # models (020s/OpenAI/Anthropic) pass a high value so a long task runs to
    # completion instead of stalling at the cap. The budget and no-progress
    # detection still bound a genuinely wedged cloud run, and the auto-continue
    # prompt below still lets the model conclude early — so this is a runaway
    # guard, not a license to spin forever.
    if max_steps <= 1:
        _MAX_CONTINUATIONS = 0
    elif max_continuations is not None:
        _MAX_CONTINUATIONS = max(0, int(max_continuations))
    else:
        _MAX_CONTINUATIONS = 3
    _total_ceiling = max_steps * (_MAX_CONTINUATIONS + 1)

    def reserve_answer_only_call_after_tool_work() -> bool:
        """Stop tool acquisition before the caller's reserved final call.

        A bounded team worker may intentionally grant N tool-bearing model
        calls plus one answer-only call. Without this boundary, the Nth tool
        result falls out of the ``for`` loop, which marks the run incomplete
        before the conclusion writer can use that reserved call. Break
        explicitly instead: the normal conclusion pass consumes the last call
        and can return a complete evidence report.
        """
        nonlocal force_conclusion_reason
        if not reserve_final_model_call or max_model_calls is None:
            return False
        if model_calls < max_model_calls - 1:
            return False
        force_conclusion_reason = "reserved_final_model_call"
        emit({
            "type": "final_call_reserved",
            "modelCalls": model_calls,
            "maxModelCalls": max_model_calls,
            "toolCalls": len(steps),
        })
        return True

    for iteration in range(_total_ceiling):
        # Auto-continuation boundary: remind the model it may conclude OR keep
        # going. This used to ASSERT "The goal is NOT yet achieved… continue
        # executing tools", which overrode the model's own judgment and forced
        # it to keep tool-calling all the way to the iteration ceiling — so an
        # open-ended goal (e.g. "continue") never converged and the TUI sat at
        # "Thinking…" forever. Let the model decide: conclude now if the work is
        # done, otherwise continue without repeating completed steps.
        if iteration > 0 and iteration % max_steps == 0 and steps:
            used = sorted({s["tool"] for s in steps if s.get("ok")})
            messages.append({"role": "user", "content": (
                f"[auto-continue {iteration // max_steps}/{_MAX_CONTINUATIONS}] "
                f"You completed {iteration} iterations using: {', '.join(used)}. "
                "If the goal is fully achieved, give your final answer now with "
                "no tool calls. Otherwise review what remains and continue "
                "executing tools; do not repeat completed steps."
            )})
            emit({"type": "auto_continue", "iteration": iteration,
                  "batch": iteration // max_steps})
        if iteration and steering_consumer is not None:
            try:
                pending = steering_consumer() or []
            except Exception:
                pending = []
            for prompt in pending:
                text_prompt = str(prompt).strip()
                if text_prompt:
                    messages.append({"role": "user", "content": text_prompt})
                    emit({"type": "steer_applied", "text": text_prompt[:500]})
        if budget is not None and budget.snapshot().cancelled:
            err = "execution budget cancelled"
            emit({"type": "budget_error", "reason": "cancelled", "error": err})
            return AgentLoopResult(goal=goal, final_text=err, ok=False, steps=steps, messages=messages,
                                   trace_path=tp, model_error=err, correlation=correlation,
                                   cost_usd=usage_cost_usd, prompt_tokens=usage_prompt_tokens,
                                   completion_tokens=usage_completion_tokens)
        if wire_messages is not None and wire_persisted_cursor < len(messages):
            # Copy any ordinary steering/nudge/auto-continue turns added since
            # the last native batch. The exact native turns themselves update
            # this cursor when they are appended below, so they are never
            # duplicated as their sanitized persisted placeholders.
            wire_messages.extend(
                dict(message) for message in messages[wire_persisted_cursor:]
            )
            wire_persisted_cursor = len(messages)
        # Auto-compact long multi-tool transcripts before each model call, at a
        # budget derived from THIS model's declared window (grok-4.5: 500K, so
        # 400K of history) rather than one constant for every backend.
        context_window = getattr(getattr(client, "primary", None), "context_window", None)
        messages, compact_audit = _compact_messages(
            messages, context_window=context_window)
        if compact_audit.get("compacted"):
            emit({"type": "auto_compact", **compact_audit})
        if wire_messages is not None:
            wire_messages, wire_compact_audit = _compact_messages(
                wire_messages, context_window=context_window)
            wire_persisted_cursor = len(messages)
            if wire_compact_audit.get("compacted") and not compact_audit.get("compacted"):
                emit({"type": "auto_compact", "nativeTranscript": True, **wire_compact_audit})
        # Compaction reassigned `messages` to a new list — re-point the live
        # reference so a cancel after this still persists the compacted transcript.
        try:
            ctx._live_messages = messages  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
        model_lease = None
        try:
            request_messages = wire_messages if wire_messages is not None else messages
            prompt_estimate = (
                _estimate_messages_tokens(request_messages)
                if wire_messages is not None
                else sum(
                    len(str(message.get("content") or ""))
                    for message in request_messages
                ) // 4
            )
            model_lease = reserve_model_call(
                prompt_estimate
            )
            # Empty schema list means "no tools" (e.g. mapped scope ∅). Pass
            # tools=None so transports treat it as tool-calling off — not an
            # invalid empty tools array. execute_tool still fail-closes the scope.
            native_tools = tool_function_schemas(scope) if enable_tools else None
            if native_tools is not None and len(native_tools) == 0:
                native_tools = None
            # For an explicit terminal/Goal/To-do workflow, or a caller that
            # explicitly requires evidence from the supplied native scope, the
            # first model turn must be a native tool call rather than a prose
            # disclaimer. Likewise, a corrective retry after a provider claims
            # that tools are unavailable must actually require one. Restore the
            # normal ``auto`` policy immediately after that turn so the model
            # can produce a final answer once tool results arrive.
            tool_protocol_retry_pending = (
                bool(messages)
                and messages[-1].get("role") == "user"
                and str(messages[-1].get("content") or "").startswith(
                    "Tool protocol correction:"
                )
            )
            forced_configs = []
            if (
                enable_tools
                and native_tools
                and (
                    tool_protocol_retry_pending
                    or (
                        not steps
                        and iteration == 0
                        and (require_initial_tool or _prompt_requires_initial_tool(goal))
                    )
                )
            ):
                for config in (
                    [getattr(client, "primary", None)]
                    + list(getattr(client, "fallbacks", []) or [])
                ):
                    if config is not None:
                        forced_configs.append((config, getattr(config, "tool_choice", None)))
                        config.tool_choice = "required"
            try:
                res = client.generate_messages(
                    request_messages,
                    tools=native_tools,
                )
            finally:
                for config, previous_tool_choice in forced_configs:
                    config.tool_choice = previous_tool_choice
            _accumulate_usage(res)
            if model_lease is not None:
                reported_usd = max(0.0, float(getattr(res, "cost_usd", 0.0) or 0.0))
                admitted_usd = (
                    model_lease.estimate.usd
                    if budget is not None and budget.effective_remaining().usd is not None
                    else reported_usd
                )
                model_lease.commit(Usage(input_tokens=max(0, int(getattr(res, "prompt_tokens", 0) or 0)),
                                         output_tokens=max(0, int(getattr(res, "completion_tokens", 0) or 0)),
                                         cache_tokens=max(0, int(getattr(res, "cache_tokens", 0) or 0)),
                                         usd=admitted_usd))
        except BudgetRejected as exc:
            if model_lease is not None:
                model_lease.refund()
            err = ("execution budget cancelled" if exc.reason is RejectionReason.CANCELLED
                   else f"execution budget exhausted ({exc.reason.value})")
            emit({"type": "budget_error", "reason": exc.reason.value, "error": err})
            return AgentLoopResult(goal=goal, final_text=err, ok=False, steps=steps, messages=messages,
                                   trace_path=tp, model_error=err, correlation=correlation,
                                   cost_usd=usage_cost_usd, prompt_tokens=usage_prompt_tokens,
                                   completion_tokens=usage_completion_tokens)
        except Exception:
            if model_lease is not None:
                model_lease.refund()
            raise
        emit({"type": "model_result", **getattr(res, "to_log", lambda: {})()})
        # Cancellation is checked at the model/tool handoff so a model response
        # cannot authorize side effects after the run has been cancelled.
        if budget is not None and budget.snapshot().cancelled:
            err = "execution budget cancelled"
            emit({"type": "budget_error", "reason": "cancelled", "error": err})
            return AgentLoopResult(goal=goal, final_text=err, ok=False, steps=steps, messages=messages,
                                   trace_path=tp, model_error=err, correlation=correlation,
                                   cost_usd=usage_cost_usd, prompt_tokens=usage_prompt_tokens,
                                   completion_tokens=usage_completion_tokens)
        if getattr(res, "ok", True) is False:
            # Model transport failed (missing local backend, provider down, blocked
            # egress). Fail visibly: the delivery gate passes empty text through
            # unchanged by design, so without this branch a dead backend surfaces
            # as an empty "ok" answer.
            err = str(getattr(res, "error", "") or "unknown model error")
            emit({"type": "model_error",
                  "provider": str(getattr(res, "provider", "") or ""),
                  "model": str(getattr(res, "model", "") or ""),
                  "error": err})
            final_text = (
                f"Model call failed: {err}\n\n"
                "Check the provider setup (local backend installed and running, or API "
                "credentials configured), then retry."
            )
            messages.append({"role": "assistant", "content": final_text})
            write_process_log(
                Path(ctx.root), goal=goal, status="failed",
                model=str(getattr(res, "model", "") or ""),
                actions="_(no tools executed)_", evidence=f"trace: {tp}",
                outcome=final_text, model_error=err,
                lessons=lessons_from_run(model_error=err, ok=False, final_text=final_text),
            )
            emit({
                "type": "final",
                "ok": False,
                "downgraded": False,
                # Keep aligned with TUI TRANSCRIPT_ROW_CHAR_CAP (8000): a 500-char
                # cut made live answers look empty when the upgrade path missed.
                "text": final_text[:8000],
            })
            return AgentLoopResult(goal=goal, final_text=final_text, ok=False, steps=steps,
                                   messages=messages, gated=False, trace_path=tp,
                                   model_error=err, cost_usd=usage_cost_usd,
                                   prompt_tokens=usage_prompt_tokens,
                                   completion_tokens=usage_completion_tokens)
        text = getattr(res, "text", "") or ""
        reasoning_text = getattr(res, "reasoning_text", "") or ""
        if show_thinking and reasoning_text:
            emit({
                "type": "thinking",
                "provider": getattr(res, "provider", ""),
                "model": getattr(res, "model", ""),
                "text": reasoning_text,
                "reasoningTokens": getattr(res, "reasoning_tokens", 0),
            })
        native_calls = list(getattr(res, "tool_calls", []) or [])
        if getattr(res, "ok", True) and not text.strip() and not native_calls:
            # Same typed contract as agent/model.py _normalize_result: a client
            # that bypasses the transport (tests, local adapters) must produce the
            # identical wording so one assertion covers both layers.
            err = "empty terminal model response (no text or tool calls)"
            emit({"type": "model_error", "provider": getattr(res, "provider", ""),
                  "model": getattr(res, "model", ""), "error": err})
            final_text = f"Model call failed: {err}"
            messages.append({"role": "assistant", "content": final_text})
            return AgentLoopResult(goal=goal, final_text=final_text, ok=False, steps=steps,
                                   messages=messages, gated=False, trace_path=tp, model_error=err,
                                   cost_usd=usage_cost_usd, prompt_tokens=usage_prompt_tokens,
                                   completion_tokens=usage_completion_tokens)
        if native_calls:
            # Native function-calling path. Generic providers retain Sophia's
            # historical text feedback. DS4-style providers are stricter:
            # every call must have a unique ID and object-valued JSON arguments,
            # then the exact assistant call batch is continued with role=tool
            # results. Any malformed slot rejects the whole strict batch before
            # side effects so the wire transcript never misrepresents execution.
            strict_native = (
                native_transcript_required
                or bool(getattr(res, "requires_native_tool_transcript", False))
                or wire_messages is not None
            )
            wire_tool_calls: list[dict] = []
            if strict_native:
                native_transcript_required = True
                calls = []
                skipped = []
                malformed_tool_call = bool(
                    getattr(res, "malformed_tool_call", False)
                )
                if malformed_tool_call:
                    # Provider parsing drops malformed slots before exposing
                    # ``tool_calls``. The result flag is therefore the only
                    # evidence that this strict assistant batch contained an
                    # unbindable call; reject valid siblings with it.
                    skipped.append({
                        "tool": "",
                        "reason": "malformed_tool_call",
                    })
                seen_call_ids: set[str] = set()
                for call in native_calls:
                    executable, wire_call, invalid = _native_tool_transcript_call(call)
                    if invalid is not None:
                        skipped.append(invalid)
                        continue
                    assert executable is not None and wire_call is not None
                    call_id = str(wire_call["id"])
                    if call_id in seen_call_ids:
                        skipped.append({
                            "tool": executable[0],
                            "toolCallId": call_id,
                            "reason": "duplicate_tool_call_id",
                        })
                        continue
                    seen_call_ids.add(call_id)
                    calls.append(executable)
                    wire_tool_calls.append(wire_call)
                if skipped:
                    # All-or-nothing is deliberate. Executing only the valid
                    # subset would force us either to invent results for the
                    # malformed IDs or to send a transcript different from the
                    # assistant turn the provider actually produced.
                    calls = []
                    wire_tool_calls = []
                raw_count = len(native_calls) + int(malformed_tool_call)
            else:
                raw_calls = [_native_tool_call(call) for call in native_calls]
                calls, skipped = _filter_native_calls(raw_calls)
                raw_count = len(raw_calls)
            for skip in skipped:
                emit({"type": "tool_call_skipped", "native": True, **skip})
            if not calls:
                # All slots incomplete — do not inject empty-tool errors; ask the
                # model to re-emit a complete call (or final answer).
                messages.append({
                    "role": "assistant",
                    "content": text or "[incomplete native tool call batch]",
                })
                hint = (
                    "Your previous tool-call batch was incomplete (empty tool name "
                    "and/or missing required arguments). Re-emit ONE complete tool "
                    "call with a valid name and all required args, or answer in prose."
                )
                if skipped:
                    details = "; ".join(
                        f"{s.get('tool') or '<empty>'}: {s.get('reason')}"
                        + (f" ({', '.join(s.get('errors') or [])})" if s.get("errors") else "")
                        for s in skipped[:4]
                    )
                    hint += f" Skipped: {details}."
                messages.append({"role": "user", "content": hint})
                emit({
                    "type": "tool_batch_incomplete",
                    "skipped": len(skipped),
                    "raw": raw_count,
                })
                continue
            if strict_native:
                if wire_messages is None:
                    wire_messages = [dict(message) for message in messages]
                wire_assistant: dict[str, Any] = {
                    "role": "assistant",
                    "content": text or "",
                    "tool_calls": wire_tool_calls,
                }
                continuation_reasoning = str(
                    getattr(res, "continuation_reasoning_content", "") or ""
                )
                if continuation_reasoning:
                    wire_assistant["reasoning_content"] = continuation_reasoning
                wire_messages.append(wire_assistant)
            assistant_content = text or (
                f"[native tool calls: {len(calls)}"
                + (f", skipped incomplete: {len(skipped)}" if skipped else "")
                + "]"
            )
            messages.append({
                "role": "assistant",
                "content": assistant_content,
            })
            # LIVE TUI only sees tool_call/tool_result unless we stream tokens.
            # DS4 (and other native tool transports) often return prose + tool
            # calls in one non-streamed turn: the prose was persisted to the
            # session file but never rendered, so operators saw only tool cards.
            # Emit the prose before tools so it appears above the cards.
            if _visible_assistant_prose(text):
                emit({
                    "type": "assistant_message",
                    "text": str(text).strip(),
                    "withTools": True,
                    "ok": True,
                })
            feedback_parts: list[str] = []
            for name, args in calls:
                emit({"type": "tool_call", "tool": name, "args": args, "native": True})
            # Preserve model order, but execute ONLY independent idempotent reads
            # concurrently. Mutations, unknown/plugin tools, and duplicate reads
            # are serial barriers (partition_tool_calls); this prevents a native
            # batch such as write_file -> read_file from racing its own write.
            results = []
            batches = partition_tool_calls(calls)
            for batch in batches:
                if max_parallel_tools > 1 and len(batch) > 1:
                    workers = min(max_parallel_tools, len(batch))
                    emit({
                        "type": "tool_batch_start",
                        "tools": [name for name, _ in batch],
                        "size": len(batch),
                        "parallel": workers,
                    })
                    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                        batch_results = list(pool.map(
                            lambda pair: run_tool(*pair, track_efficiency=False),
                            batch,
                        ))
                    # Worker completion order is intentionally ignored. Commit
                    # cache/signature/no-progress state in MODEL order after the
                    # whole batch joins, so scheduling jitter cannot change the
                    # nudge the next model turn sees.
                    for (name, args), result in zip(batch, batch_results):
                        _efficiency.record(name, args, result.ok, result.output)
                    emit({
                        "type": "tool_batch_end",
                        "tools": [name for name, _ in batch],
                        "size": len(batch),
                        "parallel": workers,
                    })
                else:
                    batch_results = [run_tool(name, args) for name, args in batch]
                results.extend(batch_results)
            for call_index, ((name, args), result) in enumerate(zip(calls, results)):
                steps.append(result.to_step(args, native=True))
                emit({"type": "tool_result", "tool": name, "ok": result.ok,
                      "output": (result.output or result.error)[:1000],
                      "errorType": result.error_type,
                      "exitCode": result.exit_code,
                      "native": True})
                tool_feedback = budget_feedback(result.as_feedback(), _feedback_cap)
                feedback_parts.append(f"[tool:{name}]\n{tool_feedback}")
                if strict_native:
                    assert wire_messages is not None
                    wire_messages.append({
                        "role": "tool",
                        "tool_call_id": wire_tool_calls[call_index]["id"],
                        "name": name,
                        "content": tool_feedback,
                    })
            if skipped:
                feedback_parts.append(
                    "[tool_call_skipped]\n"
                    + f"Dropped {len(skipped)} incomplete parallel tool slot(s) "
                    "(empty name or missing required args). Prefer fewer, complete calls."
                )
            _nudge = _efficiency.nudge_if_stuck()
            if _nudge:
                feedback_parts.append(_nudge)
                emit({"type": "tool_no_progress", "nudge": _nudge})
            messages.append({"role": "user", "content": "\n\n".join(feedback_parts)})
            if strict_native:
                if _nudge:
                    assert wire_messages is not None
                    wire_messages.append({"role": "user", "content": _nudge})
                # The native assistant/tool turns above represent the same
                # logical exchange as the sanitized assistant/user placeholders
                # just persisted. Advance the cursor so they are not copied into
                # the wire transcript on the next iteration.
                wire_persisted_cursor = len(messages)
            if reserve_answer_only_call_after_tool_work():
                break
            continue
        # A provider that says it has no tools is contradicting this loop when
        # native schemas were supplied. Give it a bounded corrective turn
        # before accepting the prose as a terminal answer. This is especially
        # important for 020s/reasoning models, which occasionally fall back to
        # a capability disclaimer instead of emitting a function call.
        if (
            enable_tools
            and _claims_tools_are_unavailable(text)
            and iteration < _total_ceiling - 1
            and continuity_nudges < 2
        ):
            continuity_nudges += 1
            messages.append({"role": "assistant", "content": text})
            messages.append({"role": "user", "content": (
                "Tool protocol correction: Sophia supplied callable tools for "
                "this run. Do not claim that tools are unavailable. Emit the "
                "native function call now for the requested operation; do not "
                "answer in prose until the tool result is received."
            )})
            emit({
                "type": "tool_protocol_retry",
                "reason": "provider_claimed_tools_unavailable",
                "iteration": iteration,
                "nudge": continuity_nudges,
            })
            continue
        kind, a, b = parse_action(text)
        if kind == "final":
            # A steering request can arrive while this terminal response is in
            # flight. Consume it at this safe boundary before publishing the
            # run result, rather than silently dropping an acknowledged request.
            if steering_consumer is not None:
                try:
                    pending = steering_consumer() or []
                except Exception:
                    pending = []
                if pending:
                    for prompt in pending:
                        text_prompt = str(prompt).strip()
                        if text_prompt:
                            messages.append({"role": "user", "content": text_prompt})
                            emit({"type": "steer_applied", "text": text_prompt[:500]})
                    continue
            candidate_final = a or text
            degenerate_reason = (
                "" if exact_output else _degenerate_response_reason(candidate_final)
            )
            if degenerate_reason:
                # Do not persist or re-feed the repeated text. The measured
                # RavenX failure repeated the same paragraph up to 21 times per
                # turn; feeding that artifact back made every nudge more likely
                # to reproduce it and inflated one session past 100 KB.
                emit({
                    "type": "model_response_degenerate",
                    "reason": degenerate_reason,
                    "chars": len(candidate_final),
                    "iteration": iteration,
                })
                final_text = "(repetitive model response rejected; forcing a clean conclusion)"
                force_conclusion_reason = "degenerate_response"
                break
            if require_live_refresh and not _has_successful_refresh_step(steps):
                # A resumed mutable-status task must not succeed by echoing the
                # previous assistant answer. Give the model bounded chances to
                # obtain fresh successful tool evidence in this run; failed or
                # denied calls do not satisfy the refresh contract. If it still
                # declines, keep the checkpoint resumable instead of calling it
                # complete.
                if (
                    enable_tools
                    and iteration < _total_ceiling - 1
                    and refresh_nudges < 2
                ):
                    refresh_nudges += 1
                    messages.append({"role": "assistant", "content": candidate_final})
                    messages.append({"role": "user", "content": (
                        "This resumed task requires a fresh read of mutable external "
                        "state before any prior status can be repeated. CALL an "
                        "appropriate read-only tool now. Do not answer from the "
                        "previous assistant summary."
                    )})
                    emit({
                        "type": "continuation_refresh_required",
                        "iteration": iteration,
                        "nudge": refresh_nudges,
                    })
                    continue
                incomplete = True
                incomplete_reason = "live_state_refresh_missing"
                final_text = candidate_final
                break
            if (
                continue_unfinished_objective
                and _explicitly_unfinished_status(
                    candidate_final, current_task or goal
                )
            ):
                # The model's own report says a persistent objective is not done
                # (for example, "PR remains open" while asked to monitor until
                # merge). Keep executing rather than converting that checkpoint
                # into a normal final answer.
                if enable_tools and iteration < _total_ceiling - 1:
                    messages.append({"role": "assistant", "content": candidate_final})
                    messages.append({"role": "user", "content": (
                        "Your latest report explicitly says the active objective is "
                        "still unfinished. Continue using tools now; do not finalize "
                        "until it is complete or genuinely blocked."
                    )})
                    emit({
                        "type": "unfinished_objective_continue",
                        "iteration": iteration,
                    })
                    continue
                incomplete = True
                incomplete_reason = "objective_still_incomplete"
                final_text = candidate_final
                break
            # Nudge: weaker local models (4-bit quants, small MoE) often stop
            # after 1-2 tool calls and narrate remaining steps as prose instead
            # of executing them. When tools are available and the model stopped
            # early with what looks like narration (long text, tool names, or
            # "next step" language), hard-loop it back — nudge budget scales
            # with max_steps so the model keeps going until the iteration
            # ceiling. Short genuine answers ("done.") pass through.
            _max_nudges = max(2, _total_ceiling // 2)
            # Aggressive continuity nudges (recover/use_data/intent) are capped
            # tighter than the narration budget so a weak model that keeps
            # announcing actions without calling tools can't run up many extra
            # turns (slow on local models). Single-shot runs (max_steps==1) never
            # reach any nudge: iteration < _total_ceiling - 1 is False at ceiling
            # 1, so the hard-cap contract is preserved either way.
            _max_continuity_nudges = max(2, min(6, _total_ceiling // 6))
            kind = (
                _continuation_nudge_kind(
                    text,
                    steps,
                    post_tool_continuity=post_tool_continuity,
                    nudged_index=post_tool_nudged_at,
                )
                if allow_continuation_nudges
                else ""
            )
            aggressive = kind in ("recover", "use_data", "intent")
            # recover/use_data/narration need prior tool activity; intent does
            # not — a weak model can announce an action on its very first turn
            # without ever calling a tool, and that must still be caught.
            needs_steps = kind in ("recover", "use_data", "narration")
            if kind and not (enable_tools
                             and iteration < _total_ceiling - 1
                             and nudges < _max_nudges
                             and (steps if needs_steps else True)
                             and (continuity_nudges < _max_continuity_nudges
                                  if aggressive else True)):
                kind = ""
            if kind:
                nudges += 1
                last_tool = steps[-1].get("tool") if steps else None
                last_err = (steps[-1].get("error") or "") if steps else ""
                if aggressive:
                    continuity_nudges += 1
                    # recover/use_data are tied to this tool-result boundary;
                    # mark it so the same boundary isn't re-nudged.
                    if kind in ("recover", "use_data"):
                        post_tool_nudged_at = len(steps) - 1
                messages.append({"role": "assistant", "content": text})
                if kind == "recover":
                    messages.append({"role": "user", "content": (
                        f"The last tool `{last_tool}` FAILED: {last_err[:200]}. "
                        "Do NOT just announce a plan — either CALL a different "
                        "tool or approach NOW, or give the best complete answer "
                        "from what you already have. Act; don't narrate."
                    )})
                    emit({"type": "post_tool_continue", "kind": "recover",
                          "iteration": iteration, "nudge": nudges, "tool": last_tool})
                    continue
                if kind == "use_data":
                    messages.append({"role": "user", "content": (
                        f"You just received output from `{last_tool}`. If the "
                        "goal needs more steps, CALL the next tool now. If — and "
                        "only if — the goal is fully achieved, give the complete "
                        "final answer (no tool call)."
                    )})
                    emit({"type": "post_tool_continue", "kind": "use_data",
                          "iteration": iteration, "nudge": nudges, "tool": last_tool})
                    continue
                if kind == "intent":
                    messages.append({"role": "user", "content": (
                        "You announced an action but did not call a tool. Do NOT "
                        "describe or announce the next step — CALL the tool NOW "
                        "(JSON object or native function call), or give the final "
                        "answer if the goal is already met."
                    )})
                    emit({"type": "nudge", "kind": "intent",
                          "iteration": iteration, "nudge": nudges})
                    continue
                # kind == "narration" — the baseline guard, active on every path.
                used = sorted({s["tool"] for s in steps if s.get("ok")})
                messages.append({"role": "user", "content": (
                    f"STOP NARRATING. You used: {', '.join(used)}. "
                    "The goal is NOT complete. Do NOT describe, number, or "
                    "announce the next tool — just CALL it. Emit a tool call "
                    "NOW (JSON object or native function call)."
                )})
                emit({"type": "nudge", "kind": "narration",
                      "iteration": iteration, "nudge": nudges})
                continue
            final_text = candidate_final
            break
        if not enable_tools:
            final_text = (
                "I attempted to call a tool, but tools are disabled for this comparison run. "
                "Please answer directly in prose."
            )
            break
        # Tool calls are safe to retain as model-visible history. A raw final answer
        # is deliberately NOT appended here: it must pass the delivery gate first,
        # otherwise a withheld answer could be persisted and re-fed on a later turn.
        messages.append({"role": "assistant", "content": text})
        name, args = a, b
        emit({"type": "tool_call", "tool": name, "args": args})
        result = run_tool(name, args)
        steps.append(result.to_step(args))
        emit({"type": "tool_result", "tool": name, "ok": result.ok,
              "output": (result.output or result.error)[:1000],
              "errorType": result.error_type,
              "exitCode": result.exit_code})
        _fb = f"[tool:{name}]\n{budget_feedback(result.as_feedback(), _feedback_cap)}"
        _nudge = _efficiency.nudge_if_stuck()
        if _nudge:
            _fb = _fb + "\n\n" + _nudge
            emit({"type": "tool_no_progress", "nudge": _nudge})
        messages.append({"role": "user", "content": _fb})
        if reserve_answer_only_call_after_tool_work():
            break
    else:
        # The for-loop exhausted its iteration ceiling without the model ever
        # emitting a tool-free final answer (a break). Left as-is, the run ends
        # with only the bare placeholder below — a system string starting with
        # "(", not a report — so an operator who waited through N tool calls
        # gets nothing to read. Flag it so the conclusion pass forces a real
        # final summary; this is exactly the case that needs one most.
        hit_ceiling = not final_text
        if hit_ceiling:
            incomplete = True
            incomplete_reason = "execution_slice_exhausted"
        final_text = final_text or (
            f"(reached {_total_ceiling}-iteration ceiling without a final answer "
            f"— {len(steps)} tool calls executed)"
        )

    # Conclusion pass: if the model's final answer looks incomplete (trails off
    # with ":", announces future actions, or is too short for the work done),
    # force one last call asking for a proper summary. This ensures the user
    # always gets a clear conclusion after a multi-tool run. It also fires when
    # the loop hit its iteration ceiling (hit_ceiling): the placeholder there
    # starts with "(" so the incomplete-text heuristic below would skip it, but
    # a run that burned its whole budget without concluding needs the forced
    # report more than any other, not less.
    _incomplete_markers = (":", "let me", "now i'll", "next,", "i will now")
    _looks_incomplete = (
        steps
        and final_text
        and not final_text.startswith("(")  # not a system message
        and (
            final_text.rstrip().endswith(":")
            or any(mk in final_text.lower()[-80:] for mk in _incomplete_markers)
            or (len(steps) >= 3 and len(final_text) < 60)
        )
    )
    if (_looks_incomplete or hit_ceiling or incomplete or force_conclusion_reason) and not exact_output:
        used = sorted({s["tool"] for s in steps if s.get("ok")})
        failed = sorted({s["tool"] for s in steps if not s.get("ok")})
        if not force_conclusion_reason:
            messages.append({"role": "assistant", "content": final_text})
        from agent.response_style import final_presentation_policy, resolve_response_style
        presentation = final_presentation_policy(
            resolve_response_style(current_task or goal, response_style))
        evidence_text = _conclusion_tool_evidence(steps, tool_feedback_cap)
        conclusion_context = (
            f"ACTIVE REQUEST\n{current_task or goal}\n\n"
            "TOOL EVIDENCE\n"
            + evidence_text
            + (
                "\n\nEXECUTION STATUS\nThis execution slice ended before the "
                "active objective was complete. Write an honest resumable "
                "checkpoint: what was completed, the latest verified state, and "
                "what remains. Do not claim the objective succeeded."
                if incomplete else ""
            )
            + f"\n\n{presentation}"
        )
        messages.append({"role": "user", "content": (
            f"Active request: {current_task or goal}\n"
            f"You executed {len(steps)} tool calls ({', '.join(used)}). "
            + (f"Failed: {', '.join(failed)}. " if failed else "")
            + (
                "This execution slice is incomplete and resumable. Report the "
                "verified checkpoint and what remains without claiming success. "
                if incomplete else ""
            )
            + "Answer the active request directly now. Do NOT discuss the "
            "transcript, tool count, or what you plan to do. Do NOT call more "
            "tools. Just give the user the answer."
        )})
        emit({
            "type": "conclusion_pass",
            "tools_used": len(used),
            **({"reason": force_conclusion_reason} if force_conclusion_reason else {}),
        })
        conclusion_accepted = False
        conclusion_lease = None
        try:
            conclusion_lease = reserve_model_call(max(1, len(conclusion_context) // 4))
            conclusion = client.generate(
                "You are the final-answer writer. Answer the ACTIVE REQUEST "
                "directly using the supplied TOOL EVIDENCE. Do not discuss the "
                "conversation, your instructions, or what you intend to do. "
                "Do not call tools.",
                conclusion_context,
            )
            _accumulate_usage(conclusion)
            if conclusion_lease is not None:
                reported_usd = max(0.0, float(getattr(conclusion, "cost_usd", 0.0) or 0.0))
                admitted_usd = (
                    conclusion_lease.estimate.usd
                    if budget is not None and budget.effective_remaining().usd is not None
                    else reported_usd
                )
                conclusion_lease.commit(Usage(
                    input_tokens=max(0, int(getattr(conclusion, "prompt_tokens", 0) or 0)),
                    output_tokens=max(0, int(getattr(conclusion, "completion_tokens", 0) or 0)),
                    cache_tokens=max(0, int(getattr(conclusion, "cache_tokens", 0) or 0)),
                    usd=admitted_usd,
                ))
            if getattr(conclusion, "ok", True) and (conclusion.text or "").strip():
                candidate = conclusion.text.strip()
                rejected_reason = _degenerate_response_reason(candidate)
                if rejected_reason:
                    emit({
                        "type": "conclusion_rejected",
                        "reason": rejected_reason,
                        "chars": len(candidate),
                    })
                else:
                    final_text = candidate
                    conclusion_accepted = True
                    emit({"type": "conclusion_result", "text": final_text[:300]})
        except BudgetRejected as exc:
            if conclusion_lease is not None:
                conclusion_lease.refund()
            terminal_model_error = (
                "model_call_limit"
                if exc.reason is RejectionReason.PARENT
                else f"execution budget exhausted ({exc.reason.value})"
            )
            emit({"type": "conclusion_error", "error": terminal_model_error})
        except Exception as exc:  # noqa: BLE001 - conclusion is best-effort
            if conclusion_lease is not None:
                conclusion_lease.refund()
            emit({"type": "conclusion_error", "error": type(exc).__name__})
        if (
            force_conclusion_reason == "degenerate_response"
            and not conclusion_accepted
        ):
            terminal_model_error = "degenerate_response_loop"
            final_text = (
                "The selected model entered a repetitive response loop and did "
                "not produce a usable final answer. Sophia stopped the run to "
                f"prevent further repetition after {len(steps)} tool call(s). "
                "Retry with a different model or a smaller step budget."
            )
        elif (
            force_conclusion_reason == "reserved_final_model_call"
            and not conclusion_accepted
        ):
            terminal_model_error = (
                terminal_model_error
                or "reserved final model call did not produce a usable answer"
            )
            final_text = (
                "The worker completed its bounded tool phase but the reserved "
                "answer-only model call did not produce a usable report."
            )

    if budget is not None and budget.snapshot().cancelled:
        err = "execution budget cancelled"
        emit({"type": "budget_error", "reason": "cancelled", "error": err})
        return AgentLoopResult(goal=goal, final_text=err, ok=False, steps=steps, messages=messages,
                               trace_path=tp, model_error=err, correlation=correlation,
                               cost_usd=usage_cost_usd, prompt_tokens=usage_prompt_tokens,
                               completion_tokens=usage_completion_tokens)
    if defer_delivery_gate:
        # Main-plan and sub-agent reports in the sequential A2A harness are
        # intermediate evidence, not operator-facing deliveries. Gating them as
        # final answers can misclassify DISPATCH syntax as empirical claims and
        # stop the chain before the real, gated Main verification pass. Record
        # the deferral explicitly; callers must never surface this result as the
        # terminal answer without a later delivery-gated synthesis.
        gated_text = final_text
        ok = not bool(terminal_model_error)
        downgraded = False
        epistemic = {
            "schema": epistemic_status.SCHEMA,
            "state": "internal_gate_deferred",
            "label": "internal artifact · delivery gate deferred",
            "detail": (
                "This intermediate orchestration artifact was not delivered to "
                "the operator. Its delivery gate is deferred to the final "
                "operator-facing synthesis."
            ),
            "severity": "notice",
            "verdict": "",
            "floorChecked": False,
            "uncertaintyChecked": False,
            "strictGateArmed": False,
            "disagreement": None,
            "reason": "",
            "checks": {
                "delivery": "internal",
                "finalGateDeferred": True,
            },
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        emit({
            "type": "delivery_gate_deferred",
            "reason": "internal_orchestration_artifact",
            "candidateOnly": True,
            "canClaimAGI": False,
        })
    else:
        gated_text, ok, downgraded, epistemic = _gate_final(
            final_text,
            tp,
            goal=goal,
            steps=steps,
            report_context=gate_report_context,
            conscience_strict=getattr(ctx, "conscience_strict", None),
            conscience_mode=getattr(ctx, "conscience_mode", None),
        )
    if terminal_model_error or incomplete:
        ok = False
    write_process_log(
        Path(ctx.root), goal=goal,
        status="done" if ok else ("incomplete" if incomplete else "failed"),
        actions=json.dumps([
            {"tool": step.get("tool"), "ok": bool(step.get("ok"))}
            for step in steps
        ], ensure_ascii=False),
        evidence=f"trace: {tp}", outcome=gated_text,
        model_error=terminal_model_error,
        lessons=lessons_from_run(
            model_error=terminal_model_error,
            ok=ok,
            final_text=gated_text,
        ),
    )
    try:
        from agent.continual_harness import ContinualHarness
        ContinualHarness(Path(ctx.root), base_policy=AGENT_SYSTEM).record_run(
            goal=goal, ok=ok, incomplete=incomplete, steps=steps, trace_path=str(tp)
        )
    except Exception:
        # Harness recording is best-effort and must not change the primary run result.
        pass
    emit({
        "type": "final",
        "ok": ok,
        "downgraded": downgraded,
        # Preview for mid-stream TUI rows. Cap matches apps/sophia-tui
        # TRANSCRIPT_ROW_CHAR_CAP (8000). The bridge `result.finalText` remains
        # the full authoritative body; this is no longer a hostile 500-char cut.
        "text": gated_text[:8000],
        "incomplete": incomplete,
        **({"incompleteReason": incomplete_reason} if incomplete_reason else {}),
    })
    messages.append({"role": "assistant", "content": gated_text})
    return AgentLoopResult(goal=goal, final_text=gated_text, ok=ok, steps=steps,
                           messages=messages, gated=downgraded, trace_path=tp,
                           model_error=terminal_model_error,
                           correlation=correlation, epistemic=epistemic,
                           cost_usd=usage_cost_usd, prompt_tokens=usage_prompt_tokens,
                           completion_tokens=usage_completion_tokens,
                           incomplete=incomplete,
                           incomplete_reason=incomplete_reason)


__all__ = [
    "AgentLoopResult",
    "run_agent_loop",
    "parse_action",
    "AGENT_SYSTEM",
    "_native_tool_call",
    "_filter_native_calls",
    "_use_short_tool_protocol",
    "_compact_messages",
    "_degenerate_response_reason",
    "_clean_persisted_history",
]
