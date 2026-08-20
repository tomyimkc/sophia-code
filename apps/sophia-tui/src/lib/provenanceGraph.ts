/**
 * Experimental, local-only provenance projection for Sophia team runs.
 *
 * The graph is a receipt-oriented UI model. It records reported relationships
 * between prompts, lanes, tool observations, results, conflicts, and merges.
 * It is not a validator and intentionally has no "validated" status.
 */

export const PROVENANCE_GRAPH_SCHEMA = "sophia.tui.provenance.v1" as const;
export const PROVENANCE_EXPERIMENTAL_LABEL =
  "Experimental provenance · local only";
export const PROVENANCE_HONESTY_NOTE =
  "Trace view only · reported/inferred links are not validation";

export type ProvenanceRecordStatus =
  | "observed"
  | "reported"
  | "inferred"
  | "unverified";

export type ProvenanceNodeKind =
  | "prompt"
  | "lane"
  | "tool"
  | "evidence"
  | "result"
  | "conflict"
  | "merge"
  | "artifact";

export interface ProvenanceNode {
  id: string;
  kind: ProvenanceNodeKind;
  label: string;
  status: ProvenanceRecordStatus;
  laneId?: string;
  detail?: string;
  /** Optional path or opaque local artifact ID; this module never opens it. */
  localRef?: string;
}
export type ProvenanceEdgeKind =
  | "assigned-to"
  | "produced-by"
  | "derived-from"
  | "references"
  | "supports"
  | "conflicts-with"
  | "merged-into"
  | "excluded-from";

export interface ProvenanceEdge {
  id: string;
  from: string;
  to: string;
  kind: ProvenanceEdgeKind;
  status: Exclude<ProvenanceRecordStatus, "observed">;
  detail?: string;
}

export interface ProvenanceGraph {
  schema: typeof PROVENANCE_GRAPH_SCHEMA;
  experimental: true;
  storage: "local-only";
  generatedAt: string;
  sessionId?: string;
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
}

export interface ProvenanceGraphInput {
  generatedAt?: string;
  sessionId?: string;
  nodes?: readonly ProvenanceNode[];
  edges?: readonly ProvenanceEdge[];
}

/**
 * Build a graph with the experimental/local-only contract fixed in the type
 * and runtime value. Inputs are copied so callers cannot mutate the original
 * arrays through the graph.
 */
export function createProvenanceGraph(
  input: ProvenanceGraphInput = {},
): ProvenanceGraph {
  return {
    schema: PROVENANCE_GRAPH_SCHEMA,
    experimental: true,
    storage: "local-only",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    nodes: [...(input.nodes ?? [])],
    edges: [...(input.edges ?? [])],
  };
}

export type ProvenanceIssueCode =
  | "duplicate-node"
  | "duplicate-edge"
  | "dangling-edge"
  | "remote-reference";

export interface ProvenanceIssue {
  code: ProvenanceIssueCode;
  id: string;
  detail: string;
}

function hasRemoteScheme(value: string): boolean {
  return /^(?:https?|wss?|ftp|s3|gs):\/\//i.test(value.trim());
}

/**
 * Validate only UI integrity and the local-storage boundary. This does not
 * establish truth, evidence quality, or semantic correctness.
 */
export function inspectProvenanceGraph(
  graph: ProvenanceGraph,
): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "duplicate-node",
        id: node.id,
        detail: `duplicate node id: ${node.id}`,
      });
    }
    nodeIds.add(node.id);
    if (node.localRef && hasRemoteScheme(node.localRef)) {
      issues.push({
        code: "remote-reference",
        id: node.id,
        detail: `remote reference is outside the local-only panel contract: ${node.id}`,
      });
    }
  }

  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: "duplicate-edge",
        id: edge.id,
        detail: `duplicate edge id: ${edge.id}`,
      });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      issues.push({
        code: "dangling-edge",
        id: edge.id,
        detail: `edge ${edge.id} references a missing node`,
      });
    }
  }

  return issues;
}

export interface ProvenanceGraphCounts {
  nodes: number;
  edges: number;
  conflicts: number;
  inferred: number;
  unverified: number;
  issues: number;
}

export function countProvenanceGraph(
  graph: ProvenanceGraph,
): ProvenanceGraphCounts {
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    conflicts:
      graph.nodes.filter((node) => node.kind === "conflict").length +
      graph.edges.filter((edge) => edge.kind === "conflicts-with").length,
    inferred:
      graph.nodes.filter((node) => node.status === "inferred").length +
      graph.edges.filter((edge) => edge.status === "inferred").length,
    unverified:
      graph.nodes.filter((node) => node.status === "unverified").length +
      graph.edges.filter((edge) => edge.status === "unverified").length,
    issues: inspectProvenanceGraph(graph).length,
  };
}

export function edgesForProvenanceNode(
  graph: ProvenanceGraph,
  nodeId: string,
): ProvenanceEdge[] {
  return graph.edges.filter(
    (edge) => edge.from === nodeId || edge.to === nodeId,
  );
}
