import test from "node:test";
import assert from "node:assert/strict";

import type { ToolCallState } from "../lib/toolState.js";
import type { FileChangeSummary } from "../lib/toolTransparency.js";
import {
  buildFileChangeSummaryViewModel,
  buildToolCardViewModel,
  describeOutputWindow,
  estimateFileChangeSummaryLines,
  estimateToolCardLines,
  formatToolDuration,
  toolCardChrome,
  toolStatusVisual,
} from "./ToolCard.js";

function state(overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    stableId: "call-1234567890",
    name: "exec_command",
    status: "succeeded",
    risk: "medium",
    args: { cmd: "npm test", token: "github_pat_abcdefghijklmnopqrstuvwxyz" },
    cwd: "/repo",
    durationMs: 1_250,
    output: "all tests passed",
    artifacts: [{ id: "log", label: "test.log", kind: "log", path: "/tmp/test.log" }],
    batchId: "batch-1",
    sourceMessageIds: ["row-1", "row-2"],
    ...overrides,
  };
}

test("rich tool-card model includes stable ID, status, risk, duration, cwd, args, output, and artifacts", () => {
  const model = buildToolCardViewModel(state(), 120);
  assert.match(model.header, /exec_command · succeeded · risk medium · 1\.3s · id call-1234567890/);
  assert.equal(model.cwdLine, "cwd · /repo");
  assert.match(model.argsLine, /npm test/);
  assert.equal(model.argsLine.includes("github_pat_"), false);
  assert.deepEqual(model.output.lines, ["all tests passed"]);
  assert.match(model.artifactLine, /test\.log → \/tmp\/test\.log/);
  assert.equal(model.lineCount, estimateToolCardLines(state(), 120));
});

test("unified output is routed through the bounded diff model instead of plain output", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "+extra",
  ].join("\n");
  const model = buildToolCardViewModel(state({ output: diff, artifacts: [] }), 80, {
    maxDiffLines: 3,
  });
  assert.ok(model.diff);
  assert.equal(model.output.lines.length, 0);
  assert.ok((model.diff?.lines.length ?? 0) <= 3);
  assert.equal(model.diff?.truncated, true);
  assert.equal(model.lineCount, estimateToolCardLines(state({ output: diff, artifacts: [] }), 80, {
    maxDiffLines: 3,
  }));
});

test("large output stays bounded and exposes whether an artifact exists", () => {
  const huge = Array.from({ length: 200 }, (_, index) => `line ${index} ${"x".repeat(100)}`).join("\n");
  const withoutArtifact = buildToolCardViewModel(state({ output: huge, artifacts: [] }), 70, {
    maxOutputLines: 2,
  });
  assert.equal(withoutArtifact.output.lines.length, 2);
  assert.match(withoutArtifact.output.retentionNote, /no artifact path supplied/);

  const withArtifact = buildToolCardViewModel(state({ output: huge }), 70, {
    maxOutputLines: 2,
  });
  assert.match(withArtifact.output.retentionNote, /full output in artifact/);
  assert.match(withArtifact.artifactLine, /test\.log/);
});

test("status and duration formatters are compact and deterministic", () => {
  assert.deepEqual(toolStatusVisual("awaiting_approval"), { icon: "?", label: "approval required" });
  assert.deepEqual(toolStatusVisual("failed"), { icon: "✗", label: "failed" });
  assert.equal(formatToolDuration(undefined), "");
  assert.equal(formatToolDuration(42), "42ms");
  assert.equal(formatToolDuration(1_250), "1.3s");
  assert.equal(formatToolDuration(65_000), "1m 05s");
  assert.deepEqual(toolCardChrome(true), {
    detailPrefix: "",
    outputPrefix: "output · ",
    notePrefix: "note · ",
  });
  assert.deepEqual(toolCardChrome(false), {
    detailPrefix: "│ ",
    outputPrefix: "│ out · ",
    notePrefix: "│ ",
  });
});

