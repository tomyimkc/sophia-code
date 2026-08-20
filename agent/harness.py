# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Agent harness for Sophia AGI: plan -> execute -> critic -> reflect/retry.

Built on the unified model adapter (agent/model.py). Reuses existing pieces as
components rather than rebuilding them:
  - critic     : agent.gate.check_response (epistemic gate) by default; any
                 verifier callable can be plugged in (unit tests, score_pack, etc.).
  - executor   : agent.tools.run_tool (approval-gated repo tools) + registered
                 python callables.
  - context    : agent.retrieval (optional), skill workflows.

Provides: model-driven planner, tool calling, a reflection/retry loop, append-only
decision logs, task-state persistence with checkpoint/resume, and failure
classification. Offline-testable via the model adapter's mock provider.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from agent.config import ROOT
from agent.context_manager import compact_history
from agent.runtime_paths import user_state_dir
from agent.gate import check_response
from agent.model import ModelClient, ModelResult
from agent.prompts import MODE_PROMPTS
from agent.tools import TOOL_CATALOG, parse_tool_requests, run_tools
from agent.untrusted import wrap_untrusted
from agent.efficiency_receipt import EfficiencyReceipt, JoinIds, ModelEfficiency, ThesisMetrics, BrainstormingMetrics

RUNS_DIR = user_state_dir() / "agent_runs"

FAILURE_CLASSES = (
    "empty_output",
    "model_error",
    "tool_error",
    "gate_violation",
    "verifier_fail",
    "exception",
    "max_retries_exhausted",
    "unknown",
)

# A verifier takes (text, task, step) and returns {"passed", "reasons", "detail"}.
Verifier = Callable[[str, "AgentTask", dict], dict]

# An action admitter (Harness-Roadmap Build 3) takes (tool_name, task, step) and returns a
# gui_action_gate decision dict; only an "execute" verdict lets the tool run. Opt-in: when
# None (the default) the harness behaves exactly as before. See agent/gui_action_gate.py.
ActionAdmitter = Callable[[str, "AgentTask", dict], dict]


@dataclass
class AgentTask:
    goal: str
    mode: str = "advisor"  # advisor | repo | life
    task_id: str = ""
    context: str = ""
    skill: dict[str, Any] | None = None
    role_id: str = ""  # role-library provenance tag (thesis §7.1); harness behavior unchanged
    # --- v0 channel additions (APPENDED + defaulted → no positional caller breaks;
    # every AgentTask(...) call site in the tree is keyword-only). The harness loop
    # itself does not read these; a Channel adapter (agent/channels/) sets them and
    # converts deadline_iso→deadline_monotonic, reusing the existing cooperative
    # deadline stop. session_id groups tasks that share memory + identity. ---
    channel: str = "cli"        # transport that produced this task ("cli" | "mcp" | …)
    session_id: str = ""        # groups tasks sharing memory/identity; defaults to task_id
    deadline_iso: str = ""      # ISO-8601 wall-clock budget for the whole task; "" = unbounded
    memory_ttl_sec: float | None = None
    replay_policy: str = "allow"

    def __post_init__(self) -> None:
        if not self.task_id:
            slug = re.sub(r"[^a-z0-9]+", "-", self.goal.lower())[:40].strip("-") or "task"
            self.task_id = slug
        if not self.session_id:  # a lone task is a session of one
            self.session_id = self.task_id


@dataclass
class StepResult:
    step_id: str
    description: str
    action: str
    output: str = ""
    ok: bool = False
    attempts: int = 0
    failure_class: str | None = None
    reasons: list[str] = field(default_factory=list)
    tool_results: list[dict] = field(default_factory=list)
    cost_usd: float = 0.0
    latency_sec: float = 0.0


