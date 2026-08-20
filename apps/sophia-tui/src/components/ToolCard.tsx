import React from "react";
import { Box, Text } from "ink";

import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import type { Theme } from "../lib/theme.js";
import type { ToolCallState, ToolRisk, ToolStatus } from "../lib/toolState.js";
import {
  formatArtifact,
  formatToolArgs,
  prepareToolOutput,
  sanitizeToolText,
  type PreparedToolOutput,
} from "../lib/toolOutput.js";
import { truncateToWidth } from "../lib/textWidth.js";
import {
  buildDiffPreview,
  diffPreviewLineCount,
  DiffView,
  isUnifiedDiff,
  type DiffPreview,
} from "./DiffView.js";
import {
  expandToolOutput,
  formatFileChangeEntry,
  formatToolCallUsage,
  type FileChangeSummary,
  type ToolOutputExpansionAction,
  type ToolOutputExpansionState,
  type ToolOutputWindow,
} from "../lib/toolTransparency.js";
import { MatrixText } from "./MatrixText.js";

export interface ToolCardOptions {
  maxOutputLines?: number;
  maxDiffLines?: number;
  /**
   * Current expand/scroll state for the plain-text output window. Omitted
   * (or `{mode: "collapsed", ...}`) reproduces today's fixed 4-line preview
   * byte-for-byte — an older call site that never sets this keeps rendering
   * exactly the way it always has. Setting this to "expanded"/"full" (see
   * lib/toolTransparency.ts's applyToolOutputExpansionAction) is what makes
   * a truncated result reachable instead of permanently clipped.
   */
  outputExpansion?: ToolOutputExpansionState;
  /** Rows visible at once while `outputExpansion.mode === "expanded"`. Ignored in "collapsed"/"full". */
  expansionViewportLines?: number;
  /**
   * Per-call token/cost usage in whatever shape the kernel's tool_result
   * happened to carry it — handed straight to toolTransparency's
   * formatToolCallUsage, which tolerates every naming variant and never
   * throws. Absent (not a fabricated zero) whenever the kernel never
   * reported usage for this specific call.
   */
  usage?: unknown;
}

export interface ToolCardViewModel {
  icon: string;
  statusLabel: string;
  header: string;
  cwdLine: string;
  argsLine: string;
  output: PreparedToolOutput;
  /** Non-null only when `outputExpansion` requested more than the collapsed preview. */
  outputWindow: ToolOutputWindow | null;
  /** One-line description of `outputWindow`'s hidden/visible extent; "" when outputWindow is null. */
  outputHint: string;
  /** "1,234 tok · $0.05"; "" when the caller supplied no usage figure for this call. */
  usageLine: string;
  diff: DiffPreview | null;
  diffSource: string;
  artifactLine: string;
  lineCount: number;
}

const DEFAULT_EXPANSION_VIEWPORT_LINES = 20;

/**
 * One human-readable line describing an expanded/full output window — how
 * much is still hidden above/below, or an honest "showing all N lines" when
 * there is truly nothing left to reveal. Exported so the exact wording is
 * testable without rendering Ink.
 */
