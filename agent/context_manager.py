# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Context-window manager for the Sophia agent loop — token-budgeted, provenance-
tagged, KV-cache-aware assembly of what the model actually sees.

The harness loop (``agent/harness.py``) used to feed prior step outputs to the
model with a blunt ``"\\n\\n".join(prior_outputs)[-4000:]`` character chop. That
silently drops the *front* of history, ignores token budgets, is bilingual-blind
(a CJK char and an ASCII char are not one "character" of budget), and rebuilds the
prompt prefix every turn so the provider's KV cache is invalidated on every call.

This module replaces that with an explicit policy. A context window is a list of
:class:`Segment`s, each tagged with a *kind*, a *priority*, a *provenance* string,
and two structural flags: ``pinned`` (never dropped) and ``stable`` (part of the
cache-stable prefix — ordered first and never compressed, so the provider's KV
cache survives across turns). :class:`ContextManager.pack` then applies a
fail-closed keep / compress / drop policy under a token budget and reports exactly
what it kept, compressed, and dropped — so compaction is *auditable*, not silent.

Discipline (the "Sophia discipline"):
  * **deterministic / offline** — the default token counter is a documented
    bilingual heuristic (no tokenizer download, no network); inject a real
    tokenizer via ``token_counter`` when one is available.
  * **fail-closed** — a ``pinned`` segment is NEVER dropped to fit the budget; if
    the pinned set alone exceeds budget the pack is returned ``over_budget=True``
    rather than silently discarding a system/safety/goal segment.
  * **provenance-preserving** — every drop/compression is reported by its
    provenance tag, and a compressed segment keeps an explicit elision marker
    naming how many tokens were removed and from where.
  * **cache-stable** — the stable prefix is emitted first in a deterministic order
    and never compressed, and :attr:`PackResult.cache_key` is a signature of that
    prefix so a caller can detect a cache-invalidating change.

Nothing here calls a model. Summarization-based compression is *optional* and
injected (``summarizer=...``); the default compressor is deterministic head+tail
elision, which preserves the harness's trailing ``Decision`` / ``中文摘要`` block.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from typing import Callable

# --------------------------------------------------------------------------- #
# Token estimation (bilingual, deterministic, offline)
# --------------------------------------------------------------------------- #

# CJK Unified Ideographs + common Hiragana/Katakana/Hangul blocks. A CJK
# codepoint typically costs MORE than a quarter-token (BPE rarely merges them),
# so we count it heavier than Latin text. These constants are a heuristic, not a
# tokenizer — what matters for budgeting is monotonicity, and a caller with a real
# tokenizer can inject one via ``token_counter``.
_CJK = re.compile(
    r"[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]"
)
_CHARS_PER_TOKEN_LATIN = 4.0
_TOKENS_PER_CJK_CHAR = 1.0


def estimate_tokens(text: str) -> int:
    """Approximate the token count of ``text`` (bilingual-aware, deterministic).

    Latin/code text bills at ~4 chars/token; each CJK codepoint bills at ~1 token.
    Always returns >= 0, and >= 1 for any non-empty string.
    """
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    latin_chars = len(text) - cjk
    est = latin_chars / _CHARS_PER_TOKEN_LATIN + cjk * _TOKENS_PER_CJK_CHAR
    return max(1, round(est))


# A token counter is any ``str -> int``; the default is the heuristic above.
TokenCounter = Callable[[str], int]
# A summarizer compresses ``text`` to <= ``budget`` tokens; returns the compressed
# string. It MUST be deterministic to keep the harness reproducible.
Summarizer = Callable[[str, int], str]


# --------------------------------------------------------------------------- #
# Segments and pack result
# --------------------------------------------------------------------------- #


@dataclass
class Segment:
    """One labelled piece of context competing for the token budget."""

    kind: str  # system|goal|skill|memory|prior|reflection|context|tool|...
    text: str
    priority: int = 0  # higher is kept first; ties broken by insertion order
    pinned: bool = False  # never dropped (may still compress unless stable)
    stable: bool = False  # cache-stable prefix: ordered first, never compressed
    compressible: bool = True
    provenance: str = ""  # audit tag for what was kept/compressed/dropped

    def tag(self) -> str:
        return self.provenance or self.kind


