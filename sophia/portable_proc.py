# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Windows-safe process helpers for Sophia Code launchers.

``subprocess`` cannot exec ``.cmd`` / ``.bat`` on Windows without ``cmd /c``.
``canClaimAGI`` stays false.
"""
from __future__ import annotations

import os
import shutil


def resolve_tool(name: str, *, nt: bool | None = None) -> str | None:
    """Return an executable path for ``name``, including Windows PATHEXT."""
    found = shutil.which(name)
    if found:
        return found
    is_nt = os.name == "nt" if nt is None else nt
    if not is_nt:
        return None
    for ext in (".cmd", ".exe", ".bat", ".com"):
        found = shutil.which(name if name.lower().endswith(ext) else name + ext)
        if found:
            return found
    return None


def argv_for_subprocess(argv: list[str], *, nt: bool | None = None) -> list[str]:
    """Prefix ``cmd /c`` when the program is a Windows batch wrapper."""
    if not argv:
        return list(argv)
    is_nt = os.name == "nt" if nt is None else nt
    if not is_nt:
        return list(argv)
    program = argv[0].lower()
    if program.endswith((".cmd", ".bat")):
        return ["cmd", "/c", *argv]
    return list(argv)
