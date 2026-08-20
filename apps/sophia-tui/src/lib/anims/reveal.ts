/**
 * Deterministic, layout-honest matrix reveal for ordinary TUI text.
 *
 * This is deliberately a presentation helper around the existing matrix
 * alphabet, not a second streaming engine. The caller supplies the previous
 * text that was already visible; that common prefix is immutable, while only
 * the newly observed suffix decodes left-to-right. No characters that are not
 * present in `text` are inferred or appended.
 */
import { graphemes, graphemeWidth } from "../textWidth.js";
import { glyph, LIVE_TOKEN_RGB, MATRIX_GLYPHS } from "./cells.js";

/**
 * The green frontier churns at the shared terminal redraw quantum. Literal
 * source commits the entire arrived suffix on the next redraw. There is no
 * 15–25 tok/s presentation cap, and no invented tokens.
 */
export const MATRIX_REVEAL_CHURN_DELAY_MS = 20;
export const MATRIX_REVEAL_MIN_PRESENTATION_TPS = 0;
export const MATRIX_REVEAL_MAX_PRESENTATION_TPS = Number.POSITIVE_INFINITY;
export const MATRIX_REVEAL_MIN_COMMIT_TICKS = 1;
export const MATRIX_REVEAL_MAX_COMMIT_TICKS = 1;
export const MATRIX_REVEAL_CURSOR_TAIL = 4;
export const MATRIX_REVEAL_MIN_BURST = 1;
export const MATRIX_REVEAL_MAX_BURST = Number.MAX_SAFE_INTEGER;
export const MATRIX_REVEAL_COLOR = `rgb(${LIVE_TOKEN_RGB.join(",")})`;
/** A negative segment frame means this wrapped row has not reached the visual frontier. */
export const MATRIX_REVEAL_PENDING_FRAME = -1;

export interface MatrixRevealCell {
  /** The exact observed grapheme. */
  source: string;
  /** The grapheme (or deterministic matrix stand-in) painted this frame. */
  display: string;
  /** True only while this observed grapheme is still decoding. */
  live: boolean;
}

export interface MatrixRevealRun {
  text: string;
  live: boolean;
}

export interface MatrixRevealState {
  /** Latest text that has actually arrived from the runtime. */
  text: string;
  /** Immutable observed prefix that was already committed visually. */
  previousText: string;
  /** Number of newly observed graphemes committed after previousText. */
  frame: number;
  /** High-frequency stand-in churn; advances even between literal commits. */
  churnFrame: number;
  /** Churn ticks elapsed since the last presentation-token commit. */
  ticksSinceCommit: number;
}

