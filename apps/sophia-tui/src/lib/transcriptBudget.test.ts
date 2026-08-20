import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "./types.js";
import {
  applyTranscriptBudget,
  createEvictionBanner,
  formatEvictionNotice,
} from "./transcriptBudget.js";

function msg(id: string, role: ChatMessage["role"], text = "x"): ChatMessage {
  return { id, role, text };
}

test("under budget: returns the same array reference and evicts nothing", () => {
  const messages = [msg("1", "user"), msg("2", "assistant")];
  const result = applyTranscriptBudget(messages, { maxMessages: 10 });
  assert.equal(result.messages, messages); // identity, not just deep-equal
  assert.equal(result.evictedCount, 0);
  assert.deepEqual(result.evictedIds, []);
  assert.equal(result.overBudget, false);
});

test("over budget: evicts oldest-first and preserves survivor identity", () => {
  const messages = [
    msg("1", "user"),
    msg("2", "assistant"),
    msg("3", "user"),
    msg("4", "assistant"),
    msg("5", "user"),
    msg("6", "assistant"),
  ];
  const result = applyTranscriptBudget(messages, { maxMessages: 4 }, ["1"]); // pin the first turn too
  assert.equal(result.evictedCount, 2);
  assert.deepEqual(result.evictedIds, ["2", "3"]); // oldest non-protected messages, in order
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["1", "4", "5", "6"],
  );
  assert.equal(result.messages.length, 4); // exactly meets maxMessages once eviction is possible
  // Survivors must be the exact same objects the caller passed in — a WeakMap
  // height cache (chatLayout.ts) is keyed on identity and must stay valid.
  for (const kept of result.messages) {
    const original = messages.find((m) => m.id === kept.id);
    assert.equal(kept, original);
  }
});

test("never evicts the active exchange (last user message onward), even at maxMessages=1", () => {
  const messages = [
    msg("1", "system"),
    msg("2", "user"),
    msg("3", "assistant"),
    msg("4", "user"), // turn 2 starts here
    msg("5", "assistant"),
    msg("6", "tool"),
  ];
  const result = applyTranscriptBudget(messages, { maxMessages: 1 });
  // Everything from the last `user` message onward must survive regardless
  // of how tight the budget is.
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["4", "5", "6"],
  );
  assert.equal(result.overBudget, true); // budget of 1 can't fit a 3-message active exchange
  assert.deepEqual(result.evictedIds, ["1", "2", "3"]);
});

test("caller-supplied protectedIds survive even outside the active exchange", () => {
  const messages = [
    msg("1", "user"),
    msg("2", "assistant"), // e.g. the message the user has scrolled to / focused
    msg("3", "user"),
    msg("4", "assistant"),
    msg("5", "user"),
    msg("6", "assistant"),
  ];
  const result = applyTranscriptBudget(messages, { maxMessages: 2 }, new Set(["2"]));
  const ids = result.messages.map((m) => m.id);
  assert.ok(ids.includes("2"), "pinned/scrolled-to message must survive");
  assert.ok(ids.includes("5") && ids.includes("6"), "active exchange must survive");
});

test("no user message yet: falls back to protecting the last minTailWhenNoUser messages", () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(String(i), "system"));
  const result = applyTranscriptBudget(messages, { maxMessages: 3, minTailWhenNoUser: 4 });
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["6", "7", "8", "9"], // last 4 kept even though maxMessages=3
  );
  assert.equal(result.overBudget, true);
});

test("maxChars evicts even when the message count is within maxMessages", () => {
  const big = "a".repeat(1000);
  const messages = [
    msg("1", "user", big),
    msg("2", "assistant", big),
    msg("3", "user", "recent question"),
    msg("4", "assistant", "recent answer"),
  ];
  const result = applyTranscriptBudget(messages, { maxMessages: 100, maxChars: 500 });
  // Count (4) is well within maxMessages, but total chars (~2000+) trips maxChars,
  // so the huge non-active-exchange messages get dropped even though maxMessages didn't force it.
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["3", "4"],
  );
  assert.equal(result.evictedCount, 2);
});

test("empty transcript: no-op", () => {
  const result = applyTranscriptBudget([], { maxMessages: 50 });
  assert.deepEqual(result.messages, []);
  assert.equal(result.evictedCount, 0);
  assert.equal(result.overBudget, false);
});

test("formatEvictionNotice pluralizes and reports a running total", () => {
  assert.equal(
    formatEvictionNotice(1),
    "transcript trimmed · 1 older message dropped to stay within the memory budget",
  );
  assert.equal(
    formatEvictionNotice(3, 3),
    "transcript trimmed · 3 older messages dropped to stay within the memory budget",
  );
  assert.equal(
    formatEvictionNotice(3, 12),
    "transcript trimmed · 3 older messages dropped to stay within the memory budget (12 dropped total this session)",
  );
});

test("createEvictionBanner is shaped for App.tsx's push(Omit<ChatMessage,'id'>)", () => {
  const banner = createEvictionBanner(5, 5);
  assert.equal(banner.role, "system");
  assert.match(banner.text, /5 older messages dropped/);
  assert.equal("id" in banner, false); // caller assigns the id (uid()), same contract as push()
});

// --- Measured effect on a long session (evidence for the memory claim) -----
// A real coding session's transcript is dominated by tool output / assistant
// text, not just message count, so this simulates a mixed 5000-message
// session (realistic-length text) and reports actual before/after numbers
// rather than asserting a synthetic worst case.
test("measured: caps a long-running session's element count and retained chars", () => {
  const SESSION_LENGTH = 5000;
  const roles: ChatMessage["role"][] = ["user", "assistant", "tool", "thinking"];
  const messages: ChatMessage[] = Array.from({ length: SESSION_LENGTH }, (_, i) => ({
    id: String(i),
    role: roles[i % roles.length],
    text: `message ${i} `.repeat(20), // ~240 chars, representative of a short tool/chat line
  }));
  const beforeChars = messages.reduce((sum, m) => sum + m.text.length, 0);

  const budget = { maxMessages: 500, maxChars: 400_000 };
  const result = applyTranscriptBudget(messages, budget);
  const afterChars = result.messages.reduce((sum, m) => sum + (m.text?.length ?? 0), 0);

  console.log(
    `[transcriptBudget measured] elements ${SESSION_LENGTH} -> ${result.messages.length} ` +
      `(${(((SESSION_LENGTH - result.messages.length) / SESSION_LENGTH) * 100).toFixed(1)}% dropped), ` +
      `chars ${beforeChars} -> ${afterChars} ` +
      `(${(((beforeChars - afterChars) / beforeChars) * 100).toFixed(1)}% dropped), ` +
      `evictedCount=${result.evictedCount}`,
  );

  assert.ok(result.messages.length <= budget.maxMessages || result.overBudget);
  assert.ok(result.messages.length < SESSION_LENGTH, "budget must actually shrink a long session");
  assert.ok(afterChars < beforeChars);
});
