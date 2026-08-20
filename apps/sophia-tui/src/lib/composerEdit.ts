/**
 * Pure composer editing engine: coalesced-chunk application, kill ring/yank,
 * word motion, undo/redo, and width-aware line wrapping.
 *
 * composer.ts already owns the base editor state (`ComposerState`: text +
 * cursor + sticky preferred column) and its total per-keystroke reducer. This
 * module builds ON that reducer rather than re-deriving it — every action
 * composer.ts already knows how to apply (insert, newline, single-char
 * delete, line/document motion, line kill) is delegated straight to
 * `reduceComposer`. What lives here is strictly the layer composer.ts does
 * not cover:
 *
 *   - applying a whole terminal-read CHUNK as an ordered sequence of actions,
 *     each one folded onto the result of the previous one. A raw PTY read
 *     can coalesce several keystrokes (fast typing, SSH/tmux jitter, held
 *     Backspace/arrow) into a single JS callback. Reducing them against a
 *     shared starting snapshot instead of a running one is exactly how N
 *     backspaces collapse into deleting one character, or how interleaved
 *     inserts land in the wrong order — this module's `applyComposerEditOps`
 *     is written so that mistake is structurally impossible: it is a plain
 *     left fold, so operation K always sees operation K-1's output.
 *   - word motion and a kill ring (composer.ts deletes a killed line's text
 *     but never remembers it for a later yank).
 *   - undo/redo with typing coalesced into groups, taking an injected clock
 *     rather than reading one itself.
 *   - width-aware line wrapping with a resolved (row, col) cursor position,
 *     for callers that need to lay a document out across several terminal
 *     rows rather than composer.ts's single-active-line viewport window.
 *
 * The interactive reverse-search state machine (incremental query, ordered
 * matches, cycling, accept/cancel) already exists, fully pure and already
 * exercised, as `ReverseSearchState` in keybindings.ts — it is re-exported
 * from here rather than re-implemented, so this module is a single place a
 * caller can import the whole composer-editing surface from.
 */
import {
  type ComposerAction,
  type ComposerState,
  composerCursorLocation,
  createComposerState,
  normalizeComposerText,
  reduceComposer,
} from "./composer.js";
import { graphemeWidth, graphemes } from "./textWidth.js";
import {
  type ReverseSearchState,
  acceptReverseSearch,
  beginReverseSearch,
  cancelReverseSearch,
  currentReverseSearchMatch,
  reverseSearchMatches,
  stepReverseSearch,
  updateReverseSearch,
} from "./keybindings.js";

export type {
  ComposerAction,
  ComposerState,
  ReverseSearchState,
};
export {
  acceptReverseSearch,
  beginReverseSearch,
  cancelReverseSearch,
  currentReverseSearchMatch,
  reverseSearchMatches,
  stepReverseSearch,
  updateReverseSearch,
};

/**
 * Every action composer.ts's `ComposerAction` does not already cover:
 * forward word deletion, word motion (composer.ts only exposes the
 * backward-deleting boundary scan, inlined into `delete-word-backward`),
 * and yanking the most recently killed text back in.
 */
export type ComposerEditOp =
  | ComposerAction
  | { type: "delete-word-forward" }
  | { type: "move-word-left" }
  | { type: "move-word-right" }
  | { type: "yank" };

/** `ComposerState` plus the kill ring that composer.ts has no concept of. */
export interface ComposerEditState extends ComposerState {
  /** Most-recently-killed text first. Empty until the first line kill. */
  readonly killRing: readonly string[];
}

const MAX_KILL_RING_ENTRIES = 16;

export function createComposerEditState(text = "", cursor?: number): ComposerEditState {
  return { ...createComposerState(text, cursor), killRing: [] };
}

function withKillRing(state: ComposerState, killRing: readonly string[]): ComposerEditState {
  return { ...state, killRing };
}

function pushKill(ring: readonly string[], text: string): readonly string[] {
  if (!text) return ring; // Nothing was actually killed (e.g. already at line start).
  return [text, ...ring].slice(0, MAX_KILL_RING_ENTRIES);
}

