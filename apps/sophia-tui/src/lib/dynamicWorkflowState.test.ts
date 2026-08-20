import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_DYNAMIC_WORKFLOW_STATE,
  dynamicWorkflowReducer,
  dynamicWorkflowStageCounter,
  dynamicWorkflowStageProgressLabel,
  dynamicWorkflowStatusLabel,
  formatWorkflowDuration,
} from "./dynamicWorkflowState.js";

test("dynamic workflow folds routing, a parallel stage, review, and synthesis", () => {
  let state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "run_start",
    runId: "run-1",
    workflowMode: "auto",
    workflowMaxStages: 6,
    workflowMaxAgents: 24,
  });
  assert.equal(state.runId, "run-1");
  assert.equal(state.plannedStages, 0, "the stage budget is not presented as a plan");
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_route",
    configuredMode: "auto",
    eligible: true,
    maxStages: 6,
    maxAgents: 24,
    plannedStages: 4,
    reason: "eligible for Main routing",
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_start",
    configuredMode: "auto",
    maxStages: 6,
    maxAgents: 24,
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_start",
    stage: 1,
    pattern: "fan-out-and-synthesize",
    goal: "Inspect independent surfaces",
    maxConcurrency: 2,
    providerConcurrencyCap: 2,
    concurrencyReason: "Grok CLI stability cap",
    controllerRequestedTaskCount: 4,
    deferredTaskCount: 2,
    taskCount: 2,
    agents: [
      { name: "Stage 1 · Sub Agent 1", status: "queued", role: "reviewer" },
      { name: "Stage 1 · Sub Agent 2", status: "queued", skills: ["repo-analysis"] },
    ],
  });
  assert.equal(state.status, "running");
  assert.equal(state.stages[0]?.agents.length, 2);
  assert.equal(state.totalAgents, 2);
  assert.equal(state.stages[0]?.providerConcurrencyCap, 2);
  assert.equal(state.stages[0]?.deferredTaskCount, 2);
  assert.equal(state.stages[0]?.totalWaves, 1);
  assert.equal(state.plannedStages, 4);
  assert.equal(dynamicWorkflowStageCounter(state), "1/4");

  state = dynamicWorkflowReducer(state, {
    type: "a2a_task_state",
    workflowStage: 1,
    agents: [
      { name: "Stage 1 · Sub Agent 1", status: "running", active: true },
      { name: "Stage 1 · Sub Agent 2", status: "succeeded" },
    ],
  });
  assert.equal(state.stages[0]?.agents[0]?.active, true);

  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_progress",
    stage: 1,
    queued: 0,
    active: 1,
    terminal: 1,
    succeeded: 1,
    failed: 0,
    started: 2,
    total: 2,
    elapsedSec: 70,
    estimatedRemainingSec: 85,
    hardDeadlineRemainingSec: 300,
    absoluteDeadlineRemainingSec: 530,
    deadlineExtensionCount: 0,
    etaBasis: "observed terminal throughput",
    currentWave: 1,
    totalWaves: 1,
    agents: [
      { name: "Stage 1 · Sub Agent 1", status: "running", active: true },
      { name: "Stage 1 · Sub Agent 2", status: "succeeded" },
    ],
  });
  assert.equal(state.stages[0]?.terminal, 1);
  assert.equal(state.stages[0]?.estimatedRemainingSec, 85);
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_deadline_extended",
    stage: 1,
    reason: "recent worker progress",
    hardDeadlineRemainingSec: 120,
    absoluteDeadlineRemainingSec: 300,
    deadlineExtensionCount: 1,
  });
  assert.equal(state.stages[0]?.deadlineExtensionCount, 1);
  assert.equal(state.stages[0]?.hardDeadlineRemainingSec, 120);
  assert.equal(
    dynamicWorkflowStageProgressLabel(state.stages[0]!),
    "1/2 done · 1 active · ETA ~2m",
  );

  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_worker_progress",
    stage: 1,
    agents: [
      {
        name: "Stage 1 · Sub Agent 1",
        status: "running",
        active: true,
        progress: "provider wait · 30s",
      },
      { name: "Stage 1 · Sub Agent 2", status: "succeeded" },
    ],
  });
  assert.equal(
    state.stages[0]?.agents[0]?.progress,
    "provider wait · 30s",
  );

  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_worker_timeout",
    stage: 1,
    agents: [
      {
        name: "Stage 1 · Sub Agent 1",
        status: "timed_out",
        active: false,
        progress: "workflow worker inactivity timeout",
      },
      { name: "Stage 1 · Sub Agent 2", status: "succeeded" },
    ],
  });
  assert.equal(state.stages[0]?.agents[0]?.status, "timed_out");

  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_end",
    stage: 1,
    ok: true,
    agents: [
      { name: "Stage 1 · Sub Agent 1", status: "succeeded" },
      { name: "Stage 1 · Sub Agent 2", status: "succeeded" },
    ],
  });
  assert.equal(state.status, "reviewing");
  assert.equal(state.stages[0]?.status, "succeeded");

  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_synthesis_start",
    totalAgents: 2,
  });
  assert.equal(dynamicWorkflowStatusLabel(state), "final synthesis");

  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_end",
    selected: true,
    status: "succeeded",
    stages: 1,
    totalAgents: 2,
  });
  assert.equal(state.active, false);
  assert.equal(state.status, "succeeded");
});

