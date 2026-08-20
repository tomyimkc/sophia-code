# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Pure diff-preview builders for the write_file / edit_file approval flow.

Before this module existed, the manual-approval dialog for these two tools showed
only ``"write_file <path>"`` or ``"edit_file <path>"`` — the model's actual content
was discarded before the approval_request was ever built, so an operator in the
default "approve" permission mode was asked to bless a write with zero information
about what it would write. That defeats the point of a human-in-the-loop gate.

These builders turn a tool call's arguments plus (when available) the file's
current text into a capped unified diff. They take no ``ToolContext``, no
filesystem access, and no approval/redaction concepts at all — the caller
(``agent/agent_tools.py``) is responsible for reading the target file and for
running the result through the repo's secret redactor before it can reach an
approver. That split is what makes every branch below trivially unit-testable:
given the same plain strings, ``build_write_preview``/``build_edit_preview``
always return the same dict, with no I/O in the loop to make a test flaky or a
mock necessary.

candidateOnly; canClaimAGI:false — approval-flow plumbing, no capability claim.
"""
from __future__ import annotations

import difflib
from typing import Any

#: Hard caps on the diff text handed to an approver. A model can propose writing
#: an arbitrarily large file; without a cap, "review this change" turns into
#: "scroll through tens of thousands of lines before you can say no" — which in
#: practice means operators stop reading and rubber-stamp everything, exactly the
#: blind-approval failure this module exists to close. Truncating is therefore a
#: safety property of the preview, not a display nicety.
MAX_DIFF_LINES = 200
MAX_DIFF_CHARS = 4000


def _cap(diff_text: str) -> str:
    """Cap ``diff_text`` to MAX_DIFF_LINES then MAX_DIFF_CHARS, with a marker.

    Line cap first (a diff is read line-by-line, so this is the cap that matters
    for readability) and character cap second (a defense against a single
    pathological unwrapped line, e.g. a minified JSON blob written as one "line").
    Either cap firing appends one explicit truncation marker — never a silent cut,
    which would let an operator believe they saw the whole change when they did not.
    """
    lines = diff_text.splitlines()
    total_lines = len(lines)
    truncated = total_lines > MAX_DIFF_LINES
    if truncated:
        lines = lines[:MAX_DIFF_LINES]
    out = "\n".join(lines)
    if len(out) > MAX_DIFF_CHARS:
        out = out[:MAX_DIFF_CHARS]
        truncated = True
    if truncated:
        out += (
            f"\n… (diff truncated — showing at most {MAX_DIFF_LINES} lines / "
            f"{MAX_DIFF_CHARS} chars of {total_lines} total lines)"
        )
    return out


def _unified(before: str, after: str, path: str) -> str:
    diff_lines = list(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
    )
    if not diff_lines:
        return "(no textual change)"
    return _cap("".join(diff_lines))


def build_write_preview(path: str, existing: str | None, new_content: str) -> dict[str, Any]:
    """Describe a pending ``write_file(path, new_content)`` call.

    ``existing`` is the file's current text, or ``None`` when there is nothing to
    diff against — the path does not exist yet, or its prior bytes could not be
    read as text (binary, or unreadable). The caller decides which of those two
    cases applies; this function only decides what an operator should see, so a
    write to a genuinely new path is clearly labelled ``"new_file"`` rather than
    presented as an overwrite of an empty file.
    """
    kind = "new_file" if existing is None else "overwrite"
    diff = _unified(existing or "", new_content, path)
    return {"kind": kind, "path": path, "diff": diff}


def build_edit_preview(path: str, content: str, old: str, new: str) -> dict[str, Any]:
    """Describe a pending ``edit_file(path, old, new)`` call's single replacement.

    Mirrors ``edit_file``'s own replace-first-occurrence semantics exactly (see
    ``agent/agent_tools.py::_t_edit_file``), so the diff an operator approves is
    the literal change that will land, not an approximation of it. When ``old``
    does not appear in ``content`` at all, the real tool call will fail its own
    uniqueness check before ever mutating anything — this preview says so
    plainly rather than silently rendering "no change", which would read as a
    false reassurance that the edit is a no-op.
    """
    if not old or content.count(old) == 0:
        return {
            "kind": "edit",
            "path": path,
            "diff": f"(cannot preview — {old!r} not found in {path})",
        }
    after = content.replace(old, new, 1)
    return {"kind": "edit", "path": path, "diff": _unified(content, after, path)}


__all__ = ["build_write_preview", "build_edit_preview", "MAX_DIFF_LINES", "MAX_DIFF_CHARS"]
