import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import type { ChatMessage } from "../lib/types.js";
import {
  estimateMessageLines,
  lineCount,
  previewLine,
  sanitizeTerminalText,
  scrollThumb,
  wrapTextLines,
} from "../lib/chatLayout.js";
import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  projectToolTimeline,
  type ToolBatch,
  type ToolCallState,
  type ToolTimelineItem,
} from "../lib/toolState.js";
import { sanitizeToolText } from "../lib/toolOutput.js";
import { estimateToolCardLines, ToolCard } from "./ToolCard.js";
import { estimateMarkdownLines, MarkdownText } from "./MarkdownText.js";
import {
  MatrixGlyphRuns,
  MatrixText,
  useMatrixReveal,
} from "./MatrixText.js";
import { matrixRevealFramesBySegment } from "../lib/anims/index.js";
import {
  verboseTranscriptEnabled,
  visibleTranscriptMessages,
} from "../lib/transcriptVisibility.js";

/** Columns the scroll bar claims on the right edge: 1 gap + 1 bar glyph. */
const SCROLLBAR_COLS = 2;

/**
 * Transcript rows use the arrival cadence. Replaying them through a
 * 15–25 presentation-token/s frontier invented a slower throughput signal
 * after delivery.
 */
export function messageUsesArrivalCadence(_role: ChatMessage["role"]): boolean {
  return true;
}

function matrixFramesByRow(
  rows: readonly string[],
  previousRows: readonly string[],
  frame: number,
): number[] {
  return matrixRevealFramesBySegment(
    rows.map((line) => line || " "),
    previousRows.map((line) => line || " "),
    frame,
  );
}

export interface MessageHitRegion {
  id: string;
  /** 1-based screen row of the message header (collapse toggle target) */
  screenRow: number;
  /** Inclusive last screen row occupied by the visible timeline item. */
  screenEndRow: number;
  role: ChatMessage["role"];
}

// Assistant (expanded) and system replies now paint through MarkdownText
// instead of a flat `wrapTextLines` split, and wrapped markdown does not
// produce the same row count plain text did (a heading, a list item's
// hanging indent, a table — none of them are "one wrapped line per screen
// row" the way plain prose is). chatLayout.ts's own `estimateMessageLines`
// has no idea markdown rendering exists (it is not owned by this file), so
// it stays the right answer for every role whose rendering here did NOT
// change (user/tool/thinking, and a COLLAPSED assistant reply, which still
// shows a single plain preview line) — only the two markdown-rendered cases
// below diverge from it. Keeping both estimators consistent with what
// MessageRow actually paints is the whole point of this wrapper; see
// MarkdownText.tsx's file header for the shared-source-of-truth reasoning.
const MARKDOWN_HEIGHT_CACHE = new WeakMap<ChatMessage, Map<string, number>>();

function cachedMarkdownMessageLines(msg: ChatMessage, width: number, headerRows: number): number {
  let per = MARKDOWN_HEIGHT_CACHE.get(msg);
  if (!per) {
    per = new Map();
    MARKDOWN_HEIGHT_CACHE.set(msg, per);
  }
  const key = `${width}:${headerRows}`;
  const hit = per.get(key);
  if (hit !== undefined) return hit;
  const height = headerRows + estimateMarkdownLines(msg.text || "", width);
  per.set(key, height);
  return height;
}

function estimateChatMessageLines(msg: ChatMessage, widthValue: number, expanded: boolean): number {
  const w = Math.max(12, widthValue);
  if (msg.role === "assistant") {
    // Collapsed stays the fixed 2-row header+preview shown today — the
    // preview is one already-plain, already-truncated line, so there is
    // nothing markdown-aware to measure there.
    return expanded ? cachedMarkdownMessageLines(msg, w, 1) : 2;
  }
  if (msg.role === "system") return cachedMarkdownMessageLines(msg, w, 0);
  return estimateMessageLines(msg, widthValue, expanded);
}

