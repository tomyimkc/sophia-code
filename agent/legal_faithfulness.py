# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Semantic citation faithfulness — does a cited authority SUPPORT the proposition?

`legal_citation_exists` answers "is this authority real?" (the *Mata* fake-case
failure). This tier answers the harder, deeper question: "does the holding
actually establish the proposition it is cited for?" — the *Ayinde* failure, where
a **real** authority (s.188(3) Housing Act 1996) was **misstated**.

Honest design, faithful to the repo's thesis:

- **Existence is deterministic; support is not.** Judging whether a holding
  supports a claim needs an LLM judge — which reintroduces hallucination risk — so
  this tier is **measured under the no-overclaim gate** (multi-judge + CIs), never
  asserted. No headline number is published from a single judge.
- **Fail-closed / abstaining.** If there is no authoritative holding text, or no
  judge is configured, or the judge errors, the pair is **abstained** (reported as
  unchecked), never silently passed. With ``require_support`` an abstention is a
  hard fail too (full fail-closed).
- **It flags affirmative misuse.** A ``contradicted`` verdict — a real authority
  cited for something its holding does not establish — is the violation this tier
  exists to catch.

The judge is pluggable: the default is an LLM (``agent.model``); tests inject a
deterministic stub so wiring is verified without a model call.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Callable

from agent.legal_citations import (
    _BUNDLED_REGISTER,
    _CAP,
    _NEUTRAL,
    _US,
    _canon_us_reporter,
    normalize_citation,
)
from agent.config import DATA_DIR

# A judge maps (proposition, holding) -> Verdict. MUST NOT raise; on any failure
# return an abstaining verdict (the caller treats abstain as "unchecked").
Judge = Callable[[str, str], "Verdict"]


@dataclass
class Verdict:
    supports: bool = False
    abstained: bool = True
    reason: str = ""
    method: str = ""


_JUDGE_SYSTEM = (
    "You assess whether a legal authority's holding SUPPORTS the proposition it is "
    "cited for. Reply with ONLY a JSON object: "
    '{"supports": bool, "abstained": bool, "reason": string}. '
    "supports=true ONLY if the holding/headnote actually establishes the proposition. "
    "abstained=true if the holding text is insufficient to decide. "
    "Be strict: a real authority cited for something its holding does not establish "
    "is supports=false (this is the misstated-authority failure mode)."
)


def _citation_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for m in _NEUTRAL.finditer(text):
        spans.append((m.start(), m.end()))
    for m in _CAP.finditer(text):
        spans.append((m.start(), m.end()))
    for m in _US.finditer(text):
        if _canon_us_reporter(m.group(2)):
            spans.append((m.start(), m.end()))
    return sorted(set(spans))


def claim_citation_pairs(text: str) -> list[tuple[str, list[str]]]:
    """Split ``text`` into (proposition, citations) pairs for every sentence that
    carries at least one citation.

    Citations are MASKED before sentence-splitting so the periods inside ``U.S.``,
    ``v.``, ``F. Supp.`` and ``Cap.`` do not fracture a citation across sentences
    (the bug that made ``576 U.S. 644`` un-pairable). Masks are restored in the
    returned proposition text.
    """
    text = text or ""
    parts: list[str] = []
    mapping: dict[str, str] = {}
    last = 0
    for idx, (s, e) in enumerate(_citation_spans(text)):
        if s < last:  # overlapping match — skip
            continue
        token = f"{idx}"  # private-use sentinels: never in legal text
        mapping[token] = normalize_citation(text[s:e])
        parts.append(text[last:s])
        parts.append(token)
        last = e
    parts.append(text[last:])
    masked = "".join(parts)

    pairs: list[tuple[str, list[str]]] = []
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", masked):
        toks = [t for t in re.findall(r"\d+", sentence) if t in mapping]
        if not toks:
            continue
        prop = sentence
        for t in toks:
            prop = prop.replace(t, mapping[t])
        seen: set[str] = set()
        cites = [mapping[t] for t in toks if not (mapping[t] in seen or seen.add(mapping[t]))]
        pairs.append((prop.strip(), cites))
    return pairs


