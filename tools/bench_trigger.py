#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""``/bench trigger`` — measure whether the model auto-triggers the right tool/skill.

The diagnostic the multibench work was missing: the other benchmarks measure tool
USE (provenance S1-S6) or long-horizon coherence, but NONE measure whether the
model RECOGNIZES when to call a tool/skill in the first place. This does: a sealed
set of intents, each with an expected tool (or None for negatives), run one short
turn through the model with surfacing ON, scored on trigger-rate, selection
accuracy, schema validity, over-trigger, and skill recall.

Mirrors ``bench_tool_use.py``'s live-model→native-tool_calls→scored shape but over
the surfaced MCP + skill surface instead of the provenance 3-tool set.

candidateOnly: true · canClaimAGI: false — methodology tooling.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent.trigger_cases import load_cases  # noqa: E402

COMPARABILITY = "local model diagnostic · candidateOnly"


# --------------------------------------------------------------------------- #
# Per-case scoring
# --------------------------------------------------------------------------- #
def score_case(case: dict, tool_calls: list[dict], exec_ok: dict | None) -> dict:
    """Score one case's model response.

    ``tool_calls`` is the list of tool calls the model made (name + args);
    ``exec_ok`` maps name→whether it executed validly (None = not executed).
    Returns a row with the trigger metrics for this case.
    """
    expected = case.get("expected")
    decision = case.get("decision")
    called = [str(tc.get("name", "")) for tc in tool_calls] if tool_calls else []
    called_any = len(called) > 0

    row = {
        "id": case["id"], "decision": decision, "expected": expected,
        "called": called, "called_any": called_any,
    }

    if decision == "no_tool":
        # negative case: must NOT call any tool
        row["trigger_correct"] = not called_any
        row["selection_correct"] = None
        row["schema_valid"] = None
        row["over_triggered"] = called_any
        return row

    # must_call: did it trigger at all? did it pick the RIGHT tool? valid args?
    row["trigger_correct"] = called_any
    if expected is None:
        row["selection_correct"] = None
    else:
        row["selection_correct"] = expected in called
    # schema validity: did the expected tool (if called) execute OK?
    if expected and expected in called and exec_ok is not None:
        row["schema_valid"] = bool(exec_ok.get(expected))
    else:
        row["schema_valid"] = None
    row["over_triggered"] = False
    # skill recall: for invoke_skill cases, did it name the right skill?
    if expected == "invoke_skill" and case.get("expected_skill"):
        expected_skill = case["expected_skill"]
        # look for invoke_skill with the right name arg
        row["skill_recall"] = any(
            tc.get("name") == "invoke_skill" and
            str(tc.get("args", {}).get("name", "")) == expected_skill
            for tc in tool_calls
        ) if tool_calls else False
    return row


# --------------------------------------------------------------------------- #
# Aggregate
# --------------------------------------------------------------------------- #
def aggregate(rows: list[dict]) -> dict[str, Any]:
    """Reduce per-case rows to the trigger-rate scorecard."""
    must = [r for r in rows if r["decision"] == "must_call"]
    negs = [r for r in rows if r["decision"] == "no_tool"]
    triggered = [r for r in must if r["trigger_correct"]]
    selected_right = [r for r in must if r["selection_correct"]]
    schema_ok = [r for r in must if r["schema_valid"] is True]
    over = [r for r in negs if r["over_triggered"]]
    skill_cases = [r for r in must if "skill_recall" in r]

    def _rate(num: int, den: int) -> float | None:
        return (num / den) if den else None

    return {
        "n": len(rows),
        "trigger_rate": _rate(len(triggered), len(must)),       # S1-analog
        "selection_accuracy": _rate(len(selected_right), len(triggered) or 1),  # S2-analog
        "schema_valid_rate": _rate(len(schema_ok), len([r for r in must if r["schema_valid"] is not None]) or 1),  # S3-analog
        "over_trigger": _rate(len(over), len(negs)),            # lower is better
        "skill_recall": _rate(sum(1 for r in skill_cases if r.get("skill_recall")), len(skill_cases) or 1),
    }


