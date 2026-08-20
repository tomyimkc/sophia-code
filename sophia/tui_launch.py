# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Portable Ink TUI launch for Windows and POSIX.

Used by ``python -m sophia.cli lite``, ``bin/sophia.cmd``, and the exported
Sophia Code tree so a future export keeps both platforms. Not AGI.
"""
from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sophia.portable_proc import argv_for_subprocess, resolve_tool

_EXIT_MISSING = 78
_EXIT_NO_NODE = 127


class TuiLaunchError(RuntimeError):
    """TUI dist or npm install cannot be completed."""


def repo_root(start: Path | None = None) -> Path:
    env = (os.environ.get("SOPHIA_RESOURCE_ROOT") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    here = start if start is not None else Path(__file__).resolve()
    return here.parents[1]


def tui_paths(root: Path) -> tuple[Path, Path, Path]:
    src = root / "apps" / "sophia-tui"
    return src, src / "dist" / "index.js", src / "node_modules" / "react"


def ensure_tui(
    root: Path,
    *,
    npm: str | None = None,
    run: Callable[..., Any] | None = None,
) -> Path:
    """Return ``dist/index.js``, running ``npm ci`` / ``npm run build`` if needed."""
    tui_src, entry, react = tui_paths(root)
    package = tui_src / "package.json"
    runner = run or subprocess.run
    npm_bin = npm if npm is not None else resolve_tool("npm")

    def _npm(args: list[str]) -> int:
        if not npm_bin:
            raise TuiLaunchError(
                "TUI dependencies missing — install Node.js, then: "
                "cd apps/sophia-tui && npm ci && npm run build"
            )
        proc = runner(
            argv_for_subprocess([npm_bin, *args]),
            cwd=str(tui_src),
            check=False,
        )
        return int(getattr(proc, "returncode", 1) or 0)

    if package.is_file() and not react.is_dir():
        print("sophia: installing TUI dependencies (npm ci)…", file=sys.stderr)
        if _npm(["ci"]) != 0:
            raise TuiLaunchError(
                "TUI dependencies missing — run: cd apps/sophia-tui && npm ci"
            )
    if not entry.is_file():
        print("sophia: building TUI…", file=sys.stderr)
        if _npm(["run", "build"]) != 0 or not entry.is_file():
            raise TuiLaunchError(
                "TUI build missing — run: cd apps/sophia-tui && npm ci && npm run build"
            )
    return entry


def run_tui(
    argv: list[str],
    *,
    root: Path | None = None,
    node: str | None = None,
    npm: str | None = None,
    run: Callable[..., Any] | None = None,
) -> int:
    """Spawn ``node dist/index.js`` after ensuring the ESM install exists."""
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    base = repo_root() if root is None else root
    os.environ.setdefault("SOPHIA_RESOURCE_ROOT", str(base))
    pythonpath = os.environ.get("PYTHONPATH", "")
    root_s = str(base)
    if root_s not in pythonpath.split(os.pathsep):
        os.environ["PYTHONPATH"] = root_s + (os.pathsep + pythonpath if pythonpath else "")

    node_bin = node if node is not None else resolve_tool("node")
    if not node_bin:
        print(
            "sophia: node not found. Install Node.js 20+ and keep node on PATH.",
            file=sys.stderr,
        )
        return _EXIT_NO_NODE
    try:
        entry = ensure_tui(base, npm=npm, run=run)
    except TuiLaunchError as exc:
        print(f"sophia: {exc}", file=sys.stderr)
        return _EXIT_MISSING
    runner = run or subprocess.run
    proc = runner(
        argv_for_subprocess([node_bin, str(entry), *argv]),
        check=False,
    )
    return int(getattr(proc, "returncode", 1) or 0)


def main(argv: list[str] | None = None) -> int:
    return run_tui(list(sys.argv[1:] if argv is None else argv))


if __name__ == "__main__":
    raise SystemExit(main())
