import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOsc52,
  copyToClipboard,
  osc52Supported,
  selectAllMessageAndCopy,
  selectCopyTarget,
} from "./clipboard.js";
import type { ChatMessage } from "./types.js";

/** A stand-in for process.stdout that records what was written to it. */
function fakeTty(isTTY: boolean) {
  const writes: string[] = [];
  return {
    stream: { isTTY, write: (s: string) => { writes.push(s); return true; } } as unknown as NodeJS.WriteStream,
    writes,
  };
}

/** Save/restore the env vars osc52Supported reads, so tests are hermetic. */
function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function msg(role: ChatMessage["role"], text: string, id?: string): ChatMessage {
  return { id: id ?? `${role}-${text.length}`, role, text };
}

// ── buildOsc52 ────────────────────────────────────────────────────────────

test("buildOsc52 wraps base64 text in the OSC 52 system-clipboard sequence", () => {
  const seq = buildOsc52("hi");
  assert.ok(seq.startsWith("\x1b]52;c;"), `missing OSC 52 header: ${JSON.stringify(seq)}`);
  assert.ok(seq.endsWith("\x07"), `missing BEL terminator: ${JSON.stringify(seq)}`);
  // base64 payload round-trips back to the original UTF-8 text.
  const payload = seq.slice("\x1b]52;c;".length, -"\x07".length);
  assert.equal(Buffer.from(payload, "base64").toString("utf-8"), "hi");
});

test("buildOsc52 preserves multibyte UTF-8 (emoji + CJK)", () => {
  const text = "café — 你好 🎉";
  const seq = buildOsc52(text);
  const payload = seq.slice("\x1b]52;c;".length, -"\x07".length);
  assert.equal(Buffer.from(payload, "base64").toString("utf-8"), text);
});

// ── osc52Supported ────────────────────────────────────────────────────────

test("osc52Supported is true on a TTY in iTerm2/Ghostty/Kitty/Alacritty", () => {
  for (const tp of ["iTerm.app", "ghostty", "WezTerm", "tmux"]) {
    withEnv({ TERM_PROGRAM: tp }, () => {
      assert.equal(osc52Supported(fakeTty(true).stream), true, `TERM_PROGRAM=${tp}`);
    });
  }
});

test("osc52Supported is false on macOS Terminal.app and VS Code integrated", () => {
  for (const tp of ["Apple_Terminal", "vscode"]) {
    withEnv({ TERM_PROGRAM: tp }, () => {
      assert.equal(osc52Supported(fakeTty(true).stream), false, `TERM_PROGRAM=${tp}`);
    });
  }
});

test("osc52Supported is false on a non-TTY (piping must not emit escapes)", () => {
  withEnv({ TERM_PROGRAM: "iTerm.app" }, () => {
    assert.equal(osc52Supported(fakeTty(false).stream), false);
  });
});

// ── selectCopyTarget ──────────────────────────────────────────────────────

test("selectCopyTarget returns the last assistant reply by default", () => {
  const msgs = [msg("user", "q1"), msg("assistant", "first"), msg("user", "q2"), msg("assistant", "second")];
  const sel = selectCopyTarget(msgs, "");
  assert.equal(sel.ok, true);
  if (sel.ok) {
    assert.equal(sel.text, "second");
    assert.equal(sel.label, "last reply");
  }
});

test("selectCopyTarget: 'reply' and 'last' alias the default", () => {
  const msgs = [msg("assistant", "x")];
  for (const a of ["reply", "last", "REPLY", " last "]) {
    const sel = selectCopyTarget(msgs, a);
    assert.equal(sel.ok, true, `arg=${JSON.stringify(a)}`);
    if (sel.ok) assert.equal(sel.text, "x");
  }
});

test("selectCopyTarget: 'prompt' returns the last user message", () => {
  const msgs = [msg("assistant", "a1"), msg("user", "first-q"), msg("assistant", "a2"), msg("user", "second-q")];
  const sel = selectCopyTarget(msgs, "prompt");
  assert.equal(sel.ok, true);
  if (sel.ok) {
    assert.equal(sel.text, "second-q");
    assert.equal(sel.label, "last prompt");
  }
});

