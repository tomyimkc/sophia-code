# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Docker sandbox backend — the real-isolation path for the terminal tool's bash.

Runs a command inside a hardened, throwaway container. On a dev box without the
kernel-sealing primitives ``os_sophia`` needs, Docker (routing through its Linux VM
on macOS, or the host on Linux) is the practical real netns/cgroup isolation.
"""
from __future__ import annotations

import subprocess

_IMAGE = "python:3.12-slim"


class DockerBackend:
    """Run a shell command in a locked-down ``docker run`` container.

    Hardening (non-negotiable argv): no network by default, all caps dropped, no new
    privileges, read-only root fs with a small tmpfs, memory + pid limits, and only
    the working directory bind-mounted rw.
    """
    name = "docker"

    def __init__(self, *, image: str = _IMAGE, net: bool = False,
                 memory: str = "512m", pids_limit: int = 256) -> None:
        self.image = image
        self.net = net
        self.memory = memory
        self.pids_limit = pids_limit

    def available(self) -> bool:
        try:
            proc = subprocess.run(["docker", "info"], capture_output=True, timeout=10)
            return proc.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def _argv(self, command: str, *, cwd: str) -> "list[str]":
        argv = [
            "docker", "run", "--rm",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--read-only",
            "--tmpfs", "/tmp",
            "--memory", self.memory,
            "--pids-limit", str(self.pids_limit),
            "-v", f"{cwd}:{cwd}:rw",
            "--workdir", cwd,
        ]
        if not self.net:
            argv.append("--network=none")
        # command passed as a single argv element to bash -lc (never shell=True here).
        argv += [self.image, "bash", "-lc", command]
        return argv

    def run_shell(self, command: str, *, timeout: float, cwd: str) -> "tuple[int, str]":
        try:
            proc = subprocess.run(self._argv(command, cwd=cwd), capture_output=True,
                                  text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return (124, f"[sandbox timeout after {timeout}s]")
        except OSError as exc:
            return (126, f"[sandbox launch failed: {exc}]")
        out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        return (proc.returncode, out.strip() or "(no output)")
