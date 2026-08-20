# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""ArkDistill — deterministic, offline, profile-based compaction of *noisy tool
output* before it enters the agent's trace log or context window.

Distilled from AgentArk's ArkDistill idea, rebuilt in pure Python to the Sophia
discipline:

  * **deterministic** — same ``(text, profile)`` in ⇒ byte-identical text out (no
    model, no network, no randomness). Golden-file testable.
  * **offline** — pure regex + slicing; reuses the bilingual token heuristic from
    :mod:`agent.context_manager` for accounting (no tokenizer download).
  * **fail-open-to-original** — if a profile errors *or* would not actually shrink
    the text, the ORIGINAL text is returned unchanged. ArkDistill can make a tool
    output smaller; it can never lose signal by expanding or corrupting it.
  * **claim-blind** — this compacts *tool noise only* (HTML, logs, traces, JSON
    dumps). Model claims and provenance NEVER flow through here, so it cannot
    affect the provenance gate or the fabrication metric.

Compaction is *auditable*: every result carries ``saved_tokens``, ``ratio``, and
an ``elision`` marker naming how much was removed and by which profile.

Public API:
    >>> from agent.arkdistill import distill, profile_for, load_profiles
    >>> d = distill(noisy_html, profile_for("browser_open", noisy_html))
    >>> d["compacted"], d["saved_tokens"], d["ratio"]
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from agent.context_manager import estimate_tokens

_PROFILES_PATH = Path(__file__).with_name("arkdistill_profiles.json")

# Baked-in fallback so import never fails if the JSON is missing/corrupt
# (fail-open): a single conservative profile that only strips control noise.
_FALLBACK_PROFILES: dict[str, dict] = {
    "generic": {
        "summary": "fallback: strip control chars, collapse blanks, head+tail",
        "strip_patterns": [r"\x1b\[[0-9;]*[A-Za-z]", r"\r"],
        "collapse_blank_lines": True,
        "max_repeat_lines": 3,
        "head_lines": 60,
        "tail_lines": 40,
        "keep_json_fields": [],
    }
}


@dataclass(frozen=True)
class Profile:
    """A deterministic compaction recipe for one class of noisy tool output."""

    name: str
    summary: str = ""
    strip_patterns: tuple[str, ...] = ()
    collapse_blank_lines: bool = True
    max_repeat_lines: int = 0  # collapse runs of >N identical lines (0 = off)
    head_lines: int = 60
    tail_lines: int = 40
    keep_json_fields: tuple[str, ...] = ()

    @property
    def _compiled(self) -> "list[re.Pattern[str]]":
        # Compiled lazily and cached on the frozen instance via the module cache
        # below; kept out of the dataclass so the profile stays hashable/serialisable.
        return _compiled_patterns(self.strip_patterns)


# Compile cache keyed by the pattern tuple (regex compilation is the only
# non-trivial cost; profiles are few and reused across every tool call).
_COMPILE_CACHE: dict[tuple[str, ...], list[re.Pattern[str]]] = {}


def _compiled_patterns(patterns: tuple[str, ...]) -> "list[re.Pattern[str]]":
    cached = _COMPILE_CACHE.get(patterns)
    if cached is None:
        cached = []
        for pat in patterns:
            try:
                cached.append(re.compile(pat))
            except re.error:
                # A malformed profile pattern is skipped, never fatal (fail-open).
                continue
        _COMPILE_CACHE[patterns] = cached
    return cached


def load_profiles(path: Path | None = None) -> dict[str, Profile]:
    """Load profiles from the committed JSON (canonical), falling back to a baked-in
    conservative profile if the file is missing or invalid. Never raises."""
    raw: dict[str, dict]
    try:
        doc = json.loads((path or _PROFILES_PATH).read_text(encoding="utf-8"))
        raw = doc.get("profiles") or {}
        if not isinstance(raw, dict) or not raw:
            raw = _FALLBACK_PROFILES
    except Exception:
        raw = _FALLBACK_PROFILES
    out: dict[str, Profile] = {}
    for name, spec in raw.items():
        if not isinstance(spec, dict):
            continue
        out[name] = Profile(
            name=name,
            summary=str(spec.get("summary", "")),
            strip_patterns=tuple(spec.get("strip_patterns", []) or ()),
            collapse_blank_lines=bool(spec.get("collapse_blank_lines", True)),
            max_repeat_lines=int(spec.get("max_repeat_lines", 0) or 0),
            head_lines=int(spec.get("head_lines", 60) or 60),
            tail_lines=int(spec.get("tail_lines", 40) or 40),
            keep_json_fields=tuple(spec.get("keep_json_fields", []) or ()),
        )
    # _FALLBACK_PROFILES always parses, so ``out`` is non-empty here; the guard is
    # belt-and-suspenders for a future profile spec that is entirely non-dict.
    return out or {"generic": Profile(name="generic", strip_patterns=(r"\x1b\[[0-9;]*[A-Za-z]", r"\r"))}


