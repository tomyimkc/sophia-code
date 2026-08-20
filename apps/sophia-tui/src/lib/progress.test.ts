import test from "node:test";
import assert from "node:assert/strict";
import {
  IDLE_SEQUENCED_PROGRESS,
  phaseLabel,
  phaseFromBridgeEvent,
  progressCoalesceKey,
  reduceProgressEvent,
} from "./progress.js";

test("thinking tokens remain ephemeral progress", () => {
  assert.deepEqual(phaseFromBridgeEvent("thinking_token", { text: "secret" }), { phase: "thinking" });
});

test("tool/provider wait heartbeats keep the current phase visibly alive", () => {
  assert.deepEqual(
    phaseFromBridgeEvent("tool_wait", { tool: "grep", elapsedSec: 46.9 }),
    { phase: "tool", detail: "grep · 46s" },
  );
  assert.deepEqual(
    phaseFromBridgeEvent("provider_wait", { elapsedSec: 30.2 }),
    { phase: "thinking", detail: "provider · 30s" },
  );
});

test("provider-neutral progress exposes rich Grok activity and generic retries", () => {
  assert.deepEqual(
    phaseFromBridgeEvent("provider_progress", {
      provider: "grok",
      model: "grok-4.6",
      phase: "planning",
      detail: "plan updated · 4 steps",
    }),
    {
      phase: "planning",
      detail: "grok:grok-4.6 · plan updated · 4 steps",
      streamPreview: "",
    },
  );
  assert.deepEqual(
    phaseFromBridgeEvent("provider_progress", {
      provider: "grok",
      model: "grok-4.6",
      phase: "provider_tool",
      tool: "read_file",
      detail: "read_file · delegated-provider tool",
    }),
    { phase: "tool", detail: "read_file" },
  );
  assert.deepEqual(
    phaseFromBridgeEvent("provider_progress", {
      provider: "openai",
      model: "custom",
      phase: "retrying",
      detail: "rate_limited",
      delaySec: 2,
    }),
    {
      phase: "thinking",
      detail: "openai:custom · rate_limited · retry in 2.0s",
      streamPreview: "",
    },
  );
  assert.equal(
    progressCoalesceKey("provider_progress", { runId: "r", lane: "l" }),
    "progress:r:l:provider_progress",
  );
});

test("team_start puts lane roles on the spinner", () => {
  assert.deepEqual(
    phaseFromBridgeEvent("team_start", { team: 2, roles: ["search-1", "search-2"] }),
    { phase: "starting", detail: "Agents · 2", streamPreview: "" },
  );
});

test("orchestration_plan surfaces the route before the first tool call", () => {
  assert.deepEqual(
    phaseFromBridgeEvent("orchestration_plan", {
      substantiveTask: true,
      goalCandidate: false,
      teamCandidate: false,
      teamLanes: 1,
    }),
    { phase: "planning", detail: "", streamPreview: "" },
  );
  assert.deepEqual(
    phaseFromBridgeEvent("orchestration_plan", {
      substantiveTask: true,
      goalCandidate: true,
      teamCandidate: false,
      teamLanes: 1,
    }),
    { phase: "planning", detail: "", streamPreview: "" },
  );
  assert.deepEqual(
    phaseFromBridgeEvent("orchestration_plan", {
      goalCandidate: true,
      teamCandidate: true,
      teamLanes: 3,
    }),
    { phase: "planning", detail: "Agents · 3", streamPreview: "" },
  );
  assert.equal(
    phaseFromBridgeEvent("orchestration_plan", {
      substantiveTask: false,
      goalCandidate: false,
      teamCandidate: false,
    }),
    null,
  );
});

test("synthesis_start is finalizing with a lane count", () => {
  assert.deepEqual(
    phaseFromBridgeEvent("synthesis_start", { lanes: 3 }),
    { phase: "finalizing", detail: "synthesizing 3 lanes", streamPreview: "" },
  );
});

test("dynamic workflow progress exposes stage completion and ETA", () => {
  assert.deepEqual(
    phaseFromBridgeEvent("dynamic_workflow_stage_start", {
      stage: 1,
      taskCount: 2,
    }),
    {
      phase: "thinking",
      detail: "Workflow 1 · 2 agents",
      streamPreview: "",
    },
  );
  assert.deepEqual(
    phaseFromBridgeEvent("dynamic_workflow_stage_progress", {
      runId: "r",
      stage: 1,
      terminal: 1,
      total: 2,
      active: 1,
      estimatedRemainingSec: 85,
    }),
    {
      phase: "thinking",
      detail: "Workflow 1 · 1/2 · ETA ~2m",
      streamPreview: "",
    },
  );
  assert.equal(
    progressCoalesceKey("dynamic_workflow_stage_progress", { runId: "r" }),
    "progress:r::dynamic_workflow_stage_progress",
  );
  assert.equal(
    phaseFromBridgeEvent("dynamic_workflow_synthesis_start", {})?.phase,
    "finalizing",
  );
});

