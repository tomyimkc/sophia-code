import assert from "node:assert/strict";
import test from "node:test";

import { TerminalInputDecoder } from "./mouse.js";

test("decodes SGR horizontal wheel directions without changing vertical directions", () => {
  const decoder = new TerminalInputDecoder();
  const result = decoder.feed(
    "\x1b[<64;10;20M\x1b[<65;11;21M\x1b[<66;12;22M\x1b[<67;13;23M",
    true,
  );

  assert.equal(result.text, "");
  assert.equal(result.mouse, true);
  assert.deepEqual(
    result.events.map(({ kind, button, x, y }) => ({ kind, button, x, y })),
    [
      { kind: "wheel_up", button: 0, x: 10, y: 20 },
      { kind: "wheel_down", button: 1, x: 11, y: 21 },
      { kind: "wheel_left", button: 2, x: 12, y: 22 },
      { kind: "wheel_right", button: 3, x: 13, y: 23 },
    ],
  );
});

test("preserves SGR modifiers on horizontal wheel reports", () => {
  const decoder = new TerminalInputDecoder();

  assert.deepEqual(decoder.feed("\x1b[<94;7;9M", true).events[0], {
    kind: "wheel_left",
    button: 2,
    x: 7,
    y: 9,
    shift: true,
    meta: true,
    ctrl: true,
  });
  assert.deepEqual(decoder.feed("\x1b[<75;8;10M", true).events[0], {
    kind: "wheel_right",
    button: 3,
    x: 8,
    y: 10,
    shift: false,
    meta: true,
    ctrl: false,
  });
});

test("buffers horizontal wheel reports across every SGR chunk boundary", () => {
  for (const report of ["\x1b[<94;123;45M", "[<95;321;54M"]) {
    const expectedKind = report.includes("<94;") ? "wheel_left" : "wheel_right";
    for (let split = 1; split < report.length; split += 1) {
      const decoder = new TerminalInputDecoder();
      const first = decoder.feed(report.slice(0, split), true);
      const second = decoder.feed(report.slice(split), true);
      const events = [...first.events, ...second.events];

      assert.equal(first.text + second.text, "", `${report} split ${split}`);
      assert.equal(events.length, 1, `${report} split ${split}`);
      assert.equal(events[0]?.kind, expectedKind, `${report} split ${split}`);
      assert.equal(first.mouse || second.mouse, true, `${report} split ${split}`);
    }
  }
});
