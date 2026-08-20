import assert from "node:assert/strict";
import test from "node:test";

import {
  type ComposerEditOp,
  type ComposerEditState,
  applyComposerEditOp,
  applyComposerEditOps,
  applyTrackedComposerEditOp,
  cancelReverseSearch,
  createComposerEditSession,
  createComposerEditState,
  redoComposerEdit,
  stepReverseSearch,
  undoComposerEdit,
  wrapComposerLines,
  beginReverseSearch,
  acceptReverseSearch,
} from "./composerEdit.js";
import { graphemes } from "./textWidth.js";

function typeText(text: string): ComposerEditOp[] {
  return graphemes(text).map((grapheme) => ({ type: "insert", text: grapheme }) as const);
}

// ---------------------------------------------------------------------------
// Coalesced-chunk correctness — the corruption fix
// ---------------------------------------------------------------------------

test("N coalesced backspaces delete N characters, not one", () => {
  const state = createComposerEditState("abcdefghij", 10);
  const ops: ComposerEditOp[] = Array.from({ length: 9 }, () => ({ type: "delete-backward" }));
  const next = applyComposerEditOps(state, ops);
  assert.equal(next.text, "a");
  assert.equal(next.cursor, 1);
});

test("a chunk that mixes inserted text with control ops folds sequentially", () => {
  const state = createComposerEditState("");
  const ops: ComposerEditOp[] = [
    ...typeText("ab"),
    { type: "delete-backward" },
    ...typeText("cd"),
    { type: "move-left" },
    { type: "delete-forward" },
  ];
  // Reference: apply the very same ops one at a time via a manual loop, so
  // this test would catch a regression to "apply every op against the
  // chunk's starting snapshot" just as surely as it checks the literal text.
  let manual = state;
  for (const op of ops) manual = applyComposerEditOp(manual, op);
  const folded = applyComposerEditOps(state, ops);
  assert.deepEqual(folded, manual);
  assert.equal(folded.text, "ac");
  assert.equal(folded.cursor, 2);
});

test("a burst of held Left-arrow coalesced into one chunk moves by the full count", () => {
  const state = createComposerEditState("hello world", 11);
  const ops: ComposerEditOp[] = Array.from({ length: 5 }, () => ({ type: "move-left" }));
  const next = applyComposerEditOps(state, ops);
  assert.equal(next.cursor, 6, "5 coalesced left-arrows move the caret by 5, not 1");
});

test("interleaved backspace and arrow keys in one chunk apply in the given order", () => {
  const state = createComposerEditState("abcdef", 6);
  const ops: ComposerEditOp[] = [
    { type: "delete-backward" },
    { type: "move-left" },
    { type: "delete-backward" },
    { type: "delete-backward" },
  ];
  // start "abcdef" cursor=6
  // delete-backward -> "abcde" cursor=5   (removes "f")
  // move-left       -> "abcde" cursor=4
  // delete-backward -> "abce"  cursor=3   (removes "d")
  // delete-backward -> "abe"   cursor=2   (removes "c")
  const next = applyComposerEditOps(state, ops);
  assert.equal(next.text, "abe");
  assert.equal(next.cursor, 2);
});

// ---------------------------------------------------------------------------
// Multi-line paste via plain insert
// ---------------------------------------------------------------------------

test("insert accepts a multi-line paste and normalizes CRLF/CR within it", () => {
  const state = createComposerEditState("start ", 6);
  const next = applyComposerEditOp(state, { type: "insert", text: "a\r\nb\rc" });
  assert.equal(next.text, "start a\nb\nc");
  assert.equal(next.cursor, graphemes("start a\nb\nc").length);
});

test("a multi-line paste splits into the expected wrapped rows", () => {
  const state = createComposerEditState("", 0);
  const pasted = applyComposerEditOp(state, { type: "insert", text: "one\ntwo\nthree" });
  const layout = wrapComposerLines(pasted.text, pasted.cursor, 80);
  assert.deepEqual(layout.rows.map((r) => r.text), ["one", "two", "three"]);
  assert.equal(layout.cursor.row, 2);
  assert.equal(layout.cursor.column, 5, "cursor after the pasted text sits at end of the last row");
});

// ---------------------------------------------------------------------------
// Word motion / forward word deletion
// ---------------------------------------------------------------------------

