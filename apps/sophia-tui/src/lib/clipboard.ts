/**
 * Clipboard copy for `/copy` and in-app transcript selection.
 *
 * Strategy (first success wins):
 *  1. OSC 52 terminal clipboard (`ESC ] 52 ; c ; <base64> BEL`) — works over
 *     SSH when the client supports it (iTerm2, Ghostty, WezTerm, Kitty, …).
 *  2. Host CLI tools: `wl-copy` (Wayland), `xclip` / `xsel` (X11), `pbcopy`
 *     (macOS). Used when OSC 52 is unsupported or write fails — common on
 *     Linux desktop terminals that drop OSC 52 silently.
 *
 * Decision helpers are pure / DI-friendly so unit tests never need a real TTY.
 */
import { spawnSync } from "node:child_process";
import type { ChatMessage } from "./types.js";
import { selectedTranscriptText, type TranscriptSelection } from "./transcriptSelection.js";

const ESC = "\x1b";
const OSC = `${ESC}]`;
const BEL = "\x07";

/**
 * Build the OSC 52 sequence that copies `text` to the system clipboard.
 * `c` is the clipboard parameter (system clipboard, vs `p` for primary on X11).
 */
export function buildOsc52(text: string): string {
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  return `${OSC}52;c;${b64}${BEL}`;
}

/**
 * Terminals known to ignore OSC 52. Detection is best-effort from env vars
 * because OSC 52 has no query/ack mechanism — a terminal that doesn't support
 * it simply drops the bytes silently, so we can't "try and see."
 */
const OSC52_BLOCKED_TERM_PROGRAMS = new Set([
  "Apple_Terminal", // macOS Terminal.app
  "vscode",         // VS Code integrated terminal
]);

/** Whether the active terminal advertises (to our knowledge) OSC 52 support. */
export function osc52Supported(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (!stream.isTTY) return false;
  const tp = process.env.TERM_PROGRAM;
  if (tp && OSC52_BLOCKED_TERM_PROGRAMS.has(tp)) return false;
  // Explicit operator override: SOPHIA_CLIPBOARD=0 forces host tools only;
  // SOPHIA_CLIPBOARD=1 assumes OSC 52 is OK even when TERM_PROGRAM is unknown.
  const flag = String(process.env.SOPHIA_CLIPBOARD || "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "host") {
    return false;
  }
  if (flag === "1" || flag === "true" || flag === "on" || flag === "osc52") {
    return true;
  }
  return true;
}

/** Human-readable terminal name for the unsupported-terminal message. */
function terminalName(): string {
  const tp = process.env.TERM_PROGRAM;
  if (tp === "Apple_Terminal") return "Terminal.app";
  if (tp === "vscode") return "the VS Code integrated terminal";
  return "this terminal";
}

export type CopySelection =
  | { ok: true; text: string; label: string }
  | { ok: false; reason: string };

export type CopyTargetContext = {
  /** Active drag/keyboard transcript selection, if any. */
  selection?: TranscriptSelection | null;
  /** Message currently focused (click highlight). */
  focusedId?: string | null;
};

/**
 * Pick which message `/copy <args>` should copy. Pure decision — no I/O.
 *
 *  - "" / "reply" / "last" → the most recent assistant message
 *  - "prompt"              → the most recent user message
 *  - "selection" / "sel"   → active transcript multi-message selection
 *  - "focused" / "this"    → focused message (click highlight)
 *  - "N" (1-based integer) → the Nth message in the visible transcript
 */
