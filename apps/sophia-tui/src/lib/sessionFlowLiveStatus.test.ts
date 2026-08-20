import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_DYNAMIC_WORKFLOW_STATE,
  type DynamicWorkflowState,
} from "./dynamicWorkflowState.js";
import {
  EMPTY_AGI_WORKFLOW_STATE,
  type AGIWorkflowAgent,
  type AGIWorkflowState,
} from "./agiWorkflowState.js";
import {
  agiWorkflowCompoundStatus,
  dynamicWorkflowCompoundStatus,
  selectAGIWorkflowStageStatuses,
  selectAGIWorkflowWorkerStatuses,
  selectDynamicWorkflowStageStatuses,
  selectDynamicWorkflowWorkerStatuses,
} from "./sessionFlowLiveStatus.js";

function dynamicState(
  overrides: Partial<DynamicWorkflowState>,
): DynamicWorkflowState {
  return {
    ...EMPTY_DYNAMIC_WORKFLOW_STATE,
    ...overrides,
  };
}

function agiAgent(
  overrides: Partial<AGIWorkflowAgent>,
): AGIWorkflowAgent {
  return {
    key: "agent",
    id: "agent",
    leaseId: "",
    workerId: "",
    name: "Agent",
    role: "",
    nodeId: "",
    stage: 1,
    status: "running",
    progress: "",
    currentTool: "",
    currentStatus: "",
    evidenceSummary: "",
    reuseCount: 0,
    reuseReason: "",
    startedAt: "",
    updatedAt: "",
    endedAt: "",
    ...overrides,
  };
}

function agiState(
  overrides: Partial<AGIWorkflowState>,
): AGIWorkflowState {
  return {
    ...EMPTY_AGI_WORKFLOW_STATE,
    ...overrides,
  };
}

test("AGI live-status counts never-started workers as failed, not queued", () => {
  const state = agiState({
    active: true,
    status: "running",
    route: "workflow",
    currentNode: {
      id: "node-1",
      index: 1,
      title: "Inspect",
      status: "running",
      route: "workflow",
      evidenceSummary: "",
      startedAt: "",
      endedAt: "",
    },
    workflow: {
      id: "wf-unstarted",
      pattern: "fan-out",
      status: "running",
      currentStage: 1,
      maxStages: 1,
      barrier: {
        stage: 1,
        status: "running",
        completed: 0,
        total: 2,
        label: "",
      },
      evidenceSummary: "",
      startedAt: "",
      endedAt: "",
    },
    activeAgents: [
      agiAgent({
        key: "done",
        id: "done",
        name: "Done",
        status: "succeeded",
      }),
      agiAgent({
        key: "missing",
        id: "missing",
        name: "Missing",
        status: "unstarted",
      }),
    ],
  });
  const summary = agiWorkflowCompoundStatus(state);
  assert.match(summary.detailLines.join("\n"), /1 failed/);
  assert.doesNotMatch(summary.detailLines.join("\n"), /1 queued/);
  const workers = selectAGIWorkflowWorkerStatuses(state, { stageIndex: 1 });
  const missing = workers.find((worker) => worker.label === "Missing");
  assert.equal(missing?.status, "failed");
  assert.equal(missing?.queued, false);
});

test("idle workflow stays non-expandable without claiming progress", () => {
  const summary = dynamicWorkflowCompoundStatus(
    dynamicState({ configuredMode: "auto" }),
  );
  assert.equal(summary.status, "info");
  assert.equal(summary.expandable, false);
  assert.equal(summary.progressCurrent, 0);
  assert.equal(summary.progressTotal, 0);
  assert.equal(summary.progressLabel, "No stage dispatched");
});

