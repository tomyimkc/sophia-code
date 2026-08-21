#!/usr/bin/env node
/**
 * Real-kernel bridge smoke: spawn the actual Python bridge through the same
 * resolver the TUI uses, perform the ready/config handshake, and shut down.
 *
 * Unlike the unit suite (which drives CodeBridge against a Node fixture child),
 * this proves the resolved interpreter really launches `agent.code_bridge`
 * on the host OS — including the win32 `python`/`py -3` probe path on
 * windows-latest CI.
 *
 * Usage: node --import tsx scripts/smoke-bridge.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePythonLaunch } from "../src/lib/pythonResolver.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const TIMEOUT_MS = 30_000;

const launch = resolvePythonLaunch(process.env);
const argv = [...launch.preArgs, "-P", "-m", "agent.code_bridge"];
process.stdout.write(
  `smoke-bridge: ${launch.command} ${argv.join(" ")} (source: ${launch.source}` +
  `${launch.version ? `, ${launch.version}` : ""})\n`,
);

const child = spawn(launch.command, argv, {
  cwd: repoRoot,
  env: {
    ...process.env,
    PYTHONPATH: [repoRoot, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
    PYTHONUNBUFFERED: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let settled = false;
const fail = (message) => {
  if (settled) return;
  settled = true;
  child.kill();
  console.error(`smoke-bridge: FAIL — ${message}`);
  process.exit(1);
};

const timer = setTimeout(
  () => fail(
    sawEnvelope
      ? `bridge did not exit after shutdown; stderr tail:\n${stderrTail}`
      : "timed out waiting for the bridge handshake",
  ),
  TIMEOUT_MS,
);
timer.unref();

let sawEnvelope = false;
child.stdout.setEncoding("utf8");
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      continue;
    }
    if (envelope?.app === "Sophia Code" || envelope?.type === "ready" || envelope?.type === "config") {
      sawEnvelope = true;
      process.stdout.write(`smoke-bridge: handshake ok (protocol ${envelope.protocol ?? "?"})\n`);
      // Same shutdown contract as the production client (bridge.stop): send
      // the command, then close stdin. The kernel's reader loop exits on EOF,
      // so the pipe close is what actually ends the process; the command
      // makes it emit a final `bye` first.
      child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      child.stdin.end();
    }
  }
});

let stderrTail = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-2000);
});

child.on("error", (err) => {
  clearTimeout(timer);
  fail(
    `could not spawn ${launch.command} (${err.message}). ` +
    "Install Python 3.11+ or set SOPHIA_PYTHON.",
  );
});

child.on("close", (code) => {
  clearTimeout(timer);
  if (settled) return;
  settled = true;
  if (!sawEnvelope) {
    console.error(`smoke-bridge: no bridge envelope; stderr tail:\n${stderrTail}`);
    process.exit(1);
  }
  // The bridge exits 0 on shutdown; tolerate a nonzero-but-orderly exit only
  // if the handshake already succeeded and stderr explains a clean refusal.
  if (code !== 0) {
    console.error(`smoke-bridge: handshake ok but exit code ${code}; stderr tail:\n${stderrTail}`);
    process.exit(1);
  }
  process.stdout.write("smoke-bridge: PASS\n");
  process.exit(0);
});
