#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Install ``sophia-lite`` on PATH for Windows and POSIX.

Source of truth for Lite install. ``tools/install_sophia_lite.sh`` and
``.cmd`` only exec this file. ``canClaimAGI`` stays false.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sophia.tui_launch import TuiLaunchError, ensure_tui  # noqa: E402


def default_prefix() -> Path:
    override = (os.environ.get("SOPHIA_PREFIX") or "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".local"


def _chmod_unix_launchers(root: Path) -> None:
    if os.name == "nt":
        return
    for name in ("sophia", "sophia-tui", "sophia-lite"):
        path = root / "bin" / name
        if path.is_file():
            path.chmod(path.stat().st_mode | 0o111)


def _write_windows_shim(dest: Path, lines: list[str]) -> None:
    dest.write_text("\n".join(lines) + "\n", encoding="ascii")


def _install_windows(root: Path, bindir: Path, *, link_sophia: bool) -> None:
    repo_cmd = root / "bin" / "sophia.cmd"
    if not repo_cmd.is_file():
        raise FileNotFoundError(f"missing Windows launcher: {repo_cmd}")
    target = str(repo_cmd)
    resource = str(root)
    _write_windows_shim(
        bindir / "sophia-lite.cmd",
        [
            "@echo off",
            "setlocal EnableExtensions",
            "set SOPHIA_EDITION=oss",
            f'set "SOPHIA_RESOURCE_ROOT={resource}"',
            f'call "{target}" lite %*',
            "exit /b %ERRORLEVEL%",
        ],
    )
    if link_sophia:
        _write_windows_shim(
            bindir / "sophia.cmd",
            [
                "@echo off",
                "setlocal EnableExtensions",
                f'set "SOPHIA_RESOURCE_ROOT={resource}"',
                f'call "{target}" %*',
                "exit /b %ERRORLEVEL%",
            ],
        )
        _write_windows_shim(
            bindir / "sophia-tui.cmd",
            [
                "@echo off",
                "setlocal EnableExtensions",
                "set SOPHIA_UI=tui",
                f'set "SOPHIA_RESOURCE_ROOT={resource}"',
                f'call "{target}" %*',
                "exit /b %ERRORLEVEL%",
            ],
        )


def _install_posix(root: Path, bindir: Path, *, link_sophia: bool) -> None:
    lite_src = root / "bin" / "sophia-lite"
    lite_dest = bindir / "sophia-lite"
    if lite_dest.is_symlink() or lite_dest.exists():
        lite_dest.unlink()
    lite_dest.symlink_to(lite_src)
    if link_sophia:
        for name in ("sophia", "sophia-tui"):
            dest = bindir / name
            if dest.is_symlink() or dest.exists():
                dest.unlink()
            dest.symlink_to(root / "bin" / name)


def install(*, prefix: Path | None = None, link_sophia: bool | None = None) -> Path:
    prefix_path = prefix if prefix is not None else default_prefix()
    bindir = prefix_path / "bin"
    bindir.mkdir(parents=True, exist_ok=True)
    if link_sophia is None:
        link_sophia = os.environ.get("SOPHIA_LITE_LINK_SOPHIA", "0") == "1"
    try:
        ensure_tui(ROOT)
    except TuiLaunchError as exc:
        print(f"sophia-lite: {exc}", file=sys.stderr)
        raise SystemExit(78) from exc
    _chmod_unix_launchers(ROOT)
    if os.name == "nt":
        _install_windows(ROOT, bindir, link_sophia=link_sophia)
    else:
        _install_posix(ROOT, bindir, link_sophia=link_sophia)
    print("Installed:")
    print(f"  {bindir / ('sophia-lite.cmd' if os.name == 'nt' else 'sophia-lite')}")
    print("  sophia lite       # same, once this tree's bin/sophia is on PATH")
    if link_sophia:
        print("Also linked sophia / sophia-tui to this tree (SOPHIA_LITE_LINK_SOPHIA=1).")
    print(f'Put {bindir} on PATH if needed.')
    if os.name == "nt":
        print(f'  setx PATH "%PATH%;{bindir}"')
        print("Then open a new terminal: sophia-lite")
    else:
        print(f'  export PATH="{bindir}:$PATH"')
        print("Then: sophia-lite    or    sophia lite")
    print('CLI:  sophia-lite -p "summarize this repo" --mock')
    print("On first run pick Grok, then /login grok opens the official xAI browser sign-in.")
    return bindir


def main(argv: list[str] | None = None) -> int:
    del argv  # flags are environment-driven (SOPHIA_PREFIX, SOPHIA_LITE_LINK_SOPHIA)
    try:
        install()
    except FileNotFoundError as exc:
        print(f"sophia-lite: {exc}", file=sys.stderr)
        return 78
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