@dataclass
class PackResult:
    """The assembled context plus a full audit of what happened to each segment."""

    text: str
    segments: list[Segment]  # segments actually included (post-compression)
    tokens: int
    budget: int
    stable_prefix_tokens: int
    cache_key: str  # signature of the stable prefix (KV-cache continuity)
    kept: list[str] = field(default_factory=list)
    compressed: list[str] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)
    over_budget: bool = False  # pinned content alone exceeded the budget
    # Explicit accounting hooks for callers/receipts.  These are provider-neutral:
    # token_counter remains the source of truth and no provider metadata is inferred.
    input_tokens: int = 0
    reserve_output_tokens: int = 0

    @property
    def utilization(self) -> float:
        return self.tokens / self.budget if self.budget else 0.0

    def to_log(self) -> dict:
        """Compact, serialisable summary for the harness decision log."""
        return {
            "tokens": self.tokens,
            "budget": self.budget,
            "stablePrefixTokens": self.stable_prefix_tokens,
            "cacheKey": self.cache_key,
            "kept": self.kept,
            "compressed": self.compressed,
            "dropped": self.dropped,
            "overBudget": self.over_budget,
            "inputTokens": self.input_tokens,
            "reserveOutputTokens": self.reserve_output_tokens,
            "utilization": self.utilization,
        }


# --------------------------------------------------------------------------- #
# Deterministic default compressor
# --------------------------------------------------------------------------- #