test("running multi-worker workflow reports stage, barrier, counts, and selectors", () => {
  const state = dynamicState({
    active: true,
    selected: true,
    status: "running",
    phase: "workers",
    currentStage: 2,
    maxStages: 4,
    pattern: "fan-out",
    stages: [{
      index: 2,
      pattern: "fan-out",
      goal: "Inspect independent surfaces",
      status: "running",
      maxConcurrency: 2,
      agents: [
        {
          name: "Reader",
          index: 0,
          status: "running",
          active: true,
          role: "reviewer",
          skills: ["repo-analysis"],
          summary: "",
          progress: "reading reducers",
        },
        {
          name: "Tester",
          index: 1,
          status: "queued_for_model",
          active: false,
          role: "tester",
          skills: ["node-test"],
          summary: "",
          progress: "",
        },
        {
          name: "Reporter",
          index: 2,
          status: "succeeded",
          active: false,
          role: "reporter",
          skills: [],
          summary: "report received",
          progress: "",
        },
      ],
    }],
  });
  const summary = dynamicWorkflowCompoundStatus(state);
  assert.equal(summary.status, "running");
  assert.equal(summary.progressCurrent, 2);
  assert.equal(summary.progressTotal, 4);
  assert.equal(summary.barrierCurrent, 1);
  assert.equal(summary.barrierTotal, 3);
  assert.equal(summary.reportCount, 1);
  assert.equal(summary.activeCount, 1);
  assert.equal(summary.queuedCount, 1);
  assert.equal(summary.succeededCount, 1);
  assert.match(summary.progressLabel, /Stage 2\/4 · barrier 1\/3/);
  assert.match(summary.detailLines.join("\n"), /Pattern fan-out/);

  const stages = selectDynamicWorkflowStageStatuses(state);
  const workers = selectDynamicWorkflowWorkerStatuses(state, 2);
  assert.deepEqual(
    stages.map((stage) => [stage.id, stage.label, stage.workerCount]),
    [["dynamic-workflow-stage:2", "Stage 2", 3]],
  );
  assert.deepEqual(
    workers.map((worker) => worker.id),
    [
      "dynamic-workflow-worker:2:0:reader",
      "dynamic-workflow-worker:2:1:tester",
      "dynamic-workflow-worker:2:2:reporter",
    ],
  );
});

test("unstarted lanes fail-close live-status without filling the barrier", () => {
  const state = dynamicState({
    active: true,
    status: "running",
    currentStage: 1,
    maxStages: 1,
    pattern: "tui-parallel-barrier-smoke",
    stages: [{
      index: 1,
      pattern: "tui-parallel-barrier-smoke",
      goal: "Inspect independent surfaces",
      status: "failed",
      maxConcurrency: 4,
      agents: [
        {
          name: "Specialist 1",
          index: 0,
          status: "succeeded",
          active: false,
          role: "backend-durability",
          skills: [],
          summary: "ok",
        },
        {
          name: "Specialist 2",
          index: 1,
          status: "succeeded",
          active: false,
          role: "bridge-authority",
          skills: [],
          summary: "ok",
        },
        {
          name: "Specialist 3",
          index: 2,
          status: "unstarted",
          active: false,
          role: "tui-graph-reducer",
          skills: [],
          summary: "",
          failureReason: "never started",
        },
        {
          name: "Specialist 4",
          index: 3,
          status: "unstarted",
          active: false,
          role: "test-evidence",
          skills: [],
          summary: "",
          failureReason: "never started",
        },
      ],
    }],
  });
  const summary = dynamicWorkflowCompoundStatus(state);
  const stage = selectDynamicWorkflowStageStatuses(state)[0];
  const workers = selectDynamicWorkflowWorkerStatuses(state, 1);

  assert.equal(summary.status, "failed");
  assert.equal(summary.succeededCount, 2);
  assert.equal(summary.failedCount, 2);
  assert.equal(summary.barrierCurrent, 2);
  assert.equal(summary.barrierTotal, 4);
  assert.equal(summary.reportCount, 2);
  assert.match(summary.progressLabel, /barrier 2\/4/);
  assert.match(summary.detailLines.join("\n"), /Barrier 2\/4 resolved/);
  assert.doesNotMatch(summary.detailLines.join("\n"), /Barrier 4\/4/);
  assert.equal(stage?.barrierCurrent, 2);
  assert.equal(stage?.status, "failed");
  assert.deepEqual(
    workers.map((worker) => worker.status),
    ["succeeded", "succeeded", "failed", "failed"],
  );
});

test("cancelled dynamic-workflow workers keep a cancelled live status", () => {
  const state = dynamicState({
    active: false,
    status: "cancelled",
    currentStage: 1,
    stages: [{
      index: 1,
      pattern: "fan-out",
      goal: "Inspect",
      status: "failed",
      maxConcurrency: 1,
      agents: [{
        name: "Reviewer",
        index: 0,
        status: "cancelled",
        active: false,
        role: "",
        skills: [],
        summary: "operator cancelled",
      }],
    }],
  });
  const worker = selectDynamicWorkflowWorkerStatuses(state, 1)[0];
  assert.equal(worker?.status, "cancelled");
  assert.equal(dynamicWorkflowCompoundStatus(state).cancelledCount, 1);
});

