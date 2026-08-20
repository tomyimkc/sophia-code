import type { ChatMessage } from "./types.js";
import {
  graphemes,
  graphemeWidth,
  truncateToWidth,
} from "./textWidth.js";

/** Strip ANSI/OSC terminal controls and C0 controls before Ink renders text. */
export function sanitizeTerminalText(input: string, allowNewline = true): string {
  // 7-bit ESC and 8-bit C1 CSI/OSC sequences, then leftover controls
  // (optionally keep \n). C1 OSC/CSI are accepted by some terminal emulators,
  // including OSC 52 clipboard writes, so stripping C0 alone is insufficient.
  const withoutEscapes = input.replace(
    // eslint-disable-next-line no-control-regex
    /(?:\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]|\x9d[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?)/g,
    "",
  );
  // eslint-disable-next-line no-control-regex
  return withoutEscapes.replace(
    allowNewline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g,
    "",
  );
}

// One segmenter for the process. Constructing one per line dominated layout
// cost: measured over 4000 lines, per-call construction took 38.34ms vs 17.70ms
// shared — and the ASCII fast path below takes the same work to 0.22ms (174.8x),
// with output verified identical across ASCII, accented, CJK and ZWJ-emoji.
const SEGMENTER: Intl.Segmenter | null = (() => {
  const Ctor = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity: "grapheme" }) : null;
})();

// Printable ASCII is exactly one grapheme per code unit, so the general path
// cannot disagree with `.length` here — and agent transcripts are overwhelmingly
// ASCII, so this branch is taken for nearly every line.
const ASCII_ONLY = /^[\x20-\x7e]*$/;

export function estimateMessageLines(msg: ChatMessage, widthValue: number, expanded: boolean): number {
  const w = Math.max(12, widthValue);
  if (msg.role === "assistant") return expanded ? 1 + estimateTextLines(msg.text || "", w) : 2;
  if (msg.role === "tool" || msg.role === "thinking") {
    return 1 + (msg.text ? estimateTextLines(msg.text, Math.max(12, w - 4)) : 0);
  }
  if (msg.role === "user") {
    return estimateTextLines((msg.text || "") + (msg.meta ? "  " + msg.meta : ""), w - 2);
  }
  return estimateTextLines(msg.text || "", w);
}

export function estimateTextLines(text: string, widthValue: number): number {
  return wrapTextLines(text, widthValue).length;
}

/**
 * Convert transcript text into the exact terminal rows MessageList renders.
 *
 * Ink/Yoga negative margins can visually overlap stale rows under incremental
 * rendering, so partial-message scrolling must slice a deterministic row
 * buffer rather than shift a whole React subtree above a clipping box.
 */
export function wrapTextLines(text: string, widthValue: number): string[] {
  const w = Math.max(1, widthValue);
  if (!text) return [""];
  const rows: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = sanitizeTerminalText(rawLine, false);
    if (!line) {
      rows.push("");
      continue;
    }
    if (ASCII_ONLY.test(line)) {
      for (let start = 0; start < line.length; start += w) {
        rows.push(line.slice(start, start + w));
      }
      continue;
    }
    const units = SEGMENTER
      ? Array.from(SEGMENTER.segment(line), (part) => part.segment)
      : graphemes(line);
    let row = "";
    let used = 0;
    for (const unit of units) {
      const unitWidth = graphemeWidth(unit);
      if (row && used + unitWidth > w) {
        rows.push(row);
        row = "";
        used = 0;
      }
      row += unit;
      used += unitWidth;
    }
    rows.push(row);
  }
  return rows.length ? rows : [""];
}

export function lineCount(text: string): number {
  return text ? text.split("\n").length : 0;
}

/**
 * The one visible line of a collapsed reply.
 *
 * `maxColumns` is a COLUMN budget — MessageList passes `width - 4`. Slicing by
 * characters got that wrong twice: a CJK preview painted two columns per
 * character and overflowed the row (10-column budget -> 20 columns), and
 * String.slice cuts UTF-16 code units, so an emoji preview ended in a lone
 * surrogate ("\ud83d") that renders as a broken glyph. truncateToWidth measures
 * real columns and never splits a grapheme.
 */
export function previewLine(text: string, maxColumns: number): string {
  const line =
    sanitizeTerminalText(text)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "(empty)";
  return truncateToWidth(line, maxColumns);
}