// ---------------------------------------------------------------------------
// Expandable output: today's fixed 4-line preview is unreachable past that
// point unless a caller explicitly asks for more via outputExpansion.
// ---------------------------------------------------------------------------

function longOutput(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");
}

test("without outputExpansion, a long result renders exactly the same fixed collapsed preview as before", () => {
  const tool = state({ output: longOutput(50), artifacts: [] });
  const model = buildToolCardViewModel(tool, 80);
  assert.equal(model.outputWindow, null);
  assert.equal(model.outputHint, "");
  assert.equal(model.output.lines.length, 4);
  assert.match(model.output.retentionNote, /output preview truncated/);
});

test("outputExpansion: 'expanded' makes the rest of a truncated result reachable, with an honest more-below count", () => {
  const tool = state({ output: longOutput(50), artifacts: [] });
  const model = buildToolCardViewModel(tool, 80, {
    outputExpansion: { mode: "expanded", scrollLine: 0 },
    expansionViewportLines: 10,
  });
  assert.ok(model.outputWindow);
  assert.equal(model.outputWindow?.lines.length, 10);
  assert.deepEqual(model.outputWindow?.lines.slice(0, 2), ["line 0", "line 1"]);
  assert.match(model.outputHint, /40 more lines below/);
  assert.equal(model.output.lines.length === 4, true); // unused legacy field still computed, ignored by the renderer in this mode
  assert.equal(
    model.lineCount,
    estimateToolCardLines(tool, 80, { outputExpansion: { mode: "expanded", scrollLine: 0 }, expansionViewportLines: 10 }),
  );
});

test("outputExpansion: scrolling within 'expanded' moves the window and the hint reports what's still hidden above and below", () => {
  const tool = state({ output: longOutput(50), artifacts: [] });
  const model = buildToolCardViewModel(tool, 80, {
    outputExpansion: { mode: "expanded", scrollLine: 20 },
    expansionViewportLines: 10,
  });
  assert.deepEqual(model.outputWindow?.lines[0], "line 20");
  assert.match(model.outputHint, /↑ 20 above/);
  assert.match(model.outputHint, /20 more lines below/);
});

test("outputExpansion: 'full' shows everything with an honest 'showing all N lines' when nothing is hidden", () => {
  const tool = state({ output: longOutput(12), artifacts: [] });
  const model = buildToolCardViewModel(tool, 80, {
    outputExpansion: { mode: "full", scrollLine: 0 },
  });
  assert.equal(model.outputWindow?.lines.length, 12);
  assert.equal(model.outputHint, "full · showing all 12 lines");
});

test("outputExpansion is ignored when the output has already been routed to the diff view", () => {
  const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
  const model = buildToolCardViewModel(state({ output: diff, artifacts: [] }), 80, {
    outputExpansion: { mode: "full", scrollLine: 0 },
  });
  assert.equal(model.outputWindow, null);
  assert.ok(model.diff);
});

test("describeOutputWindow: reachable via a stable, honestly-worded one-liner", () => {
  assert.equal(
    describeOutputWindow({
      mode: "expanded",
      lines: [],
      startLine: 0,
      totalLines: 10,
      totalLinesKnown: true,
      hiddenAbove: 0,
      hiddenBelow: 6,
      moreIndicator: "6 more lines below",
      canExpand: false,
      canScrollUp: false,
      canScrollDown: true,
    }),
    "expanded · 6 more lines below",
  );
  assert.equal(
    describeOutputWindow({
      mode: "full",
      lines: [],
      startLine: 0,
      totalLines: 3,
      totalLinesKnown: true,
      hiddenAbove: 0,
      hiddenBelow: 0,
      moreIndicator: "",
      canExpand: false,
      canScrollUp: false,
      canScrollDown: false,
    }),
    "full · showing all 3 lines",
  );
});

