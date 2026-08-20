# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Compact Sophia runtime policy for the terminal agent.

The default prompt stays intentionally small. Deeper behavior belongs to an
explicit effort/profile selection, not an always-on historical harness.

candidateOnly; canClaimAGI:false — runtime policy, not a model-identity claim.
"""
from __future__ import annotations

import os
import re
import time
import uuid
import threading
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from agent import runtime_paths
from agent.prompt_compiler import (
    CompiledPrompt,
    PromptModule,
    PromptProfile,
    compile_prompt,
)

# --------------------------------------------------------------------------- #
# System prompt
# --------------------------------------------------------------------------- #

CORE_RUNTIME_POLICY = """
## Core runtime policy

- Sophia Code is the harness, not the model identity. For a model question,
  report only the selected or provider-reported model; do not invent parent,
  worker, promotion, or historical-profile details.
- Answer simple direct questions directly and briefly.
- Use tools only when they materially help. Inspect before mutation, keep
  changes surgical, and verify before claiming success.
- Ask before destructive, outward-facing, secret-dependent, or genuinely
  ambiguous actions unless the active permission policy already authorizes them.
- Report failures and uncertainty plainly. Never claim AGI, validated uplift,
  or adapter promotion unless the relevant gate says so.
- Preserve candidateOnly:true and canClaimAGI:false.
""".strip()

TOOL_PROTOCOL = """
## Tool protocol

You accomplish the user's goal by using tools. Keep calling tools, one at a
time, until the goal is FULLY achieved — do not stop after a single tool call
to summarize or ask permission for the next step. Only produce a final prose
answer (no JSON) when the task is genuinely complete or you are blocked on
information only the user can provide.

Before the first call, silently orchestrate the complete task: identify
dependencies, combine related discovery into the smallest useful queries, and
avoid calls whose result is already present. If your provider supports native
multi-tool calls, you may request a bounded batch only for independent read-only
operations; dependent steps and all writes stay ordered. The text JSON fallback
below remains exactly one call per turn. On that fallback, use `read_batch` when
you already know 2-8 independent repository reads/searches are required; do not
use it for speculative fishing or for a dependent read-after-write sequence.

To use a tool, reply with ONE JSON object and nothing else:
  {{"tool": "<name>", "args": {{...}}}}
When (and ONLY when) you have finished ALL required steps, reply with your
final answer as plain prose (NO JSON object).

{tools}
""".strip()

#: Sent instead of ``TOOL_PROTOCOL`` when the resolved model has native
#: function-calling AND is a local backend (see
#: ``agent_loop._use_short_tool_protocol``). Reproduced 5/5 against the shipped
#: local example model (``vllm:mlx-community--Qwen3-4B-Instruct-2507-4bit``):
#: ``TOOL_PROTOCOL`` above duplicates every tool's name/description/parameters
#: in prose on top of the native ``tools=`` schema the transport already sends,
#: and that small model's tool-call emission degrades — malformed or empty
#: calls — with both present. A model that actually receives a native schema
#: does not need the prose restated; it only needs the turn-taking rule the
#: schema itself cannot express. The Codex CLI envelope bridge also uses this
#: form because it receives the schema through its structured transport prompt;
#: other cloud/frontier callers do not.
SHORT_TOOL_PROTOCOL = """
## Tool protocol

Tools are available to you via native function-calling. The schema already
declares every tool's name, description, and parameters, so no prose listing
follows here — call tools using that schema, not a JSON object in your reply
text. Call at most one tool per turn and wait for its result before the next
call. Reply in plain prose with no function call only when the goal is fully
achieved or you are blocked on information only the user can provide.
""".strip()

SOPHIA_RULES = """
## Sophia discipline

- Prefer the smallest context and tool sequence that solves the request.
- Keep working policy separate from final presentation; do not expose hidden
  reasoning or add ceremonial quality-bar boilerplate.
- Use a specific source URL only when source evidence is actually needed.
- write_file / edit_file / bash may require operator approval; if a tool is denied,
  adapt or explain what you would need.
