import type {
  SessionFlowNode,
  SessionFlowNodeStatus,
  SessionFlowState,
} from "./sessionFlow.js";
import {
  layoutSessionFlow,
  type SessionFlowLayoutBounds,
  type SessionFlowLineStyle,
} from "./sessionFlowLayout.js";
import {
  sessionFlowEdgeSemantics,
  sessionFlowEdgeTonePriority,
  type SessionFlowEdgeRelation,
} from "./sessionFlowEdgeSemantics.js";
import type { GraphEdgeTone } from "./terminalGraphCanvas.js";

export interface SessionFlowMiniMapPoint {
  x: number;
  y: number;
}

export interface SessionFlowMiniMapWorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SessionFlowMiniMapCellRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type SessionFlowMiniMapCellTone =
  | "node"
  | "selected"
  | "active"
  | "latest"
  | GraphEdgeTone
  | "viewport"
  | "success"
  | "warning"
  | "danger"
  | "dim"
  | null;

export interface SessionFlowMiniMapCell {
  glyph: string;
  tone: SessionFlowMiniMapCellTone;
  nodeIds: string[];
}

export interface SessionFlowMiniMapNode {
  id: string;
  node: SessionFlowNode;
  x: number;
  y: number;
  normalized: SessionFlowMiniMapPoint;
  selected: boolean;
  active: boolean;
  latest: boolean;
}

export interface SessionFlowMiniMapEdge {
  id: string;
  source: string;
  target: string;
  labels: string[];
  relation: SessionFlowEdgeRelation;
  tone: GraphEdgeTone;
  lineStyle: SessionFlowLineStyle;
  arrow: boolean;
  points: SessionFlowMiniMapPoint[];
}

export interface SessionFlowMiniMapProgress {
  total: number;
  settled: number;
  succeeded: number;
  running: number;
  adverse: number;
  pending: number;
  percentage: number;
}

export interface SessionFlowMiniMapProjection {
  width: number;
  height: number;
  nodes: SessionFlowMiniMapNode[];
  edges: SessionFlowMiniMapEdge[];
  cells: SessionFlowMiniMapCell[][];
  lines: string[];
  hitMap: Array<Array<string | null>>;
  nodeIdsByCell: string[][][];
  selectedNodeId: string | null;
  activeNodeId: string | null;
  latestNodeId: string | null;
  progress: SessionFlowMiniMapProgress;
  viewportRect: SessionFlowMiniMapCellRect | null;
  /** Canonical whole-graph bounds used only to normalize minimap placement. */
  projectionBounds: SessionFlowLayoutBounds;
}

export interface SessionFlowMiniMapProjectionOptions {
  width: number;
  height: number;
  selectedNodeId?: string | null;
  /**
   * Bounds of the enlarged graph layout. They do not affect node placement;
   * they are used only to draw the optional viewport rectangle.
   */
  layoutBounds?: SessionFlowMiniMapWorldBounds | null;
  viewportWorldBounds?: SessionFlowMiniMapWorldBounds | null;
}

export interface SessionFlowMiniMapNavigationTarget {
  cell: SessionFlowMiniMapPoint;
  normalized: SessionFlowMiniMapPoint;
  world: SessionFlowMiniMapPoint | null;
  nodeId: string | null;
  nodeIds: string[];
}

export type SessionFlowMiniMapLocalNavigationTarget = Omit<
  SessionFlowMiniMapNavigationTarget,
  "nodeId" | "nodeIds"
>;

interface MutableMiniMapCell extends SessionFlowMiniMapCell {}

function dimension(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cellForNormalized(value: number, size: number): number {
  if (size <= 1) return 0;
  return clamp(Math.round(clamp(value, 0, 1) * (size - 1)), 0, size - 1);
}

function cellKey(point: SessionFlowMiniMapPoint): string {
  return `${point.x}:${point.y}`;
}

function markerPriority(node: SessionFlowMiniMapNode): number {
  if (node.selected) return 100;
  if (node.node.status === "running") return 90;
  if (node.node.status === "failed") return 80;
  if (node.node.status === "blocked") return 70;
  if (node.node.status === "cancelled") return 60;
  if (node.latest) return 50;
  if (node.active) return 40;
  if (node.node.status === "succeeded") return 30;
  return 10;
}

function markerGlyph(node: SessionFlowMiniMapNode): string {
  if (node.selected) return "◆";
  if (node.node.status === "running") return "▶";
  if (node.node.status === "failed") return "×";
  if (node.node.status === "blocked") return "!";
  if (node.node.status === "cancelled") return "−";
  if (node.node.status === "succeeded") return "●";
  if (node.node.status === "pending") return "○";
  if (node.latest) return "◇";
  return "•";
}

function statusTone(status: SessionFlowNodeStatus): SessionFlowMiniMapCellTone {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "blocked" || status === "cancelled") return "warning";
  if (status === "pending" || status === "info") return "dim";
  return "node";
}

