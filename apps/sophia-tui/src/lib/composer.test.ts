import assert from "node:assert/strict";
import test from "node:test";

import {
  composerCursorLocation,
  composerViewport,
  createComposerState,
  normalizeComposerText,
  reduceComposer,
  shouldNavigateHistory,
} from "./composer.js";
import { displayWidth, graphemes } from "./textWidth.js";

test("composer preserves real newlines and normalizes all platform line endings", () => {
  assert.equal(normalizeComposerText("one\r\ntwo\rthree"), "one\ntwo\nthree");
  const state = createComposerState("one\r\ntwo");
  assert.equal(state.text, "one\ntwo");
  assert.equal(composerCursorLocation(state).lineCount, 2);
});

test("insert/newline/backspace edit by grapheme rather than UTF-16 code unit", () => {
  let state = createComposerState("A👩‍💻B", 2);
  state = reduceComposer(state, { type: "newline" });
  assert.equal(state.text, "A👩‍💻\nB");
  assert.equal(state.cursor, 3);
  state = reduceComposer(state, { type: "delete-backward" });
  assert.equal(state.text, "A👩‍💻B");
  state = reduceComposer(state, { type: "delete-backward" });
  assert.equal(state.text, "AB", "the complete ZWJ emoji is deleted as one unit");
});

test("vertical movement keeps a sticky terminal column across short and wide lines", () => {
  // First line: a(1) + 中(2) + b(1), second: x, third: 12345.
  let state = createComposerState("a中b\nx\n12345", 3);
  assert.equal(composerCursorLocation(state).displayColumn, 4);
  state = reduceComposer(state, { type: "move-down" });
  assert.equal(composerCursorLocation(state).line, 1);
  assert.equal(composerCursorLocation(state).displayColumn, 1);
  state = reduceComposer(state, { type: "move-down" });
  assert.equal(composerCursorLocation(state).line, 2);
  assert.equal(composerCursorLocation(state).displayColumn, 4);
});

test("line/document movement and line kills operate on the active logical line", () => {
  let state = createComposerState("alpha\nbeta\ngamma", graphemes("alpha\nbe").length);
  state = reduceComposer(state, { type: "move-line-end" });
  assert.equal(composerCursorLocation(state).column, 4);
  state = reduceComposer(state, { type: "kill-line-start" });
  assert.equal(state.text, "alpha\n\ngamma");
  state = reduceComposer(state, { type: "move-document-end" });
  state = reduceComposer(state, { type: "kill-line-start" });
  assert.equal(state.text, "alpha\n\n");
  state = reduceComposer(state, { type: "move-document-start" });
  assert.equal(state.cursor, 0);
});

test("delete-word-backward crosses Unicode text without splitting clusters", () => {
  const word = "hello👩‍💻";
  let state = createComposerState(`${word} 世界`);
  state = reduceComposer(state, { type: "delete-word-backward" });
  assert.equal(state.text, `${word} `);
  state = reduceComposer(state, { type: "delete-word-backward" });
  assert.equal(state.text, "");
});

test("multiline arrows reserve history only at the document edges", () => {
  const text = "one\ntwo\nthree";
  assert.equal(shouldNavigateHistory(createComposerState(text, 1), "previous"), true);
  assert.equal(shouldNavigateHistory(createComposerState(text, 5), "previous"), false);
  assert.equal(shouldNavigateHistory(createComposerState(text, 5), "next"), false);
  assert.equal(shouldNavigateHistory(createComposerState(text), "next"), true);
});

test("composer viewport stays column-bounded and keeps the caret visible", () => {
  const state = createComposerState("first\n你好嗎abc\nlast", graphemes("first\n你好").length);
  const viewport = composerViewport(state, 5, 3);
  assert.equal(viewport.lineCount, 3);
  assert.equal(viewport.rows.length, 3);
  const active = viewport.rows.find((row) => row.hasCursor);
  assert.ok(active);
  assert.ok(displayWidth(active.text) <= 5);
  assert.notEqual(active.cursorGrapheme, "");
  assert.ok(active.truncatedStart || active.truncatedEnd, "the wide line is horizontally windowed");
});
