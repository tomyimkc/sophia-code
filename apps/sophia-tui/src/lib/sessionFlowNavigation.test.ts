import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SESSION_FLOW_STATE,
  sessionFlowReducer,
  type SessionFlowState,
} from "./sessionFlow.js";
import {
  createSessionFlowInteractionState,
} from "./sessionFlowInteraction.js";
import {
  anchorSessionFlowPanAcrossLayouts,
  centerSessionFlowWorldPoint,
  fitSessionFlowLayout,
  layoutSessionFlowForInteraction,
  resolveSessionFlowMiniMapNavigation,
  sessionFlowViewportWorldBounds,
} from "./sessionFlowNavigation.js";

function state(): SessionFlowState {
  return [
    { type: "run_start", runId: "run-nav" },
    {
      type: "a2a_chain_start",
      runId: "run-nav",
      chainId: "chain-nav",
    },
    {
      type: "a2a_agent_start",
      runId: "run-nav",
      chainId: "chain-nav",
      agent: "reviewer",
      index: 0,
    },
    {
      type: "model_result",
      runId: "run-nav",
      model: "deepseek-chat",
      ok: true,
    },
    {
      type: "tool_call",
      runId: "run-nav",
      tool: "read_file",
    },
    { type: "result", runId: "run-nav", ok: true },
  ].reduce(
    (current, event) =>
      sessionFlowReducer(current, { type: "event", event }),
    EMPTY_SESSION_FLOW_STATE,
  );
}

test("builds interaction layouts from semantic zoom presets", () => {
  const interaction = createSessionFlowInteractionState();
  const normal = layoutSessionFlowForInteraction(state(), interaction);
  const inspect = layoutSessionFlowForInteraction(state(), interaction, {
    zoomLevel: "inspect",
  });

  assert.equal(normal.nodes[0]?.width, 24);
  assert.equal(normal.nodes[0]?.height, 5);
  assert.equal(inspect.nodes[0]?.width, 40);
  assert.equal(inspect.nodes[0]?.height, 9);
});

test("preserves a selected block point while semantic zoom changes geometry", () => {
  const graph = state();
  const interaction = createSessionFlowInteractionState();
  const sourceLayout = layoutSessionFlowForInteraction(graph, interaction);
  const targetLayout = layoutSessionFlowForInteraction(graph, interaction, {
    zoomLevel: "inspect",
  });
  const sourceNode = sourceLayout.nodes[1]!;
  const targetNode = targetLayout.nodes.find((node) => node.id === sourceNode.id)!;
  const sourcePan = { panX: -10, panY: 2 };
  const anchorCell = {
    x: sourceNode.x + Math.floor(sourceNode.width / 2) + sourcePan.panX,
    y: sourceNode.y + Math.floor(sourceNode.height / 2) + sourcePan.panY,
  };
  const pan = anchorSessionFlowPanAcrossLayouts({
    sourceLayout,
    targetLayout,
    sourcePan,
    viewport: { width: 80, height: 24 },
    anchorCell,
    anchorNodeId: sourceNode.id,
  });

  assert.equal(
    Math.round(targetNode.x + targetNode.width / 2 + pan.panX),
    anchorCell.x,
  );
  assert.equal(
    Math.round(targetNode.y + targetNode.height / 2 + pan.panY),
    anchorCell.y,
  );
});

