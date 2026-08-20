import {
  displayWidth,
  graphemes,
  windowForCursor,
} from "./textWidth.js";

export interface ComposerState {
  /** UTF-8/JavaScript text. Line endings are normalized to `\n`. */
  text: string;
  /** Caret offset in grapheme clusters, never UTF-16 code units. */
  cursor: number;
  /**
   * Sticky terminal-column target used by vertical movement. `null` means the
   * next vertical move should derive it from the current caret.
   */
  preferredColumn: number | null;
}

export type ComposerAction =
  | { type: "replace"; text: string; cursor?: number }
  | { type: "insert"; text: string }
  | { type: "newline" }
  | { type: "delete-backward" }
  | { type: "delete-forward" }
  | { type: "delete-word-backward" }
  | { type: "kill-line-start" }
  | { type: "kill-line-end" }
  | { type: "move-left" }
  | { type: "move-right" }
  | { type: "move-up" }
  | { type: "move-down" }
  | { type: "move-line-start" }
  | { type: "move-line-end" }
  | { type: "move-document-start" }
  | { type: "move-document-end" };

export interface ComposerCursorLocation {
  /** Zero-based logical line. */
  line: number;
  /** Zero-based grapheme column within the logical line. */
  column: number;
  /** Zero-based terminal display column within the logical line. */
  displayColumn: number;
  /** Grapheme offset at the beginning of the current logical line. */
  lineStart: number;
  /** Grapheme offset at the end of the current logical line, excluding `\n`. */
  lineEnd: number;
  /** Number of logical lines in the document (always at least one). */
  lineCount: number;
}

