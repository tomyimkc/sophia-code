# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Plugin discovery, user-owned enablement state, and operational lockfiles."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import stat
import sys
import tempfile
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback below.
    fcntl = None  # type: ignore[assignment]

try:
    import msvcrt
except ImportError:  # pragma: no cover - POSIX uses fcntl above.
    msvcrt = None  # type: ignore[assignment]

from agent.plugin_integrity import (
    PackageVerification,
    PluginIntegrityError,
    PluginIntegrityPolicy,
    verify_package_source,
)
from agent.plugin_manifest import (
    MANIFEST_FILENAME,
    PluginManifest,
    PluginManifestError,
    load_manifest,
    manifest_public_dict,
    plugin_package_digest,
)
from agent.plugin_policy import PluginPolicyError, validate_permissions
from agent.runtime_paths import user_state_dir

STATE_SCHEMA = "sophia.plugin-state/v1"
LOCK_SCHEMA = "sophia.plugins-lock/v1"
PORTABLE_LOCK_SCHEMA = "sophia.plugins-portable-lock/v1"
MAX_PORTABLE_LOCK_BYTES = 1_048_576


class PluginLockError(ValueError):
    """Raised when a portable plugin lock is malformed or has drifted."""


_AUTHORITY_LOCKS_GUARD = threading.Lock()
_AUTHORITY_THREAD_LOCKS: dict[str, threading.RLock] = {}
_AUTHORITY_TRANSACTION_DEPTHS = threading.local()


def _shared_authority_thread_lock(path: Path) -> threading.RLock:
    """Return the process-local half of a path-scoped authority lock."""
    key = str(path)
    with _AUTHORITY_LOCKS_GUARD:
        lock = _AUTHORITY_THREAD_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _AUTHORITY_THREAD_LOCKS[key] = lock
        return lock


