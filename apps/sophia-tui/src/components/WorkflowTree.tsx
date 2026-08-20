import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import { flattenWorkflow, redactLog, type WorkflowNode, type WorkflowState } from "../lib/workflow.js";
import { accessibleTheme, type AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { MatrixText } from "./MatrixText.js";

function icon(state: string): string { return ({ running: "▶", queued: "○", blocked: "⊘", succeeded: "✓", failed: "✗", cancelled: "■" } as Record<string, string>)[state] || "·"; }
function detail(n: WorkflowNode): string {
  const timing = n.timings && Object.values(n.timings).find((v) => typeof v === "number");
  const tokens = n.tokens && Object.values(n.tokens).find((v) => typeof v === "number");
  return [timing !== undefined ? `${timing}ms` : "", tokens !== undefined ? `${tokens} tok` : "", n.attempt ? `try ${n.attempt}` : "", n.blockedReason ? `blocked: ${redactLog(n.blockedReason)}` : ""].filter(Boolean).join(" · ");
}
// A rounded border is decorative chrome under accessibility.ts's screen-reader
// contract ("draw no borders or decorative chrome"); this tree is the one
// owned component that draws one (Ink's borderStyle), so it is the one that
// has to turn it off.
export function workflowBorderStyle(prefs: AccessibilityPrefs): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}
export function WorkflowTree({ state, theme, width, onToggle, onSelect }: { state: WorkflowState; theme: Theme; width: number; onToggle: (id: string) => void; onSelect: (id: string) => void }): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const rows = flattenWorkflow(state);
  const seenNodeIdsRef = React.useRef<Set<string>>(
    new Set(rows.map((node) => node.taskId)),
  );
  const newNodeIds = new Set(
    rows
      .filter((node) => !seenNodeIdsRef.current.has(node.taskId))
      .map((node) => node.taskId),
  );
  React.useEffect(() => {
    for (const node of rows) seenNodeIdsRef.current.add(node.taskId);
  }, [rows]);
  return <Box flexDirection="column" width={width} borderStyle={workflowBorderStyle(ax)} borderColor={t.dim} paddingX={1}>
    <Text color={t.accent} bold>Workflows {state.filter ? `· filter=${state.filter}` : ""}</Text>
    {rows.length === 0 ? <Text color={t.dim}>No persisted tasks. /tasks refreshes the snapshot.</Text> : rows.map((n) => {
      const depth = (() => { let d = 0, p = n.parentId; while (p) { d++; p = state.nodes[p]?.parentId || null; } return d; })();
      const hasChildren = Object.values(state.nodes).some((x) => x.parentId === n.taskId);
      const animateOnMount = newNodeIds.has(n.taskId);
      return <Box key={n.taskId} flexDirection="column" width={width}>
        <Text color={state.selectedId === n.taskId ? t.accent : t.text} wrap="truncate-end">
          {"  ".repeat(depth)}
          {hasChildren ? (state.expanded.has(n.taskId) ? "▾ " : "▸ ") : "  "}
          {icon(n.state)}{" "}
          <MatrixText
            text={n.title || n.name}
            animateOnMount={animateOnMount}
            seed={n.taskId.length * 43}
          />{" "}
          <Text color={t.dim}>
            <MatrixText
              text={`[${n.kind}/${n.state}]${detail(n) ? ` ${detail(n)}` : ""}`}
              animateOnMount={animateOnMount}
              seed={n.taskId.length * 47}
            />
          </Text>
        </Text>
        {state.selectedId === n.taskId && n.logs?.length ? (
          <Text color={t.dim} wrap="truncate-end">
            {"  ".repeat(depth + 2)}
            <MatrixText
              text={redactLog(n.logs[n.logs.length - 1])}
              animateOnMount={animateOnMount}
              seed={n.taskId.length * 53}
            />
          </Text>
        ) : null}
      </Box>;
    })}
  </Box>;
}
