# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Legal-citation extraction + an authoritative-source registry loader.

This is the substance layer the legal-AI use case needs: a way to pull the
*citations* out of an answer and check each one against a register of authorities
that actually exist. It deliberately does **one narrow, machine-checkable thing**
— "does this cited authority appear in a trusted register?" — because that is the
single check that would have stopped *Mata v. Avianca* and *Ayinde v Haringey*.

Honest scope (read before relying on this):

- It verifies **existence against a supplied register**, not that a case is in the
  right jurisdiction for the matter, that the holding supports the proposition, or
  that the law is current. Those need a real citator + a model judge + a freshness
  check (see ``data/law_council_figures.json`` seats and the doc).
- The bundled register (``data/legal_authorities.json``) is a tiny illustrative
  snapshot, **not** a citator. For real use, point ``SOPHIA_LEGAL_AUTHORITIES`` at
  a register derived from an authoritative primary source — Hong Kong e-Legislation
  (elegislation.gov.hk), HKLII (hklii.hk), the UK National Archives Find Case Law,
  and CourtListener (US).
- Extraction targets common-law **neutral citations** (``[2025] HKCFI 808``,
  ``[2025] EWHC 1383 (Admin)``), HK **ordinance chapter** refs (``Cap. 614``), and
  **US reporter citations** (``925 F.3d 1339``, ``576 U.S. 644``).
