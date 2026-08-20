#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Failure-reflection pass for ``/tbench`` — closes the OKF fix-capture gap.

The Sophia agent loop already auto-records every run as an OKF ``run_*.md`` page
and appends a ``FAILURES.md`` row on failure (``agent/sophia_harness.py``:
``write_process_log``, called from ``agent/agent_loop.py``). It also already
injects those failures into the NEXT run's system prompt as
``## Anti-repeat memory`` (``failure_recall_system_extra``), parsing the page's
``## Lessons`` section verbatim.

The gap: when a task FAILS, ``## Lessons`` is written as ``_(none yet)_`` — the
run is already dead, nobody reflects. So the anti-repeat memory that the next run
receives carries the *error* but not the *fix*. Recall stays low-signal.

This module closes that gap with a single, bounded, fail-honest reflection call:

1. ``reflect_on_failure`` — make ONE model call (oMLX) over the task prompt, the
   recorded errors, and the failing tool args, asking for a structured root-cause
   + concrete fix. Bounded: max 1 call. Fail-honest: if the model cannot produce
   a grounded fix from the evidence, we record "unclear — needs human review"
   rather than hallucinate a plausible-sounding repair (which would be worse than
   no lesson — it would mislead the next run).
2. ``write_back_lesson`` — rewrite the just-written page's ``## Lessons`` section
   with the structured ``**Why:**`` / ``**How to apply:**`` block, and patch the
   matching ``FAILURES.md`` row's ``**lessons:**`` line so BOTH read paths
   (``recall_process_logs`` and the FAILURES head) carry the high-signal fix.

Net effect: the next ``/tbench`` (or any agent) run on a similar task receives a
real, grounded ``How to apply`` in its anti-repeat memory instead of an empty
lessons stub — "save it so we don't make the same mistake again", implemented as
a write-back onto the existing OKF substrate rather than a parallel store.

candidateOnly: true · canClaimAGI: false. Reflections are advisory memory, never
a capability claim; a reflection that was not independently verified is marked as
such (``confidence: low``) and never asserted as proven.
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


# --------------------------------------------------------------------------- #
# Reflection client protocol (decoupled from the model transport)
# --------------------------------------------------------------------------- #
class _ReflectClient(Protocol):
    """Minimal model-call interface ``reflect_on_failure`` needs.

        generate(prompt: str, *, max_tokens: int) -> str

    Any callable with this shape works — the OpenAI/oMLX client, a mock for
    tests, or a no-op that returns "" (which yields an honest "unclear" lesson).
    """

    def generate(self, prompt: str, *, max_tokens: int = ...) -> str:
        """Return the model's completion for ``prompt``, capped at ``max_tokens``."""


@dataclass(frozen=True)
class Reflection:
    """A parsed reflection. ``why``/``how`` are empty when the model could not
    produce a grounded fix — the caller records that honestly as "unclear"."""

    why: str       # root cause
    how: str       # concrete fix / how to apply next time
    confidence: str  # "low" unless the evidence was concrete
    raw: str       # the model's full response (for the trace)


# The reflection prompt is deliberately narrow and evidence-bound. It must NOT:
#   - see the task's tests/solution (contamination);
#   - be invited to speculate beyond the recorded errors;
#   - produce more than a short structured block (cost + latency bound).
_REFLECT_INSTRUCTION = (
    "You are diagnosing a FAILED terminal task run. Below are: the task the agent "
    "was given, the errors the loop recorded, and the last tool calls that failed. "
    "Produce a SHORT root-cause analysis. Be concrete and grounded in the evidence "
    "shown — do NOT invent details you cannot see.\n\n"
    "Reply in EXACTLY this format and nothing else:\n"
    "WHY: <one or two sentences: the concrete root cause, grounded in the errors>\n"
    "HOW: <one or two sentences: the concrete fix or next-time approach>\n\n"
    "If the evidence is insufficient to determine a real cause, write:\n"
    "WHY: unclear\n"
    "HOW: needs human review — evidence insufficient to auto-diagnose"
)

# Token budget for the reflection call. Bounded so a failing task never costs
# more than one short generation on top of the run itself.
_REFLECT_MAX_TOKENS = 256


