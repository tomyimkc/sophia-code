# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Benchmark failure store — durable JSONL accumulator with per-case
categorization, fix tracking, and OKF gap-node bridge.

Every benchmark run (trigger, tool-use, tbench, knowledge) appends per-case
failures to ``~/.sophia/benchmark_failures.jsonl``.  Each failure is tagged
with a category (recognition_gap, disambiguation_gap, schema_error,
grounding_failure, over_trigger, skill_recall_gap, docker_deferred) and an
optional suggested fix.  A closed-loop ``mark_fix_applied`` /
``mark_fix_verified`` cycle tracks whether fixes actually resolved the failure.

The OKF bridge (``write_okf_gaps``) converts unresolved failures into gap
nodes compatible with ``okf/gap_nodes.py``.

candidateOnly; canClaimAGI:false.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from agent.runtime_paths import user_state_dir

_DEFAULT_STORE = str(user_state_dir() / "benchmark_failures.jsonl")

# --------------------------------------------------------------------------- #
# Failure categories
# --------------------------------------------------------------------------- #
RECOGNITION_GAP = "recognition_gap"           # model didn't trigger any tool
DISAMBIGUATION_GAP = "disambiguation_gap"     # triggered wrong tool
SCHEMA_ERROR = "schema_error"                 # right tool, invalid args
GROUNDING_FAILURE = "grounding_failure"       # right tool, ignored results
OVER_TRIGGER = "over_trigger"                 # called tool when it shouldn't
SKILL_RECALL_GAP = "skill_recall_gap"         # invoke_skill but wrong skill name
DOCKER_DEFERRED = "docker_deferred"           # task needs container, not scored
HARNESS_ERROR = "harness_error"               # benchmark infrastructure fault

ALL_CATEGORIES = frozenset({
    RECOGNITION_GAP, DISAMBIGUATION_GAP, SCHEMA_ERROR, GROUNDING_FAILURE,
    OVER_TRIGGER, SKILL_RECALL_GAP, DOCKER_DEFERRED, HARNESS_ERROR,
})


# --------------------------------------------------------------------------- #
# Failure record
# --------------------------------------------------------------------------- #
@dataclass
class FailureRecord:
    run_id: str
    benchmark: str              # trigger | tool_use | tbench | knowledge
    case_id: str
    model: str
    category: str               # one of ALL_CATEGORIES
    expected: str = ""          # expected tool / outcome
    actual: list[str] = field(default_factory=list)  # actual tool calls
    diagnosis: str = ""         # human-readable explanation
    suggested_fix: str = ""     # actionable fix
    fix_applied: str | None = None    # ISO date or None
    fix_verified: bool | None = None  # True/False/None
    latency_s: float = 0.0
    timestamp: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.timestamp:
            self.timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --------------------------------------------------------------------------- #
# Categorizer — maps per-case bench results to failure categories
# --------------------------------------------------------------------------- #
def categorize_trigger_case(row: dict) -> str | None:
    """Categorize a trigger bench case. Returns None if the case passed."""
    if row.get("trigger_correct") and row.get("selection_correct"):
        return None  # passed
    decision = row.get("decision", "must_call")
    if decision == "no_tool":
        if row.get("over_triggered"):
            return OVER_TRIGGER
        return None
    # must_call
    if not row.get("called_any"):
        return RECOGNITION_GAP
    if not row.get("selection_correct"):
        expected = row.get("expected", "")
        if expected == "invoke_skill" and not row.get("skill_recall"):
            return SKILL_RECALL_GAP
        return DISAMBIGUATION_GAP
    if not row.get("schema_valid"):
        return SCHEMA_ERROR
    return None


def categorize_tool_use_case(row: dict) -> str | None:
    """Categorize a tool-use bench case. Returns None if the case passed."""
    if row.get("passed"):
        return None
    skills = row.get("skills") or {}
    if not skills.get("S1_decision"):
        return RECOGNITION_GAP
    if not skills.get("S2_selection"):
        return DISAMBIGUATION_GAP
    if not skills.get("S3_schema"):
        return SCHEMA_ERROR
    if not skills.get("S4_grounding"):
        return GROUNDING_FAILURE
    if row.get("over_call"):
        return OVER_TRIGGER
    return HARNESS_ERROR


