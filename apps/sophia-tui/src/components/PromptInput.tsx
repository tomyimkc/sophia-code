import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { accessibleTheme } from "../lib/accessibility.js";
import {
  composerCursorLocation,
  composerViewport,
  createComposerState,
  shouldNavigateHistory,
  type ComposerState,
} from "../lib/composer.js";
import {
  EMPTY_COMPOSER_UNDO_HISTORY,
  acceptReverseSearch,
  applyTrackedComposerEditOp,
  beginReverseSearch,
  cancelReverseSearch,
  redoComposerEdit,
  stepReverseSearch,
  undoComposerEdit,
  updateReverseSearch,
  type ComposerEditOp,
  type ComposerEditSession,
  type ComposerEditState,
  type ComposerUndoHistory,
  type ReverseSearchState,
} from "../lib/composerEdit.js";
import {
  acceptGhostHint,
  selectGhostHint,
  type GhostHintCandidate,
} from "../lib/composerHints.js";
import {
  BracketedPasteDecoder,
  createPasteReview,
  disableBracketedPaste,
  enableBracketedPaste,
  inputRequiresPasteReview,
  type PasteReview,
} from "../lib/composerPaste.js";
import {
  keyChord,
  resolveKeyAction,
  type KeybindingAction,
  type KeymapConfig,
  type KeymapMode,
  type VimInputMode,
} from "../lib/keybindings.js";
import type { Theme } from "../lib/theme.js";
import { TerminalInputDecoder } from "../lib/mouse.js";
import {
  graphemes as segmentGraphemes,
  displayWidth as textDisplayWidth,
  truncateToWidth,
} from "../lib/textWidth.js";
import type { TerminalPlatform } from "../lib/terminalCapabilities.js";
import { sanitizeTerminalText as sanitizeSharedTerminalText } from "../lib/chatLayout.js";

/** Shared parser with the composer's historical strip-newlines default. */
export function sanitizeTerminalText(input: string, allowNewline = false): string {
  return sanitizeSharedTerminalText(input, allowNewline);
}

/**
 * Re-exported so existing importers (StatusLine, useTerminalSize) keep
 * their import path. The implementations moved to lib/textWidth.ts, where
 * displayWidth now counts terminal COLUMNS instead of one per grapheme — CJK,
 * kana, hangul, fullwidth forms and most emoji occupy two, so every field
 * budgeted with the old helper could overflow the row it was measured to fit.
 */
export const graphemes = segmentGraphemes;

export function displayWidth(value: string): number {
  return textDisplayWidth(sanitizeTerminalText(value));
}

/**
 * Ink coalesces readable stdin chunks: fast typing, or a paste, can arrive as
 * ONE data event. Bracketed paste is never enabled (neither Ink nor this app
 * writes `\x1b[?2004h`), so a genuine multi-line paste has no start/end
 * markers either — it is plain text with embedded newlines, indistinguishable
 * from "typed chars immediately followed by pressing Enter" except by what
 * follows the first newline. Only a chunk whose tail from the first newline
 * on is ITSELF all newline characters (a bare Enter, or a stray CRLF pair) is
 * a real Enter keystroke. Anything else after that first newline is more of
 * the paste and must be kept, not silently dropped mid-submit — pasting a
 * multi-line snippet used to submit only its first line and discard the rest.
 */
export function splitCoalescedInput(text: string): { literalText: string; isEnter: boolean } {
  const firstBreak = text.search(/[\r\n]/);
  const isEnter = firstBreak !== -1 && /^[\r\n]*$/.test(text.slice(firstBreak));
  return { literalText: isEnter ? text.slice(0, firstBreak) : text, isEnter };
}

/**
 * Whether an ArrowUp/ArrowDown keypress should drive prompt-history recall
 * here, as opposed to being left alone for a different handler to consume.
 * Shift+↑/↓ is App.tsx's global message-log scroll chord (both a plain
 * `useInput` and this component's `useInput` receive every keypress — Ink
 * fans raw stdin out to every mounted listener, it does not pick one "owner"
 * per key). Without this guard, trying to scroll the transcript while the
 * prompt box has focus also silently overwrote the draft with a recalled
 * history entry on every Shift+↑/↓ press.
 */
