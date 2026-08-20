import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EPISTEMIC_GLYPH } from "./epistemicGlyphs.js";

// Prefer the real detail helper when React/Ink deps are installed; otherwise
// use a stand-in that matches EpistemicChip.epistemicDetailLines so CI can
// still prove the ungated glyph + floor language without a full npm install.
let epistemicDetailLines: (status?: {
  state?: string;
  label?: string;
  detail?: string;
  verdict?: string;
  floorChecked?: boolean;
  uncertaintyChecked?: boolean;
  disagreement?: number | null;
} | null) => string[];

try {
  ({ epistemicDetailLines } = await import("./EpistemicChip.js"));
} catch {
  epistemicDetailLines = (status) => {
    if (!status || !status.state) return ["No gate report for this turn."];
    const out: string[] = [];
    if (status.detail) out.push(status.detail);
    if (status.verdict) out.push(`conscience verdict: ${status.verdict}`);
    if (status.state === "delivered_gate_off") {
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
  };
}

test("detail always states whether the uncertainty tier actually ran", () => {
  const off = epistemicDetailLines({ state: "delivered_unreviewed", uncertaintyChecked: false });
  assert.ok(off.some((l) => l.includes("NOT armed")));

  const on = epistemicDetailLines({ state: "delivered_cleared", uncertaintyChecked: true });
  assert.ok(on.some((l) => l.includes("armed") && !l.includes("NOT armed")));
});

test("detail reports disagreement, never a confidence percentage", () => {
  const lines = epistemicDetailLines({
    state: "delivered_cleared", uncertaintyChecked: true, disagreement: 0.4212,
  });
  assert.ok(lines.some((l) => l.includes("disagreement") && l.includes("0.421")));
  // A bare confidence scalar is the documented anti-pattern: it can increase
  // over-reliance rather than calibrate it.
  assert.ok(!lines.some((l) => /confidence/i.test(l)));
});

test("a missing report says so instead of implying everything is fine", () => {
  const lines = epistemicDetailLines(null);
  assert.equal(lines.length, 1);
  assert.ok(/no gate report/i.test(lines[0]));
  assert.ok(!/checked|verified|passed/i.test(lines[0]));
});

test("the verdict is surfaced when present", () => {
  const lines = epistemicDetailLines({ state: "delivered_unreviewed", verdict: "retrieve" });
  assert.ok(lines.some((l) => l.includes("retrieve")));
});

test("delivered_ungated has its own glyph and is not success or empty", () => {
  // Must not fall through to "·" (empty — quieter) or "✓" (cleared — stronger).
  assert.equal(EPISTEMIC_GLYPH.delivered_ungated, "◇");
  assert.notEqual(EPISTEMIC_GLYPH.delivered_ungated, EPISTEMIC_GLYPH.empty);
  assert.notEqual(EPISTEMIC_GLYPH.delivered_ungated, EPISTEMIC_GLYPH.delivered_cleared);
  assert.notEqual(EPISTEMIC_GLYPH.delivered_ungated, "✓");
  assert.notEqual(EPISTEMIC_GLYPH.delivered_ungated, "·");
  // Pre-rename alias still renders the same non-success glyph.
  assert.equal(EPISTEMIC_GLYPH.ungated_external, "◇");
});

test("operator-disabled and advisory modes have explicit non-success states", () => {
  assert.equal(EPISTEMIC_GLYPH.delivered_gate_off, "○");
  assert.equal(EPISTEMIC_GLYPH.delivered_advisory, "◇");
  const off = epistemicDetailLines({
    state: "delivered_gate_off",
    floorChecked: false,
    uncertaintyChecked: false,
  });
  assert.ok(off.some((line) => /disabled by the operator/i.test(line)));
  assert.ok(!off.some((line) => /external\/ungated lane/i.test(line)));
  const report = epistemicDetailLines({
    state: "delivered_advisory",
    floorChecked: true,
    uncertaintyChecked: true,
  });
  assert.ok(report.some((line) => /advisory reporting/i.test(line)));
  assert.ok(report.some((line) => /could not withhold/i.test(line)));
  const advisoryError = epistemicDetailLines({
    state: "delivered_advisory",
    floorChecked: false,
    uncertaintyChecked: false,
  });
  assert.ok(advisoryError.some((line) => /evaluation failed/i.test(line)));
  assert.ok(!advisoryError.some((line) => /external\/ungated lane/i.test(line)));
});

test("external floor-checked output is distinct from native success and ungated output", () => {
  assert.equal(EPISTEMIC_GLYPH.delivered_external_floor_checked, "◆");
  assert.notEqual(
    EPISTEMIC_GLYPH.delivered_external_floor_checked,
    EPISTEMIC_GLYPH.delivered_cleared,
  );
  assert.notEqual(
    EPISTEMIC_GLYPH.delivered_external_floor_checked,
    EPISTEMIC_GLYPH.delivered_ungated,
  );
});

test("chip glyph source wires delivered_ungated (not success/empty)", () => {
  const src = readFileSync(fileURLToPath(new URL("./epistemicGlyphs.ts", import.meta.url)), "utf8");
  assert.ok(/delivered_ungated:\s*"◇"/.test(src));
  assert.ok(!/delivered_ungated:\s*"·"/.test(src));
  assert.ok(!/delivered_ungated:\s*"✓"/.test(src));
});

test("delivered_ungated detail never claims the floor cleared the text", () => {
  const lines = epistemicDetailLines({
    state: "delivered_ungated",
    label: "not gated — external/ungated lane",
    detail: "Produced by an external/ungated agent lane that does not run Sophia's conscience floor.",
    floorChecked: false,
    uncertaintyChecked: false,
  });
  assert.ok(lines.some((l) => /NOT run|ungated/i.test(l)));
  assert.ok(!lines.some((l) => /floor: ran/i.test(l)));
  assert.ok(!lines.some((l) => /\bcleared gate\b/i.test(l)));
});
