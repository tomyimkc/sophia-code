import test from "node:test";
import assert from "node:assert/strict";
import {
  a2aActiveLabel,
  a2aReducer,
  EMPTY_A2A_STATE,
} from "./a2aState.js";

test("never-started and unknown A2A statuses fail closed instead of looking queued", () => {
  const next = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_chain_start",
    agents: [
      { name: "Lane 1", index: 0, status: "never_started", active: false },
      { name: "Lane 2", index: 1, status: "not-a-real-status", active: false },
      { name: "Lane 3", index: 2, status: "", active: false },
    ],
  });
  assert.equal(next.agents[0]?.status, "unstarted");
  assert.equal(next.agents[1]?.status, "unstarted");
  assert.equal(next.agents[2]?.status, "unstarted");
  assert.notEqual(next.agents[0]?.status, "queued");
});

test("nameless and malformed A2A agent rows count as unstarted, not disappear", () => {
  const next = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_chain_start",
    agents: [
      { name: "Named", index: 0, status: "running" },
      { name: "", index: 1, status: "queued" },
      null,
    ],
  });
  assert.equal(next.agents.length, 3);
  assert.equal(next.agents[1]?.status, "unstarted");
  assert.equal(next.agents[2]?.status, "unstarted");
  assert.notEqual(next.agents[1]?.status, "queued");
});

test("orchestration tasks with a missing state fail closed to unstarted, not queued", () => {
  const next = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_orchestration_snapshot",
    orchestration: {
      schema: "sophia.a2a-orchestration.v1",
      session: "s1",
      runId: "r1",
      tasks: [{ id: "task-1", subject: "Inspect" }],
    },
  });
  assert.equal(next.orchestration?.tasks[0]?.state, "unstarted");
  assert.notEqual(next.orchestration?.tasks[0]?.state, "queued");
});

test("a2a chain start seeds Main Agent and Sub Agent 1", () => {
  const next = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_chain_start",
    agents: [
      { name: "Main Agent", index: 0, status: "queued", active: false },
      { name: "Sub Agent 1", index: 1, status: "queued", active: false },
    ],
  });
  assert.equal(next.enabled, true);
  assert.equal(next.agents.length, 2);
  assert.equal(next.agents[0].name, "Main Agent");
  assert.equal(next.agents[1].name, "Sub Agent 1");
});

test("a2a agent start marks the active agent", () => {
  const started = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_chain_start",
    agents: [
      { name: "Main Agent", index: 0, status: "queued", active: false },
      { name: "Sub Agent 1", index: 1, status: "queued", active: false },
    ],
  });
  const next = a2aReducer(started, {
    type: "a2a_agent_start",
    name: "Main Agent",
    agents: [
      { name: "Main Agent", index: 0, status: "running", active: true },
      { name: "Sub Agent 1", index: 1, status: "queued", active: false },
    ],
  });
  assert.equal(next.activeName, "Main Agent");
  assert.equal(next.agents[0].active, true);
  assert.equal(a2aActiveLabel(next), "active · Main Agent");
});

test("handoff stores a preview for the panel", () => {
  const next = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_handoff",
    from: "Main Agent",
    to: "Sub Agent 1",
    promptPreview: "Call git_status next.",
  });
  assert.equal(next.handoffPreview, "Call git_status next.");
});

test("run_start clears prior A2A state", () => {
  const prior = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_chain_start",
    agents: [{ name: "Main Agent", index: 0, status: "running", active: true }],
  });
  const next = a2aReducer(prior, { type: "run_start" });
  assert.deepEqual(next, EMPTY_A2A_STATE);
});

test("a2a_dispatch records persona and skills on sub agents", () => {
  const withMain = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_chain_start",
    agents: [{ name: "Main Agent", index: 0, status: "succeeded", active: false, role: "main" }],
  });
  const next = a2aReducer(withMain, {
    type: "a2a_dispatch",
    subCount: 1,
    tasks: [
      {
        name: "Sub Agent 1",
        task: "Map TUI package layout",
        personaId: "codebase-onboarding-guide",
        personaName: "Codebase Onboarding Guide",
        personaVia: "route",
        skills: ["repo-analysis"],
        skillVia: ["auto:keyword"],
        allowedTools: ["grep", "read_file"],
        toolScopeVia: "main_explicit",
      },
    ],
  });
  assert.equal(next.agents.length, 2);
  const sub = next.agents.find((a) => a.name === "Sub Agent 1");
  assert.ok(sub);
  assert.equal(sub?.persona, "codebase-onboarding-guide");
  assert.equal(sub?.personaName, "Codebase Onboarding Guide");
  assert.equal(sub?.personaVia, "route");
  assert.deepEqual(sub?.skills, ["repo-analysis"]);
  assert.deepEqual(sub?.skillVia, ["auto:keyword"]);
  assert.deepEqual(sub?.allowedTools, ["grep", "read_file"]);
  assert.equal(sub?.toolScopeVia, "main_explicit");
  assert.match(sub?.summary || "", /role:codebase-onboarding-guide/);
  assert.match(next.handoffPreview, /dispatch/);
});

