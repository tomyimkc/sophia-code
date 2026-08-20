# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""OS sandbox providers for supervised plugin sidecars.

This module prepares argv/environment pairs for an already-approved sidecar
command. It never silently describes a direct subprocess as sandboxed:

* macOS uses Seatbelt through ``sandbox-exec`` only after a live probe;
* Linux uses bubblewrap only after a live namespace probe;
* partial or unavailable providers remain visible in status;
* callers must reject partial/unavailable results when isolation is required.

Provider status describes only controls the selected backend can actually
enforce. The supervisor additionally applies hard deadlines, cumulative output
bytes, concurrency, and best-effort cleanup of its retained child/process
group. Those supervisor controls are not described as kernel-backed descendant
ownership when a child can detach from that group.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Callable, Mapping, Protocol

from agent.plugin_manifest import PluginSandboxPolicy


@dataclass(frozen=True)
class PluginSandboxStatus:
    provider: str
    requested_mode: str
    state: str
    filesystem: str
    network: str
    processes: str
    enforced: tuple[str, ...] = ()
    unsupported: tuple[str, ...] = ()
    detail: str = ""
    applied: bool = False

    @property
    def sandboxed(self) -> bool:
        """True only when every requested isolation control is enforced."""
        return self.applied and self.state == "enforced"

    @property
    def active(self) -> bool:
        """True when a real provider wraps the process, including partial."""
        return self.applied and self.state in {"enforced", "partial"}

    def inactive(self) -> "PluginSandboxStatus":
        """Return an honest status for the provider with no active sidecar."""
        state = "available" if self.state == "enforced" else self.state
        return replace(
            self,
            state=state,
            enforced=(),
            applied=False,
        )

    def public_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "requestedMode": self.requested_mode,
            "state": self.state,
            "sandboxed": self.sandboxed,
            "active": self.active,
            "filesystem": self.filesystem,
            "network": self.network,
            "processes": self.processes,
            "enforced": list(self.enforced),
            "unsupported": list(self.unsupported),
            "detail": self.detail,
        }


@dataclass
class PluginSandboxLaunch:
    argv: list[str]
    env: dict[str, str]
    status: PluginSandboxStatus
    cleanup: Callable[[], None] = lambda: None


