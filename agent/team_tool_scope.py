# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Least-privilege tool-name map: SwarmRouter/harness → agent_tools.

``agent.swarm_router.TEAMS`` scopes children with harness-registry names
(``web_search``, ``fetch``, ``retrieve``, ``python``, …). Team lanes in the
bridge run via ``run_agent_loop`` + ``agent_tools``, whose surface is
``read_file`` / ``web_fetch`` / ``bash`` / … — zero name overlap.

ADR-0002 W1 forbids applying router names blindly (that would deny every real
tool). This module is the deliberate single map: only names with a clear
agent_tools equivalent are listed; unknowns contribute nothing (fail-closed).

Semantics
---------
* ``Team.allowed_tools is None`` (catalogue pure-reasoning) → empty agent set.
* ``TeamLane.allowed_tools is None`` (TEAM_ROLES coding pad) → unrestricted on
  ``ToolContext`` (byte-identical default; not produced by this map).
* Unknown harness names → contribute nothing (do not invent tools).

canClaimAGI: false — plumbing only.
"""
from __future__ import annotations

from typing import Iterable

# Read-ish research surface used for web/search/retrieve-class router tools.
_RESEARCH_READ: frozenset[str] = frozenset({
    "web_fetch",
    "read_file",
    "read_batch",
    "grep",
    "glob",
    "list_dir",
})

# Router/harness catalogue name → agent_tools name(s). Only clear equivalents.
# Unlisted names (lean, math_verify, legal_citations, datalog, …) map to nothing.
ROUTER_TO_AGENT_TOOLS: dict[str, frozenset[str]] = {
    "web_search": _RESEARCH_READ,
    "fetch": _RESEARCH_READ,
    "retrieve": _RESEARCH_READ,
    # No dedicated python tool in agent_tools; bash is the exec surface.
    "python": frozenset({"bash"}),
}


def map_router_tools(router_tools: "Iterable[str] | None") -> frozenset[str]:
    """Map harness/router tool names to agent_tools names.

    * ``None`` (Team pure-reasoning) → empty set (no tools).
    * Known names → their mapped agent_tools equivalents (union).
    * Unknown names → contribute nothing (fail-closed; do not invent tools).
    """
    if router_tools is None:
        return frozenset()
    out: set[str] = set()
    for name in router_tools:
        out |= ROUTER_TO_AGENT_TOOLS.get(str(name), frozenset())
    return frozenset(out)


__all__ = ["ROUTER_TO_AGENT_TOOLS", "map_router_tools"]
