import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import { accessibleTheme, type AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { windowFor } from "../lib/pickers.js";
import {
  confidenceBand,
  connectionLine,
  displayExceptions,
  edgesFor,
  isConflictEdge,
  isLaundered,
  nodeMeta,
  visibleNodes,
  type GraphProjection,
  type GraphProjectionState,
  type ProjectionEdge,
  type ProjectionNode,
} from "../lib/graphProjection.js";

// A rounded border is decorative chrome under accessibility.ts's screen-reader
// contract ("draw no borders or decorative chrome"); like WorkflowTree, this
// panel draws one (Ink's borderStyle) so it is the one that turns it off.
export function graphBorderStyle(prefs: AccessibilityPrefs): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

/** The ordinal confidence glyph for a node — never a numeric probability. */
export function nodeGlyph(node: ProjectionNode): string {
  return confidenceBand(node.effectiveConfidenceRank);
}

/**
 * One node row: glyph band + id + pageType + tradition. A downgraded node earns
 * a loud "⚠ downgraded" glyph marker (display-by-exception); routine provenance
 * stays unmarked.
 */
export function nodeLine(node: ProjectionNode): string {
  const tradition = node.tradition ? ` · ${node.tradition}` : "";
  const laundered = isLaundered(node) ? " ⚠ downgraded" : "";
  return `${nodeGlyph(node)} ${node.id} [${node.pageType}]${tradition}${laundered}`;
}

/**
 * One edge row. A conflict edge is marked with a non-colour "✗" glyph; an
 * unresolved/dangling edge with a dashed "┄" arrow. Calm, resolved edges carry
 * no marker.
 */
export function edgeLine(edge: ProjectionEdge): string {
  const mark = isConflictEdge(edge) ? "✗ " : "  ";
  const arrow = edge.resolved ? "→" : "┄→";
  return `${mark}${edge.src} ─${edge.kind}${arrow} ${edge.dst}${edge.resolved ? "" : " (unresolved)"}`;
}

/**
 * The honesty footer: the panel can never be read as a claim of validated
 * knowledge. Always states candidateOnly + canClaimAGI:false.
 */
export function honestyFooter(projection: GraphProjection): string {
  const co = projection.candidateOnly ? "candidateOnly" : "candidateOnly:false";
  const agi = projection.canClaimAGI ? "canClaimAGI:true" : "canClaimAGI:false";
  return `${co} · ${agi} · provenance audit view`;
}

/**
 * SessionBrowser-style knowledge-graph panel. Takes over the message pane
 * (like /resume) with a clean two-column layout: entity name on the left,
 * type · tradition · confidence on the right. Windowed scrolling via the
 * shared pickers.ts:windowFor math. Expand a node with Enter to see its
 * connections in plain language.
 *
 * PRESENTATION ONLY — ↑↓/Enter/Esc are owned by App.tsx (same pattern as
 * SessionBrowser and OptionPicker).
 */
export function GraphPanel({ state, theme, width, height, onToggle, onSelect }: { state: GraphProjectionState; theme: Theme; width: number; height: number; onToggle: (id: string) => void; onSelect: (id: string) => void }): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const projection = state.projection;

  if (!projection) {
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={1} justifyContent="center">
        <Text color={t.accent} bold>Knowledge Graph</Text>
        <Text color={t.dim}>Loading graph… the provenance audit view will appear here.</Text>
        <Text color={t.dim}>Esc to go back.</Text>
      </Box>
    );
  }

  const rows = visibleNodes(state);
  const ex = displayExceptions(projection);
  const issues = ex.laundered.length + ex.conflicts.length + ex.dangling.length;
  const edgeCount = projection.edges.length;

  // Header + footer + scroll-indicator slack claim a few lines; the rest is
  // the scrollable window. Clamp so a short terminal still shows a usable list.
  const maxVisible = Math.max(3, height - 6);
  const selectedIndex = rows.findIndex((n) => n.id === state.selectedId);
  const { start, end } = useMemo(
    () => windowFor(rows.length, selectedIndex < 0 ? 0 : selectedIndex, maxVisible),
    [rows.length, selectedIndex, maxVisible],
  );
  const innerWidth = Math.max(24, width - 2);
  const visible = rows.slice(start, end);

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      {/* Header */}
      <Box>
        <Text color={t.accent} bold>Knowledge Graph</Text>
        <Text color={t.dim}>
          {"  "}
          {rows.length} entit{rows.length === 1 ? "y" : "ies"} · {edgeCount} link{edgeCount === 1 ? "" : "s"}
          {state.filter ? ` · filter: ${state.filter}` : ""}
          {" · "}↑↓ browse · Enter expand · Esc close
        </Text>
      </Box>

      {/* Issue summary (display-by-exception) */}
      {issues > 0 ? (
        <Text color={t.warn}>
          ⚠ {ex.laundered.length ? `${ex.laundered.length} confidence downgraded ` : ""}
          {ex.conflicts.length ? `${ex.conflicts.length} conflicting ` : ""}
          {ex.dangling.length ? `${ex.dangling.length} unresolved link${ex.dangling.length === 1 ? "" : "s"}` : ""}
        </Text>
      ) : null}

      <Box height={1} />

      {/* Empty state */}
      {rows.length === 0 ? (
        <Text color={t.dim}>
          {state.filter ? `No entities match "${state.filter}" — try /graph without a filter.` : "No entities in this graph."}
        </Text>
      ) : (
        <>
          {start > 0 ? <Text color={t.dim}>  ↑ {start} more above…</Text> : null}
          <Box flexDirection="column">
            {visible.map((n) => {
              const active = n.id === state.selectedId;
              const open = state.expanded.has(n.id);
              const nodeEdges = edgesFor(projection, n.id);
              const expandable = nodeEdges.length > 0;
              const downgraded = isLaundered(n);
              const meta = nodeMeta(n);
              const titleColor = active ? t.accent : downgraded ? t.warn : t.text;
              return (
                <Box key={n.id} flexDirection="column" width={innerWidth}>
                  {/* Two-column row: name left, meta right */}
                  <Box width={innerWidth} justifyContent="space-between">
                    <Box flexGrow={1} flexShrink={1}>
                      <Text color={titleColor} bold={active} wrap="truncate-end">
                        {(active ? "› " : "  ") + (expandable ? (open ? "▾ " : "▸ ") : "  ") + n.id}
                      </Text>
                    </Box>
                    <Box flexShrink={0}>
                      <Text color={active ? t.accent : t.dim}> {meta}</Text>
                    </Box>
                  </Box>
                  {/* Expanded connections */}
                  {open ? (
                    <Box flexDirection="column" paddingLeft={4}>
                      {nodeEdges.length === 0 ? (
                        <Text color={t.dim}>no connections</Text>
                      ) : (
                        nodeEdges.map((e, i) => (
                          <Text key={`${e.src}-${e.dst}-${i}`} color={isConflictEdge(e) ? t.error : t.dim} wrap="truncate-end">
                            {connectionLine(e)}
                            {e.evidence.length ? <Text color={t.dim}> · {e.evidence.join(", ")}</Text> : null}
                          </Text>
                        ))
                      )}
                    </Box>
                  ) : null}
                </Box>
              );
            })}
          </Box>
          {end < rows.length ? <Text color={t.dim}>  ↓ {rows.length - end} more below…</Text> : null}
        </>
      )}

      <Box height={1} />
      {/* Footer */}
      <Text color={t.dim} wrap="truncate-end">
        Enter expands a node's connections · /graph &lt;name&gt; to filter · Esc closes
      </Text>
      <Text color={t.dim}>{honestyFooter(projection)}</Text>
    </Box>
  );
}
