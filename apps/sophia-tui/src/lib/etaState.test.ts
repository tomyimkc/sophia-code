import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_RUN_ETA_STATE,
  runEtaElapsedSec,
  runEtaEstimatedTotalSec,
  runEtaLabel,
  runEtaReducer,
  runEtaRemainingSec,
} from "./etaState.js";

test("a run starts in an honest estimating state", () => {
  const state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_start",
    runId: "run-1",
    receivedAtMs: 1_000,
  });
  assert.equal(state.runId, "run-1");
  assert.equal(state.status, "estimating");
  assert.equal(state.estimatedRemainingSec, null);
  assert.equal(runEtaElapsedSec(state, 2_000), 1);
  assert.equal(runEtaLabel(state, 2_000), "ETA estimating");
});

test("kernel history supplies remaining and estimated full-run duration", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_start",
    runId: "run-1",
    receivedAtMs: 1_000,
  });
  state = runEtaReducer(state, {
    type: "run_eta",
    mode: "workflow",
    elapsedSec: 5,
    estimatedRemainingSec: 595,
    estimatedTotalSec: 600,
    confidence: "medium",
    etaBasis: "median of 5 recent workflow runs",
    receivedAtMs: 6_000,
  });
  assert.equal(state.status, "active");
  assert.equal(state.estimatedTotalSec, 600);
  assert.equal(state.confidence, "medium");
  assert.equal(runEtaRemainingSec(state, 66_000), 535);
  assert.equal(runEtaElapsedSec(state, 66_000), 65);
  assert.equal(runEtaEstimatedTotalSec(state, 66_000), 600);
});

test("a kernel recalibration with null estimates clears stale numbers", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_eta",
    estimatedRemainingSec: 90,
    estimatedTotalSec: 100,
    receivedAtMs: 1_000,
  });
  state = runEtaReducer(state, {
    type: "run_eta",
    estimatedRemainingSec: null,
    estimatedTotalSec: null,
    confidence: null,
    etaBasis: "successful history exhausted; recalibrating",
    receivedAtMs: 31_000,
  });

  assert.equal(state.status, "estimating");
  assert.equal(state.estimatedRemainingSec, null);
  assert.equal(state.estimatedTotalSec, null);
  assert.equal(runEtaEstimatedTotalSec(state, 31_000), null);
  assert.equal(runEtaLabel(state, 31_000), "ETA estimating");
});

test("worker-stage progress does not replace a full-run estimate", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_start",
    runId: "run-1",
    receivedAtMs: 1_000,
  });
  state = runEtaReducer(state, {
    type: "run_eta",
    elapsedSec: 0,
    estimatedRemainingSec: 600,
    estimatedTotalSec: 600,
    confidence: "low",
    receivedAtMs: 1_000,
  });
  state = runEtaReducer(state, {
    type: "dynamic_workflow_stage_progress",
    stage: 1,
    plannedStages: 1,
    estimatedRemainingSec: 100,
    receivedAtMs: 121_000,
  });
  assert.equal(state.estimatedRemainingSec, 480);
  assert.equal(state.estimatedTotalSec, 600);
  assert.equal(runEtaEstimatedTotalSec(state, 121_000), 600);
});

test("worker progress waits for measured throughput instead of inventing a duration", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_start",
    runId: "run-1",
  });
  state = runEtaReducer(state, {
    type: "dynamic_workflow_stage_start",
    stage: 1,
    plannedStages: 3,
    taskCount: 4,
  });
  state = runEtaReducer(state, {
    type: "dynamic_workflow_worker_progress",
    stage: 1,
  });
  assert.equal(state.status, "waiting");
  assert.equal(state.plannedStages, 3);
  assert.equal(state.totalUnits, 4);
  assert.equal(runEtaLabel(state, 0), "ETA waiting");
});

