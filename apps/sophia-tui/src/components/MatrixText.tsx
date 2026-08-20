import React, { useEffect, useLayoutEffect, useState } from "react";
import { Text } from "ink";
import {
  MATRIX_REVEAL_COLOR,
  advanceMatrixRevealState,
  createMatrixRevealState,
  matrixRevealDelayMs,
  matrixRevealFramesRequired,
  matrixRevealRuns,
  syncMatrixRevealState,
  type MatrixRevealState,
} from "../lib/anims/index.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import type { AccessibilityPrefs } from "../lib/accessibility.js";

export interface MatrixRevealSnapshot {
  previousText: string;
  frame: number;
  churnFrame: number;
  active: boolean;
}

interface ScheduledMatrixTick {
  dueAt: number;
  run: () => void;
}

let nextMatrixTickId = 1;
let matrixTickTimer: ReturnType<typeof setTimeout> | null = null;
let matrixTickTimerDueAt = Number.POSITIVE_INFINITY;
const scheduledMatrixTicks = new Map<number, ScheduledMatrixTick>();
/** Cap terminal redraw cadence while preserving the per-surface typing rhythm. */
export const MATRIX_SCHEDULER_QUANTUM_MS = 20;

export function matrixRevealBucketDueAt(now: number, delayMs: number): number {
  const target = now + Math.max(0, delayMs);
  return Math.ceil(target / MATRIX_SCHEDULER_QUANTUM_MS)
    * MATRIX_SCHEDULER_QUANTUM_MS;
}

function armMatrixTickTimer(): void {
  let nextDueAt = Number.POSITIVE_INFINITY;
  for (const task of scheduledMatrixTicks.values()) {
    nextDueAt = Math.min(nextDueAt, task.dueAt);
  }

  if (!Number.isFinite(nextDueAt)) {
    if (matrixTickTimer) clearTimeout(matrixTickTimer);
    matrixTickTimer = null;
    matrixTickTimerDueAt = Number.POSITIVE_INFINITY;
    return;
  }
  if (matrixTickTimer && nextDueAt >= matrixTickTimerDueAt) return;

  if (matrixTickTimer) clearTimeout(matrixTickTimer);
  matrixTickTimerDueAt = nextDueAt;
  matrixTickTimer = setTimeout(() => {
    matrixTickTimer = null;
    matrixTickTimerDueAt = Number.POSITIVE_INFINITY;
    const now = Date.now();
    const ready = [...scheduledMatrixTicks.entries()]
      .filter(([, task]) => task.dueAt <= now)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [id, task] of ready) {
      scheduledMatrixTicks.delete(id);
      task.run();
    }
    armMatrixTickTimer();
  }, Math.max(0, nextDueAt - Date.now()));
}

/**
 * All text surfaces share one physical timer. React 19 batches callbacks that
 * become due together, while each surface still owns its own reveal frontier
 * and can therefore type in parallel with newer chat/tool/process updates.
 */
export function scheduleMatrixRevealTick(
  run: () => void,
  delayMs: number,
): () => void {
  const id = nextMatrixTickId++;
  const now = Date.now();
  scheduledMatrixTicks.set(id, {
    // Quantising every surface onto one terminal-friendly pulse is the
    // important performance property: twenty independently changing rows do
    // not turn into twenty slightly offset full-screen Ink redraws.
    dueAt: matrixRevealBucketDueAt(now, delayMs),
    run,
  });
  armMatrixTickTimer();
  return () => {
    if (!scheduledMatrixTicks.delete(id)) return;
    armMatrixTickTimer();
  };
}

export function matrixRevealSchedulerSnapshot(): {
  queuedTicks: number;
  timerArmed: boolean;
} {
  return {
    queuedTicks: scheduledMatrixTicks.size,
    timerArmed: matrixTickTimer !== null,
  };
}

export function matrixRevealIntervalEnabled(
  active: boolean,
  reducedMotion: boolean,
): boolean {
  return active && !reducedMotion;
}

/**
 * Keep one frontier per changing text surface.
 *
 * Completed or appended text joins this surface's presentation queue without
 * resetting its timer or promoting content ahead of the visual frontier.
 * Separate MatrixText/useMatrixReveal instances own separate frontiers, so a
 * newer chat/tool surface starts immediately while older text keeps typing;
 * their due ticks are coalesced by the one shared scheduler above.
 */
