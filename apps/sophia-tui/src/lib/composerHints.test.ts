import assert from "node:assert/strict";
import test from "node:test";

import { createComposerState } from "./composer.js";
import { acceptGhostHint, selectGhostHint, type GhostHintCandidate } from "./composerHints.js";
import { graphemes } from "./textWidth.js";

const CANDIDATES: GhostHintCandidate[] = [
  { value: "/permissions", source: "slash" },
  { value: "/panel", source: "slash" },
  { value: "/paste", source: "custom" },
];

test("ghost selection is deterministic regardless of candidate arrival order", () => {
  const cursor = graphemes("/p").length;
  const forward = selectGhostHint("/p", cursor, CANDIDATES);
  const reverse = selectGhostHint("/p", cursor, [...CANDIDATES].reverse());
  assert.deepEqual(forward, reverse);
  assert.equal(forward?.value, "/panel", "shortest suffix wins among the same source/priority");
  assert.equal(forward?.suffix, "anel");
});

test("priority and explicit source rank are deterministic tie breakers", () => {
  const candidates: GhostHintCandidate[] = [
    { value: "@file:README.md", source: "history", scope: "token", priority: 3 },
    { value: "@file:README.md", source: "attachment", scope: "token", priority: 3 },
    { value: "@file:README-long.md", source: "attachment", scope: "token", priority: 4 },
  ];
  const hint = selectGhostHint("inspect @fi", graphemes("inspect @fi").length, candidates);
  assert.equal(hint?.value, "@file:README-long.md", "priority wins before suffix length");
});

test("line and token scopes match only the text immediately before the caret", () => {
  const text = "intro\nopen @im";
  const cursor = graphemes(text).length;
  const hint = selectGhostHint(text, cursor, [
    { value: "@image:\"screen shot.png\"", source: "attachment", scope: "token" },
  ]);
  assert.equal(hint?.suffix, "age:\"screen shot.png\"");
  assert.equal(hint?.replaceFrom, graphemes("intro\nopen ").length);
});

test("exact values, empty queries, multiline suffixes, and wrong case do not ghost", () => {
  assert.equal(selectGhostHint("", 0, CANDIDATES), null);
  assert.equal(selectGhostHint("/panel", graphemes("/panel").length, CANDIDATES), null);
  assert.equal(selectGhostHint("/P", graphemes("/P").length, CANDIDATES), null);
  assert.equal(selectGhostHint("a", 1, [{ value: "a\nb" }]), null);
  assert.equal(
    selectGhostHint("/P", graphemes("/P").length, [{ value: "/Panel", caseSensitive: false }])?.suffix,
    "anel",
  );
});

test("accepting a hint inserts only its suffix at the grapheme caret", () => {
  const state = createComposerState("/p");
  const hint = selectGhostHint(state.text, state.cursor, CANDIDATES);
  const accepted = acceptGhostHint(state, hint);
  assert.equal(accepted.text, "/panel");
  assert.equal(accepted.cursor, graphemes("/panel").length);
});
