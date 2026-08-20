import test from "node:test";
import assert from "node:assert/strict";
import { resolveTheme } from "../lib/theme.js";
import { estimateMessageLines, visibleMessageWindow } from "../lib/chatLayout.js";
import {
  clipHitRegionsToViewport,
  computeHitRegions,
  computeTimelineHitRegions,
  estimateTimelineItemLines,
  messageUsesArrivalCadence,
  statusColor,
  visibleTimelineWindow,
} from "./MessageList.js";
import type { ChatMessage } from "../lib/types.js";
import { projectToolTimeline } from "../lib/toolState.js";

const isExpanded = (_id: string, msg: ChatMessage): boolean =>
  msg.role !== "assistant" || msg.collapsed === false;

test("completed assistant rows and visible thinking do not inherit the Matrix reveal TPS cap", () => {
  assert.equal(messageUsesArrivalCadence("assistant"), true);
  assert.equal(messageUsesArrivalCadence("thinking"), true);
  assert.equal(messageUsesArrivalCadence("user"), true);
  assert.equal(messageUsesArrivalCadence("tool"), true);
  assert.equal(messageUsesArrivalCadence("system"), true);
});

test("hit-region rows follow the SAME height model the scroll window uses, including word-wrap", () => {
  const width = 20;
  // No `\n` at all — a plain newline count sees exactly one line, but at
  // width 20 this wraps to several screen rows.
  const longUser: ChatMessage = { id: "u1", role: "user", text: "a".repeat(100) };
  const assistant: ChatMessage = { id: "a1", role: "assistant", text: "reply", collapsed: true };
  const paneTopRow = 5;

  const hits = computeHitRegions([longUser, assistant], width, paneTopRow, isExpanded);
  const userHeight = estimateMessageLines(longUser, width, true);

  assert.ok(userHeight > 2, "a 100-char unbroken line at width 20 must wrap to several rows");
  assert.equal(hits[0].screenRow, paneTopRow);
  assert.equal(hits[0].screenEndRow, paneTopRow + userHeight - 1);
  assert.equal(
    hits[1].screenRow,
    paneTopRow + userHeight,
    "the assistant's click target must start after the message above it's FULL wrapped height",
  );

  // Regression guard: the old estimator counted only `\n` splits, capped at
  // 12, and would have placed this hit here instead — provably wrong once
  // the message actually wraps past 2 rows.
  const buggyNewlineEstimate = Math.min(12, 1 + longUser.text.split("\n").length);
  assert.notEqual(paneTopRow + buggyNewlineEstimate, hits[1].screenRow);
});

test("collapsed assistant messages occupy exactly the 2 rows they render (header + preview)", () => {
  const width = 40;
  const a: ChatMessage = { id: "a1", role: "assistant", text: "hello", collapsed: true };
  const b: ChatMessage = { id: "a2", role: "assistant", text: "world", collapsed: true };
  const hits = computeHitRegions([a, b], width, 1, isExpanded);
  assert.equal(hits[0].screenRow, 1);
  assert.equal(hits[1].screenRow, 3);
});

test("clipped message hit regions cannot capture transcript banners or rows below the pane", () => {
  const clipped = clipHitRegionsToViewport(
    [
      { id: "first", role: "assistant", screenRow: 2, screenEndRow: 8 },
      { id: "middle", role: "user", screenRow: 9, screenEndRow: 11 },
      { id: "last", role: "assistant", screenRow: 12, screenEndRow: 18 },
      { id: "outside", role: "tool", screenRow: 19, screenEndRow: 20 },
    ],
    5,
    14,
  );

  assert.deepEqual(clipped, [
    { id: "first", role: "assistant", screenRow: 5, screenEndRow: 8 },
    { id: "middle", role: "user", screenRow: 9, screenEndRow: 11 },
    { id: "last", role: "assistant", screenRow: 12, screenEndRow: 14 },
  ]);
});

test("statusColor treats an unset ok (e.g. a resumed transcript entry with no persisted verdict) as neutral", () => {
  const theme = resolveTheme("dark", {} as NodeJS.ProcessEnv);
  assert.equal(statusColor(true, theme, theme.text), theme.success);
  assert.equal(statusColor(false, theme, theme.text), theme.error);
  // Regression: this used to fall through to `theme.success` (green) for
  // undefined, painting every resumed assistant reply as a false success.
  assert.equal(statusColor(undefined, theme, theme.text), theme.text);
  assert.notEqual(statusColor(undefined, theme, theme.text), theme.success);
});

