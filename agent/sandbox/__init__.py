# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Sandbox backends for the terminal tool's bash (Sophia Agents Phase 2).

``default_backend()`` selects a REAL isolation backend or, when none is available,
the fail-closed :class:`NullBackend` that refuses to run. There is deliberately NO
porous fallback (no bare ``resource.setrlimit`` shell) — a fake sandbox is the one
outcome forbidden. Wire it in with the CLI's ``--sandbox`` flag, which sets
``ToolContext.sandbox = default_backend()``.
"""
from __future__ import annotations

from agent.sandbox.base import ExecBackend, NullBackend
from agent.sandbox.apple_container_backend import AppleContainerBackend
from agent.sandbox.docker_backend import DockerBackend
from agent.sandbox.plugin_sidecar import (
    BubblewrapPluginSandboxProvider,
    NoPluginSandboxProvider,
    PluginSandboxLaunch,
    PluginSandboxProvider,
    PluginSandboxStatus,
    SeatbeltPluginSandboxProvider,
    UnavailablePluginSandboxProvider,
    plugin_sandbox_provider,
)


def default_backend() -> ExecBackend:
    """Docker if its daemon is up; otherwise the fail-closed NullBackend."""
    docker = DockerBackend()
    if docker.available():
        return docker
    return NullBackend()


__all__ = [
    "AppleContainerBackend",
    "BubblewrapPluginSandboxProvider",
    "DockerBackend",
    "ExecBackend",
    "NoPluginSandboxProvider",
    "NullBackend",
    "PluginSandboxLaunch",
    "PluginSandboxProvider",
    "PluginSandboxStatus",
    "SeatbeltPluginSandboxProvider",
    "UnavailablePluginSandboxProvider",
    "default_backend",
    "plugin_sandbox_provider",
]
