# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Taint labels for data-flow tracking.

A value's taint is a set of labels describing *where it came from*. Untrusted
sources (retrieved documents, tool output, anything an attacker can influence)
carry ``"untrusted"``. Taint propagates through derivation (``combine``), so a
value computed from any untrusted input is itself untrusted. The firewall reads
these labels to decide whether a value may flow into a sink.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

TRUSTED: frozenset = frozenset()
UNTRUSTED: frozenset = frozenset({"untrusted"})


@dataclass(frozen=True)
class Labeled:
    """A value tagged with a taint set and a short provenance note."""

    value: Any
    taint: frozenset = field(default=TRUSTED)
    origin: str = "?"

    def is_tainted(self) -> bool:
        return bool(self.taint)


def taint_of(x: Any, _depth: int = 0) -> frozenset:
    """The taint of any value — recursively, so a tainted value nested inside a
    list/tuple/set/dict argument is still seen (untracked plain scalars are
    TRUSTED). Depth-bounded to stay safe on deep/cyclic structures.

    Note (honest scope): this finds Labeled values that *survive* into the call.
    It cannot recover taint that was laundered away by ordinary Python (e.g. an
    f-string over ``labeled.value`` yields a plain str). The design contract is
    therefore: keep untrusted data Labeled until the sink. Full propagation comes
    with the M2.2 dual-LLM interpreter, where values never re-enter the planner.
    """
    if isinstance(x, Labeled):
        return x.taint
    if _depth >= 6:
        return TRUSTED
    if isinstance(x, dict):
        out: set = set()
        for k, v in x.items():
            out |= taint_of(k, _depth + 1) | taint_of(v, _depth + 1)
        return frozenset(out)
    if isinstance(x, (list, tuple, set, frozenset)):
        out = set()
        for v in x:
            out |= taint_of(v, _depth + 1)
        return frozenset(out)
    return TRUSTED


def unwrap(x: Any) -> Any:
    return x.value if isinstance(x, Labeled) else x


def combine(*xs: Any) -> frozenset:
    """Union of the taints of all inputs — the propagation rule for derived data."""
    out: set = set()
    for x in xs:
        out |= taint_of(x)
    return frozenset(out)


def untrusted(value: Any, origin: str = "retrieved") -> Labeled:
    """Tag a value as attacker-influenceable (retrieved content, tool output, …)."""
    return Labeled(value, UNTRUSTED, origin)


def trusted(value: Any, origin: str = "user") -> Labeled:
    return Labeled(value, TRUSTED, origin)
