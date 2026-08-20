import React from "react";
import { Box, Text } from "ink";
import type { AccessibilityPrefs } from "../lib/accessibility.js";
import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  countTeamLanes,
  readLaneBudget,
  teamDispatchDecision,
  type LaneBudgetMetric,
  type TeamDispatchDecision,
  type TeamLane,
  type TeamLaneLifecycle,
  type TeamLaneState,
  type TeamMergeState,
} from "../lib/teamLanes.js";
import { truncateToWidth } from "../lib/textWidth.js";
import type { Theme } from "../lib/theme.js";
import { MatrixText } from "./MatrixText.js";

export type TeamLanePanelLayout = "wide" | "compact" | "minimal";

export function teamLanePanelLayout(width: number): TeamLanePanelLayout {
  if (width >= 78) return "wide";
  if (width >= 46) return "compact";
  return "minimal";
}
export function teamLaneBorderStyle(
  prefs: AccessibilityPrefs,
): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

const LIFECYCLE_LABELS: Record<TeamLaneLifecycle, string> = {
  proposed: "proposed",
  queued: "queued",
  starting: "starting",
  running: "running",
  waiting: "waiting",
  succeeded: "succeeded",
  failed: "failed",
  cancelling: "cancelling",
  interrupting: "interrupting",
  cancelled: "cancelled",
  interrupted: "interrupted",
  abandoned: "abandoned",
};

const LIFECYCLE_GLYPHS: Record<TeamLaneLifecycle, string> = {
  proposed: "◇",
  queued: "○",
  starting: "◌",
  running: "▶",
  waiting: "…",
  succeeded: "✓",
  failed: "✗",
  cancelling: "■",
  interrupting: "!",
  cancelled: "■",
  interrupted: "!",
  abandoned: "⊘",
};

export function laneLifecycleLabel(lane: TeamLane): string {
  const controls: string[] = [];
  if (lane.control.cancel === "requested") controls.push("cancel requested");
  if (lane.control.cancel === "acknowledged") {
    controls.push("cancel acknowledged");
  }
  if (lane.control.cancel === "rejected") controls.push("cancel rejected");
  if (lane.control.cancel === "unsupported") {
    controls.push("cancel unsupported");
  }
  if (lane.control.interrupt === "requested") {
    controls.push("interrupt requested");
  }
  if (lane.control.interrupt === "acknowledged") {
    controls.push("interrupt acknowledged");
  }
  if (lane.control.interrupt === "rejected") {
    controls.push("interrupt rejected");
  }
  if (lane.control.interrupt === "unsupported") {
    controls.push("interrupt unsupported");
  }
  const base = LIFECYCLE_LABELS[lane.lifecycle];
  return controls.length ? `${base}; ${controls.join("; ")}` : base;
}

