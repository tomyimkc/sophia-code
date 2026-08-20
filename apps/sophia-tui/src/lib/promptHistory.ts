/**
 * Prompt input history — arrow-up/down recall of previously submitted prompts,
 * matching the convention users expect from shells and REPLs.
 *
 * Two layers:
 *   - an in-memory ring (capped, dedupes consecutive duplicates)
 *   - optional append-only disk persistence at SOPHIA_STATE_DIR/prompt_history.jsonl
 *     so history survives across TUI restarts
 *
 * The navigation model:
 *   - cursor === entries.length  → "live draft" position (what the user is typing now)
 *   - up()   → move to the previous entry (older); stops at the oldest (no wrap)
 *   - down() → move to the next entry (newer); past the newest → restores the live draft
 *   - push() → append a submitted line and reset cursor to the live position
 *   - typing while navigated into history → the caller keeps passing the box's
 *     actual current text into the next up()/down() call, so an edit to a
 *     recalled entry is detected (it no longer matches the entry at the
 *     cursor) and becomes the new draft — it is NOT silently discarded on
 *     the next navigation step, and it is what down()-past-newest restores.
 *     (The history entries themselves stay immutable; only the draft moves.)
 *
 * Pure, dependency-free (node:fs only when persistence is enabled).
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROMPT_HISTORY_CAP_DEFAULT = 500;
const FILENAME = "prompt_history.jsonl";

export function defaultPromptHistoryFile(): string {
  const state =
    process.env.SOPHIA_STATE_DIR ||
    process.env.SOPHIA_USER_STATE ||
    path.join(os.homedir(), ".sophia");
  return path.join(state, FILENAME);
}

/**
 * In-memory ring buffer + cursor. Entries are stored newest-last so index 0 is
 * the oldest and `entries.length` is the live-draft sentinel position.
 *
 * Disk persistence (when `file` is set) is append-only on push(); the file is
 * read once at construction to seed the in-memory ring. A truncated/corrupt
 * file is ignored (best-effort) — prompt history is a convenience, not state.
 */
export class PromptHistory {
  readonly entries: string[] = [];
  /** Cursor into entries. === entries.length means "live draft" (not in history). */
  cursor = 0;
  /** The draft the user had before navigating into history; restored on down()-past-end. */
  draft = "";
  private readonly file: string | undefined;
  private readonly cap: number;

  constructor(opts: { cap?: number; file?: string; loadFromDisk?: boolean } = {}) {
    this.cap = Math.max(1, opts.cap ?? PROMPT_HISTORY_CAP_DEFAULT);
    this.file = opts.file ?? (opts.loadFromDisk ? defaultPromptHistoryFile() : undefined);
    if (this.file) this.loadFromDisk();
    // cursor defaults to the live-draft position (=== entries.length). When
    // entries were loaded from disk, move it past them so the first up() recall
    // lands on the newest loaded entry, not the oldest.
    this.cursor = this.entries.length;
  }

  private loadFromDisk(): void {
    if (!this.file) return;
    try {
      if (!existsSync(this.file)) return;
      const raw = readFileSync(this.file, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        // Each line is JSON: {"t": <text>} — tolerant parse, skip corrupt lines.
        try {
          const obj = JSON.parse(t) as { t?: unknown };
          if (typeof obj.t === "string" && obj.t.trim()) this.appendMemory(obj.t);
        } catch {
          // Legacy/raw line format: accept the trimmed text itself.
          this.appendMemory(t);
        }
      }
    } catch {
      /* best-effort: a missing/unreadable file just starts empty */
    }
  }

  private appendMemory(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Dedupe consecutive duplicates (shell convention: `ls` run twice → one entry).
    if (this.entries[this.entries.length - 1] === trimmed) return;
    this.entries.push(trimmed);
    while (this.entries.length > this.cap) this.entries.shift();
  }

  /** Record a submitted prompt and reset to the live-draft position. */
  push(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.appendMemory(trimmed);
    if (this.file) {
      try {
        if (this.file && !existsSync(path.dirname(this.file))) {
          mkdirSync(path.dirname(this.file), { recursive: true });
        }
        appendFileSync(this.file, JSON.stringify({ t: trimmed }) + "\n", "utf8");
      } catch {
        /* persistence is best-effort; never block a submit on disk IO */
      }
    }
    this.cursor = this.entries.length;
    this.draft = "";
  }

  /** Whether the cursor is at the live-draft position (not navigated into history). */
  isLive(): boolean {
    return this.cursor >= this.entries.length;
  }

  /**
   * Move to the previous (older) entry. Saves the current draft when leaving
   * the live position. Returns the entry to display, or null if already at the
   * oldest (no wrap-around — matches standard shell behavior).
   *
   * `currentDraft` is read on EVERY call, not just the first: if it no longer
   * matches the entry currently at the cursor, the caller's box was edited in
   * place, and that edit replaces the saved draft. Without this, editing a
   * recalled entry and pressing up() again used to silently drop the edit —
   * the very next navigation step overwrote it with an untouched history
   * entry, and it was gone forever (never reachable via down() either).
   */
  up(currentDraft: string): string | null {
    if (this.entries.length === 0) return null;
    if (this.cursor >= this.entries.length) {
      // Leaving live position: capture the in-progress draft for down()-restore.
      this.draft = currentDraft;
      this.cursor = this.entries.length - 1;
      return this.entries[this.cursor];
    }
    if (currentDraft !== this.entries[this.cursor]) {
      // The entry shown at the cursor was edited in place — preserve the edit.
      this.draft = currentDraft;
    }
    if (this.cursor === 0) return null; // already at oldest — no wrap
    this.cursor -= 1;
    return this.entries[this.cursor];
  }

  /**
   * Move to the next (newer) entry. Returns the entry to display, or the saved
   * draft when returning to the live position (null if no draft was saved).
   *
   * `currentDraft` is optional and mirrors up()'s edit-preservation: pass the
   * box's actual current text so an edit made to the entry shown at the
   * cursor survives a down() the same way it survives an up() (see up()).
   * Omitting it keeps the old behavior (no edit-detection) for a caller that
   * does not track it.
   */
  down(currentDraft?: string): string | null {
    if (this.cursor >= this.entries.length) return null; // already live
    if (currentDraft !== undefined && currentDraft !== this.entries[this.cursor]) {
      this.draft = currentDraft;
    }
    this.cursor += 1;
    if (this.cursor >= this.entries.length) {
      this.cursor = this.entries.length;
      return this.draft; // restore in-progress draft (may be "")
    }
    return this.entries[this.cursor];
  }

  /** Reset to the live-draft position without clearing entries (e.g. on Esc). */
  resetToLive(): void {
    this.cursor = this.entries.length;
    this.draft = "";
  }
}
