import test from "node:test";
import assert from "node:assert/strict";
import {
  createStreamGrowth,
  flushStreamGrowth,
  pushStreamGrowth,
  type StreamGrowthState,
} from "./streamGrowth.js";

// Small, fast-to-reason-about thresholds for most tests — the production
// defaults are exercised separately below.
const OPTS = { minIntervalMs: 100, minChars: 20 };

test("a below-threshold chunk does not surface", () => {
  const start = createStreamGrowth();
  // Establish a baseline surface first so the "does nothing arrive" case
  // below isn't conflated with the always-surfaces-once-never-surfaced path.
  const first = pushStreamGrowth(start, "hello ", 0, OPTS);
  assert.equal(first.changed, true);
  assert.equal(first.text, "hello ");

  // A short chunk, no time elapsed: crosses neither the 20-char nor the
  // 100ms threshold.
  const second = pushStreamGrowth(first.state, "wor", 10, OPTS);
  assert.equal(second.changed, false);
  assert.equal(second.text, "hello "); // unchanged from the caller's point of view
  assert.equal(second.state.accumulated, "hello wor"); // but nothing was lost internally
});

test("crossing the char threshold surfaces the coalesced text", () => {
  const start = createStreamGrowth();
  const first = pushStreamGrowth(start, "hello ", 0, OPTS);
  // "world, this " is 12 chars; pendingChars was 0 after the first surface,
  // so this alone doesn't cross 20 — the next call needs to push it over.
  const second = pushStreamGrowth(first.state, "world, this ", 10, OPTS);
  assert.equal(second.changed, false);
  const third = pushStreamGrowth(second.state, "is long enough", 20, OPTS);
  // pendingChars is now 12 + 14 = 26 >= 20: the char threshold fires even
  // though only 20ms have elapsed (well under the 100ms time threshold).
  assert.equal(third.changed, true);
  assert.equal(third.text, "hello world, this is long enough");
  assert.equal(third.state.pendingChars, 0);
});

test("the time threshold fires independently of the char threshold", () => {
  const start = createStreamGrowth();
  const first = pushStreamGrowth(start, "hi", 0, OPTS);
  assert.equal(first.changed, true);

  // Only 2 chars pending (well under 20), but 150ms elapsed (over the 100ms
  // floor) — should surface on time alone.
  const second = pushStreamGrowth(first.state, "!!", 150, OPTS);
  assert.equal(second.changed, true);
  assert.equal(second.text, "hi!!");
});

test("the char threshold fires even at elapsed time 0", () => {
  const start = createStreamGrowth();
  const first = pushStreamGrowth(start, "a".repeat(5), 1000, OPTS);
  assert.equal(first.changed, true);
  // Same timestamp as the surface above (elapsed 0ms, nowhere near the
  // 100ms floor) but the chunk alone is over the 20-char floor.
  const second = pushStreamGrowth(first.state, "b".repeat(25), 1000, OPTS);
  assert.equal(second.changed, true);
  assert.equal(second.text, "a".repeat(5) + "b".repeat(25));
});

test("the changed flag is false when nothing arrived", () => {
  const start = createStreamGrowth();
  const first = pushStreamGrowth(start, "settled text", 0, OPTS);
  assert.equal(first.changed, true);

  // An empty chunk is a no-op regardless of how much time has passed.
  const noop = pushStreamGrowth(first.state, "", 10_000, OPTS);
  assert.equal(noop.changed, false);
  assert.equal(noop.text, "settled text");
  assert.deepEqual(noop.state, first.state);

  // Flushing a state with nothing pending is also a no-op.
  const flushed = flushStreamGrowth(first.state, 10_000);
  assert.equal(flushed.changed, false);
  assert.equal(flushed.text, "settled text");
});

