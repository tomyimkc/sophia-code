# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Secure, import-free compatibility handling for DeepSeek Harness plugins.

The compatibility manager treats npm packages as untrusted data.  It can
inspect local directories and tar archives, but it never imports package code,
executes a lifecycle script, invokes npm, or invokes a shell.  Discovery never
performs a network request.  An explicitly approved remote install may fetch
only one immutable exact npm registry release by reading bounded registry
metadata and streaming its same-origin tarball into private staging.  Git,
GitHub, URL, tag, and range specs are rejected before any network request.
The resulting tarball is subjected to the same inspection as a local archive.
Installations become visible through a transactionally replaced,
hash-protected lock.

``sophia-compatible`` is deliberately a narrow compatibility status, not a
sandbox, runtime-safety, or capability claim.  Publisher/package integrity is
reported separately and comes only from an operator-owned trust store.  Every
emitted record remains ``candidateOnly: true`` and ``canClaimAGI: false``.
"""
from __future__ import annotations

import base64
import binascii
import copy
import errno
import fnmatch
import functools
import hashlib
import hmac
import ipaddress
import json
import os
import posixpath
import re
import shutil
import stat
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Iterator, Mapping

try:
    import msvcrt
except ImportError:
    msvcrt = None  # type: ignore[assignment]
try:
    import fcntl
except ImportError:
    fcntl = None  # type: ignore[assignment]

from agent.plugin_integrity import (
    PluginIntegrityError,
    PluginIntegrityPolicy,
    open_bounded_tar_archive,
    read_directory_member_secure,
    read_directory_members_secure,
    verify_package_source,
)
from agent.runtime_paths import user_state_dir


LEGACY_LOCK_SCHEMA = "sophia.dsh-compat-lock/v1"
LOCK_SCHEMA = "sophia.dsh-compat-lock/v2"
CATALOG_SCHEMA = "sophia.dsh-compat-catalog/v1"
DISCOVERY_SCHEMA = "sophia.dsh-compat-discovery/v1"
RECEIPT_SCHEMA = "sophia.dsh-compat-receipt/v1"
EVENT_SCHEMA = "sophia.dsh-compat-event/v1"
BRIDGE_SCHEMA = "sophia.dsh-compat-bridge/v1"
LEGACY_TRANSACTION_SCHEMA = "sophia.dsh-compat-transactions/v1"
TRANSACTION_SCHEMA = "sophia.dsh-compat-transactions/v2"
AUTHORITY_SCHEMA = "sophia.dsh-compat-authority/v1"

MAX_MANIFEST_BYTES = 262_144
MAX_PACKAGE_FILES = 4096
MAX_PACKAGE_BYTES = 67_108_864
MAX_ARCHIVE_BYTES = 67_108_864
MAX_FILE_BYTES = 33_554_432
MAX_DEPENDENCIES = 1024
MAX_CLIENT_INJECT = 256
MAX_CONFORMANCE_BYTES = 262_144
MAX_REGISTRY_METADATA_BYTES = 1_048_576
DEFAULT_OPERATION_TIMEOUT_SECONDS = 45.0
DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/"
MAX_HTTP_REDIRECTS = 3
MAX_BRIDGE_FILES = 256
MAX_BRIDGE_BYTES = 8_388_608
MAX_BRIDGE_FILE_BYTES = 2_097_152
MAX_TRANSACTION_HISTORY = 256
MAX_TRANSACTION_STATE_BYTES = 3 * MAX_PACKAGE_BYTES
MAX_AUTHORITY_STATE_BYTES = MAX_REGISTRY_METADATA_BYTES
BRIDGE_DESTINATION = "sophia-bridge"
DEFAULT_BRIDGE_ENTRYPOINT = "cordis/bridge-plugin.js"

PACKAGE_NAME_RE = re.compile(
    r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$"
)
VERSION_RE = re.compile(
    r"^(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)"
    r"(?:-("
    r"(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*"
    r"))?"
    r"(?:\+("
    r"[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*"
    r"))?$"
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ED25519_KEY_ID_RE = re.compile(r"^ed25519:[0-9a-f]{64}$")
WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:")
STATIC_JS_SPECIFIER_RE = re.compile(
    r"""(?:^|[;\n])\s*(?:import|export)\s+"""
    r"""(?:[^'";\n]*?\s+from\s+)?["']([^"'\\\n]+)["']""",
    re.MULTILINE,
)
DYNAMIC_JS_SPECIFIER_RE = re.compile(
    r"""(?:^|[^\w])import\s*\(\s*["']([^"'\\\n]+)["']\s*\)""",
    re.MULTILINE,
)
REQUIRE_JS_SPECIFIER_RE = re.compile(
    r"""(?:^|[^\w])require\s*\(\s*["']([^"'\\\n]+)["']\s*\)""",
    re.MULTILINE,
)

_WORKSPACE_MUTEXES_GUARD = threading.Lock()
_WORKSPACE_MUTEXES: dict[str, threading.RLock] = {}

VALID_STATUSES = frozenset(
    {
        "discovered",
        "manifest-valid",
        "installable-prebuilt",
        "requires-build-script",
        "conformance-tested",
        "sophia-compatible",
        "external-runtime-only",
        "quarantined",
        "blocked",
    }
)
LIFECYCLE_SCRIPTS = frozenset(
    {
        "preinstall",
        "install",
        "postinstall",
        "prepare",
        "prepack",
        "prepublish",
        "prepublishonly",
    }
)
BUILD_SCRIPTS = frozenset(
    {
        "build",
        "bundle",
        "compile",
        "dist",
        "generate",
        "package",
    }
)


class DshCompatibilityError(ValueError):
    """Raised when a package or persisted compatibility record fails closed."""


def _lifecycle_authority_error(
    message: str,
    *,
    plugin_id: str,
    nonce: str,
) -> DshCompatibilityError:
    error = DshCompatibilityError(message)
    error._lifecycleCompatibilityId = plugin_id
    error._lifecycleAuthorityNonce = nonce
    return error


class DshApprovalRequired(PermissionError):
    """Raised when a safe local installation lacks explicit approval."""

    def __init__(self, record: Mapping[str, Any]):
        super().__init__(
            "DSH compatibility installation requires approve=True; "
            "no package content was installed"
        )
        self.record = copy.deepcopy(dict(record))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def _canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file_no_follow(path: Path, *, maximum: int | None = None) -> str:
    flags = os.O_RDONLY
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise DshCompatibilityError(
            f"could not safely open file {path}: {type(exc).__name__}"
        ) from exc
    digest = hashlib.sha256()
    total = 0
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise DshCompatibilityError(f"package member is not a regular file: {path}")
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if maximum is not None and total > maximum:
                raise DshCompatibilityError(
                    f"file exceeds the {maximum}-byte inspection limit: {path}"
                )
            digest.update(chunk)
        if total != metadata.st_size:
            raise DshCompatibilityError(f"file changed while being inspected: {path}")
    finally:
        os.close(fd)
    return digest.hexdigest()


def _read_file_no_follow(path: Path, *, maximum: int) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise DshCompatibilityError(
            f"could not safely read file {path}: {type(exc).__name__}"
        ) from exc
    chunks: list[bytes] = []
    total = 0
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise DshCompatibilityError(f"package member is not a regular file: {path}")
        if metadata.st_size > maximum:
            raise DshCompatibilityError(
                f"file exceeds the {maximum}-byte inspection limit: {path}"
            )
        while True:
            chunk = os.read(fd, min(1024 * 1024, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                raise DshCompatibilityError(
                    f"file exceeds the {maximum}-byte inspection limit: {path}"
                )
        if total != metadata.st_size:
            raise DshCompatibilityError(f"file changed while being inspected: {path}")
    finally:
        os.close(fd)
    return b"".join(chunks)


def _read_bridge_member(source_root: Path, relative: str) -> bytes:
    """Read one bridge member without following its root or parent path."""
    try:
        return read_directory_member_secure(
            source_root,
            relative,
            maximum=MAX_BRIDGE_FILE_BYTES,
        )
    except PluginIntegrityError as exc:
        raise DshCompatibilityError(
            "Sophia Cordis bridge closure member could not be read safely: "
            f"{relative}: {exc}"
        ) from exc


def _json_no_duplicates(raw: bytes, label: str) -> dict[str, Any]:
    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise DshCompatibilityError(
                    f"{label} contains duplicate object key {key!r}"
                )
            result[key] = value
        return result

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs_hook)
    except UnicodeDecodeError as exc:
        raise DshCompatibilityError(f"{label} must be UTF-8 JSON") from exc
    except DshCompatibilityError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise DshCompatibilityError(f"{label} is malformed JSON") from exc
    if not isinstance(value, dict):
        raise DshCompatibilityError(f"{label} must be a JSON object")
    return value


def _safe_relative_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DshCompatibilityError(f"{label} must be a non-empty relative path")
    text = value.strip()
    if len(text) > 1024:
        raise DshCompatibilityError(f"{label} exceeds 1024 characters")
    if "\x00" in text or "\\" in text or WINDOWS_DRIVE_RE.match(text):
        raise DshCompatibilityError(f"{label} is not a portable package path")
    while text.startswith("./"):
        text = text[2:]
    path = PurePosixPath(text)
    if path.is_absolute() or not text or any(part in {"", ".", ".."} for part in path.parts):
        raise DshCompatibilityError(f"{label} escapes the package root")
    return path.as_posix()


def _normalize_tar_name(name: str) -> str:
    if not isinstance(name, str) or "\x00" in name or "\\" in name:
        raise DshCompatibilityError("archive contains a non-portable member name")
    if name.startswith("/") or WINDOWS_DRIVE_RE.match(name):
        raise DshCompatibilityError(f"archive member is absolute: {name!r}")
    parts = [part for part in name.split("/") if part not in {"", "."}]
    if any(part == ".." for part in parts):
        raise DshCompatibilityError(f"archive member escapes its root: {name!r}")
    if not parts:
        return ""
    return PurePosixPath(*parts).as_posix()


def _inventory_digest(inventory: Iterable[Mapping[str, Any]]) -> str:
    digest = hashlib.sha256()
    digest.update(b"sophia-dsh-package-inventory-v1\0")
    for item in sorted(inventory, key=lambda row: str(row["path"])):
        digest.update(str(item["path"]).encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(item["size"]).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(item["sha256"]).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def _inventory_map(inventory: Iterable[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        str(item["path"]): {
            "path": str(item["path"]),
            "size": int(item["size"]),
            "sha256": str(item["sha256"]),
        }
        for item in inventory
    }


def _npm_dependency_map(value: Any, label: str) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise DshCompatibilityError(f"{label} must be an object")
    if len(value) > MAX_DEPENDENCIES:
        raise DshCompatibilityError(
            f"{label} exceeds {MAX_DEPENDENCIES} dependency entries"
        )
    output: dict[str, str] = {}
    for name, spec in value.items():
        if not isinstance(name, str) or not PACKAGE_NAME_RE.fullmatch(name):
            raise DshCompatibilityError(f"{label} contains invalid package name {name!r}")
        if not isinstance(spec, str) or not spec.strip() or len(spec) > 1024:
            raise DshCompatibilityError(
                f"{label}[{name!r}] must be a non-empty version/spec string"
            )
        output[name] = spec.strip()
    return dict(sorted(output.items()))


def _package_file_patterns(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_PACKAGE_FILES:
        raise DshCompatibilityError(
            f"package.json files must be an array of at most {MAX_PACKAGE_FILES} strings"
        )
    result: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip() or len(item) > 1024:
            raise DshCompatibilityError(
                f"package.json files[{index}] must be a non-empty string"
            )
        pattern = item.strip()
        candidate = pattern[1:] if pattern.startswith("!") else pattern
        if (
            "\x00" in candidate
            or "\\" in candidate
            or candidate.startswith("/")
            or WINDOWS_DRIVE_RE.match(candidate)
            or ".." in PurePosixPath(candidate).parts
        ):
            raise DshCompatibilityError(
                f"package.json files[{index}] is not package-root relative"
            )
        if pattern not in result:
            result.append(pattern)
    return result


def _pattern_matches_file(pattern: str, relative: str) -> bool:
    pattern = pattern.lstrip("./")
    if not pattern:
        return False
    if fnmatch.fnmatchcase(relative, pattern):
        return True
    literal_prefix = pattern.rstrip("/")
    if not any(char in literal_prefix for char in "*?["):
        return relative == literal_prefix or relative.startswith(literal_prefix + "/")
    return False


def _declared_files_include(relative: str, patterns: list[str]) -> bool:
    if not patterns:
        return True
    included = False
    for pattern in patterns:
        excluded = pattern.startswith("!")
        body = pattern[1:] if excluded else pattern
        if _pattern_matches_file(body, relative):
            included = not excluded
    return included


def _client_export_path(manifest: Mapping[str, Any]) -> str | None:
    exports = manifest.get("exports")
    if not isinstance(exports, dict) or "./client" not in exports:
        return None
    value: Any = exports["./client"]
    if isinstance(value, str):
        return _safe_relative_path(value, "package.json exports['./client']")
    if not isinstance(value, dict):
        raise DshCompatibilityError(
            "package.json exports['./client'] must be a string or object"
        )
    for key in ("default", "import", "browser"):
        target = value.get(key)
        if isinstance(target, str):
            return _safe_relative_path(
                target, f"package.json exports['./client'].{key}"
            )
    raise DshCompatibilityError(
        "package.json exports['./client'] has no supported string target"
    )


def _source_display(source: str | Path) -> str:
    return str(source)


def _source_catalog_id(source: str | Path) -> str:
    digest = hashlib.sha256(_source_display(source).encode("utf-8")).hexdigest()[:24]
    return f"source-{digest}"


def _exact_registry_release(source: str) -> tuple[str, str] | None:
    """Return an exact npm name/version pair or reject every mutable spec."""
    if not isinstance(source, str) or not source or any(
        character.isspace() for character in source
    ):
        return None
    separator = source.rfind("@")
    if separator <= 0:
        return None
    name = source[:separator]
    version = source[separator + 1 :]
    if not PACKAGE_NAME_RE.fullmatch(name) or not VERSION_RE.fullmatch(version):
        return None
    return name, version


def _workspace_mutex(path: Path) -> threading.RLock:
    key = str(path)
    with _WORKSPACE_MUTEXES_GUARD:
        return _WORKSPACE_MUTEXES.setdefault(key, threading.RLock())


def _set_private_fd_mode(fd: int) -> None:
    """Apply POSIX descriptor permissions when the platform exposes fchmod."""
    fchmod = getattr(os, "fchmod", None)
    if callable(fchmod):
        fchmod(fd, 0o600)


def _acquire_advisory_lock(
    fd: int,
    *,
    timeout_seconds: float,
    platform_name: str | None = None,
    windows_api: Any | None = None,
    posix_api: Any | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    sleeper: Callable[[float], None] = time.sleep,
) -> None:
    """Acquire one byte/file lock with a bounded nonblocking retry loop."""
    platform_value = os.name if platform_name is None else platform_name
    deadline = monotonic() + timeout_seconds
    while True:
        try:
            if platform_value == "nt":
                api = msvcrt if windows_api is None else windows_api
                if api is None:
                    raise DshCompatibilityError(
                        "Windows mutation locking is unavailable"
                    )
                os.lseek(fd, 0, os.SEEK_SET)
                api.locking(fd, api.LK_NBLCK, 1)
            else:
                api = fcntl if posix_api is None else posix_api
                if api is None:
                    raise DshCompatibilityError(
                        "POSIX mutation locking is unavailable"
                    )
                api.flock(fd, api.LOCK_EX | api.LOCK_NB)
            return
        except OSError as exc:
            if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise
            now = monotonic()
            if now >= deadline:
                raise DshCompatibilityError(
                    "timed out waiting for the workspace mutation lock"
                ) from exc
            sleeper(min(0.05, max(0.0, deadline - now)))


def _release_advisory_lock(
    fd: int,
    *,
    platform_name: str | None = None,
    windows_api: Any | None = None,
    posix_api: Any | None = None,
) -> None:
    platform_value = os.name if platform_name is None else platform_name
    if platform_value == "nt":
        api = msvcrt if windows_api is None else windows_api
        if api is None:
            return
        os.lseek(fd, 0, os.SEEK_SET)
        api.locking(fd, api.LK_UNLCK, 1)
    else:
        api = fcntl if posix_api is None else posix_api
        if api is not None:
            api.flock(fd, api.LOCK_UN)


def _url_origin(url: str) -> tuple[str, str, int]:
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.casefold()
    hostname = (parsed.hostname or "").casefold()
    if scheme not in {"http", "https"} or not hostname:
        raise DshCompatibilityError("registry URL must be absolute HTTP(S)")
    if parsed.username is not None or parsed.password is not None:
        raise DshCompatibilityError(
            "registry URLs containing credentials are not supported"
        )
    try:
        port = parsed.port
    except ValueError as exc:
        raise DshCompatibilityError("registry URL has an invalid port") from exc
    return scheme, hostname, port or (443 if scheme == "https" else 80)


def _is_loopback_host(hostname: str) -> bool:
    if hostname.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _validate_registry_http_url(
    url: str,
    *,
    label: str,
    expected_origin: tuple[str, str, int] | None = None,
) -> str:
    if not isinstance(url, str) or not url or len(url) > 8192 or "\x00" in url:
        raise DshCompatibilityError(f"{label} URL is invalid")
    parsed = urllib.parse.urlsplit(url)
    origin = _url_origin(url)
    if parsed.fragment:
        raise DshCompatibilityError(f"{label} URL must not contain a fragment")
    if origin[0] == "http" and not _is_loopback_host(origin[1]):
        raise DshCompatibilityError(
            f"{label} URL must use HTTPS unless it is loopback"
        )
    if expected_origin is not None and origin != expected_origin:
        raise DshCompatibilityError(
            f"{label} URL must remain on the configured registry origin"
        )
    return urllib.parse.urlunsplit(parsed)


class _ConstrainedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Allow only bounded same-origin redirects for one HTTP request chain."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        target = urllib.parse.urljoin(req.full_url, newurl)
        if _url_origin(target) != _url_origin(req.full_url):
            raise urllib.error.HTTPError(
                req.full_url,
                code,
                "cross-origin redirect rejected",
                headers,
                fp,
            )
        count = int(getattr(req, "_sophia_redirect_count", 0))
        if count >= MAX_HTTP_REDIRECTS:
            raise urllib.error.HTTPError(
                req.full_url,
                code,
                "redirect limit exceeded",
                headers,
                fp,
            )
        redirected = super().redirect_request(req, fp, code, msg, headers, target)
        if redirected is not None:
            setattr(redirected, "_sophia_redirect_count", count + 1)
        return redirected


def _serialized_state(
    method: Callable[..., Any],
) -> Callable[..., Any]:
    @functools.wraps(method)
    def wrapped(self: "DshCompatibilityManager", *args: Any, **kwargs: Any) -> Any:
        try:
            with self._state_guard():
                return method(self, *args, **kwargs)
        except DshCompatibilityError as exc:
            if method.__name__ == "health":
                return {
                    "healthy": False,
                    "status": "blocked",
                    "lockIntegrity": False,
                    "issues": [str(exc)],
                    "packages": [],
                    "candidateOnly": True,
                    "canClaimAGI": False,
                }
            raise

    return wrapped


@dataclass(frozen=True)
class _SourceSnapshot:
    source: str
    kind: str
    path: Path
    inventory: tuple[dict[str, Any], ...]
    package_sha256: str
    manifest_bytes: bytes
    archive_sha256: str | None = None
    tar_prefix: str = ""
    requested_spec: str | None = None
    resolved_package: str | None = None
    resolved_version: str | None = None
    npm_integrity: str | None = None
    network_fetched: bool = False


@dataclass(frozen=True)
class _BridgeSnapshot:
    source_root: Path
    entrypoint: str
    inventory: tuple[dict[str, Any], ...]
    sha256: str


class DshCompatibilityManager:
    """Workspace-scoped DSH compatibility catalog and private installer."""

    def __init__(
        self,
        workspace: str | Path,
        *,
        state_root: str | Path | None = None,
        max_package_files: int = MAX_PACKAGE_FILES,
        max_package_bytes: int = MAX_PACKAGE_BYTES,
        npm_executable: str | Path | None = None,
        npm_timeout_seconds: float | None = None,
        max_npm_output_bytes: int | None = None,
        registry_url: str | None = None,
        operation_timeout_seconds: float | None = None,
        max_registry_metadata_bytes: int = MAX_REGISTRY_METADATA_BYTES,
        max_archive_bytes: int = MAX_ARCHIVE_BYTES,
        bridge_source_root: str | Path | None = None,
        bridge_entrypoint: str = DEFAULT_BRIDGE_ENTRYPOINT,
        integrity_policy: PluginIntegrityPolicy | None = None,
        publisher_trust_path: str | Path | None = None,
        transaction_phase_hook: Callable[[str], None] | None = None,
    ):
        workspace_path = Path(workspace).expanduser()
        if workspace_path.is_symlink():
            raise DshCompatibilityError("workspace must not be a symlink")
        try:
            self.workspace = workspace_path.resolve(strict=True)
        except OSError as exc:
            raise DshCompatibilityError("workspace does not exist") from exc
        if not self.workspace.is_dir():
            raise DshCompatibilityError("workspace must be a directory")
        self.workspace_hash = hashlib.sha256(
            str(self.workspace).encode("utf-8")
        ).hexdigest()
        self.state_root = (
            Path(state_root).expanduser().resolve()
            if state_root is not None
            else user_state_dir()
        )
        self.private_root = (
            self.state_root
            / "dsh-plugin-compat"
            / "workspaces"
            / self.workspace_hash
        )
        self.max_package_files = int(max_package_files)
        self.max_package_bytes = int(max_package_bytes)
        if not 1 <= self.max_package_files <= MAX_PACKAGE_FILES:
            raise ValueError(f"max_package_files must be between 1 and {MAX_PACKAGE_FILES}")
        if not 1 <= self.max_package_bytes <= MAX_PACKAGE_BYTES:
            raise ValueError(f"max_package_bytes must be between 1 and {MAX_PACKAGE_BYTES}")
        # Legacy npm parameters remain accepted for callers of the earlier
        # beta API, but no npm process is started. The old timeout/output
        # values act only as aliases for the bounded direct-registry client.
        if npm_executable is not None:
            legacy_npm = str(npm_executable)
            if not legacy_npm or "\x00" in legacy_npm:
                raise ValueError(
                    "npm_executable must be a non-empty command or path"
                )
        timeout_value = (
            operation_timeout_seconds
            if operation_timeout_seconds is not None
            else (
                npm_timeout_seconds
                if npm_timeout_seconds is not None
                else DEFAULT_OPERATION_TIMEOUT_SECONDS
            )
        )
        self.operation_timeout_seconds = float(timeout_value)
        if not 0.1 <= self.operation_timeout_seconds <= 300:
            raise ValueError(
                "operation_timeout_seconds must be between 0.1 and 300"
            )
        metadata_limit = (
            max_npm_output_bytes
            if max_npm_output_bytes is not None
            else max_registry_metadata_bytes
        )
        self.max_registry_metadata_bytes = int(metadata_limit)
        if not 1024 <= self.max_registry_metadata_bytes <= (
            4 * MAX_REGISTRY_METADATA_BYTES
        ):
            raise ValueError(
                "max_registry_metadata_bytes must be between 1024 and 4194304"
            )
        self.max_archive_bytes = int(max_archive_bytes)
        if not 1024 <= self.max_archive_bytes <= MAX_ARCHIVE_BYTES:
            raise ValueError(
                f"max_archive_bytes must be between 1024 and {MAX_ARCHIVE_BYTES}"
            )
        configured_registry = (
            registry_url
            or os.environ.get("SOPHIA_NPM_REGISTRY_URL")
            or DEFAULT_REGISTRY_URL
        )
        validated_registry = _validate_registry_http_url(
            configured_registry,
            label="npm registry",
        )
        parsed_registry = urllib.parse.urlsplit(validated_registry)
        if parsed_registry.query or parsed_registry.fragment:
            raise ValueError("registry_url must not contain query or fragment")
        registry_path = parsed_registry.path or "/"
        if not registry_path.endswith("/"):
            registry_path += "/"
        self.registry_url = urllib.parse.urlunsplit(
            (
                parsed_registry.scheme,
                parsed_registry.netloc,
                registry_path,
                "",
                "",
            )
        )
        self.registry_origin = _url_origin(self.registry_url)
        proxy_handler = (
            urllib.request.ProxyHandler({})
            if _is_loopback_host(self.registry_origin[1])
            else urllib.request.ProxyHandler()
        )
        self._http_opener = urllib.request.build_opener(
            proxy_handler,
            _ConstrainedRedirectHandler(),
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
                else (self.state_root / "plugins" / "publishers.json").absolute()
            )
        )
        default_bridge_root = (
            Path(__file__).resolve().parents[1]
            / "plugins"
            / "deepseek-harness-compat"
        )
        self.bridge_source_root = (
            Path(bridge_source_root).expanduser()
            if bridge_source_root is not None
            else default_bridge_root
        )
        self.bridge_entrypoint = _safe_relative_path(
            bridge_entrypoint,
            "Sophia Cordis bridge entrypoint",
        )
        if not self.bridge_entrypoint.casefold().endswith((".js", ".mjs")):
            raise ValueError("bridge_entrypoint must be a relative .js/.mjs file")

        self.catalog_path = self.private_root / "catalog.json"
        self.lock_path = self.private_root / "sophia-dsh-compat.lock.json"
        self.objects_dir = self.private_root / "objects"
        self.staging_dir = self.private_root / "staging"
        self.receipts_dir = self.private_root / "receipts"
        self.events_dir = self.private_root / "events"
        self.events_jsonl = self.private_root / "events.jsonl"
        self.transactions_path = self.private_root / "transactions.json"
        self.authority_path = self.private_root / "authority.json"
        self.mutation_lock_path = self.private_root / ".mutation.lock"
        self._process_mutex = _workspace_mutex(self.private_root)
        self._guard_local = threading.local()
        self._state_ready = False
        self._transaction_phase_hook = transaction_phase_hook
        self._initialize_private_root()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    @_serialized_state
    def discover(self, source: str | Path) -> dict[str, Any]:
        """Inspect local package metadata without importing or executing it."""
        record, _snapshot = self._discover_internal(source)
        self._upsert_catalog(record)
        self._record_operation(
            "discover",
            record["status"],
            record["id"],
            {"source": record["source"], "statuses": record["statuses"]},
        )
        return copy.deepcopy(record)

    @_serialized_state
    def install(
        self,
        source: str | Path,
        approve: bool = False,
    ) -> dict[str, Any]:
        """Install one approved prebuilt DSH bundle into the private profile.

        Local sources are copied directly.  Only an immutable exact npm
        registry release (``name@x.y.z``) may be fetched after explicit
        approval. Git/GitHub/URL/tag/range specs are rejected before any
        registry request, and npm is never invoked.
        """
        catalog_at_start = self._read_catalog() if approve is True else None
        record, snapshot = self._discover_internal(source)
        prior_catalog_entry = copy.deepcopy(
            self._read_catalog()["entries"].get(str(record["id"]))
        )
        if approve is not True:
            self._upsert_catalog(record)
        external = (
            snapshot is None
            and record.get("sourceKind") == "registry-or-network"
            and record.get("fetchState") == "external/unfetched"
        )
        if approve is not True:
            if not external and record.get("status") != "installable-prebuilt":
                self._record_operation(
                    "install",
                    "blocked",
                    record["id"],
                    {
                        "sourceStatus": record.get("status"),
                        "issues": record.get("issues", []),
                        "installed": False,
                    },
                )
                raise DshCompatibilityError(
                    f"DSH package is not installable: {record['status']}"
                    + (
                        f" ({'; '.join(record.get('issues') or [])})"
                        if record.get("issues")
                        else ""
                    )
                )
            self._record_operation(
                "install",
                "blocked",
                record["id"],
                {
                    "reason": "explicit approval required",
                    "requestedSpec": record.get("requestedSpec"),
                    "installed": False,
                },
            )
            raise DshApprovalRequired(record)

        fetch_root: Path | None = None
        try:
            if external:
                try:
                    fetch_root, snapshot = self._fetch_external_snapshot(str(source))
                except DshCompatibilityError as exc:
                    failed = copy.deepcopy(record)
                    failed["status"] = "blocked"
                    failed["statuses"] = ["discovered", "blocked"]
                    failed["issues"] = [str(exc)]
                    failed["approvalRequired"] = False
                    self._upsert_catalog(failed)
                    self._record_operation(
                        "install",
                        "blocked",
                        failed["id"],
                        {
                            "requestedSpec": failed.get("requestedSpec"),
                            "networkFetched": False,
                            "issues": failed["issues"],
                        },
                    )
                    raise
                try:
                    record = self._record_from_snapshot(snapshot)
                except DshCompatibilityError as exc:
                    failed = copy.deepcopy(record)
                    failed["status"] = "blocked"
                    failed["statuses"] = ["discovered", "blocked"]
                    failed["issues"] = [str(exc)]
                    failed["approvalRequired"] = False
                    failed["networkFetched"] = True
                    failed["fetchState"] = "approved/fetched"
                    failed["sourceKind"] = snapshot.kind
                    failed["source"] = snapshot.source
                    failed["resolvedPackage"] = snapshot.resolved_package
                    failed["resolvedVersion"] = snapshot.resolved_version
                    failed["archiveSha256"] = snapshot.archive_sha256
                    failed["npmIntegrity"] = snapshot.npm_integrity
                    self._upsert_catalog(failed)
                    self._record_operation(
                        "install",
                        "blocked",
                        failed["id"],
                        {
                            "requestedSpec": failed.get("requestedSpec"),
                            "networkFetched": True,
                            "archiveSha256": failed.get("archiveSha256"),
                            "issues": failed["issues"],
                        },
                    )
                    raise
                prior_catalog_entry = copy.deepcopy(
                    self._read_catalog()["entries"].get(str(record["id"]))
                )

            if snapshot is None or record["status"] in {
                "blocked",
                "quarantined",
                "external-runtime-only",
            }:
                self._record_operation(
                    "install",
                    "blocked",
                    record["id"],
                    {
                        "sourceStatus": record["status"],
                        "requestedSpec": record.get("requestedSpec"),
                        "resolvedPackage": record.get("resolvedPackage"),
                        "resolvedVersion": record.get("resolvedVersion"),
                        "archiveSha256": record.get("archiveSha256"),
                        "npmIntegrity": record.get("npmIntegrity"),
                        "issues": record.get("issues", []),
                    },
                )
                raise DshCompatibilityError(
                    f"DSH package is not installable: {record['status']}"
                    + (
                        f" ({'; '.join(record.get('issues') or [])})"
                        if record.get("issues")
                        else ""
                    )
                )
            if record["status"] != "installable-prebuilt":
                raise DshCompatibilityError(
                    f"unsupported DSH installation status: {record['status']}"
                )

            try:
                bridge_snapshot = self._snapshot_bridge()
            except DshCompatibilityError as exc:
                failed = copy.deepcopy(record)
                failed["status"] = "blocked"
                failed["statuses"] = [
                    value
                    for value in failed.get("statuses", [])
                    if value != "installable-prebuilt"
                ] + ["blocked"]
                failed["installable"] = False
                failed["approvalRequired"] = False
                failed["issues"] = list(failed.get("issues") or []) + [
                    f"Sophia Cordis bridge dependency closure is unavailable: {exc}"
                ]
                self._upsert_catalog(failed)
                self._record_operation(
                    "install",
                    "blocked",
                    failed["id"],
                    {
                        "sourceStatus": record["status"],
                        "issues": failed["issues"],
                        "installed": False,
                    },
                )
                raise DshCompatibilityError(failed["issues"][-1]) from exc

            lock = self._read_lock_required()
            lock_before_state = copy.deepcopy(lock)
            object_sha256 = _sha256_bytes(
                _canonical_json_bytes(
                    {
                        "packageSha256": snapshot.package_sha256,
                        "bridgeSha256": bridge_snapshot.sha256,
                    }
                )
            )
            final_object = self.objects_dir / object_sha256
            object_created = False
            if final_object.exists():
                self._verify_existing_object(
                    final_object,
                    record,
                    bridge_snapshot,
                )
            else:
                self._materialize_object(
                    snapshot,
                    record,
                    bridge_snapshot,
                    final_object,
                )
                object_created = True

            profile_root = final_object / "runtime"
            profile_dir = (
                profile_root / "profiles" / str(record["profileName"])
            )
            package_root = (
                profile_dir / self._node_modules_relative(record["name"])
            )
            installation = {
                "id": record["id"],
                "name": record["name"],
                "version": record["version"],
                "source": record["source"],
                "sourceKind": record["sourceKind"],
                "requestedSpec": record.get("requestedSpec"),
                "resolvedPackage": record["resolvedPackage"],
                "resolvedVersion": record["resolvedVersion"],
                "npmIntegrity": record.get("npmIntegrity"),
                "sha256": record["sha256"],
                "archiveSha256": record.get("archiveSha256"),
                "objectSha256": object_sha256,
                "bridgeSha256": bridge_snapshot.sha256,
                "bridgeEntrypoint": bridge_snapshot.entrypoint,
                "bridgeInventory": [
                    copy.deepcopy(item) for item in bridge_snapshot.inventory
                ],
                "installedRoot": str(package_root),
                "profileRoot": str(profile_root),
                "profileDir": str(profile_dir),
                "profileName": record["profileName"],
                "bundlePatch": record["bundlePatch"],
                "inventory": copy.deepcopy(record["inventory"]),
                "statuses": list(record["statuses"]),
                "status": record["status"],
                "conformance": None,
                "installedAt": _now_iso(),
                "lifecycleScriptsDisabled": True,
                "networkFetched": bool(record["networkFetched"]),
                "integrity": copy.deepcopy(record["integrity"]),
                "trusted": bool(record["trusted"]),
                "trustClaims": list(record["trustClaims"]),
                "candidateOnly": True,
                "canClaimAGI": False,
            }
            installations = {
                item["id"]: item
                for item in lock.get("installations", [])
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            previous_installation = installations.get(record["id"])
            previous_quarantine = next(
                (
                    copy.deepcopy(item)
                    for item in lock.get("legacyQuarantine", [])
                    if isinstance(item, dict)
                    and item.get("id") == record["id"]
                ),
                None,
            )
            installations[record["id"]] = installation
            lock["installations"] = [
                installations[key] for key in sorted(installations)
            ]
            lock["legacyQuarantine"] = [
                item
                for item in lock.get("legacyQuarantine", [])
                if isinstance(item, dict) and item.get("id") != record["id"]
            ]

            installed = copy.deepcopy(record)
            installed["installed"] = True
            installed["installationState"] = "installed"
            installed["installedRoot"] = str(package_root)
            installed["profileRoot"] = str(profile_root)
            installed["profileDir"] = str(profile_dir)
            installed["bridgeSha256"] = bridge_snapshot.sha256
            installed["bridgeEntrypoint"] = bridge_snapshot.entrypoint
            installed["runtimeConfig"] = str(profile_dir / "bridge.json")
            installed["approvalRequired"] = False
            transaction_state = self._read_transactions()
            prior_rollback_point = copy.deepcopy(
                transaction_state["rollbackPoints"].get(str(record["id"]))
            )
            identical_reinstall = (
                previous_installation is not None
                and previous_installation.get("objectSha256")
                == installation.get("objectSha256")
            )
            rollback_point = (
                copy.deepcopy(prior_rollback_point)
                if identical_reinstall
                else (
                    {
                        "installation": copy.deepcopy(previous_installation),
                        "catalogEntry": self._catalog_entry_for_installation(
                            previous_installation,
                            prior_catalog_entry,
                        ),
                    }
                    if previous_installation is not None
                    else None
                )
            )
            catalog_before_state = (
                copy.deepcopy(catalog_at_start)
                if catalog_at_start is not None
                else self._read_catalog()
            )
            lifecycle_authority_nonce: str | None = None
            try:
                lifecycle_authority_nonce = (
                    self._rotate_authority_nonce_locked(str(record["id"]))
                )
                transaction_id = self._begin_transaction(
                    plugin_id=str(record["id"]),
                    action=(
                        "update"
                        if previous_installation is not None
                        else "install"
                    ),
                    previous=previous_installation,
                    target=installation,
                    before_lock=lock_before_state,
                    before_catalog=catalog_before_state,
                )
            except Exception as exc:
                if object_created:
                    protected = [
                        item
                        for item in (
                            previous_installation,
                            (
                                prior_rollback_point.get("installation")
                                if isinstance(prior_rollback_point, dict)
                                else None
                            ),
                        )
                        if isinstance(item, dict)
                    ]
                    self._remove_unreferenced_object(installation, protected)
                if lifecycle_authority_nonce is not None:
                    raise _lifecycle_authority_error(
                        "DSH compatibility install/update failed after "
                        "lifecycle authority rotation",
                        plugin_id=str(record["id"]),
                        nonce=lifecycle_authority_nonce,
                    ) from exc
                raise
            try:
                self._transaction_phase("after_journal")
                self._write_lock(lock)
                self._transaction_phase("after_lock")
                self._upsert_catalog(installed)
                self._transaction_phase("after_catalog")
                self._finish_transaction(
                    transaction_id,
                    status="committed",
                    rollback_point=rollback_point,
                )
            except Exception as exc:
                self._restore_state_snapshots(
                    lock_before_state,
                    catalog_before_state,
                )
                try:
                    self._finish_transaction(
                        transaction_id,
                        status="rolled-back",
                        error=f"{type(exc).__name__}: {exc}",
                    )
                except Exception:
                    pass
                if object_created:
                    protected = [
                        item
                        for item in (
                            previous_installation,
                            (
                                prior_rollback_point.get("installation")
                                if isinstance(prior_rollback_point, dict)
                                else None
                            ),
                        )
                        if isinstance(item, dict)
                    ]
                    self._remove_unreferenced_object(installation, protected)
                raise _lifecycle_authority_error(
                    "DSH compatibility install/update transaction rolled back",
                    plugin_id=str(record["id"]),
                    nonce=lifecycle_authority_nonce,
                ) from exc

            try:
                self._transaction_phase("after_completion")
                if (
                    not identical_reinstall
                    and isinstance(prior_rollback_point, dict)
                ):
                    prior_rollback_installation = prior_rollback_point.get(
                        "installation"
                    )
                    if isinstance(prior_rollback_installation, dict):
                        protected = [installation]
                        if previous_installation is not None:
                            protected.append(previous_installation)
                        self._remove_unreferenced_object(
                            prior_rollback_installation,
                            protected,
                        )
                if isinstance(previous_quarantine, dict):
                    quarantined_installation = previous_quarantine.get(
                        "installation"
                    )
                    if isinstance(quarantined_installation, dict):
                        protected = [installation]
                        if previous_installation is not None:
                            protected.append(previous_installation)
                        if isinstance(rollback_point, dict) and isinstance(
                            rollback_point.get("installation"),
                            dict,
                        ):
                            protected.append(rollback_point["installation"])
                        self._remove_unreferenced_object(
                            quarantined_installation,
                            protected,
                        )
                self._record_operation(
                    "install",
                    installed["status"],
                    installed["id"],
                    {
                        "requestedSpec": installed.get("requestedSpec"),
                        "resolvedPackage": installed["resolvedPackage"],
                        "resolvedVersion": installed["resolvedVersion"],
                        "sha256": installed["sha256"],
                        "archiveSha256": installed.get("archiveSha256"),
                        "npmIntegrity": installed.get("npmIntegrity"),
                        "networkFetched": installed["networkFetched"],
                        "installedRoot": installed["installedRoot"],
                        "profileRoot": installed["profileRoot"],
                        "profileDir": installed["profileDir"],
                        "bridgeSha256": installed["bridgeSha256"],
                        "lifecycleScriptsDisabled": True,
                        "integrity": copy.deepcopy(installed["integrity"]),
                    },
                )
                installed["_lifecycleAuthorityNonce"] = (
                    lifecycle_authority_nonce
                )
                return installed
            except Exception as exc:
                raise _lifecycle_authority_error(
                    "DSH compatibility install/update committed but result "
                    "finalization failed",
                    plugin_id=str(record["id"]),
                    nonce=lifecycle_authority_nonce,
                ) from exc
        finally:
            if (
                fetch_root is not None
                and fetch_root.exists()
                and self._is_within_private_root(fetch_root)
            ):
                shutil.rmtree(fetch_root, ignore_errors=True)

    @_serialized_state
    def uninstall(self, id: str) -> dict[str, Any]:
        """Remove an installed package from this workspace's private lock."""
        plugin_id = self._normalize_id(id)
        lock = self._read_lock_required()
        lock_before_state = copy.deepcopy(lock)
        installations = [
            item
            for item in lock.get("installations", [])
            if isinstance(item, dict)
        ]
        target = next(
            (item for item in installations if item.get("id") == plugin_id),
            None,
        )
        quarantined = next(
            (
                item
                for item in lock.get("legacyQuarantine", [])
                if isinstance(item, dict) and item.get("id") == plugin_id
            ),
            None,
        )
        if target is None and quarantined is None:
            raise KeyError(f"DSH compatibility package is not installed: {plugin_id}")
        removed_installation = (
            target
            if target is not None
            else copy.deepcopy(quarantined["installation"])
        )
        remaining = [item for item in installations if item.get("id") != plugin_id]
        lock["installations"] = remaining
        lock["legacyQuarantine"] = [
            item
            for item in lock.get("legacyQuarantine", [])
            if isinstance(item, dict) and item.get("id") != plugin_id
        ]
        catalog = self._read_catalog()
        catalog_before_state = copy.deepcopy(catalog)
        prior = catalog["entries"].get(plugin_id)
        if isinstance(prior, dict):
            prior = copy.deepcopy(prior)
            prior["installed"] = False
            prior["installationState"] = "not-installed"
            for key in (
                "installedRoot",
                "profileRoot",
                "profileDir",
                "runtimeConfig",
                "bridgeSha256",
                "bridgeEntrypoint",
            ):
                prior.pop(key, None)
            catalog["entries"][plugin_id] = prior
        transaction_state = self._read_transactions()
        prior_rollback_point = copy.deepcopy(
            transaction_state["rollbackPoints"].get(plugin_id)
        )
        lifecycle_authority_nonce = (
            self._rotate_authority_nonce_locked(plugin_id)
        )
        try:
            transaction_id = self._begin_transaction(
                plugin_id=plugin_id,
                action="uninstall",
                previous=removed_installation,
                target=None,
                before_lock=lock_before_state,
                before_catalog=catalog_before_state,
            )
        except Exception as exc:
            raise _lifecycle_authority_error(
                "DSH compatibility uninstall failed after lifecycle "
                "authority rotation",
                plugin_id=plugin_id,
                nonce=lifecycle_authority_nonce,
            ) from exc
        try:
            self._transaction_phase("after_journal")
            self._write_lock(lock)
            self._transaction_phase("after_lock")
            self._write_catalog(catalog)
            self._transaction_phase("after_catalog")
            self._finish_transaction(
                transaction_id,
                status="committed",
                rollback_point=None,
            )
        except Exception as exc:
            self._restore_state_snapshots(
                lock_before_state,
                catalog_before_state,
            )
            try:
                self._finish_transaction(
                    transaction_id,
                    status="rolled-back",
                    error=f"{type(exc).__name__}: {exc}",
                )
            except Exception:
                pass
            raise _lifecycle_authority_error(
                "DSH compatibility uninstall transaction rolled back",
                plugin_id=plugin_id,
                nonce=lifecycle_authority_nonce,
            ) from exc

        try:
            self._transaction_phase("after_completion")
            self._remove_unreferenced_object(removed_installation, remaining)
            if isinstance(prior_rollback_point, dict):
                rollback_installation = prior_rollback_point.get("installation")
                if isinstance(rollback_installation, dict):
                    self._remove_unreferenced_object(
                        rollback_installation,
                        remaining,
                    )
            result = {
                "id": plugin_id,
                "uninstalled": True,
                "installed": False,
                "candidateOnly": True,
                "canClaimAGI": False,
                "_lifecycleAuthorityNonce": lifecycle_authority_nonce,
            }
            self._record_operation("uninstall", "discovered", plugin_id, result)
            return result
        except Exception as exc:
            raise _lifecycle_authority_error(
                "DSH compatibility uninstall committed but result "
                "finalization failed",
                plugin_id=plugin_id,
                nonce=lifecycle_authority_nonce,
            ) from exc

    @_serialized_state
    def rollback(self, id: str) -> dict[str, Any]:
        """Atomically swap an installation with its last committed version."""
        plugin_id = self._normalize_id(id)
        lock = self._read_lock_required()
        lock_before_state = copy.deepcopy(lock)
        installations = {
            str(item["id"]): item
            for item in lock.get("installations", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        current = installations.get(plugin_id)
        if current is None:
            raise KeyError(f"DSH compatibility package is not installed: {plugin_id}")
        transaction_state = self._read_transactions()
        rollback_point = transaction_state["rollbackPoints"].get(plugin_id)
        if not isinstance(rollback_point, dict):
            raise DshCompatibilityError(
                f"DSH compatibility package has no rollback point: {plugin_id}"
            )
        target = copy.deepcopy(rollback_point["installation"])
        health = self._health_installation(target)
        if not health["healthy"]:
            raise DshCompatibilityError(
                "DSH compatibility rollback target failed integrity checks"
            )

        catalog = self._read_catalog()
        catalog_before_state = copy.deepcopy(catalog)
        current_catalog = self._catalog_entry_for_installation(
            current,
            catalog["entries"].get(plugin_id),
        )
        target_catalog = self._catalog_entry_for_installation(
            target,
            rollback_point.get("catalogEntry"),
        )
        installations[plugin_id] = target
        lock["installations"] = [
            installations[key] for key in sorted(installations)
        ]
        catalog["entries"][plugin_id] = target_catalog
        lifecycle_authority_nonce = (
            self._rotate_authority_nonce_locked(plugin_id)
        )
        try:
            transaction_id = self._begin_transaction(
                plugin_id=plugin_id,
                action="rollback",
                previous=current,
                target=target,
                before_lock=lock_before_state,
                before_catalog=catalog_before_state,
            )
        except Exception as exc:
            raise _lifecycle_authority_error(
                "DSH compatibility rollback failed after lifecycle "
                "authority rotation",
                plugin_id=plugin_id,
                nonce=lifecycle_authority_nonce,
            ) from exc
        try:
            self._transaction_phase("after_journal")
            self._write_lock(lock)
            self._transaction_phase("after_lock")
            self._write_catalog(catalog)
            self._transaction_phase("after_catalog")
            self._finish_transaction(
                transaction_id,
                status="committed",
                rollback_point={
                    "installation": copy.deepcopy(current),
                    "catalogEntry": current_catalog,
                },
            )
        except Exception as exc:
            self._restore_state_snapshots(
                lock_before_state,
                catalog_before_state,
            )
            try:
                self._finish_transaction(
                    transaction_id,
                    status="rolled-back",
                    error=f"{type(exc).__name__}: {exc}",
                )
            except Exception:
                pass
            raise _lifecycle_authority_error(
                "DSH compatibility rollback transaction rolled back",
                plugin_id=plugin_id,
                nonce=lifecycle_authority_nonce,
            ) from exc

        try:
            self._transaction_phase("after_completion")
            result = copy.deepcopy(target_catalog)
            result.update(
                {
                    "rolledBack": True,
                    "fromObjectSha256": current["objectSha256"],
                    "toObjectSha256": target["objectSha256"],
                    "candidateOnly": True,
                    "canClaimAGI": False,
                    "_lifecycleAuthorityNonce": lifecycle_authority_nonce,
                }
            )
            self._record_operation(
                "rollback",
                str(target["status"]),
                plugin_id,
                {
                    "fromObjectSha256": current["objectSha256"],
                    "toObjectSha256": target["objectSha256"],
                    "version": target["version"],
                    "integrity": copy.deepcopy(target["integrity"]),
                },
            )
            return result
        except Exception as exc:
            raise _lifecycle_authority_error(
                "DSH compatibility rollback committed but result "
                "finalization failed",
                plugin_id=plugin_id,
                nonce=lifecycle_authority_nonce,
            ) from exc

    @_serialized_state
    def list(self) -> list[dict[str, Any]]:
        """Return the deterministic workspace catalog."""
        catalog = self._read_catalog()
        installed = self._installed_by_id(allow_corrupt=True)
        result: list[dict[str, Any]] = []
        for plugin_id in sorted(catalog["entries"]):
            item = copy.deepcopy(catalog["entries"][plugin_id])
            if plugin_id in installed:
                item["installed"] = True
                item["installationState"] = "installed"
                item["installedRoot"] = installed[plugin_id].get("installedRoot")
                item["profileRoot"] = installed[plugin_id].get("profileRoot")
                item["profileDir"] = installed[plugin_id].get("profileDir")
            result.append(item)
        return result

    @_serialized_state
    def inspect(self, id: str) -> dict[str, Any]:
        """Return one catalog entry plus current installed-lock state."""
        plugin_id = self._normalize_id(id)
        catalog = self._read_catalog()
        item = catalog["entries"].get(plugin_id)
        if not isinstance(item, dict):
            raise KeyError(f"DSH compatibility package not found: {plugin_id}")
        result = copy.deepcopy(item)
        installed = self._installed_by_id(allow_corrupt=True).get(plugin_id)
        if installed is not None:
            result["installed"] = True
            result["installationState"] = "installed"
            result["installedRoot"] = installed.get("installedRoot")
            result["profileRoot"] = installed.get("profileRoot")
            result["profileDir"] = installed.get("profileDir")
            result["conformance"] = copy.deepcopy(installed.get("conformance"))
            result["status"] = installed.get("status", result.get("status"))
            result["statuses"] = list(
                installed.get("statuses", result.get("statuses", []))
            )
        return result

    @_serialized_state
    def health(self, id: str | None = None) -> dict[str, Any]:
        """Verify lock self-integrity, package bytes, and generated profiles."""
        try:
            lock = self._read_lock_required()
        except DshCompatibilityError as exc:
            return {
                "healthy": False,
                "status": "blocked",
                "lockIntegrity": False,
                "issues": [str(exc)],
                "packages": [],
                "candidateOnly": True,
                "canClaimAGI": False,
            }
        installations = [
            item
            for item in lock.get("installations", [])
            if isinstance(item, dict)
        ]
        if id is not None:
            plugin_id = self._normalize_id(id)
            installations = [
                item for item in installations if item.get("id") == plugin_id
            ]
            if not installations:
                catalog_item = self._read_catalog()["entries"].get(plugin_id)
                if isinstance(catalog_item, dict):
                    return {
                        "healthy": False,
                        "status": catalog_item.get("status", "blocked"),
                        "lockIntegrity": True,
                        "issues": ["package is not installed"],
                        "packages": [],
                        "candidateOnly": True,
                        "canClaimAGI": False,
                    }
                raise KeyError(f"DSH compatibility package not found: {plugin_id}")

        package_health = [
            self._health_installation(item) for item in installations
        ]
        healthy = all(item["healthy"] for item in package_health)
        healthy_statuses = [
            str(item.get("status") or "installable-prebuilt")
            for item in package_health
        ]
        if not healthy:
            status_value = "blocked"
        elif healthy_statuses and all(
            status == "sophia-compatible" for status in healthy_statuses
        ):
            status_value = "sophia-compatible"
        elif "conformance-tested" in healthy_statuses:
            status_value = "conformance-tested"
        elif healthy_statuses:
            status_value = "installable-prebuilt"
        else:
            status_value = "discovered"
        return {
            "healthy": healthy,
            "status": status_value,
            "lockIntegrity": True,
            "issues": [
                issue
                for item in package_health
                for issue in item.get("issues", [])
            ],
            "packages": package_health,
            "workspace": str(self.workspace),
            "workspaceHash": self.workspace_hash,
            "privateRoot": str(self.private_root),
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    @_serialized_state
    def runtime_config(self, id: str) -> dict[str, Any]:
        """Return the generated, private DSH profile configuration."""
        plugin_id = self._normalize_id(id)
        installation = self._installed_by_id().get(plugin_id)
        if installation is None:
            raise KeyError(f"DSH compatibility package is not installed: {plugin_id}")
        health = self.health(plugin_id)
        if not health["healthy"]:
            raise DshCompatibilityError(
                "installed DSH compatibility package failed integrity checks"
            )
        profile_root = Path(str(installation["profileRoot"]))
        profile_dir = Path(str(installation["profileDir"]))
        package_root = Path(str(installation["installedRoot"]))
        bridge_path = profile_dir / "bridge.json"
        runtime_fields = self._runtime_contract(
            profile_root,
            profile_dir,
            str(installation["profileName"]),
            plugin_id,
        )
        status = str(installation.get("status") or "installable-prebuilt")
        return {
            **runtime_fields,
            "compatibilityId": plugin_id,
            "status": status,
            "statuses": list(installation.get("statuses") or []),
            "activationAllowed": status == "sophia-compatible",
            "packageRoot": str(package_root),
            "packageJson": str(profile_dir / "package.json"),
            "cordisPatch": str(profile_dir / "cordis.patch.yml"),
            "bridgeConfig": str(bridge_path),
            "bridgeEntrypoint": installation["bridgeEntrypoint"],
            "bridgeSha256": installation["bridgeSha256"],
            "packageSha256": installation["sha256"],
            "packageDigest": installation["sha256"],
            "lifecycleScriptsDisabled": True,
            "networkFetched": bool(installation.get("networkFetched")),
            "integrity": copy.deepcopy(installation.get("integrity")),
            "trusted": bool(installation.get("trusted")),
            "trustClaims": list(installation.get("trustClaims") or []),
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    @_serialized_state
    def authority_nonce(self, id: str) -> str:
        """Return the durable per-package lifecycle authority nonce."""
        plugin_id = self._normalize_id(id)
        nonce = self._read_authority_state()["pluginNonces"].get(plugin_id)
        if not isinstance(nonce, str):
            raise DshCompatibilityError(
                f"DSH compatibility package has no lifecycle authority: {plugin_id}"
            )
        return nonce

    @_serialized_state
    def record_conformance(
        self,
        id: str,
        result: Mapping[str, Any],
        *,
        expected_authority_nonce: str,
    ) -> dict[str, Any]:
        """Attach one bounded conformance result and update compatibility state."""
        plugin_id = self._normalize_id(id)
        if not isinstance(result, Mapping):
            raise DshCompatibilityError("conformance result must be an object")
        result_copy = copy.deepcopy(dict(result))
        passed = result_copy.get("passed")
        if not isinstance(passed, bool):
            raise DshCompatibilityError(
                "conformance result must contain an exact boolean passed field"
            )
        encoded = _canonical_json_bytes(result_copy)
        if len(encoded) > MAX_CONFORMANCE_BYTES:
            raise DshCompatibilityError(
                f"conformance result exceeds {MAX_CONFORMANCE_BYTES} bytes"
            )
        if (
            not isinstance(expected_authority_nonce, str)
            or not re.fullmatch(r"[0-9a-f]{32}", expected_authority_nonce)
        ):
            raise DshCompatibilityError(
                "conformance commit requires exact lifecycle authority"
            )
        current_nonce = self._read_authority_state()[
            "pluginNonces"
        ].get(plugin_id)
        if (
            not isinstance(current_nonce, str)
            or not hmac.compare_digest(
                current_nonce,
                expected_authority_nonce,
            )
        ):
            raise DshCompatibilityError(
                "DSH compatibility authority changed before conformance "
                "result commit"
            )
        lock = self._read_lock_required()
        lock_before_state = copy.deepcopy(lock)
        installations = {
            item["id"]: item
            for item in lock.get("installations", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        installation = installations.get(plugin_id)
        if installation is None:
            raise KeyError(f"DSH compatibility package is not installed: {plugin_id}")
        package_health = self._health_installation(installation)
        statuses = [
            value
            for value in installation.get("statuses", [])
            if value in VALID_STATUSES
            and value not in {"conformance-tested", "sophia-compatible", "quarantined"}
        ]
        statuses.append("conformance-tested")
        if passed and package_health["healthy"]:
            statuses.append("sophia-compatible")
            status_value = "sophia-compatible"
        else:
            statuses.append("quarantined")
            status_value = "quarantined"
        conformance = {
            "passed": passed,
            "recordedAt": _now_iso(),
            "resultSha256": _sha256_bytes(encoded),
            "result": result_copy,
            "packageHealthyAtRecord": package_health["healthy"],
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        installation["conformance"] = conformance
        installation["statuses"] = statuses
        installation["status"] = status_value
        installations[plugin_id] = installation
        lock["installations"] = [
            installations[key] for key in sorted(installations)
        ]
        catalog = self._read_catalog()
        catalog_before_state = copy.deepcopy(catalog)
        catalog_item = catalog["entries"].get(plugin_id)
        if isinstance(catalog_item, dict):
            catalog_item = copy.deepcopy(catalog_item)
            catalog_item["conformance"] = conformance
            catalog_item["statuses"] = statuses
            catalog_item["status"] = status_value
            catalog_item["installed"] = True
            catalog["entries"][plugin_id] = catalog_item
        lifecycle_authority_nonce = (
            self._rotate_authority_nonce_locked(plugin_id)
        )
        try:
            transaction_id = self._begin_transaction(
                plugin_id=plugin_id,
                action="conformance",
                previous=lock_before_state["installations"][
                    next(
                        index
                        for index, item in enumerate(
                            lock_before_state["installations"]
                        )
                        if item.get("id") == plugin_id
                    )
                ],
                target=installation,
                before_lock=lock_before_state,
                before_catalog=catalog_before_state,
            )
        except Exception as exc:
            raise _lifecycle_authority_error(
                "DSH compatibility conformance failed after lifecycle "
                "authority rotation",
                plugin_id=plugin_id,
                nonce=lifecycle_authority_nonce,
            ) from exc
        try:
            self._transaction_phase("after_journal")
            self._write_lock(lock)
            self._transaction_phase("after_lock")
            self._write_catalog(catalog)
            self._transaction_phase("after_catalog")
            self._finish_transaction(
                transaction_id,
                status="committed",
                rollback_point=copy.deepcopy(
                    self._read_transactions()["rollbackPoints"].get(plugin_id)
                ),
            )
        except Exception as exc:
            self._restore_state_snapshots(
                lock_before_state,
                catalog_before_state,
            )
            try:
                self._finish_transaction(
                    transaction_id,
                    status="rolled-back",
                    error=f"{type(exc).__name__}: {exc}",
                )
            except Exception:
                pass
            raise _lifecycle_authority_error(
                "DSH compatibility conformance transaction rolled back",
                plugin_id=plugin_id,
                nonce=lifecycle_authority_nonce,
            ) from exc
        try:
            self._transaction_phase("after_completion")
            output = {
                "id": plugin_id,
                "status": status_value,
                "statuses": statuses,
                "conformance": conformance,
                "integrity": copy.deepcopy(installation.get("integrity")),
                "trusted": bool(installation.get("trusted")),
                "trustClaims": list(installation.get("trustClaims") or []),
                "candidateOnly": True,
                "canClaimAGI": False,
                "_lifecycleAuthorityNonce": lifecycle_authority_nonce,
            }
            self._record_operation(
                "record-conformance",
                status_value,
                plugin_id,
                {
                    "passed": passed,
                    "packageHealthy": package_health["healthy"],
                    "resultSha256": conformance["resultSha256"],
                },
            )
            return output
        except Exception as exc:
            raise _lifecycle_authority_error(
                "DSH compatibility conformance committed but result "
                "finalization failed",
                plugin_id=plugin_id,
                nonce=lifecycle_authority_nonce,
            ) from exc

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------
    def _discover_internal(
        self, source: str | Path
    ) -> tuple[dict[str, Any], _SourceSnapshot | None]:
        display = _source_display(source)
        requested_spec = display if isinstance(source, str) else None
        base = {
            "schema": DISCOVERY_SCHEMA,
            "id": _source_catalog_id(source),
            "source": display,
            "sourceKind": "unknown",
            "requestedSpec": requested_spec,
            "resolvedPackage": None,
            "resolvedVersion": None,
            "npmIntegrity": None,
            "archiveSha256": None,
            "fetchState": "local",
            "status": "blocked",
            "statuses": ["discovered", "blocked"],
            "manifestValid": False,
            "installable": False,
            "installed": False,
            "approvalRequired": False,
            "lifecycleScriptsDisabled": True,
            "networkFetched": False,
            "trusted": False,
            "trustClaims": [],
            "issues": [],
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        if not display or len(display) > 8192 or "\x00" in display:
            base["issues"] = ["source must be a bounded non-empty string/path"]
            return base, None
        try:
            local_candidate = Path(source).expanduser()
            local_exists = local_candidate.exists()
            local_symlink = local_candidate.is_symlink()
        except (OSError, ValueError, TypeError):
            base["issues"] = ["source path/spec is malformed"]
            return base, None
        if isinstance(source, str) and not local_exists and not local_symlink:
            if _exact_registry_release(source) is not None:
                base.update(
                    {
                        "sourceKind": "registry-or-network",
                        "fetchState": "external/unfetched",
                        "status": "external-runtime-only",
                        "statuses": ["discovered", "external-runtime-only"],
                        "issues": [
                            "exact npm registry release was not fetched; "
                            "implicit network is disabled"
                        ],
                    }
                )
                return base, None
            if (
                source.startswith(
                    (
                        "npm:",
                        "git+",
                        "github:",
                        "gitlab:",
                        "bitbucket:",
                        "git@",
                        "http:",
                        "https:",
                    )
                )
                or (
                    not source.startswith((".", "/", "~"))
                    and not source.endswith((".tgz", ".tar", ".tar.gz"))
                )
            ):
                base["issues"] = [
                    "external fetch requires an immutable exact npm registry "
                    "release name@x.y.z; Git/GitHub/URL/tag/range specs are "
                    "rejected before any registry request"
                ]
                return base, None
        try:
            snapshot = self._snapshot_source(source)
            record = self._record_from_snapshot(snapshot)
            return record, snapshot
        except DshCompatibilityError as exc:
            base["issues"] = [str(exc)]
            return base, None

    def _snapshot_source(self, source: str | Path) -> _SourceSnapshot:
        raw_path = Path(source).expanduser()
        if raw_path.is_symlink():
            raise DshCompatibilityError("source path must not be a symlink")
        # Keep every lexical component intact until secure directory
        # inspection.  ``resolve()`` would silently consume a symlinked parent
        # and defeat the descriptor-relative no-follow check.
        path = Path(os.path.abspath(raw_path))
        if path.is_dir():
            inventory, manifest = self._inventory_directory(path)
            return _SourceSnapshot(
                source=str(path),
                kind="directory",
                path=path,
                inventory=tuple(inventory),
                package_sha256=_inventory_digest(inventory),
                manifest_bytes=manifest,
            )
        if path.is_file() and self._is_tarball(path):
            return self._inventory_tarball(path)
        raise DshCompatibilityError(
            "source must be a local directory or .tar/.tar.gz/.tgz archive"
        )

    def _fetch_external_snapshot(
        self, requested_spec: str
    ) -> tuple[Path, _SourceSnapshot]:
        exact_release = _exact_registry_release(requested_spec)
        if exact_release is None:
            raise DshCompatibilityError(
                "external fetch requires an immutable exact npm registry "
                "release name@x.y.z; Git/GitHub/URL/tag/range specs are "
                "rejected before any registry request"
            )
        requested_name, requested_version = exact_release
        fetch_root = Path(
            tempfile.mkdtemp(prefix=".fetch-", dir=str(self.staging_dir))
        )
        os.chmod(fetch_root, 0o700)
        try:
            deadline = time.monotonic() + self.operation_timeout_seconds
            metadata = self._resolve_registry_release(
                requested_name,
                requested_version,
                deadline=deadline,
            )
            tarball = fetch_root / "package.tgz"
            self._download_registry_archive(
                metadata["tarball"],
                tarball,
                integrity=metadata["integrity"],
                shasum=metadata["shasum"],
                deadline=deadline,
            )
            snapshot = self._inventory_tarball(tarball)
            manifest = _json_no_duplicates(snapshot.manifest_bytes, "package.json")
            manifest_name = manifest.get("name")
            manifest_version = manifest.get("version")
            if (
                manifest_name != requested_name
                or manifest_version != requested_version
            ):
                raise DshCompatibilityError(
                    "downloaded npm release identity does not match the requested "
                    "exact registry release"
                )
            return fetch_root, _SourceSnapshot(
                source=requested_spec,
                kind="remote-tarball",
                path=snapshot.path,
                inventory=snapshot.inventory,
                package_sha256=snapshot.package_sha256,
                manifest_bytes=snapshot.manifest_bytes,
                archive_sha256=snapshot.archive_sha256,
                tar_prefix=snapshot.tar_prefix,
                requested_spec=requested_spec,
                resolved_package=requested_name,
                resolved_version=requested_version,
                npm_integrity=metadata["integrity"],
                network_fetched=True,
            )
        except Exception:
            if fetch_root.exists() and self._is_within_private_root(fetch_root):
                shutil.rmtree(fetch_root, ignore_errors=True)
            raise

    def _remaining_operation_timeout(self, deadline: float) -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DshCompatibilityError(
                "approved registry fetch exceeded the configured operation timeout"
            )
        return remaining

    def _open_registry_response(
        self,
        url: str,
        *,
        label: str,
        deadline: float,
    ) -> Any:
        validated = _validate_registry_http_url(
            url,
            label=label,
            expected_origin=self.registry_origin,
        )
        request = urllib.request.Request(
            validated,
            headers={
                "Accept": "application/json"
                if label == "registry metadata"
                else "application/octet-stream",
                "Accept-Encoding": "identity",
                "User-Agent": "sophia-dsh-plugin-compat/1",
            },
            method="GET",
        )
        try:
            response = self._http_opener.open(
                request,
                timeout=self._remaining_operation_timeout(deadline),
            )
        except urllib.error.HTTPError as exc:
            detail = str(exc.reason or exc.msg or type(exc).__name__)
            raise DshCompatibilityError(
                f"{label} request failed: {detail}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise DshCompatibilityError(
                f"{label} request failed: {type(exc).__name__}"
            ) from exc
        final_url = response.geturl()
        try:
            _validate_registry_http_url(
                final_url,
                label=label,
                expected_origin=self.registry_origin,
            )
        except Exception:
            response.close()
            raise
        content_encoding = response.headers.get("Content-Encoding")
        if content_encoding not in {None, "", "identity"}:
            response.close()
            raise DshCompatibilityError(
                f"{label} uses unsupported content encoding"
            )
        return response

    @staticmethod
    def _content_length(response: Any, *, label: str) -> int | None:
        raw = response.headers.get("Content-Length")
        if raw is None:
            return None
        try:
            value = int(raw, 10)
        except (TypeError, ValueError) as exc:
            raise DshCompatibilityError(
                f"{label} returned an invalid Content-Length"
            ) from exc
        if value < 0:
            raise DshCompatibilityError(
                f"{label} returned an invalid Content-Length"
            )
        return value

    def _read_registry_body(
        self,
        response: Any,
        *,
        maximum: int,
        label: str,
        deadline: float,
    ) -> bytes:
        length = self._content_length(response, label=label)
        if length is not None and length > maximum:
            raise DshCompatibilityError(f"{label} exceeds {maximum} bytes")
        chunks: list[bytes] = []
        total = 0
        while True:
            self._remaining_operation_timeout(deadline)
            chunk = response.read(min(65_536, maximum + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > maximum:
                raise DshCompatibilityError(f"{label} exceeds {maximum} bytes")
            chunks.append(chunk)
        if length is not None and total != length:
            raise DshCompatibilityError(f"{label} response was truncated")
        return b"".join(chunks)

    @staticmethod
    def _parse_registry_integrity(value: Any) -> tuple[str, bytes, str]:
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 1024
            or "\x00" in value
            or any(character.isspace() for character in value)
            or "-" not in value
        ):
            raise DshCompatibilityError(
                "registry release has invalid dist.integrity"
            )
        algorithm, encoded = value.split("-", 1)
        expected_sizes = {"sha256": 32, "sha384": 48, "sha512": 64}
        if algorithm not in expected_sizes or not encoded:
            raise DshCompatibilityError(
                "registry release uses unsupported dist.integrity"
            )
        try:
            digest = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise DshCompatibilityError(
                "registry release has invalid dist.integrity"
            ) from exc
        if len(digest) != expected_sizes[algorithm]:
            raise DshCompatibilityError(
                "registry release has invalid dist.integrity"
            )
        return algorithm, digest, value

    def _resolve_registry_release(
        self,
        package_name: str,
        version: str,
        *,
        deadline: float,
    ) -> dict[str, str | None]:
        encoded_name = urllib.parse.quote(package_name, safe="@")
        metadata_url = urllib.parse.urljoin(self.registry_url, encoded_name)
        with self._open_registry_response(
            metadata_url,
            label="registry metadata",
            deadline=deadline,
        ) as response:
            payload = self._read_registry_body(
                response,
                maximum=self.max_registry_metadata_bytes,
                label="registry metadata",
                deadline=deadline,
            )
        raw = _json_no_duplicates(payload, "registry metadata")
        versions = raw.get("versions")
        release = versions.get(version) if isinstance(versions, dict) else None
        if (
            raw.get("name") != package_name
            or not isinstance(release, dict)
            or release.get("name") != package_name
            or release.get("version") != version
        ):
            raise DshCompatibilityError(
                "registry metadata does not contain the requested exact release"
            )
        dist = release.get("dist")
        if not isinstance(dist, dict):
            raise DshCompatibilityError(
                "registry release has no valid dist metadata"
            )
        tarball = _validate_registry_http_url(
            dist.get("tarball"),
            label="registry tarball",
            expected_origin=self.registry_origin,
        )
        _algorithm, _digest, integrity = self._parse_registry_integrity(
            dist.get("integrity")
        )
        shasum = dist.get("shasum")
        if shasum is not None and (
            not isinstance(shasum, str)
            or not re.fullmatch(r"[0-9a-f]{40}", shasum)
        ):
            raise DshCompatibilityError(
                "registry release has invalid dist.shasum"
            )
        return {
            "tarball": tarball,
            "integrity": integrity,
            "shasum": shasum,
        }

    def _download_registry_archive(
        self,
        url: str,
        destination: Path,
        *,
        integrity: str,
        shasum: str | None,
        deadline: float,
    ) -> None:
        algorithm, expected_digest, _normalized = self._parse_registry_integrity(
            integrity
        )
        digest = hashlib.new(algorithm)
        sha1 = hashlib.sha1()
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(destination, flags, 0o600)
        try:
            _set_private_fd_mode(fd)
            with self._open_registry_response(
                url,
                label="registry tarball",
                deadline=deadline,
            ) as response:
                length = self._content_length(
                    response,
                    label="registry tarball",
                )
                if length is not None and length > self.max_archive_bytes:
                    raise DshCompatibilityError(
                        f"registry tarball exceeds {self.max_archive_bytes} bytes"
                    )
                total = 0
                while True:
                    self._remaining_operation_timeout(deadline)
                    chunk = response.read(
                        min(65_536, self.max_archive_bytes + 1 - total)
                    )
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > self.max_archive_bytes:
                        raise DshCompatibilityError(
                            f"registry tarball exceeds {self.max_archive_bytes} bytes"
                        )
                    digest.update(chunk)
                    sha1.update(chunk)
                    view = memoryview(chunk)
                    while view:
                        written = os.write(fd, view)
                        view = view[written:]
                if length is not None and total != length:
                    raise DshCompatibilityError(
                        "registry tarball response was truncated"
                    )
            if not hmac.compare_digest(digest.digest(), expected_digest):
                raise DshCompatibilityError(
                    "registry tarball does not match dist.integrity"
                )
            if shasum is not None and not hmac.compare_digest(
                sha1.hexdigest(),
                shasum,
            ):
                raise DshCompatibilityError(
                    "registry tarball does not match dist.shasum"
                )
            os.fsync(fd)
        except Exception:
            os.close(fd)
            try:
                os.unlink(destination)
            except OSError:
                pass
            raise
        else:
            os.close(fd)

    @staticmethod
    def _is_tarball(path: Path) -> bool:
        lowered = path.name.casefold()
        return lowered.endswith((".tar", ".tar.gz", ".tgz"))

    def _inventory_directory(
        self, root: Path
    ) -> tuple[list[dict[str, Any]], bytes]:
        try:
            members = read_directory_members_secure(
                root,
                max_files=self.max_package_files,
                max_bytes=self.max_package_bytes,
            )
        except PluginIntegrityError as exc:
            raise DshCompatibilityError(str(exc)) from exc
        manifest = members.get("package.json")
        if manifest is None:
            raise DshCompatibilityError("package root has no package.json")
        if len(manifest) > MAX_MANIFEST_BYTES:
            raise DshCompatibilityError(
                f"package.json exceeds {MAX_MANIFEST_BYTES} bytes"
            )
        inventory = [
            {
                "path": relative,
                "size": len(raw),
                "sha256": _sha256_bytes(raw),
            }
            for relative, raw in sorted(members.items())
        ]
        return inventory, manifest

    def _inventory_tarball(self, path: Path) -> _SourceSnapshot:
        metadata = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(metadata.st_mode):
            raise DshCompatibilityError("archive source is not a regular file")
        if metadata.st_size > self.max_archive_bytes:
            raise DshCompatibilityError(
                f"archive exceeds {self.max_archive_bytes} bytes"
            )
        archive_sha = _sha256_file_no_follow(
            path,
            maximum=self.max_archive_bytes,
        )
        try:
            with open_bounded_tar_archive(path) as archive:
                raw_members: list[tuple[tarfile.TarInfo, str]] = []
                regular_names: list[str] = []
                seen: set[str] = set()
                total = 0
                for member in archive:
                    normalized = _normalize_tar_name(member.name)
                    if not normalized:
                        continue
                    if normalized in seen:
                        raise DshCompatibilityError(
                            f"archive contains duplicate member: {normalized}"
                        )
                    seen.add(normalized)
                    if member.issym() or member.islnk():
                        raise DshCompatibilityError(
                            f"archive contains a link member: {normalized}"
                        )
                    if member.isdir():
                        continue
                    if not member.isfile():
                        raise DshCompatibilityError(
                            f"archive contains an unsafe special member: {normalized}"
                        )
                    if member.size < 0 or member.size > MAX_FILE_BYTES:
                        raise DshCompatibilityError(
                            f"archive member has unsafe size: {normalized}"
                        )
                    total += member.size
                    if total > self.max_package_bytes:
                        raise DshCompatibilityError(
                            f"archive expands beyond {self.max_package_bytes} bytes"
                        )
                    if len(raw_members) + 1 > self.max_package_files:
                        raise DshCompatibilityError(
                            f"archive exceeds {self.max_package_files} files"
                        )
                    raw_members.append((member, normalized))
                    regular_names.append(normalized)
                prefix = self._tar_package_prefix(regular_names)
                inventory: list[dict[str, Any]] = []
                manifest_bytes: bytes | None = None
                stripped_seen: set[str] = set()
                for member, normalized in raw_members:
                    if prefix and not normalized.startswith(prefix):
                        raise DshCompatibilityError(
                            f"archive member is outside package root: {normalized}"
                        )
                    relative = normalized[len(prefix) :] if prefix else normalized
                    if not relative or relative in stripped_seen:
                        raise DshCompatibilityError(
                            f"archive contains duplicate package path: {relative}"
                        )
                    stripped_seen.add(relative)
                    extracted = archive.extractfile(member)
                    if extracted is None:
                        raise DshCompatibilityError(
                            f"archive member could not be read: {normalized}"
                        )
                    digest = hashlib.sha256()
                    captured: list[bytes] = []
                    read_total = 0
                    while True:
                        chunk = extracted.read(1024 * 1024)
                        if not chunk:
                            break
                        read_total += len(chunk)
                        if read_total > member.size:
                            raise DshCompatibilityError(
                                f"archive member expanded past declared size: {normalized}"
                            )
                        digest.update(chunk)
                        if relative == "package.json":
                            captured.append(chunk)
                    if read_total != member.size:
                        raise DshCompatibilityError(
                            f"archive member size mismatch: {normalized}"
                        )
                    inventory.append(
                        {
                            "path": relative,
                            "size": member.size,
                            "sha256": digest.hexdigest(),
                        }
                    )
                    if relative == "package.json":
                        if member.size > MAX_MANIFEST_BYTES:
                            raise DshCompatibilityError(
                                f"package.json exceeds {MAX_MANIFEST_BYTES} bytes"
                            )
                        manifest_bytes = b"".join(captured)
        except (PluginIntegrityError, tarfile.TarError, OSError) as exc:
            if isinstance(exc, DshCompatibilityError):
                raise
            if isinstance(exc, PluginIntegrityError):
                raise DshCompatibilityError(str(exc)) from exc
            raise DshCompatibilityError(
                f"archive could not be inspected: {type(exc).__name__}"
            ) from exc
        if manifest_bytes is None:
            raise DshCompatibilityError("archive package root has no package.json")
        inventory.sort(key=lambda item: item["path"])
        return _SourceSnapshot(
            source=str(path),
            kind="tarball",
            path=path,
            inventory=tuple(inventory),
            package_sha256=_inventory_digest(inventory),
            manifest_bytes=manifest_bytes,
            archive_sha256=archive_sha,
            tar_prefix=prefix,
        )

    @staticmethod
    def _tar_package_prefix(names: list[str]) -> str:
        if "package.json" in names:
            return ""
        manifests = [name for name in names if name.endswith("/package.json")]
        package_roots = [
            manifest[: -len("package.json")]
            for manifest in manifests
            if all(
                name.startswith(manifest[: -len("package.json")])
                for name in names
            )
        ]
        if len(package_roots) != 1:
            raise DshCompatibilityError(
                "archive must contain exactly one package-root package.json"
            )
        return package_roots[0]

    def _record_from_snapshot(self, snapshot: _SourceSnapshot) -> dict[str, Any]:
        manifest = _json_no_duplicates(snapshot.manifest_bytes, "package.json")
        name = manifest.get("name")
        version = manifest.get("version")
        if (
            not isinstance(name, str)
            or len(name) > 214
            or not PACKAGE_NAME_RE.fullmatch(name)
        ):
            raise DshCompatibilityError(
                "package.json name must be a lowercase npm package name"
            )
        if (
            not isinstance(version, str)
            or len(version) > 128
            or not VERSION_RE.fullmatch(version)
        ):
            raise DshCompatibilityError(
                "package.json version must be an exact SemVer 2.0 version"
            )
        dsh = manifest.get("dsh")
        if not isinstance(dsh, dict):
            raise DshCompatibilityError("package.json dsh must be an object")
        unknown_dsh = sorted(set(dsh) - {"bundle", "client"})
        if unknown_dsh:
            raise DshCompatibilityError(
                "package.json dsh has unknown field(s): " + ", ".join(unknown_dsh)
            )
        if not dsh:
            raise DshCompatibilityError(
                "package.json dsh must declare bundle and/or client metadata"
            )

        inventory_map = _inventory_map(snapshot.inventory)
        declared_files = _package_file_patterns(manifest.get("files"))
        dependencies = _npm_dependency_map(
            manifest.get("dependencies"), "package.json dependencies"
        )
        peer_dependencies = _npm_dependency_map(
            manifest.get("peerDependencies"), "package.json peerDependencies"
        )
        optional_dependencies = _npm_dependency_map(
            manifest.get("optionalDependencies"),
            "package.json optionalDependencies",
        )
        unresolved_dependencies = sorted(
            dependency
            for dependency in set(dependencies) | set(optional_dependencies)
            if not self._inventory_contains_dependency(
                inventory_map,
                dependency,
            )
        )
        scripts_raw = manifest.get("scripts")
        if scripts_raw is None:
            scripts_raw = {}
        if not isinstance(scripts_raw, dict) or len(scripts_raw) > 256:
            raise DshCompatibilityError(
                "package.json scripts must be an object with at most 256 entries"
            )
        script_names: list[str] = []
        for script_name, command in scripts_raw.items():
            if (
                not isinstance(script_name, str)
                or not script_name
                or len(script_name) > 128
                or not isinstance(command, str)
                or len(command) > 16_384
            ):
                raise DshCompatibilityError(
                    "package.json scripts contains a malformed entry"
                )
            script_names.append(script_name)
        script_names.sort()
        lifecycle = [
            name for name in script_names if name.casefold() in LIFECYCLE_SCRIPTS
        ]
        build_scripts = [
            name for name in script_names if name.casefold() in BUILD_SCRIPTS
        ]

        bundle_patch: str | None = None
        bundle = dsh.get("bundle")
        if bundle is not None:
            if not isinstance(bundle, dict):
                raise DshCompatibilityError("package.json dsh.bundle must be an object")
            unknown_bundle = sorted(set(bundle) - {"patch"})
            if unknown_bundle:
                raise DshCompatibilityError(
                    "package.json dsh.bundle has unknown field(s): "
                    + ", ".join(unknown_bundle)
                )
            bundle_patch = _safe_relative_path(
                bundle.get("patch"), "package.json dsh.bundle.patch"
            )
            if not bundle_patch.casefold().endswith((".yml", ".yaml")):
                raise DshCompatibilityError(
                    "package.json dsh.bundle.patch must name a YAML file"
                )
            if not _declared_files_include(bundle_patch, declared_files):
                raise DshCompatibilityError(
                    "dsh.bundle.patch is excluded from package.json files"
                )

        client: dict[str, Any] | None = None
        if "client" in dsh:
            client_raw = dsh.get("client")
            if not isinstance(client_raw, dict):
                raise DshCompatibilityError("package.json dsh.client must be an object")
            unknown_client = sorted(
                set(client_raw) - {"platform", "inject", "immediately"}
            )
            if unknown_client:
                raise DshCompatibilityError(
                    "package.json dsh.client has unknown field(s): "
                    + ", ".join(unknown_client)
                )
            platform = client_raw.get("platform")
            if not isinstance(platform, str) or not platform.strip() or len(platform) > 64:
                raise DshCompatibilityError(
                    "package.json dsh.client.platform must be a non-empty string"
                )
            inject_raw = client_raw.get("inject", [])
            if (
                not isinstance(inject_raw, list)
                or len(inject_raw) > MAX_CLIENT_INJECT
                or any(
                    not isinstance(item, str)
                    or not PACKAGE_NAME_RE.fullmatch(item)
                    for item in inject_raw
                )
            ):
                raise DshCompatibilityError(
                    "package.json dsh.client.inject must be an npm package-name array"
                )
            immediately = client_raw.get("immediately", False)
            if not isinstance(immediately, bool):
                raise DshCompatibilityError(
                    "package.json dsh.client.immediately must be boolean"
                )
            export_path = _client_export_path(manifest)
            if export_path is None:
                raise DshCompatibilityError(
                    "package declares dsh.client but exports no './client' bundle"
                )
            if export_path not in inventory_map:
                raise DshCompatibilityError(
                    f"dsh.client export is missing from package files: {export_path}"
                )
            if not _declared_files_include(export_path, declared_files):
                raise DshCompatibilityError(
                    "dsh.client export is excluded from package.json files"
                )
            client = {
                "platform": platform.strip(),
                "inject": list(dict.fromkeys(inject_raw)),
                "immediately": immediately,
                "export": export_path,
            }

        statuses = ["discovered", "manifest-valid"]
        issues: list[str] = []
        installable = False
        if (
            bundle_patch is not None
            and bundle_patch in inventory_map
            and unresolved_dependencies
        ):
            statuses.append("external-runtime-only")
            status_value = "external-runtime-only"
            issues.append(
                "runtime dependency closure is not installed in the package: "
                + ", ".join(unresolved_dependencies)
            )
        elif bundle_patch is not None and bundle_patch in inventory_map:
            statuses.append("installable-prebuilt")
            status_value = "installable-prebuilt"
            installable = True
        elif bundle_patch is not None and (build_scripts or lifecycle):
            statuses.extend(["requires-build-script", "quarantined"])
            status_value = "quarantined"
            issues.append(
                "declared bundle patch is absent and would require a disabled build/lifecycle script"
            )
        elif bundle_patch is not None:
            statuses.append("blocked")
            status_value = "blocked"
            issues.append("declared dsh.bundle.patch file is missing")
        elif client is not None:
            statuses.append("external-runtime-only")
            status_value = "external-runtime-only"
            issues.append(
                "client-only DSH package requires an external browser/runtime integration"
            )
        else:
            statuses.append("blocked")
            status_value = "blocked"
            issues.append("package has no installable DSH bundle")

        profile_name = self._profile_name(name)
        if (
            snapshot.resolved_package is not None
            and snapshot.resolved_package != name
        ):
            raise DshCompatibilityError(
                "resolved package name does not match package.json"
            )
        if (
            snapshot.resolved_version is not None
            and snapshot.resolved_version != version
        ):
            raise DshCompatibilityError(
                "resolved package version does not match package.json"
            )
        try:
            integrity = verify_package_source(
                snapshot.path,
                source_kind=snapshot.kind,
                policy=self.integrity_policy,
                trust_store_path=self.publisher_trust_path,
                expected_package_id=name,
                expected_version=version,
                max_files=self.max_package_files,
                max_bytes=self.max_package_bytes,
            )
        except PluginIntegrityError as exc:
            raise DshCompatibilityError(
                f"publisher/package verification failed: {exc}"
            ) from exc
        trust_claims = (
            ["publisher-identity", "package-bytes"]
            if integrity.trusted_publisher
            else []
        )
        return {
            "schema": DISCOVERY_SCHEMA,
            "id": name,
            "name": name,
            "version": version,
            "source": snapshot.source,
            "sourceKind": snapshot.kind,
            "requestedSpec": snapshot.requested_spec,
            "resolvedPackage": name,
            "resolvedVersion": version,
            "npmIntegrity": snapshot.npm_integrity,
            "fetchState": (
                "approved/fetched"
                if snapshot.network_fetched
                else "local"
            ),
            "status": status_value,
            "statuses": statuses,
            "manifestValid": True,
            "installable": installable,
            "installed": False,
            "approvalRequired": installable,
            "sha256": snapshot.package_sha256,
            "archiveSha256": snapshot.archive_sha256,
            "bundlePatch": bundle_patch,
            "client": client,
            "dependencies": dependencies,
            "peerDependencies": peer_dependencies,
            "optionalDependencies": optional_dependencies,
            "unresolvedDependencies": unresolved_dependencies,
            "packageFiles": declared_files,
            "inventory": [copy.deepcopy(item) for item in snapshot.inventory],
            "fileCount": len(snapshot.inventory),
            "totalBytes": sum(int(item["size"]) for item in snapshot.inventory),
            "scripts": script_names,
            "lifecycleScripts": lifecycle,
            "buildScripts": build_scripts,
            "lifecycleScriptsDisabled": True,
            "networkFetched": snapshot.network_fetched,
            "profileName": profile_name,
            "integrity": integrity.public_dict(),
            "trusted": integrity.trusted_publisher,
            "trustClaims": trust_claims,
            "compatibilityScope": (
                "metadata, local package layout, and detached publisher/package "
                "integrity only; no sandbox, runtime safety, or capability claim"
            ),
            "issues": issues,
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _snapshot_bridge(self) -> _BridgeSnapshot:
        raw_root = self.bridge_source_root
        source_root = raw_root if raw_root.is_absolute() else Path.cwd() / raw_root
        entrypoint = self.bridge_entrypoint
        pending = [entrypoint]
        seen: set[str] = set()
        inventory: list[dict[str, Any]] = []
        total = 0

        while pending:
            relative = pending.pop()
            if relative in seen:
                continue
            seen.add(relative)
            raw = _read_bridge_member(source_root, relative)
            total += len(raw)
            if total > MAX_BRIDGE_BYTES:
                raise DshCompatibilityError(
                    f"Sophia Cordis bridge closure exceeds {MAX_BRIDGE_BYTES} bytes"
                )
            if len(seen) > MAX_BRIDGE_FILES:
                raise DshCompatibilityError(
                    f"Sophia Cordis bridge closure exceeds {MAX_BRIDGE_FILES} files"
                )
            inventory.append(
                {
                    "path": relative,
                    "size": len(raw),
                    "sha256": _sha256_bytes(raw),
                }
            )
            if PurePosixPath(relative).suffix.casefold() not in {
                ".js",
                ".mjs",
                ".cjs",
            }:
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise DshCompatibilityError(
                    f"Sophia Cordis bridge module is not UTF-8: {relative}"
                ) from exc
            specifiers = {
                match.group(1)
                for pattern in (
                    STATIC_JS_SPECIFIER_RE,
                    DYNAMIC_JS_SPECIFIER_RE,
                    REQUIRE_JS_SPECIFIER_RE,
                )
                for match in pattern.finditer(text)
            }
            for specifier in sorted(specifiers):
                if specifier.startswith("node:"):
                    continue
                if not specifier.startswith(("./", "../")):
                    raise DshCompatibilityError(
                        "Sophia Cordis bridge has an uncopied external import "
                        f"{specifier!r} in {relative}"
                    )
                if (
                    "\x00" in specifier
                    or "\\" in specifier
                    or "?" in specifier
                    or "#" in specifier
                ):
                    raise DshCompatibilityError(
                        f"Sophia Cordis bridge has an unsafe import in {relative}"
                    )
                dependency_relative = posixpath.normpath(
                    posixpath.join(
                        PurePosixPath(relative).parent.as_posix(),
                        specifier,
                    )
                )
                dependency_relative = _safe_relative_path(
                    dependency_relative,
                    "Sophia Cordis bridge dependency",
                )
                pending.append(dependency_relative)

        inventory.sort(key=lambda item: str(item["path"]))
        return _BridgeSnapshot(
            source_root=source_root,
            entrypoint=entrypoint,
            inventory=tuple(inventory),
            sha256=_inventory_digest(inventory),
        )

    # ------------------------------------------------------------------
    # Private installation materialization
    # ------------------------------------------------------------------
    def _materialize_object(
        self,
        snapshot: _SourceSnapshot,
        record: Mapping[str, Any],
        bridge_snapshot: _BridgeSnapshot,
        final_object: Path,
    ) -> None:
        stage = Path(
            tempfile.mkdtemp(prefix=".install-", dir=str(self.staging_dir))
        )
        os.chmod(stage, 0o700)
        try:
            runtime_root = stage / "runtime"
            profile = (
                runtime_root / "profiles" / str(record["profileName"])
            )
            package_root = profile / self._node_modules_relative(str(record["name"]))
            self._secure_mkdir(package_root)
            if snapshot.kind == "directory":
                self._copy_directory_snapshot(snapshot, package_root)
            elif snapshot.kind in {"tarball", "remote-tarball"}:
                self._extract_tar_snapshot(snapshot, package_root)
            else:
                raise DshCompatibilityError(
                    f"unsupported local source kind: {snapshot.kind}"
                )
            inventory, manifest_bytes = self._inventory_directory(package_root)
            if _inventory_digest(inventory) != snapshot.package_sha256:
                raise DshCompatibilityError(
                    "package changed between discovery and staged installation"
                )
            if _sha256_bytes(manifest_bytes) != _sha256_bytes(snapshot.manifest_bytes):
                raise DshCompatibilityError(
                    "package.json changed between discovery and staged installation"
                )
            self._copy_bridge_snapshot(
                bridge_snapshot,
                profile / BRIDGE_DESTINATION,
            )
            self._write_profile_files(
                runtime_root,
                profile,
                record,
                package_root,
                bridge_snapshot,
                final_runtime_root=final_object / "runtime",
                final_profile=(
                    final_object
                    / "runtime"
                    / "profiles"
                    / str(record["profileName"])
                ),
            )
            if final_object.exists():
                self._verify_existing_object(
                    final_object,
                    record,
                    bridge_snapshot,
                )
            else:
                os.replace(stage, final_object)
                stage = Path()
        finally:
            if stage and stage.exists() and self._is_within_private_root(stage):
                shutil.rmtree(stage, ignore_errors=True)

    def _copy_bridge_snapshot(
        self,
        snapshot: _BridgeSnapshot,
        destination: Path,
    ) -> None:
        self._secure_mkdir(destination)
        expected = _inventory_map(snapshot.inventory)
        for relative in sorted(expected):
            raw = _read_bridge_member(snapshot.source_root, relative)
            if (
                len(raw) != expected[relative]["size"]
                or _sha256_bytes(raw) != expected[relative]["sha256"]
            ):
                raise DshCompatibilityError(
                    f"Sophia Cordis bridge changed while copying: {relative}"
                )
            target = destination / PurePosixPath(relative)
            self._secure_mkdir(target.parent)
            self._write_bytes_exclusive(target, raw)

    def _copy_directory_snapshot(
        self, snapshot: _SourceSnapshot, destination: Path
    ) -> None:
        expected = _inventory_map(snapshot.inventory)
        try:
            members = read_directory_members_secure(
                snapshot.path,
                max_files=self.max_package_files,
                max_bytes=self.max_package_bytes,
            )
        except PluginIntegrityError as exc:
            raise DshCompatibilityError(str(exc)) from exc
        actual = {
            relative: {
                "path": relative,
                "size": len(raw),
                "sha256": _sha256_bytes(raw),
            }
            for relative, raw in members.items()
        }
        if actual != expected:
            raise DshCompatibilityError(
                "package changed between discovery and staged installation"
            )
        for relative in sorted(expected):
            target = destination / PurePosixPath(relative)
            self._secure_mkdir(target.parent)
            self._write_bytes_exclusive(target, members[relative])

    def _extract_tar_snapshot(
        self, snapshot: _SourceSnapshot, destination: Path
    ) -> None:
        expected = _inventory_map(snapshot.inventory)
        if (
            _sha256_file_no_follow(
                snapshot.path,
                maximum=self.max_archive_bytes,
            )
            != snapshot.archive_sha256
        ):
            raise DshCompatibilityError(
                "archive changed between discovery and staged installation"
            )
        try:
            with open_bounded_tar_archive(snapshot.path) as archive:
                seen: set[str] = set()
                for member in archive:
                    normalized = _normalize_tar_name(member.name)
                    if not normalized or member.isdir():
                        continue
                    if member.issym() or member.islnk() or not member.isfile():
                        raise DshCompatibilityError(
                            f"archive contains an unsafe member: {normalized}"
                        )
                    if snapshot.tar_prefix:
                        if not normalized.startswith(snapshot.tar_prefix):
                            raise DshCompatibilityError(
                                f"archive member is outside package root: {normalized}"
                            )
                        relative = normalized[len(snapshot.tar_prefix) :]
                    else:
                        relative = normalized
                    if relative not in expected or relative in seen:
                        raise DshCompatibilityError(
                            f"archive inventory changed during installation: {relative}"
                        )
                    seen.add(relative)
                    extracted = archive.extractfile(member)
                    if extracted is None:
                        raise DshCompatibilityError(
                            f"archive member could not be read: {relative}"
                        )
                    raw = extracted.read(MAX_FILE_BYTES + 1)
                    if len(raw) > MAX_FILE_BYTES or len(raw) != expected[relative]["size"]:
                        raise DshCompatibilityError(
                            f"archive member size changed: {relative}"
                        )
                    if _sha256_bytes(raw) != expected[relative]["sha256"]:
                        raise DshCompatibilityError(
                            f"archive member digest changed: {relative}"
                        )
                    target = destination / PurePosixPath(relative)
                    self._secure_mkdir(target.parent)
                    self._write_bytes_exclusive(target, raw)
                if seen != set(expected):
                    raise DshCompatibilityError(
                        "archive package inventory changed during installation"
                    )
        except (PluginIntegrityError, tarfile.TarError, OSError) as exc:
            if isinstance(exc, DshCompatibilityError):
                raise
            if isinstance(exc, PluginIntegrityError):
                raise DshCompatibilityError(str(exc)) from exc
            raise DshCompatibilityError(
                f"archive extraction failed: {type(exc).__name__}"
            ) from exc

    def _write_profile_files(
        self,
        runtime_root: Path,
        profile: Path,
        record: Mapping[str, Any],
        package_root: Path,
        bridge_snapshot: _BridgeSnapshot,
        *,
        final_runtime_root: Path | None = None,
        final_profile: Path | None = None,
    ) -> None:
        self._secure_mkdir(runtime_root)
        self._secure_mkdir(profile)
        final_runtime = (
            final_runtime_root.resolve()
            if final_runtime_root is not None
            else runtime_root.resolve()
        )
        final_profile_path = (
            final_profile.resolve()
            if final_profile is not None
            else profile.resolve()
        )
        self._assert_within_private_root(final_runtime)
        self._assert_within_private_root(final_profile_path)
        expected_profile = (
            final_runtime
            / "profiles"
            / str(record["profileName"])
        )
        if final_profile_path != expected_profile:
            raise DshCompatibilityError(
                "generated DSH profile path does not match its private DSH_HOME"
            )
        dependency_path = package_root.relative_to(profile).as_posix()
        private_directories = (
            runtime_root / "profiles",
            runtime_root / "profiles" / "node_modules",
            runtime_root / "home",
            runtime_root / "tmp",
            profile,
        )
        for directory in private_directories:
            self._secure_mkdir(directory)
        package_json = {
            "name": f"dsh-profile-{record['profileName']}",
            "version": "0.0.0-private",
            "private": True,
            "type": "module",
            "dependencies": {
                str(record["name"]): f"file:./{dependency_path}",
            },
            "scripts": {},
            "dsh": {
                "profile": {
                    "bundles": [
                        "@deepseek-ai/dsh-base",
                        str(record["name"]),
                    ]
                }
            },
            "sophiaDshCompatibility": {
                "schema": BRIDGE_SCHEMA,
                "workspaceHash": self.workspace_hash,
                "packageSha256": record["sha256"],
                "bridgeSha256": bridge_snapshot.sha256,
                "bridgeEntrypoint": bridge_snapshot.entrypoint,
                "lifecycleScriptsDisabled": True,
                "networkFetched": bool(record["networkFetched"]),
                "integrity": copy.deepcopy(record["integrity"]),
                "trusted": bool(record["trusted"]),
                "trustClaims": list(record["trustClaims"]),
                "candidateOnly": True,
                "canClaimAGI": False,
            },
        }
        cordis_yml = (
            "# Generated by Sophia DSH compatibility management.\n"
            f"# bundle: {record['name']}\n"
            f"# patch: {dependency_path}/{record['bundlePatch']}\n"
            "# DSH boots the profile cordis.patch.yml; this audit file is inert.\n"
            "# This profile makes no publisher, sandbox, or safety claim.\n"
            "[]\n"
        )
        loader_entry = (
            f"./{BRIDGE_DESTINATION}/{bridge_snapshot.entrypoint}"
        )
        profile_patch = (
            "# Generated Sophia user layer, applied after all bundle layers.\n"
            "# The copied bridge is candidate-only and makes no trust claim.\n"
            "- insert:\n"
            "    - id: sophia-dsh-compat-bridge\n"
            f"      name: '{loader_entry}'\n"
            "      config:\n"
            "        namespace: sophia_dsh\n"
        )
        runtime_fields = self._runtime_contract(
            final_runtime,
            final_profile_path,
            str(record["profileName"]),
            str(record["id"]),
        )
        bridge = {
            "schema": BRIDGE_SCHEMA,
            "id": record["id"],
            "compatibilityId": record["id"],
            "package": record["name"],
            "version": record["version"],
            "workspace": str(self.workspace),
            "workspaceHash": self.workspace_hash,
            "profileName": record["profileName"],
            "packageSha256": record["sha256"],
            "packageDigest": record["sha256"],
            "bridgeSha256": bridge_snapshot.sha256,
            "bridgeEntrypoint": bridge_snapshot.entrypoint,
            "loaderEntry": loader_entry,
            "bundlePatch": record["bundlePatch"],
            "packageRelativeRoot": dependency_path,
            **runtime_fields,
            "lifecycleScriptsDisabled": True,
            "networkFetched": bool(record["networkFetched"]),
            "externalRuntime": "deepseek-harness",
            "integrity": copy.deepcopy(record["integrity"]),
            "trusted": bool(record["trusted"]),
            "trustClaims": list(record["trustClaims"]),
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        bridge_package_json = {
            "name": "@sophia-agi/private-dsh-cordis-bridge",
            "version": "0.0.0-private",
            "private": True,
            "type": "module",
        }
        self._atomic_write_json(profile / "package.json", package_json)
        self._atomic_write_bytes(profile / "cordis.yml", cordis_yml.encode("utf-8"))
        self._atomic_write_bytes(
            profile / "cordis.patch.yml",
            profile_patch.encode("utf-8"),
        )
        self._atomic_write_json(profile / "bridge.json", bridge)
        self._atomic_write_json(
            profile / BRIDGE_DESTINATION / "package.json",
            bridge_package_json,
        )
        self._atomic_write_bytes(
            runtime_root / "cordis.patch.yml",
            (
                "# Generated private DSH_HOME user layer; profile layer is authoritative.\n"
                "[]\n"
            ).encode("utf-8"),
        )

    def _verify_existing_object(
        self,
        object_root: Path,
        record: Mapping[str, Any],
        bridge_snapshot: _BridgeSnapshot,
    ) -> None:
        if object_root.is_symlink() or not object_root.is_dir():
            raise DshCompatibilityError("installed object path is unsafe")
        runtime_root = object_root / "runtime"
        profile = (
            runtime_root / "profiles" / str(record["profileName"])
        )
        package_root = profile / self._node_modules_relative(str(record["name"]))
        inventory, _manifest = self._inventory_directory(package_root)
        if _inventory_digest(inventory) != record["sha256"]:
            raise DshCompatibilityError(
                "existing private object does not match requested package digest"
            )
        bridge_root = profile / BRIDGE_DESTINATION
        bridge_inventory, _bridge_manifest = self._inventory_directory(bridge_root)
        copied_bridge_inventory = [
            item for item in bridge_inventory if item["path"] != "package.json"
        ]
        if (
            copied_bridge_inventory != list(bridge_snapshot.inventory)
            or _inventory_digest(copied_bridge_inventory)
            != bridge_snapshot.sha256
        ):
            raise DshCompatibilityError(
                "existing private object does not match the Sophia bridge digest"
            )
        for required in (
            profile / "package.json",
            profile / "cordis.yml",
            profile / "cordis.patch.yml",
            profile / "bridge.json",
            runtime_root / "cordis.patch.yml",
        ):
            if required.is_symlink() or not required.is_file():
                raise DshCompatibilityError(
                    f"existing private object is missing generated config: {required.name}"
                )
        bridge_config = _json_no_duplicates(
            _read_file_no_follow(
                profile / "bridge.json",
                maximum=MAX_MANIFEST_BYTES,
            ),
            "generated bridge config",
        )
        expected_runtime = self._runtime_contract(
            runtime_root,
            profile,
            str(record["profileName"]),
            str(record["id"]),
        )
        if any(
            bridge_config.get(key) != value
            for key, value in expected_runtime.items()
        ):
            raise DshCompatibilityError(
                "existing private object runtime config does not match"
            )

    def _runtime_contract(
        self,
        profile_root: Path,
        profile_dir: Path,
        profile_name: str,
        package_id: str,
    ) -> dict[str, Any]:
        final_root = profile_root.resolve()
        final_profile = profile_dir.resolve()
        self._assert_within_private_root(final_root)
        self._assert_within_private_root(final_profile)
        if (
            final_profile
            != final_root / "profiles" / profile_name
        ):
            raise DshCompatibilityError(
                "runtime profile directory is outside the named private DSH profile"
            )
        cordis_config = final_profile / "cordis.yml"
        fields: dict[str, Any] = {
            "packageId": package_id,
            "profileRoot": str(final_root),
            "cordisConfig": str(cordis_config),
            "command": ["dsh", "--profile", profile_name],
            "allowedCommands": ["dsh"],
            "envAllow": [
                "PATH",
                "HOME",
                "DSH_HOME",
                "TMPDIR",
                "LANG",
                "LC_ALL",
            ],
            "env": {
                "HOME": str(final_root / "home"),
                "DSH_HOME": str(final_root),
                "TMPDIR": str(final_root / "tmp"),
            },
            "cwd": str(final_profile),
            "framing": "content-length",
            "timeoutMs": 120_000,
        }
        fields["digest"] = "sha256:" + _sha256_bytes(
            _canonical_json_bytes(fields)
        )
        return fields

    # ------------------------------------------------------------------
    # Catalog, lock, receipts, and integrity
    # ------------------------------------------------------------------
    @contextmanager
    def _state_guard(self, *, reconcile: bool = True) -> Iterator[None]:
        """Serialize one complete workspace state operation.

        The process-local RLock covers multiple manager instances in one
        interpreter.  The private lock file covers independent processes.  A
        manager re-reads and reconciles persisted state only after both locks
        are held.
        """
        with self._process_mutex:
            depth = int(getattr(self._guard_local, "depth", 0))
            if depth:
                self._guard_local.depth = depth + 1
                try:
                    yield
                finally:
                    self._guard_local.depth = depth
                return
            flags = os.O_RDWR | os.O_CREAT
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            lock_fd = os.open(self.mutation_lock_path, flags, 0o600)
            acquired = False
            try:
                _set_private_fd_mode(lock_fd)
                if os.name == "nt":
                    os.lseek(lock_fd, 0, os.SEEK_SET)
                    if os.fstat(lock_fd).st_size == 0:
                        os.write(lock_fd, b"\0")
                        os.fsync(lock_fd)
                _acquire_advisory_lock(
                    lock_fd,
                    timeout_seconds=self.operation_timeout_seconds,
                )
                acquired = True
                self._guard_local.depth = 1
                if reconcile and self._state_ready:
                    if self.authority_path.exists():
                        self._read_authority_state()
                    else:
                        self._ensure_authority_state_locked()
                    self._reconcile_state_locked()
                    self._migrate_legacy_lock_locked()
                    self._prune_unreferenced_objects_locked()
                    self._ensure_authority_state_locked()
                yield
            finally:
                self._guard_local.depth = 0
                try:
                    if acquired:
                        _release_advisory_lock(lock_fd)
                finally:
                    os.close(lock_fd)

    def _initialize_private_root(self) -> None:
        for path in (
            self.private_root,
            self.objects_dir,
            self.staging_dir,
            self.receipts_dir,
            self.events_dir,
        ):
            self._secure_mkdir(path)
        with self._state_guard(reconcile=False):
            if not self.catalog_path.exists():
                self._write_catalog(self._fresh_catalog())
            if not self.lock_path.exists():
                self._write_lock(self._fresh_lock())
            if not self.transactions_path.exists():
                self._write_transactions(self._fresh_transactions())
            self._migrate_legacy_transactions_locked()
            self._reconcile_state_locked()
            self._migrate_legacy_lock_locked()
            self._prune_unreferenced_objects_locked()
            self._ensure_authority_state_locked()
            self._state_ready = True

    def _fresh_catalog(self) -> dict[str, Any]:
        return {
            "schema": CATALOG_SCHEMA,
            "workspace": str(self.workspace),
            "workspaceHash": self.workspace_hash,
            "generatedAt": None,
            "entries": {},
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _fresh_lock(self) -> dict[str, Any]:
        return {
            "schema": LOCK_SCHEMA,
            "workspace": str(self.workspace),
            "workspaceHash": self.workspace_hash,
            "generatedAt": None,
            "installations": [],
            "legacyQuarantine": [],
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _fresh_transactions(self) -> dict[str, Any]:
        return {
            "schema": TRANSACTION_SCHEMA,
            "workspace": str(self.workspace),
            "workspaceHash": self.workspace_hash,
            "updatedAt": None,
            "history": [],
            "rollbackPoints": {},
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _fresh_authority_state(self) -> dict[str, Any]:
        return {
            "schema": AUTHORITY_SCHEMA,
            "workspace": str(self.workspace),
            "workspaceHash": self.workspace_hash,
            "updatedAt": None,
            "pluginNonces": {},
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _read_authority_state(self) -> dict[str, Any]:
        raw = _json_no_duplicates(
            _read_file_no_follow(
                self.authority_path,
                maximum=MAX_AUTHORITY_STATE_BYTES,
            ),
            "DSH compatibility authority state",
        )
        self._verify_self_hash(
            raw,
            "authoritySha256",
            "DSH compatibility authority state",
        )
        if set(raw) != {
            "schema",
            "workspace",
            "workspaceHash",
            "updatedAt",
            "pluginNonces",
            "candidateOnly",
            "canClaimAGI",
            "authoritySha256",
        }:
            raise DshCompatibilityError(
                "DSH compatibility authority state fields are invalid"
            )
        nonces = raw.get("pluginNonces")
        if (
            raw.get("schema") != AUTHORITY_SCHEMA
            or raw.get("workspace") != str(self.workspace)
            or raw.get("workspaceHash") != self.workspace_hash
            or raw.get("candidateOnly") is not True
            or raw.get("canClaimAGI") is not False
            or not isinstance(nonces, dict)
            or len(nonces) > MAX_PACKAGE_FILES
        ):
            raise DshCompatibilityError(
                "DSH compatibility authority state failed validation"
            )
        updated_at = raw.get("updatedAt")
        if updated_at is not None:
            if (
                not isinstance(updated_at, str)
                or len(updated_at) > 32
                or not re.fullmatch(
                    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"
                    r"(?:\.\d{1,6})?Z",
                    updated_at,
                )
            ):
                raise DshCompatibilityError(
                    "DSH compatibility authority timestamp is invalid"
                )
            try:
                datetime.fromisoformat(updated_at[:-1] + "+00:00")
            except ValueError as exc:
                raise DshCompatibilityError(
                    "DSH compatibility authority timestamp is invalid"
                ) from exc
        for plugin_id, nonce in nonces.items():
            if (
                not isinstance(plugin_id, str)
                or len(plugin_id) > 214
                or not PACKAGE_NAME_RE.fullmatch(plugin_id)
                or not isinstance(nonce, str)
                or not re.fullmatch(r"[0-9a-f]{32}", nonce)
            ):
                raise DshCompatibilityError(
                    "DSH compatibility authority nonce is invalid"
                )
        return raw

    def _write_authority_state(self, state: Mapping[str, Any]) -> None:
        output = copy.deepcopy(dict(state))
        output.pop("authoritySha256", None)
        nonces = output.get("pluginNonces")
        if (
            not isinstance(nonces, dict)
            or len(nonces) > MAX_PACKAGE_FILES
        ):
            raise DshCompatibilityError(
                "DSH compatibility authority state has an invalid nonce map"
            )
        for plugin_id, nonce in nonces.items():
            if (
                not isinstance(plugin_id, str)
                or len(plugin_id) > 214
                or not PACKAGE_NAME_RE.fullmatch(plugin_id)
                or not isinstance(nonce, str)
                or not re.fullmatch(r"[0-9a-f]{32}", nonce)
            ):
                raise DshCompatibilityError(
                    "DSH compatibility authority nonce is invalid"
                )
        output.update(
            {
                "schema": AUTHORITY_SCHEMA,
                "workspace": str(self.workspace),
                "workspaceHash": self.workspace_hash,
                "updatedAt": _now_iso(),
                "pluginNonces": {
                    key: nonces[key] for key in sorted(nonces)
                },
                "candidateOnly": True,
                "canClaimAGI": False,
            }
        )
        output["authoritySha256"] = _sha256_bytes(
            _canonical_json_bytes(output)
        )
        if len(_canonical_json_bytes(output)) > MAX_AUTHORITY_STATE_BYTES:
            raise DshCompatibilityError(
                "DSH compatibility authority state exceeds its size limit"
            )
        self._atomic_write_json(self.authority_path, output)

    def _authority_plugin_ids_locked(self) -> set[str]:
        catalog = self._read_catalog()
        lock = self._read_lock_required()
        transactions = self._read_transactions()
        return {
            plugin_id
            for plugin_id in (
                set(catalog.get("entries", {}))
                | {
                    str(item.get("id") or "")
                    for item in lock.get("installations", [])
                    if isinstance(item, Mapping)
                }
                | {
                    str(item.get("id") or "")
                    for item in lock.get("legacyQuarantine", [])
                    if isinstance(item, Mapping)
                }
                | set(transactions.get("rollbackPoints", {}))
            )
            if PACKAGE_NAME_RE.fullmatch(plugin_id)
        }

    def _ensure_authority_state_locked(self) -> None:
        if self.authority_path.exists():
            state = self._read_authority_state()
        else:
            # Legacy workspaces receive fresh unpredictable nonces while D is
            # held. Any in-flight process with no nonce fails closed against
            # this one-time migration.
            state = self._fresh_authority_state()
        nonces = state["pluginNonces"]
        changed = not self.authority_path.exists()
        required_ids = self._authority_plugin_ids_locked()
        if len(set(nonces) | required_ids) > MAX_PACKAGE_FILES:
            raise DshCompatibilityError(
                "DSH compatibility authority state exceeds its package limit"
            )
        for plugin_id in sorted(required_ids):
            if plugin_id not in nonces:
                nonces[plugin_id] = uuid.uuid4().hex
                changed = True
        if changed:
            self._write_authority_state(state)

    def _rotate_authority_nonce_locked(self, plugin_id: str) -> str:
        state = self._read_authority_state()
        if (
            plugin_id not in state["pluginNonces"]
            and len(state["pluginNonces"]) >= MAX_PACKAGE_FILES
        ):
            raise DshCompatibilityError(
                "DSH compatibility authority state exceeds its package limit"
            )
        nonce = uuid.uuid4().hex
        state["pluginNonces"][plugin_id] = nonce
        self._write_authority_state(state)
        return nonce

    def _rotate_migrated_authority_nonces_locked(
        self,
        plugin_ids: set[str],
    ) -> None:
        """Conservatively revoke every identity changed by legacy migration.

        Legacy lock migration runs before ordinary authority-state migration on
        first open, so this helper must also create the initial authority file.
        A retained authority file is never allowed to preserve a nonce across
        a lock/catalog migration or quarantine decision.
        """
        state = (
            self._read_authority_state()
            if self.authority_path.exists()
            else self._fresh_authority_state()
        )
        if (
            len(set(state["pluginNonces"]) | plugin_ids)
            > MAX_PACKAGE_FILES
        ):
            raise DshCompatibilityError(
                "DSH compatibility authority state exceeds its package limit"
            )
        for plugin_id in sorted(plugin_ids):
            state["pluginNonces"][plugin_id] = uuid.uuid4().hex
        self._write_authority_state(state)

    @staticmethod
    def _verify_self_hash(
        raw: Mapping[str, Any],
        hash_field: str,
        label: str,
    ) -> None:
        state_hash = raw.get(hash_field)
        if not isinstance(state_hash, str) or not SHA256_RE.fullmatch(state_hash):
            raise DshCompatibilityError(f"{label} has no valid self-hash")
        body = copy.deepcopy(dict(raw))
        body.pop(hash_field, None)
        if _sha256_bytes(_canonical_json_bytes(body)) != state_hash:
            raise DshCompatibilityError(f"{label} self-hash mismatch")

    def _read_transaction_file_raw(self) -> dict[str, Any]:
        raw = _json_no_duplicates(
            _read_file_no_follow(
                self.transactions_path,
                maximum=MAX_TRANSACTION_STATE_BYTES,
            ),
            "DSH compatibility transaction state",
        )
        self._verify_self_hash(
            raw,
            "transactionsSha256",
            "DSH compatibility transaction state",
        )
        return raw

    def _read_transactions(self) -> dict[str, Any]:
        raw = self._read_transaction_file_raw()
        if set(raw) != {
            "schema",
            "workspace",
            "workspaceHash",
            "updatedAt",
            "history",
            "rollbackPoints",
            "candidateOnly",
            "canClaimAGI",
            "transactionsSha256",
        }:
            raise DshCompatibilityError(
                "DSH compatibility transaction state fields are invalid"
            )
        history = raw.get("history")
        rollback_points = raw.get("rollbackPoints")
        if (
            raw.get("schema") != TRANSACTION_SCHEMA
            or raw.get("workspace") != str(self.workspace)
            or raw.get("workspaceHash") != self.workspace_hash
            or raw.get("candidateOnly") is not True
            or raw.get("canClaimAGI") is not False
            or not isinstance(history, list)
            or len(history) > MAX_TRANSACTION_HISTORY
            or not isinstance(rollback_points, dict)
        ):
            raise DshCompatibilityError(
                "DSH compatibility transaction state failed validation"
            )
        for entry in history:
            self._validate_transaction_history_entry(entry)
        for plugin_id, point in rollback_points.items():
            if (
                not isinstance(plugin_id, str)
                or not PACKAGE_NAME_RE.fullmatch(plugin_id)
                or not isinstance(point, dict)
                or set(point) != {"installation", "catalogEntry"}
                or not isinstance(point.get("catalogEntry"), dict)
            ):
                raise DshCompatibilityError(
                    "DSH compatibility rollback point is malformed"
                )
            installation = point.get("installation")
            if not isinstance(installation, dict):
                raise DshCompatibilityError(
                    "DSH compatibility rollback installation is malformed"
                )
            self._validate_lock_installation(installation)
            if installation.get("id") != plugin_id:
                raise DshCompatibilityError(
                    "DSH compatibility rollback point id is inconsistent"
                )
        return raw

    def _write_transactions(self, state: Mapping[str, Any]) -> None:
        output = copy.deepcopy(dict(state))
        output.pop("transactionsSha256", None)
        output["schema"] = TRANSACTION_SCHEMA
        output["workspace"] = str(self.workspace)
        output["workspaceHash"] = self.workspace_hash
        output["updatedAt"] = _now_iso()
        history = output.get("history", [])
        rollback_points = output.get("rollbackPoints", {})
        if not isinstance(history, list) or not isinstance(rollback_points, dict):
            raise DshCompatibilityError(
                "DSH compatibility transaction state must contain history and rollback points"
            )
        output["history"] = copy.deepcopy(history[-MAX_TRANSACTION_HISTORY:])
        output["rollbackPoints"] = {
            key: copy.deepcopy(rollback_points[key])
            for key in sorted(rollback_points)
        }
        output["candidateOnly"] = True
        output["canClaimAGI"] = False
        output["transactionsSha256"] = _sha256_bytes(
            _canonical_json_bytes(output)
        )
        self._atomic_write_json(self.transactions_path, output)

    @staticmethod
    def _validate_transaction_history_entry(entry: Any) -> None:
        fields = {
            "operationId",
            "pluginId",
            "action",
            "status",
            "startedAt",
            "completedAt",
            "fromObjectSha256",
            "toObjectSha256",
            "error",
            "beforeLock",
            "beforeCatalog",
        }
        if not isinstance(entry, dict) or set(entry) != fields:
            raise DshCompatibilityError(
                "DSH compatibility transaction history entry is malformed"
            )
        if (
            not isinstance(entry.get("operationId"), str)
            or not re.fullmatch(r"[0-9a-f]{32}", entry["operationId"])
            or not isinstance(entry.get("pluginId"), str)
            or not PACKAGE_NAME_RE.fullmatch(entry["pluginId"])
            or entry.get("action")
            not in {
                "install",
                "update",
                "rollback",
                "uninstall",
                "conformance",
                "migration",
            }
            or entry.get("status")
            not in {"pending", "committed", "rolled-back"}
            or not isinstance(entry.get("startedAt"), str)
            or not entry["startedAt"]
        ):
            raise DshCompatibilityError(
                "DSH compatibility transaction history identity is invalid"
            )
        completed = entry.get("completedAt")
        error = entry.get("error")
        if entry["status"] == "pending":
            if (
                completed is not None
                or error is not None
                or not isinstance(entry.get("beforeLock"), dict)
                or not isinstance(entry.get("beforeCatalog"), dict)
            ):
                raise DshCompatibilityError(
                    "pending DSH compatibility transaction is malformed"
                )
        elif (
            not isinstance(completed, str)
            or not completed
            or (
                entry["status"] == "committed"
                and error is not None
            )
            or (
                entry["status"] == "rolled-back"
                and (
                    not isinstance(error, str)
                    or not error
                    or len(error) > 4096
                )
            )
        ):
            raise DshCompatibilityError(
                "completed DSH compatibility transaction is malformed"
            )
        if entry["status"] != "pending" and (
            entry.get("beforeLock") is not None
            or entry.get("beforeCatalog") is not None
        ):
            raise DshCompatibilityError(
                "completed DSH compatibility transaction retains before-images"
            )
        for key in ("fromObjectSha256", "toObjectSha256"):
            digest = entry.get(key)
            if digest is not None and (
                not isinstance(digest, str) or not SHA256_RE.fullmatch(digest)
            ):
                raise DshCompatibilityError(
                    "DSH compatibility transaction object digest is invalid"
                )

    def _begin_transaction(
        self,
        *,
        plugin_id: str,
        action: str,
        previous: Mapping[str, Any] | None,
        target: Mapping[str, Any] | None,
        before_lock: Mapping[str, Any],
        before_catalog: Mapping[str, Any],
    ) -> str:
        state = self._read_transactions()
        if any(
            entry.get("status") == "pending"
            for entry in state.get("history", [])
            if isinstance(entry, dict)
        ):
            raise DshCompatibilityError(
                "an incomplete DSH compatibility transaction requires inspection"
            )
        operation_id = uuid.uuid4().hex
        state["history"].append(
            {
                "operationId": operation_id,
                "pluginId": plugin_id,
                "action": action,
                "status": "pending",
                "startedAt": _now_iso(),
                "completedAt": None,
                "fromObjectSha256": (
                    previous.get("objectSha256")
                    if previous is not None
                    else None
                ),
                "toObjectSha256": (
                    target.get("objectSha256")
                    if target is not None
                    else None
                ),
                "error": None,
                "beforeLock": copy.deepcopy(dict(before_lock)),
                "beforeCatalog": copy.deepcopy(dict(before_catalog)),
            }
        )
        self._write_transactions(state)
        return operation_id

    def _finish_transaction(
        self,
        operation_id: str,
        *,
        status: str,
        rollback_point: Mapping[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        if status not in {"committed", "rolled-back"}:
            raise ValueError("transaction completion status is invalid")
        state = self._read_transactions()
        entry = next(
            (
                item
                for item in reversed(state["history"])
                if item.get("operationId") == operation_id
            ),
            None,
        )
        if entry is None or entry.get("status") != "pending":
            raise DshCompatibilityError(
                "DSH compatibility transaction completion has no pending operation"
            )
        entry["status"] = status
        entry["completedAt"] = _now_iso()
        entry["error"] = (
            None
            if status == "committed"
            else (str(error or "transaction state update failed")[:4096])
        )
        entry["beforeLock"] = None
        entry["beforeCatalog"] = None
        if status == "committed" and entry.get("action") != "migration":
            plugin_id = str(entry["pluginId"])
            if rollback_point is None:
                state["rollbackPoints"].pop(plugin_id, None)
            else:
                state["rollbackPoints"][plugin_id] = copy.deepcopy(
                    dict(rollback_point)
                )
        self._write_transactions(state)

    @_serialized_state
    def transaction_state(self) -> dict[str, Any]:
        """Return bounded transaction history and rollback availability."""
        state = self._read_transactions()
        return {
            "schema": state["schema"],
            "history": copy.deepcopy(state["history"]),
            "rollbackAvailable": sorted(state["rollbackPoints"]),
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _migrate_legacy_transactions_locked(self) -> None:
        raw = self._read_transaction_file_raw()
        if raw.get("schema") == TRANSACTION_SCHEMA:
            return
        if raw.get("schema") != LEGACY_TRANSACTION_SCHEMA:
            raise DshCompatibilityError(
                "DSH compatibility transaction state failed validation"
            )
        history = raw.get("history")
        if not isinstance(history, list):
            raise DshCompatibilityError(
                "legacy DSH compatibility transaction history is malformed"
            )
        migrated_history: list[dict[str, Any]] = []
        for value in history:
            if not isinstance(value, dict) or value.get("status") == "pending":
                raise DshCompatibilityError(
                    "legacy pending DSH transaction cannot be recovered safely"
                )
            migrated = copy.deepcopy(value)
            migrated["beforeLock"] = None
            migrated["beforeCatalog"] = None
            self._validate_transaction_history_entry(migrated)
            migrated_history.append(migrated)
        state = self._fresh_transactions()
        state["history"] = migrated_history
        migrated_points: dict[str, Any] = {}
        for plugin_id, point in (raw.get("rollbackPoints") or {}).items():
            if (
                not isinstance(plugin_id, str)
                or not isinstance(point, dict)
                or not isinstance(point.get("installation"), dict)
                or not isinstance(point.get("catalogEntry"), dict)
            ):
                continue
            try:
                self._validate_lock_installation(point["installation"])
            except DshCompatibilityError:
                # A v1 rollback point has no signed-package integrity record.
                # Dropping rollback authority is safer than inventing it during
                # migration; the active installation is independently handled
                # by the lock migration below.
                continue
            migrated_points[plugin_id] = copy.deepcopy(point)
        state["rollbackPoints"] = migrated_points
        self._write_transactions(state)

    def _transaction_phase(self, phase: str) -> None:
        if self._transaction_phase_hook is not None:
            self._transaction_phase_hook(phase)

    def _restore_state_snapshots(
        self,
        before_lock: Mapping[str, Any],
        before_catalog: Mapping[str, Any],
    ) -> None:
        validated_lock = self._validate_before_lock_snapshot(before_lock)
        validated_catalog = self._validate_before_catalog_snapshot(
            before_catalog
        )
        self._validate_recovery_snapshot_pair(
            validated_lock,
            validated_catalog,
        )
        self._atomic_write_json(self.lock_path, before_lock)
        self._atomic_write_json(self.catalog_path, before_catalog)

    def _validate_before_lock_snapshot(
        self,
        value: Mapping[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            raise DshCompatibilityError("transaction lock before-image is malformed")
        raw = dict(value)
        self._verify_self_hash(
            raw,
            "lockSha256",
            "transaction lock before-image",
        )
        self._validate_lock_document(
            raw,
            allow_legacy=True,
            label="transaction lock before-image",
        )
        return raw

    def _validate_before_catalog_snapshot(
        self,
        value: Mapping[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            raise DshCompatibilityError(
                "transaction catalog before-image is malformed"
            )
        raw = dict(value)
        self._validate_catalog_document(
            raw,
            label="transaction catalog before-image",
        )
        return raw

    def _validate_recovery_snapshot_pair(
        self,
        lock: Mapping[str, Any],
        catalog: Mapping[str, Any],
    ) -> None:
        entries = catalog["entries"]
        active_ids = {
            str(installation["id"])
            for installation in lock["installations"]
        }
        quarantine_ids = {
            str(item["id"])
            for item in lock.get("legacyQuarantine", [])
        }
        for installation in lock["installations"]:
            plugin_id = str(installation["id"])
            entry = entries.get(plugin_id)
            if not isinstance(entry, dict):
                raise DshCompatibilityError(
                    "transaction before-image cross-consistency failed: "
                    f"catalog entry missing for {plugin_id}"
                )
            comparisons = {
                "id": plugin_id,
                "name": installation.get("name"),
                "version": installation.get("version"),
                "source": installation.get("source"),
                "sourceKind": installation.get("sourceKind"),
                "requestedSpec": installation.get("requestedSpec"),
                "resolvedPackage": installation.get("resolvedPackage"),
                "resolvedVersion": installation.get("resolvedVersion"),
                "npmIntegrity": installation.get("npmIntegrity"),
                "sha256": installation.get("sha256"),
                "archiveSha256": installation.get("archiveSha256"),
                "status": installation.get("status"),
                "statuses": installation.get("statuses"),
                "networkFetched": installation.get("networkFetched"),
                "installedRoot": installation.get("installedRoot"),
                "profileRoot": installation.get("profileRoot"),
                "profileDir": installation.get("profileDir"),
                "bridgeSha256": installation.get("bridgeSha256"),
                "bridgeEntrypoint": installation.get("bridgeEntrypoint"),
                "inventory": installation.get("inventory"),
                "conformance": installation.get("conformance"),
            }
            if any(entry.get(key) != expected for key, expected in comparisons.items()):
                raise DshCompatibilityError(
                    "transaction before-image cross-consistency failed: "
                    f"lock/catalog identity differs for {plugin_id}"
                )
            if (
                entry.get("installed") is not True
                or entry.get("installationState") != "installed"
                or entry.get("installedSha256") != installation.get("sha256")
            ):
                raise DshCompatibilityError(
                    "transaction before-image cross-consistency failed: "
                    f"catalog installation state differs for {plugin_id}"
                )
            if "integrity" in installation and (
                entry.get("integrity") != installation.get("integrity")
                or entry.get("trusted") != installation.get("trusted")
                or entry.get("trustClaims") != installation.get("trustClaims")
            ):
                raise DshCompatibilityError(
                    "transaction before-image cross-consistency failed: "
                    f"catalog integrity authority differs for {plugin_id}"
                )
        for quarantine in lock.get("legacyQuarantine", []):
            installation = quarantine["installation"]
            plugin_id = str(quarantine["id"])
            entry = entries.get(plugin_id)
            if (
                not isinstance(entry, dict)
                or entry.get("id") != plugin_id
                or entry.get("version") != installation.get("version")
                or entry.get("source") != installation.get("source")
                or entry.get("sourceKind") != installation.get("sourceKind")
                or entry.get("installed") is not False
                or entry.get("installationState") != "quarantined-legacy"
                or entry.get("status") != "quarantined"
            ):
                raise DshCompatibilityError(
                    "transaction before-image cross-consistency failed: "
                    f"legacy quarantine differs for {plugin_id}"
                )
        for entry_id, entry in entries.items():
            if entry.get("installed") is True and entry_id not in active_ids:
                raise DshCompatibilityError(
                    "transaction before-image cross-consistency failed: "
                    f"catalog-only installation exists for {entry_id}"
                )
            if (
                entry.get("installationState") == "quarantined-legacy"
                and entry_id not in quarantine_ids
            ):
                raise DshCompatibilityError(
                    "transaction before-image cross-consistency failed: "
                    f"catalog-only legacy quarantine exists for {entry_id}"
                )

    def _reconcile_state_locked(self) -> None:
        state = self._read_transactions()
        pending = [
            entry
            for entry in state["history"]
            if isinstance(entry, dict) and entry.get("status") == "pending"
        ]
        if not pending:
            return
        if len(pending) != 1:
            raise DshCompatibilityError(
                "multiple pending DSH compatibility transactions fail closed"
            )
        entry = pending[0]
        before_lock = entry.get("beforeLock")
        before_catalog = entry.get("beforeCatalog")
        if not isinstance(before_lock, dict) or not isinstance(before_catalog, dict):
            raise DshCompatibilityError(
                "pending DSH compatibility transaction lacks complete before-images"
            )
        self._restore_state_snapshots(before_lock, before_catalog)
        entry["status"] = "rolled-back"
        entry["completedAt"] = _now_iso()
        entry["error"] = (
            "recovered incomplete transaction by restoring journaled before-images"
        )
        entry["beforeLock"] = None
        entry["beforeCatalog"] = None
        self._write_transactions(state)
        self._prune_unreferenced_objects_locked()

    def _prune_unreferenced_objects_locked(self) -> None:
        lock = self._read_lock_file_raw()
        protected = {
            str(item.get("objectSha256"))
            for item in lock.get("installations", [])
            if isinstance(item, dict)
            and isinstance(item.get("objectSha256"), str)
        }
        protected.update(
            str(item.get("installation", {}).get("objectSha256"))
            for item in lock.get("legacyQuarantine", [])
            if isinstance(item, dict)
            and isinstance(item.get("installation"), dict)
            and isinstance(item["installation"].get("objectSha256"), str)
        )
        state = self._read_transactions()
        protected.update(
            str(point.get("installation", {}).get("objectSha256"))
            for point in state["rollbackPoints"].values()
            if isinstance(point, dict)
            and isinstance(point.get("installation"), dict)
            and isinstance(point["installation"].get("objectSha256"), str)
        )
        if not self.objects_dir.is_dir():
            return
        for candidate in self.objects_dir.iterdir():
            if candidate.name in protected:
                continue
            try:
                metadata = candidate.lstat()
            except OSError:
                continue
            if (
                SHA256_RE.fullmatch(candidate.name)
                and stat.S_ISDIR(metadata.st_mode)
                and not stat.S_ISLNK(metadata.st_mode)
                and candidate.parent.resolve() == self.objects_dir.resolve()
            ):
                shutil.rmtree(candidate)

    def _read_catalog(self) -> dict[str, Any]:
        raw = _json_no_duplicates(
            _read_file_no_follow(self.catalog_path, maximum=MAX_PACKAGE_BYTES),
            "DSH compatibility catalog",
        )
        self._validate_catalog_document(
            raw,
            label="DSH compatibility catalog",
        )
        return raw

    def _validate_catalog_document(
        self,
        raw: Mapping[str, Any],
        *,
        label: str,
    ) -> None:
        expected_fields = {
            "schema",
            "workspace",
            "workspaceHash",
            "generatedAt",
            "entries",
            "candidateOnly",
            "canClaimAGI",
        }
        if (
            set(raw) != expected_fields
            or raw.get("schema") != CATALOG_SCHEMA
            or raw.get("workspace") != str(self.workspace)
            or raw.get("workspaceHash") != self.workspace_hash
            or raw.get("candidateOnly") is not True
            or raw.get("canClaimAGI") is not False
            or not isinstance(raw.get("entries"), dict)
        ):
            raise DshCompatibilityError(
                f"{label} failed workspace/schema validation"
            )
        generated_at = raw.get("generatedAt")
        if generated_at is not None and (
            not isinstance(generated_at, str) or not generated_at
        ):
            raise DshCompatibilityError(f"{label} generatedAt is invalid")
        entries = raw["entries"]
        if len(entries) > MAX_PACKAGE_FILES:
            raise DshCompatibilityError(f"{label} has too many entries")
        for entry_id, entry in entries.items():
            self._validate_catalog_entry(
                entry_id,
                entry,
                label=label,
            )

    def _validate_catalog_entry(
        self,
        entry_id: Any,
        entry: Any,
        *,
        label: str,
    ) -> None:
        if (
            not isinstance(entry_id, str)
            or not isinstance(entry, dict)
            or entry.get("schema") != DISCOVERY_SCHEMA
            or entry.get("id") != entry_id
            or (
                not PACKAGE_NAME_RE.fullmatch(entry_id)
                and not re.fullmatch(r"source-[0-9a-f]{24}", entry_id)
            )
            or not isinstance(entry.get("source"), str)
            or not entry["source"]
            or len(entry["source"]) > 8192
            or "\x00" in entry["source"]
            or entry.get("sourceKind")
            not in {
                "unknown",
                "registry-or-network",
                "directory",
                "tarball",
                "remote-tarball",
            }
            or entry.get("status") not in VALID_STATUSES
            or not isinstance(entry.get("statuses"), list)
            or entry["status"] not in entry["statuses"]
            or len(entry["statuses"]) != len(set(entry["statuses"]))
            or any(
                status_value not in VALID_STATUSES
                for status_value in entry["statuses"]
            )
            or entry.get("candidateOnly") is not True
            or entry.get("canClaimAGI") is not False
        ):
            raise DshCompatibilityError(f"{label} entry {entry_id!r} is malformed")
        for key in (
            "manifestValid",
            "installable",
            "installed",
            "approvalRequired",
            "lifecycleScriptsDisabled",
            "networkFetched",
        ):
            if not isinstance(entry.get(key), bool):
                raise DshCompatibilityError(
                    f"{label} entry {entry_id!r} has invalid {key}"
                )
        if entry["lifecycleScriptsDisabled"] is not True:
            raise DshCompatibilityError(
                f"{label} entry {entry_id!r} violates lifecycle safety"
            )
        version = entry.get("version")
        if version is not None and (
            not isinstance(version, str) or not VERSION_RE.fullmatch(version)
        ):
            raise DshCompatibilityError(
                f"{label} entry {entry_id!r} has an invalid version"
            )
        resolved_package = entry.get("resolvedPackage")
        resolved_version = entry.get("resolvedVersion")
        if resolved_package is not None and (
            not isinstance(resolved_package, str)
            or not PACKAGE_NAME_RE.fullmatch(resolved_package)
        ):
            raise DshCompatibilityError(
                f"{label} entry {entry_id!r} has invalid resolved package"
            )
        if resolved_version is not None and (
            not isinstance(resolved_version, str)
            or not VERSION_RE.fullmatch(resolved_version)
        ):
            raise DshCompatibilityError(
                f"{label} entry {entry_id!r} has invalid resolved version"
            )
        for digest_key in (
            "sha256",
            "archiveSha256",
            "installedSha256",
            "bridgeSha256",
        ):
            digest = entry.get(digest_key)
            if digest is not None and (
                not isinstance(digest, str) or not SHA256_RE.fullmatch(digest)
            ):
                raise DshCompatibilityError(
                    f"{label} entry {entry_id!r} has invalid {digest_key}"
                )
        inventory = entry.get("inventory")
        if inventory is not None:
            if not isinstance(inventory, list) or not inventory:
                raise DshCompatibilityError(
                    f"{label} entry {entry_id!r} has invalid inventory"
                )
            previous = ""
            seen: set[str] = set()
            total = 0
            for row in inventory:
                if not isinstance(row, dict) or set(row) != {
                    "path",
                    "size",
                    "sha256",
                }:
                    raise DshCompatibilityError(
                        f"{label} entry {entry_id!r} inventory is malformed"
                    )
                relative = _safe_relative_path(
                    row.get("path"),
                    f"{label} inventory path",
                )
                size = row.get("size")
                digest = row.get("sha256")
                if (
                    relative in seen
                    or relative < previous
                    or not isinstance(size, int)
                    or isinstance(size, bool)
                    or size < 0
                    or size > MAX_FILE_BYTES
                    or not isinstance(digest, str)
                    or not SHA256_RE.fullmatch(digest)
                ):
                    raise DshCompatibilityError(
                        f"{label} entry {entry_id!r} inventory is invalid"
                    )
                previous = relative
                seen.add(relative)
                total += size
            if (
                total > self.max_package_bytes
                or entry.get("fileCount") != len(inventory)
                or entry.get("totalBytes") != total
                or entry.get("sha256") != _inventory_digest(inventory)
            ):
                raise DshCompatibilityError(
                    f"{label} entry {entry_id!r} inventory digest is invalid"
                )
        integrity = entry.get("integrity")
        if integrity is not None:
            self._validate_integrity_record(integrity)
            trusted = bool(integrity["trustedPublisher"])
            expected_claims = (
                ["publisher-identity", "package-bytes"] if trusted else []
            )
            if (
                entry.get("trusted") is not trusted
                or entry.get("trustClaims") != expected_claims
            ):
                raise DshCompatibilityError(
                    f"{label} entry {entry_id!r} integrity authority is inconsistent"
                )
        if entry["installed"]:
            if (
                entry.get("installationState") != "installed"
                or entry.get("installedSha256") != entry.get("sha256")
                or not all(
                    isinstance(entry.get(key), str) and entry.get(key)
                    for key in (
                        "installedRoot",
                        "profileRoot",
                        "profileDir",
                        "bridgeEntrypoint",
                    )
                )
            ):
                raise DshCompatibilityError(
                    f"{label} entry {entry_id!r} installed state is inconsistent"
                )

    def _write_catalog(self, catalog: Mapping[str, Any]) -> None:
        output = copy.deepcopy(dict(catalog))
        output["schema"] = CATALOG_SCHEMA
        output["workspace"] = str(self.workspace)
        output["workspaceHash"] = self.workspace_hash
        output["generatedAt"] = _now_iso()
        output["candidateOnly"] = True
        output["canClaimAGI"] = False
        entries = output.get("entries", {})
        if not isinstance(entries, dict):
            raise DshCompatibilityError("catalog entries must be an object")
        output["entries"] = {key: entries[key] for key in sorted(entries)}
        self._atomic_write_json(self.catalog_path, output)

    def _upsert_catalog(self, record: Mapping[str, Any]) -> None:
        catalog = self._read_catalog()
        item = copy.deepcopy(dict(record))
        if item.get("networkFetched") is True and item.get("requestedSpec"):
            for existing_id, existing in list(catalog["entries"].items()):
                if (
                    existing_id != item.get("id")
                    and isinstance(existing, dict)
                    and existing.get("requestedSpec") == item.get("requestedSpec")
                    and existing.get("fetchState") == "external/unfetched"
                ):
                    catalog["entries"].pop(existing_id, None)
        installed = self._installed_by_id(allow_corrupt=True).get(str(item["id"]))
        if installed is not None:
            item["installed"] = True
            item["installationState"] = "installed"
            item["installedRoot"] = installed.get("installedRoot")
            item["profileRoot"] = installed.get("profileRoot")
            item["profileDir"] = installed.get("profileDir")
            item["bridgeSha256"] = installed.get("bridgeSha256")
            item["bridgeEntrypoint"] = installed.get("bridgeEntrypoint")
            item["installedSha256"] = installed.get("sha256")
            item["updateAvailable"] = installed.get("sha256") != item.get("sha256")
            if not item["updateAvailable"]:
                item["status"] = installed.get("status", item.get("status"))
                item["statuses"] = list(
                    installed.get("statuses", item.get("statuses", []))
                )
                item["conformance"] = copy.deepcopy(installed.get("conformance"))
        catalog["entries"][str(item["id"])] = item
        self._write_catalog(catalog)

    def _catalog_entry_for_installation(
        self,
        installation: Mapping[str, Any],
        base: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        entry = copy.deepcopy(dict(base)) if isinstance(base, Mapping) else {}
        inventory = copy.deepcopy(list(installation.get("inventory") or []))
        entry.update(
            {
                "schema": DISCOVERY_SCHEMA,
                "id": installation["id"],
                "name": installation["name"],
                "version": installation["version"],
                "source": installation["source"],
                "sourceKind": installation["sourceKind"],
                "requestedSpec": installation.get("requestedSpec"),
                "resolvedPackage": installation["resolvedPackage"],
                "resolvedVersion": installation["resolvedVersion"],
                "npmIntegrity": installation.get("npmIntegrity"),
                "fetchState": (
                    "approved/fetched"
                    if installation.get("networkFetched")
                    else "local"
                ),
                "status": installation["status"],
                "statuses": list(installation["statuses"]),
                "manifestValid": True,
                "installable": True,
                "installed": True,
                "installationState": "installed",
                "approvalRequired": False,
                "sha256": installation["sha256"],
                "archiveSha256": installation.get("archiveSha256"),
                "bundlePatch": installation["bundlePatch"],
                "inventory": inventory,
                "fileCount": len(inventory),
                "totalBytes": sum(int(item["size"]) for item in inventory),
                "lifecycleScriptsDisabled": True,
                "networkFetched": bool(installation["networkFetched"]),
                "profileName": installation["profileName"],
                "installedRoot": installation["installedRoot"],
                "profileRoot": installation["profileRoot"],
                "profileDir": installation["profileDir"],
                "bridgeSha256": installation["bridgeSha256"],
                "bridgeEntrypoint": installation["bridgeEntrypoint"],
                "runtimeConfig": str(
                    Path(str(installation["profileDir"])) / "bridge.json"
                ),
                "installedSha256": installation["sha256"],
                "updateAvailable": False,
                "conformance": copy.deepcopy(installation.get("conformance")),
                "integrity": copy.deepcopy(installation["integrity"]),
                "trusted": bool(installation["trusted"]),
                "trustClaims": list(installation["trustClaims"]),
                "compatibilityScope": (
                    "metadata, local package layout, and detached publisher/package "
                    "integrity only; no sandbox, runtime safety, or capability claim"
                ),
                "issues": [],
                "candidateOnly": True,
                "canClaimAGI": False,
            }
        )
        return entry

    def _read_lock_file_raw(self) -> dict[str, Any]:
        raw = _json_no_duplicates(
            _read_file_no_follow(self.lock_path, maximum=MAX_PACKAGE_BYTES),
            "DSH compatibility lock",
        )
        self._verify_self_hash(
            raw,
            "lockSha256",
            "DSH compatibility lock",
        )
        return raw

    def _migrate_legacy_lock_locked(self) -> None:
        raw = self._read_lock_file_raw()
        if raw.get("schema") == LOCK_SCHEMA:
            return
        self._validate_lock_document(
            raw,
            allow_legacy=True,
            label="legacy DSH compatibility lock",
        )
        catalog = self._read_catalog()
        before_lock = copy.deepcopy(raw)
        before_catalog = copy.deepcopy(catalog)
        active: list[dict[str, Any]] = []
        quarantine: list[dict[str, Any]] = []
        for value in raw["installations"]:
            if not isinstance(value, dict):
                raise DshCompatibilityError(
                    "legacy DSH compatibility installation is malformed"
                )
            installation = copy.deepcopy(value)
            plugin_id = str(installation.get("id") or "")
            if (
                not PACKAGE_NAME_RE.fullmatch(plugin_id)
                or installation.get("name") != plugin_id
            ):
                raise DshCompatibilityError(
                    "legacy DSH compatibility installation identity is invalid"
                )
            integrity = installation.get("integrity")
            unverifiable_remote = (
                (
                    installation.get("networkFetched") is True
                    or installation.get("sourceKind") == "remote-tarball"
                )
                and not isinstance(integrity, dict)
            )
            if unverifiable_remote:
                quarantine.append(
                    {
                        "id": plugin_id,
                        "installation": installation,
                        "quarantinedAt": _now_iso(),
                        "reason": (
                            "legacy remote installation lacks verifiable signed "
                            "publisher/package metadata; reinstall the exact "
                            "signed registry release"
                        ),
                    }
                )
                base = catalog["entries"].get(plugin_id)
                item = copy.deepcopy(base) if isinstance(base, dict) else {}
                item.update(
                    {
                        "schema": DISCOVERY_SCHEMA,
                        "id": plugin_id,
                        "name": installation.get("name"),
                        "version": installation.get("version"),
                        "source": installation.get("source"),
                        "sourceKind": installation.get("sourceKind"),
                        "status": "quarantined",
                        "statuses": ["discovered", "quarantined"],
                        "installed": False,
                        "installationState": "quarantined-legacy",
                        "installable": False,
                        "approvalRequired": True,
                        "issues": [
                            "legacy remote installation is quarantined until "
                            "an exact signed release is reinstalled"
                        ],
                        "candidateOnly": True,
                        "canClaimAGI": False,
                    }
                )
                catalog["entries"][plugin_id] = item
                continue
            try:
                current = verify_package_source(
                    Path(str(installation.get("installedRoot") or "")),
                    source_kind=(
                        str(installation.get("sourceKind") or "")
                        if isinstance(integrity, dict)
                        else "directory"
                    ),
                    policy=self.integrity_policy,
                    trust_store_path=self.publisher_trust_path,
                    expected_package_id=plugin_id,
                    expected_version=str(installation.get("version") or ""),
                    max_files=self.max_package_files,
                    max_bytes=self.max_package_bytes,
                ).public_dict()
            except PluginIntegrityError as exc:
                raise DshCompatibilityError(
                    f"legacy local installation failed integrity migration: {exc}"
                ) from exc
            if isinstance(integrity, dict) and current != integrity:
                raise DshCompatibilityError(
                    "legacy installation integrity authority changed during migration"
                )
            installation["integrity"] = current
            installation["trusted"] = bool(current["trustedPublisher"])
            installation["trustClaims"] = (
                ["publisher-identity", "package-bytes"]
                if current["trustedPublisher"]
                else []
            )
            installation["migratedFromSchema"] = LEGACY_LOCK_SCHEMA
            self._validate_lock_installation(installation)
            active.append(installation)
            catalog["entries"][plugin_id] = self._catalog_entry_for_installation(
                installation,
                catalog["entries"].get(plugin_id),
            )

        target = self._fresh_lock()
        target["installations"] = active
        target["legacyQuarantine"] = quarantine
        migrated_plugin_ids = {
            str(item.get("id") or "")
            for item in [*active, *quarantine]
            if isinstance(item, Mapping)
            and PACKAGE_NAME_RE.fullmatch(str(item.get("id") or ""))
        }
        self._rotate_migrated_authority_nonces_locked(
            migrated_plugin_ids
        )
        transaction_id = self._begin_transaction(
            plugin_id=(
                str(raw["installations"][0].get("id"))
                if raw["installations"]
                and isinstance(raw["installations"][0], dict)
                and PACKAGE_NAME_RE.fullmatch(
                    str(raw["installations"][0].get("id") or "")
                )
                else "sophia-lock-migration"
            ),
            action="migration",
            previous=None,
            target=None,
            before_lock=before_lock,
            before_catalog=before_catalog,
        )
        self._transaction_phase("after_journal")
        try:
            self._write_lock(target)
            self._transaction_phase("after_lock")
            self._write_catalog(catalog)
            self._transaction_phase("after_catalog")
            self._finish_transaction(transaction_id, status="committed")
        except Exception as exc:
            self._restore_state_snapshots(before_lock, before_catalog)
            try:
                self._finish_transaction(
                    transaction_id,
                    status="rolled-back",
                    error=f"{type(exc).__name__}: {exc}",
                )
            except Exception:
                pass
            raise
        self._transaction_phase("after_completion")

    def _read_lock_required(self) -> dict[str, Any]:
        raw = self._read_lock_file_raw()
        self._validate_lock_document(
            raw,
            allow_legacy=False,
            label="DSH compatibility lock",
        )
        return raw

    def _validate_lock_document(
        self,
        raw: Mapping[str, Any],
        *,
        allow_legacy: bool,
        label: str,
    ) -> None:
        schema = raw.get("schema")
        if schema == LEGACY_LOCK_SCHEMA and allow_legacy:
            allowed = {
                "schema",
                "workspace",
                "workspaceHash",
                "generatedAt",
                "installations",
                "candidateOnly",
                "canClaimAGI",
                "lockSha256",
            }
        else:
            allowed = {
                "schema",
                "workspace",
                "workspaceHash",
                "generatedAt",
                "installations",
                "legacyQuarantine",
                "candidateOnly",
                "canClaimAGI",
                "lockSha256",
            }
        unknown = sorted(set(raw) - allowed)
        missing = sorted(allowed - set(raw))
        if unknown or missing:
            details = []
            if unknown:
                details.append("unknown: " + ", ".join(unknown))
            if missing:
                details.append("missing: " + ", ".join(missing))
            raise DshCompatibilityError(
                f"{label} fields are invalid ({'; '.join(details)})"
            )
        if (
            schema not in (
                {LOCK_SCHEMA, LEGACY_LOCK_SCHEMA}
                if allow_legacy
                else {LOCK_SCHEMA}
            )
            or raw.get("workspace") != str(self.workspace)
            or raw.get("workspaceHash") != self.workspace_hash
            or raw.get("candidateOnly") is not True
            or raw.get("canClaimAGI") is not False
            or not isinstance(raw.get("installations"), list)
            or (
                schema == LOCK_SCHEMA
                and not isinstance(raw.get("legacyQuarantine"), list)
            )
        ):
            raise DshCompatibilityError(
                f"{label} failed workspace/schema validation"
            )
        generated_at = raw.get("generatedAt")
        if generated_at is not None and (
            not isinstance(generated_at, str) or not generated_at
        ):
            raise DshCompatibilityError(f"{label} generatedAt is invalid")
        if len(raw["installations"]) > MAX_PACKAGE_FILES:
            raise DshCompatibilityError(f"{label} has too many installations")
        seen: set[str] = set()
        for item in raw["installations"]:
            if not isinstance(item, dict):
                raise DshCompatibilityError(
                    f"{label} installation must be an object"
                )
            if schema == LEGACY_LOCK_SCHEMA:
                self._validate_legacy_lock_installation(item)
            else:
                self._validate_lock_installation(item)
            plugin_id = str(item["id"])
            if plugin_id in seen:
                raise DshCompatibilityError(
                    f"{label} contains a duplicate installation id"
                )
            seen.add(plugin_id)
        if schema == LEGACY_LOCK_SCHEMA:
            return
        quarantine_seen: set[str] = set()
        for item in raw["legacyQuarantine"]:
            if (
                not isinstance(item, dict)
                or set(item)
                != {"id", "installation", "quarantinedAt", "reason"}
                or not isinstance(item.get("id"), str)
                or not PACKAGE_NAME_RE.fullmatch(item["id"])
                or item["id"] in seen
                or item["id"] in quarantine_seen
                or not isinstance(item.get("installation"), dict)
                or item["installation"].get("id") != item["id"]
                or not isinstance(item.get("quarantinedAt"), str)
                or not item["quarantinedAt"]
                or not isinstance(item.get("reason"), str)
                or not item["reason"]
            ):
                raise DshCompatibilityError(
                    f"{label} legacy quarantine entry is malformed"
                )
            self._validate_legacy_lock_installation(item["installation"])
            quarantine_seen.add(item["id"])

    def _validate_legacy_lock_installation(
        self,
        value: Mapping[str, Any],
    ) -> None:
        installation = copy.deepcopy(dict(value))
        if (
            "integrity" in installation
            or "migratedFromSchema" in installation
            or installation.get("trusted") is not False
            or installation.get("trustClaims") != []
        ):
            raise DshCompatibilityError(
                "legacy DSH compatibility installation has invalid authority fields"
            )
        installation["integrity"] = {
            "status": "unsigned-local-policy",
            "allowed": True,
            "required": False,
            "signed": False,
            "publisher": None,
            "keyId": None,
            "canonicalArchiveDigest": "sha256:"
            + str(installation.get("sha256") or ""),
            "manifestSha256": None,
            "trustedPublisher": False,
            "revocationChecked": False,
            "reason": "legacy structural validation only",
        }
        installation["trusted"] = False
        installation["trustClaims"] = []
        self._validate_lock_installation(installation)

    def _write_lock(self, lock: Mapping[str, Any]) -> None:
        output = copy.deepcopy(dict(lock))
        output.pop("lockSha256", None)
        output["schema"] = LOCK_SCHEMA
        output["workspace"] = str(self.workspace)
        output["workspaceHash"] = self.workspace_hash
        output["generatedAt"] = _now_iso()
        installations = output.get("installations", [])
        legacy_quarantine = output.get("legacyQuarantine", [])
        if not isinstance(installations, list):
            raise DshCompatibilityError("lock installations must be an array")
        if not isinstance(legacy_quarantine, list):
            raise DshCompatibilityError(
                "lock legacyQuarantine must be an array"
            )
        for installation in installations:
            if not isinstance(installation, dict):
                raise DshCompatibilityError(
                    "lock installation must be an object"
                )
            self._validate_lock_installation(installation)
        output["installations"] = sorted(
            installations, key=lambda item: str(item.get("id", ""))
        )
        output["legacyQuarantine"] = sorted(
            copy.deepcopy(legacy_quarantine),
            key=lambda item: str(item.get("id", "")),
        )
        output["candidateOnly"] = True
        output["canClaimAGI"] = False
        output["lockSha256"] = _sha256_bytes(_canonical_json_bytes(output))
        self._atomic_write_json(self.lock_path, output)

    def _validate_lock_installation(self, item: Mapping[str, Any]) -> None:
        allowed = {
            "id",
            "name",
            "version",
            "source",
            "sourceKind",
            "requestedSpec",
            "resolvedPackage",
            "resolvedVersion",
            "npmIntegrity",
            "sha256",
            "archiveSha256",
            "objectSha256",
            "bridgeSha256",
            "bridgeEntrypoint",
            "bridgeInventory",
            "installedRoot",
            "profileRoot",
            "profileDir",
            "profileName",
            "bundlePatch",
            "inventory",
            "statuses",
            "status",
            "conformance",
            "installedAt",
            "lifecycleScriptsDisabled",
            "networkFetched",
            "integrity",
            "trusted",
            "trustClaims",
            "candidateOnly",
            "canClaimAGI",
            "migratedFromSchema",
        }
        required = allowed - {"migratedFromSchema"}
        if not required <= set(item) or set(item) - allowed:
            unknown = sorted(set(item) - allowed)
            missing = sorted(required - set(item))
            parts = []
            if unknown:
                parts.append("unknown: " + ", ".join(unknown))
            if missing:
                parts.append("missing: " + ", ".join(missing))
            raise DshCompatibilityError(
                "DSH compatibility lock installation fields are invalid"
                + (f" ({'; '.join(parts)})" if parts else "")
            )
        migrated_from = item.get("migratedFromSchema")
        if migrated_from is not None and migrated_from != LEGACY_LOCK_SCHEMA:
            raise DshCompatibilityError(
                "DSH compatibility lock migration provenance is invalid"
            )
        plugin_id = item.get("id")
        name = item.get("name")
        version = item.get("version")
        if (
            not isinstance(plugin_id, str)
            or plugin_id != name
            or not PACKAGE_NAME_RE.fullmatch(plugin_id)
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock installation has an invalid id/name"
            )
        if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
            raise DshCompatibilityError(
                "DSH compatibility lock installation has an invalid version"
            )
        if (
            item.get("resolvedPackage") != name
            or item.get("resolvedVersion") != version
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock resolved package metadata is inconsistent"
            )
        if not isinstance(item.get("source"), str) or not item["source"]:
            raise DshCompatibilityError(
                "DSH compatibility lock installation has an invalid source"
            )
        if item.get("sourceKind") not in {
            "directory",
            "tarball",
            "remote-tarball",
        }:
            raise DshCompatibilityError(
                "DSH compatibility lock installation has an invalid source kind"
            )
        requested_spec = item.get("requestedSpec")
        if requested_spec is not None and (
            not isinstance(requested_spec, str)
            or not requested_spec
            or len(requested_spec) > 8192
            or "\x00" in requested_spec
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock installation has an invalid requested spec"
            )
        npm_integrity = item.get("npmIntegrity")
        if npm_integrity is not None and (
            not isinstance(npm_integrity, str)
            or not npm_integrity
            or len(npm_integrity) > 1024
            or "\x00" in npm_integrity
            or any(character.isspace() for character in npm_integrity)
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock installation has invalid npm integrity"
            )
        for digest_key in ("sha256", "objectSha256", "bridgeSha256"):
            digest = item.get(digest_key)
            if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
                raise DshCompatibilityError(
                    f"DSH compatibility lock installation has invalid {digest_key}"
                )
        if item["objectSha256"] != _sha256_bytes(
            _canonical_json_bytes(
                {
                    "packageSha256": item["sha256"],
                    "bridgeSha256": item["bridgeSha256"],
                }
            )
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock object digest is inconsistent"
            )
        archive_digest = item.get("archiveSha256")
        if archive_digest is not None and (
            not isinstance(archive_digest, str)
            or not SHA256_RE.fullmatch(archive_digest)
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock installation has invalid archiveSha256"
            )
        for path_key in ("installedRoot", "profileRoot", "profileDir"):
            path_value = item.get(path_key)
            if not isinstance(path_value, str) or not path_value:
                raise DshCompatibilityError(
                    f"DSH compatibility lock installation has invalid {path_key}"
                )
            path = Path(path_value)
            if not path.is_absolute() or not self._is_within_private_root(path):
                raise DshCompatibilityError(
                    f"lock installation {path_key} escapes the private root"
                )
        if (
            not isinstance(item.get("profileName"), str)
            or not item["profileName"]
            or item.get("bridgeEntrypoint")
            != _safe_relative_path(
                item.get("bridgeEntrypoint"),
                "lock installation bridgeEntrypoint",
            )
            or not str(item["bridgeEntrypoint"]).casefold().endswith((".js", ".mjs"))
            or item.get("bundlePatch")
            != _safe_relative_path(
                item.get("bundlePatch"),
                "lock installation bundlePatch",
            )
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock installation has invalid profile metadata"
            )
        profile_root = Path(str(item["profileRoot"]))
        profile_dir = Path(str(item["profileDir"]))
        installed_root = Path(str(item["installedRoot"]))
        expected_profile_dir = (
            profile_root / "profiles" / str(item["profileName"])
        )
        expected_installed_root = (
            profile_dir / self._node_modules_relative(str(name))
        )
        if (
            profile_dir != expected_profile_dir
            or installed_root != expected_installed_root
            or profile_root.parent.name != item["objectSha256"]
            or profile_root.name != "runtime"
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock installation paths are inconsistent"
            )
        statuses = item.get("statuses")
        status_value = item.get("status")
        if (
            not isinstance(statuses, list)
            or not statuses
            or len(statuses) != len(set(statuses))
            or any(value not in VALID_STATUSES for value in statuses)
            or status_value not in VALID_STATUSES
            or status_value not in statuses
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock installation has invalid statuses"
            )
        inventory = item.get("inventory")
        if not isinstance(inventory, list) or not inventory:
            raise DshCompatibilityError(
                "DSH compatibility lock installation has invalid inventory"
            )
        seen_paths: set[str] = set()
        previous = ""
        total = 0
        for row in inventory:
            if not isinstance(row, dict) or set(row) != {"path", "size", "sha256"}:
                raise DshCompatibilityError(
                    "DSH compatibility lock inventory entry is malformed"
                )
            relative = _safe_relative_path(
                row.get("path"), "lock installation inventory path"
            )
            size = row.get("size")
            digest = row.get("sha256")
            if (
                relative in seen_paths
                or relative < previous
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
                or size > MAX_FILE_BYTES
                or not isinstance(digest, str)
                or not SHA256_RE.fullmatch(digest)
            ):
                raise DshCompatibilityError(
                    "DSH compatibility lock inventory entry is invalid"
                )
            seen_paths.add(relative)
            previous = relative
            total += size
        if total > self.max_package_bytes:
            raise DshCompatibilityError(
                "DSH compatibility lock inventory exceeds package limit"
            )
        if _inventory_digest(inventory) != item["sha256"]:
            raise DshCompatibilityError(
                "DSH compatibility lock inventory digest mismatch"
            )
        bridge_inventory = item.get("bridgeInventory")
        if not isinstance(bridge_inventory, list) or not bridge_inventory:
            raise DshCompatibilityError(
                "DSH compatibility lock bridge inventory is invalid"
            )
        bridge_paths: set[str] = set()
        bridge_previous = ""
        bridge_total = 0
        for row in bridge_inventory:
            if not isinstance(row, dict) or set(row) != {"path", "size", "sha256"}:
                raise DshCompatibilityError(
                    "DSH compatibility lock bridge inventory entry is malformed"
                )
            relative = _safe_relative_path(
                row.get("path"),
                "lock installation bridge inventory path",
            )
            size = row.get("size")
            digest = row.get("sha256")
            if (
                relative in bridge_paths
                or relative < bridge_previous
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
                or size > MAX_BRIDGE_FILE_BYTES
                or not isinstance(digest, str)
                or not SHA256_RE.fullmatch(digest)
            ):
                raise DshCompatibilityError(
                    "DSH compatibility lock bridge inventory entry is invalid"
                )
            bridge_paths.add(relative)
            bridge_previous = relative
            bridge_total += size
        if (
            len(bridge_inventory) > MAX_BRIDGE_FILES
            or bridge_total > MAX_BRIDGE_BYTES
            or item["bridgeEntrypoint"] not in bridge_paths
            or _inventory_digest(bridge_inventory) != item["bridgeSha256"]
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock bridge inventory digest/closure is invalid"
            )
        if (
            not isinstance(item.get("installedAt"), str)
            or not item["installedAt"]
            or item.get("lifecycleScriptsDisabled") is not True
            or not isinstance(item.get("networkFetched"), bool)
            or item.get("candidateOnly") is not True
            or item.get("canClaimAGI") is not False
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock installation violates safety invariants"
            )
        integrity = item.get("integrity")
        self._validate_integrity_record(integrity)
        trusted = bool(integrity["trustedPublisher"])
        expected_claims = (
            ["publisher-identity", "package-bytes"] if trusted else []
        )
        if (
            item.get("trusted") is not trusted
            or item.get("trustClaims") != expected_claims
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock publisher trust metadata is inconsistent"
            )
        if item["networkFetched"] and (
            requested_spec is None or archive_digest is None
        ):
            raise DshCompatibilityError(
                "network-fetched installation lacks request/archive provenance"
            )
        conformance = item.get("conformance")
        if conformance is not None:
            conformance_fields = {
                "passed",
                "recordedAt",
                "resultSha256",
                "result",
                "packageHealthyAtRecord",
                "candidateOnly",
                "canClaimAGI",
            }
            if (
                not isinstance(conformance, dict)
                or set(conformance) != conformance_fields
                or not isinstance(conformance.get("passed"), bool)
                or not isinstance(conformance.get("recordedAt"), str)
                or not isinstance(conformance.get("resultSha256"), str)
                or not SHA256_RE.fullmatch(conformance["resultSha256"])
                or not isinstance(conformance.get("packageHealthyAtRecord"), bool)
                or conformance.get("candidateOnly") is not True
                or conformance.get("canClaimAGI") is not False
                or _sha256_bytes(
                    _canonical_json_bytes(conformance.get("result"))
                )
                != conformance["resultSha256"]
            ):
                raise DshCompatibilityError(
                    "DSH compatibility lock conformance record is invalid"
                )

    @staticmethod
    def _validate_integrity_record(value: Any) -> None:
        fields = {
            "status",
            "allowed",
            "required",
            "signed",
            "publisher",
            "keyId",
            "canonicalArchiveDigest",
            "manifestSha256",
            "trustedPublisher",
            "revocationChecked",
            "reason",
        }
        if not isinstance(value, dict) or set(value) != fields:
            raise DshCompatibilityError(
                "DSH compatibility lock integrity record fields are invalid"
            )
        for key in (
            "allowed",
            "required",
            "signed",
            "trustedPublisher",
            "revocationChecked",
        ):
            if not isinstance(value.get(key), bool):
                raise DshCompatibilityError(
                    "DSH compatibility lock integrity booleans are invalid"
                )
        digest = value.get("canonicalArchiveDigest")
        if (
            not isinstance(digest, str)
            or not digest.startswith("sha256:")
            or not SHA256_RE.fullmatch(digest[7:])
            or value.get("allowed") is not True
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock integrity digest/allowance is invalid"
            )
        publisher = value.get("publisher")
        if publisher is not None and (
            not isinstance(publisher, str) or not publisher
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock integrity publisher is invalid"
            )
        reason = value.get("reason")
        if reason is not None and (
            not isinstance(reason, str) or not reason
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock integrity reason is invalid"
            )
        if value["signed"]:
            if (
                value.get("status") != "verified"
                or not isinstance(value.get("keyId"), str)
                or not ED25519_KEY_ID_RE.fullmatch(value["keyId"])
                or not isinstance(value.get("manifestSha256"), str)
                or not SHA256_RE.fullmatch(value["manifestSha256"])
                or value.get("trustedPublisher") is not True
                or value.get("revocationChecked") is not True
                or publisher is None
                or reason is not None
            ):
                raise DshCompatibilityError(
                    "DSH compatibility lock verified signature metadata is invalid"
                )
        elif (
            value.get("status")
            not in {"unsigned-local-policy", "unsigned-bundled-policy"}
            or value.get("required") is not False
            or value.get("keyId") is not None
            or value.get("manifestSha256") is not None
            or value.get("trustedPublisher") is not False
            or value.get("revocationChecked") is not False
            or reason is None
        ):
            raise DshCompatibilityError(
                "DSH compatibility lock unsigned policy metadata is invalid"
            )

    def _installed_by_id(
        self, *, allow_corrupt: bool = False
    ) -> dict[str, dict[str, Any]]:
        try:
            lock = self._read_lock_required()
        except DshCompatibilityError:
            if allow_corrupt:
                return {}
            raise
        return {
            str(item["id"]): item
            for item in lock.get("installations", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }

    def _health_installation(
        self, installation: Mapping[str, Any]
    ) -> dict[str, Any]:
        plugin_id = str(installation.get("id") or "")
        issues: list[str] = []
        package_root = Path(str(installation.get("installedRoot") or ""))
        profile_root = Path(str(installation.get("profileRoot") or ""))
        profile_dir = Path(str(installation.get("profileDir") or ""))
        if not self._is_within_private_root(package_root):
            issues.append("installed package root escapes private root")
        if not self._is_within_private_root(profile_root):
            issues.append("generated private DSH_HOME escapes private root")
        if not self._is_within_private_root(profile_dir):
            issues.append("generated DSH profile directory escapes private root")
        if (
            profile_dir
            != profile_root
            / "profiles"
            / str(installation.get("profileName") or "")
        ):
            issues.append("generated DSH profile is not under DSH_HOME/profiles/<name>")
        try:
            expected_package_root = (
                profile_dir / self._node_modules_relative(plugin_id)
            )
        except DshCompatibilityError as exc:
            issues.append(str(exc))
            expected_package_root = Path()
        if package_root != expected_package_root:
            issues.append("installed package root does not match the generated profile")
        if not issues:
            try:
                inventory, _manifest = self._inventory_directory(package_root)
                expected = _inventory_map(installation.get("inventory", []))
                actual = _inventory_map(inventory)
                if actual != expected:
                    issues.append("installed file inventory mismatch")
                if _inventory_digest(inventory) != installation.get("sha256"):
                    issues.append("installed package SHA-256 mismatch")
            except DshCompatibilityError as exc:
                issues.append(str(exc))
            try:
                current_integrity = verify_package_source(
                    package_root,
                    source_kind=str(installation.get("sourceKind") or ""),
                    policy=self.integrity_policy,
                    trust_store_path=self.publisher_trust_path,
                    expected_package_id=plugin_id,
                    expected_version=str(installation.get("version") or ""),
                    max_files=self.max_package_files,
                    max_bytes=self.max_package_bytes,
                )
                if current_integrity.public_dict() != installation.get("integrity"):
                    issues.append(
                        "installed publisher/package integrity authority changed"
                    )
            except PluginIntegrityError as exc:
                issues.append(
                    f"installed publisher/package verification failed: {exc}"
                )
            bridge_root = profile_dir / BRIDGE_DESTINATION
            try:
                bridge_inventory, _bridge_manifest = self._inventory_directory(
                    bridge_root
                )
                copied_inventory = [
                    item
                    for item in bridge_inventory
                    if item["path"] != "package.json"
                ]
                if copied_inventory != installation.get("bridgeInventory"):
                    issues.append("installed Sophia bridge file inventory mismatch")
                if (
                    _inventory_digest(copied_inventory)
                    != installation.get("bridgeSha256")
                ):
                    issues.append("installed Sophia bridge SHA-256 mismatch")
            except DshCompatibilityError as exc:
                issues.append(str(exc))
            for required in (
                profile_dir / "package.json",
                profile_dir / "cordis.yml",
                profile_dir / "cordis.patch.yml",
                profile_dir / "bridge.json",
                bridge_root / "package.json",
                profile_root / "cordis.patch.yml",
            ):
                if required.is_symlink() or not required.is_file():
                    issues.append(
                        f"generated profile file missing or unsafe: {required.name}"
                    )
            for private_directory in (
                profile_root,
                profile_root / "profiles",
                profile_root / "profiles" / "node_modules",
                profile_root / "home",
                profile_root / "tmp",
                profile_dir,
            ):
                try:
                    metadata = private_directory.lstat()
                except OSError:
                    issues.append(
                        f"generated private runtime directory is missing: "
                        f"{private_directory.name}"
                    )
                    continue
                if (
                    stat.S_ISLNK(metadata.st_mode)
                    or not stat.S_ISDIR(metadata.st_mode)
                    or stat.S_IMODE(metadata.st_mode) != 0o700
                    or (
                        hasattr(os, "getuid")
                        and metadata.st_uid != os.getuid()
                    )
                ):
                    issues.append(
                        f"generated private runtime directory is unsafe: "
                        f"{private_directory.name}"
                    )
            try:
                profile_manifest = _json_no_duplicates(
                    _read_file_no_follow(
                        profile_dir / "package.json",
                        maximum=MAX_MANIFEST_BYTES,
                    ),
                    "generated DSH profile package.json",
                )
                dependency_path = package_root.relative_to(profile_dir).as_posix()
                expected_manifest = {
                    "name": f"dsh-profile-{installation['profileName']}",
                    "version": "0.0.0-private",
                    "private": True,
                    "type": "module",
                    "dependencies": {
                        plugin_id: f"file:./{dependency_path}",
                    },
                    "scripts": {},
                    "dsh": {
                        "profile": {
                            "bundles": [
                                "@deepseek-ai/dsh-base",
                                plugin_id,
                            ]
                        }
                    },
                    "sophiaDshCompatibility": {
                        "schema": BRIDGE_SCHEMA,
                        "workspaceHash": self.workspace_hash,
                        "packageSha256": installation.get("sha256"),
                        "bridgeSha256": installation.get("bridgeSha256"),
                        "bridgeEntrypoint": installation.get("bridgeEntrypoint"),
                        "lifecycleScriptsDisabled": True,
                        "networkFetched": bool(
                            installation.get("networkFetched")
                        ),
                        "integrity": copy.deepcopy(
                            installation.get("integrity")
                        ),
                        "trusted": bool(installation.get("trusted")),
                        "trustClaims": list(
                            installation.get("trustClaims") or []
                        ),
                        "candidateOnly": True,
                        "canClaimAGI": False,
                    },
                }
                legacy_expected_manifest = copy.deepcopy(expected_manifest)
                legacy_metadata = legacy_expected_manifest[
                    "sophiaDshCompatibility"
                ]
                legacy_metadata.pop("integrity", None)
                legacy_metadata.pop("trustClaims", None)
                legacy_metadata["trusted"] = False
                legacy_profile_allowed = (
                    installation.get("migratedFromSchema")
                    == LEGACY_LOCK_SCHEMA
                    and profile_manifest == legacy_expected_manifest
                )
                if (
                    profile_manifest != expected_manifest
                    and not legacy_profile_allowed
                ):
                    issues.append("generated DSH profile package.json mismatch")
            except (DshCompatibilityError, ValueError) as exc:
                issues.append(str(exc))
            try:
                loader_entry = (
                    f"./{BRIDGE_DESTINATION}/"
                    f"{installation['bridgeEntrypoint']}"
                )
                expected_patch = (
                    "# Generated Sophia user layer, applied after all bundle layers.\n"
                    "# The copied bridge is candidate-only and makes no trust claim.\n"
                    "- insert:\n"
                    "    - id: sophia-dsh-compat-bridge\n"
                    f"      name: '{loader_entry}'\n"
                    "      config:\n"
                    "        namespace: sophia_dsh\n"
                ).encode("utf-8")
                if (
                    _read_file_no_follow(
                        profile_dir / "cordis.patch.yml",
                        maximum=MAX_MANIFEST_BYTES,
                    )
                    != expected_patch
                ):
                    issues.append("generated DSH profile Cordis patch mismatch")
                bridge_package = _json_no_duplicates(
                    _read_file_no_follow(
                        bridge_root / "package.json",
                        maximum=MAX_MANIFEST_BYTES,
                    ),
                    "generated Sophia bridge package.json",
                )
                if bridge_package != {
                    "name": "@sophia-agi/private-dsh-cordis-bridge",
                    "version": "0.0.0-private",
                    "private": True,
                    "type": "module",
                }:
                    issues.append("generated Sophia bridge package.json mismatch")
            except DshCompatibilityError as exc:
                issues.append(str(exc))
            try:
                bridge = _json_no_duplicates(
                    _read_file_no_follow(
                        profile_dir / "bridge.json",
                        maximum=MAX_MANIFEST_BYTES,
                    ),
                    "generated bridge config",
                )
                expected_runtime = self._runtime_contract(
                    profile_root,
                    profile_dir,
                    str(installation["profileName"]),
                    plugin_id,
                )
                for key, value in expected_runtime.items():
                    if bridge.get(key) != value:
                        issues.append(
                            f"generated bridge config mismatch: {key}"
                        )
                legacy_bridge_allowed = (
                    installation.get("migratedFromSchema")
                    == LEGACY_LOCK_SCHEMA
                    and "integrity" not in bridge
                    and bridge.get("trusted") is False
                    and bridge.get("trustClaims") == []
                )
                current_bridge_allowed = (
                    bridge.get("integrity")
                    == installation.get("integrity")
                    and bridge.get("trusted")
                    is bool(installation.get("trusted"))
                    and bridge.get("trustClaims")
                    == installation.get("trustClaims")
                )
                if (
                    bridge.get("id") != plugin_id
                    or bridge.get("packageSha256") != installation.get("sha256")
                    or bridge.get("bridgeSha256")
                    != installation.get("bridgeSha256")
                    or bridge.get("bridgeEntrypoint")
                    != installation.get("bridgeEntrypoint")
                    or bridge.get("candidateOnly") is not True
                    or bridge.get("canClaimAGI") is not False
                    or not (current_bridge_allowed or legacy_bridge_allowed)
                ):
                    issues.append("generated bridge config safety metadata mismatch")
            except DshCompatibilityError as exc:
                issues.append(str(exc))
        return {
            "id": plugin_id,
            "healthy": not issues,
            "status": installation.get("status", "installable-prebuilt")
            if not issues
            else "blocked",
            "issues": issues,
            "sha256": installation.get("sha256"),
            "bridgeSha256": installation.get("bridgeSha256"),
            "profileRoot": str(profile_root),
            "profileDir": str(profile_dir),
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _record_operation(
        self,
        action: str,
        outcome: str,
        subject: str,
        details: Mapping[str, Any],
    ) -> None:
        operation_id = uuid.uuid4().hex
        timestamp = _now_iso()
        receipt = {
            "schema": RECEIPT_SCHEMA,
            "operationId": operation_id,
            "timestamp": timestamp,
            "action": action,
            "outcome": outcome,
            "subject": subject,
            "workspace": str(self.workspace),
            "workspaceHash": self.workspace_hash,
            "details": copy.deepcopy(dict(details)),
            "trusted": False,
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        event = {
            "schema": EVENT_SCHEMA,
            "operationId": operation_id,
            "timestamp": timestamp,
            "type": f"dsh-compat.{action}",
            "outcome": outcome,
            "subject": subject,
            "receipt": f"receipts/{operation_id}.json",
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        self._atomic_write_json(self.receipts_dir / f"{operation_id}.json", receipt)
        self._atomic_write_json(self.events_dir / f"{operation_id}.json", event)
        line = _canonical_json_bytes(event)
        fd = os.open(
            self.events_jsonl,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_APPEND
            | (os.O_NOFOLLOW if hasattr(os, "O_NOFOLLOW") else 0),
            0o600,
        )
        try:
            os.write(fd, line)
            os.fsync(fd)
        finally:
            os.close(fd)

    # ------------------------------------------------------------------
    # Filesystem helpers
    # ------------------------------------------------------------------
    def _secure_mkdir(self, path: Path) -> None:
        resolved_parent = path.parent.resolve()
        if self.private_root.exists() and path != self.private_root:
            try:
                resolved_parent.relative_to(self.private_root.resolve())
            except ValueError:
                # The initial private-root parent chain is allowed under the
                # selected Sophia state root; all operational writes are not.
                if not str(path).startswith(str(self.private_root)):
                    raise DshCompatibilityError(
                        f"refusing directory outside private root: {path}"
                    )
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        current = path
        while True:
            metadata = current.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise DshCompatibilityError(f"private state path is unsafe: {current}")
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise DshCompatibilityError(
                    f"private state path is not owned by the current user: {current}"
                )
            if current == self.private_root or current == self.state_root:
                break
            if self.private_root in current.parents:
                current = current.parent
                continue
            break
        try:
            os.chmod(path, 0o700)
        except OSError as exc:
            raise DshCompatibilityError(
                f"could not secure private state directory: {path}"
            ) from exc

    def _atomic_write_json(self, path: Path, value: Mapping[str, Any]) -> None:
        self._atomic_write_bytes(path, _canonical_json_bytes(value))

    def _atomic_write_bytes(self, path: Path, value: bytes) -> None:
        self._assert_within_private_root(path)
        self._secure_mkdir(path.parent)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        try:
            _set_private_fd_mode(fd)
            with os.fdopen(fd, "wb") as handle:
                handle.write(value)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            try:
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except Exception:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def _write_bytes_exclusive(self, path: Path, value: bytes) -> None:
        self._assert_within_private_root(path)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path, flags, 0o600)
        try:
            view = memoryview(value)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def _assert_within_private_root(self, path: Path) -> None:
        if not self._is_within_private_root(path):
            raise DshCompatibilityError(f"refusing write outside private root: {path}")

    def _is_within_private_root(self, path: Path) -> bool:
        try:
            path.expanduser().resolve().relative_to(self.private_root.resolve())
            return True
        except (OSError, ValueError):
            return False

    def _remove_unreferenced_object(
        self,
        target: Mapping[str, Any],
        remaining: Iterable[Mapping[str, Any]],
    ) -> None:
        profile_root = Path(str(target.get("profileRoot") or ""))
        object_root = profile_root.parent
        if any(
            Path(str(item.get("profileRoot") or "")).parent == object_root
            for item in remaining
        ):
            return
        try:
            safe_parent = object_root.parent.resolve() == self.objects_dir.resolve()
            metadata = object_root.lstat()
        except OSError:
            return
        if (
            safe_parent
            and self._is_within_private_root(object_root)
            and stat.S_ISDIR(metadata.st_mode)
            and not stat.S_ISLNK(metadata.st_mode)
        ):
            shutil.rmtree(object_root)

    @staticmethod
    def _normalize_id(value: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("DSH compatibility id must be a non-empty string")
        return value.strip()

    def _profile_name(self, package_name: str) -> str:
        package_hash = hashlib.sha256(package_name.encode("utf-8")).hexdigest()[:16]
        return f"sophia-{self.workspace_hash[:16]}-{package_hash}"

    @staticmethod
    def _node_modules_relative(package_name: str) -> Path:
        if not PACKAGE_NAME_RE.fullmatch(package_name):
            raise DshCompatibilityError("invalid package name for private installation")
        parts = package_name.split("/")
        return Path("node_modules", *parts)

    @classmethod
    def _inventory_contains_dependency(
        cls,
        inventory: Mapping[str, Mapping[str, Any]],
        package_name: str,
    ) -> bool:
        dependency_manifest = (
            cls._node_modules_relative(package_name) / "package.json"
        ).as_posix()
        return dependency_manifest in inventory


__all__ = [
    "BRIDGE_SCHEMA",
    "CATALOG_SCHEMA",
    "DISCOVERY_SCHEMA",
    "DshApprovalRequired",
    "DshCompatibilityError",
    "DshCompatibilityManager",
    "EVENT_SCHEMA",
    "LOCK_SCHEMA",
    "RECEIPT_SCHEMA",
    "TRANSACTION_SCHEMA",
    "VALID_STATUSES",
]
