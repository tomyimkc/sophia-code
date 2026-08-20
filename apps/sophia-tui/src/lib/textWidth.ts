/**
 * Terminal COLUMNS, not character counts.
 *
 * A terminal cell is one column. CJK ideographs, kana, hangul, fullwidth forms
 * and most emoji occupy TWO of them; combining marks and zero-width characters
 * occupy none. The app previously counted one column per grapheme, which is
 * only correct for Latin text:
 *
 *   - PromptInput sliced a `avail`-COLUMN window by taking `avail` GRAPHEMES,
 *     so a line of CJK rendered up to twice the width of its box. The row
 *     overflowed and the inverse-video cursor cell landed away from the real
 *     caret position — it drifted further the more wide characters preceded it.
 *   - StatusLine budgets its fields with the same helper, so a CJK session
 *     name or model path overflowed the row it was measured to fit.
 *
 * `string-width` is the measurement authority. It already ships inside this
 * install (Ink depends on it), so making it a direct dependency adds no new
 * third-party code — it only makes the reliance explicit. Grapheme segmentation
 * uses the platform's own `Intl.Segmenter`, so a ZWJ family or a flag stays one
 * indivisible unit for cursor movement AND is measured as the two columns it
 * actually paints.
 */
import stringWidth from "string-width";

/** Split into user-perceived characters (a ZWJ emoji is ONE, not seven). */
export function graphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    return Array.from(
      new Segmenter(undefined, { granularity: "grapheme" }).segment(value),
      (x) => x.segment,
    );
  }
  return Array.from(value);
}

/** Columns one grapheme paints: 0 (control/zero-width), 1 (narrow) or 2 (wide). */
export function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  // Control characters are stripped before display; measure them as nothing
  // rather than letting string-width's own handling decide.
  if (/^[\x00-\x1f\x7f]$/.test(grapheme)) return 0;
  return stringWidth(grapheme);
}

/** Total columns a string paints once rendered. */
export function displayWidth(value: string): number {
  return graphemes(value).reduce((n, g) => n + graphemeWidth(g), 0);
}

/**
 * The longest prefix of `units` (from `from`) that fits in `maxColumns`.
 * Returns an exclusive end index; never splits a grapheme.
 */
export function endIndexWithin(units: readonly string[], from: number, maxColumns: number): number {
  let used = 0;
  let i = Math.max(0, from);
  while (i < units.length) {
    const w = graphemeWidth(units[i]);
    if (used + w > maxColumns) break;
    used += w;
    i++;
  }
  return i;
}

/** Truncate to fit `maxColumns`, appending `ellipsis` when anything was cut. */
export function truncateToWidth(value: string, maxColumns: number, ellipsis = "…"): string {
  if (maxColumns <= 0) return "";
  const units = graphemes(value);
  if (displayWidth(value) <= maxColumns) return value;
  const budget = Math.max(0, maxColumns - displayWidth(ellipsis));
  return units.slice(0, endIndexWithin(units, 0, budget)).join("") + ellipsis;
}

export interface CursorWindow {
  /** First grapheme index shown (inclusive). */
  start: number;
  /** Last grapheme index shown (exclusive). */
  end: number;
}

/**
 * The horizontal scroll window for a single-line input, measured in COLUMNS.
 *
 * Guarantees, which the tests assert as invariants over random mixed-width
 * input rather than over hand-picked examples:
 *   1. the window never paints more than `availableColumns`, counting the
 *      cursor cell — including when the caret sits past the last grapheme,
 *      where the UI still renders a one-column space;
 *   2. the caret is always inside the window, so it cannot scroll off screen.
 */
export function windowForCursor(
  units: readonly string[],
  cursor: number,
  availableColumns: number,
): CursorWindow {
  const n = units.length;
  const caret = Math.max(0, Math.min(cursor, n));
  if (availableColumns <= 0) return { start: caret, end: caret };

  // The caret cell is reserved first: it must be visible even if nothing else is.
  const caretWidth = caret < n ? graphemeWidth(units[caret]) : 1;
  if (caretWidth > availableColumns) {
    // A two-column character cannot be painted in a one-column row. Showing it
    // anyway is what overflows the row; the UI falls back to a one-column space
    // for an empty window, which is the only thing that actually fits.
    return { start: caret, end: caret };
  }

  let used = caretWidth;
  let start = caret;
  let end = Math.min(caret + 1, n);

  // Prefer showing what was just typed: fill leftwards to ~75% of the row, the
  // same bias the grapheme-counting version had, now in columns.
  const leftBias = Math.floor(availableColumns * 0.75);
  while (start > 0) {
    const w = graphemeWidth(units[start - 1]);
    if (used + w > Math.min(availableColumns, leftBias + caretWidth)) break;
    used += w;
    start--;
  }
  // Then use whatever is left on the tail...
  while (end < n) {
    const w = graphemeWidth(units[end]);
    if (used + w > availableColumns) break;
    used += w;
    end++;
  }
  // ...and if the tail was short, spend the remainder back on the head.
  while (start > 0) {
    const w = graphemeWidth(units[start - 1]);
    if (used + w > availableColumns) break;
    used += w;
    start--;
  }
  return { start, end };
}
