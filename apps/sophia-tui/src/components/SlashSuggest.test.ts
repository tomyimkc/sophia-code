import test from "node:test";
import assert from "node:assert/strict";

import { resolve } from "../lib/slash.js";
import {
  highlightSegments,
  slashNoMatchMessage,
  slashRowArgumentHint,
  slashRowBadge,
  slashRowBadgeText,
  slashRowCategory,
  slashRowDescription,
  slashRowHighlightRanges,
  slashRowNotWired,
  slashRowShowsArgumentHint,
  slashRowUsage,
  slashSuggestBorderStyle,
} from "./SlashSuggest.js";
import { resolveAccessibility } from "../lib/accessibility.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

function command(line: string) {
  const value = resolve(line).cmd;
  assert.ok(value, `expected ${line} to resolve`);
  return value;
}

test("slash rows expose plain-language category labels and honest execution badges", () => {
  assert.equal(slashRowCategory(command("/resume")), "Sessions");
  assert.equal(slashRowBadge(command("/resume")), "local");
  assert.equal(slashRowBadge(command("/review")), "agent");
  assert.equal(slashRowBadge(command("/contract")), "local");
  assert.equal(slashRowBadge(command("/mobile")), "unavailable");
});

test("slash rows use the exported argument schema for usage help", () => {
  assert.equal(slashRowUsage(command("/resume")), "/resume [session|text]");
  assert.equal(
    slashRowDescription(command("/resume")),
    "Browse or search past sessions by id, topic, or transcript text",
  );
  assert.equal(slashRowUsage(command("/goal")), "/goal <goal>");
  assert.equal(slashRowUsage(command("/clear")), "/clear");
});

test("argument hints strip the leading name and are empty for argument-less commands", () => {
  assert.equal(slashRowArgumentHint(command("/goal")), "<goal>");
  assert.equal(slashRowArgumentHint(command("/resume")), "[session|text]");
  assert.equal(slashRowArgumentHint(command("/clear")), "");
});

test("a local handler is wired; a backend prompt and an unsupported stub are not", () => {
  assert.equal(slashRowNotWired(command("/resume")), false);
  assert.equal(slashRowNotWired(command("/review")), true);
  assert.equal(slashRowNotWired(command("/mobile")), true);
});

test("highlight ranges land on the rendered /name text, shifted past the leading slash", () => {
  const goal = command("/goal");
  const ranges = slashRowHighlightRanges(goal, "/gl");
  assert.ok(ranges.length > 0, "expected /gl to fuzzy-match /goal");
  const slash = goal.slash || "/" + goal.name;
  for (const r of ranges) {
    assert.ok(r.start >= 1 && r.end <= slash.length, `range ${r.start}-${r.end} out of bounds for ${slash}`);
  }
  // Reconstructing the matched characters from the ranges should spell out
  // the typed query in order — that is the entire point of a subsequence
  // highlight, and a silent off-by-one in the slash-offset would break it
  // without failing a bounds check alone.
  const matchedChars = ranges.map((r) => slash.slice(r.start, r.end)).join("").toLowerCase();
  assert.equal(matchedChars, "gl");
});

test("highlight ranges are empty for an empty filter or a filter that does not match", () => {
  const goal = command("/goal");
  assert.deepEqual(slashRowHighlightRanges(goal, ""), []);
  assert.deepEqual(slashRowHighlightRanges(goal, "/"), []);
  assert.deepEqual(slashRowHighlightRanges(goal, "/zzzzz"), []);
});

test("highlightSegments splits matched runs out of the surrounding text", () => {
  assert.deepEqual(highlightSegments("/goal", []), [{ text: "/goal", matched: false }]);
  assert.deepEqual(highlightSegments("", []), []);
  assert.deepEqual(highlightSegments("/goal", [{ start: 1, end: 2 }, { start: 3, end: 4 }]), [
    { text: "/", matched: false },
    { text: "g", matched: true },
    { text: "o", matched: false },
    { text: "a", matched: true },
    { text: "l", matched: false },
  ]);
});

test("did-you-mean recovers a single-edit-away typo and stays silent for gibberish", () => {
  const resumeTypo = slashNoMatchMessage("/resme");
  assert.equal(resumeTypo.guessSlash, "/resume");
  assert.match(resumeTypo.text, /Did you mean \/resume\?/);

  const nothing = slashNoMatchMessage("/xyzzyplugh");
  assert.equal(nothing.guessSlash, null);
  assert.equal(nothing.text, "No command matches “/xyzzyplugh”.");
});

test("badges degrade to a compact glyph below the full-badge width but never disappear", () => {
  const mobile = command("/mobile");
  assert.equal(slashRowBadgeText(80, mobile), "unavailable");
  assert.equal(slashRowBadgeText(58, mobile), "unavailable");
  assert.equal(slashRowBadgeText(57, mobile), "U");
  assert.equal(slashRowBadgeText(1, mobile), "U");
});

test("per-row argument hints stay visible at 80 columns and disappear, not truncate, below the threshold", () => {
  const goal = command("/goal");
  assert.equal(slashRowShowsArgumentHint(80, goal), true);
  assert.equal(slashRowShowsArgumentHint(78, goal), true);
  assert.equal(slashRowShowsArgumentHint(77, goal), false);
  assert.equal(slashRowShowsArgumentHint(40, goal), false);
  // A command with no arguments never shows a hint regardless of width.
  assert.equal(slashRowShowsArgumentHint(200, command("/clear")), false);
});

test("screen-reader mode removes the decorative slash-suggest border", () => {
  assert.equal(slashSuggestBorderStyle(resolveAccessibility(["--ax-screen-reader"], NO_ENV)), undefined);
  assert.equal(slashSuggestBorderStyle(resolveAccessibility([], NO_ENV)), "round");
});
