/**
 * Pure pattern selection: which animation job (if any) a phase deserves.
 *
 * The routing encodes the product contracts (handoff §0/§5):
 *   - reduced motion → nothing animates (the consumer's timer must die too,
 *     not just the glyph — see lib/accessibility.ts).
 *   - streaming/thinking → LINE only. Never a multi-row field while tokens
 *     paint: the stream owns the row budget.
 *   - transient waits keep the compact braille label only. A sparse dot-chain
 *     appears once a wait is genuinely noticeable, and a continuous field is
 *     reserved for a sustained wait.
 *   - awaiting permission never earns a LOAD surface: the system is blocked
 *     on operator input, not making measurable progress.
 *   - everything else falls back to the existing braille path.
 *
 * `elapsedSec` is injected (never read from a clock here) so this stays pure
 * and unit-testable.
 */
import type { LoadPhase } from "../progress.js";
import type { AccessibilityPrefs } from "../accessibility.js";

export type AnimJob = "none" | "line" | "load";

export interface AnimSelection {
  job: AnimJob;
  id: string;
}

/** A tool call this short does not deserve a full-frame loader yet. */
export const TOOL_LOAD_THRESHOLD_SEC = 3;
/** Starting work gets a shorter grace period, but still avoids startup flash. */
export const STARTING_LOAD_THRESHOLD_SEC = 2;
/** Rich fields are reserved for waits that are visibly sustained. */
export const LOAD_FIELD_ESCALATION_SEC = 10;

export function selectAnim(
  phase: LoadPhase,
  elapsedSec: number | null,
  prefs: AccessibilityPrefs,
): AnimSelection {
  if (prefs.reducedMotion) return { job: "none", id: "static" };
  if (phase === "streaming" || phase === "thinking") return { job: "line", id: "matrix-decode" };
  const elapsed = Number.isFinite(elapsedSec)
    ? Math.max(0, elapsedSec as number)
    : 0;
  if (phase === "tool") {
    if (elapsed < TOOL_LOAD_THRESHOLD_SEC) return { job: "none", id: "braille-fallback" };
    if (elapsed < LOAD_FIELD_ESCALATION_SEC) return { job: "load", id: "dot-chain-sine" };
    return { job: "load", id: "sine-sheet" };
  }
  if (phase === "starting") {
    if (elapsed < STARTING_LOAD_THRESHOLD_SEC) return { job: "none", id: "braille-fallback" };
    if (elapsed < LOAD_FIELD_ESCALATION_SEC) return { job: "load", id: "dot-chain-loop" };
    return { job: "load", id: "circular-ripple" };
  }
  if (phase === "awaiting_permission") return { job: "none", id: "braille-fallback" };
  if (phase === "planning" || phase === "finalizing") return { job: "line", id: "shimmer-label" };
  return { job: "none", id: "braille-fallback" };
}
