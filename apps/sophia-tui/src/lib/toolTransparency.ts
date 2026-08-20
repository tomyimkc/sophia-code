/**
 * Display-only helpers for showing MORE of a tool call than the collapsed
 * card does, without ever claiming to know something the kernel did not send.
 *
 * Every input here crosses the Python/TS bridge: a tool result, a filesTouched
 * list, a per-file diff count, a delegate sub-agent's token/cost usage. A
 * field can be missing because an older kernel build never sent it, because a
 * file could not be honestly diffed, or because a bridge message was dropped
 * mid-run. In all of those cases the right answer is to say so — "counts
 * unavailable", an empty string, an honest "at least N" — never a fabricated
 * 0 or empty-looking success. Every function below is pure, synchronous, and
 * defensive about its input shape so a malformed event can never throw out of
 * a render path.
 */
import type { ToolCallState, ToolStatus } from "./toolState.js";
import { sanitizeToolText } from "./toolOutput.js";
import { truncateToWidth } from "./textWidth.js";

// ---------------------------------------------------------------------------
// Expandable tool output: collapsed / expanded / fully-expanded, with
// scrolling inside the expanded state.
// ---------------------------------------------------------------------------

export type ToolOutputExpansionMode = "collapsed" | "expanded" | "full";

export interface ToolOutputExpansionState {
  mode: ToolOutputExpansionMode;
  /** First visible line while `mode` is "expanded"; ignored (and reset) otherwise. */
  scrollLine: number;
}

export const COLLAPSED_TOOL_OUTPUT: Readonly<ToolOutputExpansionState> = Object.freeze({
  mode: "collapsed",
  scrollLine: 0,
});

export interface ToolOutputExpansionOptions {
  /** Lines shown while collapsed. Defaults to 4, matching ToolCard's default preview. */
  collapsedLines?: number;
  /** Terminal columns each visible line is wrapped to. */
  maxColumns?: number;
  /** Hard cap, in characters, on how much of a huge result is ever scanned. */
  scanLimit?: number;
}

export interface ToolOutputWindow {
  mode: ToolOutputExpansionMode;
  /** The visible slice, already redacted and width-clipped — safe to print as-is. */
  lines: string[];
  /** Index of `lines[0]` within the full output (0 when nothing is scrolled past). */
  startLine: number;
  /** Line count within the scanned window; a LOWER BOUND when totalLinesKnown is false. */
  totalLines: number;
  totalLinesKnown: boolean;
  hiddenAbove: number;
  hiddenBelow: number;
  /** Honest "N more lines" summary; "" only when there is truly nothing more to see. */
  moreIndicator: string;
  /** Whether collapsing→expanding would reveal anything (used to decide whether an "e" hint is shown at all). */
  canExpand: boolean;
  canScrollUp: boolean;
  canScrollDown: boolean;
}

const DEFAULT_COLLAPSED_LINES = 4;
const DEFAULT_MAX_COLUMNS = 180;
const DEFAULT_SCAN_LIMIT = 512 * 1024;

function describeHiddenLines(hiddenBelow: number, totalLinesKnown: boolean): string {
  if (hiddenBelow > 0) {
    const prefix = totalLinesKnown ? "" : "at least ";
    return `${prefix}${hiddenBelow} more line${hiddenBelow === 1 ? "" : "s"} below`;
  }
  // The scan hit its hard cap exactly at a line boundary: hiddenBelow reads as
  // 0 (nothing left in the window we scanned) but there is unscanned raw text
  // past that cap. Saying nothing here would read as "that's everything",
  // which is exactly the false completeness this module exists to avoid.
  if (!totalLinesKnown) return "more output not shown (exceeds scan limit)";
  return "";
}

/**
 * Window a tool result's output for display, honestly, at any expansion mode.
 *
 * Sanitization/redaction is delegated to toolOutput.ts's sanitizeToolText so
 * an expanded view redacts secrets exactly like the collapsed preview does —
 * "expand" must never be a way to see something the collapsed card hid on
 * purpose. Only the windowing/scrolling here is new.
 */
