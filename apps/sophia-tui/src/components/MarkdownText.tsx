/**
 * Renders a parsed markdown document (lib/markdown.ts's `Block[]`) as Ink rows.
 *
 * The transcript's scroll window, hit-region math and scrollbar thumb all key
 * off an exact row COUNT per message (see MessageList.tsx). Plain-text
 * rendering could get that count from a single `wrapTextLines` call because
 * one wrapped row was always one rendered row. Markdown breaks that: a
 * heading is bold+colored, a list item gets a hanging indent, a table needs
 * column layout, and a diff fence hands off to DiffView's OWN row count
 * (`diffPreviewLineCount`) entirely. If the estimator and the renderer ever
 * disagreed about how many rows a block takes, the scrollbar would drift and
 * clicks would land on the wrong message — the exact class of bug
 * chatLayout.ts's `estimateMessageLines` was written to fix for plain text.
 *
 * The fix here is the same shape as ToolCard.tsx's `buildToolCardViewModel`:
 * one pure function (`buildMarkdownLayout`) builds a row-level model from
 * `parseMarkdown`'s blocks, and BOTH `estimateMarkdownLines` (layout/sizing)
 * and `renderMarkdownRows` (actual paint) are thin wrappers over it. They
 * cannot drift because there is only one place row count is decided.
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";

import type { Theme } from "../lib/theme.js";
import {
  parseMarkdown,
  type Block,
  type CodeToken,
  type CodeTokenKind,
  type Inline,
  type ListItem,
} from "../lib/markdown.js";
import { displayWidth, graphemes, graphemeWidth, truncateToWidth } from "../lib/textWidth.js";
import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  MATRIX_REVEAL_COLOR,
  matrixRevealCells,
  matrixRevealFramesBySegment,
  type MatrixRevealCell,
} from "../lib/anims/index.js";
import { buildDiffPreview, diffPreviewLineCount, DiffView, type DiffPreview } from "./DiffView.js";

// ─── Styled inline runs ─────────────────────────────────────────────────

/**
 * One contiguous span of text sharing the same inline styling. Flattening
 * `Inline`'s recursive tree into this flat shape BEFORE wrapping is what lets
 * word-wrap treat "a bold word inside a sentence" as ordinary words that
 * happen to carry style flags, instead of needing to reflow a tree.
 */
export interface MarkdownRun {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  /** True only for the synthetic ` (href)` note appended after a link's text. */
  href: boolean;
}

interface InlineStyleCtx {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
}

const BASE_INLINE_CTX: InlineStyleCtx = { bold: false, italic: false, strike: false, code: false, link: false };

function pushRun(out: MarkdownRun[], run: MarkdownRun): void {
  if (!run.text) return;
  const last = out[out.length - 1];
  if (
    last &&
    last.bold === run.bold &&
    last.italic === run.italic &&
    last.strike === run.strike &&
    last.code === run.code &&
    last.link === run.link &&
    last.href === run.href
  ) {
    last.text += run.text;
    return;
  }
  out.push(run);
}

/**
 * Flatten `Inline`'s recursive tree (bold wrapping italic wrapping text, a
 * link's own children, ...) into a flat run list. A link's href is appended
 * as its own trailing, dimmed run rather than folded into the link text —
 * per the component's contract, a reader always sees the destination as
 * plain text, never as a clickable OSC-8 escape this module refuses to emit.
 */
export function flattenInlines(inlines: readonly Inline[], ctx: InlineStyleCtx = BASE_INLINE_CTX): MarkdownRun[] {
  const out: MarkdownRun[] = [];
  for (const node of inlines) {
    if (node.type === "text") {
      pushRun(out, { text: node.text, ...ctx, href: false });
    } else if (node.type === "code") {
      pushRun(out, { text: node.text, ...ctx, code: true, href: false });
    } else if (node.type === "bold") {
      out.push(...flattenInlines(node.children, { ...ctx, bold: true }));
    } else if (node.type === "italic") {
      out.push(...flattenInlines(node.children, { ...ctx, italic: true }));
    } else if (node.type === "strike") {
      out.push(...flattenInlines(node.children, { ...ctx, strike: true }));
    } else if (node.type === "link") {
      out.push(...flattenInlines(node.children, { ...ctx, link: true }));
      if (node.href) {
        pushRun(out, { text: ` (${node.href})`, bold: false, italic: false, strike: false, code: false, link: false, href: true });
      }
    }
  }
  return out;
}

