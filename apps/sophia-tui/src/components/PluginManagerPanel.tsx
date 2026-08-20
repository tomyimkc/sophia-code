import React from "react";
import { Box, Text, type Key } from "ink";
import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  PLUGIN_MANAGER_TABS,
  pluginManagerActivityLine,
  pluginManagerEntriesForTab,
  selectedPluginManagerEntry,
  type PluginManagerEntry,
  type PluginManagerState,
  type PluginManagerTab,
} from "../lib/plugins.js";
import { windowFor } from "../lib/pickers.js";
import type { Theme } from "../lib/theme.js";

export type PluginManagerIntent =
  | "close"
  | "next_tab"
  | "previous_tab"
  | "move_up"
  | "move_down"
  | "reload"
  | "permissions"
  | "health"
  | "inspect"
  | null;

export function resolvePluginManagerKey(
  input: string,
  key: Partial<Key>,
): PluginManagerIntent {
  if (key.escape) return "close";
  if (key.tab && key.shift) return "previous_tab";
  if (key.tab) return "next_tab";
  if (key.upArrow) return "move_up";
  if (key.downArrow) return "move_down";
  if (key.return) return "inspect";
  const normalized = input.toLowerCase();
  if (normalized === "r") return "reload";
  if (normalized === "p") return "permissions";
  if (normalized === "h") return "health";
  return null;
}

export function pluginManagerTabLabel(tab: PluginManagerTab): string {
  return ({
    discover: "Discover",
    installed: "Installed",
    permissions: "Permissions",
    health: "Health",
  } as Record<PluginManagerTab, string>)[tab];
}

export function pluginManagerApprovalLabel(entry: PluginManagerEntry): string {
  if (!entry.approvalRequired) return "no approval needed";
  return entry.approved ? "approved" : "approval required";
}

export function pluginManagerEntryLine(
  entry: PluginManagerEntry,
  selected: boolean,
  tab: PluginManagerTab,
): string {
  const prefix = selected ? "›" : " ";
  const identity = `${entry.name}${entry.version === "?" ? "" : `@${entry.version}`}`;
  if (tab === "permissions") {
    return `${prefix} ${identity} · ${pluginManagerApprovalLabel(entry)} · requested ${entry.requestedPermissions.length} · approved ${entry.approvedPermissions.length}`;
  }
  if (tab === "health") {
    return `${prefix} ${identity} · structural ${entry.structuralHealth} · runtime ${entry.runtimeHealth.status.replaceAll("_", " ")}`;
  }
  return [
    `${prefix} ${identity}`,
    entry.kind === "compat" ? "compat" : "local",
    entry.present ? "present" : "catalog only",
    entry.enabled ? "enabled" : "disabled",
    pluginManagerApprovalLabel(entry),
    entry.lockState === "mismatch" ? "LOCK MISMATCH" : entry.lockState,
    entry.selected ? "selected" : "",
  ].filter(Boolean).join(" · ");
}

export function pluginManagerSelectedDetailLines(
  state: PluginManagerState,
): string[] {
  const entry = selectedPluginManagerEntry(state);
  if (!entry) return [];
  const lines = [
    `${entry.id} · ${entry.publisher} · ${entry.source}`,
  ];
  if (state.tab === "permissions") {
    lines.push(
      `requested: ${entry.requestedPermissions.length ? entry.requestedPermissions.join(", ") : "(none)"}`,
      `approved: ${entry.approvedPermissions.length ? entry.approvedPermissions.join(", ") : "(none)"}`,
      entry.executable
        ? "executable plugin · approval does not create an OS sandbox"
        : "declarative plugin · Sophia remains the authority boundary",
    );
  } else if (state.tab === "health") {
    lines.push(
      `structural: ${entry.structuralHealth} · ${entry.structuralDetail}`,
      `runtime: ${entry.runtimeHealth.status.replaceAll("_", " ")} · ${entry.runtimeHealth.detail}`,
      entry.runtimeHealth.probed
        ? "runtime evidence came from an explicit probe"
        : "runtime not established · press h to probe explicitly",
    );
  } else {
    if (entry.description) lines.push(entry.description);
    lines.push(
      `present ${entry.present ? "yes" : "no"} · enabled ${entry.enabled ? "yes" : "no"} · ${pluginManagerApprovalLabel(entry)} · lock ${entry.lockState}`,
      `selected ${entry.selected ? entry.selectedKinds.join(", ") || "yes" : "no"} · structural ${entry.structuralHealth} · runtime ${entry.runtimeHealth.status.replaceAll("_", " ")}`,
    );
  }
  if (entry.tools.length) {
    lines.push(`declared tools: ${entry.tools.join(", ")}`);
  }
  return lines;
}

/**
 * Pure text projection used by tests and screen-reader-oriented callers. The
 * actual Ink component renders these same labels and never evaluates plugin
 * supplied code or injects plugin supplied UI.
 */
