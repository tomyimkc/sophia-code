# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Atomic-claim decomposition + claim-type routing (FActScore / SAFE-style).

The fixed panel in :func:`agent.gate.check_response` runs every verifier over the
WHOLE answer. That gates a text if it contains *any* false arithmetic, *any*
forbidden attribution, etc. — but it cannot say *which* sentence failed, and it
cannot route a checkable predicate to the one verifier that can judge it.

This module decomposes an answer into atomic claims, classifies each claim by the
*kind* of checkable predicate it asserts, and runs only the MATCHING registered
verifier per claim. The result is per-claim attribution: the loop gates ANY
checkable predicate, not just whole-text scans, and reports exactly which claim
tripped which verifier.

Reuses the existing verifiers in :mod:`agent.verifiers` verbatim — it never
reimplements a check. ``'other'`` claims (no checkable predicate) pass: this is a
soundness gate, not a presence requirement. Pure stdlib, deterministic, offline.
"""

from __future__ import annotations

import re

from agent import verifiers as _v

# --------------------------------------------------------------------------- #
# Atomic-claim decomposition.
# --------------------------------------------------------------------------- #

# Abbreviations whose trailing period must not be treated as a sentence boundary
# (would shatter them into fragments below the verifiers' own min-length guards).
_NO_SPLIT_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "etc", "e.g", "i.e",
}

# Light clause split for compound sentences: coordinating connectors that join two
# independent assertions ("Plato wrote the Republic and 2 + 2 = 5"). Kept narrow
# (";", " and ", " but ", " however ", em/en dashes) so an appositive comma is NOT
# treated as a clause boundary — that would break author->title patterns the
# provenance verifier relies on.
_CLAUSE_SPLIT = re.compile(
    # Single \s on each side (not \s+) keeps the match linear — no nested/adjacent
    # quantifiers — so it cannot exhibit polynomial backtracking on adversarial input.
    r"[;—–]|\s\b(?:and|but|however|yet)\b\s"
)


def split_claims(text: str) -> list[str]:
    """Split an answer into atomic claim strings.

    Sentence split (terminal punctuation / newlines), then a light clause split on
    coordinating connectors — BUT only for sentences that are NOT authorship/legal
    assertions. Authorship and legal sentences are kept whole: clause-splitting on
    " and " would shatter multi-word titles ("Beyond Good and Evil" -> "Beyond
    Good") and sever a corrective carve-out ("it is a myth, and X wrote Y") from its
    assertion — both produce wrong verdicts. The provenance/legal verifiers do their
    own sentence-internal clause handling, so they need the full sentence. Clause
    splitting is reserved for arithmetic-style independent assertions. Whitespace-
    normalized; empty fragments dropped. Stdlib only, deterministic.
    """
    claims: list[str] = []
    for sentence in _split_sentences(text or ""):
        sentence = re.sub(r"\s+", " ", sentence).strip()
        if not sentence:
            continue
        # Keep authorship/legal sentences whole (carve-outs + multi-word titles).
        if _AUTHORSHIP_RE.search(sentence) or _has_legal(sentence):
            claims.append(sentence.strip(" \t\r\n,.!?。！？"))
            continue
        for clause in _CLAUSE_SPLIT.split(sentence):
            clause = re.sub(r"\s+", " ", clause).strip(" \t\r\n,.!?。！？")
            if clause:
                claims.append(clause)
    return claims


def _split_sentences(text: str) -> list[str]:
    """Split sentences while preserving initials and common abbreviations."""
    out: list[str] = []
    start = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\n":
            if text[start:i].strip():
                out.append(text[start:i])
            while i + 1 < len(text) and text[i + 1] == "\n":
                i += 1
            start = i + 1
        elif ch in ".!?。！？":
            if ch == "." and _protected_period(text, i):
                i += 1
                continue
            j = i + 1
            if j >= len(text) or text[j].isspace():
                out.append(text[start:j])
                while j < len(text) and text[j].isspace() and text[j] != "\n":
                    j += 1
                start = j
                i = j - 1
        i += 1
    if text[start:].strip():
        out.append(text[start:])
    return out


def _protected_period(text: str, idx: int) -> bool:
    prefix = text[:idx].rstrip()
    token = re.split(r"\s+", prefix)[-1].strip("([{'\"") if prefix else ""
    low = token.lower()
    if len(token) == 1 and token.isalpha() and token.isupper():
        return True
    return low in _NO_SPLIT_ABBREVIATIONS


# --------------------------------------------------------------------------- #
# Claim-type classification.
# --------------------------------------------------------------------------- #

# Arithmetic: a binary equality "a OP b = c". Reuse the verifier's own pattern so
# classification and checking agree on what counts as arithmetic.
_ARITH_RE = _v._ARITH

# Authorship: an assertion of who produced a work.
_AUTHORSHIP_RE = re.compile(
    r"\b(?:wrote|writes?|writing|written|authored?|author of|penned|composed|attribut\w*|credited with)",
    re.IGNORECASE,
)

# Legal: a neutral citation / ordinance ref, a "X v. Y" case style, or a holding
# verb. We borrow the legal extractor for the citation half and add the prose cues.
# The holding cues are case-insensitive; the "X v. Y" case style stays
# case-sensitive (it relies on capitalized party names).
_LEGAL_HOLDING_RE = re.compile(r"\b(?:the court (?:held|found|ruled)|it was held)\b", re.IGNORECASE)
_LEGAL_CASE_RE = re.compile(r"[A-Z][a-z]+ v\.? [A-Z]")

# Citation: a bracketed source marker ([1] / [local 1] / [web 1] / [source 1]) or
# the literal word "source".
_CITATION_RE = re.compile(r"\[(?:local|web|source)?\s*\d+\]|\bsource\b", re.IGNORECASE)

# Code: an EXPLICITLY python-fenced block only. A bare ``` fence matches Markdown /
# other-language code (JS would then fail a Python compile -> spurious violation),
# and bare def/class/import lines match prose ("import the dataset..."), so we
# require the language tag. Code is multi-line -> checked on the WHOLE text in
# route_and_check (the per-claim sentence split would shatter a block).
_CODE_RE = re.compile(r"```(?:python|py)\s*\n", re.IGNORECASE)

# Topology: a PROPOSED belief-graph edit (add/remove an edge or node, rewire, merge
# nodes, doNotMergeWith). Deliberately narrow — graph-mutation phrasing only — so it
# cannot steal an authorship/legal/citation/arithmetic claim; classify_claim checks
# those FIRST and topology LAST (just before 'other'). Precision over recall.
_TOPOLOGY_RE = re.compile(
    r"\b(?:add edge|remove edge|add node|remove node|rewire(?: graph)?|merge nodes|"
    r"topology change|graph topology|belief[- ]graph edit)\b|doNotMergeWith",
    re.IGNORECASE,
)


def _has_legal(claim: str) -> bool:
    if _LEGAL_HOLDING_RE.search(claim) or _LEGAL_CASE_RE.search(claim):
        return True
    try:
        from agent.legal_citations import extract_citations

        return bool(extract_citations(claim))
    except Exception:  # noqa: BLE001 - legal extraction is best-effort for routing
        return False


def classify_claim(claim: str) -> str:
    """Return the claim's checkable type.

    One of ``'authorship'``, ``'citation'``, ``'arithmetic'``, ``'legal'``,
    ``'topology'``, or ``'other'`` (no machine-checkable predicate). Heuristic,
    keyword/regex based.

    Ordering matters: arithmetic is the most syntactically specific, then the legal
    cues (a citation/holding), then authorship, then a bare source marker, then a
    proposed belief-graph edit (topology). Topology is checked LAST, just before
    ``'other'``, so its graph-mutation cues never steal a claim an earlier category
    already owns. A claim that matches nothing is ``'other'`` and will pass routing
    (not checkable here).
    """
    if _ARITH_RE.search(claim):
        return "arithmetic"
    if _has_legal(claim):
        return "legal"
    if _AUTHORSHIP_RE.search(claim):
        return "authorship"
    if _CITATION_RE.search(claim):
        return "citation"
    if _TOPOLOGY_RE.search(claim):
        return "topology"
    return "other"


# --------------------------------------------------------------------------- #
# Route + check.
# --------------------------------------------------------------------------- #


def route_and_check(text: str, *, records: "dict | None" = None,
                    sources: "list[str] | None" = None,
                    legal_resolver=None,
                    topology_context: "dict | None" = None) -> dict:
    """Split, classify, and run the MATCHING verifier per atomic claim.

    Routing (each runs the existing verifier from :mod:`agent.verifiers`):

    - ``arithmetic``  -> :func:`verifiers.arithmetic_sound`
    - ``authorship``  -> :func:`verifiers.provenance_faithful` (``records``)
    - ``legal``       -> :func:`verifiers.legal_citation_exists`
    - ``citation``    -> :func:`verifiers.citation_faithful` (``sources``) — skipped
      (claim passes) when no ``sources`` are supplied, since there is nothing to
      check faithfulness against.
    - ``topology``    -> :func:`agent.topology_gate.topology_verifier` — a proposed
      belief-graph edit, gated fail-closed. ``topology_context`` carries the change
      set (``{"topology_changes": [...], "graph": ..., "protected_domains": ...}``);
      with no context the verifier abstains (NOT a pass), so an unverifiable
      topology claim fails routing rather than slipping through.
    - ``other``       -> passes (no checkable predicate).

    Returns ``{passed, perClaim:[{claim,type,passed,reasons}], violations:[...]}``.
    ``passed`` is True iff every claim passed. ``violations`` aggregates each failed
    claim's reasons, prefixed with the claim type for attribution.
    """
    # Build verifiers once. arithmetic/provenance/legal are parameterless-ish and
    # cheap to construct; citation depends on sources and is built only if needed.
    arith = _v.arithmetic_sound()
    prov = _v.provenance_faithful(records)
    # Pass the operator's resolver so a real citation absent from the bundled static
    # register gets its second-chance lookup (mirrors agent.gate._legal_gate). Without
    # this the routed legal check is fail-closed and flags valid citations as forged.
    legal = _v.legal_citation_exists(resolver=legal_resolver)
    cite = _v.citation_faithful(sources) if sources else None
    # Temporal impossibility (author died before the work existed) — a corpus-free
    # check that catches misattributions outside any frozen record. Built lazily;
    # a no-op when the author/work aren't in the dated-facts table.
    try:
        from agent.temporal_verifier import temporal_consistent

        temporal = temporal_consistent()
    except Exception:  # pragma: no cover - never let the optional layer break routing
        temporal = None

    # Topology (proposed belief-graph edit) — a plain verifier (text, records,
    # context), imported lazily so the registry stays import-cheap and cycle-free.
    try:
        from agent.topology_gate import topology_verifier as topo
    except Exception:  # pragma: no cover - never let the optional layer break routing
        topo = None

    per_claim: list[dict] = []
    violations: list[str] = []

    for claim in split_claims(text):
        ctype = classify_claim(claim)
        if ctype == "arithmetic":
            result = arith(claim, None, {})
        elif ctype == "authorship":
            result = prov(claim, None, {})
            # also apply the corpus-free temporal-impossibility check
            if temporal is not None:
                tres = temporal(claim, None, {})
                if not tres["passed"]:
                    treasons = list(tres.get("reasons", []))
                    per_claim.append({"claim": claim, "type": "temporal", "passed": False, "reasons": treasons})
                    violations.extend(f"[temporal] {r}" for r in treasons)
        elif ctype == "legal":
            result = legal(claim, None, {})
        elif ctype == "citation":
            if cite is None:
                result = {"passed": True, "reasons": [], "detail": {"skipped": "no sources"}}
            else:
                result = cite(claim, None, {})
        elif ctype == "topology":
            if topo is None:
                result = {"passed": False, "reasons": ["topology verifier unavailable"], "detail": {}}
            else:
                result = topo(claim, records, topology_context or {})
        else:  # 'other' — not machine-checkable here
            result = {"passed": True, "reasons": [], "detail": {}}

        passed = bool(result["passed"])
        reasons = list(result.get("reasons", []))
        per_claim.append({"claim": claim, "type": ctype, "passed": passed, "reasons": reasons})
        if not passed:
            violations.extend(f"[{ctype}] {r}" for r in reasons)

        # Arithmetic is self-contained (a OP b = c), so also check it on a claim
        # whose PRIMARY type isn't arithmetic — e.g. an authorship sentence kept
        # whole that also bundles a false equality ("X wrote Y and 2 + 2 = 5").
        # No-op when the claim has no equality.
        if ctype != "arithmetic" and _ARITH_RE.search(claim):
            ares = arith(claim, None, {})
            if not ares["passed"]:
                areasons = list(ares.get("reasons", []))
                per_claim.append({"claim": claim, "type": "arithmetic", "passed": False, "reasons": areasons})
                violations.extend(f"[arithmetic] {r}" for r in areasons)

    # Code is multi-line — check the WHOLE text once (the per-claim sentence split
    # would shatter a code block). A fenced/bare Python block must at least be
    # syntactically valid (the cheap, safe self-check; full test-execution against a
    # hidden test is the code-uplift benchmark's job, not the free-text gate).
    if _CODE_RE.search(text or ""):
        # Only the EXPLICITLY python-tagged blocks (not a language-agnostic extract),
        # so a JS/other block elsewhere in the answer can't be compiled as Python.
        py_blocks = re.findall(r"```(?:python|py)[ \t]*\n(.*?)```", text or "", re.DOTALL | re.IGNORECASE)
        code = "\n\n".join(b.rstrip() for b in py_blocks)
        if code.strip():
            try:
                compile(code, "<answer>", "exec")
                per_claim.append({"claim": "<code block>", "type": "code", "passed": True, "reasons": []})
            except SyntaxError as exc:
                per_claim.append({"claim": "<code block>", "type": "code", "passed": False,
                                  "reasons": [f"python syntax error: {exc}"]})
                violations.append(f"[code] python syntax error: {exc}")

    return {
        "passed": not violations,
        "perClaim": per_claim,
        "violations": violations,
    }
