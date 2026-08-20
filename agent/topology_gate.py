# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Fail-closed gate for PROPOSED belief-graph topology changes (Seam A).

Sophia's runtime epistemic gate (:func:`agent.gate.check_response`) judges an
ANSWER. This module judges a proposed EDIT to the belief graph itself — adding /
removing / rewiring an edge, or removing a node — BEFORE it is admitted. The
question it answers is the structural one the OKF core already knows how to ask:

    "If this change were applied, would the graph become MORE contradictory, would
    a protected-domain belief start laundering confidence, or would a protected
    belief lose its only provenance ground?"

It is a pure, non-destructive function over an in-memory ``okf.graph.Graph``:
``apply_changes`` builds a deep-copied proposed graph (the input graph and its
pages are never mutated), and ``check_topology_change`` diffs the base vs proposed
``contradiction_ledger`` / confidence-laundering / grounding and returns a verdict.

Discipline (mirrors the rest of the gate):

- FAIL-CLOSED / abstain-first. A malformed or unresolvable change is NOT silently
  ignored — it yields ``verdict="abstain"`` (and the verifier maps abstain to
  ``passed=False``: abstain is NOT a pass).
- PROTECTED DOMAINS. ``religion`` and ``history`` mirror ``tools/promote_adapter.py``
  ``DEFAULT_PROTECTED``; a regression touching them is a hard ``violation``.
- NO OVERCLAIMING. Every verdict carries ``candidateOnly=True, canClaimAGI=False``.