def head_tail_compress(text: str, budget: int, *, counter: TokenCounter) -> str:
    """Keep the head and tail of ``text`` within ``budget`` tokens, eliding the
    middle with an explicit marker. Tail-preserving on purpose: the harness ends
    each answer with a ``Decision`` / ``中文摘要`` block we must not lose.

    Deterministic and offline. Returns ``text`` unchanged if it already fits.
    """
    if budget <= 0:
        return ""
    if counter(text) <= budget:
        return text
    lines = text.splitlines()
    if len(lines) <= 1:
        # No line structure to exploit — fall back to a proportional char chop
        # that still keeps both ends.
        approx_chars = max(1, int(budget * _CHARS_PER_TOKEN_LATIN))
        half = max(1, approx_chars // 2)
        return text[:half] + f"\n…[elided ~{estimate_tokens(text[half:len(text)-half])} tok]…\n" + text[-half:]
    # Reserve room for the marker, then grow head and tail from both ends until
    # we would exceed budget. Deterministic: head grows first on ties.
    marker_cost = 12
    avail = max(1, budget - marker_cost)
    head: list[str] = []
    tail: list[str] = []
    used = 0
    i, j = 0, len(lines) - 1
    take_head = True
    while i <= j:
        line = lines[i] if take_head else lines[j]
        cost = counter(line) + 1
        if used + cost > avail:
            break
        if take_head:
            head.append(line)
            i += 1
        else:
            tail.insert(0, line)
            j -= 1
        used += cost
        take_head = not take_head
    elided_lines = lines[i : j + 1]
    elided_tok = estimate_tokens("\n".join(elided_lines))
    marker = f"…[elided {len(elided_lines)} lines / ~{elided_tok} tok]…"
    return "\n".join(head + [marker] + tail)


# --------------------------------------------------------------------------- #
# Context manager
# --------------------------------------------------------------------------- #


class ContextManager:
    """Pack labelled segments into a token-budgeted, cache-stable context string.

    Policy (in order):
      1. **Stable prefix** (``stable=True``) is emitted first, in a deterministic
         order, and NEVER compressed — this is what keeps the provider's KV cache
         warm across turns. Its signature is :attr:`PackResult.cache_key`.
      2. **Pinned** segments are guaranteed inclusion (compressed only if needed,
         never dropped). If pinned + stable already exceed the budget the result is
         ``over_budget=True`` — fail-closed: we keep them and report the overflow
         rather than silently discard a system/safety/goal segment.
      3. **Remaining** segments are admitted by ``priority`` desc (ties by
         insertion order). Each that fits whole is kept; otherwise, if
         ``compressible``, it is compressed to the remaining budget (down to a
         floor); if it still will not fit it is dropped. Every action is reported.
    """

    def __init__(
        self,
        budget_tokens: int,
        *,
        reserve_output_tokens: int = 0,
        token_counter: TokenCounter | None = None,
        summarizer: Summarizer | None = None,
        joiner: str = "\n\n",
        compress_floor_tokens: int = 24,
        relevance_fn: Callable[[Segment], float] | None = None,
    ) -> None:
        if budget_tokens <= 0:
            raise ValueError("budget_tokens must be positive")
        self.budget = int(budget_tokens)
        self.reserve_output = max(0, int(reserve_output_tokens))
        self.counter: TokenCounter = token_counter or estimate_tokens
        self.summarizer = summarizer
        self.joiner = joiner
        self.compress_floor = max(1, int(compress_floor_tokens))
        # Optional goal-relevance scorer (Prosoche, thesis §5): boosts the admission
        # rank of UNPINNED segments by their relevance to the active goal, so
        # off-goal context is compressed/dropped FIRST under budget pressure. It NEVER
        # touches the stable prefix or pinned segments (the anchor is pinned+stable,
        # so it is never the thing dropped) — relevance reorders, it cannot evict a
        # fail-closed segment. Default ``None`` -> behaviour byte-identical to before.
        self.relevance_fn = relevance_fn

    # -- internal helpers -------------------------------------------------- #

    def _compress(self, text: str, budget: int) -> str:
        """Compress to <= ``budget`` tokens using the injected summarizer if any,
        else deterministic head+tail elision. The result is verified to fit; if a
        summarizer overshoots we fall back to head+tail (fail-closed on budget)."""
        if self.counter(text) <= budget:
            return text
        if self.summarizer is not None:
            out = self.summarizer(text, budget)
            if self.counter(out) <= budget:
                return out
            # Summarizer overshot its budget — do not trust it; fall back.
        return head_tail_compress(text, budget, counter=self.counter)

    @staticmethod
    def _stable_order(segments: list[tuple[int, Segment]]) -> list[tuple[int, Segment]]:
        # Stable prefix is ordered by (priority desc, insertion order) so it is
        # byte-identical across turns whenever its segments are unchanged.
        return sorted(segments, key=lambda pair: (-pair[1].priority, pair[0]))

    # -- public API -------------------------------------------------------- #

    def pack(self, segments: list[Segment]) -> PackResult:
        available = max(0, self.budget - self.reserve_output)
        indexed = list(enumerate(segments))

        stable = self._stable_order([(i, s) for i, s in indexed if s.stable])
        rest = [(i, s) for i, s in indexed if not s.stable]
        # Admission order for the rest: priority desc, then insertion order.
        rest.sort(key=lambda pair: (-pair[1].priority, pair[0]))

        chosen: list[tuple[int, Segment]] = []
        kept: list[str] = []
        compressed: list[str] = []
        dropped: list[str] = []
        used = 0
        over_budget = False

        # 1) Stable prefix — included verbatim, never compressed.
        stable_tokens = 0
        for _idx, seg in stable:
            cost = self.counter(seg.text)
            chosen.append((_idx, seg))
            kept.append(seg.tag())
            used += cost
            stable_tokens += cost
        if used > available:
            over_budget = True  # stable prefix alone overflows — keep it, flag it.

        # 2) Pinned non-stable — guaranteed inclusion, compressed only if needed.
        pinned = [(i, s) for i, s in rest if s.pinned]
        unpinned = [(i, s) for i, s in rest if not s.pinned]
        for idx, seg in pinned:
            remaining = available - used
            cost = self.counter(seg.text)
            if cost <= remaining or not seg.compressible or remaining < self.compress_floor:
                # Fits, or can't/shouldn't compress — keep as-is (may push over).
                text = seg.text
                if cost > remaining:
                    over_budget = True
                kept.append(seg.tag())
            else:
                text = self._compress(seg.text, remaining)
                compressed.append(seg.tag())
            seg = _with_text(seg, text)
            chosen.append((idx, seg))
            used += self.counter(text)

        # 3) Unpinned — admit by priority (+ optional goal-relevance), compress to
        #    fit, else drop. The relevance term only REORDERS admission among
        #    unpinned segments; it can never evict a pinned/stable segment.
        if self.relevance_fn is not None:
            def _rank(pair: tuple[int, Segment]) -> tuple[float, int]:
                i, s = pair
                try:
                    rel = float(self.relevance_fn(s))
                except Exception:  # noqa: BLE001 — a bad scorer must not break packing
                    rel = 0.0
                return (-(s.priority + rel), i)
            unpinned.sort(key=_rank)
        for idx, seg in unpinned:
            remaining = available - used
            if remaining <= 0:
                dropped.append(seg.tag())
                continue
            cost = self.counter(seg.text)
            if cost <= remaining:
                chosen.append((idx, seg))
                kept.append(seg.tag())
                used += cost
            elif seg.compressible and remaining >= self.compress_floor:
                text = self._compress(seg.text, remaining)
                chosen.append((idx, _with_text(seg, text)))
                compressed.append(seg.tag())
                used += self.counter(text)
            else:
                dropped.append(seg.tag())

        # Emit the stable prefix first, in its _stable_order() sequence (preserved
        # by the append order above — NOT re-sorted by insertion index, which would
        # discard the priority ordering the cache_key documents), then the
        # non-stable segments in insertion order for human-readable flow.
        stable_part = [seg for _i, seg in chosen if seg.stable]
        nonstable_part = [seg for _i, seg in sorted((p for p in chosen if not p[1].stable), key=lambda p: p[0])]
        ordered = stable_part + nonstable_part
        text = self.joiner.join(seg.text for seg in ordered if seg.text)

        prefix_text = self.joiner.join(seg.text for seg in ordered if seg.stable)
        cache_key = hashlib.sha256(prefix_text.encode("utf-8")).hexdigest()[:16]

        return PackResult(
            text=text,
            segments=ordered,
            tokens=self.counter(text),
            budget=available,
            stable_prefix_tokens=stable_tokens,
            cache_key=cache_key,
            kept=kept,
            compressed=compressed,
            dropped=dropped,
            over_budget=over_budget,
            input_tokens=self.counter(text),
            reserve_output_tokens=self.reserve_output,
        )


def _with_text(seg: Segment, text: str) -> Segment:
    return Segment(
        kind=seg.kind,
        text=text,
        priority=seg.priority,
        pinned=seg.pinned,
        stable=seg.stable,
        compressible=seg.compressible,
        provenance=seg.provenance,
    )


# --------------------------------------------------------------------------- #
# Harness convenience: compact a rolling list of prior step outputs
# --------------------------------------------------------------------------- #


def default_prior_budget() -> int:
    """Token budget for prior-step history, overridable via env for experiments."""
    raw = os.environ.get("SOPHIA_CONTEXT_PRIOR_TOKENS", "6000")
    try:
        value = int(raw)
    except ValueError:
        return 6000
    return value if value > 0 else 6000


def compact_history(
    outputs: list[str],
    *,
    budget_tokens: int | None = None,
    token_counter: TokenCounter | None = None,
    summarizer: Summarizer | None = None,
    keep_recent: int = 1,
) -> tuple[str, PackResult]:
    """Compact a rolling list of prior step outputs into a token-budgeted block.

    Recency-aware: the most recent ``keep_recent`` outputs are PINNED (kept whole
    when they fit, compressed before dropped, never dropped), while older outputs
    are admitted by recency and compressed/dropped as the budget runs out. This
    replaces the harness's ``"\\n\\n".join(prior_outputs)[-4000:]`` chop — same
    intent (favour recent context) but token-aware, bilingual, and auditable.

    Returns ``(text, pack_result)`` so the caller can log what was dropped.
    """
    budget = budget_tokens if budget_tokens is not None else default_prior_budget()
    cm = ContextManager(budget, token_counter=token_counter, summarizer=summarizer)
    n = len(outputs)
    segments: list[Segment] = []
    for i, out in enumerate(outputs):
        recency = n - i  # 1 == most recent
        is_recent = recency <= max(0, keep_recent)
        segments.append(
            Segment(
                kind="prior",
                text=out,
                priority=i,  # higher index == newer == admitted first under tight budget
                pinned=is_recent,
                provenance=f"prior#{i}",
            )
        )
    result = cm.pack(segments)
    return result.text, result
