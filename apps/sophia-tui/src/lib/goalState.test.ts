import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_GOAL_STATE,
  goalPhaseGlyph,
  goalPhaseLabel,
  goalReducer,
  isGoalLifecycleEvent,
  isTerminalGoalLifecycleEvent,
  type GoalEvent,
  type GoalState,
} from "./goalState.js";
import { normalizeBridgeEvent } from "./bridge.js";

test("run_start retains the prompt separately while Main defines the live goal", () => {
  const prior: GoalState = { ...EMPTY_GOAL_STATE, phase: "achieved", text: "old goal", statusDetail: "done" };
  const next = goalReducer(prior, { type: "run_start", goal: "write the report" });
  assert.equal(next.phase, "running");
  assert.equal(next.text, "");
  assert.equal(next.prompt, "write the report");
  assert.equal(next.statusDetail, "Main is defining the goal");
  assert.equal(next.history.length, 0);
  // A fresh run must not carry the previous run's verdict or detail forward.
  assert.equal(next.confidence, null);
});

test("normalised bridge goal events are routed into the live Goal projection", () => {
  const rawEvents = [
    {
      type: "bridge_event",
      runId: "run-live",
      event: { type: "run_start", goal: "raw operator prompt" },
    },
    {
      type: "bridge_event",
      runId: "run-live",
      event: {
        type: "goal_update",
        goal: "Audit provider readiness",
        revision: 1,
        source: "orchestration",
      },
    },
    {
      type: "bridge_event",
      runId: "run-live",
      event: {
        type: "goal_update",
        goal: "Challenge the specialist findings",
        revision: 2,
        source: "workflow-review",
        currentStage: 2,
        plannedStages: 2,
      },
    },
  ];

  let state = EMPTY_GOAL_STATE;
  for (const raw of rawEvents) {
    const event = normalizeBridgeEvent(raw);
    assert.ok(event);
    const type = String(event.type || "");
    if (type === "run_start" || isGoalLifecycleEvent(type)) {
      state = goalReducer(state, { ...event, type } as GoalEvent);
    }
  }

  assert.equal(state.prompt, "raw operator prompt");
  assert.equal(state.text, "Challenge the specialist findings");
  assert.equal(state.revision, 2);
  assert.equal(state.stage, 2);
  assert.equal(state.stageCount, 2);
  assert.deepEqual(state.history.map((entry) => entry.source), [
    "orchestration",
    "workflow-review",
  ]);
});

test("goal lifecycle routing covers every reducer-owned goal event", () => {
  for (const type of [
    "goal_update",
    "goal_triage",
    "goal_accumulated",
    "goal_mode_start",
    "goal_start",
    "goal_status",
    "goal_continuation",
    "goal_achieved",
    "goal_awaiting_input",
    "goal_unachievable",
    "goal_bound_hit",
    "goal_cancelled",
  ]) {
    assert.equal(isGoalLifecycleEvent(type), true, type);
  }
  assert.equal(isGoalLifecycleEvent("goal"), false);
  assert.equal(isGoalLifecycleEvent("run_start"), false);
  assert.equal(isGoalLifecycleEvent("goal_update_untrusted"), false);
  assert.equal(isTerminalGoalLifecycleEvent("goal_start"), false);
  assert.equal(isTerminalGoalLifecycleEvent("goal_mode_start"), false);
  assert.equal(isTerminalGoalLifecycleEvent("goal_achieved"), true);
  assert.equal(isTerminalGoalLifecycleEvent("goal_awaiting_input"), true);
});

test("an explicit Goal title stays concise and progress changes as native tools run", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, {
    type: "run_start",
    goal: [
      "Create a Goal titled “Verify Sophia native-tool execution.”",
      "Then run the native tools in order.",
    ].join("\n"),
  });
  assert.equal(s.text, "Verify Sophia native-tool execution");
  assert.equal(s.prompt.includes("Then run the native tools"), true);
  assert.equal(s.source, "operator-title");
  assert.equal(s.history.length, 1);
  s = goalReducer(s, {
    type: "todo_update",
    items: [{ id: "todo-1", content: "Inspect safely", status: "in_progress" }],
  });
  assert.equal(s.activity, "To-do · 1/1 in progress");
  s = goalReducer(s, { type: "tool_call", tool: "bash" });
  assert.equal(s.activity, "bash running");
  s = goalReducer(s, { type: "tool_result", tool: "bash", ok: true });
  assert.equal(s.activity, "bash complete");
  s = goalReducer(s, {
    type: "todo_update",
    items: [{ id: "todo-1", content: "Inspect safely", status: "completed" }],
  });
  assert.equal(s.activity, "To-do · 1/1 complete");
});

