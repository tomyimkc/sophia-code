"""Deterministic policy for reusing warm adaptive-workflow workers.

The policy is intentionally standalone: it models reusable worker state and
returns decisions, but it never starts, stops, or mutates a process.

Logical agent identity is separate from both task identity and runtime/process
identity.  A logical agent may therefore continue across several tasks while a
runtime remains warm, or later attach to a replacement runtime without changing
the logical identity recorded by the workflow.

``candidateOnly: true`` and ``canClaimAGI: false`` — this is orchestration
plumbing, not evidence of general capability.
"""

from __future__ import annotations

import hashlib
import json
import math
import posixpath
import re
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Sequence


class LeaseState(str, Enum):
    """Lifecycle state of the coordinator-owned reuse lease."""

    WARM = "warm"
    ACQUIRED = "acquired"
    EXPIRED = "expired"
    EVICTED = "evicted"
    RETIRED = "retired"


class RuntimeState(str, Enum):
    """Lifecycle state of the underlying worker runtime/process."""

    STARTING = "starting"
    READY = "ready"
    BUSY = "busy"
    DEGRADED = "degraded"
    STOPPED = "stopped"
    FAILED = "failed"


REUSABLE_LEASE_STATES = frozenset({LeaseState.WARM})
REUSABLE_RUNTIME_STATES = frozenset({RuntimeState.READY})

ALWAYS_FRESH_STAGE_KINDS = frozenset(
    {
        "critic",
        "adversarial",
        "tiebreak",
        "security",
        "source",
        "attribution",
    }
)

REUSE_ELIGIBLE_STAGE_KINDS = frozenset(
    {
        "recovery",
        "refinement",
        "implementation_follow_up",
    }
)


class ReuseReason:
    """Stable reason codes returned by :func:`decide_worker_reuse`."""

    ALLOWED = "reuse_allowed"
    STAGE_REQUIRES_FRESH = "stage_requires_fresh_worker"
    STAGE_NOT_ELIGIBLE = "stage_not_reuse_eligible"
    NO_CANDIDATES = "no_reuse_candidates"
    LEASE_NOT_WARM = "lease_not_warm"
    RUNTIME_NOT_READY = "runtime_not_ready"
    WORKFLOW_MISMATCH = "workflow_mismatch"
    LOGICAL_AGENT_MISMATCH = "logical_agent_mismatch"
    PROVIDER_MISMATCH = "fingerprint_provider_mismatch"
    MODEL_MISMATCH = "fingerprint_model_mismatch"
    TRANSPORT_MISMATCH = "fingerprint_transport_mismatch"
    ROLE_MISMATCH = "fingerprint_role_mismatch"
    SKILLS_MISMATCH = "fingerprint_skills_mismatch"
    PERMISSION_SCOPE_MISMATCH = "fingerprint_permission_scope_mismatch"
    TOOL_SCOPE_MISMATCH = "fingerprint_tool_scope_mismatch"
    WORKSPACE_ROOT_MISMATCH = "fingerprint_workspace_root_mismatch"
    WORKSPACE_REVISION_MISMATCH = "fingerprint_workspace_revision_mismatch"
    CLOCK_SKEW = "lease_timestamp_in_future"
    TTL_EXPIRED = "lease_ttl_expired"
    REUSE_LIMIT_REACHED = "max_reuses_reached"
    CONTEXT_LIMIT_EXCEEDED = "max_context_fraction_exceeded"


_FINGERPRINT_REASON_BY_FIELD = {
    "provider": ReuseReason.PROVIDER_MISMATCH,
    "model": ReuseReason.MODEL_MISMATCH,
    "transport": ReuseReason.TRANSPORT_MISMATCH,
    "role": ReuseReason.ROLE_MISMATCH,
    "skills": ReuseReason.SKILLS_MISMATCH,
    "permission_scope": ReuseReason.PERMISSION_SCOPE_MISMATCH,
    "tool_scope": ReuseReason.TOOL_SCOPE_MISMATCH,
    "workspace_root": ReuseReason.WORKSPACE_ROOT_MISMATCH,
    "workspace_revision": ReuseReason.WORKSPACE_REVISION_MISMATCH,
}

