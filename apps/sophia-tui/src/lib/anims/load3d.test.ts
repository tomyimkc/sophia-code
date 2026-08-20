import test from "node:test";
import assert from "node:assert/strict";
import { LOAD_ANIMS, LOAD_ANIM_IDS, makeLoadAnim, DEFAULT_LOAD_ANIM, DEFAULT_FIELD_ANIM } from "./load3d.js";
import { LOAD_HEIGHT } from "./types.js";
import { MATRIX_GLYPHS, glyph } from "./cells.js";

const W = 40;
const H = LOAD_HEIGHT;

test("field continuity: every cell of a 12×40 frame is defined (no holes)", () => {
  for (const id of ["circular-ripple", "circular-3d", "radial-bloom", "light-tunnel"]) {
    const anim = makeLoadAnim(id);
    assert.ok(anim, `missing anim ${id}`);
    const frame = anim!.render(17, W, "starting");
    assert.equal(frame.length, H, `${id}: height`);
    for (let y = 0; y < H; y++) {
      assert.equal(frame[y].length, W, `${id}: row ${y} width`);
      for (let x = 0; x < W; x++) {
        const c = frame[y][x];
        assert.ok(c && typeof c.ch === "string" && c.ch.length >= 1, `${id}: cell ${x},${y} undefined`);
        assert.ok(c.r >= 0 && c.r <= 255 && c.g >= 0 && c.g <= 255 && c.b >= 0 && c.b <= 255, `${id}: rgb out of range`);
      }
    }
  }
});

test("every registered load anim renders a full w×12 frame across ticks", () => {
  for (const id of LOAD_ANIM_IDS) {
    const anim = makeLoadAnim(id)!;
    for (const f of [0, 1, 5, 60]) {
      const frame = anim.render(f, W, "tool");
      assert.equal(frame.length, H, `${id}@${f}: height`);
      for (const row of frame) {
        assert.equal(row.length, W, `${id}@${f}: width`);
        for (const c of row) assert.ok(c && c.ch.length >= 1, `${id}@${f}: hole`);
      }
    }
  }
});

test("defaults exist in the registry", () => {
  assert.ok(LOAD_ANIMS[DEFAULT_LOAD_ANIM]);
  assert.ok(LOAD_ANIMS[DEFAULT_FIELD_ANIM]);
  assert.equal(makeLoadAnim("does-not-exist"), null);
});

test("renders are deterministic (no Math.random in the render path)", () => {
  for (const id of ["circular-ripple", "dot-chain-helix", "particle-flow"]) {
    const anim = makeLoadAnim(id)!;
    assert.deepEqual(anim.render(42, W, "tool"), anim.render(42, W, "tool"), `${id} nondeterministic`);
  }
});

test("dot-chain beads stay in bounds and the frame advances over time", () => {
  const anim = makeLoadAnim("dot-chain-sine")!;
  const f0 = anim.render(0, W, "tool").map((r) => r.map((c) => c.ch).join(""));
  const f30 = anim.render(30, W, "tool").map((r) => r.map((c) => c.ch).join(""));
  assert.equal(f0.length, H);
  assert.notDeepEqual(f0, f30, "chain must move between ticks");
});

test("matrix glyph alphabet wraps without producing garbage", () => {
  // Tick-derived noise indexes can be negative or huge; glyph() must wrap.
  for (const i of [-97, -1, 0, 1, 999983]) {
    const ch = glyph(i);
    assert.ok(MATRIX_GLYPHS.includes(ch), `glyph(${i}) = "${ch}" not in alphabet`);
  }
});
