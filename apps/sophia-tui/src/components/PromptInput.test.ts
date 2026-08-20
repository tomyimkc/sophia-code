import assert from "node:assert/strict";
import { test } from "node:test";
import { applyComposerEditOp, createComposerEditState, type ComposerEditOp } from "../lib/composerEdit.js";
import {
  countCoalescedDeletes,
  displayWidth,
  editOpForAction,
  formatReverseSearchLine,
  graphemes,
  isHistoryNavKey,
  promptInputPlaceholder,
  resolveChordShimAction,
  sanitizeTerminalText,
  splitCoalescedInput,
} from "./PromptInput.js";

test("disabled prompt labels describe the owning modal instead of claiming a run is active", () => {
  assert.equal(
    promptInputPlaceholder(true, "session browser open · ↑↓ Enter · Esc", 100),
    "session browser open · ↑↓ Enter · Esc",
  );
  assert.doesNotMatch(promptInputPlaceholder(true, undefined, 100), /running/i);
  assert.equal(promptInputPlaceholder(true, undefined, 100), "input unavailable");
});

test("enabled prompt keeps the existing wide and compact composer hints", () => {
  assert.equal(
    promptInputPlaceholder(false, "ignored disabled label", 100),
    "Message Sophia Code…  / for commands  ·  ↑↓ Tab select",
  );
  assert.equal(promptInputPlaceholder(false, undefined, 40), "Message…  / for cmds");
});

// --- isHistoryNavKey: gates whether an arrow keypress drives prompt-history
// recall in this component, vs. being left for App.tsx's global Shift+↑/↓
// transcript-scroll handler. Both `useInput` hooks receive every keypress
// (Ink fans stdin out to all mounted listeners), so without this guard a
// scroll attempt while the prompt has focus also silently overwrote the
// draft with a recalled history entry. ---

test("isHistoryNavKey: plain ArrowUp/ArrowDown are history-nav keys", () => {
  assert.equal(isHistoryNavKey({ upArrow: true, downArrow: false, shift: false }), true);
  assert.equal(isHistoryNavKey({ upArrow: false, downArrow: true, shift: false }), true);
});

// Title deliberately avoids a mixed-case token containing a plus and a slash:
// gitleaks' generic-api-key rule reads that shape as base64 and failed
// secret-scan on a TEST TITLE. Reworded rather than allowlisted — an allowlist
// entry would widen a real security gate to silence a false positive.
test("isHistoryNavKey: shifted arrow keys are NOT history-nav keys (reserved for transcript scroll)", () => {
  // This is the exact defect: Shift+↑ while trying to scroll the message
  // log used to also recall a prompt-history entry into the input box.
  assert.equal(isHistoryNavKey({ upArrow: true, downArrow: false, shift: true }), false);
  assert.equal(isHistoryNavKey({ upArrow: false, downArrow: true, shift: true }), false);
});

test("isHistoryNavKey: non-arrow keys are never history-nav keys, shifted or not", () => {
  assert.equal(isHistoryNavKey({ upArrow: false, downArrow: false, shift: false }), false);
  assert.equal(isHistoryNavKey({ upArrow: false, downArrow: false, shift: true }), false);
});

// --- splitCoalescedInput: bracketed paste is never enabled (no \x1b[?2004h
// is written anywhere in this app or in Ink itself), so a paste and a fast
// "typed chars + Enter" burst arrive over the exact same wire shape: plain
// text, possibly with embedded newlines, delivered as one Ink data event. ---

test("preserves a multi-line paste coalesced into one chunk instead of truncating at the first line", () => {
  // This is the exact defect: pasting a 2-line snippet used to submit only
  // "def foo():" and silently drop "    return 1" forever.
  const { literalText, isEnter } = splitCoalescedInput("def foo():\n    return 1\n");
  assert.equal(isEnter, false);
  assert.equal(literalText, "def foo():\n    return 1\n");
  // The caller strips embedded newlines via sanitizeTerminalText (default
  // allowNewline=false) rather than dropping the tail outright.
  assert.equal(sanitizeTerminalText(literalText), "def foo():    return 1");
});

test("treats a bare trailing newline as the real Enter keystroke (fast-typing burst)", () => {
  // Ink can coalesce "hello" + physical Enter into ONE chunk "hello\r" with
  // key.return === false; this must still submit.
  const { literalText, isEnter } = splitCoalescedInput("hello\r");
  assert.equal(isEnter, true);
  assert.equal(literalText, "hello");
});

test("treats a lone CR, LF, or CRLF chunk as Enter", () => {
  assert.deepEqual(splitCoalescedInput("\r"), { literalText: "", isEnter: true });
  assert.deepEqual(splitCoalescedInput("\n"), { literalText: "", isEnter: true });
  assert.deepEqual(splitCoalescedInput("\r\n"), { literalText: "", isEnter: true });
});