export function isHistoryNavKey(key: Pick<Key, "upArrow" | "downArrow" | "shift">): boolean {
  return (key.upArrow || key.downArrow) && !key.shift;
}

/**
 * Chords composer.ts's `ComposerAction` and keybindings.ts's
 * `KeybindingAction` have no vocabulary for: readline-style undo/redo and
 * word motion. These are resolved directly from the canonical chord string
 * here rather than folded into keybindings.ts's shared action enum —
 * composerEdit.ts's `ComposerEditOp` already models word motion/yank
 * precisely, and undo/redo are whole-session operations (they replace the
 * buffer from history, not derive a new one from it), not a single edit op,
 * hence the separate `kind` discriminant below.
 */
export type ChordShimAction =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "op"; op: ComposerEditOp };

export function resolveChordShimAction(
  chord: string,
  keymapMode: KeymapMode,
  vimMode: VimInputMode,
): ChordShimAction | null {
  if (chord === "ctrl+z") return { kind: "undo" };
  // Some terminals never surface the shift bit on a ctrl+letter chord (it is
  // encoded in the same control byte regardless of Shift), so this binding is
  // best-effort rather than universal — vim-normal's explicit undo-only (no
  // redo) key below is the reliable fallback in vim mode.
  if (chord === "ctrl+shift+z") return { kind: "redo" };
  if (chord === "ctrl+y") return { kind: "op", op: { type: "yank" } };
  if (chord === "alt+left" || chord === "alt+b") return { kind: "op", op: { type: "move-word-left" } };
  if (chord === "alt+right" || chord === "alt+f") return { kind: "op", op: { type: "move-word-right" } };
  if (keymapMode === "vim" && vimMode === "normal") {
    // VIM_NORMAL_BINDINGS (keybindings.ts) never binds bare u/b/w/e, so
    // claiming them here shadows nothing. Redo deliberately has NO vim-normal
    // key of its own: every short mnemonic ('r', 'y', ...) already means
    // something else in real vim, and guessing wrong is worse than requiring
    // Ctrl+Shift+Z here too — see the file-level note on that chord above.
    if (chord === "u") return { kind: "undo" };
    if (chord === "b") return { kind: "op", op: { type: "move-word-left" } };
    if (chord === "w" || chord === "e") return { kind: "op", op: { type: "move-word-right" } };
  }
  return null;
}

const ACTION_TO_EDIT_OP: Partial<Record<KeybindingAction, ComposerEditOp["type"]>> = {
  "move-left": "move-left",
  "move-right": "move-right",
  "move-up": "move-up",
  "move-down": "move-down",
  "move-line-start": "move-line-start",
  "move-line-end": "move-line-end",
  "move-document-start": "move-document-start",
  "move-document-end": "move-document-end",
  "delete-backward": "delete-backward",
  "delete-forward": "delete-forward",
  "delete-word-backward": "delete-word-backward",
  "kill-line-start": "kill-line-start",
  "kill-line-end": "kill-line-end",
};

/**
 * How many backward deletions a single terminal read is asking for.
 *
 * Returns 0 unless the whole chunk is nothing but DEL (0x7f) / BS (0x08).
 * Anything mixed with real text is left alone: a paste that happens to contain
 * a stray DEL must keep its text, and letting a partial match through here
 * would silently eat characters the user typed. Exported so the run-length
 * contract is covered without rendering Ink.
 */
export function countCoalescedDeletes(input: string): number {
  if (!input) return 0;
  let count = 0;
  for (const ch of input) {
    const code = ch.codePointAt(0);
    // 0x7f DEL is what every mainstream terminal sends for Backspace; 0x08 BS
    // is the older convention some emit under tmux/screen.
    if (code !== 0x7f && code !== 0x08) return 0;
    count += 1;
  }
  return count;
}

/**
 * A resolved KeybindingAction that is a direct 1:1 passthrough to a composer
 * mutation. Exported so the mapping itself is covered without rendering Ink;
 * kept as a plain lookup (not inlined into handleInput) so the coalesced-
 * burst test below exercises the exact table production dispatch uses.
 */
