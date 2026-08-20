import type {
  SessionFlowEdge,
  SessionFlowEdgeKind,
  SessionFlowNode,
  SessionFlowNodeKind,
  SessionFlowState,
} from "./sessionFlow.js";

export type SessionFlowDetailLevel = "overview" | "detailed";
export type SessionFlowLayoutDensity = "normal" | "compact";
export type SessionFlowArrowDirection = "left" | "right" | "up" | "down";
export type SessionFlowRouteKind = "forward" | "backward" | "retry";
export type SessionFlowLineStyle = "solid" | "dashed" | "dotted";

export interface SessionFlowLayoutPoint {
  x: number;
  y: number;
}

export interface SessionFlowLayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface SessionFlowLayoutNode {
  id: string;
  node: SessionFlowNode;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  row: number;
  collapsed: boolean;
  explicitlyCollapsed: boolean;
  visibleChildCount: number;
  hiddenChildCount: number;
  active: boolean;
  latest: boolean;
}

export interface SessionFlowLayoutEdge {
  id: string;
  edge: SessionFlowEdge;
  source: string;
  target: string;
  kind: SessionFlowEdgeKind;
  originalEdgeIds: string[];
  points: SessionFlowLayoutPoint[];
  arrowDirection: SessionFlowArrowDirection;
  routeKind: SessionFlowRouteKind;
  backward: boolean;
  retryLike: boolean;
  /**
   * The receipt linked a later event back to an earlier event. The canvas
   * renders that relation in chronological order so every directional arrow
   * still travels from the input side (left) to the output side (right).
   */
  chronologyNormalized?: boolean;
  lineStyle: SessionFlowLineStyle;
}