test("a worker-stage ETA is not presented as the full-run ETA", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_start",
    runId: "run-1",
  });
  state = runEtaReducer(state, {
    type: "dynamic_workflow_stage_progress",
    stage: 1,
    plannedStages: 1,
    terminal: 1,
    total: 2,
    estimatedRemainingSec: 120,
    etaBasis: "observed terminal throughput",
    receivedAtMs: 10_000,
  });
  assert.equal(state.status, "estimating");
  assert.equal(state.confidence, null);
  assert.equal(runEtaRemainingSec(state, 40_000), null);
  assert.equal(runEtaLabel(state, 40_000), "ETA estimating");
  assert.match(state.basis, /full-run ETA recalibrating/);
});

test("completed stage timing is retained without inventing a full-run ETA", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "dynamic_workflow_stage_start",
    stage: 1,
    plannedStages: 3,
  });
  state = runEtaReducer(state, {
    type: "dynamic_workflow_stage_progress",
    stage: 1,
    plannedStages: 3,
    estimatedRemainingSec: 60,
    receivedAtMs: 1_000,
  });
  assert.equal(state.estimatedRemainingSec, null);
  assert.equal(state.confidence, null);
  assert.match(state.basis, /full-run ETA recalibrating/);

  state = runEtaReducer(state, {
    type: "dynamic_workflow_stage_end",
    stage: 1,
    plannedStages: 3,
    elapsedSec: 100,
    receivedAtMs: 2_000,
  });
  assert.deepEqual(state.observedStageDurationsSec, [100]);
  assert.equal(state.estimatedRemainingSec, null);
  assert.equal(state.status, "waiting");

  state = runEtaReducer(state, {
    type: "dynamic_workflow_stage_progress",
    stage: 2,
    plannedStages: 3,
    estimatedRemainingSec: 40,
    receivedAtMs: 3_000,
  });
  assert.equal(state.estimatedRemainingSec, null);
  assert.match(state.basis, /full-run ETA recalibrating/);
});

test("stage and review transitions keep a full-run countdown moving", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_start",
    receivedAtMs: 1_000,
  });
  state = runEtaReducer(state, {
    type: "run_eta",
    estimatedTotalSec: 600,
    estimatedRemainingSec: 600,
    receivedAtMs: 1_000,
  });
  state = runEtaReducer(state, {
    type: "dynamic_workflow_controller_start",
    phase: "review",
    stage: 1,
    receivedAtMs: 61_000,
  });
  assert.equal(state.status, "active");
  assert.equal(state.estimatedRemainingSec, 540);

  state = runEtaReducer(state, {
    type: "dynamic_workflow_stage_start",
    stage: 2,
    receivedAtMs: 121_000,
  });
  assert.equal(state.status, "active");
  assert.equal(state.estimatedRemainingSec, 480);

  state = runEtaReducer(state, {
    type: "dynamic_workflow_stage_progress",
    stage: 2,
    estimatedRemainingSec: 10,
    receivedAtMs: 181_000,
  });
  assert.equal(state.estimatedRemainingSec, 420);
  assert.equal(state.estimatedTotalSec, 600);
});

test("a stage deadline extension cannot overwrite the full-run ETA basis", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_eta",
    estimatedTotalSec: 100,
    estimatedRemainingSec: 100,
    etaBasis: "median of successful workflow runs",
    receivedAtMs: 1_000,
  });
  state = runEtaReducer(state, {
    type: "dynamic_workflow_stage_deadline_extended",
    reason: "worker progress extended this stage",
    receivedAtMs: 31_000,
  });
  assert.equal(state.estimatedRemainingSec, 70);
  assert.equal(state.estimatedTotalSec, 100);
  assert.equal(state.basis, "median of successful workflow runs");

  state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "dynamic_workflow_stage_deadline_extended",
    receivedAtMs: 31_000,
  });
  assert.equal(state.estimatedRemainingSec, null);
  assert.equal(state.status, "waiting");
  assert.match(state.basis, /full-run ETA unavailable/);
});

