# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Deterministic routing policy for workflow reuse inside AGI-shaped runs.

This module is intentionally transport- and scheduler-independent.  It decides
whether one AGI controller node should remain a simple single pass or may use
the existing bounded dynamic-workflow/A2A machinery.

The policy is conservative:

* simple nodes are always solo, even when workflow mode is forced ``on``;
* dynamic workflows require an available cloud/frontier provider and supervised
  parallel A2A capability;
* unknown providers and missing capabilities fail closed to a single pass;
* stage and agent requests are clamped to finite hard limits;
* Main may propose a custom pattern only with an explicit bounded shape.

This is orchestration policy, not evidence of general intelligence.  Every
decision and event dictionary is candidate-only and keeps ``canClaimAGI``
false.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

SCHEMA = "sophia.agi-workflow-policy.v1"
EVENT_SCHEMA = "sophia.agi-workflow-policy-event.v1"

WORKFLOW_MODES = frozenset({"off", "auto", "on"})
ROUTE_DYNAMIC_WORKFLOW = "dynamic_workflow"
ROUTE_SINGLE_PASS = "single_pass"

DEFAULT_MAX_STAGES = 4
DEFAULT_MAX_AGENTS = 16
HARD_MAX_STAGES = 12
HARD_MAX_AGENTS = 64
HARD_MAX_AGENTS_PER_STAGE = 8
MIN_WORKFLOW_AGENTS = 2

# Compatibility aliases for callers already familiar with dynamic_workflow.py.
MAX_STAGES_SAFETY = HARD_MAX_STAGES
MAX_AGENTS_SAFETY = HARD_MAX_AGENTS
MAX_TASKS_PER_STAGE = HARD_MAX_AGENTS_PER_STAGE

KNOWN_PATTERNS = frozenset(
    {
        "fan-out-and-synthesize",
        "adversarial-verification",
        "classify-and-act",
        "generate-and-filter",
        "tournament",
        "loop-until-done",
    }
)

PATTERN_SHAPES: dict[str, tuple[int, ...]] = {
    "fan-out-and-synthesize": (3, 2),
    "adversarial-verification": (2, 2),
    "classify-and-act": (3, 3),
    "generate-and-filter": (4, 2),
    "tournament": (4, 2, 2),
    "loop-until-done": (2, 2, 2),
}

PREFERRED_PATTERNS_BY_PHASE: dict[str, str] = {
    "perceive": "fan-out-and-synthesize",
    "retrieve": "fan-out-and-synthesize",
    "strategize": "generate-and-filter",
    "critique": "adversarial-verification",
    "select": "tournament",
    "act": "classify-and-act",
    "observe": "fan-out-and-synthesize",
    "diagnose": "classify-and-act",
    "verify": "adversarial-verification",
    "learn": "generate-and-filter",
    "evaluate": "adversarial-verification",
}

PREFERRED_PATTERNS_BY_NODE_TYPE: dict[str, str] = {
    "planner": "generate-and-filter",
    "strategy": "generate-and-filter",
    "research": "fan-out-and-synthesize",
    "retrieval": "fan-out-and-synthesize",
    "investigation": "fan-out-and-synthesize",
    "classifier": "classify-and-act",
    "implementation": "classify-and-act",
    "action": "classify-and-act",
    "critic": "adversarial-verification",
    "review": "adversarial-verification",
    "verifier": "adversarial-verification",
    "risk": "adversarial-verification",
    "selection": "tournament",
    "decision": "tournament",
    "candidate-generation": "generate-and-filter",
    "recovery": "loop-until-done",
    "correction": "loop-until-done",
}

_CLOUD_PROVIDER_MARKERS = frozenset(
    {
        "020s",
        "anthropic",
        "aipro",
        "azure-openai",
        "bedrock",
        "claude",
        "cloud",
        "cohere",
        "codex",
        "deepseek",
        "fireworks",
        "frontier",
        "gemini",
        "google",
        "groq",
        "hosted",
        "llmhub",
        "mistral-api",
        "openai",
        "openrouter",
        "remote",
        "teamorouter",
        "together",
        "vertex",
        "xai",
        "zai",
        "grok",
    }
)
_LOCAL_PROVIDER_MARKERS = frozenset(
    {
        "local",
        "self-hosted",
        "self_hosted",
        "ollama",
        "llama.cpp",
        "llamacpp",
        "lmstudio",
        "mlx",
        "vllm",
        "sglang",
    }
)
_HIGH_RISK_SIGNALS = frozenset(
    {
        "contested",
        "credential",
        "data-loss",
        "data_loss",
        "destructive",
        "external-side-effect",
        "external_side_effect",
        "financial",
        "high-impact",
        "high_impact",
        "irreversible",
        "legal",
        "medical",
        "privacy",
        "production",
        "safety-critical",
        "safety_critical",
        "security",
        "uncertain",
        "verification-required",
        "verification_required",
    }
)
_PATTERN_NAME = re.compile(r"^[a-z0-9][a-z0-9._+-]*(?:-[a-z0-9._+-]+)*$")