/**
 * Mouse click-to-expand hit regions for a slice of messages.
 *
 * Row heights MUST come from the same height model the scroll window (this
 * file's `visibleTimelineWindow`/chatLayout's `visibleMessageWindow`) uses.
 * This used to guess `Math.min(12, 1 + lineCount(text))` instead — a plain
 * newline count, blind to word-wrap — so any wrapped multi-line message (a
 * long line with no `\n`, which is the common case) under-counted its own
 * height and every later message's `screenRow` in the slice drifted off,
 * misdirecting clicks.
 */
export function computeHitRegions(
  messages: ChatMessage[],
  width: number,
  paneTopRow: number,
  isExpanded: (id: string, msg: ChatMessage) => boolean,
): MessageHitRegion[] {
  const hits: MessageHitRegion[] = [];
  let rowCursor = paneTopRow;
  for (const m of messages) {
    const height = estimateChatMessageLines(m, width, isExpanded(m.id, m));
    hits.push({
      id: m.id,
      screenRow: rowCursor,
      screenEndRow: rowCursor + height - 1,
      role: m.role,
    });
    rowCursor += height;
  }
  return hits;
}

const TOOL_HEIGHT_CACHE = new WeakMap<ToolCallState, Map<number, number>>();

function cachedToolLines(tool: ToolCallState, width: number): number {
  let widths = TOOL_HEIGHT_CACHE.get(tool);
  if (!widths) {
    widths = new Map();
    TOOL_HEIGHT_CACHE.set(tool, widths);
  }
  const hit = widths.get(width);
  if (hit !== undefined) return hit;
  const height = estimateToolCardLines(tool, width);
  widths.set(width, height);
  return height;
}

export function estimateTimelineItemLines(
  item: ToolTimelineItem,
  width: number,
  isExpanded: (id: string, msg: ChatMessage) => boolean,
): number {
  if (item.kind === "message") {
    return estimateChatMessageLines(
      item.message,
      width,
      isExpanded(item.message.id, item.message),
    );
  }
  const cardWidth = Math.max(20, width - 1);
  return (
    (item.batch.parallel ? 1 : 0) +
    item.batch.tools.reduce((sum, tool) => sum + cachedToolLines(tool, cardWidth), 0)
  );
}

/** Tool-aware hit geometry used by the live transcript. */
export function computeTimelineHitRegions(
  items: readonly ToolTimelineItem[],
  width: number,
  paneTopRow: number,
  isExpanded: (id: string, msg: ChatMessage) => boolean,
): MessageHitRegion[] {
  const hits: MessageHitRegion[] = [];
  let rowCursor = paneTopRow;
  for (const item of items) {
    if (item.kind === "message") {
      const height = estimateTimelineItemLines(item, width, isExpanded);
      hits.push({
        id: item.message.id,
        screenRow: rowCursor,
        screenEndRow: rowCursor + height - 1,
        role: item.message.role,
      });
      rowCursor += height;
      continue;
    }
    if (item.batch.parallel) rowCursor += 1;
    const cardWidth = Math.max(20, width - 1);
    for (const tool of item.batch.tools) {
      const height = cachedToolLines(tool, cardWidth);
      hits.push({
        id: tool.callMessageId || tool.resultMessageId || tool.stableId,
        screenRow: rowCursor,
        screenEndRow: rowCursor + height - 1,
        role: "tool",
      });
      rowCursor += height;
    }
  }
  return hits;
}

/** Restrict transcript hit geometry to the rows actually owned by the pane. */
export function clipHitRegionsToViewport(
  hits: readonly MessageHitRegion[],
  transcriptTopRow: number,
  transcriptBottomRow: number,
): MessageHitRegion[] {
  return hits
    .filter(
      (hit) =>
        hit.screenEndRow >= transcriptTopRow &&
        hit.screenRow <= transcriptBottomRow,
    )
    .map((hit) => ({
      ...hit,
      screenRow: Math.max(hit.screenRow, transcriptTopRow),
      screenEndRow: Math.min(hit.screenEndRow, transcriptBottomRow),
    }));
}

/**
 * The chatLayout window algorithm generalized to correlated tool batches.
 * The same estimator powers rendering hit rows and scrolling, so a rich card
 * cannot move later assistant click targets or clip the newest answer.
 */
