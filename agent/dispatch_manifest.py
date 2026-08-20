# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Live, secret-free dispatch metadata for Sophia TUI and SMUX.

The bridge NDJSON stream is ephemeral.  This manifest is the durable,
atomically-written projection that a companion UI can tail or reload while a
run is in flight.  It intentionally stores assignment metadata and lifecycle
facts, not prompts, model reasoning, tool arguments, or tool outputs.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from agent.run_finished import run_finished_dir
from agent.secret_patterns import redact_diagnostic

SCHEMA = "sophia.dispatch-manifest.v1"
MAX_ASSIGNMENTS = 64
MAX_TASK_CHARS = 1600
MAX_SUMMARY_CHARS = 600
MAX_ERROR_CHARS = 800
TERMINAL_ASSIGNMENT_STATUSES = frozenset(
    {"succeeded", "failed", "cancelled", "canceled", "skipped", "timed_out"}
)
NOT_STARTED_ASSIGNMENT_STATUSES = frozenset(
    {"queued", "submitted", "blocked", "skipped", "unstarted"}
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _clean(value: Any, limit: int) -> str:
    # A live manifest is a durable boundary, so use the stricter diagnostic
    # redactor rather than the high-precision prompt redactor.  Task text and
    # provider errors can contain generic ``token=...`` or ``password=...``
    # assignments that are not shaped like a known provider credential.
    text = redact_diagnostic(str(value or "")).strip()
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + "…"


def _clean_list(
    values: Iterable[Any] | None,
    *,
    limit: int,
    item_limit: int,
) -> list[str]:
    result: list[str] = []
    for value in list(values or [])[:limit]:
        item = _clean(value, item_limit)
        if item and item not in result:
            result.append(item)
    # Preserve the selection order for skills, tools, dependencies, and
    # coverage.  The order is part of the live provenance shown by SMUX (and
    # is useful when a role resolver chose a primary skill before a secondary
    # one); callers can sort explicitly when they need canonical comparison.
    return result


class DispatchManifest:
    """Thread-safe live assignment manifest for one Sophia run."""

    def __init__(
        self,
        *,
        session: str,
        run_id: str,
        mode: str,
        state_dir: Path | None = None,
        persist: bool = True,
        source_run_id: str = "",
    ) -> None:
        self.session = str(session or "")
        self.run_id = str(run_id or "")
        self.mode = str(mode or "a2a")
        self.persist = bool(persist)
        self.root = run_finished_dir(
            self.session,
            self.run_id,
            state_dir=state_dir,
        )
        self.path = self.root / "dispatch-manifest.json"
        self._lock = threading.RLock()
        self._state: dict[str, Any] = {
            "schema": SCHEMA,
            "session": self.session,
            "runId": self.run_id,
            "mode": self.mode,
            "status": "idle",
            "phase": "planning",
            "version": 0,
            "createdAt": _now_iso(),
            "updatedAt": _now_iso(),
            "mainAgent": {
                "id": "main",
                "name": "Main Agent",
                "status": "planning",
            },
            "dispatch": {
                "decided": False,
                "source": "",
                "requestedCount": 0,
                "startedCount": 0,
                "activeCount": 0,
                "completedCount": 0,
                "failedCount": 0,
                "skippedCount": 0,
            },
            "assignments": [],
            "workflowChart": None,
            "folders": [],
            "visualReceipts": [],
            "sessionFlow": None,
            "candidateOnly": True,
            "canClaimAGI": False,
            "validatedUplift": False,
            "productGo": False,
        }
        if source_run_id:
            self._state["recoveryOf"] = _clean(source_run_id, 240)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._state, ensure_ascii=False))

    def _recompute_counts(self) -> None:
        rows = [
            row
            for row in list(self._state.get("assignments") or [])
            if isinstance(row, dict)
        ]
        statuses = [str(row.get("status") or "").casefold() for row in rows]
        self._state["dispatch"].update(
            {
                "requestedCount": len(rows),
                "startedCount": sum(
                    1
                    for row in rows
                    if (
                        bool(row.get("started"))
                        if "started" in row
                        else (
                            bool(row.get("startedAt"))
                            or str(row.get("status") or "").casefold()
                            not in NOT_STARTED_ASSIGNMENT_STATUSES
                        )
                    )
                ),
                "activeCount": sum(
                    1
                    for status in statuses
                    if status
                    in {
                        "dispatching",
                        "spawning",
                        "running",
                        "working",
                        "waiting_input",
                        "verifying",
                    }
                ),
                "completedCount": sum(
                    1 for status in statuses if status == "succeeded"
                ),
                "failedCount": sum(
                    1
                    for status in statuses
                    if status in {"failed", "timed_out", "cancelled", "canceled"}
                ),
                "skippedCount": sum(1 for status in statuses if status == "skipped"),
            }
        )

    def _commit(self) -> dict[str, Any]:
        from agent.session_flow import project_from_manifest_state

        self._recompute_counts()
        self._state["sessionFlow"] = project_from_manifest_state(self._state)
        self._state["version"] = int(self._state.get("version") or 0) + 1
        self._state["updatedAt"] = _now_iso()
        if not self.persist:
            return self.snapshot()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.root, 0o700)
        except OSError:
            pass
        encoded = (
            json.dumps(self._state, ensure_ascii=False, indent=2, sort_keys=True)
            + "\n"
        )
        temp = self.root / (
            f".dispatch-manifest.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        with temp.open("x", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, self.path)
        return self.snapshot()

    def event_payload(self) -> dict[str, Any]:
        with self._lock:
            dispatch = dict(self._state["dispatch"])
            return {
                "type": "dispatch_manifest",
                "schema": SCHEMA,
                "manifestPath": str(self.path) if self.persist else "",
                "manifestVersion": int(self._state.get("version") or 0),
                "status": str(self._state.get("status") or ""),
                "phase": str(self._state.get("phase") or ""),
                "dispatch": dispatch,
                "workflowChart": (
                    json.loads(json.dumps(self._state.get("workflowChart")))
                    if self._state.get("workflowChart") is not None
                    else None
                ),
                "sessionFlow": (
                    json.loads(json.dumps(self._state.get("sessionFlow")))
                    if self._state.get("sessionFlow") is not None
                    else None
                ),
                "candidateOnly": True,
                "canClaimAGI": False,
                "validatedUplift": False,
                "productGo": False,
            }

    def set_status(
        self,
        status: str,
        *,
        phase: str | None = None,
        source: str | None = None,
        main_status: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            self._state["status"] = _clean(status, 80)
            if phase is not None:
                self._state["phase"] = _clean(phase, 80)
            if source is not None:
                self._state["dispatch"]["source"] = _clean(source, 120)
                self._state["dispatch"]["decided"] = True
            if main_status is not None:
                self._state["mainAgent"]["status"] = _clean(main_status, 80)
            return self._commit()

    def set_folder_ledger(self, folders: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
        with self._lock:
            rows: list[dict[str, Any]] = []
            for item in list(folders or [])[:MAX_ASSIGNMENTS]:
                if not isinstance(item, Mapping):
                    continue
                path = _clean(item.get("folderPath") or item.get("path"), 512)
                if not path:
                    continue
                rows.append(
                    {
                        "folderPath": path,
                        "status": _clean(item.get("status"), 80),
                        "title": _clean(item.get("title") or item.get("name"), 180),
                    }
                )
            self._state["folders"] = rows
            return self._commit()

    def set_visual_receipts(
        self,
        receipts: Iterable[Mapping[str, Any]],
    ) -> dict[str, Any]:
        with self._lock:
            rows: list[dict[str, Any]] = []
            for item in list(receipts or [])[:MAX_ASSIGNMENTS]:
                if not isinstance(item, Mapping):
                    continue
                rows.append(
                    {
                        "id": _clean(item.get("id") or item.get("nodeId"), 160),
                        "status": _clean(item.get("status"), 80),
                        "reasonCode": _clean(item.get("reasonCode"), 120),
                        "workflowId": _clean(item.get("workflowId"), 96),
                        "semanticRole": _clean(item.get("semanticRole"), 80),
                    }
                )
            self._state["visualReceipts"] = rows
            return self._commit()

    def mark_planning_failed(self, reason_code: str = "not_dispatched") -> dict[str, Any]:
        with self._lock:
            self._state["phase"] = "planning_failed"
            self._state["status"] = "failed"
            self._state["reasonCode"] = _clean(reason_code, 120) or "not_dispatched"
            self._state["mainAgent"]["status"] = "failed"
            return self._commit()

    def set_main_agent_runtime(
        self,
        *,
        provider: str,
        model: str,
    ) -> dict[str, Any]:
        """Record the controller route separately from worker assignment routes."""
        with self._lock:
            self._state["mainAgent"]["provider"] = _clean(provider, 100)
            self._state["mainAgent"]["model"] = _clean(model, 180)
            return self._commit()

    def set_workflow_chart(
        self,
        chart: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """Record the selected, compiled chart without task/prompt bodies."""
        with self._lock:
            if chart is None:
                self._state["workflowChart"] = None
                return self._commit()
            raw_nodes = chart.get("nodeIds")
            raw_edges = chart.get("edgeIds")
            edges = chart.get("edges")
            waves = chart.get("waves")
            node_ids = _clean_list(raw_nodes, limit=MAX_ASSIGNMENTS, item_limit=160)
            edge_ids = _clean_list(
                raw_edges,
                limit=MAX_ASSIGNMENTS * 2,
                item_limit=240,
            )
            edge_rows: list[dict[str, str]] = []
            if isinstance(edges, list):
                for item in edges[: MAX_ASSIGNMENTS * 2]:
                    if not isinstance(item, Mapping):
                        continue
                    source = _clean(item.get("from"), 160)
                    target = _clean(item.get("to"), 160)
                    edge_id = _clean(item.get("id"), 240) or (
                        f"{source}->{target}" if source and target else ""
                    )
                    if source and target:
                        edge_rows.append(
                            {
                                "id": edge_id,
                                "from": source,
                                "to": target,
                                "kind": _clean(item.get("kind"), 80),
                            }
                        )
            wave_rows: list[list[str]] = []
            if isinstance(waves, list):
                for wave in waves[:MAX_ASSIGNMENTS]:
                    if isinstance(wave, list):
                        wave_rows.append(
                            _clean_list(wave, limit=MAX_ASSIGNMENTS, item_limit=160)
                        )
            self._state["workflowChart"] = {
                "schema": _clean(chart.get("schema"), 80),
                "id": _clean(chart.get("id"), 160),
                "sourcePath": _clean(chart.get("sourcePath"), 512),
                "sourceDigest": _clean(chart.get("sourceDigest"), 64),
                "topologyDigest": _clean(chart.get("topologyDigest"), 64),
                "nodeIds": node_ids,
                "edgeIds": edge_ids,
                "edges": edge_rows,
                "waves": wave_rows,
            }
            return self._commit()

    def register_assignment(
        self,
        *,
        assignment_id: str,
        agent_id: str,
        task_id: str,
        name: str,
        task: str,
        phase: str = "dispatching",
        status: str = "queued",
        persona_id: str = "",
        persona_name: str = "",
        persona_discipline: str = "",
        persona_via: str = "none",
        skills: Iterable[str] = (),
        skill_via: Iterable[str] = (),
        allowed_tools: Iterable[str] = (),
        tool_scope_via: str = "default_read_only",
        permission: str = "",
        execution: str = "",
        provider: str = "",
        model: str = "",
        stage: int | None = None,
        dependencies: Iterable[str] = (),
        coverage_keys: Iterable[str] = (),
        receipt_path: str = "",
        receipt_run_id: str = "",
        source: str = "",
        division: str = "",
        worker_session: str = "",
        logical_agent_id: str = "",
        reuse_allowed: bool | None = None,
        reuse_reason: str = "",
        cache_eligible: bool | None = None,
        process_reuse: bool | None = None,
        provider_tool_mode: str = "",
        unavailable_tools: Iterable[str] = (),
        requested_worker_model: str = "",
        resolved_worker_provider: str = "",
        resolved_worker_model: str = "",
        routing_source: str = "",
        worker_report_status: str = "",
        chart_node_id: str = "",
        started: bool | None = None,
        reason_code: str = "",
        folder_path: str = "",
        workflow_id: str = "",
        workflow_label: str = "",
        parent_assignment_id: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            assignments = self._state["assignments"]
            row = next(
                (
                    item
                    for item in assignments
                    if str(item.get("assignmentId") or "") == str(assignment_id)
                ),
                None,
            )
            if row is None:
                if len(assignments) >= MAX_ASSIGNMENTS:
                    raise ValueError("dispatch manifest assignment safety cap exceeded")
                row = {"assignmentId": _clean(assignment_id, 240)}
                assignments.append(row)
            row.update(
                {
                    "agentId": _clean(agent_id, 240),
                    "taskId": _clean(task_id, 240),
                    "name": _clean(name, 240),
                    "task": _clean(task, MAX_TASK_CHARS),
                    "phase": _clean(phase, 80),
                    "status": _clean(status, 80),
                    "personaId": _clean(persona_id, 160),
                    "personaName": _clean(persona_name, 240),
                    "personaDiscipline": _clean(persona_discipline, 160),
                    "personaVia": _clean(persona_via, 80),
                    "skills": _clean_list(skills, limit=8, item_limit=160),
                    "skillVia": _clean_list(skill_via, limit=8, item_limit=160),
                    # Canonicalize tools so SMUX diffs do not churn when a
                    # resolver returns the same least-privilege set in a
                    # different order.
                    "allowedTools": sorted(
                        _clean_list(
                            allowed_tools,
                            limit=64,
                            item_limit=120,
                        )
                    ),
                    "toolScopeVia": _clean(tool_scope_via, 100),
                    "permission": _clean(permission, 80),
                    "execution": _clean(execution, 80),
                    "provider": _clean(provider, 100),
                    "model": _clean(model, 180),
                    "dependencies": _clean_list(
                        dependencies,
                        limit=16,
                        item_limit=240,
                    ),
                    "coverageKeys": _clean_list(
                        coverage_keys,
                        limit=16,
                        item_limit=160,
                    ),
                    "receiptPath": _clean(receipt_path, 1000),
                    "receiptRunId": _clean(receipt_run_id, 240),
                    "source": _clean(source, 120),
                    "division": _clean(division, 160),
                    "workerSession": _clean(worker_session, 240),
                    "logicalAgentId": _clean(logical_agent_id, 240),
                    "folderPath": _clean(folder_path, 512),
                    "workflowId": _clean(workflow_id, 96),
                    "workflowLabel": _clean(workflow_label, 180),
                    "parentAssignmentId": _clean(parent_assignment_id, 240),
                    "updatedAt": _now_iso(),
                    "candidateOnly": True,
                    "canClaimAGI": False,
                    "validatedUplift": False,
                    "productGo": False,
                }
            )
            if reuse_allowed is not None:
                row["reuseAllowed"] = bool(reuse_allowed)
            if reuse_reason:
                row["reuseReason"] = _clean(reuse_reason, 240)
            if cache_eligible is not None:
                row["cacheEligible"] = bool(cache_eligible)
            if process_reuse is not None:
                row["processReuse"] = bool(process_reuse)
            if provider_tool_mode:
                row["providerToolMode"] = _clean(provider_tool_mode, 100)
            if requested_worker_model:
                row["requestedWorkerModel"] = _clean(
                    requested_worker_model,
                    180,
                )
            if resolved_worker_provider:
                row["resolvedWorkerProvider"] = _clean(
                    resolved_worker_provider,
                    100,
                )
            if resolved_worker_model:
                row["resolvedWorkerModel"] = _clean(
                    resolved_worker_model,
                    180,
                )
            if routing_source:
                row["routingSource"] = _clean(routing_source, 100)
            unavailable = _clean_list(
                unavailable_tools,
                limit=64,
                item_limit=120,
            )
            if unavailable:
                row["unavailableTools"] = sorted(unavailable)
            if worker_report_status:
                row["workerReportStatus"] = _clean(
                    worker_report_status,
                    80,
                )
            if chart_node_id:
                row["chartNodeId"] = _clean(chart_node_id, 160)
            if started is not None:
                row["started"] = bool(started)
            if reason_code:
                row["reasonCode"] = _clean(reason_code, 120)
            if folder_path:
                row["folderPath"] = _clean(folder_path, 512)
            if workflow_id:
                row["workflowId"] = _clean(workflow_id, 96)
            if workflow_label:
                row["workflowLabel"] = _clean(workflow_label, 180)
            if parent_assignment_id:
                row["parentAssignmentId"] = _clean(parent_assignment_id, 240)
            if stage is not None:
                row["stage"] = max(1, int(stage))
            if (
                started is not False
                and str(status).casefold()
                not in NOT_STARTED_ASSIGNMENT_STATUSES
            ):
                row.setdefault("startedAt", _now_iso())
            if str(status).casefold() in TERMINAL_ASSIGNMENT_STATUSES:
                row.setdefault("completedAt", _now_iso())
            return self._commit()

    def update_assignment(
        self,
        assignment_id: str,
        *,
        status: str | None = None,
        phase: str | None = None,
        summary: str | None = None,
        error: str | None = None,
        receipt_path: str | None = None,
        receipt_run_id: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        allowed_tools: Iterable[str] | None = None,
        tool_scope_via: str | None = None,
        provider_tool_mode: str | None = None,
        unavailable_tools: Iterable[str] | None = None,
        worker_report_status: str | None = None,
        started: bool | None = None,
        reason_code: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            row = next(
                (
                    item
                    for item in self._state["assignments"]
                    if str(item.get("assignmentId") or "") == str(assignment_id)
                ),
                None,
            )
            if row is None:
                raise KeyError(f"unknown dispatch assignment: {assignment_id}")
            if status is not None:
                row["status"] = _clean(status, 80)
                if str(status).casefold() not in NOT_STARTED_ASSIGNMENT_STATUSES:
                    row.setdefault("startedAt", _now_iso())
                    if started is None:
                        row["started"] = True
                if str(status).casefold() in TERMINAL_ASSIGNMENT_STATUSES:
                    row["completedAt"] = _now_iso()
            if phase is not None:
                row["phase"] = _clean(phase, 80)
            if summary is not None:
                row["summary"] = _clean(summary, MAX_SUMMARY_CHARS)
            if error is not None:
                row["error"] = _clean(error, MAX_ERROR_CHARS)
            if receipt_path is not None:
                row["receiptPath"] = _clean(receipt_path, 1000)
            if receipt_run_id is not None:
                row["receiptRunId"] = _clean(receipt_run_id, 240)
            if provider is not None:
                row["provider"] = _clean(provider, 100)
            if model is not None:
                row["model"] = _clean(model, 180)
            if allowed_tools is not None:
                row["allowedTools"] = sorted(
                    _clean_list(
                        allowed_tools,
                        limit=64,
                        item_limit=120,
                    )
                )
            if tool_scope_via is not None:
                row["toolScopeVia"] = _clean(tool_scope_via, 100)
            if provider_tool_mode is not None:
                row["providerToolMode"] = _clean(
                    provider_tool_mode,
                    100,
                )
            if unavailable_tools is not None:
                row["unavailableTools"] = sorted(
                    _clean_list(
                        unavailable_tools,
                        limit=64,
                        item_limit=120,
                    )
                )
            if worker_report_status is not None:
                row["workerReportStatus"] = _clean(
                    worker_report_status,
                    80,
                )
            if started is not None:
                row["started"] = bool(started)
                if started:
                    row.setdefault("startedAt", _now_iso())
                else:
                    row.pop("startedAt", None)
            if reason_code is not None:
                row["reasonCode"] = _clean(reason_code, 120)
            row["updatedAt"] = _now_iso()
            return self._commit()


__all__ = ["DispatchManifest", "SCHEMA"]
