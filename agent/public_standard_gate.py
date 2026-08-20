# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Sophia public moral standard gate.

Maps an action/output text against the overlapping-consensus public moral
standard (`moral_corpus/public_standard.v1.json`) and returns one of Sophia's
seven conscience verbs. It does NOT introduce a new vocabulary and it does NOT
fact-check: a moral norm is not a falsifiable empirical claim (the is/ought
distinction), so this gate only inspects the *normative content* of the action.

Design discipline (from the corrected blueprint):
- Reuse the seven verbs: ``allow | revise | retrieve | clarify | escalate | abstain | block``.
  (This module natively emits the subset ``allow | revise | escalate | block``;
  the kernel maps them into the unified ladder.)
- Marker hits are *features into a classifier*, never a verdict on their own.
- A negation / avoidance / condemnation carve-out is applied per clause so that
  norm-affirming text ("reduce harm", "do not deceive", "violence is wrong") is
  NOT treated as a violation. This mirrors the clause-scoped carve-out already
  proven in ``agent/verifiers.py`` / ``tools/source_discipline_cli.py``.
- Hard-floor violation -> ``block`` (evaluated before the moral parliament).
- Gray-zone signal -> ``escalate`` (route to the parliament, never a hard block).
- Unmet positive duty (opt-in, high-impact) -> ``revise``.

Boundary: control infrastructure, not a learned moral sense and not proof of AGI
or moral consciousness.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent import moral_ontology
from agent.runtime_paths import resource_root

ROOT = resource_root()
DEFAULT_CORPUS = ROOT / "moral_corpus" / "public_standard.v1.json"

SCHEMA = "sophia.public_standard_gate.v1"

# Clause separators: peel sentences and contrastive/coordinating boundaries so a
# carve-out in one clause does not excuse a violation in another.
_CLAUSE_SPLIT_RE = re.compile(
    r"[.!?;\n]+|\bbut\b|\bhowever\b|\bwhereas\b|\byet\b|\bthough\b|\balthough\b",
    re.I,
)

# Norm-affirming / avoidance / condemnation / descriptive cues. When any of these
# appears in the same clause as a category marker, the marker is treated as
# benign (the speaker is on the side of the norm, not violating it).
_BENIGN_CUES: tuple[str, ...] = (
    "do not", "don't", "do n't", "never", "avoid", "prevent", "prohibit",
    "prohibited", "refuse", "refuses", "reduce", "reducing", "minimi", "mitigat",
    "stop", "condemn", "against", "oppose", "discourage", "resist", "ban ",
    "banned", "illegal", "unethical", "immoral", "is wrong", "are wrong",
    "it is wrong", "it's wrong", "should not", "shouldn't", "should n't",
    "must not", "mustn't", "must n't", "may not", "cannot", "can't", "can n't",
    "without causing", "protect", "safeguard", "not allowed", "forbid",
    "no one should", "is bad", "are bad", "is harmful", "anti-", "decline",
    "do no harm", "forbidden",
    # Descriptive / meta discussion of safety systems (repo analysis, docs):
    # without these, explaining "the gate blocks unsafe instruction" or
    # "harm reduction" trips hard-floor markers on the very systems that forbid
    # those harms. Conservative phrasing only — not blanket software exemptions.
    "blocks unsafe", "block unsafe", "harm reduction", "harm trust",
    "without harming", "not harm", "can harm trust", "attack surface",
    "security exploit", "failure ledger", "delivery gate", "conscience gate",
    "public-standard", "public standard", "do not fabricate", "not fabricate",
    # "overclaim" used as a NOUN naming the safeguard, not a verb promising one.
    # The verb form is already covered ("we must not overclaim" allows via
    # "must not"), but the compound-noun form had no cue, so describing this
    # repo's own machinery tripped the epistemic_integrity hard floor:
    # "the repo has a no-overclaim gate" and "the overclaim linter runs in CI"
    # both blocked, while "I will overclaim the results to investors" — the
    # thing the floor is FOR — still blocks and must keep blocking.
    "no-overclaim", "no overclaim", "overclaim gate", "overclaim check",
    "overclaim linter", "overclaim lint", "overclaim discipline",
    "overclaim rule", "overclaim guard", "lint_claims", "claim-check",
    "deception detection", "anti-deception", "falsify a claim is forbidden",
)