export function visibleTimelineWindow(
  items: readonly ToolTimelineItem[],
  width: number,
  viewportLines: number,
  scrollOffset: number,
  isExpanded: (id: string, msg: ChatMessage) => boolean,
): {
  start: number;
  end: number;
  totalLines: number;
  maxScroll: number;
  /** Visual rows to hide from the first intersecting timeline item. */
  topClip: number;
  /** Visual rows to hide from the last intersecting timeline item. */
  bottomClip: number;
} {
  const heights = items.map((item) => estimateTimelineItemLines(item, width, isExpanded));
  const totalLines = heights.reduce((sum, height) => sum + height, 0);
  const maxScroll = Math.max(0, totalLines - viewportLines);
  const offset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const viewEnd = totalLines - offset;
  const viewStart = Math.max(0, viewEnd - viewportLines);
  let accumulated = 0;
  let start = 0;
  let end = items.length;

  for (let index = 0; index < items.length; index += 1) {
    const next = accumulated + heights[index];
    if (next <= viewStart) {
      start = index + 1;
      accumulated = next;
    } else {
      break;
    }
  }

  const startLine = accumulated;
  accumulated = 0;
  let endLine = totalLines;
  for (let index = 0; index < items.length; index += 1) {
    accumulated += heights[index];
    if (accumulated >= viewEnd) {
      end = index + 1;
      endLine = accumulated;
      break;
    }
  }

  return {
    start,
    end,
    totalLines,
    maxScroll,
    topClip: Math.max(0, viewStart - startLine),
    bottomClip: Math.max(0, endLine - viewEnd),
  };
}

/**
 * Status colour for a role whose outcome can be true/false/unknown.
 *
 * `ok === undefined` happens for real (e.g. a resumed disk session never
 * persisted a pass/fail flag) and must render as neutral, not as a false
 * "success". The tool row below already got this three-way check right;
 * the assistant row used to collapse straight to `theme.success` on
 * undefined, painting every resumed reply green regardless of outcome.
 */
export function statusColor(ok: boolean | undefined, theme: Theme, neutral: string): string {
  return ok === false ? theme.error : ok === true ? theme.success : neutral;
}

