# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Sophia Code product edition: ``oss`` (public coding CLI) vs ``full`` (owner TUI).

One source tree, two surfaces. New slash/kernel features are tagged here so the
public slice stays a filter, not a fork. Packaging only; ``canClaimAGI`` stays
false.
"""
from __future__ import annotations

import os
from pathlib import Path

EDITION_OSS = "oss"
EDITION_FULL = "full"
EDITION_IDS: tuple[str, ...] = (EDITION_OSS, EDITION_FULL)

#: Baked default for a checkout. Export writes ``oss`` into this file; the
#: sophia-agi tree leaves it absent so the default stays ``full``.
_DEFAULT_FILE = Path(__file__).resolve().parent / "_edition_default.txt"

#: Canonical slash names that must not appear in the open-edition catalog or
#: TUI picker. Aliases resolve to these names, so hiding the canonical name
#: hides ``/ultra``, ``/provenance``, etc.
FULL_ONLY_COMMANDS: frozenset[str] = frozenset(
    {
        "a2a",
        "agents",
        "agi",
        "agi-workflow",
        "arc",
        "conscience",
        "contract",
        "effort",
        "gaia",
        "goal",
        "graph",
        "panel",
        "tasks",
        "taubench",
        "tbench",
        "terminals",
        "thesis",
        "ultramode",
        "workflow",
        "workflows",
    }
)

#: Python modules / path prefixes omitted from the public export and never
#: imported at module top-level by the open-edition kernel.
FULL_ONLY_MODULE_PREFIXES: tuple[str, ...] = (
    "agent.a2a",
    "agent.agi_mode",
    "agent.agi_workflow",
    "agent.compound_workflow",
    "agent.conscience",
    "agent.dynamic_workflow",
    "agent.flowchart_workflow",
    "agent.goal_harness",
    "agent.got",
    "agent.ssil",
    "agent.swarm_router",
    "agent.tbench",
)

#: Path prefixes (posix, relative to repo root) omitted from the public export.
FULL_ONLY_PATH_PREFIXES: tuple[str, ...] = (
    "agent/a2a",
    "agent/agi_mode",
    "agent/agi_workflow",
    "agent/compound_workflow",
    "agent/conscience",
    "agent/dynamic_workflow",
    "agent/flowchart_workflow",
    "agent/goal_harness",
    "agent/got",
    "agent/ssil",
    "agent/swarm_router",
    "agent/tbench",
)

EDITION_UNAVAILABLE_TEMPLATE = (
    "/{name} is not part of Sophia Code (open edition). "
    "It remains in the full Sophia TUI. No action was taken."
)


def baked_default_edition() -> str:
    """Edition used when ``SOPHIA_EDITION`` is unset."""
    try:
        raw = _DEFAULT_FILE.read_text(encoding="utf-8").strip().casefold()
    except OSError:
        raw = ""
    if raw in EDITION_IDS:
        return raw
    return EDITION_FULL


def active_edition() -> str:
    """Runtime edition: env wins, then the baked default, else ``full``."""
    raw = os.environ.get("SOPHIA_EDITION", "").strip().casefold()
    if raw in EDITION_IDS:
        return raw
    return baked_default_edition()


def is_oss_edition(edition: str | None = None) -> bool:
    return (edition or active_edition()) == EDITION_OSS


def edition_skips_conscience_gate(edition: str | None = None) -> bool:
    """Open edition does not ship the Conscience delivery-gate module."""
    return is_oss_edition(edition)


def editions_for_command(name: str, explicit: tuple[str, ...] = ()) -> tuple[str, ...]:
    """Which editions may show ``name``. ``FULL_ONLY_COMMANDS`` is authoritative."""
    canonical = (name or "").strip().casefold()
    if canonical in FULL_ONLY_COMMANDS:
        return (EDITION_FULL,)
    if explicit:
        cleaned = tuple(e for e in explicit if e in EDITION_IDS)
        return cleaned or EDITION_IDS
    return EDITION_IDS


def command_in_edition(
    name: str,
    explicit: tuple[str, ...] = (),
    edition: str | None = None,
) -> bool:
    wanted = edition or active_edition()
    return wanted in editions_for_command(name, explicit)


def edition_unavailable_message(name: str) -> str:
    return EDITION_UNAVAILABLE_TEMPLATE.format(name=(name or "").strip().lstrip("/"))


def is_full_only_module(module: str) -> bool:
    mod = (module or "").strip()
    for prefix in FULL_ONLY_MODULE_PREFIXES:
        if mod == prefix or mod.startswith(prefix + ".") or mod.startswith(prefix + "_"):
            return True
    return False


def is_full_only_path(rel: str) -> bool:
    posix = (rel or "").replace("\\", "/")
    return any(posix == prefix or posix.startswith(prefix) for prefix in FULL_ONLY_PATH_PREFIXES)


__all__ = [
    "EDITION_FULL",
    "EDITION_IDS",
    "EDITION_OSS",
    "EDITION_UNAVAILABLE_TEMPLATE",
    "FULL_ONLY_COMMANDS",
    "FULL_ONLY_MODULE_PREFIXES",
    "FULL_ONLY_PATH_PREFIXES",
    "active_edition",
    "baked_default_edition",
    "command_in_edition",
    "edition_skips_conscience_gate",
    "edition_unavailable_message",
    "editions_for_command",
    "is_full_only_module",
    "is_full_only_path",
    "is_oss_edition",
]
