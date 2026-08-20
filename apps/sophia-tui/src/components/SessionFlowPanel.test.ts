import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionFlowDrawioGeometry,
  sessionFlowDrawioProjection,
  sessionFlowNodeAtScreen,
  sessionFlowSceneForLayout,
  resolvedSessionFlowPan,
  type SessionFlowPanelLayoutReport,
} from "./SessionFlowPanel.js";
import {
  EMPTY_SESSION_FLOW_STATE,
  sessionFlowToDrawioXml,
  sessionFlowReducer,
  type SessionFlowState,
} from "../lib/sessionFlow.js";
import { layoutSessionFlow } from "../lib/sessionFlowLayout.js";
import { renderTerminalGraphCanvas } from "../lib/terminalGraphCanvas.js";
import {
  createSessionFlowInteractionState,
  sessionFlowInteractionReducer,
} from "../lib/sessionFlowInteraction.js";
import { fitSessionFlowLayout } from "../lib/sessionFlowNavigation.js";

function fold(events: Array<Record<string, unknown>>): SessionFlowState {
  return events.reduce(
    (state, event) =>
      sessionFlowReducer(state, { type: "event", event }),
    EMPTY_SESSION_FLOW_STATE,
  );
}

test("screen hit testing translates absolute terminal coordinates", () => {
  const layout = layoutSessionFlow(EMPTY_SESSION_FLOW_STATE);
  const canvas = renderTerminalGraphCanvas(
    {
      blocks: [
        {
          id: "block-1",
          x: 0,
          y: 0,
          width: 6,
          height: 3,
          title: "Block",
        },
      ],
      edges: [],
    },
    { width: 8, height: 4 },
  );
  const report: SessionFlowPanelLayoutReport = {
    state: EMPTY_SESSION_FLOW_STATE,
    metadataByNodeId: {},
    projectionKey: "overview:root",
    hierarchyLevel: "overview",
    hierarchyPath: [],
    focusNodeId: null,
    layout,
    canvas,
    selectedNodeId: "block-1",
    canvasScreenLeft: 3,
    canvasScreenTop: 7,
    viewportWidth: 8,
    viewportHeight: 4,
    panX: 0,
    panY: 0,
    zoomLevel: "normal",
    viewportWorldBounds: { minX: 0, minY: 0, maxX: 8, maxY: 4 },
  };

  assert.equal(sessionFlowNodeAtScreen(report, 3, 7), "block-1");
  assert.equal(sessionFlowNodeAtScreen(report, 8, 9), "block-1");
  assert.equal(sessionFlowNodeAtScreen(report, 2, 7), null);
  assert.equal(sessionFlowNodeAtScreen(report, 3, 11), null);
});

test("fit pan survives renderer clamping for small and oversized layouts", () => {
  const graph = fold([
    { type: "run_start", runId: "run-fit" },
    {
      type: "a2a_chain_start",
      runId: "run-fit",
      chainId: "chain-fit",
    },
    {
      type: "a2a_agent_start",
      runId: "run-fit",
      chainId: "chain-fit",
      agent: "reviewer",
      index: 0,
    },
    { type: "result", runId: "run-fit", ok: true },
  ]);
  const base = createSessionFlowInteractionState();

  for (const viewport of [
    { width: 160, height: 50 },
    { width: 24, height: 8 },
  ]) {
    const fit = fitSessionFlowLayout(graph, base, viewport, 1);
    const positioned = sessionFlowInteractionReducer(base, {
      type: "set_pan",
      panX: fit.panX,
      panY: fit.panY,
    });
    const manual = sessionFlowInteractionReducer(positioned, {
      type: "pan",
      dx: 0,
      dy: 0,
      activeNodeId: fit.layout.activeNodeId,
      latestNodeId: fit.layout.latestNodeId,
    });
    assert.deepEqual(
      resolvedSessionFlowPan(
        fit.layout,
        viewport.width,
        viewport.height,
        manual,
        fit.layout.latestNodeId,
      ),
      { panX: fit.panX, panY: fit.panY },
    );
  }
});

