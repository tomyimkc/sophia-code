#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Claims linter — fail the build if public copy makes a capability/safety overclaim.

The README and marketing must never exceed what the failure ledger supports. This
deterministic, offline linter scans public-facing prose for forbidden superlatives
and unqualified safety claims, plus contest-communication overclaims (a contest
win/rank/rubric-score is a contest outcome, never by itself an AGI/capability
finding — see ``CONTEST_FORBIDDEN``). A line may opt out by including the marker
``claim-ok`` (use sparingly, only when the surrounding text already qualifies it).

Run:  python tools/lint_claims.py
Exit: 0 = clean, 1 = violations found.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Files / globs whose prose is public-facing marketing or positioning.
SCAN: list[str] = [
    "README.md",
    "VISION.md",
    "CONTRIBUTING.md",
    "GOOD_FIRST_ISSUES.md",
    "SPONSORS.md",
    "agi-proof/README.md",
    "agi-proof/sophia-wisdom-4b-method-note.md",
    "agi-proof/research-note-source-discipline.md",
    "agi-proof/measurement-thesis.md",
    "docs/00-Index/Home.md",
    "docs/LEIDEN-ALIGNMENT.md",
]
SCAN_GLOBS: list[str] = [
    "docs/07-Growth/**/*.md",
    "docs/07-Growth/**/*.txt",
    "docs/research/contests/**/*.md",
    "agi-proof/contest-submissions/**/*.md",
    "paper/arc-paper-track/**/*.md",
]

# (regex, why) — capability/safety overclaims that the ledger does not support.
FORBIDDEN: list[tuple[str, str]] = [
    (r"\bsafe to ship\b", "implies a guarantee; the gate is a filter (23.6% residual)"),
    (r"\btrust in production without\b", "implies no oversight needed"),
    (r"\bwithout constant oversight\b", "implies autonomy the evidence does not support"),
    (r"\bmakes ai safe\b", "unqualified safety claim"),
    (r"\b(the\s+)?first\s+.{0,12}\bagi\b", "AGI primacy claim"),
    (r"\bproven agi\b|\bis agi\b", "AGI capability claim"),
    (r"\bbirth(ing)?\s+the\s+first\b", "AGI primacy / hype"),
    (r"\bthe only open project\b", "unfalsifiable superiority claim"),
    (r"\b100%\s+on\s+all\b", "first-party benchmark stated as universal result"),
    (r"\bworld'?s first\b", "primacy claim"),
    (r"\bbreakthrough\b", "hype term without a cited result"),
    (r"\bproves alignment\b", "unformalizable alignment overclaim"),
    (r"\bproves safe self-improvement\b", "unqualified safe-self-improvement claim"),
    (r"\bgödel machine\b|\bgodel machine\b", "misleading Gödel-machine framing"),
    (r"\bproves it is trustworthy\b", "unqualified trustworthiness proof claim"),
    # Leiden Declaration value 2 (attribution & responsibility): credit and responsibility
    # belong to humans; AI systems are tools, never authors of results.
    (r"\bauthored by (claude|gpt|copilot|glm|an? ai|the model|the llm)\b",
     "Leiden: results are authored by humans, not by an automated system"),
    (r"\bai[- ]authored\b", "Leiden: AI is a tool, not an author"),
    (r"\b(claude|gpt|the model|the llm)\s+(is|was)\s+(the\s+|an?\s+)?(author|inventor|discoverer)\b",
     "Leiden: credit for results belongs to humans, not automated systems"),
]

# Contest-communication overclaims (skill-lift / ARC-AGI-2 / ARC-AGI-3 / DataHub / GoAI /
# arc-paper-track and any future contest). A contest placement, rank, or rubric score is a
# contest outcome — never, by itself, an AGI or capability finding. Each entry is
# (regex, why, escape_regex_or_None): when an escape_regex is given, a line that matches the
# forbidden pattern is still allowed if it ALSO matches the escape (e.g. a dated leaderboard
# receipt) — this is in addition to, not instead of, the generic 'claim-ok' marker (checked
# once, up front, for every pattern including these).
CONTEST_FORBIDDEN: list[tuple[str, str, str | None]] = [
    (
        r"\b(we won|first place|won the)\b",
        "contest win/placement claim needs a dated leaderboard-receipt reference (or 'claim-ok')",
        r"\d{4}-\d{2}-\d{2}.{0,60}(?:leaderboard|receipt)|(?:leaderboard|receipt).{0,60}\d{4}-\d{2}-\d{2}",
    ),
    (
        r"\branked?\s*#\s*\d+\b|\brank(?:ed)?\s+\d+\b",
        "contest rank stated without the provisional/semi-private leaderboard caveat "
        "(e.g. ARC-AGI-2's public leaderboard is computed on ~50% of test data)",
        r"provisional|semi-private|not final|subject to change|~\s*50%|50%\s+of\s+(?:the\s+)?test",
    ),
    (
        r"\baccepted at\b",
        "venue-acceptance claim stated before a decision exists — needs a dated decision/"
        "notification reference",
        r"decision\b.{0,40}\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}.{0,40}decision\b|"
        r"camera-ready|notification (?:email|received)",
    ),
    (
        r"\b(?:rank|ranking|leaderboard (?:position|score|rank)|rubric score|contest score)\b"
        r"[^.\n]{0,80}\b(?:is (?:an? )?agi\b|proves (?:an? )?agi\b|counts as (?:an? )?agi\b|"
        r"demonstrates (?:an? )?agi\b|is (?:an? )?capability (?:finding|proof|result)\b)",
        "a contest rank/rubric score is a contest outcome, not an AGI/capability finding",
        None,
    ),
]