Reuse, never reimplement: this leans entirely on ``okf.graph`` (ledger, confidence
propagation, laundering), ``okf.counterfactual`` (``counterfactual_remove`` /
``reduced_without`` / ``is_grounded``) and ``okf.belief_revision_consistency``
(``check_no_orphans_after_retraction``).
"""

from __future__ import annotations

import copy

from okf import wikilinks
from okf.belief_revision_consistency import check_no_orphans_after_retraction
from okf.counterfactual import counterfactual_remove, is_grounded, reduced_without
from okf.graph import (
    LINK_EDGE_KEYS,
    Graph,
    confidence_laundering,
    contradiction_ledger,
    resolve,
)
from okf.schema import as_list

# Verdict schema marker (bump the version if the shape below changes).
SCHEMA = "sophia.topology_gate.v1"

# The protected domains for this gate — mirror tools/promote_adapter.py
# DEFAULT_PROTECTED = ("religion", "history"). A regression in one of these is a
# hard violation, not a warning.
DEFAULT_PROTECTED_DOMAINS = ("religion", "history")

# The promotion-suite name this gate reports under (Seam B — see
# build_promotion_evidence below).
TOPOLOGY_CONSISTENCY_SUITE = "topology_consistency"

# Ledger categories whose INCREASE is a hard structural failure. (The ledger also
# carries declaredContradictions / unsupportedOntologyEdges /
# crossTraditionUnscopedMappings, which are reported but not gated here.)
HARD_FAILURE_CATEGORIES = (
    "selfMerges",
    "traditionMerges",
    "supersedeCycles",
    "confidenceLaundering",
    "subclassCycles",
    "disjointnessViolations",
)

_OPS = ("add_edge", "remove_edge", "remove_node", "rewire")


# --------------------------------------------------------------------------- #
# Change validation + application (pure, non-destructive).
# --------------------------------------------------------------------------- #
def _validate_change(change) -> "list[str]":
    """Return a list of problems with one proposed change (empty == well-formed).

    A change is ``{"op", "src", "dst", "kind", "new_dst"}``. ``kind`` is the
    frontmatter edge key (one of ``okf.graph.LINK_EDGE_KEYS``) the edge lives in;
    it is required for every edge op. Unknown ops / missing fields / unknown edge
    kinds are reported, never silently accepted.
    """
    if not isinstance(change, dict):
        return [f"change is not a mapping: {change!r}"]
    op = change.get("op")
    if op not in _OPS:
        return [f"unknown or missing op: {op!r}"]

    errs: list[str] = []
    src = change.get("src")
    if not isinstance(src, str) or not src:
        errs.append(f"{op}: missing 'src'")

    if op in ("add_edge", "remove_edge", "rewire"):
        kind = change.get("kind")
        if not isinstance(kind, str) or not kind:
            errs.append(f"{op}: missing 'kind'")
        elif kind not in LINK_EDGE_KEYS:
            errs.append(f"{op}: unknown edge kind {kind!r} (allowed: {', '.join(LINK_EDGE_KEYS)})")

    if op in ("add_edge", "remove_edge", "rewire"):
        dst = change.get("dst")
        if not isinstance(dst, str) or not dst:
            errs.append(f"{op}: missing 'dst'")
    if op == "rewire":
        new_dst = change.get("new_dst")
        if not isinstance(new_dst, str) or not new_dst:
            errs.append("rewire: missing 'new_dst'")
    return errs


def _target(graph: Graph, raw: str) -> str:
    """Resolve an edge target to a node id when possible, else its normalized slug
    (edges may legitimately point at a not-yet-present page — a dangling link)."""
    return resolve(graph, raw) or wikilinks.normalize_target(raw)


def apply_changes(graph: Graph, changes) -> Graph:
    """Build a NEW in-memory Graph reflecting the proposed edits.

    The input graph and its pages are never mutated: every node's ``meta`` is
    deep-copied before an edge list is touched (``node["meta"]`` aliases the source
    page's frontmatter, so a naive mutation would corrupt the page). Node removals
    go through :func:`okf.counterfactual.reduced_without`. Raises ``ValueError`` on
    a malformed / unknown-op / unresolvable change — the caller
    (:func:`check_topology_change`) turns that into an abstain, never a silent no-op.
    """
    errors: list[str] = []
    for i, change in enumerate(changes or []):
        for err in _validate_change(change):
            errors.append(f"change[{i}]: {err}")
    if errors:
        raise ValueError("; ".join(errors))

    # Deep-copy every node's meta so edge edits cannot touch the original pages.
    new_nodes = {
        nid: {
            "id": node["id"],
            "pageType": node["pageType"],
            "meta": copy.deepcopy(node["meta"]),
            "page": node["page"],
        }
        for nid, node in graph.nodes.items()
    }
    proposed = Graph(nodes=new_nodes, alias_index=dict(graph.alias_index))

    removed: list[str] = []
    for change in changes or []:
        op = change["op"]
        if op == "remove_node":
            src = resolve(proposed, change["src"])
            if src is None:
                raise ValueError(f"remove_node: src {change['src']!r} does not resolve")
            if src not in removed:
                removed.append(src)
            continue

        src = resolve(proposed, change["src"])
        if src is None or src not in proposed.nodes:
            raise ValueError(f"{op}: src {change['src']!r} does not resolve")
        meta = proposed.nodes[src]["meta"]
        kind = change["kind"]
        existing = as_list(meta.get(kind))

        if op == "add_edge":
            dst = _target(proposed, change["dst"])
            if dst not in existing:
                existing.append(dst)
            meta[kind] = existing
        elif op == "remove_edge":
            dst = _target(proposed, change["dst"])
            meta[kind] = [t for t in existing if _target(proposed, str(t)) != dst]
        elif op == "rewire":
            old = _target(proposed, change["dst"])
            new = _target(proposed, change["new_dst"])
            kept = [t for t in existing if _target(proposed, str(t)) != old]
            if new not in kept:
                kept.append(new)
            meta[kind] = kept

    if removed:
        proposed = reduced_without(proposed, removed)
    return proposed


# --------------------------------------------------------------------------- #
# The gate.
# --------------------------------------------------------------------------- #
def _domain(graph: Graph, nid: str):
    node = graph.nodes.get(nid)
    return node["meta"].get("domain") if node else None


def check_topology_change(graph: Graph, changes, *,
                          protected_domains=DEFAULT_PROTECTED_DOMAINS) -> dict:
    """Gate a proposed set of topology changes (fail-closed, abstain-first).

    Returns a verdict dict (see ``SCHEMA``): ``verdict`` is one of ``"admit"``,
    ``"abstain"``, or ``"violation"``. Priority order:

    1. malformed / unresolvable change  -> ``abstain`` ("unverifiable change");
    2. any hard-failure ledger category INCREASES -> ``violation``;
    3. a protected-domain node newly launders confidence -> ``violation``;
    4. a protected-domain belief loses its support / an uncovered orphan lands in
       a protected domain -> ``violation``;
    5. impact cannot be fully computed (counterfactual raises / node missing)
       -> ``abstain``;
    6. otherwise -> ``admit``.

    A known regression reports ``violation`` even if part of the impact is also
    uncomputable (a proven harm is worse than an unknown one); both still fail the
    verifier. When nothing is proven harmful but something is uncomputable, the
    gate abstains rather than admitting.
    """
    protected = set(protected_domains)
    reasons: list[str] = []
    out: dict = {
        "schema": SCHEMA,
        "candidateOnly": True,
        "canClaimAGI": False,
        "verdict": "abstain",
        "reasons": reasons,
        "protectedRegression": False,
        "newLaundering": [],
        "supportLostProtected": [],
        "orphanInvariantOk": True,
        "ledgerDelta": {},
        "counterfactual": None,
    }

    # 1. Build the proposed graph; a malformed/unresolvable change is unverifiable.
    try:
        proposed = apply_changes(graph, changes)
    except Exception as exc:  # noqa: BLE001 - any apply failure => abstain (fail-closed)
        reasons.append(f"unverifiable change: {exc}")
        out["orphanInvariantOk"] = False
        return out

    violation = False
    abstain = False

    # Base vs proposed structural ledger (diff the hard-failure categories).
    base_ledger = contradiction_ledger(graph)
    prop_ledger = contradiction_ledger(proposed)
    ledger_delta = {
        key: len(prop_ledger.get(key, [])) - len(base_ledger.get(key, []))
        for key in HARD_FAILURE_CATEGORIES
    }
    out["ledgerDelta"] = ledger_delta

    # 2. Any hard-failure category count INCREASES -> violation.
    increased = sorted(k for k in HARD_FAILURE_CATEGORIES if ledger_delta[k] > 0)
    if increased:
        violation = True
        reasons.append(f"structural regression: increase in {', '.join(increased)}")

    # 3. New confidence laundering; a protected-domain node laundering is a violation.
    base_launder = {r["page"] for r in confidence_laundering(graph)}
    prop_launder = {r["page"] for r in confidence_laundering(proposed)}
    new_launder = sorted(prop_launder - base_launder)
    out["newLaundering"] = new_launder
    new_launder_protected = [n for n in new_launder if _domain(proposed, n) in protected]
    if new_launder_protected:
        violation = True
        out["protectedRegression"] = True
        reasons.append(f"new confidence laundering in protected domain: {new_launder_protected}")

    # 4. Removals: orphan invariant + protected support loss.
    removal_targets = [
        ch["src"] for ch in (changes or [])
        if isinstance(ch, dict) and ch.get("op") == "remove_node"
    ]
    cf_summary: dict = {}
    sl_protected: set = set()

    if removal_targets:
        try:
            orphan_report = check_no_orphans_after_retraction(graph, removal_targets)
        except Exception as exc:  # noqa: BLE001 - invariant uncomputable => abstain
            orphan_report = None
            abstain = True
            out["orphanInvariantOk"] = False
            reasons.append(f"orphan invariant uncomputable: {exc}")
        if orphan_report is not None:
            out["orphanInvariantOk"] = bool(orphan_report.get("ok"))
            if orphan_report.get("notFound"):
                abstain = True
                reasons.append(f"removal target(s) did not resolve: {orphan_report['notFound']}")
            uncovered_prot = [o for o in orphan_report.get("uncovered", [])
                              if _domain(graph, o) in protected]
            if uncovered_prot:
                violation = True
                out["protectedRegression"] = True
                reasons.append(f"uncovered orphan(s) in protected domain: {uncovered_prot}")
            elif orphan_report.get("orphans"):
                # Orphans exist but are covered by the abstain-set and none is
                # protected — acceptable; record it so the admit is auditable.
                reasons.append(
                    "note: non-protected orphan(s) covered by abstain-set: "
                    f"{orphan_report['orphans']}"
                )

        for src in removal_targets:
            try:
                cf = counterfactual_remove(graph, src)
            except Exception as exc:  # noqa: BLE001 - counterfactual failed => abstain
                abstain = True
                reasons.append(f"counterfactual uncomputable for {src!r}: {exc}")
                continue
            if not cf.get("found"):
                abstain = True
                reasons.append(f"counterfactual source {src!r} not found")
                continue
            cf_summary[src] = {
                "supportLost": cf.get("supportLost", []),
                "supportLostCount": cf.get("supportLostCount", 0),
                "affectedCount": cf.get("affectedCount", 0),
            }
            for nid in cf.get("supportLost", []):
                if _domain(graph, nid) in protected:
                    sl_protected.add(nid)

    # General grounding diff — catches orphans introduced by remove_edge / rewire
    # (which remove support without removing a node), across every op.
    try:
        for nid in proposed.nodes:
            if is_grounded(graph, nid) and not is_grounded(proposed, nid):
                if _domain(proposed, nid) in protected:
                    sl_protected.add(nid)
    except Exception as exc:  # noqa: BLE001 - grounding diff failed => abstain
        abstain = True
        reasons.append(f"grounding diff uncomputable: {exc}")

    out["supportLostProtected"] = sorted(sl_protected)
    out["counterfactual"] = cf_summary or None
    if sl_protected:
        violation = True
        out["protectedRegression"] = True
        reasons.append(f"support lost in protected domain: {sorted(sl_protected)}")

    # Verdict: a proven regression wins; else abstain on any uncomputable impact;
    # else admit. Never admit when a regression reason was recorded above.
    if violation:
        out["verdict"] = "violation"
    elif abstain:
        out["verdict"] = "abstain"
    else:
        out["verdict"] = "admit"
    return out


# --------------------------------------------------------------------------- #
# Seam A verifier (claim_router / verifiers registry shape).
# --------------------------------------------------------------------------- #
def topology_verifier(text: str, records, context: dict) -> dict:
    """Verifier-shaped wrapper around :func:`check_topology_change`.

    ``context`` (or ``records``) supplies the proposed change set under
    ``"topology_changes"`` and, optionally, an injected ``"graph"`` (for tests) and
    ``"protected_domains"``. With no injected graph it builds one lazily from
    :func:`agent.wiki_store.belief_graph_pages` (imported lazily to avoid an import
    cycle — ``wiki_store`` imports ``agent.verifiers``). Verdict mapping is
    fail-closed: ``admit`` -> ``passed=True``; ``abstain`` and ``violation`` ->
    ``passed=False`` (abstain is NOT a pass). ``detail`` carries the full gate dict.
    """
    context = context if isinstance(context, dict) else {}
    changes = context.get("topology_changes")
    if changes is None and isinstance(records, dict):
        changes = records.get("topology_changes")

    if not changes:
        return {
            "passed": False,
            "reasons": ["no topology_changes provided — proposed edit unverifiable"],
            "detail": {"schema": SCHEMA, "candidateOnly": True, "canClaimAGI": False,
                       "verdict": "abstain"},
        }

    graph = context.get("graph")
    if graph is None:
        try:
            from agent.wiki_store import belief_graph_pages
            from okf.graph import build

            graph = build(belief_graph_pages())
        except Exception as exc:  # noqa: BLE001 - no graph available => fail-closed
            return {
                "passed": False,
                "reasons": [f"belief graph unavailable: {exc}"],
                "detail": {"schema": SCHEMA, "candidateOnly": True, "canClaimAGI": False,
                           "verdict": "abstain"},
            }

    protected = context.get("protected_domains", DEFAULT_PROTECTED_DOMAINS)
    try:
        gate = check_topology_change(graph, changes, protected_domains=protected)
    except Exception as exc:  # noqa: BLE001 - any unexpected failure => fail-closed
        return {
            "passed": False,
            "reasons": [f"topology gate error: {exc}"],
            "detail": {"schema": SCHEMA, "candidateOnly": True, "canClaimAGI": False,
                       "verdict": "abstain"},
        }

    passed = gate["verdict"] == "admit"
    reasons = list(gate.get("reasons") or [])
    if not passed and not reasons:
        reasons = [f"topology gate verdict: {gate['verdict']}"]
    return {"passed": passed, "reasons": reasons, "detail": gate}


# --------------------------------------------------------------------------- #
# Seam B hook — promotion evidence bundle.
# --------------------------------------------------------------------------- #
def build_promotion_evidence(graph: Graph, changes, *,
                             protected_domains=DEFAULT_PROTECTED_DOMAINS) -> dict:
    """A Seam-B-shaped evidence bundle for routing a REAL mutation through the
    plasticity gate later.

    SEAM B (documented, not wired here): ``agent/continual_plasticity.py`` decides
    adapter promotion from a protected-suite evidence bundle. To route a real
    topology mutation through that gate, hand it the bundle below — ``suite`` names
    the protected suite, ``protected`` is True (so a regression forces reject), and
    ``gate_verdict`` carries this gate's admit/abstain/violation. This module does
    NOT edit ``continual_plasticity.py``; it only produces the bundle shape so the
    wiring is a one-line hand-off when a real mutation path exists.
    """
    gate = check_topology_change(graph, changes, protected_domains=protected_domains)
    return {
        "suite": TOPOLOGY_CONSISTENCY_SUITE,
        "protected": True,
        "candidateOnly": True,
        "canClaimAGI": False,
        "gate_verdict": gate["verdict"],
        "artifacts": [{
            "schema": gate["schema"],
            "ledgerDelta": gate["ledgerDelta"],
            "newLaundering": gate["newLaundering"],
            "supportLostProtected": gate["supportLostProtected"],
            "orphanInvariantOk": gate["orphanInvariantOk"],
            "reasons": gate["reasons"],
        }],
        "counterfactual_summary": gate["counterfactual"] or {},
    }


__all__ = [
    "SCHEMA",
    "DEFAULT_PROTECTED_DOMAINS",
    "TOPOLOGY_CONSISTENCY_SUITE",
    "HARD_FAILURE_CATEGORIES",
    "apply_changes",
    "check_topology_change",
    "topology_verifier",
    "build_promotion_evidence",
]
