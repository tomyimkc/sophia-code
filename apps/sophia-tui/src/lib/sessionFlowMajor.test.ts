import test from "node:test";
import assert from "node:assert/strict";
import type { BridgeEvent } from "./bridge.js";
import {
  EMPTY_SESSION_FLOW_STATE,
  sessionFlowReducer,
  type SessionFlowState,
} from "./sessionFlow.js";
import {
  EMPTY_DYNAMIC_WORKFLOW_STATE,
  dynamicWorkflowReducer,
  type DynamicWorkflowState,
} from "./dynamicWorkflowState.js";
import { projectSessionFlowHierarchy } from "./sessionFlowHierarchy.js";
import { layoutSessionFlow } from "./sessionFlowLayout.js";
import { projectSessionFlowMajorOverview } from "./sessionFlowMajor.js";
import { sessionFlowTopologyText } from "../components/SessionFlowPanel.js";

function fold(events: BridgeEvent[]): SessionFlowState {
  return events.reduce<SessionFlowState>(
    (state, event) =>
      sessionFlowReducer(state, {
        type: "event",
        event,
        sessionId: "active-session",
      }),
    { ...EMPTY_SESSION_FLOW_STATE, sessionId: "active-session" },
  );
}

function major(events: BridgeEvent[]) {
  const raw = fold(events);
  return projectSessionFlowMajorOverview(
    raw,
    projectSessionFlowHierarchy(raw, { level: "overview" }),
  );
}

function dynamicState(runId: string): DynamicWorkflowState {
  let state = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "run_start",
    runId,
    workflowMode: "on",
    workflowMaxStages: 6,
    workflowMaxAgents: 24,
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_route",
    runId,
    configuredMode: "on",
    eligible: true,
    plannedStages: 2,
    maxStages: 6,
    maxAgents: 24,
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_start",
    runId,
    configuredMode: "on",
    plannedStages: 2,
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_start",
    runId,
    stage: 1,
    pattern: "fan-out-and-synthesize",
    goal: "Inspect independent surfaces",
    maxConcurrency: 4,
    agents: [
      { name: "Backend specialist", index: 0, status: "succeeded", role: "backend" },
      { name: "Bridge specialist", index: 1, status: "succeeded", role: "bridge" },
      { name: "TUI specialist", index: 2, status: "succeeded", role: "tui" },
      { name: "Evidence specialist", index: 3, status: "succeeded", role: "evidence" },
    ],
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_end",
    runId,
    stage: 1,
    ok: true,
    agents: [
      { name: "Backend specialist", index: 0, status: "succeeded", role: "backend" },
      { name: "Bridge specialist", index: 1, status: "succeeded", role: "bridge" },
      { name: "TUI specialist", index: 2, status: "succeeded", role: "tui" },
      { name: "Evidence specialist", index: 3, status: "succeeded", role: "evidence" },
    ],
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_controller_start",
    runId,
    phase: "review",
    stage: 1,
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_start",
    runId,
    stage: 2,
    pattern: "adversarial verification",
    goal: "Challenge the specialist reports",
    maxConcurrency: 2,
    agents: [
      { name: "Critic A", index: 0, status: "succeeded", role: "critic" },
      { name: "Critic B", index: 1, status: "succeeded", role: "critic" },
    ],
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_stage_end",
    runId,
    stage: 2,
    ok: true,
    agents: [
      { name: "Critic A", index: 0, status: "succeeded", role: "critic" },
      { name: "Critic B", index: 1, status: "succeeded", role: "critic" },
    ],
  });
  state = dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_synthesis_start",
    runId,
    totalAgents: 6,
  });
  return dynamicWorkflowReducer(state, {
    type: "dynamic_workflow_end",
    runId,
    selected: true,
    status: "succeeded",
    stages: 2,
    totalAgents: 6,
  });
}

function dynamicEvents(runId: string): BridgeEvent[] {
  return [
    { type: "run_start", eventId: `${runId}:run`, runId },
    { type: "dynamic_workflow_route", eventId: `${runId}:route`, runId },
    { type: "dynamic_workflow_start", eventId: `${runId}:start`, runId },
    {
      type: "dynamic_workflow_stage_start",
      eventId: `${runId}:stage-1`,
      runId,
      stage: 1,
      pattern: "fan-out-and-synthesize",
      goal: "Inspect independent surfaces",
      agents: [
        { name: "Backend specialist", index: 0, status: "succeeded" },
        { name: "Bridge specialist", index: 1, status: "succeeded" },
        { name: "TUI specialist", index: 2, status: "succeeded" },
        { name: "Evidence specialist", index: 3, status: "succeeded" },
      ],
    },
    {
      type: "dynamic_workflow_stage_end",
      eventId: `${runId}:stage-1-end`,
      runId,
      stage: 1,
      ok: true,
      agents: [
        { name: "Backend specialist", index: 0, status: "succeeded" },
        { name: "Bridge specialist", index: 1, status: "succeeded" },
        { name: "TUI specialist", index: 2, status: "succeeded" },
        { name: "Evidence specialist", index: 3, status: "succeeded" },
      ],
    },
    {
      type: "dynamic_workflow_controller_start",
      eventId: `${runId}:review-1`,
      runId,
      phase: "review",
      stage: 1,
    },
    {
      type: "dynamic_workflow_stage_start",
      eventId: `${runId}:stage-2`,
      runId,
      stage: 2,
      pattern: "adversarial verification",
      goal: "Challenge the specialist reports",
      agents: [
        { name: "Critic A", index: 0, status: "succeeded" },
        { name: "Critic B", index: 1, status: "succeeded" },
      ],
    },
    {
      type: "dynamic_workflow_stage_end",
      eventId: `${runId}:stage-2-end`,
      runId,
      stage: 2,
      ok: true,
      agents: [
        { name: "Critic A", index: 0, status: "succeeded" },
        { name: "Critic B", index: 1, status: "succeeded" },
      ],
    },
    {
      type: "dynamic_workflow_synthesis_start",
      eventId: `${runId}:synthesis`,
      runId,
    },
    {
      type: "dynamic_workflow_end",
      eventId: `${runId}:end`,
      runId,
      selected: true,
      status: "succeeded",
      stages: 2,
      totalAgents: 6,
    },
  ];
}

