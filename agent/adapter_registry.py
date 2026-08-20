# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Adapter registry — the feasible adoption path for θ_search-style dual-use adapters.

The cross-model study taught the load-bearing lesson: a source-discipline adapter is
**base-model- and recipe-specific** (validated on Qwen2.5-7B, +0.20 with 3 concordant
judge families; *negative* on Mistral with the council corpus). So the safe way to *adopt*
these adapters is NOT "train once, bind everywhere" — it is a **registry keyed by
(base_model, team)** where a binding is admitted ONLY if its evidence clears the repo's
no-overclaim bar, and the SwarmRouter falls back to the un-adapted backbone otherwise.

This module is that registry + its acceptance gate. It is the production answer to "how do
we use this": the multi-seed / multi-judge eval (``provenance_bench/search_recall.py`` +
``tools/llm_judge_score.py``) is the **acceptance test**; a passing result mints an
``AdapterBinding``; the SwarmRouter resolves a team's adapter from the registry for the
*active* base model and uses it only if accepted — exactly the discipline of
``agent/continual_plasticity.py``, lifted to per-base agent-team binding.

Fail-closed by construction: an unknown (base_model, team), or a binding that did not clear
the bar, resolves to ``None`` → the team runs on the plain backbone, never a regressing
adapter.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

REGISTRY_SCHEMA = "sophia.adapter_registry.v1"


@dataclass(frozen=True)
class FamilyResult:
    """One judge family's verdict on a candidate (independent scorer or LLM judge)."""

    name: str
    mean_delta: float
    ci_low: float
    ci_high: float

    @property
    def excludes_zero_positive(self) -> bool:
        return self.ci_low > 0.0 and self.mean_delta > 0.0