test("Draw.io geometry preserves the live layout topology and edge routes", () => {
  const state = fold([
    { type: "run_start", runId: "run-drawio" },
    {
      type: "a2a_chain_start",
      runId: "run-drawio",
      chainId: "chain-1",
    },
    {
      type: "a2a_agent_start",
      runId: "run-drawio",
      chainId: "chain-1",
      agent: "reviewer",
      index: 0,
    },
    { type: "result", runId: "run-drawio", ok: true },
  ]);
  const layout = layoutSessionFlow(state, {
    detailLevel: "detailed",
    nodeWidth: 20,
    nodeHeight: 5,
  });
  const geometry = sessionFlowDrawioGeometry(layout);
  assert.ok(Array.isArray(geometry.nodeGeometry));
  assert.ok(Array.isArray(geometry.edgeRoutes));

  const nodeGeometry = geometry.nodeGeometry as Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  const edgeRoutes = geometry.edgeRoutes as Array<{
    id: string;
    label?: string;
    waypoints?: Array<{ x: number; y: number }>;
    style?: {
      endArrow?: string;
      dashed?: boolean;
      dashPattern?: string;
      statusColor?: string;
    };
  }>;
  assert.equal(nodeGeometry.length, layout.nodes.length);
  assert.equal(nodeGeometry[0]?.width, layout.nodes[0]!.width * 12);
  assert.equal(nodeGeometry[0]?.height, layout.nodes[0]!.height * 18);
  assert.ok(edgeRoutes.length > 0);
  assert.ok(edgeRoutes.every((edge) => (edge.waypoints?.length ?? 0) >= 2));
  assert.ok(edgeRoutes.every((edge) => Boolean(edge.label)));
  assert.ok(
    edgeRoutes.every(
      (edge) =>
        edge.style?.statusColor &&
        edge.style.statusColor.toLowerCase() !== "#666666",
    ),
  );
  const contains = layout.edges.find((edge) => edge.kind === "contains");
  assert.ok(contains);
  const containsRoute = edgeRoutes.find((edge) => edge.id === contains.id);
  assert.equal(containsRoute?.label, "contains");
  assert.equal(containsRoute?.style?.endArrow, "none");
  assert.equal(containsRoute?.style?.dashed, true);
  assert.equal(containsRoute?.style?.dashPattern, "1 4");
  assert.equal(containsRoute?.style?.statusColor, "#00838f");
});

test("terminal scene gives every visible link a relation label and progress tone", () => {
  const state = fold([
    { type: "run_start", runId: "run-scene" },
    {
      type: "a2a_chain_start",
      runId: "run-scene",
      chainId: "chain-scene",
    },
    {
      type: "a2a_agent_start",
      runId: "run-scene",
      chainId: "chain-scene",
      agent: "reviewer",
      index: 0,
    },
  ]);
  const layout = layoutSessionFlow(state, { detailLevel: "detailed" });
  const scene = sessionFlowSceneForLayout(layout, null, "normal", {});
  const sceneEdgeById = new Map(scene.edges.map((edge) => [edge.id, edge]));

  assert.equal(scene.edges.length, layout.edges.length);
  assert.ok(
    scene.edges.every(
      (edge) =>
        Boolean(edge.label) &&
        edge.tone !== "edge" &&
        edge.tone !== "edge-dim",
    ),
  );
  for (const edge of layout.edges.filter((item) => item.kind === "contains")) {
    const rendered = sceneEdgeById.get(edge.id);
    assert.equal(rendered?.label, "contains");
    assert.equal(rendered?.tone, "edge-structure");
    assert.equal(rendered?.kind, "dotted");
    assert.equal(rendered?.arrow, false);
  }
});

test("terminal scene makes the transparent process frame and its children selectable", () => {
  const state = fold([
    { type: "run_start", runId: "run-process-frame" },
    {
      type: "workflow_plan_frozen",
      eventId: "plan",
      runId: "run-process-frame",
      workflowEventVersion: 1,
      workflowEventSequence: 0,
      schema: "sophia.compound-workflow-plan.v1",
      planDigest: "f".repeat(64),
      outputProcessId: "review",
      processes: [
        { processId: "review", processLabel: "Review process", branchId: "branch-a", childWorkflowIds: ["inspect", "verify"], dependsOnNodeIds: [] },
      ],
      joins: [],
    },
  ]);
  const layout = layoutSessionFlow(state, { detailLevel: "detailed" });
  const scene = sessionFlowSceneForLayout(layout, null, "normal", {});
  const canvas = renderTerminalGraphCanvas(scene, {
    width: layout.bounds.maxX + 2,
    height: layout.bounds.maxY + 2,
  });

  assert.equal(scene.frames?.length, 1);
  assert.equal(scene.frames?.[0]?.id, layout.processFrames[0]?.id);
  assert.match(scene.frames?.[0]?.label || "", /Review process · branch-a/);
  const frame = layout.processFrames[0]!;
  assert.equal(canvas.hitMap[frame.y]?.[frame.x], frame.processNodeId);
  assert.equal(
    scene.blocks.some((block) => block.id === frame.processNodeId),
    false,
    "the expanded semantic parent is represented by its frame, not an opaque block",
  );
  for (const memberId of frame.memberNodeIds) {
    assert.ok(canvas.hitMap.flat().includes(memberId));
  }

  const selectedScene = sessionFlowSceneForLayout(
    layout,
    frame.processNodeId,
    "normal",
    {},
  );
  assert.equal(selectedScene.frames?.[0]?.selected, true);

  const collapsed = layoutSessionFlow(state, {
    detailLevel: "detailed",
    collapsedIds: [frame.processNodeId],
  });
  const collapsedScene = sessionFlowSceneForLayout(
    collapsed,
    frame.processNodeId,
    "normal",
    {},
  );
  assert.equal(collapsedScene.frames?.length, 0);
  assert.ok(
    collapsedScene.blocks.some(
      (block) => block.id === frame.processNodeId && block.selected,
    ),
    "a collapsed process is one ordinary selectable block",
  );
});