function compoundEvents(runId = "compound-run"): BridgeEvent[] {
  return [
    { type: "run_start", eventId: `${runId}:run`, runId },
    {
      type: "workflow_plan_frozen",
      eventId: `${runId}:plan`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 0,
      schema: "sophia.compound-workflow-plan.v1",
      planDigest: "f".repeat(64),
      outputProcessId: "serial",
      processes: [
        { processId: "seed", processLabel: "Seed", childWorkflowIds: ["seed-workflow"], dependsOnNodeIds: [], branchId: "main" },
        { processId: "left", processLabel: "Left branch", childWorkflowIds: ["left-collect", "left-check"], dependsOnNodeIds: ["seed"], branchId: "left-lane" },
        { processId: "right", processLabel: "Right branch", childWorkflowIds: ["right-plan", "right-run", "right-check"], dependsOnNodeIds: ["seed"], branchId: "right-lane" },
        { processId: "serial", processLabel: "Serial synthesis", childWorkflowIds: ["synthesize"], dependsOnNodeIds: ["fan-in"], branchId: "main" },
      ],
      joins: [
        { joinId: "fan-in", expectedNodeIds: ["left", "right"] },
      ],
    },
    {
      type: "workflow_process_start",
      eventId: `${runId}:seed:start`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      processId: "seed",
      processLabel: "Seed",
      childWorkflowIds: ["seed-workflow"],
      dependsOnNodeIds: [],
      branchId: "main",
      workflowId: "seed-workflow",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_process_end",
      eventId: `${runId}:seed:end`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 2,
      processId: "seed",
      processLabel: "Seed",
      childWorkflowIds: ["seed-workflow"],
      dependsOnNodeIds: [],
      branchId: "main",
      state: "succeeded",
    },
    {
      type: "workflow_output_committed",
      eventId: `${runId}:seed:output`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 3,
      processId: "seed",
      artifactRef: "artifacts/seed.json",
      digest: "1".repeat(64),
    },
    {
      type: "workflow_process_start",
      eventId: `${runId}:left:start`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 4,
      processId: "left",
      processLabel: "Left branch",
      childWorkflowIds: ["left-collect", "left-check"],
      dependsOnNodeIds: ["seed"],
      branchId: "left-lane",
      workflowId: "left-collect",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_process_start",
      eventId: `${runId}:right:start`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 5,
      processId: "right",
      processLabel: "Right branch",
      childWorkflowIds: ["right-plan", "right-run", "right-check"],
      dependsOnNodeIds: ["seed"],
      branchId: "right-lane",
      workflowId: "right-plan",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_process_end",
      eventId: `${runId}:left:end`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 6,
      processId: "left",
      processLabel: "Left branch",
      childWorkflowIds: ["left-collect", "left-check"],
      dependsOnNodeIds: ["seed"],
      branchId: "left-lane",
      state: "succeeded",
    },
    {
      type: "workflow_output_committed",
      eventId: `${runId}:left:output`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 7,
      processId: "left",
      artifactRef: "artifacts/left.json",
      digest: "2".repeat(64),
    },
    {
      type: "workflow_process_end",
      eventId: `${runId}:right:end`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 8,
      processId: "right",
      processLabel: "Right branch",
      childWorkflowIds: ["right-plan", "right-run", "right-check"],
      dependsOnNodeIds: ["seed"],
      branchId: "right-lane",
      state: "succeeded",
    },
    {
      type: "workflow_output_committed",
      eventId: `${runId}:right:output`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 9,
      processId: "right",
      artifactRef: "artifacts/right.json",
      digest: "3".repeat(64),
    },
    {
      type: "workflow_join_wait",
      eventId: `${runId}:join:wait`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 10,
      joinId: "fan-in",
      expectedNodeIds: ["left", "right"],
      completedNodeIds: ["left"],
      state: "pending",
    },
    {
      type: "workflow_join_released",
      eventId: `${runId}:join:released`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 11,
      joinId: "fan-in",
      expectedNodeIds: ["left", "right"],
      completedNodeIds: ["left", "right"],
    },
    {
      type: "workflow_process_start",
      eventId: `${runId}:serial:start`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 12,
      processId: "serial",
      processLabel: "Serial synthesis",
      childWorkflowIds: ["synthesize"],
      dependsOnNodeIds: ["fan-in"],
      branchId: "main",
      workflowId: "synthesize",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_process_end",
      eventId: `${runId}:serial:end`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 13,
      processId: "serial",
      processLabel: "Serial synthesis",
      childWorkflowIds: ["synthesize"],
      dependsOnNodeIds: ["fan-in"],
      branchId: "main",
      state: "succeeded",
    },
    {
      type: "workflow_output_committed",
      eventId: `${runId}:serial:output`,
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 14,
      processId: "serial",
      artifactRef: "artifacts/final.json",
      digest: "a".repeat(64),
    },
  ];
}

function fastFanoutEvents(runId: string): BridgeEvent[] {
  const agents = Array.from({ length: 6 }, (_, index) => ({
    name: `Specialist ${index + 1}`,
    index,
    status: "succeeded",
  }));
  return [
    { type: "run_start", eventId: `${runId}:run`, runId },
    { type: "dynamic_workflow_route", eventId: `${runId}:route`, runId },
    {
      type: "dynamic_workflow_start",
      eventId: `${runId}:start`,
      runId,
      pattern: "tui-parallel-barrier-smoke",
    },
    {
      type: "dynamic_workflow_stage_start",
      eventId: `${runId}:stage-1`,
      runId,
      stage: 1,
      pattern: "tui-parallel-barrier-smoke",
      goal: "Inspect independent TUI surfaces",
      agents,
    },
    {
      type: "dynamic_workflow_stage_end",
      eventId: `${runId}:stage-1-end`,
      runId,
      stage: 1,
      ok: true,
      agents,
    },
    {
      type: "dynamic_workflow_synthesis_start",
      eventId: `${runId}:synthesis`,
      runId,
      totalAgents: agents.length,
    },
    {
      type: "dynamic_workflow_end",
      eventId: `${runId}:end`,
      runId,
      selected: true,
      status: "succeeded",
      stages: 1,
      totalAgents: agents.length,
    },
  ];
}

