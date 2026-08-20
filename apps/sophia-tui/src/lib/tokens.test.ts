import test from "node:test";
import assert from "node:assert/strict";
import { contextFillPercent, describeContextUsage, formatTokens } from "./tokens.js";

test("token counts stay short enough not to reflow a narrow status line", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(9499), "9.5k");
  // At/above 10k the decimal is dropped so the field never exceeds 5 chars —
  // "412k", not "412.3k".
  assert.equal(formatTokens(412_336), "412k");
  assert.equal(formatTokens(400_000), "400k");
  assert.equal(formatTokens(1_500_000), "1.5M");
  for (const n of [0, 999, 1000, 9999, 412_336, 999_999, 1_500_000, 12_000_000]) {
    assert.ok(formatTokens(n).length <= 5, `${n} -> ${formatTokens(n)} is too wide`);
  }
});

test("a nonsense count renders as unknown rather than as a number", () => {
  // A fabricated 0 would read as "the context is empty", which is a different
  // and wrong claim.
  assert.equal(formatTokens(Number.NaN), "?");
  assert.equal(formatTokens(-1), "?");
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), "?");
});

test("context fill is null when the window is unknown, never a made-up percentage", () => {
  // grok-4.5 declares 500k; a model that declares nothing must render nothing
  // rather than a confident number with nothing behind it.
  assert.equal(contextFillPercent(200_000, 500_000), 40);
  assert.equal(contextFillPercent(400_000, 500_000), 80);
  assert.equal(contextFillPercent(0, 500_000), 0);

  assert.equal(contextFillPercent(1000, null), null);
  assert.equal(contextFillPercent(1000, undefined), null);
  assert.equal(contextFillPercent(1000, 0), null);
  assert.equal(contextFillPercent(Number.NaN, 500_000), null);
});

test("fill is clamped so an over-budget history cannot report above 100%", () => {
  assert.equal(contextFillPercent(600_000, 500_000), 100);
});

test("context usage reads as a percentage when the window is known", () => {
  assert.equal(describeContextUsage(200_000, 500_000), "context 40% of 500k");
  assert.equal(describeContextUsage(0, 500_000), "context 0% of 500k");
});

test("an unknown window degrades to a bare count, never a fake percentage", () => {
  // A model that declares no window must not be reported as "0% of 0".
  assert.equal(describeContextUsage(12_345, undefined), "context 12k");
});

test("an unusable estimate renders nothing at all", () => {
  // "" means the caller shows no status. A fabricated 0% would read as
  // "plenty of room" — the opposite of the truth if the estimate failed on a
  // huge history.
  assert.equal(describeContextUsage(undefined, 500_000), "");
  assert.equal(describeContextUsage(Number.NaN, 500_000), "");
  assert.equal(describeContextUsage(-1, 500_000), "");
});

test("approaching the compaction budget is called out before it fires", () => {
  // 80% of the window is where turns start being folded; "62% of 500k" alone
  // does not tell you how close that is.
  assert.match(describeContextUsage(390_000, 500_000, 400_000), /compaction near/);
  assert.ok(!describeContextUsage(100_000, 500_000, 400_000).includes("compaction near"));
});
