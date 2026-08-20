import type { ChatMessage } from "./types.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Normal Sophia sessions use a concise transcript. Detailed orchestration and
 * provenance diagnostics remain available when the operator explicitly asks
 * for them instead of permanently occupying the chat pane.
 */
export function verboseTranscriptEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return [env.SOPHIA_TUI_VERBOSE_PROGRESS, env.SOPHIA_TUI_DEBUG]
    .some((value) => TRUE_VALUES.has(String(value || "").trim().toLowerCase()));
}

function isRoutineGoalProgress(text: string): boolean {
  return /^(?:auto-detected goal|goal accumulated|goal mode|attempt\s|↻\s*continuing)/i.test(text);
}

function isRoutineUpdateProgress(text: string): boolean {
  return /^(?:updating from\b|update:)/i.test(text);
}

function isActionableSupervisorMessage(text: string): boolean {
  return /\b(?:detached|failed|timeout|timed out|cancelled|abandoned|approval|permission)\b/i.test(text);
}

/**
 * Durable chat should contain conversation, tool evidence, major agent or
 * workflow transitions, and actionable failures. High-frequency diagnostics
 * stay in the bridge event/debug stores and the replace-in-place progress row.
 */
export function isTranscriptMessageVisible(
  message: ChatMessage,
  verbose = false,
): boolean {
  if (verbose || message.role !== "system") return true;

  const meta = String(message.meta || "").trim().toLowerCase();
  const text = String(message.text || "").trim();

  // Packaged Sophia intentionally executes its installed runtime while acting
  // on the selected workspace. The hashes are useful diagnostics, but not an
  // operator action item and not normal conversation.
  if (
    meta === "runtime"
    || /^⚠\s*executing runtime differs from workspace\b/i.test(text)
  ) {
    return false;
  }

  if (message.ok === false) return true;
  if (meta === "plan" || meta === "workflow-progress") return false;
  if (meta === "goal" && isRoutineGoalProgress(text)) return false;
  if (meta === "team" && /^auto-detected parallel task\b/i.test(text)) return false;
  if (meta === "update" && isRoutineUpdateProgress(text)) return false;
  if (meta === "sessiond") return isActionableSupervisorMessage(text);

  return true;
}

export function visibleTranscriptMessages(
  messages: readonly ChatMessage[],
  verbose = false,
): ChatMessage[] {
  return messages.filter((message) =>
    isTranscriptMessageVisible(message, verbose)
  );
}