/**
 * Shared word-boundary scan: skip any run of whitespace adjacent to `from`,
 * then skip the run of non-whitespace beyond it. Mirrors composer.ts's
 * inlined `delete-word-backward` boundary exactly, so a word-motion press and
 * a word-delete press agree on where a "word" starts and ends — including for
 * CJK text, which has no internal whitespace and is therefore ONE word by
 * this rule, same as composer.ts's existing behavior.
 */
function wordBoundaryLeft(units: readonly string[], from: number): number {
  let start = from;
  while (start > 0 && /\s/u.test(units[start - 1])) start -= 1;
  while (start > 0 && !/\s/u.test(units[start - 1])) start -= 1;
  return start;
}

function wordBoundaryRight(units: readonly string[], from: number): number {
  const n = units.length;
  let end = from;
  while (end < n && /\s/u.test(units[end])) end += 1;
  while (end < n && !/\s/u.test(units[end])) end += 1;
  return end;
}

/**
 * Apply a single composer edit operation. Total: every op resolves to a
 * valid state for any text/cursor/killRing input, including an empty buffer
 * or a cursor already at either extreme.
 */
export function applyComposerEditOp(state: ComposerEditState, op: ComposerEditOp): ComposerEditState {
  switch (op.type) {
    case "delete-word-forward": {
      const units = graphemes(state.text);
      const cursor = Math.max(0, Math.min(state.cursor, units.length));
      const end = wordBoundaryRight(units, cursor);
      const text = units.slice(0, cursor).concat(units.slice(end)).join("");
      return withKillRing({ text, cursor, preferredColumn: null }, state.killRing);
    }
    case "move-word-left": {
      const units = graphemes(state.text);
      const cursor = Math.max(0, Math.min(state.cursor, units.length));
      return withKillRing(
        { text: state.text, cursor: wordBoundaryLeft(units, cursor), preferredColumn: null },
        state.killRing,
      );
    }
    case "move-word-right": {
      const units = graphemes(state.text);
      const cursor = Math.max(0, Math.min(state.cursor, units.length));
      return withKillRing(
        { text: state.text, cursor: wordBoundaryRight(units, cursor), preferredColumn: null },
        state.killRing,
      );
    }
    case "yank": {
      const [latest] = state.killRing;
      if (!latest) return state; // Total: yanking an empty ring is a no-op, never a throw.
      const next = reduceComposer(state, { type: "insert", text: latest });
      return withKillRing(next, state.killRing);
    }
    case "kill-line-start": {
      const units = graphemes(state.text);
      const cursor = Math.max(0, Math.min(state.cursor, units.length));
      const { lineStart } = composerCursorLocation({ text: state.text, cursor });
      const killed = units.slice(lineStart, cursor).join("");
      const next = reduceComposer(state, op);
      return withKillRing(next, pushKill(state.killRing, killed));
    }
    case "kill-line-end": {
      const units = graphemes(state.text);
      const cursor = Math.max(0, Math.min(state.cursor, units.length));
      const { lineEnd } = composerCursorLocation({ text: state.text, cursor });
      const killed = units.slice(cursor, lineEnd).join("");
      const next = reduceComposer(state, op);
      return withKillRing(next, pushKill(state.killRing, killed));
    }
    default:
      return withKillRing(reduceComposer(state, op), state.killRing);
  }
}

/**
 * Fold a whole terminal-read chunk's decoded operations onto the composer in
 * order — the fix for coalesced-keystroke corruption. `ops` is a LEFT fold:
 * operation K is applied to the state operation K-1 produced, never to the
 * snapshot the chunk started from. Nine backspaces therefore delete nine
 * characters; a mix of inserted text and control actions lands exactly as if
 * each had arrived in its own render tick, which coalesced PTY reads do not
 * guarantee.
 */
