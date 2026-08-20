import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_GRAPH_PROJECTION_STATE,
  GRAPH_PROJECTION_SCHEMA,
  MOCK_GRAPH_PROJECTION,
  confidenceBand,
  danglingCount,
  displayExceptions,
  graphProjectionReducer,
  isConflictEdge,
  isLaundered,
  isStaleSnapshot,
  isValidProjection,
  visibleNodes,
  type GraphProjection,
  type ProjectionEdge,
  type ProjectionNode,
} from "./graphProjection.js";

function node(over: Partial<ProjectionNode> = {}): ProjectionNode {
  return {
    id: "n", pageType: "concept", domain: null, tradition: null, authorConfidence: null,
    confidenceRank: 0, effectiveConfidenceRank: 0, confidenceLaundered: false, ...over,
  };
}

function projection(over: Partial<GraphProjection> = {}): GraphProjection {
  return {
    schema: GRAPH_PROJECTION_SCHEMA, candidateOnly: true, canClaimAGI: false, level3Evidence: false,
    generatedAt: "2026-07-29T00:00:00Z", source: "okf.project_graph",
    scope: { domain: null, root: null, depth: null }, nodes: [], edges: [], ledger: {},
    stats: { nodeCount: 0, edgeCount: 0, resolvedEdgeCount: 0, danglingCount: 0, launderedCount: 0 },
    ...over,
  };
}

test("confidenceBand maps the ordinal ranks 0-4 to distinct glyphs", () => {
  const bands = [0, 1, 2, 3, 4].map(confidenceBand);
  assert.deepEqual(bands, ["·", "░", "▒", "▓", "█"]);
  assert.equal(new Set(bands).size, 5, "each rank must have its own glyph (colour is never the only carrier)");
});

test("confidenceBand clamps out-of-range ranks fail-closed to the LOWEST band", () => {
  const lowest = confidenceBand(0);
  assert.equal(confidenceBand(-1), lowest);
  assert.equal(confidenceBand(5), lowest);
  assert.equal(confidenceBand(99), lowest);
  assert.equal(confidenceBand(Number.NaN), lowest);
  assert.equal(confidenceBand(Number.POSITIVE_INFINITY), lowest);
  // @ts-expect-error — a missing rank must not crash, it must under-claim.
  assert.equal(confidenceBand(undefined), lowest);
});

test("a malformed projection is rejected by the whitelist, not rendered", () => {
  assert.equal(isValidProjection(null), false);
  assert.equal(isValidProjection({}), false);
  assert.equal(isValidProjection({ schema: "sophia.graph_projection.v1", nodes: "nope" }), false);
  assert.equal(isValidProjection({ schema: "sophia.some_other.v9", nodes: [], edges: [] }), false);
  assert.equal(isValidProjection({ schema: GRAPH_PROJECTION_SCHEMA, nodes: [] }), false, "missing edges array");
  assert.equal(isValidProjection(projection()), true);
});

test("the reducer drops a malformed snapshot instead of adopting it", () => {
  const state = graphProjectionReducer(EMPTY_GRAPH_PROJECTION_STATE, {
    type: "snapshot", projection: { schema: GRAPH_PROJECTION_SCHEMA, nodes: "garbage" },
  });
  assert.equal(state.projection, null);
});

test("an older sequence cannot roll back a newer snapshot", () => {
  let state = graphProjectionReducer(EMPTY_GRAPH_PROJECTION_STATE, {
    type: "snapshot", projection: projection({ generatedAt: "2026-07-29T00:00:02Z" }), sequence: 7,
  });
  assert.equal(state.sequence, 7);
  state = graphProjectionReducer(state, {
    type: "snapshot", projection: projection({ generatedAt: "2026-07-29T00:00:01Z" }), sequence: 5,
  });
  assert.equal(state.sequence, 7, "stale sequence must be ignored");
});

test("without a sequence, an older generatedAt is ignored", () => {
  const newer = projection({ generatedAt: "2026-07-29T00:00:05Z" });
  const older = projection({ generatedAt: "2026-07-29T00:00:01Z" });
  assert.equal(isStaleSnapshot(newer, null, older, undefined), true);
  assert.equal(isStaleSnapshot(older, null, newer, undefined), false);
  assert.equal(isStaleSnapshot(null, null, older, undefined), false, "first snapshot is never stale");
});

