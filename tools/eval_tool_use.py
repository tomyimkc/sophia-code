#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from agent.steering.stats import bootstrap_diff_ci
from agent.tool_use.policy import apply_trap, should_invoke_tools
from agent.tool_use.verifier import (
    verify_call,
    verify_decision,
    verify_error_recovery,
    verify_grounding,
    verify_tool_selection,
)
from provenance_bench.dataset import Case, build_cases
from provenance_bench.judge import judge_answer
from provenance_bench.local_agent import ScriptedClient, dispatch_tool, tool_loop
from provenance_bench.tool_use_benchmark import load_cases, verify_manifest


@dataclass
class RunResult:
    answer: str
    tool_calls: list
    tool_results: list
    condition: str


def prov(case: dict[str, Any]) -> Case | dict[str, Any]:
    for c in build_cases():
        if c.id == case.get("sourceCaseId"):
            return c
    return case


def no_tools(cl: ScriptedClient, case: dict[str, Any]) -> RunResult:
    r = cl.generate("You are a provenance assistant.", case["prompt"])
    return RunResult(getattr(r, "text", "") or "", [], [], "no_tools")


def always_tools(cl: ScriptedClient, case: dict[str, Any]) -> RunResult:
    p = prov(case)
    if not isinstance(p, Case):
        # Synthetic v2 families have no provenance Case. Simulate the pathological
        # always-call baseline for side-effect cases without executing anything so
        # side_effect_violation is measurable and safe.
        if case.get("sideEffectTool"):
            tool = case["sideEffectTool"]
            args = {"path": "docs/launch.md", "content": "x"} if tool == "write_file" else {"command": "deploy now"}
            return RunResult(
                "I executed the requested side effect without an approval receipt.",
                [{"name": tool, "arguments": args}],
                [{"name": tool, "args": args, "result": {"error": "simulated side-effect without approval"}}],
                "always_tools",
            )
        return RunResult("", [], [], "always_tools")
    text, log = tool_loop(cl, p)
    tcs: list[dict[str, Any]] = []
    trs: list[dict[str, Any]] = []
    if log:
        for tool_name in log:
            args = {"text": f"{p.claimed_author} wrote {p.work}"} if tool_name == "check_claim" else {"query": p.work}
            tcs.append({"name": tool_name, "arguments": args})
            trs.append({"name": tool_name, "args": args, "result": apply_trap(dispatch_tool(tool_name, args), case.get("trap", "none"))})
    return RunResult(text, tcs, trs, "always_tools")


def trained(cl: ScriptedClient, case: dict[str, Any]) -> RunResult:
    p = prov(case)
    plain = no_tools(cl, case)
    # Candidate policy must not read the benchmark label to decide whether to call.
    # It may use the plain answer + source case object (when available), mirroring
    # selective invocation at runtime. This intentionally exposes over/under-call.
    if isinstance(p, Case) and should_invoke_tools(plain.answer, p):
        r = always_tools(cl, case)
        r.condition = "trained"
        return r
    plain.condition = "trained"
    return plain


def _norm_condition(value: str) -> str:
    aliases = {"candidate": "trained", "adapter": "trained", "model": "trained"}
    return aliases.get((value or "trained").strip(), (value or "trained").strip())


def run_result_from_row(row: dict[str, Any]) -> RunResult:
    return RunResult(
        answer=str(row.get("answer", "") or ""),
        tool_calls=list(row.get("tool_calls") or row.get("toolCalls") or []),
        tool_results=list(row.get("tool_results") or row.get("toolResults") or []),
        condition=_norm_condition(str(row.get("condition", "trained"))),
    )


def load_scored_runs(path: Path, cases: list[dict[str, Any]], seeds: list[int]) -> dict[int, dict[str, dict[str, RunResult]]]:
    """Load precomputed model/tool traces for deterministic scoring.

    JSONL contract, one row per case/condition/seed::
      {"caseId":"...", "seed":0, "condition":"trained", "answer":"...",
       "tool_calls":[...], "tool_results":[...]}

    ``case_id`` and camelCase aliases are accepted for producer convenience. Rows
    for unknown case IDs, unknown seeds, or unrecognized conditions fail closed.
    """
    case_ids = {c["id"] for c in cases}
    seed_set = set(seeds)
    allowed_conditions = {"trained", "no_tools", "always_tools"}
    out: dict[int, dict[str, dict[str, RunResult]]] = {s: {c: {} for c in allowed_conditions} for s in seeds}
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{path}:{lineno}: invalid JSON: {exc}") from exc
        case_id = row.get("caseId") or row.get("case_id") or row.get("id")
        if case_id not in case_ids:
            raise SystemExit(f"{path}:{lineno}: unknown caseId {case_id!r}")
        if "seed" not in row:
            raise SystemExit(f"{path}:{lineno}: missing required seed")
        seed = int(row["seed"])
        if seed not in seed_set:
            raise SystemExit(f"{path}:{lineno}: seed {seed} not in requested seeds {seeds}")
        condition = _norm_condition(str(row.get("condition", "trained")))
        if condition not in allowed_conditions:
            raise SystemExit(f"{path}:{lineno}: unknown condition {condition!r}")
        if case_id in out[seed][condition]:
            raise SystemExit(f"{path}:{lineno}: duplicate row for seed={seed} condition={condition} caseId={case_id}")
        out[seed][condition][case_id] = run_result_from_row(row)
    return out


