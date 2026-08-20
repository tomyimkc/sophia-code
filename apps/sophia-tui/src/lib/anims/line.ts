/**
 * LINE (1-row) animations: matrix-decode and its companion shimmers.
 *
 * The frontier contract (handoff §3) is the honesty core of this whole
 * package — violate it and the animation lies about the stream:
 *
 *   - committed text NEVER changes glyph. It already arrived; re-scrambling
 *     it would pretend the model is regenerating what it already said.
 *   - only the in-flight token scrambles, locking left-to-right (char i locks
 *     once localFrame >= LOCK_BASE + i), then joins the committed text.
 *   - future tokens are not drawn. There is no "preview" of text the model
 *     has not emitted yet.
 *
 * `renderMatrixDecode` is a pure function of (committed, currentToken,
 * localFrame, tick, width); `advanceFrontier`/`tickFrontier` are the pure
 * state machine a consumer drives from real streamGrowth-surfaced deltas:
 * push each new preview in, get the partition back out.
 */
import type { Cell, Row } from "./types.js";
import {
  MATRIX_GLYPHS,
  glyph,
  glyphFrom,
  LIVE_TOKEN_RGB,
  STABLE_TEXT_RGB,
  clamp01,
  spaceCell,
} from "./cells.js";

/** Frames a token may scramble before being considered fully locked. */
export const LIFE = 9;
/** Frames of full scramble before the first char locks. */
export const LOCK_BASE = 4;

// ---------------------------------------------------------------------------
// Decode styles — one engine, many hacker aesthetics. Every style obeys the
// same frontier contract; only the alphabet, lock ORDER, churn rate, palette
// and optional head cursor differ. Palettes stay phosphor-classic (green /
// cyan / amber / near-white) — terminal heritage, not rainbow slop.
// ---------------------------------------------------------------------------

export interface DecodeStyle {
  readonly id: string;
  readonly label: string;
  readonly glyphs: string;
  /** Re-roll the live glyph every N frames (1 = every frame). */
  readonly churn: number;
  /** Is char i of a len-long token locked at localFrame? */
  lockedAt(i: number, len: number, localFrame: number): boolean;
  /** Colour of a live (unlocked) char — may pulse with tick. */
  liveColor(tick: number, i: number): [number, number, number];
  readonly stableColor: readonly [number, number, number];
  readonly liveBold: boolean;
  /** Override the displayed live char (e.g. solid redaction blocks). */
  liveChar?(tick: number, i: number): string;
  /** Cursor glyph appended after the live token while one is in flight. */
  readonly head?: string;
}

const ltrLock = (i: number, _len: number, localFrame: number) => localFrame >= LOCK_BASE + i;
const rtlLock = (i: number, len: number, localFrame: number) => localFrame >= LOCK_BASE + (len - 1 - i);
const centerOutLock = (i: number, len: number, localFrame: number) =>
  localFrame >= LOCK_BASE + Math.abs(i - (len - 1) / 2);
const snapLock = (_i: number, _len: number, localFrame: number) => localFrame >= LIFE - 2;
const typeOnLock = (i: number, _len: number, localFrame: number) => localFrame >= 1 + Math.floor(i * 1.5);

const MATRIX_STYLE: DecodeStyle = {
  id: "matrix",
  label: "matrix · green decode",
  glyphs: MATRIX_GLYPHS,
  churn: 1,
  lockedAt: ltrLock,
  liveColor: () => [70, 255, 90],
  stableColor: STABLE_TEXT_RGB,
  liveBold: true,
};

const HEX_STYLE: DecodeStyle = {
  id: "hex",
  label: "hex · dump readout",
  glyphs: "0123456789abcdef",
  churn: 2,
  lockedAt: ltrLock,
  liveColor: (tick, i) => [70 + ((tick + i) % 3) * 12, 214, 255],
  stableColor: [142, 172, 190],
  liveBold: true,
};

const BINARY_STYLE: DecodeStyle = {
  id: "binary",
  label: "binary · bit frontier",
  glyphs: "01",
  churn: 1,
  lockedAt: ltrLock,
  liveColor: (tick, i) => {
    const pulse = 0.5 + 0.5 * Math.sin(tick * 0.55 + i * 1.3);
    return [60 + pulse * 80, 200 + pulse * 55, 90 + pulse * 70];
  },
  stableColor: [96, 140, 108],
  liveBold: true,
};

