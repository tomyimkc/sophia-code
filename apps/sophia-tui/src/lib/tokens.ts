/**
 * Compact token counts for a status line that may only have a few columns.
 *
 * Deliberately lossy and deliberately NOT locale-formatted: "412k" survives a
 * narrow pane where "412,336 tokens" would be truncated mid-number, and a
 * truncated number is worse than a rounded one — it reads as a different value
 * rather than as an approximation.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "?";
  const n = Math.round(count);
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    // One decimal below 10k (9.4k), none above (412k) — keeps the field to at
    // most 5 characters so the status line never reflows because of a number.
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/**
 * How full the model's context is, as a percentage, or null when the window is
 * unknown.
 *
 * Returns null rather than 0 or 100 for an unknown window: a fabricated
 * percentage over a window we never learned is exactly the "confident number
 * with nothing behind it" this project treats as a defect. The caller renders
 * nothing at all in that case.
 */
export function contextFillPercent(used: number, window: number | null | undefined): number | null {
  if (!window || !Number.isFinite(window) || window <= 0) return null;
  if (!Number.isFinite(used) || used < 0) return null;
  return Math.min(100, Math.round((used / window) * 100));
}

/**
 * A one-line summary of how full the model's context is, or "" when unknown.
 *
 * Empty rather than a fabricated 0%: an estimate that failed on a huge history
 * would render as "plenty of room", which is the opposite of the truth. The
 * caller shows nothing at all in that case.
 *
 * The compaction budget is included when known, because "62% of 500k" does not
 * tell you how close you are to the point where turns start getting folded —
 * that threshold is 80% of the window, not 100%.
 */
export function describeContextUsage(
  used: number | undefined,
  window: number | undefined,
  budget?: number | undefined,
): string {
  if (!Number.isFinite(used as number) || (used as number) < 0) return "";
  const u = used as number;
  const fill = contextFillPercent(u, window);
  if (fill === null) return `context ${formatTokens(u)}`;
  const near = budget && Number.isFinite(budget) && u >= budget * 0.9 ? " · compaction near" : "";
  return `context ${fill}% of ${formatTokens(window as number)}${near}`;
}
