import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SESSION_FLOW_STATE,
  sessionFlowReducer,
  sessionFlowToDrawioXml,
  type SessionFlowEdge,
  type SessionFlowEdgeKind,
  type SessionFlowNode,
  type SessionFlowNodeKind,
  type SessionFlowNodeStatus,
  type SessionFlowState,
} from "./sessionFlow.js";
import {
  projectSessionFlowHierarchy,
  type SessionFlowHierarchyEntityKind,
} from "./sessionFlowHierarchy.js";

function flowNode(
  id: string,
  sequence: number,
  eventType: string,
  options: Partial<SessionFlowNode> = {},
): SessionFlowNode {
  return {
    id,
    runId: "run-1",
    parentId: sequence === 1 ? null : "run",
    kind: "system",
    status: "info",
    label: eventType.replaceAll("_", " "),
    detail: "",
    eventType,
    sequence,
    depth: sequence === 1 ? 0 : 1,
    timestamp: `2026-08-14T00:00:${String(sequence).padStart(2, "0")}Z`,
    scope: "run-1:main",
    ...options,
  };
}

function edge(
  source: string,
  target: string,
  kind: SessionFlowEdgeKind = "sequence",
  suffix = "",
): SessionFlowEdge {
  return {
    id: `${kind}:${source}:${target}${suffix}`,
    source,
    target,
    kind,
  };
}

function flowState(
  nodes: SessionFlowNode[],
  edges: SessionFlowEdge[] = [],
): SessionFlowState {
  const sorted = [...nodes].sort((left, right) => left.sequence - right.sequence);
  const runIds = [...new Set(sorted.map((node) => node.runId))];
  const runNodeById: Record<string, string> = {};
  for (const runId of runIds) {
    const root = sorted.find(
      (node) => node.runId === runId && node.kind === "run",
    );
    if (root) runNodeById[runId] = root.id;
  }
  return {
    schemaVersion: 1,
    candidateOnly: true,
    canClaimAGI: false,
    nodes,
    edges,
    activeRunId: runIds.at(-1) || "",
    eventCount: Math.max(0, nodes.length - runIds.length),
    nextSequence: Math.max(0, ...nodes.map((node) => node.sequence)) + 1,
    lastNodeByScope: {},
    containerByScope: {},
    runNodeById,
    nodeDepthById: Object.fromEntries(nodes.map((node) => [node.id, node.depth])),
    seenEventIds: {},
  };
}

function dynamicWorkflowFixture(): SessionFlowState {
  const nodes = [
    flowNode("run", 1, "run_start", {
      kind: "run",
      status: "running",
      label: "Run · run-1",
    }),
    flowNode("workflow", 2, "dynamic_workflow_start", {
      kind: "workflow",
      status: "running",
      label: "Dynamic workflow",
    }),
    flowNode("controller-start", 3, "dynamic_workflow_controller_start", {
      kind: "workflow",
      status: "running",
      label: "Main workflow controller",
      parentId: "workflow",
      detail: "phase plan",
    }),
    flowNode("controller-end", 4, "dynamic_workflow_controller_end", {
      kind: "workflow",
      status: "succeeded",
      label: "Main workflow decision",
      parentId: "workflow",
      detail: "phase plan · dispatch",
    }),
    flowNode("stage-start", 5, "dynamic_workflow_stage_start", {
      kind: "workflow",
      status: "running",
      label: "Workflow stage 1",
      parentId: "workflow",
      scope: "run-1:workflow:stage:1",
      detail: "stage 1 · pattern fan-out",
    }),
    flowNode("worker-a-1", 6, "dynamic_workflow_worker_progress", {
      kind: "workflow",
      status: "running",
      label: "Workflow worker 1 progress",
      parentId: "stage-start",
      scope: "run-1:workflow:stage:1:worker:0",
      detail: "stage 1 · task inspect-api · reading files",
    }),
    flowNode("worker-a-2", 7, "dynamic_workflow_worker_progress", {
      kind: "workflow",
      status: "running",
      label: "Workflow worker 1 progress",
      parentId: "stage-start",
      scope: "run-1:workflow:stage:1:worker:0",
      detail: "stage 1 · task inspect-api · running tests",
    }),
    flowNode("worker-b", 8, "dynamic_workflow_worker_progress", {
      kind: "workflow",
      status: "succeeded",
      label: "Workflow worker 2 progress",
      parentId: "stage-start",
      scope: "run-1:workflow:stage:1:worker:1",
      detail: "stage 1 · task inspect-ui · report ready",
    }),
    flowNode("provider-progress", 9, "provider_progress", {
      kind: "model",
      status: "running",
      label: "Provider activity",
      parentId: "stage-start",
      scope: "run-1:workflow:stage:1:worker:0",
    }),
    flowNode("stage-end", 10, "dynamic_workflow_stage_end", {
      kind: "workflow",
      status: "succeeded",
      label: "Workflow stage 1 complete",
      parentId: "stage-start",
      scope: "run-1:workflow:stage:1",
      detail: "stage 1 · 2 usable reports",
    }),
    flowNode("synthesis", 11, "dynamic_workflow_synthesis_start", {
      kind: "agent",
      status: "running",
      label: "Workflow synthesis",
      parentId: "workflow",
    }),
    flowNode("result", 12, "dynamic_workflow_end", {
      kind: "result",
      status: "succeeded",
      label: "Dynamic workflow complete",
      parentId: "workflow",
      detail: "succeeded",
    }),
  ];
  const edges = [
    edge("run", "workflow", "contains"),
    edge("workflow", "controller-start", "contains"),
    edge("controller-start", "controller-end"),
    edge("workflow", "stage-start", "contains"),
    edge("stage-start", "worker-a-1", "contains"),
    edge("worker-a-1", "worker-a-2"),
    edge("worker-a-2", "worker-b", "handoff"),
    edge("stage-start", "stage-end"),
    edge("workflow", "synthesis", "contains"),
    edge("workflow", "result", "contains"),
  ];
  return flowState(nodes, edges);
}

