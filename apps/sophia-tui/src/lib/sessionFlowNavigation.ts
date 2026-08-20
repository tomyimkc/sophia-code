import type { SessionFlowState } from "./sessionFlow.js";
import {
  layoutSessionFlow,
  type SessionFlowLayout,
} from "./sessionFlowLayout.js";
import type {
  SessionFlowInteractionState,
  SessionFlowViewportGeometry,
} from "./sessionFlowInteraction.js";
import {
  clampSessionFlowPan,
  fitSessionFlowPan,
  type SessionFlowCellPoint,
} from "./sessionFlowViewport.js";
import {
  SESSION_FLOW_ZOOM_LEVELS,
  sessionFlowLayoutOptionsForZoom,
  type SessionFlowZoomLevel,
} from "./sessionFlowZoom.js";

export interface SessionFlowWorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SessionFlowLayoutFit {
  zoomLevel: SessionFlowZoomLevel;
  layout: SessionFlowLayout;
  panX: number;
  panY: number;
}

export interface SessionFlowMiniMapResolvedNavigation {
  selectedNodeId: string | null;
  hiddenNodeId: string | null;
  pan: { panX: number; panY: number } | null;
}

export function layoutSessionFlowForInteraction(
  state: SessionFlowState,
  interaction: SessionFlowInteractionState,
  options: {
    zoomLevel?: SessionFlowZoomLevel;
    previousLayout?: SessionFlowLayout | null;
  } = {},
): SessionFlowLayout {
  const zoomLevel = options.zoomLevel ?? interaction.zoomLevel;
  return layoutSessionFlow(state, {
    // Hierarchy projection owns the semantic overview/stages/workers choice.
    // The lower-level layout engine only needs to know whether it may fold
    // presentation-detail blocks inside the already-projected graph.
    detailLevel:
      interaction.detailLevel === "overview" ? "overview" : "detailed",
    collapsedIds: interaction.collapsedIds,
    expandedIds: interaction.expandedIds,
    autoCollapseDetails: true,
    previousLayout: options.previousLayout ?? null,
    ...sessionFlowLayoutOptionsForZoom(zoomLevel),
  });
}

export function sessionFlowViewportWorldBounds(
  pan: { panX: number; panY: number },
  viewport: SessionFlowViewportGeometry,
): SessionFlowWorldBounds {
  const width = Math.max(0, Math.floor(viewport.width));
  const height = Math.max(0, Math.floor(viewport.height));
  return {
    minX: -Math.round(pan.panX),
    minY: -Math.round(pan.panY),
    maxX: -Math.round(pan.panX) + width,
    maxY: -Math.round(pan.panY) + height,
  };
}

export function centerSessionFlowWorldPoint(
  world: SessionFlowCellPoint,
  viewport: SessionFlowViewportGeometry,
  layout: SessionFlowLayout,
): { panX: number; panY: number } {
  return clampSessionFlowPan(
    {
      panX: Math.floor(viewport.width / 2 - world.x),
      panY: Math.floor(viewport.height / 2 - world.y),
    },
    viewport,
    layout.bounds,
  );
}

/**
 * Resolve a minimap hit against the currently visible enlarged layout.
 * Marker hits center the visible block's actual geometry instead of the
 * collision-displaced minimap cell. Hidden markers are intentionally
 * non-navigable until their block is made visible.
 */
export function resolveSessionFlowMiniMapNavigation(
  target: { nodeId: string | null; world: SessionFlowCellPoint },
  viewport: SessionFlowViewportGeometry,
  layout: SessionFlowLayout,
): SessionFlowMiniMapResolvedNavigation {
  if (target.nodeId) {
    const visibleNode = layout.nodes.find((node) => node.id === target.nodeId);
    if (!visibleNode) {
      return {
        selectedNodeId: null,
        hiddenNodeId: target.nodeId,
        pan: null,
      };
    }
    return {
      selectedNodeId: visibleNode.id,
      hiddenNodeId: null,
      pan: centerSessionFlowWorldPoint(
        {
          x: visibleNode.x + visibleNode.width / 2,
          y: visibleNode.y + visibleNode.height / 2,
        },
        viewport,
        layout,
      ),
    };
  }
  return {
    selectedNodeId: null,
    hiddenNodeId: null,
    pan: centerSessionFlowWorldPoint(target.world, viewport, layout),
  };
}

