# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Pure-Python SI units engine for the physics verifier (no dependencies).

A physical quantity is ``(value_in_SI, dimension)`` where ``dimension`` is a tuple
of exponents over the seven SI base dimensions ``(kg, m, s, A, K, mol, cd)``. This
is what makes a physics answer *machine-checkable*: ``9.8 J`` is NOT ``9.8 m/s^2``
even though the number matches, because energy and acceleration have different
dimensions. Dimensional analysis is the physics analogue of symbolic equivalence —
a deterministic, judge-free reward seam (the math/code RLVR pattern, extended).

Everything here is stdlib-only and deterministic, so it runs in CI with no GPU and
no optional backend. Unparseable input returns ``ok=False`` (fail-closed) rather
than guessing — callers turn that into a held verdict, never a silent pass.
"""

from __future__ import annotations

import re

# Base dimensions, in order. A dimension vector is a 7-tuple of exponents.
BASE = ("kg", "m", "s", "A", "K", "mol", "cd")
ZERO: tuple[float, ...] = (0.0,) * 7

Dim = "tuple[float, ...]"


def _d(**kw: float) -> tuple[float, ...]:
    """Build a dimension vector from named base exponents (e.g. ``_d(kg=1, m=1, s=-2)``)."""
    return tuple(float(kw.get(b, 0)) for b in BASE)


# Known units → (factor_to_SI, dimension). Derived units are expressed in base SI,
# so dimension checks compose automatically (N·m and J share a dimension).
UNITS: "dict[str, tuple[float, tuple[float, ...]]]" = {
    # Base
    "kg": (1.0, _d(kg=1)), "g": (1e-3, _d(kg=1)),
    "m": (1.0, _d(m=1)), "s": (1.0, _d(s=1)),
    "A": (1.0, _d(A=1)), "K": (1.0, _d(K=1)),
    "mol": (1.0, _d(mol=1)), "cd": (1.0, _d(cd=1)),
    # Derived (named SI)
    "N": (1.0, _d(kg=1, m=1, s=-2)),            # newton
    "J": (1.0, _d(kg=1, m=2, s=-2)),            # joule
    "W": (1.0, _d(kg=1, m=2, s=-3)),            # watt
    "Pa": (1.0, _d(kg=1, m=-1, s=-2)),          # pascal
    "C": (1.0, _d(s=1, A=1)),                   # coulomb
    "V": (1.0, _d(kg=1, m=2, s=-3, A=-1)),      # volt
    "ohm": (1.0, _d(kg=1, m=2, s=-3, A=-2)),    # ohm
    "Ω": (1.0, _d(kg=1, m=2, s=-3, A=-2)),
    "F": (1.0, _d(kg=-1, m=-2, s=4, A=2)),      # farad
    "T": (1.0, _d(kg=1, s=-2, A=-1)),           # tesla
    "Wb": (1.0, _d(kg=1, m=2, s=-2, A=-1)),     # weber
    "H": (1.0, _d(kg=1, m=2, s=-2, A=-2)),      # henry
    "Hz": (1.0, _d(s=-1)),                      # hertz
    "rad": (1.0, ZERO), "sr": (1.0, ZERO),
    # Convenience / non-SI commonly seen in physics answers
    "eV": (1.602176634e-19, _d(kg=1, m=2, s=-2)),
    "min": (60.0, _d(s=1)), "h": (3600.0, _d(s=1)), "hr": (3600.0, _d(s=1)),
    "day": (86400.0, _d(s=1)),
    "L": (1e-3, _d(m=3)),                       # litre
    "atm": (101325.0, _d(kg=1, m=-1, s=-2)),
    "bar": (1e5, _d(kg=1, m=-1, s=-2)),
}

# SI prefixes (applied only when a direct unit lookup fails).
PREFIX: "dict[str, float]" = {
    "Y": 1e24, "Z": 1e21, "E": 1e18, "P": 1e15, "T": 1e12, "G": 1e9, "M": 1e6,
    "k": 1e3, "h": 1e2, "da": 1e1, "d": 1e-1, "c": 1e-2, "m": 1e-3,
    "u": 1e-6, "µ": 1e-6, "μ": 1e-6, "n": 1e-9, "p": 1e-12, "f": 1e-15, "a": 1e-18,
}

# Token: a unit symbol (letters incl. Ω/µ/μ) with an optional ^exponent.
_UNIT_TOK = re.compile(r"([A-Za-zΩµμ]+)(?:\^?(-?\d+(?:\.\d+)?|-?\(\d+/\d+\)))?$")

# A fractional exponent written as ^<int>/<int>, optionally parenthesized:
# ``s^(1/2)`` or ``s^1/2`` or ``s^(-1/2)``. This is folded to a decimal *before*
# parse_unit strips parens and splits on '/', so the inner '/' is not mistaken
# for a quotient group. (Root cause of the pre-fix bug: the paren-strip ran
# first, turning ``s^(1/2)`` into ``s^ 1/2 `` and splitting it into two tokens.)
# Restricted to integer numerator/denominator on purpose: float fractions like
# ``0.5`` already parse, and a loose ``[^/]+/[^/]+`` would greedily fold a real
# quotient such as ``m^1/s^2`` into a single bogus exponent.
#
# Two mutually-exclusive shapes only, each with a single optional sign per
# operand: a *fully* parenthesized fraction ``^(<int>/<int>)`` OR a bare
# ``^<int>/<int>``. This deliberately rejects an unbalanced ``^(1/2`` or a
# trailing-``)`` half-paren so those malformed inputs are never folded and fall
# through to the fail-closed token check. ``-?\d+`` (not ``-*\d+``) also blocks a
# double-sign operand like ``--1``.
_FRAC_EXP = re.compile(r"\^(?:\((-?\d+/-?\d+)\)|(-?\d+/-?\d+))")


def same_dim(a: "tuple[float, ...]", b: "tuple[float, ...]", *, tol: float = 1e-9) -> bool:
    """True iff two dimension vectors are equal (within float tolerance)."""
    return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))


def format_dim(dim: "tuple[float, ...]") -> str:
    """Human-readable base-SI signature, e.g. ``kg·m²·s⁻²`` → ``kg·m^2·s^-2``."""
    parts = [f"{b}^{e:g}" if e not in (1.0,) else b for b, e in zip(BASE, dim) if e != 0]
    return "·".join(parts) if parts else "dimensionless"


def _parse_exp(s: "str | None") -> float:
    if not s:
        return 1.0
    s = s.strip("()")
    if "/" in s:
        num, den = s.split("/", 1)
        return float(num) / float(den)
    return float(s)


def _frac_to_decimal(m: "re.Match[str]") -> str:
    """Replacer for ``_FRAC_EXP``: fold ``^(1/2)`` → ``^0.5``.

    The captured exponent group (parenthesized in group 1, bare in group 2) is
    evaluated as a fraction and re-emitted as a decimal so the rest of
    ``parse_unit`` sees no parentheses and no inner ``/``. Called before the
    paren strip and group split, so the ``/`` inside the exponent never reaches
    ``s.split('/')``.

    Fail-closed: if the fraction cannot be converted (e.g. a zero denominator
    ``s^(1/0)`` → ``ZeroDivisionError``, or a malformed operand → ``ValueError``),
    the original matched text is returned unchanged so the downstream
    ``_UNIT_TOK`` check rejects it and ``parse_unit`` returns ``ok=False`` — the
    substitution never raises out of ``re.sub``.
    """
    frac = m.group(1) or m.group(2)
    try:
        return f"^{_parse_exp(frac)}"
    except (ValueError, ZeroDivisionError):
        return m.group(0)


def _resolve(name: str) -> "tuple[float, tuple[float, ...]] | None":
    """Resolve a unit symbol to (factor, dim), trying SI prefixes on a miss."""
    if name in UNITS:
        return UNITS[name]
    for plen in (2, 1):  # 'da' is the only two-char prefix
        if len(name) > plen and name[:plen] in PREFIX:
            base = name[plen:]
            if base in UNITS:
                f, dim = UNITS[base]
                return (PREFIX[name[:plen]] * f, dim)
    return None


def parse_unit(text: str) -> "tuple[bool, float, tuple[float, ...]]":
    """Parse a unit expression like ``kg*m/s^2`` → ``(ok, factor_to_SI, dim)``.

    Supports ``* · × /`` for products/quotients, ``^`` or ``**`` for exponents,
    whitespace as implicit multiply, SI prefixes, and a leading ``/`` denominator
    group. ``''``/``'1'`` is dimensionless. Returns ``ok=False`` on any unknown
    symbol (fail-closed).
    """
    s = (text or "").strip()
    if s in ("", "1", "dimensionless"):
        return (True, 1.0, ZERO)
    s = s.replace("·", "*").replace("×", "*").replace("⋅", "*")
    s = s.replace("**", "^")
    # Fold fractional exponents (^1/2, ^(1/2), ^(-1/2)) to decimals BEFORE the
    # paren strip and '/' group split below. Otherwise paren-stripping turns
    # 's^(1/2)' into 's^ 1/2 ' and the group split breaks it into junk tokens.
    s = _FRAC_EXP.sub(_frac_to_decimal, s)
    s = s.replace("(", " ").replace(")", " ")
    groups = s.split("/")
    factor = 1.0
    dim = [0.0] * 7
    for gi, group in enumerate(groups):
        sign = 1.0 if gi == 0 else -1.0
        for tok in re.split(r"[*\s]+", group.strip()):
            if not tok:
                continue
            m = _UNIT_TOK.fullmatch(tok)
            if not m:
                return (False, 1.0, ZERO)
            resolved = _resolve(m.group(1))
            if resolved is None:
                return (False, 1.0, ZERO)
            f, ud = resolved
            exp = sign * _parse_exp(m.group(2))
            factor *= f ** exp
            for i in range(7):
                dim[i] += ud[i] * exp
    return (True, factor, tuple(dim))


# A number, optionally in scientific form, possibly followed by a unit expression.
_SCI = re.compile(r"([+-]?\d+\.?\d*(?:[eE][+-]?\d+)?)\s*(?:[×x*·])\s*10\s*\^?\s*([+-]?\d+)")
_NUM = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")


def parse_quantity(text: str) -> "tuple[bool, float, tuple[float, ...]]":
    """Parse ``9.8 m/s^2`` / ``3.0 × 10^8 m/s`` / ``50`` → ``(ok, value_in_SI, dim)``.

    A bare number is dimensionless (``dim = ZERO``). Returns ``ok=False`` when there
    is no leading number or the trailing unit does not parse (fail-closed).
    """
    s = (text or "").strip().replace(",", "")
    # Normalize "3.0 × 10^8" → "3.0e8" before reading the number.
    s = _SCI.sub(lambda m: f"{m.group(1)}e{m.group(2)}", s)
    nm = _NUM.match(s)
    if not nm:
        return (False, 0.0, ZERO)
    value = float(nm.group(0))
    unit_str = s[nm.end():].strip()
    ok, factor, dim = parse_unit(unit_str) if unit_str else (True, 1.0, ZERO)
    if not ok:
        return (False, 0.0, ZERO)
    return (True, value * factor, dim)
