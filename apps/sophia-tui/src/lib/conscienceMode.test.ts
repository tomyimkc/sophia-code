import test from "node:test";
import assert from "node:assert/strict";
import {
  conscienceModeFromBridge,
  resolveConscienceCommand,
} from "./conscienceMode.js";

test("bridge aliases normalize to four explicit delivery modes", () => {
  assert.equal(conscienceModeFromBridge("floor"), "floor");
  assert.equal(conscienceModeFromBridge("off"), "off");
  assert.equal(conscienceModeFromBridge("report"), "report");
  assert.equal(conscienceModeFromBridge("advisory"), "report");
  assert.equal(conscienceModeFromBridge("default"), "off");
  assert.equal(conscienceModeFromBridge("strict"), "strict");
  assert.equal(conscienceModeFromBridge("on"), "strict");
  assert.equal(conscienceModeFromBridge("surprise"), null);
});

test("/conscience off disables final-text gate evaluation", () => {
  const result = resolveConscienceCommand("off", "strict");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "off");
  assert.equal(result.changed, true);
  assert.match(result.text, /final-text conscience\/provenance evaluation: off/);
  assert.match(result.text, /Tool permissions/);
});

test("/conscience report evaluates without withholding", () => {
  const result = resolveConscienceCommand("report", "strict");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "report");
  assert.match(result.text, /checks never withhold/);
  assert.match(result.text, /delivered unchanged/);
});

test("/conscience strict arms the optional epistemic tier", () => {
  const result = resolveConscienceCommand("strict", "floor");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "strict");
  assert.match(result.text, /strict provenance enforcement/);
  assert.match(result.text, /hard-prohibition floor: enforced/);
});

test("/conscience floor enforces only hard prohibitions", () => {
  const result = resolveConscienceCommand("floor", "report");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "floor");
  assert.match(result.text, /hard-floor enforcement/);
  assert.match(result.text, /uncertainty tier: evaluated but not enforced/);
});

test("status is read-only and invalid actions fail without changing mode", () => {
  const status = resolveConscienceCommand("status", "strict");
  assert.equal(status.changed, false);
  assert.equal(status.mode, "strict");

  const invalid = resolveConscienceCommand("disable-everything", "report");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.changed, false);
  assert.equal(invalid.mode, "report");
  assert.equal(invalid.text, "usage: /conscience off|report|floor|strict|status");
});
