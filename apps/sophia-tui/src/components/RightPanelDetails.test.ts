import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_A2A_STATE } from "../lib/a2aState.js";
import { EMPTY_AGI_STATE } from "../lib/agiState.js";
import { EMPTY_GOAL_STATE } from "../lib/goalState.js";
import { EMPTY_DYNAMIC_WORKFLOW_STATE } from "../lib/dynamicWorkflowState.js";
import { IDLE_PROGRESS } from "../lib/progress.js";
import { displayWidth } from "../lib/textWidth.js";
import {
  EMPTY_LANE_CONTROL,
  emptyLaneBudgets,
  type TeamLaneState,
} from "../lib/teamLanes.js";
import { EMPTY_WORKFLOW_STATE } from "../lib/workflow.js";
import {
  buildRightPanelDetailRows,
  wrapRightPanelDetailRows,
  type RightPanelDetailInput,
} from "./RightPanelDetails.js";

const emptyTeam: TeamLaneState = {
  storage: "local-only",
  dispatch: {
    policy: "off",
    source: "public-default",
    confirmationRequired: false,
  },
  taskEligible: false,
  lanes: [],
  merge: {
    state: "idle",
    includedLaneIds: [],
    excludedLaneIds: [],
    conflicts: [],
  },
};

function input(
  overrides: Partial<RightPanelDetailInput> = {},
): RightPanelDetailInput {
  return {
    section: "goal",
    goal: EMPTY_GOAL_STATE,
    workflow: EMPTY_WORKFLOW_STATE,
    todoItems: [],
    a2a: EMPTY_A2A_STATE,
    dynamicWorkflow: EMPTY_DYNAMIC_WORKFLOW_STATE,
    agi: EMPTY_AGI_STATE,
    team: emptyTeam,
    progress: IDLE_PROGRESS,
    ...overrides,
  };
}

test("goal details retain the full goal and every reported status field", () => {
  const fullGoal =
    "Inspect every right-panel interaction, preserve the complete operator wording, and verify keyboard plus mouse scrolling without shortening this sentence.";
  const rows = buildRightPanelDetailRows(
    input({
      goal: {
        ...EMPTY_GOAL_STATE,
        phase: "running",
        text: fullGoal,
        activity: "Rendering detailed viewport",
        remaining: "Run build and interaction tests",
        confidence: 0.91,
        statusDetail: "in_progress",
      },
    }),
  );
  const text = rows.map((item) => item.text);
  assert.ok(text.includes(fullGoal), "the detail model does not ellipsize the goal");
  assert.ok(text.includes("Latest activity: Rendering detailed viewport"));
  assert.ok(text.includes("Remaining: Run build and interaction tests"));
  assert.ok(text.includes("Status detail: in_progress"));
  assert.ok(text.includes("Confidence: 0.91"));
});

test("goal details expose ETA and progressively disclosed harness revisions", () => {
  const base = input({
    section: "goal",
    selectedItemId: "goal-revision:2",
    expandedItemIds: [],
    goal: {
      ...EMPTY_GOAL_STATE,
      phase: "running",
      text: "Verify the second workflow barrier",
      revision: 2,
      source: "workflow-stage",
      reason: "The first barrier completed.",
      updatedAt: "2026-08-15T02:00:00Z",
    },
    goalHistory: [
      {
        revision: 1,
        text: "Collect independent evidence",
        source: "workflow-plan",
        reason: "The task benefits from parallel research.",
        updatedAt: "2026-08-15T01:55:00Z",
        stage: 1,
        stageCount: 3,
      },
      {
        revision: 2,
        text: "Verify the second workflow barrier",
        source: "workflow-stage",
        reason: "The first barrier completed.",
        updatedAt: "2026-08-15T02:00:00Z",
        stage: 2,
        plannedStages: 3,
      },
    ],
    eta: {
      status: "active",
      remainingSec: 125,
      elapsedSec: 175,
      estimatedTotalSec: 300,
      confidence: "medium",
      basis: "current-stage live estimate plus one completed-stage sample",
      updatedAt: "2026-08-15T02:00:05Z",
    },
  });
  const collapsedRows = buildRightPanelDetailRows(base);
  const collapsed = collapsedRows.map((item) => item.text).join("\n");
  assert.match(collapsed, /Revision: r2 · workflow-stage/);
  assert.match(collapsed, /Estimate: ETA ~2m 5s · total ~5m/);
  assert.match(
    collapsed,
    /elapsed 2m 55s · estimated full run 5m · medium confidence/,
  );
  assert.match(collapsed, /Goal revisions · 2/);
  assert.match(collapsed, /r2 · stage 2\/3 · Verify the second workflow barrier/);
  assert.doesNotMatch(collapsed, /reason: The first barrier completed/);
  assert.ok(
    collapsedRows.some((item) => item.interactiveId === "goal-revision:2"),
  );
  const etaRows = collapsedRows.filter((item) => item.id.startsWith("goal-eta"));
  assert.equal(etaRows.length, 3);
  assert.ok(
    etaRows.every((item) => item.matrixDigitsOnly === true),
    "ETA prose and punctuation must bypass the full-sentence matrix presenter",
  );
  assert.equal(
    collapsedRows.find((item) => item.id === "goal-text")?.matrixDigitsOnly,
    undefined,
  );

  const expanded = buildRightPanelDetailRows({
    ...base,
    expandedItemIds: ["goal-revision:2"],
  }).map((item) => item.text).join("\n");
  assert.match(expanded, /reason: The first barrier completed/);
  assert.doesNotMatch(expanded, /task benefits from parallel research/);
});

