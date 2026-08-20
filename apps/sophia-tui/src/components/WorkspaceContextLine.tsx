import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import type { WorkspaceContext } from "../lib/workspaceContext.js";
import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { ellipsizeEnd } from "../lib/useTerminalSize.js";
import { displayWidth } from "./PromptInput.js";

const SEP = " · ";

function clipped(value: string, budget: number): string {
  return ellipsizeEnd(value || "—", Math.max(1, budget));
}

/**
 * One-row workspace/session identity immediately above the composer.
 *
 * Normal terminal widths keep repo, branch, PR and session visible. Worktree
 * identity joins them when there is room. Narrow terminals progressively use
 * shorter labels instead of wrapping and stealing rows from the middle pane.
 */
export function workspaceContextText(
  context: WorkspaceContext,
  session: string,
  width: number,
): string {
  const w = Math.max(1, Math.floor(width));
  const pr = context.pr || "unavailable";

  let text: string;
  if (w >= 118 && context.worktree) {
    const fixed = displayWidth("repo:") + displayWidth("wt:")
      + displayWidth("git:") + displayWidth("PR:") + displayWidth("session:")
      + displayWidth(SEP) * 4 + displayWidth(pr);
    const variable = Math.max(20, w - fixed);
    const repoBudget = Math.min(18, Math.max(8, Math.floor(variable * 0.18)));
    const worktreeBudget = Math.min(24, Math.max(10, Math.floor(variable * 0.24)));
    const sessionBudget = Math.min(20, Math.max(8, Math.floor(variable * 0.2)));
    const branchBudget = Math.max(10, variable - repoBudget - worktreeBudget - sessionBudget);
    text = [
      `repo:${clipped(context.repo, repoBudget)}`,
      `wt:${clipped(context.worktree, worktreeBudget)}`,
      `git:${clipped(context.branch || "—", branchBudget)}`,
      `PR:${pr}`,
      `session:${clipped(session, sessionBudget)}`,
    ].join(SEP);
  } else if (w >= 68) {
    const fixed = displayWidth("repo:") + displayWidth("git:")
      + displayWidth("PR:") + displayWidth("session:")
      + displayWidth(SEP) * 3 + displayWidth(pr);
    const variable = Math.max(18, w - fixed);
    const repoBudget = Math.min(18, Math.max(7, Math.floor(variable * 0.27)));
    const sessionBudget = Math.min(18, Math.max(7, Math.floor(variable * 0.27)));
    const branchBudget = Math.max(8, variable - repoBudget - sessionBudget);
    text = [
      `repo:${clipped(context.repo, repoBudget)}`,
      `git:${clipped(context.branch || "—", branchBudget)}`,
      `PR:${pr}`,
      `session:${clipped(session, sessionBudget)}`,
    ].join(SEP);
  } else if (w >= 46 && context.isGit) {
    const prText = `PR:${pr}`;
    const fixed = displayWidth("git:") + displayWidth("s:")
      + displayWidth(SEP) * 2 + displayWidth(prText);
    const variable = Math.max(12, w - fixed);
    const sessionBudget = Math.max(6, Math.floor(variable * 0.4));
    const branchBudget = Math.max(6, variable - sessionBudget);
    text = [
      `git:${clipped(context.branch || "—", branchBudget)}`,
      prText,
      `s:${clipped(session, sessionBudget)}`,
    ].join(SEP);
  } else {
    const fixed = displayWidth("repo:") + displayWidth("s:") + displayWidth(SEP);
    const variable = Math.max(6, w - fixed);
    const sessionBudget = Math.max(3, Math.floor(variable * 0.42));
    const repoBudget = Math.max(3, variable - sessionBudget);
    text = [
      `repo:${clipped(context.repo, repoBudget)}`,
      `s:${clipped(session, sessionBudget)}`,
    ].join(SEP);
  }

  return ellipsizeEnd(text, w);
}

export function WorkspaceContextLine({
  context,
  session,
  theme,
  width,
}: {
  context: WorkspaceContext;
  session: string;
  theme: Theme;
  width: number;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  return (
    <Box width={width} flexShrink={0} overflowX="hidden">
      <Text color={t.dim} wrap="truncate-end">
        {workspaceContextText(context, session, width)}
      </Text>
    </Box>
  );
}