test("planned stage count is live plan metadata, not the max-stage budget", () => {
  let state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "run_start",
    workflowMode: "on",
    workflowMaxStages: 8,
  });
  assert.equal(dynamicWorkflowStageCounter(state), "?/?");
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_controller_end",
    action: "dispatch",
    plannedStages: 6,
  });
  assert.equal(state.plannedStages, 6);
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_start",
    stage: 1,
    plannedStages: 6,
    agents: [],
  });
  assert.equal(dynamicWorkflowStageCounter(state), "1/6");

  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_controller_end",
    action: "dispatch",
    plannedStages: 4,
  });
  assert.equal(state.plannedStages, 4, "Main may revise the remaining plan");
  assert.equal(dynamicWorkflowStageCounter(state), "1/4");

  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_start",
    stage: 5,
    plannedStages: 3,
  });
  assert.equal(state.plannedStages, 5, "the plan can never be shorter than progress already reached");
  assert.equal(state.maxStages, 8);
});

test("planned stages are clamped to the explicit safety budget", () => {
  let state = {
    ...EMPTY_DYNAMIC_WORKFLOW_STATE,
    maxStages: 4,
  };
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_controller_end",
    plannedStages: 99,
  });
  assert.equal(state.plannedStages, 4);
});

test("workflow duration formatting stays compact for terminal status rows", () => {
  assert.equal(formatWorkflowDuration(null), "");
  assert.equal(formatWorkflowDuration(30.1), "31s");
  assert.equal(formatWorkflowDuration(61), "~2m");
  assert.equal(formatWorkflowDuration(3660), "~1h 1m");
});

test("an ineligible automatic route is retained as an explicit skipped state", () => {
  let state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "dynamic_workflow_route",
    configuredMode: "auto",
    eligible: false,
    reason: "dynamic workflow is cloud-model only",
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_end",
    selected: false,
    status: "skipped",
    reason: "dynamic workflow is cloud-model only",
  });
  assert.equal(state.selected, false);
  assert.equal(state.status, "skipped");
  assert.match(state.reason, /cloud-model only/);
});

test("run_finished stops animation, seals the stage, and preserves inspectable failure receipts", () => {
  let state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "dynamic_workflow_start",
    configuredMode: "auto",
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_start",
    stage: 2,
    pattern: "adversarial verification",
    agents: [{
      name: "critic",
      status: "running",
      summary: "provider progress",
    }],
  });
  state = dynamicWorkflowReducer(state, {
    type: "run_finished",
    ok: false,
    reason: "error",
    endedAt: "2026-08-14T10:00:00Z",
    subs: [{
      name: "critic",
      status: "failed",
      reasonCode: "worker_failed",
    }],
  });
  assert.equal(state.active, false);
  assert.equal(state.status, "failed");
  assert.equal(state.stages.length, 1);
  assert.equal(state.stages[0]?.status, "failed");
  assert.equal(state.stages[0]?.agents[0]?.status, "failed");
  assert.equal(
    state.stages[0]?.agents[0]?.failureReason,
    "worker failed · worker_failed",
  );
  assert.deepEqual(state.completion, {
    ok: false,
    reason: "error",
    endedAt: "2026-08-14T10:00:00Z",
    subCount: 1,
    failedSubs: 1,
  });
});