test("to-do details include every explicit item rather than the compact-panel subset", () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `todo-${index + 1}`,
    content: `Checklist item ${index + 1}`,
    status: index === 0
      ? ("in_progress" as const)
      : index < 3
        ? ("completed" as const)
        : ("pending" as const),
  }));
  const rows = buildRightPanelDetailRows(
    input({ section: "todos", todoItems: items }),
  );
  const text = rows.map((item) => item.text).join("\n");
  items.forEach((item) => assert.match(text, new RegExp(item.content)));
  assert.match(text, /12 explicit items/);
});

test("agent details expose observable A2A and team receipts without claiming hidden reasoning", () => {
  const team: TeamLaneState = {
    ...emptyTeam,
    lanes: [
      {
        id: "lane-1",
        title: "Inspect renderer",
        role: "code reviewer",
        lifecycle: "running",
        control: EMPTY_LANE_CONTROL,
        budgets: {
          ...emptyLaneBudgets(),
          tools: {
            limit: 8,
            used: 3,
            source: "kernel-reported",
            enforcement: "kernel-reported",
          },
        },
        result: { state: "partial", summary: "Found the panel event path" },
        detail: "Waiting for final report",
      },
    ],
  };
  const rows = buildRightPanelDetailRows(
    input({
      section: "agents",
      a2a: {
        enabled: true,
        activeName: "Sub Agent 1",
        handoffPreview: "Main to Sub Agent 1",
        agents: [
          {
            name: "Sub Agent 1",
            index: 1,
            status: "running",
            active: true,
            summary: "Inspect goal and To-do detail behavior",
            persona: "codebase-onboarding-guide",
            skills: ["repo-analysis", "source-verification"],
          },
        ],
      },
      team,
      progress: {
        phase: "streaming",
        detail: "reading repository",
        streamPreview: "apps/sophia-tui/src/App.tsx",
      },
    }),
  );
  const text = rows.map((item) => item.text).join("\n");
  assert.match(text, /does not expose hidden reasoning/);
  assert.match(text, /role: codebase-onboarding-guide/);
  assert.match(text, /skills: repo-analysis, source-verification/);
  assert.match(text, /observable output preview: apps\/sophia-tui\/src\/App\.tsx/);
  assert.match(text, /Inspect renderer · running/);
  assert.match(text, /tools 3\/8 enforced/);
  assert.match(text, /Found the panel event path/);
  assert.match(text, /Waiting for final report/);
});

