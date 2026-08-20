"""Durable, normalized task lifecycle receipts.

The module deliberately has no dependency on the rest of Sophia.  Receipt files are
JSONL so they can be tailed by operators and recovered after an interrupted write.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import time
import uuid
import threading
import dataclasses
import numbers
from contextlib import contextmanager

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None
try:
    import msvcrt
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from agent.secret_patterns import redact_diagnostic


class TaskKind(str, Enum):
    WORKFLOW = "workflow"
    PHASE = "phase"
    AGENT = "agent"
    SHELL = "shell"
    TOOL = "tool"
    VALIDATION = "validation"


class TaskState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    BLOCKED = "blocked"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    #: A node whose owning process is confirmed gone (crashed / killed) while
    #: the node was still QUEUED/BLOCKED/RUNNING. Distinct from CANCELLED
    #: (an operator decision) and FAILED (the work itself errored) — nobody
    #: decided this outcome, the receipt journal simply never saw a verdict.
    INTERRUPTED = "interrupted"


TERMINAL_STATES = frozenset({TaskState.SUCCEEDED, TaskState.FAILED, TaskState.CANCELLED, TaskState.INTERRUPTED})
_ALLOWED: dict[TaskState, frozenset[TaskState]] = {
    TaskState.QUEUED: frozenset({TaskState.RUNNING, TaskState.BLOCKED, TaskState.CANCELLED, TaskState.INTERRUPTED}),
    TaskState.BLOCKED: frozenset({TaskState.QUEUED, TaskState.RUNNING, TaskState.CANCELLED, TaskState.INTERRUPTED}),
    TaskState.RUNNING: frozenset({TaskState.BLOCKED, TaskState.SUCCEEDED, TaskState.FAILED, TaskState.CANCELLED,
                                   TaskState.INTERRUPTED}),
    TaskState.SUCCEEDED: frozenset(), TaskState.FAILED: frozenset({TaskState.QUEUED}), TaskState.CANCELLED: frozenset(),
    TaskState.INTERRUPTED: frozenset(),
}


@dataclass(frozen=True)
class TaskNode:
    task_id: str
    kind: TaskKind
    name: str
    state: TaskState = TaskState.QUEUED
    parent_id: str | None = None
    run_id: str = ""
    request_id: str | None = None
    session: str | None = None
    route_id: str | None = None
    context_id: str | None = None
    retrieval_id: str | None = None
    model_call_id: str | None = None
    tool_call_id: str | None = None
    gate_id: str | None = None
    claim_id: str | None = None
    evidence_id: str | None = None
    budget_id: str | None = None
    sequence: int = 0
    created_at: str = ""
    updated_at: str = ""
    progress: float | None = None
    detail: Mapping[str, Any] = field(default_factory=dict)
    timings: Mapping[str, Any] = field(default_factory=dict)
    attempt: int = 1
    cost: Mapping[str, Any] = field(default_factory=dict)
    token_counts: Mapping[str, int] = field(default_factory=dict)
    artifacts: tuple[Mapping[str, Any], ...] = ()
    can_cancel: bool = False
    can_retry: bool = False

    def __post_init__(self) -> None:
        if not self.task_id or not self.name or not self.run_id:
            raise ValueError("task_id, name, and run_id are required")
        if self.progress is not None and not 0 <= self.progress <= 1:
            raise ValueError("progress must be between 0 and 1")
        if self.attempt < 1:
            raise ValueError("attempt must be positive")

    def to_dict(self) -> dict[str, Any]:
        value = {
            "taskId": self.task_id, "kind": self.kind.value, "name": self.name, "state": self.state.value,
            "parentId": self.parent_id, "runId": self.run_id, "requestId": self.request_id,
            "session": self.session, "routeId": self.route_id, "contextId": self.context_id,
            "retrievalId": self.retrieval_id, "modelCallId": self.model_call_id, "toolCallId": self.tool_call_id,
            "gateId": self.gate_id, "claimId": self.claim_id, "evidenceId": self.evidence_id, "budgetId": self.budget_id,
            "sequence": self.sequence, "createdAt": self.created_at,
            "updatedAt": self.updated_at, "progress": self.progress, "detail": copy.deepcopy(self.detail),
            "timings": copy.deepcopy(self.timings), "attempt": self.attempt, "cost": copy.deepcopy(self.cost),
            "tokenCounts": copy.deepcopy(self.token_counts), "artifacts": copy.deepcopy(list(self.artifacts)),
            "canCancel": self.can_cancel, "canRetry": self.can_retry,
        }
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "TaskNode":
        data = dict(value)
        aliases = {"taskId": "task_id", "parentId": "parent_id", "runId": "run_id", "requestId": "request_id",
                   "routeId": "route_id", "contextId": "context_id", "retrievalId": "retrieval_id",
                   "modelCallId": "model_call_id", "toolCallId": "tool_call_id", "gateId": "gate_id",
                   "claimId": "claim_id", "evidenceId": "evidence_id", "budgetId": "budget_id",
                   "createdAt": "created_at", "updatedAt": "updated_at", "tokenCounts": "token_counts",
                   "canCancel": "can_cancel", "canRetry": "can_retry"}
        for source, target in aliases.items():
            if source in data: data[target] = data.pop(source)
        allowed = {field.name for field in dataclasses.fields(cls)}
        data = {key: value for key, value in data.items() if key in allowed}
        data["kind"] = TaskKind(data["kind"])
        data["state"] = TaskState(data["state"])
        data["detail"] = redact(data.get("detail", {}))
        data["timings"] = redact(data.get("timings", {}))
        data["cost"] = redact(data.get("cost", {}))
        data["artifacts"] = tuple(redact(item) for item in data.get("artifacts", ()))
        data["token_counts"] = redact(data.get("token_counts", {}), _token_mapping=True)
        return cls(**data)


@dataclass(frozen=True)
class TaskEvent:
    event: str
    node: TaskNode
    previous_state: TaskState | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"event": self.event, "previousState": self.previous_state.value if self.previous_state else None,
                "node": self.node.to_dict()}


_SECRET_KEY = re.compile(
    r"(?:"
    r"prompt|secret|password|token|api[_-]?key|authorization|"
    r"raw[_-]?(?:arg|result)|reasoning|content"
    r")",
    re.I,
)
_SENSITIVE_CONTAINER_KEY = re.compile(
    r"(?:"
    r"env(?:ironment)?|"
    r"(?:raw[_-]?)?(?:command(?:[_-]?line)?|cmd|argv)|"
    r"subprocess(?:[_-]?(?:command|argv))?|"
    r"auth(?:entication)?[_-]?output|login[_-]?output"
    r")\Z",
    re.I,
)
_TOKEN_COUNT_KEY = re.compile(r"(?:token|tokens)[_-]?(?:count|counts|input|output|prompt|completion|total)$", re.I)
_NUMERIC_TOKEN_KEY = re.compile(r"(?:input|output|cache[_-]read|cache[_-]write|reasoning)_tokens$", re.I)

# A transition may update only lifecycle/progress data.  Identity, provenance,
# and capability fields are immutable for the lifetime of a task.
_TRANSITION_MUTABLE_FIELDS = frozenset({
    "state", "sequence", "updatedAt", "progress", "detail", "timings",
    "attempt", "cost", "tokenCounts", "artifacts",
})

# These values are journal structure, not free-form telemetry.  They must
# round-trip byte-for-byte: a redaction false positive here changes the lookup
# key used by the next transition and corrupts the task graph.  In particular,
# UUID digit runs can resemble payment-card numbers to the general diagnostic
# scrubber.  User/provider-controlled fields (requestId, session, detail, ...)
# remain subject to normal redaction.
_JOURNAL_IDENTITY_FIELDS = frozenset({"taskId", "parentId", "runId"})


def redact(value: Any, *, _key: str = "", _token_mapping: bool = False) -> Any:
    """Recursively copy values, retaining only finite numbers in telemetry fields.

    Token-count mappings are traversed recursively: finite numeric leaves survive,
    while strings, booleans, non-finite numbers, and other values are redacted.
    """
    normalized_key = re.sub(r"[_-]", "", _key).lower()
    # Additive lifecycle discriminator used by the bridge/TUI to distinguish a
    # resumable owner-input pause from an ordinary failed run. It is a boolean,
    # never user content or telemetry, despite containing the substring
    # "input" that the broad token-mapping guard below intentionally redacts.
    if normalized_key == "awaitinginput" and isinstance(value, bool):
        return value
    token_mapping = _token_mapping or normalized_key in {"tokencount", "tokencounts"}
    key = _key.lower()
    telemetry_key = bool(token_mapping or _NUMERIC_TOKEN_KEY.search(_key) or _TOKEN_COUNT_KEY.search(_key)
                         or normalized_key in {"token", "tokens"}
                         or any(term in key for term in ("input", "output", "reasoning", "cache")))
    numeric = isinstance(value, numbers.Real) and not isinstance(value, bool) and math.isfinite(value)
    if telemetry_key:
        if numeric:
            return copy.deepcopy(value)
        if isinstance(value, Mapping):
            return {str(k): redact(v, _key=str(k), _token_mapping=True) for k, v in value.items()}
        return "[REDACTED]"
    if _key and (_SECRET_KEY.search(_key) or _SENSITIVE_CONTAINER_KEY.fullmatch(_key)):
        return "[REDACTED]"
    if isinstance(value, Mapping):
        return {str(k): redact(v, _key=str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v, _key=_key, _token_mapping=token_mapping) for v in value]
    if isinstance(value, str):
        return redact_diagnostic(value)
    if isinstance(value, (int, float, bool)) or value is None:
        return copy.deepcopy(value)
    return "[REDACTED]"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# A journal untouched this long cannot belong to a live run (one writes
# continuously). Used only for pid-less legacy receipts; generous on purpose,
# since the cost of waiting is a stale row and the cost of being wrong is
# calling a live run dead.
LEGACY_STALE_SEC = float(os.environ.get("SOPHIA_RECEIPTS_LEGACY_STALE_SEC", 3600))


class TaskReceiptStore:
    """Append-only receipt journal and in-memory reconstructed snapshot."""
    def __init__(self, path: str | os.PathLike[str], *, run_id: str | None = None,
                 clock: Callable[[], str] = _now, id_factory: Callable[[], str] | None = None):
        self.path = Path(path)
        self._lock = threading.RLock()
        self.clock, self.id_factory = clock, id_factory or (lambda: str(uuid.uuid4()))
        self.schema_version = 1
        self._run_id_explicit = run_id is not None
        self.run_id = run_id or ""
        self._nodes: dict[str, TaskNode] = {}
        self._sequence = 0
        self._head_path = self.path.with_name(self.path.name + ".head")
        self._txn_path = self.path.with_name(self.path.name + ".txn")
        self._hash = "0" * 64
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        with self._lock, self._file_lock():
            self._replay_unlocked()
        if not self.run_id:
            self.run_id = self.id_factory()

    @property
    def nodes(self) -> Mapping[str, TaskNode]:
        """Return this process's coherent point-in-time instance snapshot.

        It may be stale when another process appends receipts; call :meth:`replay`
        explicitly to refresh from disk rather than forcing I/O on every UI read.
        """
        with self._lock:
            return {key: copy.deepcopy(value) for key, value in self._nodes.items()}

    @contextmanager
    def _file_lock(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        if self.path.exists(): os.chmod(self.path, 0o600)
        if self._txn_path.exists(): os.chmod(self._txn_path, 0o600)
        if self._head_path.exists(): os.chmod(self._head_path, 0o600)
        tmp_path = self._head_path.with_name(self._head_path.name + ".tmp")
        if tmp_path.exists(): os.chmod(tmp_path, 0o600)
        lock_path = self.path.with_name(self.path.name + ".lock")
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        os.chmod(lock_path, 0o600)
        try:
            if msvcrt is not None and os.fstat(lock_fd).st_size == 0:
                os.write(lock_fd, b"\\0")
                os.fsync(lock_fd)
                os.lseek(lock_fd, 0, os.SEEK_SET)
            if fcntl is not None:
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
            elif msvcrt is not None:
                msvcrt.locking(lock_fd, msvcrt.LK_LOCK, 1)
            else:
                raise RuntimeError("interprocess locking is unsupported on this platform")
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            elif msvcrt is not None:
                os.lseek(lock_fd, 0, os.SEEK_SET)
                msvcrt.locking(lock_fd, msvcrt.LK_UNLCK, 1)
            os.close(lock_fd)

    def _append(self, event: TaskEvent) -> TaskEvent:
        raw_payload = event.to_dict()
        payload = redact(raw_payload)
        # Restore only the internal relational identifiers after scrubbing the
        # rest of the event.  Without this, a UUID such as the one captured in
        # the concurrent workflow regression can be persisted as
        # ``[REDACTED:credit_card]`` and the immediately following transition
        # raises KeyError for the original task id.
        raw_node = raw_payload["node"]
        safe_node = payload["node"]
        for field_name in _JOURNAL_IDENTITY_FIELDS:
            safe_node[field_name] = raw_node[field_name]
        payload["schemaVersion"] = self.schema_version
        payload["previousHash"] = self._hash
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        payload["hash"] = hashlib.sha256(canonical).hexdigest()
        line = (json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        txn = json.dumps({"sequence": event.node.sequence, "hash": payload["hash"],
                          "previousHash": payload["previousHash"], "intention": "advance_head"},
                         sort_keys=True).encode() + b"\n"
        txn_fd = os.open(self._txn_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(self._txn_path, 0o600)
        try:
            os.write(txn_fd, txn)
            os.fsync(txn_fd)
        finally:
            os.close(txn_fd)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            view = memoryview(line)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("os.write returned no progress")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(self.path, 0o600)
        self._nodes[event.node.task_id] = event.node
        self._sequence = max(self._sequence, event.node.sequence)
        self._hash = payload["hash"]
        self._write_head()
        try:
            self._txn_path.unlink()
        except FileNotFoundError:
            # Best-effort cleanup: the txn file may already be gone (e.g. a
            # previous run already advanced past this point).
            pass
        return event

    def _write_head(self) -> None:
        value = {"sequence": self._sequence, "hash": self._hash}
        encoded = (json.dumps(value, sort_keys=True) + "\n").encode()
        tmp = self._head_path.with_name(self._head_path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(tmp, 0o600)
        try:
            os.write(fd, encoded)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, self._head_path)
        os.chmod(self._head_path, 0o600)
        dir_fd = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    def create(self, name: str, kind: TaskKind | str, *, parent_id: str | None = None,
               request_id: str | None = None, session: str | None = None, detail: Mapping[str, Any] | None = None,
               can_cancel: bool = False, can_retry: bool = False, route_id: str | None = None,
               context_id: str | None = None, retrieval_id: str | None = None, model_call_id: str | None = None,
               tool_call_id: str | None = None, gate_id: str | None = None, claim_id: str | None = None,
               evidence_id: str | None = None, budget_id: str | None = None, **metadata: Any) -> TaskNode:
        with self._lock, self._file_lock():
            self._replay_unlocked()
            return self._create(name, kind, parent_id=parent_id, request_id=request_id, session=session, detail=detail,
                                can_cancel=can_cancel, can_retry=can_retry, route_id=route_id, context_id=context_id,
                                retrieval_id=retrieval_id, model_call_id=model_call_id, tool_call_id=tool_call_id,
                                gate_id=gate_id, claim_id=claim_id, evidence_id=evidence_id, budget_id=budget_id, **metadata)

    def _create(self, name: str, kind: TaskKind | str, *, parent_id: str | None = None,
               request_id: str | None = None, session: str | None = None, detail: Mapping[str, Any] | None = None,
               can_cancel: bool = False, can_retry: bool = False, route_id: str | None = None,
               context_id: str | None = None, retrieval_id: str | None = None, model_call_id: str | None = None,
               tool_call_id: str | None = None, gate_id: str | None = None, claim_id: str | None = None,
               evidence_id: str | None = None, budget_id: str | None = None, **metadata: Any) -> TaskNode:
        kind = TaskKind(kind)
        if parent_id is not None and parent_id not in self._nodes:
            raise ValueError("parent_id does not identify an existing task")
        task_id = self.id_factory()
        if task_id in self._nodes:
            raise ValueError(f"duplicate task id: {task_id}")
        now = self.clock(); self._sequence += 1
        token_counts = metadata.pop("token_counts", metadata.pop("tokenCounts", {}))
        numeric_tokens = {key: metadata.pop(key) for key in list(metadata)
                          if _NUMERIC_TOKEN_KEY.fullmatch(key)}
        node = TaskNode(task_id, kind, name, parent_id=parent_id, run_id=self.run_id, request_id=request_id,
                        session=session, sequence=self._sequence, created_at=now, updated_at=now,
                        detail=redact({**(detail or {}), **metadata}), can_cancel=can_cancel, can_retry=can_retry,
                                        token_counts=redact({**token_counts, **numeric_tokens}),
                        route_id=route_id, context_id=context_id, retrieval_id=retrieval_id, model_call_id=model_call_id,
                        tool_call_id=tool_call_id, gate_id=gate_id, claim_id=claim_id, evidence_id=evidence_id, budget_id=budget_id)
        self._append(TaskEvent("created", node))
        return node

    def transition(self, task_id: str, state: TaskState | str, *, progress: float | None = None,
                   detail: Mapping[str, Any] | None = None, timings: Mapping[str, Any] | None = None,
                   attempt: int | None = None, cost: Mapping[str, Any] | None = None,
                   token_counts: Mapping[str, int] | None = None, artifacts: Iterable[Mapping[str, Any]] | None = None) -> TaskNode:
        with self._lock, self._file_lock():
            self._replay_unlocked()
            return self._transition(task_id, state, progress=progress, detail=detail, timings=timings,
                                    attempt=attempt, cost=cost, token_counts=token_counts, artifacts=artifacts)

    @staticmethod
    def _validate_transition(old: TaskNode, new_state: TaskState) -> None:
        if new_state not in _ALLOWED[old.state]:
            raise ValueError(f"invalid task transition: {old.state.value} -> {new_state.value}")
        if new_state == TaskState.CANCELLED and not old.can_cancel:
            raise ValueError("task is not cancellable")
        if new_state == TaskState.QUEUED and old.state == TaskState.FAILED and not old.can_retry:
            raise ValueError("task is not retryable")

    def _transition(self, task_id: str, state: TaskState | str, *, progress: float | None = None,
                   detail: Mapping[str, Any] | None = None, timings: Mapping[str, Any] | None = None,
                   attempt: int | None = None, cost: Mapping[str, Any] | None = None,
                   token_counts: Mapping[str, int] | None = None, artifacts: Iterable[Mapping[str, Any]] | None = None) -> TaskNode:
        old = self._nodes[task_id]; new_state = TaskState(state)
        self._validate_transition(old, new_state)
        now = self.clock(); self._sequence += 1
        node = dataclasses.replace(old, state=new_state, sequence=self._sequence, updated_at=now,
                        progress=progress if progress is not None else old.progress,
                        detail=redact(detail if detail is not None else old.detail), timings=redact(timings if timings is not None else old.timings),
                        attempt=attempt if attempt is not None else old.attempt, cost=redact(cost if cost is not None else old.cost),
                        token_counts=redact(token_counts if token_counts is not None else old.token_counts),
                        artifacts=tuple(redact(a) for a in (artifacts if artifacts is not None else old.artifacts)))
        return self._append(TaskEvent("transition", node, old.state)).node

    def _replay_unlocked(self) -> Mapping[str, TaskNode]:
        self._nodes, self._sequence = {}, 0
        if not self.path.exists(): return self.nodes
        with self.path.open("rb") as fh:
            data = fh.read()
        lines = data.splitlines(keepends=True)
        valid_end = 0
        chain_hash = "0" * 64
        record_meta: list[tuple[int, str]] = []
        for index, raw in enumerate(lines):
            if not raw.strip():
                raise ValueError(f"malformed receipt record at line {index + 1}")
            try: payload = json.loads(raw)
            except json.JSONDecodeError:
                if index == len(lines) - 1 and raw and not raw.endswith(b"\n"):
                    break
                raise ValueError(f"corrupt receipt record at line {index + 1}")
            if not isinstance(payload, dict) or payload.get("schemaVersion") != self.schema_version:
                raise ValueError(f"invalid schemaVersion at line {index + 1}")
            if payload.get("event") not in {"created", "transition"} or not isinstance(payload.get("node"), dict):
                raise ValueError(f"unknown or malformed event at line {index + 1}")
            try:
                node = TaskNode.from_dict(payload["node"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"invalid node at line {index + 1}: {exc}") from exc
            if index == 0 and not self._run_id_explicit:
                self.run_id = node.run_id
            elif index == 0 and node.run_id != self.run_id:
                raise ValueError(f"invalid run or sequence at line {index + 1}")
            if node.run_id != self.run_id or node.sequence <= self._sequence:
                raise ValueError(f"invalid run or sequence at line {index + 1}")
            if node.parent_id is not None and node.parent_id not in self._nodes:
                raise ValueError(f"missing parent at line {index + 1}")
            current = self._nodes.get(node.task_id)
            if payload["event"] == "created":
                if current is not None:
                    raise ValueError(f"duplicate task at line {index + 1}")
                if node.state is not TaskState.QUEUED or payload.get("previousState") is not None:
                    raise ValueError(f"invalid created record at line {index + 1}")
            if payload["event"] == "transition":
                if current is None or payload.get("previousState") != current.state.value:
                    raise ValueError(f"receipt transition mismatch for {node.task_id}")
                old_dict, new_dict = current.to_dict(), node.to_dict()
                changed = {key for key in set(old_dict) | set(new_dict) if old_dict.get(key) != new_dict.get(key)}
                if not changed <= _TRANSITION_MUTABLE_FIELDS:
                    raise ValueError(f"immutable node fields changed at line {index + 1}: {sorted(changed - _TRANSITION_MUTABLE_FIELDS)}")
                try:
                    self._validate_transition(current, node.state)
                except ValueError as exc:
                    raise ValueError(f"invalid receipt transition at line {index + 1}: {exc}") from exc
            if payload.get("previousHash") != chain_hash or not isinstance(payload.get("hash"), str):
                raise ValueError(f"invalid receipt hash at line {index + 1}")
            unsigned = dict(payload); record_hash = unsigned.pop("hash")
            expected_hash = hashlib.sha256(json.dumps(unsigned, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
            if record_hash != expected_hash:
                raise ValueError(f"invalid receipt hash at line {index + 1}")
            chain_hash = record_hash
            self._nodes[node.task_id] = node; self._sequence = node.sequence
            record_meta.append((node.sequence, record_hash))
            valid_end += len(raw)
        if valid_end < len(data):
            with self.path.open("r+b") as fh:
                fh.truncate(valid_end)
        expected = {"sequence": self._sequence, "hash": chain_hash}
        if self._head_path.exists():
            os.chmod(self._head_path, 0o600)
            head = json.loads(self._head_path.read_text())
            if head != expected:
                recovered = False
                if self._txn_path.exists() and record_meta:
                    try:
                        txn = json.loads(self._txn_path.read_text())
                        previous = record_meta[-2] if len(record_meta) > 1 else (0, "0" * 64)
                        last = record_meta[-1]
                        recovered = (txn.get("intention") == "advance_head" and
                                     head.get("sequence") == previous[0] and head.get("hash") == previous[1] and
                                     txn.get("sequence") == last[0] and txn.get("hash") == last[1] and
                                     txn.get("previousHash") == previous[1])
                    except (OSError, ValueError, TypeError, AttributeError):
                        recovered = False
                if recovered:
                    self._sequence, self._hash = expected["sequence"], expected["hash"]
                    self._write_head()
                    try: self._txn_path.unlink()
                    except FileNotFoundError: pass  # Best-effort cleanup: txn file may already be gone.
                else:
                    raise ValueError("receipt journal head mismatch")
        elif valid_end:
            # A crash can leave the first durable record and its transaction before
            # the initial head rename.  The implicit predecessor is sequence 0/hash 0.
            recovered = False
            if self._txn_path.exists() and record_meta:
                try:
                    txn = json.loads(self._txn_path.read_text())
                    last = record_meta[-1]
                    recovered = (len(record_meta) == 1 and txn.get("intention") == "advance_head" and
                                 txn.get("sequence") == last[0] and txn.get("hash") == last[1] and
                                 txn.get("previousHash") == "0" * 64)
                except (OSError, ValueError, TypeError, AttributeError):
                    recovered = False
            if recovered:
                self._sequence, self._hash = expected["sequence"], expected["hash"]
                self._write_head()
                try: self._txn_path.unlink()
                except FileNotFoundError: pass  # Best-effort cleanup: txn file may already be gone.
            else:
                raise ValueError("receipt journal head is missing")
        self._hash = chain_hash
        return self.nodes
    def replay(self) -> Mapping[str, TaskNode]:
        with self._lock, self._file_lock():
            return self._replay_unlocked()

    def snapshot(self, *, retain_completed: bool = True) -> dict[str, Any]:
        """Return a coherent point-in-time instance snapshot, possibly cross-process stale.

        Call :meth:`replay` when a fresh disk view is required; UI reads do not force
        disk replay on every call.
        """
        with self._lock:
            nodes = [n.to_dict() for n in self._nodes.values() if retain_completed or n.state not in TERMINAL_STATES]
            return copy.deepcopy({"runId": self.run_id, "sequence": self._sequence, "nodes": nodes})

    def tree(self, *, retain_completed: bool = True) -> list[dict[str, Any]]:
        """Return a coherent point-in-time instance tree, possibly cross-process stale."""
        with self._lock:
            selected = {n.task_id: copy.deepcopy(n) for n in self._nodes.values() if retain_completed or n.state not in TERMINAL_STATES}
        def build(node: TaskNode) -> dict[str, Any]:
            result = node.to_dict(); result["children"] = [build(child) for child in selected.values() if child.parent_id == node.task_id]
            return result
        return [build(n) for n in selected.values() if n.parent_id not in selected]

    def cancel(self, task_id: str, **kwargs: Any) -> TaskNode:
        return self.transition(task_id, TaskState.CANCELLED, **kwargs)

    def retry(self, task_id: str, **kwargs: Any) -> TaskNode:
        return self.transition(task_id, TaskState.QUEUED, attempt=self._nodes[task_id].attempt + 1, **kwargs)

    def reconcile_orphaned(self, *, is_alive: Callable[[int], bool],
                           legacy_stale_sec: float = LEGACY_STALE_SEC) -> list[TaskNode]:
        """Transition every non-terminal node to INTERRUPTED once the process
        that owns this run's journal is confirmed gone.

        A run's whole journal is written by exactly one process for its entire
        lifetime (the caller enforces a single-active-run gate), so ownership
        only needs to be recorded once: as ``pid`` inside the root node's
        (the first node with no ``parent_id``) ``detail``. If that pid is no
        longer alive, nothing can still be advancing this run, so any node
        still QUEUED/BLOCKED/RUNNING is reconciled to the honest terminal
        state INTERRUPTED — never silently upgraded to SUCCEEDED, since no
        verdict was ever actually reached.

        Receipts written before a pid was recorded have no ``pid`` to check.
        Skipping them entirely was measured to be wrong in the way that matters:
        on a real machine ALL SEVEN stale "running" nodes were pid-less legacy
        receipts, so a pid-only rule fixed nothing a user could actually see and
        would only have helped runs created after the upgrade.

        For those, staleness is the evidence instead. A live run writes to its
        journal continuously, so a journal untouched for ``legacy_stale_sec``
        cannot belong to one. That is inference, not proof, so the window is
        deliberately generous (default one hour, far longer than any single
        model call) and it only ever yields INTERRUPTED — the honest "we do not
        know how this ended" state, never SUCCEEDED.
        """
        with self._lock, self._file_lock():
            self._replay_unlocked()
            pid: int | None = None
            for node in self._nodes.values():
                if node.parent_id is None:
                    candidate = node.detail.get("pid") if isinstance(node.detail, Mapping) else None
                    if isinstance(candidate, int) and not isinstance(candidate, bool):
                        pid = candidate
                    break
            if pid is None:
                # Legacy receipt: fall back to staleness (see docstring).
                try:
                    idle = time.time() - self.path.stat().st_mtime
                except OSError:
                    return []
                if idle < legacy_stale_sec:
                    return []
            elif is_alive(pid):
                return []
            changed: list[TaskNode] = []
            for task_id, node in list(self._nodes.items()):
                if node.state in TERMINAL_STATES:
                    continue
                changed.append(self._transition(
                    task_id, TaskState.INTERRUPTED,
                    detail={**dict(node.detail),
                            "reconciledReason": f"owning process pid {pid} exited without a terminal receipt"},
                ))
            return changed


__all__ = ["TaskKind", "TaskState", "TaskNode", "TaskEvent", "TaskReceiptStore", "TERMINAL_STATES", "redact"]