export function expandToolOutput(
  output: unknown,
  viewportLines: number,
  state: ToolOutputExpansionState = COLLAPSED_TOOL_OUTPUT,
  options: ToolOutputExpansionOptions = {},
): ToolOutputWindow {
  const mode: ToolOutputExpansionMode =
    state && (state.mode === "expanded" || state.mode === "full") ? state.mode : "collapsed";
  const scanLimit = Math.max(1_024, Math.floor(options.scanLimit ?? DEFAULT_SCAN_LIMIT) || DEFAULT_SCAN_LIMIT);
  const maxColumns = Math.max(8, Math.floor(options.maxColumns ?? DEFAULT_MAX_COLUMNS) || DEFAULT_MAX_COLUMNS);
  const collapsedLines = Math.max(
    1,
    Math.floor(options.collapsedLines ?? DEFAULT_COLLAPSED_LINES) || DEFAULT_COLLAPSED_LINES,
  );
  const viewport = Math.max(1, Math.floor(viewportLines) || 1);

  const raw = output === undefined || output === null ? "" : String(output);
  if (!raw) {
    return {
      mode,
      lines: [],
      startLine: 0,
      totalLines: 0,
      totalLinesKnown: true,
      hiddenAbove: 0,
      hiddenBelow: 0,
      moreIndicator: "",
      canExpand: false,
      canScrollUp: false,
      canScrollDown: false,
    };
  }

  const safe = sanitizeToolText(raw, true, scanLimit);
  const allLines = safe.split("\n");
  const totalLinesKnown = raw.length <= scanLimit;
  const totalLines = allLines.length;

  const windowSize = mode === "collapsed" ? collapsedLines : mode === "full" ? totalLines : viewport;
  const maxStart = Math.max(0, totalLines - windowSize);
  const requestedStart =
    mode === "expanded" && Number.isFinite(state?.scrollLine) ? Math.max(0, Math.floor(state.scrollLine)) : 0;
  const startLine = Math.min(requestedStart, maxStart);
  const endLine = Math.min(totalLines, startLine + windowSize);

  const lines = allLines.slice(startLine, endLine).map((line) => truncateToWidth(line, maxColumns));
  const hiddenAbove = startLine;
  const hiddenBelow = Math.max(0, totalLines - endLine);

  return {
    mode,
    lines,
    startLine,
    totalLines,
    totalLinesKnown,
    hiddenAbove,
    hiddenBelow,
    moreIndicator: describeHiddenLines(hiddenBelow, totalLinesKnown),
    canExpand: mode === "collapsed" && (hiddenBelow > 0 || !totalLinesKnown),
    canScrollUp: mode === "expanded" && startLine > 0,
    canScrollDown: mode === "expanded" && (endLine < totalLines || !totalLinesKnown),
  };
}

export type ToolOutputExpansionAction =
  | { kind: "cycle" }
  | { kind: "collapse" }
  | { kind: "expand" }
  | { kind: "full" }
  | { kind: "scroll"; deltaLines: number };

/**
 * Pure state transition for an "e"/click handler and scroll keys.
 *
 * `cycle` walks collapsed → expanded → full → collapsed, matching the single
 * key most terminal UIs bind for "show me more". Scrolling is only meaningful
 * in "expanded" (in "full" everything is already visible, in "collapsed"
 * there is no scroll position to remember), so a scroll action received in
 * either of those resets to the top rather than silently doing nothing.
 */
export function applyToolOutputExpansionAction(
  state: ToolOutputExpansionState,
  action: ToolOutputExpansionAction,
): ToolOutputExpansionState {
  const mode: ToolOutputExpansionMode =
    state && (state.mode === "expanded" || state.mode === "full") ? state.mode : "collapsed";
  const scrollLine = state && Number.isFinite(state.scrollLine) ? Math.max(0, Math.floor(state.scrollLine)) : 0;
  const kind = action && typeof action === "object" ? action.kind : undefined;

  switch (kind) {
    case "collapse":
      return { mode: "collapsed", scrollLine: 0 };
    case "expand":
      return { mode: "expanded", scrollLine: mode === "expanded" ? scrollLine : 0 };
    case "full":
      return { mode: "full", scrollLine: 0 };
    case "scroll": {
      if (mode !== "expanded") return { mode, scrollLine: 0 };
      const delta = action && Number.isFinite((action as { deltaLines: number }).deltaLines)
        ? Math.floor((action as { deltaLines: number }).deltaLines)
        : 0;
      return { mode, scrollLine: Math.max(0, scrollLine + delta) };
    }
    case "cycle":
    default:
      if (mode === "collapsed") return { mode: "expanded", scrollLine: 0 };
      if (mode === "expanded") return { mode: "full", scrollLine: 0 };
      return { mode: "collapsed", scrollLine: 0 };
  }
}

// ---------------------------------------------------------------------------
// Per-turn file-change summary.
// ---------------------------------------------------------------------------

export interface FileChangeCount {
  added: number;
  removed: number;
}

export interface FileChangeEntry {
  path: string;
  /** Absent when the kernel could not honestly diff this file — see agent/code_bridge.py's _file_change_counts. */
  counts?: FileChangeCount;
}

