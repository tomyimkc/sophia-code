import test from "node:test";
import assert from "node:assert/strict";
import type { SessionFlowNode, SessionFlowState } from "./sessionFlow.js";
import { layoutSessionFlow } from "./sessionFlowLayout.js";
import {
  SESSION_FLOW_ZOOM_LEVELS,
  SESSION_FLOW_ZOOM_PERCENTAGES,
  SESSION_FLOW_ZOOM_PRESETS,
  getSessionFlowZoomPreset,
  nextSessionFlowZoomLevel,
  previousSessionFlowZoomLevel,
  sessionFlowLayoutOptionsForZoom,
  sessionFlowZoomLevelAt,
  type SessionFlowZoomLevel,
  type SessionFlowZoomPreset,
} from "./sessionFlowZoom.js";

function node(
  id: string,
  sequence: number,
  kind: SessionFlowNode["kind"],
  parentId: string | null,
): SessionFlowNode {
  return {
    id,
    runId: "run-1",
    parentId,
    kind,
    status: "succeeded",
    label: id,
    detail: "",
    eventType: kind,
    sequence,
    depth: parentId ? 1 : 0,
    timestamp: `2026-08-14T00:00:0${sequence}.000Z`,
    scope: "run-1:main",
  };
}

function flowState(): SessionFlowState {
  const nodes = [
    node("run", 1, "run", null),
    node("model", 2, "model", "run"),
  ];
  return {
    schemaVersion: 1,
    candidateOnly: true,
    canClaimAGI: false,
    nodes,
    edges: [
      {
        id: "contains:run:model",
        kind: "contains",
        source: "run",
        target: "model",
      },
    ],
    activeRunId: "run-1",
    eventCount: nodes.length,
    nextSequence: nodes.length + 1,
    lastNodeByScope: {},
    containerByScope: {},
    runNodeById: { "run-1": "run" },
    nodeDepthById: { run: 0, model: 1 },
    seenEventIds: {},
  };
}

test("orders semantic zoom levels and assigns the specified percentages", () => {
  assert.deepEqual(SESSION_FLOW_ZOOM_LEVELS, [
    "map",
    "compact",
    "normal",
    "detail",
    "inspect",
  ]);
  assert.deepEqual(
    SESSION_FLOW_ZOOM_LEVELS.map(
      (level) => SESSION_FLOW_ZOOM_PERCENTAGES[level],
    ),
    [50, 75, 100, 125, 150],
  );
});

test("next and previous zoom helpers clamp at both ends", () => {
  assert.equal(nextSessionFlowZoomLevel("map"), "compact");
  assert.equal(nextSessionFlowZoomLevel("normal"), "detail");
  assert.equal(nextSessionFlowZoomLevel("inspect"), "inspect");
  assert.equal(nextSessionFlowZoomLevel("detail", 20), "inspect");

  assert.equal(previousSessionFlowZoomLevel("inspect"), "detail");
  assert.equal(previousSessionFlowZoomLevel("normal"), "compact");
  assert.equal(previousSessionFlowZoomLevel("map"), "map");
  assert.equal(previousSessionFlowZoomLevel("compact", 20), "map");

  assert.equal(sessionFlowZoomLevelAt(-100), "map");
  assert.equal(sessionFlowZoomLevelAt(100), "inspect");
});

test("presets are deterministic and normal matches the current 24x5 layout", () => {
  assert.equal(getSessionFlowZoomPreset("normal"), SESSION_FLOW_ZOOM_PRESETS.normal);
  assert.deepEqual(SESSION_FLOW_ZOOM_PRESETS.normal, {
    level: "normal",
    percentage: 100,
    nodeWidth: 24,
    nodeHeight: 5,
    horizontalGap: 8,
    verticalGap: 3,
    padding: 1,
    labelDensity: "normal",
    renderDensity: "normal",
  });

  assert.deepEqual(
    {
      nodeWidth: SESSION_FLOW_ZOOM_PRESETS.map.nodeWidth,
      nodeHeight: SESSION_FLOW_ZOOM_PRESETS.map.nodeHeight,
      horizontalGap: SESSION_FLOW_ZOOM_PRESETS.map.horizontalGap,
      verticalGap: SESSION_FLOW_ZOOM_PRESETS.map.verticalGap,
      padding: SESSION_FLOW_ZOOM_PRESETS.map.padding,
    },
    {
      nodeWidth: 8,
      nodeHeight: 3,
      horizontalGap: 2,
      verticalGap: 1,
      padding: 0,
    },
  );
});

test("preset geometry grows monotonically from map through inspect", () => {
  let previous: SessionFlowZoomPreset = SESSION_FLOW_ZOOM_PRESETS.map;
  for (const level of SESSION_FLOW_ZOOM_LEVELS.slice(1)) {
    const current = SESSION_FLOW_ZOOM_PRESETS[level];
    assert.ok(current.nodeWidth > previous.nodeWidth);
    assert.ok(current.nodeHeight >= previous.nodeHeight);
    assert.ok(current.horizontalGap >= previous.horizontalGap);
    assert.ok(current.verticalGap >= previous.verticalGap);
    assert.ok(current.padding >= previous.padding);
    previous = current;
  }
  assert.ok(
    SESSION_FLOW_ZOOM_PRESETS.detail.nodeWidth >
      SESSION_FLOW_ZOOM_PRESETS.normal.nodeWidth,
  );
  assert.ok(
    SESSION_FLOW_ZOOM_PRESETS.inspect.nodeHeight >
      SESSION_FLOW_ZOOM_PRESETS.detail.nodeHeight,
  );
});

test("layout dimensions follow each preset while detailLevel remains orthogonal", () => {
  const state = flowState();

  for (const level of SESSION_FLOW_ZOOM_LEVELS) {
    const preset = getSessionFlowZoomPreset(level);
    const options = sessionFlowLayoutOptionsForZoom(level);
    assert.equal("detailLevel" in options, false);

    const overview = layoutSessionFlow(state, {
      ...options,
      detailLevel: "overview",
    });
    const detailed = layoutSessionFlow(state, {
      ...options,
      detailLevel: "detailed",
    });

    assert.equal(overview.nodes.length, 1);
    assert.equal(detailed.nodes.length, 2);
    for (const layout of [overview, detailed]) {
      assert.ok(
        layout.nodes.every(
          (item) =>
            item.width === preset.nodeWidth &&
            item.height === preset.nodeHeight,
        ),
        `${level} uses ${preset.nodeWidth}x${preset.nodeHeight} nodes`,
      );
    }
  }
});

test("every zoom level has complete label and render density metadata", () => {
  const levels = new Set<SessionFlowZoomLevel>(
    Object.keys(SESSION_FLOW_ZOOM_PRESETS) as SessionFlowZoomLevel[],
  );
  assert.deepEqual(levels, new Set(SESSION_FLOW_ZOOM_LEVELS));

  for (const level of SESSION_FLOW_ZOOM_LEVELS) {
    const preset = SESSION_FLOW_ZOOM_PRESETS[level];
    assert.equal(preset.level, level);
    assert.equal(preset.percentage, SESSION_FLOW_ZOOM_PERCENTAGES[level]);
    assert.ok(preset.labelDensity.length > 0);
    assert.ok(preset.renderDensity.length > 0);
  }
});
