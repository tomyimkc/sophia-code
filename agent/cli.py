# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""``sophia`` — the Sophia Agents terminal tool.

An OpenClaw/Hermes-style coding agent kernel for this repo, wrapped in Sophia's
trust layer (native function-calling tools, permission-gated execution,
secret-redacted output, the mandatory delivery gate on every final answer). Runs
one-shot or as an interactive REPL that remembers the conversation across turns.

    # one-shot
    python -m agent.cli "summarize what agent/harness.py does"
    python -m agent.cli --auto "run the conscience runtime tests and report"
    python -m agent.cli --readonly "where is the delivery gate implemented?"

    # interactive REPL (memory persists across turns; /exit to quit)
    python -m agent.cli
    python -m agent.cli --model anthropic:claude-sonnet-5
    python -m agent.cli --mock          # offline, deterministic (no API key)

Permission modes: default is APPROVE (writes/bash prompt y/N); --auto runs
unattended; --readonly forbids any write/exec. candidateOnly; canClaimAGI:false.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, TextIO

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent.agent_loop import run_agent_loop  # noqa: E402
from agent.agent_tools import ToolContext  # noqa: E402
from agent.runtime_paths import workspace_dir  # noqa: E402


MODEL_CHOICES: dict[str, dict[str, str]] = {
    "mock": {
        "spec": "mock",
        "label": "Mock offline model",
        "setup": "No setup needed.",
    },
    "qwen3.6-35b": {
        "spec": "qwen3.6-35b",
        "label": "Local Qwen3.6-35B-A3B (vLLM :8000)",
        "setup": "Serve nvidia/Qwen3.6-35B-A3B-NVFP4 via vLLM on 127.0.0.1:8000 "
                 "(served-model-name qwen3.6-35b-a3b).",
    },
    "qwen3.6": {
        "spec": "qwen3.6",
        "label": "Local Qwen3.6-35B-A3B (vLLM :8000)",
        "setup": "Serve nvidia/Qwen3.6-35B-A3B-NVFP4 via vLLM on 127.0.0.1:8000 "
                 "(served-model-name qwen3.6-35b-a3b).",
    },
    "qwen36-local": {
        "spec": "qwen36-local",
        "label": "Local Qwen3.6-35B-A3B (vLLM :8000)",
        "setup": "Serve nvidia/Qwen3.6-35B-A3B-NVFP4 via vLLM on 127.0.0.1:8000 "
                 "(served-model-name qwen3.6-35b-a3b).",
    },
    "vllm": {
        "spec": "vllm:qwen3.6-35b-a3b@http://127.0.0.1:8000/v1",
        "label": "Local vLLM OpenAI server (:8000)",
        "setup": "Start vLLM with --host 127.0.0.1 --port 8000 and a served model name.",
    },
    "ds4": {
        "spec": "ds4:deepseek-v4-flash@http://127.0.0.1:8000/v1",
        "label": "DeepSeek V4 Flash · DwarfStar (ds4-server :8000)",
        "setup": "On DGX Spark run `scripts/sophia_ds4_spark.sh scan`, then start "
                 "ds4-server on 127.0.0.1:8000. Sophia uses the OpenAI-compatible "
                 "chat/tool API; no cloud key is required.",
    },
    "pulsar": {
        "spec": "pulsar:deepseek-v4-flash@http://127.0.0.1:8000/v1",
        "label": "DeepSeek V4 Flash · legacy Pulsar compatibility alias",
        "setup": "Compatibility alias for an existing pulsar-server install. "
                 "New DGX Spark installs should use the `ds4` preset.",
    },
    "omlx": {
        "spec": "omlx",
        "label": "oMLX local MLX · Qwen3.6-35B-A3B-4bit · :8000",
        "setup": "Start the oMLX app and load Qwen3.6-35B-A3B-4bit. "
                 "Auth: OMLX_API_KEY or default key 1234.",
    },
    "mlx": {
        "spec": "mlx",
        "label": "Legacy MLX direct runtime",
        "setup": "Install mlx-lm in this Python environment. This is the legacy "
                 "in-process text runtime, distinct from the oMLX server.",
    },
    "grok": {
        "spec": "grok",
        "label": "Grok CLI · grok-4.6 (answers only)",
        "setup": "Install/login to Grok CLI first, e.g. run `grok --oauth` or configure your Grok/xAI auth. "
                 "Sophia explicitly requests grok-4.6 and denies Grok's mutating/exfiltrating tools. "
                 "Pick grok-4.5 for the xAI API route with fully receipted Sophia-native tools.",
    },
    "grok-cli": {
        "spec": "grok",
        "label": "Grok CLI · grok-4.6 (answers only)",
        "setup": "Install/login to Grok CLI first, e.g. run `grok --oauth` or configure your Grok/xAI auth. "
                 "Sophia explicitly requests grok-4.6 and denies Grok's mutating/exfiltrating tools. "
                 "Pick grok-4.5 for the xAI API route with fully receipted Sophia-native tools.",
    },
    "grok-4.5": {
        "spec": "grok-4.5",
        "label": "Grok 4.5 via xAI API (full Sophia tool gate)",
        "setup": "Set XAI_API_KEY (console.x.ai). Sophia stays the agent, so tool calls, "
                 "permissions, receipts and /agents lanes all work normally.",
    },
    "xai": {
        "spec": "xai",
        "label": "Grok 4.5 via xAI API (full Sophia tool gate)",
        "setup": "Set XAI_API_KEY (console.x.ai). Sophia stays the agent, so tool calls, "
                 "permissions, receipts and /agents lanes all work normally.",
    },
    "codex": {
        "spec": "codex:gpt-5.6-sol",
        "label": "Codex subscription · GPT-5.6 Sol",
        "setup": "Install Codex CLI and run `codex login` with ChatGPT subscription authentication.",
    },
    "codex-terra": {
        "spec": "codex:gpt-5.6-terra",
        "label": "Codex subscription · GPT-5.6 Terra",
        "setup": "Install Codex CLI and run `codex login` with ChatGPT subscription authentication.",
    },
    "codex-luna": {
        "spec": "codex:gpt-5.6-luna",
        "label": "Codex subscription · GPT-5.6 Luna",
        "setup": "Install Codex CLI and run `codex login` with ChatGPT subscription authentication.",
    },
    "codex-fugu": {
        "spec": "codex:fugu",
        "label": "Codex CLI legacy/custom · fugu",
        "setup": "Legacy/custom Codex model lane. Install Codex CLI and run `codex login`; "
                 "prefer `/model codex` for the official GPT-5.6 Sol subscription lane.",
    },
}

TEMPERATURE_PRESETS = {
    "minimum": 0.0,
    "min": 0.0,
    "mean": 0.5,
    "medium": 0.5,
    "maximum": 1.0,
    "max": 1.0,
}

MODE_PRESETS: dict[str, dict[str, Any]] = {
    "logical": {
        "temperature": 0.0, "top_p": 0.30, "top_k": 1, "logic_judge": "strict",
        "description": "deterministic, premise-focused, lowest creativity",
    },
    "precise": {
        "temperature": 0.2, "top_p": 0.60, "top_k": 8, "logic_judge": "strict",
        "description": "careful and narrow, good for verification/code review",
    },
    "balanced": {
        "temperature": 0.5, "top_p": 0.90, "top_k": 24, "logic_judge": "basic",
        "description": "default middle ground",
    },
    "creative": {
        "temperature": 1.0, "top_p": 0.95, "top_k": 40, "logic_judge": "basic",
        "description": "idea generation with some guardrails",
    },
    "divergent": {
        "temperature": 1.2, "top_p": 0.98, "top_k": 64, "logic_judge": "off",
        "description": "maximum exploration / brainstorm mode",
    },
}

from agent.sophia_harness import normalize_effort
from agent.slash_catalog import (
    help_rows as _slash_help_rows,
    resolve as _resolve_slash,
    unsupported_message as _unsupported_slash_message,
)

# Legacy mode-specific entries remain available to the terminal dispatcher.
LEGACY_SLASH_COMMANDS: tuple[tuple[str, str, str], ...] = (
    ("/model", "Model picker", "choose model with arrow keys"),
    ("/mode", "Response modes", "logical / precise / balanced / creative / divergent"),
    ("/mode all", "Compare all modes", "usage: /mode all <prompt>"),
    ("/sampling", "Sampling settings", "temperature / top-p / top-k"),
    ("/config", "Runtime config", "detect OS/GPU and install best local backend"),
    ("/permission", "Permission mode", "auto / manual approval / readonly"),
    ("/temperature", "Set temperature", "usage: /temperature min|mean|max|<number>"),
    ("/top-p", "Set top-p", "usage: /top-p <0..1>"),
    ("/top-k", "Set top-k", "usage: /top-k <positive integer>"),
    ("/logic", "Logic judge", "off / basic / strict"),
    ("/thinking", "Thinking trace", "show/log provider-exposed reasoning"),
    ("/new", "New session", "usage: /new [name]"),
    ("/resume", "Resume session", "arrow-key session picker"),
    ("/sessions", "List sessions", "show saved sessions"),
    ("/reset", "Reset memory", "clear current session memory"),
    ("/help", "Help", "show terminal help"),
    ("/exit", "Exit", "quit Sophia"),
)


def _merged_slash_commands() -> tuple[tuple[str, str, str], ...]:
    """Return catalog commands plus legacy terminal-only commands without duplicates."""
    rows = list(_slash_help_rows())
    seen = {row[0].casefold() for row in rows}
    rows.extend(row for row in LEGACY_SLASH_COMMANDS if row[0].casefold() not in seen)
    return tuple(rows)


SLASH_COMMANDS: tuple[tuple[str, str, str], ...] = _merged_slash_commands()


