import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import { displayWidth } from "./PromptInput.js";
import { ellipsizeEnd, modelDisplayName } from "../lib/useTerminalSize.js";
import { EpistemicChip, type EpistemicStatus } from "./EpistemicChip.js";
import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { loadingElapsedSeconds, loadingElapsedSuffix } from "./LoadingIndicator.js";
import {
  contextPressure,
  formatLocalThroughput,
  type ContextPressureLevel,
} from "../lib/localOps.js";

export const BRAND = "My Sophia Code";
const BRAND_W = 14;
export const SEP = " · ";
const SEP_W = 3;
const RUNNING_LABEL = "running…";
const RUNNING_LABEL_W = 8;
// EpistemicChip.tsx is not owned by this file and exposes no width budget of
// its own — status.label is bridge-supplied text and can be arbitrarily
// long. This is a deliberate OVER-estimate of its typical rendered footprint
// (" · X delivered_unreviewed") used only to decide how aggressively to
// shrink the fields this file DOES control; an unusually long label can
// still push a row past `width` on that turn, which is a pre-existing gap in
// EpistemicChip, not something closeable from here (see StatusLine.test.ts).
const EPISTEMIC_RESERVE_W = 26;

export interface StatusLineLayout {
  model: string;
  bridgeWord: string;
  session: string | null;
  mode: string | null;
  effort: string | null;
  showRunning: boolean;
  showRunningElapsed: boolean;
  showEpistemicHint: boolean;
  /** null when no contextUsage was given; otherwise the rendered label plus
   * its level, so the caller can colour it without re-deriving the level. */
  context: { text: string; level: ContextPressureLevel } | null;
  /** null when no throughput sample was given, or it was dropped for width. */
  throughput: string | null;
}

export type A2ADisplayMode = "off" | "serial" | "parallel";

export interface ControlStatusChip {
  label: "Permission" | "AGI" | "A2A" | "Workflow";
  value: string;
}

/**
 * Resolve the effective next-run orchestration shown by the status chrome.
 *
 * Workflow owns parallel A2A routing. Prime and AGI own different execution
 * paths, so stored A2A preferences are accurately shown as suspended/off there.
 */
export function resolveOrchestrationStatus(opts: {
  executionRuntime: "sophia" | "prime";
  agiMode: boolean;
  a2aAgents: number;
  workflowMode?: "off" | "auto" | "on";
  workflowActive?: boolean;
  /** Kernel-observed supervisor concurrency for the active A2A run. */
  a2aConcurrency?: number | null;
}): {
  agiEnabled: boolean;
  a2aMode: A2ADisplayMode;
  workflowMode: "off" | "auto" | "on" | "active";
} {
  const agiEnabled = opts.executionRuntime === "sophia" && opts.agiMode;
  const workflowEnabled =
    opts.executionRuntime === "sophia"
    && !agiEnabled
    && opts.workflowMode !== undefined
    && opts.workflowMode !== "off";
  const a2aMode =
    opts.executionRuntime !== "sophia" || agiEnabled
      ? "off"
      : workflowEnabled
          ? "parallel"
          : opts.a2aAgents !== 0
          ? (opts.a2aConcurrency ?? 1) > 1
            ? "parallel"
            : "serial"
          : "off";
  return {
    agiEnabled,
    a2aMode,
    workflowMode:
      opts.executionRuntime !== "sophia" || agiEnabled
        ? "off"
        : opts.workflowActive
          ? "active"
          : opts.workflowMode ?? "off",
  };
}

/**
 * Lay out the explicit routing/safety controls on one or more rows.
 *
 * These labels intentionally include words as well as colour: "auto" by
 * itself was ambiguous, and colour alone is not an accessible status signal.
 * Greedy wrapping keeps every control visible at the TUI's practical minimum
 * width instead of silently dropping AGI/A2A under pressure.
 */