test("move-word-left/right land on whitespace boundaries for mixed CJK+ASCII text", () => {
  const text = "hello 世界 world";
  let state = createComposerEditState(text, 0);
  state = applyComposerEditOp(state, { type: "move-word-right" });
  assert.equal(state.cursor, graphemes("hello").length, "stops after the ASCII word");
  state = applyComposerEditOp(state, { type: "move-word-right" });
  assert.equal(state.cursor, graphemes("hello 世界").length, "CJK run with no internal space is one word");
  state = applyComposerEditOp(state, { type: "move-word-left" });
  assert.equal(state.cursor, graphemes("hello ").length, "moves back to the start of the CJK word");
});

test("delete-word-forward removes the word ahead without splitting a grapheme cluster", () => {
  const word = "👩‍💻world";
  const state = createComposerEditState(`${word} tail`, 0);
  const next = applyComposerEditOp(state, { type: "delete-word-forward" });
  assert.equal(next.text, " tail");
  assert.equal(next.cursor, 0);
});

test("move-word-left/right are total at both buffer extremes", () => {
  const empty = createComposerEditState("");
  assert.equal(applyComposerEditOp(empty, { type: "move-word-left" }).cursor, 0);
  assert.equal(applyComposerEditOp(empty, { type: "move-word-right" }).cursor, 0);
  const atStart = createComposerEditState("word", 0);
  assert.equal(applyComposerEditOp(atStart, { type: "move-word-left" }).cursor, 0);
  const atEnd = createComposerEditState("word", 4);
  assert.equal(applyComposerEditOp(atEnd, { type: "move-word-right" }).cursor, 4);
});

// ---------------------------------------------------------------------------
// Kill ring / yank
// ---------------------------------------------------------------------------

test("kill-line-end then yank elsewhere restores the killed text", () => {
  let state = createComposerEditState("keep this", 4); // cursor after "keep"
  state = applyComposerEditOp(state, { type: "kill-line-end" });
  assert.equal(state.text, "keep");
  assert.deepEqual(state.killRing, [" this"]);
  state = applyComposerEditOp(state, { type: "move-line-start" });
  state = applyComposerEditOp(state, { type: "yank" });
  assert.equal(state.text, " thiskeep");
  assert.equal(state.cursor, graphemes(" this").length);
});

test("the kill ring keeps multiple kills with the most recent first", () => {
  let state = createComposerEditState("alpha beta gamma", 5); // after "alpha"
  state = applyComposerEditOp(state, { type: "kill-line-end" }); // kills " beta gamma"
  state = applyComposerEditOp(state, { type: "kill-line-start" }); // kills "alpha"
  assert.deepEqual(state.killRing, ["alpha", " beta gamma"]);
  const yanked = applyComposerEditOp(state, { type: "yank" });
  assert.equal(yanked.text, "alpha", "yank uses the most recently killed entry");
});

test("yanking an empty kill ring is a total no-op", () => {
  const state = createComposerEditState("unchanged", 3);
  const next = applyComposerEditOp(state, { type: "yank" });
  assert.deepEqual(next, state);
});

test("killing at a boundary where nothing is selected does not push an empty entry", () => {
  const state = createComposerEditState("abc", 0);
  const next = applyComposerEditOp(state, { type: "kill-line-start" });
  assert.equal(next.text, "abc");
  assert.deepEqual(next.killRing, []);
});

// ---------------------------------------------------------------------------
// Undo / redo with coalesced typing
// ---------------------------------------------------------------------------

test("10 consecutive single-char inserts within the coalescing window undo as ONE step", () => {
  let session = createComposerEditSession("");
  let now = 1_000;
  for (const ch of graphemes("abcdefghij")) {
    session = applyTrackedComposerEditOp(session, { type: "insert", text: ch }, now);
    now += 10; // fast typing, well inside the 500ms coalescing window
  }
  assert.equal(session.edit.text, "abcdefghij");
  const undone = undoComposerEdit(session);
  assert.equal(undone.edit.text, "", "the whole burst reverts in a single undo");
  assert.equal(undone.edit.cursor, 0);
  // Nothing left to undo: a second undo is a no-op, never a throw.
  const undoneAgain = undoComposerEdit(undone);
  assert.equal(undoneAgain.edit.text, "");
});