def normalize_workflow_mode(value: Any) -> str:
    """Normalize the explicit ``off|auto|on`` policy mode."""
    if isinstance(value, bool):
        return "on" if value else "off"
    raw = str(value or "off").strip().casefold().replace("_", "-")
    aliases = {
        "automatic": "auto",
        "decide": "auto",
        "disabled": "off",
        "enabled": "on",
        "false": "off",
        "force": "on",
        "forced": "on",
        "true": "on",
    }
    normalized = aliases.get(raw, raw)
    if normalized not in WORKFLOW_MODES:
        raise ValueError("mode must be off, auto, or on")
    return normalized


def _bounded_int(value: Any, *, default: int, low: int, high: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        parsed = default
    return max(low, min(high, parsed))


@dataclass(frozen=True)
class WorkflowBudget:
    """Finite limits for one node's dynamic workflow."""

    max_stages: int
    max_agents: int
    max_agents_per_stage: int = HARD_MAX_AGENTS_PER_STAGE

    @classmethod
    def clamped(
        cls,
        *,
        max_stages: Any = None,
        max_agents: Any = None,
        max_agents_per_stage: Any = None,
    ) -> "WorkflowBudget":
        return cls(
            max_stages=_bounded_int(
                max_stages,
                default=DEFAULT_MAX_STAGES,
                low=1,
                high=HARD_MAX_STAGES,
            ),
            max_agents=_bounded_int(
                max_agents,
                default=DEFAULT_MAX_AGENTS,
                low=MIN_WORKFLOW_AGENTS,
                high=HARD_MAX_AGENTS,
            ),
            max_agents_per_stage=_bounded_int(
                max_agents_per_stage,
                default=HARD_MAX_AGENTS_PER_STAGE,
                low=MIN_WORKFLOW_AGENTS,
                high=HARD_MAX_AGENTS_PER_STAGE,
            ),
        )

    def to_dict(self) -> dict[str, int]:
        return {
            "maxStages": self.max_stages,
            "maxAgents": self.max_agents,
            "maxAgentsPerStage": self.max_agents_per_stage,
        }


@dataclass(frozen=True)
class WorkflowPattern:
    """A bounded pattern selected by policy or proposed by Main."""

    name: str
    agents_per_stage: tuple[int, ...]
    source: str = "preferred"

    @property
    def stages(self) -> int:
        return len(self.agents_per_stage)

    @property
    def total_agents(self) -> int:
        return sum(self.agents_per_stage)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "source": self.source,
            "stages": self.stages,
            "agentsPerStage": list(self.agents_per_stage),
            "totalAgents": self.total_agents,
        }


