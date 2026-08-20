"""Bounded, model-planned dynamic workflows over parallel A2A batches.

``/workflow`` is deliberately a controller protocol rather than a catalogue of
hard-coded pipelines. Main may select, combine, or invent a workflow shape for
the operator's task, then emit one parallel batch at a time. The bridge owns the
barrier, bounds, role/skill resolution, and final delivery gate.

This module contains only the structured protocol and prompt construction. The
actual workers are still the existing supervised A2A implementation in
``agent.code_bridge``.

``candidateOnly: true`` and ``canClaimAGI: false`` — orchestration plumbing
only, never evidence of general capability.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Iterable, Mapping

WORKFLOW_MODES = frozenset({"off", "auto", "on"})
WORKFLOW_ACTIONS = frozenset(
    {"dispatch", "finish", "skip", "awaiting_input", "fail"}
)
WORKFLOW_STAGE_KINDS = frozenset(
    {
        "general",
        "specialist",
        "recovery",
        "refinement",
        "implementation_follow_up",
        "critic",
        "tiebreak",
    }
)

DEFAULT_MAX_STAGES = 6
DEFAULT_MAX_AGENTS = 24
MAX_STAGES_SAFETY = 12
MAX_AGENTS_SAFETY = 64
MAX_TASKS_PER_STAGE = 8
MIN_PARALLEL_TASKS = 2
WORKFLOW_REVIEW_LEDGER_MAX_CHARS = 24_000
WORKFLOW_FINAL_LEDGER_MAX_CHARS = 96_000
WORKFLOW_DECISION_REPAIR_SOURCE_MAX_CHARS = 12_000
WORKFLOW_CRITIC_CONTEXT_MAX_CHARS = 48_000

DECISION_SENTINEL = "WORKFLOW_DECISION:"
KNOWN_PLUGIN_AUDIT_TEMPLATE_ID = "sophia-plugin-platform-beta-audit-v1"
KNOWN_TUI_PARALLEL_BARRIER_SMOKE_TEMPLATE_ID = (
    "sophia.tui.parallel-barrier-smoke.v1"
)
KNOWN_DIRECT_TEST_EXECUTION_TEMPLATE_ID = (
    "sophia.tui.direct-test-execution.v1"
)
DIRECT_TEST_EXECUTION_COVERAGE_KEYS: tuple[str, ...] = (
    "bash-exitcode-control",
    "workflow-result-authority",
)
TUI_DIRECT_TEST_COMMANDS: tuple[str, ...] = (
    "python3 tests/test_bash_exitcode.py",
    "python3 tests/test_workflow_result_authority.py",
)

SUGGESTED_PATTERNS: tuple[tuple[str, str], ...] = (
    (
        "fan-out-and-synthesize",
        "independent investigations or implementations followed by a barrier synthesis",
    ),
    (
        "adversarial-verification",
        "builders make claims and separate reviewers try to refute them against a rubric",
    ),
    (
        "classify-and-act",
        "classifiers partition cases, then specialists act on each class",
    ),
    (
        "generate-and-filter",
        "parallel generators create candidates, then a later stage scores and filters them",
    ),
    (
        "tournament",
        "candidate solutions compete through explicit comparison rounds",
    ),
    (
        "loop-until-done",
        "bounded inspect-act-verify correction stages continue until acceptance criteria pass",
    ),
)

PLUGIN_AUDIT_COVERAGE_KEYS: tuple[str, ...] = (
    "manifest-schema",
    "trust-permission",
    "registry-lock",
    "jsonrpc-supervisor",
    "deepseek-adapter",
    "codebridge",
    "review-profile",
    "tui-wiring",
)

TUI_PARALLEL_BARRIER_COVERAGE_KEYS: tuple[str, ...] = (
    "backend-durability",
    "bridge-authority",
    "tui-graph-reducer",
    "test-evidence",
)
TUI_BARRIER_NAMED_TEST_COMMAND = "python tests/test_bash_exitcode.py"
# Grok CLI workers are provider-side inspectors. Keep this smoke's
# contracted scope inside GROK_CLI_WORKER_READ_ONLY_COMPATIBLE_TOOLS so a
# live grok 4-lane run does not abort with worker_tool_scope_unavailable.
TUI_READ_ONLY_DISPATCH_TOOLS: tuple[str, ...] = (
    "glob",
    "grep",
    "grep_runtime",
    "list_dir",
    "read_batch",
    "read_file",
    "read_runtime_file",
)
TUI_TEST_EVIDENCE_DISPATCH_TOOLS: tuple[str, ...] = (
    *TUI_READ_ONLY_DISPATCH_TOOLS,
    "bash",
)

_PLUGIN_AUDIT_COVERAGE_ALIASES: dict[str, str] = {
    "manifest": "manifest-schema",
    "manifest-and-schema": "manifest-schema",
    "manifest-schema": "manifest-schema",
    "plugin-manifest": "manifest-schema",
    "plugin-manifest-schema": "manifest-schema",
    "schema": "manifest-schema",
    "permission": "trust-permission",
    "permission-policy": "trust-permission",
    "trust": "trust-permission",
    "trust-and-permission": "trust-permission",
    "trust-permission": "trust-permission",
    "trust-permission-policy": "trust-permission",
    "lock": "registry-lock",
    "lock-state": "registry-lock",
    "plugin-registry": "registry-lock",
    "registry": "registry-lock",
    "registry-and-lock": "registry-lock",
    "registry-lock": "registry-lock",
    "json-rpc": "jsonrpc-supervisor",
    "json-rpc-supervisor": "jsonrpc-supervisor",
    "jsonrpc": "jsonrpc-supervisor",
    "jsonrpc-supervisor": "jsonrpc-supervisor",
    "rpc-supervisor": "jsonrpc-supervisor",
    "supervisor": "jsonrpc-supervisor",
    "deepseek": "deepseek-adapter",
    "deepseek-adapter": "deepseek-adapter",
    "deepseek-harness": "deepseek-adapter",
    "dsh": "deepseek-adapter",
    "dsh-adapter": "deepseek-adapter",
    "code-bridge": "codebridge",
    "codebridge": "codebridge",
    "review-pack": "review-profile",
    "review-profile": "review-profile",
    "sophia-review-pack": "review-profile",
    "bundled-review-profile": "review-profile",
    "tui": "tui-wiring",
    "tui-command": "tui-wiring",
    "tui-command-wiring": "tui-wiring",
    "tui-wiring": "tui-wiring",
}

_DIRECT_TEST_COVERAGE_ALIASES: dict[str, str] = {
    "bash-exitcode-control": "bash-exitcode-control",
    "named-test-exitcode": "bash-exitcode-control",
    "workflow-result-authority": "workflow-result-authority",
    "named-test-result-authority": "workflow-result-authority",
    "result-authority": "workflow-result-authority",
}
_DIRECT_TEST_COVERAGE_PHRASES: dict[str, tuple[str, ...]] = {
    "bash-exitcode-control": (
        "test_bash_exitcode.py",
        "bash-exitcode-control",
        "named-test-exitcode",
    ),
    "workflow-result-authority": (
        "test_workflow_result_authority.py",
        "workflow-result-authority",
        "named-test-result-authority",
    ),
}
_DIRECT_TEST_COVERAGE_LABELS: dict[str, str] = {
    "bash-exitcode-control": "named-test bash exitCode control",
    "workflow-result-authority": "named-test result authority",
}

_TUI_PARALLEL_BARRIER_COVERAGE_ALIASES: dict[str, str] = {
    "backend": "backend-durability",
    "backend-durability": "backend-durability",
    "backend-durable": "backend-durability",
    "durability": "backend-durability",
    "bridge": "bridge-authority",
    "bridge-authority": "bridge-authority",
    "bridge-policy": "bridge-authority",
    "authority": "bridge-authority",
    "tui-graph": "tui-graph-reducer",
    "tui-graph-reducer": "tui-graph-reducer",
    "graph-reducer": "tui-graph-reducer",
    "graph-and-reducer": "tui-graph-reducer",
    "reducer": "tui-graph-reducer",
    "test": "test-evidence",
    "tests": "test-evidence",
    "test-evidence": "test-evidence",
    "evidence": "test-evidence",
}

_PLUGIN_AUDIT_COVERAGE_PHRASES: dict[str, tuple[str, ...]] = {
    "manifest-schema": (
        "manifest/schema",
        "manifest and schema",
        "manifest schema",
        "plugin manifest",
    ),
    "trust-permission": (
        "trust/permission",
        "trust and permission",
        "trust permission",
        "permission policy",
    ),
    "registry-lock": (
        "registry/lock",
        "registry and lock",
        "registry lock",
        "lock state",
    ),
    "jsonrpc-supervisor": (
        "json-rpc supervisor",
        "json rpc supervisor",
        "jsonrpc supervisor",
        "rpc supervisor",
    ),
    "deepseek-adapter": (
        "deepseek adapter",
        "deepseek harness",
        "dsh adapter",
    ),
    "codebridge": (
        "codebridge",
        "code bridge",
    ),
    "review-profile": (
        "bundled review profile",
        "review profile",
        "sophia-review-pack",
        "sophia review pack",
    ),
    "tui-wiring": (
        "tui command wiring",
        "tui wiring",
        "command wiring",
    ),
}

_TUI_PARALLEL_BARRIER_COVERAGE_PHRASES: dict[str, tuple[str, ...]] = {
    "backend-durability": (
        "backend durability",
        "backend durable",
        "durability",
    ),
    "bridge-authority": (
        "bridge authority",
        "bridge policy",
        "authority",
    ),
    "tui-graph-reducer": (
        "tui graph and reducer",
        "tui graph/reducer",
        "graph and reducer",
        "graph/reducer",
        "graph reducer",
    ),
    "test-evidence": (
        "test evidence",
        "tests and evidence",
        "evidence lane",
    ),
}

_PLUGIN_AUDIT_COVERAGE_LABELS: dict[str, str] = {
    "manifest-schema": "plugin manifest and schema",
    "trust-permission": "trust and permission policy",
    "registry-lock": "registry and lock state",
    "jsonrpc-supervisor": "JSON-RPC supervisor",
    "deepseek-adapter": "DeepSeek adapter and harness",
    "codebridge": "CodeBridge plugin integration",
    "review-profile": "bundled review profile",
    "tui-wiring": "TUI command wiring",
}

_TUI_PARALLEL_BARRIER_COVERAGE_LABELS: dict[str, str] = {
    "backend-durability": "backend durability",
    "bridge-authority": "bridge authority",
    "tui-graph-reducer": "TUI graph and reducer",
    "test-evidence": "test evidence",
}

_WORKFLOW_COVERAGE_ALIASES = {
    **_PLUGIN_AUDIT_COVERAGE_ALIASES,
    **_TUI_PARALLEL_BARRIER_COVERAGE_ALIASES,
    **_DIRECT_TEST_COVERAGE_ALIASES,
}
_WORKFLOW_COVERAGE_PHRASES = {
    **_PLUGIN_AUDIT_COVERAGE_PHRASES,
    **_TUI_PARALLEL_BARRIER_COVERAGE_PHRASES,
    **_DIRECT_TEST_COVERAGE_PHRASES,
}
_WORKFLOW_COVERAGE_LABELS = {
    **_PLUGIN_AUDIT_COVERAGE_LABELS,
    **_TUI_PARALLEL_BARRIER_COVERAGE_LABELS,
    **_DIRECT_TEST_COVERAGE_LABELS,
}

_WORKFLOW_PATH_LINE_RE = re.compile(
    r"(?<![\w-])`?(?:[\w./-]+\.(?:py|ts|tsx|js|jsx|json|md|yml|yaml|toml|sh))`?"
    r"(?::\d+(?:-\d+)?|\s+\d+:\d+|\s+\d+\b)"
)
_WORKFLOW_LIMITATION_MARKERS = (
    "limitation",
    "limitations",
    "unknown",
    "not proven",
    "not run",
    "not executed",
    "gap",
    "caveat",
)
_WORKFLOW_FILES_MODIFIED_RE = re.compile(
    r"(?:files?_modified|files?\s+modified|modified\s+files?|no\s+files?\s+(?:were\s+)?modified)",
    re.IGNORECASE,
)


def normalize_workflow_mode(value: Any) -> str:
    """Return ``off``, ``auto``, or ``on`` with conservative aliases."""
    if isinstance(value, bool):
        return "on" if value else "off"
    raw = str(value or "off").strip().casefold().replace("_", "-")
    aliases = {
        "true": "on",
        "enabled": "on",
        "force": "on",
        "forced": "on",
        "false": "off",
        "disabled": "off",
        "decide": "auto",
        "automatic": "auto",
    }
    normalized = aliases.get(raw, raw)
    if normalized not in WORKFLOW_MODES:
        raise ValueError("workflowMode must be off, auto, or on")
    return normalized


def normalize_workflow_max_stages(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = DEFAULT_MAX_STAGES
    return max(1, min(MAX_STAGES_SAFETY, parsed))


def normalize_workflow_max_agents(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = DEFAULT_MAX_AGENTS
    return max(MIN_PARALLEL_TASKS, min(MAX_AGENTS_SAFETY, parsed))


@dataclass(frozen=True)
class WorkflowDecision:
    """One Main-controller routing decision."""

    action: str
    pattern: str = ""
    reason: str = ""
    stage_goal: str = ""
    tasks: tuple[str, ...] = ()
    task_contracts: tuple[dict[str, Any], ...] = ()
    completion_criteria: tuple[str, ...] = ()
    final_focus: str = ""
    requested_input: str = ""
    stage_kind: str = ""
    requires_critics: bool = False
    disagreements: tuple[str, ...] = ()
    reason_code: str = ""
    planned_stages: int | None = None
    raw: str = ""

    @property
    def selected(self) -> bool:
        return self.action == "dispatch" and len(self.tasks) >= MIN_PARALLEL_TASKS

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["plannedStages"] = payload.pop("planned_stages")
        payload["tasks"] = list(self.tasks)
        payload["task_contracts"] = list(self.task_contracts)
        payload["completion_criteria"] = list(self.completion_criteria)
        payload["disagreements"] = list(self.disagreements)
        payload["candidateOnly"] = True
        payload["canClaimAGI"] = False
        return payload


def bounded_workflow_planned_stages(
    value: Any,
    *,
    current_stage: int,
    max_stages: int,
    fallback: int | None = None,
) -> int:
    """Return a fail-bounded, revisable workflow stage-count estimate.

    The controller estimate is presentation/orchestration metadata rather than
    an execution entitlement: it may move up or down after a barrier, but it
    can never describe fewer stages than have already started or exceed the
    configured hard stage budget. Booleans and non-integral values are ignored
    rather than silently becoming stage counts.
    """

    maximum = max(1, int(max_stages))
    minimum = max(1, min(maximum, int(current_stage)))

    def exact_int(candidate: Any) -> int | None:
        if isinstance(candidate, bool):
            return None
        if isinstance(candidate, int):
            return candidate
        return None

    parsed = exact_int(value)
    if parsed is None:
        parsed = exact_int(fallback)
    if parsed is None:
        parsed = minimum
    return max(minimum, min(maximum, parsed))


def _coverage_slug(value: Any) -> str:
    raw = " ".join(str(value or "").strip().casefold().split())
    for token in ("/", "_", ":", "&", "+"):
        raw = raw.replace(token, "-")
    while "--" in raw:
        raw = raw.replace("--", "-")
    return raw.strip(" -")


def normalize_workflow_coverage_keys(value: Any) -> tuple[str, ...]:
    """Normalize explicit coverage metadata to canonical plugin-audit keys.

    Unknown values are ignored deliberately: coverage-based deduplication must
    fail open rather than silently treating two unrelated task scopes as equal.
    """
    if isinstance(value, str):
        raw_items: list[Any] = [value]
        for separator in (",", "\n", ";"):
            if separator in value:
                raw_items = value.replace("\n", ",").replace(";", ",").split(",")
                break
    elif isinstance(value, Iterable) and not isinstance(
        value, (bytes, bytearray, Mapping)
    ):
        raw_items = list(value)
    else:
        raw_items = [value]

    normalized: list[str] = []
    for item in raw_items:
        slug = _coverage_slug(item)
        key = _WORKFLOW_COVERAGE_ALIASES.get(slug)
        if key and key not in normalized:
            normalized.append(key)
    return tuple(normalized)


def workflow_task_coverage_keys(task_spec: Any) -> tuple[str, ...]:
    """Extract canonical coverage keys from a task/contract specification.

    Explicit ``coverageKeys`` metadata wins. For compatibility with older
    controller decisions, a conservative phrase match is used only when no
    explicit metadata is present.
    """
    explicit: Any = None
    text_parts: list[str] = []
    if isinstance(task_spec, Mapping):
        explicit = task_spec.get("coverageKeys")
        if explicit is None:
            explicit = task_spec.get("coverage_keys")
        for key in ("task", "goal", "subject", "name", "description"):
            value = task_spec.get(key)
            if value:
                text_parts.append(str(value))
    else:
        text_parts.append(str(task_spec or ""))

    normalized = normalize_workflow_coverage_keys(explicit)
    if normalized:
        return normalized

    text = " ".join(text_parts).casefold()
    inferred = [
        key
        for key in _WORKFLOW_COVERAGE_PHRASES
        if any(
            phrase in text
            for phrase in _WORKFLOW_COVERAGE_PHRASES[key]
        )
    ]
    return tuple(inferred)


_WORKER_REPORT_HEADER_RE = re.compile(
    r"(?im)^[ \t]*WORKER_REPORT[ \t]*:[ \t]*(?:[^\n]*)$"
)
_WORKER_REPORT_STATUS_RE = re.compile(
    r"(?im)^[ \t]*-[ \t]*status[ \t]*:[ \t]*"
    r"(complete|partial|blocked|failed)\b"
)
_WORKER_REPORT_NON_SUCCESS = frozenset({"partial", "blocked", "failed"})


def worker_report_status(text: Any) -> str | None:
    """Return the last structured WORKER_REPORT status, if present.

    Ordinary prose such as "the first check failed" is not task authority.
    Only a status field inside the final structured report envelope counts.
    """

    source = str(text or "")
    headers = list(_WORKER_REPORT_HEADER_RE.finditer(source))
    if not headers:
        return None
    envelope = source[headers[-1].end() :]
    match = _WORKER_REPORT_STATUS_RE.search(envelope)
    return match.group(1).casefold() if match is not None else None


def workflow_result_evidence_gaps(
    result: Mapping[str, Any] | None,
    contract: Mapping[str, Any] | None = None,
) -> tuple[str, ...]:
    """Return fail-closed quality gaps for one terminal worker receipt.

    ``ok`` is a transport/completion signal, not an evidence signal.  This
    predicate is intentionally conservative only when a task contract declares
    an evidence requirement; legacy generic workflows retain their historical
    ``ok + finalText`` compatibility behavior.  A display preview may be
    truncated, but it must point at an authoritative receipt/artifact before it
    can release a barrier.
    """
    packet = dict(result or {})
    requirements = dict((contract or {}).get("expectedEvidence") or {})
    text = str(
        packet.get("finalText")
        or packet.get("final_text")
        or ""
    ).strip()
    gaps: list[str] = []
    status = str(
        packet.get("status")
        or packet.get("supervisorStatus")
        or ""
    ).strip().casefold()
    manifest_receipt_complete = (
        packet.get("evidenceComplete") is True
        and any(
            str(packet.get(key) or "").strip()
            for key in (
                "receiptPath",
                "fullReceiptRef",
                "artifactRef",
                "evidenceArtifactRef",
            )
        )
    )
    transport_ok = packet.get("ok") is True or (
        "ok" not in packet and status in {"succeeded", "completed"}
    )
    if not transport_ok:
        gaps.append("worker_not_ok")
    if not text and not manifest_receipt_complete:
        gaps.append("empty_final_text")
    if status not in {
        "",
        "succeeded",
        "completed",
    }:
        gaps.append("non_terminal_success_status")
    if bool(packet.get("fallbackUsed")):
        gaps.append("fallback_excluded")
    report_status = worker_report_status(text)
    if report_status in _WORKER_REPORT_NON_SUCCESS:
        gaps.append(f"worker_report_{report_status}")
    if bool(packet.get("truncated")) and not any(
        str(packet.get(key) or "").strip()
        for key in (
            "receiptPath",
            "fullReceiptRef",
            "artifactRef",
            "evidenceArtifactRef",
        )
    ):
        gaps.append("truncated_without_full_receipt")

    expected_coverage = set(
        workflow_task_coverage_keys(contract or {})
    )
    reported_coverage = set(
        normalize_workflow_coverage_keys(packet.get("coverageKeys"))
    )
    if expected_coverage and reported_coverage and not expected_coverage.issubset(
        reported_coverage
    ):
        gaps.append("coverage_mismatch")

    if (
        not manifest_receipt_complete
        and requirements.get("requiresPathLine")
        and not (
        _WORKFLOW_PATH_LINE_RE.search(text)
        or isinstance(packet.get("evidenceRefs"), list)
        and any(
            _WORKFLOW_PATH_LINE_RE.search(str(ref.get("path") or ""))
            for ref in packet["evidenceRefs"]
            if isinstance(ref, Mapping)
        )
        )
    ):
        gaps.append("path_line_evidence_missing")
    if (
        not manifest_receipt_complete
        and requirements.get("requiresLimitations")
        and not any(
            marker in text.casefold()
            for marker in _WORKFLOW_LIMITATION_MARKERS
        )
        and not (
            isinstance(packet.get("limitations"), list)
            and any(str(item).strip() for item in packet["limitations"])
        )
    ):
        gaps.append("limitations_missing")
    if (
        not manifest_receipt_complete
        and requirements.get("requiresFilesModified")
        and not (
            _WORKFLOW_FILES_MODIFIED_RE.search(text)
            or isinstance(packet.get("filesModified"), list)
        )
    ):
        gaps.append("files_modified_status_missing")
    folded = text.casefold()
    if requirements.get("requiresA2ADurability"):
        cites_a2a = (
            "a2a_orchestration.py" in folded
            or "harvest_terminal_worker_receipts" in folded
            or "reconcile_workflow_snapshot" in folded
            or "build_restart_recovery_plan" in folded
        )
        if not cites_a2a:
            gaps.append("a2a_durability_paths_missing")
    if requirements.get("forbidsCompoundWorkflowEngine"):
        cites_compound = (
            "compound_workflow.py" in folded
            or "compound_workflow_bridge.py" in folded
            or "sophia.compound-workflow-plan.v1" in folded
        )
        cites_a2a = "a2a_orchestration.py" in folded
        if cites_compound and not cites_a2a:
            gaps.append("compound_workflow_wrong_engine")
    if requirements.get("requiresNamedTestExitCode"):
        command = str(
            requirements.get("namedTestCommand") or TUI_BARRIER_NAMED_TEST_COMMAND
        ).strip() or TUI_BARRIER_NAMED_TEST_COMMAND
        step = named_test_exitcode_step(packet.get("steps"), command=command)
        if step is None:
            gaps.append("named_test_exitcode_missing")
        elif step.get("ok") is not True or step.get("exitCode") != 0:
            gaps.append("named_test_exitcode_nonzero")
        elif named_test_narrative_contradicts(text, step):
            gaps.append("named_test_narrative_contradicts_receipt")
    return tuple(dict.fromkeys(gaps))


def named_test_exitcode_step(
    steps: Any,
    *,
    command: str = TUI_BARRIER_NAMED_TEST_COMMAND,
) -> dict[str, Any] | None:
    """Return the unmasked named-test bash step, or None.

    ``; echo EXIT:$?`` is not evidence: it forces the shell to 0.
    """
    wanted = str(command or TUI_BARRIER_NAMED_TEST_COMMAND).strip()
    aliases = {wanted}
    if wanted.startswith("python3 "):
        aliases.add("python " + wanted[len("python3 "):])
    elif wanted.startswith("python "):
        aliases.add("python3 " + wanted[len("python "):])
    for raw in reversed(list(steps or [])):
        if not isinstance(raw, Mapping):
            continue
        if str(raw.get("tool") or "") != "bash":
            continue
        args = raw.get("args") if isinstance(raw.get("args"), Mapping) else {}
        invoked = str(args.get("command") or "")
        if "echo EXIT" in invoked:
            continue
        if not any(alias in invoked for alias in aliases):
            continue
        if "exitCode" not in raw:
            continue
        return dict(raw)
    return None


def execute_named_test_exitcode_step(
    root: Any,
    *,
    command: str = TUI_BARRIER_NAMED_TEST_COMMAND,
) -> dict[str, Any]:
    """Run the named test through execute_tool and persist its exitCode."""
    import sys
    from pathlib import Path

    from agent.agent_tools import ToolContext, execute_tool

    wanted = str(command or TUI_BARRIER_NAMED_TEST_COMMAND).strip()
    argv = wanted
    if argv.startswith("python3 "):
        argv = f"{sys.executable} {argv[len('python3 '):]}"
    elif argv.startswith("python "):
        argv = f"{sys.executable} {argv[len('python '):]}"
    result = execute_tool(
        "bash",
        {"command": argv},
        ToolContext(root=Path(root), permission="auto"),
    )
    return result.to_step({"command": wanted})


def attach_named_test_exitcode(
    receipt: Mapping[str, Any] | None,
    *,
    root: Any,
    expected_evidence: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Append a real named-test bash step when the contract requires one.

    Grok provider tools run in a prompts-only cwd and never write Sophia
    ``steps``. The worker receipt must still carry the cited exitCode.
    """
    packet = dict(receipt or {})
    requirements = dict(expected_evidence or {})
    if not requirements.get("requiresNamedTestExitCode"):
        return packet
    command = str(
        requirements.get("namedTestCommand") or TUI_BARRIER_NAMED_TEST_COMMAND
    ).strip() or TUI_BARRIER_NAMED_TEST_COMMAND
    steps = list(packet.get("steps") or [])
    if named_test_exitcode_step(steps, command=command) is not None:
        return packet
    steps.append(execute_named_test_exitcode_step(root, command=command))
    packet["steps"] = steps
    return packet


