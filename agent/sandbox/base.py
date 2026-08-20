# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Sandbox execution backends for the terminal tool's bash (Sophia Agents Phase 2).

The bash tool (``agent.agent_tools._t_bash``) routes through ``ctx.sandbox.run_shell``
when a backend is set. A backend contains a command in real isolation. The one rule
that must never bend: there is **no porous fallback** — if no real-isolation backend
is available, :func:`agent.sandbox.default_backend` returns a :class:`NullBackend`
that REFUSES to run (fail-closed), never a bare ``subprocess`` masquerading as a
sandbox.

candidateOnly; canClaimAGI:false — containment plumbing, no claim.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class ExecBackend(Protocol):
    name: str

    def available(self) -> bool:
        """True iff this backend can actually isolate right now."""

    def run_shell(self, command: str, *, timeout: float, cwd: str) -> "tuple[int, str]":
        """Run ``command`` in isolation. Returns (returncode, combined stdout+stderr)."""


class NullBackend:
    """The fail-closed backend: refuses to run rather than run unsandboxed.

    Selected when no real-isolation backend is available. Returning a non-zero code
    and a clear message is the whole point — a coding agent that asked for a sandbox
    must not be silently handed an unsandboxed shell.
    """
    name = "null"

    def available(self) -> bool:
        return False

    def run_shell(self, command: str, *, timeout: float, cwd: str) -> "tuple[int, str]":
        return (
            126,
            "no real-isolation sandbox backend available — refusing to run unsandboxed "
            "(fail-closed). Install/start Docker, or drop --sandbox to run directly.",
        )