def register_holdings() -> dict:
    """Map normalized citation -> holding text, from register entries that carry a
    ``holding`` field (the authoritative summary to judge a proposition against)."""
    path = DATA_DIR / _BUNDLED_REGISTER
    holdings: dict = {}
    if not path.exists():
        return holdings
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return holdings
    for entry in data.get("authorities", []) if isinstance(data, dict) else []:
        cite, holding = entry.get("citation"), entry.get("holding")
        if cite and holding:
            holdings[normalize_citation(str(cite))] = str(holding)
    return holdings


def default_holding_for(holdings: "dict | None" = None) -> Callable[[str], "str | None"]:
    holdings = register_holdings() if holdings is None else holdings

    def _get(citation: str) -> "str | None":
        return holdings.get(normalize_citation(citation))

    return _get


def make_llm_judge(spec: "str | None" = None) -> Judge:
    """An LLM-backed judge. On any model failure it abstains (fail-closed)."""
    try:
        from agent.model import default_client

        client = default_client(spec)
    except Exception:  # noqa: BLE001 - no/unknown provider -> abstain on every pair
        return abstain_judge(reason="no model client configured")

    def judge(proposition: str, holding: str) -> Verdict:
        user = f"Proposition (as cited):\n'''{proposition}'''\n\nAuthority holding:\n'''{holding}'''"
        try:
            res = client.generate(_JUDGE_SYSTEM, user)
        except Exception:  # noqa: BLE001
            return Verdict(abstained=True, reason="judge call failed", method=f"llm:{spec}")
        if not getattr(res, "ok", False):
            return Verdict(abstained=True, reason="judge unavailable", method=f"llm:{spec}")
        m = re.search(r"\{.*\}", getattr(res, "text", "") or "", re.DOTALL)
        try:
            data = json.loads(m.group(0)) if m else {}
        except (ValueError, AttributeError):
            return Verdict(abstained=True, reason="unparseable judge output", method=f"llm:{spec}")
        return Verdict(
            supports=bool(data.get("supports")),
            abstained=bool(data.get("abstained")),
            reason=str(data.get("reason", ""))[:200],
            method=f"llm:{spec}",
        )

    return judge


def abstain_judge(reason: str = "no judge") -> Judge:
    def judge(proposition: str, holding: str) -> Verdict:
        return Verdict(abstained=True, reason=reason, method="abstain")

    return judge


def assess_text(text: str, *, holding_for=None, judge: "Judge | None" = None) -> dict:
    """Classify each (proposition, citation) pair as supported / contradicted /
    abstained. Fail-closed: anything not affirmatively supported is not 'supported'."""
    holding_for = holding_for or default_holding_for()
    judge = judge or make_llm_judge()
    supported: list[str] = []
    contradicted: list[dict] = []
    abstained: list[dict] = []
    for proposition, cites in claim_citation_pairs(text):
        for c in cites:
            holding = holding_for(c)
            if not holding:
                abstained.append({"citation": c, "why": "no authoritative holding text"})
                continue
            v = _safe_judge(judge, proposition, holding)
            if v.abstained:
                abstained.append({"citation": c, "why": v.reason or "judge abstained"})
            elif v.supports:
                supported.append(c)
            else:
                contradicted.append({"citation": c, "claim": proposition[:90], "reason": v.reason})
    return {"supported": supported, "contradicted": contradicted, "abstained": abstained}


def _safe_judge(judge: Judge, proposition: str, holding: str) -> Verdict:
    try:
        v = judge(proposition, holding)
    except Exception:  # noqa: BLE001 - a broken judge verifies nothing
        return Verdict(abstained=True, reason="judge raised")
    return v if isinstance(v, Verdict) else Verdict(abstained=True, reason="bad judge return")
