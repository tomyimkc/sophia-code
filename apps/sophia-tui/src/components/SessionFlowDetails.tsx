import React from "react";
import { Box, Text } from "ink";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { MatrixText } from "./MatrixText.js";
import { accessibleTheme } from "../lib/accessibility.js";
import {
  sessionFlowStatusGlyph,
  type SessionFlowNode,
  type SessionFlowNodeStatus,
  type SessionFlowState,
} from "../lib/sessionFlow.js";
import type { SessionFlowHierarchyNodeMeta } from "../lib/sessionFlowHierarchy.js";
import type { SessionFlowLiveNodeStatus } from "../lib/sessionFlowPresentation.js";
import type { Theme } from "../lib/theme.js";
import { ellipsizeEnd } from "../lib/useTerminalSize.js";

export type SessionFlowDetailTone =
  | "text"
  | "dim"
  | "accent"
  | "success"
  | "warn"
  | "error";

export interface SessionFlowDetailRow {
  id: string;
  label: string;
  value: string;
  tone: SessionFlowDetailTone;
}

function toneForStatus(status: SessionFlowNodeStatus): SessionFlowDetailTone {
  if (status === "running") return "accent";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  if (status === "blocked" || status === "cancelled") return "warn";
  return "text";
}

function colorForTone(tone: SessionFlowDetailTone, theme: Theme): string {
  if (tone === "accent") return theme.accent;
  if (tone === "success") return theme.success;
  if (tone === "warn") return theme.warn;
  if (tone === "error") return theme.error;
  if (tone === "dim") return theme.dim;
  return theme.text;
}

function connectedNodeLabel(
  state: SessionFlowState,
  nodeId: string,
): string {
  return state.nodes.find((node) => node.id === nodeId)?.label || nodeId;
}

export function sessionFlowDetailRows(
  state: SessionFlowState,
  selectedId: string | null,
  options: {
    rawState?: SessionFlowState;
    metadataByNodeId?: Readonly<Record<string, SessionFlowHierarchyNodeMeta>>;
    liveStatusByNodeId?: Readonly<Record<string, SessionFlowLiveNodeStatus>>;
  } = {},
): SessionFlowDetailRow[] {
  const selected =
    state.nodes.find((node) => node.id === selectedId) ??
    state.nodes.find((node) => node.status === "running") ??
    state.nodes.at(-1) ??
    null;
  if (!selected) {
    return [
      {
        id: "empty",
        label: "",
        value: "Waiting for observable harness events.",
        tone: "dim",
      },
    ];
  }

  const parent = selected.parentId
    ? state.nodes.find((node) => node.id === selected.parentId) ?? null
    : null;
  const incoming = state.edges.filter((edge) => edge.target === selected.id);
  const outgoing = state.edges.filter((edge) => edge.source === selected.id);
  const metadata = options.metadataByNodeId?.[selected.id];
  const live = options.liveStatusByNodeId?.[selected.id];
  const rows: SessionFlowDetailRow[] = [
    {
      id: "status",
      label: "Status",
      value: `${sessionFlowStatusGlyph(selected.status)} ${selected.status}`,
      tone: toneForStatus(selected.status),
    },
    {
      id: "kind",
      label: "Block",
      value: selected.kind,
      tone: "text",
    },
    {
      id: "event",
      label: "Event",
      value: selected.eventType,
      tone: "dim",
    },
    {
      id: "sequence",
      label: "Step",
      value: String(selected.sequence).padStart(3, "0"),
      tone: "dim",
    },
  ];
  if (metadata) {
    rows.push({
      id: "entity",
      label: "Level",
      value: `${metadata.entityKind}${metadata.drillable ? " · portal" : ""}`,
      tone: metadata.drillable ? "accent" : "dim",
    });
    rows.push({
      id: "sources",
      label: "Events",
      value:
        `${metadata.sourceNodeIds.length} preserved`
        + (metadata.hiddenEventCount > 0
          ? ` · ${metadata.hiddenEventCount} folded into this block`
          : ""),
      tone: "dim",
    });
    if (metadata.childEntityIds.length > 0) {
      rows.push({
        id: "children",
        label: "Children",
        value: String(metadata.childEntityIds.length),
        tone: "dim",
      });
    }
  }
  if (live) {
    rows.push({
      id: "live-progress",
      label: "Progress",
      value: live.progressLabel,
      tone: toneForStatus(live.status),
    });
    for (const [index, detail] of live.detailLines.slice(0, 4).entries()) {
      rows.push({
        id: `live-detail-${index}`,
        label: index === 0 ? "Live" : "",
        value: detail,
        tone: index === 0 ? "text" : "dim",
      });
    }
  }
  if (parent) {
    rows.push({
      id: "parent",
      label: "Inside",
      value: parent.label,
      tone: "dim",
    });
  }
  if (selected.scope) {
    rows.push({
      id: "scope",
      label: "Scope",
      value: selected.scope,
      tone: "dim",
    });
  }
  if (selected.detail) {
    rows.push({
      id: "detail",
      label: "Detail",
      value: selected.detail,
      tone: "text",
    });
  }
  if (incoming.length > 0) {
    rows.push({
      id: "incoming",
      label: "From",
      value: incoming
        .slice(0, 2)
        .map((edge) => `${connectedNodeLabel(state, edge.source)} (${edge.kind})`)
        .join(", "),
      tone: "dim",
    });
  }
  if (outgoing.length > 0) {
    rows.push({
      id: "outgoing",
      label: "To",
      value: outgoing
        .slice(0, 2)
        .map((edge) => `${connectedNodeLabel(state, edge.target)} (${edge.kind})`)
        .join(", "),
      tone: "dim",
    });
  }
  const sourceIds = new Set(metadata?.sourceNodeIds ?? [selected.id]);
  const sourceNodes = (options.rawState?.nodes ?? [])
    .filter((node) => sourceIds.has(node.id))
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-6);
  for (const source of sourceNodes) {
    rows.push({
      id: `event-${source.id}`,
      label: "Event",
      value:
        `#${String(source.sequence).padStart(3, "0")} ${source.eventType}`
        + (source.detail ? ` · ${source.detail}` : ""),
      tone: toneForStatus(source.status),
    });
  }
  return rows;
}

