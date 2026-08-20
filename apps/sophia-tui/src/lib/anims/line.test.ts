import test from "node:test";
import assert from "node:assert/strict";
import {
  LIFE,
  LOCK_BASE,
  renderMatrixDecode,
  renderDecode,
  DECODE_STYLES,
  DECODE_STYLE_IDS,
  tokenize,
  advanceFrontier,
  tickFrontier,
  EMPTY_FRONTIER,
} from "./line.js";
import { STABLE_TEXT_RGB } from "./cells.js";

/** Render a row and return just its visible text. */
function rowText(row: { ch: string }[]): string {
  return row.map((c) => c.ch).join("").trimEnd();
}

test("committed text never changes glyph while a later token scrambles", () => {
  const committed = "The adapter stays";
  const a = renderMatrixDecode({ committed, currentToken: "still", localFrame: 0, tick: 100, width: 40 });
  const b = renderMatrixDecode({ committed, currentToken: "still", localFrame: 3, tick: 190, width: 40 });
  // The committed prefix must render as the same real characters at every
  // tick — re-scrambling it would lie that the model is regenerating text
  // it already emitted.
  const prefixA = rowText(a).slice(0, committed.length);
  const prefixB = rowText(b).slice(0, committed.length);
  assert.equal(prefixA, committed);
  assert.equal(prefixB, committed);
});

test("committed cells carry the stable colour, not the live green", () => {
  const row = renderMatrixDecode({ committed: "abc", currentToken: "", localFrame: 0, tick: 1, width: 10 });
  assert.deepEqual([row[0].r, row[0].g, row[0].b], [...STABLE_TEXT_RGB]);
  assert.notEqual(row[0].bold, true);
});

test("matrix-family decode alphabets contain no Japanese glyphs", () => {
  for (const id of ["matrix", "cyber", "glitch", "rtl"]) {
    assert.match(DECODE_STYLES[id].glyphs, /^[A-Za-z01]+$/, `${id} must stay ASCII-only`);
  }
});

test("the in-flight token scrambles, then locks left-to-right", () => {
  const committed = "";
  const token = "lock";
  // Frame 0: nothing locked yet — every char is a scrambling glyph.
  const f0 = renderMatrixDecode({ committed, currentToken: token, localFrame: 0, tick: 5, width: 10 });
  for (let i = 0; i < token.length; i++) {
    assert.equal(f0[i].bold, true, `char ${i} should be live/bold at frame 0`);
    assert.notEqual(f0[i].ch, token[i]);
  }
  // Frame LOCK_BASE: first char locked to its real character, rest still live.
  const f4 = renderMatrixDecode({ committed, currentToken: token, localFrame: LOCK_BASE, tick: 5, width: 10 });
  assert.equal(f4[0].ch, token[0]);
  assert.equal(f4[0].bold, undefined);
  assert.equal(f4[1].bold, true);
  // Frame LOCK_BASE + len - 1: the whole token shows its real characters.
  const fFull = renderMatrixDecode({
    committed,
    currentToken: token,
    localFrame: LOCK_BASE + token.length - 1,
    tick: 999,
    width: 10,
  });
  assert.equal(rowText(fFull).slice(0, token.length), token);
});

test("future tokens are absent from the frame", () => {
  // Only committed + currentToken are ever drawn; there is no API surface
  // that could paint text the stream has not emitted yet.
  const row = renderMatrixDecode({ committed: "seen", currentToken: "x", localFrame: 0, tick: 3, width: 8 });
  const text = rowText(row);
  assert.ok(text.startsWith("seen"));
  assert.equal(text.length, "seen".length + 1);
});

test("the row shows the rightmost width chars once the frontier overflows", () => {
  const committed = "0123456789abcdef";
  const row = renderMatrixDecode({ committed, currentToken: "", localFrame: 0, tick: 0, width: 6 });
  assert.equal(rowText(row), "abcdef");
});

test("tokenize produces 2–3 char pieces and keeps whitespace", () => {
  const pieces = tokenize("streaming frontier stays honest");
  assert.ok(pieces.includes(" "));
  for (const p of pieces) {
    if (/^\s+$/.test(p)) continue;
    assert.ok(p.length <= 3, `piece too long: ${p}`);
    assert.ok(p.length >= 1);
  }
  assert.equal(pieces.join(""), "streaming frontier stays honest");
});

test("advanceFrontier: extending preview grows the live token, keeps the partition", () => {
  let st = advanceFrontier(EMPTY_FRONTIER, "The quick");
  assert.equal(st.current, "The quick");
  assert.equal(st.committed, "");
  st = advanceFrontier(st, "The quick brown");
  // new delta " brown" extends current; committed+current partitions the preview
  assert.ok("The quick brown".endsWith(st.current));
  assert.equal(st.committed + st.current, "The quick brown");
});

