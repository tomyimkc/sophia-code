import test from "node:test";
import assert from "node:assert/strict";
import {
  AGI_WORKFLOW_RECENT_AGENT_LIMIT,
  EMPTY_AGI_WORKFLOW_STATE,
  agiWorkflowReducer,
  selectAGIWorkflowCompactSummary,
  selectAGIWorkflowDetailRows,
} from "./agiWorkflowState.js";

test("consecutive node workflows replace active agents and preserve bounded recent history", () => {
  let state = agiWorkflowReducer(EMPTY_AGI_WORKFLOW_STATE, {
    type: "agi_workflow_start",
    runId: "agi-workflow-1",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_node_start",
    node: { id: "node-1", index: 1, title: "Inspect implementation" },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_route",
    nodeId: "node-1",
    route: "dynamic_workflow",
    execution: "workflow",
    selected: true,
    reason: "independent inspection benefits from parallel workers",
    pattern: {
      name: "fan-out-and-synthesize",
      stages: 2,
      totalAgents: 5,
    },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_workflow_start",
    workflow: {
      id: "wf-1",
      pattern: "fan-out",
      stage: 1,
      maxStages: 2,
      barrier: { status: "waiting", completed: 0, total: 2 },
    },
    agents: [
      { id: "agent-a", name: "Reader", status: "running", progress: "reading files" },
      { id: "agent-b", name: "Tester", status: "leased", currentTool: "npm test" },
    ],
  });
  assert.deepEqual(state.activeAgents.map((agent) => agent.name), ["Reader", "Tester"]);

  state = agiWorkflowReducer(state, {
    type: "agi_workflow_workflow_end",
    ok: true,
    workflow: {
      id: "wf-1",
      status: "succeeded",
      stage: 1,
      barrier: { status: "released", completed: 2, total: 2 },
      evidenceSummary: "two worker reports received",
    },
    agents: [
      {
        id: "agent-a",
        name: "Reader",
        status: "succeeded",
        evidenceSummary: "source paths cited",
      },
      {
        id: "agent-b",
        name: "Tester",
        status: "succeeded",
        evidenceSummary: "focused tests passed",
      },
    ],
  });
  assert.equal(state.activeAgents.length, 0);
  assert.deepEqual(
    state.recentAgents.map((agent) => agent.name).sort(),
    ["Reader", "Tester"],
  );

  state = agiWorkflowReducer(state, {
    type: "agi_workflow_node_end",
    node: { id: "node-1", index: 1, status: "succeeded" },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_node_start",
    node: { id: "node-2", index: 2, title: "Verify integration" },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_route",
    route: "workflow",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_workflow_start",
    workflow: {
      id: "wf-2",
      pattern: "review-and-test",
      stage: 1,
      barrier: { status: "running", total: 1 },
    },
    agents: [
      {
        id: "agent-c",
        name: "Verifier",
        status: "running",
        progress: "checking reducer",
        currentTool: "node:test",
        currentStatus: "focused suite running",
        evidenceSummary: "awaiting test receipt",
      },
    ],
  });

  assert.equal(state.currentNode?.id, "node-2");
  assert.deepEqual(state.activeAgents.map((agent) => agent.name), ["Verifier"]);
  assert.equal(state.recentAgents.length, 2);
  const verifierRow = selectAGIWorkflowDetailRows(state).find(
    (row) => row.kind === "agent" && row.label === "Verifier",
  );
  assert.deepEqual(
    {
      progress: verifierRow?.progress,
      tool: verifierRow?.tool,
      currentStatus: verifierRow?.currentStatus,
      evidenceSummary: verifierRow?.evidenceSummary,
    },
    {
      progress: "checking reducer",
      tool: "node:test",
      currentStatus: "focused suite running",
      evidenceSummary: "awaiting test receipt",
    },
  );

  for (let index = 0; index < AGI_WORKFLOW_RECENT_AGENT_LIMIT + 3; index += 1) {
    state = agiWorkflowReducer(state, {
      type: "agi_workflow_worker_lease",
      agent: {
        id: `archived-${index}`,
        name: `Archived ${index}`,
        status: "succeeded",
      },
    });
  }
  assert.equal(state.recentAgents.length, AGI_WORKFLOW_RECENT_AGENT_LIMIT);
  assert.ok(state.archivedAgentCount > AGI_WORKFLOW_RECENT_AGENT_LIMIT);
});