function isSpaceToken(text: string): boolean {
  return /^\s+$/.test(text);
}

/** Split a run's text into whitespace-delimited "word" tokens, each keeping the run's style. */
function tokenizeRuns(runs: readonly MarkdownRun[]): MarkdownRun[] {
  const tokens: MarkdownRun[] = [];
  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/)) {
      if (part) tokens.push({ ...run, text: part });
    }
  }
  return tokens;
}

/** Longest grapheme-safe prefix of `text` that fits `width` columns, plus the remainder. */
function splitByWidth(text: string, width: number): [string, string] {
  const units = graphemes(text);
  let used = 0;
  let i = 0;
  while (i < units.length) {
    const w = graphemeWidth(units[i]);
    if (used + w > width) break;
    used += w;
    i += 1;
  }
  // Always take at least one grapheme so a single character wider than the
  // whole budget (e.g. a CJK glyph in a 1-column list gutter) still makes
  // forward progress instead of looping forever.
  const cut = Math.max(1, i);
  return [units.slice(0, cut).join(""), units.slice(cut).join("")];
}

/**
 * Greedy word-wrap over styled runs. Mirrors chatLayout.ts's `wrapTextLines`
 * contract (never returns zero lines; a word wider than `width` is hard-split
 * by column rather than left to overflow) but keeps each word's style intact
 * across the wrap instead of flattening to plain text first.
 */
export function wrapMarkdownRuns(runs: readonly MarkdownRun[], width: number): MarkdownRun[][] {
  const w = Math.max(1, width);
  const tokens = tokenizeRuns(runs);
  const lines: MarkdownRun[][] = [];
  let current: MarkdownRun[] = [];
  let used = 0;

  const flush = () => {
    // A wrap point must not leave a dangling space glued to the row above.
    while (current.length && isSpaceToken(current[current.length - 1].text)) {
      current.pop();
    }
    lines.push(current);
    current = [];
    used = 0;
  };

  for (const token of tokens) {
    if (isSpaceToken(token.text)) {
      if (current.length === 0) continue; // never start a line with a space
      if (used + 1 > w) {
        flush();
        continue;
      }
      current.push({ ...token, text: " " });
      used += 1;
      continue;
    }

    let remaining = token;
    let remainingWidth = displayWidth(remaining.text);
    while (remainingWidth > w) {
      if (used > 0) flush();
      const [head, tail] = splitByWidth(remaining.text, w);
      current.push({ ...remaining, text: head });
      flush();
      remaining = { ...remaining, text: tail };
      remainingWidth = displayWidth(remaining.text);
    }
    if (used > 0 && used + remainingWidth > w) flush();
    if (remaining.text) {
      current.push(remaining);
      used += remainingWidth;
    }
  }
  if (current.length || lines.length === 0) flush();
  return lines;
}

// ─── Block -> row model ─────────────────────────────────────────────────

export type MarkdownRowKind =
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "hr"
  | "note"
  | "table-header"
  | "table-sep"
  | "table-row";

export interface MarkdownRow {
  kind: MarkdownRowKind;
  /** Pre-wrapped styled content. Empty (and ignored) for "code" and "hr". */
  runs: MarkdownRun[];
  /** Literal indent/marker/quote-gutter text rendered ahead of `runs`, dim, never re-wrapped. */
  prefix: string;
  /** Set only when kind === "heading" (1-2 get the accent color, 3-6 stay plain-bold). */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Set only when kind === "code" — `runs` is unused for these rows. */
  codeTokens?: CodeToken[];
}

export type MarkdownUnit =
  | { kind: "rows"; rows: MarkdownRow[] }
  | { kind: "diff"; preview: DiffPreview; diffSource: string };

