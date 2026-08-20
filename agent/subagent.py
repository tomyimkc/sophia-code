# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Subagent delegation for the Sophia harness — spawn child agents with isolated
context, least-privilege tools, and a per-child budget; synthesise their results.

The councils (``agent/council_deliberate.py``, ``agent/team_agents.py``) are
*deliberation*: one model wearing many personas in a single shared context. This
module is the missing complement — genuine **delegation**: a parent decomposes a
goal into child :class:`SubagentSpec`s, each of which runs the full
``agent.harness.run_agent`` loop in its OWN run store (own JSONL trace, own
plan/execute/critic/reflect cycle), sees only the context it is handed, may use
only the tools it is scoped to, and is bounded by its own step/retry/cost budget.
Child results are then synthesised back through one calibrated reduce step.

Sophia discipline:
  * **least privilege** — a child's ``allowed_tools`` is enforced by the harness
    (an out-of-scope tool request fails the step fail-closed). ``None`` inherits
    the parent scope; ``set()`` means a pure-reasoning child with no tools.
  * **isolation** — every child gets a distinct ``task_id`` and its own
    ``RunStore`` under ``RUNS_DIR``, so traces never interleave and one child's
    failure cannot corrupt another's state.
  * **bounded** — ``max_steps``/``max_retries`` are the HARD cost bound;
    ``cost_budget_usd`` is an additional SOFT post-hoc ceiling (a child that
    overran is reported ``over_budget=True`` and treated as not-ok). Honest by
    construction: we do not claim mid-step pre-emption we don't implement.
  * **fail-closed synthesis** — the reduce step draws only on children that
    actually succeeded; with zero successful children it ABSTAINS rather than
    inventing an answer from failures.

Deterministic and offline: with the mock model client the whole fan-out → reduce
runs without network, so it is reproducible and CI-testable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from agent import harness
from agent.harness import AgentResult, AgentTask, RunStore, run_agent
from agent.model import ModelClient, default_client

ABSTAIN_NO_CHILDREN = (
    "Insufficient verified basis to answer: no delegated subagent completed "
    "successfully. Escalate or re-scope rather than synthesising from failures. "
    "Not advice."
)


@dataclass
class SubagentSpec:
    """One unit of delegated work. ``allowed_tools``: None inherits the parent
    scope, a set narrows it (least privilege), an empty set means no tools."""

    goal: str
    mode: str = "advisor"
    allowed_tools: "set[str] | None" = None
    max_steps: int = 3
    max_retries: int = 1
    cost_budget_usd: "float | None" = None
    context: str = ""
    skill: "dict[str, Any] | None" = None
    label: str = ""

    def child_id(self, parent_id: str, index: int) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", (self.label or self.goal).lower())[:24].strip("-") or "sub"
        return f"{parent_id}.sub{index}-{slug}"


@dataclass
class SubagentResult:
    spec: SubagentSpec
    task_id: str
    ok: bool
    final_text: str
    cost_usd: float
    over_budget: bool
    failures: list[str]
    trace_path: str

    def to_log(self) -> dict:
        return {
            "taskId": self.task_id,
            "label": self.spec.label or self.spec.goal[:40],
            "ok": self.ok,
            "costUsd": round(self.cost_usd, 6),
            "overBudget": self.over_budget,
            "failures": self.failures,
        }


@dataclass
class DelegationResult:
    parent_goal: str
    children: list[SubagentResult]
    synthesis: str
    ok: bool
    total_cost_usd: float
    n_ok: int = field(default=0)
    trace_path: str = ""  # the parent delegation log (children have their own)

    def to_dict(self) -> dict:
        return {
            "parentGoal": self.parent_goal,
            "ok": self.ok,
            "nOk": self.n_ok,
            "nChildren": len(self.children),
            "totalCostUsd": round(self.total_cost_usd, 6),
            "children": [c.to_log() for c in self.children],
            "synthesis": self.synthesis,
        }


def run_subagent(
    spec: SubagentSpec,
    *,
    parent_id: str,
    index: int,
    client: ModelClient,
    approve_tools: bool = False,
    deadline_monotonic: float | None = None,
) -> SubagentResult:
    """Run one child through the full harness loop in an isolated run store.

    ``deadline_monotonic`` (review D4) forwards a cooperative wall-clock deadline
    into the child's plan-step loop so a long-horizon budget can stop this node
    between steps; ``None`` (default) is unbounded, preserving prior behavior.
    """
    task = AgentTask(goal=spec.goal, mode=spec.mode, task_id=spec.child_id(parent_id, index), context=spec.context, skill=spec.skill)
    result: AgentResult = run_agent(
        task,
        client=client,
        max_retries=spec.max_retries,
        max_steps=spec.max_steps,
        approve_tools=approve_tools,
        allowed_tools=spec.allowed_tools,
        deadline_monotonic=deadline_monotonic,
    )
    over_budget = spec.cost_budget_usd is not None and result.cost_usd > spec.cost_budget_usd
    failures = list(result.failures)
    if over_budget:
        failures = failures + [f"over_budget:{result.cost_usd:.4f}>{spec.cost_budget_usd:.4f}"]
    return SubagentResult(
        spec=spec,
        task_id=result.task_id,
        ok=bool(result.ok and not over_budget),
        final_text=result.final_text,
        cost_usd=result.cost_usd,
        over_budget=over_budget,
        failures=failures,
        trace_path=result.trace_path,
    )


