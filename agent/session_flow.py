# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""sophia.session-flow.v1 projector.

This module is a projector only. It does not invent workflow semantics,
dispatch work, or upgrade claim fields. Nested and parallel agentic
workflows are grouped from dispatch + folder ledger + visual receipts.
sessiond/backend success never paints visual success.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Mapping

SCHEMA = "sophia.session-flow.v1"
MAX_NODES = 64
MAX_EDGES = 128

SEMANTIC_ROLES = frozenset(
    {
        "input-prompt",
        "main-plan-dispatch",
        "specialist-lane",
        "workflow-worker",
        "parallel-barrier",
        "synthesis-main",
        "output-receipt",
        "recovery-lane",
        "critic-review",
    }
)
NODE_STATUSES = frozenset(
    {
        "pending",
        "queued",
        "running",
        "waiting",
        "succeeded",
        "failed",
        "blocked",
        "cancelled",
        "skipped",
        "unknown",
    }
)
EDGE_KINDS = frozenset({"sequence", "contains", "handoff", "fan-out", "fan-in"})
_WF_FOLDER_RE = re.compile(r"(?:^|/)(wf-[a-z0-9-]+)(?:/|$)", re.IGNORECASE)
_SECRET_RE = re.compile(
    r"(?i)(api[_-]?key|secret|password|token|authorization)\s*[:=]\s*\S+"
)

_DEFAULT_CLAIMS = {
    "candidateOnly": True,
    "canClaimAGI": False,
    "validatedUplift": None,
    "productGo": False,
}

_FAILED_LIKE = frozenset(
    {
        "failed",
        "timed_out",
        "timeout",
        "lost",
        "needs_reconciliation",
        "unstarted",
        "never_started",
        "not-dispatched",
        "not_dispatched",
        "stage_no_usable_reports",
        "planning-failed",
        "planning_failed",
        "receipt_mismatch",
    }
)


