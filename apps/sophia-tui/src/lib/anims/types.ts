/**
 * Shared cell model for Sophia TUI animations.
 *
 * Two surfaces, two jobs — never merged (see the animation handoff §0):
 *
 *   LINE (1 row)  — thinking + streaming. Matrix-decode lives here and only
 *                   here: committed tokens stay still, the in-flight token
 *                   scrambles then locks. One row, ever.
 *   LOAD (~12 rows) — an independent full-frame loader for cold start, long
 *                   tool waits and provider waits. Continuous 3D light fields
 *                   and the sparse dot-chain. Never painted while tokens are
 *                   streaming — the stream owns the row budget then.
 *
 * Both production Ink and the browser demo render from this one pure model so
 * an algorithm ports 1:1 between them: an animation is a function from
 * (frame tick, width, phase) to a grid of coloured cells. No timers, no I/O,
 * no React/Ink imports, no Math.random (tick-derived noise only) — pure and
 * deterministic so tests can pin exact frames.
 */

/** One terminal cell: a grapheme plus its RGB colour (0–255 each). */
export type Cell = {
  ch: string;
  r: number;
  g: number;
  b: number;
  bold?: boolean;
};

/** A frame is rows of cells. A LINE animation returns exactly one row. */
export type Frame = Cell[][];

/** A single rendered row (a Frame with height 1). */
export type Row = Cell[];

export type AnimInstance = {
  /** frame = integer tick; width = terminal columns; phase = LoadPhase */
  render: (frame: number, width: number, phase: string) => Frame;
};

export type AnimFactory = () => AnimInstance;

/** Row budget for LOAD animations. LINE is always exactly 1 row. */
export const LINE_HEIGHT = 1;
export const LOAD_HEIGHT = 12;
