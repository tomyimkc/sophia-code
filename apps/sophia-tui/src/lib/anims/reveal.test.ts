import test from "node:test";
import assert from "node:assert/strict";
import { displayWidth } from "../textWidth.js";
import { MATRIX_GLYPHS } from "./cells.js";
import {
  MATRIX_REVEAL_CHURN_DELAY_MS,
  MATRIX_REVEAL_CURSOR_TAIL,
  MATRIX_REVEAL_MAX_COMMIT_TICKS,
  MATRIX_REVEAL_MAX_PRESENTATION_TPS,
  MATRIX_REVEAL_MIN_COMMIT_TICKS,
  MATRIX_REVEAL_MIN_PRESENTATION_TPS,
  MATRIX_REVEAL_PENDING_FRAME,
  advanceMatrixRevealState,
  commonGraphemePrefix,
  createMatrixRevealState,
  matrixRevealCells,
  matrixRevealCommitTicks,
  matrixRevealDelayMs,
  matrixRevealFramesBySegment,
  matrixRevealFramesRequired,
  syncMatrixRevealState,
} from "./index.js";

function shown(opts: Parameters<typeof matrixRevealCells>[0]): string {
  return matrixRevealCells(opts).map((cell) => cell.display).join("");
}

test("matrix reveal keeps the already visible prefix literal on every frame", () => {
  const previousText = "already committed ";
  const text = `${previousText}new sentence`;
  const required = matrixRevealFramesRequired(text, previousText);
  for (let frame = 0; frame <= required; frame += 1) {
    assert.ok(
      shown({ text, previousText, frame, seed: 17 }).startsWith(previousText),
      `frame ${frame} must not re-scramble committed text`,
    );
  }
});

test("matrix reveal types final text behind a short matrix cursor tail", () => {
  const previousText = "prefix ";
  const text = "prefix matrix sentence";
  const early = matrixRevealCells({ text, previousText, frame: 0, seed: 3 });
  const middle = matrixRevealCells({ text, previousText, frame: 3, seed: 3 });
  const finalFrame = matrixRevealFramesRequired(text, previousText);
  const final = matrixRevealCells({
    text,
    previousText,
    frame: finalFrame,
    seed: 3,
  });

  assert.ok(early.some((cell) => cell.live), "the cursor starts in matrix form");
  assert.ok(
    early.filter((cell) => cell.live).length <= MATRIX_REVEAL_CURSOR_TAIL,
    "only the short cursor tail should be green",
  );
  assert.ok(
    early.slice(previousText.length + MATRIX_REVEAL_CURSOR_TAIL)
      .every((cell) => cell.display.trim() === "" && !cell.live),
    "future observed text stays invisible instead of turning green",
  );
  assert.equal(
    middle.slice(0, previousText.length + 3)
      .map((cell) => cell.display).join(""),
    text.slice(0, previousText.length + 3),
    "committed characters appear immediately in their final style",
  );
  assert.equal(final.map((cell) => cell.display).join(""), text);
  assert.ok(final.every((cell) => !cell.live));
});

test("matrix reveal is deterministic and does not reserve future layout width", () => {
  const opts = {
    text: "wide 中文 text 42",
    previousText: "wide ",
    frame: 1,
    seed: 99,
  };
  assert.deepEqual(matrixRevealCells(opts), matrixRevealCells(opts));
  assert.ok(
    displayWidth(shown(opts)) < displayWidth(opts.text),
    "unrevealed text must not reserve future terminal columns",
  );
  assert.equal(
    matrixRevealCells(opts).map((cell) => cell.source).join(""),
    opts.text,
    "the source receipt remains exactly the observed text",
  );
});

test("matrix reveal stand-ins are ASCII English letters or binary digits", () => {
  assert.equal(MATRIX_GLYPHS, "ABCDEFGHIJKLMNOPQRSTUVWXYZ01");
  const cells = matrixRevealCells({
    text: "English matrix 101",
    previousText: "",
    frame: 0,
    seed: 41,
  });
  const live = cells.filter((cell) => cell.live);
  assert.ok(live.length > 0);
  for (const cell of live) {
    assert.match(cell.display.trim(), /^[A-Z01]$/);
    assert.notEqual(
      cell.display.trim().toLocaleLowerCase("en-US"),
      cell.source.toLocaleLowerCase("en-US"),
      "the source token itself must never be painted green",
    );
  }
});

