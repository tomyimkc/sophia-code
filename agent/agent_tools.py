# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Coding toolset for the Sophia Agents terminal loop.

The OpenClaw/Hermes-style capability surface: the tools an LLM needs to actually
work in a repo — read/write/edit files, list/search the tree, run shell commands.
Each tool is defined once with a name, an argument spec (surfaced to the model in
the system prompt), a risk class, and a pure ``execute`` function.

Sophia trust wrapping (this is why it's "Sophia Agents", not just a tool runner):

* **Permission-gated.** ``ToolContext.permission`` is ``readonly`` | ``approve`` |
  ``auto``. Anything that writes or executes is refused in ``readonly``, and in
  ``approve`` must pass the caller's ``approver`` callback (the CLI's y/N prompt).
* **Root-confined file I/O.** ``read_file``/``write_file``/``edit_file``/``list_dir``
  resolve paths under the working root and refuse escapes (no reading ``/etc``).
  ``bash`` is a shell and cannot be confined — so it is gated as ``exec`` and never
  runs in ``readonly``.
* **Secret-redacted output.** Every tool result is passed through
  ``tools.redact_secrets.redact`` before it re-enters the transcript or a log, so a
  leaked key in a command's output never reaches the model or the trace.
* **Real previews, authoritative risk, and file checkpoints.** The manual-approval
  preview for ``write_file``/``edit_file`` is a real (capped, redacted) unified diff,
  not a bare filename; every risk-gated call carries the tool's declared risk plus a
  conservative destructive-command flag to the approver instead of leaving the UI to
  guess; and every mutation is checkpointed first so it can be undone byte-for-byte.
* **Hook-enforced in every permission mode.** An operator-configured PreToolUse
  hook is consulted before every tool call — read-only, auto-mode, or the calls a
  human approves — not only the ones that already reach a confirmation dialog, so a
  denial rule actually holds even when nobody is watching the run. A PreToolUse
  hook engine failure denies the call rather than silently letting it through.

