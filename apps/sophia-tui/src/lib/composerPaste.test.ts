import assert from "node:assert/strict";
import test from "node:test";

import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  BracketedPasteDecoder,
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  createPasteReview,
  disableBracketedPaste,
  enableBracketedPaste,
  inputRequiresPasteReview,
} from "./composerPaste.js";

test("decodes adjacent text and bracketed paste without submitting either", () => {
  const decoder = new BracketedPasteDecoder();
  assert.deepEqual(
    decoder.feed(`before${BRACKETED_PASTE_START}one\ntwo${BRACKETED_PASTE_END}after`),
    [
      { kind: "text", text: "before" },
      {
        kind: "paste",
        text: "one\ntwo",
        bracketed: true,
        reviewRequired: true,
        incomplete: false,
      },
      { kind: "text", text: "after" },
    ],
  );
});

test("handles every split boundary in both bracketed-paste markers", () => {
  const wire = `${BRACKETED_PASTE_START}α\n👩‍💻${BRACKETED_PASTE_END}`;
  for (let split = 1; split < wire.length; split += 1) {
    const decoder = new BracketedPasteDecoder();
    const events = decoder.feed(wire.slice(0, split)).concat(decoder.feed(wire.slice(split)));
    assert.deepEqual(events, [{
      kind: "paste",
      text: "α\n👩‍💻",
      bracketed: true,
      reviewRequired: true,
      incomplete: false,
    }], `split=${split}`);
  }
});

test("accepts C1 and Ink prefix-stripped paste markers", () => {
  const c1 = new BracketedPasteDecoder();
  assert.equal(c1.feed("\x9b200~hello\x9b201~")[0]?.kind, "paste");
  const bare = new BracketedPasteDecoder();
  assert.deepEqual(bare.feed("[200~hello[201~"), [{
    kind: "paste",
    text: "hello",
    bracketed: true,
    reviewRequired: true,
    incomplete: false,
  }]);
});

test("an unterminated paste flushes as incomplete review-required content", () => {
  const decoder = new BracketedPasteDecoder();
  assert.deepEqual(decoder.feed(`${BRACKETED_PASTE_START}do not run\n`), []);
  assert.deepEqual(decoder.flush(), [{
    kind: "paste",
    text: "do not run\n",
    bracketed: true,
    reviewRequired: true,
    incomplete: true,
  }]);
});

test("paste review identifiers are deterministic and contain no pasted content", () => {
  const first = createPasteReview("line one\nline two");
  const second = createPasteReview("line one\r\nline two");
  assert.equal(first.id, second.id);
  assert.equal(first.lineCount, 2);
  assert.equal(first.reason, "Bracketed paste must be reviewed before submission.");
  assert.ok(!first.id.includes("line"));
});

test("bracketed pastes always require review; unmarked single-line typing does not", () => {
  assert.equal(inputRequiresPasteReview("hello", false), false);
  assert.equal(inputRequiresPasteReview("hello\nworld", false), true);
  assert.equal(inputRequiresPasteReview("hello", true), true);
});

test("terminal mode writes are TTY-only and reference-counted", () => {
  const writes: string[] = [];
  const stream = {
    isTTY: true,
    write(value: string) {
      writes.push(value);
      return true;
    },
  };
  assert.equal(enableBracketedPaste(stream), true);
  assert.equal(enableBracketedPaste(stream), true);
  assert.equal(disableBracketedPaste(stream), true);
  assert.deepEqual(writes, [ENABLE_BRACKETED_PASTE]);
  assert.equal(disableBracketedPaste(stream), true);
  assert.deepEqual(writes, [ENABLE_BRACKETED_PASTE, DISABLE_BRACKETED_PASTE]);

  const notTty = { isTTY: false, write: () => { throw new Error("must not write"); } };
  assert.equal(enableBracketedPaste(notTty), false);
});