export function editOpForAction(action: KeybindingAction | null): ComposerEditOp | null {
  const type = action ? ACTION_TO_EDIT_OP[action] : undefined;
  return type ? ({ type } as ComposerEditOp) : null;
}

/**
 * The flat "(reverse-i-search)'query': match" status line shells use. A
 * missing match renders as an empty tail rather than a placeholder word — a
 * screen reader (or a user) should never mistake "no match yet" for a literal
 * word appearing in the draft.
 */
export function formatReverseSearchLine(
  state: Pick<ReverseSearchState, "query" | "matches" | "matchIndex">,
): string {
  const match = state.matches[state.matchIndex] ?? "";
  return `(reverse-i-search)'${state.query}': ${match}`;
}

export type PromptInputProps = {
  theme: Theme;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  /**
   * Explanation shown while another UI surface owns input.
   *
   * `disabled` is used for approval dialogs and full-pane pickers, not as a
   * synonym for "a model run is active" (the composer intentionally stays
   * usable during a run for steering). Keep the label caller-owned so opening
   * /resume can never falsely render "running…".
   */
  disabledPlaceholder?: string;
  slashOpen?: boolean;
  onSlashUp?: () => void;
  onSlashDown?: () => void;
  onSlashTab?: () => string | undefined;
  onSlashEnterSelect?: () => boolean;
  /** Recall the previous (older) submitted prompt on ArrowUp (shell style).
   * Returns the recalled text (cursor jumps to end), or null if already at oldest. */
  onHistoryPrev?: () => string | null;
  /** Recall the next (newer) prompt / restore draft on ArrowDown.
   * Called with the box's current text so an edit made to the just-recalled
   * entry survives instead of being discarded (see promptHistory.ts down()).
   * Returns the recalled/draft text, or null if already at live position. */
  onHistoryNext?: (currentDraft?: string) => string | null;
  onModalInput?: (input: string, key: Key) => void;
  width?: number;
  mouseMode?: boolean;
  /** Portable default/Emacs/Vim-compatible action map, with optional overrides. */
  keymap?: KeymapConfig | KeymapMode;
  /** Logical rows to render around the caret. Defaults to one for App layout compatibility. */
  maxVisibleLines?: number;
  /** Stable candidate set for deterministic inline completion. */
  ghostHintCandidates?: readonly GhostHintCandidate[];
  /** Called when a bracketed/multiline paste begins or clears its review gate. */
  onPasteReviewChange?: (review: PasteReview | null) => void;
  /**
   * Legacy one-shot Ctrl+R fallback: given the current draft, return a single
   * recalled entry (or null) to swap in immediately. Superseded by
   * `historyEntries` below when the caller provides it — kept working
   * unchanged for callers that have not migrated, so this stays optional.
   */
  onReverseSearch?: (currentValue: string) => string | null;
  /**
   * Prompt-history entries (oldest first), enabling a real interactive
   * incremental search: Ctrl+R begins it, further typing narrows the query,
   * repeated Ctrl+R cycles older matches, Enter accepts, Escape restores the
   * original draft. Omitting this prop keeps the older one-shot
   * `onReverseSearch` behavior — this is additive, not a replacement.
   */
  historyEntries?: readonly string[];
  /** Platform-specific terminal key semantics, notably the Mac key labelled Delete. */
  platform?: TerminalPlatform;
};

export function promptInputPlaceholder(
  disabled: boolean,
  disabledPlaceholder: string | undefined,
  width: number,
): string {
  if (disabled) return disabledPlaceholder?.trim() || "input unavailable";
  return width >= 60
    ? "Message Sophia Code…  / for commands  ·  ↑↓ Tab select"
    : "Message…  / for cmds";
}

