import type { Key } from "ink";

export type RightPanelSection =
  | "goal"
  | "workflow"
  | "agents"
  | "todos"
  | "agi"
  | "flow";

export interface RightPanelDetailState {
  open: boolean;
  section: RightPanelSection;
  /** Top-anchored visual-row offset inside the expanded detail viewport. */
  scrollOffset: number;
  /** Selected progressive-disclosure item inside the expanded section. */
  selectedItemId: string;
  /** Expanded item ids; child rows stay hidden until explicitly opened. */
  expandedItemIds: string[];
}

export const EMPTY_RIGHT_PANEL_DETAIL: RightPanelDetailState = {
  open: false,
  section: "goal",
  scrollOffset: 0,
  selectedItemId: "",
  expandedItemIds: [],
};

export type RightPanelDetailAction =
  | { type: "open"; section?: RightPanelSection }
  | { type: "toggle"; section: RightPanelSection }
  | { type: "close" }
  | { type: "select"; section: RightPanelSection }
  | { type: "cycle"; delta: number }
  | { type: "scroll"; delta: number; maxScroll: number }
  | { type: "scroll_to"; offset: number; maxScroll: number }
  | { type: "clamp"; maxScroll: number }
  | { type: "set_items"; ids: string[] }
  | { type: "move_item"; delta: number; ids: string[] }
  | { type: "toggle_item"; id?: string };

// Keep the workflow section adjacent to Goal in keyboard navigation, matching
// the compact panel's visual order. Active workflow progress is controller
// state, so it should not be hidden behind long Agent or To-do previews.
export const RIGHT_PANEL_SECTIONS: readonly RightPanelSection[] = [
  "goal",
  "workflow",
  "agents",
  "todos",
  "agi",
  "flow",
];

function clampScroll(value: number, maxScroll: number): number {
  const maximum = Number.isFinite(maxScroll)
    ? Math.max(0, Math.floor(maxScroll))
    : 0;
  const offset = Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, Math.min(maximum, offset));
}

export function rightPanelDetailReducer(
  state: RightPanelDetailState,
  action: RightPanelDetailAction,
): RightPanelDetailState {
  switch (action.type) {
    case "open":
      return {
        open: true,
        section: action.section ?? state.section,
        scrollOffset: action.section && action.section !== state.section
          ? 0
          : state.scrollOffset,
        selectedItemId:
          action.section && action.section !== state.section
            ? ""
            : state.selectedItemId,
        expandedItemIds:
          action.section && action.section !== state.section
            ? []
            : state.expandedItemIds,
      };
    case "toggle":
      if (state.open && state.section === action.section) {
        return {
          ...state,
          open: false,
          scrollOffset: 0,
          selectedItemId: "",
          expandedItemIds: [],
        };
      }
      return {
        open: true,
        section: action.section,
        scrollOffset: 0,
        selectedItemId: "",
        expandedItemIds: [],
      };
    case "close":
      return {
        ...state,
        open: false,
        scrollOffset: 0,
        selectedItemId: "",
        expandedItemIds: [],
      };
    case "select":
      return {
        open: true,
        section: action.section,
        scrollOffset: action.section === state.section ? state.scrollOffset : 0,
        selectedItemId:
          action.section === state.section ? state.selectedItemId : "",
        expandedItemIds:
          action.section === state.section ? state.expandedItemIds : [],
      };
    case "cycle": {
      const current = RIGHT_PANEL_SECTIONS.indexOf(state.section);
      const next =
        (current + action.delta + RIGHT_PANEL_SECTIONS.length) %
        RIGHT_PANEL_SECTIONS.length;
      return {
        open: true,
        section: RIGHT_PANEL_SECTIONS[next],
        scrollOffset: 0,
        selectedItemId: "",
        expandedItemIds: [],
      };
    }
    case "scroll":
      return {
        ...state,
        scrollOffset: clampScroll(
          state.scrollOffset + action.delta,
          action.maxScroll,
        ),
      };
    case "scroll_to":
      return {
        ...state,
        scrollOffset: clampScroll(action.offset, action.maxScroll),
      };
    case "clamp":
      return {
        ...state,
        scrollOffset: clampScroll(state.scrollOffset, action.maxScroll),
      };
    case "set_items": {
      const ids = [...new Set(action.ids.filter(Boolean))];
      const selectedItemId = ids.includes(state.selectedItemId)
        ? state.selectedItemId
        : ids[0] ?? "";
      if (selectedItemId === state.selectedItemId) return state;
      return { ...state, selectedItemId };
    }
    case "move_item": {
      const ids = [...new Set(action.ids.filter(Boolean))];
      if (!ids.length) return { ...state, selectedItemId: "" };
      const current = Math.max(0, ids.indexOf(state.selectedItemId));
      const next = (current + action.delta + ids.length) % ids.length;
      return { ...state, selectedItemId: ids[next] };
    }
    case "toggle_item": {
      const id = action.id || state.selectedItemId;
      if (!id) return state;
      const expanded = new Set(state.expandedItemIds);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      return {
        ...state,
        selectedItemId: id,
        expandedItemIds: [...expanded],
      };
    }
    default:
      return state;
  }
}

