import React, { useMemo } from "react";
import { Box, Text, type Key } from "ink";
import { accessibleTheme, type AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { windowFor } from "../lib/pickers.js";
import type { Theme } from "../lib/theme.js";
import type {
  WorkflowPickerEntry,
  WorkflowPickerEntryKind,
} from "../lib/workflows.js";

export type WorkflowPickerIntent =
  | "move_up"
  | "move_down"
  | "select"
  | "cancel"
  | "focus_search"
  | "show_workflows"
  | "show_skills"
  | null;

export function workflowPickerBorderStyle(prefs: AccessibilityPrefs): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

export function workflowPickerBadge(entry: WorkflowPickerEntry): string {
  return entry.selectable ? entry.badge : `${entry.badge} · unavailable`;
}

export function workflowPickerDetail(entry: WorkflowPickerEntry): string {
  const capabilities = entry.capabilities.map((capability) => capability.label).join(", ");
  return [entry.summary, capabilities ? `Capabilities: ${capabilities}` : "", entry.reason || ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Presentation components do not own stdin; this resolver gives the parent a
 * portable, testable keyboard contract while avoiding duplicate Ink handlers.
 */
export function resolveWorkflowPickerKey(
  input: string,
  key: Partial<Key>,
  selectedEntry?: WorkflowPickerEntry,
): WorkflowPickerIntent {
  if (key.upArrow) return "move_up";
  if (key.downArrow) return "move_down";
  if (key.escape) return "cancel";
  if (key.tab || input === "/") return "focus_search";
  if (input === "1") return "show_workflows";
  if (input === "2") return "show_skills";
  if (key.return) return selectedEntry?.selectable ? "select" : null;
  return null;
}

function kindLabel(kind: WorkflowPickerEntryKind | "all"): string {
  if (kind === "workflow") return "workflows";
  if (kind === "skill") return "skills";
  return "workflows + skills";
}

export function WorkflowPicker({
  theme,
  entries,
  selected,
  width,
  height,
  query = "",
  kind = "all",
}: {
  theme: Theme;
  entries: WorkflowPickerEntry[];
  selected: number;
  width: number;
  height: number;
  query?: string;
  kind?: WorkflowPickerEntryKind | "all";
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const maxVisible = Math.max(3, height - 7);
  const { start, end, index } = useMemo(
    () => windowFor(entries.length, selected, maxVisible),
    [entries.length, selected, maxVisible],
  );

  if (!entries.length) {
    return (
      <Box
        flexDirection="column"
        width={width}
        borderStyle={workflowPickerBorderStyle(ax)}
        borderColor={t.accent}
        paddingX={1}
      >
        <Text color={t.accent} bold>Sophia workflows and skills</Text>
        <Text color={t.dim}>No matching {kindLabel(kind)}.</Text>
        <Text color={t.dim}>Tab or / search · 1 workflows · 2 skills · Esc cancel</Text>
      </Box>
    );
  }

  const visible = entries.slice(start, end);
  const showCapabilities = width >= 74;
  const badgeWidth = width >= 72 ? 24 : 16;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={workflowPickerBorderStyle(ax)}
      borderColor={t.accent}
      paddingX={1}
      overflow="hidden"
    >
      <Text color={t.accent} bold wrap="truncate-end">
        Sophia workflows and skills
        <Text color={t.dim}> · {kindLabel(kind)} · {index + 1}/{entries.length}</Text>
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        ↑↓ choose · Enter select · Tab or / search · 1 workflows · 2 skills · Esc cancel
      </Text>
      {query ? <Text color={t.dim} wrap="truncate-end">filter: {query}</Text> : null}
      {start > 0 ? <Text color={t.dim}>  ↑ {start} more above…</Text> : null}
      <Box flexDirection="column">
        {visible.map((entry, visibleIndex) => {
          const rowIndex = start + visibleIndex;
          const active = rowIndex === index;
          const badge = workflowPickerBadge(entry);
          const capabilityText = entry.capabilities.map((capability) => capability.label).join(", ");
          const color = !entry.selectable ? t.warn : active ? t.accent : t.text;
          return (
            <Box key={`${entry.kind}:${entry.id}`} flexDirection="column">
              <Box width={Math.max(24, width - 4)}>
                <Text color={active ? t.accent : t.dim}>{active ? "› " : "  "}</Text>
                <Text color={color} bold={active} wrap="truncate-end">
                  {entry.label}
                </Text>
                <Text color={entry.selectable ? t.dim : t.warn} wrap="truncate-end">
                  {" "}[{entry.kind} · {badge.padEnd(badgeWidth)}]
                </Text>
                {showCapabilities && capabilityText ? (
                  <Text color={t.dim} wrap="truncate-end"> {capabilityText}</Text>
                ) : null}
              </Box>
              {active ? (
                <Text color={entry.selectable ? t.dim : t.warn} wrap="truncate-end">
                  {"    "}{workflowPickerDetail(entry)}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {end < entries.length ? <Text color={t.dim}>  ↓ {entries.length - end} more below…</Text> : null}
      <Text color={t.dim} wrap="truncate-end">
        Unavailable entries explain what must be configured; experimental entries remain labeled.
      </Text>
    </Box>
  );
}