_FINGERPRINT_FIELDS = tuple(_FINGERPRINT_REASON_BY_FIELD)

_STAGE_ALIASES = {
    "critique": "critic",
    "review": "critic",
    "reviewer": "critic",
    "red_team": "adversarial",
    "redteam": "adversarial",
    "adversarial_review": "adversarial",
    "adversarial_verification": "adversarial",
    "tie_break": "tiebreak",
    "tie_breaker": "tiebreak",
    "tie_breaking": "tiebreak",
    "security_check": "security",
    "security_audit": "security",
    "security_review": "security",
    "source_check": "source",
    "source_review": "source",
    "source_verification": "source",
    "attribution_check": "attribution",
    "attribution_review": "attribution",
    "attribution_verification": "attribution",
    "recover": "recovery",
    "correction": "recovery",
    "repair": "recovery",
    "refine": "refinement",
    "revision": "refinement",
    "implementation_followup": "implementation_follow_up",
    "follow_up": "implementation_follow_up",
    "followup": "implementation_follow_up",
}


def normalize_stage_kind(value: str) -> str:
    """Return a deterministic snake-case stage kind with conservative aliases."""

    raw = re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().casefold()).strip("_")
    return _STAGE_ALIASES.get(raw, raw)


def _required_text(value: Any, field_name: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field_name} must be non-empty")
    return normalized


def _finite_number(value: Any, field_name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be a finite number")
    try:
        normalized = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a finite number") from exc
    if not math.isfinite(normalized):
        raise ValueError(f"{field_name} must be a finite number")
    return normalized


def _non_negative_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be a non-negative integer")
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a non-negative integer") from exc
    if normalized != value or normalized < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")
    return normalized


def _normalized_scope(value: Iterable[str] | str, field_name: str) -> tuple[str, ...]:
    values: Iterable[str] = (value,) if isinstance(value, str) else value
    normalized: set[str] = set()
    for item in values:
        cleaned = str(item or "").strip()
        if not cleaned:
            raise ValueError(f"{field_name} entries must be non-empty")
        normalized.add(cleaned)
    return tuple(sorted(normalized))


def _normalized_workspace_root(value: Any) -> str:
    raw = _required_text(value, "workspace_root").replace("\\", "/")
    return posixpath.normpath(raw)


@dataclass(frozen=True)
class LogicalAgentIdentity:
    """Stable workflow identity; deliberately contains no task or process ID."""

    workflow_id: str
    agent_id: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "workflow_id",
            _required_text(self.workflow_id, "workflow_id"),
        )
        object.__setattr__(
            self,
            "agent_id",
            _required_text(self.agent_id, "agent_id"),
        )

    def to_dict(self) -> dict[str, str]:
        return {
            "workflowId": self.workflow_id,
            "logicalAgentId": self.agent_id,
        }


@dataclass(frozen=True)
class WorkerRuntime:
    """Ephemeral runtime/process identity and lifecycle."""

    runtime_id: str
    state: RuntimeState
    process_id: int | None = None
    started_at: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "runtime_id",
            _required_text(self.runtime_id, "runtime_id"),
        )
        try:
            state = RuntimeState(self.state)
        except ValueError as exc:
            raise ValueError(f"unknown runtime state: {self.state!r}") from exc
        object.__setattr__(self, "state", state)
        if self.process_id is not None:
            process_id = _non_negative_int(self.process_id, "process_id")
            if process_id == 0:
                raise ValueError("process_id must be positive")
            object.__setattr__(self, "process_id", process_id)
        if self.started_at is not None:
            object.__setattr__(
                self,
                "started_at",
                _finite_number(self.started_at, "started_at"),
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "runtimeId": self.runtime_id,
            "runtimeState": self.state.value,
            "processId": self.process_id,
            "startedAt": self.started_at,
        }


