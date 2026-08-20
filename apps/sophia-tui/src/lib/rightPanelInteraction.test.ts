import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRightPanelHitRegions,
  EMPTY_RIGHT_PANEL_DETAIL,
  isInsideRightPanel,
  resolveRightPanelKey,
  rightPanelDetailReducer,
  rightPanelSectionAt,
  type RightPanelDetailState,
  type RightPanelHitRegion,
} from "./rightPanelInteraction.js";

const noKey = {
  escape: false,
  tab: false,
  shift: false,
  leftArrow: false,
  rightArrow: false,
  upArrow: false,
  downArrow: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
};

test("opening, selecting, and cycling detail sections resets section-local scroll", () => {
  let state = rightPanelDetailReducer(EMPTY_RIGHT_PANEL_DETAIL, {
    type: "open",
    section: "goal",
  });
  state = rightPanelDetailReducer(state, {
    type: "scroll",
    delta: 7,
    maxScroll: 20,
  });
  assert.equal(state.scrollOffset, 7);

  state = rightPanelDetailReducer(state, {
    type: "select",
    section: "agents",
  });
  assert.deepEqual(state, {
    open: true,
    section: "agents",
    scrollOffset: 0,
    selectedItemId: "",
    expandedItemIds: [],
  });

  state = rightPanelDetailReducer(state, { type: "cycle", delta: 1 });
  assert.equal(state.section, "todos");
  state = rightPanelDetailReducer(state, { type: "cycle", delta: 1 });
  assert.equal(state.section, "agi");
  state = rightPanelDetailReducer(state, { type: "cycle", delta: 1 });
  assert.equal(state.section, "flow");
  state = rightPanelDetailReducer(state, { type: "cycle", delta: 1 });
  assert.equal(state.section, "goal", "cycling wraps through all sections");
  state = rightPanelDetailReducer(state, { type: "cycle", delta: 1 });
  assert.equal(
    state.section,
    "workflow",
    "keyboard order follows the compact Workflow-below-Goal layout",
  );
});

test("scrolling and direct jumps are clamped to the rendered viewport", () => {
  let state: RightPanelDetailState = {
    open: true,
    section: "todos",
    scrollOffset: 4,
    selectedItemId: "",
    expandedItemIds: [],
  };
  state = rightPanelDetailReducer(state, {
    type: "scroll",
    delta: 100,
    maxScroll: 9,
  });
  assert.equal(state.scrollOffset, 9);
  state = rightPanelDetailReducer(state, {
    type: "scroll",
    delta: -100,
    maxScroll: 9,
  });
  assert.equal(state.scrollOffset, 0);
  state = rightPanelDetailReducer(
    { ...state, scrollOffset: 50 },
    { type: "clamp", maxScroll: 3 },
  );
  assert.equal(state.scrollOffset, 3);
});

test("keyboard fallback covers section selection, navigation, scrolling, and close", () => {
  assert.equal(resolveRightPanelKey("", { ...noKey, escape: true }), "close");
  assert.equal(resolveRightPanelKey("", { ...noKey, tab: true }), "next_section");
  assert.equal(
    resolveRightPanelKey("\u001b[Z", { ...noKey, tab: true, shift: true }),
    "previous_section",
  );
  assert.equal(resolveRightPanelKey("", { ...noKey, leftArrow: true }), "previous_section");
  assert.equal(resolveRightPanelKey("", { ...noKey, rightArrow: true }), "next_section");
  assert.equal(resolveRightPanelKey("", { ...noKey, upArrow: true }), "scroll_up");
  assert.equal(resolveRightPanelKey("", { ...noKey, downArrow: true }), "scroll_down");
  assert.equal(resolveRightPanelKey("", { ...noKey, pageUp: true }), "page_up");
  assert.equal(resolveRightPanelKey("", { ...noKey, pageDown: true }), "page_down");
  assert.equal(resolveRightPanelKey("", { ...noKey, home: true }), "scroll_top");
  assert.equal(resolveRightPanelKey("", { ...noKey, end: true }), "scroll_bottom");
  assert.equal(resolveRightPanelKey("g", noKey), "goal");
  assert.equal(resolveRightPanelKey("1", noKey), "goal");
  assert.equal(resolveRightPanelKey("2", noKey), "agents");
  assert.equal(resolveRightPanelKey("T", noKey), "todos");
  assert.equal(resolveRightPanelKey("w", noKey), "workflow");
  assert.equal(resolveRightPanelKey("4", noKey), "workflow");
  assert.equal(resolveRightPanelKey("i", noKey), "agi");
  assert.equal(resolveRightPanelKey("5", noKey), "agi");
  assert.equal(resolveRightPanelKey("f", noKey), "flow");
  assert.equal(resolveRightPanelKey("6", noKey), "flow");
  assert.equal(resolveRightPanelKey("x", noKey), null);
});

