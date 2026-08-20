import React, { useEffect, useMemo, useRef } from "react";
import { Box, Text } from "ink";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { accessibleTheme } from "../lib/accessibility.js";
import { wrapTextLines } from "../lib/chatLayout.js";
import {
  sessionFlowRunCount,
  sessionFlowStatusGlyph,
  type SessionFlowDrawioEdgeRouteInput,
  type SessionFlowDrawioNodeGeometryInput,
  type SessionFlowDrawioProcessGroup,
  type SessionFlowNode,
  type SessionFlowNodeStatus,
  type SessionFlowState,
} from "../lib/sessionFlow.js";
import {
  type SessionFlowLayout,
} from "../lib/sessionFlowLayout.js";
import {
  describeSessionFlowEdge,
  sessionFlowEdgeSemantics,
} from "../lib/sessionFlowEdgeSemantics.js";
import {
  selectedFlowNodeId,
  type SessionFlowInteractionAction,
  type SessionFlowInteractionState,
} from "../lib/sessionFlowInteraction.js";
import type {
  SessionFlowHierarchyBreadcrumb,
  SessionFlowHierarchyNodeMeta,
} from "../lib/sessionFlowHierarchy.js";
import type { SessionFlowLiveNodeStatus } from "../lib/sessionFlowPresentation.js";
import {
  layoutSessionFlowForInteraction,
  sessionFlowViewportWorldBounds,
  type SessionFlowWorldBounds,
} from "../lib/sessionFlowNavigation.js";
import {
  getSessionFlowZoomPreset,
  type SessionFlowZoomLevel,
} from "../lib/sessionFlowZoom.js";
import { clampSessionFlowPan } from "../lib/sessionFlowViewport.js";
import {
  renderTerminalGraphCanvas,
  type GraphBlockTone,
  type GraphEdgeTone,
  type TerminalGraphCanvasResult,
  type TerminalGraphCellTone,
  type TerminalGraphScene,
} from "../lib/terminalGraphCanvas.js";
import type { Theme } from "../lib/theme.js";
import {
  SessionFlowMiniMap,
  type SessionFlowMiniMapGeometryReport,
} from "./SessionFlowMiniMap.js";
import { MatrixText } from "./MatrixText.js";

export const COMPACT_SESSION_FLOW_ROWS = 8;

type SessionFlowTone =
  | "heading"
  | "text"
  | "dim"
  | "accent"
  | "success"
  | "warn"
  | "error";

export interface SessionFlowRow {
  id: string;
  text: string;
  tone: SessionFlowTone;
  bold?: boolean;
}

interface VisualSessionFlowRow extends SessionFlowRow {
  visualId: string;
}

export interface SessionFlowPanelLayoutReport {
  state: SessionFlowState;
  metadataByNodeId: Record<string, SessionFlowHierarchyNodeMeta>;
  projectionKey: string;
  hierarchyLevel: SessionFlowInteractionState["detailLevel"];
  hierarchyPath: readonly string[];
  focusNodeId: string | null;
  layout: SessionFlowLayout;
  canvas: TerminalGraphCanvasResult;
  selectedNodeId: string | null;
  canvasScreenLeft: number;
  canvasScreenTop: number;
  viewportWidth: number;
  viewportHeight: number;
  panX: number;
  panY: number;
  zoomLevel: SessionFlowZoomLevel;
  viewportWorldBounds: SessionFlowWorldBounds;
}

export interface SessionFlowDrawioGeometry {
  nodeGeometry: SessionFlowDrawioNodeGeometryInput;
  edgeRoutes: SessionFlowDrawioEdgeRouteInput;
  processGroups: readonly SessionFlowDrawioProcessGroup[];
}

function toneForStatus(status: SessionFlowNodeStatus): SessionFlowTone {
  if (status === "running") return "accent";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  if (status === "blocked" || status === "cancelled") return "warn";
  return "text";
}

