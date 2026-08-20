#!/usr/bin/env bash
# Install `sophia lite` / `sophia-lite` on PATH from this source checkout.
# Does not claim AGI. Open edition uses SOPHIA_EDITION=oss.
#
# Default: install the individual `sophia-lite` command only.
# Set SOPHIA_LITE_LINK_SOPHIA=1 to also point `sophia` / `sophia-tui` at this tree.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${SOPHIA_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin"
TUI="$ROOT/apps/sophia-tui"
mkdir -p "$BIN"
# dist/ can exist from a git-archive /update while node_modules does not —
# the TUI is tsc ESM (`import 'react'`), so a missing react install cannot boot.
if [[ ! -d "$TUI/node_modules/react" ]]; then
  echo "sophia-lite: installing TUI dependencies…"
  ( cd "$TUI" && npm ci )
fi
if [[ ! -f "$TUI/dist/index.js" ]]; then
  echo "sophia-lite: building TUI…"
  ( cd "$TUI" && npm run build )
fi
chmod +x "$ROOT/bin/sophia" "$ROOT/bin/sophia-tui" "$ROOT/bin/sophia-lite"
ln -sfn "$ROOT/bin/sophia-lite" "$BIN/sophia-lite"
if [[ "${SOPHIA_LITE_LINK_SOPHIA:-0}" == "1" ]]; then
  ln -sfn "$ROOT/bin/sophia" "$BIN/sophia"
  ln -sfn "$ROOT/bin/sophia-tui" "$BIN/sophia-tui"
  echo "Also linked sophia / sophia-tui to this tree (SOPHIA_LITE_LINK_SOPHIA=1)."
fi
echo "Installed:"
echo "  $BIN/sophia-lite  # open edition (SOPHIA_EDITION=oss)"
echo "  sophia lite       # same, once this tree's bin/sophia is on PATH"
echo "Put $BIN on PATH if needed: export PATH=\"$BIN:\$PATH\""
echo "Then: sophia-lite    or    sophia lite"
echo "CLI:  sophia-lite -p \"summarize this repo\" --mock"
echo "On first run pick Grok, then /login grok opens the official xAI browser sign-in."
