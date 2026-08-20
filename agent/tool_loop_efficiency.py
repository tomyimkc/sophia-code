# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Tool-loop efficiency helpers for the agent loop.

Three independent, FAIL-OPEN optimizations applied while the loop feeds tool
results back to the model (all thread-safe; native tool calls run in parallel):

1. Result budgeting — cap the characters fed back per tool result so one large
   ``read_file``/``grep`` cannot bloat the context (and cost). The full result is
   still on disk; the model is told to narrow with grep.
2. Unproductive-call detection — count consecutive no-match / failed / semantic-
   repeat calls; after a threshold, append a "change strategy" nudge so the model
   stops spraying identical greps (measured in the Kimi K3 gap-analysis run: 35
   tool calls, many ``grep -> (no matches)``).
3. Per-run read cache — serve semantically equivalent idempotent READ calls (read_file,
   grep, glob, list_dir) from cache instead of re-executing. The cache is
   invalidated by any non-read (potentially state-changing) call so a re-read
   after an edit sees fresh content.

Conservative by construction: on any doubt every helper degrades to the
unoptimized behaviour. Write tools are never cached and their semantics are
never altered.
"""
from __future__ import annotations

import json
import threading
from typing import Any

# Per-tool-result character cap fed back to the model.
FEEDBACK_CHAR_CAP = 12000
# Consecutive unproductive calls before a "change strategy" nudge is appended.
NO_PROGRESS_THRESHOLD = 3
# Idempotent read tools that are safe to cache within a run (never state-changing).
READ_TOOLS = frozenset({
    "read_file", "read_runtime_file", "grep", "grep_runtime", "grep_search",
    "glob", "list_dir", "list_files",
    "search", "ls", "cat", "view", "outline", "find_symbol",
    "git_status", "git_diff", "git_log", "read_batch",
})
# A compound read is cacheable/read-only, but parallelizing several compound
# batches at the outer native-call layer would multiply their internal worker
# pools. Keep it a serial barrier there; the batch itself owns bounded fan-out.
PARALLEL_READ_TOOLS = READ_TOOLS - {"read_batch"}
# Outputs that mean a search/read gained nothing.
_NO_MATCH_OUTPUTS = frozenset({
    "", "(no matches)", "no matches", "no results", "(no results)",
    "(tool succeeded, no output)", "(empty)",
})


def budget_feedback(feedback: str, max_chars: int = FEEDBACK_CHAR_CAP) -> str:
    """Cap a tool feedback string; append a narrowing hint when truncated."""
    if max_chars <= 0 or len(feedback) <= max_chars:
        return feedback
    dropped = len(feedback) - max_chars
    return (
        feedback[:max_chars]
        + f"\n… [truncated {dropped} chars — use grep or narrower args to see the relevant part]"
    )


def _drop_exact_integer_default(args: dict, key: str, default: int) -> None:
    value = args.get(key)
    if type(value) is int and value == default:
        args.pop(key, None)


def _canonical_read_args(name: str, args: Any) -> Any:
    """Return conservative semantic identity args for known repository reads.

    Only defaults and normalizations proven by the tool implementations are
    folded. Unknown keys, invalid types, non-default values, list order, and tool
    names remain observable so a cache lookup can never bypass schema errors or
    change behavior.
    """
    if not isinstance(args, dict):
        return args
    canonical = dict(args)
    if name == "read_file":
        _drop_exact_integer_default(canonical, "offset", 0)
        _drop_exact_integer_default(canonical, "limit", 0)
    elif name == "list_dir":
        if canonical.get("path") == ".":
            canonical.pop("path", None)
    elif name == "grep":
        # ``path`` is the exact-file compatibility alias accepted by grep.
        # Normalize it to the historical ``glob`` spelling so retry/caching
        # behavior is identical whichever schema spelling the model chose.
        if "path" in canonical and "glob" not in canonical:
            canonical["glob"] = canonical.pop("path")
        elif canonical.get("path") == canonical.get("glob"):
            canonical.pop("path", None)
        if canonical.get("glob") == "**/*":
            canonical.pop("glob", None)
    elif name == "find_symbol":
        symbol = canonical.get("name")
        if isinstance(symbol, str):
            canonical["name"] = symbol.strip()
    elif name == "git_diff":
        if canonical.get("staged") is False:
            canonical.pop("staged", None)
    elif name == "git_log":
        _drop_exact_integer_default(canonical, "limit", 10)
    elif name == "read_batch":
        _drop_exact_integer_default(canonical, "max_workers", 4)
        _drop_exact_integer_default(canonical, "max_chars_per_result", 4000)
        # Child mappings stay exact here, including insertion order. Their
        # first schema error is observable and can change with key order.
        # Valid child defaults are folded inside read_batch only *after* child
        # validation, where duplicate rows can be reconstructed safely.
    return canonical


def call_signature(name: str, args: Any) -> str:
    """Stable semantic call identity shared by batching, cache, and read_batch."""
    try:
        canonical = _canonical_read_args(
            name, {} if args is None else args)
        canon = json.dumps(
            canonical,
            # Preserve nested child key order for compound read_batch errors.
            sort_keys=name != "read_batch",
            ensure_ascii=False,
        )
    except (TypeError, ValueError):
        canon = repr(args)
    return f"{name}:{canon}"

def is_no_match_output(output: str) -> bool:
    """True when a search/read returned an explicit empty result."""
    return (output or "").strip().lower() in _NO_MATCH_OUTPUTS


def is_unproductive(name: str, args: dict, ok: bool, output: str,
                    prior_signatures: list[str]) -> bool:
    """A call is unproductive if it failed, returned no matches, or exactly
    repeats the semantic identity of a call already made this run."""
    if not ok:
        return True
    if name in READ_TOOLS and is_no_match_output(output):
        return True
    if call_signature(name, args) in prior_signatures:
        return True
    return False


def no_progress_nudge(threshold: int, recent_tools: list[str]) -> str:
    tools = ", ".join(sorted({t for t in recent_tools if t})) or "tools"
    return (
        f"[no-progress] {threshold} unproductive tool calls in a row ({tools}: "
        "no matches, failures, or equivalent repeats). STOP repeating the same calls. "
        "Change strategy: try different search terms or a different tool, broaden "
        "or narrow the scope, or synthesize the best answer from what you already have."
    )


class EfficiencyTracker:
    """Per-run tracker combining the unproductive streak and the read cache.

    Thread-safe (native tool calls execute in parallel and call back into
    ``cached_output``/``record``). Fail-open: every method degrades to the
    unoptimized behaviour on doubt.
    """

    def __init__(self, *, no_progress_threshold: int = NO_PROGRESS_THRESHOLD,
                 cache_enabled: bool = True) -> None:
        self.no_progress_threshold = max(1, int(no_progress_threshold))
        self._cache: dict[str, str] = {} if cache_enabled else None  # type: ignore[assignment]
        self._cache_enabled = cache_enabled
        self._streak = 0
        self._signatures: list[str] = []
        self._recent_tools: list[str] = []
        self._lock = threading.Lock()

    def cached_output(self, name: str, args: dict) -> str | None:
        """Return cached output for an equivalent idempotent read, else None."""
        if not self._cache_enabled or name not in READ_TOOLS:
            return None
        with self._lock:
            return self._cache.get(call_signature(name, args))

    def record(self, name: str, args: dict, ok: bool, output: str) -> None:
        """Record a completed call: update cache, signatures, and the streak."""
        sig = call_signature(name, args)
        with self._lock:
            if name in READ_TOOLS:
                if self._cache_enabled and ok:
                    self._cache[sig] = output
            elif self._cache_enabled:
                # A non-read (potentially state-changing) call invalidates cached
                # reads so a subsequent read sees fresh content.
                self._cache.clear()
            unproductive = is_unproductive(name, args, ok, output, self._signatures)
            self._signatures.append(sig)
            self._recent_tools.append(name)
            if len(self._recent_tools) > 8:
                self._recent_tools = self._recent_tools[-8:]
            if unproductive:
                self._streak += 1
            else:
                self._streak = 0

    def nudge_if_stuck(self) -> str | None:
        """Return a change-strategy nudge exactly when the streak reaches the
        threshold, resetting the counter so we nudge once per crossing."""
        with self._lock:
            if self._streak >= self.no_progress_threshold:
                self._streak = 0
                return no_progress_nudge(self.no_progress_threshold, list(self._recent_tools))
            return None

    @property
    def cache_size(self) -> int:
        with self._lock:
            return len(self._cache) if self._cache_enabled else 0


__all__ = [
    "FEEDBACK_CHAR_CAP", "NO_PROGRESS_THRESHOLD", "READ_TOOLS", "PARALLEL_READ_TOOLS",
    "budget_feedback", "call_signature", "is_no_match_output", "is_unproductive",
    "no_progress_nudge", "EfficiencyTracker",
]