def _load_code_config(explicit: str | None) -> dict[str, Any]:
    """Load layered Sophia Code config.

    Precedence is: ``~/.sophia/config.toml`` < repo ``.sophia/config.toml`` <
    ``SOPHIA_CODE_CONFIG`` < explicit ``--config``. Only the ``[code]`` table is
    honored so unrelated config in the same file cannot accidentally change CLI
    behavior.
    """
    try:
        import tomllib
    except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
        import tomli as tomllib  # type: ignore[no-redef]

    candidates: list[Path] = [
        Path.home() / ".sophia" / "config.toml",
        workspace_dir() / ".sophia" / "config.toml",
    ]
    if os.environ.get("SOPHIA_CODE_CONFIG"):
        candidates.append(Path(os.environ["SOPHIA_CODE_CONFIG"]).expanduser())
    if explicit:
        candidates.append(Path(explicit).expanduser())

    merged: dict[str, Any] = {}
    for path in candidates:
        if not path.exists():
            continue
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError):
            continue
        table = data.get("code", {})
        if isinstance(table, dict):
            merged.update(table)
    return merged


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _apply_config_defaults(args: argparse.Namespace) -> None:
    cfg = _load_code_config(args.config)
    if args.model is None and cfg.get("model"):
        args.model = str(cfg["model"])
    if args.adapter is None and cfg.get("adapter"):
        args.adapter = str(cfg["adapter"])
    if args.server is None and cfg.get("server"):
        args.server = str(cfg["server"])
    if args.cwd is None and cfg.get("cwd"):
        args.cwd = str(cfg["cwd"])
    if args.session is None and cfg.get("session"):
        args.session = str(cfg["session"])
    if args.trace is None and cfg.get("trace"):
        args.trace = str(cfg["trace"])
    if args.max_steps is None and cfg.get("max_steps") is not None:
        try:
            value = int(cfg["max_steps"])
            if value > 0:
                args.max_steps = value
        except (TypeError, ValueError, OverflowError):
            # Malformed config value; keep whatever max_steps was already set to.
            pass
    if not args.mock and _boolish(cfg.get("mock")):
        args.mock = True
    if not args.sandbox and _boolish(cfg.get("sandbox")):
        args.sandbox = True
    if not args.show_thinking and _boolish(cfg.get("show_thinking")):
        args.show_thinking = True
    if not args.capture_thinking and _boolish(cfg.get("capture_thinking")):
        args.capture_thinking = True
    if args.thinking_log is None and cfg.get("thinking_log"):
        args.thinking_log = str(cfg["thinking_log"])
    if args.logic_judge == "off" and cfg.get("logic_judge"):
        judge = str(cfg["logic_judge"]).strip().lower()
        if judge in {"off", "basic", "strict"}:
            args.logic_judge = judge
    if args.temperature is None and cfg.get("temperature") is not None:
        try:
            args.temperature = float(cfg["temperature"])
        except (TypeError, ValueError, OverflowError):
            # Malformed config value; keep whatever temperature was already set to.
            pass
    if args.temperature_preset is None and cfg.get("temperature_preset"):
        preset = str(cfg["temperature_preset"]).strip().lower()
        if preset in TEMPERATURE_PRESETS:
            args.temperature_preset = preset
    if args.top_p is None and cfg.get("top_p") is not None:
        try:
            args.top_p = float(cfg["top_p"])
        except (TypeError, ValueError, OverflowError):
            # Malformed config value; keep whatever top_p was already set to.
            pass
    if args.top_k is None and cfg.get("top_k") is not None:
        try:
            value = int(cfg["top_k"])
            if value > 0:
                args.top_k = value
        except (TypeError, ValueError, OverflowError):
            # Malformed config value; keep whatever top_k was already set to.
            pass
    if args.response_mode is None and cfg.get("mode"):
        mode = str(cfg["mode"]).strip().lower()
        if mode in {*MODE_PRESETS, "all"}:
            args.response_mode = mode
    if getattr(args, "effort", None) is None and cfg.get("effort"):
        args.effort = normalize_effort(str(cfg["effort"]))
    # Config values are defaults, never overrides. Preserve an explicit
    # permission flag from the command line, including --approve/--manual.
    if not (args.auto or args.approve or args.readonly):
        permission = str(cfg.get("permission", "")).strip().lower()
        if permission == "auto":
            args.auto = True
        elif permission == "readonly":
            args.readonly = True
        elif permission in {"approve", "manual"}:
            args.approve = True
    if args.max_steps is None:
        args.max_steps = 12


def _conversation_path(name: str) -> Path:
    """Where a named conversation's transcript is persisted (cross-restart memory).

    This is the terminal tool's chat memory, kept separate from the harness episodic
    Session (agent/session.py), which stores step episodes for run_agent.  The
    directory override is intentionally narrow and exists for isolated test
    harnesses; normal launches retain the repository memory location.
    """
    d = _conversations_dir()
    d.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name) or "default"
    return d / f"{safe}.json"


def _conversations_dir() -> Path:
    """The single source of truth for where transcripts live.

    Every reader and writer must resolve the directory through here. When only
    the writer honoured ``SOPHIA_CONVERSATIONS_DIR``, the session picker listed
    one directory while /resume loaded from another, so selecting a session
    silently resumed an empty transcript.
    """
    from agent import harness as _h

    override = os.environ.get("SOPHIA_CONVERSATIONS_DIR")
    if override:
        return Path(override).expanduser()
    return Path(_h.RUNS_DIR) / "agent_loop" / "conversations"


def _quarantine_corrupt_conversation(path: Path) -> "Path | None":
    """Move an unparsable transcript aside so the next save cannot destroy it."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = path.with_name(f"{path.name}.corrupt-{stamp}")
    try:
        os.replace(path, target)
    except OSError:
        return None
    return target


def _load_conversation(path: Path, *, out: "TextIO | None" = None) -> "list[dict] | None":
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    except UnicodeError:
        raw = None
    data: Any = None
    if raw is not None:
        if not raw.strip():
            return None
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = None
    if not isinstance(data, list):
        # The file exists but cannot be parsed. Returning a bare None here was
        # indistinguishable from "no such session", and the next turn wrote the
        # new history straight over it — losing the transcript with no warning.
        # Preserve the bytes and say so.
        kept = _quarantine_corrupt_conversation(path)
        if out is not None:
            if kept is not None:
                out.write(f"Session transcript {path.name} was unreadable; kept a copy at {kept.name}.\n")
            else:
                out.write(f"Session transcript {path.name} was unreadable and could not be preserved.\n")
        return None
    # Ignore malformed entries rather than allowing a damaged transcript to
    # crash the next startup or projection pass.
    return [item for item in data if isinstance(item, dict)]


def _atomic_write_text(path: Path, text: str) -> None:
    """Replace a file atomically, with durable flush when supported."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        try:
            dir_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            # Directory fsync is a durability best-effort; the file itself is
            # already safely in place via os.replace above.
            pass
    finally:
        try:
            tmp.unlink()
        except OSError:
            # Normal case: os.replace already moved tmp to path, so there is
            # nothing left here to unlink.
            pass


def _save_conversation(path: Path, messages: "list[dict]") -> None:
    try:
        # Persist only the dialogue turns (drop the system prompt; it is rebuilt each run).
        turns = [m for m in messages if isinstance(m, dict) and m.get("role") != "system"]
        _atomic_write_text(path, json.dumps(turns, ensure_ascii=False, indent=2))
        try:
            _save_conversation_markdown(path.with_suffix(".md"), turns)
        except (OSError, TypeError, ValueError, UnicodeError):
            # Projections are best-effort and must never invalidate the JSON save.
            pass
    except (OSError, TypeError, ValueError, UnicodeError):
        # Conversation persistence is optional; a disk fault must not break a run.
        pass


def _save_conversation_markdown(path: Path, turns: list[dict]) -> None:
    """Write a human-reviewable Markdown transcript beside the JSON transcript."""
    title = path.stem
    lines = [
        f"# Sophia session: {title}",
        "",
        f"- Updated: {datetime.now().isoformat(timespec='seconds')}",
        f"- JSON transcript: `{path.with_suffix('.json').name}`",
        "",
    ]
    for idx, msg in enumerate(turns, 1):
        role = str(msg.get("role") or "unknown").title()
        content = str(msg.get("content") or "").rstrip()
        lines.extend([f"## {idx}. {role}", "", content or "_(empty)_", ""])
        if role == "Assistant" and content:
            audit = _logic_audit(content, "basic")
            lines.extend([
                "### Visible logic audit (basic)",
                "",
                _format_logic_audit(audit).strip() or "_(not scored)_",
                "",
            ])
    _atomic_write_text(path, "\n".join(lines))
    _save_conversation_okf_rag(path.with_suffix(".json"), turns)


def _save_conversation_okf_rag(json_path: Path, turns: list[dict]) -> None:
    """Project the conversation into OKF markdown nodes + RAG JSONL chunks."""
    try:
        from agent.okf_schema import OKFNode, content_id, to_markdown, validate
    except Exception:  # noqa: BLE001 - OKF projection is best-effort memory, not runtime-critical
        return
    session = json_path.stem
    base = json_path.parent
    okf_dir = base / "okf" / session
    rag_dir = base / "rag"
    okf_dir.mkdir(parents=True, exist_ok=True)
    rag_dir.mkdir(parents=True, exist_ok=True)
    rag_rows: list[dict] = []
    previous_id = ""
    for idx, msg in enumerate(turns, 1):
        role = str(msg.get("role") or "unknown").lower()
        content = str(msg.get("content") or "").strip()
        if not content:
            continue
        node_type = "observe" if role == "user" else "reason" if role == "assistant" else "event"
        title = f"{session} turn {idx:04d} {role}"
        body = content
        node_id = content_id(node_type, title, body)
        links = [f"prev:{previous_id}"] if previous_id else []
        node = OKFNode(
            id=node_id,
            node_type=node_type,
            title=title,
            body=body,
            sources=[json_path.name],
            links=links,
            verifier="sophia_terminal_session_projection",
            verdict="none",
            moral_standard="canClaimAGI:false",
        )
        if not validate(node):
            (okf_dir / f"{node_id.replace(':', '_')}.md").write_text(to_markdown(node), encoding="utf-8")
        rag_rows.append({
            "id": node_id,
            "session": session,
            "turn": idx,
            "role": role,
            "nodeType": node_type,
            "text": body,
            "sources": [json_path.name],
            "links": links,
            "okfPath": f"okf/{session}/{node_id.replace(':', '_')}.md",
            "canClaimAGI": False,
        })
        previous_id = node_id
    _atomic_write_text(
        rag_dir / f"{session}.jsonl",
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rag_rows),
    )


def _list_conversations() -> list[Path]:
    d = _conversations_dir()
    if not d.exists():
        return []
    return sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)


def _new_session_name() -> str:
    return "session-" + datetime.now().strftime("%Y%m%d-%H%M%S")


def _render_sessions(out: TextIO) -> None:
    sessions = _list_conversations()
    if not sessions:
        out.write("No saved Sophia sessions yet. Start one with /new <name>.\n")
        return
    out.write("Saved sessions:\n")
    for path in sessions[:30]:
        try:
            turns = json.loads(path.read_text(encoding="utf-8"))
            count = len(turns) if isinstance(turns, list) else 0
        except (OSError, json.JSONDecodeError):
            count = 0
        out.write(f"  /resume {path.stem:<24} {count} turns\n")
    if len(sessions) > 30:
        out.write(f"  … {len(sessions) - 30} more\n")


def _session_menu_options() -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    for path in _list_conversations()[:30]:
        try:
            turns = json.loads(path.read_text(encoding="utf-8"))
            count = len(turns) if isinstance(turns, list) else 0
        except (OSError, json.JSONDecodeError):
            count = 0
        rows.append((path.stem, "Sophia session", f"{count} turns"))
    return rows


def _make_approver(out: TextIO, inp: TextIO) -> "Callable[[str, str], bool]":
    def approve(name: str, preview: str) -> bool:
        if not (hasattr(inp, "isatty") and inp.isatty()):
            out.write(f"  ⚠ {name} needs approval but no interactive TTY — denied. "
                      f"Use --auto to allow.\n")
            return False
        out.write(f"  ⚙ approve {name}?  {preview}\n  [y/N] ")
        out.flush()
        return inp.readline().strip().lower() in {"y", "yes"}
    return approve


