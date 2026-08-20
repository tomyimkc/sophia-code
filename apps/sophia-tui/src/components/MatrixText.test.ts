import test from "node:test";
import assert from "node:assert/strict";
import { matrixRevealCells } from "../lib/anims/index.js";

import {
  MATRIX_SCHEDULER_QUANTUM_MS,
  matrixDigitAnimationEnabled,
  matrixDigitSegments,
  matrixRevealBucketDueAt,
  matrixRevealIntervalEnabled,
  matrixRevealSchedulerSnapshot,
  scheduleMatrixRevealTick,
} from "./MatrixText.js";

test("matrix ticks quantize onto one terminal-friendly redraw pulse", () => {
  const now = 1_000;
  const first = matrixRevealBucketDueAt(now, 24);
  const second = matrixRevealBucketDueAt(now, 31);

  assert.equal(first, second);
  assert.ok(first >= now + 31);
  assert.ok(first < now + 31 + MATRIX_SCHEDULER_QUANTUM_MS);
});

test("matrix surfaces share one armed scheduler while retaining separate queued ticks", () => {
  const before = matrixRevealSchedulerSnapshot();
  assert.equal(before.queuedTicks, 0);
  assert.equal(before.timerArmed, false);

  const cancelFirst = scheduleMatrixRevealTick(() => {}, 60_000);
  const cancelSecond = scheduleMatrixRevealTick(() => {}, 60_000);
  const active = matrixRevealSchedulerSnapshot();
  assert.equal(active.queuedTicks, 2);
  assert.equal(active.timerArmed, true);

  cancelFirst();
  assert.equal(matrixRevealSchedulerSnapshot().queuedTicks, 1);
  cancelSecond();
  assert.deepEqual(matrixRevealSchedulerSnapshot(), {
    queuedTicks: 0,
    timerArmed: false,
  });
});

test("reduced motion prevents a matrix surface from scheduling any tick", () => {
  assert.equal(matrixRevealIntervalEnabled(true, false), true);
  assert.equal(matrixRevealIntervalEnabled(true, true), false);
  assert.equal(matrixRevealIntervalEnabled(false, false), false);
});

test("digit-only matrix segments leave ETA letters and punctuation literal", () => {
  const before = matrixDigitSegments("ETA ~2m 5s · total ~5m · waiting");
  const after = matrixDigitSegments("ETA ~2m 4s · total ~5m · waiting");
  const stable = (segments: ReturnType<typeof matrixDigitSegments>) =>
    segments.filter((segment) => segment.kind === "stable").map((segment) => segment.text);
  const digits = (segments: ReturnType<typeof matrixDigitSegments>) =>
    segments.filter((segment) => segment.kind === "digits").map((segment) => segment.text);

  assert.deepEqual(stable(after), stable(before));
  assert.deepEqual(stable(after), ["ETA ~", "m ", "s · total ~", "m · waiting"]);
  assert.deepEqual(digits(before), ["2", "5", "5"]);
  assert.deepEqual(digits(after), ["2", "4", "5"]);
  assert.deepEqual(
    digits(after)
      .map((value, index) => value === digits(before)[index] ? null : index)
      .filter((index) => index !== null),
    [1],
    "only the changed seconds run enters a new MatrixText frontier",
  );
  const [liveSecond] = matrixRevealCells({
    text: digits(after)[1]!,
    previousText: digits(before)[1]!,
    frame: 0,
    churnFrame: 3,
  });
  assert.equal(liveSecond?.live, true);
  assert.notEqual(liveSecond?.display, liveSecond?.source);
});

test("digit-only matrix labels stay fully literal for accessibility modes", () => {
  assert.equal(
    matrixDigitAnimationEnabled({ screenReader: false, reducedMotion: false }),
    true,
  );
  assert.equal(
    matrixDigitAnimationEnabled({ screenReader: false, reducedMotion: true }),
    false,
  );
  assert.equal(
    matrixDigitAnimationEnabled({ screenReader: true, reducedMotion: true }),
    false,
  );
  assert.deepEqual(matrixDigitSegments("ETA estimating"), [{
    kind: "stable",
    text: "ETA estimating",
    ordinal: 0,
  }]);
});