test("flush surfaces the remainder without waiting for a threshold", () => {
  const start = createStreamGrowth();
  const first = pushStreamGrowth(start, "hello ", 0, OPTS);
  const pending = pushStreamGrowth(first.state, "wor", 5, OPTS);
  assert.equal(pending.changed, false); // below both thresholds, as above

  const flushed = flushStreamGrowth(pending.state, 5);
  assert.equal(flushed.changed, true);
  assert.equal(flushed.text, "hello wor");
  assert.equal(flushed.state.pendingChars, 0);
  assert.equal(flushed.state.surfaced, flushed.state.accumulated);
});

test("the elision cap holds under a huge input and keeps both head and tail", () => {
  const opts = { minIntervalMs: 0, minChars: 0, maxRetainedChars: 100, headChars: 20, tailChars: 20 };
  let state: StreamGrowthState = createStreamGrowth();
  let now = 0;
  let lastText = "";
  // Push a large, uniquely-addressable input in small chunks so head/tail
  // provenance is unambiguous: chunk i is the 6-char token "K0042 " etc.
  const totalChunks = 500;
  for (let i = 0; i < totalChunks; i++) {
    const chunk = `K${String(i).padStart(4, "0")} `; // 6 chars each, 3000 chars total
    const update = pushStreamGrowth(state, chunk, now, opts);
    state = update.state;
    lastText = update.text;
    now += 1;
  }
  const flushed = flushStreamGrowth(state, now);
  const finalText = flushed.changed ? flushed.text : lastText;

  // Retained text never grows without bound even though 3000 raw chars were
  // fed in against a 100-char cap.
  assert.ok(finalText.length < 500, `expected an elided, bounded string, got ${finalText.length} chars`);
  // The very first token pushed is still visible at the head...
  assert.ok(finalText.startsWith("K0000"), finalText.slice(0, 20));
  // ...and the very last token pushed is still visible at the tail.
  assert.ok(finalText.trimEnd().endsWith(`K${String(totalChunks - 1).padStart(4, "0")}`), finalText.slice(-20));
  // ...with an explicit marker in between so the gap reads as intentional,
  // not as corrupted/truncated data.
  assert.ok(finalText.includes("elided"), finalText);
  assert.equal(state.rawChars, totalChunks * 6);
});

test("elision keeps a stable head across repeated elision passes", () => {
  const opts = { minIntervalMs: 0, minChars: 0, maxRetainedChars: 30, headChars: 10, tailChars: 10 };
  let state: StreamGrowthState = createStreamGrowth();
  let head: string | undefined;
  for (let i = 0; i < 50; i++) {
    const update = pushStreamGrowth(state, `chunk-${i}-`, i, opts);
    state = update.state;
    if (update.text.includes("elided")) {
      const thisHead = update.text.slice(0, 10);
      if (head === undefined) head = thisHead;
      else assert.equal(thisHead, head, `head drifted at chunk ${i}`);
    }
  }
});

test("production defaults surface promptly for a slow drip and coalesce a fast burst", () => {
  // Slow local-model cadence: one ~15-char chunk every 40ms, comfortably
  // over the 33ms default time floor, so growth still looks continuous.
  let state = createStreamGrowth();
  let now = 0;
  let surfaces = 0;
  for (let i = 0; i < 10; i++) {
    const update = pushStreamGrowth(state, "token chunk here", now);
    state = update.state;
    if (update.changed) surfaces++;
    now += 40;
  }
  assert.ok(surfaces >= 8, `expected most drips to surface promptly, got ${surfaces}/10`);

  // Fast cloud-model burst: many tiny chunks with no time passing at all —
  // only the char threshold can save this from a render per chunk.
  let burstState = createStreamGrowth();
  let burstSurfaces = 0;
  for (let i = 0; i < 200; i++) {
    const update = pushStreamGrowth(burstState, "xx", 0);
    burstState = update.state;
    if (update.changed) burstSurfaces++;
  }
  assert.ok(burstSurfaces < 200, `expected coalescing to reduce surface count, got ${burstSurfaces}/200`);
});
