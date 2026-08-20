import test from "node:test";
import assert from "node:assert/strict";
import { resolveAccessibility } from "../lib/accessibility.js";
import { createPlanModel, revisePlanModel, type PlanModel } from "../lib/planModel.js";
import {
  planModelGateLabel,
  planModelPanelHelp,
  planModelStepGlyph,
  planModelStepIsNew,
  planPanelBorderStyle,
  planPanelHelp,
  planPhaseLabel,
  planStepGlyph,
  resolvePlanModelPanelKey,
  resolvePlanPanelKey,
} from "./PlanPanel.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

test("plan presentation uses explicit Sophia-native phase and step labels", () => {
  assert.equal(planPhaseLabel("awaiting_approval"), "Awaiting approval");
  assert.equal(planPhaseLabel("exited"), "Exited · resumable locally");
  assert.equal(planStepGlyph("pending"), "○");
  assert.equal(planStepGlyph("in_progress"), "▶");
  assert.equal(planStepGlyph("completed"), "✓");
});

test("keyboard intents make approval, execution, completion, and exit explicit", () => {
  assert.equal(resolvePlanPanelKey("", { return: true }, "draft"), "submit_for_approval");
  assert.equal(resolvePlanPanelKey("a", {}, "awaiting_approval"), "approve");
  assert.equal(resolvePlanPanelKey("r", {}, "awaiting_approval"), "reject");
  assert.equal(resolvePlanPanelKey("s", {}, "approved"), "start");
  assert.equal(resolvePlanPanelKey(" ", {}, "running"), "complete_step");
  assert.equal(resolvePlanPanelKey("e", {}, "running"), "request_exit");
  assert.equal(resolvePlanPanelKey("y", {}, "exit_requested"), "confirm_exit");
  assert.equal(resolvePlanPanelKey("", { escape: true }, "exit_requested"), "cancel_exit");
  assert.equal(resolvePlanPanelKey("", { return: true }, "exited"), "resume");
});

test("keyboard navigation works without color and irrelevant keys are ignored", () => {
  assert.equal(resolvePlanPanelKey("", { upArrow: true }, "running"), "move_up");
  assert.equal(resolvePlanPanelKey("", { downArrow: true }, "running"), "move_down");
  assert.equal(resolvePlanPanelKey("a", {}, "draft"), null);
  assert.match(planPanelHelp("exit_requested"), /confirm exit/);
});

test("screen-reader mode removes decorative panel borders", () => {
  assert.equal(planPanelBorderStyle(resolveAccessibility(["--ax-screen-reader"], NO_ENV)), undefined);
  assert.equal(planPanelBorderStyle(resolveAccessibility([], NO_ENV)), "round");
});

test("PlanModel presentation uses a 5-status glyph vocabulary the FSM-driven panel does not have", () => {
  assert.equal(planModelStepGlyph("pending"), "○");
  assert.equal(planModelStepGlyph("active"), "▶");
  assert.equal(planModelStepGlyph("done"), "✓");
  assert.equal(planModelStepGlyph("failed"), "✗");
  assert.equal(planModelStepGlyph("skipped"), "⏭");
  assert.equal(planModelGateLabel("pending"), "Awaiting approval");
  assert.equal(planModelGateLabel("approved"), "Approved");
  assert.equal(planModelGateLabel("rejected"), "Rejected");
});

test("PlanModel keyboard intents gate approve/reject on a pending decision and always allow move/select/close", () => {
  assert.equal(resolvePlanModelPanelKey("", { upArrow: true }, "pending"), "move_up");
  assert.equal(resolvePlanModelPanelKey("", { downArrow: true }, "approved"), "move_down");
  assert.equal(resolvePlanModelPanelKey("", { return: true }, "pending"), "select");
  assert.equal(resolvePlanModelPanelKey("", { escape: true }, "rejected"), "close");
  assert.equal(resolvePlanModelPanelKey("a", {}, "pending"), "approve");
  assert.equal(resolvePlanModelPanelKey("r", {}, "pending"), "reject");
  assert.equal(resolvePlanModelPanelKey("a", {}, "approved"), null);
  assert.equal(resolvePlanModelPanelKey("r", {}, "rejected"), null);
  assert.match(planModelPanelHelp("pending"), /approve/);
  assert.doesNotMatch(planModelPanelHelp("approved"), /approve/);
});

test("PlanModel step-is-new marking survives a mid-run revision without losing prior step state", () => {
  const model: PlanModel = createPlanModel("1. First step\n2. Second step");
  assert.equal(model.steps[0].status, "pending");

  const withProgress: PlanModel = {
    ...model,
    steps: model.steps.map((step, i) => (i === 0 ? { ...step, status: "done" as const } : step)),
  };
  const { model: revised, diff } = revisePlanModel(
    withProgress,
    "1. First step\n2. Second step\n3. Third step",
  );

  // The surviving first step keeps its "done" status across the revision...
  assert.equal(revised.steps[0].status, "done");
  assert.equal(planModelStepIsNew(diff, revised.steps[0].id), false);
  // ...while the brand-new third step is flagged so an operator can see what changed.
  assert.equal(planModelStepIsNew(diff, revised.steps[2].id), true);
  assert.equal(planModelStepIsNew(undefined, revised.steps[2].id), false);
});