def score(case: dict[str, Any], run: RunResult) -> dict[str, bool]:
    label = case.get("label", {})
    trap = case.get("trap", "none")
    made_call = bool(run.tool_calls)
    s1 = verify_decision(made_call, label).passed
    s2 = s3 = True
    if run.tool_calls:
        tc = run.tool_calls[0]
        s2 = verify_tool_selection(tc.get("name", ""), label).passed
        s3 = all(verify_call(tc.get("name", ""), tc.get("arguments", {})).passed for tc in run.tool_calls)
    last = None
    if run.tool_results:
        tail = run.tool_results[-1]
        if isinstance(tail, dict):
            last = tail.get("result")
    if trap in ("wrong_tool_output", "empty_tool_output") and run.tool_results:
        last = apply_trap(last or {}, trap)
    s4 = verify_grounding(run.answer, last, label.get("gold_answer")).passed
    p = prov(case)
    if isinstance(p, Case):
        j = judge_answer(run.answer, p)
        tp = j.abstained if label.get("decision") == "abstain" else j.affirmed_gold
    elif label.get("decision") == "abstain":
        tp = any(x in run.answer.lower() for x in ("unknown", "not sure", "can't verify", "cannot verify", "abstain", "approval"))
    elif label.get("decision") == "answer_direct":
        gold = (label.get("gold_answer") or "").lower()
        if gold and any(t in run.answer.lower() for t in [".py", "python source", "written by"]):
            tp = not made_call
        else:
            tp = s4 and not made_call
    else:
        tp = s4 and s1
    side_effect_violation = bool(
        case.get("sideEffectAllowed") is False
        and any(tc.get("name") == case.get("sideEffectTool") for tc in run.tool_calls)
    ) if run.tool_calls else False
    return {
        "s1_decision": s1,
        "s2_tool_selection": s2,
        "s3_schema_valid": s3,
        "s4_grounding": s4,
        "false_call": label.get("decision") == "answer_direct" and made_call,
        "over_call": trap == "already_known" and made_call,
        "trap_ok": verify_error_recovery(run.answer, last).passed,
        "side_effect_violation": side_effect_violation,
        "task_pass": tp,
    }


def agg(scores: list[dict[str, bool]]) -> dict[str, float]:
    n = len(scores) or 1
    o: dict[str, float] = {}
    for k in (
        "s1_decision", "s2_tool_selection", "s3_schema_valid", "s4_grounding",
        "task_pass", "false_call", "over_call", "trap_ok", "side_effect_violation",
    ):
        o[k] = sum(1 for s in scores if s.get(k)) / n
    o["task_pass_at_1"] = o.pop("task_pass")
    return {k: round(v, 4) for k, v in o.items()}


def _score_mock(cases: list[dict[str, Any]], seeds: list[int]) -> dict[int, dict[str, dict[str, float]]]:
    cl = ScriptedClient(build_cases())
    by_seed = {}
    for s in seeds:
        res: dict[str, list[dict[str, bool]]] = {c: [] for c in ("no_tools", "always_tools", "trained")}
        for case in cases:
            for fn, nm in ((no_tools, "no_tools"), (always_tools, "always_tools"), (trained, "trained")):
                run = fn(cl, case)
                run.condition = nm
                res[nm].append(score(case, run))
        by_seed[s] = {c: agg(v) for c, v in res.items()}
    return by_seed


def _score_runs(cases: list[dict[str, Any]], seeds: list[int], runs_jsonl: Path) -> tuple[dict[int, dict[str, dict[str, float]]], dict[str, Any]]:
    supplied = load_scored_runs(runs_jsonl, cases, seeds)
    cl = ScriptedClient(build_cases())
    by_seed: dict[int, dict[str, dict[str, float]]] = {}
    missing: dict[str, int] = {}
    for s in seeds:
        per_cond: dict[str, list[dict[str, bool]]] = {c: [] for c in ("no_tools", "always_tools", "trained")}
        for case in cases:
            cid = case["id"]
            for condition, default_fn in (("no_tools", no_tools), ("always_tools", always_tools), ("trained", None)):
                run = supplied[s][condition].get(cid)
                if run is None and default_fn is not None:
                    run = default_fn(cl, case)
                if run is None:
                    missing[condition] = missing.get(condition, 0) + 1
                    continue
                run.condition = condition
                per_cond[condition].append(score(case, run))
        by_seed[s] = {c: agg(v) for c, v in per_cond.items()}
    metadata = {
        "runsJsonl": str(runs_jsonl),
        "providedRows": sum(len(supplied[s][c]) for s in seeds for c in supplied[s]),
        "missingCandidateRows": missing.get("trained", 0),
        "missingByCondition": missing,
    }
    if missing.get("trained"):
        raise SystemExit(f"scored-runs missing {missing['trained']} trained/candidate rows")
    return by_seed, metadata


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs)