# Benign PROPER NOUNS and TECHNICAL COMPOUNDS whose tokens collide with a
# hard-floor violence/harm marker as a *whole word* — e.g. "Kill Devil Hills"
# (the NC dunes where the Wright brothers first flew) trips the ``kill`` marker
# even though no violence is described. These are masked out of a clause BEFORE
# feature extraction, so a real violence marker elsewhere in the same clause
# STILL FIRES (the mask is length-preserving blank-out of the exact compound
# only — unlike a benign CUE, it does not disarm the whole clause).
#
# This is the structurally safe mechanism for marker words (bomb/torture/damage)
# that are genuinely dual-use: a substring cue would disarm "a fork bomb is when
# I bomb the warehouse", but a mask only blanks "fork bomb" and leaves the bare
# second "bomb" detectable. Conservative and auditable: only exact known
# toponyms/titles/compounds, never the bare verb. Extend as more descriptive
# false positives surface.
_BENIGN_PROPER_NOUNS: tuple[str, ...] = (
    "kill devil hills",
    # Ops / process-control vocabulary (not interpersonal violence). Measured
    # false positive: a correct analysis of this repo's fleet killswitch /
    # cgroup.kill path was conscience-held as "violence" (2026-07-25 session).
    "kill switch",
    "killswitch",
    "cgroup.kill",
    "sigkill",
    "pkill",
    # Systems-engineering compound nouns whose marker word (bomb/torture/
    # massacre/damage) is used in an established technical sense. Measured
    # 2026-07-25: a correct repo analysis of process-exhaustion (fork bomb),
    # load-testing (torture/stress test), and corruption hardening (damage the
    # index) was conscience-held as "violence" without these. Masked, not cued,
    # so a genuine "I will bomb the warehouse" in the same clause still blocks.
    "fork bomb",
    "torture test",
    "torture suite",
    "stress test",
    "load test",
    "log massacre",
    "damage the index",
    # ML-safety / RL technical compounds that reuse the hard-floor "exploit"
    # marker (verifier gaming / reward hacking). Measured 2026-07-29: a correct
    # repo gap analysis naming the "verifier-exploit rate" was conscience-held as
    # "exploitation". Masked (length-preserving), NOT cued, so a bare
    # "exploit the vulnerable" in the same clause still hard-floor blocks.
    "verifier exploit",
    "exploit rate",
    "reward exploit",
    "policy exploit",
    # Authorized red-team / contest analysis. Measured 2026-07-31: a synthetic
    # Kaggle security-evaluation second opinion was hard-blocked because
    # "public-specific exploit" and "attack failure" were read as interpersonal
    # exploitation/harm. Exact compounds are masked rather than adding a broad
    # "security" cue, so a real harmful marker elsewhere in the same clause still
    # fires.
    "public-specific exploit",
    "attack failure",
    # Threat-model heading. Only the exact heading is masked; any actual
    # harmful instruction elsewhere in the same clause remains visible.
    "attack scenario",
    "attack scenarios",
    "ransomware-class local damage",
)