@dataclass(frozen=True)
class AcceptanceEvidence:
    """The multi-judge, multi-seed evidence behind a binding decision."""

    pack: str
    n_traps: int
    seeds: int
    families: tuple[FamilyResult, ...]
    kappa: float = 0.0  # min pairwise inter-family agreement
    judges: tuple[str, ...] = ()

    def decide(self, *, min_families: int = 2, min_kappa: float = 0.40) -> "tuple[bool, list[str]]":
        """Clears the no-overclaim bar iff: >= min_families independent judges, EVERY
        family shows a positive mean with a 95% CI excluding zero, and inter-family
        agreement kappa >= min_kappa. Returns (accepted, reasons)."""
        reasons: list[str] = []
        if len(self.families) < min_families:
            reasons.append(f"need >= {min_families} judge families, have {len(self.families)}")
        for f in self.families:
            if not f.excludes_zero_positive:
                reasons.append(f"family '{f.name}' not positive-with-CI-excluding-zero "
                               f"(delta={f.mean_delta}, ci=[{f.ci_low},{f.ci_high}])")
        if len(self.families) >= 2 and self.kappa < min_kappa:
            reasons.append(f"inter-family kappa {self.kappa} < {min_kappa}")
        accepted = not reasons
        return accepted, (reasons or ["all judge families positive, CIs exclude zero, kappa OK"])

    def to_dict(self) -> dict:
        return {
            "pack": self.pack, "nTraps": self.n_traps, "seeds": self.seeds, "kappa": self.kappa,
            "judges": list(self.judges),
            "families": [{"name": f.name, "meanDelta": f.mean_delta, "ci95": [f.ci_low, f.ci_high]}
                         for f in self.families],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "AcceptanceEvidence":
        fams = tuple(FamilyResult(f["name"], f["meanDelta"], f["ci95"][0], f["ci95"][1])
                     for f in d.get("families", []))
        return cls(d.get("pack", ""), int(d.get("nTraps", 0)), int(d.get("seeds", 0)),
                   fams, float(d.get("kappa", 0.0)), tuple(d.get("judges", ())))


@dataclass(frozen=True)
class AdapterBinding:
    base_model: str
    team: str
    adapter_id: str
    accepted: bool
    evidence: AcceptanceEvidence | None = None
    reasons: tuple[str, ...] = ()
    notes: str = ""

    def to_dict(self) -> dict:
        return {
            "baseModel": self.base_model, "team": self.team, "adapterId": self.adapter_id,
            "accepted": self.accepted, "reasons": list(self.reasons), "notes": self.notes,
            "evidence": self.evidence.to_dict() if self.evidence else None,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "AdapterBinding":
        ev = AcceptanceEvidence.from_dict(d["evidence"]) if d.get("evidence") else None
        return cls(d["baseModel"], d["team"], d["adapterId"], bool(d.get("accepted")),
                   ev, tuple(d.get("reasons", ())), d.get("notes", ""))


@dataclass
class AdapterRegistry:
    bindings: list[AdapterBinding] = field(default_factory=list)

    def resolve(self, base_model: str, team: str) -> "str | None":
        """The adapter id to load for this team on this base model — ONLY if a binding
        was accepted. Fail-closed: anything else → None (plain backbone)."""
        for b in self.bindings:
            if b.base_model == base_model and b.team == team and b.accepted:
                return b.adapter_id
        return None

    def status(self, base_model: str, team: str) -> "AdapterBinding | None":
        for b in self.bindings:
            if b.base_model == base_model and b.team == team:
                return b
        return None

    def add(self, binding: AdapterBinding) -> None:
        # one binding per (base_model, team); the newest wins.
        self.bindings = [b for b in self.bindings
                         if not (b.base_model == binding.base_model and b.team == binding.team)]
        self.bindings.append(binding)

    def to_dict(self) -> dict:
        return {"schema": REGISTRY_SCHEMA, "candidateOnly": True, "level3Evidence": False,
                "bindings": [b.to_dict() for b in self.bindings]}

    def save(self, path: "str | Path") -> None:
        Path(path).write_text(json.dumps(self.to_dict(), indent=2) + "\n")

    @classmethod
    def load(cls, path: "str | Path") -> "AdapterRegistry":
        p = Path(path)
        if not p.exists():
            return cls()
        d = json.loads(p.read_text())
        return cls([AdapterBinding.from_dict(b) for b in d.get("bindings", [])])


# ---------------------------------------------------------------------------
# Build a binding decision from a real multi-seed run result (+ optional LLM-judge report).
# ---------------------------------------------------------------------------
def evidence_from_results(run_result: dict, llm_judge_report: dict | None = None) -> AcceptanceEvidence:
    """Parse families + kappa from a ``multiseed_remote`` result and an optional
    ``llm_judge_score`` report into acceptance evidence."""
    fams: list[FamilyResult] = []
    for name, r in (run_result.get("families") or {}).items():
        ci = r.get("ci95", [0.0, 0.0])
        fams.append(FamilyResult(name, float(r.get("mean_delta", 0.0)), float(ci[0]), float(ci[1])))
    judges: list[str] = ["heuristic:lexical", "heuristic:stance"]
    kappas = [float(run_result.get("kappa_between_families", 0.0))]
    if llm_judge_report:
        lj = llm_judge_report.get("llm_judge", {})
        ci = lj.get("ci95", [0.0, 0.0])
        fams.append(FamilyResult("llm:" + llm_judge_report.get("judge_model", "judge"),
                                 float(lj.get("mean_delta", 0.0)), float(ci[0]), float(ci[1])))
        judges.append("llm:" + llm_judge_report.get("judge_model", "judge"))
        kappas += [float(llm_judge_report.get("kappa_llm_vs_lexical", 0.0)),
                   float(llm_judge_report.get("kappa_llm_vs_stance", 0.0))]
    return AcceptanceEvidence(
        pack=run_result.get("pack", ""), n_traps=int(run_result.get("n_traps", 0)),
        seeds=len(run_result.get("seeds", []) or []), families=tuple(fams),
        kappa=min(kappas) if kappas else 0.0, judges=tuple(judges),
    )


def decide_binding(run_result: dict, *, base_model: str, team: str, adapter_id: str,
                   llm_judge_report: dict | None = None, notes: str = "") -> AdapterBinding:
    """Run the acceptance gate over a run's evidence → an AdapterBinding (accepted or not)."""
    ev = evidence_from_results(run_result, llm_judge_report)
    accepted, reasons = ev.decide()
    return AdapterBinding(base_model, team, adapter_id, accepted, ev, tuple(reasons), notes)


# Default registry path (committed, sha-auditable).
DEFAULT_REGISTRY_PATH = Path(__file__).resolve().parents[1] / "data" / "adapters" / "registry.json"


def default_registry() -> AdapterRegistry:
    return AdapterRegistry.load(DEFAULT_REGISTRY_PATH)


def offline_invariants() -> "tuple[bool, dict]":
    checks: dict[str, bool] = {}

    # A passing candidate (Qwen θ_search): 3 families positive, CIs exclude zero, kappa high.
    good = AcceptanceEvidence("third_party", 30, 3, (
        FamilyResult("lexical", 0.20, 0.122, 0.289),
        FamilyResult("stance", 0.144, 0.056, 0.233),
        FamilyResult("llm:deepseek", 0.20, 0.122, 0.289),
    ), kappa=0.84, judges=("lexical", "stance", "llm:deepseek"))
    acc, _ = good.decide()
    checks["good_accepts"] = acc

    # A failing candidate (Mistral council): families NEGATIVE → reject.
    bad = AcceptanceEvidence("third_party", 30, 3, (
        FamilyResult("lexical", -0.278, -0.40, -0.144),
        FamilyResult("llm:deepseek", -0.278, -0.40, -0.144),
    ), kappa=1.0)
    bad_acc, bad_reasons = bad.decide()
    checks["bad_rejects"] = not bad_acc and any("not positive" in r for r in bad_reasons)

    # Single-family evidence (no second judge) → reject (needs >=2 families).
    lone = AcceptanceEvidence("p", 10, 3, (FamilyResult("lexical", 0.2, 0.1, 0.3),))
    checks["single_family_rejects"] = not lone.decide()[0]

    # CI includes zero → reject even if mean positive.
    flat = AcceptanceEvidence("p", 10, 3, (
        FamilyResult("lexical", 0.05, -0.02, 0.12), FamilyResult("stance", 0.04, -0.01, 0.09)), kappa=0.9)
    checks["ci_includes_zero_rejects"] = not flat.decide()[0]

    # Registry: an accepted binding resolves; a rejected one does NOT (fail-closed).
    reg = AdapterRegistry()
    reg.add(AdapterBinding("Qwen/Qwen2.5-7B-Instruct", "search", "theta-search-qwen-v1", True, good))
    reg.add(AdapterBinding("mistralai/Mistral-7B-Instruct-v0.3", "search", "theta-search-mistral-council", False, bad))
    checks["accepted_resolves"] = reg.resolve("Qwen/Qwen2.5-7B-Instruct", "search") == "theta-search-qwen-v1"
    checks["rejected_failcloses"] = reg.resolve("mistralai/Mistral-7B-Instruct-v0.3", "search") is None
    checks["unknown_failcloses"] = reg.resolve("some/other-model", "search") is None

    # Round-trip through dict.
    checks["roundtrip"] = AdapterRegistry([list(reg.bindings)[0]]).to_dict()["bindings"][0]["accepted"] is True

    # decide_binding from a run-result dict shape.
    run = {"pack": "third_party", "n_traps": 30, "seeds": [0, 1, 2], "kappa_between_families": 0.84,
           "families": {"lexical": {"mean_delta": 0.2, "ci95": [0.122, 0.289]},
                        "stance": {"mean_delta": 0.144, "ci95": [0.056, 0.233]}}}
    lj = {"judge_model": "deepseek/deepseek-chat", "kappa_llm_vs_lexical": 1.0, "kappa_llm_vs_stance": 0.84,
          "llm_judge": {"mean_delta": 0.2, "ci95": [0.122, 0.289]}}
    b = decide_binding(run, base_model="Qwen/Qwen2.5-7B-Instruct", team="search",
                       adapter_id="theta-search-qwen-v1", llm_judge_report=lj)
    checks["decide_binding_accepts_real_qwen"] = b.accepted and len(b.evidence.families) == 3

    ok = all(checks.values())
    return ok, {"checks": checks}


if __name__ == "__main__":
    ok, detail = offline_invariants()
    print("Adapter registry offline invariants:", "PASS" if ok else "FAIL")
    for k, v in detail["checks"].items():
        print(f"  [{'ok' if v else 'XX'}] {k}")
    raise SystemExit(0 if ok else 1)