candidateOnly; canClaimAGI:false — capability plumbing, no claim.
"""
from __future__ import annotations

import json
import re
import os
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any, Callable, Mapping

from agent import diff_preview
from agent import hooks as user_hooks
from agent.session_ops import atomic_write_json
from agent.structured_output import validate as _validate_schema

# Secret redaction at the boundary (built earlier). Degrade to identity ONLY if the
# module is somehow unavailable — never silently import-fail into leaking secrets.
try:
    from tools.redact_secrets import redact as _redact
except Exception:  # pragma: no cover - defensive
    def _redact(text: str) -> str:
        return text

RISK_SAFE = "safe"      # read-only; allowed in every permission mode
RISK_GOVERNANCE = "governance"  # read/audit gate; allowed without write approval
RISK_WRITE = "write"    # mutates the tree; needs approval (blocked in readonly)
RISK_EXEC = "exec"      # runs code; needs approval (blocked in readonly)

# Broad repository search defaults. These are traversal exclusions, not access
# controls: an explicit pattern such as ``node_modules/pkg/**/*.js`` or
# ``.claude/worktrees/foo/**/*.py`` still searches the named tree. The purpose
# is to stop an unqualified ``**/*`` from recursively walking dependency caches,
# generated output, and dozens of nested worktrees before it returns anything.
_SEARCH_SKIP_DIR_NAMES = frozenset({
    ".git",
    "__pycache__",
    "node_modules",
    ".venv",
    ".worktrees",
    "venv",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".cache",
    ".next",
    "build",
    "dist",
    "out",
    "coverage",
    "htmlcov",
})
_SEARCH_SKIP_DIR_PREFIXES = (
    ".venv-",
    "venv-",
    ".virtualenv-",
    "virtualenv-",
)
_SEARCH_SKIP_PATHS = (
    (".claude", "worktrees"),
    (".sophia",),
)
_SEARCH_MAX_DIRECTORIES = 10_000
_SEARCH_MAX_FILES = 20_000
_SEARCH_MAX_BYTES = 32 * 1024 * 1024
_SEARCH_MAX_MATCHES = 200


class ToolCancelled(RuntimeError):
    """Cooperative in-process tool cancellation."""


@dataclass
class ToolContext:
    root: Path
    permission: str = "approve"          # readonly | approve | auto
    approver: Callable[[str, str], bool] | None = None  # (tool_name, preview) -> approved?
    max_output: int = 6000               # truncate tool output fed back to the model
    bash_timeout: float = 120.0
    client: Any = None                   # model client, for LLM-using ext tools (delegate, vision…)
    sandbox: Any = None                  # optional ExecBackend; bash routes through it when set
    #: Legacy strict-tier toggle for callers outside Sophia Code. ``None``
    #: preserves the environment-controlled harness behavior; ``False`` means
    #: floor-only and ``True`` means floor + strict holds.
    conscience_strict: bool | None = None
    #: Explicit Sophia Code delivery policy. ``off`` skips final-text
    #: conscience/provenance evaluation, ``report`` evaluates but never
    #: withholds, ``floor`` preserves the hard-prohibition floor, and ``strict``
    #: also enforces epistemic/provenance holds. ``None`` preserves the legacy
    #: harness policy above so non-TUI callers do not change silently.
    conscience_mode: str | None = None
    #: Least-privilege tool allow-list for a delegated child lane.
    #: ``None`` inherits the full registry (no extra restriction). An empty set
    #: means pure-reasoning — every tool call is refused. A non-empty set is
    #: the ONLY tools the child may invoke; anything else fails closed.
    allowed_tools: "set[str] | frozenset[str] | None" = None
    subagent_client: Any = None          # optional cheaper/specialized client for delegate
    subagent_allowed_tools: "set[str] | frozenset[str] | None" = None
    #: Optional host observer for native ``delegate`` assignment/lifecycle
    #: events.  The Code bridge uses this to maintain the live SMUX dispatch
    #: manifest without making the tool plugin depend on TUI/session modules.
    dispatch_sink: "Callable[[Mapping[str, Any]], None] | None" = None
    budget: Any = None                   # optional ExecutionBudget shared by nested loops
    #: Optional operator-authored PreToolUse/PostToolUse hook engine
    #: (an ``agent.hooks.UserHookConfig``, e.g. from ``load_user_hooks()``).
    #: ``None`` means "no hooks configured for this run" and skips dispatch
    #: entirely — the common case for every caller that never sets it.
    hook_config: Any = None
    #: Optional ``(dispatch: agent.hooks.UserHookDispatch) -> None`` observer,
    #: invoked after every Pre/PostToolUse dispatch this context makes, so a
    #: host that wants to log or surface hook activity (e.g. code_bridge.py's
    #: ``/hooks`` status view and live ``hook_dispatch`` event) can do so
    #: without this module knowing anything about bridges or wire events. An
    #: exception raised by the sink is swallowed — an observer must never be
    #: able to affect whether a tool call proceeds.
    hook_sink: "Callable[[Any], None] | None" = None
    #: Identifies this context's file-checkpoint store (``.sophia/checkpoints/<run_id>/``
    #: under ``root`` — see ``_checkpoint_root`` below). Auto-generated so every fresh
    #: ToolContext gets its own isolated undo history with zero caller wiring; a host
    #: that already tracks a real per-turn run id (e.g. code_bridge.py's bridge run)
    #: can assign ``ctx.run_id`` after construction to align the two.
    run_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    #: Cheap cooperative cancellation predicate supplied by an interactive host.
    #: Search/read tools poll it between filesystem units so a TUI cancellation
    #: does not wait for an entire broad traversal to finish.
    cancel_check: "Callable[[], bool] | None" = None
    #: Optional host-authored deterministic call limits. These limits are not
    #: model instructions: they are enforced here, immediately before a valid
    #: tool invocation is admitted. Supported keys are ``maxTotalCalls``,
    #: ``maxEquivalentCalls``, and ``maxCallsByTool``.
    tool_policy: "Mapping[str, Any] | None" = None
    tool_policy_counts: dict[str, int] = field(default_factory=dict)
    tool_policy_total_attempts: int = 0
    tool_policy_violations: list[dict[str, Any]] = field(default_factory=list)
    _tool_policy_lock: threading.Lock = field(
        default_factory=threading.Lock,
        repr=False,
    )

    def __post_init__(self) -> None:
        self.root = Path(self.root).resolve()
        if self.allowed_tools is not None and not isinstance(self.allowed_tools, (set, frozenset)):
            self.allowed_tools = set(self.allowed_tools)
        if self.subagent_allowed_tools is not None \
                and not isinstance(self.subagent_allowed_tools, (set, frozenset)):
            self.subagent_allowed_tools = set(self.subagent_allowed_tools)
        if self.tool_policy is not None and not isinstance(self.tool_policy, Mapping):
            self.tool_policy = None


@dataclass
class ToolResult:
    ok: bool
    tool: str
    output: str = ""
    error: str = ""
    error_type: str = ""
    retryable: bool = False
    expected: str = ""
    actual: str = ""
    exit_code: int | None = None

    def as_feedback(self) -> str:
        """The text handed back to the model for the next turn."""
        if self.ok:
            return self.output if self.output.strip() else "(tool succeeded, no output)"
        # Keep the historic ``ERROR: <message>`` prefix so existing agent loops keep
        # their recovery habit, but add a machine-readable envelope for training rows
        # and benchmark attribution.
        payload = {
            "ok": False,
            "tool": self.tool,
            "errorType": self.error_type or "tool_error",
            "retryable": bool(self.retryable),
            "message": self.error,
        }
        if self.expected:
            payload["expected"] = self.expected
        if self.actual:
            payload["actual"] = self.actual
        if self.exit_code is not None:
            payload["exitCode"] = self.exit_code
        if self.output and self.output != self.error:
            payload["output"] = self.output
        return "ERROR: " + json.dumps(payload, ensure_ascii=False, sort_keys=True)

    def to_step(self, args: dict | None = None, *, native: bool = False) -> dict:
        """Persist a tool receipt, including bash exitCode when the command ran."""
        step = {
            "tool": self.tool,
            "args": {} if args is None else args,
            "ok": self.ok,
            "output": self.output,
            "error": self.error,
            "errorType": self.error_type,
        }
        if native:
            step["native"] = True
        if self.exit_code is not None:
            step["exitCode"] = self.exit_code
        return step


# --------------------------------------------------------------------------- #
# Path confinement
# --------------------------------------------------------------------------- #
def _resolve_in_root(root: Path, path: str) -> Path:
    """Resolve ``path`` (relative to root, or absolute) and refuse to escape root."""
    if not path or not str(path).strip():
        raise ValueError("path is required")
    p = Path(path)
    resolved = (p if p.is_absolute() else root / p).resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"path escapes the working root: {path!r}")
    return resolved


def _tool_cancelled(ctx: ToolContext) -> bool:
    check = ctx.cancel_check
    if callable(check):
        try:
            if check():
                return True
        except Exception:
            # A liveness observer must not turn an otherwise valid tool call into
            # a crash. The authoritative budget cancellation flag below still
            # supplies a fail-closed fallback for bridge-hosted runs.
            pass
    budget = ctx.budget
    if budget is not None:
        try:
            return bool(budget.snapshot().cancelled)
        except Exception:
            pass
    return False


def _raise_if_cancelled(ctx: ToolContext) -> None:
    if _tool_cancelled(ctx):
        raise ToolCancelled("tool execution cancelled")


@dataclass
class _SearchScan:
    directories_visited: int = 0
    files_visited: int = 0
    files_matched: int = 0
    bytes_read: int = 0
    pruned_directories: int = 0
    truncated_reason: str = ""


def _contains_parts(haystack: tuple[str, ...], needle: tuple[str, ...]) -> bool:
    if not needle or len(needle) > len(haystack):
        return False
    return any(
        haystack[index:index + len(needle)] == needle
        for index in range(len(haystack) - len(needle) + 1)
    )


def _has_glob_magic(part: str) -> bool:
    return any(char in part for char in "*?[")


def _glob_matches(path_parts: tuple[str, ...], pattern_parts: tuple[str, ...]) -> bool:
    """Segment-aware glob matcher with ``**`` matching zero or more segments."""
    @lru_cache(maxsize=None)
    def match(path_index: int, pattern_index: int) -> bool:
        if pattern_index >= len(pattern_parts):
            return path_index >= len(path_parts)
        pattern = pattern_parts[pattern_index]
        if pattern == "**":
            return (
                match(path_index, pattern_index + 1)
                or (
                    path_index < len(path_parts)
                    and match(path_index + 1, pattern_index)
                )
            )
        return (
            path_index < len(path_parts)
            and fnmatchcase(path_parts[path_index], pattern)
            and match(path_index + 1, pattern_index + 1)
        )

    return match(0, 0)


def _pattern_explicitly_names(
    pattern_parts: tuple[str, ...],
    excluded_parts: tuple[str, ...],
) -> bool:
    literal_parts = tuple(
        part if not _has_glob_magic(part) and part != "**" else "\0"
        for part in pattern_parts
    )
    return _contains_parts(literal_parts, excluded_parts)


def _should_prune_search_dir(
    relative_parts: tuple[str, ...],
    pattern_parts: tuple[str, ...],
) -> bool:
    name = relative_parts[-1] if relative_parts else ""
    if (
        name in _SEARCH_SKIP_DIR_NAMES
        and not _pattern_explicitly_names(pattern_parts, (name,))
    ):
        return True
    if (
        any(name.startswith(prefix) for prefix in _SEARCH_SKIP_DIR_PREFIXES)
        and not _pattern_explicitly_names(pattern_parts, (name,))
    ):
        return True
    for excluded in _SEARCH_SKIP_PATHS:
        if (
            _contains_parts(relative_parts, excluded)
            and not _pattern_explicitly_names(pattern_parts, excluded)
        ):
            return True
    return False


def _iter_search_files(
    ctx: ToolContext,
    pattern: str,
    scan: _SearchScan,
):
    """Yield matching files without recursively entering default-heavy trees."""
    normalized = str(pattern or "").replace("\\", "/")
    if not normalized:
        raise ValueError("pattern is required")
    raw_parts = tuple(part for part in normalized.split("/") if part not in {"", "."})
    if not raw_parts:
        raise ValueError("pattern is required")

    first_magic = next(
        (index for index, part in enumerate(raw_parts) if part == "**" or _has_glob_magic(part)),
        len(raw_parts),
    )
    static_parts = raw_parts[:first_magic]
    static_path = "/".join(static_parts) or "."
    search_root = _resolve_in_root(ctx.root, static_path)

    if first_magic == len(raw_parts):
        _raise_if_cancelled(ctx)
        if search_root.is_file():
            scan.files_visited = 1
            scan.files_matched = 1
            yield search_root
        return
    if not search_root.is_dir():
        return

    for directory, dirnames, filenames in os.walk(search_root, followlinks=False):
        _raise_if_cancelled(ctx)
        scan.directories_visited += 1
        if scan.directories_visited > _SEARCH_MAX_DIRECTORIES:
            scan.truncated_reason = "directory_limit"
            return

        directory_path = Path(directory)
        try:
            relative_directory = directory_path.relative_to(ctx.root)
        except ValueError:
            raise ValueError(f"pattern escapes the working root: {pattern!r}") from None

        kept_dirs: list[str] = []
        for dirname in sorted(dirnames):
            relative_parts = relative_directory.parts + (dirname,)
            if _should_prune_search_dir(relative_parts, raw_parts):
                scan.pruned_directories += 1
                continue
            kept_dirs.append(dirname)
        dirnames[:] = kept_dirs

        for filename in sorted(filenames):
            _raise_if_cancelled(ctx)
            scan.files_visited += 1
            if scan.files_visited > _SEARCH_MAX_FILES:
                scan.truncated_reason = "file_limit"
                return
            path = directory_path / filename
            if path.is_symlink() or not path.is_file():
                continue
            relative_parts = path.relative_to(ctx.root).parts
            if _glob_matches(relative_parts, raw_parts):
                scan.files_matched += 1
                yield path


def _search_truncation(scan: _SearchScan) -> str:
    if not scan.truncated_reason:
        return ""
    return "\n… " + json.dumps({
        "type": "search_truncated",
        "reason": scan.truncated_reason,
        "directoriesVisited": scan.directories_visited,
        "filesVisited": scan.files_visited,
        "filesMatched": scan.files_matched,
        "bytesRead": scan.bytes_read,
        "prunedDirectories": scan.pruned_directories,
    }, sort_keys=True)


# --------------------------------------------------------------------------- #
# File checkpoints — a real undo path for write_file/edit_file
# --------------------------------------------------------------------------- #
# Until this existed, the only checkpoint in the TUI snapshotted the chat
# transcript; nothing anywhere recorded a file's *prior bytes*, so a bad write or
# edit had no way back except asking the model to "please revert that" and hoping
# it reconstructs the original text correctly. The store below records the bytes
# (or the fact that there were none) before every approved mutation, confined to
# ``<root>/.sophia/checkpoints/<run_id>/`` — inside the workspace root the same
# way every other file tool is, so "never snapshot outside the workspace root" is
# structural rather than a rule someone has to remember to check.
_CHECKPOINT_MAX_ENTRIES = 200
_CHECKPOINT_MAX_TOTAL_BYTES = 50 * 1024 * 1024  # 50 MB per run — generous, still bounded


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _checkpoint_root(ctx: "ToolContext") -> Path:
    return ctx.root / ".sophia" / "checkpoints" / ctx.run_id


def _checkpoint_index_path(store: Path) -> Path:
    return store / "index.json"


def _load_checkpoint_index(store: Path) -> list[dict[str, Any]]:
    idx_path = _checkpoint_index_path(store)
    if not idx_path.is_file():
        return []
    try:
        data = json.loads(idx_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # A corrupt or half-written index must never crash a write/edit call — it
        # just means this run's undo history is unrecoverable, not that the tool
        # itself should fail.
        return []
    return data if isinstance(data, list) else []


def _entry_blob_bytes(store: Path, entry: dict[str, Any]) -> int:
    backup_rel = entry.get("backupPath")
    if not backup_rel:
        return 0
    try:
        return (store / backup_rel).stat().st_size
    except OSError:
        return 0


def _save_checkpoint_index(store: Path, entries: list[dict[str, Any]]) -> None:
    # Evict the OLDEST entries first (both the index row and its blob file) until
    # the store satisfies both bounds, so one long run's checkpoints can never
    # grow into an unbounded disk liability.
    while entries and (
        len(entries) > _CHECKPOINT_MAX_ENTRIES
        or sum(_entry_blob_bytes(store, e) for e in entries) > _CHECKPOINT_MAX_TOTAL_BYTES
    ):
        oldest = entries.pop(0)
        backup_rel = oldest.get("backupPath")
        if backup_rel:
            (store / backup_rel).unlink(missing_ok=True)
    atomic_write_json(_checkpoint_index_path(store), entries)


def _capture_checkpoint(ctx: "ToolContext", tool: str, target: Path) -> None:
    """Snapshot ``target``'s current bytes (or its absence) before a mutation.

    Called synchronously, before the caller's own write, so a crash mid-write can
    never race ahead of the backup. Best-effort by design: a failure here (a
    read-only ``.sophia`` dir, a disk-full condition, an unreadable file) must
    never block the write_file/edit_file call that triggered it — losing undo
    coverage for one call is a far smaller failure than turning a successful edit
    into a crash.
    """
    try:
        rel = target.relative_to(ctx.root).as_posix()
    except ValueError:
        return  # unreachable in practice: target always comes from _resolve_in_root
    existed = target.is_file()
    try:
        data = target.read_bytes() if existed else None
    except OSError:
        return  # can't snapshot an unreadable file — don't fake a backup that isn't there
    store = _checkpoint_root(ctx)
    entry_id = f"cp-{uuid.uuid4().hex[:10]}"
    backup_rel: str | None = None
    try:
        if data is not None:
            backup_rel = f"{entry_id}.blob"
            store.mkdir(parents=True, exist_ok=True)
            (store / backup_rel).write_bytes(data)
        entries = _load_checkpoint_index(store)
        entries.append({
            "id": entry_id, "path": rel, "existed": existed,
            "backupPath": backup_rel, "ts": _now_iso(), "tool": tool,
        })
        _save_checkpoint_index(store, entries)
    except OSError:
        return


def list_checkpoints(ctx: "ToolContext") -> list[dict[str, Any]]:
    """Return this run's captured checkpoints, oldest first."""
    return _load_checkpoint_index(_checkpoint_root(ctx))


