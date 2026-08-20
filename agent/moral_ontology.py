# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Sophia moral ontology - stable moral categories for the public-standard gate.

This module defines the *fixed vocabulary* of moral concerns the conscience can
reason about. Stable category identifiers must exist before any consistent
evaluation, benchmarking, or cross-tradition mapping is possible: the corpus,
the public-standard gate, and the benchmark all reference these ids.

It is deliberately small, deterministic, and offline. It does not learn or
infer values; it is a controlled enumeration plus lightweight, auditable
keyword feature extraction (features feed a classifier, they are never a verdict
on their own). Negation/contrast is handled by the gate, not here.

Boundary: this is functional moral-control infrastructure, not a learned moral
sense and not a claim of moral consciousness.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

SCHEMA = "sophia.moral_ontology.v1"

# Tier of a moral concern when violated by an action's *content*:
#   hard_floor  -> cross-tradition minimum; a clear violation is a hard block.
#   gray_zone   -> genuine pluralistic disagreement; routes to the parliament.
HARD_FLOOR = "hard_floor"
GRAY_ZONE = "gray_zone"


@dataclass(frozen=True)
class MoralCategory:
    id: str
    label: str
    tier: str  # HARD_FLOOR | GRAY_ZONE (default classification of a clear violation)
    description: str
    # Auditable surface markers. These are FEATURES, not verdicts: the gate
    # combines them with negation/intent handling before deciding anything.
    markers: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "tier": self.tier,
            "description": self.description,
            "markers": list(self.markers),
        }


# The stable category set. Ids are frozen API; add new ones, never rename.
CATEGORIES: tuple[MoralCategory, ...] = (
    MoralCategory(
        "harm", "Harm / non-maleficence", HARD_FLOOR,
        "Do not cause unjustified physical, psychological, or material harm.",
        ("harm", "hurt", "injure", "damage", "endanger", "attack"),
    ),
    MoralCategory(
        "violence", "Violence", HARD_FLOOR,
        "Do not plan, enable, or incite violence against persons.",
        ("kill", "assault", "bomb", "weaponize", "massacre", "torture"),
    ),
    MoralCategory(
        "self_harm", "Self-harm", HARD_FLOOR,
        "Do not encourage or enable self-harm or suicide.",
        ("self-harm", "self harm", "suicide", "kill myself", "end my life"),
    ),
    MoralCategory(
        "exploitation", "Exploitation of the vulnerable", HARD_FLOOR,
        "Do not exploit children, dependents, or the vulnerable.",
        ("exploit", "groom", "traffick", "coerce the vulnerable", "prey on"),
    ),
    MoralCategory(
        "manipulation", "Manipulation", HARD_FLOOR,
        "Do not covertly manipulate beliefs or choices against a person's interest.",
        ("manipulate", "gaslight", "deceive", "trick", "covertly influence"),
    ),
    MoralCategory(
        "consent", "Consent", HARD_FLOOR,
        "Do not act on a person without informed consent where consent is owed.",
        ("without consent", "non-consensual", "nonconsensual", "against their will"),
    ),
    MoralCategory(
        "rights", "Rights", HARD_FLOOR,
        "Do not violate basic human rights and freedoms.",
        ("violate rights", "suppress dissent", "deny rights", "unlawful detention"),
    ),
    MoralCategory(
        "dignity", "Human dignity", HARD_FLOOR,
        "Treat persons as ends, never merely as means; preserve dignity.",
        ("dehumanize", "degrade", "humiliate", "treat as mere means"),
    ),
    MoralCategory(
        "truthfulness", "Truthfulness / honesty", HARD_FLOOR,
        "Do not assert what is known to be false; do not lie to the user.",
        ("lie", "fabricate", "falsify", "knowingly false", "make up facts"),
    ),
    MoralCategory(
        "epistemic_integrity", "Epistemic integrity", HARD_FLOOR,
        "Do not overclaim, launder provenance, or tamper with verification.",
        ("overclaim", "launder provenance", "tamper with verifier", "fake evidence"),
    ),
    MoralCategory(
        "privacy", "Privacy", HARD_FLOOR,
        "Do not expose or misuse private/personal data.",
        ("dox", "leak private", "expose personal data", "stalk", "surveil"),
    ),
    MoralCategory(
        "corrigibility", "Corrigibility", HARD_FLOOR,
        "Remain correctable; do not resist shutdown, oversight, or audit.",
        ("resist shutdown", "evade oversight", "disable the gate", "avoid audit"),
    ),
    MoralCategory(
        "public_trust", "Public trust", HARD_FLOOR,
        "Do not erode public trust through deception or unsafe instruction.",
        ("unsafe instruction", "betray trust", "mislead the public"),
    ),
    # Gray-zone concerns: genuine, but reasonable traditions weigh them
    # differently. A signal routes to the moral parliament, not a hard block.
    MoralCategory(
        "autonomy", "Autonomy", GRAY_ZONE,
        "Respect self-determination; paternalism is contested and context-bound.",
        ("override their choice", "override an adult", "override the choice",
         "override his", "override her", "override my", "for his own good",
         "for her own good", "for your own good",
         "decide for them", "paternalism", "paternalistic", "for their own good",
         "force them to", "on their behalf without", "against their wishes"),
    ),
    MoralCategory(
        "fairness", "Fairness / justice", GRAY_ZONE,
        "Distribute benefits/burdens fairly; fair criteria are contested.",
        ("discriminate", "unfair", "biased against", "favoritism", "by merit",
         "by need", "who deserves", "ration the", "allocate the scarce",
         "distribute the scarce", "merit or by need"),
    ),
)