function colorForTone(tone: SessionFlowTone, theme: Theme): string {
  if (tone === "heading" || tone === "accent") return theme.accent;
  if (tone === "dim") return theme.dim;
  if (tone === "success") return theme.success;
  if (tone === "warn") return theme.warn;
  if (tone === "error") return theme.error;
  return theme.text;
}

function blockTone(node: SessionFlowNode): GraphBlockTone {
  if (node.status === "running") return "accent";
  if (node.status === "succeeded") return "success";
  if (node.status === "failed") return "danger";
  if (node.status === "blocked" || node.status === "cancelled") return "warning";
  if (node.kind === "tool" || node.kind === "model") return "info";
  if (node.status === "pending" || node.status === "info") return "dim";
  return "neutral";
}

function processFrameTone(status: SessionFlowNodeStatus): GraphEdgeTone {
  if (status === "running") return "edge-live";
  if (status === "succeeded") return "edge-success";
  if (status === "failed") return "edge-danger";
  if (status === "blocked" || status === "cancelled") return "edge-warning";
  if (status === "pending") return "edge-queued";
  return "edge-structure";
}

function colorForCanvasTone(
  tone: TerminalGraphCellTone,
  theme: Theme,
): string {
  if (tone === "accent") return theme.accent;
  if (tone === "success") return theme.success;
  if (tone === "warning") return theme.warn;
  if (tone === "danger") return theme.error;
  if (tone === "info") return theme.tool;
  if (tone === "dim" || tone === "edge-dim") return theme.dim;
  if (tone === "edge-structure" || tone === "edge-progress") return theme.tool;
  if (tone === "edge-queued" || tone === "edge-retry") return theme.thinking;
  if (tone === "edge-live") return theme.user;
  if (tone === "edge-success") return theme.success;
  if (tone === "edge-handoff" || tone === "edge-warning") return theme.warn;
  if (tone === "edge-danger") return theme.error;
  if (tone === "edge-label") return theme.accent;
  if (tone === "edge") return theme.tool;
  return theme.text;
}

/**
 * Expose the semantic fast-path topology alongside the spatial canvas.
 *
 * The canvas is the primary interaction surface, but terminal graph blocks
 * do not reliably emit their labels as transcript text (and screen readers
 * need a concise summary). Keep this derived from the visible projection so
 * the operator sees the same declared lane inventory that the graph renders.
 */
export function sessionFlowTopologyText(
  state: SessionFlowState,
): string | null {
  const hasMain = state.nodes.some(
    (node) =>
      node.eventType === "parallel_main_agent"
      || node.label === "Main Agent · Plan & Dispatch",
  );
  const hasSynthesis = state.nodes.some(
    (node) =>
      node.eventType === "parallel_synthesis"
      || node.label === "Synthesis · Main Agent",
  );
  const hasOutput = state.nodes.some(
    (node) =>
      node.eventType === "parallel_output"
      || node.label === "Output · Receipt",
  );
  if (!hasMain || !hasSynthesis || !hasOutput) return null;

  const laneCount = state.nodes.filter(
    (node) =>
      node.eventType === "parallel_lane_process"
      && node.processNode === true,
  ).length;
  if (laneCount === 0) return null;

  const barriers = state.nodes
    .filter((node) => node.eventType === "parallel_barrier")
    .sort((left, right) => left.sequence - right.sequence)
    .map((node) => node.label);

  return [
    "Main Agent · Plan & Dispatch",
    `${laneCount} parallel specialist lane${laneCount === 1 ? "" : "s"}`,
    ...barriers,
    "Synthesis · Main Agent",
    "Output · Receipt",
  ].join(" → ");
}

