import {
  nextSessionFlowZoomLevel,
  previousSessionFlowZoomLevel,
  type SessionFlowZoomLevel,
} from "./sessionFlowZoom.js";

export type SessionFlowDetailLevel = "overview" | "stages" | "workers";

export type SessionFlowNavigationDirection =
  | "left"
  | "right"
  | "up"
  | "down";

/**
 * UI-independent geometry used by the interaction reducer. Coordinates are
 * layout coordinates before pan is applied.
 */
export interface SessionFlowNodeGeometry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SessionFlowViewportGeometry {
  width: number;
  height: number;
}

export interface SessionFlowPan {
  panX: number;
  panY: number;
}

export interface SessionFlowInteractionState extends SessionFlowPan {
  selectedNodeId: string | null;
  followLive: boolean;
  zoomLevel: SessionFlowZoomLevel;
  /**
   * Kept as an array so the complete interaction state can be serialized in a
   * session receipt or React dev tooling without Set-specific conversion.
   */
  collapsedIds: string[];
  /** Containers whose overview-only detail children are explicitly revealed. */
  expandedIds: string[];
  /**
   * Entered compound node IDs from the outermost hierarchy to the current
   * focus. Kept as an array so interaction state remains JSON-serializable.
   */
  hierarchyPath: string[];
  detailLevel: SessionFlowDetailLevel;
  /**
   * Monotonic invalidation token. The layout layer can use it to discard its
   * stable-position cache after a user-requested structural change.
   */
  layoutGeneration: number;
}

export const EMPTY_SESSION_FLOW_INTERACTION: SessionFlowInteractionState = {
  selectedNodeId: null,
  panX: 0,
  panY: 0,
  followLive: true,
  zoomLevel: "normal",
  collapsedIds: [],
  expandedIds: [],
  hierarchyPath: [],
  detailLevel: "overview",
  layoutGeneration: 0,
};

export function createSessionFlowInteractionState(): SessionFlowInteractionState {
  return {
    ...EMPTY_SESSION_FLOW_INTERACTION,
    collapsedIds: [],
    expandedIds: [],
    hierarchyPath: [],
  };
}

export type SessionFlowInteractionAction =
  | { type: "select"; nodeId: string | null }
  | {
      type: "navigate";
      direction: SessionFlowNavigationDirection;
      nodes: readonly SessionFlowNodeGeometry[];
      activeNodeId?: string | null;
      latestNodeId?: string | null;
    }
  | {
      type: "home";
      nodes: readonly SessionFlowNodeGeometry[];
    }
  | {
      type: "end";
      nodes: readonly SessionFlowNodeGeometry[];
      activeNodeId?: string | null;
      latestNodeId?: string | null;
    }
  | {
      type: "pan";
      dx: number;
      dy: number;
      activeNodeId?: string | null;
      latestNodeId?: string | null;
    }
  | { type: "set_pan"; panX: number; panY: number }
  | {
      type: "center";
      node: SessionFlowNodeGeometry | null;
      viewport: SessionFlowViewportGeometry;
    }
  | {
      type: "follow_active";
      nodeId: string | null;
      node?: SessionFlowNodeGeometry | null;
      viewport?: SessionFlowViewportGeometry;
    }
  | {
      type: "toggle_follow";
      activeNodeId?: string | null;
      latestNodeId?: string | null;
    }
  | { type: "set_zoom"; zoomLevel: SessionFlowZoomLevel }
  | { type: "zoom_in" }
  | { type: "zoom_out" }
  | { type: "toggle_collapse"; nodeId: string }
  | { type: "collapse"; nodeId: string }
  | { type: "expand"; nodeId: string }
  | { type: "set_collapsed"; nodeIds: readonly string[] }
  | { type: "set_expanded"; nodeIds: readonly string[] }
  | { type: "enter_hierarchy"; nodeId: string }
  | { type: "exit_hierarchy" }
  | { type: "set_hierarchy_path"; nodeIds: readonly string[] }
  | { type: "clear_hierarchy" }
  | { type: "toggle_detail" }
  | { type: "set_detail"; detailLevel: SessionFlowDetailLevel }
  | { type: "increase_detail" }
  | { type: "decrease_detail" }
  | { type: "relayout" }
  | { type: "reset" };

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function terminalCell(value: number, fallback = 0): number {
  return Math.round(finiteNumber(value, fallback));
}

function usableNodeId(nodeId: string | null | undefined): string | null {
  const normalized = nodeId?.trim() ?? "";
  return normalized || null;
}

