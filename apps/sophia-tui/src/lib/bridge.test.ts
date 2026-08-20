import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEADLESS_BRIDGE_CONTRACT,
  CodeBridge,
  bridgeErrorFromEvent,
  bridgeEventText,
  bridgeEventQoS,
  coalesceBridgeEvents,
  normalizeBridgeEvent,
  prepareBridgeCommand,
  retryBridgeCommand,
  sanitizeBridgeStderr,
  isTerminalBridgeEvent,
  kernelApprovalId,
  type BridgeOptions,
  type BridgeEvent,
} from "./bridge.js";

test("extracts terminal answer text from 020s envelope variants", () => {
  assert.equal(bridgeEventText({ type: "final", text: "preview" }), "preview");
  assert.equal(bridgeEventText({ type: "result", finalText: "answer" }), "answer");
  assert.equal(bridgeEventText({ type: "result", payload: { content: "payload answer" } }), "payload answer");
  assert.equal(bridgeEventText({ type: "result", certificate: { finalText: "certificate answer" } }), "certificate answer");
});

test("sanitizes bridge stderr before display", () => {
  assert.equal(sanitizeBridgeStderr("[31mBearer supersecret token=abc https://secret.example/x[0m"), "Bearer [REDACTED] token=[REDACTED] [REDACTED_URL]");
});

test("redacts env-var-shaped secrets, which are the commonest kind on stderr", () => {
  // `\b` cannot match between "_" and a letter, so the previous pattern missed
  // every OPENAI_API_KEY= / GITHUB_TOKEN= / AWS_SECRET_ACCESS_KEY= assignment.
  // Measured before the fix: "OPENAI_API_KEY=sk-proj-abc123def456" passed through in full.
  for (const [input, secret] of [
    ["OPENAI_API_KEY=sk-proj-abc123def456", "sk-proj"],
    ["GITHUB_TOKEN=ghp_abcdef123456", "ghp_"],
    ["ANTHROPIC_API_KEY=sk-ant-api03-XYZ", "sk-ant"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI", "wJalrX"],
    ["MY_ACCESS_KEY: hunter2", "hunter2"],
  ] as Array<[string, string]>) {
    const out = sanitizeBridgeStderr(input);
    assert.ok(!out.includes(secret), `leaked ${secret} from ${input}: ${out}`);
    assert.match(out, /\[REDACTED\]/);
  }
});

test("strips OSC sequences whole — they used to pass through with their payload", () => {
  // ESC ] 0 ; <title> BEL. The old pattern only handled CSI, so a secret in a
  // terminal-title sequence survived AND its raw ESC/BEL reached the UI.
  const osc = "\u001b]0;sk-leaked-title\u0007rest";
  const out = sanitizeBridgeStderr(osc);
  assert.equal(out, "rest");
  assert.ok(!out.includes("sk-leaked"));
});

test("no control byte from a subprocess can reach the terminal", () => {
  const out = sanitizeBridgeStderr("a\u0000b\u0007c\u001bd\u007fe");
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(out), JSON.stringify(out));
});

test("normalizes nested bridge event envelopes and preserves correlation", () => {
  assert.deepEqual(normalizeBridgeEvent({ type: "bridge_event", runId: "run-1", path: ["lane-1"], session: "s", event: { type: "run_start", text: "x" } }), { type: "run_start", text: "x", runId: "run-1", path: ["lane-1"], session: "s" });
});

test("normalizes v2 metadata and legacy snake-case aliases without breaking v1", () => {
  assert.deepEqual(
    normalizeBridgeEvent({
      type: "event",
      protocol: 2,
      event_id: "ev-1",
      call_id: "call-1",
      parent_id: "ev-root",
      protocol_sequence: 7,
      protocol_attempt: 2,
      bridge_instance_id: "bridge-a",
      event: { type: "tool_result", ok: true },
    }),
    {
      type: "tool_result",
      ok: true,
      protocol: 2,
      eventId: "ev-1",
      callId: "call-1",
      parentEventId: "ev-root",
      protocolSequence: 7,
      protocolAttempt: 2,
      bridgeInstanceId: "bridge-a",
    },
  );
  // Existing v1 event shape stays byte-for-byte/object-for-object unchanged.
  assert.deepEqual(normalizeBridgeEvent({ type: "token", text: "x" }), { type: "token", text: "x" });
});

test("reliable command retries keep request/call ids stable and increment attempt", () => {
  const first = prepareBridgeCommand(
    { cmd: "snapshot" },
    { requestId: "req-fixed", callId: "call-fixed" },
  );
  const second = retryBridgeCommand(first);
  assert.deepEqual(first.command, {
    cmd: "snapshot",
    protocol: 2,
    requestId: "req-fixed",
    callId: "call-fixed",
    attempt: 1,
  });
  assert.equal(second.requestId, first.requestId);
  assert.equal(second.callId, first.callId);
  assert.equal(second.attempt, 2);
  assert.equal(second.command.attempt, 2);
  assert.ok(HEADLESS_BRIDGE_CONTRACT.restartSafeCommands.includes("snapshot"));
});

test("headless completion waits for run_finished rather than result", () => {
  assert.deepEqual(HEADLESS_BRIDGE_CONTRACT.terminalEvents, ["run_finished"]);
  assert.equal(isTerminalBridgeEvent({ type: "result", ok: true }), false);
  assert.equal(
    isTerminalBridgeEvent({
      type: "run_finished",
      session: "s",
      runId: "r",
      ok: true,
    }),
    true,
  );
});

test("typed protocol errors pass through without losing correlation", () => {
  const typed = bridgeErrorFromEvent({
    type: "error",
    requestId: "req-err",
    callId: "call-err",
    protocolAttempt: 3,
    errorPayload: {
      message: "temporarily unavailable",
      type: "BridgeUnavailable",
      category: "availability",
      retryable: true,
    },
  });
  assert.equal(typed?.type, "BridgeUnavailable");
  assert.equal(typed?.requestId, "req-err");
  assert.equal(typed?.callId, "call-err");
  assert.equal(typed?.attempt, 3);
  assert.equal(typed?.retryable, true);
});

test("QoS coalesces ephemeral streams but never drops critical events", () => {
  const events: BridgeEvent[] = [
    { type: "token", runId: "r", eventId: "e1", text: "a" },
    { type: "token", runId: "r", eventId: "e2", text: "b" },
    { type: "thinking_token", runId: "r", eventId: "e3", text: "x" },
    { type: "result", runId: "r", eventId: "e4", ok: true },
  ];
  const coalesced = coalesceBridgeEvents(events);
  assert.equal(bridgeEventQoS(events[0]).class, "ephemeral");
  assert.equal(bridgeEventQoS(events[3]).class, "critical");
  assert.equal(coalesced.length, 3);
  assert.equal(coalesced[0].text, "ab");
  assert.deepEqual(coalesced[0].coalescedFrom, ["e1", "e2"]);
  assert.equal(coalesced.at(-1)?.type, "result");
});

test("preserves top-level result finalText", () => {
  const result = normalizeBridgeEvent({ type: "result", finalText: "answer", certificate: { finalText: "stale" } });
  assert.equal(result?.finalText, "answer");
});

test("flattens payload-wrapped terminal results for TUI rendering", () => {
  const result = normalizeBridgeEvent({
    type: "result",
    runId: "run-envelope",
    payload: {
      type: "result",
      runId: "run-payload",
      finalText: "answer from payload",
      certificate: { finalText: "certificate answer" },
    },
  });
  assert.equal(result?.type, "result");
  assert.equal(result?.runId, "run-envelope");
  assert.equal(result?.finalText, "answer from payload");
  assert.deepEqual(result?.certificate, { finalText: "certificate answer" });
});

