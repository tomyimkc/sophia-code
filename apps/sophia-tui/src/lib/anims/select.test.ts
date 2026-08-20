import test from "node:test";
import assert from "node:assert/strict";
import {
  LOAD_FIELD_ESCALATION_SEC,
  STARTING_LOAD_THRESHOLD_SEC,
  TOOL_LOAD_THRESHOLD_SEC,
  selectAnim,
} from "./select.js";
import type { LoadPhase } from "../progress.js";
import type { AccessibilityPrefs } from "../accessibility.js";

const MOVING: AccessibilityPrefs = { screenReader: false, reducedMotion: false };
const STILL: AccessibilityPrefs = { screenReader: false, reducedMotion: true };

test("streaming and thinking get the 1-line matrix-decode, never a load field", () => {
  for (const phase of ["streaming", "thinking"] as LoadPhase[]) {
    const sel = selectAnim(phase, null, MOVING);
    assert.equal(sel.job, "line");
    assert.equal(sel.id, "matrix-decode");
  }
});

test("tool waits escalate braille to dot-chain to a low-fatigue field", () => {
  assert.deepEqual(
    selectAnim("tool", TOOL_LOAD_THRESHOLD_SEC - 1, MOVING),
    { job: "none", id: "braille-fallback" },
  );
  assert.deepEqual(
    selectAnim("tool", TOOL_LOAD_THRESHOLD_SEC, MOVING),
    { job: "load", id: "dot-chain-sine" },
  );
  assert.deepEqual(
    selectAnim("tool", LOAD_FIELD_ESCALATION_SEC - 1, MOVING),
    { job: "load", id: "dot-chain-sine" },
  );
  assert.deepEqual(
    selectAnim("tool", LOAD_FIELD_ESCALATION_SEC, MOVING),
    { job: "load", id: "sine-sheet" },
  );
});

test("invalid or negative elapsed time fails closed to the compact route", () => {
  for (const elapsed of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.deepEqual(
      selectAnim("tool", elapsed, MOVING),
      { job: "none", id: "braille-fallback" },
    );
    assert.deepEqual(
      selectAnim("starting", elapsed, MOVING),
      { job: "none", id: "braille-fallback" },
    );
  }
});

test("starting waits avoid flash, then escalate loop to atmospheric field", () => {
  assert.deepEqual(
    selectAnim("starting", STARTING_LOAD_THRESHOLD_SEC - 1, MOVING),
    { job: "none", id: "braille-fallback" },
  );
  assert.deepEqual(
    selectAnim("starting", STARTING_LOAD_THRESHOLD_SEC, MOVING),
    { job: "load", id: "dot-chain-loop" },
  );
  assert.deepEqual(
    selectAnim("starting", LOAD_FIELD_ESCALATION_SEC - 1, MOVING),
    { job: "load", id: "dot-chain-loop" },
  );
  assert.deepEqual(
    selectAnim("starting", LOAD_FIELD_ESCALATION_SEC, MOVING),
    { job: "load", id: "circular-ripple" },
  );
});

test("awaiting permission stays compact because progress is blocked on operator input", () => {
  for (const elapsed of [0, TOOL_LOAD_THRESHOLD_SEC, LOAD_FIELD_ESCALATION_SEC, 90]) {
    assert.deepEqual(
      selectAnim("awaiting_permission", elapsed, MOVING),
      { job: "none", id: "braille-fallback" },
    );
  }
});

test("planning and finalizing shimmer the label line only", () => {
  for (const phase of ["planning", "finalizing"] as LoadPhase[]) {
    const sel = selectAnim(phase, null, MOVING);
    assert.equal(sel.job, "line");
    assert.equal(sel.id, "shimmer-label");
  }
});

test("reduced motion selects nothing, regardless of phase", () => {
  for (const phase of ["streaming", "thinking", "tool", "starting", "planning"] as LoadPhase[]) {
    const sel = selectAnim(phase, 120, STILL);
    assert.deepEqual(sel, { job: "none", id: "static" });
  }
});

test("terminal and idle phases fall back to braille", () => {
  for (const phase of ["idle", "done", "error", "cancelled", "cancelling", "paused"] as LoadPhase[]) {
    const sel = selectAnim(phase, 10, MOVING);
    assert.equal(sel.job, "none");
    assert.equal(sel.id, "braille-fallback");
  }
});