def reflect_on_failure(
    task_prompt: str,
    errors: list[dict[str, Any]],
    failing_tools: list[dict[str, Any]],
    client: Any,
    *,
    max_tokens: int = _REFLECT_MAX_TOKENS,
    timeout_note: str = "",
) -> Reflection:
    """One bounded reflection call. Returns a :class:`Reflection`.

    ``errors`` and ``failing_tools`` are the loop's recorded structures (the same
    shape ``write_process_log`` consumes). ``client`` is anything with a
    ``generate(prompt, *, max_tokens)`` method; pass a mock in tests. The call is
    wrapped so any transport fault degrades to an honest "unclear" reflection
    rather than crashing the sweep — a failed reflection must never break the run.
    """
    # Cap the evidence so the prompt stays tiny even for a long failing trace.
    err_blob = json.dumps(errors[:6], default=str, ensure_ascii=False)[:1200] if errors else "_(no structured errors recorded)_"
    tools_blob = json.dumps(failing_tools[:4], default=str, ensure_ascii=False)[:800] if failing_tools else "_(none)_"

    prompt = (
        f"{_REFLECT_INSTRUCTION}\n\n"
        f"### Task (what the agent was asked to do)\n{task_prompt[:1500]}\n\n"
        f"### Recorded errors\n{err_blob}\n\n"
        f"### Last failing tool calls\n{tools_blob}\n"
    )
    if timeout_note:
        prompt += f"\n### Run note\n{timeout_note[:200]}\n"

    raw = ""
    try:
        out = client.generate(prompt, max_tokens=max_tokens)
        raw = out if isinstance(out, str) else str(out)
    except Exception:  # noqa: BLE001 — a transport fault yields "unclear", not a crash
        return Reflection(why="", how="", confidence="low", raw="(reflection call failed)")

    why, how = _parse_reflection(raw)
    # confidence is "low" unless BOTH fields are concrete and non-fallback.
    fallback = (not why) or (not how) or why.strip().lower().startswith("unclear")
    conf = "low" if fallback else "low"  # advisory memory is never "verified"
    return Reflection(why=why, how=how, confidence=conf, raw=raw)


def _parse_reflection(raw: str) -> tuple[str, str]:
    """Extract WHY / HOW lines from the model response.

    Tolerant of leading whitespace, mixed case, and the model wrapping the block
    in markdown fences. Returns ``("", "")`` if neither marker is present — the
    caller treats that as "unclear".
    """
    text = raw.strip()
    # strip code fences if the model wrapped the block
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    why = ""
    how = ""
    for line in text.splitlines():
        stripped = line.strip()
        # Accept "WHY:" or "WHY -" separators, but only consume up to the first
        # separator — never split on dashes inside the content (a fix legitimately
        # contains CLI flags like "--force"). The regex captures the marker only.
        m_why = re.match(r"^why\s*[:\-]\s*(.*)$", stripped, re.IGNORECASE)
        m_how = re.match(r"^how\s*[:\-]\s*(.*)$", stripped, re.IGNORECASE)
        if not why and m_why:
            why = m_why.group(1).strip()
        elif not how and m_how:
            how = m_how.group(1).strip()
    return why, how


def render_lesson(refl: Reflection) -> str:
    """Render a reflection into the OKF ``## Lessons`` body format.

    Matches the existing convention: a ``**Why:**`` line (root cause) and a
    ``**How to apply:**`` line (fix), which is exactly what ``recall_process_logs``
    surfaces into the next run's anti-repeat memory. An ungrounded reflection is
    recorded honestly as "unclear", never dressed up as a proven fix.
    """
    why = refl.why.strip() or "unclear — evidence was insufficient to auto-diagnose"
    how = refl.how.strip() or "needs human review"
    note = " _(advisory auto-reflection, not independently verified)_" if refl.confidence == "low" else ""
    return (
        f"**Why:** {why}{note}\n"
        f"**How to apply:** {how}"
    )