export interface ComposerViewportLine {
  logicalLine: number;
  text: string;
  hasCursor: boolean;
  beforeCursor: string;
  cursorGrapheme: string;
  afterCursor: string;
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

export interface ComposerViewport {
  firstLine: number;
  activeLine: number;
  lineCount: number;
  rows: ComposerViewportLine[];
}

export function normalizeComposerText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function clampedCursor(text: string, cursor: number): number {
  return Math.max(0, Math.min(Math.trunc(cursor), graphemes(text).length));
}

export function createComposerState(text = "", cursor?: number): ComposerState {
  const normalized = normalizeComposerText(text);
  return {
    text: normalized,
    cursor: clampedCursor(normalized, cursor ?? graphemes(normalized).length),
    preferredColumn: null,
  };
}

function lineBounds(units: readonly string[], cursor: number): {
  line: number;
  lineStart: number;
  lineEnd: number;
  lineCount: number;
} {
  const caret = Math.max(0, Math.min(cursor, units.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < caret; i += 1) {
    if (units[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  let lineEnd = units.length;
  for (let i = caret; i < units.length; i += 1) {
    if (units[i] === "\n") {
      lineEnd = i;
      break;
    }
  }
  let lineCount = 1;
  for (const unit of units) if (unit === "\n") lineCount += 1;
  return { line, lineStart, lineEnd, lineCount };
}

export function composerCursorLocation(state: Pick<ComposerState, "text" | "cursor">): ComposerCursorLocation {
  const text = normalizeComposerText(state.text);
  const units = graphemes(text);
  const cursor = Math.max(0, Math.min(state.cursor, units.length));
  const bounds = lineBounds(units, cursor);
  const before = units.slice(bounds.lineStart, cursor).join("");
  return {
    ...bounds,
    column: cursor - bounds.lineStart,
    displayColumn: displayWidth(before),
  };
}

function cursorForDisplayColumn(
  units: readonly string[],
  lineStart: number,
  lineEnd: number,
  targetColumn: number,
): number {
  let cursor = lineStart;
  let used = 0;
  while (cursor < lineEnd) {
    const nextWidth = displayWidth(units[cursor]);
    if (used + nextWidth > targetColumn) break;
    used += nextWidth;
    cursor += 1;
  }
  return cursor;
}

function moveVertical(state: ComposerState, direction: -1 | 1): ComposerState {
  const units = graphemes(state.text);
  const location = composerCursorLocation(state);
  const targetColumn = state.preferredColumn ?? location.displayColumn;

  if (direction < 0) {
    if (location.lineStart === 0) return { ...state, preferredColumn: targetColumn };
    const previousEnd = location.lineStart - 1;
    let previousStart = 0;
    for (let i = previousEnd - 1; i >= 0; i -= 1) {
      if (units[i] === "\n") {
        previousStart = i + 1;
        break;
      }
    }
    return {
      ...state,
      cursor: cursorForDisplayColumn(units, previousStart, previousEnd, targetColumn),
      preferredColumn: targetColumn,
    };
  }

  if (location.lineEnd >= units.length) return { ...state, preferredColumn: targetColumn };
  const nextStart = location.lineEnd + 1;
  let nextEnd = units.length;
  for (let i = nextStart; i < units.length; i += 1) {
    if (units[i] === "\n") {
      nextEnd = i;
      break;
    }
  }
  return {
    ...state,
    cursor: cursorForDisplayColumn(units, nextStart, nextEnd, targetColumn),
    preferredColumn: targetColumn,
  };
}

function withUnits(
  state: ComposerState,
  update: (units: string[], cursor: number) => { units: string[]; cursor: number },
): ComposerState {
  const units = graphemes(state.text);
  const cursor = Math.max(0, Math.min(state.cursor, units.length));
  const next = update(units, cursor);
  return {
    text: next.units.join(""),
    cursor: Math.max(0, Math.min(next.cursor, next.units.length)),
    preferredColumn: null,
  };
}

export function reduceComposer(state: ComposerState, action: ComposerAction): ComposerState {
  const current = createComposerState(state.text, state.cursor);
  current.preferredColumn = state.preferredColumn;

  switch (action.type) {
    case "replace": {
      const next = createComposerState(action.text, action.cursor);
      return next;
    }
    case "insert":
    case "newline": {
      const inserted = action.type === "newline" ? "\n" : normalizeComposerText(action.text);
      if (!inserted) return current;
      return withUnits(current, (units, cursor) => {
        const added = graphemes(inserted);
        return {
          units: units.slice(0, cursor).concat(added, units.slice(cursor)),
          cursor: cursor + added.length,
        };
      });
    }
    case "delete-backward":
      return withUnits(current, (units, cursor) => ({
        units: cursor === 0 ? units : units.slice(0, cursor - 1).concat(units.slice(cursor)),
        cursor: Math.max(0, cursor - 1),
      }));
    case "delete-forward":
      return withUnits(current, (units, cursor) => ({
        units: cursor >= units.length ? units : units.slice(0, cursor).concat(units.slice(cursor + 1)),
        cursor,
      }));
    case "delete-word-backward":
      return withUnits(current, (units, cursor) => {
        let start = cursor;
        while (start > 0 && /\s/u.test(units[start - 1])) start -= 1;
        while (start > 0 && !/\s/u.test(units[start - 1])) start -= 1;
        return { units: units.slice(0, start).concat(units.slice(cursor)), cursor: start };
      });
    case "kill-line-start":
      return withUnits(current, (units, cursor) => {
        const { lineStart } = lineBounds(units, cursor);
        return { units: units.slice(0, lineStart).concat(units.slice(cursor)), cursor: lineStart };
      });
    case "kill-line-end":
      return withUnits(current, (units, cursor) => {
        const { lineEnd } = lineBounds(units, cursor);
        return { units: units.slice(0, cursor).concat(units.slice(lineEnd)), cursor };
      });
    case "move-left":
      return { ...current, cursor: Math.max(0, current.cursor - 1), preferredColumn: null };
    case "move-right": {
      const length = graphemes(current.text).length;
      return { ...current, cursor: Math.min(length, current.cursor + 1), preferredColumn: null };
    }
    case "move-up":
      return moveVertical(current, -1);
    case "move-down":
      return moveVertical(current, 1);
    case "move-line-start": {
      const { lineStart } = composerCursorLocation(current);
      return { ...current, cursor: lineStart, preferredColumn: null };
    }
    case "move-line-end": {
      const { lineEnd } = composerCursorLocation(current);
      return { ...current, cursor: lineEnd, preferredColumn: null };
    }
    case "move-document-start":
      return { ...current, cursor: 0, preferredColumn: null };
    case "move-document-end":
      return { ...current, cursor: graphemes(current.text).length, preferredColumn: null };
  }
}

/**
 * History navigation should not steal arrows that still have somewhere to go
 * inside a multiline draft. It becomes eligible only at the top/bottom edge.
 */
export function shouldNavigateHistory(
  state: Pick<ComposerState, "text" | "cursor">,
  direction: "previous" | "next",
): boolean {
  const location = composerCursorLocation(state);
  return direction === "previous"
    ? location.line === 0
    : location.line === location.lineCount - 1;
}

function logicalLines(text: string): Array<{ units: string[]; start: number }> {
  const result: Array<{ units: string[]; start: number }> = [];
  const all = graphemes(normalizeComposerText(text));
  let start = 0;
  let line: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    if (all[i] === "\n") {
      result.push({ units: line, start });
      line = [];
      start = i + 1;
    } else {
      line.push(all[i]);
    }
  }
  result.push({ units: line, start });
  return result;
}

/**
 * Build a bounded, grapheme-safe viewport around the active logical line.
 * Each row is horizontally windowed in terminal columns, so CJK and emoji can
 * never overflow a width budget or leave the inverse-video caret off-screen.
 */
export function composerViewport(
  state: Pick<ComposerState, "text" | "cursor">,
  availableColumns: number,
  maxVisibleLines = 1,
): ComposerViewport {
  const text = normalizeComposerText(state.text);
  const allUnits = graphemes(text);
  const cursor = Math.max(0, Math.min(state.cursor, allUnits.length));
  const location = composerCursorLocation({ text, cursor });
  const lines = logicalLines(text);
  const visibleCount = Math.max(1, Math.min(lines.length, Math.trunc(maxVisibleLines) || 1));
  const half = Math.floor(visibleCount / 2);
  const firstLine = Math.max(0, Math.min(location.line - half, lines.length - visibleCount));
  const rows: ComposerViewportLine[] = [];

  for (let logicalLine = firstLine; logicalLine < firstLine + visibleCount; logicalLine += 1) {
    const line = lines[logicalLine];
    const hasCursor = logicalLine === location.line;
    const localCursor = hasCursor ? cursor - line.start : line.units.length;
    const window = windowForCursor(
      line.units,
      localCursor,
      Math.max(1, availableColumns),
    );
    const shown = line.units.slice(window.start, window.end);
    const displayCursor = Math.max(0, Math.min(localCursor - window.start, shown.length));
    rows.push({
      logicalLine,
      text: shown.join(""),
      hasCursor,
      beforeCursor: hasCursor ? shown.slice(0, displayCursor).join("") : shown.join(""),
      cursorGrapheme: hasCursor ? (shown[displayCursor] || " ") : "",
      afterCursor: hasCursor ? shown.slice(displayCursor + 1).join("") : "",
      truncatedStart: window.start > 0,
      truncatedEnd: window.end < line.units.length,
    });
  }

  return {
    firstLine,
    activeLine: location.line,
    lineCount: location.lineCount,
    rows,
  };
}
