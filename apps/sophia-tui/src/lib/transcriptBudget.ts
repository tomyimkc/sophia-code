import type { ChatMessage } from "./types.js";

/**
 * App.tsx holds `messages` in a single `useState<ChatMessage[]>` and only ever
 * appends (`setMessages(prev => [...prev, msg])`) — there is no cap or
 * eviction, so a long session grows the array (and the DOM/height-cache
 * entries it drives) without bound. This module is the pure decision function
 * for trimming that array: given the current messages and a budget, decide
 * what to drop and what must survive.
 *
 * Deliberately pure / framework-free so it can be unit tested without Ink or
 * React, and so App.tsx (owned by another agent) only needs to call one
 * function and splice the result back into state.
 */

export interface TranscriptBudget {
  /** Hard cap on retained message *count*. Each message is a React element
   *  plus a chatLayout.ts WeakMap height-cache entry, so count alone bounds
   *  the per-message overhead even for short messages. */
  maxMessages: number;
  /** Optional cap on total retained `text`+`meta` characters. A handful of
   *  huge pasted tool outputs can dwarf message-count memory while never
   *  tripping `maxMessages`, so this catches what a count-only cap misses.
   *  Omit to budget on count alone. */
  maxChars?: number;
  /** When no `user` message exists to anchor "the active exchange" (e.g. a
   *  session that is only system banners so far), protect this many of the
   *  most recent messages instead. Default 8. */
  minTailWhenNoUser?: number;
}

export interface TranscriptBudgetResult {
  /** Same message *references* as the input for every survivor — eviction
   *  never rewrites a kept message, so chatLayout.ts's WeakMap height cache
   *  (keyed on message identity) stays valid for everything that remains.
   *  When nothing is evicted this is `===` the input array. */
  messages: ChatMessage[];
  /** How many messages this call dropped (0 if the transcript was already
   *  within budget). */
  evictedCount: number;
  /** ids of the dropped messages, oldest first. */
  evictedIds: string[];
  /** True when the protected messages (active exchange + caller-pinned ids)
   *  alone exceed the budget, so eviction stopped short of the target on
   *  purpose — correctness (never silently drop something in view or
   *  in-flight) wins over hitting the exact budget. */
  overBudget: boolean;
}

const DEFAULT_MIN_TAIL_WHEN_NO_USER = 8;

/**
 * Messages that must never be evicted, regardless of budget:
 *  - the "active exchange": the most recent `user` message and everything
 *    after it (the in-flight/just-finished turn — evicting it mid-run would
 *    corrupt the run the user is currently watching).
 *  - `protectedIds`: caller-supplied ids the module has no way to derive on
 *    its own — e.g. the currently visible scroll window or a focused message
 *    id. App.tsx already tracks scrollOffset/focusedMsgId; pass those ids in
 *    rather than duplicating viewport math here.
 */
function computeProtectedIds(
  messages: readonly ChatMessage[],
  protectedIds: Iterable<string> | undefined,
  minTailWhenNoUser: number,
): Set<string> {
  const protectedSet = new Set<string>(protectedIds ?? []);
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  const tailStart =
    lastUserIndex >= 0 ? lastUserIndex : Math.max(0, messages.length - Math.max(0, minTailWhenNoUser));
  for (let i = tailStart; i < messages.length; i++) {
    protectedSet.add(messages[i].id);
  }
  return protectedSet;
}

function messageChars(msg: ChatMessage): number {
  return (msg.text?.length ?? 0) + (msg.meta?.length ?? 0);
}

/**
 * Decide the retained transcript for a budget. Pure: does not mutate
 * `messages` or any message object; safe to call on every render/append.
 */
export function applyTranscriptBudget(
  messages: readonly ChatMessage[],
  budget: TranscriptBudget,
  protectedIds?: Iterable<string>,
): TranscriptBudgetResult {
  const maxMessages = Math.max(0, Math.floor(budget.maxMessages));
  const maxChars = budget.maxChars !== undefined ? Math.max(0, Math.floor(budget.maxChars)) : undefined;
  const minTailWhenNoUser = budget.minTailWhenNoUser ?? DEFAULT_MIN_TAIL_WHEN_NO_USER;

  let totalChars = 0;
  for (const m of messages) totalChars += messageChars(m);

  const withinBudget = messages.length <= maxMessages && (maxChars === undefined || totalChars <= maxChars);
  if (withinBudget) {
    return { messages: messages as ChatMessage[], evictedCount: 0, evictedIds: [], overBudget: false };
  }

  const protectedSet = computeProtectedIds(messages, protectedIds, minTailWhenNoUser);

  let remainingCount = messages.length;
  let remainingChars = totalChars;
  const evictedIds: string[] = [];
  const evictedSet = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const overCount = remainingCount > maxMessages;
    const overChars = maxChars !== undefined && remainingChars > maxChars;
    if (!overCount && !overChars) break;
    const msg = messages[i];
    if (protectedSet.has(msg.id)) continue; // never evict the active exchange / pinned ids
    evictedSet.add(msg.id);
    evictedIds.push(msg.id);
    remainingCount -= 1;
    remainingChars -= messageChars(msg);
  }

  const kept = evictedSet.size === 0 ? (messages as ChatMessage[]) : messages.filter((m) => !evictedSet.has(m.id));
  const overBudget = remainingCount > maxMessages || (maxChars !== undefined && remainingChars > maxChars);

  return { messages: kept, evictedCount: evictedIds.length, evictedIds, overBudget };
}

/** Human-readable notice for a trim, meant to be surfaced as a `system`
 *  ChatMessage so history loss is visible rather than silent. */
export function formatEvictionNotice(evictedCount: number, totalEvictedSoFar?: number): string {
  const noun = evictedCount === 1 ? "message" : "messages";
  const base = `transcript trimmed · ${evictedCount} older ${noun} dropped to stay within the memory budget`;
  return totalEvictedSoFar !== undefined && totalEvictedSoFar > evictedCount
    ? `${base} (${totalEvictedSoFar} dropped total this session)`
    : base;
}

/**
 * Ready-to-`push` banner for a trim. Shaped to match App.tsx's
 * `push(msg: Omit<ChatMessage, "id"> & { id?: string })` so wiring this in is
 * a one-line call; the caller still assigns the id (App.tsx already has
 * `uid()` for that) so this module stays free of id-generation side effects.
 */
export function createEvictionBanner(
  evictedCount: number,
  totalEvictedSoFar?: number,
): Omit<ChatMessage, "id"> {
  return { role: "system", text: formatEvictionNotice(evictedCount, totalEvictedSoFar) };
}