test("skipped dynamic-workflow workers count as failed, not waiting", () => {
  const state = dynamicState({
    active: true,
    status: "reviewing",
    currentStage: 1,
    stages: [{
      index: 1,
      pattern: "fan-out",
      goal: "Inspect",
      status: "failed",
      maxConcurrency: 2,
      agents: [
        {
          name: "Done",
          index: 0,
          status: "succeeded",
          active: false,
          role: "",
          skills: [],
          summary: "ok",
        },
        {
          name: "Skipped",
          index: 1,
          status: "skipped",
          active: false,
          role: "",
          skills: [],
          summary: "",
        },
      ],
    }],
  });
  const summary = dynamicWorkflowCompoundStatus(state);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.succeededCount, 1);
  const skipped = selectDynamicWorkflowWorkerStatuses(state, 1)
    .find((worker) => worker.label === "Skipped");
  assert.equal(skipped?.status, "failed");
});

test("waiting input and failure are exposed without being counted as success", () => {
  const waiting = dynamicWorkflowCompoundStatus(dynamicState({
    active: true,
    status: "awaiting_input",
    phase: "workers",
    currentStage: 1,
    stages: [{
      index: 1,
      pattern: "review",
      goal: "",
      status: "running",
      maxConcurrency: 1,
      agents: [{
        name: "Reviewer",
        index: 0,
        status: "waiting_input",
        active: true,
        role: "",
        skills: [],
        summary: "",
        progress: "waiting for approval",
      }],
    }],
  }));
  assert.equal(waiting.status, "blocked");
  assert.equal(waiting.waitingCount, 1);
  assert.equal(waiting.succeededCount, 0);

  const failed = dynamicWorkflowCompoundStatus(dynamicState({
    status: "failed",
    currentStage: 1,
    stages: [{
      index: 1,
      pattern: "verify",
      goal: "",
      status: "failed",
      maxConcurrency: 1,
      agents: [{
        name: "Verifier",
        index: 0,
        status: "timed_out",
        active: false,
        role: "",
        skills: [],
        summary: "",
        progress: "worker inactivity timeout",
      }],
    }],
  }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.failedCount, 1);
  assert.equal(failed.tone, "danger");
});

test("live operational activity is terminal-safe, secret-redacted, and excludes hidden reasoning labels", () => {
  const state = dynamicState({
    active: true,
    status: "running",
    currentStage: 1,
    stages: [{
      index: 1,
      pattern: "review",
      goal: "",
      status: "running",
      maxConcurrency: 1,
      agents: [{
        name: "Reviewer",
        index: 0,
        status: "running",
        active: true,
        role: "",
        skills: [],
        summary: "",
        progress: "OPENAI_API_KEY=sk-proj-abcdefghijklmnop\u001b[31m",
      }],
    }],
  });
  const worker = selectDynamicWorkflowWorkerStatuses(state)[0]!;
  const visible = worker.detailLines.join("\n");

  assert.match(visible, /\[REDACTED\]/);
  assert.doesNotMatch(visible, /abcdefghijklmnop/);
  assert.doesNotMatch(visible, /\u001b/);

  state.stages[0]!.agents[0]!.progress =
    "hidden reasoning tokens are being generated";
  const hidden = selectDynamicWorkflowWorkerStatuses(state)[0]!;
  assert.doesNotMatch(hidden.detailLines.join("\n"), /hidden reasoning/i);
});

test("terminal workflow success reports succeeded only from an explicit terminal state", () => {
  const summary = dynamicWorkflowCompoundStatus(dynamicState({
    status: "succeeded",
    phase: "synthesis",
    currentStage: 1,
    maxStages: 2,
    stages: [{
      index: 1,
      pattern: "fan-out",
      goal: "",
      status: "succeeded",
      maxConcurrency: 2,
      agents: [
        {
          name: "A",
          index: 0,
          status: "succeeded",
          active: false,
          role: "",
          skills: [],
          summary: "report A",
        },
        {
          name: "B",
          index: 1,
          status: "succeeded",
          active: false,
          role: "",
          skills: [],
          summary: "report B",
        },
      ],
    }],
  }));
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.tone, "success");
  assert.equal(summary.reportCount, 2);
  assert.equal(summary.failedCount, 0);
});