test("ordinary runs render only Main Agent, Workflow, and Output blocks", () => {
  const projection = major([
    { type: "run_start", runId: "run-1", goal: "Inspect the active session" },
    { type: "model_preflight", runId: "run-1", model: "deepseek-chat" },
    { type: "tool_call", runId: "run-1", tool: "read_file" },
    { type: "tool_result", runId: "run-1", tool: "read_file", ok: true },
    { type: "result", runId: "run-1", ok: true, detail: "Inspection complete" },
    { type: "run_finished", runId: "run-1", ok: true },
  ]);

  assert.deepEqual(
    projection.state.nodes.map((node) => node.label),
    ["Main Agent", "Workflow", "Output"],
  );
  assert.deepEqual(
    projection.state.edges.map((item) => item.kind),
    ["sequence", "sequence"],
  );
  assert.equal(
    projection.state.nodes.some((node) =>
      ["tool", "model", "agent"].includes(node.kind)
    ),
    false,
  );
  const workflow = projection.state.nodes[1]!;
  assert.ok(
    projection.metadataByNodeId[workflow.id]?.sourceNodeIds.length >= 3,
  );
  assert.equal(projection.state.sessionId, "active-session");
});

test("fast parallel overview fans declared lanes into a visible all-of barrier", () => {
  const runId = "fast-fanout-overview";
  const raw = fold(fastFanoutEvents(runId));
  const workflow = dynamicWorkflowReducer(
    EMPTY_DYNAMIC_WORKFLOW_STATE,
    { type: "run_start", runId, workflowMode: "on", workflowMaxAgents: 64 },
  );
  const hydrated = dynamicWorkflowReducer(
    workflow,
    {
      type: "dynamic_workflow_stage_start",
      runId,
      stage: 1,
      pattern: "tui-parallel-barrier-smoke",
      goal: "Inspect independent TUI surfaces",
      agents: Array.from({ length: 6 }, (_, index) => ({
        name: `Specialist ${index + 1}`,
        index,
        status: "succeeded",
      })),
    },
  );
  const projection = projectSessionFlowMajorOverview(
    raw,
    projectSessionFlowHierarchy(raw, { level: "overview" }),
    hydrated,
  );
  const labels = projection.state.nodes.map((node) => node.label);
  const processNodes = projection.state.nodes.filter(
    (node) => node.processNode === true,
  );
  const synthesis = projection.state.nodes.find(
    (node) => node.label === "Synthesis · Main Agent",
  );
  const main = projection.state.nodes.find(
    (node) => node.label === "Main Agent · Plan & Dispatch",
  );
  const barrier = projection.state.nodes.find(
    (node) => node.label === "Barrier · Stage 1",
  );

  assert.ok(main);
  assert.ok(synthesis);
  assert.ok(barrier);
  assert.equal(barrier.eventType, "parallel_barrier");
  assert.equal(processNodes.length, 6);
  assert.ok(labels.includes("Output · Receipt"));
  assert.equal(labels.some((label) => /critic|review/i.test(label)), false);
  assert.equal(
    projection.state.nodes.some((node) => node.eventType === "parallel_critic_review"),
    false,
  );
  assert.equal(
    projection.state.edges.filter((item) => item.target === barrier.id).length,
    6,
  );
  assert.equal(
    projection.state.edges.filter((item) => item.source === barrier.id).length,
    1,
  );
  assert.equal(
    projection.state.edges.some(
      (item) => item.source === barrier.id && item.target === synthesis!.id,
    ),
    true,
  );
  assert.equal(
    projection.state.edges.filter((item) => item.target === synthesis!.id).length,
    1,
  );
  assert.equal(
    projection.state.edges.filter((item) => item.source === main!.id).length,
    6,
  );
  assert.equal(
    sessionFlowTopologyText(projection.state),
    "Main Agent · Plan & Dispatch → 6 parallel specialist lanes → Barrier · Stage 1 → Synthesis · Main Agent → Output · Receipt",
  );
});

test("fast parallel overview fail-closes the barrier when a declared lane never started", () => {
  const runId = "fast-fanout-unstarted";
  const agents = [
    { name: "Specialist 1", index: 0, status: "succeeded" },
    { name: "Specialist 2", index: 1, status: "succeeded" },
    { name: "Specialist 3", index: 2, status: "unstarted" },
    { name: "Specialist 4", index: 3, status: "never_started" },
  ];
  const raw = fold([
    { type: "run_start", eventId: `${runId}:run`, runId },
    {
      type: "dynamic_workflow_start",
      eventId: `${runId}:start`,
      runId,
      pattern: "tui-parallel-barrier-smoke",
    },
    {
      type: "dynamic_workflow_stage_start",
      eventId: `${runId}:stage-1`,
      runId,
      stage: 1,
      pattern: "tui-parallel-barrier-smoke",
      agents,
    },
  ]);
  const workflow = dynamicWorkflowReducer(
    EMPTY_DYNAMIC_WORKFLOW_STATE,
    { type: "run_start", runId, workflowMode: "on", workflowMaxAgents: 64 },
  );
  const hydrated = dynamicWorkflowReducer(
    workflow,
    {
      type: "dynamic_workflow_stage_start",
      runId,
      stage: 1,
      pattern: "tui-parallel-barrier-smoke",
      agents,
    },
  );
  const projection = projectSessionFlowMajorOverview(
    raw,
    projectSessionFlowHierarchy(raw, { level: "overview" }),
    hydrated,
  );
  const barrier = projection.state.nodes.find(
    (node) => node.label === "Barrier · Stage 1",
  );
  assert.ok(barrier);
  assert.equal(barrier.status, "failed");
  assert.match(barrier.detail || "", /2\/4 lanes complete/);
});

