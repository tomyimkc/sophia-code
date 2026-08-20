import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAccessibility } from "../lib/accessibility.js";
import {
  ambientBackdropSnapshot,
  ambientIntervalEnabled,
} from "./AmbientBackdrop.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

test("ambient 3D backdrop fills the requested pane with defined cells", () => {
  for (const [width, height] of [[40, 7], [80, 18], [120, 31]]) {
    const frame = ambientBackdropSnapshot({ frame: 4, width, height });
    assert.equal(frame.length, height);
    frame.forEach((row) => {
      assert.equal(row.length, width);
      row.forEach((cell) => {
        assert.equal(typeof cell.ch, "string");
        assert.ok(Number.isFinite(cell.r));
        assert.ok(Number.isFinite(cell.g));
        assert.ok(Number.isFinite(cell.b));
      });
    });
  }
});

test("ambient backdrop is deterministic but visibly evolves with frame", () => {
  const a = ambientBackdropSnapshot({ frame: 2, width: 60, height: 18 });
  const b = ambientBackdropSnapshot({ frame: 2, width: 60, height: 18 });
  const c = ambientBackdropSnapshot({ frame: 9, width: 60, height: 18 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("ambient backdrop stays sparse instead of forming dotted separator rows", () => {
  const width = 80;
  const height = 30;
  for (const frameValue of [0, 1, 2, 5, 10]) {
    const frame = ambientBackdropSnapshot({
      frame: frameValue,
      width,
      height,
    });
    const rowCounts = frame.map(
      (row) => row.filter((cell) => cell.ch !== " ").length,
    );
    const visible = rowCounts.reduce((sum, count) => sum + count, 0);
    assert.ok(visible > 0, `frame ${frameValue} should retain ambient depth`);
    assert.ok(
      visible < width * height * 0.05,
      `frame ${frameValue} should light under 5% of the pane`,
    );
    assert.ok(
      Math.max(...rowCounts) < width * 0.1,
      `frame ${frameValue} should never paint a full dotted row`,
    );
  }
});

test("reduced motion stops the ambient timer and screen readers get no animation", () => {
  assert.equal(
    ambientIntervalEnabled(resolveAccessibility([], NO_ENV)),
    true,
  );
  assert.equal(
    ambientIntervalEnabled(
      resolveAccessibility(["--reduced-motion"], NO_ENV),
    ),
    false,
  );
  assert.equal(
    ambientIntervalEnabled(
      resolveAccessibility(["--ax-screen-reader"], NO_ENV),
    ),
    false,
  );
});

test("ambient production component contains no random render source", () => {
  const source = readFileSync(
    new URL("./AmbientBackdrop.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /Math\.random/);
});