""".strip()

LOCAL_CORE_RUNTIME_POLICY = """
## Core runtime policy
Answer direct questions briefly. Sophia Code is the harness, not the model.
Use tools only when useful; inspect before mutation; verify material claims.
Never invent evidence, model identity, promotion, or AGI capability.
Preserve candidateOnly:true and canClaimAGI:false.
""".strip()



# --------------------------------------------------------------------------- #
# Ultramode / effort
# --------------------------------------------------------------------------- #

ULTRA_EFFORTS = frozenset({"max", "ultra", "ultramode", "xhigh", "ultracode"})

# Repo-local explicit high-rigor profile.
_DEFAULT_PROFILE = Path(__file__).resolve().parent / "prompts" / "sophia-ultramode.md"


def resolve_ultramode_profile_path() -> Path | None:
    """Locate the Sophia Ultramode markdown profile."""
    import os
    env = os.environ.get("SOPHIA_ULTRAMODE_PROFILE", "").strip()
    if env:
        path = Path(env).expanduser()
        if path.is_file():
            return path
    if _DEFAULT_PROFILE.is_file():
        return _DEFAULT_PROFILE
    return None


def load_ultramode_profile(*, max_chars: int = 12_000) -> str:
    """Load the Sophia Ultramode profile (truncated). Empty if missing."""
    path = resolve_ultramode_profile_path()
    if path is None:
        return ""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return raw.strip()[:max_chars]


def normalize_effort(value: str | None) -> str:
    import os
    raw = (value or os.environ.get("SOPHIA_REASONING_EFFORT") or "medium").strip().lower()
    aliases = {
        "min": "low",
        "minimum": "low",
        "med": "medium",
        "default": "medium",
        "xhigh": "ultramode",
        "ultracode": "ultramode",
        "ultra": "ultramode",
        "max": "ultramode",
    }
    raw = aliases.get(raw, raw)
    if raw not in {"low", "medium", "high", "ultramode"}:
        return "medium"
    return raw


def is_ultramode(effort: str | None = None) -> bool:
    return normalize_effort(effort) == "ultramode"


def effort_system_extra(effort: str | None = None) -> str:
    """System-extra block for the current effort ladder."""
    e = normalize_effort(effort)
    if e == "low":
        return (
            "\nSophia effort: LOW. Prefer short answers, minimal tool use, and "
            "skip deep multi-file exploration unless the task requires it.\n"
        )
    if e == "high":
        return (
            "\nSophia effort: HIGH. Inspect carefully, verify material claims, "
            "and double-check before reporting completion.\n"
        )
    if e == "ultramode":
        profile = load_ultramode_profile()
        header = (
            "\n## Sophia ULTRAMODE\n"
            "Effort=ultramode: explicit high-rigor profile. Inspect deeply, verify "
            "with tools, and keep canClaimAGI:false.\n"
        )
        if profile:
            return header + "\n" + profile + "\n"
        return header
    # medium
    return (
        "\nSophia effort: MEDIUM. Answer directly; use tools when useful; verify "
        "before claiming completion.\n"
    )


def compile_system_prompt(
    *,
    root: str | Path,
    tools: str,
    extra: str = "",
    effort: str | None = None,
    ultramode: bool | None = None,
    response_style: str = "adaptive",
    current_request: str = "",
    short_tool_protocol: bool = False,
    prompt_profile: PromptProfile = "classic",
    prompt_budget_tokens: int | None = None,
    context_window: int | None = None,
) -> CompiledPrompt:
    """Compile the Sophia Code system prompt for one run.

    When ``effort`` is max/ultra/ultramode (or ``ultramode=True``), inject the
    explicit Sophia Ultramode profile (``agent/prompts/sophia-ultramode.md`` or
    ``SOPHIA_ULTRAMODE_PROFILE``).

    ``short_tool_protocol=True`` swaps the full per-tool prose block (``tools``,
    normally rendered via ``TOOL_PROTOCOL``) for ``SHORT_TOOL_PROTOCOL``. The
    caller (``agent_loop.run_agent_loop``) sets this when the resolved model
    supports native function-calling and is either a local backend — the
    combination the redundant prose was measured to break — or the Codex CLI
    structured-envelope bridge. ``tools`` is simply ignored in that case.
    Defaults to ``False`` so every existing caller keeps the historical
    full-prose prompt unless it opts in.

    ``prompt_profile="local"`` selects compact module variants and a bounded
    prompt budget. The compiler emits a receipt naming included, truncated, and
    dropped modules so prompt customization is inspectable rather than hidden.
    """
    import os
    from agent.response_style import (
        final_presentation_policy,
        is_exact_output_request,
        resolve_response_style,
        working_policy,
    )

    root_s = str(root)
    eff = normalize_effort(effort)
    if ultramode is True:
        eff = "ultramode"
        os.environ["SOPHIA_REASONING_EFFORT"] = "ultramode"
    effort_block = effort_system_extra(eff)
    local_effort_block = {
        "low": "Sophia effort: LOW. Keep the answer and tool sequence minimal.",
        "medium": "Sophia effort: MEDIUM. Act, verify, and report concisely.",
        "high": (
            "Sophia effort: HIGH. Inspect carefully, verify material claims, "
            "and double-check the result."
        ),
        "ultramode": (
            "Sophia effort: ULTRAMODE. Use maximum practical rigor and agency, "
            "finish the task, and keep canClaimAGI:false."
        ),
    }[eff]
    tool_block = SHORT_TOOL_PROTOCOL if short_tool_protocol else TOOL_PROTOCOL.format(tools=tools)
    resolved_style = resolve_response_style(current_request, response_style)
    presentation_block = final_presentation_policy(
        resolved_style,
        exact_output=is_exact_output_request(current_request),
    )
    modules = [
        PromptModule(
            "identity",
            (
                "You are operating through Sophia Code, a provenance-aware "
                f"terminal coding harness rooted at {root_s}."
            ),
            priority=1_000,
            source="core",
            required=True,
        ),
        PromptModule(
            "core-runtime-policy",
            CORE_RUNTIME_POLICY,
            priority=900,
            source="core",
            required=True,
            local_text=LOCAL_CORE_RUNTIME_POLICY,
        ),
        PromptModule(
            "effort",
            effort_block,
            priority=800,
            source="run",
            required=True,
            local_text=local_effort_block,
        ),
        PromptModule(
            "working-policy",
            working_policy(),
            priority=700,
            source="core",
            required=True,
        ),
        PromptModule(
            "presentation",
            presentation_block,
            priority=600,
            source="request",
            required=True,
        ),
        PromptModule(
            "tool-protocol",
            tool_block,
            priority=500,
            source="provider-tools",
            required=True,
            min_chars=320,
        ),
        PromptModule(
            "sophia-discipline",
            SOPHIA_RULES,
            priority=400,
            source="core",
            required=True,
        ),
    ]
    if (extra or "").strip():
        modules.append(
            PromptModule(
                "run-context",
                str(extra).strip(),
                priority=200,
                source="repo-request-session-memory",
                # Current-turn authority and continuation guidance live here.
                # Preserve a bounded prefix rather than silently dropping the
                # operator's active request when a local budget is tight.
                required=True,
                min_chars=320,
            )
        )
    return compile_prompt(
        modules,
        profile=prompt_profile,
        budget_tokens=prompt_budget_tokens,
        context_window=context_window,
    )


def build_system_prompt(
    *,
    root: str | Path,
    tools: str,
    extra: str = "",
    effort: str | None = None,
    ultramode: bool | None = None,
    response_style: str = "adaptive",
    current_request: str = "",
    short_tool_protocol: bool = False,
    prompt_profile: PromptProfile = "classic",
    prompt_budget_tokens: int | None = None,
    context_window: int | None = None,
) -> str:
    """Backward-compatible text-only wrapper around ``compile_system_prompt``."""
    return compile_system_prompt(
        root=root,
        tools=tools,
        extra=extra,
        effort=effort,
        ultramode=ultramode,
        response_style=response_style,
        current_request=current_request,
        short_tool_protocol=short_tool_protocol,
        prompt_profile=prompt_profile,
        prompt_budget_tokens=prompt_budget_tokens,
        context_window=context_window,
    ).text


# --------------------------------------------------------------------------- #
# OKF process-log pages (task-level, not turn-level session projection)
# --------------------------------------------------------------------------- #

def _slugify(text: str, *, limit: int = 48) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    return (slug[:limit] or "task").strip("_")


def process_log_id(goal: str, *, when: date | None = None) -> str:
    day = (when or date.today()).strftime("%Y%m%d")
    # Keep the stable human-readable prefix while preventing same-day collisions.
    nonce = f"{time.time_ns():x}-{os.getpid():x}-{uuid.uuid4().hex[:8]}"
    return f"run_{_slugify(goal)}_{day}_{nonce}"


def process_log_paths(root: Path) -> list[Path]:
    """Candidate directories for process logs, first-writable preference order."""
    paths = [
        root / "wiki" / "drafts",
        root / ".sophia" / "okf-process-log",
        root / ".claude" / "okf-process-log",
        Path.home() / ".sophia" / "okf-process-log",
    ]
    mutable = runtime_paths.mutable_root()
    if mutable != runtime_paths.PROJECT_ROOT.resolve():
        external = mutable / "okf-process-log"
        paths = [external, *[path for path in paths if path != external]]
    return paths


def resolve_process_log_dir(root: Path) -> Path:
    """Pick a durable process-log directory without leaking into another project."""
    mutable = runtime_paths.mutable_root()
    if mutable != runtime_paths.PROJECT_ROOT.resolve():
        # Bundled releases and operator-managed runs promise that every mutable
        # default stays under the external state root. A release launched with
        # its own directory as the workspace previously wrote
        # <release>/.sophia/okf-process-log and invalidated its manifest.
        path = mutable / "okf-process-log"
    elif (root / "okf").is_dir() and (root / "wiki").is_dir():
        path = root / "wiki" / "drafts"
    elif (root / ".claude" / "okf-process-log").is_dir():
        path = root / ".claude" / "okf-process-log"
    else:
        path = root / ".sophia" / "okf-process-log"
    path.mkdir(parents=True, exist_ok=True)
    return path


def render_process_page(
    *,
    page_id: str,
    goal: str,
    status: str,
    model: str = "",
    plan: str = "",
    actions: str = "",
    evidence: str = "",
    outcome: str = "",
    lessons: str = "",
    sources: list[str] | None = None,
) -> str:
    """Render an OKF memory page body (frontmatter + markdown)."""
    src = sources or ["sophia_code"]
    sources_yaml = "[" + ", ".join(json_quote(s) for s in src) + "]"
    model_line = f"model: {json_quote(model)}\n" if model else ""
    return (
        f"---\n"
        f"id: {page_id}\n"
        f"pageType: memory\n"
        f"sources: {sources_yaml}\n"
        f"mode: sophia_code\n"
        f"task: {json_quote(goal[:200])}\n"
        f"status: {status}\n"
        f"{model_line}"
        f"candidateOnly: true\n"
        f"canClaimAGI: false\n"
        f"links: []\n"
        f"updated: {json_quote(datetime.now(timezone.utc).isoformat())}\n"
        f"---\n\n"
        f"# Task: {goal[:120]}\n\n"
        f"## Goal\n\n{goal}\n\n"
        f"## Plan\n\n{plan or '_(none)_'}\n\n"
        f"## Actions\n\n{actions or '_(none)_'}\n\n"
        f"## Evidence\n\n{evidence or '_(none)_'}\n\n"
        f"## Outcome\n\n{outcome or '_(in progress)_'}\n\n"
        f"## Lessons\n\n{lessons or '_(none yet)_'}\n"
    )


def json_quote(value: str) -> str:
    """YAML-safe double-quoted scalar for simple strings."""
    escaped = (
        str(value)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", " ")
        .replace("\r", " ")
    )
    return f'"{escaped}"'



def extract_errors_from_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collect failed tool steps as structured error records."""
    errors: list[dict[str, Any]] = []
    for step in steps or []:
        if step.get("ok"):
            continue
        name = str(step.get("tool") or "?")
        err = str(step.get("error") or "").strip()
        out = str(step.get("output") or "").strip()
        args = step.get("args") or {}
        detail = err or out or "tool failed without message"
        errors.append({
            "type": "tool_error",
            "tool": name,
            "args": args if isinstance(args, dict) else {"raw": str(args)[:200]},
            "error": detail[:1500],
        })
    return errors


