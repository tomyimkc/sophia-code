# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Unified model adapter for Sophia AGI.

One abstraction over every backend the repo touches, so the agent harness,
distillation, and eval layers depend on a single interface instead of the
fragmented access in agent/llm.py, agent/gemini_llm.py, and the call_model
helpers inside tools/run_hidden_eval_sophia.py.

Providers
---------
- ``anthropic``     : Claude via the anthropic SDK (lazy import).
- ``openai``        : ANY OpenAI-compatible /chat/completions endpoint — covers
                      GLM-5.2 (Zhipu), vLLM, SGLang, Ollama, llama.cpp server,
                      DeepSeek, and OpenAI itself. Uses urllib (no new deps).
- ``grok``          : the local grok CLI (subprocess), mirroring the hidden runner.
- ``openclaw``      : the local OpenClaw CLI gateway (subprocess) — unified text
                      inference (``openclaw infer model run --json``) routed across
                      OpenClaw's own provider/auth profiles. Pure inference (writes no
                      knowledge); offline-stubbable, degrades to ``ok=False`` when absent.
- ``mock``          : deterministic, offline — lets the whole stack be tested
                      without network or credentials.
- ``pi-ai``         : thin Node stdio sidecar (``tools/pi_ai_sidecar/``) for the
                      optional ``@mariozechner/pi-ai`` package (ADR-0002 W4 spike).
                      Default backend is an offline mock — no network/OAuth in CI.

Features: named presets, reasoning effort, streaming (openai/mock), native
tool-calling pass-through, retry with backoff, fallback chain, and cost/latency
tracking. No required third-party dependency at import time.
"""

from __future__ import annotations

from collections import OrderedDict
from contextlib import nullcontext

import json
import math
import os
import queue
import re
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from dataclasses import dataclass, field, replace
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from agent.config import (
    anthropic_api_key,
    anthropic_base_url,
    is_real_secret,
    load_dotenv,
    normalize_api_keys,
)
from agent.runtime_paths import mutable_path

ROOT = Path(__file__).resolve().parents[1]

# Approximate USD per 1M tokens (input, output). Override via SOPHIA_MODEL_PRICES
# (JSON object keyed by model substring). Unknown models cost 0 and are flagged.
DEFAULT_PRICES: dict[str, tuple[float, float]] = {
    "claude-opus": (15.0, 75.0),
    "claude-sonnet": (3.0, 15.0),
    "claude-haiku": (0.8, 4.0),
    "gpt-4o-mini": (0.15, 0.6),
    "gpt-4o": (2.5, 10.0),
    "gpt-4.1": (2.0, 8.0),
    "deepseek": (0.27, 1.1),
    "glm-5": (0.8, 3.0),
    "glm-4": (0.6, 2.2),
    "glm": (0.6, 2.2),
    "qwen": (0.0, 0.0),
    "llama": (0.0, 0.0),
    "mistral": (0.0, 0.0),
}

# Transport families that never send cfg.model to the backend, so cfg.model is
# only a LABEL. codex/openclaw/mlx all pass cfg.model through and are therefore
# genuinely steerable by it, so they were never in here.
#
# "grok" WAS listed: _call_grok shelled out with no --model flag, so the CLI's
# own config decided what answered and any name we reported was a guess. The CLI
# does accept -m/--model (verified against `grok --help` and `grok models`), so
# _grok_command now passes it and the label is earned rather than assumed. Empty
# is the correct current state, not a disabled check — re-add a kind here the
# moment a transport stops forwarding the name.
_MODEL_NAME_IGNORED_KINDS: frozenset[str] = frozenset()

#: Default model selected by the ChatGPT-authenticated Grok CLI transport.
#:
#: ``grok models`` reported grok-4.6 as the CLI default on 2026-08-14. Sophia
#: still passes the model explicitly so the runtime receipt names what was
#: actually requested instead of relying on a mutable CLI-side default.
GROK_CLI_DEFAULT_MODEL = "grok-4.6"

#: Operator aliases that are Sophia provider names, not grok-CLI model ids.
#: Sending ``--model grok`` to the CLI fails with ``unknown model id``.
_GROK_CLI_MODEL_ALIASES: dict[str, str] = {
    "grok": GROK_CLI_DEFAULT_MODEL,
    "grok-cli": GROK_CLI_DEFAULT_MODEL,
    "grok-4": GROK_CLI_DEFAULT_MODEL,
}


def canonical_grok_cli_model(model: str) -> str:
    """Return a grok-CLI model id, never the Sophia provider alias."""
    normalized = str(model or "").strip()
    if not normalized:
        return ""
    return _GROK_CLI_MODEL_ALIASES.get(normalized.casefold(), normalized)

#: Grok 4.5/4.6 total window, in tokens.
#:
#: Not a marketing figure: it is what the grok CLI itself operates on, read from
#: its own model cache (``~/.grok/models_cache.json``, fetched from
#: ``https://cli-chat-proxy.grok.com/v1/models``), where grok-4.5 and grok-4.6
#: declare
#: ``"context_window": 500000`` alongside
#: ``"auto_compact_threshold_percent": 80`` — the same 80% this repo now
#: compacts at, so Sophia and the CLI agree about when a session is full.
GROK_CONTEXT_WINDOW = 500_000
# Dynamic workflow stages own a queue-aware hard deadline of at least 600
# seconds for normal runs. Keep the Grok transport from pre-empting that
# supervisor with the historical 300-second subprocess timeout. Cancellation
# remains prompt because _call_grok polls should_cancel and stops only its exact
# owned process group.
GROK_CLI_TIMEOUT_SEC = 600
# Compatibility alias for code/tests that predate the Grok 4.6 CLI default.
GROK_4_5_CONTEXT_WINDOW = GROK_CONTEXT_WINDOW

CODEX_SOL_MODEL = "gpt-5.6-sol"
CODEX_TERRA_MODEL = "gpt-5.6-terra"
CODEX_LUNA_MODEL = "gpt-5.6-luna"
CODEX_LEGACY_FUGU_MODEL = "fugu"

_CODEX_MODEL_ALIASES: dict[str, str] = {
    "codex": CODEX_SOL_MODEL,
    "codex-5.6": CODEX_SOL_MODEL,
    "codex-sol": CODEX_SOL_MODEL,
    "gpt-5.6": CODEX_SOL_MODEL,
    "sol": CODEX_SOL_MODEL,
    "codex-terra": CODEX_TERRA_MODEL,
    "terra": CODEX_TERRA_MODEL,
    "codex-luna": CODEX_LUNA_MODEL,
    "luna": CODEX_LUNA_MODEL,
    "codex-fugu": CODEX_LEGACY_FUGU_MODEL,
    "fugu": CODEX_LEGACY_FUGU_MODEL,
}


def canonical_codex_model(model: str) -> str:
    """Return the concrete model slug sent to the official Codex CLI."""
    normalized = str(model or "").strip()
    return _CODEX_MODEL_ALIASES.get(normalized.casefold(), normalized)


# provider preset -> partial config. "kind" is the transport family.
PRESETS: dict[str, dict[str, Any]] = {
    "anthropic": {"kind": "anthropic", "model": "claude-sonnet-4-6"},
    "openai": {"kind": "openai", "base_url": "https://api.openai.com/v1", "api_key_env": "OPENAI_API_KEY", "model": "gpt-4o-mini"},
    "glm": {"kind": "openai", "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key_env": "ZHIPUAI_API_KEY", "model": "glm-4.6"},
    # Provider/model aliases used by the local Sophia Code harness.
    "zai": {"kind": "anthropic", "base_url": "https://api.z.ai/api/anthropic", "api_key_env": "ZAI_API_KEY", "model": "glm-5.2"},
    "glm-5.2": {"kind": "anthropic", "base_url": "https://api.z.ai/api/anthropic", "api_key_env": "ZAI_API_KEY", "model": "glm-5.2"},

    # TeamoRouter native Anthropic endpoint. Claude models must use /v1/messages;
    # the provider documents that its OpenAI Responses endpoint rejects Claude.
    # Keep the credential provider-specific so selecting this preset never
    # borrows an unrelated OPENAI_API_KEY or ANTHROPIC_API_KEY.
    "teamorouter": {
        "kind": "anthropic",
        "base_url": "https://api.teamorouter.com",
        "api_key_env": "TEAMOROUTER_API_KEY",
        "model": "claude-opus-5",
        "worker_model": "claude-sonnet-5",
        "max_tokens": 8192,
        "timeout_sec": 600,
        "strict_key_source": True,
    },

    # vip.aipro.love has exactly two credential lanes in /model. Each keeps
    # Opus 5 as coordinator and uses Sonnet 5 for ultramode team/delegate work.
    "aipro": {
        "kind": "anthropic",
        "base_url": "https://vip.aipro.love",
        "api_key_env": "SOPHIA_AIPRO_KEY",
        "model": "claude-opus-5",
        "worker_model": "claude-sonnet-5",
        "worker_all_efforts": True,
        "fixed_model": True,
        "allow_fallbacks": False,
        "max_tokens": 8192,
        "timeout_sec": 300,
        "strict_key_source": True,
    },
    "aipro-2": {
        "kind": "anthropic",
        "base_url": "https://vip.aipro.love",
        "api_key_env": "SOPHIA_AIPRO_KEY_2",
        "model": "claude-opus-5",
        "worker_model": "claude-sonnet-5",
        "worker_all_efforts": True,
        "fixed_model": True,
        "allow_fallbacks": False,
        "max_tokens": 8192,
        "timeout_sec": 300,
        "strict_key_source": True,
    },
    "deepseek": {"kind": "openai", "base_url": "https://api.deepseek.com", "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-chat"},
    "openrouter": {"kind": "openai", "base_url": "https://openrouter.ai/api/v1", "api_key_env": "OPENROUTER_API_KEY", "model": "openai/gpt-4o-mini", "external_gateway": True, "optional": True},
    # api.020s.com: an OpenAI-compatible cloud aggregator serving gpt-5.6-sol /
    # -luna / -terra, gpt-5.5, gpt-5.3-codex-spark. Like every kind=openai preset
    # Sophia's loop owns tool use through native tool_calls. The Codex CLI presets
    # below now provide the same ownership through a structured-envelope bridge.
    # Pin a sibling model via spec, e.g. "020s:gpt-5.6-terra". Key: SOPHIA_020S_KEY.
    # reasoning_effort defaults to "max" because gpt-5.6-sol/-luna/-terra return NO
    # reasoning_content without it, and "max" yields the most reasoning to distill
    # (~3x the reasoning_tokens of "high"; measured 260 vs 90 on gpt-5.6-luna).
    # Valid values: none/minimal/low/medium/high/xhigh/max — "ultra" is rejected (400).
    # SOPHIA_REASONING_EFFORT still overrides when set.
    "020s": {"kind": "openai", "base_url": "https://api.020s.com/v1", "api_key_env": "SOPHIA_020S_KEY", "model": "gpt-5.6-sol", "reasoning_effort": "max", "tool_choice": "auto", "external_gateway": True, "optional": True},
    # Named gpt-5.6 model choices on the primary key…
    "020s-luna": {"kind": "openai", "base_url": "https://api.020s.com/v1", "api_key_env": "SOPHIA_020S_KEY", "model": "gpt-5.6-luna", "reasoning_effort": "max", "tool_choice": "auto", "external_gateway": True, "optional": True},
    "020s-terra": {"kind": "openai", "base_url": "https://api.020s.com/v1", "api_key_env": "SOPHIA_020S_KEY", "model": "gpt-5.6-terra", "reasoning_effort": "max", "tool_choice": "auto", "external_gateway": True, "optional": True},
    # …and two extra gpt-5.6-terra options, each on its OWN 020s key, so heavy
    # distillation load can spread across keys (avoids the per-key weekly limit).
    "020s-terra2": {"kind": "openai", "base_url": "https://api.020s.com/v1", "api_key_env": "SOPHIA_020S_KEY_2", "model": "gpt-5.6-terra", "reasoning_effort": "max", "tool_choice": "auto", "external_gateway": True, "optional": True},
    "020s-terra3": {"kind": "openai", "base_url": "https://api.020s.com/v1", "api_key_env": "SOPHIA_020S_KEY_3", "model": "gpt-5.6-terra", "reasoning_effort": "max", "tool_choice": "auto", "external_gateway": True, "optional": True},
    # Codex-family id on the same OpenAI-compatible 020s gateway. Native Sophia
    # tools (not grok-CLI, not the ChatGPT Codex CLI). Pin a different spark
    # id with ``020s:gpt-5.3-codex-spark`` if the catalog moves.
    "020s-codex": {
        "kind": "openai",
        "base_url": "https://api.020s.com/v1",
        "api_key_env": "SOPHIA_020S_KEY",
        "model": "gpt-5.3-codex-spark",
        "reasoning_effort": "max",
        "tool_choice": "auto",
        "external_gateway": True,
        "optional": True,
    },
    "ollama": {"kind": "openai", "base_url": "http://localhost:11434/v1", "api_key_env": "OLLAMA_API_KEY", "model": "llama3.1", "api_key_default": "ollama"},
    "vllm": {"kind": "openai", "base_url": "http://localhost:8000/v1", "api_key_env": "VLLM_API_KEY", "model": "local", "api_key_default": "1234"},
    # Native DS4 chat-completions endpoint. Unlike generic OpenAI-compatible
    # servers, DS4's reasoning/tool continuation template needs the assistant's
    # reasoning_content + tool_calls turn followed by role=tool results. The
    # transport/loop flags below keep that wire-only transcript exact without
    # persisting hidden reasoning in Sophia logs or session history.
    "ds4": {
        "kind": "openai",
        "base_url": "http://127.0.0.1:8000/v1",
        "api_key_env": "DS4_API_KEY",
        "api_key_default": "dsv4-local",
        "model": "deepseek-v4-flash",
        # Matches the managed Spark wrapper and upstream's agent examples.
        # Operators serving another --ctx must set SOPHIA_CONTEXT_WINDOW.
        "context_window": 100000,
        "max_tokens": 16384,
        "timeout_sec": 600,
        "tool_choice": "auto",
        "requires_native_tool_transcript": True,
    },
    # Compatibility alias for deployments that still expose the earlier
    # pulsar-server name while speaking the same DS4 OpenAI chat protocol.
    "pulsar": {
        "kind": "openai",
        "base_url": "http://127.0.0.1:8000/v1",
        "api_key_env": "PULSAR_API_KEY",
        "api_key_default": "dsv4-local",
        "model": "deepseek-v4-flash",
        "context_window": 100000,
        "max_tokens": 16384,
        "timeout_sec": 600,
        "tool_choice": "auto",
        "requires_native_tool_transcript": True,
    },
    "sglang": {"kind": "openai", "base_url": "http://localhost:30000/v1", "api_key_env": "SGLANG_API_KEY", "model": "local", "api_key_default": "EMPTY"},
    "llamacpp": {"kind": "openai", "base_url": "http://localhost:8080/v1", "api_key_env": "LLAMACPP_API_KEY", "model": "local", "api_key_default": "sk-no-key"},
    # The grok CLI, driven with its mutating/exfiltrating tools denied. Pin the
    # live CLI default explicitly so receipts remain model-honest. This exact
    # subscription transport is an authority choice: never silently substitute
    # an ambient API-provider fallback beneath it.
    "grok": {
        "kind": "grok",
        "model": GROK_CLI_DEFAULT_MODEL,
        "context_window": GROK_CONTEXT_WINDOW,
        "timeout_sec": GROK_CLI_TIMEOUT_SEC,
        "allow_fallbacks": False,
    },
    # xAI's OpenAI-compatible API, retained as the separately authenticated
    # Grok 4.5 route for operators who hold an XAI_API_KEY. Both
    # routes now keep Sophia's tool gate (the CLI one by denying grok's own tools,
    # see GROK_DENY_PREFIXES), so the choice between them is about credentials,
    # not about safety. Endpoint matches tools/run_external_models.py.
    "xai": {"kind": "openai", "base_url": "https://api.x.ai/v1", "api_key_env": "XAI_API_KEY",
            "model": "grok-4.5", "context_window": GROK_CONTEXT_WINDOW},
    "grok-4.5": {"kind": "openai", "base_url": "https://api.x.ai/v1", "api_key_env": "XAI_API_KEY",
                 "model": "grok-4.5", "context_window": GROK_CONTEXT_WINDOW},
    # Official ChatGPT-authenticated Codex CLI lane. ``codex`` is the canonical
    # advertised Sol alias; codex-5.6 remains resolution-only compatibility.
    # Codex CLI is an authenticated subscription transport, not an API-key
    # provider alias. Ambient SOPHIA_MODEL_FALLBACKS often names API providers
    # (and may include exhausted paid routes such as 020s); inheriting that list
    # made a transient/format failure open an unrelated cross-provider approval
    # dialog in the middle of an A2A lane. The unattended lane then emitted
    # provider-wait heartbeats while waiting for an operator decision.
    # Keep every official Codex alias on the selected ChatGPT subscription.
    "codex": {
        "kind": "codex", "model": CODEX_SOL_MODEL, "allow_fallbacks": False,
    },
    "codex-sol": {
        "kind": "codex", "model": CODEX_SOL_MODEL, "allow_fallbacks": False,
    },
    "codex-5.6": {
        "kind": "codex", "model": CODEX_SOL_MODEL, "allow_fallbacks": False,
    },
    "codex-terra": {
        "kind": "codex", "model": CODEX_TERRA_MODEL, "allow_fallbacks": False,
    },
    "codex-luna": {
        "kind": "codex", "model": CODEX_LUNA_MODEL, "allow_fallbacks": False,
    },
    # Separate legacy/custom lane; never silently selected by plain ``codex``.
    "codex-fugu": {
        "kind": "codex", "model": CODEX_LEGACY_FUGU_MODEL, "allow_fallbacks": False,
    },
    "fugu": {
        "kind": "codex", "model": CODEX_LEGACY_FUGU_MODEL, "allow_fallbacks": False,
    },
    "codex-api": {"kind": "anthropic", "base_url": "http://127.0.0.1:8788", "api_key_env": "CODEX_API_KEY", "api_key_default": "codex-proxy-local", "model": CODEX_SOL_MODEL, "external_gateway": True, "optional": True},
    "openclaw": {"kind": "openclaw", "model": "xai/grok-4.3", "external_gateway": True, "optional": True},
    # llmhub.com.cn: an OpenAI-compatible aggregator fronting many vendor families
    # (openai/gpt-*, anthropic/claude-*, google/gemini-*, deepseek-*, ...). It serves
    # BARE model ids (no "vendor/" prefix), so family detection needs a name->family map
    # rather than the openrouter "vendor/model" split (see _LLMHUB_FAMILY in
    # provenance_bench/aggregate.py). HTTPS (host 301-redirects HTTP->HTTPS); key via
    # LLMHUB_API_KEY. Lets two genuinely-different vendors behind one key count as two
    # independent judge families for the no-overclaim >=2-family gate.
    "llmhub": {"kind": "openai", "base_url": "https://api.llmhub.com.cn/v1", "api_key_env": "LLMHUB_API_KEY", "model": "gpt-4o", "external_gateway": True, "optional": True},
    # Qwen teacher backend (DashScope's OpenAI-compatible endpoint). The default model is
    # the stable API alias; pin a specific snapshot via spec, e.g. "qwen:qwen3.6-35b-a3b".
    # A LOCAL Qwen teacher (e.g. Qwen3.6-35B-A3B on the workstation) rides the existing
    # local presets instead: "vllm:Qwen/Qwen3.6-35B-A3B@http://localhost:8000/v1",
    # "ollama:qwen3.6", or "mlx:<mlx-community model>" — no new transport needed.
    "qwen": {"kind": "openai", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key_env": "DASHSCOPE_API_KEY", "model": "qwen-max"},
    "qwen-coding": {"kind": "anthropic", "base_url": "http://127.0.0.1:8789", "api_key_env": "QWEN_API_KEY", "api_key_default": "qwen-cc-proxy-local", "model": "qwen-coding", "external_gateway": True, "optional": True},
    # Local Qwen3.6-35B-A3B (NVFP4) served by vLLM on this workstation (127.0.0.1:8000).
    # Served-model-name aliases on the live process: qwen3.6-35b-a3b, qwen3.5-35b-a3b,
    # nvidia/Qwen3.6-35B-A3B-NVFP4. Use /model qwen3.6-35b (or --model qwen3.6-35b).
    # Local Qwen3.6 is a reasoning model on a 256K-class context (vLLM max-model-len
    # 262144 on this Spark). Budget enough completion tokens for thinking +
    # multi-tool batches so parallel tool slots are not truncated mid-JSON.
    # timeout is high because long-context prefill is slow even when decode is fine.
    "qwen3.6-35b": {
        "kind": "openai",
        "base_url": "http://127.0.0.1:8000/v1",
        "api_key_env": "VLLM_API_KEY",
        "model": "qwen3.6-35b-a3b",
        "api_key_default": "1234",
        "max_tokens": 16384,
        "timeout_sec": 600,
    },
    "qwen3.6": {
        "kind": "openai",
        "base_url": "http://127.0.0.1:8000/v1",
        "api_key_env": "VLLM_API_KEY",
        "model": "qwen3.6-35b-a3b",
        "api_key_default": "1234",
        "max_tokens": 16384,
        "timeout_sec": 600,
    },
    "qwen36-local": {
        "kind": "openai",
        "base_url": "http://127.0.0.1:8000/v1",
        "api_key_env": "VLLM_API_KEY",
        "model": "qwen3.6-35b-a3b",
        "api_key_default": "1234",
        "max_tokens": 16384,
        "timeout_sec": 600,
    },
    "mlx": {"kind": "mlx", "model": "Qwen/Qwen3-4B-Instruct-2507"},
    # oMLX: local MLX OpenAI-compatible server (Mac). Serves MLX-quantized models
    # with native function-calling via the OpenAI tools protocol. Default model is
    # the Qwen3.6-35B-A3B 4-bit MLX quant (~19 GB). Auth: OMLX_API_KEY or the
    # oMLX default key "1234". NOT the prose-only mlx: transport — this rides
    # kind=openai so tools, streaming, and /bench tool-use all work.
    "omlx": {
        "kind": "openai",
        "base_url": "http://127.0.0.1:8000/v1",
        "api_key_env": "OMLX_API_KEY",
        "model": "Qwen3.6-35B-A3B-4bit",
        "api_key_default": "1234",
        "max_tokens": 32768,
        "timeout_sec": 600,
        "context_window": 262144,
    },
    "mock": {"kind": "mock", "model": "mock-1"},
    # ADR-0002 W4 spike: pi-ai provider backplane via Node stdio sidecar.
    # Spawns tools/pi_ai_sidecar/server.mjs per call. Default backend is mock
    # (CI-safe). Opt into real @mariozechner/pi-ai with SOPHIA_PI_AI_BACKEND=pi-ai
    # after optional install — scaffold only; not a measured multi-provider claim.
    "pi-ai": {"kind": "pi-ai", "model": "pi-ai-fixture", "timeout_sec": 120},
}

_REGISTERED_EXTERNAL_GATEWAYS: dict[str, dict[str, Any]] = {}
_EXTERNAL_GATEWAY_ALLOWED_FIELDS = frozenset({
    "kind", "model", "base_url", "api_key_env", "api_key_default",
    "context_window", "max_tokens", "timeout_sec", "reasoning_effort",
    "strict_key_source", "allow_fallbacks", "allow_private_network",
    "endpoint_scope",
})

_PLAINTEXT_MODEL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _validate_model_base_url(value: str, *, label: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"model provider {label!r} has invalid base_url")
    if parsed.scheme != "https" and (parsed.hostname or "").casefold() not in _PLAINTEXT_MODEL_HOSTS:
        raise ValueError(f"model provider {label!r} must use https off loopback")
    return value


def _normalize_external_gateway(name: str, raw: Mapping[str, Any]) -> dict[str, Any]:
    """Validate an optional gateway definition without accepting inline secrets."""
    label = name.strip().lower()
    if not label or not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", label):
        raise ValueError(f"invalid external gateway name {name!r}")
    if "api_key" in raw or "token" in raw or "secret" in raw:
        raise ValueError(
            f"external gateway {label!r} must name api_key_env; inline secret values are forbidden"
        )
    unknown = set(raw) - _EXTERNAL_GATEWAY_ALLOWED_FIELDS
    if unknown:
        raise ValueError(f"external gateway {label!r} has unsupported fields: {sorted(unknown)}")
    kind = str(raw.get("kind") or "openai").strip().lower()
    if kind not in {"openai", "openai-responses", "anthropic"}:
        raise ValueError(
            f"external gateway {label!r} kind must be openai, "
            "openai-responses, or anthropic"
        )
    base_url = str(raw.get("base_url") or "").strip()
    model = str(raw.get("model") or "").strip()
    if not base_url or not model:
        raise ValueError(f"external gateway {label!r} requires base_url and model")
    base_url = _validate_model_base_url(base_url, label=label)
    parsed = urlsplit(base_url)
    loopback = (parsed.hostname or "").casefold() in _PLAINTEXT_MODEL_HOSTS
    endpoint_scope = str(
        raw.get("endpoint_scope")
        or (
            "local"
            if loopback
            else "private"
            if bool(raw.get("allow_private_network", False))
            else "remote"
        )
    ).strip().casefold()
    if endpoint_scope not in {"local", "private", "remote"}:
        raise ValueError(
            f"external gateway {label!r} endpoint_scope must be local, private, or remote"
        )
    if endpoint_scope == "local" and not loopback:
        raise ValueError(
            f"external gateway {label!r} cannot mark a non-loopback endpoint as local"
        )
    preset = {key: value for key, value in raw.items() if key in _EXTERNAL_GATEWAY_ALLOWED_FIELDS}
    preset.update({
        "kind": kind,
        "base_url": base_url,
        "model": model,
        "external_gateway": True,
        "optional": True,
        "allow_private_network": bool(raw.get("allow_private_network", False)),
        "endpoint_scope": endpoint_scope,
        # A custom endpoint is an explicit authority boundary. Never borrow a
        # credential from a native provider or silently cross to a fallback.
        "strict_key_source": bool(raw.get("strict_key_source", True)),
        "allow_fallbacks": bool(raw.get("allow_fallbacks", False)),
    })
    # A default credential is acceptable only for a loopback/local gateway and
    # is treated as a dummy token. Remote gateways must use an env-var name.
    if (
        preset.get("api_key_default")
        and not loopback
        and not preset["allow_private_network"]
    ):
        raise ValueError(
            f"external gateway {label!r} cannot embed api_key_default for a remote endpoint"
        )
    return preset


def register_external_gateway(
    name: str,
    *,
    base_url: str,
    model: str,
    kind: str = "openai",
    api_key_env: str | None = None,
    api_key_default: str | None = None,
    context_window: int | None = None,
    max_tokens: int | None = None,
    timeout_sec: int | None = None,
    strict_key_source: bool = True,
    allow_fallbacks: bool = False,
    allow_private_network: bool = False,
    endpoint_scope: str | None = None,
) -> None:
    """Register an optional OpenAI/Anthropic-compatible gateway for this process.

    An environment-variable *name* is preferred. ``api_key_default`` exists
    only for an OS-keyring value injected into this process; it is never
    serialized, logged, or returned by the public gateway manifest.
    Registration never probes or contacts the URL.
    """
    raw: dict[str, Any] = {
        "kind": kind,
        "base_url": base_url,
        "model": model,
    }
    if api_key_env:
        raw["api_key_env"] = api_key_env
    if api_key_default:
        raw["api_key_default"] = api_key_default
    if context_window is not None:
        raw["context_window"] = int(context_window)
    if max_tokens is not None:
        raw["max_tokens"] = int(max_tokens)
    if timeout_sec is not None:
        raw["timeout_sec"] = int(timeout_sec)
    raw["strict_key_source"] = bool(strict_key_source)
    raw["allow_fallbacks"] = bool(allow_fallbacks)
    raw["allow_private_network"] = bool(allow_private_network)
    if endpoint_scope is not None:
        raw["endpoint_scope"] = endpoint_scope
    _REGISTERED_EXTERNAL_GATEWAYS[name.strip().lower()] = _normalize_external_gateway(name, raw)


def clear_registered_external_gateways() -> None:
    """Clear process-local gateway registrations (primarily for isolated tests)."""
    _REGISTERED_EXTERNAL_GATEWAYS.clear()


def external_gateway_presets() -> dict[str, dict[str, Any]]:
    """Return validated optional gateways from registration + environment.

    ``SOPHIA_EXTERNAL_GATEWAYS`` is a JSON object keyed by provider alias. Each
    value names ``base_url``, ``model``, and optionally ``api_key_env``/``kind``.
    Invalid entries fail closed by being omitted; no secret values are surfaced.
    """
    out = {name: dict(preset) for name, preset in _REGISTERED_EXTERNAL_GATEWAYS.items()}
    raw = (os.environ.get("SOPHIA_EXTERNAL_GATEWAYS") or "").strip()
    if not raw:
        return out
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return out
    if not isinstance(data, dict):
        return out
    for name, value in data.items():
        if not isinstance(name, str) or not isinstance(value, dict):
            continue
        try:
            out[name.strip().lower()] = _normalize_external_gateway(name, value)
        except (TypeError, ValueError):
            continue
    return out


def external_gateway_public_presets() -> dict[str, dict[str, Any]]:
    """Return gateway metadata with every credential value removed."""
    return {
        name: {
            key: value
            for key, value in preset.items()
            if key != "api_key_default"
        }
        for name, preset in external_gateway_presets().items()
    }


def credential_env_names() -> frozenset[str]:
    """Environment variable names that may carry provider credentials."""
    presets = [*PRESETS.values(), *external_gateway_presets().values()]
    explicit = {
        str(preset["api_key_env"])
        for preset in presets
        if preset.get("api_key_env")
    }
    return frozenset({*explicit, "ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_AUTH_TOKEN"})


def available_provider_names() -> tuple[str, ...]:
    """All built-in and configured provider aliases, sorted for stable UIs."""
    return tuple(sorted({*PRESETS, *external_gateway_presets()}))


# Coarse model-family markers for anti-circularity accounting (teacher != student family,
# >=2 distinct teacher families for a real distillation run). Matched against the resolved
# model id (vendor prefix first, then whole id), lowercased. Order matters only in that the
# first matching marker wins; markers are mutually exclusive on real ids seen in the tree.
_TEACHER_FAMILY_MARKERS: tuple[tuple[str, str], ...] = (
    ("glm", "glm"),
    ("deepseek", "deepseek"),
    ("qwen", "qwen"),
    ("llama", "llama"),
    ("mistral", "mistral"),
    ("gemini", "google"),
    ("claude", "anthropic"),
    ("gpt", "openai"),
    ("mock", "mock"),
)


def teacher_family(spec: str | None) -> str:
    """Coarse family of the model a spec resolves to, for anti-circularity accounting.

    Returns e.g. "glm" / "deepseek" / "qwen" / "mock". Falls back to the provider name
    when the provider IS a single-vendor endpoint, and to "unknown" when the family
    cannot be determined (e.g. a local server with model id "local"). "unknown" must
    never be counted as a distinct family — fail closed on ambiguity.
    """
    cfg = resolve_config(spec)
    name = (cfg.model or "").lower()
    vendor = name.split("/", 1)[0] if "/" in name else ""
    for marker, family in _TEACHER_FAMILY_MARKERS:
        if (vendor and marker in vendor) or marker in name:
            return family
    if cfg.label in {"glm", "deepseek", "qwen", "anthropic", "openai", "mock"}:
        return cfg.label
    return "unknown"

TRANSIENT_HTTP = {408, 409, 425, 429, 500, 502, 503, 504}
_MAX_RETRY_AFTER_SEC = 300.0


def _parse_retry_after(value: Any, *, now: datetime | None = None) -> float | None:
    """Parse an HTTP Retry-After value into a bounded delay.

    RFC 9110 permits either non-negative delta-seconds or an HTTP-date. Only
    the derived numeric delay is retained; the raw header is never copied into
    provider errors, logs, or receipts.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.isascii() and text.isdecimal():
        return min(float(text), _MAX_RETRY_AFTER_SEC)
    try:
        target = parsedate_to_datetime(text)
    except (TypeError, ValueError, OverflowError):
        return None
    if target is None:
        return None
    if target.tzinfo is None:
        target = target.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    delay = max(0.0, (target - current).total_seconds())
    return min(delay, _MAX_RETRY_AFTER_SEC)