test("Draw.io exports expanded process frames as collapsible transparent groups", () => {
  const state = fold([
    { type: "run_start", runId: "run-group-export" },
    {
      type: "workflow_plan_frozen",
      eventId: "plan",
      runId: "run-group-export",
      workflowEventVersion: 1,
      workflowEventSequence: 0,
      schema: "sophia.compound-workflow-plan.v1",
      planDigest: "f".repeat(64),
      outputProcessId: "review",
      processes: [
        { processId: "review", processLabel: "Review", branchId: "main", childWorkflowIds: ["inspect", "verify"], dependsOnNodeIds: [] },
      ],
      joins: [],
    },
    {
      type: "workflow_process_end",
      eventId: "end",
      runId: "run-group-export",
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      processId: "review",
      processLabel: "Review",
      branchId: "main",
      childWorkflowIds: ["inspect", "verify"],
      dependsOnNodeIds: [],
      state: "succeeded",
    },
    {
      type: "workflow_output_committed",
      eventId: "output",
      runId: "run-group-export",
      workflowEventVersion: 1,
      workflowEventSequence: 2,
      processId: "review",
      artifactRef: "final.json",
      digest: "a".repeat(64),
    },
  ]);
  const layout = layoutSessionFlow(state, { detailLevel: "detailed" });
  const geometry = sessionFlowDrawioGeometry(layout);
  const projected = sessionFlowDrawioProjection(state, layout);
  const frame = layout.processFrames[0]!;
  const group = geometry.processGroups[0]!;
  const processIndex = projected.nodes.findIndex(
    (node) => node.id === frame.processNodeId,
  );
  const member = layout.nodes.find(
    (item) => item.id === frame.memberNodeIds[0],
  )!;
  const memberIndex = projected.nodes.findIndex(
    (node) => node.id === member.id,
  );
  const processCell = `n${processIndex + 2}`;
  const memberCell = `n${memberIndex + 2}`;
  const xml = sessionFlowToDrawioXml(projected, {
    generatedAt: "2026-08-16T00:00:00.000Z",
    ...geometry,
  });

  assert.equal(group.processNodeId, frame.processNodeId);
  assert.deepEqual(group.memberNodeIds, frame.memberNodeIds);
  assert.equal(group.x, frame.x * 12);
  assert.equal(group.width, frame.width * 12);
  assert.match(
    xml,
    new RegExp(
      `<mxCell id="${processCell}"[^>]*style="[^"]*container=1;[^"]*collapsible=1;[^"]*fillColor=none`,
    ),
  );
  assert.match(
    xml,
    new RegExp(`<mxCell id="${memberCell}"[^>]*parent="${processCell}"`),
  );
  assert.match(
    xml,
    new RegExp(
      `<mxGeometry x="${(member.x - frame.x) * 12}" y="${(member.y - frame.y) * 18}"`,
    ),
  );
  assert.match(
    xml,
    new RegExp(`edge="1" parent="1" source="${processCell}"`),
    "external output edge attaches to the process group",
  );
});

test("Draw.io projection exports only the currently visible folded graph", () => {
  const state = fold([
    { type: "run_start", runId: "run-folded-export" },
    {
      type: "model_result",
      runId: "run-folded-export",
      model: "deepseek-chat",
      ok: true,
    },
    {
      type: "tool_call",
      runId: "run-folded-export",
      tool: "read_file",
    },
    {
      type: "result",
      runId: "run-folded-export",
      ok: true,
    },
  ]);
  const layout = layoutSessionFlow(state, { detailLevel: "overview" });
  const projected = sessionFlowDrawioProjection(state, layout);
  const visibleIds = new Set(layout.nodes.map((node) => node.id));

  assert.ok(layout.hiddenNodeIds.length > 0);
  assert.deepEqual(
    projected.nodes.map((node) => node.id),
    layout.nodes.map((node) => node.id),
  );
  assert.deepEqual(
    projected.edges.map((edge) => edge.id),
    layout.edges.map((edge) => edge.id),
  );
  assert.ok(
    projected.edges.every(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    ),
  );

  const geometry = sessionFlowDrawioGeometry(layout);
  const routeIds = new Set(
    (geometry.edgeRoutes as Array<{ id: string }>).map((edge) => edge.id),
  );
  assert.deepEqual(
    routeIds,
    new Set(projected.edges.map((edge) => edge.id)),
  );
});