export function selectCopyTarget(
  messages: ChatMessage[],
  args: string,
  ctx: CopyTargetContext = {},
): CopySelection {
  const arg = args.trim().toLowerCase();

  if (arg === "selection" || arg === "sel" || arg === "selected") {
    const text = selectedTranscriptText(messages, ctx.selection ?? null);
    if (!text) {
      return {
        ok: false,
        reason: "no transcript selection — drag-select messages, or click one and /copy focused",
      };
    }
    return { ok: true, text, label: "selection" };
  }
  if (arg === "focused" || arg === "this" || arg === "focus") {
    const id = String(ctx.focusedId || "").trim();
    if (!id) return { ok: false, reason: "no focused message — click a chat row first" };
    const m = messages.find((row) => row.id === id);
    if (!m) return { ok: false, reason: "focused message is no longer in the transcript" };
    if (!String(m.text || "").trim()) {
      return { ok: false, reason: "focused message has no copyable text" };
    }
    return { ok: true, text: m.text, label: `focused ${m.role}` };
  }

  if (arg === "" || arg === "reply" || arg === "last") {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last) return { ok: false, reason: "no assistant reply to copy yet" };
    return { ok: true, text: last.text, label: "last reply" };
  }
  if (arg === "prompt") {
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (!last) return { ok: false, reason: "no user prompt to copy yet" };
    return { ok: true, text: last.text, label: "last prompt" };
  }
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    if (n < 1 || n > messages.length) {
      return { ok: false, reason: `no message #${n} (have 1..${messages.length})` };
    }
    const m = messages[n - 1];
    return { ok: true, text: m.text, label: `message #${n} (${m.role})` };
  }
  return {
    ok: false,
    reason: "usage: /copy [reply|prompt|last|selection|focused|N]",
  };
}

export type CopyResult = { ok: boolean; message: string; method?: "osc52" | "host" };

export type HostClipboardRunner = (text: string) => boolean;

/** Built-in host clipboard tools (Linux / macOS). Pure for injection in tests. */
export function defaultHostClipboardRunner(text: string): boolean {
  const candidates: Array<{ cmd: string; args: string[] }> = [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
    { cmd: "pbcopy", args: [] },
  ];
  for (const { cmd, args } of candidates) {
    try {
      const res = spawnSync(cmd, args, {
        input: text,
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (res.error) continue;
      if (res.status === 0) return true;
    } catch {
      // try next tool
    }
  }
  return false;
}

/**
 * Write `text` to the system clipboard via OSC 52 and/or host tools.
 * Returns a result the caller surfaces to the user — never throws.
 */
export function copyToClipboard(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
  hostRunner: HostClipboardRunner = defaultHostClipboardRunner,
): CopyResult {
  const body = String(text ?? "");
  if (!body) {
    return { ok: false, message: "nothing to copy (empty text)" };
  }

  let oscTried = false;
  let oscOk = false;
  if (osc52Supported(stream)) {
    oscTried = true;
    try {
      stream.write(buildOsc52(body));
      oscOk = true;
    } catch {
      oscOk = false;
    }
  }

  // Prefer host tools when OSC is blocked (Terminal.app / VS Code) or failed.
  // Also run host tools after OSC success on Linux — dual-write is cheap and
  // covers terminals that accept OSC bytes but never apply them to the OS clipboard.
  const preferHost =
    !oscOk ||
    process.platform === "linux" ||
    String(process.env.SOPHIA_CLIPBOARD || "").toLowerCase() === "both";

  if (preferHost || !oscOk) {
    try {
      if (hostRunner(body)) {
        return {
          ok: true,
          method: "host",
          message: `copied ${body.length} char${body.length === 1 ? "" : "s"}`,
        };
      }
    } catch {
      // fall through
    }
  }

  if (oscOk) {
    return {
      ok: true,
      method: "osc52",
      message: `copied ${body.length} char${body.length === 1 ? "" : "s"}`,
    };
  }

  if (oscTried) {
    return {
      ok: false,
      message: `clipboard write failed — install wl-copy/xclip or use a terminal with OSC 52 (${terminalName()})`,
    };
  }
  return {
    ok: false,
    message: `OSC 52 not supported in ${terminalName()} — install wl-copy/xclip, or select the text manually`,
  };
}

/**
 * Select one full message (select-all for that row) and copy its text.
 * Used by double-click and keyboard "copy focused".
 */
export function selectAllMessageAndCopy(
  messages: ChatMessage[],
  messageId: string,
  stream: NodeJS.WriteStream = process.stdout,
  hostRunner: HostClipboardRunner = defaultHostClipboardRunner,
): { selection: TranscriptSelection | null; result: CopyResult; label: string } {
  const m = messages.find((row) => row.id === messageId);
  if (!m) {
    return {
      selection: null,
      result: { ok: false, message: "message not found" },
      label: "message",
    };
  }
  const selection: TranscriptSelection = { anchorId: m.id, headId: m.id };
  const text = String(m.text || "");
  if (!text.trim()) {
    return {
      selection,
      result: { ok: false, message: "message has no copyable text" },
      label: m.role,
    };
  }
  return {
    selection,
    result: copyToClipboard(text, stream, hostRunner),
    label: m.role,
  };
}
