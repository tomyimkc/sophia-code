# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Apple ``container`` sandbox backend — persistent-container isolation for /tbench.

Distinct from :class:`agent.sandbox.docker_backend.DockerBackend` (which spins up
a fresh ``docker run --rm`` per command and loses state between calls), this
backend keeps ONE container alive for the lifetime of a task and routes every
``run_shell`` into it via ``container exec``. That persistence is what terminal-bench
needs: the agent installs a package in one bash call and uses it in the next, or
compiles an artifact that a later step depends on.

Why Apple ``container`` (not Docker): native to Apple Silicon, lighter than Docker
Desktop, runs Linux containers as lightweight VMs on macOS 26+. Selected by the
operator for the local M-series test bed. The CLI contract (verified against the
1.1.0 command reference):

  - ``container image pull <ref>``           — pull an OCI image
  - ``container run -d --name <id> [-v h:c] [--env K=V] <image> <cmd...>``
      — start detached; ``--name`` is the id used by later ``exec``/``cp``
  - ``container exec [--workdir d] <id> <cmd...>``  — run a command inside
  - ``container cp <src> <dst>``             — one side must be ``id:path``
  - ``container stop <id>`` / ``container rm <id>`` — teardown

Lifecycle (owned by the caller, e.g. ``_handle_tbench``)::

    be = AppleContainerBackend(image="alexgshaw/regex-log:20251031", name="tbench-regex-log-7f3")
    be.start(workdir="/app")          # pull + run -d + sleep keepalive
    rc, out = be.run_shell("ls", timeout=60, cwd="/app")   # → container exec
    data = be.read_file("/app/regex.txt")                  # → exec cat
    be.write_file("/app/x.txt", "hi")                      # → cp from a host tmp
    be.stop()                         # stop + rm, best-effort, never raises

