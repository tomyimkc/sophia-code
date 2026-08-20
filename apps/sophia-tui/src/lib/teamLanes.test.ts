import test from "node:test";
import assert from "node:assert/strict";
import {
  canRequestLaneCancel,
  canRequestLaneInterrupt,
  countTeamLanes,
  emptyLaneBudgets,
  isTerminalLane,
  readLaneBudget,
  resolveTeamDispatchPolicy,
  teamDispatchDecision,
  type TeamLane,
} from "./teamLanes.js";

function lane(overrides: Partial<TeamLane> = {}): TeamLane {
  return {
    id: "lane-1",
    title: "Inspect provider health",
    role: "reviewer",
    lifecycle: "running",
    control: { cancel: "none", interrupt: "none" },
    budgets: emptyLaneBudgets(),
    result: { state: "none" },
    ...overrides,
  };
}

test("saved dispatch policy wins over machine and public defaults", () => {
  assert.deepEqual(
    resolveTeamDispatchPolicy({
      savedPolicy: "off",
      localDefault: "auto",
      publicDefault: "ask-first",
    }),
    { policy: "off", source: "saved", confirmationRequired: false },
  );
});
test("an explicit machine-local default supports auto-dispatch on this Mac", () => {
  assert.deepEqual(resolveTeamDispatchPolicy({ localDefault: "auto" }), {
    policy: "auto",
    source: "local-default",
    confirmationRequired: false,
  });
});

test("public installs default automatic team dispatch to off", () => {
  assert.deepEqual(resolveTeamDispatchPolicy(), {
    policy: "off",
    source: "public-default",
    confirmationRequired: false,
  });
  assert.deepEqual(resolveTeamDispatchPolicy({ savedPolicy: "invalid" }), {
    policy: "off",
    source: "public-default",
    confirmationRequired: false,
  });
});

test("dispatch decisions express eligibility without claiming execution", () => {
  assert.equal(teamDispatchDecision("off", true), "disabled");
  assert.equal(teamDispatchDecision("auto", false), "not-eligible");
  assert.equal(
    teamDispatchDecision("ask-first", true),
    "confirmation-required",
  );
  assert.equal(teamDispatchDecision("auto", true), "eligible");
});

test("budget readings distinguish warning, exhaustion, overage, and unknown", () => {
  const base = {
    source: "configured" as const,
    enforcement: "not-reported" as const,
  };
  assert.equal(
    readLaneBudget({ ...base, used: 79, limit: 100 }).status,
    "ok",
  );
  assert.equal(
    readLaneBudget({ ...base, used: 80, limit: 100 }).status,
    "warning",
  );
  assert.equal(
    readLaneBudget({ ...base, used: 100, limit: 100 }).status,
    "exhausted",
  );
  assert.equal(
    readLaneBudget({ ...base, used: 101, limit: 100 }).status,
    "over",
  );
  assert.equal(
    readLaneBudget({ ...base, used: null, limit: 100 }).status,
    "unknown",
  );
});

test("budget enforcement is never inferred from a configured limit", () => {
  assert.equal(
    readLaneBudget({
      used: 10,
      limit: 100,
      source: "configured",
      enforcement: "not-reported",
    }).enforcementReported,
    false,
  );
  assert.equal(
    readLaneBudget({
      used: 10,
      limit: 100,
      source: "kernel-reported",
      enforcement: "kernel-reported",
    }).enforcementReported,
    true,
  );
});

test("cancel and interrupt requests remain distinct from terminal states", () => {
  const requested = lane({
    lifecycle: "running",
    control: { cancel: "requested", interrupt: "none" },
  });
  assert.equal(isTerminalLane(requested), false);
  assert.equal(canRequestLaneCancel(requested), false);
  assert.equal(canRequestLaneInterrupt(requested), true);

  const cancelled = lane({ lifecycle: "cancelled" });
  assert.equal(isTerminalLane(cancelled), true);
  assert.equal(canRequestLaneCancel(cancelled), false);
  assert.equal(canRequestLaneInterrupt(cancelled), false);
});

test("interrupt is only offered for a lane that may currently be executing", () => {
  assert.equal(canRequestLaneInterrupt(lane({ lifecycle: "queued" })), false);
  assert.equal(canRequestLaneInterrupt(lane({ lifecycle: "starting" })), true);
  assert.equal(canRequestLaneInterrupt(lane({ lifecycle: "waiting" })), true);
  assert.equal(
    canRequestLaneInterrupt(
      lane({
        lifecycle: "running",
        control: { cancel: "none", interrupt: "unsupported" },
      }),
    ),
    false,
  );
});

test("team counts surface conflicts and pending control requests", () => {
  const counts = countTeamLanes([
    lane(),
    lane({
      id: "lane-2",
      lifecycle: "succeeded",
      result: { state: "conflict", conflictIds: ["conflict-1"] },
    }),
    lane({
      id: "lane-3",
      lifecycle: "cancelling",
      control: { cancel: "acknowledged", interrupt: "none" },
    }),
    lane({ id: "lane-4", lifecycle: "failed", result: { state: "failed" } }),
  ]);
  assert.deepEqual(counts, {
    total: 4,
    active: 2,
    terminal: 2,
    succeeded: 1,
    failed: 1,
    conflicts: 1,
    controlPending: 1,
  });
});
