import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "./types.js";
import {
  isTranscriptMessageVisible,
  verboseTranscriptEnabled,
  visibleTranscriptMessages,
} from "./transcriptVisibility.js";

const system = (
  id: string,
  text: string,
  meta?: string,
  ok?: boolean,
): ChatMessage => ({ id, role: "system", text, meta, ok });

test("normal transcript hides installed-runtime hash diagnostics", () => {
  const warning = system(
    "runtime",
    "⚠ executing runtime differs from workspace at agent/code_bridge.py · runtime a51239f1b598 ≠ workspace 0ceeb7876da1 · backend claims must use runtime-source tools",
    "runtime",
    false,
  );
  assert.equal(isTranscriptMessageVisible(warning), false);
  assert.equal(isTranscriptMessageVisible(warning, true), true);
});

test("normal transcript keeps conversation, tools, major transitions, and failures", () => {
  const messages: ChatMessage[] = [
    { id: "u", role: "user", text: "Ship it" },
    { id: "tool", role: "tool", meta: "exec_command", text: "npm test" },
    system("agents", "Agents · 3 active", "team"),
    system("workflow", "Workflow · stage 1 · 2 agents", "workflow"),
    system("timeout", "Workflow stage 1 worker timed out", "workflow-timeout", false),
    { id: "a", role: "assistant", text: "Done." },
  ];
  assert.deepEqual(
    visibleTranscriptMessages(messages).map((message) => message.id),
    ["u", "tool", "agents", "workflow", "timeout", "a"],
  );
});

test("normal transcript removes routine orchestration, goal, update, and supervisor chatter", () => {
  const messages = [
    system("plan", "orchestrated before tools · solo dependency plan", "plan"),
    system("goal", "attempt 2 · in_progress (0.40)", "goal"),
    system("triage", "auto-detected parallel task · 3 lanes", "team"),
    system("update", "update: building TUI", "update"),
    system("sessiond-start", "A2A supervisor · terminal · concurrency 2", "sessiond"),
    system("sessiond-end", "A2A supervisor finished · succeeded", "sessiond", true),
    system(
      "sessiond-detached",
      "bridge detached · supervised workers continue headlessly",
      "sessiond",
    ),
  ];
  assert.deepEqual(
    visibleTranscriptMessages(messages).map((message) => message.id),
    ["sessiond-detached"],
  );
});

test("verbose transcript is opt-in through either progress or debug settings", () => {
  assert.equal(verboseTranscriptEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(verboseTranscriptEnabled({
    SOPHIA_TUI_VERBOSE_PROGRESS: "1",
  } as NodeJS.ProcessEnv), true);
  assert.equal(verboseTranscriptEnabled({
    SOPHIA_TUI_DEBUG: "true",
  } as NodeJS.ProcessEnv), true);
});
