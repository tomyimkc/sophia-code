#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Live head-to-head **tool-use** benchmark for ``/bench``.

Where ``agent.model_bench`` grades prose Q&A, this grades whether a model can
actually *use tools*. It drives each model through the REAL Sophia tool loop
(``check_claim`` / ``wiki_search`` / ``belief`` dispatched in-process against the
provenance gate) over the sealed held-out tool-use cases, captures the trace, and
scores the six load-bearing tool-use skills with the repo's deterministic
verifiers, plus speed:

  S1  decision-to-call     — call / answer-direct / abstain, correctly
  S2  tool selection       — the right tool for the task
  S3  schema-valid args    — arguments validate AND execute
  S4  result grounding     — the answer is entailed by the tool output
  S6  fail-closed recovery — tool error/empty  ->  abstain, never invent
  over-call                — did it call when it already knew? (lower is better)
  task pass@1              — did the final answer satisfy the case?
  speed                    — median latency + throughput (tok/s)

This is the *live* driver the sealed scorer (``tools/eval_tool_use.py``)
declares but does not implement (its ``--mode real`` has no body — it only grades
``mock`` or precomputed traces). We reuse that scorer's ``score()`` / ``agg()``
so the numbers are identical to the sealed eval, and we reuse the S1-S6
verifiers, the sealed cases, and the in-process tool executor unchanged.

The report is written in the SAME ``*.candidate.json`` shape ``/bench`` writes,
into the same ``agi-proof/benchmark-results/bench/`` folder, so the results
dashboard (``tools/bench_dashboard.py``) renders it head-to-head automatically.

Usage::

    # Compare two local function-calling models on the sealed v1 cases:
    python -m tools.bench_tool_use \\
        --models ollama:qwen3:30b-a3b,mlx:mlx-community/Qwen3.6-35B-A3B-4bit \\
        --version heldout_v1 --max-cases 30

    # Dry-run the harness with the mock preset (no spend; it simply never calls
    # a tool, so every must-call case fails S1 — proves the wiring):
    python -m tools.bench_tool_use --models mock --max-cases 6

Only native function-calling transports (openai / vllm / ollama, mlx where the
served model supports tools) can actually emit ``tool_calls``. Prose-only CLI
plans (grok / codex) return text with no calls, so they score 0 on must-call
cases — an honest result, not a harness bug.

candidateOnly: true · canClaimAGI: false — the MCP tools encode the provenance
knowledge under test, so this measures tool-GROUNDED behavior, not pure model
capability (the same circularity ``provenance_bench.local_agent`` states plainly).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent.model import default_client  # noqa: E402
from agent.tool_use.policy import apply_trap, registry_for_case  # noqa: E402
from provenance_bench.local_agent import TOOL_SYSTEM, dispatch_tool  # noqa: E402
from provenance_bench.tool_use_benchmark import load_cases, verify_manifest  # noqa: E402

# Reuse the sealed scorer's exact metrics so live numbers match the sealed eval.
from tools.eval_tool_use import RunResult, agg, score  # noqa: E402

DEFAULT_REPORTS_DIR = ROOT / "agi-proof" / "benchmark-results" / "bench"

# grok / codex CLI transports return no token counts (codex fakes len//4); report
# their tok/s as null rather than a misleading number (mirrors agent.model_bench).
TRANSPORTS_WITHOUT_TOKEN_COUNTS = {"grok", "codex"}

# The skill columns surfaced by the dashboard, in display order, with labels.
# Keys match tools.eval_tool_use.score()/agg() output (trap_ok == S6).
TOOL_USE_SKILLS: dict[str, str] = {
    "s1_decision": "S1 decision-to-call",
    "s2_tool_selection": "S2 tool selection",
    "s3_schema_valid": "S3 schema-valid args",
    "s4_grounding": "S4 result grounding",
    "trap_ok": "S6 fail-closed recovery",
}
# Rates where LOWER is better (shown inverted in the dashboard).
LOWER_IS_BETTER = ("over_call", "false_call", "side_effect_violation")

MAX_TOOL_CALLS = 6  # bound a single case's dispatch so a pathological loop can't run away


