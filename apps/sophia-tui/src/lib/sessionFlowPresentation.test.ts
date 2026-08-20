import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_AGI_WORKFLOW_STATE,
  type AGIWorkflowState,
} from "./agiWorkflowState.js";
import type { BridgeEvent } from "./bridge.js";
import {
  EMPTY_DYNAMIC_WORKFLOW_STATE,
  type DynamicWorkflowState,
} from "./dynamicWorkflowState.js";
import {
  presentSessionFlowHierarchy,
} from "./sessionFlowPresentation.js";
import type {
  SessionFlowNode,
  SessionFlowState,
} from "./sessionFlow.js";
import {
  EMPTY_SESSION_FLOW_STATE,
  sessionFlowReducer,
} from "./sessionFlow.js";

function node(
  id: string,
  sequence: number,
  eventType: string,
  overrides: Partial<SessionFlowNode> = {},
): SessionFlowNode {
  return {
    id,
    runId: "run-1",
    parentId: sequence === 1 ? null : "run",
    kind: "workflow",
    status: "running",
    label: eventType,
    detail: "",
    eventType,
    sequence,
    depth: sequence === 1 ? 0 : 1,
    timestamp: `2026-08-14T00:00:${String(sequence).padStart(2, "0")}Z`,
    scope: "run-1:workflow",
    ...overrides,
  };
}

function rawState(): SessionFlowState {
  const nodes = [
    node("run", 1, "run_start", {
      kind: "run",
      label: "Run",
      scope: "run-1:main",
    }),
    node("workflow", 2, "dynamic_workflow_start"),
    node("stage", 3, "dynamic_workflow_stage_start", {
      parentId: "workflow",
      scope: "run-1:workflow:stage:2",
      detail: "stage 2 · pattern fan-out",
    }),
    node("worker", 4, "dynamic_workflow_worker_progress", {
      parentId: "stage",
      scope: "run-1:workflow:stage:2:worker:0",
      detail: "stage 2 · task inspect · reading reducers",
    }),
  ];
  return {
    schemaVersion: 1,
    candidateOnly: true,
    canClaimAGI: false,
    nodes,
    edges: [
      { id: "contains:run:workflow", source: "run", target: "workflow", kind: "contains" },
      { id: "contains:workflow:stage", source: "workflow", target: "stage", kind: "contains" },
      { id: "contains:stage:worker", source: "stage", target: "worker", kind: "contains" },
    ],
    activeRunId: "run-1",
    eventCount: 3,
    nextSequence: 5,
    lastNodeByScope: {},
    containerByScope: {},
    runNodeById: { "run-1": "run" },
    nodeDepthById: Object.fromEntries(nodes.map((item) => [item.id, item.depth])),
    seenEventIds: {},
  };
}

function dynamicState(): DynamicWorkflowState {
  return {
    ...EMPTY_DYNAMIC_WORKFLOW_STATE,
    runId: "run-1",
    active: true,
    selected: true,
    status: "running",
    phase: "workers",
    currentStage: 2,
    maxStages: 4,
    stages: [{
      index: 2,
      pattern: "fan-out",
      goal: "Inspect the flow projection",
      status: "running",
      maxConcurrency: 2,
      agents: [{
        name: "Reader",
        index: 0,
        status: "running",
        active: true,
        role: "reviewer",
        skills: ["repo-analysis"],
        summary: "",
        progress: "reading reducers",
      }],
    }],
  };
}

test("presentation keeps the raw audit graph while enriching the parallel stage DAG", () => {
  const raw = rawState();
  const presented = presentSessionFlowHierarchy(
    raw,
    { level: "overview" },
    dynamicState(),
    EMPTY_AGI_WORKFLOW_STATE,
  );
  const barrier = presented.state.nodes.find(
    (item) =>
      item.label === "Barrier · Stage 2",
  );

  assert.ok(barrier);
  assert.equal(presented.rawState, raw);
  assert.ok(presented.state.nodes.length > raw.nodes.length);
  assert.equal(barrier.status, "running");
  assert.match(barrier.detail, /0\/1 lanes complete/);
  assert.ok(presented.liveStatusByNodeId[barrier.id]);
  assert.ok(
    presented.metadataByNodeId[barrier.id]?.sourceNodeIds.includes("worker"),
  );
});

test("multi-worker projection joins live status by canonical stage and worker index", () => {
  const raw = rawState();
  raw.nodes.push(
    node("worker-2", 5, "dynamic_workflow_worker_progress", {
      parentId: "stage",
      scope: "run-1:workflow:stage:2:worker:1",
      detail: "stage 2 · task test · running tests",
    }),
  );
  const dynamic = dynamicState();
  dynamic.stages[0]!.agents.push({
    name: "Tester",
    index: 1,
    status: "running",
    active: true,
    role: "tester",
    skills: ["node-test"],
    summary: "",
    progress: "running tests",
  });

  const presented = presentSessionFlowHierarchy(
    raw,
    { level: "workers" },
    dynamic,
    EMPTY_AGI_WORKFLOW_STATE,
  );
  const workers = presented.state.nodes.filter(
    (item) =>
      presented.metadataByNodeId[item.id]?.entityKind === "worker",
  );

  assert.equal(workers.length, 2);
  assert.deepEqual(
    workers.map((worker) => worker.label).sort(),
    ["Reader", "Tester"],
  );
  assert.ok(workers.every((worker) => presented.liveStatusByNodeId[worker.id]));
});

