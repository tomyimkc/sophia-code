import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EMPTY_AGI_WORKFLOW_STATE,
  agiWorkflowReducer,
} from "../lib/agiWorkflowState.js";
import { EMPTY_DYNAMIC_WORKFLOW_STATE } from "../lib/dynamicWorkflowState.js";
import {
  agiWorkflowCompactPanelLines,
  compactWorkflowBarrierChrome,
  dynamicWorkflowStageCounter,
} from "./GoalTodoPanel.js";

const GOAL_PANEL_SOURCE = readFileSync(
  new URL("./GoalTodoPanel.tsx", import.meta.url),
  "utf8",
);

test("compact AGI workflow panel reports routing, workers, warm leases, and reuse", () => {
  let state = agiWorkflowReducer(EMPTY_AGI_WORKFLOW_STATE, {
    type: "agi_workflow_start",
    runId: "run-1",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_node_start",
    node: { id: "node-1", index: 2, title: "Verify frontend wiring" },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_route",
    execution: "workflow",
    reason: "parallel verification",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_workflow_start",
    workflow: {
      id: "wf-1",
      pattern: "fan-out-and-synthesize",
      stage: 1,
      maxStages: 2,
      barrier: { status: "running", completed: 0, total: 2 },
    },
    agents: [
      { id: "agent-1", name: "Implementer", status: "running" },
      { id: "agent-2", name: "Verifier", status: "leased" },
    ],
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_warm_pool",
    size: 1,
    leases: [{
      leaseId: "lease-1",
      workerId: "worker-1",
      name: "Warm verifier",
      status: "warm_idle",
      reuseCount: 2,
      reuseReason: "same tool scope",
    }],
  });

  const lines = agiWorkflowCompactPanelLines(state, "on");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /mode on · running/);
  assert.match(lines[1], /node 2 · Verify frontend wiring/);
  assert.match(lines[2], /route workflow · fan-out-and-synthesize/);
  assert.match(lines[3], /2 active agents · 1 warm-idle lease · 2 reuses/);
});

test("compact AGI workflow panel stays hidden for an idle disabled projection", () => {
  assert.deepEqual(
    agiWorkflowCompactPanelLines(EMPTY_AGI_WORKFLOW_STATE, "off"),
    [],
  );
});

test("compact workflow stage counter uses the latest plan rather than the safety budget", () => {
  assert.equal(
    dynamicWorkflowStageCounter({
      ...EMPTY_DYNAMIC_WORKFLOW_STATE,
      currentStage: 2,
      plannedStages: 5,
      maxStages: 12,
    }),
    "2/5",
  );
  assert.equal(
    dynamicWorkflowStageCounter({
      ...EMPTY_DYNAMIC_WORKFLOW_STATE,
      currentStage: 2,
      plannedStages: 0,
      maxStages: 12,
    }),
    "2/?",
  );
});

test("compact ETA uses the digit-only matrix presenter", () => {
  assert.match(
    GOAL_PANEL_SOURCE,
    /↳ <MatrixDigitsText text=\{etaLabel\} \/>/,
  );
  assert.doesNotMatch(
    GOAL_PANEL_SOURCE,
    /↳ <MatrixText text=\{etaLabel\} \/>/,
  );
});

test("compact workflow chrome counts never-started lanes as failed, not waiting", () => {
  const chrome = compactWorkflowBarrierChrome([
    { status: "succeeded" },
    { status: "succeeded" },
    { status: "unstarted" },
    { status: "unstarted" },
  ]);
  assert.deepEqual(chrome, { terminal: 4, succeeded: 2, failed: 2 });
});

test("compact workflow chrome counts skipped lanes as failed", () => {
  const chrome = compactWorkflowBarrierChrome([
    { status: "succeeded" },
    { status: "skipped" },
  ]);
  assert.deepEqual(chrome, { terminal: 2, succeeded: 1, failed: 1 });
});

test("expanded AGI workflow inspector exposes selectable clickable rows", () => {
  const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));
  const source = readFileSync(appPath, "utf8");
  assert.doesNotMatch(source, /onInteractiveLayout\?\.\(\[\], \[\]\)/);
  assert.match(
    source,
    /onInteractiveLayout\?\.\(itemIds, \[\.\.\.byId\.values\(\)\]\)/,
  );
  assert.match(source, /selectedItemId=\{rightPanelDetail\.selectedItemId\}/);
  assert.match(source, /expandedItemIds=\{rightPanelDetail\.expandedItemIds\}/);
  assert.match(source, /Enter\/Space expand/);
});