@dataclass(frozen=True)
class CompatibilityFingerprint:
    """Exact compatibility boundary for stateful worker reuse."""

    provider: str
    model: str
    transport: str
    role: str
    skills: tuple[str, ...]
    permission_scope: tuple[str, ...]
    tool_scope: tuple[str, ...]
    workspace_root: str
    workspace_revision: str

    def __post_init__(self) -> None:
        for field_name in ("provider", "model", "transport", "role"):
            object.__setattr__(
                self,
                field_name,
                _required_text(getattr(self, field_name), field_name),
            )
        object.__setattr__(
            self,
            "skills",
            _normalized_scope(self.skills, "skills"),
        )
        object.__setattr__(
            self,
            "permission_scope",
            _normalized_scope(self.permission_scope, "permission_scope"),
        )
        object.__setattr__(
            self,
            "tool_scope",
            _normalized_scope(self.tool_scope, "tool_scope"),
        )
        object.__setattr__(
            self,
            "workspace_root",
            _normalized_workspace_root(self.workspace_root),
        )
        object.__setattr__(
            self,
            "workspace_revision",
            _required_text(self.workspace_revision, "workspace_revision"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "transport": self.transport,
            "role": self.role,
            "skills": list(self.skills),
            "permissionScope": list(self.permission_scope),
            "toolScope": list(self.tool_scope),
            "workspaceRoot": self.workspace_root,
            "workspaceRevision": self.workspace_revision,
        }

    def stable_id(self) -> str:
        """Return a content-addressed, process-independent fingerprint ID."""

        encoded = json.dumps(
            self.to_dict(),
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def mismatch_reason(self, other: "CompatibilityFingerprint") -> str | None:
        """Return the first mismatch in stable field order, otherwise ``None``."""

        for field_name in _FINGERPRINT_FIELDS:
            if getattr(self, field_name) != getattr(other, field_name):
                return _FINGERPRINT_REASON_BY_FIELD[field_name]
        return None


@dataclass(frozen=True)
class WorkerLease:
    """Coordinator lease binding one logical identity to one warm runtime."""

    lease_id: str
    logical_agent: LogicalAgentIdentity
    runtime: WorkerRuntime
    fingerprint: CompatibilityFingerprint
    lease_state: LeaseState
    created_at: float
    last_used_at: float
    reuse_count: int
    context_tokens: int
    context_window_tokens: int
    last_task_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "lease_id",
            _required_text(self.lease_id, "lease_id"),
        )
        try:
            state = LeaseState(self.lease_state)
        except ValueError as exc:
            raise ValueError(f"unknown lease state: {self.lease_state!r}") from exc
        object.__setattr__(self, "lease_state", state)
        created_at = _finite_number(self.created_at, "created_at")
        last_used_at = _finite_number(self.last_used_at, "last_used_at")
        if last_used_at < created_at:
            raise ValueError("last_used_at cannot precede created_at")
        object.__setattr__(self, "created_at", created_at)
        object.__setattr__(self, "last_used_at", last_used_at)
        object.__setattr__(
            self,
            "reuse_count",
            _non_negative_int(self.reuse_count, "reuse_count"),
        )
        object.__setattr__(
            self,
            "context_tokens",
            _non_negative_int(self.context_tokens, "context_tokens"),
        )
        context_window = _non_negative_int(
            self.context_window_tokens,
            "context_window_tokens",
        )
        if context_window == 0:
            raise ValueError("context_window_tokens must be positive")
        object.__setattr__(self, "context_window_tokens", context_window)
        if self.last_task_id is not None:
            object.__setattr__(
                self,
                "last_task_id",
                _required_text(self.last_task_id, "last_task_id"),
            )

    @property
    def reuse_available(self) -> bool:
        return (
            self.lease_state in REUSABLE_LEASE_STATES
            and self.runtime.state in REUSABLE_RUNTIME_STATES
        )

    @property
    def context_fraction(self) -> float:
        return self.context_tokens / self.context_window_tokens


@dataclass(frozen=True)
class ReuseRequest:
    """One task's request to continue a logical agent on a warm worker."""

    logical_agent: LogicalAgentIdentity
    task_id: str
    stage_kind: str
    fingerprint: CompatibilityFingerprint
    requested_at: float
    additional_context_tokens: int = 0
    predecessor_task_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "task_id",
            _required_text(self.task_id, "task_id"),
        )
        object.__setattr__(
            self,
            "stage_kind",
            normalize_stage_kind(self.stage_kind),
        )
        object.__setattr__(
            self,
            "requested_at",
            _finite_number(self.requested_at, "requested_at"),
        )
        object.__setattr__(
            self,
            "additional_context_tokens",
            _non_negative_int(
                self.additional_context_tokens,
                "additional_context_tokens",
            ),
        )
        if self.predecessor_task_id is not None:
            object.__setattr__(
                self,
                "predecessor_task_id",
                _required_text(
                    self.predecessor_task_id,
                    "predecessor_task_id",
                ),
            )

    def is_direct_continuation_of(self, lease: WorkerLease) -> bool:
        return (
            self.predecessor_task_id is not None
            and self.predecessor_task_id == lease.last_task_id
            and self.logical_agent == lease.logical_agent
        )


