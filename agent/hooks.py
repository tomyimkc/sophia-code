# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Lifecycle hook bus — deterministic, named steering events (Stage A).

Sophia already enforces its guarantees *inside* ``gateway/interceptor.py`` (the
fail-closed pipeline) and ``agent/dataflow/interpreter.py`` (the CaMeL-style
constrained executor). What was missing was a **named, reusable lifecycle
abstraction** so those guarantees can be (a) externally legible, (b) extended
without editing the interceptor body, and (c) snapshotted before context
compaction so the audit trail survives long-horizon runs.

This module is that abstraction. It is dependency-free, offline, and
deterministic — the steering discipline lives in code the harness runs, never in
a prompt instruction (the central lesson the design imports from the Claude Code
steering model: a real guardrail must be enforcement, not a "never do this"
string).

Events
------
  - ``SESSION_START``   : a session/run begins.
  - ``PRE_TOOL_USE``    : before a tool executes. A handler may **block**
                          (fail-closed) — the canonical guardrail point.
  - ``POST_TOOL_USE``   : after a tool executes / is verified. Observe only.
  - ``PRE_COMPACT``     : before context compaction. Handlers persist a durable
                          snapshot (belief-graph / provenance delta).
  - ``SESSION_END``     : a session/run ends.

Decision contract (fail-closed)
-------------------------------
A ``PRE_TOOL_USE`` handler returns a :class:`HookDecision` (or ``None`` = allow).
If *any* handler blocks, the action is blocked. A handler that *raises* is treated
as a block on ``PRE_TOOL_USE`` (fail-closed: a broken guardrail must not silently
open) but as a no-op on observe-only events (availability over a missed
annotation, matching the repo's existing "loud but non-fatal" audit convention).
"""

from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
from dataclasses import dataclass, field
from enum import Enum
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any, Callable, Mapping


class HookEvent(str, Enum):
    SESSION_START = "SessionStart"
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    PRE_COMPACT = "PreCompact"
    SESSION_END = "SessionEnd"
    # End-of-run analogue of SESSION_END, named to match the operator-facing
    # vocabulary the config-driven engine below uses (a "Stop" hook, not a
    # "SessionEnd" hook) — kept as a distinct member rather than reusing
    # SESSION_END so a config file can name it without relying on an alias.
    STOP = "Stop"


#: Events at which a handler is permitted to *block* the pending action.
BLOCKING_EVENTS = frozenset({HookEvent.PRE_TOOL_USE})


@dataclass(frozen=True)
class HookContext:
    """Immutable payload passed to every handler.

    ``event``    the lifecycle event being dispatched.
    ``tool_id``  the tool about to run / that ran (None for session/compact events).
    ``args``     the call arguments (read-only view; handlers must not mutate).
    ``payload``  free-form, event-specific extra data (verdict, snapshot target...).
    """

    event: "HookEvent"
    tool_id: "str | None" = None
    args: dict = field(default_factory=dict)
    payload: dict = field(default_factory=dict)


@dataclass(frozen=True)
class HookDecision:
    """A handler's verdict on a pending action.

    ``allow``   False blocks the action (fail-closed) on a blocking event.
    ``reason``  human/audit explanation, always set when blocking.
    ``source``  the handler name, for audit attribution.
    """

    allow: bool = True
    reason: str = ""
    source: str = ""


# A handler maps a context to a decision (or None == allow / observe-only).
Handler = Callable[["HookContext"], "HookDecision | None"]


@dataclass(frozen=True)
class DispatchResult:
    """Aggregate outcome of dispatching one event to all its handlers."""

    event: "HookEvent"
    allowed: bool
    decisions: tuple = ()      # tuple[HookDecision] from handlers that returned one
    blocked_by: "str | None" = None
    reason: str = ""

    @property
    def blocked(self) -> bool:
        return not self.allowed


class HookBus:
    """Register handlers per event and dispatch deterministically.

    Handlers run in registration order. The bus is fail-closed on blocking
    events: an exception in a ``PRE_TOOL_USE`` handler counts as a block, so a
    crashing guardrail can never let an action through.
    """

    def __init__(self) -> None:
        self._handlers: dict = {e: [] for e in HookEvent}

    def register(self, event: "HookEvent", handler: "Handler", *, name: "str | None" = None) -> "HookBus":
        """Register ``handler`` for ``event``. ``name`` is used for audit/blocked_by;
        defaults to the handler's ``__name__``. Returns self for chaining."""
        if event not in self._handlers:
            raise ValueError(f"unknown hook event {event!r}")
        handler_name = name or getattr(handler, "__name__", repr(handler))
        self._handlers[event].append((handler_name, handler))
        return self

    def handlers(self, event: "HookEvent") -> "list[str]":
        return [n for n, _ in self._handlers.get(event, [])]

    def dispatch(self, ctx: "HookContext") -> "DispatchResult":
        """Run every handler for ``ctx.event``.

        On a blocking event the first handler that returns ``allow=False`` (or
        raises) short-circuits and blocks. On an observe-only event every handler
        runs and exceptions are swallowed (loud-but-non-fatal), never blocking.
        """
        event = ctx.event
        is_blocking = event in BLOCKING_EVENTS
        decisions: list = []
        for name, handler in self._handlers.get(event, []):
            try:
                decision = handler(ctx)
            except Exception as exc:  # noqa: BLE001 - intentional fail-closed/observe split
                if is_blocking:
                    return DispatchResult(
                        event=event, allowed=False,
                        decisions=tuple(decisions),
                        blocked_by=name,
                        reason=f"handler {name!r} raised (fail-closed): {exc!r}",
                    )
                continue  # observe-only: a broken annotator must not stall the run
            if decision is None:
                continue
            if isinstance(decision, bool):  # tolerate a bare bool for ergonomics
                decision = HookDecision(allow=decision, source=name)
            if not decision.source:
                decision = HookDecision(allow=decision.allow, reason=decision.reason, source=name)
            decisions.append(decision)
            if is_blocking and not decision.allow:
                return DispatchResult(
                    event=event, allowed=False,
                    decisions=tuple(decisions),
                    blocked_by=decision.source,
                    reason=decision.reason or f"blocked by {decision.source}",
                )
        return DispatchResult(event=event, allowed=True, decisions=tuple(decisions))


# ----------------------------------------------------------------------------- #
# Ready-made handlers for the common Sophia guardrails.
# ----------------------------------------------------------------------------- #
def make_provenance_pretool_guard(*, require_provenance: bool = True) -> "Handler":
    """A ``PRE_TOOL_USE`` guard that fails closed when a side-effecting call lacks
    declared provenance/clearance.

    This expresses, as a *named hook*, the same discipline the interceptor already
    enforces inline: a write/external tool must carry a clearance and the caller
    must not be anonymous. It only *adds* a fail-closed check; it never relaxes
    the interceptor.
    """

    def _guard(ctx: "HookContext") -> "HookDecision | None":
        if not require_provenance:
            return None
        side_effects = ctx.payload.get("side_effects", "read")
        if side_effects in ("write", "external"):
            clearance = ctx.payload.get("clearance")
            role = ctx.payload.get("role")
            if not clearance or not role:
                return HookDecision(
                    allow=False,
                    reason=(f"fail-closed: side-effecting tool {ctx.tool_id!r} "
                            f"requires both role and clearance "
                            f"(role={role!r}, clearance={clearance!r})"),
                )
        return None

    return _guard


def make_precompact_snapshot(sink: "Callable[[dict], Any]") -> "Handler":
    """A ``PRE_COMPACT`` handler that hands the snapshot payload to ``sink`` (e.g.
    append-to-jsonl) so the belief-graph / provenance delta survives compaction.

    ``sink`` receives the ``ctx.payload`` dict (plus the event name). Exceptions
    are swallowed by the bus on this observe-only event, so a failing sink cannot
    stall a run — but should itself log loudly per repo convention.
    """

    def _snapshot(ctx: "HookContext") -> None:
        sink({"event": ctx.event.value, **ctx.payload})
        return None

    return _snapshot


def make_conscience_pretool_guard(*, default_high_impact: bool = True) -> "Handler":
    """A PRE_TOOL_USE guard backed by :mod:`agent.conscience_enforcement`.

    Imported lazily to avoid a hard dependency cycle. High-impact tool calls with
    conscience verdict block/abstain/escalate/retrieve/clarify/revise are blocked
    fail-closed unless the caller explicitly marks them low-impact.
    """
    from agent.conscience_enforcement import make_conscience_pretool_guard as _mk
    return _mk(default_high_impact=default_high_impact)


# ----------------------------------------------------------------------------- #
# User-configurable hook engine (operator-authored, config-driven).
#
# Everything above this line is an in-process Python API: a HookBus handler is
# a Python callable an embedder registers directly, right for guardrails baked
# into Sophia itself. It is the wrong shape for the power-user feature of "run
# my own command when a tool fires" — an operator does not want to edit Python
# to add a formatter-on-write hook. This section adds a second, config-driven
# layer: hooks named in an operator-authored TOML file and run as
# subprocesses. It reuses HookEvent so both layers speak the same event names,
# but is otherwise independent of HookBus — a shell command and a Python
# callable are different trust boundaries and gain nothing from sharing a
# dispatch loop.
#
# Security model: a hook here runs an arbitrary local command chosen by
# whoever can write ``.sophia/hooks.toml`` — never model-generated content,
# and never anything derived from a tool call's arguments. Given that, every
# failure mode below defaults to the outcome that is safest for the human at
# the keyboard, not the most permissive one for the run:
#   * a broken config disables hooks ENTIRELY, not "hooks minus the broken
#     row" — a half-parsed config is exactly the state most likely to hide a
#     typo, so the failure signature must be "nothing runs", never "something
#     unreviewed runs";
#   * a PreToolUse hook that exits non-zero (or times out) BLOCKS the tool
#     call, the same fail-closed contract ``HookBus.dispatch`` already applies
#     above, and the decision is always returned, never swallowed;
#   * a hook that will not exit is killed by process GROUP (``os.killpg``), so
#     a command that forks — a shell pipeline, a backgrounded watcher — cannot
#     outlive the timeout by hiding in a grandchild;
#   * captured output is bounded, THEN redacted, before anything downstream
#     (a ``/hooks`` status view, an audit log) can render it, so a hook that
#     echoes an environment variable can never leak a credential into the UI.
# ----------------------------------------------------------------------------- #

#: Hook events the config-driven engine accepts in a ``.sophia/hooks.toml``
#: row. A subset of HookEvent — PRE_COMPACT/SESSION_START stay Python-API-only
#: (they carry belief-graph/session payloads no shell command should see).
USER_HOOK_EVENTS = frozenset({HookEvent.PRE_TOOL_USE, HookEvent.POST_TOOL_USE, HookEvent.STOP})

DEFAULT_HOOK_TIMEOUT_SEC = 10.0
#: Hard ceiling on an operator-set ``timeout_sec``. Without this a typo'd
#: ``timeout_sec = 36000`` would let a single misconfigured hook stall a run
#: for hours; the ceiling keeps "worst case" bounded even when the operator
#: fat-fingers the config.
MAX_HOOK_TIMEOUT_SEC = 120.0
MAX_HOOK_OUTPUT_CHARS = 4000
_TRUNCATION_MARKER = "…[truncated]"


@dataclass(frozen=True)
class UserHookRule:
    """One operator-authored ``[[hooks]]`` row, already validated."""

    event: "HookEvent"
    matcher: str
    command: "tuple[str, ...]"
    timeout_sec: float = DEFAULT_HOOK_TIMEOUT_SEC

    def matches(self, tool_id: "str | None") -> bool:
        """Case-sensitive glob match against a tool id (``fnmatchcase`` — plain
        ``fnmatch`` normalizes case on some platforms, which would make a
        matcher like ``Write_File`` behave differently on macOS than Linux)."""
        return fnmatchcase(tool_id or "", self.matcher)


@dataclass(frozen=True)
class UserHookConfig:
    """Result of loading ``.sophia/hooks.toml``: usable rules, or disabled.

    ``enabled`` is False both when no config file exists (nothing to run —
    not an error) and when a config file exists but is malformed (an error,
    and hooks are OFF rather than partially applied). ``error`` distinguishes
    the two for a ``/hooks`` status view: ``None`` means "no config found", a
    string means "found but rejected, here is why".
    """

    rules: "tuple[UserHookRule, ...]" = ()
    enabled: bool = False
    error: "str | None" = None
    source: "str | None" = None


def _coerce_hook_command(raw: Any, *, row_desc: str) -> "tuple[str, ...]":
    if isinstance(raw, str):
        parts = tuple(shlex.split(raw))
    elif isinstance(raw, list) and raw and all(isinstance(item, str) for item in raw):
        parts = tuple(raw)
    else:
        raise ValueError(f"{row_desc}: 'command' must be a non-empty string or list of strings")
    if not parts:
        raise ValueError(f"{row_desc}: 'command' must not be empty")
    return parts


def _parse_user_hook_rows(rows: Any) -> "tuple[UserHookRule, ...]":
    if not isinstance(rows, list):
        raise ValueError("top-level 'hooks' must be an array of tables (use [[hooks]])")
    allowed_events = {event.value for event in USER_HOOK_EVENTS}
    rules: list[UserHookRule] = []
    for index, row in enumerate(rows):
        row_desc = f"hooks[{index}]"
        if not isinstance(row, dict):
            raise ValueError(f"{row_desc}: must be a table")
        event_name = row.get("event")
        if event_name not in allowed_events:
            raise ValueError(
                f"{row_desc}: 'event' must be one of {sorted(allowed_events)}, got {event_name!r}"
            )
        matcher = row.get("matcher", "*")
        if not isinstance(matcher, str) or not matcher:
            raise ValueError(f"{row_desc}: 'matcher' must be a non-empty string")
        command = _coerce_hook_command(row.get("command"), row_desc=row_desc)
        timeout_raw = row.get("timeout_sec", DEFAULT_HOOK_TIMEOUT_SEC)
        try:
            timeout_sec = float(timeout_raw)
        except (TypeError, ValueError):
            raise ValueError(f"{row_desc}: 'timeout_sec' must be a number") from None
        if not (0 < timeout_sec <= MAX_HOOK_TIMEOUT_SEC):
            raise ValueError(f"{row_desc}: 'timeout_sec' must be within (0, {MAX_HOOK_TIMEOUT_SEC}]")
        rules.append(UserHookRule(
            event=HookEvent(event_name), matcher=matcher, command=command, timeout_sec=timeout_sec,
        ))
    return tuple(rules)


def _default_hook_config_candidates(environ: "Mapping[str, str] | None" = None) -> "list[Path]":
    env = os.environ if environ is None else environ
    candidates = [Path.home() / ".sophia" / "hooks.toml"]
    try:
        # Lazy + guarded: runtime_paths is a small, dependency-free module, but
        # importing it at module scope would make agent.hooks import order
        # matter for every existing HookBus caller (gateway/interceptor.py,
        # agent/conscience_enforcement.py) for a feature those callers never use.
        from agent.runtime_paths import workspace_dir
        candidates.append(workspace_dir() / ".sophia" / "hooks.toml")
    except Exception:
        candidates.append(Path.cwd() / ".sophia" / "hooks.toml")
    override = str(env.get("SOPHIA_HOOKS_CONFIG", "") or "").strip()
    if override:
        candidates.append(Path(override).expanduser())
    return candidates


def load_user_hooks(
    path: "str | Path | None" = None,
    *,
    environ: "Mapping[str, str] | None" = None,
) -> "UserHookConfig":
    """Load operator-authored hooks from ``.sophia/hooks.toml``.

    Precedence mirrors the rest of Sophia's layered config (see
    ``agent/cli.py:_load_code_config``): ``~/.sophia/hooks.toml`` < workspace
    ``.sophia/hooks.toml`` < ``SOPHIA_HOOKS_CONFIG`` < an explicit ``path``
    argument — except hook ROWS are never merged across layers the way
    ``[code]`` keys are: whichever candidate exists and sorts last is read
    WHOLE. Merging would let a workspace-local file silently add commands to
    a set the operator never reviewed together; a hook engine is exactly the
    surface where "the file I looked at is the file that runs" must hold.

    Never raises. Returns a disabled config on every failure mode: no file
    found (``error=None``), unparsable TOML, or a row failing schema
    validation (``error`` set, hooks OFF — never a partial rule set).
    """
    try:
        import tomllib
    except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
        import tomli as tomllib  # type: ignore[no-redef]

    candidates = [Path(path).expanduser()] if path is not None else _default_hook_config_candidates(environ)
    chosen: "Path | None" = None
    for candidate in candidates:
        try:
            if candidate.exists():
                chosen = candidate
        except OSError:
            continue
    if chosen is None:
        return UserHookConfig(rules=(), enabled=False, error=None, source=None)

    try:
        text = chosen.read_text(encoding="utf-8")
    except OSError as exc:
        return UserHookConfig(rules=(), enabled=False, error=f"could not read {chosen}: {exc}", source=str(chosen))

    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        return UserHookConfig(rules=(), enabled=False, error=f"invalid TOML in {chosen}: {exc}", source=str(chosen))

    try:
        rules = _parse_user_hook_rows(data.get("hooks", []))
    except ValueError as exc:
        return UserHookConfig(
            rules=(), enabled=False, error=f"invalid hook config in {chosen}: {exc}", source=str(chosen),
        )

    return UserHookConfig(rules=rules, enabled=True, error=None, source=str(chosen))


def _bounded_hook_text(text: "str | None") -> str:
    text = text or ""
    if len(text) > MAX_HOOK_OUTPUT_CHARS:
        return text[:MAX_HOOK_OUTPUT_CHARS] + _TRUNCATION_MARKER
    return text


def _redact_hook_text(text: str) -> str:
    try:
        from agent.secret_patterns import redact
    except Exception:
        # Fail toward LESS disclosure, not more: if the redaction helper
        # itself cannot be imported, withhold the capture rather than surface
        # an unredacted subprocess output to a status view or audit log.
        return "[hook output withheld: redaction helper unavailable]"
    return redact(text)


@dataclass(frozen=True)
class UserHookOutcome:
    """One executed hook's result, already bounded + redacted for display."""

    rule: "UserHookRule"
    ran: bool  # False only when the process could not even start (e.g. ENOENT)
    returncode: "int | None"
    timed_out: bool
    stdout: str
    stderr: str
    reason: str

    @property
    def ok(self) -> bool:
        return self.ran and not self.timed_out and self.returncode == 0


def _run_one_user_hook(rule: "UserHookRule", stdin_payload: "dict | None") -> "UserHookOutcome":
    """Run a single hook command in its own process group with a hard timeout.

    ``start_new_session=True`` makes the child the leader of a new process
    group, so a hung command AND anything it forked (a shell pipeline, a
    backgrounded watcher) is killed as a unit via ``os.killpg`` on timeout.
    Killing only the direct child (``proc.kill()``) would leave a forked
    grandchild running past the timeout — precisely the "hook that hangs"
    failure this exists to prevent. Mirrors the same rlimit-free
    process-group pattern ``agent/code_verifier.py:run_program`` already uses
    for sandboxed execution.
    """
    stdin_text = json.dumps(stdin_payload) if stdin_payload is not None else None
    try:
        proc = subprocess.Popen(
            list(rule.command),
            stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
    except OSError as exc:
        return UserHookOutcome(
            rule=rule, ran=False, returncode=None, timed_out=False,
            stdout="", stderr="", reason=f"could not start hook: {exc}",
        )
    try:
        out, err = proc.communicate(input=stdin_text, timeout=rule.timeout_sec)
        timed_out = False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
        out, err = proc.communicate()
        timed_out = True
    stdout = _redact_hook_text(_bounded_hook_text(out))
    stderr = _redact_hook_text(_bounded_hook_text(err))
    if timed_out:
        reason = f"hook timed out after {rule.timeout_sec}s and was killed (process group)"
    elif proc.returncode == 0:
        reason = "ok"
    else:
        reason = f"exit {proc.returncode}"
    return UserHookOutcome(
        rule=rule, ran=True, returncode=proc.returncode, timed_out=timed_out,
        stdout=stdout, stderr=stderr, reason=reason,
    )


@dataclass(frozen=True)
class UserHookDispatch:
    """Aggregate result of running every rule matching one (event, tool) pair."""

    event: "HookEvent"
    tool_id: "str | None"
    allowed: bool
    outcomes: "tuple[UserHookOutcome, ...]" = ()
    blocked_by: "str | None" = None
    reason: str = ""


def dispatch_user_hooks(
    config: "UserHookConfig",
    event: "HookEvent",
    tool_id: "str | None" = None,
    *,
    payload: "dict | None" = None,
) -> "UserHookDispatch":
    """Run every rule in ``config`` matching ``(event, tool_id)``.

    On ``PRE_TOOL_USE`` — the one blocking event here, same contract as
    ``HookBus`` above — the first hook that exits non-zero or times out
    BLOCKS and short-circuits; later matching hooks do not run, so a call is
    never allowed by one hook after another already denied it. On
    ``POST_TOOL_USE``/``STOP`` every matching hook runs regardless of exit
    code (observe-only): a formatter that fails must not retroactively fail a
    tool call that already completed.

    A disabled config (``config.enabled is False`` — no file, or a rejected
    malformed one) always returns ``allowed=True`` with zero outcomes: hooks
    being off is never itself a block, and nothing is ever run from a config
    that failed validation.
    """
    if not config.enabled:
        return UserHookDispatch(event=event, tool_id=tool_id, allowed=True, reason="hooks disabled")
    matching = [rule for rule in config.rules if rule.event == event and rule.matches(tool_id)]
    if not matching:
        return UserHookDispatch(event=event, tool_id=tool_id, allowed=True, reason="no matching hook")

    is_blocking = event == HookEvent.PRE_TOOL_USE
    stdin_payload = {"event": event.value, "tool": tool_id, **(payload or {})}
    outcomes: list[UserHookOutcome] = []
    for rule in matching:
        outcome = _run_one_user_hook(rule, stdin_payload)
        outcomes.append(outcome)
        if is_blocking and not outcome.ok:
            return UserHookDispatch(
                event=event, tool_id=tool_id, allowed=False,
                outcomes=tuple(outcomes),
                blocked_by=" ".join(rule.command),
                reason=outcome.reason,
            )
    return UserHookDispatch(event=event, tool_id=tool_id, allowed=True, outcomes=tuple(outcomes), reason="ok")


__all__ = [
    "HookEvent",
    "BLOCKING_EVENTS",
    "HookContext",
    "HookDecision",
    "HookBus",
    "DispatchResult",
    "Handler",
    "make_provenance_pretool_guard",
    "make_precompact_snapshot",
    "make_conscience_pretool_guard",
    "USER_HOOK_EVENTS",
    "DEFAULT_HOOK_TIMEOUT_SEC",
    "MAX_HOOK_TIMEOUT_SEC",
    "MAX_HOOK_OUTPUT_CHARS",
    "UserHookRule",
    "UserHookConfig",
    "UserHookOutcome",
    "UserHookDispatch",
    "load_user_hooks",
    "dispatch_user_hooks",
]