# --------------------------------------------------------------------------- #
# Write-back onto the OKF page + FAILURES.md row
# --------------------------------------------------------------------------- #
def find_page_for_goal(log_dir: str | Path, goal: str) -> Path | None:
    """Find the most-recent OKF page for ``goal`` under ``log_dir``.

    ``process_log_id`` embeds a high-resolution nonce (``time_ns`` + pid + uuid) so
    a caller CANNOT re-derive the exact page filename a run just wrote. We instead
    glob by the stable slug prefix (``run_<slug>_<date>_`` — the nonce is the only
    variable tail) and return the newest match. This is how the fix-capture pass
    locates the page the loop wrote, without coupling to the loop's internal id.

    Returns ``None`` if no page matches (e.g. the run was a clean success and the
    caller is looking in the wrong dir, or the goal slug is empty).
    """
    import glob

    d = Path(log_dir)
    if not d.is_dir():
        return None
    # process_log_id(goal) = run_<slug>_<YYYYMMDD>_<nonce>. The slug + date are
    # deterministic; only the nonce varies. Glob by the stable middle and pick
    # newest by mtime (the page we want is the one just written for THIS goal).
    from agent.sophia_harness import _slugify, process_log_id  # noqa: WPS433

    sample = process_log_id(goal)
    day = sample.split("_")[-2] if "_" in sample else ""  # YYYYMMDD
    slug = _slugify(goal)
    candidates = sorted(
        d.glob(f"run_{slug}_{day}_*.md"),
        key=lambda p: p.stat().st_mtime if p.exists() else 0,
        reverse=True,
    )
    return candidates[0] if candidates else None


def write_back_lesson(page_path: str | Path, refl: Reflection) -> bool:
    """Rewrite the ``## Lessons`` section of an existing OKF page in place.

    Idempotent: if the page already carries a non-stub lesson (not
    ``_(none yet)_`` / ``_(none)_``), the write-back is skipped so a repeated
    reflection never clobbers an earlier, possibly human-authored lesson. Returns
    ``True`` if the page was updated.

    The page is rewritten atomically (temp + ``os.replace``), matching
    ``write_process_log``'s own atomic-write discipline so a concurrent run never
    sees a half-written page.
    """
    import os
    import uuid

    p = Path(page_path)
    if not p.is_file():
        return False
    text = p.read_text(encoding="utf-8")
    if "## Lessons" not in text:
        return False
    head, rest = text.split("## Lessons", 1)
    # rest looks like "\n\n_(none yet)_\n" possibly followed by nothing (Lessons
    # is the last section). Drop everything after the Lessons header up to EOF or
    # the next section marker.
    new_lessons = render_lesson(refl)
    # Idempotency guard: keep an existing concrete lesson.
    existing = rest.strip()
    if existing and not re.match(r"^_\(none", existing):
        return False
    rebuilt = head.rstrip("\n") + "\n\n## Lessons\n\n" + new_lessons + "\n"
    tmp = p.with_name(f".{p.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(rebuilt, encoding="utf-8")
    os.replace(tmp, p)
    return True


def patch_failures_lesson(failures_path: str | Path, page_id: str, refl: Reflection) -> bool:
    """Update the ``**lessons:**`` line of the ``page_id`` row in FAILURES.md.

    ``failure_recall_system_extra`` reads the FAILURES.md head as the primary
    anti-repeat block, so a lesson that only lives on the page (and not the row)
    can be missed when the ledger head is what gets injected. Patching the row
    keeps both read paths consistent. No-op (returns False) if the row or file
    is absent — the page write-back is the source of truth.
    """
    import os
    import uuid

    fp = Path(failures_path)
    if not fp.is_file():
        return False
    text = fp.read_text(encoding="utf-8")
    if page_id not in text:
        return False
    new_lessons = render_lesson(refl).replace("\n", " ")
    # A row block looks like: "## <stamp> · `page_id`\n\n- **goal:** ...\n ... - **lessons:** <text>\n\n"
    # Replace the single **lessons:** line that belongs to this page_id's block.
    pattern = re.compile(
        r"(## [^\n]*· `[ \t]*" + re.escape(page_id) + r"[ \t]*`[\s\S]*?\*\*lessons:\*\*)[^\n]*",
    )

    def _repl(m: re.Match) -> str:
        return m.group(1) + " " + new_lessons[:400]

    new_text, n = pattern.subn(_repl, text, count=1)
    if not n:
        return False
    tmp = fp.with_name(f".{fp.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(tmp, fp)
    return True