test("preserves payload terminal fields when envelope only carries correlation", () => {
  const result = normalizeBridgeEvent({
    type: "event",
    request_id: "req-envelope",
    event: {
      type: "result",
      payload: { finalText: "nested answer", text: "fallback" },
    },
  });
  assert.equal(result?.type, "result");
  assert.equal(result?.requestId, "req-envelope");
  assert.equal(result?.finalText, "nested answer");
  assert.equal(result?.text, "fallback");
});

// ── Flow control (backpressure) + liveness (stall) ──────────────────────
//
// These exercise CodeBridge against a real child process (bridge-fixture-child.mjs)
// rather than the real python bridge, so they stay hermetic (no LLM calls, no
// agent/code_bridge.py dependency) while still driving genuine OS-pipe/Node
// stdin.write() backpressure and genuine process liveness gaps — the two
// properties under test can't be faked with a mocked EventEmitter, since the
// defect was specifically about ignoring signals from the real subprocess.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "bridge-fixture-child.mjs");
const REPO_ROOT = path.resolve(__dirname, "../../../../");

/** Run `fn` (constructs + starts a CodeBridge) with fixture behavior selected
 * via env vars, then restore the prior environment. */
function withFixtureEnv<T>(mode: string, holdMs: number, fn: () => T): T {
  const prev = {
    py: process.env.SOPHIA_PYTHON,
    mode: process.env.FAKE_BRIDGE_MODE,
    hold: process.env.FAKE_BRIDGE_HOLD_MS,
  };
  process.env.FAKE_BRIDGE_MODE = mode;
  process.env.FAKE_BRIDGE_HOLD_MS = String(holdMs);
  try {
    return fn();
  } finally {
    if (prev.py === undefined) delete process.env.SOPHIA_PYTHON; else process.env.SOPHIA_PYTHON = prev.py;
    if (prev.mode === undefined) delete process.env.FAKE_BRIDGE_MODE; else process.env.FAKE_BRIDGE_MODE = prev.mode;
    if (prev.hold === undefined) delete process.env.FAKE_BRIDGE_HOLD_MS; else process.env.FAKE_BRIDGE_HOLD_MS = prev.hold;
  }
}

async function withFixtureEnvAsync<T>(
  mode: string,
  holdMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = {
    py: process.env.SOPHIA_PYTHON,
    mode: process.env.FAKE_BRIDGE_MODE,
    hold: process.env.FAKE_BRIDGE_HOLD_MS,
  };
  process.env.FAKE_BRIDGE_MODE = mode;
  process.env.FAKE_BRIDGE_HOLD_MS = String(holdMs);
  try {
    return await fn();
  } finally {
    if (prev.py === undefined) delete process.env.SOPHIA_PYTHON; else process.env.SOPHIA_PYTHON = prev.py;
    if (prev.mode === undefined) delete process.env.FAKE_BRIDGE_MODE; else process.env.FAKE_BRIDGE_MODE = prev.mode;
    if (prev.hold === undefined) delete process.env.FAKE_BRIDGE_HOLD_MS; else process.env.FAKE_BRIDGE_HOLD_MS = prev.hold;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fixtureBridge(options: BridgeOptions = {}): CodeBridge {
  return new CodeBridge(REPO_ROOT, {
    ...options,
    spawnCommand: process.execPath,
    spawnArgs: [FIXTURE],
  });
}

/**
 * Wait for a CONDITION, not for a duration.
 *
 * These tests drive a real subprocess and real timers, so any fixed sleep is a
 * bet that the machine finishes the work inside it. Under CI load that bet
 * loses and the suite goes red for a reason unrelated to the code — which
 * trains people to re-run red checks instead of reading them.
 *
 * Polling with a generous ceiling removes the bet without weakening anything:
 * a broken implementation never satisfies the predicate and still fails, just
 * via a timeout that names what it was waiting for. The ceiling is a
 * last-resort backstop, not a delay — a healthy run leaves in milliseconds.
 */
async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(5);
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

test("send() queues writes under real stdin backpressure and flushes them in FIFO order on drain", async () => {
  const bridge = withFixtureEnv("slow-echo", 200, () => {
    const b = fixtureBridge();
    b.start();
    return b;
  });
  try {
    const echoed: string[] = [];
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "echo") echoed.push(String(ev.line));
    });
    const bpStates: boolean[] = [];
    bridge.on("backpressure", (info: { active: boolean; queued: number }) => bpStates.push(info.active));

    // A 300KB single write comfortably exceeds Node's default 16KB
    // highWaterMark before the fixture starts reading (it waits 200ms), so
    // stdin.write() is guaranteed to return false here — this is the exact
    // signal the old code observed and then discarded.
    bridge.send({ cmd: "big", payload: "x".repeat(300_000) });
    assert.equal(bridge.isBackpressured(), true, "a 300KB write with no reader must report backpressure");

    // Sent while backpressured: must be queued (not dropped, not thrown).
    bridge.send({ cmd: "small-1" });
    bridge.send({ cmd: "small-2" });

    await wait(1500);

    assert.equal(bridge.isBackpressured(), false, "queue must drain once the child starts reading");
    assert.equal(echoed.length, 3, "the big write and both queued writes must all be delivered exactly once");
    assert.match(echoed[0], /"cmd":"big"/);
    assert.match(echoed[1], /"cmd":"small-1"/, "queued writes flush in the order they were sent");
    assert.match(echoed[2], /"cmd":"small-2"/);
    assert.ok(bpStates.includes(true) && bpStates.includes(false), "backpressure enter/exit must both be observable");
  } finally {
    await bridge.stop(100);
  }
});

test("write queue never drops approve or cancel when the oldest overflow would be a privilege line", async () => {
  const bridge = withFixtureEnv("slow-echo", 300, () => {
    const b = fixtureBridge({ writeQueueCap: 2 });
    b.start();
    return b;
  });
  try {
    const echoed: string[] = [];
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "echo") echoed.push(String(ev.line));
    });

    bridge.send({ cmd: "big", payload: "x".repeat(300_000) });
    assert.equal(bridge.isBackpressured(), true);
    bridge.send({ cmd: "approve", id: "ap-1", allow: true });
    bridge.send({ cmd: "noise-1" });
    bridge.send({ cmd: "cancel", id: "ap-1" });
    bridge.send({ cmd: "noise-2" });
    bridge.send({ cmd: "noise-3" });

    await until(() => !bridge.isBackpressured() && echoed.length >= 3,
      "the privileged write queue to drain");

    const cmds = echoed.map((line) => {
      try {
        return String(JSON.parse(line).cmd || "");
      } catch {
        return "";
      }
    });
    assert.ok(cmds.includes("approve"), `approve must survive overflow: ${cmds.join(",")}`);
    assert.ok(cmds.includes("cancel"), `cancel must survive overflow: ${cmds.join(",")}`);
  } finally {
    await bridge.stop(100);
  }
});

test("write queue drops the OLDEST entry once writeQueueCap is exceeded, keeping the newest", async () => {
  const bridge = withFixtureEnv("slow-echo", 300, () => {
    const b = fixtureBridge({ writeQueueCap: 2 });
    b.start();
    return b;
  });
  try {
    const echoed: string[] = [];
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "echo") echoed.push(String(ev.line));
    });

    bridge.send({ cmd: "big", payload: "x".repeat(300_000) });
    assert.equal(bridge.isBackpressured(), true);

    // 5 sends while backpressured with cap=2: only the 2 most recent survive.
    for (let i = 1; i <= 5; i += 1) bridge.send({ cmd: `q${i}` });

    // The fixture starts reading after its hold, then echoes everything the
    // queue delivered. Wait for the delivery to finish rather than betting a
    // fixed 1800ms covers it on a loaded machine.
    await until(() => !bridge.isBackpressured() && echoed.length >= 3,
      "the write queue to drain and the child to echo all delivered writes");

    assert.equal(bridge.isBackpressured(), false);
    assert.equal(echoed.length, 3, "big write + the 2 surviving queued writes (q4, q5)");
    assert.match(echoed[0], /"cmd":"big"/);
    assert.match(echoed[1], /"cmd":"q4"/, "q1-q3 must be dropped as the oldest once the cap is exceeded");
    assert.match(echoed[2], /"cmd":"q5"/);
  } finally {
    await bridge.stop(100);
  }
});