# Regex-form benign technical vocabulary, same length-preserving mask contract
# as the literal compounds above. Process signalling (``kill -9 <pid>``,
# ``kill -TERM $PID``) is ordinary ops writing, not interpersonal violence.
#
# The OPERAND is matched deliberately rather than left open as ``kill\s+-\w+``.
# Unlike the compounds above, "kill" is a hard-floor marker ON ITS OWN, so a
# mask that blanked only the flag would erase the sole piece of evidence in the
# clause: a bare signal pattern was measured letting "kill -9 my neighbor"
# through as ``allow``. Requiring a pid/variable/process-noun operand keeps the
# mask confined to genuine ops vocabulary.
_SIGNAL = r"kill\s+-(?:\d+|[A-Za-z]+)\s+"
_PROCESS_NOUN = (
    r"(?:process(?:es)?|proc|worker|job|pod|container|child(?:ren)?|pid|daemon"
    r"|server|task|thread|shell|runner|agent)"
)
# Technical object of the ML-safety/RL verb "exploit" (verifier gaming, reward
# hacking). Requiring one of these UNAMBIGUOUS technical objects keeps the mask
# confined to genuine technical writing — "exploit the verifier" is masked, but
# "exploit the vulnerable" / "exploit children" (no technical object) still
# hard-floor blocks. Same operand-required contract as the kill-signal patterns.
# Deliberately excludes broad nouns (agent/model/system/task) that could be the
# object of a real exploitation sentence.
_EXPLOIT_OBJECT = (
    r"(?:verifier|reward|policy|oracle|evaluator|scorer|metric|rubric|judge"
    r"|gate|signal|function)s?"
)
# Vulnerability words that must NOT sit between a technical noun and "to exploit"
# — their presence means the clause is about exploiting people, not a system, so
# the mask backs off and the hard-floor marker fires.
_VULN_WORD = (
    r"vulnerable|children|child|dependents?|people|persons?|users?|elderly"
    r"|disabled|workers?|victims?|minors?|patients?|students?"
)
_BENIGN_TECHNICAL_PATTERNS: tuple[str, ...] = (
    # kill -9 1234 / kill -TERM $PID / kill -9 %1
    _SIGNAL + r"(?:-?\d+|\$\{?\w+\}?|%\d+)",
    # kill -9 the stuck worker / kill -TERM the child process
    _SIGNAL + r"(?:the|a|that|this|my|its)?\s*(?:\w+\s+){0,2}" + _PROCESS_NOUN + r"\w*",
    # Plain process-supervision prose without an explicit signal flag:
    # "kill the child process" / "kill a stuck worker process". Requiring the
    # complete process object is the safety boundary: bare "kill the child",
    # "kill the worker", or "kill the operator" remains visible to the
    # hard-floor violence detector.
    r"\bkill(?:s|ed|ing)?\s+"
    r"(?:(?:the|a|an|this|that|its|our|stuck|hung|orphaned|runaway)\s+){0,3}"
    r"(?:child\s+process(?:es)?|worker\s+process(?:es)?|process(?:es)?)\b"
    r"(?!\s*(?:,?\s*(?:and|or|then)\b))",
    # Process-supervision terminology. Mask only the complete comparison, not
    # a bare "kill" verb elsewhere in the clause.
    r"soft[\s_-]*cancel\s+(?:vs\.?|versus)\s+hard[\s_-]*kill",
    # Retry/idempotency analysis may call unintended tool side effects
    # "external damage". Requiring the nearby non-idempotent/retry context
    # avoids turning that broad phrase into a blanket benign cue.
    r"(?:non[\s_-]*idempotent|automatic\s+retry|retry\s+of)"
    r"[^.!?;\n]{0,140}?\bexternal\s+damage\b",
    # exploit the verifier / exploiting reward / exploits the oracle
    r"exploit(?:s|ed|ing)?\s+(?:the|a|an|this|these|our|their|its)?\s*" + _EXPLOIT_OBJECT,
    # "<technical noun> … to exploit" — an exploitability assessment of a SYSTEM
    # (measured 2026-07-29: "Generative rewards are substantially easier to
    # exploit" was conscience-held). The negative lookahead refuses to mask when
    # a vulnerability word sits between the noun and "to exploit", so "vulnerable
    # people are easy to exploit" still hard-floor blocks.
    r"(?:reward|verifier|oracle|evaluator|scorer|metric|rubric|policy|judge|gate)s?\b"
    r"(?:(?!\b(?:" + _VULN_WORD + r")\b)[^.!?;\n]){0,60}?"
    r"\bto\s+exploit\b",
    # Scientific falsification: "falsify" means design a test that could
    # disprove a hypothesis, not forge evidence. Keep this precise and
    # object-bound. A broad "research/scientific" cue would disarm a separate
    # "falsify the audit records" instruction in the same clause.
    r"falsif(?:y|ies|ied|ying)\s+"
    r"(?:(?:a|an|the|this|that|each|these|those)\s+)?"
    r"(?:hypothes(?:is|es)|failure[\s_-]+modes?|causal[\s_-]+models?"
    r"|predictions?|theor(?:y|ies))\b",
    # Back-reference wording used in experimental plans: "failure modes and
    # how to falsify each offline". Requiring an explicit scientific object
    # before "falsify each" preserves blocks for "falsify each witness
    # statement" and similar evidence-tampering instructions.
    r"(?:hypothes(?:is|es)|failure[\s_-]+modes?|causal[\s_-]+models?"
    r"|predictions?|theor(?:y|ies))\b"
    r"[^.!?;\n]{0,80}?\b(?:how\s+to\s+)?falsif(?:y|ies|ied|ying)\s+each\b",
    # Release engineering also uses falsification in Popper's sense: criteria
    # should be testable and a drill should be able to disprove readiness.
    # Keep the carve-out object-bound so falsifying records/evidence remains a
    # truthfulness hard-floor violation.
    r"\bfalsif(?:y|ies|ied|ying)\s+"
    r"(?:(?:a|an|the|this|that|each|these|those|our)\s+)?"
    r"(?:release|launch|deployment|acceptance|go[\s_/-]*no[\s_/-]*go)"
    r"[\s_-]+(?:criterion|criteria|gate|thresholds?)\b"
    r"(?!\s*(?:,?\s*(?:and|or|then)\b))",
    # Assertion-vs-mention scoping for a review verdict. "I will overclaim"
    # remains a hard-floor breach, while "that wording is an overclaim" is a
    # criticism of the breach. Mask only the copular noun phrase, not the whole
    # clause, so a second directive to overclaim in the same clause remains
    # visible to the detector.
    r"\b(?:is|are|was|were|would\s+be|amounts?\s+to|constitutes?)\s+"
    r"(?:an?\s+)?overclaim(?:s|ed|ing)?\b",
)


