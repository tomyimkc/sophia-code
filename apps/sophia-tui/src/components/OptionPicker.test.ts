import test from "node:test";
import assert from "node:assert/strict";

import { resolveAccessibility } from "../lib/accessibility.js";
import {
  anyPickerOptionMatches,
  matchPickerOption,
  optionPickerBorderStyle,
  pickerNoMatchMessage,
  splitOptionLabel,
  type PickerOption,
} from "./OptionPicker.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

const OPTIONS: PickerOption[] = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

test("matchPickerOption highlights the label a query fuzzy-matches and returns [] otherwise", () => {
  const sonnetRanges = matchPickerOption({ label: "Sonnet" }, "snt");
  assert.ok(sonnetRanges.length > 0, "expected 'snt' to fuzzy-match 'Sonnet'");
  const matched = sonnetRanges.map((r) => "Sonnet".slice(r.start, r.end)).join("").toLowerCase();
  assert.equal(matched, "snt");

  assert.deepEqual(matchPickerOption({ label: "Sonnet" }, ""), []);
  assert.deepEqual(matchPickerOption({ label: "Sonnet" }, undefined), []);
  assert.deepEqual(matchPickerOption({ label: "Sonnet" }, "zzz"), []);
});

test("splitOptionLabel breaks matched runs out of the label text", () => {
  assert.deepEqual(splitOptionLabel("Opus", []), [{ text: "Opus", matched: false }]);
  assert.deepEqual(splitOptionLabel("", []), []);
  assert.deepEqual(splitOptionLabel("Opus", [{ start: 0, end: 1 }]), [
    { text: "O", matched: true },
    { text: "pus", matched: false },
  ]);
});

test("anyPickerOptionMatches is honest about a query that matches nothing", () => {
  assert.equal(anyPickerOptionMatches(OPTIONS, ""), true);
  assert.equal(anyPickerOptionMatches(OPTIONS, undefined), true);
  assert.equal(anyPickerOptionMatches(OPTIONS, "op"), true);
  assert.equal(anyPickerOptionMatches(OPTIONS, "zzzzz"), false);
});

test("pickerNoMatchMessage names the query that came up empty", () => {
  assert.equal(pickerNoMatchMessage("zzzzz"), "No options match “zzzzz”.");
});

test("screen-reader mode removes the decorative option-picker border", () => {
  assert.equal(optionPickerBorderStyle(resolveAccessibility(["--ax-screen-reader"], NO_ENV)), undefined);
  assert.equal(optionPickerBorderStyle(resolveAccessibility([], NO_ENV)), "round");
});
