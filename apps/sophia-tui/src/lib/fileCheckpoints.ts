/**
 * Pure projection layer for per-file edit backups (see agent/edit_backup.py's
 * design: before an approved write_file/edit_file mutates a file, the kernel
 * copies its prior bytes into a per-session backup store and records
 * {path, backupPath, ts} on that tool's tool_result event).
 *
 * This module never touches disk or the bridge socket. It only folds whatever
 * raw entries a caller already collected from the event stream into display
 * rows, run/turn groupings, and a two-step restore-intent model. Keeping it
 * pure means the fold logic — which file goes under which run, how "created"
 * differs from "modified", what counts as a valid two-step confirm — is
 * exercised by ordinary unit tests instead of only ever being exercised live,
 * against a real kernel, the day someone actually clicks restore.
 */
import path from "node:path";

/**
 * One raw per-file backup record as it would cross the bridge on a
 * tool_result payload. Every field is `unknown` and optional: an older kernel
 * build, a plugin tool that never adopted backups, or a still-in-flight event
 * from a future kernel revision can all send a tool_result with none of this,
 * and folding the run's events must degrade to "nothing to show" rather than
 * throw partway through a resume.
 */
export interface RawFileCheckpointEvent {
  /** Absolute path of the file the tool call mutated. */
  path?: unknown;
  /**
   * Absolute path of the pre-write backup copy, if one was made. Absent when
   * the file did not exist before this write — there was nothing to snapshot.
   */
  backupPath?: unknown;
  /** Kernel-supplied write time: an ISO-8601 string or epoch milliseconds. */
  ts?: unknown;
  /** Tool that performed the write (write_file / edit_file / …). */
  tool?: unknown;
  /**
   * Run/turn attribution. A bare tool_result payload has no notion of "which
   * run" on its own — the caller folding the event stream attaches these from
   * the surrounding run_start/turn context before handing the entry here.
   */
  runId?: unknown;
  turn?: unknown;
}

export type FileCheckpointKind = "modified" | "created";

export interface FileCheckpointEntry {
  /**
   * Derived only from the entry's own fields (run, turn, timestamp, path) —
   * no random or clock component. The same underlying kernel event always
   * folds to the same id, so replaying a resumed session's event log twice
   * (or reconciling a live stream against a reloaded one) never double-counts
   * a row under a different identity.
   */
  id: string;
  /** Absolute path exactly as reported by the kernel. */
  path: string;
  /**
   * Path relative to the workspace root when the file falls under it;
   * otherwise the absolute path, unchanged. A file outside the workspace
   * (e.g. a global config an approved tool call touched) must never be
   * silently relabeled as if it lived inside the project.
   */
  displayPath: string;
  backupPath: string;
  kind: FileCheckpointKind;
  tool: string;
  /** Epoch milliseconds; 0 when the kernel omitted ts or sent something unparsable. */
  ts: number;
  /** "" when the caller did not attach a run id. */
  runId: string;
  turn: number | null;
}

