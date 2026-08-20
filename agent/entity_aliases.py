# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Canonical entity-alias resolution for author attribution matching.

The gate's attribution checks (``agent.benchmark_checks.author_markers`` and the
``provenance_faithful`` verifier) match a model's prose against a small set of
"surface markers" for each forbidden author. Today a record that stores the full
name ``"Leo Tolstoy"`` is only matched when the model also writes the full name;
a natural phrasing like *"Tolstoy wrote Crime and Punishment"* slips through. As
~58% of records carry multi-token authors, this is a real recall hole.

This module derives the canonical surface forms a matcher should accept for a
given author name: the full name, a surname-only form (last whitespace token),
given-name + surname orderings, and any hand/known transliteration aliases
(reused from ``agent.benchmark_checks.AUTHOR_ALIASES``).

A guard prevents over-firing: a bare surname is only emitted when it is long
enough (>= 4 chars) and is not an over-common given name (Paul, James, ...).
Those names stay full-name-only.

Pure standard library, no side effects, safe to import anywhere.
"""

from __future__ import annotations

import re

# Over-common given names that frequently appear as a *last* token (e.g. authors
# referenced by a single given name, or "Letter of Paul"). Emitting these as a
# bare surname marker would over-fire on unrelated prose, so they stay
# full-name-only. Lowercased for comparison.
_OVERCOMMON_GIVEN: frozenset[str] = frozenset(
    {"paul", "james", "peter", "john", "mary", "mark", "luke", "david", "thomas"}
)

# Generic words that can appear as a trailing token but are never a real surname.
_GENERIC_WORDS: frozenset[str] = frozenset(
    {"the", "of", "and", "great", "elder", "younger", "saint", "king", "book",
     "work", "text", "author", "prophet", "apostle", "emperor"}
)

# Minimum length for a bare surname to be safe to emit on its own.
_MIN_SURNAME_LEN = 4

_WS = re.compile(r"\s+")


def _canon_key(name: str) -> str:
    """Reduce a display name to the snake_case id form AUTHOR_ALIASES uses."""
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def _known_aliases(name: str) -> list[str]:
    """Look up hand/known transliteration aliases for ``name`` from the gate's
    AUTHOR_ALIASES table, trying both the raw id and a canonicalized key.

    Imported lazily so this module stays free of import-time side effects and
    does not create a hard import cycle with benchmark_checks.
    """
    try:
        from agent.benchmark_checks import AUTHOR_ALIASES
    except Exception:  # pragma: no cover - defensive; table is optional
        return []
    out: list[str] = []
    for key in (name, name.strip().lower(), _canon_key(name)):
        for alias in AUTHOR_ALIASES.get(key, []):
            if alias and alias not in out:
                out.append(alias)
    return out


def is_ambiguous_surname(surname: str) -> bool:
    """True if ``surname`` must NOT be emitted as a bare marker.

    A surname is ambiguous (unsafe to fire on alone) when it is too short, a
    generic structural word, or an over-common given name. Such authors stay
    full-name-only so the matcher does not over-fire.
    """
    s = surname.strip().lower()
    if not s:
        return True
    # Multi-token "surnames" (e.g. "von Neumann") are handled by the caller; a
    # bare check only governs single tokens.
    if len(s) < _MIN_SURNAME_LEN:
        return True
    if s in _GENERIC_WORDS:
        return True
    if s in _OVERCOMMON_GIVEN:
        return True
    return False


def author_surface_forms(name: str) -> list[str]:
    """Return canonical lower-cased surface markers a matcher should accept for
    an author ``name``.

    Always includes the full name (normalized whitespace, lower-cased). Adds the
    surname-only form (last whitespace token) and given+surname orderings when
    the surname is unambiguous, plus any known transliteration aliases. The
    result composes with ``benchmark_checks.author_markers`` (which lower-cases
    every marker before regex-escaping it) — duplicates are harmless.

    Designed to be merged in by the integrator via::

        markers += author_surface_forms(author_id)
    """
    raw = (name or "").strip()
    if not raw:
        return []

    full = _WS.sub(" ", raw).lower()
    forms: list[str] = [full]

    tokens = full.split(" ")
    # Surname-only: last whitespace token, guarded.
    if len(tokens) >= 2:
        surname = tokens[-1]
        given = tokens[0]
        if not is_ambiguous_surname(surname):
            forms.append(surname)
            # Given-name + surname orderings (covers "given surname" and the
            # reversed "surname, given" / "surname given" the model may use).
            forms.append(f"{given} {surname}")
            forms.append(f"{surname} {given}")

    # Known/hand transliteration aliases (CJK, Wade-Giles, etc.).
    for alias in _known_aliases(raw):
        a = alias.strip().lower()
        if a:
            forms.append(a)

    # De-duplicate, preserve order.
    seen: set[str] = set()
    out: list[str] = []
    for f in forms:
        if f and f not in seen:
            seen.add(f)
            out.append(f)
    return out