function markerTone(node: SessionFlowMiniMapNode): SessionFlowMiniMapCellTone {
  if (node.selected) return "selected";
  return statusTone(node.node.status);
}

function progressTone(status: SessionFlowNodeStatus): GraphEdgeTone {
  if (status === "running") return "edge-live";
  if (status === "succeeded") return "edge-success";
  if (status === "failed") return "edge-danger";
  if (status === "blocked" || status === "cancelled") return "edge-warning";
  if (status === "pending") return "edge-queued";
  return "edge-progress";
}

function progressSummary(
  nodes: readonly SessionFlowNode[],
): SessionFlowMiniMapProgress {
  const succeeded = nodes.filter((node) => node.status === "succeeded").length;
  const running = nodes.filter((node) => node.status === "running").length;
  const adverse = nodes.filter(
    (node) =>
      node.status === "failed"
      || node.status === "blocked"
      || node.status === "cancelled",
  ).length;
  const pending = nodes.filter(
    (node) => node.status === "pending" || node.status === "info",
  ).length;
  const settled = succeeded + adverse;
  return {
    total: nodes.length,
    settled,
    succeeded,
    running,
    adverse,
    pending,
    percentage:
      nodes.length === 0 ? 0 : Math.round((settled / nodes.length) * 100),
  };
}

const EDGE_RELATION_PRIORITY: Readonly<Record<SessionFlowEdgeRelation, number>> = {
  structure: 1,
  sequence: 2,
  handoff: 3,
  return: 4,
  retry: 5,
};

function shouldPreferMiniMapEdge(
  incoming: SessionFlowMiniMapEdge,
  current: SessionFlowMiniMapEdge,
): boolean {
  const relationDelta =
    EDGE_RELATION_PRIORITY[incoming.relation] -
    EDGE_RELATION_PRIORITY[current.relation];
  if (relationDelta !== 0) return relationDelta > 0;
  const toneDelta =
    sessionFlowEdgeTonePriority(incoming.tone) -
    sessionFlowEdgeTonePriority(current.tone);
  if (toneDelta !== 0) return toneDelta > 0;
  return incoming.id.localeCompare(current.id) < 0;
}