def _apply_checkpoint_restore(ctx: "ToolContext", entry: dict[str, Any]) -> "ToolResult":
    rel_path = str(entry.get("path", ""))
    try:
        target = _resolve_in_root(ctx.root, rel_path)
    except ValueError as exc:
        return ToolResult(False, "checkpoint_restore", error=str(exc),
                           error_type="invalid_path", retryable=False)
    store = _checkpoint_root(ctx)
    try:
        if entry.get("existed"):
            backup_rel = entry.get("backupPath")
            if not backup_rel:
                return ToolResult(False, "checkpoint_restore",
                                   error="checkpoint record is missing its backup blob",
                                   error_type="corrupt_checkpoint", retryable=False)
            data = (store / backup_rel).read_bytes()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            action = "restored"
        else:
            # The path did not exist before the recorded mutation — undoing it
            # means deleting whatever now exists there, not writing empty bytes.
            target.unlink(missing_ok=True)
            action = "deleted"
    except OSError as exc:
        return ToolResult(False, "checkpoint_restore", error=f"{type(exc).__name__}: {exc}",
                           error_type="restore_failed", retryable=True)
    return ToolResult(True, "checkpoint_restore",
                       output=f"{action} {rel_path} (checkpoint {entry.get('id')})")


def restore_checkpoint(ctx: "ToolContext", checkpoint_id: str) -> "ToolResult":
    """Restore exactly one prior file state by checkpoint id.

    Recreates a deleted file, reverts a modified file to its pre-mutation bytes,
    or deletes a file that did not exist before the recorded mutation — mirroring
    whichever of those three cases the original write_file/edit_file call produced.
    """
    entries = _load_checkpoint_index(_checkpoint_root(ctx))
    entry = next((e for e in entries if e.get("id") == checkpoint_id), None)
    if entry is None:
        return ToolResult(False, "checkpoint_restore", error=f"unknown checkpoint id {checkpoint_id!r}",
                           error_type="not_found", retryable=False)
    return _apply_checkpoint_restore(ctx, entry)


def undo_last_checkpoint(ctx: "ToolContext") -> "ToolResult":
    """Restore the most recently captured checkpoint for this run."""
    entries = _load_checkpoint_index(_checkpoint_root(ctx))
    if not entries:
        return ToolResult(False, "checkpoint_restore", error="no checkpoints recorded for this run",
                           error_type="not_found", retryable=False)
    return _apply_checkpoint_restore(ctx, entries[-1])