function revealable(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function typingBoundary(value: string): boolean {
  return /[\s.!?,;:。！？，；：、]/u.test(value);
}

function graphemePrefix(value: string, count: number): string {
  return graphemes(value).slice(0, Math.max(0, count)).join("");
}

/** Count the grapheme prefix that is identical in both observed strings. */
export function commonGraphemePrefix(a: string, b: string): number {
  const left = graphemes(a);
  const right = graphemes(b);
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

/** Frames required for the changed suffix to settle completely. */
export function matrixRevealFramesRequired(
  text: string,
  previousText: string,
): number {
  const units = graphemes(text);
  const stable = commonGraphemePrefix(previousText, text);
  return Math.max(0, units.length - stable);
}

/**
 * Split one message-wide frontier across its visual rows/segments.
 *
 * Earlier changed segments consume frames before later segments can settle,
 * preserving a true top-to-bottom, left-to-right sentence reveal after wrap.
 */
export function matrixRevealFramesBySegment(
  segments: readonly string[],
  previousSegments: readonly string[],
  frame: number,
): number[] {
  let precedingChanges = 0;
  return segments.map((segment, index) => {
    const segmentFrame = frame - precedingChanges;
    precedingChanges += matrixRevealFramesRequired(
      segment,
      previousSegments[index] ?? "",
    );
    return segmentFrame;
  });
}

/**
 * Delay before the next high-frequency green-frontier churn.
 *
 * Literal source commits on the next redraw quantum. The physical timer
 * stays shared so every active surface pulses together.
 */
export function matrixRevealDelayMs(_state: MatrixRevealState): number {
  return MATRIX_REVEAL_CHURN_DELAY_MS;
}

/**
 * Number of 20 ms churn ticks before the next literal presentation token.
 *
 * One tick = one redraw quantum. There is no 15–25 tok/s presentation band.
 */
export function matrixRevealCommitTicks({
  text,
  previousText,
  frame,
}: MatrixRevealState): number {
  const units = graphemes(text);
  const stable = commonGraphemePrefix(previousText, text);
  const index = stable + Math.max(0, Math.floor(frame));
  if (index >= units.length) return 0;
  return MATRIX_REVEAL_MIN_COMMIT_TICKS;
}

/**
 * Number of graphemes committed on the next timer tick.
 *
 * Commit every observed grapheme that has already arrived. This is not a
 * claim about provider tokenizer output. The queue still contains observed
 * text only, so a slower runtime naturally empties between arrivals.
 */
export function matrixRevealBurstSize({
  text,
  previousText,
  frame,
}: MatrixRevealState): number {
  const units = graphemes(text);
  const stable = commonGraphemePrefix(previousText, text);
  const index = stable + Math.max(0, Math.floor(frame));
  if (index >= units.length) return 0;
  return units.length - index;
}

/** Initial presentation state for one independently animated text surface. */
export function createMatrixRevealState(
  text: string,
  animateOnMount: boolean,
  reducedMotion: boolean,
): MatrixRevealState {
  return {
    text,
    previousText: animateOnMount && !reducedMotion ? "" : text,
    frame: 0,
    churnFrame: 0,
    ticksSinceCommit: 0,
  };
}

function committedText(state: MatrixRevealState): string {
  const stable = commonGraphemePrefix(state.previousText, state.text);
  const required = matrixRevealFramesRequired(
    state.text,
    state.previousText,
  );
  return graphemePrefix(
    state.text,
    stable + Math.min(required, Math.max(0, Math.floor(state.frame))),
  );
}

function isGraphemePrefix(prefix: string, value: string): boolean {
  const left = graphemes(prefix);
  const right = graphemes(value);
  return left.length <= right.length
    && left.every((unit, index) => unit === right[index]);
}

/**
 * Incorporate newly observed text without promoting unrevealed tokens.
 *
 * Streaming appends extend the existing queue and preserve its current frame,
 * so a fast backend cannot skip the visual frontier. A correction/rewrite
 * keeps only the prefix that was genuinely committed before restarting the
 * changed suffix.
 */
export function syncMatrixRevealState(
  state: MatrixRevealState,
  text: string,
  reducedMotion: boolean,
): MatrixRevealState {
  if (reducedMotion) {
    return {
      text,
      previousText: text,
      frame: 0,
      churnFrame: 0,
      ticksSinceCommit: 0,
    };
  }
  if (state.text === text) return state;

  const required = matrixRevealFramesRequired(
    state.text,
    state.previousText,
  );
  if (required === 0 || state.frame >= required) {
    return {
      text,
      previousText: state.text,
      frame: 0,
      churnFrame: state.churnFrame,
      ticksSinceCommit: 0,
    };
  }
  if (isGraphemePrefix(state.text, text)) {
    return { ...state, text };
  }

  const locked = committedText(state);
  const stable = commonGraphemePrefix(locked, text);
  return {
    text,
    previousText: graphemePrefix(text, stable),
    frame: 0,
    churnFrame: state.churnFrame,
    ticksSinceCommit: 0,
  };
}

/**
 * Churn the green stand-ins once and commit every arrived suffix grapheme.
 */
export function advanceMatrixRevealState(
  state: MatrixRevealState,
): MatrixRevealState {
  const required = matrixRevealFramesRequired(
    state.text,
    state.previousText,
  );
  if (required === 0) {
    return (
      state.previousText === state.text
      && state.frame === 0
      && state.ticksSinceCommit === 0
    )
      ? state
      : {
        text: state.text,
        previousText: state.text,
        frame: 0,
        churnFrame: state.churnFrame,
        ticksSinceCommit: 0,
      };
  }
  const churnFrame = state.churnFrame + 1;
  const ticksSinceCommit = state.ticksSinceCommit + 1;
  const commitTicks = matrixRevealCommitTicks(state);
  if (ticksSinceCommit < commitTicks) {
    return { ...state, churnFrame, ticksSinceCommit };
  }

  const nextFrame = state.frame + matrixRevealBurstSize(state);
  return nextFrame >= required
    ? {
      text: state.text,
      previousText: state.text,
      frame: 0,
      churnFrame,
      ticksSinceCommit: 0,
    }
    : {
      ...state,
      frame: nextFrame,
      churnFrame,
      ticksSinceCommit: 0,
    };
}

function matrixStandIn(source: string, code: number): string {
  const sourceFolded = source.toLocaleLowerCase("en-US");
  for (let offset = 0; offset < MATRIX_GLYPHS.length; offset += 1) {
    const candidate = glyph(code + offset);
    if (candidate.toLocaleLowerCase("en-US") !== sourceFolded) {
      return candidate;
    }
  }
  return glyph(code);
}

/**
 * Project one sentence/row into matrix cells.
 *
 * Committed text is painted literally in its final inherited style. Only the
 * short cursor tail is green and scrambled; the remaining observed suffix is
 * absent from the terminal tree. That absence is intentional: future wrapped
 * rows do not exist early, so Ink creates the next line only when the visible
 * frontier actually fills or commits a newline.
 */
export function matrixRevealCells({
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
}): MatrixRevealCell[] {
  const units = graphemes(text);
  if (frame < 0) {
    return units.map((source) => ({
      source,
      display: "",
      live: false,
    }));
  }
  const stable = commonGraphemePrefix(previousText, text);
  const required = matrixRevealFramesRequired(text, previousText);
  const settled = required === 0 || frame >= required;
  const lockCount = settled
    ? units.length
    : stable + Math.max(0, Math.floor(frame));

  let tailEnd = lockCount;
  while (
    tailEnd < units.length
    && tailEnd - lockCount < MATRIX_REVEAL_CURSOR_TAIL
  ) {
    const source = units[tailEnd] ?? "";
    if (tailEnd > lockCount && typingBoundary(source)) break;
    tailEnd += 1;
    if (typingBoundary(source)) break;
  }

  return units.map((source, index) => {
    if (index < lockCount) return { source, display: source, live: false };

    const live = revealable(source) && index < tailEnd;
    const width = Math.max(1, graphemeWidth(source));
    if (!live) {
      return {
        source,
        display: "",
        live: false,
      };
    }
    return {
      source,
      display: matrixStandIn(
        source,
        seed + churnFrame * 29 + frame * 13 + index * 17,
      )
        + " ".repeat(Math.max(0, width - 1)),
      live: true,
    };
  });
}

/** Coalesce adjacent stable/live cells for a small number of Ink Text nodes. */
export function matrixRevealRuns(opts: {
  text: string;
  previousText: string;
  frame: number;
  churnFrame?: number;
  seed?: number;
}): MatrixRevealRun[] {
  const runs: MatrixRevealRun[] = [];
  for (const cell of matrixRevealCells(opts)) {
    if (!cell.display) continue;
    const last = runs[runs.length - 1];
    if (last && last.live === cell.live) {
      last.text += cell.display;
    } else {
      runs.push({ text: cell.display, live: cell.live });
    }
  }
  return runs;
}
