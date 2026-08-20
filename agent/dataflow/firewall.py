# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""The firewall: enforce a tool's capability against its arguments' taint.

``guard_call`` returns the policy Decision for a prospective tool call.
``firewalled`` wraps a tool function so the policy is enforced *before* it runs:
a blocked call raises ``FirewallBlocked``; a require-HITL call runs only if the
approver grants it; an allowed call executes (with ``Labeled`` args unwrapped).
"""

from __future__ import annotations

import os
from typing import Callable

from agent.dataflow.capabilities import Decision, decide
from agent.dataflow.manifest import cap_for
from agent.dataflow.taint import taint_of, unwrap


class FirewallBlocked(RuntimeError):
    """Raised when the data-flow policy blocks (or fails to approve) a tool call."""


def active_profile(profile: "str | None" = None) -> str:
    return (profile or os.environ.get("SOPHIA_PROFILE") or "default").strip().lower()


def egress_blocked(profile: "str | None" = None) -> bool:
    """True when the active profile forbids leaving the trust boundary (airgap).

    The single chokepoint every egress sink (model adapter, web search, GenAI
    client, MCP egress tools) consults so 'airgap' is enforced uniformly."""
    return active_profile(profile) == "airgap"


def guard_call(tool_name: str, args=(), kwargs=None, *, profile=None, approver=None) -> Decision:
    """Decide whether ``tool_name`` may run with these (possibly tainted) inputs."""
    kwargs = kwargs or {}
    taints = [taint_of(a) for a in args] + [taint_of(v) for v in kwargs.values()]
    return decide(cap_for(tool_name), taints, profile=active_profile(profile), approver=approver)


def firewalled(fn: Callable, *, name: "str | None" = None, approver=None, profile=None) -> Callable:
    """Wrap ``fn`` so every call is policy-checked. ``approver(tool, args, kwargs,
    decision) -> bool`` is consulted for require-HITL decisions."""
    tool_name = name or getattr(fn, "__name__", "tool")

    def _wrapped(*args, **kwargs):
        decision = guard_call(tool_name, args, kwargs, profile=profile, approver=approver)
        if decision.action == "block":
            raise FirewallBlocked(f"[{tool_name}] {decision.reason}")
        if decision.action == "require_hitl":
            # Fail CLOSED: a missing approver, a raising approver, or any non-True
            # return all block. Only an explicit True approves a tainted→sink call.
            granted = False
            if approver is not None:
                try:
                    granted = approver(tool_name, args, kwargs, decision) is True
                except Exception:
                    granted = False
            if not granted:
                raise FirewallBlocked(f"[{tool_name}] HITL not approved: {decision.reason}")
        real_args = [unwrap(a) for a in args]
        real_kwargs = {k: unwrap(v) for k, v in kwargs.items()}
        return fn(*real_args, **real_kwargs)

    _wrapped.__name__ = tool_name
    _wrapped.__wrapped__ = fn
    return _wrapped