function nodesOfKind(
  state: SessionFlowState,
  metadata: ReturnType<typeof projectSessionFlowHierarchy>["metadataByNodeId"],
  kind: SessionFlowHierarchyEntityKind,
): SessionFlowNode[] {
  return state.nodes.filter((node) => metadata[node.id]?.entityKind === kind);
}

test("overview collapses workflow progress explosions but keeps synthesis and result major", () => {
  const raw = dynamicWorkflowFixture();
  const projection = projectSessionFlowHierarchy(raw, { level: "overview" });
  const workflowNodes = nodesOfKind(
    projection.state,
    projection.metadataByNodeId,
    "workflow",
  );

  assert.equal(workflowNodes.length, 1);
  assert.equal(
    projection.state.nodes.some(
      (node) => node.eventType === "dynamic_workflow_worker_progress",
    ),
    false,
  );
  assert.equal(
    projection.state.nodes.some((node) => node.id === "provider-progress"),
    false,
  );
  assert.ok(
    projection.state.nodes.some(
      (node) => node.eventType === "hierarchy_workflow_synthesis",
    ),
  );
  assert.ok(
    projection.state.nodes.some(
      (node) => node.eventType === "hierarchy_workflow_result",
    ),
  );

  const workflow = workflowNodes[0]!;
  const meta = projection.metadataByNodeId[workflow.id]!;
  assert.ok(meta.sourceNodeIds.length >= 8);
  assert.equal(meta.hiddenEventCount, meta.sourceNodeIds.length - 1);
  assert.equal(meta.compound, true);
  assert.equal(meta.drillable, true);
  assert.ok(meta.childFocusNodeId);
  assert.match(workflow.label, /\d+ events/);
  assert.match(workflow.detail, /source/);
});