test("one-shot credential commands fail closed instead of entering the backpressure queue", async () => {
  const bridge = withFixtureEnv("slow-echo", 300, () => {
    const b = fixtureBridge();
    b.start();
    return b;
  });
  try {
    const echoed: string[] = [];
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "echo") echoed.push(String(ev.line));
    });

    bridge.send({ cmd: "big", payload: "x".repeat(300_000) });
    assert.equal(bridge.isBackpressured(), true);
    assert.throws(
      () => bridge.sendOneShotSecret({
        cmd: "model_connection",
        action: "store_credential",
        credentialValue: "must-not-enter-queue",
      }),
      /was not queued or sent/,
    );

    await until(
      () => !bridge.isBackpressured() && echoed.length >= 1,
      "the non-secret write to drain",
    );
    assert.equal(echoed.some((line) => line.includes("must-not-enter-queue")), false);
  } finally {
    await bridge.stop(100);
  }
});

test("a missing python binary is reported, not thrown as an uncaught exception", async () => {
  // ENOENT on spawn is an EventEmitter error; with no listener Node RETHROWS it
  // and an ordinary misconfiguration (SOPHIA_PYTHON pointing at a deleted venv)
  // took the whole TUI down. Verified before the fix: "Error: spawn ... ENOENT"
  // reached the top level.
  const bridge = withFixtureEnv("silent", 0, () => {
    process.env.SOPHIA_PYTHON = "/nonexistent/python-that-is-not-here";
    const b = new CodeBridge(REPO_ROOT);
    b.start();
    return b;
  });
  try {
    const errors: Error[] = [];
    bridge.on("error", (e: Error) => errors.push(e));
    await until(() => errors.length > 0, "the spawn failure to be reported to the app");
    assert.match(String(errors[0]), /ENOENT/);
    assert.equal(bridge.isReady(), false);
  } finally {
    await bridge.stop(100);
  }
});

test("connect/restart is staged and only terminates the child this bridge owns", async () => {
  await withFixtureEnvAsync("ready-then-silent", 0, async () => {
    const bridge = fixtureBridge();
    const stages: string[] = [];
    bridge.on("restart_stage", (event: { stage: string }) => stages.push(event.stage));
    try {
      const first = await bridge.connect(2_000);
      assert.equal(first.type, "ready");
      assert.equal(first.protocol, 1, "v1 ready payload remains normalizable");

      bridge.run({ prompt: "wedged" });
      const second = await bridge.restart({
        cancelGraceMs: 20,
        terminateGraceMs: 2_000,
        readyTimeoutMs: 2_000,
      });
      assert.equal(second.type, "ready");
      assert.deepEqual(stages, ["cancelling", "terminating", "starting", "ready"]);
      assert.equal(bridge.isReady(), true);
    } finally {
      await bridge.stop(100);
    }
  });
});

test("an unparseable stdout line is surfaced as a log event, not dropped", async () => {
  // A corrupted or truncated protocol line could be the RESULT. It must leave a
  // trace rather than vanishing.
  const bridge = withFixtureEnv("garbage-line", 0, () => {
    const b = fixtureBridge();
    b.start();
    return b;
  });
  try {
    const logs: string[] = [];
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "log") logs.push(String(ev.text));
    });
    await until(() => logs.length > 0, "the unparseable line to surface");
    assert.match(logs[0], /this is not json at all/);
  } finally {
    await bridge.stop(100);
  }
});

test("a secret split across two stderr chunks is still redacted", async () => {
  // A pipe splits at arbitrary byte boundaries. The fixture writes
  // "OPENAI_API_KEY=sk-proj-" and "abcdef123456\n" as two chunks; sanitising
  // each in isolation matches NEITHER half and the secret reassembles on screen.
  const bridge = withFixtureEnv("split-secret", 0, () => {
    const b = fixtureBridge();
    b.start();
    return b;
  });
  try {
    const lines: string[] = [];
    bridge.on("stderr", (text: string) => lines.push(text));
    await until(() => lines.length > 0, "the child's stderr line to arrive");

    const joined = lines.join("\n");
    assert.ok(!joined.includes("sk-proj-abcdef123456"), `secret leaked: ${joined}`);
    assert.ok(!joined.includes("sk-proj-"), `secret prefix leaked: ${joined}`);
    assert.match(joined, /OPENAI_API_KEY=\[REDACTED\]/);
  } finally {
    await bridge.stop(100);
  }
});

test("run() with a wedged child surfaces a stall, and new activity clears it", async () => {
  // "wake-on-command", not "recover": the child stays silent until this test
  // tells it to speak, so waiting for the stall cannot race a timed recovery.
  // The previous version had to land its assertion between the 80ms threshold
  // and a 500ms recovery write, and a loaded machine landed outside that window.
  const bridge = withFixtureEnv("wake-on-command", 0, () => {
    const b = fixtureBridge({ stallTimeoutMs: 80 });
    b.start();
    return b;
  });
  try {
    const stallEvents: Array<{ stalled: boolean; sinceMs: number }> = [];
    bridge.on("stall", (info: { stalled: boolean; sinceMs: number }) => stallEvents.push(info));

    bridge.run({ prompt: "hello" });
    assert.equal(bridge.isStalled(), false, "must not stall immediately after run() is sent");

    // Nothing can clear this but the detector firing — the child is mute until
    // the wake below, so there is no deadline to lose a race against.
    await until(() => bridge.isStalled(),
      "a wedged child to surface a stall");
    assert.ok(stallEvents.some((e) => e.stalled === true && e.sinceMs >= 80),
      "the surfaced stall must report at least the configured threshold");

    // ANY activity clears a surfaced stall, even though the run is technically
    // still open (no terminal "result"/"error" yet) — stall is a liveness
    // signal for the UI to show, not a verdict that kills the run.
    bridge.send({ cmd: "wake" });
    await until(() => !bridge.isStalled(),
      "activity from the child to clear the surfaced stall");
    assert.ok(stallEvents.some((e) => e.stalled === false));
  } finally {
    await bridge.stop(100);
  }
});

test("stall detection only applies while a run is in flight (idle bridge never stalls)", async () => {
  // A negative assertion needs a positive clock to measure against, or it just
  // means "we did not wait long enough". A second bridge with a run in flight
  // is that clock: once IT has stalled, enough poll cycles have demonstrably
  // elapsed for the idle one to have stalled too, had the guard been missing.
  const idle = withFixtureEnv("silent", 0, () => {
    const b = fixtureBridge({ stallTimeoutMs: 60 });
    b.start();
    return b;
  });
  const control = withFixtureEnv("silent", 0, () => {
    const b = fixtureBridge({ stallTimeoutMs: 60 });
    b.start();
    return b;
  });
  try {
    control.run({ prompt: "hello" });   // arms stall detection on the control only
    await until(() => control.isStalled(),
      "the control bridge (run in flight) to stall");

    assert.equal(idle.isStalled(), false,
      "no run in flight means nothing to stall-detect, however long we wait");
  } finally {
    await Promise.all([idle.stop(100), control.stop(100)]);
  }
});

// ── Auto-cancel: a wedged/over-budget run is cancelled, not spun on ─────
//
// Before this, a kernel that wedged mid-run left the TUI showing "writing
// response…" forever — the stall WARNING fired but nothing ever ACTED on it.
// These drive the real bridge against the cancel-ack fixture (silent until it
// receives a cancel, then acks) so they prove both halves: the give-up DECIDED
// to cancel, and the cancel actually REACHED the child.

