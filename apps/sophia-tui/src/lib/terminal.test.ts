import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import {
  graphemes,
  sanitizeTerminalText,
} from "../components/PromptInput.js";
import { normalizeBridgeEvent, validateBridgeCwd } from "./bridge.js";
import {
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  TerminalInputDecoder,
  disableMouse,
  enableMouse,
} from "./mouse.js";

test("sanitizes ANSI escapes and controls while preserving printable text", () => {
  assert.equal(sanitizeTerminalText("ok\x1b[31m red\x1b[0m\x07\n"), "ok red");
  assert.equal(sanitizeTerminalText("line\nnext"), "linenext");
  assert.equal(sanitizeTerminalText("line\nnext", true), "line\nnext");
  assert.equal(sanitizeTerminalText("safe\u009b31m red\u009b0m"), "safe red");
  assert.equal(
    sanitizeTerminalText("before\u009d52;c;c2VjcmV0\u009cafter"),
    "beforeafter",
  );
});

test("edits Unicode by grapheme cluster rather than UTF-16 code unit", () => {
  const units = graphemes("A👩‍💻é");
  assert.deepEqual(units, ["A", "👩‍💻", "é"]);
  assert.equal(units.slice(0, 2).join("") + units.slice(3).join(""), "A👩‍💻");
});

test("decodes wheel reports and preserves adjacent printable text", () => {
  const decoder = new TerminalInputDecoder();
  const result = decoder.feed("before\x1b[<64;12;8Mafter", true);
  assert.equal(result.text, "beforeafter");
  assert.equal(result.mouse, true);
  assert.deepEqual(result.events, [{
    kind: "wheel_up", button: 0, x: 12, y: 8,
    shift: false, meta: false, ctrl: false,
  }]);
  assert.deepEqual(decoder.feed("\x1b[<65;12;8M", true).events[0], {
    kind: "wheel_down", button: 1, x: 12, y: 8,
    shift: false, meta: false, ctrl: false,
  });
});

test("preserves Shift on application-reported drags and distinguishes hover motion", () => {
  const decoder = new TerminalInputDecoder();
  assert.deepEqual(decoder.feed("\x1b[<36;12;8M", true).events[0], {
    kind: "drag", button: 0, x: 12, y: 8,
    shift: true, meta: false, ctrl: false,
  });
  assert.deepEqual(decoder.feed("\x1b[<35;12;8M", true).events[0], {
    kind: "move", button: 3, x: 12, y: 8,
    shift: false, meta: false, ctrl: false,
  });
});

test("swallows the exact prefix-stripped click and drag reports seen live", () => {
  const decoder = new TerminalInputDecoder();
  const result = decoder.feed(
    "[<32;33;28M[<32;32;28M[<32;31;28M[<32;31;27M[<0;31;27M[<0;31;27m",
    true,
  );
  assert.equal(result.text, "");
  assert.equal(result.mouse, true);
  assert.deepEqual(result.events.map((event) => event.kind), [
    "drag", "drag", "drag", "drag", "click", "release",
  ]);
});

test("buffers an isolated Escape before Ink-delivered SGR suffix", () => {
  const decoder = new TerminalInputDecoder();
  assert.deepEqual(decoder.feed("\x1b", true), { text: "", events: [], mouse: false });
  const result = decoder.feed("[<32;33;28M", true);
  assert.equal(result.text, "");
  assert.equal(result.events[0]?.kind, "drag");
});

test("handles every split boundary and multiple reports", () => {
  const report = "\x1b[<64;12;8M";
  for (let split = 1; split < report.length; split += 1) {
    const decoder = new TerminalInputDecoder();
    const first = decoder.feed(report.slice(0, split), true);
    const second = decoder.feed(report.slice(split), true);
    assert.equal(first.text + second.text, "", `split ${split}`);
    assert.equal(first.events.length + second.events.length, 1, `split ${split}`);
  }
  const decoder = new TerminalInputDecoder();
  assert.equal(decoder.feed("\x1b[<64;1;2M\x1b[<65;1;2M", true).events.length, 2);
});

test("bare reports are mode-scoped without dropping malformed literal text", () => {
  const nativeDecoder = new TerminalInputDecoder();
  assert.equal(nativeDecoder.feed("[<32;33;28M", false).text, "[<32;33;28M");
  const mouseDecoder = new TerminalInputDecoder();
  assert.equal(mouseDecoder.feed("[<32;33;28M", true).text, "");
  assert.equal(mouseDecoder.feed("[<32;abc", true).text, "[<32;abc");
  assert.equal(mouseDecoder.feed("x", true).text, "x");
  assert.equal(mouseDecoder.feed("[<32;abcMhello", true).text, "[<32;abcMhello");
});

test("consumes legacy X10 reports without leaking encoded bytes", () => {
  const decoder = new TerminalInputDecoder();
  assert.deepEqual(decoder.feed("\x1b[M !!hello", true), {
    text: "hello", events: [], mouse: true,
  });
});

test("mouse tracking emits balanced opt-in terminal modes", () => {
  const writes: string[] = [];
  const stream = { isTTY: true, write: (value: string) => { writes.push(value); return true; } } as any;
  disableMouse(stream);
  enableMouse(stream);
  enableMouse(stream);
  disableMouse(stream);
  assert.deepEqual(writes, [ENABLE_MOUSE, DISABLE_MOUSE]);
});

test("normalizes nested bridge envelopes", () => {
  assert.deepEqual(normalizeBridgeEvent({
    type: "bridge_event", event: { type: "event", event: { type: "ready" } },
  }), { type: "ready" });
  assert.equal(normalizeBridgeEvent(null), null);
  assert.equal(normalizeBridgeEvent("not an event"), null);
});

test("accepts any existing workspace cwd and rejects missing directories", () => {
  const root = process.cwd();
  assert.equal(validateBridgeCwd(root, root), path.resolve(root));
  assert.equal(validateBridgeCwd(root, path.dirname(root)), path.resolve(path.dirname(root)));
  // The message must LEAD with the recovery: a transcript row truncates at the
  // pane edge, so a "<label>: <long path>" shape showed only the half that
  // carries no information. Assert both halves are present and that the
  // instruction precedes the path.
  assert.throws(
    () => validateBridgeCwd(root, path.join(root, "does-not-exist")),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /workspace folder is missing/);
      assert.match(message, /--cwd/);
      assert.ok(
        message.indexOf("--cwd") < message.indexOf("does-not-exist"),
        `recovery instruction must precede the path: ${message}`,
      );
      return true;
    },
  );
});
