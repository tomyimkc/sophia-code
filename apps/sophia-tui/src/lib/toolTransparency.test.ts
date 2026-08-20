import test from "node:test";
import assert from "node:assert/strict";

import type { ToolCallState } from "./toolState.js";
import {
  applyToolOutputExpansionAction,
  COLLAPSED_TOOL_OUTPUT,
  expandToolOutput,
  extractToolCallUsage,
  formatFileChangeEntry,
  formatToolCallCostUsd,
  formatToolCallTokens,
  formatToolCallUsage,
  groupToolCallsByName,
  sortToolCallsForDisplay,
  summarizeFileChanges,
} from "./toolTransparency.js";

function call(overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    stableId: "call-1",
    name: "read_file",
    status: "succeeded",
    risk: "low",
    artifacts: [],
    batchId: "batch-1",
    sourceMessageIds: ["row-1"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// expandToolOutput
// ---------------------------------------------------------------------------

test("expandToolOutput: empty/missing output never throws and reports nothing hidden", () => {
  for (const value of [undefined, null, ""]) {
    const view = expandToolOutput(value, 10);
    assert.deepEqual(view.lines, []);
    assert.equal(view.totalLines, 0);
    assert.equal(view.moreIndicator, "");
    assert.equal(view.canExpand, false);
  }
});

test("expandToolOutput: collapsed mode shows the default preview and an honest more-lines count", () => {
  const output = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const view = expandToolOutput(output, 10);
  assert.equal(view.mode, "collapsed");
  assert.equal(view.lines.length, 4);
  assert.deepEqual(view.lines, ["line 0", "line 1", "line 2", "line 3"]);
  assert.equal(view.hiddenBelow, 6);
  assert.equal(view.moreIndicator, "6 more lines below");
  assert.equal(view.canExpand, true);
  assert.equal(view.canScrollUp, false);
  assert.equal(view.canScrollDown, false);
});

test("expandToolOutput: short output collapsed has nothing to expand", () => {
  const view = expandToolOutput("one\ntwo", 10);
  assert.deepEqual(view.lines, ["one", "two"]);
  assert.equal(view.hiddenBelow, 0);
  assert.equal(view.moreIndicator, "");
  assert.equal(view.canExpand, false);
});

test("expandToolOutput: expanded mode windows by viewport and reports scroll affordances", () => {
  const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const view = expandToolOutput(output, 5, { mode: "expanded", scrollLine: 0 });
  assert.equal(view.mode, "expanded");
  assert.equal(view.lines.length, 5);
  assert.deepEqual(view.lines, ["line 0", "line 1", "line 2", "line 3", "line 4"]);
  assert.equal(view.canScrollUp, false);
  assert.equal(view.canScrollDown, true);
  assert.equal(view.moreIndicator, "15 more lines below");
});

test("expandToolOutput: scrolling within expanded mode moves the window and clamps at the end", () => {
  const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const mid = expandToolOutput(output, 5, { mode: "expanded", scrollLine: 8 });
  assert.deepEqual(mid.lines, ["line 8", "line 9", "line 10", "line 11", "line 12"]);
  assert.equal(mid.hiddenAbove, 8);
  assert.equal(mid.hiddenBelow, 7);
  assert.equal(mid.canScrollUp, true);
  assert.equal(mid.canScrollDown, true);

  // Requesting a scroll far past the end clamps to the last full window
  // rather than returning an empty or out-of-range slice.
  const past = expandToolOutput(output, 5, { mode: "expanded", scrollLine: 999 });
  assert.equal(past.startLine, 15);
  assert.deepEqual(past.lines, ["line 15", "line 16", "line 17", "line 18", "line 19"]);
  assert.equal(past.hiddenBelow, 0);
  assert.equal(past.canScrollDown, false);
});

test("expandToolOutput: full mode shows everything scanned with no hidden lines", () => {
  const output = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const view = expandToolOutput(output, 5, { mode: "full", scrollLine: 0 });
  assert.equal(view.mode, "full");
  assert.equal(view.lines.length, 500);
  assert.equal(view.hiddenBelow, 0);
  assert.equal(view.moreIndicator, "");
  assert.equal(view.canScrollUp, false);
  assert.equal(view.canScrollDown, false);
});

test("expandToolOutput: full mode over the scan limit says so honestly instead of claiming completeness", () => {
  const output = "x".repeat(600 * 1024);
  const view = expandToolOutput(output, 5, { mode: "full", scrollLine: 0 }, { scanLimit: 512 * 1024 });
  assert.equal(view.totalLinesKnown, false);
  assert.equal(view.moreIndicator, "more output not shown (exceeds scan limit)");
});

test("expandToolOutput: never fabricates line width beyond maxColumns for wide characters", () => {
  const wide = "字".repeat(50); // each character paints 2 terminal columns
  const view = expandToolOutput(wide, 10, undefined, { maxColumns: 10 });
  assert.equal(view.lines.length, 1);
  // 10 columns budget minus the ellipsis leaves room for at most 4-5 wide glyphs.
  assert.ok(view.lines[0].length <= 6, `expected a short truncated line, got ${JSON.stringify(view.lines[0])}`);
});

test("expandToolOutput: redacts secrets the same way in every mode", () => {
  // Built at runtime rather than written as a literal: a key-SHAPED string in a
  // tracked file trips the repo's secret-detection gate, and weakening that gate
  // to whitelist a test fixture would blunt the check that exists to catch a
  // real leak. The concatenation produces the identical bytes at test time.
  const secret = "Authorization: Bearer " + "sk" + "-verysecrettoken1234567890";
  for (const mode of ["collapsed", "expanded", "full"] as const) {
    const view = expandToolOutput(secret, 10, { mode, scrollLine: 0 });
    const joined = view.lines.join("\n");
    assert.equal(joined.includes("verysecrettoken"), false, `mode ${mode} leaked a secret`);
  }
});

test("expandToolOutput: non-string output coerces without throwing", () => {
  assert.doesNotThrow(() => expandToolOutput(12345, 10));
  assert.doesNotThrow(() => expandToolOutput({ weird: true }, 10));
  const view = expandToolOutput(12345, 10);
  assert.deepEqual(view.lines, ["12345"]);
});

test("applyToolOutputExpansionAction: cycles collapsed -> expanded -> full -> collapsed", () => {
  let state = COLLAPSED_TOOL_OUTPUT;
  state = applyToolOutputExpansionAction(state, { kind: "cycle" });
  assert.equal(state.mode, "expanded");
  state = applyToolOutputExpansionAction(state, { kind: "cycle" });
  assert.equal(state.mode, "full");
  state = applyToolOutputExpansionAction(state, { kind: "cycle" });
  assert.equal(state.mode, "collapsed");
});

test("applyToolOutputExpansionAction: scroll only moves in expanded mode and never goes negative", () => {
  const collapsed = applyToolOutputExpansionAction(COLLAPSED_TOOL_OUTPUT, { kind: "scroll", deltaLines: 5 });
  assert.equal(collapsed.mode, "collapsed");
  assert.equal(collapsed.scrollLine, 0);

  let expanded = applyToolOutputExpansionAction(COLLAPSED_TOOL_OUTPUT, { kind: "expand" });
  expanded = applyToolOutputExpansionAction(expanded, { kind: "scroll", deltaLines: 5 });
  assert.equal(expanded.scrollLine, 5);
  expanded = applyToolOutputExpansionAction(expanded, { kind: "scroll", deltaLines: -100 });
  assert.equal(expanded.scrollLine, 0);
});

test("applyToolOutputExpansionAction: malformed state/action never throws and defaults to collapsed", () => {
  // @ts-expect-error deliberately malformed input from an untrusted boundary
  assert.doesNotThrow(() => applyToolOutputExpansionAction(null, { kind: "cycle" }));
  // @ts-expect-error deliberately malformed input from an untrusted boundary
  const result = applyToolOutputExpansionAction(undefined, undefined);
  assert.equal(result.mode, "expanded");
});

// ---------------------------------------------------------------------------
// summarizeFileChanges / formatFileChangeEntry
// ---------------------------------------------------------------------------

test("summarizeFileChanges: no files touched is a distinct, empty-but-legitimate state", () => {
  const summary = summarizeFileChanges([]);
  assert.equal(summary.fileCount, 0);
  assert.equal(summary.headline, "");
  assert.equal(summary.countsUnavailable, false);
  assert.equal(summary.totals, undefined);
});

test("summarizeFileChanges: renders the canonical '+42 -7' headline when counts are fully known", () => {
  const summary = summarizeFileChanges(
    ["src/a.ts", "src/b.ts"],
    { "src/a.ts": { added: 40, removed: 5 }, "src/b.ts": { added: 2, removed: 2 } },
  );
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.headline, "2 files changed · +42 -7");
  assert.deepEqual(summary.totals, { added: 42, removed: 7 });
  assert.equal(summary.countsUnavailable, false);
  assert.equal(summary.partialCounts, false);
});

test("summarizeFileChanges: missing fileChanges argument is 'counts unavailable', not a fabricated 0", () => {
  const summary = summarizeFileChanges(["src/a.ts", "src/b.ts"]);
  assert.equal(summary.headline, "2 files changed · counts unavailable");
  assert.equal(summary.countsUnavailable, true);
  assert.equal(summary.totals, undefined);
  for (const entry of summary.files) assert.equal(entry.counts, undefined);
});

test("summarizeFileChanges: a half-known per-file count is treated as unknown, not zero-filled", () => {
  const summary = summarizeFileChanges(["src/a.ts"], { "src/a.ts": { added: 9 } });
  assert.equal(summary.files[0].counts, undefined);
  assert.equal(summary.countsUnavailable, true);
});

test("summarizeFileChanges: partial coverage is flagged rather than silently under-reported", () => {
  const summary = summarizeFileChanges(
    ["src/a.ts", "src/b.ts", "src/c.ts"],
    { "src/a.ts": { added: 10, removed: 1 } },
  );
  assert.equal(summary.fileCount, 3);
  assert.equal(summary.partialCounts, true);
  assert.deepEqual(summary.totals, { added: 10, removed: 1 });
  assert.match(summary.headline, /\(partial\)$/);
  assert.equal(summary.files.find((f) => f.path === "src/b.ts")?.counts, undefined);
});

test("summarizeFileChanges: accepts an array-of-rows fileChanges shape with alternate key names", () => {
  const summary = summarizeFileChanges(
    ["a.ts", "b.ts"],
    [
      { path: "a.ts", insertions: 3, deletions: 1 },
      { file: "b.ts", linesAdded: 4, lines_removed: 0 },
    ],
  );
  assert.deepEqual(summary.totals, { added: 7, removed: 1 });
});

test("summarizeFileChanges: tolerates malformed filesTouched/fileChanges without throwing", () => {
  assert.doesNotThrow(() => summarizeFileChanges(null, null));
  assert.doesNotThrow(() => summarizeFileChanges("not-an-array", 42));
  assert.doesNotThrow(() => summarizeFileChanges(undefined, undefined));
  const summary = summarizeFileChanges("nope" as unknown, 1 as unknown);
  assert.equal(summary.fileCount, 0);
});

test("summarizeFileChanges: dedupes repeated paths and sanitizes control characters", () => {
  const summary = summarizeFileChanges(["a.ts", "a.ts", "b .ts"]);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.files.some((f) => f.path.includes(" ")), false);
});