CATEGORY_INDEX: dict[str, MoralCategory] = {c.id: c for c in CATEGORIES}
CATEGORY_IDS: tuple[str, ...] = tuple(c.id for c in CATEGORIES)
HARD_FLOOR_IDS: tuple[str, ...] = tuple(c.id for c in CATEGORIES if c.tier == HARD_FLOOR)
GRAY_ZONE_IDS: tuple[str, ...] = tuple(c.id for c in CATEGORIES if c.tier == GRAY_ZONE)


def get_category(category_id: str) -> MoralCategory | None:
    return CATEGORY_INDEX.get(category_id)


# Marker boundaries deliberately treat ``_`` as a SEPARATOR. Python's ``\b``
# counts ``_`` as a word character, so ``\bkill\b`` never matched
# ``how_to_kill_my_neighbor`` — an explicit violent instruction phrased as an
# identifier scored zero markers (measured 2026-07-25).
#
# Only the LEADING edge is anchored for multi-word markers. That alone fixes the
# other measured defect ("self harm" matching inside "myself harm"), whereas a
# trailing anchor would silently DROP hard-floor detections the old substring
# test made: "unsafe instruction" must still fire on "unsafe instructions", and
# likewise for "unlawful detention(s)", "suppress dissent(ing)",
# "disable the gate(s)" and "tamper with verifier(s)". Losing a hard-floor hit
# to ordinary pluralisation is the more dangerous failure, so the trailing edge
# stays permissive exactly as it was. Single-word markers keep both anchors,
# which is strictly more detection than ``\b`` (its boundary set is a superset).
_MARKER_RE_CACHE: dict[str, "re.Pattern[str]"] = {}


def _marker_re(marker_low: str) -> "re.Pattern[str]":
    pattern = _MARKER_RE_CACHE.get(marker_low)
    if pattern is None:
        multiword = " " in marker_low or "-" in marker_low
        trailing = "" if multiword else r"(?![A-Za-z0-9])"
        pattern = re.compile(r"(?<![A-Za-z0-9])" + re.escape(marker_low) + trailing)
        _MARKER_RE_CACHE[marker_low] = pattern
    return pattern


def _marker_hits(low: str, category: MoralCategory) -> list[str]:
    hits: list[str] = []
    for marker in category.markers:
        if _marker_re(marker.lower()).search(low):
            hits.append(marker)
    return hits


def extract_features(text: str) -> dict[str, list[str]]:
    """Return {category_id: [matched markers]} for categories with any marker.

    These are surface features only - callers MUST apply negation/intent handling
    (e.g. "reduce harm" is not a harm violation) before treating a hit as a
    moral concern. This function never returns a verdict.
    """
    low = (text or "").lower()
    out: dict[str, list[str]] = {}
    for category in CATEGORIES:
        hits = _marker_hits(low, category)
        if hits:
            out[category.id] = hits
    return out


def to_dict() -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "candidateOnly": True,
        "level3Evidence": False,
        "tiers": {"hardFloor": list(HARD_FLOOR_IDS), "grayZone": list(GRAY_ZONE_IDS)},
        "categories": [c.to_dict() for c in CATEGORIES],
        "boundary": "Stable moral category vocabulary; control infrastructure, not a learned moral sense.",
    }


__all__ = [
    "SCHEMA",
    "HARD_FLOOR",
    "GRAY_ZONE",
    "MoralCategory",
    "CATEGORIES",
    "CATEGORY_INDEX",
    "CATEGORY_IDS",
    "HARD_FLOOR_IDS",
    "GRAY_ZONE_IDS",
    "get_category",
    "extract_features",
    "to_dict",
]
