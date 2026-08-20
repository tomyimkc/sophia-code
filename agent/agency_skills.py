# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Resolve bounded discipline skills for agency-agent team lanes.

The agency catalogue supplies a static, curated baseline per specialist.  The
existing Layer B skill router may add relevant disciplines for the concrete
lane goal, but only after registry ids are mapped to this small allowlist.
Every failure preserves the static baseline and never blocks dispatch.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from agent.config import ROOT


PORTED_SKILL_IDS = frozenset(
    {
        "grilling",
        "research",
    }
)

# Canonical ids are stable at the agency index boundary even when the existing
# repo skill has a more specific on-disk name.
CANONICAL_SKILL_PATHS: dict[str, tuple[Path, ...]] = {
    "tdd": (
        ROOT / ".claude" / "skills" / "tdd-loop" / "SKILL.md",
        ROOT / "skills" / "portable" / "skill-lift-kaggle" / "tdd-loop" / "SKILL.md",
    ),
    # This repo has no standalone .claude/skills/code-review file. Reuse the
    # existing verification discipline instead of creating a duplicate.
    "code-review": (
        ROOT / ".agents" / "skills" / "pr-merge-verification" / "SKILL.md",
    ),
    # These methods were already adapted into Sophia's Layer B registry before
    # this integration. Reuse their canonical specs rather than vendoring a
    # second SKILL.md that would drift independently.
    "diagnosing-bugs": (
        ROOT / "skills" / "registry" / "coding-debugging.json",
    ),
    "codebase-design": (
        ROOT / "skills" / "registry" / "codebase-design.json",
    ),
    "domain-modeling": (
        ROOT / "skills" / "registry" / "domain-modeling.json",
    ),
    "prototype": (
        ROOT / "skills" / "registry" / "prototype-throwaway.json",
    ),
    **{
        skill_id: (
            ROOT / "agent" / "agency_skills" / skill_id / "SKILL.md",
        )
        for skill_id in PORTED_SKILL_IDS
    },
}

ALLOWED_SUBAGENT_DISCIPLINES = frozenset(CANONICAL_SKILL_PATHS)
FORBIDDEN_SUBAGENT_SKILLS = frozenset(
    {
        "ask-matt",
        "grill-me",
        "grill-the-plan",
        "grill-with-docs",
        "handoff",
        "implement",
        "resolving-merge-conflicts",
        "setup-matt-pocock-skills",
        "teach",
        "to-questionnaire",
        "to-spec",
        "to-tickets",
        "triage",
        "wait-what",
        "wayfinder",
        "writing-great-skills",
    }
)
REGISTRY_TO_CANONICAL: dict[str, str] = {
    "codebase-design": "codebase-design",
    "coding-debugging": "diagnosing-bugs",
    "domain-modeling": "domain-modeling",
    "grilling": "grilling",
    "prototype-throwaway": "prototype",
    "research-rag": "research",
    "source-verification": "research",
    "tdd-implementation": "tdd",
}
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})


def _offline() -> bool:
    return str(os.environ.get("OFFLINE", "")).strip().casefold() in _TRUE_VALUES


def resolve_skill_path(skill_id: str) -> Path | None:
    """Return the first readable path for one canonical discipline id."""
    for candidate in CANONICAL_SKILL_PATHS.get(str(skill_id), ()):
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def resolvable_skill_ids() -> frozenset[str]:
    """Canonical ids whose configured skill body is present in this checkout."""
    return frozenset(
        skill_id
        for skill_id in CANONICAL_SKILL_PATHS
        if resolve_skill_path(skill_id) is not None
    )


def _canonical_skill_id(value: str) -> str:
    skill_id = str(value or "").strip()
    canonical = REGISTRY_TO_CANONICAL.get(skill_id, skill_id)
    if canonical in FORBIDDEN_SUBAGENT_SKILLS:
        return ""
    if canonical not in ALLOWED_SUBAGENT_DISCIPLINES:
        return ""
    if resolve_skill_path(canonical) is None:
        return ""
    return canonical


def _ranked_skill_rows(goal: str) -> list[dict[str, Any]]:
    """Thin seam around the existing Layer B router for deterministic tests."""
    from agent.skills import select_ranked

    return select_ranked(str(goal or ""), top_k=3, min_score=1.0)