const CYBER_STYLE: DecodeStyle = {
  id: "cyber",
  label: "cyber · center-out lock",
  glyphs: MATRIX_GLYPHS,
  churn: 1,
  lockedAt: centerOutLock,
  liveColor: (tick, i) => [176 + ((tick * 5 + i * 3) % 4) * 14, 240, 255],
  stableColor: [148, 188, 204],
  liveBold: true,
};

const GLITCH_STYLE: DecodeStyle = {
  id: "glitch",
  label: "glitch · full-token snap",
  glyphs: MATRIX_GLYPHS,
  churn: 1,
  lockedAt: snapLock,
  // Mostly matrix green with periodic white "v-sync tear" flashes.
  liveColor: (tick, i) => (i % 3 === 0 && tick % 4 === 0 ? [235, 255, 240] : [70, 255, 90]),
  stableColor: [178, 208, 180],
  liveBold: true,
};

const PHOSPHOR_STYLE: DecodeStyle = {
  id: "phosphor",
  label: "phosphor · amber type-on",
  glyphs: "·:˙",
  churn: 3,
  lockedAt: typeOnLock,
  liveColor: () => [255, 208, 84],
  stableColor: [214, 150, 40],
  liveBold: true,
  head: "▌",
};

const REDACT_STYLE: DecodeStyle = {
  id: "redact",
  label: "redact · declassify reveal",
  glyphs: "█▓▒░",
  churn: 2,
  lockedAt: ltrLock,
  liveColor: () => [96, 116, 136],
  stableColor: [188, 198, 205],
  liveBold: false,
  liveChar: (tick, i) => glyphFrom("█▓▒░", tick + i),
};

const RTL_STYLE: DecodeStyle = {
  id: "rtl",
  label: "rtl · reverse lock",
  glyphs: MATRIX_GLYPHS,
  churn: 1,
  lockedAt: rtlLock,
  liveColor: (tick, i) => [70, 255 - ((tick + i) % 3) * 18, 90],
  stableColor: [168, 198, 170],
  liveBold: true,
};

export const DECODE_STYLES: Record<string, DecodeStyle> = {
  matrix: MATRIX_STYLE,
  hex: HEX_STYLE,
  binary: BINARY_STYLE,
  cyber: CYBER_STYLE,
  glitch: GLITCH_STYLE,
  phosphor: PHOSPHOR_STYLE,
  redact: REDACT_STYLE,
  rtl: RTL_STYLE,
};

export const DECODE_STYLE_IDS = Object.keys(DECODE_STYLES);
/** Production default per Tom (2026-08-14): the binary bit-frontier style. */
export const DEFAULT_DECODE_STYLE = "binary";

/**
 * The generalized frontier renderer: committed cells hold their real
 * characters in the style's stable colour; the current token's char i is a
 * scrambling glyph until style.lockedAt says otherwise, painted with the
 * style's live colour. The row shows the RIGHTMOST `width` cells when the
 * frontier overflows (stream tail). Unknown style ids fall back to matrix.
 */
export function renderDecode(styleId: string, opts: {
  committed: string;
  currentToken: string;
  localFrame: number;
  tick: number;
  width: number;
}): Row {
  const style = DECODE_STYLES[styleId] ?? DECODE_STYLES[DEFAULT_DECODE_STYLE];
  const { committed, currentToken, localFrame, tick, width } = opts;
  const frontier: { ch: string; live: boolean }[] = [];
  for (const ch of committed) frontier.push({ ch, live: false });
  const churn = Math.max(1, style.churn);
  for (let i = 0; i < currentToken.length; i++) {
    const locked = style.lockedAt(i, currentToken.length, localFrame);
    frontier.push({
      ch: locked
        ? currentToken[i]
        : style.liveChar
          ? style.liveChar(tick, i)
          : glyphFrom(style.glyphs, Math.floor(tick / churn) * 3 + i * 17),
      live: !locked,
    });
  }
  // Display list = frontier + optional head cursor; the window shows its
  // rightmost `width` cells, so the head rides the tail like the text does.
  const head = style.head && currentToken.length > 0 ? style.head : null;
  const display: { ch: string; live: boolean }[] = frontier;
  const headIndex = head ? frontier.length : -1;
  if (head) display.push({ ch: head, live: true });
  const start = display.length > width ? display.length - width : 0;
  const row: Row = Array.from({ length: width }, () => spaceCell());
  for (let i = 0; i < width; i++) {
    const src = display[start + i];
    if (!src) break;
    const fi = start + i; // index into the frontier for colour phasing
    if (src.live) {
      const [r, g, b] = style.liveColor(tick, fi === headIndex ? frontier.length : fi);
      row[i] = { ch: src.ch, r, g, b, bold: style.liveBold };
    } else if (src.ch !== " ") {
      row[i] = { ch: src.ch, r: style.stableColor[0], g: style.stableColor[1], b: style.stableColor[2] };
    }
  }
  return row;
}

