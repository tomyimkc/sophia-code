import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_FLOW_DRAG_THRESHOLD_CELLS,
  clampSessionFlowPan,
  fitSessionFlowPan,
  fitSessionFlowViewport,
  isSessionFlowDrag,
  scaleSessionFlowBounds,
  sessionFlowPointerDelta,
  sessionFlowPointerGesture,
  sessionFlowPointerTravelCells,
  zoomAnchorSessionFlowPan,
} from "./sessionFlowViewport.js";

test("click versus drag uses a two-cell maximum-axis threshold", () => {
  const start = { x: 10, y: 20 };
  assert.equal(SESSION_FLOW_DRAG_THRESHOLD_CELLS, 2);
  assert.deepEqual(sessionFlowPointerDelta(start, { x: 11, y: 19 }), {
    panX: 1,
    panY: -1,
  });
  assert.equal(sessionFlowPointerTravelCells(start, { x: 11, y: 19 }), 1);
  assert.equal(isSessionFlowDrag(start, { x: 11, y: 19 }), false);
  assert.equal(sessionFlowPointerGesture(start, { x: 11, y: 19 }), "click");
  assert.equal(isSessionFlowDrag(start, { x: 12, y: 20 }), true);
  assert.equal(sessionFlowPointerGesture(start, { x: 10, y: 18 }), "drag");
  assert.equal(
    sessionFlowPointerGesture(start, { x: 12, y: 22 }),
    "drag",
    "diagonal movement does not need to accumulate Manhattan distance",
  );
});

test("pointer helpers normalize fractional and non-finite terminal cells", () => {
  assert.deepEqual(
    sessionFlowPointerDelta(
      { x: 4.4, y: Number.NaN },
      { x: 6.2, y: 1.6 },
    ),
    { panX: 2, panY: 2 },
  );
  assert.equal(
    isSessionFlowDrag({ x: 0, y: 0 }, { x: 1, y: 0 }, Number.NaN),
    false,
  );
  assert.equal(
    isSessionFlowDrag({ x: 0, y: 0 }, { x: 1, y: 0 }, 0),
    true,
    "custom thresholds are clamped to at least one cell",
  );
});

test("layout bounds scale outward in half-open integer cell coordinates", () => {
  assert.deepEqual(
    scaleSessionFlowBounds(
      { minX: -3, minY: 2, maxX: 11, maxY: 9 },
      75,
    ),
    {
      minX: -3,
      minY: 1,
      maxX: 9,
      maxY: 7,
      width: 12,
      height: 6,
    },
  );
  assert.deepEqual(
    scaleSessionFlowBounds(
      { minX: 10, minY: 8, maxX: 0, maxY: -2 },
      100,
    ),
    {
      minX: 0,
      minY: -2,
      maxX: 10,
      maxY: 8,
      width: 10,
      height: 10,
    },
    "reversed bounds are normalized rather than producing negative spans",
  );
});

test("pan clamping centers small layouts and exposes every edge of large layouts", () => {
  const small = { minX: 10, minY: 5, maxX: 30, maxY: 15 };
  assert.deepEqual(
    clampSessionFlowPan(
      { panX: 999, panY: -999 },
      { width: 40, height: 20 },
      small,
    ),
    { panX: 0, panY: 0 },
  );

  const large = { minX: -10, minY: 0, maxX: 90, maxY: 80 };
  assert.deepEqual(
    clampSessionFlowPan(
      { panX: -999, panY: 999 },
      { width: 40, height: 30 },
      large,
    ),
    { panX: -50, panY: 0 },
  );
  assert.deepEqual(
    clampSessionFlowPan(
      { panX: 999, panY: -999 },
      { width: 40, height: 30 },
      large,
    ),
    { panX: 10, panY: -50 },
  );
});

test("zoom-anchor pan keeps the same layout point under the anchor cell", () => {
  const anchored = zoomAnchorSessionFlowPan({
    pan: { panX: -20, panY: 5 },
    anchor: { x: 10, y: 15 },
    fromZoomPercent: 100,
    toZoomPercent: 150,
  });
  assert.deepEqual(anchored, { panX: -35, panY: 0 });
  assert.equal((10 - -20) / 1, (10 - anchored.panX) / 1.5);
  assert.equal((15 - 5) / 1, (15 - anchored.panY) / 1.5);
});

test("zoom-anchor pan rounds once and clamps against target zoom bounds", () => {
  assert.deepEqual(
    zoomAnchorSessionFlowPan({
      pan: { panX: -61, panY: 0 },
      anchor: { x: 39, y: 0 },
      fromZoomPercent: 100,
      toZoomPercent: 150,
      viewport: { width: 40, height: 20 },
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 10 },
    }),
    { panX: -110, panY: 2 },
  );
  assert.deepEqual(
    zoomAnchorSessionFlowPan({
      pan: { panX: -7, panY: 3 },
      anchor: { x: 11, y: 7 },
      fromZoomPercent: 100,
      toZoomPercent: 75,
    }),
    { panX: -2, panY: 4 },
  );
});

test("fit pan centers actual layout bounds at a fixed zoom", () => {
  assert.deepEqual(
    fitSessionFlowPan(
      { minX: 10, minY: -5, maxX: 30, maxY: 5 },
      { width: 41, height: 21 },
    ),
    { panX: 0, panY: 10 },
  );
  assert.deepEqual(
    fitSessionFlowPan(
      { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      { width: 40, height: 20 },
    ),
    { panX: -30, panY: -15 },
    "oversized bounds are centered while remaining within both pan limits",
  );
});

test("fit view chooses the largest supplied zoom that fits with padding", () => {
  assert.deepEqual(
    fitSessionFlowViewport(
      { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      { width: 80, height: 40 },
      [50, 75, 100, 125, 150],
      2,
    ),
    {
      zoomPercent: 50,
      panX: 15,
      panY: 7,
    },
  );
  assert.deepEqual(
    fitSessionFlowViewport(
      { minX: 0, minY: 0, maxX: 20, maxY: 10 },
      { width: 80, height: 40 },
      [75, Number.NaN, 150, 100, 150],
      1,
    ),
    {
      zoomPercent: 150,
      panX: 25,
      panY: 12,
    },
    "candidate order, duplicates, and invalid entries do not affect the result",
  );
});
