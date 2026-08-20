import React, { useEffect, useMemo } from "react";
import { Box, Text } from "ink";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { accessibleTheme } from "../lib/accessibility.js";
import {
  projectSessionFlowMiniMap,
  sessionFlowMiniMapTextSummary,
  type SessionFlowMiniMapCellTone,
  type SessionFlowMiniMapProjection,
  type SessionFlowMiniMapWorldBounds,
} from "../lib/sessionFlowMiniMap.js";
import type { SessionFlowState } from "../lib/sessionFlow.js";
import type { Theme } from "../lib/theme.js";

export interface SessionFlowMiniMapGeometryReport {
  projectionKey: string;
  projection: SessionFlowMiniMapProjection;
  /** Canvas geometry is local to this component, never terminal-absolute. */
  canvasLocalLeft: number;
  canvasLocalTop: number;
  canvasWidth: number;
  canvasHeight: number;
  hitMap: Array<Array<string | null>>;
  nodeIdsByCell: string[][][];
  layoutBounds: SessionFlowMiniMapWorldBounds | null;
}

export interface SessionFlowMiniMapProps {
  state: SessionFlowState;
  theme: Theme;
  width: number;
  height?: number;
  contextLabel?: string;
  projectionKey?: string;
  selectedNodeId?: string | null;
  layoutBounds?: SessionFlowMiniMapWorldBounds | null;
  viewportWorldBounds?: SessionFlowMiniMapWorldBounds | null;
  onGeometry?: (report: SessionFlowMiniMapGeometryReport) => void;
}

export const SESSION_FLOW_MINIMAP_CANVAS_LOCAL_LEFT = 0;
export const SESSION_FLOW_MINIMAP_CANVAS_LOCAL_TOP = 1;

function colorForTone(
  tone: SessionFlowMiniMapCellTone,
  theme: Theme,
): string {
  if (tone === "selected") return theme.accent;
  if (tone === "active" || tone === "success") return theme.success;
  if (tone === "latest" || tone === "warning") return theme.warn;
  if (tone === "danger") return theme.error;
  if (tone === "viewport") return theme.tool;
  if (tone === "edge-structure" || tone === "edge-progress" || tone === "edge") {
    return theme.tool;
  }
  if (tone === "edge-queued" || tone === "edge-retry") return theme.thinking;
  if (tone === "edge-live") return theme.user;
  if (tone === "edge-success") return theme.success;
  if (tone === "edge-handoff" || tone === "edge-warning") return theme.warn;
  if (tone === "edge-danger") return theme.error;
  if (tone === "edge-label") return theme.accent;
  if (tone === "edge-dim" || tone === "dim") return theme.dim;
  return theme.text;
}

function rowSegments(
  row: SessionFlowMiniMapProjection["cells"][number],
): Array<{ text: string; tone: SessionFlowMiniMapCellTone }> {
  const segments: Array<{ text: string; tone: SessionFlowMiniMapCellTone }> = [];
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

/**
 * Current-hierarchy terminal minimap. Mouse ownership remains with the parent panel:
 * `onGeometry` reports local hit cells, while sessionFlowMiniMapNavigationAtCell
 * converts a clicked cell into normalized and optional enlarged-world space.
 */
export function SessionFlowMiniMap({
  state,
  theme,
  width,
  height = 5,
  contextLabel = "current hierarchy",
  projectionKey = "current",
  selectedNodeId = null,
  layoutBounds = null,
  viewportWorldBounds = null,
  onGeometry,
}: SessionFlowMiniMapProps): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const mapWidth = Math.max(1, Math.floor(width));
  const mapHeight = Math.max(1, Math.floor(height));
  const projection = useMemo(
    () =>
      projectSessionFlowMiniMap(state, {
        width: mapWidth,
        height: mapHeight,
        selectedNodeId,
        layoutBounds,
        viewportWorldBounds,
      }),
    [
      layoutBounds,
      mapHeight,
      mapWidth,
      selectedNodeId,
      state,
      viewportWorldBounds,
    ],
  );
  const report = useMemo<SessionFlowMiniMapGeometryReport>(
    () => ({
      projectionKey,
      projection,
      canvasLocalLeft: SESSION_FLOW_MINIMAP_CANVAS_LOCAL_LEFT,
      canvasLocalTop: SESSION_FLOW_MINIMAP_CANVAS_LOCAL_TOP,
      canvasWidth: projection.width,
      canvasHeight: projection.height,
      hitMap: projection.hitMap,
      nodeIdsByCell: projection.nodeIdsByCell,
      layoutBounds,
    }),
    [layoutBounds, projection, projectionKey],
  );
  useEffect(() => {
    onGeometry?.(report);
  }, [onGeometry, report]);

  const summary = sessionFlowMiniMapTextSummary(
    projection,
    `Current hierarchy · ${contextLabel}`,
  );
  if (ax.screenReader) {
    return (
      <Box flexDirection="column" width={width}>
        <Text color={t.accent} bold>
          Session flow minimap
        </Text>
        <Text color={t.text}>{summary}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text color={t.accent} bold wrap="truncate-end">
        Progress map · Input → Output · {projection.progress.percentage}% ·{" "}
        {projection.progress.settled}/{projection.progress.total} settled
      </Text>
      {projection.cells.map((row, rowIndex) => (
        <Text key={`session-flow-minimap-${rowIndex}`} wrap="truncate-end">
          {rowSegments(row).map((segment, segmentIndex) => (
            <Text
              key={`${rowIndex}:${segmentIndex}`}
              color={colorForTone(segment.tone, t)}
              bold={
                segment.tone === "selected" ||
                segment.tone === "active" ||
                segment.tone === "latest"
              }
            >
              {segment.text}
            </Text>
          ))}
        </Text>
      ))}
      <Text color={t.dim} wrap="truncate-end">
        ◆ selected · ▶ running · ● done · ○ pending · ! blocked · × failed
        {projection.viewportRect ? " · [━] viewport" : ""}
      </Text>
    </Box>
  );
}
