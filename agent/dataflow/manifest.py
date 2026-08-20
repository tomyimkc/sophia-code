# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Capability manifest for the Sophia MCP tools (default-deny).

Classifies each ``sophia_*`` tool by its real effect. An UNKNOWN tool is treated
as a tainted-input-forbidding WRITE sink — the safe default: a tool nobody
declared cannot silently receive untrusted data or change the world.
"""

from __future__ import annotations

from agent.dataflow.capabilities import Effect, ToolCap

_READ = [
    "sophia_validate", "sophia_corpus_stats", "sophia_gate_check", "sophia_check_claim",
    "sophia_belief", "sophia_benchmark_list", "sophia_benchmark_score",
    "sophia_get_attribution", "sophia_get_record", "sophia_list_disputes",
    "sophia_read_dispute", "sophia_sector_council", "sophia_rubric_review",
    "sophia_wiki_read", "sophia_wiki_search", "sophia_wiki_contradictions",
    "sophia_wiki_validate",
]
_WRITE = ["sophia_wiki_upsert", "sophia_export_corpus"]
_EGRESS = ["sophia_web_evidence_search", "sophia_openclaw_infer"]

TOOL_CAPS: dict = {}
for _n in _READ:
    TOOL_CAPS[_n] = ToolCap(_n, Effect.READ)
for _n in _WRITE:
    # Writes may receive tainted input only behind human approval (not forbidden outright):
    TOOL_CAPS[_n] = ToolCap(_n, Effect.WRITE, accepts_tainted=True)
for _n in _EGRESS:
    TOOL_CAPS[_n] = ToolCap(_n, Effect.EGRESS, accepts_tainted=True)


def cap_for(name: str) -> ToolCap:
    """Capability for a tool; unknown tools default-deny (tainted-forbidding WRITE)."""
    return TOOL_CAPS.get(name) or ToolCap(name, Effect.WRITE, accepts_tainted=False)