def lessons_from_run(
    *,
    steps: list[dict[str, Any]] | None = None,
    model_error: str | None = None,
    gated: bool = False,
    ok: bool = True,
    final_text: str = "",
) -> str:
    """Build concrete Lessons text so future runs can avoid the same failure."""
    lines: list[str] = []
    errors = extract_errors_from_steps(steps or [])
    if model_error:
        lines.append(
            f"**Model/transport failure:** {model_error[:500]}\n"
            "**How to apply:** Fix provider credentials/backend reachability before retrying; "
            "do not assume the previous plan executed."
        )
    for e in errors:
        tool = e.get("tool", "?")
        detail = str(e.get("error") or "")[:400]
        args = e.get("args") or {}
        arg_hint = ""
        if isinstance(args, dict) and args:
            # surface path/command if present
            for k in ("path", "command", "pattern", "file"):
                if args.get(k):
                    arg_hint = f" ({k}={str(args[k])[:120]})"
                    break
        lines.append(
            f"**Tool failure — {tool}{arg_hint}:** {detail}\n"
            f"**How to apply:** Do not repeat the same {tool} call with identical args without "
            f"changing approach (check paths exist, permissions, command flags, or fix the root cause first)."
        )
    if gated:
        lines.append(
            "**Delivery gate held/downgraded the answer.**\n"
            "**How to apply:** Remove overclaims (AGI/uplift/promotion); keep canClaimAGI:false; "
            "state uncertainty; ground claims in tool evidence."
        )
    if not ok and not lines:
        snippet = " ".join((final_text or "").split())[:300]
        lines.append(
            f"**Run failed without structured tool errors.** Outcome: {snippet or '_(empty)_'}\n"
            "**How to apply:** Re-check goal scope, max_steps, and whether tools were denied."
        )
    if ok and not lines:
        lines.append(
            "Run completed without tool failures. canClaimAGI:false; delivery gate applied."
        )
    return "\n\n".join(lines)