test("stages level expands a focused capsule and aggregates repeated stage progress", () => {
  const raw = dynamicWorkflowFixture();
  const overview = projectSessionFlowHierarchy(raw, { level: "overview" });
  const workflow = nodesOfKind(
    overview.state,
    overview.metadataByNodeId,
    "workflow",
  )[0]!;
  const projection = projectSessionFlowHierarchy(raw, {
    level: "stages",
    focusNodeId: workflow.id,
  });
  const stages = nodesOfKind(
    projection.state,
    projection.metadataByNodeId,
    "stage",
  );

  assert.equal(stages.length, 1);
  const stage = stages[0]!;
  const stageMeta = projection.metadataByNodeId[stage.id]!;
  assert.deepEqual(
    stageMeta.sourceEventTypes.sort(),
    [
      "dynamic_workflow_stage_end",
      "dynamic_workflow_stage_start",
      "dynamic_workflow_worker_progress",
      "provider_progress",
    ],
  );
  assert.equal(stageMeta.sourceNodeIds.length, 6);
  assert.equal(stage.status, "succeeded");
  assert.equal(stageMeta.childEntityIds.length, 2);
  assert.equal(stageMeta.statusLookupId, "dynamic-workflow-stage:1");
  assert.equal(projection.breadcrumbs.length, 2);
  assert.equal(projection.breadcrumbs[1]?.focusNodeId, workflow.id);
});

test("workers level expands stable worker scopes and aggregates repeated updates", () => {
  const raw = dynamicWorkflowFixture();
  const stages = projectSessionFlowHierarchy(raw, { level: "stages" });
  const stage = nodesOfKind(
    stages.state,
    stages.metadataByNodeId,
    "stage",
  )[0]!;
  const first = projectSessionFlowHierarchy(raw, {
    level: "workers",
    focusNodeId: stage.id,
  });
  const second = projectSessionFlowHierarchy(raw, {
    level: "workers",
    focusNodeId: stage.id,
  });
  const workers = nodesOfKind(
    first.state,
    first.metadataByNodeId,
    "worker",
  );

  assert.equal(workers.length, 2);
  assert.deepEqual(
    workers.map((node) => first.metadataByNodeId[node.id]!.sourceNodeIds.length),
    [2, 1],
  );
  assert.deepEqual(
    workers.map((node) => first.metadataByNodeId[node.id]!.statusLookupId),
    [
      "dynamic-workflow-worker:1:0",
      "dynamic-workflow-worker:1:1",
    ],
  );
  assert.deepEqual(
    first.state.nodes.map((node) => node.id),
    second.state.nodes.map((node) => node.id),
  );
  assert.equal(first.breadcrumbs.length, 3);
  assert.equal(first.focusNodeId, stage.id);
});

test("production-shaped AGI receipts preserve distinct structured hierarchy identity", () => {
  const raw = [
    { type: "run_start", runId: "agi-run" },
    { type: "agi_workflow_start", runId: "agi-run" },
    {
      type: "agi_workflow_node_start",
      runId: "agi-run",
      payload: {
        node: { id: "node-a", title: "Inspect", index: 1 },
      },
    },
    {
      type: "agi_workflow_workflow_start",
      runId: "agi-run",
      payload: {
        nodeId: "node-a",
        workflow: { id: "workflow-a", currentStage: 1 },
      },
    },
    {
      type: "agi_workflow_worker_lease",
      runId: "agi-run",
      payload: {
        nodeId: "node-a",
        workflowId: "workflow-a",
        agent: {
          agentId: "reader",
          nodeId: "node-a",
          stage: 1,
          name: "Reader",
        },
      },
    },
    {
      type: "agi_workflow_worker_lease",
      runId: "agi-run",
      payload: {
        nodeId: "node-a",
        workflowId: "workflow-a",
        agent: {
          agentId: "tester",
          nodeId: "node-a",
          stage: 1,
          name: "Tester",
        },
      },
    },
    {
      type: "agi_workflow_node_end",
      runId: "agi-run",
      payload: { node: { id: "node-a", title: "Inspect" } },
      ok: true,
    },
    {
      type: "agi_workflow_node_start",
      runId: "agi-run",
      payload: {
        node: { id: "node-b", title: "Verify", index: 2 },
      },
    },
    {
      type: "agi_workflow_node_end",
      runId: "agi-run",
      payload: { node: { id: "node-b", title: "Verify" } },
      ok: true,
    },
  ].reduce(
    (state, event) =>
      sessionFlowReducer(state, { type: "event", event }),
    EMPTY_SESSION_FLOW_STATE,
  );

  const overview = projectSessionFlowHierarchy(raw, { level: "overview" });
  const agiNodes = nodesOfKind(
    overview.state,
    overview.metadataByNodeId,
    "agi-node",
  );
  assert.equal(agiNodes.length, 2);

  const nodeA = agiNodes.find((node) => node.scope.includes("node-a"));
  assert.ok(nodeA);
  const workers = projectSessionFlowHierarchy(raw, {
    level: "workers",
    focusNodeId: nodeA.id,
  });
  const workerNodes = nodesOfKind(
    workers.state,
    workers.metadataByNodeId,
    "worker",
  );
  assert.equal(workerNodes.length, 2);
  assert.deepEqual(
    workerNodes
      .map((node) => workers.metadataByNodeId[node.id]?.statusLookupId)
      .sort(),
    ["agi-workflow-worker:reader", "agi-workflow-worker:tester"],
  );
  const stage = nodesOfKind(
    workers.state,
    workers.metadataByNodeId,
    "stage",
  )[0];
  assert.equal(
    stage && workers.metadataByNodeId[stage.id]?.statusLookupId,
    "agi-workflow-stage:workflow-a:1",
  );
});