function preferredLiveNodeId(
  activeNodeId: string | null | undefined,
  latestNodeId: string | null | undefined,
): string | null {
  return usableNodeId(activeNodeId) ?? usableNodeId(latestNodeId);
}

function normalizeCollapsedIds(nodeIds: readonly string[]): string[] {
  return [...new Set(nodeIds.map((id) => id.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizeHierarchyPath(nodeIds: readonly string[]): string[] {
  return nodeIds.map((id) => id.trim()).filter(Boolean);
}

const SESSION_FLOW_DETAIL_LEVELS: readonly SessionFlowDetailLevel[] = [
  "overview",
  "stages",
  "workers",
];

export function nextSessionFlowDetailLevel(
  detailLevel: SessionFlowDetailLevel,
): SessionFlowDetailLevel {
  const index = SESSION_FLOW_DETAIL_LEVELS.indexOf(detailLevel);
  return SESSION_FLOW_DETAIL_LEVELS[
    Math.min(index + 1, SESSION_FLOW_DETAIL_LEVELS.length - 1)
  ];
}

export function previousSessionFlowDetailLevel(
  detailLevel: SessionFlowDetailLevel,
): SessionFlowDetailLevel {
  const index = SESSION_FLOW_DETAIL_LEVELS.indexOf(detailLevel);
  return SESSION_FLOW_DETAIL_LEVELS[Math.max(index - 1, 0)];
}

export function currentHierarchyFocusId(
  state: Pick<SessionFlowInteractionState, "hierarchyPath">,
): string | null {
  return state.hierarchyPath.at(-1) ?? null;
}

export function sessionFlowNodeCenter(
  node: SessionFlowNodeGeometry,
): { x: number; y: number } {
  return {
    x: finiteNumber(node.x) + Math.max(0, finiteNumber(node.width)) / 2,
    y: finiteNumber(node.y) + Math.max(0, finiteNumber(node.height)) / 2,
  };
}

function compareLayoutOrder(
  left: SessionFlowNodeGeometry,
  right: SessionFlowNodeGeometry,
): number {
  const leftCenter = sessionFlowNodeCenter(left);
  const rightCenter = sessionFlowNodeCenter(right);
  return (
    leftCenter.x - rightCenter.x ||
    leftCenter.y - rightCenter.y ||
    left.id.localeCompare(right.id)
  );
}

/** The spatially first node in the left-to-right flow. */
export function firstSessionFlowNodeId(
  nodes: readonly SessionFlowNodeGeometry[],
): string | null {
  return [...nodes].sort(compareLayoutOrder)[0]?.id ?? null;
}

/**
 * Resolve End-key focus. The active node wins, then the latest node, then the
 * spatially last node in the left-to-right flow.
 */
export function lastSessionFlowNodeId(
  nodes: readonly SessionFlowNodeGeometry[],
  activeNodeId: string | null = null,
  latestNodeId: string | null = null,
): string | null {
  const available = new Set(nodes.map((node) => node.id));
  const active = usableNodeId(activeNodeId);
  if (active && available.has(active)) return active;
  const latest = usableNodeId(latestNodeId);
  if (latest && available.has(latest)) return latest;
  return [...nodes].sort(compareLayoutOrder).at(-1)?.id ?? null;
}

/**
 * Resolve the effective selection without mutating interaction state.
 *
 * While follow-live is enabled, an explicit active/latest ID wins. Otherwise
 * the manual selection is retained while visible. The supplied array tail is
 * used as the live fallback because layout nodes preserve event order.
 */
export function selectedFlowNodeId(
  state: SessionFlowInteractionState,
  layoutNodes: readonly SessionFlowNodeGeometry[],
  latestNodeId: string | null = null,
  activeNodeId: string | null = null,
): string | null {
  const availableIds = new Set(layoutNodes.map((node) => node.id));
  if (state.followLive) {
    const active = usableNodeId(activeNodeId);
    if (active && availableIds.has(active)) return active;
    const latest = usableNodeId(latestNodeId);
    if (latest && availableIds.has(latest)) return latest;
    return layoutNodes.at(-1)?.id ?? null;
  }
  if (state.selectedNodeId && availableIds.has(state.selectedNodeId)) {
    return state.selectedNodeId;
  }
  return firstSessionFlowNodeId(layoutNodes);
}

/**
 * Pick the nearest node in a directional half-plane. Perpendicular movement
 * is weighted so aligned blocks win over visually misleading diagonals.
 * Stable geometric and ID tie-breakers make the answer independent of input
 * array order.
 */
export function nearestSessionFlowNodeId(
  currentId: string | null,
  direction: SessionFlowNavigationDirection,
  nodes: readonly SessionFlowNodeGeometry[],
): string | null {
  if (nodes.length === 0) return null;
  const current =
    nodes.find((node) => node.id === currentId) ??
    nodes.find((node) => node.id === firstSessionFlowNodeId(nodes));
  if (!current) return null;

  const origin = sessionFlowNodeCenter(current);
  const candidates = nodes
    .filter((node) => node.id !== current.id)
    .map((node) => {
      const center = sessionFlowNodeCenter(node);
      const dx = center.x - origin.x;
      const dy = center.y - origin.y;
      const primary =
        direction === "left"
          ? -dx
          : direction === "right"
            ? dx
            : direction === "up"
              ? -dy
              : dy;
      const perpendicular =
        direction === "left" || direction === "right"
          ? Math.abs(dy)
          : Math.abs(dx);
      return {
        node,
        center,
        primary,
        perpendicular,
        score: primary + perpendicular * 2,
        distance: Math.hypot(dx, dy),
      };
    })
    .filter((candidate) => candidate.primary > 0)
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.perpendicular - right.perpendicular ||
        left.distance - right.distance ||
        left.center.x - right.center.x ||
        left.center.y - right.center.y ||
        left.node.id.localeCompare(right.node.id),
    );

  return candidates[0]?.node.id ?? current.id;
}

/** Compute a whole-cell pan that centers a layout node in the viewport. */
export function centerSessionFlowPan(
  node: SessionFlowNodeGeometry,
  viewport: SessionFlowViewportGeometry,
): SessionFlowPan {
  const center = sessionFlowNodeCenter(node);
  return {
    panX: terminalCell(finiteNumber(viewport.width) / 2 - center.x),
    panY: terminalCell(finiteNumber(viewport.height) / 2 - center.y),
  };
}

function updateCollapsed(
  state: SessionFlowInteractionState,
  nodeIds: readonly string[],
  expandedNodeIds: readonly string[] = state.expandedIds,
): SessionFlowInteractionState {
  const collapsedIds = normalizeCollapsedIds(nodeIds);
  const collapsed = new Set(collapsedIds);
  const expandedIds = normalizeCollapsedIds(expandedNodeIds).filter(
    (id) => !collapsed.has(id),
  );
  if (
    collapsedIds.length === state.collapsedIds.length &&
    collapsedIds.every((id, index) => id === state.collapsedIds[index]) &&
    expandedIds.length === state.expandedIds.length &&
    expandedIds.every((id, index) => id === state.expandedIds[index])
  ) {
    return state;
  }
  return {
    ...state,
    collapsedIds,
    expandedIds,
    layoutGeneration: state.layoutGeneration + 1,
  };
}

function updateDetailLevel(
  state: SessionFlowInteractionState,
  detailLevel: SessionFlowDetailLevel,
): SessionFlowInteractionState {
  if (detailLevel === state.detailLevel) return state;
  return {
    ...state,
    detailLevel,
    layoutGeneration: state.layoutGeneration + 1,
  };
}

function updateHierarchyPath(
  state: SessionFlowInteractionState,
  nodeIds: readonly string[],
): SessionFlowInteractionState {
  const hierarchyPath = normalizeHierarchyPath(nodeIds);
  if (
    hierarchyPath.length === state.hierarchyPath.length &&
    hierarchyPath.every((id, index) => id === state.hierarchyPath[index])
  ) {
    return state;
  }
  return {
    ...state,
    selectedNodeId: null,
    panX: 0,
    panY: 0,
    followLive: false,
    hierarchyPath,
    layoutGeneration: state.layoutGeneration + 1,
  };
}

function updateZoomLevel(
  state: SessionFlowInteractionState,
  zoomLevel: SessionFlowZoomLevel,
): SessionFlowInteractionState {
  if (zoomLevel === state.zoomLevel) return state;
  return {
    ...state,
    zoomLevel,
    layoutGeneration: state.layoutGeneration + 1,
  };
}

export function sessionFlowInteractionReducer(
  state: SessionFlowInteractionState,
  action: SessionFlowInteractionAction,
): SessionFlowInteractionState {
  switch (action.type) {
    case "select":
      return {
        ...state,
        selectedNodeId: usableNodeId(action.nodeId),
        followLive: false,
      };
    case "navigate": {
      const currentId = selectedFlowNodeId(
        state,
        action.nodes,
        action.latestNodeId ?? null,
        action.activeNodeId ?? null,
      );
      return {
        ...state,
        selectedNodeId: nearestSessionFlowNodeId(
          currentId,
          action.direction,
          action.nodes,
        ),
        followLive: false,
      };
    }
    case "home":
      return {
        ...state,
        selectedNodeId: firstSessionFlowNodeId(action.nodes),
        followLive: false,
      };
    case "end":
      return {
        ...state,
        selectedNodeId: lastSessionFlowNodeId(
          action.nodes,
          action.activeNodeId ?? null,
          action.latestNodeId ?? null,
        ),
        followLive: false,
      };
    case "pan": {
      const liveId = preferredLiveNodeId(
        action.activeNodeId,
        action.latestNodeId,
      );
      return {
        ...state,
        selectedNodeId:
          state.followLive && liveId ? liveId : state.selectedNodeId,
        panX: terminalCell(state.panX + finiteNumber(action.dx)),
        panY: terminalCell(state.panY + finiteNumber(action.dy)),
        followLive: false,
      };
    }
    case "set_pan":
      return {
        ...state,
        panX: terminalCell(action.panX),
        panY: terminalCell(action.panY),
      };
    case "center":
      return action.node
        ? { ...state, ...centerSessionFlowPan(action.node, action.viewport) }
        : state;
    case "follow_active": {
      const nodeId = usableNodeId(action.nodeId);
      const pan =
        action.node && action.viewport
          ? centerSessionFlowPan(action.node, action.viewport)
          : null;
      return {
        ...state,
        ...(pan ?? {}),
        selectedNodeId: nodeId,
        followLive: true,
      };
    }
    case "toggle_follow": {
      const liveId = preferredLiveNodeId(
        action.activeNodeId,
        action.latestNodeId,
      );
      return {
        ...state,
        selectedNodeId: liveId ?? state.selectedNodeId,
        followLive: !state.followLive,
      };
    }
    case "set_zoom":
      return updateZoomLevel(state, action.zoomLevel);
    case "zoom_in":
      return updateZoomLevel(
        state,
        nextSessionFlowZoomLevel(state.zoomLevel),
      );
    case "zoom_out":
      return updateZoomLevel(
        state,
        previousSessionFlowZoomLevel(state.zoomLevel),
      );
    case "toggle_collapse": {
      const nodeId = usableNodeId(action.nodeId);
      if (!nodeId) return state;
      return updateCollapsed(
        state,
        state.collapsedIds.includes(nodeId)
          ? state.collapsedIds.filter((id) => id !== nodeId)
          : [...state.collapsedIds, nodeId],
        state.collapsedIds.includes(nodeId)
          ? [...state.expandedIds, nodeId]
          : state.expandedIds.filter((id) => id !== nodeId),
      );
    }
    case "collapse": {
      const nodeId = usableNodeId(action.nodeId);
      return nodeId
        ? updateCollapsed(
            state,
            [...state.collapsedIds, nodeId],
            state.expandedIds.filter((id) => id !== nodeId),
          )
        : state;
    }
    case "expand": {
      const nodeId = usableNodeId(action.nodeId);
      return nodeId
        ? updateCollapsed(
            state,
            state.collapsedIds.filter((id) => id !== nodeId),
            [...state.expandedIds, nodeId],
          )
        : state;
    }
    case "set_collapsed":
      return updateCollapsed(state, action.nodeIds);
    case "set_expanded":
      return updateCollapsed(state, state.collapsedIds, action.nodeIds);
    case "enter_hierarchy": {
      const nodeId = usableNodeId(action.nodeId);
      return nodeId
        ? updateHierarchyPath(state, [...state.hierarchyPath, nodeId])
        : state;
    }
    case "exit_hierarchy":
      return state.hierarchyPath.length > 0
        ? updateHierarchyPath(state, state.hierarchyPath.slice(0, -1))
        : state;
    case "set_hierarchy_path":
      return updateHierarchyPath(state, action.nodeIds);
    case "clear_hierarchy":
      return state.hierarchyPath.length > 0
        ? updateHierarchyPath(state, [])
        : state;
    case "toggle_detail":
      return updateDetailLevel(
        state,
        state.detailLevel === "workers"
          ? "overview"
          : nextSessionFlowDetailLevel(state.detailLevel),
      );
    case "set_detail":
      return updateDetailLevel(state, action.detailLevel);
    case "increase_detail":
      return updateDetailLevel(
        state,
        nextSessionFlowDetailLevel(state.detailLevel),
      );
    case "decrease_detail":
      return updateDetailLevel(
        state,
        previousSessionFlowDetailLevel(state.detailLevel),
      );
    case "relayout":
      return {
        ...state,
        layoutGeneration: state.layoutGeneration + 1,
      };
    case "reset":
      return createSessionFlowInteractionState();
    default:
      return state;
  }
}