export function buildSessionFlowRows(
  state: SessionFlowState,
): SessionFlowRow[] {
  const runs = sessionFlowRunCount(state);
  const topology = sessionFlowTopologyText(state);
  const rows: SessionFlowRow[] = [
    {
      id: "flow-title",
      text: `Live session flow · ${runs} run${runs === 1 ? "" : "s"} · ${state.nodes.length} step${state.nodes.length === 1 ? "" : "s"} · ${state.edges.length} edge${state.edges.length === 1 ? "" : "s"}`,
      tone: "heading",
      bold: true,
    },
    {
      id: "flow-scope",
      text: "Observable harness receipts only. Hidden reasoning and raw tool arguments/output are not captured.",
      tone: "dim",
    },
  ];
  if (topology) {
    rows.push({
      id: "flow-topology",
      text: `Topology: ${topology}`,
      tone: "accent",
      bold: true,
    });
  }

  if (state.nodes.length === 0) {
    rows.push({
      id: "flow-empty",
      text: "◇ Waiting for the next accepted bridge event…",
      tone: "dim",
    });
    return rows;
  }

  for (const node of state.nodes) {
    rows.push({
      id: `${node.id}-title`,
      text: `${sessionFlowStatusGlyph(node.status)} [${String(node.sequence).padStart(3, "0")} · ${node.kind}] ${node.label}`,
      tone: toneForStatus(node.status),
      bold: node.status === "running" || node.kind === "run",
    });
    rows.push({
      id: `${node.id}-detail`,
      text: `${node.eventType}${node.detail ? ` · ${node.detail}` : ""}`,
      tone: "dim",
    });
  }
  return rows;
}

export function wrapSessionFlowRows(
  rows: readonly SessionFlowRow[],
  width: number,
): VisualSessionFlowRow[] {
  const columns = Math.max(1, width);
  return rows.flatMap((item) =>
    wrapTextLines(item.text, columns).map((text, index) => ({
      ...item,
      text,
      visualId: `${item.id}:${index}`,
    })),
  );
}

function isPlanned(node: SessionFlowNode): boolean {
  return node.status === "pending";
}

function terminalEdgePoints(
  edge: SessionFlowLayout["edges"][number],
  arrow: boolean,
): Array<{ x: number; y: number }> {
  const points = edge.points.map((point) => ({ ...point }));
  const end = points.at(-1);
  if (!end || !arrow) return points;
  // Layout routes terminate on the target block border for Draw.io. Move the
  // terminal arrowhead one cell outward so block-over-edge painting does not
  // erase the direction marker.
  if (edge.arrowDirection === "right") end.x -= 1;
  if (edge.arrowDirection === "left") end.x += 1;
  if (edge.arrowDirection === "down") end.y -= 1;
  if (edge.arrowDirection === "up") end.y += 1;
  return points;
}