test("nested AGI workflow reports node route barrier and current tool", () => {
  const state = agiState({
    active: true,
    runId: "agi-1",
    status: "running",
    route: "workflow",
    currentNode: {
      id: "node-2",
      index: 2,
      title: "Verify integration",
      status: "running",
      route: "workflow",
      evidenceSummary: "",
      startedAt: "",
      endedAt: "",
    },
    workflow: {
      id: "wf-2",
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
      startedAt: "",
      endedAt: "",
    },
    activeAgents: [
      agiAgent({
        key: "verifier",
        id: "verifier",
        name: "Verifier",
        status: "running",
        progress: "checking reducer",
        currentTool: "node:test",
        updatedAt: "2026-08-14T10:00:00Z",
      }),
      agiAgent({
        key: "reader",
        id: "reader",
        name: "Reader",
        status: "queued",
      }),
    ],
  });
  const summary = agiWorkflowCompoundStatus(state);
  assert.equal(summary.status, "running");
  assert.equal(summary.title, "Verify integration");
  assert.equal(summary.progressCurrent, 1);
  assert.equal(summary.progressTotal, 3);
  assert.equal(summary.barrierCurrent, 1);
  assert.equal(summary.barrierTotal, 2);
  assert.equal(summary.latestActor, "Verifier");
  assert.equal(summary.latestActivity, "checking reducer");
  assert.match(summary.detailLines.join("\n"), /route workflow/);
  assert.match(summary.detailLines.join("\n"), /review-and-test/);

  const stage = selectAGIWorkflowStageStatuses(state)[0];
  const workers = selectAGIWorkflowWorkerStatuses(state, { stageIndex: 1 });
  assert.equal(stage?.id, "agi-workflow-stage:wf-2:1");
  assert.equal(stage?.workerCount, 2);
  assert.deepEqual(
    workers.map((worker) => worker.id),
    ["agi-workflow-worker:reader", "agi-workflow-worker:verifier"],
  );
});

test("AGI stage and worker selectors exclude archived agents from previous nodes", () => {
  const state = agiState({
    active: true,
    runId: "agi-1",
    status: "running",
    route: "workflow",
    currentNode: {
      id: "node-b",
      index: 2,
      title: "Verify",
      status: "running",
      route: "workflow",
      evidenceSummary: "",
      startedAt: "",
      endedAt: "",
    },
    workflow: {
      id: "workflow-b",
      pattern: "verify",
      status: "running",
      currentStage: 1,
      maxStages: 2,
      barrier: {
        stage: 1,
        status: "running",
        completed: 0,
        total: 1,
        label: "",
      },
      evidenceSummary: "",
      startedAt: "",
      endedAt: "",
    },
    activeAgents: [
      agiAgent({
        key: "current-reader",
        id: "current-reader",
        name: "Current reader",
        nodeId: "node-b",
        stage: 1,
        status: "running",
      }),
    ],
    recentAgents: [
      {
        ...agiAgent({
          key: "old-critic",
          id: "old-critic",
          name: "Old critic",
          nodeId: "node-a",
          stage: 1,
          status: "failed",
        }),
        archiveId: "archive-old-critic",
        archivedAt: "2026-08-14T10:00:00Z",
        archiveReason: "node advanced",
      },
    ],
  });

  const stage = selectAGIWorkflowStageStatuses(state)[0];
  const workers = selectAGIWorkflowWorkerStatuses(state, {
    stageIndex: 1,
    includeRecent: true,
  });

  assert.equal(stage?.status, "running");
  assert.equal(stage?.failedCount, 0);
  assert.equal(stage?.workerCount, 1);
  assert.deepEqual(
    workers.map((worker) => worker.label),
    ["Current reader"],
  );
});