# --------------------------------------------------------------------------- #
# Tool implementations (each: (args: dict, ctx: ToolContext) -> str)
# --------------------------------------------------------------------------- #
def _container_file_backend(ctx: ToolContext):
    """Return the sandbox backend iff it is a container with file-IO helpers.

    The terminal-bench handler sets ``ctx.sandbox`` to an AppleContainerBackend
    (or similar) that, beyond the bash ``run_shell`` contract, also exposes
    ``read_file``/``write_file`` for bridging host tool calls into the container.
    When such a backend is present, the file tools route through it so the agent
    reads/writes the container's ``/app`` rather than the host workdir. Returns
    ``None`` for the ordinary host-root case (no behavior change).
    """
    sb = getattr(ctx, "sandbox", None)
    if sb is not None and hasattr(sb, "read_file") and hasattr(sb, "write_file"):
        return sb
    return None


def _t_read_file(args: dict, ctx: ToolContext) -> str:
    _raise_if_cancelled(ctx)
    path = str(args.get("path", "")).strip()
    cbe = _container_file_backend(ctx)
    if cbe is not None:
        # Container path (e.g. /app/regex.txt) — read straight from the backend.
        if not path:
            raise ValueError("path is required")
        text = cbe.read_file(path)
        _raise_if_cancelled(ctx)
        lines = text.splitlines()
        offset = int(args.get("offset", 0) or 0)
        limit = args.get("limit")
        chosen = lines[offset: offset + int(limit)] if limit else lines[offset:]
        width = len(str(offset + len(chosen)))
        return "\n".join(f"{offset + i + 1:>{width}}  {ln}" for i, ln in enumerate(chosen)) or "(empty file)"
    p = _resolve_in_root(ctx.root, path)
    if not p.is_file():
        raise ValueError(f"not a file: {args.get('path')!r}")
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    _raise_if_cancelled(ctx)
    offset = int(args.get("offset", 0) or 0)
    limit = args.get("limit")
    chosen = lines[offset: offset + int(limit)] if limit else lines[offset:]
    width = len(str(offset + len(chosen)))
    return "\n".join(f"{offset + i + 1:>{width}}  {ln}" for i, ln in enumerate(chosen)) or "(empty file)"


def _t_write_file(args: dict, ctx: ToolContext) -> str:
    path = str(args.get("path", "")).strip()
    content = args.get("content", "")
    if content is None:
        raise ValueError("content is required")
    cbe = _container_file_backend(ctx)
    if cbe is not None:
        if not path:
            raise ValueError("path is required")
        cbe.write_file(path, str(content))
        return f"wrote {path} ({len(str(content))} bytes) [in container]"
    p = _resolve_in_root(ctx.root, path)
    _capture_checkpoint(ctx, "write_file", p)
    p.parent.mkdir(parents=True, exist_ok=True)
    existed = p.exists()
    p.write_text(str(content), encoding="utf-8")
    return f"{'overwrote' if existed else 'created'} {p.relative_to(ctx.root)} ({len(str(content))} bytes)"


def _t_edit_file(args: dict, ctx: ToolContext) -> str:
    path = str(args.get("path", "")).strip()
    old, new = args.get("old", ""), args.get("new", "")
    if not old:
        raise ValueError("'old' string is required (the exact text to replace)")
    cbe = _container_file_backend(ctx)
    if cbe is not None:
        if not path:
            raise ValueError("path is required")
        text = cbe.read_file(path)
        n = text.count(old)
        if n == 0:
            raise ValueError("'old' string not found in file")
        if n > 1:
            raise ValueError(f"'old' string is not unique ({n} matches) — add surrounding context")
        cbe.write_file(path, text.replace(old, new, 1))
        return f"edited {path} (1 replacement) [in container]"
    p = _resolve_in_root(ctx.root, path)
    if not p.is_file():
        raise ValueError(f"not a file: {args.get('path')!r}")
    text = p.read_text(encoding="utf-8")
    n = text.count(old)
    if n == 0:
        raise ValueError("'old' string not found in file")
    if n > 1:
        raise ValueError(f"'old' string is not unique ({n} matches) — add surrounding context")
    _capture_checkpoint(ctx, "edit_file", p)
    p.write_text(text.replace(old, new, 1), encoding="utf-8")
    return f"edited {p.relative_to(ctx.root)} (1 replacement)"


def _t_list_dir(args: dict, ctx: ToolContext) -> str:
    _raise_if_cancelled(ctx)
    p = _resolve_in_root(ctx.root, args.get("path", "."))
    if not p.is_dir():
        raise ValueError(f"not a directory: {args.get('path')!r}")
    entries = sorted(p.iterdir(), key=lambda x: (x.is_file(), x.name))
    rows = [f"{'d' if e.is_dir() else 'f'}  {e.relative_to(ctx.root)}" for e in entries]
    return "\n".join(rows) or "(empty directory)"


def _t_glob(args: dict, ctx: ToolContext) -> str:
    pattern = args.get("pattern", "")
    if not pattern:
        raise ValueError("pattern is required (e.g. '**/*.py')")
    scan = _SearchScan()
    matches: list[str] = []
    for path in _iter_search_files(ctx, str(pattern), scan):
        matches.append(str(path.relative_to(ctx.root)))
        if len(matches) > _SEARCH_MAX_MATCHES:
            scan.truncated_reason = "match_limit"
            matches = matches[:_SEARCH_MAX_MATCHES]
            break
    matches.sort()
    body = "\n".join(matches) if matches else "(no matches)"
    return body + _search_truncation(scan)


def _t_grep(args: dict, ctx: ToolContext) -> str:
    pattern = args.get("pattern", "")
    if not pattern:
        raise ValueError("pattern is required (a regular expression)")
    # Models and human operators routinely use ``path`` for an exact file even
    # though grep historically named this selector ``glob``. Treat path as a
    # compatibility alias instead of burning a bounded agent turn on a strict
    # additional-property error. If both are supplied they must agree so the
    # alias can never make scope ambiguous.
    file_glob = args.get("glob")
    file_path = args.get("path")
    if file_glob and file_path and str(file_glob) != str(file_path):
        raise ValueError("'glob' and 'path' disagree; provide only one file selector")
    file_glob = file_path or file_glob or "**/*"
    try:
        rx = re.compile(pattern)
    except re.error as exc:
        raise ValueError(f"invalid regex: {exc}") from exc
    hits: list[str] = []
    scan = _SearchScan()
    for f in _iter_search_files(ctx, str(file_glob), scan):
        try:
            with f.open("rb") as handle:
                for i, raw_line in enumerate(handle, 1):
                    if i == 1 or i % 64 == 0:
                        _raise_if_cancelled(ctx)
                    if scan.bytes_read + len(raw_line) > _SEARCH_MAX_BYTES:
                        scan.truncated_reason = "byte_limit"
                        body = "\n".join(hits) if hits else "(no matches)"
                        return body + _search_truncation(scan)
                    scan.bytes_read += len(raw_line)
                    line = raw_line.decode("utf-8", errors="replace")
                    if not rx.search(line):
                        continue
                    hits.append(f"{f.relative_to(ctx.root)}:{i}: {line.strip()[:200]}")
                    if len(hits) >= _SEARCH_MAX_MATCHES:
                        scan.truncated_reason = "match_limit"
                        return "\n".join(hits) + _search_truncation(scan)
        except OSError:
            continue
    body = "\n".join(hits) if hits else "(no matches)"
    return body + _search_truncation(scan)


