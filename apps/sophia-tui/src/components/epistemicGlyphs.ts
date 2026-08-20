/**
 * Glyphs for EpistemicChip. Kept dependency-free so unit tests can assert the
 * mapping without pulling React/Ink (and so colour is never the only carrier).
 *
 * delivered_ungated must not look like success (✓) or empty (·) — those are
 * quieter / stronger claims in the wrong direction for an ungated lane.
 *
 * ungated_external is kept as a glyph alias for any receipt still carrying the
 * pre-rename state string; the canonical wire state is delivered_ungated.
 */
export const EPISTEMIC_GLYPH: Record<string, string> = {
  delivered_cleared: "✓",
  delivered_unreviewed: "~",
  delivered_advisory: "◇",
  delivered_gate_off: "○",
  delivered_ungated: "◇",
  delivered_external_floor_checked: "◆",
  // Alias for receipts written before the delivered_ungated rename.
  ungated_external: "◇",
  blocked: "⊘",
  withheld_error: "!",
  empty: "·",
};
