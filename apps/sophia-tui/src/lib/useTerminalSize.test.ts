import assert from "node:assert/strict";
import { test } from "node:test";
import { ellipsizeEnd, hr, modelDisplayName } from "./useTerminalSize.js";

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate must be followed by a low surrogate
      const next = s.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // low surrogate must be preceded by a high surrogate
      const prev = s.charCodeAt(i - 1);
      if (i === 0 || prev < 0xd800 || prev > 0xdbff) return true;
    }
  }
  return false;
}

test("ellipsizeEnd never splits a surrogate pair or grapheme cluster, at any truncation width", () => {
  // "👩‍💻" is a woman + ZWJ + laptop ZWJ sequence: 5 UTF-16 code units for
  // one visual glyph. A naive `.slice()` on code-unit offsets can land mid
  // sequence and emit a lone surrogate, which renders as a broken glyph.
  const s = "abcdefgh👩‍💻ijklmnop";
  for (let max = 3; max <= 20; max += 1) {
    const out = ellipsizeEnd(s, max);
    assert.equal(hasLoneSurrogate(out), false, `max=${max} produced ${JSON.stringify(out)}`);
  }
});

test("ellipsizeEnd keeps the tail and prefixes an ellipsis when truncating", () => {
  assert.equal(ellipsizeEnd("short", 20), "short");
  assert.equal(ellipsizeEnd("a/very/long/path/to/file.ts", 12), "…/to/file.ts");
});

test("ellipsizeEnd handles degenerate max values without throwing", () => {
  assert.equal(ellipsizeEnd("abc", 0), "…");
  assert.equal(ellipsizeEnd("abc", 1), "…");
  assert.equal(ellipsizeEnd("", 5), "");
});

test("hr repeats within a bounded minimum even for a very small or zero width", () => {
  assert.equal(hr(0), "─".repeat(8));
  assert.equal(hr(-5), "─".repeat(8));
  assert.equal(hr(3), "─".repeat(8));
  assert.equal(hr(10).length, 10);
});

test("modelDisplayName leaves a short spec untouched when it already fits", () => {
  assert.equal(modelDisplayName("mock", 40), "mock");
  assert.equal(modelDisplayName("zai", 40), "zai");
  assert.equal(modelDisplayName("codex-api", 40), "codex-api");
});

test("modelDisplayName shortens a long on-disk model path to its basename", () => {
  const long = "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit";
  assert.equal(modelDisplayName(long, 30), "Qwen3.6-35B-A3B-4bit");
});

test("modelDisplayName falls back to an honest ellipsis when even the basename doesn't fit", () => {
  const long = "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit";
  const out = modelDisplayName(long, 10);
  assert.ok([...out].length <= 10, `expected <=10 graphemes, got ${JSON.stringify(out)}`);
  assert.ok(out.startsWith("…"), "an honest truncation, not a silent mid-word cut");
});

test("modelDisplayName never returns more graphemes than the budget, across a sweep", () => {
  const long = "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit";
  for (const budget of [1, 2, 3, 4, 5, 8, 12, 20, 30, 50]) {
    const out = modelDisplayName(long, budget);
    assert.ok(
      [...out].length <= budget,
      `budget=${budget} produced ${JSON.stringify(out)} (${[...out].length} graphemes)`,
    );
  }
});

test("modelDisplayName treats a trailing slash / Windows-style separators as path-like too", () => {
  assert.equal(modelDisplayName("codex:C:\\models\\big-checkpoint", 20), "big-checkpoint");
});

test("modelDisplayName keeps the model, not the API version, for an endpoint spec", () => {
  // "vllm:<model>@<base-url>" is the spec shape every locally served model uses.
  // The basename rule alone returned "v1" — the /v1 path segment of the base URL —
  // so the status row named the API version instead of the model answering.
  const spec = "vllm:mlx-community--Qwen3-4B-Instruct-2507-4bit@http://127.0.0.1:8000/v1";
  const identity = "vllm:mlx-community--Qwen3-4B-Instruct-2507-4bit";

  // Wide enough for the identity but not the endpoint: drop only the endpoint.
  assert.equal(modelDisplayName(spec, identity.length), identity);

  // Too narrow for even the identity: still never collapses to the URL tail.
  const squeezed = modelDisplayName(spec, 20);
  assert.notEqual(squeezed, "v1");
  assert.ok(squeezed.includes("…"), `expected an elision, got ${squeezed}`);
  assert.ok([...squeezed].length <= 20, `over budget: ${squeezed}`);
});

test("modelDisplayName still prefers the leaf of a plain on-disk model path", () => {
  const onDisk = "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit";
  assert.equal(modelDisplayName(onDisk, 24), "Qwen3.6-35B-A3B-4bit");
});