@dataclass(frozen=True)
class ReusePolicyConfig:
    """Bounds for safe, deterministic warm-worker reuse and eviction."""

    ttl_seconds: float = 900.0
    max_warm_per_workflow: int = 2
    max_warm_per_provider: int = 4
    max_reuses: int = 4
    max_context_fraction: float = 0.65
    always_fresh_stage_kinds: frozenset[str] = field(
        default_factory=lambda: ALWAYS_FRESH_STAGE_KINDS
    )
    reuse_eligible_stage_kinds: frozenset[str] = field(
        default_factory=lambda: REUSE_ELIGIBLE_STAGE_KINDS
    )

    def __post_init__(self) -> None:
        ttl = _finite_number(self.ttl_seconds, "ttl_seconds")
        if ttl <= 0:
            raise ValueError("ttl_seconds must be positive")
        object.__setattr__(self, "ttl_seconds", ttl)
        for field_name in (
            "max_warm_per_workflow",
            "max_warm_per_provider",
            "max_reuses",
        ):
            object.__setattr__(
                self,
                field_name,
                _non_negative_int(getattr(self, field_name), field_name),
            )
        context_fraction = _finite_number(
            self.max_context_fraction,
            "max_context_fraction",
        )
        if not 0 < context_fraction <= 1:
            raise ValueError("max_context_fraction must be in (0, 1]")
        object.__setattr__(
            self,
            "max_context_fraction",
            context_fraction,
        )
        fresh = frozenset(
            normalize_stage_kind(item) for item in self.always_fresh_stage_kinds
        )
        eligible = frozenset(
            normalize_stage_kind(item) for item in self.reuse_eligible_stage_kinds
        )
        if "" in fresh or "" in eligible:
            raise ValueError("stage kind sets cannot contain empty values")
        overlap = fresh & eligible
        if overlap:
            raise ValueError(
                "always-fresh and reuse-eligible stage kinds overlap: "
                + ", ".join(sorted(overlap))
            )
        object.__setattr__(self, "always_fresh_stage_kinds", fresh)
        object.__setattr__(self, "reuse_eligible_stage_kinds", eligible)


@dataclass(frozen=True)
class ReuseDecision:
    """Pure policy result; callers decide how to acquire or retire a runtime."""

    allowed: bool
    reason: str
    lease_id: str | None = None
    runtime_id: str | None = None
    direct_continuation: bool = False
    evaluated_lease_ids: tuple[str, ...] = ()

    def to_event_payload(self, request: ReuseRequest) -> dict[str, Any]:
        """Return a JSON-safe, claim-bounded decision event."""

        return {
            "schema": "sophia.workflow.worker_reuse_event.v1",
            "eventType": "workflow.worker_reuse.decision",
            "workflowId": request.logical_agent.workflow_id,
            "logicalAgentId": request.logical_agent.agent_id,
            "taskId": request.task_id,
            "predecessorTaskId": request.predecessor_task_id,
            "stageKind": request.stage_kind,
            "requestedAt": request.requested_at,
            "fingerprintId": request.fingerprint.stable_id(),
            "allowed": self.allowed,
            "reason": self.reason,
            "leaseId": self.lease_id,
            "runtimeId": self.runtime_id,
            "directContinuation": self.direct_continuation,
            "evaluatedLeaseIds": list(self.evaluated_lease_ids),
            "candidateOnly": True,
            "canClaimAGI": False,
        }


