#!/usr/bin/env node
// Test-only stand-in for the real python bridge (agent/code_bridge.py),
// launched through CodeBridge's explicit test-process override in
// bridge.test.ts so the flow-control/stall tests stay cross-platform and
// hermetic (no real python process, no LLM calls).
//
// Modes, selected by FAKE_BRIDGE_MODE:
//   "silent"    — never reads stdin, never writes stdout. Simulates a fully
//                 wedged child for stall-detection tests.
//   "recover"   — like "silent" until FAKE_BRIDGE_HOLD_MS ms, then writes a
//                 stdout line every 20ms (sustained, not a single blip — a
//                 one-shot line would race the next stall re-check and make
//                 the test timing-flaky), so tests can assert a surfaced
//                 stall clears once real activity resumes.
//   "wake-on-command"
//               — like "silent" until the parent sends a {"cmd":"wake"} line,
//                 then writes every 20ms. Recovery is driven by an EVENT the
//                 test controls rather than a timer, so a test can wait for
//                 "has it stalled yet?" for as long as a loaded machine needs
//                 without ever racing the recovery. This is what makes the
//                 stall test deterministic: "recover" forced the assertion to
//                 land inside a fixed window between the stall threshold and
//                 the timed recovery, and under load it landed outside.
//   "slow-echo" — does not read stdin for FAKE_BRIDGE_HOLD_MS ms (so writes
//                 the parent makes in the meantime pile up and can trigger
//                 real stdin-write backpressure), then reads every buffered
//                 line and echoes it back as {"type":"echo","line":...} so
//                 a test can confirm what was actually delivered, and in
//                 what order, once the queue drains.
//   "cancel-ack" — silent (so a run stalls) until the parent sends a
//                 {"cmd":"cancel"} line, then acks with one {"type":"cancelled"}
//                 stdout line. Lets a test assert the bridge's auto-cancel both
//                 fired AND reached the child; the ack arrives after the give-up
//                 so it cannot prevent the stall that triggered it.
//
// Deliberately dependency-free stdlib-only Node so it needs nothing beyond
// the `node` binary already required to run the test suite itself.

const mode = process.env.FAKE_BRIDGE_MODE || "silent";
const holdMs = Number(process.env.FAKE_BRIDGE_HOLD_MS || "0");

function readAllLines(onLine) {
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
  });
}

function startChatter() {
  setInterval(() => {
    process.stdout.write(`${JSON.stringify({ type: "log", text: "still here" })}\n`);
  }, 20);
}

if (mode === "garbage-line") {
  // A stdout line that is not JSON at all. The client turns it into
  // {type:"log"}; nothing consumed that, so it vanished silently.
  process.stdout.write("this is not json at all\n");
} else if (mode === "split-secret") {
  // Write a secret in TWO stderr chunks with no newline between them, the way a
  // pipe can split any line. Per-chunk redaction matches neither half and the
  // secret reassembles on screen; per-line redaction sees the whole line.
  process.stderr.write("OPENAI_API_KEY=sk-proj-");
  setTimeout(() => process.stderr.write("abcdef123456\n"), 50);
} else if (mode === "recover") {
  setTimeout(startChatter, holdMs);
} else if (mode === "wake-on-command") {
  let woken = false;
  readAllLines((line) => {
    // Only an explicit wake counts. The `run` command the parent sends to arm
    // stall detection also arrives here and must NOT be mistaken for one.
    if (woken || !line.includes('"wake"')) return;
    woken = true;
    startChatter();
  });
} else if (mode === "ready-then-silent") {
  // Announce readiness, accept one run, then go permanently quiet.
  //
  // The existing "silent" mode cannot exercise stall DETECTION end to end: the
  // client only arms its stall clock once a run is in flight, and App.tsx will
  // not submit a run until the bridge reports ready — so a never-ready child
  // just sits at "starting bridge…" and nothing stalls. This is the shape of a
  // kernel that came up fine and then wedged mid-run, which is the case the
  // operator actually cannot diagnose without help.
  process.stdout.write(`${JSON.stringify({
    type: "ready", protocolVersion: 1, app: "Sophia Code",
    models: [{ alias: "mock", label: "Mock offline model" }],
    canClaimAGI: false,
  })}\n`);
  readAllLines(() => {
    /* consume stdin so writes never block, but answer nothing, ever */
  });
} else if (mode === "slow-echo") {
  setTimeout(() => {
    readAllLines((line) => {
      process.stdout.write(`${JSON.stringify({ type: "echo", line })}\n`);
    });
  }, holdMs);
} else if (mode === "cancel-ack") {
  // Silent (so an in-flight run stalls and the give-up can fire) until the
  // parent sends a {"cmd":"cancel"} line, then ack with ONE stdout line. The
  // ack arrives AFTER the give-up has already emitted stall_timeout (the cancel
  // is its consequence), so a test can assert both that the auto-cancel was
  // DECIDED and that it actually REACHED the child — without the ack preventing
  // the stall that triggered it. The arming `run` line also arrives here and is
  // ignored (it is not a cancel).
  readAllLines((line) => {
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      return;
    }
    if (command?.cmd !== "cancel") return;
    process.stdout.write(`${JSON.stringify({ type: "cancelled", reason: command.reason })}\n`);
  });
}
// mode === "silent": intentionally do nothing — no stdin reader, no stdout writer.

// Keep-alive independent of stdio activity; the parent always tears this
// down via bridge.stop() (SIGTERM after its own timeout) between tests.
setInterval(() => {}, 1_000_000_000);
