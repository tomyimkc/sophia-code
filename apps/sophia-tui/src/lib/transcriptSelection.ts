import type { ChatMessage } from "./types.js";

export interface TranscriptSelection {
  anchorId: string;
  headId: string;
}

export interface TranscriptHitRegion {
  id: string;
  screenRow: number;
  screenEndRow: number;
}

export interface DragAutoScroll {
  /** Positive scrolls toward older content; negative toward newer content. */
  delta: number;
}

function messageIndex(messages: readonly ChatMessage[], id: string): number {
  return messages.findIndex((message) => message.id === id);
}

export function selectedMessageIds(
  messages: readonly ChatMessage[],
  selection: TranscriptSelection | null,
): Set<string> {
  if (!selection) return new Set();
  const anchor = messageIndex(messages, selection.anchorId);
  const head = messageIndex(messages, selection.headId);
  if (anchor < 0 || head < 0) return new Set();
  const start = Math.min(anchor, head);
  const end = Math.max(anchor, head);
  return new Set(messages.slice(start, end + 1).map((message) => message.id));
}

/**
 * Clipboard payload for an in-app drag selection.
 *
 * Message chrome (role bullets, collapse labels, tool borders) is deliberately
 * excluded, matching Grok's selection model: copy the conversation content,
 * not the TUI decoration used to display it.
 */
export function selectedTranscriptText(
  messages: readonly ChatMessage[],
  selection: TranscriptSelection | null,
): string {
  const ids = selectedMessageIds(messages, selection);
  if (ids.size === 0) return "";
  return messages
    .filter((message) => ids.has(message.id))
    .map((message) => message.text)
    .filter(Boolean)
    .join("\n\n");
}

export function hitRegionAtRow<T extends TranscriptHitRegion>(
  hits: readonly T[],
  row: number,
): T | null {
  return hits.find((hit) => row >= hit.screenRow && row <= hit.screenEndRow) ?? null;
}

export function nearestHitRegion<T extends TranscriptHitRegion>(
  hits: readonly T[],
  row: number,
): T | null {
  if (hits.length === 0) return null;
  const exact = hitRegionAtRow(hits, row);
  if (exact) return exact;
  let best = hits[0];
  let bestDistance = Math.min(
    Math.abs(row - best.screenRow),
    Math.abs(row - best.screenEndRow),
  );
  for (const hit of hits.slice(1)) {
    const distance = Math.min(
      Math.abs(row - hit.screenRow),
      Math.abs(row - hit.screenEndRow),
    );
    if (distance < bestDistance) {
      best = hit;
      bestDistance = distance;
    }
  }
  return best;
}

function autoScrollSpeed(distance: number): number {
  if (distance <= 1) return 1;
  if (distance <= 3) return 2;
  if (distance <= 6) return 3;
  return 5;
}

/**
 * Grok-style drag autoscroll activation near or beyond the transcript edges.
 *
 * The terminal may keep reporting rows in the prompt/chrome below the pane, so
 * rows outside the pane accelerate. Inside the pane, a two-row edge zone keeps
 * selection moving even when the pointer cannot leave the terminal window.
 */
export function dragAutoScrollAtRow(
  row: number,
  paneTopRow: number,
  paneHeight: number,
  edgeRows = 2,
): DragAutoScroll | null {
  if (paneHeight <= 0) return null;
  const bottom = paneTopRow + paneHeight - 1;
  const safeEdge = Math.max(1, Math.min(edgeRows, Math.ceil(paneHeight / 2)));
  const topThreshold = paneTopRow + safeEdge - 1;
  const bottomThreshold = bottom - safeEdge + 1;

  if (row <= topThreshold) {
    return { delta: autoScrollSpeed(topThreshold - row + 1) };
  }
  if (row >= bottomThreshold) {
    return { delta: -autoScrollSpeed(row - bottomThreshold + 1) };
  }
  return null;
}