function normalizedAxis(
  value: number,
  minimum: number,
  maximum: number,
): number {
  const span = maximum - minimum;
  if (!Number.isFinite(span) || span <= 0) return 0.5;
  return Math.max(0, Math.min(1, (value - minimum) / span));
}

/**
 * Preserve the world point under a terminal cell while a semantic zoom
 * rebuilds node sizes and gaps. When a block is under the pointer, preserve
 * the relative point inside that block; otherwise preserve normalized graph
 * position.
 */
export function anchorSessionFlowPanAcrossLayouts(input: {
  sourceLayout: SessionFlowLayout;
  targetLayout: SessionFlowLayout;
  sourcePan: { panX: number; panY: number };
  viewport: SessionFlowViewportGeometry;
  anchorCell: SessionFlowCellPoint;
  anchorNodeId?: string | null;
}): { panX: number; panY: number } {
  const anchorCell = {
    x: Math.round(input.anchorCell.x),
    y: Math.round(input.anchorCell.y),
  };
  const sourceWorld = {
    x: anchorCell.x - input.sourcePan.panX,
    y: anchorCell.y - input.sourcePan.panY,
  };
  const sourceNode = input.anchorNodeId
    ? input.sourceLayout.nodes.find((node) => node.id === input.anchorNodeId)
    : null;
  const targetNode = input.anchorNodeId
    ? input.targetLayout.nodes.find((node) => node.id === input.anchorNodeId)
    : null;

  let targetWorld: SessionFlowCellPoint;
  if (sourceNode && targetNode) {
    const withinX = normalizedAxis(
      sourceWorld.x,
      sourceNode.x,
      sourceNode.x + sourceNode.width,
    );
    const withinY = normalizedAxis(
      sourceWorld.y,
      sourceNode.y,
      sourceNode.y + sourceNode.height,
    );
    targetWorld = {
      x: targetNode.x + withinX * targetNode.width,
      y: targetNode.y + withinY * targetNode.height,
    };
  } else {
    const normalizedX = normalizedAxis(
      sourceWorld.x,
      input.sourceLayout.bounds.minX,
      input.sourceLayout.bounds.maxX,
    );
    const normalizedY = normalizedAxis(
      sourceWorld.y,
      input.sourceLayout.bounds.minY,
      input.sourceLayout.bounds.maxY,
    );
    targetWorld = {
      x:
        input.targetLayout.bounds.minX +
        normalizedX *
          (input.targetLayout.bounds.maxX - input.targetLayout.bounds.minX),
      y:
        input.targetLayout.bounds.minY +
        normalizedY *
          (input.targetLayout.bounds.maxY - input.targetLayout.bounds.minY),
    };
  }

  return clampSessionFlowPan(
    {
      panX: Math.round(anchorCell.x - targetWorld.x),
      panY: Math.round(anchorCell.y - targetWorld.y),
    },
    input.viewport,
    input.targetLayout.bounds,
  );
}

/**
 * Choose the largest semantic zoom preset whose actual rebuilt layout fits
 * the terminal viewport. If no preset fits, use map zoom and center it.
 */
export function fitSessionFlowLayout(
  state: SessionFlowState,
  interaction: SessionFlowInteractionState,
  viewport: SessionFlowViewportGeometry,
  paddingCells = 2,
): SessionFlowLayoutFit {
  const padding = Math.max(0, Math.floor(paddingCells));
  const availableWidth = Math.max(0, Math.floor(viewport.width) - padding * 2);
  const availableHeight = Math.max(0, Math.floor(viewport.height) - padding * 2);
  const candidates = [...SESSION_FLOW_ZOOM_LEVELS].reverse().map((zoomLevel) => ({
    zoomLevel,
    layout: layoutSessionFlowForInteraction(state, interaction, { zoomLevel }),
  }));
  const chosen =
    candidates.find(
      ({ layout }) =>
        layout.bounds.width <= availableWidth &&
        layout.bounds.height <= availableHeight,
    ) ?? candidates.at(-1)!;
  return {
    ...chosen,
    ...fitSessionFlowPan(chosen.layout.bounds, viewport),
  };
}
