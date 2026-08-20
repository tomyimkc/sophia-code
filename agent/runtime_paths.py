# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Relocatable paths for bundled resources and runtime state.

Source checkouts retain their repository-relative defaults. Bundled releases
and operator-managed runs place every mutable default outside the package tree
under :func:`user_state_dir`, so a verified release remains byte-for-byte
immutable after launch.
"""

from __future__ import annotations

import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _release_root_if_bundled() -> Path | None:
    """Return the release root when running from a bundled release, else None.

    Release layout: ``<release>/python/agent/runtime_paths.py`` with the bundled
    data dirs (constitution/, moral_corpus/, schemas/) at ``<release>/`` — one
    level ABOVE the python package dir. Source-checkout layout:
    ``<repo>/agent/runtime_paths.py`` with the data dirs alongside ``agent/``.

    PROJECT_ROOT (parents[1]) is correct for a source checkout but WRONG for a
    release: it points at ``<release>/python/`` where none of the data dirs
    live. Detect that ``python/`` shape (and a sibling VERSION, which the
    bundler writes at both ``<release>/VERSION`` and ``<release>/python/VERSION``)
    and walk up one level so resource_root() defaults to the actual release
    root without needing SOPHIA_RESOURCE_ROOT.
    """
    # release shape: .../<release>/python/agent/runtime_paths.py
    #   parents[0]=agent  parents[1]=python  parents[2]=<release>
    if PROJECT_ROOT.name == "python" and (PROJECT_ROOT.parent / "VERSION").is_file():
        return PROJECT_ROOT.parent
    return None


def _env_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    return Path(value).expanduser() if value else None


def workspace_dir() -> Path:
    """Return the active workspace, defaulting to the current directory."""
    return (_env_path("SOPHIA_WORKSPACE_DIR") or Path.cwd()).resolve()


def user_state_dir() -> Path:
    """Return the per-user mutable state directory."""
    explicit = _env_path("SOPHIA_STATE_DIR")
    if explicit:
        return explicit.resolve()
    xdg = _env_path("XDG_STATE_HOME")
    return (xdg / "sophia" if xdg else Path.home() / ".sophia").resolve()


def _state_root_required() -> bool:
    """Whether mutable defaults must be external to ``PROJECT_ROOT``."""
    return (
        _release_root_if_bundled() is not None
        or _env_path("SOPHIA_STATE_DIR") is not None
        or _env_path("XDG_STATE_HOME") is not None
    )


def mutable_root() -> Path:
    """Return the root for paths that may be written at runtime.

    A source checkout keeps its historical repository-relative layout unless
    the operator selects a state root through ``SOPHIA_STATE_DIR`` or the
    standard ``XDG_STATE_HOME``. A bundled release always uses per-user state
    and must never write into ``<release>/python``.
    """
    return user_state_dir() if _state_root_required() else PROJECT_ROOT.resolve()


def mutable_path(*parts: str) -> Path:
    """Resolve a mutable runtime path without targeting a bundled package."""
    return mutable_root().joinpath(*parts).resolve()


def memory_dir() -> Path:
    """Return Sophia's mutable memory root."""
    explicit = _env_path("SOPHIA_MEMORY_DIR")
    return (explicit.resolve() if explicit else mutable_path("agent", "memory"))


def artifact_dir() -> Path:
    """Return the mutable artifact root for this run."""
    explicit = _env_path("SOPHIA_ARTIFACTS_DIR")
    return (explicit.resolve() if explicit else mutable_path("agi-proof"))


def resource_root() -> Path:
    """Return bundled resources from a release artifact or source checkout."""
    explicit = _env_path("SOPHIA_RESOURCE_ROOT")
    if explicit:
        return explicit.resolve()
    relocated = artifact_dir() / "resources"
    if relocated.is_dir():
        return relocated
    # Bundled release: data dirs sit at <release>/ (above python/), not under
    # PROJECT_ROOT (<release>/python). Honor the release layout so the
    # conscience/constitution/schemas files resolve without an env crutch.
    release_root = _release_root_if_bundled()
    if release_root is not None:
        return release_root
    return PROJECT_ROOT


def resource_path(*parts: str) -> Path:
    """Resolve a resource without depending on the process working directory."""
    return resource_root().joinpath(*parts)


__all__ = [
    "PROJECT_ROOT",
    "workspace_dir",
    "user_state_dir",
    "mutable_root",
    "mutable_path",
    "memory_dir",
    "artifact_dir",
    "resource_root",
    "resource_path",
]