// ---------------------------------------------------------------------------
// Per-call cost/tokens: omitted, not zero, when the kernel never reported them.
// ---------------------------------------------------------------------------

test("usage is appended to the header only when the kernel supplied it", () => {
  const withoutUsage = buildToolCardViewModel(state(), 120);
  assert.equal(withoutUsage.usageLine, "");
  assert.equal(withoutUsage.header.includes("tok"), false);

  const withUsage = buildToolCardViewModel(state(), 120, { usage: { tokens: 1234, costUsd: 0.05 } });
  assert.equal(withUsage.usageLine, "1,234 tok · $0.05");
  assert.match(withUsage.header, /1,234 tok · \$0\.05 · id call-1234567890/);
});

test("usage tolerates malformed/absent input without throwing and never fabricates a figure", () => {
  assert.doesNotThrow(() => buildToolCardViewModel(state(), 120, { usage: null }));
  assert.doesNotThrow(() => buildToolCardViewModel(state(), 120, { usage: "garbage" }));
  const model = buildToolCardViewModel(state(), 120, { usage: "garbage" });
  assert.equal(model.usageLine, "");
});

// ---------------------------------------------------------------------------
// Per-turn file-change summary.
// ---------------------------------------------------------------------------

function fileSummary(overrides: Partial<FileChangeSummary> = {}): FileChangeSummary {
  return {
    fileCount: 2,
    files: [
      { path: "src/a.ts", counts: { added: 40, removed: 5 } },
      { path: "src/b.ts", counts: { added: 2, removed: 2 } },
    ],
    omittedFiles: 0,
    totals: { added: 42, removed: 7 },
    partialCounts: false,
    countsUnavailable: false,
    headline: "2 files changed · +42 -7",
    ...overrides,
  };
}

test("buildFileChangeSummaryViewModel: renders the canonical headline with a per-file breakdown", () => {
  const model = buildFileChangeSummaryViewModel(fileSummary(), 80);
  assert.equal(model.headline, "2 files changed · +42 -7");
  assert.deepEqual(model.fileLines, ["src/a.ts +40 -5", "src/b.ts +2 -2"]);
  assert.equal(model.omittedNote, "");
  assert.equal(estimateFileChangeSummaryLines(fileSummary(), 80), 3);
});

test("buildFileChangeSummaryViewModel: no files touched renders nothing, not a fabricated zero-file line", () => {
  const model = buildFileChangeSummaryViewModel(
    fileSummary({ fileCount: 0, files: [], totals: undefined, headline: "" }),
    80,
  );
  assert.equal(model.headline, "");
  assert.deepEqual(model.fileLines, []);
  assert.equal(estimateFileChangeSummaryLines(fileSummary({ fileCount: 0, files: [], totals: undefined, headline: "" }), 80), 0);
});

test("buildFileChangeSummaryViewModel: an explicit 'counts unavailable' headline is passed through untouched, not rewritten as 0", () => {
  const summary = fileSummary({
    files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    totals: undefined,
    countsUnavailable: true,
    headline: "2 files changed · counts unavailable",
  });
  const model = buildFileChangeSummaryViewModel(summary, 80);
  assert.equal(model.headline, "2 files changed · counts unavailable");
  assert.deepEqual(model.fileLines, ["src/a.ts counts unavailable", "src/b.ts counts unavailable"]);
});

test("buildFileChangeSummaryViewModel: caps the per-file breakdown and reports how many were left out", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ path: `file-${i}.ts`, counts: { added: 1, removed: 0 } }));
  const summary = fileSummary({
    fileCount: 20,
    files: many,
    totals: { added: 20, removed: 0 },
    headline: "20 files changed · +20 -0",
  });
  const model = buildFileChangeSummaryViewModel(summary, 80, 5);
  assert.equal(model.fileLines.length, 5);
  assert.equal(model.omittedNote, "+15 more files not shown");
  assert.equal(estimateFileChangeSummaryLines(summary, 80, 5), 1 + 5 + 1);
});
