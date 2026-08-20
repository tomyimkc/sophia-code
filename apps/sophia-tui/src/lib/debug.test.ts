import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tuiDebugText, appendTuiDebug } from "./debug.js";

test("debug metadata excludes prompt payloads", () => {
  const text = tuiDebugText({ lifecycle: "run_start", runId: "run-1", path: ["lane-1"] });
  assert.match(text, /run-1/);
  assert.doesNotMatch(text, /prompt|payload/);
});

test("debug appends safe JSONL to an injected cross-platform path", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sophia-tui-debug-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "debug.jsonl");
  appendTuiDebug({ lifecycle: "error", error: "safe", runId: "run-1" }, file);
  const row = JSON.parse(readFileSync(file, "utf8").trim());
  assert.equal(row.lifecycle, "error");
  assert.equal(row.runId, "run-1");
});
