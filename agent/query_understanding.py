# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Query understanding for the AI-search pipeline.

The JD's first-named algorithm surface is *query 理解* — turning a raw user question into a
structured search plan before recall. Sophia had recall/rerank but no query layer; this is
it, built to the repo's house rules: **deterministic, offline, CPU-only**, no API key.

What it does (all rule-based, all explainable):

  - **normalize** — lowercase, collapse whitespace, strip trailing punctuation noise;
  - **language** — en / zh / mixed / other from CJK-vs-latin character share;
  - **intent** — definition / comparison / temporal / navigational / factoid via small,
    auditable keyword rules (bilingual EN+ZH);
  - **decompose** — split comparison / conjunctive questions into atomic sub-queries so a
    multi-hop ask ("compare A and B") fans out to ["A", "B"] and each is recalled on its
    own, then fused downstream;
  - **expand** — widen recall with author surface forms (reused from
    :mod:`agent.entity_aliases`) and a small, curated seed synonym map.

Honest bound: intent rules and the synonym seed are **hand-authored**, not learned — they
generalize over phrasing, not deep meaning. An optional LLM rewrite (:func:`rewrite_with_llm`)
adds HyDE-style query forms when a client is supplied, mirroring ``agent.rerank.llm_rerank``;
it is strictly additive and falls back to ``[]`` so the deterministic path is never broken.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

INTENTS = ("definition", "comparison", "temporal", "navigational", "factoid")

# Auditable, bilingual keyword rules. Order matters: first match wins (most specific first).
_COMPARISON_MARKERS = (
    "compare", "comparison", "versus", " vs ", "vs.", "difference between",
    "differences between", "对比", "比较", "区别", "异同", "相比",
)
_DEFINITION_MARKERS = (
    "what is", "what are", "what's", "define ", "definition of", "meaning of",
    "what does", "什么是", "定义", "含义", "是什么", "何谓",
)
_TEMPORAL_MARKERS = (
    "when ", "what year", "what date", "latest", "current", "today", "now",
    "recent", "most recent", "this year", "nowadays", "最新", "现在", "目前",
    "什么时候", "何时", "近期", "当前", "今天",
)
_NAVIGATIONAL_MARKERS = (
    "official site", "official website", "homepage", "home page", "login",
    "sign in", "download", "官网", "官方网站", "主页", "登录",
)

# Connectives used to split a conjunctive / comparison question into atomic asks. Latin
# connectives need surrounding whitespace; CJK ones (与/和/及/跟/或) split between Han chars
# directly since Chinese is unspaced.
_SPLIT_RE = re.compile(
    r"\s+(?:versus|vs\.?|and|or)\s+|[;；]\s*|(?<=[一-鿿])(?:与|和|及|跟|或)(?=[一-鿿])",
    re.IGNORECASE,
)
# Strip a leading interrogative frame so a sub-query is a clean entity span.
_LEAD_FRAME_RE = re.compile(
    r"^(?:who|what|when|where|which|why|how|whose|whom|is|are|was|were|does|do|did|"
    r"compare|tell me about|谁|什么|哪|为什么|如何|怎样|怎么|是|比较|对比)\b[\s,:'’]*",
    re.IGNORECASE,
)
_DIFF_BETWEEN_RE = re.compile(
    r"(?:difference|differences)\s+between\s+(.+)", re.IGNORECASE
)
# CJK lead-frame words to strip from a sub-query (no word boundary exists between Han chars,
# so the latin _LEAD_FRAME_RE can't catch these).
_CJK_LEAD_RE = re.compile(
    r"^(?:比较|对比|什么是|是什么|定义|谁是|谁|哪些|哪个|为什么|如何|怎样|怎么|介绍)"
)
# Sentence-leading command/interrogative words that a capitalized-span proper-name match can
# wrongly absorb (e.g. "Compare Plato"). Dropped from the front of a candidate name.
_NAME_STOP: frozenset[str] = frozenset(
    {"compare", "comparison", "who", "what", "when", "where", "which", "why", "how",
     "whose", "whom", "is", "are", "was", "were", "does", "do", "did", "tell", "the",
     "a", "an", "list", "name", "explain", "describe", "define", "between"}
)