export function pluginManagerPanelLines(state: PluginManagerState): string[] {
  const entries = pluginManagerEntriesForTab(state);
  const selected = selectedPluginManagerEntry(state);
  const activity = pluginManagerActivityLine(state.activity);
  return [
    `Sophia plugin manager · safe mode ${state.safeMode ? "on" : "off"}`,
    PLUGIN_MANAGER_TABS
      .map((tab) => `${tab === state.tab ? "[" : ""}${pluginManagerTabLabel(tab)}${tab === state.tab ? "]" : ""}`)
      .join("  "),
    state.tab === "discover"
      ? "Local manifests + DSH compatibility catalog; catalog presence is not installation."
      : "",
    ...entries.map((entry) =>
      pluginManagerEntryLine(entry, entry.key === selected?.key, state.tab)
    ),
    ...pluginManagerSelectedDetailLines(state),
    activity,
    state.lastError ? `error: ${state.lastError}` : "",
    "Tab tabs · ↑↓ select · r reload · p permissions · h explicit health probe · Enter inspect · Esc close",
    "No auto-spawn, auto-install, auto-enable, or auto-call. External DSH code runs only after existing gates and explicit actions.",
  ].filter(Boolean);
}

export function PluginManagerPanel({
  state,
  theme,
  width,
  height,
}: {
  state: PluginManagerState;
  theme: Theme;
  width: number;
  height: number;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const entries = pluginManagerEntriesForTab(state);
  const selected = selectedPluginManagerEntry(state);
  const selectedIndex = selected
    ? entries.findIndex((entry) => entry.key === selected.key)
    : 0;
  const detailLines = pluginManagerSelectedDetailLines(state);
  const activity = pluginManagerActivityLine(state.activity);
  const reserved = 8 + Math.min(detailLines.length, 4) + (activity ? 1 : 0);
  const maxVisible = Math.max(2, height - reserved);
  const { start, end } = windowFor(
    entries.length,
    Math.max(0, selectedIndex),
    maxVisible,
  );
  const visible = entries.slice(start, end);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={1}
      overflow="hidden"
    >
      <Box justifyContent="space-between">
        <Text color={t.accent} bold>Sophia plugin manager</Text>
        <Text color={state.safeMode ? t.success : t.warn} bold>
          safe mode {state.safeMode ? "on" : "off"}
        </Text>
      </Box>
      <Box>
        {PLUGIN_MANAGER_TABS.map((tab, index) => (
          <Text
            key={tab}
            color={tab === state.tab ? t.accent : t.dim}
            bold={tab === state.tab}
          >
            {index ? "  " : ""}
            {tab === state.tab ? `[${pluginManagerTabLabel(tab)}]` : pluginManagerTabLabel(tab)}
          </Text>
        ))}
      </Box>
      <Text color={t.dim} wrap="truncate-end">
        {state.tab === "discover"
          ? "Local manifests + DSH compatibility catalog · catalog only ≠ installed"
          : state.tab === "health"
            ? "Structural checks are passive · runtime status changes only after an explicit probe"
            : "present, enabled, approved, locked, and selected are separate states"}
      </Text>

      <Box height={1} />
      {entries.length === 0 ? (
        <Text color={t.dim}>
          {state.tab === "discover"
            ? "No local or compatibility catalog entries reported. Use /plugin compat discover <source> explicitly."
            : `No ${pluginManagerTabLabel(state.tab).toLowerCase()} entries reported.`}
        </Text>
      ) : (
        <>
          {start > 0 ? <Text color={t.dim}>  ↑ {start} more above…</Text> : null}
          {visible.map((entry) => {
            const active = entry.key === selected?.key;
            const color = active
              ? t.accent
              : entry.structuralHealth === "blocked" || entry.structuralHealth === "invalid"
                ? t.warn
                : t.text;
            return (
              <Text
                key={entry.key}
                color={color}
                bold={active}
                wrap="truncate-end"
              >
                {pluginManagerEntryLine(entry, active, state.tab)}
              </Text>
            );
          })}
          {end < entries.length
            ? <Text color={t.dim}>  ↓ {entries.length - end} more below…</Text>
            : null}
        </>
      )}

      {detailLines.length ? (
        <Box flexDirection="column" marginTop={1}>
          {detailLines.slice(0, 4).map((line, index) => (
            <Text
              key={`${selected?.key || "detail"}-${index}`}
              color={index === 0 ? t.text : t.dim}
              bold={index === 0}
              wrap="truncate-end"
            >
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box flexGrow={1} />
      {activity ? <Text color={t.tool} wrap="truncate-end">{activity}</Text> : null}
      {state.lastError ? (
        <Text color={t.error} wrap="truncate-end">error: {state.lastError}</Text>
      ) : null}
      {state.issues.length ? (
        <Text color={t.warn} wrap="truncate-end">
          {state.issues.length} structural issue{state.issues.length === 1 ? "" : "s"} · {state.issues[0]}
        </Text>
      ) : null}
      <Text color={t.dim} wrap="truncate-end">
        Tab tabs · ↑↓ select · r reload · p permissions · h explicit health probe · Enter inspect · Esc close
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        no auto-spawn/install/enable/call · external DSH code remains OS-user authority
      </Text>
    </Box>
  );
}