// --- exact visual-line windowing --------------------------------------------
// Message indexes alone cannot express a viewport inside one oversized reply.
// `topClip` and `bottomClip` carry the exact first/last-item row slices. Both
// boundaries are required: clipping only the top leaves an oversized remainder
// for Yoga to shrink, which stitches unrelated transcript lines together.

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
}
const expandAll = () => true;
const heightOf = (m: { id: string; role: string; text: string }) =>
  estimateMessageLines(m as never, 80, true);

test("a tall message must not push the newest reply off the bottom", () => {
  // A 50-line message followed by a 3-row expanded assistant in a 10-row
  // viewport. The final 10 rows are represented by the intersecting slice plus
  // an exact 43-row clip into the first message.
  const msgs = [
    { id: "a", role: "user", text: lines(50) },
    { id: "b", role: "assistant", text: lines(2) },
  ] as never[];
  const w = visibleMessageWindow(msgs, 80, 10, 0, expandAll);
  assert.equal(w.end, 2, "the newest message must still be in the window");
  assert.equal(w.topClip, 43);
  assert.equal(w.bottomClip, 0);
});

test("every scroll offset advances exactly one visual row inside an oversized reply", () => {
  const msgs = [
    { id: "a", role: "assistant", text: lines(71) },
  ] as never[];
  const bottom = visibleMessageWindow(msgs, 80, 17, 0, expandAll);
  const oneRowOlder = visibleMessageWindow(msgs, 80, 17, 1, expandAll);
  const top = visibleMessageWindow(msgs, 80, 17, bottom.maxScroll, expandAll);
  assert.deepEqual(
    { start: bottom.start, end: bottom.end },
    { start: 0, end: 1 },
    "a single oversized message remains the intersecting item at every offset",
  );
  assert.equal(oneRowOlder.topClip, bottom.topClip - 1);
  assert.equal(oneRowOlder.bottomClip, bottom.bottomClip + 1);
  assert.equal(top.topClip, 0);
  assert.equal(bottom.topClip, bottom.maxScroll);
  assert.equal(
    heightOf(msgs[0]) - oneRowOlder.topClip - oneRowOlder.bottomClip,
    17,
    "the middle window must render exactly the viewport, not an oversized flex child",
  );
});

test("the clipped slice equals the requested viewport for random transcripts", () => {
  let seed = 4242;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
  for (let trial = 0; trial < 2000; trial++) {
    const n = 1 + Math.floor(rand() * 6);
    const msgs = Array.from({ length: n }, (_, i) => ({
      id: `m${i}`, role: "assistant", text: lines(1 + Math.floor(rand() * 25)),
    })) as never[];
    const viewport = 6 + Math.floor(rand() * 20);
    const maxScroll = Math.max(
      0,
      msgs.reduce((sum, msg) => sum + heightOf(msg), 0) - viewport,
    );
    const offset = Math.floor(rand() * (maxScroll + 1));
    const w = visibleMessageWindow(msgs, 80, viewport, offset, expandAll);
    const sliceHeight = msgs.slice(w.start, w.end).reduce((s, m) => s + heightOf(m as never), 0);
    const visibleAfterBothClips = Math.max(
      0,
      sliceHeight - w.topClip - w.bottomClip,
    );
    const expectedVisible = Math.min(
      viewport,
      msgs.reduce((sum, msg) => sum + heightOf(msg), 0),
    );
    assert.equal(
      visibleAfterBothClips,
      expectedVisible,
      `trial ${trial}: exact slice ${visibleAfterBothClips} rows != ${expectedVisible}`,
    );
  }
});

test("a short transcript is untouched — the whole thing stays visible", () => {
  const msgs = [
    { id: "a", role: "user", text: lines(3) },
    { id: "b", role: "assistant", text: lines(2) },
  ] as never[];
  const w = visibleMessageWindow(msgs, 80, 20, 0, expandAll);
  assert.equal(w.start, 0);
  assert.equal(w.end, 2);
  assert.equal(w.maxScroll, 0, "nothing to scroll");
  assert.equal(w.topClip, 0);
  assert.equal(w.bottomClip, 0);
});

