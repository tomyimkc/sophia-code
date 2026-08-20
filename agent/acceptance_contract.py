# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Acceptance contract v2 and criterion-level completion ledger.

This module is deliberately small and deterministic.  Models may propose
criteria, evidence, and repairs, but the contract and ledger are owned by
Python.  A criterion is complete only when its recorded status and evidence
meet the authoritative policy; fluent model prose is not a completion signal.

candidateOnly: true
canClaimAGI: false
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping


SCHEMA = "sophia.acceptance_contract.v2"


class CriterionStatus(str, Enum):
    UNASSIGNED = "unassigned"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    EVIDENCED = "evidenced"
    VERIFIED = "verified"
    FAILED = "failed"
    CONTRADICTED = "contradicted"
    BLOCKED = "blocked"
    UNKNOWN = "unknown"
    STALE = "stale"
    WAIVED = "waived"


_TERMINAL_POSITIVE = {CriterionStatus.VERIFIED, CriterionStatus.WAIVED}
_MANDATORY_SOURCES = {"explicit", "machine"}
_AMENDMENT_AUTHORITIES = {"operator", "deterministic", "planner"}


def _text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _safe_json(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _safe_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_safe_json(item) for item in value]
    try:
        import json

        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def _status(value: Any) -> CriterionStatus:
    if isinstance(value, CriterionStatus):
        return value
    normalized = _text(value).lower().replace("-", "_")
    try:
        return CriterionStatus(normalized)
    except ValueError:
        return CriterionStatus.UNKNOWN


def _criterion_id(value: Any, index: int) -> str:
    text = _text(value, 80)
    return text or f"C{index + 1:02d}"


@dataclass(frozen=True)
class AcceptanceCriterion:
    """One immutable requirement in the completion contract."""

    criterion_id: str
    requirement: str
    mandatory: bool
    verifier_type: str
    predicate: Mapping[str, Any]
    required_evidence: tuple[str, ...]
    source: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "criterion_id", _criterion_id(self.criterion_id, 0))
        object.__setattr__(self, "requirement", _text(self.requirement, 4000))
        object.__setattr__(self, "mandatory", bool(self.mandatory))
        object.__setattr__(self, "verifier_type", _text(self.verifier_type, 80) or "semantic")
        object.__setattr__(self, "predicate", dict(_safe_json(self.predicate or {})))
        object.__setattr__(
            self,
            "required_evidence",
            tuple(_text(item, 1000) for item in (self.required_evidence or ()) if _text(item, 1000)),
        )
        source = _text(self.source, 80) or "planner_proposed"
        object.__setattr__(self, "source", source)

    def __str__(self) -> str:
        return self.requirement

    def __contains__(self, value: object) -> bool:
        return str(value) in self.requirement

    def to_dict(self) -> dict[str, Any]:
        return {
            "criterionId": self.criterion_id,
            "requirement": self.requirement,
            "mandatory": self.mandatory,
            "verifierType": self.verifier_type,
            "predicate": _safe_json(self.predicate),
            "requiredEvidence": list(self.required_evidence),
            "source": self.source,
        }

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any], index: int = 0) -> "AcceptanceCriterion":
        return cls(
            criterion_id=_criterion_id(
                value.get("criterionId", value.get("criterion_id")), index
            ),
            requirement=_text(value.get("requirement") or value.get("text") or value.get("description")),
            mandatory=bool(value.get("mandatory", value.get("required", False))),
            verifier_type=_text(value.get("verifierType", value.get("verifier_type")) or "semantic"),
            predicate=value.get("predicate") if isinstance(value.get("predicate"), Mapping) else {},
            required_evidence=tuple(
                _text(item)
                for item in (
                    value.get("requiredEvidence", value.get("required_evidence")) or ()
                )
                if _text(item)
            ),
            source=_text(value.get("source") or "planner_proposed"),
        )