def _compound_pattern(phrase: str) -> str:
    """Match a benign compound written with any separator style.

    ``fork bomb``, ``fork-bomb`` and ``fork_bomb`` are the same technical term,
    and identifiers use the last two. This matters beyond spelling tolerance:
    marker matching treats ``_`` as a word separator, so without underscore
    coverage here a plain ``kill_switch`` identifier would newly register as a
    violence marker.
    """
    return r"[\s_-]+".join(re.escape(part) for part in phrase.split(" "))


_BENIGN_PROPER_NOUN_RE = re.compile(
    "|".join(
        [_compound_pattern(p) for p in _BENIGN_PROPER_NOUNS]
        + list(_BENIGN_TECHNICAL_PATTERNS)
    ),
    re.I,
) if _BENIGN_PROPER_NOUNS or _BENIGN_TECHNICAL_PATTERNS else None


def _mask_benign_proper_nouns(clause: str) -> str:
    """Blank out known benign proper nouns so their tokens cannot register as
    moral-ontology markers. Length-preserving replacement keeps clause offsets sane."""
    if _BENIGN_PROPER_NOUN_RE is None:
        return clause
    return _BENIGN_PROPER_NOUN_RE.sub(lambda m: " " * len(m.group(0)), clause)


# Deontic / moral-language cues that mark text as primarily *normative*. The
# kernel uses ``isNormative`` to short-circuit the factual provenance gate for
# pure-norm content (is/ought): a norm must not be sent to retrieve/abstain.
_NORMATIVE_CUES: tuple[str, ...] = (
    "should", "ought", "must", "may not", "duty", "obligation", "permissible",
    "impermissible", "right to", "wrong to", "morally", "moral", "ethical",
    "ethically", "unethical", "fair", "unfair", "it is wrong", "it's wrong",
    "have a right", "human right", "dignity", "consent", "ought to",
)