export function describeOutputWindow(window: ToolOutputWindow): string {
  const parts: string[] = [window.mode === "full" ? "full" : "expanded"];
  if (window.hiddenAbove > 0) parts.push(`↑ ${window.hiddenAbove} above`);
  if (window.moreIndicator) {
    parts.push(window.moreIndicator);
  } else if (window.totalLines > 0) {
    parts.push(`showing all ${window.totalLines} line${window.totalLines === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

export function formatToolDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function toolStatusVisual(status: ToolStatus): { icon: string; label: string } {
  switch (status) {
    case "queued": return { icon: "○", label: "queued" };
    case "running": return { icon: "⏺", label: "running" };
    case "awaiting_approval": return { icon: "?", label: "approval required" };
    case "succeeded": return { icon: "✓", label: "succeeded" };
    case "failed": return { icon: "✗", label: "failed" };
    case "denied": return { icon: "⊘", label: "denied" };
    case "cancelled": return { icon: "■", label: "cancelled" };
  }
}

export function toolCardChrome(screenReader: boolean): {
  detailPrefix: string;
  outputPrefix: string;
  notePrefix: string;
} {
  return screenReader
    ? { detailPrefix: "", outputPrefix: "output · ", notePrefix: "note · " }
    : { detailPrefix: "│ ", outputPrefix: "│ out · ", notePrefix: "│ " };
}

function shortId(stableId: string): string {
  const safe = sanitizeToolText(stableId, false, 128);
  return safe.length <= 18 ? safe : `${safe.slice(0, 8)}…${safe.slice(-6)}`;
}

function formatArtifacts(tool: ToolCallState, width: number): string {
  if (tool.artifacts.length === 0) return "";
  const shown = tool.artifacts
    .slice(0, 3)
    .map((artifact) => formatArtifact(artifact, Math.max(16, Math.floor(width / 3))))
    .join(" · ");
  const rest = tool.artifacts.length > 3 ? ` · +${tool.artifacts.length - 3} more` : "";
  return truncateToWidth(`artifacts · ${shown}${rest}`, Math.max(16, width - 3));
}

/** One model drives both rendering and layout estimation, preventing scroll drift. */
export function buildToolCardViewModel(
  tool: ToolCallState,
  width: number,
  options: ToolCardOptions = {},
): ToolCardViewModel {
  const bodyWidth = Math.max(16, width - 4);
  const visual = toolStatusVisual(tool.status);
  const duration = formatToolDuration(tool.durationMs);
  const usageLine = options.usage !== undefined && options.usage !== null ? formatToolCallUsage(options.usage) : "";
  const header = truncateToWidth(
    `${visual.icon} ${sanitizeToolText(tool.name, false, 256)} · ${visual.label} · risk ${tool.risk}` +
      `${duration ? ` · ${duration}` : ""}${usageLine ? ` · ${usageLine}` : ""} · id ${shortId(tool.stableId)}`,
    Math.max(20, width),
  );
  const cwdLine = tool.cwd
    ? truncateToWidth(`cwd · ${sanitizeToolText(tool.cwd, false, 2_048)}`, bodyWidth)
    : "";
  const args = formatToolArgs(tool.args, Math.max(16, bodyWidth - 7));
  const argsLine = args ? truncateToWidth(`args · ${args}`, bodyWidth) : "";
  const maxOutputLines = Math.max(1, options.maxOutputLines ?? 4);
  const maxDiffLines = Math.max(1, options.maxDiffLines ?? 12);
  const explicitDiff = tool.diff || "";
  const outputIsDiff = !explicitDiff && tool.output ? isUnifiedDiff(tool.output) : false;
  const diffSource = explicitDiff || (outputIsDiff ? tool.output || "" : "");
  const diff = diffSource
    ? buildDiffPreview(diffSource, {
      maxLines: maxDiffLines,
      maxColumns: bodyWidth,
    })
    : null;
  const normalOutput =
    outputIsDiff || (explicitDiff && tool.output === explicitDiff)
      ? ""
      : tool.output || "";
  const output = prepareToolOutput(normalOutput, {
    maxLines: maxOutputLines,
    maxChars: 1_600,
    maxColumns: Math.max(12, bodyWidth - 6),
    artifacts: tool.artifacts,
  });
  // A truncated result used to be permanently clipped at maxOutputLines/1600
  // chars with no way back — expandToolOutput only takes over once a caller
  // explicitly asks for more (the default `{mode: "collapsed"}` path above
  // is untouched), so an older render site that never sets outputExpansion
  // keeps seeing exactly the same fixed preview it always has.
  const wantsExpansion =
    options.outputExpansion?.mode === "expanded" || options.outputExpansion?.mode === "full";
  const outputWindow =
    wantsExpansion && normalOutput
      ? expandToolOutput(
        normalOutput,
        Math.max(1, options.expansionViewportLines ?? DEFAULT_EXPANSION_VIEWPORT_LINES),
        options.outputExpansion,
        {
          collapsedLines: maxOutputLines,
          maxColumns: Math.max(12, bodyWidth - 6),
        },
      )
      : null;
  const outputHint = outputWindow ? describeOutputWindow(outputWindow) : "";
  const artifactLine = formatArtifacts(tool, width);
  const lineCount =
    1 +
    (cwdLine ? 1 : 0) +
    (argsLine ? 1 : 0) +
    (diff ? diffPreviewLineCount(diff) : 0) +
    (outputWindow
      ? outputWindow.lines.length + (outputHint ? 1 : 0)
      : output.lines.length + (output.retentionNote ? 1 : 0)) +
    (artifactLine ? 1 : 0);
  return {
    icon: visual.icon,
    statusLabel: visual.label,
    header,
    cwdLine,
    argsLine,
    output,
    outputWindow,
    outputHint,
    usageLine,
    diff,
    diffSource,
    artifactLine,
    lineCount,
  };
}

export function estimateToolCardLines(
  tool: ToolCallState,
  width: number,
  options: ToolCardOptions = {},
): number {
  return buildToolCardViewModel(tool, width, options).lineCount;
}

function statusColor(status: ToolStatus, theme: Theme): string {
  if (status === "succeeded") return theme.success;
  if (status === "failed" || status === "denied" || status === "cancelled") return theme.error;
  if (status === "awaiting_approval") return theme.warn;
  return theme.tool;
}

function riskColor(risk: ToolRisk, theme: Theme): string {
  if (risk === "critical" || risk === "high") return theme.error;
  if (risk === "medium") return theme.warn;
  if (risk === "low") return theme.success;
  return theme.dim;
}

export function ToolCard({
  tool,
  theme,
  width,
  maxOutputLines,
  maxDiffLines,
  outputExpansion,
  expansionViewportLines,
  usage,
  onExpansionAction,
  selected = false,
  animateOnMount = false,
  topClip = 0,
  bottomClip = 0,
}: {
  tool: ToolCallState;
  theme: Theme;
  width: number;
  maxOutputLines?: number;
  maxDiffLines?: number;
  /** See ToolCardOptions.outputExpansion — owned/persisted by the caller, not this component. */
  outputExpansion?: ToolOutputExpansionState;
  expansionViewportLines?: number;
  /** See ToolCardOptions.usage. */
  usage?: unknown;
  /**
   * Reports expand/collapse/scroll intent for this card's output, the same
   * way GraphPanel/WorkflowTree report `onToggle`/`onSelect`: this component
   * stays presentation-only and never calls it itself — the App owns
   * keyboard (and any mouse hit-region) routing, decides when the selected
   * card's output should cycle collapsed → expanded → full, and re-renders
   * with a new `outputExpansion`. Declared here purely so a caller can pass
   * a real handler once that routing exists, without this component's props
   * changing shape again.
   */
  onExpansionAction?: (action: ToolOutputExpansionAction) => void;
  selected?: boolean;
  /** Reveal only genuinely new/live cards; resumed history stays still. */
  animateOnMount?: boolean;
  topClip?: number;
  bottomClip?: number;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const model = buildToolCardViewModel(tool, width, {
    maxOutputLines,
    maxDiffLines,
    outputExpansion,
    expansionViewportLines,
    usage,
  });
  const visual = toolStatusVisual(tool.status);
  const chrome = toolCardChrome(ax.screenReader);
  const safeName = sanitizeToolText(tool.name, false, 256);
  const headerStart = ax.screenReader
    ? `${safeName}: ${visual.label}`
    : `${visual.icon} ${safeName} · ${visual.label}`;
  const diffIndent = ax.screenReader ? 0 : 2;
  const visibleStart = Math.max(0, topClip);
  const visibleEnd = Math.max(
    visibleStart,
    model.lineCount - Math.max(0, bottomClip),
  );
  let rowCursor = 0;
  const rows: React.ReactNode[] = [];
  const pushRow = (key: string, row: React.ReactElement) => {
    if (rowCursor >= visibleStart && rowCursor < visibleEnd) {
      rows.push(React.cloneElement(row, { key }));
    }
    rowCursor += 1;
  };

  pushRow(
    "header",
    <Text color={statusColor(tool.status, t)} bold wrap="truncate-end" inverse={selected}>
      <MatrixText text={headerStart} animateOnMount={animateOnMount} seed={11} />
      <Text color={riskColor(tool.risk, t)} inverse={selected}>
        <MatrixText
          text={` · risk ${tool.risk}`}
          animateOnMount={animateOnMount}
          seed={23}
        />
      </Text>
      {formatToolDuration(tool.durationMs) ? (
        <Text color={t.dim} inverse={selected}>
          <MatrixText
            text={` · ${formatToolDuration(tool.durationMs)}`}
            animateOnMount={animateOnMount}
            seed={37}
          />
        </Text>
      ) : null}
      {model.usageLine ? (
        <Text color={t.dim} inverse={selected}>
          <MatrixText
            text={` · ${model.usageLine}`}
            animateOnMount={animateOnMount}
            seed={41}
          />
        </Text>
      ) : null}
      <Text color={t.dim} inverse={selected}>
        <MatrixText
          text={` · id ${shortId(tool.stableId)}`}
          animateOnMount={animateOnMount}
          seed={53}
        />
      </Text>
    </Text>,
  );
  if (model.cwdLine) {
    pushRow(
      "cwd",
      <Text color={t.dim} wrap="truncate-end" inverse={selected}>
        {chrome.detailPrefix}
        <MatrixText
          text={model.cwdLine}
          animateOnMount={animateOnMount}
          seed={67}
        />
      </Text>,
    );
  }
  if (model.argsLine) {
    pushRow(
      "args",
      <Text color={t.dim} wrap="truncate-end" inverse={selected}>
        {chrome.detailPrefix}
        <MatrixText
          text={model.argsLine}
          animateOnMount={animateOnMount}
          seed={79}
        />
      </Text>,
    );
  }
  if (model.diff) {
    const diffRows = diffPreviewLineCount(model.diff);
    const diffStart = rowCursor;
    const diffEnd = diffStart + diffRows;
    if (diffEnd > visibleStart && diffStart < visibleEnd) {
      rows.push(
        <Box
          key="diff"
          marginLeft={diffIndent}
          width={Math.max(16, width - diffIndent)}
        >
          <DiffView
            preview={model.diff}
            diff={model.diffSource}
            theme={t}
            width={Math.max(16, width - diffIndent)}
            maxLines={maxDiffLines}
            topClip={Math.max(0, visibleStart - diffStart)}
            bottomClip={Math.max(0, diffEnd - visibleEnd)}
            selected={selected}
            animateOnMount={animateOnMount}
          />
        </Box>,
      );
    }
    rowCursor = diffEnd;
  }
  if (model.outputWindow) {
    // Reachable now: an expanded/full request renders the actual windowed
    // slice (already redacted/width-clipped by expandToolOutput) instead of
    // the fixed 4-line preview, so a truncated result is no longer a dead end.
    model.outputWindow.lines.forEach((line, index) => {
      pushRow(
        `output:${index}`,
        <Text color={t.dim} wrap="truncate-end" inverse={selected}>
          {chrome.outputPrefix}
          <MatrixText
            text={line || " "}
            animateOnMount={animateOnMount}
            seed={101 + index}
          />
        </Text>,
      );
    });
    if (model.outputHint) {
      pushRow(
        "output-hint",
        <Text color={t.warn} wrap="truncate-end" inverse={selected}>
          {chrome.notePrefix}
          <MatrixText
            text={model.outputHint}
            animateOnMount={animateOnMount}
            seed={127}
          />
        </Text>,
      );
    }
  } else {
    model.output.lines.forEach((line, index) => {
      pushRow(
        `output:${index}`,
        <Text color={t.dim} wrap="truncate-end" inverse={selected}>
          {chrome.outputPrefix}
          <MatrixText
            text={line || " "}
            animateOnMount={animateOnMount}
            seed={151 + index}
          />
        </Text>,
      );
    });
    if (model.output.retentionNote) {
      pushRow(
        "retention",
        <Text color={t.warn} wrap="truncate-end" inverse={selected}>
          {chrome.notePrefix}
          <MatrixText
            text={`${model.output.retentionNote}${
              model.output.omittedLines
                ? ` · ${model.output.lineCountComplete ? "" : "at least "}${model.output.omittedLines} lines omitted`
                : ""
            }`}
            animateOnMount={animateOnMount}
            seed={181}
          />
        </Text>,
      );
    }
  }
  if (model.artifactLine) {
    pushRow(
      "artifact",
      <Text color={t.accent} wrap="truncate-end" inverse={selected}>
        {chrome.detailPrefix}
        <MatrixText
          text={model.artifactLine}
          animateOnMount={animateOnMount}
          seed={211}
        />
      </Text>,
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      {rows}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Per-turn file-change summary ("3 files changed · +42 -7" + breakdown).
//
// This is deliberately a standalone unit rather than a field folded into a
// single ToolCallState's card: a turn's file changes are a property of the
// whole batch of tool calls, not any one call, so a caller (the timeline
// that groups tool calls into a turn) renders this once per turn rather than
// once per card. summarizeFileChanges() (lib/toolTransparency.ts) already
// decides the "counts unavailable" vs real-zero distinction; this only
// formats and windows what it was handed, the same discipline as the rest
// of this file.
// ---------------------------------------------------------------------------

const DEFAULT_FILE_CHANGE_ROWS = 12;

export interface FileChangeSummaryViewModel {
  /** "" only when summary.fileCount === 0 — the caller should render nothing at all in that case. */
  headline: string;
  /** Per-file breakdown rows, already width-truncated, capped at maxFilesShown entries. */
  fileLines: string[];
  /** "+N more files not shown"; "" when every touched file is listed. */
  omittedNote: string;
}

/** One model drives both estimateFileChangeSummaryLines and ToolFileChangeSummary, for the same scroll-drift reason buildToolCardViewModel documents above. */
export function buildFileChangeSummaryViewModel(
  summary: FileChangeSummary,
  width: number,
  maxFilesShown: number = DEFAULT_FILE_CHANGE_ROWS,
): FileChangeSummaryViewModel {
  if (summary.fileCount === 0) return { headline: "", fileLines: [], omittedNote: "" };
  const rowWidth = Math.max(16, width - 2);
  const cap = Math.max(0, Math.floor(maxFilesShown) || 0);
  const shown = summary.files.slice(0, cap);
  const fileLines = shown.map((entry) => formatFileChangeEntry(entry, rowWidth));
  const notShown = summary.files.length - shown.length + summary.omittedFiles;
  const omittedNote = notShown > 0 ? `+${notShown} more file${notShown === 1 ? "" : "s"} not shown` : "";
  return { headline: summary.headline, fileLines, omittedNote };
}

/** Row count `ToolFileChangeSummary` will occupy at this width — call this from the same layout-estimation pass that sizes ToolCard rows. */
export function estimateFileChangeSummaryLines(
  summary: FileChangeSummary,
  width: number,
  maxFilesShown: number = DEFAULT_FILE_CHANGE_ROWS,
): number {
  const model = buildFileChangeSummaryViewModel(summary, width, maxFilesShown);
  if (!model.headline) return 0;
  return 1 + model.fileLines.length + (model.omittedNote ? 1 : 0);
}

/**
 * The per-turn "N files changed · +A -R" line plus its per-file breakdown.
 * Renders nothing (null) when the turn touched no files — a distinct,
 * legitimate state from "0 files changed" that summarizeFileChanges already
 * tells apart from "counts unavailable"; this component just trusts that
 * distinction rather than re-deriving it.
 */
export function ToolFileChangeSummary({
  summary,
  theme,
  width,
  maxFilesShown = DEFAULT_FILE_CHANGE_ROWS,
  animateOnMount = false,
  topClip = 0,
  bottomClip = 0,
}: {
  summary: FileChangeSummary;
  theme: Theme;
  width: number;
  maxFilesShown?: number;
  /** Reveal only a newly emitted summary; historical summaries stay still. */
  animateOnMount?: boolean;
  topClip?: number;
  bottomClip?: number;
}): React.ReactElement | null {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const model = buildFileChangeSummaryViewModel(summary, width, maxFilesShown);
  if (!model.headline) return null;

  const allRows = [model.headline, ...model.fileLines, ...(model.omittedNote ? [model.omittedNote] : [])];
  const visibleStart = Math.max(0, topClip);
  const visibleEnd = Math.max(visibleStart, allRows.length - Math.max(0, bottomClip));
  const visibleRows = allRows
    .map((text, index) => ({ text, index }))
    .slice(visibleStart, visibleEnd);
  if (visibleRows.length === 0) return null;

  // countsUnavailable is a distinct, honest state from "0 lines changed" —
  // it earns the same warn treatment ToolCard gives a truncated/unreliable
  // preview, rather than blending in as if the headline were routine.
  const headlineColor = summary.countsUnavailable ? t.warn : t.accent;

  return (
    <Box flexDirection="column" width={width}>
      {visibleRows.map(({ text, index }) => (
        <Text
          key={index}
          color={index === 0 ? headlineColor : t.dim}
          bold={index === 0}
          wrap="truncate-end"
        >
          {index === 0 ? "" : ax.screenReader ? "" : "  "}
          <MatrixText
            text={text || " "}
            animateOnMount={animateOnMount}
            seed={601 + index}
          />
        </Text>
      ))}
    </Box>
  );
}