const UNORDERED_MARKERS = ["•", "◦", "▪"];
/** Quote gutter — ASCII, not a box-drawing glyph, so it reads fine to a screen reader. */
const QUOTE_GUTTER = "> ";

function listItemMarker(item: ListItem): string {
  if (item.checked !== undefined) return item.checked ? "☑ " : "☐ ";
  if (item.ordered) return `${item.ordinal ?? 1}. `;
  return `${UNORDERED_MARKERS[item.depth % UNORDERED_MARKERS.length]} `;
}

function inlinesToPlainText(inlines: readonly Inline[]): string {
  let out = "";
  for (const node of inlines) {
    if (node.type === "text" || node.type === "code") out += node.text;
    else out += inlinesToPlainText(node.children);
  }
  return out;
}

function plainRun(text: string, bold: boolean): MarkdownRun {
  return { text, bold, italic: false, strike: false, code: false, link: false, href: false };
}

function padCell(text: string, width: number, align: "left" | "right" | "center" | null): string {
  const cut = truncateToWidth(text, width, "");
  const pad = Math.max(0, width - displayWidth(cut));
  if (align === "right") return " ".repeat(pad) + cut;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + cut + " ".repeat(pad - left);
  }
  return cut + " ".repeat(pad);
}

/**
 * A table gets a simple, ALWAYS-fits-width layout (columns split the
 * available width evenly) rather than a shrink-to-content one. A model reply
 * table is rarely more than a handful of short columns, and a fixed-formula
 * layout is one line of arithmetic that can never overflow `width` — a
 * shrink-to-content pass would need a second full scan of every cell just to
 * measure, for a case this rare.
 */
function buildTableRows(block: Extract<Block, { type: "table" }>, width: number): MarkdownRow[] {
  const cols = Math.max(1, block.header.length);
  const headerPlain = block.header.map(inlinesToPlainText);
  const bodyPlain = block.rows.map((row) =>
    Array.from({ length: cols }, (_, i) => inlinesToPlainText(row[i] ?? [])),
  );
  const sep = " │ ";
  const sepWidth = displayWidth(sep);
  const totalSep = sepWidth * Math.max(0, cols - 1);
  const colWidth = Math.max(3, Math.floor((width - totalSep) / cols));
  const buildLine = (cells: readonly string[], aligned: boolean) =>
    truncateToWidth(
      cells.map((cell, i) => padCell(cell, colWidth, aligned ? block.align[i] ?? null : null)).join(sep),
      width,
      "",
    );

  const rows: MarkdownRow[] = [
    { kind: "table-header", runs: [plainRun(buildLine(headerPlain, false), true)], prefix: "" },
    {
      kind: "table-sep",
      runs: [plainRun("─".repeat(Math.max(1, Math.min(width, colWidth * cols + totalSep))), false)],
      prefix: "",
    },
  ];
  for (const cells of bodyPlain) {
    rows.push({ kind: "table-row", runs: [plainRun(buildLine(cells, true), false)], prefix: "" });
  }
  return rows;
}

/**
 * Non-diff blocks only — the top-level `buildMarkdownLayout` intercepts a
 * diff fence BEFORE it ever reaches here so it can route to DiffView. A diff
 * fence nested inside a blockquote falls through to the generic "code" case
 * below instead (plain syntax-less text, no DiffView) — a deliberate, narrow
 * scope limit: DiffView owns its own topClip/bottomClip bookkeeping, and
 * threading that through an arbitrarily-nested quote gutter is not worth it
 * for what is, in practice, a vanishingly rare shape of message.
 */