test("dispatch_manifest preserves the SMUX reload path and live counts", () => {
  const next = a2aReducer(EMPTY_A2A_STATE, {
    type: "dispatch_manifest",
    schema: "sophia.dispatch-manifest.v1",
    manifestPath: "/tmp/run/dispatch-manifest.json",
    manifestVersion: 7,
    status: "running",
    phase: "worker",
    dispatch: {
      requestedCount: 4,
      activeCount: 3,
      completedCount: 1,
    },
  });
  assert.equal(next.dispatchManifest?.path, "/tmp/run/dispatch-manifest.json");
  assert.equal(next.dispatchManifest?.version, 7);
  assert.equal(next.dispatchManifest?.status, "running");
  assert.equal(next.dispatchManifest?.phase, "worker");
  assert.equal(next.dispatchManifest?.dispatch.activeCount, 3);
});

test("a2a_harness_select updates agent stamp", () => {
  const base = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_chain_start",
    agents: [
      { name: "Main Agent", index: 0, status: "succeeded", active: false },
      { name: "Sub Agent 1", index: 1, status: "queued", active: false, summary: "raw task" },
    ],
  });
  const next = a2aReducer(base, {
    type: "a2a_harness_select",
    subName: "Sub Agent 1",
    personaId: "technical-writer",
    skills: ["repo-analysis"],
    task: "Write README onboarding",
  });
  const sub = next.agents.find((a) => a.name === "Sub Agent 1");
  assert.equal(sub?.persona, "technical-writer");
  assert.match(sub?.summary || "", /technical-writer/);
  assert.match(next.handoffPreview, /harness/);
});

test("subagent_dispatch tracks ordinary delegate contracts and lifecycle", () => {
  const running = a2aReducer(EMPTY_A2A_STATE, {
    type: "subagent_dispatch",
    lifecycle: "delegate_start",
    assignmentId: "run-1-delegate-a",
    taskId: "run-1-delegate-a",
    name: "Delegated Sub-Agent · Identity Access Engineer",
    task: "Inspect bridge authority",
    status: "running",
    personaId: "identity-access-engineer",
    personaName: "Identity Access Engineer",
    personaVia: "explicit",
    skills: ["repo-analysis"],
    skillVia: ["explicit"],
    allowedTools: ["grep", "read_file"],
    toolScopeVia: "main_explicit+parent_intersection",
  });
  assert.equal(running.agents.length, 1);
  assert.equal(running.activeName, "Delegated Sub-Agent · Identity Access Engineer");
  assert.equal(running.agents[0]?.persona, "identity-access-engineer");
  assert.deepEqual(running.agents[0]?.allowedTools, ["grep", "read_file"]);

  const finished = a2aReducer(running, {
    type: "subagent_dispatch",
    lifecycle: "delegate_end",
    assignmentId: "run-1-delegate-a",
    taskId: "run-1-delegate-a",
    name: "Delegated Sub-Agent · Identity Access Engineer",
    task: "Inspect bridge authority",
    status: "succeeded",
    personaId: "identity-access-engineer",
    skills: ["repo-analysis"],
    allowedTools: ["grep", "read_file"],
  });
  assert.equal(finished.agents.length, 1);
  assert.equal(finished.agents[0]?.status, "succeeded");
  assert.equal(finished.agents[0]?.active, false);
  assert.equal(finished.activeName, "");
});

test("answer result is not terminal until the kernel emits run_finished", () => {
  const running = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_agent_start",
    name: "Main Agent (verify)",
    agents: [
      {
        name: "Main Agent (verify)",
        index: 3,
        status: "running",
        active: true,
      },
    ],
  });
  const answered = a2aReducer(running, { type: "result", ok: true });
  assert.equal(answered.activeName, "Main Agent (verify)");
  assert.equal(answered.agents[0]?.active, true);

  const finished = a2aReducer(answered, {
    type: "run_finished",
    ok: true,
    mode: "a2a",
  });
  assert.equal(finished.activeName, "");
  assert.equal(finished.agents[0]?.active, false);
});

