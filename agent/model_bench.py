#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Head-to-head benchmark: run the same gold-labelled task corpus across
multiple LLMs and report a comparative scorecard.

This fills the one gap the repo's eval infrastructure had: it had multi-model
loops (``tools/run_council_panel.py``), gold corpora
(``tests/benchmark-*.json``), a deterministic judge
(``agent.benchmark_checks.score_case``), and a unified model entry point
(``agent.model.default_client``) — but no tool that ran the SAME tasks across
N models and produced a single comparison document. This is that tool.

Usage::

    # The three models the operator asked for (prose-only, no tools):
    python -m agent.model_bench --models grok,qwen-coding,codex-5.6 \\
        --corpus knowledge --max-cases 20

    # Local-LLM throughput comparison (mlx vs ollama vs vllm):
    python -m agent.model_bench \\
        --models mlx:mlx-community/Qwen3.6-35B-A3B-4bit,ollama:qwen3:30b-a3b,vllm \\
        --corpus philosophy

    # Dry-run against the mock preset (no API/CLI spend; proves the harness):
    python -m agent.model_bench --models mock --corpus philosophy --max-cases 3

    # Just verify each backend is configured (1 throwaway call each):
    python -m agent.model_bench --models grok,qwen-coding,codex-5.6 --smoke-only

Output:
  - A markdown comparison table on stdout (sorted by score).
  - A JSON report at ``agi-proof/benchmark-results/bench/<slug>-<ts>.candidate.json``.

candidateOnly: true · canClaimAGI: false — methodology/integrity tooling only.
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

from agent.benchmark_checks import (  # noqa: E402
    DOMAIN_BENCH,
    load_benchmark,
    load_traditions,
    score_case,
)
from agent.model import default_client  # noqa: E402
from agent.runtime_paths import artifact_dir  # noqa: E402

BENCH_OUT_DIR = artifact_dir() / "benchmark-results" / "bench"

# A neutral system prompt for the benchmark — not the Sophia operating harness.
# The production harness carries operating-contract instructions (tool protocol, OKF logging,
# source-discipline reminders) that are irrelevant to a prose-only knowledge
# Q&A and would unevenly affect models that weight system prompts differently.
# grok CLI overwrites its system slot regardless, and codex CLI receives the
# prompt as a positional arg with no system/message distinction, so a neutral
# prompt is also the most comparable choice across the CLI transports.
BENCH_SYSTEM = (
    "You are answering knowledge questions. Answer the user's question directly "
    "and concisely in one short paragraph. Do not refuse, do not ask clarifying "
    "questions, do not use tools."
)

# Throughput reporting: grok CLI and codex CLI subprocess transports return no
# token counts (codex fakes ``len(text)//4``). For those we report tok/s as
# null rather than a misleading number.
TRANSPORTS_WITHOUT_TOKEN_COUNTS = {"grok", "codex"}


# --------------------------------------------------------------------------- #
# Pure helpers (unit-tested)
# --------------------------------------------------------------------------- #
def slugify(models: list[str]) -> str:
    """Filename-safe slug from a model list, e.g. ['grok','qwen-coding'] -> 'grok+qwen-coding'."""
    return "+".join(m.replace("/", "_").replace(":", "-") for m in models)


def select_cases(domains: list[str], max_cases: int) -> list[tuple[str, dict]]:
    """Load cases for the given domains, capped at ``max_cases`` per domain.

    Returns a flat list of (domain, case) pairs.
    """
    out: list[tuple[str, dict]] = []
    for domain in domains:
        if domain not in DOMAIN_BENCH:
            raise ValueError(f"unknown corpus domain: {domain!r} (have {sorted(DOMAIN_BENCH)})")
        bench = load_benchmark(domain)
        cases = bench.get("cases", [])
        for case in cases[:max_cases]:
            out.append((domain, case))
    return out


