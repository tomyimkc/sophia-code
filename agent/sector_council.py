# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Generic data-driven sector council router (law, financial, economy, ...).

Mirrors the coding council pattern (agent/coding_council.py) but generalized so a
new sector council needs only a data file. Each council JSON declares seatGroups;
non-core groups contribute the top-N seats by trigger-term match, while core
groups (the cross-cutting guardians: ethics, citation/numbers auditor,
plain-language explainer, human-review gatekeeper) are always seated.

Source discipline: figure-inspired seats name a lineage and carry a
speakerBoundary forbidding impersonation, exactly like the coding/religion
councils. These councils are decision-support scaffolds, not licensed
professionals — every council carries a humanBoundary and a "not advice" stance.
"""

from __future__ import annotations

import json
import re
from typing import Any

from agent.config import ROOT

COUNCIL_DIR = ROOT / "data"
COUNCIL_FILES = {
    "law": "law_council_figures.json",
    "financial": "financial_council_figures.json",
    "economy": "economy_council_figures.json",
    "wisdom": "wisdom_council_figures.json",
}


def available_councils() -> list[str]:
    return sorted(COUNCIL_FILES)


def load_council(council_id: str) -> dict[str, Any]:
    name = COUNCIL_FILES.get(council_id)
    if not name:
        raise ValueError(f"unknown council: {council_id!r}; valid: {', '.join(available_councils())}")
    path = COUNCIL_DIR / name
    return json.loads(path.read_text(encoding="utf-8"))


def _term_matches(text: str, term: str) -> bool:
    normalized = text.lower()
    needle = term.lower()
    if needle.strip() != needle:  # term intentionally padded with spaces
        return needle in f" {normalized} "
    if re.search(r"[^a-zA-Z0-9_+#.-]", needle):  # multiword term (contains a space)
        # treat hyphens as spaces so "minimum-wage" matches "minimum wage"
        return needle.replace("-", " ") in normalized.replace("-", " ")
    return bool(re.search(rf"(?<![a-zA-Z0-9_]){re.escape(needle)}(?![a-zA-Z0-9_])", normalized))


def _score_seat(text: str, seat: dict[str, Any]) -> int:
    return sum(1 for term in seat.get("triggerTerms", []) if _term_matches(text, str(term)))


def detect_council(text: str, *, min_score: int = 2) -> str | None:
    """Pick the sector council whose non-core (specialist) seats best match the
    text, or None if no council is a clear fit. Guardian seats (no triggerTerms)
    do not count toward detection."""
    best_id: str | None = None
    best_score = 0
    for council_id in available_councils():
        council = load_council(council_id)
        score = 0
        for group in council.get("seatGroups", {}).values():
            if group.get("core"):
                continue
            for seat in group.get("seats", {}).values():
                score += _score_seat(text, seat)
        if score > best_score:
            best_id, best_score = council_id, score
    return best_id if best_score >= min_score else None


def route_council(
    council: dict[str, Any],
    query: str,
    materials: list[str] | None = None,
) -> dict[str, Any]:
    """Select council seats relevant to a query.

    Core groups are always seated; non-core groups contribute their top-`limit`
    trigger-matched seats. workflow.defaultSeats are force-included, and a
    fallbackSeat is added when no non-core seat matched.
    """
    text = f"{query}\n" + "\n".join(materials or [])
    groups = council.get("seatGroups", {})
    selected: dict[str, Any] = {}
    non_core_hit = False

    for group_key, group in groups.items():
        seats = group.get("seats", {})
        if group.get("core"):
            chosen = list(seats.values())
        else:
            ranked = sorted(
                ((_score_seat(text, seat), key, seat) for key, seat in seats.items()),
                key=lambda item: (-item[0], item[1]),
            )
            chosen = [seat for score, _, seat in ranked if score > 0][: group.get("limit", 3)]
            if chosen:
                non_core_hit = True
        if chosen:
            selected[group_key] = {"label": group.get("label", group_key), "core": bool(group.get("core")), "seats": chosen}

    default_ids = set(council.get("workflow", {}).get("defaultSeats", []))
    present_ids = {seat.get("seatId") for group in selected.values() for seat in group["seats"]}
    for missing_id in default_ids - present_ids:
        for group_key, group in groups.items():
            seat = next((s for s in group.get("seats", {}).values() if s.get("seatId") == missing_id), None)
            if seat:
                bucket = selected.setdefault(
                    group_key, {"label": group.get("label", group_key), "core": bool(group.get("core")), "seats": []}
                )
                if seat not in bucket["seats"]:
                    bucket["seats"].append(seat)
                break

    fallback = council.get("workflow", {}).get("fallbackSeat")
    if not non_core_hit and fallback:
        selected["fallback"] = {"label": "Fallback", "core": False, "seats": [fallback]}

    return {
        "councilId": council.get("councilId"),
        "displayName": council.get("displayName"),
        "selected": selected,
        "decisionContract": council.get("workflow", {}).get("decisionContract", []),
        "humanBoundary": council.get("humanBoundary", []),
    }


def format_council(route: dict[str, Any]) -> str:
    """Render a routed council as compact prompt context."""
    lines = [
        f"## {route.get('displayName', 'Sector Council')}",
        "Source-inspired seats provide constraints and perspectives only — not impersonation, "
        "and NOT a substitute for a licensed professional.",
    ]
    for group in route.get("selected", {}).values():
        seats = [seat for seat in group.get("seats", []) if isinstance(seat, dict) and seat]
        if not seats:
            continue
        lines.append(f"\n### {group.get('label', 'Seats')}")
        for seat in seats:
            emphasis = "; ".join(str(item) for item in seat.get("decisionEmphasis", [])[:4])
            details = []
            frame = seat.get("sourceFrame") or seat.get("representativeFrame")
            if frame:
                details.append(str(frame))
            if seat.get("speakerBoundary"):
                details.append(str(seat["speakerBoundary"]))
            if emphasis:
                details.append(f"Emphasis: {emphasis}.")
            if seat.get("humanBoundary"):
                details.append(f"Human boundary: {seat['humanBoundary']}")
            lines.append(f"- {seat.get('displayName', seat.get('seatId', 'Council seat'))}: {' '.join(details)}")
    if route.get("humanBoundary"):
        lines.append("\n### Human authority boundary")
        for item in route["humanBoundary"]:
            lines.append(f"- {item}")
    if route.get("decisionContract"):
        lines.append("\n### Council decision contract")
        for item in route["decisionContract"]:
            lines.append(f"- {item}")
    return "\n".join(lines)
