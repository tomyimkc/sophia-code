# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""An honest, UI-ready summary of what the gate actually did to an answer.

The underlying delivery gate has two enforcement tiers:

* **Tier 1 (floor)** withholds hard prohibitions.
* **Tier 2 (strict, opt-in)** withholds epistemic-uncertainty verdicts, and is
  off by default because arming it would downgrade almost every ordinary answer.

General harness callers retain the historical mandatory floor. Sophia Code adds
an explicit operator policy above it: ``off`` skips final-text evaluation,
``report`` evaluates without withholding, ``floor`` enforces Tier 1, and
``strict`` enforces both tiers. The status emitted for each answer must therefore
say what actually ran rather than implying every delivered answer was cleared.

So an answer whose conscience verdict was ``abstain``/``retrieve``/``escalate``
is still DELIVERED when Tier 2 is off. Today nothing tells the user that. A UI
built on the naive reading — "it came back, so the gate passed it" — would put a
reassuring affordance over text that was never actually checked for uncertainty,
which is the automation-bias failure this project exists to avoid.

This module exists to make that distinction representable. Its rules:

1. **Never claim more checking than ran.** ``delivered_unreviewed`` is a
   first-class state, not an error and not a success — and it still means the
   hard-prohibition floor ran. Operator-selected ``off`` and ``report`` modes
   receive their own states. External / ungated lanes (e.g. a pi lane that has
   no permission system by design) must use ``delivered_ungated`` instead;
   reusing ``delivered_unreviewed`` would claim the floor cleared the text.
2. **Report disagreement, not confidence.** The moral parliament already
   computes a variance across its theories; the human-factors literature is
   clear that a bare confidence scalar can *increase* over-reliance, while
   disagreement is both rarer and more actionable.
3. **Display by exception.** ``severity`` is ``notice`` for the routine states so
   a UI can keep them quiet. Uniform severity trains people to ignore everything.
   Ungated output is ``caution`` (louder than empty's ``notice``) — never quieter
   than "no answer".

This is a reporting layer. It makes no gating decision and changes no outcome.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

SCHEMA = "sophia.epistemic_status.v1"

#: Verdicts that mean the conscience kernel positively cleared the text, rather
#: than merely not prohibiting it.
_CLEARED_VERDICTS = frozenset({"allow"})

#: Runners that never invoke Sophia's conscience floor. Callers may also pass
#: ``floor_checked=False`` explicitly for any other external path.
_UNGATED_RUNNERS = frozenset({"pi", "external", "ungated", "lane_ungated"})
_EXTERNAL_FLOOR_RUNNERS = frozenset({"prime", "prime-agent", "external_floor"})


@dataclass(frozen=True)
class EpistemicStatus:
    """What was checked, what was not, and what that means for this answer."""

    state: str
    label: str
    detail: str
    severity: str  # "notice" | "caution" | "alert"
    verdict: str = ""
    floorChecked: bool = True
    uncertaintyChecked: bool = False
    strictGateArmed: bool = False
    disagreement: float | None = None
    reason: str = ""
    schema: str = SCHEMA
    candidateOnly: bool = True
    canClaimAGI: bool = False
    checks: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "state": self.state,
            "label": self.label,
            "detail": self.detail,
            "severity": self.severity,
            "verdict": self.verdict,
            "floorChecked": self.floorChecked,
            "uncertaintyChecked": self.uncertaintyChecked,
            "strictGateArmed": self.strictGateArmed,
            "disagreement": self.disagreement,
            "reason": self.reason,
            "checks": dict(self.checks),
            "candidateOnly": self.candidateOnly,
            "canClaimAGI": self.canClaimAGI,
        }


