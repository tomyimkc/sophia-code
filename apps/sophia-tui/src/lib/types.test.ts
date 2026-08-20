import test from "node:test";
import assert from "node:assert/strict";

import { classifyToolResult, formatLiveToolStatus } from "./types.js";

// classifyToolResult is the SINGLE source of truth for tool-row ✓/✗/⏺ across
// the live-run bridge path (App.tsx) and the disk-resume projection
// (sessionStore.pushToolFeedbackBlocks). These tests lock the strict (disk)
// semantics so the two paths cannot silently diverge again.

test("classifyToolResult: happy path — named tool, clean body", () => {
  const r = classifyToolResult({ toolName: "read_file", body: "the file contents" });
  assert.equal(r.failed, false);
  assert.equal(r.meta, "read_file");
});

test("classifyToolResult: empty tool name (parallel-slot artifact) fails and normalizes meta", () => {
  // Qwen/vLLM sometimes emits parallel tool_call slots with no name. Live this
  // used to render as a dangling ⏺ "tool"; disk showed ✗ (empty). Both must
  // now show ✗ (empty) — the unified strict predicate.
  const r = classifyToolResult({ toolName: "", body: "(empty)" });
  assert.equal(r.failed, true);
  assert.equal(r.meta, "(empty)");
});

test("classifyToolResult: whitespace-only tool name is treated as empty", () => {
  const r = classifyToolResult({ toolName: "   ", body: "x" });
  assert.equal(r.failed, true);
  assert.equal(r.meta, "(empty)");
});

test("classifyToolResult: ERROR-prefixed body fails", () => {
  const r = classifyToolResult({ toolName: "outline", body: "ERROR: file not found" });
  assert.equal(r.failed, true);
  assert.equal(r.meta, "outline");
});

test("classifyToolResult: embedded JSON \"ok\": false fails", () => {
  // Some tools return a JSON envelope with its own ok flag inside the body text.
  const r = classifyToolResult({
    toolName: "grep",
    body: '{"ok": false, "matches": []}',
  });
  assert.equal(r.failed, true);
});

test("classifyToolResult: schema / unknown-tool substrings fail", () => {
  const cases = [
    "unknown tool 'frob' for this kernel",
    "missing required property: path",
    "schema_missing: write_file",
    "schema_invalid: args.path must be string",
  ];
  for (const body of cases) {
    const r = classifyToolResult({ toolName: "x", body });
    assert.equal(r.failed, true, `expected failure for body: ${body}`);
  }
});

test("classifyToolResult: a sibling ERROR in the SAME body is detected (per-block, not per-blob)", () => {
  // pushToolFeedbackBlocks splits the blob BEFORE calling this, so each block
  // is judged alone — one ERROR must not taint a sibling ok tool. This test
  // pins that the classifier itself fails on an ERROR anywhere in its body,
  // and the splitting is the caller's job (covered in sessionStore.test.ts).
  const r = classifyToolResult({
    toolName: "read_file",
    body: "first line\nERROR: disk full\nthird line",
  });
  assert.equal(r.failed, true, "ERROR on a non-first line must still fail");
});

test("classifyToolResult: clean JSON body with ok: true does NOT fail", () => {
  const r = classifyToolResult({
    toolName: "list_dir",
    body: '{"ok": true, "entries": ["a", "b"]}',
  });
  assert.equal(r.failed, false);
});

test("classifyToolResult: missing/undefined args are safe (no throw)", () => {
  // Defensive — live bridge events can carry undefined fields.
  // @ts-expect-error — intentionally omitting fields
  const r1 = classifyToolResult({});
  assert.equal(r1.failed, true);
  assert.equal(r1.meta, "(empty)");
  const r2 = classifyToolResult({ toolName: "x", body: "" });
  assert.equal(r2.failed, false);
  assert.equal(r2.meta, "x");
});

test("formatLiveToolStatus keeps name, phase, and uncapped live args/result", () => {
  const args = JSON.stringify({ cmd: "npm test", cwd: "/repo" });
  assert.equal(
    formatLiveToolStatus({ toolName: "exec_command", phase: "running", body: args }),
    `exec_command · running · ${args}`,
  );
  assert.equal(
    formatLiveToolStatus({ toolName: "exec_command", phase: "waiting", body: "20s" }),
    "exec_command · waiting · 20s",
  );
  const body = "ok\n".repeat(2000);
  const done = formatLiveToolStatus({
    toolName: "exec_command",
    phase: "done",
    body,
  });
  assert.ok(done.startsWith("exec_command · done · "));
  assert.ok(done.length <= 8000);
  assert.ok(done.length > 4000);
});