test("phase labels keep the replace-in-place progress row concise", () => {
  assert.equal(phaseLabel("starting", "Agents · 3"), "Agents · 3");
  assert.equal(phaseLabel("thinking", "openai:gpt · reasoning"), "Thinking…");
  assert.equal(phaseLabel("thinking", "Workflow 2 · 3/5"), "Workflow 2 · 3/5");
  assert.equal(phaseLabel("tool", "read_file · 12s"), "Tool · read_file · 12s");
  assert.equal(phaseLabel("streaming", "provider detail"), "Writing…");
  assert.equal(
    phaseLabel("finalizing", "Workflow · synthesis"),
    "Workflow · finalizing",
  );
});

test("reserved team final-report grace is visible and explicitly bounded", () => {
  assert.deepEqual(
    phaseFromBridgeEvent("team_drain_extended", { role: "reviewer" }),
    {
      phase: "finalizing",
      detail: "reviewer final report · bounded wait",
      streamPreview: "",
    },
  );
});

test("lanes_abandoned stays in progress with a warning detail", () => {
  const patch = phaseFromBridgeEvent("lanes_abandoned", { lanes: ["team-lane-1"] });
  assert.equal(patch?.phase, "planning");
  assert.match(String(patch?.detail), /abandoned/i);
});

test("only run_finished marks an answered run done", () => {
  assert.deepEqual(
    phaseFromBridgeEvent("result", { ok: true }),
    {
      phase: "finalizing",
      detail: "answer received · verifying completion",
      streamPreview: "",
    },
  );
  assert.equal(
    phaseFromBridgeEvent("result", {
      ok: false,
      agiStatus: "awaiting_input",
      incompleteReason: "approval required",
    })?.phase,
    "paused",
  );
  assert.deepEqual(
    phaseFromBridgeEvent("run_finished", { ok: true, reason: "verified" }),
    { phase: "done", detail: "", streamPreview: "" },
  );
  assert.deepEqual(
    phaseFromBridgeEvent("run_finished", { ok: false, reason: "error" }),
    { phase: "error", detail: "error", streamPreview: "" },
  );
});

test("goal awaiting input pauses progress with an actionable reason", () => {
  const patch = phaseFromBridgeEvent("goal_awaiting_input", {
    reason: "sign in to continue",
    remaining: "provide eligibility declarations",
  });
  assert.deepEqual(patch, {
    phase: "paused",
    detail: "sign in to continue",
    streamPreview: "",
  });
  assert.equal(phaseLabel(patch?.phase ?? "idle", patch?.detail), "Waiting · sign in to continue");
});

test("queue-next does not steer active progress while cancel/restart stages do", () => {
  assert.equal(phaseFromBridgeEvent("queue_next_ack", { status: "queued" }), null);
  assert.deepEqual(
    phaseFromBridgeEvent("cancel_ack", { status: "cancelling", stage: "requested" }),
    { phase: "cancelling", detail: "requested", streamPreview: "" },
  );
  assert.equal(phaseFromBridgeEvent("restart_stage", { stage: "starting" })?.phase, "starting");
  assert.equal(phaseFromBridgeEvent("restart_stage", { stage: "ready" })?.phase, "idle");
});

test("headless progress reducer ignores stale v2 snapshots and accepts v1 arrival order", () => {
  const first = reduceProgressEvent(
    IDLE_SEQUENCED_PROGRESS,
    "thinking",
    { protocolSequence: 5, model: "m" },
  );
  assert.equal(first.phase, "thinking");
  assert.equal(first.protocolSequence, 5);
  const stale = reduceProgressEvent(first, "token", { protocolSequence: 4 });
  assert.equal(stale, first);
  const next = reduceProgressEvent(first, "token", { protocolSequence: 6 });
  assert.equal(next.phase, "streaming");
  assert.equal(next.protocolSequence, 6);
  const v1 = reduceProgressEvent(next, "tool_call", { tool: "read_file" });
  assert.equal(v1.phase, "tool");
  assert.equal(v1.protocolSequence, 6);
  assert.equal(
    progressCoalesceKey("thinking_token", { runId: "r", lane: "l" }),
    "progress:r:l:thinking_token",
  );
});
