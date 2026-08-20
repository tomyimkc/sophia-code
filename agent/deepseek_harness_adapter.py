# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Read-only, quarantined DeepSeek Harness headless runtime adapter."""
from __future__ import annotations

import os
import signal
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, TextIO

# Stay below Linux's common 128 KiB single-argument ceiling after the NUL
# terminator and CLI overhead are included.
MAX_DSH_PROMPT_BYTES = 122_880
MAX_DSH_STDOUT_CHARS = 4_000_000
MAX_DSH_STDERR_CHARS = 16_000
_PROMPT_WRITE_CHUNK_BYTES = 4_096

SpawnGuard = Callable[[], None]

_DEFERRED_EXEC_BOOTSTRAP = """\
import os
import sys

prompt = sys.stdin.buffer.read().decode("utf-8", errors="replace")
os.execvpe(sys.argv[1], [*sys.argv[1:], prompt], os.environ)
"""


class _PromptHandoffCancelled(OSError):
    pass


class _PromptHandoffTimedOut(TimeoutError):
    pass


@dataclass(frozen=True)
class ExternalRuntimeResult:
    ok: bool
    text: str
    error: str
    meta: Mapping[str, Any]


def _bounded(text: str, maximum: int) -> str:
    if len(text) <= maximum:
        return text
    return text[:maximum] + "\n…[truncated by Sophia plugin host]"


def _runtime_env(allowed_names: tuple[str, ...] = ()) -> dict[str, str]:
    env_names = set(allowed_names)
    env = {key: value for key, value in os.environ.items() if key in env_names}
    env["DSH_PERMISSION_MODE"] = "read-only"
    env["DSH_TELEMETRY_MODE"] = "DISABLED"
    # DSH 0.1.0-rc.6 honors both the telemetry provider mode and this
    # profile-composition kill switch. Set both so a user profile override
    # cannot accidentally re-enable the telemetry row for a Sophia-owned run.
    env["DSH_TELEMETRY_DISABLED"] = "1"
    return env


def _runtime_boundary_meta(profile: str) -> dict[str, Any]:
    return {
        "profile": profile,
        "permissionMode": "read-only",
        "streamingQuarantined": True,
        "isolation": "os-user",
        "sandboxed": False,
        "productionEligible": False,
        "concurrencyMode": "single-flight",
        "promptTransport": "guarded-stdin-exec-to-argv",
        "candidateOnly": True,
        "canClaimAGI": False,
    }


def _drain_stream(
    stream: TextIO | None,
    *,
    maximum: int,
    chunks: list[str],
    truncated: list[bool],
) -> None:
    if stream is None:
        return
    retained = 0
    try:
        while True:
            chunk = stream.read(8192)
            if not chunk:
                return
            if retained >= maximum:
                truncated[0] = True
                continue
            keep = chunk[: maximum - retained]
            chunks.append(keep)
            retained += len(keep)
            if len(keep) < len(chunk):
                truncated[0] = True
    finally:
        stream.close()


def _captured_text(chunks: list[str], truncated: list[bool]) -> str:
    text = "".join(chunks).strip()
    if truncated[0]:
        text += "\n…[truncated by Sophia plugin host]"
    return text


def _stop_owned_process(proc: subprocess.Popen[str]) -> bool:
    """Stop only the retained process tree, escalating after a deadline."""
    if proc.poll() is not None:
        return False
    if os.name != "nt":
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return False
    else:
        proc.terminate()
    try:
        proc.wait(timeout=2.0)
        return False
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                return False
        else:
            proc.kill()
        proc.wait(timeout=2.0)
        return True


def _close_stdin_after_stop(proc: subprocess.Popen[str]) -> None:
    """Close the parent writer only after the child can no longer see EOF."""
    if proc.stdin is None or proc.stdin.closed:
        return
    try:
        proc.stdin.close()
    except OSError:
        pass