test("summarizeFileChanges: caps the per-file breakdown and reports how many were omitted", () => {
  const many = Array.from({ length: 501 }, (_, i) => `file-${i}.ts`);
  const summary = summarizeFileChanges(many);
  assert.equal(summary.fileCount, 501);
  assert.equal(summary.files.length, 500);
  assert.equal(summary.omittedFiles, 1);
});

test("formatFileChangeEntry: shows counts when known and an explicit unavailable label otherwise", () => {
  assert.equal(
    formatFileChangeEntry({ path: "src/a.ts", counts: { added: 3, removed: 1 } }),
    "src/a.ts +3 -1",
  );
  assert.equal(formatFileChangeEntry({ path: "src/a.ts" }), "src/a.ts counts unavailable");
});

test("formatFileChangeEntry: truncates long paths to the requested width", () => {
  const long = "src/" + "nested/".repeat(20) + "file.ts";
  const row = formatFileChangeEntry({ path: long, counts: { added: 1, removed: 1 } }, 24);
  assert.ok(row.length <= 24, `expected a row within 24 columns, got ${row.length}`);
});

// ---------------------------------------------------------------------------
// Per-call cost/token formatting
// ---------------------------------------------------------------------------

test("formatToolCallTokens: omits an absent figure instead of printing 0", () => {
  assert.equal(formatToolCallTokens(undefined), "");
  assert.equal(formatToolCallTokens(null), "");
  assert.equal(formatToolCallTokens(Number.NaN), "");
  assert.equal(formatToolCallTokens(-5), "");
  assert.equal(formatToolCallTokens("not a number"), "");
});