export function SessionFlowDetails({
  state,
  rawState = state,
  metadataByNodeId = {},
  liveStatusByNodeId = {},
  selectedId,
  theme,
  width,
}: {
  state: SessionFlowState;
  rawState?: SessionFlowState;
  metadataByNodeId?: Readonly<Record<string, SessionFlowHierarchyNodeMeta>>;
  liveStatusByNodeId?: Readonly<Record<string, SessionFlowLiveNodeStatus>>;
  selectedId: string | null;
  theme: Theme;
  width: number;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const selected =
    state.nodes.find((node) => node.id === selectedId) ??
    state.nodes.find((node) => node.status === "running") ??
    state.nodes.at(-1) ??
    null;
  const metadata = selected ? metadataByNodeId[selected.id] : undefined;
  const rows = sessionFlowDetailRows(state, selected?.id ?? null, {
    rawState,
    metadataByNodeId,
    liveStatusByNodeId,
  });
  const contentWidth = Math.max(8, width - 2);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Text color={t.accent} bold wrap="truncate-end">
        ▾ Selected block
      </Text>
      <Text color={selected ? t.text : t.dim} bold wrap="truncate-end">
        <MatrixText
          text={ellipsizeEnd(
            selected?.label || "No block selected",
            contentWidth,
          )}
          seed={971}
        />
      </Text>
      {rows.map((item) => (
        <Text
          key={item.id}
          color={colorForTone(item.tone, t)}
          wrap="truncate-end"
        >
          {item.label ? `${item.label}: ` : ""}
          <MatrixText
            text={ellipsizeEnd(
              item.value,
              Math.max(
                4,
                contentWidth - (item.label ? item.label.length + 2 : 0),
              ),
            )}
            seed={item.id.length * 97}
          />
        </Text>
      ))}
      <Text color={t.dim} wrap="truncate-end">
        {metadata?.drillable
          ? "Enter drill in · Esc go up · Space fold"
          : "Leaf block · Esc go up/close"}
      </Text>
    </Box>
  );
}