test("dynamic parallel overview renders fan-out lanes, barriers, critics, synthesis, and receipt", () => {
  const runId = "parallel-overview";
  const raw = fold(dynamicEvents(runId));
  const hierarchy = projectSessionFlowHierarchy(raw, { level: "overview" });
  const projection = projectSessionFlowMajorOverview(
    raw,
    hierarchy,
    dynamicState(runId),
  );
  const labels = projection.state.nodes.map((node) => node.label);

  assert.ok(labels.includes("Main Agent · Plan & Dispatch"));
  assert.equal(
    projection.state.nodes.filter(
      (node) => node.processMember === true && node.processId?.includes("stage-1-lane"),
    ).length,
    4,
  );
  assert.equal(
    projection.state.nodes.filter(
      (node) => node.processMember === true && node.processId?.includes("stage-2-lane"),
    ).length,
    2,
  );
  assert.ok(labels.includes("Barrier · Stage 1"));
  assert.ok(labels.includes("Barrier · Stage 2"));
  assert.ok(labels.includes("Review · Stage 1"));
  assert.ok(labels.includes("Review · Stage 2"));
  assert.ok(labels.includes("Synthesis · Main Agent"));
  assert.ok(labels.includes("Output · Receipt"));
  assert.equal(labels.includes("Workflow"), false, "the dynamic overview is no longer a three-node capsule");

  const layout = layoutSessionFlow(projection.state);
  const stageOneLanes = layout.nodes.filter(
    (item) => item.node.processMember === true && item.node.processId?.includes("stage-1-lane"),
  );
  assert.equal(new Set(stageOneLanes.map((item) => item.row)).size, 4);
  const stageOneBarrier = projection.state.nodes.find(
    (node) => node.label === "Barrier · Stage 1",
  )!;
  const stageOneProcesses = projection.state.nodes.filter(
    (node) => node.processNode === true && node.processId?.includes("stage-1-lane"),
  );
  assert.deepEqual(
    new Set(
      projection.state.edges
        .filter((item) => item.target === stageOneBarrier.id)
        .map((item) => item.source),
    ),
    new Set(stageOneProcesses.map((node) => node.id)),
    "the barrier has one incoming edge from every parallel lane",
  );
  const stageTwoProcesses = projection.state.nodes.filter(
    (node) => node.processNode === true && node.processId?.includes("stage-2-lane"),
  );
  const stageOneBarrierId = stageOneBarrier.id;
  assert.ok(
    stageTwoProcesses.every((node) =>
      node.dependsOnNodeIds?.includes(`stage-1-barrier`)
      || projection.state.edges.some(
        (item) =>
          item.source === stageOneBarrierId
          && item.target === node.id,
      )
    ),
    "the second fan-out is explicitly downstream of the first all-of barrier",
  );
  assert.ok(layout.edges.some((item) => item.kind === "handoff"));
  assert.ok(
    projection.state.edges.some(
      (item) =>
        item.source.includes("stage-2-review")
        && item.target.includes(":synthesis")
        && item.kind === "handoff",
    ),
  );
});

test("failed parallel lane adds an explicit dashed recovery branch", () => {
  const runId = "parallel-recovery";
  const raw = fold([
    ...dynamicEvents(runId).slice(0, 4),
    {
      type: "dynamic_workflow_stage_end",
      eventId: `${runId}:stage-1-failed`,
      runId,
      stage: 1,
      ok: false,
      agents: [
        { name: "Backend specialist", index: 0, status: "failed", reason: "receipt missing" },
        { name: "Bridge specialist", index: 1, status: "succeeded" },
      ],
    },
  ]);
  let workflow = dynamicWorkflowReducer(EMPTY_DYNAMIC_WORKFLOW_STATE, {
    type: "run_start",
    runId,
    workflowMode: "on",
  });
  workflow = dynamicWorkflowReducer(workflow, {
    type: "dynamic_workflow_stage_start",
    runId,
    stage: 1,
    pattern: "parallel verification",
    agents: [
      { name: "Backend specialist", index: 0, status: "failed" },
      { name: "Bridge specialist", index: 1, status: "succeeded" },
    ],
  });
  workflow = dynamicWorkflowReducer(workflow, {
    type: "dynamic_workflow_stage_end",
    runId,
    stage: 1,
    ok: false,
    agents: [
      { name: "Backend specialist", index: 0, status: "failed", reason: "receipt missing" },
      { name: "Bridge specialist", index: 1, status: "succeeded" },
    ],
  });
  const projection = projectSessionFlowMajorOverview(
    raw,
    projectSessionFlowHierarchy(raw, { level: "overview" }),
    workflow,
  );
  const recovery = projection.state.nodes.find(
    (node) => node.label === "Recovery · Retry branch",
  );
  assert.ok(recovery);
  const barrier = projection.state.nodes.find(
    (node) => node.label === "Barrier · Stage 1",
  );
  assert.ok(barrier);
  assert.ok(
    projection.state.edges.some(
      (item) =>
        item.source === barrier!.id
        && item.target === recovery!.id
        && item.kind === "handoff",
    ),
  );
});