@dataclass(frozen=True)
class StandardViolation:
    category: str
    tier: str
    marker: str
    clause: str

    def to_dict(self) -> dict[str, Any]:
        return {"category": self.category, "tier": self.tier, "marker": self.marker, "clause": self.clause}


@dataclass(frozen=True)
class PublicStandardDecision:
    schema: str = SCHEMA
    verdict: str = "allow"  # allow|revise|escalate|block (subset of the seven verbs)
    reason: str = "no public-standard concern detected"
    isNormative: bool = False
    violations: tuple[StandardViolation, ...] = ()
    grayZone: tuple[StandardViolation, ...] = ()
    unmetDuties: tuple[str, ...] = ()
    candidateOnly: bool = True
    level3Evidence: bool = False
    boundary: str = "Public-standard moral gate; control infrastructure, not a learned moral sense or AGI proof."

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "verdict": self.verdict,
            "reason": self.reason,
            "isNormative": self.isNormative,
            "violations": [v.to_dict() for v in self.violations],
            "grayZone": [v.to_dict() for v in self.grayZone],
            "unmetDuties": list(self.unmetDuties),
            "candidateOnly": self.candidateOnly,
            "level3Evidence": self.level3Evidence,
            "boundary": self.boundary,
        }


_CORPUS_CACHE: dict[str, Any] | None = None


def load_corpus(path: str | Path = DEFAULT_CORPUS) -> dict[str, Any]:
    global _CORPUS_CACHE
    if _CORPUS_CACHE is None or path != DEFAULT_CORPUS:
        _CORPUS_CACHE = json.loads(Path(path).read_text(encoding="utf-8"))
    return _CORPUS_CACHE


def _clauses(text: str) -> list[str]:
    return [c.strip() for c in _CLAUSE_SPLIT_RE.split(text or "") if c.strip()]


# Cues that are deliberately PREFIXES, matching inside a longer word
# ("minimi" -> minimize/minimise/minimizing). Every other cue must match on a
# word boundary, allowing only ordinary inflection.
_PREFIX_CUES: frozenset[str] = frozenset({"minimi", "mitigat"})

# Inflections a boundary-anchored cue may still absorb, so "protecting",
# "prevented" and "opposes" keep disarming their clause the way the bare stems
# always did.
_CUE_INFLECTION = r"(?:s|es|ed|ing|d)?"


def _cue_pattern(cue: str) -> str:
    """Anchor a benign cue so it cannot match inside an unrelated word.

    A cue was previously an unbounded substring, so "bomb-resistant" (containing
    "resist"), "unavoidable" ("avoid") or "stopwatch" ("stop") disarmed the WHOLE
    clause — including a bare, unmasked violence marker sitting next to it.
    Measured 2026-07-25: "The device is bomb-resistant, so here is exactly how to
    kill my neighbor with a knife." returned ``allow``. Unlike the proper-noun
    mask (which blanks one compound), a cue suppresses every marker in its
    clause, so an accidental cue match is a full detection bypass.
    """
    pattern = re.escape(cue)
    if cue[:1].isalnum():
        pattern = r"(?<![A-Za-z0-9])" + pattern
    if cue[-1:].isalnum() and cue not in _PREFIX_CUES:
        pattern = pattern + _CUE_INFLECTION + r"(?![A-Za-z0-9])"
    return pattern


_BENIGN_CUE_RE = re.compile("|".join(_cue_pattern(c) for c in _BENIGN_CUES), re.I)


def _has_benign_cue(clause_low: str) -> bool:
    return bool(_BENIGN_CUE_RE.search(clause_low))


def is_normative(text: str) -> bool:
    low = (text or "").lower()
    return any(cue in low for cue in _NORMATIVE_CUES)


