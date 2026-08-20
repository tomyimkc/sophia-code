# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""pi-ai provider backplane transport (ADR-0002 W4 spike).

Spawns the thin Node sidecar at ``tools/pi_ai_sidecar/server.mjs`` over stdio:

    request:  {"model": str, "messages": [...], "max_tokens"?: int}
    response: {"text": str, "ok": bool, "error"?: str, ...}

Default sidecar backend is an offline mock (no ``@mariozechner/pi-ai`` install,
no network/OAuth). Operators opt into the real package with
``SOPHIA_PI_AI_BACKEND=pi-ai`` after installing the optional dep.

This is a **scaffold / spike**, not a claim that ~30 providers are measured
working. Fail closed on missing Node binary, missing script, timeout, or
malformed sidecar JSON. Spend caps and the delivery gate still apply above
this transport — it is just another model path.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from agent.model import ModelConfig, ModelResult

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SIDECAR = ROOT / "tools" / "pi_ai_sidecar" / "server.mjs"


def sidecar_command() -> list[str]:
    """Resolve ``[node, server.mjs]`` from env overrides or repo defaults."""
    node = (os.environ.get("SOPHIA_PI_AI_NODE") or "node").strip() or "node"
    script = (os.environ.get("SOPHIA_PI_AI_SIDECAR") or "").strip()
    path = Path(script) if script else DEFAULT_SIDECAR
    return [node, str(path)]


def build_request(
    system: str,
    user: str,
    cfg: ModelConfig,
    *,
    messages: list[dict] | None = None,
) -> dict[str, Any]:
    """Build the stdio JSON body the sidecar expects."""
    if messages:
        msgs = list(messages)
    else:
        msgs = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs.append({"role": "user", "content": user})
    return {
        "model": cfg.model,
        "messages": msgs,
        "max_tokens": cfg.max_tokens,
        "temperature": cfg.temperature,
    }


def call_pi_ai(
    system: str,
    user: str,
    cfg: ModelConfig,
    *,
    messages: list[dict] | None = None,
    **_: Any,
) -> ModelResult:
    """Spawn the pi-ai sidecar once per call; fail closed on any transport fault."""
    command = sidecar_command()
    script_path = Path(command[-1])
    if not script_path.is_file():
        return ModelResult(
            text="",
            provider="pi-ai",
            model=cfg.model,
            ok=False,
            error=f"pi-ai sidecar script missing: {script_path}. "
            "Expected tools/pi_ai_sidecar/server.mjs (or set SOPHIA_PI_AI_SIDECAR).",
            finish_reason="error",
        )

    payload = build_request(system, user, cfg, messages=messages)
    try:
        proc = subprocess.run(
            command,
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=cfg.timeout_sec,
            check=False,
            cwd=str(ROOT),
        )
    except subprocess.TimeoutExpired as exc:
        return ModelResult(
            text="",
            provider="pi-ai",
            model=cfg.model,
            ok=False,
            error=f"pi-ai sidecar timed out after {cfg.timeout_sec}s: {exc!r}",
            finish_reason="timeout",
        )
    except FileNotFoundError as exc:
        return ModelResult(
            text="",
            provider="pi-ai",
            model=cfg.model,
            ok=False,
            error=f"pi-ai sidecar binary unavailable (need Node on PATH or "
            f"SOPHIA_PI_AI_NODE): {exc!r}",
            finish_reason="error",
        )
    except OSError as exc:
        return ModelResult(
            text="",
            provider="pi-ai",
            model=cfg.model,
            ok=False,
            error=f"pi-ai sidecar spawn failed: {exc!r}",
            finish_reason="error",
        )

    stdout = (proc.stdout or "").strip()
    if not stdout:
        detail = (proc.stderr or f"exit {proc.returncode}")[-500:]
        return ModelResult(
            text="",
            provider="pi-ai",
            model=cfg.model,
            ok=False,
            error=f"pi-ai sidecar returned empty stdout: {detail}",
            finish_reason="error",
        )

    # Sidecar may emit a ready line + result; take the last JSON object line.
    data: dict[str, Any] | None = None
    parse_error: str | None = None
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            parse_error = str(exc)
            continue
        if isinstance(parsed, dict):
            data = parsed
            break

    if data is None:
        return ModelResult(
            text="",
            provider="pi-ai",
            model=cfg.model,
            ok=False,
            error=f"pi-ai sidecar returned non-JSON stdout: {parse_error or stdout[:300]!r}",
            finish_reason="error",
        )

    text = str(data.get("text") or "").strip()
    ok_flag = bool(data.get("ok", True)) and bool(text)
    if proc.returncode != 0 and not ok_flag:
        err = data.get("error") or (proc.stderr or "")[-500:] or f"exit {proc.returncode}"
        return ModelResult(
            text=text,
            provider="pi-ai",
            model=str(data.get("model") or cfg.model),
            ok=False,
            error=str(err),
            finish_reason="error",
            raw=data,
        )
    if not ok_flag:
        return ModelResult(
            text=text,
            provider="pi-ai",
            model=str(data.get("model") or cfg.model),
            ok=False,
            error=str(data.get("error") or "pi-ai sidecar returned no usable text"),
            finish_reason="error",
            raw=data,
        )

    return ModelResult(
        text=text,
        provider="pi-ai",
        model=str(data.get("model") or cfg.model),
        ok=True,
        finish_reason="stop",
        completion_tokens=max(1, len(text) // 4),
        raw=data,
    )
