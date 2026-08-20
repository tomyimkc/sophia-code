import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SESSION_FLOW_STATE,
  type SessionFlowNode,
  type SessionFlowState,
} from "./sessionFlow.js";
import {
  projectSessionFlowMiniMap,
  sessionFlowMiniMapCellToNormalized,
  sessionFlowMiniMapLocalCellToNavigation,
  sessionFlowMiniMapNavigationAtCell,
  sessionFlowMiniMapNormalizedToWorld,
  sessionFlowMiniMapTextSummary,
  sessionFlowWorldRectToMiniMap,
} from "./sessionFlowMiniMap.js";

function node(
  id: string,
  sequence: number,
  over: Partial<SessionFlowNode> = {},
): SessionFlowNode {
  return {
    id,
    runId: "run-1",
    parentId: sequence === 1 ? null : "run",
    kind: sequence === 1 ? "run" : "tool",
    status: sequence === 3 ? "running" : "succeeded",
    label: id,
    detail: "",
    eventType: sequence === 1 ? "run_start" : "tool_result",
    sequence,
    depth: sequence === 1 ? 0 : 1,
    timestamp: `2026-08-14T00:00:0${sequence}Z`,
    scope: "run-1:main",
    ...over,
  };
}

function state(): SessionFlowState {
  const nodes = [
    node("run", 1),
    node("prepare", 2),
    node("live", 3),
    node("latest", 4, { status: "succeeded", kind: "result" }),
  ];
  return {
    ...EMPTY_SESSION_FLOW_STATE,
    nodes,
    edges: [
      { id: "e1", source: "run", target: "prepare", kind: "sequence" },
      { id: "e2", source: "prepare", target: "live", kind: "sequence" },
      { id: "e3", source: "live", target: "latest", kind: "handoff" },
    ],
    activeRunId: "run-1",
    eventCount: nodes.length,
    nextSequence: nodes.length + 1,
    lastNodeByScope: { "run-1:main": "latest" },
    containerByScope: {},
    runNodeById: { "run-1": "run" },
    nodeDepthById: Object.fromEntries(nodes.map((item) => [item.id, item.depth])),
  };
}

test("projects every node into fixed left-to-right progress cells independently of enlarged layout scale", () => {
  const graph = state();
  const first = projectSessionFlowMiniMap(graph, {
    width: 20,
    height: 5,
    selectedNodeId: "prepare",
    layoutBounds: { minX: 0, minY: 0, maxX: 100, maxY: 40 },
    viewportWorldBounds: { minX: 10, minY: 5, maxX: 40, maxY: 20 },
  });
  const enlarged = projectSessionFlowMiniMap(graph, {
    width: 20,
    height: 5,
    selectedNodeId: "prepare",
    layoutBounds: { minX: -500, minY: -200, maxX: 2500, maxY: 1800 },
    viewportWorldBounds: { minX: 0, minY: 0, maxX: 900, maxY: 800 },
  });

  assert.equal(first.nodes.length, graph.nodes.length);
  assert.ok(
    first.edges.length >= graph.edges.length,
    "explicit links remain visible alongside non-duplicate structural parent links",
  );
  assert.equal(
    new Set(first.edges.map((edge) => `${edge.source}:${edge.target}`)).size,
    first.edges.length,
    "simplified minimap edges collapse duplicate endpoint pairs",
  );
  assert.deepEqual(
    first.nodes.map(({ id, x, y }) => ({ id, x, y })),
    enlarged.nodes.map(({ id, x, y }) => ({ id, x, y })),
  );
  assert.ok(
    first.nodes.every(
      (item) =>
        item.x >= 0 &&
        item.x < first.width &&
        item.y >= 0 &&
        item.y < first.height,
    ),
  );
  assert.ok(first.edges.every((edge) => edge.points.length >= 2));
  assert.ok(first.edges.every((edge) => edge.labels.length >= 1));
  assert.ok(
    first.edges.every(
      (edge) => edge.tone !== "edge" && edge.tone !== "edge-dim",
    ),
    "minimap links carry semantic non-gray tones",
  );
  assert.deepEqual(
    first.nodes.map((item) => item.x),
    [...first.nodes.map((item) => item.x)].sort((a, b) => a - b),
    "observed milestones never reverse direction in the progress map",
  );
  assert.deepEqual(first.progress, {
    total: 4,
    settled: 3,
    succeeded: 3,
    running: 1,
    adverse: 0,
    pending: 0,
    percentage: 75,
  });
});