test("minor provider and tool receipts stay inspectable through folded provenance", () => {
  const raw = dynamicWorkflowFixture();
  raw.nodes.push(
    flowNode("tool-result", 13, "tool_result", {
      kind: "tool",
      status: "succeeded",
      parentId: "stage-start",
      scope: "run-1:workflow:stage:1:worker:0",
      detail: "read_file succeeded",
    }),
  );
  const projection = projectSessionFlowHierarchy(raw, { level: "stages" });
  const representedSourceIds = new Set(
    Object.values(projection.metadataByNodeId)
      .flatMap((metadata) => metadata.sourceNodeIds),
  );

  assert.equal(representedSourceIds.has("provider-progress"), true);
  assert.equal(representedSourceIds.has("tool-result"), true);
  const stage = nodesOfKind(
    projection.state,
    projection.metadataByNodeId,
    "stage",
  )[0];
  assert.ok(stage?.provenance?.sourceNodeIds.includes("provider-progress"));
  assert.ok(stage?.provenance?.sourceNodeIds.includes("tool-result"));
  const xml = sessionFlowToDrawioXml(projection.state, {
    generatedAt: "2026-08-14T12:00:00.000Z",
  });
  assert.match(
    xml,
    /sophiaSourceNodeIds="[^"]*provider-progress[^"]*tool-result[^"]*"/,
  );
  assert.match(xml, /sophiaHiddenEventCount="[1-9]\d*"/);
});

test("AGI workflow controller events group separately from derived AGI nodes", () => {
  const raw = flowState([
    flowNode("run", 1, "run_start", {
      kind: "run",
      status: "running",
      label: "Run · run-1",
    }),
    flowNode("agi-start", 2, "agi_workflow_start", {
      kind: "agi",
      status: "running",
      label: "AGI workflow start",
    }),
    flowNode("node-a-start", 3, "agi_workflow_node_start", {
      kind: "agi",
      status: "running",
      label: "AGI node start",
      detail: "nodeId=node-a · phase inspect",
    }),
    flowNode("node-a-route", 4, "agi_workflow_route", {
      kind: "agi",
      status: "running",
      detail: "nodeId=node-a · phase inspect",
    }),
    flowNode("node-a-stage", 5, "agi_workflow_workflow_start", {
      kind: "agi",
      status: "running",
      detail: "nodeId=node-a · workflowId=wf-a · stage 1",
    }),
    flowNode("node-a-worker-1", 6, "agi_workflow_worker_lease", {
      kind: "agi",
      status: "running",
      detail:
        "nodeId=node-a · workflowId=wf-a · stage 1 · workerId=worker-a",
    }),
    flowNode("node-a-worker-2", 7, "agi_workflow_worker_lease", {
      kind: "agi",
      status: "succeeded",
      detail:
        "nodeId=node-a · workflowId=wf-a · stage 1 · workerId=worker-a",
    }),
    flowNode("node-a-end", 8, "agi_workflow_node_end", {
      kind: "agi",
      status: "succeeded",
      detail: "nodeId=node-a · phase inspect",
    }),
    flowNode("node-b-start", 9, "agi_workflow_node_start", {
      kind: "agi",
      status: "running",
      detail: "nodeId=node-b · phase verify",
    }),
    flowNode("node-b-end", 10, "agi_workflow_node_end", {
      kind: "agi",
      status: "failed",
      detail: "nodeId=node-b · phase verify",
    }),
    flowNode("agi-end", 11, "agi_workflow_end", {
      kind: "agi",
      status: "failed",
      detail: "failed",
    }),
  ]);

  const overview = projectSessionFlowHierarchy(raw, { level: "overview" });
  assert.equal(
    nodesOfKind(overview.state, overview.metadataByNodeId, "agi-controller")
      .length,
    1,
  );
  const agiNodes = nodesOfKind(
    overview.state,
    overview.metadataByNodeId,
    "agi-node",
  );
  assert.equal(agiNodes.length, 2);
  assert.deepEqual(
    agiNodes.map((node) => node.status),
    ["succeeded", "failed"],
  );
  assert.ok(
    overview.state.nodes.some(
      (node) => node.eventType === "hierarchy_agi_result",
    ),
  );

  const nodeA = agiNodes.find((node) => /inspect/.test(node.label))!;
  const workers = projectSessionFlowHierarchy(raw, {
    level: "workers",
    focusNodeId: nodeA.id,
  });
  const agiWorkers = nodesOfKind(
    workers.state,
    workers.metadataByNodeId,
    "worker",
  );
  assert.equal(agiWorkers.length, 1);
  assert.equal(
    workers.metadataByNodeId[agiWorkers[0]!.id]!.statusLookupId,
    "agi-workflow-worker:worker-a",
  );
  const agiStage = nodesOfKind(
    workers.state,
    workers.metadataByNodeId,
    "stage",
  )[0]!;
  assert.equal(
    workers.metadataByNodeId[agiStage.id]!.statusLookupId,
    "agi-workflow-stage:wf-a:1",
  );
});

