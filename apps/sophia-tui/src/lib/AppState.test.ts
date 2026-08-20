import assert from "node:assert/strict";
import test from "node:test";
import { epistemicDetailLines } from "../components/EpistemicChip.js";
import * as appModule from "../App.js";
import {
  approvalQueueReducer,
  createSessionTransitionPresentation,
  imageExecutionPolicy,
  type PendingApproval,
} from "../App.js";

const approval = (
  id: string,
  tool: string,
  kind: PendingApproval["kind"] = "tool",
): PendingApproval => ({
  kind,
  id,
  tool,
  preview: `${tool} preview`,
});

test("concurrent approval requests queue by id and decisions advance FIFO", () => {
  let queue = approvalQueueReducer([], {
    type: "enqueue",
    approval: approval("approval-a", "write_file"),
  });
  queue = approvalQueueReducer(queue, {
    type: "enqueue",
    approval: approval("approval-b", "shell"),
  });
  assert.deepEqual(queue.map((item) => item.id), ["approval-a", "approval-b"]);

  queue = approvalQueueReducer(queue, {
    type: "enqueue",
    approval: { ...approval("approval-b", "shell"), preview: "updated preview" },
  });
  assert.equal(queue.length, 2, "a replayed id updates rather than duplicating");
  assert.equal(queue[1].preview, "updated preview");

  queue = approvalQueueReducer(queue, { type: "resolve", id: "approval-a" });
  assert.equal(queue[0].id, "approval-b", "a y/n decision reveals the next request");
  queue = approvalQueueReducer(queue, { type: "resolve", id: "approval-b" });
  assert.deepEqual(queue, []);
});

test("approval queue cleanup releases every pending tool and local confirmation", () => {
  const queue = [
    approval("approval-a", "write_file"),
    approval("confirm-a", "Archive session", "local"),
  ];
  assert.deepEqual(approvalQueueReducer(queue, { type: "clear" }), []);
});

test("new or empty session presentation cannot leak the prior gate chip or report", () => {
  const next = createSessionTransitionPresentation("ready · empty-session (empty)");
  assert.equal(next.epistemic, null, "StatusLine receives no prior gate chip");
  assert.deepEqual(
    epistemicDetailLines(next.epistemic),
    ["No gate report for this turn."],
    "Ctrl+G cannot report the previous session's verdict",
  );
  assert.equal(next.contextUsage, "");
  assert.equal(next.lastCost, "");
  assert.equal(next.running, false);
  assert.equal(next.cancelling, false);
  assert.deepEqual(next.progress, { phase: "idle", detail: "", streamPreview: "" });
  assert.equal(next.status, "ready · empty-session (empty)");
});

test("only a successful resume can persist the selected session", () => {
  const settingsFor = (appModule as unknown as {
    sessionSelectionSettings?: (result: { ok: boolean; session: string }) => {
      session: string;
      selectedSessionID: string;
    } | null;
  }).sessionSelectionSettings;
  assert.equal(typeof settingsFor, "function", "App must expose its session selection decision");
  assert.equal(settingsFor!({ ok: false, session: "corrupt-target" }), null);
  assert.deepEqual(settingsFor!({ ok: true, session: "loaded-target" }), {
    session: "loaded-target",
    selectedSessionID: "loaded-target",
  });
});

test("raw session fallback accepts only a coalesced navigation-plus-Enter chunk", () => {
  const isCoalesced = (appModule as unknown as {
    isCoalescedSessionNavigationEnter?: (raw: string) => boolean;
  }).isCoalescedSessionNavigationEnter;
  assert.equal(typeof isCoalesced, "function", "App must expose its raw fallback classifier");
  assert.equal(isCoalesced!("\r"), false, "bare Enter belongs to the stable Ink handler");
  assert.equal(isCoalesced!("\n"), false);
  assert.equal(isCoalesced!("\u001b[B\r"), true);
  assert.equal(isCoalesced!("\u001b[1;2A\n"), true);
  assert.equal(isCoalesced!("\u009bB\r"), true);
  assert.equal(isCoalesced!("literal text\r"), false);
});

test("readonly rejects every image writer and delegated approval names its authority", () => {
  const blocked = imageExecutionPolicy("readonly", "grok-cli");
  assert.equal(blocked.delegated, true);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.disclosure, /autonomous filesystem, network, and tool authority/i);

  assert.equal(imageExecutionPolicy("manual", "grok-cli").allowed, true);
  assert.equal(imageExecutionPolicy("readonly", "openai").allowed, false);
});