// Height cache keyed on message IDENTITY. App.tsx appends with
// `setMessages(prev => [...prev, msg])`, so every pre-existing message keeps its
// object identity across a turn and only the new one has to be measured. A
// WeakMap also means evicted messages cannot leak.
//
// The inner key covers the two inputs that change a message's height without
// changing the message: terminal width and whether it is expanded.
const HEIGHT_CACHE = new WeakMap<ChatMessage, Map<string, number>>();

function cachedMessageLines(msg: ChatMessage, widthValue: number, expanded: boolean): number {
  let per = HEIGHT_CACHE.get(msg);
  if (!per) {
    per = new Map();
    HEIGHT_CACHE.set(msg, per);
  }
  const key = `${widthValue}:${expanded ? 1 : 0}`;
  const hit = per.get(key);
  if (hit !== undefined) return hit;
  const height = estimateMessageLines(msg, widthValue, expanded);
  per.set(key, height);
  return height;
}

export function visibleMessageWindow(
  messages: ChatMessage[],
  widthValue: number,
  viewportLines: number,
  scrollOffset: number,
  isExpanded: (id: string, msg: ChatMessage) => boolean,
): {
  start: number;
  end: number;
  totalLines: number;
  maxScroll: number;
  /** Visual rows to hide from the first intersecting message. */
  topClip: number;
  /** Visual rows to hide from the last intersecting message. */
  bottomClip: number;
} {
  const heights = messages.map((m) => cachedMessageLines(m, widthValue, isExpanded(m.id, m)));
  const totalLines = heights.reduce((a, b) => a + b, 0);
  const maxScroll = Math.max(0, totalLines - viewportLines);
  const offset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const viewEnd = totalLines - offset;
  const viewStart = Math.max(0, viewEnd - viewportLines);
  let acc = 0;
  let start = 0;
  let end = messages.length;
  for (let i = 0; i < messages.length; i++) {
    const next = acc + heights[i];
    if (next <= viewStart) {
      start = i + 1;
      acc = next;
    } else {
      break;
    }
  }
  const startLine = acc;
  acc = 0;
  let endLine = totalLines;
  for (let i = 0; i < messages.length; i++) {
    acc += heights[i];
    if (acc >= viewEnd) {
      end = i + 1;
      endLine = acc;
      break;
    }
  }
  // Whole-message slicing is not enough for a line-based scroll model. A
  // single 71-line answer in a 17-row pane intersects every offset but keeps
  // the same start/end indexes. `topClip` is the missing intra-message offset:
  // MessageList drops exactly this many rows from the first intersecting item
  // before rendering. Every scroll offset now exposes a distinct contiguous
  // visual-line window without negative-margin overlap.
  const topClip = Math.max(0, viewStart - startLine);
  const bottomClip = Math.max(0, endLine - viewEnd);
  return { start, end, totalLines, maxScroll, topClip, bottomClip };
}

/**
 * Geometry of a scroll bar's "thumb" (the bright segment that shows where the
 * viewport sits inside the whole transcript). Pure so it is unit-tested without
 * rendering Ink.
 *
 * The chat's scroll model anchors offset 0 at the BOTTOM (newest message) and
 * `maxScroll` at the TOP (oldest) — see visibleMessageWindow. A scroll bar reads
 * the other way (top of bar = oldest), so the thumb's row is inverted: offset 0
 * parks the thumb at the bottom of the track, offset `maxScroll` at the top.
 *
 * The thumb's HEIGHT is the viewport's fraction of the total content
 * (viewportLines / totalLines × track), floored at 1 row so a tiny viewport on a
 * huge transcript is still grabbable. When nothing scrolls (maxScroll 0 — the
 * whole transcript already fits) the thumb fills the track: "you're seeing
 * everything", which is what a full-height bar means in every GUI.
 */
export function scrollThumb(
  trackHeight: number,
  scrollOffset: number,
  maxScroll: number,
  viewportLines: number,
  totalLines: number,
): { top: number; height: number } {
  if (trackHeight <= 0) return { top: 0, height: 0 };
  // No content yet → a bare track (no thumb); a full bright bar over an empty
  // chat would falsely scream "there's a screenful of history here".
  if (totalLines <= 0) return { top: 0, height: 0 };
  // Content fits the viewport entirely → full-height thumb ("seeing it all").
  if (maxScroll <= 0) return { top: 0, height: trackHeight };
  const height = Math.max(1, Math.min(trackHeight, Math.round((trackHeight * viewportLines) / totalLines)));
  const frac = Math.max(0, Math.min(1, scrollOffset / maxScroll)); // 0 = bottom, 1 = top
  const top = Math.round((1 - frac) * (trackHeight - height));
  return { top: Math.max(0, Math.min(trackHeight - height, top)), height };
}
