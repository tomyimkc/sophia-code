# SPDX-License-Identifier: Apache-2.0
"""Governed continual-harness state for long-running Sophia sessions.

The harness keeps four boundaries separate:

* observations are append-only run records;
* lessons are inert proposals until an explicit proposal-ID decision;
* applied state changes use an expected-version transaction under a file lock;
* every decision and commit is written to a tamper-evident receipt chain.

This module never changes model weights and never auto-promotes advice.  Its
mechanism-level guarantees are useful infrastructure for later continual
learning research, but they are not evidence of model self-improvement or AGI.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import unicodedata
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

try:  # pragma: no cover - exercised on Unix CI and production hosts
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None  # type: ignore[assignment]

try:  # pragma: no cover - exercised only on Windows
    import msvcrt
except ImportError:  # pragma: no cover - Unix
    msvcrt = None  # type: ignore[assignment]


MAX_CATEGORY_CHARS = 64
MAX_LESSON_CHARS = 1_000
MAX_EVIDENCE_CHARS = 2_000
MAX_QUERY_CHARS = 500
MAX_QUERY_TERMS = 16
MAX_STATE_BYTES = 1024 * 1024
MAX_RUNS_BYTES = 8 * 1024 * 1024
MAX_PROPOSALS_BYTES = 8 * 1024 * 1024
MAX_RECEIPTS_BYTES = 8 * 1024 * 1024
MAX_HISTORY = 100
MAX_CATEGORY_ITEMS = 50
RELEVANCE_PREVIEW_LIMIT = 3

STATE_SCHEMA = "sophia.continual-harness-state.v2"
DECISION_SCHEMA = "sophia.continual-harness-decision.v1"
GENESIS_HASH = "0" * 64

_HEX_ID = re.compile(r"^[a-f0-9]{16,64}$")
_HEX_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_POISON_PHRASES: tuple[tuple[str, str], ...] = (
    ("test_bypass", "skip tests"),
    ("test_bypass", "disable tests"),
    ("test_bypass", "delete tests"),
    ("test_bypass", "modify tests"),
    ("test_bypass", "edit tests"),
    ("verifier_bypass", "bypass verifier"),
    ("verifier_bypass", "verifier bypass"),
    ("verifier_bypass", "disable verifier"),
    ("verifier_bypass", "modify verifier"),
    ("verifier_bypass", "edit verifier"),
    ("verifier_bypass", "ignore verifier"),
    ("fixture_shortcut", "hard-code task"),
    ("fixture_shortcut", "hardcode task"),
    ("fixture_shortcut", "hard-code fixture"),
    ("fixture_shortcut", "hardcode fixture"),
    ("fixture_shortcut", "task-id branch"),
    ("fixture_shortcut", "task id branch"),
    ("visible_answer", "copy the visible answer"),
    ("visible_answer", "exact visible answer"),
    ("visible_answer", "hard-code answer"),
    ("visible_answer", "hardcode answer"),
    ("visible_answer", "return constant"),
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-") or "run"


def _bounded_text(name: str, value: str, *, max_chars: int) -> str:
    text = str(value).strip()
    if not text:
        raise ValueError(f"{name} must not be empty")
    if len(text) > max_chars:
        raise ValueError(f"{name} exceeds {max_chars} characters")
    return text


def _normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", str(value)).lower()


def _tokens(value: str) -> tuple[str, ...]:
    # ``[^\W_]`` means a Unicode alphanumeric without underscore. Preserve
    # first occurrence order so scoring is deterministic across runtimes.
    return tuple(dict.fromkeys(re.findall(r"[^\W_]+", _normalized(value), re.UNICODE)))


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256_value(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _phrase_is_negated(text: str, start: int) -> bool:
    prefix = text[max(0, start - 20):start].rstrip()
    return prefix.endswith(("do not", "don't", "never", "must not"))


def refinement_risk_signals(*, lesson: str, evidence: str = "") -> list[dict[str, str]]:
    """Return deterministic shortcut/verifier-bypass signals for a proposal.

    This is deliberately a narrow high-precision boundary, not a general prompt
    injection classifier.  It catches the frozen Forbidden Fixture Shortcut
    families while leaving semantic/adversarial review as a later gate.
    """

    text = _normalized(f"{lesson}\n{evidence}")
    signals: list[dict[str, str]] = []
    for kind, phrase in _POISON_PHRASES:
        start = text.find(phrase)
        matched = False
        while start >= 0:
            if not _phrase_is_negated(text, start):
                matched = True
                break
            start = text.find(phrase, start + len(phrase))
        if not matched:
            continue
        signal = {"kind": kind, "matched": phrase}
        if signal not in signals:
            signals.append(signal)
    return signals


class HarnessMutationError(RuntimeError):
    """Base class for fail-closed continual-harness mutation errors."""


class HarnessStateError(HarnessMutationError):
    """The authoritative state is malformed, unsafe, or policy-incompatible."""


class HarnessProposalError(HarnessMutationError):
    """The proposal registry is malformed or the requested proposal is invalid."""


class HarnessDecisionLedgerError(HarnessMutationError):
    """The append-only decision receipt chain is malformed or tampered."""


class StaleHarnessVersion(HarnessMutationError):
    """The caller reviewed an older state version than the authoritative one."""

    def __init__(self, expected: int, actual: int) -> None:
        super().__init__(
            f"stale harness version: expected {expected}, authoritative version is {actual}"
        )
        self.expected = expected
        self.actual = actual


class UnknownProposalError(HarnessProposalError):
    """No exact proposal ID exists in the append-only proposal registry."""


class ProposalAlreadyDecidedError(HarnessProposalError):
    """The proposal already has a terminal apply/quarantine decision."""


class RefinementQuarantinedError(HarnessProposalError):
    """The deterministic shortcut gate quarantined the proposal."""

    def __init__(self, proposal_id: str, signals: list[dict[str, str]]) -> None:
        kinds = ", ".join(sorted({signal["kind"] for signal in signals}))
        super().__init__(f"proposal {proposal_id} quarantined by refinement gate: {kinds}")
        self.proposal_id = proposal_id
        self.signals = signals


class UnknownSnapshotError(HarnessMutationError):
    """The requested rollback target is absent from verified state history."""


class NeedsReconciliationError(HarnessMutationError):
    """A prepared transaction cannot be reconciled against authoritative state."""


@dataclass(frozen=True)
class HarnessSnapshot:
    version: int
    base_policy_sha256: str
    supplemental: dict[str, Any]
    created_at: str
    reason: str
    source_version: int | None = None
    proposal_id: str | None = None
    decision_id: str | None = None


@dataclass(frozen=True)
class RunRecord:
    run_id: str
    goal: str
    ok: bool
    incomplete: bool
    steps: int
    tool_failures: int
    trace_path: str
    created_at: str


class ContinualHarness:
    """Persist bounded, reviewable harness memory under ``.sophia/harness``."""

    def __init__(self, root: Path, *, base_policy: str = "") -> None:
        override = (os.environ.get("SOPHIA_CONTINUAL_HARNESS_DIR") or "").strip()
        self.root = (
            Path(override).expanduser()
            if override
            else Path(root) / ".sophia" / "harness"
        )
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root_info = self.root.lstat()
        if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
            raise HarnessStateError(f"refusing unsafe harness directory: {self.root}")
        os.chmod(self.root, 0o700)

        self.base_policy = base_policy
        self.base_sha = hashlib.sha256(base_policy.encode()).hexdigest()
        self.state_path = self.root / "state.json"
        self.runs_path = self.root / "runs.jsonl"
        self.proposals_path = self.root / "proposals.jsonl"
        self.decisions_path = self.root / "decisions.jsonl"
        self.lock_path = self.root / "mutation.lock"

        with self._mutation_lock():
            if not self.state_path.exists():
                initial = HarnessSnapshot(
                    0,
                    self.base_sha,
                    {},
                    _now(),
                    "initial",
                )
                self._atomic_write_state({
                    "schema": STATE_SCHEMA,
                    "version": 0,
                    "base_policy_sha256": self.base_sha,
                    "supplemental": {},
                    "history": [asdict(initial)],
                })

    @contextmanager
    def _mutation_lock(self) -> Iterator[None]:
        no_follow = getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(
            self.lock_path,
            os.O_RDWR | os.O_CREAT | no_follow,
            0o600,
        )
        try:
            os.chmod(self.lock_path, 0o600)
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_EX)
            elif msvcrt is not None:  # pragma: no cover - Windows
                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"0")
                    os.fsync(fd)
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            yield
        finally:
            try:
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                elif msvcrt is not None:  # pragma: no cover - Windows
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            finally:
                os.close(fd)

    def _read_regular_bytes(
        self,
        path: Path,
        *,
        max_bytes: int,
        missing_ok: bool = False,
    ) -> bytes:
        no_follow = getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, os.O_RDONLY | no_follow)
        except FileNotFoundError:
            if missing_ok:
                return b""
            raise
        except OSError as exc:
            raise HarnessStateError(f"cannot safely open harness file: {path}") from exc
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                raise HarnessStateError(f"refusing unsafe harness file: {path}")
            if before.st_size > max_bytes:
                raise HarnessStateError(
                    f"harness file exceeds {max_bytes} bytes: {path}"
                )
            chunks: list[bytes] = []
            remaining = max_bytes + 1
            while remaining > 0:
                chunk = os.read(fd, min(64 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            after = os.fstat(fd)
            if len(data) > max_bytes:
                raise HarnessStateError(
                    f"harness file exceeds {max_bytes} bytes: {path}"
                )
            stable_identity = (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            ) == (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
            if not stable_identity or len(data) != after.st_size:
                raise HarnessStateError(
                    f"harness file changed while it was being read: {path}"
                )
            return data
        finally:
            os.close(fd)

    def _atomic_write_state(self, state: dict[str, Any]) -> None:
        tmp = self.state_path.with_name(
            f".{self.state_path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            data = (
                json.dumps(state, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
            ).encode("utf-8")
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("state write made no progress")
                view = view[written:]
            os.fsync(fd)
            os.close(fd)
            fd = -1
            os.replace(tmp, self.state_path)
            os.chmod(self.state_path, 0o600)
            directory_fd = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except Exception:
            if fd >= 0:
                os.close(fd)
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            raise

    def _append_jsonl(
        self,
        path: Path,
        row: dict[str, Any],
        *,
        max_bytes: int,
    ) -> None:
        no_follow = getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | no_follow,
            0o600,
        )
        try:
            data = _canonical_bytes(row) + b"\n"
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise HarnessStateError(f"refusing unsafe harness file: {path}")
            if info.st_size + len(data) > max_bytes:
                raise HarnessStateError(
                    f"harness file would exceed {max_bytes} bytes: {path}"
                )
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("JSONL append made no progress")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(path, 0o600)
        directory_fd = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    @staticmethod
    def _validate_version(name: str, value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise HarnessStateError(f"{name} must be a non-negative integer")
        return value

    def _validate_supplemental(
        self,
        value: Any,
        *,
        reject_poison: bool,
    ) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise HarnessStateError("state supplemental must be an object")
        clean: dict[str, Any] = {}
        for category, rows in value.items():
            if not isinstance(category, str) or not category or len(category) > MAX_CATEGORY_CHARS:
                raise HarnessStateError("state supplemental category is invalid")
            if not isinstance(rows, list) or len(rows) > MAX_CATEGORY_ITEMS:
                raise HarnessStateError(
                    f"state supplemental bucket {category!r} is invalid or oversized"
                )
            checked: list[dict[str, Any]] = []
            for row in rows:
                if not isinstance(row, dict):
                    raise HarnessStateError("state supplemental rows must be objects")
                text = str(row.get("text", "")).strip()
                evidence = str(row.get("evidence", "")).strip()
                status_text = str(row.get("status", "applied")).casefold()
                if not text or len(text) > MAX_LESSON_CHARS:
                    raise HarnessStateError("state lesson is empty or oversized")
                if len(evidence) > MAX_EVIDENCE_CHARS:
                    raise HarnessStateError("state lesson evidence is oversized")
                if status_text not in {"applied", "pending", "quarantined"}:
                    raise HarnessStateError(f"unknown supplemental status: {status_text}")
                signals = refinement_risk_signals(lesson=text, evidence=evidence)
                if reject_poison and status_text == "applied" and signals:
                    raise HarnessStateError(
                        "authoritative state contains an applied refinement that "
                        "matches the Forbidden Fixture Shortcut gate"
                    )
                checked.append(dict(row))
            clean[category] = checked
        return clean

    def _read_state_strict(self) -> dict[str, Any]:
        try:
            raw = self._read_regular_bytes(
                self.state_path,
                max_bytes=MAX_STATE_BYTES,
            )
        except (OSError, HarnessStateError) as exc:
            if isinstance(exc, HarnessStateError):
                raise
            raise HarnessStateError(f"cannot read authoritative harness state: {exc}") from exc
        try:
            state = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HarnessStateError("authoritative harness state is not valid JSON") from exc
        if not isinstance(state, dict):
            raise HarnessStateError("authoritative harness state must be an object")

        schema = state.get("schema")
        if schema not in {None, STATE_SCHEMA}:
            raise HarnessStateError(f"unknown harness state schema: {schema}")
        version = self._validate_version("state version", state.get("version"))
        supplemental = self._validate_supplemental(
            state.get("supplemental"),
            reject_poison=True,
        )
        history = state.get("history")
        if not isinstance(history, list) or not history or len(history) > MAX_HISTORY:
            raise HarnessStateError("state history must be a bounded non-empty list")

        top_base = state.get("base_policy_sha256")
        if top_base is not None and top_base != self.base_sha:
            raise HarnessStateError("base policy hash does not match authoritative state")

        seen_versions: set[int] = set()
        active_matches = 0
        checked_history: list[dict[str, Any]] = []
        for entry in history:
            if not isinstance(entry, dict):
                raise HarnessStateError("state history entries must be objects")
            entry_version = self._validate_version(
                "history version",
                entry.get("version"),
            )
            if entry_version in seen_versions:
                raise HarnessStateError(f"duplicate history version: {entry_version}")
            seen_versions.add(entry_version)
            entry_base = entry.get("base_policy_sha256")
            if entry_base != self.base_sha or not _HEX_SHA256.fullmatch(str(entry_base)):
                raise HarnessStateError("history base policy hash mismatch")
            entry_supplemental = self._validate_supplemental(
                entry.get("supplemental"),
                reject_poison=True,
            )
            if (
                entry_version == version
                and _canonical_bytes(entry_supplemental) == _canonical_bytes(supplemental)
            ):
                active_matches += 1
            checked_history.append(dict(entry))
        if active_matches != 1:
            raise HarnessStateError(
                "current state must match exactly one verified history snapshot"
            )
        return {
            **state,
            "schema": STATE_SCHEMA,
            "version": version,
            "base_policy_sha256": self.base_sha,
            "supplemental": supplemental,
            "history": checked_history,
        }

    def state(self) -> dict[str, Any]:
        """Return verified state or a safe empty read-side projection.

        Reads remain fail-safe for status/preview surfaces: malformed or
        policy-incompatible state contributes no lesson.  Mutations use
        :meth:`_read_state_strict` directly and raise instead of resetting.
        """

        try:
            return self._read_state_strict()
        except HarnessMutationError:
            return {
                "schema": STATE_SCHEMA,
                "version": 0,
                "base_policy_sha256": self.base_sha,
                "supplemental": {},
                "history": [],
                "read_error": "authoritative state unavailable",
            }

    def _read_proposals_strict(self) -> list[dict[str, Any]]:
        try:
            raw = self._read_regular_bytes(
                self.proposals_path,
                max_bytes=MAX_PROPOSALS_BYTES,
                missing_ok=True,
            )
        except HarnessStateError as exc:
            raise HarnessProposalError(str(exc)) from exc
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HarnessProposalError(
                "proposal registry is not valid UTF-8"
            ) from exc
        rows: list[dict[str, Any]] = []
        ids: set[str] = set()
        for index, line in enumerate(text.splitlines()):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise HarnessProposalError(
                    f"proposal registry has invalid JSON at row {index}"
                ) from exc
            if not isinstance(row, dict):
                raise HarnessProposalError(f"proposal row {index} must be an object")
            proposal_id = str(row.get("id", ""))
            if not _HEX_ID.fullmatch(proposal_id) or proposal_id in ids:
                raise HarnessProposalError(
                    f"proposal row {index} has an invalid or duplicate ID"
                )
            ids.add(proposal_id)
            try:
                _bounded_text(
                    "category",
                    str(row.get("category", "")),
                    max_chars=MAX_CATEGORY_CHARS,
                )
                _bounded_text(
                    "lesson",
                    str(row.get("lesson", "")),
                    max_chars=MAX_LESSON_CHARS,
                )
                _bounded_text(
                    "evidence",
                    str(row.get("evidence", "")),
                    max_chars=MAX_EVIDENCE_CHARS,
                )
            except ValueError as exc:
                raise HarnessProposalError(
                    f"proposal row {index} is invalid: {exc}"
                ) from exc
            if (
                row.get("status") != "pending"
                or row.get("candidateOnly") is not True
                or row.get("applied") is not False
                or row.get("weightUpdate") is not False
                or row.get("promotionEligible") is not False
                or row.get("canClaimAGI") is not False
            ):
                raise HarnessProposalError(
                    f"proposal row {index} violates the candidate-only boundary"
                )
            rows.append(dict(row))
        return rows

    @staticmethod
    def _receipt_hash(row: dict[str, Any]) -> str:
        return _sha256_value({
            key: value for key, value in row.items() if key != "receipt_sha256"
        })

    def _read_receipts_strict(self) -> list[dict[str, Any]]:
        try:
            raw = self._read_regular_bytes(
                self.decisions_path,
                max_bytes=MAX_RECEIPTS_BYTES,
                missing_ok=True,
            )
        except HarnessStateError as exc:
            raise HarnessDecisionLedgerError(str(exc)) from exc
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HarnessDecisionLedgerError(
                "decision receipt ledger is not valid UTF-8"
            ) from exc
        rows: list[dict[str, Any]] = []
        previous = GENESIS_HASH
        for sequence, line in enumerate(text.splitlines()):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise HarnessDecisionLedgerError(
                    f"decision receipt ledger has invalid JSON at row {sequence}"
                ) from exc
            if (
                not isinstance(row, dict)
                or row.get("schema") != DECISION_SCHEMA
                or row.get("sequence") != sequence
                or row.get("previous_sha256") != previous
                or row.get("receipt_sha256") != self._receipt_hash(row)
            ):
                raise HarnessDecisionLedgerError(
                    f"decision receipt chain is invalid at sequence {sequence}"
                )
            previous = str(row["receipt_sha256"])
            rows.append(dict(row))
        return rows

    def _append_receipt_locked(self, **payload: Any) -> dict[str, Any]:
        rows = self._read_receipts_strict()
        sequence = len(rows)
        row = {
            "schema": DECISION_SCHEMA,
            "sequence": sequence,
            "previous_sha256": (
                str(rows[-1]["receipt_sha256"]) if rows else GENESIS_HASH
            ),
            "created_at": _now(),
            "candidateOnly": True,
            "weightUpdate": False,
            "promotionEligible": False,
            "canClaimAGI": False,
            **payload,
        }
        row["receipt_sha256"] = self._receipt_hash(row)
        self._append_jsonl(
            self.decisions_path,
            row,
            max_bytes=MAX_RECEIPTS_BYTES,
        )
        return row

    def decision_receipts(self) -> list[dict[str, Any]]:
        """Return the verified append-only decision receipt chain."""

        with self._mutation_lock():
            return self._read_receipts_strict()

    def verify_decision_chain(self) -> dict[str, Any]:
        with self._mutation_lock():
            try:
                rows = self._read_receipts_strict()
            except HarnessDecisionLedgerError as exc:
                return {"ok": False, "length": 0, "reason": str(exc)}
        return {
            "ok": True,
            "length": len(rows),
            "tail": rows[-1]["receipt_sha256"] if rows else GENESIS_HASH,
            "reason": "chain intact",
        }

    def _reconcile_prepared_locked(
        self,
        state: dict[str, Any],
        receipts: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        terminal_transactions = {
            str(row.get("transaction_id"))
            for row in receipts
            if row.get("phase") in {"commit", "aborted"}
        }
        pending = [
            row for row in receipts
            if (
                row.get("phase") == "decision"
                and row.get("outcome") == "approved"
                and str(row.get("transaction_id")) not in terminal_transactions
            )
        ]
        if not pending:
            return receipts
        if len(pending) != 1 or pending[0] != receipts[-1]:
            raise NeedsReconciliationError(
                "decision ledger contains non-terminal transactions that are not "
                "a single recoverable tail decision"
            )
        prepared = pending[0]
        current_hash = _sha256_value(state)
        before_hash = prepared.get("before_state_sha256")
        after_hash = prepared.get("after_state_sha256")
        if current_hash == after_hash:
            outcome = "applied" if prepared.get("operation") == "apply" else "rolled_back"
            phase = "commit"
            reason = "recovered_after_state_commit"
            after_version = prepared.get("after_version")
        elif current_hash == before_hash:
            outcome = "aborted"
            phase = "aborted"
            reason = "recovered_before_state_commit"
            after_version = prepared.get("before_version")
        else:
            raise NeedsReconciliationError(
                "prepared transaction matches neither the before nor after state"
            )
        self._append_receipt_locked(
            transaction_id=prepared.get("transaction_id"),
            decision_id=prepared.get("decision_id"),
            operation=prepared.get("operation"),
            phase=phase,
            outcome=outcome,
            final=True,
            reason=reason,
            proposal_id=prepared.get("proposal_id"),
            target_version=prepared.get("target_version"),
            expected_version=prepared.get("expected_version"),
            before_version=prepared.get("before_version"),
            after_version=after_version,
            before_state_sha256=before_hash,
            after_state_sha256=after_hash,
            base_policy_sha256=self.base_sha,
            gate=prepared.get("gate"),
            recovered=True,
        )
        return self._read_receipts_strict()

    def _record_non_mutating_decision_locked(
        self,
        *,
        operation: str,
        outcome: str,
        reason: str,
        proposal_id: str | None,
        target_version: int | None,
        expected_version: int | None,
        state: dict[str, Any] | None,
        gate: dict[str, Any],
        final: bool = False,
    ) -> dict[str, Any]:
        state_hash = _sha256_value(state) if state is not None else None
        state_version = state.get("version") if state is not None else None
        transaction_id = uuid.uuid4().hex
        return self._append_receipt_locked(
            transaction_id=transaction_id,
            decision_id=transaction_id,
            operation=operation,
            phase="decision",
            outcome=outcome,
            final=final,
            reason=reason,
            proposal_id=proposal_id,
            target_version=target_version,
            expected_version=expected_version,
            before_version=state_version,
            after_version=state_version,
            before_state_sha256=state_hash,
            after_state_sha256=state_hash,
            base_policy_sha256=self.base_sha,
            gate=gate,
            recovered=False,
        )

    @staticmethod
    def _next_version(state: dict[str, Any]) -> int:
        versions = [int(state["version"])]
        versions.extend(
            int(entry["version"])
            for entry in state.get("history", [])
            if isinstance(entry, dict) and isinstance(entry.get("version"), int)
        )
        return max(versions) + 1

    @staticmethod
    def _terminal_proposal_receipt(
        receipts: Iterable[dict[str, Any]],
        proposal_id: str,
    ) -> dict[str, Any] | None:
        terminal = {
            "applied",
            "quarantined",
        }
        for row in reversed(list(receipts)):
            if (
                row.get("proposal_id") == proposal_id
                and row.get("final") is True
                and row.get("outcome") in terminal
            ):
                return row
        return None

    def record_run(
        self,
        *,
        goal: str,
        ok: bool,
        incomplete: bool,
        steps: Iterable[dict[str, Any]],
        trace_path: str = "",
    ) -> RunRecord:
        rows = list(steps)
        failures = sum(1 for row in rows if row.get("ok") is False)
        created_at = _now()
        digest = hashlib.sha256(
            f"{goal}|{trace_path}|{created_at}|{uuid.uuid4().hex}".encode()
        ).hexdigest()[:16]
        record = RunRecord(
            digest,
            goal,
            bool(ok),
            bool(incomplete),
            len(rows),
            failures,
            trace_path,
            created_at,
        )
        with self._mutation_lock():
            self._append_jsonl(
                self.runs_path,
                asdict(record),
                max_bytes=MAX_RUNS_BYTES,
            )
        return record

    def propose_refinement(
        self,
        *,
        lesson: str,
        evidence: str,
        category: str = "lesson",
    ) -> dict[str, Any]:
        """Append a unique inert proposal; applying it is a separate transaction."""

        category_text = _bounded_text(
            "category",
            category,
            max_chars=MAX_CATEGORY_CHARS,
        )
        lesson_text = _bounded_text(
            "lesson",
            lesson,
            max_chars=MAX_LESSON_CHARS,
        )
        evidence_text = _bounded_text(
            "evidence",
            evidence,
            max_chars=MAX_EVIDENCE_CHARS,
        )
        category_slug = _slug(category_text)
        created_at = _now()
        with self._mutation_lock():
            existing = self._read_proposals_strict()
            existing_ids = {str(row["id"]) for row in existing}
            proposal_id = ""
            while not proposal_id or proposal_id in existing_ids:
                proposal_id = hashlib.sha256(
                    (
                        f"{category_slug}|{lesson_text}|{evidence_text}|"
                        f"{created_at}|{uuid.uuid4().hex}"
                    ).encode()
                ).hexdigest()[:24]
            proposal = {
                "id": proposal_id,
                "category": category_slug,
                "lesson": lesson_text,
                "evidence": evidence_text,
                "status": "pending",
                "created_at": created_at,
                "candidateOnly": True,
                "applied": False,
                "weightUpdate": False,
                "promotionEligible": False,
                "canClaimAGI": False,
            }
            self._append_jsonl(
                self.proposals_path,
                proposal,
                max_bytes=MAX_PROPOSALS_BYTES,
            )
        return proposal

    def apply_refinement(
        self,
        *,
        proposal_id: str,
        expected_version: int,
    ) -> HarnessSnapshot:
        """Apply one exact pending proposal under an expected-version transaction."""

        proposal_id = str(proposal_id).strip()
        if not _HEX_ID.fullmatch(proposal_id):
            raise UnknownProposalError(f"invalid proposal ID: {proposal_id!r}")
        expected = self._validate_version("expected_version", expected_version)

        with self._mutation_lock():
            receipts = self._read_receipts_strict()
            proposals = self._read_proposals_strict()
            proposal = next(
                (row for row in proposals if row["id"] == proposal_id),
                None,
            )
            try:
                state = self._read_state_strict()
            except HarnessStateError:
                self._record_non_mutating_decision_locked(
                    operation="apply",
                    outcome="rejected",
                    reason="authoritative_state_invalid",
                    proposal_id=proposal_id,
                    target_version=None,
                    expected_version=expected,
                    state=None,
                    gate={"accepted": False, "signals": ["state_invalid"]},
                )
                raise
            receipts = self._reconcile_prepared_locked(state, receipts)

            if proposal is None:
                self._record_non_mutating_decision_locked(
                    operation="apply",
                    outcome="rejected",
                    reason="unknown_proposal",
                    proposal_id=proposal_id,
                    target_version=None,
                    expected_version=expected,
                    state=state,
                    gate={"accepted": False, "signals": ["unknown_proposal"]},
                )
                raise UnknownProposalError(f"unknown refinement proposal: {proposal_id}")

            terminal = self._terminal_proposal_receipt(receipts, proposal_id)
            if terminal is not None:
                self._record_non_mutating_decision_locked(
                    operation="apply",
                    outcome="rejected",
                    reason="proposal_already_decided",
                    proposal_id=proposal_id,
                    target_version=None,
                    expected_version=expected,
                    state=state,
                    gate={
                        "accepted": False,
                        "signals": ["already_decided"],
                        "proposal_sha256": _sha256_value(proposal),
                        "terminalReceipt": terminal["receipt_sha256"],
                    },
                )
                raise ProposalAlreadyDecidedError(
                    f"refinement proposal already decided: {proposal_id}"
                )

            actual = int(state["version"])
            if expected != actual:
                self._record_non_mutating_decision_locked(
                    operation="apply",
                    outcome="held",
                    reason="stale_expected_version",
                    proposal_id=proposal_id,
                    target_version=None,
                    expected_version=expected,
                    state=state,
                    gate={
                        "accepted": False,
                        "signals": ["stale_version"],
                        "proposal_sha256": _sha256_value(proposal),
                    },
                )
                raise StaleHarnessVersion(expected, actual)

            signals = refinement_risk_signals(
                lesson=str(proposal["lesson"]),
                evidence=str(proposal["evidence"]),
            )
            if signals:
                self._record_non_mutating_decision_locked(
                    operation="apply",
                    outcome="quarantined",
                    reason="forbidden_fixture_shortcut",
                    proposal_id=proposal_id,
                    target_version=None,
                    expected_version=expected,
                    state=state,
                    gate={
                        "accepted": False,
                        "signals": signals,
                        "proposal_sha256": _sha256_value(proposal),
                    },
                    final=True,
                )
                raise RefinementQuarantinedError(proposal_id, signals)

            supplemental = {
                category: [dict(row) for row in rows]
                for category, rows in state["supplemental"].items()
            }
            category_slug = str(proposal["category"])
            bucket = list(supplemental.get(category_slug, []))
            item = {
                "proposal_id": proposal_id,
                "text": str(proposal["lesson"]),
                "evidence": str(proposal["evidence"]),
                "status": "applied",
                "created_at": _now(),
            }
            if any(
                row.get("proposal_id") == proposal_id
                for row in bucket
                if isinstance(row, dict)
            ):
                raise HarnessStateError(
                    f"proposal {proposal_id} is already present in applied state"
                )
            bucket.append(item)
            supplemental[category_slug] = bucket[-MAX_CATEGORY_ITEMS:]
            version = self._next_version(state)
            transaction_id = uuid.uuid4().hex
            snapshot = HarnessSnapshot(
                version,
                self.base_sha,
                supplemental,
                _now(),
                "explicit-proposal-refinement",
                source_version=actual,
                proposal_id=proposal_id,
                decision_id=transaction_id,
            )
            next_state = {
                "schema": STATE_SCHEMA,
                "version": version,
                "base_policy_sha256": self.base_sha,
                "supplemental": supplemental,
                "history": [
                    *state["history"],
                    asdict(snapshot),
                ][-MAX_HISTORY:],
            }
            before_hash = _sha256_value(state)
            after_hash = _sha256_value(next_state)
            self._append_receipt_locked(
                transaction_id=transaction_id,
                decision_id=transaction_id,
                operation="apply",
                phase="decision",
                outcome="approved",
                final=False,
                reason="proposal_gate_accepted",
                proposal_id=proposal_id,
                target_version=None,
                expected_version=expected,
                before_version=actual,
                after_version=version,
                before_state_sha256=before_hash,
                after_state_sha256=after_hash,
                base_policy_sha256=self.base_sha,
                gate={
                    "accepted": True,
                    "signals": [],
                    "proposal_sha256": _sha256_value(proposal),
                },
                recovered=False,
            )
            self._atomic_write_state(next_state)
            self._append_receipt_locked(
                transaction_id=transaction_id,
                decision_id=transaction_id,
                operation="apply",
                phase="commit",
                outcome="applied",
                final=True,
                reason="state_commit_verified",
                proposal_id=proposal_id,
                target_version=None,
                expected_version=expected,
                before_version=actual,
                after_version=version,
                before_state_sha256=before_hash,
                after_state_sha256=after_hash,
                base_policy_sha256=self.base_sha,
                gate={
                    "accepted": True,
                    "signals": [],
                    "proposal_sha256": _sha256_value(proposal),
                },
                recovered=False,
            )
            return snapshot

    def _applied_items(self) -> list[dict[str, Any]]:
        state = self.state()
        rows: list[dict[str, Any]] = []
        order = 0
        for category, items in (state.get("supplemental") or {}).items():
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                if str(item.get("status", "applied")).casefold() != "applied":
                    continue
                text = str(item.get("text", "")).strip()
                evidence = str(item.get("evidence", "")).strip()
                if not text or refinement_risk_signals(lesson=text, evidence=evidence):
                    continue
                rows.append({
                    "proposal_id": str(item.get("proposal_id", "")),
                    "category": str(category),
                    "text": text,
                    "evidence": evidence,
                    "created_at": str(item.get("created_at", "")),
                    "status": "applied",
                    "_order": order,
                })
                order += 1
        return rows

    def preview(
        self,
        query: str,
        *,
        limit: int = RELEVANCE_PREVIEW_LIMIT,
    ) -> list[dict[str, Any]]:
        """Rank only explicitly applied, non-quarantinable lessons for ``query``."""

        query_text = _bounded_text("query", query, max_chars=MAX_QUERY_CHARS)
        query_tokens = _tokens(query_text)[:MAX_QUERY_TERMS]
        if not query_tokens:
            raise ValueError("query must contain at least one letter or number")
        query_normalized = _normalized(query_text)
        bounded_limit = min(RELEVANCE_PREVIEW_LIMIT, max(1, int(limit)))
        ranked: list[dict[str, Any]] = []
        for item in self._applied_items():
            lesson_normalized = _normalized(item["text"])
            lesson_tokens = set(_tokens(item["text"]))
            category_tokens = set(_tokens(item["category"]))
            evidence_tokens = set(_tokens(item["evidence"]))
            score = (
                sum(4 for token in query_tokens if token in lesson_tokens)
                + sum(2 for token in query_tokens if token in category_tokens)
                + sum(1 for token in query_tokens if token in evidence_tokens)
                + (8 if query_normalized in lesson_normalized else 0)
            )
            if score <= 0:
                continue
            ranked.append({**item, "score": score})
        ranked.sort(key=lambda item: (
            -int(item["score"]),
            _normalized(item["category"]),
            _normalized(item["text"]),
            _normalized(item["evidence"]),
            int(item["_order"]),
        ))
        return [
            {key: value for key, value in item.items() if key != "_order"}
            for item in ranked[:bounded_limit]
        ]

    def context(
        self,
        query: str | None = None,
        *,
        limit: int = RELEVANCE_PREVIEW_LIMIT,
    ) -> str:
        """Render verified harness context; no-argument calls retain compatibility."""

        if query is not None:
            rows = self.preview(query, limit=limit)
        else:
            rows = []
            by_category: dict[str, list[dict[str, Any]]] = {}
            for item in self._applied_items():
                by_category.setdefault(item["category"], []).append(item)
            for items in by_category.values():
                rows.extend(items[-10:])
        return "\n".join(
            f"- [{item['category']}] {item['text']} (evidence: {item['evidence']})"
            for item in rows
        )

    def rollback(
        self,
        target_version: int,
        *,
        expected_version: int,
    ) -> HarnessSnapshot:
        """Create a new version restoring one verified historical snapshot."""

        target = self._validate_version("target_version", target_version)
        expected = self._validate_version("expected_version", expected_version)
        with self._mutation_lock():
            receipts = self._read_receipts_strict()
            try:
                state = self._read_state_strict()
            except HarnessStateError:
                self._record_non_mutating_decision_locked(
                    operation="rollback",
                    outcome="rejected",
                    reason="authoritative_state_invalid",
                    proposal_id=None,
                    target_version=target,
                    expected_version=expected,
                    state=None,
                    gate={"accepted": False, "signals": ["state_invalid"]},
                )
                raise
            self._reconcile_prepared_locked(state, receipts)
            actual = int(state["version"])
            if expected != actual:
                self._record_non_mutating_decision_locked(
                    operation="rollback",
                    outcome="held",
                    reason="stale_expected_version",
                    proposal_id=None,
                    target_version=target,
                    expected_version=expected,
                    state=state,
                    gate={"accepted": False, "signals": ["stale_version"]},
                )
                raise StaleHarnessVersion(expected, actual)

            match = next(
                (
                    entry for entry in reversed(state["history"])
                    if entry.get("version") == target
                ),
                None,
            )
            if match is None:
                self._record_non_mutating_decision_locked(
                    operation="rollback",
                    outcome="rejected",
                    reason="unknown_snapshot",
                    proposal_id=None,
                    target_version=target,
                    expected_version=expected,
                    state=state,
                    gate={"accepted": False, "signals": ["unknown_snapshot"]},
                )
                raise UnknownSnapshotError(f"unknown harness snapshot: {target}")

            supplemental = self._validate_supplemental(
                match.get("supplemental"),
                reject_poison=True,
            )
            version = self._next_version(state)
            transaction_id = uuid.uuid4().hex
            snapshot = HarnessSnapshot(
                version,
                self.base_sha,
                supplemental,
                _now(),
                "rollback",
                source_version=target,
                proposal_id=None,
                decision_id=transaction_id,
            )
            next_state = {
                "schema": STATE_SCHEMA,
                "version": version,
                "base_policy_sha256": self.base_sha,
                "supplemental": supplemental,
                "history": [
                    *state["history"],
                    asdict(snapshot),
                ][-MAX_HISTORY:],
            }
            before_hash = _sha256_value(state)
            after_hash = _sha256_value(next_state)
            self._append_receipt_locked(
                transaction_id=transaction_id,
                decision_id=transaction_id,
                operation="rollback",
                phase="decision",
                outcome="approved",
                final=False,
                reason="rollback_target_verified",
                proposal_id=None,
                target_version=target,
                expected_version=expected,
                before_version=actual,
                after_version=version,
                before_state_sha256=before_hash,
                after_state_sha256=after_hash,
                base_policy_sha256=self.base_sha,
                gate={"accepted": True, "signals": []},
                recovered=False,
            )
            self._atomic_write_state(next_state)
            self._append_receipt_locked(
                transaction_id=transaction_id,
                decision_id=transaction_id,
                operation="rollback",
                phase="commit",
                outcome="rolled_back",
                final=True,
                reason="state_commit_verified",
                proposal_id=None,
                target_version=target,
                expected_version=expected,
                before_version=actual,
                after_version=version,
                before_state_sha256=before_hash,
                after_state_sha256=after_hash,
                base_policy_sha256=self.base_sha,
                gate={"accepted": True, "signals": []},
                recovered=False,
            )
            return snapshot


__all__ = [
    "ContinualHarness",
    "HarnessDecisionLedgerError",
    "HarnessMutationError",
    "HarnessProposalError",
    "HarnessSnapshot",
    "HarnessStateError",
    "NeedsReconciliationError",
    "ProposalAlreadyDecidedError",
    "RefinementQuarantinedError",
    "RunRecord",
    "StaleHarnessVersion",
    "UnknownProposalError",
    "UnknownSnapshotError",
    "refinement_risk_signals",
]
