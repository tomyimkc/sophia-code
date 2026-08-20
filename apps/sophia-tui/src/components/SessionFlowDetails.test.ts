import test from "node:test";
import assert from "node:assert/strict";
import type { BridgeEvent } from "../lib/bridge.js";
import {
  sessionFlowDetailRows,
} from "./SessionFlowDetails.js";
import {
  EMPTY_SESSION_FLOW_STATE,
  sessionFlowReducer,
  type SessionFlowState,
} from "../lib/sessionFlow.js";
import type { SessionFlowHierarchyNodeMeta } from "../lib/sessionFlowHierarchy.js";

function fold(events: BridgeEvent[]): SessionFlowState {
  return events.reduce(
    (state, event) => sessionFlowReducer(state, { type: "event", event }),
    EMPTY_SESSION_FLOW_STATE,
  );
}

test("selected block details include its observable metadata and connections", () => {
  const state = fold([
    { type: "run_start", runId: "run-1", goal: "Inspect repository" },
    { type: "a2a_chain_start", runId: "run-1" },
    {
      type: "a2a_agent_start",
      runId: "run-1",
      agentName: "repo-reviewer",
      lane: "repo",
    },
    {
      type: "tool_call",
      runId: "run-1",
      lane: "repo",
      tool: "rg",
    },
  ]);
  const selected = state.nodes.at(-1);
  assert.ok(selected);

  const rows = sessionFlowDetailRows(state, selected.id);
  assert.equal(rows.find((item) => item.id === "kind")?.value, "tool");
  assert.equal(rows.find((item) => item.id === "event")?.value, "tool_call");
  assert.match(rows.find((item) => item.id === "parent")?.value ?? "", /Agent/);
  assert.match(rows.find((item) => item.id === "incoming")?.value ?? "", /Agent/);
});

test("details fall back to the running or latest block", () => {
  const state = fold([
    { type: "run_start", runId: "run-1" },
    { type: "result", runId: "run-1", ok: true },
  ]);
  const rows = sessionFlowDetailRows(state, null);

  assert.equal(rows.find((item) => item.id === "event")?.value, "run_start");
});

test("empty state reports that the inspector is waiting for events", () => {
  assert.deepEqual(
    sessionFlowDetailRows(EMPTY_SESSION_FLOW_STATE, "missing"),
    [
      {
        id: "empty",
        label: "",
        value: "Waiting for observable harness events.",
        tone: "dim",
      },
    ],
  );
});

test("compound inspector exposes hierarchy metadata and preserved safe event order", () => {
  const projected: SessionFlowState = {
    ...EMPTY_SESSION_FLOW_STATE,
    nodes: [{
      id: "workflow",
      runId: "run-1",
      parentId: null,
      kind: "workflow",
      status: "running",
      label: "Workflow",
      detail: "Reader · checking flow",
      eventType: "Stage 1/3 · barrier 1/2",
      sequence: 2,
      depth: 0,
      timestamp: "2026-08-14T00:00:02Z",
      scope: "run-1:workflow",
    }],
  };
  const raw: SessionFlowState = {
    ...EMPTY_SESSION_FLOW_STATE,
    nodes: [
      {
        ...projected.nodes[0]!,
        id: "source-1",
        eventType: "dynamic_workflow_start",
        sequence: 2,
        detail: "workflow accepted",
      },
      {
        ...projected.nodes[0]!,
        id: "source-2",
        eventType: "dynamic_workflow_worker_progress",
        sequence: 3,
        detail: "Reader · checking flow",
      },
    ],
  };
  const metadata: SessionFlowHierarchyNodeMeta = {
    projectedNodeId: "workflow",
    entityKind: "workflow",
    sourceNodeIds: ["source-1", "source-2"],
    hiddenEventCount: 1,
    childEntityIds: ["stage-1"],
    compound: true,
    expandable: true,
    drillable: true,
    childFocusNodeId: "stage-1",
    statusLookupId: null,
    hierarchyPath: ["workflow"],
    sourceEventTypes: [
      "dynamic_workflow_start",
      "dynamic_workflow_worker_progress",
    ],
    summary: "workflow capsule",
  };
  const rows = sessionFlowDetailRows(projected, "workflow", {
    rawState: raw,
    metadataByNodeId: { workflow: metadata },
  });

  assert.ok(rows.some((row) => row.id === "entity" && /portal/.test(row.value)));
  assert.ok(
    rows.some(
      (row) =>
        row.id === "sources"
        && /2 preserved/.test(row.value)
        && /1 folded/.test(row.value),
    ),
  );
  assert.deepEqual(
    rows
      .filter((row) => row.id.startsWith("event-"))
      .map((row) => row.value),
    [
      "#002 dynamic_workflow_start · workflow accepted",
      "#003 dynamic_workflow_worker_progress · Reader · checking flow",
    ],
  );
});