def _permission_menu_options() -> list[tuple[str, str, str]]:
    return [
        ("auto", "Auto permit tools", "LLM tool/function calls run without approval"),
        ("manual", "Manual approval", "default: write/bash/function calls ask before execution"),
        ("readonly", "Read-only", "block write and exec tools"),
    ]


def _set_permission(ctx: ToolContext, mode: str, *, out: TextIO, inp: TextIO) -> None:
    normalized = "approve" if mode in {"manual", "approve"} else mode
    if normalized not in {"auto", "approve", "readonly"}:
        out.write("Usage: /permission auto|manual|readonly\n")
        return
    ctx.permission = normalized
    ctx.approver = _make_approver(out, inp) if normalized == "approve" else None
    label = "manual approval" if normalized == "approve" else normalized
    out.write(f"Permission mode set to {label}.\n")


def _permission(args: argparse.Namespace) -> str:
    if args.readonly:
        return "readonly"
    if getattr(args, "auto", False):
        return "auto"
    return "approve"


_THINKING_DISPLAY_LINES = 40


def _printer(out: TextIO) -> "Callable[[dict], None]":
    def ev(e: dict) -> None:
        t = e.get("type")
        if t == "goal":
            out.write(f"● {e['goal']}   ({e['permission']} · {e['root']})\n")
        elif t == "tool_call":
            out.write(f"  ⚙ {e['tool']}  {json.dumps(e.get('args') or {})[:140]}\n")
        elif t == "tool_result":
            status = "ok" if e.get("ok") else "FAIL"
            body = (e.get("output") or "").rstrip().splitlines()
            head = body[0][:200] if body else ""
            more = f"  (+{len(body) - 1} lines)" if len(body) > 1 else ""
            out.write(f"    → [{status}] {head}{more}\n")
        elif t == "thinking":
            out.write(f"  🧠 thinking ({e.get('provider')}:{e.get('model')}, "
                      f"{e.get('reasoningTokens', 0)} tokens)\n")
            # Bounded like the tool-result branch above: a local thinking-mode
            # model can emit thousands of reasoning lines and scroll the answer
            # off screen. The full text stays available via --thinking-log.
            lines = str(e.get("text") or "").splitlines()
            for line in lines[:_THINKING_DISPLAY_LINES]:
                out.write(f"     {line[:200]}\n")
            if len(lines) > _THINKING_DISPLAY_LINES:
                out.write(f"     (+{len(lines) - _THINKING_DISPLAY_LINES} more lines, see --thinking-log)\n")
        out.flush()
    return ev


def _build_client(args: argparse.Namespace):
    from agent import model as m
    if args.adapter:
        # The MLX transport reads this at config resolution time. Keeping it as
        # an env override preserves existing agent.model contracts.
        os.environ["SOPHIA_MLX_ADAPTER"] = str(args.adapter)
    if args.server:
        server = str(args.server)
        # agent.model already supports per-spec base URL overrides:
        # provider:model@http://host/v1. Attach the server when the user gave a
        # provider spec; otherwise set the generic OpenAI-compatible base URL.
        if args.model and "@" not in args.model and ":" in args.model:
            args.model = f"{args.model}@{server}"
        else:
            os.environ["SOPHIA_MODEL_BASE_URL"] = server
    if args.mock:
        return m.ModelClient(m.resolve_config("mock"))
    return m.default_client(args.model)


def _apply_sampling_env(args: argparse.Namespace) -> None:
    if getattr(args, "effort", None):
        os.environ["SOPHIA_REASONING_EFFORT"] = normalize_effort(args.effort)
    if args.response_mode and args.response_mode != "all":
        settings = MODE_PRESETS.get(args.response_mode)
        if settings is None:
            raise ValueError(f"unknown mode {args.response_mode!r}")
        os.environ["SOPHIA_TEMPERATURE"] = str(settings["temperature"])
        os.environ["SOPHIA_TOP_P"] = str(settings["top_p"])
        os.environ["SOPHIA_TOP_K"] = str(settings["top_k"])
        if args.logic_judge == "off":
            args.logic_judge = str(settings["logic_judge"])
    if args.temperature_preset:
        preset = args.temperature_preset.lower()
        if preset not in TEMPERATURE_PRESETS:
            raise ValueError(f"unknown temperature preset {args.temperature_preset!r}")
        os.environ["SOPHIA_TEMPERATURE"] = str(TEMPERATURE_PRESETS[preset])
    if args.temperature is not None:
        os.environ["SOPHIA_TEMPERATURE"] = str(_clamp(float(args.temperature), 0.0, 2.0))
    if args.top_p is not None:
        os.environ["SOPHIA_TOP_P"] = str(_clamp(float(args.top_p), 0.0, 1.0))
    if args.top_k is not None:
        os.environ["SOPHIA_TOP_K"] = str(max(1, int(args.top_k)))


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _sampling_values(client: Any | None = None) -> dict[str, Any]:
    cfg = getattr(client, "primary", None)
    return {
        "temperature": getattr(cfg, "temperature", None) if cfg is not None else os.environ.get("SOPHIA_TEMPERATURE"),
        "top_p": getattr(cfg, "top_p", None) if cfg is not None else os.environ.get("SOPHIA_TOP_P"),
        "top_k": getattr(cfg, "top_k", None) if cfg is not None else os.environ.get("SOPHIA_TOP_K"),
    }


def _set_client_sampling(client: Any, *, temperature: float | None = None,
                         top_p: float | None = None, top_k: int | None = None) -> None:
    cfgs = [getattr(client, "primary", None), *list(getattr(client, "fallbacks", []) or [])]
    for cfg in cfgs:
        if cfg is None:
            continue
        if temperature is not None:
            cfg.temperature = _clamp(float(temperature), 0.0, 2.0)
        if top_p is not None:
            cfg.top_p = _clamp(float(top_p), 0.0, 1.0)
        if top_k is not None:
            cfg.top_k = max(1, int(top_k))


def _render_sampling(out: TextIO, client: Any) -> None:
    vals = _sampling_values(client)
    out.write("Sampling settings:\n")
    out.write(f"  temperature: {vals['temperature']}  (presets: minimum=0.0, mean=0.5, maximum=1.0)\n")
    out.write(f"  top_p      : {vals['top_p'] if vals['top_p'] is not None else '(unset)'}\n")
    out.write(f"  top_k      : {vals['top_k'] if vals['top_k'] is not None else '(unset)'}\n")
    out.write("Commands: /temperature min|mean|max|<number>, /top-p <0..1>, /top-k <int>, /sampling\n")


def _apply_mode(client: Any, mode: str, *, out: TextIO | None = None) -> str:
    settings = MODE_PRESETS[mode]
    _set_client_sampling(
        client,
        temperature=float(settings["temperature"]),
        top_p=float(settings["top_p"]),
        top_k=int(settings["top_k"]),
    )
    os.environ["SOPHIA_TEMPERATURE"] = str(settings["temperature"])
    os.environ["SOPHIA_TOP_P"] = str(settings["top_p"])
    os.environ["SOPHIA_TOP_K"] = str(settings["top_k"])
    logic = str(settings["logic_judge"])
    if out:
        out.write(
            f"Mode set to {mode}: temperature={settings['temperature']} "
            f"top_p={settings['top_p']} top_k={settings['top_k']} "
            f"logic_judge={logic} — {settings['description']}\n"
        )
    return logic


def _render_modes(out: TextIO) -> None:
    out.write("Response modes:\n")
    for name, settings in MODE_PRESETS.items():
        out.write(
            f"  /mode {name:<9} temp={settings['temperature']:<3} "
            f"top_p={settings['top_p']:<4} top_k={settings['top_k']:<3} "
            f"logic={settings['logic_judge']:<6} {settings['description']}\n"
        )
    out.write("  /mode all <prompt>     run the prompt under every mode and print a comparison table\n")


def _mode_menu_options() -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    for name, settings in MODE_PRESETS.items():
        rows.append((
            name,
            str(settings["description"]),
            f"temp={settings['temperature']} top_p={settings['top_p']} top_k={settings['top_k']} logic={settings['logic_judge']}",
        ))
    rows.append(("all", "Run next prompt under every mode", "prints comparison table with settings"))
    return rows


def _logic_menu_options() -> list[tuple[str, str, str]]:
    return [
        ("off", "Disable visible-reasoning judge", "no logic score"),
        ("basic", "Basic visible-reasoning judge", "threshold=0.50"),
        ("strict", "Strict visible-reasoning judge", "threshold=0.75"),
    ]


def _thinking_menu_options() -> list[tuple[str, str, str]]:
    return [
        ("status", "Show thinking trace status", "display/log/capture"),
        ("on", "Enable thinking display + log", "provider-exposed reasoning only"),
        ("off", "Disable thinking display + log", "turn off env switches"),
        ("show on", "Show reasoning in terminal", "display only"),
        ("log", "Enable default thinking log", "agent/memory/thinking"),
        ("capture on", "Request/store exposed reasoning", "provider-dependent"),
    ]


def _extract_confidence(text: str) -> str:
    import re

    m = re.search(r"confidence\s*[:=]\s*(\d{1,3})\s*/\s*100", text or "", flags=re.I)
    if not m:
        return ""
    value = max(1, min(100, int(m.group(1))))
    return f"{value}/100"


def _table_cell(text: Any, *, limit: int = 260) -> str:
    raw = str(text if text is not None else "")
    raw = raw.replace("|", "\\|").replace("\n", "<br>")
    return raw[:limit] + ("…" if len(raw) > limit else "")