test("a run that stays silent past the give-up threshold is auto-cancelled as silent_timeout, exactly once", async () => {
  const bridge = withFixtureEnv("cancel-ack", 0, () => {
    const b = fixtureBridge({ stallTimeoutMs: 60, stallGiveUpMs: 150 });
    b.start();
    return b;
  });
  try {
    const timeouts: Array<{ sinceMs: number }> = [];
    const cancelled: BridgeEvent[] = [];
    bridge.on("stall_timeout", (info: { sinceMs: number }) => timeouts.push(info));
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "cancelled") cancelled.push(ev);
    });

    bridge.run({ prompt: "hello" });
    await until(() => timeouts.length >= 1,
      "a silent run to trip the give-up and auto-cancel");
    assert.equal(timeouts.length, 1, "the give-up must latch — fire once, not every poll");
    assert.ok(timeouts[0].sinceMs >= 150,
      "the event must report at least the configured give-up threshold");
    // The cancel must actually be delivered to the child, not merely decided.
    // The fixture parses the delivered line and echoes its reason in the ack.
    await until(() => cancelled.length >= 1,
      "the auto-cancel to be delivered to and acknowledged by the child");
    assert.equal(cancelled[0].reason, "silent_timeout");
  } finally {
    await bridge.stop(100);
  }
});

test("an explicit operator cancel is sent as user_cancel", async () => {
  const bridge = withFixtureEnv("cancel-ack", 0, () => {
    const b = fixtureBridge({ stallGiveUpMs: 0 });
    b.start();
    return b;
  });
  try {
    const cancelled: BridgeEvent[] = [];
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "cancelled") cancelled.push(ev);
    });

    bridge.run({ prompt: "hello" });
    bridge.cancel();
    await until(() => cancelled.length >= 1,
      "the explicit cancel to be delivered and acknowledged");
    assert.equal(cancelled[0].reason, "user_cancel");
  } finally {
    await bridge.stop(100);
  }
});

test("an overall run timeout is sent as run_timeout", async () => {
  const bridge = withFixtureEnv("cancel-ack", 0, () => {
    const b = fixtureBridge({
      stallTimeoutMs: 1_000,
      stallGiveUpMs: 0,
      runTimeoutMs: 150,
    });
    b.start();
    return b;
  });
  try {
    const cancelled: BridgeEvent[] = [];
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "cancelled") cancelled.push(ev);
    });

    bridge.run({ prompt: "hello" });
    await until(() => cancelled.length >= 1,
      "the overall timeout cancel to be delivered and acknowledged");
    assert.equal(cancelled[0].reason, "run_timeout");
  } finally {
    await bridge.stop(100);
  }
});

test("stallGiveUpMs=0 disables auto-cancel: the run stalls but is never cancelled", async () => {
  // A negative assertion needs a positive clock: the control bridge has give-up
  // ENABLED at the same thresholds, so once IT auto-cancels, enough poll cycles
  // have demonstrably elapsed for the disabled bridge to have cancelled too —
  // had the disable been broken. Without the control, "no cancel yet" could
  // just mean "we did not wait long enough" (the same idiom as the idle-bridge
  // test above).
  const disabled = withFixtureEnv("cancel-ack", 0, () => {
    const b = fixtureBridge({ stallTimeoutMs: 60, stallGiveUpMs: 0 });
    b.start();
    return b;
  });
  const control = withFixtureEnv("cancel-ack", 0, () => {
    const b = fixtureBridge({ stallTimeoutMs: 60, stallGiveUpMs: 150 });
    b.start();
    return b;
  });
  try {
    const disabledTimeouts: unknown[] = [];
    const disabledCancelled: BridgeEvent[] = [];
    disabled.on("stall_timeout", () => disabledTimeouts.push(1));
    disabled.on("event", (ev: BridgeEvent) => {
      if (ev.type === "cancelled") disabledCancelled.push(ev);
    });
    let controlFired = false;
    control.on("stall_timeout", () => { controlFired = true; });

    disabled.run({ prompt: "hello" });
    control.run({ prompt: "hello" });
    await until(() => controlFired, "the control bridge (give-up enabled) to auto-cancel");

    assert.equal(disabled.isStalled(), true,
      "the disabled bridge must still be stalled, not cancelled");
    assert.equal(disabledTimeouts.length, 0, "stallGiveUpMs=0 must never emit stall_timeout");
    assert.equal(disabledCancelled.length, 0, "stallGiveUpMs=0 must never send a cancel");
  } finally {
    await Promise.all([disabled.stop(100), control.stop(100)]);
  }
});

// ── Team lanes on the wire ──────────────────────────────────────────────
//
// The kernel has had a working K-lane team mode all along: agent/code_bridge.py
// clamps `team` to 1..4 (_normalize_team), dispatches team>1 to _run_team, and
// emits a `lane_start` per lane which _record_lifecycle maps to TaskKind.AGENT
// -> a receipt -> the `agent` nodes WorkflowTree already knows how to draw.
// The one missing link was this client: run() never put `team` on the wire, so
// no lane could ever be requested and the tree stayed empty.
//
// These assert against the REAL delivered bytes (the slow-echo fixture echoes
// back what it actually read off stdin), not against a mocked send().

/** Drive one run() through the echo fixture and return the delivered line. */
async function deliveredRunLine(opts: Parameters<CodeBridge["run"]>[0]): Promise<string> {
  const prevEffort = process.env.SOPHIA_REASONING_EFFORT;
  delete process.env.SOPHIA_REASONING_EFFORT;   // keep `effort` deterministic
  const bridge = withFixtureEnv("slow-echo", 20, () => {
    const b = fixtureBridge();
    b.start();
    return b;
  });
  try {
    const echoed: string[] = [];
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "echo") echoed.push(String(ev.line));
    });
    bridge.run(opts);
    await until(() => echoed.length >= 1, `the fixture to echo the run line for ${JSON.stringify(opts)}`);
    return echoed[0];
  } finally {
    await bridge.stop(100);
    if (prevEffort === undefined) delete process.env.SOPHIA_REASONING_EFFORT;
    else process.env.SOPHIA_REASONING_EFFORT = prevEffort;
  }
}

/**
 * The exact solo `run` command line, byte for byte. `autoGoal:true` is part of
 * the standard solo line now: the TUI lets the kernel route explicit
 * persistence/retry/resume intent into the autonomous goal-continuation loop
 * while ordinary substantive tasks stay in the inner loop. `team` is
 * still omitted (the kernel defaults it to 1), and autoTeam is omitted while
 * unset so a public first-use install cannot silently dispatch agents.
 */
const SOLO_RUN_LINE = JSON.stringify({
  cmd: "run",
  prompt: "p",
  model: "mock",
  mode: "balanced",
  permission: "manual",
  session: "tui-default",
  maxSteps: 12,
  cwd: path.resolve(REPO_ROOT),
  deepThink: false,
  deepMode: false,
  reasoningEffort: "medium",
  effort: "medium",
  autoGoal: true,
});

test("autoTeam is omitted while unset and explicit true/false are preserved", async () => {
  assert.ok(!/"autoTeam":/.test(await deliveredRunLine({ prompt: "p" })));
  assert.equal(
    await deliveredRunLine({ prompt: "p", autoTeam: true }),
    SOLO_RUN_LINE.replace(/}$/, ',"autoTeam":true}'),
  );
  assert.equal(
    await deliveredRunLine({ prompt: "p", autoTeam: false }),
    SOLO_RUN_LINE.replace(/}$/, ',"autoTeam":false}'),
  );
});

