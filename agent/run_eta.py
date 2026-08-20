# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""History-backed, secret-free full-run ETA estimates.

Sophia's durable ``run_finished`` receipts already provide the only reliable
cross-provider definition of completion.  This module uses those receipts to
estimate a new run's total wall time without inspecting prompts, answers, tool
arguments, or provider payloads.

The estimate is deliberately conservative:

* only root runs are sampled (supervised ``-wf-``/``-a2a-`` workers are
  excluded);
* the same orchestration mode is preferred;
* a bounded cross-mode fallback is low-confidence;
* very short fixture/mock receipts and implausibly long records are ignored;
* the median is used so one provider timeout does not dominate the panel.
"""

from __future__ import annotations

import json
import statistics
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from agent.runtime_paths import user_state_dir


MIN_SAMPLE_SEC = 5.0
MAX_SAMPLE_SEC = 12 * 60 * 60.0
DEFAULT_SAMPLE_LIMIT = 24
DEFAULT_SCAN_LIMIT = 500


@dataclass(frozen=True)
class RunDurationEstimate:
    """One bounded estimate suitable for a public lifecycle receipt."""

    total_sec: float
    sample_count: int
    confidence: str
    basis: str
    mode: str


def normalize_run_mode(value: Any) -> str:
    """Collapse internal variants into stable ETA history buckets."""
    mode = str(value or "solo").strip().lower()
    if mode.startswith("agi"):
        return "agi"
    if mode in {"workflow", "a2a", "team"}:
        return mode
    return "solo"


def _parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _first_event_time(path: Path) -> datetime | None:
    try:
        with path.open("r", encoding="utf-8") as stream:
            for raw in stream:
                try:
                    event = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if not isinstance(event, dict):
                    continue
                timestamp = _parse_time(
                    event.get("ts")
                    or event.get("updatedAt")
                    or event.get("endedAt")
                )
                if timestamp is not None:
                    return timestamp
    except OSError:
        return None
    return None


def _receipt_duration(path: Path, payload: dict[str, Any]) -> float | None:
    explicit = payload.get("durationSec")
    if isinstance(explicit, (int, float)) and not isinstance(explicit, bool):
        duration = float(explicit)
    else:
        ended = _parse_time(payload.get("endedAt"))
        started = _parse_time(payload.get("startedAt"))
        if started is None:
            started = _first_event_time(path.with_name("events.jsonl"))
        if started is None or ended is None:
            return None
        duration = (ended - started).total_seconds()
    if duration < MIN_SAMPLE_SEC or duration > MAX_SAMPLE_SEC:
        return None
    return duration


def _is_root_session(session: str) -> bool:
    lowered = str(session or "").lower()
    return "-wf-" not in lowered and "-a2a-" not in lowered


def _recent_receipts(
    root: Path,
    *,
    scan_limit: int,
) -> Iterable[tuple[Path, dict[str, Any], float]]:
    try:
        paths = sorted(
            root.glob("*/*/finished.json"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )[:scan_limit]
    except OSError:
        return ()
    rows: list[tuple[Path, dict[str, Any], float]] = []
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        if payload.get("ok") is not True:
            continue
        duration = _receipt_duration(path, payload)
        if duration is None or not _is_root_session(str(payload.get("session") or "")):
            continue
        rows.append((path, payload, duration))
    return rows


def _confidence(sample_count: int, *, exact_mode: bool) -> str:
    if exact_mode and sample_count >= 7:
        return "high"
    if exact_mode and sample_count >= 3:
        return "medium"
    return "low"


def estimate_run_duration(
    mode: str,
    *,
    state_dir: Path | None = None,
    sample_limit: int = DEFAULT_SAMPLE_LIMIT,
    scan_limit: int = DEFAULT_SCAN_LIMIT,
    exclude_run_id: str = "",
    minimum_total_sec: float | None = None,
) -> RunDurationEstimate | None:
    """Estimate total wall time from recent durable terminal receipts.

    Same-mode history is authoritative when available.  A new mode with no
    samples gets a low-confidence median of other root runs rather than a
    fabricated constant, so the TUI can still communicate an approximate full
    session duration while clearly labelling the basis.  When provided,
    ``minimum_total_sec`` excludes candidates at or below the elapsed threshold.
    """

    normalized = normalize_run_mode(mode)
    root = (state_dir or user_state_dir()).expanduser().resolve() / "agent_runs"
    rows = [
        row
        for row in _recent_receipts(root, scan_limit=max(1, scan_limit))
        if str(row[1].get("runId") or "") != str(exclude_run_id or "")
    ]
    if minimum_total_sec is not None:
        rows = [row for row in rows if row[2] > minimum_total_sec]
    exact = [
        duration
        for _, payload, duration in rows
        if normalize_run_mode(payload.get("mode")) == normalized
    ][: max(1, sample_limit)]
    values = exact
    exact_mode = bool(exact)
    if not values:
        values = [duration for _, _, duration in rows][: max(1, sample_limit)]
    if not values:
        return None
    total = float(statistics.median(values))
    count = len(values)
    basis = (
        f"median of {count} recent {normalized} run"
        f"{'' if count == 1 else 's'}"
        if exact_mode
        else (
            f"median of {count} recent root run"
            f"{'' if count == 1 else 's'} · cross-mode fallback"
        )
    )
    return RunDurationEstimate(
        total_sec=total,
        sample_count=count,
        confidence=_confidence(count, exact_mode=exact_mode),
        basis=basis,
        mode=normalized,
    )


__all__ = [
    "RunDurationEstimate",
    "estimate_run_duration",
    "normalize_run_mode",
]