@dataclass
class AgentResult:
    task_id: str
    ok: bool
    final_text: str
    steps: list[StepResult]
    failures: list[str]
    cost_usd: float
    latency_sec: float
    trace_path: str
    receipt: EfficiencyReceipt | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RunStore:
    """Append-only decision log + checkpoint state for one agent run."""

    def __init__(self, task_id: str, *, runs_dir: Path = RUNS_DIR):
        self.task_id = task_id
        self.log_path = runs_dir / f"{task_id}.jsonl"
        self.state_path = runs_dir / f"{task_id}.state.json"
        self.events: list[dict] = []
        self.state: dict[str, Any] = {"taskId": task_id, "completedSteps": [], "final": None}

    def fresh(self) -> "RunStore":
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_path.write_text("", encoding="utf-8")
        self._save_state()
        return self

    def resume(self) -> "RunStore":
        if self.log_path.exists():
            self.events = [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if self.state_path.exists():
            self.state = json.loads(self.state_path.read_text(encoding="utf-8"))
        return self

    def log(self, event_type: str, **fields: Any) -> None:
        record = {"ts": _now(), "type": event_type, **fields}
        self.events.append(record)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def mark_done(self, step_id: str, output: str) -> None:
        if step_id not in self.state["completedSteps"]:
            self.state["completedSteps"].append(step_id)
        self.state.setdefault("stepOutputs", {})[step_id] = output
        self._save_state()

    def set_final(self, text: str) -> None:
        self.state["final"] = text
        self._save_state()

    def _save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(self.state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def classify_failure(*, result: ModelResult | None, gate: dict | None, verifier: dict | None, tool_results: list[dict] | None) -> str:
    if result is not None and not result.ok:
        return "model_error"
    if result is not None and result.ok and not result.text.strip():
        return "empty_output"
    if tool_results and any(not t.get("ok") for t in tool_results):
        return "tool_error"
    if gate is not None and not gate.get("passed", True):
        return "gate_violation"
    if verifier is not None and not verifier.get("passed", True):
        return "verifier_fail"
    return "unknown"  # cause not identified — do NOT credit it to the verifier (taints ablations)


# --------------------------------------------------------------------------- #
# H2 episodic memory bridge (opt-in, fail-soft)
#
# The harness already produces a per-step gate/verifier decision (ok + a
# failure_class taxonomy). H2 episodic memory (agent/episodic_memory.py) wants that
# decision as an *episode* tagged with one of its valid verdicts
# (allow|revise|retrieve|clarify|escalate|abstain|block). We map, we do not
# re-decide: a passed step is a terminal ``allow``; a failed step is classified from
# the failure_class the loop already computed. This is a record of what the loop
# asserted, never a second gate.
# --------------------------------------------------------------------------- #

# Loop failure_class -> episodic gateVerdict. Follow-up (open) verdicts are used for
# any unresolved step so a killed multi-step run can see it is still owed work;
# terminal (closed) verdicts mark a decision the loop finished.
_FAILCLASS_TO_VERDICT = {
    "gate_violation": "revise",       # rewrite to clear the epistemic gate
    "verifier_fail": "revise",        # rewrite to satisfy the verifier
    "empty_output": "revise",         # produced nothing — re-work
    "tool_error": "retrieve",         # a tool/source failed — fetch again
    "model_error": "escalate",        # transport/model failure — stronger process
    "max_retries_exhausted": "escalate",  # loop gave up — owes a human/next turn
    "exception": "escalate",
    "unknown": "escalate",            # cause unknown — conservatively still open
}


def _step_verdict(outcome: StepResult) -> str:
    """Map the loop's per-step decision to an episodic gateVerdict.

    A passed step is the loop's terminal ``allow``. A failed step is classified from
    the ``failure_class`` the loop already computed (never re-derived here); anything
    unmapped is conservatively ``escalate`` (open) rather than a silent terminal pass.
    """
    if outcome.ok:
        return "allow"
    return _FAILCLASS_TO_VERDICT.get(outcome.failure_class or "unknown", "escalate")


def _step_sources(outcome: StepResult) -> list[str]:
    """Citations/tool sources for the step: the names of the tools it actually ran
    (successful or not is recorded on the episode's verdict, not dropped here)."""
    sources: list[str] = []
    for tr in outcome.tool_results or []:
        name = tr.get("tool")
        if name and name not in sources:
            sources.append(str(name))
    return sources


def _record_step_episode(memory, store: "RunStore", task: "AgentTask", outcome: StepResult, ts) -> None:
    """Record one provenance-tagged episode for an executed step. Fail-soft: a memory
    backend error is logged to the run trace and swallowed so it never crashes the run.

    ``ts`` is supplied by the caller (the harness's own step stamp); this helper never
    reads a clock. The episode is a *record* of the loop's decision — it does not
    re-execute the gate.
    """
    if memory is None:
        return
    try:
        verdict = _step_verdict(outcome)
        memory.record_episode(
            action=f"{outcome.step_id}: {outcome.description}",
            agent=task.mode,
            gateVerdict=verdict,
            sources=_step_sources(outcome),
            taskId=task.task_id,
            ts=ts,
        )
        store.log("episode_record", step=outcome.step_id, gateVerdict=verdict)
    except Exception as exc:  # memory must NEVER fail the run
        store.log("episode_record_skip", step=outcome.step_id, error=repr(exc))


def _seed_from_memory(memory, store: "RunStore") -> None:
    """Expose the resume path: log which prior episodes are still open so a killed
    multi-step run can see its outstanding follow-ups. Honest — it reads the record
    store's classification, it does not re-execute any gate. Fail-soft."""
    if memory is None:
        return
    try:
        snapshot = memory.resume_state()
        store.log(
            "episodic_resume",
            backend=snapshot.get("backend"),
            openCount=snapshot.get("openCount"),
            closedCount=snapshot.get("closedCount"),
            pendingByTask=snapshot.get("pendingByTask"),
        )
    except Exception as exc:  # resume seeding must NEVER fail the run
        store.log("episodic_resume_skip", error=repr(exc))


def gate_verifier(text: str, task: "AgentTask", step: dict) -> dict:
    gate = check_response(text, mode=task.mode if task.mode in {"advisor", "repo", "life"} else "advisor", question=task.goal)
    return {
        "passed": bool(gate.get("passed")),
        "reasons": list(gate.get("warnings", [])) + list(gate.get("violations", [])),
        "detail": {"gate": gate},
    }


def skill_keyword_verifier(must_include: list[str]) -> Verifier:
    """Verifier that the output mentions each required token (skill output check)."""

    def _verify(text: str, task: "AgentTask", step: dict) -> dict:
        lowered = text.lower()
        missing = [kw for kw in must_include if kw.lower() not in lowered]
        return {"passed": not missing, "reasons": [f"missing: {kw}" for kw in missing], "detail": {"missing": missing}}

    return _verify


# --------------------------------------------------------------------------- #
# Planner
# --------------------------------------------------------------------------- #


def _memory_recall(goal: str, *, max_pages: int = 3, search_fn=None, graph=None) -> str:
    """Recall relevant OKF wiki pages at plan time (prior knowledge + provenance
    warnings), annotated with the belief graph's EFFECTIVE confidence so a page
    that launders weak provenance into a confident claim is shown as capped, not
    at face value. Never raises — recall failure must not break planning.

    ``search_fn`` / ``graph`` are injectable for testing; by default they wire
    wiki_store search and a graph built over the whole corpus.
    """
    try:
        if search_fn is None:
            from agent import wiki_store

            search_fn = wiki_store.search
        pages = search_fn(goal, top_k=max_pages)
        if not pages:
            return ""
        if graph is None:
            import okf
            from agent import wiki_store

            graph = okf.build_graph(wiki_store.load_all_pages())
        lines = [_recall_line(page, graph) for page in pages]
        return "## Memory (prior knowledge — build on it, respect the warnings)\n" + "\n".join(lines)
    except Exception:
        return ""


def _recall_line(page, graph) -> str:
    """One memory bullet: page id + effective (graph) confidence + provenance warnings."""
    import okf

    dna = page.meta.get("doNotAttributeTo") or []
    dnm = page.meta.get("doNotMergeWith") or []
    conf = page.meta.get("authorConfidence")
    belief = okf.belief(graph, page.id) if graph is not None else {}
    note = ""
    if conf:
        note += f" (confidence={conf}"
        if belief.get("found"):
            note += f", effectiveRank={belief['effectiveConfidenceRank']}/{belief['confidenceRank']}"
        note += ")"
    if belief.get("confidenceLaundered"):
        note += " ⚠ confidence capped by weak provenance."
    if dna:
        note += f" ⚠ do-not-attribute: {', '.join(dna)}."
    if dnm:
        note += f" ⚠ do-not-merge: {', '.join(dnm)}."
    return f"- [[{page.id}]]{note}"


def _scoped_catalog(allowed_tools: "set[str] | None") -> list[str]:
    """Tool names this run may use: all of TOOL_CATALOG, or the allowed subset
    (least-privilege scoping for subagents). An unknown name in the scope is
    ignored — the scope can only ever *narrow* the catalog, never widen it."""
    if allowed_tools is None:
        return list(TOOL_CATALOG)
    return [t for t in TOOL_CATALOG if t in allowed_tools]


def plan(task: AgentTask, client: ModelClient, *, max_steps: int = 4, allowed_tools: "set[str] | None" = None) -> list[dict]:
    """Ask the model for a compact JSON plan; fall back to a single answer step."""
    skill_block = ""
    if task.skill:
        skill_block = (
            f"\nUse this skill workflow:\n- when: {task.skill.get('whenToUse', '')}\n"
            + "\n".join(f"- step: {s}" for s in task.skill.get("workflow", []))
        )
    memory_block = _memory_recall(task.goal)
    catalog = _scoped_catalog(allowed_tools)
    system = "You are a planner. Output ONLY a JSON array of steps."
    parts = [f"Goal: {task.goal}\nMode: {task.mode}\n{task.context}{skill_block}"]
    if memory_block:
        parts.append(memory_block)
    parts.append(
        f"Available repo tools: {', '.join(catalog) or '(none)'}.\n"
        f"Return up to {max_steps} steps as JSON: "
        '[{"id":"s1","description":"...","action":"model|tool","tool":"<tool name or empty>"}].'
    )
    user = "\n\n".join(parts)
    result = client.generate(system, user)
    steps = _parse_plan(result.text, max_steps=max_steps, catalog=catalog)
    if not steps:
        steps = [{"id": "s1", "description": task.goal, "action": "model", "tool": ""}]
    return steps


def _parse_plan(text: str, *, max_steps: int, catalog: "list[str] | None" = None) -> list[dict]:
    allowed = TOOL_CATALOG if catalog is None else set(catalog)
    candidate = text
    fence = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", text, re.DOTALL)
    if fence:
        candidate = fence.group(1)
    else:
        start, end = text.find("["), text.rfind("]")
        if start >= 0 and end > start:
            candidate = text[start : end + 1]
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    steps: list[dict] = []
    for index, item in enumerate(data[:max_steps], 1):
        if not isinstance(item, dict):
            continue
        steps.append(
            {
                "id": str(item.get("id") or f"s{index}"),
                "description": str(item.get("description") or item.get("desc") or "step"),
                "action": "tool" if str(item.get("action")) == "tool" and item.get("tool") in allowed else "model",
                "tool": item.get("tool") if item.get("tool") in allowed else "",
            }
        )
    return steps


# --------------------------------------------------------------------------- #
# Executor + reflection/retry loop
# --------------------------------------------------------------------------- #


def _build_step_prompt(task: AgentTask, step: dict, prior: str, reflection: str | None) -> tuple[str, str]:
    system = MODE_PROMPTS.get(task.mode, MODE_PROMPTS["advisor"])
    parts = [f"## Goal\n{task.goal}", f"## Current step\n{step['description']}"]
    if task.context:
        # external context is untrusted -> fence it against prompt injection
        parts.append("## Context\n" + wrap_untrusted(task.context, "task-context"))
    if task.skill:
        parts.append("## Skill verification\n" + "\n".join(f"- {v}" for v in task.skill.get("verification", [])))
    if prior:
        parts.append(f"## Prior step outputs\n{prior}")
    if reflection:
        parts.append(f"## Reflection on the previous failed attempt — fix these\n{reflection}")
    parts.append("End with a Decision section and a short 中文摘要.")
    return system, "\n\n".join(parts)


def _execute_step(
    task: AgentTask,
    step: dict,
    *,
    client: ModelClient,
    store: RunStore,
    verifier: Verifier,
    prior: str,
    max_retries: int,
    approve_tools: bool,
    allowed_tools: "set[str] | None" = None,
    admit_action: "ActionAdmitter | None" = None,
) -> StepResult:
    result = StepResult(step_id=step["id"], description=step["description"], action=step["action"])
    reflection: str | None = None
    for attempt in range(1, max_retries + 2):
        result.attempts = attempt
        store.log("step_attempt", step=step["id"], attempt=attempt, action=step["action"])
        system, user = _build_step_prompt(task, step, prior, reflection)
        model_result = client.generate(system, user)
        store.log("model_call", step=step["id"], **model_result.to_log())
        result.cost_usd += model_result.cost_usd
        result.latency_sec += model_result.latency_sec
        text = model_result.text

        tool_results: list[dict] = []
        if step["action"] == "tool" or "{\"tools\"" in text or "```json" in text:
            requested = parse_tool_requests(text)
            allowed_requests = requested
            # Least-privilege: a tool requested outside this run's scope is refused
            # fail-closed (recorded as a failed result so the step does not pass).
            if allowed_tools is not None and requested:
                blocked = [t for t in requested if t not in allowed_tools]
                allowed_requests = [t for t in requested if t in allowed_tools]
                if blocked:
                    store.log("tool_scope_block", step=step["id"], blocked=blocked)
                    tool_results.extend({"tool": t, "ok": False, "error": "out of subagent tool scope"} for t in blocked)
            # Action admission (Harness-Roadmap Build 3, opt-in): a high-risk/irreversible
            # tool is withheld fail-closed (recorded as a failed result so the step does not
            # pass) and routed to a human, even if tools were globally approved. No-op when
            # admit_action is None. The admitter's decision is logged for the audit trail.
            if admit_action is not None and allowed_requests:
                admitted: list[str] = []
                for t in allowed_requests:
                    decision = admit_action(t, task, step)
                    if decision.get("verdict") == "execute":
                        admitted.append(t)
                    else:
                        store.log("action_admission_block", step=step["id"], tool=t,
                                  verdict=decision.get("verdict"), reasons=decision.get("reasons", []))
                        tool_results.append({"tool": t, "ok": False,
                                             "error": f"action admission: {decision.get('verdict')}"})
                allowed_requests = admitted
            if allowed_requests:
                tool_results.extend(run_tools(allowed_requests, approved=approve_tools))
            if tool_results:
                # ArkDistill: compact noisy tool output for the trace/log path only.
                # The ORIGINAL tool_results (with verbatim `ok`) drive the pass/fail
                # check below — distillation never touches them, so the gate path is
                # byte-identical. The distilled view shrinks the SFT/DPO trace logs
                # and feeds a saved-token accounting (Sentinel savings ledger).
                from agent.arkdistill import distill_tool_result

                logged = [distill_tool_result(t) for t in tool_results]
                saved = sum(t.get("arkdistill", {}).get("saved_tokens", 0) for t in logged)
                # log the ORIGINAL requested list so blocked tools are visible alongside their results
                store.log("tool_call", step=step["id"], requested=requested, results=logged)
                if saved > 0:
                    store.log("arkdistill", step=step["id"], savedTokens=saved,
                              profiles=[t.get("arkdistill", {}).get("profile") for t in logged if t.get("arkdistill")])
        result.tool_results = tool_results

        gate_check = gate_verifier(text, task, step)
        verify = verifier(text, task, step) if verifier is not gate_verifier else gate_check
        store.log("critic", step=step["id"], gatePassed=gate_check["passed"], verifierPassed=verify["passed"], reasons=verify.get("reasons", []))

        passed = model_result.ok and bool(text.strip()) and verify.get("passed", False) and all(t.get("ok") for t in tool_results)
        result.output = text
        fclass = None if passed else classify_failure(result=model_result, gate=gate_check, verifier=verify, tool_results=tool_results)
        # full output is logged (gitignored run dir) so collect_traces can build SFT/DPO data
        store.log("step_output", step=step["id"], attempt=attempt, passed=passed, failureClass=fclass, output=text)
        if passed:
            result.ok = True
            result.reasons = []
            result.failure_class = None
            store.log("step_done", step=step["id"], attempts=attempt)
            return result

        result.failure_class = fclass
        result.reasons = verify.get("reasons", []) or ([model_result.error] if model_result.error else [])
        if attempt <= max_retries:
            reflection = _reflect(client, task, text, result.reasons)
            store.log("reflect", step=step["id"], failureClass=result.failure_class, reflection=reflection)
        else:
            result.failure_class = "max_retries_exhausted"
            store.log("step_failed", step=step["id"], failureClass=result.failure_class, reasons=result.reasons)
    return result


def _reflect(client: ModelClient, task: AgentTask, last_output: str, reasons: list[str]) -> str:
    system = "You are a critic. In 2-4 bullet points, say exactly how to fix the answer. No rewrite."
    user = f"Goal: {task.goal}\nReasons it failed: {reasons}\nLast answer:\n{last_output[:1500]}"
    result = client.generate(system, user)
    return result.text.strip() if result.ok else f"Address: {', '.join(reasons)}"


def run_agent(
    task: AgentTask,
    *,
    client: ModelClient | None = None,
    verifier: Verifier | None = None,
    max_retries: int = 2,
    max_steps: int = 4,
    approve_tools: bool = False,
    resume: bool = False,
    consolidate: bool = False,
    allowed_tools: "set[str] | None" = None,
    conscience_gate: bool | None = None,
    admit_action: "ActionAdmitter | None" = None,
    deadline_monotonic: float | None = None,
    memory: "EpisodicMemory | None" = None,
) -> AgentResult:
    """Run the full plan -> execute -> critic -> reflect/retry loop.

    When ``consolidate=True``, a verified run folds its conclusion into a gated OKF
    memory page so future runs can recall it (continual learning, off by default).

    When ``memory`` (an :class:`agent.episodic_memory.EpisodicMemory`) is supplied, each
    executed step is recorded as a provenance-tagged episode whose ``gateVerdict`` is
    mapped from the loop's own per-step decision, and the run seeds from
    ``memory.resume_state()`` so a killed multi-step run can see which prior decisions
    are still open. Opt-in and fail-soft: when ``memory`` is ``None`` behavior is
    byte-for-byte unchanged, and a memory backend error is logged but never crashes the
    run. It records + classifies decisions; it does not re-execute a gate.
    """
    if client is None:
        # Gate-aware backend selection (default-inert: with no config/inference.local.json
        # this is exactly default_client(); see serving.gated_router.routed_default_client).
        from serving.gated_router import RouteSignals, routed_default_client

        client = routed_default_client(RouteSignals(task=(task.goal or "")[:120], request_id=task.task_id))
    verifier = verifier or gate_verifier
    # Pass RUNS_DIR explicitly (looked up here at call time) so a runtime override
    # of the module global — as tests do — actually redirects the run logs; the
    # RunStore default binds at definition time and would ignore the override.
    store = RunStore(task.task_id, runs_dir=RUNS_DIR)
    store.resume() if resume else store.fresh()
    store.log("task_start", goal=task.goal, mode=task.mode, skill=(task.skill or {}).get("name"), resumed=resume,
              **({"roleId": task.role_id} if task.role_id else {}))
    # H2 (opt-in): seed from episodic memory so a killed multi-step run sees which
    # prior decisions are still open. No-op + fail-soft when memory is None.
    _seed_from_memory(memory, store)

    steps = plan(task, client, max_steps=max_steps, allowed_tools=allowed_tools)
    store.log("plan", steps=[s["id"] for s in steps], detail=steps)

    completed = set(store.state.get("completedSteps", [])) if resume else set()
    step_results: list[StepResult] = []
    prior_outputs: list[str] = []
    total_cost = 0.0
    total_latency = 0.0
    for step in steps:
        # Cooperative wall-clock deadline (review D4): stop between plan steps when the
        # budget is exhausted. Sub-step granularity; a single in-flight model call still
        # runs to its transport timeout (cfg.timeout_sec), not interrupted mid-request.
        if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic:
            store.log("deadline_stop", step=step["id"], reason="wall-clock budget exhausted")
            break
        if step["id"] in completed:
            store.log("step_skip", step=step["id"], reason="already completed (resume)")
            prior_outputs.append(store.state.get("stepOutputs", {}).get(step["id"], ""))
            continue
        # Token-budgeted, recency-aware compaction of prior step outputs (replaces
        # a blunt char chop): keeps recent context whole, compresses/drops older,
        # and logs exactly what was elided so the context window is auditable.
        prior_text, prior_pack = compact_history(prior_outputs)
        if prior_pack.compressed or prior_pack.dropped or prior_pack.over_budget:
            store.log("context_compact", step=step["id"], **prior_pack.to_log())
        outcome = _execute_step(
            task, step, client=client, store=store, verifier=verifier,
            prior=prior_text, max_retries=max_retries, approve_tools=approve_tools,
            allowed_tools=allowed_tools, admit_action=admit_action,
        )
        step_results.append(outcome)
        total_cost += outcome.cost_usd
        total_latency += outcome.latency_sec
        # H2 (opt-in): record this step as a provenance-tagged episode. ``ts`` is the
        # harness's own stamp on the step's last logged event — we PASS it, never mint a
        # clock here. Fail-soft: never crashes the run.
        step_ts = store.events[-1].get("ts") if store.events else None
        _record_step_episode(memory, store, task, outcome, step_ts)
        if outcome.ok:
            store.mark_done(step["id"], outcome.output)
            prior_outputs.append(outcome.output)
        else:
            break  # stop at first unrecoverable step

    final_text = prior_outputs[-1] if prior_outputs else ""
    failures = [f"{s.step_id}:{s.failure_class}" for s in step_results if not s.ok]
    # ok = no failures and every executed step passed (a fully-resumed task with
    # all steps already complete has no new step_results and is also ok).
    ok = not failures and all(s.ok for s in step_results)
    store.set_final(final_text)
    if consolidate and ok and final_text.strip():
        try:
            from agent.memory_consolidation import consolidate_result

            cons = consolidate_result(task.goal, final_text, task_id=task.task_id, mode=task.mode)
            store.log("consolidate", ok=cons.get("ok"), id=cons.get("id"), reasons=cons.get("reasons"))
        except Exception as exc:  # consolidation must never fail the run
            store.log("consolidate", ok=False, error=repr(exc))
    store.log("task_end", ok=ok, failures=failures, costUsd=round(total_cost, 6), latencySec=round(total_latency, 3))
    receipt = EfficiencyReceipt(
        run_id=task.task_id,
        correlation_id=task.task_id,
        join_ids=JoinIds(task_id=task.task_id, final=task.task_id),
        model_efficiency=ModelEfficiency(
            cost=total_cost,
            latency_ms=total_latency * 1000.0,
            retry_count=sum(max(0, s.attempts - 1) for s in step_results),
        ),
        thesis_metrics=ThesisMetrics() if task.mode == "thesis" else ThesisMetrics(),
        brainstorming_metrics=BrainstormingMetrics() if task.mode in {"brainstorm", "brainstorming"} else BrainstormingMetrics(),
        metadata={"memoryTtlSec": task.memory_ttl_sec, "replayPolicy": task.replay_policy},
    )
    result = AgentResult(
        task_id=task.task_id,
        ok=ok,
        final_text=final_text,
        steps=step_results,
        failures=failures,
        cost_usd=total_cost,
        latency_sec=total_latency,
        trace_path=str(store.log_path),
        receipt=receipt,
    )
    # Mandatory delivery gate on the final emit. The conscience FLOOR (hard
    # prohibitions — AGI overclaim, tampering, forbidden attribution) is applied
    # UNCONDITIONALLY; the epistemic strict tier is opt-in via conscience_gate /
    # SOPHIA_CONSCIENCE_GATE. Fail CLOSED: if the gate module cannot even be
    # reached, withhold rather than emit ungated final_text (apply_delivery_gate
    # already fails closed on an evaluation error; this backstops an import fault).
    try:
        from agent.conscience_runtime import maybe_gate_result
        result = maybe_gate_result(result, conscience_gate)
    except Exception as exc:
        store.log("conscience_gate_error", error=repr(exc))
        if result.final_text.strip():
            result = AgentResult(
                task_id=result.task_id,
                ok=False,
                final_text=("Delivery gate unavailable; refusing to emit ungated "
                            "output (fail-closed). See run trace."),
                steps=result.steps,
                failures=(result.failures or []) + ["conscience:gate_unavailable"],
                cost_usd=result.cost_usd,
                latency_sec=result.latency_sec,
                trace_path=result.trace_path,
            )
    return result
