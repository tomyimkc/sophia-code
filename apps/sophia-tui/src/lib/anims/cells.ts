/**
 * Cell-level helpers shared by LINE and LOAD animations: glyph alphabets,
 * shade ramps, the cool-light tint, and run coalescing.
 *
 * Colour law (handoff §8): light is cool white/cyan — never rainbow-slop.
 * Matrix green is reserved for the streaming frontier's live glyphs.
 */
import type { Cell, Row } from "./types.js";

/** ASCII-only Matrix alphabet: exactly 26 English letters plus binary digits. */
export const MATRIX_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ01";

/** Deterministic glyph pick from any alphabet: index wraps, so tick-derived
 *  noise is stable and never out of range. */
export function glyphFrom(alphabet: string, i: number): string {
  return alphabet[((i % alphabet.length) + alphabet.length) % alphabet.length];
}

/** Deterministic glyph pick from the matrix alphabet. */
export function glyph(i: number): string {
  return glyphFrom(MATRIX_GLYPHS, i);
}

/** Shade ramp for continuous 3D fields: dark → bright. */
export const SHADE = " .:-=+*#%@█";

/** Map a 0–1 luminance onto the shade ramp. */
export function shade(lum: number): string {
  const i = Math.max(0, Math.min(SHADE.length - 1, Math.floor(lum * SHADE.length)));
  return SHADE[i];
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Cool light tint (loading, not rainbow): near-black base rising to a pale
 * cyan-white. `warm` (0–1) nudges the highlight toward amber for crest/spec
 * accents without ever leaving the cool family.
 */
export function light(lum: number, warm = 0): [number, number, number] {
  const t = clamp01(lum);
  const w = clamp01(warm);
  const k = t * t;
  // Clamp each channel: the raw handoff formula lets blue reach 287 at full
  // luminance, but Cell promises 0–255 and coalescing must not carry overflow.
  const ch = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return [
    ch(18 + k * (210 + w * 40)),
    ch(24 + k * (228 - w * 20)),
    ch(32 + k * (255 - w * 80)),
  ];
}

/** Matrix palette: the live frontier glyph and the settled stream text. */
export const LIVE_TOKEN_RGB: readonly [number, number, number] = [70, 255, 90];
export const STABLE_TEXT_RGB: readonly [number, number, number] = [168, 198, 170];

/** An empty cell: dim near-black space. */
export function spaceCell(): Cell {
  return { ch: " ", r: 8, g: 8, b: 10 };
}

/** A w×h frame of empty cells. */
export function emptyFrame(w: number, h: number): Cell[][] {
  const rows: Cell[][] = [];
  for (let y = 0; y < h; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < w; x++) row.push(spaceCell());
    rows.push(row);
  }
  return rows;
}

/** `#rrggbb` for a cell. */
export function cellColor(c: Cell): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** One coalesced run of same-styled cells — the Ink `<Text>` / DOM span unit. */
export interface CellRun {
  text: string;
  color: string;
  bold: boolean;
}

/**
 * Group consecutive cells with identical colour+bold into runs, so a row of
 * ~100 cells becomes a handful of styled strings instead of 100 elements.
 */
export function coalesceRuns(row: Row): CellRun[] {
  const runs: CellRun[] = [];
  for (const c of row) {
    const color = cellColor(c);
    const bold = c.bold === true;
    const last = runs[runs.length - 1];
    if (last && last.color === color && last.bold === bold) {
      last.text += c.ch;
    } else {
      runs.push({ text: c.ch, color, bold });
    }
  }
  return runs;
}