test("the default Sophia runtime preserves the wire while Prime is explicit", async () => {
  assert.equal(await deliveredRunLine({ prompt: "p" }), SOLO_RUN_LINE);
  assert.equal(
    await deliveredRunLine({ prompt: "p", runtime: "sophia" }),
    SOLO_RUN_LINE,
  );
  assert.equal(
    await deliveredRunLine({ prompt: "p", runtime: "prime" }),
    SOLO_RUN_LINE.replace('"prompt":"p",', '"prompt":"p","runtime":"prime",'),
  );
});

test("run sends an explicit responseStyle on the wire", async () => {
  const line = await deliveredRunLine({ prompt: "p", responseStyle: "structured" });
  assert.equal(line, SOLO_RUN_LINE.replace(/}$/, ',"responseStyle":"structured"}'));
});

test("run sends each explicit Conscience policy without changing the default wire shape", async () => {
  assert.ok(!/"conscienceMode":/.test(await deliveredRunLine({ prompt: "p" })));
  assert.equal(
    await deliveredRunLine({ prompt: "p", conscienceMode: "off" }),
    SOLO_RUN_LINE.replace(/}$/, ',"conscienceMode":"off"}'),
  );
  assert.equal(
    await deliveredRunLine({ prompt: "p", conscienceMode: "report" }),
    SOLO_RUN_LINE.replace(/}$/, ',"conscienceMode":"report"}'),
  );
  assert.equal(
    await deliveredRunLine({ prompt: "p", conscienceMode: "floor" }),
    SOLO_RUN_LINE.replace(/}$/, ',"conscienceMode":"floor"}'),
  );
  assert.equal(
    await deliveredRunLine({ prompt: "p", conscienceMode: "strict" }),
    SOLO_RUN_LINE.replace(/}$/, ',"conscienceMode":"strict"}'),
  );
});

test("run sends the explicit AGI workflow mode on the wire", async () => {
  assert.equal(
    await deliveredRunLine({ prompt: "p", agiWorkflowMode: "auto" }),
    SOLO_RUN_LINE.replace(/}$/, ',"agiWorkflowMode":"auto"}'),
  );
  assert.equal(
    await deliveredRunLine({ prompt: "p", agiWorkflowMode: "on" }),
    SOLO_RUN_LINE.replace(/}$/, ',"agiWorkflowMode":"on"}'),
  );
  assert.equal(
    await deliveredRunLine({ prompt: "p", agiWorkflowMode: "off" }),
    SOLO_RUN_LINE.replace(/}$/, ',"agiWorkflowMode":"off"}'),
  );
});

test("run sends an explicit durable workflow resume source", async () => {
  assert.equal(
    await deliveredRunLine({
      prompt: "p",
      workflowResumeRunId: "crashed-workflow",
    }),
    SOLO_RUN_LINE.replace(
      /}$/,
      ',"workflowResumeRunId":"crashed-workflow"}',
    ),
  );
});

test("settings writes preserve an explicit AGI workflow mode", async () => {
  const command = JSON.parse(
    await deliveredLine((bridge) =>
      bridge.setSettings({ agiWorkflowMode: "auto" })
    ),
  );
  assert.equal(command.cmd, "settings");
  assert.equal(command.agiWorkflowMode, "auto");
});

test("goal sends an explicit responseStyle on the wire", async () => {
  const line = await deliveredLine((bridge) => bridge.goal({ prompt: "p", responseStyle: "explanatory" }));
  assert.match(line, /"cmd":"goal"/);
  assert.match(line, /"responseStyle":"explanatory"/);
});

test("goal sends an explicit Conscience policy on the wire", async () => {
  const line = await deliveredLine((bridge) =>
    bridge.goal({ prompt: "p", conscienceMode: "strict" })
  );
  assert.match(line, /"cmd":"goal"/);
  assert.match(line, /"conscienceMode":"strict"/);
});

test("a solo run is byte-identical to the pre-team wire format", async () => {
  // The kernel already defaults team to 1, so SENDING team:1 would be a no-op
  // that still changed the bytes for every existing client and every recorded
  // fixture. The key is omitted instead. This is the SPEC §8 byte-identical-
  // default proof for the optional path, and it is an equality test on purpose:
  // a `!includes("team")` check would pass even if key ORDER drifted.
  assert.equal(await deliveredRunLine({ prompt: "p" }), SOLO_RUN_LINE);
});

test("an unusable lane count is treated as no opinion, not as 1", async () => {
  // These must NOT become `team:1`. The kernel persists `team` and falls back
  // to the stored value when the key is absent, so "no opinion" and "solo" are
  // genuinely different messages — but garbage should still never lose a
  // prompt, so it degrades to silence rather than throwing.
  for (const team of [0, -3, Number.NaN, undefined]) {
    const line = await deliveredRunLine({ prompt: "p", team });
    assert.equal(line, SOLO_RUN_LINE, `team:${String(team)} must not alter the solo wire format`);
    // Match the JSON KEY, not the bare word: `cwd` carries the checkout path,
    // and a worktree called ".../team-lanes" makes a substring check fail for
    // a reason that has nothing to do with the protocol.
    assert.ok(!/"team":/.test(line), `team:${String(team)} leaked a key: ${line}`);
  }
});

test("an explicit team:1 IS sent, because omitting it would inherit a stored lane count", async () => {
  // Measured against agent/code_bridge.py: run(team:3) persists team=3 into
  // ~/.sophia/code_bridge_state.json, and a later run with no `team` key
  // resolves it from that default and fans out three lanes again — across
  // restarts. If `/agents 1` omitted the key it would be a silent no-op, the
  // same defect #1578/#1594 fixed for `model`.
  const line = await deliveredRunLine({ prompt: "p", team: 1 });
  assert.equal(line, SOLO_RUN_LINE.replace(/}$/, ',"team":1}'),
    "an explicit solo request must reach the kernel to override its stored default");
});

test("team>1 puts the lane count on the wire, last, so the kernel can fan out", async () => {
  const line = await deliveredRunLine({ prompt: "p", team: 3 });
  assert.equal(line, SOLO_RUN_LINE.replace(/}$/, ',"team":3}'),
    "team must be appended to the otherwise-unchanged solo line");
  // A float would make _normalize_team's int() throw before it could clamp.
  assert.match(await deliveredRunLine({ prompt: "p", team: 2.7 }), /"team":2}$/);
});

test("an over-large lane count is left for the kernel to clamp, not silently reshaped here", async () => {
  // agent/code_bridge.py::_normalize_team is the single source of truth for the
  // 1..4 range. Duplicating the ceiling in the client would be a second place to
  // update, and the two would drift. We only guarantee an integer above 1.
  assert.match(await deliveredRunLine({ prompt: "p", team: 99 }), /"team":99}$/);
});

// ── listTasks: let the kernel own its own default ───────────────────────

/** Drive one bridge command through the echo fixture and return the line. */
async function deliveredLine(call: (b: CodeBridge) => void): Promise<string> {
  const bridge = withFixtureEnv("slow-echo", 20, () => {
    const b = fixtureBridge();
    b.start();
    return b;
  });
  try {
    const echoed: string[] = [];
    bridge.on("event", (ev: BridgeEvent) => {
      if (ev.type === "echo") echoed.push(String(ev.line));
    });
    call(bridge);
    await until(() => echoed.length >= 1, "the fixture to echo the command");
    return echoed[0];
  } finally {
    await bridge.stop(100);
  }
}

test("replayCompoundWorkflows sends a session-scoped read-only replay command", async () => {
  const command = JSON.parse(await deliveredLine((bridge) => {
    bridge.replayCompoundWorkflows("compound-session", "replay-request");
  }));
  assert.deepEqual(command, {
    cmd: "compound_workflow",
    action: "replay",
    workflowCommandVersion: 1,
    session: "compound-session",
    protocol: 2,
    requestId: "replay-request",
    callId: "replay-request",
    attempt: 1,
  });
  assert.ok(!("workflowRunKey" in command));
  assert.ok(!("plan" in command));
});