/**
 * The reference matrix-decode render (handoff §10): the default style,
 * exact — 26 ASCII English letters plus 0/1, LTR lock at LOCK_BASE + i,
 * bright matrix green live glyphs, stable stream green behind them.
 */
export function renderMatrixDecode(opts: {
  committed: string;
  currentToken: string;
  localFrame: number;
  tick: number;
  width: number;
}): Row {
  return renderDecode(MATRIX_STYLE.id, opts);
}

/**
 * Demo-only simulator tokenizer (handoff §3.2): split a sentence into 2–3
 * char pieces + whitespace so a fake stream advances one "token" at a time.
 * Production never uses this — real deltas come from the bridge.
 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part) || part.length <= 3) {
      out.push(part);
      continue;
    }
    for (let i = 0; i < part.length; ) {
      const n = Math.min(i === 0 ? 3 : 2, part.length - i);
      out.push(part.slice(i, i + n));
      i += n;
    }
  }
  return out;
}

/**
 * The frontier partition of a live stream preview.
 *
 * `committed` is stable, already-arrived text; `current` is the newest delta
 * still eligible to scramble. Both together are a suffix-partition of the
 * most recent preview: committed + current === lastPreview, always.
 */
export interface FrontierState {
  committed: string;
  current: string;
  /** Frames since `current` started (0…LIFE-1); drives char locking. */
  localFrame: number;
  /** The preview this state was computed from (for delta alignment). */
  lastPreview: string;
}

export const EMPTY_FRONTIER: FrontierState = {
  committed: "",
  current: "",
  localFrame: 0,
  lastPreview: "",
};

/** Longest suffix of `a` that is a prefix of `b` (capped for cheapness). */
function longestSuffixPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  for (let n = max; n > 0; n--) {
    if (a.endsWith(b.slice(0, n))) return n;
  }
  return 0;
}

/** Count UTF-16 code units for the last n grapheme-ish chunks. Simple and
 * adequate for the ≤ ~240-char preview windows this runs on. */
function tailUnits(s: string, keepUnits: number): { tail: string; head: string } {
  if (s.length <= keepUnits) return { tail: s, head: "" };
  return { tail: s.slice(s.length - keepUnits), head: s.slice(0, s.length - keepUnits) };
}

/**
 * Push the newest stream preview in; get the frontier partition back out.
 *
 * A preview is whatever coalesced text the consumer surfaces (the TUI's
 * 240-char sliding `streamPreview`, or the demo's growing buffer). Alignment:
 * if the preview extends the previous one, the extension is the delta;
 * otherwise the window slid, and the longest suffix∧prefix overlap yields the
 * delta — so a sliding window still produces honest committed/current
 * partitions without ever inventing text that is not in the preview.
 *
 * A new delta folds the previous current into committed (it is no longer the
 * newest token) and resets localFrame. `current` is capped at
 * `maxCurrentUnits` code units; overflow joins committed.
 */