test("does not truncate-and-submit a paste that merely ends with a line break", () => {
  // A paste of one full line copied with its own trailing newline should be
  // inserted, not silently auto-submitted out from under the user.
  const { literalText, isEnter } = splitCoalescedInput("console.log(1)\n");
  assert.equal(isEnter, true);
  assert.equal(literalText, "console.log(1)");
});

test("leaves plain text with no line break untouched", () => {
  assert.deepEqual(splitCoalescedInput("hello world"), { literalText: "hello world", isEnter: false });
  assert.deepEqual(splitCoalescedInput(""), { literalText: "", isEnter: false });
});

test("multiline composer mode preserves newlines while still stripping terminal controls", () => {
  const ESC = "\x1b";
  assert.equal(
    sanitizeTerminalText(`one\r\n${ESC}[31mtwo${ESC}[0m\u0007\nthree`, true),
    "one\r\ntwo\nthree",
  );
  // The legacy/default caller contract remains single-line.
  assert.equal(sanitizeTerminalText("one\ntwo"), "onetwo");
});

// --- Unicode correctness already provided by Intl.Segmenter; locked in here
// since PromptInput's cursor math (arrow keys, backspace) walks `graphemes`
// one unit at a time and must never split these clusters. ---

test("clusters a combining-mark sequence into a single grapheme", () => {
  const combining = "e" + "́".repeat(3); // e + 3 stacked combining acute accents
  assert.equal(graphemes(combining).length, 1);
});

test("clusters a ZWJ family emoji and a flag (regional-indicator pair) as one grapheme each", () => {
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
  const flag = "\u{1F1FA}\u{1F1F8}";
  assert.equal(graphemes(family).length, 1);
  assert.equal(graphemes(flag).length, 1);
});

test("displayWidth counts terminal COLUMNS, and control characters as none", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("a\x07b"), 2, "control characters paint nothing");
  // A=1, the ZWJ emoji=2, the combining-accented e=1.
  assert.equal(displayWidth("A👩‍💻é"), 4);
});

test("displayWidth accounts for East-Asian-Wide columns (was a KNOWN GAP)", () => {
  // This test previously asserted the BUG: the helper counted one unit per
  // grapheme, so 3 CJK graphemes measured 3 while the terminal paints 6. Its
  // own comment named the fix — `string-width`, already resolved transitively
  // through ink — and that is now a direct dependency, used by lib/textWidth.
  // Ink's Yoga layout has always measured real columns, so the helper and the
  // layout finally agree.
  assert.equal(displayWidth("你好嗎"), 6);
});

// --- The keystroke-race corruption fix: handleInput's commit() now writes
// the just-applied edit synchronously into inputStateRef.current before
// returning, so a second keystroke arriving in the same coalesced Ink
// dispatch (before React re-renders) starts from what the first one just
// produced. That stateful ref threading cannot be exercised without a real
// terminal/render loop, but the piece that actually decides "which composer
// mutation does this keystroke produce" — editOpForAction, the same table
// production handleInput dispatches through — can be, by folding a decoded
// sequence exactly the way a burst would need to compose correctly. ---

test("nine coalesced backspace-decoded ops delete nine characters, not one", () => {
  // This is the exact defect: holding Backspace used to do nothing or move
  // by exactly one character regardless of how many presses Ink coalesced
  // into a single dispatch.
  const backspace = editOpForAction("delete-backward");
  assert.ok(backspace);
  let state = createComposerEditState("abcdefghij");
  for (let i = 0; i < 9; i += 1) state = applyComposerEditOp(state, backspace!);
  assert.equal(state.text, "a");
  assert.equal(state.cursor, 1);
});

test("a coalesced burst mixing left-arrow motion with inserted text composes in order", () => {
  const moveLeft = editOpForAction("move-left");
  assert.ok(moveLeft);
  const ops: ComposerEditOp[] = [
    { type: "insert", text: "a" },
    { type: "insert", text: "b" },
    { type: "insert", text: "c" },
    moveLeft!,
    moveLeft!,
    { type: "insert", text: "X" },
  ];
  let state = createComposerEditState("");
  for (const op of ops) state = applyComposerEditOp(state, op);
  // Both left-arrow presses moved the cursor — a stale-snapshot bug would
  // have applied every op to the ORIGINAL empty buffer instead of chaining
  // off the previous op's result, landing "X" at the end instead of the
  // middle (or dropping/reordering characters entirely).
  assert.equal(state.text, "aXbc");
  assert.equal(state.cursor, 2);
});

test("editOpForAction only maps the direct passthrough motions/deletes, not submit or mode actions", () => {
  assert.deepEqual(editOpForAction("kill-line-end"), { type: "kill-line-end" });
  assert.equal(editOpForAction("submit"), null);
  assert.equal(editOpForAction("complete"), null);
  assert.equal(editOpForAction(null), null);
});

