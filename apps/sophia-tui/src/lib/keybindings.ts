import type { TerminalPlatform } from "./terminalCapabilities.js";

export type KeymapMode = "default" | "emacs" | "vim";
export type VimInputMode = "insert" | "normal";

export type KeybindingAction =
  | "submit"
  | "insert-newline"
  | "complete"
  | "cancel"
  | "move-left"
  | "move-right"
  | "move-up"
  | "move-down"
  | "move-line-start"
  | "move-line-end"
  | "move-document-start"
  | "move-document-end"
  | "delete-backward"
  | "delete-forward"
  | "delete-word-backward"
  | "kill-line-start"
  | "kill-line-end"
  | "history-previous"
  | "history-next"
  | "reverse-search"
  | "vim-normal"
  | "vim-insert"
  | "vim-append"
  | "vim-open-below";

export interface KeyLike {
  return?: boolean;
  escape?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  tab?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface KeymapConfig {
  mode?: KeymapMode;
  /**
   * Portable chord names (`ctrl+r`, `alt+enter`, `shift+tab`). `null` removes
   * a built-in binding. "cmd" and "option" normalize to "meta"/"alt".
   */
  overrides?: Readonly<Record<string, KeybindingAction | null>>;
}

export interface ResolvedKeybinding {
  chord: string;
  action: KeybindingAction;
}

const DEFAULT_BINDINGS: Readonly<Record<string, KeybindingAction>> = {
  enter: "submit",
  "shift+enter": "insert-newline",
  "alt+enter": "insert-newline",
  tab: "complete",
  escape: "cancel",
  left: "move-left",
  right: "move-right",
  up: "history-previous",
  down: "history-next",
  home: "move-line-start",
  end: "move-line-end",
  "ctrl+home": "move-document-start",
  "ctrl+end": "move-document-end",
  backspace: "delete-backward",
  delete: "delete-forward",
  "ctrl+r": "reverse-search",
  "ctrl+w": "delete-word-backward",
  "ctrl+k": "kill-line-end",
};

const EMACS_BINDINGS: Readonly<Record<string, KeybindingAction>> = {
  ...DEFAULT_BINDINGS,
  "ctrl+a": "move-line-start",
  "ctrl+e": "move-line-end",
  "ctrl+b": "move-left",
  "ctrl+f": "move-right",
  "ctrl+p": "history-previous",
  "ctrl+n": "history-next",
  "ctrl+h": "delete-backward",
  "ctrl+d": "delete-forward",
  "ctrl+u": "kill-line-start",
  "ctrl+k": "kill-line-end",
};

const VIM_INSERT_BINDINGS: Readonly<Record<string, KeybindingAction>> = {
  ...DEFAULT_BINDINGS,
  escape: "vim-normal",
  "ctrl+[": "vim-normal",
};

const VIM_NORMAL_BINDINGS: Readonly<Record<string, KeybindingAction>> = {
  escape: "vim-normal",
  h: "move-left",
  l: "move-right",
  k: "move-up",
  j: "move-down",
  "0": "move-line-start",
  "$": "move-line-end",
  "^": "move-line-start",
  x: "delete-forward",
  i: "vim-insert",
  a: "vim-append",
  o: "vim-open-below",
  enter: "submit",
  "ctrl+r": "reverse-search",
};

function baseKey(
  input: string,
  key: KeyLike,
  platform: TerminalPlatform = "other",
): string {
  if (key.return) return "enter";
  if (key.escape) return "escape";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  if (key.home) return "home";
  if (key.end) return "end";
  if (key.backspace) return "backspace";
  if (key.delete) {
    // Ink 6 maps BOTH of these to `key.delete` with empty `input`:
    //   - ASCII DEL 0x7f (Backspace on Linux/GNOME/xterm; the key labelled
    //     Delete on macOS)
    //   - CSI 3~ (PC forward-Delete)
    // See ink/build/parse-keypress.js: `\x7f` → name "delete", with an Ink
    // TODO to merge that back into backspace. useInput then blanks `input`
    // because "delete" is in nonAlphanumericKeys — so the raw byte is gone
    // and we cannot distinguish the two sequences here.
    //
    // Prefer delete-backward on every platform: that is the key users press
    // constantly. Mapping 0x7f to delete-forward on Linux made Backspace erase
    // the character to the RIGHT of the caret (or do nothing at EOL), which
    // reads as a broken keyboard. True forward-delete remains available via
    // Ctrl+D (emacs mode) / vim `x`.
    void platform;
    return "backspace";
  }
  if (key.tab) return "tab";
  if (input === "\r" || input === "\n") return "enter";
  if (!input) return "";
  if (input.length === 1) {
    const code = input.charCodeAt(0);
    if (code >= 1 && code <= 26) return String.fromCharCode(96 + code);
  }
  return input.toLowerCase();
}

export function canonicalKeyChord(chord: string): string {
  const raw = chord.trim().toLowerCase().replace(/\s+/g, "");
  if (!raw) return "";
  const parts = raw.split("+").filter(Boolean);
  const key = parts.pop() ?? "";
  const modifiers = new Set(
    parts.map((part) => {
      if (part === "control" || part === "ctl") return "ctrl";
      if (part === "option") return "alt";
      if (part === "cmd" || part === "command") return "meta";
      return part;
    }),
  );
  const ordered = ["ctrl", "meta", "alt", "shift"].filter((modifier) => modifiers.has(modifier));
  return [...ordered, key === "return" ? "enter" : key].filter(Boolean).join("+");
}

export function keyChord(
  input: string,
  key: KeyLike,
  platform: TerminalPlatform = "other",
): string {
  const base = baseKey(input, key, platform);
  if (!base) return "";
  const modifiers: string[] = [];
  if (key.ctrl) modifiers.push("ctrl");
  if (key.meta) modifiers.push("alt");
  if (key.shift) modifiers.push("shift");
  return canonicalKeyChord([...modifiers, base].join("+"));
}

function bindingTable(mode: KeymapMode, vimMode: VimInputMode): Readonly<Record<string, KeybindingAction>> {
  if (mode === "emacs") return EMACS_BINDINGS;
  if (mode === "vim") return vimMode === "normal" ? VIM_NORMAL_BINDINGS : VIM_INSERT_BINDINGS;
  return DEFAULT_BINDINGS;
}

export function resolveKeybinding(
  input: string,
  key: KeyLike,
  config: KeymapConfig | KeymapMode = "default",
  vimMode: VimInputMode = "insert",
  platform: TerminalPlatform = "other",
): ResolvedKeybinding | null {
  const normalizedConfig = typeof config === "string" ? { mode: config } : config;
  const mode = normalizedConfig.mode ?? "default";
  const chord = keyChord(input, key, platform);
  if (!chord) return null;

  const overrides = normalizedConfig.overrides ?? {};
  for (const [configuredChord, action] of Object.entries(overrides)) {
    if (canonicalKeyChord(configuredChord) !== chord) continue;
    return action ? { chord, action } : null;
  }

  const action = bindingTable(mode, vimMode)[chord];
  return action ? { chord, action } : null;
}

export function resolveKeyAction(
  input: string,
  key: KeyLike,
  config: KeymapConfig | KeymapMode = "default",
  vimMode: VimInputMode = "insert",
  platform: TerminalPlatform = "other",
): KeybindingAction | null {
  return resolveKeybinding(input, key, config, vimMode, platform)?.action ?? null;
}

export interface ReverseSearchState {
  active: boolean;
  query: string;
  originalDraft: string;
  matches: string[];
  matchIndex: number;
}

function uniqueNewestFirst(history: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const value = history[index];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function reverseSearchMatches(history: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  return uniqueNewestFirst(history).filter((entry) => entry.toLowerCase().includes(needle));
}

export function beginReverseSearch(
  history: readonly string[],
  originalDraft = "",
  initialQuery = "",
): ReverseSearchState {
  const matches = reverseSearchMatches(history, initialQuery);
  return {
    active: true,
    query: initialQuery,
    originalDraft,
    matches,
    matchIndex: 0,
  };
}

export function updateReverseSearch(
  state: ReverseSearchState,
  history: readonly string[],
  query: string,
): ReverseSearchState {
  const matches = reverseSearchMatches(history, query);
  return { ...state, active: true, query, matches, matchIndex: 0 };
}

/** Ctrl+R again walks older matches and stops at the oldest (no surprise wrap). */
export function stepReverseSearch(state: ReverseSearchState): ReverseSearchState {
  if (!state.active || state.matches.length === 0) return state;
  return {
    ...state,
    matchIndex: Math.min(state.matches.length - 1, state.matchIndex + 1),
  };
}

export function currentReverseSearchMatch(state: ReverseSearchState): string | null {
  return state.matches[state.matchIndex] ?? null;
}

export function acceptReverseSearch(state: ReverseSearchState): string {
  return currentReverseSearchMatch(state) ?? state.originalDraft;
}

export function cancelReverseSearch(state: ReverseSearchState): string {
  return state.originalDraft;
}
