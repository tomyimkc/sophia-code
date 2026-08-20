# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""No-spend provider health checks.

The probes in this module inspect configuration, credential *presence*,
installed binaries, loopback metadata endpoints, and advertised model IDs.
They never send a chat/completions or image-generation request. Remote metadata
requests are opt-in; the default automatic path contacts loopback only.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from agent.model import (
    ModelConfig,
    ProviderError,
    classify_provider_error,
    provider_capabilities,
    resolve_config,
)


class HealthState(str, Enum):
    READY = "ready"
    CONFIGURED = "configured"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"
    UNCONFIGURED = "unconfigured"
    UNKNOWN = "unknown"
    SKIPPED = "skipped"


@dataclass(frozen=True)
class HealthCheck:
    name: str
    state: HealthState
    detail: str
    required: bool = True
    no_spend: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.state in {HealthState.READY, HealthState.CONFIGURED, HealthState.SKIPPED}

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "state": self.state.value,
            "ok": self.ok,
            "detail": self.detail,
            "required": self.required,
            "noSpend": self.no_spend,
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True)
class ProviderHealth:
    provider: str
    model: str
    state: HealthState
    checks: tuple[HealthCheck, ...]
    error: ProviderError | None = None
    capabilities: dict[str, Any] | None = None
    paid_probe_made: bool = False

    @property
    def ok(self) -> bool:
        return self.state in {HealthState.READY, HealthState.CONFIGURED}

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "sophia.provider-health.v1",
            "provider": self.provider,
            "model": self.model,
            "state": self.state.value,
            "ok": self.ok,
            "checks": [check.to_dict() for check in self.checks],
            "error": self.error.to_dict() if self.error else None,
            "paidProbeMade": self.paid_probe_made,
            "capabilities": dict(self.capabilities) if self.capabilities else None,
            "candidateOnly": True,
            "canClaimAGI": False,
        }


_CLI_BINARIES: dict[str, str] = {
    "grok": "grok",
    "codex": "codex",
    "openclaw": "openclaw",
    "mlx": "python3",
    "pi-ai": "node",
}
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1"})
_CODEX_LOGIN_TIMEOUT_MAX_SEC = 5.0


def _cli_binary(cfg: ModelConfig, environ: Mapping[str, str]) -> str | None:
    binary = _CLI_BINARIES.get(cfg.kind)
    if cfg.kind == "codex":
        override = str(environ.get("SOPHIA_CODEX_BIN", "")).strip()
        if override:
            return override
    return binary


def _credential_present(cfg: ModelConfig, environ: Mapping[str, str]) -> bool:
    if cfg.api_key_default:
        return True
    if cfg.api_key_env and str(environ.get(cfg.api_key_env, "")).strip():
        return True
    if cfg.kind == "anthropic":
        return bool(
            str(environ.get("ANTHROPIC_API_KEY", "")).strip()
            or str(environ.get("ANTHROPIC_AUTH_TOKEN", "")).strip()
        )
    return cfg.kind in {"mock", "grok", "codex", "openclaw", "mlx", "pi-ai"}


def _credential_check(cfg: ModelConfig, environ: Mapping[str, str]) -> HealthCheck:
    if cfg.kind in {"mock", "mlx", "pi-ai"} and not cfg.api_key_env:
        return HealthCheck("credentials", HealthState.SKIPPED, "provider does not require an API key")
    if cfg.kind == "grok":
        auth_file = Path.home() / ".grok" / "auth.json"
        present = auth_file.exists() or bool(str(environ.get("XAI_API_KEY", "")).strip())
        return HealthCheck(
            "credentials",
            HealthState.CONFIGURED if present else HealthState.UNCONFIGURED,
            "Grok authentication detected" if present else "Grok authentication not detected",
        )
    if cfg.kind == "codex":
        binary = _cli_binary(cfg, environ) or "codex"
        return HealthCheck(
            "credentials",
            HealthState.SKIPPED,
            "Codex authentication is verified by bounded `codex login status`",
            required=False,
            metadata={"statusCommand": [binary, "login", "status"], "generationRequest": False},
        )
    if cfg.kind == "openclaw" and not cfg.api_key_env:
        return HealthCheck(
            "credentials",
            HealthState.UNKNOWN,
            "OpenClaw owns provider credentials; not inspected",
            required=False,
        )
    present = _credential_present(cfg, environ)
    source = cfg.api_key_env or (
        "ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN" if cfg.kind == "anthropic" else "provider config"
    )
    return HealthCheck(
        "credentials",
        HealthState.CONFIGURED if present else HealthState.UNCONFIGURED,
        f"{source} is configured" if present else f"{source} is not configured",
        metadata={"source": source, "valueExposed": False},
    )