_NAMED_TEST_DENIAL_MARKERS = (
    "no bash exitcode",
    "no bash `exitcode`",
    "no step exitcode",
    "no step `exitcode`",
    "not persisted",
    "denied by permission",
    "denied by permis",
)


_QUOTED_SPAN_RE = re.compile(
    r'"[^"]{0,240}"|`[^`]{0,240}`|'
    r"'(?:this receipt has no [^']{0,80})'"
)


def _strip_quoted_spans(text: str) -> str:
    """Drop quoted examples so citing a unit-test sentence is not a denial."""

    return _QUOTED_SPAN_RE.sub(" ", str(text or ""))


def named_test_narrative_contradicts(text: str, step: Mapping[str, Any] | None) -> bool:
    """True when prose denies a green named-test step already on the receipt."""
    if not step or step.get("ok") is not True or step.get("exitCode") != 0:
        return False
    folded = str(text or "").casefold().replace("**", "").replace("“", '"').replace("”", '"')
    cites_green_envelope = (
        "exitcode: 0" in folded
        or "exitcode 0" in folded
        or "harness_named_test" in folded
    )
    unquoted = _strip_quoted_spans(folded)
    hard_denies_this_receipt = (
        "this receipt has no bash exitcode" in unquoted
        or "this receipt has no step exitcode" in unquoted
        or "this receipt has no bash" in unquoted
    )
    if cites_green_envelope and not hard_denies_this_receipt:
        return False
    return any(marker in unquoted for marker in _NAMED_TEST_DENIAL_MARKERS)