class ProviderErrorCode(str, Enum):
    """Stable provider failure categories for UI, fallback, and telemetry."""

    CONFIGURATION = "configuration"
    MISSING_CREDENTIALS = "missing_credentials"
    AUTHENTICATION = "authentication"
    AUTHORIZATION = "authorization"
    RATE_LIMIT = "rate_limit"
    QUOTA = "quota"
    TIMEOUT = "timeout"
    CONNECTION = "connection"
    ENDPOINT_UNAVAILABLE = "endpoint_unavailable"
    MODEL_NOT_FOUND = "model_not_found"
    CAPABILITY_UNSUPPORTED = "capability_unsupported"
    EMPTY_RESPONSE = "empty_response"
    # A tool_call the model attempted but never gave a function name -- distinct
    # from EMPTY_RESPONSE (which means no text AND no tool-call attempt at all).
    # Small local models emit this under load; see ModelResult.malformed_tool_call.
    MALFORMED_TOOL_CALL = "malformed_tool_call"
    FALLBACK_CONFIRMATION_REQUIRED = "fallback_confirmation_required"
    CANCELLED = "cancelled"
    CONTENT_FILTER = "content_filter"
    TRANSPORT = "transport"
    UNKNOWN = "unknown"


# Compatibility-friendly names for callers that prefer "kind" or "type".
ProviderErrorKind = ProviderErrorCode
ProviderErrorType = ProviderErrorCode


_SECRET_TEXT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[^\s,;]+"),
    re.compile(r"(?i)\b(sk-[a-z0-9_-]{8,})\b"),
    re.compile(r"(?i)(api[_-]?key|token|secret)(\s*[=:]\s*)[^\s,;]+"),
    re.compile(
        r"""(?i)(["']?(?:api[_-]?key|token|secret|password)["']?)"""
        r"""(\s*:\s*["']?)[^"'\s,;}]+"""
    ),
)


def _redact_error_text(value: Any, *, environ: Mapping[str, str] | None = None) -> str:
    """Redact credentials from provider errors before they reach logs or UIs."""
    text = "" if value is None else str(value)
    env = os.environ if environ is None else environ
    credential_names = credential_env_names()
    # Replace known secret values first. Length >= 8 avoids redacting harmless
    # dummy local keys such as "1234" and common short words.
    for name, secret in env.items():
        if not (
            name.endswith("_API_KEY")
            or name.endswith("_TOKEN")
            or name in {"ANTHROPIC_AUTH_TOKEN", "SOPHIA_020S_KEY"}
            or name in credential_names
        ):
            continue
        if len(secret or "") >= 8:
            text = text.replace(secret, "[REDACTED]")
    for pattern in _SECRET_TEXT_PATTERNS:
        if pattern.groups >= 2:
            text = pattern.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", text)
        else:
            text = pattern.sub("[REDACTED]", text)
    return text[:4000]


@dataclass
class ProviderError(Exception):
    """Typed, redacted provider failure.

    ``message`` is safe for logs/UI. The underlying exception object and secret
    values are intentionally not retained.
    """

    code: ProviderErrorCode
    message: str
    provider: str = ""
    model: str = ""
    retryable: bool = False
    http_status: int | None = None
    cause_type: str | None = None
    retry_after_sec: float | None = None

    def __post_init__(self) -> None:
        self.message = _redact_error_text(self.message)
        Exception.__init__(self, self.message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code.value,
            "message": self.message,
            "provider": self.provider,
            "model": self.model,
            "retryable": self.retryable,
            "httpStatus": self.http_status,
            "causeType": self.cause_type,
            "retryAfterSec": self.retry_after_sec,
        }


def classify_provider_error(
    error: Any,
    *,
    provider: str = "",
    model: str = "",
    http_status: int | None = None,
    retry_after_sec: float | None = None,
) -> ProviderError:
    """Classify arbitrary transport text/exception into a stable safe taxonomy."""
    if isinstance(error, ProviderError):
        return error
    cause_type = type(error).__name__ if isinstance(error, BaseException) else None
    text = _redact_error_text(error)
    lowered = text.casefold()
    status = http_status
    if status is None:
        match = re.search(r"\bHTTP\s+(\d{3})\b", text, re.IGNORECASE)
        if match is None:
            match = re.search(r"\bUnauthorized\s*\((401)\)", text, re.IGNORECASE)
        if match:
            status = int(match.group(1))

    if "fallback confirmation" in lowered or "confirmation required" in lowered:
        code = ProviderErrorCode.FALLBACK_CONFIRMATION_REQUIRED
    elif "api key" in lowered and any(word in lowered for word in ("missing", "required", "set ")):
        code = ProviderErrorCode.MISSING_CREDENTIALS
    elif status == 401 or any(
        word in lowered
        for word in (
            "invalid_api_key",
            "unauthenticated",
            "not authenticated",
            "authentication required",
        )
    ):
        code = ProviderErrorCode.AUTHENTICATION
    elif status == 403 or "forbidden" in lowered or "permission denied" in lowered:
        code = ProviderErrorCode.AUTHORIZATION
    elif status == 429 and any(word in lowered for word in ("quota", "balance", "billing", "credit")):
        code = ProviderErrorCode.QUOTA
    elif status == 429 or "rate limit" in lowered:
        code = ProviderErrorCode.RATE_LIMIT
    elif "unknown model provider" in lowered or "invalid provider configuration" in lowered:
        code = ProviderErrorCode.CONFIGURATION
    elif status == 404 and "model" in lowered:
        code = ProviderErrorCode.MODEL_NOT_FOUND
    elif "model not found" in lowered or "unknown model" in lowered:
        code = ProviderErrorCode.MODEL_NOT_FOUND
    elif "malformed tool call" in lowered:
        code = ProviderErrorCode.MALFORMED_TOOL_CALL
    elif "empty terminal model response" in lowered or "empty response" in lowered:
        code = ProviderErrorCode.EMPTY_RESPONSE
    elif "timed out" in lowered or "timeout" in lowered:
        code = ProviderErrorCode.TIMEOUT
    elif any(marker in lowered for marker in (
        "connection", "broken pipe", "remotedisconnected", "remote end closed",
        "name or service not known", "nodename nor servname",
    )):
        code = ProviderErrorCode.CONNECTION
    elif any(marker in lowered for marker in (
        "overloaded",
        "over capacity",
        "overcapacity",
        "temporarily unavailable",
        "temporary failure",
        "internal server error",
        "server error",
        "service unavailable",
        "upstream error",
        "try again later",
        "server_error",
        "internal_error",
    )):
        # Some OpenAI-compatible gateways return these only in a streamed
        # ``event: error`` payload with HTTP 200.  They are provider-side
        # availability failures, not malformed protocol shapes.
        code = ProviderErrorCode.ENDPOINT_UNAVAILABLE
    elif status is not None and status >= 500:
        code = ProviderErrorCode.ENDPOINT_UNAVAILABLE
    elif "not supported" in lowered or "unsupported" in lowered:
        code = ProviderErrorCode.CAPABILITY_UNSUPPORTED
    elif "cancel" in lowered:
        code = ProviderErrorCode.CANCELLED
    elif any(word in lowered for word in ("content filter", "safety filter", "blocked by safety")):
        code = ProviderErrorCode.CONTENT_FILTER
    elif any(word in lowered for word in ("missing", "invalid configuration")):
        code = ProviderErrorCode.CONFIGURATION
    elif text:
        code = ProviderErrorCode.TRANSPORT
    else:
        code = ProviderErrorCode.UNKNOWN
    retryable_codes = {
        ProviderErrorCode.RATE_LIMIT,
        ProviderErrorCode.TIMEOUT,
        ProviderErrorCode.CONNECTION,
        ProviderErrorCode.ENDPOINT_UNAVAILABLE,
        ProviderErrorCode.EMPTY_RESPONSE,
    }
    retryable = code in retryable_codes or (
        status in TRANSIENT_HTTP
        and code not in {
            ProviderErrorCode.QUOTA,
            ProviderErrorCode.AUTHENTICATION,
            ProviderErrorCode.AUTHORIZATION,
        }
    )
    return ProviderError(
        code=code,
        message=text or "unknown provider failure",
        provider=provider,
        model=model,
        retryable=retryable,
        http_status=status,
        cause_type=cause_type,
        retry_after_sec=retry_after_sec,
    )


class FallbackMode(str, Enum):
    NEVER = "never"
    CONFIRM = "confirm"
    AUTOMATIC = "automatic"


@dataclass(frozen=True)
class FallbackAuthorityDescriptor:
    """Safe, operator-visible identity for one fallback endpoint.

    Credential metadata names only the source used to obtain a credential. It
    must never contain a resolved key or an ``api_key_default`` value.
    """

    endpoint_scheme: str | None = None
    endpoint_host: str | None = None
    endpoint_port: int | None = None
    transport_kind: str | None = None
    credential_source_name: str | None = None
    credential_source_type: str | None = None
    vendor_identity: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "endpoint": {
                "scheme": self.endpoint_scheme,
                "host": self.endpoint_host,
                "port": self.endpoint_port,
            },
            "transportKind": self.transport_kind,
            "credentialSource": {
                "name": self.credential_source_name,
                "type": self.credential_source_type,
            },
            "vendorIdentity": self.vendor_identity,
        }


@dataclass(frozen=True)
class FallbackRequest:
    primary_provider: str
    primary_model: str
    fallback_provider: str
    fallback_model: str
    reason: ProviderError
    primary_authority: FallbackAuthorityDescriptor | None = None
    fallback_authority: FallbackAuthorityDescriptor | None = None
    authority_changes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "primaryProvider": self.primary_provider,
            "primaryModel": self.primary_model,
            "fallbackProvider": self.fallback_provider,
            "fallbackModel": self.fallback_model,
            "primaryAuthority": (
                self.primary_authority.to_dict() if self.primary_authority is not None else None
            ),
            "fallbackAuthority": (
                self.fallback_authority.to_dict() if self.fallback_authority is not None else None
            ),
            "authorityChanges": list(self.authority_changes),
            "reason": self.reason.to_dict(),
        }


@dataclass(frozen=True)
class FallbackPolicy:
    """Cross-provider fallback defaults to explicit operator confirmation."""

    mode: FallbackMode = FallbackMode.CONFIRM
    allow_same_provider: bool = True

    @classmethod
    def from_value(cls, value: "FallbackPolicy | FallbackMode | str | None") -> "FallbackPolicy":
        if isinstance(value, cls):
            return value
        if isinstance(value, FallbackMode):
            return cls(mode=value)
        normalized = str(value or "confirm").strip().lower().replace("_", "-")
        aliases = {
            "off": FallbackMode.NEVER,
            "none": FallbackMode.NEVER,
            "never": FallbackMode.NEVER,
            "confirm": FallbackMode.CONFIRM,
            "ask": FallbackMode.CONFIRM,
            "manual": FallbackMode.CONFIRM,
            "auto": FallbackMode.AUTOMATIC,
            "automatic": FallbackMode.AUTOMATIC,
            "always": FallbackMode.AUTOMATIC,
        }
        if normalized not in aliases:
            raise ValueError("fallback policy must be never, confirm, or automatic")
        return cls(mode=aliases[normalized])


def fallback_policy_from_env() -> FallbackPolicy:
    raw = (
        os.environ.get("SOPHIA_MODEL_FALLBACK_POLICY")
        or os.environ.get("SOPHIA_FALLBACK_POLICY")
        or "confirm"
    )
    try:
        return FallbackPolicy.from_value(raw)
    except ValueError:
        return FallbackPolicy()


@dataclass
class ModelConfig:
    """Resolved configuration for one model endpoint."""

    kind: str  # anthropic | openai | grok | openclaw | mlx | mock | pi-ai
    model: str
    label: str = ""
    base_url: str | None = None
    api_key_env: str | None = None
    api_key_default: str | None = None  # for local servers that need a dummy key
    adapter_path: str | None = None  # local LoRA adapter dir (mlx transport)
    #: Total INPUT+OUTPUT window the endpoint accepts, in tokens. Distinct from
    #: ``max_tokens``, which caps generation only. ``None`` means unknown, and
    #: callers must fall back to a conservative default rather than guess — an
    #: over-estimate silently truncates at the provider, which looks like the
    #: model forgetting rather than like a configuration error.
    context_window: int | None = None
    max_tokens: int = 2400
    temperature: float = 0.2
    top_p: float | None = None
    top_k: int | None = None
    reasoning_effort: str | None = None  # low | medium | high (provider-dependent)
    worker_model: str | None = None
    worker_all_efforts: bool = False
    timeout_sec: int = 120
    seed: int | None = None  # sampling seed (passed through to OpenAI-compatible servers, e.g. Ollama)
    # Provider-default tool selection sent only when a non-empty tools schema is
    # present. None preserves the existing OpenAI-compatible request shape.
    tool_choice: Any | None = None
    # Some compatible endpoints (DS4/Pulsar) require a native assistant
    # tool_calls turn and bound role=tool messages on continuation. Generic
    # providers keep Sophia's historical provider-agnostic text transcript.
    requires_native_tool_transcript: bool = False
    external_gateway: bool = False
    endpoint_scope: str | None = None
    optional: bool = False
    strict_key_source: bool = False
    allow_fallbacks: bool = True
    # Explicit root for delegated CLI transports. Relative paths are resolved
    # from the Sophia repository root, never from an ambient process cwd.
    working_dir: str | None = None

    def resolved_key(self) -> str | None:
        if self.kind == "anthropic":
            # An explicit credential source is an authority boundary. Never
            # borrow a native Anthropic key for a compatible third-party host.
            if self.api_key_env:
                value = (os.environ.get(self.api_key_env) or "").strip()
                if is_real_secret(value):
                    _validate_credential_endpoint(self, value)
                    return value
                if self.strict_key_source:
                    return self.api_key_default
            value = anthropic_api_key() or self.api_key_default
            _validate_credential_endpoint(self, value)
            return value
        if self.api_key_env:
            value = (os.environ.get(self.api_key_env) or "").strip()
            if is_real_secret(value):
                _validate_credential_endpoint(self, value)
                return value
        value = self.api_key_default
        _validate_credential_endpoint(self, value)
        return value


class _NoModelRedirect(urllib.request.HTTPRedirectHandler):
    """Do not move credentials or requests to a second authority."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _validate_custom_gateway_destination(cfg: ModelConfig) -> None:
    """Re-resolve a custom endpoint immediately before each network request.

    Profile validation and the setup smoke establish operator intent. This
    request-time check narrows the DNS-rebinding window and preserves that same
    local/private/remote authority when a saved profile is used later.
    """
    if not cfg.endpoint_scope or not cfg.base_url:
        return
    from agent.provider_profiles import validate_runtime_endpoint_authority

    validate_runtime_endpoint_authority(
        cfg.base_url,
        expected_scope=cfg.endpoint_scope,
    )


def _urlopen_model_request(
    request: urllib.request.Request,
    cfg: ModelConfig,
):
    """Open a model request under the custom profile's explicit authority."""
    if not cfg.endpoint_scope:
        return urllib.request.urlopen(request, timeout=cfg.timeout_sec)
    _validate_custom_gateway_destination(cfg)
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _NoModelRedirect(),
    )
    return opener.open(request, timeout=cfg.timeout_sec)


def _validate_credential_endpoint(cfg: ModelConfig, credential: str | None) -> None:
    """Reject plaintext off-loopback egress only when a credential would be sent."""
    if not credential or not cfg.base_url or cfg.kind not in {
        "openai", "openai-responses", "anthropic",
    }:
        return
    _validate_model_base_url(cfg.base_url, label=cfg.label or cfg.kind)


@dataclass
class Attempt:
    provider: str
    model: str
    ok: bool
    latency_sec: float
    error: str | None = None
    error_type: str | None = None


@dataclass
class ModelResult:
    text: str
    provider: str
    model: str
    ok: bool = True
    error: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_tokens: int = 0
    cost_usd: float = 0.0
    latency_sec: float = 0.0
    finish_reason: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    fallback_used: bool = False
    attempts: list[Attempt] = field(default_factory=list)
    raw: dict[str, Any] | None = None
    error_info: ProviderError | None = None
    # The model's own reasoning / "thinking" tokens, when the provider surfaces them
    # (Claude extended/adaptive thinking, DeepSeek/GLM ``reasoning_content``, ``<think>``
    # tags). Empty unless capture is enabled (see agent.thinking_trace). This is the LLM's
    # stated reasoning, NOT a faithful record of its actual decision cause — treat it as
    # evidence to be probed (agent.faithfulness_probe), never as ground truth.
    reasoning_text: str = ""
    reasoning_tokens: int = 0
    # Wall-clock seconds from "the transport started consuming the stream" to
    # "the first generated chunk (content, reasoning, or tool-call delta)
    # arrived", set only by the two streaming transports (_consume_stream,
    # _mlx_generate). None on every non-streaming call and on a streaming call
    # that produced nothing. This is deliberately NOT the same number as
    # latency_sec: for a local model that just cold-loaded weights, latency_sec
    # is dominated by the one-time load while this stays small once generation
    # itself starts -- without both numbers side by side a slow-loading model
    # and a slow-generating model are indistinguishable to the user watching
    # the status line.
    time_to_first_token_sec: float | None = None
    # True when the response's tool_calls contained at least one attempt with
    # an empty/blank function.name -- a malformed call small local models emit
    # under load (see _normalize_result). Kept distinct from "the model made
    # no tool calls at all": a caller that only checks `bool(tool_calls)` would
    # otherwise read a broken call the exact same way as a deliberate refusal
    # to use tools, which sends the operator down the wrong fix.
    malformed_tool_call: bool = False
    # True only for endpoints whose next request must contain the provider's
    # native assistant tool-call turn plus role=tool results. The loop reads
    # this transport capability without applying it to generic providers.
    requires_native_tool_transcript: bool = False
    # Wire-only reasoning needed to continue a DS4 tool turn. This is populated
    # only when a provider requiring native tool transcripts returned tool calls,
    # is never included by to_log(), and is kept separate from reasoning_text so
    # normal thinking capture/visibility remains explicitly opt-in.
    continuation_reasoning_content: str = field(default="", repr=False, compare=False)

    def to_log(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "ok": self.ok,
            "error": _redact_error_text(self.error) if self.error else None,
            "errorType": self.error_info.code.value if self.error_info else None,
            "errorInfo": self.error_info.to_dict() if self.error_info else None,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "cacheTokens": self.cache_tokens,
            "reasoningTokens": self.reasoning_tokens,
            # The harness decision log keeps only the SIZE of the reasoning, not the text:
            # the verbatim reasoning is large and may be sensitive, so it goes to the
            # dedicated, opt-in thinking trace (agent.thinking_trace), never here.
            "reasoningChars": len(self.reasoning_text),
            "hasReasoning": bool(self.reasoning_text),
            "costUsd": round(self.cost_usd, 6),
            "latencySec": round(self.latency_sec, 3),
            "timeToFirstTokenSec": (
                round(self.time_to_first_token_sec, 3) if self.time_to_first_token_sec is not None else None
            ),
            "finishReason": self.finish_reason,
            "toolCalls": self.tool_calls,
            "malformedToolCall": self.malformed_tool_call,
            "fallbackUsed": self.fallback_used,
            "attempts": [
                {
                    **a.__dict__,
                    "error": _redact_error_text(a.error) if a.error else None,
                }
                for a in self.attempts
            ],
        }


def _prices() -> dict[str, tuple[float, float]]:
    override = os.environ.get("SOPHIA_MODEL_PRICES")
    if not override:
        return DEFAULT_PRICES
    try:
        data = json.loads(override)
        merged = dict(DEFAULT_PRICES)
        for key, value in data.items():
            if isinstance(value, (list, tuple)) and len(value) == 2:
                merged[key] = (float(value[0]), float(value[1]))
        return merged
    except (json.JSONDecodeError, TypeError, ValueError):
        return DEFAULT_PRICES


@dataclass(frozen=True)
class CostEstimate:
    usd: float
    known: bool
    input_per_million: float | None = None
    output_per_million: float | None = None
    matched_rule: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "usd": round(self.usd, 8),
            "known": self.known,
            "inputPerMillion": self.input_per_million,
            "outputPerMillion": self.output_per_million,
            "matchedRule": self.matched_rule,
        }


def estimate_cost_detail(model: str, prompt_tokens: int, completion_tokens: int) -> CostEstimate:
    """Typed cost estimate; unknown pricing is never represented as known-free."""
    lowered = model.lower()
    for key, (price_in, price_out) in sorted(_prices().items(), key=lambda kv: -len(kv[0])):
        if key in lowered:
            usd = prompt_tokens / 1e6 * price_in + completion_tokens / 1e6 * price_out
            return CostEstimate(
                usd=usd,
                known=True,
                input_per_million=price_in,
                output_per_million=price_out,
                matched_rule=key,
            )
    return CostEstimate(usd=0.0, known=False)


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> tuple[float, bool]:
    """Return (usd, known). known=False when no price entry matched the model."""
    detail = estimate_cost_detail(model, prompt_tokens, completion_tokens)
    return detail.usd, detail.known


def resolve_config(spec: str | None = None) -> ModelConfig:
    """Build a ModelConfig from a spec ("provider", "provider:model", or preset)
    or from the environment when spec is None."""
    load_dotenv()
    normalize_api_keys()
    if spec is None:
        spec = os.environ.get("SOPHIA_MODEL_PROVIDER") or os.environ.get("SOPHIA_DEFAULT_PROVIDER")
    if not spec:
        spec = _auto_provider()

    provider, _, model_override = spec.partition(":")
    provider = provider.strip().lower()
    # Per-spec base_url override: "provider:model@http://host/v1". Model IDs contain no
    # '@', so this is unambiguous; it lets two local judges hit two ports on one host, e.g.
    # "vllm:Qwen/..@http://localhost:8000/v1" and "vllm:meta-llama/..@http://localhost:8001/v1"
    # (a local judge farm on a DGX Spark). Most-specific: beats the preset AND SOPHIA_MODEL_BASE_URL.
    spec_base_url = None
    if "@" in model_override:
        model_override, _, spec_base_url = model_override.partition("@")
        spec_base_url = spec_base_url.strip() or None
    external = external_gateway_presets()
    preset = PRESETS.get(provider) or external.get(provider)
    if preset is None:
        raise ValueError(
            f"unknown model provider {provider!r}; valid: {', '.join(available_provider_names())}"
        )
    if provider in {"teamorouter", "aipro", "aipro-2"} and (
        spec_base_url is not None or os.environ.get("SOPHIA_MODEL_BASE_URL")
    ):
        raise ValueError(f"{provider} endpoint override is not permitted for the built-in credentialed preset")
    if preset.get("fixed_model") and model_override.strip():
        if model_override.strip() != str(preset["model"]):
            raise ValueError(f"{provider} model override is not permitted for this fixed preset")

    # Env overrides win; otherwise honor per-preset max_tokens/timeout when set
    # (local reasoning models like Qwen3.6-35B need larger budgets than the
    # global 2400/120 defaults or multi-tool batches truncate mid-slot).
    _preset_max = preset.get("max_tokens")
    _preset_timeout = preset.get("timeout_sec")
    # A transport that never sends cfg.model must not be RENAMED by the ambient
    # SOPHIA_MODEL. Fixed presets and the official Codex aliases are similarly
    # stable: ambient state must not silently turn ``codex``/``codex-api`` into
    # another model. An explicit ``provider:<model>`` spec remains authoritative.
    env_model = (
        None
        if (
            preset["kind"] in _MODEL_NAME_IGNORED_KINDS
            or preset.get("fixed_model")
            or preset["kind"] == "codex"
            or provider == "codex-api"
        )
        else os.environ.get("SOPHIA_MODEL")
    )
    resolved_model = model_override.strip() or env_model or preset["model"]
    if preset["kind"] == "codex":
        resolved_model = canonical_codex_model(resolved_model)
    if preset["kind"] == "grok":
        resolved_model = (
            canonical_grok_cli_model(resolved_model) or GROK_CLI_DEFAULT_MODEL
        )
    cfg = ModelConfig(
        kind=preset["kind"],
        model=resolved_model,
        label=provider,
        base_url=spec_base_url or os.environ.get("SOPHIA_MODEL_BASE_URL") or preset.get("base_url"),
        api_key_env=preset.get("api_key_env"),
        api_key_default=preset.get("api_key_default"),
        adapter_path=(os.environ.get("SOPHIA_MLX_ADAPTER") or None) if preset["kind"] == "mlx" else None,
        context_window=_resolve_context_window(preset),
        max_tokens=int(os.environ.get("SOPHIA_MAX_TOKENS") or _preset_max or 2400),
        temperature=float(os.environ.get("SOPHIA_TEMPERATURE", "0.2")),
        top_p=(float(os.environ["SOPHIA_TOP_P"]) if os.environ.get("SOPHIA_TOP_P") else None),
        top_k=(int(os.environ["SOPHIA_TOP_K"]) if os.environ.get("SOPHIA_TOP_K") else None),
        reasoning_effort=os.environ.get("SOPHIA_REASONING_EFFORT") or preset.get("reasoning_effort") or None,
        worker_model=preset.get("worker_model"),
        worker_all_efforts=bool(preset.get("worker_all_efforts")),
        timeout_sec=int(os.environ.get("SOPHIA_TIMEOUT_SEC") or _preset_timeout or 120),
        tool_choice=preset.get("tool_choice"),
        requires_native_tool_transcript=bool(
            preset.get("requires_native_tool_transcript")
            or preset["kind"] == "openai-responses"
        ),
        external_gateway=bool(preset.get("external_gateway")),
        endpoint_scope=(
            str(preset.get("endpoint_scope"))
            if preset.get("endpoint_scope")
            else None
        ),
        optional=bool(preset.get("optional")),
        strict_key_source=bool(preset.get("strict_key_source")),
        allow_fallbacks=bool(preset.get("allow_fallbacks", True)),
        working_dir=os.environ.get("SOPHIA_MODEL_WORKING_DIR") or None,
    )
    if cfg.kind == "anthropic" and not cfg.base_url:
        cfg.base_url = anthropic_base_url()
    return cfg