// --- resolveChordShimAction: the readline undo/redo/word-motion/yank chords
// that keybindings.ts's shared KeybindingAction table has no vocabulary for
// (see the file-level comment on ChordShimAction for why these live here
// instead of widening that shared enum). ---

test("resolveChordShimAction: ctrl+z undoes, ctrl+shift+z redoes, ctrl+y yanks, in ordinary modes", () => {
  assert.deepEqual(resolveChordShimAction("ctrl+z", "default", "insert"), { kind: "undo" });
  assert.deepEqual(resolveChordShimAction("ctrl+shift+z", "emacs", "insert"), { kind: "redo" });
  assert.deepEqual(resolveChordShimAction("ctrl+y", "default", "insert"), { kind: "op", op: { type: "yank" } });
});

test("resolveChordShimAction: alt+left/alt+b move a word left, alt+right/alt+f move a word right", () => {
  assert.deepEqual(resolveChordShimAction("alt+left", "default", "insert"), { kind: "op", op: { type: "move-word-left" } });
  assert.deepEqual(resolveChordShimAction("alt+b", "emacs", "insert"), { kind: "op", op: { type: "move-word-left" } });
  assert.deepEqual(resolveChordShimAction("alt+right", "default", "insert"), { kind: "op", op: { type: "move-word-right" } });
  assert.deepEqual(resolveChordShimAction("alt+f", "emacs", "insert"), { kind: "op", op: { type: "move-word-right" } });
});

test("resolveChordShimAction: vim-normal claims bare u/b/w/e for undo and word motion, but ONLY in normal mode", () => {
  assert.deepEqual(resolveChordShimAction("u", "vim", "normal"), { kind: "undo" });
  assert.deepEqual(resolveChordShimAction("b", "vim", "normal"), { kind: "op", op: { type: "move-word-left" } });
  assert.deepEqual(resolveChordShimAction("w", "vim", "normal"), { kind: "op", op: { type: "move-word-right" } });
  assert.deepEqual(resolveChordShimAction("e", "vim", "normal"), { kind: "op", op: { type: "move-word-right" } });
  // The exact vim Ctrl+R collision the corruption fix has to resolve: a bare
  // 'u' in vim-INSERT mode is plain text, not undo, and vim-normal never gets
  // its own redo key (every short mnemonic already means something else in
  // real vim) — Ctrl+Shift+Z above is still reachable from any mode.
  assert.equal(resolveChordShimAction("u", "vim", "insert"), null);
  assert.equal(resolveChordShimAction("b", "vim", "insert"), null);
  assert.deepEqual(resolveChordShimAction("ctrl+shift+z", "vim", "normal"), { kind: "redo" });
});

test("resolveChordShimAction: an ordinary key or unrelated chord is never claimed", () => {
  assert.equal(resolveChordShimAction("z", "default", "insert"), null);
  assert.equal(resolveChordShimAction("ctrl+w", "default", "insert"), null);
  assert.equal(resolveChordShimAction("j", "vim", "normal"), null);
  assert.equal(resolveChordShimAction("w", "default", "insert"), null);
});

// --- formatReverseSearchLine: the interactive Ctrl+R overlay's status text. ---

test("formatReverseSearchLine renders the shell-style '(reverse-i-search)' status line", () => {
  assert.equal(
    formatReverseSearchLine({ query: "foo", matches: ["foo bar", "food"], matchIndex: 1 }),
    "(reverse-i-search)'foo': food",
  );
});

test("formatReverseSearchLine shows an empty match tail rather than a placeholder when nothing matches", () => {
  assert.equal(formatReverseSearchLine({ query: "zzz", matches: [], matchIndex: 0 }), "(reverse-i-search)'zzz': ");
});

test("countCoalescedDeletes reports the run length of a held backspace", () => {
  // One terminal read carrying several DELs is what a held Backspace looks like
  // over ssh/tmux. Before this was handled no chord resolved for the run and the
  // raw bytes sanitized to nothing, so the whole burst was dropped and the key
  // appeared dead.
  assert.equal(countCoalescedDeletes("\u007f\u007f\u007f"), 3);
  assert.equal(countCoalescedDeletes("\u007f"), 1);
  assert.equal(countCoalescedDeletes("\b\b"), 2);
  assert.equal(countCoalescedDeletes(""), 0);
});

test("countCoalescedDeletes refuses to eat a chunk that carries real text", () => {
  // A paste containing a stray DEL must keep its text: treating a partial match
  // as a delete run would silently discard characters the user typed.
  assert.equal(countCoalescedDeletes("ab\u007f"), 0);
  assert.equal(countCoalescedDeletes("\u007fab"), 0);
  assert.equal(countCoalescedDeletes("hello"), 0);
});