def _binary_check(
    cfg: ModelConfig,
    *,
    environ: Mapping[str, str],
    which: Callable[[str], str | None],
) -> HealthCheck | None:
    binary = _cli_binary(cfg, environ)
    if not binary:
        return None
    path = which(binary)
    return HealthCheck(
        "binary",
        HealthState.READY if path else HealthState.UNAVAILABLE,
        f"{binary} is available on PATH" if path else f"{binary} is not available on PATH",
        metadata={"binary": binary, "pathExposed": False},
    )


def probe_codex_login_status(
    *,
    timeout: float = 1.5,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    binary: str = "codex",
) -> tuple[HealthCheck, ProviderError | None]:
    """Classify Codex auth mode using the CLI's metadata-only status command."""
    bounded_timeout = min(max(float(timeout), 0.1), _CODEX_LOGIN_TIMEOUT_MAX_SEC)
    try:
        proc = run(
            [binary, "login", "status"],
            text=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=bounded_timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        message = "codex login status timed out"
        error = classify_provider_error(message, provider="codex")
        return HealthCheck(
            "authentication",
            HealthState.UNAVAILABLE,
            message,
            metadata={"authMode": "unknown", "generationRequest": False},
        ), error
    except OSError:
        message = "codex login status could not run"
        error = classify_provider_error(message, provider="codex")
        return HealthCheck(
            "authentication",
            HealthState.UNAVAILABLE,
            message,
            metadata={"authMode": "unknown", "generationRequest": False},
        ), error

    output = f"{proc.stdout or ''}\n{proc.stderr or ''}".casefold()
    metadata = {
        "command": [binary, "login", "status"],
        "generationRequest": False,
    }
    if "logged in using chatgpt" in output:
        return HealthCheck(
            "authentication",
            HealthState.READY,
            "Codex is logged in with ChatGPT subscription authentication",
            metadata={**metadata, "authMode": "chatgpt"},
        ), None
    if any(marker in output for marker in (
        "logged in using an api key",
        "logged in using access token",
        "logged in using personal access token",
        "logged in using amazon bedrock api key",
    )):
        return HealthCheck(
            "authentication",
            HealthState.DEGRADED,
            "Codex is usable with API-key/token authentication, not ChatGPT subscription authentication",
            metadata={**metadata, "authMode": "api-key"},
        ), None
    if proc.returncode != 0 or any(marker in output for marker in (
        "not logged in",
        "logged out",
        "login required",
    )):
        return HealthCheck(
            "authentication",
            HealthState.UNCONFIGURED,
            "Codex is logged out; run `codex login` for ChatGPT subscription access",
            metadata={**metadata, "authMode": "logged-out"},
        ), None

    message = "codex login status returned an unrecognized authentication state"
    error = classify_provider_error(message, provider="codex")
    return HealthCheck(
        "authentication",
        HealthState.DEGRADED,
        message,
        metadata={**metadata, "authMode": "unknown"},
    ), error


def _models_url(cfg: ModelConfig) -> str | None:
    if cfg.kind != "openai" or not cfg.base_url:
        return None
    return cfg.base_url.rstrip("/") + "/models"


def _read_models_payload(raw: Any) -> list[str]:
    data = raw.get("data") if isinstance(raw, dict) else raw
    if not isinstance(data, list):
        return []
    models: list[str] = []
    for item in data:
        if isinstance(item, dict) and item.get("id"):
            models.append(str(item["id"]))
        elif isinstance(item, str):
            models.append(item)
    return models


def _safe_http_error(exc: BaseException, cfg: ModelConfig) -> ProviderError:
    status = exc.code if isinstance(exc, urllib.error.HTTPError) else None
    # Do not read arbitrary error bodies here: gateways sometimes echo request
    # headers. Exception text + status is sufficient for a health report.
    return classify_provider_error(
        f"{type(exc).__name__}: {exc}",
        provider=cfg.label or cfg.kind,
        model=cfg.model,
        http_status=status,
    )


def _probe_models_endpoint(
    cfg: ModelConfig,
    *,
    timeout: float,
    urlopen: Callable[..., Any],
    environ: Mapping[str, str],
) -> tuple[HealthCheck, HealthCheck | None, ProviderError | None]:
    url = _models_url(cfg)
    if not url:
        return (
            HealthCheck(
                "endpoint",
                HealthState.SKIPPED,
                "transport has no standard no-spend models endpoint",
                required=False,
            ),
            None,
            None,
        )
    headers = {"Accept": "application/json"}
    key = (
        str(environ.get(cfg.api_key_env, "")).strip()
        if cfg.api_key_env
        else ""
    ) or (cfg.api_key_default or "")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError) as exc:
        error = _safe_http_error(exc, cfg)
        return (
            HealthCheck(
                "endpoint",
                HealthState.UNAVAILABLE,
                error.message,
                metadata={"url": url, "method": "GET", "generationRequest": False},
            ),
            None,
            error,
        )
    models = _read_models_payload(payload)
    endpoint = HealthCheck(
        "endpoint",
        HealthState.READY,
        "metadata endpoint responded",
        metadata={"url": url, "method": "GET", "generationRequest": False},
    )
    if not models:
        return (
            endpoint,
            HealthCheck("model", HealthState.UNKNOWN, "endpoint returned no advertised model IDs"),
            None,
        )
    wanted = cfg.model.casefold()
    exact = any(model.casefold() == wanted for model in models)
    # Aliases such as ``local`` are intentionally accepted as endpoint-level
    # health, while concrete model IDs must be present.
    generic = wanted in {"", "local", "default"}
    model_check = HealthCheck(
        "model",
        HealthState.READY if exact or generic else HealthState.DEGRADED,
        (
            f"configured model is advertised ({len(models)} model(s) total)"
            if exact or generic
            else f"endpoint is healthy but configured model is not among {len(models)} advertised IDs"
        ),
        metadata={
            "configuredModel": cfg.model,
            "advertisedModels": models[:50],
            "truncated": len(models) > 50,
        },
    )
    return endpoint, model_check, None


