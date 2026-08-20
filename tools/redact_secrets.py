#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Redact secrets AT THE BOUNDARY — return masked text safe to log/persist/show.

Complements tools/security_audit.py: `scan_text` DETECTS and reports (fixed marker,
never returns the surrounding content), while this returns the ORIGINAL TEXT with
every secret span replaced in place by «REDACTED:<label>». Use it on anything that
crosses a trust boundary and might carry a secret a scanner would only flag after
the fact: a rented-pod's streamed log before it's uploaded, an MCP tool's output
before it's shown, an evidence artifact before it's committed.

Motivation (grok-build `xai-grok-secrets` pattern): on 2026-07-14 a GPG PRIVATE KEY
block and a live RunPod `rpa_…` key entered this session's transcript. Neither shape
was even in `security_audit.SECRET_PATTERNS` (no RunPod rule; the private-key rule
matches only the header LINE, so a redactor built on it would leave the key BODY in
the clear). This module adds those shapes and masks whole multi-line key BLOCKS.

No capability claim; this is defensive plumbing. candidateOnly; canClaimAGI:false.

    python tools/redact_secrets.py pod.log            # print redacted text
    some_command | python tools/redact_secrets.py -   # filter a stream
    python tools/redact_secrets.py --assert-clean f   # exit 3 if any secret present
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.security_audit import SECRET_PATTERNS as _AUDIT_PATTERNS  # noqa: E402

REDACT_EXIT = 3  # a secret was present (with --assert-clean)

# Multi-line key BLOCKS — masked whole (header + body + footer), DOTALL. Ordered
# FIRST so the single-line header rule can't leave the body exposed.
BLOCK_PATTERNS: "tuple[tuple[str, str], ...]" = (
    (r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----.*?-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----",
     "private-key-block"),
)

# Single-line shapes NOT covered by the shared audit set — the exact gaps that
# bit this repo (RunPod key; the broader GitHub token family; bearer tokens).
EXTRA_LINE_PATTERNS: "tuple[tuple[str, str], ...]" = (
    (r"rpa_[A-Za-z0-9]{20,}", "runpod-key"),
    (r"gh[oususr]_[A-Za-z0-9]{20,}", "github-token"),
    (r"sk-ant-[A-Za-z0-9-]{20,}", "anthropic-key"),
    (r"(?i)bearer\s+[A-Za-z0-9._\-]{20,}", "bearer-token"),
)

# The shared, canonical audit shapes (AWS, private-key header, openai/hf/xai, ghp_).
# Reused verbatim so the two tools never drift; see security_audit.SECRET_PATTERNS.
_LINE_PATTERNS = tuple(EXTRA_LINE_PATTERNS) + tuple(_AUDIT_PATTERNS)

_BLOCK_RE = [(re.compile(p, re.DOTALL), name) for p, name in BLOCK_PATTERNS]
_LINE_RE = [(re.compile(p), name) for p, name in _LINE_PATTERNS]

# The complete, fixed label vocabulary (module constants — never derived from any
# scanned text). Reporting is done by filtering THIS tuple, so nothing that flows
# from a secret can reach a log line (keeps CodeQL py/clear-text-logging happy and
# is genuinely safe: only pattern names, never secret bytes, are ever emitted).
_ALL_LABELS = tuple(sorted({name for _, name in (*BLOCK_PATTERNS, *_LINE_PATTERNS)}))

_MARK = "«REDACTED:{}»"  # «REDACTED:label»


def redact(text: str) -> str:
    """Return `text` with every secret span replaced by «REDACTED:<label>».

    Blocks are masked before single-line shapes so a key body is never left behind.
    Idempotent: the marker itself contains no secret shape, so re-running is a no-op.
    """
    for rx, name in _BLOCK_RE:
        text = rx.sub(_MARK.format(name), text)
    for rx, name in _LINE_RE:
        text = rx.sub(_MARK.format(name), text)
    return text


def find_labels(text: str) -> "list[str]":
    """Labels of secrets present (sorted, de-duped). Never returns secret bytes —
    only the pattern label, so results are safe to print/log."""
    found: "set[str]" = set()
    for rx, name in _BLOCK_RE:
        if rx.search(text):
            found.add(name)
    for rx, name in _LINE_RE:
        if rx.search(text):
            found.add(name)
    return sorted(found)


def _read(src: str) -> str:
    if src == "-":
        return sys.stdin.read()
    return Path(src).read_text(encoding="utf-8", errors="replace")


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("source", nargs="?", default="-",
                    help="file to redact, or '-' for stdin (default)")
    ap.add_argument("--assert-clean", action="store_true",
                    help="exit 3 if any secret is present (fail-closed gate); prints "
                         "only the labels found, never the secret")
    args = ap.parse_args(argv)

    text = _read(args.source)
    if args.assert_clean:
        present = set(find_labels(text))
        if present:
            # Build the message by FILTERING the constant vocabulary — the emitted
            # strings come from _ALL_LABELS (module constants), not from `text`, so
            # nothing derived from a secret is ever logged (CodeQL clear-text-safe).
            names = " ".join(lbl for lbl in _ALL_LABELS if lbl in present)
            print(f"::error::redact_secrets: secret shape(s) present: {names}", file=sys.stderr)
            return REDACT_EXIT
        print("redact_secrets: clean (no secret shapes present)")
        return 0
    sys.stdout.write(redact(text))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