# Loaded once at import (cheap, deterministic). Reload via load_profiles() in tests.
PROFILES: dict[str, Profile] = load_profiles()


# --------------------------------------------------------------------------- #
# Profile selection (heuristic, deterministic)
# --------------------------------------------------------------------------- #

_HTML_RE = re.compile(r"<\s*(html|body|div|span|table|a|p|script|head)\b", re.IGNORECASE)
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}", re.MULTILINE)

# Tool-name → profile hints (substring match, longest hint wins for determinism).
_TOOL_HINTS: tuple[tuple[str, str], ...] = (
    ("browser", "browser_html"),
    ("fetch", "browser_html"),
    ("http", "browser_html"),
    ("web", "browser_html"),
    ("log", "log_dump"),
    ("ci", "log_dump"),
    ("build", "log_dump"),
    ("run", "tool_trace"),
    ("exec", "tool_trace"),
    ("shell", "tool_trace"),
    ("trace", "tool_trace"),
)


def _looks_json(text: str) -> bool:
    s = text.strip()
    if not (s.startswith("{") and s.endswith("}")) and not (s.startswith("[") and s.endswith("]")):
        return False
    try:
        json.loads(s)
        return True
    except Exception:
        return False


def profile_for(tool_name: str | None = None, text: str = "") -> Profile:
    """Pick the best profile for ``tool_name`` and/or ``text`` content.

    Content sniffing wins for JSON/HTML (unambiguous structure); otherwise the
    tool name hints; otherwise ``generic``. Always returns a valid Profile.
    """
    profiles = PROFILES
    fallback = profiles.get("generic") or next(iter(profiles.values()))

    if text and _looks_json(text) and "json_response" in profiles:
        return profiles["json_response"]
    if text and _HTML_RE.search(text) and "browser_html" in profiles:
        return profiles["browser_html"]

    name = (tool_name or "").lower()
    best: tuple[int, str] | None = None
    for hint, prof in _TOOL_HINTS:
        if hint in name and prof in profiles:
            score = len(hint)
            if best is None or score > best[0]:
                best = (score, prof)
    if best is not None:
        return profiles[best[1]]

    if text and (_ANSI_RE.search(text) or _TS_RE.search(text)) and "log_dump" in profiles:
        return profiles["log_dump"]
    return fallback


# --------------------------------------------------------------------------- #
# Core compaction (deterministic)
# --------------------------------------------------------------------------- #


def _strip(text: str, profile: Profile) -> str:
    for pat in profile._compiled:
        text = pat.sub("", text)
    return text


def _collapse_repeats(lines: list[str], max_repeat: int) -> list[str]:
    """Collapse runs of >``max_repeat`` identical lines into the line plus a marker."""
    if max_repeat <= 0:
        return lines
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        j = i
        while j < n and lines[j] == lines[i]:
            j += 1
        run = j - i
        if run > max_repeat:
            out.extend([lines[i]] * max_repeat)
            out.append(f"…[arkdistill: {run - max_repeat} more identical lines]…")
        else:
            out.extend(lines[i:j])
        i = j
    return out


def _head_tail(lines: list[str], head: int, tail: int) -> tuple[list[str], int]:
    """Keep ``head`` first + ``tail`` last lines; return (lines, elided_count)."""
    if len(lines) <= head + tail:
        return lines, 0
    elided = len(lines) - head - tail
    kept = lines[:head] + [f"…[arkdistill: elided {elided} middle lines]…"] + (lines[-tail:] if tail else [])
    return kept, elided


