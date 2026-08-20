/**
 * Coalesces streamed assistant-reply chunks so a UI can grow a message in
 * place while it streams, without a state update per token.
 *
 * The kernel's delivery floor (agent/stream_gate.py) already buffers raw
 * tokens and releases them in phrase-sized chunks rather than one at a time,
 * so by the time text reaches here it typically arrives in bursts of a few
 * dozen characters at a stretch, not single characters. This module adds the
 * second, UI-facing throttle on top of that: even phrase-sized chunks can
 * arrive faster than a repaint is worth — a fast cloud model can emit
 * hundreds of them a second — and a human cannot perceive more than roughly
 * 30 updates a second regardless. Surfacing sooner than that just spends a
 * `setState`/re-render on a delta nobody sees.
 *
 * Two independent thresholds gate when the internally accumulated text
 * becomes the text a caller should actually render (`surfaced`): a minimum
 * elapsed time and a minimum character count since the last surface,
 * whichever is met first. That "whichever first" is deliberate: a slow local
 * model emitting a few chunks a second clears the time threshold almost every
 * chunk (so growth still looks continuous), while a fast model's tight burst
 * of small deltas clears the char threshold first and gets coalesced into
 * fewer, larger updates instead of one render per delta.
 *
 * Independently of surfacing cadence, the raw accumulator itself is capped. A
 * runaway or misbehaving backend can emit megabytes into a single turn, and a
 * JS string retained for the lifetime of a long session would otherwise grow
 * the transcript's memory footprint without limit. Once the total exceeds
 * `maxRetainedChars`, the middle is elided and replaced with a marker,
 * keeping a fixed head (what the reply opened with, useful for orientation)
 * and a fixed-size tail (the most recent text, which is what the eye is
 * actually tracking while it streams).
 *
 * Pure and clock-injected throughout: no timers, no I/O, no React/Ink. A
 * caller drives this by calling `pushStreamGrowth` for every chunk and
 * `flushStreamGrowth` at end-of-turn, threading the returned `state` through
 * calls and rendering `text` only when `changed` is true. Start a fresh turn
 * with a new `createStreamGrowth()` rather than trying to "reset" a state in
 * place — the type has no mutation to reset.
 */
import { graphemes } from "./textWidth.js";

export interface StreamGrowthOptions {
  /** Minimum time between surfaced updates, in the injected clock's units
   *  (ms). Cleared independently of `minChars` — whichever threshold a push
   *  crosses first triggers a surface. */
  minIntervalMs?: number;
  /** Minimum characters appended since the last surface before surfacing
   *  again, regardless of elapsed time. */
  minChars?: number;
  /** Hard cap, in characters, on the retained accumulator. Once the raw
   *  total appended exceeds this, the middle is elided. */
  maxRetainedChars?: number;
  /** Grapheme count kept from the start of the reply when eliding. */
  headChars?: number;
  /** Grapheme count kept from the end (most recent text) when eliding. */
  tailChars?: number;
}

interface ResolvedStreamGrowthOptions {
  minIntervalMs: number;
  minChars: number;
  maxRetainedChars: number;
  headChars: number;
  tailChars: number;
}

/** ~30 updates/sec — the fastest cadence a human reliably reads as smooth
 *  growth rather than individually-noticed flicker. */
const DEFAULT_MIN_INTERVAL_MS = 33;
/** A little under one stream_gate.py release (~120 chars / 30 tokens), so a
 *  single kernel-released phrase almost always clears this on its own. */
const DEFAULT_MIN_CHARS = 80;
const DEFAULT_MAX_RETAINED_CHARS = 20_000;
const DEFAULT_HEAD_CHARS = 8_000;
const DEFAULT_TAIL_CHARS = 8_000;

export const STREAM_GROWTH_DEFAULTS: Readonly<Required<StreamGrowthOptions>> = {
  minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
  minChars: DEFAULT_MIN_CHARS,
  maxRetainedChars: DEFAULT_MAX_RETAINED_CHARS,
  headChars: DEFAULT_HEAD_CHARS,
  tailChars: DEFAULT_TAIL_CHARS,
};

function resolveOptions(options: StreamGrowthOptions): ResolvedStreamGrowthOptions {
  const headChars = Math.max(0, Math.floor(options.headChars ?? DEFAULT_HEAD_CHARS));
  const tailChars = Math.max(0, Math.floor(options.tailChars ?? DEFAULT_TAIL_CHARS));
  const requestedCap = Math.max(0, Math.floor(options.maxRetainedChars ?? DEFAULT_MAX_RETAINED_CHARS));
  // Head and tail windows must both fit inside the cap or elision has nothing
  // left to cut — widen the cap rather than silently overlapping the two.
  const maxRetainedChars = Math.max(requestedCap, headChars + tailChars);
  return {
    minIntervalMs: Math.max(0, Math.floor(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)),
    minChars: Math.max(0, Math.floor(options.minChars ?? DEFAULT_MIN_CHARS)),
    maxRetainedChars,
    headChars,
    tailChars,
  };
}