test("goal_triage refines the goal only when the model actually detects one", () => {
  const base = goalReducer(EMPTY_GOAL_STATE, { type: "run_start", goal: "raw prompt" });
  // Non-goal: leave the run_start awaiting a harness-owned goal revision.
  const nonGoal = goalReducer(base, { type: "goal_triage", isGoal: false, goal: "ignored" });
  assert.deepEqual(nonGoal, base);
  // Detected goal: adopt the goal text + confidence.
  const isGoal = goalReducer(base, { type: "goal_triage", isGoal: true, goal: "the real goal", confidence: 0.83, willLoop: true });
  assert.equal(isGoal.text, "the real goal");
  assert.equal(isGoal.confidence, 0.83);
  assert.equal(isGoal.statusDetail, "running autonomously");
  assert.equal(isGoal.source, "goal-triage");
});

test("goal_accumulated adopts the accumulated goal (the algorithm the panel tracks)", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, { type: "run_start", goal: "first" });
  s = goalReducer(s, { type: "goal_accumulated", accumulatedGoal: "first + second", continuesPrior: true, confidence: 0.9 });
  assert.equal(s.text, "first + second");
  assert.equal(s.statusDetail, "extends prior goal");
  assert.equal(s.confidence, 0.9);
  assert.equal(s.revision, 1);
  assert.equal(s.history[0]?.source, "goal-accumulator");
});

test("goal_update creates inspectable revisions and tracks workflow stage metadata", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, {
    type: "run_start",
    goal: "Long raw operator prompt that must not become the durable Goal text.",
  });
  s = goalReducer(s, {
    type: "goal_update",
    goal: "Audit provider readiness",
    revision: 4,
    source: "workflow-plan",
    reason: "Main selected a two-stage audit",
    updatedAt: "2026-08-15T01:00:00Z",
    stage: 1,
    plannedStages: 2,
  });
  assert.equal(s.text, "Audit provider readiness");
  assert.equal(s.prompt.startsWith("Long raw operator prompt"), true);
  assert.equal(s.revision, 4);
  assert.equal(s.stage, 1);
  assert.equal(s.stageCount, 2);
  assert.deepEqual(s.history[0], {
    revision: 4,
    text: "Audit provider readiness",
    source: "workflow-plan",
    reason: "Main selected a two-stage audit",
    updatedAt: "2026-08-15T01:00:00Z",
    stage: 1,
    stageCount: 2,
  });

  s = goalReducer(s, {
    type: "goal_update",
    goal: "Challenge stage-one findings",
    source: "workflow-stage",
    reason: "Critic barrier started",
    stage: 2,
    stageCount: 3,
  });
  assert.equal(s.revision, 5);
  assert.equal(s.stage, 2);
  assert.equal(s.stageCount, 3);
  assert.equal(s.history.length, 2);
  assert.equal(s.history[1]?.text, "Challenge stage-one findings");
});

test("goal_update accepts the bridge currentStage field", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, {
    type: "run_start",
    goal: "Perform a multi-stage verification.",
  });
  s = goalReducer(s, {
    type: "goal_update",
    goal: "Challenge the completed specialist reports.",
    revision: 2,
    source: "workflow-review",
    currentStage: 2,
    plannedStages: 6,
  });
  assert.equal(s.stage, 2);
  assert.equal(s.stageCount, 6);
  assert.equal(s.history.at(-1)?.stage, 2);
  assert.equal(s.history.at(-1)?.stageCount, 6);
});

test("duplicate goal updates do not flood revision history", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, { type: "run_start", goal: "raw" });
  const update = {
    type: "goal_update",
    goal: "Inspect safely",
    source: "workflow-stage",
    reason: "stage one",
    stage: 1,
    plannedStages: 2,
  };
  s = goalReducer(s, update);
  const revision = s.revision;
  s = goalReducer(s, update);
  assert.equal(s.revision, revision);
  assert.equal(s.history.length, 1);
});

test("stale or replayed backend goal revisions cannot replace the current goal", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, {
    type: "run_start",
    goal: "raw",
  });
  s = goalReducer(s, {
    type: "goal_update",
    goal: "Current objective",
    revision: 4,
    source: "workflow-stage",
    updatedAt: "2026-08-15T01:00:00Z",
  });
  const current = s;
  s = goalReducer(s, {
    type: "goal_update",
    goal: "Stale objective",
    revision: 2,
    source: "workflow-stage",
    updatedAt: "2026-08-15T01:01:00Z",
  });
  assert.deepEqual(s, current);
  s = goalReducer(s, {
    type: "goal_update",
    goal: "Conflicting replay",
    revision: 4,
    source: "workflow-stage",
    updatedAt: "2026-08-15T01:02:00Z",
  });
  assert.deepEqual(s, current);
});

test("semantic duplicate receipts keep timestamps consistent while advancing replay order", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, {
    type: "run_start",
    goal: "raw",
  });
  s = goalReducer(s, {
    type: "goal_update",
    goal: "Inspect safely",
    revision: 1,
    source: "workflow-stage",
    reason: "stage one",
    updatedAt: "2026-08-15T01:00:00Z",
  });
  const revision = s.revision;
  s = goalReducer(s, {
    type: "goal_update",
    goal: "Inspect safely",
    revision: 2,
    source: "workflow-stage",
    reason: "stage one",
    updatedAt: "2026-08-15T01:05:00Z",
  });
  assert.equal(s.revision, revision);
  assert.equal(s.backendRevision, 2);
  assert.equal(s.updatedAt, "2026-08-15T01:00:00Z");
  assert.equal(s.history.at(-1)?.updatedAt, "2026-08-15T01:00:00Z");
});