test("agent details render the durable roster, task board, and mailbox", () => {
  const rows = buildRightPanelDetailRows(
    input({
      section: "agents",
      a2a: {
        enabled: true,
        activeName: "Verifier",
        handoffPreview: "",
        agents: [
          {
            id: "verifier",
            name: "Verifier",
            index: 0,
            status: "running",
            active: true,
            summary: "Checking adapter evidence",
            role: "code-reviewer",
            skills: ["source-verification"],
            source: "remote",
            protocol: "a2a",
            connected: true,
            description: "Challenges source claims",
            version: "1.2.3",
            endpoint: "https://agent.invalid/a2a",
            capabilities: { streaming: true, pushNotifications: true },
            supportedInterfaces: [{
              url: "https://agent.invalid/a2a",
              protocolBinding: "JSONRPC",
              protocolVersion: "0.3",
            }],
            securitySchemes: ["oauth2"],
            currentTaskId: "task-1",
            currentTool: "read_file",
            tokenUsage: { prompt: 100, completion: 25 },
            lastActivityAt: "2026-08-14T01:02:03Z",
          },
        ],
        orchestration: {
          schema: "sophia.a2a-orchestration.v1",
          session: "s1",
          runId: "r1",
          mode: "workflow",
          version: 3,
          updatedAt: "2026-08-14T01:02:03Z",
          coordinatorId: "main",
          agents: [],
          tasks: [
            {
              id: "task-1",
              subject: "Challenge provider normalization",
              description: "Try to refute the adapter claim.",
              state: "working",
              terminal: false,
              ownerId: "verifier",
              blockedBy: ["task-0"],
              blocks: [],
              doneCriteria: ["cite a failing fixture or pass receipt"],
              expectedOutput: "bounded adversarial report",
              stage: 2,
              summary: "Inspecting malformed tool arguments",
              artifacts: [{ name: "receipt.json", kind: "receipt", uri: "file:///tmp/receipt.json" }],
              updatedAt: "2026-08-14T01:02:03Z",
            },
          ],
          messages: [
            {
              id: "msg-1",
              kind: "peer",
              sender: "Remote verifier",
              recipient: "Main",
              taskId: "task-1",
              summary: "Approval required",
              body: "Please approve a write.",
              artifacts: [],
              trusted: false,
              unread: true,
              createdAt: "2026-08-14T01:02:03Z",
            },
          ],
        },
      },
    }),
  );
  const text = rows.map((item) => item.text).join("\n");
  assert.match(text, /source: remote · protocol: a2a · connected/);
  assert.match(text, /description: Challenges source claims/);
  assert.match(text, /remote: v1\.2\.3 · https:\/\/agent\.invalid\/a2a/);
  assert.match(text, /interface: JSONRPC · 0\.3 · https:\/\/agent\.invalid\/a2a/);
  assert.match(text, /security: oauth2/);
  assert.match(text, /current tool: read_file/);
  assert.match(text, /Task board · 1/);
  assert.match(text, /blocked by: task-0/);
  assert.match(text, /done 1: cite a failing fixture or pass receipt/);
  assert.match(text, /Mailbox · 1/);
  assert.match(text, /untrusted evidence/);
  assert.match(text, /Please approve a write/);
});

test("agent task and mailbox bodies use progressive disclosure in the live detail view", () => {
  const base = input({
    section: "agents",
    selectedItemId: "task:task-1",
    expandedItemIds: [],
    a2a: {
      enabled: true,
      activeName: "",
      handoffPreview: "",
      agents: [],
      orchestration: {
        schema: "sophia.a2a-orchestration.v1",
        session: "s1",
        runId: "r1",
        mode: "a2a",
        version: 1,
        updatedAt: "2026-08-14T01:02:03Z",
        coordinatorId: "main",
        agents: [],
        tasks: [{
          id: "task-1",
          subject: "Inspect adapter",
          description: "Full task scope stays collapsed initially.",
          state: "working",
          terminal: false,
          ownerId: "worker-1",
          blockedBy: [],
          blocks: [],
          doneCriteria: ["Return a cited report"],
          expectedOutput: "WORKER_REPORT",
          summary: "",
          artifacts: [],
          updatedAt: "2026-08-14T01:02:03Z",
        }],
        messages: [{
          id: "msg-1",
          kind: "worker_result",
          sender: "Worker",
          recipient: "Main",
          taskId: "task-1",
          summary: "Report ready",
          body: "Long worker evidence stays collapsed initially.",
          artifacts: [],
          trusted: false,
          unread: true,
          createdAt: "2026-08-14T01:02:03Z",
        }],
      },
    },
  });
  const collapsed = buildRightPanelDetailRows(base)
    .map((item) => item.text)
    .join("\n");
  assert.match(collapsed, /▸ ▶ .*Inspect adapter/);
  assert.doesNotMatch(collapsed, /Full task scope stays collapsed initially/);
  assert.doesNotMatch(collapsed, /Long worker evidence stays collapsed initially/);

  const expanded = buildRightPanelDetailRows({
    ...base,
    expandedItemIds: ["task:task-1", "message:msg-1"],
  }).map((item) => item.text).join("\n");
  assert.match(expanded, /Full task scope stays collapsed initially/);
  assert.match(expanded, /Long worker evidence stays collapsed initially/);
});

