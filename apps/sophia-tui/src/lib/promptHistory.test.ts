import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PromptHistory } from "./promptHistory.js";

// PromptHistory is pure logic (no React), so it tests directly. The arrow-up/down
// Recall model mirrors shells: up=older (no wrap), down=newer,
// down-past-end restores the in-progress draft.

function makeTempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sophia-prompt-history-"));
  return path.join(dir, "prompt_history.jsonl");
}

test("PromptHistory: up() recalls older entries; stops at oldest without wrapping", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("first");
  h.push("second");
  h.push("third");
  // cursor starts at live position (=== entries.length)
  assert.equal(h.up("draft"), "third");
  assert.equal(h.up(""), "second");
  assert.equal(h.up(""), "first");
  assert.equal(h.up(""), null, "already at oldest — no wrap");
});

test("PromptHistory: down() moves newer; past newest restores the saved draft", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("a");
  h.push("b");
  h.push("c");
  // Walk up to oldest, capturing the live draft on the way in. Each
  // subsequent up() is passed exactly the entry just shown (the real caller
  // always forwards the box's actual content, and here the user hasn't
  // edited anything) so it must NOT be mistaken for an edit.
  assert.equal(h.up("MY DRAFT"), "c");
  assert.equal(h.up("c"), "b");
  assert.equal(h.up("b"), "a");
  // Walk back down.
  assert.equal(h.down(), "b");
  assert.equal(h.down(), "c");
  assert.equal(h.down(), "MY DRAFT", "past newest restores the saved draft");
  assert.equal(h.down(), null, "already at live position");
  assert.ok(h.isLive());
});

test("PromptHistory: editing a recalled entry preserves the edit as the draft instead of discarding it on the next navigation step", () => {
  // Regression: up() used to only read currentDraft on the very first
  // transition out of the live position. Editing a recalled entry and then
  // pressing up() again replaced the draft with an unedited history entry,
  // silently losing the edit forever (down()-past-newest could never recover it).
  const h = new PromptHistory({ file: undefined });
  h.push("alpha");
  h.push("beta");
  h.push("gamma");
  assert.equal(h.up(""), "gamma");
  const edited = "gamma-typo-fixed";
  // Continue navigating older; the real caller always forwards the box's
  // *actual* current text, which is now the edited line, not "gamma".
  assert.equal(h.up(edited), "beta");
  assert.equal(h.up("beta"), "alpha");
  // Walk back down to the live position: the edit must resurface.
  assert.equal(h.down(), "beta");
  assert.equal(h.down(), "gamma");
  assert.equal(h.down(), edited, "editing a recalled entry must not silently discard the edit");
});

test("PromptHistory: down() also preserves an in-place edit when the caller passes the current draft", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("one");
  h.push("two");
  assert.equal(h.up(""), "two");
  const edited = "two-edited";
  // Edit the recalled entry, then press Down (past newest) immediately —
  // no further Up in between.
  assert.equal(
    h.down(edited),
    edited,
    "an edit made before down()-past-newest must survive, not the stale pre-navigation draft",
  );
});

test("PromptHistory: down(currentDraft) omitted keeps the old no-edit-detection behavior (backward compatible)", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("one");
  h.push("two");
  assert.equal(h.up("pre-nav draft"), "two");
  // Caller doesn't pass a draft (e.g. not yet wired) — falls back to
  // restoring whatever was captured on the way into history.
  assert.equal(h.down(), "pre-nav draft");
});

test("PromptHistory: up() from an empty prompt recalls the newest entry, and down()-past-newest restores the exact empty draft", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("first");
  h.push("second");
  assert.equal(h.up(""), "second", "up() from an empty live draft recalls the newest entry");
  assert.equal(h.down(), "", "down()-past-newest must restore the exact pre-navigation draft, including an empty one");
  assert.ok(h.isLive());
});

