import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SESSION_FLOW_INTERACTION,
  centerSessionFlowPan,
  createSessionFlowInteractionState,
  currentHierarchyFocusId,
  firstSessionFlowNodeId,
  lastSessionFlowNodeId,
  nearestSessionFlowNodeId,
  nextSessionFlowDetailLevel,
  previousSessionFlowDetailLevel,
  selectedFlowNodeId,
  sessionFlowInteractionReducer,
  type SessionFlowInteractionState,
  type SessionFlowNodeGeometry,
} from "./sessionFlowInteraction.js";

const layoutNodes: SessionFlowNodeGeometry[] = [
  { id: "a", x: 0, y: 0, width: 20, height: 10 },
  { id: "b", x: 100, y: 0, width: 20, height: 10 },
  { id: "c", x: 0, y: 100, width: 20, height: 10 },
  { id: "d", x: 80, y: 50, width: 20, height: 10 },
];

test("initial interaction state is serializable and independently constructed", () => {
  const first = createSessionFlowInteractionState();
  const second = createSessionFlowInteractionState();
  assert.deepEqual(first, EMPTY_SESSION_FLOW_INTERACTION);
  assert.equal(first.zoomLevel, "normal");
  assert.notEqual(first, second);
  assert.notEqual(first.collapsedIds, second.collapsedIds);
  assert.notEqual(first.expandedIds, second.expandedIds);
  assert.notEqual(first.hierarchyPath, second.hierarchyPath);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

test("follow-live resolves active, latest, and layout-tail focus deterministically", () => {
  assert.equal(
    selectedFlowNodeId(EMPTY_SESSION_FLOW_INTERACTION, layoutNodes, "c", "b"),
    "b",
  );
  assert.equal(
    selectedFlowNodeId(EMPTY_SESSION_FLOW_INTERACTION, layoutNodes, "c"),
    "c",
  );
  assert.equal(
    selectedFlowNodeId(EMPTY_SESSION_FLOW_INTERACTION, layoutNodes),
    "d",
  );

  const manual = {
    ...createSessionFlowInteractionState(),
    selectedNodeId: "c",
    followLive: false,
  };
  assert.equal(selectedFlowNodeId(manual, layoutNodes, "b", "a"), "c");
  assert.equal(
    selectedFlowNodeId({ ...manual, selectedNodeId: "missing" }, layoutNodes),
    "a",
  );
  assert.equal(selectedFlowNodeId(manual, []), null);
});

test("Home and End helpers follow left-to-right geometry with live-node preference", () => {
  const shuffled = [layoutNodes[1], layoutNodes[3], layoutNodes[2], layoutNodes[0]];
  assert.equal(firstSessionFlowNodeId(shuffled), "a");
  assert.equal(lastSessionFlowNodeId(shuffled), "b");
  assert.equal(lastSessionFlowNodeId(shuffled, "c", "d"), "c");
  assert.equal(lastSessionFlowNodeId(shuffled, "missing", "d"), "d");
  assert.equal(firstSessionFlowNodeId([]), null);
  assert.equal(lastSessionFlowNodeId([]), null);
});

test("directional navigation prefers aligned blocks and has stable tie-breakers", () => {
  assert.equal(nearestSessionFlowNodeId("a", "right", layoutNodes), "b");
  assert.equal(nearestSessionFlowNodeId("a", "down", layoutNodes), "c");
  assert.equal(nearestSessionFlowNodeId("c", "up", layoutNodes), "a");
  assert.equal(nearestSessionFlowNodeId("b", "left", layoutNodes), "a");
  assert.equal(
    nearestSessionFlowNodeId("b", "right", layoutNodes),
    "b",
    "no directional candidate retains the current selection",
  );

  const tied: SessionFlowNodeGeometry[] = [
    { id: "origin", x: 0, y: 0, width: 0, height: 0 },
    { id: "z", x: 10, y: -2, width: 0, height: 0 },
    { id: "a", x: 10, y: 2, width: 0, height: 0 },
  ];
  assert.equal(nearestSessionFlowNodeId("origin", "right", tied), "z");
  assert.equal(
    nearestSessionFlowNodeId("origin", "right", [...tied].reverse()),
    "z",
  );
});

test("selection, directional navigation, Home, and End stop follow-live", () => {
  let state = sessionFlowInteractionReducer(
    createSessionFlowInteractionState(),
    { type: "select", nodeId: " a " },
  );
  assert.equal(state.selectedNodeId, "a");
  assert.equal(state.followLive, false);

  state = sessionFlowInteractionReducer(
    { ...state, selectedNodeId: "a" },
    {
      type: "navigate",
      direction: "right",
      nodes: layoutNodes,
    },
  );
  assert.equal(state.selectedNodeId, "b");

  state = sessionFlowInteractionReducer(state, {
    type: "home",
    nodes: layoutNodes,
  });
  assert.equal(state.selectedNodeId, "a");

  state = sessionFlowInteractionReducer(state, {
    type: "end",
    nodes: layoutNodes,
    activeNodeId: "c",
    latestNodeId: "d",
  });
  assert.equal(state.selectedNodeId, "c");
  assert.equal(state.followLive, false);
});

test("pan, set-pan, and center use finite whole-cell coordinates", () => {
  let state = sessionFlowInteractionReducer(
    createSessionFlowInteractionState(),
    {
      type: "pan",
      dx: 8.4,
      dy: -3.2,
      latestNodeId: "d",
    },
  );
  assert.deepEqual(
    {
      selectedNodeId: state.selectedNodeId,
      panX: state.panX,
      panY: state.panY,
      followLive: state.followLive,
    },
    {
      selectedNodeId: "d",
      panX: 8,
      panY: -3,
      followLive: false,
    },
  );

  state = sessionFlowInteractionReducer(state, {
    type: "set_pan",
    panX: 20.7,
    panY: Number.NaN,
  });
  assert.equal(state.panX, 21);
  assert.equal(state.panY, 0);

  const node = { id: "target", x: 100, y: 40, width: 20, height: 10 };
  assert.deepEqual(centerSessionFlowPan(node, { width: 201, height: 101 }), {
    panX: -9,
    panY: 6,
  });
  state = sessionFlowInteractionReducer(state, {
    type: "center",
    node,
    viewport: { width: 200, height: 100 },
  });
  assert.equal(state.panX, -10);
  assert.equal(state.panY, 5);
  assert.equal(
    sessionFlowInteractionReducer(state, {
      type: "center",
      node: null,
      viewport: { width: 20, height: 10 },
    }),
    state,
  );
});

test("follow actions select and optionally center the active node", () => {
  let state: SessionFlowInteractionState = {
    ...createSessionFlowInteractionState(),
    selectedNodeId: "a",
    followLive: false,
  };
  state = sessionFlowInteractionReducer(state, {
    type: "toggle_follow",
    latestNodeId: "d",
  });
  assert.equal(state.followLive, true);
  assert.equal(state.selectedNodeId, "d");

  state = sessionFlowInteractionReducer(state, {
    type: "toggle_follow",
    activeNodeId: "c",
    latestNodeId: "d",
  });
  assert.equal(state.followLive, false);
  assert.equal(state.selectedNodeId, "c");

  state = sessionFlowInteractionReducer(state, {
    type: "follow_active",
    nodeId: "b",
    node: layoutNodes[1],
    viewport: { width: 100, height: 40 },
  });
  assert.deepEqual(
    {
      selectedNodeId: state.selectedNodeId,
      panX: state.panX,
      panY: state.panY,
      followLive: state.followLive,
    },
    {
      selectedNodeId: "b",
      panX: -60,
      panY: 15,
      followLive: true,
    },
  );
});

test("zoom actions use semantic levels without changing navigation ownership", () => {
  let following = createSessionFlowInteractionState();
  following = sessionFlowInteractionReducer(following, { type: "zoom_in" });
  assert.equal(following.zoomLevel, "detail");
  assert.equal(following.followLive, true);
  assert.equal(following.selectedNodeId, null);
  assert.equal(following.panX, 0);
  assert.equal(following.panY, 0);
  assert.equal(following.layoutGeneration, 1);

  following = sessionFlowInteractionReducer(following, {
    type: "set_zoom",
    zoomLevel: "map",
  });
  assert.equal(following.zoomLevel, "map");
  assert.equal(following.followLive, true);
  assert.equal(following.layoutGeneration, 2);
  assert.equal(
    sessionFlowInteractionReducer(following, { type: "zoom_out" }),
    following,
    "zooming past the minimum is a no-op",
  );

  let manual: SessionFlowInteractionState = {
    ...createSessionFlowInteractionState(),
    selectedNodeId: "c",
    panX: -18,
    panY: 7,
    followLive: false,
    zoomLevel: "inspect",
  };
  manual = sessionFlowInteractionReducer(manual, { type: "zoom_out" });
  assert.deepEqual(
    {
      zoomLevel: manual.zoomLevel,
      selectedNodeId: manual.selectedNodeId,
      panX: manual.panX,
      panY: manual.panY,
      followLive: manual.followLive,
      layoutGeneration: manual.layoutGeneration,
    },
    {
      zoomLevel: "detail",
      selectedNodeId: "c",
      panX: -18,
      panY: 7,
      followLive: false,
      layoutGeneration: 1,
    },
  );
  manual = sessionFlowInteractionReducer(manual, {
    type: "set_zoom",
    zoomLevel: "normal",
  });
  assert.equal(manual.zoomLevel, "normal");
  assert.equal(manual.followLive, false);
  assert.equal(manual.layoutGeneration, 2);
});

test("collapse actions normalize serializable IDs and invalidate layout only on change", () => {
  let state = sessionFlowInteractionReducer(
    createSessionFlowInteractionState(),
    { type: "set_collapsed", nodeIds: [" b ", "a", "b", ""] },
  );
  assert.deepEqual(state.collapsedIds, ["a", "b"]);
  assert.equal(state.layoutGeneration, 1);

  const unchanged = sessionFlowInteractionReducer(state, {
    type: "collapse",
    nodeId: "a",
  });
  assert.equal(unchanged, state);

  state = sessionFlowInteractionReducer(state, {
    type: "expand",
    nodeId: "a",
  });
  assert.deepEqual(state.collapsedIds, ["b"]);
  assert.deepEqual(state.expandedIds, ["a"]);
  assert.equal(state.layoutGeneration, 2);

  state = sessionFlowInteractionReducer(state, {
    type: "toggle_collapse",
    nodeId: "b",
  });
  assert.deepEqual(state.collapsedIds, []);
  assert.deepEqual(state.expandedIds, ["a", "b"]);
  state = sessionFlowInteractionReducer(state, {
    type: "toggle_collapse",
    nodeId: "c",
  });
  assert.deepEqual(state.collapsedIds, ["c"]);
  assert.deepEqual(state.expandedIds, ["a", "b"]);
  assert.equal(state.layoutGeneration, 4);

  state = sessionFlowInteractionReducer(state, {
    type: "set_expanded",
    nodeIds: [" c ", "d", "d"],
  });
  assert.deepEqual(state.expandedIds, ["d"]);
  assert.equal(state.layoutGeneration, 5);
});

test("detail density controls and relayout use a monotonic generation", () => {
  let state = createSessionFlowInteractionState();
  assert.equal(nextSessionFlowDetailLevel("overview"), "stages");
  assert.equal(nextSessionFlowDetailLevel("stages"), "workers");
  assert.equal(nextSessionFlowDetailLevel("workers"), "workers");
  assert.equal(previousSessionFlowDetailLevel("workers"), "stages");
  assert.equal(previousSessionFlowDetailLevel("stages"), "overview");
  assert.equal(previousSessionFlowDetailLevel("overview"), "overview");

  const unchanged = sessionFlowInteractionReducer(state, {
    type: "decrease_detail",
  });
  assert.equal(unchanged, state);

  state = sessionFlowInteractionReducer(state, { type: "increase_detail" });
  assert.equal(state.detailLevel, "stages");
  assert.equal(state.layoutGeneration, 1);

  state = sessionFlowInteractionReducer(state, {
    type: "set_detail",
    detailLevel: "stages",
  });
  assert.equal(state.layoutGeneration, 1);

  state = sessionFlowInteractionReducer(state, { type: "increase_detail" });
  assert.equal(state.detailLevel, "workers");
  assert.equal(state.layoutGeneration, 2);

  state = sessionFlowInteractionReducer(state, {
    type: "set_detail",
    detailLevel: "workers",
  });
  assert.equal(state.layoutGeneration, 2);

  state = sessionFlowInteractionReducer(state, { type: "toggle_detail" });
  assert.equal(state.detailLevel, "overview");
  assert.equal(state.layoutGeneration, 3);

  state = sessionFlowInteractionReducer(state, { type: "toggle_detail" });
  assert.equal(state.detailLevel, "stages");
  assert.equal(state.layoutGeneration, 4);

  state = sessionFlowInteractionReducer(state, { type: "toggle_detail" });
  assert.equal(state.detailLevel, "workers");
  assert.equal(state.layoutGeneration, 5);

  state = sessionFlowInteractionReducer(state, { type: "decrease_detail" });
  assert.equal(state.detailLevel, "stages");
  assert.equal(state.layoutGeneration, 6);

  state = sessionFlowInteractionReducer(state, {
    type: "set_detail",
    detailLevel: "overview",
  });
  assert.equal(state.detailLevel, "overview");
  assert.equal(state.layoutGeneration, 7);

  state = sessionFlowInteractionReducer(state, { type: "relayout" });
  assert.equal(state.layoutGeneration, 8);
});

test("hierarchy focus actions reset stale viewport state only on path changes", () => {
  let state: SessionFlowInteractionState = {
    ...createSessionFlowInteractionState(),
    selectedNodeId: "stale-worker",
    panX: 22,
    panY: -7,
  };

  const invalidEnter = sessionFlowInteractionReducer(state, {
    type: "enter_hierarchy",
    nodeId: "   ",
  });
  assert.equal(invalidEnter, state);
  assert.equal(invalidEnter.followLive, true);

  state = sessionFlowInteractionReducer(state, {
    type: "enter_hierarchy",
    nodeId: " stage-a ",
  });
  assert.deepEqual(state.hierarchyPath, ["stage-a"]);
  assert.equal(currentHierarchyFocusId(state), "stage-a");
  assert.equal(state.selectedNodeId, null);
  assert.equal(state.panX, 0);
  assert.equal(state.panY, 0);
  assert.equal(state.followLive, false);
  assert.equal(state.layoutGeneration, 1);

  state = {
    ...state,
    selectedNodeId: "worker-a",
    panX: -14,
    panY: 3,
    followLive: true,
  };
  state = sessionFlowInteractionReducer(state, {
    type: "enter_hierarchy",
    nodeId: "worker-group",
  });
  assert.deepEqual(state.hierarchyPath, ["stage-a", "worker-group"]);
  assert.equal(currentHierarchyFocusId(state), "worker-group");
  assert.equal(state.selectedNodeId, null);
  assert.equal(state.panX, 0);
  assert.equal(state.panY, 0);
  assert.equal(state.followLive, false);
  assert.equal(state.layoutGeneration, 2);

  const samePathSource: SessionFlowInteractionState = {
    ...state,
    selectedNodeId: "current-worker",
    panX: 9,
    panY: -2,
    followLive: true,
  };
  const samePath = sessionFlowInteractionReducer(samePathSource, {
    type: "set_hierarchy_path",
    nodeIds: [" stage-a ", "worker-group", ""],
  });
  assert.equal(samePath, samePathSource);
  assert.equal(samePath.followLive, true);
  assert.equal(samePath.selectedNodeId, "current-worker");
  assert.equal(samePath.panX, 9);
  assert.equal(samePath.panY, -2);

  state = samePath;
  state = sessionFlowInteractionReducer(state, { type: "exit_hierarchy" });
  assert.deepEqual(state.hierarchyPath, ["stage-a"]);
  assert.equal(currentHierarchyFocusId(state), "stage-a");
  assert.equal(state.selectedNodeId, null);
  assert.equal(state.panX, 0);
  assert.equal(state.panY, 0);
  assert.equal(state.followLive, false);
  assert.equal(state.layoutGeneration, 3);

  state = {
    ...state,
    selectedNodeId: "stale-stage",
    panX: -6,
    panY: 11,
    followLive: true,
  };
  state = sessionFlowInteractionReducer(state, {
    type: "set_hierarchy_path",
    nodeIds: [" outer ", " inner "],
  });
  assert.deepEqual(state.hierarchyPath, ["outer", "inner"]);
  assert.equal(currentHierarchyFocusId(state), "inner");
  assert.equal(state.selectedNodeId, null);
  assert.equal(state.panX, 0);
  assert.equal(state.panY, 0);
  assert.equal(state.followLive, false);
  assert.equal(state.layoutGeneration, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(state.hierarchyPath)), [
    "outer",
    "inner",
  ]);

  state = {
    ...state,
    selectedNodeId: "stale-inner",
    panX: 4,
    panY: 5,
    followLive: true,
  };
  state = sessionFlowInteractionReducer(state, { type: "clear_hierarchy" });
  assert.deepEqual(state.hierarchyPath, []);
  assert.equal(currentHierarchyFocusId(state), null);
  assert.equal(state.selectedNodeId, null);
  assert.equal(state.panX, 0);
  assert.equal(state.panY, 0);
  assert.equal(state.followLive, false);
  assert.equal(state.layoutGeneration, 5);

  const emptyExit = sessionFlowInteractionReducer(state, {
    type: "exit_hierarchy",
  });
  assert.equal(emptyExit, state);
  assert.equal(
    sessionFlowInteractionReducer(state, { type: "clear_hierarchy" }),
    state,
  );
});

test("reset creates a fresh overview state without retaining serializable arrays", () => {
  const dirty: SessionFlowInteractionState = {
    selectedNodeId: "x",
    panX: 12,
    panY: -4,
    followLive: false,
    zoomLevel: "inspect",
    collapsedIds: ["x"],
    expandedIds: ["y"],
    hierarchyPath: ["outer", "inner"],
    detailLevel: "workers",
    layoutGeneration: 9,
  };
  const reset = sessionFlowInteractionReducer(dirty, { type: "reset" });
  assert.deepEqual(reset, EMPTY_SESSION_FLOW_INTERACTION);
  assert.notEqual(reset, EMPTY_SESSION_FLOW_INTERACTION);
  assert.notEqual(reset.collapsedIds, EMPTY_SESSION_FLOW_INTERACTION.collapsedIds);
  assert.notEqual(reset.expandedIds, EMPTY_SESSION_FLOW_INTERACTION.expandedIds);
  assert.notEqual(reset.hierarchyPath, EMPTY_SESSION_FLOW_INTERACTION.hierarchyPath);
  assert.equal(reset.detailLevel, "overview");
  assert.deepEqual(reset.hierarchyPath, []);
});