def resolve_worker_config(spec: str) -> ModelConfig:
    """Resolve an internal worker while preserving its coordinator's authority."""
    primary = resolve_config(spec)
    if not primary.worker_model:
        raise ValueError(f"model provider {primary.label!r} has no worker model")
    return replace(
        primary,
        model=primary.worker_model,
        worker_model=None,
        worker_all_efforts=False,
        allow_fallbacks=False,
    )


def _auto_provider() -> str:
    configured = (os.environ.get("SOPHIA_DEFAULT_PROVIDER") or "").strip()
    if configured:
        provider = configured.partition(":")[0].strip().lower()
        if provider in available_provider_names():
            return configured
    profile_name = (
        os.environ.get("SOPHIA_PROVIDER_PROFILE")
        or os.environ.get("SOPHIA_RUNTIME_PROFILE")
        or ""
    ).strip()
    if profile_name:
        try:
            from agent.runtime_config import provider_profile

            return provider_profile(profile_name).default_provider
        except (ImportError, ValueError):
            pass
    if anthropic_api_key():
        return "anthropic"
    if os.environ.get("SOPHIA_MODEL_BASE_URL"):
        return "openai"
    try:
        from agent.runtime_config import direct_credential_provider

        direct = direct_credential_provider()
        if direct:
            return direct
    except ImportError:
        # Runtime discovery is optional in minimal installations; continue to
        # local-engine discovery when that support module is unavailable.
        pass
    # Public local-engine discovery is intentionally after directly configured
    # credentials and excludes optional loopback gateways (:8788/:8789).
    try:
        from agent.runtime_config import detect_local_provider

        local = detect_local_provider()
        if local:
            return local
    except Exception:  # noqa: BLE001 - auto-detection must fail closed
        pass
    if (Path.home() / ".grok" / "auth.json").exists():
        return "grok"
    return "mock"


# --------------------------------------------------------------------------- #
# Provider transports
# --------------------------------------------------------------------------- #


def _call_mock(system: str, user: str, cfg: ModelConfig, *, on_token: Callable[[str], None] | None,
               messages: list[dict] | None = None, **_: Any) -> ModelResult:
    """Deterministic offline provider for tests and dry runs.

    Honors SOPHIA_MOCK_RESPONSE / a {"mockResponse": ...} hint embedded in the
    user prompt; otherwise echoes a structured, gate-friendly answer. When a
    ``messages`` list is supplied, the LAST user turn is echoed so multi-turn
    plumbing is offline-testable.
    """
    if messages:
        users = [str(m.get("content") or "") for m in messages if m.get("role") == "user"]
        user = users[-1] if users else user
    forced = os.environ.get("SOPHIA_MOCK_RESPONSE")
    delay_raw = os.environ.get("SOPHIA_MOCK_DELAY_SEC", "0").strip()
    try:
        delay = max(0.0, min(30.0, float(delay_raw)))
    except ValueError:
        delay = 0.0
    if delay:
        # Deterministic, opt-in test fixture: short slices make cancellation
        # observable without changing the normal mock provider latency.
        deadline = time.monotonic() + delay
        while time.monotonic() < deadline:
            time.sleep(min(0.02, deadline - time.monotonic()))
    if forced is not None:
        text = forced
    else:
        head = user.strip().splitlines()[0][:200] if user.strip() else "(empty)"
        text = (
            f"[mock:{cfg.model}] Analysis of: {head}\n"
            "Decision: proceed (mock). source discipline noted.\n"
            "中文摘要: 模拟回答。"
        )
    if on_token:
        for token in text.split(" "):
            on_token(token + " ")
    pt, ct = max(1, len(user) // 4), max(1, len(text) // 4)
    return ModelResult(text=text, provider="mock", model=cfg.model, prompt_tokens=pt, completion_tokens=ct, finish_reason="stop")


def capture_thinking_enabled() -> bool:
    """Reasoning capture is opt-in: it enables extended/adaptive thinking on Claude and
    surfaces reasoning_content/<think> on OpenAI-compatible servers. Off by default so
    behaviour and cost are unchanged unless a run asks to log the thinking steps."""
    return (os.environ.get("SOPHIA_CAPTURE_THINKING") or "").strip().lower() in {"1", "true", "yes", "on"}


_THINK_PAIR_RE = re.compile(r"<think>(.*?)</think>", re.DOTALL | re.I)
_THINK_OPEN_RE = re.compile(r"<think>", re.I)
_THINK_CLOSE_RE = re.compile(r"</think>", re.I)
# A tag the model is TALKING ABOUT rather than emitting is normally quoted or
# fenced. Treating such a mention as a delimiter would silently truncate a
# legitimate answer, so quoted occurrences are left alone.
_QUOTING_CHARS = "`'\"“”‘’"


def _is_quoted(text: str, start: int, end: int) -> bool:
    before = text[start - 1] if start > 0 else ""
    after = text[end] if end < len(text) else ""
    return before in _QUOTING_CHARS and after in _QUOTING_CHARS


def split_think_blocks(content: str) -> tuple[str, list[str]]:
    """Split inline chain-of-thought out of a completion.

    Returns ``(answer_text, reasoning_blocks)``. Reasoning must never reach the
    user-facing answer, so this strips regardless of the capture setting; the
    caller decides whether to RETAIN the blocks in ``reasoning_text``.

    Handles the unbalanced forms real reasoning models emit, not just matched
    pairs. Qwen3.6's chat template pre-opens the think block, so the model's
    output starts mid-reasoning and carries only a CLOSING tag — measured
    2026-07-25, an MLX run returned "The user wants me to reply...</think>\\n\\nOK"
    and the whole monologue was delivered as the answer.
    """
    text = content or ""
    blocks: list[str] = []

    def _take_pair(match: "re.Match[str]") -> str:
        blocks.append(match.group(1).strip())
        return ""

    text = _THINK_PAIR_RE.sub(_take_pair, text)
    # Template pre-opened the block: everything before the first orphan close tag.
    close = _THINK_CLOSE_RE.search(text)
    if close and not _THINK_OPEN_RE.search(text[: close.start()]) and not _is_quoted(text, close.start(), close.end()):
        blocks.append(text[: close.start()].strip())
        text = text[close.end():]
    # Generation stopped inside an open block: everything after it is reasoning.
    open_tag = _THINK_OPEN_RE.search(text)
    if (open_tag and not _THINK_CLOSE_RE.search(text[open_tag.end():])
            and not _is_quoted(text, open_tag.start(), open_tag.end())):
        blocks.append(text[open_tag.end():].strip())
        text = text[: open_tag.start()]
    return text.strip(), [b for b in blocks if b]


def _anthropic_thinking_param(cfg: ModelConfig) -> dict[str, Any] | None:
    """The right ``thinking`` shape for Claude, by model family (see the claude-api skill):

    - Claude 4.6+ (sonnet-4-6, opus-4-6/4-7/4-8, fable): adaptive thinking. ``budget_tokens``
      is rejected (400) on 4.7/4.8 and deprecated on 4.6, so we never send it there.
    - Older Claude (sonnet-4-5 and earlier): the legacy enabled+budget_tokens form, with
      budget strictly < max_tokens.

    ``display: "summarized"`` is required to get readable reasoning text back — the default
    is "omitted" (empty thinking blocks) on the newer models. Returns None when capture is
    off or the model can't accommodate thinking."""
    if not capture_thinking_enabled():
        return None
    name = cfg.model.lower()
    adaptive = any(
        tag in name
        for tag in ("-4-6", "-4-7", "-4-8", "opus-5", "sonnet-5", "fable", "mythos")
    ) or "sonnet-4-6" in name
    if adaptive:
        return {"type": "adaptive", "display": "summarized"}
    # Legacy budgeted thinking: the API requires 1024 <= budget_tokens < max_tokens. Only
    # enable when both can hold; otherwise omit thinking rather than send an invalid budget.
    budget = max(1024, min(2048, cfg.max_tokens - 100))
    if budget < cfg.max_tokens:
        return {"type": "enabled", "budget_tokens": budget}
    return None


def _anthropic_messages(system: str, user: str, messages: list[dict] | None) -> tuple[str, list[dict]]:
    """Convert an OpenAI-style message list to the Anthropic (system, messages) shape.
    System turns concatenate into the system string; only user/assistant turns are
    forwarded (tool turns are flattened into user text — honest lossy fallback until a
    native tool-result mapping is needed)."""
    if not messages:
        return system, [{"role": "user", "content": user}]
    system_parts = [str(m.get("content") or "") for m in messages if m.get("role") == "system"]
    turns: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role in ("user", "assistant"):
            turns.append({"role": role, "content": str(m.get("content") or "")})
        elif role == "tool":
            turns.append({"role": "user", "content": f"[tool result] {m.get('content') or ''}"})
    if not turns:
        turns = [{"role": "user", "content": user}]
    return ("\n\n".join(p for p in system_parts if p) or system), turns


def _as_anthropic_tools(tools: list[dict] | None) -> list[dict] | None:
    """Normalize OpenAI-style function schemas to Anthropic tool schemas."""
    if not tools:
        return None
    normalized: list[dict] = []
    for tool in tools:
        if "name" in tool and "input_schema" in tool:
            normalized.append(tool)
            continue
        fn = tool.get("function") if isinstance(tool, dict) else None
        if isinstance(fn, dict) and fn.get("name"):
            normalized.append({
                "name": fn["name"],
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
            })
    return normalized or None


def _as_openai_tools(tools: list[dict] | None) -> list[dict] | None:
    """Normalize Anthropic/simple tool schemas to OpenAI function schemas."""
    if not tools:
        return None
    normalized: list[dict] = []
    for tool in tools:
        if tool.get("type") == "function" and isinstance(tool.get("function"), dict):
            normalized.append(tool)
            continue
        if tool.get("name"):
            normalized.append({
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
                },
            })
    return normalized or None


def _as_openai_responses_tools(tools: list[dict] | None) -> list[dict] | None:
    """Normalize Sophia tools to the flat OpenAI Responses function shape."""
    chat_tools = _as_openai_tools(tools)
    if not chat_tools:
        return None
    normalized: list[dict[str, Any]] = []
    for tool in chat_tools:
        function = tool.get("function")
        if not isinstance(function, Mapping) or not function.get("name"):
            continue
        normalized.append({
            "type": "function",
            "name": str(function["name"]),
            "description": str(function.get("description") or ""),
            "parameters": function.get("parameters")
            or {"type": "object", "properties": {}},
            "strict": True,
        })
    return normalized or None


_PROTOCOL_MISSING = object()


class _EndpointProtocolError(ValueError):
    """A response used a known endpoint family but an unsafe/unknown shape."""


def _protocol_failure(
    cfg: ModelConfig,
    protocol: str,
    detail: str,
    *,
    streaming: bool = False,
    framing: str = "json",
) -> ModelResult:
    """Return a typed, redacted protocol failure without retaining request headers."""
    provider = cfg.label or cfg.kind
    provider_error_payload = str(detail).casefold().startswith(
        ("stream error event:", "stream endpoint error:", "endpoint error:")
    )
    classified = (
        classify_provider_error(
            detail,
            provider=provider,
            model=cfg.model,
        )
        if provider_error_payload
        else ProviderError(
            code=ProviderErrorCode.TRANSPORT,
            message=_redact_error_text(detail),
            provider=provider,
            model=cfg.model,
            retryable=False,
            cause_type="_EndpointProtocolError",
        )
    )
    message = f"{protocol} protocol error: {classified.message}"
    info = ProviderError(
        # Malformed stream shapes remain TRANSPORT/non-retryable.  A stream
        # ``event: error`` that carries a typed transient provider failure
        # (429/5xx/overload/timeout/connection) retains that classification so
        # ModelClient can perform its bounded retry without making every
        # protocol error retryable.
        code=classified.code,
        message=message,
        provider=provider,
        model=cfg.model,
        retryable=classified.retryable,
        http_status=classified.http_status,
        retry_after_sec=classified.retry_after_sec,
        cause_type="_EndpointProtocolError",
    )
    return ModelResult(
        text="",
        provider=provider,
        model=cfg.model,
        ok=False,
        error=info.message,
        error_info=info,
        finish_reason="protocol_error",
        raw={
            "protocolNormalization": {
                "protocol": protocol,
                "streaming": streaming,
                "framing": framing,
                "valid": False,
                "error": _redact_error_text(detail),
            }
        },
    )


def _field(value: Any, name: str, default: Any = _PROTOCOL_MISSING) -> Any:
    """Read a response field from either a mapping or an SDK response object."""
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _shape_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, Mapping):
        return "object"
    return type(value).__name__


def _normalization_metadata(
    *,
    protocol: str,
    streaming: bool,
    framing: str,
    content_shape: str,
    tool_shape: str,
    usage_shape: str,
    response_shape: str,
) -> dict[str, Any]:
    """Protocol-safe format-probe detail; deliberately contains no headers."""
    return {
        "protocol": protocol,
        "streaming": streaming,
        "framing": framing,
        "contentShape": content_shape,
        "toolShape": tool_shape,
        "usageShape": usage_shape,
        "responseShape": response_shape,
        "valid": True,
    }


_PROTOCOL_RAW_SENSITIVE_KEYS = frozenset({
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "headers",
    "http_headers",
    "request_headers",
    "response_headers",
    "api_key",
    "api-key",
    "access_token",
    "refresh_token",
    "password",
    "secret",
})


def _sanitize_protocol_raw(value: Any) -> Any:
    """Copy provider response data while excluding secret-bearing containers."""
    if isinstance(value, Mapping):
        sanitized: dict[str, Any] = {}
        for key, child in value.items():
            key_text = str(key)
            normalized_key = re.sub(
                r"[^a-z0-9]+",
                "_",
                key_text.strip().casefold(),
            ).strip("_")
            compact_key = normalized_key.replace("_", "")
            if (
                normalized_key in _PROTOCOL_RAW_SENSITIVE_KEYS
                or compact_key in {
                    "authorization",
                    "proxyauthorization",
                    "cookie",
                    "setcookie",
                    "headers",
                    "httpheaders",
                    "requestheaders",
                    "responseheaders",
                    "apikey",
                    "accesstoken",
                    "refreshtoken",
                    "password",
                    "secret",
                }
            ):
                continue
            sanitized[key_text] = _sanitize_protocol_raw(child)
        return sanitized
    if isinstance(value, (list, tuple)):
        return [_sanitize_protocol_raw(child) for child in value]
    return value


def _attach_normalization_metadata(
    raw: Mapping[str, Any] | None,
    metadata: Mapping[str, Any],
) -> dict[str, Any]:
    """Attach format-probe metadata to response data, never request metadata."""
    return {
        **(
            _sanitize_protocol_raw(raw)
            if isinstance(raw, Mapping)
            else {}
        ),
        "protocolNormalization": dict(metadata),
    }


