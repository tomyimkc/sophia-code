# SPDX-License-Identifier: Apache-2.0
"""Sophia Code open edition. Apache-2.0. Not AGI. canClaimAGI:false."""
from pathlib import Path

_VERSION = Path(__file__).resolve().parents[1] / "VERSION"
__version__ = _VERSION.read_text(encoding="utf-8").strip() if _VERSION.is_file() else "0.12.16"
