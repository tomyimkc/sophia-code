import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_SOURCE = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

test("My Sophia Code branding shares the first runtime row without a standalone banner", () => {
  assert.doesNotMatch(APP_SOURCE, /components\/Banner/);
  assert.doesNotMatch(APP_SOURCE, /<Banner\b/);
  assert.doesNotMatch(APP_SOURCE, /\bbannerH\b/);
  assert.match(APP_SOURCE, /<StatusLine\b/);
  assert.match(APP_SOURCE, /\bshowBrand\b/);
});

test("live progress owns one row instead of duplicating itself in top chrome", () => {
  assert.match(APP_SOURCE, /const loadH = loadingIndicatorHeight\(progress\);/);
  assert.match(APP_SOURCE, /loadH === 0 \? idleStatus : ""/);
  assert.match(APP_SOURCE, /running=\{running && loadH === 0\}/);
  assert.doesNotMatch(APP_SOURCE, /`backend=\$\{providerHealthWord/);
  assert.doesNotMatch(APP_SOURCE, /`runtime=\$\{executionRuntime\}`/);
  assert.doesNotMatch(APP_SOURCE, /lastCost \? `cost=/);
});
