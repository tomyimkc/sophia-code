# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Configurable image-provider foundations.

Resolution and health checks are no-spend. ``build_image_request`` only builds
an explicit request plan; it never invokes a CLI or API. This keeps discovery
safe while giving the TUI/tool layer a typed seam for operator-approved image
generation later.
"""
from __future__ import annotations

import base64
import binascii
import http.client
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urljoin, urlsplit

from agent.model import ProviderError, ProviderErrorCode
from agent.runtime_config import provider_profile


class ImageProviderKind(str, Enum):
    NONE = "none"
    GROK_CLI = "grok-cli"
    OPENAI = "openai"
    EXTERNAL_API = "external-api"
    EXTERNAL_COMMAND = "external-command"


IMAGE_EXECUTION_PERMISSIONS = ("auto", "approve", "readonly")
DELEGATED_AUTHORITY_DISCLOSURE = (
    "Delegated providers may autonomously use tools and network access under "
    "their configured permissions."
)


def _confirmation_text(*, delegated: bool) -> str:
    text = "Explicit confirmation is required before paid image execution."
    if delegated:
        return f"{text} {DELEGATED_AUTHORITY_DISCLOSURE}"
    return text


@dataclass(frozen=True)
class ImageProviderConfig:
    name: str
    kind: ImageProviderKind
    model: str | None = None
    binary: str | None = None
    base_url: str | None = None
    api_key_env: str | None = None
    command: tuple[str, ...] = ()
    delegated: bool = False
    native_generation: bool = False
    cost_known: bool = False
    optional: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind.value,
            "model": self.model,
            "binary": self.binary,
            "baseUrl": self.base_url,
            "apiKeyEnv": self.api_key_env,
            "credentialValueExposed": False,
            "delegated": self.delegated,
            "delegatedAuthorityDisclosure": (
                DELEGATED_AUTHORITY_DISCLOSURE if self.delegated else None
            ),
            "executionPermissionRequired": True,
            "supportedExecutionPermissions": list(IMAGE_EXECUTION_PERMISSIONS),
            "nativeGeneration": self.native_generation,
            "costKnown": self.cost_known,
            "optional": self.optional,
        }


@dataclass(frozen=True)
class ImageProviderHealth:
    provider: str
    configured: bool
    ready: bool
    detail: str
    binary_present: bool | None = None
    credential_present: bool | None = None
    paid_probe_made: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "sophia.image-provider-health.v1",
            "provider": self.provider,
            "configured": self.configured,
            "ready": self.ready,
            "detail": self.detail,
            "binaryPresent": self.binary_present,
            "credentialPresent": self.credential_present,
            "paidProbeMade": self.paid_probe_made,
            "candidateOnly": True,
            "canClaimAGI": False,
        }


@dataclass(frozen=True)
class ImageRequest:
    """An unexecuted, explicitly paid/delegated image-generation plan."""

    provider: str
    model: str | None
    prompt: str
    output_path: str
    command: tuple[str, ...] = ()
    endpoint: str | None = None
    body: dict[str, Any] | None = None
    delegated: bool = False
    paid: bool = True
    requires_explicit_approval: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "prompt": self.prompt,
            "outputPath": self.output_path,
            "command": list(self.command),
            "endpoint": self.endpoint,
            "body": dict(self.body) if self.body else None,
            "delegated": self.delegated,
            "paid": self.paid,
            "requiresExplicitApproval": self.requires_explicit_approval,
            "confirmationText": _confirmation_text(delegated=self.delegated),
            "delegatedAuthorityDisclosure": (
                DELEGATED_AUTHORITY_DISCLOSURE if self.delegated else None
            ),
            "executionPermissionRequired": True,
            "supportedExecutionPermissions": list(IMAGE_EXECUTION_PERMISSIONS),
            "executed": False,
            "candidateOnly": True,
            "canClaimAGI": False,
        }


@dataclass(frozen=True)
class ImageExecutionResult:
    """JSON-friendly outcome for one explicitly confirmed execution attempt."""

    provider: str
    output_path: str
    status: str
    ok: bool
    executed: bool
    confirmed: bool
    execution_kind: str
    delegated: bool
    detail: str
    exit_code: int | None = None
    timed_out: bool = False
    stdout: str = ""
    stderr: str = ""
    bytes_written: int | None = None
    downloaded_from_url: bool = False
    atomic_write: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "sophia.image-execution.v1",
            "provider": self.provider,
            "outputPath": self.output_path,
            "status": self.status,
            "ok": self.ok,
            "executed": self.executed,
            "confirmed": self.confirmed,
            "confirmationRequired": not self.confirmed,
            "executionKind": self.execution_kind,
            "delegated": self.delegated,
            "delegatedAuthorityDisclosure": (
                DELEGATED_AUTHORITY_DISCLOSURE if self.delegated else None
            ),
            "detail": self.detail,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "bytesWritten": self.bytes_written,
            "downloadedFromUrl": self.downloaded_from_url,
            "atomicWrite": self.atomic_write,
            "paidProbeMade": False,
            "candidateOnly": True,
            "canClaimAGI": False,
        }


IMAGE_PRESETS: dict[str, ImageProviderConfig] = {
    "none": ImageProviderConfig(
        name="none",
        kind=ImageProviderKind.NONE,
        optional=True,
    ),
    # The installed Grok Build CLI has no documented native `image` subcommand.
    # This adapter is therefore honest delegation: an explicitly invoked Grok
    # agent may use its configured image capability and save the requested file,
    # but discovery does not claim a verified native image-generation command.
    "grok-cli": ImageProviderConfig(
        name="grok-cli",
        kind=ImageProviderKind.GROK_CLI,
        model="grok-4.5",
        binary="grok",
        command=("grok",),
        delegated=True,
        native_generation=False,
        cost_known=False,
    ),
    "grok": ImageProviderConfig(
        name="grok-cli",
        kind=ImageProviderKind.GROK_CLI,
        model="grok-4.5",
        binary="grok",
        command=("grok",),
        delegated=True,
        native_generation=False,
        cost_known=False,
    ),
    "openai": ImageProviderConfig(
        name="openai",
        kind=ImageProviderKind.OPENAI,
        model="gpt-image-1",
        base_url="https://api.openai.com/v1",
        api_key_env="OPENAI_API_KEY",
        delegated=False,
        native_generation=True,
        cost_known=False,
    ),
}


def _external_image_presets() -> dict[str, ImageProviderConfig]:
    """Load optional providers without accepting inline secret values."""
    raw = (os.environ.get("SOPHIA_EXTERNAL_IMAGE_PROVIDERS") or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    providers: dict[str, ImageProviderConfig] = {}
    for raw_name, value in data.items():
        if not isinstance(raw_name, str) or not isinstance(value, dict):
            continue
        name = raw_name.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", name):
            continue
        if any(key in value for key in ("api_key", "token", "secret")):
            continue
        model = str(value.get("model") or "").strip() or None
        api_key_env = str(value.get("api_key_env") or "").strip() or None
        command_raw = value.get("command")
        if isinstance(command_raw, list) and command_raw and all(
            isinstance(part, str) and part for part in command_raw
        ):
            providers[name] = ImageProviderConfig(
                name=name,
                kind=ImageProviderKind.EXTERNAL_COMMAND,
                model=model,
                binary=command_raw[0],
                api_key_env=api_key_env,
                command=tuple(command_raw),
                delegated=True,
                native_generation=bool(value.get("native_generation", False)),
                cost_known=bool(value.get("cost_known", False)),
            )
            continue
        base_url = str(value.get("base_url") or "").strip().rstrip("/")
        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            continue
        providers[name] = ImageProviderConfig(
            name=name,
            kind=ImageProviderKind.EXTERNAL_API,
            model=model,
            base_url=base_url,
            api_key_env=api_key_env,
            delegated=False,
            native_generation=bool(value.get("native_generation", True)),
            cost_known=bool(value.get("cost_known", False)),
        )
    return providers


def available_image_providers() -> tuple[str, ...]:
    return tuple(sorted({*IMAGE_PRESETS, *_external_image_presets()}))


def resolve_image_provider(
    spec: str | None = None,
    *,
    profile: str | None = None,
) -> ImageProviderConfig:
    """Resolve explicit/env/profile image-provider configuration.

    Precedence: explicit ``spec`` -> ``SOPHIA_IMAGE_PROVIDER`` -> provider
    profile. The explicit this-Mac profile defaults to ``grok-cli``; the public
    profile defaults to ``none`` and never infers paid image use from a text key.
    """
    raw = (
        spec
        or os.environ.get("SOPHIA_IMAGE_PROVIDER")
        or provider_profile(profile).image_provider
    )
    name, separator, model_override = str(raw).strip().partition(":")
    normalized = name.strip().lower()
    preset = IMAGE_PRESETS.get(normalized) or _external_image_presets().get(normalized)
    if preset is None:
        raise ValueError(
            f"unknown image provider {normalized!r}; valid: {', '.join(available_image_providers())}"
        )
    if separator and model_override.strip():
        return ImageProviderConfig(
            **{
                **preset.__dict__,
                "model": model_override.strip(),
            }
        )
    return preset


def image_provider_health(
    spec: str | ImageProviderConfig | None = None,
    *,
    profile: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> ImageProviderHealth:
    """Presence-only health check; never executes a CLI or contacts an API."""
    env = os.environ if environ is None else environ
    try:
        cfg = spec if isinstance(spec, ImageProviderConfig) else resolve_image_provider(spec, profile=profile)
    except ValueError as exc:
        return ImageProviderHealth(
            provider="",
            configured=False,
            ready=False,
            detail=str(exc),
        )
    if cfg.kind is ImageProviderKind.NONE:
        return ImageProviderHealth(
            provider=cfg.name,
            configured=False,
            ready=False,
            detail="image generation is disabled",
        )
    binary_present = shutil.which(cfg.binary) is not None if cfg.binary else None
    credential_present = (
        bool(str(env.get(cfg.api_key_env, "")).strip()) if cfg.api_key_env else None
    )
    if cfg.kind is ImageProviderKind.GROK_CLI:
        auth = (Path.home() / ".grok" / "auth.json").exists() or bool(
            str(env.get("XAI_API_KEY", "")).strip()
        )
        ready = bool(binary_present and auth)
        return ImageProviderHealth(
            provider=cfg.name,
            configured=True,
            ready=ready,
            detail=(
                "Grok CLI delegation is configured"
                if ready
                else "Grok CLI binary or authentication is not available"
            ),
            binary_present=binary_present,
            credential_present=auth,
        )
    ready = bool(
        (binary_present if binary_present is not None else True)
        and (credential_present if credential_present is not None else True)
    )
    return ImageProviderHealth(
        provider=cfg.name,
        configured=True,
        ready=ready,
        detail="image provider is configured" if ready else "image provider dependency is missing",
        binary_present=binary_present,
        credential_present=credential_present,
    )


def build_image_request(
    prompt: str,
    output_path: str | Path,
    *,
    spec: str | ImageProviderConfig | None = None,
    profile: str | None = None,
) -> ImageRequest:
    """Build, but never execute, an image-generation request."""
    clean_prompt = str(prompt).strip()
    if not clean_prompt:
        raise ValueError("image prompt is required")
    raw_path = str(output_path).strip()
    if not raw_path:
        raise ValueError("output path is required")
    path = str(Path(raw_path).expanduser())
    cfg = spec if isinstance(spec, ImageProviderConfig) else resolve_image_provider(spec, profile=profile)
    if cfg.kind is ImageProviderKind.NONE:
        raise ProviderError(
            ProviderErrorCode.CONFIGURATION,
            "no image provider is configured",
            provider=cfg.name,
        )
    if cfg.kind in {ImageProviderKind.GROK_CLI, ImageProviderKind.EXTERNAL_COMMAND}:
        delegated_prompt = (
            "Generate the requested image using your configured image-generation "
            f"capability and save the final image to this exact path: {path}\n\n"
            f"Image prompt:\n{clean_prompt}\n\n"
            "Do not claim success unless the image file exists at that path."
        )
        base = cfg.command or ((cfg.binary,) if cfg.binary else ())
        if cfg.kind is ImageProviderKind.GROK_CLI:
            command = (
                *base,
                "--single",
                delegated_prompt,
                "--output-format",
                "json",
                "--permission-mode",
                "auto",
                "--max-turns",
                "3",
            )
            if cfg.model:
                command += ("--model", cfg.model)
        else:
            command = (*base, delegated_prompt, path)
        return ImageRequest(
            provider=cfg.name,
            model=cfg.model,
            prompt=clean_prompt,
            output_path=path,
            command=command,
            delegated=True,
        )
    endpoint = (cfg.base_url or "").rstrip("/") + "/images/generations"
    return ImageRequest(
        provider=cfg.name,
        model=cfg.model,
        prompt=clean_prompt,
        output_path=path,
        endpoint=endpoint,
        body={
            "model": cfg.model,
            "prompt": clean_prompt,
            "response_format": "b64_json",
        },
        delegated=False,
    )


_ANSI_CSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_ANSI_OSC_RE = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(authorization|api[_-]?key|access[_-]?token|token|secret|"
    r"password|passwd|cookie)\b(\s*[:=]\s*)(?:bearer\s+)?"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)
_PROVIDER_TOKEN_RE = re.compile(
    r"(?i)\b(?:sk|xai|gsk|hf|github_pat|ghp|glpat)-[a-z0-9._-]{8,}\b"
)
_SENSITIVE_ENV_RE = re.compile(
    r"(?i)(?:api[_-]?key|token|secret|password|passwd|authorization|credential|cookie)"
)


class _ImageExecutionFailure(RuntimeError):
    """Internal typed-control-flow exception; messages must be sanitized."""


def _text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _sanitize_text(
    value: str | bytes | None,
    *,
    environ: Mapping[str, str],
    limit: int,
) -> str:
    """Remove terminal controls and likely credentials, then bound the result."""
    text = _text(value)
    text = _ANSI_OSC_RE.sub("", text)
    text = _ANSI_CSI_RE.sub("", text)
    text = _CONTROL_RE.sub("", text)
    text = _SECRET_ASSIGNMENT_RE.sub(
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]",
        text,
    )
    text = _PROVIDER_TOKEN_RE.sub("[REDACTED]", text)
    for name, secret in environ.items():
        explicitly_added = str(name).startswith("SOPHIA_IMAGE_CREDENTIAL_")
        if (
            (explicitly_added or _SENSITIVE_ENV_RE.search(str(name)))
            and isinstance(secret, str)
            and secret
            and (explicitly_added or len(secret) >= 4)
        ):
            text = text.replace(secret, "[REDACTED]")
    bounded = max(0, int(limit))
    if len(text) <= bounded:
        return text
    if bounded == 0:
        return ""
    marker = f"… [{len(text) - bounded} characters omitted]"
    if len(marker) >= bounded:
        return marker[:bounded]
    return f"{text[:bounded - len(marker)]}{marker}"


def _execution_kind(request: ImageRequest) -> str:
    return "command" if request.command else "api"


def _result(
    request: ImageRequest,
    *,
    status: str,
    ok: bool,
    executed: bool,
    confirmed: bool,
    detail: str,
    environ: Mapping[str, str],
    output_limit: int,
    exit_code: int | None = None,
    timed_out: bool = False,
    stdout: str | bytes | None = None,
    stderr: str | bytes | None = None,
    bytes_written: int | None = None,
    downloaded_from_url: bool = False,
    atomic_write: bool = False,
) -> ImageExecutionResult:
    return ImageExecutionResult(
        provider=request.provider,
        output_path=request.output_path,
        status=status,
        ok=ok,
        executed=executed,
        confirmed=confirmed,
        execution_kind=_execution_kind(request),
        delegated=request.delegated,
        detail=_sanitize_text(detail, environ=environ, limit=output_limit),
        exit_code=exit_code,
        timed_out=timed_out,
        stdout=_sanitize_text(stdout, environ=environ, limit=output_limit),
        stderr=_sanitize_text(stderr, environ=environ, limit=output_limit),
        bytes_written=bytes_written,
        downloaded_from_url=downloaded_from_url,
        atomic_write=atomic_write,
    )


def _normalize_output_path(
    raw_path: str,
    *,
    allowed_root: str | Path | None,
    output_path_policy: Callable[[Path], bool] | None,
) -> Path:
    raw = str(raw_path).strip()
    if not raw:
        raise _ImageExecutionFailure("output path is required")
    candidate = Path(raw).expanduser()
    try:
        normalized = candidate.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise _ImageExecutionFailure(f"output path cannot be resolved: {exc}") from exc
    if allowed_root is not None:
        try:
            root = Path(allowed_root).expanduser().resolve(strict=False)
            normalized.relative_to(root)
        except (OSError, RuntimeError, ValueError) as exc:
            raise _ImageExecutionFailure(
                "output path is outside the allowed root"
            ) from exc
    if candidate.is_symlink():
        raise _ImageExecutionFailure("output path must not be a symbolic link")
    if output_path_policy is not None:
        try:
            allowed = output_path_policy(normalized)
        except Exception as exc:
            raise _ImageExecutionFailure(
                f"output path policy rejected the path: {exc}"
            ) from exc
        if allowed is not True:
            raise _ImageExecutionFailure("output path policy rejected the path")
    try:
        normalized.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise _ImageExecutionFailure(
            f"output parent directory could not be created: {exc}"
        ) from exc
    if allowed_root is not None:
        try:
            normalized.parent.resolve(strict=True).relative_to(root)
        except (OSError, RuntimeError, ValueError) as exc:
            raise _ImageExecutionFailure(
                "output parent directory escaped the allowed root"
            ) from exc
    return normalized


def _read_bounded(stream: Any, *, limit: int) -> bytes:
    maximum = max(1, int(limit))
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = stream.read(min(65_536, maximum + 1 - total))
        if not chunk:
            break
        if isinstance(chunk, str):
            chunk = chunk.encode("utf-8")
        chunks.append(chunk)
        total += len(chunk)
        if total > maximum:
            raise _ImageExecutionFailure(
                f"image provider response exceeded the {maximum}-byte limit"
            )
    return b"".join(chunks)


def _validated_http_url(value: str, *, label: str) -> str:
    raw = str(value).strip()
    if any(character in raw for character in ("\x00", "\r", "\n")):
        raise _ImageExecutionFailure(f"{label} must be an explicit HTTP(S) URL")
    parsed = urlsplit(raw)
    try:
        parsed.port
    except ValueError as exc:
        raise _ImageExecutionFailure(
            f"{label} must be an explicit HTTP(S) URL"
        ) from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise _ImageExecutionFailure(f"{label} must be an explicit HTTP(S) URL")
    return parsed.geturl()


def _is_public_ip_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return not (
        address.is_loopback
        or address.is_private
        or address.is_link_local
        or address.is_unspecified
        or address.is_multicast
        or address.is_reserved
        or getattr(address, "is_site_local", False)
        or not address.is_global
    )


@dataclass(frozen=True)
class _ResolvedPublicUrl:
    url: str
    scheme: str
    hostname: str
    port: int
    host_header: str
    addresses: tuple[str, ...]


def _resolved_public_http_url(value: str, *, label: str) -> _ResolvedPublicUrl:
    """Resolve once and retain only validated public addresses for connection."""
    url = _validated_http_url(value, label=label)
    parsed = urlsplit(url)
    hostname = parsed.hostname or ""
    if "%" in hostname:
        raise _ImageExecutionFailure(f"{label} resolved to a non-public address")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    try:
        addresses.append(ipaddress.ip_address(hostname))
    except ValueError:
        try:
            hostname = hostname.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise _ImageExecutionFailure(
                f"{label} hostname could not be resolved"
            ) from exc
        try:
            resolved = socket.getaddrinfo(
                hostname,
                port,
                0,
                socket.SOCK_STREAM,
            )
        except (socket.gaierror, OSError) as exc:
            raise _ImageExecutionFailure(
                f"{label} hostname could not be resolved"
            ) from exc
        for entry in resolved:
            try:
                addresses.append(ipaddress.ip_address(entry[4][0].split("%", 1)[0]))
            except (IndexError, TypeError, ValueError):
                raise _ImageExecutionFailure(
                    f"{label} hostname resolution returned an invalid address"
                )
    if not addresses:
        raise _ImageExecutionFailure(f"{label} hostname resolved to no addresses")
    if any(not _is_public_ip_address(address) for address in addresses):
        raise _ImageExecutionFailure(f"{label} resolved to a non-public address")
    pinned_addresses: list[str] = []
    for address in addresses:
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        normalized = str(address)
        if normalized not in pinned_addresses:
            pinned_addresses.append(normalized)
    default_port = 443 if parsed.scheme == "https" else 80
    host_header = f"[{hostname}]" if ":" in hostname else hostname
    if port != default_port:
        host_header = f"{host_header}:{port}"
    return _ResolvedPublicUrl(
        url=url,
        scheme=parsed.scheme,
        hostname=hostname,
        port=port,
        host_header=host_header,
        addresses=tuple(pinned_addresses),
    )


def _validated_public_http_url(value: str, *, label: str) -> str:
    """Compatibility wrapper for callers that only need the validated URL."""
    return _resolved_public_http_url(value, label=label).url


def _connect_pinned_socket(
    pinned_ip: str,
    port: int,
    *,
    timeout: float,
    source_address: tuple[str, int] | None = None,
) -> socket.socket:
    """Connect directly to a numeric IP without a second hostname resolution."""
    address = ipaddress.ip_address(pinned_ip)
    family = (
        socket.AF_INET6
        if isinstance(address, ipaddress.IPv6Address)
        else socket.AF_INET
    )
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        if source_address:
            sock.bind(source_address)
        destination: tuple[Any, ...]
        if family == socket.AF_INET6:
            destination = (str(address), port, 0, 0)
        else:
            destination = (str(address), port)
        sock.connect(destination)
        return sock
    except Exception:
        sock.close()
        raise


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(
        self,
        host: str,
        port: int,
        *,
        pinned_ip: str,
        timeout: float,
    ) -> None:
        super().__init__(host, port=port, timeout=timeout)
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        if self._tunnel_host:
            raise OSError("pinned image transport does not support HTTP tunnels")
        self.sock = _connect_pinned_socket(
            self._pinned_ip,
            self.port,
            timeout=self.timeout,
            source_address=self.source_address,
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        host: str,
        port: int,
        *,
        pinned_ip: str,
        timeout: float,
    ) -> None:
        super().__init__(host, port=port, timeout=timeout)
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        if self._tunnel_host:
            raise OSError("pinned image transport does not support HTTPS tunnels")
        raw_socket = _connect_pinned_socket(
            self._pinned_ip,
            self.port,
            timeout=self.timeout,
            source_address=self.source_address,
        )
        try:
            self.sock = self._context.wrap_socket(
                raw_socket,
                server_hostname=self.host,
            )
        except Exception:
            raw_socket.close()
            raise


class _PinnedResponse:
    def __init__(
        self,
        connection: http.client.HTTPConnection,
        response: http.client.HTTPResponse,
        *,
        url: str,
    ) -> None:
        self._connection = connection
        self._response = response
        self.status = response.status
        self.headers = response.headers
        self._url = url

    def read(self, size: int = -1) -> bytes:
        return self._response.read(size)

    def getheader(self, name: str) -> str | None:
        return self._response.getheader(name)

    def geturl(self) -> str:
        return self._url

    def close(self) -> None:
        try:
            self._response.close()
        finally:
            self._connection.close()

    def __enter__(self) -> "_PinnedResponse":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def _open_pinned_url(
    resolved: _ResolvedPublicUrl,
    *,
    timeout: float,
) -> _PinnedResponse:
    """Open one URL using only its already-validated numeric addresses."""
    parsed = urlsplit(resolved.url)
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    last_error: BaseException | None = None
    for pinned_ip in resolved.addresses:
        connection: http.client.HTTPConnection
        if resolved.scheme == "https":
            connection = _PinnedHTTPSConnection(
                resolved.hostname,
                resolved.port,
                pinned_ip=pinned_ip,
                timeout=timeout,
            )
        else:
            connection = _PinnedHTTPConnection(
                resolved.hostname,
                resolved.port,
                pinned_ip=pinned_ip,
                timeout=timeout,
            )
        try:
            connection.request(
                "GET",
                target,
                headers={
                    "Accept": "image/*",
                    "Connection": "close",
                    "Host": resolved.host_header,
                },
            )
            response = connection.getresponse()
            return _PinnedResponse(connection, response, url=resolved.url)
        except (OSError, http.client.HTTPException, UnicodeError, ValueError) as exc:
            last_error = exc
            connection.close()
    raise _ImageExecutionFailure(
        "image download failed to connect to a validated public address"
    ) from last_error


def _response_header(response: Any, name: str) -> str:
    headers = getattr(response, "headers", None)
    if headers is not None and hasattr(headers, "get"):
        value = headers.get(name)
        return str(value).strip() if value is not None else ""
    getter = getattr(response, "getheader", None)
    if callable(getter):
        value = getter(name)
        return str(value).strip() if value is not None else ""
    return ""


def _validate_image_magic(image: bytes) -> None:
    common_magic = (
        image.startswith(b"\x89PNG\r\n\x1a\n"),
        image.startswith(b"\xff\xd8\xff"),
        image.startswith((b"GIF87a", b"GIF89a")),
        len(image) >= 12
        and image.startswith(b"RIFF")
        and image[8:12] == b"WEBP",
        image.startswith(b"BM"),
        image.startswith((b"II*\x00", b"MM\x00*")),
        image.startswith((b"\x00\x00\x01\x00", b"\x00\x00\x02\x00")),
        len(image) >= 12
        and image[4:8] == b"ftyp"
        and image[8:12]
        in {
            b"avif",
            b"avis",
            b"heic",
            b"heix",
            b"hevc",
            b"hevx",
            b"mif1",
            b"msf1",
        },
    )
    if not any(common_magic):
        raise _ImageExecutionFailure(
            "image payload did not match a supported image file signature"
        )


def _download_public_image(
    url: str,
    *,
    timeout: float,
    limit: int,
) -> bytes:
    current = _resolved_public_http_url(url, label="returned image URL")
    for redirect_count in range(6):
        try:
            response = _open_pinned_url(current, timeout=timeout)
        except _ImageExecutionFailure:
            raise
        except (urllib_error.URLError, TimeoutError, OSError) as exc:
            raise _ImageExecutionFailure(f"image download failed: {exc}") from exc

        with response:
            status = int(
                getattr(response, "status", getattr(response, "code", 200)) or 200
            )
            if 300 <= status < 400:
                location = _response_header(response, "Location")
                if not location:
                    raise _ImageExecutionFailure(
                        "image download redirect had no Location header"
                    )
                if redirect_count >= 5:
                    raise _ImageExecutionFailure(
                        "image download exceeded the redirect limit"
                    )
                current = _resolved_public_http_url(
                    urljoin(current.url, location),
                    label="redirected image URL",
                )
                continue
            if status < 200 or status >= 300:
                detail = _read_bounded(response, limit=min(limit, 65_536)).decode(
                    "utf-8",
                    errors="replace",
                )
                raise _ImageExecutionFailure(
                    f"image download returned HTTP {status}: {detail}"
                )
            content_type = _response_header(response, "Content-Type").partition(";")[0]
            if not content_type.strip().lower().startswith("image/"):
                raise _ImageExecutionFailure(
                    "image download response did not have an image Content-Type"
                )
            image = _read_bounded(response, limit=limit)
        if not image:
            raise _ImageExecutionFailure("image provider returned an empty image")
        _validate_image_magic(image)
        return image
    raise _ImageExecutionFailure("image download exceeded the redirect limit")


def _open_bounded(
    request: urllib_request.Request,
    *,
    timeout: float,
    limit: int,
    urlopen: Callable[..., Any],
) -> bytes:
    try:
        with urlopen(request, timeout=timeout) as response:
            body = _read_bounded(response, limit=limit)
            status = int(getattr(response, "status", 200) or 200)
            if status < 200 or status >= 300:
                raise _ImageExecutionFailure(
                    f"image provider returned HTTP {status}: "
                    f"{body.decode('utf-8', errors='replace')}"
                )
            return body
    except _ImageExecutionFailure:
        raise
    except urllib_error.HTTPError as exc:
        try:
            body = _read_bounded(exc, limit=min(limit, 65_536))
        except Exception:
            body = b""
        detail = body.decode("utf-8", errors="replace")
        raise _ImageExecutionFailure(
            f"image provider returned HTTP {exc.code}: {detail}"
        ) from exc
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        raise _ImageExecutionFailure(f"image provider request failed: {exc}") from exc


def _extract_api_image(
    response_body: bytes,
    *,
    timeout: float,
    max_image_bytes: int,
) -> tuple[bytes, bool]:
    try:
        payload = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _ImageExecutionFailure(
            "image provider returned malformed JSON"
        ) from exc
    if not isinstance(payload, dict):
        raise _ImageExecutionFailure("image provider response must be a JSON object")
    data = payload.get("data")
    item = data[0] if isinstance(data, list) and data else payload
    if not isinstance(item, dict):
        raise _ImageExecutionFailure("image provider response has no image result")
    encoded = item.get("b64_json")
    if isinstance(encoded, str) and encoded.strip():
        try:
            image = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise _ImageExecutionFailure(
                "image provider returned invalid base64 image data"
            ) from exc
        if not image:
            raise _ImageExecutionFailure("image provider returned an empty image")
        if len(image) > max_image_bytes:
            raise _ImageExecutionFailure(
                f"decoded image exceeded the {max_image_bytes}-byte limit"
            )
        _validate_image_magic(image)
        return image, False
    returned_url = item.get("url")
    if isinstance(returned_url, str) and returned_url.strip():
        image = _download_public_image(
            returned_url,
            timeout=timeout,
            limit=max_image_bytes,
        )
        return image, True
    raise _ImageExecutionFailure(
        "image provider response contains neither b64_json nor a returned URL"
    )


def _atomic_write(path: Path, data: bytes) -> None:
    descriptor = -1
    temporary = ""
    try:
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=str(path.parent),
        )
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = ""
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                # A completed replace or concurrent cleanup may already have
                # removed the temporary sibling.
                pass


def _credential_env_name(request: ImageRequest) -> str | None:
    try:
        return resolve_image_provider(request.provider).api_key_env
    except ValueError:
        return None


_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_DELEGATED_ENV_ALLOWLIST = (
    "PATH",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
)
_DANGEROUS_DELEGATED_ENV_NAMES = {
    "BASH_ENV",
    "ENV",
    "NODE_OPTIONS",
    "PERL5OPT",
    "PYTHONHOME",
    "PYTHONPATH",
    "RUBYOPT",
}


def _delegated_env_name_allowed(name: str) -> bool:
    upper = name.upper()
    return bool(
        _ENV_NAME_RE.fullmatch(name)
        and upper not in _DANGEROUS_DELEGATED_ENV_NAMES
        and not upper.startswith(("LD_", "DYLD_"))
    )


def _delegated_credential_env_names(
    request: ImageRequest,
    *,
    api_key_env: str | None,
) -> tuple[tuple[str, bool], ...]:
    configured_name = (
        api_key_env if api_key_env is not None else _credential_env_name(request)
    )
    credential_names: list[tuple[str, bool]] = []
    if configured_name:
        credential_names.append((str(configured_name), True))
    if request.provider in {"grok", "grok-cli"} and not any(
        name == "XAI_API_KEY" for name, _required in credential_names
    ):
        credential_names.append(("XAI_API_KEY", False))
    return tuple(credential_names)


def _delegated_command_env(
    request: ImageRequest,
    *,
    environ: Mapping[str, str],
    api_key_env: str | None,
    permission: str,
    temporary_output: Path,
) -> dict[str, str]:
    """Build an explicit least-privilege environment for a delegated process."""
    child_env: dict[str, str] = {}
    allowed_names = list(_DELEGATED_ENV_ALLOWLIST)
    if request.provider in {"grok", "grok-cli"}:
        allowed_names.append("HOME")
    for name in allowed_names:
        value = environ.get(name)
        if value is None or str(value) == "":
            continue
        text = str(value)
        if "\x00" in text:
            raise _ImageExecutionFailure(
                f"delegated command environment variable {name} is invalid"
            )
        child_env[name] = text
    child_env.setdefault("PATH", os.defpath)
    child_env["TMPDIR"] = str(temporary_output.parent)
    child_env["SOPHIA_IMAGE_OUTPUT_PATH"] = str(temporary_output)
    child_env["SOPHIA_IMAGE_PERMISSION"] = permission

    for name, required in _delegated_credential_env_names(
        request,
        api_key_env=api_key_env,
    ):
        if not _delegated_env_name_allowed(name):
            raise _ImageExecutionFailure(
                "delegated command credential environment variable is not allowed"
            )
        value = str(environ.get(name, "")).strip()
        if required and not value:
            raise _ImageExecutionFailure(
                f"required credential environment variable {name} is not set"
            )
        if value:
            if "\x00" in value:
                raise _ImageExecutionFailure(
                    f"delegated command environment variable {name} is invalid"
                )
            child_env[name] = value
    return child_env


def _delegated_command_argv(
    request: ImageRequest,
    *,
    output: Path,
    temporary_output: Path,
) -> list[str]:
    """Retarget a delegated command to a unique file for atomic promotion."""
    aliases = {
        str(request.output_path),
        str(Path(request.output_path).expanduser()),
        str(output),
    }
    aliases.discard("")
    ordered_aliases = sorted(aliases, key=len, reverse=True)
    argv: list[str] = []
    output_referenced = False
    for part in request.command:
        rewritten = part
        for alias in ordered_aliases:
            if alias in rewritten:
                rewritten = rewritten.replace(alias, str(temporary_output))
                output_referenced = True
        argv.append(rewritten)
    if not output_referenced:
        raise _ImageExecutionFailure(
            "delegated command must explicitly reference the requested output path"
        )
    if request.provider in {"grok", "grok-cli"}:
        if "--permission-mode" not in argv:
            raise _ImageExecutionFailure(
                "delegated Grok command requires an explicit permission mode"
            )
        permission_index = argv.index("--permission-mode")
        if permission_index + 1 >= len(argv):
            raise _ImageExecutionFailure(
                "delegated Grok command has no permission-mode value"
            )
        if "--cwd" in argv:
            cwd_index = argv.index("--cwd")
            if cwd_index + 1 >= len(argv):
                raise _ImageExecutionFailure(
                    "delegated Grok command has no cwd value"
                )
            argv[cwd_index + 1] = str(output.parent)
        else:
            argv.extend(("--cwd", str(output.parent)))
    return argv


def _add_redaction_value(
    redaction_env: dict[str, str],
    value: Any,
    *,
    force: bool = False,
) -> None:
    if isinstance(value, (str, int, float)):
        text = str(value)
        if text and (force or len(text) >= 4):
            redaction_env[
                f"SOPHIA_IMAGE_CREDENTIAL_{len(redaction_env)}_SECRET"
            ] = text


def _collect_body_credentials(
    value: Any,
    redaction_env: dict[str, str],
    *,
    sensitive: bool = False,
    depth: int = 0,
) -> None:
    if depth > 8 or len(redaction_env) > 128:
        return
    if isinstance(value, Mapping):
        for key, child in value.items():
            child_sensitive = sensitive or bool(_SENSITIVE_ENV_RE.search(str(key)))
            _collect_body_credentials(
                child,
                redaction_env,
                sensitive=child_sensitive,
                depth=depth + 1,
            )
        return
    if isinstance(value, (list, tuple)):
        for child in value[:64]:
            _collect_body_credentials(
                child,
                redaction_env,
                sensitive=sensitive,
                depth=depth + 1,
            )
        return
    if sensitive:
        _add_redaction_value(redaction_env, value)


def execute_image_request(
    request: ImageRequest,
    *,
    confirm: bool,
    permission: str,
    timeout: float = 120.0,
    max_output_chars: int = 8_000,
    max_image_bytes: int = 32 * 1024 * 1024,
    allowed_root: str | Path | None = None,
    output_path_policy: Callable[[Path], bool] | None = None,
    api_key_env: str | None = None,
    request_headers: Mapping[str, str] | None = None,
    environ: Mapping[str, str] | None = None,
    run: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
    urlopen: Callable[..., Any] = urllib_request.urlopen,
) -> ImageExecutionResult:
    """Execute an already-built image request only after explicit confirmation.

    Discovery and health checks never call this function. CLI providers remain
    delegated external commands; this function does not imply that Grok CLI or
    any other CLI has a native image subcommand. ``permission`` is required and
    must be ``auto``, ``approve``, or ``readonly``; readonly mode never starts a
    delegated command. An injected ``urlopen`` is used only for the provider API
    request; provider-returned image URLs always use the pinned numeric-IP
    transport.
    """
    env = os.environ if environ is None else environ
    output_limit = max(0, int(max_output_chars))
    normalized_permission = str(permission).strip().lower()
    if normalized_permission not in IMAGE_EXECUTION_PERMISSIONS:
        return _result(
            request,
            status="rejected",
            ok=False,
            executed=False,
            confirmed=confirm is True,
            detail=(
                "execution permission must be one of: "
                f"{', '.join(IMAGE_EXECUTION_PERMISSIONS)}"
            ),
            environ=env,
            output_limit=output_limit,
        )
    if confirm is not True:
        return _result(
            request,
            status="confirmation-required",
            ok=False,
            executed=False,
            confirmed=False,
            detail=_confirmation_text(delegated=request.delegated),
            environ=env,
            output_limit=output_limit,
        )
    if request.command and normalized_permission == "readonly":
        return _result(
            request,
            status="rejected",
            ok=False,
            executed=False,
            confirmed=True,
            detail=(
                "readonly permission forbids delegated command execution. "
                f"{DELEGATED_AUTHORITY_DISCLOSURE}"
            ),
            environ=env,
            output_limit=output_limit,
        )
    if timeout <= 0 or timeout > 300:
        return _result(
            request,
            status="rejected",
            ok=False,
            executed=False,
            confirmed=True,
            detail="execution timeout must be greater than 0 and at most 300 seconds",
            environ=env,
            output_limit=output_limit,
        )
    if max_image_bytes <= 0:
        return _result(
            request,
            status="rejected",
            ok=False,
            executed=False,
            confirmed=True,
            detail="maximum image size must be greater than zero",
            environ=env,
            output_limit=output_limit,
        )
    try:
        output = _normalize_output_path(
            request.output_path,
            allowed_root=allowed_root,
            output_path_policy=output_path_policy,
        )
    except _ImageExecutionFailure as exc:
        return _result(
            request,
            status="rejected",
            ok=False,
            executed=False,
            confirmed=True,
            detail=str(exc),
            environ=env,
            output_limit=output_limit,
        )

    if request.command:
        redaction_env = dict(env)
        if any(
            not isinstance(part, str) or not part or "\x00" in part
            for part in request.command
        ):
            return _result(
                request,
                status="rejected",
                ok=False,
                executed=False,
                confirmed=True,
                detail="delegated command must be a non-empty argument vector",
                environ=env,
                output_limit=output_limit,
            )
        temporary_root: Path | None = None
        try:
            temporary_root = Path(
                tempfile.mkdtemp(
                    prefix=f".{output.name}.delegated-",
                    dir=str(output.parent),
                )
            )
            temporary_output = temporary_root / output.name
            command = _delegated_command_argv(
                request,
                output=output,
                temporary_output=temporary_output,
            )
            command_env = _delegated_command_env(
                request,
                environ=env,
                api_key_env=api_key_env,
                permission=normalized_permission,
                temporary_output=temporary_output,
            )
            for credential_name, _required in _delegated_credential_env_names(
                request,
                api_key_env=api_key_env,
            ):
                if credential_name in command_env:
                    _add_redaction_value(
                        redaction_env,
                        command_env[credential_name],
                        force=True,
                    )
        except (_ImageExecutionFailure, OSError) as exc:
            if temporary_root is not None:
                shutil.rmtree(temporary_root, ignore_errors=True)
            return _result(
                request,
                status="rejected",
                ok=False,
                executed=False,
                confirmed=True,
                detail=str(exc),
                environ=env,
                output_limit=output_limit,
            )
        try:
            completed = run(
                command,
                shell=False,
                check=False,
                capture_output=True,
                text=False,
                timeout=timeout,
                env=command_env,
                cwd=str(output.parent),
            )
        except subprocess.TimeoutExpired as exc:
            shutil.rmtree(temporary_root, ignore_errors=True)
            return _result(
                request,
                status="timed-out",
                ok=False,
                executed=True,
                confirmed=True,
                detail="delegated image command timed out",
                environ=redaction_env,
                output_limit=output_limit,
                timed_out=True,
                stdout=exc.stdout,
                stderr=exc.stderr,
            )
        except (OSError, ValueError) as exc:
            shutil.rmtree(temporary_root, ignore_errors=True)
            return _result(
                request,
                status="failed",
                ok=False,
                executed=True,
                confirmed=True,
                detail=f"delegated image command could not run: {exc}",
                environ=redaction_env,
                output_limit=output_limit,
            )
        if completed.returncode != 0:
            shutil.rmtree(temporary_root, ignore_errors=True)
            return _result(
                request,
                status="failed",
                ok=False,
                executed=True,
                confirmed=True,
                detail=f"delegated image command exited with status {completed.returncode}",
                environ=redaction_env,
                output_limit=output_limit,
                exit_code=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
            )
        try:
            symbolic_link_output = temporary_output.is_symlink()
            size = (
                temporary_output.stat().st_size
                if not symbolic_link_output and temporary_output.is_file()
                else 0
            )
        except OSError:
            symbolic_link_output = False
            size = 0
        if symbolic_link_output:
            shutil.rmtree(temporary_root, ignore_errors=True)
            return _result(
                request,
                status="failed",
                ok=False,
                executed=True,
                confirmed=True,
                detail="delegated image command created a symbolic-link output",
                environ=redaction_env,
                output_limit=output_limit,
                exit_code=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
            )
        if size <= 0:
            shutil.rmtree(temporary_root, ignore_errors=True)
            return _result(
                request,
                status="failed",
                ok=False,
                executed=True,
                confirmed=True,
                detail=(
                    "delegated image command reported success but did not create "
                    "a new non-empty output file"
                ),
                environ=redaction_env,
                output_limit=output_limit,
                exit_code=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
            )
        if size > max_image_bytes:
            shutil.rmtree(temporary_root, ignore_errors=True)
            return _result(
                request,
                status="failed",
                ok=False,
                executed=True,
                confirmed=True,
                detail=(
                    "delegated image command output exceeded the "
                    f"{max_image_bytes}-byte limit"
                ),
                environ=redaction_env,
                output_limit=output_limit,
                exit_code=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
            )
        try:
            os.replace(temporary_output, output)
        except OSError as exc:
            return _result(
                request,
                status="failed",
                ok=False,
                executed=True,
                confirmed=True,
                detail=f"delegated image output could not be promoted atomically: {exc}",
                environ=redaction_env,
                output_limit=output_limit,
                exit_code=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
            )
        finally:
            if temporary_root is not None:
                shutil.rmtree(temporary_root, ignore_errors=True)
        return _result(
            request,
            status="succeeded",
            ok=True,
            executed=True,
            confirmed=True,
            detail="delegated image command created the requested output file",
            environ=redaction_env,
            output_limit=output_limit,
            exit_code=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            bytes_written=size,
            atomic_write=True,
        )

    if not request.endpoint or request.body is None:
        return _result(
            request,
            status="rejected",
            ok=False,
            executed=False,
            confirmed=True,
            detail="API image execution requires an explicit endpoint and request body",
            environ=env,
            output_limit=output_limit,
        )
    try:
        endpoint = _validated_http_url(request.endpoint, label="image endpoint")
        body = json.dumps(request.body, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, _ImageExecutionFailure) as exc:
        return _result(
            request,
            status="rejected",
            ok=False,
            executed=False,
            confirmed=True,
            detail=f"invalid API image request: {exc}",
            environ=env,
            output_limit=output_limit,
        )
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    redaction_env = dict(env)
    _collect_body_credentials(request.body, redaction_env)
    if request_headers:
        for name, value in request_headers.items():
            if (
                not isinstance(name, str)
                or not name.strip()
                or "\r" in name
                or "\n" in name
                or not isinstance(value, str)
                or "\r" in value
                or "\n" in value
            ):
                return _result(
                    request,
                    status="rejected",
                    ok=False,
                    executed=False,
                    confirmed=True,
                    detail="API request headers must be non-empty single-line strings",
                    environ=env,
                    output_limit=output_limit,
                )
            headers[name] = value
            _add_redaction_value(redaction_env, value)
    credential_name = api_key_env if api_key_env is not None else _credential_env_name(request)
    if credential_name:
        credential = str(env.get(credential_name, "")).strip()
        if not credential:
            return _result(
                request,
                status="rejected",
                ok=False,
                executed=False,
                confirmed=True,
                detail=f"required credential environment variable {credential_name} is not set",
                environ=env,
                output_limit=output_limit,
            )
        headers.setdefault("Authorization", f"Bearer {credential}")
        _add_redaction_value(redaction_env, credential)
    api_request = urllib_request.Request(
        endpoint,
        data=body,
        headers=headers,
        method="POST",
    )
    response_limit = max(1_048_576, ((max_image_bytes + 2) // 3) * 4 + 65_536)
    try:
        response_body = _open_bounded(
            api_request,
            timeout=timeout,
            limit=response_limit,
            urlopen=urlopen,
        )
        image, downloaded_from_url = _extract_api_image(
            response_body,
            timeout=timeout,
            max_image_bytes=max_image_bytes,
        )
        _atomic_write(output, image)
    except (_ImageExecutionFailure, OSError) as exc:
        return _result(
            request,
            status="failed",
            ok=False,
            executed=True,
            confirmed=True,
            detail=str(exc),
            environ=redaction_env,
            output_limit=output_limit,
        )
    return _result(
        request,
        status="succeeded",
        ok=True,
        executed=True,
        confirmed=True,
        detail="image provider response was written to the requested output file",
        environ=redaction_env,
        output_limit=output_limit,
        bytes_written=len(image),
        downloaded_from_url=downloaded_from_url,
        atomic_write=True,
    )


def image_provider_manifest(
    spec: str | ImageProviderConfig | None = None,
    *,
    profile: str | None = None,
) -> dict[str, Any]:
    cfg = spec if isinstance(spec, ImageProviderConfig) else resolve_image_provider(spec, profile=profile)
    return {
        "schema": "sophia.image-provider.v1",
        **cfg.to_dict(),
        "health": image_provider_health(cfg, profile=profile).to_dict(),
        "confirmationText": _confirmation_text(delegated=cfg.delegated),
        "paidProbeMade": False,
        "candidateOnly": True,
        "canClaimAGI": False,
    }