export function MessageList({
  theme,
  messages,
  width,
  height,
  scrollOffset,
  focusedId,
  /** First screen row (1-based) of the message pane — for mouse hit-testing */
  paneTopRow,
  onLayout,
  mouseMode = false,
  selectedMessageIds = new Set<string>(),
}: {
  theme: Theme;
  messages: ChatMessage[];
  width: number;
  height: number;
  scrollOffset: number;
  focusedId?: string | null;
  paneTopRow: number;
  onLayout?: (hits: MessageHitRegion[], maxScroll: number) => void;
  mouseMode?: boolean;
  selectedMessageIds?: ReadonlySet<string>;
}): React.ReactElement {
  const ax = useAccessibility();
  // Screen-reader mode must emit no colour (see accessibility.ts) —
  // StatusLine and LoadingIndicator already resolve through this; the
  // transcript itself (the bulk of what's on screen) had been left reading
  // straight from the raw themed `theme` prop instead.
  const t = accessibleTheme(theme, ax);
  const verboseTranscript = verboseTranscriptEnabled();
  const displayMessages = useMemo(
    () => visibleTranscriptMessages(messages, verboseTranscript),
    [messages, verboseTranscript],
  );
  // Existing/resumed rows initialize as already seen and remain still. A
  // genuinely appended row gets one matrix reveal on first mount; scrolling
  // an old row out and back in never replays it.
  const seenMessageIdsRef = React.useRef<Set<string>>(
    new Set(displayMessages.map((message) => message.id)),
  );
  const unseenMessageIds = displayMessages
    .filter((message) => !seenMessageIdsRef.current.has(message.id))
    .map((message) => message.id);
  // A bulk hydration is session/history loading, not a live sentence arriving.
  const animateOnMountIds = new Set(
    unseenMessageIds.length <= 2 ? unseenMessageIds : [],
  );
  React.useEffect(() => {
    for (const message of displayMessages) {
      seenMessageIdsRef.current.add(message.id);
    }
  }, [displayMessages]);

  const isExpanded = (id: string, msg: ChatMessage) => {
    if (msg.role !== "assistant") return true;
    return msg.collapsed === false;
  };

  // Reserve the rightmost 2 columns for the scroll bar (1 gap + 1 bar). The
  // transcript and its hit regions MUST measure against this narrower width so
  // word-wrap (and therefore row heights / click targets) agree with what the
  // message column actually renders.
  const contentWidth = Math.max(20, width - SCROLLBAR_COLS);
  const viewportLines = Math.max(1, height - 2);
  const timeline = useMemo(
    () => projectToolTimeline(displayMessages),
    [displayMessages],
  );

  const { start, end, totalLines, maxScroll, topClip, bottomClip } = useMemo(
    () =>
      // The scroll banners render INSIDE this same fixed-height Box, so they eat
      // rows the window thinks it has. Passing the full height meant even a
      // correctly-sized slice lost its bottom row(s) — again the newest message.
      // One banner shows at the bottom ("↓ at bottom"), two when scrolled up
      // ("↑ earlier history" plus the trailing one); reserve the worst case so
      // the reservation never itself flips which banners appear.
      visibleTimelineWindow(timeline, contentWidth, viewportLines, scrollOffset, isExpanded),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, width, height, scrollOffset],
  );

  const slice = timeline.slice(start, end);
  const showTopBanner = maxScroll > 0 && scrollOffset < maxScroll;
  // At the oldest possible position there is no banner above the transcript;
  // only the "newer" hint below it remains. Keep hit geometry aligned with the
  // rows Ink actually renders at that boundary.
  const topBannerRows = showTopBanner ? 1 : 0;
  const transcriptTopRow = paneTopRow + topBannerRows;
  const transcriptBottomRow = transcriptTopRow + viewportLines - 1;

  // Build hit regions + notify parent (for click-to-expand)
  const hits = clipHitRegionsToViewport(
    computeTimelineHitRegions(
      slice,
      contentWidth,
      transcriptTopRow - topClip,
      isExpanded,
    ),
    transcriptTopRow,
    transcriptBottomRow,
  );

  // Defer layout callback to avoid setState during render of parent
  React.useEffect(() => {
    onLayout?.(hits, maxScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, maxScroll, height, scrollOffset, timeline, paneTopRow]);

  const scrollHint =
    maxScroll > 0
      ? `  scroll ${maxScroll - scrollOffset}/${maxScroll} · PgUp/PgDn${mouseMode ? " · wheel" : ""}`
      : "";
  // When scrolled up, the "↑ earlier history" banner shows the N/N position.
  // At the bottom there used to be NO indicator — indistinguishable from "no
  // scrollback". Surface a dim "at bottom" line so the user can tell.
  const atBottom = maxScroll > 0 && scrollOffset === 0;

  return (
    <Box
      position="relative"
      flexDirection="row"
      width={width}
      height={height}
      overflow="hidden"
    >
      <Box flexDirection="column" width={contentWidth} height={height} overflow="hidden">
        {showTopBanner ? (
          <Text color={t.dim} wrap="truncate-end">
            ↑ earlier history{scrollHint}
          </Text>
        ) : null}
        {atBottom ? (
          <Text color={t.dim} wrap="truncate-end">
            ↓ at bottom · {maxScroll} line{maxScroll === 1 ? "" : "s"} of history · PgUp to scroll
          </Text>
        ) : null}

        <Box
          flexDirection="column"
          width={contentWidth}
          height={viewportLines}
          overflow="hidden"
        >
          {slice.length === 0 ? (
            <Text color={t.dim}>No messages yet. Type a goal or /help.</Text>
          ) : (
            <Box flexDirection="column" width={contentWidth}>
              {slice.map((item, itemIndex) => {
                const selected =
                  item.kind === "message"
                    ? selectedMessageIds.has(item.message.id)
                    : item.batch.tools.some((tool) =>
                      tool.sourceMessageIds.some((id) => selectedMessageIds.has(id))
                    );
                return item.kind === "message" ? (
                  <MessageRow
                    key={item.id}
                    theme={t}
                    message={item.message}
                    width={contentWidth}
                    expanded={isExpanded(item.message.id, item.message)}
                    focused={focusedId === item.message.id}
                    selected={selected}
                    animateOnMount={animateOnMountIds.has(item.message.id)}
                    topClip={itemIndex === 0 ? topClip : 0}
                    bottomClip={itemIndex === slice.length - 1 ? bottomClip : 0}
                  />
                ) : (
                  <ToolBatchGroup
                    key={item.id}
                    batch={item.batch}
                    theme={t}
                    width={contentWidth}
                    selected={selected}
                    animateOnMount={item.batch.tools.some((tool) =>
                      tool.sourceMessageIds.some((id) => animateOnMountIds.has(id))
                    )}
                    topClip={itemIndex === 0 ? topClip : 0}
                    bottomClip={itemIndex === slice.length - 1 ? bottomClip : 0}
                  />
                );
              })}
            </Box>
          )}
        </Box>

        {maxScroll > 0 && scrollOffset > 0 ? (
          <Text color={t.dim} wrap="truncate-end">
            {/* Ctrl+N is the binding App.tsx actually wires (see key.ctrl "n"
                handler); this used to say "End", a key nothing handles. */}
            ↓ newer · {scrollOffset} lines below · Ctrl+N to jump latest
          </Text>
        ) : null}
      </Box>

      {/* Scroll bar: where the viewport sits inside the whole transcript. The
          thumb grows/shrinks with the visible fraction and slides as you scroll
          (wheel / PgUp-PgDn / Shift+↑↓ / Ctrl+B-N), so there is always a visual
          anchor for "how far back am I" and "is there more history". */}
      <ScrollBar
        height={height}
        scrollOffset={scrollOffset}
        maxScroll={maxScroll}
        viewportLines={viewportLines}
        totalLines={totalLines}
        theme={t}
      />
    </Box>
  );
}