export function sessionFlowSceneForLayout(
  layout: SessionFlowLayout,
  selectedNodeId: string | null,
  zoomLevel: SessionFlowZoomLevel,
  metadataByNodeId: Readonly<Record<string, SessionFlowHierarchyNodeMeta>>,
): TerminalGraphScene {
  const preset = getSessionFlowZoomPreset(zoomLevel);
  const minimal = preset.labelDensity === "minimal";
  const compact = preset.labelDensity === "compact";
  const verbose =
    preset.labelDensity === "detailed" || preset.labelDensity === "full";
  const full = preset.labelDensity === "full";
  const showEdgeLabels = !minimal && !compact;
  const nodeById = new Map(
    layout.nodes.map((item) => [item.id, item.node] as const),
  );
  const expandedProcessNodeIds = new Set(
    layout.processFrames.map((frame) => frame.processNodeId),
  );
  return {
    frames: layout.processFrames.map((frame) => ({
      id: frame.id,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      label: minimal
        ? frame.processId
        : `Process · ${frame.label}${frame.branchId ? ` · ${frame.branchId}` : ""}`,
      tone: processFrameTone(frame.status),
      dashed: frame.status === "pending",
      nodeId: frame.processNodeId,
      selected: frame.processNodeId === selectedNodeId,
    })),
    blocks: layout.nodes
      .filter((item) => !expandedProcessNodeIds.has(item.id))
      .map((item) => {
      const metadata = metadataByNodeId[item.id];
      const compoundSubtitle = metadata?.compound
        ? `${item.node.eventType}${
            metadata.hiddenEventCount > 0
              ? ` · ${metadata.sourceNodeIds.length} events`
              : ""
          }`
        : "";
      return {
      id: item.id,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      title: minimal
        ? `${sessionFlowStatusGlyph(item.node.status)} #${item.node.sequence}`
        : `${sessionFlowStatusGlyph(item.node.status)} ${item.node.label}`,
      subtitle: minimal
        ? undefined
        : compact
          ? item.node.kind
          : compoundSubtitle
            || `${item.node.kind} · #${String(item.node.sequence).padStart(3, "0")}` +
              (item.hiddenChildCount > 0 ? ` · +${item.hiddenChildCount}` : ""),
      detail: verbose
        ? full && item.node.detail
          ? item.node.detail
          : item.node.eventType
        : undefined,
      status: item.active
        ? "LIVE"
        : item.latest
          ? "latest"
          : item.node.status,
      tone: blockTone(item.node),
      selected: item.id === selectedNodeId,
      live: item.active,
      planned: isPlanned(item.node),
    };
    }),
    edges: layout.edges.map((item) => {
      const semantics = sessionFlowEdgeSemantics(
        item,
        nodeById.get(item.target),
      );
      return {
        id: item.id,
        points: terminalEdgePoints(item, semantics.arrow),
        kind: semantics.lineStyle,
        dashed: semantics.lineStyle !== "solid",
        label: showEdgeLabels
          ? verbose
            ? semantics.detailedLabel
            : semantics.shortLabel
          : undefined,
        tone: semantics.tone,
        labelTone: semantics.tone,
        arrow: semantics.arrow,
      };
    }),
  };
}

export function buildSessionFlowEdgeRows(
  layout: SessionFlowLayout,
): SessionFlowRow[] {
  const nodeById = new Map(
    layout.nodes.map((item) => [item.id, item.node] as const),
  );
  return layout.edges.map((edge) => {
    const target = nodeById.get(edge.target);
    return {
      id: `${edge.id}-link`,
      text: `Link: ${describeSessionFlowEdge(
        edge,
        nodeById.get(edge.source),
        target,
      )}`,
      tone: target ? toneForStatus(target.status) : "text",
    };
  });
}

function centeredPan(
  layout: SessionFlowLayout,
  viewportWidth: number,
  viewportHeight: number,
  selectedNodeId: string | null,
): { panX: number; panY: number } {
  const selected =
    layout.nodes.find((node) => node.id === selectedNodeId) ??
    layout.nodes.find((node) => node.active) ??
    layout.nodes.at(-1) ??
    null;
  if (!selected) return { panX: 0, panY: 0 };
  return {
    panX:
      Math.floor(viewportWidth / 2) -
      Math.floor(selected.x + selected.width / 2),
    panY:
      Math.floor(viewportHeight / 2) -
      Math.floor(selected.y + selected.height / 2),
  };
}

export function resolvedSessionFlowPan(
  layout: SessionFlowLayout,
  viewportWidth: number,
  viewportHeight: number,
  interaction: SessionFlowInteractionState,
  selectedNodeId: string | null,
): { panX: number; panY: number } {
  const desired = interaction.followLive
    ? centeredPan(layout, viewportWidth, viewportHeight, selectedNodeId)
    : { panX: interaction.panX, panY: interaction.panY };
  return clampSessionFlowPan(
    desired,
    { width: viewportWidth, height: viewportHeight },
    layout.bounds,
  );
}

function rowSegments(
  row: TerminalGraphCanvasResult["cells"][number],
): Array<{ text: string; tone: TerminalGraphCellTone }> {
  const segments: Array<{ text: string; tone: TerminalGraphCellTone }> = [];
  for (const cell of row) {
    const previous = segments.at(-1);
    if (previous && previous.tone === cell.tone) {
      previous.text += cell.glyph;
    } else {
      segments.push({ text: cell.glyph, tone: cell.tone });
    }
  }
  return segments;
}