def _compact_json(text: str, profile: Profile) -> str | None:
    """If ``text`` is JSON and the profile names keep-fields, project to the kept
    fields (compact, sorted keys). Returns None to fall through to line handling."""
    if not profile.keep_json_fields or not _looks_json(text):
        return None
    try:
        doc = json.loads(text)
    except Exception:
        return None
    keep = set(profile.keep_json_fields)

    def project(obj):
        if isinstance(obj, dict):
            kept = {k: obj[k] for k in obj if k in keep}
            return kept if kept else obj  # nothing matched → keep object as-is
        if isinstance(obj, list):
            return [project(x) for x in obj]
        return obj

    projected = project(doc)
    # Compact separators remove pretty-print whitespace; sort_keys for determinism.
    return json.dumps(projected, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


@dataclass
class DistillResult:
    compacted: str
    before_tokens: int
    after_tokens: int
    saved_tokens: int
    ratio: float
    profile: str
    elision: str = ""
    applied: bool = True

    def to_dict(self) -> dict:
        return {
            "compacted": self.compacted,
            "before_tokens": self.before_tokens,
            "after_tokens": self.after_tokens,
            "saved_tokens": self.saved_tokens,
            "ratio": self.ratio,
            "profile": self.profile,
            "elision": self.elision,
            "applied": self.applied,
        }


def distill(text: str, profile: Profile | str | None = None) -> dict:
    """Compact noisy ``text`` with ``profile`` (a Profile, a profile name, or None
    to auto-select). Returns a dict (see :class:`DistillResult`).

    Fail-open: on ANY error, or if compaction would not shrink the text, the
    original is returned unchanged with ``applied=False`` and ``saved_tokens=0``.
    Deterministic: same input + profile ⇒ byte-identical ``compacted``.
    """
    if not isinstance(text, str):
        text = str(text)
    before = estimate_tokens(text)

    if isinstance(profile, str):
        profile = PROFILES.get(profile) or profile_for(None, text)
    elif profile is None:
        profile = profile_for(None, text)

    original = text
    try:
        # 1) Structured JSON projection (if applicable) short-circuits line work.
        json_out = _compact_json(text, profile)
        if json_out is not None:
            body = json_out
        else:
            # 2) Strip configured noise patterns.
            stripped = _strip(text, profile)
            lines = stripped.split("\n")
            # 3) Collapse blank-line runs.
            if profile.collapse_blank_lines:
                collapsed: list[str] = []
                blank = False
                for ln in lines:
                    is_blank = ln.strip() == ""
                    if is_blank and blank:
                        continue
                    collapsed.append("" if is_blank else ln)
                    blank = is_blank
                lines = collapsed
            # 4) Collapse repeated identical lines.
            lines = _collapse_repeats(lines, profile.max_repeat_lines)
            # 5) Head+tail elision of the middle.
            lines, _elided = _head_tail(lines, profile.head_lines, profile.tail_lines)
            body = "\n".join(lines).strip("\n")
    except Exception:
        # Fail-open: never lose signal on a profile bug.
        return DistillResult(
            compacted=original, before_tokens=before, after_tokens=before,
            saved_tokens=0, ratio=0.0, profile=getattr(profile, "name", "generic"),
            elision="", applied=False,
        ).to_dict()

    after = estimate_tokens(body)
    # Never expand: if the profile didn't actually save tokens, keep the original.
    if after >= before:
        return DistillResult(
            compacted=original, before_tokens=before, after_tokens=before,
            saved_tokens=0, ratio=0.0, profile=profile.name, elision="", applied=False,
        ).to_dict()

    saved = before - after
    ratio = round(saved / before, 4) if before else 0.0
    elision = f"[arkdistill:{profile.name} −{saved} tok ({int(ratio * 100)}%)]"
    return DistillResult(
        compacted=body, before_tokens=before, after_tokens=after,
        saved_tokens=saved, ratio=ratio, profile=profile.name, elision=elision,
        applied=True,
    ).to_dict()


def distill_tool_result(result: dict, *, field: str = "output") -> dict:
    """Return a SHALLOW COPY of a harness tool-result dict with its noisy text
    ``field`` distilled, plus an ``arkdistill`` accounting sub-dict. The original
    dict (used for the ``ok`` pass/fail check) is never mutated, so the gate path
    stays byte-identical. ``ok`` and all other fields are preserved verbatim.
    """
    if not isinstance(result, dict) or field not in result or not isinstance(result.get(field), str):
        return result
    tool = str(result.get("tool", ""))
    d = distill(result[field], profile_for(tool, result[field]))
    if not d["applied"]:
        return result
    clone = dict(result)
    clone[field] = d["compacted"]
    clone["arkdistill"] = {
        "profile": d["profile"],
        "saved_tokens": d["saved_tokens"],
        "ratio": d["ratio"],
        "before_tokens": d["before_tokens"],
        "after_tokens": d["after_tokens"],
    }
    return clone