test("AGI waiting, failure, cancellation, and terminal success remain distinct", () => {
  const waiting = agiWorkflowCompoundStatus(agiState({
    active: true,
    status: "awaiting_input",
    route: "solo",
  }));
  assert.equal(waiting.status, "blocked");

  const failure = agiWorkflowCompoundStatus(agiState({
    terminal: true,
    status: "failed",
    terminalStatus: "failed",
    archiveState: "terminal",
  }));
  assert.equal(failure.status, "failed");

  const cancelled = agiWorkflowCompoundStatus(agiState({
    terminal: true,
    status: "cancelled",
    terminalStatus: "cancelled",
    archiveState: "terminal",
  }));
  assert.equal(cancelled.status, "cancelled");

  const success = agiWorkflowCompoundStatus(agiState({
    terminal: true,
    status: "succeeded",
    terminalStatus: "succeeded",
    archiveState: "terminal",
  }));
  assert.equal(success.status, "succeeded");
});

test("AGI warm leases and reuse appear in bounded overview and worker selectors", () => {
  const state = agiState({
    active: true,
    status: "running",
    route: "workflow",
    warmPoolSize: 1,
    reuseCount: 3,
    lastReuseReason: "same provider and tool scope",
    warmIdleLeases: [{
      key: "warm-1",
      leaseId: "lease-1",
      workerId: "worker-1",
      name: "Warm Worker",
      role: "reviewer",
      nodeId: "node-1",
      stage: 1,
      reuseCount: 2,
      reuseReason: "stage complete",
      updatedAt: "2026-08-14T09:00:00Z",
    }],
  });
  const summary = agiWorkflowCompoundStatus(state);
  const workers = selectAGIWorkflowWorkerStatuses(state);
  assert.match(summary.detailLines.join("\n"), /1 warm lease/);
  assert.match(summary.detailLines.join("\n"), /Reuse 3/);
  assert.equal(workers[0]?.id, "agi-workflow-lease:warm-1");
  assert.equal(workers[0]?.warmLease, true);
  assert.equal(workers[0]?.reuseCount, 2);
});

test("recent progress choice prefers active agents and breaks timestamp ties deterministically", () => {
  const state = agiState({
    active: true,
    status: "running",
    route: "workflow",
    activeAgents: [
      agiAgent({
        key: "z-worker",
        name: "Zulu",
        progress: "z progress",
        updatedAt: "2026-08-14T10:00:00Z",
      }),
      agiAgent({
        key: "a-worker",
        name: "Alpha",
        progress: "alpha progress",
        updatedAt: "2026-08-14T10:00:00Z",
      }),
    ],
    recentAgents: [{
      ...agiAgent({
        key: "recent",
        name: "Recent",
        status: "succeeded",
        progress: "newer but archived",
        updatedAt: "2026-08-14T11:00:00Z",
      }),
      archiveId: "archive-recent",
      archivedAt: "2026-08-14T11:00:00Z",
      archiveReason: "complete",
    }],
  });
  const first = agiWorkflowCompoundStatus(state);
  const reordered = agiWorkflowCompoundStatus({
    ...state,
    activeAgents: state.activeAgents.slice().reverse(),
  });
  assert.equal(first.latestActor, "Alpha");
  assert.equal(reordered.latestActor, "Alpha");
  assert.equal(first.latestActivity, "alpha progress");
});

test("detail lines and operational text are bounded and hidden reasoning is dropped", () => {
  const long = `working ${"x".repeat(240)}`;
  const state = dynamicState({
    active: true,
    status: "running",
    phase: "workers",
    currentStage: 1,
    maxStages: 2,
    pattern: long,
    reason: long,
    stages: [{
      index: 1,
      pattern: long,
      goal: long,
      status: "running",
      maxConcurrency: 1,
      agents: [{
        name: "Worker",
        index: 0,
        status: "running",
        active: true,
        role: long,
        skills: [long],
        summary: "hidden reasoning: do not show this",
        progress: "chain of thought: secret tokens",
      }],
    }],
  });
  const summary = dynamicWorkflowCompoundStatus(state);
  const worker = selectDynamicWorkflowWorkerStatuses(state)[0];
  assert.ok(summary.detailLines.length <= 6);
  assert.ok(summary.detailLines.every((line) => line.length <= 112));
  assert.ok((worker?.detailLines.length || 0) <= 6);
  assert.ok(worker?.detailLines.every((line) => line.length <= 112));
  assert.doesNotMatch(JSON.stringify({ summary, worker }), /secret tokens|do not show/);
  assert.ok(summary.detailLines.some((line) => line.endsWith("…")));
});