class DeepSeekHarnessAdapter:
    """Execute exactly one DSH headless task in a child owned by this instance."""

    def __init__(
        self,
        *,
        command: list[str] | tuple[str, ...] | None = None,
        profile: str = "headless",
        timeout_seconds: float = 900,
        env_allow: list[str] | tuple[str, ...] | None = None,
    ):
        raw = list(command or ["dsh"])
        if profile != "headless":
            raise ValueError(
                "DeepSeek Harness plugin ABI v1 requires profile=headless"
            )
        executable = raw[0]
        if not Path(executable).is_absolute():
            resolved = shutil.which(executable)
            if not resolved:
                raise RuntimeError(f"DeepSeek Harness executable not found: {executable}")
            raw[0] = resolved
        self.command = tuple(raw)
        self.profile = profile
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 3600.0))
        self.env_allow = tuple(env_allow or ())
        self._process: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._retired = False
        self._starting = False
        self._lifecycle_epoch = 0
        self._retired_event = threading.Event()

    def _check_deferred_handoff_locked(
        self,
        proc: subprocess.Popen[str],
        *,
        lifecycle_epoch: int,
        cancel_event: threading.Event | None,
        deadline: float | None,
    ) -> None:
        if (
            self._retired
            or self._lifecycle_epoch != lifecycle_epoch
            or self._process is not proc
        ):
            raise PermissionError(
                "DeepSeek Harness adapter authority was retired "
                "during prompt handoff"
            )
        if cancel_event is not None and cancel_event.is_set():
            raise _PromptHandoffCancelled(
                "DeepSeek Harness prompt handoff was cancelled"
            )
        if deadline is not None and time.monotonic() >= deadline:
            raise _PromptHandoffTimedOut(
                "DeepSeek Harness prompt handoff timed out"
            )

    def _handoff_deferred_input(
        self,
        proc: subprocess.Popen[str],
        deferred_input: str,
        *,
        lifecycle_epoch: int,
        cancel_event: threading.Event | None,
        deadline: float | None,
    ) -> None:
        """Release prompt bytes only while this process retains authority."""
        stream = proc.stdin
        if stream is None:
            raise OSError("guarded runtime bootstrap has no stdin")
        with self._lock:
            self._check_deferred_handoff_locked(
                proc,
                lifecycle_epoch=lifecycle_epoch,
                cancel_event=cancel_event,
                deadline=deadline,
            )
            try:
                descriptor = stream.fileno()
                os.set_blocking(descriptor, False)
            except (OSError, ValueError) as exc:
                raise OSError(
                    "guarded runtime bootstrap stdin cannot be made "
                    "nonblocking"
                ) from exc

        payload = deferred_input.encode("utf-8", errors="replace")
        offset = 0
        while offset < len(payload):
            with self._lock:
                self._check_deferred_handoff_locked(
                    proc,
                    lifecycle_epoch=lifecycle_epoch,
                    cancel_event=cancel_event,
                    deadline=deadline,
                )
                try:
                    written = os.write(
                        descriptor,
                        payload[
                            offset : offset + _PROMPT_WRITE_CHUNK_BYTES
                        ],
                    )
                except (BlockingIOError, InterruptedError):
                    written = 0
            if written:
                offset += written
                continue
            # The descriptor is nonblocking.  Wait without the lifecycle
            # mutex so close/revocation can win and wake this handoff.
            self._retired_event.wait(0.01)

        with self._lock:
            self._check_deferred_handoff_locked(
                proc,
                lifecycle_epoch=lifecycle_epoch,
                cancel_event=cancel_event,
                deadline=deadline,
            )
            # No TextIO writes were used, so closing cannot flush buffered
            # prompt data.  EOF is linearized by the same lifecycle mutex as
            # every nonblocking os.write above.
            stream.close()

    def _spawn(
        self,
        argv: list[str],
        *,
        workspace: Path | None,
        spawn_guard: SpawnGuard | None,
        deferred_input: str | None = None,
        deferred_cancel_event: threading.Event | None = None,
        deferred_deadline: float | None = None,
    ) -> subprocess.Popen[str]:
        with self._lock:
            if self._retired:
                raise PermissionError(
                    "DeepSeek Harness adapter authority was retired"
                )
            if self._starting or (
                self._process is not None
                and self._process.poll() is None
            ):
                raise RuntimeError(
                    "DeepSeek Harness runtime is already active"
                )
            self._starting = True
            lifecycle_epoch = self._lifecycle_epoch
        proc: subprocess.Popen[str] | None = None
        try:
            if spawn_guard is not None:
                # The host validates and reserves this tracked adapter, then
                # releases its global lock before the potentially unbounded
                # Popen.
                spawn_guard()
            proc = subprocess.Popen(
                argv,
                cwd=str(workspace) if workspace is not None else None,
                env=_runtime_env(self.env_allow),
                stdin=(
                    subprocess.PIPE
                    if deferred_input is not None
                    else subprocess.DEVNULL
                ),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                start_new_session=os.name != "nt",
            )
            with self._lock:
                retired_during_spawn = (
                    self._retired
                    or self._lifecycle_epoch != lifecycle_epoch
                )
                if not retired_during_spawn:
                    self._process = proc
            if retired_during_spawn:
                _stop_owned_process(proc)
                _close_stdin_after_stop(proc)
                raise PermissionError(
                    "DeepSeek Harness adapter authority was retired "
                    "during process startup"
                )
            if deferred_input is not None:
                try:
                    self._handoff_deferred_input(
                        proc,
                        deferred_input,
                        lifecycle_epoch=lifecycle_epoch,
                        cancel_event=deferred_cancel_event,
                        deadline=deferred_deadline,
                    )
                except OSError:
                    with self._lock:
                        still_owned = self._process is proc
                        if still_owned:
                            self._process = None
                    # A concurrent close owns termination after detaching the
                    # process.  Otherwise this failing handoff owns it.
                    if still_owned:
                        _stop_owned_process(proc)
                        _close_stdin_after_stop(proc)
                    raise
            return proc
        finally:
            with self._lock:
                self._starting = False

    def _release_process(self, proc: subprocess.Popen[str]) -> None:
        with self._lock:
            if self._process is proc:
                self._process = None

    def _retired_status(self) -> bool:
        with self._lock:
            return self._retired

    def status(
        self,
        *,
        spawn_guard: SpawnGuard | None = None,
    ) -> dict[str, Any]:
        try:
            probe = self._spawn(
                [*self.command, "--version"],
                workspace=None,
                spawn_guard=spawn_guard,
            )
        except (OSError, RuntimeError) as exc:
            return {
                "available": False,
                "error": f"{type(exc).__name__}: {exc}",
                **_runtime_boundary_meta(self.profile),
            }
        try:
            try:
                stdout, stderr = probe.communicate(timeout=5)
            except subprocess.TimeoutExpired as exc:
                _stop_owned_process(probe)
                return {
                    "available": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    **_runtime_boundary_meta(self.profile),
                }
            if self._retired_status():
                return {
                    "available": False,
                    "error": (
                        "DeepSeek Harness adapter authority was retired "
                        "during status execution"
                    ),
                    **_runtime_boundary_meta(self.profile),
                }
            return {
                "available": probe.returncode == 0,
                "version": stdout.strip()[:120],
                "error": (
                    ""
                    if probe.returncode == 0
                    else _bounded(stderr.strip(), 800)
                ),
                **_runtime_boundary_meta(self.profile),
            }
        finally:
            self._release_process(probe)

    def run(
        self,
        prompt: str,
        *,
        workspace: Path,
        cancel_event: threading.Event,
        spawn_guard: SpawnGuard | None = None,
    ) -> ExternalRuntimeResult:
        prompt_bytes = len(prompt.encode("utf-8", errors="replace"))
        if prompt_bytes > MAX_DSH_PROMPT_BYTES:
            return ExternalRuntimeResult(
                ok=False,
                text="",
                error=(
                    "DeepSeek Harness beta adapter prompt exceeds "
                    f"{MAX_DSH_PROMPT_BYTES} UTF-8 bytes"
                ),
                meta={
                    "promptBytes": prompt_bytes,
                    **_runtime_boundary_meta(self.profile),
                },
            )
        # Start only a trusted, prompt-empty bootstrap.  The prompt is released
        # through its owned stdin after Popen returns and the adapter-local
        # lifecycle check wins.  If revocation returns while Popen is blocked,
        # the eventual bootstrap is killed without ever receiving the prompt.
        argv = [
            sys.executable,
            "-I",
            "-S",
            "-c",
            _DEFERRED_EXEC_BOOTSTRAP,
            *self.command,
            "--profile",
            self.profile,
        ]
        started = time.monotonic()
        try:
            proc = self._spawn(
                argv,
                workspace=workspace,
                spawn_guard=spawn_guard,
                deferred_input=prompt,
                deferred_cancel_event=cancel_event,
                deferred_deadline=started + self.timeout_seconds,
            )
        except _PromptHandoffCancelled:
            return ExternalRuntimeResult(
                ok=False,
                text="",
                error="cancelled",
                meta={
                    "cancelled": True,
                    **_runtime_boundary_meta(self.profile),
                },
            )
        except _PromptHandoffTimedOut:
            return ExternalRuntimeResult(
                ok=False,
                text="",
                error=(
                    "DeepSeek Harness timed out after "
                    f"{self.timeout_seconds:g}s"
                ),
                meta={
                    "timedOut": True,
                    **_runtime_boundary_meta(self.profile),
                },
            )
        except (OSError, RuntimeError) as exc:
            return ExternalRuntimeResult(
                ok=False,
                text="",
                error=f"{type(exc).__name__}: {exc}",
                meta=_runtime_boundary_meta(self.profile),
            )
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        stdout_truncated = [False]
        stderr_truncated = [False]
        stdout_reader = threading.Thread(
            target=_drain_stream,
            kwargs={
                "stream": proc.stdout,
                "maximum": MAX_DSH_STDOUT_CHARS,
                "chunks": stdout_chunks,
                "truncated": stdout_truncated,
            },
            name="sophia-dsh-stdout",
            daemon=True,
        )
        stderr_reader = threading.Thread(
            target=_drain_stream,
            kwargs={
                "stream": proc.stderr,
                "maximum": MAX_DSH_STDERR_CHARS,
                "chunks": stderr_chunks,
                "truncated": stderr_truncated,
            },
            name="sophia-dsh-stderr",
            daemon=True,
        )
        stdout_reader.start()
        stderr_reader.start()
        try:
            while proc.poll() is None:
                if cancel_event.is_set():
                    forced = _stop_owned_process(proc)
                    stdout_reader.join(timeout=2.0)
                    stderr_reader.join(timeout=2.0)
                    return ExternalRuntimeResult(
                        ok=False,
                        text="",
                        error="cancelled",
                        meta={
                            "cancelled": True,
                            "forcedTermination": forced,
                            **_runtime_boundary_meta(self.profile),
                        },
                    )
                if time.monotonic() - started > self.timeout_seconds:
                    forced = _stop_owned_process(proc)
                    stdout_reader.join(timeout=2.0)
                    stderr_reader.join(timeout=2.0)
                    return ExternalRuntimeResult(
                        ok=False,
                        text="",
                        error=f"DeepSeek Harness timed out after {self.timeout_seconds:g}s",
                        meta={
                            "timedOut": True,
                            "forcedTermination": forced,
                            **_runtime_boundary_meta(self.profile),
                        },
                    )
                time.sleep(0.05)
            stdout_reader.join(timeout=2.0)
            stderr_reader.join(timeout=2.0)
            stdout = _captured_text(stdout_chunks, stdout_truncated)
            stderr = _captured_text(stderr_chunks, stderr_truncated).replace(
                "\x00", ""
            )
            if self._retired_status():
                return ExternalRuntimeResult(
                    ok=False,
                    text="",
                    error=(
                        "DeepSeek Harness adapter authority was retired "
                        "during execution"
                    ),
                    meta={
                        "exitCode": proc.returncode,
                        "stderr": stderr,
                        "elapsedSec": round(time.monotonic() - started, 3),
                        **_runtime_boundary_meta(self.profile),
                    },
                )
            return ExternalRuntimeResult(
                ok=proc.returncode == 0 and bool(stdout),
                text=stdout,
                error="" if proc.returncode == 0 else (stderr or f"dsh exited {proc.returncode}"),
                meta={
                    "exitCode": proc.returncode,
                    "stderr": stderr,
                    "elapsedSec": round(time.monotonic() - started, 3),
                    **_runtime_boundary_meta(self.profile),
                },
            )
        finally:
            self._release_process(proc)

    def close(self) -> None:
        with self._lock:
            self._retired = True
            self._lifecycle_epoch += 1
            self._retired_event.set()
            proc = self._process
            self._process = None
        if proc is not None:
            if proc.poll() is None:
                _stop_owned_process(proc)
            # The child is now stopped, so closing our writer cannot deliver
            # an EOF that could release a revoked bootstrap.
            _close_stdin_after_stop(proc)