@dataclass(frozen=True)
class ContractAmendment:
    action: str
    criterion_ids: tuple[str, ...]
    reason: str
    authority: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "criterionIds": list(self.criterion_ids),
            "reason": self.reason,
            "authority": self.authority,
        }


@dataclass
class AcceptanceContract:
    criteria: tuple[AcceptanceCriterion, ...] = ()
    output_predicates: Mapping[str, Any] = field(default_factory=dict)
    amendments: list[ContractAmendment] = field(default_factory=list)

    def __post_init__(self) -> None:
        rows: list[AcceptanceCriterion] = []
        seen: set[str] = set()
        for index, raw in enumerate(self.criteria):
            criterion = (
                raw
                if isinstance(raw, AcceptanceCriterion)
                else AcceptanceCriterion.from_mapping(raw, index)
                if isinstance(raw, Mapping)
                else AcceptanceCriterion(
                    criterion_id=f"C{index + 1:02d}",
                    requirement=_text(raw),
                    mandatory=True,
                    verifier_type="semantic",
                    predicate={},
                    required_evidence=(),
                    source="explicit",
                )
            )
            if not criterion.requirement or criterion.criterion_id in seen:
                continue
            seen.add(criterion.criterion_id)
            rows.append(criterion)
        self.criteria = tuple(rows)
        self.output_predicates = dict(_safe_json(self.output_predicates or {}))
        self.amendments = [
            item if isinstance(item, ContractAmendment) else ContractAmendment(
                action=_text(item.get("action") if isinstance(item, Mapping) else "amend"),
                criterion_ids=tuple(
                    _text(value)
                    for value in (
                        item.get("criterionIds", item.get("criterion_ids", ()))
                        if isinstance(item, Mapping)
                        else ()
                    )
                    if _text(value)
                ),
                reason=_text(item.get("reason") if isinstance(item, Mapping) else ""),
                authority=_text(item.get("authority") if isinstance(item, Mapping) else ""),
            )
            for item in (self.amendments or ())
        ]

    @property
    def by_id(self) -> dict[str, AcceptanceCriterion]:
        return {criterion.criterion_id: criterion for criterion in self.criteria}

    def criterion(self, criterion_id: str) -> AcceptanceCriterion:
        try:
            return self.by_id[_text(criterion_id, 80)]
        except KeyError as exc:
            raise KeyError(f"unknown acceptance criterion: {criterion_id}") from exc

    def output_predicates_pass(self) -> bool:
        """Evaluate deterministic output predicates already attached to the contract."""
        for value in self.output_predicates.values():
            if isinstance(value, Mapping):
                if value.get("passed") is False or value.get("ok") is False:
                    return False
                if "passed" in value and value.get("passed") is not True:
                    return False
                if "ok" in value and value.get("ok") is not True:
                    return False
            elif value is not True:
                return False
        return True

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "candidateOnly": True,
            "canClaimAGI": False,
            "criteria": [criterion.to_dict() for criterion in self.criteria],
            "outputPredicates": _safe_json(self.output_predicates),
            "amendments": [amendment.to_dict() for amendment in self.amendments],
        }

    def record_amendment(
        self,
        *,
        action: str,
        criterion_ids: Iterable[str],
        reason: str,
        authority: str,
    ) -> None:
        self.amendments.append(
            ContractAmendment(
                action=_text(action, 80),
                criterion_ids=tuple(
                    _text(item, 80)
                    for item in criterion_ids
                    if _text(item, 80)
                ),
                reason=_text(reason, 2000),
                authority=_text(authority, 80),
            )
        )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "AcceptanceContract":
        raw_criteria = value.get("criteria")
        if not isinstance(raw_criteria, (list, tuple)):
            raw_criteria = value.get("acceptanceCriteria") or ()
        criteria: list[AcceptanceCriterion] = []
        for index, raw in enumerate(raw_criteria):
            if isinstance(raw, Mapping):
                criteria.append(AcceptanceCriterion.from_mapping(raw, index))
            else:
                criteria.append(
                    AcceptanceCriterion(
                        criterion_id=f"C{index + 1:02d}",
                        requirement=_text(raw),
                        mandatory=True,
                        verifier_type="semantic",
                        predicate={},
                        required_evidence=(),
                        source="explicit",
                    )
                )
        return cls(
            criteria=tuple(criteria),
            output_predicates=value.get("outputPredicates") or value.get("output_predicates") or {},
            amendments=list(value.get("amendments") or ()),
        )