def _t_bash(args: dict, ctx: ToolContext) -> ToolResult:
    command = str(args.get("command", "")).strip()
    if not command:
        raise ValueError("command is required")
    # Optional sandbox backend (agent/sandbox/). Contract: run_shell(cmd, *, timeout,
    # cwd) -> (returncode, combined_output). When absent, run directly in the root.
    if ctx.sandbox is not None and hasattr(ctx.sandbox, "run_shell"):
        rc, out = ctx.sandbox.run_shell(command, timeout=ctx.bash_timeout, cwd=str(ctx.root))
    else:
        from agent.model import credential_env_names

        env = {key: value for key, value in os.environ.items() if key not in credential_env_names()}
        env.pop("ANTHROPIC_AUTH_TOKEN", None)
        proc = subprocess.run(command, shell=True, cwd=str(ctx.root), capture_output=True,
                              text=True, timeout=ctx.bash_timeout, env=env)
        rc = proc.returncode
        out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
    text = out.strip() or "(no output)"
    if rc == 0:
        return ToolResult(True, "bash", output=text, exit_code=0)
    tagged = f"[exit {rc}]\n{text}"
    return ToolResult(
        False,
        "bash",
        output=tagged,
        error=tagged,
        error_type="nonzero_exit",
        retryable=True,
        exit_code=rc,
    )


# --------------------------------------------------------------------------- #
# todo_write — a real model-driven checklist, not one generic placeholder node
# --------------------------------------------------------------------------- #
# Without this, a single-agent run has no way to tell the operator "here is my
# actual plan and which step I'm on" — the To-do panel only ever showed one
# generic node for the whole run. RISK_SAFE: it mutates no files and runs no
# code, only records the model's own stated checklist so the host can render
# it. Bounded on three independent axes so a model that calls it every step (or
# hallucinates an enormous list) cannot turn a "safe" tool into unbounded work:
# per-call item count (schema maxItems), per-item text length, and total calls
# allowed in one run (tracked on the context itself, since schema validation is
# stateless per call and cannot see across calls).
_TODO_STATUS_VALUES = ("pending", "in_progress", "completed")
_TODO_WRITE_MAX_ITEMS = 50
_TODO_WRITE_MAX_CONTENT_CHARS = 400
_TODO_WRITE_MAX_CALLS_PER_RUN = 200
_TODO_STATUS_MARKERS = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]"}


def _t_todo_write(args: dict, ctx: ToolContext) -> str:
    calls = getattr(ctx, "_todo_write_calls", 0) + 1
    ctx._todo_write_calls = calls  # type: ignore[attr-defined]
    if calls > _TODO_WRITE_MAX_CALLS_PER_RUN:
        raise ValueError(
            f"todo_write has been called {calls} times this run "
            f"(limit {_TODO_WRITE_MAX_CALLS_PER_RUN}); stop calling it every step"
        )
    items = args.get("items") or []
    if not items:
        return "(to-do list cleared)"
    lines = []
    for i, item in enumerate(items, start=1):
        content = str(item.get("content", "")).strip()[:_TODO_WRITE_MAX_CONTENT_CHARS] or "(empty)"
        status = str(item.get("status", "pending"))
        marker = _TODO_STATUS_MARKERS.get(status, "[ ]")
        lines.append(f"{marker} {i}. {content}")
    return "\n".join(lines)


@dataclass
class ToolSpec:
    name: str
    risk: str
    description: str
    args: dict[str, str] = field(default_factory=dict)   # arg name -> human description
    fn: "Callable[[dict, ToolContext], str | ToolResult]" = None  # type: ignore[assignment]
    schema: dict[str, Any] | None = None                 # strict JSON schema for args
    requires_confirmation: bool = False                 # explicit even in auto mode

    def parameters_schema(self) -> dict[str, Any]:
        """Return the fail-closed argument schema exposed to native tool callers.

        Plugin authors can provide ``schema`` explicitly. Legacy ``args`` specs are
        still supported, but they now compile to a strict object schema where every
        listed key is a string and unknown keys are rejected. Core tools below use
        explicit schemas so numeric/bool optionals stay typed.
        """
        if self.schema is not None:
            return self.schema
        optional_markers = ("optional", "default", "if set", "when set")
        required = [
            name for name, desc in self.args.items()
            if not any(marker in desc.lower() for marker in optional_markers)
        ]
        def _legacy_prop(desc: str) -> dict[str, Any]:
            lowered = desc.lower()
            if "bool" in lowered:
                return {"type": "boolean", "description": desc}
            if "int" in lowered or "step budget" in lowered:
                return {"type": "integer", "description": desc}
            return {"type": "string", "description": desc}

        return {
            "type": "object",
            "properties": {name: _legacy_prop(desc) for name, desc in self.args.items()},
            "required": required,
            "additionalProperties": False,
        }




def _obj_schema(properties: dict[str, dict[str, Any]], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def _string(desc: str, *, min_length: int = 0) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "string", "description": desc}
    if min_length:
        out["minLength"] = min_length
    return out


def _integer(desc: str) -> dict[str, Any]:
    return {"type": "integer", "description": desc}


def _boolean(desc: str) -> dict[str, Any]:
    return {"type": "boolean", "description": desc}

TOOLS: dict[str, ToolSpec] = {
    "read_file": ToolSpec(
        "read_file", RISK_SAFE, "Read a UTF-8 text file (line-numbered).",
        {"path": "file path (relative to the working root)",
         "offset": "optional: 0-based first line", "limit": "optional: max lines"},
        _t_read_file,
        _obj_schema({
            "path": _string("file path (relative to the working root)", min_length=1),
            "offset": _integer("optional: 0-based first line"),
            "limit": _integer("optional: max lines"),
        }, ["path"]),
    ),
    "list_dir": ToolSpec(
        "list_dir", RISK_SAFE, "List a directory's entries.",
        {"path": "directory path (default '.')"}, _t_list_dir,
        _obj_schema({"path": _string("directory path (default '.')")}, []),
    ),
    "glob": ToolSpec(
        "glob", RISK_SAFE, "Find files by glob pattern.",
        {"pattern": "e.g. '**/*.py' or 'agent/*.py'"}, _t_glob,
        _obj_schema({"pattern": _string("e.g. '**/*.py' or 'agent/*.py'", min_length=1)}, ["pattern"]),
    ),
    "grep": ToolSpec(
        "grep", RISK_SAFE, "Search file contents by regex.",
        {
            "pattern": "a regular expression",
            "glob": "optional file glob (default '**/*')",
            "path": "optional exact-file alias for glob",
        },
        _t_grep,
        _obj_schema({
            "pattern": _string("a regular expression", min_length=1),
            "glob": _string("optional file glob (default '**/*')"),
            "path": _string("optional exact-file alias for glob"),
        }, ["pattern"]),
    ),
    "write_file": ToolSpec(
        "write_file", RISK_WRITE, "Create or overwrite a file.",
        {"path": "file path", "content": "full file content"}, _t_write_file,
        _obj_schema({
            "path": _string("file path", min_length=1),
            "content": _string("full file content"),
        }, ["path", "content"]),
    ),
    "edit_file": ToolSpec(
        "edit_file", RISK_WRITE, "Replace one unique occurrence of a string in a file.",
        {"path": "file path", "old": "exact text to replace (must be unique)",
         "new": "replacement text"},
        _t_edit_file,
        _obj_schema({
            "path": _string("file path", min_length=1),
            "old": _string("exact text to replace (must be unique)", min_length=1),
            "new": _string("replacement text"),
        }, ["path", "old", "new"]),
    ),
    "bash": ToolSpec(
        "bash", RISK_EXEC, "Run a shell command in the working root.",
        {"command": "the shell command"}, _t_bash,
        _obj_schema({"command": _string("the shell command", min_length=1)}, ["command"]),
    ),
    "todo_write": ToolSpec(
        "todo_write", RISK_SAFE,
        "Replace the run's visible to-do checklist with the given steps (mutates no "
        "files); call again with updated statuses as steps start/finish so progress "
        "is genuinely tracked instead of announced in prose.",
        {"items": "the full current list of {content, status} steps — each call replaces the whole list"},
        _t_todo_write,
        _obj_schema({
            "items": {
                "type": "array",
                "description": "the full current to-do list; each call replaces it entirely",
                "items": _obj_schema({
                    "content": _string("short imperative description of the step", min_length=1),
                    "status": {
                        "type": "string",
                        "enum": list(_TODO_STATUS_VALUES),
                        "description": "pending | in_progress | completed",
                    },
                }, ["content", "status"]),
                "maxItems": _TODO_WRITE_MAX_ITEMS,
            },
        }, ["items"]),
    ),
}


