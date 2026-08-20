# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Secret-safe custom model provider profiles.

This module is an integration boundary for Bridge/UI code.  It deliberately
does not execute network requests, and its public profile/probe payloads never
resolve or return credential values.  Persisted profiles contain only
``env:NAME`` or ``keyring:SERVICE/ACCOUNT`` references.  A keyring value may be
resolved privately and injected into a process-local model adapter only when
that adapter can preserve the same security boundary.

Supported wire protocols:

* ``openai-chat`` (OpenAI-compatible ``/chat/completions``)
* ``openai-responses``
* ``anthropic-messages``
* ``ollama-native``
* ``mlx-native`` (on-device alias; no endpoint)

Persistence is deterministic TOML, protected by an advisory lock, owner-only
permissions, and atomic replacement.  Malformed or unsafe stores fail closed.
"""

from __future__ import annotations

import ipaddress
import hashlib
import json
import os
import posixpath
import re
import socket
import stat
import subprocess
import sys
import tempfile
import tomllib
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit

from agent.runtime_paths import user_state_dir
from agent.secret_patterns import find_secrets

try:  # Unix/macOS production path.
    import fcntl  # type: ignore
except ImportError:  # pragma: no cover - Windows fallback is exercised by type shape.
    fcntl = None  # type: ignore


STORE_SCHEMA = "sophia.provider-profiles.v1"
STORE_VERSION = 1
PROBE_SCHEMA = "sophia.provider-profile-probe-plan.v1"

OPENAI_CHAT = "openai-chat"
OPENAI_RESPONSES = "openai-responses"
ANTHROPIC_MESSAGES = "anthropic-messages"
OLLAMA_NATIVE = "ollama-native"
MLX_NATIVE = "mlx-native"

SUPPORTED_PROTOCOLS = frozenset({
    OPENAI_CHAT,
    OPENAI_RESPONSES,
    ANTHROPIC_MESSAGES,
    OLLAMA_NATIVE,
    MLX_NATIVE,
})

_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_ENV_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,127}$")
_KEYRING_PART_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$")
_METADATA_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_DNS_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_DANGEROUS_ENCODED_PATH_RE = re.compile(r"%(?:2e|2f|5c)", re.IGNORECASE)
_SECRET_FIELD_NAMES = frozenset({
    "access_key",
    "api_key",
    "api_token",
    "auth_token",
    "authorization",
    "bearer",
    "bearer_token",
    "client_secret",
    "cookie",
    "credential",
    "credentials",
    "credential_value",
    "password",
    "private_key",
    "refresh_token",
    "secret",
    "session_token",
    "secret_key",
    "token",
})
_SECRET_FIELD_SUFFIXES = (
    "_access_key",
    "_api_key",
    "_api_token",
    "_auth_token",
    "_client_secret",
    "_cookie",
    "_credential",
    "_credentials",
    "_credential_value",
    "_password",
    "_private_key",
    "_refresh_token",
    "_secret",
    "_secret_key",
    "_session_token",
)

_DENIED_REMOTE_SUFFIXES = (
    ".localhost",
    ".home.arpa",
)
_PRIVATE_NETWORK_SUFFIXES = (
    ".internal",
    ".local",
    ".lan",
    ".corp",
    ".intranet",
)
_DENIED_REMOTE_HOSTS = frozenset({
    "localhost",
    "localhost.localdomain",
    "metadata",
    "metadata.google",
    "metadata.google.internal",
    "instance-data",
    "instance-data.ec2.internal",
})
_METADATA_IPS = frozenset({
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("169.254.170.2"),
    ipaddress.ip_address("100.100.100.200"),
    ipaddress.ip_address("fd00:ec2::254"),
})


class ProviderProfileError(ValueError):
    """Base error for invalid profiles, unsafe stores, and failed validation."""


class ProfileNotFoundError(ProviderProfileError):
    """Raised when an operation requires a stored profile that does not exist."""


class UnsupportedProfileError(ProviderProfileError):
    """Raised when a valid profile cannot be represented by the current runtime."""


def normalize_profile_name(name: str) -> str:
    """Return the stable, case-insensitive profile key used on disk."""
    normalized = re.sub(r"[\s_]+", "-", str(name or "").strip().casefold())
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-")
    if not _PROFILE_NAME_RE.fullmatch(normalized):
        raise ProviderProfileError(
            "profile name must be 1-64 characters using letters, digits, '.', '_', or '-'"
        )
    return normalized


def _assert_secret_free(value: str, *, field_name: str) -> None:
    if find_secrets(value):
        raise ProviderProfileError(f"{field_name} must not contain credential material")


def _is_secret_field_name(value: str) -> bool:
    """Identify credential fields without confusing token-count settings."""
    normalized = re.sub(r"[^a-z0-9]+", "_", str(value).casefold()).strip("_")
    return normalized in _SECRET_FIELD_NAMES or normalized.endswith(
        _SECRET_FIELD_SUFFIXES
    )


@dataclass(frozen=True, slots=True)
class CredentialReference:
    """Reference to a secret source; never the secret itself."""

    kind: str = "none"
    name: str | None = None
    service: str | None = None
    account: str | None = None

    def __post_init__(self) -> None:
        kind = str(self.kind or "none").strip().casefold()
        kind = {
            "environment": "env",
            "keychain": "keyring",
        }.get(kind, kind)
        object.__setattr__(self, "kind", kind)
        if kind == "none":
            if any((self.name, self.service, self.account)):
                raise ProviderProfileError("credential kind 'none' cannot carry reference fields")
            return
        if kind == "env":
            name = str(self.name or "").strip()
            if not _ENV_NAME_RE.fullmatch(name):
                raise ProviderProfileError(
                    "environment credential reference must name an uppercase environment variable"
                )
            object.__setattr__(self, "name", name)
            if self.service or self.account:
                raise ProviderProfileError("environment credential reference accepts only 'name'")
            return
        if kind == "keyring":
            service = str(self.service or "").strip()
            account = str(self.account or "").strip()
            if not _KEYRING_PART_RE.fullmatch(service) or not _KEYRING_PART_RE.fullmatch(account):
                raise ProviderProfileError(
                    "keyring credential reference requires safe service and account names"
                )
            _assert_secret_free(service, field_name="keyring service")
            _assert_secret_free(account, field_name="keyring account")
            object.__setattr__(self, "service", service)
            object.__setattr__(self, "account", account)
            if self.name:
                raise ProviderProfileError("keyring credential reference does not accept 'name'")
            return
        raise ProviderProfileError("credential reference kind must be none, env, or keyring")

    @classmethod
    def parse(
        cls,
        value: "CredentialReference | Mapping[str, Any] | str | None",
    ) -> "CredentialReference":
        if isinstance(value, cls):
            return value
        if value is None:
            return cls()
        if isinstance(value, str):
            text = value.strip()
            if not text or text.casefold() == "none":
                return cls()
            if text.startswith("env:"):
                return cls(kind="env", name=text.removeprefix("env:"))
            if text.startswith(("keyring:", "keychain:")):
                _, _, payload = text.partition(":")
                service, separator, account = payload.partition("/")
                if not separator:
                    raise ProviderProfileError(
                        "keyring credential reference must use keyring:SERVICE/ACCOUNT"
                    )
                return cls(kind="keyring", service=service, account=account)
            raise ProviderProfileError(
                "credential_ref must use env:NAME or keyring:SERVICE/ACCOUNT"
            )
        if not isinstance(value, Mapping):
            raise ProviderProfileError("credential_ref must be a reference object or string")
        unknown = set(value) - {"kind", "type", "name", "service", "account"}
        if unknown:
            raise ProviderProfileError(
                f"credential reference has unsupported fields: {sorted(unknown)}"
            )
        if "kind" in value and "type" in value:
            raise ProviderProfileError(
                "credential reference must not provide both kind and type"
            )
        return cls(
            kind=str(value.get("kind") or value.get("type") or "none"),
            name=_optional_string(value.get("name")),
            service=_optional_string(value.get("service")),
            account=_optional_string(value.get("account")),
        )

    def to_uri(self) -> str:
        if self.kind == "env":
            return f"env:{self.name}"
        if self.kind == "keyring":
            return f"keyring:{self.service}/{self.account}"
        return "none"

    def to_dict(self) -> dict[str, str]:
        if self.kind == "env":
            return {"kind": "env", "name": str(self.name)}
        if self.kind == "keyring":
            return {
                "kind": "keyring",
                "service": str(self.service),
                "account": str(self.account),
            }
        return {"kind": "none"}


@dataclass(frozen=True, slots=True)
class _ProviderAlias:
    provider: str
    protocol: str
    endpoint_url: str | None = None


_PROVIDER_ALIASES: dict[str, _ProviderAlias] = {
    "openai": _ProviderAlias("openai", OPENAI_CHAT, "https://api.openai.com/v1"),
    "openai-chat": _ProviderAlias("openai", OPENAI_CHAT, "https://api.openai.com/v1"),
    "openai-compatible": _ProviderAlias("openai", OPENAI_CHAT),
    "chat-completions": _ProviderAlias("openai", OPENAI_CHAT),
    "openai-responses": _ProviderAlias(
        "openai", OPENAI_RESPONSES, "https://api.openai.com/v1"
    ),
    "responses": _ProviderAlias("openai", OPENAI_RESPONSES),
    "anthropic": _ProviderAlias(
        "anthropic", ANTHROPIC_MESSAGES, "https://api.anthropic.com"
    ),
    "anthropic-messages": _ProviderAlias(
        "anthropic", ANTHROPIC_MESSAGES, "https://api.anthropic.com"
    ),
    "claude": _ProviderAlias("anthropic", ANTHROPIC_MESSAGES),
    "ollama": _ProviderAlias(
        "ollama", OLLAMA_NATIVE, "http://127.0.0.1:11434/api/chat"
    ),
    "ollama-native": _ProviderAlias(
        "ollama", OLLAMA_NATIVE, "http://127.0.0.1:11434/api/chat"
    ),
    "ollama-openai": _ProviderAlias(
        "ollama", OPENAI_CHAT, "http://127.0.0.1:11434/v1"
    ),
    "vllm": _ProviderAlias("vllm", OPENAI_CHAT, "http://127.0.0.1:8000/v1"),
    "sglang": _ProviderAlias("sglang", OPENAI_CHAT, "http://127.0.0.1:30000/v1"),
    "llamacpp": _ProviderAlias(
        "llamacpp", OPENAI_CHAT, "http://127.0.0.1:8080/v1"
    ),
    "llama-cpp": _ProviderAlias(
        "llamacpp", OPENAI_CHAT, "http://127.0.0.1:8080/v1"
    ),
    "llama.cpp": _ProviderAlias(
        "llamacpp", OPENAI_CHAT, "http://127.0.0.1:8080/v1"
    ),
    "omlx": _ProviderAlias("omlx", OPENAI_CHAT, "http://127.0.0.1:8000/v1"),
    "o-mlx": _ProviderAlias("omlx", OPENAI_CHAT, "http://127.0.0.1:8000/v1"),
    "mlx": _ProviderAlias("mlx", MLX_NATIVE),
    "mlx-native": _ProviderAlias("mlx", MLX_NATIVE),
    "mlx-lm": _ProviderAlias("mlx", MLX_NATIVE),
}

_PROVIDER_PROTOCOLS: dict[str, frozenset[str]] = {
    "openai": frozenset({OPENAI_CHAT, OPENAI_RESPONSES}),
    "anthropic": frozenset({ANTHROPIC_MESSAGES}),
    "ollama": frozenset({OLLAMA_NATIVE, OPENAI_CHAT}),
    "vllm": frozenset({OPENAI_CHAT}),
    "sglang": frozenset({OPENAI_CHAT}),
    "llamacpp": frozenset({OPENAI_CHAT}),
    "omlx": frozenset({OPENAI_CHAT}),
    "mlx": frozenset({MLX_NATIVE}),
}


def _normalize_provider_alias(value: str) -> _ProviderAlias:
    alias = str(value or "").strip().casefold().replace("_", "-")
    resolved = _PROVIDER_ALIASES.get(alias)
    if resolved is None:
        raise ProviderProfileError(
            "provider must be openai, anthropic, ollama, vllm, sglang, "
            "llama.cpp, oMLX, or MLX"
        )
    return resolved


def _normalize_protocol(value: str | None, *, alias: _ProviderAlias) -> str:
    protocol = (
        str(value).strip().casefold().replace("_", "-")
        if value is not None
        else alias.protocol
    )
    protocol_aliases = {
        "chat": OPENAI_CHAT,
        "chat-completions": OPENAI_CHAT,
        "openai-compatible": OPENAI_CHAT,
        "openai-chat-compatible": OPENAI_CHAT,
        "responses": OPENAI_RESPONSES,
        "anthropic": ANTHROPIC_MESSAGES,
        "messages": ANTHROPIC_MESSAGES,
        "ollama": OLLAMA_NATIVE,
        "mlx": MLX_NATIVE,
    }
    protocol = protocol_aliases.get(protocol, protocol)
    if protocol not in SUPPORTED_PROTOCOLS:
        raise ProviderProfileError("unsupported provider protocol")
    if protocol not in _PROVIDER_PROTOCOLS[alias.provider]:
        raise ProviderProfileError(
            f"provider {alias.provider!r} does not support protocol {protocol!r}"
        )
    return protocol


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _endpoint_host_scope(
    hostname: str,
    *,
    allow_private: bool = False,
) -> tuple[str, str]:
    host = hostname.strip().casefold().rstrip(".")
    if not host:
        raise ProviderProfileError("endpoint URL requires a hostname")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        try:
            ascii_host = host.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise ProviderProfileError("endpoint hostname is not valid IDNA") from exc
        if (
            len(ascii_host) > 253
            or any(not _DNS_LABEL_RE.fullmatch(label) for label in ascii_host.split("."))
        ):
            raise ProviderProfileError("endpoint hostname is not a valid DNS name")
        if ascii_host in _DENIED_REMOTE_HOSTS or ascii_host.endswith(".localhost"):
            if ascii_host == "localhost" or ascii_host.endswith(".localhost"):
                return ascii_host, "local"
            raise ProviderProfileError("endpoint hostname is denied by SSRF policy")
        if ascii_host.endswith(_DENIED_REMOTE_SUFFIXES):
            raise ProviderProfileError("endpoint hostname is denied by SSRF policy")
        if ascii_host.endswith(_PRIVATE_NETWORK_SUFFIXES) or "." not in ascii_host:
            if not allow_private:
                raise ProviderProfileError(
                    "private-network endpoint requires explicit allow_private=true"
                )
            return ascii_host, "private"
        return ascii_host, "remote"
    if ip.is_loopback:
        return ip.compressed, "local"
    if ip in _METADATA_IPS:
        raise ProviderProfileError("endpoint IP is denied by SSRF policy")
    if ip.is_private or ip.is_link_local:
        if not allow_private:
            raise ProviderProfileError(
                "private-network endpoint requires explicit allow_private=true"
            )
        return ip.compressed, "private"
    if not ip.is_global:
        raise ProviderProfileError(
            "endpoint IP is private, link-local, reserved, multicast, or unspecified"
        )
    return ip.compressed, "remote"


def validate_runtime_endpoint_authority(
    endpoint_url: str,
    *,
    expected_scope: str,
    resolver: Callable[..., Sequence[tuple[Any, ...]]] = socket.getaddrinfo,
) -> tuple[str, ...]:
    """Re-resolve a saved endpoint and enforce its approved network scope.

    Profile creation validates the operator's URL and records one of
    ``local``, ``private``, or ``remote``.  This request-time check resolves the
    authority again immediately before use, rejects mixed-scope DNS answers and
    cloud-metadata targets, and refuses any change from the approved scope.

    The returned addresses are diagnostic metadata only.  The standard HTTP
    transports still perform their own connection; callers must therefore keep
    redirects and ambient proxy use disabled as a separate authority boundary.
    """
    expected = str(expected_scope or "").strip().casefold()
    if expected not in {"local", "private", "remote"}:
        raise ProviderProfileError("endpoint scope must be local, private, or remote")
    try:
        parsed = urlsplit(str(endpoint_url or "").strip())
        port = parsed.port
    except ValueError as exc:
        raise ProviderProfileError("endpoint URL has an invalid authority") from exc
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ProviderProfileError("endpoint must be an absolute HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ProviderProfileError("endpoint URL must not contain user information")
    if parsed.query or parsed.fragment:
        raise ProviderProfileError("endpoint URL must not contain a query or fragment")

    host = parsed.hostname.casefold().rstrip(".")
    try:
        literal = ipaddress.ip_address(host)
        ascii_host = literal.compressed
    except ValueError:
        literal = None
        try:
            ascii_host = host.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise ProviderProfileError("endpoint hostname is not valid IDNA") from exc
        if (
            len(ascii_host) > 253
            or any(not _DNS_LABEL_RE.fullmatch(label) for label in ascii_host.split("."))
        ):
            raise ProviderProfileError("endpoint hostname is not a valid DNS name")
        if ascii_host in _DENIED_REMOTE_HOSTS and ascii_host not in {
            "localhost",
            "localhost.localdomain",
        }:
            raise ProviderProfileError("endpoint hostname is denied by SSRF policy")

    resolved_port = port or (443 if parsed.scheme.casefold() == "https" else 80)
    if not 1 <= resolved_port <= 65535:
        raise ProviderProfileError("endpoint URL port must be between 1 and 65535")

    if literal is not None:
        addresses = (literal,)
    elif ascii_host == "localhost" or ascii_host.endswith(".localhost"):
        # The special-use localhost namespace must never be delegated to DNS.
        addresses = (ipaddress.ip_address("127.0.0.1"),)
    else:
        try:
            records = resolver(ascii_host, resolved_port, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise ProviderProfileError(f"endpoint DNS resolution failed: {exc}") from exc
        collected: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
        for record in records:
            try:
                address = ipaddress.ip_address(record[4][0])
            except (IndexError, TypeError, ValueError):
                continue
            if address not in collected:
                collected.append(address)
        if not collected:
            raise ProviderProfileError(
                "endpoint DNS resolution returned no usable addresses"
            )
        addresses = tuple(collected)

    scopes: set[str] = set()
    for address in addresses:
        if address in _METADATA_IPS:
            raise ProviderProfileError("endpoint IP is denied by SSRF policy")
        if address.is_unspecified or address.is_multicast or address.is_reserved:
            raise ProviderProfileError(
                "endpoint IP is reserved, multicast, or unspecified"
            )
        if address.is_loopback:
            scopes.add("local")
        elif address.is_private or address.is_link_local:
            scopes.add("private")
        elif address.is_global:
            scopes.add("remote")
        else:
            raise ProviderProfileError("endpoint IP is not an allowed network target")

    # A non-local hostname that resolves to loopback is private authority, not
    # permission to inherit the localhost HTTP exception.
    if literal is None and not (
        ascii_host == "localhost" or ascii_host.endswith(".localhost")
    ) and scopes == {"local"}:
        scopes = {"private"}
    if len(scopes) != 1:
        raise ProviderProfileError(
            "endpoint DNS resolves across multiple network scopes"
        )
    actual = next(iter(scopes))
    if actual != expected:
        raise ProviderProfileError(
            f"endpoint destination scope changed from {expected} to {actual}"
        )
    if parsed.scheme.casefold() == "http" and actual != "local":
        raise ProviderProfileError("plain HTTP is allowed only for loopback endpoints")
    return tuple(str(address) for address in addresses)


def _canonical_endpoint_path(path: str, *, protocol: str) -> str:
    if "\\" in path or _DANGEROUS_ENCODED_PATH_RE.search(path):
        raise ProviderProfileError("endpoint URL path contains ambiguous encoded separators")
    normalized = posixpath.normpath("/" + path.lstrip("/"))
    if normalized in {"/", "/."}:
        normalized = ""
    terminal_suffixes: dict[str, tuple[str, ...]] = {
        OPENAI_CHAT: ("/chat/completions",),
        OPENAI_RESPONSES: ("/responses",),
        ANTHROPIC_MESSAGES: ("/v1/messages",),
        OLLAMA_NATIVE: ("/api/chat",),
    }
    for suffix in terminal_suffixes.get(protocol, ()):
        if normalized.casefold().endswith(suffix):
            if protocol == OLLAMA_NATIVE:
                # agent.model recognizes native Ollama only from an explicit
                # /api/chat endpoint, so canonicalize to that full route.
                normalized = normalized[: -len(suffix)] + suffix
            else:
                normalized = normalized[: -len(suffix)]
            break
    return normalized.rstrip("/")


def normalize_endpoint_url(
    url: str,
    *,
    protocol: str,
    allow_remote: bool,
    allow_private: bool = False,
) -> str:
    """Normalize and validate one model endpoint under the SSRF policy.

    Remote profiles require explicit ``allow_remote=True``, HTTPS, a public
    FQDN/global literal IP, no userinfo/query/fragment, and runtime DNS
    re-validation by probe executors.  Local profiles accept only loopback.
    """
    raw = str(url or "").strip()
    if not raw or _CONTROL_RE.search(raw):
        raise ProviderProfileError("endpoint must be a non-empty absolute HTTP(S) URL")
    protocol = str(protocol or "").strip().casefold().replace("_", "-")
    if protocol not in SUPPORTED_PROTOCOLS - {MLX_NATIVE}:
        raise ProviderProfileError("network endpoint requires a supported HTTP protocol")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise ProviderProfileError("endpoint URL has an invalid host or port") from exc
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ProviderProfileError("endpoint must be an absolute HTTP(S) URL")
    if port == 0:
        raise ProviderProfileError("endpoint URL port must be between 1 and 65535")
    if parsed.username is not None or parsed.password is not None:
        raise ProviderProfileError("endpoint URL must not contain user information")
    if parsed.query or parsed.fragment:
        raise ProviderProfileError("endpoint URL must not contain a query or fragment")
    host, scope = _endpoint_host_scope(
        parsed.hostname,
        allow_private=allow_private,
    )
    scheme = parsed.scheme.casefold()
    if scope == "remote":
        if not allow_remote:
            raise ProviderProfileError(
                "remote endpoint requires explicit allow_remote=true"
            )
        if scheme != "https":
            raise ProviderProfileError("remote endpoint must use HTTPS")
    elif scope == "private":
        if not allow_private:
            raise ProviderProfileError(
                "private-network endpoint requires explicit allow_private=true"
            )
        if scheme != "https":
            raise ProviderProfileError("private-network endpoint must use HTTPS")
    path = _canonical_endpoint_path(parsed.path, protocol=protocol)
    if ":" in host:
        rendered_host = f"[{host}]"
    else:
        rendered_host = host
    default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    netloc = rendered_host if port is None or default_port else f"{rendered_host}:{port}"
    normalized = urlunsplit((scheme, netloc, path, "", ""))
    _assert_secret_free(normalized, field_name="endpoint URL")
    return normalized


def validate_endpoint_url(
    url: str,
    *,
    protocol: str,
    allow_remote: bool,
    allow_private: bool = False,
) -> str:
    """Stable validation alias; returns the normalized endpoint URL."""
    return normalize_endpoint_url(
        url,
        protocol=protocol,
        allow_remote=allow_remote,
        allow_private=allow_private,
    )


def _metadata_items(value: Any) -> tuple[tuple[str, str], ...]:
    if value is None:
        return ()
    if not isinstance(value, Mapping):
        raise ProviderProfileError("metadata must be an object of string pairs")
    if len(value) > 16:
        raise ProviderProfileError("metadata accepts at most 16 entries")
    items: list[tuple[str, str]] = []
    for raw_key, raw_value in value.items():
        key = str(raw_key).strip()
        text = str(raw_value).strip()
        if not _METADATA_KEY_RE.fullmatch(key):
            raise ProviderProfileError("metadata keys must use safe identifier characters")
        if _is_secret_field_name(key):
            raise ProviderProfileError("metadata keys must not name credential fields")
        if not text or len(text) > 512 or _CONTROL_RE.search(text):
            raise ProviderProfileError("metadata values must be non-empty strings up to 512 chars")
        _assert_secret_free(text, field_name=f"metadata field {key!r}")
        items.append((key, text))
    return tuple(sorted(items))


def _int_option(value: Any, *, name: str, minimum: int, maximum: int) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ProviderProfileError(f"{name} must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ProviderProfileError(f"{name} must be an integer") from exc
    if parsed < minimum or parsed > maximum:
        raise ProviderProfileError(f"{name} must be between {minimum} and {maximum}")
    return parsed


@dataclass(frozen=True, slots=True)
class ProviderProfile:
    """Validated, serializable provider profile with reference-only credentials."""

    name: str
    provider: str
    protocol: str
    model: str
    endpoint_url: str | None = None
    credential: CredentialReference = field(default_factory=CredentialReference)
    allow_remote: bool = False
    allow_private: bool = False
    metadata: tuple[tuple[str, str], ...] = ()
    timeout_sec: int | None = None
    max_output_tokens: int | None = None
    context_window: int | None = None

    @classmethod
    def from_value(
        cls,
        value: "ProviderProfile | Mapping[str, Any]",
    ) -> "ProviderProfile":
        if isinstance(value, cls):
            return value
        if not isinstance(value, Mapping):
            raise ProviderProfileError("profile must be a ProviderProfile or mapping")
        forbidden = [str(key) for key in value if _is_secret_field_name(str(key))]
        # credential / credential_ref are safe reference fields, not secret values.
        forbidden = [
            key
            for key in forbidden
            if key.casefold().replace("-", "_")
            not in {"credential", "credential_ref"}
        ]
        if forbidden:
            raise ProviderProfileError(
                f"inline credential fields are forbidden: {sorted(forbidden)}"
            )
        aliases = {
            "base_url": "endpoint_url",
            "baseUrl": "endpoint_url",
            "endpoint": "endpoint_url",
            "credential_ref": "credential",
            "credentialRef": "credential",
            "timeout": "timeout_sec",
            "timeoutSec": "timeout_sec",
            "max_tokens": "max_output_tokens",
            "maxOutputTokens": "max_output_tokens",
            "contextWindow": "context_window",
            "allowRemote": "allow_remote",
            "allowPrivate": "allow_private",
            "allowPrivateNetwork": "allow_private",
            "displayName": "name",
            "kind": "provider",
        }
        normalized: dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            key = aliases.get(str(raw_key), str(raw_key))
            if key in normalized:
                raise ProviderProfileError(f"profile field {key!r} was provided more than once")
            normalized[key] = raw_value
        allowed = {
            "name",
            "provider",
            "protocol",
            "model",
            "endpoint_url",
            "credential",
            "allow_remote",
            "allow_private",
            "metadata",
            "timeout_sec",
            "max_output_tokens",
            "context_window",
        }
        unknown = set(normalized) - allowed
        if unknown:
            raise ProviderProfileError(f"profile has unsupported fields: {sorted(unknown)}")
        provider_value = str(normalized.get("provider") or "").strip()
        if not provider_value:
            protocol_value = (
                str(normalized.get("protocol") or "")
                .strip()
                .casefold()
                .replace("_", "-")
            )
            provider_value = {
                OPENAI_CHAT: "openai-compatible",
                "openai-compatible": "openai-compatible",
                OPENAI_RESPONSES: "openai-responses",
                "responses": "openai-responses",
                ANTHROPIC_MESSAGES: "anthropic",
                "messages": "anthropic",
                OLLAMA_NATIVE: "ollama",
                MLX_NATIVE: "mlx",
            }.get(protocol_value, "")
        alias = _normalize_provider_alias(provider_value)
        protocol = _normalize_protocol(normalized.get("protocol"), alias=alias)
        name = normalize_profile_name(str(normalized.get("name") or ""))
        model = str(normalized.get("model") or "").strip()
        if (
            not model
            or len(model) > 512
            or _CONTROL_RE.search(model)
            or "@" in model
        ):
            raise ProviderProfileError(
                "model must be a non-empty string up to 512 chars and must not contain '@'"
            )
        _assert_secret_free(model, field_name="model")
        allow_remote = normalized.get("allow_remote", False)
        if not isinstance(allow_remote, bool):
            raise ProviderProfileError("allow_remote must be a boolean")
        allow_private = normalized.get("allow_private", False)
        if not isinstance(allow_private, bool):
            raise ProviderProfileError("allow_private must be a boolean")
        credential = CredentialReference.parse(normalized.get("credential"))
        endpoint_raw = normalized.get("endpoint_url")
        if protocol == MLX_NATIVE:
            if endpoint_raw not in (None, ""):
                raise ProviderProfileError("MLX native profiles must not define an endpoint")
            if credential.kind != "none":
                raise ProviderProfileError("MLX native profiles must not define credentials")
            endpoint_url = None
        else:
            endpoint = str(endpoint_raw or alias.endpoint_url or "").strip()
            if not endpoint:
                raise ProviderProfileError("network provider profile requires endpoint_url")
            endpoint_url = normalize_endpoint_url(
                endpoint,
                protocol=protocol,
                allow_remote=allow_remote,
                allow_private=allow_private,
            )
            scope = _endpoint_host_scope(
                str(urlsplit(endpoint_url).hostname),
                allow_private=allow_private,
            )[1]
            if scope == "remote" and credential.kind == "none":
                raise ProviderProfileError(
                    "remote endpoint requires an env or keyring credential reference"
                )
        return cls(
            name=name,
            provider=alias.provider,
            protocol=protocol,
            model=model,
            endpoint_url=endpoint_url,
            credential=credential,
            allow_remote=allow_remote,
            allow_private=allow_private,
            metadata=_metadata_items(normalized.get("metadata")),
            timeout_sec=_int_option(
                normalized.get("timeout_sec"),
                name="timeout_sec",
                minimum=1,
                maximum=3600,
            ),
            max_output_tokens=_int_option(
                normalized.get("max_output_tokens"),
                name="max_output_tokens",
                minimum=1,
                maximum=1_000_000,
            ),
            context_window=_int_option(
                normalized.get("context_window"),
                name="context_window",
                minimum=128,
                maximum=10_000_000,
            ),
        )

    @property
    def endpoint_scope(self) -> str:
        if self.endpoint_url is None:
            return "on-device"
        return _endpoint_host_scope(
            str(urlsplit(self.endpoint_url).hostname),
            allow_private=self.allow_private,
        )[1]

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "provider": self.provider,
            "protocol": self.protocol,
            "model": self.model,
            "endpoint_url": self.endpoint_url,
            "endpoint_scope": self.endpoint_scope,
            "credential_ref": self.credential.to_uri(),
            "credential": self.credential.to_dict(),
            "allow_remote": self.allow_remote,
            "allow_private": self.allow_private,
            "metadata": dict(self.metadata),
            "timeout_sec": self.timeout_sec,
            "max_output_tokens": self.max_output_tokens,
            "context_window": self.context_window,
        }


@dataclass(frozen=True, slots=True)
class ProbePlan:
    """Non-executing, secret-free connectivity or wire-format probe plan."""

    profile_name: str
    probe_type: str
    protocol: str
    method: str
    url: str | None
    credential_ref: CredentialReference
    auth_header: str | None = None
    auth_scheme: str | None = None
    headers: tuple[tuple[str, str], ...] = ()
    body: Mapping[str, Any] | None = None
    timeout_sec: int = 5
    max_response_bytes: int = 65_536
    runtime_checks: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": PROBE_SCHEMA,
            "profile": self.profile_name,
            "probeType": self.probe_type,
            "protocol": self.protocol,
            "method": self.method,
            "url": self.url,
            "credentialRef": self.credential_ref.to_dict(),
            "authHeader": self.auth_header,
            "authScheme": self.auth_scheme,
            "headers": dict(self.headers),
            "body": dict(self.body) if self.body is not None else None,
            "timeoutSec": self.timeout_sec,
            "maxResponseBytes": self.max_response_bytes,
            "runtimeChecks": list(self.runtime_checks),
        }


def profiles_path(path: str | Path | None = None) -> Path:
    """Return the profile TOML path, honoring the per-user Sophia state root."""
    return (
        Path(path).expanduser()
        if path is not None
        else user_state_dir() / "config" / "provider-profiles.toml"
    )


def _ensure_private_directory(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or not directory.is_dir():
        raise ProviderProfileError("provider profile directory must be a real directory")
    try:
        directory.chmod(0o700)
    except OSError as exc:
        raise ProviderProfileError("could not secure provider profile directory") from exc
    if hasattr(os, "getuid"):
        info = directory.stat()
        if info.st_uid != os.getuid():
            raise ProviderProfileError("provider profile directory is not owned by this user")
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise ProviderProfileError("provider profile directory is not owner-only")


def _check_store_file(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ProviderProfileError("provider profile store must be a regular non-symlink file")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise ProviderProfileError("provider profile store is not owned by this user")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ProviderProfileError("provider profile store permissions must be owner-only")


@contextmanager
def _locked_store(path: Path) -> Iterator[None]:
    _ensure_private_directory(path.parent)
    lock_path = path.with_name(f".{path.name}.lock")
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(lock_path, flags, 0o600)
    except OSError as exc:
        raise ProviderProfileError("could not open provider profile lock safely") from exc
    try:
        os.fchmod(fd, 0o600)
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _load_profiles_unlocked(path: Path) -> dict[str, ProviderProfile]:
    _check_store_file(path)
    if not path.exists():
        return {}
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8", errors="strict"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        raise ProviderProfileError("provider profile store is unreadable or malformed") from exc
    if set(data) - {"schema", "version", "profiles"}:
        raise ProviderProfileError("provider profile store has unsupported top-level fields")
    if data.get("schema") != STORE_SCHEMA or data.get("version") != STORE_VERSION:
        raise ProviderProfileError("provider profile store schema/version is not supported")
    raw_profiles = data.get("profiles", {})
    if not isinstance(raw_profiles, Mapping):
        raise ProviderProfileError("provider profile store 'profiles' must be a table")
    loaded: dict[str, ProviderProfile] = {}
    for stored_name, raw in raw_profiles.items():
        if not isinstance(raw, Mapping):
            raise ProviderProfileError("stored provider profile must be a table")
        profile = ProviderProfile.from_value({"name": stored_name, **dict(raw)})
        if profile.name in loaded:
            raise ProviderProfileError("provider profile store has duplicate normalized names")
        loaded[profile.name] = profile
    return loaded


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _serialize_profiles(profiles: Mapping[str, ProviderProfile]) -> str:
    lines = [
        f"schema = {_toml_string(STORE_SCHEMA)}",
        f"version = {STORE_VERSION}",
        "",
    ]
    for name in sorted(profiles):
        profile = profiles[name]
        section = f"profiles.{_toml_string(name)}"
        lines.extend([
            f"[{section}]",
            f"provider = {_toml_string(profile.provider)}",
            f"protocol = {_toml_string(profile.protocol)}",
            f"model = {_toml_string(profile.model)}",
            f"allow_remote = {'true' if profile.allow_remote else 'false'}",
            f"allow_private = {'true' if profile.allow_private else 'false'}",
            f"credential_ref = {_toml_string(profile.credential.to_uri())}",
        ])
        if profile.endpoint_url is not None:
            lines.append(f"endpoint_url = {_toml_string(profile.endpoint_url)}")
        if profile.timeout_sec is not None:
            lines.append(f"timeout_sec = {profile.timeout_sec}")
        if profile.max_output_tokens is not None:
            lines.append(f"max_output_tokens = {profile.max_output_tokens}")
        if profile.context_window is not None:
            lines.append(f"context_window = {profile.context_window}")
        lines.append("")
        if profile.metadata:
            lines.append(f"[{section}.metadata]")
            for key, value in profile.metadata:
                lines.append(f"{_toml_string(key)} = {_toml_string(value)}")
            lines.append("")
    text = "\n".join(lines).rstrip() + "\n"
    if find_secrets(text):
        raise ProviderProfileError("refusing to persist credential material")
    return text


def _fsync_directory(directory: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        fd = os.open(directory, flags)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_profiles_unlocked(path: Path, profiles: Mapping[str, ProviderProfile]) -> None:
    text = _serialize_profiles(profiles)
    _check_store_file(path)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    tmp = Path(tmp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", closefd=True) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        path.chmod(0o600)
        _fsync_directory(path.parent)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    finally:
        tmp.unlink(missing_ok=True)


def list_profiles(*, path: str | Path | None = None) -> tuple[ProviderProfile, ...]:
    """List stored profiles in stable name order; never returns secret values."""
    target = profiles_path(path)
    with _locked_store(target):
        profiles = _load_profiles_unlocked(target)
    return tuple(profiles[name] for name in sorted(profiles))


def get_profile(
    name: str,
    *,
    path: str | Path | None = None,
) -> ProviderProfile | None:
    """Return one stored profile, or ``None`` when its normalized name is absent."""
    normalized = normalize_profile_name(name)
    target = profiles_path(path)
    with _locked_store(target):
        return _load_profiles_unlocked(target).get(normalized)


def upsert_profile(
    profile: ProviderProfile | Mapping[str, Any],
    *,
    path: str | Path | None = None,
) -> ProviderProfile:
    """Validate and atomically create/update one profile."""
    validated = ProviderProfile.from_value(profile)
    target = profiles_path(path)
    with _locked_store(target):
        profiles = _load_profiles_unlocked(target)
        profiles[validated.name] = validated
        _write_profiles_unlocked(target, profiles)
    return validated


def add_profile(
    profile: ProviderProfile | Mapping[str, Any],
    *,
    path: str | Path | None = None,
) -> ProviderProfile:
    """Validate and atomically add one profile, failing if its name exists."""
    validated = ProviderProfile.from_value(profile)
    target = profiles_path(path)
    with _locked_store(target):
        profiles = _load_profiles_unlocked(target)
        if validated.name in profiles:
            raise ProviderProfileError(
                f"provider profile {validated.name!r} already exists"
            )
        profiles[validated.name] = validated
        _write_profiles_unlocked(target, profiles)
    return validated


def update_profile(
    profile: ProviderProfile | Mapping[str, Any],
    *,
    path: str | Path | None = None,
) -> ProviderProfile:
    """Validate and atomically replace one profile, failing if it is absent."""
    validated = ProviderProfile.from_value(profile)
    target = profiles_path(path)
    with _locked_store(target):
        profiles = _load_profiles_unlocked(target)
        if validated.name not in profiles:
            raise ProfileNotFoundError(
                f"provider profile {validated.name!r} was not found"
            )
        profiles[validated.name] = validated
        _write_profiles_unlocked(target, profiles)
    return validated


def save_profile(
    profile: ProviderProfile | Mapping[str, Any],
    *,
    path: str | Path | None = None,
) -> ProviderProfile:
    """Stable convenience alias for :func:`upsert_profile`."""
    return upsert_profile(profile, path=path)


def remove_profile(
    name: str,
    *,
    path: str | Path | None = None,
) -> bool:
    """Atomically remove a stored profile; return whether it existed."""
    normalized = normalize_profile_name(name)
    target = profiles_path(path)
    with _locked_store(target):
        profiles = _load_profiles_unlocked(target)
        if normalized not in profiles:
            return False
        profiles.pop(normalized)
        _write_profiles_unlocked(target, profiles)
    return True


def _coerce_profile(
    profile: ProviderProfile | Mapping[str, Any] | str,
    *,
    path: str | Path | None = None,
) -> ProviderProfile:
    if isinstance(profile, str):
        stored = get_profile(profile, path=path)
        if stored is None:
            raise ProfileNotFoundError(
                f"provider profile {normalize_profile_name(profile)!r} was not found"
            )
        return stored
    return ProviderProfile.from_value(profile)


_BUILTIN_ENV_REFS: dict[str, str] = {
    "ollama": "OLLAMA_API_KEY",
    "vllm": "VLLM_API_KEY",
    "sglang": "SGLANG_API_KEY",
    "llamacpp": "LLAMACPP_API_KEY",
    "omlx": "OMLX_API_KEY",
}
_LOCAL_DUMMY_CREDENTIAL = "sophia-local-no-key"


def credential_environment_name(profile: ProviderProfile) -> str:
    """Return the process-local env slot used for an OS-keyring credential."""
    digest = hashlib.sha256(profile.name.encode("utf-8")).hexdigest()[:16].upper()
    return f"SOPHIA_CUSTOM_PROFILE_{digest}_KEY"


def resolve_model_spec(
    profile: ProviderProfile | Mapping[str, Any] | str,
    *,
    path: str | Path | None = None,
) -> str:
    """Return an ``agent.model`` spec and register custom chat gateways.

    Environment references are passed through without reading their values.
    Keyring references are resolved only in memory and injected into a
    process-local gateway preset; the value is never persisted or returned.
    Responses API profiles use their dedicated transport and are never
    silently downgraded to chat completions.
    """
    resolved = _coerce_profile(profile, path=path)
    if resolved.protocol == MLX_NATIVE:
        return f"mlx:{resolved.model}"
    if resolved.endpoint_url is None:
        raise UnsupportedProfileError("network profile has no endpoint")

    # Existing loopback aliases supply their own non-secret dummy key defaults.
    # Private/LAN endpoints must stay on the explicitly registered custom path
    # so their approval receipt and local/self-hosted classification survive.
    builtin_env = _BUILTIN_ENV_REFS.get(resolved.provider)
    if resolved.endpoint_scope == "local" and resolved.provider in _BUILTIN_ENV_REFS and (
        resolved.credential.kind == "none"
        or (
            resolved.credential.kind == "env"
            and resolved.credential.name == builtin_env
        )
    ):
        return f"{resolved.provider}:{resolved.model}@{resolved.endpoint_url}"

    if resolved.protocol == OLLAMA_NATIVE and resolved.provider != "ollama":
        raise UnsupportedProfileError("ollama-native protocol requires provider 'ollama'")
    kind = {
        ANTHROPIC_MESSAGES: "anthropic",
        OPENAI_RESPONSES: "openai-responses",
    }.get(resolved.protocol, "openai")
    credential_value: str | None = None
    api_key_env: str | None = None
    if resolved.credential.kind == "env":
        api_key_env = resolved.credential.name
    elif resolved.credential.kind == "keyring":
        api_key_env = credential_environment_name(resolved)
        os.environ[api_key_env] = resolve_credential_value(resolved.credential)
    elif resolved.endpoint_scope == "remote":
        raise UnsupportedProfileError(
            "remote custom gateways require an environment or keyring credential reference"
        )
    else:
        # The current model adapter requires a non-empty key even for no-auth
        # loopback/private servers. This constant is an explicit dummy, not a
        # credential, and private scope was explicitly approved on the profile.
        credential_value = _LOCAL_DUMMY_CREDENTIAL
    # Lazy import avoids coupling persistence/probe planning to the large model
    # adapter and lets Bridge inspect profiles without importing provider SDKs.
    from agent import model as model_adapter

    alias = f"custom.{resolved.name}"
    model_adapter.register_external_gateway(
        alias,
        base_url=resolved.endpoint_url,
        model=resolved.model,
        kind=kind,
        api_key_env=api_key_env,
        api_key_default=credential_value,
        context_window=resolved.context_window,
        max_tokens=resolved.max_output_tokens,
        timeout_sec=resolved.timeout_sec,
        strict_key_source=True,
        allow_fallbacks=False,
        allow_private_network=resolved.endpoint_scope == "private",
        endpoint_scope=resolved.endpoint_scope,
    )
    return f"{alias}:{resolved.model}"


_APPROVED_KEYRING_BACKEND_MARKERS = (
    "keyring.backends.macos.",
    "keyring.backends.secretservice.",
    "keyring.backends.windows.",
    "keyring.backends.kwallet.",
)


def _is_approved_os_keyring_backend(backend: Any) -> bool:
    """Return True only for explicitly approved OS-integrated keyring backends."""
    backend_name = (
        f"{type(backend).__module__}.{type(backend).__name__}"
    ).casefold()
    try:
        priority = float(getattr(backend, "priority", 0) or 0)
    except (TypeError, ValueError):
        return False
    return priority > 0 and any(
        marker in backend_name for marker in _APPROVED_KEYRING_BACKEND_MARKERS
    )


def resolve_credential_value(reference: CredentialReference) -> str:
    """Resolve a credential for one Bridge execution, never for serialization.

    This is the only public API here that can return a raw value. Callers must
    keep it ephemeral, must not log it, and must remove any temporary process
    environment entry after the approved request.
    """
    reference = CredentialReference.parse(reference)
    if reference.kind == "env":
        value = (os.environ.get(str(reference.name)) or "").strip()
        if not value:
            raise UnsupportedProfileError(
                f"credential environment variable {reference.name} is not set"
            )
        return value
    if reference.kind != "keyring":
        return ""
    service = str(reference.service)
    account = str(reference.account)
    try:
        import keyring  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        keyring = None
    if keyring is not None:
        try:
            backend = keyring.get_keyring()
            if _is_approved_os_keyring_backend(backend):
                value = keyring.get_password(service, account)
                if value:
                    return value
        except Exception:
            pass
    if sys.platform == "darwin":
        try:
            result = subprocess.run(
                [
                    "security",
                    "find-generic-password",
                    "-s",
                    service,
                    "-a",
                    account,
                    "-w",
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            result = None
        if result is not None and result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    raise UnsupportedProfileError(
        f"credential keyring entry {service}/{account} is unavailable"
    )


def store_credential_value(reference: CredentialReference, value: str) -> None:
    """Store one credential in an approved OS-backed keyring, or fail closed.

    The raw value is accepted only at this execution boundary. It is never
    returned, serialized, logged, or written to the profile TOML store.
    Environment references are intentionally unsupported here because Sophia
    cannot safely mutate a parent shell's environment.
    """
    reference = CredentialReference.parse(reference)
    if reference.kind != "keyring":
        raise UnsupportedProfileError(
            "one-time secret storage requires keyring:SERVICE/ACCOUNT"
        )
    secret = str(value or "").strip()
    if not secret:
        raise ProviderProfileError("credential value is required")
    service = str(reference.service)
    account = str(reference.account)
    try:
        import keyring  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        keyring = None
    if keyring is not None:
        try:
            backend = keyring.get_keyring()
            if not _is_approved_os_keyring_backend(backend):
                raise UnsupportedProfileError(
                    "the active keyring backend is not an approved OS-backed store"
                )
            keyring.set_password(service, account, secret)
            return
        except UnsupportedProfileError:
            raise
        except Exception as exc:
            raise UnsupportedProfileError(
                "secure credential storage is unavailable; nothing was stored"
            ) from exc
    raise UnsupportedProfileError(
        "secure credential storage is unavailable; nothing was stored"
    )


def delete_credential_value(reference: CredentialReference) -> bool:
    """Delete one OS-keyring credential without exposing its previous value."""
    reference = CredentialReference.parse(reference)
    if reference.kind != "keyring":
        return False
    service = str(reference.service)
    account = str(reference.account)
    deleted = False
    try:
        import keyring  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        keyring = None
    if keyring is not None:
        try:
            keyring.delete_password(service, account)
            deleted = True
        except Exception:
            pass
    if sys.platform == "darwin":
        try:
            removed = subprocess.run(
                [
                    "security",
                    "delete-generic-password",
                    "-s",
                    service,
                    "-a",
                    account,
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            removed = None
        if removed is not None and removed.returncode == 0:
            deleted = True
    return deleted


def _append_endpoint(base: str, suffix: str) -> str:
    parsed = urlsplit(base)
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, f"{path}{suffix}", "", ""))


def _probe_runtime_checks(profile: ProviderProfile) -> tuple[str, ...]:
    common = ("disable_environment_proxies", "reject_redirects")
    if profile.endpoint_scope == "local":
        return common + ("require_loopback_peer",)
    if profile.endpoint_scope == "private":
        return common + (
            "resolve_dns_before_connect",
            "require_private_network_peer",
            "pin_validated_address_for_connection",
        )
    if profile.endpoint_scope == "remote":
        return common + (
            "resolve_dns_before_connect",
            "reject_non_global_resolved_addresses",
            "pin_validated_address_for_connection",
        )
    return ("resolve_local_model_without_network",)


def _auth_shape(
    profile: ProviderProfile,
) -> tuple[str | None, str | None, tuple[tuple[str, str], ...]]:
    content_type = (("content-type", "application/json"),)
    if profile.credential.kind == "none":
        return None, None, content_type
    if profile.protocol == ANTHROPIC_MESSAGES:
        return (
            "x-api-key",
            "direct",
            (("anthropic-version", "2023-06-01"), *content_type),
        )
    if profile.protocol in {OPENAI_CHAT, OPENAI_RESPONSES, OLLAMA_NATIVE}:
        return ("Authorization", "Bearer", content_type)
    return None, None, ()


def plan_connectivity_probe(
    profile: ProviderProfile | Mapping[str, Any] | str,
    *,
    path: str | Path | None = None,
) -> ProbePlan:
    """Plan a bounded reachability probe without executing it."""
    resolved = _coerce_profile(profile, path=path)
    if resolved.protocol == MLX_NATIVE:
        return ProbePlan(
            profile_name=resolved.name,
            probe_type="connectivity",
            protocol=resolved.protocol,
            method="LOCAL_CHECK",
            url=None,
            credential_ref=resolved.credential,
            body={"module": "mlx_lm", "model": resolved.model, "operation": "availability"},
            runtime_checks=_probe_runtime_checks(resolved),
        )
    assert resolved.endpoint_url is not None
    if resolved.protocol in {OPENAI_CHAT, OPENAI_RESPONSES}:
        url = _append_endpoint(resolved.endpoint_url, "/models")
        method = "GET"
    elif resolved.protocol == OLLAMA_NATIVE:
        base = resolved.endpoint_url
        if base.endswith("/api/chat"):
            base = base[: -len("/api/chat")]
        url = _append_endpoint(base, "/api/tags")
        method = "GET"
    else:
        url = _append_endpoint(resolved.endpoint_url, "/v1/messages")
        method = "HEAD"
    auth_header, auth_scheme, headers = _auth_shape(resolved)
    return ProbePlan(
        profile_name=resolved.name,
        probe_type="connectivity",
        protocol=resolved.protocol,
        method=method,
        url=url,
        credential_ref=resolved.credential,
        auth_header=auth_header,
        auth_scheme=auth_scheme,
        headers=headers,
        timeout_sec=min(resolved.timeout_sec or 5, 30),
        runtime_checks=_probe_runtime_checks(resolved),
    )


def plan_format_probe(
    profile: ProviderProfile | Mapping[str, Any] | str,
    *,
    path: str | Path | None = None,
) -> ProbePlan:
    """Plan a one-token protocol-format probe without executing it."""
    resolved = _coerce_profile(profile, path=path)
    if resolved.protocol == MLX_NATIVE:
        return ProbePlan(
            profile_name=resolved.name,
            probe_type="format",
            protocol=resolved.protocol,
            method="LOCAL_CHECK",
            url=None,
            credential_ref=resolved.credential,
            body={
                "module": "mlx_lm",
                "model": resolved.model,
                "operation": "tokenizer-chat-template-check",
            },
            runtime_checks=_probe_runtime_checks(resolved),
        )
    assert resolved.endpoint_url is not None
    if resolved.protocol == OPENAI_CHAT:
        url = _append_endpoint(resolved.endpoint_url, "/chat/completions")
        body: dict[str, Any] = {
            "model": resolved.model,
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "max_tokens": 1,
            "temperature": 0,
            "stream": False,
        }
    elif resolved.protocol == OPENAI_RESPONSES:
        url = _append_endpoint(resolved.endpoint_url, "/responses")
        body = {
            "model": resolved.model,
            "input": "Reply with OK.",
            "max_output_tokens": 1,
        }
        if resolved.metadata:
            body["metadata"] = dict(resolved.metadata)
    elif resolved.protocol == ANTHROPIC_MESSAGES:
        url = _append_endpoint(resolved.endpoint_url, "/v1/messages")
        body = {
            "model": resolved.model,
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "max_tokens": 1,
        }
    elif resolved.protocol == OLLAMA_NATIVE:
        url = resolved.endpoint_url
        body = {
            "model": resolved.model,
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "stream": False,
            "options": {"num_predict": 1, "temperature": 0},
        }
    else:  # pragma: no cover - validated protocols make this unreachable.
        raise UnsupportedProfileError(f"unsupported format probe protocol {resolved.protocol!r}")
    auth_header, auth_scheme, headers = _auth_shape(resolved)
    return ProbePlan(
        profile_name=resolved.name,
        probe_type="format",
        protocol=resolved.protocol,
        method="POST",
        url=url,
        credential_ref=resolved.credential,
        auth_header=auth_header,
        auth_scheme=auth_scheme,
        headers=headers,
        body=body,
        timeout_sec=min(resolved.timeout_sec or 15, 60),
        runtime_checks=_probe_runtime_checks(resolved),
    )


def plan_profile_probe(
    profile: ProviderProfile | Mapping[str, Any] | str,
    probe_type: str,
    *,
    path: str | Path | None = None,
) -> ProbePlan:
    """Dispatch to connectivity or format planning with a stable API."""
    normalized = str(probe_type or "").strip().casefold().replace("_", "-")
    if normalized in {"connectivity", "reachability", "health"}:
        return plan_connectivity_probe(profile, path=path)
    if normalized in {"format", "protocol", "wire-format"}:
        return plan_format_probe(profile, path=path)
    raise ProviderProfileError("probe_type must be connectivity or format")


__all__ = [
    "ANTHROPIC_MESSAGES",
    "CredentialReference",
    "credential_environment_name",
    "delete_credential_value",
    "MLX_NATIVE",
    "OLLAMA_NATIVE",
    "OPENAI_CHAT",
    "OPENAI_RESPONSES",
    "PROBE_SCHEMA",
    "ProfileNotFoundError",
    "ProbePlan",
    "ProviderProfile",
    "ProviderProfileError",
    "STORE_SCHEMA",
    "STORE_VERSION",
    "SUPPORTED_PROTOCOLS",
    "UnsupportedProfileError",
    "add_profile",
    "get_profile",
    "list_profiles",
    "normalize_endpoint_url",
    "normalize_profile_name",
    "plan_connectivity_probe",
    "plan_format_probe",
    "plan_profile_probe",
    "profiles_path",
    "remove_profile",
    "resolve_credential_value",
    "resolve_model_spec",
    "store_credential_value",
    "save_profile",
    "update_profile",
    "upsert_profile",
    "validate_endpoint_url",
    "validate_runtime_endpoint_authority",
]