test("a simple solo node stays agent-free and renders a compact solo summary", () => {
  let state = agiWorkflowReducer(EMPTY_AGI_WORKFLOW_STATE, {
    type: "agi_workflow_start",
    runId: "solo-run",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_node_start",
    nodeId: "solo-node",
    nodeIndex: 1,
    title: "Answer directly",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_route",
    route: "single_pass",
    execution: "solo",
    selected: false,
    reason: "bounded single-step node",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_node_end",
    nodeId: "solo-node",
    status: "succeeded",
    evidenceSummary: "structured result emitted",
  });

  const compact = selectAGIWorkflowCompactSummary(state);
  assert.equal(state.route, "solo");
  assert.equal(state.workflow, null);
  assert.equal(state.activeAgents.length, 0);
  assert.match(compact.workflow, /solo execution/);
  assert.match(compact.node, /Answer directly/);
});

test("completed workflow agents leave active state and become archived rows", () => {
  let state = agiWorkflowReducer(EMPTY_AGI_WORKFLOW_STATE, {
    type: "agi_workflow_node_start",
    node: { id: "node-a", title: "Run bounded workflow" },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_workflow_start",
    workflow: { id: "wf-a", stage: 2, barrier: { status: "waiting", total: 2 } },
    workers: [
      { workerId: "worker-1", name: "Worker 1", status: "running" },
      { workerId: "worker-2", name: "Worker 2", status: "running" },
    ],
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_workflow_end",
    ok: false,
    status: "failed",
    workers: [
      { workerId: "worker-1", name: "Worker 1", status: "succeeded" },
      {
        workerId: "worker-2",
        name: "Worker 2",
        status: "failed",
        currentStatus: "verification failed",
        evidenceSummary: "one assertion failed",
      },
    ],
  });

  assert.equal(state.activeAgents.length, 0);
  assert.equal(state.recentAgents.length, 2);
  assert.deepEqual(
    state.recentAgents.map((agent) => agent.status).sort(),
    ["failed", "succeeded"],
  );
  const rows = selectAGIWorkflowDetailRows(state);
  assert.equal(rows.filter((row) => row.kind === "agent").length, 0);
  assert.equal(rows.filter((row) => row.kind === "archive").length, 2);
  for (const row of rows.filter((item) => item.kind === "archive")) {
    assert.match(row.detail, /node node-a/);
    assert.match(row.detail, /stage 2/);
  }
});

