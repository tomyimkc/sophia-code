#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""GAIA official scorer, vendored verbatim + per-level harness diagnostic.

The scoring logic is the GAIA leaderboard's OFFICIAL ``question_scorer``
(Apache-2.0, https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/scorer.py),
reproduced here verbatim so local scores are identical to the leaderboard's
quasi-exact-match rule. We do NOT modify the comparison logic — only wrap it with
a per-level aggregate that serves as the harness-weakness diagnostic.

Why per-level: GAIA's levels (1 = ≤5 steps/≤1 tool; 2 = 5-10 steps + tool
chaining; 3 = long-horizon autonomy) form a GRADIENT that isolates where the
harness breaks. A model strong at L1 but collapsing at L2 points at multi-step
coherence, not knowledge — actionable harness work. This is the diagnostic signal
a flat pass@1 cannot give.

candidateOnly: true · canClaimAGI: false — scoring tooling only. GAIA questions
are PUBLIC (gated behind HF terms) and must NEVER enter training corpora; the
official contamination warning is honored by never persisting questions/answers
into a committable artifact.
"""
from __future__ import annotations

import re
import string
from typing import Any

# --------------------------------------------------------------------------- #
# Official scorer — vendored VERBATIM from the GAIA leaderboard (Apache-2.0).
# Do not "improve" this: any deviation makes local scores non-comparable to the
# leaderboard. The docstrings below are the original author comments.
# --------------------------------------------------------------------------- #
def normalize_number_str(number_str: str) -> float:
    for char in ["$", "%", ","]:
        number_str = number_str.replace(char, "")
    try:
        return float(number_str)
    except ValueError:
        return float("inf")


def split_string(s, char_list=[",", ";"]):
    pattern = f"[{''.join(char_list)}]"
    return re.split(pattern, s)


def question_scorer(model_answer: str, ground_truth: str) -> bool:
    """Official GAIA quasi-exact-match scorer. Returns True iff the (normalized)
    model answer equals the (normalized) ground truth. The branch is chosen by
    the GROUND TRUTH's type (number / list / string), not the prediction."""
    def is_float(element: Any) -> bool:
        try:
            float(element)
            return True
        except ValueError:
            return False

    if model_answer is None:
        model_answer = "None"
    # NUMBER: ground truth parses as float → numeric compare
    if is_float(ground_truth):
        return normalize_number_str(model_answer) == float(ground_truth)
    # LIST: gt contains , or ; → split both, lengths must match, compare each elem
    elif any(c in ground_truth for c in [",", ";"]):
        gt_elems = split_string(ground_truth)
        ma_elems = split_string(model_answer)
        if len(gt_elems) != len(ma_elems):
            return False
        for ma_elem, gt_elem in zip(ma_elems, gt_elems):
            if is_float(gt_elem):
                if normalize_number_str(ma_elem) != float(gt_elem):
                    return False
            else:
                if normalize_str(ma_elem, remove_punct=False) != normalize_str(gt_elem, remove_punct=False):
                    return False
        return True
    # STRING: normalize both (lowercase, strip ALL whitespace, remove punctuation)
    else:
        return normalize_str(model_answer) == normalize_str(ground_truth)


def normalize_str(input_str, remove_punct=True) -> str:
    no_spaces = re.sub(r"\s", "", input_str)           # remove ALL whitespace
    if remove_punct:
        translator = str.maketrans("", "", string.punctuation)
        return no_spaces.lower().translate(translator)  # lowercase + strip punctuation
    return no_spaces.lower()


# --------------------------------------------------------------------------- #
# Per-level aggregate (the harness diagnostic) — ours, not the official scorer
# --------------------------------------------------------------------------- #
def score_answer(model_answer: str | None, ground_truth: str) -> bool:
    """Thin wrapper so callers don't import the vendored name directly."""
    return bool(question_scorer(model_answer, ground_truth))