# --------------------------------------------------------------------------- #
# Pure helpers (unit-tested)
# --------------------------------------------------------------------------- #
def slugify(models: list[str]) -> str:
    """Filename-safe slug from a model list (matches agent.model_bench.slugify)."""
    return "+".join(m.replace("/", "_").replace(":", "-") for m in models)


def dedupe(models: list[str]) -> list[str]:
    """Order-preserving de-duplication of model specs."""
    return list(dict.fromkeys(m for m in models if m))


def select_cases(cases: list[dict[str, Any]], max_cases: int) -> list[dict[str, Any]]:
    """Balanced round-robin sample across decision types, capped at ``max_cases``.

    The sealed file is ordered by id (all ``should-call-*`` first), so a naive
    head slice would be all-one-decision and skew every rate. Round-robin across
    the decision buckets keeps the sample representative of the benchmark balance.
    ``max_cases <= 0`` means "all cases".
    """
    if max_cases is not None and max_cases > 0 and max_cases < len(cases):
        buckets: dict[str, list[dict[str, Any]]] = {}
        for c in cases:
            buckets.setdefault(str(c.get("label", {}).get("decision", "")), []).append(c)
        order = sorted(buckets)  # deterministic bucket order
        picked: list[dict[str, Any]] = []
        idx = 0
        while len(picked) < max_cases and any(buckets[k] for k in order):
            bucket = buckets[order[idx % len(order)]]
            if bucket:
                picked.append(bucket.pop(0))
            idx += 1
        # Preserve the file's original order among the picked cases.
        picked_ids = {c["id"] for c in picked}
        return [c for c in cases if c["id"] in picked_ids]
    return list(cases)


def _augment_prompt(prompt: str, tool_results: list[dict[str, Any]]) -> str:
    """Second-turn prompt: original question + the tool outputs to ground on."""
    blob = "\n".join(
        f"- {r['name']}({r.get('args')}) => {json.dumps(r['result'], ensure_ascii=False)[:500]}"
        for r in tool_results
    )
    return (
        f"{prompt}\n\nTool results:\n{blob}\n\n"
        "Using these results, answer the original question concisely."
    )


def _normalize_tool_calls(raw: list[Any]) -> list[dict[str, Any]]:
    """Flatten model tool_calls to ``[{name, arguments}]``.

    ``agent.model`` flattens to ``{id,name,arguments}``; raw OpenAI nests under
    ``function``. Non-dict entries are dropped.
    """
    out: list[dict[str, Any]] = []
    for tc in raw or []:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
        name = tc.get("name") or fn.get("name", "")
        args = tc.get("arguments") if tc.get("arguments") is not None else fn.get("arguments", "{}")
        out.append({"name": name, "arguments": args})
    return out


def _skill_reasons(sc: dict[str, Any]) -> list[str]:
    """Human-readable failure reasons for the dashboard viewer."""
    reasons: list[str] = []
    for key, label in TOOL_USE_SKILLS.items():
        if not sc.get(key):
            reasons.append(f"{label} failed")
    if sc.get("over_call"):
        reasons.append("over-called (answer was already known)")
    if sc.get("false_call"):
        reasons.append("false call (should have answered directly)")
    if sc.get("side_effect_violation"):
        reasons.append("side-effect tool used without approval")
    return reasons


def _client_kind(client: Any) -> str:
    """Best-effort transport label for reporting (e.g. 'ollama', 'mlx', 'mock')."""
    primary = getattr(client, "primary", None)
    return getattr(primary, "kind", None) or getattr(client, "kind", None) or "model"


