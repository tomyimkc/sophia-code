# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Swarm-Router — the learned-glue seam of the Agentic-MoE design.

This is the *missing fourth layer* from ``docs/11-Platform/Agentic-MoE-Swarm.md``:
a policy that, from the task alone, decides **solo-vs-fan-out**, picks **which agent
teams** to spawn, sizes **k**, and sets each child's **budget + least-privilege tool
scope** — then hands the resulting :class:`SwarmPlan` to the delegation layer
(:mod:`agent.subagent`) which already does the isolated fan-out + fail-closed reduce.

It is the agent-altitude analog of ``moe/router.py`` (token → FFN-expert):

    task t → SwarmRouter.decide(t) → SwarmPlan{ teams, k, budgets } → subagent.delegate

Sophia discipline (matches every other ``agent/*`` module):

  * **deterministic + offline** — the v1 policy is a transparent *scored* policy over
    signals from :mod:`agent.query_understanding` (intent, multi-hop, length) plus a
    small auditable risk lexicon. No network, no key, CPU-only, CI-testable. The
    *trained* head (Stage-2/3 of the design doc) is a drop-in replacement for
    :meth:`SwarmRouter.decide`; the contract (SwarmPlan) does not change.
  * **least privilege** — each team carries a fixed ``allowed_tools`` scope that the
    harness enforces fail-closed; the router never widens a child's scope beyond it.
  * **fail-closed bias** — an empty/garbage task does **not** spawn a swarm (you don't
    fan out 6 agents on noise); below the difficulty floor the router answers solo.
  * **honest cost** — every plan carries an estimated cost (Σ k·max_steps over teams)
    so the solo-vs-swarm trade is *measured*, never hidden (see
    ``provenance_bench/swarm_benchmark.py``).
  * **load-balance aware** — :func:`route_batch` exposes team-utilisation so the
    Switch load-balancing loss (``moe/router.load_balancing_loss``) lifts cleanly from
    tokens-over-FFN-experts to tasks-over-agent-teams (used by the RL reward).

Honest bound: the v1 routing rules are **hand-authored**, not learned — they generalise
over phrasing and task shape, not deep meaning. They are the deterministic foothold the
design doc calls for *before* spending GPU on the trained router.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from agent.query_understanding import AnalyzedQuery, analyze
from agent.subagent import SubagentSpec
from agent.efficiency_receipt import swarm_net_benefit, unknown

SCHEMA = "sophia.swarm_plan.v1"

# ---------------------------------------------------------------------------
# Team catalogue — each "expert" of the Agentic-MoE. A team is a spawnable
# sub-agent role with a FIXED least-privilege tool scope (enforced by the
# harness) and a default budget. This is the agent-altitude analog of an FFN
# expert in moe/router.py; in the V3 (Branch-Train-MiX) design each of these is
# also a LoRA adapter. Tool scopes are intentionally narrow (fail-closed).
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Team:
    name: str
    role: str                     # what the spawned child is told to do
    allowed_tools: "frozenset[str] | None"  # None = pure reasoning child, no tools
    default_k: int = 1            # how many independent children by default
    max_steps: int = 3
    adapter_id: "str | None" = None  # V3 (Branch-Train-MiX): the LoRA adapter that is
    # ALSO this team's in-weights MoE expert. None = use the un-adapted backbone.
    # See docs/11-Platform/Swarm-Variants-V3-V4-Spec.md and agent/dual_use_adapter.py.

    def spec(self, goal: str, *, k_index: int, budget_usd: float | None) -> SubagentSpec:
        """Build one least-privilege child spec for this team. When the team is bound to
        a V3 adapter, the adapter id is carried in ``skill`` so a real harness can load
        it into the child (the loader hook); the mock/offline path ignores it."""
        label = self.name if self.default_k == 1 else f"{self.name}-{k_index + 1}"
        scoped_goal = f"[{self.name}] {self.role}\n\nTask: {goal}"
        skill = {"adapter_id": self.adapter_id, "team": self.name} if self.adapter_id else None
        return SubagentSpec(
            goal=scoped_goal,
            mode="advisor",
            allowed_tools=(set(self.allowed_tools) if self.allowed_tools is not None else None),
            max_steps=self.max_steps,
            max_retries=1,
            cost_budget_usd=budget_usd,
            skill=skill,
            label=label,
        )


# The catalogue. Tool names mirror the harness's tool registry (least privilege).
TEAMS: dict[str, Team] = {
    "search": Team(
        "search",
        "Retrieve and cite primary sources that bear on the task. Return claims with "
        "source ids; abstain on anything you cannot ground.",
        frozenset({"web_search", "fetch", "retrieve"}),
        default_k=2,  # independent searchers reduce single-query blind spots
        max_steps=3,
    ),
    "research": Team(
        "research",
        "Synthesise the retrieved evidence into a structured, sourced analysis of the "
        "sub-question. Flag contradictions; do not invent agreement.",
        frozenset({"retrieve", "fetch"}),
        default_k=1,
        max_steps=4,
    ),
    "math_verify": Team(
        "math_verify",
        "Solve and MACHINE-VERIFY the quantitative/logical core (executable check or "
        "proof). Report the verifier verdict, not just an answer.",
        frozenset({"python", "lean", "math_verify"}),
        default_k=1,
        max_steps=4,
    ),
    "legal": Team(
        "legal",
        "Check citation faithfulness and jurisdictional validity of any legal claim. "
        "Not advice; flag for human review on any unresolved point.",
        frozenset({"retrieve", "legal_citations"}),
        default_k=1,
        max_steps=3,
    ),
    "ontology": Team(
        "ontology",
        "Police concept boundaries (no merging distinct traditions/entities); resolve "
        "aliases and check the claim against the TBox.",
        frozenset({"datalog", "retrieve"}),
        default_k=1,
        max_steps=3,
    ),
    "redteam": Team(
        "redteam",
        "Adversarially try to REFUTE the emerging answer. Default to 'refuted' when "
        "evidence is thin. Surface the strongest counter-source.",
        frozenset({"web_search", "fetch", "retrieve"}),
        default_k=1,
        max_steps=3,
    ),
}

# ---------------------------------------------------------------------------
# Routing thresholds — auditable knobs (the trained head replaces the rules,
# not these contracts).
# ---------------------------------------------------------------------------
DIFFICULTY_SOLO_FLOOR = 0.34   # below this, answer solo (no swarm)
HARD_TASK = 0.66               # at/above this, allow the full panel + redteam
DEFAULT_CHILD_BUDGET_USD = 0.05

# Small, auditable risk/verifiability lexicons (bilingual, mirroring query_understanding).
_QUANT_MARKERS = (
    "calculate", "compute", "prove", "theorem", "equation", "probability", "integral",
    "derivative", "how many", "what is the value", "solve for", "证明", "计算", "求解",
    "概率", "方程",
)
_LEGAL_MARKERS = (
    "statute", "case law", "ruling", "plaintiff", "defendant", "jurisdiction", "§",
    "v.", "court held", "法条", "判例", "诉讼", "管辖",
)
_CONTESTED_MARKERS = (
    "controvers", "disput", "debate", "versus", " vs ", "critics", "alleged",
    "conspiracy", "争议", "对立", "批评",
)
_ENTITY_RISK_MARKERS = (
    "according to", "as said by", "attributed to", "misattribut", "credited to",
    "wrote", "founded", "invented", "originated", "据说", "出自", "归功于", "提出者",
)


def _hits(text: str, markers: "tuple[str, ...]") -> int:
    low = f" {text.lower()} "
    return sum(1 for m in markers if m in low)


# ---------------------------------------------------------------------------
# Signals + plan
# ---------------------------------------------------------------------------
@dataclass
class RouteSignals:
    """Transparent, auditable features behind a routing decision."""

    difficulty: float
    multi_hop: bool
    quant: bool
    legal: bool
    contested: bool
    entity_risk: bool
    n_sub_queries: int
    intent: str

    def to_dict(self) -> dict:
        return {
            "difficulty": round(self.difficulty, 3),
            "multiHop": self.multi_hop,
            "quant": self.quant,
            "legal": self.legal,
            "contested": self.contested,
            "entityRisk": self.entity_risk,
            "nSubQueries": self.n_sub_queries,
            "intent": self.intent,
        }


@dataclass
class TeamAssignment:
    team: str
    k: int
    budget_usd: float
    goal: str

    def to_dict(self) -> dict:
        return {"team": self.team, "k": self.k, "budgetUsd": round(self.budget_usd, 4), "goal": self.goal}


@dataclass
class SwarmPlan:
    """The dispatch contract handed to :func:`agent.subagent.delegate`. Validates
    against ``schema/swarm-plan-1.0.0.json``."""

    task: str
    mode: str                       # "solo" | "swarm"
    assignments: list[TeamAssignment]
    signals: RouteSignals
    rationale: str
    reduce: str = "fail_closed_synthesis"
    correlation_id: str | None = None
    net_benefit: Any = None
    expansion_allowed: bool = True

    @property
    def est_cost_steps(self) -> int:
        """Honest upper-bound compute estimate: Σ k·max_steps across teams. Solo = the
        backbone's own steps (counted as one team of k=1, max_steps=3)."""
        if self.mode == "solo":
            return 3
        return sum(a.k * TEAMS[a.team].max_steps for a in self.assignments)

    @property
    def n_agents(self) -> int:
        return sum(a.k for a in self.assignments)

    def to_specs(self, *, base_model: "str | None" = None, registry: "Any | None" = None) -> list[SubagentSpec]:
        """Lower the plan to least-privilege subagent specs for the delegation layer.

        When ``base_model`` is given, each team's adapter is resolved from the adapter
        registry (``agent.adapter_registry``) for THAT base model — and only bound if its
        evidence cleared the acceptance gate. Fail-closed: no accepted binding → the team
        runs on the plain backbone (no regressing adapter is ever attached)."""
        specs: list[SubagentSpec] = []
        for a in self.assignments:
            team = _team_for(a.team, base_model, registry)
            for j in range(a.k):
                specs.append(team.spec(a.goal, k_index=j, budget_usd=a.budget_usd))
        return specs

    def to_dict(self) -> dict:
        return {
            "schema": SCHEMA,
            "schemaVersion": "1.0.0",
            "task": self.task,
            "mode": self.mode,
            "assignments": [a.to_dict() for a in self.assignments],
            "reduce": self.reduce,
            "signals": self.signals.to_dict(),
            "rationale": self.rationale,
            "correlationId": self.correlation_id,
            "netBenefit": self.net_benefit.to_dict() if hasattr(self.net_benefit, "to_dict") else self.net_benefit,
            "expansionAllowed": self.expansion_allowed,
            "estCostSteps": self.est_cost_steps,
            "nAgents": self.n_agents,
        }


class SwarmRouter:
    """v1 deterministic routing policy. ``decide`` is the single seam the trained
    head (design-doc Stage 2/3) overrides; everything downstream is unchanged."""

    def __init__(
        self,
        *,
        solo_floor: float = DIFFICULTY_SOLO_FLOOR,
        hard_task: float = HARD_TASK,
        child_budget_usd: float = DEFAULT_CHILD_BUDGET_USD,
        analyze_fn: Callable[[str], AnalyzedQuery] | None = None,
        value_threshold: float = 0.0,
    ) -> None:
        self.solo_floor = solo_floor
        self.hard_task = hard_task
        self.child_budget_usd = child_budget_usd
        self._analyze = analyze_fn or analyze
        self.value_threshold = value_threshold

    # --- signal extraction (deterministic) ---------------------------------
    def signals(self, task: str) -> RouteSignals:
        aq = self._analyze(task)
        n_sub = len(aq.sub_queries)
        quant = _hits(task, _QUANT_MARKERS) > 0
        legal = _hits(task, _LEGAL_MARKERS) > 0
        contested = _hits(task, _CONTESTED_MARKERS) > 0 or aq.intent == "comparison"
        entity_risk = _hits(task, _ENTITY_RISK_MARKERS) > 0
        # Difficulty: a bounded blend of length, multi-hop fan, and risk markers.
        words = len([w for w in task.split() if w])
        length_term = min(words / 40.0, 1.0)                 # ~40 words ≈ saturated
        hop_term = min((n_sub - 1) / 3.0, 1.0) if n_sub > 1 else 0.0
        risk_term = min(
            (int(quant) + int(legal) + int(contested) + int(entity_risk)) / 3.0, 1.0
        )
        difficulty = round(0.4 * length_term + 0.35 * hop_term + 0.25 * risk_term, 4)
        return RouteSignals(
            difficulty=difficulty,
            multi_hop=aq.is_multi_hop,
            quant=quant,
            legal=legal,
            contested=contested,
            entity_risk=entity_risk,
            n_sub_queries=n_sub,
            intent=aq.intent,
        )

    # --- the decision ------------------------------------------------------
    def decide(self, task: str, *, telemetry: dict[str, Any] | None = None, correlation_id: str | None = None) -> SwarmPlan:
        """task → SwarmPlan. Optional telemetry gates expansion fail-safe."""
        clean = (task or "").strip()
        sig = self.signals(clean)
        telemetry = telemetry or {}
        quality = telemetry.get("quality_delta", unknown("quality not measured"))
        cost = telemetry.get("added_cost", unknown("cost not measured"))
        latency = telemetry.get("added_latency_ms", unknown("latency not measured"))
        benefit = swarm_net_benefit(quality, cost, latency, latency_weight=telemetry.get("latency_weight", 0.0))
        expansion_allowed = not (self.value_threshold > 0 and isinstance(benefit.net_benefit, (int, float)) and benefit.net_benefit < self.value_threshold)

        # A "hard signal" is a verifier-relevant feature (machine-checkable core, legal
        # claim, attribution risk, multi-hop, contested) that warrants fanning out the
        # relevant team EVEN on a short query — verifiability doesn't scale with length.
        hard_signal = (
            sig.quant or sig.legal or sig.entity_risk or sig.multi_hop
            or sig.contested or sig.n_sub_queries > 1
        )

        # Fail-closed: no swarm on empty input, and a generic low-difficulty query with
        # no hard signal is answered solo (don't fan out 6 agents on noise).
        if not clean or (sig.difficulty < self.solo_floor and not hard_signal):
            return SwarmPlan(
                task=clean,
                mode="solo",
                assignments=[],
                signals=sig,
                rationale=(
                    "empty task" if not clean else
                    f"difficulty {sig.difficulty} < solo floor {self.solo_floor}, no hard signal: backbone answers solo"
                ), correlation_id=correlation_id, net_benefit=benefit, expansion_allowed=expansion_allowed,
            )

        assignments: list[TeamAssignment] = []
        budget = self.child_budget_usd
        reasons: list[str] = []

        # 1. Anything sourced/factoid/temporal/multi-hop → a search team (independent k≥2).
        if sig.intent in ("factoid", "temporal", "navigational") or sig.multi_hop or sig.entity_risk:
            assignments.append(TeamAssignment("search", TEAMS["search"].default_k, budget,
                                              f"Find and cite sources for: {clean}"))
            reasons.append("sourced/factoid → search(k2)")

        # 2. Multi-hop / comparison / contested → a research synthesis team.
        if sig.multi_hop or sig.contested or sig.n_sub_queries > 1:
            assignments.append(TeamAssignment("research", 1, budget,
                                              f"Synthesise a sourced analysis of: {clean}"))
            reasons.append("multi-hop/contested → research")

        # 3. Quantitative/logical core → a machine-verify team.
        if sig.quant:
            assignments.append(TeamAssignment("math_verify", 1, budget,
                                              f"Solve and machine-verify the quantitative core of: {clean}"))
            reasons.append("quant → math_verify")

        # 4. Legal claim → legal faithfulness team.
        if sig.legal:
            assignments.append(TeamAssignment("legal", 1, budget,
                                              f"Check citation faithfulness for: {clean}"))
            reasons.append("legal → legal")

        # 5. Attribution/entity risk → ontology boundary cop.
        if sig.entity_risk:
            assignments.append(TeamAssignment("ontology", 1, budget,
                                              f"Police concept/attribution boundaries in: {clean}"))
            reasons.append("entity risk → ontology")

        # 6. Hard + contested → add an adversarial red-team seat (independence).
        if sig.difficulty >= self.hard_task and sig.contested:
            assignments.append(TeamAssignment("redteam", 1, budget,
                                              f"Try to refute the emerging answer to: {clean}"))
            reasons.append("hard+contested → redteam")

        # Guard: if nothing matched but we're above the floor, fall back to a minimal
        # search+research swarm (the generic "go look it up properly" pair).
        if not assignments:
            assignments = [
                TeamAssignment("search", TEAMS["search"].default_k, budget, f"Find sources for: {clean}"),
                TeamAssignment("research", 1, budget, f"Synthesise an answer to: {clean}"),
            ]
            reasons.append("above floor, no specific signal → generic search+research")

        if not expansion_allowed:
            return SwarmPlan(task=clean, mode="solo", assignments=[], signals=sig,
                             rationale="estimated swarm value below configured threshold",
                             correlation_id=correlation_id, net_benefit=benefit, expansion_allowed=False)
        return SwarmPlan(
            task=clean,
            mode="swarm",
            assignments=assignments,
            signals=sig,
            rationale="; ".join(reasons),
            correlation_id=correlation_id, net_benefit=benefit, expansion_allowed=expansion_allowed,
        )


# ---------------------------------------------------------------------------
# Batch utilisation — the bridge to the Switch load-balancing loss. Lifts
# moe/router.load_balancing_loss from tokens-over-experts to tasks-over-teams.
# ---------------------------------------------------------------------------
def _team_for(team_name: str, base_model: "str | None", registry: "Any | None") -> Team:
    """Return the catalogue team, bound to its registry adapter for ``base_model`` when an
    accepted binding exists (V3 dual-use). No base model / no accepted binding → plain team."""
    from dataclasses import replace

    base = TEAMS[team_name]
    if not base_model:
        return base
    if registry is None:
        from agent.adapter_registry import default_registry
        registry = default_registry()
    adapter_id = registry.resolve(base_model, team_name)
    return replace(base, adapter_id=adapter_id) if adapter_id else base


def route_batch(router: SwarmRouter, tasks: "list[str]") -> dict:
    """Route a batch and report per-team utilisation. The fraction-dispatched vector
    is exactly the ``f_e`` term of the Switch aux loss; a router that collapses onto
    one team shows up here as a spiked distribution (the signal the load-balance
    penalty in ``provenance_bench/swarm_rl.py`` is trained against)."""
    plans = [router.decide(t) for t in tasks]
    counts: dict[str, int] = {name: 0 for name in TEAMS}
    n_swarm = 0
    total_agents = 0
    for p in plans:
        if p.mode == "swarm":
            n_swarm += 1
            for a in p.assignments:
                counts[a.team] += a.k
                total_agents += a.k
    frac = {t: (counts[t] / total_agents if total_agents else 0.0) for t in TEAMS}
    return {
        "nTasks": len(tasks),
        "nSwarm": n_swarm,
        "soloRate": round((len(tasks) - n_swarm) / len(tasks), 3) if tasks else 0.0,
        "teamCounts": counts,
        "teamFraction": {t: round(v, 3) for t, v in frac.items()},
        "totalAgents": total_agents,
        "plans": [p.to_dict() for p in plans],
    }


# ---------------------------------------------------------------------------
# Convenience: route + delegate in one call (ties the router to the existing
# fan-out + fail-closed reduce). Kept thin so the seam stays testable in isolation.
# ---------------------------------------------------------------------------
def run_swarm(task: str, *, client: Any | None = None, router: SwarmRouter | None = None,
              parent_id: str = "swarm", approve_tools: bool = False,
              base_model: "str | None" = None, registry: "Any | None" = None,
              telemetry: dict[str, Any] | None = None, correlation_id: str | None = None):
    """Decide a plan and execute it through :func:`agent.subagent.delegate`. A solo
    plan delegates a single backbone child (still isolated + budgeted).

    ``base_model`` opts the spawned teams into their registry-validated adapters for that
    base (V3 dual-use); fail-closed to the plain backbone when no binding is accepted."""
    from agent import subagent as sa

    router = router or SwarmRouter()
    plan = router.decide(task, telemetry=telemetry, correlation_id=correlation_id)
    if plan.mode == "solo":
        specs = [SubagentSpec(goal=task, label="solo", max_steps=3)]
    else:
        specs = plan.to_specs(base_model=base_model, registry=registry)
    result = sa.delegate(task, specs, client=client, parent_id=parent_id, approve_tools=approve_tools)
    return plan, result


# ---------------------------------------------------------------------------
# Offline invariants (CI-gated, no network/torch) — same contract as moe/router.
# ---------------------------------------------------------------------------
def offline_invariants() -> "tuple[bool, dict]":
    r = SwarmRouter()
    checks: dict[str, bool] = {}
    detail: dict = {}

    # 1. Trivial query → solo (fail-closed against needless fan-out).
    p_easy = r.decide("hi")
    checks["trivial_is_solo"] = p_easy.mode == "solo" and p_easy.n_agents == 0

    # 2. Empty/garbage → solo, never a swarm.
    checks["empty_is_solo"] = r.decide("   ").mode == "solo"

    # 3. Multi-hop comparison → swarm with search + research, ≥2 agents.
    p_cmp = r.decide("Compare the epistemology of Kant and the skepticism of Hume in detail")
    teams_cmp = {a.team for a in p_cmp.assignments}
    checks["comparison_fans_out"] = (
        p_cmp.mode == "swarm" and "research" in teams_cmp and p_cmp.n_agents >= 2
    )

    # 4. Quantitative task → includes a machine-verify team.
    p_math = r.decide("Calculate the probability of at least one six in four rolls and prove the bound")
    checks["quant_gets_verifier"] = any(a.team == "math_verify" for a in p_math.assignments)

    # 5. Attribution-risk task → ontology boundary cop (Sophia's signature concern).
    p_attr = r.decide("Which ideas are wrongly attributed to Freud that actually originated later?")
    checks["entity_risk_gets_ontology"] = any(a.team == "ontology" for a in p_attr.assignments)

    # 6. Cost is monotonic: a hard contested task costs more steps than a solo one.
    p_hard = r.decide(
        "Compare the disputed authorship claims for the Dao De Jing versus the Analects, "
        "citing primary sources, and adjudicate the strongest counter-arguments"
    )
    checks["cost_monotonic"] = p_hard.est_cost_steps > p_easy.est_cost_steps
    detail["hardCostSteps"] = p_hard.est_cost_steps

    # 7. Least privilege preserved: every spawned spec's tool scope ⊆ its team's scope.
    scope_ok = True
    for a in p_hard.assignments:
        team = TEAMS[a.team]
        for spec in [team.spec(a.goal, k_index=0, budget_usd=0.05)]:
            if team.allowed_tools is None:
                scope_ok = scope_ok and (spec.allowed_tools is None)
            else:
                scope_ok = scope_ok and (spec.allowed_tools is not None
                                         and set(spec.allowed_tools) <= set(team.allowed_tools))
    checks["least_privilege"] = scope_ok

    # 8. Determinism: same task → identical plan dict.
    checks["deterministic"] = r.decide("Compare Kant and Hume on causation") .to_dict() == \
        SwarmRouter().decide("Compare Kant and Hume on causation").to_dict()

    # 9. Plan validates structurally (required contract keys present).
    d = p_hard.to_dict()
    required = {"schema", "task", "mode", "assignments", "reduce", "signals", "rationale"}
    checks["plan_well_formed"] = required <= set(d) and d["reduce"] == "fail_closed_synthesis"

    # 10. Batch utilisation sums to 1 over teams when any agent is dispatched.
    batch = route_batch(r, [
        "hi", "Compare Kant and Hume", "Calculate 17*23 and verify",
        "Which quote is misattributed to Einstein?",
    ])
    frac_sum = sum(batch["teamFraction"].values())
    checks["utilisation_normalised"] = abs(frac_sum - 1.0) < 1e-9 if batch["totalAgents"] else True
    detail["soloRate"] = batch["soloRate"]

    ok = all(checks.values())
    return ok, {"checks": checks, **detail}


if __name__ == "__main__":
    ok, detail = offline_invariants()
    print("Swarm-Router offline invariants:", "PASS" if ok else "FAIL")
    for k, v in detail["checks"].items():
        print(f"  [{'ok' if v else 'XX'}] {k}")
    print("  hard-task cost (steps):", detail.get("hardCostSteps"), " solo rate:", detail.get("soloRate"))
    raise SystemExit(0 if ok else 1)