test("minimap preserves relation metadata while painting chronological progress lanes", () => {
  const projection = projectSessionFlowMiniMap(state(), {
    width: 40,
    height: 7,
  });
  const tones = new Set(projection.edges.map((edge) => edge.tone));
  const relations = new Set(projection.edges.map((edge) => edge.relation));
  const paintedEdgeTones = new Set(
    projection.cells
      .flat()
      .map((cell) => cell.tone)
      .filter((tone) => typeof tone === "string" && tone.startsWith("edge-")),
  );

  assert.ok(relations.has("structure"));
  assert.ok(relations.has("sequence") || relations.has("handoff"));
  assert.ok(tones.has("edge-structure"));
  assert.ok(tones.has("edge-live") || tones.has("edge-success"));
  assert.ok(paintedEdgeTones.size > 0);
  assert.ok(
    projection.edges
      .filter((edge) => edge.relation === "structure")
      .every((edge) => !edge.arrow && edge.lineStyle === "dotted"),
  );
});

test("keeps selected, active, and latest markers distinct without relying on color", () => {
  const projection = projectSessionFlowMiniMap(state(), {
    width: 20,
    height: 5,
    selectedNodeId: "prepare",
  });
  const selected = projection.nodes.find((item) => item.id === "prepare")!;
  const active = projection.nodes.find((item) => item.id === "latest")!;

  assert.equal(projection.selectedNodeId, "prepare");
  assert.equal(projection.activeNodeId, "latest");
  assert.equal(projection.latestNodeId, "latest");
  assert.equal(projection.cells[selected.y]![selected.x]!.glyph, "◆");
  assert.equal(projection.cells[active.y]![active.x]!.glyph, "●");
  assert.equal(projection.cells[selected.y]![selected.x]!.tone, "selected");
  assert.equal(projection.cells[active.y]![active.x]!.tone, "success");

  const graph = state();
  graph.activeRunId = "";
  const latestOnly = projectSessionFlowMiniMap(graph, {
    width: 20,
    height: 5,
  });
  const latest = latestOnly.nodes.find((item) => item.id === "latest")!;
  assert.equal(latestOnly.cells[latest.y]![latest.x]!.glyph, "●");
  assert.equal(latestOnly.cells[latest.y]![latest.x]!.tone, "success");
});

test("an unobserved causal output stays rightmost without stealing live markers", () => {
  const graph = state();
  graph.nodes = graph.nodes.map((item) =>
    item.id === "live"
      ? { ...item, observedSequence: item.sequence }
      : item.id === "latest"
        ? { ...item, status: "pending", observedSequence: null }
        : item
  );
  const projection = projectSessionFlowMiniMap(graph, {
    width: 20,
    height: 5,
  });

  assert.equal(projection.nodes.at(-1)?.id, "latest");
  assert.equal(projection.activeNodeId, "live");
  assert.equal(projection.latestNodeId, "live");
  assert.equal(projection.nodes.find((item) => item.id === "live")?.active, true);
  assert.equal(
    projection.nodes.find((item) => item.id === "latest")?.active,
    false,
  );
});