export interface NormalizeFileCheckpointOptions {
  /** Workspace root used only to shorten displayPath — never to drop entries. */
  workspaceRoot?: string;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asTurnNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/** Accepts either an ISO-8601 string or epoch milliseconds; 0 on anything else. */
function parseCheckpointTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const iso = Date.parse(value);
    if (Number.isFinite(iso)) return iso;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function toDisplayPath(workspaceRoot: string, absolutePath: string): string {
  if (!workspaceRoot) return absolutePath;
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(absolutePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return absolutePath;
  return relative.split(path.sep).join("/");
}

/** Fold one raw kernel event into a display-ready entry, or null if unusable. */
export function normalizeFileCheckpointEntry(
  raw: RawFileCheckpointEvent | null | undefined,
  options: NormalizeFileCheckpointOptions = {},
): FileCheckpointEntry | null {
  const filePath = asTrimmedString(raw?.path);
  // Without a path there is nothing to show a row for and nothing to restore
  // — this is the one field that must be present, everything else degrades.
  if (!filePath) return null;
  const backupPath = asTrimmedString(raw?.backupPath);
  const runId = asTrimmedString(raw?.runId);
  const turn = asTurnNumber(raw?.turn);
  const ts = parseCheckpointTimestamp(raw?.ts);
  const toolName = asTrimmedString(raw?.tool) || "edit";
  return {
    id: `${runId || "run"}#${turn ?? "-"}#${ts}#${filePath}`,
    path: filePath,
    displayPath: toDisplayPath(options.workspaceRoot ? String(options.workspaceRoot) : "", filePath),
    backupPath,
    // No backup means nothing existed to snapshot before this write: the file
    // was created by this call, not edited. Restoring a "created" row would
    // mean deleting the file entirely, which is a different (and more
    // destructive) operation than byte-for-byte restore — armFileRestore
    // below refuses it rather than silently reinterpreting "restore" as
    // "delete".
    kind: backupPath ? "modified" : "created",
    tool: toolName,
    ts,
    runId,
    turn,
  };
}

export function normalizeFileCheckpointEntries(
  raws: readonly (RawFileCheckpointEvent | null | undefined)[],
  options: NormalizeFileCheckpointOptions = {},
): FileCheckpointEntry[] {
  const out: FileCheckpointEntry[] = [];
  for (const raw of raws) {
    const entry = normalizeFileCheckpointEntry(raw, options);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * "5m ago" style age string for a checkpoint's write time.
 *
 * Deliberately NOT shared with sessionStore.ts's relativeTime (same shape,
 * different module): this file must stay import-free of sessionStore.ts,
 * which the checkpoint-restore wiring work edits concurrently, and the
 * algorithm is small enough to own outright rather than risk a signature
 * drifting out from under this module mid-flight.
 */
export function formatCheckpointAge(ts: number, now: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "unknown time";
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface FileCheckpointRow {
  id: string;
  /** Workspace-relative when possible; see FileCheckpointEntry.displayPath. */
  path: string;
  kind: FileCheckpointKind;
  age: string;
  ts: number;
  runId: string;
  turn: number | null;
  /** False for a "created" row — there is no prior-bytes backup to restore. */
  restorable: boolean;
  backupPath: string;
}

export function fileCheckpointRow(entry: FileCheckpointEntry, now: number): FileCheckpointRow {
  return {
    id: entry.id,
    path: entry.displayPath,
    kind: entry.kind,
    age: formatCheckpointAge(entry.ts, now),
    ts: entry.ts,
    runId: entry.runId,
    turn: entry.turn,
    restorable: entry.kind === "modified" && entry.backupPath.length > 0,
    backupPath: entry.backupPath,
  };
}

/** e.g. "3 files changed (2 modified, 1 created)". Never blank for a non-empty row list. */
export function turnCheckpointSummary(rows: readonly FileCheckpointRow[]): string {
  if (!rows.length) return "no file changes recorded";
  const modified = rows.filter((row) => row.kind === "modified").length;
  const created = rows.filter((row) => row.kind === "created").length;
  const parts: string[] = [];
  if (modified) parts.push(`${modified} modified`);
  if (created) parts.push(`${created} created`);
  const noun = rows.length === 1 ? "file" : "files";
  return `${rows.length} ${noun} changed (${parts.join(", ")})`;
}

export interface FileCheckpointTurnGroup {
  turn: number | null;
  rows: FileCheckpointRow[];
  summary: string;
}

export interface FileCheckpointRunGroup {
  /** "" for entries the caller never attached a run id to. */
  runId: string;
  turns: FileCheckpointTurnGroup[];
}

/**
 * Group entries by run, then by turn within the run. Runs are ordered most
 * recently touched first; turns within a run ascend (turn order tells the
 * story of what happened, oldest to newest); rows within a turn are newest
 * edit first, matching /undo's last-in-first-restored order — the edit an
 * operator is most likely to want to inspect or undo is the one they just
 * watched happen, not the first one from three tool calls ago.
 */
export function groupFileCheckpointsByRun(
  entries: readonly FileCheckpointEntry[],
  now: number,
): FileCheckpointRunGroup[] {
  const byRun = new Map<string, FileCheckpointEntry[]>();
  for (const entry of entries) {
    const key = entry.runId;
    const bucket = byRun.get(key);
    if (bucket) bucket.push(entry);
    else byRun.set(key, [entry]);
  }
  const runs: Array<FileCheckpointRunGroup & { maxTs: number }> = [];
  for (const [runId, runEntries] of byRun) {
    const byTurn = new Map<number | null, FileCheckpointEntry[]>();
    let maxTs = 0;
    for (const entry of runEntries) {
      maxTs = Math.max(maxTs, entry.ts);
      const bucket = byTurn.get(entry.turn);
      if (bucket) bucket.push(entry);
      else byTurn.set(entry.turn, [entry]);
    }
    const turns: FileCheckpointTurnGroup[] = [...byTurn.entries()]
      .sort(([a], [b]) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER))
      .map(([turn, turnEntries]) => {
        const rows = turnEntries
          .slice()
          .sort((a, b) => b.ts - a.ts)
          .map((entry) => fileCheckpointRow(entry, now));
        return { turn, rows, summary: turnCheckpointSummary(rows) };
      });
    runs.push({ runId, turns, maxTs });
  }
  runs.sort((a, b) => b.maxTs - a.maxTs || a.runId.localeCompare(b.runId));
  return runs.map(({ runId, turns }) => ({ runId, turns }));
}

// ---------------------------------------------------------------------------
// Destructive-restore confirmation model.
//
// Restoring overwrites whatever the file currently holds — there is no undo
// for THAT overwrite from inside this module (the kernel takes its own backup
// of the pre-restore bytes, but from here the operator's intent is a one-way
// door). A single restoreFile(id) call would let one accidental keypress or
// one stale callback fire it; every other destructive action in this app
// (PermissionDialog, /undo's own approval gate) already forces an explicit
// second step, so this pure model mirrors that shape instead of inventing a
// weaker one just because it lives at the bottom of the stack.

export type FileRestoreStage = "armed" | "confirmed";

export interface FileRestoreIntent {
  stage: FileRestoreStage;
  entryId: string;
  path: string;
  backupPath: string;
}

export type FileRestoreIntentResult =
  | { ok: true; intent: FileRestoreIntent }
  | { ok: false; reason: string };

/** Step 1: arm a restore for exactly one row. */
export function armFileRestore(
  row: Pick<FileCheckpointRow, "id" | "path" | "kind" | "backupPath">,
): FileRestoreIntentResult {
  if (row.kind !== "modified" || !row.backupPath) {
    return {
      ok: false,
      reason: "nothing to restore — this row created the file, it never had prior bytes",
    };
  }
  return {
    ok: true,
    intent: { stage: "armed", entryId: row.id, path: row.path, backupPath: row.backupPath },
  };
}

/**
 * Step 2: confirm. The caller must re-assert the SAME entry id it armed. If
 * the visible list reloaded or re-sorted between "restore this row" and the
 * operator's confirm keypress, a confirm that trusted the intent alone would
 * silently restore whatever backupPath is in the (possibly stale) intent
 * object onto a file the operator never actually looked at again — checking
 * identity here is what turns that into a rejected confirm instead of a
 * silent wrong-file restore. A second confirm on an already-confirmed intent
 * is rejected too, so one intent object can only ever fire once.
 */
export function confirmFileRestore(intent: FileRestoreIntent, entryId: string): FileRestoreIntentResult {
  if (intent.stage !== "armed") {
    return { ok: false, reason: "restore was already confirmed or was never armed" };
  }
  if (intent.entryId !== entryId) {
    return { ok: false, reason: "confirmed a different file than the one that was armed" };
  }
  return { ok: true, intent: { ...intent, stage: "confirmed" } };
}