def _normalize_text_value(
    value: Any,
    *,
    field_name: str,
    accepted_block_types: frozenset[str],
    accepted_text_keys: tuple[str, ...] = ("text",),
) -> str:
    """Normalize a text field that may be a string or a known content-block array."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if not isinstance(value, (list, tuple)):
        raise _EndpointProtocolError(
            f"{field_name} must be a string, array, or null; got {_shape_name(value)}"
        )
    parts: list[str] = []
    for index, part in enumerate(value):
        if isinstance(part, str):
            parts.append(part)
            continue
        if not isinstance(part, Mapping):
            raise _EndpointProtocolError(
                f"{field_name}[{index}] must be a string or object; got {_shape_name(part)}"
            )
        block_type_value = part.get("type")
        block_type = (
            str(block_type_value).strip().casefold()
            if block_type_value is not None
            else ""
        )
        if block_type and block_type not in accepted_block_types:
            raise _EndpointProtocolError(
                f"{field_name}[{index}] has unsupported block type {block_type!r}"
            )
        text = _PROTOCOL_MISSING
        for key in accepted_text_keys:
            if key in part:
                text = part[key]
                break
        if text is _PROTOCOL_MISSING:
            raise _EndpointProtocolError(
                f"{field_name}[{index}] has no supported text field"
            )
        if not isinstance(text, str):
            raise _EndpointProtocolError(
                f"{field_name}[{index}] text must be a string; got {_shape_name(text)}"
            )
        parts.append(text)
    return "".join(parts)


_OPENAI_CONTENT_BLOCK_TYPES = frozenset({"", "text", "output_text", "refusal"})
_OPENAI_REASONING_BLOCK_TYPES = frozenset({
    "", "text", "reasoning", "reasoning_text", "summary_text",
})


def _normalize_openai_content(value: Any, *, field_name: str = "message.content") -> str:
    return _normalize_text_value(
        value,
        field_name=field_name,
        accepted_block_types=_OPENAI_CONTENT_BLOCK_TYPES,
        accepted_text_keys=("text", "refusal"),
    )


def _normalize_openai_reasoning(value: Any, *, field_name: str) -> str:
    return _normalize_text_value(
        value,
        field_name=field_name,
        accepted_block_types=_OPENAI_REASONING_BLOCK_TYPES,
        accepted_text_keys=("text", "reasoning_content", "reasoning", "summary"),
    )


def _normalize_tool_arguments(value: Any, *, field_name: str) -> Any:
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        return dict(value)
    raise _EndpointProtocolError(
        f"{field_name} must be a JSON string, object, or null; got {_shape_name(value)}"
    )


def _normalize_openai_tool_calls(
    message: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], bool, str]:
    """Normalize modern tool_calls and legacy function_call into Sophia calls."""
    raw_calls = message.get("tool_calls", _PROTOCOL_MISSING)
    legacy_call = message.get("function_call", _PROTOCOL_MISSING)
    has_modern = raw_calls not in (_PROTOCOL_MISSING, None, [])
    has_legacy = legacy_call not in (_PROTOCOL_MISSING, None, {})
    if has_modern and has_legacy:
        raise _EndpointProtocolError(
            "message cannot contain both tool_calls and function_call"
        )
    if has_modern and not isinstance(raw_calls, list):
        raise _EndpointProtocolError(
            f"message.tool_calls must be an array; got {_shape_name(raw_calls)}"
        )
    calls_to_parse: list[tuple[Mapping[str, Any], str]] = []
    tool_shape = "none"
    if has_modern:
        tool_shape = "tool_calls"
        for index, call in enumerate(raw_calls):
            if not isinstance(call, Mapping):
                raise _EndpointProtocolError(
                    f"message.tool_calls[{index}] must be an object; got {_shape_name(call)}"
                )
            if call.get("type") not in (None, "", "function"):
                raise _EndpointProtocolError(
                    f"message.tool_calls[{index}] has unsupported type {call.get('type')!r}"
                )
            calls_to_parse.append((call, f"message.tool_calls[{index}]"))
    elif has_legacy:
        tool_shape = "function_call"
        if not isinstance(legacy_call, Mapping):
            raise _EndpointProtocolError(
                f"message.function_call must be an object; got {_shape_name(legacy_call)}"
            )
        calls_to_parse.append((legacy_call, "message.function_call"))

    normalized: list[dict[str, Any]] = []
    malformed = False
    for call, field_name in calls_to_parse:
        function = call.get("function", _PROTOCOL_MISSING)
        if function is _PROTOCOL_MISSING:
            function = call
        elif not isinstance(function, Mapping):
            raise _EndpointProtocolError(
                f"{field_name}.function must be an object; got {_shape_name(function)}"
            )
        raw_name = call.get("name", function.get("name"))
        if raw_name is not None and not isinstance(raw_name, str):
            raise _EndpointProtocolError(
                f"{field_name} function name must be a string"
            )
        name = (raw_name or "").strip()
        if not name:
            malformed = True
            continue
        raw_id = call.get("id", function.get("id"))
        if raw_id is not None and not isinstance(raw_id, str):
            raise _EndpointProtocolError(f"{field_name}.id must be a string or null")
        arguments = (
            call.get("arguments")
            if "arguments" in call
            else function.get("arguments")
        )
        normalized.append({
            "id": raw_id,
            "name": name,
            "arguments": _normalize_tool_arguments(
                arguments,
                field_name=f"{field_name}.arguments",
            ),
        })
    return normalized, malformed, tool_shape


def _nonnegative_int(value: Any, *, field_name: str) -> int:
    if isinstance(value, bool):
        raise _EndpointProtocolError(f"{field_name} must be a non-negative integer")
    if isinstance(value, str):
        if not value.strip().isascii() or not value.strip().isdecimal():
            raise _EndpointProtocolError(f"{field_name} must be a non-negative integer")
        value = int(value.strip())
    elif isinstance(value, float):
        if not value.is_integer():
            raise _EndpointProtocolError(f"{field_name} must be a non-negative integer")
        value = int(value)
    if not isinstance(value, int) or value < 0:
        raise _EndpointProtocolError(f"{field_name} must be a non-negative integer")
    return value


def _usage_field(
    usage: Any,
    names: tuple[str, ...],
    *,
    default: Any = _PROTOCOL_MISSING,
) -> tuple[Any, str | None]:
    for name in names:
        value = _field(usage, name, _PROTOCOL_MISSING)
        if value is not _PROTOCOL_MISSING and value is not None:
            return value, name
    return default, None


def _normalize_usage(
    usage: Any,
    *,
    field_name: str = "usage",
    ollama_native: bool = False,
) -> tuple[int, int, int, int, str]:
    """Normalize OpenAI, Anthropic-proxy, and Ollama token-count variants."""
    if usage in (_PROTOCOL_MISSING, None):
        return 0, 0, 0, 0, "none"
    if not isinstance(usage, Mapping) and not hasattr(usage, "__dict__"):
        raise _EndpointProtocolError(
            f"{field_name} must be an object; got {_shape_name(usage)}"
        )
    prompt_raw, prompt_name = _usage_field(
        usage,
        ("prompt_eval_count",) if ollama_native else ("prompt_tokens", "input_tokens"),
        default=0,
    )
    completion_raw, completion_name = _usage_field(
        usage,
        ("eval_count",) if ollama_native else ("completion_tokens", "output_tokens"),
        default=0,
    )
    prompt_tokens = _nonnegative_int(prompt_raw, field_name=f"{field_name}.{prompt_name or 'prompt'}")
    completion_tokens = _nonnegative_int(
        completion_raw,
        field_name=f"{field_name}.{completion_name or 'completion'}",
    )

    cache_tokens = 0
    cache_direct, cache_name = _usage_field(
        usage,
        ("cache_tokens", "cached_tokens", "cached_input_tokens"),
    )
    if cache_direct is not _PROTOCOL_MISSING:
        cache_tokens = _nonnegative_int(
            cache_direct,
            field_name=f"{field_name}.{cache_name}",
        )
    else:
        details = _field(usage, "prompt_tokens_details", _PROTOCOL_MISSING)
        if details is _PROTOCOL_MISSING:
            details = _field(usage, "input_tokens_details", _PROTOCOL_MISSING)
        if details not in (_PROTOCOL_MISSING, None):
            cached, cached_name = _usage_field(details, ("cached_tokens",))
            if cached is not _PROTOCOL_MISSING:
                cache_tokens = _nonnegative_int(
                    cached,
                    field_name=f"{field_name}.details.{cached_name}",
                )
        if cache_tokens == 0:
            cache_read, read_name = _usage_field(
                usage,
                ("cache_read_input_tokens",),
                default=0,
            )
            cache_create, create_name = _usage_field(
                usage,
                ("cache_creation_input_tokens",),
                default=0,
            )
            cache_tokens = (
                _nonnegative_int(
                    cache_read,
                    field_name=f"{field_name}.{read_name or 'cache_read_input_tokens'}",
                )
                + _nonnegative_int(
                    cache_create,
                    field_name=f"{field_name}.{create_name or 'cache_creation_input_tokens'}",
                )
            )

    reasoning_tokens = 0
    completion_details = _field(
        usage,
        "completion_tokens_details",
        _field(usage, "output_tokens_details", _PROTOCOL_MISSING),
    )
    if completion_details not in (_PROTOCOL_MISSING, None):
        reasoning_raw, reasoning_name = _usage_field(
            completion_details,
            ("reasoning_tokens",),
        )
        if reasoning_raw is not _PROTOCOL_MISSING:
            reasoning_tokens = _nonnegative_int(
                reasoning_raw,
                field_name=f"{field_name}.details.{reasoning_name}",
            )

    if ollama_native:
        usage_shape = "ollama_counts"
    elif prompt_name == "input_tokens" or completion_name == "output_tokens":
        usage_shape = "input_output"
    elif prompt_name or completion_name:
        usage_shape = "prompt_completion"
    else:
        usage_shape = "none"
    return prompt_tokens, completion_tokens, cache_tokens, reasoning_tokens, usage_shape


def _response_model(response: Any, cfg: ModelConfig) -> str:
    value = _field(response, "model", _PROTOCOL_MISSING)
    if value in (_PROTOCOL_MISSING, None, ""):
        return cfg.model
    if not isinstance(value, str):
        raise _EndpointProtocolError("response.model must be a string")
    return value


def _optional_string(value: Any, *, field_name: str) -> str | None:
    if value is _PROTOCOL_MISSING or value is None:
        return None
    if not isinstance(value, str):
        raise _EndpointProtocolError(f"{field_name} must be a string or null")
    return value


def _normalize_anthropic_response(response: Any, cfg: ModelConfig) -> ModelResult:
    """Normalize native SDK objects and mapping-shaped Anthropic Messages."""
    content = _field(response, "content", _PROTOCOL_MISSING)
    if content is _PROTOCOL_MISSING:
        raise _EndpointProtocolError("response.content is missing")
    response_shape = "mapping" if isinstance(response, Mapping) else "sdk_object"
    content_shape = _shape_name(content)
    text_parts: list[str] = []
    thinking_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    malformed_tool_call = False
    redacted = 0
    tool_shape = "none"

    if isinstance(content, str):
        text_parts.append(content)
    elif isinstance(content, (list, tuple)):
        for index, block in enumerate(content):
            block_type_value = _field(block, "type", _PROTOCOL_MISSING)
            if block_type_value is _PROTOCOL_MISSING or not isinstance(block_type_value, str):
                raise _EndpointProtocolError(
                    f"response.content[{index}].type must be a string"
                )
            block_type = block_type_value.strip().casefold()
            if block_type == "text":
                block_text = _field(block, "text", _PROTOCOL_MISSING)
                if not isinstance(block_text, str):
                    raise _EndpointProtocolError(
                        f"response.content[{index}].text must be a string"
                    )
                text_parts.append(block_text)
            elif block_type == "thinking":
                thinking = _field(block, "thinking", _PROTOCOL_MISSING)
                if not isinstance(thinking, str):
                    raise _EndpointProtocolError(
                        f"response.content[{index}].thinking must be a string"
                    )
                thinking_parts.append(thinking)
            elif block_type == "redacted_thinking":
                redacted += 1
            elif block_type == "tool_use":
                tool_shape = "tool_use"
                raw_name = _field(block, "name", _PROTOCOL_MISSING)
                if raw_name is _PROTOCOL_MISSING or not isinstance(raw_name, str):
                    raise _EndpointProtocolError(
                        f"response.content[{index}].name must be a string"
                    )
                name = raw_name.strip()
                if not name:
                    malformed_tool_call = True
                    continue
                raw_id = _field(block, "id", None)
                if raw_id is not None and not isinstance(raw_id, str):
                    raise _EndpointProtocolError(
                        f"response.content[{index}].id must be a string or null"
                    )
                raw_input = _field(block, "input", None)
                tool_calls.append({
                    "id": raw_id,
                    "name": name,
                    "arguments": _normalize_tool_arguments(
                        raw_input,
                        field_name=f"response.content[{index}].input",
                    ),
                })
            else:
                raise _EndpointProtocolError(
                    f"response.content[{index}] has unsupported block type {block_type!r}"
                )
    else:
        raise _EndpointProtocolError(
            f"response.content must be a string or array; got {content_shape}"
        )

    usage = _field(response, "usage", _PROTOCOL_MISSING)
    prompt_tokens, completion_tokens, cache_tokens, _, usage_shape = _normalize_usage(
        usage,
        field_name="response.usage",
    )
    reasoning = "".join(thinking_parts) if capture_thinking_enabled() else ""
    metadata = _normalization_metadata(
        protocol="anthropic-messages",
        streaming=False,
        framing="sdk",
        content_shape=content_shape,
        tool_shape=tool_shape,
        usage_shape=usage_shape,
        response_shape=response_shape,
    )
    raw = _attach_normalization_metadata(
        {"redactedThinkingBlocks": redacted} if redacted else None,
        metadata,
    )
    return ModelResult(
        text="".join(text_parts),
        provider=cfg.label or "anthropic",
        model=_response_model(response, cfg),
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cache_tokens=cache_tokens,
        finish_reason=_optional_string(
            _field(response, "stop_reason", _PROTOCOL_MISSING),
            field_name="response.stop_reason",
        ),
        tool_calls=tool_calls,
        malformed_tool_call=malformed_tool_call,
        reasoning_text=reasoning,
        reasoning_tokens=(max(1, len(reasoning) // 4) if reasoning else 0),
        raw=raw,
    )


def _call_anthropic(system: str, user: str, cfg: ModelConfig, *, tools: list[dict] | None,
                    messages: list[dict] | None = None, **_: Any) -> ModelResult:
    key = cfg.resolved_key()
    provider = cfg.label or "anthropic"
    if not key:
        expected = cfg.api_key_env or "ANTHROPIC_API_KEY/CLAUDE_API_KEY"
        return ModelResult(text="", provider=provider, model=cfg.model, ok=False, error=f"no API key (set {expected})")
    import anthropic  # lazy

    kwargs: dict[str, Any] = {"api_key": key, "timeout": cfg.timeout_sec}
    guarded_http_client: Any | None = None
    if cfg.endpoint_scope:
        _validate_custom_gateway_destination(cfg)
        import httpx  # anthropic SDK dependency; lazy with the provider itself

        guarded_http_client = httpx.Client(
            follow_redirects=False,
            trust_env=False,
            timeout=cfg.timeout_sec,
        )
        kwargs["http_client"] = guarded_http_client
    if cfg.base_url:
        kwargs["base_url"] = cfg.base_url
    try:
        client = anthropic.Anthropic(**kwargs)
    except Exception:
        if guarded_http_client is not None:
            guarded_http_client.close()
        raise
    system_text, turns = _anthropic_messages(system, user, messages)
    create_kwargs: dict[str, Any] = {
        "model": cfg.model,
        "max_tokens": cfg.max_tokens,
        "system": system_text,
        "messages": turns,
        "temperature": cfg.temperature,
    }
    if cfg.top_p is not None:
        create_kwargs["top_p"] = cfg.top_p
    if cfg.top_k is not None:
        create_kwargs["top_k"] = cfg.top_k
    anthropic_tools = _as_anthropic_tools(tools)
    if anthropic_tools:
        create_kwargs["tools"] = anthropic_tools
    thinking = _anthropic_thinking_param(cfg)
    if thinking:
        create_kwargs["thinking"] = thinking
    try:
        try:
            response = client.messages.create(**create_kwargs)
        except Exception as exc:  # noqa: BLE001
            # A model that doesn't accept `thinking` (older/3rd-party) must not lose the answer:
            # retry only for an explicit 400 incompatibility. Operational failures
            # belong to ModelClient's normal classifier/backoff; replaying them here
            # can duplicate a paid request and silently downgrade reasoning.
            status = getattr(exc, "status_code", None)
            if (
                "thinking" not in create_kwargs
                or status != 400
                or "thinking" not in str(exc).casefold()
            ):
                raise
            create_kwargs.pop("thinking", None)
            response = client.messages.create(**create_kwargs)
        try:
            return _normalize_anthropic_response(response, cfg)
        except _EndpointProtocolError as exc:
            return _protocol_failure(cfg, "anthropic-messages", str(exc), framing="sdk")
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()
        elif guarded_http_client is not None:
            guarded_http_client.close()


# Backstop margin for the hard wall-clock deadline over cfg.timeout_sec (the socket-level
# urlopen timeout should fire first; this catches the case where it does not). Module-level
# so tests can shrink it to exercise the deadline without a real wait.
_HARD_DEADLINE_MARGIN_SEC = 15


def _ollama_native_chat_endpoint(base_url: str) -> str | None:
    """Return an explicit Ollama /api/chat URL, without guessing from host/model."""
    normalized = base_url.rstrip("/")
    path = urlsplit(normalized).path.rstrip("/")
    if path.endswith("/api/chat"):
        return normalized
    if path.endswith("/api"):
        return f"{normalized}/chat"
    return None


def _ollama_native_payload(
    *,
    cfg: ModelConfig,
    messages: list[dict[str, Any]],
    tools: list[dict] | None,
    streaming: bool,
    response_format: dict | None,
    extra_body: dict | None,
) -> dict[str, Any]:
    """Build only documented Ollama chat fields for an explicit /api endpoint."""
    payload: dict[str, Any] = {
        "model": cfg.model,
        "messages": messages,
        "stream": streaming,
        "options": {
            "temperature": cfg.temperature,
            "num_predict": cfg.max_tokens,
        },
    }
    if cfg.top_p is not None:
        payload["options"]["top_p"] = cfg.top_p
    if cfg.top_k is not None:
        payload["options"]["top_k"] = cfg.top_k
    if cfg.seed is not None:
        payload["options"]["seed"] = cfg.seed
    openai_tools = _as_openai_tools(tools)
    if openai_tools:
        if cfg.tool_choice is not None:
            raise _EndpointProtocolError(
                "Ollama native chat does not support ModelClient tool_choice"
            )
        payload["tools"] = openai_tools
    if response_format:
        response_type = response_format.get("type")
        if response_type == "json_object":
            payload["format"] = "json"
        elif response_type == "json_schema":
            json_schema = response_format.get("json_schema")
            if not isinstance(json_schema, Mapping) or not isinstance(
                json_schema.get("schema"),
                Mapping,
            ):
                raise _EndpointProtocolError(
                    "Ollama native json_schema requires json_schema.schema"
                )
            payload["format"] = dict(json_schema["schema"])
        else:
            raise _EndpointProtocolError(
                f"Ollama native chat does not support response_format type {response_type!r}"
            )
    if extra_body:
        payload.update(extra_body)
    return payload


def _looks_like_ollama_native(value: Mapping[str, Any]) -> bool:
    return isinstance(value.get("message"), Mapping) and any(
        marker in value
        for marker in (
            "done",
            "done_reason",
            "created_at",
            "total_duration",
            "prompt_eval_count",
            "eval_count",
        )
    )


def _provider_error_detail(value: Any) -> str:
    """Extract a bounded safe message from a 200-with-error response object."""
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        # Compatible gateways frequently nest the useful provider payload
        # under ``error`` (and sometimes nest that again).  The old extractor
        # stopped at the outer object and returned only the unhelpful
        # "endpoint returned an error object", which also prevented the typed
        # retry classifier from seeing 429/5xx/overload details.
        parts: list[str] = []
        for key in (
            "message",
            "detail",
            "error",
            "code",
            "type",
            "status",
            "status_code",
        ):
            if key not in value:
                continue
            candidate = value.get(key)
            if isinstance(candidate, (Mapping, list, tuple)):
                detail = _provider_error_detail(candidate)
            elif candidate is None:
                detail = ""
            else:
                detail = str(candidate).strip()
            if not detail or detail == "endpoint returned an error object":
                continue
            parts.append(
                detail
                if key in {"message", "detail", "error"}
                else f"{key}={detail}"
            )
        if parts:
            # Preserve order while avoiding repeated nested fields.
            return "; ".join(dict.fromkeys(parts))[:4000]
    if isinstance(value, (list, tuple)):
        parts = []
        for item in value[:8]:
            detail = _provider_error_detail(item)
            if detail != "endpoint returned an error object":
                parts.append(detail)
        if parts:
            return "; ".join(dict.fromkeys(parts))[:4000]
    return "endpoint returned an error object"


def _normalize_ollama_native_response(
    raw: Mapping[str, Any],
    cfg: ModelConfig,
) -> ModelResult:
    message = raw.get("message")
    if not isinstance(message, Mapping):
        raise _EndpointProtocolError("Ollama response.message must be an object")
    done = raw.get("done", _PROTOCOL_MISSING)
    if done is not True:
        if done is False:
            raise _EndpointProtocolError(
                "Ollama non-streaming response ended with done=false"
            )
        raise _EndpointProtocolError("Ollama non-streaming response.done is missing")

    content_value = message.get("content")
    content = _normalize_openai_content(
        content_value,
        field_name="Ollama response.message.content",
    )
    content, think_blocks = split_think_blocks(content)
    provider_reasoning = _normalize_openai_reasoning(
        message.get(
            "thinking",
            message.get("reasoning_content", message.get("reasoning")),
        ),
        field_name="Ollama response.message.thinking",
    )
    tool_calls, malformed_tool_call, tool_shape = _normalize_openai_tool_calls(message)
    prompt_tokens, completion_tokens, cache_tokens, usage_reasoning, usage_shape = (
        _normalize_usage(
            raw,
            field_name="Ollama response",
            ollama_native=True,
        )
    )
    reasoning = ""
    reasoning_tokens = 0
    if capture_thinking_enabled():
        reasoning = provider_reasoning
        for block in think_blocks:
            reasoning = (
                f"{reasoning}\n{block.strip()}".strip()
                if reasoning
                else block.strip()
            )
        reasoning_tokens = usage_reasoning
        if not reasoning_tokens and reasoning:
            reasoning_tokens = max(1, len(reasoning) // 4)
    metadata = _normalization_metadata(
        protocol="ollama-native-chat",
        streaming=False,
        framing="json",
        content_shape=_shape_name(content_value),
        tool_shape=tool_shape,
        usage_shape=usage_shape,
        response_shape="mapping",
    )
    return ModelResult(
        text=content,
        provider=cfg.label or "openai",
        model=_response_model(raw, cfg),
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cache_tokens=cache_tokens,
        finish_reason=_optional_string(
            raw.get("done_reason", "stop"),
            field_name="Ollama response.done_reason",
        ) or "stop",
        tool_calls=tool_calls,
        malformed_tool_call=malformed_tool_call,
        reasoning_text=reasoning,
        reasoning_tokens=reasoning_tokens,
        raw=_attach_normalization_metadata(raw, metadata),
        requires_native_tool_transcript=cfg.requires_native_tool_transcript,
        continuation_reasoning_content=(
            provider_reasoning
            if cfg.requires_native_tool_transcript and tool_calls
            else ""
        ),
    )


def _normalize_openai_response(
    raw: Any,
    cfg: ModelConfig,
    *,
    expect_ollama_native: bool = False,
) -> ModelResult:
    """Normalize one non-streaming Chat Completions or Ollama native response."""
    if not isinstance(raw, Mapping):
        raise _EndpointProtocolError(
            f"response must be an object; got {_shape_name(raw)}"
        )
    if raw.get("error") not in (None, "", {}):
        raise _EndpointProtocolError(
            f"endpoint error: {_provider_error_detail(raw.get('error'))}"
        )
    if expect_ollama_native or _looks_like_ollama_native(raw):
        if not _looks_like_ollama_native(raw):
            raise _EndpointProtocolError(
                "explicit Ollama /api/chat endpoint returned a non-Ollama payload"
            )
        return _normalize_ollama_native_response(raw, cfg)

    choices = raw.get("choices", _PROTOCOL_MISSING)
    if choices is _PROTOCOL_MISSING:
        raise _EndpointProtocolError("response.choices is missing")
    if not isinstance(choices, list) or not choices:
        raise _EndpointProtocolError("response.choices must be a non-empty array")
    choice = choices[0]
    if not isinstance(choice, Mapping):
        raise _EndpointProtocolError("response.choices[0] must be an object")
    message = choice.get("message", _PROTOCOL_MISSING)
    if not isinstance(message, Mapping):
        raise _EndpointProtocolError("response.choices[0].message must be an object")

    content_value = message.get("content")
    content = _normalize_openai_content(content_value)
    if not content and message.get("refusal") not in (None, ""):
        content = _normalize_openai_content(
            [{"type": "refusal", "refusal": message.get("refusal")}],
            field_name="message.refusal",
        )
    content, think_blocks = split_think_blocks(content)
    provider_reasoning = _normalize_openai_reasoning(
        message.get("reasoning_content", message.get("reasoning")),
        field_name="message.reasoning_content",
    )
    tool_calls, malformed_tool_call, tool_shape = _normalize_openai_tool_calls(message)
    usage = raw.get("usage", _PROTOCOL_MISSING)
    prompt_tokens, completion_tokens, cache_tokens, usage_reasoning, usage_shape = (
        _normalize_usage(usage)
    )
    reasoning = ""
    reasoning_tokens = 0
    if capture_thinking_enabled():
        reasoning = provider_reasoning
        for block in think_blocks:
            reasoning = (
                f"{reasoning}\n{block.strip()}".strip()
                if reasoning
                else block.strip()
            )
        reasoning_tokens = usage_reasoning
        if not reasoning_tokens and reasoning:
            reasoning_tokens = max(1, len(reasoning) // 4)

    result_raw: Mapping[str, Any] = raw
    continuation_reasoning = ""
    if cfg.requires_native_tool_transcript and tool_calls:
        continuation_reasoning = provider_reasoning
        # Keep hidden reasoning transient for DS4-compatible continuation.
        result_raw_dict = dict(raw)
        raw_choices = list(choices)
        first_choice = dict(choice)
        sanitized_message = dict(message)
        sanitized_message.pop("reasoning_content", None)
        sanitized_message.pop("reasoning", None)
        first_choice["message"] = sanitized_message
        raw_choices[0] = first_choice
        result_raw_dict["choices"] = raw_choices
        result_raw = result_raw_dict

    metadata = _normalization_metadata(
        protocol="openai-chat-completions",
        streaming=False,
        framing="json",
        content_shape=_shape_name(content_value),
        tool_shape=tool_shape,
        usage_shape=usage_shape,
        response_shape="mapping",
    )
    return ModelResult(
        text=content,
        provider=cfg.label or "openai",
        model=_response_model(raw, cfg),
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cache_tokens=cache_tokens,
        finish_reason=_optional_string(
            choice.get("finish_reason", _PROTOCOL_MISSING),
            field_name="response.choices[0].finish_reason",
        ),
        tool_calls=tool_calls,
        malformed_tool_call=malformed_tool_call,
        reasoning_text=reasoning,
        reasoning_tokens=reasoning_tokens,
        raw=_attach_normalization_metadata(result_raw, metadata),
        requires_native_tool_transcript=cfg.requires_native_tool_transcript,
        continuation_reasoning_content=continuation_reasoning,
    )


def _responses_input(
    system: str,
    user: str,
    messages: list[dict] | None,
) -> str | list[dict[str, Any]]:
    """Build Responses input while preserving native function-call bindings."""
    if not messages:
        return user
    items: list[dict[str, Any]] = []
    for message in messages:
        role = str(message.get("role") or "").strip().casefold()
        content = str(message.get("content") or "")
        if role == "system":
            continue
        if role == "assistant":
            if content:
                items.append({"role": "assistant", "content": content})
            tool_calls = message.get("tool_calls")
            if tool_calls is None:
                continue
            if not isinstance(tool_calls, list):
                raise _EndpointProtocolError(
                    "Responses assistant tool_calls must be an array"
                )
            for index, call in enumerate(tool_calls):
                if not isinstance(call, Mapping):
                    raise _EndpointProtocolError(
                        f"Responses assistant tool_calls[{index}] must be an object"
                    )
                function = call.get("function")
                if not isinstance(function, Mapping):
                    raise _EndpointProtocolError(
                        f"Responses assistant tool_calls[{index}].function must be an object"
                    )
                call_id = str(call.get("id") or "").strip()
                name = str(function.get("name") or "").strip()
                arguments = function.get("arguments")
                if not call_id or not name or not isinstance(arguments, str):
                    raise _EndpointProtocolError(
                        "Responses native tool continuation requires call id, name, "
                        "and JSON-string arguments"
                    )
                items.append({
                    "type": "function_call",
                    "call_id": call_id,
                    "name": name,
                    "arguments": arguments,
                })
        elif role == "tool":
            call_id = str(message.get("tool_call_id") or "").strip()
            if not call_id:
                raise _EndpointProtocolError(
                    "Responses native tool output requires tool_call_id"
                )
            items.append({
                "type": "function_call_output",
                "call_id": call_id,
                "output": content,
            })
        else:
            items.append({"role": "user", "content": content})
    return items or user


def _normalize_openai_responses_response(
    raw: Any,
    cfg: ModelConfig,
) -> ModelResult:
    """Normalize one non-streaming OpenAI Responses-compatible payload."""
    if not isinstance(raw, Mapping):
        raise _EndpointProtocolError(
            f"response must be an object; got {_shape_name(raw)}"
        )
    if raw.get("error") not in (None, "", {}):
        raise _EndpointProtocolError(
            f"endpoint error: {_provider_error_detail(raw.get('error'))}"
        )
    output = raw.get("output", _PROTOCOL_MISSING)
    if not isinstance(output, list):
        raise _EndpointProtocolError("response.output must be an array")
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    malformed_tool_call = False
    content_shapes: set[str] = set()
    for index, item in enumerate(output):
        if not isinstance(item, Mapping):
            raise _EndpointProtocolError(
                f"response.output[{index}] must be an object"
            )
        item_type = str(item.get("type") or "").strip().casefold()
        if item_type in {"message", "output_text"}:
            content = item.get("content")
            content_shapes.add(_shape_name(content))
            if item_type == "output_text" and isinstance(item.get("text"), str):
                text_parts.append(str(item["text"]))
            elif content is not None:
                text_parts.append(
                    _normalize_openai_content(
                        content,
                        field_name=f"response.output[{index}].content",
                    )
                )
            continue
        if item_type == "function_call":
            raw_name = item.get("name")
            if raw_name is not None and not isinstance(raw_name, str):
                raise _EndpointProtocolError(
                    f"response.output[{index}].name must be a string"
                )
            name = str(raw_name or "").strip()
            if not name:
                malformed_tool_call = True
                continue
            raw_id = item.get("call_id", item.get("id"))
            if raw_id is not None and not isinstance(raw_id, str):
                raise _EndpointProtocolError(
                    f"response.output[{index}].call_id must be a string or null"
                )
            tool_calls.append({
                "id": raw_id,
                "name": name,
                "arguments": _normalize_tool_arguments(
                    item.get("arguments"),
                    field_name=f"response.output[{index}].arguments",
                ),
            })
            continue
        if item_type in {"reasoning", "computer_call", "web_search_call"}:
            # These blocks are recognized but not executable by this generic
            # endpoint adapter. Tool execution remains limited to registered
            # function calls.
            continue
        raise _EndpointProtocolError(
            f"response.output[{index}] has unsupported type {item_type!r}"
        )
    output_text = raw.get("output_text")
    if isinstance(output_text, str) and output_text:
        text_parts = [output_text]
        content_shapes.add("output_text")
    elif output_text not in (None, _PROTOCOL_MISSING):
        raise _EndpointProtocolError("response.output_text must be a string or null")
    usage = raw.get("usage", _PROTOCOL_MISSING)
    prompt_tokens, completion_tokens, cache_tokens, reasoning_tokens, usage_shape = (
        _normalize_usage(usage)
    )
    metadata = _normalization_metadata(
        protocol="openai-responses",
        streaming=False,
        framing="json",
        content_shape="+".join(sorted(content_shapes)) or "none",
        tool_shape="function_call" if tool_calls or malformed_tool_call else "none",
        usage_shape=usage_shape,
        response_shape="mapping",
    )
    status = _optional_string(
        raw.get("status", _PROTOCOL_MISSING),
        field_name="response.status",
    )
    if status in {"failed", "incomplete", "cancelled"}:
        raise _EndpointProtocolError(f"response completed with status {status!r}")
    return ModelResult(
        text="".join(text_parts),
        provider=cfg.label or "openai-responses",
        model=_response_model(raw, cfg),
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cache_tokens=cache_tokens,
        finish_reason=status or "completed",
        tool_calls=tool_calls,
        malformed_tool_call=malformed_tool_call,
        reasoning_tokens=reasoning_tokens,
        raw=_attach_normalization_metadata(raw, metadata),
        requires_native_tool_transcript=True,
    )


def _call_openai_responses(
    system: str,
    user: str,
    cfg: ModelConfig,
    *,
    tools: list[dict] | None,
    on_token: Callable[[str], None] | None,
    on_thinking_token: Callable[[str], None] | None = None,
    messages: list[dict] | None = None,
    response_format: dict | None = None,
    extra_body: dict | None = None,
    **_: Any,
) -> ModelResult:
    """Call an OpenAI Responses-compatible endpoint.

    The generic adapter intentionally uses non-streaming Responses calls.
    Streaming compatibility remains available in the explicit format probe and
    can be promoted here only after the event-shape suite stays fail-closed.
    """
    del on_token, on_thinking_token
    key = cfg.resolved_key()
    if not key:
        return ModelResult(
            text="",
            provider=cfg.label or "openai-responses",
            model=cfg.model,
            ok=False,
            error=f"no API key (set {cfg.api_key_env})",
        )
    base = (cfg.base_url or "https://api.openai.com/v1").rstrip("/")
    payload: dict[str, Any] = {
        "model": cfg.model,
        "input": _responses_input(system, user, messages),
        "max_output_tokens": cfg.max_tokens,
        "stream": False,
    }
    if system:
        payload["instructions"] = system
    if cfg.temperature is not None:
        payload["temperature"] = cfg.temperature
    if cfg.top_p is not None:
        payload["top_p"] = cfg.top_p
    responses_tools = _as_openai_responses_tools(tools)
    if responses_tools:
        payload["tools"] = responses_tools
    if response_format:
        response_type = response_format.get("type")
        if response_type == "json_schema":
            schema = response_format.get("json_schema")
            if isinstance(schema, Mapping):
                payload["text"] = {
                    "format": {
                        "type": "json_schema",
                        **dict(schema),
                    }
                }
            else:
                raise _EndpointProtocolError(
                    "Responses json_schema requires a json_schema object"
                )
        elif response_type == "json_object":
            payload["text"] = {"format": {"type": "json_object"}}
        else:
            raise _EndpointProtocolError(
                "Responses transport accepts only json_schema or json_object formats"
            )
    if extra_body:
        payload.update(extra_body)
    request = urllib.request.Request(
        f"{base}/responses",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with _urlopen_model_request(request, cfg) as response:
            raw = json.loads(response.read().decode("utf-8", errors="strict"))
        return _normalize_openai_responses_response(raw, cfg)
    except (json.JSONDecodeError, UnicodeError, _EndpointProtocolError) as exc:
        return _protocol_failure(cfg, "openai-responses", str(exc))


def _call_openai_compatible(
    system: str,
    user: str,
    cfg: ModelConfig,
    *,
    tools: list[dict] | None,
    on_token: Callable[[str], None] | None,
    on_thinking_token: Callable[[str], None] | None = None,
    messages: list[dict] | None = None,
    response_format: dict | None = None,
    extra_body: dict | None = None,
    **_: Any,
) -> ModelResult:
    key = cfg.resolved_key()
    if not key:
        return ModelResult(text="", provider=cfg.label or "openai", model=cfg.model, ok=False, error=f"no API key (set {cfg.api_key_env})")
    base = (cfg.base_url or "https://api.openai.com/v1").rstrip("/")
    stream_requested = bool(on_token) or bool(on_thinking_token)
    request_messages = messages or [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    ollama_endpoint = _ollama_native_chat_endpoint(base)
    try:
        if ollama_endpoint:
            payload = _ollama_native_payload(
                cfg=cfg,
                messages=request_messages,
                tools=tools,
                streaming=stream_requested,
                response_format=response_format,
                extra_body=extra_body,
            )
            request_url = ollama_endpoint
        else:
            payload = {
                "model": cfg.model,
                # Multi-turn: an explicit ``messages`` list wins over the legacy
                # pair so agentic loops preserve provider prefix caches.
                "messages": request_messages,
                "temperature": cfg.temperature,
                "max_tokens": cfg.max_tokens,
                "stream": stream_requested,
            }
            if cfg.top_p is not None:
                payload["top_p"] = cfg.top_p
            if cfg.top_k is not None:
                # Non-standard for OpenAI proper, but supported by many local
                # compatible servers. User opt-in only.
                payload["top_k"] = cfg.top_k
            if response_format:
                payload["response_format"] = response_format
            if extra_body:
                payload.update(extra_body)
            if cfg.reasoning_effort:
                payload["reasoning_effort"] = cfg.reasoning_effort
            if cfg.seed is not None:
                payload["seed"] = cfg.seed
            openai_tools = _as_openai_tools(tools)
            if openai_tools:
                payload["tools"] = openai_tools
                if cfg.tool_choice is not None:
                    payload["tool_choice"] = cfg.tool_choice
            request_url = f"{base}/chat/completions"
    except _EndpointProtocolError as exc:
        return _protocol_failure(
            cfg,
            "ollama-native-chat",
            str(exc),
        )
    request = urllib.request.Request(
        request_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream_requested else "application/json",
        },
        method="POST",
    )
    def _blocking_call() -> "ModelResult | dict":
        with _urlopen_model_request(request, cfg) as response:
            if stream_requested:
                return _consume_stream(
                    response,
                    cfg,
                    on_token or (lambda _token: None),
                    on_thinking_token,
                    expect_ollama_native=bool(ollama_endpoint),
                )
            return json.loads(response.read().decode("utf-8", errors="replace"))

    try:
        if stream_requested:
            # Streaming: token-level progress is its own liveness signal; run inline.
            result = _blocking_call()
        else:
            # HARD wall-clock deadline. The socket-level ``urlopen`` timeout is UNRELIABLE on
            # some networks — a stalled/trickled chunked read can sit far past
            # ``cfg.timeout_sec`` (diagnosed 2026-07-06: an entailment judge call wedged
            # >500s in ``ssl.recv`` while the 120s urlopen timeout never fired, hanging a
            # whole eval). Run the blocking call in a worker thread and ABANDON it past a
            # hard deadline so a wedged provider read raises ``TimeoutError`` (-> the
            # existing fail-safe below) instead of hanging the process indefinitely.
            import concurrent.futures

            _ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            _fut = _ex.submit(_blocking_call)
            _deadline = cfg.timeout_sec + _HARD_DEADLINE_MARGIN_SEC
            try:
                result = _fut.result(timeout=_deadline)
            except concurrent.futures.TimeoutError:
                _ex.shutdown(wait=False, cancel_futures=True)  # abandon the wedged thread; do NOT block
                raise TimeoutError(
                    f"hard wall-clock deadline {_deadline}s exceeded "
                    "(stalled provider read; socket-level timeout did not fire)"
                )
            _ex.shutdown(wait=False)
        if isinstance(result, ModelResult):  # streaming path already built the result
            return result
        raw = result
    except (json.JSONDecodeError, UnicodeError, _EndpointProtocolError) as exc:
        return _protocol_failure(
            cfg,
            "ollama-native-chat" if ollama_endpoint else "openai-chat-completions",
            str(exc),
            streaming=stream_requested,
            framing="ndjson" if ollama_endpoint and stream_requested else (
                "sse" if stream_requested else "json"
            ),
        )
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            body = ""
        retry_after_sec = None
        if exc.code == 429:
            try:
                retry_after_sec = _parse_retry_after(exc.headers.get("Retry-After"))
            except Exception:
                retry_after_sec = None
        info = classify_provider_error(
            f"HTTP {exc.code}: {body}".strip(),
            provider=cfg.label or "openai",
            model=cfg.model,
            http_status=exc.code,
            retry_after_sec=retry_after_sec,
        )
        return ModelResult(
            text="", provider=cfg.label or "openai", model=cfg.model, ok=False,
            error=info.message, error_info=info, finish_reason="error",
        )
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        return ModelResult(text="", provider=cfg.label or "openai", model=cfg.model, ok=False, error=repr(exc))
    try:
        return _normalize_openai_response(
            raw,
            cfg,
            expect_ollama_native=bool(ollama_endpoint),
        )
    except _EndpointProtocolError as exc:
        return _protocol_failure(
            cfg,
            "ollama-native-chat" if ollama_endpoint else "openai-chat-completions",
            str(exc),
        )


def _stream_payloads(response: Any):
    """Yield ``(framing, event, payload, done_marker)`` from SSE or NDJSON.

    Known permissive variants remain accepted: SSE comments/keepalives, optional
    ``event:`` lines, missing blank separators between complete ``data:`` JSON
    records, and raw JSON-lines streams. Invalid JSON is never skipped.
    """
    pending_data: list[str] = []
    pending_event: str | None = None

    def parse_pending(*, final: bool) -> tuple[str, str | None, Any, bool] | None:
        nonlocal pending_data, pending_event
        if not pending_data:
            return None
        data = "\n".join(pending_data).strip()
        if data == "[DONE]":
            parsed = ("sse", pending_event, None, True)
            pending_data = []
            pending_event = None
            return parsed
        try:
            payload = json.loads(data)
        except json.JSONDecodeError as exc:
            if not final:
                return None
            raise _EndpointProtocolError(
                f"stream data is not valid JSON at line {exc.lineno} column {exc.colno}"
            ) from exc
        parsed = ("sse", pending_event, payload, False)
        pending_data = []
        pending_event = None
        return parsed

    for raw_line in response:
        if isinstance(raw_line, bytes):
            try:
                line = raw_line.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise _EndpointProtocolError("stream contains invalid UTF-8") from exc
        elif isinstance(raw_line, str):
            line = raw_line
        else:
            raise _EndpointProtocolError(
                f"stream line must be bytes or string; got {_shape_name(raw_line)}"
            )
        line = line.rstrip("\r\n")
        if not line.strip():
            parsed = parse_pending(final=True)
            if parsed is not None:
                yield parsed
            continue
        if line.startswith(":"):
            # SSE comment/keepalive.
            continue
        if line.startswith("event:"):
            parsed = parse_pending(final=True)
            if parsed is not None:
                yield parsed
            pending_event = line[len("event:"):].strip() or None
            continue
        if line.startswith("data:"):
            # Some compatible servers omit the blank separator. If the prior
            # data line was already complete JSON, emit it before starting the
            # next record; otherwise retain it as an SSE multi-line payload.
            parsed = parse_pending(final=False)
            if parsed is not None:
                yield parsed
            pending_data.append(line[len("data:"):].lstrip())
            parsed = parse_pending(final=False)
            if parsed is not None:
                yield parsed
            continue
        if line.startswith(("id:", "retry:")):
            # Valid SSE metadata with no response-content semantics.
            continue
        if re.match(r"^[A-Za-z0-9_-]+:", line):
            # The SSE specification permits extension fields and requires
            # consumers to ignore fields they do not understand.
            continue

        parsed = parse_pending(final=True)
        if parsed is not None:
            yield parsed
        try:
            payload = json.loads(line.strip())
        except json.JSONDecodeError as exc:
            raise _EndpointProtocolError(
                f"stream line is neither SSE nor valid JSON at column {exc.colno}"
            ) from exc
        yield ("ndjson", None, payload, False)

    parsed = parse_pending(final=True)
    if parsed is not None:
        yield parsed


def _merge_stream_tool_calls(
    raw_calls: Any,
    tool_parts: dict[int, dict[str, Any]],
    *,
    field_name: str,
) -> None:
    if not isinstance(raw_calls, list):
        raise _EndpointProtocolError(
            f"{field_name} must be an array; got {_shape_name(raw_calls)}"
        )
    for position, raw_call in enumerate(raw_calls):
        if not isinstance(raw_call, Mapping):
            raise _EndpointProtocolError(
                f"{field_name}[{position}] must be an object"
            )
        if raw_call.get("type") not in (None, "", "function"):
            raise _EndpointProtocolError(
                f"{field_name}[{position}] has unsupported type {raw_call.get('type')!r}"
            )
        raw_index = raw_call.get("index", position if len(raw_calls) > 1 else 0)
        index = _nonnegative_int(
            raw_index,
            field_name=f"{field_name}[{position}].index",
        )
        function = raw_call.get("function", _PROTOCOL_MISSING)
        if function is _PROTOCOL_MISSING:
            function = raw_call
        elif not isinstance(function, Mapping):
            raise _EndpointProtocolError(
                f"{field_name}[{position}].function must be an object"
            )
        entry = tool_parts.setdefault(
            index,
            {
                "id": None,
                "name": "",
                "argumentParts": [],
                "argumentObject": _PROTOCOL_MISSING,
            },
        )
        raw_id = raw_call.get("id", function.get("id"))
        if raw_id is not None:
            if not isinstance(raw_id, str):
                raise _EndpointProtocolError(
                    f"{field_name}[{position}].id must be a string or null"
                )
            if entry["id"] not in (None, raw_id):
                raise _EndpointProtocolError(
                    f"{field_name}[{position}] changed tool-call id mid-stream"
                )
            entry["id"] = raw_id
        raw_name = raw_call.get("name", function.get("name"))
        if raw_name is not None:
            if not isinstance(raw_name, str):
                raise _EndpointProtocolError(
                    f"{field_name}[{position}] function name must be a string"
                )
            entry["name"] += raw_name
        arguments = (
            raw_call.get("arguments")
            if "arguments" in raw_call
            else function.get("arguments", _PROTOCOL_MISSING)
        )
        if arguments is _PROTOCOL_MISSING or arguments is None:
            continue
        normalized_arguments = _normalize_tool_arguments(
            arguments,
            field_name=f"{field_name}[{position}].arguments",
        )
        if isinstance(normalized_arguments, str):
            if entry["argumentObject"] is not _PROTOCOL_MISSING:
                raise _EndpointProtocolError(
                    f"{field_name}[{position}] mixed object and string arguments"
                )
            entry["argumentParts"].append(normalized_arguments)
        else:
            if entry["argumentParts"]:
                raise _EndpointProtocolError(
                    f"{field_name}[{position}] mixed string and object arguments"
                )
            if (
                entry["argumentObject"] is not _PROTOCOL_MISSING
                and entry["argumentObject"] != normalized_arguments
            ):
                raise _EndpointProtocolError(
                    f"{field_name}[{position}] changed object arguments mid-stream"
                )
            entry["argumentObject"] = normalized_arguments


def _consume_stream(
    response: Any,
    cfg: ModelConfig,
    on_token: Callable[[str], None],
    on_thinking_token: Callable[[str], None] | None = None,
    *,
    expect_ollama_native: bool = False,
) -> ModelResult:
    parts: list[str] = []
    thinking_parts: list[str] = []
    tool_parts: dict[int, dict[str, Any]] = {}
    finish_reason: str | None = None
    actual_model = cfg.model
    prompt_tokens = 0
    completion_tokens = 0
    cache_tokens = 0
    usage_reasoning_tokens = 0
    usage_shape = "none"
    content_shapes: set[str] = set()
    tool_shape = "none"
    response_shape = "mapping"
    framing: str | None = None
    stream_protocol: str | None = None
    saw_terminal = False
    saw_payload = False
    saw_full_message = False
    stream_started = time.monotonic()
    time_to_first_token: float | None = None

    def mark_first_output() -> None:
        nonlocal time_to_first_token
        if time_to_first_token is None:
            time_to_first_token = time.monotonic() - stream_started

    for chunk_framing, event, payload, done_marker in _stream_payloads(response):
        if framing is None:
            framing = chunk_framing
        elif framing != chunk_framing:
            raise _EndpointProtocolError("stream mixed SSE and NDJSON framing")
        if done_marker:
            saw_terminal = True
            finish_reason = finish_reason or "stop"
            break
        if event and event.casefold() in {"ping", "keepalive"}:
            continue
        if event and event.casefold() == "error":
            raise _EndpointProtocolError(
                f"stream error event: {_provider_error_detail(payload)}"
            )
        if not isinstance(payload, Mapping):
            raise _EndpointProtocolError(
                f"stream payload must be an object; got {_shape_name(payload)}"
            )
        saw_payload = True
        if payload.get("error") not in (None, "", {}):
            raise _EndpointProtocolError(
                f"stream endpoint error: {_provider_error_detail(payload.get('error'))}"
            )

        is_ollama = _looks_like_ollama_native(payload)
        if expect_ollama_native and not is_ollama:
            raise _EndpointProtocolError(
                "explicit Ollama /api/chat stream returned a non-Ollama payload"
            )
        if is_ollama:
            if stream_protocol not in (None, "ollama-native-chat"):
                raise _EndpointProtocolError(
                    "stream mixed OpenAI and Ollama payload shapes"
                )
            stream_protocol = "ollama-native-chat"
            message = payload.get("message")
            if not isinstance(message, Mapping):
                raise _EndpointProtocolError(
                    "Ollama stream message must be an object"
                )
            actual_model = _response_model(payload, cfg)
            content_value = message.get("content")
            content_shapes.add(_shape_name(content_value))
            token = _normalize_openai_content(
                content_value,
                field_name="Ollama stream message.content",
            )
            if token:
                mark_first_output()
                parts.append(token)
                on_token(token)
            thinking_token = _normalize_openai_reasoning(
                message.get(
                    "thinking",
                    message.get("reasoning_content", message.get("reasoning")),
                ),
                field_name="Ollama stream message.thinking",
            )
            if thinking_token:
                mark_first_output()
                thinking_parts.append(thinking_token)
                if on_thinking_token is not None and (
                    not cfg.requires_native_tool_transcript
                    or capture_thinking_enabled()
                ):
                    on_thinking_token(thinking_token)
            modern_calls = message.get("tool_calls", _PROTOCOL_MISSING)
            legacy_call = message.get("function_call", _PROTOCOL_MISSING)
            if modern_calls not in (_PROTOCOL_MISSING, None, []):
                if legacy_call not in (_PROTOCOL_MISSING, None, {}):
                    raise _EndpointProtocolError(
                        "Ollama stream message contains both tool_calls and function_call"
                    )
                if tool_shape not in {"none", "tool_calls"}:
                    raise _EndpointProtocolError(
                        "stream changed tool-call protocol mid-response"
                    )
                tool_shape = "tool_calls"
                mark_first_output()
                _merge_stream_tool_calls(
                    modern_calls,
                    tool_parts,
                    field_name="Ollama stream message.tool_calls",
                )
            elif legacy_call not in (_PROTOCOL_MISSING, None, {}):
                if tool_shape not in {"none", "function_call"}:
                    raise _EndpointProtocolError(
                        "stream changed tool-call protocol mid-response"
                    )
                tool_shape = "function_call"
                mark_first_output()
                _merge_stream_tool_calls(
                    [legacy_call],
                    tool_parts,
                    field_name="Ollama stream message.function_call",
                )
            done = payload.get("done", _PROTOCOL_MISSING)
            if done is not _PROTOCOL_MISSING and not isinstance(done, bool):
                raise _EndpointProtocolError("Ollama stream done must be boolean")
            if done is True:
                saw_terminal = True
                finish_reason = _optional_string(
                    payload.get("done_reason", "stop"),
                    field_name="Ollama stream done_reason",
                ) or "stop"
                (
                    prompt_tokens,
                    completion_tokens,
                    cache_tokens,
                    usage_reasoning_tokens,
                    usage_shape,
                ) = _normalize_usage(
                    payload,
                    field_name="Ollama stream",
                    ollama_native=True,
                )
            continue

        if stream_protocol not in (None, "openai-chat-completions"):
            raise _EndpointProtocolError(
                "stream mixed Ollama and OpenAI payload shapes"
            )
        stream_protocol = "openai-chat-completions"
        choices = payload.get("choices", _PROTOCOL_MISSING)
        usage = payload.get("usage", _PROTOCOL_MISSING)
        if choices is _PROTOCOL_MISSING:
            if usage is _PROTOCOL_MISSING:
                raise _EndpointProtocolError(
                    "OpenAI stream payload has neither choices nor usage"
                )
            choices = []
        if not isinstance(choices, list):
            raise _EndpointProtocolError("OpenAI stream choices must be an array")
        actual_model = _response_model(payload, cfg)
        if usage is not _PROTOCOL_MISSING:
            (
                prompt_tokens,
                completion_tokens,
                cache_tokens,
                usage_reasoning_tokens,
                usage_shape,
            ) = _normalize_usage(usage, field_name="stream.usage")
        if not choices:
            # OpenAI include_usage sends a final usage-only chunk.
            continue
        choice = choices[0]
        if not isinstance(choice, Mapping):
            raise _EndpointProtocolError(
                "OpenAI stream choices[0] must be an object"
            )
        finish_value = choice.get("finish_reason", _PROTOCOL_MISSING)
        if finish_value not in (_PROTOCOL_MISSING, None):
            finish_reason = _optional_string(
                finish_value,
                field_name="stream.choices[0].finish_reason",
            )
            saw_terminal = True
        delta = choice.get("delta", _PROTOCOL_MISSING)
        if delta is _PROTOCOL_MISSING:
            delta = choice.get("message", _PROTOCOL_MISSING)
            if delta is not _PROTOCOL_MISSING:
                if saw_full_message:
                    raise _EndpointProtocolError(
                        "OpenAI stream contained multiple full message chunks"
                    )
                saw_full_message = True
        if delta is _PROTOCOL_MISSING:
            # A finish-only or usage-bearing chunk is valid.
            if finish_value is _PROTOCOL_MISSING and usage is _PROTOCOL_MISSING:
                raise _EndpointProtocolError(
                    "OpenAI stream choice has neither delta, message, nor finish_reason"
                )
            continue
        if delta is None and (
            finish_value is not _PROTOCOL_MISSING
            or usage is not _PROTOCOL_MISSING
        ):
            # Several compatible servers use delta=null for a terminal choice.
            continue
        if not isinstance(delta, Mapping):
            raise _EndpointProtocolError(
                "OpenAI stream delta/message must be an object"
            )
        content_value = delta.get("content")
        content_shapes.add(_shape_name(content_value))
        token = _normalize_openai_content(
            content_value,
            field_name="stream.delta.content",
        )
        if not token and delta.get("refusal") not in (None, ""):
            token = _normalize_openai_content(
                [{"type": "refusal", "refusal": delta.get("refusal")}],
                field_name="stream.delta.refusal",
            )
        if token:
            mark_first_output()
            parts.append(token)
            on_token(token)
        thinking_token = _normalize_openai_reasoning(
            delta.get("reasoning_content", delta.get("reasoning")),
            field_name="stream.delta.reasoning_content",
        )
        if thinking_token:
            mark_first_output()
            thinking_parts.append(thinking_token)
            if on_thinking_token is not None and (
                not cfg.requires_native_tool_transcript
                or capture_thinking_enabled()
            ):
                on_thinking_token(thinking_token)
        modern_calls = delta.get("tool_calls", _PROTOCOL_MISSING)
        legacy_call = delta.get("function_call", _PROTOCOL_MISSING)
        if modern_calls not in (_PROTOCOL_MISSING, None, []):
            if legacy_call not in (_PROTOCOL_MISSING, None, {}):
                raise _EndpointProtocolError(
                    "OpenAI stream delta contains both tool_calls and function_call"
                )
            if tool_shape not in {"none", "tool_calls"}:
                raise _EndpointProtocolError(
                    "stream changed tool-call protocol mid-response"
                )
            tool_shape = "tool_calls"
            mark_first_output()
            _merge_stream_tool_calls(
                modern_calls,
                tool_parts,
                field_name="stream.delta.tool_calls",
            )
        elif legacy_call not in (_PROTOCOL_MISSING, None, {}):
            if not isinstance(legacy_call, Mapping):
                raise _EndpointProtocolError(
                    "stream.delta.function_call must be an object"
                )
            if tool_shape not in {"none", "function_call"}:
                raise _EndpointProtocolError(
                    "stream changed tool-call protocol mid-response"
                )
            tool_shape = "function_call"
            mark_first_output()
            _merge_stream_tool_calls(
                [legacy_call],
                tool_parts,
                field_name="stream.delta.function_call",
            )

    if not saw_payload and not saw_terminal:
        raise _EndpointProtocolError("stream contained no response payload")
    if not saw_terminal:
        raise _EndpointProtocolError(
            "stream ended without [DONE], finish_reason, or Ollama done=true"
        )

    text, inline_thinking = split_think_blocks("".join(parts))
    provider_reasoning = "".join(thinking_parts)
    reasoning = ""
    reasoning_tokens = 0
    if capture_thinking_enabled():
        reasoning = provider_reasoning
        for block in inline_thinking:
            reasoning = (
                f"{reasoning}\n{block.strip()}".strip()
                if reasoning
                else block.strip()
            )
        reasoning_tokens = usage_reasoning_tokens
        if not reasoning_tokens and reasoning:
            reasoning_tokens = max(1, len(reasoning) // 4)

    assembled_tools: list[dict[str, Any]] = []
    malformed_tool_call = False
    for index in sorted(tool_parts):
        entry = tool_parts[index]
        name = str(entry.get("name") or "").strip()
        if not name:
            malformed_tool_call = True
            continue
        arguments = (
            entry["argumentObject"]
            if entry["argumentObject"] is not _PROTOCOL_MISSING
            else "".join(entry["argumentParts"])
        )
        assembled_tools.append({
            "id": entry["id"],
            "name": name,
            "arguments": arguments,
        })

    if completion_tokens == 0 and (text or assembled_tools):
        completion_tokens = max(1, len(text) // 4)
    protocol = stream_protocol or (
        "ollama-native-chat" if expect_ollama_native else "openai-chat-completions"
    )
    metadata = _normalization_metadata(
        protocol=protocol,
        streaming=True,
        framing=framing or ("ndjson" if expect_ollama_native else "sse"),
        content_shape=(
            next(iter(content_shapes))
            if len(content_shapes) == 1
            else "mixed" if content_shapes else "null"
        ),
        tool_shape=tool_shape,
        usage_shape=usage_shape,
        response_shape=response_shape,
    )
    return ModelResult(
        text=text,
        provider=cfg.label or "openai",
        model=actual_model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cache_tokens=cache_tokens,
        finish_reason=finish_reason or "stop",
        tool_calls=assembled_tools,
        malformed_tool_call=malformed_tool_call,
        reasoning_text=reasoning,
        reasoning_tokens=reasoning_tokens,
        raw=_attach_normalization_metadata(None, metadata),
        requires_native_tool_transcript=cfg.requires_native_tool_transcript,
        continuation_reasoning_content=(
            provider_reasoning
            if cfg.requires_native_tool_transcript and assembled_tools
            else ""
        ),
        time_to_first_token_sec=(
            round(time_to_first_token, 3)
            if time_to_first_token is not None
            else None
        ),
    )


def _resolve_context_window(preset: dict) -> int | None:
    """Total input+output window for this endpoint, in tokens.

    ``SOPHIA_CONTEXT_WINDOW`` overrides everything (an operator serving the same
    model at a shorter ``--max-model-len`` needs to say so). Otherwise the
    preset's declared value, else ``None`` for "unknown" — never a guess, because
    over-estimating truncates silently at the provider and reads as the model
    forgetting rather than as a misconfiguration.
    """
    raw = os.environ.get("SOPHIA_CONTEXT_WINDOW")
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value
    declared = preset.get("context_window")
    return int(declared) if declared else None


#: Every tool-rule prefix the grok CLI documents (user-guide 14-headless-mode,
#: "Permission Rules"), denied wholesale so the CLI cannot act on its own.
#:
#: Bare prefixes are used deliberately: grok's docs state that "a bare prefix
#: without parentheses matches all invocations of that type", and that deny
#: beats ask beats allow regardless of --permission-mode or the operator's
#: ~/.grok/config.toml. Denying the PREFIX taxonomy rather than enumerating
#: internal tool ids (run_terminal_cmd, search_replace, ...) is what makes this
#: fail closed: an unknown or newly-added tool still falls under its prefix,
#: whereas a missed id in --disallowed-tools is accepted silently and fails OPEN
#: (measured: `--disallowed-tools bogus_tool` ran without complaint).
GROK_DENY_PREFIXES = ("Bash", "Edit", "Write", "WebFetch", "MCPTool")

#: Turn budget for the grok CLI's own agent loop.
#:
#: It was 8, which is fine when nothing is blocked and far too tight when
#: something is: grok spends turns ATTEMPTING a denied tool, being refused, and
#: retrying ("Permission blocked the shell; switching to filesystem…"), so a
#: prompt that wants to explore exhausts the budget and the run dies with
#: "Error: max turns reached" — a hard failure with no answer at all. Measured
#: on a repo-analysis prompt: 8 turns -> rc=1 max-turns on every deny
#: configuration tried; 30 turns -> rc=0 with a full answer.
GROK_MAX_TURNS = "30"

# ``grok models`` is a metadata/authentication request, not a generation. Run it
# immediately before each CLI generation so an expired grok.com session fails
# as a typed authentication error instead of occupying the full generation
# timeout. Grok 1.0.3 normally returns this in roughly 1.5 seconds; the existing
# provider-health probe also accepts an advertised model captured before a
# telemetry-only shutdown timeout.
GROK_PREFLIGHT_TIMEOUT_SEC = 10.0
_GROK_PREFLIGHT_TIMEOUT_SEC = GROK_PREFLIGHT_TIMEOUT_SEC


def grok_preflight_timeout_sec(
    environ: Mapping[str, str] | None = None,
) -> float:
    """Return the bounded no-spend Grok CLI preflight timeout."""

    env = os.environ if environ is None else environ
    raw = str(env.get("SOPHIA_GROK_PREFLIGHT_TIMEOUT_SEC", "")).strip()
    try:
        value = float(raw) if raw else GROK_PREFLIGHT_TIMEOUT_SEC
    except (TypeError, ValueError, OverflowError):
        value = GROK_PREFLIGHT_TIMEOUT_SEC
    if not math.isfinite(value):
        value = GROK_PREFLIGHT_TIMEOUT_SEC
    return min(30.0, max(3.0, value))

# One CLI process (and any leader it starts) is owned by exactly one transport
# call. A short grace keeps cancellation bounded without leaving a first-wave
# process behind to interfere with queued workflow workers.
_GROK_PROCESS_STOP_GRACE_SEC = 1.0
_GROK_TERMINAL_STREAM_EVENTS = frozenset(
    {"auto_compact_failed", "error", "max_turns_reached"}
)
_GROK_FAIL_FAST_STDERR_CODES = frozenset(
    {
        ProviderErrorCode.AUTHENTICATION,
        ProviderErrorCode.AUTHORIZATION,
        ProviderErrorCode.MISSING_CREDENTIALS,
    }
)

ProviderProgressCallback = Callable[[dict[str, Any]], None]


def _emit_provider_progress(
    callback: ProviderProgressCallback | None,
    *,
    phase: str,
    provider: str,
    model: str,
    status: str = "",
    detail: str = "",
    **fields: Any,
) -> None:
    """Emit a secret-free provider lifecycle update without risking the call.

    This is deliberately a small, provider-neutral vocabulary. Transports may
    add safe counters and identifiers, but prompts, hidden reasoning, tool
    arguments, tool output, credentials, and response bodies never belong in
    this channel. Rich provider streams (currently Grok's ACP-derived
    ``streaming-json``) are projected into the same shape as generic HTTP/CLI
    lifecycle events so the TUI does not need one progress UI per vendor.
    """
    if not callable(callback):
        return
    payload: dict[str, Any] = {
        "phase": str(phase or "activity"),
        "provider": str(provider or ""),
        "model": str(model or ""),
    }
    if status:
        payload["status"] = str(status)
    if detail:
        payload["detail"] = str(detail)[:240]
    for key, value in fields.items():
        if value is None or value == "":
            continue
        if isinstance(value, (bool, int, float, str)):
            payload[key] = value
    try:
        callback(payload)
    except Exception:
        # Progress is observability, never a reason to fail a paid generation.
        pass


# Short and hard: a context-window probe that hangs is worse than one that
# fails, because it sits on the critical path of picking a model. Local
# servers answer this in milliseconds when they answer at all.
_CONTEXT_WINDOW_PROBE_TIMEOUT_SEC = 3

# Per-process cache of live-probed context windows, keyed by (base_url, model).
# The probe hits a real socket, and the same (server, model) pair is asked
# about repeatedly across a session (every /model switch, every startup) --
# without this a slow/unreachable server would re-pay its own timeout on each
# call instead of once.
_CONTEXT_WINDOW_CACHE: dict[tuple[str, str], int | None] = {}


def _probe_json(url: str, *, method: str = "GET", body: dict | None = None, key: str | None = None) -> Any:
    """Fetch and parse one small JSON document with a short, hard timeout.

    Raises on any failure -- callers decide what "unknown" means for their
    shape; this helper only owns the transport, not the fallback.
    """
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if key:
        # The local oMLX server on this machine 401s /v1/models without this --
        # measured live: same request, no Authorization header, 401; with it, 200.
        # A local server with no auth configured just ignores an extra header.
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=_CONTEXT_WINDOW_PROBE_TIMEOUT_SEC) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def _detect_openai_context_window(base_url: str, model: str, key: str | None = None) -> int | None:
    """GET {base_url}/models and read max_model_len for the matching id.

    This is the shape the local oMLX/vLLM OpenAI-compatible servers on this
    machine actually return (verified against a live oMLX instance) -- SGLang
    and llama.cpp's server are the same family of endpoint, so the same probe
    covers all of them. Anything else about the payload (missing "data", a
    model id that isn't listed, a non-numeric field) reads as "unknown", not
    as zero -- a model with a REAL small window and one this server simply
    didn't report must not look the same to a caller deciding whether to warn.
    """
    try:
        payload = _probe_json(f"{base_url.rstrip('/')}/models", key=key)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    for entry in payload.get("data") or []:
        if not isinstance(entry, dict) or entry.get("id") != model:
            continue
        value = entry.get("max_model_len")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            return int(value)
        return None  # matching id found but no usable length -- stop, don't guess from another model
    return None


def _detect_ollama_context_window(base_url: str, model: str) -> int | None:
    """POST {host}/api/show and read the context length out of model_info.

    ollama serves an OpenAI-compatible ``/v1`` surface for chat, but that
    surface's ``/v1/models`` carries no length field (verified against a live
    daemon) -- only the NATIVE ``/api/show`` does, and it reports the length
    under a vendor/architecture-prefixed key (e.g. ``"qwen35moe.context_length"``,
    ``"llama.context_length"``) rather than one fixed name, because the key
    mirrors the gguf metadata field for whatever architecture the model is.
    Scanning for the ``*.context_length`` suffix is what makes this work across
    architectures without hardcoding a family list that goes stale.
    """
    host = base_url.rstrip("/")
    if host.endswith("/v1"):
        host = host[: -len("/v1")]
    try:
        payload = _probe_json(f"{host}/api/show", method="POST", body={"name": model})
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    model_info = payload.get("model_info")
    if isinstance(model_info, dict):
        for key, value in model_info.items():
            if (isinstance(key, str) and key.endswith(".context_length")
                    and isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0):
                return int(value)
    # Older ollama (or a gguf whose metadata omits *.context_length) still lets an
    # operator pin the window explicitly via a Modelfile ``PARAMETER num_ctx`` line,
    # which /api/show echoes back as free text in "parameters" rather than JSON --
    # worth one more look before giving up and calling it unknown.
    parameters = payload.get("parameters")
    if isinstance(parameters, str):
        for line in parameters.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "num_ctx":
                try:
                    value = int(float(parts[1]))
                except ValueError:
                    continue
                if value > 0:
                    return value
    return None


def detect_context_window(cfg: "ModelConfig") -> int | None:
    """Best-effort LIVE discovery of an endpoint's context window.

    PRESETS declares no ``context_window`` for ollama/vllm/sglang/llamacpp/mlx
    because one preset entry serves whatever model an operator happens to have
    pulled -- a static number would be right for one model and silently wrong
    (an unfired overflow warning, or a bogus one) for the next. This asks the
    server what it is actually running instead.

    Total fail-soft, by design: a probe that raises or hangs would sit on the
    critical path of picking a model, and the cost of staying silent (no
    overflow warning) is far smaller than the cost of a model call that can't
    start because a context-window check threw or blocked. Returns ``None`` on
    literally anything unexpected -- down server, malformed JSON, model absent
    from the response, wrong shape entirely.
    """
    base = (cfg.base_url or "").strip()
    model = (cfg.model or "").strip()
    if not base or not model:
        return None
    # Saved custom endpoints have an explicit, consented diagnostic path in
    # /model connections. Do not make an implicit /models request here, where
    # the generic legacy probe follows ambient urllib proxy/redirect behavior.
    if cfg.endpoint_scope:
        return None
    cache_key = (base, model)
    if cache_key in _CONTEXT_WINDOW_CACHE:
        return _CONTEXT_WINDOW_CACHE[cache_key]
    window: int | None = None
    try:
        if cfg.kind == "openai":
            window = (_detect_ollama_context_window(base, model) if cfg.label == "ollama"
                      else _detect_openai_context_window(base, model, key=cfg.resolved_key()))
        # mlx (on-device) and every CLI transport (grok/codex/openclaw/pi-ai) have no
        # server to probe -- PRESETS/SOPHIA_CONTEXT_WINDOW stay the only source there.
    except Exception:  # noqa: BLE001 -- a probe helper bug must not become a model-call bug
        window = None
    _CONTEXT_WINDOW_CACHE[cache_key] = window
    return window


def resolve_config_with_live_context_window(spec: str | None = None) -> ModelConfig:
    """``resolve_config()`` plus one live probe for a local endpoint's real window.

    ``resolve_config()`` itself stays probe-free on purpose: it re-resolves
    from the live environment on essentially every model call (see
    ``ModelClient.generate``), and ``detect_context_window`` opens a real
    socket -- paying that round trip on every single turn would tax every
    call for a number that only ever changes when the operator switches
    models or restarts the local server. This wrapper is the explicit,
    opt-in entry point for the one place that actually wants a fresh answer:
    a ``/model`` switch (or an equivalent bridge model-select path calling in
    at startup/switch time, not per turn).

    Scoped to local ``kind="openai"`` endpoints (vllm/ollama/sglang/llamacpp/
    omlx) with no already-declared ``context_window`` -- a cloud preset
    missing one (e.g. the bare ``openai`` preset) is left alone rather than
    spending a live request against someone's paid API for a field their
    ``/v1/models`` will not even return. A probe failure (down server,
    unreachable host, malformed reply) returns ``resolve_config()``'s result
    completely UNCHANGED -- this never raises and never mutates a resolved
    config into something the caller didn't ask for.
    """
    cfg = resolve_config(spec)
    if cfg.context_window is not None or cfg.kind != "openai" or not is_local_model(cfg):
        return cfg
    window = detect_context_window(cfg)
    if window is None:
        return cfg
    return replace(cfg, context_window=window)


#: Every tool-rule prefix the grok CLI documents (user-guide 14-headless-mode,
#: "Permission Rules"), denied wholesale so the CLI cannot act on its own.
#:
#: Bare prefixes are used deliberately: grok's docs state that "a bare prefix
#: without parentheses matches all invocations of that type", and that deny
#: beats ask beats allow regardless of --permission-mode or the operator's
#: ~/.grok/config.toml. Denying the PREFIX taxonomy rather than enumerating
#: internal tool ids (run_terminal_cmd, search_replace, ...) is what makes this
#: fail closed: an unknown or newly-added tool still falls under its prefix,
#: whereas a missed id in --disallowed-tools is accepted silently and fails OPEN
#: (measured: `--disallowed-tools bogus_tool` ran without complaint).
GROK_DENY_PREFIXES = ("Bash", "Edit", "Write", "WebFetch", "MCPTool")

#: Turn budget for the grok CLI's own agent loop.
#:
#: It was 8, which is fine when nothing is blocked and far too tight when
#: something is: grok spends turns ATTEMPTING a denied tool, being refused, and
#: retrying ("Permission blocked the shell; switching to filesystem…"), so a
#: prompt that wants to explore exhausts the budget and the run dies with
#: "Error: max turns reached" — a hard failure with no answer at all. Measured
#: on a repo-analysis prompt: 8 turns -> rc=1 max-turns on every deny
#: configuration tried; 30 turns -> rc=0 with a full answer.
GROK_MAX_TURNS = "30"


GROK_CLI_WORKER_READ_ONLY_COMPATIBLE_TOOLS = frozenset(
    {
        "glob",
        "grep",
        "grep_runtime",
        "list_dir",
        "read_batch",
        "read_file",
        "read_runtime_file",
    }
)


def grok_cli_worker_unavailable_tools(
    requested_tools: Sequence[str] | None,
    *,
    harness_owned_tools: Sequence[str] = (),
) -> tuple[str, ...]:
    """Return requested native tools unavailable to a Grok CLI worker.

    Grok CLI workers are provider-side read-only inspectors, not
    Sophia-native tool workers. A harness may execute an explicitly contracted
    check before the model; excluding that one harness-owned tool here never
    enables it inside Grok.
    """

    owned = {
        str(tool or "").strip().lower().replace("-", "_")
        for tool in harness_owned_tools
        if str(tool or "").strip()
    }
    requested = {
        str(tool or "").strip().lower().replace("-", "_")
        for tool in requested_tools or ()
        if str(tool or "").strip()
    }
    return tuple(
        sorted(
            requested
            - GROK_CLI_WORKER_READ_ONLY_COMPATIBLE_TOOLS
            - owned
        )
    )


def _grok_command(
    prompt_file: Path,
    run_cwd: Path,
    model: str = "",
    *,
    leader_socket: Path | None = None,
) -> list[str]:
    """Argv for the grok CLI, held read-only.

    The grok CLI is an AGENT, not a completion endpoint: inside one generate()
    call it runs its own loop with its own file tools. Sophia therefore records
    ZERO tool steps for a grok turn, and `execute_tool`'s permission gate never
    sees the work — it cannot gate what it is never asked about.

    Measured on grok 0.2.112 with the previous argv (``--no-plan``, no
    permission mode): a ``run_agent_loop`` at ``permission="readonly"`` asked
    for a file to be created, Sophia executed 0 tools, and the file was on disk
    afterwards. It also read a file outside ``--cwd`` when asked to find one.

    ``--permission-mode plan`` plus a deny list is the fix that exists at the
    CLI boundary. It is passed UNCONDITIONALLY rather than mapped from Sophia's
    permission setting, because a transport's job is to return text — nothing
    Sophia asks a model to *say* should ever mutate the machine. Tried and
    rejected: ``--max-turns 1`` (still wrote, and then failed the turn) and
    ``--tools ""`` (silently ignored; still wrote).

    WHAT IS DENIED, AND WHY NOT MORE. The deny list covers the MUTATING and
    EXFILTRATING prefixes — Bash, Edit, Write, WebFetch, MCPTool — and
    deliberately leaves Read and Grep alone.

    Denying reads as well was tried and REVERTED, because it made the transport
    useless for the thing people actually ask it: "what is this repo about?"
    Measured on that prompt, with reads denied, grok spent its turns attempting
    a blocked tool, being refused, and retrying ("Permission blocked the shell;
    switching to filesystem…") until the budget was gone — rc=1, "Error: max
    turns reached", no answer. Removing the tools outright
    (``--disallowed-tools``) did not help either: still rc=1, and with an EMPTY
    transcript. Nor did instructing it, in the system-prompt override, to emit
    Sophia's JSON tool protocol instead — it never emitted one. grok's loop
    cannot be talked into behaving as a plain completion endpoint.

    With reads allowed the same prompt returns a grounded 14.8K-character
    analysis, and the safety property that motivated the deny list still holds:
    asked to create a file it answers "write and shell are both blocked by
    policy" and nothing lands on disk (verified).

    HONEST RESIDUAL. Those reads happen inside the CLI, so they carry no
    receipt, no secret redaction, and no execution budget — Sophia records zero
    tool steps for a grok turn and cannot gate what it is never asked about.
    What is bounded is the damage: no writes, no shell, no network fetch, no MCP.
    When the harness must OWN tool use, use the ``xai`` / ``grok-4.5`` preset —
    the separately authenticated Grok 4.5 API route, where Sophia stays the
    agent. See PRESETS.
    """
    command = [
        "grok", "--prompt-file", str(prompt_file), "--cwd", str(run_cwd),
        # grok-build exposes its native ACP session updates as one JSON object
        # per line. The previous plain mode buffered the whole subprocess, so
        # Sophia could show only a generic 30-second heartbeat and the final
        # answer. streaming-json gives us typed plan/tool/usage/end events while
        # preserving the same read-only transport boundary below.
        "--output-format", "streaming-json", "--max-turns", GROK_MAX_TURNS,
        # Read-only baseline: see the docstring. Note --no-plan is deliberately
        # NOT passed; it disables the very mode doing the containment.
        "--permission-mode", "plan",
        "--no-memory", "--no-subagents", "--disable-web-search", "--verbatim",
        "--system-prompt-override", "You are Sophia's answerer. Answer directly from the prompt and provided context.",
    ]
    # Grok 1.0.3 otherwise discovers the shared ~/.grok/leader.sock. Workflow
    # workers execute concurrently, so every call gets a private socket instead
    # of sharing lifecycle/auth state with another worker's leader.
    if leader_socket is not None:
        command += ["--leader-socket", str(leader_socket)]
    # Deny the WHOLE documented tool taxonomy, so the CLI stops being an agent
    # and becomes a completion engine — which is what Sophia's loop needs.
    for prefix in GROK_DENY_PREFIXES:
        command += ["--deny", prefix]
    # The CLI does accept -m/--model (verified: `grok --help`, `grok models`).
    # Passing it is what lets cfg.model stop being a placeholder, so the TUI can
    # report the model that actually answered rather than a literal "grok-cli".
    # Never send the Sophia provider alias ``grok`` — the CLI rejects it as
    # ``unknown model id``.
    cli_model = canonical_grok_cli_model(model)
    if cli_model:
        command += ["--model", cli_model]
    return command


@dataclass
class _GrokStreamState:
    text_parts: list[str] = field(default_factory=list)
    tool_names: dict[str, str] = field(default_factory=dict)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_tokens: int = 0
    reasoning_tokens: int = 0
    finish_reason: str | None = None
    error: str | None = None
    error_info: ProviderError | None = None
    end_seen: bool = False
    first_activity_at: float | None = None
    reasoning_started: bool = False
    generation_started: bool = False


def _grok_usage_fields(value: Any) -> tuple[int, int, int, int]:
    if not isinstance(value, Mapping):
        return 0, 0, 0, 0

    def count(*names: str) -> int:
        for name in names:
            raw = value.get(name)
            if isinstance(raw, bool):
                continue
            if isinstance(raw, (int, float)):
                return max(0, int(raw))
        return 0

    return (
        count("input_tokens", "inputTokens", "prompt_tokens"),
        count("output_tokens", "outputTokens", "completion_tokens"),
        count("cache_read_input_tokens", "cacheReadInputTokens", "cache_tokens"),
        count("reasoning_tokens", "reasoningTokens"),
    )


def _consume_grok_stream_event(
    event: Mapping[str, Any],
    state: _GrokStreamState,
    *,
    cfg: ModelConfig,
    started: float,
    on_token: Callable[[str], None] | None,
    on_thinking_token: Callable[[str], None] | None,
    on_provider_progress: ProviderProgressCallback | None,
) -> None:
    """Project one grok-build streaming-json line into Sophia callbacks.

    The ACP stream includes raw tool inputs/outputs plus ``thought`` records
    that Grok deliberately publishes on its user-visible streaming-json
    surface. Those values stay on their dedicated channels: response text goes
    to ``on_token`` and provider-published thought text goes to the dedicated
    thinking callback. Provider progress receives only status, names,
    identifiers, and counters, preventing it from becoming a secret or hidden
    chain-of-thought side channel.
    """
    kind = str(event.get("type") or "").strip().casefold()
    if not kind:
        raise _EndpointProtocolError("grok streaming-json event is missing type")
    if state.first_activity_at is None and kind not in {"available_commands"}:
        state.first_activity_at = max(0.0, time.monotonic() - started)

    if kind == "text":
        data = event.get("data")
        if not isinstance(data, str):
            raise _EndpointProtocolError("grok text event data must be a string")
        state.text_parts.append(data)
        if on_token and data:
            on_token(data)
        # Token streaming already drives the live answer. Emit one lifecycle
        # transition instead of one Flow node per text delta.
        if not state.generation_started:
            state.generation_started = True
            _emit_provider_progress(
                on_provider_progress,
                phase="generating",
                provider="grok",
                model=cfg.model,
                status="in_progress",
                detail="writing response",
            )
        return
    if kind == "thought":
        data = event.get("data")
        if not isinstance(data, str):
            raise _EndpointProtocolError("grok thought event data must be a string")
        # Grok published this record on its visible streaming-json transport;
        # establish the provider identity before forwarding the first text
        # chunk so a fail-closed UI can authorize it without guessing. The
        # provider-neutral progress stream never carries the text itself.
        if not state.reasoning_started:
            state.reasoning_started = True
            _emit_provider_progress(
                on_provider_progress,
                phase="reasoning",
                provider="grok",
                model=cfg.model,
                status="in_progress",
                detail="provider reasoning",
            )
        if on_thinking_token and data:
            on_thinking_token(data)
        return
    if kind == "plan":
        entries = event.get("entries")
        count = len(entries) if isinstance(entries, list) else None
        _emit_provider_progress(
            on_provider_progress,
            phase="planning",
            provider="grok",
            model=cfg.model,
            status="in_progress",
            detail=f"plan updated · {count} steps" if count is not None else "plan updated",
            planSteps=count,
        )
        return
    if kind == "tool_call":
        call_id = str(event.get("toolCallId") or "").strip()
        tool = str(event.get("toolName") or event.get("title") or "provider tool").strip()
        status = str(event.get("status") or "in_progress").strip()
        if call_id:
            state.tool_names[call_id] = tool
        _emit_provider_progress(
            on_provider_progress,
            phase="provider_tool",
            provider="grok",
            model=cfg.model,
            status=status,
            detail=f"{tool} · delegated-provider tool",
            tool=tool,
            toolCallId=call_id,
        )
        return
    if kind == "tool_call_update":
        call_id = str(event.get("toolCallId") or "").strip()
        tool = state.tool_names.get(call_id, "provider tool")
        status = str(event.get("status") or "in_progress").strip()
        _emit_provider_progress(
            on_provider_progress,
            phase="provider_tool",
            provider="grok",
            model=cfg.model,
            status=status,
            detail=f"{tool} · delegated-provider tool",
            tool=tool,
            toolCallId=call_id,
        )
        return
    if kind == "usage":
        prompt, completion, cache, reasoning = _grok_usage_fields(event.get("usage"))
        state.prompt_tokens += prompt
        state.completion_tokens += completion
        state.cache_tokens += cache
        state.reasoning_tokens += reasoning
        stop_reason = event.get("stopReason")
        if isinstance(stop_reason, str) and stop_reason.strip():
            state.finish_reason = stop_reason.strip()
        _emit_provider_progress(
            on_provider_progress,
            phase="generating",
            provider="grok",
            model=cfg.model,
            status="response_boundary",
            detail="response boundary",
            promptTokens=state.prompt_tokens,
            completionTokens=state.completion_tokens,
            reasoningTokens=state.reasoning_tokens,
        )
        return
    if kind == "auto_compact_started":
        percentage = event.get("percentage")
        _emit_provider_progress(
            on_provider_progress,
            phase="compacting",
            provider="grok",
            model=cfg.model,
            status="in_progress",
            detail=(
                f"context compaction · {int(percentage)}%"
                if isinstance(percentage, (int, float)) and not isinstance(percentage, bool)
                else "context compaction"
            ),
        )
        return
    if kind in {"auto_compact_completed", "auto_compact_cancelled"}:
        _emit_provider_progress(
            on_provider_progress,
            phase="compacting",
            provider="grok",
            model=cfg.model,
            status="completed" if kind.endswith("completed") else "cancelled",
            detail=kind.replace("_", " "),
        )
        return
    if kind == "auto_compact_failed":
        state.error = _redact_error_text(str(event.get("error") or "grok compaction failed"))
        _emit_provider_progress(
            on_provider_progress,
            phase="error",
            provider="grok",
            model=cfg.model,
            status="failed",
            detail="context compaction failed",
        )
        return
    if kind == "max_turns_reached":
        state.error = "grok maximum turns reached"
        state.finish_reason = "max_turns_reached"
        _emit_provider_progress(
            on_provider_progress,
            phase="error",
            provider="grok",
            model=cfg.model,
            status="failed",
            detail=state.error,
        )
        return
    if kind == "error":
        state.error = _redact_error_text(str(event.get("message") or "grok provider error"))
        state.error_info = classify_provider_error(
            state.error,
            provider="grok",
            model=cfg.model,
        )
        _emit_provider_progress(
            on_provider_progress,
            phase="error",
            provider="grok",
            model=cfg.model,
            status="failed",
            detail=state.error,
        )
        return
    if kind == "end":
        state.end_seen = True
        stop_reason = event.get("stopReason")
        state.finish_reason = (
            str(stop_reason).strip()
            if isinstance(stop_reason, str) and stop_reason.strip()
            else state.finish_reason or "stop"
        )
        prompt, completion, cache, reasoning = _grok_usage_fields(event.get("usage"))
        # ``end`` repeats final spend. Prefer it only when no per-response usage
        # lines were observed, otherwise adding it would double count.
        if not any(
            (
                state.prompt_tokens,
                state.completion_tokens,
                state.cache_tokens,
                state.reasoning_tokens,
            )
        ):
            state.prompt_tokens = prompt
            state.completion_tokens = completion
            state.cache_tokens = cache
            state.reasoning_tokens = reasoning
        _emit_provider_progress(
            on_provider_progress,
            phase="finalizing",
            provider="grok",
            model=cfg.model,
            status="completed",
            detail=f"turn ended · {state.finish_reason}",
            promptTokens=state.prompt_tokens,
            completionTokens=state.completion_tokens,
            reasoningTokens=state.reasoning_tokens,
        )
        return
    if kind in {
        "available_commands",
        "auto_continue_completed",
        "image_compressed",
    }:
        # Safe lifecycle-only projection; command lists and image messages may
        # contain workspace detail, so they are intentionally not forwarded.
        _emit_provider_progress(
            on_provider_progress,
            phase="activity",
            provider="grok",
            model=cfg.model,
            status="in_progress",
            detail=kind.replace("_", " "),
        )
        return
    # grok-build documents the event list as non-exhaustive. Unknown typed
    # lifecycle events remain visible by name without retaining their payload.
    _emit_provider_progress(
        on_provider_progress,
        phase="activity",
        provider="grok",
        model=cfg.model,
        status="in_progress",
        detail=f"provider event · {kind}",
    )


def _signal_owned_grok_process(
    proc: subprocess.Popen[str],
    sig: signal.Signals,
) -> None:
    """Signal one Grok call's private process group, with a direct-child fallback."""
    if os.name == "posix":
        try:
            os.killpg(proc.pid, sig)
            return
        except ProcessLookupError:
            return
        except OSError:
            # Fall back to the direct child if process-group signaling is not
            # available despite start_new_session=True.
            pass
    if sig == signal.SIGTERM:
        proc.terminate()
    else:
        proc.kill()


def _stop_owned_grok_process(proc: subprocess.Popen[str]) -> None:
    """Stop only the Grok process group owned by this transport call."""
    if proc.poll() is not None:
        return
    _signal_owned_grok_process(proc, signal.SIGTERM)
    try:
        proc.wait(timeout=_GROK_PROCESS_STOP_GRACE_SEC)
    except subprocess.TimeoutExpired:
        _signal_owned_grok_process(
            proc,
            getattr(signal, "SIGKILL", signal.SIGTERM),
        )
        try:
            proc.wait(timeout=_GROK_PROCESS_STOP_GRACE_SEC)
        except subprocess.TimeoutExpired:
            # The caller must not exceed its own deadline because a broken CLI
            # ignored both signals. The process group and private leader socket
            # keep any residual damage isolated to this call.
            pass


def _grok_preflight(
    cfg: ModelConfig,
    *,
    on_provider_progress: ProviderProgressCallback | None,
) -> tuple[ProviderError | None, dict[str, Any]]:
    """Run the authoritative no-spend Grok model/authentication probe."""
    _emit_provider_progress(
        on_provider_progress,
        phase="preflight",
        provider="grok",
        model=cfg.model,
        status="in_progress",
        detail="checking Grok authentication and model availability",
    )
    try:
        # Lazy import avoids provider_health -> model's module-level dependency
        # becoming a circular import.
        from agent.provider_health import probe_provider

        report = probe_provider(
            cfg,
            timeout=grok_preflight_timeout_sec(),
            run=_run_grok_preflight_command,
        )
    except Exception as exc:  # noqa: BLE001 - preflight fails closed and typed
        info = classify_provider_error(
            exc,
            provider="grok",
            model=cfg.model,
        )
        receipt = {
            "schema": "sophia.grok-preflight.v1",
            "ok": False,
            "state": "unavailable",
            "error": info.to_dict(),
            "paidProbeMade": False,
        }
    else:
        receipt = report.to_dict()
        if report.ok:
            _emit_provider_progress(
                on_provider_progress,
                phase="preflight",
                provider="grok",
                model=cfg.model,
                status="succeeded",
                detail="Grok authentication and model are ready",
            )
            return None, receipt
        info = report.error or ProviderError(
            code=(
                ProviderErrorCode.MODEL_NOT_FOUND
                if str(getattr(report.state, "value", report.state)) == "degraded"
                else ProviderErrorCode.CONFIGURATION
            ),
            message=(
                "Grok CLI preflight did not advertise the configured model"
                if str(getattr(report.state, "value", report.state)) == "degraded"
                else "Grok CLI preflight did not reach a ready state"
            ),
            provider="grok",
            model=cfg.model,
            retryable=False,
        )
    _emit_provider_progress(
        on_provider_progress,
        phase="preflight",
        provider="grok",
        model=cfg.model,
        status="failed",
        detail=info.code.value,
    )
    return info, receipt


def _grok_preflight_command_output(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value or "")


def _run_grok_preflight_command(
    command: Sequence[str],
    **kwargs: Any,
) -> subprocess.CompletedProcess[str]:
    """Preserve an auth message emitted before Grok's interactive 300s wait.

    The authoritative provider-health probe intentionally accepts
    ``subprocess.run``-compatible injection. Grok 1.0.3 may print a terminal 401
    and then wait for browser/device authentication; converting that bounded
    timeout into a non-zero completed process lets the existing probe classify
    the real authentication failure instead of the later shutdown timeout.
    """
    try:
        return subprocess.run(command, **kwargs)
    except subprocess.TimeoutExpired as exc:
        stdout = _grok_preflight_command_output(
            exc.stdout if exc.stdout is not None else exc.output
        )
        stderr = _grok_preflight_command_output(exc.stderr)
        info = classify_provider_error(
            "\n".join(part for part in (stderr, stdout) if part),
            provider="grok",
            model="",
        )
        if info.code in _GROK_FAIL_FAST_STDERR_CODES:
            return subprocess.CompletedProcess(
                args=command,
                returncode=1,
                stdout=stdout,
                stderr=info.message,
            )
        raise


def _call_grok(
    system: str,
    user: str,
    cfg: ModelConfig,
    *,
    on_token: Callable[[str], None] | None = None,
    on_thinking_token: Callable[[str], None] | None = None,
    on_provider_progress: ProviderProgressCallback | None = None,
    should_cancel: Callable[[], bool] | None = None,
    **_: Any,
) -> ModelResult:
    prompt = f"{system}\n\n{user}"
    preflight_error, preflight_receipt = _grok_preflight(
        cfg,
        on_provider_progress=on_provider_progress,
    )
    if preflight_error is not None:
        return ModelResult(
            text="",
            provider="grok",
            model=cfg.model,
            ok=False,
            error=preflight_error.message,
            error_info=preflight_error,
            finish_reason=preflight_error.code.value,
            raw={"preflight": preflight_receipt},
        )
    run_cwd = mutable_path("private", "agent-grok-cwd")
    run_cwd.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=run_cwd, prefix="sophia-prompt-", suffix=".md", delete=False) as handle:
        handle.write(prompt)
        prompt_file = Path(handle.name)
    started = time.monotonic()
    state = _GrokStreamState()
    proc: subprocess.Popen[str] | None = None
    leader_directory: tempfile.TemporaryDirectory[str] | None = None
    try:
        leader_directory = tempfile.TemporaryDirectory(
            dir=run_cwd,
            prefix="sophia-grok-leader-",
        )
        leader_socket = Path(leader_directory.name) / "leader.sock"
        command = _grok_command(
            prompt_file,
            run_cwd,
            cfg.model,
            leader_socket=leader_socket,
        )
        popen_kwargs: dict[str, Any] = {}
        if os.name == "posix":
            popen_kwargs["start_new_session"] = True
        proc = subprocess.Popen(
            command,
            cwd=run_cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            **popen_kwargs,
        )
        output: "queue.Queue[tuple[str, str | None]]" = queue.Queue()

        def read_stream(name: str, stream: Any) -> None:
            try:
                for line in iter(stream.readline, ""):
                    output.put((name, line))
            finally:
                output.put((name, None))

        readers = [
            threading.Thread(
                target=read_stream,
                args=("stdout", proc.stdout),
                name="sophia-grok-stdout",
                daemon=True,
            ),
            threading.Thread(
                target=read_stream,
                args=("stderr", proc.stderr),
                name="sophia-grok-stderr",
                daemon=True,
            ),
        ]
        for reader in readers:
            reader.start()
        closed: set[str] = set()
        stderr_tail = ""
        protocol_error = ""
        cancelled = False
        timed_out = False
        deadline = started + max(0.1, float(cfg.timeout_sec))
        while len(closed) < 2 or proc.poll() is None:
            if should_cancel is not None and should_cancel():
                cancelled = True
                _stop_owned_grok_process(proc)
            if time.monotonic() >= deadline and proc.poll() is None:
                timed_out = True
                _stop_owned_grok_process(proc)
            try:
                source, line = output.get(timeout=0.05)
            except queue.Empty:
                if cancelled or timed_out:
                    break
                continue
            if line is None:
                closed.add(source)
                continue
            if source == "stderr":
                stderr_tail = (stderr_tail + line)[-2000:]
                stderr_info = classify_provider_error(
                    line,
                    provider="grok",
                    model=cfg.model,
                )
                if stderr_info.code in _GROK_FAIL_FAST_STDERR_CODES:
                    state.error = stderr_info.message
                    state.error_info = stderr_info
                    _stop_owned_grok_process(proc)
                    break
                continue
            stripped = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
            if not stripped:
                continue
            try:
                event = json.loads(stripped)
                if not isinstance(event, Mapping):
                    raise _EndpointProtocolError("grok streaming-json line must be an object")
                event_type = str(event.get("type") or "").strip().casefold()
                _consume_grok_stream_event(
                    event,
                    state,
                    cfg=cfg,
                    started=started,
                    on_token=on_token,
                    on_thinking_token=on_thinking_token,
                    on_provider_progress=on_provider_progress,
                )
                if event_type in _GROK_TERMINAL_STREAM_EVENTS:
                    _stop_owned_grok_process(proc)
                    break
            except (json.JSONDecodeError, _EndpointProtocolError) as exc:
                protocol_error = f"invalid grok streaming-json: {exc}"
                _stop_owned_grok_process(proc)
                break
        for reader in readers:
            reader.join(timeout=0.2)
        return_code = proc.wait(timeout=_GROK_PROCESS_STOP_GRACE_SEC)
        text = "".join(state.text_parts).strip()
        if cancelled:
            error = "grok CLI cancelled"
            finish_reason = "cancel"
        elif timed_out:
            error = f"grok CLI timed out after {cfg.timeout_sec}s"
            finish_reason = "timeout"
        elif protocol_error:
            error = protocol_error
            finish_reason = "protocol_error"
        elif state.error:
            error = state.error
            finish_reason = (
                state.error_info.code.value
                if state.error_info is not None
                else state.finish_reason or "error"
            )
        elif return_code != 0:
            error = _redact_error_text(stderr_tail.strip() or f"grok exited {return_code}")
            finish_reason = state.finish_reason or "error"
        elif not state.end_seen:
            error = "grok streaming-json ended without a terminal end event"
            finish_reason = "protocol_error"
        elif not text:
            error = "grok streaming-json produced no usable text"
            finish_reason = state.finish_reason or "empty"
        else:
            error = None
            finish_reason = state.finish_reason or "stop"
        ok = error is None
        return ModelResult(
            text=text,
            provider="grok",
            model=cfg.model,
            ok=ok,
            error=error,
            error_info=state.error_info,
            prompt_tokens=state.prompt_tokens,
            completion_tokens=state.completion_tokens,
            cache_tokens=state.cache_tokens,
            reasoning_tokens=state.reasoning_tokens,
            finish_reason=finish_reason,
            time_to_first_token_sec=state.first_activity_at,
        )
    except FileNotFoundError as exc:
        return ModelResult(
            text="",
            provider="grok",
            model=cfg.model,
            ok=False,
            error=repr(exc),
            finish_reason="error",
        )
    finally:
        if proc is not None and proc.poll() is None:
            _stop_owned_grok_process(proc)
        if leader_directory is not None:
            leader_directory.cleanup()
        if prompt_file.exists():
            prompt_file.unlink()


