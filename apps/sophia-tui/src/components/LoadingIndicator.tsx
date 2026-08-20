import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import {
  phaseLabel,
  SPINNER_FRAMES,
  type LoadPhase,
  type ProgressState,
} from "../lib/progress.js";
import { accessibleTheme, spinnerFrame, type AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  EMPTY_FRONTIER,
  advanceFrontier,
  coalesceRuns,
  renderDecode,
  shimmerLabel,
  type FrontierState,
  type Row,
} from "../lib/anims/index.js";

const ACTIVE: LoadPhase[] = [
  "starting",
  "planning",
  "thinking",
  "tool",
  "streaming",
  "awaiting_permission",
  "finalizing",
];

const ANIMATION_INTERVAL_MS = 100;
const CHAT_DECODE_STYLE = "matrix";

/**
 * Whether the spinner's setInterval should run at all.
 *
 * Gating just the glyph (via spinnerFrame) is not enough: an interval that
 * still ticks every 80ms forces a re-render on the same cadence, and a screen
 * reader's live-region behaviour re-announces text on every change even when
 * the rendered glyph happens to come out the same. Reduced motion has to stop
 * the timer, not just freeze what it draws.
 */
export function loadingIntervalEnabled(active: boolean, prefs: AccessibilityPrefs): boolean {
  return active && !prefs.reducedMotion;
}

/** The glyph for the current tick, honouring reduced motion via spinnerFrame. */
export function loadingSpinGlyph(
  prefs: AccessibilityPrefs,
  phase: LoadPhase,
  active: boolean,
  frames: readonly string[],
  tick: number,
): string {
  if (active) return spinnerFrame(prefs, frames, tick);
  if (phase === "done") return "✓";
  if (phase === "error") return "✗";
  return "·";
}

/**
 * Seconds since an active run/phase started, or null while idle/finished.
 *
 * A separate research pass on competing agent TUIs found Sophia was alone in
 * showing only a bare spinner on a long tool call, with no sense of elapsed
 * time. `startedAt`/`now` are both injected (never `Date.now()` read inline)
 * so this stays a pure, deterministic function to unit test.
 */
