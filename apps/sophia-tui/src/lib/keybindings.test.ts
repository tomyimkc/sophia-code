import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptReverseSearch,
  beginReverseSearch,
  cancelReverseSearch,
  canonicalKeyChord,
  currentReverseSearchMatch,
  keyChord,
  resolveKeyAction,
  reverseSearchMatches,
  stepReverseSearch,
  updateReverseSearch,
} from "./keybindings.js";

test("portable chord normalization is independent of operating-system spelling", () => {
  assert.equal(canonicalKeyChord("Control + R"), "ctrl+r");
  assert.equal(canonicalKeyChord("Option+Return"), "alt+enter");
  assert.equal(canonicalKeyChord("Command+Shift+P"), "meta+shift+p");
  assert.equal(keyChord("", { return: true, shift: true }), "shift+enter");
  assert.equal(keyChord("R", { ctrl: true }), "ctrl+r");
  assert.equal(keyChord("\x12", { ctrl: true }), "ctrl+r", "raw Ctrl+R control byte is portable too");
});

test("default keymap submits Enter but reserves shifted/alt Enter for real newlines", () => {
  assert.equal(resolveKeyAction("\n", { return: true }), "submit");
  assert.equal(resolveKeyAction("\n", { return: true, shift: true }), "insert-newline");
  assert.equal(resolveKeyAction("\n", { return: true, meta: true }), "insert-newline");
  assert.equal(resolveKeyAction("", { upArrow: true }), "history-previous");
});

test("Ink's key.delete (ASCII DEL 0x7f / CSI 3~) deletes backward on every platform", () => {
  // Ink 6 reports Backspace (0x7f) as key.delete with empty input on Linux
  // and the key labelled Delete the same way on macOS. Prefer backward
  // deletion so the composer is usable; forward-delete stays on Ctrl+D.
  for (const platform of ["macos", "linux", "windows", "other"] as const) {
    assert.equal(keyChord("", { delete: true }, platform), "backspace");
    assert.equal(
      resolveKeyAction("", { delete: true }, "default", "insert", platform),
      "delete-backward",
    );
  }
  assert.equal(
    resolveKeyAction("", { backspace: true }, "default", "insert", "macos"),
    "delete-backward",
  );
  assert.equal(
    resolveKeyAction("", { backspace: true }, "default", "insert", "linux"),
    "delete-backward",
  );
});

test("Emacs-compatible mode exposes the expected navigation/edit subset", () => {
  assert.equal(resolveKeyAction("a", { ctrl: true }, "emacs"), "move-line-start");
  assert.equal(resolveKeyAction("e", { ctrl: true }, "emacs"), "move-line-end");
  assert.equal(resolveKeyAction("b", { ctrl: true }, "emacs"), "move-left");
  assert.equal(resolveKeyAction("f", { ctrl: true }, "emacs"), "move-right");
  assert.equal(resolveKeyAction("p", { ctrl: true }, "emacs"), "history-previous");
  assert.equal(resolveKeyAction("n", { ctrl: true }, "emacs"), "history-next");
  assert.equal(resolveKeyAction("u", { ctrl: true }, "emacs"), "kill-line-start");
});

test("Vim-compatible mode keeps insert/normal bindings explicit", () => {
  assert.equal(resolveKeyAction("", { escape: true }, "vim", "insert"), "vim-normal");
  assert.equal(resolveKeyAction("h", {}, "vim", "normal"), "move-left");
  assert.equal(resolveKeyAction("j", {}, "vim", "normal"), "move-down");
  assert.equal(resolveKeyAction("x", {}, "vim", "normal"), "delete-forward");
  assert.equal(resolveKeyAction("i", {}, "vim", "normal"), "vim-insert");
  assert.equal(resolveKeyAction("a", {}, "vim", "normal"), "vim-append");
  assert.equal(resolveKeyAction("z", {}, "vim", "normal"), null, "unbound normal-mode text is not inserted");
});

test("custom overrides win and null explicitly disables a built-in chord", () => {
  const config = {
    mode: "default" as const,
    overrides: {
      "ctrl+enter": "submit" as const,
      "alt+enter": null,
    },
  };
  assert.equal(resolveKeyAction("\n", { return: true, ctrl: true }, config), "submit");
  assert.equal(resolveKeyAction("\n", { return: true, meta: true }, config), null);
});

test("reverse search is newest-first, case-insensitive, and deduplicated", () => {
  const history = ["git status", "npm test", "Git log", "git status"];
  assert.deepEqual(reverseSearchMatches(history, "GIT"), ["git status", "Git log"]);
});

test("reverse search updates, steps older without wrapping, accepts, and cancels", () => {
  const history = ["alpha one", "beta", "alpha two"];
  let state = beginReverseSearch(history, "draft", "alpha");
  assert.equal(currentReverseSearchMatch(state), "alpha two");
  state = stepReverseSearch(state);
  assert.equal(currentReverseSearchMatch(state), "alpha one");
  state = stepReverseSearch(state);
  assert.equal(currentReverseSearchMatch(state), "alpha one", "oldest match does not wrap");
  assert.equal(acceptReverseSearch(state), "alpha one");
  assert.equal(cancelReverseSearch(state), "draft");

  state = updateReverseSearch(state, history, "missing");
  assert.equal(currentReverseSearchMatch(state), null);
  assert.equal(acceptReverseSearch(state), "draft");
});