@dataclass(frozen=True)
class AGIWorkflowDecision:
    """Deterministic route for one AGI phase/node."""

    mode: str
    phase: str
    node_type: str
    route: str
    selected: bool
    eligible: bool
    denied: bool
    simple: bool
    complexity: str
    risk: str
    risk_signals: tuple[str, ...]
    independent_workstreams: int
    provider: str
    provider_class: str
    parallel_a2a: bool
    preferred_pattern: str
    pattern: WorkflowPattern | None
    custom_pattern_accepted: bool | None
    custom_pattern_rejection: str
    budget: WorkflowBudget
    reason_code: str
    reason: str

    @property
    def workflow(self) -> bool:
        return self.selected

    @property
    def solo(self) -> bool:
        return not self.selected

    def to_dict(self) -> dict[str, Any]:
        pattern = self.pattern.to_dict() if self.pattern is not None else None
        return {
            "schema": SCHEMA,
            "mode": self.mode,
            "phase": self.phase,
            "nodeType": self.node_type,
            "route": self.route,
            "execution": "workflow" if self.selected else "solo",
            "selected": self.selected,
            "eligible": self.eligible,
            "denied": self.denied,
            "simple": self.simple,
            "complexity": self.complexity,
            "risk": self.risk,
            "riskSignals": list(self.risk_signals),
            "independentWorkstreams": self.independent_workstreams,
            "provider": self.provider,
            "providerClass": self.provider_class,
            "parallelA2A": self.parallel_a2a,
            "preferredPattern": self.preferred_pattern,
            "pattern": pattern,
            "customPatternAccepted": self.custom_pattern_accepted,
            "customPatternRejection": self.custom_pattern_rejection,
            **self.budget.to_dict(),
            "plannedStages": pattern["stages"] if pattern else 0,
            "plannedAgents": pattern["totalAgents"] if pattern else 0,
            "reasonCode": self.reason_code,
            "reason": self.reason,
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def to_event(self, event_type: str = "agi_workflow_route") -> dict[str, Any]:
        event = self.to_dict()
        event["schema"] = EVENT_SCHEMA
        event["type"] = str(event_type or "agi_workflow_route")
        return event


def _slug(value: Any) -> str:
    text = str(value or "").strip().casefold().replace("_", "-")
    return "-".join(part for part in re.split(r"[^a-z0-9.+-]+", text) if part)


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value > 0
    return str(value).strip().casefold() in {"1", "true", "yes", "on", "enabled"}


def _parallel_a2a_available(value: Any) -> bool:
    """Normalize bool or capability-map forms without assuming availability."""
    if not isinstance(value, Mapping):
        return _truthy(value)
    raw = None
    for key in (
        "parallelA2A",
        "parallel_a2a",
        "parallel",
        "available",
        "capable",
        "enabled",
    ):
        if key in value:
            raw = value.get(key)
            break
    if raw is None or not _truthy(raw):
        return False
    for key in ("supervised", "bounded", "stageBarriers", "stage_barriers"):
        if key in value and not _truthy(value.get(key)):
            return False
    return True


def _level(value: Any, *, default: int = 0) -> int:
    """Map numeric or named low/medium/high values to 0/1/2."""
    if isinstance(value, bool):
        return 2 if value else 0
    if isinstance(value, (int, float)):
        numeric = float(value)
        if not math.isfinite(numeric):
            return default
        if isinstance(value, float) and 0.0 <= numeric <= 1.0:
            return 0 if numeric < 0.35 else 1 if numeric < 0.70 else 2
        return 0 if numeric <= 0 else 1 if numeric < 2 else 2
    raw = _slug(value)
    if raw in {"", "none"}:
        return default
    if raw in {"simple", "trivial", "low", "routine"}:
        return 0
    if raw in {"medium", "moderate", "normal"}:
        return 1
    if raw in {
        "complex",
        "high",
        "multi-stage",
        "multistage",
        "frontier",
        "critical",
    }:
        return 2
    return default


def _level_name(level: int) -> str:
    return ("low", "medium", "high")[max(0, min(2, level))]


def _risk_signal_names(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    raw_items: Iterable[Any]
    if isinstance(value, Mapping):
        raw_items = (key for key, enabled in value.items() if _truthy(enabled))
    elif isinstance(value, str):
        raw_items = re.split(r"[,;\n]+", value)
    else:
        try:
            raw_items = iter(value)
        except TypeError:
            raw_items = (value,)
    normalized = {_slug(item) for item in raw_items}
    normalized.discard("")
    normalized.discard("none")
    normalized.discard("low")
    return tuple(sorted(normalized))


def _provider_capability(
    provider: Any,
    *,
    provider_available: bool,
) -> tuple[str, str, bool, str]:
    """Return display name, class, eligibility, and denial reason."""
    available = bool(provider_available)
    provider_class = ""
    name = ""
    frontier = False
    cloud = False
    explicit_local = False

    if isinstance(provider, Mapping):
        name = str(
            provider.get("name")
            or provider.get("provider")
            or provider.get("id")
            or ""
        ).strip()
        provider_class = _slug(
            provider.get("kind")
            or provider.get("class")
            or provider.get("providerClass")
        )
        if "available" in provider:
            available = available and _truthy(provider.get("available"))
        frontier = _truthy(provider.get("frontier"))
        cloud = _truthy(provider.get("cloud"))
        explicit_local = _truthy(
            provider.get("local")
            or provider.get("selfHosted")
            or provider.get("self_hosted")
        )
    else:
        name = str(provider or "").strip()

    marker_text = " ".join(
        item for item in (_slug(name), provider_class) if item
    )
    markers = set(marker_text.replace(":", "-").split("-"))
    markers.add(_slug(name))
    markers.add(provider_class)
    is_local = explicit_local or any(
        marker in marker_text for marker in _LOCAL_PROVIDER_MARKERS
    )
    is_cloud = (
        frontier
        or cloud
        or provider_class in {"cloud", "frontier", "hosted", "remote"}
        or any(marker in markers for marker in _CLOUD_PROVIDER_MARKERS)
        or any(
            marker and marker in marker_text
            for marker in _CLOUD_PROVIDER_MARKERS
        )
    )

    if not available:
        return name, provider_class or "unavailable", False, "provider_unavailable"
    if is_local:
        return name, "local", False, "provider_not_cloud_frontier"
    if not is_cloud:
        return name, provider_class or "unknown", False, "provider_not_cloud_frontier"
    return name, "frontier" if frontier else "cloud", True, ""


def preferred_workflow_pattern(
    *,
    phase: Any = "",
    node_type: Any = "",
    high_risk: bool = False,
) -> str:
    """Map an AGI phase/node to a deterministic preferred workflow pattern."""
    phase_key = _slug(phase)
    node_key = _slug(node_type)
    if high_risk or node_key in {"critic", "review", "verifier", "risk"}:
        return "adversarial-verification"
    if node_key in PREFERRED_PATTERNS_BY_NODE_TYPE:
        return PREFERRED_PATTERNS_BY_NODE_TYPE[node_key]
    return PREFERRED_PATTERNS_BY_PHASE.get(
        phase_key,
        "fan-out-and-synthesize",
    )


def _fit_known_pattern(name: str, budget: WorkflowBudget, *, source: str) -> WorkflowPattern:
    desired = PATTERN_SHAPES.get(name, PATTERN_SHAPES["fan-out-and-synthesize"])
    stage_count = min(
        len(desired),
        budget.max_stages,
        max(1, budget.max_agents // MIN_WORKFLOW_AGENTS),
    )
    desired = desired[:stage_count]
    agents = [MIN_WORKFLOW_AGENTS for _ in desired]
    remaining = budget.max_agents - sum(agents)
    for index, requested in enumerate(desired):
        extra = min(
            max(0, requested - MIN_WORKFLOW_AGENTS),
            max(0, budget.max_agents_per_stage - MIN_WORKFLOW_AGENTS),
            remaining,
        )
        agents[index] += extra
        remaining -= extra
    return WorkflowPattern(
        name=name,
        agents_per_stage=tuple(agents),
        source=source,
    )


def _distribute_total_agents(total: int, stages: int) -> tuple[int, ...] | None:
    if stages < 1 or total < stages * MIN_WORKFLOW_AGENTS:
        return None
    base, extra = divmod(total, stages)
    values = tuple(base + (1 if index < extra else 0) for index in range(stages))
    return values


def _custom_pattern(
    proposal: Any,
    *,
    budget: WorkflowBudget,
) -> tuple[WorkflowPattern | None, bool | None, str]:
    if proposal is None:
        return None, None, ""

    if isinstance(proposal, str):
        name = _slug(proposal)
        if name in KNOWN_PATTERNS:
            return _fit_known_pattern(name, budget, source="main-preferred"), True, ""
        return None, False, "custom_pattern_requires_bounded_shape"

    if not isinstance(proposal, Mapping):
        return None, False, "custom_pattern_must_be_mapping"

    name = _slug(proposal.get("name") or proposal.get("pattern"))
    if not name or len(name) > 80 or _PATTERN_NAME.fullmatch(name) is None:
        return None, False, "custom_pattern_name_invalid"

    raw_stages = proposal.get(
        "stages",
        proposal.get("stageCount", proposal.get("stage_count")),
    )
    stage_count = 0
    stage_agent_values: tuple[int, ...] | None = None
    if isinstance(raw_stages, (list, tuple)):
        stage_count = len(raw_stages)
        parsed: list[int] = []
        for stage in raw_stages:
            raw_agents = (
                stage.get("agents")
                if isinstance(stage, Mapping)
                else stage
            )
            try:
                parsed.append(int(raw_agents))
            except (TypeError, ValueError, OverflowError):
                return None, False, "custom_pattern_stage_agents_invalid"
        stage_agent_values = tuple(parsed)
    else:
        try:
            stage_count = int(raw_stages)
        except (TypeError, ValueError, OverflowError):
            return None, False, "custom_pattern_stages_required"

    if stage_count < 1:
        return None, False, "custom_pattern_stages_required"
    if stage_count > budget.max_stages or stage_count > HARD_MAX_STAGES:
        return None, False, "custom_pattern_stage_cap_exceeded"

    if stage_agent_values is None:
        raw_per_stage = proposal.get(
            "agentsPerStage",
            proposal.get("agents_per_stage"),
        )
        if isinstance(raw_per_stage, (list, tuple)):
            try:
                stage_agent_values = tuple(int(item) for item in raw_per_stage)
            except (TypeError, ValueError, OverflowError):
                return None, False, "custom_pattern_stage_agents_invalid"
        elif raw_per_stage is not None:
            try:
                per_stage = int(raw_per_stage)
            except (TypeError, ValueError, OverflowError):
                return None, False, "custom_pattern_stage_agents_invalid"
            stage_agent_values = tuple(per_stage for _ in range(stage_count))
        else:
            raw_total = proposal.get(
                "totalAgents",
                proposal.get(
                    "agentCount",
                    proposal.get(
                        "agent_count",
                        proposal.get("maxAgents", proposal.get("agents")),
                    ),
                ),
            )
            try:
                total = int(raw_total)
            except (TypeError, ValueError, OverflowError):
                return None, False, "custom_pattern_agents_required"
            stage_agent_values = _distribute_total_agents(total, stage_count)
            if stage_agent_values is None:
                return None, False, "custom_pattern_too_few_parallel_agents"

    if len(stage_agent_values) != stage_count:
        return None, False, "custom_pattern_stage_shape_mismatch"
    if any(value < MIN_WORKFLOW_AGENTS for value in stage_agent_values):
        return None, False, "custom_pattern_too_few_parallel_agents"
    if any(value > budget.max_agents_per_stage for value in stage_agent_values):
        return None, False, "custom_pattern_stage_agent_cap_exceeded"
    if sum(stage_agent_values) > budget.max_agents:
        return None, False, "custom_pattern_agent_cap_exceeded"

    return (
        WorkflowPattern(
            name=name,
            agents_per_stage=stage_agent_values,
            source="main-custom",
        ),
        True,
        "",
    )


def decide_agi_workflow(
    *,
    mode: Any,
    provider: Any,
    parallel_a2a: Any,
    phase: Any = "",
    node_type: Any = "",
    complexity: Any = "simple",
    risk: Any = "low",
    risk_signals: Any = None,
    independent_workstreams: Any = 1,
    simple: bool | None = None,
    max_stages: Any = None,
    max_agents: Any = None,
    max_agents_per_stage: Any = None,
    main_pattern: Any = None,
    provider_available: bool = True,
) -> AGIWorkflowDecision:
    """Choose a bounded dynamic workflow or deterministic single-pass route.

    ``mode=on`` forces workflow preference, not workflow eligibility: a simple
    node remains solo, and unavailable provider/A2A prerequisites still deny
    workflow execution.
    """
    normalized_mode = normalize_workflow_mode(mode)
    phase_key = _slug(phase)
    node_key = _slug(node_type)
    complexity_level = _level(complexity)
    signals = _risk_signal_names(risk_signals)
    risk_level = max(
        _level(risk),
        2 if any(item in _HIGH_RISK_SIGNALS for item in signals) else 0,
        # A caller only places an item in ``risk_signals`` when it is material
        # to routing. Unknown-but-present signals therefore remain conservative
        # and workflow-worthy instead of being silently treated as low risk.
        2 if signals else 0,
    )
    workstreams = _bounded_int(
        independent_workstreams,
        default=1,
        low=1,
        high=HARD_MAX_AGENTS,
    )
    inferred_simple = (
        complexity_level == 0
        and risk_level == 0
        and workstreams == 1
    )
    simple_node = bool(simple) if simple is not None else inferred_simple

    budget = WorkflowBudget.clamped(
        max_stages=max_stages,
        max_agents=max_agents,
        max_agents_per_stage=max_agents_per_stage,
    )
    provider_name, provider_class, provider_ok, provider_reason = (
        _provider_capability(
            provider,
            provider_available=provider_available,
        )
    )
    parallel_ok = _parallel_a2a_available(parallel_a2a)
    eligible = provider_ok and parallel_ok

    preferred = preferred_workflow_pattern(
        phase=phase_key,
        node_type=node_key,
        high_risk=risk_level >= 2,
    )
    proposed_pattern, custom_accepted, custom_rejection = _custom_pattern(
        main_pattern,
        budget=budget,
    )
    safe_pattern = proposed_pattern or _fit_known_pattern(
        preferred,
        budget,
        source="preferred",
    )

    auto_worthy = (
        complexity_level >= 2
        or risk_level >= 2
        or workstreams >= MIN_WORKFLOW_AGENTS
    )
    wants_workflow = normalized_mode == "on" or (
        normalized_mode == "auto" and auto_worthy
    )

    selected = False
    denied = False
    reason_code = ""
    reason = ""
    if normalized_mode == "off":
        reason_code = "mode_off"
        reason = "Workflow mode is off; use a simple single pass."
    elif simple_node:
        reason_code = "simple_node_solo"
        reason = "Simple AGI nodes remain solo even when workflow mode is on."
    elif not wants_workflow:
        reason_code = "workflow_not_warranted"
        reason = (
            "Auto mode found no high complexity, high risk, or parallel-work "
            "signal requiring a dynamic workflow."
        )
    elif not provider_ok:
        denied = True
        reason_code = provider_reason
        reason = (
            "Dynamic workflow denied: an available cloud/frontier provider is "
            "required; route this node through a simple single pass."
        )
    elif not parallel_ok:
        denied = True
        reason_code = "parallel_a2a_unavailable"
        reason = (
            "Dynamic workflow denied: supervised parallel A2A capability is "
            "unavailable; route this node through a simple single pass."
        )
    else:
        selected = True
        reason_code = (
            "workflow_forced"
            if normalized_mode == "on"
            else "workflow_selected"
        )
        reason = (
            "Bounded dynamic workflow selected from deterministic complexity "
            "and risk signals."
        )

    return AGIWorkflowDecision(
        mode=normalized_mode,
        phase=phase_key,
        node_type=node_key,
        route=(
            ROUTE_DYNAMIC_WORKFLOW
            if selected
            else ROUTE_SINGLE_PASS
        ),
        selected=selected,
        eligible=eligible,
        denied=denied,
        simple=simple_node,
        complexity=_level_name(complexity_level),
        risk=_level_name(risk_level),
        risk_signals=signals,
        independent_workstreams=workstreams,
        provider=provider_name,
        provider_class=provider_class,
        parallel_a2a=parallel_ok,
        preferred_pattern=preferred,
        pattern=safe_pattern if selected else None,
        custom_pattern_accepted=custom_accepted,
        custom_pattern_rejection=custom_rejection,
        budget=budget,
        reason_code=reason_code,
        reason=reason,
    )


def decision_event(
    decision: AGIWorkflowDecision,
    *,
    event_type: str = "agi_workflow_route",
) -> dict[str, Any]:
    """Return the deterministic, claim-bounded event representation."""
    return decision.to_event(event_type)


# Readable aliases for integration sites that route one phase/node at a time.
route_agi_node = decide_agi_workflow
route_agi_stage = decide_agi_workflow


__all__ = [
    "SCHEMA",
    "EVENT_SCHEMA",
    "WORKFLOW_MODES",
    "ROUTE_DYNAMIC_WORKFLOW",
    "ROUTE_SINGLE_PASS",
    "DEFAULT_MAX_STAGES",
    "DEFAULT_MAX_AGENTS",
    "HARD_MAX_STAGES",
    "HARD_MAX_AGENTS",
    "HARD_MAX_AGENTS_PER_STAGE",
    "MIN_WORKFLOW_AGENTS",
    "MAX_STAGES_SAFETY",
    "MAX_AGENTS_SAFETY",
    "MAX_TASKS_PER_STAGE",
    "KNOWN_PATTERNS",
    "PREFERRED_PATTERNS_BY_PHASE",
    "PREFERRED_PATTERNS_BY_NODE_TYPE",
    "WorkflowBudget",
    "WorkflowPattern",
    "AGIWorkflowDecision",
    "normalize_workflow_mode",
    "preferred_workflow_pattern",
    "decide_agi_workflow",
    "decision_event",
    "route_agi_node",
    "route_agi_stage",
]