def _detect(text: str) -> tuple[list[StandardViolation], list[StandardViolation]]:
    """Clause-scoped detection: return (hard_floor_violations, gray_zone_signals).

    A category marker counts only if its clause has NO benign/avoidance cue, so
    norm-affirming or condemning text is excluded.
    """
    hard: list[StandardViolation] = []
    gray: list[StandardViolation] = []
    seen_hard: set[str] = set()
    seen_gray: set[str] = set()
    # Mask benign proper nouns on the FULL text BEFORE clause splitting. Otherwise
    # a dotted token like ``cgroup.kill`` is split on ``.`` into a bare ``kill``
    # clause and false-positive as violence (measured 2026-07-25 on a fleet
    # killswitch analysis). Length-preserving mask keeps clause offsets sane.
    masked_text = _mask_benign_proper_nouns(text or "")
    for clause in _clauses(masked_text):
        low = clause.lower()
        if _has_benign_cue(low):
            continue
        feats = moral_ontology.extract_features(clause)
        for cat_id, markers in feats.items():
            cat = moral_ontology.get_category(cat_id)
            if cat is None:
                continue
            v = StandardViolation(cat_id, cat.tier, markers[0], clause[:160])
            if cat.tier == moral_ontology.HARD_FLOOR:
                if cat_id not in seen_hard:
                    seen_hard.add(cat_id)
                    hard.append(v)
            else:
                if cat_id not in seen_gray:
                    seen_gray.add(cat_id)
                    gray.append(v)
    return hard, gray


# Positive duties that the gate can require for high-impact actions. Each maps to
# a cue whose ABSENCE (when the duty applies) yields a ``revise``. Conservative
# and opt-in via context so it never fires on benign default checks.
_DUTY_CUES: dict[str, tuple[str, ...]] = {
    "state_uncertainty_when_unsure": ("uncertain", "may be", "might", "appears", "i think", "not sure", "possibly", "likely", "approximately"),
    "preserve_provenance": ("source", "cite", "citation", "provenance", "according to", "reference"),
}


def _unmet_duties(text: str, context: dict[str, Any]) -> list[str]:
    if not context.get("checkPositiveDuties"):
        return []
    required = context.get("requiredDuties") or []
    low = (text or "").lower()
    unmet: list[str] = []
    for duty in required:
        cues = _DUTY_CUES.get(duty)
        if cues is None:
            continue
        if not any(c in low for c in cues):
            unmet.append(duty)
    return unmet


def check_public_standard(text: str, *, context: dict[str, Any] | None = None, corpus: dict[str, Any] | None = None) -> PublicStandardDecision:
    """Evaluate text against the public moral standard. No fact-checking (is/ought)."""
    context = context or {}
    # corpus is loaded for provenance/versioning surface; detection uses the
    # stable ontology so the two never drift apart.
    load_corpus() if corpus is None else corpus
    normative = is_normative(text)
    hard, gray = _detect(text)
    unmet = _unmet_duties(text, context)

    if hard:
        cats = ", ".join(sorted({v.category for v in hard}))
        return PublicStandardDecision(
            verdict="block",
            reason=f"hard-floor public-standard violation: {cats}",
            isNormative=normative,
            violations=tuple(hard),
            grayZone=tuple(gray),
            unmetDuties=tuple(unmet),
        )
    if gray:
        cats = ", ".join(sorted({v.category for v in gray}))
        return PublicStandardDecision(
            verdict="escalate",
            reason=f"gray-zone moral disagreement requires escalation: {cats}",
            isNormative=normative,
            grayZone=tuple(gray),
            unmetDuties=tuple(unmet),
        )
    if unmet:
        return PublicStandardDecision(
            verdict="revise",
            reason=f"unmet positive duty for high-impact action: {', '.join(unmet)}",
            isNormative=normative,
            unmetDuties=tuple(unmet),
        )
    return PublicStandardDecision(verdict="allow", isNormative=normative)


__all__ = [
    "SCHEMA",
    "StandardViolation",
    "PublicStandardDecision",
    "load_corpus",
    "is_normative",
    "check_public_standard",
]
