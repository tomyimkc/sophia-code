# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Runtime/backend detection and install planning for Sophia terminal.

No install command runs unless the terminal operator explicitly approves it. Plans
avoid sudo and prefer user-owned locations under ~/.sophia or user-site Python.
"""
from __future__ import annotations

import importlib.util
import json
import os
import platform
import shlex
import shutil
import socket
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping


@dataclass
class RuntimeStatus:
    os_name: str
    machine: str
    python: str
    is_apple_silicon: bool
    has_nvidia: bool
    commands: dict[str, bool] = field(default_factory=dict)
    packages: dict[str, bool] = field(default_factory=dict)
    ollama_models: list[str] = field(default_factory=list)
    local_hf_models: list[str] = field(default_factory=list)
    local_mlx_models: list[str] = field(default_factory=list)
    local_ds4_models: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class LocalEngine:
    """A locally installed inference engine or optional loopback gateway.

    Detection is deliberately no-spend: it checks binaries/packages, bounded
    local cache metadata, and whether a loopback TCP port accepts connections.
    It never sends a generation request and never contacts a cloud endpoint.
    """

    name: str
    provider: str
    installed: bool
    running: bool
    base_url: str | None = None
    command: str | None = None
    models: tuple[str, ...] = ()
    model_files: tuple[str, ...] = ()
    optional_gateway: bool = False

    @property
    def ready(self) -> bool:
        return self.installed and (self.running or self.base_url is None)

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "provider": self.provider,
            "installed": self.installed,
            "running": self.running,
            "ready": self.ready,
            "baseUrl": self.base_url,
            "command": self.command,
            "models": list(self.models),
            "modelFiles": list(self.model_files),
            "optionalGateway": self.optional_gateway,
            "noSpendProbe": True,
        }


@dataclass(frozen=True)
class ProviderProfile:
    """Operator-facing provider defaults, separate from model credentials."""

    name: str
    default_provider: str
    permission: str
    auto_dispatch: bool
    fallback_policy: str
    image_provider: str
    prefer_direct_credentials: bool = True
    local_gateways_optional: bool = True

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "defaultProvider": self.default_provider,
            "permission": self.permission,
            "autoDispatch": self.auto_dispatch,
            "fallbackPolicy": self.fallback_policy,
            "imageProvider": self.image_provider,
            "preferDirectCredentials": self.prefer_direct_credentials,
            "localGatewaysOptional": self.local_gateways_optional,
        }


@dataclass
class InstallPlan:
    target: str
    title: str
    commands: list[list[str]]
    notes: list[str] = field(default_factory=list)
    after: list[str] = field(default_factory=list)


def _which(name: str) -> bool:
    return shutil.which(name) is not None


def _pkg(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def _loopback_port_open(port: int, *, timeout: float = 0.15) -> bool:
    """Return whether a local TCP listener is present, without sending data."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def _ollama_models() -> list[str]:
    if not _which("ollama"):
        return []
    try:
        proc = subprocess.run(["ollama", "list"], text=True, capture_output=True, timeout=5, check=False)
    except Exception:
        return []
    if proc.returncode != 0:
        return []
    models: list[str] = []
    for line in proc.stdout.splitlines()[1:]:
        parts = line.split()
        if parts and ":" in parts[0]:
            models.append(parts[0])
    return models


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _dedupe_paths(values: list[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for value in values:
        key = str(value)
        if key and key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _env_path(name: str) -> Path | None:
    value = (os.environ.get(name) or "").strip()
    return Path(value).expanduser() if value else None


def _cache_roots() -> dict[str, list[Path]]:
    """Return likely local model-cache roots without creating or mutating them.

    The app uses this only for environment awareness.  Detection is deliberately
    read-only and bounded so a large cache cannot make first launch feel hung.
    """
    xdg_cache = _env_path("XDG_CACHE_HOME") or (Path.home() / ".cache")
    hf_home = _env_path("HF_HOME") or (xdg_cache / "huggingface")
    roots = {
        "hf": [
            _env_path("HUGGINGFACE_HUB_CACHE"),
            _env_path("HF_HUB_CACHE"),
            _env_path("TRANSFORMERS_CACHE"),
            hf_home / "hub",
            Path.home() / ".cache" / "huggingface" / "hub",
        ],
        "modelscope": [
            _env_path("MODELSCOPE_CACHE"),
            Path.home() / ".cache" / "modelscope" / "hub",
        ],
        "mlx": [
            _env_path("MLX_CACHE_DIR"),
            _env_path("MLX_LM_CACHE"),
            Path.home() / ".cache" / "mlx",
            Path.home() / ".cache" / "mlx_lm",
        ],
    }
    return {key: _dedupe_paths([root for root in values if root]) for key, values in roots.items()}


def _cache_model_name(path: Path) -> str | None:
    """Best-effort model-id extraction for common cache directory layouts."""
    name = path.name
    if name.startswith("models--"):
        return name.removeprefix("models--").replace("--", "/")
    # Some local MLX caches are plain owner/model-like names flattened with "--".
    if "--" in name and not name.startswith("."):
        return name.replace("--", "/")
    return None


_CACHE_SCAN_MAX_ENTRIES = 200
_CACHE_SCAN_MAX_RESULTS = 200


def _models_under(
    root: Path,
    *,
    max_entries: int = _CACHE_SCAN_MAX_ENTRIES,
    max_results: int = _CACHE_SCAN_MAX_RESULTS,
) -> list[str]:
    """List cache model names without consuming an unbounded directory."""
    if max_entries <= 0 or max_results <= 0:
        return []
    children: list[Path] = []
    try:
        with os.scandir(root) as entries:
            for _ in range(max_entries):
                try:
                    entry = next(entries)
                except StopIteration:
                    break
                try:
                    if entry.is_dir():
                        children.append(Path(entry.name))
                except OSError:
                    continue
    except OSError:
        return []
    names: list[str] = []
    for path in sorted(children, key=lambda candidate: candidate.name):
        name = _cache_model_name(path)
        if name and name not in names:
            names.append(name)
            if len(names) >= max_results:
                break
    return names


def _hf_cache_models() -> list[str]:
    names: list[str] = []
    roots = _cache_roots()
    for root in roots["hf"] + roots["modelscope"]:
        names.extend(_models_under(root))
    return _dedupe(names)


def _mlx_cache_models(hf_models: list[str]) -> list[str]:
    names = [name for name in hf_models if name.lower().startswith("mlx-community/")]
    for root in _cache_roots()["mlx"]:
        names.extend(_models_under(root))
    return _dedupe(names)


_DS4_MODEL_MARKERS = (
    "ds4flash",
    "deepseek-v4-flash",
    "deepseek_v4_flash",
    "deepseekv4flash",
)
_DS4_SCAN_MAX_ROOTS = 16
_DS4_SCAN_MAX_ENTRIES = 2_000
_DS4_SCAN_MAX_RESULTS = 64
_DS4_SCAN_MAX_DEPTH = 5


def _ds4_binary_path(
    environ: Mapping[str, str] | None = None,
    *,
    home: Path | None = None,
) -> Path | None:
    """Resolve an executable DS4 binary from PATH or the managed user install."""
    env = os.environ if environ is None else environ
    home = Path.home() if home is None else home
    candidates: list[Path] = []
    path_text = str(env.get("PATH") or "")
    if path_text:
        try:
            path_binary = shutil.which("ds4-server", path=path_text)
        except (OSError, RuntimeError):
            path_binary = None
        if path_binary:
            candidates.append(Path(path_binary))
    candidates.append(home / ".local" / "bin" / "ds4-server")

    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        try:
            resolved = candidate.expanduser().resolve(strict=True)
            if resolved.is_file() and os.access(resolved, os.X_OK):
                return resolved
        except (OSError, RuntimeError):
            continue
    return None


def _ds4_config_values(
    environ: Mapping[str, str],
    *,
    home: Path,
) -> dict[str, str]:
    """Read the owner-local DS4 config without sourcing shell code.

    ``scripts/sophia_ds4_spark.sh`` writes one shell-quoted ``KEY=value`` token
    per line. Parse only the model-discovery keys needed here; arbitrary
    shell syntax is ignored rather than executed.
    """
    config_path = Path(
        environ.get("SOPHIA_DS4_CONFIG")
        or (home / ".config" / "sophia" / "ds4-spark.env")
    ).expanduser()
    if not config_path.is_file() or config_path.is_symlink():
        return {}
    allowed = {
        "SOPHIA_DS4_MODEL_PATH",
        "SOPHIA_DS4_MODEL_DIR",
        "SOPHIA_DS4_SOURCE_ROOT",
    }
    values: dict[str, str] = {}
    try:
        lines = config_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return {}
    for raw in lines[:128]:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            parts = shlex.split(line, posix=True)
        except ValueError:
            continue
        if len(parts) != 1 or "=" not in parts[0]:
            continue
        key, value = parts[0].split("=", 1)
        if key in allowed and value:
            values[key] = value
    return values


def _ds4_model_files(
    environ: Mapping[str, str] | None = None,
    *,
    home: Path | None = None,
) -> list[str]:
    """Return a bounded, read-only inventory of likely DS4 GGUF files.

    Operators can provide one exact file with ``SOPHIA_DS4_MODEL_PATH``, one
    managed directory with ``SOPHIA_DS4_MODEL_DIR``, and/or a
    platform-separated directory list with ``SOPHIA_DS4_MODEL_DIRS``. The
    owner-local Spark config is read safely as a fallback so a normally
    launched TUI can find the model selected by the service. Default roots
    cover the managed Sophia DS4 directory, conventional upstream DS4
    checkouts, a conventional ``~/models`` directory, and Hugging Face's
    cache. We never crawl the whole home directory: every walk has hard root,
    depth, entry, and result limits.
    """
    env = os.environ if environ is None else environ
    home = Path.home() if home is None else home
    xdg_cache = Path(env.get("XDG_CACHE_HOME") or (home / ".cache")).expanduser()
    hf_home = Path(env.get("HF_HOME") or (xdg_cache / "huggingface")).expanduser()
    config = _ds4_config_values(env, home=home)

    exact: list[Path] = []
    exact_raw = str(
        env.get("SOPHIA_DS4_MODEL_PATH")
        or config.get("SOPHIA_DS4_MODEL_PATH")
        or ""
    ).strip()
    if exact_raw:
        exact.append(Path(exact_raw).expanduser())

    configured_root_texts = [
        str(env.get("SOPHIA_DS4_MODEL_DIR") or "").strip(),
        str(config.get("SOPHIA_DS4_MODEL_DIR") or "").strip(),
    ]
    configured_root_texts.extend(
        value.strip()
        for value in str(env.get("SOPHIA_DS4_MODEL_DIRS") or "").split(os.pathsep)
        if value.strip()
    )
    configured_roots = [
        Path(value).expanduser()
        for value in configured_root_texts
        if value
    ]
    source_root_text = str(
        env.get("SOPHIA_DS4_SOURCE_ROOT")
        or config.get("SOPHIA_DS4_SOURCE_ROOT")
        or ""
    ).strip()
    source_root = Path(source_root_text).expanduser() if source_root_text else None
    ds4_binary = _ds4_binary_path(env, home=home)
    binary_gguf_root = ds4_binary.parent / "gguf" if ds4_binary else None
    default_root_candidates = [
        home / ".local" / "share" / "sophia" / "ds4" / "models",
        source_root / "current" / "gguf" if source_root else None,
        binary_gguf_root,
        home / "ds4" / "gguf",
        home / "src" / "ds4" / "gguf",
        home / "DwarfStar" / "gguf",
        home / ".local" / "src" / "ds4" / "gguf",
        home / ".sophia" / "models",
        home / "models",
        Path(env.get("HUGGINGFACE_HUB_CACHE") or "").expanduser()
        if env.get("HUGGINGFACE_HUB_CACHE") else None,
        Path(env.get("HF_HUB_CACHE") or "").expanduser()
        if env.get("HF_HUB_CACHE") else None,
        hf_home / "hub",
    ]
    default_roots = _dedupe_paths(
        [root for root in default_root_candidates if root]
    )[:_DS4_SCAN_MAX_ROOTS]
    default_root_keys = {str(root) for root in default_roots}
    optional_roots = [
        root
        for root in _dedupe_paths(configured_roots)
        if str(root) not in default_root_keys
    ]
    optional_root_budget = max(0, _DS4_SCAN_MAX_ROOTS - len(default_roots))
    roots = optional_roots[:optional_root_budget] + default_roots
    explicit_roots = {str(path) for path in configured_roots}

    results: list[str] = []
    seen: set[str] = set()

    def accept(
        path: Path,
        *,
        explicit: bool,
        known_regular_file: bool = False,
    ) -> None:
        if len(results) >= _DS4_SCAN_MAX_RESULTS:
            return
        if not known_regular_file:
            try:
                if path.is_symlink() or not path.is_file():
                    return
            except OSError:
                return
        name = path.name.casefold()
        if (
            path.suffix.casefold() != ".gguf"
            or (
                not explicit
                and not any(marker in name for marker in _DS4_MODEL_MARKERS)
            )
        ):
            return
        try:
            key = str(path.resolve(strict=False))
        except (OSError, RuntimeError):
            return
        if key not in seen:
            seen.add(key)
            results.append(key)

    for path in exact:
        accept(path, explicit=True)

    # Reserve a finite share of the global entry budget for every candidate
    # root. A large configured/cache directory must not consume the complete
    # allowance before later conventional roots such as ~/ds4/gguf are seen.
    per_root_budget = max(
        1,
        _DS4_SCAN_MAX_ENTRIES // max(1, len(roots)),
    )
    entries_seen = 0
    for root in roots:
        if (
            len(results) >= _DS4_SCAN_MAX_RESULTS
            or entries_seen >= _DS4_SCAN_MAX_ENTRIES
        ):
            break
        try:
            if root.is_symlink() or not root.is_dir():
                continue
        except OSError:
            continue
        explicit = str(root) in explicit_roots
        stack: list[tuple[Path, int]] = [(root, 0)]
        root_entries_seen = 0
        while (
            stack
            and root_entries_seen < per_root_budget
            and entries_seen < _DS4_SCAN_MAX_ENTRIES
            and len(results) < _DS4_SCAN_MAX_RESULTS
        ):
            current, depth = stack.pop()
            try:
                with os.scandir(current) as children:
                    for child in children:
                        if (
                            root_entries_seen >= per_root_budget
                            or entries_seen >= _DS4_SCAN_MAX_ENTRIES
                        ):
                            break
                        root_entries_seen += 1
                        entries_seen += 1
                        try:
                            if child.is_symlink():
                                continue
                            if child.is_dir(follow_symlinks=False):
                                if depth < _DS4_SCAN_MAX_DEPTH:
                                    stack.append((Path(child.path), depth + 1))
                                continue
                            if not child.is_file(follow_symlinks=False):
                                continue
                        except OSError:
                            continue
                        accept(
                            Path(child.path),
                            explicit=explicit,
                            known_regular_file=True,
                        )
                        if len(results) >= _DS4_SCAN_MAX_RESULTS:
                            break
            except OSError:
                continue
    return results


def detect_status() -> RuntimeStatus:
    os_name = platform.system()
    machine = platform.machine()
    ds4_binary = _ds4_binary_path()
    commands = {
        name: ds4_binary is not None if name == "ds4-server" else _which(name)
        for name in [
            "ollama", "python3", "pipx", "docker", "git", "cmake", "make",
            "nvidia-smi", "nvcc", "llama-server", "vllm", "sglang",
            "ds4-server", "pulsar-server", "omlx", "grok", "codex", "openclaw",
        ]
    }
    packages = {name: _pkg(name) for name in ["mlx_lm", "transformers", "vllm", "sglang", "llama_cpp"]}
    has_nvidia = commands.get("nvidia-smi", False)
    hf_models = _hf_cache_models()
    return RuntimeStatus(
        os_name=os_name,
        machine=machine,
        python=shutil.which("python3") or "python3",
        is_apple_silicon=(os_name == "Darwin" and machine in {"arm64", "aarch64"}),
        has_nvidia=has_nvidia,
        commands=commands,
        packages=packages,
        ollama_models=_ollama_models(),
        local_hf_models=hf_models,
        local_mlx_models=_mlx_cache_models(hf_models),
        local_ds4_models=_ds4_model_files(),
    )


_DIRECT_CREDENTIAL_PROVIDERS: tuple[tuple[str, str], ...] = (
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("zai", "ZAI_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("glm", "ZHIPUAI_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("xai", "XAI_API_KEY"),
    ("qwen", "DASHSCOPE_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("llmhub", "LLMHUB_API_KEY"),
    ("020s", "SOPHIA_020S_KEY"),
)


def direct_credential_provider(environ: Mapping[str, str] | None = None) -> str | None:
    """First directly credentialed cloud provider, checking presence only.

    Values are never returned, logged, or included in a status object. Loopback
    proxy presets such as ``codex-api`` (:8788) and ``qwen-coding`` (:8789) are
    intentionally absent: the public profile treats them as optional external
    gateways, not prerequisites for using saved/direct provider credentials.
    """
    env = os.environ if environ is None else environ
    for provider, key_env in _DIRECT_CREDENTIAL_PROVIDERS:
        if str(env.get(key_env, "")).strip():
            return provider
    return None


def provider_profile(
    name: str | None = None,
    *,
    status: RuntimeStatus | None = None,
    environ: Mapping[str, str] | None = None,
) -> ProviderProfile:
    """Return public or this-Mac defaults without mutating operator config.

    ``SOPHIA_PROVIDER_PROFILE`` (or ``SOPHIA_RUNTIME_PROFILE``) selects the
    profile when ``name`` is omitted. The default is the conservative public
    profile. ``this-mac``/``mac-local`` is the explicit workstation profile:
    oMLX, full-authority ``auto`` permission, automatic team dispatch, and
    Grok CLI image delegation. Cross-provider fallback still defaults to
    confirmation in both profiles.
    """
    env = os.environ if environ is None else environ
    raw = (
        name
        or env.get("SOPHIA_PROVIDER_PROFILE")
        or env.get("SOPHIA_RUNTIME_PROFILE")
        or "public"
    )
    normalized = str(raw).strip().lower().replace("_", "-")
    if normalized == "auto":
        current = status or detect_status()
        normalized = (
            "this-mac"
            if current.is_apple_silicon and current.commands.get("omlx")
            else "public"
        )
    if normalized in {"this-mac", "mac-local", "local-mac", "workstation"}:
        return ProviderProfile(
            name="this-mac",
            default_provider="omlx",
            permission="auto",
            auto_dispatch=True,
            fallback_policy="confirm",
            image_provider="grok-cli",
        )
    if normalized not in {"public", "default"}:
        raise ValueError(f"unknown provider profile {raw!r}; valid: public, this-mac")
    direct = direct_credential_provider(env)
    return ProviderProfile(
        name="public",
        default_provider=direct or "mock",
        permission="manual",
        auto_dispatch=False,
        fallback_policy="confirm",
        image_provider="none",
    )


def detect_local_engines(
    status: RuntimeStatus | None = None,
    *,
    port_probe: Callable[[int], bool] | None = None,
) -> list[LocalEngine]:
    """Public, deterministic local-engine discovery.

    The result includes ordinary local engines and the two loopback proxy
    gateways used on the maintainer workstation. The latter are marked
    ``optional_gateway`` and are never selected as public-profile defaults.
    """
    status = status or detect_status()
    probe = port_probe or _loopback_port_open

    def command(name: str) -> bool:
        return bool(status.commands.get(name))

    engines: list[LocalEngine] = []
    ds4_command = (
        "ds4-server"
        if command("ds4-server")
        else "pulsar-server"
        if command("pulsar-server")
        else None
    )
    # DwarfStar is a deliberately narrow GGUF runtime. Surface a detected
    # DeepSeek V4 Flash file even when the server binary is missing so the TUI
    # can say "model found, runtime missing" instead of pretending nothing is
    # installed. A listener alone is not enough to claim DS4 identity because
    # port 8000 is also shared by vLLM and oMLX.
    if ds4_command or status.local_ds4_models:
        engines.append(LocalEngine(
            name="DwarfStar (ds4)",
            provider="ds4",
            installed=bool(ds4_command),
            running=bool(ds4_command and probe(8000)),
            base_url="http://127.0.0.1:8000/v1",
            command=ds4_command or "ds4-server",
            model_files=tuple(status.local_ds4_models),
        ))
    # Port 8000 may host oMLX or vLLM. Prefer the platform-native identity when
    # its binary is installed, while still exposing vLLM when independently
    # installed. No HTTP request or model generation is made here.
    if command("omlx") or status.is_apple_silicon:
        engines.append(LocalEngine(
            name="oMLX",
            provider="omlx",
            installed=command("omlx"),
            running=probe(8000),
            base_url="http://127.0.0.1:8000/v1",
            command="omlx",
            models=tuple(status.local_mlx_models),
        ))
    if command("vllm") or status.packages.get("vllm"):
        engines.append(LocalEngine(
            name="vLLM",
            provider="vllm",
            installed=command("vllm") or bool(status.packages.get("vllm")),
            running=probe(8000),
            base_url="http://127.0.0.1:8000/v1",
            command="vllm",
            models=tuple(status.local_hf_models),
        ))
    if command("ollama"):
        engines.append(LocalEngine(
            name="Ollama",
            provider="ollama",
            installed=True,
            running=probe(11434),
            base_url="http://127.0.0.1:11434/v1",
            command="ollama",
            models=tuple(status.ollama_models),
        ))
    if command("sglang") or status.packages.get("sglang"):
        engines.append(LocalEngine(
            name="SGLang",
            provider="sglang",
            installed=command("sglang") or bool(status.packages.get("sglang")),
            running=probe(30000),
            base_url="http://127.0.0.1:30000/v1",
            command="sglang",
            models=tuple(status.local_hf_models),
        ))
    if command("llama-server") or status.packages.get("llama_cpp"):
        engines.append(LocalEngine(
            name="llama.cpp",
            provider="llamacpp",
            installed=command("llama-server") or bool(status.packages.get("llama_cpp")),
            running=probe(8080),
            base_url="http://127.0.0.1:8080/v1",
            command="llama-server",
        ))

    # These are transport conveniences, not required local engines.
    engines.extend([
        LocalEngine(
            name="Codex API loopback gateway",
            provider="codex-api",
            installed=probe(8788),
            running=probe(8788),
            base_url="http://127.0.0.1:8788",
            optional_gateway=True,
        ),
        LocalEngine(
            name="Qwen Coding loopback gateway",
            provider="qwen-coding",
            installed=probe(8789),
            running=probe(8789),
            base_url="http://127.0.0.1:8789",
            optional_gateway=True,
        ),
    ])
    return engines


def detect_local_provider(
    status: RuntimeStatus | None = None,
    *,
    port_probe: Callable[[int], bool] | None = None,
) -> str | None:
    """Best ready local engine alias, excluding optional proxy gateways."""
    if status is None:
        os_name = platform.system()
        machine = platform.machine()
        # Keep model resolution cheap: unlike the full runtime status screen,
        # provider auto-selection does not need to scan caches or run
        # ``ollama list``. Binary/package presence + a loopback listener is
        # enough to choose an alias; provider_health verifies /models later.
        commands = {
            name: _which(name)
            for name in (
                "ds4-server", "pulsar-server", "omlx", "ollama", "vllm",
                "sglang", "llama-server",
            )
        }
        status = RuntimeStatus(
            os_name=os_name,
            machine=machine,
            python=shutil.which("python3") or "python3",
            is_apple_silicon=(os_name == "Darwin" and machine in {"arm64", "aarch64"}),
            has_nvidia=False,
            commands=commands,
            packages={
                "vllm": _pkg("vllm"),
                "sglang": _pkg("sglang"),
                "llama_cpp": _pkg("llama_cpp"),
            },
        )
    priority = {"ds4": 0, "omlx": 1, "vllm": 2, "ollama": 3, "sglang": 4, "llamacpp": 5}
    ready = [
        engine for engine in detect_local_engines(status, port_probe=port_probe)
        if engine.ready and not engine.optional_gateway and engine.provider in priority
    ]
    if not ready:
        return None
    return min(ready, key=lambda engine: priority[engine.provider]).provider


def recommended_backend(status: RuntimeStatus) -> str:
    if status.os_name == "Linux" and status.has_nvidia:
        if (
            (status.commands.get("ds4-server") or status.commands.get("pulsar-server"))
            and status.local_ds4_models
        ):
            return "ds4-ready" if _loopback_port_open(8000) else "ds4"
        return "vllm" if not status.packages.get("vllm") else "vllm-ready"
    if status.is_apple_silicon:
        if status.commands.get("omlx") and _loopback_port_open(8000):
            return "omlx-ready"
        if status.commands.get("omlx"):
            return "omlx"
        if status.commands.get("ollama") and status.ollama_models:
            return "ollama-ready"
        return "mlx-lm"
    if status.commands.get("ollama") and status.ollama_models:
        return "ollama-ready"
    return "llama.cpp"


def install_plan(target: str, *, home: Path | None = None, python: str = "python3") -> InstallPlan:
    home = home or Path.home()
    rt = home / ".sophia" / "runtimes"
    if target in {"ds4", "dwarfstar", "pulsar"}:
        resource_root = Path(
            os.environ.get("SOPHIA_RESOURCE_ROOT")
            or Path(__file__).resolve().parents[1]
        )
        if resource_root.name == "python" and (resource_root.parent / "scripts").is_dir():
            resource_root = resource_root.parent
        script = resource_root / "scripts" / "sophia_ds4_spark.sh"
        return InstallPlan(
            target="ds4",
            title="Install DwarfStar for DeepSeek V4 Flash on DGX Spark",
            commands=[["bash", str(script), "install"]],
            notes=[
                "DGX Spark-only narrow exception for DeepSeek V4 Flash GGUF; vLLM remains the general Linux default.",
                "The installer is explicit and user-owned. Run `scan` first; large model downloads are never implicit.",
            ],
            after=[
                f"bash {script} serve",
                "sophia --model ds4:deepseek-v4-flash@http://127.0.0.1:8000/v1",
            ],
        )
    if target in {"mlx", "mlx-lm"}:
        return InstallPlan(
            target="mlx-lm",
            title="Install MLX-LM for Apple Silicon local inference",
            commands=[[python, "-m", "pip", "install", "--user", "mlx-lm"]],
            notes=[
                "Best native Apple Silicon path. Installs into the current Python user site.",
                "If Homebrew Python reports PEP 668 externally-managed, use a venv or rerun manually with your preferred policy.",
            ],
            after=["sophia --model mlx:Qwen/Qwen2.5-3B-Instruct -p 'hello'"],
        )
    if target == "vllm":
        venv = rt / "vllm"
        py = venv / "bin" / "python"
        return InstallPlan(
            target="vllm",
            title="Install vLLM in an isolated Sophia runtime venv",
            commands=[
                [python, "-m", "venv", str(venv)],
                [str(py), "-m", "pip", "install", "--upgrade", "pip"],
                [str(py), "-m", "pip", "install", "vllm"],
            ],
            notes=["Best for Linux + NVIDIA parallel serving; isolated under ~/.sophia/runtimes/vllm."],
            after=["~/.sophia/runtimes/vllm/bin/python -m vllm.entrypoints.openai.api_server --model <hf-model>",
                   "sophia --model vllm:<hf-model> --server http://localhost:8000/v1"],
        )
    if target == "sglang":
        venv = rt / "sglang"
        py = venv / "bin" / "python"
        return InstallPlan(
            target="sglang",
            title="Install SGLang in an isolated Sophia runtime venv",
            commands=[
                [python, "-m", "venv", str(venv)],
                [str(py), "-m", "pip", "install", "--upgrade", "pip"],
                [str(py), "-m", "pip", "install", "sglang", "sglang-kernel"],
            ],
            notes=["Strong for structured/agentic serving on Linux + NVIDIA; isolated under ~/.sophia/runtimes/sglang."],
            after=["~/.sophia/runtimes/sglang/bin/python -m sglang.launch_server --model-path <hf-model>",
                   "sophia --model sglang:<hf-model> --server http://localhost:30000/v1"],
        )
    if target in {"llamacpp", "llama.cpp"}:
        src = rt / "llama.cpp"
        return InstallPlan(
            target="llama.cpp",
            title="Build llama.cpp server under ~/.sophia/runtimes",
            commands=[
                ["git", "clone", "https://github.com/ggml-org/llama.cpp", str(src)],
                ["cmake", "-S", str(src), "-B", str(src / "build")],
                ["cmake", "--build", str(src / "build"), "--config", "Release", "-t", "llama-server"],
            ],
            notes=["Portable GGUF server path for Mac/Linux CPU/Metal/CUDA. Requires git + cmake."],
            after=[str(src / "build" / "bin" / "llama-server") + " -m <model.gguf> --port 8080 --parallel 4",
                   "sophia --model llamacpp:local --server http://localhost:8080/v1"],
        )
    if target == "ollama":
        return InstallPlan(
            target="ollama",
            title="Install/setup Ollama",
            commands=[],
            notes=["Ollama install is best done with the official app/installer for your OS, then `ollama pull <model>`.",
                   "Sophia auto-detects `ollama list` models and exposes them in /model."],
            after=["ollama pull qwen3:30b-a3b", "sophia", "/model ollama:qwen3:30b-a3b"],
        )
    raise ValueError(f"unknown install target: {target}")


def best_install_plan(status: RuntimeStatus) -> InstallPlan | None:
    rec = recommended_backend(status)
    if rec in {"omlx", "omlx-ready"}:
        return None
    if rec == "ds4":
        return install_plan("ds4", python=status.python)
    if rec == "ds4-ready":
        return None
    if rec == "vllm":
        return install_plan("vllm", python=status.python)
    if rec == "mlx-lm":
        return install_plan("mlx-lm", python=status.python)
    if rec == "llama.cpp":
        return install_plan("llama.cpp", python=status.python)
    return None


def format_status(status: RuntimeStatus) -> str:
    lines = [
        "Sophia runtime config status:",
        f"  OS/arch       : {status.os_name} / {status.machine}",
        f"  Python        : {status.python}",
        f"  Apple Silicon : {status.is_apple_silicon}",
        f"  NVIDIA GPU    : {status.has_nvidia}",
        "  Commands      : " + ", ".join(f"{k}={'yes' if v else 'no'}" for k, v in status.commands.items()),
        "  Python pkgs   : " + ", ".join(f"{k}={'yes' if v else 'no'}" for k, v in status.packages.items()),
        "  Ollama models : " + (", ".join(status.ollama_models) if status.ollama_models else "none detected"),
        "  HF cache      : " + (", ".join(status.local_hf_models[:12]) if status.local_hf_models else "none detected"),
        "  MLX cache     : " + (", ".join(status.local_mlx_models[:12]) if status.local_mlx_models else "none detected"),
        "  DS4 GGUF      : " + (", ".join(status.local_ds4_models[:8]) if status.local_ds4_models else "none detected"),
        f"  Recommendation: {recommended_backend(status)}",
    ]
    return "\n".join(lines)


def format_plan(plan: InstallPlan | None) -> str:
    if plan is None:
        return "No install needed for the current recommendation; a usable backend is already available."
    lines = [plan.title, "", "Commands:"]
    if not plan.commands:
        lines.append("  (manual installer / no safe automatic command)")
    for cmd in plan.commands:
        lines.append("  " + " ".join(cmd))
    if plan.notes:
        lines += ["", "Notes:"] + ["  - " + n for n in plan.notes]
    if plan.after:
        lines += ["", "After install:"] + ["  " + a for a in plan.after]
    return "\n".join(lines)


def _cli_model_ready(alias: str, spec: str) -> "tuple[bool, str] | None":
    """Best-effort delegate to ``agent.cli``'s existing per-spec readiness probe.

    Returns ``None`` (never raises) when ``agent.cli`` cannot be imported or
    its private probe's signature has drifted, degrading a preflight to
    "unknown" instead of crashing whatever status screen called it. Import is
    lazy and local: ``agent.cli`` imports ``agent_loop``/``agent_tools`` at
    module scope, which is fine for a CLI entrypoint but makes it exactly the
    kind of heavy, import-order-sensitive module a GUI status probe must not
    depend on succeeding.
    """
    try:
        from agent.cli import _model_ready
    except Exception:
        return None
    try:
        return _model_ready(alias, spec)
    except Exception:
        return None


def _spec_transport(spec: str) -> "tuple[str, str | None]":
    """Best-guess (transport, endpoint) for a model spec, for display only.

    Deliberately independent of ``agent.cli``'s internals beyond the readiness
    probe reused above: this only needs to say roughly WHERE a preflight
    looked, not duplicate cli.py's provider-selection logic.
    """
    normalized = spec.casefold()
    if normalized == "mock":
        return "mock", None
    if normalized.startswith("ollama:"):
        return "ollama-cli", "http://127.0.0.1:11434/v1"
    if normalized == "omlx" or normalized.startswith("omlx:"):
        return "http", "http://127.0.0.1:8000/v1"
    if normalized == "mlx" or normalized.startswith("mlx:"):
        return "mlx-lm", None
    if normalized in {"ds4", "pulsar"} or normalized.startswith(("ds4:", "pulsar:")):
        if "@" in spec:
            return "http", spec.split("@", 1)[1]
        return "http", "http://127.0.0.1:8000/v1"
    if normalized.startswith("vllm:") or normalized in {"qwen3.6-35b", "qwen3.6", "qwen36-local", "vllm"}:
        if "@" in spec:
            return "http", spec.split("@", 1)[1]
        return "http", "http://127.0.0.1:8000/v1"
    if normalized == "grok":
        return "cli", None
    if normalized.startswith("codex:") or normalized in {
        "codex", "codex-sol", "codex-5.6", "codex-terra", "codex-luna",
        "codex-fugu", "fugu",
    }:
        return "cli", None
    return "unknown", None


def _spec_fix(spec: str) -> str:
    """A one-line, actionable suggestion for a not-ready spec.

    Kept a pure function of ``spec`` (not the probe's ``reason`` text) so it
    stays deterministic and testable regardless of which local phrasing
    ``agent.cli``'s probe happens to return this call.
    """
    normalized = spec.casefold()
    if normalized.startswith("ollama:"):
        return "install Ollama (https://ollama.com) and run `ollama pull <model>`"
    if normalized == "omlx" or normalized.startswith("omlx:"):
        return "start the oMLX app so it listens on 127.0.0.1:8000"
    if normalized == "mlx" or normalized.startswith("mlx:"):
        return "install `mlx-lm` in this Python environment for the legacy direct MLX runtime"
    if normalized in {"ds4", "pulsar"} or normalized.startswith(("ds4:", "pulsar:")):
        return (
            "run `/config install-ds4`, then start the guarded DS4 service "
            "on 127.0.0.1:8000"
        )
    if normalized.startswith("vllm:") or normalized in {"qwen3.6-35b", "qwen3.6", "qwen36-local", "vllm"}:
        return "start a local vLLM/oMLX server on 127.0.0.1:8000"
    if normalized == "grok":
        return "run `grok login` or set XAI_API_KEY"
    if normalized.startswith("codex:") or normalized in {
        "codex", "codex-sol", "codex-5.6", "codex-terra", "codex-luna",
        "codex-fugu", "fugu",
    }:
        return "run `codex login` for ChatGPT subscription access"
    return "no automatic fix known for this spec"


def preflight_spec(spec: str, *, alias: str | None = None) -> dict[str, Any]:
    """Per-spec reachability/readiness preflight for a GUI status screen.

    Returns a JSON-serialisable ``{spec, ready, reason, transport, endpoint,
    fix}`` dict and never raises or blocks more than the underlying probe's
    own sub-second/few-second timeouts (the same bounds ``_model_ready`` and
    its ``_probe_openai_models`` helper already use). ``fix`` is ``None`` when
    ready, and an actionable one-liner (not a generic "connection refused")
    when it is not.
    """
    spec = str(spec or "").strip()
    alias = str(alias or spec).strip()
    transport, endpoint = _spec_transport(spec)
    if not spec:
        return {
            "spec": spec, "ready": False, "reason": "empty model spec",
            "transport": transport, "endpoint": endpoint, "fix": "pass a non-empty --model spec",
        }
    outcome = _cli_model_ready(alias, spec)
    if outcome is None:
        return {
            "spec": spec, "ready": False, "reason": "unknown: local readiness probe unavailable",
            "transport": transport, "endpoint": endpoint, "fix": "unknown",
        }
    ready, reason = outcome
    return {
        "spec": spec,
        "ready": bool(ready),
        "reason": str(reason),
        "transport": transport,
        "endpoint": endpoint,
        "fix": None if ready else _spec_fix(spec),
    }


def local_runtime_report(*, port_probe: Callable[[int], bool] | None = None) -> dict[str, Any]:
    """Machine-wide local-runtime report for a GUI status/recommend screen.

    Fail-soft and JSON-serialisable. ``detect_status``/``detect_local_engines``
    are already defensive (every sub-probe degrades to a safe default rather
    than raising), so the ``try`` here only guards against something
    unexpected in glue code — never leaving a config screen to crash on a
    machine this was never tested on.
    """
    try:
        status = detect_status()
        engines = detect_local_engines(status, port_probe=port_probe)
        recommendation = recommended_backend(status)
        plan = best_install_plan(status)
    except Exception as exc:  # noqa: BLE001 - a status screen must not crash the caller
        return {
            "osName": "unknown", "machine": "unknown", "isAppleSilicon": False,
            "hasNvidia": False, "mlxImportable": False, "ollamaInstalled": False,
            "ollamaRunning": False, "endpoints": [], "modelCounts": {},
            "modelFiles": {"ds4": []},
            "recommendation": "unknown", "setupSuggestions": [],
            "error": f"runtime detection failed: {exc!r}",
        }
    endpoints = [
        {
            "name": engine.name, "provider": engine.provider, "baseUrl": engine.base_url,
            "installed": engine.installed, "running": engine.running,
        }
        for engine in engines if engine.base_url
    ]
    ollama_running = next((engine.running for engine in engines if engine.provider == "ollama"), False)
    if plan is None:
        setup_suggestions = ["no install needed: a usable local backend is already available"]
    else:
        setup_suggestions = list(plan.notes) + [" ".join(cmd) for cmd in plan.commands]
    return {
        "osName": status.os_name,
        "machine": status.machine,
        "isAppleSilicon": status.is_apple_silicon,
        "hasNvidia": status.has_nvidia,
        "mlxImportable": bool(status.packages.get("mlx_lm")),
        "ollamaInstalled": bool(status.commands.get("ollama")),
        "ollamaRunning": bool(ollama_running),
        "endpoints": endpoints,
        "modelCounts": {
            "ollama": len(status.ollama_models),
            "huggingFace": len(status.local_hf_models),
            "mlx": len(status.local_mlx_models),
            "ds4": len(status.local_ds4_models),
        },
        "modelFiles": {"ds4": list(status.local_ds4_models)},
        "recommendation": recommendation,
        "setupSuggestions": setup_suggestions,
    }


#: Phrasings a local inference server (llama.cpp, MLX, vLLM) uses when a
#: request does not fit in device memory. Deliberately broad: local engines
#: disagree on status code (507, or a bare 400/500) and on wording, so this
#: matches on content, with the 507 status code itself as a second signal.
_MEMORY_FIT_MARKERS: tuple[str, ...] = (
    "insufficient memory", "out of memory", "oom", "memory ceiling",
    "does not fit in memory", "not enough memory", "failed to allocate",
    "cuda out of memory", "metal out of memory",
)

#: Step-down suggestion by quantization/precision marker found in the error
#: text, ordered so the first matching key wins. A generic fallback covers any
#: OOM refusal that names no quantization at all.
_QUANT_STEP_DOWN: tuple[tuple[str, str], ...] = (
    ("bf16", "8-bit"), ("fp16", "8-bit"), ("f16", "8-bit"),
    ("8bit", "4-bit"), ("8-bit", "4-bit"), ("q8_0", "q4_k_m"),
    ("4bit", "a smaller parameter-count model"), ("4-bit", "a smaller parameter-count model"),
    ("q4_k_m", "q3_k_m or a smaller parameter-count model"),
)


def classify_memory_fit(status_code: int | None, body: str | dict | None) -> dict[str, Any]:
    """Turn a local server's out-of-memory refusal into an actionable message.

    A generic "connection/server error" framing sends an operator down a
    networking rabbit hole for what is actually a model-too-big problem. This
    recognizes the common local-engine OOM phrasings (a plain HTTP 507, or OOM
    wording in a 400/500 body) and suggests a smaller quantization instead of
    just re-surfacing the raw transport error. Returns
    ``{isMemoryFit, message, suggestion}``; the two latter fields are ``None``
    when the body doesn't look like a memory-fit refusal, so a caller can
    fall through to its own generic classification unchanged.
    """
    text = json.dumps(body) if isinstance(body, dict) else str(body or "")
    lowered = text.casefold()
    is_memory_fit = status_code == 507 or any(marker in lowered for marker in _MEMORY_FIT_MARKERS)
    if not is_memory_fit:
        return {"isMemoryFit": False, "message": None, "suggestion": None}
    smaller = next((step for marker, step in _QUANT_STEP_DOWN if marker in lowered), "a smaller quantization (e.g. 4-bit)")
    return {
        "isMemoryFit": True,
        "message": "the local model does not fit in available memory",
        "suggestion": f"try {smaller} or reduce the context window",
    }


def _cached_adapter_names(home: Path, *, limit: int = 50) -> list[str]:
    root = home / ".sophia" / "adapters"
    if not root.exists() or not root.is_dir():
        return []
    try:
        children = sorted(root.iterdir(), key=lambda p: p.name)[:limit]
    except OSError:
        return []
    return [child.name for child in children if child.is_dir() or child.suffix in {".safetensors", ".npz"}]


def adapter_status(environ: Mapping[str, str] | None = None, *, home: Path | None = None) -> dict[str, Any]:
    """Resolve what ``SOPHIA_MLX_ADAPTER`` currently points at, for GUI display.

    Never raises: a missing/garbled path is reported as ``exists: false``, not
    an exception, since this is meant to back a status line that must not
    crash a render loop over an operator's stale env var.
    """
    env = os.environ if environ is None else environ
    home = home or Path.home()
    cached = _cached_adapter_names(home)
    raw = str(env.get("SOPHIA_MLX_ADAPTER", "") or "").strip()
    if not raw:
        return {"configured": False, "path": None, "name": None, "exists": False, "cachedAdapters": cached}
    try:
        path = Path(raw).expanduser()
        exists = path.exists()
    except (OSError, ValueError):
        return {"configured": True, "path": raw, "name": None, "exists": False, "cachedAdapters": cached}
    return {
        "configured": True,
        "path": str(path),
        "name": path.name,
        "exists": exists,
        "cachedAdapters": cached,
    }


def run_plan(plan: InstallPlan, *, confirm: Callable[[str], bool]) -> list[dict]:
    results: list[dict] = []
    if not plan.commands:
        return [{"ok": False, "command": [], "note": "no automatic install command for this target"}]
    if not confirm(format_plan(plan)):
        return [{"ok": False, "command": [], "note": "operator declined"}]
    for cmd in plan.commands:
        proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
        results.append({
            "command": cmd,
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": (proc.stdout or "")[-2000:],
            "stderr": (proc.stderr or "")[-2000:],
        })
        if proc.returncode != 0:
            break
    return results