_EXT_CACHE: "dict[str, ToolSpec] | None" = None


def all_tools(*, refresh: bool = False) -> "dict[str, ToolSpec]":
    """Core tools plus any auto-discovered plugins under ``agent/tools_ext/``.

    Plugins are discovered lazily and cached. A plugin whose optional dependency is
    missing simply fails to import and is skipped — it never breaks the core tools."""
    global _EXT_CACHE
    if _EXT_CACHE is None or refresh:
        merged = dict(TOOLS)
        try:
            from agent.tools_ext import discover_ext_tools
            merged.update(discover_ext_tools())
        except Exception:  # noqa: BLE001 - the plugin layer must never break core tools
            pass
        _EXT_CACHE = merged
    return _EXT_CACHE


class ToolPreview(str):
    """A one-line approval preview that also carries the full context an approver needs.

    ``ctx.approver`` is a fixed ``(name, preview) -> bool`` contract with live callers
    that predate this module — agent/cli.py's y/N prompt f-strings ``preview`` straight
    into the terminal, agent/code_bridge.py's ``_GuiApprover`` runs it through a plain
    ``str(preview)`` length cap. Both treat the second argument as *a string*. Rather
    than widen the contract to ``str | dict`` (which would make ``preview`` itself
    correct for a caller that knows to check, and a page of ``{'kind': ...}`` repr text
    for one that doesn't), this subclasses ``str``: every existing caller keeps working
    completely unchanged — they still see the short summary line below — while a caller
    written to look for it can read ``.diff``/``.kind``/``.risk``/``.destructive``
    without the wire type of the second argument ever changing for the one that can't.
    """

    diff: str = ""
    kind: str = ""
    risk: str = ""
    destructive: bool = False

    def __new__(
        cls, line: str, *, diff: str = "", kind: str = "", risk: str = "", destructive: bool = False,
    ) -> "ToolPreview":
        obj = str.__new__(cls, line)
        obj.diff = diff
        obj.kind = kind
        obj.risk = risk
        obj.destructive = destructive
        return obj


