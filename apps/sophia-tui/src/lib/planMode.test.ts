import test from "node:test";
import assert from "node:assert/strict";
import {
  activePlanStep,
  createPlanModeState,
  planCanExecute,
  planExitNeedsConfirmation,
  planProgress,
  transitionPlanMode,
  validatePlanModeState,
  type PlanModeState,
} from "./planMode.js";

const STEPS = [
  { id: "inspect", title: "Inspect the current state" },
  { id: "change", title: "Implement the thin slice" },
  { id: "verify", title: "Verify the result" },
];

function draft() {
  return createPlanModeState({
    planId: "plan-1",
    title: "Sophia implementation plan",
    steps: STEPS,
    at: "2026-07-30T00:00:00.000Z",
  });
}

function approved() {
  let state = draft();
  state = transitionPlanMode(state, { type: "submit_for_approval" }).state;
  state = transitionPlanMode(state, { type: "approve" }).state;
  return state;
}

test("a plan cannot execute until its current revision is explicitly approved", () => {
  const beforeApproval = transitionPlanMode(draft(), { type: "start" });
  assert.equal(beforeApproval.accepted, false);
  assert.equal(beforeApproval.code, "approval_required");

  const state = approved();
  assert.equal(state.phase, "approved");
  assert.equal(state.approvedRevision, state.revision);
  assert.equal(planCanExecute(state), true);
});

test("starting an approved plan activates exactly one pending step", () => {
  const started = transitionPlanMode(approved(), { type: "start" });
  assert.equal(started.accepted, true);
  assert.equal(started.state.phase, "running");
  assert.equal(activePlanStep(started.state)?.id, "inspect");
  assert.equal(started.state.steps.filter((step) => step.status === "in_progress").length, 1);
});

test("the one-in-progress invariant rejects a second active step", () => {
  const running = transitionPlanMode(approved(), { type: "start" }).state;
  const second = transitionPlanMode(running, {
    type: "set_step_status",
    stepId: "change",
    status: "in_progress",
  });
  assert.equal(second.accepted, false);
  assert.equal(second.code, "already_active");
  assert.equal(activePlanStep(second.state)?.id, "inspect");
});

test("completing the active step advances the plan and eventually completes it", () => {
  let state = transitionPlanMode(approved(), { type: "start" }).state;
  for (const stepId of ["inspect", "change", "verify"]) {
    const transition = transitionPlanMode(state, {
      type: "set_step_status",
      stepId,
      status: "completed",
    });
    assert.equal(transition.accepted, true);
    state = transition.state;
  }
  assert.equal(state.phase, "completed");
  assert.equal(activePlanStep(state), null);
  assert.deepEqual(planProgress(state), { completed: 3, total: 3, percent: 100 });
  assert.equal(planExitNeedsConfirmation(state), false);
});

test("revising a plan invalidates approval and resets execution state", () => {
  const state = transitionPlanMode(approved(), {
    type: "revise",
    title: "Revised Sophia plan",
    steps: [{ id: "new", title: "Review the new approach" }],
  }).state;
  assert.equal(state.phase, "draft");
  assert.equal(state.approvedRevision, null);
  assert.equal(state.revision, 2);
  assert.equal(state.steps[0].status, "pending");
  assert.equal(planCanExecute(state), false);
});

test("exit is a two-step confirmation and cancellation restores the exact phase", () => {
  const running = transitionPlanMode(approved(), { type: "start" }).state;
  const requested = transitionPlanMode(running, { type: "request_exit", reason: "switch task" });
  assert.equal(requested.state.phase, "exit_requested");
  assert.equal(requested.state.exitReturnPhase, "running");

  const cancelled = transitionPlanMode(requested.state, { type: "cancel_exit" });
  assert.equal(cancelled.state.phase, "running");
  assert.equal(activePlanStep(cancelled.state)?.id, "inspect");
});

test("confirmed exit pauses active work and a local resume returns to approved state", () => {
  let state = transitionPlanMode(approved(), { type: "start" }).state;
  state = transitionPlanMode(state, { type: "request_exit" }).state;
  state = transitionPlanMode(state, { type: "confirm_exit" }).state;
  assert.equal(state.phase, "exited");
  assert.equal(activePlanStep(state), null);
  assert.equal(state.steps[0].status, "pending");

  state = transitionPlanMode(state, { type: "resume" }).state;
  assert.equal(state.phase, "approved");
  assert.equal(planCanExecute(state), true);
});

test("empty drafts cannot be submitted for approval", () => {
  const empty = createPlanModeState({ planId: "empty", title: "Empty" });
  const submitted = transitionPlanMode(empty, { type: "submit_for_approval" });
  assert.equal(submitted.accepted, false);
  assert.equal(submitted.code, "empty_plan");
});

test("restored state with two active steps fails closed", () => {
  const invalid: PlanModeState = {
    ...draft(),
    phase: "running",
    approvedRevision: 1,
    steps: [
      { id: "a", title: "A", status: "in_progress" },
      { id: "b", title: "B", status: "in_progress" },
    ],
  };
  assert.deepEqual(validatePlanModeState(invalid).map((issue) => issue.code), ["multiple_active_steps"]);
  const transition = transitionPlanMode(invalid, { type: "request_exit" });
  assert.equal(transition.accepted, false);
  assert.equal(transition.code, "invalid_state");
});