def _call_openclaw(system: str, user: str, cfg: ModelConfig, **_: Any) -> ModelResult:
    """OpenClaw gateway via its local CLI: ``openclaw infer model run --json``.

    ``cfg.model`` is the OpenClaw route ``<provider>/<model>`` (e.g. ``xai/grok-4.3``);
    OpenClaw owns provider auth/fallback. Pure inference — writes no knowledge, so this
    transport never touches the provenance gate. Degrades to ``ok=False`` when the binary
    is absent so the fallback chain (``...,mock``) keeps the stack offline-testable.
    """
    prompt = f"{system}\n\n{user}"
    binary = os.environ.get("SOPHIA_OPENCLAW_BIN", "openclaw")
    command = [binary, "infer", "model", "run", "--model", cfg.model, "--prompt", prompt, "--json"]
    try:
        proc = subprocess.run(command, text=True, capture_output=True, timeout=cfg.timeout_sec, check=False)
        if proc.returncode != 0:
            return ModelResult(text="", provider="openclaw", model=cfg.model, ok=False, error=(proc.stderr or proc.stdout or "")[-500:], finish_reason="error")
        data = json.loads(proc.stdout or "{}")
        outputs = data.get("outputs") if isinstance(data, dict) else None
        text = ""
        if isinstance(outputs, list) and outputs and isinstance(outputs[0], dict):
            text = (outputs[0].get("text") or "").strip()
        ok = bool(isinstance(data, dict) and data.get("ok", True)) and bool(text)
        return ModelResult(
            text=text,
            provider="openclaw",
            model=cfg.model,
            ok=ok,
            error=None if ok else "openclaw returned no usable text",
            finish_reason="stop" if ok else "error",
            raw=data if isinstance(data, dict) else None,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError, TypeError) as exc:
        return ModelResult(text="", provider="openclaw", model=cfg.model, ok=False, error=repr(exc), finish_reason="error")


