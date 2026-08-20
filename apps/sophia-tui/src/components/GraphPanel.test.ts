import test from "node:test";
import assert from "node:assert/strict";
import { resolveAccessibility } from "../lib/accessibility.js";
import { confidenceBand, confidenceLabel, connectionLine, nodeMeta, type ProjectionEdge, type ProjectionNode } from "../lib/graphProjection.js";
import { edgeLine, graphBorderStyle, honestyFooter, nodeGlyph, nodeLine } from "./GraphPanel.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

function node(over: Partial<ProjectionNode> = {}): ProjectionNode {
  return {
    id: "prosoche", pageType: "concept", domain: "philosophy", tradition: "stoic",
    authorConfidence: "attested", confidenceRank: 3, effectiveConfidenceRank: 3,
    confidenceLaundered: false, ...over,
  };
}

function edge(over: Partial<ProjectionEdge> = {}): ProjectionEdge {
  return {
    src: "discourses", dst: "prosoche", kind: "mentions", resolved: true,
    effectiveRank: 2, conflict: false, evidence: ["discourses 1.1"], ...over,
  };
}

test("the graph panel drops its rounded border in screen-reader mode", () => {
  const reader = resolveAccessibility(["--ax-screen-reader"], NO_ENV);
  assert.equal(graphBorderStyle(reader), undefined);
});

test("the graph panel keeps its border outside screen-reader mode", () => {
  const normal = resolveAccessibility([], NO_ENV);
  assert.equal(graphBorderStyle(normal), "round");
  const motionOnly = resolveAccessibility(["--reduced-motion"], NO_ENV);
  assert.equal(graphBorderStyle(motionOnly), "round");
});

test("a node row renders its id alongside the ordinal glyph band", () => {
  const line = nodeLine(node({ effectiveConfidenceRank: 3 }));
  assert.ok(line.includes("prosoche"), "row must show the node id");
  assert.ok(line.includes(confidenceBand(3)), "row must show the ordinal glyph band");
  assert.ok(line.includes("[concept]"), "row must show the pageType");
  assert.ok(line.includes("stoic"), "row must show the tradition");
  // The band is a glyph, never a number.
  assert.equal(nodeGlyph(node({ effectiveConfidenceRank: 3 })), "▓");
});

test("a downgraded node is flagged with a non-colour glyph marker", () => {
  const line = nodeLine(node({ confidenceLaundered: true }));
  assert.ok(line.includes("⚠"), "downgrade must be carried by a glyph, not colour alone");
  assert.ok(line.includes("downgraded"), "plain-language marker, not the jargon 'laundered'");
  assert.ok(!nodeLine(node({ confidenceLaundered: false })).includes("⚠"));
});

test("a conflict edge is marked with a non-colour glyph", () => {
  const line = edgeLine(edge({ conflict: true }));
  assert.ok(line.includes("✗"), "conflict must be carried by a glyph, not colour alone");
  assert.ok(line.includes("discourses") && line.includes("prosoche"));
  assert.ok(line.includes("mentions"));
  // A calm resolved edge carries no conflict marker.
  assert.ok(!edgeLine(edge({ conflict: false })).includes("✗"));
});

test("an unresolved edge is drawn with a dashed arrow, not a solid one", () => {
  const line = edgeLine(edge({ resolved: false }));
  assert.ok(line.includes("┄"), "unresolved must be carried by a glyph pattern");
  assert.ok(line.includes("(unresolved)"));
});

test("the honesty footer can never be read as a claim of validated knowledge", () => {
  const footer = honestyFooter({
    schema: "sophia.graph_projection.v1", candidateOnly: true, canClaimAGI: false, level3Evidence: false,
    generatedAt: "2026-07-29T00:00:00Z", source: "okf.project_graph",
    scope: { domain: null, root: null, depth: null }, nodes: [], edges: [], ledger: {},
    stats: { nodeCount: 0, edgeCount: 0, resolvedEdgeCount: 0, danglingCount: 0, launderedCount: 0 },
  });
  assert.equal(footer, "candidateOnly · canClaimAGI:false · provenance audit view");
});

test("no panel line emits a numeric confidence probability", () => {
  const lines = [
    nodeLine(node({ effectiveConfidenceRank: 4 })),
    nodeLine(node({ confidenceLaundered: true, effectiveConfidenceRank: 1 })),
    edgeLine(edge({ conflict: true })),
    edgeLine(edge({ resolved: false })),
  ];
  for (const line of lines) {
    assert.ok(!/%/.test(line), `no percentage in: ${JSON.stringify(line)}`);
    assert.ok(!/confidence\s*[:=]?\s*\d/i.test(line), `no numeric confidence in: ${JSON.stringify(line)}`);
  }
});

test("confidenceLabel maps ranks 0-4 to ordinal words, never numbers", () => {
  const labels = [0, 1, 2, 3, 4].map(confidenceLabel);
  assert.deepEqual(labels, ["uncertain", "low", "moderate", "high", "strong"]);
  assert.equal(new Set(labels).size, 5, "each rank must have its own word");
  for (const label of labels) assert.ok(!/\d/.test(label), `no digit in label: ${label}`);
});

test("confidenceLabel clamps out-of-range ranks fail-closed to 'uncertain'", () => {
  assert.equal(confidenceLabel(-1), "uncertain");
  assert.equal(confidenceLabel(5), "uncertain");
  assert.equal(confidenceLabel(Number.NaN), "uncertain");
});

test("nodeMeta renders a two-column right-hand side with type, tradition, and confidence", () => {
  const meta = nodeMeta(node({ pageType: "concept", tradition: "stoic", effectiveConfidenceRank: 3 }));
  assert.ok(meta.includes("concept"), "shows page type");
  assert.ok(meta.includes("stoic"), "shows tradition");
  assert.ok(meta.includes("high"), "shows the ordinal word label");
  assert.ok(meta.includes(confidenceBand(3)), "shows the ordinal glyph");
  assert.ok(!meta.includes("downgraded"), "clean node has no warning");
});

test("nodeMeta flags a downgraded node in plain language", () => {
  const meta = nodeMeta(node({ confidenceLaundered: true, effectiveConfidenceRank: 2 }));
  assert.ok(meta.includes("⚠ downgraded"));
});

test("connectionLine uses plain language for resolved, conflict, and unresolved edges", () => {
  const resolved = connectionLine(edge({ resolved: true, conflict: false, kind: "teaches", dst: "prosoche" }));
  assert.ok(resolved.startsWith("→"), "resolved edge uses a solid arrow");
  assert.ok(resolved.includes("teaches prosoche"));

  const conflict = connectionLine(edge({ conflict: true, dst: "prosoche", kind: "mentions" }));
  assert.ok(conflict.includes("✗"), "conflict carried by glyph");
  assert.ok(conflict.includes("conflicts with"), "plain-language conflict marker");

  const unresolved = connectionLine(edge({ resolved: false, dst: "arrian", kind: "compiled_by" }));
  assert.ok(unresolved.includes("┄"), "unresolved carried by dashed glyph");
  assert.ok(unresolved.includes("unresolved"), "plain-language unresolved marker");
});