test("selectCopyTarget: integer N returns the Nth visible message (1-based)", () => {
  const msgs = [msg("user", "u1"), msg("assistant", "a1"), msg("system", "s1")];
  const sel = selectCopyTarget(msgs, "2");
  assert.equal(sel.ok, true);
  if (sel.ok) {
    assert.equal(sel.text, "a1");
    assert.match(sel.label, /message #2 \(assistant\)/);
  }
});

test("selectCopyTarget rejects out-of-range and non-numeric args", () => {
  const msgs = [msg("user", "u1"), msg("assistant", "a1")];
  for (const a of ["0", "3", "-1", "foo", "bar"]) {
    const sel = selectCopyTarget(msgs, a);
    assert.equal(sel.ok, false, `arg=${JSON.stringify(a)} should be rejected`);
  }
});

test("selectCopyTarget fails honestly when there is nothing to copy", () => {
  assert.equal(selectCopyTarget([], "").ok, false);
  assert.equal(selectCopyTarget([msg("user", "only-q")], "").ok, false);
  assert.equal(selectCopyTarget([msg("assistant", "only-a")], "prompt").ok, false);
});

// ── copyToClipboard ───────────────────────────────────────────────────────

test("copyToClipboard writes the OSC 52 bytes on a supported terminal", () => {
  withEnv({ TERM_PROGRAM: "iTerm.app", SOPHIA_CLIPBOARD: "osc52" }, () => {
    const { stream, writes } = fakeTty(true);
    // Host runner fails so we exercise the pure OSC path.
    const res = copyToClipboard("payload", stream, () => false);
    assert.equal(res.ok, true);
    assert.equal(res.method, "osc52");
    assert.equal(writes.length, 1);
    assert.ok(writes[0].startsWith("\x1b]52;c;"), `wrote non-OSC-52 bytes: ${JSON.stringify(writes[0])}`);
  });
});

test("copyToClipboard on an unsupported terminal falls back to host runner", () => {
  withEnv({ TERM_PROGRAM: "Apple_Terminal" }, () => {
    const { stream, writes } = fakeTty(true);
    let hostGot = "";
    const res = copyToClipboard("payload", stream, (t) => {
      hostGot = t;
      return true;
    });
    assert.equal(res.ok, true);
    assert.equal(res.method, "host");
    assert.equal(hostGot, "payload");
    assert.equal(writes.length, 0, `must not emit OSC 52 to Terminal.app: ${JSON.stringify(writes)}`);
  });
});

test("copyToClipboard on a non-TTY can still use host runner", () => {
  withEnv({ TERM_PROGRAM: "iTerm.app" }, () => {
    const { stream, writes } = fakeTty(false);
    const res = copyToClipboard("payload", stream, () => true);
    assert.equal(res.ok, true);
    assert.equal(res.method, "host");
    assert.equal(writes.length, 0);
  });
});

test("copyToClipboard survives an EPIPE / closed stdout and still tries host", () => {
  withEnv({ TERM_PROGRAM: "iTerm.app" }, () => {
    const exploding = {
      isTTY: true,
      write: () => {
        throw new Error("EPIPE");
      },
    } as unknown as NodeJS.WriteStream;
    const res = copyToClipboard("x", exploding, () => true);
    assert.equal(res.ok, true);
    assert.equal(res.method, "host");
  });
});

test("selectCopyTarget: selection and focused modes", () => {
  const msgs = [
    msg("user", "u1", "id-u1"),
    msg("assistant", "a1 body", "id-a1"),
    msg("user", "u2", "id-u2"),
  ];
  const sel = selectCopyTarget(msgs, "selection", {
    selection: { anchorId: "id-u1", headId: "id-a1" },
  });
  assert.equal(sel.ok, true);
  if (sel.ok) assert.match(sel.text, /u1[\s\S]*a1 body/);

  const focused = selectCopyTarget(msgs, "focused", { focusedId: "id-a1" });
  assert.equal(focused.ok, true);
  if (focused.ok) assert.equal(focused.text, "a1 body");

  assert.equal(selectCopyTarget(msgs, "selection", { selection: null }).ok, false);
  assert.equal(selectCopyTarget(msgs, "focused", { focusedId: null }).ok, false);
});

test("selectAllMessageAndCopy selects one message and copies its body", () => {
  const msgs = [msg("assistant", "full answer", "id-a")];
  // Non-TTY forces the injected host runner on every OS. With a TTY, macOS
  // correctly stops after OSC 52 succeeds while Linux deliberately dual-writes,
  // which made this body-selection test platform-dependent.
  const { stream } = fakeTty(false);
  let host = "";
  const out = selectAllMessageAndCopy(msgs, "id-a", stream, (t) => {
    host = t;
    return true;
  });
  assert.deepEqual(out.selection, { anchorId: "id-a", headId: "id-a" });
  assert.equal(out.result.ok, true);
  assert.equal(host, "full answer");
});