def _candidate_sort_key(
    request: ReuseRequest,
    lease: WorkerLease,
) -> tuple[int, float, str]:
    """Prefer direct continuation, then the warmest compatible context."""

    return (
        0 if request.is_direct_continuation_of(lease) else 1,
        -lease.last_used_at,
        lease.lease_id,
    )


def _candidate_denial_reason(
    request: ReuseRequest,
    lease: WorkerLease,
    config: ReusePolicyConfig,
) -> str | None:
    if lease.lease_state is not LeaseState.WARM:
        return ReuseReason.LEASE_NOT_WARM
    if lease.runtime.state is not RuntimeState.READY:
        return ReuseReason.RUNTIME_NOT_READY
    if lease.logical_agent.workflow_id != request.logical_agent.workflow_id:
        return ReuseReason.WORKFLOW_MISMATCH
    if lease.logical_agent.agent_id != request.logical_agent.agent_id:
        return ReuseReason.LOGICAL_AGENT_MISMATCH
    mismatch = lease.fingerprint.mismatch_reason(request.fingerprint)
    if mismatch is not None:
        return mismatch
    age = request.requested_at - lease.last_used_at
    if age < 0:
        return ReuseReason.CLOCK_SKEW
    if age >= config.ttl_seconds:
        return ReuseReason.TTL_EXPIRED
    if lease.reuse_count >= config.max_reuses:
        return ReuseReason.REUSE_LIMIT_REACHED
    projected_context = lease.context_tokens + request.additional_context_tokens
    projected_fraction = projected_context / lease.context_window_tokens
    if projected_fraction > config.max_context_fraction:
        return ReuseReason.CONTEXT_LIMIT_EXCEEDED
    return None


def decide_worker_reuse(
    request: ReuseRequest,
    candidates: Sequence[WorkerLease],
    config: ReusePolicyConfig = ReusePolicyConfig(),
) -> ReuseDecision:
    """Return a deterministic allow/deny result without mutating candidates.

    Fresh-only stage kinds fail before the candidate pool is inspected.  For an
    eligible stage, all candidates are considered in a stable order so an
    incompatible newer runtime cannot mask a compatible older one.  If every
    candidate is rejected, the reason from the highest-priority candidate is
    returned.
    """

    stage_kind = request.stage_kind
    if stage_kind in config.always_fresh_stage_kinds:
        return ReuseDecision(
            allowed=False,
            reason=ReuseReason.STAGE_REQUIRES_FRESH,
        )
    if stage_kind not in config.reuse_eligible_stage_kinds:
        return ReuseDecision(
            allowed=False,
            reason=ReuseReason.STAGE_NOT_ELIGIBLE,
        )
    if not candidates:
        return ReuseDecision(
            allowed=False,
            reason=ReuseReason.NO_CANDIDATES,
        )

    ordered = sorted(candidates, key=lambda lease: _candidate_sort_key(request, lease))
    evaluated: list[str] = []
    first_reason: str | None = None
    for lease in ordered:
        evaluated.append(lease.lease_id)
        reason = _candidate_denial_reason(request, lease, config)
        if reason is None:
            direct = request.is_direct_continuation_of(lease)
            return ReuseDecision(
                allowed=True,
                reason=ReuseReason.ALLOWED,
                lease_id=lease.lease_id,
                runtime_id=lease.runtime.runtime_id,
                direct_continuation=direct,
                evaluated_lease_ids=tuple(evaluated),
            )
        if first_reason is None:
            first_reason = reason

    return ReuseDecision(
        allowed=False,
        reason=first_reason or ReuseReason.NO_CANDIDATES,
        evaluated_lease_ids=tuple(evaluated),
    )