function blockToRows(block: Block, width: number): MarkdownRow[] {
  switch (block.type) {
    case "heading": {
      const runs = flattenInlines(block.inlines);
      return wrapMarkdownRuns(runs, width).map((lineRuns) => ({
        kind: "heading",
        runs: lineRuns,
        prefix: "",
        level: block.level,
      }));
    }
    case "paragraph": {
      const runs = flattenInlines(block.inlines);
      return wrapMarkdownRuns(runs, width).map((lineRuns) => ({ kind: "paragraph", runs: lineRuns, prefix: "" }));
    }
    case "list": {
      const rows: MarkdownRow[] = [];
      for (const item of block.items) {
        const indent = " ".repeat(item.depth * 2);
        const marker = listItemMarker(item);
        const firstPrefix = indent + marker;
        const contPrefix = " ".repeat(displayWidth(firstPrefix));
        const contentWidth = Math.max(4, width - displayWidth(firstPrefix));
        const wrapped = wrapMarkdownRuns(flattenInlines(item.inlines), contentWidth);
        wrapped.forEach((lineRuns, index) => {
          rows.push({ kind: "list", runs: lineRuns, prefix: index === 0 ? firstPrefix : contPrefix });
        });
      }
      return rows;
    }
    case "blockquote": {
      const innerWidth = Math.max(4, width - displayWidth(QUOTE_GUTTER));
      const innerRows = blocksToRows(block.blocks, innerWidth);
      return innerRows.map((row) => ({ ...row, prefix: QUOTE_GUTTER + row.prefix }));
    }
    case "code": {
      const rows: MarkdownRow[] = block.lines.map((tokens) => ({
        kind: "code",
        runs: [],
        prefix: "",
        codeTokens: tokens,
      }));
      if (block.unterminated) {
        rows.push({ kind: "note", runs: [plainRun("(code fence not closed)", false)], prefix: "" });
      }
      return rows;
    }
    case "hr":
      return [{ kind: "hr", runs: [], prefix: "" }];
    case "table":
      return buildTableRows(block, width);
    default:
      return [];
  }
}

function blocksToRows(blocks: readonly Block[], width: number): MarkdownRow[] {
  const rows: MarkdownRow[] = [];
  for (const block of blocks) rows.push(...blockToRows(block, width));
  return rows;
}

/**
 * Parse `text` and lay it out into render units at `width` columns. This is
 * the SINGLE source of truth both `estimateMarkdownLines` (sizing) and
 * `renderMarkdownRows` (painting) build on — see the file header for why that
 * matters.
 */
export function buildMarkdownLayout(text: string, width: number): MarkdownUnit[] {
  const w = Math.max(10, width);
  const blocks = parseMarkdown(text);
  const units: MarkdownUnit[] = [];
  for (const block of blocks) {
    if (block.type === "code" && block.isDiff) {
      const preview = buildDiffPreview(block.code, { maxColumns: Math.max(16, w - 2) });
      units.push({ kind: "diff", preview, diffSource: block.code });
      continue;
    }
    units.push({ kind: "rows", rows: blockToRows(block, w) });
  }
  return units;
}

function unitsHeight(units: readonly MarkdownUnit[]): number {
  let total = 0;
  for (const unit of units) total += unit.kind === "diff" ? diffPreviewLineCount(unit.preview) : unit.rows.length;
  return total;
}

/**
 * Exact terminal row count `renderMarkdownRows` will produce for `text` at
 * `width` columns. MessageList.tsx's scroll window, hit regions and scrollbar
 * all size against this instead of a plain-text line count once a message
 * renders through `MarkdownText` — see the file header.
 */
export function estimateMarkdownLines(text: string, width: number): number {
  return unitsHeight(buildMarkdownLayout(text, width));
}

// ─── Rendering ──────────────────────────────────────────────────────────

function codeTokenColor(kind: CodeTokenKind, theme: Theme): string {
  switch (kind) {
    case "keyword":
      return theme.accent;
    case "string":
      return theme.success;
    case "comment":
      return theme.dim;
    case "number":
      return theme.warn;
    default:
      return theme.text;
  }
}

function headingColor(level: 1 | 2 | 3 | 4 | 5 | 6 | undefined, theme: Theme): string {
  return (level ?? 3) <= 2 ? theme.accent : theme.text;
}

function baseRowColor(row: MarkdownRow, theme: Theme): string {
  switch (row.kind) {
    case "heading":
      return headingColor(row.level, theme);
    case "table-header":
      return theme.accent;
    case "table-sep":
      return theme.dim;
    case "note":
      return theme.warn;
    default:
      return theme.text;
  }
}

