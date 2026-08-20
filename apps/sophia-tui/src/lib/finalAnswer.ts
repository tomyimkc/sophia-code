/**
 * Which transcript row should a terminal `result` write to?
 *
 * Two events describe the same answer and both derive their dedupe key from
 * `ev.id || ev.runId`:
 *
 *   - the kernel's `final`, whose text is a capped preview (agent_loop.py
 *     emits `text[:8000]`), delivered mid-run through the event stream;
 *   - the bridge's `result`, carrying the authoritative full `finalText`.
 *
 * Neither carries an `id`, so both keys collapse to the same runId. Treating
 * the result as a duplicate meant the full answer was DROPPED and the user read
 * a reply cut off mid-sentence with no marker — while the session file on disk
 * held the whole thing, so resuming showed what the live pane had withheld.
 *
 * Pushing unconditionally is the opposite bug: the answer renders twice.
 *
 * So the rule is: a preview row is UPGRADED in place; anything else is a fresh
 * push unless the key was genuinely already delivered.
 */
export type FinalRowAction =
  | { action: "error" }
  | { action: "upgrade"; id: string }
  | { action: "push" }
  | { action: "skip" };

/**
 * Shared live/resume display ceiling.
 *
 * The resume path previously used 2,500 characters while a live answer used
 * 8,000, so reopening the exact same 3,374-character response silently hid its
 * tail even though it had been complete during the run. Keep both projections
 * on one contract; longer outputs retain an explicit on-disk marker.
 */
export const TRANSCRIPT_ROW_CHAR_CAP = 8000;

/**
 * A terminal result arriving a handful of rows below the viewport is not
 * useful "preserve my scrollback" behaviour: it makes a completed run look
 * wedged even though the answer is already present. Keep intentional deep
 * scrollback stable, but reveal a result when the operator was still following
 * the run or only drifted a few rows from the bottom.
 */
/** Rows of intentional scrollback above the bottom before we stop auto-revealing. */
export const TERMINAL_RESULT_NEAR_BOTTOM_ROWS = 12;

export function shouldRevealTerminalResult(input: {
  followLatest: boolean;
  scrollOffset: number;
  nearBottomRows?: number;
}): boolean {
  if (input.followLatest) return true;
  const offset = Number.isFinite(input.scrollOffset)
    ? Math.max(0, Math.floor(input.scrollOffset))
    : 0;
  const threshold = Number.isFinite(input.nearBottomRows)
    ? Math.max(0, Math.floor(input.nearBottomRows as number))
    : TERMINAL_RESULT_NEAR_BOTTOM_ROWS;
  return offset <= threshold;
}

export function displayFinalText(
  text: string,
  options: { exactOutput: boolean; cap: number },
): string {
  if (options.exactOutput || text.length <= options.cap) return text;
  return `${text.slice(0, options.cap)}\n\n…[truncated for display: ${text.length} chars total · full text saved to the session transcript]`;
}

export function resolveFinalRow(input: {
  /** The resolved answer text for this result (may be empty/whitespace). */
  text: string;
  /** Row id created by an earlier truncated `final` for this key, if any. */
  previewRowId?: string;
  /** Whether this key was already delivered as a completed row. */
  alreadyDelivered: boolean;
  /**
   * Length of the existing assistant row for this run, when known. Used to
   * recover when a truncated preview was marked "delivered" but the upgrade
   * row id was lost (key mismatch): if the authoritative text is longer, push
   * so the operator still sees the full answer.
   */
  existingTextLength?: number;
}): FinalRowAction {
  if (!input.text.trim()) return { action: "error" };
  if (input.previewRowId) return { action: "upgrade", id: input.previewRowId };
  if (input.alreadyDelivered) {
    const existing = Number(input.existingTextLength);
    if (Number.isFinite(existing) && input.text.length > existing) {
      // Truncated `final` preview was recorded as delivered; the bridge `result`
      // carries a longer authoritative body. Push rather than silently skip.
      return { action: "push" };
    }
    return { action: "skip" };
  }
  return { action: "push" };
}

/**
 * Pick the best final body for the bottom of the chat.
 *
 * DS4 often emits a long complete report mid-loop (prose + tools), then a short
 * meta recap as the kernel `final` after a stray tool failure. Prefer the
 * longest assistant body from the active exchange when it is clearly fuller
 * than the terminal `result` text, so the operator sees the real report at the
 * bottom — not a "nothing further to execute" epilogue buried after tool cards.
 */
export function preferBestFinalText(
  resultText: string,
  activeExchangeAssistantTexts: readonly string[],
): string {
  const result = String(resultText || "").trim();
  let best = result;
  for (const candidate of activeExchangeAssistantTexts) {
    const body = String(candidate || "").trim();
    if (body.length > best.length) best = body;
  }
  return best || result;
}

/**
 * Move (or append) the terminal answer so it is the last chat row.
 *
 * Upgrade-in-place left the answer mid-transcript above later tool cards; the
 * operator then saw "only tools" at the bottom. Always pin the final answer as
 * the lowest message.
 */
export function pinMessageToEnd<T extends { id: string }>(
  messages: readonly T[],
  row: T,
  removeIds: readonly string[] = [],
): T[] {
  const drop = new Set<string>([row.id, ...removeIds].filter(Boolean));
  const rest = messages.filter((m) => !drop.has(m.id));
  return [...rest, row];
}

/** Ids of assistant rows after the last operator user turn (active exchange). */
export function activeExchangeAssistantTexts(
  messages: readonly { role?: string; text?: string }[],
): string[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const out: string[] = [];
  for (let i = lastUser + 1; i < messages.length; i += 1) {
    if (messages[i].role === "assistant" && messages[i].text) {
      out.push(String(messages[i].text));
    }
  }
  return out;
}
