# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Owned-process supervisor for JSON-RPC stdio plugins.

One sidecar process is owned by one supervisor instance. Shutdown and failure
cleanup use only the retained child object; there is no PID search and no
arbitrary process killing.
"""
from __future__ import annotations

import base64
import binascii
from collections import deque
import hashlib
import json
import os
import queue
import signal
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping

from agent.plugin_manifest import Entrypoint, PluginManifest
from agent.plugin_protocol import (
    JSONRPC_VERSION,
    MAX_MESSAGE_BYTES,
    SAFE_INTEGER_MAX,
    PluginProtocolError,
    PluginRpcError,
    execution_contract,
    notification_methods,
    parse_response,
    request,
    request_methods,
)
from agent.sandbox.plugin_sidecar import (
    PluginSandboxProvider,
    PluginSandboxStatus,
    plugin_sandbox_provider,
)


class PluginSupervisorError(RuntimeError):
    """Raised when a supervised sidecar is unavailable or violates protocol."""


_MAX_IGNORED_RESPONSE_IDS = 1024
_V2_CANCELLATION_METHODS = {
    "tool.execute": "tool.cancel",
    "command.execute": "job.cancel",
    "workflow.start": "workflow.cancel",
}
_CAPABILITY_SCHEMA = "sophia.plugin-capabilities/v1"
_PROTOCOL = "sophia.plugin-rpc/v2"
_SDK_VERSION = "1.0.0"
_RESOURCE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
_TERMINAL_JOB_STATES = frozenset(
    {"cancelled", "failed", "succeeded", "timed_out"}
)


def _strict_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant: {value}")


def _exact_fields(
    value: Mapping[str, Any],
    fields: set[str],
    *,
    label: str,
) -> None:
    missing = sorted(fields - set(value))
    unknown = sorted(set(value) - fields)
    if missing or unknown:
        detail: list[str] = []
        if missing:
            detail.append("missing " + ", ".join(missing))
        if unknown:
            detail.append("unknown " + ", ".join(unknown))
        raise PluginSupervisorError(
            f"{label} fields are invalid: {'; '.join(detail)}"
        )


def _safe_env(allowed_names: tuple[str, ...]) -> dict[str, str]:
    names = set(allowed_names)
    env = {key: value for key, value in os.environ.items() if key in names}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _resolve_command(entrypoint: Entrypoint, plugin_root: Path) -> list[str]:
    command: list[str] = []
    for index, raw in enumerate(entrypoint.command):
        value = raw.replace("${pluginRoot}", str(plugin_root))
        if index == 0 and not Path(value).is_absolute():
            resolved = shutil.which(value)
            if not resolved:
                raise PluginSupervisorError(
                    f"plugin executable not found: {value}"
                )
            value = resolved
        command.append(value)
    return command


def _owned_process_group_exists(process_group_id: int) -> bool:
    """Check one retained, supervisor-owned POSIX process group."""
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS can reject a signal-0 probe for an orphaned retained group even
        # though a direct signal to that exact group remains valid. Treat it
        # as present so the bounded cleanup still reaches SIGKILL if needed.
        return True
    return True


def _stop_owned_process(
    proc: subprocess.Popen[bytes],
    process_group_id: int | None,
) -> bool:
    """Stop only the retained child or its retained POSIX process group."""
    if os.name == "nt" or process_group_id is None:
        if proc.poll() is not None:
            return False
        proc.terminate()
        try:
            proc.wait(timeout=2.0)
            return False
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2.0)
            return True

    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except (PermissionError, ProcessLookupError):
        proc.poll()
        return False

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        proc.poll()
        if not _owned_process_group_exists(process_group_id):
            return False
        time.sleep(0.02)

    try:
        os.killpg(process_group_id, signal.SIGKILL)
    except (PermissionError, ProcessLookupError):
        return False
    try:
        proc.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        pass
    return True


class PluginSupervisor:
    def __init__(
        self,
        manifest: PluginManifest,
        *,
        workspace: Path,
        on_notification: Callable[[Mapping[str, Any]], None] | None = None,
        sandbox_provider: PluginSandboxProvider | None = None,
        before_spawn: Callable[[], None] | None = None,
    ):
        if manifest.entrypoint is None:
            raise PluginSupervisorError("plugin has no JSON-RPC entrypoint")
        self.manifest = manifest
        self.entrypoint = manifest.entrypoint
        self.workspace = workspace.expanduser().resolve()
        self.on_notification = on_notification
        self._sandbox_provider = sandbox_provider or plugin_sandbox_provider(
            self.entrypoint.sandbox
        )
        self._sandbox_status: PluginSandboxStatus = (
            self._sandbox_provider.status(self.entrypoint.sandbox)
        )
        self._sandbox_cleanup: Callable[[], None] | None = None
        self.before_spawn = before_spawn
        self.process: subprocess.Popen[bytes] | None = None
        self._owned_process_group_id: int | None = None
        self._deadline_timer: threading.Timer | None = None
        self._process_deadline: float | None = None
        self._output_bytes = 0
        self._active_calls = 0
        self._condition = threading.Condition(threading.RLock())
        self._pending: dict[
            str | int,
            queue.Queue[dict[str, Any] | BaseException],
        ] = {}
        self._pending_methods: dict[str | int, str] = {}
        self._cancellation_reservations: set[str | int] = set()
        self._ignored_response_ids: set[str | int] = set()
        self._ignored_response_order: deque[str | int] = deque()
        self._write_lock = threading.Lock()
        self._v1_call_lock = threading.RLock()
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._stderr_lock = threading.Lock()
        self._stderr: list[str] = []
        self._retired = False
        self._starting = False
        self._initialized = False
        self._rpc_version: str | None = None
        self._negotiated_capabilities: dict[str, Any] | None = None
        self._lifecycle_epoch = 0

    @property
    def stderr_tail(self) -> str:
        with self._stderr_lock:
            return "\n".join(self._stderr[-20:])[-4000:]

    @property
    def rpc_version(self) -> str | None:
        """Return the negotiated sidecar RPC version, if started."""
        with self._condition:
            return self._rpc_version

    @property
    def api_version(self) -> str | None:
        """Compatibility alias using the initialize response field name."""
        return self.rpc_version

    @property
    def isolation_status(self) -> Mapping[str, Any]:
        return {
            **self._isolation_public(),
            "resources": {
                "deadlineSeconds": (
                    self.entrypoint.resources.deadline_seconds
                ),
                "maxOutputBytes": (
                    self.entrypoint.resources.max_output_bytes
                ),
                "maxConcurrency": self._max_concurrency(),
            },
            "environmentAllow": list(self.entrypoint.env_allow),
        }

    def _isolation_public(self) -> dict[str, Any]:
        status = self._sandbox_status.public_dict()
        if self._sandbox_status.sandboxed:
            isolation = self._sandbox_status.provider
        elif self._sandbox_status.active:
            isolation = f"partial:{self._sandbox_status.provider}"
        else:
            isolation = "os-user"
        return {
            **status,
            "isolation": isolation,
        }

    def _max_concurrency(self) -> int:
        if self.entrypoint.rpc_version == "1":
            return 1
        return self.entrypoint.resources.max_concurrency

    @property
    def negotiated_capabilities(self) -> Mapping[str, Any] | None:
        """Return the retained API v2 capability contract, if advertised."""
        with self._condition:
            capabilities = self._negotiated_capabilities
            if capabilities is None:
                return None
            return {
                "methods": capabilities["methods"],
                "notifications": capabilities["notifications"],
                "limits": dict(capabilities["limits"]),
                "cancellation": dict(capabilities["cancellation"]),
                "jobs": {
                    "supported": capabilities["jobs"]["supported"],
                    "terminalStates": capabilities["jobs"][
                        "terminalStates"
                    ],
                },
                "artifacts": {
                    "supported": capabilities["artifacts"]["supported"],
                    "idPattern": capabilities["artifacts"]["idPattern"],
                    "encodings": capabilities["artifacts"]["encodings"],
                },
            }

    def start(self) -> None:
        stale_proc: subprocess.Popen[bytes] | None = None
        stale_process_group_id: int | None = None
        stale_deadline_timer: threading.Timer | None = None
        stale_cleanup: Callable[[], None] | None = None
        with self._condition:
            while self._starting:
                self._condition.wait(timeout=0.2)
                if self._retired:
                    raise PluginSupervisorError(
                        "plugin supervisor authority was retired"
                    )
            if self._retired:
                raise PluginSupervisorError(
                    "plugin supervisor authority was retired"
                )
            if (
                self.process is not None
                and self.process.poll() is None
                and self._initialized
            ):
                return
            if self.process is not None and self.process.poll() is not None:
                stale_proc = self.process
                stale_process_group_id = self._owned_process_group_id
                stale_deadline_timer = self._deadline_timer
                stale_cleanup = self._sandbox_cleanup
                self.process = None
                self._owned_process_group_id = None
                self._deadline_timer = None
                self._process_deadline = None
                self._sandbox_cleanup = None
                self._initialized = False
                self._rpc_version = None
                self._negotiated_capabilities = None
            self._starting = True
            start_epoch = self._lifecycle_epoch

        proc: subprocess.Popen[bytes] | None = None
        process_group_id: int | None = None
        launch_cleanup: Callable[[], None] | None = None
        published = False
        try:
            if stale_deadline_timer is not None:
                stale_deadline_timer.cancel()
            if stale_proc is not None:
                _stop_owned_process(
                    stale_proc,
                    stale_process_group_id,
                )
            if stale_cleanup is not None:
                stale_cleanup()
            command = _resolve_command(
                self.entrypoint,
                self.manifest.plugin_root,
            )
            cwd = self.manifest.plugin_root
            if self.entrypoint.cwd:
                cwd = (cwd / self.entrypoint.cwd).resolve()
                try:
                    cwd.relative_to(self.manifest.plugin_root)
                except ValueError as exc:
                    raise PluginSupervisorError(
                        "plugin cwd escaped plugin root"
                    ) from exc
            launch = self._sandbox_provider.prepare(
                command,
                cwd=cwd,
                env=_safe_env(self.entrypoint.env_allow),
                plugin_root=self.manifest.plugin_root,
                workspace=self.workspace,
                policy=self.entrypoint.sandbox,
            )
            self._sandbox_status = launch.status
            launch_cleanup = launch.cleanup
            if (
                self.entrypoint.sandbox.required
                and not launch.status.sandboxed
            ):
                launch.cleanup()
                launch_cleanup = None
                raise PluginSupervisorError(
                    "required plugin sandbox enforcement unavailable: "
                    f"{launch.status.provider} {launch.status.state}: "
                    f"{launch.status.detail}"
                )
            if self.before_spawn is not None:
                self.before_spawn()
            proc = subprocess.Popen(
                launch.argv,
                cwd=str(cwd),
                env=launch.env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=os.name != "nt",
            )
            if os.name != "nt":
                process_group_id = proc.pid
            with self._condition:
                if self._retired or self._lifecycle_epoch != start_epoch:
                    raise PluginSupervisorError(
                        "plugin supervisor was closed during startup"
                    )
                self.process = proc
                self._owned_process_group_id = process_group_id
                self._sandbox_cleanup = launch_cleanup
                launch_cleanup = None
                self._process_deadline = (
                    time.monotonic()
                    + self.entrypoint.resources.deadline_seconds
                )
                self._output_bytes = 0
                self._initialized = False
                self._rpc_version = None
                self._negotiated_capabilities = None
                self._pending.clear()
                self._pending_methods.clear()
                self._cancellation_reservations.clear()
                self._ignored_response_ids.clear()
                self._ignored_response_order.clear()
                timer = threading.Timer(
                    self.entrypoint.resources.deadline_seconds,
                    self._expire_process,
                    args=(proc, start_epoch),
                )
                timer.daemon = True
                self._deadline_timer = timer
                published = True
            timer.start()
            self._reader = threading.Thread(
                target=self._read_stdout,
                args=(proc,),
                name=f"sophia-plugin-{self.manifest.plugin_id}",
                daemon=True,
            )
            self._reader.start()
            self._stderr_reader = threading.Thread(
                target=self._read_stderr,
                args=(proc,),
                name=f"sophia-plugin-stderr-{self.manifest.plugin_id}",
                daemon=True,
            )
            self._stderr_reader.start()
            result = self._call_running(
                "initialize",
                {
                    "apiVersion": self.entrypoint.rpc_version,
                    "pluginId": self.manifest.plugin_id,
                    "workspace": str(self.workspace),
                    "execution": execution_contract(
                        isolation=self._isolation_public(),
                        deadline_seconds=(
                            self.entrypoint.resources.deadline_seconds
                        ),
                        max_output_bytes=(
                            self.entrypoint.resources.max_output_bytes
                        ),
                        max_concurrency=self._max_concurrency(),
                        environment_allow=self.entrypoint.env_allow,
                    ),
                    "candidateOnly": True,
                    "canClaimAGI": False,
                },
                timeout=min(10.0, self.entrypoint.timeout_seconds),
                api_version=self.entrypoint.rpc_version,
                cancel_event=None,
                allow_cancellation=False,
            )
            negotiated = self._negotiate_rpc_version(result)
            capabilities = (
                self._negotiate_v2_capabilities(result)
                if negotiated == "2"
                else None
            )
            with self._condition:
                if self.process is not proc or proc.poll() is not None:
                    raise PluginSupervisorError(
                        "plugin exited during initialize"
                    )
                self._rpc_version = negotiated
                self._negotiated_capabilities = capabilities
                self._initialized = True
        except Exception as exc:
            if proc is not None:
                with self._condition:
                    active = self.process is proc
                if active:
                    error = (
                        exc
                        if isinstance(exc, PluginSupervisorError)
                        else PluginSupervisorError(
                            f"plugin startup failed: {type(exc).__name__}"
                        )
                    )
                    self._fail_process(proc, error, stop=True)
                elif not published:
                    _stop_owned_process(proc, process_group_id)
                    if launch_cleanup is not None:
                        launch_cleanup()
                        launch_cleanup = None
            elif launch_cleanup is not None:
                launch_cleanup()
                launch_cleanup = None
            if not published:
                with self._condition:
                    self._sandbox_status = self._sandbox_status.inactive()
            if isinstance(exc, PluginSupervisorError):
                raise
            raise PluginSupervisorError(
                f"plugin startup failed: {type(exc).__name__}"
            ) from exc
        finally:
            with self._condition:
                self._starting = False
                self._condition.notify_all()

    def _expire_process(
        self,
        proc: subprocess.Popen[bytes],
        lifecycle_epoch: int,
    ) -> None:
        with self._condition:
            if (
                self.process is not proc
                or self._lifecycle_epoch != lifecycle_epoch
            ):
                return
        self._fail_process(
            proc,
            PluginSupervisorError(
                "plugin process deadline exceeded "
                f"{self.entrypoint.resources.deadline_seconds:g}s"
            ),
            stop=True,
        )

    def _negotiate_rpc_version(self, result: Any) -> str:
        expected = self.entrypoint.rpc_version
        returned = (
            result.get("apiVersion")
            if isinstance(result, Mapping)
            else None
        )
        if expected == "1":
            # ABI v1 sidecars predate an explicit initialize result field.
            if returned is None:
                return "1"
            if returned != "1":
                raise PluginSupervisorError(
                    "plugin API v1 negotiation returned a different version"
                )
            return "1"
        if not isinstance(result, Mapping) or returned != "2":
            raise PluginSupervisorError(
                "plugin API v2 negotiation requires apiVersion 2"
            )
        return "2"

    def _negotiate_v2_capabilities(
        self,
        result: Any,
    ) -> dict[str, Any] | None:
        if not isinstance(result, Mapping):
            raise PluginSupervisorError(
                "plugin API v2 initialize result must be an object"
            )
        if "capabilities" not in result:
            # Capability-less API v2 sidecars predate SDK v1 negotiation.
            # They retain the historical global protocol bounds.
            return None
        _exact_fields(
            result,
            {
                "apiVersion",
                "protocol",
                "sdkVersion",
                "capabilities",
                "candidateOnly",
                "canClaimAGI",
            },
            label="plugin API v2 initialize result",
        )
        if result.get("protocol") != _PROTOCOL:
            raise PluginSupervisorError(
                f"plugin protocol must be {_PROTOCOL}"
            )
        if result.get("sdkVersion") != _SDK_VERSION:
            raise PluginSupervisorError(
                f"plugin SDK version must be {_SDK_VERSION}"
            )
        if result.get("candidateOnly") is not True:
            raise PluginSupervisorError(
                "plugin initialize candidateOnly must be true"
            )
        if result.get("canClaimAGI") is not False:
            raise PluginSupervisorError(
                "plugin initialize canClaimAGI must be false"
            )

        capabilities = result.get("capabilities")
        if not isinstance(capabilities, Mapping):
            raise PluginSupervisorError(
                "plugin capabilities must be an object"
            )
        _exact_fields(
            capabilities,
            {
                "schema",
                "methods",
                "notifications",
                "limits",
                "cancellation",
                "jobs",
                "artifacts",
            },
            label="plugin capabilities",
        )
        if capabilities.get("schema") != _CAPABILITY_SCHEMA:
            raise PluginSupervisorError(
                f"plugin capabilities schema must be {_CAPABILITY_SCHEMA}"
            )

        methods_value = capabilities.get("methods")
        if (
            not isinstance(methods_value, list)
            or any(not isinstance(item, str) for item in methods_value)
            or len(methods_value) != len(set(methods_value))
        ):
            raise PluginSupervisorError(
                "plugin capability methods must be a unique string array"
            )
        methods = frozenset(methods_value)
        unknown_methods = sorted(methods - request_methods("2"))
        if unknown_methods:
            raise PluginSupervisorError(
                "plugin capability methods contain undeclared method(s): "
                + ", ".join(unknown_methods)
            )
        missing_lifecycle = sorted(
            {"initialize", "health", "shutdown"} - methods
        )
        if missing_lifecycle:
            raise PluginSupervisorError(
                "plugin capability methods are missing lifecycle method(s): "
                + ", ".join(missing_lifecycle)
            )

        notifications_value = capabilities.get("notifications")
        if (
            not isinstance(notifications_value, list)
            or any(not isinstance(item, str) for item in notifications_value)
            or len(notifications_value) != len(set(notifications_value))
        ):
            raise PluginSupervisorError(
                "plugin capability notifications must be a unique "
                "string array"
            )
        notifications = frozenset(notifications_value)
        unknown_notifications = sorted(
            notifications - notification_methods("2")
        )
        if unknown_notifications:
            raise PluginSupervisorError(
                "plugin capability notifications contain undeclared "
                "method(s): "
                + ", ".join(unknown_notifications)
            )

        limits_value = capabilities.get("limits")
        if not isinstance(limits_value, Mapping):
            raise PluginSupervisorError(
                "plugin capability limits must be an object"
            )
        _exact_fields(
            limits_value,
            {
                "maxMessageBytes",
                "maxInFlight",
                "maxArtifactReadBytes",
            },
            label="plugin capability limits",
        )
        limits: dict[str, int] = {}
        for key, lower, upper in (
            ("maxMessageBytes", 1024, MAX_MESSAGE_BYTES),
            ("maxInFlight", 1, 64),
            ("maxArtifactReadBytes", 1, MAX_MESSAGE_BYTES),
        ):
            value = limits_value.get(key)
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not lower <= value <= upper
            ):
                raise PluginSupervisorError(
                    f"plugin capability {key} must be {lower}..{upper}"
                )
            limits[key] = value

        cancellation_value = capabilities.get("cancellation")
        if not isinstance(cancellation_value, Mapping):
            raise PluginSupervisorError(
                "plugin capability cancellation must be an object"
            )
        cancellation: dict[str, str] = {}
        for active, cancel in cancellation_value.items():
            if (
                not isinstance(active, str)
                or not isinstance(cancel, str)
                or _V2_CANCELLATION_METHODS.get(active) != cancel
            ):
                raise PluginSupervisorError(
                    "plugin cancellation mapping is invalid"
                )
            if active not in methods or cancel not in methods:
                raise PluginSupervisorError(
                    "plugin cancellation mapping methods must both be "
                    "advertised"
                )
            cancellation[active] = cancel
        for active, cancel in _V2_CANCELLATION_METHODS.items():
            if active in methods and cancellation.get(active) != cancel:
                raise PluginSupervisorError(
                    f"advertised {active} requires cancellation mapping "
                    f"{cancel}"
                )

        jobs_value = capabilities.get("jobs")
        if not isinstance(jobs_value, Mapping):
            raise PluginSupervisorError(
                "plugin capability jobs must be an object"
            )
        _exact_fields(
            jobs_value,
            {"supported", "terminalStates"},
            label="plugin capability jobs",
        )
        jobs_supported = jobs_value.get("supported")
        expected_jobs_supported = any(
            method.startswith("job.") for method in methods
        )
        if jobs_supported is not expected_jobs_supported:
            raise PluginSupervisorError(
                "plugin jobs support disagrees with advertised methods"
            )
        terminal_states_value = jobs_value.get("terminalStates")
        if (
            not isinstance(terminal_states_value, list)
            or len(terminal_states_value) != len(_TERMINAL_JOB_STATES)
            or set(terminal_states_value) != _TERMINAL_JOB_STATES
        ):
            raise PluginSupervisorError(
                "plugin terminal job states are invalid"
            )

        artifacts_value = capabilities.get("artifacts")
        if not isinstance(artifacts_value, Mapping):
            raise PluginSupervisorError(
                "plugin capability artifacts must be an object"
            )
        _exact_fields(
            artifacts_value,
            {"supported", "idPattern", "encodings"},
            label="plugin capability artifacts",
        )
        artifacts_supported = artifacts_value.get("supported")
        if artifacts_supported is not ("artifact.read" in methods):
            raise PluginSupervisorError(
                "plugin artifact support disagrees with advertised methods"
        )
        id_pattern = artifacts_value.get("idPattern")
        if id_pattern != _RESOURCE_ID_PATTERN:
            raise PluginSupervisorError(
                "plugin artifact id pattern is invalid"
            )
        encodings_value = artifacts_value.get("encodings")
        if (
            not isinstance(encodings_value, list)
            or len(encodings_value) != 2
            or set(encodings_value) != {"utf8", "base64"}
        ):
            raise PluginSupervisorError(
                "plugin artifact encodings must be utf8 and base64"
            )

        return {
            "methods": methods,
            "notifications": notifications,
            "limits": limits,
            "cancellation": cancellation,
            "jobs": {
                "supported": jobs_supported,
                "terminalStates": frozenset(terminal_states_value),
            },
            "artifacts": {
                "supported": artifacts_supported,
                "idPattern": id_pattern,
                "encodings": frozenset(encodings_value),
            },
        }

    def _read_stdout(self, proc: subprocess.Popen[bytes]) -> None:
        if proc.stdout is None:
            return
        while True:
            with self._condition:
                remaining_output = max(
                    0,
                    self.entrypoint.resources.max_output_bytes
                    - self._output_bytes,
                )
            line = proc.stdout.readline(
                min(MAX_MESSAGE_BYTES + 2, remaining_output + 1)
            )
            if not line:
                with self._condition:
                    active = self.process is proc
                if active:
                    self._fail_process(
                        proc,
                        PluginSupervisorError(
                            "plugin closed stdout unexpectedly: "
                            f"{self.stderr_tail}"
                        ),
                        stop=True,
                    )
                return
            if not self._consume_output_bytes(proc, len(line)):
                return
            with self._condition:
                capabilities = (
                    self._negotiated_capabilities
                    if self.process is proc
                    else None
                )
            negotiated_max = (
                capabilities["limits"]["maxMessageBytes"]
                if capabilities is not None
                else MAX_MESSAGE_BYTES
            )
            oversized = len(line) > negotiated_max
            if not line.endswith(b"\n") and len(line) >= MAX_MESSAGE_BYTES + 1:
                oversized = True
            if oversized:
                if capabilities is None:
                    size_error = "plugin JSON-RPC message exceeded 1 MiB"
                else:
                    size_error = (
                        "plugin JSON-RPC message exceeded negotiated "
                        f"maxMessageBytes {negotiated_max}"
                    )
                self._fail_process(
                    proc,
                    PluginSupervisorError(size_error),
                    stop=True,
                )
                return
            try:
                payload = json.loads(
                    line.decode("utf-8"),
                    parse_constant=_strict_json_constant,
                )
            except UnicodeDecodeError as exc:
                self._fail_process(
                    proc,
                    PluginSupervisorError(
                        "plugin emitted non-UTF-8 JSON-RPC: "
                        f"{type(exc).__name__}"
                    ),
                    stop=True,
                )
                return
            except (json.JSONDecodeError, ValueError) as exc:
                self._fail_process(
                    proc,
                    PluginSupervisorError(
                        "plugin emitted invalid JSON-RPC: "
                        f"{type(exc).__name__}"
                    ),
                    stop=True,
                )
                return
            if not self._route_payload(proc, payload):
                return

    def _route_payload(
        self,
        proc: subprocess.Popen[bytes],
        payload: Any,
    ) -> bool:
        if not isinstance(payload, dict):
            self._fail_process(
                proc,
                PluginSupervisorError(
                    "plugin JSON-RPC payload was not an object"
                ),
                stop=True,
            )
            return False
        if payload.get("jsonrpc") != JSONRPC_VERSION:
            self._fail_process(
                proc,
                PluginSupervisorError(
                    "plugin JSON-RPC response version mismatch"
                ),
                stop=True,
            )
            return False
        if "method" in payload:
            if "id" in payload:
                self._fail_process(
                    proc,
                    PluginSupervisorError(
                        "plugin emitted an unsupported JSON-RPC request"
                    ),
                    stop=True,
                )
                return False
            if set(payload) != {"jsonrpc", "method", "params"}:
                self._fail_process(
                    proc,
                    PluginSupervisorError(
                        "plugin emitted a malformed JSON-RPC notification"
                    ),
                    stop=True,
                )
                return False
            method = payload.get("method")
            params = payload.get("params")
            with self._condition:
                if self.process is not proc:
                    return False
                api_version = (
                    self._rpc_version or self.entrypoint.rpc_version
                )
                capabilities = self._negotiated_capabilities
                initialized = self._initialized
            if not initialized:
                self._fail_process(
                    proc,
                    PluginSupervisorError(
                        "plugin emitted an unsupported JSON-RPC "
                        "notification before initialization"
                    ),
                    stop=True,
                )
                return False
            if (
                not isinstance(method, str)
                or method not in notification_methods(api_version)
                or not isinstance(params, dict)
            ):
                self._fail_process(
                    proc,
                    PluginSupervisorError(
                        "plugin emitted an unsupported JSON-RPC notification"
                    ),
                    stop=True,
                )
                return False
            if (
                capabilities is not None
                and method not in capabilities["notifications"]
            ):
                self._fail_process(
                    proc,
                    PluginSupervisorError(
                        "plugin emitted a notification that was not "
                        f"advertised: {method}"
                    ),
                    stop=True,
                )
                return False
            if self.on_notification:
                try:
                    self.on_notification(payload)
                except Exception as exc:
                    self._fail_process(
                        proc,
                        PluginSupervisorError(
                            "plugin notification handler failed: "
                            f"{type(exc).__name__}"
                        ),
                        stop=True,
                    )
                    return False
            return True
        if "id" not in payload:
            self._fail_process(
                proc,
                PluginSupervisorError(
                    "plugin emitted a malformed JSON-RPC response"
                ),
                stop=True,
            )
            return False
        response_id = payload.get("id")
        if (
            isinstance(response_id, bool)
            or not isinstance(response_id, (str, int))
            or (
                isinstance(response_id, int)
                and not -SAFE_INTEGER_MAX
                <= response_id
                <= SAFE_INTEGER_MAX
            )
            or (
                isinstance(response_id, str)
                and not 1 <= len(response_id) <= 128
            )
        ):
            self._fail_process(
                proc,
                PluginSupervisorError(
                    "plugin emitted an invalid JSON-RPC response id"
                ),
                stop=True,
            )
            return False
        with self._condition:
            if self.process is not proc:
                return False
            ignored = response_id in self._ignored_response_ids
        if ignored:
            try:
                parse_response(payload, expected_id=response_id)
            except PluginRpcError:
                # A well-formed JSON-RPC error is still a valid envelope.
                pass
            except PluginProtocolError as exc:
                self._fail_process(
                    proc,
                    PluginSupervisorError(str(exc)),
                    stop=True,
                )
                return False
            with self._condition:
                if self.process is not proc:
                    return False
                self._ignored_response_ids.discard(response_id)
                self._cancellation_reservations.discard(response_id)
            return True
        with self._condition:
            if self.process is not proc:
                return False
            target = self._pending.get(response_id)
            target_method = self._pending_methods.get(response_id)
        if target is None:
            self._fail_process(
                proc,
                PluginSupervisorError(
                    "plugin returned an unexpected JSON-RPC response id"
                ),
                stop=True,
            )
            return False
        if target_method == "initialize" and "result" in payload:
            try:
                result = parse_response(
                    payload,
                    expected_id=response_id,
                )
                negotiated = self._negotiate_rpc_version(result)
                capabilities = (
                    self._negotiate_v2_capabilities(result)
                    if negotiated == "2"
                    else None
                )
            except PluginRpcError:
                # The startup caller receives the JSON-RPC error response and
                # retires the process through the normal initialize path.
                pass
            except (PluginProtocolError, PluginSupervisorError) as exc:
                error = (
                    exc
                    if isinstance(exc, PluginSupervisorError)
                    else PluginSupervisorError(str(exc))
                )
                self._fail_process(proc, error, stop=True)
                return False
            else:
                with self._condition:
                    if (
                        self.process is not proc
                        or self._pending.get(response_id) is not target
                    ):
                        return False
                    self._rpc_version = negotiated
                    self._negotiated_capabilities = capabilities
                    self._initialized = True
        try:
            target.put_nowait(payload)
        except queue.Full:
            self._fail_process(
                proc,
                PluginSupervisorError(
                    "plugin returned duplicate JSON-RPC responses"
                ),
                stop=True,
            )
            return False
        return True

    def _read_stderr(self, proc: subprocess.Popen[bytes]) -> None:
        if proc.stderr is None:
            return
        while True:
            with self._condition:
                remaining_output = max(
                    0,
                    self.entrypoint.resources.max_output_bytes
                    - self._output_bytes,
                )
            chunk = os.read(
                proc.stderr.fileno(),
                min(4096, remaining_output + 1),
            )
            if not chunk:
                return
            if not self._consume_output_bytes(proc, len(chunk)):
                return
            safe = (
                chunk.decode("utf-8", errors="replace")
                .rstrip()
                .replace("\x00", "")
            )
            if safe:
                with self._stderr_lock:
                    self._stderr.append(safe[:800])
                    if len(self._stderr) > 100:
                        del self._stderr[:-100]

    def _consume_output_bytes(
        self,
        proc: subprocess.Popen[bytes],
        amount: int,
    ) -> bool:
        with self._condition:
            if self.process is not proc:
                return False
            self._output_bytes += amount
            exceeded = (
                self._output_bytes
                > self.entrypoint.resources.max_output_bytes
            )
        if exceeded:
            self._fail_process(
                proc,
                PluginSupervisorError(
                    "plugin cumulative output exceeded "
                    f"{self.entrypoint.resources.max_output_bytes} bytes"
                ),
                stop=True,
            )
            return False
        return True

    def call(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        timeout: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> Any:
        self.start()
        with self._condition:
            api_version = self._rpc_version
            if self._active_calls >= self._max_concurrency():
                raise PluginSupervisorError(
                    "plugin concurrency budget exceeded "
                    f"{self._max_concurrency()} active call(s)"
                )
            self._active_calls += 1
        if api_version is None:
            with self._condition:
                self._active_calls -= 1
            raise PluginSupervisorError("plugin did not complete initialization")
        try:
            if api_version == "1":
                # Preserve ABI v1 single-flight behavior and cancellation.
                with self._v1_call_lock:
                    return self._call_running(
                        method,
                        params,
                        timeout=timeout,
                        api_version=api_version,
                        cancel_event=cancel_event,
                        allow_cancellation=True,
                    )
            return self._call_running(
                method,
                params,
                timeout=timeout,
                api_version=api_version,
                cancel_event=cancel_event,
                allow_cancellation=True,
            )
        finally:
            with self._condition:
                self._active_calls -= 1
                self._condition.notify_all()

    def _write_request_frame(
        self,
        proc: subprocess.Popen[bytes],
        frame: bytes,
        *,
        method: str,
        request_id: str | int,
        response_queue: queue.Queue[dict[str, Any] | BaseException],
        reserved_slot: str | int | None,
        deadline: float,
        process_deadline: float | None,
        cancel_event: threading.Event | None,
        allow_cancellation: bool,
    ) -> None:
        """Write one frame without pinning the caller behind a full pipe."""
        state_lock = threading.Lock()
        state = {"started": False, "aborted": False}
        finished = threading.Event()
        outcome: list[BaseException] = []

        def write_frame() -> None:
            try:
                with self._write_lock:
                    with state_lock:
                        if state["aborted"]:
                            return
                        state["started"] = True
                    with self._condition:
                        if self.process is not proc or proc.poll() is not None:
                            raise PluginSupervisorError(
                                "plugin process is not running: "
                                f"{self.stderr_tail}"
                            )
                        active_capabilities = self._negotiated_capabilities
                        if reserved_slot is not None:
                            if (
                                reserved_slot
                                not in self._cancellation_reservations
                            ):
                                raise PluginSupervisorError(
                                    "plugin RPC cancellation slot reservation "
                                    "was lost"
                                )
                            self._cancellation_reservations.remove(
                                reserved_slot
                            )
                        elif active_capabilities is not None:
                            active_slots = (
                                len(self._pending)
                                + len(self._cancellation_reservations)
                            )
                            max_in_flight = active_capabilities["limits"][
                                "maxInFlight"
                            ]
                            if active_slots >= max_in_flight:
                                raise PluginSupervisorError(
                                    "plugin RPC exceeded negotiated maxInFlight "
                                    f"{max_in_flight}"
                                )
                        self._pending[request_id] = response_queue
                        self._pending_methods[request_id] = method
                    try:
                        assert proc.stdin is not None
                        descriptor = proc.stdin.fileno()
                        try:
                            os.set_blocking(descriptor, False)
                        except (AttributeError, NotImplementedError, OSError):
                            # Older Windows runtimes cannot make anonymous
                            # pipe handles nonblocking. Keep that blocking call
                            # isolated to this kill-interruptible writer thread.
                            proc.stdin.write(frame)
                            proc.stdin.flush()
                        else:
                            remaining = memoryview(frame)
                            while remaining:
                                with self._condition:
                                    if self.process is not proc:
                                        raise BrokenPipeError(
                                            "plugin write authority was closed"
                                        )
                                try:
                                    written = os.write(descriptor, remaining)
                                except BlockingIOError:
                                    time.sleep(0.01)
                                    continue
                                except InterruptedError:
                                    continue
                                if written <= 0:
                                    raise BrokenPipeError(
                                        "plugin stdin accepted zero bytes"
                                    )
                                remaining = remaining[written:]
                    except (BrokenPipeError, OSError) as exc:
                        error = PluginSupervisorError(
                            f"plugin write failed during {method}: "
                            f"{type(exc).__name__}"
                        )
                        self._fail_process(proc, error, stop=True)
                        raise error from exc
            except BaseException as exc:
                outcome.append(exc)
            finally:
                finished.set()

        writer = threading.Thread(
            target=write_frame,
            name=f"sophia-plugin-writer-{self.manifest.plugin_id}",
            daemon=True,
        )
        writer.start()

        while not finished.wait(timeout=0.05):
            with self._condition:
                active = self.process is proc
            if not active:
                with state_lock:
                    if not state["started"]:
                        state["aborted"] = True
                raise PluginSupervisorError(
                    f"plugin process stopped during {method} request write"
                )
            if (
                allow_cancellation
                and cancel_event is not None
                and cancel_event.is_set()
            ):
                with state_lock:
                    unsent = not state["started"]
                    if unsent:
                        state["aborted"] = True
                error = PluginSupervisorError(
                    f"plugin RPC {method} cancelled"
                )
                if not unsent:
                    self._fail_process(proc, error, stop=True)
                raise error
            now = time.monotonic()
            if now >= deadline:
                with state_lock:
                    if not state["started"]:
                        state["aborted"] = True
                if (
                    process_deadline is not None
                    and now >= process_deadline
                ):
                    error = PluginSupervisorError(
                        "plugin process deadline exceeded "
                        f"{self.entrypoint.resources.deadline_seconds:g}s"
                    )
                else:
                    error = PluginSupervisorError(
                        f"plugin RPC {method} timed out"
                    )
                self._fail_process(proc, error, stop=True)
                raise error

        if outcome:
            error = outcome[0]
            if isinstance(error, PluginSupervisorError):
                raise error
            raise PluginSupervisorError(
                f"plugin write failed during {method}: "
                f"{type(error).__name__}"
            ) from error

    def _call_running(
        self,
        method: str,
        params: Mapping[str, Any] | None,
        *,
        timeout: float | None,
        api_version: str,
        cancel_event: threading.Event | None,
        allow_cancellation: bool,
        reserved_slot: str | int | None = None,
    ) -> Any:
        with self._condition:
            capabilities = self._negotiated_capabilities
        if (
            capabilities is not None
            and method != "initialize"
            and method not in capabilities["methods"]
        ):
            raise PluginSupervisorError(
                f"plugin RPC method was not advertised: {method}"
            )
        request_id = f"rpc-{uuid.uuid4().hex[:12]}"
        try:
            envelope = request(
                request_id,
                method,
                params,
                api_version=api_version,
            )
        except PluginProtocolError as exc:
            raise PluginSupervisorError(str(exc)) from exc
        try:
            encoded = json.dumps(
                envelope,
                ensure_ascii=False,
                allow_nan=False,
            )
        except (TypeError, ValueError) as exc:
            raise PluginSupervisorError(
                f"plugin JSON-RPC request was not portable JSON: "
                f"{type(exc).__name__}"
            ) from exc
        max_message_bytes = (
            capabilities["limits"]["maxMessageBytes"]
            if capabilities is not None
            else MAX_MESSAGE_BYTES
        )
        if len(encoded.encode("utf-8")) + 1 > max_message_bytes:
            raise PluginSupervisorError(
                "plugin JSON-RPC request exceeded negotiated "
                f"maxMessageBytes {max_message_bytes}"
            )
        response_queue: queue.Queue[
            dict[str, Any] | BaseException
        ] = queue.Queue(maxsize=1)
        with self._condition:
            proc = self.process
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise PluginSupervisorError(
                f"plugin process is not running: {self.stderr_tail}"
            )
        requested_timeout = (
            timeout
            if timeout is not None
            else self.entrypoint.timeout_seconds
        )
        if requested_timeout <= 0:
            raise PluginSupervisorError(
                "plugin RPC timeout must be positive"
            )
        now = time.monotonic()
        deadline = now + requested_timeout
        with self._condition:
            process_deadline = self._process_deadline
        if process_deadline is not None:
            deadline = min(deadline, process_deadline)
        request_completed = False
        try:
            self._write_request_frame(
                proc,
                (encoded + "\n").encode("utf-8"),
                method=method,
                request_id=request_id,
                response_queue=response_queue,
                reserved_slot=reserved_slot,
                deadline=deadline,
                process_deadline=process_deadline,
                cancel_event=cancel_event,
                allow_cancellation=allow_cancellation,
            )
            while True:
                if (
                    allow_cancellation
                    and cancel_event is not None
                    and cancel_event.is_set()
                ):
                    if api_version == "1":
                        error = PluginSupervisorError(
                            f"plugin RPC {method} cancelled"
                        )
                        self._fail_process(proc, error, stop=True)
                        raise error
                    with self._condition:
                        active_capabilities = (
                            self._negotiated_capabilities
                        )
                    cancel_method = (
                        active_capabilities["cancellation"].get(method)
                        if active_capabilities is not None
                        else _V2_CANCELLATION_METHODS.get(method)
                    )
                    if (
                        active_capabilities is not None
                        and cancel_method is None
                    ):
                        error = PluginSupervisorError(
                            f"plugin RPC {method} cancellation was not "
                            "advertised"
                        )
                        self._fail_process(proc, error, stop=True)
                        raise error
                    if cancel_method is not None:
                        self._abandon_request(
                            request_id,
                            response_queue,
                            reserve_cancellation=True,
                        )
                        try:
                            self._call_running(
                                cancel_method,
                                self._cancellation_params(
                                    method,
                                    request_id,
                                    params,
                                ),
                                timeout=min(
                                    2.0,
                                    self.entrypoint.timeout_seconds,
                                ),
                                api_version="2",
                                cancel_event=None,
                                allow_cancellation=False,
                                reserved_slot=request_id,
                            )
                        except PluginSupervisorError as exc:
                            raise PluginSupervisorError(
                                f"plugin RPC {method} cancelled; "
                                f"{cancel_method} failed: {exc}"
                            ) from exc
                    else:
                        self._abandon_request(
                            request_id,
                            response_queue,
                            reserve_cancellation=False,
                        )
                    raise PluginSupervisorError(
                        f"plugin RPC {method} cancelled"
                    )
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    if (
                        process_deadline is not None
                        and time.monotonic() >= process_deadline
                    ):
                        error = PluginSupervisorError(
                            "plugin process deadline exceeded "
                            f"{self.entrypoint.resources.deadline_seconds:g}s"
                        )
                    else:
                        error = PluginSupervisorError(
                            f"plugin RPC {method} timed out"
                        )
                    self._fail_process(proc, error, stop=True)
                    raise error
                try:
                    payload = response_queue.get(
                        timeout=min(remaining, 0.1)
                    )
                except queue.Empty:
                    if proc.poll() is not None:
                        error = PluginSupervisorError(
                            f"plugin exited during {method}: "
                            f"{self.stderr_tail}"
                        )
                        self._fail_process(proc, error, stop=False)
                        raise error
                    continue
                if isinstance(payload, BaseException):
                    raise PluginSupervisorError(str(payload)) from payload
                try:
                    result = parse_response(
                        payload,
                        expected_id=request_id,
                    )
                    self._enforce_result_limits(method, result, proc)
                    request_completed = True
                    return result
                except PluginRpcError as exc:
                    raise PluginSupervisorError(str(exc)) from exc
                except PluginProtocolError as exc:
                    error = PluginSupervisorError(str(exc))
                    self._fail_process(proc, error, stop=True)
                    raise error from exc
        finally:
            self._remove_pending(
                request_id,
                response_queue,
                restore_cancellation=(
                    reserved_slot
                    if reserved_slot is not None and not request_completed
                    else None
                ),
            )

    def _enforce_result_limits(
        self,
        method: str,
        result: Any,
        proc: subprocess.Popen[bytes],
    ) -> None:
        if method != "artifact.read":
            return
        with self._condition:
            capabilities = self._negotiated_capabilities
        if capabilities is None:
            return
        limit = capabilities["limits"]["maxArtifactReadBytes"]
        if not isinstance(result, Mapping):
            error = PluginSupervisorError(
                "plugin artifact.read result must be an object"
            )
            self._fail_process(proc, error, stop=True)
            raise error
        artifact = result.get("artifact")
        encoding = result.get("encoding")
        data = result.get("data")
        if (
            not isinstance(artifact, Mapping)
            or isinstance(artifact.get("sizeBytes"), bool)
            or not isinstance(artifact.get("sizeBytes"), int)
            or not isinstance(data, str)
            or encoding not in {"utf8", "base64"}
        ):
            error = PluginSupervisorError(
                "plugin artifact.read result fields are invalid"
            )
            self._fail_process(proc, error, stop=True)
            raise error
        descriptor_size = artifact["sizeBytes"]
        try:
            raw = (
                data.encode("utf-8")
                if encoding == "utf8"
                else base64.b64decode(data, validate=True)
            )
        except (UnicodeError, ValueError, binascii.Error) as exc:
            error = PluginSupervisorError(
                "plugin artifact.read data encoding is invalid"
            )
            self._fail_process(proc, error, stop=True)
            raise error from exc
        content_size = len(raw)
        if descriptor_size != content_size:
            error = PluginSupervisorError(
                "plugin artifact.read sizeBytes does not match data"
            )
            self._fail_process(proc, error, stop=True)
            raise error
        if descriptor_size < 0 or descriptor_size > limit:
            error = PluginSupervisorError(
                "plugin artifact.read exceeded negotiated "
                f"maxArtifactReadBytes {limit}"
            )
            self._fail_process(proc, error, stop=True)
            raise error
        if hashlib.sha256(raw).hexdigest() != artifact.get("sha256"):
            error = PluginSupervisorError(
                "plugin artifact.read sha256 does not match data"
            )
            self._fail_process(proc, error, stop=True)
            raise error

    @staticmethod
    def _cancellation_params(
        method: str,
        request_id: str | int,
        params: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        cancellation: dict[str, Any] = {
            "requestId": request_id,
            "requestMethod": method,
        }
        if params:
            for key in (
                "executionId",
                "toolCallId",
                "commandId",
                "workflowId",
                "runId",
                "jobId",
            ):
                if key in params:
                    cancellation[key] = params[key]
        return cancellation

    def _abandon_request(
        self,
        request_id: str | int,
        response_queue: queue.Queue[dict[str, Any] | BaseException],
        *,
        reserve_cancellation: bool,
    ) -> None:
        with self._condition:
            if self._pending.get(request_id) is response_queue:
                self._pending.pop(request_id, None)
                self._pending_methods.pop(request_id, None)
                if reserve_cancellation:
                    self._cancellation_reservations.add(request_id)
                if request_id not in self._ignored_response_ids:
                    while (
                        len(self._ignored_response_order)
                        >= _MAX_IGNORED_RESPONSE_IDS
                    ):
                        oldest = self._ignored_response_order.popleft()
                        self._ignored_response_ids.discard(oldest)
                    self._ignored_response_ids.add(request_id)
                    self._ignored_response_order.append(request_id)

    def _remove_pending(
        self,
        request_id: str | int,
        response_queue: queue.Queue[dict[str, Any] | BaseException],
        *,
        restore_cancellation: str | int | None = None,
    ) -> None:
        with self._condition:
            if self._pending.get(request_id) is response_queue:
                self._pending.pop(request_id, None)
                self._pending_methods.pop(request_id, None)
                if (
                    restore_cancellation is not None
                    and restore_cancellation in self._ignored_response_ids
                ):
                    self._cancellation_reservations.add(
                        restore_cancellation
                    )

    def _fail_process(
        self,
        proc: subprocess.Popen[bytes],
        error: PluginSupervisorError,
        *,
        stop: bool,
    ) -> None:
        with self._condition:
            if self.process is not proc:
                return
            process_group_id = self._owned_process_group_id
            deadline_timer = self._deadline_timer
            sandbox_cleanup = self._sandbox_cleanup
            self.process = None
            self._owned_process_group_id = None
            self._deadline_timer = None
            self._process_deadline = None
            self._sandbox_cleanup = None
            self._sandbox_status = self._sandbox_status.inactive()
            self._initialized = False
            self._rpc_version = None
            self._negotiated_capabilities = None
            waiters = list(self._pending.values())
            self._pending.clear()
            self._pending_methods.clear()
            self._cancellation_reservations.clear()
            self._ignored_response_ids.clear()
            self._ignored_response_order.clear()
            self._condition.notify_all()
        if deadline_timer is not None:
            deadline_timer.cancel()
        for waiter in waiters:
            try:
                waiter.put_nowait(error)
            except queue.Full:
                pass
        if stop or proc.poll() is not None:
            _stop_owned_process(proc, process_group_id)
        if sandbox_cleanup is not None:
            sandbox_cleanup()

    def health(self) -> Mapping[str, Any]:
        result = self.call(
            "health",
            {},
            timeout=min(5.0, self.entrypoint.timeout_seconds),
        )
        return result if isinstance(result, dict) else {"status": str(result)}

    def _send_shutdown_bounded(
        self,
        proc: subprocess.Popen[bytes],
        payload: bytes,
        *,
        timeout: float = 0.1,
    ) -> bool:
        """Attempt graceful shutdown without waiting behind a blocked writer."""
        permitted = threading.Event()
        permitted.set()
        finished = threading.Event()
        sent = threading.Event()

        def write_shutdown() -> None:
            try:
                with self._write_lock:
                    if (
                        not permitted.is_set()
                        or proc.poll() is not None
                        or proc.stdin is None
                    ):
                        return
                    proc.stdin.write(payload)
                    proc.stdin.flush()
                    sent.set()
            except (BrokenPipeError, OSError):
                pass
            finally:
                finished.set()

        writer = threading.Thread(
            target=write_shutdown,
            name=f"sophia-plugin-shutdown-{self.manifest.plugin_id}",
            daemon=True,
        )
        writer.start()
        if not finished.wait(timeout=timeout):
            permitted.clear()
            return False
        return sent.is_set()

    def close(self) -> None:
        with self._condition:
            self._lifecycle_epoch += 1
            proc = self.process
            process_group_id = self._owned_process_group_id
            deadline_timer = self._deadline_timer
            sandbox_cleanup = self._sandbox_cleanup
            api_version = (
                self._rpc_version or self.entrypoint.rpc_version
            )
            self.process = None
            self._owned_process_group_id = None
            self._deadline_timer = None
            self._process_deadline = None
            self._sandbox_cleanup = None
            self._sandbox_status = self._sandbox_status.inactive()
            self._initialized = False
            self._rpc_version = None
            self._negotiated_capabilities = None
            waiters = list(self._pending.values())
            self._pending.clear()
            self._pending_methods.clear()
            self._cancellation_reservations.clear()
            self._ignored_response_ids.clear()
            self._ignored_response_order.clear()
            self._condition.notify_all()
        if deadline_timer is not None:
            deadline_timer.cancel()
        error = PluginSupervisorError("plugin supervisor closed")
        for waiter in waiters:
            try:
                waiter.put_nowait(error)
            except queue.Full:
                pass
        if proc is None:
            return
        if proc.poll() is None:
            shutdown_sent = False
            try:
                if proc.stdin is not None:
                    payload = json.dumps(
                        request(
                            f"shutdown-{uuid.uuid4().hex[:12]}",
                            "shutdown",
                            {},
                            api_version=api_version,
                        )
                    )
                    shutdown_sent = self._send_shutdown_bounded(
                        proc,
                        (payload + "\n").encode("utf-8"),
                    )
            except (BrokenPipeError, OSError):
                pass
            if shutdown_sent:
                try:
                    proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    pass
        _stop_owned_process(proc, process_group_id)
        if sandbox_cleanup is not None:
            sandbox_cleanup()
        current = threading.current_thread()
        for reader in (self._reader, self._stderr_reader):
            if reader is not None and reader is not current:
                reader.join(timeout=0.2)

    def retire(self) -> None:
        """Permanently invalidate this exact authority-bound supervisor."""
        with self._condition:
            self._retired = True
        self.close()