# --------------------------------------------------------------------------- #
# Live tool loop (the piece eval_tool_use.py's --mode real lacks)
# --------------------------------------------------------------------------- #
def run_case(client: Any, case: dict[str, Any], *, max_tool_calls: int = MAX_TOOL_CALLS) -> tuple[RunResult, dict[str, Any]]:
    """Drive one live model through the tool loop for one case.

    (1) ask with the case's allowed tool registry; (2) dispatch each emitted call
    in-process, applying the case's trap to the output; (3) re-ask with the tool
    outputs appended and take the final answer. Falls back to the plain answer if
    the model emits no calls (prose-only transports) or a turn errors — never
    raises. Returns ``(RunResult, meta)`` where meta carries latency/tokens.
    """
    registry = registry_for_case(case)
    prompt = str(case.get("prompt", ""))
    trap = case.get("trap", "none")

    started = time.monotonic()
    error: str | None = None
    try:
        res = client.generate(TOOL_SYSTEM, prompt, tools=registry)
    except Exception as exc:  # noqa: BLE001 - a transport failure is a scored outcome, not a crash
        res, error = None, f"{type(exc).__name__}: {exc}"

    tool_calls = _normalize_tool_calls(list(getattr(res, "tool_calls", []) or [])[:max_tool_calls])
    tokens = int(getattr(res, "completion_tokens", 0) or 0)

    tool_results: list[dict[str, Any]] = []
    for tc in tool_calls:
        outcome = apply_trap(dispatch_tool(tc["name"], tc["arguments"]), trap)
        tool_results.append({"name": tc["name"], "args": tc["arguments"], "result": outcome})

    if tool_calls:
        try:
            final = client.generate(TOOL_SYSTEM, _augment_prompt(prompt, tool_results))
            answer = getattr(final, "text", "") or getattr(res, "text", "") or ""
            tokens += int(getattr(final, "completion_tokens", 0) or 0)
        except Exception:  # noqa: BLE001 - grounding turn failed; fall back to the first answer
            answer = getattr(res, "text", "") or ""
    else:
        answer = getattr(res, "text", "") if res else ""

    latency_s = round(time.monotonic() - started, 3)
    run = RunResult(answer=answer, tool_calls=tool_calls, tool_results=tool_results, condition="trained")
    meta = {
        "latency_s": latency_s,
        "completion_tokens": tokens,
        "transport": _client_kind(client),
        "error": error,
        "tool_log": [tc["name"] for tc in tool_calls],
    }
    return run, meta


def run_model(
    spec: str,
    cases: list[dict[str, Any]],
    *,
    warmup: bool,
    progress_cb: Callable[[dict[str, Any]], None] | None = None,
    client: Any = None,
) -> dict[str, Any]:
    """Run every case through one model and return its tool-use scorecard row.

    The row mirrors ``agent.model_bench``'s per-model shape (so the dashboard's
    tables/charts/viewer work unchanged) and ADDS ``toolUse`` (the S1-S6 rates)
    plus per-case ``skills`` / ``tool_calls`` for the tool-use rendering.

    ``client`` is injectable for offline tests; production passes ``None`` and the
    transport is resolved from ``spec`` via ``agent.model.default_client``.
    """
    if client is None:
        client = default_client(spec)
    transport = _client_kind(client)

    cold_start_s: float | None = None
    if warmup and transport != "mock":
        t0 = time.monotonic()
        try:
            client.generate(TOOL_SYSTEM, "Ready? Reply with OK.")
        except Exception:  # noqa: BLE001 - warmup failure is non-fatal
            pass
        cold_start_s = round(time.monotonic() - t0, 3)

    scores: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    for idx, case in enumerate(cases):
        run, meta = run_case(client, case)
        sc = score(case, run)
        scores.append(sc)
        rows.append({
            "case_id": case.get("id"),
            "domain": str(case.get("label", {}).get("decision") or "tool-use"),
            "question": case.get("prompt"),
            "passed": bool(sc.get("task_pass")),
            "latency_s": meta["latency_s"],
            "completion_tokens": meta["completion_tokens"],
            "transport": meta["transport"],
            "is_cold_start": idx == 0 and cold_start_s is not None,
            "error": meta["error"],
            "response": run.answer,
            "tool_calls": run.tool_calls,
            "tool_results": [{"name": r["name"], "result": r["result"]} for r in run.tool_results],
            "skills": {k: bool(sc.get(k)) for k in TOOL_USE_SKILLS},
            "over_call": bool(sc.get("over_call")),
            "decision": case.get("label", {}).get("decision"),
            "trap": case.get("trap", "none"),
            "reasons": _skill_reasons(sc),
        })
        if progress_cb is not None:
            progress_cb({
                "model": spec,
                "case_idx": idx,
                "total": len(cases),
                "domain": rows[-1]["domain"],
                "case_id": rows[-1]["case_id"],
                "passed": rows[-1]["passed"],
                "latency_s": rows[-1]["latency_s"],
                "reasons": rows[-1]["reasons"],
                "is_cold_start": rows[-1]["is_cold_start"],
            })

    tool_use = agg(scores)  # {s1_decision, s2_tool_selection, ..., task_pass_at_1, over_call, ...}
    latencies = [r["latency_s"] for r in rows if r["latency_s"] is not None]
    tok_s = [
        r["completion_tokens"] / r["latency_s"]
        for r in rows
        if r["completion_tokens"] and r["latency_s"] and r["latency_s"] > 0
        and r["transport"] not in TRANSPORTS_WITHOUT_TOKEN_COUNTS
    ]
    row: dict[str, Any] = {
        "model": spec,
        "transport": transport,
        "passed": sum(1 for r in rows if r["passed"]),
        "total": len(rows),
        "score_pct": tool_use.get("task_pass_at_1", 0.0),  # 0..1; dashboard renders as %
        "median_latency_s": round(statistics.median(latencies), 3) if latencies else None,
        "mean_tok_s": round(statistics.mean(tok_s), 1) if tok_s else None,
        "cold_start_s": cold_start_s,
        "toolUse": tool_use,
        "cases": rows,
    }
    return row