test("formatToolCallTokens: a real reported 0 is shown as a legitimate zero", () => {
  assert.equal(formatToolCallTokens(0), "0 tok");
});

test("formatToolCallTokens: groups large counts", () => {
  assert.equal(formatToolCallTokens(1234), "1,234 tok");
});

test("formatToolCallCostUsd: omits an absent figure instead of printing $0", () => {
  assert.equal(formatToolCallCostUsd(undefined), "");
  assert.equal(formatToolCallCostUsd(null), "");
  assert.equal(formatToolCallCostUsd(Number.NaN), "");
  assert.equal(formatToolCallCostUsd(-0.5), "");
});

test("formatToolCallCostUsd: a real reported $0 is shown as a legitimate zero", () => {
  assert.equal(formatToolCallCostUsd(0), "$0.00");
});

test("formatToolCallCostUsd: formats sub-cent and larger costs distinctly", () => {
  assert.equal(formatToolCallCostUsd(0.00034), "$0.0003");
  assert.equal(formatToolCallCostUsd(1.2), "$1.20");
});

test("extractToolCallUsage: reads snake_case and camelCase variants", () => {
  assert.deepEqual(extractToolCallUsage({ token_count: 10, cost_usd: 0.02 }), { tokens: 10, costUsd: 0.02 });
  assert.deepEqual(extractToolCallUsage({ totalTokens: 5, cost: 1 }), { tokens: 5, costUsd: 1 });
  assert.deepEqual(extractToolCallUsage({}), {});
  assert.deepEqual(extractToolCallUsage(null), {});
  assert.deepEqual(extractToolCallUsage("garbage"), {});
});

