# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Strict, workspace-bound JSON flowchart compiler for Sophia TUI workflows.

The chart is deliberately a small data contract.  It describes task and
all-of-join nodes plus directed edges; it never describes a shell command,
tool invocation, executable, or provider.  The kernel owns execution and
the TUI receives only the bounded, secret-free topology projection.

This module is intentionally independent from the dynamic-workflow planner.
That keeps file validation deterministic and makes it possible to prove that a
selected chart, rather than a planner-invented pattern, supplied the runtime
topology.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping


FLOWCHART_SCHEMA = "sophia.tui.flowchart.v1"
MAX_CHART_BYTES = 512 * 1024
MAX_NODES = 64
MAX_EDGES = 128
MAX_NODE_ID_CHARS = 96
MAX_LABEL_CHARS = 180
MAX_TASK_CHARS = 4_000
MAX_ROLE_CHARS = 120
MAX_CRITERIA = 8
MAX_CRITERION_CHARS = 300
MAX_OUTPUT_CHARS = 1_200
NODE_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,95}$")

_TOP_LEVEL_FIELDS = frozenset({"schema", "id", "name", "nodes", "edges"})
_NODE_FIELDS = frozenset(
    {
        "id",
        "label",
        "task",
        "kind",
        "role",
        "doneCriteria",
        "expectedOutput",
        "join",
        "recoveryOf",
    }
)
_EDGE_FIELDS = frozenset({"id", "from", "to", "kind"})
_FORBIDDEN_TERMS = frozenset(
    {
        "command",
        "commands",
        "exec",
        "executor",
        "executable",
        "shell",
        "script",
        "tool",
        "tools",
        "process",
        "argv",
    }
)


class FlowchartError(ValueError):
    """Raised when a chart cannot be proven safe and structurally complete."""


def _bounded_string(
    value: Any,
    *,
    field: str,
    maximum: int,
    required: bool = True,
) -> str:
    if not isinstance(value, str):
        if required:
            raise FlowchartError(f"{field} must be a string")
        return ""
    text = " ".join(value.split())
    if required and not text:
        raise FlowchartError(f"{field} must be non-empty")
    if len(text) > maximum:
        raise FlowchartError(f"{field} exceeds {maximum} characters")
    return text


def _reject_unknown(value: Mapping[str, Any], allowed: Iterable[str], field: str) -> None:
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        raise FlowchartError(
            f"{field} has unsupported field(s): {', '.join(unknown)}"
        )


def _reject_forbidden_keys(value: Mapping[str, Any], field: str) -> None:
    forbidden = sorted(
        key
        for key in value
        if str(key).casefold() in _FORBIDDEN_TERMS
    )
    if forbidden:
        raise FlowchartError(
            f"{field} contains forbidden execution field(s): "
            + ", ".join(forbidden)
        )


def _string_list(
    value: Any,
    *,
    field: str,
    maximum_items: int,
    item_maximum: int,
) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise FlowchartError(f"{field} must be an array")
    if len(value) > maximum_items:
        raise FlowchartError(f"{field} exceeds {maximum_items} entries")
    result: list[str] = []
    for index, item in enumerate(value):
        text = _bounded_string(
            item,
            field=f"{field}[{index}]",
            maximum=item_maximum,
        )
        if text not in result:
            result.append(text)
    return tuple(result)


@dataclass(frozen=True)
class FlowchartNode:
    id: str
    label: str
    task: str
    kind: str
    role: str
    done_criteria: tuple[str, ...]
    expected_output: str
    join: str
    recovery_of: str
    level: int
    stage: int | None
    predecessor_ids: tuple[str, ...]
    successor_ids: tuple[str, ...]

    @property
    def executable(self) -> bool:
        return self.kind != "join"

    def to_projection(self) -> dict[str, Any]:
        """Return the secret-free node shape sent to the TUI/manifest."""
        return {
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "stage": self.stage,
            "join": self.join,
            "predecessorIds": list(self.predecessor_ids),
            "successorIds": list(self.successor_ids),
        }