# --------------------------------------------------------------------------- #
# Report (dashboard-compatible) + rendering
# --------------------------------------------------------------------------- #
def build_report(
    rows: list[dict[str, Any]],
    *,
    version: str,
    models: list[str],
    n_cases: int,
    warmup: bool,
    seal: dict[str, Any] | None,
) -> dict[str, Any]:
    """Assemble the ``*.candidate.json`` report (same shape /bench writes)."""
    domains = sorted({str(c.get("domain")) for r in rows for c in r.get("cases", [])})
    return {
        "benchmark": "sophia-tool-use-bench",
        "mode": "tool-use",
        "version": version,
        "runAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "corpus": "tool-use",
        "domains": domains,
        "maxCasesPerDomain": n_cases,
        "models": models,
        "warmup": warmup,
        "comparability": (
            "Same sealed cases + in-process MCP tools per model. Tool-calling needs native "
            "function-calling; prose-only transports score 0 on must-call cases. The tools "
            "encode the provenance knowledge under test, so this reflects tool-grounded "
            "behavior, not pure model capability."
        ),
        "benchmarkContentHash": (seal or {}).get("contentHash"),
        "sealOk": bool((seal or {}).get("ok")),
        "toolUseSkills": TOOL_USE_SKILLS,
        "lowerIsBetter": list(LOWER_IS_BETTER),
        "candidateOnly": True,
        "canClaimAGI": False,
        "results": {r["model"]: r for r in rows},
    }


def write_report(report: dict[str, Any], out_dir: Path) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = out_dir / f"{slugify(report['models'])}-tooluse-{ts}.candidate.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Persist per-case failures to the durable JSONL store
    try:
        from agent.benchmark_failure_store import ingest_tool_use_results
        for model_result in report.get("results", []):
            model_name = model_result.get("model", "unknown")
            run_id = f"tooluse-{ts}-{slugify(model_name)}"
            ingest_tool_use_results(run_id, model_name, model_result.get("rows", []))
    except Exception:  # noqa: BLE001 — failure store is best-effort
        pass

    return out_path