test("compound overview preserves process frames, all-of gating, and one terminal Output", () => {
  const raw = fold(compoundEvents());
  const hierarchy = projectSessionFlowHierarchy(raw, { level: "overview" });
  const projection = projectSessionFlowMajorOverview(raw, hierarchy);
  const layout = layoutSessionFlow(projection.state);
  const frameByProcess = new Map(
    layout.processFrames.map((frame) => [frame.processId, frame]),
  );
  const main = layout.nodes.find((item) => item.node.label === "Main Agent");
  const join = layout.nodes.find((item) => item.node.joinId === "fan-in");
  const output = layout.nodes.find((item) => item.node.label === "Output");
  const seed = frameByProcess.get("seed");
  const left = frameByProcess.get("left");
  const right = frameByProcess.get("right");
  const serial = frameByProcess.get("serial");
  assert.ok(main);
  assert.ok(join);
  assert.ok(output);
  assert.ok(seed);
  assert.ok(left);
  assert.ok(right);
  assert.ok(serial);
  assert.equal(seed.memberNodeIds.length, 1);
  assert.equal(left.memberNodeIds.length, 2);
  assert.equal(right.memberNodeIds.length, 3);
  assert.equal(serial.memberNodeIds.length, 1);
  assert.ok(
    [seed, left, right, serial].every((frame) =>
      projection.state.nodes.some(
        (node) => node.id === frame.processNodeId && node.processNode === true,
      )),
    "every frame has a stable semantic process node",
  );

  const leftInput = layout.nodes.find((item) => item.id === left.inputNodeId)!;
  const rightInput = layout.nodes.find((item) => item.id === right.inputNodeId)!;
  assert.ok(main.x < seed.x);
  assert.equal(leftInput.layer, rightInput.layer);
  assert.notEqual(leftInput.row, rightInput.row);
  assert.ok(join.x > left.x + left.width - 1);
  assert.ok(join.x > right.x + right.width - 1);
  assert.ok(serial.x > join.x + join.width - 1);
  assert.ok(output.x > serial.x + serial.width - 1);
  assert.ok(layout.edges.every((item) => item.arrowDirection === "right"));

  const incoming = (nodeId: string) =>
    projection.state.edges.filter((item) => item.target === nodeId);
  assert.deepEqual(
    new Set(incoming(join.id).map((item) => item.source)),
    new Set([left.processNodeId, right.processNodeId]),
    "the join is gated only by every declared parallel predecessor",
  );
  assert.deepEqual(
    incoming(serial.processNodeId).map((item) => item.source),
    [join.id],
    "serial continuation cannot bypass the all-of join",
  );
  assert.deepEqual(
    incoming(output.id).map((item) => item.source),
    [serial.processNodeId],
    "only the final sink process feeds Output",
  );

  const projectedOutput = projection.state.nodes.find(
    (node) => node.id === output.id,
  );
  assert.equal(
    projection.state.nodes.some(
      (node) => node.eventType === "workflow_output_committed",
    ),
    false,
    "intermediate artifact receipts are folded rather than rendered as outputs",
  );
  assert.equal(projectedOutput?.status, "succeeded");
  assert.equal(projectedOutput?.provenance?.sourceNodeIds.length, 4);
  assert.deepEqual(
    projection.metadataByNodeId[output.id]?.sourceEventTypes,
    ["workflow_output_committed"],
  );
});

test("a frozen header alone renders complete pending topology from Main through explicit Output", () => {
  const projection = major(
    compoundEvents("header-only").filter(
      (event) =>
        event.type === "run_start" || event.type === "workflow_plan_frozen",
    ),
  );
  const main = projection.state.nodes.find((node) => node.label === "Main Agent")!;
  const seed = projection.state.nodes.find(
    (node) => node.processNode && node.processId === "seed",
  )!;
  const serial = projection.state.nodes.find(
    (node) => node.processNode && node.processId === "serial",
  )!;
  const output = projection.state.nodes.find((node) => node.label === "Output")!;

  assert.equal(output.status, "pending");
  assert.equal(
    projection.state.nodes.some(
      (node) => node.eventType === "workflow_plan_frozen",
    ),
    false,
  );
  assert.ok(
    projection.state.edges.some(
      (item) => item.source === main.id && item.target === seed.id,
    ),
  );
  assert.ok(
    projection.state.edges.some(
      (item) => item.source === serial.id && item.target === output.id,
    ),
  );
});

test("terminal success and receipt stay pending until the full declared ancestor closure completes", () => {
  const projection = major(
    compoundEvents("partial-closure").filter(
      (event) =>
        event.type === "run_start"
        || event.type === "workflow_plan_frozen"
        || event.eventId === "partial-closure:serial:end"
        || event.eventId === "partial-closure:serial:output",
    ),
  );
  const terminal = projection.state.nodes.find(
    (node) => node.processNode && node.processId === "serial",
  );
  const output = projection.state.nodes.find((node) => node.label === "Output");

  assert.equal(terminal?.status, "succeeded");
  assert.equal(output?.status, "pending");
  assert.equal(output?.observedSequence !== null, true);
});

test("cold replay of engine events settles synthetic Main without a run boundary receipt", () => {
  const raw = fold(
    [
      ...compoundEvents("cold-engine").filter(
        (event) => event.type !== "run_start",
      ),
      {
        type: "compound_workflow_status",
        eventId: "cold-engine:summary",
        durableRunCount: 1,
      },
    ],
  );
  const projection = projectSessionFlowMajorOverview(
    raw,
    projectSessionFlowHierarchy(raw, { level: "overview" }),
  );
  const runRoots = raw.nodes.filter(
    (node) => node.runId === "cold-engine" && node.kind === "run",
  );

  assert.equal(runRoots.length, 1);
  assert.equal(raw.nodes.some((node) => node.runId === "session"), false);
  assert.equal(raw.activeRunId, "");
  assert.equal(
    projection.state.nodes.find((node) => node.label === "Main Agent")?.status,
    "succeeded",
  );
  assert.equal(
    projection.state.nodes.find((node) => node.label === "Output")?.status,
    "succeeded",
  );
});

