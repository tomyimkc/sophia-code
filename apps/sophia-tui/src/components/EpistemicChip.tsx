import React from "react";
import { Text } from "ink";
import type { Theme } from "../lib/theme.js";
import { EPISTEMIC_GLYPH } from "./epistemicGlyphs.js";

export { EPISTEMIC_GLYPH } from "./epistemicGlyphs.js";

/** What the gate actually checked, as reported by agent/epistemic_status.py. */
export interface EpistemicStatus {
  state?: string;
  label?: string;
  detail?: string;
  severity?: string;
  verdict?: string;
  floorChecked?: boolean;
  uncertaintyChecked?: boolean;
  disagreement?: number | null;
}

// Glyph FIRST, colour second — see epistemicGlyphs.ts (WCAG 1.4.1).

/**
 * Display by exception.
 *
 * The alarm-fatigue literature is unambiguous: when every event is rendered at
 * alert intensity, people learn to ignore all of them. A gate that fires on
 * ordinary turns must therefore stay quiet on ordinary turns. Only genuinely
 * withheld output earns the loud treatment; the routine "checked" state is dim
 * and easy to skip past.
 *
 * Note what this deliberately does NOT show: a confidence percentage. A bare
 * confidence scalar can increase over-reliance rather than calibrate it, so the
 * detail view surfaces the parliament's DISAGREEMENT instead — a rarer and more
 * actionable signal that Sophia already computes.
 */
export function EpistemicChip({
  status,
  theme,
  showHint,
}: {
  status?: EpistemicStatus | null;
  theme: Theme;
  showHint?: boolean;
}): React.ReactElement | null {
  if (!status || !status.state) return null;
  const glyph = EPISTEMIC_GLYPH[status.state] || "·";
  const label = status.label || status.state;
  const severity = status.severity || "notice";

  // "not gated" is the honest label for output that cleared the prohibition
  // floor but was never checked for factual grounding. It is a caution, not an
  // error: rendering a routine state in error-red is the documented way to
  // train users to disable the whole thing. Ungated external lanes use the
  // same caution band — louder than empty (notice), never a success colour.
  const color =
    severity === "alert" ? theme.error : severity === "caution" ? theme.warn : theme.dim;

  return (
    <>
      <Text color={theme.dim}> · </Text>
      <Text color={color}>
        {glyph} {label}
      </Text>
      {showHint && severity !== "notice" ? (
        <Text color={theme.dim}> (^g)</Text>
      ) : null}
    </>
  );
}

/** One honest sentence about what was and was not checked. */
export function epistemicDetailLines(status?: EpistemicStatus | null): string[] {
  if (!status || !status.state) return ["No gate report for this turn."];
  const out: string[] = [];
  if (status.detail) out.push(status.detail);
  if (status.verdict) out.push(`conscience verdict: ${status.verdict}`);
  if (
    status.state === "delivered_gate_off"
  ) {
    out.push("conscience/provenance gate: disabled by the operator for this run");
  } else if (
    status.state === "delivered_advisory" &&
    status.floorChecked === false
  ) {
    out.push("conscience/provenance advisory: evaluation failed; no enforcement was applied");
  } else if (
    status.state === "delivered_ungated" ||
    status.state === "ungated_external" ||
    status.floorChecked === false
  ) {
    out.push("conscience floor: NOT run — external/ungated lane");
  } else {
    out.push("conscience floor: ran (hard-prohibition tier)");
  }
  if (status.state === "delivered_external_floor_checked") {
    out.push("execution authority: external user process — Sophia did not approve prior tool actions");
  }
  if (status.state === "delivered_advisory") {
    out.push("strict uncertainty tier: evaluated for advisory reporting; it could not withhold");
  } else {
    out.push(
      status.uncertaintyChecked
        ? "strict uncertainty tier: armed — factual grounding was checked"
        : "strict uncertainty tier: NOT armed — factual grounding was not checked",
    );
  }
  if (typeof status.disagreement === "number") {
    out.push(`moral parliament disagreement: ${status.disagreement.toFixed(3)}`);
  }
  return out;
}
