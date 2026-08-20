# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Memory consolidation: episodic agent-run logs -> semantic OKF wiki pages.

This is the continual-learning step that makes Sophia stateful: a verified agent
run's conclusion is folded into a provenance-gated memory page, so run N+1 can
recall it at plan time instead of re-deriving it. Crucially the SAME source-
discipline gate applies — an answer that merged a lineage is never consolidated,
so growing memory never means accumulating contamination.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from agent import wiki_store
from agent.config import MEMORY_DIR

RUNS_DIR = MEMORY_DIR / "agent_runs"


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    return slug[:48] or "memory"


def consolidate_result(goal: str, final_text: str, *, task_id: "str | None" = None,
                       mode: str = "advisor", tier: str = "memory") -> dict:
    """Fold one finished answer into a gated memory page. Returns upsert result."""
    if not final_text.strip():
        return {"ok": False, "rejected": True, "reasons": ["empty final text"]}
    page_id = "mem_" + slugify(task_id or goal)
    body = (
        f"# Memory: {goal}\n\n"
        f"{final_text.strip()[:4000]}\n\n"
        f"_Consolidated from an agent run (mode={mode}); provenance-gated semantic memory._"
    )
    meta = {"pageType": "memory", "sources": [f"agent_runs/{task_id or slugify(goal)}"], "mode": mode}
    return wiki_store.upsert(page_id, meta=meta, body=body, tier=tier)


def _read_run(path: Path) -> dict:
    events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    start = next((e for e in events if e.get("type") == "task_start"), {})
    passed_outputs = [e.get("output", "") for e in events if e.get("type") == "step_output" and e.get("passed")]
    return {"goal": start.get("goal", ""), "mode": start.get("mode", "advisor"),
            "taskId": start.get("taskId") or path.stem, "final": passed_outputs[-1] if passed_outputs else ""}


def _benchmark_questions() -> set:
    from agent.benchmark_checks import DOMAIN_BENCH, load_json

    questions: set = set()
    for path in DOMAIN_BENCH.values():
        if path.exists():
            for case in load_json(path).get("cases", []):
                q = str(case.get("question", "")).strip().lower()
                if q:
                    questions.add(q)
    return questions


def consolidate_runs(runs_dir: Path = RUNS_DIR, *, deleak: bool = True, tier: str = "memory") -> dict:
    """Fold every verified run in runs_dir into memory pages (benchmark-leak guarded)."""
    if not runs_dir.exists():
        return {"ok": True, "consolidated": 0, "rejected": 0, "leakedSkipped": 0, "runs": 0}
    holdout = _benchmark_questions() if deleak else set()
    consolidated = rejected = leaked = runs = 0
    rejections: list = []
    for path in sorted(runs_dir.glob("*.jsonl")):
        run = _read_run(path)
        if not run["goal"] or not run["final"]:
            continue
        runs += 1
        if deleak and run["goal"].strip().lower() in holdout:
            leaked += 1
            continue
        result = consolidate_result(run["goal"], run["final"], task_id=run["taskId"], mode=run["mode"], tier=tier)
        if result.get("ok"):
            consolidated += 1
        else:
            rejected += 1
            rejections.append({"goal": run["goal"][:60], "reasons": result.get("reasons", [])})
    return {"ok": True, "runs": runs, "consolidated": consolidated, "rejected": rejected,
            "leakedSkipped": leaked, "rejections": rejections}