test("generic synthesis timing cannot create or overwrite a full-run ETA", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "dynamic_workflow_synthesis_start",
    estimatedRemainingSec: 15,
    receivedAtMs: 1_000,
  });
  assert.equal(state.estimatedRemainingSec, null);
  assert.equal(runEtaLabel(state, 1_000), "ETA estimating");

  state = runEtaReducer(state, {
    type: "run_eta",
    estimatedTotalSec: 300,
    estimatedRemainingSec: 250,
    elapsedSec: 50,
    receivedAtMs: 51_000,
  });
  state = runEtaReducer(state, {
    type: "dynamic_workflow_synthesis_start",
    estimatedRemainingSec: 5,
    receivedAtMs: 101_000,
  });
  assert.equal(state.estimatedRemainingSec, 200);
  assert.equal(state.estimatedTotalSec, 300);

  state = runEtaReducer(state, {
    type: "dynamic_workflow_synthesis_start",
    runEstimatedRemainingSec: 80,
    etaBasis: "kernel full-run synthesis estimate",
    receivedAtMs: 121_000,
  });
  assert.equal(state.estimatedRemainingSec, 80);
  assert.equal(state.confidence, "high");
  assert.equal(state.basis, "kernel full-run synthesis estimate");
});

test("an explicit kernel run estimate has the highest confidence", () => {
  const state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "dynamic_workflow_stage_progress",
    stage: 2,
    plannedStages: 5,
    workflowEstimatedRemainingSec: 900,
    receivedAtMs: 5_000,
  });
  assert.equal(state.estimatedRemainingSec, 900);
  assert.equal(state.confidence, "high");
  assert.equal(runEtaLabel(state, 5_000), "ETA ~15m");
});

test("provider waits change the label without pausing the full-run clock", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_eta",
    estimatedTotalSec: 100,
    estimatedRemainingSec: 90,
    receivedAtMs: 10_000,
  });
  state = runEtaReducer(state, {
    type: "provider_wait",
    receivedAtMs: 40_000,
  });
  state = runEtaReducer(state, {
    type: "provider_wait",
    receivedAtMs: 60_000,
  });
  assert.equal(state.status, "waiting");
  assert.equal(state.estimatedRemainingSec, 90);
  assert.equal(state.estimateAsOfMs, 10_000);
  assert.equal(runEtaRemainingSec(state, 70_000), 30);
  assert.equal(runEtaEstimatedTotalSec(state, 70_000), 100);
  assert.equal(runEtaLabel(state, 70_000), "ETA under 1m · waiting");
  assert.equal(runEtaRemainingSec(state, 101_000), null);
  assert.equal(runEtaEstimatedTotalSec(state, 101_000), null);
  assert.equal(runEtaLabel(state, 101_000), "ETA waiting");
  assert.equal(state.basis, "kernel run history");
});

test("provider waits preserve a just-published recalibration receipt", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_eta",
    estimatedTotalSec: 100,
    estimatedRemainingSec: 90,
    etaBasis: "median of successful workflow runs",
    receivedAtMs: 10_000,
  });
  state = runEtaReducer(state, {
    type: "run_eta",
    estimatedTotalSec: null,
    estimatedRemainingSec: null,
    confidence: null,
    etaBasis: "recalibrating · no successful comparable completed run exceeds current elapsed time",
    receivedAtMs: 40_000,
  });
  state = runEtaReducer(state, {
    type: "provider_wait",
    receivedAtMs: 40_001,
  });

  assert.equal(state.status, "waiting");
  assert.equal(state.estimatedRemainingSec, null);
  assert.equal(state.estimatedTotalSec, null);
  assert.equal(state.confidence, null);
  assert.equal(
    state.basis,
    "recalibrating · no successful comparable completed run exceeds current elapsed time",
  );
});