def diagnose_by_level(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate per-question results into a per-level diagnostic.

    ``rows`` is a list of ``{level, passed, task_id}`` (one per GAIA question).
    Returns ``{levels: {1: {n, passed, rate}, ...}, overall: {...}, diagnosis}``
    where ``diagnosis`` names the harness-weakness gradient from the per-level
    rate pattern — the actionable signal a flat pass@1 hides.

    The diagnosis is harness-shaped: a collapse from L1→L2 or L2→L3 points at a
    loop subsystem (multi-step coherence, tool chaining, long-horizon autonomy),
    NOT model IQ. ``candidateOnly``: advisory, not a capability claim.
    """
    levels: dict[int, dict[str, int]] = {}
    total_n = 0
    total_pass = 0
    for r in rows:
        lvl = int(r.get("level", 0) or 0)
        passed = bool(r.get("passed"))
        d = levels.setdefault(lvl, {"n": 0, "passed": 0})
        d["n"] += 1
        if passed:
            d["passed"] += 1
        total_n += 1
        total_pass += 1 if passed else 0

    out_levels: dict[str, dict[str, Any]] = {}
    rates: dict[int, float] = {}
    for lvl in sorted(levels):
        d = levels[lvl]
        rate = d["passed"] / d["n"] if d["n"] else 0.0
        rates[lvl] = rate
        out_levels[str(lvl)] = {"n": d["n"], "passed": d["passed"], "rate": rate}

    overall_rate = total_pass / total_n if total_n else 0.0
    return {
        "levels": out_levels,
        "overall": {"n": total_n, "passed": total_pass, "rate": overall_rate},
        "diagnosis": _interpret_level_gradient(rates, out_levels),
    }


_LEVEL_NAMES = {
    1: "single-step / ≤1 tool (sanity)",
    2: "multi-step tool chaining (5-10 steps)",
    3: "long-horizon autonomy (arbitrary steps)",
}


def _interpret_level_gradient(rates: dict[int, float], out_levels: dict) -> list[str]:
    """Turn the per-level rate pattern into named, fixable harness gaps.

    Conservative — only flags when the rate DROPS materially between adjacent
    levels (a real coherence collapse), not small noise. Each finding names the
    harness subsystem + a concrete next action. candidateOnly advisory.
    """
    findings: list[str] = []
    if not rates:
        return findings
    DROP = 0.20  # a >20pp drop between adjacent levels is a flagged gradient

    def _fmt(lvl: int) -> str:
        return f"L{lvl} ({_LEVEL_NAMES.get(lvl, '?')}): {int(rates[lvl]*100)}% (n={out_levels[str(lvl)]['n']})"

    for lo, hi in [(1, 2), (2, 3)]:
        if lo in rates and hi in rates:
            drop = rates[lo] - rates[hi]
            if drop >= DROP:
                if lo == 1:
                    findings.append(
                        f"Coherence collapse L1→L2: {_fmt(1)} → {_fmt(2)} (−{int(drop*100)}pp). "
                        "Points at MULTI-STEP / tool-chaining weakness — the harness loses "
                        "the thread across 5-10 steps. Audit auto_compact, the narration "
                        "nudge, and whether tool results are re-fed verbatim into the transcript."
                    )
                else:
                    findings.append(
                        f"Coherence collapse L2→L3: {_fmt(2)} → {_fmt(3)} (−{int(drop*100)}pp). "
                        "Points at LONG-HORIZON autonomy weakness — the harness can chain a "
                        "few steps but degrades on arbitrary-length sequences. Audit the step "
                        "ceiling, the conclusion pass, and budget scaling."
                    )
    if not findings:
        # still surface the per-level breakdown as an informational line
        findings.append("No material per-level collapse (≥20pp). Per-level: " +
                        " · ".join(_fmt(l) for l in sorted(rates)) +
                        ". (This is a harness-health read, not a capability claim.)")
    return findings