def categorize_tbench_case(row: dict) -> str | None:
    """Categorize a tbench case. Returns None if passed."""
    if row.get("passed") is True:
        return None
    if row.get("deferred") or row.get("passed") is None:
        return DOCKER_DEFERRED
    return HARNESS_ERROR


# --------------------------------------------------------------------------- #
# Suggested fix generator
# --------------------------------------------------------------------------- #
_SUGGESTED_FIXES: dict[str, str] = {
    RECOGNITION_GAP: "Sharpen tool description with explicit trigger keywords; check system prompt surfaces the tool",
    DISAMBIGUATION_GAP: "Add negative hints to competing tool descriptions (e.g. 'NOT for X — use Y instead')",
    SCHEMA_ERROR: "Check tool schema matches model's output format; add examples to description",
    GROUNDING_FAILURE: "Model ignores tool results — add 'base your answer ONLY on the tool output' to system prompt",
    OVER_TRIGGER: "Tighten tool description scope; add 'do NOT use for plain questions' hint",
    SKILL_RECALL_GAP: "Sharpen skill catalog descriptions with intent-matching keywords",
    DOCKER_DEFERRED: "Run with /tbench docker for faithful container scoring",
    HARNESS_ERROR: "Investigate benchmark infrastructure — not a model problem",
}


def suggest_fix(category: str, row: dict) -> str:
    base = _SUGGESTED_FIXES.get(category, "Investigate manually")
    expected = row.get("expected", "")
    actual = row.get("called", [])
    if category == DISAMBIGUATION_GAP and expected and actual:
        return f"Model called {actual} instead of {expected}. {base}"
    return base


# --------------------------------------------------------------------------- #
# JSONL store
# --------------------------------------------------------------------------- #
def _store_path() -> str:
    return os.environ.get("SOPHIA_BENCH_FAILURE_DB", _DEFAULT_STORE)


def append_failures(records: list[FailureRecord]) -> int:
    """Append failure records to the JSONL store. Returns count written."""
    if not records:
        return 0
    path = Path(_store_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(asdict(r), ensure_ascii=False) + "\n")
    return len(records)


def load_failures(*, benchmark: str | None = None,
                  category: str | None = None,
                  unresolved_only: bool = False) -> list[FailureRecord]:
    """Load failures from the store with optional filters."""
    path = Path(_store_path())
    if not path.exists():
        return []
    records: list[FailureRecord] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            d = json.loads(line)
            r = FailureRecord(**{k: v for k, v in d.items() if k in FailureRecord.__dataclass_fields__})
            if benchmark and r.benchmark != benchmark:
                continue
            if category and r.category != category:
                continue
            if unresolved_only and r.fix_verified is True:
                continue
            records.append(r)
        except (json.JSONDecodeError, TypeError):
            continue
    return records


def mark_fix_applied(case_id: str, benchmark: str, *, fix_note: str = "") -> int:
    """Mark all unresolved failures for a case as fix-applied. Returns count."""
    return _update_records(case_id, benchmark, {"fix_applied": time.strftime("%Y-%m-%d"), 
                                                  "diagnosis": fix_note or "fix applied"})


def mark_fix_verified(case_id: str, benchmark: str, *, verified: bool = True) -> int:
    """Mark fix verification status. Returns count."""
    return _update_records(case_id, benchmark, {"fix_verified": verified})


def _update_records(case_id: str, benchmark: str, updates: dict) -> int:
    path = Path(_store_path())
    if not path.exists():
        return 0
    lines = path.read_text(encoding="utf-8").splitlines()
    count = 0
    new_lines: list[str] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            d = json.loads(line)
            if d.get("case_id") == case_id and d.get("benchmark") == benchmark and d.get("fix_verified") is not True:
                d.update(updates)
                count += 1
            new_lines.append(json.dumps(d, ensure_ascii=False))
        except (json.JSONDecodeError, TypeError):
            new_lines.append(line)
    path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    return count


