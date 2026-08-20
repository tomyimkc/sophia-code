# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Browser/CLI login for subscription-backed model providers.

Sophia does not implement xAI or OpenAI OAuth. It launches the official
provider CLI (``grok login``, ``codex login``), which opens the vendor
sign-in page. Tokens stay in that CLI's own files; this module never
returns credential values.

candidateOnly; canClaimAGI:false.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

URL_RE = re.compile(r"https://[^\s\"'<>]+")
_SECRET_RE = re.compile(
    r"(sk-[A-Za-z0-9]{8,}|xai-[A-Za-z0-9]{8,}|Bearer\s+\S+|access_token|refresh_token)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class LoginProvider:
    id: str
    label: str
    model_spec: str
    binary: str
    login_argv: tuple[str, ...]
    session_relpath: str
    install_hint: str
    login_hint: str


LOGIN_PROVIDERS: tuple[LoginProvider, ...] = (
    LoginProvider(
        id="grok",
        label="Grok (xAI subscription)",
        model_spec="grok",
        binary="grok",
        login_argv=("login", "--oauth"),
        session_relpath=".grok/auth.json",
        install_hint="Install the official Grok CLI and keep `grok` on PATH.",
        login_hint="Opens the xAI / grok.com browser login used by the Grok subscription.",
    ),
    LoginProvider(
        id="codex",
        label="Codex (ChatGPT subscription)",
        model_spec="codex",
        binary="codex",
        login_argv=("login",),
        session_relpath=".codex",
        install_hint="Install the official Codex CLI and keep `codex` on PATH.",
        login_hint="Opens the ChatGPT / Codex browser login used by that subscription.",
    ),
)

_BY_ID = {row.id: row for row in LOGIN_PROVIDERS}
_ALIASES = {
    "grok": "grok",
    "grok-cli": "grok",
    "xai": "grok",
    "codex": "codex",
    "chatgpt": "codex",
}
# Only these hosts may be handed to webbrowser.open. Sophia never follows
# arbitrary URLs printed by a provider CLI.
ALLOWED_LOGIN_HOSTS = {
    "grok": frozenset({"auth.x.ai", "accounts.x.ai", "grok.com", "www.grok.com", "x.ai"}),
    "codex": frozenset({
        "auth.openai.com",
        "chatgpt.com",
        "www.chatgpt.com",
        "platform.openai.com",
    }),
}


def redact_auth_text(text: str) -> str:
    """Strip credential-shaped spans before any UI/event payload."""
    return _SECRET_RE.sub("[redacted]", text or "")


def resolve_login_provider(name: str) -> LoginProvider | None:
    key = (name or "").strip().casefold()
    if key.startswith("grok:"):
        key = "grok"
    canonical = _ALIASES.get(key)
    if canonical is None:
        return None
    return _BY_ID[canonical]


def session_path(provider: LoginProvider, *, home: Path | None = None) -> Path:
    root = home if home is not None else Path.home()
    return root / provider.session_relpath


def provider_login_status(
    name: str,
    *,
    home: Path | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> dict[str, Any]:
    spec = resolve_login_provider(name)
    if spec is None:
        return {
            "ok": False,
            "provider": (name or "").strip().casefold(),
            "ready": False,
            "needsLogin": False,
            "detail": "unknown login provider (try grok or codex)",
            "canClaimAGI": False,
        }
    binary = which(spec.binary)
    path = session_path(spec, home=home)
    signed_in = path.exists()
    ready = bool(binary) and signed_in
    if binary is None:
        detail = spec.install_hint
    elif not signed_in:
        detail = spec.login_hint
    else:
        detail = f"{spec.label} CLI is installed and a local session file is present."
    return {
        "ok": True,
        "provider": spec.id,
        "label": spec.label,
        "modelSpec": spec.model_spec,
        "binary": spec.binary,
        "binaryFound": binary is not None,
        "ready": ready,
        "needsLogin": binary is not None and not signed_in,
        "detail": detail,
        "loginHint": spec.login_hint,
        "canClaimAGI": False,
    }


def list_login_providers(
    *,
    home: Path | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> list[dict[str, Any]]:
    return [
        provider_login_status(row.id, home=home, which=which)
        for row in LOGIN_PROVIDERS
    ]


def login_argv(spec: LoginProvider, *, binary: str) -> list[str]:
    return [binary, *spec.login_argv]


def extract_login_urls(text: str) -> list[str]:
    return [
        match.group(0).rstrip(").,;]")
        for match in URL_RE.finditer(text or "")
        if "http" in match.group(0)
    ]


def is_allowed_login_url(url: str, provider: str) -> bool:
    """Fail closed: https + exact vendor host only."""
    parsed = urlparse(url or "")
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return False
    host = (parsed.hostname or "").casefold()
    return host in ALLOWED_LOGIN_HOSTS.get(provider, frozenset())


def _public_login_result(
    spec: LoginProvider,
    *,
    ready: bool,
    detail: str,
    urls: list[str],
    started: bool,
    exit_code: int | None,
) -> dict[str, Any]:
    payload = {
        "ok": ready or started,
        "provider": spec.id,
        "label": spec.label,
        "modelSpec": spec.model_spec,
        "ready": ready,
        "started": started,
        "urls": urls[:4],
        "detail": redact_auth_text(detail),
        "exitCode": exit_code,
        "canClaimAGI": False,
    }
    blob = str(payload)
    if _SECRET_RE.search(blob):
        raise RuntimeError("provider login result leaked a credential-shaped value")
    return payload


def run_provider_login(
    name: str,
    *,
    home: Path | None = None,
    which: Callable[[str], str | None] = shutil.which,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    open_url: Callable[[str], None] | None = None,
    timeout_sec: float = 300.0,
) -> dict[str, Any]:
    """Run the official provider CLI login. Never returns credential values."""
    spec = resolve_login_provider(name)
    if spec is None:
        return {
            "ok": False,
            "provider": (name or "").strip().casefold(),
            "ready": False,
            "started": False,
            "urls": [],
            "detail": "unknown login provider (try grok or codex)",
            "exitCode": None,
            "canClaimAGI": False,
        }
    status = provider_login_status(spec.id, home=home, which=which)
    if status["ready"]:
        return _public_login_result(
            spec,
            ready=True,
            detail=str(status["detail"]),
            urls=[],
            started=False,
            exit_code=0,
        )
    binary = which(spec.binary)
    if binary is None:
        return _public_login_result(
            spec,
            ready=False,
            detail=spec.install_hint,
            urls=[],
            started=False,
            exit_code=None,
        )
    argv = login_argv(spec, binary=binary)
    run = runner or subprocess.run
    try:
        from sophia.portable_proc import argv_for_subprocess

        completed = run(
            argv_for_subprocess(argv),
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
            stdin=subprocess.DEVNULL,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired:
        return _public_login_result(
            spec,
            ready=session_path(spec, home=home).exists(),
            detail="login is still waiting in the browser; finish sign-in there, then /login status",
            urls=[],
            started=True,
            exit_code=None,
        )
    except OSError as exc:
        return _public_login_result(
            spec,
            ready=False,
            detail=f"could not start {spec.binary} login: {type(exc).__name__}",
            urls=[],
            started=False,
            exit_code=None,
        )
    raw = (completed.stdout or "") + "\n" + (completed.stderr or "")
    urls = [
        url for url in extract_login_urls(raw)
        if is_allowed_login_url(url, spec.id)
    ]
    ready = session_path(spec, home=home).exists() and completed.returncode == 0
    if urls:
        opener = open_url
        if opener is None:
            try:
                import webbrowser

                opener = lambda url: webbrowser.open(url, new=2)
            except Exception:
                opener = None
        if opener is not None:
            try:
                opener(urls[0])
            except Exception:
                pass
    if ready:
        detail = f"{spec.label} sign-in finished. Sophia will use model `{spec.model_spec}`."
    elif urls:
        detail = (
            f"Open this sign-in page if the browser did not appear: {urls[0]}"
        )
    elif completed.returncode != 0:
        detail = (
            f"{spec.binary} login exited {completed.returncode}. "
            f"{spec.install_hint}"
        )
    else:
        detail = spec.login_hint
    return _public_login_result(
        spec,
        ready=ready,
        detail=detail,
        urls=urls,
        started=True,
        exit_code=int(completed.returncode),
    )


__all__ = [
    "LOGIN_PROVIDERS",
    "LoginProvider",
    "extract_login_urls",
    "is_allowed_login_url",
    "list_login_providers",
    "login_argv",
    "provider_login_status",
    "redact_auth_text",
    "resolve_login_provider",
    "run_provider_login",
    "session_path",
]