def _read_text_or_none(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _read_existing_for_preview(ctx: "ToolContext", raw_path: str) -> str | None:
    """Best-effort read of ``raw_path``'s current text, for diffing only.

    Mirrors the container-vs-host branch _t_write_file/_t_edit_file use for the
    real mutation, so a preview built while a container ExecBackend is active
    diffs against the container's file, not a same-named host path that may not
    exist or may hold something unrelated. Any failure here (new path, binary,
    unreadable, escapes root) just means "nothing to diff against" — the real
    tool call still runs its own authoritative checks after approval.
    """
    if not raw_path.strip():
        return None
    cbe = _container_file_backend(ctx)
    if cbe is not None:
        try:
            return cbe.read_file(raw_path)
        except Exception:  # noqa: BLE001 - preview-only best effort, never the authoritative read
            return None
    try:
        resolved = _resolve_in_root(ctx.root, raw_path)
    except ValueError:
        return None
    return _read_text_or_none(resolved)


def _preview(name: str, args: dict, ctx: "ToolContext", spec: "ToolSpec", *, destructive: bool) -> ToolPreview:
    if name == "bash":
        return ToolPreview(f"$ {args.get('command', '')}", risk=spec.risk, destructive=destructive)
    if name in {"write_file", "edit_file"}:
        raw_path = str(args.get("path", ""))
        existing = _read_existing_for_preview(ctx, raw_path)
        if name == "write_file":
            info = diff_preview.build_write_preview(raw_path, existing, str(args.get("content", "")))
            line = f"{'create' if info['kind'] == 'new_file' else 'overwrite'} {raw_path}"
        else:
            info = diff_preview.build_edit_preview(
                raw_path, existing or "", str(args.get("old", "")), str(args.get("new", "")),
            )
            line = f"edit {raw_path}"
        # The diff can contain whatever text the file/model put there — redact it
        # through the same boundary every tool result already passes through before
        # it can leave the process via ctx.approver -> the CLI/GUI transport.
        diff = _redact(info["diff"])
        return ToolPreview(line, diff=diff, kind=info["kind"], risk=spec.risk, destructive=destructive)
    return ToolPreview(f"{name} {args}", risk=spec.risk, destructive=destructive)


# --------------------------------------------------------------------------- #
# Destructive-command detection (approval-trust escalation)
# --------------------------------------------------------------------------- #
# Deliberately narrow, and deliberately NOT a general risk classifier (a client-side
# UI heuristic already fills that role). This exists only to force a second, explicit
# confirmation on the handful of invocations that destroy data with no local undo —
# a recursive+forced delete, a rewritten remote git history, a dropped/truncated
# database object — even when the caller is otherwise in unattended "auto" mode.
# Conservative per the caller's own contract: a spelling this misses just costs one
# fewer speed bump (acceptable), but silently treating a real match as safe would be
# a false reassurance (not acceptable) — so this only ever grows, never narrows.
_COMMAND_SEPARATORS = (";", "&&", "||", "|")
#: Argument names conventionally holding command/query text for a plugin tool that
#: is not ``bash`` itself (a future SQL-executing or script-running tool). Deliberately
#: excludes write_file/edit_file's path/content/old/new — those hold a FILE'S literal
#: content, and scanning it would flag any source file that merely mentions "drop
#: table" in a comment or test fixture as a destructive invocation.
_COMMAND_LIKE_ARG_NAMES = ("command", "cmd", "sql", "query", "script", "shell")
_DB_DROP_TRUNCATE_RE = re.compile(r"\b(?:drop|truncate)\s+(?:table|database|schema|index|collection)\b")


def _split_shell_tokens(text: str) -> list[str]:
    normalized = text
    for sep in _COMMAND_SEPARATORS:
        normalized = normalized.replace(sep, f" {sep} ")
    return normalized.split()


def _mentions_rm_recursive_force(lowered: str) -> bool:
    tokens = _split_shell_tokens(lowered)
    for i, tok in enumerate(tokens):
        if tok != "rm":
            continue
        has_r = has_f = False
        for w in tokens[i + 1:]:
            if w in _COMMAND_SEPARATORS:
                break  # end of this particular rm invocation
            if w == "--recursive":
                has_r = True
            elif w == "--force":
                has_f = True
            elif w.startswith("-") and not w.startswith("--"):
                letters = w[1:]
                has_r = has_r or "r" in letters
                has_f = has_f or "f" in letters
        if has_r and has_f:
            return True
    return False


def _mentions_force_push(lowered: str) -> bool:
    tokens = lowered.split()
    for i, tok in enumerate(tokens[:-1]):
        if tok != "git" or tokens[i + 1] != "push":
            continue
        for w in tokens[i + 2:]:
            if w in ("-f", "--force") or w.startswith("--force-with-lease"):
                return True
    return False


def _is_destructive_text(text: str) -> bool:
    if not text:
        return False
    lowered = text.lower()
    return (
        _mentions_rm_recursive_force(lowered)
        or _mentions_force_push(lowered)
        or bool(_DB_DROP_TRUNCATE_RE.search(lowered))
    )


def is_destructive_invocation(name: str, args: dict[str, Any]) -> bool:
    """Conservative, explicitly-tested check for a small set of catastrophic invocations.

    ``bash`` is checked directly on its ``command`` argument. Any other tool is
    checked only on the conventionally command/query-shaped argument names in
    ``_COMMAND_LIKE_ARG_NAMES`` — new core tools never need to be added here by
    hand as long as a future exec/SQL-shaped plugin names its argument that way.
    """
    if name == "bash":
        return _is_destructive_text(str(args.get("command", "")))
    return any(
        isinstance(args.get(arg_name), str) and _is_destructive_text(args[arg_name])
        for arg_name in _COMMAND_LIKE_ARG_NAMES
    )


def _schema_error_type(msg: str) -> str:
    if "additional property" in msg:
        return "schema_extra_arg"
    if "missing required property" in msg:
        return "schema_missing_arg"
    if "not in enum" in msg:
        return "enum_invalid"
    if "expected type" in msg:
        return "schema_type_invalid"
    return "schema_invalid"


def validate_tool_args(spec: ToolSpec, args: Any) -> tuple[dict[str, Any] | None, list[str]]:
    if not isinstance(args, dict):
        return None, [f"$: expected type object, got {type(args).__name__} for {spec.name} arguments"]
    errors = _validate_schema(args, spec.parameters_schema())
    return (dict(args), errors) if not errors else (None, errors)


def _positive_policy_limit(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _tool_policy_key(name: str, args: Mapping[str, Any]) -> str:
    return json.dumps(
        {"tool": name, "args": dict(args)},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def _enforce_tool_policy(
    ctx: ToolContext,
    name: str,
    args: Mapping[str, Any],
) -> "ToolResult | None":
    """Admit one validated call or return an authoritative policy denial.

    An admitted attempt is counted before execution. A failed lookup therefore
    still consumes its one-call receipt and an equivalent retry is denied.
    """
    policy = ctx.tool_policy
    if not isinstance(policy, Mapping) or not policy:
        return None
    key = _tool_policy_key(name, args)
    with ctx._tool_policy_lock:
        max_total = _positive_policy_limit(policy.get("maxTotalCalls"))
        max_equivalent = _positive_policy_limit(policy.get("maxEquivalentCalls"))
        by_tool = policy.get("maxCallsByTool")
        max_for_tool = (
            _positive_policy_limit(by_tool.get(name))
            if isinstance(by_tool, Mapping)
            else None
        )
        equivalent_attempts = int(ctx.tool_policy_counts.get(key, 0))
        tool_attempts = int(ctx.tool_policy_counts.get(f"tool:{name}", 0))
        error_type = ""
        expected = ""
        actual = ""
        if max_total is not None and ctx.tool_policy_total_attempts >= max_total:
            error_type = "tool_policy_denied"
            expected = f"total tool calls <= {max_total}"
            actual = str(ctx.tool_policy_total_attempts + 1)
        elif (
            max_equivalent is not None
            and equivalent_attempts >= max_equivalent
        ):
            error_type = "duplicate_tool_call_denied"
            expected = f"equivalent calls <= {max_equivalent}"
            actual = str(equivalent_attempts + 1)
        elif max_for_tool is not None and tool_attempts >= max_for_tool:
            error_type = "tool_policy_denied"
            expected = f"{name} calls <= {max_for_tool}"
            actual = str(tool_attempts + 1)
        if error_type:
            violation = {
                "tool": name,
                "args": dict(args),
                "errorType": error_type,
                "expected": expected,
                "actual": actual,
            }
            ctx.tool_policy_violations.append(violation)
            return ToolResult(
                False,
                name,
                error=f"blocked by deterministic tool policy: {expected}",
                error_type=error_type,
                retryable=False,
                expected=expected,
                actual=actual,
            )
        ctx.tool_policy_total_attempts += 1
        ctx.tool_policy_counts[key] = equivalent_attempts + 1
        ctx.tool_policy_counts[f"tool:{name}"] = tool_attempts + 1
    return None


# --------------------------------------------------------------------------- #
# PreToolUse / PostToolUse hook enforcement
# --------------------------------------------------------------------------- #
# Before this, the config-driven hook engine (agent/hooks.py) was only ever
# consulted from the manual-approval confirmation dialog — so a PreToolUse rule
# written to DENY a call silently never ran for a read-only tool, or for ANY
# tool call under permission=auto (the one mode with no human in the loop to
# catch what the hook missed). Dispatching here, at the single place every
# permission mode already passes through before a tool's `fn` runs, closes
# that gap for every mode and every caller of this module at once, instead of
# teaching each permission path the same lesson separately.
def _notify_hook_sink(ctx: ToolContext, dispatch: Any) -> None:
    sink = ctx.hook_sink
    if sink is None:
        return
    try:
        sink(dispatch)
    except Exception:  # noqa: BLE001 - an observer must never be able to break tool execution
        pass


def _dispatch_pre_tool_hook(ctx: ToolContext, name: str, args: dict[str, Any]) -> "ToolResult | None":
    """Consult any configured PreToolUse hooks before ``name`` executes.

    Returns ``None`` when the call may proceed: no hook config on this
    context, no rule matched ``name``, or every matching hook allowed it.
    Returns a denial ``ToolResult`` otherwise — including when the hook
    engine itself raises, since a broken engine that fails open would be
    indistinguishable from "no hook was ever configured" to everything
    downstream. Fail-closed here, not fail-open, is the whole point.
    """
    config = ctx.hook_config
    if config is None:
        return None
    try:
        dispatch = user_hooks.dispatch_user_hooks(
            config, user_hooks.HookEvent.PRE_TOOL_USE, name, payload={"args": args},
        )
    except Exception as exc:  # noqa: BLE001 - fail-closed: an engine failure must deny, not allow
        dispatch = user_hooks.UserHookDispatch(
            event=user_hooks.HookEvent.PRE_TOOL_USE, tool_id=name, allowed=False,
            reason=f"PreToolUse hook engine raised (denying fail-closed): {type(exc).__name__}: {exc}",
        )
        _notify_hook_sink(ctx, dispatch)
        return ToolResult(
            False, name, error=dispatch.reason,
            error_type="hook_engine_error", retryable=False,
            expected="hook engine available", actual="hook engine raised",
        )
    _notify_hook_sink(ctx, dispatch)
    if not dispatch.allowed:
        return ToolResult(
            False, name,
            error=f"blocked by PreToolUse hook ({dispatch.blocked_by or 'unknown command'}): {dispatch.reason}",
            error_type="hook_denied", retryable=False,
            expected="hook approval", actual=dispatch.blocked_by or "denied",
        )
    return None


def _dispatch_post_tool_hook(ctx: ToolContext, name: str, result: "ToolResult") -> None:
    """Observe-only PostToolUse dispatch, run after ``name`` has already executed.

    Never raises and never changes ``result`` — hooks.py's own contract is that
    PostToolUse cannot retroactively fail a call that already completed; a
    broken hook here is a lost audit note, not a reason to misreport the tool's
    actual outcome to the model or the caller.
    """
    config = ctx.hook_config
    if config is None:
        return
    try:
        outcome_text = (result.output if result.ok else result.error)[:800]
        dispatch = user_hooks.dispatch_user_hooks(
            config, user_hooks.HookEvent.POST_TOOL_USE, name,
            payload={"ok": result.ok, "output": outcome_text},
        )
    except Exception:  # noqa: BLE001 - observe-only: never let a broken engine touch a finished result
        return
    _notify_hook_sink(ctx, dispatch)


def execute_tool(name: str, args: dict, ctx: ToolContext) -> ToolResult:
    """Run a tool under strict schema validation + permission policy.

    Validation happens before permission prompts and before execution. This keeps the
    model-facing tool contract honest: extra/missing/mistyped fields are rejected as
    structured, retryable schema errors and never reach side-effecting code.
    """
    registry = all_tools()
    spec = registry.get(name)
    if spec is None:
        return ToolResult(
            False, name,
            error=f"unknown tool {name!r}; available: {', '.join(registry)}",
            error_type="unknown_tool", retryable=True,
            expected=", ".join(registry), actual=name,
        )

    # Least-privilege allow-list (delegated lanes / SwarmRouter children). Checked
    # BEFORE schema work and BEFORE the permission prompt so a child cannot
    # spend an operator approval on a tool it was never scoped to use.
    if ctx.allowed_tools is not None and name not in ctx.allowed_tools:
        allowed = ", ".join(sorted(ctx.allowed_tools)) or "(none)"
        return ToolResult(
            False, name,
            error=f"blocked: {name} is outside this lane's allowed_tools {{{allowed}}}",
            error_type="scope_denied", retryable=False,
            expected=allowed, actual=name,
        )

    raw_args = {} if args is None else args
    clean_args, schema_errors = validate_tool_args(spec, raw_args)
    if schema_errors:
        return ToolResult(
            False, name, error="; ".join(schema_errors[:3]),
            error_type=_schema_error_type(schema_errors[0]), retryable=True,
            expected=str(spec.parameters_schema()), actual=str(args or {}),
        )

    assert clean_args is not None

    policy_denial = _enforce_tool_policy(ctx, name, clean_args)
    if policy_denial is not None:
        return policy_denial

    # Universal PreToolUse gate: every permission mode reaches this line before
    # any RISK_SAFE tool runs or any write/exec tool even asks for approval, so
    # an operator's hook denial holds regardless of readonly/approve/auto.
    hook_denial = _dispatch_pre_tool_hook(ctx, name, clean_args)
    if hook_denial is not None:
        return hook_denial

    permission_gated = spec.risk not in {RISK_SAFE, RISK_GOVERNANCE}
    if permission_gated:
        if ctx.permission == "readonly":
            return ToolResult(
                False, name, error=f"blocked: {name} is {spec.risk} and mode is readonly",
                error_type="permission_denied", retryable=False,
                expected="permission=approve|auto", actual="permission=readonly",
            )
    destructive = permission_gated and is_destructive_invocation(name, clean_args)
    # A tool-level confirmation requirement is stronger than its broad risk class:
    # governance/read tools can still cross an operator-defined privacy boundary.
    # "auto" normally means unattended, but a destructive match must likewise
    # receive explicit confirmation.
    if (
        spec.requires_confirmation
        or (permission_gated and ctx.permission == "approve")
        or (permission_gated and ctx.permission == "auto" and destructive)
    ):
        preview = _preview(name, clean_args, ctx, spec, destructive=destructive)
        approved = bool(ctx.approver and ctx.approver(name, preview))
        if not approved:
            if spec.requires_confirmation:
                return ToolResult(
                    False,
                    name,
                    error=f"blocked: {name} requires explicit operator confirmation",
                    error_type="operator_confirmation_required",
                    retryable=False,
                    expected="operator confirmation",
                    actual="denied",
                )
            if ctx.permission == "auto":
                return ToolResult(
                    False, name,
                    error=f"blocked: {name} matches a destructive pattern and needs "
                          f"explicit confirmation even in auto mode",
                    error_type="destructive_confirmation_required", retryable=False,
                    expected="operator confirmation", actual="denied",
                )
            return ToolResult(
                False, name, error=f"denied: {name} not approved by operator",
                error_type="operator_denied", retryable=False,
                expected="operator approval", actual="denied",
            )
    # "auto" (non-destructive) falls through — the operator opted into unattended execution.
    try:
        raw = spec.fn(clean_args, ctx)
    except ToolCancelled as exc:
        result = ToolResult(
            False, name, error=str(exc) or "tool execution cancelled",
            error_type="cancelled", retryable=False,
        )
        _dispatch_post_tool_hook(ctx, name, result)
        return result
    except subprocess.TimeoutExpired:
        result = ToolResult(
            False, name, error=f"timeout after {ctx.bash_timeout}s",
            error_type="timeout", retryable=True,
        )
        _dispatch_post_tool_hook(ctx, name, result)
        return result
    except Exception as exc:  # noqa: BLE001 - surface the failure to the model, don't crash the loop
        result = ToolResult(
            False, name, error=f"{type(exc).__name__}: {exc}",
            error_type="tool_runtime_error", retryable=True,
        )
        _dispatch_post_tool_hook(ctx, name, result)
        return result
    if isinstance(raw, ToolResult):
        output = _redact(raw.output or "")
        error = _redact(raw.error or "")
        if len(output) > ctx.max_output:
            output = output[: ctx.max_output] + f"\n… (truncated at {ctx.max_output} chars)"
        if len(error) > ctx.max_output:
            error = error[: ctx.max_output] + f"\n… (truncated at {ctx.max_output} chars)"
        result = ToolResult(
            raw.ok,
            name,
            output=output,
            error=error,
            error_type=raw.error_type,
            retryable=raw.retryable,
            expected=raw.expected,
            actual=raw.actual,
            exit_code=raw.exit_code,
        )
    else:
        safe = _redact(raw)
        if len(safe) > ctx.max_output:
            safe = safe[: ctx.max_output] + f"\n… (truncated at {ctx.max_output} chars)"
        result = ToolResult(True, name, output=safe)
    _dispatch_post_tool_hook(ctx, name, result)
    return result


def tool_specs_text(allowed_tools: "set[str] | frozenset[str] | None" = None) -> str:
    """Render the toolset (core + discovered plugins) for the system prompt.

    When ``allowed_tools`` is set, only those names are listed (lane least
    privilege). ``None`` lists the full surface — the historical default.
    """
    lines = ["Available tools:"]
    for spec in all_tools().values():
        if allowed_tools is not None and spec.name not in allowed_tools:
            continue
        arglist = ", ".join(f"{k} ({v})" for k, v in spec.args.items())
        lines.append(f"- {spec.name} [{spec.risk}]: {spec.description}  args: {arglist}")
    if allowed_tools is not None and len(lines) == 1:
        lines.append("(none in lane allowed_tools scope)")
    return "\n".join(lines)


def tool_function_schemas(allowed_tools: "set[str] | frozenset[str] | None" = None) -> list[dict]:
    """Return OpenAI-style function schemas for direct/native tool calling.

    This is the "kernel" surface: in-process tools are exposed to a model as real
    functions, while the old JSON-in-text protocol remains as a fallback for local
    or CLI transports that do not support native tool calls. Parameters are the
    strict schemas returned by ``ToolSpec.parameters_schema()``: unknown arguments
    are rejected and core/plugin optionals preserve their declared string/int/bool
    types before any permission prompt or execution.

    When ``allowed_tools`` is set, only those names are exposed. ``None`` is the
    full surface (byte-identical default).
    """
    schemas: list[dict] = []
    for spec in all_tools().values():
        if allowed_tools is not None and spec.name not in allowed_tools:
            continue
        schemas.append({
            "type": "function",
            "function": {
                "name": spec.name,
                "description": f"[{spec.risk}] {spec.description}",
                "parameters": spec.parameters_schema(),
            },
        })
    return schemas


__all__ = [
    "ToolContext", "ToolResult", "ToolSpec", "ToolCancelled", "TOOLS", "ToolPreview",
    "execute_tool", "validate_tool_args", "tool_specs_text", "tool_function_schemas", "all_tools",
    "RISK_SAFE", "RISK_GOVERNANCE", "RISK_WRITE", "RISK_EXEC",
    "is_destructive_invocation",
    "list_checkpoints", "restore_checkpoint", "undo_last_checkpoint",
]