export function advanceFrontier(
  state: FrontierState,
  preview: string,
  maxCurrentUnits = 12,
): FrontierState {
  if (preview === state.lastPreview) return state;

  let delta: string;
  let stable: string;
  if (state.lastPreview && preview.startsWith(state.lastPreview)) {
    stable = state.lastPreview;
    delta = preview.slice(stable.length);
  } else if (!state.lastPreview) {
    stable = "";
    delta = preview;
  } else {
    const overlap = longestSuffixPrefix(state.lastPreview, preview);
    stable = preview.slice(0, overlap);
    delta = preview.slice(overlap);
  }

  if (!delta) {
    // Window slid with no growth (or text was replaced outright). Keep the
    // partition honest relative to what is actually on screen: if the current
    // token is still the preview's suffix tail it stays live, else the stream
    // replaced text under us and nothing may pretend to still be decoding.
    const endsWithCurrent = state.current !== "" && preview.endsWith(state.current);
    const current = endsWithCurrent ? state.current : "";
    return {
      committed: preview.slice(0, preview.length - current.length),
      current,
      localFrame: endsWithCurrent ? state.localFrame : 0,
      lastPreview: preview,
    };
  }

  // Invariant: committed + current === preview (a suffix partition of the
  // newest preview). The delta REPLACES the live token — the previous token
  // folds into committed the moment a newer one arrives, so no already-seen
  // character ever goes back to scrambling (handoff §3.3). Cap current at the
  // last `maxCurrentUnits` units; overflow is by definition committed now.
  const { tail } = tailUnits(delta, maxCurrentUnits);
  return {
    committed: preview.slice(0, preview.length - tail.length),
    current: tail,
    localFrame: 0,
    lastPreview: preview,
  };
}

/**
 * One animation tick on the frontier: ages `current` and, once it has had its
 * full LIFE of frames (fully locked), folds it into committed. Pure — callers
 * drive it from their own interval so reduced-motion simply never calls it.
 */
export function tickFrontier(state: FrontierState): FrontierState {
  if (state.current === "") {
    return state.localFrame === 0 ? state : { ...state, localFrame: 0 };
  }
  const localFrame = state.localFrame + 1;
  if (localFrame >= LIFE) {
    return {
      committed: state.committed + state.current,
      current: "",
      localFrame: 0,
      lastPreview: state.lastPreview,
    };
  }
  return { ...state, localFrame };
}

// ---------------------------------------------------------------------------
// Companion 1-line patterns (handoff §3.4) — optional, kept available.
// ---------------------------------------------------------------------------

/** Phase label with a traveling sine highlight blended toward cyan. */
export function shimmerLabel(label: string, frame: number, width: number): Row {
  const shown = label.slice(0, width);
  const row: Row = [];
  for (let i = 0; i < shown.length; i++) {
    const wave = Math.sin((i - frame * 0.32) * 0.72);
    const t = wave > 0.22 ? clamp01((wave - 0.22) / 0.78) : 0;
    const r = Math.round(168 - t * 100);
    const g = Math.round(198 + t * 20);
    const b = Math.round(170 + t * 85);
    row.push({ ch: shown[i], r, g, b, bold: t > 0.5 });
  }
  for (let i = shown.length; i < width; i++) row.push(spaceCell());
  return row;
}

/** LTR glyph arrival with a bright head and decaying tail (no decode). */
export function matrixStream(text: string, frame: number, width: number): Row {
  const shown = text.slice(0, width);
  const head = (frame % (width + 8)) - 3;
  const row: Row = [];
  for (let i = 0; i < width; i++) {
    if (i >= shown.length) {
      row.push(spaceCell());
      continue;
    }
    const d = head - i;
    if (d < 0) {
      row.push({ ch: shown[i], r: 120, g: 170, b: 130 });
    } else if (d === 0) {
      row.push({ ch: glyph(frame * 7 + i * 3), r: 70, g: 255, b: 90, bold: true });
    } else {
      row.push({ ch: glyph(frame * 3 + i * 17), r: 46, g: 140, b: 70 });
    }
  }
  return row;
}

/** Type-on label with a block cursor `▌`. */
export function shimmerCursor(label: string, frame: number, width: number): Row {
  const revealed = Math.min(label.length, Math.floor(frame / 2) % (label.length + 6));
  const shown = label.slice(0, revealed);
  const row: Row = [];
  for (const ch of shown) row.push({ ch, r: 168, g: 198, b: 170 });
  if (revealed < width) row.push({ ch: "▌", r: 70, g: 255, b: 90, bold: true });
  while (row.length < width) row.push(spaceCell());
  return row.slice(0, width);
}