"""

from __future__ import annotations

import json
import os
import re
import warnings
from pathlib import Path

from agent.config import DATA_DIR

# Env var letting a user point at their OWN authority register (e.g. an
# HKLII/e-Legislation-derived snapshot). A directory (its *.json), a glob, a
# single file, or several joined by the OS path separator.
LEGAL_AUTHORITIES_ENV = "SOPHIA_LEGAL_AUTHORITIES"
_BUNDLED_REGISTER = "legal_authorities.json"

# Neutral citation: [YYYY] COURT NUMBER, with an optional trailing division
# marker like "(Admin)" / "(Comm)". COURT is 2-6 uppercase letters
# (HKCFA/HKCA/HKCFI/HKDC/EWHC/EWCA/UKSC/UKPC ...).
_NEUTRAL = re.compile(r"\[\s*(\d{4})\s*\]\s+([A-Za-z]{2,6})\s+(\d+)(\s*\([A-Za-z]+\))?")
# HK ordinance chapter reference: "Cap. 614", "Cap 486A", "(Cap. 614)".
_CAP = re.compile(r"\bCap\.?\s*(\d+[A-Z]?)\b", re.IGNORECASE)
# US reporter citation: VOLUME REPORTER PAGE, e.g. "925 F.3d 1339", "576 U.S. 644",
# "678 F. Supp. 3d 443", "143 S. Ct. 1322". Reporter spacing/periods vary in the
# wild, so the capture is permissive and the reporter is canonicalized below; an
# unrecognized reporter is NOT extracted (avoids matching stray "12 of 30" text).
_US = re.compile(
    r"\b(\d+)\s+("
    r"U\.?\s?S\.?"
    r"|S\.?\s?Ct\.?"
    r"|L\.?\s?Ed\.?(?:\s?2d)?"
    r"|F\.?\s?Supp\.?(?:\s?[23]d)?"
    r"|F\.?\s?(?:2d|3d|4th)?"
    r")\s+(\d+)\b"
)
# Canonical reporter forms keyed by the de-spaced, lowercased token.
_US_REPORTERS = {
    "u.s.": "U.S.", "us": "U.S.",
    "s.ct.": "S. Ct.", "sct": "S. Ct.", "s.ct": "S. Ct.",
    "l.ed.": "L. Ed.", "l.ed.2d": "L. Ed. 2d", "led": "L. Ed.", "led2d": "L. Ed. 2d",
    "f.": "F.", "f": "F.", "f.2d": "F.2d", "f2d": "F.2d",
    "f.3d": "F.3d", "f3d": "F.3d", "f.4th": "F.4th", "f4th": "F.4th",
    "f.supp.": "F. Supp.", "fsupp": "F. Supp.", "f.supp": "F. Supp.",
    "f.supp.2d": "F. Supp. 2d", "fsupp2d": "F. Supp. 2d",
    "f.supp.3d": "F. Supp. 3d", "fsupp3d": "F. Supp. 3d",
}


def _canon_us_reporter(raw: str) -> "str | None":
    key = re.sub(r"\s+", "", raw).lower()
    return _US_REPORTERS.get(key)


def normalize_citation(text: str) -> str:
    """Canonical form for matching: collapse whitespace; normalize Cap, neutral
    (``[2025]  hkcfi 808`` -> ``[2025] HKCFI 808``) and US reporter citations
    (``925  f.3d 1339`` -> ``925 F.3d 1339``)."""
    s = re.sub(r"\s+", " ", text).strip()
    m = _NEUTRAL.fullmatch(s) or _NEUTRAL.match(s)
    if m:
        year, court, num, div = m.group(1), m.group(2).upper(), m.group(3), (m.group(4) or "")
        div = re.sub(r"\s+", "", div)
        return f"[{year}] {court} {num}{div}"
    mc = _CAP.fullmatch(s) or _CAP.match(s)
    if mc:
        return f"Cap. {mc.group(1).upper()}"
    mu = _US.fullmatch(s) or _US.match(s)
    if mu:
        reporter = _canon_us_reporter(mu.group(2))
        if reporter:
            return f"{mu.group(1)} {reporter} {mu.group(3)}"
    return s


def extract_citations(text: str) -> list[str]:
    """Return the normalized legal citations found in ``text`` (order-preserving,
    de-duplicated). Empty list means no recognizable citation was made."""
    found: list[str] = []
    for m in _NEUTRAL.finditer(text or ""):
        found.append(normalize_citation(m.group(0)))
    for m in _CAP.finditer(text or ""):
        found.append(normalize_citation(m.group(0)))
    for m in _US.finditer(text or ""):
        if _canon_us_reporter(m.group(2)):
            found.append(normalize_citation(m.group(0)))
    seen: set[str] = set()
    ordered: list[str] = []
    for c in found:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


# Court tokens by jurisdiction, for routing neutral citations to the right source.
HK_COURTS = {"HKCFA", "HKCA", "HKCFI", "HKDC", "HKFC", "HKLDT", "HKCT", "HKLT", "HKMAGC", "HKCRC"}
UK_COURTS = {"EWHC", "EWCA", "UKSC", "UKHL", "UKPC", "EWFC", "EWCOP", "EWCC", "EWCR",
             "UKUT", "UKFTT", "UKEAT", "EAT"}


def neutral_court(citation: str) -> "str | None":
    """The court token of a neutral citation (``[2025] HKCFI 808`` -> ``HKCFI``)."""
    m = _NEUTRAL.match(normalize_citation(citation))
    return m.group(2).upper() if m else None


def is_us_reporter(citation: str) -> bool:
    """True if the citation is a recognized US reporter citation (``925 F.3d 1339``)."""
    norm = normalize_citation(citation)
    m = _US.fullmatch(norm) or _US.match(norm)
    return bool(m and _canon_us_reporter(m.group(2)))


def _register_paths() -> list[Path]:
    """Bundled register first, then any user-supplied paths from the env var."""
    paths: list[Path] = []
    bundled = DATA_DIR / _BUNDLED_REGISTER
    if bundled.exists():
        paths.append(bundled)
    spec = os.environ.get(LEGAL_AUTHORITIES_ENV, "").strip()
    for part in spec.split(os.pathsep) if spec else []:
        part = part.strip()
        if not part:
            continue
        p = Path(part).expanduser()
        if p.is_dir():
            paths.extend(sorted(p.glob("*.json")))
        elif p.exists():
            paths.append(p)
        else:
            warnings.warn(f"{LEGAL_AUTHORITIES_ENV} path not found: {part}")
    return paths


def load_known_authorities() -> set[str]:
    """Load the set of normalized citations the register vouches for.

    Fail-safe by design: an empty/missing register yields an empty set, which
    makes ``legal_citation_exists`` fail **closed** (it cannot vouch for anything),
    rather than silently passing fabricated citations.
    """
    known: set[str] = set()
    for path in _register_paths():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            warnings.warn(f"could not load legal authorities from {path}: {exc}")
            continue
        for entry in data.get("authorities", []) if isinstance(data, dict) else []:
            cite = entry.get("citation") if isinstance(entry, dict) else None
            if cite:
                known.add(normalize_citation(str(cite)))
    return known