test("compound overview preserves nested join-to-join gates in actual backend order", () => {
  const runId = "nested-joins";
  const projection = major([
    { type: "run_start", eventId: "run", runId },
    {
      type: "workflow_plan_frozen",
      eventId: "plan",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 0,
      schema: "sophia.compound-workflow-plan.v1",
      planDigest: "f".repeat(64),
      outputProcessId: "serial",
      processes: [
        { processId: "seed", processLabel: "Seed", branchId: "main", childWorkflowIds: ["collect", "verify"], dependsOnNodeIds: [] },
        { processId: "peer", processLabel: "Peer", branchId: "peer", childWorkflowIds: ["peer-workflow"], dependsOnNodeIds: [] },
        { processId: "side", processLabel: "Side", branchId: "side", childWorkflowIds: ["side-workflow"], dependsOnNodeIds: [] },
        { processId: "serial", processLabel: "Finish", branchId: "main", childWorkflowIds: ["finish"], dependsOnNodeIds: ["join-b"] },
      ],
      joins: [
        { joinId: "join-a", expectedNodeIds: ["seed", "peer"] },
        { joinId: "join-b", expectedNodeIds: ["join-a", "side"] },
      ],
    },
    {
      type: "workflow_process_end",
      eventId: "peer-end",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      processId: "peer",
      processLabel: "Peer",
      branchId: "peer",
      childWorkflowIds: ["peer-workflow"],
      dependsOnNodeIds: [],
      state: "succeeded",
    },
    {
      type: "workflow_process_end",
      eventId: "side-end",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 2,
      processId: "side",
      processLabel: "Side",
      branchId: "side",
      childWorkflowIds: ["side-workflow"],
      dependsOnNodeIds: [],
      state: "succeeded",
    },
    {
      type: "workflow_process_end",
      eventId: "seed-end",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 3,
      processId: "seed",
      processLabel: "Seed",
      branchId: "main",
      childWorkflowIds: ["collect", "verify"],
      dependsOnNodeIds: [],
      state: "succeeded",
    },
    {
      type: "workflow_join_released",
      eventId: "join-a-release",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 4,
      joinId: "join-a",
      expectedNodeIds: ["seed", "peer"],
      completedNodeIds: ["seed", "peer"],
    },
    {
      type: "workflow_join_released",
      eventId: "join-b-release",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 5,
      joinId: "join-b",
      expectedNodeIds: ["join-a", "side"],
      completedNodeIds: ["join-a", "side"],
    },
    {
      type: "workflow_process_end",
      eventId: "serial-end",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 6,
      processId: "serial",
      processLabel: "Finish",
      branchId: "main",
      childWorkflowIds: ["finish"],
      dependsOnNodeIds: ["join-b"],
      state: "succeeded",
    },
    {
      type: "workflow_output_committed",
      eventId: "output",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 7,
      processId: "serial",
      artifactRef: "final.json",
      digest: "a".repeat(64),
    },
  ]);
  const layout = layoutSessionFlow(projection.state);
  const seed = layout.nodes.find(
    (item) => item.node.processNode && item.node.processId === "seed",
  )!;
  const joinA = layout.nodes.find((item) => item.node.joinId === "join-a")!;
  const joinB = layout.nodes.find((item) => item.node.joinId === "join-b")!;
  const serial = layout.nodes.find(
    (item) => item.node.processNode && item.node.processId === "serial",
  )!;
  const output = layout.nodes.find((item) => item.node.label === "Output")!;
  const hasEdge = (source: string, target: string) =>
    projection.state.edges.some(
      (item) => item.source === source && item.target === target,
    );

  assert.ok(hasEdge(seed.id, joinA.id));
  assert.ok(hasEdge(joinA.id, joinB.id));
  assert.ok(hasEdge(joinB.id, serial.id));
  assert.ok(hasEdge(serial.id, output.id));
  assert.ok(seed.x < joinA.x);
  assert.ok(joinA.x < joinB.x);
  assert.ok(joinB.x < serial.x);
  assert.ok(serial.x < output.x);
  assert.equal(
    projection.state.edges.some(
      (item) => item.source === seed.id && item.target === joinB.id,
    ),
    false,
    "the nested all-of gate cannot be bypassed",
  );
});

test("compound adverse process and join states settle both Main and Output", () => {
  const reconciliation = major(
    compoundEvents("needs-reconciliation").map((event) =>
      event.eventId === "needs-reconciliation:serial:end"
        ? { ...event, state: "needs_reconciliation" }
        : event
    ),
  );
  const blockedOutput = reconciliation.state.nodes.find(
    (node) => node.label === "Output",
  );
  const blockedMain = reconciliation.state.nodes.find(
    (node) => node.label === "Main Agent",
  );
  assert.equal(blockedOutput?.status, "blocked");
  assert.equal(blockedMain?.status, "blocked");

  const failed = major(
    compoundEvents("failed-join").map((event) =>
      event.eventId === "failed-join:join:released"
        ? { ...event, type: "workflow_join_failed", state: "failed", ok: false }
        : event
    ),
  );
  assert.equal(
    failed.state.nodes.find((node) => node.label === "Output")?.status,
    "failed",
  );
  assert.equal(
    failed.state.nodes.find((node) => node.label === "Main Agent")?.status,
    "failed",
  );
});

test("compound runs do not fabricate cross-run artifact handoffs from chronology", () => {
  const projection = major([
    ...compoundEvents("compound-first"),
    { type: "run_start", eventId: "next:run", runId: "next-run" },
    { type: "result", eventId: "next:result", runId: "next-run", ok: true },
  ]);
  const compoundOutput = projection.state.nodes.find(
    (node) => node.runId === "compound-first" && node.label === "Output",
  );
  const nextMain = projection.state.nodes.find(
    (node) => node.runId === "next-run" && node.label === "Main Agent",
  );
  assert.ok(compoundOutput);
  assert.ok(nextMain);
  assert.equal(
    projection.state.edges.some(
      (item) => item.source === compoundOutput.id && item.target === nextMain.id,
    ),
    false,
  );
});

test("a normal run does not fabricate an artifact handoff into a later compound run", () => {
  const projection = major([
    { type: "run_start", eventId: "normal:run", runId: "normal-first" },
    { type: "result", eventId: "normal:result", runId: "normal-first", ok: true },
    { type: "run_finished", eventId: "normal:finished", runId: "normal-first", ok: true },
    ...compoundEvents("compound-second"),
  ]);
  const normalOutput = projection.state.nodes.find(
    (node) => node.runId === "normal-first" && node.label === "Output",
  )!;
  const compoundMain = projection.state.nodes.find(
    (node) => node.runId === "compound-second" && node.label === "Main Agent",
  )!;

  assert.equal(
    projection.state.edges.some(
      (item) => item.source === normalOutput.id && item.target === compoundMain.id,
    ),
    false,
  );
});

test("intermediate artifact receipts do not complete the terminal Output", () => {
  const events = compoundEvents().filter(
    (event) => event.eventId !== "compound-run:serial:output",
  );
  const projection = major(events);
  const output = projection.state.nodes.find((node) => node.label === "Output");
  assert.ok(output);
  assert.equal(output.status, "pending");
  assert.equal(output.observedSequence, null);
  assert.equal(
    output.provenance?.sourceNodeIds.length,
    3,
    "intermediate receipts remain available as folded provenance",
  );
});