test("mouse hit testing requires both the right-panel columns and section rows", () => {
  const regions: RightPanelHitRegion[] = [
    {
      section: "goal",
      screenRow: 4,
      screenEndRow: 8,
      screenLeft: 91,
      screenRight: 120,
    },
    {
      section: "workflow",
      screenRow: 10,
      screenEndRow: 13,
      screenLeft: 91,
      screenRight: 120,
    },
    {
      section: "todos",
      screenRow: 15,
      screenEndRow: 21,
      screenLeft: 91,
      screenRight: 120,
    },
    {
      section: "flow",
      screenRow: 22,
      screenEndRow: 28,
      screenLeft: 91,
      screenRight: 120,
    },
  ];
  assert.equal(rightPanelSectionAt(regions, 100, 6), "goal");
  assert.equal(rightPanelSectionAt(regions, 100, 11), "workflow");
  assert.equal(rightPanelSectionAt(regions, 100, 18), "todos");
  assert.equal(rightPanelSectionAt(regions, 100, 25), "flow");
  assert.equal(rightPanelSectionAt(regions, 80, 6), null);
  assert.equal(rightPanelSectionAt(regions, 100, 14), null);
  assert.equal(isInsideRightPanel(regions, 100, 18), true);
  assert.equal(isInsideRightPanel(regions, 80, 18), false);
});

test("compact layout reserves a visible clickable Workflow region before long previews", () => {
  const regions = buildRightPanelHitRegions({
    specs: [
      { section: "goal", rowCount: 5 },
      { section: "workflow", rowCount: 4, marginTop: 1 },
      { section: "agents", rowCount: 50, marginTop: 1 },
      { section: "todos", rowCount: 50, marginTop: 1 },
      { section: "agi", rowCount: 2, marginTop: 1 },
    ],
    paneTopRow: 2,
    height: 16,
    screenLeft: 91,
    width: 30,
  });
  assert.deepEqual(
    regions.map((region) => region.section),
    ["goal", "workflow", "agents"],
    "Workflow remains above clipped Agent and To-do previews",
  );
  const workflow = regions.find((region) => region.section === "workflow");
  assert.ok(workflow);
  assert.equal(rightPanelSectionAt(regions, 100, workflow.screenRow), "workflow");
  assert.ok(workflow.screenEndRow <= 16);
});

test("clicking the workflow region opens its details and clicking it again closes", () => {
  const regions: RightPanelHitRegion[] = [
    {
      section: "workflow",
      screenRow: 9,
      screenEndRow: 12,
      screenLeft: 91,
      screenRight: 120,
    },
  ];
  const section = rightPanelSectionAt(regions, 104, 10);
  assert.equal(section, "workflow");
  let state = rightPanelDetailReducer(EMPTY_RIGHT_PANEL_DETAIL, {
    type: "toggle",
    section: section!,
  });
  assert.deepEqual(state, {
    open: true,
    section: "workflow",
    scrollOffset: 0,
    selectedItemId: "",
    expandedItemIds: [],
  });
  state = rightPanelDetailReducer(state, {
    type: "scroll",
    delta: 12,
    maxScroll: 40,
  });
  assert.equal(state.scrollOffset, 12);
  state = rightPanelDetailReducer(state, {
    type: "toggle",
    section: "workflow",
  });
  assert.deepEqual(state, {
    open: false,
    section: "workflow",
    scrollOffset: 0,
    selectedItemId: "",
    expandedItemIds: [],
  });
});

test("detail items can be selected and expanded without changing sections", () => {
  let state = rightPanelDetailReducer(EMPTY_RIGHT_PANEL_DETAIL, {
    type: "open",
    section: "agents",
  });
  state = rightPanelDetailReducer(state, {
    type: "set_items",
    ids: ["agent:main", "task:t1", "message:m1"],
  });
  assert.equal(state.selectedItemId, "agent:main");
  state = rightPanelDetailReducer(state, {
    type: "move_item",
    delta: 1,
    ids: ["agent:main", "task:t1", "message:m1"],
  });
  assert.equal(state.selectedItemId, "task:t1");
  state = rightPanelDetailReducer(state, { type: "toggle_item" });
  assert.deepEqual(state.expandedItemIds, ["task:t1"]);
  state = rightPanelDetailReducer(state, {
    type: "toggle_item",
    id: "task:t1",
  });
  assert.deepEqual(state.expandedItemIds, []);
});