export interface FileChangeSummary {
  fileCount: number;
  /** Per-file breakdown, capped at MAX_SUMMARIZED_FILES entries. */
  files: FileChangeEntry[];
  /** How many touched files were dropped past the display cap; 0 when nothing was cut. */
  omittedFiles: number;
  /** Sum of added/removed over files with known counts; absent when NONE of them are known. */
  totals?: FileChangeCount;
  /** True when at least one listed file's counts are unknown — totals above are a partial picture. */
  partialCounts: boolean;
  /** True when NO touched file has a known count, a distinct state from "0 lines changed". */
  countsUnavailable: boolean;
  /** "3 files changed · +42 -7", "3 files changed · counts unavailable", or "" when nothing was touched. */
  headline: string;
}

const MAX_SUMMARIZED_FILES = 500;

function safePath(value: unknown, limit = 1_024): string {
  return sanitizeToolText(value, false, limit).trim();
}

function nonNegativeInt(value: unknown): number | undefined {
  // `Number(null)` is 0, not NaN — without this guard a genuinely-missing
  // field would silently become the fabricated zero this module exists to
  // avoid, rather than the "counts unavailable" state it should produce.
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/**
 * A half-known count ("+3" with no removed figure) is not trustworthy enough
 * to show: defaulting the missing half to 0 would be exactly the fabricated
 * zero this module exists to avoid, so a partial pair is treated as unknown.
 */
function extractFileChangeCount(value: unknown): FileChangeCount | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const added = nonNegativeInt(row.added ?? row.insertions ?? row.linesAdded ?? row.lines_added ?? row.plus);
  const removed = nonNegativeInt(row.removed ?? row.deletions ?? row.linesRemoved ?? row.lines_removed ?? row.minus);
  if (added === undefined || removed === undefined) return undefined;
  return { added, removed };
}

function normalizeFilesTouched(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const path =
      typeof item === "string"
        ? safePath(item)
        : item && typeof item === "object"
          ? safePath((item as Record<string, unknown>).path ?? (item as Record<string, unknown>).file)
          : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function normalizeFileChangesMap(value: unknown): Map<string, FileChangeCount> {
  const out = new Map<string, FileChangeCount>();
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const path = safePath(row.path ?? row.file ?? row.filePath ?? row.file_path);
      if (!path) continue;
      const counts = extractFileChangeCount(row);
      if (counts) out.set(path, counts);
    }
    return out;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const path = safePath(key);
    if (!path) continue;
    const counts = extractFileChangeCount(raw);
    if (counts) out.set(path, counts);
  }
  return out;
}

/**
 * Fold a run's filesTouched list plus optional per-file line counts into one
 * summary line and a per-file breakdown. Tolerates every shape the kernel
 * might (or might not, on an older build) send: a bare path array, an
 * object-keyed or array-of-rows counts map, snake_case or camelCase count
 * keys, and either input being absent entirely.
 */