# --------------------------------------------------------------------------- #
# Diagnosis — interpret the rates as harness gaps
# --------------------------------------------------------------------------- #
def diagnose_trigger(agg: dict) -> list[str]:
    """Turn the trigger scorecard into named, fixable harness gaps.

    Each finding points at a concrete lever (the whenToUse text, tool-description
    overlap, trigger-condition tightness) — the spec-md levers your question was
    about. candidateOnly advisory.
    """
    findings: list[str] = []
    tr = agg.get("trigger_rate")
    sa = agg.get("selection_accuracy")
    ot = agg.get("over_trigger")
    sr = agg.get("skill_recall")

    def _p(x): return "—" if x is None else f"{int(x*100)}%"

    if tr is not None and tr < 0.60:
        findings.append(
            f"LOW trigger_rate ({_p(tr)}): the model often does NOT call a tool when it "
            "should. This is a RECOGNITION gap — the trigger-condition descriptions "
            "(whenToUse text / spec md) are not making the intent→tool match clear "
            "enough. Sharpen the whenToUse wording and add concrete trigger keywords."
        )
    if sa is not None and sa < 0.70 and (tr or 0) > 0:
        findings.append(
            f"LOW selection_accuracy ({_p(sa)}): the model triggers but picks the WRONG "
            "tool. This is a DISAMBIGUATION gap — tool descriptions overlap or are too "
            "generic. Differentiate the surfaced tools' descriptions so the right one is "
            "unambiguous for each intent."
        )
    if ot is not None and ot > 0.30:
        findings.append(
            f"HIGH over_trigger ({_p(ot)}): the model calls tools on plain questions that "
            "need no tool. This is a TIGHTNESS gap — the trigger conditions are too broad. "
            "Add more negative cases and tighten whenToUse to require a clear signal."
        )
    if sr is not None and sr < 0.50:
        findings.append(
            f"LOW skill_recall ({_p(sr)}): for skill-expected intents the model invokes a "
            "skill but names the wrong one (or none). The catalog's skill descriptions "
            "need sharper trigger keywords so the model maps intent→skill name correctly."
        )
    if not findings:
        findings.append(
            f"Trigger behavior looks balanced: trigger_rate={_p(tr)} · "
            f"selection={_p(sa)} · over_trigger={_p(ot)} · skill_recall={_p(sr)}. "
            "(This is a harness-health read, not a capability claim.)"
        )
    return findings


# --------------------------------------------------------------------------- #
# Live runner — drives the model one turn per case
# --------------------------------------------------------------------------- #
def run_model(model_spec: str, *, cases: list[dict] | None = None,
              surface_skills: bool = True, max_cases: int = 0,
              progress_cb: Callable[[dict], None] | None = None) -> dict[str, Any]:
    """Run the trigger benchmark against ``model_spec``. Returns the scorecard.

    Each case is one short model turn: send the intent + system prompt (with the
    surfaced tools + optional skill catalog), take the first tool_call (or none),
    score it. Cheap — a single generation per case.
    """
    import os
    from agent import model as _m
    from agent.agent_tools import all_tools, tool_function_schemas
    from agent.skill_catalog import catalog_system_extra

    if surface_skills:
        os.environ["SOPHIA_SURFACE_SKILLS"] = "1"
    cases = cases if cases is not None else load_cases(include_skills=surface_skills)
    if max_cases and max_cases > 0:
        cases = cases[:max_cases]

    client = _m.default_client(model_spec)
    # The surfaced native tool schemas (incl MCP tools + invoke_skill when on)
    native_tools = tool_function_schemas()
    catalog = catalog_system_extra()
    sys_prompt = (
        "You are a Sophia agent with provenance/safety/memory tools available. "
        "Call a tool ONLY when the user's intent clearly matches one; otherwise answer "
        "directly. Do not over-call." + (("\n\n" + catalog) if catalog else "")
    )

    rows: list[dict] = []
    for idx, case in enumerate(cases):
        t0 = time.time()
        tool_calls = []
        exec_ok: dict | None = {}
        try:
            messages = [{"role": "system", "content": sys_prompt},
                        {"role": "user", "content": case["intent"]}]
            res = client.generate_messages(messages, tools=native_tools)
            raw_calls = getattr(res, "tool_calls", None) or []
            for tc in raw_calls[:3]:  # cap at first 3 calls
                # Support both OpenAI nested {function:{name,args}} and
                # oMLX/OpenClaw flat {name, arguments} tool-call formats.
                if isinstance(tc, dict):
                    fn = tc.get("function")
                    if fn and isinstance(fn, dict):
                        name = fn.get("name", "")
                        raw_args = fn.get("arguments", {})
                    else:
                        name = tc.get("name", "")
                        raw_args = tc.get("arguments", {})
                else:
                    fn = getattr(tc, "function", None)
                    name = (getattr(fn, "name", "") if fn else "") or getattr(tc, "name", "")
                    raw_args = (getattr(fn, "arguments", {}) if fn else {}) or getattr(tc, "arguments", {})
                args = raw_args
                if isinstance(raw_args, str):
                    try:
                        args = json.loads(raw_args)
                    except Exception:
                        args = {"_raw": raw_args}
                tool_calls.append({"name": name, "args": args})
        except Exception:  # noqa: BLE001 — a model fault = no trigger for this case
            tool_calls = []

        row = score_case(case, tool_calls, exec_ok)
        row["latency_s"] = round(time.time() - t0, 2)
        rows.append(row)
        if progress_cb:
            progress_cb({"model": model_spec, "case_idx": idx, "total": len(cases),
                         "id": case["id"], "trigger_correct": row["trigger_correct"],
                         "selection_correct": row["selection_correct"],
                         "passed": row["trigger_correct"] and row.get("selection_correct", False),
                         "called": row.get("called", []),
                         "expected": case.get("expected"),
                         "latency_s": row.get("latency_s")})

    agg = aggregate(rows)
    agg["diagnosis"] = diagnose_trigger(agg)
    agg["rows"] = rows
    agg["model"] = model_spec

    # Persist failures to the durable JSONL store
    try:
        from agent.benchmark_failure_store import ingest_trigger_results
        run_id = f"trigger-{time.strftime('%Y%m%dT%H%M%S')}-{model_spec}"
        n_failures = ingest_trigger_results(run_id, model_spec, rows)
        agg["failures_recorded"] = n_failures
    except Exception:  # noqa: BLE001 — failure store is best-effort
        pass

    return agg