function coalesceRevealCells(cells: readonly MatrixRevealCell[]): Array<{
  text: string;
  live: boolean;
}> {
  const runs: Array<{ text: string; live: boolean }> = [];
  for (const cell of cells) {
    const last = runs[runs.length - 1];
    if (last && last.live === cell.live) {
      last.text += cell.display;
    } else {
      runs.push({ text: cell.display, live: cell.live });
    }
  }
  return runs;
}

function renderRun(
  run: MarkdownRun,
  key: number,
  baseColor: string,
  theme: Theme,
  forceBold: boolean,
  reveal?: { cells: readonly MatrixRevealCell[]; cursor: { value: number } },
): React.ReactElement {
  const color = run.href ? theme.dim : run.link ? theme.accent : run.code ? theme.accent : baseColor;
  const unitCount = graphemes(run.text).length;
  const cells = reveal
    ? reveal.cells.slice(reveal.cursor.value, reveal.cursor.value + unitCount)
    : [];
  if (reveal) reveal.cursor.value += unitCount;
  return (
    <Text
      key={key}
      color={color}
      bold={forceBold || run.bold}
      italic={run.italic}
      strikethrough={run.strike}
      dimColor={run.href}
    >
      {reveal
        ? coalesceRevealCells(cells).map((segment, index) => (
            <Text
              key={`${index}-${segment.live ? "live" : "stable"}`}
              color={segment.live ? MATRIX_REVEAL_COLOR : color}
              bold={segment.live || forceBold || run.bold}
            >
              {segment.text}
            </Text>
          ))
        : run.text}
    </Text>
  );
}

function markdownRowContent(row: MarkdownRow | null | undefined): string {
  if (!row) return "";
  if (row.kind === "code") {
    return (row.codeTokens ?? []).map((token) => token.text).join("");
  }
  return row.runs.map((run) => run.text).join("");
}

function renderRow(
  row: MarkdownRow,
  key: number,
  width: number,
  theme: Theme,
  screenReader: boolean,
  selected: boolean,
  matrix?: {
    previousRow: MarkdownRow | null;
    frame: number;
    churnFrame: number;
    seed: number;
  },
): React.ReactElement {
  if (row.kind === "hr") {
    const text = screenReader ? "---" : "─".repeat(Math.max(1, width));
    return (
      <Text key={key} color={theme.dim} wrap="truncate-end" inverse={selected}>
        {text}
      </Text>
    );
  }
  if (row.kind === "table-sep" && screenReader) {
    // A full-width dash divider is announced character-by-character by a
    // screen reader (accessibility.ts's own documented concern) — say what it
    // is instead of drawing it.
    return (
      <Text key={key} color={theme.dim} inverse={selected}>
        (table separator)
      </Text>
    );
  }
  if (row.kind === "code") {
    const tokens = row.codeTokens ?? [];
    if (tokens.length === 0) {
      return (
        <Text key={key} color={theme.text} wrap="truncate-end" inverse={selected}>
          {" "}
        </Text>
      );
    }
    const cells = matrix
      ? matrixRevealCells({
          text: markdownRowContent(row),
          previousText: markdownRowContent(matrix.previousRow),
          frame: matrix.frame,
          churnFrame: matrix.churnFrame,
          seed: matrix.seed,
        })
      : [];
    const cursor = { value: 0 };
    return (
      <Text key={key} wrap="truncate-end" inverse={selected}>
        {tokens.map((tok, i) => {
          const count = graphemes(tok.text).length;
          const tokenCells = cells.slice(cursor.value, cursor.value + count);
          cursor.value += count;
          const color = codeTokenColor(tok.kind, theme);
          return (
            <Text key={i} color={color}>
              {matrix
                ? coalesceRevealCells(tokenCells).map((segment, index) => (
                    <Text
                      key={`${index}-${segment.live ? "live" : "stable"}`}
                      color={segment.live ? MATRIX_REVEAL_COLOR : color}
                      bold={segment.live || undefined}
                    >
                      {segment.text}
                    </Text>
                  ))
                : tok.text}
            </Text>
          );
        })}
      </Text>
    );
  }

  const baseColor = baseRowColor(row, theme);
  const bold = row.kind === "heading" || row.kind === "table-header";
  const reveal = matrix
    ? {
        cells: matrixRevealCells({
          text: markdownRowContent(row),
          previousText: markdownRowContent(matrix.previousRow),
          frame: matrix.frame,
          churnFrame: matrix.churnFrame,
          seed: matrix.seed,
        }),
        cursor: { value: 0 },
      }
    : undefined;
  const content =
    row.runs.length === 0 ? (
      <Text color={baseColor}> </Text>
    ) : (
      row.runs.map((run, i) =>
        renderRun(run, i, baseColor, theme, bold, reveal)
      )
    );

  return (
    <Text key={key} wrap="truncate-end" inverse={selected}>
      {row.prefix ? (
        <Text color={theme.dim} bold={false}>
          {row.prefix}
        </Text>
      ) : null}
      {content}
    </Text>
  );
}

