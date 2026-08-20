import React from "react";
import { Box, Text } from "ink";

import { accessibleTheme } from "../lib/accessibility.js";
import type {
  TerminalCapabilities,
  TerminalWidthClass,
} from "../lib/terminalCapabilities.js";
import { terminalWidthClass } from "../lib/terminalCapabilities.js";
import type { Theme } from "../lib/theme.js";

export interface AccessibilityPanelRow {
  key: string;
  label: string;
  value: "on" | "off" | string;
  detail: string;
  editable: boolean;
}

export interface AccessibilityPanelLayout {
  widthClass: TerminalWidthClass;
  showDetails: boolean;
  showCapabilitySummary: boolean;
  innerWidth: number;
}

export function accessibilityPanelLayout(width: number): AccessibilityPanelLayout {
  const safeWidth = Number.isFinite(width) ? Math.max(24, Math.floor(width)) : 80;
  const widthClass = terminalWidthClass(safeWidth);
  return {
    widthClass,
    showDetails: widthClass === "standard" || widthClass === "wide",
    showCapabilitySummary: widthClass !== "narrow",
    innerWidth: Math.max(20, safeWidth - 4),
  };
}

export function accessibilityPanelRows(
  capabilities: TerminalCapabilities,
): AccessibilityPanelRow[] {
  const prefs = capabilities.accessibility;
  return [
    {
      key: "screenReader",
      label: "Screen reader",
      value: prefs.screenReader ? "on" : "off",
      detail: "flat output; no colour, animation, mouse, or decorative protocol chrome",
      editable: true,
    },
    {
      key: "reducedMotion",
      label: "Reduced motion",
      value: prefs.reducedMotion ? "on" : "off",
      detail: "still spinners and no timer-driven presentation changes",
      editable: true,
    },
    {
      key: "lowColor",
      label: "Low colour",
      value: prefs.lowColor ? "on" : "off",
      detail: "small palette; state is always repeated in text",
      editable: true,
    },
    {
      key: "unicode",
      label: "Unicode",
      value: capabilities.unicode ? "available" : "plain ASCII",
      detail: "glyph choice follows locale and explicit terminal settings",
      editable: false,
    },
    {
      key: "mouse",
      label: "Mouse",
      value: capabilities.mouse ? "available" : "off",
      detail: "keyboard navigation remains the universal path",
      editable: false,
    },
    {
      key: "clipboard",
      label: "Clipboard",
      value: capabilities.clipboard ? "available" : "not declared",
      detail: "OSC clipboard writes require an explicit capability declaration",
      editable: false,
    },
    {
      key: "notifications",
      label: "Notifications",
      value: capabilities.notifications
        ? capabilities.notificationProtocol ?? "available"
        : capabilities.bell
          ? "bell only"
          : "local toast only",
      detail: "external notifications remain off until the user enables them",
      editable: false,
    },
  ];
}

export function accessibilityPanelBorderStyle(
  capabilities: TerminalCapabilities,
): "round" | undefined {
  return capabilities.accessibility.screenReader ? undefined : "round";
}

export function accessibilityPanelTheme(
  theme: Theme,
  capabilities: TerminalCapabilities,
): Theme {
  const accessible = accessibleTheme(theme, capabilities.accessibility);
  if (!capabilities.accessibility.lowColor || capabilities.accessibility.screenReader) {
    return accessible;
  }
  // Low-colour mode uses only the normal/dim roles. Every state also has an
  // explicit word, so no information depends on this reduced palette.
  return {
    ...accessible,
    accent: accessible.text,
    success: accessible.text,
    warn: accessible.text,
    error: accessible.text,
    tool: accessible.text,
    thinking: accessible.text,
    user: accessible.text,
    border: accessible.dim,
  };
}

export function accessibilityRowPrefix(
  selected: boolean,
  capabilities: TerminalCapabilities,
): string {
  if (!selected) return capabilities.accessibility.screenReader ? "" : "  ";
  if (capabilities.accessibility.screenReader) return "Selected: ";
  return capabilities.unicode ? "› " : "> ";
}

export function accessibilityPanelSummary(capabilities: TerminalCapabilities): {
  environment: string;
  capabilities: string;
} {
  const separator = capabilities.unicode ? " · " : " | ";
  return {
    environment: [
      capabilities.platform,
      `${capabilities.columns} columns`,
      `${capabilities.widthClass} layout`,
    ].join(separator),
    capabilities: [
      `colour=${capabilities.colorLevel}`,
      `links=${capabilities.hyperlinks ? "on" : "off"}`,
      `remote=${capabilities.isRemote ? "yes" : "no"}`,
    ].join(separator),
  };
}

export function AccessibilityPanel({
  capabilities,
  theme,
  width,
  selectedIndex = 0,
  interactive = true,
}: {
  capabilities: TerminalCapabilities;
  theme: Theme;
  width: number;
  selectedIndex?: number;
  interactive?: boolean;
}): React.ReactElement {
  const layout = accessibilityPanelLayout(width);
  const rows = accessibilityPanelRows(capabilities).map((row) => ({
    ...row,
    editable: interactive && row.editable,
  }));
  const t = accessibilityPanelTheme(theme, capabilities);
  const borderStyle = accessibilityPanelBorderStyle(capabilities);
  const summary = accessibilityPanelSummary(capabilities);

  return (
    <Box
      flexDirection="column"
      width={Math.max(24, width)}
      paddingX={1}
      borderStyle={borderStyle}
      borderColor={borderStyle ? t.border : undefined}
    >
      <Text color={t.accent} bold>
        Accessibility & terminal
      </Text>
      <Text color={t.dim}>{summary.environment}</Text>
      <Box height={1} />
      {rows.map((row, index) => {
        const selected = index === selectedIndex;
        const prefix = accessibilityRowPrefix(selected, capabilities);
        const statusColor =
          row.value === "off" || row.value === "not declared"
            ? t.dim
            : row.value === "on" || row.value === "available"
              ? t.success
              : t.text;
        return (
          <Box key={row.key} flexDirection="column" width={layout.innerWidth}>
            <Text color={selected ? t.accent : t.text} bold={selected}>
              {prefix}
              {row.label}: <Text color={statusColor}>{row.value}</Text>
              {row.editable ? " (toggle)" : ""}
            </Text>
            {layout.showDetails ? (
              <Text color={t.dim}>    {row.detail}</Text>
            ) : null}
          </Box>
        );
      })}
      {layout.showCapabilitySummary ? (
        <>
          <Box height={1} />
          <Text color={t.dim}>{summary.capabilities}</Text>
        </>
      ) : null}
      <Text color={t.dim}>
        {interactive
          ? "Space toggles editable preferences · Esc closes · keyboard always works"
          : "Set SOPHIA_SCREEN_READER / SOPHIA_REDUCED_MOTION / SOPHIA_LOW_COLOR before launch · Esc closes"}
      </Text>
    </Box>
  );
}