# A small, curated seed synonym map (NOT learned). Each entry widens recall for a term the
# attribution/provenance corpus uses under more than one surface form. Kept short and
# explainable on purpose; grows by hand as badcases surface.
_SEED_SYNONYMS: dict[str, tuple[str, ...]] = {
    "author": ("writer", "wrote", "composed", "authored"),
    "writer": ("author",),
    "tradition": ("school", "lineage", "current"),
    "founder": ("originator", "founded"),
    "book": ("text", "work", "treatise", "scripture"),
    "belief": ("doctrine", "teaching", "tenet"),
    "meaning": ("definition", "sense"),
    "作者": ("作家", "著者"),
    "传统": ("流派", "学派"),
}

_WS_RE = re.compile(r"\s+")
_CJK_RE = re.compile(r"[一-鿿]")
_LATIN_RE = re.compile(r"[a-zA-Z]")
# Capitalized multi-token span → candidate proper name for alias expansion.
_PROPER_RE = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b")


@dataclass
class AnalyzedQuery:
    """Structured search plan derived from a raw query (see module docstring)."""

    raw: str
    normalized: str
    intent: str
    language: str
    sub_queries: list[str]
    expansions: list[str] = field(default_factory=list)
    is_multi_hop: bool = False

    def search_terms(self) -> str:
        """Normalized query widened with expansion terms — a single recall string."""
        if not self.expansions:
            return self.normalized
        return self.normalized + " " + " ".join(self.expansions)

    def to_dict(self) -> dict:
        return {
            "raw": self.raw,
            "normalized": self.normalized,
            "intent": self.intent,
            "language": self.language,
            "subQueries": list(self.sub_queries),
            "expansions": list(self.expansions),
            "isMultiHop": self.is_multi_hop,
        }


def normalize(query: str) -> str:
    """Lowercase, collapse whitespace, trim surrounding quote/punctuation noise."""
    q = _WS_RE.sub(" ", (query or "").strip())
    # Drop a trailing run of terminal punctuation but keep internal structure.
    q = re.sub(r"[\s?？！!。.,，]+$", "", q)
    return q.lower().strip()


def detect_language(query: str) -> str:
    """en / zh / mixed / other from the share of CJK vs latin letters."""
    cjk = len(_CJK_RE.findall(query or ""))
    latin = len(_LATIN_RE.findall(query or ""))
    if not cjk and not latin:
        return "other"
    if cjk and latin:
        return "mixed"
    return "zh" if cjk else "en"


def classify_intent(query: str) -> str:
    """Map a query to one of :data:`INTENTS` via first-match keyword rules."""
    low = f" {(query or '').lower()} "
    if any(m in low for m in _COMPARISON_MARKERS):
        return "comparison"
    if any(low.lstrip().startswith(m) or m in low for m in _DEFINITION_MARKERS):
        return "definition"
    if any(m in low for m in _NAVIGATIONAL_MARKERS):
        return "navigational"
    if any(m in low for m in _TEMPORAL_MARKERS):
        return "temporal"
    return "factoid"


def _clean_span(span: str) -> str:
    span = _LEAD_FRAME_RE.sub("", span.strip())
    prev = None
    while prev != span:  # CJK frames can stack ("比较" then "什么是"); strip to fixpoint
        prev = span
        span = _CJK_LEAD_RE.sub("", span).strip()
    span = re.sub(r"[\s?？！!。.,，:：'’\"]+$", "", span).strip()
    return span


def decompose(query: str, intent: str) -> list[str]:
    """Split comparison / conjunctive questions into atomic sub-queries.

    Returns ``[normalized]`` when the query is already atomic. Sub-queries are de-framed
    entity spans so each can be recalled independently and fused downstream (multi-hop).
    """
    norm = normalize(query)
    # "difference between A and B" → recover the "A and B" tail, then split it.
    diff = _DIFF_BETWEEN_RE.search(query or "")
    target = _clean_span(diff.group(1)) if diff else norm
    if intent not in {"comparison"} and not diff:
        # Only fan out conjunctive questions for comparison-style asks; a plain
        # "who wrote X and when" should stay one query to keep recall focused.
        return [norm]
    parts = [_clean_span(p) for p in _SPLIT_RE.split(target) if p and p.strip()]
    parts = [p for p in parts if len(p) >= 2]
    # De-dup while preserving order; require at least two real spans to call it multi-hop.
    seen: set[str] = set()
    uniq = [p for p in parts if not (p in seen or seen.add(p))]
    if len(uniq) >= 2:
        return uniq
    return [norm]


