import test from "node:test";
import assert from "node:assert/strict";
import { resolveAccessibility } from "../lib/accessibility.js";
import {
  createProvenanceGraph,
  type ProvenanceEdge,
  type ProvenanceNode,
} from "../lib/provenanceGraph.js";
import { displayWidth } from "../lib/textWidth.js";
import {
  provenanceBorderStyle,
  provenanceEdgeLine,
  provenanceNodeLine,
  provenancePanelLayout,
  provenanceSummary,
} from "./ProvenancePanel.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

const node: ProvenanceNode = {
  id: "result-1",
  kind: "result",
  label: "跨平台 provider analysis with a deliberately long label",
  status: "unverified",
  laneId: "lane-review",
  detail: "Reported by the lane; not independently validated",
};

const edge: ProvenanceEdge = {
  id: "edge-1",
  from: "result-1",
  to: "merge-1",
  kind: "merged-into",
  status: "inferred",
  detail: "Derived from locally reported merge metadata",
};

test("panel layout collapses at stable width thresholds", () => {
  assert.equal(provenancePanelLayout(100), "wide");
  assert.equal(provenancePanelLayout(76), "wide");
  assert.equal(provenancePanelLayout(60), "compact");
  assert.equal(provenancePanelLayout(44), "compact");
  assert.equal(provenancePanelLayout(30), "minimal");
});

test("screen-reader mode removes the decorative border", () => {
  assert.equal(
    provenanceBorderStyle(
      resolveAccessibility(["--ax-screen-reader"], NO_ENV),
    ),
    undefined,
  );
  assert.equal(
    provenanceBorderStyle(resolveAccessibility([], NO_ENV)),
    "round",
  );
});

test("node rows carry status in text and glyphs rather than colour alone", () => {
  const line = provenanceNodeLine(node, 120, "wide");
  assert.match(line, /^\? /);
  assert.match(line, /\[result\/unverified\]/);
  assert.match(line, /lane:lane-review/);
});

test("edge rows label inferred/conflict state without implying validation", () => {
  const inferred = provenanceEdgeLine(edge, 120, "wide");
  assert.match(inferred, /^~ /);
  assert.match(inferred, /\[merged-into\/inferred\]/);
  assert.ok(!/validated|verified/.test(inferred));

  const conflict = provenanceEdgeLine(
    { ...edge, kind: "conflicts-with", status: "unverified" },
    120,
    "wide",
  );
  assert.match(conflict, / ✗ /);
  assert.match(conflict, /conflicts-with\/unverified/);
});

test("node and edge lines obey terminal-column width with wide glyphs", () => {
  for (const width of [16, 28, 50, 90]) {
    assert.ok(displayWidth(provenanceNodeLine(node, width)) <= width);
    assert.ok(displayWidth(provenanceEdgeLine(edge, width)) <= width);
  }
});

test("summary exposes conflicts, inferred links, unverified records, and issues", () => {
  const graph = createProvenanceGraph({
    nodes: [
      node,
      {
        id: "conflict-1",
        kind: "conflict",
        label: "Contradiction",
        status: "reported",
      },
    ],
    edges: [
      edge,
      {
        id: "edge-conflict",
        from: "result-1",
        to: "conflict-1",
        kind: "conflicts-with",
        status: "unverified",
      },
      {
        id: "edge-dangling",
        from: "missing",
        to: "result-1",
        kind: "derived-from",
        status: "reported",
      },
    ],
  });
  const summary = provenanceSummary(graph);
  assert.match(summary, /2 nodes/);
  assert.match(summary, /3 links/);
  assert.match(summary, /2 conflicts/);
  assert.match(summary, /1 inferred/);
  assert.match(summary, /2 unverified/);
  assert.match(summary, /2 integrity issues/);
});
