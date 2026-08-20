# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Plugin publisher trust and detached package-signature verification.

Packages remain untrusted data until all of these independently pass:

* the package payload matches a canonical, deterministic file inventory;
* an Ed25519 detached signature verifies over the canonical manifest bytes;
* the signer key is already present in the operator-owned publisher trust store;
* the publisher, key, and exact package release are not revoked.

The package can declare a publisher and ship a public key, but neither action
adds trust.  Trust is loaded only from the user-owned store supplied by Sophia.
Unsigned local packages remain available solely through the explicit
``PluginIntegrityPolicy.allow_unsigned_local`` compatibility policy.  Remote
packages require signatures by default.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping

PACKAGE_MANIFEST_SCHEMA = "sophia.plugin-package-manifest/v1"
PACKAGE_SIGNATURE_SCHEMA = "sophia.plugin-package-signature/v1"
PUBLISHER_TRUST_SCHEMA = "sophia.plugin-publishers/v1"
CANONICAL_ARCHIVE_SCHEMA = "sophia.plugin-canonical-archive/v1"

PACKAGE_MANIFEST_FILENAME = "sophia-package-manifest.json"
PACKAGE_SIGNATURE_FILENAME = "sophia-package-manifest.sig.json"

MAX_PACKAGE_FILES = 4096
MAX_PACKAGE_BYTES = 67_108_864
MAX_FILE_BYTES = 33_554_432
MAX_INTEGRITY_FILE_BYTES = 1_048_576
MAX_ARCHIVE_HEADERS = 8192
MAX_ARCHIVE_METADATA_BYTES = 8_388_608
MAX_ARCHIVE_EXTENDED_HEADER_BYTES = 1_048_576
MAX_PACKAGE_DEPTH = 64

_SECURE_DIRECTORY_WALK_SUPPORTED = (
    hasattr(os, "O_DIRECTORY")
    and hasattr(os, "O_NOFOLLOW")
    and os.open in os.supports_dir_fd
    and os.stat in os.supports_dir_fd
    and os.scandir in os.supports_fd
)

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
KEY_ID_RE = re.compile(r"^ed25519:[0-9a-f]{64}$")
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9@][A-Za-z0-9@._/-]{0,213}$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:")


class PluginIntegrityError(ValueError):
    """Raised when package identity or signature verification fails closed."""


@dataclass(frozen=True)
class DirectoryMemberSnapshot:
    """One securely opened regular file and its digest-relevant mode."""

    content: bytes
    mode: int


class _BoundedTarInfo(tarfile.TarInfo):
    """Reject archive metadata bombs before ``tarfile`` allocates their body."""

    def _proc_member(self, archive: tarfile.TarFile) -> tarfile.TarInfo:
        count = int(getattr(archive, "_sophia_header_count", 0)) + 1
        if count > MAX_ARCHIVE_HEADERS:
            raise PluginIntegrityError(
                f"archive exceeds the {MAX_ARCHIVE_HEADERS}-header limit"
            )
        setattr(archive, "_sophia_header_count", count)

        metadata_bytes = tarfile.BLOCKSIZE
        extended_types = {
            tarfile.GNUTYPE_LONGNAME,
            tarfile.GNUTYPE_LONGLINK,
            tarfile.XHDTYPE,
            tarfile.XGLTYPE,
            getattr(tarfile, "SOLARIS_XHDTYPE", b"X"),
        }
        if self.type in extended_types:
            if (
                self.size < 0
                or self.size > MAX_ARCHIVE_EXTENDED_HEADER_BYTES
            ):
                raise PluginIntegrityError(
                    "archive extended header exceeds the parser-memory limit"
                )
            metadata_bytes += self._block(self.size)
        total = int(getattr(archive, "_sophia_metadata_bytes", 0)) + metadata_bytes
        if total > MAX_ARCHIVE_METADATA_BYTES:
            raise PluginIntegrityError(
                "archive metadata exceeds the parser-memory limit"
            )
        setattr(archive, "_sophia_metadata_bytes", total)

        pax_types = {
            tarfile.XHDTYPE,
            tarfile.XGLTYPE,
            getattr(tarfile, "SOLARIS_XHDTYPE", b"X"),
        }
        if self.type in pax_types:
            position = archive.fileobj.tell()
            body = archive.fileobj.read(self._block(self.size))
            archive.fileobj.seek(position)
            if b"GNU.sparse." in body:
                raise PluginIntegrityError(
                    "archive contains unsupported sparse metadata"
                )

        # GNU sparse parsing can consume an attacker-selected number of extension
        # blocks before a TarInfo is yielded. Plugin packages do not need sparse
        # members, and the normal member validation rejects them anyway.
        if self.type == tarfile.GNUTYPE_SPARSE:
            raise PluginIntegrityError(
                "archive contains unsupported sparse metadata"
            )
        return super()._proc_member(archive)


def open_bounded_tar_archive(path: str | Path) -> tarfile.TarFile:
    """Open a tar archive with hard parser-memory and raw-header ceilings."""
    return tarfile.open(
        Path(path),
        mode="r:*",
        tarinfo=_BoundedTarInfo,
    )