function ToolBatchGroup({
  batch,
  theme,
  width,
  selected = false,
  animateOnMount = false,
  topClip = 0,
  bottomClip = 0,
}: {
  batch: ToolBatch;
  theme: Theme;
  width: number;
  selected?: boolean;
  animateOnMount?: boolean;
  topClip?: number;
  bottomClip?: number;
}): React.ReactElement {
  const ax = useAccessibility();
  const cardWidth = Math.max(20, width - 1);
  const completed = batch.tools.filter((tool) => tool.status === "succeeded").length;
  const failed = batch.tools.filter((tool) =>
    tool.status === "failed" || tool.status === "denied" || tool.status === "cancelled"
  ).length;
  const active = batch.tools.length - completed - failed;
  const summary = [
    completed ? `${completed} done` : "",
    active ? `${active} active` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean).join(" · ");
  const totalHeight =
    (batch.parallel ? 1 : 0) +
    batch.tools.reduce((sum, tool) => sum + cachedToolLines(tool, cardWidth), 0);
  const visibleStart = Math.max(0, topClip);
  const visibleEnd = Math.max(
    visibleStart,
    totalHeight - Math.max(0, bottomClip),
  );
  let rowCursor = 0;
  const showParallelHeader =
    batch.parallel && rowCursor >= visibleStart && rowCursor < visibleEnd;
  if (batch.parallel) rowCursor += 1;

  return (
    <Box flexDirection="column" marginLeft={1} width={cardWidth}>
      {showParallelHeader ? (
        <Text color={theme.tool} bold wrap="truncate-end" inverse={selected}>
          <MatrixText
            text={
              ax.screenReader
                ? `parallel batch: ${batch.tools.length} tools; ${summary}; id ${sanitizeToolText(batch.id, false, 128)}`
                : `∥ parallel batch · ${batch.tools.length} tools · ${summary} · id ${sanitizeToolText(batch.id, false, 128)}`
            }
            animateOnMount={animateOnMount}
            seed={307}
          />
        </Text>
      ) : null}
      {batch.tools.map((tool) => {
        const toolHeight = cachedToolLines(tool, cardWidth);
        const toolStart = rowCursor;
        const toolEnd = toolStart + toolHeight;
        rowCursor = toolEnd;
        if (toolEnd <= visibleStart || toolStart >= visibleEnd) return null;
        return (
          <ToolCard
            key={tool.stableId}
            tool={tool}
            theme={theme}
            width={cardWidth}
            selected={selected}
            animateOnMount={animateOnMount}
            topClip={Math.max(0, visibleStart - toolStart)}
            bottomClip={Math.max(0, toolEnd - visibleEnd)}
          />
        );
      })}
    </Box>
  );
}

