import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVENANCE_EXPERIMENTAL_LABEL,
  PROVENANCE_GRAPH_SCHEMA,
  PROVENANCE_HONESTY_NOTE,
  countProvenanceGraph,
  createProvenanceGraph,
  edgesForProvenanceNode,
  inspectProvenanceGraph,
  type ProvenanceEdge,
  type ProvenanceNode,
} from "./provenanceGraph.js";

const nodes: ProvenanceNode[] = [
  {
    id: "prompt-1",
    kind: "prompt",
    label: "Owner request",
    status: "observed",
  },
  {
    id: "lane-1",
    kind: "lane",
    label: "Provider review lane",
    status: "reported",
  },
  {
    id: "result-1",
    kind: "result",
    label: "Review findings",
    status: "unverified",
    laneId: "lane-1",
    localRef: "receipts/result-1.json",
  },
];

const edges: ProvenanceEdge[] = [
  {
    id: "edge-1",
    from: "prompt-1",
    to: "lane-1",
    kind: "assigned-to",
    status: "reported",
  },
  {
    id: "edge-2",
    from: "result-1",
    to: "lane-1",
    kind: "produced-by",
    status: "inferred",
  },
];

test("graph creation always fixes the experimental local-only contract", () => {
  const graph = createProvenanceGraph({
    generatedAt: "2026-07-30T00:00:00.000Z",
    nodes,
    edges,
  });
  assert.equal(graph.schema, PROVENANCE_GRAPH_SCHEMA);
  assert.equal(graph.experimental, true);
  assert.equal(graph.storage, "local-only");
  assert.equal(PROVENANCE_EXPERIMENTAL_LABEL, "Experimental provenance · local only");
  assert.match(PROVENANCE_HONESTY_NOTE, /not validation/);
});
test("graph creation copies arrays instead of retaining caller containers", () => {
  const graph = createProvenanceGraph({ nodes, edges });
  assert.notEqual(graph.nodes, nodes);
  assert.notEqual(graph.edges, edges);
});

test("integrity inspection detects duplicates, dangling edges, and remote refs", () => {
  const graph = createProvenanceGraph({
    nodes: [
      ...nodes,
      { ...nodes[0] },
      {
        id: "artifact-remote",
        kind: "artifact",
        label: "Remote",
        status: "unverified",
        localRef: "https://example.invalid/result.json",
      },
    ],
    edges: [
      ...edges,
      { ...edges[0] },
      {
        id: "edge-missing",
        from: "missing",
        to: "lane-1",
        kind: "derived-from",
        status: "unverified",
      },
    ],
  });
  const codes = inspectProvenanceGraph(graph).map((issue) => issue.code);
  assert.ok(codes.includes("duplicate-node"));
  assert.ok(codes.includes("duplicate-edge"));
  assert.ok(codes.includes("dangling-edge"));
  assert.ok(codes.includes("remote-reference"));
});

test("counts keep conflicts, inferred, unverified, and integrity issues visible", () => {
  const graph = createProvenanceGraph({
    nodes: [
      ...nodes,
      {
        id: "conflict-1",
        kind: "conflict",
        label: "Conflicting recommendations",
        status: "reported",
      },
    ],
    edges: [
      ...edges,
      {
        id: "edge-conflict",
        from: "result-1",
        to: "conflict-1",
        kind: "conflicts-with",
        status: "unverified",
      },
    ],
  });
  assert.deepEqual(countProvenanceGraph(graph), {
    nodes: 4,
    edges: 3,
    conflicts: 2,
    inferred: 1,
    unverified: 2,
    issues: 0,
  });
});

test("edge lookup returns incoming and outgoing records for one node", () => {
  const graph = createProvenanceGraph({ nodes, edges });
  assert.deepEqual(
    edgesForProvenanceNode(graph, "lane-1").map((edge) => edge.id),
    ["edge-1", "edge-2"],
  );
  assert.deepEqual(edgesForProvenanceNode(graph, "missing"), []);
});