test("isConflictEdge / isLaundered read the boolean flags, not colour", () => {
  const conflict: ProjectionEdge = { src: "a", dst: "b", kind: "contradicts", resolved: true, effectiveRank: 2, conflict: true, evidence: [] };
  const calm: ProjectionEdge = { ...conflict, conflict: false };
  assert.equal(isConflictEdge(conflict), true);
  assert.equal(isConflictEdge(calm), false);
  assert.equal(isLaundered(node({ confidenceLaundered: true })), true);
  assert.equal(isLaundered(node({ confidenceLaundered: false })), false);
});

test("displayExceptions surfaces only laundered nodes, conflict edges, and dangling edges", () => {
  const p = projection({
    nodes: [node({ id: "a", confidenceLaundered: true }), node({ id: "b" })],
    edges: [
      { src: "a", dst: "b", kind: "teaches", resolved: true, effectiveRank: 2, conflict: true, evidence: [] },
      { src: "a", dst: "ghost", kind: "mentions", resolved: false, effectiveRank: 1, conflict: false, evidence: [] },
    ],
  });
  const ex = displayExceptions(p);
  assert.deepEqual(ex.laundered.map((n) => n.id), ["a"]);
  assert.equal(ex.conflicts.length, 1);
  assert.deepEqual(ex.dangling.map((e) => e.dst), ["ghost"]);
  assert.equal(danglingCount(p), 1);
});

test("displayExceptions is empty for a clean projection (display-by-exception)", () => {
  const p = projection({
    nodes: [node({ id: "a" }), node({ id: "b" })],
    edges: [{ src: "a", dst: "b", kind: "teaches", resolved: true, effectiveRank: 2, conflict: false, evidence: [] }],
  });
  const ex = displayExceptions(p);
  assert.equal(ex.laundered.length + ex.conflicts.length + ex.dangling.length, 0);
});

test("the reducer accepts a valid snapshot and prunes stale selections/expansions on supersede", () => {
  let state = graphProjectionReducer(EMPTY_GRAPH_PROJECTION_STATE, {
    type: "snapshot", projection: projection({ nodes: [node({ id: "a" }), node({ id: "b" })] }), sequence: 1,
  });
  state = graphProjectionReducer(state, { type: "toggle", id: "a" });
  state = graphProjectionReducer(state, { type: "select", id: "b" });
  assert.ok(state.expanded.has("a"));
  assert.equal(state.selectedId, "b");
  // Superseding snapshot drops node "b"; its selection must clear.
  state = graphProjectionReducer(state, {
    type: "snapshot", projection: projection({ nodes: [node({ id: "a" })] }), sequence: 2,
  });
  assert.equal(state.selectedId, null);
  assert.ok(state.expanded.has("a"), "still-present expansion survives");
});

test("visibleNodes filters case-insensitively over id/pageType/tradition", () => {
  const state = graphProjectionReducer(EMPTY_GRAPH_PROJECTION_STATE, {
    type: "snapshot",
    projection: projection({ nodes: [node({ id: "Prosoche", tradition: "stoic" }), node({ id: "Dao", tradition: "daoist" })] }),
  });
  const filtered = graphProjectionReducer(state, { type: "filter", value: "STOIC" });
  assert.deepEqual(visibleNodes(filtered).map((n) => n.id), ["Prosoche"]);
});

test("no helper emits a numeric confidence probability (bare-scalar anti-pattern)", () => {
  // A confidence percentage is the documented over-reliance trap; the audit
  // view may only ever show an ordinal glyph band.
  const outputs = [
    confidenceBand(0), confidenceBand(2), confidenceBand(4), confidenceBand(7),
    ...displayExceptions(MOCK_GRAPH_PROJECTION).laundered.map((n) => n.id),
    ...visibleNodes({ ...EMPTY_GRAPH_PROJECTION_STATE, projection: MOCK_GRAPH_PROJECTION }).map((n) => confidenceBand(n.effectiveConfidenceRank)),
  ];
  for (const out of outputs) {
    assert.ok(!/\d/.test(out), `helper output must carry no numeric scalar: ${JSON.stringify(out)}`);
    assert.ok(!/%/.test(out), `helper output must carry no percentage: ${JSON.stringify(out)}`);
  }
});