test("draws a clamped viewport range below the simplified progress lanes", () => {
  const projection = projectSessionFlowMiniMap(state(), {
    width: 11,
    height: 5,
    selectedNodeId: "prepare",
    layoutBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    viewportWorldBounds: { minX: 20, minY: 25, maxX: 60, maxY: 75 },
  });

  assert.deepEqual(projection.viewportRect, {
    left: 2,
    top: 4,
    right: 6,
    bottom: 4,
    width: 5,
    height: 1,
  });
  assert.match(projection.lines[4]!, /\[━+\]/);
  const selected = projection.nodes.find((item) => item.id === "prepare")!;
  assert.equal(projection.cells[selected.y]![selected.x]!.glyph, "◆");

  assert.equal(
    sessionFlowWorldRectToMiniMap(
      { minX: 200, minY: 200, maxX: 220, maxY: 220 },
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      11,
      5,
    ),
    null,
  );
});

test("maps minimap clicks to normalized and enlarged world coordinates", () => {
  assert.deepEqual(sessionFlowMiniMapCellToNormalized(5, 2, 11, 5), {
    x: 0.5,
    y: 0.5,
  });
  assert.deepEqual(
    sessionFlowMiniMapNormalizedToWorld(
      { x: 0.5, y: 0.25 },
      { minX: -20, minY: 100, maxX: 180, maxY: 300 },
    ),
    { x: 80, y: 150 },
  );
  assert.deepEqual(
    sessionFlowMiniMapLocalCellToNavigation(
      5,
      2,
      11,
      5,
      { minX: -20, minY: 100, maxX: 180, maxY: 300 },
    ),
    {
      cell: { x: 5, y: 2 },
      normalized: { x: 0.5, y: 0.5 },
      world: { x: 80, y: 200 },
    },
  );
  assert.equal(
    sessionFlowMiniMapLocalCellToNavigation(11, 2, 11, 5),
    null,
  );

  const projection = projectSessionFlowMiniMap(state(), {
    width: 11,
    height: 5,
    selectedNodeId: "prepare",
  });
  const selected = projection.nodes.find((item) => item.id === "prepare")!;
  const target = sessionFlowMiniMapNavigationAtCell(
    projection,
    selected.x,
    selected.y,
    { minX: -20, minY: 100, maxX: 180, maxY: 300 },
  );
  assert.equal(target?.nodeId, "prepare");
  assert.deepEqual(target?.cell, { x: selected.x, y: selected.y });
  assert.ok(target && target.normalized.x >= 0 && target.normalized.x <= 1);
  assert.ok(target && target.world && target.world.x >= -20 && target.world.x <= 180);
  assert.equal(sessionFlowMiniMapNavigationAtCell(projection, -1, 0), null);
});

test("retains all colliding node ids and prioritizes the selected hit target", () => {
  const projection = projectSessionFlowMiniMap(state(), {
    width: 1,
    height: 1,
    selectedNodeId: "prepare",
  });

  assert.equal(projection.nodes.length, 4);
  assert.deepEqual(
    new Set(projection.nodeIdsByCell[0]![0]),
    new Set(["run", "prepare", "live", "latest"]),
  );
  assert.equal(projection.hitMap[0]![0], "prepare");
  assert.equal(projection.lines[0], "◆");
});

test("provides a flat whole-graph summary for screen-reader rendering", () => {
  const projection = projectSessionFlowMiniMap(state(), {
    width: 11,
    height: 5,
    selectedNodeId: "prepare",
  });
  const summary = sessionFlowMiniMapTextSummary(projection);

  assert.match(summary, /Whole session graph: 4 nodes/);
  assert.match(summary, /75% settled/);
  assert.match(summary, /3 of 4 observed milestones terminal/);
  assert.match(summary, /selected prepare \(prepare\)/);
  assert.match(summary, /active latest \(latest\)/);
  assert.match(summary, /viewport not shown/);
  assert.ok(!/[┌┐└┘─│]/.test(summary));
});

test("screen-reader summary can name the exact projected hierarchy", () => {
  const projection = projectSessionFlowMiniMap(state(), {
    width: 11,
    height: 5,
  });

  assert.match(
    sessionFlowMiniMapTextSummary(
      projection,
      "Current hierarchy · Workflow / Stage 2",
    ),
    /^Current hierarchy · Workflow \/ Stage 2: 4 nodes/,
  );
});