def _codex_working_dir(cfg: ModelConfig) -> Path:
    candidate = Path(cfg.working_dir).expanduser() if cfg.working_dir else ROOT
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    resolved = candidate.resolve(strict=True)
    if not resolved.is_dir():
        raise NotADirectoryError("Codex working root is not a directory")
    return resolved


def _codex_message_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("text", "message", "output_text"):
            text = _codex_message_text(value.get(key))
            if text:
                return text
        content = value.get("content")
        if isinstance(content, list):
            parts = [_codex_message_text(item) for item in content]
            return "".join(part for part in parts if part).strip()
    return ""


def _codex_usage(value: Any) -> tuple[int, int, int] | None:
    if not isinstance(value, dict):
        return None
    prompt = value.get("input_tokens", value.get("prompt_tokens"))
    completion = value.get("output_tokens", value.get("completion_tokens"))
    cached = value.get("cached_input_tokens", value.get("cache_tokens", 0))
    if prompt is None and completion is None and cached in {None, 0}:
        return None
    try:
        return int(prompt or 0), int(completion or 0), int(cached or 0)
    except (TypeError, ValueError):
        return None


def _parse_codex_jsonl(
    raw: str,
    requested_model: str,
) -> tuple[str, str, int, int, int, tuple[str, ...]]:
    """Parse Codex 0.144.x ``exec --json`` output without trusting prose stdout."""
    final_text = ""
    completed_turn_text = ""
    actual_model = requested_model
    usage = (0, 0, 0)
    saw_event = False
    internal_actions: set[str] = set()
    for line in (raw or "").splitlines():
        if not line.strip():
            continue
        saw_event = True
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError("malformed Codex JSONL") from exc
        if not isinstance(event, dict):
            raise ValueError("malformed Codex JSONL event")

        response = event.get("response")
        if isinstance(response, dict):
            response_model = response.get("model")
            if isinstance(response_model, str) and response_model.strip():
                actual_model = response_model.strip()
            parsed_usage = _codex_usage(response.get("usage"))
            if parsed_usage is not None:
                usage = parsed_usage

        event_type = str(event.get("type") or "").replace("_", ".").casefold()
        item = event.get("item")
        item_type = (
            str(item.get("type") or "").replace("_", ".").casefold()
            if isinstance(item, dict)
            else ""
        )
        # In native-tool mode Codex is a model transport, not a second agent.
        # Record any built-in action so the caller can reject the turn rather
        # than reporting unreceipted shell/MCP/file work as a Sophia tool call.
        if item_type != "agent.message" and (
            "command" in item_type
            or "tool" in item_type
            or item_type in {
                "file.change",
                "web.search",
                "image.generation",
            }
        ):
            internal_actions.add(item_type)
        if (
            event_type == "item.completed"
            and isinstance(item, dict)
            and item_type == "agent.message"
        ):
            text = _codex_message_text(item)
            if text:
                final_text = text
            item_response = item.get("response")
            if isinstance(item_response, dict):
                response_model = item_response.get("model")
                if isinstance(response_model, str) and response_model.strip():
                    actual_model = response_model.strip()
        elif event_type in {"agent.message", "agent.message.completed"}:
            text = _codex_message_text(event)
            if text:
                final_text = text

        if event_type in {"turn.completed", "task.complete", "response.completed"}:
            text = _codex_message_text(event.get("last_agent_message"))
            if text:
                completed_turn_text = text
            parsed_usage = _codex_usage(event.get("usage"))
            if parsed_usage is not None:
                usage = parsed_usage

    if not saw_event:
        raise ValueError("empty Codex JSONL")
    text = final_text or completed_turn_text
    return (
        text,
        actual_model,
        usage[0],
        usage[1],
        usage[2],
        tuple(sorted(internal_actions)),
    )


