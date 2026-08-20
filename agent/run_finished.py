# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Durable, connector-friendly publication for completed Sophia runs.

The bridge protocol remains the authoritative live stream.  This module mirrors
its ``run_finished`` payload into a small per-run state directory so scripts,
CI, bots, and MCP clients can wait without attaching to an Ink TTY.

Only lifecycle metadata is published here.  Prompts, assistant text, tool
arguments, credentials, and provider response bodies are intentionally absent.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import socket
import subprocess
import threading
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from agent.runtime_paths import user_state_dir


HOOK_TIMEOUT_SEC = 2.0


def _safe_component(value: str, *, prefix: str) -> str:
    """Return a readable path component, hashing path-like identifiers."""
    text = str(value or "")
    ordinary = (
        0 < len(text) <= 160
        and text not in {".", ".."}
        and text[0].isalnum()
        and all(char.isalnum() or char in "._-" for char in text)
    )
    if ordinary:
        return text
    digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:24]
    return f"{prefix}-{digest}"


def run_finished_dir(
    session: str,
    run_id: str,
    *,
    state_dir: Path | None = None,
) -> Path:
    """Return the canonical durable directory for one bridge run."""
    root = (state_dir or user_state_dir()).expanduser().resolve()
    return (
        root
        / "agent_runs"
        / _safe_component(session, prefix="session")
        / _safe_component(run_id, prefix="run")
    )


def run_finished_path(
    session: str,
    run_id: str,
    *,
    state_dir: Path | None = None,
) -> Path:
    return run_finished_dir(session, run_id, state_dir=state_dir) / "finished.json"


class RunFinishedPublisher:
    """Publish each session/run terminal payload at most once per process.

    The durable ``finished.json`` is also used as a cross-process idempotency
    fence.  Hooks are invoked only after both durable files have been written.
    Hook failures are deliberately fail-open: connector availability must not
    change whether the kernel can finish a run.
    """

    def __init__(self, *, state_dir: Path | None = None):
        self._state_dir = state_dir
        self._lock = threading.Lock()
        self._published: set[tuple[str, str]] = set()
        self._event_ids: set[tuple[str, str, str]] = set()

    def publish_event(self, payload: dict[str, Any]) -> bool:
        """Append one secret-free lifecycle event before terminal publication.

        ``finished.json`` remains the authoritative terminal fence. Once it
        exists, no later lifecycle event may be appended, which guarantees
        that the terminal ``run_finished`` receipt is always the final line of
        ``events.jsonl``.
        """
        session = str(payload.get("session") or "")
        run_id = str(payload.get("runId") or "")
        event_id = str(payload.get("eventId") or "")
        if (
            payload.get("schema") != "sophia.run-event.v1"
            or payload.get("type") != "run_event"
            or not session
            or not run_id
            or not event_id
        ):
            raise ValueError(
                "run event requires schema, type, session, runId, and eventId"
            )

        key = (session, run_id, event_id)
        with self._lock:
            target_dir = run_finished_dir(
                session,
                run_id,
                state_dir=self._state_dir,
            )
            finished_path = target_dir / "finished.json"
            if key in self._event_ids or finished_path.is_file():
                return False

            target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                os.chmod(target_dir, 0o700)
            except OSError:
                pass

            line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            events_path = target_dir / "events.jsonl"
            with events_path.open("a", encoding="utf-8") as stream:
                try:
                    os.fchmod(stream.fileno(), 0o600)
                except OSError:
                    pass
                stream.write(line + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            self._event_ids.add(key)
        return True

    def publish(self, payload: dict[str, Any]) -> bool:
        """Persist and fan out ``payload``; return false for a duplicate."""
        session = str(payload.get("session") or "")
        run_id = str(payload.get("runId") or "")
        if payload.get("type") != "run_finished" or not session or not run_id:
            raise ValueError("run_finished payload requires type, session, and runId")

        key = (session, run_id)
        with self._lock:
            target_dir = run_finished_dir(
                session,
                run_id,
                state_dir=self._state_dir,
            )
            finished_path = target_dir / "finished.json"
            if key in self._published or finished_path.is_file():
                self._published.add(key)
                return False

            target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                os.chmod(target_dir, 0o700)
            except OSError:
                pass

            line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            temp_path = target_dir / f".finished.{os.getpid()}.{uuid.uuid4().hex}.tmp"
            try:
                with temp_path.open("x", encoding="utf-8") as stream:
                    os.fchmod(stream.fileno(), 0o600)
                    stream.write(line + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temp_path, finished_path)
                except FileExistsError:
                    # Another bridge process won the same session/run race.
                    self._published.add(key)
                    return False
                except OSError as exc:
                    # Filesystems without hard-link support still get a
                    # best-effort atomic replacement. The normal local state
                    # directories use the create-only branch above.
                    if exc.errno not in {
                        errno.EOPNOTSUPP,
                        errno.ENOTSUP,
                        errno.EPERM,
                        errno.EXDEV,
                    }:
                        raise
                    if finished_path.is_file():
                        self._published.add(key)
                        return False
                    os.replace(temp_path, finished_path)
            finally:
                try:
                    temp_path.unlink()
                except FileNotFoundError:
                    pass

            # Append only after the create-only terminal fence succeeds. A
            # losing process therefore cannot duplicate events.jsonl.
            events_path = target_dir / "events.jsonl"
            with events_path.open("a", encoding="utf-8") as stream:
                try:
                    os.fchmod(stream.fileno(), 0o600)
                except OSError:
                    pass
                stream.write(line + "\n")
                stream.flush()
                os.fsync(stream.fileno())

            self._published.add(key)

        # Connectors are deliberately outside the publication lock: the file
        # is already the idempotency fence, and a slow hook must not block a
        # different run from becoming durable.
        self._notify_hook(line)
        self._notify_fd(line)
        self._notify_socket(line)
        return True

    @staticmethod
    def _notify_hook(line: str) -> None:
        hook = os.environ.get("SOPHIA_RUN_FINISHED_HOOK", "").strip()
        if not hook:
            return
        try:
            if hook.startswith(("http://", "https://")):
                request = urllib.request.Request(
                    hook,
                    data=line.encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=HOOK_TIMEOUT_SEC):
                    pass
                return
            path = Path(hook).expanduser()
            if path.is_file() and os.access(path, os.X_OK):
                subprocess.run(
                    [str(path)],
                    input=line + "\n",
                    text=True,
                    check=False,
                    timeout=HOOK_TIMEOUT_SEC,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        except Exception:
            # Outbound connector failures are telemetry failures, not run
            # failures.  The durable file remains the source of truth.
            return

    @staticmethod
    def _notify_fd(line: str) -> None:
        raw = os.environ.get("SOPHIA_RUN_FINISHED_FD", "").strip()
        if not raw:
            return
        try:
            fd = int(raw)
            if fd >= 0:
                pending = memoryview((line + "\n").encode("utf-8"))
                while pending:
                    written = os.write(fd, pending)
                    if written <= 0:
                        break
                    pending = pending[written:]
        except (OSError, TypeError, ValueError):
            return

    @staticmethod
    def _notify_socket(line: str) -> None:
        raw = os.environ.get("SOPHIA_RUN_FINISHED_SOCKET", "").strip()
        if not raw:
            return
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(HOOK_TIMEOUT_SEC)
                client.connect(str(Path(raw).expanduser()))
                client.sendall((line + "\n").encode("utf-8"))
        except OSError:
            return


__all__ = [
    "HOOK_TIMEOUT_SEC",
    "RunFinishedPublisher",
    "run_finished_dir",
    "run_finished_path",
]
