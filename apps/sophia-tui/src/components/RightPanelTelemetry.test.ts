import test from "node:test";
import assert from "node:assert/strict";
import {
  formatRightPanelDuration,
  rightPanelEtaLabel,
} from "./RightPanelTelemetry.js";
import { matrixDigitSegments } from "./MatrixText.js";

test("right-panel duration formatting remains compact at terminal widths", () => {
  assert.equal(formatRightPanelDuration(9), "9s");
  assert.equal(formatRightPanelDuration(125), "2m 5s");
  assert.equal(formatRightPanelDuration(3600), "1h");
  assert.equal(formatRightPanelDuration(7325), "2h 2m");
});

test("right-panel ETA labels distinguish estimates, waits, and completion", () => {
  assert.equal(rightPanelEtaLabel(undefined), "");
  assert.equal(
    rightPanelEtaLabel({ status: "estimating", remainingSec: null }),
    "ETA estimating",
  );
  assert.equal(
    rightPanelEtaLabel({ status: "active", remainingSec: 125 }),
    "ETA ~2m 5s",
  );
  assert.equal(
    rightPanelEtaLabel({ status: "waiting", remainingSec: 30 }),
    "ETA ~30s · waiting",
  );
  assert.equal(
    rightPanelEtaLabel({ status: "waiting", remainingSec: null }),
    "ETA waiting",
  );
  assert.equal(
    rightPanelEtaLabel({ status: "complete", remainingSec: 0 }),
    "Done",
  );
  assert.equal(
    rightPanelEtaLabel({
      status: "active",
      remainingSec: 125,
      elapsedSec: 175,
      estimatedTotalSec: 300,
    }),
    "ETA ~2m 5s · total ~5m",
  );
  assert.equal(
    rightPanelEtaLabel({
      status: "estimating",
      remainingSec: null,
      elapsedSec: 35,
    }),
    "Elapsed 35s · ETA calibrating",
  );
  assert.equal(
    rightPanelEtaLabel({
      status: "complete",
      remainingSec: 0,
      estimatedTotalSec: 245,
      terminalOk: false,
    }),
    "Finished with errors · 4m 5s total",
  );
});

test("changing an ETA second preserves its complete sentence scaffold", () => {
  const before = matrixDigitSegments(rightPanelEtaLabel({
    status: "active",
    remainingSec: 125,
    estimatedTotalSec: 300,
  }));
  const after = matrixDigitSegments(rightPanelEtaLabel({
    status: "active",
    remainingSec: 124,
    estimatedTotalSec: 300,
  }));
  const stable = (segments: ReturnType<typeof matrixDigitSegments>) =>
    segments.filter((segment) => segment.kind === "stable").map((segment) => segment.text);
  const digits = (segments: ReturnType<typeof matrixDigitSegments>) =>
    segments.filter((segment) => segment.kind === "digits").map((segment) => segment.text);

  assert.deepEqual(stable(after), stable(before));
  assert.deepEqual(stable(after), ["ETA ~", "m ", "s · total ~", "m"]);
  assert.deepEqual(digits(before), ["2", "5", "5"]);
  assert.deepEqual(digits(after), ["2", "4", "5"]);
});
