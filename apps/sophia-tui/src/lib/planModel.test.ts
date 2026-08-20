import test from "node:test";
import assert from "node:assert/strict";
import { displayWidth } from "./textWidth.js";
import {
  approvePlanModel,
  createPlanModel,
  derivePlanProgress,
  mergePlanRevision,
  parsePlanText,
  planModelCanExecute,
  revisePlanModel,
  setPlanStepStatus,
  type PlanModelStep,
} from "./planModel.js";

// ---------------------------------------------------------------------------
// Parsing: numbered / bulleted / nested / rationale
// ---------------------------------------------------------------------------

test("a numbered plan parses into one step per line, task-specific and in order", () => {
  const { steps, truncated } = parsePlanText(
    "1. Inspect the current state\n2. Implement the thin slice\n3. Verify the result",
  );
  assert.equal(truncated, false);
  assert.deepEqual(steps.map((s) => s.title), [
    "Inspect the current state",
    "Implement the thin slice",
    "Verify the result",
  ]);
  assert.ok(steps.every((s) => s.status === "pending" && s.depth === 0));
  assert.equal(new Set(steps.map((s) => s.id)).size, 3, "ids must be unique");
});

test("a bulleted plan with nested sub-steps records the correct depth for each", () => {
  const { steps } = parsePlanText(
    "- Set up environment\n  - Install dependencies\n  - Configure secrets\n- Run the migration",
  );
  assert.deepEqual(
    steps.map((s) => [s.title, s.depth]),
    [
      ["Set up environment", 0],
      ["Install dependencies", 1],
      ["Configure secrets", 1],
      ["Run the migration", 0],
    ],
  );
});

test("re-nesting back out to a shallower indent after a deep nest is not left stuck at depth", () => {
  const { steps } = parsePlanText(
    "1. Top\n   1. Mid\n      1. Deep\n   2. Mid again\n2. Top again",
  );
  assert.deepEqual(
    steps.map((s) => [s.title, s.depth]),
    [
      ["Top", 0],
      ["Mid", 1],
      ["Deep", 2],
      ["Mid again", 1],
      ["Top again", 0],
    ],
  );
});

test("an inline rationale after a step is split into title and detail", () => {
  const { steps } = parsePlanText("1. Add the cache — rationale: repeated lookups are slow");
  assert.equal(steps.length, 1);
  assert.equal(steps[0].title, "Add the cache");
  assert.equal(steps[0].detail, "repeated lookups are slow");
});

test("a rationale wrapped onto its own continuation line attaches to the step above it", () => {
  const { steps } = parsePlanText("1. Add the cache\n2. Add a test\n   Why: guards the fix above");
  assert.equal(steps.length, 2);
  assert.equal(steps[0].detail, undefined, "the first step has no rationale line under it");
  assert.equal(steps[1].detail, "guards the fix above");
});

test("a step with no rationale at all simply has no detail", () => {
  const { steps } = parsePlanText("1. Ship it");
  assert.equal(steps[0].detail, undefined);
});

// ---------------------------------------------------------------------------
// Untrusted input: must never throw, must degrade sensibly
// ---------------------------------------------------------------------------

test("empty, whitespace-only and preamble-only text parse to zero steps without throwing", () => {
  assert.deepEqual(parsePlanText(""), { steps: [], truncated: false });
  assert.deepEqual(parsePlanText("   \n\n  \t \n"), { steps: [], truncated: false });
  assert.deepEqual(parsePlanText("Here is my plan for the task, no list follows."), {
    steps: [],
    truncated: false,
  });
});

test("nullish input is coerced rather than throwing", () => {
  assert.doesNotThrow(() => parsePlanText(undefined as unknown as string));
  assert.doesNotThrow(() => parsePlanText(null as unknown as string));
  assert.deepEqual(parsePlanText(null as unknown as string).steps, []);
});