@dataclass(frozen=True)
class PluginIntegrityPolicy:
    """Explicit compatibility and signature policy.

    ``allow_unsigned_local`` defaults to ``True`` only to preserve the existing
    local/workspace plugin contract.  Such packages are reported as unsigned
    and are never promoted to publisher-trusted status.  Remote packages remain
    signature-required unless an embedding application explicitly opts out.
    """

    require_signed_remote: bool = True
    allow_unsigned_local: bool = True
    allow_unsigned_bundled: bool = True

    @classmethod
    def from_environment(cls) -> "PluginIntegrityPolicy":
        return cls(
            require_signed_remote=_env_bool(
                "SOPHIA_PLUGIN_REQUIRE_REMOTE_SIGNATURES",
                default=True,
                malformed_default=True,
            ),
            allow_unsigned_local=_env_bool(
                "SOPHIA_PLUGIN_ALLOW_UNSIGNED_LOCAL",
                default=True,
                malformed_default=False,
            ),
            allow_unsigned_bundled=_env_bool(
                "SOPHIA_PLUGIN_ALLOW_UNSIGNED_BUNDLED",
                default=True,
                malformed_default=False,
            ),
        )

    def signature_required(self, source_kind: str) -> bool:
        normalized = str(source_kind).strip().casefold()
        if normalized in {"remote", "remote-tarball", "registry-or-network"}:
            return self.require_signed_remote
        if normalized == "bundled":
            return not self.allow_unsigned_bundled
        return not self.allow_unsigned_local

    def public_dict(self) -> dict[str, Any]:
        return {
            "requireSignedRemote": self.require_signed_remote,
            "allowUnsignedLocal": self.allow_unsigned_local,
            "allowUnsignedBundled": self.allow_unsigned_bundled,
        }


@dataclass(frozen=True)
class PackageVerification:
    status: str
    allowed: bool
    required: bool
    signed: bool
    publisher: str | None
    key_id: str | None
    canonical_archive_digest: str
    manifest_sha256: str | None
    trusted_publisher: bool
    revocation_checked: bool
    reason: str | None = None

    def public_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "allowed": self.allowed,
            "required": self.required,
            "signed": self.signed,
            "publisher": self.publisher,
            "keyId": self.key_id,
            "canonicalArchiveDigest": self.canonical_archive_digest,
            "manifestSha256": self.manifest_sha256,
            "trustedPublisher": self.trusted_publisher,
            "revocationChecked": self.revocation_checked,
            "reason": self.reason,
        }

    def lock_dict(self) -> dict[str, Any]:
        """Stable, path-free subset suitable for deterministic portable locks."""
        return {
            "status": self.status,
            "signed": self.signed,
            "publisher": self.publisher,
            "keyId": self.key_id,
            "canonicalArchiveDigest": self.canonical_archive_digest,
            "manifestSha256": self.manifest_sha256,
            "trustedPublisher": self.trusted_publisher,
            "revocationChecked": self.revocation_checked,
        }