test("advanceFrontier: a sliding window still yields an honest partition", () => {
  // Simulate the TUI's 240-char sliding preview: the window slides forward
  // (no simple startsWith) once it saturates.
  let st = advanceFrontier(EMPTY_FRONTIER, "0123456789");
  st = advanceFrontier(st, "123456789X");
  // delta vs the old preview is "X"; committed+current partitions the new preview.
  assert.equal(st.committed + st.current, "123456789X");
  assert.equal(st.current, "X");
  assert.equal(st.localFrame, 0);
});

test("advanceFrontier caps the live token; overflow becomes committed", () => {
  let st = advanceFrontier(EMPTY_FRONTIER, "abcdefghij", 4);
  assert.equal(st.current, "ghij");
  assert.equal(st.committed, "abcdef");
});

test("tickFrontier ages the token then folds it into committed at LIFE", () => {
  let st = advanceFrontier(EMPTY_FRONTIER, "hello");
  for (let i = 0; i < LIFE - 1; i++) st = tickFrontier(st);
  assert.equal(st.current, "hello", "still live one frame before LIFE");
  st = tickFrontier(st);
  assert.equal(st.current, "", "folded at LIFE");
  assert.equal(st.committed, "hello");
});

test("tickFrontier is idempotent once the token has folded", () => {
  let st = advanceFrontier(EMPTY_FRONTIER, "hi");
  for (let i = 0; i < LIFE; i++) st = tickFrontier(st);
  assert.equal(st.current, "");
  assert.equal(st.committed, "hi");
  const snapshot = { ...st };
  st = tickFrontier(st);
  assert.deepEqual(st, snapshot);
});

test("render is deterministic: same inputs, same row", () => {
  const opts = { committed: "stable", currentToken: "xy", localFrame: 2, tick: 7, width: 12 };
  assert.deepEqual(renderMatrixDecode(opts), renderMatrixDecode(opts));
});

// ---------------------------------------------------------------------------
// Every decode style must obey the same frontier contract — the aesthetic
// changes, the honesty does not.
// ---------------------------------------------------------------------------

test("every style: committed text never changes glyph while the token scrambles", () => {
  const committed = "settled text stays";
  for (const id of DECODE_STYLE_IDS) {
    for (const [tick, lf] of [[3, 0], [87, 1], [201, 5]] as const) {
      const row = renderDecode(id, { committed, currentToken: "live", localFrame: lf, tick, width: 40 });
      const text = row.map((c) => c.ch).join("");
      assert.ok(text.startsWith(committed), `${id}@tick${tick}: committed mutated -> "${text.slice(0, committed.length)}"`);
    }
  }
});

test("every style: the token fully resolves to its real characters before LIFE", () => {
  // 5 chars is the budget the tightest schedule (LTR, LOCK_BASE 4, LIFE 9)
  // can fully lock; longer live tails pop at fold by design — the handoff's
  // own geometry, unchanged here.
  const token = "resol";
  for (const id of DECODE_STYLE_IDS) {
    const style = DECODE_STYLES[id];
    const fullyLocked = Array.from({ length: token.length }, (_, i) => style.lockedAt(i, token.length, LIFE - 1)).every(Boolean);
    assert.ok(fullyLocked, `${id}: not fully locked at LIFE-1 (fold would snap mid-scramble)`);
    const row = renderDecode(id, { committed: "", currentToken: token, localFrame: LIFE - 1, tick: 50, width: 20 });
    const text = row.map((c) => c.ch).join("");
    assert.ok(text.startsWith(token), `${id}: resolved text mismatch`);
  }
});

test("every style: future tokens absent, rgb in range, deterministic", () => {
  for (const id of DECODE_STYLE_IDS) {
    const opts = { committed: "abc", currentToken: "de", localFrame: 1, tick: 9, width: 10 };
    const a = renderDecode(id, opts);
    const b = renderDecode(id, opts);
    assert.deepEqual(a, b, `${id}: nondeterministic`);
    for (const c of a) {
      assert.ok(c.r >= 0 && c.r <= 255 && c.g >= 0 && c.g <= 255 && c.b >= 0 && c.b <= 255, `${id}: rgb out of range`);
    }
    const len = rowText(a).trimEnd().length;
    const budget = "abc".length + "de".length + (DECODE_STYLES[id].head ? 1 : 0);
    assert.ok(len <= budget, `${id}: drew more than committed+current(+head)`);
  }
});

test("unknown style id falls back to the default (binary)", () => {
  const opts = { committed: "x", currentToken: "y", localFrame: 0, tick: 4, width: 6 };
  assert.deepEqual(renderDecode("nope", opts), renderDecode("binary", opts));
});

test("phosphor appends its head cursor only while a token is live", () => {
  const opts = { committed: "abc", currentToken: "", localFrame: 0, tick: 2, width: 10 };
  const idle = renderDecode("phosphor", opts).map((c) => c.ch).join("");
  assert.ok(!idle.includes("▌"), "head shown with no live token");
  const live = renderDecode("phosphor", { ...opts, currentToken: "de" }).map((c) => c.ch).join("");
  assert.ok(live.includes("▌"), "head missing while token live");
});
