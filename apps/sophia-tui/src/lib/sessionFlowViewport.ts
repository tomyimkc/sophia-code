import type { SessionFlowLayoutBounds } from "./sessionFlowLayout.js";
import type {
  SessionFlowPan,
  SessionFlowViewportGeometry,
} from "./sessionFlowInteraction.js";

export interface SessionFlowCellPoint {
  x: number;
  y: number;
}

export interface SessionFlowScaledBounds {
  minX: number;
  minY: number;
  /** Exclusive right edge. */
  maxX: number;
  /** Exclusive bottom edge. */
  maxY: number;
  width: number;
  height: number;
}

export type SessionFlowPointerGesture = "click" | "drag";

export interface SessionFlowZoomAnchorInput {
  pan: SessionFlowPan;
  anchor: SessionFlowCellPoint;
  fromZoomPercent: number;
  toZoomPercent: number;
  /**
   * Supplying both viewport and bounds clamps the anchored result to the
   * target zoom's scrollable layout extent.
   */
  viewport?: SessionFlowViewportGeometry;
  bounds?: Pick<SessionFlowLayoutBounds, "minX" | "minY" | "maxX" | "maxY">;
}

export interface SessionFlowFitView {
  zoomPercent: number;
  panX: number;
  panY: number;
}

/** Two terminal cells of travel distinguish an intentional drag from a click. */
export const SESSION_FLOW_DRAG_THRESHOLD_CELLS = 2;

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function terminalCell(value: number, fallback = 0): number {
  const cell = Math.round(finiteNumber(value, fallback));
  return cell === 0 ? 0 : cell;
}

function viewportCells(value: number): number {
  return Math.max(0, Math.floor(finiteNumber(value)));
}

function positiveZoomPercent(value: number, fallback = 100): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizedDragThreshold(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : SESSION_FLOW_DRAG_THRESHOLD_CELLS;
}

function normalizedBounds(
  bounds: Pick<SessionFlowLayoutBounds, "minX" | "minY" | "maxX" | "maxY">,
): Pick<SessionFlowLayoutBounds, "minX" | "minY" | "maxX" | "maxY"> {
  const firstX = finiteNumber(bounds.minX);
  const secondX = finiteNumber(bounds.maxX, firstX);
  const firstY = finiteNumber(bounds.minY);
  const secondY = finiteNumber(bounds.maxY, firstY);
  return {
    minX: Math.min(firstX, secondX),
    minY: Math.min(firstY, secondY),
    maxX: Math.max(firstX, secondX),
    maxY: Math.max(firstY, secondY),
  };
}

export function sessionFlowPointerDelta(
  start: SessionFlowCellPoint,
  current: SessionFlowCellPoint,
): SessionFlowPan {
  return {
    panX: terminalCell(current.x) - terminalCell(start.x),
    panY: terminalCell(current.y) - terminalCell(start.y),
  };
}

/** Maximum axis travel matches the discrete rows/columns emitted by terminals. */
export function sessionFlowPointerTravelCells(
  start: SessionFlowCellPoint,
  current: SessionFlowCellPoint,
): number {
  const delta = sessionFlowPointerDelta(start, current);
  return Math.max(Math.abs(delta.panX), Math.abs(delta.panY));
}

export function isSessionFlowDrag(
  start: SessionFlowCellPoint,
  current: SessionFlowCellPoint,
  thresholdCells = SESSION_FLOW_DRAG_THRESHOLD_CELLS,
): boolean {
  return (
    sessionFlowPointerTravelCells(start, current) >=
    normalizedDragThreshold(thresholdCells)
  );
}

export function sessionFlowPointerGesture(
  start: SessionFlowCellPoint,
  current: SessionFlowCellPoint,
  thresholdCells = SESSION_FLOW_DRAG_THRESHOLD_CELLS,
): SessionFlowPointerGesture {
  return isSessionFlowDrag(start, current, thresholdCells) ? "drag" : "click";
}

/**
 * Scale half-open layout bounds outward so every occupied source cell remains
 * covered after conversion to integer terminal coordinates.
 */
