import test from "node:test";
import assert from "node:assert/strict";

import type { ChatMessage } from "./types.js";
import {
  adaptChatMessageToToolEvent,
  approvalRequestFromLegacy,
  inferToolRisk,
  legacyApprovalChoices,
  projectToolTimeline,
  scopedApprovalChoices,
} from "./toolState.js";

test("current ChatMessage call/result rows correlate by per-tool FIFO and keep the call ID stable", () => {
  const messages: ChatMessage[] = [
    { id: "call-1", role: "tool", meta: "read_file", text: '{"path":"README.md"}' },
    { id: "result-1", role: "tool", meta: "read_file", text: "# Sophia", ok: true },
  ];
  const timeline = projectToolTimeline(messages);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, "tool_batch");
  if (timeline[0].kind !== "tool_batch") return;
  const tool = timeline[0].batch.tools[0];
  assert.equal(tool.stableId, "tool:call-1");
  assert.equal(tool.callMessageId, "call-1");
  assert.equal(tool.resultMessageId, "result-1");
  assert.equal(tool.status, "succeeded");
  assert.deepEqual(tool.args, { path: "README.md" });
  assert.equal(tool.output, "# Sophia");
  assert.deepEqual(tool.sourceMessageIds, ["call-1", "result-1"]);
});

test("explicit IDs correlate out-of-order parallel results into one stable batch", () => {
  const messages = [
    {
      id: "row-a",
      role: "tool",
      text: "",
      meta: "read_file",
      toolCallId: "call-a",
      batchId: "parallel-7",
      args: { path: "a.txt" },
    },
    {
      id: "row-b",
      role: "tool",
      text: "",
      meta: "search",
      toolCallId: "call-b",
      batchId: "parallel-7",
      args: { query: "needle" },
    },
    {
      id: "done-b",
      role: "tool",
      text: "1 hit",
      meta: "search",
      ok: true,
      toolCallId: "call-b",
      durationMs: 12,
      artifacts: ["reports/search.log"],
    },
    {
      id: "done-a",
      role: "tool",
      text: "contents",
      meta: "read_file",
      ok: false,
      toolCallId: "call-a",
      durationMs: 20,
    },
  ] as unknown as ChatMessage[];
  const timeline = projectToolTimeline(messages);
  assert.equal(timeline.length, 1);
  if (timeline[0].kind !== "tool_batch") return;
  assert.equal(timeline[0].batch.id, "parallel-7");
  assert.equal(timeline[0].batch.parallel, true);
  assert.deepEqual(timeline[0].batch.tools.map((tool) => tool.stableId), ["call-a", "call-b"]);
  assert.deepEqual(timeline[0].batch.tools.map((tool) => tool.status), ["failed", "succeeded"]);
  assert.equal(timeline[0].batch.tools[1].durationMs, 12);
  assert.equal(timeline[0].batch.tools[1].artifacts[0].kind, "log");
});

test("adjacent legacy calls form a parallel batch and do not duplicate result rows", () => {
  const messages: ChatMessage[] = [
    { id: "c1", role: "tool", meta: "read", text: "a" },
    { id: "c2", role: "tool", meta: "find", text: "b" },
    { id: "r1", role: "tool", meta: "read", text: "A", ok: true },
    { id: "r2", role: "tool", meta: "find", text: "B", ok: true },
    { id: "a", role: "assistant", text: "done" },
  ];
  const timeline = projectToolTimeline(messages);
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].kind, "tool_batch");
  if (timeline[0].kind !== "tool_batch") return;
  assert.equal(timeline[0].batch.parallel, true);
  assert.equal(timeline[0].batch.tools.length, 2);
  assert.equal(timeline[1].kind, "message");
});

test("the structural adapter reads enriched cwd, timing, risk, args, diff, and artifacts", () => {
  const message = {
    id: "m",
    role: "tool",
    meta: "apply_patch",
    text: "",
    toolState: {
      toolCallId: "stable",
      status: "completed",
      risk: "high",
      cwd: "/repo",
      args: { patch: "*** Begin Patch" },
      durationMs: 42,
      diff: "@@ -1 +1 @@\n-old\n+new",
      artifacts: [{ label: "Patch", path: "/tmp/change.patch" }],
    },
    ok: true,
  } as unknown as ChatMessage;
  const event = adaptChatMessageToToolEvent(message);
  assert.ok(event);
  assert.equal(event?.explicitStableId, "stable");
  assert.equal(event?.cwd, "/repo");
  assert.equal(event?.durationMs, 42);
  assert.equal(event?.risk, "high");
  assert.match(event?.diff || "", /-old/);
  assert.equal(event?.artifacts[0].kind, "diff");
});

test("risk inference distinguishes destructive, mutating, and read-only calls", () => {
  assert.equal(inferToolRisk("exec_command", { cmd: "rm -rf build" }), "critical");
  assert.equal(inferToolRisk("apply_patch", { path: "src/a.ts" }), "medium");
  assert.equal(inferToolRisk("read_file", { path: "src/a.ts" }), "low");
  assert.equal(inferToolRisk("custom_widget", {}), "unknown");
});

test("approval choices are typed scopes while legacy presentation advertises only wired y/n keys", () => {
  const request = approvalRequestFromLegacy({
    id: "approval-1",
    tool: "exec_command",
    preview: '{"cwd":"/repo","cmd":"npm test"}',
  });
  assert.equal(request.cwd, "/repo");
  assert.equal(request.risk, "medium");

  const legacy = legacyApprovalChoices(request);
  assert.deepEqual(legacy.map((choice) => choice.key), ["y", "n"]);
  assert.ok(legacy.every((choice) => choice.scope.kind === "call"));

  const scoped = scopedApprovalChoices(request);
  assert.deepEqual(scoped.map((choice) => choice.key), ["y", "t", "w", "n"]);
  assert.deepEqual(scoped.map((choice) => choice.scope.kind), ["call", "tool", "cwd", "call"]);
});