def resolve_lane_skills(
    lane_goal: str,
    static_skills: Iterable[str],
) -> list[str]:
    """Union the curated baseline with relevant Layer B skill results.

    Static order is preserved so a lane's known discipline baseline remains
    stable. Dynamic matches are appended only when they map to a resolvable,
    non-orchestration canonical id. Offline mode and every router failure use
    the static list alone.
    """
    resolved: list[str] = []
    for value in static_skills:
        canonical = _canonical_skill_id(str(value))
        if canonical and canonical not in resolved:
            resolved.append(canonical)

    # An empty static baseline is an intentional division boundary, not router
    # uncertainty. In particular, sales/marketing/finance/healthcare/support
    # specialists must not acquire coding disciplines from fuzzy goal matches.
    if not resolved:
        return []
    if _offline() or not str(lane_goal or "").strip():
        return resolved

    try:
        ranked = _ranked_skill_rows(lane_goal)
    except Exception:
        return resolved
    for row in ranked:
        skill = row.get("skill") if isinstance(row, dict) else None
        registry_id = (
            str(skill.get("name", ""))
            if isinstance(skill, dict)
            else ""
        )
        canonical = _canonical_skill_id(registry_id)
        if canonical and canonical not in resolved:
            resolved.append(canonical)
    return resolved


def _strip_frontmatter(text: str) -> str:
    if not text.startswith("---\n"):
        return text.strip()
    end = text.find("\n---", 4)
    if end < 0:
        return text.strip()
    return text[end + 4 :].lstrip("\n").strip()


def _render_registry_skill(path: Path) -> str:
    """Render an existing Layer B JSON skill as prompt-ready Markdown."""
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return ""
    if not isinstance(spec, dict):
        return ""

    title = str(spec.get("name") or path.stem).replace("-", " ").title()
    chunks = [f"# {title}"]
    when = str(spec.get("whenToUse") or "").strip()
    if when:
        chunks.extend(["## When to use", when])

    section_fields = (
        ("Workflow", "workflow"),
        ("Verification", "verification"),
        ("Common failures", "commonFailures"),
    )
    for heading, field in section_fields:
        values = spec.get(field)
        if not isinstance(values, list) or not values:
            continue
        lines = [f"{idx}. {str(value).strip()}" for idx, value in enumerate(values, 1)]
        chunks.extend([f"## {heading}", "\n".join(lines)])

    io_schema = spec.get("ioSchema")
    if isinstance(io_schema, dict) and io_schema:
        chunks.extend(
            [
                "## I/O contract",
                "```json\n"
                + json.dumps(io_schema, ensure_ascii=False, indent=2, sort_keys=True)
                + "\n```",
            ]
        )

    examples = spec.get("examples")
    if isinstance(examples, list) and examples:
        chunks.extend(
            [
                "## Examples",
                "```json\n"
                + json.dumps(examples, ensure_ascii=False, indent=2, sort_keys=True)
                + "\n```",
            ]
        )
    return "\n\n".join(chunks).strip()


@lru_cache(maxsize=None)
def load_skill_body(skill_id: str) -> str:
    """Load one discipline body lazily and cache it by canonical id."""
    canonical = _canonical_skill_id(skill_id)
    path = resolve_skill_path(canonical) if canonical else None
    if path is None:
        return ""
    if path.suffix.casefold() == ".json":
        return _render_registry_skill(path)
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return ""
    # A git-crypt ciphertext or binary file must never be injected as prompt
    # guidance. Ordinary Markdown will not contain NUL bytes.
    if "\x00" in raw or raw.startswith("\x00GITCRYPT"):
        return ""
    return _strip_frontmatter(raw)


def render_lane_disciplines(skill_ids: Iterable[str]) -> str:
    """Render full discipline bodies for one lane, or an empty string."""
    chunks: list[str] = []
    seen: set[str] = set()
    for value in skill_ids:
        canonical = _canonical_skill_id(str(value))
        if not canonical or canonical in seen:
            continue
        seen.add(canonical)
        body = load_skill_body(canonical)
        if body:
            chunks.append(f"## {canonical}\n\n{body}")
    return "\n\n---\n\n".join(chunks)


__all__ = [
    "ALLOWED_SUBAGENT_DISCIPLINES",
    "CANONICAL_SKILL_PATHS",
    "FORBIDDEN_SUBAGENT_SKILLS",
    "PORTED_SKILL_IDS",
    "load_skill_body",
    "render_lane_disciplines",
    "resolvable_skill_ids",
    "resolve_lane_skills",
    "resolve_skill_path",
]