def _state_fingerprint(state: dict[str, Any]) -> str:
    encoded = json.dumps(
        state,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _absolute_without_resolving(path: str | Path) -> Path:
    try:
        return Path(os.path.abspath(os.fspath(Path(path).expanduser())))
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise PluginLockError("portable plugin lock path is invalid") from exc


def _check_path_components(
    path: Path,
    *,
    create_parents: bool,
) -> None:
    """Reject symlinked parents without resolving the caller-supplied path."""
    parent = path.parent
    anchor = Path(parent.anchor)
    current = anchor
    for part in parent.parts[len(anchor.parts) :]:
        current = current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if not create_parents:
                raise PluginLockError(
                    "portable plugin lock parent does not exist"
                )
            try:
                current.mkdir(mode=0o700)
                metadata = current.lstat()
            except FileExistsError:
                # A cooperating process may have created this component after
                # our lstat. Inspect that winner instead of failing startup.
                try:
                    metadata = current.lstat()
                except OSError as exc:
                    raise PluginLockError(
                        "portable plugin lock parent could not be inspected"
                    ) from exc
            except OSError as exc:
                raise PluginLockError(
                    "portable plugin lock parent could not be created"
                ) from exc
        except OSError as exc:
            raise PluginLockError(
                "portable plugin lock parent could not be inspected"
            ) from exc
        if stat.S_ISLNK(metadata.st_mode):
            raise PluginLockError(
                "portable plugin lock path contains a parent symlink"
            )
        if not stat.S_ISDIR(metadata.st_mode):
            raise PluginLockError(
                "portable plugin lock parent is not a directory"
            )


def _descriptor_no_follow_supported() -> bool:
    return not (
        os.name == "nt"
        or not hasattr(os, "O_DIRECTORY")
        or not hasattr(os, "O_NOFOLLOW")
        or os.open not in os.supports_dir_fd
        or os.stat not in os.supports_dir_fd
        or os.rename not in os.supports_dir_fd
        or os.unlink not in os.supports_dir_fd
    )


def _open_parent_directory_no_follow(path: Path) -> int | None:
    """Open each POSIX parent component relative to the prior descriptor."""
    if not _descriptor_no_follow_supported():
        return None
    anchor = Path(path.parent.anchor)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(anchor, flags)
    try:
        for part in path.parent.parts[len(anchor.parts) :]:
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def _validate_lock_leaf(
    path: Path,
    *,
    parent_fd: int | None,
    allow_missing: bool,
) -> None:
    try:
        if parent_fd is None:
            metadata = path.lstat()
        else:
            metadata = os.stat(
                path.name,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
    except FileNotFoundError:
        if allow_missing:
            return
        raise PluginLockError("portable plugin lock does not exist")
    except OSError as exc:
        raise PluginLockError(
            "portable plugin lock could not be inspected"
        ) from exc
    if stat.S_ISLNK(metadata.st_mode):
        raise PluginLockError("portable plugin lock path is a symlink")
    if not stat.S_ISREG(metadata.st_mode):
        raise PluginLockError("portable plugin lock is not a regular file")


def _reopen_stable_parent(path: Path, parent_fd: int) -> int:
    """Reopen the advertised lexical parent and confirm it is still held."""
    reopened = _open_parent_directory_no_follow(path)
    if reopened is None:
        raise PluginLockError(
            "portable plugin locks require descriptor-relative no-follow support"
        )
    try:
        held = os.fstat(parent_fd)
        visible = os.fstat(reopened)
        if (
            held.st_dev,
            held.st_ino,
            stat.S_IFMT(held.st_mode),
        ) != (
            visible.st_dev,
            visible.st_ino,
            stat.S_IFMT(visible.st_mode),
        ):
            raise PluginLockError(
                "portable plugin lock parent changed while being accessed"
            )
    except BaseException:
        os.close(reopened)
        raise
    return reopened


def _confirm_lock_leaf(
    path: Path,
    *,
    parent_fd: int,
    expected: os.stat_result,
    expected_bytes: bytes | None = None,
) -> None:
    """Confirm the visible leaf still names the opened regular file."""
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    try:
        fd = os.open(path.name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise PluginLockError(
            "portable plugin lock visible replacement could not be opened"
        ) from exc
    try:
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino, opened.st_size)
            != (expected.st_dev, expected.st_ino, expected.st_size)
        ):
            raise PluginLockError(
                "portable plugin lock visible replacement could not be confirmed"
            )
        if expected_bytes is not None:
            confirmed = bytearray()
            while len(confirmed) <= len(expected_bytes):
                chunk = os.read(
                    fd,
                    min(65_536, len(expected_bytes) + 1 - len(confirmed)),
                )
                if not chunk:
                    break
                confirmed.extend(chunk)
            if bytes(confirmed) != expected_bytes:
                raise PluginLockError(
                    "portable plugin lock atomic replacement could not be confirmed"
                )
        current = os.stat(
            path.name,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if (
            current.st_dev,
            current.st_ino,
            current.st_size,
        ) != (
            opened.st_dev,
            opened.st_ino,
            opened.st_size,
        ):
            raise PluginLockError(
                "portable plugin lock visible replacement could not be confirmed"
            )
    finally:
        os.close(fd)


def _write_json_atomic(
    path: Path,
    payload: dict[str, Any],
    *,
    require_descriptor_no_follow: bool = False,
) -> None:
    path = _absolute_without_resolving(path)
    if require_descriptor_no_follow and not _descriptor_no_follow_supported():
        raise PluginLockError(
            "portable plugin locks require descriptor-relative no-follow support"
        )
    _check_path_components(path, create_parents=True)
    encoded = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    encoded_bytes = encoded.encode("utf-8")
    parent_fd: int | None = None
    temp_name: str | None = None
    try:
        parent_fd = _open_parent_directory_no_follow(path)
        if require_descriptor_no_follow and parent_fd is None:
            raise PluginLockError(
                "portable plugin locks require descriptor-relative no-follow support"
            )
        _validate_lock_leaf(path, parent_fd=parent_fd, allow_missing=True)
        if parent_fd is not None:
            temp_name = f".{path.name}.{uuid.uuid4().hex}.tmp"
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open(temp_name, flags, 0o600, dir_fd=parent_fd)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            _validate_lock_leaf(path, parent_fd=parent_fd, allow_missing=True)
            os.replace(
                temp_name,
                path.name,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
            )
            if require_descriptor_no_follow:
                verify_flags = os.O_RDONLY | os.O_NOFOLLOW
                if hasattr(os, "O_NONBLOCK"):
                    verify_flags |= os.O_NONBLOCK
                verify_fd = os.open(path.name, verify_flags, dir_fd=parent_fd)
                try:
                    verify_metadata = os.fstat(verify_fd)
                    if not stat.S_ISREG(verify_metadata.st_mode):
                        raise PluginLockError(
                            "portable plugin lock replacement is not a regular file"
                        )
                    confirmed = bytearray()
                    while len(confirmed) <= len(encoded_bytes):
                        chunk = os.read(
                            verify_fd,
                            min(65_536, len(encoded_bytes) + 1 - len(confirmed)),
                        )
                        if not chunk:
                            break
                        confirmed.extend(chunk)
                    current = os.stat(
                        path.name,
                        dir_fd=parent_fd,
                        follow_symlinks=False,
                    )
                    if (
                        not stat.S_ISREG(current.st_mode)
                        or (verify_metadata.st_dev, verify_metadata.st_ino)
                        != (current.st_dev, current.st_ino)
                        or bytes(confirmed) != encoded_bytes
                    ):
                        raise PluginLockError(
                            "portable plugin lock atomic replacement could not "
                            "be confirmed"
                        )
                finally:
                    os.close(verify_fd)
                visible_parent_fd = _reopen_stable_parent(path, parent_fd)
                try:
                    _confirm_lock_leaf(
                        path,
                        parent_fd=visible_parent_fd,
                        expected=verify_metadata,
                        expected_bytes=encoded_bytes,
                    )
                finally:
                    os.close(visible_parent_fd)
            temp_name = None
            try:
                os.fsync(parent_fd)
            except OSError:
                pass
        else:
            fd, temp_name = tempfile.mkstemp(
                prefix=f".{path.name}.",
                dir=str(path.parent),
            )
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            _check_path_components(path, create_parents=False)
            _validate_lock_leaf(path, parent_fd=None, allow_missing=True)
            os.replace(temp_name, path)
            temp_name = None
    except PluginLockError:
        raise
    except Exception:
        raise
    finally:
        if temp_name is not None:
            try:
                if parent_fd is None:
                    os.unlink(temp_name)
                else:
                    os.unlink(temp_name, dir_fd=parent_fd)
            except OSError:
                pass
        if parent_fd is not None:
            os.close(parent_fd)


def _read_bounded_regular_file(
    path: Path,
    *,
    maximum: int,
    require_descriptor_no_follow: bool = False,
) -> bytes:
    path = _absolute_without_resolving(path)
    if require_descriptor_no_follow and not _descriptor_no_follow_supported():
        raise PluginLockError(
            "portable plugin locks require descriptor-relative no-follow support"
        )
    _check_path_components(path, create_parents=False)
    parent_fd: int | None = None
    fd: int | None = None
    chunks: list[bytes] = []
    total = 0
    try:
        parent_fd = _open_parent_directory_no_follow(path)
        if require_descriptor_no_follow and parent_fd is None:
            raise PluginLockError(
                "portable plugin locks require descriptor-relative no-follow support"
            )
        _validate_lock_leaf(path, parent_fd=parent_fd, allow_missing=False)
        flags = os.O_RDONLY
        if hasattr(os, "O_NONBLOCK"):
            flags |= os.O_NONBLOCK
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        if parent_fd is None:
            fd = os.open(path, flags)
        else:
            fd = os.open(path.name, flags, dir_fd=parent_fd)
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise PluginLockError("portable plugin lock is not a regular file")
        if metadata.st_size > maximum:
            raise PluginLockError(
                f"portable plugin lock exceeds {maximum} bytes"
            )
        while True:
            chunk = os.read(fd, min(65_536, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                raise PluginLockError(
                    f"portable plugin lock exceeds {maximum} bytes"
                )
        after = os.fstat(fd)
        if parent_fd is None:
            current = path.lstat()
        else:
            current = os.stat(
                path.name,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
        if (
            total != metadata.st_size
            or (metadata.st_dev, metadata.st_ino, metadata.st_size)
            != (after.st_dev, after.st_ino, after.st_size)
            or (after.st_dev, after.st_ino, after.st_size)
            != (current.st_dev, current.st_ino, current.st_size)
        ):
            raise PluginLockError(
                "portable plugin lock changed while being read"
            )
        encoded = b"".join(chunks)
        if require_descriptor_no_follow and parent_fd is not None:
            visible_parent_fd = _reopen_stable_parent(path, parent_fd)
            try:
                _confirm_lock_leaf(
                    path,
                    parent_fd=visible_parent_fd,
                    expected=after,
                    expected_bytes=encoded,
                )
            finally:
                os.close(visible_parent_fd)
    finally:
        if fd is not None:
            os.close(fd)
        if parent_fd is not None:
            os.close(parent_fd)
    return encoded


def _confirm_authority_lock_identity(
    path: Path,
    *,
    parent_fd: int | None,
    opened: os.stat_result,
) -> None:
    """Confirm the process lock still names the opened regular file."""
    try:
        if parent_fd is None:
            current = path.lstat()
        else:
            current = os.stat(
                path.name,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
    except OSError as exc:
        raise PluginLockError(
            "plugin state process lock could not be confirmed"
        ) from exc
    if (
        not stat.S_ISREG(opened.st_mode)
        or not stat.S_ISREG(current.st_mode)
        or (opened.st_dev, opened.st_ino)
        != (current.st_dev, current.st_ino)
    ):
        raise PluginLockError(
            "plugin state process lock must be a stable regular file"
        )
    if parent_fd is not None:
        visible_parent_fd = _reopen_stable_parent(path, parent_fd)
        try:
            visible = os.stat(
                path.name,
                dir_fd=visible_parent_fd,
                follow_symlinks=False,
            )
            if (
                not stat.S_ISREG(visible.st_mode)
                or (opened.st_dev, opened.st_ino)
                != (visible.st_dev, visible.st_ino)
            ):
                raise PluginLockError(
                    "plugin state process lock visible identity changed"
                )
        finally:
            os.close(visible_parent_fd)


def _confirm_authority_lock_distinct(
    path: Path,
    opened: os.stat_result,
    protected_paths: tuple[Path, ...],
) -> None:
    """Reject aliases/hardlinks before the lock leaf is ever mutated."""
    if opened.st_nlink != 1:
        raise PluginLockError(
            "plugin state process lock must have exactly one link"
        )
    authority_key = os.path.normpath(str(path)).casefold()
    for protected in protected_paths:
        if authority_key == os.path.normpath(str(protected)).casefold():
            raise PluginLockError(
                "plugin state process lock collides with persisted authority"
            )
        try:
            protected_metadata = protected.stat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise PluginLockError(
                "plugin state process lock collision could not be checked"
            ) from exc
        if (opened.st_dev, opened.st_ino) == (
            protected_metadata.st_dev,
            protected_metadata.st_ino,
        ):
            raise PluginLockError(
                "plugin state process lock aliases persisted authority"
            )


@contextmanager
def _authority_process_lock(
    path: Path,
    *,
    protected_paths: tuple[Path, ...],
) -> Iterator[None]:
    """Hold a no-follow OS process lock, or fail closed if unsupported.

    The user-state parent is a trusted ownership boundary. The visible leaf is
    nevertheless checked before any mutation, after acquisition, and after the
    transaction body so a replacement fails loudly instead of being accepted
    as a coordinated lock.
    """
    if fcntl is None and msvcrt is None:
        raise PluginLockError(
            "plugin state requires an available process-lock backend"
        )
    lock_path = _absolute_without_resolving(path)
    _check_path_components(lock_path, create_parents=True)
    parent_fd: int | None = None
    fd: int | None = None
    acquired = False
    try:
        parent_fd = _open_parent_directory_no_follow(lock_path)
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        if parent_fd is None:
            fd = os.open(lock_path, flags, 0o600)
        else:
            fd = os.open(
                lock_path.name,
                flags,
                0o600,
                dir_fd=parent_fd,
            )
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise PluginLockError(
                "plugin state process lock is not a regular file"
            )
        _confirm_authority_lock_distinct(
            lock_path,
            opened,
            protected_paths,
        )
        _confirm_authority_lock_identity(
            lock_path,
            parent_fd=parent_fd,
            opened=opened,
        )
        if os.name != "nt":
            # On POSIX, a failure to make the coordination file private is an
            # authority-lock failure. Windows access is governed by the parent
            # directory ACL and does not expose portable fchmod semantics.
            os.fchmod(fd, 0o600)
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        else:
            assert msvcrt is not None
            if opened.st_size == 0:
                os.lseek(fd, 0, os.SEEK_SET)
                os.write(fd, b"\0")
                os.fsync(fd)
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        acquired = True
        opened = os.fstat(fd)
        _confirm_authority_lock_distinct(
            lock_path,
            opened,
            protected_paths,
        )
        _confirm_authority_lock_identity(
            lock_path,
            parent_fd=parent_fd,
            opened=opened,
        )
        yield
        _confirm_authority_lock_distinct(
            lock_path,
            opened,
            protected_paths,
        )
        _confirm_authority_lock_identity(
            lock_path,
            parent_fd=parent_fd,
            opened=opened,
        )
    except PluginLockError:
        raise
    except OSError as exc:
        if acquired:
            # OSError subclasses raised by the protected operation (notably
            # PermissionError) retain their public API meaning.
            raise
        raise PluginLockError(
            f"plugin state process lock failed: {type(exc).__name__}"
        ) from exc
    finally:
        if acquired and fd is not None:
            try:
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                elif msvcrt is not None:  # pragma: no cover - Windows only.
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        if fd is not None:
            os.close(fd)
        if parent_fd is not None:
            os.close(parent_fd)


@dataclass(frozen=True)
class RegistryIssue:
    path: str
    error: str


@dataclass(frozen=True)
class PluginRecord:
    manifest: PluginManifest
    source: str
    enabled: bool
    approved_permissions: tuple[str, ...]
    approved_executables: tuple[tuple[str, str, str], ...]
    locked_digest: str | None
    integrity: PackageVerification

    def public_dict(self) -> dict[str, Any]:
        return {
            **manifest_public_dict(self.manifest),
            "source": self.source,
            "manifestPath": str(self.manifest.manifest_path),
            "enabled": self.enabled,
            "approvedPermissions": list(self.approved_permissions),
            "approvedExecutables": [
                {"contribution": key, "path": path, "sha256": digest}
                for key, path, digest in self.approved_executables
            ],
            "locked": self.locked_digest == self.manifest.digest,
            "lockMismatch": bool(
                self.locked_digest and self.locked_digest != self.manifest.digest
            ),
            "integrity": self.integrity.public_dict(),
        }


@dataclass(frozen=True)
class PluginAuthoritySnapshot:
    """Immutable durable authority expected by one plugin operation."""

    plugin_id: str
    record: PluginRecord | None
    safe_mode: bool
    safe_mode_closed_revision: int
    plugin_disabled_revision: int


def _command_executable_identity(
    command: Iterable[Any],
    *,
    plugin_root: Path,
    contribution: str,
) -> tuple[str, str, str]:
    argv = [str(value) for value in command]
    if not argv:
        raise PluginManifestError(
            f"{contribution} executable command is empty"
        )
    raw = argv[0].replace("${pluginRoot}", str(plugin_root))
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        resolved = shutil.which(raw)
        if not resolved:
            raise PluginManifestError(
                f"{contribution} executable not found: {raw}"
            )
        candidate = Path(resolved)
    executable = candidate.resolve()
    if not executable.is_file():
        raise PluginManifestError(
            f"{contribution} executable is not a file: {executable}"
        )
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    return contribution, str(executable), digest


def plugin_executable_identities(
    manifest: PluginManifest,
) -> tuple[tuple[str, str, str], ...]:
    """Resolve and hash every executable authority approved for this package."""
    identities: list[tuple[str, str, str]] = []
    if manifest.entrypoint is not None:
        identities.append(
            _command_executable_identity(
                manifest.entrypoint.command,
                plugin_root=manifest.plugin_root,
                contribution="entrypoint",
            )
        )
    for runtime in manifest.contributes.get("runtimes", ()):
        # JSON-RPC runtimes execute through the package-level supervised
        # entrypoint above.  They do not own a second command and the manifest
        # parser intentionally rejects a runtime-level ``command`` for this
        # adapter.  Falling back to ``dsh`` here therefore invents executable
        # authority that the plugin never requested and makes otherwise valid
        # JSON-RPC plugins depend on an unrelated host binary.
        adapter = str(runtime.get("adapter") or "")
        if adapter == "jsonrpc-stdio":
            continue
        if adapter != "deepseek-harness-headless":
            raise PluginManifestError(
                f"runtime:{runtime.get('id') or 'unknown'} has unsupported "
                f"adapter for executable approval: {adapter or 'missing'}"
            )
        command = runtime.get("command") or ["dsh"]
        identities.append(
            _command_executable_identity(
                command,
                plugin_root=manifest.plugin_root,
                contribution=f"runtime:{runtime.get('id') or 'unknown'}",
            )
        )
    return tuple(sorted(identities))


class PluginRegistry:
    """Discover manifests without importing or executing plugin code."""

    def __init__(
        self,
        workspace: str | Path,
        *,
        repo_root: str | Path | None = None,
        integrity_policy: PluginIntegrityPolicy | None = None,
        publisher_trust_path: str | Path | None = None,
    ):
        self.workspace = Path(workspace).expanduser().resolve()
        self.repo_root = (
            Path(repo_root).expanduser().resolve()
            if repo_root is not None
            else Path(__file__).resolve().parents[1]
        )
        beta_state = os.environ.get("SOPHIA_PLUGIN_STATE_PATH")
        workspace_key = hashlib.sha256(
            str(self.workspace).encode("utf-8")
        ).hexdigest()[:20]
        self.state_path = (
            Path(beta_state).expanduser().resolve()
            if beta_state
            else (
                user_state_dir()
                / "plugins"
                / "workspaces"
                / workspace_key
                / "state.json"
            ).resolve()
        )
        lock_override = os.environ.get("SOPHIA_PLUGIN_LOCK_PATH")
        self.lock_path = (
            Path(lock_override).expanduser().resolve()
            if lock_override
            else self.state_path.parent / "plugins.lock.json"
        )
        self.integrity_policy = (
            integrity_policy
            if integrity_policy is not None
            else PluginIntegrityPolicy.from_environment()
        )
        trust_override = os.environ.get("SOPHIA_PLUGIN_PUBLISHER_TRUST_PATH")
        self.publisher_trust_path = (
            Path(publisher_trust_path).expanduser().absolute()
            if publisher_trust_path is not None
            else (
                Path(trust_override).expanduser().absolute()
                if trust_override
                else (user_state_dir() / "plugins" / "publishers.json").absolute()
            )
        )
        authority_lock_override = os.environ.get(
            "SOPHIA_PLUGIN_AUTHORITY_LOCK_PATH"
        )
        self.authority_lock_path = _absolute_without_resolving(
            authority_lock_override
            if authority_lock_override
            else self.state_path.with_name(
                f".{self.state_path.name}.authority.lock"
            )
        )
        self._validate_authority_lock_path()
        self._authority_thread_lock = _shared_authority_thread_lock(
            self.authority_lock_path
        )
        self._authority_lock_key = str(self.authority_lock_path)
        self._records: dict[str, PluginRecord] = {}
        self._issues: list[RegistryIssue] = []
        self._state_issues: list[RegistryIssue] = []
        self._state = self._fresh_state()
        self._loaded_state_fingerprint = _state_fingerprint(self._state)
        self.refresh()

    @property
    def records(self) -> dict[str, PluginRecord]:
        return dict(self._records)

    @property
    def issues(self) -> tuple[RegistryIssue, ...]:
        return tuple(self._issues)

    @property
    def state(self) -> dict[str, Any]:
        return json.loads(json.dumps(self._state))

    def _fresh_state(self) -> dict[str, Any]:
        return {
            "schema": STATE_SCHEMA,
            "workspace": str(self.workspace),
            "enabled": {},
            "approvedPermissions": {},
            "approvedExecutables": {},
            "safeMode": True,
            "authorityRevisions": {
                "safeModeClosed": 0,
                "pluginsDisabled": {},
            },
            "selections": {
                "profile": None,
                "workflow": None,
                "skill": None,
                "compatSkill": None,
                "agent": None,
                "runtime": None,
            },
            "updatedAt": None,
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _validate_authority_lock_path(self) -> None:
        """Reject a coordination leaf that aliases persisted JSON authority."""
        authority_key = os.path.normpath(
            str(self.authority_lock_path)
        ).casefold()
        for protected in (
            self.state_path,
            self.lock_path,
            self.publisher_trust_path,
        ):
            protected_key = os.path.normpath(str(protected)).casefold()
            if authority_key == protected_key:
                raise PluginLockError(
                    "plugin state process lock must be distinct from state, "
                    "operational lock, and publisher trust paths"
                )
            try:
                authority_metadata = self.authority_lock_path.stat()
                protected_metadata = protected.stat()
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise PluginLockError(
                    "plugin state process lock collision could not be checked"
                ) from exc
            if (
                authority_metadata.st_dev,
                authority_metadata.st_ino,
            ) == (
                protected_metadata.st_dev,
                protected_metadata.st_ino,
            ):
                raise PluginLockError(
                    "plugin state process lock must not alias state, "
                    "operational lock, or publisher trust files"
                )

    def _load_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return self._fresh_state()
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            self._state_issues.append(
                RegistryIssue(
                    path=str(self.state_path),
                    error=(
                        "plugin state could not be read; safe-mode defaults "
                        f"were restored in memory: {type(exc).__name__}"
                    ),
                )
            )
            return self._fresh_state()
        if not isinstance(raw, dict) or raw.get("schema") != STATE_SCHEMA:
            self._state_issues.append(
                RegistryIssue(
                    path=str(self.state_path),
                    error=(
                        "plugin state schema is invalid; safe-mode defaults "
                        "were restored in memory"
                    ),
                )
            )
            return self._fresh_state()
        stored_workspace = raw.get("workspace")
        if (
            isinstance(stored_workspace, str)
            and Path(stored_workspace).expanduser().resolve() != self.workspace
        ):
            self._state_issues.append(
                RegistryIssue(
                    path=str(self.state_path),
                    error=(
                        "plugin state belongs to a different workspace; "
                        "safe-mode defaults were restored in memory"
                    ),
                )
            )
            return self._fresh_state()
        state = self._fresh_state()
        if isinstance(raw.get("enabled"), dict):
            state["enabled"] = {
                str(key): str(value)
                for key, value in raw["enabled"].items()
                if isinstance(key, str) and isinstance(value, str)
            }
        if isinstance(raw.get("approvedPermissions"), dict):
            state["approvedPermissions"] = {
                str(key): [str(item) for item in value if isinstance(item, str)]
                for key, value in raw["approvedPermissions"].items()
                if isinstance(key, str) and isinstance(value, list)
            }
        if isinstance(raw.get("approvedExecutables"), dict):
            state["approvedExecutables"] = {
                str(key): [
                    {
                        "contribution": str(item.get("contribution") or ""),
                        "path": str(item.get("path") or ""),
                        "sha256": str(item.get("sha256") or ""),
                    }
                    for item in value
                    if isinstance(item, dict)
                    and item.get("contribution")
                    and item.get("path")
                    and item.get("sha256")
                ]
                for key, value in raw["approvedExecutables"].items()
                if isinstance(key, str) and isinstance(value, list)
            }
        raw_safe_mode = raw.get("safeMode", True)
        # Persisted plugin state is an authority boundary. Only the exact JSON
        # boolean ``false`` may disable safe mode; null, 0, strings, arrays, and
        # other malformed values fail closed instead of inheriting Python's
        # permissive truthiness rules.
        state["safeMode"] = (
            raw_safe_mode
            if isinstance(raw_safe_mode, bool)
            else True
        )
        if not isinstance(raw_safe_mode, bool):
            self._state_issues.append(
                RegistryIssue(
                    path=str(self.state_path),
                    error=(
                        "plugin state safeMode must be a boolean; "
                        "safe mode was restored"
                    ),
                )
            )
        raw_authority_revisions = raw.get("authorityRevisions")
        if raw_authority_revisions is not None:
            valid_revisions = isinstance(raw_authority_revisions, dict)
            safe_mode_closed = (
                raw_authority_revisions.get("safeModeClosed")
                if valid_revisions
                else None
            )
            plugins_disabled = (
                raw_authority_revisions.get("pluginsDisabled")
                if valid_revisions
                else None
            )
            valid_revisions = bool(
                valid_revisions
                and isinstance(safe_mode_closed, int)
                and not isinstance(safe_mode_closed, bool)
                and safe_mode_closed >= 0
                and isinstance(plugins_disabled, dict)
                and all(
                    isinstance(key, str)
                    and isinstance(value, int)
                    and not isinstance(value, bool)
                    and value >= 0
                    for key, value in plugins_disabled.items()
                )
            )
            if valid_revisions:
                state["authorityRevisions"] = {
                    "safeModeClosed": safe_mode_closed,
                    "pluginsDisabled": dict(plugins_disabled),
                }
            else:
                # Revocation counters close disable/re-enable and
                # safe-on/safe-off ABA windows. Malformed counters cannot be
                # ignored while leaving executable authority open.
                state["safeMode"] = True
                self._state_issues.append(
                    RegistryIssue(
                        path=str(self.state_path),
                        error=(
                            "plugin state authorityRevisions are invalid; "
                            "safe mode was restored"
                        ),
                    )
                )
        else:
            # A state written before revocation counters existed cannot prove
            # that an idempotent safe-mode/disable closure did not occur.  It
            # remains readable for inspection, but executable authority stays
            # closed until an explicit state mutation (normally
            # ``set_safe_mode``) rewrites it with counters.
            state["safeMode"] = True
            self._state_issues.append(
                RegistryIssue(
                    path=str(self.state_path),
                    error=(
                        "plugin state authorityRevisions are missing; "
                        "safe mode was restored pending explicit migration"
                    ),
                )
            )
        if isinstance(raw.get("selections"), dict):
            for key in (
                "profile",
                "workflow",
                "skill",
                "compatSkill",
                "agent",
                "runtime",
            ):
                value = raw["selections"].get(key)
                state["selections"][key] = value if isinstance(value, str) else None
        state["updatedAt"] = raw.get("updatedAt")
        return state

    @contextmanager
    def authority_transaction(self) -> Iterator[None]:
        """Serialize persisted authority reads and writes across processes."""
        with self._authority_thread_lock:
            depths = getattr(
                _AUTHORITY_TRANSACTION_DEPTHS,
                "paths",
                None,
            )
            if depths is None:
                depths = {}
                _AUTHORITY_TRANSACTION_DEPTHS.paths = depths
            depth = depths.get(self._authority_lock_key, 0)
            if depth:
                depths[self._authority_lock_key] = depth + 1
                try:
                    yield
                finally:
                    depths[self._authority_lock_key] -= 1
                return
            with _authority_process_lock(
                self.authority_lock_path,
                protected_paths=(
                    self.state_path,
                    self.lock_path,
                    self.publisher_trust_path,
                ),
            ):
                depths[self._authority_lock_key] = 1
                try:
                    yield
                finally:
                    depths.pop(self._authority_lock_key, None)

    def _reload_state_unlocked(self) -> None:
        # Issues describe exactly the durable snapshot loaded for this refresh;
        # retaining an earlier parse failure after a repair is misleading, and
        # retaining an earlier permissive snapshot after a new failure is unsafe.
        self._state_issues = []
        self._state = self._load_state()
        self._loaded_state_fingerprint = _state_fingerprint(self._state)

    def _safe_mode_closed_revision_unlocked(self) -> int:
        return int(
            self._state["authorityRevisions"]["safeModeClosed"]
        )

    def _plugin_disabled_revision_unlocked(self, plugin_id: str) -> int:
        return int(
            self._state["authorityRevisions"]["pluginsDisabled"].get(
                plugin_id,
                0,
            )
        )

    def _bump_safe_mode_closed_revision_unlocked(self) -> None:
        revisions = self._state["authorityRevisions"]
        revisions["safeModeClosed"] = int(revisions["safeModeClosed"]) + 1

    def _bump_plugin_disabled_revision_unlocked(
        self,
        plugin_id: str,
    ) -> None:
        disabled = self._state["authorityRevisions"]["pluginsDisabled"]
        disabled[plugin_id] = int(disabled.get(plugin_id, 0)) + 1

    def authority_snapshot(self, plugin_id: str) -> PluginAuthoritySnapshot:
        """Return the authority represented by the current stable cache."""
        normalized = str(plugin_id).strip()
        return PluginAuthoritySnapshot(
            plugin_id=normalized,
            record=self.get(normalized),
            safe_mode=self.safe_mode(),
            safe_mode_closed_revision=(
                self._safe_mode_closed_revision_unlocked()
            ),
            plugin_disabled_revision=(
                self._plugin_disabled_revision_unlocked(normalized)
            ),
        )

    def authority_snapshots(self) -> dict[str, PluginAuthoritySnapshot]:
        """Return cached per-plugin authority after a stable refresh."""
        return {
            plugin_id: self.authority_snapshot(plugin_id)
            for plugin_id in self._records
        }

    def safe_mode_authority(self) -> tuple[bool, int]:
        """Return effective safe mode and its monotonic closure revision."""
        return (
            self.safe_mode(),
            self._safe_mode_closed_revision_unlocked(),
        )

    def state_authority_valid(self) -> bool:
        """Whether the current durable state parsed without authority loss."""
        return not self._state_issues

    def _save_state_unlocked(self) -> None:
        self._state["updatedAt"] = _now_iso()
        _write_json_atomic(self.state_path, self._state)
        self._state_issues = []
        self._loaded_state_fingerprint = _state_fingerprint(self._state)
        self._write_lockfile_unlocked()

    def save_state(self) -> None:
        """Save a direct in-memory edit only if its durable base is unchanged.

        Authority mutations use the named methods below, which reload and
        merge from the latest durable state. This compatibility path is a
        fail-closed compare-and-swap so a stale registry cannot replace a
        newer disable, safe-mode, approval, or selection snapshot wholesale.
        """
        desired = json.loads(json.dumps(self._state))
        expected_fingerprint = self._loaded_state_fingerprint
        with self.authority_transaction():
            self._reload_state_unlocked()
            if (
                self._state_issues
                or self._loaded_state_fingerprint != expected_fingerprint
            ):
                raise PluginLockError(
                    "plugin state changed or became invalid since it was loaded; "
                    "refresh and retry the specific authority mutation"
                )
            current = json.loads(json.dumps(self._state))
            desired["authorityRevisions"] = json.loads(
                json.dumps(current["authorityRevisions"])
            )
            if (
                current.get("safeMode") is False
                and desired.get("safeMode") is True
            ):
                self._state = desired
                self._bump_safe_mode_closed_revision_unlocked()
                desired = json.loads(json.dumps(self._state))
            authority_fields = (
                "enabled",
                "approvedPermissions",
                "approvedExecutables",
            )
            plugin_ids = {
                str(plugin_id)
                for field in authority_fields
                for plugin_id in {
                    *current.get(field, {}),
                    *desired.get(field, {}),
                }
            }
            self._state = desired
            for plugin_id in plugin_ids:
                if any(
                    current.get(field, {}).get(plugin_id)
                    != desired.get(field, {}).get(plugin_id)
                    for field in authority_fields
                ):
                    self._bump_plugin_disabled_revision_unlocked(plugin_id)
            desired = json.loads(json.dumps(self._state))
            self._state = desired
            self._save_state_unlocked()
            self._refresh_unlocked()

    def discovery_roots(self) -> tuple[tuple[str, Path], ...]:
        user_root = Path(
            os.environ.get("SOPHIA_PLUGIN_HOME") or Path.home() / ".sophia" / "plugins"
        ).expanduser()
        return (
            ("bundled", self.repo_root / "plugins"),
            ("user", user_root),
            ("workspace", self.workspace / ".sophia" / "plugins"),
        )

    @staticmethod
    def _within(path: Path, root: Path) -> bool:
        try:
            path.relative_to(root)
        except ValueError:
            return False
        return True

    def _manifest_paths(
        self,
        root: Path,
        issues: list[RegistryIssue],
    ) -> Iterable[tuple[Path, Path]]:
        try:
            resolved_root = root.resolve(strict=True)
        except FileNotFoundError:
            return ()
        except OSError as exc:
            issues.append(
                RegistryIssue(
                    path=str(root),
                    error=(
                        "plugin discovery root could not be resolved: "
                        f"{type(exc).__name__}"
                    ),
                )
            )
            return ()
        if not resolved_root.is_dir():
            return ()
        try:
            with os.scandir(root) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name)
        except OSError as exc:
            issues.append(
                RegistryIssue(
                    path=str(root),
                    error=(
                        "plugin discovery root could not be enumerated: "
                        f"{type(exc).__name__}"
                    ),
                )
            )
            return ()

        manifests: list[tuple[Path, Path]] = []
        for entry in entries:
            package_root = Path(entry.path)
            try:
                package_stat = entry.stat(follow_symlinks=False)
            except OSError as exc:
                issues.append(
                    RegistryIssue(
                        path=str(package_root),
                        error=(
                            "plugin package root could not be inspected: "
                            f"{type(exc).__name__}"
                        ),
                    )
                )
                continue
            if stat.S_ISLNK(package_stat.st_mode):
                issues.append(
                    RegistryIssue(
                        path=str(package_root),
                        error=(
                            "plugin package directory symlinks are not "
                            "allowed during discovery"
                        ),
                    )
                )
                continue
            if not stat.S_ISDIR(package_stat.st_mode):
                continue

            manifest_path = package_root / MANIFEST_FILENAME
            try:
                manifest_stat = manifest_path.lstat()
            except FileNotFoundError:
                continue
            except OSError as exc:
                issues.append(
                    RegistryIssue(
                        path=str(manifest_path),
                        error=(
                            "plugin manifest could not be inspected: "
                            f"{type(exc).__name__}"
                        ),
                    )
                )
                continue
            if stat.S_ISLNK(manifest_stat.st_mode):
                issues.append(
                    RegistryIssue(
                        path=str(manifest_path),
                        error=(
                            "plugin manifest symlinks are not allowed during "
                            "discovery"
                        ),
                    )
                )
                continue
            if not stat.S_ISREG(manifest_stat.st_mode):
                issues.append(
                    RegistryIssue(
                        path=str(manifest_path),
                        error="plugin manifest is not a regular file",
                    )
                )
                continue

            try:
                resolved_package = package_root.resolve(strict=True)
                resolved_manifest = manifest_path.resolve(strict=True)
            except OSError as exc:
                issues.append(
                    RegistryIssue(
                        path=str(manifest_path),
                        error=(
                            "plugin package could not be resolved safely: "
                            f"{type(exc).__name__}"
                        ),
                    )
                )
                continue
            if (
                not self._within(resolved_package, resolved_root)
                or not self._within(resolved_manifest, resolved_package)
                or not self._within(resolved_manifest, resolved_root)
            ):
                issues.append(
                    RegistryIssue(
                        path=str(manifest_path),
                        error=(
                            "plugin package escaped its resolved discovery "
                            "root"
                        ),
                    )
                )
                continue
            manifests.append((manifest_path, resolved_root))
        return tuple(manifests)

    def _load_locked_digests(
        self,
        issues: list[RegistryIssue],
    ) -> dict[str, str]:
        if not self.lock_path.exists():
            return {}
        try:
            raw = json.loads(self.lock_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            issues.append(
                RegistryIssue(
                    path=str(self.lock_path),
                    error=(
                        "plugin lockfile could not be read: "
                        f"{type(exc).__name__}"
                    ),
                )
            )
            return {}
        if not isinstance(raw, dict) or raw.get("schema") != LOCK_SCHEMA:
            issues.append(
                RegistryIssue(
                    path=str(self.lock_path),
                    error="plugin lockfile schema is invalid",
                )
            )
            return {}
        lock_workspace = raw.get("workspace")
        if (
            isinstance(lock_workspace, str)
            and Path(lock_workspace).expanduser().resolve() != self.workspace
        ):
            issues.append(
                RegistryIssue(
                    path=str(self.lock_path),
                    error="plugin lockfile belongs to a different workspace",
                )
            )
            return {}
        plugins = raw.get("plugins")
        if not isinstance(plugins, list):
            issues.append(
                RegistryIssue(
                    path=str(self.lock_path),
                    error="plugin lockfile plugins field is invalid",
                )
            )
            return {}
        return {
            str(item.get("id")): str(item.get("digest"))
            for item in plugins
            if isinstance(item, dict) and item.get("id") and item.get("digest")
        }

    def _refresh_unlocked(self) -> None:
        issues: list[RegistryIssue] = list(self._state_issues)
        discovered: dict[str, tuple[PluginManifest, str]] = {}
        integrity_by_id: dict[str, PackageVerification] = {}
        conflicts: set[str] = set()
        for source, root in self.discovery_roots():
            for path, resolved_root in self._manifest_paths(root, issues):
                try:
                    # Re-check immediately around parsing so replacement
                    # during discovery is surfaced instead of accepted.
                    package_stat = path.parent.lstat()
                    manifest_stat = path.lstat()
                    if stat.S_ISLNK(package_stat.st_mode):
                        raise PluginManifestError(
                            "plugin package directory symlinks are not allowed "
                            "during discovery"
                        )
                    if stat.S_ISLNK(manifest_stat.st_mode):
                        raise PluginManifestError(
                            "plugin manifest symlinks are not allowed during "
                            "discovery"
                        )
                    manifest = load_manifest(path)
                    package_stat = path.parent.lstat()
                    manifest_stat = path.lstat()
                    if stat.S_ISLNK(package_stat.st_mode):
                        raise PluginManifestError(
                            "plugin package directory symlinks are not allowed "
                            "during discovery"
                        )
                    if stat.S_ISLNK(manifest_stat.st_mode):
                        raise PluginManifestError(
                            "plugin manifest symlinks are not allowed during "
                            "discovery"
                        )
                    resolved_package = path.parent.resolve(strict=True)
                    resolved_manifest = path.resolve(strict=True)
                    if (
                        manifest.plugin_root != resolved_package
                        or manifest.manifest_path != resolved_manifest
                        or not self._within(
                            manifest.plugin_root,
                            resolved_root,
                        )
                        or not self._within(
                            manifest.manifest_path,
                            resolved_root,
                        )
                    ):
                        raise PluginManifestError(
                            "plugin package escaped its resolved discovery root"
                        )
                    validate_permissions(
                        manifest.permissions,
                        executable=manifest.executable,
                        trust_tier=manifest.trust_tier,
                        sandbox=(
                            manifest.entrypoint.sandbox
                            if manifest.entrypoint is not None
                            else None
                        ),
                    )
                    compatibility_error = self._compatibility_error(manifest)
                    if compatibility_error:
                        raise PluginManifestError(compatibility_error)
                    if manifest.trust_tier == 1 and source != "bundled":
                        raise PluginManifestError(
                            "trustTier 1 is reserved for plugins bundled with Sophia"
                        )
                    integrity = verify_package_source(
                        manifest.plugin_root,
                        source_kind=source,
                        policy=self.integrity_policy,
                        trust_store_path=self.publisher_trust_path,
                        expected_package_id=manifest.plugin_id,
                        expected_version=manifest.version,
                        expected_publisher=manifest.publisher,
                    )
                except OSError as exc:
                    issues.append(
                        RegistryIssue(
                            path=str(path),
                            error=(
                                "plugin package changed or became unreadable "
                                f"during discovery: {type(exc).__name__}"
                            ),
                        )
                    )
                    continue
                except (
                    PluginIntegrityError,
                    PluginManifestError,
                    PluginPolicyError,
                ) as exc:
                    issues.append(RegistryIssue(path=str(path), error=str(exc)))
                    continue
                if manifest.plugin_id in discovered:
                    prior, _ = discovered[manifest.plugin_id]
                    conflicts.add(manifest.plugin_id)
                    issues.append(
                        RegistryIssue(
                            path=str(path),
                            error=(
                                f"duplicate plugin id {manifest.plugin_id}; "
                                f"also declared at {prior.manifest_path}"
                            ),
                        )
                    )
                    continue
                discovered[manifest.plugin_id] = (manifest, source)
                integrity_by_id[manifest.plugin_id] = integrity
        for plugin_id in conflicts:
            discovered.pop(plugin_id, None)
            integrity_by_id.pop(plugin_id, None)
        enabled = self._state.get("enabled", {})
        approved = self._state.get("approvedPermissions", {})
        approved_executables = self._state.get("approvedExecutables", {})
        locked = self._load_locked_digests(issues)
        records: dict[str, PluginRecord] = {}
        for plugin_id, (manifest, source) in discovered.items():
            approved_permissions = tuple(
                item
                for item in approved.get(plugin_id, [])
                if isinstance(item, str)
            )
            is_enabled = enabled.get(plugin_id) == manifest.digest
            executable_approvals = tuple(
                sorted(
                    (
                        str(item.get("contribution") or ""),
                        str(item.get("path") or ""),
                        str(item.get("sha256") or ""),
                    )
                    for item in approved_executables.get(plugin_id, [])
                    if isinstance(item, dict)
                )
            )
            if enabled.get(plugin_id) and not is_enabled:
                issues.append(
                    RegistryIssue(
                        path=str(manifest.manifest_path),
                        error=(
                            f"enabled digest for {plugin_id} changed; "
                            "plugin is disabled until explicitly re-enabled"
                        ),
                    )
                )
            records[plugin_id] = PluginRecord(
                manifest=manifest,
                source=source,
                enabled=is_enabled,
                approved_permissions=approved_permissions,
                approved_executables=executable_approvals,
                locked_digest=locked.get(plugin_id),
                integrity=integrity_by_id[plugin_id],
            )
        self._records = records
        invalid_enabled_plugins = {
            str(plugin_id)
            for plugin_id in enabled
            if (
                plugin_id not in records
                or not records[plugin_id].enabled
                or not records[plugin_id].integrity.allowed
                or records[plugin_id].locked_digest
                != records[plugin_id].manifest.digest
            )
        }
        if invalid_enabled_plugins and not self._state_issues:
            # Discovery is itself an authority observation. Once any process
            # sees an enabled package absent, digest-drifted, or trust-invalid,
            # persist that revocation under A so byte-for-byte restoration
            # cannot resurrect an older cached approval without re-enable.
            for plugin_id in sorted(invalid_enabled_plugins):
                self._bump_plugin_disabled_revision_unlocked(plugin_id)
                self._state["enabled"].pop(plugin_id, None)
                self._state["approvedPermissions"].pop(plugin_id, None)
                self._state["approvedExecutables"].pop(plugin_id, None)
                for key, value in list(
                    self._state["selections"].items()
                ):
                    if isinstance(value, str) and (
                        value == plugin_id
                        or value.startswith(plugin_id + "/")
                    ):
                        self._state["selections"][key] = None
            observed_issues = list(issues)
            self._save_state_unlocked()
            # Return a cache derived from the persisted revoked state, not the
            # pre-revocation discovery snapshot (whose record may still say
            # enabled when trust or the portable lock failed).
            self._refresh_unlocked()
            self._issues = [
                *observed_issues,
                *(
                    issue
                    for issue in self._issues
                    if issue not in observed_issues
                ),
            ]
            return
        self._issues = issues

    def refresh(self) -> None:
        """Reload one stable durable authority snapshot before discovery."""
        with self.authority_transaction():
            self._reload_state_unlocked()
            self._refresh_unlocked()

    @staticmethod
    def _compatibility_error(manifest: PluginManifest) -> str | None:
        platforms = {
            str(value).strip().casefold()
            for value in manifest.compatibility.get("platforms", [])
            if str(value).strip()
        }
        if platforms and sys.platform.casefold() not in platforms:
            return (
                f"plugin does not support platform {sys.platform}; "
                f"declared: {', '.join(sorted(platforms))}"
            )
        architectures = {
            str(value).strip().casefold()
            for value in manifest.compatibility.get("architectures", [])
            if str(value).strip()
        }
        machine = platform.machine().strip().casefold()
        machine_aliases = {machine}
        if machine in {"arm64", "aarch64"}:
            machine_aliases.update({"arm64", "aarch64"})
        elif machine in {"x86_64", "amd64"}:
            machine_aliases.update({"x86_64", "amd64"})
        if architectures and not (architectures & machine_aliases):
            return (
                f"plugin does not support architecture {machine or 'unknown'}; "
                f"declared: {', '.join(sorted(architectures))}"
            )
        return None

    def get(self, plugin_id: str) -> PluginRecord | None:
        return self._records.get(str(plugin_id).strip())

    def require(self, plugin_id: str) -> PluginRecord:
        record = self.get(plugin_id)
        if record is None:
            raise KeyError(f"plugin not found: {plugin_id}")
        return record

    def enable(
        self,
        plugin_id: str,
        *,
        approve_permissions: bool = False,
    ) -> PluginRecord:
        with self.authority_transaction():
            self._reload_state_unlocked()
            self._refresh_unlocked()
            record = self.require(plugin_id)
            manifest = record.manifest
            current_digest = plugin_package_digest(manifest.plugin_root)
            if current_digest != manifest.digest:
                self._refresh_unlocked()
                raise PermissionError(
                    "plugin package changed during approval; inspect and "
                    "enable it again"
                )
            try:
                integrity = verify_package_source(
                    manifest.plugin_root,
                    source_kind=record.source,
                    policy=self.integrity_policy,
                    trust_store_path=self.publisher_trust_path,
                    expected_package_id=manifest.plugin_id,
                    expected_version=manifest.version,
                    expected_publisher=manifest.publisher,
                )
            except PluginIntegrityError as exc:
                self._refresh_unlocked()
                raise PermissionError(
                    "plugin publisher/package verification failed: "
                    f"{exc}"
                ) from exc
            if integrity != record.integrity:
                self._refresh_unlocked()
                raise PermissionError(
                    "plugin integrity authority changed during approval; "
                    "inspect it again"
                )
            needed = validate_permissions(
                manifest.permissions,
                executable=manifest.executable,
                trust_tier=manifest.trust_tier,
                sandbox=(
                    manifest.entrypoint.sandbox
                    if manifest.entrypoint is not None
                    else None
                ),
            )
            from agent.plugin_policy import permissions_need_approval

            if permissions_need_approval(needed) and not approve_permissions:
                raise PermissionError(
                    "executable plugin permissions require explicit --approve: "
                    + ", ".join(needed)
                )
            self._state["enabled"][plugin_id] = manifest.digest
            self._state["approvedPermissions"][plugin_id] = list(needed)
            self._state["approvedExecutables"][plugin_id] = [
                {"contribution": key, "path": path, "sha256": digest}
                for key, path, digest in plugin_executable_identities(manifest)
            ]
            # Every explicit approval/open command advances the same
            # per-plugin mutation generation used by disable. This closes
            # enable/disable and package/trust restore ABA windows for all
            # registry-governed writers.
            self._bump_plugin_disabled_revision_unlocked(plugin_id)
            self._save_state_unlocked()
            self._refresh_unlocked()
            return self.require(plugin_id)

    def disable(self, plugin_id: str) -> PluginRecord:
        with self.authority_transaction():
            self._reload_state_unlocked()
            self._refresh_unlocked()
            record = self.require(plugin_id)
            # A disable is an explicit revocation even when durable
            # enablement is already absent. Keep the counter monotonic so a
            # disable/re-enable ABA cannot authorize older output.
            self._bump_plugin_disabled_revision_unlocked(plugin_id)
            self._state["enabled"].pop(plugin_id, None)
            self._state["approvedPermissions"].pop(plugin_id, None)
            self._state["approvedExecutables"].pop(plugin_id, None)
            selections = self._state["selections"]
            for key, value in list(selections.items()):
                if isinstance(value, str) and (
                    value == plugin_id or value.startswith(plugin_id + "/")
                ):
                    selections[key] = None
            self._save_state_unlocked()
            self._refresh_unlocked()
            return record

    def set_safe_mode(self, enabled: bool) -> None:
        with self.authority_transaction():
            self._reload_state_unlocked()
            self._refresh_unlocked()
            if bool(enabled):
                self._bump_safe_mode_closed_revision_unlocked()
            self._state["safeMode"] = bool(enabled)
            self._save_state_unlocked()
            self._refresh_unlocked()

    def safe_mode(self) -> bool:
        env = os.environ.get("SOPHIA_PLUGIN_SAFE_MODE")
        if env is not None:
            normalized = env.strip().casefold()
            if normalized in {"1", "true", "on", "yes"}:
                return True
            if normalized in {"0", "false", "off", "no"}:
                # The environment may force the executable boundary closed,
                # but it cannot silently reopen a workspace whose persisted
                # safe mode is still on. Use the explicit host command to
                # disable safe mode so the state change is durable and visible.
                return bool(self._state.get("safeMode"))
            # Empty or malformed environment overrides fail closed.
            return True
        return bool(self._state.get("safeMode"))

    def set_selection(
        self,
        kind: str,
        reference: str | None,
        *,
        expected_authority: PluginAuthoritySnapshot | None = None,
    ) -> PluginAuthoritySnapshot | None:
        return self.set_selections(
            {kind: reference},
            expected_authority=expected_authority,
        )

    def set_selections(
        self,
        updates: dict[str, str | None],
        *,
        expected_authority: PluginAuthoritySnapshot | None = None,
    ) -> PluginAuthoritySnapshot | None:
        """Conditionally apply a selection group in one authority write."""
        allowed = {
            "profile",
            "workflow",
            "skill",
            "compatSkill",
            "agent",
            "runtime",
        }
        unknown = sorted(set(updates) - allowed)
        if unknown:
            raise ValueError(
                "unsupported plugin selection(s): " + ", ".join(unknown)
            )
        with self.authority_transaction():
            self._reload_state_unlocked()
            self._refresh_unlocked()
            if (
                expected_authority is not None
                and self.authority_snapshot(
                    expected_authority.plugin_id
                )
                != expected_authority
            ):
                raise PermissionError(
                    "plugin selection authority changed before the durable "
                    "selection mutation"
                )
            selections = dict(self._state["selections"])
            for kind, reference in updates.items():
                if reference is not None and not isinstance(reference, str):
                    raise ValueError(
                        f"plugin selection {kind} must be a string or null"
                    )
                selections[kind] = reference
            self._state["selections"] = selections
            self._save_state_unlocked()
            self._refresh_unlocked()
            if expected_authority is None:
                return None
            return self.authority_snapshot(expected_authority.plugin_id)

    def selection(self, kind: str) -> str | None:
        if kind not in {
            "profile",
            "workflow",
            "skill",
            "compatSkill",
            "agent",
            "runtime",
        }:
            raise ValueError(f"unsupported plugin selection {kind}")
        value = self._state.get("selections", {}).get(kind)
        return value if isinstance(value, str) and value else None

    def _write_lockfile_unlocked(self) -> None:
        plugins = []
        for plugin_id in sorted(self._records):
            record = self._records[plugin_id]
            plugins.append(
                {
                    "id": plugin_id,
                    "version": record.manifest.version,
                    "digest": record.manifest.digest,
                    "source": record.source,
                    "enabled": self._state.get("enabled", {}).get(plugin_id)
                    == record.manifest.digest,
                    "approvedPermissions": list(
                        self._state.get("approvedPermissions", {}).get(plugin_id, [])
                    ),
                    "approvedExecutables": list(
                        self._state.get("approvedExecutables", {}).get(plugin_id, [])
                    ),
                    "publisher": record.manifest.publisher,
                    "integrity": record.integrity.lock_dict(),
                }
            )
        _write_json_atomic(
            self.lock_path,
            {
                "schema": LOCK_SCHEMA,
                "generatedAt": _now_iso(),
                "workspace": str(self.workspace),
                "plugins": plugins,
                "candidateOnly": True,
                "canClaimAGI": False,
            },
        )

    def write_lockfile(self) -> None:
        with self.authority_transaction():
            self._reload_state_unlocked()
            self._refresh_unlocked()
            self._write_lockfile_unlocked()

    def portable_lock_payload(self) -> dict[str, Any]:
        """Return a deterministic, authority-free lock for explicit export."""
        plugins = []
        for plugin_id in sorted(self._records):
            record = self._records[plugin_id]
            plugins.append(
                {
                    "id": plugin_id,
                    "version": record.manifest.version,
                    "canonicalArchiveDigest": (
                        record.integrity.canonical_archive_digest
                    ),
                    "source": record.source,
                    "publisher": record.manifest.publisher,
                    "integrity": record.integrity.lock_dict(),
                }
            )
        return {
            "schema": PORTABLE_LOCK_SCHEMA,
            "plugins": plugins,
            "importsAuthority": False,
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def export_lockfile(self, path: str | Path) -> dict[str, Any]:
        """Export stable package identities without enablement or approvals."""
        self.refresh()
        payload = self.portable_lock_payload()
        target = _absolute_without_resolving(path)
        _write_json_atomic(
            target,
            payload,
            require_descriptor_no_follow=True,
        )
        return {
            "path": str(target),
            "pluginCount": len(payload["plugins"]),
            "importsAuthority": False,
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def import_lockfile(self, path: str | Path) -> dict[str, Any]:
        """Validate a portable lock against discovery without importing authority."""
        source = _absolute_without_resolving(path)

        def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            output: dict[str, Any] = {}
            for key, value in pairs:
                if key in output:
                    raise PluginLockError(
                        f"portable plugin lock contains duplicate key {key!r}"
                    )
                output[key] = value
            return output

        try:
            encoded = _read_bounded_regular_file(
                source,
                maximum=MAX_PORTABLE_LOCK_BYTES,
                require_descriptor_no_follow=True,
            )
            raw = json.loads(
                encoded.decode("utf-8"),
                object_pairs_hook=unique_object,
            )
        except PluginLockError:
            raise
        except (
            OSError,
            UnicodeDecodeError,
            json.JSONDecodeError,
            RecursionError,
        ) as exc:
            raise PluginLockError(
                f"portable plugin lock could not be read: {type(exc).__name__}"
            ) from exc
        if not isinstance(raw, dict) or set(raw) != {
            "schema",
            "plugins",
            "importsAuthority",
            "candidateOnly",
            "canClaimAGI",
        }:
            raise PluginLockError("portable plugin lock fields are invalid")
        if (
            raw.get("schema") != PORTABLE_LOCK_SCHEMA
            or raw.get("importsAuthority") is not False
            or raw.get("candidateOnly") is not True
            or raw.get("canClaimAGI") is not False
            or not isinstance(raw.get("plugins"), list)
        ):
            raise PluginLockError("portable plugin lock schema/invariants are invalid")
        seen: set[str] = set()
        prior_id = ""
        for item in raw["plugins"]:
            if not isinstance(item, dict) or set(item) != {
                "id",
                "version",
                "canonicalArchiveDigest",
                "source",
                "publisher",
                "integrity",
            }:
                raise PluginLockError("portable plugin lock entry fields are invalid")
            plugin_id = item.get("id")
            if (
                not isinstance(plugin_id, str)
                or not plugin_id
                or plugin_id in seen
                or plugin_id < prior_id
                or not isinstance(item.get("integrity"), dict)
            ):
                raise PluginLockError(
                    "portable plugin lock ids must be unique and sorted"
                )
            seen.add(plugin_id)
            prior_id = plugin_id
        self.refresh()
        expected = self.portable_lock_payload()
        if raw != expected:
            imported = {
                str(item.get("id")): item
                for item in raw["plugins"]
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            current = {
                str(item.get("id")): item
                for item in expected["plugins"]
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            missing = sorted(set(imported) - set(current))
            unexpected = sorted(set(current) - set(imported))
            changed = sorted(
                plugin_id
                for plugin_id in set(imported) & set(current)
                if imported[plugin_id] != current[plugin_id]
            )
            details = []
            if missing:
                details.append("missing: " + ", ".join(missing))
            if unexpected:
                details.append("unexpected: " + ", ".join(unexpected))
            if changed:
                details.append("drifted: " + ", ".join(changed))
            raise PluginLockError(
                "portable plugin lock does not match discovered packages"
                + (f" ({'; '.join(details)})" if details else "")
            )
        return {
            "path": str(source),
            "matched": True,
            "pluginCount": len(raw["plugins"]),
            "authorityImported": False,
            "candidateOnly": True,
            "canClaimAGI": False,
        }