function straightLine(
  start: SessionFlowMiniMapPoint,
  end: SessionFlowMiniMapPoint,
): SessionFlowMiniMapPoint[] {
  const points: SessionFlowMiniMapPoint[] = [];
  let x = start.x;
  let y = start.y;
  const dx = Math.abs(end.x - start.x);
  const sx = start.x < end.x ? 1 : -1;
  const dy = -Math.abs(end.y - start.y);
  const sy = start.y < end.y ? 1 : -1;
  let error = dx + dy;

  while (true) {
    points.push({ x, y });
    if (x === end.x && y === end.y) break;
    const doubled = error * 2;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
  return points;
}

function worldSpan(bounds: SessionFlowMiniMapWorldBounds, axis: "x" | "y"): number {
  return axis === "x"
    ? finite(bounds.maxX) - finite(bounds.minX)
    : finite(bounds.maxY) - finite(bounds.minY);
}

function validWorldBounds(
  bounds: SessionFlowMiniMapWorldBounds | null | undefined,
): bounds is SessionFlowMiniMapWorldBounds {
  return Boolean(
    bounds &&
      Number.isFinite(bounds.minX) &&
      Number.isFinite(bounds.minY) &&
      Number.isFinite(bounds.maxX) &&
      Number.isFinite(bounds.maxY) &&
      bounds.maxX >= bounds.minX &&
      bounds.maxY >= bounds.minY,
  );
}

export function sessionFlowMiniMapCellToNormalized(
  cellX: number,
  cellY: number,
  width: number,
  height: number,
): SessionFlowMiniMapPoint {
  const resolvedWidth = dimension(width);
  const resolvedHeight = dimension(height);
  return {
    x:
      resolvedWidth <= 1
        ? 0.5
        : clamp(finite(cellX) / (resolvedWidth - 1), 0, 1),
    y:
      resolvedHeight <= 1
        ? 0.5
        : clamp(finite(cellY) / (resolvedHeight - 1), 0, 1),
  };
}

export function sessionFlowMiniMapNormalizedToWorld(
  point: SessionFlowMiniMapPoint,
  bounds: SessionFlowMiniMapWorldBounds,
): SessionFlowMiniMapPoint {
  const x = clamp(finite(point.x, 0.5), 0, 1);
  const y = clamp(finite(point.y, 0.5), 0, 1);
  return {
    x: finite(bounds.minX) + x * Math.max(0, worldSpan(bounds, "x")),
    y: finite(bounds.minY) + y * Math.max(0, worldSpan(bounds, "y")),
  };
}

/**
 * Convert a cell relative to the minimap canvas itself (not the surrounding
 * panel or terminal screen) into normalized whole-graph coordinates and,
 * when supplied, coordinates in the enlarged graph layout.
 */
export function sessionFlowMiniMapLocalCellToNavigation(
  localCellX: number,
  localCellY: number,
  canvasWidth: number,
  canvasHeight: number,
  worldBounds?: SessionFlowMiniMapWorldBounds | null,
): SessionFlowMiniMapLocalNavigationTarget | null {
  const width = dimension(canvasWidth);
  const height = dimension(canvasHeight);
  const x = Math.floor(finite(localCellX, -1));
  const y = Math.floor(finite(localCellY, -1));
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const normalized = sessionFlowMiniMapCellToNormalized(x, y, width, height);
  return {
    cell: { x, y },
    normalized,
    world: validWorldBounds(worldBounds)
      ? sessionFlowMiniMapNormalizedToWorld(normalized, worldBounds)
      : null,
  };
}

export function sessionFlowWorldRectToMiniMap(
  viewport: SessionFlowMiniMapWorldBounds,
  layoutBounds: SessionFlowMiniMapWorldBounds,
  width: number,
  height: number,
): SessionFlowMiniMapCellRect | null {
  if (!validWorldBounds(viewport) || !validWorldBounds(layoutBounds)) return null;
  const resolvedWidth = dimension(width);
  const resolvedHeight = dimension(height);
  const xSpan = worldSpan(layoutBounds, "x");
  const ySpan = worldSpan(layoutBounds, "y");
  const normalizedLeft =
    xSpan <= 0
      ? 0
      : clamp((viewport.minX - layoutBounds.minX) / xSpan, 0, 1);
  const normalizedRight =
    xSpan <= 0
      ? 1
      : clamp((viewport.maxX - layoutBounds.minX) / xSpan, 0, 1);
  const normalizedTop =
    ySpan <= 0
      ? 0
      : clamp((viewport.minY - layoutBounds.minY) / ySpan, 0, 1);
  const normalizedBottom =
    ySpan <= 0
      ? 1
      : clamp((viewport.maxY - layoutBounds.minY) / ySpan, 0, 1);

  if (
    viewport.maxX < layoutBounds.minX ||
    viewport.minX > layoutBounds.maxX ||
    viewport.maxY < layoutBounds.minY ||
    viewport.minY > layoutBounds.maxY
  ) {
    return null;
  }

  const left = cellForNormalized(Math.min(normalizedLeft, normalizedRight), resolvedWidth);
  const right = cellForNormalized(Math.max(normalizedLeft, normalizedRight), resolvedWidth);
  const top = cellForNormalized(Math.min(normalizedTop, normalizedBottom), resolvedHeight);
  const bottom = cellForNormalized(Math.max(normalizedTop, normalizedBottom), resolvedHeight);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

function drawViewportRange(
  cells: MutableMiniMapCell[][],
  left: number,
  right: number,
  row: number,
): void {
  const resolvedLeft = Math.min(left, right);
  const resolvedRight = Math.max(left, right);
  const set = (x: number, glyph: string): void => {
    const cell = cells[row]?.[x];
    if (!cell) return;
    cell.glyph = glyph;
    cell.tone = "viewport";
  };
  if (resolvedLeft === resolvedRight) {
    set(resolvedLeft, "□");
    return;
  }
  set(resolvedLeft, "[");
  set(resolvedRight, "]");
  for (let x = resolvedLeft + 1; x < resolvedRight; x += 1) {
    set(x, "━");
  }
}

/**
 * Build a fixed-cell progress projection. The detailed block graph remains in
 * the enlarged canvas; this map deliberately compresses each run into a
 * chronological left-to-right lane so operators can read input, live work,
 * output, and the current viewport without reproducing every edge crossing.
 */
export function projectSessionFlowMiniMap(
  state: SessionFlowState,
  options: SessionFlowMiniMapProjectionOptions,
): SessionFlowMiniMapProjection {
  const width = dimension(options.width);
  const height = dimension(options.height);
  const progressRows = height > 1 ? height - 1 : 1;
  const layout = layoutSessionFlow(state, {
    detailLevel: "detailed",
    collapsedIds: [],
    autoCollapseDetails: false,
    compact: true,
    nodeWidth: 4,
    nodeHeight: 1,
    horizontalGap: 2,
    verticalGap: 1,
    padding: 0,
  });
  const selectedNodeId =
    options.selectedNodeId &&
    state.nodes.some((item) => item.id === options.selectedNodeId)
      ? options.selectedNodeId
      : null;
  const orderedNodes = [...state.nodes].sort(
    (left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const runOrder = [...new Set(orderedNodes.map((node) => node.runId))];
  const runRow = new Map(
    runOrder.map((runId, index) => [runId, index % progressRows] as const),
  );
  // The layout already separates causal position from observed receipt
  // recency. Reuse its focus markers so a future Output placeholder does not
  // appear active merely because it is rightmost in the causal lane.
  const latestNodeId = layout.latestNodeId;
  const activeNodeId = layout.activeNodeId;
  const nodes: SessionFlowMiniMapNode[] = [];

  for (const [index, item] of orderedNodes.entries()) {
    const normalized = {
      x:
        orderedNodes.length <= 1
          ? 0.5
          : index / (orderedNodes.length - 1),
      y:
        progressRows <= 1
          ? 0.5
          : (runRow.get(item.runId) ?? 0) / (progressRows - 1),
    };
    const position = {
      x: cellForNormalized(normalized.x, width),
      y: runRow.get(item.runId) ?? 0,
    };
    nodes.push({
      id: item.id,
      node: item,
      x: position.x,
      y: position.y,
      normalized,
      selected: item.id === selectedNodeId,
      active: item.id === activeNodeId,
      latest: item.id === latestNodeId,
    });
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgesByEndpoints = new Map<string, SessionFlowMiniMapEdge>();
  for (const edge of layout.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const key = `${edge.source}:${edge.target}`;
    const semantics = sessionFlowEdgeSemantics(edge, target.node);
    const candidate: SessionFlowMiniMapEdge = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      labels: [semantics.shortLabel],
      relation: semantics.relation,
      tone: semantics.tone,
      lineStyle: semantics.lineStyle,
      arrow: semantics.arrow,
      points: straightLine(source, target),
    };
    const existing = edgesByEndpoints.get(key);
    if (!existing) {
      edgesByEndpoints.set(key, candidate);
      continue;
    }
    const labels = [...new Set([...existing.labels, ...candidate.labels])];
    if (shouldPreferMiniMapEdge(candidate, existing)) {
      edgesByEndpoints.set(key, { ...candidate, labels });
    } else {
      existing.labels = labels;
    }
  }
  const edges = [...edgesByEndpoints.values()];
  const cells: MutableMiniMapCell[][] = Array.from(
    { length: height },
    () =>
      Array.from(
        { length: width },
        (): MutableMiniMapCell => ({ glyph: " ", tone: null, nodeIds: [] }),
      ),
  );

  const nodesByRun = new Map<string, SessionFlowMiniMapNode[]>();
  for (const node of nodes) {
    const values = nodesByRun.get(node.node.runId) ?? [];
    values.push(node);
    nodesByRun.set(node.node.runId, values);
  }
  for (const laneNodes of nodesByRun.values()) {
    laneNodes.sort(
      (left, right) =>
        left.node.sequence - right.node.sequence || left.id.localeCompare(right.id),
    );
    const row = laneNodes[0]?.y;
    if (row == null) continue;
    const firstX = laneNodes[0]?.x ?? 0;
    const lastX = laneNodes.at(-1)?.x ?? firstX;
    for (let x = firstX; x <= lastX; x += 1) {
      const cell = cells[row]?.[x];
      if (!cell) continue;
      cell.glyph = "─";
      cell.tone = "dim";
    }
    for (let index = 1; index < laneNodes.length; index += 1) {
      const source = laneNodes[index - 1]!;
      const target = laneNodes[index]!;
      for (let x = source.x + 1; x < target.x; x += 1) {
        const cell = cells[row]?.[x];
        if (!cell) continue;
        cell.glyph = "━";
        cell.tone = progressTone(target.node.status);
      }
    }
  }

  const worldViewportRect =
    options.layoutBounds && options.viewportWorldBounds
      ? sessionFlowWorldRectToMiniMap(
          options.viewportWorldBounds,
          options.layoutBounds,
          width,
          1,
        )
      : null;
  const viewportRect = worldViewportRect
    ? {
        ...worldViewportRect,
        top: height - 1,
        bottom: height - 1,
        height: 1,
      }
    : null;
  if (viewportRect && height > 1) {
    drawViewportRange(
      cells,
      viewportRect.left,
      viewportRect.right,
      viewportRect.top,
    );
  }

  const nodesByCell = new Map<string, SessionFlowMiniMapNode[]>();
  for (const node of nodes) {
    const values = nodesByCell.get(cellKey(node)) ?? [];
    values.push(node);
    nodesByCell.set(cellKey(node), values);
  }
  for (const values of nodesByCell.values()) {
    values.sort(
      (left, right) =>
        markerPriority(right) - markerPriority(left) ||
        right.node.sequence - left.node.sequence ||
        left.id.localeCompare(right.id),
    );
    const top = values[0];
    if (!top) continue;
    const cell = cells[top.y]?.[top.x];
    if (!cell) continue;
    cell.glyph = markerGlyph(top);
    cell.tone = markerTone(top);
    cell.nodeIds = values.map((node) => node.id);
  }

  const frozenCells = cells.map((row) =>
    row.map((cell) => ({ ...cell, nodeIds: [...cell.nodeIds] })),
  );
  return {
    width,
    height,
    nodes,
    edges,
    cells: frozenCells,
    lines: frozenCells.map((row) => row.map((cell) => cell.glyph).join("")),
    hitMap: frozenCells.map((row) =>
      row.map((cell) => cell.nodeIds[0] ?? null),
    ),
    nodeIdsByCell: frozenCells.map((row) =>
      row.map((cell) => [...cell.nodeIds]),
    ),
    selectedNodeId,
    activeNodeId,
    latestNodeId,
    progress: progressSummary(orderedNodes),
    viewportRect,
    projectionBounds: layout.bounds,
  };
}

export function sessionFlowMiniMapNavigationAtCell(
  projection: SessionFlowMiniMapProjection,
  cellX: number,
  cellY: number,
  worldBounds?: SessionFlowMiniMapWorldBounds | null,
): SessionFlowMiniMapNavigationTarget | null {
  const local = sessionFlowMiniMapLocalCellToNavigation(
    cellX,
    cellY,
    projection.width,
    projection.height,
    worldBounds,
  );
  if (!local) return null;
  const { x, y } = local.cell;
  const nodeIds = [...(projection.nodeIdsByCell[y]?.[x] ?? [])];
  return {
    ...local,
    nodeId: nodeIds[0] ?? null,
    nodeIds,
  };
}

function nodeSummary(
  id: string | null,
  projection: SessionFlowMiniMapProjection,
): string {
  if (!id) return "none";
  const item = projection.nodes.find((node) => node.id === id);
  return item ? `${item.node.label} (${item.id})` : id;
}

/** Flat summary used instead of decorative graph cells in screen-reader mode. */
export function sessionFlowMiniMapTextSummary(
  projection: SessionFlowMiniMapProjection,
  contextLabel = "Whole session graph",
): string {
  const scope = contextLabel.trim() || "Whole session graph";
  return [
    `${scope}: ${projection.nodes.length} node${projection.nodes.length === 1 ? "" : "s"}`,
    `${projection.progress.percentage}% settled`,
    `${projection.progress.settled} of ${projection.progress.total} observed milestones terminal`,
    `${projection.progress.running} running`,
    `${projection.progress.adverse} adverse`,
    `selected ${nodeSummary(projection.selectedNodeId, projection)}`,
    `active ${nodeSummary(projection.activeNodeId, projection)}`,
    `latest ${nodeSummary(projection.latestNodeId, projection)}`,
    "lanes move from input on the left to output on the right",
    "line color shows the status of the next observed milestone",
    projection.viewportRect ? "viewport shown" : "viewport not shown",
  ].join(". ") + ".";
}