export function PromptInput({
  theme,
  value,
  onChange,
  onSubmit,
  disabled,
  disabledPlaceholder,
  slashOpen,
  onSlashUp,
  onSlashDown,
  onSlashTab,
  onSlashEnterSelect,
  onHistoryPrev,
  onHistoryNext,
  onModalInput,
  width,
  mouseMode = false,
  keymap = "default",
  maxVisibleLines = 1,
  ghostHintCandidates = [],
  onPasteReviewChange,
  onReverseSearch,
  historyEntries,
  platform = "other",
}: PromptInputProps) {
  const accessibility = useAccessibility();
  const activeTheme = accessibleTheme(theme, accessibility);
  const safeValue = sanitizeTerminalText(value, true);
  const units = useMemo(() => graphemes(safeValue), [safeValue]);
  const [cursor, setCursor] = useState(units.length);
  const [preferredColumn, setPreferredColumn] = useState<number | null>(null);
  const [vimMode, setVimMode] = useState<VimInputMode>("insert");
  const [pasteReview, setPasteReview] = useState<PasteReview | null>(null);
  const [reverseSearch, setReverseSearch] = useState<ReverseSearchState | null>(null);
  const decoderRef = useRef(new TerminalInputDecoder());
  const pasteDecoderRef = useRef(new BracketedPasteDecoder());
  // Undo history and the kill ring are internal scratch state no prop ever
  // supplies or observes, so — unlike everything in inputStateRef below —
  // they need no per-render resync: a plain ref mutated only by this
  // component's own handleInput is always current by construction.
  const killRingRef = useRef<readonly string[]>([]);
  const undoHistoryRef = useRef<ComposerUndoHistory>(EMPTY_COMPOSER_UNDO_HISTORY);
  const inputStateRef = useRef({
    disabled,
    mouseMode,
    slashOpen,
    safeValue,
    units,
    cursor,
    preferredColumn,
    vimMode,
    pasteReview,
    reverseSearch,
    keymap,
    ghostHintCandidates,
    historyEntries,
    onChange,
    onSubmit,
    onSlashUp,
    onSlashDown,
    onSlashTab,
    onSlashEnterSelect,
    onHistoryPrev,
    onHistoryNext,
    onModalInput,
    onPasteReviewChange,
    onReverseSearch,
    platform,
  });
  inputStateRef.current = {
    disabled,
    mouseMode,
    slashOpen,
    safeValue,
    units,
    cursor,
    preferredColumn,
    vimMode,
    pasteReview,
    reverseSearch,
    keymap,
    ghostHintCandidates,
    historyEntries,
    onChange,
    onSubmit,
    onSlashUp,
    onSlashDown,
    onSlashTab,
    onSlashEnterSelect,
    onHistoryPrev,
    onHistoryNext,
    onModalInput,
    onPasteReviewChange,
    onReverseSearch,
    platform,
  };

  // `units` above already re-segments on every `value` change; reuse that
  // count instead of re-running Intl.Segmenter a second time per keystroke
  // (segmentation cost grows with total input length, e.g. ~40ms at 500k
  // chars — paying it twice per keystroke was pure waste).
  useEffect(() => {
    setCursor((c) => Math.min(c, units.length));
    if (!safeValue) {
      if (pasteReview) {
        setPasteReview(null);
        onPasteReviewChange?.(null);
      }
      // The box went empty by some path other than our own tracked submit
      // (a slash /clear, a session reset, a programmatic set) — the past
      // snapshots no longer describe a coherent history for whatever comes
      // next, so start undo fresh rather than let Ctrl+Z resurrect text from
      // an unrelated draft. The kill ring is a scratch clipboard, not tied to
      // any one draft's lifetime, so it deliberately survives this reset.
      undoHistoryRef.current = EMPTY_COMPOSER_UNDO_HISTORY;
    }
  }, [onPasteReviewChange, pasteReview, safeValue, units]);

  useEffect(() => {
    if (accessibility.screenReader) return;
    const enabled = enableBracketedPaste();
    return () => {
      if (enabled) disableBracketedPaste();
    };
  }, [accessibility.screenReader]);

  // A run in progress disables the box outright; an incremental search left
  // active underneath it would otherwise reappear frozen on the next enable.
  useEffect(() => {
    if (disabled) setReverseSearch(null);
  }, [disabled]);

  const handleInput = useCallback((input: string, key: Key) => {
    const state = inputStateRef.current;
    if (state.onModalInput) {
      state.onModalInput(input, key);
      return;
    }
    if (state.disabled) return;
    const decoded = decoderRef.current.feed(input, state.mouseMode);
    if (decoded.mouse && !decoded.text) return;

    const decodedEvents = pasteDecoderRef.current.feed(decoded.text);
    const hasBracketedPaste =
      decodedEvents.some((event) => event.kind === "paste")
      || pasteDecoderRef.current.isPasting();

    // Reflect a just-applied edit into the ref BEFORE returning, not only
    // after the next render. Ink can dispatch several keystrokes
    // synchronously before React re-renders (fast typing, or a burst relayed
    // over SSH/tmux jitter); without this, every keystroke in that burst
    // would read the SAME safeValue/cursor captured at the last render, so N
    // coalesced backspaces would delete at most one character and inserted
    // text could land out of order or get silently dropped.
    const syncRefText = (text: string, nextCursor: number, nextPreferredColumn: number | null) => {
      inputStateRef.current = {
        ...inputStateRef.current,
        safeValue: text,
        units: graphemes(text),
        cursor: nextCursor,
        preferredColumn: nextPreferredColumn,
      };
    };
    const commit = (next: ComposerState) => {
      if (next.text !== state.safeValue) state.onChange(next.text);
      setCursor(next.cursor);
      setPreferredColumn(next.preferredColumn);
      syncRefText(next.text, next.cursor, next.preferredColumn);
      return next;
    };
    // Same idea for the interactive search overlay: a second keystroke in a
    // burst must see the query this call just extended, not the one from
    // before the burst started.
    const updateReverseSearchState = (next: ReverseSearchState | null) => {
      setReverseSearch(next);
      inputStateRef.current = { ...inputStateRef.current, reverseSearch: next };
    };
    const initial: ComposerState = {
      ...createComposerState(state.safeValue, state.cursor),
      preferredColumn: state.preferredColumn,
    };
    // Every mutation below is layered over composerEdit.ts's tracked
    // applier instead of composer.ts's bare reduceComposer, so undo/redo and
    // the kill ring see EVERY edit (typing, deletes, kill-line, paste) — not
    // just the four ops composer.ts itself has no concept of.
    const applyTracked = (from: ComposerState, op: ComposerEditOp): ComposerEditState => {
      const editState: ComposerEditState = {
        text: from.text,
        cursor: from.cursor,
        preferredColumn: from.preferredColumn,
        killRing: killRingRef.current,
      };
      const session: ComposerEditSession = { edit: editState, undo: undoHistoryRef.current };
      const tracked = applyTrackedComposerEditOp(session, op, Date.now());
      killRingRef.current = tracked.edit.killRing;
      undoHistoryRef.current = tracked.undo;
      return tracked.edit;
    };

    if (hasBracketedPaste) {
      let next: ComposerState = initial;
      let pastedForReview = "";
      for (const event of decodedEvents) {
        const clean = sanitizeTerminalText(event.text, true);
        if (!clean) continue;
        next = applyTracked(next, { type: "insert", text: clean });
        if (event.kind === "paste") pastedForReview += clean;
      }
      commit(next);
      if (pastedForReview) {
        const review = createPasteReview(pastedForReview, true);
        setPasteReview(review);
        state.onPasteReviewChange?.(review);
      }
      // A paste event is data, never an implicit command/submit, even when its
      // body ends in a newline or contains text resembling a key chord.
      return;
    }

    // See splitCoalescedInput: distinguishes a coalesced "typed text + Enter"
    // burst from a genuine multi-line paste that happens to share the same
    // wire shape when bracketed-paste mode is unavailable.
    const plainText = decodedEvents
      .filter((event): event is { kind: "text"; text: string } => event.kind === "text")
      .map((event) => event.text)
      .join("");
    const { literalText: carriedText, isEnter: carriedSubmit } = splitCoalescedInput(plainText);
    const cleanInput = sanitizeTerminalText(carriedText, true);
    const keyForBinding = carriedSubmit ? { ...key, return: true } : key;
    const action: KeybindingAction | null = resolveKeyAction(
      carriedSubmit ? "" : input,
      keyForBinding,
      state.keymap,
      state.vimMode,
      state.platform,
    );
    const keymapMode: KeymapMode = typeof state.keymap === "string" ? state.keymap : state.keymap.mode ?? "default";

    if (state.reverseSearch?.active) {
      const search = state.reverseSearch;
      const history = state.historyEntries ?? [];
      const exit = (text: string) => {
        updateReverseSearchState(null);
        commit(createComposerState(sanitizeTerminalText(text, true)));
      };
      if (action === "cancel" || key.escape) return void exit(cancelReverseSearch(search));
      if (action === "submit") return void exit(acceptReverseSearch(search));
      if (action === "reverse-search") return void updateReverseSearchState(stepReverseSearch(search));
      if (action === "delete-backward") {
        const shorter = graphemes(search.query).slice(0, -1).join("");
        return void updateReverseSearchState(updateReverseSearch(search, history, shorter));
      }
      if (cleanInput) {
        return void updateReverseSearchState(updateReverseSearch(search, history, search.query + cleanInput));
      }
      // Any other key (an arrow, Tab, an unbound chord) ends the incremental
      // search and keeps whatever it currently matched — the same "search
      // stops, editing resumes" convention shells use — rather than silently
      // eating a keypress the user did not aim at the search box.
      return void exit(acceptReverseSearch(search));
    }

    if (state.slashOpen) {
      if (key.upArrow) return void state.onSlashUp?.();
      if (key.downArrow) return void state.onSlashDown?.();
      if (key.tab && !key.shift) {
        const completed = state.onSlashTab?.();
        if (completed !== undefined) {
          const completedCursor = graphemes(completed).length;
          setCursor(completedCursor);
          syncRefText(completed, completedCursor, null);
        }
        return;
      }
      if (action === "submit") {
        // Slash menu open: always prefer the dedicated slash Enter path so we
        // run the resolved/highlighted command. Using onSubmit(next) alone used
        // to drop args when the highlight path ran bare `/resume` without the
        // typed session name, and pure Enter (cleanInput empty) is the common case.
        if (state.onSlashEnterSelect?.()) {
          undoHistoryRef.current = EMPTY_COMPOSER_UNDO_HISTORY;
          return;
        }
        const next = cleanInput
          ? applyTracked(initial, { type: "insert", text: cleanInput })
          : initial;
        commit(next);
        undoHistoryRef.current = EMPTY_COMPOSER_UNDO_HISTORY;
        state.onSubmit(next.text);
        return;
      }
    }

    const shim = resolveChordShimAction(
      keyChord(carriedSubmit ? "" : input, keyForBinding, state.platform),
      keymapMode,
      state.vimMode,
    );
    if (shim) {
      if (shim.kind === "op") {
        commit(applyTracked(initial, shim.op));
        return;
      }
      const editState: ComposerEditState = {
        text: initial.text,
        cursor: initial.cursor,
        preferredColumn: initial.preferredColumn,
        killRing: killRingRef.current,
      };
      const session: ComposerEditSession = { edit: editState, undo: undoHistoryRef.current };
      const result = shim.kind === "undo" ? undoComposerEdit(session) : redoComposerEdit(session);
      killRingRef.current = result.edit.killRing;
      undoHistoryRef.current = result.undo;
      commit(result.edit);
      return;
    }

    if (
      cleanInput
      && inputRequiresPasteReview(cleanInput, false)
      && action !== "insert-newline"
    ) {
      const next = commit(applyTracked(initial, { type: "insert", text: cleanInput }));
      const review = createPasteReview(cleanInput, false);
      setPasteReview(review);
      state.onPasteReviewChange?.(review);
      setCursor(next.cursor);
      return;
    }

    if (action === "submit") {
      const next = cleanInput
        ? commit(applyTracked(initial, { type: "insert", text: cleanInput }))
        : initial;
      if (state.pasteReview) {
        // First Enter is the explicit review acknowledgement. A second Enter
        // submits, preventing pasted commands from executing on arrival.
        setPasteReview(null);
        state.onPasteReviewChange?.(null);
        return;
      }
      // A sent message is a clean boundary: undoing PAST it back into text
      // that already went out would be confusing, not helpful.
      undoHistoryRef.current = EMPTY_COMPOSER_UNDO_HISTORY;
      state.onSubmit(next.text);
      return;
    }

    if (action === "insert-newline") {
      let next: ComposerState = initial;
      if (cleanInput && cleanInput !== "\n" && cleanInput !== "\r") {
        next = applyTracked(next, { type: "insert", text: cleanInput.replace(/[\r\n]+$/u, "") });
      }
      commit(applyTracked(next, { type: "newline" }));
      return;
    }

    if (action === "complete") {
      const hint = selectGhostHint(
        initial.text,
        initial.cursor,
        state.ghostHintCandidates,
      );
      if (hint) commit(acceptGhostHint(initial, hint));
      return;
    }

    if (action === "reverse-search") {
      if (state.historyEntries) {
        updateReverseSearchState(beginReverseSearch(state.historyEntries, state.safeValue));
        return;
      }
      // Legacy one-shot fallback for callers that have not passed
      // historyEntries yet (see the doc comment on the prop).
      const recalled = state.onReverseSearch?.(state.safeValue);
      if (recalled !== undefined && recalled !== null) {
        commit(createComposerState(sanitizeTerminalText(recalled, true)));
      }
      return;
    }

    if (action === "vim-normal") {
      setVimMode("normal");
      return;
    }
    if (action === "vim-insert") {
      setVimMode("insert");
      return;
    }
    if (action === "vim-append") {
      setVimMode("insert");
      commit(applyTracked(initial, { type: "move-right" }));
      return;
    }
    if (action === "vim-open-below") {
      setVimMode("insert");
      let next = applyTracked(initial, { type: "move-line-end" });
      next = applyTracked(next, { type: "newline" });
      commit(next);
      return;
    }

    if (action === "history-previous" || action === "history-next") {
      const arrowHistory = !!(key.upArrow || key.downArrow);
      if (arrowHistory && !isHistoryNavKey(key)) return; // Shift+arrow: leave it for scroll
      const direction = action === "history-previous" ? "previous" : "next";
      if (arrowHistory && !shouldNavigateHistory(initial, direction)) {
        commit(applyTracked(initial, {
          type: direction === "previous" ? "move-up" : "move-down",
        }));
        return;
      }
      // No-mouse mode: a bare ↑/↓ on an EMPTY box is the wheel/scroll path
      // (App.tsx's empty-input fallback) — do NOT recall history here, or the
      // scroll keypress silently overwrites the empty draft with the last
      // command. With mouse tracking on, the wheel is a separate (mouse) event
      // that never reaches this branch, so recall-on-empty stays available.
      if (arrowHistory && !state.mouseMode && state.safeValue.length === 0) return;
      const recalled =
        direction === "previous"
          ? state.onHistoryPrev?.()
          : state.onHistoryNext?.(state.safeValue);
      if (recalled !== undefined && recalled !== null) {
        const next = createComposerState(sanitizeTerminalText(recalled, true));
        setCursor(next.cursor);
        setPreferredColumn(null);
        syncRefText(next.text, next.cursor, null);
      }
      return;
    }

    // A held backspace over ssh/tmux arrives as ONE read carrying several DEL
    // bytes (0x7f). The chord table only classifies a single key, so no op
    // resolves for that run, and the raw DELs sanitize away to nothing — so
    // every one of them used to be dropped on the `!cleanInput` return below.
    // Replay pure DEL/BS runs as delete-backward (including a lone DEL): Ink
    // reports 0x7f as key.delete, and on Linux that previously mapped to
    // delete-forward, which is the opposite of Backspace.
    const coalescedDeletes = countCoalescedDeletes(input);
    if (coalescedDeletes >= 1) {
      let next: ComposerState = initial;
      for (let i = 0; i < coalescedDeletes; i += 1) {
        next = applyTracked(next, { type: "delete-backward" });
      }
      commit(next);
      return;
    }

    const boundOp = editOpForAction(action);
    if (boundOp) {
      commit(applyTracked(initial, boundOp));
      return;
    }

    if (action === "cancel" || key.ctrl || key.meta || key.tab) return;
    if (keymapMode === "vim" && state.vimMode === "normal") return;
    if (!cleanInput) return;
    commit(applyTracked(initial, { type: "insert", text: cleanInput }));
  }, []);

  useInput(handleInput);

  const w = Math.max(12, width ?? 80);
  const avail = Math.max(12, w - 2);

  if (reverseSearch?.active) {
    // A dedicated flat status line rather than threading a label through the
    // normal multi-row viewport: composerViewport's width/cursor math is
    // tuned for editable text, not a read-mostly search summary, and shells
    // render reverse-i-search the same simplified way.
    return (
      <Box width={w} flexShrink={0} flexDirection="column">
        <Box width={w}>
          <Text color={activeTheme.accent} bold>
            {"❯ "}
          </Text>
          <Box flexGrow={1} width={avail}>
            <Text color={activeTheme.text} wrap="truncate-end">
              {formatReverseSearchLine(reverseSearch)}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  const mode = typeof keymap === "string" ? keymap : keymap.mode ?? "default";
  const cursorLocation = composerCursorLocation({ text: safeValue, cursor });
  const indicator = pasteReview
    ? " paste review: Enter"
    : mode === "vim"
      ? ` ${vimMode.toUpperCase()}`
      : cursorLocation.lineCount > 1
        ? ` ${cursorLocation.line + 1}/${cursorLocation.lineCount}`
        : "";
  const indicatorWidth = textDisplayWidth(indicator);
  // Reserve two cells for the optional left/right truncation markers.
  const inputColumns = Math.max(4, avail - indicatorWidth - (safeValue ? 2 : 0));
  const viewport = composerViewport(
    { text: safeValue, cursor },
    inputColumns,
    maxVisibleLines,
  );
  const ghostHint = pasteReview
    ? null
    : selectGhostHint(safeValue, cursor, ghostHintCandidates);
  const placeholder = promptInputPlaceholder(!!disabled, disabledPlaceholder, w);

  return (
    <Box width={w} flexShrink={0} flexDirection="column">
      {viewport.rows.map((row) => {
        const isActive = row.hasCursor;
        const canPaintGhost = isActive
          && ghostHint
          && ghostHint.insertAt === cursor
          && row.afterCursor === ""
          && row.cursorGrapheme === " ";
        const ghostUnits = canPaintGhost ? graphemes(ghostHint.suffix) : [];
        const cursorGlyph = ghostUnits[0] || row.cursorGrapheme || " ";
        const used = textDisplayWidth(row.beforeCursor) + textDisplayWidth(cursorGlyph);
        const ghostTail = canPaintGhost
          ? truncateToWidth(ghostUnits.slice(1).join(""), Math.max(0, inputColumns - used))
          : "";
        return (
          <Box key={row.logicalLine} width={w}>
            <Text color={activeTheme.accent} bold>
              {isActive ? "❯ " : "  "}
            </Text>
            <Box flexGrow={1} width={avail}>
              {!safeValue && isActive ? (
                <Text wrap="truncate-end">
                  <Text inverse color={activeTheme.dim}>
                    {" "}
                  </Text>
                  <Text color={activeTheme.dim}>{placeholder}</Text>
                </Text>
              ) : isActive ? (
                <Text color={activeTheme.text}>
                  {row.truncatedStart ? "…" : ""}
                  {row.beforeCursor}
                  <Text inverse color={canPaintGhost ? activeTheme.dim : activeTheme.text}>
                    {cursorGlyph}
                  </Text>
                  {ghostTail ? <Text color={activeTheme.dim}>{ghostTail}</Text> : null}
                  {row.afterCursor}
                  {row.truncatedEnd ? "…" : ""}
                  {indicator ? <Text color={pasteReview ? activeTheme.warn : activeTheme.dim}>{indicator}</Text> : null}
                </Text>
              ) : (
                <Text color={activeTheme.text}>
                  {row.truncatedStart ? "…" : ""}
                  {row.text}
                  {row.truncatedEnd ? "…" : ""}
                </Text>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