export function controlStatusRows(opts: {
  width: number;
  permission: string;
  agiEnabled: boolean;
  a2aMode: A2ADisplayMode;
  workflowMode: "off" | "auto" | "on" | "active";
}): ControlStatusChip[][] {
  const chips: ControlStatusChip[] = [
    { label: "Permission", value: opts.permission },
    { label: "AGI", value: opts.agiEnabled ? "on" : "off" },
    { label: "A2A", value: opts.a2aMode },
    { label: "Workflow", value: opts.workflowMode },
  ];
  const width = Math.max(1, Math.floor(opts.width));
  const rows: ControlStatusChip[][] = [];
  let row: ControlStatusChip[] = [];
  let rowWidth = 0;

  for (const chip of chips) {
    const chipWidth = displayWidth(`${chip.label}: ${chip.value}`);
    const nextWidth = rowWidth + (row.length ? SEP_W : 0) + chipWidth;
    if (row.length && nextWidth > width) {
      rows.push(row);
      row = [chip];
      rowWidth = chipWidth;
    } else {
      row.push(chip);
      rowWidth = nextWidth;
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

/**
 * Budget every field in the status row to `width` columns so the row can
 * never overflow into Ink's raw hard-clip. Before this function existed, the
 * name/model/effort/permission fields had no width budget at all: on a real
 * 107-column terminal with a long mlx model path the row ran to 109 columns
 * and Ink dropped arbitrary characters near the boundary — sometimes mid-word
 * ("sophia"->"sophi", "medium"->"mediu"), sometimes a separator itself
 * (producing two fields glued together with no space). Both are the same
 * corruption mechanism; keeping total row width <= `width` removes the
 * trigger for either.
 *
 * Priority when the terminal is too narrow to show every field (lowest
 * priority — dropped first — listed first): the live throughput chip
 * (decorative telemetry; a rate that cannot be shown this instant is not
 * worth losing anything else on this row for) -> the epistemic "(^g)" hint
 * suffix (decorative — the safety glyph+label itself always renders when
 * EpistemicChip gets a status) -> the running badge's elapsed-time suffix ->
 * the running badge itself (LoadingIndicator already shows a spinner plus its
 * own elapsed time for the same event, so this is the most dispensable field
 * under pressure) -> a context-pressure reading that has NOT reached
 * critical (useful, but checkable on demand via /context, so it competes for
 * whatever room effort/mode/session left rather than displacing them) ->
 * reasoning effort and mode (both are configuration state, checkable on
 * demand via /effort and /mode, not identity or safety signals) -> the
 * session name. Model identity, bridge connectivity, and a CRITICAL
 * context-pressure reading are never dropped, only shortened. Permission and
 * orchestration state render on their own wrapped control rows below, so they
 * remain explicit without squeezing or corrupting this telemetry row.
 */
export function layoutStatusLine(opts: {
  width: number;
  model: string;
  effort?: string;
  mode: string;
  /** Retained for source compatibility; permission renders on control rows. */
  permission?: string;
  bridgeReady: boolean;
  session: string;
  running: boolean;
  hasEpistemicChip: boolean;
  /** Raw used/window token counts; percentage and level are derived here via
   * lib/localOps's contextPressure so "unknown window" is worded honestly
   * rather than the caller having to remember to check for a null window. */
  contextUsage?: { used: number; window: number | null } | null;
  /** A live local-model sample; formatting (and its own internal budget-
   * aware truncation) is delegated to lib/localOps's formatLocalThroughput. */
  throughput?: { tokensPerSec?: number; ttftMs?: number } | null;
  /** Omit branding only for an explicitly unbranded embedding. */
  showBrand?: boolean;
  /** Session identity can move to the prompt's workspace-context row. */
  showSession?: boolean;
}): StatusLineLayout {
  const {
    width, model, effort, mode, bridgeReady, session, running, hasEpistemicChip,
    contextUsage, throughput, showBrand = true, showSession = true,
  } = opts;
  const bridgeWord = bridgeReady ? "bridge" : "no-bridge";
  const pressure = contextUsage ? contextPressure(contextUsage.used, contextUsage.window) : null;

  let used = showBrand ? BRAND_W : 0;
  if (hasEpistemicChip) used += EPISTEMIC_RESERVE_W;
  used += SEP_W + displayWidth(bridgeWord);

  // Model gets the next claim on the row, generously capped so the optional
  // fields below still have a shot at fitting; floored so a basename stays
  // legible even under real width pressure.
  const modelPrefixWidth = showBrand ? SEP_W : 0;
  const modelBudget = Math.max(1, Math.min(width - used - modelPrefixWidth, 40));
  const modelText = modelDisplayName(model, modelBudget);
  used += modelPrefixWidth + displayWidth(modelText);

  let remaining = width - used;

  // A critical reading is checked FIRST among the optional fields — see the
  // doc comment above for why it outranks session/mode/effort/running.
  let context: { text: string; level: ContextPressureLevel } | null = null;
  if (pressure && pressure.level === "critical" && remaining >= SEP_W + displayWidth(pressure.label)) {
    context = { text: pressure.label, level: pressure.level };
    remaining -= SEP_W + displayWidth(pressure.label);
  }

  let sessionText: string | null = null;
  const sessionBudget = Math.min(24, remaining - SEP_W);
  if (showSession && session.trim() && sessionBudget >= 6) {
    sessionText = ellipsizeEnd(session, sessionBudget);
    remaining -= SEP_W + displayWidth(sessionText);
  }

  let modeText: string | null = null;
  if (remaining >= SEP_W + displayWidth(mode)) {
    modeText = mode;
    remaining -= SEP_W + displayWidth(mode);
  }

  let effortText: string | null = null;
  if (effort && remaining >= SEP_W + displayWidth(effort)) {
    effortText = effort;
    remaining -= SEP_W + displayWidth(effort);
  }

  // A non-critical reading (ok/warn/unknown) only gets whatever room is left
  // once effort/mode/session have already claimed theirs — it is informative,
  // not urgent, so it never displaces them the way a critical one does above.
  if (pressure && !context && remaining >= SEP_W + displayWidth(pressure.label)) {
    context = { text: pressure.label, level: pressure.level };
    remaining -= SEP_W + displayWidth(pressure.label);
  }

  let showRunning = false;
  let showRunningElapsed = false;
  if (running && remaining >= SEP_W + RUNNING_LABEL_W) {
    showRunning = true;
    remaining -= SEP_W + RUNNING_LABEL_W;
    if (remaining >= 9) {
      // Room for a " (12s)" / " (1m 5s)"-shaped suffix (loadingElapsedSuffix).
      showRunningElapsed = true;
      remaining -= 9;
    }
  }

  const showEpistemicHint = hasEpistemicChip && remaining >= 5; // " (^g)"

  // Decorative telemetry, computed dead last: it takes only what nothing
  // else above needed. formatLocalThroughput already caps itself to the
  // given budget and drops its own least-useful segment (elapsed, then ttft)
  // first, so this never needs a second truncation pass on top of it.
  let throughputText: string | null = null;
  if (throughput) {
    const budget = remaining - SEP_W;
    if (budget > 0) {
      const formatted = formatLocalThroughput(
        { tokensPerSec: throughput.tokensPerSec, ttftMs: throughput.ttftMs },
        budget,
      );
      if (formatted) {
        throughputText = formatted;
        remaining -= SEP_W + displayWidth(formatted);
      }
    }
  }

  return {
    model: modelText,
    bridgeWord,
    session: sessionText,
    mode: modeText,
    effort: effortText,
    showRunning,
    showRunningElapsed,
    showEpistemicHint,
    context,
    throughput: throughputText,
  };
}

/**
 * Colour for a context-pressure reading: critical is an error (compaction is
 * imminent), warn is a caution, and ok/unknown are informational only — no
 * different from the mode/session fields around them. The reading's WORD
 * ("critical", "getting full", "unknown window") always carries the same
 * information as the colour, per accessibility.ts's no-colour-alone rule.
 */
export function contextPressureColor(level: ContextPressureLevel, theme: Theme): string {
  if (level === "critical") return theme.error;
  if (level === "warn") return theme.warn;
  return theme.dim;
}

function controlStatusValueColor(chip: ControlStatusChip, theme: Theme): string {
  if (chip.label === "Permission") {
    if (chip.value === "manual") return theme.warn;
    if (chip.value === "auto") return theme.success;
    return theme.tool;
  }
  if (chip.label === "AGI") return chip.value === "on" ? theme.accent : theme.dim;
  if (chip.label === "A2A") {
    if (chip.value === "parallel") return theme.success;
    if (chip.value === "serial") return theme.tool;
    return theme.dim;
  }
  if (chip.label === "Workflow") {
    if (chip.value === "active") return theme.warn;
    if (chip.value === "on") return theme.success;
    if (chip.value === "auto") return theme.tool;
    return theme.dim;
  }
  return chip.value === "on" ? theme.success : theme.dim;
}

export function StatusLine({
  theme,
  model,
  permission,
  mode,
  session,
  running,
  bridgeReady,
  status,
  width,
  effort,
  epistemic,
  contextUsage,
  throughput,
  agiEnabled,
  a2aMode,
  workflowMode,
  showBrand = true,
  showSession = true,
}: {
  theme: Theme;
  model: string;
  permission: string;
  mode: string;
  session: string;
  running: boolean;
  bridgeReady: boolean;
  status: string;
  width: number;
  effort?: string;
  epistemic?: EpistemicStatus | null;
  /** Optional so an unmodified call site (no kernel telemetry wired yet)
   * keeps compiling and simply never shows this field. */
  contextUsage?: { used: number; window: number | null } | null;
  /** Optional for the same reason; both are new, additive fields. */
  throughput?: { tokensPerSec?: number; ttftMs?: number } | null;
  /** Effective AGI-controller routing state; this is not a capability claim. */
  agiEnabled: boolean;
  /** Serial or parallel A2A execution, or neither. */
  a2aMode: A2ADisplayMode;
  /** Dynamic Main-controlled multi-stage parallel A2A routing. */
  workflowMode: "off" | "auto" | "on" | "active";
  /** Branding shares the runtime row; this remains for embedded callers. */
  showBrand?: boolean;
  /** The prompt context line can own session identity instead. */
  showSession?: boolean;
}): React.ReactElement {
  const ax = useAccessibility();
  // No animation lives on this line already; the fix here is colour, not
  // motion — see accessibleTheme's doc comment for why the theme prop alone
  // is not a trustworthy "screen-reader mode is colourless" guarantee.
  const t = accessibleTheme(theme, ax);

  // Tracks when the current `running` stretch began, from the `running` prop
  // this component already receives — no new prop or App.tsx wiring needed.
  // Mirrors LoadingIndicator's identical startedAtRef pattern so both "is
  // Sophia working" signals report the same elapsed count.
  const runningSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (running) {
      if (runningSinceRef.current === null) runningSinceRef.current = Date.now();
    } else {
      runningSinceRef.current = null;
    }
  }, [running]);

  // Re-render once a second while running so the elapsed suffix counts up.
  // Gated on reduced motion for the same reason LoadingIndicator gates its
  // own spinner interval (loadingIntervalEnabled): a second-by-second text
  // change is still a re-render a screen reader's live region re-announces.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!running || ax.reducedMotion) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running, ax.reducedMotion]);

  const layout = layoutStatusLine({
    width,
    model,
    effort,
    mode,
    bridgeReady,
    session,
    running,
    hasEpistemicChip: !!epistemic?.state,
    contextUsage,
    throughput,
    showBrand,
    showSession,
  });
  const elapsedSeconds = loadingElapsedSeconds(running, runningSinceRef.current, Date.now());
  const elapsedSuffix = layout.showRunningElapsed ? loadingElapsedSuffix(elapsedSeconds) : "";
  const controls = controlStatusRows({
    width,
    permission,
    agiEnabled,
    a2aMode,
    workflowMode,
  });

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {/* overflowX="hidden" is a safety net, not the primary fix: the layout
          above already budgets every field it controls to fit `width`, but
          EpistemicChip's label length is outside this file's control (see
          EPISTEMIC_RESERVE_W above). If an unusually long label still blows
          the budget, this clips cleanly at the boundary instead of letting
          Ink's raw hard-clip corrupt characters the way the original bug did. */}
      <Box width={width} overflowX="hidden">
        {showBrand ? (
          <>
            <Text color={t.accent} bold>
              {BRAND}
            </Text>
            <Text color={t.dim}>{SEP}</Text>
          </>
        ) : null}
        <Text color={t.text}>{layout.model}</Text>
        <EpistemicChip status={epistemic} theme={t} showHint={layout.showEpistemicHint} />
        {layout.effort ? (
          <>
            <Text color={t.dim}>{SEP}</Text>
            <Text color={t.tool}>{layout.effort}</Text>
          </>
        ) : null}
        {layout.mode ? (
          <>
            <Text color={t.dim}>{SEP}</Text>
            <Text color={t.dim}>{layout.mode}</Text>
          </>
        ) : null}
        <Text color={t.dim}>{SEP}</Text>
        <Text color={bridgeReady ? t.success : t.error}>{layout.bridgeWord}</Text>
        {layout.session ? (
          <>
            <Text color={t.dim}>{SEP}</Text>
            <Text color={t.dim}>{layout.session}</Text>
          </>
        ) : null}
        {layout.context ? (
          <>
            <Text color={t.dim}>{SEP}</Text>
            <Text color={contextPressureColor(layout.context.level, t)}>
              {layout.context.text}
            </Text>
          </>
        ) : null}
        {layout.throughput ? (
          <>
            <Text color={t.dim}>{SEP}</Text>
            <Text color={t.dim}>{layout.throughput}</Text>
          </>
        ) : null}
        {layout.showRunning ? (
          <>
            <Text color={t.dim}>{SEP}</Text>
            <Text color={t.warn}>{RUNNING_LABEL}</Text>
            {elapsedSuffix ? <Text color={t.dim}>{elapsedSuffix}</Text> : null}
          </>
        ) : null}
      </Box>
      {controls.map((row, rowIndex) => (
        <Box key={`controls-${rowIndex}`} width={width} overflowX="hidden">
          {row.map((chip, chipIndex) => (
            <React.Fragment key={chip.label}>
              {chipIndex > 0 ? <Text color={t.dim}>{SEP}</Text> : null}
              <Text color={t.tool}>{chip.label}: </Text>
              <Text color={controlStatusValueColor(chip, t)}>{chip.value}</Text>
            </React.Fragment>
          ))}
        </Box>
      ))}
      {status ? (
        <Text color={t.dim} wrap="truncate-end">
          {ellipsizeEnd(status, Math.max(1, width))}
        </Text>
      ) : null}
    </Box>
  );
}