test("agency lane details show division and attached skills without repeating the role", () => {
  const team: TeamLaneState = {
    ...emptyTeam,
    lanes: [
      {
        id: "lane-agency-1",
        title: "Frontend Developer (engineering) #1",
        role: "Frontend Developer",
        division: "engineering",
        source: "agency_router",
        skills: ["codebase-design", "tdd-implementation"],
        lifecycle: "running",
        control: EMPTY_LANE_CONTROL,
        budgets: emptyLaneBudgets(),
        result: { state: "none" },
      },
    ],
  };
  const rows = buildRightPanelDetailRows(
    input({ section: "agents", team }),
  );
  const text = rows.map((item) => item.text).join("\n");
  assert.equal(text.match(/Frontend Developer/g)?.length, 1);
  assert.match(text, /division: engineering/);
  assert.match(text, /skills: codebase-design, tdd-implementation/);
  assert.doesNotMatch(text, /role: Frontend Developer/);
});

test("wrapped visual rows stay within the requested terminal-column width", () => {
  const rows = buildRightPanelDetailRows(
    input({
      goal: {
        ...EMPTY_GOAL_STATE,
        text: "完整目標：讓右側面板可點擊、展開並捲動，同時保留 English details.",
      },
    }),
  );
  const wrapped = wrapRightPanelDetailRows(rows, 18);
  assert.ok(wrapped.length > rows.length);
  wrapped.forEach((item) => {
    assert.ok(
      displayWidth(item.text) <= 18,
      `${JSON.stringify(item.text)} exceeds 18 terminal columns`,
    );
  });
});

test("AGI details expose controller receipts and same-model claim ceiling", () => {
  const rows = buildRightPanelDetailRows(
    input({
      section: "agi",
      agi: {
        ...EMPTY_AGI_STATE,
        enabled: true,
        active: false,
        runId: "agi-123",
        status: "candidate_complete",
        profile: "balanced",
        phase: "evaluate",
        cycle: 2,
        strategy: "small reversible patch",
        action: "run focused tests",
        verificationStatus: "achieved",
        verificationReason: "semantic verifier accepted the result",
        confidence: 0.91,
        sameModelVerifier: true,
        verifierIndependent: false,
        deterministicEvidence: false,
        statePath: "/tmp/agi/state.json",
      },
    }),
  );
  const text = rows.map((item) => item.text).join("\n");
  assert.match(text, /candidateOnly and canClaimAGI=false/);
  assert.match(text, /Status: candidate complete/);
  assert.match(text, /same model · semantic completion alone is candidate_complete/);
  assert.match(text, /Deterministic completion receipt: not present/);
  assert.match(text, /Durable state: \/tmp\/agi\/state.json/);
});

test("AGI details expose criterion coverage and targeted gap receipts", () => {
  const rows = buildRightPanelDetailRows(
    input({
      section: "agi",
      agi: {
        ...EMPTY_AGI_STATE,
        enabled: true,
        active: true,
        status: "running",
        totalCriteria: 6,
        verifiedCriteria: 4,
        failedCriteria: ["C03"],
        unknownCriteria: ["C05"],
        blockedCriteria: ["C06"],
        currentGapId: "GAP-C03-1",
      },
    }),
  );
  const text = rows.map((item) => item.text).join("\n");
  assert.match(text, /Criteria: 4\/6 verified/);
  assert.match(text, /Failed: C03/);
  assert.match(text, /Unknown: C05/);
  assert.match(text, /Blocked: C06/);
  assert.match(text, /Current gap: GAP-C03-1/);
});