export function loadingElapsedSeconds(
  active: boolean,
  startedAt: number | null,
  now: number,
): number | null {
  if (!active || startedAt === null) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * "(Ns)" / "(Nm Ss)" suffix for the phase label, once a wait is long enough
 * to be worth surfacing — a fresh "(0s)" on every fast phase would just be
 * noise, not the "how long has this been running" signal a long tool call
 * needs.
 */
export function loadingElapsedSuffix(seconds: number | null, thresholdSeconds = 2): string {
  if (seconds === null || seconds < thresholdSeconds) return "";
  if (seconds < 60) return ` (${seconds}s)`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return ` (${m}m ${s}s)`;
}

/** The progress surface is always one replace-in-place row when present. */
export function loadingIndicatorHeight(progress: ProgressState): number {
  return progress.phase === "idle" ? 0 : 1;
}

/**
 * Align the decode frontier with the latest real bridge preview.
 *
 * Reduced motion folds the whole observed preview immediately: the row stays
 * informative, but no character is left in a synthetic "live" state that
 * would require a timer to settle. Leaving thinking/streaming resets the
 * frontier so text from one run or authority can never leak into the next.
 */
export function syncLoadingFrontier(
  state: FrontierState,
  preview: string,
  linePhase: boolean,
  reducedMotion: boolean,
): FrontierState {
  if (!linePhase) return EMPTY_FRONTIER;
  const next = advanceFrontier(state, preview);
  if (!reducedMotion) return next;
  return {
    committed: preview,
    current: "",
    localFrame: 0,
    lastPreview: preview,
  };
}

export interface LoadingAnimationSnapshot {
  job: "none" | "line";
  rows: Row[];
  renderedId: string;
}

/**
 * Pure one-line animation projection used by the Ink component and tests.
 *
 * Production deliberately does not route into the 3D LOAD engine. Full-pane
 * field redraws can interleave poorly with terminal input on slower terminals,
 * so the loading surface is limited to the status spinner plus an optional
 * one-row decode/shimmer. The engine remains available to the browser demo.
 */
export function loadingAnimationSnapshot({
  progress,
  prefs,
  frontier,
  frame,
  width,
}: {
  progress: ProgressState;
  prefs: AccessibilityPrefs;
  frontier: FrontierState;
  frame: number;
  width: number;
}): LoadingAnimationSnapshot {
  const safeWidth = Math.max(1, Math.floor(width));
  const carriesText = progress.phase === "streaming" || progress.phase === "thinking";

  if (carriesText && progress.streamPreview) {
    const staticDecode = prefs.reducedMotion;
    return {
      job: staticDecode ? "none" : "line",
      rows: [renderDecode(CHAT_DECODE_STYLE, {
        committed: staticDecode ? progress.streamPreview : frontier.committed,
        currentToken: staticDecode ? "" : frontier.current,
        localFrame: staticDecode ? 0 : frontier.localFrame,
        tick: staticDecode ? 0 : frame,
        width: safeWidth,
      })],
      renderedId: staticDecode ? "static-decode" : "matrix-decode",
    };
  }

  if (!prefs.reducedMotion && (
    progress.phase === "planning" || progress.phase === "finalizing"
  )) {
    return {
      job: "line",
      rows: [shimmerLabel(
        phaseLabel(progress.phase, progress.detail),
        frame,
        safeWidth,
      )],
      renderedId: "shimmer-label",
    };
  }

  return { job: "none", rows: [], renderedId: "static-status" };
}

function AnimatedInlineRow({ row }: { row: Row }): React.ReactElement {
  return (
    <>
      {coalesceRuns(row).map((run, index) => (
        <Text key={`${index}-${run.color}-${run.bold ? "b" : "n"}`} color={run.color} bold={run.bold}>
          {run.text}
        </Text>
      ))}
    </>
  );
}

export function LoadingIndicator({
  theme,
  progress,
  width,
}: {
  theme: Theme;
  progress: ProgressState;
  width: number;
}): React.ReactElement | null {
  const ax = useAccessibility();
  const [frame, setFrame] = useState(0);
  const active = ACTIVE.includes(progress.phase);
  const animatedLabelPhase =
    progress.phase === "planning" || progress.phase === "finalizing";

  useEffect(() => {
    if (!loadingIntervalEnabled(active, ax)) return;
    const id = setInterval(() => {
      setFrame((f) => f + 1);
    }, ANIMATION_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, ax.reducedMotion]);

  // Tracks when the CURRENT active run began (not each sub-phase within it),
  // so "Thinking…" -> "Running tool…" -> "Writing response…" reads as one
  // continuous elapsed count instead of resetting on every phase change.
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (active) {
      if (startedAtRef.current === null) startedAtRef.current = Date.now();
    } else {
      startedAtRef.current = null;
    }
  }, [active]);

  if (progress.phase === "idle") return null;

  const t = accessibleTheme(theme, ax);
  const label = phaseLabel(progress.phase, progress.detail);
  const spin = loadingSpinGlyph(
    ax,
    progress.phase,
    active,
    SPINNER_FRAMES,
    frame,
  );
  // Under reduced motion the spinner interval above never ticks, so this only
  // recomputes when something else causes a re-render (a real phase/detail
  // change) — informative updates still land, just not on an animation clock.
  const elapsedSeconds = loadingElapsedSeconds(active, startedAtRef.current, Date.now());
  const elapsedSuffix = loadingElapsedSuffix(elapsedSeconds);
  const color =
    progress.phase === "error"
      ? t.error
      : progress.phase === "done"
        ? t.success
        : progress.phase === "awaiting_permission"
          ? t.warn
          : t.accent;
  const labelWidth = Math.max(1, width - 2 - elapsedSuffix.length);
  const animatedLabel =
    !ax.screenReader
    && animatedLabelPhase
      ? loadingAnimationSnapshot({
          progress,
          prefs: ax,
          frontier: EMPTY_FRONTIER,
          frame,
          width: labelWidth,
        }).rows[0] ?? null
      : null;

  return (
    <Box width={width} flexShrink={0} marginY={0} overflowX="hidden">
      <Text color={color} bold>
        {spin}{" "}
      </Text>
      {animatedLabel
        ? <AnimatedInlineRow row={animatedLabel} />
        : <Text color={color}>{label}</Text>}
      {elapsedSuffix ? <Text color={t.dim}>{elapsedSuffix}</Text> : null}
    </Box>
  );
}