export function summarizeFileChanges(filesTouched: unknown, fileChanges?: unknown): FileChangeSummary {
  const paths = normalizeFilesTouched(filesTouched);
  const countsByPath = normalizeFileChangesMap(fileChanges);
  const fileCount = paths.length;
  const shown = paths.slice(0, MAX_SUMMARIZED_FILES);
  const omittedFiles = fileCount - shown.length;

  const files: FileChangeEntry[] = shown.map((path) => {
    const counts = countsByPath.get(path);
    return counts ? { path, counts } : { path };
  });

  let knownFiles = 0;
  const totals: FileChangeCount = { added: 0, removed: 0 };
  for (const entry of files) {
    if (!entry.counts) continue;
    knownFiles += 1;
    totals.added += entry.counts.added;
    totals.removed += entry.counts.removed;
  }
  const hasTotals = knownFiles > 0;
  const countsUnavailable = fileCount > 0 && !hasTotals;
  const partialCounts = hasTotals && (knownFiles < files.length || omittedFiles > 0);

  const base = fileCount === 0 ? "" : `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
  const headline =
    fileCount === 0
      ? ""
      : countsUnavailable
        ? `${base} · counts unavailable`
        : `${base} · +${totals.added} -${totals.removed}${partialCounts ? " (partial)" : ""}`;

  return {
    fileCount,
    files,
    omittedFiles,
    ...(hasTotals ? { totals } : {}),
    partialCounts,
    countsUnavailable,
    headline,
  };
}

/** One width-safe display row for a file-change breakdown list. */
export function formatFileChangeEntry(entry: FileChangeEntry, maxColumns = 120): string {
  const suffix = entry.counts ? ` +${entry.counts.added} -${entry.counts.removed}` : " counts unavailable";
  return truncateToWidth(`${safePath(entry.path)}${suffix}`, Math.max(8, maxColumns));
}

// ---------------------------------------------------------------------------
// Per-call cost/token formatting.
// ---------------------------------------------------------------------------

export interface ToolCallUsage {
  tokens?: number;
  costUsd?: number;
}

function financeNumber(value: unknown): number | undefined {
  // Same `Number(null) === 0` trap as nonNegativeInt above: a null/undefined
  // token or cost figure means "the kernel did not send this", not "$0".
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Tolerant extraction across the naming variants a delegate/tool_result event might use. */
export function extractToolCallUsage(source: unknown): ToolCallUsage {
  const row = source && typeof source === "object" && !Array.isArray(source) ? (source as Record<string, unknown>) : {};
  const tokens = financeNumber(row.tokens ?? row.tokenCount ?? row.token_count ?? row.totalTokens ?? row.total_tokens);
  const costUsd = financeNumber(row.costUsd ?? row.cost_usd ?? row.cost);
  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** "$0.0034" for sub-cent costs, "$1.23" otherwise; "" when the figure is absent (not a real $0). */
export function formatToolCallCostUsd(costUsd: unknown): string {
  const value = financeNumber(costUsd);
  if (value === undefined) return "";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** "1,234 tok"; "" when the figure is absent (not a real 0-token call). */
export function formatToolCallTokens(tokens: unknown): string {
  const value = financeNumber(tokens);
  if (value === undefined) return "";
  return `${Math.round(value).toLocaleString("en-US")} tok`;
}

/**
 * Combine tokens + cost for one tool call, omitting whichever half is
 * missing instead of printing a placeholder 0 for it. Returns "" when
 * neither figure was supplied, so a caller can skip the row entirely rather
 * than render an empty-looking cost chip.
 */
export function formatToolCallUsage(source: unknown): string {
  const usage = extractToolCallUsage(source);
  const parts: string[] = [];
  if (usage.tokens !== undefined) parts.push(formatToolCallTokens(usage.tokens));
  if (usage.costUsd !== undefined) parts.push(formatToolCallCostUsd(usage.costUsd));
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Stable ordering/grouping of tool calls for display.
// ---------------------------------------------------------------------------

export interface ToolCallDisplayGroup {
  name: string;
  calls: ToolCallState[];
  succeeded: number;
  failed: number;
  pending: number;
}

const TERMINAL_FAILURE_STATUSES: ReadonlySet<ToolStatus> = new Set(["failed", "denied", "cancelled"]);

/**
 * A deterministic order for a set of tool calls, independent of the order
 * their call/result bridge events actually arrived in.
 *
 * Parallel tool calls can resolve out of dispatch order (a fast `read` can
 * finish after a slow `bash` started earlier but reports later), and a
 * re-render mid-stream must not let the list visibly reshuffle every time an
 * event lands. Sorting by startedAt (missing timestamps sort last, not
 * first — an unknown start time is not evidence of an early start) with
 * name/id/original-index tie-breaks gives every render of the same call set
 * the same order.
 */
export function sortToolCallsForDisplay(calls: readonly ToolCallState[] | null | undefined): ToolCallState[] {
  const rows = Array.isArray(calls)
    ? calls
      .map((call, index) => ({ call, index }))
      .filter((row): row is { call: ToolCallState; index: number } => !!row.call && typeof row.call === "object")
    : [];
  rows.sort((a, b) => {
    const at = Number.isFinite(a.call.startedAt) ? (a.call.startedAt as number) : Number.POSITIVE_INFINITY;
    const bt = Number.isFinite(b.call.startedAt) ? (b.call.startedAt as number) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    const nameCompare = String(a.call.name ?? "").localeCompare(String(b.call.name ?? ""));
    if (nameCompare !== 0) return nameCompare;
    const idCompare = String(a.call.stableId ?? "").localeCompare(String(b.call.stableId ?? ""));
    if (idCompare !== 0) return idCompare;
    return a.index - b.index;
  });
  return rows.map((row) => row.call);
}

/**
 * Group calls by tool name, in the display order above, for a compact
 * rollup ("Read x5, Bash x2 (1 failed)") instead of one row per call.
 */
export function groupToolCallsByName(calls: readonly ToolCallState[] | null | undefined): ToolCallDisplayGroup[] {
  const ordered = sortToolCallsForDisplay(calls);
  const groups = new Map<string, ToolCallDisplayGroup>();
  const order: string[] = [];
  for (const call of ordered) {
    const name = String(call.name ?? "").trim() || "(unknown tool)";
    let group = groups.get(name);
    if (!group) {
      group = { name, calls: [], succeeded: 0, failed: 0, pending: 0 };
      groups.set(name, group);
      order.push(name);
    }
    group.calls.push(call);
    if (call.status === "succeeded") group.succeeded += 1;
    else if (TERMINAL_FAILURE_STATUSES.has(call.status)) group.failed += 1;
    else group.pending += 1;
  }
  return order.map((name) => groups.get(name) as ToolCallDisplayGroup);
}