export interface RightPanelDetailItemRegion {
  id: string;
  screenRow: number;
  screenEndRow: number;
  screenLeft: number;
  screenRight: number;
}

export function rightPanelDetailItemAt(
  regions: readonly RightPanelDetailItemRegion[],
  x: number,
  y: number,
): string | null {
  return (
    regions.find(
      (region) =>
        x >= region.screenLeft
        && x <= region.screenRight
        && y >= region.screenRow
        && y <= region.screenEndRow,
    )?.id ?? null
  );
}

export type RightPanelKeyIntent =
  | "close"
  | "previous_section"
  | "next_section"
  | "goal"
  | "agents"
  | "todos"
  | "workflow"
  | "agi"
  | "flow"
  | "scroll_up"
  | "scroll_down"
  | "page_up"
  | "page_down"
  | "scroll_top"
  | "scroll_bottom";

/**
 * Keyboard fallback for terminals with mouse tracking disabled and for
 * screen-reader users. App.tsx owns the state transitions; this helper only
 * translates keys into stable intents.
 */
export function resolveRightPanelKey(
  input: string,
  key: Pick<
    Key,
    | "escape"
    | "tab"
    | "shift"
    | "leftArrow"
    | "rightArrow"
    | "upArrow"
    | "downArrow"
    | "pageUp"
    | "pageDown"
    | "home"
    | "end"
  >,
): RightPanelKeyIntent | null {
  if (key.escape) return "close";
  if ((key.shift && key.tab) || key.leftArrow) return "previous_section";
  if (key.tab || key.rightArrow) return "next_section";
  if (key.pageUp) return "page_up";
  if (key.pageDown) return "page_down";
  if (key.upArrow) return "scroll_up";
  if (key.downArrow) return "scroll_down";
  if (key.home) return "scroll_top";
  if (key.end) return "scroll_bottom";
  const normalized = input.toLowerCase();
  if (normalized === "g" || normalized === "1") return "goal";
  if (normalized === "a" || normalized === "2") return "agents";
  if (normalized === "t" || normalized === "3") return "todos";
  if (normalized === "w" || normalized === "4") return "workflow";
  if (normalized === "i" || normalized === "5") return "agi";
  if (normalized === "f" || normalized === "6") return "flow";
  return null;
}

export interface RightPanelHitRegion {
  section: RightPanelSection;
  screenRow: number;
  screenEndRow: number;
  screenLeft: number;
  screenRight: number;
}

export interface RightPanelRegionSpec {
  section: RightPanelSection;
  rowCount: number;
  marginTop?: number;
}

export function buildRightPanelHitRegions({
  specs,
  paneTopRow,
  height,
  screenLeft,
  width,
  bordered = true,
}: {
  specs: readonly RightPanelRegionSpec[];
  paneTopRow: number;
  height: number;
  screenLeft: number;
  width: number;
  bordered?: boolean;
}): RightPanelHitRegion[] {
  const out: RightPanelHitRegion[] = [];
  let cursor = paneTopRow + (bordered ? 1 : 0);
  const bottom = paneTopRow + height - (bordered ? 2 : 1);
  const screenRight = screenLeft + width - 1;
  for (const spec of specs) {
    cursor += Math.max(0, Math.floor(spec.marginTop ?? 0));
    const rows = Math.max(1, Math.floor(spec.rowCount));
    const start = cursor;
    const end = Math.min(bottom, start + rows - 1);
    if (start <= bottom) {
      out.push({
        section: spec.section,
        screenRow: start,
        screenEndRow: end,
        screenLeft,
        screenRight,
      });
    }
    cursor += rows;
  }
  return out;
}

export function rightPanelSectionAt(
  regions: readonly RightPanelHitRegion[],
  x: number,
  y: number,
): RightPanelSection | null {
  return (
    regions.find(
      (region) =>
        x >= region.screenLeft &&
        x <= region.screenRight &&
        y >= region.screenRow &&
        y <= region.screenEndRow,
    )?.section ?? null
  );
}

export function isInsideRightPanel(
  regions: readonly RightPanelHitRegion[],
  x: number,
  y: number,
): boolean {
  return regions.some(
    (region) =>
      x >= region.screenLeft &&
      x <= region.screenRight &&
      y >= region.screenRow &&
      y <= region.screenEndRow,
  );
}