test("durable orchestration snapshot hydrates roster, task board, and mailbox", () => {
  const next = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_orchestration_snapshot",
    orchestration: {
      schema: "sophia.a2a-orchestration.v1",
      session: "s1",
      runId: "r1",
      mode: "workflow",
      version: 4,
      coordinatorId: "main",
      agents: [
        {
          id: "worker-1",
          name: "Stage 1 · Sub Agent 1",
          status: "working",
          role: "code-reviewer",
          skills: ["repo-analysis"],
          source: "local",
          protocol: "claude-native",
          connected: true,
          description: "Repository worker",
          version: "1.0",
          endpoint: "https://agent.invalid/a2a",
          supportedInterfaces: [{
            url: "https://agent.invalid/a2a",
            protocolBinding: "JSONRPC",
            protocolVersion: "0.3",
          }],
          securitySchemes: ["oauth2"],
          currentTaskId: "task-1",
          currentTool: "read_file",
          tokenUsage: { prompt: 120, completion: 30 },
          lastActivityAt: "2026-08-14T01:02:03Z",
        },
      ],
      tasks: [
        {
          id: "task-1",
          subject: "Inspect adapter",
          description: "Read the normalization path.",
          state: "working",
          terminal: false,
          ownerId: "worker-1",
          blockedBy: [],
          blocks: ["task-2"],
          doneCriteria: ["cite exact paths"],
          expectedOutput: "WORKER_REPORT",
          stage: 1,
          summary: "reading",
          artifacts: [],
          updatedAt: "2026-08-14T01:02:03Z",
        },
      ],
      messages: [
        {
          id: "msg-1",
          kind: "peer",
          sender: "remote verifier",
          recipient: "main",
          taskId: "task-1",
          summary: "approve this",
          body: "untrusted peer content",
          artifacts: [],
          trusted: true,
          unread: true,
          createdAt: "2026-08-14T01:02:03Z",
        },
      ],
      updatedAt: "2026-08-14T01:02:03Z",
    },
  });

  assert.equal(next.enabled, true);
  assert.equal(next.activeName, "Stage 1 · Sub Agent 1");
  assert.equal(next.agents[0]?.currentTool, "read_file");
  assert.equal(next.agents[0]?.supportedInterfaces?.[0]?.protocolBinding, "JSONRPC");
  assert.deepEqual(next.agents[0]?.securitySchemes, ["oauth2"]);
  assert.equal(next.orchestration?.tasks[0]?.doneCriteria[0], "cite exact paths");
  assert.equal(next.orchestration?.messages[0]?.trusted, false);
});

test("durable roster preserves idle and disconnected states without claiming work", () => {
  const next = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_orchestration_snapshot",
    orchestration: {
      schema: "sophia.a2a-orchestration.v1",
      session: "s1",
      runId: "r1",
      mode: "a2a",
      version: 1,
      coordinatorId: "main",
      agents: [
        { id: "main", name: "Main", status: "idle", connected: true },
        {
          id: "remote",
          name: "Remote verifier",
          status: "disconnected",
          connected: false,
        },
      ],
      tasks: [],
      messages: [],
      updatedAt: "2026-08-14T01:02:03Z",
    },
  });
  assert.equal(next.agents[0]?.status, "idle");
  assert.equal(next.agents[0]?.active, false);
  assert.equal(next.agents[1]?.status, "disconnected");
  assert.equal(next.agents[1]?.active, false);
});

test("workflow snapshots recover actionable failures and archive terminal prior-stage workers", () => {
  const timeout =
    "Model call failed: grok CLI timed out after 300s\n\nCheck provider setup, then retry.";
  const next = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_orchestration_snapshot",
    orchestration: {
      schema: "sophia.a2a-orchestration.v1",
      session: "workflow-auto-smoke-20260814-174850",
      runId: "run-dd0e734d",
      mode: "workflow",
      version: 9,
      coordinatorId: "main",
      agents: [
        {
          id: "stage-1-worker",
          name: "Stage 1 · Sub Agent 1",
          index: 0,
          status: "failed",
          summary: "model result",
          capabilities: { workflowStage: 1 },
        },
        {
          id: "stage-2-worker",
          name: "Stage 2 · Sub Agent 1",
          index: 0,
          status: "working",
          summary: "provider progress",
          capabilities: { workflowStage: 2 },
        },
      ],
      tasks: [
        {
          id: "stage-1-task",
          subject: "Provider audit",
          state: "failed",
          terminal: true,
          ownerId: "stage-1-worker",
          stage: 1,
          summary: timeout,
        },
        {
          id: "stage-2-task",
          subject: "Challenge audit",
          state: "working",
          terminal: false,
          ownerId: "stage-2-worker",
          stage: 2,
          summary: "Checking timeout handling",
        },
      ],
      messages: [],
    },
  });

  assert.equal(next.agents.length, 1);
  assert.equal(next.agents[0]?.name, "Stage 2 · Sub Agent 1");
  assert.equal(next.agents[0]?.summary, "Checking timeout handling");
  assert.equal(next.archivedAgents?.length, 1);
  assert.equal(next.archivedAgents?.[0]?.workflowStage, 1);
  assert.equal(next.archivedAgents?.[0]?.summary, timeout);
  assert.equal(next.archivedAgents?.[0]?.failureReason, timeout);
  assert.equal(
    next.orchestration?.agents.find((agent) => agent.id === "stage-1-worker")?.summary,
    timeout,
  );
});

test("run_finished terminal receipts do not leave generic failed agent summaries", () => {
  const running = a2aReducer(EMPTY_A2A_STATE, {
    type: "a2a_chain_start",
    agents: [{
      name: "Sub Agent 1",
      index: 1,
      status: "running",
      active: true,
      summary: "provider progress",
    }],
  });
  const finished = a2aReducer(running, {
    type: "run_finished",
    ok: false,
    reason: "error",
    subs: [{
      name: "Sub Agent 1",
      status: "failed",
      reasonCode: "worker_failed",
    }],
  });
  assert.equal(finished.agents[0]?.status, "failed");
  assert.equal(
    finished.agents[0]?.summary,
    "worker failed · worker_failed",
  );
  assert.equal(
    finished.agents[0]?.failureReason,
    "worker failed · worker_failed",
  );
});