_CODEX_TOOL_ENVELOPE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["type", "text", "tool_calls"],
    "properties": {
        "type": {"type": "string", "enum": ["final", "tool_calls"]},
        "text": {"type": "string"},
        "tool_calls": {
            "type": "array",
            "maxItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "name", "arguments_json"],
                "properties": {
                    "id": {"type": "string"},
                    "name": {"type": "string"},
                    # Codex structured outputs require additionalProperties=false
                    # for every object. A JSON string preserves arbitrary Sophia
                    # tool argument objects without weakening the outer schema.
                    "arguments_json": {"type": "string"},
                },
            },
        },
    },
}


def _codex_tool_protocol_prompt(
    system: str,
    user: str,
    tools: list[dict],
    *,
    tool_choice: Any,
) -> str:
    """Build the CLI prompt that keeps all executable work in Sophia's loop."""
    requirement = (
        "This turn MUST return type=tool_calls with exactly one call."
        if tool_choice == "required"
        else (
            "Return type=tool_calls with exactly one call when more evidence or "
            "action is needed; otherwise return type=final with the completed answer."
        )
    )
    schemas = json.dumps(tools, ensure_ascii=False, separators=(",", ":"))
    return (
        "TRANSPORT CONTRACT — higher priority than the conversation below:\n"
        "You are the reasoning/model layer inside Sophia Code, not an independent "
        "coding agent. Sophia owns every repository, shell, web, MCP, and file tool.\n"
        "Do NOT use Codex built-in command execution, file access, web search, MCP, "
        "or any other Codex tool. Do not inspect the current directory.\n"
        "Return only the JSON object required by the supplied output schema. "
        "Never wrap it in Markdown.\n"
        f"{requirement}\n"
        "For a tool call, choose only a listed Sophia tool, use a non-empty unique "
        "id, put an object encoded as JSON in arguments_json, and keep text empty "
        "unless a short user-visible preface is genuinely useful. For a final "
        "answer, tool_calls must be empty and text must be non-empty.\n\n"
        f"SOPHIA NATIVE TOOL SCHEMAS:\n{schemas}\n\n"
        "BEGIN SOPHIA CONVERSATION\n"
        f"{system}\n\n{user}\n"
        "END SOPHIA CONVERSATION"
    )


def _parse_codex_tool_envelope(
    text: str,
    tools: list[dict],
    *,
    tool_choice: Any,
) -> tuple[str, list[dict[str, Any]], str]:
    """Validate one structured Codex response as a Sophia-native model turn."""
    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError("invalid Codex native-tool envelope JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("invalid Codex native-tool envelope")

    envelope_type = str(payload.get("type") or "").strip()
    answer = str(payload.get("text") or "")
    raw_calls = payload.get("tool_calls")
    if not isinstance(raw_calls, list):
        raise ValueError("invalid Codex native-tool calls")

    allowed_names = {
        str((schema.get("function") or {}).get("name") or "").strip()
        for schema in tools
        if isinstance(schema, dict) and isinstance(schema.get("function"), dict)
    }
    allowed_names.discard("")

    if envelope_type == "final":
        if tool_choice == "required":
            raise ValueError("Codex returned a final answer when a tool call was required")
        if raw_calls or not answer.strip():
            raise ValueError("invalid Codex final envelope")
        return answer, [], "stop"

    if envelope_type != "tool_calls" or len(raw_calls) != 1:
        raise ValueError("invalid Codex tool-call envelope")
    call = raw_calls[0]
    if not isinstance(call, dict):
        raise ValueError("invalid Codex tool call")
    call_id = str(call.get("id") or "").strip()
    name = str(call.get("name") or "").strip()
    arguments_json = call.get("arguments_json")
    if not call_id or name not in allowed_names or not isinstance(arguments_json, str):
        raise ValueError("invalid Codex tool call metadata")
    try:
        arguments = json.loads(arguments_json)
    except json.JSONDecodeError as exc:
        raise ValueError("invalid Codex tool arguments JSON") from exc
    if not isinstance(arguments, dict):
        raise ValueError("Codex tool arguments must be an object")
    return answer, [{
        "id": call_id,
        "name": name,
        "arguments": json.dumps(arguments, ensure_ascii=False, separators=(",", ":")),
    }], "tool_calls"


def _codex_safe_failure(returncode: int, stdout: str, stderr: str, model: str) -> str:
    lowered = f"{stdout}\n{stderr}".casefold()
    if any(marker in lowered for marker in (
        "not logged in", "not authenticated", "logged out", "login required", "unauthorized",
    )):
        return "codex CLI is not authenticated; run `codex login`"
    if any(marker in lowered for marker in ("unknown model", "model not found", "unsupported model")):
        return f"codex CLI rejected model {model!r}"
    return f"codex subprocess exited {returncode}"


_CODEX_CANCEL_POLL_SEC = 0.25
_CODEX_TERMINATE_GRACE_SEC = 2.0


def _stop_owned_codex_process(proc: subprocess.Popen[str]) -> tuple[str, str]:
    """Stop the exact Codex child Sophia launched and drain its pipes.

    ``terminate`` is the normal path. ``kill`` is only a bounded last resort for
    that owned child after it ignores termination; no unrelated PID is touched.
    """
    if proc.poll() is None:
        proc.terminate()
    try:
        return proc.communicate(timeout=_CODEX_TERMINATE_GRACE_SEC)
    except subprocess.TimeoutExpired:
        proc.kill()
        return proc.communicate()


def _run_codex_subprocess(
    command: list[str],
    *,
    cwd: Path,
    timeout_sec: int,
    should_cancel: Callable[[], bool] | None,
) -> subprocess.CompletedProcess[str]:
    """Run Codex with prompt cancellation when called from the live bridge."""
    common = {
        "cwd": cwd,
        "text": True,
        "stdin": subprocess.DEVNULL,
    }
    if should_cancel is None:
        return subprocess.run(
            command,
            capture_output=True,
            timeout=timeout_sec,
            check=False,
            **common,
        )

    proc = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **common,
    )
    deadline = time.monotonic() + timeout_sec
    while True:
        if should_cancel():
            _stop_owned_codex_process(proc)
            raise InterruptedError("codex subprocess cancelled")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _stop_owned_codex_process(proc)
            raise subprocess.TimeoutExpired(command, timeout_sec)
        try:
            stdout, stderr = proc.communicate(
                timeout=min(_CODEX_CANCEL_POLL_SEC, remaining),
            )
        except subprocess.TimeoutExpired:
            continue
        return subprocess.CompletedProcess(
            command,
            proc.returncode,
            stdout,
            stderr,
        )


def _call_codex(
    system: str,
    user: str,
    cfg: ModelConfig,
    *,
    tools: list[dict] | None = None,
    on_token: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    **_: Any,
) -> ModelResult:
    """Official Codex CLI bridge with Sophia-owned native tool execution.

    With a tool schema present, Codex runs in an empty temporary directory and
    may only return a structured tool/final envelope. Any Codex built-in action
    observed in its JSONL stream fails closed, so only Sophia's executor can
    create repository tool receipts. Tool-less calls retain the historical
    bounded, ephemeral, read-only CLI behavior.
    """
    binary = os.environ.get("SOPHIA_CODEX_BIN", "codex")
    model = canonical_codex_model(cfg.model)
    try:
        run_cwd = _codex_working_dir(cfg)
    except (OSError, RuntimeError, ValueError):
        return ModelResult(
            text="", provider="codex", model=model, ok=False,
            error="codex working directory is unavailable or invalid",
            finish_reason="error",
        )
    with (
        tempfile.TemporaryDirectory(prefix="sophia-codex-transport-")
        if tools
        else nullcontext(run_cwd)
    ) as cli_cwd:
        cli_cwd = Path(cli_cwd)
        prompt = (
            _codex_tool_protocol_prompt(
                system,
                user,
                tools,
                tool_choice=cfg.tool_choice,
            )
            if tools
            else f"{system}\n\n{user}"
        )
        command = [
            binary,
            "--ask-for-approval", "never",
            "exec",
            "--model", model,
            "--sandbox", "read-only",
            "--ignore-user-config",
            "--ephemeral",
            "--json",
        ]
        if tools:
            schema_path = cli_cwd / "sophia-tool-envelope.schema.json"
            schema_path.write_text(
                json.dumps(_CODEX_TOOL_ENVELOPE_SCHEMA, ensure_ascii=False),
                encoding="utf-8",
            )
            command.extend([
                "--skip-git-repo-check",
                "--output-schema", str(schema_path),
            ])
        command.extend(["--cd", str(cli_cwd), prompt])
        try:
            proc = _run_codex_subprocess(
                command,
                cwd=cli_cwd,
                timeout_sec=cfg.timeout_sec,
                should_cancel=should_cancel,
            )
        except InterruptedError:
            return ModelResult(
                text="", provider="codex", model=model, ok=False,
                error="codex subprocess cancelled",
                finish_reason="cancelled",
            )
        except subprocess.TimeoutExpired:
            return ModelResult(
                text="", provider="codex", model=model, ok=False,
                error=f"codex subprocess timed out after {cfg.timeout_sec}s",
                finish_reason="timeout",
            )
        except FileNotFoundError:
            return ModelResult(
                text="", provider="codex", model=model, ok=False,
                error="codex CLI unavailable; install Codex CLI and run `codex login`",
                finish_reason="error",
            )
        except OSError:
            return ModelResult(
                text="", provider="codex", model=model, ok=False,
                error="codex CLI could not be started",
                finish_reason="error",
            )
    if proc.returncode != 0:
        return ModelResult(
            text="", provider="codex", model=model, ok=False,
            error=_codex_safe_failure(proc.returncode, proc.stdout or "", proc.stderr or "", model),
            finish_reason="error",
        )
    try:
        (
            text,
            actual_model,
            prompt_tokens,
            completion_tokens,
            cache_tokens,
            internal_actions,
        ) = _parse_codex_jsonl(proc.stdout or "", model)
    except (TypeError, ValueError):
        return ModelResult(
            text="", provider="codex", model=model, ok=False,
            error="codex returned malformed JSONL output",
            finish_reason="error",
        )
    if tools and internal_actions:
        return ModelResult(
            text="", provider="codex", model=actual_model, ok=False,
            error=(
                "codex attempted internal tool execution instead of Sophia native "
                f"tools ({', '.join(internal_actions)})"
            ),
            finish_reason="tool_protocol_bypass",
        )
    if not text:
        return ModelResult(
            text="", provider="codex", model=actual_model, ok=False,
            error="codex returned no final agent message",
            finish_reason="empty",
        )
    tool_calls: list[dict[str, Any]] = []
    finish_reason = "stop"
    if tools:
        try:
            text, tool_calls, finish_reason = _parse_codex_tool_envelope(
                text,
                tools,
                tool_choice=cfg.tool_choice,
            )
        except (TypeError, ValueError):
            return ModelResult(
                text="", provider="codex", model=actual_model, ok=False,
                error="codex returned an invalid Sophia native-tool envelope",
                finish_reason="tool_protocol_error",
            )
    if on_token is not None and text:
        on_token(text)
    return ModelResult(
        text=text,
        provider="codex",
        model=actual_model,
        ok=True,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cache_tokens=cache_tokens,
        finish_reason=finish_reason,
        tool_calls=tool_calls,
    )


def _call_pi_ai(system: str, user: str, cfg: ModelConfig, *, messages: list[dict] | None = None, **kwargs: Any) -> ModelResult:
    """pi-ai stdio sidecar transport — see ``agent.pi_ai_transport`` (W4 spike)."""
    from agent.pi_ai_transport import call_pi_ai

    return call_pi_ai(system, user, cfg, messages=messages, **kwargs)


_MLX_MODEL_CACHE: "OrderedDict[tuple[str, str | None], tuple[Any, Any]]" = OrderedDict()