def _probe_cli_models(
    cfg: ModelConfig,
    *,
    timeout: float,
    run: Callable[..., subprocess.CompletedProcess[str]],
) -> tuple[HealthCheck | None, ProviderError | None]:
    if cfg.kind != "grok":
        return None, None
    proc: subprocess.CompletedProcess[str] | None = None
    try:
        proc = run(
            ["grok", "models"],
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        # Grok CLI 1.0.3 can print the complete, authenticated model list and
        # then linger while its telemetry BatchSpanProcessor shuts down. A
        # strict process-exit-only probe therefore showed a red Provider Health
        # node even though grok-4.6 had already been advertised. TimeoutExpired
        # preserves captured stdout; accept only the configured model's exact
        # appearance, and retain the missing process exit in metadata.
        raw_output = exc.stdout if exc.stdout is not None else exc.output
        if isinstance(raw_output, bytes):
            output = raw_output.decode("utf-8", errors="replace")
        else:
            output = str(raw_output or "")
        wanted = cfg.model.casefold()
        advertised = bool(wanted and wanted in output.casefold())
        if advertised:
            return HealthCheck(
                "model",
                HealthState.READY,
                "configured Grok model was advertised before CLI shutdown timed out",
                metadata={
                    "generationRequest": False,
                    "processExitObserved": False,
                    "metadataTimeoutSec": float(timeout),
                },
            ), None
        error = classify_provider_error(
            exc, provider=cfg.label or cfg.kind, model=cfg.model
        )
        return HealthCheck(
            "model",
            HealthState.UNAVAILABLE,
            error.message,
            metadata={
                "generationRequest": False,
                "processExitObserved": False,
                "metadataTimeoutSec": float(timeout),
            },
        ), error
    except OSError as exc:
        error = classify_provider_error(
            exc, provider=cfg.label or cfg.kind, model=cfg.model
        )
        return HealthCheck("model", HealthState.UNAVAILABLE, error.message), error
    assert proc is not None
    if proc.returncode != 0:
        # stderr may contain terminal noise but must not expose credentials.
        error = classify_provider_error(
            f"grok models exited {proc.returncode}: {(proc.stderr or '')[-500:]}",
            provider=cfg.label or cfg.kind,
            model=cfg.model,
        )
        return HealthCheck("model", HealthState.UNAVAILABLE, error.message), error
    output = (proc.stdout or "").strip()
    wanted = cfg.model.casefold()
    advertised = wanted in output.casefold() if wanted else bool(output)
    return HealthCheck(
        "model",
        HealthState.READY if advertised else HealthState.DEGRADED,
        "configured Grok model is advertised" if advertised else "Grok model list did not advertise configured model",
        metadata={"generationRequest": False},
    ), None


def _overall_state(checks: list[HealthCheck]) -> HealthState:
    required = [check for check in checks if check.required]
    if any(check.state is HealthState.UNCONFIGURED for check in required):
        return HealthState.UNCONFIGURED
    if any(check.state is HealthState.UNAVAILABLE for check in required):
        return HealthState.UNAVAILABLE
    if any(check.state is HealthState.DEGRADED for check in required):
        return HealthState.DEGRADED
    if any(check.state is HealthState.READY for check in required):
        return HealthState.READY
    if any(check.state is HealthState.CONFIGURED for check in required):
        return HealthState.CONFIGURED
    return HealthState.UNKNOWN


def probe_provider(
    spec: str | ModelConfig | None = None,
    *,
    allow_remote_metadata: bool = False,
    include_models: bool = True,
    timeout: float = 1.5,
    environ: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> ProviderHealth:
    """Probe one provider without generation or paid requests.

    Loopback OpenAI-compatible ``GET /models`` is automatic. A remote metadata
    request happens only when ``allow_remote_metadata=True``. CLI model listing
    is metadata-only and can be disabled with ``include_models=False``.
    """
    env = os.environ if environ is None else environ
    try:
        cfg = spec if isinstance(spec, ModelConfig) else resolve_config(spec)
    except Exception as exc:  # noqa: BLE001 - return typed health failure
        error = classify_provider_error(exc)
        return ProviderHealth(
            provider="",
            model="",
            state=HealthState.UNCONFIGURED,
            checks=(HealthCheck("configuration", HealthState.UNCONFIGURED, error.message),),
            error=error,
        )

    checks: list[HealthCheck] = [
        HealthCheck(
            "configuration",
            HealthState.CONFIGURED,
            "provider configuration resolved",
            metadata={
                "provider": cfg.label or cfg.kind,
                "transport": cfg.kind,
                "externalGateway": cfg.external_gateway,
                "optional": cfg.optional,
            },
        ),
        _credential_check(cfg, env),
    ]
    binary_name = _cli_binary(cfg, env)
    binary = _binary_check(cfg, environ=env, which=which)
    if binary:
        checks.append(binary)

    error: ProviderError | None = None
    if cfg.kind == "codex" and binary and binary.ok:
        auth_check, auth_error = probe_codex_login_status(
            timeout=timeout,
            run=run,
            binary=binary_name or "codex",
        )
        checks.append(auth_check)
        error = auth_error

    url = _models_url(cfg)
    host = ""
    if url:
        try:
            host = (urlsplit(url).hostname or "").casefold()
        except ValueError:
            host = ""
    if url and (host in _LOOPBACK_HOSTS or allow_remote_metadata):
        endpoint, model_check, error = _probe_models_endpoint(
            cfg, timeout=timeout, urlopen=urlopen, environ=env
        )
        checks.append(endpoint)
        if include_models and model_check:
            checks.append(model_check)
    elif url:
        checks.append(HealthCheck(
            "endpoint",
            HealthState.SKIPPED,
            "remote metadata endpoint not contacted automatically",
            required=False,
            metadata={"remote": True, "generationRequest": False},
        ))
    elif include_models and cfg.kind == "grok" and (not binary or binary.ok):
        model_check, error = _probe_cli_models(cfg, timeout=timeout, run=run)
        if model_check:
            checks.append(model_check)
            if model_check.state in {HealthState.READY, HealthState.DEGRADED}:
                # ``grok models`` is the authoritative no-spend authentication
                # probe. Grok CLI credential storage is an implementation
                # detail and may not live at ~/.grok/auth.json, so a successful
                # model-list response must outrank the earlier filesystem hint.
                checks = [
                    HealthCheck(
                        "credentials",
                        HealthState.CONFIGURED,
                        "Grok CLI metadata probe authenticated successfully",
                        metadata={
                            "source": "grok models",
                            "valueExposed": False,
                            "generationRequest": False,
                        },
                    )
                    if check.name == "credentials"
                    else check
                    for check in checks
                ]
    else:
        checks.append(HealthCheck(
            "endpoint",
            HealthState.SKIPPED,
            "no endpoint probe applies to this transport",
            required=False,
        ))

    return ProviderHealth(
        provider=cfg.label or cfg.kind,
        model=cfg.model,
        state=_overall_state(checks),
        checks=tuple(checks),
        error=error,
        capabilities=provider_capabilities(cfg).to_dict(),
        paid_probe_made=False,
    )


def probe_providers(
    specs: list[str],
    **kwargs: Any,
) -> list[ProviderHealth]:
    """Probe several explicit specs; never auto-enumerates paid cloud providers."""
    return [probe_provider(spec, **kwargs) for spec in specs]


# Naming aliases for consumers that read more naturally as "health check".
check_provider_health = probe_provider
provider_health = probe_provider