export interface RenderMarkdownRowsOptions {
  screenReader?: boolean;
  topClip?: number;
  bottomClip?: number;
  selected?: boolean;
  matrix?: {
    previousText: string;
    frame: number;
    churnFrame?: number;
    seed?: number;
  };
}

function visualMarkdownRows(units: readonly MarkdownUnit[]): Array<MarkdownRow | null> {
  const rows: Array<MarkdownRow | null> = [];
  for (const unit of units) {
    if (unit.kind === "diff") {
      rows.push(...Array.from(
        { length: diffPreviewLineCount(unit.preview) },
        () => null,
      ));
    } else {
      rows.push(...unit.rows);
    }
  }
  return rows;
}

/**
 * Paint `text` as an array of Ink row elements, clipped to
 * `[topClip, totalRows - bottomClip)` — the same row-range clipping contract
 * ToolCard/DiffView already use, so a markdown message straddling the top or
 * bottom of the viewport renders an exact partial slice instead of an
 * oversized flex child Yoga has to squash.
 */
export function renderMarkdownRows(
  text: string,
  width: number,
  theme: Theme,
  options: RenderMarkdownRowsOptions = {},
): React.ReactElement[] {
  const w = Math.max(10, width);
  const units = buildMarkdownLayout(text, w);
  const previousUnits = options.matrix
    ? buildMarkdownLayout(options.matrix.previousText, w)
    : [];
  return renderMarkdownLayoutRows(units, previousUnits, w, theme, options);
}

/**
 * Render pre-built layouts so an active Matrix reveal can advance without
 * reparsing and rewrapping the same completed response on every visual frame.
 */
function renderMarkdownLayoutRows(
  units: readonly MarkdownUnit[],
  previousUnits: readonly MarkdownUnit[],
  width: number,
  theme: Theme,
  options: RenderMarkdownRowsOptions = {},
): React.ReactElement[] {
  const w = Math.max(10, width);
  const screenReader = options.screenReader ?? false;
  const selected = options.selected ?? false;
  const previousRows = options.matrix
    ? visualMarkdownRows(previousUnits)
    : [];
  const currentRows = options.matrix ? visualMarkdownRows(units) : [];
  const rowMatrixFrames = options.matrix
    ? matrixRevealFramesBySegment(
        currentRows.map((row) => markdownRowContent(row)),
        previousRows.map((row) => markdownRowContent(row)),
        options.matrix.frame,
      )
    : [];
  const totalHeight = unitsHeight(units);
  const visibleStart = Math.max(0, options.topClip ?? 0);
  const visibleEnd = Math.max(visibleStart, totalHeight - Math.max(0, options.bottomClip ?? 0));

  const elements: React.ReactElement[] = [];
  let rowCursor = 0;
  for (const unit of units) {
    if (unit.kind === "diff") {
      const unitRows = diffPreviewLineCount(unit.preview);
      const unitStart = rowCursor;
      const unitEnd = unitStart + unitRows;
      rowCursor = unitEnd;
      if (unitEnd <= visibleStart || unitStart >= visibleEnd) continue;
      const diffWidth = Math.max(16, w - 2);
      elements.push(
        <Box key={`d${elements.length}`} marginLeft={2} width={diffWidth}>
          <DiffView
            preview={unit.preview}
            diff={unit.diffSource}
            theme={theme}
            width={diffWidth}
            topClip={Math.max(0, visibleStart - unitStart)}
            bottomClip={Math.max(0, unitEnd - visibleEnd)}
            selected={selected}
          />
        </Box>,
      );
      continue;
    }
    for (const row of unit.rows) {
      const rowStart = rowCursor;
      rowCursor += 1;
      const previousRow = previousRows[rowStart] ?? null;
      if (rowCursor <= visibleStart || rowStart >= visibleEnd) continue;
      const rowFrame = rowMatrixFrames[rowStart] ?? 0;
      if (options.matrix && rowFrame < 0) {
        // Do not mount a future wrapped row just to reserve its spaces. A row
        // that was already committed before an append remains literal until
        // the message-wide frontier reaches its changed replacement.
        if (!previousRow) continue;
        elements.push(
          renderRow(
            previousRow,
            elements.length,
            w,
            theme,
            screenReader,
            selected,
          ),
        );
        continue;
      }
      elements.push(
        renderRow(
          row,
          elements.length,
          w,
          theme,
          screenReader,
          selected,
          options.matrix
            ? {
                previousRow,
                frame: rowFrame,
                churnFrame: options.matrix.churnFrame ?? options.matrix.frame,
                seed: (options.matrix.seed ?? 0) + rowStart * 97,
              }
            : undefined,
        ),
      );
    }
  }
  return elements;
}

