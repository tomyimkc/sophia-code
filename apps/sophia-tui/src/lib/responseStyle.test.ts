import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyResponseStyleCommand,
  normalizeResponseStyle,
  parseResponseStyleCommand,
} from "./responseStyle.js";

test("normalizes only the approved response styles", () => {
  assert.equal(normalizeResponseStyle(" Structured "), "structured");
  assert.equal(normalizeResponseStyle("CONCISE"), "concise");
  assert.equal(normalizeResponseStyle("verbose"), null);
  assert.equal(normalizeResponseStyle(undefined), null);
});

test("a bare response-style slash asks App to open the picker", () => {
  assert.deepEqual(parseResponseStyleCommand("/response-style"), { kind: "picker" });
  assert.deepEqual(parseResponseStyleCommand("/style  "), { kind: "picker" });
});

test("a response-style slash with an approved value applies it", () => {
  assert.deepEqual(parseResponseStyleCommand("/style concise"), {
    kind: "apply",
    responseStyle: "concise",
  });
  assert.deepEqual(applyResponseStyleCommand("/response-style structured", "adaptive"), {
    handled: true,
    responseStyle: "structured",
    openPicker: false,
    error: null,
  });
});

test("an invalid style is handled without changing the current style", () => {
  assert.deepEqual(applyResponseStyleCommand("/style verbose", "adaptive"), {
    handled: true,
    responseStyle: "adaptive",
    openPicker: false,
    error: "Unknown response style: verbose",
  });
});

test("unrelated slashes, especially /continue, remain untouched", () => {
  assert.equal(parseResponseStyleCommand("/continue"), null);
  assert.deepEqual(applyResponseStyleCommand("/continue", "concise"), {
    handled: false,
    responseStyle: "concise",
    openPicker: false,
    error: null,
  });
});