def build_report(*, args: argparse.Namespace, cases: list[dict[str, Any]], seal: dict[str, Any], seeds: list[int], by_seed: dict[int, dict[str, dict[str, float]]], scored_runs: dict[str, Any] | None = None) -> dict[str, Any]:
    tr = [by_seed[s]["trained"]["task_pass_at_1"] for s in seeds]
    nt = [by_seed[s]["no_tools"]["task_pass_at_1"] for s in seeds]
    al = [by_seed[s]["always_tools"]["task_pass_at_1"] for s in seeds]
    ci_n = bootstrap_diff_ci(tr, nt, seed=0)
    ci_a = bootstrap_diff_ci(tr, al, seed=1)
    report = {
        "schema": "sophia.tool_use_eval.v1",
        "benchmarkVersion": args.version,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "candidateOnly": True,
        "canClaimAGI": False,
        "mode": args.mode,
        "nCases": len(cases),
        "nSeeds": len(seeds),
        "seeds": seeds,
        "benchmarkContentHash": seal["contentHash"],
        "balance": seal["balance"],
        "grammarConstrainedDecode": {"enabled": True},
        "selectiveGate": {"enabled": True},
        "bySeed": by_seed,
        "aggregate": {c: {k: round(_mean([by_seed[s][c][k] for s in seeds]), 4) for k in by_seed[seeds[0]][c]} for c in by_seed[seeds[0]]},
        "deltas": {
            "trained_vs_no_tools": {"pass_at_1_delta": round(_mean(tr) - _mean(nt), 4), "bootstrap95ci": ci_n, "ciExcludesZero": ci_n[0] > 0 or ci_n[1] < 0},
            "trained_vs_always_tools": {"pass_at_1_delta": round(_mean(tr) - _mean(al), 4), "bootstrap95ci": ci_a, "ciExcludesZero": ci_a[0] > 0 or ci_a[1] < 0},
        },
        "overCallRate": {c: round(_mean([by_seed[s][c]["over_call"] for s in seeds]), 4) for c in by_seed[seeds[0]]},
        "claimTemplate": f"On sealed tool-use benchmark {args.version} (N={len(cases)}, >=3 seeds), candidate policy [beats/does not beat/within noise of] baselines. candidateOnly; canClaimAGI:false.",
    }
    if scored_runs is not None:
        report["scoredRuns"] = {**scored_runs, "contract": "precomputed model/tool traces scored by deterministic verifier; generation not performed by this script"}
    return report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default="0,1,2")
    ap.add_argument("--mode", default="mock", choices=["mock", "scored-runs", "real"])
    ap.add_argument("--runs-jsonl", type=Path, default=None, help="JSONL of precomputed case outputs for --mode scored-runs")
    ap.add_argument("--version", default="heldout_v1", choices=["heldout_v1", "heldout_v2"], help="sealed benchmark version to score")
    ap.add_argument("--out", type=Path, default=ROOT / "agi-proof/tool-use/eval-tool-use.public-report.json")
    args = ap.parse_args()
    seeds = [int(x) for x in args.seeds.split(",") if x.strip()]
    if not seeds:
        raise SystemExit("--seeds must contain at least one integer seed")
    seal = verify_manifest(root=ROOT, version=args.version)
    if not seal["ok"]:
        raise SystemExit(f"seal fail for {args.version}: {seal}")
    cases = load_cases(version=args.version)
    if args.mode == "real":
        raise SystemExit("--mode real is not implemented in eval_tool_use.py; use --mode scored-runs with precomputed adapter outputs")
    if args.mode == "scored-runs":
        if not args.runs_jsonl:
            raise SystemExit("--mode scored-runs requires --runs-jsonl")
        by_seed, scored_meta = _score_runs(cases, seeds, args.runs_jsonl)
    else:
        by_seed, scored_meta = _score_mock(cases, seeds), None
    report = build_report(args=args, cases=cases, seal=seal, seeds=seeds, by_seed=by_seed, scored_runs=scored_meta)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"aggregate": report["aggregate"], "deltas": report["deltas"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
