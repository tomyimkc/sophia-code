export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

const START_MARKERS = [BRACKETED_PASTE_START, "\x9b200~", "[200~"] as const;
const END_MARKERS = [BRACKETED_PASTE_END, "\x9b201~", "[201~"] as const;

export interface ComposerTextEvent {
  kind: "text";
  text: string;
}

export interface ComposerPasteEvent {
  kind: "paste";
  text: string;
  bracketed: true;
  reviewRequired: true;
  incomplete: boolean;
}

export type ComposerDecodedInputEvent = ComposerTextEvent | ComposerPasteEvent;

export interface PasteReview {
  id: string;
  text: string;
  lineCount: number;
  graphemeCount: number;
  bracketed: boolean;
  reason: string;
}

function earliestMarker(
  input: string,
  markers: readonly string[],
): { index: number; marker: string } | null {
  let result: { index: number; marker: string } | null = null;
  for (const marker of markers) {
    const index = input.indexOf(marker);
    if (index < 0) continue;
    if (
      result === null
      || index < result.index
      || (index === result.index && marker.length > result.marker.length)
    ) {
      result = { index, marker };
    }
  }
  return result;
}

function partialMarkerSuffix(input: string, markers: readonly string[]): number {
  const max = Math.min(
    input.length,
    Math.max(...markers.map((marker) => marker.length - 1)),
  );
  for (let length = max; length > 0; length -= 1) {
    const suffix = input.slice(-length);
    if (markers.some((marker) => marker.startsWith(suffix))) return length;
  }
  return 0;
}

/**
 * Streaming bracketed-paste decoder.
 *
 * Terminal chunks can split the start/end marker at any byte boundary. This
 * decoder buffers only a possible marker suffix and never lets a split escape
 * sequence leak into prompt text. It accepts the canonical ESC form, the C1
 * CSI form, and Ink's observed prefix-stripped `[200~`/`[201~` form.
 */
export class BracketedPasteDecoder {
  private buffer = "";
  private pasted = "";
  private inPaste = false;

  reset(): void {
    this.buffer = "";
    this.pasted = "";
    this.inPaste = false;
  }

  isPasting(): boolean {
    return this.inPaste;
  }

  feed(chunk: string): ComposerDecodedInputEvent[] {
    this.buffer += chunk;
    const events: ComposerDecodedInputEvent[] = [];

    while (this.buffer) {
      const markers = this.inPaste ? END_MARKERS : START_MARKERS;
      const found = earliestMarker(this.buffer, markers);
      if (found) {
        const before = this.buffer.slice(0, found.index);
        this.buffer = this.buffer.slice(found.index + found.marker.length);
        if (this.inPaste) {
          this.pasted += before;
          events.push({
            kind: "paste",
            text: this.pasted,
            bracketed: true,
            reviewRequired: true,
            incomplete: false,
          });
          this.pasted = "";
          this.inPaste = false;
        } else {
          if (before) events.push({ kind: "text", text: before });
          this.inPaste = true;
        }
        continue;
      }

      const keep = partialMarkerSuffix(this.buffer, markers);
      const ready = this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      if (this.inPaste) this.pasted += ready;
      else if (ready) events.push({ kind: "text", text: ready });
      break;
    }

    return events;
  }

  /**
   * Drain buffered data at shutdown. An unterminated paste is still surfaced
   * as review-required content rather than silently discarded or submitted.
   */
  flush(): ComposerDecodedInputEvent[] {
    const events: ComposerDecodedInputEvent[] = [];
    if (this.inPaste) {
      const text = this.pasted + this.buffer;
      if (text) {
        events.push({
          kind: "paste",
          text,
          bracketed: true,
          reviewRequired: true,
          incomplete: true,
        });
      }
    } else if (this.buffer) {
      events.push({ kind: "text", text: this.buffer });
    }
    this.reset();
    return events;
  }
}

function stablePasteId(text: string, bracketed: boolean): string {
  // FNV-1a over UTF-16 code units is deterministic on every Node platform and
  // avoids putting the pasted text itself in a loggable identifier.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bracketed ? "bp" : "mp"}-${text.length}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function createPasteReview(text: string, bracketed = true): PasteReview {
  const normalized = text.replace(/\r\n?/g, "\n");
  return {
    id: stablePasteId(normalized, bracketed),
    text: normalized,
    lineCount: normalized.split("\n").length,
    graphemeCount: graphemes(normalized).length,
    bracketed,
    reason: bracketed
      ? "Bracketed paste must be reviewed before submission."
      : "Multiline paste must be reviewed before submission.",
  };
}

export function inputRequiresPasteReview(text: string, bracketed = false): boolean {
  return bracketed || /[\r\n]/.test(text);
}

type PasteModeStream = {
  isTTY?: boolean;
  write: (value: string) => unknown;
};

const enabledStreams = new WeakMap<object, number>();

/** Reference-counted so nested mounts cannot disable another input's mode. */
export function enableBracketedPaste(stream: PasteModeStream = process.stdout): boolean {
  if (!stream.isTTY) return false;
  const key = stream as object;
  const users = enabledStreams.get(key) ?? 0;
  if (users === 0) {
    try {
      stream.write(ENABLE_BRACKETED_PASTE);
    } catch {
      return false;
    }
  }
  enabledStreams.set(key, users + 1);
  return true;
}

export function disableBracketedPaste(stream: PasteModeStream = process.stdout): boolean {
  const key = stream as object;
  const users = enabledStreams.get(key) ?? 0;
  if (users <= 0) return false;
  if (users > 1) {
    enabledStreams.set(key, users - 1);
    return true;
  }
  enabledStreams.delete(key);
  try {
    stream.write(DISABLE_BRACKETED_PASTE);
    return true;
  } catch {
    return false;
  }
}
import { graphemes } from "./textWidth.js";
