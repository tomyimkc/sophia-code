import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatFinishedPayload,
  onceExitCode,
  writeFinishedPayload,
} from "./once.js";

const DONE = {
  type: "run_finished",
  session: "once-test",
  runId: "run-1",
  ok: true,
  mode: "solo",
  reason: "verified",
  subs: [],
  endedAt: "2026-08-13T00:00:00Z",
};

test("once exits from run_finished success/failure rather than answer result", () => {
  assert.equal(onceExitCode(DONE), 0);
  assert.equal(onceExitCode({ ...DONE, ok: false, reason: "error" }), 1);
  assert.equal(formatFinishedPayload(DONE), JSON.stringify(DONE));
});

test("once writes the terminal payload to stdout or an atomic output file", () => {
  let stdout = "";
  writeFinishedPayload(DONE, undefined, (text) => {
    stdout += text;
  });
  assert.equal(stdout, `${JSON.stringify(DONE)}\n`);

  const directory = mkdtempSync(path.join(os.tmpdir(), "sophia-once-"));
  const target = path.join(directory, "nested", "finished.json");
  writeFinishedPayload(DONE, target);
  assert.equal(readFileSync(target, "utf8"), `${JSON.stringify(DONE)}\n`);
});
