import test from "node:test";
import assert from "node:assert/strict";
import { agiReducer, EMPTY_AGI_STATE } from "./agiState.js";

test("projects an observable AGI run without hidden reasoning", () => {
  let state = agiReducer(EMPTY_AGI_STATE, {
    type: "agi_mode_start",
    runId: "agi-1",
    goal: "ship the change",
    profile: "balanced",
    config: { maxCycles: 8 },
    sameModelVerifier: true,
    statePath: "/tmp/state.json",
  });
  state = agiReducer(state, {
    type: "agi_phase_start",
    phase: "strategize",
    role: "planner",
    model: "omlx",
    cycle: 2,
  });
  state = agiReducer(state, {
    type: "agi_strategy_selected",
    cycle: 2,
    strategy: {
      title: "small reversible patch",
      nextAction: "edit one module",
      prediction: "focused tests pass",
    },
  });
  state = agiReducer(state, {
    type: "agi_verification",
    verdict: { status: "achieved", confidence: 0.9, reason: "tests passed" },
    deterministicEvidence: false,
    verifierIndependent: false,
    sameModelVerifier: true,
  });

  assert.deepEqual(
    {
      enabled: state.enabled,
      active: state.active,
      runId: state.runId,
      cycle: state.cycle,
      phase: state.phase,
      strategy: state.strategy,
      action: state.action,
      verificationStatus: state.verificationStatus,
      confidence: state.confidence,
      sameModelVerifier: state.sameModelVerifier,
      verifierIndependent: state.verifierIndependent,
    },
    {
      enabled: true,
      active: true,
      runId: "agi-1",
      cycle: 2,
      phase: "verify",
      strategy: "small reversible patch",
      action: "edit one module",
      verificationStatus: "achieved",
      confidence: 0.9,
      sameModelVerifier: true,
      verifierIndependent: false,
    },
  );
});

test("preserves candidate-complete rather than upgrading it to achieved", () => {
  const state = agiReducer(
    { ...EMPTY_AGI_STATE, enabled: true, active: true, status: "running" },
    {
      type: "agi_mode_end",
      status: "candidate_complete",
      reason: "same-model verifier needs independent evidence",
      cycles: 3,
    },
  );
  assert.equal(state.status, "candidate_complete");
  assert.equal(state.active, false);
  assert.match(state.reason, /independent/);
});

test("hydrates a resumable run from agi_status", () => {
  const state = agiReducer(EMPTY_AGI_STATE, {
    type: "agi_status",
    enabled: true,
    run: {
      runId: "agi-2",
      status: "paused",
      goal: "resume me",
      currentPhase: "act",
      cycle: 4,
      config: { profile: "deep", maxCycles: 16 },
    },
  });
  assert.deepEqual(
    {
      enabled: state.enabled,
      active: state.active,
      runId: state.runId,
      status: state.status,
      phase: state.phase,
      cycle: state.cycle,
      maxCycles: state.maxCycles,
      profile: state.profile,
    },
    {
      enabled: true,
      active: false,
      runId: "agi-2",
      status: "paused",
      phase: "act",
      cycle: 4,
      maxCycles: 16,
      profile: "deep",
    },
  );
});

test("agi_status can turn future AGI routing off without erasing a durable run", () => {
  const state = agiReducer(
    {
      ...EMPTY_AGI_STATE,
      enabled: true,
      runId: "agi-3",
      status: "paused",
      goal: "keep durable state",
    },
    {
      type: "agi_status",
      enabled: false,
      run: {
        runId: "agi-3",
        status: "paused",
        goal: "keep durable state",
        verifierIndependent: false,
      },
    },
  );
  assert.equal(state.enabled, false);
  assert.equal(state.runId, "agi-3");
  assert.equal(state.goal, "keep durable state");
  assert.equal(state.sameModelVerifier, true);
});

test("projects adaptive route, action authorization, typed discrepancy, and correction receipts", () => {
  let state = agiReducer(EMPTY_AGI_STATE, {
    type: "agi_route_selected",
    route: "critical",
    reason: "external side effects require pre-action authorization",
    goalContract: {
      budgets: {
        maxCycles: 4,
        wallClockSec: 900,
        maxStepsPerAction: 5,
      },
    },
  });
  state = agiReducer(state, {
    type: "agi_action_contract",
    contract: {
      actionId: "act-123",
      actionClass: "external_mutation",
      action: "publish the release",
      risk: 0.9,
      uncertainty: 0.4,
      reversibility: 0.2,
      authorizationRequired: true,
    },
  });
  state = agiReducer(state, {
    type: "agi_pre_action_gate",
    actionId: "act-123",
    actionClass: "external_mutation",
    authorizationRequired: true,
    authorized: false,
  });
  state = agiReducer(state, {
    type: "agi_discrepancy_vector",
    vector: {
      hasFailures: true,
      hasUnknowns: false,
      allRequiredPassed: false,
    },
  });
  state = agiReducer(state, {
    type: "agi_correction_selected",
    action: "rollback",
  });

  assert.deepEqual(
    {
      route: state.route,
      routeReason: state.routeReason,
      maxCycles: state.maxCycles,
      wallClockSec: state.wallClockSec,
      maxStepsPerAction: state.maxStepsPerAction,
      actionId: state.actionId,
      actionClass: state.actionClass,
      authorizationRequired: state.authorizationRequired,
      authorizationGranted: state.authorizationGranted,
      expectationStatus: state.expectationStatus,
      correctionAction: state.correctionAction,
    },
    {
      route: "critical",
      routeReason: "external side effects require pre-action authorization",
      maxCycles: 4,
      wallClockSec: 900,
      maxStepsPerAction: 5,
      actionId: "act-123",
      actionClass: "external_mutation",
      authorizationRequired: true,
      authorizationGranted: false,
      expectationStatus: "failed",
      correctionAction: "rollback",
    },
  );
});

test("projects criterion coverage and the current targeted gap without hidden reasoning", () => {
  let state = agiReducer(EMPTY_AGI_STATE, {
    type: "completion_contract",
    criteria: [
      { criterionId: "C01", mandatory: true },
      { criterionId: "C02", mandatory: true },
      { criterionId: "C03", mandatory: false },
    ],
  });
  state = agiReducer(state, {
    type: "criterion_ledger",
    summary: {
      total: 3,
      verified: 1,
      failed: ["C02"],
      unknown: [],
      blocked: [],
    },
  });
  state = agiReducer(state, {
    type: "completion_gap_start",
    wave: 1,
    criteria: ["C02"],
    tasks: [{ taskId: "GAP-C02-1", criteriaCovered: ["C02"] }],
  });

  assert.deepEqual(
    {
      verified: state.verifiedCriteria,
      total: state.totalCriteria,
      failed: state.failedCriteria,
      unknown: state.unknownCriteria,
      blocked: state.blockedCriteria,
      currentGapId: state.currentGapId,
    },
    {
      verified: 1,
      total: 3,
      failed: ["C02"],
      unknown: [],
      blocked: [],
      currentGapId: "GAP-C02-1",
    },
  );
});