export interface MarkdownTextProps {
  text: string;
  width: number;
  theme: Theme;
  /** Rows to hide from the top, for a message straddling the viewport's top edge. */
  topClip?: number;
  /** Rows to hide from the bottom, for a message straddling the viewport's bottom edge. */
  bottomClip?: number;
  selected?: boolean;
  /** Previous observed body; only its changed suffix receives matrix decode. */
  matrixPreviousText?: string;
  matrixFrame?: number;
  matrixChurnFrame?: number;
  matrixSeed?: number;
}

function MarkdownTextImpl({
  text,
  width,
  theme,
  topClip = 0,
  bottomClip = 0,
  selected = false,
  matrixPreviousText,
  matrixFrame,
  matrixChurnFrame,
  matrixSeed = 0,
}: MarkdownTextProps): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const layoutWidth = Math.max(10, width);
  const units = useMemo(
    () => buildMarkdownLayout(text, layoutWidth),
    [text, layoutWidth],
  );
  const previousUnits = useMemo(
    () => matrixPreviousText === undefined
      ? []
      : buildMarkdownLayout(matrixPreviousText, layoutWidth),
    [matrixPreviousText, layoutWidth],
  );
  // The completed response layouts above are stable while only matrixFrame
  // changes. Frames now rebuild lightweight Ink nodes and glyph runs, not the
  // markdown parser, wrapping model, table layout or diff preview.
  const rows = useMemo(
    () => renderMarkdownLayoutRows(units, previousUnits, layoutWidth, t, {
      screenReader: ax.screenReader,
      topClip,
      bottomClip,
      selected,
      matrix:
        !ax.reducedMotion
        && matrixPreviousText !== undefined
        && matrixFrame !== undefined
          ? {
              previousText: matrixPreviousText,
              frame: matrixFrame,
              churnFrame: matrixChurnFrame ?? matrixFrame,
              seed: matrixSeed,
            }
          : undefined,
    }),
    [
      units,
      previousUnits,
      layoutWidth,
      t,
      ax.screenReader,
      ax.reducedMotion,
      topClip,
      bottomClip,
      selected,
      matrixPreviousText,
      matrixFrame,
      matrixChurnFrame,
      matrixSeed,
    ],
  );
  return <Box flexDirection="column" width={Math.max(1, width)}>{rows}</Box>;
}

/**
 * Memoized so a completed message or Matrix-frame update does not repaint
 * every other transcript row. A message whose props are unchanged skips
 * straight back to its cached render output.
 */
export const MarkdownText = React.memo(MarkdownTextImpl);