test("workflow progress resumes without inflating a provider-wait full-run ETA", () => {
  for (const type of [
    "dynamic_workflow_controller_end",
    "dynamic_workflow_controller_start",
    "dynamic_workflow_stage_start",
    "dynamic_workflow_stage_deadline_extended",
    "dynamic_workflow_worker_progress",
  ]) {
    let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
      type: "run_start",
      runId: `run-${type}`,
      receivedAtMs: 0,
    });
    state = runEtaReducer(state, {
      type: "run_eta",
      estimatedTotalSec: 100,
      estimatedRemainingSec: 90,
      elapsedSec: 10,
      receivedAtMs: 10_000,
    });
    state = runEtaReducer(state, {
      type: "provider_wait",
      receivedAtMs: 40_000,
    });
    assert.equal(state.estimatedRemainingSec, 90, type);
    assert.equal(runEtaRemainingSec(state, 40_000), 60, type);
    assert.equal(state.status, "waiting", type);

    state = runEtaReducer(state, {
      type,
      stage: 1,
      receivedAtMs: 70_000,
    });
    assert.equal(state.status, "active", type);
    assert.equal(state.estimatedRemainingSec, 30, type);
    assert.equal(state.estimateAsOfMs, 70_000, type);
    assert.equal(state.estimatedTotalSec, 100, type);
    assert.equal(runEtaRemainingSec(state, 80_000), 20, type);
  }
});

test("an expired non-terminal estimate recalibrates instead of showing zero", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_start",
    runId: "run-1",
    receivedAtMs: 1_000,
  });
  state = runEtaReducer(state, {
    type: "run_eta",
    elapsedSec: 0,
    estimatedRemainingSec: 25,
    estimatedTotalSec: 25,
    confidence: "low",
    receivedAtMs: 1_000,
  });

  assert.equal(runEtaRemainingSec(state, 31_000), null);
  assert.equal(runEtaEstimatedTotalSec(state, 31_000), null);
  assert.equal(runEtaLabel(state, 31_000), "ETA estimating");

  state = runEtaReducer(state, {
    type: "provider_wait",
    receivedAtMs: 31_000,
  });
  assert.equal(state.status, "waiting");
  assert.equal(state.estimatedRemainingSec, 25);
  assert.equal(state.estimateAsOfMs, 1_000);
  assert.equal(runEtaRemainingSec(state, 61_000), null);
  assert.equal(runEtaEstimatedTotalSec(state, 61_000), null);
  assert.equal(runEtaLabel(state, 61_000), "ETA waiting");
});

test("command errors cannot freeze an active ETA or reopen a completed run", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_start",
    receivedAtMs: 0,
  });
  state = runEtaReducer(state, {
    type: "run_eta",
    estimatedTotalSec: 100,
    estimatedRemainingSec: 90,
    elapsedSec: 10,
    confidence: "low",
    receivedAtMs: 10_000,
  });
  const active = state;
  state = runEtaReducer(active, {
    type: "error",
    receivedAtMs: 40_000,
  });
  assert.equal(state, active);
  assert.equal(state.status, "active");
  assert.equal(runEtaRemainingSec(state, 40_000), 60);
  assert.equal(state.estimatedTotalSec, 100);

  state = runEtaReducer(state, {
    type: "run_finished",
    ok: true,
    durationSec: 50,
    receivedAtMs: 50_000,
  });
  const complete = state;
  state = runEtaReducer(complete, {
    type: "error",
    receivedAtMs: 60_000,
  });
  assert.equal(state, complete);
  assert.equal(state.status, "complete");
  assert.equal(runEtaRemainingSec(state, 60_000), 0);
});

test("only run_finished changes ETA to complete", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "run_start",
    runId: "run-1",
  });
  state = runEtaReducer(state, { type: "error", message: "provider failed" });
  assert.equal(state.status, "estimating");
  state = runEtaReducer(state, {
    type: "run_finished",
    ok: false,
    reason: "error",
    endedAt: "2026-08-15T01:00:00Z",
  });
  assert.equal(state.status, "complete");
  assert.equal(state.terminalOk, false);
  assert.equal(runEtaRemainingSec(state, Date.now()), 0);
  assert.equal(runEtaLabel(state, Date.now()), "Finished with errors");
});

test("planned stages may be revised but never fall below reached progress", () => {
  let state = runEtaReducer(EMPTY_RUN_ETA_STATE, {
    type: "goal_update",
    currentStage: 2,
    plannedStages: 6,
  });
  assert.equal(state.plannedStages, 6);
  state = runEtaReducer(state, {
    type: "goal_update",
    currentStage: 4,
    plannedStages: 3,
  });
  assert.equal(state.stage, 4);
  assert.equal(state.plannedStages, 4);
});