test("duplicate step numbering never collides and never throws", () => {
  const { steps } = parsePlanText("1. Refactor the parser\n1. Refactor the parser");
  assert.equal(steps.length, 2);
  assert.equal(steps[0].title, steps[1].title);
  assert.notEqual(steps[0].id, steps[1].id, "duplicate numerals must still get distinct ids");
});

test("ANSI escapes are stripped and an absurdly long line is bounded, not thrown on", () => {
  const poisoned = `1. \x1b[31mDanger\x1b[0m step ${"x".repeat(5000)}`;
  const { steps } = parsePlanText(poisoned);
  assert.equal(steps.length, 1);
  assert.ok(!steps[0].title.includes("\x1b"), "no raw escape byte should survive into the title");
  assert.ok(displayWidth(steps[0].title) <= 200, "title must be bounded to a renderable width");
});

test("unterminated markdown markup is kept as plain text instead of throwing", () => {
  const { steps } = parsePlanText("1. Fix the `unterminated code span and **bold that never closes");
  assert.equal(steps.length, 1);
  assert.ok(steps[0].title.startsWith("Fix the"));
});

test("an absurd step count is capped rather than accepted in full", () => {
  const lines: string[] = [];
  for (let i = 1; i <= 5000; i++) lines.push(`${i}. step number ${i}`);
  const { steps, truncated } = parsePlanText(lines.join("\n"));
  assert.ok(steps.length <= 200);
  assert.equal(truncated, true);
});

// ---------------------------------------------------------------------------
// Honest progress
// ---------------------------------------------------------------------------

test("progress on an empty plan says so rather than dividing by zero", () => {
  const progress = derivePlanProgress([]);
  assert.equal(progress.total, 0);
  assert.equal(progress.percent, 0);
  assert.equal(progress.activeIndex, null);
  assert.equal(progress.label, "No steps yet");
});

test("progress reports the active step's true position, not an assumed linear one", () => {
  const steps: PlanModelStep[] = [
    { id: "a", title: "a", depth: 0, status: "done" },
    { id: "b", title: "b", depth: 0, status: "active" },
    { id: "c", title: "c", depth: 0, status: "pending" },
  ];
  const progress = derivePlanProgress(steps);
  assert.equal(progress.activeIndex, 2);
  assert.equal(progress.label, "Step 2 of 3");
  assert.equal(progress.resolved, 1);
  assert.equal(progress.percent, 33);
});

test("progress with nothing active and nothing finished reports what is known, not a guess", () => {
  const steps: PlanModelStep[] = [
    { id: "a", title: "a", depth: 0, status: "pending" },
    { id: "b", title: "b", depth: 0, status: "pending" },
  ];
  const progress = derivePlanProgress(steps);
  assert.equal(progress.activeIndex, null);
  assert.equal(progress.label, "0 of 2 resolved");
});

test("progress on a finished plan distinguishes done from failed/skipped instead of hiding them", () => {
  const steps: PlanModelStep[] = [
    { id: "a", title: "a", depth: 0, status: "done" },
    { id: "b", title: "b", depth: 0, status: "failed" },
    { id: "c", title: "c", depth: 0, status: "done" },
  ];
  const progress = derivePlanProgress(steps);
  assert.equal(progress.percent, 100);
  assert.equal(progress.label, "2 of 3 done (1 failed, 0 skipped)");

  const allDone = derivePlanProgress(steps.map((s) => ({ ...s, status: "done" as const })));
  assert.equal(allDone.label, "3 of 3 done");
});

// ---------------------------------------------------------------------------
// Revision merging: survive, add, remove, reorder
// ---------------------------------------------------------------------------

const REVISION_BASE = "1. Set up environment\n2. Write the migration\n3. Run the tests";