test("typed compound workflow methods preserve run-key and replay authority boundaries", async () => {
  const plan = { schema: "sophia.compound-workflow-plan.v1" };
  const run = JSON.parse(await deliveredLine((bridge) => {
    bridge.runCompoundWorkflow("compound-session", "stable-key", plan, "run-request");
  }));
  assert.equal(run.action, "run");
  assert.equal(run.workflowRunKey, "stable-key");
  assert.deepEqual(run.plan, plan);
  assert.equal(run.requestId, "run-request");

  const resume = JSON.parse(await deliveredLine((bridge) => {
    bridge.resumeCompoundWorkflow("compound-session", "stable-key", "resume-request");
  }));
  assert.equal(resume.action, "resume");
  assert.equal(resume.workflowRunKey, "stable-key");
  assert.ok(!("plan" in resume));

  const status = JSON.parse(await deliveredLine((bridge) => {
    bridge.statusCompoundWorkflow("compound-session", "stable-key");
  }));
  assert.equal(status.action, "status");
  assert.equal(status.workflowRunKey, "stable-key");

  const events = JSON.parse(await deliveredLine((bridge) => {
    bridge.eventsCompoundWorkflow("compound-session", "stable-key");
  }));
  assert.equal(events.action, "events");
  assert.equal(events.workflowRunKey, "stable-key");
});

test("plugin() dispatches the full governed catalog selection request", async () => {
  const command = JSON.parse(await deliveredLine((bridge) => bridge.plugin({
    action: "catalog_select",
    pluginId: "reviewer",
    version: "1.2.3",
    protocol: ["sophia.plugin/v1"],
    hostProtocols: ["sophia.plugin/v1", "jsonrpc-stdio/v2"],
    platform: "darwin",
    architecture: "arm64",
    allowStale: true,
    allowPrerelease: true,
  }, REPO_ROOT)));
  assert.deepEqual(command, {
    cmd: "plugin",
    action: "catalog_select",
    pluginId: "reviewer",
    version: "1.2.3",
    protocol: ["sophia.plugin/v1"],
    hostProtocols: ["sophia.plugin/v1", "jsonrpc-stdio/v2"],
    platform: "darwin",
    architecture: "arm64",
    allowStale: true,
    allowPrerelease: true,
    cwd: REPO_ROOT,
  });
});

test("plugin() dispatches governed catalog search filters", async () => {
  const command = JSON.parse(await deliveredLine((bridge) => bridge.plugin({
    action: "catalog_search",
    query: "review",
    contribution: ["reviewer"],
    capability: ["source-check"],
    protocol: ["sophia.plugin/v1"],
    hostProtocols: ["sophia.plugin/v1", "jsonrpc-stdio/v2"],
    platform: "darwin",
    architecture: "arm64",
    eligibleOnly: true,
  }, REPO_ROOT)));
  assert.deepEqual(command, {
    cmd: "plugin",
    action: "catalog_search",
    query: "review",
    contribution: ["reviewer"],
    capability: ["source-check"],
    protocol: ["sophia.plugin/v1"],
    hostProtocols: ["sophia.plugin/v1", "jsonrpc-stdio/v2"],
    platform: "darwin",
    architecture: "arm64",
    eligibleOnly: true,
    cwd: REPO_ROOT,
  });
});

test("listTasks omits retainCompleted so the kernel's context-sensitive default is reachable", async () => {
  // agent/code_bridge.py::_handle_tasks resolves it to bool(runId or session):
  // a caller naming a target wants that target's finished nodes, while an
  // unscoped "what's happening now" call must not be handed every run this
  // machine ever recorded. Serializing it on every call — which a default
  // parameter of `true` did — made that branch dead code and moved a policy
  // decision from the kernel into the client.
  const scoped = await deliveredLine((b) => b.listTasks(undefined, "sess-1"));
  assert.ok(!/"retainCompleted"/.test(scoped), `client pinned the policy: ${scoped}`);
  assert.match(scoped, /"cmd":"tasks"/);
  assert.match(scoped, /"session":"sess-1"/);

  const unscoped = await deliveredLine((b) => b.listTasks());
  assert.ok(!/"retainCompleted"/.test(unscoped), unscoped);
});

test("an explicit retainCompleted still reaches the kernel, in both polarities", async () => {
  // Omitting on `undefined` must not become "you can never ask for it".
  assert.match(await deliveredLine((b) => b.listTasks(undefined, "s", true)), /"retainCompleted":true/);
  assert.match(await deliveredLine((b) => b.listTasks(undefined, "s", false)), /"retainCompleted":false/);
});

test("agi() sends explicit controller, profile, and local role-model settings", async () => {
  const command = JSON.parse(await deliveredLine((b) => {
    b.agi({
      action: "start",
      session: "agi-session",
      prompt: "complete the bounded task",
      profile: "deep",
      model: "ollama:qwen3",
      mode: "code",
      permission: "readonly",
      cwd: process.cwd(),
      reasoningEffort: "high",
      responseStyle: "structured",
      conscienceMode: "strict",
      plannerModel: "ollama:qwen3",
      workerModel: "ollama:qwen3-coder",
      verifierModel: "ollama:llama3.3",
    });
  }));
  assert.deepEqual(
    {
      cmd: command.cmd,
      action: command.action,
      session: command.session,
      prompt: command.prompt,
      profile: command.profile,
      agiProfile: command.agiProfile,
      model: command.model,
      permission: command.permission,
      reasoningEffort: command.reasoningEffort,
      responseStyle: command.responseStyle,
      conscienceMode: command.conscienceMode,
      planner: command.agiPlannerModel,
      worker: command.agiWorkerModel,
      verifier: command.agiVerifierModel,
    },
    {
      cmd: "agi",
      action: "start",
      session: "agi-session",
      prompt: "complete the bounded task",
      profile: "deep",
      agiProfile: "deep",
      model: "ollama:qwen3",
      permission: "readonly",
      reasoningEffort: "high",
      responseStyle: "structured",
      conscienceMode: "strict",
      planner: "ollama:qwen3",
      worker: "ollama:qwen3-coder",
      verifier: "ollama:llama3.3",
    },
  );
});

test("queueNext, snapshot, and MCP methods expose correlated v2 command surfaces", async () => {
  const queued = JSON.parse(await deliveredLine((b) => {
    b.queueNext("later", {
      session: "s",
      autoTeam: false,
      team: 2,
      agiWorkflowMode: "on",
      requestId: "req-next",
    });
  }));
  assert.equal(queued.cmd, "queue_next");
  assert.equal(queued.requestId, "req-next");
  assert.equal(queued.callId, "req-next");
  assert.equal(queued.attempt, 1);
  assert.equal(queued.autoTeam, false);
  assert.equal(queued.team, 2);
  assert.equal(queued.agiWorkflowMode, "on");

  const snapshot = JSON.parse(await deliveredLine((b) => {
    b.diagnosticSnapshot({ session: "s", requestId: "req-snap" });
  }));
  assert.equal(snapshot.cmd, "snapshot");
  assert.equal(snapshot.protocol, 2);
  assert.equal(snapshot.requestId, "req-snap");

  const health = JSON.parse(await deliveredLine((b) => {
    b.mcpHealth({ probe: false, timeoutMs: 250, requestId: "req-health" });
  }));
  assert.deepEqual(
    { cmd: health.cmd, probe: health.probe, timeoutMs: health.timeoutMs },
    { cmd: "mcp_health", probe: false, timeoutMs: 250 },
  );

  const timeouts = JSON.parse(await deliveredLine((b) => {
    b.mcpTimeouts({ connectMs: 100, requestMs: 500, requestId: "req-mcp-timeouts" });
  }));
  assert.equal(timeouts.cmd, "mcp_timeouts");
  assert.equal(timeouts.connectMs, 100);
  assert.equal(timeouts.requestMs, 500);
});