# Short alias for callers that already have a worker-reuse namespace.
decide_reuse = decide_worker_reuse


def _lru_key(lease: WorkerLease) -> tuple[float, float, str]:
    return (lease.last_used_at, lease.created_at, lease.lease_id)


def select_lru_evictions(
    leases: Sequence[WorkerLease],
    *,
    now: float,
    config: ReusePolicyConfig = ReusePolicyConfig(),
) -> tuple[WorkerLease, ...]:
    """Select warm leases to evict for TTL and configured capacity bounds.

    Expired warm leases are selected first.  Remaining capacity violations are
    resolved oldest-first.  A single eviction may satisfy both a workflow and a
    provider limit, so the helper does not over-evict.
    """

    current_time = _finite_number(now, "now")
    warm = sorted(
        (lease for lease in leases if lease.lease_state is LeaseState.WARM),
        key=_lru_key,
    )
    selected: list[WorkerLease] = []
    selected_ids: set[str] = set()

    for lease in warm:
        age = current_time - lease.last_used_at
        if age >= config.ttl_seconds:
            selected.append(lease)
            selected_ids.add(lease.lease_id)

    remaining = [lease for lease in warm if lease.lease_id not in selected_ids]
    workflow_counts = Counter(
        lease.logical_agent.workflow_id for lease in remaining
    )
    provider_counts = Counter(lease.fingerprint.provider for lease in remaining)

    for lease in remaining:
        workflow_id = lease.logical_agent.workflow_id
        provider = lease.fingerprint.provider
        if (
            workflow_counts[workflow_id] > config.max_warm_per_workflow
            or provider_counts[provider] > config.max_warm_per_provider
        ):
            selected.append(lease)
            selected_ids.add(lease.lease_id)
            workflow_counts[workflow_id] -= 1
            provider_counts[provider] -= 1

    return tuple(selected)


def select_lru_eviction_ids(
    leases: Sequence[WorkerLease],
    *,
    now: float,
    config: ReusePolicyConfig = ReusePolicyConfig(),
) -> tuple[str, ...]:
    """ID-only convenience wrapper around :func:`select_lru_evictions`."""

    return tuple(
        lease.lease_id
        for lease in select_lru_evictions(leases, now=now, config=config)
    )


lru_eviction_candidates = select_lru_evictions


def eviction_event_payload(
    lease: WorkerLease,
    *,
    reason: str,
    evicted_at: float,
) -> dict[str, Any]:
    """Return a JSON-safe, claim-bounded LRU/TTL eviction event."""

    return {
        "schema": "sophia.workflow.worker_reuse_event.v1",
        "eventType": "workflow.worker_reuse.eviction",
        "workflowId": lease.logical_agent.workflow_id,
        "logicalAgentId": lease.logical_agent.agent_id,
        "leaseId": lease.lease_id,
        "runtimeId": lease.runtime.runtime_id,
        "provider": lease.fingerprint.provider,
        "fingerprintId": lease.fingerprint.stable_id(),
        "reason": _required_text(reason, "reason"),
        "evictedAt": _finite_number(evicted_at, "evicted_at"),
        "candidateOnly": True,
        "canClaimAGI": False,
    }


__all__ = [
    "ALWAYS_FRESH_STAGE_KINDS",
    "REUSABLE_LEASE_STATES",
    "REUSABLE_RUNTIME_STATES",
    "REUSE_ELIGIBLE_STAGE_KINDS",
    "CompatibilityFingerprint",
    "LeaseState",
    "LogicalAgentIdentity",
    "ReuseDecision",
    "ReusePolicyConfig",
    "ReuseReason",
    "ReuseRequest",
    "RuntimeState",
    "WorkerLease",
    "WorkerRuntime",
    "decide_reuse",
    "decide_worker_reuse",
    "eviction_event_payload",
    "lru_eviction_candidates",
    "normalize_stage_kind",
    "select_lru_eviction_ids",
    "select_lru_evictions",
]