test("a mid-run revision preserves the status of every step that survived", () => {
  const previous = parsePlanText(REVISION_BASE).steps.map((step) => {
    if (step.id === "write-the-migration") return { ...step, status: "active" as const };
    if (step.id === "run-the-tests") return { ...step, status: "done" as const };
    return step;
  });

  // The model comes back having reordered, dropped the migration step, and
  // added a brand new one — a plausible "revise mid-run" turn.
  const revised = "1. Run the tests\n2. Set up environment\n3. Deploy to staging";
  const diff = mergePlanRevision(previous, parsePlanText(revised).steps);

  assert.deepEqual(diff.added, ["deploy-to-staging"]);
  assert.deepEqual(diff.removed, ["write-the-migration"]);
  assert.equal(diff.reordered, true);

  const byId = new Map(diff.steps.map((s) => [s.id, s.status]));
  assert.equal(byId.get("run-the-tests"), "done", "surviving completed step keeps its status");
  assert.equal(byId.get("set-up-environment"), "pending");
  assert.equal(byId.get("deploy-to-staging"), "pending", "a brand new step always starts pending");
  assert.equal(byId.has("write-the-migration"), false, "a removed step does not resurrect");
});

test("a revision that keeps the same relative order for survivors is not flagged reordered", () => {
  const previous = parsePlanText(REVISION_BASE).steps;
  const revised = "1. Set up environment\n2. Run the tests"; // migration dropped, order unchanged
  const diff = mergePlanRevision(previous, parsePlanText(revised).steps);
  assert.equal(diff.reordered, false);
  assert.deepEqual(diff.removed, ["write-the-migration"]);
  assert.deepEqual(diff.added, []);
});

test("a step whose wording changed is treated as a new step, not fuzzily matched to the old one", () => {
  const previous = parsePlanText("1. Write the migration").steps.map((s) => ({
    ...s,
    status: "done" as const,
  }));
  const revised = parsePlanText("1. Write the DB migration script").steps;
  const diff = mergePlanRevision(previous, revised);
  assert.equal(diff.steps[0].status, "pending", "reworded text must not inherit a stale 'done'");
  assert.deepEqual(diff.removed, ["write-the-migration"]);
});

// ---------------------------------------------------------------------------
// Approve/reject gate
// ---------------------------------------------------------------------------

test("execution is gated until the exact current revision is approved", () => {
  const model = createPlanModel(REVISION_BASE, "2026-01-01T00:00:00.000Z");
  assert.equal(planModelCanExecute(model), false);

  const approved = approvePlanModel(model, "2026-01-01T00:00:01.000Z");
  assert.equal(planModelCanExecute(approved), true);
});

test("revising the plan silently invalidates a stale approval instead of carrying it forward", () => {
  const model = approvePlanModel(createPlanModel(REVISION_BASE, "2026-01-01T00:00:00.000Z"));
  assert.equal(planModelCanExecute(model), true);

  const { model: revised } = revisePlanModel(
    model,
    "1. Set up environment\n2. Run the tests\n3. Deploy",
    "2026-01-01T00:00:02.000Z",
  );
  assert.equal(revised.revision, model.revision + 1);
  assert.equal(planModelCanExecute(revised), false, "the old approval belonged to a different revision");

  const reapproved = approvePlanModel(revised, "2026-01-01T00:00:03.000Z");
  assert.equal(planModelCanExecute(reapproved), true);
});

// ---------------------------------------------------------------------------
// Per-step status tracking
// ---------------------------------------------------------------------------

test("setPlanStepStatus updates exactly the named step and ignores an unknown id", () => {
  const model = createPlanModel(REVISION_BASE, "2026-01-01T00:00:00.000Z");
  const updated = setPlanStepStatus(model, "run-the-tests", "skipped", "2026-01-01T00:00:01.000Z");
  assert.equal(updated.steps.find((s) => s.id === "run-the-tests")?.status, "skipped");
  assert.equal(updated.steps.find((s) => s.id === "set-up-environment")?.status, "pending");

  const untouched = setPlanStepStatus(model, "no-such-step", "failed");
  assert.equal(untouched, model, "an unknown step id is a no-op, not a thrown error");
});