/**
 * Vertical scroll bar for the transcript pane (1 gap column + 1 bar column).
 * The bright thumb shows the viewport's position and size within the whole
 * history; the dim track is the rest. Full-height thumb = everything fits.
 */
function ScrollBar({
  height,
  scrollOffset,
  maxScroll,
  viewportLines,
  totalLines,
  theme,
}: {
  height: number;
  scrollOffset: number;
  maxScroll: number;
  viewportLines: number;
  totalLines: number;
  theme: Theme;
}): React.ReactElement {
  const { top, height: thumbH } = scrollThumb(height, scrollOffset, maxScroll, viewportLines, totalLines);
  return (
    <Box flexDirection="column" width={SCROLLBAR_COLS} height={height} flexShrink={0}>
      {Array.from({ length: height }, (_, r) => {
        const isThumb = r >= top && r < top + thumbH;
        return (
          <Text key={r} color={isThumb ? theme.accent : theme.dim}>
            {isThumb ? " █" : " │"}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * System rows have always painted in a single dim tone regardless of
 * content — they are meta/status lines, not the answer. MarkdownText picks
 * its own colors per block (accent headings, success strings, ...), so
 * rendering a system message through it verbatim would suddenly make a
 * system line as loud as an assistant one. Forcing every themed field to
 * `theme.dim` keeps bold/italic/strikethrough (structure) while flattening
 * color (loudness) back to what a system row has always looked like.
 */
function dimTheme(theme: Theme): Theme {
  return {
    ...theme,
    text: theme.dim,
    accent: theme.dim,
    success: theme.dim,
    warn: theme.dim,
    error: theme.dim,
    tool: theme.dim,
    thinking: theme.dim,
    user: theme.dim,
  };
}

function MessageRowImpl({
  theme,
  message,
  width,
  expanded,
  focused,
  selected,
  animateOnMount,
  topClip = 0,
  bottomClip = 0,
}: {
  theme: Theme;
  message: ChatMessage;
  width: number;
  expanded: boolean;
  focused: boolean;
  selected: boolean;
  animateOnMount: boolean;
  topClip?: number;
  bottomClip?: number;
}): React.ReactElement {
  const { role, text, meta, ok } = message;
  const ax = useAccessibility();
  const reveal = useMatrixReveal(text || "", {
    animateOnMount,
    reducedMotion: ax.reducedMotion || messageUsesArrivalCadence(role),
  });
  const bodyW = Math.max(20, width - 2);
  const focusMark = focused ? "▸" : " ";
  const clip = Math.max(0, topClip);
  const bottom = Math.max(0, bottomClip);
  const clipRows = <T,>(rows: T[]): T[] =>
    rows.slice(clip, Math.max(clip, rows.length - bottom));
  const visibleText = (line: string) => line || " ";
  // Stable across re-renders unless `theme` itself changes, so MarkdownText's
  // own memoization (keyed on this object's identity) isn't defeated by a
  // fresh dimmed-theme object on every render this component happens to do
  // for an unrelated prop change (e.g. a selection-highlight toggle).
  const systemTheme = useMemo(() => dimTheme(theme), [theme]);
  const seed = [...message.id].reduce(
    (value, char) => (value * 33 + (char.codePointAt(0) ?? 0)) >>> 0,
    5381,
  );

  if (role === "user") {
    const rows = wrapTextLines(
      `${text || ""}${meta ? `  ${sanitizeTerminalText(meta, false)}` : ""}`,
      bodyW,
    );
    const previousRows = wrapTextLines(
      `${reveal.previousText}${meta ? `  ${sanitizeTerminalText(meta, false)}` : ""}`,
      bodyW,
    );
    const rowFrames = matrixFramesByRow(rows, previousRows, reveal.frame);
    return (
      <Box flexDirection="column" width={width} marginY={0}>
        {clipRows(rows).map((line, index) => {
          const rowIndex = clip + index;
          const rowFrame = rowFrames[rowIndex] ?? 0;
          const previousRow = previousRows[rowIndex] ?? "";
          // A wrapped row that has not reached the message-wide frontier must
          // not exist yet. If this row was already committed before an append,
          // keep that literal prior row visible until the frontier reaches its
          // changed replacement.
          if (rowFrame < 0 && !previousRow) return null;
          const shownLine = rowFrame < 0 ? previousRow : line;
          return (
            <Box key={rowIndex} width={width}>
              <Text color={theme.user} bold inverse={selected}>
                {rowIndex === 0 ? (focusMark === "▸" ? "▸" : "●") : " "}{" "}
              </Text>
              <Text color={theme.text} wrap="truncate-end" inverse={selected}>
                <MatrixGlyphRuns
                  text={visibleText(shownLine)}
                  previousText={visibleText(previousRow)}
                  frame={rowFrame < 0 ? 0 : rowFrame}
                  churnFrame={reveal.churnFrame}
                  seed={seed + rowIndex}
                />
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  if (role === "tool") {
    const mark = ok === false ? "✗" : ok === true ? "✓" : "⏺";
    const color = statusColor(ok, theme, theme.tool);
    const bodyLines = text
      ? wrapTextLines(text, Math.max(12, width - 4))
      : [];
    const previousBodyLines = wrapTextLines(
      reveal.previousText,
      Math.max(12, width - 4),
    );
    const bodyFrames = matrixFramesByRow(
      bodyLines,
      previousBodyLines,
      reveal.frame,
    );
    const rows: React.ReactNode[] = [
      <Text key="header" color={color} wrap="truncate-end" inverse={selected}>
        {mark}{" "}
        <MatrixText
          text={sanitizeTerminalText(meta || "tool", false)}
          animateOnMount={animateOnMount}
          seed={seed + 901}
        />
      </Text>,
      ...(text
        ? bodyLines.map((line, index) => {
          const rowFrame = bodyFrames[index] ?? 0;
          const previousLine = previousBodyLines[index] ?? "";
          if (rowFrame < 0 && !previousLine) return null;
          return (
          <Text key={`body:${index}`} color={theme.dim} wrap="truncate-end" inverse={selected}>
            {"    "}
            <MatrixGlyphRuns
              text={visibleText(rowFrame < 0 ? previousLine : line)}
              previousText={visibleText(previousLine)}
              frame={rowFrame < 0 ? 0 : rowFrame}
              churnFrame={reveal.churnFrame}
              seed={seed + index}
            />
          </Text>
          );
        })
        : []),
    ];
    return (
      <Box flexDirection="column" marginLeft={1} width={Math.max(20, width - 1)}>
        {clipRows(rows)}
      </Box>
    );
  }

  if (role === "thinking") {
    const bodyLines = text
      ? wrapTextLines(text, Math.max(12, width - 4))
      : [];
    const previousBodyLines = wrapTextLines(
      reveal.previousText,
      Math.max(12, width - 4),
    );
    const bodyFrames = matrixFramesByRow(
      bodyLines,
      previousBodyLines,
      reveal.frame,
    );
    const rows: React.ReactNode[] = [
      <Text key="header" color={theme.thinking} wrap="truncate-end" inverse={selected}>
        ⎿{"  "}
        <MatrixText
          text={`thinking${meta ? ` ${sanitizeTerminalText(meta, false)}` : ""}`}
          animateOnMount={animateOnMount}
          seed={seed + 977}
        />
      </Text>,
      ...(text
        ? bodyLines.map((line, index) => {
          const rowFrame = bodyFrames[index] ?? 0;
          const previousLine = previousBodyLines[index] ?? "";
          if (rowFrame < 0 && !previousLine) return null;
          return (
          <Text key={`body:${index}`} color={theme.dim} wrap="truncate-end" inverse={selected}>
            {"   "}
            <MatrixGlyphRuns
              text={visibleText(rowFrame < 0 ? previousLine : line)}
              previousText={visibleText(previousLine)}
              frame={rowFrame < 0 ? 0 : rowFrame}
              churnFrame={reveal.churnFrame}
              seed={seed + index}
            />
          </Text>
          );
        })
        : []),
    ];
    return (
      <Box flexDirection="column" marginLeft={1} width={Math.max(20, width - 1)}>
        {clipRows(rows)}
      </Box>
    );
  }

  if (role === "system") {
    return (
      <Box flexDirection="column" width={width}>
        <MarkdownText
          text={text || ""}
          width={width}
          theme={systemTheme}
          topClip={clip}
          bottomClip={bottom}
          selected={selected}
          matrixPreviousText={reveal.previousText}
          matrixFrame={reveal.frame}
          matrixChurnFrame={reveal.churnFrame}
          matrixSeed={seed}
        />
      </Box>
    );
  }

  // ── assistant: collapsed by default ─────────────────────────────────
  const lines = lineCount(text || "");
  const chars = (text || "").length;
  const okColor = statusColor(ok, theme, theme.text);

  if (!expanded) {
    const rows: React.ReactElement[] = [
      <Box key="header" width={width}>
        <Text color={focused ? theme.accent : okColor} bold inverse={selected}>
          {focused ? "▸ " : "● "}
        </Text>
        <Text color={theme.dim} inverse={selected}>
          collapsed
        </Text>
        <Text color={theme.dim} inverse={selected}>
          {" · "}
          {lines} line{lines === 1 ? "" : "s"}
          {chars > 0 ? ` · ${chars} chars` : ""}
        </Text>
        <Text color={theme.accent} inverse={selected}>
          {"  "}[click / e to expand]
        </Text>
      </Box>,
      <Text key="preview" color={theme.dim} wrap="truncate-end" inverse={selected}>
        {"  "}
        <MatrixGlyphRuns
          text={previewLine(text || "", Math.max(20, width - 4))}
          previousText={previewLine(
            reveal.previousText,
            Math.max(20, width - 4),
          )}
          frame={reveal.frame}
          churnFrame={reveal.churnFrame}
          seed={seed}
        />
      </Text>,
    ];
    return (
      <Box flexDirection="column" width={width} marginY={0}>
        {clipRows(rows)}
      </Box>
    );
  }

  // MarkdownText owns its own row-range clipping (the same contract
  // ToolCard/DiffView already use), so the header row above it and the
  // markdown body below split ONE combined [visibleStart, visibleEnd) window
  // between them instead of both slicing a single flat element array the way
  // every other branch above does — a markdown body is not a flat array of
  // pre-rendered rows, its row count is only known via `estimateMarkdownLines`.
  const bodyLines = estimateMarkdownLines(text || "", width);
  const totalHeight = 1 + bodyLines;
  const visibleStart = Math.max(0, clip);
  const visibleEnd = Math.max(visibleStart, totalHeight - bottom);
  const showHeader = visibleStart <= 0 && visibleEnd > 0;
  const bodyTopClip = Math.max(0, visibleStart - 1);
  const bodyBottomClip = Math.max(0, totalHeight - visibleEnd);
  return (
    <Box flexDirection="column" width={width} marginY={0}>
      {showHeader ? (
        <Box key="header" width={width}>
          <Text color={focused ? theme.accent : okColor} bold inverse={selected}>
            {focused ? "▸ " : "● "}
          </Text>
          <Text color={theme.dim} inverse={selected}>
            expanded · {bodyLines} line{bodyLines === 1 ? "" : "s"}
          </Text>
          <Text color={theme.accent} inverse={selected}>
            {"  "}[click / e to collapse]
          </Text>
        </Box>
      ) : null}
      <MarkdownText
        text={text || ""}
        width={width}
        theme={theme}
        topClip={bodyTopClip}
        bottomClip={bodyBottomClip}
        selected={selected}
        matrixPreviousText={reveal.previousText}
        matrixFrame={reveal.frame}
        matrixChurnFrame={reveal.churnFrame}
        matrixSeed={seed}
      />
    </Box>
  );
}

/**
 * Memoized so a Matrix frame or completed message update repaints only the
 * affected row, not the whole visible slice. Markdown parsing makes a naive
 * re-render of every message measurably more expensive than the old flat
 * `wrapTextLines` path was; stable message objects let unchanged rows reuse
 * their previous render.
 */
const MessageRow = React.memo(MessageRowImpl);