test("unknown and never-started agents fail closed instead of collapsing to queued", () => {
  let state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "dynamic_workflow_stage_start",
    stage: 1,
    pattern: "tui-parallel-barrier-smoke",
    goal: "Four specialist lanes",
    taskCount: 4,
    agents: [
      { name: "Stage 1 · Sub Agent 1", status: "running" },
      { name: "Stage 1 · Sub Agent 2", status: "succeeded" },
      { name: "Stage 1 · Sub Agent 3", status: "never_started" },
      { name: "Stage 1 · Sub Agent 4", status: "not-a-real-status" },
    ],
  });
  const agents = state.stages[0]?.agents ?? [];
  assert.equal(agents[2]?.status, "unstarted");
  assert.equal(agents[3]?.status, "unstarted");
  assert.notEqual(agents[2]?.status, "queued");
  assert.notEqual(agents[3]?.status, "queued");
  assert.equal(state.stages[0]?.queued, 0);
  assert.equal(state.stages[0]?.unstarted, 2);
  assert.equal(state.stages[0]?.failed, 2);
  assert.equal(state.stages[0]?.started, 2);

  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_end",
    stage: 1,
    ok: true,
    startedAgentCount: 4,
    requestedAgentCount: 4,
    succeeded: 4,
    failed: 0,
    agents: [
      { name: "Stage 1 · Sub Agent 1", status: "succeeded" },
      { name: "Stage 1 · Sub Agent 2", status: "succeeded" },
      { name: "Stage 1 · Sub Agent 3", status: "" },
      { name: "Stage 1 · Sub Agent 4", status: "bogus" },
    ],
  });
  assert.equal(state.stages[0]?.status, "failed");
  assert.equal(state.stages[0]?.unstarted, 2);
  assert.equal(state.stages[0]?.failed, 2);
  assert.equal(state.stages[0]?.started, 2);
  assert.equal(state.stages[0]?.succeeded, 2);
});

test("nameless and malformed agent rows count as unstarted, not disappear", () => {
  const state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "dynamic_workflow_stage_start",
    stage: 1,
    pattern: "tui-parallel-barrier-smoke",
    taskCount: 3,
    agents: [
      { name: "Named", status: "running" },
      { name: "", status: "queued" },
      null,
    ],
  });
  assert.equal(state.stages[0]?.agents.length, 3);
  assert.equal(state.stages[0]?.unstarted, 2);
  assert.equal(state.stages[0]?.failed, 2);
  assert.equal(state.stages[0]?.agents[1]?.status, "unstarted");
  assert.equal(state.stages[0]?.agents[2]?.status, "unstarted");
});

test("spoofed event.queued cannot hide never-started agent rows", () => {
  const state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "dynamic_workflow_stage_start",
    stage: 1,
    pattern: "tui-parallel-barrier-smoke",
    taskCount: 2,
    queued: 2,
    agents: [
      { name: "Lane 1", status: "running" },
      { name: "Lane 2", status: "never_started" },
    ],
  });
  assert.equal(state.stages[0]?.queued, 0);
  assert.equal(state.stages[0]?.unstarted, 1);
  assert.equal(state.stages[0]?.failed, 1);
});

test("stage_end without stage_start still fail-closes never-started agents", () => {
  const state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "dynamic_workflow_stage_end",
    stage: 1,
    ok: true,
    agents: [
      { name: "Lane 1", status: "succeeded" },
      { name: "Lane 2", status: "" },
    ],
  });
  assert.equal(state.stages.length, 1);
  assert.equal(state.stages[0]?.status, "failed");
  assert.equal(state.stages[0]?.unstarted, 1);
});

test("run_finished ok:true does not succeed a stage with unstarted lanes", () => {
  let state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "dynamic_workflow_stage_start",
    stage: 1,
    pattern: "tui-parallel-barrier-smoke",
    agents: [
      { name: "Lane 1", status: "succeeded" },
      { name: "Lane 2", status: "unstarted" },
    ],
  });
  state = dynamicWorkflowReducer(state, {
    type: "run_finished",
    mode: "workflow",
    ok: true,
  });
  assert.equal(state.stages[0]?.status, "failed");
  assert.equal(state.status, "failed");
  assert.equal(state.stages[0]?.unstarted, 1);
  assert.equal(state.completion?.ok, false);
});

test("cancelled workflow terminal receipt clears stale review state", () => {
  let state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "dynamic_workflow_controller_start",
    phase: "review",
    stage: 4,
  });
  state = dynamicWorkflowReducer(state, {
    type: "run_finished",
    mode: "workflow",
    reason: "cancel",
    workflowReceipt: {
      controller: {
        status: "cancelled",
        reason: "operator cancelled during stage 4 review",
        reasonCode: "operator_cancelled",
      },
    },
  });
  assert.equal(state.active, false);
  assert.equal(state.status, "cancelled");
  assert.match(state.reason, /operator cancelled/);
});