function CanvasRows({
  canvas,
  theme,
}: {
  canvas: TerminalGraphCanvasResult;
  theme: Theme;
}): React.ReactElement {
  return (
    <>
      {canvas.cells.map((row, rowIndex) => (
        <Text key={`flow-canvas-${rowIndex}`} wrap="truncate-end">
          {rowSegments(row).map((segment, segmentIndex) => (
            <Text
              key={`${rowIndex}:${segmentIndex}`}
              color={colorForCanvasTone(segment.tone, theme)}
              bold={segment.tone === "accent"}
            >
              {segment.text}
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

export function sessionFlowNodeAtScreen(
  report: SessionFlowPanelLayoutReport | null,
  screenX: number,
  screenY: number,
): string | null {
  if (!report) return null;
  const x = screenX - report.canvasScreenLeft;
  const y = screenY - report.canvasScreenTop;
  if (x < 0 || y < 0) return null;
  return report.canvas.hitMap[y]?.[x] ?? null;
}

export function sessionFlowDrawioGeometry(
  layout: SessionFlowLayout,
): SessionFlowDrawioGeometry {
  const xScale = 12;
  const yScale = 18;
  const nodeById = new Map(
    layout.nodes.map((item) => [item.id, item.node] as const),
  );
  const edgeRoutes: Array<{
    id: string;
    label: string;
    waypoints: Array<{ x: number; y: number }>;
    style: {
      endArrow: string;
      dashed: boolean;
      dashPattern?: string;
      statusColor?: string;
      strokeWidth: number;
    };
  }> = [];
  for (const edge of layout.edges) {
    const semantics = sessionFlowEdgeSemantics(
      edge,
      nodeById.get(edge.target),
    );
    edgeRoutes.push({
      id: edge.id,
      label: semantics.detailedLabel,
      waypoints: edge.points.map((point) => ({
        x: point.x * xScale,
        y: point.y * yScale,
      })),
      style: {
        endArrow: semantics.arrow ? "block" : "none",
        dashed: semantics.lineStyle !== "solid",
        dashPattern: semantics.drawioDashPattern,
        statusColor: semantics.drawioColor,
        strokeWidth: semantics.strokeWidth,
      },
    });
  }
  return {
    nodeGeometry: layout.nodes.map((item) => ({
      id: item.id,
      x: item.x * xScale,
      y: item.y * yScale,
      width: item.width * xScale,
      height: item.height * yScale,
    })),
    edgeRoutes,
    processGroups: layout.processFrames.map((frame) => ({
      id: frame.id,
      processNodeId: frame.processNodeId,
      memberNodeIds: [...frame.memberNodeIds],
      label: frame.label,
      x: frame.x * xScale,
      y: frame.y * yScale,
      width: frame.width * xScale,
      height: frame.height * yScale,
    })),
  };
}

/**
 * Build the exact graph projection currently visible in the terminal.
 *
 * Overview mode can fold model/tool/receipt nodes into their visible
 * containers. Exporting the original state alongside visible-only geometry
 * would restore those hidden nodes at fallback positions and attach projected
 * routes to the wrong topology. The Draw.io writer only needs nodes and edges,
 * so keep the receipt metadata while replacing those collections with the
 * displayed projection.
 */
export function sessionFlowDrawioProjection(
  state: SessionFlowState,
  layout: SessionFlowLayout,
): SessionFlowState {
  return {
    ...state,
    nodes: layout.nodes.map((item) => item.node),
    edges: layout.edges.map((item) => ({
      id: item.id,
      source: item.source,
      target: item.target,
      kind: item.kind,
    })),
  };
}

export function CompactSessionFlow({
  state,
  theme,
  width,
  selected = false,
  selectedNodeId = null,
  layoutBounds = null,
  viewportWorldBounds = null,
  contextLabel = "major overview",
  projectionKey = "current",
  rawNodeCount = state.nodes.length,
  onMiniMapGeometry,
}: {
  state: SessionFlowState;
  theme: Theme;
  width: number;
  selected?: boolean;
  selectedNodeId?: string | null;
  layoutBounds?: SessionFlowWorldBounds | null;
  viewportWorldBounds?: SessionFlowWorldBounds | null;
  contextLabel?: string;
  projectionKey?: string;
  rawNodeCount?: number;
  onMiniMapGeometry?: (report: SessionFlowMiniMapGeometryReport) => void;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const innerWidth = Math.max(8, width - (ax.screenReader ? 0 : 4));
  const runs = sessionFlowRunCount(state);

  return (
    <Box
      flexDirection="column"
      height={COMPACT_SESSION_FLOW_ROWS}
      flexShrink={0}
      overflow="hidden"
      borderStyle={ax.screenReader ? undefined : "single"}
      borderColor={selected ? t.accent : t.dim}
      paddingX={ax.screenReader ? 0 : 1}
    >
      <SessionFlowMiniMap
        state={state}
        theme={t}
        width={innerWidth}
        height={3}
        contextLabel={contextLabel}
        projectionKey={projectionKey}
        selectedNodeId={selectedNodeId}
        layoutBounds={layoutBounds}
        viewportWorldBounds={viewportWorldBounds}
        onGeometry={onMiniMapGeometry}
      />
      <Text color={selected ? t.accent : t.text} bold wrap="truncate-end">
        [
        <MatrixText
          text={`${selected ? "Navigate" : "Open"} flow · ${contextLabel} · ${
            runs === 0
              ? "no runs"
              : `${state.nodes.length}/${rawNodeCount} major/audit`
          } · f/6`}
          seed={929}
        />
        ]
      </Text>
    </Box>
  );
}

function SessionFlowEdgeLegend({
  theme,
}: {
  theme: Theme;
}): React.ReactElement {
  return (
    <Text wrap="truncate-end">
      <Text color={theme.dim}>Links </Text>
      <Text color={theme.tool}>┈ contains(no arrow)</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.text}>┄ handoff/retry/return</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.text}>─▶ execution</Text>
      <Text color={theme.dim}> | status </Text>
      <Text color={theme.tool}>observed</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.thinking}>queued</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.user}>live</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.success}>done</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.warn}>blocked/cancelled</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.error}>failed</Text>
    </Text>
  );
}

export function SessionFlowPanel({
  state,
  interaction,
  rawNodeCount = state.nodes.length,
  metadataByNodeId = {},
  breadcrumbs = [],
  liveStatusByNodeId = {},
  projectionKey = `${interaction.detailLevel}:${interaction.hierarchyPath.join("/")}`,
  dispatchInteraction,
  theme,
  width,
  height,
  scrollOffset = 0,
  mouseMode = false,
  paneTopRow = 1,
  screenLeft = 1,
  onScrollLayout,
  onGraphLayout,
}: {
  state: SessionFlowState;
  interaction: SessionFlowInteractionState;
  rawNodeCount?: number;
  metadataByNodeId?: Record<string, SessionFlowHierarchyNodeMeta>;
  breadcrumbs?: readonly SessionFlowHierarchyBreadcrumb[];
  liveStatusByNodeId?: Readonly<Record<string, SessionFlowLiveNodeStatus>>;
  projectionKey?: string;
  dispatchInteraction: React.Dispatch<SessionFlowInteractionAction>;
  theme: Theme;
  width: number;
  height: number;
  scrollOffset?: number;
  mouseMode?: boolean;
  paneTopRow?: number;
  screenLeft?: number;
  onScrollLayout?: (maxScroll: number) => void;
  onGraphLayout?: (report: SessionFlowPanelLayoutReport) => void;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const innerWidth = Math.max(8, width - (ax.screenReader ? 0 : 4));
  const topology = sessionFlowTopologyText(state);
  const topologyRows = topology
    ? wrapTextLines(`Topology: ${topology}`, innerWidth).length
    : 0;
  const canvasHeight = Math.max(
    1,
    height - (ax.screenReader ? 3 : 6) - (ax.screenReader ? 0 : topologyRows),
  );
  const previousLayoutRef = useRef<SessionFlowLayout | null>(null);
  const previousGenerationRef = useRef(interaction.layoutGeneration);
  const previousProjectionKeyRef = useRef(projectionKey);
  const preserve =
    previousGenerationRef.current === interaction.layoutGeneration
      && previousProjectionKeyRef.current === projectionKey
      ? previousLayoutRef.current
      : null;
  const layout = useMemo(
    () =>
      layoutSessionFlowForInteraction(state, interaction, {
        previousLayout: preserve,
      }),
    [
      interaction.collapsedIds,
      interaction.detailLevel,
      interaction.expandedIds,
      interaction.layoutGeneration,
      interaction.zoomLevel,
      projectionKey,
      state,
    ],
  );
  useEffect(() => {
    previousLayoutRef.current = layout;
    previousGenerationRef.current = interaction.layoutGeneration;
    previousProjectionKeyRef.current = projectionKey;
  }, [interaction.layoutGeneration, layout, projectionKey]);

  const selectedNodeId = selectedFlowNodeId(
    interaction,
    layout.nodes,
    layout.latestNodeId,
    layout.activeNodeId,
  );
  const pan = resolvedSessionFlowPan(
    layout,
    innerWidth,
    canvasHeight,
    interaction,
    selectedNodeId,
  );
  const scene = useMemo(
    () =>
      sessionFlowSceneForLayout(
        layout,
        selectedNodeId,
        interaction.zoomLevel,
        metadataByNodeId,
      ),
    [interaction.zoomLevel, layout, metadataByNodeId, selectedNodeId],
  );
  const canvas = useMemo(
    () =>
      renderTerminalGraphCanvas(scene, {
        width: innerWidth,
        height: canvasHeight,
        panX: pan.panX,
        panY: pan.panY,
      }),
    [canvasHeight, innerWidth, pan.panX, pan.panY, scene],
  );
  const report = useMemo<SessionFlowPanelLayoutReport>(
    () => ({
      state,
      metadataByNodeId,
      projectionKey,
      hierarchyLevel: interaction.detailLevel,
      hierarchyPath: interaction.hierarchyPath,
      focusNodeId: interaction.hierarchyPath.at(-1) ?? null,
      layout,
      canvas,
      selectedNodeId,
      canvasScreenLeft: screenLeft + (ax.screenReader ? 0 : 2),
      canvasScreenTop: paneTopRow + (ax.screenReader ? 2 : 3),
      viewportWidth: innerWidth,
      viewportHeight: canvasHeight,
      panX: pan.panX,
      panY: pan.panY,
      zoomLevel: interaction.zoomLevel,
      viewportWorldBounds: sessionFlowViewportWorldBounds(pan, {
        width: innerWidth,
        height: canvasHeight,
      }),
    }),
    [
      ax.screenReader,
      canvas,
      canvasHeight,
      innerWidth,
      layout,
      metadataByNodeId,
      paneTopRow,
      pan.panX,
      pan.panY,
      screenLeft,
      selectedNodeId,
      state,
      projectionKey,
      interaction.detailLevel,
      interaction.hierarchyPath,
      interaction.zoomLevel,
    ],
  );
  useEffect(() => {
    onGraphLayout?.(report);
  }, [onGraphLayout, report]);

  const logicalRows = useMemo(
    () => [...buildSessionFlowRows(state), ...buildSessionFlowEdgeRows(layout)],
    [layout, state],
  );
  const visualRows = useMemo(
    () => wrapSessionFlowRows(logicalRows, innerWidth),
    [innerWidth, logicalRows],
  );
  const screenReaderRows = Math.max(1, height - 6);
  const maxScroll = ax.screenReader
    ? Math.max(0, visualRows.length - screenReaderRows)
    : 0;
  const safeOffset = Math.max(0, Math.min(maxScroll, scrollOffset));
  useEffect(() => {
    onScrollLayout?.(maxScroll);
  }, [maxScroll, onScrollLayout]);

  if (ax.screenReader) {
    const selectedNode =
      layout.nodes.find((node) => node.id === selectedNodeId) ?? null;
    const selectedSummary = selectedNode
      ? `${selectedNode.node.label} · ${selectedNode.node.status} · ${
          selectedNode.collapsed ? "folded" : "expanded"
        } · ${selectedNode.visibleChildCount} visible / ${
          selectedNode.hiddenChildCount
        } hidden children`
      : "none";
    return (
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        <Text color={t.accent} bold>
          Session Flow block diagram
        </Text>
        <Text color={t.dim}>
          Arrow keys select blocks; Page Up/Down scroll rows; plus/minus zoom;
          zero fits; Enter drills into compound blocks; Escape goes up or
          closes; F follows live; e exports the major view; Shift+e exports the
          full audit graph. The timeline always reads input on the left to
          output on the right.
        </Text>
        <Text color={t.text}>
          Selected: <MatrixText text={selectedSummary} seed={937} />
        </Text>
        <Text color={t.dim}>
          View:{" "}
          <MatrixText
            text={`${getSessionFlowZoomPreset(interaction.zoomLevel).percentage}% · ${
              interaction.detailLevel
            } · ${interaction.followLive ? "follow live" : "manual"}`}
            seed={941}
          />
        </Text>
        <Text color={t.dim}>
          Path:{" "}
          <MatrixText
            text={`${breadcrumbs.map((item) => item.label).join(" / ") || "All runs"} · ${
              state.nodes.length
            } major blocks / ${rawNodeCount} audit events`}
            seed={947}
          />
        </Text>
        <Text color={t.dim}>
          Links: contains is structural and has no arrow; handoff, retry, and
          return are dashed; execution is solid. Link labels name the relation;
          progress is observed, queued, live, done, blocked, cancelled, or
          failed.
        </Text>
        {visualRows
          .slice(safeOffset, safeOffset + screenReaderRows)
          .map((item) => (
            <Text
              key={item.visualId}
              color={colorForTone(item.tone, t)}
              bold={item.bold}
            >
              <MatrixText text={item.text || " "} seed={item.visualId.length * 89} />
            </Text>
          ))}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={t.accent}
      paddingX={1}
      overflow="hidden"
    >
      <Text color={t.accent} bold wrap="truncate-end">
        Session Flow ·{" "}
        <MatrixText
          text={`${breadcrumbs.map((item) => item.label).join(" › ") || "All runs"} · ${
            getSessionFlowZoomPreset(interaction.zoomLevel).percentage
          }% · ${interaction.detailLevel} · ${
            interaction.followLive ? "follow LIVE" : "manual"
          }`}
          seed={953}
        />
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        left input → right output · drag/two-finger pan · Ctrl/⌘+two-finger
        zoom · arrows select · Shift+arrows pan · +/- zoom · 0 fit · 1 normal ·
        Enter drill/inspect · Esc up/close · d hierarchy · F follow · e major ·
        E audit
      </Text>
      {topology ? (
        <Text color={t.accent} bold wrap="wrap">
          Topology: <MatrixText text={topology} seed={959} />
        </Text>
      ) : null}
      {state.nodes.length === 0 ? (
        <Box height={canvasHeight} flexDirection="column">
          <Text color={t.dim}>◇ Waiting for observable harness events…</Text>
        </Box>
      ) : (
        <CanvasRows canvas={canvas} theme={t} />
      )}
      <SessionFlowEdgeLegend theme={t} />
      <Text color={t.dim} wrap="truncate-end">
        <MatrixText
          text={`${
            selectedNodeId
              ? `selected ${selectedNodeId} · ${layout.nodes.length} visible · ${rawNodeCount} audit events${
                  liveStatusByNodeId[selectedNodeId] ? " · live status" : ""
                }`
              : "no block selected"
          }${
            mouseMode
              ? " · drag canvas · four-way trackpad · modified trackpad zoom"
              : ""
          }`}
          seed={967}
        />
      </Text>
    </Box>
  );
}