def _env_bool(name: str, *, default: bool, malformed_default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return malformed_default


def canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def publisher_key_id(public_key_bytes: bytes) -> str:
    if len(public_key_bytes) != 32:
        raise PluginIntegrityError("Ed25519 public keys must contain exactly 32 bytes")
    return "ed25519:" + sha256_bytes(public_key_bytes)


def _safe_relative_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise PluginIntegrityError(f"{label} must be a non-empty relative path")
    if (
        "\x00" in value
        or "\\" in value
        or value.startswith("/")
        or WINDOWS_DRIVE_RE.match(value)
    ):
        raise PluginIntegrityError(f"{label} is not a portable package path")
    path = PurePosixPath(value)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise PluginIntegrityError(f"{label} escapes the package root")
    return path.as_posix()


def _normalize_tar_name(value: str) -> str:
    if not isinstance(value, str) or "\x00" in value or "\\" in value:
        raise PluginIntegrityError("archive contains a non-portable member name")
    if value.startswith("/") or WINDOWS_DRIVE_RE.match(value):
        raise PluginIntegrityError("archive contains an absolute member")
    parts = [part for part in value.split("/") if part not in {"", "."}]
    if any(part == ".." for part in parts):
        raise PluginIntegrityError("archive member escapes the package root")
    return PurePosixPath(*parts).as_posix() if parts else ""


def _tar_prefix(names: list[str]) -> str:
    if PACKAGE_MANIFEST_FILENAME in names or "package.json" in names:
        return ""
    root_markers = [
        name
        for name in names
        if name.endswith("/" + PACKAGE_MANIFEST_FILENAME)
        or name.endswith("/package.json")
    ]
    roots: set[str] = set()
    for marker in root_markers:
        suffix = (
            PACKAGE_MANIFEST_FILENAME
            if marker.endswith("/" + PACKAGE_MANIFEST_FILENAME)
            else "package.json"
        )
        root = marker[: -len(suffix)]
        if all(candidate.startswith(root) for candidate in names):
            roots.add(root)
    if len(roots) != 1:
        raise PluginIntegrityError(
            "archive must contain one package root with package metadata"
        )
    return next(iter(roots))


def _read_regular_file(path: Path, *, maximum: int) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise PluginIntegrityError(
            f"could not safely read package file: {type(exc).__name__}"
        ) from exc
    chunks: list[bytes] = []
    total = 0
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise PluginIntegrityError("package member is not a regular file")
        while True:
            chunk = os.read(fd, min(1024 * 1024, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                raise PluginIntegrityError(
                    f"package file exceeds the {maximum}-byte limit"
                )
        if total != metadata.st_size:
            raise PluginIntegrityError("package file changed while being inspected")
    finally:
        os.close(fd)
    return b"".join(chunks)


def _same_node(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        first.st_dev,
        first.st_ino,
        stat.S_IFMT(first.st_mode),
    ) == (
        second.st_dev,
        second.st_ino,
        stat.S_IFMT(second.st_mode),
    )


def _same_snapshot(first: os.stat_result, second: os.stat_result) -> bool:
    return _same_node(first, second) and (
        first.st_mode,
        first.st_size,
        getattr(first, "st_mtime_ns", None),
        getattr(first, "st_ctime_ns", None),
    ) == (
        second.st_mode,
        second.st_size,
        getattr(second, "st_mtime_ns", None),
        getattr(second, "st_ctime_ns", None),
    )


def _secure_directory_walk_supported() -> bool:
    return _SECURE_DIRECTORY_WALK_SUPPORTED


def _open_directory_path_no_follow(root_path: Path) -> int:
    """Open every lexical component of ``root_path`` without following links.

    Opening only the final component with ``O_NOFOLLOW`` is insufficient: an
    attacker-controlled ancestor can otherwise redirect the whole traversal.
    Each component is inspected and then opened relative to its already-open
    parent descriptor.  The no-follow open and inode comparison close the
    lstat/open race while allowing the previous descriptor to be released.
    """
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        directory_flags |= os.O_CLOEXEC

    if root_path.is_absolute():
        anchor = root_path.anchor
        parts = root_path.parts[1:]
    else:
        anchor = "."
        parts = root_path.parts
    try:
        current_fd = os.open(anchor, directory_flags)
    except OSError as exc:
        raise PluginIntegrityError(
            "package source could not be inspected"
        ) from exc

    try:
        for part in parts:
            try:
                expected = os.stat(
                    part,
                    dir_fd=current_fd,
                    follow_symlinks=False,
                )
            except OSError as exc:
                raise PluginIntegrityError(
                    "package source could not be inspected"
                ) from exc
            if stat.S_ISLNK(expected.st_mode):
                raise PluginIntegrityError(
                    "package source path contains a symlink"
                )
            if not stat.S_ISDIR(expected.st_mode):
                raise PluginIntegrityError(
                    "package source must be a non-symlink directory"
                )
            try:
                next_fd = os.open(
                    part,
                    directory_flags,
                    dir_fd=current_fd,
                )
            except OSError as exc:
                raise PluginIntegrityError(
                    "package source changed while being inspected"
                ) from exc
            try:
                opened = os.fstat(next_fd)
                if not _same_node(expected, opened):
                    raise PluginIntegrityError(
                        "package source changed while being inspected"
                    )
            except BaseException:
                os.close(next_fd)
                raise
            os.close(current_fd)
            current_fd = next_fd
    except BaseException:
        os.close(current_fd)
        raise
    return current_fd


def _read_regular_file_at(
    parent_fd: int,
    name: str,
    *,
    relative: str,
    expected: os.stat_result,
    maximum: int,
) -> tuple[bytes, os.stat_result]:
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    try:
        fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise PluginIntegrityError(
            f"package member changed while being inspected: {relative}"
        ) from exc
    chunks: list[bytes] = []
    total = 0
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise PluginIntegrityError(
                f"package contains non-regular member: {relative}"
            )
        if not _same_snapshot(expected, opened):
            raise PluginIntegrityError(
                f"package member changed while being inspected: {relative}"
            )
        if opened.st_size > maximum:
            raise PluginIntegrityError(
                f"package file exceeds the {maximum}-byte limit"
            )
        while True:
            chunk = os.read(fd, min(1024 * 1024, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                raise PluginIntegrityError(
                    f"package file exceeds the {maximum}-byte limit"
                )
        after = os.fstat(fd)
        try:
            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except OSError as exc:
            raise PluginIntegrityError(
                f"package member changed while being inspected: {relative}"
            ) from exc
        if (
            total != opened.st_size
            or not _same_snapshot(opened, after)
            or not _same_snapshot(after, current)
        ):
            raise PluginIntegrityError(
                f"package member changed while being inspected: {relative}"
            )
    finally:
        os.close(fd)
    return b"".join(chunks), after


def read_directory_member_secure(
    root: str | Path,
    relative: str,
    *,
    maximum: int = MAX_FILE_BYTES,
) -> bytes:
    """Read one regular member through a stable no-follow descriptor chain."""
    if not _secure_directory_walk_supported():
        raise PluginIntegrityError(
            "secure directory inspection requires descriptor-relative "
            "no-follow filesystem support"
        )
    normalized = _safe_relative_path(relative, "package path")
    parts = PurePosixPath(normalized).parts
    if len(parts) > MAX_PACKAGE_DEPTH:
        raise PluginIntegrityError(
            f"package exceeds the {MAX_PACKAGE_DEPTH}-level depth limit"
        )

    root_path = Path(root)
    root_fd = _open_directory_path_no_follow(root_path)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        directory_flags |= os.O_CLOEXEC
    directory_fds = [root_fd]
    opened_directories: list[tuple[int, str, int, os.stat_result]] = []
    current_root_fd: int | None = None
    try:
        opened_root = os.fstat(root_fd)
        parent_fd = root_fd
        for index, part in enumerate(parts[:-1]):
            current_relative = PurePosixPath(*parts[: index + 1]).as_posix()
            try:
                expected = os.stat(
                    part,
                    dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            except OSError as exc:
                raise PluginIntegrityError(
                    "package directory changed while being inspected: "
                    f"{current_relative}"
                ) from exc
            if stat.S_ISLNK(expected.st_mode):
                raise PluginIntegrityError(
                    f"package contains symlink: {current_relative}"
                )
            if not stat.S_ISDIR(expected.st_mode):
                raise PluginIntegrityError(
                    f"package member is not a directory: {current_relative}"
                )
            try:
                child_fd = os.open(
                    part,
                    directory_flags,
                    dir_fd=parent_fd,
                )
            except OSError as exc:
                raise PluginIntegrityError(
                    "package directory changed while being inspected: "
                    f"{current_relative}"
                ) from exc
            directory_fds.append(child_fd)
            opened = os.fstat(child_fd)
            if not _same_node(expected, opened):
                raise PluginIntegrityError(
                    "package directory changed while being inspected: "
                    f"{current_relative}"
                )
            opened_directories.append((parent_fd, part, child_fd, opened))
            parent_fd = child_fd

        leaf = parts[-1]
        try:
            expected_leaf = os.stat(
                leaf,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except OSError as exc:
            raise PluginIntegrityError(
                f"package member changed while being inspected: {normalized}"
            ) from exc
        if stat.S_ISLNK(expected_leaf.st_mode):
            raise PluginIntegrityError(f"package contains symlink: {normalized}")
        if not stat.S_ISREG(expected_leaf.st_mode):
            raise PluginIntegrityError(
                f"package contains non-regular member: {normalized}"
            )
        raw, _ = _read_regular_file_at(
            parent_fd,
            leaf,
            relative=normalized,
            expected=expected_leaf,
            maximum=maximum,
        )

        for parent, name, descriptor, opened in reversed(opened_directories):
            after = os.fstat(descriptor)
            try:
                current = os.stat(
                    name,
                    dir_fd=parent,
                    follow_symlinks=False,
                )
            except OSError as exc:
                raise PluginIntegrityError(
                    "package directory changed while being inspected: "
                    f"{normalized}"
                ) from exc
            if (
                not _same_snapshot(opened, after)
                or not _same_snapshot(after, current)
            ):
                raise PluginIntegrityError(
                    "package directory changed while being inspected: "
                    f"{normalized}"
                )

        after_root = os.fstat(root_fd)
        current_root_fd = _open_directory_path_no_follow(root_path)
        current_root = os.fstat(current_root_fd)
        if (
            not _same_snapshot(opened_root, after_root)
            or not _same_snapshot(after_root, current_root)
        ):
            raise PluginIntegrityError(
                "package source changed while being inspected"
            )
        return raw
    finally:
        if current_root_fd is not None:
            os.close(current_root_fd)
        for descriptor in reversed(directory_fds):
            os.close(descriptor)


def read_directory_snapshot_secure(
    root: str | Path,
    *,
    max_files: int,
    max_bytes: int,
    max_file_bytes: int = MAX_FILE_BYTES,
) -> dict[str, DirectoryMemberSnapshot]:
    """Read one immutable directory snapshot through no-follow descriptors.

    Descriptor-relative traversal keeps an attacker from swapping an already
    inspected parent for a symlink. ``O_NONBLOCK`` on leaf opens also ensures a
    regular-file-to-FIFO race fails closed instead of hanging the verifier.
    """
    root_path = Path(root)
    if not _secure_directory_walk_supported():
        raise PluginIntegrityError(
            "secure directory inspection requires descriptor-relative "
            "no-follow filesystem support"
        )
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        directory_flags |= os.O_CLOEXEC
    root_fd = _open_directory_path_no_follow(root_path)
    members: dict[str, DirectoryMemberSnapshot] = {}
    total = 0
    nodes = 0
    max_nodes = max(max_files * 2, max_files + 64)

    def walk(directory_fd: int, relative_parts: tuple[str, ...]) -> None:
        nonlocal nodes, total
        try:
            with os.scandir(directory_fd) as entries:
                for entry in entries:
                    nodes += 1
                    if nodes > max_nodes:
                        raise PluginIntegrityError(
                            f"package exceeds the {max_nodes}-entry integrity limit"
                        )
                    relative = _safe_relative_path(
                        PurePosixPath(*relative_parts, entry.name).as_posix(),
                        "package path",
                    )
                    try:
                        expected = os.stat(
                            entry.name,
                            dir_fd=directory_fd,
                            follow_symlinks=False,
                        )
                    except OSError as exc:
                        raise PluginIntegrityError(
                            f"package member changed while being inspected: {relative}"
                        ) from exc
                    if stat.S_ISLNK(expected.st_mode):
                        raise PluginIntegrityError(
                            f"package contains symlink: {relative}"
                        )
                    if stat.S_ISDIR(expected.st_mode):
                        if len(relative_parts) + 1 > MAX_PACKAGE_DEPTH:
                            raise PluginIntegrityError(
                                "package exceeds the "
                                f"{MAX_PACKAGE_DEPTH}-level depth limit"
                            )
                        try:
                            child_fd = os.open(
                                entry.name,
                                directory_flags,
                                dir_fd=directory_fd,
                            )
                        except OSError as exc:
                            raise PluginIntegrityError(
                                "package directory changed while being inspected: "
                                f"{relative}"
                            ) from exc
                        try:
                            opened = os.fstat(child_fd)
                            if not _same_node(expected, opened):
                                raise PluginIntegrityError(
                                    "package directory changed while being "
                                    f"inspected: {relative}"
                                )
                            walk(child_fd, (*relative_parts, entry.name))
                            after = os.fstat(child_fd)
                            try:
                                current = os.stat(
                                    entry.name,
                                    dir_fd=directory_fd,
                                    follow_symlinks=False,
                                )
                            except OSError as exc:
                                raise PluginIntegrityError(
                                    "package directory changed while being "
                                    f"inspected: {relative}"
                                ) from exc
                            if (
                                not _same_snapshot(opened, after)
                                or not _same_snapshot(after, current)
                            ):
                                raise PluginIntegrityError(
                                    "package directory changed while being "
                                    f"inspected: {relative}"
                                )
                        finally:
                            os.close(child_fd)
                        continue
                    if not stat.S_ISREG(expected.st_mode):
                        raise PluginIntegrityError(
                            f"package contains non-regular member: {relative}"
                        )
                    if len(members) >= max_files:
                        raise PluginIntegrityError(
                            f"package exceeds the {max_files}-file integrity limit"
                        )
                    raw, stable_metadata = _read_regular_file_at(
                        directory_fd,
                        entry.name,
                        relative=relative,
                        expected=expected,
                        maximum=max_file_bytes,
                    )
                    total += len(raw)
                    if total > max_bytes:
                        raise PluginIntegrityError(
                            f"package exceeds the {max_bytes}-byte integrity limit"
                        )
                    members[relative] = DirectoryMemberSnapshot(
                        content=raw,
                        mode=stable_metadata.st_mode & 0o777,
                    )
        except PluginIntegrityError:
            raise
        except OSError as exc:
            raise PluginIntegrityError(
                "package directory changed while being inspected"
            ) from exc

    try:
        opened_root = os.fstat(root_fd)
        walk(root_fd, ())
        after_root = os.fstat(root_fd)
        try:
            current_root_fd = _open_directory_path_no_follow(root_path)
            try:
                current_root = os.fstat(current_root_fd)
                if (
                    not _same_snapshot(opened_root, after_root)
                    or not _same_snapshot(after_root, current_root)
                ):
                    raise PluginIntegrityError(
                        "package source changed while being inspected"
                    )
            finally:
                os.close(current_root_fd)
        except PluginIntegrityError:
            raise
    finally:
        os.close(root_fd)
    return members


def read_directory_members_secure(
    root: str | Path,
    *,
    max_files: int,
    max_bytes: int,
    max_file_bytes: int = MAX_FILE_BYTES,
) -> dict[str, bytes]:
    """Return the content from one secure directory snapshot."""
    snapshot = read_directory_snapshot_secure(
        root,
        max_files=max_files,
        max_bytes=max_bytes,
        max_file_bytes=max_file_bytes,
    )
    return {
        relative: member.content
        for relative, member in snapshot.items()
    }


def _directory_members(
    root: Path,
    *,
    max_files: int,
    max_bytes: int,
) -> dict[str, bytes]:
    return read_directory_members_secure(
        root,
        max_files=max_files,
        max_bytes=max_bytes,
    )


def _tar_members(
    path: Path,
    *,
    max_files: int,
    max_bytes: int,
) -> dict[str, bytes]:
    if path.is_symlink() or not path.is_file():
        raise PluginIntegrityError("package archive must be a non-symlink file")
    if path.stat().st_size > max_bytes:
        raise PluginIntegrityError(
            f"package archive exceeds the {max_bytes}-byte integrity limit"
        )
    try:
        with open_bounded_tar_archive(path) as archive:
            raw_members: list[tuple[tarfile.TarInfo, str]] = []
            names: list[str] = []
            total_declared = 0
            for member in archive:
                normalized = _normalize_tar_name(member.name)
                if not normalized or member.isdir():
                    continue
                if member.issym() or member.islnk() or not member.isfile():
                    raise PluginIntegrityError(
                        f"archive contains unsafe member: {normalized}"
                    )
                if member.size < 0 or member.size > MAX_FILE_BYTES:
                    raise PluginIntegrityError(
                        f"archive member exceeds its declared limit: {normalized}"
                    )
                if len(raw_members) >= max_files:
                    raise PluginIntegrityError(
                        f"package exceeds the {max_files}-file integrity limit"
                    )
                total_declared += member.size
                if total_declared > max_bytes:
                    raise PluginIntegrityError(
                        f"package exceeds the {max_bytes}-byte integrity limit"
                    )
                raw_members.append((member, normalized))
                names.append(normalized)
            prefix = _tar_prefix(names)
            members: dict[str, bytes] = {}
            total = 0
            for member, normalized in raw_members:
                if prefix:
                    if not normalized.startswith(prefix):
                        raise PluginIntegrityError(
                            "archive member is outside the signed package root"
                        )
                    relative = normalized[len(prefix) :]
                else:
                    relative = normalized
                relative = _safe_relative_path(relative, "archive package path")
                if relative in members:
                    raise PluginIntegrityError(
                        f"archive contains duplicate member: {relative}"
                    )
                handle = archive.extractfile(member)
                if handle is None:
                    raise PluginIntegrityError(
                        f"archive member could not be read: {relative}"
                    )
                raw = handle.read(MAX_FILE_BYTES + 1)
                if len(raw) > MAX_FILE_BYTES or len(raw) != member.size:
                    raise PluginIntegrityError(
                        f"archive member exceeds its declared limit: {relative}"
                    )
                total += len(raw)
                if total > max_bytes:
                    raise PluginIntegrityError(
                        f"package exceeds the {max_bytes}-byte integrity limit"
                    )
                members[relative] = raw
            return members
    except PluginIntegrityError:
        raise
    except (OSError, tarfile.TarError) as exc:
        raise PluginIntegrityError(
            f"package archive could not be inspected: {type(exc).__name__}"
        ) from exc


def _package_members(
    source: Path,
    *,
    max_files: int,
    max_bytes: int,
) -> dict[str, bytes]:
    if source.is_dir():
        return _directory_members(
            source,
            max_files=max_files,
            max_bytes=max_bytes,
        )
    return _tar_members(
        source,
        max_files=max_files,
        max_bytes=max_bytes,
    )


def canonical_file_inventory(
    members: Mapping[str, bytes],
) -> list[dict[str, Any]]:
    excluded = {PACKAGE_MANIFEST_FILENAME, PACKAGE_SIGNATURE_FILENAME}
    return [
        {
            "path": path,
            "size": len(members[path]),
            "sha256": sha256_bytes(members[path]),
        }
        for path in sorted(members)
        if path not in excluded
    ]


def canonical_archive_digest(inventory: Iterable[Mapping[str, Any]]) -> str:
    body = {
        "schema": CANONICAL_ARCHIVE_SCHEMA,
        "files": [
            {
                "path": str(item["path"]),
                "size": int(item["size"]),
                "sha256": str(item["sha256"]),
            }
            for item in sorted(inventory, key=lambda row: str(row["path"]))
        ],
    }
    return "sha256:" + sha256_bytes(canonical_json_bytes(body))


def build_package_manifest(
    members: Mapping[str, bytes],
    *,
    package_id: str,
    version: str,
    publisher: str,
) -> dict[str, Any]:
    _validate_package_identity(package_id, version, publisher)
    inventory = canonical_file_inventory(members)
    return {
        "schema": PACKAGE_MANIFEST_SCHEMA,
        "package": {
            "id": package_id,
            "version": version,
            "publisher": publisher,
        },
        "canonicalArchive": {
            "schema": CANONICAL_ARCHIVE_SCHEMA,
            "sha256": canonical_archive_digest(inventory),
            "files": inventory,
        },
    }


def _validate_package_identity(
    package_id: Any,
    version: Any,
    publisher: Any,
) -> tuple[str, str, str]:
    if (
        not isinstance(package_id, str)
        or not IDENTIFIER_RE.fullmatch(package_id)
        or ".." in PurePosixPath(package_id).parts
    ):
        raise PluginIntegrityError("signed package id is invalid")
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise PluginIntegrityError("signed package version is invalid")
    if (
        not isinstance(publisher, str)
        or not publisher
        or len(publisher) > 120
        or not IDENTIFIER_RE.fullmatch(publisher)
    ):
        raise PluginIntegrityError("signed publisher id is invalid")
    return package_id, version, publisher


def _json_object(raw: bytes, label: str) -> dict[str, Any]:
    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for key, value in pairs:
            if key in output:
                raise PluginIntegrityError(
                    f"{label} contains duplicate object key {key!r}"
                )
            output[key] = value
        return output

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs_hook)
    except UnicodeDecodeError as exc:
        raise PluginIntegrityError(f"{label} must be UTF-8 JSON") from exc
    except PluginIntegrityError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise PluginIntegrityError(f"{label} is malformed JSON") from exc
    if not isinstance(value, dict):
        raise PluginIntegrityError(f"{label} must be a JSON object")
    return value


class PublisherTrustStore:
    """Strict read-only view of operator-established publisher trust."""

    def __init__(self, path: Path, payload: Mapping[str, Any] | None = None):
        self.path = path
        self.publishers: dict[str, dict[str, Any]] = {}
        self.revocations: tuple[dict[str, Any], ...] = ()
        if payload is not None:
            self._load_payload(payload)

    @classmethod
    def load(cls, path: str | Path) -> "PublisherTrustStore":
        unresolved = Path(path).expanduser()
        if unresolved.is_symlink():
            raise PluginIntegrityError(
                "publisher trust store must not be a symlink"
            )
        resolved = unresolved.absolute()
        if not resolved.exists():
            return cls(resolved)
        raw = _read_regular_file(resolved, maximum=MAX_INTEGRITY_FILE_BYTES)
        return cls(resolved, _json_object(raw, "publisher trust store"))

    def _load_payload(self, payload: Mapping[str, Any]) -> None:
        allowed = {"schema", "publishers", "revocations"}
        unknown = sorted(set(payload) - allowed)
        if unknown:
            raise PluginIntegrityError(
                "publisher trust store has unknown field(s): " + ", ".join(unknown)
            )
        if payload.get("schema") != PUBLISHER_TRUST_SCHEMA:
            raise PluginIntegrityError("publisher trust store schema is invalid")
        publishers = payload.get("publishers")
        revocations = payload.get("revocations", [])
        if not isinstance(publishers, list) or not isinstance(revocations, list):
            raise PluginIntegrityError(
                "publisher trust store publishers/revocations must be arrays"
            )
        parsed: dict[str, dict[str, Any]] = {}
        for item in publishers:
            if not isinstance(item, dict):
                raise PluginIntegrityError("publisher trust record must be an object")
            unknown = sorted(
                set(item)
                - {
                    "id",
                    "displayName",
                    "trust",
                    "keys",
                    "revokedAt",
                    "revocationReason",
                }
            )
            if unknown:
                raise PluginIntegrityError(
                    "publisher trust record has unknown field(s): "
                    + ", ".join(unknown)
                )
            publisher_id = item.get("id")
            _validate_package_identity("placeholder", "0.0.0", publisher_id)
            if publisher_id in parsed:
                raise PluginIntegrityError(
                    f"publisher trust store duplicates publisher {publisher_id}"
                )
            trust = item.get("trust")
            if trust not in {"trusted", "revoked"}:
                raise PluginIntegrityError(
                    f"publisher {publisher_id} trust must be trusted or revoked"
                )
            if trust == "revoked" and (
                not isinstance(item.get("revokedAt"), str)
                or not item["revokedAt"]
                or not isinstance(item.get("revocationReason"), str)
                or not item["revocationReason"]
            ):
                raise PluginIntegrityError(
                    f"revoked publisher {publisher_id} lacks revocation metadata"
                )
            keys = item.get("keys")
            if not isinstance(keys, list) or not keys:
                raise PluginIntegrityError(
                    f"publisher {publisher_id} must declare at least one key"
                )
            parsed_keys: dict[str, dict[str, Any]] = {}
            for key in keys:
                if not isinstance(key, dict):
                    raise PluginIntegrityError(
                        f"publisher {publisher_id} key record must be an object"
                    )
                unknown = sorted(
                    set(key)
                    - {
                        "keyId",
                        "algorithm",
                        "publicKey",
                        "status",
                        "createdAt",
                        "revokedAt",
                        "revocationReason",
                    }
                )
                if unknown:
                    raise PluginIntegrityError(
                        "publisher key record has unknown field(s): "
                        + ", ".join(unknown)
                    )
                if key.get("algorithm") != "ed25519":
                    raise PluginIntegrityError(
                        f"publisher {publisher_id} uses unsupported key algorithm"
                    )
                public_hex = key.get("publicKey")
                try:
                    public_bytes = bytes.fromhex(public_hex)
                except (TypeError, ValueError) as exc:
                    raise PluginIntegrityError(
                        f"publisher {publisher_id} has invalid Ed25519 public key"
                    ) from exc
                derived_id = publisher_key_id(public_bytes)
                if key.get("keyId") != derived_id:
                    raise PluginIntegrityError(
                        f"publisher {publisher_id} keyId does not match publicKey"
                    )
                status_value = key.get("status")
                if status_value not in {"active", "revoked"}:
                    raise PluginIntegrityError(
                        f"publisher {publisher_id} key status is invalid"
                    )
                if status_value == "revoked" and (
                    not isinstance(key.get("revokedAt"), str)
                    or not key["revokedAt"]
                    or not isinstance(key.get("revocationReason"), str)
                    or not key["revocationReason"]
                ):
                    raise PluginIntegrityError(
                        f"revoked publisher key {derived_id} lacks revocation metadata"
                    )
                if derived_id in parsed_keys:
                    raise PluginIntegrityError(
                        f"publisher {publisher_id} duplicates key {derived_id}"
                    )
                parsed_keys[derived_id] = {**key, "publicKeyBytes": public_bytes}
            parsed[publisher_id] = {**item, "parsedKeys": parsed_keys}
        parsed_revocations: list[dict[str, Any]] = []
        for item in revocations:
            if not isinstance(item, dict):
                raise PluginIntegrityError("package revocation must be an object")
            allowed_fields = {
                "publisher",
                "package",
                "version",
                "canonicalArchiveDigest",
                "revokedAt",
                "reason",
            }
            unknown = sorted(set(item) - allowed_fields)
            if unknown:
                raise PluginIntegrityError(
                    "package revocation has unknown field(s): " + ", ".join(unknown)
                )
            publisher = item.get("publisher")
            package = item.get("package")
            version = item.get("version")
            _validate_package_identity(
                package,
                version if version is not None else "0.0.0",
                publisher,
            )
            digest = item.get("canonicalArchiveDigest")
            if digest is not None and (
                not isinstance(digest, str)
                or not digest.startswith("sha256:")
                or not SHA256_RE.fullmatch(digest[7:])
            ):
                raise PluginIntegrityError("package revocation digest is invalid")
            if (
                not isinstance(item.get("revokedAt"), str)
                or not item["revokedAt"]
                or not isinstance(item.get("reason"), str)
                or not item["reason"]
            ):
                raise PluginIntegrityError(
                    "package revocation lacks revokedAt/reason metadata"
                )
            parsed_revocations.append(dict(item))
        self.publishers = parsed
        self.revocations = tuple(parsed_revocations)

    def require_key(
        self,
        *,
        publisher: str,
        key_id: str,
        package_id: str,
        version: str,
        canonical_digest: str,
    ) -> bytes:
        record = self.publishers.get(publisher)
        if record is None:
            raise PluginIntegrityError(
                f"publisher {publisher} is not present in the operator trust store"
            )
        if record.get("trust") != "trusted":
            raise PluginIntegrityError(
                f"publisher {publisher} is revoked: "
                f"{record.get('revocationReason') or 'no reason supplied'}"
            )
        key = record["parsedKeys"].get(key_id)
        if key is None:
            raise PluginIntegrityError(
                f"publisher {publisher} does not own trusted key {key_id}"
            )
        if key.get("status") != "active":
            raise PluginIntegrityError(
                f"publisher key {key_id} is revoked: "
                f"{key.get('revocationReason') or 'no reason supplied'}"
            )
        for revocation in self.revocations:
            if (
                revocation.get("publisher") == publisher
                and revocation.get("package") == package_id
                and (
                    revocation.get("version") is None
                    or revocation.get("version") == version
                )
                and (
                    revocation.get("canonicalArchiveDigest") is None
                    or revocation.get("canonicalArchiveDigest")
                    == canonical_digest
                )
            ):
                raise PluginIntegrityError(
                    "signed package release is revoked: "
                    + str(revocation.get("reason"))
                )
        return bytes(key["publicKeyBytes"])


def _verify_ed25519(public_key: bytes, signature: bytes, message: bytes) -> None:
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PublicKey,
        )
    except ImportError as exc:
        raise PluginIntegrityError(
            "cryptography is required for Ed25519 plugin signature verification"
        ) from exc
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
    except (InvalidSignature, ValueError) as exc:
        raise PluginIntegrityError("detached plugin signature is invalid") from exc


def verify_package_source(
    source: str | Path,
    *,
    source_kind: str,
    policy: PluginIntegrityPolicy,
    trust_store_path: str | Path,
    expected_package_id: str,
    expected_version: str,
    expected_publisher: str | None = None,
    max_files: int = MAX_PACKAGE_FILES,
    max_bytes: int = MAX_PACKAGE_BYTES,
) -> PackageVerification:
    """Verify one directory/archive without importing or executing package code."""
    unresolved = Path(source).expanduser()
    if unresolved.is_symlink():
        raise PluginIntegrityError("package source must not be a symlink")
    # Preserve the lexical path into the descriptor-relative reader.  Resolving
    # here would erase a symlinked ancestor before the no-follow boundary had a
    # chance to reject it.
    path = Path(os.path.abspath(unresolved))
    members = _package_members(
        path,
        max_files=max_files,
        max_bytes=max_bytes,
    )
    inventory = canonical_file_inventory(members)
    archive_digest = canonical_archive_digest(inventory)
    required = policy.signature_required(source_kind)
    manifest_raw = members.get(PACKAGE_MANIFEST_FILENAME)
    signature_raw = members.get(PACKAGE_SIGNATURE_FILENAME)
    if manifest_raw is None and signature_raw is None:
        if required:
            raise PluginIntegrityError(
                f"{source_kind} plugin package requires a trusted publisher signature"
            )
        status = (
            "unsigned-bundled-policy"
            if str(source_kind).strip().casefold() == "bundled"
            else "unsigned-local-policy"
        )
        return PackageVerification(
            status=status,
            allowed=True,
            required=False,
            signed=False,
            publisher=expected_publisher,
            key_id=None,
            canonical_archive_digest=archive_digest,
            manifest_sha256=None,
            trusted_publisher=False,
            revocation_checked=False,
            reason="allowed only by explicit unsigned local/bundled policy",
        )
    if manifest_raw is None or signature_raw is None:
        raise PluginIntegrityError(
            "plugin package has incomplete detached signature metadata"
        )
    if (
        len(manifest_raw) > MAX_INTEGRITY_FILE_BYTES
        or len(signature_raw) > MAX_INTEGRITY_FILE_BYTES
    ):
        raise PluginIntegrityError("plugin integrity metadata exceeds 1 MiB")
    manifest = _json_object(manifest_raw, "plugin package integrity manifest")
    expected_keys = {"schema", "package", "canonicalArchive"}
    if set(manifest) != expected_keys:
        raise PluginIntegrityError(
            "plugin package integrity manifest fields are invalid"
        )
    package = manifest.get("package")
    archive = manifest.get("canonicalArchive")
    if (
        not isinstance(package, dict)
        or set(package) != {"id", "version", "publisher"}
        or not isinstance(archive, dict)
        or set(archive) != {"schema", "sha256", "files"}
    ):
        raise PluginIntegrityError(
            "plugin package integrity manifest structure is invalid"
        )
    package_id, version, publisher = _validate_package_identity(
        package.get("id"),
        package.get("version"),
        package.get("publisher"),
    )
    if package_id != expected_package_id or version != expected_version:
        raise PluginIntegrityError(
            "signed package identity does not match the inspected package"
        )
    if expected_publisher is not None and publisher != expected_publisher:
        raise PluginIntegrityError(
            "signed publisher does not match the plugin manifest publisher"
        )
    expected_manifest = build_package_manifest(
        members,
        package_id=package_id,
        version=version,
        publisher=publisher,
    )
    expected_manifest_raw = canonical_json_bytes(expected_manifest)
    if manifest_raw != expected_manifest_raw:
        raise PluginIntegrityError(
            "plugin package integrity manifest is non-canonical or payload-drifted"
        )
    if (
        archive.get("schema") != CANONICAL_ARCHIVE_SCHEMA
        or archive.get("sha256") != archive_digest
        or archive.get("files") != inventory
    ):
        raise PluginIntegrityError(
            "plugin canonical archive digest/manifest does not match package bytes"
        )
    signature = _json_object(signature_raw, "detached plugin signature")
    signature_fields = {
        "schema",
        "algorithm",
        "publisher",
        "keyId",
        "manifestSha256",
        "signature",
        "signedAt",
    }
    if set(signature) != signature_fields:
        raise PluginIntegrityError("detached plugin signature fields are invalid")
    if (
        signature.get("schema") != PACKAGE_SIGNATURE_SCHEMA
        or signature.get("algorithm") != "ed25519"
        or signature.get("publisher") != publisher
        or not isinstance(signature.get("signedAt"), str)
        or not signature["signedAt"]
    ):
        raise PluginIntegrityError(
            "detached plugin signature metadata is invalid or publisher-mismatched"
        )
    manifest_sha256 = sha256_bytes(manifest_raw)
    if signature.get("manifestSha256") != manifest_sha256:
        raise PluginIntegrityError(
            "detached signature manifest digest does not match canonical manifest"
        )
    key_id = signature.get("keyId")
    if not isinstance(key_id, str) or not KEY_ID_RE.fullmatch(key_id):
        raise PluginIntegrityError("detached plugin signature keyId is invalid")
    try:
        signature_bytes = bytes.fromhex(signature.get("signature"))
    except (TypeError, ValueError) as exc:
        raise PluginIntegrityError(
            "detached plugin signature bytes are invalid"
        ) from exc
    if len(signature_bytes) != 64:
        raise PluginIntegrityError(
            "detached Ed25519 signature must contain exactly 64 bytes"
        )
    trust_store = PublisherTrustStore.load(trust_store_path)
    public_key = trust_store.require_key(
        publisher=publisher,
        key_id=key_id,
        package_id=package_id,
        version=version,
        canonical_digest=archive_digest,
    )
    _verify_ed25519(public_key, signature_bytes, manifest_raw)
    return PackageVerification(
        status="verified",
        allowed=True,
        required=required,
        signed=True,
        publisher=publisher,
        key_id=key_id,
        canonical_archive_digest=archive_digest,
        manifest_sha256=manifest_sha256,
        trusted_publisher=True,
        revocation_checked=True,
    )


__all__ = [
    "CANONICAL_ARCHIVE_SCHEMA",
    "PACKAGE_MANIFEST_FILENAME",
    "PACKAGE_MANIFEST_SCHEMA",
    "PACKAGE_SIGNATURE_FILENAME",
    "PACKAGE_SIGNATURE_SCHEMA",
    "PUBLISHER_TRUST_SCHEMA",
    "PackageVerification",
    "PluginIntegrityError",
    "PluginIntegrityPolicy",
    "PublisherTrustStore",
    "build_package_manifest",
    "canonical_archive_digest",
    "canonical_file_inventory",
    "canonical_json_bytes",
    "publisher_key_id",
    "sha256_bytes",
    "verify_package_source",
]