# --------------------------------------------------------------------------- #
# Convenience: ingest bench results directly
# --------------------------------------------------------------------------- #
def ingest_trigger_results(run_id: str, model: str, rows: list[dict]) -> int:
    """Ingest trigger bench rows, appending categorized failures."""
    records: list[FailureRecord] = []
    for row in rows:
        cat = categorize_trigger_case(row)
        if cat is None:
            continue
        records.append(FailureRecord(
            run_id=run_id, benchmark="trigger", case_id=row.get("id", ""),
            model=model, category=cat,
            expected=str(row.get("expected", "")),
            actual=row.get("called", []),
            diagnosis=f"trigger={'✓' if row.get('trigger_correct') else '✗'} "
                      f"select={'✓' if row.get('selection_correct') else '✗'} "
                      f"called={row.get('called', [])}",
            suggested_fix=suggest_fix(cat, row),
            latency_s=row.get("latency_s", 0.0),
        ))
    return append_failures(records)


def ingest_tool_use_results(run_id: str, model: str, rows: list[dict]) -> int:
    """Ingest tool-use bench rows, appending categorized failures."""
    records: list[FailureRecord] = []
    for row in rows:
        cat = categorize_tool_use_case(row)
        if cat is None:
            continue
        records.append(FailureRecord(
            run_id=run_id, benchmark="tool_use", case_id=row.get("case_id", ""),
            model=model, category=cat,
            expected=row.get("domain", ""),
            actual=[tc.get("name", "") for tc in (row.get("tool_calls") or [])],
            diagnosis="; ".join(row.get("reasons", [])),
            suggested_fix=suggest_fix(cat, row),
            latency_s=row.get("latency_s", 0.0),
        ))
    return append_failures(records)


def ingest_tbench_results(run_id: str, model: str, rows: list[dict]) -> int:
    """Ingest tbench rows, appending categorized failures."""
    records: list[FailureRecord] = []
    for row in rows:
        cat = categorize_tbench_case(row)
        if cat is None:
            continue
        records.append(FailureRecord(
            run_id=run_id, benchmark="tbench", case_id=row.get("task", row.get("case_id", "")),
            model=model, category=cat,
            diagnosis=row.get("reason", ""),
            suggested_fix=suggest_fix(cat, row),
            latency_s=row.get("latency_s", 0.0),
        ))
    return append_failures(records)


# --------------------------------------------------------------------------- #
# OKF gap-node bridge
# --------------------------------------------------------------------------- #
def write_okf_gaps(*, unresolved_only: bool = True) -> list[dict]:
    """Convert unresolved failures into OKF-compatible gap nodes.

    Returns a list of gap-node dicts compatible with ``okf/gap_nodes.py``.
    Each gap node represents a recurring failure pattern (grouped by
    category + case_id) that the ontology should track.
    """
    failures = load_failures(unresolved_only=unresolved_only)
    # group by (benchmark, case_id) to find recurring failures
    groups: dict[tuple[str, str], list[FailureRecord]] = {}
    for f in failures:
        key = (f.benchmark, f.case_id)
        groups.setdefault(key, []).append(f)

    gaps: list[dict] = []
    for (benchmark, case_id), recs in groups.items():
        categories = {r.category for r in recs}
        gaps.append({
            "id": f"bench-gap-{benchmark}-{case_id}",
            "pageType": "gap",
            "title": f"Benchmark gap: {case_id} ({benchmark})",
            "domain": "methodology",
            "categories": sorted(categories),
            "occurrences": len(recs),
            "models_affected": sorted({r.model for r in recs}),
            "latest_diagnosis": recs[-1].diagnosis,
            "suggested_fix": recs[-1].suggested_fix,
            "fix_applied": recs[-1].fix_applied,
            "fix_verified": recs[-1].fix_verified,
            "first_seen": recs[0].timestamp,
            "last_seen": recs[-1].timestamp,
            "candidateOnly": True,
            "canClaimAGI": False,
        })
    return gaps