class PluginSandboxProvider(Protocol):
    name: str

    def status(self, policy: PluginSandboxPolicy) -> PluginSandboxStatus:
        """Report live provider availability and requested-policy coverage."""

    def prepare(
        self,
        command: list[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        plugin_root: Path,
        workspace: Path,
        policy: PluginSandboxPolicy,
    ) -> PluginSandboxLaunch:
        """Prepare an argv/env pair without launching the sidecar."""


def _direct_launch(
    provider: str,
    command: list[str],
    env: Mapping[str, str],
    policy: PluginSandboxPolicy,
    *,
    state: str,
    detail: str,
    unsupported: tuple[str, ...] = (),
) -> PluginSandboxLaunch:
    return PluginSandboxLaunch(
        argv=list(command),
        env=dict(env),
        status=PluginSandboxStatus(
            provider=provider,
            requested_mode=policy.mode,
            state=state,
            filesystem=policy.filesystem,
            network=policy.network,
            processes=policy.processes,
            unsupported=unsupported,
            detail=detail,
        ),
    )


class NoPluginSandboxProvider:
    """Explicit unsandboxed provider for manifests with sandbox mode off."""

    name = "none"

    def status(self, policy: PluginSandboxPolicy) -> PluginSandboxStatus:
        return PluginSandboxStatus(
            provider=self.name,
            requested_mode=policy.mode,
            state="disabled",
            filesystem=policy.filesystem,
            network=policy.network,
            processes=policy.processes,
            detail="manifest did not request OS sandbox enforcement",
        )

    def prepare(
        self,
        command: list[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        plugin_root: Path,
        workspace: Path,
        policy: PluginSandboxPolicy,
    ) -> PluginSandboxLaunch:
        del cwd, plugin_root, workspace
        return _direct_launch(
            self.name,
            command,
            env,
            policy,
            state="disabled",
            detail="manifest did not request OS sandbox enforcement",
        )


class UnavailablePluginSandboxProvider:
    """Platform/provider mismatch with an honest unavailable status."""

    def __init__(self, name: str, detail: str):
        self.name = name
        self.detail = detail

    def status(self, policy: PluginSandboxPolicy) -> PluginSandboxStatus:
        return PluginSandboxStatus(
            provider=self.name,
            requested_mode=policy.mode,
            state="unavailable",
            filesystem=policy.filesystem,
            network=policy.network,
            processes=policy.processes,
            unsupported=("os-isolation",),
            detail=self.detail,
        )

    def prepare(
        self,
        command: list[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        plugin_root: Path,
        workspace: Path,
        policy: PluginSandboxPolicy,
    ) -> PluginSandboxLaunch:
        del cwd, plugin_root, workspace
        return _direct_launch(
            self.name,
            command,
            env,
            policy,
            state="unavailable",
            detail=self.detail,
            unsupported=("os-isolation",),
        )


def _bounded_probe_error(proc: subprocess.CompletedProcess[str]) -> str:
    message = (proc.stderr or proc.stdout or "").strip().replace("\x00", "")
    return message[:500] or f"probe exited {proc.returncode}"


def _path_literal(path: str | Path) -> str:
    return json.dumps(str(path))


def _runtime_read_roots(executable: str, *, platform_name: str) -> tuple[Path, ...]:
    """Return read-only runtime roots needed to load the approved executable."""
    candidates: list[Path] = []
    if platform_name == "darwin":
        candidates.extend(
            Path(value)
            for value in (
                "/System",
                "/usr",
                "/Library/Apple",
                "/private/var/db/timezone",
            )
        )
    else:
        candidates.extend(
            Path(value)
            for value in (
                "/usr",
                "/bin",
                "/sbin",
                "/lib",
                "/lib64",
                "/usr/local",
            )
        )
    raw = Path(executable).expanduser()
    resolved = raw.resolve()
    for path in (raw, resolved):
        parts = path.parts
        if "homebrew" in parts:
            index = parts.index("homebrew")
            candidates.append(Path(*parts[: index + 1]))
        elif len(parts) >= 3 and parts[:3] == ("/", "opt", "homebrew"):
            candidates.append(Path("/opt/homebrew"))
        elif len(parts) >= 3 and parts[:3] == ("/", "usr", "local"):
            candidates.append(Path("/usr/local"))
        elif path.is_absolute():
            candidates.append(path.parent)
            virtualenv_root = path.parent.parent
            if (
                (virtualenv_root / "pyvenv.cfg").is_file()
                or virtualenv_root.name in {".venv", "venv"}
            ):
                candidates.append(virtualenv_root)
    unique: list[Path] = []
    for path in candidates:
        # Preserve literal compatibility paths such as /bin and /lib. On
        # merged-usr Linux hosts they may be symlinks, but the private tmpfs
        # root has no corresponding symlink unless we mount that literal path.
        literal_path = path.expanduser().absolute()
        if path.exists() and literal_path not in unique:
            unique.append(literal_path)
    return tuple(unique)


def _metadata_ancestors(paths: tuple[Path, ...]) -> tuple[Path, ...]:
    """Return literal parent directories needed for path traversal."""
    ancestors: list[Path] = []
    roots = {path.resolve() for path in paths}
    for path in roots:
        parent = path.parent
        while parent != parent.parent:
            if parent not in roots and parent not in ancestors:
                ancestors.append(parent)
            parent = parent.parent
    return tuple(ancestors)


def _private_temp(plugin_root: Path) -> tuple[Path, Callable[[], None]]:
    prefix = f"sophia-plugin-{plugin_root.name[:32]}-"
    root = Path(tempfile.mkdtemp(prefix=prefix)).resolve()

    def cleanup() -> None:
        shutil.rmtree(root, ignore_errors=True)

    return root, cleanup


class SeatbeltPluginSandboxProvider:
    """macOS Seatbelt provider using the installed ``sandbox-exec`` tool."""

    name = "seatbelt"

    def __init__(
        self,
        *,
        binary: str | None = None,
        platform_name: str | None = None,
    ):
        self.platform_name = platform_name or sys.platform
        self.binary = binary or shutil.which("sandbox-exec")

    def status(self, policy: PluginSandboxPolicy) -> PluginSandboxStatus:
        if self.platform_name != "darwin":
            return PluginSandboxStatus(
                provider=self.name,
                requested_mode=policy.mode,
                state="unavailable",
                filesystem=policy.filesystem,
                network=policy.network,
                processes=policy.processes,
                unsupported=("platform",),
                detail="Seatbelt provider is available only on macOS",
            )
        if not self.binary:
            return PluginSandboxStatus(
                provider=self.name,
                requested_mode=policy.mode,
                state="unavailable",
                filesystem=policy.filesystem,
                network=policy.network,
                processes=policy.processes,
                unsupported=("os-isolation",),
                detail="sandbox-exec was not found",
            )
        try:
            proc = subprocess.run(
                [
                    self.binary,
                    "-p",
                    "(version 1) (allow default)",
                    "/usr/bin/true",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return PluginSandboxStatus(
                provider=self.name,
                requested_mode=policy.mode,
                state="unavailable",
                filesystem=policy.filesystem,
                network=policy.network,
                processes=policy.processes,
                unsupported=("os-isolation",),
                detail=f"Seatbelt probe failed: {type(exc).__name__}",
            )
        if proc.returncode != 0:
            return PluginSandboxStatus(
                provider=self.name,
                requested_mode=policy.mode,
                state="unavailable",
                filesystem=policy.filesystem,
                network=policy.network,
                processes=policy.processes,
                unsupported=("os-isolation",),
                detail=f"Seatbelt probe failed: {_bounded_probe_error(proc)}",
            )
        if policy.processes == "isolated-tree":
            return PluginSandboxStatus(
                provider=self.name,
                requested_mode=policy.mode,
                state="partial",
                filesystem=policy.filesystem,
                network=policy.network,
                processes=policy.processes,
                unsupported=("detached-descendant-lifetime",),
                detail=(
                    "sandbox-exec can apply the Seatbelt profile to inherited "
                    "descendants, but macOS provides no retained kernel-owned "
                    "process container here; a descendant can create a new "
                    "session and outlive supervisor process-group cleanup"
                ),
            )
        return PluginSandboxStatus(
            provider=self.name,
            requested_mode=policy.mode,
            state="available",
            filesystem=policy.filesystem,
            network=policy.network,
            processes=policy.processes,
            detail=(
                "sandbox-exec accepted a live probe; no plugin profile is "
                "active yet, and sandbox-exec is deprecated by Apple"
            ),
        )

    def _profile(
        self,
        command: list[str],
        *,
        plugin_root: Path,
        workspace: Path,
        temp_root: Path,
        policy: PluginSandboxPolicy,
    ) -> str:
        plugin_root = plugin_root.resolve()
        workspace = workspace.resolve()
        temp_root = temp_root.resolve()
        executable = Path(command[0]).resolve()
        read_roots = list(
            _runtime_read_roots(
                command[0],
                platform_name="darwin",
            )
        )
        read_roots.extend((plugin_root, temp_root))
        if policy.filesystem in {"workspace-read", "workspace-write"}:
            read_roots.append(workspace)
        unique_read_roots = tuple(dict.fromkeys(read_roots))
        metadata_paths = _metadata_ancestors(
            (*unique_read_roots, Path(command[0]), executable)
        )
        lines = [
            "(version 1)",
            "(deny default)",
            '(import "system.sb")',
        ]
        if policy.network == "deny":
            lines.append("(deny network*)")
        if policy.processes == "deny-children":
            lines.extend(
                [
                    "(deny process-fork)",
                    "(deny process-exec)",
                ]
            )
        for path in metadata_paths:
            lines.append(
                f"(allow file-read-metadata (literal {_path_literal(path)}))"
            )
        for root in unique_read_roots:
            lines.append(
                f"(allow file-read* (subpath {_path_literal(root)}))"
            )
        lines.extend(
            [
                f"(allow file-read* (literal {_path_literal(command[0])}))",
                f"(allow file-read* (literal {_path_literal(executable)}))",
                f"(allow process-exec (literal {_path_literal(command[0])}))",
                f"(allow process-exec (literal {_path_literal(executable)}))",
                f"(allow file-write* (subpath {_path_literal(temp_root)}))",
            ]
        )
        if policy.filesystem == "workspace-write":
            lines.append(
                f"(allow file-write* (subpath {_path_literal(workspace)}))"
            )
        if policy.network == "allow":
            lines.append("(allow network*)")
        if policy.processes == "isolated-tree":
            lines.extend(
                [
                    "(allow process-fork)",
                    "(allow process-exec)",
                ]
            )
        return "\n".join(lines)

    def prepare(
        self,
        command: list[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        plugin_root: Path,
        workspace: Path,
        policy: PluginSandboxPolicy,
    ) -> PluginSandboxLaunch:
        del cwd
        status = self.status(policy)
        if status.state == "unavailable" or not self.binary:
            return _direct_launch(
                self.name,
                command,
                env,
                policy,
                state="unavailable",
                detail=status.detail,
                unsupported=status.unsupported,
            )
        temp_root, cleanup = _private_temp(plugin_root)
        child_env = dict(env)
        child_env["TMPDIR"] = str(temp_root)
        profile = self._profile(
            command,
            plugin_root=plugin_root,
            workspace=workspace,
            temp_root=temp_root,
            policy=policy,
        )
        return PluginSandboxLaunch(
            argv=[self.binary, "-p", profile, *command],
            env=child_env,
            status=replace(
                status,
                state=(
                    "partial"
                    if status.state == "partial"
                    else "enforced"
                ),
                enforced=(
                    (
                        "filesystem",
                        "network",
                        "environment",
                        "descendant-sandbox-profile",
                    )
                    if status.state == "partial"
                    else (
                        "filesystem",
                        "network",
                        "process",
                        "environment",
                    )
                ),
                applied=True,
                detail=(
                    status.detail
                    if status.state == "partial"
                    else (
                        "Seatbelt profile selected for this sidecar; status "
                        "is reported as sandboxed only while the wrapped "
                        "process is active"
                    )
                ),
            ),
            cleanup=cleanup,
        )


def _linux_runtime_config_paths(network: str) -> tuple[Path, ...]:
    paths = [
        Path("/etc/ssl"),
        Path("/etc/pki"),
        Path("/etc/alternatives"),
        Path("/etc/passwd"),
        Path("/etc/group"),
        Path("/etc/localtime"),
    ]
    if network == "allow":
        paths.extend(
            [
                Path("/etc/hosts"),
                Path("/etc/nsswitch.conf"),
                Path("/etc/resolv.conf"),
            ]
        )
    return tuple(path for path in paths if path.exists())


class BubblewrapPluginSandboxProvider:
    """Linux mount/network/PID namespace provider using bubblewrap."""

    name = "bubblewrap"

    def __init__(
        self,
        *,
        binary: str | None = None,
        platform_name: str | None = None,
    ):
        self.platform_name = platform_name or sys.platform
        self.binary = binary or shutil.which("bwrap")

    def status(self, policy: PluginSandboxPolicy) -> PluginSandboxStatus:
        if not self.platform_name.startswith("linux"):
            return PluginSandboxStatus(
                provider=self.name,
                requested_mode=policy.mode,
                state="unavailable",
                filesystem=policy.filesystem,
                network=policy.network,
                processes=policy.processes,
                unsupported=("platform",),
                detail="bubblewrap provider is available only on Linux",
            )
        if not self.binary:
            return PluginSandboxStatus(
                provider=self.name,
                requested_mode=policy.mode,
                state="unavailable",
                filesystem=policy.filesystem,
                network=policy.network,
                processes=policy.processes,
                unsupported=("os-isolation",),
                detail="bwrap was not found",
            )
        true_bin = shutil.which("true") or "/usr/bin/true"
        try:
            proc = subprocess.run(
                [
                    self.binary,
                    "--die-with-parent",
                    "--unshare-all",
                    "--cap-drop",
                    "ALL",
                    "--ro-bind",
                    "/",
                    "/",
                    "--proc",
                    "/proc",
                    "--dev",
                    "/dev",
                    true_bin,
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return PluginSandboxStatus(
                provider=self.name,
                requested_mode=policy.mode,
                state="unavailable",
                filesystem=policy.filesystem,
                network=policy.network,
                processes=policy.processes,
                unsupported=("os-isolation",),
                detail=f"bubblewrap probe failed: {type(exc).__name__}",
            )
        if proc.returncode != 0:
            return PluginSandboxStatus(
                provider=self.name,
                requested_mode=policy.mode,
                state="unavailable",
                filesystem=policy.filesystem,
                network=policy.network,
                processes=policy.processes,
                unsupported=("os-isolation",),
                detail=f"bubblewrap probe failed: {_bounded_probe_error(proc)}",
            )
        unsupported: tuple[str, ...] = ()
        state = "available"
        detail = (
            "bubblewrap mount, network, and PID namespace probe passed; "
            "no plugin namespace is active yet"
        )
        if policy.processes == "deny-children":
            unsupported = ("deny-children",)
            state = "partial"
            detail = (
                "bubblewrap confines descendants to the owned namespace but "
                "does not by itself deny child creation"
            )
        return PluginSandboxStatus(
            provider=self.name,
            requested_mode=policy.mode,
            state=state,
            filesystem=policy.filesystem,
            network=policy.network,
            processes=policy.processes,
            unsupported=unsupported,
            detail=detail,
        )

    @staticmethod
    def _argv(
        binary: str,
        command: list[str],
        *,
        cwd: Path,
        plugin_root: Path,
        workspace: Path,
        policy: PluginSandboxPolicy,
    ) -> list[str]:
        read_roots = list(
            _runtime_read_roots(
                command[0],
                platform_name="linux",
            )
        )
        read_roots.extend(_linux_runtime_config_paths(policy.network))
        argv = [
            binary,
            "--die-with-parent",
            "--unshare-all",
            "--cap-drop",
            "ALL",
        ]
        if policy.network == "allow":
            argv.append("--share-net")
        argv.extend(["--tmpfs", "/"])
        destinations = [
            *read_roots,
            plugin_root,
            Path("/tmp"),
            Path("/proc"),
            Path("/dev"),
        ]
        if policy.filesystem in {"workspace-read", "workspace-write"}:
            destinations.append(workspace)
        destination_parents: list[Path] = []
        for destination in destinations:
            parent = destination.parent
            chain: list[Path] = []
            while parent != parent.parent:
                chain.append(parent)
                parent = parent.parent
            for candidate in reversed(chain):
                if (
                    candidate != Path("/")
                    and candidate not in destination_parents
                ):
                    destination_parents.append(candidate)
        for destination_parent in destination_parents:
            argv.extend(["--dir", str(destination_parent)])
        argv.extend(["--tmpfs", "/tmp"])
        for root in dict.fromkeys(read_roots):
            argv.extend(["--ro-bind", str(root), str(root)])
        argv.extend(
            [
                "--ro-bind",
                str(plugin_root),
                str(plugin_root),
            ]
        )
        if policy.filesystem == "workspace-read":
            argv.extend(
                [
                    "--ro-bind",
                    str(workspace),
                    str(workspace),
                ]
            )
        elif policy.filesystem == "workspace-write":
            argv.extend(
                [
                    "--bind",
                    str(workspace),
                    str(workspace),
                ]
            )
        argv.extend(
            [
                "--proc",
                "/proc",
                "--dev",
                "/dev",
            ]
        )
        argv.extend(["--chdir", str(cwd), *command])
        return argv

    def prepare(
        self,
        command: list[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        plugin_root: Path,
        workspace: Path,
        policy: PluginSandboxPolicy,
    ) -> PluginSandboxLaunch:
        status = self.status(policy)
        if status.state == "unavailable" or not self.binary:
            return _direct_launch(
                self.name,
                command,
                env,
                policy,
                state="unavailable",
                detail=status.detail,
                unsupported=status.unsupported,
            )
        argv = self._argv(
            self.binary,
            command,
            cwd=cwd,
            plugin_root=plugin_root,
            workspace=workspace,
            policy=policy,
        )
        child_env = dict(env)
        child_env["TMPDIR"] = "/tmp"
        return PluginSandboxLaunch(
            argv=argv,
            env=child_env,
            status=replace(
                status,
                state=(
                    "partial"
                    if status.state == "partial"
                    else "enforced"
                ),
                enforced=(
                    "filesystem",
                    "network",
                    "environment",
                    "process-namespace",
                ),
                applied=True,
                detail=(
                    status.detail
                    if status.state == "partial"
                    else (
                        "bubblewrap namespaces and mounts selected for this "
                        "sidecar; status is reported as sandboxed only while "
                        "the wrapped process is active"
                    )
                ),
            ),
        )


def plugin_sandbox_provider(
    policy: PluginSandboxPolicy,
    *,
    platform_name: str | None = None,
) -> PluginSandboxProvider:
    """Select the requested platform provider without porous substitution."""
    if not policy.requested:
        return NoPluginSandboxProvider()
    platform_value = platform_name or sys.platform
    requested = policy.provider
    if requested == "seatbelt":
        return SeatbeltPluginSandboxProvider(platform_name=platform_value)
    if requested == "bubblewrap":
        return BubblewrapPluginSandboxProvider(platform_name=platform_value)
    if platform_value == "darwin":
        return SeatbeltPluginSandboxProvider(platform_name=platform_value)
    if platform_value.startswith("linux"):
        return BubblewrapPluginSandboxProvider(platform_name=platform_value)
    if platform_value == "win32":
        return UnavailablePluginSandboxProvider(
            "windows-unsupported",
            "Windows plugin sidecar isolation is not implemented; "
            "AppContainer/job-object support remains explicit future work",
        )
    return UnavailablePluginSandboxProvider(
        "unsupported-platform",
        f"no plugin sidecar sandbox provider for platform {platform_value}",
    )


__all__ = [
    "BubblewrapPluginSandboxProvider",
    "NoPluginSandboxProvider",
    "PluginSandboxLaunch",
    "PluginSandboxProvider",
    "PluginSandboxStatus",
    "SeatbeltPluginSandboxProvider",
    "UnavailablePluginSandboxProvider",
    "plugin_sandbox_provider",
]