def _comparison_box(rows: list[dict], *, width: int | None = None) -> str:
    """Render comparison rows as tmux-like terminal panes."""
    import textwrap

    term_width = width or shutil.get_terminal_size((120, 40)).columns
    columns = 2 if term_width >= 104 else 1
    gap = " "
    pane_w = max(50, (term_width - (columns - 1) * len(gap)) // columns)
    pane_h = 14
    green = "\x1b[38;5;46m"
    cyan = "\x1b[36m"
    yellow = "\x1b[33m"
    bold = "\x1b[1m"
    dim = "\x1b[2m"
    reset = "\x1b[0m"

    def visible_slice(text: str, n: int) -> str:
        return text[:n]

    def pane(row: dict) -> list[str]:
        logic = row["logic"] or {}
        logic_text = _logic_display(logic)
        speed = f"{row.get('elapsedSec', 0):.2f}s · ~{row.get('tokensPerSec', 0):.1f} tok/s"
        title = f" {row['mode'].upper()} "
        top = "╭" + "─" * (pane_w - 2) + "╮"
        mid = "├" + "─" * (pane_w - 2) + "┤"
        bottom = "╰" + "─" * (pane_w - 2) + "╯"
        lines = [
            f"{green}{top}{reset}",
            f"{green}│{reset}{bold}{cyan}{title:<{pane_w - 2}}{reset}{green}│{reset}",
            f"{green}│{reset}{dim} temp={row['temperature']} top_p={row['top_p']} top_k={row['top_k']} conf={row['confidence'] or 'n/a'}{reset}".ljust(pane_w + 20) + f"{green}│{reset}",
            f"{green}│{reset}{dim} logic={logic_text} speed={speed}{reset}".ljust(pane_w + 20) + f"{green}│{reset}",
            f"{green}{mid}{reset}",
        ]
        response = str(row.get("response") or "").replace("\r", "").replace("<br>", "\n")
        wrapped: list[str] = []
        for para in response.splitlines() or [response]:
            wrapped.extend(textwrap.wrap(para, width=pane_w - 5, replace_whitespace=False) or [""])
        for line in wrapped[: pane_h - 6]:
            lines.append(f"{green}│{reset} {visible_slice(line, pane_w - 4):<{pane_w - 3}}{green}│{reset}")
        if len(wrapped) > pane_h - 6:
            more = "… full response saved in session Markdown/RAG history"
            lines.append(f"{green}│{reset}{yellow} {more:<{pane_w - 3}}{reset}{green}│{reset}")
        while len(lines) < pane_h - 1:
            lines.append(f"{green}│{reset}{'':<{pane_w - 2}}{green}│{reset}")
        lines.append(f"{green}{bottom}{reset}")
        return lines

    panes = [pane(row) for row in rows]
    output = [f"{green}╭{'─' * (min(term_width, 120) - 2)}╮{reset}",
              f"{green}│{reset}{bold} SOPHIA // ALL-MODE TMUX VIEW{reset}" + " " * max(0, min(term_width, 120) - 31) + f"{green}│{reset}",
              f"{green}╰{'─' * (min(term_width, 120) - 2)}╯{reset}"]
    for i in range(0, len(panes), columns):
        group = panes[i: i + columns]
        height = max(len(pn) for pn in group)
        for y in range(height):
            output.append(gap.join((pn[y] if y < len(pn) else " " * pane_w) for pn in group))
    return "\n".join(output)


def _logic_display(logic: dict | None) -> str:
    if not logic:
        return "off"
    verdict = str(logic.get("verdict") or "")
    score = float(logic.get("score") or 0.0)
    threshold = float(logic.get("threshold") or 0.0)
    if verdict == "pass_abstain":
        return f"PASS-ABSTAIN {score * 100:.0f}% (>= {threshold * 100:.0f}%)"
    return f"{verdict.upper()} {score * 100:.0f}% (>= {threshold * 100:.0f}%)"


def _mode_system_extra(mode: str | None) -> str:
    if not mode or mode not in MODE_PRESETS:
        return ""
    settings = MODE_PRESETS[mode]
    policies = {
        "logical": (
            "Answer in LOGICAL mode. Use terse formal structure: definitions, premises,"
            " inference, conclusion, verification. Avoid speculation and creative branches."
        ),
        "precise": (
            "Answer in PRECISE mode. Optimize for exactness, caveats, source/tool evidence,"
            " and minimal necessary claims. Prefer verification over breadth."
        ),
        "balanced": (
            "Answer in BALANCED mode. Combine practical recommendation with enough reasoning,"
            " caveats, and alternatives to be useful."
        ),
        "creative": (
            "Answer in CREATIVE mode. Generate multiple novel options, analogies, and designs,"
            " but keep Sophia's claim boundaries and safety gates explicit."
        ),
        "divergent": (
            "Answer in DIVERGENT mode. Explore unusual hypotheses and edge-case ideas."
            " Label speculation clearly and include at least three distinct directions when possible."
        ),
    }
    return (
        f"\nSophia response mode: {mode.upper()}. This mode must visibly change the answer style even if the backend CLI ignores sampling parameters.\n"
        f"Sampling intent: temperature={settings['temperature']}, top_p={settings['top_p']}, top_k={settings['top_k']}.\n"
        f"Mode policy: {policies[mode]}\n"
        "For all-mode comparison, do not use tools, do not write files, do not browse the web, "
        "and do not inspect the repository unless the user explicitly asks for repository work. "
        "Answer directly in prose.\n"
        "End with Confidence: N/100."
    )

def _configure_thinking(args: argparse.Namespace) -> None:
    if args.thinking_log:
        os.environ["SOPHIA_THINKING_LOG"] = "1" if args.thinking_log is True else str(args.thinking_log)
    if args.capture_thinking:
        os.environ["SOPHIA_CAPTURE_THINKING"] = "1"
    if args.show_thinking:
        os.environ["SOPHIA_SHOW_THINKING"] = "1"
        # Displaying reasoning requires retaining it. Without this, providers
        # were never asked to think and --show-thinking printed nothing at all
        # unless --capture-thinking happened to be passed too; the REPL's
        # `/thinking on` already couples the two.
        os.environ.setdefault("SOPHIA_CAPTURE_THINKING", "1")


def _refresh_trace_sink(client: Any) -> None:
    if not hasattr(client, "trace_sink"):
        return
    try:
        from agent.thinking_trace import sink_from_env

        client.trace_sink = sink_from_env()
    except Exception:  # noqa: BLE001 - thinking logs must not break the terminal
        pass


def _vllm_base_urls() -> list[str]:
    """Candidate OpenAI-compatible bases for local vLLM (this workstation)."""
    bases: list[str] = []
    env_base = (os.environ.get("SOPHIA_MODEL_BASE_URL") or "").strip().rstrip("/")
    if env_base:
        bases.append(env_base)
    for candidate in (
        "http://127.0.0.1:8000/v1",
        "http://localhost:8000/v1",
    ):
        if candidate not in bases:
            bases.append(candidate)
    return bases


def _ds4_base_urls() -> list[str]:
    """Candidate OpenAI-compatible bases for a local ds4-server."""
    bases: list[str] = []
    env_base = (os.environ.get("SOPHIA_DS4_BASE_URL") or "").strip().rstrip("/")
    if env_base:
        bases.append(env_base)
    for candidate in (
        "http://127.0.0.1:8000/v1",
        "http://localhost:8000/v1",
    ):
        if candidate not in bases:
            bases.append(candidate)
    return bases


def _probe_openai_models(base_url: str, *, timeout: float = 1.5) -> list[str]:
    """Return model ids from an OpenAI-compatible /models endpoint, or [].

    Tries multiple dummy/configured local auth tokens. First success wins.
    """
    import urllib.error
    import urllib.request

    url = base_url.rstrip("/") + "/models"
    candidates = ["EMPTY"]
    for env in ("SOPHIA_DS4_API_KEY", "DS4_API_KEY", "OMLX_API_KEY", "VLLM_API_KEY"):
        val = (os.environ.get(env) or "").strip()
        if val and val not in candidates:
            candidates.append(val)
    for default_token in ("dsv4-local", "1234"):
        if default_token not in candidates:
            candidates.append(default_token)
    for token in candidates:
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = json.loads(resp.read().decode("utf-8", errors="replace"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError):
            continue
        data = raw.get("data") if isinstance(raw, dict) else raw
        if not isinstance(data, list):
            continue
        ids: list[str] = []
        for item in data:
            if isinstance(item, dict) and item.get("id"):
                ids.append(str(item["id"]))
        if ids:
            return ids
    return []


def _discover_vllm_specs() -> list[str]:
    """Live models on local vLLM, as ``vllm:<id>@http://host/v1`` specs."""
    seen: set[str] = set()
    specs: list[str] = []
    ds4_identity = bool(
        shutil.which("ds4-server")
        or shutil.which("pulsar-server")
        or (os.environ.get("SOPHIA_DS4_BASE_URL") or "").strip()
    )
    for base in _vllm_base_urls():
        model_ids = _probe_openai_models(base)
        # A default-port DS4 endpoint is OpenAI-compatible, but it is not vLLM.
        # Keep it out of the vLLM picker when local binary/config evidence says
        # this listener is DwarfStar; _discover_ds4_specs() will expose it under
        # the correct provider.
        if ds4_identity and any("deepseek-v4" in model_id.casefold() for model_id in model_ids):
            continue
        for model_id in model_ids:
            spec = f"vllm:{model_id}@{base}"
            if spec not in seen:
                seen.add(spec)
                specs.append(spec)
        if specs:
            break  # first reachable base wins
    return specs


def _discover_ds4_specs() -> list[str]:
    """Live DwarfStar models as ``ds4:<id>@http://host/v1`` specs.

    Port 8000 is shared by several local runtimes, so we only classify a
    listener as DS4 when a DS4 binary is installed or the operator explicitly
    supplied ``SOPHIA_DS4_BASE_URL``.
    """
    if not (
        shutil.which("ds4-server")
        or shutil.which("pulsar-server")
        or (os.environ.get("SOPHIA_DS4_BASE_URL") or "").strip()
    ):
        return []
    seen: set[str] = set()
    specs: list[str] = []
    for base in _ds4_base_urls():
        for model_id in _probe_openai_models(base):
            spec = f"ds4:{model_id}@{base}"
            if spec not in seen:
                seen.add(spec)
                specs.append(spec)
        if specs:
            break
    return specs


def _model_ready(alias: str, spec: str) -> tuple[bool, str]:
    if spec == "mock":
        return True, "ready"
    if spec.startswith("ollama:"):
        if not shutil.which("ollama"):
            return False, "missing `ollama` command"
        return True, "ready"
    if alias == "omlx" or spec == "omlx":
        for base in _vllm_base_urls():
            ids = _probe_openai_models(base)
            if not ids:
                continue
            if "Qwen3.6-35B-A3B-4bit" in ids or any("qwen3.6" in m.lower() for m in ids):
                return True, f"ready ({base})"
            return True, f"ready ({base}; {len(ids)} model(s) — Qwen3.6-35B-A3B-4bit not listed)"
        return False, "oMLX not reachable on 127.0.0.1:8000 (start the oMLX app)"
    if alias == "mlx" or spec == "mlx" or spec.startswith("mlx:"):
        if importlib.util.find_spec("mlx_lm") is None:
            return False, "missing `mlx_lm` package (legacy MLX direct runtime)"
        return True, "ready (legacy MLX direct runtime)"
    if (
        alias in {"ds4", "pulsar"}
        or spec in {"ds4", "pulsar"}
        or spec.startswith(("ds4:", "pulsar:"))
    ):
        bases = [spec.split("@", 1)[1]] if "@" in spec else _ds4_base_urls()
        requested = (
            spec.split(":", 1)[1].split("@", 1)[0]
            if ":" in spec else "deepseek-v4-flash"
        )
        for base in bases:
            ids = _probe_openai_models(base)
            if not ids:
                continue
            if requested in {"", "local"} or requested in ids:
                return True, f"ready ({base})"
            return False, f"ds4-server up at {base} but model {requested!r} not among {ids[:5]}"
        binary = shutil.which("ds4-server") or shutil.which("pulsar-server")
        if not binary:
            return False, "ds4-server not installed and no DS4 endpoint is reachable"
        return False, "ds4-server installed but not reachable on 127.0.0.1:8000"
    if (
        alias in {"qwen3.6-35b", "qwen3.6", "qwen36-local", "vllm"}
        or spec.startswith("vllm:")
        or spec in {"qwen3.6-35b", "qwen3.6", "qwen36-local", "vllm"}
    ):
        for base in _vllm_base_urls():
            ids = _probe_openai_models(base)
            if not ids:
                continue
            # Alias presets pin qwen3.6-35b-a3b; accept any of the served aliases.
            wanted = {
                "qwen3.6-35b-a3b",
                "qwen3.5-35b-a3b",
                "nvidia/Qwen3.6-35B-A3B-NVFP4",
            }
            if alias in {"qwen3.6-35b", "qwen3.6", "qwen36-local"}:
                if any(m in ids for m in wanted) or any("qwen3.6" in m.lower() or "qwen3.5-35" in m.lower() for m in ids):
                    return True, f"ready ({base})"
                return False, f"vLLM up at {base} but Qwen3.6-35B not among {ids[:5]}"
            if ":" in spec and "@" in spec:
                # vllm:model@base — require that model id (case-sensitive OpenAI id).
                model_part = spec.split(":", 1)[1].split("@", 1)[0]
                if model_part in ids or model_part in {"local", ""}:
                    return True, f"ready ({base})"
                return False, f"model {model_part!r} not served at {base}"
            return True, f"ready ({base}; {len(ids)} model(s))"
        return False, "vLLM not reachable on 127.0.0.1:8000 (start the local server)"
    if spec == "grok":
        if not shutil.which("grok"):
            return False, "missing `grok` command"
        if not ((Path.home() / ".grok" / "auth.json").exists() or os.environ.get("XAI_API_KEY")):
            return False, "grok auth not detected"
        return True, "ready"
    codex_aliases = {
        "codex", "codex-sol", "codex-5.6", "codex-terra", "codex-luna",
        "codex-fugu", "fugu",
    }
    if alias in codex_aliases or spec in codex_aliases or spec.startswith("codex:"):
        binary = os.environ.get("SOPHIA_CODEX_BIN", "codex")
        if not shutil.which(binary):
            return False, "missing `codex` command"
        from agent.provider_health import HealthState, probe_codex_login_status

        auth, _error = probe_codex_login_status(
            timeout=3.0,
            run=subprocess.run,
            binary=binary,
        )
        mode = str(auth.metadata.get("authMode") or "unknown")
        if auth.state is HealthState.READY and mode == "chatgpt":
            return True, "ready (ChatGPT subscription)"
        if auth.state in {HealthState.READY, HealthState.DEGRADED} and mode == "api-key":
            return True, "ready (API-key/token authentication)"
        return False, auth.detail
    return True, "custom spec"


def _parse_ollama_list(text: str) -> list[str]:
    specs: list[str] = []
    for line in (text or "").splitlines()[1:]:
        parts = line.split()
        if not parts:
            continue
        name = parts[0]
        if ":" in name and name not in {"NAME", "ID"}:
            specs.append(f"ollama:{name}")
    return specs


def _discover_ollama_specs() -> list[str]:
    if not shutil.which("ollama"):
        return []
    try:
        proc = subprocess.run(["ollama", "list"], text=True, capture_output=True, timeout=5, check=False)
    except Exception:  # noqa: BLE001 - local model discovery is optional
        return []
    if proc.returncode != 0:
        return []
    return _parse_ollama_list(proc.stdout)


def _make_client_for_model(alias_or_spec: str):
    from agent import model as m

    choice = MODEL_CHOICES.get(alias_or_spec)
    spec = choice["spec"] if choice else alias_or_spec
    if spec == "mock":
        return m.ModelClient(m.resolve_config("mock")), spec
    return m.default_client(spec), spec


def _render_model_choices(out: TextIO) -> None:
    out.write("Available models:\n")
    seen: set[str] = set()
    for alias, choice in MODEL_CHOICES.items():
        spec = choice["spec"]
        if (alias, spec) in seen:
            continue
        seen.add((alias, spec))
        ready, status = _model_ready(alias, spec)
        mark = "ready" if ready else f"needs setup: {status}"
        out.write(f"  /model {alias:<14} -> {spec:<40} {choice['label']}  [{mark}]\n")
    out.write(
        "  /model codex-5.6      -> codex:gpt-5.6-sol                       "
        "Compatibility alias for `/model codex`\n"
    )
    out.write("  /model <provider[:model]>  # custom agent.model spec\n")
    vllm_local = _discover_vllm_specs()
    if vllm_local:
        out.write("\nLocal vLLM models (live /v1/models):\n")
        for spec in vllm_local:
            out.write(f"  /model {spec}\n")
    local = _discover_ollama_specs()
    if local:
        out.write("\nLocal Ollama models with sampling controls:\n")
        for spec in local:
            out.write(f"  /model {spec}\n")
    out.write("\nSetup help:\n")
    out.write("  Local Qwen3.6-35B: ensure vLLM is up on 127.0.0.1:8000, then `/model qwen3.6-35b`.\n")
    out.write("  Grok CLI : run `grok --oauth` or configure Grok/xAI auth.\n")
    out.write("  Codex CLI: run `codex login` for ChatGPT subscription access; API-key auth is reported separately.\n")


def _render_slash_commands(out: TextIO) -> None:
    out.write("Sophia slash commands:\n")
    for command, label, hint in SLASH_COMMANDS:
        out.write(f"  {command:<14} {label:<22} {hint}\n")
    out.write("\nTip: in a real terminal, type `/` then Enter to open the arrow-key command panel.\n")


def _config_menu_options() -> list[tuple[str, str, str]]:
    return [
        ("status", "Detect current system", "OS, GPU, commands, packages, local models"),
        ("recommend", "Show best backend plan", "Mac/Linux-specific recommendation"),
        ("install-best", "Install recommended backend", "asks approval first"),
        ("install-mlx", "Install MLX-LM", "Apple Silicon native path"),
        ("install-vllm", "Install vLLM", "Linux NVIDIA parallel serving"),
        ("install-ds4", "Install DwarfStar", "DeepSeek V4 Flash on DGX Spark"),
        ("install-sglang", "Install SGLang", "agentic/structured serving"),
        ("install-llamacpp", "Build llama.cpp", "portable GGUF server"),
    ]


def _slash_menu_options() -> list[tuple[str, str, str]]:
    return [(command, label, hint) for command, label, hint in SLASH_COMMANDS]


def _model_menu_options() -> list[tuple[str, str, str]]:
    preferred = [
        "ds4", "qwen3.6-35b", "qwen3.6", "vllm", "omlx", "mlx", "mock", "grok-cli",
        "codex", "codex-terra", "codex-luna", "codex-fugu",
    ]
    rows: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for alias in preferred:
        choice = MODEL_CHOICES.get(alias)
        if not choice or alias in seen:
            continue
        seen.add(alias)
        ready, status = _model_ready(alias, choice["spec"])
        mark = "ready" if ready else f"needs setup: {status}"
        rows.append((alias, choice["label"], mark))
    for spec in _discover_vllm_specs():
        if spec in seen:
            continue
        seen.add(spec)
        rows.append((spec, "Local vLLM model", "live on OpenAI-compatible /v1"))
    for spec in _discover_ds4_specs():
        if spec in seen:
            continue
        seen.add(spec)
        rows.append((spec, "Local DwarfStar model", "live on ds4-server OpenAI-compatible /v1"))
    for spec in _discover_ollama_specs():
        if spec in seen:
            continue
        seen.add(spec)
        rows.append((spec, "Local Ollama model", "supports temperature/top_p/top_k via local server"))
    return rows


def _config_target_from_action(action: str) -> str:
    return {
        "install-mlx": "mlx-lm",
        "install-vllm": "vllm",
        "install-ds4": "ds4",
        "install-sglang": "sglang",
        "install-llamacpp": "llama.cpp",
    }[action]


def _handle_config_action(action: str, *, out: TextIO, inp: TextIO) -> None:
    from agent import runtime_config as rc

    status = rc.detect_status()
    if action in {"status", "detect", "list"}:
        out.write(rc.format_status(status) + "\n")
        return
    if action in {"recommend", "plan"}:
        out.write(rc.format_status(status) + "\n\n")
        out.write(rc.format_plan(rc.best_install_plan(status)) + "\n")
        return
    if action == "install-best":
        plan = rc.best_install_plan(status)
    elif action in {"install-mlx", "install-vllm", "install-ds4", "install-sglang", "install-llamacpp"}:
        plan = rc.install_plan(_config_target_from_action(action), python=status.python)
    else:
        out.write("Usage: /config status|recommend|install-best|install-mlx|install-vllm|install-ds4|install-sglang|install-llamacpp\n")
        return
    out.write(rc.format_plan(plan) + "\n")
    if plan is None:
        return
    if not (hasattr(inp, "isatty") and inp.isatty()):
        out.write("Install requires an interactive terminal for approval; not running commands.\n")
        return

    def confirm(preview: str) -> bool:
        out.write("\nRun these install commands now? [y/N] ")
        out.flush()
        return inp.readline().strip().lower() in {"y", "yes"}

    out.write("Install may take several minutes depending on backend and network.\n")
    for result in rc.run_plan(plan, confirm=confirm):
        cmd = " ".join(result.get("command") or [])
        if cmd:
            out.write(f"  $ {cmd}\n")
        status_text = "OK" if result.get("ok") else "FAIL"
        out.write(f"    [{status_text}] {result.get('note') or 'returncode=' + str(result.get('returncode'))}\n")
        if result.get("stderr"):
            out.write((result["stderr"] or "")[-800:] + "\n")


def _arrow_menu(title: str, rows: list[tuple[str, str, str]], *, out: TextIO, inp: TextIO) -> str | None:
    """Tiny dependency-free arrow-key menu for real terminals.

    Returns the selected row's first field, or None on cancel / non-TTY. Kept
    stdlib-only so Sophia works like `python`/`codex` after install on macOS/Linux
    without adding a TUI dependency.
    """
    if not rows or not (hasattr(inp, "isatty") and inp.isatty() and hasattr(out, "isatty") and out.isatty()):
        return None
    try:
        import termios
        import tty

        fd = inp.fileno()
        old = termios.tcgetattr(fd)
    except Exception:  # noqa: BLE001 - fall back to text list when raw mode is unavailable
        return None

    idx = 0
    width = min(max(72, max(len(f"{a} {b} {c}") for a, b, c in rows) + 10), 110)
    green = "\x1b[38;5;46m"
    dim = "\x1b[2m"
    bold = "\x1b[1m"
    rev = "\x1b[7m"
    reset = "\x1b[0m"
    top = "╭" + "─" * (width - 2) + "╮"
    mid = "├" + "─" * (width - 2) + "┤"
    bottom = "╰" + "─" * (width - 2) + "╯"

    def draw() -> None:
        out.write("\r\x1b[K")
        out.write(f"{green}{top}{reset}\n")
        title_text = f" SOPHIA // {title} "
        out.write(f"{green}│{reset}{bold}{title_text:<{width - 2}}{reset}{green}│{reset}\n")
        out.write(f"{green}{mid}{reset}\n")
        for i, (alias, label, status) in enumerate(rows):
            cursor = "➤" if i == idx else " "
            content = f" {cursor} {alias:<14} {label:<34} {status}"
            content = content[: width - 2]
            style = rev if i == idx else ""
            out.write(f"\r\x1b[K{green}│{reset}{style}{content:<{width - 2}}{reset}{green}│{reset}\n")
        help_line = " ↑/↓ or j/k navigate · Enter select · q/Esc cancel "
        out.write(f"{green}{mid}{reset}\n")
        out.write(f"{green}│{reset}{dim}{help_line:<{width - 2}}{reset}{green}│{reset}\n")
        out.write(f"{green}{bottom}{reset}")
        out.write(f"\x1b[{len(rows) + 5}A")
        out.flush()

    out.write("\n")
    try:
        tty.setcbreak(fd)
        out.write("\x1b[?25l")  # hide cursor
        draw()
        while True:
            ch = inp.read(1)
            if ch in {"\r", "\n"}:
                out.write(f"\x1b[{len(rows) + 5}B\n\x1b[?25h")
                return rows[idx][0]
            if ch in {"q", "Q", "\x03"}:  # q or Ctrl-C
                out.write(f"\x1b[{len(rows) + 5}B\n{dim}(cancelled){reset}\n\x1b[?25h")
                return None
            if ch == "\x1b":
                seq = inp.read(2)
                if seq == "[A":
                    idx = (idx - 1) % len(rows)
                elif seq == "[B":
                    idx = (idx + 1) % len(rows)
                elif seq in {"[C", "[D"}:
                    # Left/right arrows are intentionally not menu controls. Do
                    # nothing here so they remain reserved for prompt line
                    # editing via readline in the main terminal prompt.
                    pass
                else:
                    out.write(f"\x1b[{len(rows) + 5}B\n{dim}(cancelled){reset}\n\x1b[?25h")
                    return None
            elif ch in {"k", "K"}:
                idx = (idx - 1) % len(rows)
            elif ch in {"j", "J"}:
                idx = (idx + 1) % len(rows)
            draw()
    finally:
        try:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        finally:
            out.write("\x1b[?25h")
            out.flush()


def _switch_model(alias: str, client: Any, *, out: TextIO, inp: TextIO) -> Any:
    choice = MODEL_CHOICES.get(alias)
    spec = choice["spec"] if choice else alias
    ready, status = _model_ready(alias, spec)
    if not ready:
        setup = (choice or {}).get("setup", "Configure the model provider/API key, then retry.")
        out.write(f"Model `{alias}` needs setup: {status}\n{setup}\n")
        if not (hasattr(inp, "isatty") and inp.isatty()):
            out.write("Not switching in non-interactive setup state.\n")
            return client
        out.write("Switch anyway? [y/N] ")
        out.flush()
        if inp.readline().strip().lower() not in {"y", "yes"}:
            return client
    try:
        next_client, resolved = _make_client_for_model(alias)
        _refresh_trace_sink(next_client)
    except Exception as exc:  # noqa: BLE001
        out.write(f"Could not switch model: {type(exc).__name__}: {exc}\n")
        return client
    out.write(f"Switched model to {alias} ({resolved}).\n")
    return next_client


def _json_event_printer(out: TextIO) -> "Callable[[dict], None]":
    def ev(e: dict) -> None:
        out.write(json.dumps({"type": "event", "event": e}, ensure_ascii=False) + "\n")
        out.flush()
    return ev


def _files_touched(steps: list[dict]) -> list[str]:
    touched: list[str] = []
    for step in steps:
        if step.get("tool") in {"write_file", "edit_file"}:
            path = (step.get("args") or {}).get("path")
            if path and str(path) not in touched:
                touched.append(str(path))
    return touched


def _logic_audit(text: str, mode: str) -> dict | None:
    if mode in {"", "off", "none"}:
        return None
    from agent.logical_thinking import judge_text

    return judge_text(text, mode="strict" if mode == "strict" else "basic")


def _format_logic_audit(audit: dict | None) -> str:
    if not audit:
        return ""
    missing = ", ".join(audit.get("missing") or []) or "none"
    return (f"[Logic judge:{audit['mode']}] verdict={audit['verdict']} "
            f"score={audit['score']}/{audit['threshold']} missing={missing}\n")


def _result_payload(goal: str, res: Any, ctx: ToolContext, *, logic: dict | None = None) -> dict[str, Any]:
    files = _files_touched(res.steps)
    tools = [
        {"tool": step.get("tool"), "ok": bool(step.get("ok")), "args": step.get("args") or {}}
        for step in res.steps
    ]
    return {
        "ok": bool(res.ok),
        "goal": goal,
        "finalText": res.final_text,
        "gated": bool(res.gated),
        # What the gate actually checked. "gated" alone cannot tell
        # "cleared" from "merely not prohibited" — see agent/epistemic_status.py.
        "epistemic": dict(getattr(res, "epistemic", None) or {}),
        "tracePath": res.trace_path,
        "permission": ctx.permission,
        "root": str(ctx.root),
        "steps": tools,
        "filesTouched": files,
        "logicJudge": logic,
        "certificate": {
            "kind": "sophia-code-terminal-certificate",
            "deliveryGatePassed": bool(res.ok),
            "deliveryGated": bool(res.gated),
            "tracePath": res.trace_path,
            "toolsRun": [step["tool"] for step in tools],
            "filesTouched": files,
            "canClaimAGI": False,
        },
    }


def _trace_arg_path(value: str | None) -> str | None:
    if not value:
        return None
    path = Path(value).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    return str(path)


def _run_once(goal: str, *, client: Any, ctx: ToolContext, out: TextIO,
              history: "list[dict] | None", max_steps: int,
              json_output: bool = False, streaming_json: bool = False,
              trace_path: str | None = None,
              show_thinking: bool = False,
              logic_judge: str = "off",
              response_mode: str | None = None,
              enable_tools: bool = True) -> "tuple[int, list[dict]]":
    event_sink = _json_event_printer(out) if streaming_json else (None if json_output else _printer(out))
    res = run_agent_loop(goal, client=client, ctx=ctx, history=history,
                         on_event=event_sink, max_steps=max_steps,
                         trace_path=_trace_arg_path(trace_path),
                         show_thinking=show_thinking,
                         system_extra=_mode_system_extra(response_mode),
                         enable_tools=enable_tools)
    # Skip the logic audit when the model transport itself failed — scoring an
    # error notice as if it were an answer reads like the judge blocked the run.
    logic = None if getattr(res, "model_error", None) else _logic_audit(res.final_text, logic_judge)
    payload = _result_payload(goal, res, ctx, logic=logic)
    if json_output:
        out.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    elif streaming_json:
        out.write(json.dumps({"type": "result", **payload}, ensure_ascii=False) + "\n")
    else:
        marker = "⚑ (delivery gate held this answer)" if res.gated else ""
        out.write(f"\n{res.final_text}\n{marker}\n" if marker else f"\n{res.final_text}\n")
        if logic:
            out.write(_format_logic_audit(logic))
    out.flush()
    return (0 if res.ok else 1), res.messages


def _run_compare_modes(goal: str, *, client: Any, ctx: ToolContext, out: TextIO,
                       history: "list[dict] | None", max_steps: int,
                       show_thinking: bool = False) -> "tuple[int, list[dict]]":
    """Run one prompt under every response mode and print a Markdown table."""
    prior = _sampling_values(client)
    rows: list[dict] = []
    for mode, settings in MODE_PRESETS.items():
        logic_mode = _apply_mode(client, mode)
        out.write(f"● compare:{mode} temp={settings['temperature']} top_p={settings['top_p']} top_k={settings['top_k']}\n")
        out.flush()
        started = time.monotonic()
        res = run_agent_loop(
            goal,
            client=client,
            ctx=ctx,
            history=list(history or []),
            on_event=None,
            max_steps=1,
            show_thinking=show_thinking,
            system_extra=_mode_system_extra(mode),
            enable_tools=False,
        )
        elapsed = max(0.001, time.monotonic() - started)
        logic = None if getattr(res, "model_error", None) else _logic_audit(res.final_text, logic_mode)
        rows.append({
            "mode": mode,
            "temperature": settings["temperature"],
            "top_p": settings["top_p"],
            "top_k": settings["top_k"],
            "logic": logic,
            "confidence": _extract_confidence(res.final_text),
            "ok": res.ok,
            "response": res.final_text,
            "elapsedSec": round(elapsed, 3),
            "approxTokens": max(1, round(len(res.final_text) / 4)),
            "tokensPerSec": round((len(res.final_text) / 4) / elapsed, 2),
        })
    _set_client_sampling(
        client,
        temperature=(float(prior["temperature"]) if prior.get("temperature") is not None else None),
        top_p=(float(prior["top_p"]) if prior.get("top_p") is not None else None),
        top_k=(int(prior["top_k"]) if prior.get("top_k") is not None else None),
    )
    lines = [
        "| Mode | Temp | Top-p | Top-k | Sec | Approx tok/s | Confidence | Logic | OK | Response |",
        "|---|---:|---:|---:|---:|---:|---:|---|---|---|",
    ]
    for row in rows:
        logic = row["logic"] or {}
        logic_text = _logic_display(logic)
        lines.append(
            f"| {row['mode']} | {row['temperature']} | {row['top_p']} | {row['top_k']} | "
            f"{row['elapsedSec']} | {row['tokensPerSec']} | {row['confidence'] or 'n/a'} | {_table_cell(logic_text, limit=80)} | "
            f"{'yes' if row['ok'] else 'no'} | {_table_cell(row['response'])} |"
        )
    table = "\n".join(lines)
    if hasattr(out, "isatty") and out.isatty():
        out.write("\n" + _comparison_box(rows) + "\n")
    else:
        out.write("\n" + table + "\n")
    out.flush()
    next_history = list(history or [])
    next_history.extend([
        {"role": "user", "content": f"[compare all modes]\n{goal}"},
        {"role": "assistant", "content": table},
    ])
    return (0 if all(row["ok"] for row in rows) else 1), next_history


def _thinking_status(out: TextIO, *, show_thinking: bool) -> None:
    log = os.environ.get("SOPHIA_THINKING_LOG") or ""
    capture = os.environ.get("SOPHIA_CAPTURE_THINKING") or ""
    out.write("Thinking trace status:\n")
    out.write(f"  show in terminal : {show_thinking}\n")
    out.write(f"  log file/dir      : {log or '(off)'}\n")
    out.write(f"  capture verbatim  : {bool(capture.strip())}\n")
    out.write("Notes: providers may expose only summaries or no reasoning at all; "
              "hidden chain-of-thought is not guaranteed/available.\n")


def _repl_history_path() -> Path:
    from agent import harness as _h

    d = Path(_h.RUNS_DIR) / "agent_loop"
    d.mkdir(parents=True, exist_ok=True)
    return d / "sophia_repl_history"


def _setup_readline(inp: TextIO, out: TextIO):
    """Enable shell-like line editing/history for the real Sophia terminal.

    Arrow-up/down history is provided by the platform readline/libedit binding.
    We only enable it for the real process stdin/stdout; tests and piped usage keep
    the deterministic ``inp.readline()`` path.
    """
    if inp is not sys.stdin or out is not sys.stdout:
        return None
    if not (hasattr(inp, "isatty") and inp.isatty() and hasattr(out, "isatty") and out.isatty()):
        return None
    try:
        import readline
    except Exception:  # noqa: BLE001 - readline is unavailable on some minimal builds
        return None
    try:
        readline.set_history_length(1000)
        hist = _repl_history_path()
        if hist.exists():
            readline.read_history_file(str(hist))
    except Exception:  # noqa: BLE001 - history is a convenience only
        pass
    return readline


def _save_readline_history(readline_mod: Any) -> None:
    if readline_mod is None:
        return
    try:
        readline_mod.write_history_file(str(_repl_history_path()))
    except Exception:  # noqa: BLE001 - history persistence must not break exit
        pass


def _read_repl_line(out: TextIO, inp: TextIO, readline_mod: Any) -> str:
    if readline_mod is not None:
        try:
            return input("\nsophia> ")
        except EOFError:
            return ""
        except KeyboardInterrupt:
            out.write("\n")
            out.flush()
            return ""
    out.write("\nsophia> ")
    out.flush()
    return inp.readline()


def _repl(*, client: Any, ctx: ToolContext, out: TextIO, inp: TextIO, max_steps: int,
          history: "list[dict] | None" = None, conv_path: "Path | None" = None,
          logic_judge: str = "off") -> int:
    persisted = f" (session persists to {conv_path.name})" if conv_path else ""
    show_thinking = (os.environ.get("SOPHIA_SHOW_THINKING") or "").strip().lower() in {"1", "true", "yes", "on"}
    compare_next = False
    current_mode: str | None = None
    current_effort = normalize_effort(os.environ.get("SOPHIA_REASONING_EFFORT"))
    readline_mod = _setup_readline(inp, out)
    out.write(f"Sophia Agents — interactive{persisted}. /exit to quit, /reset to clear memory, /help.\n")
    if readline_mod is not None:
        out.write("Line editing enabled: use ↑/↓ to navigate prompt history.\n")
    out.flush()
    try:
        while True:
            line = _read_repl_line(out, inp, readline_mod)
            if not line:  # EOF
                break
            goal = line.strip()
            if not goal:
                continue
            if goal in {"/exit", "/quit"}:
                break
            if goal in {"/", "/menu"}:
                selected = _arrow_menu("Sophia slash command panel", _slash_menu_options(), out=out, inp=inp)
                if selected:
                    goal = selected
                else:
                    _render_slash_commands(out)
                    continue
            if goal in {"/exit", "/quit"}:
                break
            if goal == "/reset":
                history = None
                if conv_path:
                    _save_conversation(conv_path, [])
                out.write("(memory cleared)\n")
                continue
            if goal == "/help":
                out.write("Type a goal. Tools run under the current permission mode. "
                          "Use ↑/↓ for prompt history. /model lists/selects models, "
                          "/thinking controls reasoning logs, /new starts a session, "
                          "/resume restores one, /logic judges visible reasoning, "
                          "/permission controls tool approval, "
                          "/mode sets logical/creative presets, /sampling tunes temperature/top-p/top-k, "
                          "type / then Enter for the command panel, /reset clears memory, /exit quits.\n")
                _render_slash_commands(out)
                continue
            if goal == "/permission":
                selected = _arrow_menu("Select permission mode", _permission_menu_options(), out=out, inp=inp)
                if selected:
                    _set_permission(ctx, selected, out=out, inp=inp)
                else:
                    current = "manual" if ctx.permission == "approve" else ctx.permission
                    out.write(f"Permission mode: {current}. Use /permission auto|manual|readonly.\n")
                continue
            if goal.startswith("/permission "):
                mode = goal.split(None, 1)[1].strip().lower()
                _set_permission(ctx, mode, out=out, inp=inp)
                continue
            if goal in {"/mode", "/modes"}:
                selected = _arrow_menu("Select response mode", _mode_menu_options(), out=out, inp=inp)
                if selected:
                    if selected == "all":
                        compare_next = True
                        out.write("All-mode compare armed. Type your next prompt to compare every mode.\n")
                    else:
                        logic_judge = _apply_mode(client, selected, out=out)
                        current_mode = selected
                else:
                    _render_modes(out)
                continue
            if goal.startswith("/mode "):
                rest = goal.split(None, 1)[1].strip()
                name, _, maybe_prompt = rest.partition(" ")
                name = name.lower()
                if name in {"list", "ls"}:
                    _render_modes(out)
                    continue
                if name in {"all", "compare"}:
                    prompt = maybe_prompt.strip()
                    if not prompt:
                        compare_next = True
                        out.write("All-mode compare armed. Type your next prompt to compare every mode.\n")
                        continue
                    _, history = _run_compare_modes(
                        prompt, client=client, ctx=ctx, out=out, history=history,
                        max_steps=max_steps, show_thinking=show_thinking,
                    )
                    if conv_path:
                        _save_conversation(conv_path, history or [])
                    continue
                if name not in MODE_PRESETS:
                    out.write(f"Unknown mode {name!r}. Use /mode to list modes.\n")
                    continue
                logic_judge = _apply_mode(client, name, out=out)
                current_mode = name
                continue
            if goal in {"/ultramode", "/ultra"}:
                current_effort = "ultramode"
                os.environ["SOPHIA_REASONING_EFFORT"] = current_effort
                out.write("Effort set to ultramode (Sophia Ultramode profile active).\n")
                continue
            if goal == "/effort":
                out.write(f"Effort: {current_effort}. Use /effort low|medium|high|ultramode.\n")
                continue
            if goal.startswith("/effort "):
                raw_effort = goal.split(None, 1)[1].strip()
                current_effort = normalize_effort(raw_effort)
                os.environ["SOPHIA_REASONING_EFFORT"] = current_effort
                out.write(f"Effort set to {current_effort}.\n")
                continue
            if goal == "/config":
                selected = _arrow_menu("Sophia runtime configuration", _config_menu_options(), out=out, inp=inp)
                if selected:
                    _handle_config_action(selected, out=out, inp=inp)
                else:
                    _handle_config_action("recommend", out=out, inp=inp)
                continue
            if goal.startswith("/config "):
                action = goal.split(None, 1)[1].strip().lower()
                if action in {"list", "ls"}:
                    for key, label, hint in _config_menu_options():
                        out.write(f"  /config {key:<16} {label:<28} {hint}\n")
                    continue
                _handle_config_action(action, out=out, inp=inp)
                continue
            if goal == "/sampling":
                _render_sampling(out, client)
                continue
            if goal == "/temperature":
                out.write("Usage: /temperature minimum|mean|maximum|<0..2>\n")
                continue
            if goal.startswith("/temperature "):
                raw = goal.split(None, 1)[1].strip().lower()
                temp = TEMPERATURE_PRESETS.get(raw)
                if temp is None:
                    try:
                        temp = _clamp(float(raw), 0.0, 2.0)
                    except ValueError:
                        out.write("Usage: /temperature minimum|mean|maximum|<0..2>\n")
                        continue
                os.environ["SOPHIA_TEMPERATURE"] = str(temp)
                _set_client_sampling(client, temperature=temp)
                out.write(f"Temperature set to {temp}.\n")
                continue
            if goal == "/top-p":
                out.write("Usage: /top-p <0..1>\n")
                continue
            if goal.startswith("/top-p "):
                try:
                    value = _clamp(float(goal.split(None, 1)[1].strip()), 0.0, 1.0)
                except ValueError:
                    out.write("Usage: /top-p <0..1>\n")
                    continue
                os.environ["SOPHIA_TOP_P"] = str(value)
                _set_client_sampling(client, top_p=value)
                out.write(f"top_p set to {value}.\n")
                continue
            if goal == "/top-k":
                out.write("Usage: /top-k <positive integer>\n")
                continue
            if goal.startswith("/top-k "):
                try:
                    value = max(1, int(goal.split(None, 1)[1].strip()))
                except ValueError:
                    out.write("Usage: /top-k <positive integer>\n")
                    continue
                os.environ["SOPHIA_TOP_K"] = str(value)
                _set_client_sampling(client, top_k=value)
                out.write(f"top_k set to {value}.\n")
                continue
            if goal == "/logic":
                selected = _arrow_menu("Select logic judge", _logic_menu_options(), out=out, inp=inp)
                if selected:
                    logic_judge = "basic" if selected == "basic" else "strict" if selected == "strict" else "off"
                    out.write(f"Logic judge set to {logic_judge}.\n")
                else:
                    out.write(f"Logic judge: {logic_judge} (use /logic off|basic|strict)\n")
                continue
            if goal.startswith("/logic "):
                mode = goal.split(None, 1)[1].strip().lower()
                if mode in {"on", "basic"}:
                    logic_judge = "basic"
                elif mode == "strict":
                    logic_judge = "strict"
                elif mode in {"off", "none"}:
                    logic_judge = "off"
                else:
                    out.write("Usage: /logic off|basic|strict\n")
                    continue
                out.write(f"Logic judge set to {logic_judge}.\n")
                continue
            if goal == "/new" or goal.startswith("/new "):
                requested = goal.split(None, 1)[1].strip() if " " in goal else _new_session_name()
                conv_path = _conversation_path(requested)
                history = None
                _save_conversation(conv_path, [])
                out.write(f"Started new Sophia session: {conv_path.stem}\n")
                continue
            if goal in {"/sessions", "/resume list"}:
                _render_sessions(out)
                continue
            if goal == "/resume":
                rows = _session_menu_options()
                if not rows:
                    out.write("No saved Sophia sessions yet. Start one with /new <name>.\n")
                    continue
                selected = _arrow_menu("Resume Sophia session", rows, out=out, inp=inp)
                if not selected:
                    _render_sessions(out)
                    continue
                conv_path = _conversation_path(selected)
                history = _load_conversation(conv_path, out=out)
                out.write(f"Resumed Sophia session: {selected} ({len(history or [])} turns)\n")
                continue
            if goal.startswith("/resume "):
                requested = goal.split(None, 1)[1].strip()
                if requested in {"list", "ls"}:
                    _render_sessions(out)
                    continue
                conv_path = _conversation_path(requested)
                history = _load_conversation(conv_path, out=out)
                if history is None:
                    out.write(f"No saved Sophia session named {requested!r}. Use /sessions to list.\n")
                    conv_path = None
                    history = None
                else:
                    out.write(f"Resumed Sophia session: {conv_path.stem} ({len(history)} turns)\n")
                continue
            if goal == "/thinking":
                selected = _arrow_menu("Thinking controls", _thinking_menu_options(), out=out, inp=inp)
                if selected:
                    goal = f"/thinking {selected}"
                else:
                    _thinking_status(out, show_thinking=show_thinking)
                    continue
            if goal.startswith("/thinking "):
                parts = goal.split()
                cmd = parts[1].lower() if len(parts) > 1 else "status"
                if cmd in {"on", "enable"}:
                    show_thinking = True
                    os.environ["SOPHIA_SHOW_THINKING"] = "1"
                    os.environ["SOPHIA_THINKING_LOG"] = os.environ.get("SOPHIA_THINKING_LOG") or "1"
                    os.environ["SOPHIA_CAPTURE_THINKING"] = "1"
                    _refresh_trace_sink(client)
                    out.write("Thinking display/logging enabled for provider-exposed reasoning.\n")
                elif cmd in {"off", "disable"}:
                    show_thinking = False
                    os.environ.pop("SOPHIA_SHOW_THINKING", None)
                    os.environ.pop("SOPHIA_CAPTURE_THINKING", None)
                    os.environ.pop("SOPHIA_THINKING_LOG", None)
                    _refresh_trace_sink(client)
                    out.write("Thinking display/logging disabled.\n")
                elif cmd == "show" and len(parts) > 2:
                    show_thinking = parts[2].lower() in {"1", "true", "yes", "on"}
                    os.environ["SOPHIA_SHOW_THINKING"] = "1" if show_thinking else "0"
                    out.write(f"Terminal thinking display set to {show_thinking}.\n")
                elif cmd == "capture" and len(parts) > 2:
                    if parts[2].lower() in {"1", "true", "yes", "on"}:
                        os.environ["SOPHIA_CAPTURE_THINKING"] = "1"
                    else:
                        os.environ.pop("SOPHIA_CAPTURE_THINKING", None)
                    out.write(f"Verbatim provider-exposed capture set to {bool(os.environ.get('SOPHIA_CAPTURE_THINKING'))}.\n")
                elif cmd == "log":
                    os.environ["SOPHIA_THINKING_LOG"] = parts[2] if len(parts) > 2 else "1"
                    _refresh_trace_sink(client)
                    out.write(f"Thinking log set to {os.environ['SOPHIA_THINKING_LOG']}.\n")
                else:
                    _thinking_status(out, show_thinking=show_thinking)
                continue
            if goal == "/model":
                selected = _arrow_menu("Select model", _model_menu_options(), out=out, inp=inp)
                if selected:
                    client = _switch_model(selected, client, out=out, inp=inp)
                else:
                    _render_model_choices(out)
                continue
            if goal in {"/models", "/model list"}:
                _render_model_choices(out)
                continue
            if goal.startswith("/model "):
                alias = goal.split(None, 1)[1].strip()
                if alias in {"list", "ls"}:
                    _render_model_choices(out)
                    continue
                client = _switch_model(alias, client, out=out, inp=inp)
                continue
            if goal.startswith("/"):
                command, _name, command_args = _resolve_slash(goal)
                if command is None:
                    out.write(f"Unknown slash command: {goal.split(None, 1)[0]}. Use /help to list commands.\n")
                    continue
                if command.kind == "prompt":
                    template = command.prompt_template or "Handle the /{name} request. Args: {args}"
                    goal = template.replace("{name}", command.name).replace(
                        "{args}", command_args or "(see repository state)"
                    )
                else:
                    if command.execution_state == "info":
                        out.write(f"/{command.name}: {command.description}\n")
                    else:
                        out.write(_unsupported_slash_message(command.name) + "\n")
                    continue
            if compare_next:
                compare_next = False
                _, history = _run_compare_modes(
                    goal, client=client, ctx=ctx, out=out, history=history,
                    max_steps=max_steps, show_thinking=show_thinking,
                )
                if conv_path:
                    _save_conversation(conv_path, history or [])
                continue
            _, history = _run_once(goal, client=client, ctx=ctx, out=out,
                                   history=history, max_steps=max_steps,
                                   show_thinking=show_thinking,
                                   logic_judge=logic_judge,
                                   response_mode=current_mode)
            if conv_path:
                _save_conversation(conv_path, history or [])
    finally:
        _save_readline_history(readline_mod)
    out.write("bye.\n")
    out.flush()
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sophia", description="Sophia Agents terminal tool")
    p.add_argument("goal", nargs="?", help="one-shot goal; omit for an interactive REPL")
    p.add_argument("-p", "--prompt", default=None,
                   help="one-shot goal for headless/script mode (alias for positional goal)")
    p.add_argument("-m", "--model", default=None,
                   help="model spec: provider[:model] (e.g. anthropic, glm:glm-4). Default: env")
    p.add_argument("--adapter", default=None,
                   help="local LoRA adapter path (currently passed to the MLX transport)")
    p.add_argument("--server", default=None,
                   help="OpenAI-compatible base URL for local vLLM/SGLang/Ollama/llama.cpp")
    p.add_argument("--mock", action="store_true", help="use the offline deterministic model")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--auto", "--yolo", action="store_true", dest="auto",
                   help="run write/bash tools WITHOUT prompting (unattended)")
    g.add_argument("--full-access", action="store_true", dest="auto",
                   help="explicit alias for --auto; destructive commands still require confirmation")
    g.add_argument("--approve", "--manual", action="store_true", dest="approve",
                   help="ask before write/bash tools and function-call execution")
    g.add_argument("--readonly", action="store_true", help="forbid any write or exec tool")
    p.add_argument("--cwd", default=None, help="working root for the agent (default: current directory)")
    p.add_argument("--max-steps", type=int, default=None, help="max tool-use steps per goal")
    p.add_argument("--session", default=None,
                   help="named conversation: persists memory across runs (resume later with the same name)")
    p.add_argument("--sandbox", action="store_true",
                   help="run bash inside a sandbox (Docker); fail-closed if no isolation backend is available")
    p.add_argument("--config", default=None,
                   help="Sophia Code TOML config file; only the [code] table is honored")
    p.add_argument("--json", action="store_true",
                   help="one-shot machine output: final payload + certificate as JSON")
    p.add_argument("--streaming-json", action="store_true",
                   help="one-shot NDJSON event stream followed by a result payload")
    p.add_argument("--trace", default=None, help="write the tool-loop trace JSONL to this path")
    p.add_argument("--show-thinking", action="store_true",
                   help="print provider-exposed reasoning/summaries in the terminal when available")
    p.add_argument("--thinking-log", nargs="?", const="1", default=None,
                   help="enable thinking trace logging; optional path or default agent/memory/thinking")
    p.add_argument("--capture-thinking", action="store_true",
                   help="request and store provider-exposed reasoning text when available")
    p.add_argument("--logic-judge", choices=("off", "basic", "strict"), default="off",
                   help="score visible final-answer reasoning against Sophia logical-thinking criteria")
    p.add_argument("--mode", dest="response_mode",
                   choices=(*MODE_PRESETS.keys(), "all"), default=None,
                   help="response mode preset; 'all' runs every mode and prints a comparison table")
    p.add_argument("--effort", default=None,
                   help="reasoning effort: low|medium|high|ultramode (aliases accepted)")
    p.add_argument("--no-tools", action="store_true",
                   help="disable the tool-use loop for one-shot runs; answer directly in prose")
    p.add_argument("--temperature", type=float, default=None,
                   help="LLM sampling temperature (clamped to 0..2)")
    p.add_argument("--temperature-preset", choices=("minimum", "min", "mean", "medium", "maximum", "max"),
                   default=None, help="temperature preset: minimum=0.0, mean=0.5, maximum=1.0")
    p.add_argument("--top-p", type=float, default=None, help="nucleus sampling top_p (0..1), when supported")
    p.add_argument("--top-k", type=int, default=None, help="top_k sampling cutoff, when supported")
    return p


def _force_utf8_stdio() -> None:
    """Windows pipes default to the ANSI codepage (cp1252), which cannot
    encode the bilingual (EN + 中文) output this CLI emits; without this the
    JSON/REPL modes crash with UnicodeEncodeError: 'charmap' codec. Replace
    unencodable bytes rather than fail a delivered answer."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def main(argv: "list[str] | None" = None, *, client: Any = None,
         out: "TextIO | None" = None, inp: "TextIO | None" = None) -> int:
    args = build_parser().parse_args(argv)
    _force_utf8_stdio()
    out = out if out is not None else sys.stdout
    inp = inp if inp is not None else sys.stdin
    _apply_config_defaults(args)
    try:
        _apply_sampling_env(args)
    except ValueError as exc:
        out.write(f"error: {exc}\n")
        return 2
    _configure_thinking(args)

    if args.json and args.streaming_json:
        out.write("error: choose only one of --json or --streaming-json\n")
        return 2
    goal = args.prompt or args.goal
    if args.prompt and args.goal:
        out.write("error: pass the goal either positionally or with -p/--prompt, not both\n")
        return 2
    if not goal and (args.json or args.streaming_json):
        out.write("error: --json/--streaming-json require a one-shot goal\n")
        return 2

    root = Path(args.cwd).resolve() if args.cwd else workspace_dir()
    if not root.is_dir():
        out.write(f"error: working root does not exist: {root}\n")
        return 2

    permission = _permission(args)
    approver = None if permission != "approve" else _make_approver(out, inp)
    ctx = ToolContext(root=root, permission=permission, approver=approver)

    if args.sandbox:
        from agent.sandbox import default_backend
        ctx.sandbox = default_backend()
        note = ("no isolation backend available — bash will fail closed"
                if ctx.sandbox.name == "null" else f"backend: {ctx.sandbox.name}")
        # --json promises stdout is exactly one JSON document; this banner is
        # human chrome, so it goes to stderr there rather than corrupting it.
        banner = f"● sandbox on ({note})\n"
        if args.json or args.streaming_json:
            sys.stderr.write(banner)
        else:
            out.write(banner)

    if client is None:
        try:
            client = _build_client(args)
        except Exception as exc:  # noqa: BLE001 - user-facing helpful message, not a traceback
            out.write(f"error: could not build model client: {exc}\n"
                      f"hint: set SOPHIA_MODEL_PROVIDER (and an API key), or pass --mock.\n")
            return 2
    else:
        _refresh_trace_sink(client)
    if args.response_mode and args.response_mode != "all":
        args.logic_judge = _apply_mode(client, args.response_mode)

    conv_path = _conversation_path(args.session) if args.session else (None if goal else _conversation_path("default"))
    history = _load_conversation(conv_path, out=out) if conv_path else None

    if goal:
        if args.response_mode == "all":
            code, messages = _run_compare_modes(
                goal, client=client, ctx=ctx, out=out, history=history,
                max_steps=args.max_steps, show_thinking=args.show_thinking,
            )
        else:
            code, messages = _run_once(goal, client=client, ctx=ctx, out=out,
                                       history=history, max_steps=args.max_steps,
                                       json_output=args.json, streaming_json=args.streaming_json,
                                       trace_path=args.trace,
                                       show_thinking=args.show_thinking,
                                       logic_judge=args.logic_judge,
                                       response_mode=args.response_mode,
                                       enable_tools=not args.no_tools)
        if conv_path:
            _save_conversation(conv_path, messages)
        return code
    return _repl(client=client, ctx=ctx, out=out, inp=inp, max_steps=args.max_steps,
                 history=history, conv_path=conv_path, logic_judge=args.logic_judge)


if __name__ == "__main__":
    raise SystemExit(main())