@dataclass
class CriterionLedgerEntry:
    criterion: AcceptanceCriterion
    status: CriterionStatus = CriterionStatus.UNKNOWN
    evidence: tuple[str, ...] = ()
    reason: str = ""
    writes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "criterionId": self.criterion.criterion_id,
            "status": self.status.value,
            "evidence": list(self.evidence),
            "reason": self.reason,
            "writes": list(self.writes),
        }


class CriterionLedger:
    """Mutable evidence/status projection for an immutable acceptance contract."""

    def __init__(self, contract: AcceptanceContract) -> None:
        self.contract = contract
        self.criteria: dict[str, AcceptanceCriterion] = contract.by_id
        self.entries: dict[str, CriterionLedgerEntry] = {
            criterion.criterion_id: CriterionLedgerEntry(criterion)
            for criterion in contract.criteria
        }
        self.side_effects: list[str] = []

    @classmethod
    def from_mapping(
        cls,
        contract: AcceptanceContract,
        value: Mapping[str, Any] | None,
    ) -> "CriterionLedger":
        ledger = cls(contract)
        if not isinstance(value, Mapping):
            return ledger
        raw_entries = value.get("criteria", value)
        if not isinstance(raw_entries, Mapping):
            return ledger
        for criterion_id, raw in raw_entries.items():
            if criterion_id not in ledger.entries or not isinstance(raw, Mapping):
                continue
            entry = ledger.entries[criterion_id]
            entry.status = _status(raw.get("status"))
            entry.evidence = tuple(
                _text(item, 2000)
                for item in raw.get("evidence") or ()
                if _text(item, 2000)
            )
            entry.reason = _text(raw.get("reason"), 2000)
            entry.writes = tuple(
                _text(item, 1000)
                for item in raw.get("writes") or ()
                if _text(item, 1000)
            )
        side_effects = value.get("sideEffects")
        if isinstance(side_effects, list):
            ledger.side_effects = [
                _text(item, 2000) for item in side_effects if _text(item, 2000)
            ]
        return ledger

    def entry(self, criterion_id: str) -> CriterionLedgerEntry:
        key = _text(criterion_id, 80)
        if key not in self.entries:
            raise KeyError(f"unknown acceptance criterion: {criterion_id}")
        return self.entries[key]

    def mandatory_entries(self) -> tuple[CriterionLedgerEntry, ...]:
        return tuple(entry for entry in self.entries.values() if entry.criterion.mandatory)

    def mandatory_all_verified(self) -> bool:
        return all(entry.status in _TERMINAL_POSITIVE for entry in self.mandatory_entries())

    def summary(self) -> dict[str, Any]:
        entries = tuple(self.entries.values())
        verified = sum(entry.status in _TERMINAL_POSITIVE for entry in entries)
        return {
            "total": len(entries),
            "verified": verified,
            "failed": [
                entry.criterion.criterion_id
                for entry in entries
                if entry.status is CriterionStatus.FAILED
            ],
            "unknown": [
                entry.criterion.criterion_id
                for entry in entries
                if entry.status is CriterionStatus.UNKNOWN
            ],
            "blocked": [
                entry.criterion.criterion_id
                for entry in entries
                if entry.status is CriterionStatus.BLOCKED
            ],
            "contradicted": [
                entry.criterion.criterion_id
                for entry in entries
                if entry.status is CriterionStatus.CONTRADICTED
            ],
        }

    def unresolved_mandatory(self) -> tuple[str, ...]:
        return tuple(
            entry.criterion.criterion_id
            for entry in self.mandatory_entries()
            if entry.status not in _TERMINAL_POSITIVE
        )

    def mandatory_contradictions(self) -> tuple[str, ...]:
        return tuple(
            entry.criterion.criterion_id
            for entry in self.mandatory_entries()
            if entry.status is CriterionStatus.CONTRADICTED
        )

    def prohibited_side_effects(self) -> bool:
        return bool(self.side_effects)

    def set_status(
        self,
        criterion_id: str,
        status: CriterionStatus | str,
        *,
        evidence: Iterable[str] = (),
        reason: str = "",
    ) -> CriterionLedgerEntry:
        entry = self.entry(criterion_id)
        next_status = _status(status)
        if next_status is CriterionStatus.WAIVED:
            raise PermissionError("WAIVED requires explicit operator authority")
        entry.status = next_status
        if evidence:
            entry.evidence = tuple(
                dict.fromkeys(
                    [*entry.evidence, *(_text(item, 2000) for item in evidence if _text(item, 2000))]
                )
            )
        entry.reason = _text(reason, 2000)
        return entry

    def attach_evidence(
        self, criterion_id: str, evidence: Iterable[str], *, reason: str = ""
    ) -> CriterionLedgerEntry:
        entry = self.entry(criterion_id)
        entry.evidence = tuple(
            dict.fromkeys(
                [*entry.evidence, *(_text(item, 2000) for item in evidence if _text(item, 2000))]
            )
        )
        if entry.status is CriterionStatus.UNKNOWN:
            entry.status = CriterionStatus.EVIDENCED
        if reason:
            entry.reason = _text(reason, 2000)
        return entry

    def record_side_effect(self, detail: str) -> None:
        value = _text(detail, 2000)
        if value and value not in self.side_effects:
            self.side_effects.append(value)

    def mark_write(self, writes: Iterable[str]) -> tuple[str, ...]:
        paths = tuple(dict.fromkeys(_text(item, 1000) for item in writes if _text(item, 1000)))
        if not paths:
            return ()
        for entry in self.entries.values():
            if entry.status is CriterionStatus.VERIFIED:
                entry.status = CriterionStatus.STALE
                entry.writes = tuple(dict.fromkeys([*entry.writes, *paths]))
                entry.reason = "verification became stale after a later write"
        return paths

    def waive(
        self,
        criterion_id: str,
        *,
        authority: str,
        allow_mandatory: bool = False,
        reason: str = "",
    ) -> CriterionLedgerEntry:
        normalized = _text(authority, 80).lower()
        entry = self.entry(criterion_id)
        if normalized != "operator":
            raise PermissionError("WAIVED requires explicit operator authority")
        if entry.criterion.mandatory and not allow_mandatory:
            raise PermissionError("waiving a mandatory criterion needs explicit override")
        entry.status = CriterionStatus.WAIVED
        entry.reason = _text(reason) or "explicit operator waiver"
        return entry

    def amend(
        self,
        *,
        add: Iterable[AcceptanceCriterion] = (),
        remove: Iterable[str] = (),
        promote: Iterable[str] = (),
        replace: Mapping[str, AcceptanceCriterion] | None = None,
        reason: str,
        authority: str,
    ) -> tuple[str, ...]:
        normalized_authority = _text(authority, 80).lower()
        if normalized_authority not in _AMENDMENT_AUTHORITIES:
            raise PermissionError("criterion amendments require operator or deterministic authority")
        existing = dict(self.criteria)
        added: list[str] = []
        for raw in add:
            criterion = raw if isinstance(raw, AcceptanceCriterion) else AcceptanceCriterion.from_mapping(raw)
            if criterion.criterion_id in existing:
                continue
            if criterion.mandatory and (
                criterion.source == "planner_proposed"
                or normalized_authority not in {"operator", "deterministic"}
            ):
                raise PermissionError("planner criteria remain proposed and non-mandatory")
            existing[criterion.criterion_id] = criterion
            self.criteria[criterion.criterion_id] = criterion
            self.entries[criterion.criterion_id] = CriterionLedgerEntry(criterion)
            added.append(criterion.criterion_id)
        removed: list[str] = []
        for raw_id in remove:
            criterion_id = _text(raw_id, 80)
            criterion = existing.get(criterion_id)
            if criterion is None:
                continue
            if criterion.mandatory:
                raise PermissionError("mandatory criteria are immutable and cannot be removed")
            self.criteria.pop(criterion_id, None)
            self.entries.pop(criterion_id, None)
            removed.append(criterion_id)
        promoted: list[str] = []
        for raw_id in promote:
            criterion_id = _text(raw_id, 80)
            criterion = existing.get(criterion_id)
            if criterion is None:
                continue
            if normalized_authority not in {"operator", "deterministic"}:
                raise PermissionError("only operator or deterministic policy may promote criteria")
            if criterion.mandatory:
                continue
            promoted_criterion = AcceptanceCriterion(
                criterion_id=criterion.criterion_id,
                requirement=criterion.requirement,
                mandatory=True,
                verifier_type=criterion.verifier_type,
                predicate=criterion.predicate,
                required_evidence=criterion.required_evidence,
                source=criterion.source,
            )
            self.criteria[criterion_id] = promoted_criterion
            self.entries[criterion_id].criterion = promoted_criterion
            promoted.append(criterion_id)
            existing[criterion_id] = promoted_criterion
        for raw_id, replacement in (replace or {}).items():
            criterion_id = _text(raw_id, 80)
            current = existing.get(criterion_id)
            if current is None:
                continue
            if current.mandatory and (
                replacement.requirement != current.requirement
                or replacement.predicate != current.predicate
                or replacement.required_evidence != current.required_evidence
            ):
                raise PermissionError("mandatory criteria cannot be weakened or replaced")
            self.criteria[criterion_id] = replacement
            self.entries[criterion_id].criterion = replacement
            existing[criterion_id] = replacement
        affected = tuple([*added, *removed, *promoted, *(_text(item, 80) for item in (replace or {}))])
        if affected:
            self.contract.criteria = tuple(self.criteria.values())
            self.contract.amendments.append(
                ContractAmendment(
                    action="amend",
                    criterion_ids=affected,
                    reason=_text(reason, 2000),
                    authority=normalized_authority,
                )
            )
        return affected

    def to_dict(self) -> dict[str, Any]:
        payload = {
            criterion_id: entry.to_dict()
            for criterion_id, entry in self.entries.items()
        }
        payload["schema"] = "sophia.criterion_ledger.v1"
        payload["sideEffects"] = list(self.side_effects)
        return payload


def strict_complete(contract: AcceptanceContract, ledger: CriterionLedger) -> bool:
    """Return the authoritative strict completion predicate."""
    return (
        all(entry.status in _TERMINAL_POSITIVE for entry in ledger.mandatory_entries())
        and not ledger.mandatory_contradictions()
        and contract.output_predicates_pass()
        and not ledger.prohibited_side_effects()
    )


def criteria_to_legacy_strings(
    criteria: Iterable[AcceptanceCriterion | str],
    *,
    mandatory_only: bool = False,
) -> tuple[str, ...]:
    return tuple(
        _text(item.requirement if isinstance(item, AcceptanceCriterion) else item, 1000)
        for item in criteria
        if (
            not mandatory_only
            or not isinstance(item, AcceptanceCriterion)
            or item.mandatory
        )
        if _text(item.requirement if isinstance(item, AcceptanceCriterion) else item, 1000)
    )


__all__ = [
    "AcceptanceContract",
    "AcceptanceCriterion",
    "ContractAmendment",
    "CriterionLedger",
    "CriterionLedgerEntry",
    "CriterionStatus",
    "SCHEMA",
    "criteria_to_legacy_strings",
    "strict_complete",
]