test("a pause longer than the coalescing window starts a new undo group", () => {
  let session = createComposerEditSession("");
  session = applyTrackedComposerEditOp(session, { type: "insert", text: "a" }, 0);
  session = applyTrackedComposerEditOp(session, { type: "insert", text: "b" }, 100);
  session = applyTrackedComposerEditOp(session, { type: "insert", text: "c" }, 900); // >500ms since the last edit
  assert.equal(session.edit.text, "abc");
  const afterFirstUndo = undoComposerEdit(session);
  assert.equal(afterFirstUndo.edit.text, "ab", "only the post-pause group is reverted first");
  const afterSecondUndo = undoComposerEdit(afterFirstUndo);
  assert.equal(afterSecondUndo.edit.text, "", "the pre-pause group reverts as its own step");
});

test("kill-line then undo restores exact prior text and cursor", () => {
  let session = createComposerEditSession("alpha beta", 5);
  session = applyTrackedComposerEditOp(session, { type: "kill-line-end" }, 0);
  assert.equal(session.edit.text, "alpha");
  const undone = undoComposerEdit(session);
  assert.equal(undone.edit.text, "alpha beta");
  assert.equal(undone.edit.cursor, 5);
});

test("redo restores an edit that was just undone", () => {
  let session = createComposerEditSession("");
  session = applyTrackedComposerEditOp(session, { type: "insert", text: "hi" }, 0);
  const undone = undoComposerEdit(session);
  assert.equal(undone.edit.text, "");
  const redone = redoComposerEdit(undone);
  assert.equal(redone.edit.text, "hi");
  assert.equal(redone.edit.cursor, session.edit.cursor);
});

test("a non-coalescable action between two typing bursts starts a new group", () => {
  let session = createComposerEditSession("");
  session = applyTrackedComposerEditOp(session, { type: "insert", text: "a" }, 0);
  session = applyTrackedComposerEditOp(session, { type: "insert", text: "b" }, 10);
  session = applyTrackedComposerEditOp(session, { type: "kill-line-start" }, 20);
  session = applyTrackedComposerEditOp(session, { type: "insert", text: "c" }, 30);
  session = applyTrackedComposerEditOp(session, { type: "insert", text: "d" }, 40);
  assert.equal(session.edit.text, "cd");
  let steps = 0;
  let cursor = session;
  while (cursor.undo.past.length > 0) {
    cursor = undoComposerEdit(cursor);
    steps += 1;
  }
  assert.equal(steps, 3, "insert-burst, kill, insert-burst are three distinct undo steps");
  assert.equal(cursor.edit.text, "");
});

test("a new edit after undo clears the redo stack", () => {
  let session = createComposerEditSession("");
  session = applyTrackedComposerEditOp(session, { type: "insert", text: "a" }, 0);
  const undone = undoComposerEdit(session);
  const branched = applyTrackedComposerEditOp(undone, { type: "insert", text: "z" }, 1_000);
  assert.equal(redoComposerEdit(branched).edit.text, "z", "redo is unavailable once history branches");
});

test("undo/redo on empty history are total no-ops", () => {
  const session = createComposerEditSession("hello", 3);
  assert.deepEqual(undoComposerEdit(session), session);
  assert.deepEqual(redoComposerEdit(session), session);
});

test("moving the cursor never creates an undo checkpoint", () => {
  let session = createComposerEditSession("hello", 0);
  session = applyTrackedComposerEditOp(session, { type: "move-right" }, 0);
  session = applyTrackedComposerEditOp(session, { type: "move-word-right" }, 0);
  assert.equal(session.undo.past.length, 0, "cursor motion has nothing to undo");
});

// ---------------------------------------------------------------------------
// Width-aware wrapped layout — CJK/emoji cursor positioning
// ---------------------------------------------------------------------------

test("wrapped rows never exceed the width budget except a single over-wide grapheme", () => {
  const text = "中中中中中"; // 5 double-width graphemes
  const layout = wrapComposerLines(text, 0, 4);
  for (const row of layout.rows) {
    const cells = graphemes(row.text).length * 2;
    assert.ok(cells <= 4, `row "${row.text}" must fit in 4 columns`);
  }
  assert.equal(layout.rows.map((r) => r.text).join(""), text);
});