// ── New kernel-capability commands: hooks, checkpoints, local-engine status ──
//
// Each command's field names/shape are pinned against agent/code_bridge.py's
// own dispatch table (`_handle_hooks`, `_handle_checkpoints`,
// `_handle_checkpoint_undo/_restore`, `_handle_local_engine_report`,
// `_handle_adapter_status`, `_handle_model_preflight`), not invented here.

test("hooks() sends {cmd:'hooks'}, cwd omitted unless given", async () => {
  const bare = JSON.parse(await deliveredLine((b) => b.hooks()));
  assert.equal(bare.cmd, "hooks");
  assert.equal("cwd" in bare, false);

  const scoped = JSON.parse(await deliveredLine((b) => b.hooks("/tmp/some-workspace")));
  assert.equal(scoped.cwd, "/tmp/some-workspace");
});

test("checkpoints()/checkpointUndo()/checkpointRestore() send the exact cmd names the kernel dispatches on", async () => {
  const list = JSON.parse(await deliveredLine((b) => b.checkpoints()));
  assert.equal(list.cmd, "checkpoints");
  assert.equal("session" in list, false);

  const scopedList = JSON.parse(await deliveredLine((b) => b.checkpoints("sess-1")));
  assert.equal(scopedList.session, "sess-1");

  const undo = JSON.parse(await deliveredLine((b) => b.checkpointUndo("sess-1")));
  assert.equal(undo.cmd, "checkpoint_undo");
  assert.equal(undo.session, "sess-1");

  const restore = JSON.parse(await deliveredLine((b) => b.checkpointRestore("cp-1", "sess-1")));
  assert.equal(restore.cmd, "checkpoint_restore");
  assert.equal(restore.id, "cp-1");
  assert.equal(restore.session, "sess-1");

  // session is genuinely optional on restore too — the kernel falls back to
  // its own last-active tool context (_lookup_checkpoint_ctx).
  const restoreNoSession = JSON.parse(await deliveredLine((b) => b.checkpointRestore("cp-2")));
  assert.equal(restoreNoSession.id, "cp-2");
  assert.equal("session" in restoreNoSession, false);
});

test("localEngineReport() and modelPreflight() are reliable commands carrying protocol/requestId/callId", async () => {
  const report = JSON.parse(await deliveredLine((b) => {
    b.localEngineReport({ requestId: "req-engine" });
  }));
  assert.equal(report.cmd, "local_engine_report");
  assert.equal(report.protocol, HEADLESS_BRIDGE_CONTRACT.protocolVersion);
  assert.equal(report.requestId, "req-engine");
  assert.equal(report.callId, "req-engine");

  // requestId is optional client-side — a caller that doesn't need
  // correlation still gets a valid, well-formed command.
  const reportNoId = JSON.parse(await deliveredLine((b) => b.localEngineReport()));
  assert.equal(reportNoId.cmd, "local_engine_report");
  assert.equal(typeof reportNoId.requestId, "string");

  const preflight = JSON.parse(await deliveredLine((b) => {
    b.modelPreflight({ model: "ollama:phi4:14b", requestId: "req-preflight" });
  }));
  assert.equal(preflight.cmd, "model_preflight");
  assert.equal(preflight.model, "ollama:phi4:14b");
  assert.equal(preflight.requestId, "req-preflight");

  const preflightNoModel = JSON.parse(await deliveredLine((b) => b.modelPreflight()));
  assert.equal(preflightNoModel.cmd, "model_preflight");
  assert.equal("model" in preflightNoModel, false);
});

test("adapterStatus() sends the bare command with no extra fields", async () => {
  const line = await deliveredLine((b) => b.adapterStatus());
  assert.equal(JSON.parse(line).cmd, "adapter_status");
});

// ── Parsing the new event payloads ───────────────────────────────────────
//
// normalizeBridgeEvent is exactly what the NDJSON line reader applies to
// every parsed stdout line (bridge.ts's rl.on("line", ...) has no per-type
// branch at all — every JSON line reaches it and is emitted as "event"
// unchanged), so exercising it directly here proves the same thing an
// end-to-end child-process round trip would: a new, KNOWN event type is
// never treated as unparsed noise (that fallback only fires on a JSON.parse
// failure — see the existing "garbage-line" test above), and passes through
// with its fields intact. Each is tested once fully populated and once with
// every optional field omitted, since an older/partial kernel build sends
// exactly the latter.

test("kernelApprovalId refuses a client-invented id when the kernel omitted one", () => {
  assert.equal(kernelApprovalId("ap-1"), "ap-1");
  assert.equal(kernelApprovalId(""), "");
  assert.equal(kernelApprovalId(undefined), "");
  assert.equal(kernelApprovalId(null), "");
});

test("approval_request parses with diff/risk/destructive, and without them", () => {
  const full = normalizeBridgeEvent({
    type: "approval_request", runId: "r1", id: "ap-1", tool: "write_file",
    preview: "write_file src/foo.py", diff: "-old\n+new", risk: "write",
    destructive: true, ts: "2026-01-01T00:00:00Z", canClaimAGI: false,
  });
  assert.equal(full?.diff, "-old\n+new");
  assert.equal(full?.risk, "write");
  assert.equal(full?.destructive, true);

  const minimal = normalizeBridgeEvent({
    type: "approval_request", runId: "r1", id: "ap-2", tool: "bash", preview: "bash ls",
  });
  assert.equal(minimal?.diff, undefined);
  assert.equal(minimal?.risk, undefined);
  assert.equal(minimal?.destructive, undefined);
});

test("approval_decision parses with an optional risk field", () => {
  const withRisk = normalizeBridgeEvent({
    type: "approval_decision", runId: "r1", id: "ap-1", tool: "bash", allow: true, risk: "exec",
  });
  assert.equal(withRisk?.risk, "exec");

  const withoutRisk = normalizeBridgeEvent({
    type: "approval_decision", runId: "r1", id: "ap-1", tool: "bash", allow: false,
  });
  assert.equal(withoutRisk?.risk, undefined);
});

test("result parses new per-turn telemetry, fileChanges, and contextTokensSource", () => {
  const full = normalizeBridgeEvent({
    type: "result", runId: "r1", ok: true, finalText: "done",
    promptTokens: 120, completionTokens: 40, costUsd: 0.001234, ttftMs: 210.5,
    tokensPerSec: 18.25, malformedToolCall: true,
    fileChanges: { "src/foo.py": { added: 3, removed: 1 } },
    contextTokens: 4096, contextTokensSource: "reported", contextWindow: 131072,
  });
  assert.equal(full?.promptTokens, 120);
  assert.equal(full?.completionTokens, 40);
  assert.equal(full?.costUsd, 0.001234);
  assert.equal(full?.ttftMs, 210.5);
  assert.equal(full?.tokensPerSec, 18.25);
  assert.equal(full?.malformedToolCall, true);
  assert.deepEqual(full?.fileChanges, { "src/foo.py": { added: 3, removed: 1 } });
  assert.equal(full?.contextTokensSource, "reported");

  // A run whose transport never reported usage: every new field is simply
  // absent (never a fabricated 0/false), except fileChanges which the kernel
  // always sends (possibly {}).
  const minimal = normalizeBridgeEvent({
    type: "result", runId: "r1", ok: true, finalText: "done", fileChanges: {},
  });
  assert.equal(minimal?.promptTokens, undefined);
  assert.equal(minimal?.costUsd, undefined);
  assert.equal(minimal?.malformedToolCall, undefined);
  assert.deepEqual(minimal?.fileChanges, {});
});