export function useMatrixReveal(
  text: string,
  opts: {
    animateOnMount?: boolean;
    reducedMotion: boolean;
  },
): MatrixRevealSnapshot {
  const { animateOnMount = false, reducedMotion } = opts;
  const [state, setState] = useState<MatrixRevealState>(() =>
    createMatrixRevealState(text, animateOnMount, reducedMotion)
  );
  const effective = syncMatrixRevealState(state, text, reducedMotion);
  const changed =
    state.text !== effective.text
    || state.previousText !== effective.previousText
    || state.frame !== effective.frame
    || state.churnFrame !== effective.churnFrame
    || state.ticksSinceCommit !== effective.ticksSinceCommit;
  const required = matrixRevealFramesRequired(
    effective.text,
    effective.previousText,
  );
  const active = !reducedMotion && required > 0 && effective.frame < required;
  const nextDelay = matrixRevealDelayMs(effective);

  useLayoutEffect(() => {
    if (!changed) return;
    setState(effective);
  }, [changed, effective]);

  useEffect(() => {
    if (!matrixRevealIntervalEnabled(active, reducedMotion)) return;
    return scheduleMatrixRevealTick(() => {
      setState((current) => advanceMatrixRevealState(current));
    }, nextDelay);
  }, [
    active,
    effective.frame,
    effective.churnFrame,
    effective.previousText,
    effective.ticksSinceCommit,
    nextDelay,
    reducedMotion,
  ]);

  return {
    previousText: effective.previousText,
    frame: effective.frame,
    churnFrame: effective.churnFrame,
    active,
  };
}

/** Inline glyph runs; the parent Text keeps its original typography/color. */
export function MatrixGlyphRuns({
  text,
  previousText,
  frame,
  churnFrame = frame,
  seed = 0,
}: {
  text: string;
  previousText: string;
  frame: number;
  churnFrame?: number;
  seed?: number;
}): React.ReactElement {
  return (
    <>
      {matrixRevealRuns({
        text,
        previousText,
        frame,
        churnFrame,
        seed,
      }).map((run, index) => (
        <Text
          key={`${index}-${run.live ? "live" : "stable"}`}
          color={run.live ? MATRIX_REVEAL_COLOR : undefined}
          bold={run.live || undefined}
        >
          {run.text}
        </Text>
      ))}
    </>
  );
}

/**
 * Standalone one-line text that animates when its value changes.
 * Initial content is static by default so resumed/history views do not replay.
 */
export function MatrixText({
  text,
  animateOnMount = false,
  seed = 0,
}: {
  text: string;
  animateOnMount?: boolean;
  seed?: number;
}): React.ReactElement {
  const ax = useAccessibility();
  const reveal = useMatrixReveal(text, {
    animateOnMount,
    reducedMotion: ax.reducedMotion,
  });
  return (
    <MatrixGlyphRuns
      text={text}
      previousText={reveal.previousText}
      frame={reveal.frame}
      churnFrame={reveal.churnFrame}
      seed={seed}
    />
  );
}

export interface MatrixDigitSegment {
  kind: "stable" | "digits";
  text: string;
  ordinal: number;
}

/**
 * Split a live label into literal sentence chrome and independently changing
 * ASCII-digit runs. Time formatters in the TUI emit ASCII digits; keeping the
 * boundary deliberately narrow means units, spaces, punctuation, and status
 * words can never enter the matrix presenter by accident.
 */
export function matrixDigitSegments(text: string): MatrixDigitSegment[] {
  const segments: MatrixDigitSegment[] = [];
  const digitPattern = /[0-9]+/g;
  let cursor = 0;
  let digitOrdinal = 0;
  let stableOrdinal = 0;

  for (const match of text.matchAll(digitPattern)) {
    const start = match.index;
    if (start > cursor) {
      segments.push({
        kind: "stable",
        text: text.slice(cursor, start),
        ordinal: stableOrdinal++,
      });
    }
    segments.push({
      kind: "digits",
      text: match[0],
      ordinal: digitOrdinal++,
    });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) {
    segments.push({
      kind: "stable",
      text: text.slice(cursor),
      ordinal: stableOrdinal,
    });
  }
  return segments;
}

export function matrixDigitAnimationEnabled(
  prefs: Pick<AccessibilityPrefs, "reducedMotion" | "screenReader">,
): boolean {
  return !prefs.reducedMotion && !prefs.screenReader;
}

/**
 * Inline live-label presenter that matrix-decodes only numeric runs.
 *
 * Each run owns a MatrixText frontier, so changing seconds cannot re-scramble
 * a later total-duration number. Literal sentence text is rendered directly
 * and accessibility modes bypass animated children altogether.
 */
export function MatrixDigitsText({
  text,
  animateOnMount = false,
  seed = 0,
}: {
  text: string;
  animateOnMount?: boolean;
  seed?: number;
}): React.ReactElement {
  const ax = useAccessibility();
  const animateDigits = matrixDigitAnimationEnabled(ax);
  return (
    <>
      {matrixDigitSegments(text).map((segment) => {
        const key = `${segment.kind}-${segment.ordinal}`;
        if (segment.kind === "stable" || !animateDigits) {
          return <React.Fragment key={key}>{segment.text}</React.Fragment>;
        }
        return (
          <MatrixText
            key={key}
            text={segment.text}
            animateOnMount={animateOnMount}
            seed={seed + segment.ordinal * 131}
          />
        );
      })}
    </>
  );
}
