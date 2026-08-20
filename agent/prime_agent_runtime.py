# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Persistent Prime Agent RPC runtime for Sophia's optional external lane.

Prime Agent is an execution backend, not Sophia's policy authority.  This
adapter therefore does only four things:

1. launch a pinned ``prime-agent --mode rpc`` child;
2. preserve one child per Sophia session so Prime's own context can persist;
3. translate Prime JSONL events into content-minimized Sophia lifecycle events;
4. stop/abort only the child process this object created.

The wire protocol is line-feed framed.  The reader deliberately splits only on
``b"\\n"`` instead of using a generic text ``readline`` implementation: Unicode
U+2028/U+2029 are valid JSON string content and must not become record
separators.

This module does *not* claim that Prime's user-level process authority is a
sandbox or that Sophia's tool permission gate approved Prime's actions.
``candidateOnly`` and ``canClaimAGI:false`` are fixed in every public result.
"""
from __future__ import annotations

import json
import os
import queue
import re
import shlex
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

SCHEMA = "sophia.prime_agent_runtime.v1"
SUPPORTED_PRIME_AGENT_VERSION = "0.7.1"
DEFAULT_POLICY_MODE = "advisory"
_DEFAULT_ARGV = ("prime-agent", "--mode", "rpc")
_POLICY_STATUS_COMMAND = "sophia-policy-status"
_VERSION_RE = re.compile(r"(?<!\d)(\d+\.\d+\.\d+)(?!\d)")

NormalizedEventCallback = Callable[[dict[str, Any]], None]
UiRequestCallback = Callable[[dict[str, Any]], dict[str, Any] | None]


@dataclass(frozen=True)
class PrimeRunResult:
    """One terminal Prime turn, before Sophia's final delivery floor."""

    ok: bool
    text: str = ""
    error: str = ""
    meta: dict[str, Any] = field(default_factory=dict)
    candidateOnly: bool = True
    canClaimAGI: bool = False