export interface StreamGrowthState {
  /** Full text accumulated so far, already subject to the head+tail elision
   *  cap. This is the ground truth; `surfaced` lags behind it between
   *  coalescing windows. */
  readonly accumulated: string;
  /** Total raw characters ever appended, before elision. Used to size the
   *  elision notice accurately even after repeated elision passes have
   *  discarded the characters it is counting. */
  readonly rawChars: number;
  /** The text most recently handed back to a caller via `text`. Equal to
   *  `accumulated` immediately after a surface. */
  readonly surfaced: string;
  /** Clock time of the last surface, or null before the first one. */
  readonly surfacedAt: number | null;
  /** Characters appended to `accumulated` since `surfaced` was last updated
   *  — the running counter the char threshold compares against. */
  readonly pendingChars: number;
}

export interface StreamGrowthUpdate {
  /** State to thread into the next `pushStreamGrowth`/`flushStreamGrowth` call. */
  state: StreamGrowthState;
  /** The coalesced text as of this call. Identical to the previous call's
   *  `text` whenever `changed` is false — safe to skip rendering entirely. */
  text: string;
  /** True when `text` differs from what the previous push/flush call returned. */
  changed: boolean;
}

/** A fresh buffer for a new turn. There is no in-place reset: starting a new
 *  turn means starting a new state, so a stale reference can never leak
 *  partial text from a previous answer into the next one. */
export function createStreamGrowth(): StreamGrowthState {
  return { accumulated: "", rawChars: 0, surfaced: "", surfacedAt: null, pendingChars: 0 };
}

/** Cut `candidate` down to `maxRetainedChars` (in raw terms) by eliding its
 *  middle, keeping a head+tail window sized in GRAPHEMES rather than raw
 *  string indices so the cut can never land inside a surrogate pair or a
 *  combining/ZWJ sequence and paint a corrupted character at the seam. */
function elideIfNeeded(candidate: string, rawChars: number, o: ResolvedStreamGrowthOptions): string {
  if (rawChars <= o.maxRetainedChars) return candidate;
  const units = graphemes(candidate);
  if (units.length <= o.headChars + o.tailChars) return candidate;
  const head = units.slice(0, o.headChars).join("");
  const tail = o.tailChars > 0 ? units.slice(units.length - o.tailChars).join("") : "";
  const omitted = Math.max(0, rawChars - o.headChars - o.tailChars);
  return `${head}\n\n… ${omitted.toLocaleString()} characters elided from the live preview — the full reply is still generating …\n\n${tail}`;
}

/**
 * Feed one streamed chunk in. Returns the coalesced text and whether it
 * changed from the last surfaced value, so the caller can skip its own
 * update entirely when nothing did.
 *
 * An empty/falsy chunk is a no-op: it returns the input state unchanged with
 * `changed: false` rather than resetting the pending-char counter or nudging
 * `surfacedAt`, so a caller that occasionally forwards an empty delta cannot
 * accidentally reset the coalescing window.
 */
export function pushStreamGrowth(
  state: StreamGrowthState,
  chunk: string,
  now: number,
  options: StreamGrowthOptions = {},
): StreamGrowthUpdate {
  if (!chunk) return { state, text: state.surfaced, changed: false };
  const o = resolveOptions(options);
  const rawChars = state.rawChars + chunk.length;
  const accumulated = elideIfNeeded(state.accumulated + chunk, rawChars, o);
  const pendingChars = state.pendingChars + chunk.length;
  const elapsed = state.surfacedAt === null ? Infinity : now - state.surfacedAt;
  const crossedThreshold = pendingChars >= o.minChars || elapsed >= o.minIntervalMs;

  if (!crossedThreshold) {
    const next: StreamGrowthState = { ...state, accumulated, rawChars, pendingChars };
    return { state: next, text: state.surfaced, changed: false };
  }

  const next: StreamGrowthState = {
    accumulated,
    rawChars,
    surfaced: accumulated,
    surfacedAt: now,
    pendingChars: 0,
  };
  return { state: next, text: accumulated, changed: accumulated !== state.surfaced };
}

/**
 * Release whatever has accumulated but not yet surfaced, bypassing both
 * thresholds. Call this at a turn boundary (the `final`/`result` event) so
 * the last coalescing window's worth of text is never silently dropped.
 */
export function flushStreamGrowth(state: StreamGrowthState, now: number): StreamGrowthUpdate {
  if (state.pendingChars === 0) return { state, text: state.surfaced, changed: false };
  const next: StreamGrowthState = { ...state, surfaced: state.accumulated, surfacedAt: now, pendingChars: 0 };
  return { state: next, text: state.accumulated, changed: true };
}
