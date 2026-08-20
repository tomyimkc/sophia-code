import type { SessionFlowLayoutOptions } from "./sessionFlowLayout.js";

export type SessionFlowZoomLevel =
  | "map"
  | "compact"
  | "normal"
  | "detail"
  | "inspect";

export type SessionFlowZoomPercentage = 50 | 75 | 100 | 125 | 150;

export type SessionFlowLabelDensity =
  | "minimal"
  | "compact"
  | "normal"
  | "detailed"
  | "full";

export type SessionFlowRenderDensity =
  | "minimal"
  | "reduced"
  | "normal"
  | "enhanced"
  | "maximum";

export interface SessionFlowZoomPreset {
  level: SessionFlowZoomLevel;
  percentage: SessionFlowZoomPercentage;
  nodeWidth: number;
  nodeHeight: number;
  horizontalGap: number;
  verticalGap: number;
  padding: number;
  labelDensity: SessionFlowLabelDensity;
  renderDensity: SessionFlowRenderDensity;
}

export const SESSION_FLOW_ZOOM_LEVELS = [
  "map",
  "compact",
  "normal",
  "detail",
  "inspect",
] as const satisfies readonly SessionFlowZoomLevel[];

export const SESSION_FLOW_ZOOM_PERCENTAGES = {
  map: 50,
  compact: 75,
  normal: 100,
  detail: 125,
  inspect: 150,
} as const satisfies Readonly<
  Record<SessionFlowZoomLevel, SessionFlowZoomPercentage>
>;

export const SESSION_FLOW_ZOOM_PRESETS = {
  map: {
    level: "map",
    percentage: 50,
    nodeWidth: 8,
    nodeHeight: 3,
    horizontalGap: 2,
    verticalGap: 1,
    padding: 0,
    labelDensity: "minimal",
    renderDensity: "minimal",
  },
  compact: {
    level: "compact",
    percentage: 75,
    nodeWidth: 16,
    nodeHeight: 3,
    horizontalGap: 4,
    verticalGap: 1,
    padding: 0,
    labelDensity: "compact",
    renderDensity: "reduced",
  },
  normal: {
    level: "normal",
    percentage: 100,
    nodeWidth: 24,
    nodeHeight: 5,
    horizontalGap: 8,
    verticalGap: 3,
    padding: 1,
    labelDensity: "normal",
    renderDensity: "normal",
  },
  detail: {
    level: "detail",
    percentage: 125,
    nodeWidth: 32,
    nodeHeight: 7,
    horizontalGap: 10,
    verticalGap: 4,
    padding: 2,
    labelDensity: "detailed",
    renderDensity: "enhanced",
  },
  inspect: {
    level: "inspect",
    percentage: 150,
    nodeWidth: 40,
    nodeHeight: 9,
    horizontalGap: 12,
    verticalGap: 5,
    padding: 2,
    labelDensity: "full",
    renderDensity: "maximum",
  },
} as const satisfies Readonly<
  Record<SessionFlowZoomLevel, SessionFlowZoomPreset>
>;

function zoomIndex(level: SessionFlowZoomLevel): number {
  return SESSION_FLOW_ZOOM_LEVELS.indexOf(level);
}

function finiteStep(step: number): number {
  return Number.isFinite(step) ? Math.max(0, Math.floor(step)) : 1;
}

export function sessionFlowZoomLevelAt(index: number): SessionFlowZoomLevel {
  const finiteIndex = Number.isFinite(index) ? Math.floor(index) : 0;
  const clampedIndex = Math.max(
    0,
    Math.min(SESSION_FLOW_ZOOM_LEVELS.length - 1, finiteIndex),
  );
  return SESSION_FLOW_ZOOM_LEVELS[clampedIndex]!;
}

export function nextSessionFlowZoomLevel(
  level: SessionFlowZoomLevel,
  step = 1,
): SessionFlowZoomLevel {
  return sessionFlowZoomLevelAt(zoomIndex(level) + finiteStep(step));
}

export function previousSessionFlowZoomLevel(
  level: SessionFlowZoomLevel,
  step = 1,
): SessionFlowZoomLevel {
  return sessionFlowZoomLevelAt(zoomIndex(level) - finiteStep(step));
}

export function getSessionFlowZoomPreset(
  level: SessionFlowZoomLevel,
): SessionFlowZoomPreset {
  return SESSION_FLOW_ZOOM_PRESETS[level];
}

/**
 * Returns only geometry options. Topology visibility remains controlled
 * independently by `SessionFlowLayoutOptions.detailLevel`.
 */
export function sessionFlowLayoutOptionsForZoom(
  level: SessionFlowZoomLevel,
): Pick<
  SessionFlowLayoutOptions,
  "nodeWidth" | "nodeHeight" | "horizontalGap" | "verticalGap" | "padding"
> {
  const preset = getSessionFlowZoomPreset(level);
  return {
    nodeWidth: preset.nodeWidth,
    nodeHeight: preset.nodeHeight,
    horizontalGap: preset.horizontalGap,
    verticalGap: preset.verticalGap,
    padding: preset.padding,
  };
}

export const nextSessionFlowZoom = nextSessionFlowZoomLevel;
export const previousSessionFlowZoom = previousSessionFlowZoomLevel;