test("approval, material failure, receipts, final output, and completion stay visible", () => {
  const raw = dynamicWorkflowFixture();
  raw.nodes.push(
    flowNode("goal", 13, "goal", {
      kind: "goal",
      status: "info",
      label: "Goal updated",
      parentId: "workflow",
    }),
    flowNode("harness", 14, "harness_context", {
      kind: "harness",
      status: "info",
      label: "Harness · agi",
      parentId: "workflow",
    }),
    flowNode("approval", 15, "approval_request", {
      kind: "approval",
      status: "blocked",
      label: "Approval · deploy",
      parentId: "stage-start",
    }),
    flowNode("tool-failed", 16, "tool_result", {
      kind: "tool",
      status: "failed",
      label: "Tool result · test",
      parentId: "workflow",
    }),
    flowNode("receipt", 17, "receipt", {
      kind: "receipt",
      status: "succeeded",
      label: "Receipt · final",
      parentId: "workflow",
    }),
    flowNode("final", 18, "final", {
      kind: "model",
      status: "succeeded",
      label: "Answer draft observed",
      parentId: "workflow",
    }),
    flowNode("run-finished", 19, "run_finished", {
      kind: "result",
      status: "succeeded",
      label: "Run finished",
    }),
  );

  const projection = projectSessionFlowHierarchy(raw, { level: "overview" });
  for (const id of [
    "goal",
    "harness",
    "approval",
    "tool-failed",
    "receipt",
    "final",
    "run-finished",
  ]) {
    assert.ok(projection.state.nodes.some((node) => node.id === id), id);
    assert.equal(projection.metadataByNodeId[id]?.entityKind, "critical");
  }
});

test("terminal success can dominate earlier adverse progress while unresolved states remain visible", () => {
  const raw = dynamicWorkflowFixture();
  const stageStart = raw.nodes.find((node) => node.id === "stage-start")!;
  const worker = raw.nodes.find((node) => node.id === "worker-a-1")!;
  stageStart.status = "blocked";
  worker.status = "failed";
  const stages = projectSessionFlowHierarchy(raw, { level: "stages" });
  const stage = nodesOfKind(
    stages.state,
    stages.metadataByNodeId,
    "stage",
  )[0]!;
  assert.equal(stage.status, "succeeded");

  const withoutEnd = flowState(
    raw.nodes.filter((node) => node.id !== "stage-end" && node.id !== "result"),
    raw.edges,
  );
  const unresolved = projectSessionFlowHierarchy(withoutEnd, {
    level: "stages",
  });
  const unresolvedStage = nodesOfKind(
    unresolved.state,
    unresolved.metadataByNodeId,
    "stage",
  )[0]!;
  assert.equal(unresolvedStage.status, "failed");
});

