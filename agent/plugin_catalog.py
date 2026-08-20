# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Offline-first, signed discovery catalog for Sophia plugin packages.

The catalog is metadata only. Loading, caching, searching, inspecting, and
selecting an immutable install reference never fetches a package, installs it,
imports plugin code, or grants execution authority. Installation and plugin
permission approval remain separate operator actions owned by the existing
plugin registry/host boundary.

Trust is deliberately decomposed:

* the catalog envelope is signed by a trusted catalog publisher;
* each release may be signed by its own plugin publisher;
* publisher/key trust comes from an operator-owned local trust store;
* compatibility is evaluated independently from identity and signature state;
* signed revocations and quarantine metadata can block reference selection.
"""
from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
import os
import platform as host_platform
import re
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import cmp_to_key
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from agent.plugin_manifest import PLUGIN_API_VERSION, PLUGIN_ID_RE
from agent.runtime_paths import user_state_dir

try:
    import fcntl
except ImportError:  # pragma: no cover - exercised through the explicit test seam
    fcntl = None  # type: ignore[assignment]

CATALOG_SCHEMA = "sophia.plugin-catalog/v1"
TRUST_STORE_SCHEMA = "sophia.plugin-catalog-trust/v1"
CACHE_SCHEMA = "sophia.plugin-catalog-cache/v3"
LEGACY_CACHE_SCHEMA_V2 = "sophia.plugin-catalog-cache/v2"
LEGACY_CACHE_SCHEMA_V1 = "sophia.plugin-catalog-cache/v1"
CACHE_OPERATOR_STATE_SCHEMA = "sophia.plugin-catalog-operator-state/v1"
CACHE_ACCEPTANCE_FLOOR_SCHEMA = (
    "sophia.plugin-catalog-acceptance-floor/v1"
)
CATALOG_SIGNATURE_SCHEMA = "sophia.plugin-catalog-signature/v1"
RELEASE_SIGNATURE_SCHEMA = "sophia.plugin-release-signature/v1"
SIGNATURE_ALGORITHM = "ed25519"

MAX_CATALOG_BYTES = 16 * 1024 * 1024
MAX_TRUST_STORE_BYTES = 1024 * 1024
MAX_PLUGINS = 10_000
MAX_RELEASES_PER_PLUGIN = 256
MAX_PUBLISHERS = 10_000
MAX_REVOCATIONS = 100_000
MAX_SEMVER_LENGTH = 1024
MAX_CACHE_BYTES = 24 * 1024 * 1024
MAX_CACHE_OPERATOR_STATE_BYTES = 16 * 1024

CATALOG_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
KEY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CAPABILITY_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$")
PROTOCOL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$")
SEMVER_RE = re.compile(
    r"^(?P<major>0|[1-9][0-9]*)"
    r"\.(?P<minor>0|[1-9][0-9]*)"
    r"\.(?P<patch>0|[1-9][0-9]*)"
    r"(?:-(?P<prerelease>"
    r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*"
    r"))?"
    r"(?:\+(?P<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)

PUBLISHER_CATALOG_STATUSES = frozenset({"active", "quarantined", "revoked"})
PUBLISHER_TRUST_STATUSES = frozenset({"trusted", "untrusted", "revoked"})
KEY_STATUSES = frozenset({"active", "revoked"})
KEY_USAGES = frozenset({"catalog-signing", "release-signing"})
QUARANTINE_STATUSES = frozenset({"clear", "quarantined"})
ARTIFACT_KINDS = frozenset({"local", "archive", "npm", "github"})
REVOCATION_SCOPES = frozenset(
    {"publisher", "key", "plugin", "release", "artifact"}
)
REVOCATION_ACTIONS = frozenset({"revoke", "restore", "supersede"})

DEFAULT_SUPPORTED_PROTOCOLS = frozenset(
    {
        "sophia.plugin/v1",
        "jsonrpc-stdio/v1",
        "jsonrpc-stdio/v2",
        "dsh-rpc/v2",
    }
)


class PluginCatalogError(ValueError):
    """Raised when catalog, trust, cache, or signature data fails closed."""


class PluginCatalogSelectionError(PluginCatalogError):
    """Raised when no governed install reference can be selected."""


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _format_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _parse_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise PluginCatalogError(f"{label} must be a non-empty RFC3339 timestamp")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise PluginCatalogError(f"{label} must be an RFC3339 timestamp") from exc
    if parsed.tzinfo is None:
        raise PluginCatalogError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def canonical_json_bytes(value: Any) -> bytes:
    """Return the exact canonical JSON representation used for signatures."""
    try:
        rendered = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError, RecursionError) as exc:
        raise PluginCatalogError(
            f"value cannot be canonicalized as JSON: {type(exc).__name__}"
        ) from exc
    return (rendered + "\n").encode("utf-8")


def _json_object_no_duplicates(
    raw: bytes,
    *,
    label: str,
    maximum: int,
) -> dict[str, Any]:
    if len(raw) > maximum:
        raise PluginCatalogError(f"{label} exceeds {maximum} bytes")

    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise PluginCatalogError(
                    f"{label} contains duplicate object key {key!r}"
                )
            result[key] = value
        return result

    try:
        decoded = raw.decode("utf-8")
        value = json.loads(decoded, object_pairs_hook=pairs_hook)
    except UnicodeDecodeError as exc:
        raise PluginCatalogError(f"{label} must be UTF-8 JSON") from exc
    except PluginCatalogError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise PluginCatalogError(f"{label} is malformed JSON") from exc
    if not isinstance(value, dict):
        raise PluginCatalogError(f"{label} must be a JSON object")
    if raw != canonical_json_bytes(value):
        raise PluginCatalogError(
            f"{label} must use Sophia canonical JSON "
            "(UTF-8, sorted keys, compact separators, trailing newline)"
        )
    return value


def _object(
    value: Any,
    label: str,
    *,
    required: Iterable[str] = (),
    allowed: Iterable[str],
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PluginCatalogError(f"{label} must be an object")
    required_set = set(required)
    missing = sorted(required_set - set(value))
    if missing:
        raise PluginCatalogError(
            f"{label} is missing required field(s): {', '.join(missing)}"
        )
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        raise PluginCatalogError(
            f"{label} has unknown field(s): {', '.join(unknown)}"
        )
    return dict(value)


def _text(
    value: Any,
    label: str,
    *,
    maximum: int,
    pattern: re.Pattern[str] | None = None,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        raise PluginCatalogError(f"{label} must be a string")
    text = value.strip()
    if not text and not allow_empty:
        raise PluginCatalogError(f"{label} must be a non-empty string")
    if len(text) > maximum:
        raise PluginCatalogError(f"{label} exceeds {maximum} characters")
    if pattern is not None and not pattern.fullmatch(text):
        raise PluginCatalogError(f"{label} has an invalid format")
    return text


def _integer(
    value: Any,
    label: str,
    *,
    minimum: int = 0,
    maximum: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PluginCatalogError(f"{label} must be an integer")
    if value < minimum or (maximum is not None and value > maximum):
        suffix = (
            f" between {minimum} and {maximum}"
            if maximum is not None
            else f" greater than or equal to {minimum}"
        )
        raise PluginCatalogError(f"{label} must be{suffix}")
    return value


def _string_list(
    value: Any,
    label: str,
    *,
    maximum: int,
    item_maximum: int = 128,
    pattern: re.Pattern[str] | None = None,
) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise PluginCatalogError(f"{label} must be an array")
    if len(value) > maximum:
        raise PluginCatalogError(f"{label} exceeds {maximum} entries")
    result: list[str] = []
    for index, item in enumerate(value):
        text = _text(
            item,
            f"{label}[{index}]",
            maximum=item_maximum,
            pattern=pattern,
        )
        if text in result:
            raise PluginCatalogError(f"{label} contains duplicate value {text!r}")
        result.append(text)
    return tuple(result)


def _decode_base64(value: Any, label: str, *, expected_bytes: int) -> bytes:
    text = _text(value, label, maximum=2048)
    try:
        decoded = base64.b64decode(text, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise PluginCatalogError(f"{label} must be canonical base64") from exc
    if len(decoded) != expected_bytes:
        raise PluginCatalogError(
            f"{label} must decode to exactly {expected_bytes} bytes"
        )
    if base64.b64encode(decoded).decode("ascii") != text:
        raise PluginCatalogError(f"{label} must use canonical base64 padding")
    return decoded


def _decode_bounded_base64(
    value: Any,
    label: str,
    *,
    maximum_bytes: int,
) -> bytes:
    text = _text(
        value,
        label,
        maximum=((maximum_bytes + 2) // 3) * 4,
    )
    try:
        decoded = base64.b64decode(text, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise PluginCatalogError(f"{label} must be canonical base64") from exc
    if len(decoded) > maximum_bytes:
        raise PluginCatalogError(
            f"{label} decodes to more than {maximum_bytes} bytes"
        )
    if base64.b64encode(decoded).decode("ascii") != text:
        raise PluginCatalogError(f"{label} must use canonical base64 padding")
    return decoded


def _file_identity(stat_result: os.stat_result) -> tuple[int, int, int, int]:
    return (
        stat_result.st_dev,
        stat_result.st_ino,
        stat_result.st_size,
        stat_result.st_mtime_ns,
    )


def _read_stable_file(
    path: Path,
    *,
    label: str,
    maximum: int,
) -> bytes:
    """Read one complete file identity, rejecting concurrent replacements."""
    last_error: OSError | None = None
    for _attempt in range(3):
        try:
            before = path.stat()
            with path.open("rb") as handle:
                opened = os.fstat(handle.fileno())
                raw = handle.read(maximum + 1)
                after_read = os.fstat(handle.fileno())
            after = path.stat()
        except OSError as exc:
            last_error = exc
            continue
        identities = {
            _file_identity(before),
            _file_identity(opened),
            _file_identity(after_read),
            _file_identity(after),
        }
        if len(identities) != 1:
            continue
        if len(raw) > maximum:
            raise PluginCatalogError(f"{label} exceeds {maximum} bytes")
        return raw
    if last_error is not None:
        raise PluginCatalogError(
            f"could not read {label}: {type(last_error).__name__}"
        ) from last_error
    raise PluginCatalogError(
        f"{label} changed identity during read; refusing stale trust"
    )


def _atomic_write(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


@dataclass(frozen=True)
class SemVer:
    """Strict SemVer 2.0.0 value with unbounded decimal precedence."""

    original: str
    major: str
    minor: str
    patch: str
    prerelease: tuple[str, ...]
    build: tuple[str, ...]

    @property
    def is_prerelease(self) -> bool:
        return bool(self.prerelease)


def parse_semver(value: Any, label: str = "version") -> SemVer:
    if not isinstance(value, str):
        raise PluginCatalogError(f"{label} must be a SemVer 2.0.0 string")
    version = value.strip()
    if version != value:
        raise PluginCatalogError(f"{label} must be strict SemVer 2.0.0")
    if not version or len(version) > MAX_SEMVER_LENGTH:
        raise PluginCatalogError(
            f"{label} must be a SemVer 2.0.0 string no longer than "
            f"{MAX_SEMVER_LENGTH} characters"
        )
    match = SEMVER_RE.fullmatch(version)
    if match is None:
        raise PluginCatalogError(f"{label} must be strict SemVer 2.0.0")
    prerelease = tuple((match.group("prerelease") or "").split("."))
    if prerelease == ("",):
        prerelease = ()
    build = tuple((match.group("build") or "").split("."))
    if build == ("",):
        build = ()
    return SemVer(
        original=version,
        major=match.group("major"),
        minor=match.group("minor"),
        patch=match.group("patch"),
        prerelease=prerelease,
        build=build,
    )


def _compare_decimal(left: str, right: str) -> int:
    if len(left) != len(right):
        return (len(left) > len(right)) - (len(left) < len(right))
    return (left > right) - (left < right)


def _compare_prerelease(
    left: tuple[str, ...],
    right: tuple[str, ...],
) -> int:
    if not left or not right:
        return (not left) - (not right)
    for left_item, right_item in zip(left, right):
        if left_item == right_item:
            continue
        left_numeric = left_item.isdigit()
        right_numeric = right_item.isdigit()
        if left_numeric and right_numeric:
            return _compare_decimal(left_item, right_item)
        if left_numeric != right_numeric:
            return -1 if left_numeric else 1
        return (left_item > right_item) - (left_item < right_item)
    return (len(left) > len(right)) - (len(left) < len(right))


def compare_semver_precedence(left: str, right: str) -> int:
    """Compare strict SemVer precedence, intentionally ignoring build metadata."""
    parsed_left = parse_semver(left)
    parsed_right = parse_semver(right)
    for left_part, right_part in (
        (parsed_left.major, parsed_right.major),
        (parsed_left.minor, parsed_right.minor),
        (parsed_left.patch, parsed_right.patch),
    ):
        comparison = _compare_decimal(left_part, right_part)
        if comparison:
            return comparison
    return _compare_prerelease(
        parsed_left.prerelease,
        parsed_right.prerelease,
    )


def _normalize_architecture(value: str) -> str:
    normalized = value.strip().casefold()
    if normalized in {"arm64", "aarch64"}:
        return "arm64"
    if normalized in {"x86_64", "amd64"}:
        return "x86_64"
    return normalized


def catalog_signature_payload(document: Mapping[str, Any]) -> bytes:
    """Build the canonical catalog-publisher signature payload."""
    unsigned = {key: value for key, value in document.items() if key != "signature"}
    return canonical_json_bytes(
        {
            "schemaVersion": CATALOG_SIGNATURE_SCHEMA,
            "catalog": unsigned,
        }
    )


def release_signature_payload(
    *,
    plugin_id: str,
    publisher_id: str,
    release: Mapping[str, Any],
) -> bytes:
    """Build the canonical publisher-signature payload for one release."""
    unsigned_release = {
        key: value
        for key, value in release.items()
        if key != "publisherSignature"
    }
    return canonical_json_bytes(
        {
            "schemaVersion": RELEASE_SIGNATURE_SCHEMA,
            "pluginId": plugin_id,
            "publisherId": publisher_id,
            "release": unsigned_release,
        }
    )


@dataclass(frozen=True)
class CatalogEnvironment:
    """Local compatibility facts used for passive catalog evaluation."""

    sophia_api: str = PLUGIN_API_VERSION
    platform: str = sys.platform
    architecture: str = host_platform.machine()
    protocols: frozenset[str] = DEFAULT_SUPPORTED_PROTOCOLS

    @classmethod
    def current(
        cls,
        *,
        protocols: Iterable[str] | None = None,
        platform: str | None = None,
        architecture: str | None = None,
    ) -> "CatalogEnvironment":
        return cls(
            platform=(platform or sys.platform).strip().casefold(),
            architecture=_normalize_architecture(
                architecture or host_platform.machine()
            ),
            protocols=frozenset(
                str(item).strip()
                for item in (
                    protocols
                    if protocols is not None
                    else DEFAULT_SUPPORTED_PROTOCOLS
                )
                if str(item).strip()
            ),
        )

    def public_dict(self) -> dict[str, Any]:
        return {
            "sophiaApi": self.sophia_api,
            "platform": self.platform,
            "architecture": _normalize_architecture(self.architecture),
            "protocols": sorted(self.protocols),
        }


@dataclass(frozen=True)
class CompatibilityEvaluation:
    status: str
    reasons: tuple[str, ...]

    def public_dict(self) -> dict[str, Any]:
        return {"status": self.status, "reasons": list(self.reasons)}


@dataclass(frozen=True)
class TrustedKey:
    publisher_id: str
    publisher_status: str
    key_id: str
    key_status: str
    usage: str
    public_key: bytes


class PluginCatalogTrustStore:
    """Operator-owned publisher/key trust, separate from catalog metadata."""

    def __init__(
        self,
        *,
        raw: Mapping[str, Any],
        publishers: Mapping[str, Mapping[str, Any]],
        keys: Mapping[tuple[str, str], TrustedKey],
        catalog_bindings: Mapping[str, Mapping[str, Any]],
        source: str,
    ):
        self.raw = dict(raw)
        self.publishers = {
            key: dict(value) for key, value in publishers.items()
        }
        self.keys = dict(keys)
        self.catalog_bindings = {
            key: dict(value) for key, value in catalog_bindings.items()
        }
        self.source = source
        self.digest = "sha256:" + hashlib.sha256(
            canonical_json_bytes(self.raw)
        ).hexdigest()

    @classmethod
    def load(cls, path: str | Path) -> "PluginCatalogTrustStore":
        source = Path(path).expanduser().resolve()
        raw_bytes = _read_stable_file(
            source,
            label="plugin catalog trust store",
            maximum=MAX_TRUST_STORE_BYTES,
        )
        return cls.from_bytes(raw_bytes, source=str(source))

    @classmethod
    def from_bytes(
        cls,
        raw_bytes: bytes,
        *,
        source: str = "<memory>",
    ) -> "PluginCatalogTrustStore":
        raw = _json_object_no_duplicates(
            raw_bytes,
            label="plugin catalog trust store",
            maximum=MAX_TRUST_STORE_BYTES,
        )
        _object(
            raw,
            "plugin catalog trust store",
            required=(
                "schemaVersion",
                "catalogBindings",
                "publishers",
                "candidateOnly",
                "canClaimAGI",
            ),
            allowed=(
                "schemaVersion",
                "catalogBindings",
                "publishers",
                "candidateOnly",
                "canClaimAGI",
            ),
        )
        if raw["schemaVersion"] != TRUST_STORE_SCHEMA:
            raise PluginCatalogError(
                f"trust store schemaVersion must be {TRUST_STORE_SCHEMA}"
            )
        if raw["candidateOnly"] is not True or raw["canClaimAGI"] is not False:
            raise PluginCatalogError(
                "trust store must preserve candidateOnly=true and canClaimAGI=false"
            )
        publisher_rows = raw["publishers"]
        if not isinstance(publisher_rows, list):
            raise PluginCatalogError("trust store publishers must be an array")
        if len(publisher_rows) > MAX_PUBLISHERS:
            raise PluginCatalogError(
                f"trust store exceeds {MAX_PUBLISHERS} publishers"
            )

        publishers: dict[str, dict[str, Any]] = {}
        keys: dict[tuple[str, str], TrustedKey] = {}
        material_identities: dict[bytes, tuple[str, str]] = {}
        for index, value in enumerate(publisher_rows):
            label = f"trust store publishers[{index}]"
            item = _object(
                value,
                label,
                required=("id", "name", "status", "keys"),
                allowed=("id", "name", "status", "keys"),
            )
            publisher_id = _text(
                item["id"],
                f"{label}.id",
                maximum=96,
                pattern=PLUGIN_ID_RE,
            )
            if publisher_id in publishers:
                raise PluginCatalogError(
                    f"duplicate trust-store publisher id {publisher_id}"
                )
            status = _text(item["status"], f"{label}.status", maximum=32)
            if status not in PUBLISHER_TRUST_STATUSES:
                raise PluginCatalogError(
                    f"{label}.status must be one of: "
                    + ", ".join(sorted(PUBLISHER_TRUST_STATUSES))
                )
            key_rows = item["keys"]
            if not isinstance(key_rows, list) or not key_rows:
                raise PluginCatalogError(f"{label}.keys must be a non-empty array")
            parsed_keys: list[dict[str, Any]] = []
            for key_index, key_value in enumerate(key_rows):
                key_label = f"{label}.keys[{key_index}]"
                key_item = _object(
                    key_value,
                    key_label,
                    required=(
                        "keyId",
                        "algorithm",
                        "publicKey",
                        "status",
                        "usage",
                    ),
                    allowed=(
                        "keyId",
                        "algorithm",
                        "publicKey",
                        "status",
                        "usage",
                    ),
                )
                key_id = _text(
                    key_item["keyId"],
                    f"{key_label}.keyId",
                    maximum=128,
                    pattern=KEY_ID_RE,
                )
                identity = (publisher_id, key_id)
                if identity in keys:
                    raise PluginCatalogError(
                        f"duplicate trust-store key {publisher_id}/{key_id}"
                    )
                algorithm = _text(
                    key_item["algorithm"],
                    f"{key_label}.algorithm",
                    maximum=32,
                )
                if algorithm != SIGNATURE_ALGORITHM:
                    raise PluginCatalogError(
                        f"{key_label}.algorithm must be {SIGNATURE_ALGORITHM}"
                    )
                key_status = _text(
                    key_item["status"],
                    f"{key_label}.status",
                    maximum=32,
                )
                if key_status not in KEY_STATUSES:
                    raise PluginCatalogError(
                        f"{key_label}.status must be one of: "
                        + ", ".join(sorted(KEY_STATUSES))
                    )
                usage = _text(
                    key_item["usage"],
                    f"{key_label}.usage",
                    maximum=32,
                )
                if usage not in KEY_USAGES:
                    raise PluginCatalogError(
                        f"{key_label}.usage must be one of: "
                        + ", ".join(sorted(KEY_USAGES))
                    )
                public_key = _decode_base64(
                    key_item["publicKey"],
                    f"{key_label}.publicKey",
                    expected_bytes=32,
                )
                prior_identity = material_identities.get(public_key)
                if prior_identity is not None:
                    raise PluginCatalogError(
                        "trust-store key material must be globally unique; "
                        f"{publisher_id}/{key_id} aliases "
                        f"{prior_identity[0]}/{prior_identity[1]}"
                    )
                material_identities[public_key] = identity
                keys[identity] = TrustedKey(
                    publisher_id=publisher_id,
                    publisher_status=status,
                    key_id=key_id,
                    key_status=key_status,
                    usage=usage,
                    public_key=public_key,
                )
                parsed_keys.append(
                    {
                        "keyId": key_id,
                        "algorithm": algorithm,
                        "publicKey": key_item["publicKey"],
                        "status": key_status,
                        "usage": usage,
                    }
                )
            publishers[publisher_id] = {
                "id": publisher_id,
                "name": _text(
                    item["name"],
                    f"{label}.name",
                    maximum=120,
                ),
                "status": status,
                "keys": parsed_keys,
            }
        binding_rows = raw["catalogBindings"]
        if not isinstance(binding_rows, list):
            raise PluginCatalogError("trust store catalogBindings must be an array")
        if len(binding_rows) > MAX_PUBLISHERS:
            raise PluginCatalogError(
                f"trust store exceeds {MAX_PUBLISHERS} catalog bindings"
            )
        catalog_bindings: dict[str, dict[str, Any]] = {}
        for index, value in enumerate(binding_rows):
            label = f"trust store catalogBindings[{index}]"
            item = _object(
                value,
                label,
                required=("catalogId", "publisherId", "keyIds"),
                allowed=("catalogId", "publisherId", "keyIds"),
            )
            catalog_id = _text(
                item["catalogId"],
                f"{label}.catalogId",
                maximum=96,
                pattern=CATALOG_ID_RE,
            )
            if catalog_id in catalog_bindings:
                raise PluginCatalogError(
                    f"duplicate trust-store catalog binding {catalog_id}"
                )
            publisher_id = _text(
                item["publisherId"],
                f"{label}.publisherId",
                maximum=96,
                pattern=PLUGIN_ID_RE,
            )
            if publisher_id not in publishers:
                raise PluginCatalogError(
                    f"{label}.publisherId references an unknown publisher"
                )
            key_ids = _string_list(
                item["keyIds"],
                f"{label}.keyIds",
                maximum=64,
                item_maximum=128,
                pattern=KEY_ID_RE,
            )
            if not key_ids:
                raise PluginCatalogError(
                    f"{label}.keyIds must be a non-empty array"
                )
            for key_id in key_ids:
                key = keys.get((publisher_id, key_id))
                if key is None:
                    raise PluginCatalogError(
                        f"{label}.keyIds references unknown key "
                        f"{publisher_id}/{key_id}"
                    )
                if key.usage != "catalog-signing":
                    raise PluginCatalogError(
                        f"{label}.keyIds must reference catalog-signing keys"
                    )
            catalog_bindings[catalog_id] = {
                "catalogId": catalog_id,
                "publisherId": publisher_id,
                "keyIds": list(key_ids),
            }
        normalized = {
            "schemaVersion": TRUST_STORE_SCHEMA,
            "catalogBindings": [
                catalog_bindings[key] for key in catalog_bindings
            ],
            "publishers": [publishers[key] for key in publishers],
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        if normalized != raw:
            raise PluginCatalogError(
                "trust store values are not in normalized canonical form"
            )
        return cls(
            raw=normalized,
            publishers=publishers,
            keys=keys,
            catalog_bindings=catalog_bindings,
            source=source,
        )

    def publisher_status(self, publisher_id: str) -> str:
        publisher = self.publishers.get(publisher_id)
        if publisher is None:
            return "unknown"
        return str(publisher["status"])

    def catalog_authority_status(
        self,
        *,
        catalog_id: str,
        publisher_id: str,
        key_id: str,
    ) -> str:
        binding = self.catalog_bindings.get(catalog_id)
        if binding is None:
            return "unbound-catalog"
        if binding["publisherId"] != publisher_id:
            return "unauthorized-publisher"
        if key_id not in binding["keyIds"]:
            return "unauthorized-key"
        return "authorized"

    def verify(
        self,
        *,
        publisher_id: str,
        signature: Mapping[str, Any] | None,
        payload: bytes,
        required_usage: str,
    ) -> dict[str, Any]:
        """Return cryptographic signature state without conflating trust."""
        if required_usage not in KEY_USAGES:
            raise PluginCatalogError(
                f"required key usage must be one of: "
                + ", ".join(sorted(KEY_USAGES))
            )
        if signature is None:
            return {
                "status": "missing",
                "keyId": None,
                "algorithm": None,
                "keyUsage": None,
                "requiredUsage": required_usage,
            }
        item = _object(
            signature,
            "signature",
            required=("algorithm", "keyId", "value"),
            allowed=("algorithm", "keyId", "value"),
        )
        algorithm = _text(item["algorithm"], "signature.algorithm", maximum=32)
        key_id = _text(
            item["keyId"],
            "signature.keyId",
            maximum=128,
            pattern=KEY_ID_RE,
        )
        if algorithm != SIGNATURE_ALGORITHM:
            return {
                "status": "unsupported-algorithm",
                "keyId": key_id,
                "algorithm": algorithm,
                "keyUsage": None,
                "requiredUsage": required_usage,
            }
        key = self.keys.get((publisher_id, key_id))
        if key is None:
            return {
                "status": "unknown-key",
                "keyId": key_id,
                "algorithm": algorithm,
                "keyUsage": None,
                "requiredUsage": required_usage,
            }
        if key.key_status == "revoked":
            return {
                "status": "revoked-key",
                "keyId": key_id,
                "algorithm": algorithm,
                "keyUsage": key.usage,
                "requiredUsage": required_usage,
            }
        if key.usage != required_usage:
            return {
                "status": "wrong-key-usage",
                "keyId": key_id,
                "algorithm": algorithm,
                "keyUsage": key.usage,
                "requiredUsage": required_usage,
            }
        try:
            signature_bytes = _decode_base64(
                item["value"],
                "signature.value",
                expected_bytes=64,
            )
        except PluginCatalogError:
            return {
                "status": "invalid",
                "keyId": key_id,
                "algorithm": algorithm,
                "keyUsage": key.usage,
                "requiredUsage": required_usage,
            }
        try:
            Ed25519PublicKey.from_public_bytes(key.public_key).verify(
                signature_bytes,
                payload,
            )
        except (InvalidSignature, ValueError):
            return {
                "status": "invalid",
                "keyId": key_id,
                "algorithm": algorithm,
                "keyUsage": key.usage,
                "requiredUsage": required_usage,
            }
        return {
            "status": "valid",
            "keyId": key_id,
            "algorithm": algorithm,
            "keyUsage": key.usage,
            "requiredUsage": required_usage,
        }


def _parse_platform_rows(value: Any, label: str) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, list):
        raise PluginCatalogError(f"{label} must be an array")
    if len(value) > 64:
        raise PluginCatalogError(f"{label} exceeds 64 entries")
    rows: list[dict[str, Any]] = []
    identities: set[tuple[str, tuple[str, ...]]] = set()
    for index, row in enumerate(value):
        row_label = f"{label}[{index}]"
        item = _object(
            row,
            row_label,
            required=("os", "architectures"),
            allowed=("os", "architectures"),
        )
        os_name = _text(item["os"], f"{row_label}.os", maximum=64).casefold()
        architectures = tuple(
            _normalize_architecture(value)
            for value in _string_list(
                item["architectures"],
                f"{row_label}.architectures",
                maximum=32,
                item_maximum=64,
            )
        )
        identity = (os_name, architectures)
        if identity in identities:
            raise PluginCatalogError(f"{label} contains duplicate platform row")
        identities.add(identity)
        rows.append({"os": os_name, "architectures": list(architectures)})
    return tuple(rows)


def _parse_artifact(value: Any, label: str) -> dict[str, Any]:
    item = _object(
        value,
        label,
        required=("kind", "reference", "sha256"),
        allowed=("kind", "reference", "sha256", "sizeBytes"),
    )
    kind = _text(item["kind"], f"{label}.kind", maximum=32)
    if kind not in ARTIFACT_KINDS:
        raise PluginCatalogError(
            f"{label}.kind must be one of: {', '.join(sorted(ARTIFACT_KINDS))}"
        )
    artifact = {
        "kind": kind,
        "reference": _text(
            item["reference"],
            f"{label}.reference",
            maximum=2048,
        ),
        "sha256": _text(
            item["sha256"],
            f"{label}.sha256",
            maximum=71,
            pattern=SHA256_RE,
        ),
    }
    if "sizeBytes" in item:
        artifact["sizeBytes"] = _integer(
            item["sizeBytes"],
            f"{label}.sizeBytes",
            minimum=1,
            maximum=2**63 - 1,
        )
    return artifact


def _parse_compatibility(value: Any, label: str) -> dict[str, Any]:
    item = _object(
        value,
        label,
        required=("sophiaApi", "protocols", "platforms"),
        allowed=("sophiaApi", "protocols", "platforms"),
    )
    return {
        "sophiaApi": _text(
            item["sophiaApi"],
            f"{label}.sophiaApi",
            maximum=32,
        ),
        "protocols": list(
            _string_list(
                item["protocols"],
                f"{label}.protocols",
                maximum=64,
                pattern=PROTOCOL_RE,
            )
        ),
        "platforms": list(
            _parse_platform_rows(item["platforms"], f"{label}.platforms")
        ),
    }


def _parse_quarantine(value: Any, label: str) -> dict[str, Any]:
    item = _object(
        value,
        label,
        required=("status",),
        allowed=("status", "reason"),
    )
    status = _text(item["status"], f"{label}.status", maximum=32)
    if status not in QUARANTINE_STATUSES:
        raise PluginCatalogError(
            f"{label}.status must be one of: "
            + ", ".join(sorted(QUARANTINE_STATUSES))
        )
    parsed = {"status": status}
    reason = ""
    if "reason" in item:
        reason = _text(
            item["reason"],
            f"{label}.reason",
            maximum=1000,
            allow_empty=True,
        )
        parsed["reason"] = reason
    if status == "quarantined" and not reason:
        raise PluginCatalogError(
            f"{label}.reason is required when status is quarantined"
        )
    return parsed


def _parse_optional_signature(value: Any, label: str) -> dict[str, Any] | None:
    if value is None:
        return None
    item = _object(
        value,
        label,
        required=("algorithm", "keyId", "value"),
        allowed=("algorithm", "keyId", "value"),
    )
    return {
        "algorithm": _text(
            item["algorithm"],
            f"{label}.algorithm",
            maximum=32,
        ),
        "keyId": _text(
            item["keyId"],
            f"{label}.keyId",
            maximum=128,
            pattern=KEY_ID_RE,
        ),
        "value": _text(item["value"], f"{label}.value", maximum=2048),
    }


def _parse_release(value: Any, label: str) -> dict[str, Any]:
    item = _object(
        value,
        label,
        required=(
            "version",
            "publishedAt",
            "artifact",
            "compatibility",
            "publisherSignature",
            "quarantine",
        ),
        allowed=(
            "version",
            "publishedAt",
            "artifact",
            "compatibility",
            "publisherSignature",
            "quarantine",
        ),
    )
    version = parse_semver(item["version"], f"{label}.version").original
    published = _parse_time(item["publishedAt"], f"{label}.publishedAt")
    return {
        "version": version,
        "publishedAt": _format_time(published),
        "artifact": _parse_artifact(item["artifact"], f"{label}.artifact"),
        "compatibility": _parse_compatibility(
            item["compatibility"],
            f"{label}.compatibility",
        ),
        "publisherSignature": _parse_optional_signature(
            item.get("publisherSignature"),
            f"{label}.publisherSignature",
        ),
        "quarantine": _parse_quarantine(
            item["quarantine"],
            f"{label}.quarantine",
        ),
    }


def _parse_catalog_publisher(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        "catalogPublisher",
        required=("id", "name", "keyId"),
        allowed=("id", "name", "keyId"),
    )
    return {
        "id": _text(
            item["id"],
            "catalogPublisher.id",
            maximum=96,
            pattern=PLUGIN_ID_RE,
        ),
        "name": _text(item["name"], "catalogPublisher.name", maximum=120),
        "keyId": _text(
            item["keyId"],
            "catalogPublisher.keyId",
            maximum=128,
            pattern=KEY_ID_RE,
        ),
    }


def _parse_catalog_publishers(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, list):
        raise PluginCatalogError("catalog publishers must be an array")
    if len(value) > MAX_PUBLISHERS:
        raise PluginCatalogError(
            f"catalog exceeds {MAX_PUBLISHERS} publisher records"
        )
    publishers: dict[str, dict[str, Any]] = {}
    for index, value_item in enumerate(value):
        label = f"publishers[{index}]"
        item = _object(
            value_item,
            label,
            required=("id", "name", "status"),
            allowed=("id", "name", "status", "homepage"),
        )
        publisher_id = _text(
            item["id"],
            f"{label}.id",
            maximum=96,
            pattern=PLUGIN_ID_RE,
        )
        if publisher_id in publishers:
            raise PluginCatalogError(
                f"duplicate catalog publisher id {publisher_id}"
            )
        status = _text(item["status"], f"{label}.status", maximum=32)
        if status not in PUBLISHER_CATALOG_STATUSES:
            raise PluginCatalogError(
                f"{label}.status must be one of: "
                + ", ".join(sorted(PUBLISHER_CATALOG_STATUSES))
            )
        parsed: dict[str, Any] = {
            "id": publisher_id,
            "name": _text(item["name"], f"{label}.name", maximum=120),
            "status": status,
        }
        if "homepage" in item:
            parsed["homepage"] = _text(
                item["homepage"],
                f"{label}.homepage",
                maximum=2048,
            )
        publishers[publisher_id] = parsed
    return publishers


def _parse_plugins(
    value: Any,
    *,
    publishers: Mapping[str, Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    if not isinstance(value, list):
        raise PluginCatalogError("plugins must be an array")
    if len(value) > MAX_PLUGINS:
        raise PluginCatalogError(f"catalog exceeds {MAX_PLUGINS} plugins")
    plugins: dict[str, dict[str, Any]] = {}
    for index, value_item in enumerate(value):
        label = f"plugins[{index}]"
        item = _object(
            value_item,
            label,
            required=(
                "id",
                "name",
                "summary",
                "publisherId",
                "contributions",
                "capabilities",
                "protocols",
                "tags",
                "releases",
            ),
            allowed=(
                "id",
                "name",
                "summary",
                "publisherId",
                "contributions",
                "capabilities",
                "protocols",
                "tags",
                "releases",
            ),
        )
        plugin_id = _text(
            item["id"],
            f"{label}.id",
            maximum=96,
            pattern=PLUGIN_ID_RE,
        )
        if plugin_id in plugins:
            raise PluginCatalogError(f"duplicate plugin id {plugin_id}")
        publisher_id = _text(
            item["publisherId"],
            f"{label}.publisherId",
            maximum=96,
            pattern=PLUGIN_ID_RE,
        )
        if publisher_id not in publishers:
            raise PluginCatalogError(
                f"{label}.publisherId is not declared in catalog publishers"
            )
        releases_value = item["releases"]
        if not isinstance(releases_value, list) or not releases_value:
            raise PluginCatalogError(f"{label}.releases must be a non-empty array")
        if len(releases_value) > MAX_RELEASES_PER_PLUGIN:
            raise PluginCatalogError(
                f"{label}.releases exceeds {MAX_RELEASES_PER_PLUGIN} entries"
            )
        releases: list[dict[str, Any]] = []
        versions: set[str] = set()
        for release_index, release_value in enumerate(releases_value):
            release = _parse_release(
                release_value,
                f"{label}.releases[{release_index}]",
            )
            if release["version"] in versions:
                raise PluginCatalogError(
                    f"{label}.releases contains duplicate version "
                    f"{release['version']}"
                )
            versions.add(str(release["version"]))
            releases.append(release)
        protocols = _string_list(
            item["protocols"],
            f"{label}.protocols",
            maximum=64,
            pattern=PROTOCOL_RE,
        )
        for release in releases:
            undeclared = sorted(
                set(release["compatibility"]["protocols"]) - set(protocols)
            )
            if undeclared:
                raise PluginCatalogError(
                    f"{label} release {release['version']} uses protocol(s) "
                    f"not declared by the plugin: {', '.join(undeclared)}"
                )
        plugins[plugin_id] = {
            "id": plugin_id,
            "name": _text(item["name"], f"{label}.name", maximum=120),
            "summary": _text(
                item["summary"],
                f"{label}.summary",
                maximum=2000,
                allow_empty=True,
            ),
            "publisherId": publisher_id,
            "contributions": list(
                _string_list(
                    item["contributions"],
                    f"{label}.contributions",
                    maximum=64,
                    pattern=CAPABILITY_RE,
                )
            ),
            "capabilities": list(
                _string_list(
                    item["capabilities"],
                    f"{label}.capabilities",
                    maximum=128,
                    pattern=CAPABILITY_RE,
                )
            ),
            "protocols": list(protocols),
            "tags": list(
                _string_list(
                    item["tags"],
                    f"{label}.tags",
                    maximum=128,
                    item_maximum=96,
                    pattern=CAPABILITY_RE,
                )
            ),
            "releases": releases,
        }
    return plugins


def _parse_revocations(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, list):
        raise PluginCatalogError("revocations must be an array")
    if len(value) > MAX_REVOCATIONS:
        raise PluginCatalogError(
            f"catalog exceeds {MAX_REVOCATIONS} revocations"
        )
    revocations: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for index, value_item in enumerate(value):
        label = f"revocations[{index}]"
        item = _object(
            value_item,
            label,
            required=("id", "action", "scope", "effectiveAt", "reason"),
            allowed=(
                "id",
                "action",
                "scope",
                "publisherId",
                "keyId",
                "pluginId",
                "version",
                "artifactSha256",
                "supersedes",
                "effectiveAt",
                "reason",
            ),
        )
        revocation_id = _text(
            item["id"],
            f"{label}.id",
            maximum=128,
            pattern=KEY_ID_RE,
        )
        if revocation_id in identifiers:
            raise PluginCatalogError(f"duplicate revocation id {revocation_id}")
        identifiers.add(revocation_id)
        action = _text(item["action"], f"{label}.action", maximum=32)
        if action not in REVOCATION_ACTIONS:
            raise PluginCatalogError(
                f"{label}.action must be one of: "
                + ", ".join(sorted(REVOCATION_ACTIONS))
            )
        scope = _text(item["scope"], f"{label}.scope", maximum=32)
        if scope not in REVOCATION_SCOPES:
            raise PluginCatalogError(
                f"{label}.scope must be one of: "
                + ", ".join(sorted(REVOCATION_SCOPES))
            )
        parsed: dict[str, Any] = {
            "id": revocation_id,
            "action": action,
            "scope": scope,
            "effectiveAt": _format_time(
                _parse_time(item["effectiveAt"], f"{label}.effectiveAt")
            ),
            "reason": _text(
                item["reason"],
                f"{label}.reason",
                maximum=1000,
            ),
        }
        optional_patterns: dict[str, re.Pattern[str]] = {
            "publisherId": PLUGIN_ID_RE,
            "keyId": KEY_ID_RE,
            "pluginId": PLUGIN_ID_RE,
            "artifactSha256": SHA256_RE,
            "supersedes": KEY_ID_RE,
        }
        for key, pattern in optional_patterns.items():
            if key in item:
                parsed[key] = _text(
                    item[key],
                    f"{label}.{key}",
                    maximum=128,
                    pattern=pattern,
                )
        if "version" in item:
            parsed["version"] = parse_semver(
                item["version"],
                f"{label}.version",
            ).original
        requirements = {
            "publisher": {"publisherId"},
            "key": {"publisherId", "keyId"},
            "plugin": {"pluginId"},
            "release": {"pluginId", "version"},
            "artifact": {"artifactSha256"},
        }[scope]
        missing = sorted(requirements - set(parsed))
        if missing:
            raise PluginCatalogError(
                f"{label} scope {scope} requires: {', '.join(missing)}"
            )
        if action == "revoke" and "supersedes" in parsed:
            raise PluginCatalogError(
                f"{label}.supersedes is only valid for restore or supersede"
            )
        if action != "revoke" and "supersedes" not in parsed:
            raise PluginCatalogError(
                f"{label}.supersedes is required for action {action}"
            )
        revocations.append(parsed)
    return tuple(revocations)


def _revocation_target(item: Mapping[str, Any]) -> tuple[Any, ...]:
    scope = str(item["scope"])
    return {
        "publisher": (scope, item.get("publisherId")),
        "key": (scope, item.get("publisherId"), item.get("keyId")),
        "plugin": (scope, item.get("pluginId")),
        "release": (scope, item.get("pluginId"), item.get("version")),
        "artifact": (scope, item.get("artifactSha256")),
    }[scope]


def _validate_revocations(
    revocations: Sequence[Mapping[str, Any]],
    *,
    trust_store: PluginCatalogTrustStore,
    catalog_publisher: Mapping[str, Any],
    publishers: Mapping[str, Mapping[str, Any]],
    plugins: Mapping[str, Mapping[str, Any]],
) -> None:
    publisher_ids = set(publishers) | {str(catalog_publisher["id"])}
    prior: dict[str, Mapping[str, Any]] = {}
    terminal_records: set[str] = set()
    for index, item in enumerate(revocations):
        label = f"revocations[{index}]"
        scope = str(item["scope"])
        if scope == "publisher":
            publisher_id = str(item["publisherId"])
            if publisher_id not in publisher_ids:
                raise PluginCatalogError(
                    f"{label} targets unknown publisher {publisher_id}"
                )
        elif scope == "key":
            publisher_id = str(item["publisherId"])
            key_id = str(item["keyId"])
            if (publisher_id, key_id) not in trust_store.keys:
                raise PluginCatalogError(
                    f"{label} targets unknown key {publisher_id}/{key_id}"
                )
        elif scope == "plugin":
            plugin_id = str(item["pluginId"])
            if plugin_id not in plugins:
                raise PluginCatalogError(
                    f"{label} targets unknown plugin {plugin_id}"
                )
        elif scope == "release":
            plugin_id = str(item["pluginId"])
            plugin = plugins.get(plugin_id)
            versions = (
                {str(release["version"]) for release in plugin["releases"]}
                if plugin is not None
                else set()
            )
            version = str(item["version"])
            if plugin is None or version not in versions:
                raise PluginCatalogError(
                    f"{label} targets unknown release {plugin_id}@{version}"
                )
        # Artifact revocations are intentionally global by digest and may be
        # preemptive; no current artifact match is required.

        action = str(item["action"])
        if action in {"restore", "supersede"}:
            predecessor_id = str(item["supersedes"])
            predecessor = prior.get(predecessor_id)
            if predecessor is None:
                raise PluginCatalogError(
                    f"{label}.supersedes must reference an earlier record"
                )
            if predecessor_id in terminal_records:
                raise PluginCatalogError(
                    f"{label}.supersedes references an already restored or "
                    "superseded record"
                )
            if predecessor["action"] not in {"revoke", "supersede"}:
                raise PluginCatalogError(
                    f"{label}.supersedes must reference an active revocation record"
                )
            if _revocation_target(predecessor) != _revocation_target(item):
                raise PluginCatalogError(
                    f"{label} target must exactly match superseded record "
                    f"{predecessor_id}"
                )
            predecessor_time = _parse_time(
                predecessor["effectiveAt"],
                f"{label}.supersedes.effectiveAt",
            )
            current_time = _parse_time(
                item["effectiveAt"],
                f"{label}.effectiveAt",
            )
            if current_time < predecessor_time:
                raise PluginCatalogError(
                    f"{label}.effectiveAt cannot precede superseded record"
                )
            terminal_records.add(predecessor_id)
        prior[str(item["id"])] = item


def _effective_revocations(
    revocations: Sequence[Mapping[str, Any]],
    *,
    now: datetime,
) -> tuple[dict[str, Any], ...]:
    active: dict[str, dict[str, Any]] = {}
    for item in revocations:
        if _parse_time(item["effectiveAt"], "revocation.effectiveAt") > now:
            continue
        action = str(item["action"])
        if action == "revoke":
            active[str(item["id"])] = dict(item)
        elif action == "restore":
            active.pop(str(item["supersedes"]), None)
        elif action == "supersede":
            active.pop(str(item["supersedes"]), None)
            active[str(item["id"])] = dict(item)
    return tuple(active[key] for key in active)


def _evaluate_compatibility(
    compatibility: Mapping[str, Any],
    environment: CatalogEnvironment,
) -> CompatibilityEvaluation:
    reasons: list[str] = []
    sophia_api = str(compatibility.get("sophiaApi") or "")
    protocols = {
        str(item) for item in compatibility.get("protocols", []) if str(item)
    }
    platforms = [
        item
        for item in compatibility.get("platforms", [])
        if isinstance(item, Mapping)
    ]
    if not sophia_api or not protocols or not platforms:
        return CompatibilityEvaluation(
            status="unknown",
            reasons=("compatibility metadata is incomplete",),
        )
    if sophia_api != environment.sophia_api:
        reasons.append(
            f"requires Sophia API {sophia_api}; host provides "
            f"{environment.sophia_api}"
        )
    if not (protocols & environment.protocols):
        reasons.append(
            "no supported protocol intersection; release declares "
            + ", ".join(sorted(protocols))
        )
    platform_match = False
    architecture_mismatch = False
    host_os = environment.platform.strip().casefold()
    host_arch = _normalize_architecture(environment.architecture)
    for row in platforms:
        if str(row.get("os") or "").strip().casefold() != host_os:
            continue
        architectures = {
            _normalize_architecture(str(item))
            for item in row.get("architectures", [])
            if str(item).strip()
        }
        if not architectures or host_arch in architectures:
            platform_match = True
            break
        architecture_mismatch = True
    if not platform_match:
        if architecture_mismatch:
            reasons.append(
                f"platform {host_os} does not support architecture "
                f"{host_arch or 'unknown'}"
            )
        else:
            reasons.append(f"release does not support platform {host_os}")
    return CompatibilityEvaluation(
        status="incompatible" if reasons else "manifest-valid",
        reasons=tuple(reasons),
    )


def _artifact_reference_issue(release: Mapping[str, Any]) -> str | None:
    artifact = release["artifact"]
    kind = str(artifact["kind"])
    reference = str(artifact["reference"])
    version = str(release["version"])
    if kind == "npm" and not reference.endswith("@" + version):
        return "npm reference is not pinned to the release version"
    if kind == "github":
        fragment = reference.rpartition("#")[2]
        if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", fragment):
            return "GitHub reference is not pinned to a full commit digest"
    return None


def _release_compare(
    left: Mapping[str, Any],
    right: Mapping[str, Any],
) -> int:
    precedence = compare_semver_precedence(
        str(left["version"]),
        str(right["version"]),
    )
    if precedence:
        return precedence
    left_key = (
        str(left["publishedAt"]),
        str(left["version"]),
        str(left["artifact"]["reference"]),
    )
    right_key = (
        str(right["publishedAt"]),
        str(right["version"]),
        str(right["artifact"]["reference"]),
    )
    return (left_key > right_key) - (left_key < right_key)


def _is_prerelease(version: str) -> bool:
    return parse_semver(version).is_prerelease


class PluginCatalog:
    """Verified catalog snapshot with passive search and selection APIs."""

    def __init__(
        self,
        *,
        raw: Mapping[str, Any],
        raw_bytes: bytes,
        trust_store: PluginCatalogTrustStore,
        source: str,
        now: datetime,
        catalog_publisher: Mapping[str, Any],
        publishers: Mapping[str, Mapping[str, Any]],
        plugins: Mapping[str, Mapping[str, Any]],
        revocations: Sequence[Mapping[str, Any]],
        signature: Mapping[str, Any],
    ):
        self.raw = dict(raw)
        self.raw_bytes = raw_bytes
        self.trust_store = trust_store
        self.source = source
        self.now = now
        self.catalog_publisher = dict(catalog_publisher)
        self.publishers = {
            key: dict(value) for key, value in publishers.items()
        }
        self.plugins = {key: dict(value) for key, value in plugins.items()}
        self.revocations = tuple(dict(item) for item in revocations)
        self.signature = dict(signature)
        self.catalog_id = str(raw["catalogId"])
        self.sequence = int(raw["sequence"])
        self.generated_at = _parse_time(raw["generatedAt"], "generatedAt")
        self.expires_at = _parse_time(raw["expiresAt"], "expiresAt")
        self.digest = "sha256:" + hashlib.sha256(raw_bytes).hexdigest()
        self._active_revocation_records = _effective_revocations(
            self.revocations,
            now=self.now,
        )
        self._revocation_index: dict[
            tuple[Any, ...], tuple[tuple[int, dict[str, Any]], ...]
        ] = self._build_revocation_index()

    @property
    def stale(self) -> bool:
        return self.now >= self.expires_at

    def status(self) -> dict[str, Any]:
        artifact_digests = {
            release["artifact"]["sha256"]
            for plugin in self.plugins.values()
            for release in plugin["releases"]
        }
        return {
            "schemaVersion": CATALOG_SCHEMA,
            "catalogId": self.catalog_id,
            "sequence": self.sequence,
            "source": self.source,
            "sha256": self.digest,
            "generatedAt": _format_time(self.generated_at),
            "expiresAt": _format_time(self.expires_at),
            "evaluatedAt": _format_time(self.now),
            "cacheStatus": "stale" if self.stale else "fresh",
            "catalogPublisher": dict(self.catalog_publisher),
            "catalogSignature": dict(self.signature),
            "pluginCount": len(self.plugins),
            "publisherCount": len(self.publishers),
            "revocationCount": len(self.revocations),
            "preemptiveGlobalArtifactRevocationCount": sum(
                1
                for item in self.revocations
                if item["action"] in {"revoke", "supersede"}
                and item["scope"] == "artifact"
                and item["artifactSha256"] not in artifact_digests
            ),
            "networkAccessed": False,
            "installPerformed": False,
            "pluginCodeExecuted": False,
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _active_revocations(self) -> tuple[dict[str, Any], ...]:
        return self._active_revocation_records

    def _build_revocation_index(
        self,
    ) -> dict[tuple[Any, ...], tuple[tuple[int, dict[str, Any]], ...]]:
        indexed: dict[
            tuple[Any, ...], list[tuple[int, dict[str, Any]]]
        ] = {}
        for position, item in enumerate(self._active_revocation_records):
            indexed.setdefault(_revocation_target(item), []).append(
                (position, item)
            )
        return {key: tuple(value) for key, value in indexed.items()}

    def _matching_revocations(
        self,
        *,
        plugin: Mapping[str, Any],
        release: Mapping[str, Any],
        signature_key_id: str | None,
    ) -> tuple[dict[str, Any], ...]:
        targets = (
            ("publisher", plugin["publisherId"]),
            ("key", plugin["publisherId"], signature_key_id),
            ("plugin", plugin["id"]),
            ("release", plugin["id"], release["version"]),
            ("artifact", release["artifact"]["sha256"]),
        )
        matches = [
            indexed
            for target in targets
            for indexed in self._revocation_index.get(target, ())
        ]
        matches.sort(key=lambda value: value[0])
        return tuple(item for _position, item in matches)

    def evaluate_release(
        self,
        plugin: Mapping[str, Any],
        release: Mapping[str, Any],
        *,
        environment: CatalogEnvironment,
    ) -> dict[str, Any]:
        publisher_id = str(plugin["publisherId"])
        catalog_publisher = self.publishers[publisher_id]
        trust_status = self.trust_store.publisher_status(publisher_id)
        signature = self.trust_store.verify(
            publisher_id=publisher_id,
            signature=release.get("publisherSignature"),
            payload=release_signature_payload(
                plugin_id=str(plugin["id"]),
                publisher_id=publisher_id,
                release=release,
            ),
            required_usage="release-signing",
        )
        compatibility = _evaluate_compatibility(
            release["compatibility"],
            environment,
        )
        revocations = self._matching_revocations(
            plugin=plugin,
            release=release,
            signature_key_id=(
                str(signature["keyId"]) if signature.get("keyId") else None
            ),
        )
        quarantine_reasons: list[str] = []
        explicit_quarantine = release["quarantine"]
        if explicit_quarantine["status"] == "quarantined":
            quarantine_reasons.append(str(explicit_quarantine["reason"]))
        if catalog_publisher["status"] == "quarantined":
            quarantine_reasons.append("catalog marks publisher quarantined")
        elif catalog_publisher["status"] == "revoked":
            quarantine_reasons.append("catalog marks publisher revoked")
        if trust_status != "trusted":
            quarantine_reasons.append(
                f"operator trust status is {trust_status}"
            )
        if signature["status"] != "valid":
            quarantine_reasons.append(
                f"publisher signature status is {signature['status']}"
            )
        reference_issue = _artifact_reference_issue(release)
        if reference_issue:
            quarantine_reasons.append(reference_issue)
        if revocations:
            quarantine_reasons.extend(
                f"revoked by {item['id']}: {item['reason']}"
                for item in revocations
            )
        quarantine_status = (
            "quarantined" if quarantine_reasons else "clear"
        )
        return {
            "version": release["version"],
            "publishedAt": release["publishedAt"],
            "artifact": dict(release["artifact"]),
            "compatibility": compatibility.public_dict(),
            "compatibilityDeclaration": copy.deepcopy(
                release["compatibility"]
            ),
            "evaluatedEnvironment": environment.public_dict(),
            "publisher": {
                "id": publisher_id,
                "name": catalog_publisher["name"],
                "catalogStatus": catalog_publisher["status"],
                "trustStatus": trust_status,
            },
            "publisherSignature": signature,
            "quarantine": {
                "status": quarantine_status,
                "reasons": quarantine_reasons,
            },
            "revocation": {
                "status": "revoked" if revocations else "active",
                "records": [dict(item) for item in revocations],
            },
            "packageState": "discovered",
            "runtimeStatus": "disabled",
            "installApproved": False,
            "executionApproved": False,
            "networkAccessed": False,
            "pluginCodeExecuted": False,
        }

    def _release_evaluations(
        self,
        plugin: Mapping[str, Any],
        *,
        environment: CatalogEnvironment,
        releases: Sequence[Mapping[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        return [
            self.evaluate_release(
                plugin,
                release,
                environment=environment,
            )
            for release in (
                releases if releases is not None else plugin["releases"]
            )
        ]

    @staticmethod
    def _release_selectable(
        evaluation: Mapping[str, Any],
        *,
        allow_prerelease: bool,
    ) -> bool:
        return (
            evaluation["compatibility"]["status"] == "manifest-valid"
            and evaluation["publisher"]["catalogStatus"] == "active"
            and evaluation["publisher"]["trustStatus"] == "trusted"
            and evaluation["publisherSignature"]["status"] == "valid"
            and evaluation["quarantine"]["status"] == "clear"
            and evaluation["revocation"]["status"] == "active"
            and (
                allow_prerelease
                or not _is_prerelease(str(evaluation["version"]))
            )
        )

    def _best_evaluation(
        self,
        plugin: Mapping[str, Any],
        *,
        environment: CatalogEnvironment,
        allow_prerelease: bool,
        releases: Sequence[Mapping[str, Any]] | None = None,
    ) -> dict[str, Any]:
        evaluations = self._release_evaluations(
            plugin,
            environment=environment,
            releases=releases,
        )
        selectable = [
            item
            for item in evaluations
            if self._release_selectable(
                item,
                allow_prerelease=allow_prerelease,
            )
        ]
        pool = selectable or evaluations
        ordered = sorted(
            pool,
            key=cmp_to_key(_release_compare),
            reverse=True,
        )
        best = dict(ordered[0])
        best["referenceSelectable"] = bool(selectable) and not self.stale
        return best

    def inspect(
        self,
        plugin_id: str,
        *,
        environment: CatalogEnvironment | None = None,
    ) -> dict[str, Any]:
        normalized = str(plugin_id).strip()
        plugin = self.plugins.get(normalized)
        if plugin is None:
            raise KeyError(f"catalog plugin not found: {normalized}")
        environment = environment or CatalogEnvironment.current()
        releases = self._release_evaluations(
            plugin,
            environment=environment,
        )
        releases = sorted(
            releases,
            key=cmp_to_key(_release_compare),
            reverse=True,
        )
        return {
            **{
                key: value
                for key, value in plugin.items()
                if key != "releases"
            },
            "releases": releases,
            "catalog": self.status(),
            "discovery": {
                "source": "signed-catalog",
                "networkAccessed": False,
                "installPerformed": False,
                "pluginCodeExecuted": False,
            },
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    @staticmethod
    def _matches_plugin_filters(
        plugin: Mapping[str, Any],
        *,
        contributions: frozenset[str],
        capabilities: frozenset[str],
    ) -> bool:
        if contributions and not contributions <= set(plugin["contributions"]):
            return False
        if capabilities and not capabilities <= set(plugin["capabilities"]):
            return False
        return True

    @staticmethod
    def _release_matches_filters(
        release: Mapping[str, Any],
        *,
        protocols: frozenset[str],
        platform: str | None,
        architecture: str | None,
    ) -> bool:
        compatibility = release["compatibility"]
        if protocols and not protocols <= set(compatibility["protocols"]):
            return False
        if not platform and not architecture:
            return True
        target_os = platform.casefold() if platform else None
        target_arch = _normalize_architecture(architecture or "")
        for row in compatibility["platforms"]:
            if target_os is not None and row["os"] != target_os:
                continue
            architectures = {
                _normalize_architecture(str(item))
                for item in row["architectures"]
            }
            if not target_arch or not architectures or target_arch in architectures:
                return True
        return False

    @staticmethod
    def _search_score(plugin: Mapping[str, Any], query: str) -> int:
        normalized = query.strip().casefold()
        if not normalized:
            return 0
        plugin_id = str(plugin["id"]).casefold()
        name = str(plugin["name"]).casefold()
        summary = str(plugin["summary"]).casefold()
        capabilities = {str(item).casefold() for item in plugin["capabilities"]}
        tags = {str(item).casefold() for item in plugin["tags"]}
        score = 0
        if plugin_id == normalized:
            score += 10_000
        elif plugin_id.startswith(normalized):
            score += 4_000
        if name == normalized:
            score += 3_000
        elif name.startswith(normalized):
            score += 1_500
        tokens = tuple(
            item
            for item in re.split(r"[^a-z0-9._:/+-]+", normalized)
            if item
        )
        for token in tokens:
            if token in plugin_id:
                score += 500
            if token in name:
                score += 300
            if token in capabilities:
                score += 250
            if token in tags:
                score += 200
            if token in summary:
                score += 100
        return score

    def search(
        self,
        query: str = "",
        *,
        contribution: Iterable[str] = (),
        capability: Iterable[str] = (),
        protocol: Iterable[str] = (),
        platform: str | None = None,
        architecture: str | None = None,
        eligible_only: bool = False,
        environment: CatalogEnvironment | None = None,
    ) -> list[dict[str, Any]]:
        environment = environment or CatalogEnvironment.current()
        contributions = frozenset(
            str(item).strip()
            for item in contribution
            if str(item).strip()
        )
        capabilities = frozenset(
            str(item).strip()
            for item in capability
            if str(item).strip()
        )
        protocols = frozenset(
            str(item).strip()
            for item in protocol
            if str(item).strip()
        )
        ranked: list[tuple[int, int, int, str, dict[str, Any]]] = []
        for plugin_id in sorted(self.plugins):
            plugin = self.plugins[plugin_id]
            if not self._matches_plugin_filters(
                plugin,
                contributions=contributions,
                capabilities=capabilities,
            ):
                continue
            candidate_releases = [
                release
                for release in plugin["releases"]
                if self._release_matches_filters(
                    release,
                    protocols=protocols,
                    platform=platform,
                    architecture=architecture,
                )
            ]
            if not candidate_releases:
                continue
            score = self._search_score(plugin, query)
            if query.strip() and score == 0:
                continue
            best = self._best_evaluation(
                plugin,
                environment=environment,
                allow_prerelease=False,
                releases=candidate_releases,
            )
            eligible = best["referenceSelectable"] is True
            if eligible_only and not eligible:
                continue
            result = {
                "id": plugin["id"],
                "name": plugin["name"],
                "summary": plugin["summary"],
                "publisherId": plugin["publisherId"],
                "contributions": list(plugin["contributions"]),
                "capabilities": list(plugin["capabilities"]),
                "protocols": list(plugin["protocols"]),
                "tags": list(plugin["tags"]),
                "bestRelease": best,
                "searchScore": score,
                "catalogId": self.catalog_id,
                "catalogCacheStatus": "stale" if self.stale else "fresh",
                "candidateOnly": True,
                "canClaimAGI": False,
            }
            trust_rank = (
                1
                if best["publisher"]["trustStatus"] == "trusted"
                else 0
            )
            ranked.append(
                (score, int(eligible), trust_rank, str(plugin["id"]), result)
            )
        ranked.sort(key=lambda item: (-item[0], -item[1], -item[2], item[3]))
        return [item[-1] for item in ranked]

    def select_install_reference(
        self,
        plugin_id: str,
        *,
        version: str | None = None,
        protocol: Iterable[str] = (),
        allow_stale: bool = False,
        allow_prerelease: bool = False,
        environment: CatalogEnvironment | None = None,
    ) -> dict[str, Any]:
        normalized = str(plugin_id).strip()
        plugin = self.plugins.get(normalized)
        if plugin is None:
            raise KeyError(f"catalog plugin not found: {normalized}")
        if self.stale and not allow_stale:
            raise PluginCatalogSelectionError(
                f"catalog {self.catalog_id} expired at "
                f"{_format_time(self.expires_at)}; stale metadata remains "
                "searchable but install-reference selection is blocked"
            )
        environment = environment or CatalogEnvironment.current()
        requested_protocols = frozenset(
            str(item).strip()
            for item in protocol
            if str(item).strip()
        )
        candidate_releases = [
            release
            for release in plugin["releases"]
            if self._release_matches_filters(
                release,
                protocols=requested_protocols,
                platform=None,
                architecture=None,
            )
        ]
        requested: str | None = None
        if version is not None:
            requested = parse_semver(version, "version").original
            candidate_releases = [
                release
                for release in candidate_releases
                if release["version"] == requested
            ]
        if not candidate_releases:
            request_detail = (
                f" matching requested protocols "
                f"{', '.join(sorted(requested_protocols))}"
                if requested_protocols
                else ""
            )
            if requested is not None:
                request_detail += f" at version {requested}"
            raise PluginCatalogSelectionError(
                f"catalog plugin {normalized} has no release{request_detail}"
            )
        evaluations = self._release_evaluations(
            plugin,
            environment=environment,
            releases=candidate_releases,
        )
        selectable = [
            item
            for item in evaluations
            if self._release_selectable(
                item,
                allow_prerelease=allow_prerelease,
            )
        ]
        if not selectable:
            reasons = sorted(
                {
                    reason
                    for item in evaluations
                    for reason in (
                        list(item["compatibility"]["reasons"])
                        + list(item["quarantine"]["reasons"])
                    )
                }
            )
            raise PluginCatalogSelectionError(
                f"catalog plugin {normalized} has no selectable release"
                + (f": {'; '.join(reasons)}" if reasons else "")
            )
        selected = sorted(
            selectable,
            key=cmp_to_key(_release_compare),
            reverse=True,
        )[0]
        return {
            "schemaVersion": "sophia.plugin-install-reference/v1",
            "catalogId": self.catalog_id,
            "catalogSequence": self.sequence,
            "catalogSha256": self.digest,
            "catalogCacheStatus": "stale" if self.stale else "fresh",
            "pluginId": normalized,
            "publisherId": plugin["publisherId"],
            "version": selected["version"],
            "requestedProtocols": sorted(requested_protocols),
            "selectionMode": (
                "explicit-version"
                if requested is not None
                else "highest-compatible"
            ),
            "explicitVersion": requested,
            "allowStale": allow_stale,
            "allowPrerelease": allow_prerelease,
            "artifact": dict(selected["artifact"]),
            "compatibility": dict(selected["compatibility"]),
            "compatibilityDeclaration": copy.deepcopy(
                selected["compatibilityDeclaration"]
            ),
            "evaluatedEnvironment": dict(selected["evaluatedEnvironment"]),
            "publisher": dict(selected["publisher"]),
            "publisherSignature": dict(selected["publisherSignature"]),
            "revocation": dict(selected["revocation"]),
            "quarantine": dict(selected["quarantine"]),
            "selectionOnly": True,
            "installApproved": False,
            "executionApproved": False,
            "networkAccessed": False,
            "installPerformed": False,
            "pluginCodeExecuted": False,
            "candidateOnly": True,
            "canClaimAGI": False,
        }


class PluginCatalogLoader:
    """Strict canonical loader and signature verifier."""

    def __init__(self, trust_store: PluginCatalogTrustStore):
        self.trust_store = trust_store

    def load(
        self,
        path: str | Path,
    ) -> PluginCatalog:
        source = Path(path).expanduser().resolve()
        try:
            raw_bytes = source.read_bytes()
        except OSError as exc:
            raise PluginCatalogError(
                f"could not read plugin catalog: {type(exc).__name__}"
            ) from exc
        return self.from_bytes(raw_bytes, source=str(source))

    def from_bytes(
        self,
        raw_bytes: bytes,
        *,
        source: str = "<memory>",
        _evaluation_floor: datetime | None = None,
        _defer_catalog_authority_revocation: bool = False,
    ) -> PluginCatalog:
        raw = _json_object_no_duplicates(
            raw_bytes,
            label="plugin catalog",
            maximum=MAX_CATALOG_BYTES,
        )
        _object(
            raw,
            "plugin catalog",
            required=(
                "schemaVersion",
                "catalogId",
                "sequence",
                "generatedAt",
                "expiresAt",
                "catalogPublisher",
                "publishers",
                "plugins",
                "revocations",
                "signature",
                "candidateOnly",
                "canClaimAGI",
            ),
            allowed=(
                "schemaVersion",
                "catalogId",
                "sequence",
                "generatedAt",
                "expiresAt",
                "catalogPublisher",
                "publishers",
                "plugins",
                "revocations",
                "signature",
                "candidateOnly",
                "canClaimAGI",
            ),
        )
        if raw["schemaVersion"] != CATALOG_SCHEMA:
            raise PluginCatalogError(
                f"catalog schemaVersion must be {CATALOG_SCHEMA}"
            )
        if raw["candidateOnly"] is not True or raw["canClaimAGI"] is not False:
            raise PluginCatalogError(
                "catalog must preserve candidateOnly=true and canClaimAGI=false"
            )
        catalog_id = _text(
            raw["catalogId"],
            "catalogId",
            maximum=96,
            pattern=CATALOG_ID_RE,
        )
        sequence = _integer(
            raw["sequence"],
            "sequence",
            minimum=1,
            maximum=2**63 - 1,
        )
        generated_at = _parse_time(raw["generatedAt"], "generatedAt")
        expires_at = _parse_time(raw["expiresAt"], "expiresAt")
        if expires_at <= generated_at:
            raise PluginCatalogError("expiresAt must be later than generatedAt")
        actual_now = _now_utc()
        effective_now = (
            max(actual_now, _evaluation_floor)
            if _evaluation_floor is not None
            else actual_now
        )
        if generated_at > effective_now:
            raise PluginCatalogError(
                f"catalog generatedAt {_format_time(generated_at)} is in the future"
            )
        catalog_publisher = _parse_catalog_publisher(raw["catalogPublisher"])
        publishers = _parse_catalog_publishers(raw["publishers"])
        plugins = _parse_plugins(raw["plugins"], publishers=publishers)
        revocations = _parse_revocations(raw["revocations"])
        _validate_revocations(
            revocations,
            trust_store=self.trust_store,
            catalog_publisher=catalog_publisher,
            publishers=publishers,
            plugins=plugins,
        )
        signature = _parse_optional_signature(raw["signature"], "signature")
        if signature is None:
            raise PluginCatalogError("catalog signature is required")
        if signature["keyId"] != catalog_publisher["keyId"]:
            raise PluginCatalogError(
                "catalog signature keyId does not match catalogPublisher.keyId"
            )
        authority_status = self.trust_store.catalog_authority_status(
            catalog_id=catalog_id,
            publisher_id=str(catalog_publisher["id"]),
            key_id=str(catalog_publisher["keyId"]),
        )
        if authority_status != "authorized":
            raise PluginCatalogError(
                "catalog signing authority is not authorized for catalog "
                f"{catalog_id}: {authority_status}"
            )
        verification = self.trust_store.verify(
            publisher_id=catalog_publisher["id"],
            signature=signature,
            payload=catalog_signature_payload(raw),
            required_usage="catalog-signing",
        )
        trust_status = self.trust_store.publisher_status(
            catalog_publisher["id"]
        )
        if trust_status != "trusted":
            raise PluginCatalogError(
                f"catalog publisher trust status is {trust_status}, not trusted"
            )
        if verification["status"] != "valid":
            raise PluginCatalogError(
                "catalog signature verification failed: "
                f"{verification['status']}"
            )
        active_revocations = _effective_revocations(
            revocations,
            now=effective_now,
        )
        for item in active_revocations:
            if (
                item["scope"] == "publisher"
                and item.get("publisherId") == catalog_publisher["id"]
            ) or (
                item["scope"] == "key"
                and item.get("publisherId") == catalog_publisher["id"]
                and item.get("keyId") == catalog_publisher["keyId"]
            ):
                if not _defer_catalog_authority_revocation:
                    raise PluginCatalogError(
                        "catalog signing authority is revoked by "
                        f"{item['id']}"
                    )
        normalized = {
            "schemaVersion": CATALOG_SCHEMA,
            "catalogId": catalog_id,
            "sequence": sequence,
            "generatedAt": _format_time(generated_at),
            "expiresAt": _format_time(expires_at),
            "catalogPublisher": catalog_publisher,
            "publishers": [publishers[key] for key in publishers],
            "plugins": [plugins[key] for key in plugins],
            "revocations": list(revocations),
            "signature": signature,
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        if normalized != raw:
            raise PluginCatalogError(
                "catalog values are not in normalized canonical form"
            )
        return PluginCatalog(
            raw=raw,
            raw_bytes=raw_bytes,
            trust_store=self.trust_store,
            source=source,
            now=effective_now,
            catalog_publisher=catalog_publisher,
            publishers=publishers,
            plugins=plugins,
            revocations=revocations,
            signature={
                **verification,
                "publisherId": catalog_publisher["id"],
            },
        )


def _revocation_event_digests(
    revocations: Sequence[Mapping[str, Any]],
) -> dict[str, str]:
    return {
        str(item["id"]): (
            "sha256:" + hashlib.sha256(canonical_json_bytes(item)).hexdigest()
        )
        for item in revocations
    }


def _revocation_history_digest(
    revocations: Sequence[Mapping[str, Any]],
) -> str:
    event_digests = _revocation_event_digests(revocations)
    rows = [
        {"id": event_id, "sha256": event_digests[event_id]}
        for event_id in sorted(event_digests)
    ]
    return "sha256:" + hashlib.sha256(canonical_json_bytes(rows)).hexdigest()


def _parse_cached_catalog_floor(
    catalog_bytes: bytes,
) -> dict[str, Any]:
    """Read rollback/revocation facts without requiring current signer trust."""
    raw = _json_object_no_duplicates(
        catalog_bytes,
        label="cached embedded plugin catalog",
        maximum=MAX_CATALOG_BYTES,
    )
    _object(
        raw,
        "cached embedded plugin catalog",
        required=(
            "schemaVersion",
            "catalogId",
            "sequence",
            "generatedAt",
            "expiresAt",
            "catalogPublisher",
            "publishers",
            "plugins",
            "revocations",
            "signature",
            "candidateOnly",
            "canClaimAGI",
        ),
        allowed=(
            "schemaVersion",
            "catalogId",
            "sequence",
            "generatedAt",
            "expiresAt",
            "catalogPublisher",
            "publishers",
            "plugins",
            "revocations",
            "signature",
            "candidateOnly",
            "canClaimAGI",
        ),
    )
    if raw["schemaVersion"] != CATALOG_SCHEMA:
        raise PluginCatalogError(
            f"cached embedded catalog schemaVersion must be {CATALOG_SCHEMA}"
        )
    if raw["candidateOnly"] is not True or raw["canClaimAGI"] is not False:
        raise PluginCatalogError(
            "cached embedded catalog must preserve candidateOnly=true "
            "and canClaimAGI=false"
        )
    catalog_id = _text(
        raw["catalogId"],
        "cached embedded catalogId",
        maximum=96,
        pattern=CATALOG_ID_RE,
    )
    sequence = _integer(
        raw["sequence"],
        "cached embedded catalog sequence",
        minimum=1,
        maximum=2**63 - 1,
    )
    generated_at = _parse_time(
        raw["generatedAt"],
        "cached embedded catalog generatedAt",
    )
    expires_at = _parse_time(
        raw["expiresAt"],
        "cached embedded catalog expiresAt",
    )
    if expires_at <= generated_at:
        raise PluginCatalogError(
            "cached embedded catalog expiresAt must be later than generatedAt"
        )
    revocations = list(_parse_revocations(raw["revocations"]))
    return {
        "catalogId": catalog_id,
        "sequence": sequence,
        "generatedAt": _format_time(generated_at),
        "expiresAt": _format_time(expires_at),
        "revocations": revocations,
        "revocationHistorySha256": _revocation_history_digest(revocations),
    }


def _build_cache_acceptance_floor(
    *,
    catalog_id: str,
    sequence: int,
    catalog_sha256: str,
    generated_at: str,
    evaluated_through: datetime,
    revocation_history_sha256: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": CACHE_ACCEPTANCE_FLOOR_SCHEMA,
        "catalogId": catalog_id,
        "sequence": sequence,
        "catalogSha256": catalog_sha256,
        "generatedAt": generated_at,
        "evaluatedThrough": _format_time(evaluated_through),
        "revocationHistorySha256": revocation_history_sha256,
    }


def _parse_cache_acceptance_floor(value: Any) -> dict[str, Any]:
    floor = _object(
        value,
        "cache acceptanceFloor",
        required=(
            "schemaVersion",
            "catalogId",
            "sequence",
            "catalogSha256",
            "generatedAt",
            "evaluatedThrough",
            "revocationHistorySha256",
        ),
        allowed=(
            "schemaVersion",
            "catalogId",
            "sequence",
            "catalogSha256",
            "generatedAt",
            "evaluatedThrough",
            "revocationHistorySha256",
        ),
    )
    if floor["schemaVersion"] != CACHE_ACCEPTANCE_FLOOR_SCHEMA:
        raise PluginCatalogError(
            "cache acceptanceFloor schemaVersion must be "
            f"{CACHE_ACCEPTANCE_FLOOR_SCHEMA}"
        )
    generated_at = _parse_time(
        floor["generatedAt"],
        "cache acceptanceFloor generatedAt",
    )
    evaluated_through = _parse_time(
        floor["evaluatedThrough"],
        "cache acceptanceFloor evaluatedThrough",
    )
    if evaluated_through < generated_at:
        raise PluginCatalogError(
            "cache acceptanceFloor evaluatedThrough cannot precede generatedAt"
        )
    normalized = {
        "schemaVersion": CACHE_ACCEPTANCE_FLOOR_SCHEMA,
        "catalogId": _text(
            floor["catalogId"],
            "cache acceptanceFloor catalogId",
            maximum=96,
            pattern=CATALOG_ID_RE,
        ),
        "sequence": _integer(
            floor["sequence"],
            "cache acceptanceFloor sequence",
            minimum=1,
            maximum=2**63 - 1,
        ),
        "catalogSha256": _text(
            floor["catalogSha256"],
            "cache acceptanceFloor catalogSha256",
            maximum=71,
            pattern=SHA256_RE,
        ),
        "generatedAt": _format_time(generated_at),
        "evaluatedThrough": _format_time(evaluated_through),
        "revocationHistorySha256": _text(
            floor["revocationHistorySha256"],
            "cache acceptanceFloor revocationHistorySha256",
            maximum=71,
            pattern=SHA256_RE,
        ),
    }
    if normalized != floor:
        raise PluginCatalogError(
            "cache acceptanceFloor values are not in normalized canonical form"
        )
    return normalized


def _cache_floor_anchor(floor: Mapping[str, Any]) -> tuple[Any, ...]:
    return (
        floor["catalogId"],
        floor["sequence"],
        floor["catalogSha256"],
        floor["generatedAt"],
        floor["revocationHistorySha256"],
    )


def _cache_operator_state_document(
    acceptance_floor: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schemaVersion": CACHE_OPERATOR_STATE_SCHEMA,
        "acceptanceFloor": dict(acceptance_floor),
        "candidateOnly": True,
        "canClaimAGI": False,
    }


def _parse_cache_operator_state(raw_bytes: bytes) -> dict[str, Any]:
    state = _json_object_no_duplicates(
        raw_bytes,
        label="plugin catalog operator state",
        maximum=MAX_CACHE_OPERATOR_STATE_BYTES,
    )
    _object(
        state,
        "plugin catalog operator state",
        required=(
            "schemaVersion",
            "acceptanceFloor",
            "candidateOnly",
            "canClaimAGI",
        ),
        allowed=(
            "schemaVersion",
            "acceptanceFloor",
            "candidateOnly",
            "canClaimAGI",
        ),
    )
    if state["schemaVersion"] != CACHE_OPERATOR_STATE_SCHEMA:
        raise PluginCatalogError(
            "plugin catalog operator state schemaVersion must be "
            f"{CACHE_OPERATOR_STATE_SCHEMA}"
        )
    if state["candidateOnly"] is not True or state["canClaimAGI"] is not False:
        raise PluginCatalogError(
            "plugin catalog operator state must preserve candidateOnly=true "
            "and canClaimAGI=false"
        )
    normalized = _cache_operator_state_document(
        _parse_cache_acceptance_floor(state["acceptanceFloor"])
    )
    if normalized != state:
        raise PluginCatalogError(
            "plugin catalog operator state values are not in normalized "
            "canonical form"
        )
    return normalized


def _validate_operator_floor(
    bundle_floor: Mapping[str, Any],
    operator_floor: Mapping[str, Any],
) -> tuple[datetime, bool]:
    if _cache_floor_anchor(bundle_floor) != _cache_floor_anchor(operator_floor):
        raise PluginCatalogError(
            "cache bundle and operator state acceptance-floor anchors differ"
        )
    bundle_time = _parse_time(
        bundle_floor["evaluatedThrough"],
        "cache acceptanceFloor evaluatedThrough",
    )
    operator_time = _parse_time(
        operator_floor["evaluatedThrough"],
        "operator state acceptanceFloor evaluatedThrough",
    )
    if operator_time < bundle_time:
        raise PluginCatalogError(
            "operator state evaluatedThrough rollback detected"
        )
    # Operator state is the authoritative monotonic copy and is replaced
    # before the cache bundle.  A higher operator time therefore represents
    # either an interrupted state-first transaction or an independently
    # lowered replaceable bundle.  Both are recovered by rewriting the bundle
    # from this higher floor before catalog evaluation; neither may lower the
    # effective revocation clock.
    return operator_time, bundle_time < operator_time


def _parse_cache_bundle(raw_bytes: bytes) -> tuple[dict[str, Any], bytes]:
    bundle = _json_object_no_duplicates(
        raw_bytes,
        label="plugin catalog cache bundle",
        maximum=MAX_CACHE_BYTES,
    )
    schema_version = bundle.get("schemaVersion")
    if (
        not isinstance(schema_version, str)
        or schema_version
        not in {
            CACHE_SCHEMA,
            LEGACY_CACHE_SCHEMA_V2,
            LEGACY_CACHE_SCHEMA_V1,
        }
    ):
        raise PluginCatalogError(
            "cache bundle schemaVersion must be "
            f"{CACHE_SCHEMA}, {LEGACY_CACHE_SCHEMA_V2}, or "
            f"{LEGACY_CACHE_SCHEMA_V1}"
        )
    base_fields = (
        "schemaVersion",
        "catalogId",
        "sequence",
        "catalogSha256",
        "catalogBase64",
        "storedAt",
        "generatedAt",
        "expiresAt",
        "candidateOnly",
        "canClaimAGI",
    )
    required_fields = (
        (*base_fields, "acceptanceFloor")
        if schema_version in {CACHE_SCHEMA, LEGACY_CACHE_SCHEMA_V2}
        else base_fields
    )
    _object(
        bundle,
        "plugin catalog cache bundle",
        required=required_fields,
        allowed=required_fields,
    )
    if (
        bundle["candidateOnly"] is not True
        or bundle["canClaimAGI"] is not False
    ):
        raise PluginCatalogError(
            "cache bundle must preserve candidateOnly=true "
            "and canClaimAGI=false"
        )
    catalog_id = _text(
        bundle["catalogId"],
        "cache bundle catalogId",
        maximum=96,
        pattern=CATALOG_ID_RE,
    )
    sequence = _integer(
        bundle["sequence"],
        "cache bundle sequence",
        minimum=1,
        maximum=2**63 - 1,
    )
    catalog_digest = _text(
        bundle["catalogSha256"],
        "cache bundle catalogSha256",
        maximum=71,
        pattern=SHA256_RE,
    )
    catalog_bytes = _decode_bounded_base64(
        bundle["catalogBase64"],
        "cache bundle catalogBase64",
        maximum_bytes=MAX_CATALOG_BYTES,
    )
    actual_digest = "sha256:" + hashlib.sha256(catalog_bytes).hexdigest()
    if catalog_digest != actual_digest:
        raise PluginCatalogError("cached catalog digest mismatch")
    embedded = _parse_cached_catalog_floor(catalog_bytes)
    if embedded["catalogId"] != catalog_id:
        raise PluginCatalogError(
            "cache bundle catalogId does not match embedded catalogId"
        )
    stored_at = _parse_time(bundle["storedAt"], "cache bundle storedAt")
    generated_at = _parse_time(
        bundle["generatedAt"],
        "cache bundle generatedAt",
    )
    expires_at = _parse_time(
        bundle["expiresAt"],
        "cache bundle expiresAt",
    )
    if expires_at <= generated_at:
        raise PluginCatalogError(
            "cache bundle expiresAt must be later than generatedAt"
        )
    if (
        embedded["sequence"] != sequence
        or embedded["generatedAt"] != _format_time(generated_at)
        or embedded["expiresAt"] != _format_time(expires_at)
    ):
        raise PluginCatalogError(
            "cache bundle metadata does not match embedded signed catalog"
        )
    normalized_base = {
        "schemaVersion": schema_version,
        "catalogId": catalog_id,
        "sequence": sequence,
        "catalogSha256": catalog_digest,
        "catalogBase64": base64.b64encode(catalog_bytes).decode("ascii"),
        "storedAt": _format_time(stored_at),
        "generatedAt": _format_time(generated_at),
        "expiresAt": _format_time(expires_at),
        "candidateOnly": True,
        "canClaimAGI": False,
    }
    if schema_version in {CACHE_SCHEMA, LEGACY_CACHE_SCHEMA_V2}:
        acceptance_floor = _parse_cache_acceptance_floor(
            bundle["acceptanceFloor"]
        )
        if (
            acceptance_floor["catalogId"] != catalog_id
            or acceptance_floor["sequence"] != sequence
            or acceptance_floor["catalogSha256"] != catalog_digest
            or acceptance_floor["generatedAt"]
            != _format_time(generated_at)
            or acceptance_floor["revocationHistorySha256"]
            != embedded["revocationHistorySha256"]
        ):
            raise PluginCatalogError(
                "cache acceptanceFloor does not match embedded signed catalog"
            )
        normalized_document = {
            **normalized_base,
            "acceptanceFloor": acceptance_floor,
        }
    else:
        if embedded["revocations"]:
            raise PluginCatalogError(
                "legacy v1 cache contains revocation history but no durable "
                "evaluation floor; recache it from the signed catalog source"
            )
        evaluated_through = max(stored_at, generated_at)
        acceptance_floor = _build_cache_acceptance_floor(
            catalog_id=catalog_id,
            sequence=sequence,
            catalog_sha256=catalog_digest,
            generated_at=_format_time(generated_at),
            evaluated_through=evaluated_through,
            revocation_history_sha256=embedded[
                "revocationHistorySha256"
            ],
        )
        normalized_document = normalized_base
    if normalized_document != bundle:
        raise PluginCatalogError(
            "cache bundle values are not in normalized canonical form"
        )
    return {
        **normalized_base,
        "acceptanceFloor": acceptance_floor,
        "_cacheSchema": schema_version,
        "_legacyCache": schema_version != CACHE_SCHEMA,
    }, catalog_bytes


def _enforce_revocation_continuity(
    previous_revocations: Sequence[Mapping[str, Any]],
    candidate: PluginCatalog,
) -> None:
    previous_digests = _revocation_event_digests(previous_revocations)
    candidate_digests = _revocation_event_digests(candidate.revocations)
    for record_id in sorted(previous_digests):
        previous_digest = previous_digests[record_id]
        candidate_digest = candidate_digests.get(record_id)
        if candidate_digest is None:
            raise PluginCatalogError(
                f"revocation history event {record_id} "
                f"({previous_digest}) cannot be removed from a "
                "higher-sequence catalog"
            )
        if candidate_digest != previous_digest:
            raise PluginCatalogError(
                f"revocation history event {record_id} cannot be changed: "
                f"accepted {previous_digest}, candidate {candidate_digest}"
            )


def _cache_bundle_document(
    *,
    catalog_id: str,
    sequence: int,
    catalog_sha256: str,
    catalog_bytes: bytes,
    stored_at: str,
    generated_at: str,
    expires_at: str,
    acceptance_floor: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schemaVersion": CACHE_SCHEMA,
        "catalogId": catalog_id,
        "sequence": sequence,
        "catalogSha256": catalog_sha256,
        "catalogBase64": base64.b64encode(catalog_bytes).decode("ascii"),
        "storedAt": stored_at,
        "generatedAt": generated_at,
        "expiresAt": expires_at,
        "acceptanceFloor": dict(acceptance_floor),
        "candidateOnly": True,
        "canClaimAGI": False,
    }


def _advance_cache_bundle_floor(
    bundle: Mapping[str, Any],
    *,
    catalog_bytes: bytes,
    evaluated_through: datetime,
) -> dict[str, Any]:
    current_floor = bundle["acceptanceFloor"]
    floor_time = _parse_time(
        current_floor["evaluatedThrough"],
        "cache acceptanceFloor evaluatedThrough",
    )
    next_floor_time = max(floor_time, evaluated_through)
    acceptance_floor = _build_cache_acceptance_floor(
        catalog_id=str(bundle["catalogId"]),
        sequence=int(bundle["sequence"]),
        catalog_sha256=str(bundle["catalogSha256"]),
        generated_at=str(bundle["generatedAt"]),
        evaluated_through=next_floor_time,
        revocation_history_sha256=str(
            current_floor["revocationHistorySha256"]
        ),
    )
    return _cache_bundle_document(
        catalog_id=str(bundle["catalogId"]),
        sequence=int(bundle["sequence"]),
        catalog_sha256=str(bundle["catalogSha256"]),
        catalog_bytes=catalog_bytes,
        stored_at=str(bundle["storedAt"]),
        generated_at=str(bundle["generatedAt"]),
        expires_at=str(bundle["expiresAt"]),
        acceptance_floor=acceptance_floor,
    )


def _bounded_evaluation_floor(
    *,
    current_floor: datetime,
    observed_now: datetime,
    generated_at: datetime,
    expires_at: datetime,
) -> datetime:
    """Advance durable time only while the signed snapshot is fresh.

    A wall-clock jump beyond the signed validity window still makes the
    in-memory view stale, but it cannot permanently move operator state into
    that untrusted future.
    """
    if generated_at <= observed_now < expires_at:
        return max(current_floor, observed_now)
    return current_floor


def _persist_cache_transaction(
    *,
    cache_path: Path,
    operator_state_path: Path,
    bundle: Mapping[str, Any],
) -> None:
    # Operator state is authoritative and is written first. If the process
    # stops between replacements, the state can only be ahead of the bundle;
    # retrying the same signed store repairs that safe direction.
    state = _cache_operator_state_document(bundle["acceptanceFloor"])
    _atomic_write(operator_state_path, canonical_json_bytes(state))
    _atomic_write(cache_path, canonical_json_bytes(bundle))


def _cache_receipt(
    bundle: Mapping[str, Any],
    *,
    cache_path: Path,
    lock_path: Path,
    operator_state_path: Path,
    catalog: PluginCatalog,
) -> dict[str, Any]:
    acceptance_floor = bundle["acceptanceFloor"]
    return {
        **{
            key: value
            for key, value in bundle.items()
            if key not in {"catalogBase64", "acceptanceFloor"}
            and not key.startswith("_")
        },
        "evaluationFloorAt": acceptance_floor["evaluatedThrough"],
        "revocationHistorySha256": acceptance_floor[
            "revocationHistorySha256"
        ],
        "cachePath": str(cache_path),
        "lockPath": str(lock_path),
        "operatorStatePath": str(operator_state_path),
        "cacheStatus": "stale" if catalog.stale else "fresh",
        "networkAccessed": False,
        "installPerformed": False,
        "pluginCodeExecuted": False,
    }


class PluginCatalogCache:
    """Verified, rollback-resistant local cache for offline discovery."""

    def __init__(
        self,
        trust_store: PluginCatalogTrustStore,
        *,
        root: str | Path | None = None,
    ):
        self.trust_store = trust_store
        self.root = (
            Path(root).expanduser().resolve()
            if root is not None
            else (user_state_dir() / "plugin-catalog" / "cache").resolve()
        )

    def _paths(self, catalog_id: str) -> tuple[Path, Path]:
        normalized = _text(
            catalog_id,
            "catalogId",
            maximum=96,
            pattern=CATALOG_ID_RE,
        )
        return (
            self.root / f"{normalized}.cache.json",
            self.root / f"{normalized}.lock",
        )

    def _operator_state_path(self, catalog_id: str) -> Path:
        normalized = _text(
            catalog_id,
            "catalogId",
            maximum=96,
            pattern=CATALOG_ID_RE,
        )
        return self.root / f"{normalized}.operator-state.json"

    def _read_operator_floor(self, path: Path) -> dict[str, Any]:
        try:
            raw_bytes = path.read_bytes()
        except OSError as exc:
            raise PluginCatalogError(
                "could not read plugin catalog operator state: "
                f"{type(exc).__name__}"
            ) from exc
        state = _parse_cache_operator_state(raw_bytes)
        return dict(state["acceptanceFloor"])

    def _resolve_operator_floor(
        self,
        bundle: Mapping[str, Any],
        *,
        operator_state_path: Path,
        recovery_floor: Mapping[str, Any] | None = None,
    ) -> tuple[dict[str, Any], datetime, bool]:
        bundle_floor = dict(bundle["acceptanceFloor"])
        if operator_state_path.exists():
            operator_floor = self._read_operator_floor(operator_state_path)
            if _cache_floor_anchor(bundle_floor) != _cache_floor_anchor(
                operator_floor
            ):
                if recovery_floor is None or _cache_floor_anchor(
                    operator_floor
                ) != _cache_floor_anchor(recovery_floor):
                    raise PluginCatalogError(
                        "cache bundle and operator state acceptance-floor "
                        "anchors differ"
                    )
                bundle_time = _parse_time(
                    bundle_floor["evaluatedThrough"],
                    "cache acceptanceFloor evaluatedThrough",
                )
                floor_time = _parse_time(
                    operator_floor["evaluatedThrough"],
                    "operator state acceptanceFloor evaluatedThrough",
                )
                if floor_time < bundle_time:
                    raise PluginCatalogError(
                        "operator state evaluatedThrough rollback detected "
                        "across a catalog transition"
                    )
                return operator_floor, floor_time, True
            floor_time, pending_transition = _validate_operator_floor(
                bundle_floor,
                operator_floor,
            )
            return operator_floor, floor_time, pending_transition
        if bundle["_cacheSchema"] == CACHE_SCHEMA:
            raise PluginCatalogError(
                "plugin catalog operator state is missing for a v3 cache"
            )
        floor_time = _parse_time(
            bundle_floor["evaluatedThrough"],
            "cache acceptanceFloor evaluatedThrough",
        )
        return bundle_floor, floor_time, False

    def _before_lock_acquire(self, _catalog_id: str) -> None:
        """Test seam immediately before the interprocess lock attempt."""

    def _after_lock_acquired(self, _catalog_id: str) -> None:
        """Test seam immediately after the interprocess lock is held."""

    @contextmanager
    def _catalog_lock(self, catalog_id: str):
        _cache_path, lock_path = self._paths(catalog_id)
        if fcntl is None:
            raise PluginCatalogError(
                "plugin catalog cache operations are unsupported on this "
                "platform: no interprocess lock backend is available"
            )
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        except OSError as exc:
            raise PluginCatalogError(
                f"could not open plugin catalog cache lock: {type(exc).__name__}"
            ) from exc
        locked = False
        try:
            self._before_lock_acquire(catalog_id)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            except OSError as exc:
                raise PluginCatalogError(
                    "plugin catalog cache lock acquisition failed: "
                    f"{type(exc).__name__}"
                ) from exc
            locked = True
            self._after_lock_acquired(catalog_id)
            yield lock_path
        finally:
            try:
                if locked:
                    try:
                        fcntl.flock(descriptor, fcntl.LOCK_UN)
                    except OSError:
                        pass
            finally:
                # Closing the descriptor releases the lock even if an explicit
                # unlock failed. Cleanup must not hide the original body error.
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def _load_locked(
        self,
        catalog_id: str,
        cache_path: Path,
        operator_state_path: Path,
        *,
        advance_evaluation_floor: bool = False,
    ) -> tuple[PluginCatalog, dict[str, Any]]:
        try:
            bundle_bytes = cache_path.read_bytes()
        except OSError as exc:
            raise PluginCatalogError(
                f"could not read plugin catalog cache: {type(exc).__name__}"
            ) from exc
        bundle, catalog_bytes = _parse_cache_bundle(bundle_bytes)
        if bundle["catalogId"] != catalog_id:
            raise PluginCatalogError("cache bundle catalogId mismatch")
        bundle_floor_time = _parse_time(
            bundle["acceptanceFloor"]["evaluatedThrough"],
            "cache acceptanceFloor evaluatedThrough",
        )
        _operator_floor, floor_time, _pending_transition = (
            self._resolve_operator_floor(
                bundle,
                operator_state_path=operator_state_path,
            )
        )
        observed_now = _now_utc()
        next_floor_time = floor_time
        if advance_evaluation_floor:
            next_floor_time = _bounded_evaluation_floor(
                current_floor=floor_time,
                observed_now=observed_now,
                generated_at=_parse_time(
                    bundle["generatedAt"],
                    "cache bundle generatedAt",
                ),
                expires_at=_parse_time(
                    bundle["expiresAt"],
                    "cache bundle expiresAt",
                ),
            )
        if bundle["_legacyCache"] or next_floor_time > bundle_floor_time:
            upgraded = _advance_cache_bundle_floor(
                bundle,
                catalog_bytes=catalog_bytes,
                evaluated_through=next_floor_time,
            )
            _persist_cache_transaction(
                cache_path=cache_path,
                operator_state_path=operator_state_path,
                bundle=upgraded,
            )
            bundle = {
                **upgraded,
                "_cacheSchema": CACHE_SCHEMA,
                "_legacyCache": False,
            }
            floor_time = next_floor_time
        catalog = PluginCatalogLoader(self.trust_store).from_bytes(
            catalog_bytes,
            source=str(cache_path),
            _evaluation_floor=floor_time,
        )
        if catalog.catalog_id != catalog_id:
            raise PluginCatalogError(
                "requested catalogId does not match embedded catalogId"
            )
        if (
            bundle["sequence"] != catalog.sequence
            or bundle["generatedAt"] != _format_time(catalog.generated_at)
            or bundle["expiresAt"] != _format_time(catalog.expires_at)
        ):
            raise PluginCatalogError("cache bundle does not match signed catalog")
        return catalog, bundle

    def store(self, catalog: PluginCatalog) -> dict[str, Any]:
        # Never trust a PluginCatalog object's provenance. Reparse its exact
        # signed bytes under this cache's own current trust before consulting
        # or advancing the rollback floor.
        loader = PluginCatalogLoader(self.trust_store)
        preliminarily_verified = loader.from_bytes(
            catalog.raw_bytes,
            source=catalog.source,
            _defer_catalog_authority_revocation=True,
        )
        observed_now = preliminarily_verified.now
        if catalog.catalog_id != preliminarily_verified.catalog_id:
            raise PluginCatalogError(
                "PluginCatalog catalog_id does not match embedded catalogId"
            )
        cache_path, lock_path = self._paths(
            preliminarily_verified.catalog_id
        )
        operator_state_path = self._operator_state_path(
            preliminarily_verified.catalog_id
        )
        candidate_anchor_floor = _build_cache_acceptance_floor(
            catalog_id=preliminarily_verified.catalog_id,
            sequence=preliminarily_verified.sequence,
            catalog_sha256=preliminarily_verified.digest,
            generated_at=_format_time(preliminarily_verified.generated_at),
            evaluated_through=preliminarily_verified.generated_at,
            revocation_history_sha256=_revocation_history_digest(
                preliminarily_verified.revocations
            ),
        )
        with self._catalog_lock(preliminarily_verified.catalog_id):
            current: dict[str, Any] | None = None
            current_floor: dict[str, Any] | None = None
            evaluation_floor = preliminarily_verified.generated_at
            if cache_path.exists():
                try:
                    current_bytes = cache_path.read_bytes()
                except OSError as exc:
                    raise PluginCatalogError(
                        "could not read plugin catalog cache: "
                        f"{type(exc).__name__}"
                    ) from exc
                current, current_catalog_bytes = _parse_cache_bundle(
                    current_bytes
                )
                if current["catalogId"] != preliminarily_verified.catalog_id:
                    raise PluginCatalogError("cache bundle catalogId mismatch")
                current_floor = _parse_cached_catalog_floor(
                    current_catalog_bytes
                )
                (
                    _operator_floor,
                    accepted_evaluation_floor,
                    pending_transition,
                ) = self._resolve_operator_floor(
                    current,
                    operator_state_path=operator_state_path,
                    recovery_floor=candidate_anchor_floor,
                )
                evaluation_floor = _bounded_evaluation_floor(
                    current_floor=accepted_evaluation_floor,
                    observed_now=observed_now,
                    generated_at=preliminarily_verified.generated_at,
                    expires_at=preliminarily_verified.expires_at,
                )
                if not pending_transition and (
                    current["_legacyCache"]
                    or evaluation_floor
                    > _parse_time(
                        current["acceptanceFloor"]["evaluatedThrough"],
                        "cache acceptanceFloor evaluatedThrough",
                    )
                ):
                    advanced_current = _advance_cache_bundle_floor(
                        current,
                        catalog_bytes=current_catalog_bytes,
                        evaluated_through=evaluation_floor,
                    )
                    _persist_cache_transaction(
                        cache_path=cache_path,
                        operator_state_path=operator_state_path,
                        bundle=advanced_current,
                    )
                    current = {
                        **advanced_current,
                        "_cacheSchema": CACHE_SCHEMA,
                        "_legacyCache": False,
                    }
                current_sequence = int(current["sequence"])
                if current_sequence > preliminarily_verified.sequence:
                    raise PluginCatalogError(
                        f"cache rollback blocked: existing sequence "
                        f"{current_sequence} is newer than "
                        f"{preliminarily_verified.sequence}"
                    )
                if (
                    current_sequence == preliminarily_verified.sequence
                    and current["catalogSha256"]
                    != preliminarily_verified.digest
                ):
                    raise PluginCatalogError(
                        f"cache equivocation blocked: sequence "
                        f"{preliminarily_verified.sequence} has a different "
                        "signed digest"
                    )
                if current_sequence < preliminarily_verified.sequence:
                    _enforce_revocation_continuity(
                        current_floor["revocations"],
                        preliminarily_verified,
                    )
            elif operator_state_path.exists():
                operator_floor = self._read_operator_floor(
                    operator_state_path
                )
                if _cache_floor_anchor(operator_floor) != _cache_floor_anchor(
                    candidate_anchor_floor
                ):
                    raise PluginCatalogError(
                        "orphaned plugin catalog operator state does not "
                        "match the candidate catalog"
                    )
                evaluation_floor = _parse_time(
                    operator_floor["evaluatedThrough"],
                    "operator state acceptanceFloor evaluatedThrough",
                )

            evaluation_floor = _bounded_evaluation_floor(
                current_floor=evaluation_floor,
                observed_now=observed_now,
                generated_at=preliminarily_verified.generated_at,
                expires_at=preliminarily_verified.expires_at,
            )
            if (
                current is None
                or int(current["sequence"])
                < preliminarily_verified.sequence
            ):
                # Persist the fully authenticated signed snapshot and its
                # observation floor before applying its self-revocation
                # policy. This deliberately advances to a higher signed
                # candidate even when that candidate rejects itself: retaining
                # the older snapshot would resurrect the now-observed revoked
                # catalog key after a clock rollback.
                observed_floor = _build_cache_acceptance_floor(
                    catalog_id=preliminarily_verified.catalog_id,
                    sequence=preliminarily_verified.sequence,
                    catalog_sha256=preliminarily_verified.digest,
                    generated_at=_format_time(
                        preliminarily_verified.generated_at
                    ),
                    evaluated_through=evaluation_floor,
                    revocation_history_sha256=(
                        _revocation_history_digest(
                            preliminarily_verified.revocations
                        )
                    ),
                )
                observed_bundle = _cache_bundle_document(
                    catalog_id=preliminarily_verified.catalog_id,
                    sequence=preliminarily_verified.sequence,
                    catalog_sha256=preliminarily_verified.digest,
                    catalog_bytes=preliminarily_verified.raw_bytes,
                    stored_at=_format_time(observed_now),
                    generated_at=_format_time(
                        preliminarily_verified.generated_at
                    ),
                    expires_at=_format_time(
                        preliminarily_verified.expires_at
                    ),
                    acceptance_floor=observed_floor,
                )
                _persist_cache_transaction(
                    cache_path=cache_path,
                    operator_state_path=operator_state_path,
                    bundle=observed_bundle,
                )
            # Re-evaluate the candidate under the persisted monotonic clock
            # floor. This catches catalog-key revocations that became effective
            # before an update even if the local wall clock later moved back.
            verified = loader.from_bytes(
                catalog.raw_bytes,
                source=catalog.source,
                _evaluation_floor=evaluation_floor,
            )
            acceptance_floor = _build_cache_acceptance_floor(
                catalog_id=verified.catalog_id,
                sequence=verified.sequence,
                catalog_sha256=verified.digest,
                generated_at=_format_time(verified.generated_at),
                evaluated_through=evaluation_floor,
                revocation_history_sha256=_revocation_history_digest(
                    verified.revocations
                ),
            )
            if (
                current is not None
                and current["sequence"] == verified.sequence
                and current["catalogSha256"] == verified.digest
            ):
                if (
                    not current["_legacyCache"]
                    and current["acceptanceFloor"] == acceptance_floor
                ):
                    return _cache_receipt(
                        current,
                        cache_path=cache_path,
                        lock_path=lock_path,
                        operator_state_path=operator_state_path,
                        catalog=verified,
                    )
                bundle = _cache_bundle_document(
                    catalog_id=verified.catalog_id,
                    sequence=verified.sequence,
                    catalog_sha256=verified.digest,
                    catalog_bytes=verified.raw_bytes,
                    stored_at=current["storedAt"],
                    generated_at=_format_time(verified.generated_at),
                    expires_at=_format_time(verified.expires_at),
                    acceptance_floor=acceptance_floor,
                )
            else:
                bundle = _cache_bundle_document(
                    catalog_id=verified.catalog_id,
                    sequence=verified.sequence,
                    catalog_sha256=verified.digest,
                    catalog_bytes=verified.raw_bytes,
                    stored_at=_format_time(observed_now),
                    generated_at=_format_time(verified.generated_at),
                    expires_at=_format_time(verified.expires_at),
                    acceptance_floor=acceptance_floor,
                )
            _persist_cache_transaction(
                cache_path=cache_path,
                operator_state_path=operator_state_path,
                bundle=bundle,
            )
        return _cache_receipt(
            bundle,
            cache_path=cache_path,
            lock_path=lock_path,
            operator_state_path=operator_state_path,
            catalog=verified,
        )

    def load(
        self,
        catalog_id: str,
    ) -> PluginCatalog:
        cache_path, _lock_path = self._paths(catalog_id)
        operator_state_path = self._operator_state_path(catalog_id)
        with self._catalog_lock(catalog_id):
            catalog, _bundle = self._load_locked(
                catalog_id,
                cache_path,
                operator_state_path,
                advance_evaluation_floor=True,
            )
            return catalog


class PluginCatalogService:
    """No-network catalog API suitable for CLI and PluginHost integration."""

    def __init__(
        self,
        *,
        trust_store_path: str | Path,
        catalog_path: str | Path | None = None,
        cache_root: str | Path | None = None,
        catalog_id: str | None = None,
        registry: Any = None,
    ):
        if catalog_path is None and not catalog_id:
            raise PluginCatalogError(
                "catalog service requires a local catalog path or cache/catalog id"
            )
        self.trust_store_path = Path(trust_store_path).expanduser().resolve()
        self.catalog_path = (
            Path(catalog_path).expanduser().resolve()
            if catalog_path is not None
            else None
        )
        self.cache_root = (
            Path(cache_root).expanduser().resolve()
            if cache_root is not None
            else None
        )
        self.catalog_id = catalog_id
        self.registry = registry

    @classmethod
    def from_environment(
        cls,
        *,
        registry: Any = None,
    ) -> "PluginCatalogService":
        trust_path = os.environ.get("SOPHIA_PLUGIN_CATALOG_TRUST_PATH")
        if not trust_path:
            raise PluginCatalogError(
                "SOPHIA_PLUGIN_CATALOG_TRUST_PATH is required for catalog commands"
            )
        catalog_path = os.environ.get("SOPHIA_PLUGIN_CATALOG_PATH")
        cache_root = os.environ.get("SOPHIA_PLUGIN_CATALOG_CACHE_DIR")
        catalog_id = os.environ.get("SOPHIA_PLUGIN_CATALOG_ID")
        return cls(
            trust_store_path=trust_path,
            catalog_path=catalog_path,
            cache_root=cache_root,
            catalog_id=catalog_id,
            registry=registry,
        )

    def snapshot(self) -> PluginCatalog:
        # Reload the operator-owned trust file for every operation. The stable
        # read rejects missing, malformed, unreadable, or concurrently replaced
        # trust rather than falling back to an older in-memory decision.
        trust_store = PluginCatalogTrustStore.load(self.trust_store_path)
        if self.catalog_path is not None:
            return PluginCatalogLoader(trust_store).load(self.catalog_path)
        assert self.catalog_id is not None
        return PluginCatalogCache(
            trust_store,
            root=self.cache_root,
        ).load(self.catalog_id)

    def _annotate_local(self, value: dict[str, Any]) -> dict[str, Any]:
        if self.registry is None:
            return value
        plugin_id = str(value.get("id") or value.get("pluginId") or "")
        record = self.registry.get(plugin_id) if plugin_id else None
        annotated = dict(value)
        annotated["localRegistry"] = (
            {
                "discovered": True,
                "source": record.source,
                "version": record.manifest.version,
                "digest": record.manifest.digest,
                "enabled": record.enabled,
            }
            if record is not None
            else {
                "discovered": False,
                "source": None,
                "version": None,
                "digest": None,
                "enabled": False,
            }
        )
        return annotated

    def status(self) -> dict[str, Any]:
        return self.snapshot().status()

    def search(self, query: str = "", **filters: Any) -> list[dict[str, Any]]:
        return [
            self._annotate_local(item)
            for item in self.snapshot().search(query, **filters)
        ]

    def search_response(
        self,
        query: str = "",
        **filters: Any,
    ) -> dict[str, Any]:
        """Search one verified snapshot so status/results cannot race."""
        snapshot = self.snapshot()
        return {
            "catalog": snapshot.status(),
            "results": [
                self._annotate_local(item)
                for item in snapshot.search(query, **filters)
            ],
        }

    def inspect(self, plugin_id: str, **kwargs: Any) -> dict[str, Any]:
        return self._annotate_local(
            self.snapshot().inspect(plugin_id, **kwargs)
        )

    def select(
        self,
        plugin_id: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return self._annotate_local(
            self.snapshot().select_install_reference(plugin_id, **kwargs)
        )