def aggregate(per_case: list[dict[str, Any]]) -> dict[str, Any]:
    """Reduce a model's per-case rows to a scorecard row.

    Pure — takes the list of {passed, latency_s, completion_tokens, transport}
    dicts and returns {passed, total, score_pct, median_latency_s, mean_tok_s}.
    """
    total = len(per_case)
    passed = sum(1 for c in per_case if c.get("passed"))
    latencies = [c["latency_s"] for c in per_case if c.get("latency_s") is not None]
    median_lat = statistics.median(latencies) if latencies else None
    # tok/s only over cases that reported real token counts (excludes grok/codex CLI)
    tok_s_samples = [
        c["completion_tokens"] / c["latency_s"]
        for c in per_case
        if c.get("completion_tokens") and c.get("latency_s")
        and c.get("transport") not in TRANSPORTS_WITHOUT_TOKEN_COUNTS
        and c["latency_s"] > 0
    ]
    mean_tok_s = statistics.mean(tok_s_samples) if tok_s_samples else None
    cold_start = next((c["latency_s"] for c in per_case if c.get("is_cold_start")), None)
    return {
        "passed": passed,
        "total": total,
        "score_pct": round(passed / total, 4) if total else 0.0,
        "median_latency_s": round(median_lat, 3) if median_lat is not None else None,
        "mean_tok_s": round(mean_tok_s, 2) if mean_tok_s is not None else None,
        "cold_start_s": round(cold_start, 3) if cold_start is not None else None,
    }


def render_table(model_rows: list[dict[str, Any]], *, with_throughput: bool) -> str:
    """Render the comparison scorecard as a markdown table.

    Pure — takes the per-model aggregated rows (each with ``model`` + the
    ``aggregate()`` output) and returns the markdown string. Sorted by score.
    """
    rows = sorted(model_rows, key=lambda r: r.get("score_pct", 0), reverse=True)
    header = ["model", "passed", "score_pct"]
    if with_throughput:
        header += ["median_lat_s", "tok_s", "cold_start_s"]
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        def cell(v: Any) -> str:
            return "—" if v is None else str(v)
        line = [r["model"], f"{r['passed']}/{r['total']}", f"{r['score_pct']:.2f}"]
        if with_throughput:
            line += [cell(r.get("median_latency_s")), cell(r.get("mean_tok_s")), cell(r.get("cold_start_s"))]
        out.append("| " + " | ".join(line) + " |")
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #
def _run_one(
    client: Any,
    case: dict,
    *,
    is_cold_start: bool,
    timeout_label: str,
) -> dict[str, Any]:
    """Run one case through ``client.generate`` and score it.

    Returns a per-case row. Never raises — a transport failure becomes a
    ``{passed: False, error: ...}`` row so the benchmark continues.
    """
    question = case.get("question") or ""
    started = time.monotonic()
    try:
        res = client.generate(BENCH_SYSTEM, question)
    except Exception as exc:  # noqa: BLE001 - transport failures must not abort the bench
        latency = round(time.monotonic() - started, 3)
        return {"passed": False, "latency_s": latency, "completion_tokens": 0,
                "transport": timeout_label, "is_cold_start": is_cold_start,
                "error": f"{type(exc).__name__}: {exc}", "response": ""}
    latency = round(time.monotonic() - started, 3)
    text = getattr(res, "text", "") or ""
    if not getattr(res, "ok", True):
        return {"passed": False, "latency_s": latency,
                "completion_tokens": getattr(res, "completion_tokens", 0) or 0,
                "transport": timeout_label, "is_cold_start": is_cold_start,
                "error": getattr(res, "error", "unknown"), "response": text}
    return {"passed": True, "latency_s": latency,
            "completion_tokens": getattr(res, "completion_tokens", 0) or 0,
            "transport": timeout_label, "is_cold_start": is_cold_start,
            "error": None, "response": text, "_raw_result": res}