test("the cursor's displayColumn accounts for wide CJK graphemes, not grapheme count", () => {
  const text = "a中b"; // a=1 col, 中=2 cols, b=1 col
  const layout = wrapComposerLines(text, 3, 80); // caret after all three graphemes
  assert.equal(layout.cursor.row, 0);
  assert.equal(layout.cursor.column, 3);
  assert.equal(layout.cursor.displayColumn, 4, "1 + 2 + 1 columns before the caret");
});

test("a ZWJ emoji cluster stays one indivisible unit under wrapping", () => {
  const text = "ab👩‍💻cd";
  const units = graphemes(text);
  const layout = wrapComposerLines(text, units.length, 3);
  const rejoined = layout.rows.map((r) => r.text).join("");
  assert.equal(rejoined, text, "no row split the emoji cluster into surrogate halves");
});

test("caret at an exact width-wrap boundary is reported at column 0 of the next row", () => {
  const layout = wrapComposerLines("abcd", 3, 3); // "abc" fills row 0 exactly, "d" wraps
  assert.equal(layout.rows.length, 2);
  assert.equal(layout.cursor.row, 1);
  assert.equal(layout.cursor.column, 0);
});

test("caret at the true end of a wrap-boundary-filled document stays on the last row", () => {
  const layout = wrapComposerLines("abc", 3, 3); // exactly one full row, cursor at the very end
  assert.equal(layout.rows.length, 1);
  assert.equal(layout.cursor.row, 0);
  assert.equal(layout.cursor.column, 3);
});

test("wrapping an empty buffer yields one empty row and a total, non-throwing result", () => {
  const layout = wrapComposerLines("", 0, 10);
  assert.deepEqual(layout.rows, [{ start: 0, end: 0, text: "" }]);
  assert.deepEqual(layout.cursor, { row: 0, column: 0, displayColumn: 0 });
  assert.doesNotThrow(() => wrapComposerLines("anything", -5, 0));
  assert.doesNotThrow(() => wrapComposerLines("anything", 999, 999));
});

test("a trailing newline produces a final empty row, matching composer.ts's own line accounting", () => {
  const layout = wrapComposerLines("abc\n", 4, 80);
  assert.equal(layout.rows.length, 2);
  assert.equal(layout.rows[1].text, "");
  assert.equal(layout.cursor.row, 1);
  assert.equal(layout.cursor.column, 0);
});

// ---------------------------------------------------------------------------
// Reverse-search re-export — composed, not re-implemented
// ---------------------------------------------------------------------------

test("the re-exported reverse-search primitives compose end to end through this module", () => {
  const history = ["git status", "git commit -am fix", "grep -r todo"];
  let search = beginReverseSearch(history, "draft", "git");
  assert.equal(search.matches.length, 2);
  search = stepReverseSearch(search);
  assert.equal(search.matches[search.matchIndex], "git status");
  assert.equal(acceptReverseSearch(search), "git status");
  assert.equal(cancelReverseSearch(search), "draft");
});

// ---------------------------------------------------------------------------
// Totality sweep
// ---------------------------------------------------------------------------

test("every ComposerEditOp is total on an empty buffer and at cursor extremes", () => {
  const ops: ComposerEditOp[] = [
    { type: "insert", text: "x" },
    { type: "newline" },
    { type: "delete-backward" },
    { type: "delete-forward" },
    { type: "delete-word-backward" },
    { type: "delete-word-forward" },
    { type: "kill-line-start" },
    { type: "kill-line-end" },
    { type: "yank" },
    { type: "move-left" },
    { type: "move-right" },
    { type: "move-up" },
    { type: "move-down" },
    { type: "move-line-start" },
    { type: "move-line-end" },
    { type: "move-document-start" },
    { type: "move-document-end" },
    { type: "move-word-left" },
    { type: "move-word-right" },
  ];
  const fixtures: ComposerEditState[] = [
    createComposerEditState(""),
    createComposerEditState("x", 0),
    createComposerEditState("hello world", 11),
    createComposerEditState("multi\nline\ntext", 6),
  ];
  for (const fixture of fixtures) {
    for (const op of ops) {
      assert.doesNotThrow(() => applyComposerEditOp(fixture, op), `${op.type} on "${fixture.text}"`);
    }
  }
});