test("PromptHistory: down() at the live position is a no-op when history was never entered", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("only-entry");
  assert.ok(h.isLive());
  assert.equal(h.down(), null, "never navigated into history — nothing to recall going 'newer'");
  assert.equal(h.down("whatever"), null, "still a no-op even if a currentDraft happens to be passed");
});

test("PromptHistory: push() resets to live position and clears saved draft", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("one");
  h.up("draft-in-progress"); // enter history
  assert.ok(!h.isLive());
  h.push("two"); // submitting a new line must return to live
  assert.ok(h.isLive());
  assert.equal(h.down(), null, "no draft to restore after push()");
  assert.equal(h.up(""), "two"); // newest entry is the just-pushed one
});

test("PromptHistory: dedupes consecutive duplicates (shell convention)", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("ls");
  h.push("ls"); // consecutive duplicate — dropped
  h.push("ls");
  h.push("pwd");
  h.push("ls"); // non-consecutive duplicate — kept
  assert.deepEqual(h.entries, ["ls", "pwd", "ls"]);
});

test("PromptHistory: empty/whitespace-only pushes are ignored", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("");
  h.push("   ");
  h.push("\t\n");
  assert.deepEqual(h.entries, []);
  assert.equal(h.up("anything"), null);
});

test("PromptHistory: respects the cap (oldest evicted FIFO)", () => {
  const h = new PromptHistory({ cap: 3, file: undefined });
  h.push("a");
  h.push("b");
  h.push("c");
  h.push("d"); // evicts "a"
  assert.deepEqual(h.entries, ["b", "c", "d"]);
  // Cursor indexes stay valid after eviction.
  assert.equal(h.up("draft"), "d");
  assert.equal(h.up(""), "c");
  assert.equal(h.up(""), "b");
  assert.equal(h.up(""), null);
});

test("PromptHistory: persistence — push() appends to the jsonl file", () => {
  const file = makeTempFile();
  try {
    const h = new PromptHistory({ file });
    h.push("alpha");
    h.push("beta");
    const raw = readFileSync(file, "utf8").trim().split(/\n/);
    assert.equal(raw.length, 2);
    assert.deepEqual(raw.map((l) => JSON.parse(l).t), ["alpha", "beta"]);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("PromptHistory: constructor loads prior entries from disk", () => {
  const file = makeTempFile();
  try {
    // Seed a history file in the on-disk format.
    writeFileSync(
      file,
      JSON.stringify({ t: "old-1" }) + "\n" + JSON.stringify({ t: "old-2" }) + "\n",
      "utf8",
    );
    const h = new PromptHistory({ file });
    assert.deepEqual(h.entries, ["old-1", "old-2"]);
    assert.equal(h.up("draft"), "old-2");
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("PromptHistory: corrupt lines in the file are skipped (best-effort)", () => {
  const file = makeTempFile();
  try {
    writeFileSync(
      file,
      JSON.stringify({ t: "good-1" }) + "\nCORRUPT_NOT_JSON\n" + JSON.stringify({ t: "good-2" }) + "\n",
      "utf8",
    );
    const h = new PromptHistory({ file });
    // The corrupt line is treated as legacy raw text (trimmed) — accepted, not crashing.
    // The key property: load never throws and the good lines survive.
    assert.ok(h.entries.includes("good-1"));
    assert.ok(h.entries.includes("good-2"));
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("PromptHistory: missing file just starts empty (no throw)", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "ph-")), "nonexistent.jsonl");
  try {
    const h = new PromptHistory({ file });
    assert.deepEqual(h.entries, []);
    assert.equal(h.up("draft"), null);
    // push creates the file on first write.
    h.push("first");
    assert.ok(existsSync(file));
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("PromptHistory: resetToLive() exits history navigation without clearing entries", () => {
  const h = new PromptHistory({ file: undefined });
  h.push("x");
  h.up("draft");
  assert.ok(!h.isLive());
  h.resetToLive();
  assert.ok(h.isLive());
  assert.deepEqual(h.entries, ["x"]);
  assert.equal(h.down(), null, "draft was cleared on reset");
});
