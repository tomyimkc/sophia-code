import test from "node:test";
import assert from "node:assert/strict";
import { sessionFlowWheelGesture } from "./sessionFlowGesture.js";

const base = {
  shift: false,
  meta: false,
  ctrl: false,
};

test("maps two-finger vertical and horizontal wheel reports to four-way pan", () => {
  assert.deepEqual(
    sessionFlowWheelGesture({ ...base, kind: "wheel_up" }),
    { kind: "pan", dx: 0, dy: 3 },
  );
  assert.deepEqual(
    sessionFlowWheelGesture({ ...base, kind: "wheel_down" }),
    { kind: "pan", dx: 0, dy: -3 },
  );
  assert.deepEqual(
    sessionFlowWheelGesture({ ...base, kind: "wheel_left" }),
    { kind: "pan", dx: 6, dy: 0 },
  );
  assert.deepEqual(
    sessionFlowWheelGesture({ ...base, kind: "wheel_right" }),
    { kind: "pan", dx: -6, dy: 0 },
  );
});

test("uses Shift+vertical scroll as a horizontal-pan fallback", () => {
  assert.deepEqual(
    sessionFlowWheelGesture({
      ...base,
      kind: "wheel_up",
      shift: true,
    }),
    { kind: "pan", dx: 6, dy: 0 },
  );
  assert.deepEqual(
    sessionFlowWheelGesture({
      ...base,
      kind: "wheel_down",
      shift: true,
    }),
    { kind: "pan", dx: -6, dy: 0 },
  );
});

test("maps Ctrl or Meta plus two-finger vertical scroll to semantic zoom", () => {
  assert.deepEqual(
    sessionFlowWheelGesture({
      ...base,
      kind: "wheel_up",
      ctrl: true,
    }),
    { kind: "zoom", step: 1 },
  );
  assert.deepEqual(
    sessionFlowWheelGesture({
      ...base,
      kind: "wheel_down",
      meta: true,
    }),
    { kind: "zoom", step: -1 },
  );
});

test("ignores non-wheel reports and accepts custom pan sensitivity", () => {
  assert.equal(
    sessionFlowWheelGesture({ ...base, kind: "move" }),
    null,
  );
  assert.deepEqual(
    sessionFlowWheelGesture(
      { ...base, kind: "wheel_right" },
      { horizontalPanCells: 2, verticalPanCells: 1 },
    ),
    { kind: "pan", dx: -2, dy: 0 },
  );
});