def _synthesize(client: ModelClient, parent_goal: str, oks: list[SubagentResult]) -> str:
    """Reduce successful child outputs into one answer. Fail-closed: callers only
    pass successful children here; an empty list is handled before this is called."""
    blocks = []
    for i, child in enumerate(oks, 1):
        label = child.spec.label or child.spec.goal
        blocks.append(f"### Subagent {i}: {label}\n{child.final_text}")
    system = (
        "You are a synthesis lead. Combine the subagent results into ONE coherent answer "
        "to the parent goal. Attribute which subagent each conclusion came from. Do not "
        "invent agreement the subagents did not reach. End with a Decision section and a short 中文摘要."
    )
    user = f"## Parent goal\n{parent_goal}\n\n## Subagent results\n" + "\n\n".join(blocks)
    out = client.generate(system, user)
    return out.text.strip() if out.ok and out.text.strip() else "\n\n".join(b for b in blocks)


def delegate(
    parent_goal: str,
    specs: list[SubagentSpec],
    *,
    client: ModelClient | None = None,
    parent_id: str = "parent",
    approve_tools: bool = False,
    synthesize: bool = True,
) -> DelegationResult:
    """Fan out ``specs`` as isolated subagents (sequential, deterministic) and
    synthesise the successful results. The parent run logs a delegation trace so
    the whole tree — parent + each child store — is auditable.

    ``synthesize=False`` returns the children with a plain concatenation of their
    successful outputs (useful when the caller wants to run its own reduce, e.g.
    ``team_agents.deliberate_team`` for calibrated, divergence-aware synthesis)."""
    client = client or default_client()
    # Use the harness's current RUNS_DIR (looked up at call time) so parent and
    # child traces co-locate and a test/runtime override of the dir is honoured.
    store = RunStore(f"{parent_id}.delegation", runs_dir=harness.RUNS_DIR).fresh()
    store.log("delegate_start", parentGoal=parent_goal, nChildren=len(specs))

    from agent.thinking_trace import maybe_record_a2a, trace_scope

    children: list[SubagentResult] = []
    # Tie this delegation's A2A messages + the children's LLM calls to one trace id, and
    # RESTORE the prior context on exit so the id never leaks into later, unrelated calls.
    with trace_scope(trace_id=f"{parent_id}.delegation"):
        for i, spec in enumerate(specs, 1):
            label = spec.label or spec.goal[:40]
            # parent -> child: the delegated task prompt is an A2A message in swarm mode.
            maybe_record_a2a(sender=parent_id, receiver=f"{parent_id}.sub{i}-{label}", prompt=spec.goal, kind="delegate")
            child = run_subagent(spec, parent_id=parent_id, index=i, client=client, approve_tools=approve_tools)
            children.append(child)
            store.log("subagent_done", index=i, **child.to_log())
            # child -> parent: the child's synthesised answer (its contribution to the swarm).
            maybe_record_a2a(
                sender=child.task_id, receiver=parent_id, prompt=spec.goal, response=child.final_text,
                ok=child.ok, cost_usd=child.cost_usd, kind="result",
            )

        oks = [c for c in children if c.ok]
        if not oks:
            synthesis = ABSTAIN_NO_CHILDREN
        elif synthesize:
            synthesis = _synthesize(client, parent_goal, oks)
        else:
            synthesis = "\n\n".join(c.final_text for c in oks)
        # reduce: the parent folding child outputs into one answer is the synthesis leg.
        maybe_record_a2a(sender=parent_id, receiver="synthesis", prompt=parent_goal, response=synthesis,
                         ok=bool(oks), kind="synthesis")

    total_cost = sum(c.cost_usd for c in children)
    result = DelegationResult(
        parent_goal=parent_goal,
        children=children,
        synthesis=synthesis,
        ok=bool(oks),
        total_cost_usd=total_cost,
        n_ok=len(oks),
        trace_path=str(store.log_path),
    )
    store.log("delegate_end", **{k: v for k, v in result.to_dict().items() if k != "children"})
    return result