# --------------------------------------------------------------------------- #
# Summary report
# --------------------------------------------------------------------------- #
def summary_report() -> str:
    """Human-readable summary of all stored failures."""
    failures = load_failures()
    if not failures:
        return "No benchmark failures recorded."
    by_cat: dict[str, int] = {}
    by_bench: dict[str, int] = {}
    unresolved = 0
    for f in failures:
        by_cat[f.category] = by_cat.get(f.category, 0) + 1
        by_bench[f.benchmark] = by_bench.get(f.benchmark, 0) + 1
        if f.fix_verified is not True:
            unresolved += 1
    lines = [
        f"Benchmark Failure Store: {len(failures)} total, {unresolved} unresolved",
        "",
        "By category:",
    ]
    for cat, n in sorted(by_cat.items(), key=lambda x: -x[1]):
        lines.append(f"  {cat}: {n}")
    lines.append("")
    lines.append("By benchmark:")
    for bench, n in sorted(by_bench.items(), key=lambda x: -x[1]):
        lines.append(f"  {bench}: {n}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Failure prompt log — copyable per-case report for AI-assisted fixing
# --------------------------------------------------------------------------- #
def render_failure_prompt_log(run_id: str | None = None,
                              benchmark: str | None = None) -> str:
    """Render a self-contained, copyable prompt log of failures.

    The output is designed to be pasted into an AI chat session so the
    AI can diagnose and fix each failure without prior context.
    """
    failures = load_failures(benchmark=benchmark)
    if run_id:
        failures = [f for f in failures if f.run_id == run_id]
    if not failures:
        return "No failures recorded."

    lines = [
        "# Benchmark Failure Log — copy this to your AI for fixing",
        f"# Run: {run_id or 'all'} | Benchmark: {benchmark or 'all'}",
        f"# Total failures: {len(failures)}",
        "",
    ]
    for i, f in enumerate(failures, 1):
        status = "FIXED" if f.fix_verified else ("FIX APPLIED" if f.fix_applied else "OPEN")
        lines.append(f"## Failure {i}: {f.case_id} [{status}]")
        lines.append(f"- **Benchmark:** {f.benchmark}")
        lines.append(f"- **Model:** {f.model}")
        lines.append(f"- **Category:** {f.category}")
        lines.append(f"- **Expected:** {f.expected or '(none)'}")
        lines.append(f"- **Actual:** {f.actual or '(no tool called)'}")
        lines.append(f"- **Diagnosis:** {f.diagnosis}")
        lines.append(f"- **Suggested fix:** {f.suggested_fix}")
        lines.append(f"- **Latency:** {f.latency_s}s")
        lines.append(f"- **Timestamp:** {f.timestamp}")
        if f.fix_applied:
            lines.append(f"- **Fix applied:** {f.fix_applied}")
        if f.fix_verified is not None:
            lines.append(f"- **Fix verified:** {f.fix_verified}")
        lines.append("")
        lines.append(f"**Prompt:** Fix the {f.category} for benchmark case "
                     f"'{f.case_id}' in {f.benchmark}. "
                     f"The model {'called ' + str(f.actual) + ' instead of ' + f.expected if f.actual else 'did not call any tool when it should have called ' + f.expected}. "
                     f"{f.suggested_fix}")
        lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# OKF process log — write a run page per benchmark execution
# --------------------------------------------------------------------------- #
def write_okf_process_log(run_id: str, benchmark: str, model: str,
                          scorecard: str, n_failures: int) -> "Path | None":
    """Write an OKF process log entry for a benchmark run.

    Creates ``.claude/okf-process-log/run_bench_<benchmark>_<date>.md``
    with structured frontmatter and failure summary.
    """
    from pathlib import Path

    log_dir = Path(__file__).resolve().parents[1] / ".claude" / "okf-process-log"
    if not log_dir.is_dir():
        return None  # OKF log dir not present in this checkout

    date_str = time.strftime("%Y%m%d")
    slug = f"run_bench_{benchmark}_{date_str}"
    page_path = log_dir / f"{slug}.md"

    failures = load_failures(benchmark=benchmark)
    run_failures = [f for f in failures if f.run_id == run_id] if run_id else failures

    content = f"""---
id: {slug}
pageType: memory
sources: ["sophia-tui/benchmark"]
mode: benchmark
task: "{benchmark} benchmark run"
status: {"failed" if n_failures > 0 else "done"}
model: "{model}"
candidateOnly: true
canClaimAGI: false
---

## Goal
Run {benchmark} benchmark on {model} and record results.

## Outcome
{n_failures} failure(s) out of the run.

## Scorecard
{scorecard}

## Failures
"""
    if run_failures:
        for f in run_failures:
            content += f"- **{f.case_id}** [{f.category}]: {f.diagnosis}\n"
            content += f"  - Fix: {f.suggested_fix}\n"
    else:
        content += "None — all cases passed.\n"

    content += f"\n## Lessons\n"
    content += f"Run ID: {run_id}. See `~/.sophia/benchmark_failures.jsonl` for full details.\n"

    try:
        page_path.write_text(content, encoding="utf-8")
        return page_path
    except Exception:  # noqa: BLE001
        return None