test("compound Output waits for process end when output commits first", () => {
  const runId = "commit-before-end";
  const beforeEnd: BridgeEvent[] = [
    { type: "run_start", eventId: "run", runId },
    {
      type: "workflow_plan_frozen",
      eventId: "plan",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 0,
      schema: "sophia.compound-workflow-plan.v1",
      planDigest: "f".repeat(64),
      outputProcessId: "terminal",
      processes: [
        { processId: "terminal", processLabel: "Terminal", branchId: "main", childWorkflowIds: ["produce"], dependsOnNodeIds: [] },
      ],
      joins: [],
    },
    {
      type: "workflow_process_start",
      eventId: "start",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      processId: "terminal",
      processLabel: "Terminal",
      branchId: "main",
      childWorkflowIds: ["produce"],
      dependsOnNodeIds: [],
      workflowId: "produce",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_output_committed",
      eventId: "commit",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 2,
      processId: "terminal",
      artifactRef: "final.json",
      digest: "a".repeat(64),
    },
  ];
  const waiting = major(beforeEnd).state.nodes.find(
    (node) => node.label === "Output",
  );
  const completed = major([
    ...beforeEnd,
    {
      type: "workflow_process_end",
      eventId: "end",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 3,
      processId: "terminal",
      processLabel: "Terminal",
      branchId: "main",
      childWorkflowIds: ["produce"],
      dependsOnNodeIds: [],
      state: "succeeded",
    },
  ]).state.nodes.find((node) => node.label === "Output");

  assert.equal(waiting?.status, "pending");
  assert.equal(completed?.status, "succeeded");
});

test("generic successful results cannot authorize compound Output without its receipt", () => {
  const runId = "generic-success-only";
  const projection = major([
    { type: "run_start", eventId: "run", runId },
    {
      type: "workflow_plan_frozen",
      eventId: "plan",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 0,
      schema: "sophia.compound-workflow-plan.v1",
      planDigest: "f".repeat(64),
      outputProcessId: "terminal",
      processes: [
        { processId: "terminal", processLabel: "Terminal", branchId: "main", childWorkflowIds: ["produce"], dependsOnNodeIds: [] },
      ],
      joins: [],
    },
    {
      type: "workflow_process_end",
      eventId: "end",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      processId: "terminal",
      processLabel: "Terminal",
      branchId: "main",
      childWorkflowIds: ["produce"],
      dependsOnNodeIds: [],
      state: "succeeded",
    },
    { type: "result", eventId: "result", runId, ok: true },
    { type: "run_finished", eventId: "finished", runId, ok: true },
  ]);
  const output = projection.state.nodes.find((node) => node.label === "Output");

  assert.equal(output?.status, "pending");
  assert.deepEqual(
    projection.metadataByNodeId[output!.id]?.sourceEventTypes,
    ["result", "run_finished"],
    "generic terminal receipts remain provenance-only",
  );
});

test("compound terminal receipts without a frozen header remain unauthorized", () => {
  const runId = "missing-header";
  const projection = major([
    { type: "workflow_process_end", eventId: "end", runId, workflowEventVersion: 1, workflowEventSequence: 1, processId: "terminal", processLabel: "Terminal", branchId: "main", childWorkflowIds: ["produce"], dependsOnNodeIds: [], state: "succeeded" },
    { type: "workflow_output_committed", eventId: "output", runId, workflowEventVersion: 1, workflowEventSequence: 2, processId: "terminal", artifactRef: "final.json", digest: "a".repeat(64) },
  ]);

  assert.equal(
    projection.state.nodes.find((node) => node.label === "Output")?.status,
    "pending",
  );
});

test("late workflow telemetry cannot reorder one merged run harness after output", () => {
  const runId = "run-late-workflow";
  const beforeRaw = fold([
    { type: "run_start", runId, goal: "Keep the merged harness ordered" },
    { type: "final", runId, text: "Final answer arrived first" },
  ]);
  const beforeProjection = projectSessionFlowMajorOverview(
    beforeRaw,
    projectSessionFlowHierarchy(beforeRaw, { level: "overview" }),
  );
  const groupedPreviousLayout = layoutSessionFlow(beforeProjection.state);
  const previousLayout = {
    ...groupedPreviousLayout,
    nodes: groupedPreviousLayout.nodes.map((node, index) => ({
      ...node,
      row: index,
      y: 1 + index * 5,
    })),
  };
  const raw = fold([
    { type: "run_start", runId, goal: "Keep the merged harness ordered" },
    { type: "final", runId, text: "Final answer arrived first" },
    {
      type: "dynamic_workflow_stage_progress",
      runId,
      stage: 1,
      detail: "Late workflow telemetry",
    },
  ]);
  const projection = projectSessionFlowMajorOverview(
    raw,
    projectSessionFlowHierarchy(raw, { level: "overview" }),
  );
  const nodes = projection.state.nodes.filter((node) => node.runId === runId);
  const sequenceBase = Math.min(
    ...raw.nodes.filter((node) => node.runId === runId).map((node) => node.sequence),
  );

  assert.deepEqual(
    nodes.map((node) => [node.label, node.sequence]),
    [
      ["Main Agent", sequenceBase],
      ["Workflow", sequenceBase + 0.25],
      ["Output", sequenceBase + 0.5],
    ],
  );
  assert.equal(new Set(nodes.map((node) => node.harnessId)).size, 1);

  const main = nodes[0]!;
  const workflow = nodes[1]!;
  const output = nodes[2]!;
  const rawOutput = raw.nodes.find((node) => node.eventType === "final");
  const rawWorkflow = raw.nodes.find(
    (node) => node.eventType === "dynamic_workflow_stage_progress",
  );
  assert.ok(rawOutput);
  assert.ok(rawWorkflow);
  assert.ok(rawOutput.sequence < rawWorkflow.sequence);
  assert.ok(output.provenance?.sourceNodeIds.includes(rawOutput.id));
  assert.ok(workflow.provenance?.sourceNodeIds.includes(rawWorkflow.id));

  const metadata = nodes.map((node) => projection.metadataByNodeId[node.id]);
  assert.ok(
    metadata.every((item) =>
      item?.summary.includes(
        `Merged run harness ${runId}: Main Agent → Workflow → Output`,
      )
    ),
  );
  const harnessIds = metadata.map((item) => item?.hierarchyPath[0]);
  assert.equal(new Set(harnessIds).size, 1);
  assert.match(harnessIds[0] || "", /:harness$/);
  assert.deepEqual(
    metadata.map((item) => item?.hierarchyPath),
    nodes.map((node) => [harnessIds[0], node.id]),
  );

  assert.ok(
    projection.state.edges.some(
      (item) =>
        item.source === workflow.id
        && item.target === output.id
        && item.kind === "sequence",
    ),
  );

  const layout = layoutSessionFlow(projection.state, { previousLayout });
  const mainLayout = layout.nodes.find((item) => item.id === main.id);
  const workflowLayout = layout.nodes.find((item) => item.id === workflow.id);
  const outputLayout = layout.nodes.find((item) => item.id === output.id);
  assert.ok(mainLayout);
  assert.ok(workflowLayout);
  assert.ok(outputLayout);
  assert.ok(mainLayout.x < workflowLayout.x);
  assert.ok(workflowLayout.x < outputLayout.x);
  assert.equal(mainLayout.y, workflowLayout.y);
  assert.equal(workflowLayout.y, outputLayout.y);
  assert.ok(
    layout.edges.some(
      (item) => item.source === workflow.id && item.target === output.id,
    ),
  );
});