class PrimeAgentRuntime:
    """One persistent Prime Agent RPC child.

    Instantiate one object per Sophia session.  ``run`` calls are serialized;
    Prime's RPC child remains alive between calls until :meth:`close`.
    """

    name = "prime"

    def __init__(
        self,
        *,
        argv: list[str] | tuple[str, ...] | None = None,
        cwd: str | Path | None = None,
        session_dir: str | Path | None = None,
        extension_path: str | Path | None = None,
        timeout_sec: float = 300.0,
        on_ui_request: UiRequestCallback | None = None,
        env: dict[str, str] | None = None,
        policy_mode: str = DEFAULT_POLICY_MODE,
        policy_verified: bool | None = None,
        require_pinned_version: bool = True,
    ) -> None:
        override = (
            os.environ.get("SOPHIA_PRIME_AGENT_COMMAND")
            or os.environ.get("SOPHIA_PI_RPC")
            or ""
        ).strip()
        self._explicit_argv = argv is not None or bool(override)
        if argv is not None:
            base_argv = list(argv)
        elif override:
            base_argv = shlex.split(override)
        else:
            base_argv = list(_DEFAULT_ARGV)

        self.cwd = str(Path(cwd).expanduser().resolve()) if cwd else None
        self.session_dir = (
            Path(session_dir).expanduser().resolve() if session_dir else None
        )
        self.extension_path = (
            Path(extension_path).expanduser().resolve() if extension_path else None
        )
        self.policy_mode = _normalize_policy_mode(policy_mode)
        self.timeout_sec = max(1.0, float(timeout_sec))
        self.on_ui_request = on_ui_request
        self.env = dict(env or {})
        self.require_pinned_version = bool(require_pinned_version)

        if not self._explicit_argv:
            if self.session_dir is not None:
                base_argv.extend(["--session-dir", str(self.session_dir)])
            if self.extension_path is not None:
                # Disable project/user resource discovery while preserving this
                # explicitly supplied CLI extension (Prime v0.7.1 semantics).
                base_argv.extend([
                    "--no-extensions",
                    "--no-skills",
                    "--no-prompt-templates",
                    "--no-context-files",
                    "-e",
                    str(self.extension_path),
                ])
        self.argv = base_argv

        if policy_verified is None:
            policy_verified = bool(
                self.extension_path
                and self.extension_path.is_file()
                and str(self.extension_path) in self.argv
            )
        self.policy_configured = bool(policy_verified)
        # Command-line presence is not proof that the extension loaded. This
        # flips true only after a live get_commands RPC handshake.
        self.policy_verified = False

        self._proc: subprocess.Popen[bytes] | None = None
        self._events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._reader_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._stderr_lock = threading.Lock()
        self._stderr_tail = ""
        self._write_lock = threading.Lock()
        self._run_lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._closed = False
        self._probed_version: str | None = None

    # -- public --------------------------------------------------------- #
    def available(self) -> bool:
        if not self.argv:
            return False
        head = self.argv[0]
        if os.path.isabs(head) or os.sep in head:
            return Path(head).is_file()
        return shutil.which(head) is not None

    @property
    def running(self) -> bool:
        proc = self._proc
        return proc is not None and proc.poll() is None

    @property
    def runtime_version(self) -> str:
        return self._probed_version or (
            "explicit-command-unverified"
            if self._explicit_argv
            else SUPPORTED_PRIME_AGENT_VERSION
        )

    def run(
        self,
        prompt: str,
        *,
        cancel_event: threading.Event | None = None,
        on_event: NormalizedEventCallback | None = None,
        on_ui_request: UiRequestCallback | None = None,
        timeout_sec: float | None = None,
    ) -> PrimeRunResult:
        clean = str(prompt or "").strip()
        if not clean:
            return self._failure("empty prompt")
        if not self.available():
            return self._failure(
                f"Prime Agent runtime not available: {self.argv[0]!r} not found"
            )
        if self._closed:
            return self._failure("Prime Agent runtime is closed")

        with self._run_lock:
            try:
                self._ensure_started()
                return self._run_locked(
                    clean,
                    cancel_event=cancel_event,
                    on_event=on_event,
                    on_ui_request=on_ui_request,
                    timeout_sec=timeout_sec,
                )
            except _PrimeRuntimeError as exc:
                return self._failure(str(exc), **exc.meta)

    def close(self, *, grace_sec: float = 2.0) -> None:
        """Gracefully stop this object's owned child only."""
        with self._lifecycle_lock:
            self._closed = True
            proc = self._proc
            self._proc = None
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
        except OSError:
            return
        try:
            proc.wait(timeout=max(0.1, grace_sec))
        except subprocess.TimeoutExpired:
            # This is the exact child created by this instance, not an arbitrary
            # PID discovered from the host.
            try:
                proc.kill()
                proc.wait(timeout=1.0)
            except (OSError, subprocess.TimeoutExpired):
                # The owned child ignored both graceful and forced shutdown.
                return

    # -- lifecycle ------------------------------------------------------ #
    def _ensure_started(self) -> None:
        with self._lifecycle_lock:
            if self.running:
                if self.policy_configured and not self.policy_verified:
                    raise _PrimeRuntimeError(
                        "Sophia's Prime Agent policy extension is no longer "
                        "verified; refusing another prompt until the runtime "
                        "is restarted."
                    )
                return
            self._drain_event_queue()
            self._validate_version()
            if self.session_dir is not None:
                self.session_dir.mkdir(parents=True, exist_ok=True)
            env = os.environ.copy()
            env.update(self.env)
            env.setdefault("SOPHIA_PRIME_POLICY", self.policy_mode)
            try:
                proc = subprocess.Popen(
                    self.argv,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=self.cwd,
                    env=env,
                    bufsize=0,
                    text=False,
                )
            except OSError as exc:
                raise _PrimeRuntimeError(
                    f"failed to spawn Prime Agent: {type(exc).__name__}: {exc}",
                    {"argv": list(self.argv)},
                ) from exc
            self._proc = proc
            self._reader_thread = threading.Thread(
                target=self._reader_loop,
                args=(proc,),
                name=f"prime-agent-rpc-{proc.pid}",
                daemon=True,
            )
            self._stderr_thread = threading.Thread(
                target=self._stderr_loop,
                args=(proc,),
                name=f"prime-agent-stderr-{proc.pid}",
                daemon=True,
            )
            self._reader_thread.start()
            self._stderr_thread.start()
            if self.policy_configured:
                self.policy_verified = False
                try:
                    self._verify_policy_extension_loaded()
                except _PrimeRuntimeError:
                    self._terminate_owned_process(proc)
                    self._proc = None
                    raise

    def _validate_version(self) -> None:
        if self._explicit_argv or not self.require_pinned_version:
            self._probed_version = (
                self._probed_version or "explicit-command-unverified"
            )
            return
        allow_unpinned = _truthy(os.environ.get("SOPHIA_PRIME_AGENT_ALLOW_UNPINNED"))
        try:
            probe = subprocess.run(
                [self.argv[0], "--version"],
                cwd=self.cwd,
                env={**os.environ, **self.env},
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=5.0,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            if allow_unpinned:
                self._probed_version = "unknown"
                return
            raise _PrimeRuntimeError(
                f"could not verify Prime Agent version: {type(exc).__name__}: {exc}"
            ) from exc
        match = _VERSION_RE.search(probe.stdout or "")
        version = match.group(1) if match else ""
        self._probed_version = version or "unknown"
        if version != SUPPORTED_PRIME_AGENT_VERSION and not allow_unpinned:
            raise _PrimeRuntimeError(
                "unsupported Prime Agent version "
                f"{version or 'unknown'}; Sophia pins {SUPPORTED_PRIME_AGENT_VERSION}. "
                "Install the pinned release or explicitly set "
                "SOPHIA_PRIME_AGENT_ALLOW_UNPINNED=1 for a candidate-only test."
            )

    def _verify_policy_extension_loaded(self) -> None:
        """Fail closed unless the live child reports Sophia's status command."""
        request_id = f"sophia-policy-{uuid.uuid4().hex[:12]}"
        self._send({"id": request_id, "type": "get_commands"})
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                raise _PrimeRuntimeError(
                    self._stderr_message(
                        "Prime Agent exited before policy extension verification"
                    )
                )
            try:
                kind, payload = self._events.get(timeout=0.05)
            except queue.Empty:
                continue
            if kind == "eof":
                raise _PrimeRuntimeError(
                    self._stderr_message(
                        "Prime Agent RPC closed before policy extension verification"
                    )
                )
            if kind != "json" or not isinstance(payload, dict):
                continue
            if payload.get("type") == "extension_error":
                raise _PrimeRuntimeError(
                    "Prime Agent policy extension failed to load: "
                    f"{payload.get('error') or payload.get('message') or 'extension_error'}"
                )
            if payload.get("type") != "response" or payload.get("id") != request_id:
                continue
            if payload.get("success") is not True:
                raise _PrimeRuntimeError(
                    "Prime Agent refused policy extension verification: "
                    f"{payload.get('error') or 'get_commands failed'}"
                )
            data = payload.get("data")
            commands = data.get("commands") if isinstance(data, dict) else None
            names = {
                str(item.get("name") or "")
                for item in commands or []
                if isinstance(item, dict)
            }
            if _POLICY_STATUS_COMMAND not in names:
                raise _PrimeRuntimeError(
                    "Sophia policy extension status command is absent; refusing "
                    "external execution fail-closed."
                )
            self.policy_verified = True
            return
        raise _PrimeRuntimeError(
            "timed out verifying Sophia's Prime Agent policy extension"
        )

    # -- protocol ------------------------------------------------------- #
    def _run_locked(
        self,
        prompt: str,
        *,
        cancel_event: threading.Event | None,
        on_event: NormalizedEventCallback | None,
        on_ui_request: UiRequestCallback | None,
        timeout_sec: float | None,
    ) -> PrimeRunResult:
        request_id = f"sophia-{uuid.uuid4().hex[:12]}"
        self._send({"id": request_id, "type": "prompt", "message": prompt})
        deadline = time.monotonic() + (
            self.timeout_sec if timeout_sec is None else max(1.0, float(timeout_sec))
        )
        chunks: list[str] = []
        final_candidates: list[str] = []
        tools_started = 0
        tools_finished = 0
        events_seen = 0
        noise_seen = 0
        accepted = False
        abort_sent = False

        while time.monotonic() < deadline:
            if cancel_event is not None and cancel_event.is_set() and not abort_sent:
                self._send({"type": "abort"})
                abort_sent = True
                _emit(on_event, {
                    "type": "external_abort_requested",
                    "runtime": "prime",
                    "candidateOnly": True,
                    "canClaimAGI": False,
                })

            proc = self._proc
            if proc is None:
                raise _PrimeRuntimeError("Prime Agent child disappeared")
            if proc.poll() is not None and self._events.empty():
                raise _PrimeRuntimeError(
                    self._stderr_message("Prime Agent exited before agent_end"),
                    {"returncode": proc.returncode},
                )
            try:
                kind, payload = self._events.get(timeout=0.05)
            except queue.Empty:
                continue
            if kind == "noise":
                noise_seen += 1
                continue
            if kind == "eof":
                raise _PrimeRuntimeError(
                    self._stderr_message("Prime Agent RPC stream closed before agent_end")
                )
            if kind != "json" or not isinstance(payload, dict):
                continue

            events_seen += 1
            etype = str(payload.get("type") or "")
            if etype == "response":
                if payload.get("id") == request_id:
                    accepted = payload.get("success") is not False
                    if not accepted:
                        raise _PrimeRuntimeError(
                            str(
                                payload.get("error")
                                or payload.get("message")
                                or "Prime Agent rejected prompt"
                            ),
                            {"response": _content_minimized(payload)},
                        )
                continue
            if etype == "message_update":
                event = payload.get("assistantMessageEvent")
                if isinstance(event, dict) and event.get("type") == "text_delta":
                    delta = event.get("delta")
                    if isinstance(delta, str) and delta:
                        chunks.append(delta)
                        _emit(on_event, {
                            "type": "token",
                            "token": delta,
                            "runtime": "prime",
                            "candidateOnly": True,
                            "canClaimAGI": False,
                        })
                continue
            if etype == "message_end":
                text = _message_text(payload.get("message"))
                if text:
                    final_candidates.append(text)
                continue
            if etype == "tool_execution_start":
                tools_started += 1
                _emit(on_event, {
                    "type": "tool_call",
                    "tool": str(payload.get("toolName") or "unknown"),
                    "callId": str(payload.get("toolCallId") or ""),
                    "args": payload.get("args") if isinstance(payload.get("args"), dict) else {},
                    "runtime": "prime",
                    "authority": "external-user-process",
                    "candidateOnly": True,
                    "canClaimAGI": False,
                })
                continue
            if etype == "tool_execution_update":
                _emit(on_event, {
                    "type": "external_tool_update",
                    "tool": str(payload.get("toolName") or "unknown"),
                    "callId": str(payload.get("toolCallId") or ""),
                    "runtime": "prime",
                    "candidateOnly": True,
                    "canClaimAGI": False,
                })
                continue
            if etype == "tool_execution_end":
                tools_finished += 1
                _emit(on_event, {
                    "type": "tool_result",
                    "tool": str(payload.get("toolName") or "unknown"),
                    "callId": str(payload.get("toolCallId") or ""),
                    "ok": payload.get("isError") is not True,
                    "runtime": "prime",
                    "authority": "external-user-process",
                    "candidateOnly": True,
                    "canClaimAGI": False,
                })
                continue
            if etype == "extension_ui_request":
                response = self._answer_ui_request(
                    payload,
                    callback=on_ui_request or self.on_ui_request,
                )
                self._send(response)
                _emit(on_event, {
                    "type": "external_ui_request",
                    "requestKind": str(payload.get("method") or payload.get("kind") or ""),
                    "handled": response.get("cancelled") is not True,
                    "runtime": "prime",
                    "candidateOnly": True,
                    "canClaimAGI": False,
                })
                continue
            if etype == "extension_error":
                if self.policy_configured:
                    self.policy_verified = False
                    raise _PrimeRuntimeError(
                        "Prime Agent extension error invalidated Sophia policy: "
                        f"{payload.get('error') or payload.get('message') or etype}",
                        {"event": _content_minimized(payload)},
                    )
                _emit(on_event, {
                    "type": "external_runtime_event",
                    "eventType": etype,
                    "runtime": "prime",
                    "candidateOnly": True,
                    "canClaimAGI": False,
                })
                continue
            if etype == "agent_end":
                text = _messages_text(payload.get("messages"))
                if text:
                    final_candidates.append(text)
                _emit(on_event, {
                    "type": "external_agent_end",
                    "runtime": "prime",
                    "candidateOnly": True,
                    "canClaimAGI": False,
                })
                break
            if etype in {"error", "agent_error"}:
                raise _PrimeRuntimeError(
                    str(payload.get("error") or payload.get("message") or etype),
                    {"event": _content_minimized(payload)},
                )
            _emit(on_event, {
                "type": "external_runtime_event",
                "eventType": etype or "unknown",
                "runtime": "prime",
                "candidateOnly": True,
                "canClaimAGI": False,
            })
        else:
            if not abort_sent:
                try:
                    self._send({"type": "abort"})
                except _PrimeRuntimeError:
                    # Preserve the timeout as the primary failure when the RPC
                    # stream is already unavailable during best-effort abort,
                    # but poison policy reuse: an unwritable child cannot still
                    # count as a verified enforcement boundary.
                    self.policy_verified = False
            raise _PrimeRuntimeError(
                f"Prime Agent timed out after "
                f"{self.timeout_sec if timeout_sec is None else timeout_sec}s",
                {"events": events_seen, "partialChars": sum(map(len, chunks))},
            )

        if abort_sent or (cancel_event is not None and cancel_event.is_set()):
            raise _PrimeRuntimeError(
                "Prime Agent run cancelled",
                {"cancelled": True, "accepted": accepted},
            )
        if not accepted:
            raise _PrimeRuntimeError(
                "Prime Agent produced events without a successful prompt "
                "acknowledgement; refusing the result."
            )
        # A tool-using turn may contain several assistant messages. Deliver the
        # last terminal assistant message, not the concatenation of intermediate
        # streamed planning/tool-call text. Deltas remain a fallback for runtimes
        # that omit terminal message bodies.
        text = (
            final_candidates[-1].strip()
            if final_candidates
            else "".join(chunks).strip()
        )
        if not text:
            raise _PrimeRuntimeError("Prime Agent produced no assistant text")
        return PrimeRunResult(
            ok=True,
            text=text,
            meta={
                "schema": SCHEMA,
                "runtime": "prime",
                "runtimeVersion": self.runtime_version,
                "persistent": True,
                "accepted": accepted,
                "events": events_seen,
                "noise": noise_seen,
                "toolsStarted": tools_started,
                "toolsFinished": tools_finished,
                "policyMode": self.policy_mode,
                "toolPolicyChecked": self.policy_verified,
                "executionAuthority": "external-user-process",
                "candidateOnly": True,
                "canClaimAGI": False,
            },
        )

    def _send(self, payload: dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None or proc.stdin is None:
            raise _PrimeRuntimeError("Prime Agent RPC child is not writable")
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self._write_lock:
            try:
                proc.stdin.write(data + b"\n")
                proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise _PrimeRuntimeError(
                    f"failed to write Prime Agent RPC: {type(exc).__name__}: {exc}"
                ) from exc

    def _reader_loop(self, proc: subprocess.Popen[bytes]) -> None:
        assert proc.stdout is not None
        buf = bytearray()
        try:
            while True:
                chunk = os.read(proc.stdout.fileno(), 4096)
                if not chunk:
                    break
                buf.extend(chunk)
                while True:
                    index = buf.find(b"\n")
                    if index < 0:
                        break
                    raw = bytes(buf[:index])
                    del buf[: index + 1]
                    if raw.endswith(b"\r"):
                        raw = raw[:-1]
                    self._queue_record(raw)
            if buf:
                self._queue_record(bytes(buf))
        except OSError as exc:
            self._events.put(("noise", f"reader error: {type(exc).__name__}"))
        finally:
            self._events.put(("eof", None))

    def _queue_record(self, raw: bytes) -> None:
        if not raw.strip():
            return
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._events.put(("noise", raw[:200]))
            return
        if isinstance(parsed, dict):
            self._events.put(("json", parsed))
        else:
            self._events.put(("noise", parsed))

    def _stderr_loop(self, proc: subprocess.Popen[bytes]) -> None:
        assert proc.stderr is not None
        try:
            while True:
                chunk = os.read(proc.stderr.fileno(), 4096)
                if not chunk:
                    return
                text = chunk.decode("utf-8", errors="replace")
                with self._stderr_lock:
                    self._stderr_tail = (self._stderr_tail + text)[-4000:]
        except OSError:
            return

    def _answer_ui_request(
        self,
        event: dict[str, Any],
        *,
        callback: UiRequestCallback | None,
    ) -> dict[str, Any]:
        request_id = event.get("id") or event.get("requestId") or "ui-0"
        if callback is None:
            return {
                "type": "extension_ui_response",
                "id": request_id,
                "cancelled": True,
            }
        try:
            answer = callback(event)
        except Exception:
            answer = None
        if not isinstance(answer, dict):
            return {
                "type": "extension_ui_response",
                "id": request_id,
                "cancelled": True,
            }
        if answer.get("cancelled") is True:
            return {
                "type": "extension_ui_response",
                "id": request_id,
                "cancelled": True,
            }
        response: dict[str, Any] = {
            "type": "extension_ui_response",
            "id": request_id,
        }
        if "value" in answer:
            response["value"] = answer["value"]
        elif "confirmed" in answer:
            response["confirmed"] = bool(answer["confirmed"])
        elif "allow" in answer:
            response["confirmed"] = bool(answer["allow"])
        else:
            response["cancelled"] = True
        return response

    def _failure(self, message: str, **meta: Any) -> PrimeRunResult:
        return PrimeRunResult(
            ok=False,
            error=message,
            meta={
                "schema": SCHEMA,
                "runtime": "prime",
                "runtimeVersion": self.runtime_version,
                "policyMode": self.policy_mode,
                "toolPolicyChecked": self.policy_verified,
                "executionAuthority": "external-user-process",
                **meta,
                "candidateOnly": True,
                "canClaimAGI": False,
            },
        )

    @staticmethod
    def _terminate_owned_process(proc: subprocess.Popen[bytes]) -> None:
        if proc.poll() is not None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
                proc.wait(timeout=1.0)
            except (OSError, subprocess.TimeoutExpired):
                return
        except OSError:
            return

    def _stderr_message(self, fallback: str) -> str:
        with self._stderr_lock:
            tail = self._stderr_tail.strip()
        return f"{fallback}: {tail[-800:]}" if tail else fallback

    def _drain_event_queue(self) -> None:
        while True:
            try:
                self._events.get_nowait()
            except queue.Empty:
                return


class _PrimeRuntimeError(RuntimeError):
    def __init__(self, message: str, meta: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.meta = dict(meta or {})


def _normalize_policy_mode(value: str) -> str:
    raw = str(value or "").strip().casefold()
    return raw if raw in {"advisory", "full"} else DEFAULT_POLICY_MODE


def _truthy(value: Any) -> bool:
    return str(value or "").strip().casefold() in {"1", "true", "yes", "on"}


def _emit(callback: NormalizedEventCallback | None, event: dict[str, Any]) -> None:
    if callback is None:
        return
    try:
        callback(event)
    except Exception:
        # Event display/telemetry must not change execution semantics.
        return


def _message_text(message: Any) -> str:
    if isinstance(message, str):
        return message
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def _messages_text(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "assistant":
            text = _message_text(message)
            if text.strip():
                return text
    return ""


def _content_minimized(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in payload.items()
        if key in {"type", "id", "command", "success", "error", "toolName", "isError"}
    }


__all__ = [
    "SCHEMA",
    "SUPPORTED_PRIME_AGENT_VERSION",
    "DEFAULT_POLICY_MODE",
    "PrimeRunResult",
    "PrimeAgentRuntime",
]