def expand(query: str, *, raw: str | None = None, language: str | None = None) -> list[str]:
    """Recall-widening terms: author surface forms + curated seed synonyms.

    ``query`` is the normalized form (used for synonym lookup); ``raw`` is the original,
    case-preserving query (used for proper-name detection — capitalization is the signal).
    Deterministic and additive — never removes signal, only offers more surface forms for
    the same intent. De-duplicated and lowercased; excludes terms already in the query.
    """
    present = set(re.findall(r"[a-z0-9一-鿿]+", (query or "").lower()))
    out: list[str] = []

    # Proper-name alias expansion (e.g. "Leo Tolstoy" → "tolstoy") via the shared resolver.
    # Run on the case-preserving raw query — capitalization is what marks a proper name.
    try:
        from agent.entity_aliases import author_surface_forms

        for name in _PROPER_RE.findall(raw if raw is not None else (query or "")):
            # Drop leading command words a capitalized span absorbed ("Compare Plato" → "Plato").
            tokens = name.split()
            while tokens and tokens[0].lower() in _NAME_STOP:
                tokens.pop(0)
            if not tokens:
                continue
            for form in author_surface_forms(" ".join(tokens)):
                fl = form.lower().strip()
                if fl and fl not in present:
                    out.append(fl)
    except Exception:
        # alias expansion is best-effort enrichment; any failure just yields no
        # extra surface forms and the base expansions below still apply.
        pass

    # Seed synonym expansion over present tokens.
    for tok in list(present):
        for syn in _SEED_SYNONYMS.get(tok, ()):  # type: ignore[arg-type]
            sl = syn.lower()
            if sl not in present:
                out.append(sl)

    # De-dup, preserve order.
    seen: set[str] = set()
    return [t for t in out if not (t in seen or seen.add(t))]


def analyze(query: str, *, client: Any | None = None, max_expansions: int = 8) -> AnalyzedQuery:
    """Full query-understanding pass → an :class:`AnalyzedQuery` search plan.

    Pure-deterministic by default. If ``client`` is supplied, HyDE-style rewrites are appended
    to the expansion terms (best-effort; failures are swallowed) — see :func:`rewrite_with_llm`.
    """
    norm = normalize(query)
    language = detect_language(query)
    intent = classify_intent(query)
    sub_queries = decompose(query, intent)
    expansions = expand(norm, raw=query, language=language)
    if client is not None:
        try:
            expansions = expansions + [r for r in rewrite_with_llm(norm, client) if r]
        except Exception:
            # HyDE rewrites are best-effort; on any client/parse failure we fall
            # back to the deterministic expansions already computed above.
            pass
    # Cap to keep the recall string bounded; de-dup once more after the LLM merge.
    seen: set[str] = set()
    expansions = [e for e in expansions if not (e in seen or seen.add(e))][:max_expansions]
    return AnalyzedQuery(
        raw=query,
        normalized=norm,
        intent=intent,
        language=language,
        sub_queries=sub_queries,
        expansions=expansions,
        is_multi_hop=len(sub_queries) > 1,
    )


def rewrite_with_llm(query: str, client: Any, *, n: int = 3) -> list[str]:
    """Optional HyDE-style query rewrites via the unified adapter; ``[]`` on any failure.

    Mirrors ``agent.rerank.llm_rerank``: best-effort, additive, never raises. Returns up to
    ``n`` alternative phrasings of the same information need.
    """
    system = (
        "You rewrite a search query into alternative phrasings that would retrieve the same "
        "answer. Output ONLY a JSON array of strings, no commentary."
    )
    try:
        result = client.generate(system, f"Query: {query}\n\nReturn up to {n} rewrites.")
    except Exception:
        return []
    if not getattr(result, "ok", False):
        return []
    import json

    match = re.search(r"\[.*\]", result.text, re.DOTALL)
    if not match:
        return []
    try:
        items = json.loads(match.group(0))
    except (json.JSONDecodeError, ValueError):
        return []
    out = [str(s).strip() for s in items if isinstance(s, str) and s.strip()]
    return out[:n]


__all__ = [
    "INTENTS",
    "AnalyzedQuery",
    "analyze",
    "classify_intent",
    "decompose",
    "detect_language",
    "expand",
    "normalize",
    "rewrite_with_llm",
]