test("a pending harness output does not replace live workflow focus", () => {
  const runId = "run-live-workflow";
  const raw = fold([
    { type: "run_start", runId, goal: "Track the active harness role" },
    {
      type: "dynamic_workflow_stage_progress",
      runId,
      stage: 1,
      detail: "Workflow is still running",
    },
  ]);
  const projection = projectSessionFlowMajorOverview(
    raw,
    projectSessionFlowHierarchy(raw, { level: "overview" }),
  );
  const workflow = projection.state.nodes.find((node) => node.label === "Workflow");
  const output = projection.state.nodes.find((node) => node.label === "Output");
  assert.ok(workflow);
  assert.ok(output);
  assert.equal(workflow.observedSequence, 2);
  assert.equal(output.observedSequence, null);

  const layout = layoutSessionFlow(projection.state);
  assert.equal(layout.activeNodeId, workflow.id);
  assert.equal(layout.latestNodeId, workflow.id);
  assert.equal(layout.nodes.find((node) => node.id === workflow.id)?.active, true);
  assert.equal(layout.nodes.find((node) => node.id === output.id)?.active, false);
});

test("completed output connects meaningfully to the next run's main agent", () => {
  const projection = major([
    { type: "run_start", runId: "run-1" },
    { type: "result", runId: "run-1", ok: true },
    { type: "run_finished", runId: "run-1", ok: true },
    { type: "run_start", runId: "run-2" },
    { type: "result", runId: "run-2", ok: true },
    { type: "run_finished", runId: "run-2", ok: true },
  ]);
  const runOneOutput = projection.state.nodes.find(
    (node) => node.runId === "run-1" && node.label === "Output",
  );
  const runTwoMain = projection.state.nodes.find(
    (node) => node.runId === "run-2" && node.label === "Main Agent",
  );

  assert.ok(runOneOutput);
  assert.ok(runTwoMain);
  assert.ok(
    projection.state.edges.some(
      (item) =>
        item.source === runOneOutput.id
        && item.target === runTwoMain.id
        && item.kind === "sequence",
    ),
  );
});

test("AGI overview renders each AGI step as one merged plugin capsule", () => {
  const projection = major([
    { type: "run_start", runId: "agi-run" },
    { type: "agi_workflow_start", runId: "agi-run" },
    {
      type: "agi_workflow_node_start",
      runId: "agi-run",
      payload: { node: { id: "inspect", title: "Inspect", index: 1 } },
    },
    {
      type: "agi_workflow_workflow_start",
      runId: "agi-run",
      payload: {
        nodeId: "inspect",
        workflow: { id: "inspect-flow", currentStage: 1 },
      },
    },
    {
      type: "agi_workflow_node_end",
      runId: "agi-run",
      payload: { node: { id: "inspect", title: "Inspect" } },
      ok: true,
    },
    {
      type: "agi_workflow_node_start",
      runId: "agi-run",
      payload: { node: { id: "verify", title: "Verify", index: 2 } },
    },
    {
      type: "agi_workflow_node_end",
      runId: "agi-run",
      payload: { node: { id: "verify", title: "Verify" } },
      ok: true,
    },
    { type: "agi_workflow_end", runId: "agi-run", ok: true },
  ]);

  assert.equal(projection.state.nodes.length, 2);
  assert.ok(
    projection.state.nodes.every((node) => node.label.startsWith("AGI Step ")),
  );
  assert.ok(
    projection.state.nodes.every((node) =>
      node.detail.includes("Main Agent → Workflow → Output")
    ),
  );
  assert.equal(projection.state.edges.length, 1);
  assert.equal(projection.state.edges[0]?.kind, "sequence");
  for (const node of projection.state.nodes) {
    const meta = projection.metadataByNodeId[node.id];
    assert.equal(meta?.entityKind, "agi-node");
    assert.equal(meta?.compound, true);
    assert.match(meta?.summary || "", /Merged AGI plugin/);
    assert.ok((meta?.sourceNodeIds.length || 0) > 0);
  }
});

test("routing AGI run starts as one pending merged capsule", () => {
  const projection = major([
    { type: "run_start", runId: "agi-routing" },
    { type: "agi_workflow_start", runId: "agi-routing" },
    { type: "agi_workflow_route", runId: "agi-routing", route: "workflow" },
  ]);
  assert.equal(projection.state.nodes.length, 1);
  assert.equal(projection.state.nodes[0]?.label, "AGI Step · routing");
  assert.match(
    projection.state.nodes[0]?.detail || "",
    /Main Agent → Workflow → Output/,
  );
});