export function laneLifecycleGlyph(lifecycle: TeamLaneLifecycle): string {
  return LIFECYCLE_GLYPHS[lifecycle];
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}m`;
  }
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value));
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  return `${Math.round((seconds / 60) * 10) / 10}m`;
}

function metricText(
  metric: LaneBudgetMetric,
  formatter: (value: number) => string,
): string {
  const used =
    typeof metric.used === "number" && Number.isFinite(metric.used)
      ? formatter(metric.used)
      : "?";
  const limit =
    typeof metric.limit === "number" && Number.isFinite(metric.limit)
      ? formatter(metric.limit)
      : "?";
  const reading = readLaneBudget(metric);
  const mark =
    reading.status === "over"
      ? "!"
      : reading.status === "exhausted"
        ? "="
        : reading.status === "warning"
          ? "~"
          : "";
  const enforcement = reading.enforcementReported ? " enforced" : "";
  return `${used}/${limit}${mark}${enforcement}`;
}

export function laneBudgetSummary(lane: TeamLane): string {
  return [
    `tok ${metricText(lane.budgets.tokens, compactNumber)}`,
    `time ${metricText(lane.budgets.timeMs, formatDuration)}`,
    `tools ${metricText(lane.budgets.tools, compactNumber)}`,
  ].join(" · ");
}

const DISPATCH_LABELS: Record<TeamDispatchDecision, string> = {
  disabled: "legacy dispatch archived",
  "not-eligible": "legacy dispatch not eligible",
  "confirmation-required": "legacy dispatch required confirmation",
  eligible: "legacy dispatch was eligible",
};

export function teamDispatchLabel(state: TeamLaneState): string {
  const decision = teamDispatchDecision(
    state.dispatch.policy,
    state.taskEligible,
  );
  return `${DISPATCH_LABELS[decision]} · ${state.dispatch.source}`;
}

const MERGE_LABELS: Record<TeamMergeState, string> = {
  idle: "merge idle",
  collecting: "collecting lane results",
  ready: "results ready to merge",
  merging: "merge in progress",
  merged: "merge reported complete",
  conflict: "merge conflicts require review",
  failed: "merge reported failed",
};

export function teamMergeLabel(state: TeamLaneState): string {
  const open = state.merge.conflicts.filter(
    (conflict) => conflict.state === "open",
  ).length;
  const excluded = state.merge.excludedLaneIds.length;
  return [
    MERGE_LABELS[state.merge.state],
    open ? `${open} open conflict${open === 1 ? "" : "s"}` : "",
    excluded ? `${excluded} excluded lane${excluded === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function teamLaneLine(
  lane: TeamLane,
  width: number,
  layout: TeamLanePanelLayout = teamLanePanelLayout(width),
): string {
  const title = lane.title.trim();
  const roleValue = lane.role?.trim() || "";
  const titleContainsRole =
    roleValue.length > 0 &&
    title.toLocaleLowerCase().includes(roleValue.toLocaleLowerCase());
  const role = roleValue && !titleContainsRole ? ` · ${roleValue}` : "";
  const division =
    lane.division &&
    !title.toLocaleLowerCase().includes(lane.division.toLocaleLowerCase())
      ? ` · ${lane.division}`
      : "";
  const result =
    lane.result.state !== "none" ? ` · result:${lane.result.state}` : "";
  const controls = laneLifecycleLabel(lane);
  const base = `${laneLifecycleGlyph(lane.lifecycle)} ${title} · ${controls}${role}${division}${result}`;
  const full =
    layout === "wide" ? `${base} · ${laneBudgetSummary(lane)}` : base;
  return truncateToWidth(full, Math.max(1, width));
}

function laneColor(lane: TeamLane, theme: Theme): string {
  if (
    lane.lifecycle === "failed" ||
    lane.result.state === "failed" ||
    lane.result.state === "conflict"
  ) {
    return theme.error;
  }
  if (
    lane.lifecycle === "cancelled" ||
    lane.lifecycle === "interrupted" ||
    lane.lifecycle === "abandoned" ||
    lane.control.cancel === "requested" ||
    lane.control.interrupt === "requested"
  ) {
    return theme.warn;
  }
  if (lane.lifecycle === "succeeded") return theme.success;
  if (
    lane.lifecycle === "running" ||
    lane.lifecycle === "starting" ||
    lane.lifecycle === "waiting"
  ) {
    return theme.tool;
  }
  return theme.text;
}

/**
 * Display-only compatibility panel for parallel lane receipts. Parent wiring
 * owns selection and control requests; this component never starts, cancels,
 * interrupts, or merges work.
 */
export function TeamLanePanel({
  state,
  theme,
  width,
}: {
  state: TeamLaneState;
  theme: Theme;
  width: number;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const layout = teamLanePanelLayout(width);
  const counts = countTeamLanes(state.lanes);
  const innerWidth = Math.max(1, width - (ax.screenReader ? 0 : 4));
  const seenLaneIdsRef = React.useRef<Set<string>>(
    new Set(state.lanes.map((lane) => lane.id)),
  );
  const newLaneIds = new Set(
    state.lanes
      .filter((lane) => !seenLaneIdsRef.current.has(lane.id))
      .map((lane) => lane.id),
  );
  React.useEffect(() => {
    for (const lane of state.lanes) seenLaneIdsRef.current.add(lane.id);
  }, [state.lanes]);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={teamLaneBorderStyle(ax)}
      borderColor={t.border}
      paddingX={ax.screenReader ? 0 : 1}
    >
      <Text color={t.accent} bold>
        Parallel agent lanes
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        <MatrixText
          text={truncateToWidth(
            `${teamDispatchLabel(state)} · local only`,
            innerWidth,
          )}
          seed={701}
        />
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        <MatrixText
          text={truncateToWidth(
            `${counts.total} lanes · ${counts.active} active · ${counts.terminal} terminal${counts.controlPending ? ` · ${counts.controlPending} control pending` : ""}`,
            innerWidth,
          )}
          seed={719}
        />
      </Text>

      {state.lanes.length === 0 ? (
        <Text color={t.dim}>No parallel lanes reported by the kernel.</Text>
      ) : (
        state.lanes.map((lane) => (
          <Text
            key={lane.id}
            color={laneColor(lane, t)}
            bold={state.selectedLaneId === lane.id}
            wrap="truncate-end"
          >
            {state.selectedLaneId === lane.id ? "› " : "  "}
            <MatrixText
              text={teamLaneLine(
                lane,
                Math.max(1, innerWidth - 2),
                layout,
              )}
              animateOnMount={newLaneIds.has(lane.id)}
              seed={lane.id.length * 59}
            />
          </Text>
        ))
      )}

      <Text
        color={
          state.merge.state === "conflict" || state.merge.state === "failed"
            ? t.warn
            : t.dim
        }
        wrap="truncate-end"
      >
        <MatrixText
          text={truncateToWidth(teamMergeLabel(state), innerWidth)}
          seed={743}
        />
      </Text>
      {layout === "wide" ? (
        <Text color={t.dim} wrap="truncate-end">
          Budget meters are informational unless marked enforced by the kernel.
        </Text>
      ) : null}
    </Box>
  );
}