test("green frontier stand-ins change on every high-frequency churn tick", () => {
  const base = {
    text: "Matrix",
    previousText: "",
    frame: 0,
    seed: 41,
  };
  const first = shown({ ...base, churnFrame: 0 });
  const second = shown({ ...base, churnFrame: 1 });
  const third = shown({ ...base, churnFrame: 2 });

  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.match(first, /^[A-Z01]+$/);
  assert.match(second, /^[A-Z01]+$/);
  assert.match(third, /^[A-Z01]+$/);
});

test("unrevealed newlines and wrapped rows do not exist ahead of the frontier", () => {
  const text = "first\nsecond";
  assert.doesNotMatch(
    shown({ text, previousText: "", frame: 2, churnFrame: 3 }),
    /\n/,
  );
  assert.match(
    shown({ text, previousText: "", frame: 6, churnFrame: 8 }),
    /\n/,
  );
  assert.equal(
    shown({
      text: "future row",
      previousText: "",
      frame: MATRIX_REVEAL_PENDING_FRAME,
      churnFrame: 10,
    }),
    "",
  );
});

test("commonGraphemePrefix handles multi-code-point graphemes as one unit", () => {
  assert.equal(commonGraphemePrefix("A 👩‍💻", "A 👩‍💻 builds"), 3);
});

test("matrix reveal commits the full arrived suffix without a 15–25 tok/s cap", () => {
  const text = "x".repeat(240);
  assert.equal(matrixRevealFramesRequired(text, ""), 240);
  let state = createMatrixRevealState(text, true, false);
  state = advanceMatrixRevealState(state);
  assert.equal(state.previousText, text);
  assert.equal(state.frame, 0);
});

test("wrapped rows share one left-to-right frontier instead of decoding together", () => {
  const current = ["first", "second", "third"];
  const previous = ["", "", ""];

  assert.deepEqual(matrixRevealFramesBySegment(current, previous, 3), [3, -2, -8]);
  assert.deepEqual(matrixRevealFramesBySegment(current, previous, 7), [7, 2, -4]);
  assert.deepEqual(matrixRevealFramesBySegment(current, previous, 13), [13, 8, 2]);
});

test("presentation cadence is uncapped and follows the 20 ms redraw quantum", () => {
  const state = createMatrixRevealState(
    "Fast hacker cadence with randomized visual tokens",
    true,
    false,
  );
  assert.equal(matrixRevealDelayMs(state), MATRIX_REVEAL_CHURN_DELAY_MS);
  assert.equal(matrixRevealCommitTicks(state), MATRIX_REVEAL_MIN_COMMIT_TICKS);
  const rate = 1_000 / (MATRIX_REVEAL_MIN_COMMIT_TICKS * MATRIX_REVEAL_CHURN_DELAY_MS);
  assert.ok(rate > 25);
  assert.equal(MATRIX_REVEAL_MIN_PRESENTATION_TPS, 0);
  assert.equal(MATRIX_REVEAL_MAX_PRESENTATION_TPS, Number.POSITIVE_INFINITY);
});

test("fast streaming appends keep the already committed prefix", () => {
  let state = createMatrixRevealState("mat", true, false);
  state = advanceMatrixRevealState(state);
  assert.equal(state.previousText, "mat");
  state = syncMatrixRevealState(state, "matrix tokens arrived", false);
  assert.equal(state.previousText, "mat");
  assert.equal(state.text, "matrix tokens arrived");
  assert.equal(state.frame, 0);
});

test("each text surface advances independently so later work can animate in parallel", () => {
  const first = createMatrixRevealState("first reply", true, false);
  const second = createMatrixRevealState("tool call", true, false);
  let firstAdvanced = first;
  let secondAdvanced = second;
  for (
    let tick = 0;
    tick < MATRIX_REVEAL_MAX_COMMIT_TICKS;
    tick += 1
  ) {
    firstAdvanced = advanceMatrixRevealState(firstAdvanced);
    secondAdvanced = advanceMatrixRevealState(secondAdvanced);
  }

  assert.equal(firstAdvanced.previousText, "first reply");
  assert.equal(second.previousText, "");
  assert.equal(secondAdvanced.previousText, "tool call");
});

test("reduced motion settles immediately and advancing eventually commits exact text", () => {
  const reduced = createMatrixRevealState("still", true, true);
  assert.deepEqual(reduced, {
    text: "still",
    previousText: "still",
    frame: 0,
    churnFrame: 0,
    ticksSinceCommit: 0,
  });

  let animated = createMatrixRevealState("done", true, false);
  for (let index = 0; index < 8 && animated.previousText !== "done"; index += 1) {
    animated = advanceMatrixRevealState(animated);
  }
  assert.deepEqual(animated, {
    text: "done",
    previousText: "done",
    frame: 0,
    churnFrame: animated.churnFrame,
    ticksSinceCommit: 0,
  });
});
