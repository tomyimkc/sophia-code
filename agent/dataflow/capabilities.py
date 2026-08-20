# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Capabilities + the deterministic policy that enforces them.

Every tool has a *capability* describing its effect on the world. The policy
``decide`` takes the tool's capability, the taint of its arguments, and the active
profile, and returns ALLOW / REQUIRE_HITL / BLOCK. The core rule is the lethal
trifecta: **tainted (attacker-influenceable) data must not flow into a write or
egress sink** without human approval. Reads are always allowed; their *outputs*
are tainted by the caller. The airgap profile additionally blocks all egress.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Effect(str, Enum):
    READ = "read"        # observes state; no external/world change
    WRITE = "write"      # mutates local state (belief graph, files)
    EGRESS = "egress"    # leaves the trust boundary (network, external process)


@dataclass(frozen=True)
class ToolCap:
    name: str
    effect: Effect
    accepts_tainted: bool = True   # may a tainted value flow into this tool at all?


@dataclass(frozen=True)
class Decision:
    action: str        # "allow" | "require_hitl" | "block"
    reason: str

    @property
    def allowed(self) -> bool:
        return self.action == "allow"

    @property
    def blocked(self) -> bool:
        return self.action == "block"


def decide(cap: ToolCap, arg_taints, *, profile: str = "default", approver=None) -> Decision:
    """Deterministic enforcement. ``arg_taints`` is an iterable of taint sets."""
    tainted = any(bool(t) for t in (arg_taints or []))

    # Fail-closed airgap: nothing leaves the boundary, period.
    if profile == "airgap" and cap.effect == Effect.EGRESS:
        return Decision("block", f"airgap profile blocks egress tool '{cap.name}'")

    if cap.effect == Effect.READ:
        return Decision("allow", f"read tool '{cap.name}'")

    # WRITE / EGRESS sinks:
    if not tainted:
        return Decision("allow", f"{cap.effect.value} tool '{cap.name}' with only trusted inputs")

    # Lethal trifecta: untrusted data heading into a side-effecting sink.
    if not cap.accepts_tainted:
        return Decision("block", f"{cap.effect.value} sink '{cap.name}' forbids tainted input")
    if approver is None:
        return Decision(
            "block",
            f"tainted input into {cap.effect.value} sink '{cap.name}' needs human approval (none available)",
        )
    return Decision("require_hitl", f"tainted input into {cap.effect.value} sink '{cap.name}'")