/** Transparent visual boundary for one durable compound process. */
export interface SessionFlowProcessFrame {
  /** Stable across replay because it derives from runId + processId. */
  id: string;
  runId: string;
  processId: string;
  /** Selectable semantic parent and external dependency endpoint. */
  processNodeId: string;
  label: string;
  branchId?: string;
  memberNodeIds: string[];
  inputNodeId: string;
  outputNodeId: string;
  status: SessionFlowNode["status"];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompactSessionFlowNode {
  id: string;
  label: string;
  kind: SessionFlowNodeKind;
  status: SessionFlowNode["status"];
  column: number;
  row: number;
  collapsed: boolean;
  active: boolean;
  latest: boolean;
}

export interface CompactSessionFlowEdge {
  id: string;
  source: string;
  target: string;
  kind: SessionFlowEdgeKind;
  routeKind: SessionFlowRouteKind;
  arrowDirection: SessionFlowArrowDirection;
}

export interface CompactSessionFlowProjection {
  nodes: CompactSessionFlowNode[];
  edges: CompactSessionFlowEdge[];
  columns: number;
  rows: number;
  activeNodeId: string | null;
  latestNodeId: string | null;
}

export interface SessionFlowLayout {
  detailLevel: SessionFlowDetailLevel;
  density: SessionFlowLayoutDensity;
  nodes: SessionFlowLayoutNode[];
  edges: SessionFlowLayoutEdge[];
  processFrames: SessionFlowProcessFrame[];
  hiddenNodeIds: string[];
  collapsedIds: string[];
  activeNodeId: string | null;
  latestNodeId: string | null;
  focusNodeId: string | null;
  bounds: SessionFlowLayoutBounds;
  compact: CompactSessionFlowProjection;
}

export interface SessionFlowLayoutOptions {
  /**
   * Overview hides model/tool/receipt detail by default. Supplying
   * `collapsedIds` makes collapse state controlled: nodes not in the set are
   * treated as expanded. Detailed mode shows every non-collapsed node.
   */
  detailLevel?: SessionFlowDetailLevel;
  collapsedIds?: Iterable<string>;
  /**
   * Optional convenience for expanding selected overview containers while
   * leaving the remaining detail-bearing containers auto-collapsed.
   */
  expandedIds?: Iterable<string>;
  /**
   * Keep overview model/tool/receipt children folded even when collapse state
   * is controlled. The TUI uses this so per-container expansion does not
   * accidentally reveal every detail block in the session.
   */
  autoCollapseDetails?: boolean;
  /** Preserve x/y/layer/row for nodes shared with an earlier layout. */
  previous?: SessionFlowLayout | null;
  previousLayout?: SessionFlowLayout | null;
  /** Use smaller terminal-cell node dimensions and gaps. */
  compact?: boolean;
  nodeWidth?: number;
  nodeHeight?: number;
  horizontalGap?: number;
  verticalGap?: number;
  padding?: number;
}

interface ProjectedEdge {
  id: string;
  source: string;
  target: string;
  kind: SessionFlowEdgeKind;
  originalEdgeIds: string[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DETAIL_KINDS = new Set<SessionFlowNodeKind>([
  "model",
  "tool",
  "receipt",
]);

const RETRY_PATTERN =
  /(^|[^a-z])(retry|rerun|re-run|rollback|backtrack|revisit|recover|resume|again|loop|replan|repair)([^a-z]|$)/i;

const EDGE_KIND_ORDER: Record<SessionFlowEdgeKind, number> = {
  contains: 0,
  sequence: 1,
  handoff: 2,
};

function integerAtLeast(value: number | undefined, fallback: number, minimum: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function compareNodes(a: SessionFlowNode, b: SessionFlowNode): number {
  return a.sequence - b.sequence || a.id.localeCompare(b.id);
}

function observedSequence(node: SessionFlowNode): number {
  if (node.observedSequence === null) return Number.NEGATIVE_INFINITY;
  return node.observedSequence ?? node.sequence;
}

function compareObservedNodes(a: SessionFlowNode, b: SessionFlowNode): number {
  return observedSequence(a) - observedSequence(b) || compareNodes(a, b);
}

function iterableSet(values: Iterable<string> | undefined): Set<string> {
  return new Set(values ?? []);
}

function isMainScope(node: SessionFlowNode): boolean {
  return !node.scope || node.scope === `${node.runId}:main`;
}

function isOutputNode(node: SessionFlowNode): boolean {
  return (
    node.kind === "result"
    || node.eventType === "major_output"
    || node.eventType === "result"
    || node.eventType === "final"
    || node.eventType === "run_finished"
    || /(^|_)(output|result|receipt|finish|complete)(ed)?$/.test(node.eventType)
  );
}

function parentChain(
  node: SessionFlowNode,
  nodeById: ReadonlyMap<string, SessionFlowNode>,
): SessionFlowNode[] {
  const parents: SessionFlowNode[] = [];
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodeById.get(parentId);
    if (!parent) break;
    parents.push(parent);
    parentId = parent.parentId;
  }
  return parents;
}

function hasAncestorIn(
  node: SessionFlowNode,
  ids: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, SessionFlowNode>,
): boolean {
  return parentChain(node, nodeById).some((parent) => ids.has(parent.id));
}

function isDescendantOf(
  node: SessionFlowNode,
  ancestorId: string,
  nodeById: ReadonlyMap<string, SessionFlowNode>,
): boolean {
  return parentChain(node, nodeById).some((parent) => parent.id === ancestorId);
}

function visibleNodesFor(
  nodes: readonly SessionFlowNode[],
  nodeById: ReadonlyMap<string, SessionFlowNode>,
  detailLevel: SessionFlowDetailLevel,
  explicitCollapsedIds: ReadonlySet<string>,
  expandedIds: ReadonlySet<string>,
  controlledCollapse: boolean,
): {
  visible: SessionFlowNode[];
  hidden: SessionFlowNode[];
} {
  const visible: SessionFlowNode[] = [];
  const hidden: SessionFlowNode[] = [];

  for (const node of nodes) {
    const belowCollapsedNode = hasAncestorIn(node, explicitCollapsedIds, nodeById);
    const overviewDetailHidden =
      detailLevel === "overview" &&
      DETAIL_KINDS.has(node.kind) &&
      !controlledCollapse &&
      !hasAncestorIn(node, expandedIds, nodeById);
    if (belowCollapsedNode || overviewDetailHidden) {
      hidden.push(node);
    } else {
      visible.push(node);
    }
  }

  return { visible, hidden };
}

function representativeId(
  nodeId: string,
  visibleIds: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, SessionFlowNode>,
): string | null {
  let current = nodeById.get(nodeId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (visibleIds.has(current.id)) return current.id;
    current = current.parentId ? nodeById.get(current.parentId) : undefined;
  }
  return null;
}

function projectEdges(
  state: SessionFlowState,
  visibleNodes: readonly SessionFlowNode[],
  nodeById: ReadonlyMap<string, SessionFlowNode>,
): ProjectedEdge[] {
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const projected = new Map<string, ProjectedEdge>();

  const add = (
    kind: SessionFlowEdgeKind,
    sourceId: string,
    targetId: string,
    originalEdgeId?: string,
  ): void => {
    const source = representativeId(sourceId, visibleIds, nodeById);
    const target = representativeId(targetId, visibleIds, nodeById);
    if (!source || !target || source === target) return;
    const key = `${kind}:${source}:${target}`;
    const existing = projected.get(key);
    if (existing) {
      if (originalEdgeId && !existing.originalEdgeIds.includes(originalEdgeId)) {
        existing.originalEdgeIds.push(originalEdgeId);
      }
      return;
    }
    projected.set(key, {
      id: key,
      source,
      target,
      kind,
      originalEdgeIds: originalEdgeId ? [originalEdgeId] : [],
    });
  };

  for (const edge of state.edges) {
    add(edge.kind, edge.source, edge.target, edge.id);
  }

  // Parent links are structural input even when a caller constructed a state
  // without duplicating every parentId as a contains edge.
  for (const node of state.nodes) {
    if (node.parentId) add("contains", node.parentId, node.id);
  }

  return [...projected.values()].sort((a, b) => {
    const sourceA = nodeById.get(a.source);
    const sourceB = nodeById.get(b.source);
    const targetA = nodeById.get(a.target);
    const targetB = nodeById.get(b.target);
    return (
      (sourceA?.sequence ?? 0) - (sourceB?.sequence ?? 0) ||
      (targetA?.sequence ?? 0) - (targetB?.sequence ?? 0) ||
      EDGE_KIND_ORDER[a.kind] - EDGE_KIND_ORDER[b.kind] ||
      a.id.localeCompare(b.id)
    );
  });
}

function retryText(
  edge: ProjectedEdge,
  source: SessionFlowNode,
  target: SessionFlowNode,
): string {
  return [
    edge.id,
    ...edge.originalEdgeIds,
    source.eventType,
    source.label,
    source.detail,
    target.eventType,
    target.label,
    target.detail,
  ].join(" ");
}

function isExplicitWorkflowForwardEdge(
  edge: ProjectedEdge,
  source: SessionFlowNode,
  target: SessionFlowNode,
): boolean {
  if (edge.kind !== "sequence") return false;
  if (source.processNode === true && target.processNode === true) {
    return Boolean(
      source.processId
      && target.dependsOnNodeIds?.includes(source.processId),
    );
  }
  if (source.processNode === true && target.joinId) {
    return Boolean(
      source.processId
      && target.expectedNodeIds?.includes(source.processId),
    );
  }
  if (source.joinId && target.processNode === true) {
    return Boolean(target.dependsOnNodeIds?.includes(source.joinId));
  }
  if (source.joinId && target.joinId) {
    return Boolean(
      target.expectedNodeIds?.includes(source.joinId),
    );
  }
  if (
    source.processNode === true
    && (target.eventType === "workflow_output_committed"
      || target.eventType === "major_output")
  ) {
    return true;
  }
  if (source.processMember === true && target.processMember === true) {
    return source.processId === target.processId
      || Boolean(
        source.processId
        && target.dependsOnNodeIds?.includes(source.processId),
      );
  }
  if (source.processMember === true && target.joinId) {
    return Boolean(
      source.processId
      && target.expectedNodeIds?.includes(source.processId),
    );
  }
  if (source.joinId && target.processMember === true) {
    return Boolean(target.dependsOnNodeIds?.includes(source.joinId));
  }
  return Boolean(
    source.processMember === true
    && target.eventType === "workflow_output_committed"
    && source.processId
    && source.processId === target.processId,
  );
}

function inferLayers(
  visibleNodes: readonly SessionFlowNode[],
  projectedEdges: readonly ProjectedEdge[],
  nodeById: ReadonlyMap<string, SessionFlowNode>,
): Map<string, number> {
  const layers = new Map<string, number>();
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleMemberCount = new Map<string, number>();
  for (const node of visibleNodes) {
    if (node.processMember !== true || !node.parentId) continue;
    visibleMemberCount.set(
      node.parentId,
      (visibleMemberCount.get(node.parentId) ?? 0) + 1,
    );
  }
  const incoming = new Map<string, ProjectedEdge[]>();
  for (const edge of projectedEdges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const sourceFirst = isExplicitWorkflowForwardEdge(edge, source, target)
      ||
      source.sequence < target.sequence
      || (
        source.sequence === target.sequence
        && source.id.localeCompare(target.id) <= 0
      );
    const chronologicalEdge = sourceFirst
      ? edge
      : { ...edge, source: edge.target, target: edge.source };
    const values = incoming.get(chronologicalEdge.target) ?? [];
    values.push(chronologicalEdge);
    incoming.set(chronologicalEdge.target, values);
  }

  const nodes = [...visibleNodes].sort(compareNodes);
  // Explicit process/join topology can point opposite receipt chronology
  // (a waiting barrier is normally observed before its branches start).
  // Relax the bounded DAG until those causal constraints settle.
  for (let pass = 0; pass < Math.max(1, nodes.length); pass += 1) {
    const previousByScope = new Map<string, SessionFlowNode>();
    let changed = false;
    for (const node of nodes) {
      let layer = Math.max(layers.get(node.id) ?? 0, node.parentId ? 1 : 0);
      for (const edge of incoming.get(node.id) ?? []) {
        const source = nodeById.get(edge.source);
        const internalProcessEdge =
          source?.processNode === true && node.parentId === source.id;
        const processSpan =
          source?.processNode === true
          && visibleIds.has(source.id)
          && !internalProcessEdge
            ? (visibleMemberCount.get(source.id) ?? 0) + 1
            : 1;
        layer = Math.max(
          layer,
          (layers.get(edge.source) ?? 0) + processSpan,
        );
      }

      // Even sparse event streams remain a left-to-right timeline inside each
      // execution lane. Explicit edges can add stronger constraints, but an
      // omitted sequence edge must never stack a later receipt on top of an
      // earlier input.
      const scope = node.scope || `${node.runId}:main`;
      const previousInScope = previousByScope.get(scope);
      if (
        previousInScope
        && previousInScope.runId === node.runId
        && !previousInScope.joinId
        && !node.joinId
        && previousInScope.processNode !== true
        && previousInScope.processMember !== true
        && node.processNode !== true
        && node.processMember !== true
      ) {
        layer = Math.max(layer, (layers.get(previousInScope.id) ?? 0) + 1);
      }

      // Main-lane receipts after parallel work form a deterministic
      // convergence barrier when no explicit join telemetry is available.
      if (isMainScope(node) || isOutputNode(node)) {
        for (const earlier of nodes) {
          if (earlier.sequence >= node.sequence) break;
          if (earlier.runId !== node.runId) continue;
          if (!isOutputNode(node) && isMainScope(earlier)) continue;
          layer = Math.max(layer, (layers.get(earlier.id) ?? 0) + 1);
        }
      }

      if (layer !== layers.get(node.id)) changed = true;
      layers.set(node.id, layer);
      previousByScope.set(scope, node);
    }
    if (!changed) break;
  }
  return layers;
}

function inferRows(visibleNodes: readonly SessionFlowNode[]): Map<string, number> {
  const nodes = [...visibleNodes].sort(compareNodes);
  const runs = new Map<string, SessionFlowNode[]>();
  for (const node of nodes) {
    const values = runs.get(node.runId) ?? [];
    values.push(node);
    runs.set(node.runId, values);
  }

  const orderedRuns = [...runs.entries()].sort((a, b) => {
    const firstA = a[1][0];
    const firstB = b[1][0];
    return (
      (firstA?.sequence ?? 0) - (firstB?.sequence ?? 0) ||
      a[0].localeCompare(b[0])
    );
  });

  const rowByNode = new Map<string, number>();
  let nextRow = 0;
  for (const [, runNodes] of orderedRuns) {
    const scopes = new Map<string, SessionFlowNode[]>();
    for (const node of runNodes) {
      const scope = node.harnessId
        ? `harness:${node.harnessId}`
        : node.scope || `${node.runId}:main`;
      const values = scopes.get(scope) ?? [];
      values.push(node);
      scopes.set(scope, values);
    }
    const orderedScopes = [...scopes.entries()].sort((a, b) => {
      const aMain = a[0] === `${a[1][0]?.runId}:main`;
      const bMain = b[0] === `${b[1][0]?.runId}:main`;
      if (aMain !== bMain) return aMain ? -1 : 1;
      return (
        (a[1][0]?.sequence ?? 0) - (b[1][0]?.sequence ?? 0) ||
        a[0].localeCompare(b[0])
      );
    });
    for (const [, scopeNodes] of orderedScopes) {
      for (const node of scopeNodes) rowByNode.set(node.id, nextRow);
      nextRow += 1;
    }
  }
  return rowByNode;
}

function rectanglesOverlap(a: Rect, b: Rect, gap: number): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

function edgeLineStyle(kind: SessionFlowEdgeKind): SessionFlowLineStyle {
  if (kind === "contains") return "dotted";
  if (kind === "handoff") return "dashed";
  return "solid";
}

function removeDuplicateAndCollinearPoints(
  points: readonly SessionFlowLayoutPoint[],
): SessionFlowLayoutPoint[] {
  const unique: SessionFlowLayoutPoint[] = [];
  for (const point of points) {
    const previous = unique.at(-1);
    if (!previous || previous.x !== point.x || previous.y !== point.y) {
      unique.push(point);
    }
  }

  const result: SessionFlowLayoutPoint[] = [];
  for (const point of unique) {
    const previous = result.at(-1);
    const beforePrevious = result.at(-2);
    if (
      beforePrevious &&
      previous &&
      ((beforePrevious.x === previous.x && previous.x === point.x) ||
        (beforePrevious.y === previous.y && previous.y === point.y))
    ) {
      result[result.length - 1] = point;
    } else {
      result.push(point);
    }
  }
  return result;
}

function arrowDirection(
  points: readonly SessionFlowLayoutPoint[],
): SessionFlowArrowDirection {
  const end = points.at(-1);
  const previous = points.at(-2);
  if (!end || !previous) return "right";
  if (end.x > previous.x) return "right";
  if (end.x < previous.x) return "left";
  if (end.y > previous.y) return "down";
  return "up";
}

function nodeBounds(nodes: readonly SessionFlowLayoutNode[]): SessionFlowLayoutBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function processFrameId(runId: string, processId: string): string {
  return `process-frame:${encodeURIComponent(runId)}:${encodeURIComponent(processId)}`;
}

function aggregateFrameStatus(
  nodes: readonly SessionFlowLayoutNode[],
): SessionFlowNode["status"] {
  const statuses = new Set(nodes.map((item) => item.node.status));
  if (statuses.has("failed")) return "failed";
  if (statuses.has("blocked")) return "blocked";
  if (statuses.has("cancelled")) return "cancelled";
  if (statuses.has("running")) return "running";
  if (statuses.has("pending")) return "pending";
  if (statuses.size === 1 && statuses.has("succeeded")) return "succeeded";
  return "info";
}

function buildProcessFrames(
  nodes: readonly SessionFlowLayoutNode[],
): SessionFlowProcessFrame[] {
  const nodeById = new Map(nodes.map((item) => [item.id, item] as const));
  const groups = new Map<string, SessionFlowLayoutNode[]>();
  for (const item of nodes) {
    if (!item.node.processId || item.node.processMember !== true) continue;
    const key = `${item.node.runId}\u0000${item.node.processId}`;
    const members = groups.get(key) ?? [];
    members.push(item);
    groups.set(key, members);
  }

  return [...groups.values()]
    .map((members): SessionFlowProcessFrame => {
      members.sort((left, right) =>
        left.layer - right.layer
        || left.node.sequence - right.node.sequence
        || left.id.localeCompare(right.id));
      const first = members[0]!;
      const last = members.at(-1)!;
      const semanticProcessNode = first.node.parentId
        ? nodeById.get(first.node.parentId)
        : undefined;
      const processNode = semanticProcessNode?.node.processNode === true
        ? semanticProcessNode
        : undefined;
      const minX = Math.min(...members.map((item) => item.x));
      const minY = Math.min(...members.map((item) => item.y));
      const maxX = Math.max(...members.map((item) => item.x + item.width));
      const maxY = Math.max(...members.map((item) => item.y + item.height));
      const leftPadding = Math.min(1, minX);
      const topPadding = Math.min(1, minY);
      return {
        id: processFrameId(first.node.runId, first.node.processId!),
        runId: first.node.runId,
        processId: first.node.processId!,
        processNodeId: processNode?.id ?? first.id,
        label: first.node.processLabel || first.node.processId!,
        ...(first.node.branchId ? { branchId: first.node.branchId } : {}),
        memberNodeIds: members.map((item) => item.id),
        inputNodeId: processNode?.id ?? first.id,
        outputNodeId: processNode?.id ?? last.id,
        status: processNode?.node.status ?? aggregateFrameStatus(members),
        x: minX - leftPadding,
        y: minY - topPadding,
        width: maxX - minX + leftPadding + 1,
        height: maxY - minY + topPadding + 1,
      };
    })
    .sort((left, right) =>
      left.x - right.x || left.y - right.y || left.id.localeCompare(right.id));
}

function fullBounds(
  nodes: readonly SessionFlowLayoutNode[],
  edges: readonly SessionFlowLayoutEdge[],
  processFrames: readonly SessionFlowProcessFrame[] = [],
): SessionFlowLayoutBounds {
  if (nodes.length === 0 && edges.length === 0 && processFrames.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  const nodeBox = nodeBounds(nodes);
  const points = edges.flatMap((edge) => edge.points);
  const minX = Math.min(
    nodeBox.minX,
    ...points.map((point) => point.x),
    ...processFrames.map((frame) => frame.x),
  );
  const minY = Math.min(
    nodeBox.minY,
    ...points.map((point) => point.y),
    ...processFrames.map((frame) => frame.y),
  );
  const maxX = Math.max(
    nodeBox.maxX,
    ...points.map((point) => point.x + 1),
    ...processFrames.map((frame) => frame.x + frame.width),
  );
  const maxY = Math.max(
    nodeBox.maxY,
    ...points.map((point) => point.y + 1),
    ...processFrames.map((frame) => frame.y + frame.height),
  );
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function routeEdges(
  projectedEdges: readonly ProjectedEdge[],
  layoutNodeById: ReadonlyMap<string, SessionFlowLayoutNode>,
  preliminaryBounds: SessionFlowLayoutBounds,
  nodeById: ReadonlyMap<string, SessionFlowNode>,
  processFrames: readonly SessionFlowProcessFrame[],
  routeGap: number,
): SessionFlowLayoutEdge[] {
  const frameByNodeId = new Map<string, SessionFlowProcessFrame>();
  for (const frame of processFrames) {
    frameByNodeId.set(frame.processNodeId, frame);
    for (const memberId of frame.memberNodeIds) {
      frameByNodeId.set(memberId, frame);
    }
  }
  let detourIndex = 0;
  return projectedEdges.flatMap((projected): SessionFlowLayoutEdge[] => {
    const originalSource = layoutNodeById.get(projected.source);
    const originalTarget = layoutNodeById.get(projected.target);
    const sourceNode = nodeById.get(projected.source);
    const targetNode = nodeById.get(projected.target);
    if (!originalSource || !originalTarget || !sourceNode || !targetNode) {
      return [];
    }

    const explicitWorkflowForward = isExplicitWorkflowForwardEdge(
      projected,
      sourceNode,
      targetNode,
    );
    const retryLike =
      !explicitWorkflowForward
      && (
        sourceNode.sequence >= targetNode.sequence
        || RETRY_PATTERN.test(retryText(projected, sourceNode, targetNode))
      );
    const backward =
      !explicitWorkflowForward
      && (
        sourceNode.sequence >= targetNode.sequence
        || originalTarget.layer < originalSource.layer
      );
    const chronologyNormalized =
      !explicitWorkflowForward
      && (
        sourceNode.sequence > targetNode.sequence
        || (
          sourceNode.sequence === targetNode.sequence
          && originalSource.layer > originalTarget.layer
        )
      );
    const source = chronologyNormalized ? originalTarget : originalSource;
    const target = chronologyNormalized ? originalSource : originalTarget;
    const sourceFrame = frameByNodeId.get(source.id);
    const targetFrame = frameByNodeId.get(target.id);
    const crossesSourceBoundary =
      sourceFrame != null && sourceFrame.id !== targetFrame?.id;
    const crossesTargetBoundary =
      targetFrame != null && sourceFrame?.id !== targetFrame.id;
    const rightAnchor = (item: SessionFlowLayoutNode): SessionFlowLayoutPoint => ({
      x: crossesSourceBoundary
        ? sourceFrame!.x + sourceFrame!.width - 1
        : item.x + item.width,
      y: item.y + Math.floor(item.height / 2),
    });
    const leftAnchor = (item: SessionFlowLayoutNode): SessionFlowLayoutPoint => ({
      x: crossesTargetBoundary ? targetFrame!.x : item.x,
      y: item.y + Math.floor(item.height / 2),
    });
    const routeKind: SessionFlowRouteKind = backward
      ? retryLike
        ? "retry"
        : "backward"
      : retryLike
        ? "retry"
        : "forward";

    let points: SessionFlowLayoutPoint[];
    const internalContainment =
      projected.kind === "contains"
      && sourceNode.processNode === true
      && targetNode.parentId === sourceNode.id
      && sourceFrame?.id === targetFrame?.id;
    if (internalContainment) {
      const y = target.y + Math.floor(target.height / 2);
      points = [
        { x: sourceFrame!.x, y },
        { x: target.x, y },
      ];
    } else if (retryLike || backward) {
      const index = detourIndex++;
      const start = rightAnchor(source);
      const end = leftAnchor(target);
      const channelY = preliminaryBounds.maxY + routeGap + index * 2;
      points = [
        start,
        { x: start.x + routeGap, y: start.y },
        { x: start.x + routeGap, y: channelY },
        { x: end.x - routeGap, y: channelY },
        { x: end.x - routeGap, y: end.y },
        end,
      ];
    } else if (target.x >= source.x + source.width) {
      const start = rightAnchor(source);
      const end = leftAnchor(target);
      const middleX = Math.floor((start.x + end.x) / 2);
      points = [
        start,
        { x: middleX, y: start.y },
        { x: middleX, y: end.y },
        end,
      ];
    } else {
      const targetBelow = target.y >= source.y;
      const start = {
        x: source.x + Math.floor(source.width / 2),
        y: targetBelow ? source.y + source.height : source.y,
      };
      const end = {
        x: target.x + Math.floor(target.width / 2),
        y: targetBelow ? target.y : target.y + target.height,
      };
      const middleY = Math.floor((start.y + end.y) / 2);
      points = [
        start,
        { x: start.x, y: middleY },
        { x: end.x, y: middleY },
        end,
      ];
    }

    points = removeDuplicateAndCollinearPoints(points);
    const syntheticEdge: SessionFlowEdge = {
      id: projected.id,
      source: projected.source,
      target: projected.target,
      kind: projected.kind,
    };
    return [{
      id: projected.id,
      edge: syntheticEdge,
      source: source.id,
      target: target.id,
      kind: projected.kind,
      originalEdgeIds: [...projected.originalEdgeIds],
      points,
      arrowDirection: arrowDirection(points),
      routeKind,
      backward,
      retryLike,
      chronologyNormalized,
      lineStyle: edgeLineStyle(projected.kind),
    }];
  });
}

export function projectCompactSessionFlowLayout(
  layout: Pick<
    SessionFlowLayout,
    "nodes" | "edges" | "activeNodeId" | "latestNodeId"
  >,
): CompactSessionFlowProjection {
  const nodes = layout.nodes.map((item) => ({
    id: item.id,
    label: item.node.label,
    kind: item.node.kind,
    status: item.node.status,
    column: item.layer,
    row: item.row,
    collapsed: item.collapsed,
    active: item.active,
    latest: item.latest,
  }));
  return {
    nodes,
    edges: layout.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      routeKind: edge.routeKind,
      arrowDirection: edge.arrowDirection,
    })),
    columns: nodes.length === 0
      ? 0
      : Math.max(...nodes.map((node) => node.column)) + 1,
    rows: nodes.length === 0
      ? 0
      : Math.max(...nodes.map((node) => node.row)) + 1,
    activeNodeId: layout.activeNodeId,
    latestNodeId: layout.latestNodeId,
  };
}

export function layoutSessionFlow(
  state: SessionFlowState,
  options: SessionFlowLayoutOptions = {},
): SessionFlowLayout {
  const detailLevel = options.detailLevel ?? "overview";
  const density: SessionFlowLayoutDensity = options.compact ? "compact" : "normal";
  const compact = density === "compact";
  const nodeWidth = integerAtLeast(options.nodeWidth, compact ? 14 : 24, 4);
  const nodeHeight = integerAtLeast(options.nodeHeight, compact ? 1 : 3, 1);
  const horizontalGap = integerAtLeast(options.horizontalGap, compact ? 3 : 8, 1);
  const verticalGap = integerAtLeast(options.verticalGap, compact ? 1 : 2, 0);
  const padding = integerAtLeast(options.padding, compact ? 0 : 1, 0);
  const explicitCollapsedIds = iterableSet(options.collapsedIds);
  const expandedIds = iterableSet(options.expandedIds);
  const controlledCollapse = options.collapsedIds !== undefined;
  const autoCollapseDetails =
    options.autoCollapseDetails ?? !controlledCollapse;
  const previous = options.previousLayout ?? options.previous ?? null;
  const preservePrevious = previous?.density === density;

  const allNodes = [...state.nodes].sort(compareNodes);
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const { visible, hidden } = visibleNodesFor(
    allNodes,
    nodeById,
    detailLevel,
    explicitCollapsedIds,
    expandedIds,
    !autoCollapseDetails,
  );
  const visibleIds = new Set(visible.map((node) => node.id));
  const projectedEdges = projectEdges(state, visible, nodeById);
  const inferredLayers = inferLayers(visible, projectedEdges, nodeById);
  const inferredRows = inferRows(visible);
  const hasProcessMembers = visible.some(
    (node) => node.processId && node.processMember === true,
  );
  const layoutPadding = padding + (hasProcessMembers ? 1 : 0);

  const latestOriginal = [...allNodes].sort(compareObservedNodes).at(-1);
  const latestNodeId = latestOriginal
    ? representativeId(latestOriginal.id, visibleIds, nodeById)
    : null;
  const activeOriginal = state.activeRunId
    ? allNodes
      .filter((node) => node.runId === state.activeRunId)
      .sort(compareObservedNodes)
      .at(-1)
    : undefined;
  const activeNodeId = activeOriginal
    ? representativeId(activeOriginal.id, visibleIds, nodeById)
    : null;

  const autoCollapsedIds = new Set<string>();
  if (autoCollapseDetails && detailLevel === "overview") {
    for (const node of hidden) {
      if (!DETAIL_KINDS.has(node.kind)) continue;
      const representative = representativeId(node.id, visibleIds, nodeById);
      if (representative) autoCollapsedIds.add(representative);
    }
  }
  const collapsedIds = new Set([...explicitCollapsedIds, ...autoCollapsedIds]);

  const hiddenChildCount = new Map<string, number>();
  const visibleChildCount = new Map<string, number>();
  for (const parent of visible) {
    hiddenChildCount.set(
      parent.id,
      hidden.filter((node) => isDescendantOf(node, parent.id, nodeById)).length,
    );
    visibleChildCount.set(
      parent.id,
      visible.filter((node) => {
        if (node.id === parent.id) return false;
        const nearestVisibleParent = node.parentId
          ? representativeId(node.parentId, visibleIds, nodeById)
          : null;
        return nearestVisibleParent === parent.id;
      }).length,
    );
  }

  const previousNodeById = new Map(
    preservePrevious
      ? previous.nodes.map((node) => [node.id, node])
      : [],
  );
  // A process frame extends one cell above and below its members. Keep those
  // borders distinct even at map/compact zoom, whose ordinary one-cell lane
  // gap would otherwise make adjacent frames share a horizontal border.
  const effectiveVerticalGap = hasProcessMembers
    ? Math.max(2, verticalGap)
    : verticalGap;
  const rowStep = nodeHeight + effectiveVerticalGap;
  const columnStep = nodeWidth + horizontalGap;
  const occupied: Rect[] = [];
  const positioned = new Map<string, SessionFlowLayoutNode>();

  // Preserve stable lane rows where possible, but always recompute semantic
  // columns and node dimensions. This keeps Output to the right when live
  // topology expands and makes semantic zoom actually resize the graph.
  for (const node of visible) {
    const prior = previousNodeById.get(node.id);
    const layer = inferredLayers.get(node.id) ?? 0;
    // Harness membership is a stronger invariant than legacy row
    // preservation: every role in one harness must remain on one lane.
    let row = node.harnessId
      ? inferredRows.get(node.id) ?? prior?.row ?? 0
      : prior?.row ?? inferredRows.get(node.id) ?? 0;
    const x = layoutPadding + layer * columnStep;
    let y = layoutPadding + row * rowStep;
    let rect: Rect = { x, y, width: nodeWidth, height: nodeHeight };
    while (
      occupied.some((other) =>
        rectanglesOverlap(rect, other, effectiveVerticalGap))
    ) {
      row += 1;
      y += rowStep;
      rect = { ...rect, y };
    }
    const item: SessionFlowLayoutNode = {
      id: node.id,
      node,
      x,
      y,
      width: nodeWidth,
      height: nodeHeight,
      layer,
      row,
      collapsed: collapsedIds.has(node.id),
      explicitlyCollapsed: explicitCollapsedIds.has(node.id),
      visibleChildCount: visibleChildCount.get(node.id) ?? 0,
      hiddenChildCount: hiddenChildCount.get(node.id) ?? 0,
      active: node.id === activeNodeId,
      latest: node.id === latestNodeId,
    };
    positioned.set(node.id, item);
    occupied.push(item);
  }

  const layoutNodes = visible
    .map((node) => positioned.get(node.id))
    .filter((node): node is SessionFlowLayoutNode => Boolean(node));
  const layoutNodeById = new Map(layoutNodes.map((node) => [node.id, node]));
  const processFrames = buildProcessFrames(layoutNodes);
  // Expanded semantic processes occupy their transparent frame geometry for
  // selection, navigation, edge attachment, and export. The terminal scene
  // suppresses the opaque parent block while keeping this ordinary layout
  // node; collapsing the parent hides members and restores its normal block.
  for (const frame of processFrames) {
    const processNode = layoutNodeById.get(frame.processNodeId);
    if (!processNode || processNode.node.processNode !== true) continue;
    processNode.x = frame.x;
    processNode.y = frame.y;
    processNode.width = frame.width;
    processNode.height = frame.height;
  }
  const preliminaryBounds = nodeBounds(layoutNodes);
  const layoutEdges = routeEdges(
    projectedEdges,
    layoutNodeById,
    preliminaryBounds,
    nodeById,
    processFrames,
    Math.max(2, horizontalGap),
  );
  const bounds = fullBounds(layoutNodes, layoutEdges, processFrames);

  const partial = {
    nodes: layoutNodes,
    edges: layoutEdges,
    processFrames,
    activeNodeId,
    latestNodeId,
  };
  return {
    detailLevel,
    density,
    nodes: layoutNodes,
    edges: layoutEdges,
    processFrames,
    hiddenNodeIds: hidden.map((node) => node.id),
    collapsedIds: [...collapsedIds].sort(),
    activeNodeId,
    latestNodeId,
    focusNodeId: activeNodeId ?? latestNodeId,
    bounds,
    compact: projectCompactSessionFlowLayout(partial),
  };
}

export function compactSessionFlowLayout(
  state: SessionFlowState,
  options: Omit<SessionFlowLayoutOptions, "compact"> = {},
): SessionFlowLayout {
  return layoutSessionFlow(state, { ...options, compact: true });
}

export const buildSessionFlowLayout = layoutSessionFlow;