export function applyComposerEditOps(
  state: ComposerEditState,
  ops: readonly ComposerEditOp[],
): ComposerEditState {
  let next = state;
  for (const op of ops) next = applyComposerEditOp(next, op);
  return next;
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

export interface ComposerUndoSnapshot {
  text: string;
  cursor: number;
}

export interface ComposerUndoHistory {
  /** Oldest first; last entry is the state to restore on the next undo. */
  past: readonly ComposerUndoSnapshot[];
  /** Most-recently-undone first; last entry is the state to restore on redo. */
  future: readonly ComposerUndoSnapshot[];
  /** In-flight coalescing group's op key, or null between groups. */
  groupKey: string | null;
  /** Clock time (caller-supplied) the in-flight group last absorbed an edit. */
  groupAt: number | null;
}

export const EMPTY_COMPOSER_UNDO_HISTORY: ComposerUndoHistory = {
  past: [],
  future: [],
  groupKey: null,
  groupAt: null,
};

const MAX_UNDO_ENTRIES = 200;
const UNDO_COALESCE_WINDOW_MS = 500;

/** Ops that never merge with a neighbor: each always starts its own group. */
const MUTATING_OP_TYPES: ReadonlySet<string> = new Set([
  "replace",
  "insert",
  "newline",
  "delete-backward",
  "delete-forward",
  "delete-word-backward",
  "delete-word-forward",
  "kill-line-start",
  "kill-line-end",
  "yank",
]);

/**
 * Only a single-grapheme insert or a single-char delete coalesces with a
 * like-typed neighbor within the time window — a pasted block, a newline, a
 * word-kill, or a yank is always its own undo step, never silently folded
 * into whatever typing preceded it.
 */
function coalesceKey(op: ComposerEditOp): string | null {
  if (op.type === "delete-backward" || op.type === "delete-forward") return op.type;
  if (op.type === "insert" && graphemes(op.text).length === 1) return "insert-1";
  return null;
}

/**
 * Record an undo checkpoint for `before` — the state immediately preceding
 * `op` — coalescing into the in-flight group only when `op` is itself
 * coalescable, matches the group's op key, and arrives within the coalescing
 * window of the group's last absorbed edit.
 */
export function recordComposerUndoCheckpoint(
  history: ComposerUndoHistory,
  before: ComposerUndoSnapshot,
  op: ComposerEditOp,
  now: number,
): ComposerUndoHistory {
  const key = coalesceKey(op);
  if (key !== null && key === history.groupKey && history.groupAt !== null
    && now - history.groupAt <= UNDO_COALESCE_WINDOW_MS) {
    return { ...history, groupAt: now };
  }
  const past = history.past.concat([before]).slice(-MAX_UNDO_ENTRIES);
  return { past, future: [], groupKey: key, groupAt: key !== null ? now : null };
}

export interface ComposerEditSession {
  edit: ComposerEditState;
  undo: ComposerUndoHistory;
}

export function createComposerEditSession(text = "", cursor?: number): ComposerEditSession {
  return { edit: createComposerEditState(text, cursor), undo: EMPTY_COMPOSER_UNDO_HISTORY };
}

/**
 * Apply one op and update undo history in lockstep. Cursor-only motion never
 * creates a checkpoint (there is nothing to undo); a mutating op that turns
 * out to be a no-op (delete-backward at offset 0, yank with an empty ring)
 * likewise records nothing, so undo never "restores" the state already on
 * screen.
 */
export function applyTrackedComposerEditOp(
  session: ComposerEditSession,
  op: ComposerEditOp,
  now: number,
): ComposerEditSession {
  const before: ComposerUndoSnapshot = { text: session.edit.text, cursor: session.edit.cursor };
  const edit = applyComposerEditOp(session.edit, op);
  if (!MUTATING_OP_TYPES.has(op.type) || edit.text === before.text) {
    return { edit, undo: session.undo };
  }
  return { edit, undo: recordComposerUndoCheckpoint(session.undo, before, op, now) };
}

function restoreSnapshot(edit: ComposerEditState, snapshot: ComposerUndoSnapshot): ComposerEditState {
  return withKillRing(createComposerState(snapshot.text, snapshot.cursor), edit.killRing);
}

export function undoComposerEdit(session: ComposerEditSession): ComposerEditSession {
  const { past } = session.undo;
  if (past.length === 0) return session;
  const target = past[past.length - 1];
  const current: ComposerUndoSnapshot = { text: session.edit.text, cursor: session.edit.cursor };
  const future = session.undo.future.concat([current]).slice(-MAX_UNDO_ENTRIES);
  return {
    edit: restoreSnapshot(session.edit, target),
    undo: { past: past.slice(0, -1), future, groupKey: null, groupAt: null },
  };
}

export function redoComposerEdit(session: ComposerEditSession): ComposerEditSession {
  const { future } = session.undo;
  if (future.length === 0) return session;
  const target = future[future.length - 1];
  const current: ComposerUndoSnapshot = { text: session.edit.text, cursor: session.edit.cursor };
  const past = session.undo.past.concat([current]).slice(-MAX_UNDO_ENTRIES);
  return {
    edit: restoreSnapshot(session.edit, target),
    undo: { past, future: future.slice(0, -1), groupKey: null, groupAt: null },
  };
}

// ---------------------------------------------------------------------------
// Width-aware wrapped layout
// ---------------------------------------------------------------------------

export interface WrappedComposerRow {
  /** Absolute grapheme offset (into the full normalized text) this row starts at. */
  start: number;
  /** Absolute grapheme offset this row ends at, exclusive of any consumed newline. */
  end: number;
  text: string;
}

export interface WrappedComposerCursor {
  row: number;
  /** Grapheme column within the row. */
  column: number;
  /** Terminal display column within the row — wide graphemes count as two. */
  displayColumn: number;
}

export interface WrappedComposerLayout {
  rows: WrappedComposerRow[];
  cursor: WrappedComposerCursor;
}

/**
 * Soft-wrap `text` into rows of at most `width` terminal columns apiece and
 * resolve the cursor's (row, col) within that layout. Wrapping operates on
 * graphemes and measures with `graphemeWidth`, so a CJK/emoji cluster is
 * never split across rows and never desynchronises the reported cursor cell
 * the way counting one column per grapheme would.
 *
 * Unlike composer.ts's `composerViewport` — a single active line horizontally
 * windowed/scrolled to fit one row — this lays the WHOLE document out across
 * as many visual rows as it needs, for a caller that renders more than one
 * active line's width budget at a time.
 */
export function wrapComposerLines(text: string, cursor: number, width: number): WrappedComposerLayout {
  const normalized = normalizeComposerText(text);
  const units = graphemes(normalized);
  const caret = Math.max(0, Math.min(Math.trunc(cursor) || 0, units.length));
  const columns = Math.max(1, Math.trunc(width) || 1);

  const rows: WrappedComposerRow[] = [];
  let rowStart = 0;
  let used = 0;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit === "\n") {
      rows.push({ start: rowStart, end: i, text: units.slice(rowStart, i).join("") });
      rowStart = i + 1;
      used = 0;
      continue;
    }
    const width1 = graphemeWidth(unit);
    if (used > 0 && used + width1 > columns) {
      rows.push({ start: rowStart, end: i, text: units.slice(rowStart, i).join("") });
      rowStart = i;
      used = 0;
    }
    used += width1;
  }
  rows.push({ start: rowStart, end: units.length, text: units.slice(rowStart, units.length).join("") });

  // The caret sits "before" grapheme `caret`. When that offset is shared by
  // two adjacent rows (a width-wrapped boundary — the row that just filled
  // and the fresh row starting at the very same offset), prefer the LATER
  // row: that is the row the next typed character will actually land on. A
  // newline boundary never creates this ambiguity because consuming the `\n`
  // advances the next row's start past the caret offset by one.
  let rowIndex = 0;
  for (let r = 0; r < rows.length; r += 1) {
    if (rows[r].start <= caret && caret <= rows[r].end) rowIndex = r;
  }
  const row = rows[rowIndex];
  const column = caret - row.start;
  let displayColumn = 0;
  for (let i = row.start; i < caret; i += 1) displayColumn += graphemeWidth(units[i]);

  return { rows, cursor: { row: rowIndex, column, displayColumn } };
}