test("correlated tool cards replace duplicate call/result rows and preserve later hit geometry", () => {
  const messages: ChatMessage[] = [
    { id: "call", role: "tool", meta: "exec_command", text: '{"cmd":"npm test","cwd":"/repo"}' },
    { id: "result", role: "tool", meta: "exec_command", text: "all tests passed", ok: true },
    { id: "answer", role: "assistant", text: "Done.", collapsed: true },
  ];
  const timeline = projectToolTimeline(messages);
  assert.equal(timeline.length, 2, "call/result rows should fold into one card plus the answer");
  assert.equal(timeline[0].kind, "tool_batch");
  const width = 80;
  const paneTop = 4;
  const toolHeight = estimateTimelineItemLines(timeline[0], width, isExpanded);
  assert.ok(toolHeight >= 4, "the rich card should account for header, cwd, args, and output");

  const hits = computeTimelineHitRegions(timeline, width, paneTop, isExpanded);
  assert.equal(hits[0].id, "call");
  assert.equal(hits[1].id, "answer");
  assert.equal(hits[1].screenRow, paneTop + toolHeight);
});

test("adjacent calls are one parallel batch whose group header is included in layout", () => {
  const messages: ChatMessage[] = [
    { id: "c1", role: "tool", meta: "read_file", text: '{"path":"a"}' },
    { id: "c2", role: "tool", meta: "search", text: '{"query":"b"}' },
    { id: "r1", role: "tool", meta: "read_file", text: "A", ok: true },
    { id: "r2", role: "tool", meta: "search", text: "B", ok: true },
  ];
  const timeline = projectToolTimeline(messages);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, "tool_batch");
  if (timeline[0].kind !== "tool_batch") return;
  assert.equal(timeline[0].batch.parallel, true);
  const groupedHeight = estimateTimelineItemLines(timeline[0], 100, isExpanded);
  const individualHeights = timeline[0].batch.tools.reduce(
    (sum, tool) =>
      sum +
      estimateTimelineItemLines({
        kind: "tool_batch",
        id: tool.stableId,
        batch: { id: tool.batchId, parallel: false, tools: [tool] },
      }, 100, isExpanded),
    0,
  );
  assert.equal(groupedHeight, individualHeights + 1, "parallel batch header occupies one real row");
});

test("a tall bounded tool card cannot push the newest assistant answer out of the bottom window", () => {
  const messages = [
    {
      id: "call",
      role: "tool",
      meta: "exec_command",
      text: '{"cmd":"produce output"}',
      output: Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n"),
      artifacts: ["/tmp/full.log"],
    },
    { id: "result", role: "tool", meta: "exec_command", text: "done", ok: true },
    { id: "answer", role: "assistant", text: "Newest answer", collapsed: true },
  ] as unknown as ChatMessage[];
  const timeline = projectToolTimeline(messages);
  const window = visibleTimelineWindow(timeline, 80, 10, 0, isExpanded);
  assert.equal(window.end, timeline.length);
  assert.equal(
    timeline[window.end - 1].id,
    "answer",
    "the newest answer must remain in the rendered slice",
  );
});

test("tool-aware timeline window exposes line offsets inside one oversized answer", () => {
  // Fenced as code, not plain prose: markdown reflows contiguous plain lines
  // with no blank separator into ONE paragraph (see lib/markdown.ts), so 71
  // bare newline-joined lines would no longer be 71 rows once this renders
  // through MarkdownText. A code fence renders exactly one row per source
  // line (no reflow), which is what this test actually needs — a fixture
  // tall enough to force scrolling with an exact, predictable row count.
  const messages: ChatMessage[] = [
    { id: "answer", role: "assistant", text: "```\n" + lines(71) + "\n```", collapsed: false },
  ];
  const timeline = projectToolTimeline(messages);
  const bottom = visibleTimelineWindow(timeline, 80, 17, 0, isExpanded);
  const older = visibleTimelineWindow(timeline, 80, 17, 5, isExpanded);
  assert.equal(bottom.start, 0);
  assert.equal(bottom.end, 1);
  assert.equal(older.start, 0);
  assert.equal(older.end, 1);
  assert.equal(older.topClip, bottom.topClip - 5);
  assert.equal(older.bottomClip, bottom.bottomClip + 5);
  assert.equal(
    estimateTimelineItemLines(timeline[0], 80, isExpanded) -
      older.topClip -
      older.bottomClip,
    17,
  );
});
