import React from "react";
import { Box, Text } from "ink";
import type { AccessibilityPrefs } from "../lib/accessibility.js";
import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  PROVENANCE_EXPERIMENTAL_LABEL,
  PROVENANCE_HONESTY_NOTE,
  countProvenanceGraph,
  inspectProvenanceGraph,
  type ProvenanceEdge,
  type ProvenanceGraph,
  type ProvenanceNode,
  type ProvenanceRecordStatus,
} from "../lib/provenanceGraph.js";
import { truncateToWidth } from "../lib/textWidth.js";
import type { Theme } from "../lib/theme.js";

export type ProvenancePanelLayout = "wide" | "compact" | "minimal";

export function provenancePanelLayout(width: number): ProvenancePanelLayout {
  if (width >= 76) return "wide";
  if (width >= 44) return "compact";
  return "minimal";
}
export function provenanceBorderStyle(
  prefs: AccessibilityPrefs,
): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

const STATUS_MARK: Record<ProvenanceRecordStatus, string> = {
  observed: "●",
  reported: "○",
  inferred: "~",
  unverified: "?",
};

export function provenanceNodeLine(
  node: ProvenanceNode,
  width: number,
  layout: ProvenancePanelLayout = provenancePanelLayout(width),
): string {
  const lane = node.laneId ? ` · lane:${node.laneId}` : "";
  const detail = layout === "wide" && node.detail ? ` · ${node.detail}` : "";
  return truncateToWidth(
    `${STATUS_MARK[node.status]} ${node.label} [${node.kind}/${node.status}]${lane}${detail}`,
    Math.max(1, width),
  );
}

export function provenanceEdgeLine(
  edge: ProvenanceEdge,
  width: number,
  layout: ProvenancePanelLayout = provenancePanelLayout(width),
): string {
  const detail = layout === "wide" && edge.detail ? ` · ${edge.detail}` : "";
  const arrow = edge.kind === "conflicts-with" ? "✗" : "→";
  return truncateToWidth(
    `${STATUS_MARK[edge.status]} ${edge.from} ${arrow} ${edge.to} [${edge.kind}/${edge.status}]${detail}`,
    Math.max(1, width),
  );
}

export function provenanceSummary(graph: ProvenanceGraph): string {
  const counts = countProvenanceGraph(graph);
  return [
    `${counts.nodes} nodes`,
    `${counts.edges} links`,
    counts.conflicts ? `${counts.conflicts} conflicts` : "",
    counts.inferred ? `${counts.inferred} inferred` : "",
    counts.unverified ? `${counts.unverified} unverified` : "",
    counts.issues ? `${counts.issues} integrity issues` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function nodeColor(node: ProvenanceNode, theme: Theme): string {
  if (node.kind === "conflict") return theme.error;
  if (node.status === "unverified" || node.status === "inferred") {
    return theme.warn;
  }
  if (node.status === "observed") return theme.success;
  return theme.text;
}

/**
 * Experimental, display-only provenance panel. It renders graph records
 * already present in local state and performs no network access or validation.
 */
export function ProvenancePanel({
  graph,
  theme,
  width,
  selectedNodeId,
  maxRows,
}: {
  graph: ProvenanceGraph;
  theme: Theme;
  width: number;
  selectedNodeId?: string | null;
  maxRows?: number;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const layout = provenancePanelLayout(width);
  const innerWidth = Math.max(1, width - (ax.screenReader ? 0 : 4));
  const limit = Math.max(1, maxRows ?? 12);
  const nodeLimit =
    layout === "minimal" ? limit : Math.max(1, Math.ceil(limit * 0.65));
  const edgeLimit = Math.max(0, limit - Math.min(nodeLimit, graph.nodes.length));
  const visibleNodes = graph.nodes.slice(0, nodeLimit);
  const visibleEdges =
    layout === "minimal" ? [] : graph.edges.slice(0, edgeLimit);
  const hidden =
    graph.nodes.length -
    visibleNodes.length +
    graph.edges.length -
    visibleEdges.length;
  const issues = inspectProvenanceGraph(graph);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={provenanceBorderStyle(ax)}
      borderColor={t.border}
      paddingX={ax.screenReader ? 0 : 1}
    >
      <Text color={t.accent} bold>
        {truncateToWidth(PROVENANCE_EXPERIMENTAL_LABEL, innerWidth)}
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        {truncateToWidth(provenanceSummary(graph), innerWidth)}
      </Text>

      {graph.nodes.length === 0 ? (
        <Text color={t.dim}>No local provenance records.</Text>
      ) : (
        visibleNodes.map((node) => (
          <Text
            key={node.id}
            color={nodeColor(node, t)}
            bold={selectedNodeId === node.id}
            wrap="truncate-end"
          >
            {selectedNodeId === node.id ? "› " : "  "}
            {provenanceNodeLine(
              node,
              Math.max(1, innerWidth - 2),
              layout,
            )}
          </Text>
        ))
      )}

      {visibleEdges.length ? (
        <Box flexDirection="column" paddingLeft={layout === "wide" ? 2 : 0}>
          <Text color={t.dim}>Links</Text>
          {visibleEdges.map((edge) => (
            <Text
              key={edge.id}
              color={edge.kind === "conflicts-with" ? t.error : t.dim}
              wrap="truncate-end"
            >
              {provenanceEdgeLine(
                edge,
                Math.max(1, innerWidth - (layout === "wide" ? 2 : 0)),
                layout,
              )}
            </Text>
          ))}
        </Box>
      ) : null}

      {hidden > 0 ? (
        <Text color={t.dim}>
          {hidden} more local record{hidden === 1 ? "" : "s"} hidden by width/row
          limits
        </Text>
      ) : null}
      {issues.length > 0 ? (
        <Text color={t.warn}>
          ⚠ {issues.length} graph integrity issue
          {issues.length === 1 ? "" : "s"}; inspect local receipt
        </Text>
      ) : null}
      <Text color={t.dim} wrap="truncate-end">
        {truncateToWidth(PROVENANCE_HONESTY_NOTE, innerWidth)}
      </Text>
    </Box>
  );
}