ALLOW_MARKER = "claim-ok"

# Adapter registry: a candidate PROMOTED past candidate_only must carry a passing measurement
# receipt (tools/claim_gate.py). This makes "no claim beyond what the instrument resolves"
# machine-enforced. candidate_only entries are exempt (they make no external claim).
REGISTRY = "training/adapters/registry.jsonl"


def _check_registry_receipts() -> list[str]:
    v: list[str] = []
    reg = ROOT / REGISTRY
    if not reg.exists():
        return v
    for ln in reg.read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            e = json.loads(ln)
        except Exception:
            continue
        promoted = e.get("validated_external") is True or e.get("canClaimAGI") is True \
            or e.get("candidate_only") is False
        generalizes = e.get("generalizes") is True
        if not (promoted or generalizes):
            continue  # candidate_only / no-generalization-claim -> no receipt required

        def _receipt_go(rcpt: str, kind: str) -> None:
            if not rcpt or not (ROOT / rcpt).exists():
                v.append(f"{REGISTRY}: {e.get('id')} requires a {kind} but has none "
                         f"(run tools/claim_gate.py and reference its GO receipt)")
                return
            try:
                r = json.loads((ROOT / rcpt).read_text(encoding="utf-8"))
            except Exception:
                v.append(f"{REGISTRY}: {e.get('id')} {kind} {rcpt} is unreadable")
                return
            if r.get("verdict") != "GO":
                v.append(f"{REGISTRY}: {e.get('id')} {kind} {rcpt} is {r.get('verdict')} "
                         f"(critical failures: {r.get('criticalFailures')}) — cannot back the claim")

        # A promotion past candidate_only needs a primary measurement receipt.
        if promoted:
            _receipt_go(e.get("measurement_receipt"), "measurement_receipt")
        # ANY 'generalizes' claim (habit, not memorized format) needs an EXTERNAL-VALIDITY
        # transfer receipt on novel entities — markers alone cannot establish generalization.
        if generalizes:
            _receipt_go(e.get("transfer_receipt"), "transfer_receipt (external-validity)")
    return v


def _check_recipe_receipt() -> list[str]:
    """A recipe-ranking artifact that names a 'best' recipe must be backed by a GO superiority
    receipt (tools/benchmark_recipes.py --emit-receipt) — principle #9: no 'recipe X wins' claim
    without a powered ranking + the simple baseline in the table."""
    v: list[str] = []
    wm = ROOT / "agi-proof" / "benchmark-results" / "wisdom-market"
    bench = wm / "recipe-benchmark.json"
    if not bench.exists():
        return v
    try:
        b = json.loads(bench.read_text(encoding="utf-8"))
    except Exception:
        return ["recipe-benchmark.json is unreadable"]
    if not b.get("best"):
        return v
    rcpt = wm / "recipe-benchmark.gate.json"
    if not rcpt.exists():
        return [f"recipe-benchmark.json names best='{b['best']}' but has no superiority receipt "
                f"(run tools/benchmark_recipes.py --emit-receipt)"]
    try:
        r = json.loads(rcpt.read_text(encoding="utf-8"))
        if r.get("verdict") != "GO":
            v.append(f"recipe-benchmark.gate.json is {r.get('verdict')} — ranking is not powered/"
                     f"baselined; cannot claim a 'best' recipe ({[c for c in r.get('checks',[]) if not c.get('ok')]})")
    except Exception:
        v.append("recipe-benchmark.gate.json is unreadable")
    return v


def _files() -> list[Path]:
    out: list[Path] = []
    for rel in SCAN:
        p = ROOT / rel
        if p.exists():
            out.append(p)
    for g in SCAN_GLOBS:
        # Skip vendored/virtualenv trees: contest packs may keep a local .venv for the
        # pinned sim, and its site-packages docs are third-party prose, not repo claims.
        out.extend(
            p for p in sorted(ROOT.glob(g))
            if not ({"venv", ".venv", "node_modules", "__pycache__", "site-packages"} & set(p.parts))
        )
    return out


_VALID_BET_STATUSES = {"scaffold", "wired", "measured", "retired"}


