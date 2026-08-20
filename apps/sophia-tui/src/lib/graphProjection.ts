/**
 * Client-side model for the OKF graph projection (schema
 * `sophia.graph_projection.v1`), produced by the Python side
 * (`okf.project_graph`) and consumed here read-only.
 *
 * This is a PROVENANCE AUDIT view, not a claim of validated knowledge: the
 * projection is always `candidateOnly` and `canClaimAGI:false`. Mirrors
 * lib/workflow.ts's reducer shape and its fail-closed discipline — a stale or
 * malformed snapshot is IGNORED rather than rendered, and colour is never the
 * only carrier of a signal (WCAG 1.4.1, see components/epistemicGlyphs.ts).
 *
 * Deliberately dependency-free (no React import) so the pure mapping can be
 * unit-tested without Ink, and deliberately renders NO numeric confidence
 * probability anywhere: components/EpistemicChip.ts documents that a bare
 * scalar increases over-reliance rather than calibrating it. Confidence is
 * shown as an ordinal glyph band only.
 */

export const GRAPH_PROJECTION_SCHEMA = "sophia.graph_projection.v1";

export interface ProjectionScope {
  domain: string | null;
  root: string | null;
  depth: number | null;
}

export interface ProjectionNode {
  id: string;
  pageType: string;
  domain: string | null;
  tradition: string | null;
  authorConfidence: string | null;
  /** Ordinal 0-4 as authored. */
  confidenceRank: number;
  /** Ordinal 0-4 after laundering/downgrade checks. */
  effectiveConfidenceRank: number;
  confidenceLaundered: boolean;
}

export interface ProjectionEdge {
  src: string;
  dst: string;
  kind: string;
  resolved: boolean;
  effectiveRank: number;
  conflict: boolean;
  evidence: string[];
}

export interface ProjectionStats {
  nodeCount: number;
  edgeCount: number;
  resolvedEdgeCount: number;
  danglingCount: number;
  launderedCount: number;
}

export interface GraphProjection {
  schema: typeof GRAPH_PROJECTION_SCHEMA;
  candidateOnly: boolean;
  canClaimAGI: false;
  level3Evidence: boolean;
  generatedAt: string;
  source: string;
  scope: ProjectionScope;
  nodes: ProjectionNode[];
  edges: ProjectionEdge[];
  /** Opaque dict — the panel does not interpret it, only passes it through. */
  ledger: Record<string, unknown>;
  stats: ProjectionStats;
}

export interface GraphProjectionState {
  projection: GraphProjection | null;
  selectedId: string | null;
  expanded: Set<string>;
  filter: string;
  /** Explicit backend sequence of the accepted snapshot, if one was carried. */
  sequence: number | null;
  receivedAt: number;
}

export const EMPTY_GRAPH_PROJECTION_STATE: GraphProjectionState = {
  projection: null, selectedId: null, expanded: new Set(), filter: "", sequence: null, receivedAt: 0,
};

export type GraphProjectionAction =
  | { type: "snapshot"; projection: unknown; sequence?: number }
  | { type: "select"; id: string | null }
  | { type: "toggle"; id: string }
  | { type: "filter"; value: string }
  | { type: "clear" };

/**
 * Whitelist, not a blacklist (the same discipline as workflow.ts's
 * ACTIVE_STATES): an unrecognised or malformed projection — missing schema
 * field, wrong schema string, non-array nodes/edges — is rejected rather than
 * partially rendered. Failing open here would let a half-formed snapshot draw
 * a misleading "knowledge graph".
 */
export function isValidProjection(value: unknown): value is GraphProjection {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  if (p.schema !== GRAPH_PROJECTION_SCHEMA) return false;
  if (!Array.isArray(p.nodes)) return false;
  if (!Array.isArray(p.edges)) return false;
  return true;
}

/**
 * Order two snapshots so an older read can never roll back a newer one —
 * the whole-snapshot analogue of workflow.ts's nodeVersion/mergeSnapshotNodes.
 * Prefer the explicit backend `sequence`; fall back to the `generatedAt`
 * timestamp when a sequence is absent. Returns true when `incoming` is STRICTLY
 * OLDER than `current` (equal-or-newer supersedes, so an idempotent re-send of
 * the same snapshot is still accepted).
 */
