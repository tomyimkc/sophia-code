# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Temporal / date-impossibility verifier — catch physically impossible authorship.

A whole class of misattributions is *impossible* by arithmetic, no provenance
record needed: an author who **died before the work existed**. "Aristotle wrote
the Critique of Pure Reason" — Aristotle d. 322 BCE, the work was published 1781
CE — is false on its face. This verifier recomputes that the way
``arithmetic_sound`` recomputes ``a OP b = c``: deterministic, offline, and
pass-if-no-checkable-claim (a soundness check, not a presence requirement).

It catches misattributions OUTSIDE any frozen ``doNotAttributeTo`` corpus, so it
generalizes the gate to unseen works/authors as long as the dated facts resolve.
Data lives in ``data/temporal_facts.json`` (authors -> {died}, works -> {created});
years are integers, negative = BCE. Unknown author or undated work -> abstain
(pass), keeping false positives at zero.

Shape matches ``agent.verifiers.Verifier``: ``(text, task, step) -> {passed,
reasons, detail}``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "temporal_facts.json"

# Authorship assertion: "<author> wrote/authored/composed/penned (the) <work>" and
# the passive "<work> was written by <author>". Kept tight (tight connectors only)
# to mirror provenance_faithful's precision and avoid cross-sentence false matches.
# Work title: a run of words after the verb, up to sentence-ending punctuation or a
# clause break. Greedy within the clause so multi-word titles ("Critique of Pure
# Reason", "Beyond Good and Evil") are captured whole; the leading word is
# capitalized or quoted. Matching is tolerant — the verifier only acts when the
# captured title normalizes to a known dated work, so an over-capture simply misses
# the table and abstains rather than false-firing.
_ATTR_ACTIVE = re.compile(
    r"([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})\s+"
    r"(?:wrote|authored|composed|penned)\s+"
    r"(?:the\s+)?[\"“']?([A-Z][\w.'-]+(?:\s+[\w.'-]+){0,8})[\"”']?"
)
_ATTR_PASSIVE = re.compile(
    r"[\"“']?([A-Z][\w.'-]{0,63}(?:\s+[\w.'-]{1,64}){0,8})[\"”']?\s+"
    r"(?:was|were)\s+(?:written|authored|composed|penned)\s+by\s+"
    r"([A-Z][\w.'-]{0,63}(?:\s+[A-Z][\w.'-]{0,63}){0,3})"
)


def _norm(s: str) -> str:
    s = re.sub(r"\s*\(.*?\)\s*", " ", s or "")
    s = re.sub(r"^\s*the\s+", "", s.strip(), flags=re.IGNORECASE)
    s = re.sub(r"[^\w\s'’-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def _load_facts(facts: "Optional[dict]" = None) -> dict:
    if facts is not None:
        return facts
    try:
        return json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"authors": {}, "works": {}}


def _index(facts: dict) -> "tuple[dict, dict]":
    """Return ({norm author -> died_year}, {norm work (+aliases) -> created_year})."""
    authors: dict[str, int] = {}
    for name, rec in (facts.get("authors") or {}).items():
        died = rec.get("died") if isinstance(rec, dict) else rec
        if died is not None:
            authors[_norm(name)] = int(died)
    works: dict[str, int] = {}
    for title, rec in (facts.get("works") or {}).items():
        created = rec.get("created") if isinstance(rec, dict) else rec
        if created is None:
            continue
        works[_norm(title)] = int(created)
        if isinstance(rec, dict):
            for alt in rec.get("aliases", []) or []:
                works[_norm(str(alt))] = int(created)
    return authors, works


def _year_str(y: int) -> str:
    return f"{abs(y)} {'BCE' if y < 0 else 'CE'}"


# Posthumous publication is normal — a work written near the end of life can appear
# years later (Wittgenstein d.1951 / Philosophical Investigations pub.1953). A real
# temporal IMPOSSIBILITY is century-scale (Aristotle d.322 BCE vs a 1781 CE work),
# so we use a wide posthumous window: only flag when creation is more than this many
# years after death. This trades a sliver of recall (a work fabricated 30y after an
# author's death slips) for zero false positives on genuine posthumous works — the
# right call for a gate whose cardinal rule is "never break a correct answer".
_GRACE_YEARS = 50


def temporal_consistent(facts: "Optional[dict]" = None) -> "Any":
    """Build a verifier that fails on an authorship claim where the author DIED
    before the work was created (by more than a grace margin).

    Deterministic and offline. A claim whose author or work is not in the dated
    facts table is not checkable here and passes (abstain) — composed as a tier,
    never a standalone guarantee.
    """
    authors, works = _index(_load_facts(facts))

    def _resolve_work(work: str) -> "Optional[int]":
        """Resolve a captured title to a creation year — EXACT full-title match only.

        A progressive leading-prefix walk was unsafe: it resolved an over-captured
        "Ethics for his students" down to the ambiguous bare "ethics" (a different
        author's work), firing a false positive. Requiring the full normalized title
        means an over-capture simply MISSES (abstains) instead of mis-resolving to a
        shorter, ambiguous title. Titles whose creation we know are multi-word and
        unambiguous; the regex captures them whole."""
        return works.get(_norm(work))

    def _check_pair(author: str, work: str, violations: list) -> None:
        died = authors.get(_norm(author))
        created = _resolve_work(work)
        if died is None or created is None:
            return
        if created - died > _GRACE_YEARS:
            a = author.strip().strip(" .,;:'\"")
            w = work.strip().strip(" .,;:'\"")
            violations.append(
                f"{a} (d. {_year_str(died)}) could not have written "
                f"{w} (created {_year_str(created)})"
            )

    def _verify(text: str, task: Any, step: dict) -> dict:
        violations: list[str] = []
        for m in _ATTR_ACTIVE.finditer(text or ""):
            _check_pair(m.group(1), m.group(2), violations)
        for m in _ATTR_PASSIVE.finditer(text or ""):
            _check_pair(m.group(2), m.group(1), violations)
        violations = sorted(set(violations))
        if violations:
            return {"passed": False,
                    "reasons": [f"temporally impossible: {v}" for v in violations],
                    "detail": {"violations": violations}}
        return {"passed": True, "reasons": [], "detail": {"authors": len(authors), "works": len(works)}}

    return _verify