def render_table(rows: list[dict[str, Any]]) -> str:
    """Markdown comparison table, sorted by task pass@1 desc."""
    ordered = sorted(rows, key=lambda r: r.get("score_pct") or 0.0, reverse=True)
    head = (
        "| model | pass@1 | S1 | S2 | S3 | S4 | S6 | over-call | med lat (s) | tok/s |\n"
        "|---|--:|--:|--:|--:|--:|--:|--:|--:|"
    )
    lines = [head]

    def pc(x: Any) -> str:
        return "—" if x is None else f"{float(x) * 100:.0f}%"

    for r in ordered:
        tu = r.get("toolUse", {})
        lat = "—" if r.get("median_latency_s") is None else f"{r['median_latency_s']:.2f}"
        tok = "—" if r.get("mean_tok_s") is None else f"{r['mean_tok_s']:.0f}"
        lines.append(
            f"| {r['model']} | {pc(r.get('score_pct'))} | {pc(tu.get('s1_decision'))} | "
            f"{pc(tu.get('s2_tool_selection'))} | {pc(tu.get('s3_schema_valid'))} | "
            f"{pc(tu.get('s4_grounding'))} | {pc(tu.get('trap_ok'))} | "
            f"{pc(tu.get('over_call'))} | {lat} | {tok} |"
        )
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Harness-weakness diagnosis — interpret the S1-S6 pattern as actionable gaps
# --------------------------------------------------------------------------- #
# A skill rate below these thresholds flags a NAMED harness weakness the operator
# (or the OKF anti-repeat loop) can act on. Tuned to "clearly weak", not "perfect":
# a rate in the gray zone (between FLOOR and the pass@1 headline) is reported as a
# soft note, not a flag, so the diagnosis does not over-call.
WEAKNESS_FLOOR = 0.60  # a skill below this is a flagged gap


def _diagnose_one(tu: dict[str, Any], pass_at_1: float | None) -> list[dict[str, str]]:
    """Return a list of {skill, rate, weakness, action} for clearly-weak skills.

    The mapping is harness-shaped (NOT model-IQ-shaped): each skill isolates a
    different loop subsystem, so a low rate points at a fixable harness seam, not
    "the model is dumb." Order matters — the first hit is usually the root cause
    that cascades into the others (S1 low drags S2/S3/S4 down with it).
    """
    flags: list[dict[str, str]] = []

    def _flag(skill: str, rate: float, weakness: str, action: str) -> None:
        if rate is None:
            return
        if rate < WEAKNESS_FLOOR:
            flags.append({"skill": skill, "rate": f"{rate*100:.0f}%",
                          "weakness": weakness, "action": action})

    s1 = tu.get("s1_decision")
    s2 = tu.get("s2_tool_selection")
    s3 = tu.get("s3_schema_valid")
    s4 = tu.get("s4_grounding")
    s6 = tu.get("trap_ok")
    over = tu.get("over_call")
    # Each diagnosis names the harness subsystem + a concrete next action.
    _flag("S1", s1,
          "decision-to-call: the loop calls a tool when it should answer directly "
          "(or abstains when it must call) — a steering/prompt gap, not model IQ",
          "audit the system prompt's tool-vs-answer framing; check the nudge logic "
          "isn't forcing calls on knowledge questions")
    _flag("S2", s2,
          "tool selection: the loop picks the wrong tool for the task — a tool-catalog "
          "clarity / description gap",
          "sharpen the failing tools' descriptions; check the tool list isn't too long "
          "(selection dilution)")
    _flag("S3", s3,
          "schema-valid args: the loop emits args that fail JSON-schema validation or "
          "don't execute — a native-tool-call normalization gap (common with local Qwen/"
          "vLLM parallel batches that drop empty-name slots)",
          "inspect _filter_native_calls / _native_tool_call normalization; add the "
          "failing arg shape as a regression test")
    _flag("S4", s4,
          "result grounding: the loop's final answer is NOT entailed by the tool output — "
          "a grounding/context gap (the model ignores the tool result)",
          "check tool results are re-fed into the transcript verbatim (not summarized); "
          "audit auto_compact isn't dropping the result turn")
    _flag("S6", s6,
          "fail-closed recovery: on a tool error/empty result the loop invents an answer "
          "instead of abstaining — a safety/guard gap",
          "strengthen the delivery gate's abstention-on-error rule; this is a reliability "
          "weakness that pass^k (tau-bench) would amplify")
    # over-call is "lower is better": flag HIGH over-call as a distinct waste pattern.
    if over is not None and over > 0.40:
        flags.append({"skill": "over-call", "rate": f"{over*100:.0f}%",
                      "weakness": "over-call: the loop calls a tool when it already knew the "
                      "answer — a cost/latency gap, not correctness",
                      "action": "add a 'do you already know this?' pre-check in the steering; "
                      "raises latency and token cost without helping pass@1"})
    return flags