test("workflow details expose bounded stages, parallel barrier receipts, and reports", () => {
  const rows = buildRightPanelDetailRows(
    input({
      section: "workflow",
      dynamicWorkflow: {
        ...EMPTY_DYNAMIC_WORKFLOW_STATE,
        configuredMode: "auto",
        eligible: true,
        selected: true,
        active: true,
        status: "reviewing",
        phase: "review",
        currentStage: 1,
        plannedStages: 4,
        maxStages: 6,
        maxAgents: 24,
        totalAgents: 2,
        pattern: "adversarial-verification",
        reason: "Independent implementation and refutation improve reliability.",
        stages: [
          {
            index: 1,
            pattern: "adversarial-verification",
            goal: "Implement and independently challenge the change",
            status: "reviewing",
            maxConcurrency: 2,
            agents: [
              {
                name: "Builder",
                index: 0,
                status: "succeeded",
                active: false,
                role: "minimal-diff-engineer",
                skills: ["repo-analysis"],
                summary: "Implemented the bounded controller.",
              },
              {
                name: "Verifier",
                index: 1,
                status: "running",
                active: true,
                role: "code-reviewer",
                skills: ["source-verification"],
                summary: "Checking failure paths.",
              },
            ],
          },
        ],
      },
    }),
  );
  const text = rows.map((item) => item.text).join("\n");
  assert.match(text, /bounded parallel A2A/);
  assert.match(text, /Main plans each stage/);
  assert.match(text, /stage 1\/4 review/);
  assert.match(text, /Progress: stage 1\/4 planned · agents 2\/24/i);
  assert.match(text, /Safety budget: max 6 stages · max 24 agents/i);
  assert.match(text, /Stage 1 · adversarial-verification · reviewing/);
  assert.match(text, /barrier: 1\/2 terminal · 1 succeeded · 0 failed · concurrency 2/);
  assert.match(text, /role: minimal-diff-engineer/);
  assert.match(text, /skills: source-verification/);
  assert.match(text, /Implemented the bounded controller/);
  assert.match(text, /candidateOnly=true · canClaimAGI=false/);
  assert.match(text, /hidden reasoning is not exposed/);

  const wrapped = wrapRightPanelDetailRows(rows, 24);
  assert.ok(
    wrapped.length > rows.length,
    "workflow details wrap into a scrollable visual-row viewport on narrow terminals",
  );
  assert.ok(
    wrapped.length > 12,
    "the workflow receipt remains long enough to exercise viewport scrolling",
  );
});

test("workflow barrier chrome counts never-started lanes as failed, not waiting", () => {
  const rows = buildRightPanelDetailRows(
    input({
      section: "workflow",
      dynamicWorkflow: {
        ...EMPTY_DYNAMIC_WORKFLOW_STATE,
        configuredMode: "on",
        selected: true,
        active: true,
        status: "reviewing",
        phase: "review",
        currentStage: 1,
        plannedStages: 1,
        stages: [
          {
            index: 1,
            pattern: "tui-parallel-barrier-smoke",
            goal: "Four specialist lanes",
            status: "failed",
            maxConcurrency: 4,
            unstarted: 2,
            failed: 2,
            started: 2,
            succeeded: 2,
            agents: [
              {
                name: "Stage 1 · Sub Agent 1",
                index: 0,
                status: "succeeded",
                active: false,
                role: "",
                skills: [],
                summary: "done",
              },
              {
                name: "Stage 1 · Sub Agent 2",
                index: 1,
                status: "succeeded",
                active: false,
                role: "",
                skills: [],
                summary: "done",
              },
              {
                name: "Stage 1 · Sub Agent 3",
                index: 2,
                status: "unstarted",
                active: false,
                role: "",
                skills: [],
                summary: "",
              },
              {
                name: "Stage 1 · Sub Agent 4",
                index: 3,
                status: "unstarted",
                active: false,
                role: "",
                skills: [],
                summary: "",
              },
            ],
          },
        ],
      },
    }),
  );
  const text = rows.map((item) => item.text).join("\n");
  assert.match(
    text,
    /barrier: 4\/4 terminal · 2 succeeded · 2 failed/,
  );
  assert.doesNotMatch(text, /0 failed/);
  const unstarted = rows.filter((item) => item.text.includes("Sub Agent 3"));
  assert.ok(unstarted.some((item) => item.tone === "error"));
});