test("config/ready and state parse the additive modelContextWindow field", () => {
  const config = normalizeBridgeEvent({ type: "config", modelContextWindow: 131072 });
  assert.equal(config?.modelContextWindow, 131072);

  // Unresolvable model: reported as null, not omitted — a real, known "unknown".
  const readyUnknown = normalizeBridgeEvent({ type: "ready", modelContextWindow: null });
  assert.equal(readyUnknown?.modelContextWindow, null);

  // state only carries it when the command just changed the model.
  const stateAfterSwitch = normalizeBridgeEvent({ type: "state", ok: true, state: {}, modelContextWindow: 262144 });
  assert.equal(stateAfterSwitch?.modelContextWindow, 262144);
  const stateUnrelated = normalizeBridgeEvent({ type: "state", ok: true, state: {} });
  assert.equal("modelContextWindow" in (stateUnrelated || {}), false);
});

test("hook_dispatch and hooks-status parse fully and with an empty/disabled config", () => {
  // hook_dispatch is emitted via `self.bus.bridge_event(run_id, {...})`, i.e.
  // wrapped in the generic {"type":"bridge_event","event":{...}} envelope —
  // NOT a top-level event — so this must round-trip through the same
  // unwrapping normalizeBridgeEvent already does for every other bridge_event
  // payload. The inner record's OWN `event` field ("PreToolUse") is the hook
  // lifecycle stage, distinct from (and normalized alongside) the wrapper.
  const dispatch = normalizeBridgeEvent({
    type: "bridge_event", runId: "r1", path: [], lane: null, ts: "2026-01-01T00:00:01Z",
    event: {
      type: "hook_dispatch", runId: "r1", event: "PreToolUse", tool: "write_file",
      allowed: false, blockedBy: "prettier --check", reason: "hook denied",
      outcomes: [{ command: "prettier --check", matcher: "*", ok: false, returncode: 1, timedOut: false, reason: "exit 1" }],
      ts: "2026-01-01T00:00:00Z",
    },
  });
  assert.equal(dispatch?.type, "hook_dispatch");
  assert.equal(dispatch?.event, "PreToolUse");
  assert.equal(dispatch?.allowed, false);
  assert.equal((dispatch?.outcomes as unknown[])?.length, 1);

  // A no-match/allowed dispatch still carries the required fields, just with
  // an empty outcomes list and allowed:true — the "nothing happened" case
  // the kernel deliberately does NOT emit live (see _dispatch_hook), so this
  // only needs to parse correctly if a caller ever constructs/replays one.
  const minimalDispatch = normalizeBridgeEvent({
    type: "hook_dispatch", runId: "r1", event: "PostToolUse", tool: null,
    allowed: true, blockedBy: null, reason: "", outcomes: [], ts: "2026-01-01T00:00:00Z",
  });
  assert.equal(minimalDispatch?.allowed, true);
  assert.deepEqual(minimalDispatch?.outcomes, []);

  const status = normalizeBridgeEvent({
    type: "hooks", ok: true,
    config: { enabled: false, source: null, error: null, rules: [] },
    preToolUseScope: "manual-approval tool calls only (write/exec risk)",
    recent: [],
  });
  assert.equal((status?.config as { enabled?: boolean } | undefined)?.enabled, false);
  assert.deepEqual(status?.recent, []);
});

test("checkpoints and checkpoint_result parse an empty list and a failed restore", () => {
  const empty = normalizeBridgeEvent({ type: "checkpoints", ok: true, session: "", items: [] });
  assert.deepEqual(empty?.items, []);

  const populated = normalizeBridgeEvent({
    type: "checkpoints", ok: true, session: "sess-1",
    items: [{ id: "cp-1", path: "src/foo.py", existed: true, backupPath: "cp-1.bak", ts: "2026-01-01T00:00:00Z", tool: "edit_file" }],
  });
  assert.equal((populated?.items as unknown[])?.length, 1);

  const failedRestore = normalizeBridgeEvent({
    type: "checkpoint_result", ok: false, action: "restore", session: "sess-1",
    detail: "unknown checkpoint id 'cp-9'", errorType: "not_found",
  });
  assert.equal(failedRestore?.ok, false);
  assert.equal(failedRestore?.errorType, "not_found");

  const undoOk = normalizeBridgeEvent({
    type: "checkpoint_result", ok: true, action: "undo", session: "sess-1",
    detail: "restored src/foo.py from cp-3", errorType: null,
  });
  assert.equal(undoOk?.ok, true);
  assert.equal(undoOk?.errorType, null);
});

test("local_engine_report, adapter_status, model_preflight parse fully and with only their required fields", () => {
  const report = normalizeBridgeEvent({
    type: "local_engine_report", ok: true, requestId: "req-1",
    osName: "Darwin", machine: "arm64", isAppleSilicon: true, hasNvidia: false,
    mlxImportable: true, ollamaInstalled: true, ollamaRunning: false,
    endpoints: [{ name: "mlx", provider: "mlx", baseUrl: "http://127.0.0.1:8000", installed: true, running: true }],
    modelCounts: { ollama: 2, huggingFace: 0, mlx: 5, gguf: 2 },
    modelFiles: ["/models/deepseek-v4-flash.gguf", "/models/glm-5.2.gguf"],
    recommendation: "mlx", setupSuggestions: [],
  });
  assert.equal(report?.osName, "Darwin");
  assert.equal((report?.endpoints as unknown[])?.length, 1);
  assert.equal((report?.modelFiles as unknown[])?.length, 2);

  // Runtime detection itself failed: only {type, ok:false, error, requestId} —
  // every other field genuinely absent, not a fabricated default.
  const reportError = normalizeBridgeEvent({
    type: "local_engine_report", ok: false, requestId: "req-2",
    error: "RuntimeError: probe failed",
  });
  assert.equal(reportError?.ok, false);
  assert.equal(reportError?.osName, undefined);

  const adapterConfigured = normalizeBridgeEvent({
    type: "adapter_status", ok: true, configured: true,
    path: "/Users/x/.sophia/adapters/run-1", name: "run-1", exists: true,
    cachedAdapters: ["run-1", "run-2"],
  });
  assert.equal(adapterConfigured?.configured, true);

  const adapterUnconfigured = normalizeBridgeEvent({
    type: "adapter_status", ok: true, configured: false, path: null, name: null,
    exists: false, cachedAdapters: [],
  });
  assert.equal(adapterUnconfigured?.configured, false);
  assert.equal(adapterUnconfigured?.path, null);

  const preflightReady = normalizeBridgeEvent({
    type: "model_preflight", ok: true, model: "mock", requestId: "req-3",
    spec: "mock", ready: true, reason: "ok", transport: "mock", endpoint: null, fix: null,
  });
  assert.equal(preflightReady?.ready, true);
  assert.equal(preflightReady?.fix, null);

  // The bridge's own auto-emitted not-ready preflight before a run: no
  // requestId (nothing asked for it), no model_preflight ok field guaranteed —
  // it is the SAME shape spread onto a bridge_event, not a reply.
  const preflightAuto = normalizeBridgeEvent({
    type: "bridge_event", runId: "r1",
    event: {
      type: "model_preflight", ready: false, reason: "endpoint unreachable",
      transport: "http", endpoint: "http://127.0.0.1:8000", fix: "start the local server",
    },
  });
  assert.equal(preflightAuto?.type, "model_preflight");
  assert.equal(preflightAuto?.ready, false);
  assert.equal(preflightAuto?.runId, "r1");
});

test("new one-shot kernel-capability replies are QoS-critical, like their diagnostic_snapshot/mcp_health siblings", () => {
  for (const type of [
    "hooks", "checkpoints", "checkpoint_result",
    "local_engine_report", "adapter_status", "model_preflight",
    "shell_start", "shell_result",
  ]) {
    assert.equal(bridgeEventQoS({ type }).class, "critical", `${type} must not be droppable/coalescable`);
  }
});