def describe(
    *,
    verdict: str,
    gated: bool,
    strict: bool,
    empty: bool = False,
    disagreement: float | None = None,
    reason: str = "",
    checks: dict[str, Any] | None = None,
    floor_checked: bool | None = None,
    runner: str = "sophia",
) -> EpistemicStatus:
    """Summarise one answer's gate outcome.

    ``gated`` is the delivery gate's own signal that it downgraded the answer;
    ``strict`` is whether Tier 2 was armed for this run.

    ``runner`` is the agent lane that produced the answer. The Sophia lane runs
    the conscience floor; the ``pi`` lane (and any other external runner) does
    **not**. Callers MUST pass ``runner="pi"`` (or set ``floor_checked=False``)
    for those answers — reusing ``delivered_unreviewed`` would claim the text
    "cleared the hard-prohibition floor", which is false when nothing ran.
    """
    verdict = (verdict or "").strip().lower()
    checks = dict(checks or {})
    runner = (runner or "sophia").strip().lower()

    # A floor evaluation error is a terminal fail-closed outcome, even though
    # floorChecked is necessarily false. Handle it before the generic ungated
    # branch so a withheld answer can never be mislabeled as delivered.
    if gated and verdict == "gate_error":
        return EpistemicStatus(
            state="withheld_error", label="withheld", severity="alert",
            detail=(
                "The gate could not be evaluated, so the answer was withheld "
                "rather than delivered unchecked."
            ),
            verdict=verdict, floorChecked=False, uncertaintyChecked=False,
            strictGateArmed=strict, disagreement=disagreement, reason=reason,
            checks=checks,
        )

    # External / ungated lane: nothing about the conscience floor ran. This is
    # a strictly weaker claim than delivered_unreviewed (which still means the
    # hard-prohibition tier cleared the text). Severity is caution — louder
    # than empty (notice), never quieter, so the UI cannot hide the gap.
    # Canonical state name: delivered_ungated (delivered_* family). The prior
    # spike name ungated_external is accepted only as a runner alias, not as a
    # state string on the wire.
    if floor_checked is False or runner in _UNGATED_RUNNERS:
        if empty:
            return EpistemicStatus(
                state="empty", label="no answer", severity="notice",
                detail="The external/ungated lane produced no text.",
                verdict=verdict, floorChecked=False, uncertaintyChecked=False,
                strictGateArmed=False, disagreement=disagreement, reason=reason,
                checks={**checks, "runner": runner or "external"},
            )
        return EpistemicStatus(
            state="delivered_ungated",
            label="not gated — external/ungated lane",
            severity="caution",
            detail=(
                "Produced by an external/ungated agent lane that does not run "
                "Sophia's conscience floor or uncertainty tier. Never claim more "
                "checking than ran — treat as unverified output."
            ),
            verdict=verdict, floorChecked=False, uncertaintyChecked=False,
            strictGateArmed=False, disagreement=disagreement, reason=reason,
            checks={**checks, "runner": runner or "external"},
        )

    if empty:
        return EpistemicStatus(
            state="empty", label="no answer", severity="notice",
            detail="The run produced no text to check.",
            verdict=verdict, uncertaintyChecked=strict, strictGateArmed=strict,
            disagreement=disagreement, reason=reason, checks=checks,
        )

    if gated:
        return EpistemicStatus(
            state="blocked", label="blocked", severity="alert",
            detail=("The conscience floor withheld this answer as a hard prohibition."
                    if not strict else
                    "The conscience gate withheld this answer."),
            verdict=verdict, uncertaintyChecked=strict, strictGateArmed=strict,
            disagreement=disagreement, reason=reason, checks=checks,
        )

    # Prime/external runtime whose FINAL TEXT was checked after execution.  This
    # is stronger than delivered_ungated but deliberately not conflated with a
    # Sophia-native run: the floor says nothing about filesystem/process/network
    # actions Prime already took under the user's OS authority, and Tier 2 did
    # not validate factual grounding.
    if runner in _EXTERNAL_FLOOR_RUNNERS and floor_checked is True:
        return EpistemicStatus(
            state="delivered_external_floor_checked",
            label="external output · floor checked",
            severity="caution",
            detail=(
                "Prime Agent produced this answer under external user-process "
                "authority. Sophia checked the final text against the mandatory "
                "hard-prohibition floor, but did not retroactively approve its "
                "tool actions or arm the strict uncertainty tier."
            ),
            verdict=verdict,
            floorChecked=True,
            uncertaintyChecked=False,
            strictGateArmed=False,
            disagreement=disagreement,
            reason=reason,
            checks={
                **checks,
                "runner": runner,
                "executionAuthority": "external-user-process",
                "toolActionsApprovedBySophia": False,
            },
        )

    # Delivered. The honest question is what that actually establishes.
    if verdict in _CLEARED_VERDICTS:
        return EpistemicStatus(
            state="delivered_cleared", label="checked", severity="notice",
            detail=("Checked against the conscience floor"
                    + (" and the strict uncertainty tier." if strict
                       else "; the strict uncertainty tier was not armed.")),
            verdict=verdict, uncertaintyChecked=strict, strictGateArmed=strict,
            disagreement=disagreement, reason=reason, checks=checks,
        )

    if strict:
        # Tier 2 was armed and still let it through: a genuinely stronger claim.
        return EpistemicStatus(
            state="delivered_cleared", label="checked", severity="notice",
            detail="Passed the conscience floor and the strict uncertainty tier.",
            verdict=verdict, uncertaintyChecked=True, strictGateArmed=True,
            disagreement=disagreement, reason=reason, checks=checks,
        )

    # The load-bearing state: not prohibited, but never checked for uncertainty.
    return EpistemicStatus(
        state="delivered_unreviewed", label="not gated", severity="caution",
        detail=(f"Delivered on a '{verdict or 'non-allow'}' verdict: it cleared the hard-prohibition "
                "floor, but the strict uncertainty tier is not armed, so its factual "
                "grounding was not checked."),
        verdict=verdict, uncertaintyChecked=False, strictGateArmed=False,
        disagreement=disagreement, reason=reason, checks=checks,
    )


def from_result(result: Any, *, strict: bool, decision: Any = None) -> EpistemicStatus:
    """Build a status from an AgentResult-shaped object.

    Tolerant of missing attributes so a caller can pass a partial or mocked
    result without the reporting layer becoming a new failure source.
    """
    text = str(getattr(result, "final_text", "") or "")
    verdict = str(getattr(result, "gate_verdict", "") or getattr(decision, "verdict", "") or "")
    gated = bool(getattr(result, "gated", False))
    reason = str(getattr(decision, "reason", "") or "")
    disagreement = None
    parliament = getattr(decision, "parliament", None) or getattr(decision, "moral", None)
    if parliament is not None:
        raw = getattr(parliament, "variance", None)
        if raw is None and isinstance(parliament, dict):
            raw = parliament.get("variance")
        if isinstance(raw, (int, float)):
            disagreement = float(raw)
    # Optional lane tag on the result (pi / external). Default stays Sophia.
    runner = str(getattr(result, "runner", "") or getattr(result, "lane", "") or "sophia")
    floor_raw = getattr(result, "floor_checked", None)
    if floor_raw is None:
        floor_raw = getattr(result, "floorChecked", None)
    floor_checked = None if floor_raw is None else bool(floor_raw)
    return describe(
        verdict=verdict, gated=gated, strict=strict, empty=not text.strip(),
        disagreement=disagreement, reason=reason,
        runner=runner, floor_checked=floor_checked,
    )


__all__ = ["SCHEMA", "EpistemicStatus", "describe", "from_result"]