export function isStaleSnapshot(
  current: GraphProjection | null,
  currentSequence: number | null,
  incoming: GraphProjection,
  incomingSequence?: number,
): boolean {
  if (!current) return false;
  const inSeq = typeof incomingSequence === "number" && Number.isFinite(incomingSequence) ? incomingSequence : null;
  const curSeq = typeof currentSequence === "number" && Number.isFinite(currentSequence) ? currentSequence : null;
  if (inSeq !== null && curSeq !== null) return inSeq < curSeq;
  const inT = Date.parse(incoming.generatedAt || "");
  const curT = Date.parse(current.generatedAt || "");
  if (Number.isFinite(inT) && Number.isFinite(curT)) return inT < curT;
  // No comparable ordering signal on both sides: accept (supersede) rather
  // than freeze the panel on an unverifiable timestamp.
  return false;
}

export function graphProjectionReducer(state: GraphProjectionState, action: GraphProjectionAction): GraphProjectionState {
  if (action.type === "clear") return { ...EMPTY_GRAPH_PROJECTION_STATE, expanded: new Set() };
  if (action.type === "snapshot") {
    // Fail closed: a malformed projection is dropped, not rendered.
    if (!isValidProjection(action.projection)) return state;
    if (isStaleSnapshot(state.projection, state.sequence, action.projection, action.sequence)) return state;
    const expanded = new Set(state.expanded);
    // Drop expansions for nodes that no longer exist in the new snapshot so a
    // superseding projection cannot leave a stale id "open".
    const ids = new Set(action.projection.nodes.map((n) => n.id));
    for (const id of expanded) if (!ids.has(id)) expanded.delete(id);
    const selectedId = state.selectedId && ids.has(state.selectedId) ? state.selectedId : null;
    return {
      ...state,
      projection: action.projection,
      expanded,
      selectedId,
      sequence: typeof action.sequence === "number" && Number.isFinite(action.sequence) ? action.sequence : state.sequence,
      receivedAt: Date.now(),
    };
  }
  if (action.type === "select") return { ...state, selectedId: action.id };
  if (action.type === "toggle") {
    const expanded = new Set(state.expanded); expanded.has(action.id) ? expanded.delete(action.id) : expanded.add(action.id);
    return { ...state, expanded };
  }
  if (action.type === "filter") return { ...state, filter: action.value };
  return state;
}

/**
 * Ordinal confidence glyph band for a rank 0-4. Colour is never the only
 * carrier (WCAG 1.4.1): the band is a distinct glyph shape per level. Any
 * out-of-range or non-finite rank clamps fail-closed to the LOWEST band — we
 * would rather under-state confidence than over-claim it.
 */
const CONFIDENCE_BANDS = ["·", "░", "▒", "▓", "█"] as const;

export function confidenceBand(rank: number): string {
  if (typeof rank !== "number" || !Number.isFinite(rank)) return CONFIDENCE_BANDS[0];
  if (rank < 0 || rank > 4) return CONFIDENCE_BANDS[0];
  return CONFIDENCE_BANDS[Math.floor(rank)];
}

/**
 * Ordinal WORD label for a confidence rank 0-4 — the plain-language companion
 * to the glyph band. Never a number or percentage (the over-reliance trap).
 * Out-of-range / non-finite ranks clamp fail-closed to the LOWEST label, same
 * discipline as confidenceBand.
 */
const CONFIDENCE_LABELS = ["uncertain", "low", "moderate", "high", "strong"] as const;

export function confidenceLabel(rank: number): string {
  if (typeof rank !== "number" || !Number.isFinite(rank)) return CONFIDENCE_LABELS[0];
  if (rank < 0 || rank > 4) return CONFIDENCE_LABELS[0];
  return CONFIDENCE_LABELS[Math.floor(rank)];
}

/**
 * Right-hand meta for a node row in the two-column layout: pageType, tradition,
 * and the ordinal confidence (glyph + word). A downgraded node earns a
 * plain-language "⚠ downgraded" marker (display-by-exception).
 */
export function nodeMeta(node: ProjectionNode): string {
  const tradition = node.tradition ? ` · ${node.tradition}` : "";
  const conf = `${confidenceBand(node.effectiveConfidenceRank)} ${confidenceLabel(node.effectiveConfidenceRank)}`;
  const downgraded = isLaundered(node) ? " ⚠ downgraded" : "";
  return `${node.pageType}${tradition} · ${conf}${downgraded}`;
}

/**
 * A plain-language one-line description of a connection (edge) for the expanded
 * detail view. Conflict and unresolved states are carried by distinct glyphs
 * (WCAG 1.4.1) plus words, never colour alone.
 */