def format_errors_section(errors: list[dict[str, Any]]) -> str:
    if not errors:
        return "_(none)_"
    lines: list[str] = []
    for i, e in enumerate(errors, 1):
        lines.append(
            f"{i}. **{e.get('type', 'error')}** · `{e.get('tool', '')}`\n"
            f"   {str(e.get('error') or '')[:800]}"
        )
    return "\n".join(lines)


_INDEX_LOCKS: dict[str, threading.Lock] = {}
_INDEX_LOCKS_GUARD = threading.Lock()


def _path_lock(path: Path) -> threading.Lock:
    key = str(path.resolve())
    with _INDEX_LOCKS_GUARD:
        return _INDEX_LOCKS.setdefault(key, threading.Lock())


def _atomic_write_text(path: Path, text: str) -> None:
    """Replace a UTF-8 text file atomically within its directory."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            # os.replace may already have consumed the temporary path.
            pass


def write_process_log(
    root: Path,
    *,
    goal: str,
    status: str,
    model: str = "",
    plan: str = "",
    actions: str = "",
    evidence: str = "",
    outcome: str = "",
    lessons: str = "",
    page_id: str | None = None,
    sources: list[str] | None = None,
    errors: list[dict[str, Any]] | None = None,
    model_error: str | None = None,
) -> Path | None:
    """Write or overwrite one OKF process-log page. Best-effort; never raises.

    Always safe to call on failure paths. Failed runs also append to FAILURES.md
    for fast recall.
    """
    try:
        log_dir = resolve_process_log_dir(root)
        pid = page_id or process_log_id(goal)
        path = log_dir / f"{pid}.md"

        err_list = list(errors or [])
        if model_error:
            err_list.insert(0, {
                "type": "model_error",
                "tool": "model",
                "args": {},
                "error": model_error[:1500],
            })
        error_types = sorted({str(e.get("type") or "error") for e in err_list})
        errors_yaml = "[" + ", ".join(json_quote(x) for x in error_types) + "]" if error_types else "[]"
        src = sources or ["sophia_code"]
        sources_yaml = "[" + ", ".join(json_quote(s) for s in src) + "]"
        model_line = f"model: {json_quote(model)}\n" if model else ""
        failed = status in {"failed", "blocked", "error"} or bool(err_list and status != "done")

        body = (
            f"---\n"
            f"id: {pid}\n"
            f"pageType: memory\n"
            f"sources: {sources_yaml}\n"
            f"mode: sophia_code\n"
            f"task: {json_quote(goal[:200])}\n"
            f"status: {status}\n"
            f"{model_line}"
            f"errorTypes: {errors_yaml}\n"
            f"candidateOnly: true\n"
            f"canClaimAGI: false\n"
            f"links: []\n"
            f"updated: {json_quote(datetime.now(timezone.utc).isoformat())}\n"
            f"---\n\n"
            f"# Task: {goal[:120]}\n\n"
            f"## Goal\n\n{goal}\n\n"
            f"## Plan\n\n{plan or '_(none)_'}\n\n"
            f"## Actions\n\n{actions or '_(none)_'}\n\n"
            f"## Errors\n\n{format_errors_section(err_list)}\n\n"
            f"## Evidence\n\n{evidence or '_(none)_'}\n\n"
            f"## Outcome\n\n{outcome or '_(in progress)_'}\n\n"
            f"## Lessons\n\n{lessons or '_(none yet)_'}\n"
        )
        # Atomic create/write: never expose a partial page and never overwrite a
        # concurrent run unless an explicit page_id was supplied by the caller.
        tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        tmp.write_text(body, encoding="utf-8")
        os.replace(tmp, path)

        # INDEX.md — upsert status line for this file
        index = log_dir / "INDEX.md"
        line = f"- [{goal[:60]}]({path.name}) — {status}\n"
        with _path_lock(index):
            if index.exists():
                existing = index.read_text(encoding="utf-8").splitlines()
                kept = [ln for ln in existing if path.name not in ln]
                if kept and not kept[0].startswith("#"):
                    kept.insert(0, "# OKF process log index (Sophia Code)")
                kept.append(line.rstrip())
                _atomic_write_text(index, "\n".join(kept).rstrip() + "\n")
            else:
                _atomic_write_text(index, "# OKF process log index (Sophia Code)\n\n" + line)

        # FAILURES.md — append-only ledger of failed runs for anti-repeat recall
        if failed:
            fail_path = log_dir / "FAILURES.md"
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            err_summary = "; ".join(
                f"{e.get('type')}:{e.get('tool')}:{str(e.get('error') or '')[:120]}"
                for e in err_list[:5]
            ) or status
            entry = (
                f"## {stamp} · `{pid}`\n\n"
                f"- **goal:** {goal[:200]}\n"
                f"- **status:** {status}\n"
                f"- **errors:** {err_summary}\n"
                f"- **file:** [[{pid}]] / `{path.name}`\n"
                f"- **lessons:** {((lessons or '')[:400]).replace(chr(10), ' ')}\n\n"
            )
            with _path_lock(fail_path):
                prev = fail_path.read_text(encoding="utf-8") if fail_path.exists() else (
                    "# Sophia Code failure ledger (OKF process logs)\n\n"
                    "Append-only. Recalled into new agent runs so the same error is not repeated.\n"
                    "candidateOnly: true · canClaimAGI: false\n\n"
                )
                # Avoid exact duplicate consecutive entries for same pid+error
                if pid not in prev[-800:] or err_summary[:80] not in prev[-800:]:
                    _atomic_write_text(fail_path, prev.rstrip() + "\n\n" + entry)

        return path
    except OSError:
        return None


def _iter_process_log_files(root: Path, dirs: "list[Path] | None" = None) -> list[Path]:
    """Run_*.md pages to consider. ``dirs=None`` preserves the original behaviour
    (every ``process_log_paths(root)`` directory plus the global ``~/.sophia`` log,
    de-duplicated by filename). Passing an explicit ``dirs`` list scans ONLY those
    directories with NO implicit global append — this is what lets
    ``failure_recall_system_extra`` draw a LOCAL-only recall pass (so a local failed
    lesson is guaranteed a slot instead of losing a score/id tiebreak against
    hundreds of global pages) and a separate global pass that is placed at the
    truncatable tail."""
    files: list[Path] = []
    seen: set[str] = set()
    if dirs is None:
        scan = list(process_log_paths(root))
        home = Path.home() / ".sophia" / "okf-process-log"
        if home not in scan:
            scan = scan + [home]
    else:
        scan = list(dirs)
    for d in scan:
        if not d.exists():
            continue
        for path in sorted(d.glob("run_*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
            key = path.name
            if key in seen:
                continue
            seen.add(key)
            files.append(path)
    return files


def _score_log_for_goal(text: str, goal: str, *, prefer_failed: bool) -> float:
    """Higher = more relevant to inject for this goal."""
    low = text.lower()
    g = (goal or "").lower()
    score = 0.0
    # status weight
    if prefer_failed:
        if "status: failed" in low or "status: error" in low or "status: blocked" in low:
            score += 5.0
        if "## errors" in low and "_(none)_" not in low.split("## errors", 1)[-1][:200]:
            score += 3.0
        if "model_error" in low or "tool_error" in low:
            score += 2.0
    # token overlap
    tokens = [t for t in re.split(r"[^a-z0-9_]+", g) if len(t) >= 3]
    for tok in tokens[:24]:
        if tok in low:
            score += 1.0
    return score


def recall_process_logs(
    root: Path,
    goal: str,
    *,
    limit: int = 5,
    prefer_failed: bool = True,
    max_chars: int = 3500,
    dirs: "list[Path] | None" = None,
) -> list[dict[str, Any]]:
    """Return top process-log summaries relevant to ``goal`` (failed first).

    ``dirs`` restricts the scan to the given directories (no implicit global
    ``~/.sophia`` append); ``None`` keeps the original mixed local+global scan.
    ``failure_recall_system_extra`` uses a local-only pass plus a separate global
    pass so a local lesson cannot lose a score/id tiebreak against the global log."""
    scored: list[tuple[float, dict[str, Any]]] = []
    for path in _iter_process_log_files(root, dirs=dirs)[:80]:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        sc = _score_log_for_goal(text, goal, prefer_failed=prefer_failed)
        if sc <= 0 and prefer_failed:
            # still keep recent failed pages even with no token overlap
            if "status: failed" not in text.lower() and "status: error" not in text.lower():
                continue
            sc = 1.0
        # extract snippets
        status = "unknown"
        for line in text.splitlines()[:40]:
            if line.startswith("status:"):
                status = line.split(":", 1)[1].strip()
                break
        lessons = ""
        if "## Lessons" in text:
            lessons = text.split("## Lessons", 1)[1]
            for stop in ("## ", "---"):
                if stop in lessons[2:]:
                    lessons = lessons.split(stop, 1)[0]
            lessons = lessons.strip()[:800]
        errors = ""
        if "## Errors" in text:
            errors = text.split("## Errors", 1)[1]
            for stop in ("## ",):
                if stop in errors[2:]:
                    errors = errors.split(stop, 1)[0]
            errors = errors.strip()[:600]
        scored.append((sc, {
            "path": str(path),
            "id": path.stem,
            "status": status,
            "lessons": lessons,
            "errors": errors,
            "score": sc,
        }))
    scored.sort(key=lambda x: (-x[0], x[1]["id"]))
    return [item for _, item in scored[:limit]]


def failure_recall_system_extra(
    root: Path,
    goal: str,
    *,
    limit: int = 5,
    max_chars: int = 3200,
) -> str:
    """System-extra block: prior failures so the model avoids repeating them.

    Ordering invariant (the self-correction channel): PROJECT-LOCAL recall is always
    placed at the HEAD and GLOBAL (cross-project ``~/.sophia``) recall at the TAIL, so
    the final ``text[:max_chars]`` tail-truncation eats global content first and a
    local lesson is never the part that is dropped. Local recall pages are drawn from
    a LOCAL-only pass (unopposed by the large global log) so a local failed lesson is
    guaranteed a slot instead of losing a ``(-score, id)`` tiebreak against hundreds of
    global pages -- the clog that silently starved the channel under global saturation.
    ``SOPHIA_RECALL_MAX_CHARS`` overrides the cap; the default prompt size for existing
    runs is unchanged. candidateOnly; canClaimAGI:false."""
    import os as _os
    try:
        max_chars = int(_os.environ.get("SOPHIA_RECALL_MAX_CHARS", max_chars))
    except (TypeError, ValueError):
        # Keep the caller-provided/default cap when the optional override is invalid.
        pass
    home = Path.home() / ".sophia" / "okf-process-log"
    local_dirs = [p for p in process_log_paths(root) if p != home]
    global_dirs = [home]

    def _read_failures(d: Path) -> "str | None":
        fail = d / "FAILURES.md"
        if not fail.exists():
            return None
        try:
            raw = fail.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        parts = raw.split("\n## ")
        recent = parts[-6:] if len(parts) > 1 else parts
        snippet = ("\n## ".join(recent)).strip()[:1800]
        return snippet or None

    blocks: list[str] = []
    # Block 1: recent failure ledger -- local first (head-preserved); global only as fallback.
    for d in local_dirs + global_dirs:
        snip = _read_failures(d)
        if snip:
            blocks.append("### Failure ledger (recent)\n" + snip)
            break

    def _fmt(recalls: "list[dict[str, Any]]", label: str) -> "str | None":
        if not recalls:
            return None
        lines = [label]
        for r in recalls:
            lines.append(
                f"- **{r['id']}** status={r['status']} score={r['score']:.1f}\n"
                f"  Errors: {(r.get('errors') or '_(n/a)_').replace(chr(10), ' ')[:280]}\n"
                f"  Lessons: {(r.get('lessons') or '_(n/a)_').replace(chr(10), ' ')[:320]}"
            )
        return "\n".join(lines)

    # Block 2: recall pages -- local-only pass gets the primary slots (guaranteed),
    # global fills only the remainder and sits at the tail (truncated first).
    recalls_local = recall_process_logs(root, goal, limit=limit, prefer_failed=True, dirs=local_dirs)
    remain = max(0, limit - len(recalls_local))
    recalls_global = (
        recall_process_logs(root, goal, limit=remain, prefer_failed=True, dirs=global_dirs)
        if remain else []
    )
    bl = _fmt(recalls_local, "### Prior process logs (do not repeat these failures)")
    if bl:
        blocks.append(bl)
    bg = _fmt(recalls_global, "### Prior process logs (other projects - lower priority)")
    if bg:
        blocks.append(bg)

    if not blocks:
        return ""

    header = (
        "\n## Anti-repeat memory (OKF process logs)\n"
        "The following are **real prior failures** from this project. "
        "You MUST avoid repeating the same failing tool args/commands. "
        "If a listed failure matches your plan, change approach or fix the cause first.\n"
        "canClaimAGI:false.\n\n"
    )
    body = "\n\n".join(blocks)
    text = header + body
    return text[:max_chars]


def summarize_steps(steps: list[dict[str, Any]]) -> str:
    """One-line-per-step action list for process logs."""
    if not steps:
        return "_(no tools)_"
    lines: list[str] = []
    for step in steps:
        name = step.get("tool") or "?"
        ok = "x" if step.get("ok") else " "
        err = step.get("error")
        note = (err or step.get("output") or "")[:80]
        note = " ".join(str(note).split())
        lines.append(f"- [{ok}] {name} — {note}" if note else f"- [{ok}] {name}")
    return "\n".join(lines)


__all__ = [
    "CORE_RUNTIME_POLICY",
    "TOOL_PROTOCOL",
    "SHORT_TOOL_PROTOCOL",
    "ULTRA_EFFORTS",
    "compile_system_prompt",
    "build_system_prompt",
    "normalize_effort",
    "is_ultramode",
    "effort_system_extra",
    "load_ultramode_profile",
    "resolve_ultramode_profile_path",
    "process_log_id",
    "resolve_process_log_dir",
    "process_log_paths",
    "render_process_page",
    "write_process_log",
    "summarize_steps",
    "extract_errors_from_steps",
    "lessons_from_run",
    "format_errors_section",
    "recall_process_logs",
    "failure_recall_system_extra",
]