@dataclass(frozen=True)
class FlowchartEdge:
    id: str
    source: str
    target: str
    kind: str

    def to_projection(self) -> dict[str, str]:
        return {
            "id": self.id,
            "from": self.source,
            "to": self.target,
            "kind": self.kind,
        }


@dataclass(frozen=True)
class CompiledFlowchart:
    schema: str
    chart_id: str
    source_path: str
    source_digest: str
    topology_digest: str
    nodes: tuple[FlowchartNode, ...]
    edges: tuple[FlowchartEdge, ...]
    waves: tuple[tuple[str, ...], ...]

    @property
    def executable_nodes(self) -> tuple[FlowchartNode, ...]:
        return tuple(node for node in self.nodes if node.executable)

    @property
    def node_by_id(self) -> dict[str, FlowchartNode]:
        return {node.id: node for node in self.nodes}

    def node(self, node_id: str) -> FlowchartNode:
        try:
            return self.node_by_id[node_id]
        except KeyError as exc:
            raise FlowchartError(f"compiled chart has no node {node_id!r}") from exc

    def to_event(self) -> dict[str, Any]:
        """Return a bounded topology payload safe for bridge/TUI events."""
        return {
            "schema": self.schema,
            "id": self.chart_id,
            "sourcePath": self.source_path,
            "sourceDigest": self.source_digest,
            "topologyDigest": self.topology_digest,
            "nodes": [node.to_projection() for node in self.nodes],
            "edges": [edge.to_projection() for edge in self.edges],
        }

    def to_manifest(self) -> dict[str, Any]:
        """Return a compact durable manifest record with no task bodies."""
        return {
            "schema": self.schema,
            "id": self.chart_id,
            "sourcePath": self.source_path,
            "sourceDigest": self.source_digest,
            "topologyDigest": self.topology_digest,
            "nodeIds": [node.id for node in self.nodes],
            "edgeIds": [edge.id for edge in self.edges],
            "edges": [edge.to_projection() for edge in self.edges],
            "waves": [list(wave) for wave in self.waves],
        }