def _mlx_cache_max_entries() -> int:
    raw = (os.environ.get("SOPHIA_MLX_CACHE_SIZE") or "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value
    return 1


def _mlx_cached_load(load_fn: Callable[..., tuple[Any, Any]], model: str, adapter_path: str | None) -> tuple[Any, Any]:
    """Return the (model, tokenizer) pair for (model, adapter_path), loading once.

    A repeat call with the same key reuses the resident weights instead of
    re-reading them from disk. Eviction pops the dict entry rather than just
    marking it unused -- this module's cache is the ONLY reference this process
    holds to those weights, so dropping the entry is what actually frees the
    memory; keeping a stray reference anywhere would silently defeat the cap.
    """
    key = (model, adapter_path)
    cached = _MLX_MODEL_CACHE.get(key)
    if cached is not None:
        _MLX_MODEL_CACHE.move_to_end(key)
        return cached
    load_kwargs: dict[str, Any] = {}
    if adapter_path:
        load_kwargs["adapter_path"] = adapter_path
    loaded = load_fn(model, **load_kwargs)
    _MLX_MODEL_CACHE[key] = loaded
    cap = _mlx_cache_max_entries()
    while len(_MLX_MODEL_CACHE) > cap:
        _MLX_MODEL_CACHE.popitem(last=False)  # evict least-recently-used
    return loaded


def _mlx_build_sampler(temperature: float) -> Any | None:
    try:  # older mlx_lm without sample_utils -> fall back to the library default
        from mlx_lm.sample_utils import make_sampler

        return make_sampler(temp=float(temperature))
    except Exception:  # pragma: no cover - depends on installed mlx_lm version
        return None


def _mlx_generate(
    model: Any,
    tokenizer: Any,
    prompt: str,
    gen_kwargs: dict[str, Any],
    *,
    on_token: Callable[[str], None] | None,
    should_cancel: Callable[[], bool] | None,
) -> tuple[str, bool, int, int, float | None]:
    """Run generation, streaming through ``on_token`` when the installed mlx_lm can.

    Returns ``(text, cancelled, prompt_tokens, completion_tokens,
    time_to_first_token_sec)``. The TTFT clock starts here, AFTER
    ``_call_mlx`` has already loaded (or reused) the model weights -- a cold
    load is the dominant cost on a model's first call and is measured
    separately by the caller's ``latency_sec``, so anchoring TTFT here is what
    lets the two numbers together tell "weights just loaded" apart from
    "generation itself is slow". Older mlx_lm pins without ``stream_generate``
    fall back to the blocking ``generate()`` this transport always used --
    caught narrowly (ImportError only) so a REAL bug inside streaming surfaces
    instead of silently degrading to the slow path every time.
    """
    generate_started = time.monotonic()
    try:
        from mlx_lm import stream_generate
    except ImportError:
        from mlx_lm import generate as _blocking_generate

        text = _blocking_generate(model, tokenizer, prompt=prompt, verbose=False, **gen_kwargs)
        # No real chunk boundary exists on this fallback -- the "first token"
        # and "last token" are the same event, so TTFT collapses to the whole
        # generation time rather than staying None (None would read as "never
        # streamed anything," which is misleading when text really did arrive).
        ttft = (time.monotonic() - generate_started) if text else None
        if on_token and text:
            on_token(text)  # no real chunks available from this entry point; deliver it whole
        return text, False, 0, 0, ttft

    parts: list[str] = []
    cancelled = False
    prompt_tokens = 0
    completion_tokens = 0
    time_to_first_token: float | None = None
    for chunk in stream_generate(model, tokenizer, prompt=prompt, **gen_kwargs):
        piece = getattr(chunk, "text", "") or ""
        if piece:
            if time_to_first_token is None:
                time_to_first_token = time.monotonic() - generate_started
            parts.append(piece)
            if on_token:
                on_token(piece)
        prompt_tokens = getattr(chunk, "prompt_tokens", None) or prompt_tokens
        completion_tokens = getattr(chunk, "generation_tokens", None) or completion_tokens
        if should_cancel is not None and should_cancel():
            # Stop pulling from the generator NOW rather than draining it: MLX
            # compute happens lazily inside the `for` step, so breaking here is
            # what actually stops the GPU/CPU work, not just what stops the
            # forwarding. The generator's own `wired_limit` finally-block still
            # runs on GC/close, so this is a clean stop, not an abandoned one.
            cancelled = True
            break
    return "".join(parts), cancelled, prompt_tokens, completion_tokens, time_to_first_token


def _call_mlx(system: str, user: str, cfg: ModelConfig, *, on_token: Callable[[str], None] | None = None,
              should_cancel: Callable[[], bool] | None = None, **_: Any) -> ModelResult:
    """Local MLX-LM inference with an optional LoRA adapter (Apple Silicon).

    Loads (and caches — see ``_MLX_MODEL_CACHE``) ``cfg.model`` (+
    ``cfg.adapter_path`` when set) via ``mlx_lm`` and streams the reply through
    ``on_token`` so a slow local model shows live progress instead of a frozen
    spinner for the whole generation. ``should_cancel`` is polled once per
    streamed chunk so an operator-cancelled run actually stops compute instead
    of finishing the full answer unseen. ``mlx_lm`` is absent off-Mac/CI, so this
    fails closed with a clear error — callers (e.g. the SEIB preflight) then
    record an environment artifact, not a crash/score.
    """
    try:
        from mlx_lm import load  # lazy: only present on Apple Silicon with mlx-lm
    except Exception as exc:
        return ModelResult(text="", provider="mlx", model=cfg.model, ok=False,
                           error=f"mlx_lm unavailable: {type(exc).__name__}: {exc}")
    try:
        model, tokenizer = _mlx_cached_load(load, cfg.model, cfg.adapter_path)
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        # cfg.temperature must reach the sampler. mlx_lm's default sampler is
        # make_sampler(temp=0.0) -> ARGMAX, so omitting it silently pins this transport to
        # greedy decoding and makes SOPHIA_TEMPERATURE / `sophia --temperature` dead knobs
        # here while every other provider honours them (see _call_openai_compatible /
        # _call_anthropic, which pass cfg.temperature in their request bodies). The visible
        # damage is to any k-sample method: repeated calls return byte-identical text, so
        # self-consistency reads a constant 1.0 instead of measuring sample agreement.
        # Callers that need determinism set SOPHIA_TEMPERATURE=0 and are unaffected.
        gen_kwargs: dict[str, Any] = {"max_tokens": cfg.max_tokens}
        sampler = _mlx_build_sampler(cfg.temperature)
        if sampler is not None:
            gen_kwargs["sampler"] = sampler
        raw, cancelled, prompt_tokens, completion_tokens, time_to_first_token_sec = _mlx_generate(
            model, tokenizer, prompt, gen_kwargs, on_token=on_token, should_cancel=should_cancel,
        )
        # Thinking-mode local models (Qwen3.6 and friends) emit their monologue
        # inline; it must never be delivered as the answer.
        text, think_blocks = split_think_blocks(raw)
        reasoning = "\n".join(think_blocks) if (think_blocks and capture_thinking_enabled()) else ""
        return ModelResult(
            text=text, provider="mlx",
            model=cfg.model + (f"+{cfg.adapter_path}" if cfg.adapter_path else ""),
            # The streaming path reports its own counts as it goes (matching what the
            # OpenAI-compatible transport surfaces for tokens-per-second downstream);
            # the blocking fallback has no per-chunk counts, so tokenize directly.
            prompt_tokens=prompt_tokens or len(tokenizer.encode(prompt)),
            completion_tokens=completion_tokens or (len(tokenizer.encode(raw)) if raw else 0),
            reasoning_text=reasoning,
            reasoning_tokens=(max(1, len(reasoning) // 4) if reasoning else 0),
            time_to_first_token_sec=time_to_first_token_sec,
            # A cancelled run still returns ok=True with whatever text it produced --
            # it is a request that was honored partway through, not a transport
            # failure, and the caller asked to see partial progress, not an error.
            finish_reason="cancelled" if cancelled else "stop",
            raw=({"cancelled": True} if cancelled else None),
        )
    except Exception as exc:
        return ModelResult(text="", provider="mlx", model=cfg.model, ok=False, error=repr(exc))


def _continuation_targets(prompt_ids: Sequence[int], full_ids: Sequence[int]) -> list[int]:
    """Return the continuation token ids under the prompt/full-tokenize contract."""
    start = len(prompt_ids)
    if start > len(full_ids):
        raise ValueError("prompt tokenization is longer than prompt+continuation")
    return [int(t) for t in full_ids[start:]]


def _sum_logprob_rows(logit_rows: Sequence[Sequence[float]], target_ids: Sequence[int]) -> float:
    """Pure-Python log-softmax gather for tiny tests; production uses MLX tensors."""
    import math

    if len(logit_rows) != len(target_ids):
        raise ValueError("logit row count must match target token count")
    total = 0.0
    for row, target in zip(logit_rows, target_ids):
        values = [float(x) for x in row]
        if target < 0 or target >= len(values):
            raise ValueError(f"target id {target} outside vocab size {len(values)}")
        m = max(values)
        log_denom = m + math.log(sum(math.exp(v - m) for v in values))
        total += values[target] - log_denom
    return float(total)


def _score_logprob_loaded(prompt: str, continuation: str, model: Any, tokenizer: Any) -> float:
    """Score ``continuation`` after ``prompt`` using a loaded MLX model/tokenizer.

    The model runs once on ``prompt + continuation``. We then sum the log-probability
    assigned to continuation tokens only, with no length normalization.
    """
    prompt_ids = list(tokenizer.encode(prompt))
    full_ids = list(tokenizer.encode(prompt + continuation))
    target_ids = _continuation_targets(prompt_ids, full_ids)
    if not target_ids:
        return 0.0
    if len(prompt_ids) == 0:
        raise ValueError("prompt must tokenize to at least one token for continuation scoring")

    try:
        import mlx.core as mx  # lazy: absent off-Mac/CI
    except Exception as exc:
        raise RuntimeError(f"mlx unavailable for logprob scoring: {type(exc).__name__}: {exc}") from exc

    input_ids = mx.array([full_ids])
    logits = model(input_ids)
    if isinstance(logits, (tuple, list)):
        logits = logits[0]
    start = len(prompt_ids)
    # Logits at position k-1 predict token k. Slice exactly the continuation
    # targets full_ids[start:].
    pred = logits[:, start - 1 : len(full_ids) - 1, :]
    targets = mx.array([target_ids])
    log_probs = pred - mx.logsumexp(pred, axis=-1, keepdims=True)
    chosen = mx.take_along_axis(log_probs, targets[..., None], axis=-1)
    total = mx.sum(chosen)
    mx.eval(total)
    return float(total)


def build_logprob_scorer(spec: str | None = None, *, adapter_path: str | None = None) -> Callable[[str, str], float]:
    """Load a local MLX model once and return ``score_logprob(prompt, continuation)``.

    This is deterministic, uses no sampling, and fails closed when MLX/``mlx_lm``
    is unavailable or when a non-MLX provider is requested.
    """
    cfg = resolve_config(spec or "mlx")
    if cfg.kind != "mlx":
        raise RuntimeError(f"logprob scoring currently requires mlx:<model>, got {cfg.kind!r}")
    if adapter_path is not None:
        cfg.adapter_path = adapter_path
    try:
        from mlx_lm import load  # lazy: only present on Apple Silicon with mlx-lm
    except Exception as exc:
        raise RuntimeError(f"mlx_lm unavailable for logprob scoring: {type(exc).__name__}: {exc}") from exc
    load_kwargs: dict[str, Any] = {}
    if cfg.adapter_path:
        load_kwargs["adapter_path"] = cfg.adapter_path
    try:
        loaded_model, tokenizer = load(cfg.model, **load_kwargs)
    except Exception as exc:
        raise RuntimeError(f"mlx_lm load failed for {cfg.model}: {exc!r}") from exc
    return lambda prompt, continuation: _score_logprob_loaded(prompt, continuation, loaded_model, tokenizer)


def score_logprob(prompt: str, continuation: str, *, spec: str | None = None, adapter_path: str | None = None) -> float:
    """One-shot continuation log-probability scorer for MLX models/adapters.

    Prefer :func:`build_logprob_scorer` for benchmarks so the model is loaded once.
    """
    return build_logprob_scorer(spec, adapter_path=adapter_path)(prompt, continuation)


_TRANSPORTS: dict[str, Callable[..., ModelResult]] = {
    "mock": _call_mock,
    "anthropic": _call_anthropic,
    "openai": _call_openai_compatible,
    "openai-responses": _call_openai_responses,
    "grok": _call_grok,
    "codex": _call_codex,
    "openclaw": _call_openclaw,
    "mlx": _call_mlx,
    "pi-ai": _call_pi_ai,
}


def _is_transient(error: str | None) -> bool:
    if not error:
        return False
    # HTTP retry codes, timeouts, and the connection-level drops a live backend
    # can inflict mid-request. The connection drops matter most: a broken pipe
    # surfaces as ``URLError(BrokenPipeError(32, 'Broken pipe'))`` and a closed
    # keep-alive as ``URLError(RemoteDisconnected(...))`` — neither contains the
    # literal substring "Connection", so before this list they fell through and
    # the client gave up on the first attempt instead of retrying a transient
    # cloud/proxy disconnect.
    transient_markers = (
        "429", "500", "502", "503", "504",
        "timed out", "timeout",
        "Connection",          # ConnectionResetError / Connection aborted / refused
        "Broken pipe",         # BrokenPipeError(32, 'Broken pipe')
        "BrokenPipeError",
        "RemoteDisconnected",  # http.client.RemoteDisconnected
        "Remote end closed",
        "EOF occurred",
        # A 200 with neither text nor tool calls (often after emitting only
        # reasoning) — seen intermittently on gpt-5.6 via the 020s gateway at
        # reasoning_effort=max. Usually transient: retrying gives the model
        # another turn to surface a concrete answer instead of killing the run.
        # In team mode an abrupt empty-terminal lane strands the synthesis and
        # the TUI hangs at "Finalizing answer…", so a retry is worth the cost.
        "empty terminal model response",
    )
    return any(marker in error for marker in transient_markers)


def _normalize_result(result: ModelResult) -> ModelResult:
    """Fail visibly on a nominally successful terminal empty response.

    Some GLM/Anthropic-compatible gateways return ``200`` with neither text nor
    tool calls (often after emitting only reasoning).  A tool-only turn remains
    actionable; an empty terminal turn is a typed transport failure.

    A malformed tool call (the response parser already stripped an attempted
    call with a blank function name -- see ``ModelResult.malformed_tool_call``)
    lands in this same "no text, no tool_calls" shape, but it is NOT the same
    failure: one is the model choosing to say nothing, the other is the model
    trying to call a tool and the transport being unable to dispatch it. Small
    local models (Qwen3-family on vLLM/oMLX) hit the malformed case often
    enough that folding it into "empty response" reads as "refuses to use
    tools" to whoever is debugging it, which sends them chasing the wrong fix.
    """
    if result.ok and not (result.text or "").strip() and not result.tool_calls:
        result.ok = False
        if result.malformed_tool_call:
            result.error = result.error or "malformed tool call: model attempted a tool_call with an empty function name"
            result.finish_reason = result.finish_reason or "malformed_tool_call"
        else:
            result.error = result.error or "empty terminal model response (no text or tool calls)"
            result.finish_reason = result.finish_reason or "empty"
        result.error_info = result.error_info or classify_provider_error(
            result.error,
            provider=result.provider,
            model=result.model,
        )
    return result


_LOCAL_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "::1")

#: Dummy keys local OpenAI-compatible servers use (no real credential). A preset
#: carrying one of these is self-hosted even if its hostname is not a literal
#: localhost (e.g. a LAN box), so it counts as local for cloud-only gating.
_LOCAL_DUMMY_KEYS = frozenset({
    "1234",
    "EMPTY",
    "sk-no-key",
    "ollama",
    "codex-proxy-local",
    "qwen-cc-proxy-local",
    "sophia-local-no-key",
})


def is_local_model(cfg: "ModelConfig") -> bool:
    """True when ``cfg`` is a local/self-hosted backend rather than a cloud API.

    Decides cloud-only feature gates (e.g. ultra-effort auto team dispatch).
    ``kind`` alone is insufficient — oMLX is ``kind == "openai"`` yet local — so
    the base_url hostname is the decisive signal, with ``kind == "mlx"``
    (on-device) and the dummy-key presets closing the remaining gaps.
    """
    if cfg.kind == "mlx":
        return True
    if getattr(cfg, "endpoint_scope", None) in {"local", "private"}:
        return True
    try:
        hostname = (urlsplit(getattr(cfg, "base_url", "") or "").hostname or "").casefold()
    except ValueError:
        hostname = ""
    if hostname in _LOCAL_HOSTS:
        return True
    return (getattr(cfg, "api_key_default", "") or "") in _LOCAL_DUMMY_KEYS


@dataclass(frozen=True)
class ProviderCapabilities:
    """Honest runtime capabilities for one resolved provider/model."""

    provider: str
    transport: str
    model: str
    tools: bool
    streaming: bool
    images: bool
    context_window: int | None
    local: bool
    cloud: bool
    cost_known: bool
    external_gateway: bool = False
    optional: bool = False
    image_mode: str = "none"

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "transport": self.transport,
            "model": self.model,
            "tools": self.tools,
            "streaming": self.streaming,
            "images": self.images,
            "imageMode": self.image_mode,
            "context": self.context_window,
            "contextWindow": self.context_window,
            "local": self.local,
            "cloud": self.cloud,
            "costKnown": self.cost_known,
            "externalGateway": self.external_gateway,
            "optional": self.optional,
        }


_TOOLS_BY_KIND: dict[str, bool] = {
    "openai": True,
    "openai-responses": True,
    "anthropic": True,
    "mock": True,
    "pi-ai": True,
    # The CLI itself is denied repository work in tool-enabled turns. A strict
    # structured-output envelope is converted into ModelResult.tool_calls and
    # executed/receipted by Sophia's native tool loop.
    "codex": True,
    # These transports own/flatten their own interaction and do not receive
    # Sophia's native tool schema.
    "grok": False,
    "openclaw": False,
    "mlx": False,
}
_STREAMING_BY_KIND: dict[str, bool] = {
    "openai": True,
    # The compatibility smoke validates Responses SSE independently; the
    # generic agent transport stays non-streaming until every event family is
    # normalized fail-closed.
    "openai-responses": False,
    "mock": True,
    "anthropic": False,
    "grok": False,
    "codex": False,
    "openclaw": False,
    "mlx": False,
    "pi-ai": False,
}


def provider_capabilities(spec: str | ModelConfig | None = None) -> ProviderCapabilities:
    """Return a typed manifest; no endpoint, binary, or paid probe is made."""
    cfg = spec if isinstance(spec, ModelConfig) else resolve_config(spec)
    local = is_local_model(cfg)
    detail = estimate_cost_detail(cfg.model, 0, 0)
    # A zero-dollar family rule is meaningful for local inference. For a cloud
    # endpoint, zero is not enough evidence to claim pricing is known.
    cost_known = detail.known and (
        local
        or bool((detail.input_per_million or 0.0) > 0)
        or bool((detail.output_per_million or 0.0) > 0)
    )
    provider = cfg.label or cfg.kind
    image_mode = "none"
    if provider in {"grok", "grok-cli"}:
        image_mode = "delegated-cli"
    elif provider in {"openai", "xai", "grok-4.5"}:
        image_mode = "api"
    return ProviderCapabilities(
        provider=provider,
        transport=cfg.kind,
        model=cfg.model,
        tools=bool(_TOOLS_BY_KIND.get(cfg.kind, False)),
        streaming=bool(_STREAMING_BY_KIND.get(cfg.kind, False)),
        images=image_mode != "none",
        image_mode=image_mode,
        context_window=cfg.context_window,
        local=local,
        cloud=not local,
        cost_known=cost_known,
        external_gateway=cfg.external_gateway,
        optional=cfg.optional,
    )


def provider_capability_manifest(spec: str | ModelConfig | None = None) -> dict[str, Any]:
    """JSON-compatible one-provider capability manifest."""
    return provider_capabilities(spec).to_dict()


def capability_manifest(specs: Sequence[str] | None = None) -> dict[str, Any]:
    """Stable manifest for UIs/bridges; claims only wired adapter properties."""
    names = list(specs) if specs is not None else list(available_provider_names())
    providers: list[dict[str, Any]] = []
    for name in names:
        try:
            providers.append(provider_capability_manifest(name))
        except (TypeError, ValueError):
            continue
    return {
        "schema": "sophia.provider-capabilities.v1",
        "providers": providers,
        "candidateOnly": True,
        "canClaimAGI": False,
    }


def _egress_blocked_for(cfg: "ModelConfig") -> bool:
    """Under the airgap profile, refuse any model transport that leaves the host.
    Local providers (ollama / llama.cpp / vLLM on localhost) are still allowed."""
    from agent.dataflow.firewall import egress_blocked

    if not egress_blocked():
        return False
    if cfg.kind == "mlx":  # local on-device inference; no network egress
        return False
    # pi-ai default is a local Node mock subprocess. Real backend (if enabled)
    # may still egress from Node; under airgap prefer mock-only operator config.
    if cfg.kind == "pi-ai":
        backend = (os.environ.get("SOPHIA_PI_AI_BACKEND") or "mock").strip().lower()
        return backend not in {"", "mock", "fixture"}
    url = getattr(cfg, "base_url", "") or ""
    try:
        hostname = (urlsplit(url).hostname or "").casefold()
    except ValueError:
        return True
    return hostname not in _LOCAL_HOSTS


_FALLBACK_VENDOR_MARKERS: tuple[tuple[str, str], ...] = (
    ("grok", "xai"),
    ("codex", "openai"),
    ("fugu", "openai"),
    *_TEACHER_FAMILY_MARKERS,
)
_FALLBACK_VENDOR_LABEL_ALIASES = {
    "codex": "openai",
    "codex-api": "openai",
    "codex-fugu": "openai",
    "codex-5.6": "openai",
    "codex-sol": "openai",
    "codex-terra": "openai",
    "codex-luna": "openai",
    "fugu": "openai",
    "grok": "xai",
    "grok-4.5": "xai",
    "xai": "xai",
}


def _normalized_endpoint_authority(
    cfg: "ModelConfig",
) -> tuple[str, str, int | None] | None:
    """Return a path-insensitive, security-relevant endpoint authority.

    Default HTTP(S) ports are normalized so equivalent URL spellings compare
    equal. Invalid or credential-bearing URLs fail closed instead of receiving
    the same-provider confirmation bypass.
    """
    url = (cfg.base_url or "").strip()
    if not url:
        return ("implicit", cfg.kind.strip().casefold(), None)
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    scheme = parsed.scheme.casefold()
    hostname = (parsed.hostname or "").casefold().rstrip(".")
    if not scheme or not hostname or parsed.username is not None or parsed.password is not None:
        return None
    if port is None:
        port = {"http": 80, "https": 443}.get(scheme)
    return (scheme, hostname, port)


def _credential_authority(cfg: "ModelConfig") -> tuple[str, str, str]:
    """Identify the credential source without resolving or exposing a secret."""
    if cfg.api_key_env:
        return ("env", cfg.api_key_env.strip(), str(cfg.api_key_default or ""))
    if cfg.api_key_default is not None:
        return ("default", "", str(cfg.api_key_default))
    if cfg.kind == "anthropic":
        return ("implicit-env", "ANTHROPIC_API_KEY|CLAUDE_API_KEY", "")
    return ("transport", cfg.kind.strip().casefold(), "")


def _vendor_identity(cfg: "ModelConfig") -> str:
    """Best available vendor identity for fallback authority comparisons."""
    model = (cfg.model or "").strip().casefold()
    if "/" in model:
        vendor = model.split("/", 1)[0].strip()
        if vendor:
            return _FALLBACK_VENDOR_LABEL_ALIASES.get(vendor, vendor)
    for marker, vendor in _FALLBACK_VENDOR_MARKERS:
        if marker in model:
            return vendor
    label = (cfg.label or "").strip().casefold()
    if label:
        return _FALLBACK_VENDOR_LABEL_ALIASES.get(label, label)
    return f"unknown:{model}"


def _fallback_authority_descriptor(cfg: "ModelConfig") -> FallbackAuthorityDescriptor:
    """Build authority metadata without resolving or serializing credentials."""
    scheme: str | None = None
    host: str | None = None
    port: int | None = None
    url = (cfg.base_url or "").strip()
    if url:
        try:
            parsed = urlsplit(url)
            scheme = parsed.scheme.casefold() or None
            host = (parsed.hostname or "").casefold().rstrip(".") or None
            port = parsed.port
            if port is None:
                port = {"http": 80, "https": 443}.get(scheme or "")
        except ValueError:
            # Malformed authorities still require confirmation; omit the
            # unparseable endpoint rather than copying raw URL text.
            scheme = None
            host = None
            port = None

    if cfg.api_key_env:
        credential_source_name = cfg.api_key_env.strip() or None
        credential_source_type = (
            "environment-with-configured-default"
            if cfg.api_key_default is not None
            else "environment"
        )
    elif cfg.api_key_default is not None:
        credential_source_name = "api_key_default"
        credential_source_type = "configured-default"
    elif cfg.kind == "anthropic":
        credential_source_name = "ANTHROPIC_API_KEY|CLAUDE_API_KEY"
        credential_source_type = "implicit-environment"
    else:
        credential_source_name = cfg.kind.strip().casefold() or None
        credential_source_type = "transport-managed"

    return FallbackAuthorityDescriptor(
        endpoint_scheme=scheme,
        endpoint_host=host,
        endpoint_port=port,
        transport_kind=cfg.kind.strip().casefold() or None,
        credential_source_name=credential_source_name,
        credential_source_type=credential_source_type,
        vendor_identity=_vendor_identity(cfg),
    )


def _fallback_authority_changes(
    primary: "ModelConfig",
    fallback: "ModelConfig",
) -> tuple[str, ...]:
    """Name changed authority dimensions without exposing credential values."""
    changes: list[str] = []
    if _normalized_endpoint_authority(primary) != _normalized_endpoint_authority(fallback):
        changes.append("endpoint")
    if primary.kind.strip().casefold() != fallback.kind.strip().casefold():
        changes.append("transport")
    if _credential_authority(primary) != _credential_authority(fallback):
        changes.append("credential")
    if _vendor_identity(primary) != _vendor_identity(fallback):
        changes.append("vendor")
    return tuple(changes)


def _same_provider_authority(primary: "ModelConfig", fallback: "ModelConfig") -> bool:
    """True only when every provider-authority component is unchanged."""
    primary_endpoint = _normalized_endpoint_authority(primary)
    fallback_endpoint = _normalized_endpoint_authority(fallback)
    return (
        primary_endpoint is not None
        and primary_endpoint == fallback_endpoint
        and primary.kind.strip().casefold() == fallback.kind.strip().casefold()
        and _credential_authority(primary) == _credential_authority(fallback)
        and _vendor_identity(primary) == _vendor_identity(fallback)
    )


# --------------------------------------------------------------------------- #
# Client with retry + fallback
# --------------------------------------------------------------------------- #


class ModelClient:
    """Generate text with retry, fallback chain, and cost/latency tracking."""

    def __init__(
        self,
        primary: ModelConfig,
        fallbacks: list[ModelConfig] | None = None,
        *,
        retries: int = 2,
        backoff_sec: float = 1.0,
        trace_sink: "Callable[[str, str, ModelResult], None] | None" = None,
        fallback_policy: FallbackPolicy | FallbackMode | str | None = None,
        fallback_confirmer: "Callable[[FallbackRequest], bool] | None" = None,
    ):
        self.primary = primary
        self.fallbacks = fallbacks or []
        self.retries = max(1, retries)
        self.backoff_sec = backoff_sec
        self.fallback_policy = FallbackPolicy.from_value(fallback_policy)
        self.fallback_confirmer = fallback_confirmer
        # Optional thinking-trace hook: called once per successful generate() with
        # (system, user, result). This is THE choke point every LLM call passes through —
        # planner, step, reflect, synthesis — so one sink captures every thinking step,
        # not just the ones the harness happens to log. None = no capture (default).
        self.trace_sink = trace_sink

    def generate(
        self,
        system: str,
        user: str,
        *,
        tools: list[dict] | None = None,
        on_token: Callable[[str], None] | None = None,
        on_thinking_token: Callable[[str], None] | None = None,
        on_provider_progress: ProviderProgressCallback | None = None,
        messages: list[dict] | None = None,
        response_format: dict | None = None,
        extra_body: dict | None = None,
        should_cancel: Callable[[], bool] | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> ModelResult:
        attempts: list[Attempt] = []
        configs = [self.primary, *self.fallbacks]
        last_failure: ProviderError | None = None
        last_result: ModelResult | None = None
        for index, cfg in enumerate(configs):
            if index > 0:
                _emit_provider_progress(
                    on_provider_progress,
                    phase="fallback",
                    provider=cfg.label or cfg.kind,
                    model=cfg.model,
                    status="pending",
                    detail="evaluating configured fallback",
                    attempt=index + 1,
                )
                request = FallbackRequest(
                    primary_provider=self.primary.label or self.primary.kind,
                    primary_model=self.primary.model,
                    fallback_provider=cfg.label or cfg.kind,
                    fallback_model=cfg.model,
                    reason=last_failure or classify_provider_error(
                        "primary provider failed",
                        provider=self.primary.label or self.primary.kind,
                        model=self.primary.model,
                    ),
                    primary_authority=_fallback_authority_descriptor(self.primary),
                    fallback_authority=_fallback_authority_descriptor(cfg),
                    authority_changes=_fallback_authority_changes(self.primary, cfg),
                )
                same_provider = _same_provider_authority(self.primary, cfg)
                allowed = same_provider and (
                    self.fallback_policy.allow_same_provider
                    or self.fallback_policy.mode is FallbackMode.AUTOMATIC
                )
                if not allowed and self.fallback_policy.mode in {
                    FallbackMode.CONFIRM,
                    FallbackMode.AUTOMATIC,
                }:
                    if self.fallback_confirmer is not None:
                        try:
                            allowed = bool(self.fallback_confirmer(request))
                        except Exception:  # noqa: BLE001 - confirmation fails closed
                            allowed = False
                    if not allowed:
                        info = ProviderError(
                            code=ProviderErrorCode.FALLBACK_CONFIRMATION_REQUIRED,
                            message=(
                                "cross-provider fallback confirmation required "
                                f"before {request.fallback_provider}/{request.fallback_model}"
                            ),
                            provider=request.primary_provider,
                            model=request.primary_model,
                            retryable=False,
                        )
                        return ModelResult(
                            text="",
                            provider=request.primary_provider,
                            model=request.primary_model,
                            ok=False,
                            error=info.message,
                            error_info=info,
                            finish_reason="fallback_confirmation_required",
                            attempts=attempts,
                            raw={"fallbackRequest": request.to_dict()},
                        )
                if not allowed:
                    break
            transport = _TRANSPORTS[cfg.kind]
            if cfg.kind != "mock" and _egress_blocked_for(cfg):
                err = f"airgap profile blocks egress to model provider '{cfg.label or cfg.kind}'"
                last_failure = classify_provider_error(
                    err, provider=cfg.label or cfg.kind, model=cfg.model
                )
                attempts.append(Attempt(
                    cfg.label or cfg.kind,
                    cfg.model,
                    False,
                    0.0,
                    last_failure.message,
                    last_failure.code.value,
                ))
                continue
            for attempt in range(self.retries):
                started = time.monotonic()
                _emit_provider_progress(
                    on_provider_progress,
                    phase="requesting",
                    provider=cfg.label or cfg.kind,
                    model=cfg.model,
                    status="in_progress",
                    detail="provider request started",
                    attempt=attempt + 1,
                    maxAttempts=self.retries,
                    fallback=index > 0,
                )
                try:
                    # should_cancel is a no-op kwarg for every transport that doesn't
                    # declare it (all accept **_) -- only the mlx transport currently
                    # checks it mid-generation; the others already stop at their own
                    # request boundary when cancelled from outside this call.
                    result = transport(system, user, cfg, tools=tools, on_token=on_token,
                                       on_thinking_token=on_thinking_token,
                                       on_provider_progress=on_provider_progress,
                                       messages=messages, response_format=response_format,
                                       extra_body=extra_body, should_cancel=should_cancel)
                except Exception as exc:  # transport-level failure
                    info = classify_provider_error(
                        exc, provider=cfg.label or cfg.kind, model=cfg.model
                    )
                    result = ModelResult(
                        text="",
                        provider=cfg.label or cfg.kind,
                        model=cfg.model,
                        ok=False,
                        error=info.message,
                        error_info=info,
                    )
                result = _normalize_result(result)
                last_result = result
                if not result.ok:
                    result.error_info = result.error_info or classify_provider_error(
                        result.error,
                        provider=result.provider or cfg.label or cfg.kind,
                        model=result.model or cfg.model,
                    )
                    result.error = result.error_info.message
                    last_failure = result.error_info
                result.latency_sec = round(time.monotonic() - started, 3)
                attempts.append(Attempt(
                    cfg.label or cfg.kind,
                    cfg.model,
                    result.ok,
                    result.latency_sec,
                    result.error,
                    result.error_info.code.value if result.error_info else None,
                ))
                if result.ok:
                    cost, known = estimate_cost(result.model, result.prompt_tokens, result.completion_tokens)
                    result.cost_usd = cost
                    if not known:
                        result.raw = {**(result.raw or {}), "costNote": "no price entry for model; cost=0"}
                    result.fallback_used = index > 0
                    result.attempts = attempts
                    if self.trace_sink is not None:
                        # Tracing must never break a verified generation — fail open.
                        try:
                            self.trace_sink(system, user, result)
                        except Exception:  # noqa: BLE001
                            pass
                    _emit_provider_progress(
                        on_provider_progress,
                        phase="completed",
                        provider=result.provider or cfg.label or cfg.kind,
                        model=result.model or cfg.model,
                        status="succeeded",
                        detail="provider response complete",
                        attempt=attempt + 1,
                        elapsedSec=result.latency_sec,
                        promptTokens=result.prompt_tokens,
                        completionTokens=result.completion_tokens,
                        reasoningTokens=result.reasoning_tokens,
                    )
                    return result
                retryable = _is_transient(result.error)
                if result.error_info is not None:
                    # Typed transport/protocol classification is authoritative.
                    # In particular, a streamed ``event: error`` may carry a
                    # transient nested provider payload whose human-readable
                    # text does not contain one of the legacy marker strings.
                    retryable = bool(result.error_info.retryable)
                if attempt < self.retries - 1 and retryable:
                    configured_delay = self.backoff_sec * (2 ** attempt)
                    server_delay = (
                        result.error_info.retry_after_sec
                        if result.error_info is not None
                        and result.error_info.retry_after_sec is not None
                        else 0.0
                    )
                    delay = max(configured_delay, server_delay)
                    _emit_provider_progress(
                        on_provider_progress,
                        phase="retrying",
                        provider=result.provider or cfg.label or cfg.kind,
                        model=result.model or cfg.model,
                        status="waiting",
                        detail=(
                            result.error_info.code.value
                            if result.error_info is not None
                            else "transient provider error"
                        ),
                        attempt=attempt + 2,
                        maxAttempts=self.retries,
                        delaySec=round(delay, 3),
                    )
                    sleep(delay)
                else:
                    _emit_provider_progress(
                        on_provider_progress,
                        phase="error",
                        provider=result.provider or cfg.label or cfg.kind,
                        model=result.model or cfg.model,
                        status="failed",
                        detail=(
                            result.error_info.code.value
                            if result.error_info is not None
                            else "provider request failed"
                        ),
                        attempt=attempt + 1,
                        elapsedSec=result.latency_sec,
                    )
                    break  # move to next fallback config
        failed = ModelResult(
            text="",
            provider=self.primary.label or self.primary.kind,
            model=self.primary.model,
            ok=False,
            error=(
                last_failure.message
                if last_failure
                else attempts[-1].error if attempts else "no attempts"
            ),
            error_info=last_failure,
            attempts=attempts,
            finish_reason=last_result.finish_reason if last_result else None,
            raw=last_result.raw if last_result else None,
            malformed_tool_call=(
                last_result.malformed_tool_call if last_result else False
            ),
            requires_native_tool_transcript=(
                last_result.requires_native_tool_transcript
                if last_result
                else False
            ),
        )
        _emit_provider_progress(
            on_provider_progress,
            phase="error",
            provider=failed.provider,
            model=failed.model,
            status="failed",
            detail=(
                failed.error_info.code.value
                if failed.error_info is not None
                else "all provider attempts failed"
            ),
        )
        return failed

    def generate_messages(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        on_token: Callable[[str], None] | None = None,
        on_thinking_token: Callable[[str], None] | None = None,
        on_provider_progress: ProviderProgressCallback | None = None,
        response_format: dict | None = None,
        extra_body: dict | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> ModelResult:
        """Multi-turn generation from an OpenAI-style message list.

        The openai/anthropic/mock transports consume ``messages`` natively. Codex
        receives the flattened transcript plus a strict Sophia tool envelope;
        other CLI transports (grok/openclaw/mlx) receive only the flattened
        legacy (system, user) pair. ``response_format`` is enforced only where
        the server supports it — callers keep post-validating
        (agent.structured_output).
        """
        if not messages:
            raise ValueError("messages must be a non-empty list of {role, content} dicts")
        system = "\n\n".join(
            str(m.get("content") or "") for m in messages if m.get("role") == "system"
        )
        transcript = "\n".join(
            f"{m.get('role', 'user')}: {m.get('content') or ''}"
            for m in messages
            if m.get("role") != "system"
        )
        return self.generate(system, transcript, tools=tools, on_token=on_token,
                             on_thinking_token=on_thinking_token,
                             on_provider_progress=on_provider_progress,
                             messages=messages, response_format=response_format,
                             should_cancel=should_cancel)

    def generate_many(
        self,
        requests: "Sequence[dict[str, Any]]",
        *,
        max_concurrency: int = 8,
    ) -> list[ModelResult]:
        """Run several independent generations concurrently (stdlib threads).

        Each request dict takes the ``generate``/``generate_messages`` kwargs:
        ``{"system": ..., "user": ...}`` or ``{"messages": [...]}``, plus optional
        ``tools`` / ``response_format``. Results return IN INPUT ORDER. This is
        client-side concurrency so a continuous-batching server (vLLM/SGLang)
        actually receives a batch; each call still carries the full retry/fallback
        chain. Determinism note: concurrent requests may be batched differently
        run-to-run by the server — certification runs that need bit-replayability
        must use max_concurrency=1 (the receipts record which lane produced what).
        """
        import concurrent.futures

        if max_concurrency < 1:
            raise ValueError("max_concurrency must be >= 1")

        def _one(req: dict[str, Any]) -> ModelResult:
            if req.get("messages"):
                return self.generate_messages(
                    req["messages"], tools=req.get("tools"),
                    response_format=req.get("response_format"))
            return self.generate(
                req.get("system", ""), req.get("user", ""), tools=req.get("tools"),
                messages=None, response_format=req.get("response_format"))

        if len(requests) <= 1 or max_concurrency == 1:
            return [_one(r) for r in requests]
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(max_concurrency, len(requests))) as pool:
            return list(pool.map(_one, requests))


def default_client(
    spec: str | None = None,
    *,
    fallback_confirmer: "Callable[[FallbackRequest], bool] | None" = None,
) -> ModelClient:
    """Build a ModelClient from the environment.

    SOPHIA_MODEL_PROVIDER selects the primary; SOPHIA_MODEL_FALLBACKS is a
    comma-separated list of provider[:model] specs. Cross-provider substitution
    defaults to confirmation; set SOPHIA_MODEL_FALLBACK_POLICY=automatic only
    for an explicitly unattended policy, or inject ``fallback_confirmer``.
    """
    primary = resolve_config(spec)
    fallbacks: list[ModelConfig] = []
    raw = os.environ.get("SOPHIA_MODEL_FALLBACKS", "").strip() if primary.allow_fallbacks else ""
    if raw:
        for token in raw.split(","):
            token = token.strip()
            if token:
                try:
                    fallbacks.append(resolve_config(token))
                except ValueError:
                    continue
    retries = int(os.environ.get("SOPHIA_MODEL_RETRIES", "2"))
    policy = fallback_policy_from_env() if primary.allow_fallbacks else FallbackPolicy.from_value("never")
    return ModelClient(
        primary,
        fallbacks,
        retries=retries,
        trace_sink=_env_trace_sink(),
        fallback_policy=policy,
        fallback_confirmer=fallback_confirmer if primary.allow_fallbacks else None,
    )


def default_worker_client(
    spec: str,
    *,
    fallback_confirmer: "Callable[[FallbackRequest], bool] | None" = None,
) -> ModelClient:
    """Build a no-fallback internal worker on the selected provider/key lane."""
    del fallback_confirmer
    return ModelClient(
        resolve_worker_config(spec),
        [],
        retries=1,
        trace_sink=_env_trace_sink(),
        fallback_policy=FallbackPolicy.from_value("never"),
        fallback_confirmer=None,
    )


def _env_trace_sink() -> "Callable[[str, str, ModelResult], None] | None":
    """Build a thinking-trace sink from the environment, or None when logging is off.

    Enabled by SOPHIA_THINKING_LOG (a path or "1"); imported lazily so the model adapter
    keeps no hard dependency on the trace writer and stays offline-importable."""
    if not (os.environ.get("SOPHIA_THINKING_LOG") or "").strip():
        return None
    try:
        from agent.thinking_trace import sink_from_env

        return sink_from_env()
    except Exception:  # noqa: BLE001
        return None


def complete(system: str, user: str, *, max_tokens: int = 2400, spec: str | None = None) -> str:
    """Backward-compatible string API (drop-in for agent.llm.complete).

    Raises RuntimeError on failure to preserve the previous contract.
    """
    cfg = resolve_config(spec)
    cfg.max_tokens = max_tokens
    client = ModelClient(
        cfg,
        _env_fallbacks(),
        retries=int(os.environ.get("SOPHIA_MODEL_RETRIES", "2")),
        fallback_policy=fallback_policy_from_env(),
    )
    result = client.generate(system, user)
    if not result.ok:
        raise RuntimeError(f"model call failed ({result.provider}/{result.model}): {result.error}")
    return result.text


def _env_fallbacks() -> list[ModelConfig]:
    raw = os.environ.get("SOPHIA_MODEL_FALLBACKS", "").strip()
    out: list[ModelConfig] = []
    for token in raw.split(",") if raw else []:
        token = token.strip()
        if token:
            try:
                out.append(resolve_config(token))
            except ValueError:
                continue
    return out


def probe_reasoning(spec: str, prompt: str, *,
                    system: str = "You are a careful problem solver. Reason step by step.") -> dict[str, Any]:
    """Diagnostic for the thinking-trace / distillation pipeline.

    Calls ``spec`` on ``prompt`` with verbatim reasoning capture FORCED on and
    returns exactly what the model emitted — the verbatim ``reasoning_content``
    (``reasoningText``) plus the answer. Use it to confirm a provider/model
    actually surfaces reasoning before relying on the thinking trace to distill
    it (e.g. gpt-5.6-sol returns none unless ``reasoning_effort`` is high — the
    020s preset now defaults it to high for exactly this reason).

    When ``SOPHIA_THINKING_LOG`` is set, the call is ALSO recorded verbatim to the
    thinking trace (``agent/memory/thinking/*.jsonl``) via the usual trace sink,
    giving a ready-made distillation record. The global SOPHIA_CAPTURE_THINKING
    value is restored afterwards so a probe never leaks that state."""
    prev = os.environ.get("SOPHIA_CAPTURE_THINKING")
    os.environ["SOPHIA_CAPTURE_THINKING"] = "1"  # force verbatim reasoning for this probe
    try:
        result = default_client(spec).generate(system, prompt)
    finally:
        if prev is None:
            os.environ.pop("SOPHIA_CAPTURE_THINKING", None)
        else:
            os.environ["SOPHIA_CAPTURE_THINKING"] = prev
    return {
        "spec": spec,
        "model": result.model,
        "provider": result.provider,
        "ok": result.ok,
        "finishReason": result.finish_reason,
        "reasoningText": result.reasoning_text,
        "reasoningTokens": result.reasoning_tokens,
        "hasReasoning": bool(result.reasoning_text),
        "answer": result.text,
        "error": result.error,
    }


if __name__ == "__main__":
    import sys as _sys

    if len(_sys.argv) >= 4 and _sys.argv[1] == "probe":
        _spec = _sys.argv[2]
        _prompt = " ".join(_sys.argv[3:])
        print(json.dumps(probe_reasoning(_spec, _prompt), ensure_ascii=False, indent=2))
    else:
        print('usage: python -m agent.model probe <model-spec> "<prompt>"')
        print("       set SOPHIA_THINKING_LOG=1 to also log the verbatim reasoning to agent/memory/thinking/")