def run_model(
    spec: str,
    cases: list[tuple[str, dict]],
    traditions: dict,
    *,
    warmup: bool,
    progress_cb: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Run every case through one model. Returns the per-model result block.

    ``progress_cb`` (optional) is invoked once after each scored case with a
    small JSON-safe dict {model, case_idx, total, domain, case_id, passed,
    latency_s, reasons, is_cold_start}. The CLI leaves it ``None`` (its stderr
    progress prints are unaffected); the TUI bridge passes one to stream
    per-case bubbles live. Kept backward-compatible: no callback == old behaviour.
    """
    client = default_client(spec)
    transport_label = _transport_label(spec, client)
    # Warmup: one throwaway call so cold-start (model load / CLI spawn) is
    # measured separately, not folded into the first scored case's latency.
    cold_start_s: float | None = None
    if warmup and transport_label != "mock":
        started = time.monotonic()
        try:
            client.generate(BENCH_SYSTEM, "Ready? Reply with OK.")
        except Exception:  # noqa: BLE001 - warmup failure is reported but non-fatal
            pass
        cold_start_s = round(time.monotonic() - started, 3)

    per_case: list[dict[str, Any]] = []
    for idx, (domain, case) in enumerate(cases):
        row = _run_one(client, case, is_cold_start=(idx == 0 and cold_start_s is not None),
                       timeout_label=transport_label)
        # Score the response against the case's declarative constraints.
        if row.get("response"):
            passed, reasons = score_case(case, row["response"], traditions)
            row["passed"] = passed
            row["reasons"] = reasons
        else:
            row["reasons"] = [row.get("error") or "no response"]
        row["case_id"] = case.get("id")
        row["domain"] = domain
        # Persist the input prompt alongside the output so a report is
        # self-contained for the results dashboard (input vs. output, and
        # cross-model output comparison) without re-joining to the corpus.
        row["question"] = case.get("question")
        per_case.append(row)
        if progress_cb is not None:
            progress_cb({
                "model": spec,
                "case_idx": idx,
                "total": len(cases),
                "domain": domain,
                "case_id": case.get("id"),
                "passed": bool(row.get("passed")),
                "latency_s": row.get("latency_s"),
                "reasons": row.get("reasons", []),
                "is_cold_start": bool(row.get("is_cold_start", False)),
            })

    agg = aggregate(per_case)
    if cold_start_s is not None:
        agg["cold_start_s"] = cold_start_s
    return {
        "model": spec,
        "transport": transport_label,
        **agg,
        "cases": [
            {k: v for k, v in c.items() if k != "_raw_result"}
            for c in per_case
        ],
    }


def _transport_label(spec: str, client: Any) -> str:
    """Best-effort transport kind for the spec, for tok/s reporting decisions."""
    try:
        primary = getattr(client, "primary", None)
        if primary is not None:
            return getattr(primary, "kind", "unknown")
    except Exception:  # noqa: BLE001
        pass
    # Fall back to parsing the spec prefix.
    if spec.startswith(("mlx:", "ollama:", "vllm:")):
        return spec.split(":", 1)[0]
    if spec in {"grok", "grok-cli"}:
        return "grok"
    if spec.startswith("codex"):
        return "codex"
    return "unknown"


def smoke_probe(specs: list[str]) -> list[tuple[str, bool, str]]:
    """One throwaway call per model. Returns [(spec, ok, message)]."""
    out: list[tuple[str, bool, str]] = []
    for spec in specs:
        try:
            client = default_client(spec)
            res = client.generate(BENCH_SYSTEM, "Reply with OK.")
            ok = bool(getattr(res, "ok", False)) and bool(getattr(res, "text", "").strip())
            msg = "ready" if ok else (getattr(res, "error", None) or "empty response")
            out.append((spec, ok, msg))
        except Exception as exc:  # noqa: BLE001
            out.append((spec, False, f"{type(exc).__name__}: {exc}"))
    return out


# --------------------------------------------------------------------------- #
# Report (shared by the CLI and the TUI bridge)
# --------------------------------------------------------------------------- #
def build_report(
    model_rows: list[dict[str, Any]],
    *,
    corpus: str,
    domains: list[str],
    max_cases: int,
    models: list[str],
    warmup: bool,
) -> dict[str, Any]:
    """Assemble the candidate JSON report (pure — no I/O)."""
    return {
        "benchmark": "agent-bench-prose-v1",
        "version": 1,
        "runAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "corpus": corpus,
        "domains": domains,
        "maxCasesPerDomain": max_cases,
        "models": models,
        "warmup": warmup,
        "comparability": "prose-only-no-tools (grok/codex are CLI agents; qwen-coding/mlx/ollama/vllm are API/local — see --help)",
        "candidateOnly": True,
        "canClaimAGI": False,
        "results": {r["model"]: r for r in model_rows},
    }


def write_report(
    model_rows: list[dict[str, Any]],
    *,
    corpus: str,
    domains: list[str],
    max_cases: int,
    models: list[str],
    warmup: bool,
    out_dir: Path,
) -> Path:
    """Write the candidate JSON report and return its path.

    Shared by ``main()`` (the CLI) and ``code_bridge._handle_bench`` (the TUI)
    so both persist an identical report to ``agi-proof/benchmark-results/bench/``.
    """
    report = build_report(
        model_rows, corpus=corpus, domains=domains,
        max_cases=max_cases, models=models, warmup=warmup,
    )
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = out_dir / f"{slugify(models)}-{ts}.candidate.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return out_path


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _setup_hints(spec: str) -> str:
    """Per-backend setup hint when smoke fails (mirrors model.py error paths)."""
    if spec in {"grok", "grok-cli"}:
        return "grok CLI needs the `grok` binary on PATH (or GROK_BIN) and ~/.grok/auth.json (grok login)."
    if spec.startswith("codex"):
        return "codex CLI needs the `codex` binary (or SOPHIA_CODEX_BIN) and `codex login`."
    if spec == "qwen-coding":
        return "qwen-coding needs QWEN_API_KEY and the local proxy on 127.0.0.1:8789 running."
    if spec.startswith("vllm"):
        return "vllm preset needs a vLLM OpenAI server on 127.0.0.1:8000."
    if spec.startswith("ollama:"):
        return "ollama preset needs the ollama daemon running and the model pulled."
    if spec.startswith("mlx:"):
        return "mlx preset needs mlx-lm installed and the model cached."
    return f"could not configure {spec!r}."


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m agent.model_bench",
        description="Head-to-head benchmark across LLMs on the Sophia knowledge corpus.",
    )
    p.add_argument("--models", required=True,
                   help="Comma-separated model specs (presets): grok,qwen-coding,codex-5.6 "
                        "OR mlx:mlx-community/Qwen3.6-35B-A3B-4bit,ollama:qwen3:30b-a3b,vllm")
    p.add_argument("--corpus", default="knowledge",
                   help="Comma-separated domain names, or 'knowledge' for all 7, or 'tool-use' for "
                        "the S1-S6 tool-use capability benchmark (drives models through the real "
                        "tool loop). Have: philosophy,psychology,history,religion,personality,coding,math.")
    p.add_argument("--max-cases", type=int, default=20,
                   help="Cap cases per domain (default 20). Set high for full corpus.")
    p.add_argument("--out", type=Path,
                   default=BENCH_OUT_DIR,
                   help="Directory for the JSON report (default agi-proof/benchmark-results/bench/).")
    p.add_argument("--warmup", dest="warmup", action="store_true", default=True,
                   help="Do one throwaway call per model first so cold-start is measured "
                        "separately (default ON; recommended for local LLMs).")
    p.add_argument("--no-warmup", dest="warmup", action="store_false",
                   help="Disable warmup (first scored case includes cold-start latency).")
    p.add_argument("--smoke-only", action="store_true",
                   help="Only probe each model with one call to verify configuration; don't run cases.")
    p.add_argument("--skip-smoke", action="store_true",
                   help="Skip the configuration smoke probe (you've already verified setup).")
    args = p.parse_args(argv)

    specs = [s.strip() for s in args.models.split(",") if s.strip()]
    if not specs:
        p.error("--models is empty")

    # Tool-use capability benchmark (S1-S6 + speed): a distinct corpus that drives each
    # model through the REAL Sophia tool loop and scores with the sealed verifiers.
    # Delegate to the dedicated runner, which writes a dashboard-compatible report.
    if args.corpus in ("tool-use", "tooluse", "tools"):
        from tools import bench_tool_use  # lazy: only when tool-use is requested

        tu_argv = ["--models", ",".join(specs), "--max-cases", str(args.max_cases),
                   "--out", str(args.out)]
        if not args.warmup:
            tu_argv.append("--no-warmup")
        return bench_tool_use.main(tu_argv)

    domains = (
        sorted(DOMAIN_BENCH) if args.corpus == "knowledge"
        else [d.strip() for d in args.corpus.split(",") if d.strip()]
    )

    # Smoke probe (fail-closed, but does not abort — reports which are unconfigured).
    if not args.skip_smoke:
        print(f"# smoke probe: {len(specs)} model(s)...", file=sys.stderr)
        smokes = smoke_probe(specs)
        ready = [s for s, ok, _ in smokes if ok]
        failed = [(s, msg) for s, ok, msg in smokes if not ok]
        for spec, ok, msg in smokes:
            mark = "✓" if ok else "✗"
            print(f"  {mark} {spec}: {msg}", file=sys.stderr)
        if failed:
            print("\nNot all models are ready. Setup hints:", file=sys.stderr)
            for spec, _ in failed:
                print(f"  {spec}: {_setup_hints(spec)}", file=sys.stderr)
        if args.smoke_only:
            return 0 if not failed else 1
        if not ready:
            print("\nNo models ready; aborting. Fix setup and retry.", file=sys.stderr)
            return 1
        if failed:
            print(f"\nProceeding with the {len(ready)} ready model(s); "
                  f"skipping {len(failed)} unconfigured: {[s for s,_ in failed]}", file=sys.stderr)
            specs = ready

    cases = select_cases(domains, args.max_cases)
    traditions = load_traditions()
    print(f"\n# Benchmarking {len(specs)} model(s) x {len(cases)} case(s) "
          f"(corpus={args.corpus}, max_cases={args.max_cases})\n", file=sys.stderr)

    model_rows: list[dict[str, Any]] = []
    for spec in specs:
        print(f"  running {spec}...", file=sys.stderr, flush=True)
        row = run_model(spec, cases, traditions, warmup=args.warmup)
        model_rows.append(row)
        print(f"    -> {row['passed']}/{row['total']} ({row['score_pct']:.2f})", file=sys.stderr)

    # Throughput columns shown when ANY model reports tok/s OR cold_start
    with_throughput = any(r.get("mean_tok_s") is not None or r.get("cold_start_s") is not None
                          for r in model_rows)
    table = render_table(model_rows, with_throughput=with_throughput)
    print(table)
    if with_throughput:
        print("\n_Note: tok/s is null for grok/codex CLI transports (they don't report token counts); "
              "cold_start_s is the warmup-call latency (model load / CLI spawn)._")
    print("\n_Comparability: prose-only, no-tools. grok/codex-5.6 are CLI transports that run their "
          "own loops and ignore sampling knobs; qwen-coding is an API. Scores reflect the transport "
          "as configured, not pure model capability. For fair tool-use comparison, swap to the "
          "xai / codex-api presets. candidateOnly: true · canClaimAGI: false_")

    # Write JSON report.
    out_path = write_report(
        model_rows, corpus=args.corpus, domains=domains,
        max_cases=args.max_cases, models=specs, warmup=args.warmup, out_dir=args.out,
    )
    print(f"\n# report written: {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
