# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Sophia-native slash command catalog for Sophia Code.

Authoritative registry of command names, argument contracts, client handlers,
help metadata, and product-profile defaults. Used by:

- terminal REPL (autocomplete + dispatch)
- Sophia Code TUI (composer suggestions + dispatch)
- docs / `/help`

Catalog presence never implies execution. Every command carries a separate
``client_execution`` record for the TUI and terminal clients, including the
route and concrete handler key when an action is implemented.

candidateOnly; canClaimAGI:false.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from typing import Any, Iterable, Mapping

from agent.edition import (
    EDITION_IDS,
    EDITION_OSS,
    EDITION_UNAVAILABLE_TEMPLATE,
    FULL_ONLY_COMMANDS,
    active_edition,
    command_in_edition,
    edition_unavailable_message,
    editions_for_command,
)


EXECUTION_STATES = frozenset(
    {"implemented_local", "prompt", "info", "unsupported"}
)
CLIENT_IDS = ("tui", "terminal")


@dataclass(frozen=True)
class SlashArgument:
    """One positional token (or the free-form remainder) in a slash command."""

    name: str
    value_type: str = "string"
    required: bool = False
    choices: tuple[str, ...] = ()
    rest: bool = False


@dataclass(frozen=True)
class SlashArgumentSchema:
    """JSON-friendly argument contract used by help and catalog consumers."""

    usage: str
    min_args: int = 0
    max_args: int | None = 0
    positionals: tuple[SlashArgument, ...] = ()
    examples: tuple[str, ...] = ()
    custom_parser: bool = False