test("workflow failure details replace generic provider progress and remain click-expandable", () => {
  const timeout =
    "Model call failed: grok CLI timed out after 300s\n\nCheck provider setup, then retry.";
  const base = input({
    section: "workflow",
    selectedItemId: "workflow-agent:1:0",
    expandedItemIds: [],
    a2a: {
      enabled: true,
      activeName: "",
      handoffPreview: "",
      agents: [{
        id: "worker-1",
        name: "Stage 1 · Sub Agent 1",
        index: 0,
        status: "failed",
        active: false,
        summary: timeout,
        failureReason: timeout,
        workflowStage: 1,
      }],
      orchestration: {
        schema: "sophia.a2a-orchestration.v1",
        session: "workflow-auto-smoke-20260814-174850",
        runId: "run-dd0e734d",
        mode: "workflow",
        version: 9,
        updatedAt: "2026-08-14T09:55:00Z",
        coordinatorId: "main",
        agents: [],
        tasks: [{
          id: "task-1",
          subject: "Provider normalization",
          description: "Inspect provider paths",
          state: "failed",
          terminal: true,
          ownerId: "worker-1",
          blockedBy: [],
          blocks: [],
          doneCriteria: [],
          expectedOutput: "report",
          stage: 1,
          summary: timeout,
          artifacts: [],
          updatedAt: "2026-08-14T09:55:00Z",
        }],
        messages: [{
          id: "message-1",
          kind: "worker_result",
          sender: "Stage 1 · Sub Agent 1",
          recipient: "Main",
          taskId: "task-1",
          summary: "worker failed",
          body: timeout,
          artifacts: [],
          trusted: false,
          unread: true,
          createdAt: "2026-08-14T09:55:00Z",
        }],
      },
    },
    dynamicWorkflow: {
      ...EMPTY_DYNAMIC_WORKFLOW_STATE,
      configuredMode: "auto",
      selected: true,
      status: "failed",
      phase: "review",
      currentStage: 1,
      maxStages: 4,
      maxAgents: 12,
      totalAgents: 1,
      pattern: "fan-out-and-synthesize",
      stages: [{
        index: 1,
        pattern: "fan-out-and-synthesize",
        goal: "Collect evidence",
        status: "failed",
        maxConcurrency: 1,
        agents: [{
          name: "Stage 1 · Sub Agent 1",
          index: 0,
          status: "failed",
          active: false,
          role: "provider-specialist",
          skills: ["coding-debugging"],
          summary: "model result",
          progress: "provider progress",
        }],
      }],
      completion: {
        ok: false,
        reason: "error",
        endedAt: "2026-08-14T09:55:00Z",
        subCount: 1,
        failedSubs: 1,
      },
    },
  });
  const collapsed = buildRightPanelDetailRows(base)
    .map((item) => item.text)
    .join("\n");
  assert.match(collapsed, /grok CLI timed out after 300s/);
  assert.match(collapsed, /barrier: 1\/1 terminal · 0 succeeded · 1 failed/);
  assert.match(collapsed, /Run finished: failed · error · 1\/1 sub-agents failed/);
  assert.doesNotMatch(collapsed, /report: model result/);
  assert.doesNotMatch(collapsed, /progress: provider progress/);

  const expanded = buildRightPanelDetailRows({
    ...base,
    expandedItemIds: ["workflow-agent:1:0"],
  }).map((item) => item.text).join("\n");
  assert.match(expanded, /role: provider-specialist/);
  assert.match(expanded, /task: Provider normalization · failed/);
  assert.match(expanded, /report: Model call failed: grok CLI timed out after 300s/);
});

test("agent detail separates current-stage roster from expandable prior-stage archives", () => {
  const rows = buildRightPanelDetailRows(input({
    section: "agents",
    expandedItemIds: [],
    a2a: {
      enabled: true,
      activeName: "Stage 2 · Critic",
      handoffPreview: "",
      agents: [{
        id: "critic",
        name: "Stage 2 · Critic",
        index: 0,
        status: "running",
        active: true,
        summary: "Challenging stage 1",
        workflowStage: 2,
      }],
      archivedAgents: [{
        id: "specialist",
        name: "Stage 1 · Specialist",
        index: 0,
        status: "failed",
        active: false,
        summary: "grok CLI timed out after 300s",
        failureReason: "grok CLI timed out after 300s",
        workflowStage: 1,
      }],
    },
  }));
  const text = rows.map((item) => item.text).join("\n");
  assert.match(text, /A2A dispatch · 1 agent/);
  assert.match(text, /Prior workflow stages · 1 archived agent/);
  const archived = rows.find(
    (item) => item.interactiveId === "archived-agent:specialist",
  );
  assert.equal(archived?.agentBot?.status, "failed");
  assert.match(text, /Stage 1 · Specialist/);
  assert.doesNotMatch(text, /failure: grok CLI timed out after 300s/);
  assert.ok(
    rows.some((item) => item.interactiveId === "archived-agent:specialist"),
  );
});