test("warm leases record reuse and are removed and archived on eviction", () => {
  let state = agiWorkflowReducer(EMPTY_AGI_WORKFLOW_STATE, {
    type: "agi_workflow_node_start",
    node: { id: "node-warm", title: "Reuse worker" },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_warm_pool",
    size: 1,
    leases: [
      {
        leaseId: "lease-1",
        workerId: "worker-1",
        name: "Warm Worker",
        status: "warm_idle",
        reuseCount: 1,
        reuseReason: "same provider and tool scope",
      },
    ],
  });
  assert.equal(state.warmIdleLeases.length, 1);
  assert.equal(state.warmPoolSize, 1);

  state = agiWorkflowReducer(state, {
    type: "agi_workflow_worker_lease",
    schema: "sophia.workflow.worker_reuse_event.v1",
    eventType: "workflow.worker_reuse.decision",
    workflowId: "workflow-1",
    logicalAgentId: "implementer-1",
    taskId: "task-2",
    predecessorTaskId: "task-1",
    stageKind: "implementation_follow_up",
    allowed: true,
    reason: "reuse_allowed",
    leaseId: "lease-1",
    runtimeId: "worker-1",
    directContinuation: true,
    lease: {
      leaseId: "lease-1",
      runtimeId: "worker-1",
      logicalAgentId: "implementer-1",
      status: "running",
      progress: "reused without respawn",
      currentTool: "read_file",
    },
  });
  assert.equal(state.warmIdleLeases.length, 0);
  assert.equal(state.activeAgents.length, 1);
  assert.equal(state.reuseCount, 2);
  assert.equal(state.lastReuseReason, "reuse_allowed");

  state = agiWorkflowReducer(state, {
    type: "agi_workflow_worker_lease",
    eventType: "workflow.worker_reuse.decision",
    workflowId: "workflow-1",
    logicalAgentId: "critic-1",
    taskId: "task-critic",
    stageKind: "critic",
    allowed: false,
    reason: "stage_requires_fresh_worker",
    leaseId: null,
    runtimeId: null,
  });
  assert.equal(state.activeAgents.length, 1);
  assert.equal(state.lastReuseReason, "stage_requires_fresh_worker");

  state = agiWorkflowReducer(state, {
    type: "agi_workflow_warm_pool",
    size: 1,
    lease: {
      leaseId: "lease-1",
      workerId: "worker-1",
      name: "Warm Worker",
      status: "warm_idle",
      reuseCount: 2,
      reuseReason: "stage complete",
    },
  });
  assert.equal(state.activeAgents.length, 0);
  assert.equal(state.warmIdleLeases.length, 1);

  state = agiWorkflowReducer(state, {
    type: "agi_workflow_evicted",
    schema: "sophia.workflow.worker_reuse_event.v1",
    eventType: "workflow.worker_reuse.eviction",
    workflowId: "workflow-1",
    logicalAgentId: "implementer-1",
    leaseId: "lease-1",
    runtimeId: "worker-1",
    reason: "idle TTL expired",
    evictedAt: 10_000,
  });
  assert.equal(state.warmIdleLeases.length, 0);
  assert.equal(state.warmPoolSize, 0);
  assert.equal(state.recentAgents[0]?.status, "evicted");
  assert.match(state.recentAgents[0]?.archiveReason || "", /TTL expired/);
});

test("terminal state and safety flags fail closed and hidden reasoning is never projected", () => {
  let state = agiWorkflowReducer(EMPTY_AGI_WORKFLOW_STATE, {
    type: "agi_workflow_start",
    runId: "safe-run",
    candidateOnly: false,
    canClaimAGI: true,
    chainOfThought: "do not expose this",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_node_start",
    node: {
      id: "safe-node",
      title: "Collect evidence",
      reasoning: "hidden private reasoning",
    },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_worker_lease",
    agent: {
      id: "safe-agent",
      name: "Evidence worker",
      status: "running",
      progress: "2/3 checks complete",
      currentTool: "pytest",
      currentStatus: "verifying",
      evidenceSummary: "two deterministic checks passed",
      thinking: "hidden worker thought",
    },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_end",
    status: "candidate_complete",
    archived: true,
    reason: "independent verification remains",
    candidateOnly: false,
    canClaimAGI: true,
  });

  assert.equal(state.candidateOnly, true);
  assert.equal(state.canClaimAGI, false);
  assert.equal(state.active, false);
  assert.equal(state.terminal, true);
  assert.equal(state.archiveState, "archived");
  assert.equal(state.terminalStatus, "candidate_complete");
  assert.equal(state.status, "archived");

  const rendered = JSON.stringify({
    compact: selectAGIWorkflowCompactSummary(state),
    rows: selectAGIWorkflowDetailRows(state),
  });
  assert.doesNotMatch(rendered, /do not expose this/);
  assert.doesNotMatch(rendered, /hidden private reasoning/);
  assert.doesNotMatch(rendered, /hidden worker thought/);
  assert.match(rendered, /2\/3 checks complete/);
  assert.match(rendered, /pytest/);
  assert.match(rendered, /two deterministic checks passed/);
  assert.match(rendered, /candidateOnly:true/);
  assert.match(rendered, /canClaimAGI:false/);
});