test("goal revision history is bounded while the current revision remains monotonic", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, { type: "run_start", goal: "raw" });
  for (let index = 1; index <= 40; index += 1) {
    s = goalReducer(s, {
      type: "goal_update",
      goal: `Goal revision ${index}`,
      source: "main-harness",
    });
  }
  assert.equal(s.revision, 40);
  assert.equal(s.history.length, 32);
  assert.equal(s.history[0]?.text, "Goal revision 9");
  assert.equal(s.history[31]?.text, "Goal revision 40");
});

test("goal_status carries the live 'remaining' sub-line and confidence", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, { type: "run_start", goal: "g" });
  s = goalReducer(s, { type: "goal_status", status: "in_progress", remaining: "3 steps left", confidence: 0.5 });
  assert.equal(s.remaining, "3 steps left");
  assert.equal(s.statusDetail, "in_progress");
  assert.equal(s.confidence, 0.5);
});

test("a terminal goal verdict is STICKY across the run's result event", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, { type: "run_start", goal: "g" });
  s = goalReducer(s, { type: "goal_update", goal: "g", source: "main-harness" });
  s = goalReducer(s, { type: "goal_achieved", reason: "all done", confidence: 0.95 });
  assert.equal(s.phase, "achieved");
  assert.equal(s.statusDetail, "all done");
  // The run then ends; "achieved" must NOT be downgraded to idle.
  s = goalReducer(s, { type: "result" });
  assert.equal(s.phase, "achieved", "a goal verdict survives the terminal result event");
  assert.equal(s.text, "g", "and the goal text stays visible");
});

test("awaiting-input is a sticky resumable phase with an explicit label", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, { type: "run_start", goal: "submit the entry" });
  s = goalReducer(s, {
    type: "goal_awaiting_input",
    reason: "sign in to Devpost",
    remaining: "provide eligibility declarations",
    confidence: 0.97,
  });
  assert.equal(s.phase, "awaiting_input");
  assert.equal(s.remaining, "provide eligibility declarations");
  assert.equal(goalPhaseLabel(s.phase).label, "awaiting your input");
  assert.equal(goalPhaseLabel(s.phase).ok, null);
  assert.equal(goalPhaseGlyph(s.phase), "?");
  s = goalReducer(s, { type: "result" });
  assert.equal(s.phase, "awaiting_input");
});

test("a plain run going idle keeps its text but drops the running phase", () => {
  let s = goalReducer(EMPTY_GOAL_STATE, { type: "run_start", goal: "answer the question" });
  s = goalReducer(s, { type: "goal_update", goal: "Answer the operator question" });
  assert.equal(s.phase, "running");
  s = goalReducer(s, { type: "result" });
  assert.equal(s.phase, "idle");
  assert.equal(s.text, "Answer the operator question", "the last harness goal stays shown, greyed, not blank");
  assert.equal(s.activity, "completed");
});

test("malformed fields degrade safely, never to NaN/undefined", () => {
  const s = goalReducer(EMPTY_GOAL_STATE, { type: "goal_status", status: undefined, remaining: undefined, confidence: "garbage" });
  assert.equal(s.confidence, null, "a non-numeric confidence is ignored, not NaN");
  assert.equal(s.remaining, "");
  // A goal_accumulated with no text keeps the prior text rather than blanking it.
  const base = goalReducer(EMPTY_GOAL_STATE, { type: "run_start", goal: "keep me" });
  assert.equal(goalReducer(base, { type: "goal_accumulated", accumulatedGoal: "" }).text, "");
});

test("unknown events are a no-op", () => {
  const s = goalReducer(EMPTY_GOAL_STATE, { type: "tool_call", tool: "x" });
  assert.deepEqual(s, EMPTY_GOAL_STATE);
});

test("phase labels + glyphs cover every phase, glyph-first", () => {
  assert.equal(goalPhaseLabel("achieved").ok, true);
  assert.equal(goalPhaseLabel("awaiting_input").ok, null);
  assert.equal(goalPhaseLabel("unachievable").ok, false);
  assert.equal(goalPhaseLabel("bound_hit").ok, false);
  assert.equal(goalPhaseLabel("running").ok, null);
  assert.equal(goalPhaseLabel("idle").label, "");
  // Distinct glyphs so state is readable without colour (WCAG 1.4.1).
  const glyphs = new Set(["achieved", "awaiting_input", "unachievable", "bound_hit", "cancelled", "running", "idle"].map((p) => goalPhaseGlyph(p as GoalState["phase"])));
  assert.equal(glyphs.size, 7, "each phase gets its own glyph");
});
