import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveWorkflowRouting,
  workflowOwnsRouting,
  type WorkflowRoutingSettings,
} from "./workflowRouting.js";

const STALE_PERSISTED_SETTINGS: WorkflowRoutingSettings = {
  autoTeam: true,
  team: 4,
  a2aAgents: 0,
  a2aExecution: "embedded",
  terminalLayout: "off",
  agiMode: true,
};

test("workflow on owns routing and cannot be disabled by stale legacy dispatch or AGI defaults", () => {
  assert.deepEqual(resolveWorkflowRouting("on", STALE_PERSISTED_SETTINGS), {
    autoTeam: false,
    team: 1,
    a2aAgents: -1,
    a2aExecution: "terminal",
    terminalLayout: "auto",
    agiMode: false,
  });
});

test("workflow auto has the same parallel A2A prerequisites as workflow on", () => {
  assert.equal(workflowOwnsRouting("auto"), true);
  assert.deepEqual(
    resolveWorkflowRouting("auto", STALE_PERSISTED_SETTINGS),
    resolveWorkflowRouting("on", STALE_PERSISTED_SETTINGS),
  );
});

test("workflow off preserves the operator's existing routing preferences", () => {
  const resolved = resolveWorkflowRouting("off", STALE_PERSISTED_SETTINGS);
  assert.deepEqual(resolved, STALE_PERSISTED_SETTINGS);
  assert.notEqual(resolved, STALE_PERSISTED_SETTINGS);
  assert.equal(workflowOwnsRouting("off"), false);
});