test("terminal latch rejects late node and lease events for the same run", () => {
  let state = agiWorkflowReducer(EMPTY_AGI_WORKFLOW_STATE, {
    type: "agi_workflow_start",
    runId: "terminal-run",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_node_start",
    runId: "terminal-run",
    node: { id: "node-1", title: "Finish once" },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_end",
    runId: "terminal-run",
    status: "succeeded",
  });
  const terminal = state;

  state = agiWorkflowReducer(state, {
    type: "agi_workflow_node_start",
    runId: "terminal-run",
    node: { id: "late-node", title: "Must not resurrect" },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_worker_lease",
    runId: "terminal-run",
    agent: { id: "late-agent", status: "running" },
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_warm_pool",
    runId: "terminal-run",
    size: 1,
    leases: [{ leaseId: "late-lease", status: "warm_idle" }],
  });

  assert.deepEqual(state, terminal);
  assert.equal(state.active, false);
  assert.equal(state.terminal, true);
  assert.equal(state.currentNode?.id, "node-1");
  assert.equal(state.activeAgents.length, 0);
  assert.equal(state.warmIdleLeases.length, 0);

  const nextRun = agiWorkflowReducer(state, {
    type: "agi_workflow_start",
    runId: "next-run",
  });
  assert.equal(nextRun.runId, "next-run");
  assert.equal(nextRun.terminal, false);
  assert.equal(nextRun.active, true);
});

test("cancelled and interrupted terminal receipts close node and nested workflow", () => {
  for (const status of ["cancelled", "interrupted"] as const) {
    let state = agiWorkflowReducer(EMPTY_AGI_WORKFLOW_STATE, {
      type: "agi_workflow_start",
      runId: `run-${status}`,
    });
    state = agiWorkflowReducer(state, {
      type: "agi_workflow_node_start",
      runId: `run-${status}`,
      node: { id: `node-${status}`, title: "Bounded node" },
    });
    state = agiWorkflowReducer(state, {
      type: "agi_workflow_workflow_start",
      runId: `run-${status}`,
      workflow: {
        id: `workflow-${status}`,
        status: "running",
        stage: 1,
      },
      agents: [{ id: "worker", status: "running" }],
    });
    state = agiWorkflowReducer(state, {
      type: "agi_workflow_end",
      runId: `run-${status}`,
      status,
      workflowStatus: "running",
    });

    assert.equal(state.status, status);
    assert.equal(state.currentNode?.status, status);
    assert.equal(state.workflow?.status, status);
    assert.equal(state.active, false);
    assert.equal(state.terminal, true);
  }
});

test("unknown and never-started AGI agents fail closed instead of looking queued", () => {
  let state = agiWorkflowReducer(EMPTY_AGI_WORKFLOW_STATE, {
    type: "agi_workflow_start",
    runId: "agi-unknown",
  });
  state = agiWorkflowReducer(state, {
    type: "agi_workflow_workflow_start",
    workflow: {
      id: "wf-unknown",
      pattern: "fan-out",
      stage: 1,
    },
    agents: [
      { id: "agent-a", name: "Known", status: "running" },
      { id: "agent-b", name: "Blank", status: "" },
      { id: "agent-c", name: "Mystery", status: "not-a-real-status" },
      { id: "agent-d", name: "Never", status: "never_started" },
    ],
  });
  assert.equal(state.activeAgents[0]?.status, "running");
  assert.equal(state.activeAgents[1]?.status, "unstarted");
  assert.equal(state.activeAgents[2]?.status, "unstarted");
  assert.equal(state.activeAgents[3]?.status, "unstarted");
  assert.notEqual(state.activeAgents[1]?.status, "queued");
  assert.notEqual(state.activeAgents[2]?.status, "queued");
});