test("raw edges project through representatives, deduplicate, and avoid self edges", () => {
  const raw = dynamicWorkflowFixture();
  raw.edges.push(
    edge("run", "workflow", "contains", ":duplicate"),
    edge("worker-a-1", "worker-a-2", "sequence", ":duplicate"),
  );
  const projection = projectSessionFlowHierarchy(raw, { level: "workers" });
  const keys = projection.state.edges.map(
    (item) => `${item.kind}:${item.source}:${item.target}`,
  );

  assert.equal(new Set(keys).size, keys.length);
  assert.equal(
    projection.state.edges.some((item) => item.source === item.target),
    false,
  );
  assert.ok(projection.state.edges.some((item) => item.kind === "contains"));
  assert.ok(projection.state.edges.some((item) => item.kind === "handoff"));
  assert.equal(
    projection.state.edges.some(
      (item) =>
        item.kind === "sequence"
        && projection.metadataByNodeId[item.source]?.entityKind === "worker"
        && item.source === item.target,
    ),
    false,
  );
});

test("projection IDs and ordering are deterministic even when raw arrays are presented differently", () => {
  const raw = dynamicWorkflowFixture();
  const reordered: SessionFlowState = {
    ...raw,
    nodes: [...raw.nodes].reverse(),
    edges: [...raw.edges].reverse(),
  };
  const first = projectSessionFlowHierarchy(raw, { level: "workers" });
  const second = projectSessionFlowHierarchy(reordered, { level: "workers" });

  assert.deepEqual(first.state.nodes, second.state.nodes);
  assert.deepEqual(first.state.edges, second.state.edges);
  assert.deepEqual(first.metadataByNodeId, second.metadataByNodeId);
});

test("hierarchy projection preserves harness grouping and observed receipt order", () => {
  const harnessId = "session-flow-major:run-1:harness";
  const raw = flowState([
    flowNode("main", 1, "major_main_agent", {
      kind: "run",
      parentId: null,
      observedSequence: 1,
      harnessId,
    }),
    flowNode("output", 1.5, "major_output", {
      kind: "result",
      parentId: null,
      status: "pending",
      observedSequence: null,
      harnessId,
    }),
  ]);
  const projection = projectSessionFlowHierarchy(raw, { level: "overview" });
  const projectedMain = projection.state.nodes.find((node) =>
    node.provenance?.sourceNodeIds.includes("main")
  );
  const projectedOutput = projection.state.nodes.find((node) =>
    node.provenance?.sourceNodeIds.includes("output")
  );

  assert.ok(projectedMain);
  assert.ok(projectedOutput);
  assert.equal(projectedMain.harnessId, harnessId);
  assert.equal(projectedMain.observedSequence, 1);
  assert.equal(projectedOutput.harnessId, harnessId);
  assert.equal(projectedOutput.observedSequence, null);
});