def _check_architecture_bets() -> list[str]:
    """Fail if the architecture-bets registry claims AGI or marks a bet ``wired``
    without naming a concrete ``live_caller``. A registry that says a module is on
    the live path must point at the caller that proves it. A missing/invalid registry
    is not an overclaim, so it is silently skipped (W0 owns its own existence test).

    Schema v2 additions: status must be a known value (scaffold/wired/measured/retired),
    and a bet marked ``retired`` must carry a non-empty ``retirement_criteria``. The
    latter is the guard against silent resurrection — a retired bet cannot flip back to
    scaffold/wired without clearing the criterion that documented its death.
    """
    registry = ROOT / "agi-proof" / "architecture-bets.json"
    if not registry.exists():
        return []
    try:
        data = json.loads(registry.read_text(encoding="utf-8"))
    except Exception as exc:  # malformed JSON is W0's test to catch, not an overclaim
        return [f"agi-proof/architecture-bets.json: unreadable ({exc})"]
    problems: list[str] = []
    if data.get("canClaimAGI") is not False:
        problems.append("agi-proof/architecture-bets.json: canClaimAGI must be false")
    for bet in data.get("bets", []):
        status = bet.get("status")
        if status not in _VALID_BET_STATUSES:
            problems.append(
                f"agi-proof/architecture-bets.json: bet '{bet.get('id')}' has unknown "
                f"status '{status}' (must be one of {sorted(_VALID_BET_STATUSES)})"
            )
        if status == "wired" and not bet.get("live_caller"):
            problems.append(
                f"agi-proof/architecture-bets.json: bet '{bet.get('id')}' is 'wired' "
                "but has no live_caller"
            )
        if status == "retired" and not (bet.get("retirement_criteria") or "").strip():
            problems.append(
                f"agi-proof/architecture-bets.json: bet '{bet.get('id')}' is 'retired' "
                "but has no retirement_criteria"
            )

    # Sibling long-context measurement-target registry (split out so the two
    # incompatible schemas can coexist; see docs/11-Platform/Architecture-Bets-Schema.md).
    # It must also never claim AGI. A missing/invalid file is not an overclaim.
    lc_registry = ROOT / "agi-proof" / "long-context-bets.json"
    if lc_registry.exists():
        try:
            lc_data = json.loads(lc_registry.read_text(encoding="utf-8"))
        except Exception as exc:
            problems.append(f"agi-proof/long-context-bets.json: unreadable ({exc})")
        else:
            if lc_data.get("canClaimAGI") is not False:
                problems.append("agi-proof/long-context-bets.json: canClaimAGI must be false")
    return problems


def _prose_violations_python(files: list[Path]) -> list[str]:
    """Reference oracle: the regex FORBIDDEN scan over public-facing prose."""
    violations: list[str] = []
    for path in files:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception:
            continue
        for i, line in enumerate(lines, 1):
            if ALLOW_MARKER in line:
                continue
            low = line.lower()
            for pat, why in FORBIDDEN:
                if re.search(pat, low):
                    rel = path.relative_to(ROOT)
                    violations.append(f"{rel}:{i}: «{line.strip()[:90]}» — {why}")
            for pat, why, escape in CONTEST_FORBIDDEN:
                if re.search(pat, low) and not (escape and re.search(escape, low)):
                    rel = path.relative_to(ROOT)
                    violations.append(f"{rel}:{i}: «{line.strip()[:90]}» — {why}")
    return violations


def _prose_violations_accel(files: list[Path]) -> list[str]:
    """Optional sophia-lex accelerator path; raises on any issue so the caller
    can fall back to the Python oracle. Reproduces the Python message format."""
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _lex_accel import overclaim_scan  # type: ignore

    cache: dict[str, list[str]] = {}

    def _line_text(rel: str, n: int) -> str:
        if rel not in cache:
            try:
                cache[rel] = (ROOT / rel).read_text(encoding="utf-8").splitlines()
            except Exception:
                cache[rel] = []
        lines = cache[rel]
        return lines[n - 1].strip()[:90] if 0 < n <= len(lines) else ""

    return [
        f"{rel}:{line_no}: «{_line_text(rel, line_no)}» — {why}"
        for rel, line_no, why in overclaim_scan(files)
    ]


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(
        description="Claims linter (no-overclaim gate).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--accel", action="store_true",
        help="use the sophia-lex Rust scanner for the prose scan if built (auto "
             "falls back to Python); registry/recipe/architecture checks always run in Python",
    )
    args = ap.parse_args()

    files = _files()
    violations: list[str] = []
    used_accel = False
    if args.accel:
        try:
            violations = _prose_violations_accel(files)
            used_accel = True
        except Exception as exc:  # any bridge error -> Python oracle
            print(f"(claims linter: accel unavailable, using Python oracle — {exc})")
    if not used_accel:
        violations = _prose_violations_python(files)

    violations.extend(_check_registry_receipts())
    violations.extend(_check_recipe_receipt())
    violations.extend(_check_architecture_bets())

    if violations:
        print("CLAIMS LINTER: FAIL — overclaims found (fix the copy or add a qualifier):\n")
        for v in violations:
            print("  " + v)
        print(f"\n{len(violations)} violation(s). The README must not exceed agi-proof/failure-ledger.md.")
        print("If a line is genuinely qualified in context, append the marker 'claim-ok'.")
        return 1
    scanner = "sophia-lex" if used_accel else "python"
    print(f"CLAIMS LINTER: OK — scanned {len(files)} file(s) ({scanner}), no overclaims.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
