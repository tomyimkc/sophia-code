# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Epistemic self-check for agent responses (Phase 3 runtime gate)."""

from __future__ import annotations

import re

from agent.benchmark_checks import infer_domain, run_attribution_checks

DISCIPLINE_MARKERS = [
    r"source discipline",
    r"來源",
    r"do not attribute",
    r"並未",
    r"did not",
    r"myth",
    r"misconception",
    r"迷思",
    r"council",
    r"理事會",
]

UNCERTAINTY_MARKERS = [
    r"uncertain",
    r"disputed",
    r"存疑",
    r"may\b",
    r"might\b",
    r"recommend",
    r"建議",
]


def _legal_gate(text: str, *, resolver=None, judge=None) -> "dict | None":
    """Self-check any legal citations in an agent answer. Returns None when the
    answer cites no legal authority (cheap no-op for non-legal answers).

    - Existence (deterministic, always): every cited authority must be verifiable
      against the register / live resolver — the *Mata* guardrail, fail-closed.
    - Faithfulness (only when a ``judge`` is supplied): flag a real authority cited
      for a proposition its holding does not support — the *Ayinde* guardrail.
    """
    from agent.legal_citations import extract_citations
    from agent.verifiers import legal_citation_exists, legal_holding_faithful

    if not extract_citations(text):
        return None
    violations: list[str] = []
    checks: list[dict] = []

    exist = legal_citation_exists(resolver=resolver)(text, None, {})
    checks.append({"id": "legal_citation_exists", "passed": exist["passed"], "reasons": exist["reasons"]})
    if not exist["passed"]:
        violations.extend(exist["reasons"])

    faithfulness_run = judge is not None
    if faithfulness_run:
        faith = legal_holding_faithful(judge=judge)(text, None, {})
        checks.append({"id": "legal_holding_faithful", "passed": faith["passed"], "reasons": faith["reasons"]})
        if not faith["passed"]:
            violations.extend(faith["reasons"])

    return {"violations": violations, "checks": checks, "faithfulnessRun": faithfulness_run}


def _numeric_gate(text: str) -> "dict | None":
    """Domain-agnostic math soundness — flags a stated FALSE equality, arithmetic
    (e.g. '100000 / 5000 = 25 months') OR algebraic ('(x+1)**2 = x**2 + 1', when
    sympy is installed). Returns None when the answer states no checkable math
    (cheap no-op). ``math_sound`` subsumes ``arithmetic_sound`` and degrades to
    arithmetic-only when sympy is absent, so this never regresses without it.
    """
    from agent.verifiers import math_sound

    r = math_sound()(text, None, {})
    if not r["passed"]:
        return {"checks": [{"id": "math_sound", "passed": False, "reasons": r["reasons"]}],
                "violations": r["reasons"]}
    if (r.get("detail") or {}).get("checked", 0) > 0:
        return {"checks": [{"id": "math_sound", "passed": True, "reasons": []}], "violations": []}
    return None


def _detect_sector(question: "str | None") -> "str | None":
    if not question:
        return None
    try:
        from agent.sector_council import detect_council

        return detect_council(question)
    except Exception:  # noqa: BLE001 - sector detection is best-effort metadata
        return None


def check_response(
    text: str,
    *,
    mode: str,
    question: str | None = None,
    sources: list[str] | None = None,
    domain: str | None = None,
    strict_attribution: bool = True,
    legal_resolver=None,
    legal_judge=None,
    legal_strict: bool = True,
    route_claims: bool = False,
) -> dict:
    """Post-generation epistemic gate.

    Style warnings (discipline, 中文), attribution trap checks when a question is
    provided, plus a legal self-check (citation existence; holding faithfulness when
    a ``legal_judge`` is supplied) whenever the answer cites a legal authority.
    """
    lowered = text.lower()
    has_discipline = any(re.search(p, lowered, re.IGNORECASE) for p in DISCIPLINE_MARKERS)
    has_uncertainty = any(re.search(p, lowered, re.IGNORECASE) for p in UNCERTAINTY_MARKERS)
    has_zh = bool(re.search(r"[\u4e00-\u9fff]", text))

    warnings: list[str] = []
    violations: list[str] = []
    checks: list[dict] = []

    if mode in ("advisor", "repo") and not has_discipline:
        warnings.append("Missing explicit source-discipline framing")
    if not has_uncertainty and mode == "life":
        warnings.append("Life decisions should express uncertainty and human agency")
    if not has_zh:
        warnings.append("Missing 中文 summary section")

    resolved_domain = domain
    attribution_ok = True
    if question:
        resolved_domain = domain or infer_domain(question, sources)
        attribution_ok, checks = run_attribution_checks(text, question, domain=resolved_domain)
        for check in checks:
            if not check["passed"]:
                violations.extend(check["reasons"])

    legal = _legal_gate(text, resolver=legal_resolver, judge=legal_judge)
    if legal:
        checks.extend(legal["checks"])
        violations.extend(legal["violations"])

    numeric = _numeric_gate(text)
    if numeric:
        checks.extend(numeric["checks"])
        violations.extend(numeric["violations"])

    sector = _detect_sector(question)

    # Per-claim routing (opt-in): decompose the answer into atomic claims, classify
    # each, and run the matching verifier — so a claim type the fixed panel above
    # didn't target is still gated, and violations are attributed to the claim.
    routed = None
    if route_claims:
        try:
            from agent.claim_router import route_and_check

            routed = route_and_check(text, records=None, sources=sources, legal_resolver=legal_resolver)
            checks.extend({"name": "routed", **c} for c in routed.get("perClaim", []))
            violations.extend(routed.get("violations") or [])
        except Exception:
            routed = None

    passed = len(warnings) == 0
    if strict_attribution and checks and not attribution_ok:
        passed = False
    if legal_strict and legal and legal["violations"]:
        passed = False
    if numeric and numeric["violations"]:
        passed = False
    if routed and routed.get("violations"):
        passed = False

    return {
        "passed": passed,
        "warnings": warnings,
        "violations": violations,
        "checks": checks,
        "has_discipline": has_discipline,
        "has_zh": has_zh,
        "domain": resolved_domain,
        "sector": sector,
        "legal": legal,
        "numeric": numeric,
        "routed": routed,
    }