test("empty-space semantic zoom preserves normalized graph position", () => {
  const graph = state();
  const interaction = createSessionFlowInteractionState();
  const sourceLayout = layoutSessionFlowForInteraction(graph, interaction);
  const targetLayout = layoutSessionFlowForInteraction(graph, interaction, {
    zoomLevel: "detail",
  });
  const viewport = { width: 20, height: 8 };
  const anchorCell = { x: 10, y: 4 };
  const sourcePan = { panX: -10, panY: -2 };
  const sourceWorld = {
    x: anchorCell.x - sourcePan.panX,
    y: anchorCell.y - sourcePan.panY,
  };
  const normalized = {
    x:
      (sourceWorld.x - sourceLayout.bounds.minX) /
      sourceLayout.bounds.width,
    y:
      (sourceWorld.y - sourceLayout.bounds.minY) /
      sourceLayout.bounds.height,
  };
  const pan = anchorSessionFlowPanAcrossLayouts({
    sourceLayout,
    targetLayout,
    sourcePan,
    viewport,
    anchorCell,
    anchorNodeId: null,
  });
  const targetWorld = {
    x: anchorCell.x - pan.panX,
    y: anchorCell.y - pan.panY,
  };

  assert.ok(
    Math.abs(
      (targetWorld.x - targetLayout.bounds.minX) /
        targetLayout.bounds.width -
        normalized.x,
    ) <= 0.03,
  );
  assert.ok(
    Math.abs(
      (targetWorld.y - targetLayout.bounds.minY) /
        targetLayout.bounds.height -
        normalized.y,
    ) <= 0.03,
  );
});

test("minimap markers center visible block geometry and reject hidden blocks", () => {
  const graph = state();
  const interaction = createSessionFlowInteractionState();
  const overview = layoutSessionFlowForInteraction(graph, interaction);
  const visible = overview.nodes[0]!;
  const visibleTarget = resolveSessionFlowMiniMapNavigation(
    {
      nodeId: visible.id,
      // Deliberately unrelated: marker collision displacement must not control
      // where a visible block is centered.
      world: { x: overview.bounds.maxX, y: overview.bounds.maxY },
    },
    { width: 80, height: 24 },
    overview,
  );
  assert.equal(visibleTarget.selectedNodeId, visible.id);
  assert.equal(visibleTarget.hiddenNodeId, null);
  assert.deepEqual(
    visibleTarget.pan,
    centerSessionFlowWorldPoint(
      {
        x: visible.x + visible.width / 2,
        y: visible.y + visible.height / 2,
      },
      { width: 80, height: 24 },
      overview,
    ),
  );

  const hiddenId = overview.hiddenNodeIds[0];
  assert.ok(hiddenId, "overview fixture should hide at least one detail block");
  assert.deepEqual(
    resolveSessionFlowMiniMapNavigation(
      {
        nodeId: hiddenId!,
        world: { x: overview.bounds.minX, y: overview.bounds.minY },
      },
      { width: 80, height: 24 },
      overview,
    ),
    {
      selectedNodeId: null,
      hiddenNodeId: hiddenId,
      pan: null,
    },
  );
});

test("maps viewport cells to world bounds and recenters a minimap target", () => {
  const graph = state();
  const interaction = createSessionFlowInteractionState();
  const layout = layoutSessionFlowForInteraction(graph, interaction);
  assert.deepEqual(
    sessionFlowViewportWorldBounds(
      { panX: -20, panY: 3 },
      { width: 60, height: 20 },
    ),
    { minX: 20, minY: -3, maxX: 80, maxY: 17 },
  );
  const centered = centerSessionFlowWorldPoint(
    {
      x: (layout.bounds.minX + layout.bounds.maxX) / 2,
      y: (layout.bounds.minY + layout.bounds.maxY) / 2,
    },
    { width: 80, height: 24 },
    layout,
  );
  assert.ok(Number.isInteger(centered.panX));
  assert.ok(Number.isInteger(centered.panY));
});

test("fit chooses the largest actual layout that fits", () => {
  const interaction = createSessionFlowInteractionState();
  const fit = fitSessionFlowLayout(
    state(),
    interaction,
    { width: 130, height: 40 },
    1,
  );
  assert.ok(["normal", "detail", "inspect"].includes(fit.zoomLevel));
  assert.ok(fit.layout.bounds.width <= 128);
  assert.ok(fit.layout.bounds.height <= 38);
});
