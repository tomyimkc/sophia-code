#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""GAIA runner for /gaia — feed GAIA questions through the Sophia agent loop,
score with the official scorer, aggregate per-level (the harness diagnostic).

GAIA is a pure dataset of {question, optional attached file, level, answer} + a
deterministic scorer. There is NO official runner with a fixed agent — we iterate
the validation split (165 questions, public answers), hand each question to
``run_agent_loop`` against the current model (oMLX), take the agent's final
string answer, and score it with the vendored official ``question_scorer``.

The diagnostic value is the PER-LEVEL breakdown: GAIA's 3 levels form a gradient
(single-step → multi-step chaining → long-horizon autonomy). A collapse from L1
to L2/L3 isolates WHERE the harness breaks — actionable harness work, not a model
IQ verdict. That gradient is what a flat pass@1 hides.

Anti-contamination (CRITICAL — official GAIA warning): GAIA questions are PUBLIC
but must NEVER enter training corpora. This runner:
  - loads the validation split at RUN TIME only (never committed);
  - NEVER persists questions, answers, or annotator steps to the repo;
  - writes only aggregate per-level rates + task_id pass/fail to the candidate
    report (no question text, no answer text).
  - the test split (private answers) is never scored locally.

candidateOnly: true · canClaimAGI: false — diagnostic tooling, not a result.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent import gaia_scorer  # noqa: E402

# The GAIA validation split only. Never score the test split locally — its answers
# are private (leaderboard-only); local scoring would silently produce nulls.
GAIA_SPLIT = "validation"
# Pinned dataset revision (per inspect_evals) so scoring is reproducible across
# runs — the scorer's normalization has changed before, which affects comparability.
GAIA_REVISION = "682dd723ee1e1697e00360edccf2366dc8418dd9"

# The prompt suffix enforcing the EXACT answer shape the scorer demands. Verbose
# answers fail the quasi-exact matcher (it strips punctuation/whitespace but a
# leading article or extra words will fail the string branch). This is paraphrased
# from inspect_evals DEFAULT_INPUT_PROMPT.
ANSWER_SHAPE_SUFFIX = (
    "\n\nReturn ONLY your final answer — a number, a short phrase with as few "
    "words as possible, or a comma-separated list. For a number, return only the "
    "number (no units like $ or % unless asked). For a phrase, do NOT include "
    "articles (a/an/the) or abbreviations. Put your final answer on the last line."
)

# Comparability caveat for the candidate report.
COMPARABILITY = "GAIA per-level diagnostic · local model · candidateOnly"


def load_dataset_rows(level: int | None = None) -> tuple[list[dict], Path]:
    """Load the GAIA validation split. Returns (rows, attached_files_dir).

    Requires `huggingface-cli login` with a token that has accepted GAIA's terms
    (gaia-benchmark/GAIA is gated). Raises a clear error if not authenticated —
    fail-closed rather than silently returning empty. ``level`` filters to one
    level (1/2/3); None = all levels.
    """
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "GAIA needs the `datasets` package: pip install datasets huggingface_hub, "
            "then `huggingface-cli login` (accept GAIA's terms on the dataset page first)."
        ) from exc

    config = "2023_all" if level is None else f"2023_level{level}"
    ds = load_dataset("gaia-benchmark/GAIA", config, split=GAIA_SPLIT,
                      revision=GAIA_REVISION, trust_remote_code=True)
    rows = []
    for r in ds:
        lvl_raw = r.get("Level")
        try:
            lvl = int(lvl_raw)
        except (TypeError, ValueError):
            lvl = 0
        rows.append({
            "task_id": str(r.get("task_id", "")),
            "question": str(r.get("Question", "")),
            "level": lvl,
            "answer": str(r.get("Final answer", "")),
            "file_name": str(r.get("file_name", "") or ""),
            "file_path": str(r.get("file_path", "") or ""),
        })
    return rows, Path(".")  # attached files: locate by task_id under the snapshot


def build_prompt(row: dict, files_dir: Path) -> str:
    """The agent-facing prompt for one GAIA question.

    Mentions the attached file (if any) so a file-capable agent opens it. NEVER
    includes the answer. The answer-shape suffix enforces the scorer's format.
    """
    q = row["question"].strip()
    prompt = q + ANSWER_SHAPE_SUFFIX
    fn = row.get("file_name", "").strip()
    if fn and fn not in ("", "-", "None"):
        prompt = (f"The following file is referenced by the question; you will likely "
                  f"need to read it: {fn} (locate it in the working directory).\n\n" + prompt)
    return prompt


def extract_final_answer(final_text: str) -> str:
    """Pull the candidate answer out of the agent's final text.

    The scorer is tolerant (strips punctuation/whitespace), so we take the last
    non-empty line — the answer-shape suffix asks the model to put the answer
    last. We do NOT parse aggressively; a wrong extraction is itself a harness
    signal (the model didn't isolate its answer).
    """
    if not final_text:
        return ""
    lines = [ln.strip() for ln in final_text.strip().splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def score_row(model_answer: str, row: dict) -> bool:
    """Score one answer against the row's ground truth using the official scorer."""
    return gaia_scorer.score_answer(model_answer, row["answer"])