def copy_claims(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    """Copy claim fields. Never upgrade a missing or non-true value."""

    data = raw if isinstance(raw, Mapping) else {}
    uplift = data.get("validatedUplift")
    if uplift is True:
        validated: bool | None = True
    elif uplift is False:
        validated = False
    else:
        validated = None
    return {
        "candidateOnly": data.get("candidateOnly") is True,
        "canClaimAGI": data.get("canClaimAGI") is True,
        "validatedUplift": validated,
        "productGo": data.get("productGo") is True,
    }


def workflow_id_from_folder(folder_path: Any) -> str | None:
    if not isinstance(folder_path, str) or not folder_path.strip():
        return None
    match = _WF_FOLDER_RE.search(folder_path.strip())
    if not match:
        return None
    return match.group(1).lower()


def attach_workflow(node: Mapping[str, Any]) -> dict[str, Any]:
    row = dict(node)
    workflow_id = row.get("workflowId") or workflow_id_from_folder(row.get("folderPath"))
    if not workflow_id:
        row.pop("workflowId", None)
        return row
    row["workflowId"] = str(workflow_id)
    if not row.get("workflowLabel"):
        suffix = str(workflow_id)[3:] if str(workflow_id).lower().startswith("wf-") else str(workflow_id)
        row["workflowLabel"] = f"Agentic workflow {suffix.upper()}"
    return row


def _clean_text(value: Any, limit: int) -> str:
    text = _SECRET_RE.sub("[redacted]", str(value or ""))
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _status(value: Any, *, default: str = "pending") -> str:
    raw = str(value or "").strip().casefold().replace("-", "_")
    if raw in NODE_STATUSES:
        return raw
    if raw in _FAILED_LIKE or raw in {"429", "error"}:
        return "failed"
    if raw in {"dispatching", "spawning", "working", "verifying"}:
        return "running"
    if raw in {"queued_for_model", "submitted"}:
        return "queued"
    if raw in {"waiting_input"}:
        return "waiting"
    if raw in {"canceled"}:
        return "cancelled"
    if raw in {"complete", "completed", "ok", "success"}:
        return "succeeded"
    if raw in {"idle", "planning"}:
        return default
    return default if default in NODE_STATUSES else "unknown"


def _role(value: Any) -> str | None:
    raw = str(value or "").strip()
    return raw if raw in SEMANTIC_ROLES else None


def _infer_role(item: Mapping[str, Any]) -> str:
    explicit = _role(item.get("semanticRole") or item.get("role"))
    if explicit:
        return explicit
    title = str(item.get("title") or item.get("name") or "").strip().lower()
    if item.get("parentId") or item.get("parentAssignmentId"):
        return "workflow-worker"
    if title.startswith("input"):
        return "input-prompt"
    if title.startswith("output"):
        return "output-receipt"
    if "barrier" in title or "all-of" in title or title == "join" or title.endswith(" · all-of"):
        return "parallel-barrier"
    if "synthesis" in title or title == "synth" or title.startswith("synthesize"):
        return "synthesis-main"
    if "main" in title and "dispatch" in title:
        return "main-plan-dispatch"
    if "critic" in title or "review" in title:
        return "critic-review"
    if "recover" in title:
        return "recovery-lane"
    return "specialist-lane"


def empty_snapshot(*, claims: Mapping[str, Any] | None = None) -> dict[str, Any]:
    copied = copy_claims(claims) if claims is not None else dict(_DEFAULT_CLAIMS)
    if claims is None:
        copied = dict(_DEFAULT_CLAIMS)
    return {
        "schema": SCHEMA,
        "nodes": [],
        "edges": [],
        "claims": copied,
        "terminalReceipt": False,
        "completedWorkflow": False,
        "overflowWarning": None,
        "barrierTally": {
            "barrierId": "barrier",
            "have": 0,
            "need": 0,
            "caption": "",
        },
    }


def is_terminal_output(node: Mapping[str, Any]) -> bool:
    return node.get("semanticRole") == "output-receipt" and not node.get("workflowId")


def finalize(snap: Mapping[str, Any]) -> dict[str, Any]:
    nodes = [dict(node) for node in list(snap.get("nodes") or [])]
    edges = [dict(edge) for edge in list(snap.get("edges") or [])]
    term = next((node for node in nodes if is_terminal_output(node)), None)
    barrier = next(
        (
            node
            for node in nodes
            if node.get("semanticRole") == "parallel-barrier" and not node.get("workflowId")
        ),
        None,
    )
    all_wf_outs = [
        node
        for node in nodes
        if node.get("semanticRole") == "output-receipt" and node.get("workflowId")
    ]
    have = sum(1 for node in all_wf_outs if node.get("status") == "succeeded")
    need = len(all_wf_outs)
    if need == 0 and barrier is not None:
        by_id = {str(node.get("id") or ""): node for node in nodes}
        sources = [
            str(edge.get("from") or "")
            for edge in edges
            if str(edge.get("to") or "") == str(barrier.get("id") or "")
            and str(edge.get("kind") or "") == "fan-in"
        ]
        sources = [source for source in sources if source in by_id]
        if sources:
            have = sum(
                1 for source in sources if by_id[source].get("status") == "succeeded"
            )
            need = len(sources)
    reason = str((barrier or {}).get("reasonCode") or "")
    parallel_ok = (
        barrier is not None
        and barrier.get("status") == "succeeded"
        and have == need
        and need > 0
    )
    single_ok = (
        need == 0
        and term is not None
        and term.get("status") == "succeeded"
        and (barrier is None or barrier.get("status") == "succeeded")
    )
    completed = (
        (parallel_ok if need > 0 else single_ok)
        and term is not None
        and term.get("status") == "succeeded"
    )
    if need == 0:
        caption = ""
    elif parallel_ok:
        caption = f"{have}/{need} workflow receipts"
    elif reason in {"visual_timeout", "receipt_mismatch"}:
        caption = f"{have}/{need} timed out"
    else:
        caption = f"{have}/{need} workflow receipts"
    out = dict(snap)
    out["schema"] = SCHEMA
    out["nodes"] = nodes
    out["edges"] = edges
    out["claims"] = copy_claims(snap.get("claims") if isinstance(snap.get("claims"), Mapping) else None)
    if snap.get("claims") is None:
        out["claims"] = dict(_DEFAULT_CLAIMS)
    out["terminalReceipt"] = completed is True
    out["completedWorkflow"] = completed is True
    out["barrierTally"] = {
        "barrierId": str((barrier or {}).get("id") or "barrier"),
        "have": have,
        "need": need,
        "caption": caption,
    }
    return out


def _node(
    *,
    node_id: str,
    title: str,
    role: str,
    status: str,
    **extra: Any,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": _clean_text(node_id, 96) or "node",
        "title": _clean_text(title, 180) or role,
        "semanticRole": role if role in SEMANTIC_ROLES else "specialist-lane",
        "status": _status(status),
    }
    detail = extra.pop("detail", None)
    if detail:
        row["detail"] = _clean_text(detail, 240)
    for key in (
        "stageIndex",
        "workerIndex",
        "folderPath",
        "provider",
        "model",
        "progress",
        "reasonCode",
        "started",
        "workflowId",
        "workflowLabel",
        "parentId",
    ):
        if extra.get(key) is not None and extra.get(key) != "":
            row[key] = extra[key]
    if "progress" in row:
        try:
            progress = float(row["progress"])
        except (TypeError, ValueError):
            row.pop("progress", None)
        else:
            row["progress"] = max(0.0, min(1.0, progress))
    return attach_workflow(row)


def _edge(edge_id: str, source: str, target: str, kind: str) -> dict[str, str]:
    return {
        "id": _clean_text(edge_id, 160) or f"{source}->{target}",
        "from": source,
        "to": target,
        "kind": kind if kind in EDGE_KINDS else "sequence",
    }


def _apply_visual_receipts(
    nodes: list[dict[str, Any]],
    receipts: Iterable[Mapping[str, Any]] | None,
) -> None:
    by_id = {node["id"]: node for node in nodes}
    for raw in receipts or []:
        if not isinstance(raw, Mapping):
            continue
        target = None
        node_id = str(raw.get("id") or raw.get("nodeId") or "")
        if node_id and node_id in by_id:
            target = by_id[node_id]
        elif raw.get("workflowId") and raw.get("semanticRole"):
            target = next(
                (
                    node
                    for node in nodes
                    if node.get("workflowId") == raw.get("workflowId")
                    and node.get("semanticRole") == raw.get("semanticRole")
                ),
                None,
            )
        elif raw.get("semanticRole") and not raw.get("workflowId"):
            target = next(
                (
                    node
                    for node in nodes
                    if node.get("semanticRole") == raw.get("semanticRole")
                    and not node.get("workflowId")
                ),
                None,
            )
        if target is None:
            continue
        if raw.get("status") is not None:
            target["status"] = _status(raw.get("status"), default=target["status"])
        if raw.get("reasonCode"):
            target["reasonCode"] = _clean_text(raw.get("reasonCode"), 80)
        if raw.get("started") is not None:
            target["started"] = bool(raw.get("started"))


def _cap(nodes: list[dict[str, Any]], edges: list[dict[str, str]]) -> tuple[list[dict[str, Any]], list[dict[str, str]], str | None]:
    warning = None
    run_level = [node for node in nodes if not node.get("workflowId")]
    scoped = [node for node in nodes if node.get("workflowId")]
    kept = list(nodes)
    if len(kept) > MAX_NODES:
        budget = max(0, MAX_NODES - len(run_level))
        kept = run_level + scoped[:budget]
        hidden = len(nodes) - len(kept)
        warning = (
            f"{hidden} more nodes not shown. Overflow is a warning — not done."
        )
    kept_ids = {node["id"] for node in kept}
    kept_edges = [
        edge for edge in edges if edge["from"] in kept_ids and edge["to"] in kept_ids
    ]
    if len(kept_edges) > MAX_EDGES:
        structural = [
            edge
            for edge in kept_edges
            if edge["kind"] in {"fan-out", "fan-in", "handoff", "contains", "sequence"}
        ]
        kept_edges = structural[:MAX_EDGES]
        extra = len(edges) - len(kept_edges)
        extra_note = f"{extra} more edges not shown. Overflow is a warning — not done."
        warning = f"{warning} {extra_note}".strip() if warning else extra_note
    return kept, kept_edges, warning


def _required_edges(nodes: list[dict[str, Any]]) -> list[dict[str, str]]:
    by_id = {node["id"]: node for node in nodes}

    def find(role: str, workflow_id: str | None = None) -> dict[str, Any] | None:
        return next(
            (
                node
                for node in nodes
                if node.get("semanticRole") == role
                and (node.get("workflowId") or None) == workflow_id
            ),
            None,
        )

    def lanes(workflow_id: str | None) -> list[dict[str, Any]]:
        rows = [
            node
            for node in nodes
            if node.get("semanticRole") == "specialist-lane"
            and (node.get("workflowId") or None) == workflow_id
        ]
        return sorted(
            rows,
            key=lambda node: (
                int(node.get("stageIndex") or 0),
                int(node.get("workerIndex") or 0),
                node["id"],
            ),
        )

    def workers(parent_id: str) -> list[dict[str, Any]]:
        rows = [
            node
            for node in nodes
            if node.get("semanticRole") == "workflow-worker"
            and node.get("parentId") == parent_id
        ]
        return sorted(rows, key=lambda node: (int(node.get("workerIndex") or 0), node["id"]))

    edges: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    def add(source: str, target: str, kind: str, suffix: str = "") -> None:
        if source not in by_id or target not in by_id or source == target:
            return
        key = (source, target, kind)
        if key in seen:
            return
        seen.add(key)
        edge_id = f"{source}-{kind}-{target}" + (f"-{suffix}" if suffix else "")
        edges.append(_edge(edge_id, source, target, kind))

    run_input = find("input-prompt")
    main = find("main-plan-dispatch")
    barrier = find("parallel-barrier")
    synthesis = find("synthesis-main")
    output = find("output-receipt")
    if run_input and main:
        add(run_input["id"], main["id"], "sequence")
    workflow_ids = []
    for node in nodes:
        wid = node.get("workflowId")
        if wid and wid not in workflow_ids:
            workflow_ids.append(wid)
    parallel = len(workflow_ids) >= 2

    if parallel and main:
        for wid in workflow_ids:
            wf_in = find("input-prompt", wid)
            wf_out = find("output-receipt", wid)
            wf_lanes = lanes(wid)
            if wf_in:
                add(main["id"], wf_in["id"], "fan-out")
                add(main["id"], wf_in["id"], "handoff")
            heads = [wf_in] if wf_in else ([wf_lanes[0]] if wf_lanes else [])
            if wf_in and wf_lanes:
                add(wf_in["id"], wf_lanes[0]["id"], "sequence")
                for left, right in zip(wf_lanes, wf_lanes[1:]):
                    add(left["id"], right["id"], "sequence")
            elif main and wf_lanes:
                for lane in wf_lanes:
                    add(main["id"], lane["id"], "fan-out")
            for lane in wf_lanes:
                for worker in workers(lane["id"]):
                    add(lane["id"], worker["id"], "contains")
            tail = wf_lanes[-1] if wf_lanes else (heads[0] if heads else None)
            if tail and wf_out:
                add(tail["id"], wf_out["id"], "sequence")
            if wf_out and barrier:
                add(wf_out["id"], barrier["id"], "fan-in")
    elif main:
        run_lanes = lanes(None)
        if not run_lanes and len(workflow_ids) == 1:
            run_lanes = lanes(workflow_ids[0])
        dispatch_kind = "fan-out" if len(run_lanes) > 1 else "sequence"
        join_kind = "fan-in" if len(run_lanes) > 1 else "sequence"
        for lane in run_lanes:
            add(main["id"], lane["id"], dispatch_kind)
            for worker in workers(lane["id"]):
                add(lane["id"], worker["id"], "contains")
            if barrier:
                add(lane["id"], barrier["id"], join_kind)
        if not barrier and not synthesis and output and run_lanes:
            add(run_lanes[-1]["id"], output["id"], "sequence")
        wf_in = find("input-prompt", workflow_ids[0]) if workflow_ids else None
        wf_out = find("output-receipt", workflow_ids[0]) if workflow_ids else None
        if wf_in and run_lanes:
            add(wf_in["id"], run_lanes[0]["id"], "sequence")
        if wf_out and run_lanes:
            add(run_lanes[-1]["id"], wf_out["id"], "sequence")
        if wf_out and barrier:
            add(wf_out["id"], barrier["id"], "fan-in")
        if not run_lanes and main and barrier:
            add(main["id"], barrier["id"], "sequence")

    if barrier and synthesis:
        add(barrier["id"], synthesis["id"], "sequence")
    if synthesis and output:
        add(synthesis["id"], output["id"], "sequence")
    if (
        main
        and output
        and not barrier
        and not synthesis
        and not any(node.get("semanticRole") == "specialist-lane" for node in nodes)
    ):
        add(main["id"], output["id"], "sequence")
    return edges


def _item_to_node(item: Mapping[str, Any], fallback_id: str) -> dict[str, Any]:
    role = _infer_role(item)
    node_id = str(item.get("id") or item.get("assignmentId") or fallback_id)
    title = str(item.get("title") or item.get("name") or node_id)
    return _node(
        node_id=node_id,
        title=title,
        role=role,
        status=item.get("status") or "pending",
        detail=item.get("detail") or item.get("task"),
        stageIndex=item.get("stageIndex") if item.get("stageIndex") is not None else item.get("stage"),
        workerIndex=item.get("workerIndex") if item.get("workerIndex") is not None else item.get("index"),
        folderPath=item.get("folderPath"),
        provider=item.get("provider"),
        model=item.get("model"),
        progress=item.get("progress"),
        reasonCode=item.get("reasonCode"),
        started=item.get("started"),
        workflowId=item.get("workflowId"),
        workflowLabel=item.get("workflowLabel"),
        parentId=item.get("parentId") or item.get("parentAssignmentId"),
    )


def _ensure_run_anchors(
    nodes: list[dict[str, Any]],
    *,
    evidence: Mapping[str, Any],
    parallel: bool,
    planning_failed: bool,
    skip_input: bool = False,
) -> list[dict[str, Any]]:
    have = {(node.get("semanticRole"), node.get("workflowId")) for node in nodes}
    main_raw = evidence.get("main") if isinstance(evidence.get("main"), Mapping) else {}
    main_status = _status(main_raw.get("status"), default="pending")
    if planning_failed:
        main_status = "failed"
    main_title = str(main_raw.get("name") or main_raw.get("title") or "").strip()
    if not main_title:
        main_title = "Main Agent · Plan & Dispatch"
    elif "plan" not in main_title.lower() and main_title.lower().startswith("flowchart"):
        pass
    elif main_title.lower() == "main agent":
        main_title = "Main Agent · Plan & Dispatch"

    def ensure(role: str, node_id: str, title: str, status: str, workflow_id: str | None = None) -> None:
        key = (role, workflow_id)
        if key in have:
            return
        extra: dict[str, Any] = {}
        if workflow_id:
            extra["workflowId"] = workflow_id
        nodes.append(_node(node_id=node_id, title=title, role=role, status=status, **extra))
        have.add(key)

    ensure("main-plan-dispatch", "main", main_title, main_status)
    if planning_failed:
        ensure(
            "output-receipt",
            "output",
            "Output · Receipt",
            "failed",
        )
        for node in nodes:
            if node["id"] == "output":
                node["reasonCode"] = str(evidence.get("reasonCode") or "not_dispatched")
        return nodes

    if (
        not skip_input
        and not any(
            node.get("semanticRole") == "input-prompt" and not node.get("workflowId")
            for node in nodes
        )
    ):
        ensure("input-prompt", "input", "INPUT / PROMPT", main_status if main_status != "pending" else "pending")
    workflow_ids = []
    for node in nodes:
        wid = node.get("workflowId")
        if wid and wid not in workflow_ids:
            workflow_ids.append(wid)
    if parallel:
        for wid in workflow_ids:
            label = next(
                (node.get("workflowLabel") for node in nodes if node.get("workflowId") == wid),
                None,
            ) or f"Agentic workflow {wid.replace('wf-', '').upper()}"
            suffix = wid.replace("wf-", "").upper()
            if not any(
                node.get("semanticRole") == "input-prompt" and node.get("workflowId") == wid
                for node in nodes
            ):
                ensure(
                    "input-prompt",
                    f"{wid}-in",
                    f"INPUT · Workflow {suffix}",
                    "pending",
                    wid,
                )
                nodes[-1]["workflowLabel"] = label
            if not any(
                node.get("semanticRole") == "output-receipt" and node.get("workflowId") == wid
                for node in nodes
            ):
                ensure(
                    "output-receipt",
                    f"{wid}-out",
                    f"Output · Workflow {suffix}",
                    "pending",
                    wid,
                )
                nodes[-1]["workflowLabel"] = label
        ensure("parallel-barrier", "barrier", "Barrier · Run", "waiting")
        ensure("synthesis-main", "synthesis", "Synthesis", "waiting")
        ensure("output-receipt", "output", "Output · Receipt", "pending")
    else:
        if any(node.get("semanticRole") == "specialist-lane" for node in nodes):
            if not any(
                node.get("semanticRole") == "parallel-barrier" and not node.get("workflowId")
                for node in nodes
            ):
                ensure("parallel-barrier", "barrier", "Barrier · Run", "waiting")
                ensure("synthesis-main", "synthesis", "Synthesis", "waiting")
        ensure("output-receipt", "output", "Output · Receipt", "pending")
    return nodes


def _settle_synthesized_workflow_io(nodes: list[dict[str, Any]]) -> None:
    workflow_ids: list[str] = []
    for node in nodes:
        wid = node.get("workflowId")
        if wid and wid not in workflow_ids:
            workflow_ids.append(str(wid))
    for wid in workflow_ids:
        body = [
            node
            for node in nodes
            if node.get("workflowId") == wid
            and node.get("semanticRole") in {"specialist-lane", "workflow-worker"}
        ]
        if any(node.get("status") == "failed" for node in body):
            body_status = "failed"
        elif any(node.get("status") == "cancelled" for node in body):
            body_status = "cancelled"
        elif body and all(node.get("status") == "succeeded" for node in body):
            body_status = "succeeded"
        else:
            body_status = "pending"
        input_happened = any(
            node.get("status")
            in {"succeeded", "running", "queued", "waiting", "failed", "cancelled"}
            for node in body
        )
        in_node = next(
            (
                node
                for node in nodes
                if node.get("semanticRole") == "input-prompt"
                and node.get("workflowId") == wid
            ),
            None,
        )
        out_node = next(
            (
                node
                for node in nodes
                if node.get("semanticRole") == "output-receipt"
                and node.get("workflowId") == wid
            ),
            None,
        )
        if in_node is not None and in_node.get("status") == "pending":
            in_node["status"] = "succeeded" if input_happened else "pending"
        if out_node is not None and out_node.get("status") == "pending":
            out_node["status"] = (
                body_status
                if body_status in {"succeeded", "failed", "cancelled"}
                else "pending"
            )
    barrier = next(
        (
            node
            for node in nodes
            if node.get("semanticRole") == "parallel-barrier" and not node.get("workflowId")
        ),
        None,
    )
    outs = [
        node
        for node in nodes
        if node.get("semanticRole") == "output-receipt" and node.get("workflowId")
    ]
    if (
        barrier is not None
        and barrier.get("status") == "succeeded"
        and outs
        and any(node.get("status") != "succeeded" for node in outs)
        and barrier.get("reasonCode") not in {"visual_timeout", "receipt_mismatch"}
    ):
        barrier["status"] = (
            "failed" if any(node.get("status") == "failed" for node in outs) else "waiting"
        )
    if barrier is not None and barrier.get("status") != "succeeded":
        synthesis = next(
            (
                node
                for node in nodes
                if node.get("semanticRole") == "synthesis-main" and not node.get("workflowId")
            ),
            None,
        )
        output = next((node for node in nodes if is_terminal_output(node)), None)
        if synthesis is not None and synthesis.get("status") == "succeeded":
            synthesis["status"] = "waiting"
        if output is not None and output.get("status") == "succeeded":
            output["status"] = "pending"

    run_lanes = [
        node
        for node in nodes
        if node.get("semanticRole") == "specialist-lane" and not node.get("workflowId")
    ]
    synthesis = next(
        (
            node
            for node in nodes
            if node.get("semanticRole") == "synthesis-main" and not node.get("workflowId")
        ),
        None,
    )
    output = next((node for node in nodes if is_terminal_output(node)), None)
    if run_lanes and any(node.get("status") == "failed" for node in run_lanes):
        if barrier is not None and barrier.get("status") != "failed":
            barrier["status"] = "failed"
        if synthesis is not None and synthesis.get("status") != "failed":
            synthesis["status"] = "failed"
        if output is not None and output.get("status") != "failed":
            output["status"] = "failed"
        return
    if (
        output is not None
        and output.get("status") == "pending"
        and (barrier is None or barrier.get("status") == "succeeded")
        and synthesis is not None
        and synthesis.get("status") == "succeeded"
    ):
        output["status"] = "succeeded"


def _chart_topology(
    chart: Mapping[str, Any],
) -> tuple[list[str], dict[str, list[str]], dict[str, list[str]], list[tuple[str, str]]]:
    node_ids = [str(item) for item in list(chart.get("nodeIds") or []) if str(item).strip()]
    incoming: dict[str, list[str]] = {}
    outgoing: dict[str, list[str]] = {}
    declared: list[tuple[str, str]] = []
    for edge in list(chart.get("edges") or []):
        if not isinstance(edge, Mapping):
            continue
        source = str(edge.get("from") or "")
        target = str(edge.get("to") or "")
        if source and target:
            incoming.setdefault(target, []).append(source)
            outgoing.setdefault(source, []).append(target)
            declared.append((source, target))
    return node_ids, incoming, outgoing, declared


def _chart_join_ids(
    node_ids: list[str],
    incoming: Mapping[str, list[str]],
    executable: set[str],
) -> set[str]:
    if executable:
        return {
            node_id
            for node_id in node_ids
            if node_id not in executable and node_id in incoming
        }
    return {
        node_id
        for node_id in node_ids
        if len(incoming.get(node_id) or []) >= 2
    }


def _items_from_workflow_chart(
    chart: Mapping[str, Any],
    assignments: list[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    node_ids, incoming, _outgoing, _declared = _chart_topology(chart)
    if not node_ids:
        return []
    executable: set[str] = set()
    for wave in list(chart.get("waves") or []):
        if isinstance(wave, list):
            executable.update(str(item) for item in wave if str(item).strip())
    join_ids = _chart_join_ids(node_ids, incoming, executable)
    status_by_chart: dict[str, str] = {}
    for row in assignments:
        chart_id = str(row.get("chartNodeId") or "")
        if chart_id:
            status_by_chart[chart_id] = str(row.get("status") or "pending")
    items: list[dict[str, Any]] = []
    for node_id in node_ids:
        is_join = node_id in join_ids
        predecessors = incoming.get(node_id) or []
        is_synthesis = (not is_join) and any(pred in join_ids for pred in predecessors)
        status = status_by_chart.get(node_id)
        if status is None:
            pred_statuses = [status_by_chart.get(pred) for pred in predecessors]
            if any(item in _FAILED_LIKE or item == "failed" for item in pred_statuses if item):
                status = "failed"
            elif is_join and pred_statuses and all(item == "succeeded" for item in pred_statuses):
                status = "succeeded"
            elif is_join:
                status = "pending"
            else:
                status = "unstarted"
        if is_join:
            role = "parallel-barrier"
            title = f"{node_id} · all-of"
        elif is_synthesis:
            role = "synthesis-main"
            title = node_id
        else:
            role = "specialist-lane"
            title = node_id
        items.append(
            {
                "id": node_id,
                "title": title,
                "name": title,
                "semanticRole": role,
                "status": status,
            }
        )
    return items


def _edges_from_workflow_chart(
    nodes: list[dict[str, Any]],
    chart: Mapping[str, Any],
) -> list[dict[str, str]]:
    _node_ids, incoming, outgoing, declared = _chart_topology(chart)
    by_id = {node["id"]: node for node in nodes}
    chart_ids = [str(item) for item in list(chart.get("nodeIds") or []) if str(item).strip()]
    seen: set[tuple[str, str, str]] = set()
    edges: list[dict[str, str]] = []

    def add(source: str, target: str, kind: str) -> None:
        if source not in by_id or target not in by_id or source == target:
            return
        key = (source, target, kind)
        if key in seen:
            return
        seen.add(key)
        edges.append(_edge(f"{source}-{kind}-{target}", source, target, kind))

    run_input = next(
        (
            node
            for node in nodes
            if node.get("semanticRole") == "input-prompt" and not node.get("workflowId")
        ),
        None,
    )
    main = next(
        (node for node in nodes if node.get("semanticRole") == "main-plan-dispatch"),
        None,
    )
    output = next((node for node in nodes if is_terminal_output(node)), None)
    if run_input and main:
        add(run_input["id"], main["id"], "sequence")
    roots = [node_id for node_id in chart_ids if node_id in by_id and not incoming.get(node_id)]
    dispatch_kind = "fan-out" if len(roots) > 1 else "sequence"
    if main:
        for root in roots:
            add(main["id"], root, dispatch_kind)
    for source, target in declared:
        target_node = by_id.get(target)
        kind = (
            "fan-in"
            if target_node and target_node.get("semanticRole") == "parallel-barrier"
            else "sequence"
        )
        add(source, target, kind)
    sinks = [node_id for node_id in chart_ids if node_id in by_id and not outgoing.get(node_id)]
    if output:
        for sink in sinks:
            add(sink, output["id"], "sequence")
    return edges


def project_session_flow(evidence: Mapping[str, Any] | None) -> dict[str, Any]:
    """Project one sanitized session-flow snapshot from existing evidence."""

    data = evidence if isinstance(evidence, Mapping) else {}
    claims_in = data.get("claims") if isinstance(data.get("claims"), Mapping) else None
    snapshot = empty_snapshot(claims=claims_in)
    planning_failed = bool(data.get("planningFailed"))
    raw_items = [
        item
        for item in list(data.get("items") or data.get("nodes") or [])
        if isinstance(item, Mapping)
    ]
    raw_assignments = [
        item
        for item in list(data.get("assignments") or [])
        if isinstance(item, Mapping)
    ]
    chart = data.get("workflowChart") if isinstance(data.get("workflowChart"), Mapping) else None
    chart_items = _items_from_workflow_chart(chart, raw_assignments) if chart else []
    source_items = chart_items or raw_items or raw_assignments
    if not source_items and not planning_failed and not data.get("main"):
        return snapshot

    nodes: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(source_items):
        node = _item_to_node(item, f"item-{index + 1}")
        if node["id"] in seen_ids:
            node["id"] = f"{node['id']}-{index + 1}"
        seen_ids.add(node["id"])
        nodes.append(node)

    workflow_ids = []
    for node in nodes:
        wid = node.get("workflowId")
        if wid and wid not in workflow_ids:
            workflow_ids.append(wid)
    parallel = len(workflow_ids) >= 2
    nodes = _ensure_run_anchors(
        nodes,
        evidence=data,
        parallel=parallel,
        planning_failed=planning_failed,
        skip_input=bool(chart_items),
    )
    _settle_synthesized_workflow_io(nodes)
    _apply_visual_receipts(nodes, data.get("visualReceipts"))
    if data.get("sessiondOk") is True:
        # Backend success is a separate receipt. Do not upgrade visual status.
        pass
    extra_edges = [
        _edge(
            str(edge.get("id") or f"{edge.get('from')}-{edge.get('to')}"),
            str(edge.get("from") or edge.get("source") or ""),
            str(edge.get("to") or edge.get("target") or ""),
            str(edge.get("kind") or "sequence"),
        )
        for edge in list(data.get("edges") or [])
        if isinstance(edge, Mapping)
    ]
    if chart_items and chart:
        edges = _edges_from_workflow_chart(nodes, chart) + extra_edges
    else:
        edges = _required_edges(nodes) + extra_edges
    nodes, edges, warning = _cap(nodes, edges)
    snapshot["nodes"] = nodes
    snapshot["edges"] = edges
    snapshot["overflowWarning"] = warning
    snapshot["claims"] = copy_claims(claims_in) if claims_in is not None else dict(_DEFAULT_CLAIMS)
    finalized = finalize(snapshot)
    if warning:
        finalized["overflowWarning"] = warning
    return finalized


def project_from_manifest_state(state: Mapping[str, Any] | None) -> dict[str, Any]:
    data = state if isinstance(state, Mapping) else {}
    dispatch = data.get("dispatch") if isinstance(data.get("dispatch"), Mapping) else {}
    phase = str(data.get("phase") or "").casefold()
    planning_failed = phase in {"planning_failed", "planning-failed", "not_dispatched"}
    chart = data.get("workflowChart") if isinstance(data.get("workflowChart"), Mapping) else None
    main = data.get("mainAgent") if isinstance(data.get("mainAgent"), Mapping) else {}
    if chart and chart.get("id"):
        main = {**dict(main), "name": f"Flowchart · {chart.get('id')}"}
    return project_session_flow(
        {
            "runId": data.get("runId"),
            "claims": {
                "candidateOnly": data.get("candidateOnly"),
                "canClaimAGI": data.get("canClaimAGI"),
                "validatedUplift": data.get("validatedUplift"),
                "productGo": data.get("productGo"),
            },
            "main": main,
            "assignments": data.get("assignments") or [],
            "workflowChart": chart,
            "folders": data.get("folders") or [],
            "visualReceipts": data.get("visualReceipts") or [],
            "planningFailed": planning_failed or dispatch.get("source") == "planning_failed",
            "reasonCode": data.get("reasonCode") or ("not_dispatched" if planning_failed else ""),
            "sessiondOk": data.get("sessiondOk"),
            "items": data.get("sessionFlowItems") or [],
        }
    )


def process_map_lines(snap: Mapping[str, Any]) -> list[str]:
    """Causal indented process map. Empty snapshot yields the waiting line."""

    nodes = list(snap.get("nodes") or [])
    if not nodes:
        return ["Waiting for Session Flow events…"]
    lines: list[str] = []
    overflow = snap.get("overflowWarning")
    if overflow:
        lines.append(str(overflow))
    run_nodes = [node for node in nodes if not node.get("workflowId")]
    groups: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for node in nodes:
        wid = node.get("workflowId")
        if not wid:
            continue
        if wid not in groups:
            groups[wid] = []
            order.append(wid)
        groups[wid].append(node)

    def role_rank(role: Any) -> int:
        order = {
            "input-prompt": 0,
            "main-plan-dispatch": 1,
            "specialist-lane": 2,
            "workflow-worker": 3,
            "output-receipt": 6,
            "parallel-barrier": 7,
            "synthesis-main": 8,
        }
        return int(order.get(str(role), 9))

    def status_text(node: Mapping[str, Any]) -> str:
        tally = snap.get("barrierTally") if node.get("semanticRole") == "parallel-barrier" else None
        if isinstance(tally, Mapping) and tally.get("need") and tally.get("caption"):
            extra = f" {tally.get('caption')}"
        else:
            extra = ""
        progress = node.get("progress")
        progress_s = f" {int(float(progress) * 100)}%" if isinstance(progress, (int, float)) and node.get("status") == "running" else ""
        return f"{node.get('status', 'unknown')}{progress_s}{extra}"

    run_head = sorted(
        [
            node
            for node in run_nodes
            if node.get("semanticRole") in {"input-prompt", "main-plan-dispatch"}
        ],
        key=lambda node: role_rank(node.get("semanticRole")),
    )
    for node in run_head:
        lines.append(f"{node.get('title')}  {status_text(node)}")
    run_lanes = [node for node in run_nodes if node.get("semanticRole") == "specialist-lane"]
    run_workers = [node for node in run_nodes if node.get("semanticRole") == "workflow-worker"]
    fan_out = len(run_lanes) > 1 and any(
        node.get("semanticRole") == "parallel-barrier" for node in run_nodes
    )
    for index, node in enumerate(run_lanes):
        if fan_out:
            mark = "└" if index == len(run_lanes) - 1 else "├"
            lines.append(f"  {mark} {node.get('title')}  {status_text(node)}")
            kid_prefix = "  │  " if index < len(run_lanes) - 1 else "     "
        else:
            lines.append(f"{node.get('title')}  {status_text(node)}")
            kid_prefix = "  "
        kids = [
            child
            for child in run_workers
            if child.get("parentId") == node["id"]
        ]
        for kid_index, kid in enumerate(kids):
            mark = "└ contains" if kid_index == len(kids) - 1 else "├ contains"
            lines.append(f"{kid_prefix}{mark} {kid.get('title')}  {status_text(kid)}")
    for index, wid in enumerate(order):
        members = sorted(
            [
                node
                for node in groups[wid]
                if node.get("semanticRole") != "workflow-worker"
            ],
            key=lambda node: (role_rank(node.get("semanticRole")), str(node.get("id"))),
        )
        branch = "└─" if index == len(order) - 1 else "├─"
        label = members[0].get("workflowLabel") if members else wid
        lines.append(f"  {branch} {label}")
        indent = "  │    " if index < len(order) - 1 else "       "
        for node in members:
            lines.append(f"{indent}{node.get('title')}  {status_text(node)}")
            kids = [
                child
                for child in groups[wid]
                if child.get("semanticRole") == "workflow-worker"
                and child.get("parentId") == node["id"]
            ]
            for kid_index, kid in enumerate(kids):
                mark = "└ contains" if kid_index == len(kids) - 1 else "├ contains"
                lines.append(f"{indent}  {mark} {kid.get('title')}  {status_text(kid)}")
    for node in run_nodes:
        if node.get("semanticRole") in {
            "parallel-barrier",
            "synthesis-main",
            "output-receipt",
        }:
            lines.append(f"{node.get('title')}  {status_text(node)}")
    return lines


def strip_lines(snap: Mapping[str, Any]) -> list[str]:
    """Short wide Session Flow strip. Same nodes as the process map."""

    nodes = list(snap.get("nodes") or [])
    if not nodes:
        return ["Waiting for Session Flow events…"]
    overflow = snap.get("overflowWarning")
    lines = [str(overflow)] if overflow else []
    workflow_ids = []
    for node in nodes:
        wid = node.get("workflowId")
        if wid and wid not in workflow_ids:
            workflow_ids.append(wid)
    tally = snap.get("barrierTally") if isinstance(snap.get("barrierTally"), Mapping) else {}
    barrier = next(
        (
            node
            for node in nodes
            if node.get("semanticRole") == "parallel-barrier" and not node.get("workflowId")
        ),
        None,
    )
    bar_caption = (
        str(tally.get("caption") or "")
        if int(tally.get("need") or 0) > 0
        else str((barrier or {}).get("title") or "")
    )
    syn = next((n for n in nodes if n.get("semanticRole") == "synthesis-main" and not n.get("workflowId")), None)
    out = next((n for n in nodes if is_terminal_output(n)), None)
    main = next((n for n in nodes if n.get("semanticRole") == "main-plan-dispatch"), None)
    run_in = next((n for n in nodes if n.get("semanticRole") == "input-prompt" and not n.get("workflowId")), None)
    if len(workflow_ids) >= 2:
        bands = []
        for wid in workflow_ids:
            scoped = [n for n in nodes if n.get("workflowId") == wid]
            label = next((n.get("workflowLabel") for n in scoped if n.get("workflowLabel")), wid)
            wf_in = next((n for n in scoped if n.get("semanticRole") == "input-prompt"), None)
            wf_out = next((n for n in scoped if n.get("semanticRole") == "output-receipt"), None)
            lanes = [n for n in scoped if n.get("semanticRole") == "specialist-lane"]
            lane_s = " ─ ".join(n.get("title", "") for n in lanes) or "—"
            nests = [n for n in scoped if n.get("semanticRole") == "workflow-worker"]
            nest_s = f" [{' '.join(n.get('title', '') for n in nests)}]" if nests else ""
            bands.append(
                f"{label}  {wf_in.get('title') if wf_in else 'In'} ─ {lane_s}{nest_s} ─ {wf_out.get('title') if wf_out else 'Out'}"
            )
        lines.append(
            f"{run_in.get('title') if run_in else 'IN'} ▶  {main.get('title') if main else 'MAIN'} ─┬─ {bands[0]}"
        )
        for band in bands[1:-1]:
            lines.append(f"                      ├─ {band}")
        if len(bands) > 1:
            lines.append(
                f"                      └─ {bands[-1]} ── {bar_caption or 'BAR'} ─ {syn.get('title') if syn else 'SYN'} ─ {out.get('title') if out else 'OUT'}"
            )
        return lines
    lane_titles = [
        n.get("title")
        for n in nodes
        if n.get("semanticRole") == "specialist-lane"
    ]
    lines.append(
        " → ".join(
            part
            for part in [
                run_in.get("title") if run_in else None,
                main.get("title") if main else "MAIN",
                ", ".join(lane_titles) if lane_titles else None,
                bar_caption or None,
                syn.get("title") if syn else None,
                out.get("title") if out else None,
            ]
            if part
        )
    )
    return lines


__all__ = [
    "EDGE_KINDS",
    "MAX_EDGES",
    "MAX_NODES",
    "NODE_STATUSES",
    "SCHEMA",
    "SEMANTIC_ROLES",
    "attach_workflow",
    "copy_claims",
    "empty_snapshot",
    "finalize",
    "is_terminal_output",
    "process_map_lines",
    "project_from_manifest_state",
    "project_session_flow",
    "strip_lines",
    "workflow_id_from_folder",
]