def write_report(result: dict[str, Any], out_dir: "Path | str | None" = None) -> "Path | None":
    """Persist trigger bench results as a candidate JSON report."""
    import json as _json
    from datetime import datetime, timezone
    from pathlib import Path

    if out_dir is None:
        out_dir = Path(__file__).resolve().parents[1] / "agi-proof" / "benchmark-results" / "bench"
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    model_slug = str(result.get("model", "unknown")).replace("/", "-").replace(" ", "-")
    out_path = out_dir / f"{model_slug}-trigger-{ts}.candidate.json"
    out_path.write_text(_json.dumps(result, ensure_ascii=False, indent=2, default=str),
                        encoding="utf-8")
    return out_path


def render_table(result: dict[str, Any]) -> str:
    """Markdown scorecard for the in-chat result bubble."""
    def _p(x): return "—" if x is None else f"{int(x*100)}%"
    a = result
    lines = [
        "## Trigger benchmark (intent → right tool)",
        f"**trigger_rate** (called something when it should): {_p(a.get('trigger_rate'))}",
        f"**selection_accuracy** (called the RIGHT tool): {_p(a.get('selection_accuracy'))}",
        f"**schema_valid** (args valid + executed): {_p(a.get('schema_valid_rate'))}",
        f"**over_trigger** (called a tool on a plain question — lower better): {_p(a.get('over_trigger'))}",
        f"**skill_recall** (named the right skill): {_p(a.get('skill_recall'))}",
        f"**n**: {a.get('n')} cases ({sum(1 for r in a.get('rows',[]) if r['decision']=='must_call')} must-call, "
        f"{sum(1 for r in a.get('rows',[]) if r['decision']=='no_tool')} no-tool)",
        "",
    ]
    if a.get("diagnosis"):
        lines.append("### Harness-weakness diagnosis")
        for f in a["diagnosis"]:
            lines.append(f"- {f}")

    # Append per-case failure prompt log (copyable for AI-assisted fixing)
    n_fail = a.get("failures_recorded", 0)
    if n_fail:
        try:
            from agent.benchmark_failure_store import render_failure_prompt_log
            prompt_log = render_failure_prompt_log(benchmark="trigger")
            if prompt_log and prompt_log != "No failures recorded.":
                lines.append("")
                lines.append("### Failure prompt log (copy to AI for fixing)")
                lines.append("```")
                lines.append(prompt_log)
                lines.append("```")
        except Exception:  # noqa: BLE001
            pass

    return "\n".join(lines)