def diagnose_weaknesses(rows: list[dict[str, Any]]) -> str:
    """Render a harness-weakness diagnosis from a tool-use result set.

    For each model, names the clearly-weak skills (rate < WEAKNESS_FLOOR) as
    actionable harness gaps. This is the diagnostic surface that turns the S1-S6
    numbers into OKF-recordable lessons — the *point* of running tool-use for
    harness improvement (vs a capability headline). candidateOnly; not a claim.
    """
    if not rows:
        return "_(no rows to diagnose)_"
    blocks: list[str] = ["## Harness-weakness diagnosis (tool-use S1-S6)",
                         "Each flagged skill is a fixable **harness** subsystem, not a " +
                         "model-IQ verdict. Record these in OKF; fix the lowest-skill " +
                         "first (it usually cascades).\n"]
    for r in sorted(rows, key=lambda x: x.get("score_pct") or 0.0):
        model = r.get("model", "?")
        tu = r.get("toolUse", {}) or {}
        p1 = r.get("score_pct")
        flags = _diagnose_one(tu, p1)
        blocks.append(f"### {model} — pass@1 {'' if p1 is None else f'{p1*100:.0f}%'}")
        if not flags:
            blocks.append("No skill below the weakness floor ("
                          f"{int(WEAKNESS_FLOOR*100)}%); harness tool-use looks "
                          "balanced. (This is a harness-health read, not a capability claim.)")
            continue
        blocks.append("| skill | rate | weakness | suggested action |")
        blocks.append("|---|--:|---|---|")
        for f in flags:
            blocks.append(f"| {f['skill']} | {f['rate']} | {f['weakness']} | {f['action']} |")
        blocks.append("")
    return "\n".join(blocks)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m tools.bench_tool_use", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--models", required=True,
                   help="Comma-separated model specs, e.g. 'ollama:qwen3:30b-a3b,mlx:...,mock'.")
    p.add_argument("--version", default="heldout_v1", choices=["heldout_v1", "heldout_v2"],
                   help="Sealed tool-use benchmark version (default heldout_v1).")
    p.add_argument("--max-cases", type=int, default=30,
                   help="Cap total cases (balanced across decision types). <=0 = all.")
    p.add_argument("--no-warmup", dest="warmup", action="store_false",
                   help="Skip the cold-start warmup call.")
    p.add_argument("--out", type=Path, default=DEFAULT_REPORTS_DIR,
                   help="Directory for the JSON report (default agi-proof/benchmark-results/bench/).")
    p.add_argument("--allow-unsealed", action="store_true",
                   help="Proceed even if the benchmark seal fails (default: warn and continue).")
    args = p.parse_args(argv)

    specs = dedupe([s.strip() for s in args.models.split(",")])
    if not specs:
        raise SystemExit("--models must contain at least one model spec")

    seal = verify_manifest(root=ROOT, version=args.version)
    if not seal.get("ok"):
        msg = f"benchmark seal FAILED for {args.version}: {seal.get('errors')}"
        if not args.allow_unsealed:
            print(f"WARNING: {msg} (continuing; --allow-unsealed to silence, candidateOnly report)", file=sys.stderr)

    all_cases = load_cases(version=args.version)
    cases = select_cases(all_cases, args.max_cases)
    print(f"tool-use benchmark {args.version}: {len(cases)}/{len(all_cases)} cases, "
          f"{len(specs)} model(s): {', '.join(specs)}", file=sys.stderr)

    rows: list[dict[str, Any]] = []
    for spec in specs:
        print(f"  running {spec} ...", file=sys.stderr)
        rows.append(run_model(spec, cases, warmup=args.warmup))

    report = build_report(rows, version=args.version, models=specs,
                          n_cases=len(cases), warmup=args.warmup, seal=seal)
    out_path = write_report(report, args.out)

    print("\n" + render_table(rows))
    print(f"\nwrote {out_path}")
    print("candidateOnly: true · canClaimAGI: false — tool-grounded behavior over a sealed "
          "benchmark; not a pure model-capability claim.")
    print("view the dashboard:  python tools/bench_dashboard.py --serve --open", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