export function connectionLine(edge: ProjectionEdge): string {
  if (isConflictEdge(edge)) return `✗ conflicts with ${edge.dst} (${edge.kind})`;
  if (!edge.resolved) return `┄ links to ${edge.dst} (${edge.kind}) — unresolved`;
  return `→ ${edge.kind} ${edge.dst}`;
}

export function isConflictEdge(edge: ProjectionEdge): boolean {
  return edge.conflict === true;
}

export function isLaundered(node: ProjectionNode): boolean {
  return node.confidenceLaundered === true;
}

function nodeIdSet(projection: GraphProjection): Set<string> {
  return new Set(projection.nodes.map((n) => n.id));
}

/** Edges that reference a node id absent from the projection. */
export function danglingEdges(projection: GraphProjection): ProjectionEdge[] {
  const ids = nodeIdSet(projection);
  return projection.edges.filter((e) => !ids.has(e.src) || !ids.has(e.dst));
}

/**
 * Count of dangling edges, COMPUTED from the graph structure rather than
 * trusted from stats.danglingCount: a provenance-audit view should reflect the
 * edges actually present, not a summary field that could have drifted.
 */
export function danglingCount(projection: GraphProjection): number {
  return danglingEdges(projection).length;
}

export interface DisplayExceptions {
  laundered: ProjectionNode[];
  conflicts: ProjectionEdge[];
  dangling: ProjectionEdge[];
}

/**
 * Display by exception (the alarm-fatigue discipline from EpistemicChip): the
 * ONLY things worth rendering loud are laundered nodes, conflict edges, and
 * dangling edges. Routine, checked provenance stays dim. Callers render nothing
 * loud when every list here is empty.
 */
export function displayExceptions(projection: GraphProjection): DisplayExceptions {
  return {
    laundered: projection.nodes.filter(isLaundered),
    conflicts: projection.edges.filter(isConflictEdge),
    dangling: danglingEdges(projection),
  };
}

/** Edges touching a node (either direction). */
export function edgesFor(projection: GraphProjection, id: string): ProjectionEdge[] {
  return projection.edges.filter((e) => e.src === id || e.dst === id);
}

/** Nodes matching the active filter (case-insensitive substring over the id/pageType/tradition/domain). */
export function visibleNodes(state: GraphProjectionState): ProjectionNode[] {
  if (!state.projection) return [];
  const needle = state.filter.trim().toLowerCase();
  if (!needle) return state.projection.nodes;
  return state.projection.nodes.filter((n) =>
    [n.id, n.pageType, n.tradition || "", n.domain || ""].some((f) => f.toLowerCase().includes(needle)),
  );
}

/**
 * A clearly-labelled MOCK projection for local UI wiring until the panel
 * subscribes to the `sophia_dump_graph` bridge event (see App.tsx /graph
 * handler). Shaped exactly to sophia.graph_projection.v1 so the reducer's
 * whitelist accepts it. TODO: replace with a live bridge subscription.
 */
export const MOCK_GRAPH_PROJECTION: GraphProjection = {
  schema: GRAPH_PROJECTION_SCHEMA,
  candidateOnly: true,
  canClaimAGI: false,
  level3Evidence: false,
  generatedAt: "2026-07-29T00:00:00Z",
  source: "okf.project_graph",
  scope: { domain: "philosophy", root: "prosoche", depth: 2 },
  nodes: [
    { id: "prosoche", pageType: "concept", domain: "philosophy", tradition: "stoic", authorConfidence: "attested", confidenceRank: 3, effectiveConfidenceRank: 3, confidenceLaundered: false },
    { id: "epictetus", pageType: "figure", domain: "philosophy", tradition: "stoic", authorConfidence: "attested", confidenceRank: 4, effectiveConfidenceRank: 3, confidenceLaundered: true },
    { id: "discourses", pageType: "text", domain: "philosophy", tradition: "stoic", authorConfidence: "compiled", confidenceRank: 2, effectiveConfidenceRank: 2, confidenceLaundered: false },
  ],
  edges: [
    { src: "epictetus", dst: "prosoche", kind: "teaches", resolved: true, effectiveRank: 3, conflict: false, evidence: ["discourses 1.1"] },
    { src: "discourses", dst: "prosoche", kind: "mentions", resolved: true, effectiveRank: 2, conflict: true, evidence: ["discourses 1.1", "encheiridion 1"] },
    { src: "discourses", dst: "arrian", kind: "compiled_by", resolved: false, effectiveRank: 1, conflict: false, evidence: [] },
  ],
  ledger: { disputes: 1 },
  stats: { nodeCount: 3, edgeCount: 3, resolvedEdgeCount: 2, danglingCount: 1, launderedCount: 1 },
};
