import test from "node:test";
import assert from "node:assert/strict";
import { enterFullscreen, isFullscreen, leaveFullscreen } from "./fullscreen.js";

/** A stand-in for process.stdout that records what was written to it. */
function fakeTty(isTTY: boolean) {
  const writes: string[] = [];
  return {
    stream: { isTTY, write: (s: string) => { writes.push(s); return true; } } as unknown as NodeJS.WriteStream,
    writes,
  };
}

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

test("entering a TTY takes the alternate screen and hides the cursor", (t) => {
  t.after(() => leaveFullscreen(fakeTty(true).stream));
  const { stream, writes } = fakeTty(true);
  enterFullscreen(stream);
  assert.equal(isFullscreen(), true);
  const out = writes.join("");
  assert.ok(out.includes(ENTER_ALT), "did not switch to the alternate screen");
  assert.ok(out.includes(HIDE_CURSOR), "left the cursor visible over the TUI");
});

test("leaving restores the cursor BEFORE returning to the main screen", () => {
  const { stream, writes } = fakeTty(true);
  enterFullscreen(stream);
  writes.length = 0;
  leaveFullscreen(stream);
  const out = writes.join("");
  assert.ok(out.includes(SHOW_CURSOR) && out.includes(LEAVE_ALT));
  // Order matters: restoring the cursor after leaving the alt screen can leave
  // the user's shell with an invisible cursor, which survives the process.
  assert.ok(out.indexOf(SHOW_CURSOR) < out.indexOf(LEAVE_ALT),
    `cursor must be restored before leaving the alt screen: ${JSON.stringify(out)}`);
  assert.equal(isFullscreen(), false);
});

test("a non-TTY is never switched — piping must not emit escape codes", () => {
  // `sophia --version | cat` or a CI capture must produce clean text, not
  // alt-screen sequences that corrupt the pipe.
  const { stream, writes } = fakeTty(false);
  enterFullscreen(stream);
  assert.equal(writes.length, 0, `wrote escapes to a non-TTY: ${JSON.stringify(writes)}`);
  assert.equal(isFullscreen(), false);
});

test("entering twice does not double-write, and leaving twice is a no-op", () => {
  const { stream, writes } = fakeTty(true);
  enterFullscreen(stream);
  const afterFirst = writes.length;
  enterFullscreen(stream);
  assert.equal(writes.length, afterFirst, "re-entering pushed a second alt-screen frame");

  leaveFullscreen(stream);
  const afterLeave = writes.length;
  leaveFullscreen(stream);
  assert.equal(writes.length, afterLeave,
    "leaving when already left wrote LEAVE_ALT again — that pops the user's own alt screen");
  assert.equal(isFullscreen(), false);
});

test("a write that throws cannot take the process down", () => {
  // stdout can EPIPE the moment the terminal goes away; a TUI that dies while
  // cleaning up leaves the terminal in exactly the broken state cleanup exists
  // to prevent.
  const exploding = {
    isTTY: true,
    write: () => { throw new Error("EPIPE"); },
  } as unknown as NodeJS.WriteStream;
  assert.doesNotThrow(() => enterFullscreen(exploding));
  assert.doesNotThrow(() => leaveFullscreen(exploding));
});