test("hierarchy projection preserves compound process and join identities", () => {
  const raw = [
    { type: "run_start", eventId: "run", runId: "compound" },
    {
      type: "workflow_plan_frozen",
      eventId: "plan",
      runId: "compound",
      workflowEventVersion: 1,
      workflowEventSequence: 0,
      schema: "sophia.compound-workflow-plan.v1",
      planDigest: "f".repeat(64),
      outputProcessId: "terminal",
      processes: [
        { processId: "process-1", processLabel: "Verify", branchId: "left", childWorkflowIds: ["collect", "check"], dependsOnNodeIds: [] },
        { processId: "process-2", processLabel: "Peer", branchId: "right", childWorkflowIds: ["peer"], dependsOnNodeIds: [] },
        { processId: "terminal", processLabel: "Finish", branchId: "main", childWorkflowIds: ["finish"], dependsOnNodeIds: ["join-1"] },
      ],
      joins: [
        { joinId: "join-1", expectedNodeIds: ["process-1", "process-2"] },
      ],
    },
    {
      type: "workflow_process_start",
      eventId: "process",
      runId: "compound",
      workflowEventVersion: 1,
      workflowEventSequence: 10,
      processId: "process-1",
      processLabel: "Verify",
      branchId: "left",
      childWorkflowIds: ["collect", "check"],
      dependsOnNodeIds: [],
      workflowId: "collect",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_process_progress",
      eventId: "progress",
      runId: "compound",
      workflowEventVersion: 1,
      workflowEventSequence: 11,
      processId: "process-1",
      processLabel: "Verify",
      branchId: "left",
      childWorkflowIds: ["collect", "check"],
      dependsOnNodeIds: [],
      completedChildWorkflowIds: ["collect"],
    },
    {
      type: "workflow_join_wait",
      eventId: "join",
      runId: "compound",
      workflowEventVersion: 1,
      workflowEventSequence: 12,
      joinId: "join-1",
      expectedNodeIds: ["process-1", "process-2"],
      completedNodeIds: ["process-1"],
      state: "pending",
    },
  ].reduce(
    (state, event) =>
      sessionFlowReducer(state, { type: "event", event }),
    EMPTY_SESSION_FLOW_STATE,
  );
  const projection = projectSessionFlowHierarchy(raw, { level: "workers" });
  const process = projection.state.nodes.find(
    (node) => node.processNode && node.processId === "process-1",
  );
  const members = projection.state.nodes.filter(
    (node) => node.processMember && node.processId === "process-1",
  );
  const join = projection.state.nodes.find((node) => node.joinId === "join-1");

  assert.equal(members.length, 2);
  assert.equal(process?.id, "workflow-process:compound:process-1");
  assert.ok(members.every((node) => node.parentId === process?.id));
  assert.deepEqual(
    projection.metadataByNodeId[process!.id]?.childEntityIds,
    members.map((node) => node.id),
  );
  assert.equal(projection.metadataByNodeId[process!.id]?.drillable, true);
  assert.ok(members.every((node) => node.processId === "process-1"));
  assert.equal(process?.workflowEventSequence, 11);
  assert.ok(members.every((node) => node.workflowEventSequence === 11));
  assert.ok(members.every((node) => node.branchId === "left"));
  assert.ok(
    members.every((node) => node.completedChildWorkflowIds?.[0] === "collect"),
  );
  assert.deepEqual(
    join?.expectedNodeIds,
    ["process-1", "process-2"],
  );
  assert.deepEqual(join?.completedNodeIds, ["process-1"]);
  assert.equal(join?.workflowEventSequence, 12);
});

test("projection does not mutate the input state or its nested collections", () => {
  const raw = dynamicWorkflowFixture();
  const before = structuredClone(raw);
  for (const node of raw.nodes) Object.freeze(node);
  for (const item of raw.edges) Object.freeze(item);
  Object.freeze(raw.nodes);
  Object.freeze(raw.edges);
  Object.freeze(raw.lastNodeByScope);
  Object.freeze(raw.containerByScope);
  Object.freeze(raw.runNodeById);
  Object.freeze(raw.nodeDepthById);
  Object.freeze(raw.seenEventIds);
  Object.freeze(raw);

  const projection = projectSessionFlowHierarchy(raw, { level: "workers" });

  assert.deepEqual(raw, before);
  assert.notEqual(projection.state, raw);
  assert.notEqual(projection.state.nodes, raw.nodes);
  assert.notEqual(projection.state.edges, raw.edges);
  assert.equal(projection.state.candidateOnly, true);
  assert.equal(projection.state.canClaimAGI, false);
});

test("metadata exports inspector and drill-down fields for every projected node", () => {
  const projection = projectSessionFlowHierarchy(dynamicWorkflowFixture(), {
    level: "stages",
  });
  for (const node of projection.state.nodes) {
    const meta = projection.metadataByNodeId[node.id];
    assert.ok(meta, node.id);
    assert.equal(meta.projectedNodeId, node.id);
    assert.ok(Array.isArray(meta.sourceNodeIds));
    assert.ok(Array.isArray(meta.sourceEventTypes));
    assert.ok(Array.isArray(meta.hierarchyPath));
    assert.equal(meta.drillable, meta.expandable);
    assert.equal(
      meta.childFocusNodeId,
      meta.childEntityIds[0] || null,
    );
    assert.match(meta.summary, /source/);
  }
  assert.equal(projection.level, "stages");
  assert.equal(projection.projectedState, projection.state);
  assert.equal(projection.breadcrumbs[0]?.label, "All runs");
});