export function scaleSessionFlowBounds(
  bounds: Pick<SessionFlowLayoutBounds, "minX" | "minY" | "maxX" | "maxY">,
  zoomPercent = 100,
): SessionFlowScaledBounds {
  const normalized = normalizedBounds(bounds);
  const scale = positiveZoomPercent(zoomPercent) / 100;
  const minX = Math.floor(normalized.minX * scale);
  const minY = Math.floor(normalized.minY * scale);
  const maxX = Math.ceil(normalized.maxX * scale);
  const maxY = Math.ceil(normalized.maxY * scale);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

function clampAxisPan(
  desired: number,
  viewportSize: number,
  min: number,
  max: number,
): number {
  const cells = viewportCells(viewportSize);
  const span = Math.max(0, max - min);
  if (span <= cells) {
    return Math.floor((cells - span) / 2) - min;
  }
  const minimum = cells - max;
  const maximum = -min;
  return terminalCell(
    Math.max(minimum, Math.min(maximum, terminalCell(desired))),
  );
}

export function clampSessionFlowPan(
  pan: SessionFlowPan,
  viewport: SessionFlowViewportGeometry,
  bounds: Pick<SessionFlowLayoutBounds, "minX" | "minY" | "maxX" | "maxY">,
  zoomPercent = 100,
): SessionFlowPan {
  const scaled = scaleSessionFlowBounds(bounds, zoomPercent);
  return {
    panX: clampAxisPan(
      pan.panX,
      viewport.width,
      scaled.minX,
      scaled.maxX,
    ),
    panY: clampAxisPan(
      pan.panY,
      viewport.height,
      scaled.minY,
      scaled.maxY,
    ),
  };
}

/**
 * Keep the same layout coordinate under a viewport cell while changing zoom.
 * The result is rounded once, after applying the zoom ratio, to avoid
 * accumulating sub-cell drift over repeated zoom-in/zoom-out actions.
 */
export function zoomAnchorSessionFlowPan(
  input: SessionFlowZoomAnchorInput,
): SessionFlowPan {
  const fromZoom = positiveZoomPercent(input.fromZoomPercent);
  const toZoom = positiveZoomPercent(input.toZoomPercent, fromZoom);
  const anchorX = terminalCell(input.anchor.x);
  const anchorY = terminalCell(input.anchor.y);
  const pan = {
    panX: terminalCell(input.pan.panX),
    panY: terminalCell(input.pan.panY),
  };
  const ratio = toZoom / fromZoom;
  const anchored = {
    panX: terminalCell(anchorX - (anchorX - pan.panX) * ratio),
    panY: terminalCell(anchorY - (anchorY - pan.panY) * ratio),
  };
  return input.viewport && input.bounds
    ? clampSessionFlowPan(
        anchored,
        input.viewport,
        input.bounds,
        toZoom,
      )
    : anchored;
}

/** Center the scaled layout bounds in the viewport using whole-cell pan. */
export function fitSessionFlowPan(
  bounds: Pick<SessionFlowLayoutBounds, "minX" | "minY" | "maxX" | "maxY">,
  viewport: SessionFlowViewportGeometry,
  zoomPercent = 100,
): SessionFlowPan {
  const scaled = scaleSessionFlowBounds(bounds, zoomPercent);
  const desired = {
    panX:
      Math.floor((viewportCells(viewport.width) - scaled.width) / 2) -
      scaled.minX,
    panY:
      Math.floor((viewportCells(viewport.height) - scaled.height) / 2) -
      scaled.minY,
  };
  return clampSessionFlowPan(desired, viewport, bounds, zoomPercent);
}

function zoomCandidates(values: readonly number[]): number[] {
  const candidates = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => finiteNumber(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => right - left);
  return candidates.length > 0 ? candidates : [100];
}

/**
 * Choose the largest supplied zoom that fits the half-open layout bounds,
 * then return the centered whole-cell pan for that zoom. If no supplied zoom
 * fits, the smallest candidate is used and centered for predictable panning.
 */
export function fitSessionFlowViewport(
  bounds: Pick<SessionFlowLayoutBounds, "minX" | "minY" | "maxX" | "maxY">,
  viewport: SessionFlowViewportGeometry,
  zoomPercents: readonly number[],
  paddingCells = 1,
): SessionFlowFitView {
  const candidates = zoomCandidates(zoomPercents);
  const padding = Number.isFinite(paddingCells)
    ? Math.max(0, Math.floor(paddingCells))
    : 1;
  const availableWidth = Math.max(
    0,
    viewportCells(viewport.width) - padding * 2,
  );
  const availableHeight = Math.max(
    0,
    viewportCells(viewport.height) - padding * 2,
  );
  const zoomPercent =
    candidates.find((candidate) => {
      const scaled = scaleSessionFlowBounds(bounds, candidate);
      return (
        scaled.width <= availableWidth && scaled.height <= availableHeight
      );
    }) ?? candidates.at(-1)!;
  return {
    zoomPercent,
    ...fitSessionFlowPan(bounds, viewport, zoomPercent),
  };
}
