#!/usr/bin/env bash
# Install `sophia lite` / `sophia-lite` on PATH from this source checkout.
# POSIX wrapper around tools/install_sophia_lite.py (Windows: .cmd).
# Does not claim AGI. Open edition uses SOPHIA_EDITION=oss.
#
# Default: install the individual `sophia-lite` command only.
# Set SOPHIA_LITE_LINK_SOPHIA=1 to also point `sophia` / `sophia-tui` at this tree.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$ROOT/tools/install_sophia_lite.py" "$@"
fi
if command -v python >/dev/null 2>&1; then
  exec python "$ROOT/tools/install_sophia_lite.py" "$@"
fi
echo "sophia-lite: Python 3.11+ is required to install" >&2
exit 127