def _canonical_topology(
    *,
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> str:
    # The source digest already fingerprints the complete file.  Keep the
    # topology digest structural so changing task prose, labels, roles, or
    # output guidance does not make an unchanged graph look like a different
    # dispatch shape.  Sorting also makes equivalent JSON with reordered
    # arrays produce the same digest.
    structural_nodes = sorted(
        (
            {
                "id": str(node["id"]),
                "kind": str(node["kind"]),
                "join": str(node["join"]),
            }
            for node in nodes
        ),
        key=lambda node: node["id"],
    )
    structural_edges = sorted(
        (
            {
                "id": str(edge["id"]),
                "from": str(edge["from"]),
                "to": str(edge["to"]),
                "kind": str(edge["kind"]),
            }
            for edge in edges
        ),
        key=lambda edge: edge["id"],
    )
    encoded = json.dumps(
        {
            "schema": FLOWCHART_SCHEMA,
            "nodes": structural_nodes,
            "edges": structural_edges,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def compile_flowchart_document(
    document: Mapping[str, Any],
    *,
    source_path: str = "",
    source_digest: str = "",
) -> CompiledFlowchart:
    """Validate and compile one already-decoded chart document."""
    if not isinstance(document, Mapping):
        raise FlowchartError("flowchart root must be an object")
    _reject_forbidden_keys(document, "flowchart")
    _reject_unknown(document, _TOP_LEVEL_FIELDS, "flowchart")
    schema = _bounded_string(
        document.get("schema"),
        field="flowchart.schema",
        maximum=80,
    )
    if schema != FLOWCHART_SCHEMA:
        raise FlowchartError(
            f"unsupported flowchart schema {schema!r}; expected {FLOWCHART_SCHEMA}"
        )
    chart_id = _bounded_string(
        document.get("id"),
        field="flowchart.id",
        maximum=MAX_NODE_ID_CHARS,
    )
    if not NODE_ID_RE.fullmatch(chart_id):
        raise FlowchartError("flowchart.id is not a safe identifier")
    raw_nodes = document.get("nodes")
    raw_edges = document.get("edges")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise FlowchartError("flowchart.nodes must be a non-empty array")
    if len(raw_nodes) > MAX_NODES:
        raise FlowchartError(f"flowchart.nodes exceeds {MAX_NODES} entries")
    if not isinstance(raw_edges, list):
        raise FlowchartError("flowchart.edges must be an array")
    if len(raw_edges) > MAX_EDGES:
        raise FlowchartError(f"flowchart.edges exceeds {MAX_EDGES} entries")

    node_rows: list[dict[str, Any]] = []
    node_ids: set[str] = set()
    node_by_id: dict[str, dict[str, Any]] = {}
    for index, raw_node in enumerate(raw_nodes):
        field = f"flowchart.nodes[{index}]"
        if not isinstance(raw_node, Mapping):
            raise FlowchartError(f"{field} must be an object")
        _reject_forbidden_keys(raw_node, field)
        _reject_unknown(raw_node, _NODE_FIELDS, field)
        node_id = _bounded_string(
            raw_node.get("id"),
            field=f"{field}.id",
            maximum=MAX_NODE_ID_CHARS,
        )
        if not NODE_ID_RE.fullmatch(node_id):
            raise FlowchartError(f"{field}.id is not a safe identifier")
        if node_id in node_ids:
            raise FlowchartError(f"duplicate flowchart node id {node_id!r}")
        node_ids.add(node_id)
        kind = _bounded_string(
            raw_node.get("kind", "task"),
            field=f"{field}.kind",
            maximum=32,
        ).casefold()
        # Recovery is intentionally not part of v1 execution semantics.  A
        # recovery node needs an explicit trigger/attempt contract; treating
        # it as an ordinary topological task would dispatch it unconditionally
        # and could hide a failed predecessor behind a "recovery" label.
        if kind not in {"task", "join"}:
            raise FlowchartError(
                f"{field}.kind must be task or join; recovery nodes are "
                "unsupported until trigger semantics are defined"
            )
        label = _bounded_string(
            raw_node.get("label", node_id),
            field=f"{field}.label",
            maximum=MAX_LABEL_CHARS,
        )
        task = _bounded_string(
            raw_node.get("task", ""),
            field=f"{field}.task",
            maximum=MAX_TASK_CHARS,
            required=kind != "join",
        )
        role = _bounded_string(
            raw_node.get("role", ""),
            field=f"{field}.role",
            maximum=MAX_ROLE_CHARS,
            required=False,
        )
        done_criteria = _string_list(
            raw_node.get("doneCriteria"),
            field=f"{field}.doneCriteria",
            maximum_items=MAX_CRITERIA,
            item_maximum=MAX_CRITERION_CHARS,
        )
        expected_output = _bounded_string(
            raw_node.get("expectedOutput", ""),
            field=f"{field}.expectedOutput",
            maximum=MAX_OUTPUT_CHARS,
            required=False,
        )
        join = _bounded_string(
            raw_node.get("join", ""),
            field=f"{field}.join",
            maximum=32,
            required=False,
        ).casefold()
        if kind == "join" and join != "all-of":
            raise FlowchartError(
                f"{field}.join must be 'all-of' for join nodes"
            )
        if kind != "join" and join:
            raise FlowchartError(f"{field}.join is only valid for join nodes")
        recovery_of = _bounded_string(
            raw_node.get("recoveryOf", ""),
            field=f"{field}.recoveryOf",
            maximum=MAX_NODE_ID_CHARS,
            required=False,
        )
        if recovery_of:
            raise FlowchartError(
                f"{field}.recoveryOf is unsupported; recovery triggers are "
                "not defined for flowchart v1"
            )
        if recovery_of and not NODE_ID_RE.fullmatch(recovery_of):
            raise FlowchartError(f"{field}.recoveryOf is not a safe identifier")
        normalized = {
            "id": node_id,
            "label": label,
            "task": task,
            "kind": kind,
            "role": role,
            "doneCriteria": list(done_criteria),
            "expectedOutput": expected_output,
            "join": join,
            "recoveryOf": recovery_of,
        }
        node_rows.append(normalized)
        node_by_id[node_id] = normalized

    edge_rows: list[dict[str, str]] = []
    edge_ids: set[str] = set()
    edge_pairs: set[tuple[str, str]] = set()
    predecessors: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    successors: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    for index, raw_edge in enumerate(raw_edges):
        field = f"flowchart.edges[{index}]"
        if not isinstance(raw_edge, Mapping):
            raise FlowchartError(f"{field} must be an object")
        _reject_forbidden_keys(raw_edge, field)
        _reject_unknown(raw_edge, _EDGE_FIELDS, field)
        source = _bounded_string(
            raw_edge.get("from"),
            field=f"{field}.from",
            maximum=MAX_NODE_ID_CHARS,
        )
        target = _bounded_string(
            raw_edge.get("to"),
            field=f"{field}.to",
            maximum=MAX_NODE_ID_CHARS,
        )
        if source not in node_ids or target not in node_ids:
            raise FlowchartError(
                f"{field} references an unknown endpoint: {source!r} -> {target!r}"
            )
        if source == target:
            raise FlowchartError(f"{field} cannot be a self-edge")
        pair = (source, target)
        if pair in edge_pairs:
            raise FlowchartError(f"duplicate flowchart edge {source!r} -> {target!r}")
        edge_pairs.add(pair)
        edge_id = _bounded_string(
            raw_edge.get("id", f"{source}-to-{target}"),
            field=f"{field}.id",
            maximum=MAX_NODE_ID_CHARS * 2,
        )
        if not NODE_ID_RE.fullmatch(edge_id):
            raise FlowchartError(f"{field}.id is not a safe identifier")
        if edge_id in edge_ids:
            raise FlowchartError(f"duplicate flowchart edge id {edge_id!r}")
        edge_ids.add(edge_id)
        kind = _bounded_string(
            raw_edge.get("kind", "control"),
            field=f"{field}.kind",
            maximum=32,
        ).casefold()
        if kind != "control":
            raise FlowchartError(
                f"{field}.kind must be control; recovery edges are "
                "unsupported until trigger semantics are defined"
            )
        edge_rows.append(
            {
                "id": edge_id,
                "from": source,
                "to": target,
                "kind": kind,
            }
        )
        predecessors[target].append(source)
        successors[source].append(target)

    for node_id, row in node_by_id.items():
        if row["kind"] == "join" and len(predecessors[node_id]) < 1:
            raise FlowchartError(
                f"join node {node_id!r} must have at least one predecessor"
            )
        if row["recoveryOf"] and row["recoveryOf"] not in node_ids:
            raise FlowchartError(
                f"node {node_id!r} recoveryOf references unknown node "
                f"{row['recoveryOf']!r}"
            )

    # Kahn's algorithm gives both cycle rejection and deterministic levels.
    indegree = {node_id: len(predecessors[node_id]) for node_id in node_ids}
    ready = sorted(node_id for node_id, degree in indegree.items() if degree == 0)
    topo: list[str] = []
    while ready:
        current = ready.pop(0)
        topo.append(current)
        for target in sorted(successors[current]):
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
                ready.sort()
    if len(topo) != len(node_ids):
        raise FlowchartError("flowchart graph contains a cycle")

    levels: dict[str, int] = {}
    for node_id in topo:
        parents = predecessors[node_id]
        levels[node_id] = (
            0
            if not parents
            else max(levels[parent] + 1 for parent in parents)
        )

    executable_count = sum(
        1 for row in node_rows if row["kind"] != "join"
    )
    if executable_count < 2:
        raise FlowchartError(
            "flowchart must contain at least two executable task/recovery nodes"
        )

    # Join nodes are graph barriers, not provider tasks.  They still advance
    # the topological level so successors cannot enter the same dispatch wave
    # as their predecessors.
    executable_levels = sorted(
        {
            levels[row["id"]]
            for row in node_rows
            if row["kind"] != "join"
        }
    )
    stage_for_level = {
        level: index + 1
        for index, level in enumerate(executable_levels)
    }
    waves: list[tuple[str, ...]] = []
    for level in executable_levels:
        wave = tuple(
            row["id"]
            for row in node_rows
            if row["kind"] != "join"
            and levels[row["id"]] == level
        )
        if wave:
            waves.append(wave)

    nodes = tuple(
        FlowchartNode(
            id=row["id"],
            label=row["label"],
            task=row["task"],
            kind=row["kind"],
            role=row["role"],
            done_criteria=tuple(row["doneCriteria"]),
            expected_output=row["expectedOutput"],
            join=row["join"],
            recovery_of=row["recoveryOf"],
            level=levels[row["id"]],
            stage=(
                stage_for_level[levels[row["id"]]]
                if row["kind"] != "join"
                else None
            ),
            predecessor_ids=tuple(sorted(predecessors[row["id"]])),
            successor_ids=tuple(sorted(successors[row["id"]])),
        )
        for row in node_rows
    )
    edges = tuple(
        FlowchartEdge(
            id=row["id"],
            source=row["from"],
            target=row["to"],
            kind=row["kind"],
        )
        for row in edge_rows
    )
    return CompiledFlowchart(
        schema=FLOWCHART_SCHEMA,
        chart_id=chart_id,
        source_path=" ".join(str(source_path or "").split()),
        source_digest=str(source_digest or ""),
        topology_digest=_canonical_topology(
            nodes=node_rows,
            edges=edge_rows,
        ),
        nodes=nodes,
        edges=edges,
        waves=tuple(waves),
    )


def load_flowchart(
    path: str | Path,
    *,
    workspace: str | Path,
) -> CompiledFlowchart:
    """Read and compile a JSON chart only when it stays inside ``workspace``."""
    root = Path(workspace).expanduser().resolve()
    raw_path = Path(path).expanduser()
    candidate = raw_path if raw_path.is_absolute() else root / raw_path
    try:
        resolved = candidate.resolve()
    except OSError as exc:
        raise FlowchartError(f"could not resolve flowchart path: {exc}") from exc
    try:
        relative = resolved.relative_to(root)
    except ValueError as exc:
        raise FlowchartError("flowchart path must stay inside the workspace") from exc
    if not resolved.is_file():
        raise FlowchartError(f"flowchart file not found: {relative.as_posix()}")
    try:
        data = resolved.read_bytes()
    except OSError as exc:
        raise FlowchartError(f"could not read flowchart file: {exc}") from exc
    if len(data) > MAX_CHART_BYTES:
        raise FlowchartError(
            f"flowchart file exceeds {MAX_CHART_BYTES} bytes"
        )
    digest = hashlib.sha256(data).hexdigest()
    try:
        document = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FlowchartError(f"flowchart JSON is invalid: {exc}") from exc
    return compile_flowchart_document(
        document,
        source_path=relative.as_posix(),
        source_digest=digest,
    )


__all__ = [
    "CompiledFlowchart",
    "FLOWCHART_SCHEMA",
    "FlowchartEdge",
    "FlowchartError",
    "FlowchartNode",
    "MAX_EDGES",
    "MAX_NODES",
    "compile_flowchart_document",
    "load_flowchart",
]