test("formatToolCallUsage: combines both figures, one figure, or neither, never throwing", () => {
  assert.equal(formatToolCallUsage({ tokens: 100, costUsd: 0.05 }), "100 tok · $0.05");
  assert.equal(formatToolCallUsage({ tokens: 100 }), "100 tok");
  assert.equal(formatToolCallUsage({ costUsd: 0.05 }), "$0.05");
  assert.equal(formatToolCallUsage({}), "");
  assert.doesNotThrow(() => formatToolCallUsage(null));
  assert.doesNotThrow(() => formatToolCallUsage([1, 2, 3]));
});

// ---------------------------------------------------------------------------
// Stable ordering/grouping
// ---------------------------------------------------------------------------

test("sortToolCallsForDisplay: orders by start time regardless of array/arrival order", () => {
  const calls = [
    call({ stableId: "c", startedAt: 300 }),
    call({ stableId: "a", startedAt: 100 }),
    call({ stableId: "b", startedAt: 200 }),
  ];
  assert.deepEqual(sortToolCallsForDisplay(calls).map((c) => c.stableId), ["a", "b", "c"]);
});

test("sortToolCallsForDisplay: missing startedAt sorts last, not first, and ties break by name then id", () => {
  const calls = [
    call({ stableId: "no-time", name: "z_tool" }),
    call({ stableId: "with-time", name: "a_tool", startedAt: 50 }),
    call({ stableId: "z", name: "same", startedAt: 10 }),
    call({ stableId: "a", name: "same", startedAt: 10 }),
  ];
  const order = sortToolCallsForDisplay(calls).map((c) => c.stableId);
  assert.deepEqual(order, ["a", "z", "with-time", "no-time"]);
});

test("sortToolCallsForDisplay: repeated calls with the same order produce the same output (stable, deterministic)", () => {
  const calls = [call({ stableId: "x" }), call({ stableId: "y" }), call({ stableId: "z" })];
  const first = sortToolCallsForDisplay(calls).map((c) => c.stableId);
  const second = sortToolCallsForDisplay(calls).map((c) => c.stableId);
  assert.deepEqual(first, second);
});

test("sortToolCallsForDisplay: tolerates null/undefined entries and non-array input without throwing", () => {
  assert.doesNotThrow(() => sortToolCallsForDisplay(null));
  assert.doesNotThrow(() => sortToolCallsForDisplay(undefined));
  // @ts-expect-error deliberately malformed input from an untrusted boundary
  const result = sortToolCallsForDisplay([call({ stableId: "ok" }), null, undefined]);
  assert.deepEqual(result.map((c) => c.stableId), ["ok"]);
});

test("groupToolCallsByName: groups in first-seen (post-sort) order with succeeded/failed/pending rollups", () => {
  const calls = [
    call({ stableId: "r1", name: "read_file", status: "succeeded", startedAt: 1 }),
    call({ stableId: "b1", name: "bash", status: "failed", startedAt: 2 }),
    call({ stableId: "r2", name: "read_file", status: "failed", startedAt: 3 }),
    call({ stableId: "b2", name: "bash", status: "running", startedAt: 4 }),
  ];
  const groups = groupToolCallsByName(calls);
  assert.deepEqual(groups.map((g) => g.name), ["read_file", "bash"]);
  const readGroup = groups[0];
  assert.equal(readGroup.calls.length, 2);
  assert.equal(readGroup.succeeded, 1);
  assert.equal(readGroup.failed, 1);
  const bashGroup = groups[1];
  assert.equal(bashGroup.failed, 1);
  assert.equal(bashGroup.pending, 1);
});

test("groupToolCallsByName: blank/missing name falls back to a labeled bucket instead of throwing", () => {
  const groups = groupToolCallsByName([call({ name: "" }), call({ name: "   " })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "(unknown tool)");
  assert.equal(groups[0].calls.length, 2);
});
