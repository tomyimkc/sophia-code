"""Thread-safe execution budgets for independent agent jobs."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math
import threading
import time
import uuid
from typing import Callable, Optional, Union

Number = Union[int, float]


class RejectionReason(str, Enum):
    CONCURRENCY = "concurrency"
    CANCELLED = "cancelled"
    DEADLINE = "deadline"
    USD = "usd"
    INPUT_TOKENS = "input_tokens"
    OUTPUT_TOKENS = "output_tokens"
    CACHE_TOKENS = "cache_tokens"
    TOOL_CALLS = "tool_calls"
    PARENT = "parent"
    INVALID = "invalid"


class BudgetRejected(RuntimeError):
    def __init__(self, reason: RejectionReason, message: str = "") -> None:
        self.reason = reason
        super().__init__(message or f"execution budget rejected: {reason.value}")


def _valid_number(value: object, *, integer: bool = False) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if integer:
        return isinstance(value, int)
    try:
        return math.isfinite(value)
    except (OverflowError, TypeError, ValueError):
        return False


def _check_nonnegative(value: object, name: str, *, integer: bool = False) -> None:
    if not _valid_number(value, integer=integer) or value < 0:
        raise ValueError(f"{name} must be a finite non-negative {'integer' if integer else 'number'}")


@dataclass(frozen=True)
class Limits:
    usd: Optional[float] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cache_tokens: Optional[int] = None
    tool_calls: Optional[int] = None

    def __post_init__(self) -> None:
        if self.usd is not None:
            _check_nonnegative(self.usd, "usd")
        for name in ("input_tokens", "output_tokens", "cache_tokens", "tool_calls"):
            value = getattr(self, name)
            if value is not None:
                _check_nonnegative(value, name, integer=True)


@dataclass(frozen=True)
class Usage:
    usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_tokens: int = 0
    tool_calls: int = 0

    def __post_init__(self) -> None:
        _check_nonnegative(self.usd, "usd")
        for name in ("input_tokens", "output_tokens", "cache_tokens", "tool_calls"):
            _check_nonnegative(getattr(self, name), name, integer=True)

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(*(a + b for a, b in zip(self, other)))

    def __iter__(self):
        yield self.usd
        yield self.input_tokens
        yield self.output_tokens
        yield self.cache_tokens
        yield self.tool_calls


@dataclass(frozen=True)
class CorrelationIds:
    run_id: Optional[str] = None
    task_id: Optional[str] = None
    request_id: Optional[str] = None
    budget_id: str = ""
    parent_budget_id: Optional[str] = None

    def __post_init__(self) -> None:
        for name in ("run_id", "task_id", "request_id", "budget_id", "parent_budget_id"):
            value = getattr(self, name)
            if value is not None and (not isinstance(value, str) or not value):
                raise ValueError(f"{name} must be a non-empty string")

    def to_dict(self) -> dict[str, str]:
        return {name: value for name in ("run_id", "task_id", "request_id", "budget_id", "parent_budget_id")
                if (value := getattr(self, name)) is not None}

    as_dict = to_dict

    @property
    def run(self) -> Optional[str]:
        return self.run_id

    @property
    def task(self) -> Optional[str]:
        return self.task_id

    @property
    def request(self) -> Optional[str]:
        return self.request_id

    @property
    def budget(self) -> str:
        return self.budget_id

    @property
    def parent_budget(self) -> Optional[str]:
        return self.parent_budget_id


@dataclass(frozen=True)
class BudgetRemaining:
    """Remaining capacity; ``None`` explicitly represents an unlimited axis."""

    usd: Optional[float]
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    cache_tokens: Optional[int]
    tool_calls: Optional[int]


@dataclass(frozen=True)
class BudgetSnapshot:
    limits: Limits
    committed: Usage
    reserved: Usage
    active_leases: int
    max_concurrency: Optional[int]
    deadline: Optional[float]
    cancelled: bool
    correlation: CorrelationIds

    @property
    def remaining(self) -> BudgetRemaining:
        u = self.committed + self.reserved
        return BudgetRemaining(
            usd=None if self.limits.usd is None else max(0.0, self.limits.usd - u.usd),
            input_tokens=None if self.limits.input_tokens is None else max(0, self.limits.input_tokens - u.input_tokens),
            output_tokens=None if self.limits.output_tokens is None else max(0, self.limits.output_tokens - u.output_tokens),
            cache_tokens=None if self.limits.cache_tokens is None else max(0, self.limits.cache_tokens - u.cache_tokens),
            tool_calls=None if self.limits.tool_calls is None else max(0, self.limits.tool_calls - u.tool_calls),
        )


class Lease:
    def __init__(self, budget: "ExecutionBudget", estimate: Usage, parent: Optional["Lease"] = None):
        self._budget, self.estimate, self._parent = budget, estimate, parent
        self._closed = False
        self._committed = False
        self._lock = threading.Lock()

    def commit(self, actual: Optional[Usage] = None, **kwargs: Number) -> Usage:
        if actual is None:
            actual = _usage(kwargs)
        elif kwargs:
            raise TypeError("pass either Usage or usage fields")
        if not isinstance(actual, Usage):
            raise TypeError("actual must be Usage")
        self._budget._commit_chain(self, actual)
        return actual

    def refund(self) -> None:
        self._budget._refund_chain(self)

    release = refund

    def __enter__(self) -> "Lease":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.refund()
        return False


def _usage_minus(left: Usage, right: Usage) -> Usage:
    values = {
        name: left_value - right_value
        for name, left_value, right_value in zip(
            ("usd", "input_tokens", "output_tokens", "cache_tokens", "tool_calls"),
            left,
            right,
        )
    }
    if any(value < 0 for value in values.values()):
        raise AssertionError("usage counters cannot be negative")
    return Usage(**values)


def _usage(values: dict) -> Usage:
    allowed = {"usd", "input_tokens", "output_tokens", "cache_tokens", "tool_calls"}
    if set(values) - allowed:
        raise TypeError(f"unknown usage fields: {set(values) - allowed}")
    try:
        return Usage(**values)
    except (TypeError, ValueError) as error:
        raise BudgetRejected(RejectionReason.INVALID, str(error)) from error


class ExecutionBudget:
    def __init__(self, limits: Limits = Limits(), *, max_concurrency: Optional[int] = None,
                 deadline: Optional[float] = None, clock: Callable[[], float] = time.monotonic,
                 parent: Optional["ExecutionBudget"] = None, correlation: Optional[CorrelationIds] = None,
                 run_id: Optional[str] = None, task_id: Optional[str] = None,
                 request_id: Optional[str] = None, budget_id: Optional[str] = None) -> None:
        if not isinstance(limits, Limits):
            raise TypeError("limits must be Limits")
        if max_concurrency is not None and (not isinstance(max_concurrency, int) or isinstance(max_concurrency, bool) or max_concurrency < 1):
            raise ValueError("max_concurrency must be a positive integer")
        if deadline is not None and (not _valid_number(deadline) or deadline < 0):
            raise ValueError("deadline must be a finite non-negative number")
        if correlation is not None and any(v is not None for v in (run_id, task_id, request_id, budget_id)):
            raise TypeError("pass either correlation or individual correlation IDs")
        self.limits, self.max_concurrency, self._clock = limits, max_concurrency, clock
        self._parent, self._deadline = parent, deadline
        self._correlation = correlation or CorrelationIds(run_id, task_id, request_id, budget_id or uuid.uuid4().hex,
                                                         parent.snapshot().correlation.budget_id if parent else None)
        self._cancel = threading.Event()
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._committed, self._reserved = Usage(), Usage()
        self._active = 0

    @property
    def deadline(self) -> Optional[float]:
        return self._deadline

    def cancel(self) -> None:
        # Acquire the hierarchy in parent-before-child order.
        with _Locks(self._chain()):
            self._cancel.set()
            self._condition.notify_all()

    def child(self, limits: Limits = Limits(), *, deadline: Optional[float] = None,
              max_concurrency: Optional[int] = None) -> "ExecutionBudget":
        inherited = self._deadline if deadline is None else deadline
        if self._deadline is not None and inherited is not None:
            inherited = min(self._deadline, inherited)
        return ExecutionBudget(limits, max_concurrency=max_concurrency, deadline=inherited,
                               clock=self._clock, parent=self)

    def reserve(self, estimate: Optional[Usage] = None, **kwargs: Number) -> Lease:
        if estimate is not None and kwargs:
            raise TypeError("pass either Usage or usage fields")
        estimate = estimate if estimate is not None else _usage(kwargs)
        if not isinstance(estimate, Usage):
            raise TypeError("estimate must be Usage")
        chain = self._chain()
        with _Locks(chain):
            self._check(estimate)
            while any(budget.max_concurrency is not None and budget._active >= budget.max_concurrency
                       for budget in chain):
                # Condition.wait reacquires self._lock before returning. Release it
                # before reacquiring ancestors so lock order remains parent-first.
                for ancestor in reversed(chain[:-1]):
                    ancestor._lock.release()
                try:
                    self._wait_or_reject()
                finally:
                    # Drop the child lock acquired by Condition.wait before
                    # restoring the full hierarchy in canonical order.
                    self._lock.release()
                    for ancestor in chain[:-1]:
                        ancestor._lock.acquire()
                    self._lock.acquire()
                self._check(estimate)
            for budget in chain:
                budget._check(estimate)
                budget._reserved, budget._active = budget._reserved + estimate, budget._active + 1
                budget._assert_invariants()
            for budget in chain:
                budget._condition.notify_all()
        parent_lease = None
        for budget in chain[:-1]:
            parent_lease = Lease(budget, estimate, parent_lease)
        return Lease(self, estimate, parent_lease)

    def snapshot(self) -> BudgetSnapshot:
        with _Locks(self._chain()):
            cancelled = any(budget._cancel.is_set() for budget in self._chain())
            return BudgetSnapshot(self.limits, self._committed, self._reserved, self._active,
                                  self.max_concurrency, self._deadline, cancelled, self._correlation)

    def effective_remaining(self) -> BudgetRemaining:
        """Most restrictive remaining capacity across this budget hierarchy."""
        snapshots = [budget.snapshot() for budget in self._chain()]

        def minimum(name: str):
            values = [getattr(snapshot.remaining, name) for snapshot in snapshots]
            finite = [value for value in values if value is not None]
            return min(finite) if finite else None

        return BudgetRemaining(
            usd=minimum("usd"),
            input_tokens=minimum("input_tokens"),
            output_tokens=minimum("output_tokens"),
            cache_tokens=minimum("cache_tokens"),
            tool_calls=minimum("tool_calls"),
        )

    def _chain(self):
        chain, budget = [], self
        while budget is not None:
            chain.append(budget)
            budget = budget._parent
        return list(reversed(chain))

    def _wait_or_reject(self) -> None:
        if self._cancel.is_set() or any(budget._cancel.is_set() for budget in self._chain()[:-1]):
            raise BudgetRejected(RejectionReason.CANCELLED)
        if self._deadline is not None and self._clock() >= self._deadline:
            raise BudgetRejected(RejectionReason.DEADLINE)
        timeout = 0.05 if self._deadline is None else min(0.05, max(0.0, self._deadline - self._clock()))
        self._condition.wait(timeout)

    def _check(self, u: Usage, *, replacing: Optional[Usage] = None) -> None:
        if self._cancel.is_set() or any(budget._cancel.is_set() for budget in self._chain()[:-1]):
            raise BudgetRejected(RejectionReason.CANCELLED)
        if self._deadline is not None and self._clock() >= self._deadline:
            raise BudgetRejected(RejectionReason.DEADLINE)
        # A commit consumes this lease's estimate and replaces it with actual
        # usage. Actual usage may exceed the estimate when the resulting total
        # still fits the limits; estimates are reservations, not hard caps.
        reserved = self._reserved if replacing is None else _usage_minus(self._reserved, replacing)
        total = self._committed + reserved + u
        for field, reason in (("usd", RejectionReason.USD), ("input_tokens", RejectionReason.INPUT_TOKENS),
                              ("output_tokens", RejectionReason.OUTPUT_TOKENS), ("cache_tokens", RejectionReason.CACHE_TOKENS),
                              ("tool_calls", RejectionReason.TOOL_CALLS)):
            limit = getattr(self.limits, field)
            if limit is not None and getattr(total, field) > limit:
                raise BudgetRejected(reason)

    def _refund(self, estimate: Usage) -> None:
        self._reserved = _usage_minus(self._reserved, estimate)
        self._active -= 1
        self._assert_invariants()
        self._condition.notify()

    def _refund_chain(self, lease: Lease) -> None:
        leases, current = [], lease
        while current is not None:
            leases.append(current)
            current = current._parent
        with _Locks([item._budget for item in reversed(leases)]):
            if lease._closed:
                return
            for item in leases:
                item._budget._refund(item.estimate)
                item._closed = True
            for budget in {item._budget for item in leases}:
                budget._condition.notify_all()

    def _assert_invariants(self) -> None:
        if self._active < 0:
            raise AssertionError("active lease count cannot be negative")
        for usage_name, usage in (("reserved", self._reserved), ("committed", self._committed)):
            if any(value < 0 for value in usage):
                raise AssertionError(f"{usage_name} usage cannot be negative")

    def _commit_chain(self, lease: Lease, actual: Usage) -> None:
        leases = []
        current = lease
        while current is not None:
            leases.append(current)
            current = current._parent
        budgets = {item._budget for item in leases}
        with _Locks(budgets):
            if any(item._closed for item in leases):
                raise RuntimeError("lease is already closed")
            try:
                for item in leases:
                    item._budget._check(actual, replacing=item.estimate)
            except Exception:
                # A rejected commit leaves every reservation open and unchanged.
                # The caller may explicitly refund or retry the same lease.
                for item in leases:
                    item._budget._assert_invariants()
                raise
            for item in leases:
                budget = item._budget
                budget._reserved = _usage_minus(budget._reserved, item.estimate)
                budget._committed = budget._committed + actual
                budget._active -= 1
                budget._assert_invariants()
                budget._condition.notify()
                item._committed = item._closed = True


class _Locks:
    def __init__(self, budgets):
        self.budgets = sorted(set(budgets), key=_depth)

    def __enter__(self):
        for budget in self.budgets:
            budget._lock.acquire()
        return self

    def __exit__(self, *_):
        for budget in reversed(self.budgets):
            budget._lock.release()


def _depth(budget: ExecutionBudget) -> int:
    depth = 0
    while budget._parent is not None:
        depth += 1
        budget = budget._parent
    return depth


__all__ = ["BudgetRejected", "BudgetRemaining", "BudgetSnapshot", "CorrelationIds", "ExecutionBudget", "Lease", "Limits", "RejectionReason", "Usage"]