@dataclass(frozen=True)
class ClientExecution:
    """What one concrete client does with a catalog command."""

    execution_state: str
    handler: str = ""
    handler_names: tuple[str, ...] = ()
    note: str = ""

    def to_public(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SlashCommand:
    name: str                 # without leading slash, e.g. "model"
    description: str
    category: str
    kind: str = "local"       # local | prompt
    support_state: str = "supported"  # supported | unsupported
    aliases: tuple[str, ...] = ()
    deprecated_aliases: tuple[str, ...] = ()
    badges: tuple[str, ...] = ()
    hint: str = ""            # usage snippet
    # When true, executing this command collapses the chat panel so the result
    # surface gets the available terminal space.
    collapse_chat: bool = True
    # Prompt-command body template; `{args}` is replaced with rest of line.
    prompt_template: str = ""
    # Alias target (without slash) when kind == "alias"
    target: str = ""
    # Empty means "compute from agent.edition.FULL_ONLY_COMMANDS".
    editions: tuple[str, ...] = ()

    @property
    def slash(self) -> str:
        return f"/{self.name}"

    def matches(self, prefix: str) -> bool:
        """True if prefix (with or without leading /) matches name or an alias."""
        p = (prefix or "").strip().casefold()
        if p.startswith("/"):
            p = p[1:]
        if not p:
            return True
        # Match command name or alias by prefix; also match full slash form.
        names = (self.name,) + self.aliases
        return any(n.startswith(p) or f"/{n}".startswith("/" + p) for n in names)

    @property
    def execution_state(self) -> str:
        """Terminal-client state used by the Python REPL's legacy dispatcher."""
        return client_execution_for(self, "terminal").execution_state

    def to_public(self) -> dict[str, Any]:
        d = asdict(self)
        d["slash"] = self.slash
        arguments = argument_schema_for(self)
        executions = {client: client_execution_for(self, client).to_public()
                      for client in CLIENT_IDS}
        tui_execution = executions["tui"]
        d["arguments"] = asdict(arguments)
        d["client_execution"] = executions
        # Compatibility field for existing TUI consumers. New code should use
        # client_execution.tui.execution_state instead.
        d["execution_state"] = tui_execution["execution_state"]
        d["help"] = help_metadata_for(self, client="tui")
        d["editions"] = list(editions_for_command(self.name, self.editions))
        return d


def unsupported_message(name: str, *, client: str = "terminal") -> str:
    """Stable, non-deceptive output for catalog entries this client cannot run."""
    return f"/{name} is listed but is not implemented in this {client} yet. No action was taken."


# --------------------------------------------------------------------------- #
# Catalog — Sophia Code surface
# --------------------------------------------------------------------------- #

_COMMANDS: tuple[SlashCommand, ...] = (
    # ── Session & context ────────────────────────────────────────────────
    SlashCommand("clear", "Clear the screen (keep memory)", "session",
                 aliases=("cls",), collapse_chat=False),
    SlashCommand("compact", "Fold older turns to shrink the context sent to the model",
                 "session", hint="/compact"),
    SlashCommand("resume", "Browse past sessions (topic · turns · recency) and restore one", "session",
                 hint="/resume [name]", collapse_chat=False),
    SlashCommand("continue", "Resume the most recent session instantly (no picker)", "session",
                 hint="/continue", collapse_chat=False),
    SlashCommand("session", "Manage sessions (list / switch)", "session",
                 aliases=("sessions",), hint="/session [list|<name>]", collapse_chat=False),
    SlashCommand("new", "Start a new named session", "session",
                 hint="/new [name]", collapse_chat=False),
    SlashCommand("fork", "Fork the current session into a new local session", "session",
                 hint="/fork <name>", collapse_chat=False),
    SlashCommand("checkpoint", "Create a durable local checkpoint for the current session", "session",
                 hint="/checkpoint [label]", collapse_chat=False),
    # File-level checkpoints (agent_tools.list_checkpoints/undo_last_checkpoint/
    # restore_checkpoint via code_bridge.py's checkpoints/checkpoint_undo/
    # checkpoint_restore commands) are a DIFFERENT recovery layer than
    # /checkpoint above: that snapshots the chat transcript, these snapshot the
    # actual bytes of every file an approved write_file/edit_file touched.
    SlashCommand("checkpoints", "List this session's captured file checkpoints (path, kind, id)", "session",
                 hint="/checkpoints", collapse_chat=False),
    SlashCommand("undo", "Revert the most recently captured file checkpoint(s)", "session",
                 hint="/undo [n]", collapse_chat=False),
    SlashCommand("reset", "Clear current session memory", "session",
                 collapse_chat=False),
    SlashCommand("export", "Export conversation to a file", "session",
                 hint="/export <path>", kind="local", collapse_chat=False),
    SlashCommand("archive", "Archive the current session locally", "session",
                 hint="/archive", collapse_chat=False),
    SlashCommand("summary", "Summarize the current session", "session",
                 kind="prompt",
                 prompt_template="Summarize this session's work so far for an operator handoff. "
                                 "Include goals, changes, open risks. Args: {args}"),
    SlashCommand("context", "Show context / workspace status", "session"),
    SlashCommand("harness", "Show continual-harness version and explicit lesson count", "session",
                 kind="local", hint="/harness", collapse_chat=False),
    SlashCommand(
        "refine",
        "Propose a pending harness lesson or preview relevant applied lessons",
        "session",
        kind="local",
        hint="/refine propose <lesson> :: <evidence> | /refine preview <query>",
        badges=("candidate",),
        collapse_chat=False,
    ),
    SlashCommand("rename", "Rename the current session", "session",
                 hint="/rename <name>", collapse_chat=False),
    SlashCommand("share", "Share session (print path / OKF pointer)", "session"),
    SlashCommand("copy", "Copy last reply via OSC 52 [/copy reply|prompt|last|N]",
                 "session", hint="/copy [reply|prompt|last|N]", collapse_chat=False),
    SlashCommand("tag", "Tag the current session", "session",
                 hint="/tag <label[,label...]>", collapse_chat=False),

    # ── Model & sampling ─────────────────────────────────────────────────
    SlashCommand("model", "Switch the active model or manage custom endpoints", "settings",
                 hint="/model [spec|connections]", collapse_chat=False),
    SlashCommand(
        "runtime",
        "Select Sophia-native execution or the optional Prime Agent external backend",
        "settings",
        hint="/runtime sophia|prime|status",
        collapse_chat=False,
    ),
    SlashCommand(
        "fallback-model",
        "Configure confirmed local recovery for non-substantive primary refusals",
        "settings",
        aliases=("semantic-fallback",),
        hint="/fallback-model status|off|return-main on|off|<local-provider:model>",
        collapse_chat=False,
    ),
    SlashCommand(
        "conscience",
        "Choose off, advisory report, hard-floor, or strict final-answer gating",
        "settings",
        aliases=("provenance",),
        hint="/conscience off|report|floor|strict|status",
        collapse_chat=False,
    ),
    SlashCommand("mode", "Response mode presets", "settings",
                 hint="/mode logical|precise|balanced|creative|divergent|all", collapse_chat=False),
    SlashCommand("effort", "Adjust response effort (high/ultra run the creative→logical deep-think debate)", "settings",
                 hint="/effort low|medium|high|ultramode (aliases: min, med, max, ultra)", collapse_chat=False),
    SlashCommand("ultramode", "Activate Sophia ultramode: explicit high-rigor deep-think effort", "settings",
                 aliases=("ultra",), hint="/ultramode (alias: /ultra)", collapse_chat=False),
    SlashCommand("deepmode", "Toggle deep-mode sampling (high-exploration temperature/top-p/top-k), independent of effort", "settings",
                 hint="/deepmode on|off|status", collapse_chat=False),
    SlashCommand("fast", "Use concise responses with low effort", "settings",
                 collapse_chat=False),
    SlashCommand("brief", "Use concise response formatting", "settings",
                 collapse_chat=False),
    SlashCommand("thinking", "Show/log provider reasoning", "settings",
                 hint="/thinking hidden|summary|stream|full", collapse_chat=False),
    SlashCommand("sampling", "Temperature / top-p / top-k", "settings",
                 collapse_chat=False),
    SlashCommand("temperature", "Set temperature", "settings",
                 hint="/temperature min|mean|max|<n>", collapse_chat=False),
    SlashCommand("top-p", "Set top-p", "settings", hint="/top-p <0..1>", collapse_chat=False),
    SlashCommand("top-k", "Set top-k", "settings", hint="/top-k <n>", collapse_chat=False),
    SlashCommand("theme", "Color theme", "settings",
                 hint="/theme dark|light|mono", collapse_chat=False),
    SlashCommand("color", "Toggle color output", "settings", collapse_chat=False),
    SlashCommand("output-style", "Response formatting style", "settings",
                 aliases=("response-style", "style"),
                 hint="/output-style adaptive|concise|explanatory|structured",
                 collapse_chat=False),
    SlashCommand("vim", "Toggle vim-style input (hint)", "settings",
                 collapse_chat=False),
    SlashCommand("keybindings", "Keybinding help", "settings", collapse_chat=False),
    SlashCommand("image-provider", "Select the configured image provider", "settings",
                 aliases=("images",), hint="/image-provider [name]", collapse_chat=False),
    SlashCommand("image", "Generate an image with the configured provider after confirmation",
                 "settings", hint="/image [output-path ::] <prompt>", collapse_chat=False),
    SlashCommand("notifications", "Configure terminal completion notifications", "settings",
                 hint="/notifications on|off|status", collapse_chat=False),
    SlashCommand("accessibility", "Show terminal accessibility and capability status", "settings",
                 hint="/accessibility", collapse_chat=False),
    SlashCommand("permissions", "Tool permission mode", "settings",
                 aliases=("permission",),
                 hint="/permissions auto|full|manual|readonly", collapse_chat=False),
    SlashCommand("config", "Runtime / backend config", "settings",
                 hint="/config status|recommend|install-best", collapse_chat=False),
    # The entry point to the local-LLM operations view (LocalEnginePanel):
    # installed/running engines, model counts, and the active LoRA adapter, all
    # from a fresh runtime_config.local_runtime_report()/adapter_status() probe.
    SlashCommand("local", "Open the local-model/engine operations panel and refresh its runtime report",
                 "settings", aliases=("engines",), hint="/local (alias: /engines)", collapse_chat=False),
    SlashCommand("privacy-settings", "Privacy / no-overclaim reminders", "settings",
                 collapse_chat=False),
    SlashCommand("statusline", "Show / customize status line", "settings",
                 collapse_chat=False),

    # ── Git & quality (prompt → agent) ───────────────────────────────────
    # /diff remains an agent prompt so it can summarize findings, but native
    # read-only Git functions now make it usable in readonly mode without
    # routing an inspection through Bash.
    SlashCommand("diff", "Show Git diff with read-only native Git inspection", "git", kind="prompt",
                 prompt_template="Use native git_status and git_diff (not Bash) to inspect the "
                                 "current Git state and summarize what changed for an operator. "
                                 "Do not modify files or Git state. Args: {args}"),
    SlashCommand("commit", "AI-assisted git commit", "git", kind="prompt",
                 prompt_template="Create a git commit for the current changes. "
                                 "Inspect the diff, draft a concise message, stage relevant files, "
                                 "and commit. Do not push unless asked. {args}"),
    SlashCommand("commit-push-pr", "Commit, push, and open a PR", "git", kind="prompt",
                 prompt_template="Commit current changes, push the branch, and open a pull request "
                                 "with a clear title/body. {args}"),
    SlashCommand("branch", "Create or switch branches", "git", kind="prompt",
                 prompt_template="Help with git branches: {args}"),
    SlashCommand("pr-comments", "View / address PR comments", "git",
                 aliases=("pr_comments",), kind="prompt",
                 prompt_template="Review and address open PR review comments. {args}"),
    # Restores exactly the one file a specific checkpoint recorded — the same
    # agent_tools.restore_checkpoint kernel path /undo uses, targeted by id
    # instead of "the most recent one". Not a workspace-wide git-style rewind;
    # the TUI says so explicitly before the confirmation step.
    SlashCommand("rewind", "Restore one file to its state before a specific recorded checkpoint", "git",
                 hint="/rewind [checkpoint-id]", collapse_chat=False),
    SlashCommand("review", "AI code review of current changes", "quality", kind="prompt",
                 prompt_template="Review the current git changes for correctness, security, and "
                                 "maintainability. Be specific with file:line references. {args}"),
    SlashCommand("security-review", "Security-focused review", "quality", kind="prompt",
                 prompt_template="Security review of pending changes: injection, auth, secrets, "
                                 "path traversal, unsafe deserialization. {args}"),
    SlashCommand("advisor", "Architecture / design advice", "quality", kind="prompt",
                 prompt_template="Advise on architecture and design for: {args}"),
    SlashCommand("bughunter", "Find potential bugs", "quality", kind="prompt",
                 prompt_template="Hunt for bugs in the relevant code. Focus on real failure modes. {args}"),

    # ── Plan / agents / tasks ────────────────────────────────────────────
    # /plan and /plan-mode drive the identical approval-gated local flow (a
    # bounded plan text is parsed into steps via lib/planModel.ts, the operator
    # approves or rejects before anything executes); kept as two independent
    # catalog entries — rather than one aliasing the other — because the
    # terminal REPL's own help table (agent/cli.py) reads each command's own
    # `.slash` form, which an alias would not produce.
    SlashCommand("plan", "Enter an approval-gated local Sophia execution plan before any changes run "
                         "(same flow as /plan-mode)",
                 "agents", hint="/plan <task>", badges=("candidate",), collapse_chat=False),
    SlashCommand("plan-mode", "Create an approval-gated local Sophia execution plan "
                              "(same flow as /plan; experimental)",
                 "agents", hint="/plan-mode <task>", badges=("candidate",),
                 collapse_chat=False),
    SlashCommand("ultraplan", "Detailed multi-step execution plan", "agents", kind="prompt",
                 prompt_template="Produce a thorough execution plan with risks, files, and verify steps. "
                                 "Task: {args}"),
    SlashCommand("agents", "Legacy shortcut for a fixed A2A agent total", "agents",
                 hint="/agents [n]", collapse_chat=False),
    SlashCommand("a2a", "A2A harness: Main dispatches N sub-agents (auto N), then verifies+synthesizes", "agents",
                 hint="/a2a on|off|status|auto|2|3|…", collapse_chat=False),
    SlashCommand(
        "workflow",
        "Dynamic cloud workflow: Main chooses bounded multi-stage parallel A2A patterns",
        "agents",
        hint="/workflow off|auto|on|status|resume <run-id>",
        badges=("candidate", "cloud"),
        collapse_chat=False,
    ),
    SlashCommand(
        "agi-workflow",
        "Route each AGI controller node through solo execution or a bounded cloud workflow",
        "agents",
        hint="/agi-workflow off|auto|on|status",
        badges=("candidate", "cloud"),
        collapse_chat=False,
    ),
    SlashCommand(
        "arc",
        "Read-only ARC2/ARC3 campaign status and plan views with candidate-only and submission-gate receipts",
        "agents",
        hint="/arc status|plan arc2|arc3|copy status|copy plan <contest>|close",
        badges=("candidate", "submission-gated"),
        collapse_chat=False,
    ),
    SlashCommand(
        "terminals",
        "Choose whether A2A sub-agents run embedded or in supervised terminal PTYs",
        "agents",
        hint="/terminals off|auto|splits|windows|headless|status",
        badges=("candidate",),
        collapse_chat=False,
    ),
    SlashCommand(
        "agi",
        "Control the adaptive, bounded, resumable AGI-shaped planner/worker/verifier loop",
        "agents",
        hint="/agi on|off|status|profile|route|model|pause|stop|approve|resume|start",
        badges=("candidate",),
        collapse_chat=False,
    ),
    SlashCommand("tasks", "List workflow tasks and snapshots", "agents",
                 hint="/tasks [runId]", collapse_chat=False),
    SlashCommand("workflows", "List workflow trees and task snapshots", "agents",
                 hint="/workflows [runId]", collapse_chat=False),
    SlashCommand("queue", "Queue a prompt to run after the active run", "agents",
                 hint="/queue <prompt>", collapse_chat=False),
    SlashCommand("steer", "Steer the active run at its next safe boundary", "agents",
                 hint="/steer <instruction>", collapse_chat=False),
    SlashCommand("bench", "Benchmark models head-to-head (knowledge corpus or tool-use)", "agents",
                 kind="local", hint="/bench [model1,model2,...]", collapse_chat=False),
    # /tbench runs terminal-bench 2.1 tasks through the agent loop against the
    # current model (oMLX by default) with OKF auto-recording + fix-capture, so
    # errors are recorded as memory and recalled to avoid repeating them.
    # collapse_chat=False keeps the per-task progress bubbles in the transcript.
    SlashCommand("tbench",
                 "Run terminal-bench 2.1 tasks through the agent loop (oMLX) with auto-learning",
                 "agents", kind="local",
                 hint="/tbench [list|smoke|subset N|task <name>]", collapse_chat=False),
    # The three harness-diagnostic benchmarks: each surfaces a different harness
    # weakness signal (terminal-bench = long-horizon env; GAIA = per-level gradient;
    # tau-bench = pass^k reliability). All candidateOnly; canClaimAGI:false.
    SlashCommand("gaia",
                 "GAIA benchmark — per-level harness diagnostic (single-step → long-horizon)",
                 "agents", kind="local",
                 hint="/gaia [level 1|2|3] [n PER_LEVEL]", collapse_chat=False),
    SlashCommand("taubench",
                 "τ-bench reliability (pass^k) — measures harness flakiness, not peak score",
                 "agents", kind="local",
                 hint="/taubench [retail|airline] [k TRIALS] [n TASKS]", collapse_chat=False),

    # ── Memory / MCP / skills ────────────────────────────────────────────
    SlashCommand("memory", "Personal memory status, ontology, and review queue", "memory",
                 hint="/memory [status|review]", collapse_chat=False),
    SlashCommand("recall", "Search local personal memory without sending a model request", "memory",
                 hint="/recall <query>", collapse_chat=False),
    SlashCommand("receipt", "Show the latest personal-harness selection and policy receipt", "memory",
                 hint="/receipt [latest]", collapse_chat=False),
    SlashCommand("prompt", "Show the latest compiled system-prompt module receipt", "memory",
                 hint="/prompt [modules]", collapse_chat=False),
    SlashCommand("artifact", "List reusable artifacts staged for this session", "memory",
                 hint="/artifact [list]", collapse_chat=False),
    SlashCommand("add-dir", "Add a directory to context", "memory",
                 hint="/add-dir <path>", collapse_chat=False, support_state="unsupported"),
    SlashCommand("files", "List files in the workspace root", "memory"),
    SlashCommand("mcp", "MCP server status / hints", "mcp", collapse_chat=False),
    SlashCommand("connectors", "Show personal-harness connector read/write policy", "mcp",
                 collapse_chat=False),
    SlashCommand("tools", "Show native tool availability and permission classes for this Sophia runtime",
                 "mcp", collapse_chat=False),
    SlashCommand(
        "shell",
        "Run a workspace shell command through the kernel bash tool (alias: /bash, !cmd)",
        "mcp",
        aliases=("bash",),
        hint="/shell <command>",
        collapse_chat=False,
    ),
    SlashCommand(
        "plugin",
        "Inspect, enable, select, and safely supervise Sophia plugins",
        "mcp",
        aliases=("plugins",),
        hint="/plugin [list|inspect|permissions|enable|disable|profile|workflow|skill|agent|runtime|safe-mode|lock|catalog|compat]",
        collapse_chat=False,
    ),
    SlashCommand(
        "reload-plugins",
        "Re-scan manifests and rewrite the user-owned operational plugin lock",
        "mcp",
        collapse_chat=False,
    ),
    SlashCommand("skills", "List available skills", "mcp", collapse_chat=False),
    SlashCommand("hooks", "Show loaded PreToolUse/PostToolUse/Stop hooks and recent dispatch outcomes",
                 "mcp", collapse_chat=False),

    # ── Diagnostics ──────────────────────────────────────────────────────
    SlashCommand("doctor", "Environment diagnostics", "diagnostics"),
    SlashCommand("debug", "Diagnostic debug information", "diagnostics",
                 hint="/debug", collapse_chat=False),
    SlashCommand("status", "System + session status line", "diagnostics",
                 collapse_chat=False),
    SlashCommand("stats", "Session statistics", "diagnostics"),
    SlashCommand("cost", "Token / cost estimate", "diagnostics", collapse_chat=False),
    SlashCommand("version", "Show Sophia Code version", "diagnostics",
                 collapse_chat=False),
    SlashCommand("usage", "API usage notes", "diagnostics", collapse_chat=False),
    SlashCommand("env", "Relevant environment variables", "diagnostics"),
    SlashCommand("logic", "Visible-reasoning logic judge", "diagnostics",
                 kind="prompt", hint="/logic off|basic|strict", collapse_chat=False,
                 prompt_template=("Run the deterministic logic-error verifier (agent/logic_verifier.py) "
                                  "on the current reasoning trace and report a per-step logic_verdict. "
                                  "candidateOnly; canClaimAGI:false. Args: {args}")),

    # ── Auth / install / IDE ─────────────────────────────────────────────
    SlashCommand(
        "login",
        "Sign in to a subscription provider (Grok/xAI or Codex) via its official CLI browser login",
        "auth",
        hint="/login [status|grok|codex]",
        collapse_chat=False,
    ),
    SlashCommand(
        "setup",
        "Choose the LLM provider for this device and sign in if that provider uses a browser login",
        "auth",
        hint="/setup",
        collapse_chat=False,
    ),
    SlashCommand("logout", "Clear session auth hints", "auth", collapse_chat=False, support_state="unsupported"),
    SlashCommand("init", "Initialize project agent docs", "setup", kind="prompt",
                 prompt_template="Initialize or refresh AGENTS.md and supported project guidance "
                                 "for this repo. Keep canClaimAGI:false. {args}"),
    SlashCommand("install", "Install / refresh the `sophia` CLI on PATH", "setup",
                 collapse_chat=False, support_state="unsupported"),
    SlashCommand("update", "Pull latest main, rebuild, and reinstall the sophia CLI",
                 "setup", kind="local", hint="/update [/path/to/repo]",
                 collapse_chat=False),
    SlashCommand("upgrade", "Upgrade hints", "setup", collapse_chat=False),
    SlashCommand("onboarding", "First-run tips", "setup", collapse_chat=False),
    SlashCommand("terminal-setup", "Terminal setup tips", "setup",
                 aliases=("terminalSetup",), collapse_chat=False),
    SlashCommand("desktop", "Open Sophia Code macOS / web shell", "ide",
                 collapse_chat=False, support_state="unsupported"),
    SlashCommand("ide", "IDE bridge hints", "ide", collapse_chat=False),
    SlashCommand("bridge", "Code bridge status", "ide", collapse_chat=False),
    SlashCommand("mobile", "Mobile handoff (not available)", "ide",
                 support_state="unsupported", collapse_chat=False),
    SlashCommand("sandbox-toggle", "Toggle sandbox mode", "ide",
                 aliases=("sandbox",), collapse_chat=False, support_state="unsupported"),

    # ── Meta ─────────────────────────────────────────────────────────────
    SlashCommand("help", "Show help and command list", "meta",
                 collapse_chat=False),
    SlashCommand("exit", "Exit Sophia Code", "meta",
                 aliases=("quit",), collapse_chat=False),
    SlashCommand("feedback", "How to file feedback", "meta", collapse_chat=False),
    SlashCommand("release-notes", "Point to CHANGELOG", "meta", collapse_chat=False),
    SlashCommand("insights", "Codebase insights", "meta", kind="prompt",
                 prompt_template="Give high-signal codebase insights for an operator: structure, "
                                 "hot paths, risks. {args}"),
    SlashCommand("issue", "Draft a GitHub issue", "meta", kind="prompt",
                 prompt_template="Draft a clear GitHub issue for: {args}"),

    # Sophia-only (keep)
    SlashCommand("okf", "Write / show OKF process log location", "sophia",
                 collapse_chat=False),
    # Read-only OKF belief-graph projection (sophia.graph_projection.v1). The TUI
    # executes this via a raw-token handler in App.tsx (before resolve()); its
    # client_execution metadata names that route explicitly.
    SlashCommand("graph", "Open the read-only OKF provenance-graph audit panel (candidateOnly)",
                 "sophia", hint="/graph [entity]", badges=("candidate",), collapse_chat=True),
    # Autonomous goal-continuation (run_goal_loop): keeps self-generating
    # continuation prompts (restating the goal) until the goal is achieved,
    # confidently unachievable, or a safety bound trips. The TUI executes this
    # via a raw-token handler in App.tsx (like /graph); the catalog records it
    # as implemented_local only for that client.
    SlashCommand("goal", "Autonomous mode: keep working until the goal is achieved or confidently unachievable (bounded; candidateOnly)",
                 "sophia", hint="/goal <what you want achieved>", badges=("candidate",),
                 collapse_chat=True),
    SlashCommand("panel", "Show, hide, or expand Goal, Workflow, Agents, To-do, AGI, and live Flow views",
                 "sophia",
                 hint="/panel [show|hide|goal|workflow|agents|todo|agi|flow|details|compact|status]",
                 collapse_chat=False),
    SlashCommand("contract", "Show the compact Sophia runtime policy and ultramode boundary",
                 "sophia",
                 badges=("sophia-native",), collapse_chat=False),
    SlashCommand("thesis", "Thesis discussion prompt", "sophia", kind="prompt",
                 hint="/thesis <question>",
                 prompt_template="Discuss the repository thesis as a hypothesis, with evidence and open gaps. {args}"),
    SlashCommand("brainstorm", "Brainstorm prompt using creative mode", "sophia", kind="prompt",
                 hint="/brainstorm <question>",
                 prompt_template="Brainstorm candidate ideas for: {args}. Label speculation and do not claim validation."),
)


CATEGORY_METADATA: tuple[dict[str, Any], ...] = (
    {"id": "session", "label": "Sessions", "description": "Conversation lifecycle and context."},
    {"id": "settings", "label": "Model & control", "description": "Models, effort, style, and permissions."},
    {"id": "git", "label": "Git", "description": "Repository operations delegated to the agent."},
    {"id": "quality", "label": "Review", "description": "Code review, security, and architecture prompts."},
    {"id": "agents", "label": "Agents & eval", "description": "Lanes, workflows, and candidate-only diagnostics."},
    {"id": "memory", "label": "Memory", "description": "Workspace files and durable memory surfaces."},
    {"id": "mcp", "label": "Tools & skills", "description": "MCP, skills, plugins, and hooks."},
    {"id": "diagnostics", "label": "Diagnostics", "description": "Runtime status and troubleshooting."},
    {"id": "auth", "label": "Access", "description": "Provider authentication guidance."},
    {"id": "setup", "label": "Setup", "description": "Installation, updates, and onboarding."},
    {"id": "ide", "label": "Surfaces", "description": "Terminal, IDE, desktop, and sandbox surfaces."},
    {"id": "meta", "label": "Help", "description": "Help, exit, feedback, and issue drafting."},
    {"id": "sophia", "label": "Sophia", "description": "Wisdom Gate, OKF, goals, and the runtime policy."},
)
CATEGORY_BY_ID = {row["id"]: row for row in CATEGORY_METADATA}


def _arg(
    name: str,
    *,
    value_type: str = "string",
    required: bool = False,
    choices: tuple[str, ...] = (),
    rest: bool = False,
) -> SlashArgument:
    return SlashArgument(
        name=name,
        value_type=value_type,
        required=required,
        choices=choices,
        rest=rest,
    )


def _schema(
    usage: str,
    *positionals: SlashArgument,
    min_args: int = 0,
    max_args: int | None = None,
    examples: tuple[str, ...] = (),
    custom_parser: bool = False,
) -> SlashArgumentSchema:
    return SlashArgumentSchema(
        usage=usage,
        min_args=min_args,
        max_args=max_args,
        positionals=tuple(positionals),
        examples=examples,
        custom_parser=custom_parser,
    )


_ARGUMENT_SCHEMAS: dict[str, SlashArgumentSchema] = {
    "resume": _schema("/resume [session]", _arg("session", value_type="session"), max_args=1,
                      examples=("/resume tui-default",)),
    "session": _schema("/session [list|select <name>|<name>]",
                       _arg("action_or_session", value_type="session", rest=True),
                       examples=("/session list", "/session tui-default"), custom_parser=True),
    "new": _schema("/new [name]", _arg("name", value_type="session"), max_args=1),
    "export": _schema("/export [path]", _arg("path", value_type="path", rest=True), max_args=1),
    "rename": _schema("/rename <name>", _arg("name", value_type="session", required=True, rest=True),
                      min_args=1, max_args=1),
    "copy": _schema("/copy [reply|prompt|last|N]",
                    _arg("target", value_type="message_selector"), max_args=1,
                    examples=("/copy reply", "/copy 3")),
    "tag": _schema("/tag <label>", _arg("label", required=True, rest=True), min_args=1, max_args=1),
    "refine": _schema(
        "/refine propose <lesson> :: <evidence> | /refine preview <query>",
        _arg("action", required=True, rest=True),
        min_args=1,
        max_args=1,
        examples=(
            "/refine propose Run focused tests before claiming success :: run receipt 123",
            "/refine preview focused tests",
        ),
        custom_parser=True,
    ),
    "model": _schema("/model [spec]", _arg("spec", value_type="model", rest=True), max_args=1),
    "runtime": _schema(
        "/runtime [sophia|prime|status]",
        _arg("runtime", choices=("sophia", "prime", "status")),
        max_args=1,
    ),
    "fallback-model": _schema(
        "/fallback-model [status|off|return-main on|off|<local-provider:model>]",
        _arg("action_or_model", value_type="model", rest=True),
        max_args=1,
        examples=(
            "/fallback-model ollama:qwen3:30b-a3b",
            "/fallback-model return-main off",
            "/fallback-model off",
        ),
        custom_parser=True,
    ),
    "conscience": _schema(
        "/conscience [off|report|floor|strict|status]",
        _arg("mode", choices=("off", "report", "floor", "strict", "status")),
        max_args=1,
        examples=(
            "/conscience status",
            "/conscience report",
            "/conscience off",
            "/conscience floor",
            "/conscience strict",
        ),
    ),
    "mode": _schema("/mode [logical|precise|balanced|creative|divergent|all]",
                    _arg("mode", choices=("logical", "precise", "balanced", "creative", "divergent", "all")),
                    max_args=1),
    "effort": _schema("/effort [low|medium|high|ultramode]",
                      _arg("effort", choices=("low", "medium", "high", "ultramode")),
                      max_args=1),
    "deepmode": _schema("/deepmode [on|off|status]",
                        _arg("state", choices=("on", "off", "status")), max_args=1),
    "thinking": _schema("/thinking [on|off|status|show|capture|log]",
                        _arg("action", choices=("on", "off", "status", "show", "capture", "log")),
                        _arg("value"), max_args=2, custom_parser=True),
    "temperature": _schema("/temperature [min|mean|max|number]",
                           _arg("temperature", value_type="number"), max_args=1),
    "top-p": _schema("/top-p [0..1]", _arg("top_p", value_type="number"), max_args=1),
    "top-k": _schema("/top-k [integer]", _arg("top_k", value_type="integer"), max_args=1),
    "theme": _schema("/theme [dark|light|mono]",
                     _arg("theme", choices=("dark", "light", "mono")), max_args=1),
    "output-style": _schema("/output-style [adaptive|concise|explanatory|structured]",
                            _arg("style", choices=("adaptive", "concise", "explanatory", "structured")),
                            max_args=1),
    "permissions": _schema("/permissions [auto|full|manual|readonly]",
                           _arg("permission", choices=("auto", "full", "manual", "readonly")), max_args=1),
    "shell": _schema(
        "/shell <command>",
        _arg("command", required=True, rest=True),
        min_args=1,
        max_args=1,
        examples=("/shell git status", "/bash ls -la", "!pwd"),
    ),
    "config": _schema("/config [status|recommend|install-best]",
                      _arg("action", choices=("status", "recommend", "install-best")), max_args=1),
    "memory": _schema(
        "/memory [status|review]",
        _arg("action", choices=("status", "review")),
        max_args=1,
    ),
    "recall": _schema(
        "/recall <query>",
        _arg("query", required=True, rest=True),
        min_args=1,
        max_args=1,
    ),
    "receipt": _schema(
        "/receipt [latest]",
        _arg("action", choices=("latest",)),
        max_args=1,
    ),
    "prompt": _schema(
        "/prompt [modules]",
        _arg("action", choices=("modules",)),
        max_args=1,
    ),
    "artifact": _schema(
        "/artifact [list]",
        _arg("action", choices=("list",)),
        max_args=1,
    ),
    "connectors": _schema("/connectors", max_args=0),
    "tools": _schema("/tools", max_args=0),
    "undo": _schema("/undo [n]", _arg("n", value_type="integer"), max_args=1,
                    examples=("/undo", "/undo 3")),
    "rewind": _schema("/rewind [checkpoint-id]", _arg("checkpoint_id"), max_args=1,
                      examples=("/rewind cp-1a2b3c4d5e",)),
    "plan": _schema("/plan <task>", _arg("task", required=True, rest=True), min_args=1, max_args=1,
                    examples=("/plan add rate limiting to the API",)),
    "plan-mode": _schema("/plan-mode <task>", _arg("task", required=True, rest=True), min_args=1, max_args=1,
                         examples=("/plan-mode add rate limiting to the API",)),
    "diff": _schema("/diff [scope]", _arg("scope", rest=True), max_args=1),
    "agents": _schema("/agents [count]", _arg("count", value_type="integer"), max_args=1),
    "a2a": _schema("/a2a on|off|status|auto|2|3|…",
                   _arg("mode", rest=True), max_args=1,
                   examples=("/a2a on", "/a2a auto", "/a2a status", "/a2a off")),
    "workflow": _schema(
        "/workflow off|auto|on|status|resume <run-id>",
        _arg("mode", choices=("off", "auto", "on", "status", "resume")),
        _arg("run_id", value_type="run_id"),
        max_args=2,
        custom_parser=True,
        examples=(
            "/workflow auto",
            "/workflow on",
            "/workflow status",
            "/workflow off",
            "/workflow resume <run-id>",
        ),
    ),
    "agi-workflow": _schema(
        "/agi-workflow off|auto|on|status",
        _arg("mode", choices=("off", "auto", "on", "status")),
        max_args=1,
        examples=(
            "/agi-workflow auto",
            "/agi-workflow on",
            "/agi-workflow status",
            "/agi-workflow off",
        ),
    ),
    "arc": _schema(
        "/arc [status|plan arc2|arc3|copy status|copy plan <contest>|close|help]",
        _arg("read_only_action", rest=True),
        max_args=1,
        examples=(
            "/arc status",
            "/arc plan arc2",
            "/arc plan arc3",
            "/arc copy status",
        ),
        custom_parser=True,
    ),
    "terminals": _schema(
        "/terminals off|auto|splits|windows|headless|status",
        _arg(
            "mode",
            choices=("off", "auto", "splits", "windows", "headless", "status"),
        ),
        max_args=1,
        examples=("/terminals auto", "/terminals headless", "/terminals off"),
    ),
    "agi": _schema(
        "/agi on|off|status|profile <name>|route <auto|fast|deliberative|critical>|model <role> <model>|pause|stop|approve [action-id]|resume [run-id]|start <goal>",
        _arg("options", rest=True),
        max_args=1,
        custom_parser=True,
        examples=(
            "/agi on",
            "/agi route auto",
            "/agi route critical",
            "/agi profile conservative",
            "/agi model verifier openai:gpt-5",
            "/agi pause",
            "/agi approve",
            "/agi resume",
        ),
    ),
    "tasks": _schema("/tasks [runId]", _arg("run_id", value_type="run_id"), max_args=1),
    "workflows": _schema("/workflows [runId]", _arg("run_id", value_type="run_id"), max_args=1),
    "bench": _schema("/bench [knowledge|tool-use|trigger] [model1,model2,...]",
                     _arg("mode", choices=("knowledge", "tool-use", "trigger")),
                     _arg("models", value_type="model", rest=True),
                     examples=("/bench tool-use omlx,grok",), custom_parser=True),
    "tbench": _schema("/tbench [docker] [list|smoke|subset N|task <name>] [model]",
                      _arg("options", rest=True), examples=("/tbench smoke", "/tbench docker task regex-log"),
                      custom_parser=True),
    "gaia": _schema("/gaia [level 1|2|3] [n N] [model]",
                    _arg("options", rest=True), custom_parser=True),
    "taubench": _schema("/taubench [retail|airline] [k TRIALS] [n TASKS] [model]",
                        _arg("options", rest=True), custom_parser=True),
    "add-dir": _schema("/add-dir <path>", _arg("path", value_type="path", required=True, rest=True),
                       min_args=1, max_args=1),
    "plugin": _schema(
        "/plugin [list|inspect <id>|permissions <id>|enable <id> [--approve]|disable <id>|profile use <id/profile>|workflow use <id/workflow>|skill use <id/skill>|agent use <id/agent>|runtime use <id/runtime>|runtime status [id/runtime]|safe-mode on|off|lock export <path>|lock import <path>|catalog status|catalog search [query] [filters]|catalog inspect <id> [filters]|catalog select <id> [filters]|compat ...]",
        _arg("action", rest=True),
        max_args=1,
        custom_parser=True,
        examples=(
            "/plugin list",
            "/plugin inspect sophia-review-pack",
            "/plugin enable sophia-review-pack",
            "/plugin profile use sophia-review-pack/production-beta",
            "/plugin workflow use sophia-review-pack/bounded-review",
            "/plugin permissions deepseek-harness",
            "/plugin enable deepseek-harness --approve",
            "/plugin runtime use deepseek-harness/headless",
            "/plugin safe-mode on",
            "/plugin lock export \"release locks/plugins.json\"",
            "/plugin compat transactions",
            "/plugin catalog status",
            "/plugin catalog search review --capability review.code --protocol sophia.plugin/v1",
            "/plugin catalog inspect reviewer --platform darwin --architecture arm64",
            "/plugin catalog select reviewer --protocol sophia.plugin/v1",
        ),
    ),
    "logic": _schema("/logic [off|basic|strict]",
                     _arg("mode", choices=("off", "basic", "strict")), max_args=1),
    "login": _schema(
        "/login [status|grok|codex]",
        _arg("provider", choices=("status", "grok", "codex")),
        max_args=1,
        examples=("/login", "/login grok", "/login status"),
    ),
    "setup": _schema("/setup", max_args=0),
    "update": _schema("/update [repo-path]", _arg("repo_path", value_type="path", rest=True), max_args=1),
    "graph": _schema("/graph [entity]", _arg("entity", rest=True), max_args=1),
    "panel": _schema(
        "/panel [show|hide|goal|workflow|agents|todo|agi|flow|details|compact|status]",
        _arg(
            "view",
            choices=(
                "show",
                "hide",
                "goal",
                "workflow",
                "agents",
                "todo",
                "agi",
                "flow",
                "details",
                "compact",
                "status",
            ),
        ),
        max_args=1,
    ),
    "goal": _schema("/goal <goal>", _arg("goal", required=True, rest=True),
                    min_args=1, max_args=1, examples=("/goal make the failing tests pass",)),
    "thesis": _schema("/thesis [question]", _arg("question", rest=True), max_args=1),
    "brainstorm": _schema("/brainstorm [question]", _arg("question", rest=True), max_args=1),
}


_PROMPT_ARGUMENT_NAMES: dict[str, str] = {
    "summary": "focus",
    "commit": "instructions",
    "commit-push-pr": "instructions",
    "branch": "branch_request",
    "pr-comments": "scope",
    "review": "scope",
    "security-review": "scope",
    "advisor": "question",
    "bughunter": "scope",
    "ultraplan": "task",
    "init": "instructions",
    "insights": "scope",
    "issue": "issue",
}


def argument_schema_for(command: SlashCommand | str) -> SlashArgumentSchema:
    """Return a complete schema; every current command has one."""
    cmd = command if isinstance(command, SlashCommand) else _CANONICAL_COMMANDS[command]
    if cmd.name in _ARGUMENT_SCHEMAS:
        return _ARGUMENT_SCHEMAS[cmd.name]
    if cmd.kind == "prompt":
        arg_name = _PROMPT_ARGUMENT_NAMES.get(cmd.name, "request")
        return _schema(
            f"/{cmd.name} [{arg_name}]",
            _arg(arg_name, rest=True),
            max_args=1,
        )
    return SlashArgumentSchema(usage=cmd.hint or cmd.slash)


_TUI_RUN_LOCAL = frozenset({
    "help", "clear", "exit", "status", "harness", "refine", "statusline", "theme", "model", "runtime",
    "login", "setup",
    "fallback-model", "conscience",
    "effort", "ultramode", "deepmode", "mode", "permissions", "version",
    "doctor", "cost", "stats", "usage", "okf", "resume", "continue", "session",
    "tasks", "workflows", "debug", "agents", "a2a", "workflow", "arc", "terminals", "agi", "compact", "copy", "bench",
    "tbench", "gaia", "taubench", "update", "output-style", "contract",
    "new", "fork", "checkpoint", "reset", "export", "archive", "rename",
    "share", "tag", "context", "thinking", "fast", "brief", "color", "vim",
    "keybindings", "image-provider", "notifications",
    "accessibility", "config", "memory", "recall", "receipt", "prompt", "artifact",
    "mcp", "connectors", "plugin", "reload-plugins", "skills", "bridge", "queue", "steer",
    "tools",
    "shell",
    "plan-mode", "plan",
    "image",
    "local", "undo", "checkpoints", "rewind", "hooks",
})
_TUI_HANDLER_NAMES: dict[str, tuple[str, ...]] = {
    "exit": ("exit", "quit"),
    "ultramode": ("ultramode", "ultra"),
    "permissions": ("permissions", "permission"),
    "shell": ("shell", "bash"),
    "output-style": ("output-style", "response-style", "style"),
    "contract": ("contract",),
}
# Backward-compatible public name for older tests and integrations that used
# the pre-v3 catalog's flat TUI handler set. New consumers should prefer
# client_handler_registry("tui"), which preserves handler routing explicitly.
IMPLEMENTED_LOCAL_NAMES = frozenset(
    _TUI_RUN_LOCAL
    | {
        handler_name
        for handler_names in _TUI_HANDLER_NAMES.values()
        for handler_name in handler_names
    }
)
_TUI_RAW_LOCAL = frozenset({"graph", "goal", "panel", "agi-workflow"})
_TERMINAL_LOCAL = frozenset({
    "exit", "reset", "help", "mode", "ultramode", "effort", "config",
    "sampling", "temperature", "top-p", "top-k", "logic", "new", "resume",
    "thinking", "model",
})
_TERMINAL_HANDLER_NAMES: dict[str, tuple[str, ...]] = {
    "exit": ("exit", "quit"),
    "ultramode": ("ultramode", "ultra"),
}
CLIENT_REGISTRY_METADATA: dict[str, dict[str, Any]] = {
    "tui": {
        "label": "Sophia Code TUI",
        "retired_handlers": {},
    },
    "terminal": {
        "label": "Sophia terminal REPL",
        "retired_handlers": {},
    },
}


def client_execution_for(command: SlashCommand | str, client: str) -> ClientExecution:
    """Resolve command execution without inferring support from catalog presence."""
    if client not in CLIENT_IDS:
        raise KeyError(f"unknown slash client: {client}")
    cmd = command if isinstance(command, SlashCommand) else _CANONICAL_COMMANDS[command]
    if cmd.support_state == "unsupported":
        return ClientExecution(
            "unsupported",
            note=f"Not implemented in the {CLIENT_REGISTRY_METADATA[client]['label']}; no action is taken.",
        )
    if cmd.kind == "prompt":
        handler = "expandPromptCommand" if client == "tui" else "agent.cli.prompt_template"
        return ClientExecution(
            "prompt",
            handler=handler,
            handler_names=(cmd.name,),
            note="Expands to an agent goal and runs under the active tool-permission policy.",
        )
    if client == "tui":
        if cmd.name in _TUI_RAW_LOCAL:
            return ClientExecution(
                "implemented_local",
                handler="rawToken",
                handler_names=(cmd.name,),
                note="Handled directly by the TUI before generic slash resolution.",
            )
        if cmd.name in _TUI_RUN_LOCAL:
            return ClientExecution(
                "implemented_local",
                handler="runLocalSlash",
                handler_names=_TUI_HANDLER_NAMES.get(cmd.name, (cmd.name,)),
                note="Handled locally by the TUI; it does not invent an agent goal.",
            )
        return ClientExecution(
            "info",
            note="Information only in this TUI build; no state change is claimed.",
        )
    if cmd.name in _TERMINAL_LOCAL:
        return ClientExecution(
            "implemented_local",
            handler="agent.cli._repl",
            handler_names=_TERMINAL_HANDLER_NAMES.get(cmd.name, (cmd.name,)),
            note="Handled directly by the terminal REPL.",
        )
    return ClientExecution(
        "info",
        note="Information only in the terminal REPL; no state change is claimed.",
    )


def help_metadata_for(command: SlashCommand | str, *, client: str) -> dict[str, Any]:
    """Honest, render-ready help metadata for one client."""
    cmd = command if isinstance(command, SlashCommand) else _CANONICAL_COMMANDS[command]
    execution = client_execution_for(cmd, client)
    badge = {
        "implemented_local": "local",
        "prompt": "agent",
        "info": "info",
        "unsupported": "unavailable",
    }[execution.execution_state]
    badges = [badge, *cmd.badges]
    if cmd.deprecated_aliases:
        badges.append("legacy-alias")
    category = CATEGORY_BY_ID[cmd.category]
    return {
        "usage": argument_schema_for(cmd).usage,
        "category_id": cmd.category,
        "category_label": category["label"],
        "badges": list(dict.fromkeys(badges)),
        "availability": execution.execution_state,
        "note": execution.note,
        "deprecated_aliases": list(cmd.deprecated_aliases),
    }


def client_handler_registry(client: str) -> dict[str, set[str]]:
    """Declared concrete handler keys for parity checks."""
    registry: dict[str, set[str]] = {}
    for cmd in _COMMANDS:
        execution = client_execution_for(cmd, client)
        if execution.execution_state != "implemented_local" or not execution.handler:
            continue
        registry.setdefault(execution.handler, set()).update(execution.handler_names)
    return registry


def client_registry_parity(
    client: str,
    observed: Mapping[str, Iterable[str]],
) -> dict[str, dict[str, list[str]]]:
    """Compare source-observed handler names with catalog declarations."""
    declared = client_handler_registry(client)
    retired = CLIENT_REGISTRY_METADATA[client].get("retired_handlers", {})
    handlers = set(declared) | set(observed)
    out: dict[str, dict[str, list[str]]] = {}
    for handler in sorted(handlers):
        expected = set(declared.get(handler, set()))
        actual = set(observed.get(handler, ()))
        allowed_retired = set(retired.get(handler, ()))
        missing = sorted(expected - actual)
        extra = sorted(actual - expected - allowed_retired)
        out[handler] = {"missing": missing, "extra": extra}
    return out


PRODUCT_DEFAULTS: dict[str, Any] = {
    "schema": "sophia.product-defaults.v1",
    "runtime_binding": (
        "Declarative product metadata only. CLI flags, layered config, and live "
        "auto-detection remain authoritative until a launcher binds a profile."
    ),
    "profile_order": ["this-mac", "public"],
    "profiles": {
        "this-mac": {
            "label": "This Mac",
            "audience": "owner-local",
            "model": {"mode": "fixed", "value": "omlx"},
            "authority": {
                "mode": "fixed",
                "value": "full-authority",
                "runtime_permission": "auto",
            },
            "dispatch": {"mode": "fixed", "value": "workflow"},
            "image_generation": {"mode": "fixed", "value": "Grok CLI"},
            "configurable": True,
        },
        "public": {
            "label": "Public install",
            "audience": "distribution",
            "model": {"mode": "auto-detect", "value": None},
            "authority": {"mode": "configurable", "value": None},
            "dispatch": {"mode": "configurable", "value": None},
            "image_generation": {"mode": "auto-detect-or-configure", "value": None},
            "configurable": True,
        },
    },
    "candidateOnly": True,
    "canClaimAGI": False,
    "edition_ids": list(EDITION_IDS),
    "defaultEdition": "full",
    "editionUnavailableTemplate": EDITION_UNAVAILABLE_TEMPLATE,
}


_CANONICAL_COMMANDS: dict[str, SlashCommand] = {cmd.name: cmd for cmd in _COMMANDS}


def all_commands() -> tuple[SlashCommand, ...]:
    return _COMMANDS


def visible_commands(*, edition: str | None = None) -> tuple[SlashCommand, ...]:
    """Commands shown to one edition. Default is the process ``SOPHIA_EDITION``."""
    wanted = edition if edition is not None else active_edition()
    return tuple(
        cmd
        for cmd in _COMMANDS
        if command_in_edition(cmd.name, cmd.editions, wanted)
    )


def by_name() -> dict[str, SlashCommand]:
    out: dict[str, SlashCommand] = {}
    for cmd in _COMMANDS:
        out[cmd.name.lower()] = cmd
        for a in cmd.aliases:
            out[a.lower()] = cmd
    return out


def help_rows(*, client: str = "terminal") -> list[tuple[str, str, str]]:
    """Rows for one client's help table: (slash, description, honest metadata)."""
    rows: list[tuple[str, str, str]] = []
    for cmd in visible_commands():
        help_meta = help_metadata_for(cmd, client=client)
        badges = " ".join(f"[{badge}]" for badge in help_meta["badges"])
        extra = f"{badges} {help_meta['usage']}".strip()
        rows.append((cmd.slash, cmd.description, extra))
    return rows


def suggest(prefix: str, *, limit: int = 12) -> list[SlashCommand]:
    """Progressively match a typed prefix (e.g. ``/m`` → model, mode, mcp…)."""
    p = (prefix or "").strip()
    if not p.startswith("/") and p != "":
        # Allow bare "mod" while already in slash mode
        p = "/" + p
    visible = visible_commands()
    if p == "":
        return list(visible)[:limit]
    # Only command name portion before first space
    head = p.split(None, 1)[0]
    matches = [c for c in visible if c.matches(head)]
    # Prefer exact name prefix length ranking: shorter names first, then alpha
    head_body = (head[1:] if head.startswith("/") else head).casefold()

    def rank(c: SlashCommand) -> tuple[int, int, int, int, str]:
        names = tuple(n.casefold() for n in (c.name,) + c.aliases)
        exact = 0 if head_body == c.name.casefold() else 1
        alias_exact = 0 if head_body in names[1:] else 1
        starts = 0 if any(n.startswith(head_body) for n in names) else 1
        distance = min((len(n) for n in names if n.startswith(head_body)), default=len(c.name))
        return (exact, alias_exact, starts, distance, c.name.casefold())

    matches.sort(key=rank)
    return matches[:limit]


def resolve(line: str) -> tuple[SlashCommand | None, str, str]:
    """Parse a user line into (command, name, args).

    Returns (None, "", "") when the line is not a slash command.
    """
    text = (line or "").strip()
    if not text.startswith("/"):
        return None, "", ""
    # "/model zai" → name=model, args=zai
    body = text[1:]
    if not body:
        return None, "", ""
    name, _, args = body.partition(" ")
    name = name.strip().casefold()
    # allow /mode-all style? keep simple
    cmd = by_name().get(name)
    if cmd is None:
        return None, name, args.strip()
    if not command_in_edition(cmd.name, cmd.editions):
        return None, cmd.name, args.strip()
    # unwrap alias target for dispatch metadata (same object already)
    return cmd, cmd.name, args.strip()


def complete_token(token: str) -> list[str]:
    """Return slash completions for readline (full `/name` forms)."""
    matches = suggest(token if token.startswith("/") else "/" + token, limit=40)
    return [c.slash for c in matches]


def validate_catalog() -> list[str]:
    """Return deterministic catalog errors; an empty list means export-safe."""
    errors: list[str] = []
    seen: dict[str, str] = {}
    for cmd in _COMMANDS:
        if cmd.name != cmd.name.casefold():
            errors.append(f"/{cmd.name}: canonical names must be lowercase")
        for entry in (cmd.name, *cmd.aliases):
            key = entry.casefold()
            owner = seen.get(key)
            if owner and owner != cmd.name:
                errors.append(f"/{cmd.name}: name or alias {entry!r} collides with /{owner}")
            seen[key] = cmd.name
        if not set(cmd.deprecated_aliases).issubset(set(cmd.aliases)):
            errors.append(f"/{cmd.name}: deprecated aliases must also be aliases")
        if cmd.category not in CATEGORY_BY_ID:
            errors.append(f"/{cmd.name}: unknown category {cmd.category!r}")
        schema = argument_schema_for(cmd)
        if not schema.usage.startswith(cmd.slash):
            errors.append(f"/{cmd.name}: usage must start with {cmd.slash}")
        if schema.max_args is not None and schema.max_args < schema.min_args:
            errors.append(f"/{cmd.name}: max_args is lower than min_args")
        for client in CLIENT_IDS:
            execution = client_execution_for(cmd, client)
            if execution.execution_state not in EXECUTION_STATES:
                errors.append(
                    f"/{cmd.name}: invalid {client} execution state "
                    f"{execution.execution_state!r}"
                )
            if execution.execution_state == "implemented_local":
                if not execution.handler or not execution.handler_names:
                    errors.append(f"/{cmd.name}: {client} local execution needs handler metadata")
            elif execution.handler_names and execution.execution_state != "prompt":
                errors.append(
                    f"/{cmd.name}: {client} non-local execution must not claim local handler names"
                )
        eds = editions_for_command(cmd.name, cmd.editions)
        if not eds or set(eds) - set(EDITION_IDS):
            errors.append(f"/{cmd.name}: editions must be a non-empty subset of {EDITION_IDS}")
        if cmd.name in FULL_ONLY_COMMANDS and EDITION_OSS in eds:
            errors.append(f"/{cmd.name}: full-only command cannot be tagged oss")
    if PRODUCT_DEFAULTS.get("canClaimAGI") is not False:
        errors.append("product defaults must preserve canClaimAGI:false")
    default_edition = PRODUCT_DEFAULTS.get("defaultEdition")
    if default_edition not in set(PRODUCT_DEFAULTS.get("edition_ids") or ()):
        errors.append("product defaults must name a known defaultEdition")
    profiles = PRODUCT_DEFAULTS.get("profiles", {})
    if set(PRODUCT_DEFAULTS.get("profile_order", ())) != set(profiles):
        errors.append("product profile_order must name every profile exactly once")
    return errors


def public_catalog() -> dict[str, Any]:
    """JSON-serializable authoritative catalog for all clients."""
    errors = validate_catalog()
    if errors:
        raise ValueError("invalid slash catalog:\n- " + "\n- ".join(errors))
    cats: dict[str, list[dict[str, Any]]] = {}
    commands = [c.to_public() for c in _COMMANDS]
    for row in commands:
        cats.setdefault(row["category"], []).append(row)
    clients = json.loads(json.dumps(CLIENT_REGISTRY_METADATA))
    payload = {
        "source": "sophia-code-native",
        "commands": commands,
        "categories": cats,
        "category_metadata": list(CATEGORY_METADATA),
        "clients": clients,
        "product_defaults": PRODUCT_DEFAULTS,
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"version": 3, "hash": digest, **payload, "canClaimAGI": False}


def public_catalog_for_edition(edition: str) -> dict[str, Any]:
    """Full catalog restricted to one edition, with that edition baked as default."""
    if edition not in EDITION_IDS:
        raise ValueError(f"unknown edition {edition!r}")
    cat = public_catalog()
    commands = [row for row in cat["commands"] if edition in row.get("editions", list(EDITION_IDS))]
    categories: dict[str, list[dict[str, Any]]] = {}
    for row in commands:
        categories.setdefault(row["category"], []).append(row)
    defaults = dict(cat["product_defaults"])
    defaults["defaultEdition"] = edition
    payload = {
        "source": cat["source"],
        "commands": commands,
        "categories": categories,
        "category_metadata": cat["category_metadata"],
        "clients": cat["clients"],
        "product_defaults": defaults,
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"version": 3, "hash": digest, **payload, "canClaimAGI": False}


def format_suggestion_block(matches: Iterable[SlashCommand], *, selected: int = 0,
                            width: int = 56) -> str:
    """Render a multi-line suggestion popup for the terminal."""
    rows = list(matches)
    if not rows:
        return "  (no matching commands)"
    lines: list[str] = []
    for i, cmd in enumerate(rows):
        mark = "›" if i == selected else " "
        badge = help_metadata_for(cmd, client="terminal")["badges"][0]
        desc = cmd.description
        if len(desc) > width - 26:
            desc = desc[: width - 29] + "…"
        lines.append(f"  {mark} {cmd.slash:<16} [{badge:<11}] {desc}")
    return "\n".join(lines)


__all__ = [
    "SlashCommand",
    "SlashArgument",
    "SlashArgumentSchema",
    "ClientExecution",
    "CATEGORY_METADATA",
    "PRODUCT_DEFAULTS",
    "IMPLEMENTED_LOCAL_NAMES",
    "all_commands",
    "by_name",
    "argument_schema_for",
    "client_execution_for",
    "client_handler_registry",
    "client_registry_parity",
    "help_metadata_for",
    "help_rows",
    "suggest",
    "resolve",
    "complete_token",
    "validate_catalog",
    "public_catalog",
    "format_suggestion_block",
    "unsupported_message",
    "visible_commands",
    "edition_unavailable_message",
    "public_catalog_for_edition",
]