candidateOnly: true · canClaimAGI: false — containment plumbing, no claim.
"""
from __future__ import annotations

import os
import secrets
import subprocess
import tempfile
from pathlib import Path


class AppleContainerBackend:
    """Persistent-container exec backend over Apple ``container``.

    Implements the :class:`agent.sandbox.base.ExecBackend` ``run_shell`` contract
    (so the bash tool routes through it) PLUS file IO helpers (``read_file`` /
    ``write_file``) the terminal-bench handler uses to bridge host-side tool calls
    into the container's ``/app``. The container is started once per task and torn
    down on ``stop()``; every ``run_shell`` is a ``container exec`` into the same
    live container so filesystem state persists across the agent's steps.
    """

    name = "apple-container"

    def __init__(
        self,
        *,
        image: str,
        name: str | None = None,
        workdir: str = "/app",
        env: "dict[str, str] | None" = None,
        volumes: "dict[str, str] | None" = None,
        net: bool = True,
        platform: str | None = None,
        rosetta: bool = False,
        container_bin: str = "container",
    ) -> None:
        self.image = image
        # A unique container name per task so two tasks never collide and a
        # crashed run can't leave a dangling same-named container.
        self.name = name or f"tbench-{secrets.token_hex(4)}"
        self.workdir = workdir
        self.env = dict(env or {})
        # host_dir -> container_dir bind mounts (e.g. mounting the tests/ dir).
        self.volumes = dict(volumes or {})
        self.net = net
        # terminal-bench task images are published linux/amd64; on Apple Silicon
        # we run them under Rosetta. ``platform`` forces the image arch (e.g.
        # "linux/amd64"); ``rosetta`` enables the x86 translation layer. Both
        # default off so a caller with arm64 images pays no emulation cost.
        self.platform = platform
        self.rosetta = rosetta
        self._bin = container_bin
        self._started = False

    # -- lifecycle -------------------------------------------------------- #
    def available(self) -> bool:
        """True iff the ``container`` CLI is on PATH and its service is up."""
        try:
            proc = subprocess.run([self._bin, "system", "status"],
                                  capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            return False
        return proc.returncode == 0 and "running" in (proc.stdout or "").lower()

    def start(self, workdir: str | None = None) -> str:
        """Pull (if needed) and start the container detached. Returns its name.

        Idempotent: a second ``start`` is a no-op. The keepalive is a long
        ``sleep`` so the container stays up between ``exec`` calls; the agent's
        own commands are the subsequent ``exec`` invocations.
        """
        if self._started:
            return self.name
        wd = workdir or self.workdir
        # Pull first (run will pull implicitly, but an explicit pull gives a
        # cleaner error when the image name is wrong and avoids a half-started
        # container on a registry/auth fault).
        self._run([self._bin, "image", "pull", self.image], check=False, timeout=600)
        argv = [self._bin, "run", "-d", "--name", self.name, "--workdir", wd]
        if self.platform:
            argv += ["--platform", self.platform]
        if self.rosetta:
            argv.append("--rosetta")
        for k, v in self.env.items():
            argv += ["--env", f"{k}={v}"]
        for host, cont in self.volumes.items():
            argv += ["-v", f"{host}:{cont}"]
        if not self.net:
            argv.append("--network=none")
        # sleep keeps the init process alive; agent commands come via `exec`.
        argv += [self.image, "sh", "-c", "sleep 86400"]
        self._run(argv, check=True, timeout=120)
        self._started = True
        return self.name

    def stop(self) -> None:
        """Stop + remove the container. Best-effort: never raises (teardown path)."""
        if not self._started:
            return
        for argv in ([self._bin, "stop", self.name], [self._bin, "rm", self.name]):
            try:
                self._run(argv, check=False, timeout=60)
            except Exception:  # noqa: BLE001 — teardown must never raise
                pass
        self._started = False

    # -- ExecBackend contract (the bash tool calls this) ----------------- #
    def run_shell(self, command: str, *, timeout: float, cwd: str) -> "tuple[int, str]":
        """Run ``command`` inside the container via ``container exec``.

        ``cwd`` is honored as the exec workdir when set (the bash tool passes
        ``ctx.root``; for terminal-bench that maps to the container's ``/app``).
        Returns ``(returncode, combined stdout+stderr)`` per the ExecBackend
        contract. Timeouts return 124 (matching the docker backend).
        """
        argv = [self._bin, "exec"]
        if cwd:
            argv += ["--workdir", cwd]
        argv += [self.name, "sh", "-c", command]
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return (124, f"[sandbox timeout after {timeout}s]")
        except OSError as exc:
            return (126, f"[sandbox launch failed: {exc}]")
        out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        return (proc.returncode, out.strip() or "(no output)")

    # -- file IO helpers (the terminal-bench handler uses these) --------- #
    def read_file(self, container_path: str) -> str:
        """Read a file from the container (``exec cat``). Raises on missing."""
        rc, out = self.run_shell(f"cat {self._shell_quote(container_path)}",
                                 timeout=30, cwd=self.workdir)
        if rc != 0:
            raise FileNotFoundError(f"container read failed ({rc}): {container_path}")
        return out

    def write_file(self, container_path: str, content: str) -> None:
        """Write ``content`` to ``container_path`` in the container via ``cp``.

        We stage the bytes in a host temp file then ``container cp`` it in — this
        avoids shell-quoting a potentially-large/multiline content blob onto an
        ``echo``/``printf`` (which would mangle it). The temp file is removed
        immediately after the copy.
        """
        with tempfile.NamedTemporaryFile("w", suffix="-tbench-cp", delete=False,
                                         encoding="utf-8") as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        try:
            # cp semantics: one side must be id:path. Host file → container path.
            self._run([self._bin, "cp", tmp_path, f"{self.name}:{container_path}"],
                      check=True, timeout=60)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                # Best-effort cleanup: the host temp file may already be gone.
                pass

    def copy_in(self, host_dir: str, container_dir: str) -> None:
        """Copy a host directory tree into the container at ``container_dir``.

        Apple ``container cp`` does NOT auto-extract tarballs (unlike Docker cp
        of a stream) — it copies the file as-is. So we tar on the host, ``cp``
        the tarball into the container, then ``tar -xf`` it in place. Files are
        copied with paths relative to ``host_dir`` so the tree reconstructs under
        ``container_dir``. Used by the faithful scorer to place the task's
        ``tests/`` tree at ``/tests``. Public so callers don't reach into privates.
        """
        import tarfile

        with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as tmp:
            tmp_path = tmp.name
            with tarfile.open(tmp_path, mode="w") as tar:
                for p in Path(host_dir).rglob("*"):
                    if p.is_file():
                        tar.add(p, arcname=str(p.relative_to(host_dir)))
        try:
            # 0. ensure the destination dir exists (container cp errors on a missing
            #    target dir, unlike mkdir-then-cp on the host).
            self.run_shell(f"mkdir -p {self._shell_quote(container_dir)}",
                           timeout=30, cwd=container_dir)
            # 1. cp the tarball into the container (lands as <container_dir>/<basename>).
            self._run([self._bin, "cp", tmp_path, f"{self.name}:{container_dir}/"],
                      check=True, timeout=120)
            # 2. extract it in place + remove the tarball. Quote the basename so a
            #    weird tmp suffix can't break the shell line.
            base = self._shell_quote(Path(tmp_path).name)
            self.run_shell(
                f"cd {self._shell_quote(container_dir)} && tar -xf {base} && rm -f {base}",
                timeout=60, cwd=container_dir,
            )
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                # Best-effort cleanup: the host tarball may already be gone.
                pass

    # -- internals -------------------------------------------------------- #
    def _run(self, argv: list[str], *, check: bool, timeout: float) -> subprocess.CompletedProcess:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        if check and proc.returncode != 0:
            raise RuntimeError(
                f"{' '.join(argv[:3])}… exit {proc.returncode}: "
                f"{(proc.stderr or proc.stdout or '').strip()[:300]}"
            )
        return proc

    @staticmethod
    def _shell_quote(s: str) -> str:
        return "'" + str(s).replace("'", "'\"'\"'") + "'"