test("live workflow status is scoped to its owning run after activeRunId clears", () => {
  const first = rawState();
  const idMap = new Map(
    first.nodes.map((item) => [item.id, `second-${item.id}`]),
  );
  const secondNodes = first.nodes.map((item) => ({
    ...item,
    id: idMap.get(item.id)!,
    runId: "run-2",
    parentId: item.parentId ? idMap.get(item.parentId) || null : null,
    sequence: item.sequence + 10,
    scope: item.scope.replace("run-1", "run-2"),
  }));
  const secondEdges = first.edges.map((edge) => ({
    ...edge,
    id: `second-${edge.id}`,
    source: idMap.get(edge.source)!,
    target: idMap.get(edge.target)!,
  }));
  const raw: SessionFlowState = {
    ...first,
    nodes: [...first.nodes, ...secondNodes],
    edges: [...first.edges, ...secondEdges],
    activeRunId: "",
    runNodeById: {
      "run-1": "run",
      "run-2": "second-run",
    },
  };
  const dynamic = {
    ...dynamicState(),
    runId: "run-2",
    currentStage: 9,
    maxStages: 9,
    stages: [{
      ...dynamicState().stages[0]!,
      index: 9,
    }],
  };

  const presented = presentSessionFlowHierarchy(
    raw,
    { level: "overview" },
    dynamic,
    EMPTY_AGI_WORKFLOW_STATE,
  );
  const barrierNodes = presented.state.nodes.filter(
    (item) =>
      presented.metadataByNodeId[item.id]?.entityKind === "stage",
  );
  const secondBarrier = barrierNodes.find((item) => item.runId === "run-2");

  assert.ok(secondBarrier);
  assert.equal(
    barrierNodes.some((item) => item.runId === "run-1"),
    false,
    "a live dynamic snapshot must not be applied to an older run",
  );
  assert.match(
    presented.liveStatusByNodeId[secondBarrier.id]?.progressLabel || "",
    /Barrier 0\/1/,
  );
});

test("worker projection joins structured live status without adding minor event nodes", () => {
  const presented = presentSessionFlowHierarchy(
    rawState(),
    { level: "workers" },
    dynamicState(),
    EMPTY_AGI_WORKFLOW_STATE,
  );
  const worker = presented.state.nodes.find(
    (item) =>
      presented.metadataByNodeId[item.id]?.entityKind === "worker",
  );

  assert.ok(worker);
  assert.equal(worker.label, "Reader");
  assert.equal(worker.status, "running");
  assert.match(worker.eventType, /reading reducers/);
  assert.equal(
    presented.state.nodes.some(
      (item) => item.eventType === "dynamic_workflow_worker_progress",
    ),
    false,
  );
});

test("active AGI merged capsule streams the current node workflow status", () => {
  const events: BridgeEvent[] = [
    { type: "run_start", runId: "agi-run" },
    { type: "agi_workflow_start", runId: "agi-run" },
    {
      type: "agi_workflow_node_start",
      runId: "agi-run",
      payload: {
        node: { id: "verify", index: 2, title: "Verify integration" },
      },
    },
    {
      type: "agi_workflow_workflow_start",
      runId: "agi-run",
      payload: {
        nodeId: "verify",
        workflow: { id: "verify-flow", currentStage: 1 },
      },
    },
  ];
  const raw = events.reduce<SessionFlowState>(
    (state, event) =>
      sessionFlowReducer(state, {
        type: "event",
        event,
        sessionId: "active-session",
      }),
    { ...EMPTY_SESSION_FLOW_STATE, sessionId: "active-session" },
  );
  const agi: AGIWorkflowState = {
    ...EMPTY_AGI_WORKFLOW_STATE,
    active: true,
    runId: "agi-run",
    status: "running",
    route: "workflow",
    currentNode: {
      id: "verify",
      index: 2,
      title: "Verify integration",
      status: "running",
      route: "workflow",
      evidenceSummary: "",
      startedAt: "2026-08-14T00:00:00Z",
      endedAt: "",
    },
    workflow: {
      id: "verify-flow",
      pattern: "review-and-test",
      status: "running",
      currentStage: 1,
      maxStages: 3,
      barrier: {
        stage: 1,
        status: "running",
        completed: 1,
        total: 2,
        label: "parallel reports",
      },
      evidenceSummary: "",
      startedAt: "2026-08-14T00:00:00Z",
      endedAt: "",
    },
    activeAgents: [{
      key: "verifier",
      id: "verifier",
      leaseId: "",
      workerId: "worker-1",
      name: "Verifier",
      role: "reviewer",
      nodeId: "verify",
      stage: 1,
      status: "running",
      progress: "checking reducer",
      currentTool: "node:test",
      currentStatus: "",
      evidenceSummary: "",
      reuseCount: 0,
      reuseReason: "",
      startedAt: "2026-08-14T00:00:00Z",
      updatedAt: "2026-08-14T00:00:01Z",
      endedAt: "",
    }],
  };

  const presented = presentSessionFlowHierarchy(
    raw,
    { level: "overview" },
    EMPTY_DYNAMIC_WORKFLOW_STATE,
    agi,
  );
  const capsule = presented.state.nodes.find(
    (item) =>
      presented.metadataByNodeId[item.id]?.entityKind === "agi-node",
  );

  assert.ok(capsule);
  assert.equal(capsule.label, "Verify integration");
  assert.equal(capsule.status, "running");
  assert.match(capsule.eventType, /Stage 1\/3/);
  assert.match(capsule.detail, /Verifier · checking reducer/);
  assert.ok(presented.liveStatusByNodeId[capsule.id]);
  assert.match(
    presented.metadataByNodeId[capsule.id]?.summary || "",
    /Main Agent → Workflow → Output/,
  );
});