def format_named_test_brief(
    step: Mapping[str, Any],
    *,
    command: str = TUI_BARRIER_NAMED_TEST_COMMAND,
) -> str:
    output = str(step.get("output") or "").strip().splitlines()
    tail = output[-1] if output else ""
    return (
        "HARNESS_NAMED_TEST (authoritative; already executed via Sophia "
        "execute_tool on this checkout)\n"
        f"command: {command}\n"
        f"exitCode: {step.get('exitCode')}\n"
        f"ok: {step.get('ok')}\n"
        f"output: {tail}\n"
        "Cite this envelope as the named-test step. A Grok "
        "run_terminal_command deny in private/agent-grok-cwd is not this "
        "step. Do not write that this receipt has no bash exitCode. "
        "Do not quote that denial sentence, even as a unit-test example."
    )


def prepare_named_test_for_worker(
    spec: Mapping[str, Any] | None,
    *,
    root: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run the named test before the model writes, and put the cite in the prompt.

    Attach-after-report left 20260817n with a green ``steps[0]`` and a
    finalText that said the test was denied.
    """
    packet = dict(spec or {})
    evidence = (
        packet.get("expectedEvidence")
        if isinstance(packet.get("expectedEvidence"), Mapping)
        else {}
    )
    seeded = attach_named_test_exitcode(
        {"steps": []},
        root=root,
        expected_evidence=evidence,
    )
    steps = [
        dict(item)
        for item in list(seeded.get("steps") or [])
        if isinstance(item, Mapping)
    ]
    if not steps:
        return packet, []
    command = str(
        evidence.get("namedTestCommand") or TUI_BARRIER_NAMED_TEST_COMMAND
    ).strip() or TUI_BARRIER_NAMED_TEST_COMMAND
    raw_cmd = packet.get("command")
    if isinstance(raw_cmd, Mapping):
        updated = dict(raw_cmd)
        prompt = str(updated.get("prompt") or "")
        brief = format_named_test_brief(steps[0], command=command)
        updated["prompt"] = f"{prompt}\n\n{brief}" if prompt else brief
        packet["command"] = updated
    return packet, steps


def workflow_result_evidence_complete(
    result: Mapping[str, Any] | None,
    contract: Mapping[str, Any] | None = None,
) -> bool:
    """Return whether one result is safe to count toward a barrier."""
    return not workflow_result_evidence_gaps(result, contract)


def workflow_stage_packet_complete(stage: Mapping[str, Any] | None) -> bool:
    """Return whether every declared contract has one usable receipt."""
    packet = dict(stage or {})
    results = [
        result
        for result in packet.get("results") or []
        if isinstance(result, Mapping)
    ]
    raw_contracts = list(packet.get("taskContracts") or [])
    contracts = [
        contract
        for contract in raw_contracts
        if isinstance(contract, Mapping)
    ]
    if not results:
        return False
    if raw_contracts and (
        len(contracts) != len(raw_contracts)
        or len(results) != len(raw_contracts)
    ):
        return False
    task_ids = [
        str(result.get("taskId") or "").strip()
        for result in results
        if str(result.get("taskId") or "").strip()
    ]
    if len(task_ids) != len(set(task_ids)):
        return False
    for index, result in enumerate(results):
        contract = contracts[index] if index < len(contracts) else {}
        if not workflow_result_evidence_complete(result, contract):
            return False
    return True


def workflow_completed_coverage(
    stage_ledger: Iterable[dict[str, Any]],
) -> set[str]:
    """Return coverage backed by successful, non-empty task results."""
    completed: set[str] = set()
    for stage in stage_ledger:
        if not isinstance(stage, dict):
            continue
        contracts = list(stage.get("taskContracts") or [])
        results = [
            result
            for result in stage.get("results") or []
            if isinstance(result, dict)
        ]
        results_by_task_id = {
            str(result.get("taskId") or ""): result
            for result in results
            if str(result.get("taskId") or "").strip()
        }
        results_by_contract_index = {
            int(result.get("contractIndex")): result
            for result in results
            if str(result.get("contractIndex") or "").isdigit()
        }
        aligned = (
            [
                (
                    index,
                    contract,
                    results_by_task_id.get(str(contract.get("taskId") or ""))
                    or results_by_contract_index.get(index)
                    or (results[index] if index < len(results) else None),
                )
                for index, contract in enumerate(contracts)
            ]
            if contracts
            else [(index, {}, result) for index, result in enumerate(results)]
        )
        for _index, contract, result in aligned:
            if not isinstance(result, dict):
                continue
            if not isinstance(contract, dict):
                contract = {}
            if not workflow_result_evidence_complete(result, contract):
                continue
            contract_coverage = workflow_task_coverage_keys(contract)
            if contract_coverage:
                # The controller contract is the authoritative lane scope.
                # Do not let incidental words in a worker's report make an
                # unstarted lane look complete.
                completed.update(contract_coverage)
            else:
                completed.update(workflow_task_coverage_keys(result))
    return completed


def _aligned_task_contracts(
    tasks: Iterable[str],
    task_contracts: Iterable[dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    task_list = [" ".join(str(task or "").split()) for task in tasks]
    contracts = [
        dict(contract) if isinstance(contract, dict) else {}
        for contract in task_contracts
    ]
    return [
        (
            task,
            contracts[index] if index < len(contracts) else {},
        )
        for index, task in enumerate(task_list)
        if task
    ]


def workflow_filter_completed_tasks(
    tasks: Iterable[str],
    task_contracts: Iterable[dict[str, Any]],
    completed_coverage: Iterable[str],
    stage_kind: str,
) -> tuple[tuple[str, ...], tuple[dict[str, Any], ...]]:
    """Remove completed specialist scopes while preserving task/contract order.

    Critic and tiebreak stages intentionally retain overlapping coverage. For a
    partially completed multi-coverage task, the retained contract is narrowed
    to the missing keys and its task text receives an explicit scope guard.
    """
    aligned = _aligned_task_contracts(tasks, task_contracts)
    normalized_kind = normalize_workflow_stage_kind(stage_kind)
    if normalized_kind in {"critic", "tiebreak"}:
        return (
            tuple(task for task, _contract in aligned),
            tuple(contract for _task, contract in aligned),
        )

    completed = set(normalize_workflow_coverage_keys(completed_coverage))
    filtered_tasks: list[str] = []
    filtered_contracts: list[dict[str, Any]] = []
    for task, contract in aligned:
        coverage = workflow_task_coverage_keys(contract)
        if not coverage:
            coverage = workflow_task_coverage_keys(task)
        if coverage and set(coverage).issubset(completed):
            continue
        retained = tuple(key for key in coverage if key not in completed)
        next_contract = dict(contract)
        next_task = task
        if retained and len(retained) != len(coverage):
            skipped = tuple(key for key in coverage if key in completed)
            next_contract["coverageKeys"] = list(retained)
            next_contract["skippedCoverageKeys"] = list(skipped)
            labels = ", ".join(
                _PLUGIN_AUDIT_COVERAGE_LABELS[key] for key in retained
            )
            next_task = (
                f"{task} COVERAGE_SCOPE:{','.join(retained)} "
                f"Audit only the still-missing coverage: {labels}; do not "
                "repeat already successful coverage."
            )
        elif retained:
            next_contract["coverageKeys"] = list(retained)
        filtered_tasks.append(next_task)
        filtered_contracts.append(next_contract)
    return tuple(filtered_tasks), tuple(filtered_contracts)


def workflow_board_todo_items(
    stage_ledger: Iterable[dict[str, Any]],
    *,
    pending_contracts: Iterable[Mapping[str, Any]] | None = None,
) -> list[dict[str, str]]:
    """Shared To-do rows from dispatch contracts and harvest receipts.

    This is the operator-visible checklist every agent is already following:
    one row per assigned coverage key, status from the terminal receipt.
    It is not the workflow pattern name.
    """

    items: list[dict[str, str]] = []
    index_by_id: dict[str, int] = {}

    def _content(contract: Mapping[str, Any]) -> str:
        evidence = contract.get("expectedEvidence")
        if isinstance(evidence, Mapping):
            command = str(evidence.get("namedTestCommand") or "").strip()
            if command:
                return command
        task = " ".join(str(contract.get("task") or "").split())
        if task:
            return task[:160]
        keys = workflow_task_coverage_keys(contract)
        if keys:
            return _WORKFLOW_COVERAGE_LABELS.get(keys[0], keys[0])
        return "assigned task"

    def _status(result: Mapping[str, Any] | None, *, default: str) -> str:
        if not isinstance(result, Mapping):
            return default
        if result.get("ok") is True or str(result.get("status") or "") in {
            "succeeded",
            "completed",
        }:
            return "completed"
        status = str(result.get("status") or "").strip().casefold()
        if status in {"failed", "cancelled", "timed_out", "lost"}:
            return "failed"
        if status in {"running", "spawning", "queued", "queued_for_model"}:
            return "in_progress"
        if result.get("ok") is False:
            return "failed"
        return default

    def _upsert(contract: Mapping[str, Any], result: Mapping[str, Any] | None, default: str) -> None:
        keys = workflow_task_coverage_keys(contract)
        task_id = str(contract.get("taskId") or "").strip()
        item_id = keys[0] if keys else task_id or f"todo-{len(items)}"
        row = {
            "id": item_id,
            "content": _content(contract),
            "status": _status(result, default=default),
            "owner": str(contract.get("taskId") or contract.get("name") or "").strip(),
        }
        existing = index_by_id.get(item_id)
        if existing is None:
            index_by_id[item_id] = len(items)
            items.append(row)
            return
        items[existing] = row

    for stage in stage_ledger:
        if not isinstance(stage, Mapping):
            continue
        contracts = [
            contract
            for contract in list(stage.get("taskContracts") or [])
            if isinstance(contract, Mapping)
        ]
        results = [
            result
            for result in list(stage.get("results") or [])
            if isinstance(result, Mapping)
        ]
        by_task = {
            str(result.get("taskId") or ""): result
            for result in results
            if str(result.get("taskId") or "").strip()
        }
        for index, contract in enumerate(contracts):
            result = by_task.get(str(contract.get("taskId") or ""))
            if result is None and index < len(results):
                result = results[index]
            default = "in_progress" if str(stage.get("status") or "") == "running" else "pending"
            _upsert(contract, result, default)

    for contract in pending_contracts or ():
        if isinstance(contract, Mapping):
            _upsert(contract, None, "in_progress")
    return items


def _task_with_role_and_skills(
    task: str,
    contract: Mapping[str, Any],
) -> str:
    rendered = " ".join(str(task or "").split())
    role = " ".join(str(contract.get("role") or "").split())
    if role:
        rendered = f"{rendered} ROLE:{role}".strip()
    for skill in contract.get("skills") or []:
        name = " ".join(str(skill or "").split())
        if name:
            rendered = f"{rendered} SKILL:{name}".strip()
    return rendered


def _recovery_task_spec(
    *,
    contract: Mapping[str, Any],
    result: Mapping[str, Any],
    coverage_key: str | None,
    retry_of: str,
) -> tuple[str, dict[str, Any]]:
    base_task = " ".join(
        str(
            contract.get("task")
            or result.get("task")
            or result.get("name")
            or "Recover the failed workflow task"
        ).split()
    )
    next_contract = {
        "task": base_task,
        "role": " ".join(str(contract.get("role") or "").split()),
        "skills": [
            " ".join(str(item or "").split())
            for item in list(contract.get("skills") or [])
            if str(item or "").strip()
        ],
        "doneCriteria": [
            " ".join(str(item or "").split())
            for item in list(contract.get("doneCriteria") or [])
            if str(item or "").strip()
        ],
        "expectedOutput": " ".join(
            str(contract.get("expectedOutput") or "").split()
        )[:1200],
        "allowSubagents": bool(contract.get("allowSubagents", False)),
        "retryOf": retry_of,
    }
    tools = [
        " ".join(str(item or "").split()).lower().replace("-", "_")
        for item in list(contract.get("allowedTools") or [])
        if str(item or "").strip()
    ]
    if tools:
        next_contract["allowedTools"] = list(dict.fromkeys(tools))
        next_contract["toolScopeVia"] = str(
            contract.get("toolScopeVia") or "template_explicit"
        )
    evidence = contract.get("expectedEvidence")
    if isinstance(evidence, Mapping) and evidence:
        next_contract["expectedEvidence"] = dict(evidence)
    worker_model = " ".join(str(contract.get("workerModel") or "").split())
    if worker_model:
        next_contract["workerModel"] = worker_model[:180]
    if isinstance(contract.get("retryPolicy"), Mapping):
        next_contract["retryPolicy"] = dict(contract["retryPolicy"])
    if contract.get("recoveryOf"):
        next_contract["recoveryOf"] = str(contract.get("recoveryOf"))[:240]
    if contract.get("idempotencyKey"):
        next_contract["idempotencyKey"] = str(
            contract.get("idempotencyKey")
        )[:300]
    if coverage_key:
        label = _WORKFLOW_COVERAGE_LABELS.get(coverage_key, coverage_key)
        next_contract["coverageKeys"] = [coverage_key]
        next_contract["task"] = (
            f"{base_task} Recovery scope: {label} only. Preserve successful "
            "coverage from prior workers and do not repeat it."
        )
    task = _task_with_role_and_skills(next_contract["task"], next_contract)
    return task, next_contract


def workflow_deterministic_recovery_decision(
    stage_record: dict[str, Any],
    completed_coverage: Iterable[str] = (),
) -> WorkflowDecision | None:
    """Build a retry-only recovery decision for one failed stage.

    Successful coverage is retained. Failed contracts that span multiple
    missing coverage keys become one singleton task per key, all carrying the
    original task id in ``retryOf``. A one-task recovery is returned when only
    one coverage item is missing; callers must not reject it merely because
    ordinary planned stages prefer parallel fan-out.
    """
    if not isinstance(stage_record, dict):
        return None
    contracts = list(stage_record.get("taskContracts") or [])
    results = [
        result if isinstance(result, dict) else {}
        for result in list(stage_record.get("results") or [])
    ]
    if not results and not contracts:
        return None

    completed = set(normalize_workflow_coverage_keys(completed_coverage))
    completed.update(workflow_completed_coverage([stage_record]))
    tasks: list[str] = []
    recovery_contracts: list[dict[str, Any]] = []
    scheduled_coverage: set[str] = set()

    def nonnegative_int(value: Any) -> int:
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 0

    requested_count = max(
        len(contracts),
        len(results),
        nonnegative_int(stage_record.get("requestedAgentCount")),
        nonnegative_int(stage_record.get("controllerRequestedTaskCount")),
    )
    results_by_task_id = {
        str(result.get("taskId") or ""): result
        for result in results
        if str(result.get("taskId") or "").strip()
    }
    results_by_contract_index = {
        int(result.get("contractIndex")): result
        for result in results
        if str(result.get("contractIndex") or "").isdigit()
    }
    for index in range(requested_count):
        contract = (
            contracts[index]
            if index < len(contracts) and isinstance(contracts[index], dict)
            else {}
        )
        result = (
            results_by_task_id.get(str(contract.get("taskId") or ""))
            or results_by_contract_index.get(index)
            or (results[index] if index < len(results) else {})
        )
        if workflow_result_evidence_complete(result, contract):
            continue
        coverage = workflow_task_coverage_keys(contract)
        if not coverage:
            coverage = workflow_task_coverage_keys(result)
        missing = tuple(
            key
            for key in coverage
            if key not in completed and key not in scheduled_coverage
        )
        retry_of = str(
            contract.get("retryOf")
            or result.get("taskId")
            or contract.get("taskId")
            or f"stage-{stage_record.get('stage') or 0}-task-{index + 1}"
        )
        if missing:
            for coverage_key in missing:
                task, next_contract = _recovery_task_spec(
                    contract=contract,
                    result=result,
                    coverage_key=coverage_key,
                    retry_of=retry_of,
                )
                tasks.append(task)
                recovery_contracts.append(next_contract)
                scheduled_coverage.add(coverage_key)
            continue
        if coverage:
            # Every scope in this failed task was independently completed by a
            # successful result, so retrying it would duplicate work.
            continue
        task, next_contract = _recovery_task_spec(
            contract=contract,
            result=result,
            coverage_key=None,
            retry_of=retry_of,
        )
        tasks.append(task)
        recovery_contracts.append(next_contract)

    if not tasks:
        return None
    pattern = " ".join(str(stage_record.get("pattern") or "workflow").split())
    if not pattern.endswith("-recovery"):
        pattern = f"{pattern}-recovery"
    return WorkflowDecision(
        action="dispatch",
        pattern=pattern[:120],
        reason=(
            "Deterministic recovery preserves successful coverage and retries "
            "only failed or still-missing task scopes."
        ),
        stage_goal=(
            "Recover only failed or missing coverage without repeating "
            "successful evidence."
        ),
        tasks=tuple(tasks[:MAX_TASKS_PER_STAGE]),
        task_contracts=tuple(recovery_contracts[:MAX_TASKS_PER_STAGE]),
        completion_criteria=(
            "Every retried coverage key has a successful, non-empty report.",
            "Previously successful coverage is not repeated.",
        ),
        stage_kind="recovery",
        requires_critics=bool(stage_record.get("requiresCritics")),
        reason_code="deterministic_recovery",
    )


def _known_audit_task(
    *,
    task: str,
    coverage_keys: tuple[str, ...],
    expected_output: str,
    role: str = "",
    skills: tuple[str, ...] = (),
    allowed_tools: tuple[str, ...] = (),
    expected_evidence: Mapping[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    contract = {
        "task": task,
        "role": role,
        "skills": list(skills),
        "allowedTools": list(allowed_tools),
        "toolScopeVia": "template_explicit" if allowed_tools else "",
        "coverageKeys": list(coverage_keys),
        "doneCriteria": [
            "Assign PASS or FAIL for every assigned subsystem.",
            "Cite concrete repository paths and load-bearing fields or behavior.",
            "Stay read-only and make no production-readiness claim.",
        ],
        "expectedOutput": expected_output,
        "allowSubagents": False,
        # These template tasks are explicitly read-only. Persisting this
        # policy lets a restarted controller retry an orphaned inspection
        # without guessing that an arbitrary worker task is safe to repeat.
        "retryPolicy": {
            "safeToRetry": True,
            "mode": "read_only",
            "sideEffects": "none",
        },
    }
    if expected_evidence:
        contract["expectedEvidence"] = dict(expected_evidence)
    return task, contract


def _known_audit_decision(
    *,
    stage_kind: str,
    stage_goal: str,
    tasks_and_contracts: tuple[tuple[str, dict[str, Any]], ...],
    completion_criteria: tuple[str, ...],
) -> WorkflowDecision:
    tasks = tuple(item[0] for item in tasks_and_contracts)
    contracts = tuple(item[1] for item in tasks_and_contracts)
    payload = {
        "source": "known-plugin-audit-template",
        "stageKind": stage_kind,
        "coverageKeys": [
            key
            for contract in contracts
            for key in contract.get("coverageKeys", [])
        ],
    }
    return WorkflowDecision(
        action="dispatch",
        pattern="known-plugin-audit",
        reason=(
            "Recognized the bounded eight-subsystem Sophia plugin-platform "
            "audit; use the deterministic barrier plan instead of model routing."
        ),
        stage_goal=stage_goal,
        tasks=tasks,
        task_contracts=contracts,
        completion_criteria=completion_criteria,
        stage_kind=stage_kind,
        requires_critics=True,
        reason_code="known_plugin_audit_template",
        raw=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    )


def _known_tui_barrier_decision(
    *,
    stage_kind: str,
    stage_goal: str,
    tasks_and_contracts: tuple[tuple[str, dict[str, Any]], ...],
    completion_criteria: tuple[str, ...],
) -> WorkflowDecision:
    tasks = tuple(item[0] for item in tasks_and_contracts)
    contracts = tuple(item[1] for item in tasks_and_contracts)
    payload = {
        "source": "known-tui-parallel-barrier-smoke-template",
        "templateId": KNOWN_TUI_PARALLEL_BARRIER_SMOKE_TEMPLATE_ID,
        "stageKind": stage_kind,
        "coverageKeys": [
            key
            for contract in contracts
            for key in contract.get("coverageKeys", [])
        ],
    }
    return WorkflowDecision(
        action="dispatch",
        pattern="tui-parallel-barrier-smoke",
        reason=(
            "Recognized the bounded TUI parallel fan-out smoke; dispatch "
            "all specialist lanes in parallel and synthesize once."
        ),
        stage_goal=stage_goal,
        tasks=tasks,
        task_contracts=contracts,
        completion_criteria=completion_criteria,
        stage_kind=stage_kind,
        requires_critics=False,
        reason_code="known_tui_parallel_barrier_smoke_template",
        raw=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    )


def known_plugin_audit_stages(
    prompt: str,
    *,
    profile_context: str = "",
) -> tuple[WorkflowDecision, ...]:
    """Return the fixed three-stage plan for the recognized plugin audit.

    Recognition is intentionally strict: the request must be an audit of a
    plugin platform, name all eight canonical coverage areas, require an
    independent critic/reviewer barrier, and be explicitly bound to Sophia's
    beta/profile or the stable template id. Otherwise an empty tuple is
    returned and the normal dynamic planner remains authoritative.
    """
    text = " ".join(str(prompt or "").casefold().split())
    context = " ".join(str(profile_context or "").casefold().split())
    coverage = set(workflow_task_coverage_keys(text))
    audit_requested = any(
        token in text for token in ("audit", "review", "pass/fail", "pass or fail")
    )
    plugin_platform = (
        "plugin-platform" in text
        or "plugin platform" in text
        or "plugin-platform beta" in text
    )
    critic_requested = any(
        token in text
        for token in (
            "critic barrier",
            "critics",
            "independent critic",
            "independent reviewer",
            "go/hold",
            "go or hold",
        )
    )
    explicit_template = KNOWN_PLUGIN_AUDIT_TEMPLATE_ID in text
    sophia_beta_signal = (
        ("sophia" in text and "beta" in text)
        or "sophia-review-pack" in text
        or "sophia-review-pack/" in context
    )
    if not (
        audit_requested
        and plugin_platform
        and critic_requested
        and coverage == set(PLUGIN_AUDIT_COVERAGE_KEYS)
        and (sophia_beta_signal or explicit_template)
    ):
        return ()

    read_only = (
        "Use read-only repository inspection only. Do not edit files, execute "
        "project commands or tests, use network tools, or claim production "
        "readiness. Treat candidateOnly as true and canClaimAGI as false."
    )
    specialist_output = (
        "Bounded WORKER_REPORT with a subsystem PASS/FAIL table, file-backed "
        "evidence, scoped gaps, and residual unknowns."
    )
    stage_one = _known_audit_decision(
        stage_kind="specialist",
        stage_goal=(
            "Establish file-backed PASS/FAIL candidates for the first four "
            "independent plugin-platform control surfaces."
        ),
        tasks_and_contracts=(
            _known_audit_task(
                task=(
                    "Audit only the plugin manifest/schema and trust/permission "
                    f"policy. {read_only}"
                ),
                coverage_keys=("manifest-schema", "trust-permission"),
                expected_output=specialist_output,
            ),
            _known_audit_task(
                task=(
                    "Audit only the registry/lock state and JSON-RPC supervisor. "
                    f"{read_only}"
                ),
                coverage_keys=("registry-lock", "jsonrpc-supervisor"),
                expected_output=specialist_output,
            ),
        ),
        completion_criteria=(
            "All first-stage coverage keys have file-cited PASS/FAIL evidence.",
            "No worker edits the tree or claims production readiness.",
        ),
    )
    stage_two = _known_audit_decision(
        stage_kind="specialist",
        stage_goal=(
            "Establish file-backed PASS/FAIL candidates for the remaining four "
            "runtime and operator-facing plugin-platform surfaces."
        ),
        tasks_and_contracts=(
            _known_audit_task(
                task=(
                    "Audit only the DeepSeek adapter/harness and CodeBridge "
                    f"plugin integration. {read_only}"
                ),
                coverage_keys=("deepseek-adapter", "codebridge"),
                expected_output=specialist_output,
            ),
            _known_audit_task(
                task=(
                    "Audit only the bundled review profile and TUI command "
                    f"wiring. {read_only}"
                ),
                coverage_keys=("review-profile", "tui-wiring"),
                expected_output=specialist_output,
            ),
        ),
        completion_criteria=(
            "All eight specialist coverage keys now have file-cited evidence.",
            "Security and scalability gaps remain scoped to assigned surfaces.",
        ),
    )
    critic_output = (
        "Bounded CRITIC_REPORT listing confirmed evidence, contradicted claims, "
        "unresolved blockers, and a subsystem-scoped GO/HOLD recommendation."
    )
    stage_three = _known_audit_decision(
        stage_kind="critic",
        stage_goal=(
            "Independently challenge the complete eight-subsystem specialist "
            "packet before final synthesis."
        ),
        tasks_and_contracts=(
            _known_audit_task(
                task=(
                    "Critique the complete prior packet for manifest/schema, "
                    "trust/permission, registry/lock, and JSON-RPC supervisor. "
                    "Do not redo specialist discovery unless a cited claim must "
                    f"be checked. {read_only}"
                ),
                coverage_keys=(
                    "manifest-schema",
                    "trust-permission",
                    "registry-lock",
                    "jsonrpc-supervisor",
                ),
                expected_output=critic_output,
            ),
            _known_audit_task(
                task=(
                    "Critique the complete prior packet for DeepSeek adapter, "
                    "CodeBridge, bundled review profile, and TUI wiring. Do not "
                    "redo specialist discovery unless a cited claim must be "
                    f"checked. {read_only}"
                ),
                coverage_keys=(
                    "deepseek-adapter",
                    "codebridge",
                    "review-profile",
                    "tui-wiring",
                ),
                expected_output=critic_output,
            ),
        ),
        completion_criteria=(
            "Both critics address their four assigned coverage keys.",
            "Material contradictions and production HOLD blockers are explicit.",
        ),
    )
    return stage_one, stage_two, stage_three


def known_tui_parallel_barrier_smoke_stages(
    prompt: str,
    *,
    profile_context: str = "",
) -> tuple[WorkflowDecision, ...]:
    """Return the fixed parallel fan-out plan for the TUI barrier smoke.

    This is intentionally opt-in via an exact template marker. The marker
    makes the smoke contract executable and prevents ordinary TUI questions
    from being silently routed through a multi-lane audit. Recovery is not a
    planned optional stage: the bridge derives it from the failed stage's full
    task-contract packet before synthesis.
    """
    text = " ".join(str(prompt or "").casefold().split())
    context = " ".join(str(profile_context or "").casefold().split())
    marker = KNOWN_TUI_PARALLEL_BARRIER_SMOKE_TEMPLATE_ID.casefold()
    if marker not in f"{text} {context}":
        return ()
    required_phrases = (
        "backend durability",
        "bridge authority",
        "tui graph",
        "reducer",
        "test evidence",
        "read-only",
    )
    if not all(phrase in text for phrase in required_phrases):
        return ()

    read_only = (
        "Use read-only repository inspection only. Do not edit files, execute "
        "project commands or tests, use network tools, or claim production "
        "readiness. Treat candidateOnly as true and canClaimAGI as false."
    )
    test_evidence_exec = (
        "Do not edit files or use network tools. Do not claim production "
        "readiness. Treat candidateOnly as true and canClaimAGI as false. "
        "This lane is the execution exception: run exactly "
        f"`{TUI_BARRIER_NAMED_TEST_COMMAND}` via bash without appending "
        "`; echo EXIT:$?`. Cite the persisted step exitCode. An unexecuted "
        "inventory is not a product PASS."
    )
    specialist_output = (
        "Bounded WORKER_REPORT with exact path:line evidence, an explicit "
        "PASS/FAIL/PARTIAL verdict for the assigned scope, recovery risks, "
        "and unresolved limitations."
    )
    specialist_evidence = {
        "requiresPathLine": True,
        "requiresLimitations": True,
        "requiresFilesModified": True,
    }
    durability_evidence = {
        **specialist_evidence,
        "requiresA2ADurability": True,
        "forbidsCompoundWorkflowEngine": True,
    }
    stage_one = _known_tui_barrier_decision(
        stage_kind="specialist",
        stage_goal=(
            "Complete the parallel specialist fan-out for backend durability, "
            "bridge authority, TUI graph/reducer behavior, and test evidence; "
            "Main synthesizes after every lane has a terminal receipt."
        ),
        tasks_and_contracts=(
            _known_audit_task(
                task=(
                    "Inspect A2A backend durability only: persistence, resume, "
                    "failure, and recovery in agent/a2a_orchestration.py and "
                    "the code_bridge resume path (load_orchestration → "
                    "harvest_terminal_worker_receipts → "
                    "reconcile_workflow_snapshot → "
                    "build_restart_recovery_plan). Do not treat "
                    "agent/compound_workflow.py, "
                    "agent/compound_workflow_bridge.py, or "
                    "sophia.compound-workflow-plan.v1 as this template's "
                    "runner. A compound-workflow PASS without those A2A "
                    f"paths is FAIL for this coverage key. {read_only}"
                ),
                coverage_keys=("backend-durability",),
                expected_output=specialist_output,
                expected_evidence=durability_evidence,
                role="reliability-engineer",
                skills=("repo-analysis", "coding-debugging"),
                allowed_tools=TUI_READ_ONLY_DISPATCH_TOOLS,
            ),
            _known_audit_task(
                task=(
                    "Inspect bridge authority only: policy ownership, "
                    "allow/deny enforcement, approval identity, and TUI "
                    f"transport boundaries. {read_only}"
                ),
                coverage_keys=("bridge-authority",),
                expected_output=specialist_output,
                expected_evidence=specialist_evidence,
                role="identity-access-engineer",
                skills=("repo-analysis", "coding-debugging"),
                allowed_tools=TUI_READ_ONLY_DISPATCH_TOOLS,
            ),
            _known_audit_task(
                task=(
                    "Inspect TUI graph and reducer behavior only: stage/lane "
                    "state, reducer transitions, barrier visibility, and "
                    "failure rendering. Never-started or malformed lanes must "
                    "fail closed (not collapse to queued). Failure counters "
                    f"must match started/unstarted/failed facts. {read_only}"
                ),
                coverage_keys=("tui-graph-reducer",),
                expected_output=specialist_output,
                expected_evidence=specialist_evidence,
                role="frontend-developer",
                skills=("codebase-design", "tdd-implementation"),
                allowed_tools=TUI_READ_ONLY_DISPATCH_TOOLS,
            ),
            _known_audit_task(
                task=(
                    "Inspect test evidence only: focused regression coverage, "
                    "PTY smoke workflow-parallel-barrier, CI wiring, and what "
                    "the current tests do or do not prove about a live "
                    "parallel fan-out packet. Do not treat an "
                    f"unexecuted inventory as a product PASS. {test_evidence_exec}"
                ),
                coverage_keys=("test-evidence",),
                expected_output=specialist_output,
                expected_evidence={
                    **specialist_evidence,
                    "requiresNamedTestExitCode": True,
                    "namedTestCommand": TUI_BARRIER_NAMED_TEST_COMMAND,
                },
                role="test-automation-engineer",
                skills=("tdd-implementation", "ci-path-selection"),
                allowed_tools=TUI_TEST_EVIDENCE_DISPATCH_TOOLS,
            ),
        ),
        completion_criteria=(
            "All four specialist contracts have terminal receipts.",
            "Every successful report contains exact file-backed evidence.",
            "A provider or turn-limit failure is recorded as transport failure, "
            "not converted into a product verdict.",
        ),
    )
    return (stage_one,)


def _known_direct_test_decision(
    *,
    stage_goal: str,
    tasks_and_contracts: tuple[tuple[str, dict[str, Any]], ...],
    completion_criteria: tuple[str, ...],
) -> WorkflowDecision:
    tasks = tuple(item[0] for item in tasks_and_contracts)
    contracts = tuple(item[1] for item in tasks_and_contracts)
    payload = {
        "source": "known-direct-test-execution-template",
        "templateId": KNOWN_DIRECT_TEST_EXECUTION_TEMPLATE_ID,
        "stageKind": "specialist",
        "coverageKeys": [
            key
            for contract in contracts
            for key in contract.get("coverageKeys", [])
        ],
    }
    return WorkflowDecision(
        action="dispatch",
        pattern="direct-test-execution",
        reason=(
            "Recognized the two-command named-test smoke; harness-run each "
            "python file and cite the persisted bash exitCode."
        ),
        stage_goal=stage_goal,
        tasks=tasks,
        task_contracts=contracts,
        completion_criteria=completion_criteria,
        stage_kind="specialist",
        requires_critics=False,
        reason_code="known_direct_test_execution_template",
        raw=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    )


def known_direct_test_execution_stages(
    prompt: str,
    *,
    profile_context: str = "",
) -> tuple[WorkflowDecision, ...]:
    """Return the two-command named-test plan. Grok never owns bash.

    Opt-in when the operator names both in-checkout test files and either
    the template id or an explicit ban on the four-lane smoke. The harness
    executes each command and persists ``exitCode``; workers only cite the
    envelope. This is not Product GO.
    """
    text = " ".join(str(prompt or "").casefold().split())
    context = " ".join(str(profile_context or "").casefold().split())
    blob = f"{text} {context}"
    has_exitcode = "tests/test_bash_exitcode.py" in text
    has_authority = "tests/test_workflow_result_authority.py" in text
    if not (has_exitcode and has_authority):
        return ()
    explicit = KNOWN_DIRECT_TEST_EXECUTION_TEMPLATE_ID.casefold() in blob
    forbids_four_lane = (
        (
            "do not run" in text
            or "do not start" in text
            or "do not open" in text
        )
        and (
            "parallel-barrier-smoke" in text
            or "four-lane" in text
            or "four lane" in text
        )
    )
    if not (explicit or forbids_four_lane):
        return ()
    if known_tui_parallel_barrier_smoke_stages(
        prompt,
        profile_context=profile_context,
    ):
        return ()

    named_test_exec = (
        "Do not edit files or use network tools. Do not claim production "
        "readiness. Treat candidateOnly as true and canClaimAGI as false. "
        "Cite the HARNESS_NAMED_TEST envelope. Do not write that this "
        "receipt has no bash exitCode."
    )
    specialist_output = (
        "Bounded WORKER_REPORT with the persisted bash exitCode, pass/fail "
        "for the assigned command, and unresolved limitations."
    )
    exitcode_cmd, authority_cmd = TUI_DIRECT_TEST_COMMANDS
    stage_one = _known_direct_test_decision(
        stage_goal=(
            "Harness-run the two named python tests and persist each "
            "bash exitCode; Main synthesizes after both receipts."
        ),
        tasks_and_contracts=(
            _known_audit_task(
                task=(
                    "Execute only "
                    f"`{exitcode_cmd}` via the harness named-test. "
                    f"{named_test_exec}"
                ),
                coverage_keys=("bash-exitcode-control",),
                expected_output=specialist_output,
                role="test-automation-engineer",
                skills=("tdd-implementation", "ci-path-selection"),
                allowed_tools=TUI_TEST_EVIDENCE_DISPATCH_TOOLS,
                expected_evidence={
                    "requiresNamedTestExitCode": True,
                    "namedTestCommand": exitcode_cmd,
                    "requiresLimitations": True,
                    "requiresFilesModified": True,
                },
            ),
            _known_audit_task(
                task=(
                    "Execute only "
                    f"`{authority_cmd}` via the harness named-test. "
                    f"{named_test_exec}"
                ),
                coverage_keys=("workflow-result-authority",),
                expected_output=specialist_output,
                role="reliability-engineer",
                skills=("tdd-implementation", "coding-debugging"),
                allowed_tools=TUI_TEST_EVIDENCE_DISPATCH_TOOLS,
                expected_evidence={
                    "requiresNamedTestExitCode": True,
                    "namedTestCommand": authority_cmd,
                    "requiresLimitations": True,
                    "requiresFilesModified": True,
                },
            ),
        ),
        completion_criteria=(
            "Both named-test commands have a persisted bash exitCode.",
            "Absence of an exitCode is not treated as 0 or as a pass.",
        ),
    )
    return (stage_one,)


def workflow_compact_worker_context(
    original_goal: str,
    *,
    stage_goal: str,
    rationale: str = "",
    coverage_keys: Iterable[str] = (),
    stage_ledger: Iterable[dict[str, Any]] = (),
    source_ids: Iterable[str] = (),
    max_chars: int = 6000,
) -> str:
    """Build a bounded worker context without repeating full controller prompts.

    A critic task may name the exact ``sourceId`` values it must challenge.
    When it does, retain only those reports so the bounded packet can carry
    substantially more of the relevant evidence instead of tiny excerpts from
    every earlier worker.
    """
    limit = max(512, int(max_chars))

    def clipped(value: Any, size: int) -> str:
        text = " ".join(str(value or "").split())
        return text if len(text) <= size else f"{text[: max(0, size - 1)]}…"

    requested_sources = tuple(
        dict.fromkeys(
            " ".join(str(item or "").split())
            for item in source_ids
            if str(item or "").strip()
        )
    )
    ledger_list = list(stage_ledger)
    matched_sources: tuple[str, ...] = ()
    if requested_sources and ledger_list:
        requested = set(requested_sources)
        focused: list[dict[str, Any]] = []
        found: list[str] = []
        for stage in ledger_list:
            if not isinstance(stage, dict):
                continue
            results = list(stage.get("results") or [])
            contracts = list(stage.get("taskContracts") or [])
            selected_results: list[dict[str, Any]] = []
            selected_contracts: list[dict[str, Any]] = []
            for index, result in enumerate(results):
                if not isinstance(result, dict):
                    continue
                source_id = " ".join(
                    str(
                        result.get("taskId")
                        or result.get("sourceId")
                        or result.get("name")
                        or ""
                    ).split()
                )
                if source_id not in requested:
                    continue
                found.append(source_id)
                selected_results.append(result)
                selected_contracts.append(
                    contracts[index]
                    if index < len(contracts)
                    and isinstance(contracts[index], dict)
                    else {}
                )
            if selected_results:
                focused_stage = dict(stage)
                focused_stage["results"] = selected_results
                focused_stage["taskContracts"] = selected_contracts
                focused.append(focused_stage)
        if focused:
            ledger_list = focused
            matched_sources = tuple(dict.fromkeys(found))

    coverage = normalize_workflow_coverage_keys(coverage_keys)
    coverage_line = f"Coverage: {','.join(coverage) or 'unspecified'}"
    source_line = ""
    if requested_sources:
        missing = [
            source_id
            for source_id in requested_sources
            if source_id not in set(matched_sources)
        ]
        source_line = (
            f"\nRequested source packets: {','.join(requested_sources)}"
            f"\nMatched source packets: {','.join(matched_sources) or 'none'}"
            f"\nMissing source packets: {','.join(missing) or 'none'}"
        )
    ledger_budget = min(3600, max(512, limit // 2)) if ledger_list else 0
    if matched_sources:
        # Focused critic packets deserve the remaining context budget. The
        # ordinary compact path stays small for planning/recovery workers.
        ledger_budget = max(512, limit - 1800)
    header_budget = max(
        256,
        limit
        - ledger_budget
        - len(coverage_line)
        - len(source_line)
        - (32 if ledger_list else 8),
    )
    original_budget = max(96, int(header_budget * 0.45))
    stage_budget = max(80, int(header_budget * 0.30))
    rationale_budget = max(
        64,
        header_budget - original_budget - stage_budget,
    )
    header = (
        f"Operator goal: {clipped(original_goal, original_budget)}\n"
        f"Stage goal: {clipped(stage_goal, stage_budget)}\n"
        f"{coverage_line}\n"
        f"Controller rationale: {clipped(rationale, rationale_budget)}"
        f"{source_line}"
    )
    if ledger_list:
        remaining = max(256, limit - len(header) - 24)
        packet_label = (
            "Selected prior workflow packets"
            if matched_sources
            else "Complete prior workflow packet"
        )
        header = (
            f"{header}\n{packet_label} "
            "(source-labeled; truncated=true means only an excerpt was retained):\n"
            f"{workflow_stage_context(ledger_list, max_chars=remaining)}"
        )
    if len(header) <= limit:
        return header
    return f"{header[: max(0, limit - 1)]}…"


_WORKFLOW_SOURCE_ID_RE = re.compile(
    r"\bsourceIds?\s*(?:[:=]\s*)?([A-Za-z0-9][A-Za-z0-9._:-]{2,})",
    re.IGNORECASE,
)


def workflow_referenced_source_ids(value: Any) -> tuple[str, ...]:
    """Return source packet ids explicitly named by a worker task."""
    return tuple(
        dict.fromkeys(
            match.group(1).rstrip(".,;:)")
            for match in _WORKFLOW_SOURCE_ID_RE.finditer(str(value or ""))
        )
    )


def normalize_workflow_stage_kind(value: Any) -> str:
    """Return a supported barrier-stage kind, or an empty compatibility value."""
    raw = str(value or "").strip().casefold().replace("-", "_")
    aliases = {
        "review": "critic",
        "reviewer": "critic",
        "critique": "critic",
        "tie_break": "tiebreak",
        "tie_breaker": "tiebreak",
        "correction": "recovery",
        "repair": "recovery",
        "refine": "refinement",
        "revision": "refinement",
        "implementation_followup": "implementation_follow_up",
        "implementation_follow_up": "implementation_follow_up",
        "followup": "implementation_follow_up",
        "follow_up": "implementation_follow_up",
        "assessment": "specialist",
    }
    normalized = aliases.get(raw, raw)
    return normalized if normalized in WORKFLOW_STAGE_KINDS else ""


def infer_workflow_stage_kind(
    decision: WorkflowDecision,
    *,
    stage_index: int,
) -> str:
    """Infer a conservative stage kind for older controller responses."""
    explicit = normalize_workflow_stage_kind(decision.stage_kind)
    if explicit:
        return explicit
    if stage_index <= 1:
        return "specialist"
    text = " ".join(
        (
            decision.stage_goal,
            decision.reason,
            decision.final_focus,
        )
    ).casefold()
    if any(
        token in text
        for token in (
            "recover",
            "recovery",
            "correct",
            "repair",
            "missing axis",
            "incomplete packet",
        )
    ):
        return "recovery"
    if any(token in text for token in ("tie-break", "tiebreak", "tie breaker")):
        return "tiebreak"
    if any(
        token in text
        for token in ("critic", "critique", "reviewer", "challenge the packet")
    ):
        return "critic"
    return "general"


def workflow_requires_critic_barrier(
    original_goal: str,
    decision: WorkflowDecision | None = None,
) -> bool:
    """Detect an explicitly requested later critic/reviewer barrier."""
    if decision is not None and decision.requires_critics:
        return True
    text = str(original_goal or "").casefold()
    critic = any(
        token in text
        for token in (
            "critic barrier",
            "critics against",
            "separate critics",
            "independent critics",
            "reviewer barrier",
            "separate reviewers",
        )
    )
    staged = any(
        token in text
        for token in ("then", "later", "after", "before main", "before a go", "before go")
    )
    return critic and staged


def workflow_stage_context(
    stage_ledger: Iterable[dict[str, Any]],
    *,
    max_chars: int = 3600,
) -> str:
    """Build a bounded, source-labeled packet for dependent workers.

    The packet preserves every selected result and its source/status while
    excluding hidden reasoning and tool traces. Long report bodies are divided
    fairly across the available context and carry explicit truncation markers.
    """
    normalized: list[dict[str, Any]] = []
    for stage in stage_ledger:
        if not isinstance(stage, dict):
            continue
        task_contracts = list(stage.get("taskContracts") or [])
        normalized_results: list[dict[str, Any]] = []
        for index, result in enumerate(stage.get("results") or [], start=1):
            if not isinstance(result, dict):
                continue
            contract = (
                task_contracts[index - 1]
                if index <= len(task_contracts)
                and isinstance(task_contracts[index - 1], dict)
                else {}
            )
            normalized_results.append({
                "sourceId": (
                    result.get("taskId")
                    or result.get("name")
                    or f"stage-{stage.get('stage')}-result-{index}"
                ),
                "coverageKeys": list(
                    workflow_task_coverage_keys(contract)
                    or workflow_task_coverage_keys(result)
                ),
                "retryOf": str(
                    contract.get("retryOf")
                    or result.get("retryOf")
                    or ""
                )[:240],
                "status": result.get("status") or "",
                "ok": bool(result.get("ok")),
                "error": str(
                    result.get("error") or result.get("modelError") or ""
                )[:500],
                "provider": str(result.get("provider") or "")[:120],
                "fallbackUsed": bool(result.get("fallbackUsed")),
                "receiptPath": str(result.get("receiptPath") or "")[:800],
                "receiptSha256": str(result.get("receiptSha256") or "")[:128],
                "evidenceRefs": [
                    dict(ref)
                    for ref in list(result.get("evidenceRefs") or [])[:32]
                    if isinstance(ref, Mapping)
                ],
                "verification": [
                    str(item)[:500]
                    for item in list(result.get("verification") or [])[:16]
                    if str(item).strip()
                ],
                "limitations": [
                    str(item)[:500]
                    for item in list(result.get("limitations") or [])[:16]
                    if str(item).strip()
                ],
                "filesModified": [
                    str(item)[:500]
                    for item in list(result.get("filesModified") or [])[:64]
                    if str(item).strip()
                ],
                "doneCriteria": [
                    str(item)[:240]
                    for item in list(contract.get("doneCriteria") or [])[:16]
                ],
                "expectedOutput": str(
                    contract.get("expectedOutput") or ""
                )[:600],
                "expectedEvidence": dict(
                    contract.get("expectedEvidence") or {}
                ),
                "evidenceGaps": list(
                    workflow_result_evidence_gaps(result, contract)
                ),
                "_fullText": str(result.get("finalText") or "").strip(),
            })
        normalized.append({
            "stage": stage.get("stage"),
            "kind": stage.get("kind") or "general",
            "pattern": str(stage.get("pattern") or "")[:120],
            "goal": str(stage.get("goal") or "")[:600],
            "status": stage.get("status") or "",
            "requestedAgentCount": stage.get("requestedAgentCount"),
            "startedAgentCount": stage.get("startedAgentCount"),
            "unstartedAgentCount": stage.get("unstartedAgentCount"),
            "deferredTaskCount": stage.get("deferredTaskCount"),
            "failureCodes": [
                str(item)[:120]
                for item in list(stage.get("failureCodes") or [])[:16]
            ],
            "completionCriteria": [
                str(item)[:240]
                for item in list(stage.get("completionCriteria") or [])[:16]
            ],
            "results": normalized_results,
        })

    def build_packet(verbosity: int, excerpt_chars: int) -> list[dict[str, Any]]:
        packet: list[dict[str, Any]] = []
        for stage in normalized:
            if verbosity >= 2:
                stage_view: dict[str, Any] = {
                    key: stage.get(key)
                    for key in (
                        "stage",
                        "kind",
                        "pattern",
                        "goal",
                        "status",
                        "requestedAgentCount",
                        "startedAgentCount",
                        "unstartedAgentCount",
                        "deferredTaskCount",
                        "failureCodes",
                        "completionCriteria",
                    )
                }
            elif verbosity == 1:
                stage_view = {
                    key: stage.get(key)
                    for key in (
                        "stage",
                        "kind",
                        "pattern",
                        "status",
                        "requestedAgentCount",
                        "startedAgentCount",
                        "unstartedAgentCount",
                        "failureCodes",
                    )
                }
                stage_view["metadataTruncated"] = True
            else:
                stage_view = {
                    "stage": stage.get("stage"),
                    "kind": stage.get("kind"),
                    "status": stage.get("status"),
                    "metadataTruncated": True,
                }
            stage_view["results"] = []
            for result in stage.get("results") or []:
                full_text = str(result.get("_fullText") or "")
                retained = full_text[: max(0, excerpt_chars)]
                truncated = len(retained) < len(full_text)
                if verbosity >= 2:
                    result_view = {
                        key: result.get(key)
                        for key in (
                            "sourceId",
                            "coverageKeys",
                            "retryOf",
                            "status",
                            "ok",
                            "error",
                            "provider",
                            "fallbackUsed",
                            "receiptPath",
                            "receiptSha256",
                            "evidenceRefs",
                            "verification",
                            "limitations",
                            "filesModified",
                            "evidenceGaps",
                            "doneCriteria",
                            "expectedOutput",
                            "expectedEvidence",
                        )
                    }
                elif verbosity == 1:
                    result_view = {
                        key: result.get(key)
                        for key in (
                            "sourceId",
                            "coverageKeys",
                            "status",
                            "ok",
                            "error",
                            "provider",
                            "fallbackUsed",
                            "receiptPath",
                            "receiptSha256",
                            "evidenceGaps",
                        )
                    }
                else:
                    result_view = {
                        key: result.get(key)
                        for key in ("sourceId", "status", "ok")
                    }
                result_view["finalText"] = (
                    retained + ("…" if truncated and retained else "")
                )
                result_view["truncated"] = truncated
                stage_view["results"].append(result_view)
            packet.append(stage_view)
        return packet

    def render(verbosity: int, excerpt_chars: int) -> str:
        return json.dumps(
            build_packet(verbosity, excerpt_chars),
            ensure_ascii=False,
            separators=(",", ":"),
        )

    # Report text is the evidence Main must synthesize. If verbose task
    # contracts alone exceed the packet budget, progressively trim metadata
    # before trimming every report down to nothing. This prevents a large set
    # of self-contained worker prompts from turning a successful barrier into a
    # source-id-only packet.
    selected_verbosity: int | None = None
    for verbosity in (2, 1, 0):
        if len(render(verbosity, 0)) <= max_chars:
            selected_verbosity = verbosity
            break
    if selected_verbosity is not None:
        longest = max(
            (
                len(str(result.get("_fullText") or ""))
                for stage in normalized
                for result in stage.get("results") or []
            ),
            default=0,
        )
        low, high = 0, longest
        while low < high:
            candidate = (low + high + 1) // 2
            if len(render(selected_verbosity, candidate)) <= max_chars:
                low = candidate
            else:
                high = candidate - 1
        return render(selected_verbosity, low)

    # An unusually tiny budget may not fit even the source identities. Preserve
    # stage/result counts as a last resort and mark the packet explicitly.
    counts_only = [
        {
            "stage": stage.get("stage"),
            "kind": stage.get("kind"),
            "status": stage.get("status"),
            "resultCount": len(stage.get("results", [])),
            "packetTruncated": True,
        }
        for stage in normalized
    ]
    return json.dumps(counts_only, ensure_ascii=False, separators=(",", ":"))


def _balanced_json_object(text: str, start: int) -> str:
    """Return the first balanced JSON object at/after ``start``."""
    begin = text.find("{", max(0, start))
    if begin < 0:
        return ""
    depth = 0
    quoted = False
    escaped = False
    for index in range(begin, len(text)):
        char = text[index]
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            continue
        if char == '"':
            quoted = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[begin : index + 1]
    return ""


def _string_list(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(
        text
        for text in (" ".join(str(item or "").split()) for item in value)
        if text
    )


def _bool_value(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().casefold() in {"1", "true", "yes", "on"}


def parse_workflow_decision(text: str) -> WorkflowDecision | None:
    """Parse the last valid ``WORKFLOW_DECISION`` JSON object in ``text``.

    Last-valid wins because an agent loop may emit a draft decision, call a
    native tool, then emit a corrected final decision.
    """
    source = str(text or "")
    positions: list[int] = []
    cursor = 0
    while True:
        found = source.find(DECISION_SENTINEL, cursor)
        if found < 0:
            break
        positions.append(found)
        cursor = found + len(DECISION_SENTINEL)
    for position in reversed(positions):
        raw_object = _balanced_json_object(
            source, position + len(DECISION_SENTINEL)
        )
        if not raw_object:
            continue
        try:
            payload = json.loads(raw_object)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        action = str(payload.get("action") or "").strip().casefold().replace("-", "_")
        if action not in WORKFLOW_ACTIONS:
            continue
        raw_tasks = payload.get("tasks")
        tasks: list[str] = []
        task_contracts: list[dict[str, Any]] = []
        if isinstance(raw_tasks, list):
            for item in raw_tasks:
                if isinstance(item, dict):
                    task = " ".join(
                        str(item.get("task") or item.get("goal") or "").split()
                    )
                    contract_task = task
                    role = " ".join(str(item.get("role") or "").split())
                    skills = item.get("skills")
                    if role:
                        task = f"{task} ROLE:{role}".strip()
                    normalized_skills: list[str] = []
                    if isinstance(skills, list):
                        for skill in skills:
                            name = " ".join(str(skill or "").split())
                            if name:
                                normalized_skills.append(name)
                                task = f"{task} SKILL:{name}".strip()
                    raw_tools = item.get("allowedTools")
                    if raw_tools is None:
                        raw_tools = item.get("allowed_tools")
                    normalized_tools = [
                        " ".join(str(tool or "").split()).lower().replace("-", "_")
                        for tool in (
                            raw_tools
                            if isinstance(raw_tools, list)
                            else (
                                str(raw_tools).split(",")
                                if isinstance(raw_tools, str)
                                else []
                            )
                        )
                        if str(tool or "").strip()
                    ]
                    contract = {
                        "task": contract_task,
                        "role": role,
                        "skills": normalized_skills,
                        "workerModel": " ".join(
                            str(
                                item.get("workerModel")
                                or item.get("worker_model")
                                or ""
                            ).split()
                        )[:180],
                        "allowedTools": list(dict.fromkeys(normalized_tools)),
                        "toolScopeVia": (
                            "main_explicit" if raw_tools is not None else ""
                        ),
                        "coverageKeys": list(
                            workflow_task_coverage_keys(item)
                        ),
                        "doneCriteria": list(
                            _string_list(
                                item.get("doneCriteria")
                                or item.get("done_criteria")
                                or []
                            )
                        ),
                        "expectedOutput": " ".join(
                            str(
                                item.get("expectedOutput")
                                or item.get("expected_output")
                                or ""
                            ).split()
                        )[:1200],
                        "expectedEvidence": (
                            dict(item.get("expectedEvidence"))
                            if isinstance(item.get("expectedEvidence"), Mapping)
                            else (
                                dict(item.get("expected_evidence"))
                                if isinstance(item.get("expected_evidence"), Mapping)
                                else {}
                            )
                        ),
                        "allowSubagents": bool(
                            item.get("allowSubagents")
                            or item.get("allow_subagents")
                        ),
                        "reuseKey": " ".join(
                            str(
                                item.get("reuseKey")
                                or item.get("reuse_key")
                                or item.get("logicalAgentId")
                                or item.get("logical_agent_id")
                                or ""
                            ).split()
                        )[:160],
                        "continuationOf": " ".join(
                            str(
                                item.get("continuationOf")
                                or item.get("continuation_of")
                                or item.get("predecessorTaskId")
                                or item.get("predecessor_task_id")
                                or ""
                            ).split()
                        )[:200],
                        "freshWorker": _bool_value(
                            item.get("freshWorker")
                            or item.get("fresh_worker")
                        ),
                        "retryOf": " ".join(
                            str(
                                item.get("retryOf")
                                or item.get("retry_of")
                                or ""
                            ).split()
                        )[:240],
                        "retryPolicy": (
                            dict(item.get("retryPolicy"))
                            if isinstance(item.get("retryPolicy"), Mapping)
                            else (
                                dict(item.get("retry_policy"))
                                if isinstance(item.get("retry_policy"), Mapping)
                                else {}
                            )
                        ),
                    }
                else:
                    task = " ".join(str(item or "").split())
                    contract = {
                        "task": task,
                        "role": "",
                        "skills": [],
                        "workerModel": "",
                        "allowedTools": [],
                        "toolScopeVia": "",
                        "coverageKeys": list(
                            workflow_task_coverage_keys(task)
                        ),
                        "doneCriteria": [],
                        "expectedOutput": "",
                        "expectedEvidence": {},
                        "allowSubagents": False,
                        "reuseKey": "",
                        "continuationOf": "",
                        "freshWorker": False,
                        "retryOf": "",
                    }
                if task:
                    tasks.append(task)
                    task_contracts.append(contract)
        tasks = tasks[:MAX_TASKS_PER_STAGE]
        task_contracts = task_contracts[:MAX_TASKS_PER_STAGE]
        pattern = " ".join(str(payload.get("pattern") or "").split())[:120]
        reason = " ".join(str(payload.get("reason") or "").split())[:1000]
        stage_goal = " ".join(
            str(payload.get("stageGoal") or payload.get("stage_goal") or "").split()
        )[:1200]
        final_focus = " ".join(
            str(payload.get("finalFocus") or payload.get("final_focus") or "").split()
        )[:1200]
        requested_input = " ".join(
            str(
                payload.get("requestedInput")
                or payload.get("requested_input")
                or ""
            ).split()
        )[:1200]
        completion = _string_list(
            payload.get("completionCriteria")
            or payload.get("completion_criteria")
            or []
        )
        stage_kind = normalize_workflow_stage_kind(
            payload.get("stageKind") or payload.get("stage_kind")
        )
        disagreements = _string_list(payload.get("disagreements") or [])
        reason_code = " ".join(
            str(
                payload.get("reasonCode")
                or payload.get("reason_code")
                or ""
            ).split()
        )[:120]
        raw_planned_stages = (
            payload.get("plannedStages")
            if "plannedStages" in payload
            else payload.get("planned_stages")
        )
        planned_stages = (
            raw_planned_stages
            if isinstance(raw_planned_stages, int)
            and not isinstance(raw_planned_stages, bool)
            else None
        )
        return WorkflowDecision(
            action=action,
            pattern=pattern,
            reason=reason,
            stage_goal=stage_goal,
            tasks=tuple(tasks),
            task_contracts=tuple(task_contracts),
            completion_criteria=completion,
            final_focus=final_focus,
            requested_input=requested_input,
            stage_kind=stage_kind,
            requires_critics=_bool_value(
                payload.get("requiresCritics")
                or payload.get("requires_critics")
            ),
            disagreements=disagreements,
            reason_code=reason_code,
            planned_stages=planned_stages,
            raw=raw_object,
        )
    return None


def collect_workflow_source_text(
    final_text: str = "",
    *,
    messages: list[dict[str, Any]] | None = None,
    steps: list[Any] | None = None,
) -> str:
    """Collect model-visible text so mid-transcript decisions are recoverable."""
    candidates: list[str] = []

    def add(value: Any) -> None:
        text = str(value or "").strip()
        if text:
            candidates.append(text)

    add(final_text)
    for message in reversed(list(messages or [])):
        if not isinstance(message, dict):
            continue
        if str(message.get("role") or "") not in {"assistant", "model"}:
            continue
        content = message.get("content")
        if isinstance(content, str):
            add(content)
        elif isinstance(content, list):
            add(
                "\n".join(
                    str(part.get("text") or part.get("content") or "")
                    if isinstance(part, dict)
                    else str(part)
                    for part in content
                )
            )
    for step in reversed(list(steps or [])):
        if isinstance(step, dict):
            for key in ("text", "content", "final_text", "output", "answer"):
                if key in step:
                    add(step.get(key))
        else:
            add(step)
    marked = [item for item in candidates if DECISION_SENTINEL in item]
    return "\n\n".join(reversed(marked or candidates))


def _pattern_catalog() -> str:
    return "\n".join(f"- {name}: {description}" for name, description in SUGGESTED_PATTERNS)


def _provider_worker_capability_contract(provider_kind: str) -> str:
    if str(provider_kind or "").strip().casefold() != "grok":
        return ""
    return (
        "\nSelected worker-provider boundary:\n"
        "- Grok CLI workers support read-only provider inspection only. "
        "Bash, edit, write, network fetch, and MCP are unavailable inside "
        "the worker transport.\n"
        "- permission=auto or permission=manual does not override this "
        "transport boundary.\n"
        "- Tasks inherit Grok unless they declare workerModel. When the "
        "operator explicitly names and authorizes a configured Sophia-native "
        "execution model, route only that task by setting the exact model "
        'alias, for example "workerModel":"020s". Never invent or silently '
        "substitute a provider.\n"
        "- Do not dispatch execution, mutation, persistence, test-running, "
        "or network/MCP tasks to a task that still resolves to Grok. Use "
        "only read/grep-style inspection scopes for Grok workers.\n"
        "- If the operator goal requires unavailable worker authority and "
        "does not explicitly authorize a tool-capable worker model, emit "
        "action=fail with reasonCode=worker_tool_scope_unavailable instead "
        "of dispatching a task that is guaranteed to be denied.\n"
    )


def workflow_planner_system_extra(
    *,
    configured_mode: str,
    max_stages: int,
    max_agents: int,
    max_tasks_per_stage: int = MAX_TASKS_PER_STAGE,
    active_concurrency_limit: int | None = None,
    provider_kind: str = "",
) -> str:
    """System contract for the initial Main workflow decision."""
    forced = normalize_workflow_mode(configured_mode) == "on"
    stage_limit = max(
        MIN_PARALLEL_TASKS,
        min(
            MAX_TASKS_PER_STAGE,
            int(
                max_tasks_per_stage
                if active_concurrency_limit is None
                else active_concurrency_limit
            ),
        ),
    )
    return (
        "You are Sophia Code, an AI assistant that orchestrates work. You are "
        "Main Workflow Controller and the only agent that talks to the human. "
        "Decide whether this operator request "
        "benefits from a bounded, multi-stage workflow whose individual stages "
        "run independent A2A workers in parallel behind a barrier.\n\n"
        f"Configured mode: {'forced on' if forced else 'automatic worthiness decision'}.\n"
        f"Hard bounds: at most {max_stages} stages and {max_agents} total workers; "
        f"2-{max_tasks_per_stage} queued workers per dispatched barrier, with "
        f"at most {stage_limit} active concurrently. The active limit matches "
        "the selected provider's safe concurrency budget; larger bounded "
        "fan-outs run in provider-safe waves behind the same all-of barrier. "
        "Do not silently turn deferred work into a later stage.\n\n"
        "Suggested patterns (not an exhaustive enum):\n"
        f"{_pattern_catalog()}\n\n"
        "You may combine, rename, or invent a better workflow shape. Prefer the "
        "smallest sufficient workflow. A workflow is worthwhile when the task "
        "needs multiple evidence-producing or implementation stages, independent "
        "parallel work inside a stage, and a later decision that depends on the "
        "whole prior-stage barrier. A simple question, one-file edit, or single "
        "linear investigation is not workflow-worthy.\n\n"
        "Coordinator discipline:\n"
        "- Workers have isolated context windows and cannot see this conversation, "
        "another worker's output, or unstated assumptions.\n"
        "- Each task must be fully self-contained and name scope, relevant context, "
        "observable done criteria, and expected report format.\n"
        "- Prefer parallel research/verification and serialize overlapping writes.\n"
        "- The harness owns all communication and barriers. Do not converse with or "
        "thank workers; their free-form text is not a peer messaging channel.\n"
        "- After every barrier, independently analyze all reports. Never rubber-stamp "
        "a worker completion claim.\n"
        "- Workers must not spawn further agents unless a task explicitly grants it.\n\n"
        "Harness selection discipline:\n"
        "- Main must choose a suitable role, the smallest useful skills set, and "
        "the narrowest native allowedTools list for every dispatched worker. "
        "Omitting allowedTools applies a read-only fail-closed floor.\n"
        "- Do not attach citation, source-verification, ontology, or domain-modeling "
        "skills to a local code audit unless the worker must actually verify external "
        "sources or build a domain model. Irrelevant skill cards consume context and "
        "can cause unnecessary tool loops.\n"
        "- A critic task that depends on prior reports must name each required "
        "sourceId exactly. The harness uses those ids to deliver a focused packet.\n\n"
        f"{_provider_worker_capability_contract(provider_kind)}\n"
        "Make the routing decision from the complete operator request and supplied "
        "conversation context. Do not call native tools, delegate, or launch agents "
        "yourself; routing must be side-effect free because automatic mode may fall "
        "back to the ordinary solo loop. End with exactly "
        "one JSON decision after the sentinel below:\n\n"
        f"{DECISION_SENTINEL}\n"
        '{"action":"dispatch|skip|fail","pattern":"free-form workflow name",'
        '"reason":"why","stageKind":"specialist|general",'
        f'"plannedStages":{min(2, max_stages)},'
        '"requiresCritics":false,"stageGoal":"what stage 1 must establish",'
        '"tasks":[{"task":"self-contained independent task with scope and evidence",'
        '"role":"role-id","skills":["skill-id"],'
        '"workerModel":"optional exact operator-authorized model alias",'
        '"allowedTools":["read_file","grep"],'
        '"doneCriteria":["observable condition"],'
        '"expectedOutput":"bounded worker report shape",'
        '"reuseKey":"optional stable logical agent id",'
        '"continuationOf":"optional prior task id",'
        '"freshWorker":false}],'
        '"completionCriteria":["observable condition"]}\n\n'
        "Rules:\n"
        "- dispatch requires at least two genuinely independent tasks.\n"
        "- tasks must declare role, skills, and allowedTools when dispatching; "
        "the harness validates them and intersects tools with the parent scope.\n"
        "- workerModel is optional and inherits Main when omitted. Any explicit "
        "cross-provider value must be named in the operator request; invalid or "
        "unauthorized values fail closed before worker launch.\n"
        "- stageKind names one barrier only; never mix specialist and critic "
        "work inside the same dispatched stage.\n"
        f"- plannedStages is Main's current estimate of the total barriers; "
        f"use an integer from 1 to {max_stages}. The harness may revise it after "
        "later barriers, but it is not permission to exceed the hard bound.\n"
        "- reuseKey/continuationOf may request a warm logical-agent continuation "
        "only for recovery, refinement, or implementation_follow_up. Critics, "
        "security/source/attribution reviewers, and tiebreakers must be fresh.\n"
        "- set requiresCritics=true when the operator requires a later, "
        "separate critic/reviewer barrier.\n"
        "- do not add fake tasks merely to reach two.\n"
        "- if automatic mode and a dynamic workflow is unnecessary, action=skip.\n"
        + (
            "- forced mode must dispatch unless the request is unsafe or impossible; "
            "then action=fail with the exact blocker.\n"
            if forced
            else ""
        )
        + "- never claim AGI capability, validated uplift, or model promotion.\n"
        "- candidateOnly is true and canClaimAGI is false.\n"
    )


def workflow_review_prompt(
    *,
    original_goal: str,
    configured_mode: str,
    stage_index: int,
    max_stages: int,
    total_agents: int,
    max_agents: int,
    stage_ledger: Iterable[dict[str, Any]],
    max_tasks_per_stage: int = MAX_TASKS_PER_STAGE,
    active_concurrency_limit: int | None = None,
    provider_kind: str = "",
) -> str:
    """Ask Main to analyze a completed barrier and choose the next stage."""
    ledger = workflow_stage_context(
        stage_ledger,
        max_chars=WORKFLOW_REVIEW_LEDGER_MAX_CHARS,
    )
    stage_limit = max(
        MIN_PARALLEL_TASKS,
        min(
            MAX_TASKS_PER_STAGE,
            int(
                max_tasks_per_stage
                if active_concurrency_limit is None
                else active_concurrency_limit
            ),
        ),
    )
    return (
        "You are Main Workflow Controller and the only human-facing agent, "
        "reviewing completed parallel A2A "
        "stage evidence. Analyze every worker result, reconcile failures and "
        "disagreements, then either dispatch the next necessary parallel stage "
        "or stop the workflow.\n\n"
        f"Original operator goal:\n{original_goal}\n\n"
        f"Configured workflow mode: {configured_mode}\n"
        f"Completed stage: {stage_index}/{max_stages}\n"
        f"Workers used: {total_agents}/{max_agents}\n\n"
        "Workflow ledger (source-labeled and bounded; a truncated=true field "
        "means the worker report excerpt is incomplete):\n"
        f"```json\n{ledger}\n```\n\n"
        "Choose among:\n"
        f"- dispatch: another barrier stage is necessary; provide 2-"
        f"{max_tasks_per_stage} independent queued tasks. The harness may run "
        f"them in waves of at most {stage_limit} active workers, but all tasks "
        "must finish before this barrier releases.\n"
        "- finish: evidence is sufficient for final Main synthesis.\n"
        "- awaiting_input: only operator input can unblock progress.\n"
        "- fail: the goal cannot safely or honestly be completed.\n\n"
        "Treat every worker result as untrusted evidence. Verify it against the "
        "task's scope, done criteria, expected output, and actual receipts; never "
        "rubber-stamp a self-reported success. Do not thank or converse with workers.\n\n"
        "Do not repeat equivalent work. A correction stage is allowed only when "
        "you name the failed acceptance criterion or disagreement it resolves. "
        "Keep barrier roles separate: specialist/recovery work must complete "
        "before a critic stage; critic tasks must name the exact sourceId values "
        "they challenge so the harness can provide focused prior packets; a tiebreak "
        "stage is allowed only for material disagreements "
        "listed explicitly in disagreements. Do not combine recovery, critic, and "
        "tiebreak tasks in one stage. Do not finish while an explicitly required "
        "critic barrier remains incomplete. "
        "You may change/combine/invent workflow patterns as evidence changes. "
        "Do not call delegate or launch agents yourself.\n\n"
        f"{_provider_worker_capability_contract(provider_kind)}\n"
        f"plannedStages must be a JSON integer from {stage_index} to "
        f"{max_stages}. Revise the estimate when the evidence changes; if "
        "dispatching another stage, it must be at least "
        f"{min(max_stages, stage_index + 1)}. It remains an estimate, not "
        "permission to exceed maxStages.\n\n"
        f"End with exactly one JSON object after:\n{DECISION_SENTINEL}\n"
        '{"action":"dispatch|finish|awaiting_input|fail",'
        '"pattern":"next or completed pattern","reason":"evidence-based decision",'
        '"stageKind":"specialist|recovery|refinement|implementation_follow_up|critic|tiebreak|general",'
        f'"plannedStages":{min(max_stages, stage_index + 1)},'
        '"requiresCritics":false,"disagreements":["material disagreement"],'
        '"stageGoal":"next stage goal when dispatching",'
        '"tasks":[{"task":"self-contained independent task","role":"role-id",'
        '"skills":["skill-id"],'
        '"workerModel":"optional exact operator-authorized model alias",'
        '"allowedTools":["read_file","grep"],'
        '"doneCriteria":["observable condition"],'
        '"expectedOutput":"bounded worker report shape",'
        '"reuseKey":"optional stable logical agent id",'
        '"continuationOf":"optional prior task id",'
        '"freshWorker":false}],'
        '"completionCriteria":["observable condition"],'
        '"finalFocus":"what final synthesis must emphasize",'
        '"requestedInput":"only for awaiting_input"}\n\n'
        "Role, skills, and allowedTools are dispatch decisions. Use the smallest "
        "native tool set that can complete the task; omission fails closed to "
        "read-only. Do not attach source-verification or domain-modeling to "
        "ordinary local code review. Critic tasks must include "
        "the exact prior sourceId values they need. workerModel is optional "
        "and inherits Main when omitted; explicit cross-provider routing must "
        "name a model the operator authorized in the original request and "
        "fails closed otherwise.\n\n"
        "candidateOnly is true; canClaimAGI is false.\n"
    )


def workflow_final_synthesis_prompt(
    *,
    original_goal: str,
    stage_ledger: Iterable[dict[str, Any]],
    final_decision: WorkflowDecision,
) -> str:
    """Final Main answer prompt; the active Sophia Code delivery policy applies."""
    ledger = workflow_stage_context(
        stage_ledger,
        max_chars=WORKFLOW_FINAL_LEDGER_MAX_CHARS,
    )
    return (
        "You are Main Agent, the coordinator and only human-facing participant, "
        "performing the final synthesis of a "
        "completed dynamic workflow. Answer the original operator goal using the "
        "workflow evidence below. Reconcile disagreements, distinguish verified "
        "facts from model interpretation, retain material limitations, and do not "
        "invent missing evidence. Never rubber-stamp worker verdicts and do not "
        "thank or address workers as conversation partners.\n\n"
        f"Original operator goal:\n{original_goal}\n\n"
        f"Final controller decision:\n{json.dumps(final_decision.to_dict(), ensure_ascii=False, indent=2)}\n\n"
        "Complete workflow ledger (source-labeled and bounded; a "
        "truncated=true field means the report excerpt is incomplete):\n"
        f"```json\n{ledger}\n```\n\n"
        "The ledger above is the only worker-evidence packet available in this "
        "answer-only pass. Native tools are disabled. Do not narrate tool use, "
        "claim that you recovered fuller reports, or claim an independent source "
        "inspection that is not explicitly present in the ledger. When an excerpt "
        "is truncated, state the limitation and synthesize only its retained text.\n\n"
        "Do not emit another WORKFLOW_DECISION or dispatch. Produce one clear "
        "operator-facing answer, followed by a compact WORKFLOW_LOG listing each "
        "stage pattern, worker count, and verdict. State candidateOnly:true and "
        "canClaimAGI:false when the task is an integration/evaluation report; do "
        "not claim AGI capability, validated uplift, or model promotion.\n"
    )


def workflow_decision_repair_prompt(
    *,
    phase: str,
    original_goal: str,
    invalid_source: str,
    stage_ledger: Iterable[dict[str, Any]] = (),
) -> str:
    """Request one compact, tool-free repair of an invalid controller object."""
    source = str(invalid_source or "").strip()
    if len(source) > WORKFLOW_DECISION_REPAIR_SOURCE_MAX_CHARS:
        source = (
            source[:WORKFLOW_DECISION_REPAIR_SOURCE_MAX_CHARS]
            + "\n…[invalid controller source truncated]"
        )
    ledger = workflow_stage_context(
        stage_ledger,
        max_chars=WORKFLOW_REVIEW_LEDGER_MAX_CHARS,
    )
    return (
        "You are repairing a malformed Sophia workflow-controller response. "
        "Do not continue the audit, call tools, narrate reasoning, or repeat "
        "worker reports. Recover the intended bounded controller action from "
        "the source and ledger. If the intended action cannot be recovered "
        "safely, emit action=fail with reasonCode=controller_decision_unrecoverable.\n\n"
        f"Controller phase: {phase}\n"
        f"Original operator goal:\n{original_goal}\n\n"
        f"Bounded stage ledger:\n```json\n{ledger}\n```\n\n"
        f"Invalid controller source:\n```text\n{source}\n```\n\n"
        "Output exactly this sentinel followed by one complete JSON object and "
        "nothing else:\n"
        f"{DECISION_SENTINEL}\n"
        '{"action":"dispatch|finish|skip|awaiting_input|fail",'
        '"pattern":"workflow pattern","reason":"brief evidence-based reason",'
        '"reasonCode":"optional stable code",'
        '"stageKind":"specialist|recovery|critic|tiebreak|general",'
        '"requiresCritics":false,"disagreements":[],'
        '"stageGoal":"required only for dispatch",'
        '"tasks":[{"task":"self-contained task","role":"optional role",'
        '"skills":[],"doneCriteria":["observable condition"],'
        '"expectedOutput":"bounded report"}],'
        '"completionCriteria":[],"finalFocus":"brief synthesis focus",'
        '"requestedInput":"only for awaiting_input"}\n'
        "candidateOnly is true; canClaimAGI is false.\n"
    )


__all__ = [
    "DEFAULT_MAX_AGENTS",
    "DEFAULT_MAX_STAGES",
    "DECISION_SENTINEL",
    "MAX_AGENTS_SAFETY",
    "MAX_STAGES_SAFETY",
    "MAX_TASKS_PER_STAGE",
    "MIN_PARALLEL_TASKS",
    "KNOWN_PLUGIN_AUDIT_TEMPLATE_ID",
    "KNOWN_TUI_PARALLEL_BARRIER_SMOKE_TEMPLATE_ID",
    "KNOWN_DIRECT_TEST_EXECUTION_TEMPLATE_ID",
    "PLUGIN_AUDIT_COVERAGE_KEYS",
    "TUI_PARALLEL_BARRIER_COVERAGE_KEYS",
    "DIRECT_TEST_EXECUTION_COVERAGE_KEYS",
    "TUI_BARRIER_NAMED_TEST_COMMAND",
    "TUI_DIRECT_TEST_COMMANDS",
    "attach_named_test_exitcode",
    "named_test_exitcode_step",
    "prepare_named_test_for_worker",
    "SUGGESTED_PATTERNS",
    "WORKFLOW_STAGE_KINDS",
    "WORKFLOW_CRITIC_CONTEXT_MAX_CHARS",
    "WorkflowDecision",
    "collect_workflow_source_text",
    "infer_workflow_stage_kind",
    "known_plugin_audit_stages",
    "known_tui_parallel_barrier_smoke_stages",
    "known_direct_test_execution_stages",
    "workflow_board_todo_items",
    "normalize_workflow_coverage_keys",
    "normalize_workflow_max_agents",
    "normalize_workflow_max_stages",
    "normalize_workflow_mode",
    "normalize_workflow_stage_kind",
    "parse_workflow_decision",
    "workflow_compact_worker_context",
    "workflow_referenced_source_ids",
    "workflow_completed_coverage",
    "workflow_decision_repair_prompt",
    "workflow_deterministic_recovery_decision",
    "workflow_filter_completed_tasks",
    "workflow_final_synthesis_prompt",
    "workflow_planner_system_extra",
    "workflow_requires_critic_barrier",
    "workflow_review_prompt",
    "worker_report_status",
    "workflow_stage_context",
    "workflow_task_coverage_keys",
]
