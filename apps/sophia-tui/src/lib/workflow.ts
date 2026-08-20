export type WorkflowKind = "workflow" | "phase" | "agent" | "shell" | "tool" | "validation";
export type WorkflowStatus = "queued" | "running" | "blocked" | "succeeded" | "failed" | "cancelled" | string;

export interface WorkflowNode {
  taskId: string;
  runId?: string | null;
  requestId?: string | null;
  session?: string | null;
  parentId?: string | null;
  name: string;
  title?: string;
  kind: WorkflowKind;
  state: WorkflowStatus;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  attempt?: number;
  /** Monotonic backend receipt sequence, used to reject stale snapshots. */
  sequence?: number;
  canCancel?: boolean;
  canRetry?: boolean;
  blockedReason?: string;
  detail?: Record<string, unknown>;
  timings?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  artifacts?: string[];
  logs?: string[];
}

export interface WorkflowSnapshot {
  nodes: WorkflowNode[];
  trees?: unknown[];
  retention?: { retainCompleted?: boolean; maxRuns?: number; maxAgeDays?: number };
  capabilities?: { cancel?: boolean; retry?: boolean; logs?: boolean };
  receivedAt: number;
}

export interface WorkflowState {
  nodes: Record<string, WorkflowNode>;
  selectedId: string | null;
  expanded: Set<string>;
  filter: string;
  view: "tasks" | "workflows" | "hidden";
  snapshot: WorkflowSnapshot | null;
  /**
   * runId of the run the user most recently started in this client session,
   * set by the "run_start" action. Once set, activeWorkflowNodes() only
   * counts unfinished nodes tagged with THIS runId (or no runId at all) as
   * active. Nodes from an earlier runId stay in `nodes` (so /tasks and
   * /workflows history still shows them) but stop rendering in the "Active
   * work" banner, even if they're stuck "running" forever because App.tsx's
   * cross-run event guard dropped their terminal event. null means this
   * session hasn't started a run yet (e.g. a fresh reconnect snapshot before
   * the first prompt) — in that case nothing is scoped away.
   */
  activeRunId: string | null;
}

export const EMPTY_WORKFLOW_STATE: WorkflowState = {
  nodes: {}, selectedId: null, expanded: new Set(), filter: "", view: "hidden", snapshot: null, activeRunId: null,
};

export type WorkflowAction =
  | { type: "snapshot"; snapshot: Omit<WorkflowSnapshot, "receivedAt"> }
  | { type: "event"; event: Partial<WorkflowNode> & { taskId: string; state?: WorkflowStatus } }
  | { type: "select"; id: string | null }
  | { type: "toggle"; id: string }
  | { type: "filter"; value: string }
  | { type: "view"; value: WorkflowState["view"] }
  /** Dispatch when a NEW run begins (App.tsx's t === "run_start" handler,
   *  the same place that sets activeRunIdRef.current) to scope the "Active
   *  work" banner to that run and stop rendering the previous run's
   *  leftovers as active. */
  | { type: "run_start"; runId: string }
  | { type: "clear" };

function nodeVersion(node: Partial<WorkflowNode>): number {
  const sequence = Number((node as { sequence?: unknown }).sequence);
  if (Number.isFinite(sequence) && sequence > 0) return sequence;
  const updatedAt = Date.parse(String((node as { updatedAt?: unknown }).updatedAt || ""));
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

/**
 * The receipt protocol historically closes every non-successful run as
 * `failed`. Newer kernels add `awaitingInput:true` when the run intentionally
 * paused for owner input. Normalize that additive detail to the existing
 * `blocked` display state so old receipt readers remain compatible while the
 * current TUI no longer paints an actionable pause as a red execution failure.
 */
function normalizeAwaitingInputNode<T extends Partial<WorkflowNode>>(node: T): T {
  const extra = node as T & { awaitingInput?: unknown; incompleteReason?: unknown };
  const detail = node.detail && typeof node.detail === "object"
    ? node.detail as Record<string, unknown>
    : {};
  const awaitingInput = extra.awaitingInput === true || detail.awaitingInput === true;
  if (!awaitingInput || node.state !== "failed") return node;
  const reason = String(
    extra.incompleteReason || detail.incompleteReason || "awaiting user input",
  ).replaceAll("_", " ");
  return {
    ...node,
    state: "blocked",
    blockedReason: node.blockedReason || reason,
  };
}

/** Merge a backend snapshot without allowing an older read to roll back live events. */
function mergeSnapshotNodes(state: WorkflowState, incoming: WorkflowNode[]): Record<string, WorkflowNode> {
  const merged: Record<string, WorkflowNode> = { ...state.nodes };
  for (const rawNode of incoming) {
    const node = normalizeAwaitingInputNode(rawNode);
    const previous = merged[node.taskId];
    merged[node.taskId] = previous && nodeVersion(previous) > nodeVersion(node)
      ? previous
      : node;
  }
  return merged;
}

/**
 * Whitelist, not a blacklist: a state this client doesn't recognise (a typo,
 * a future addition on the backend, the terminal "interrupted" state added
 * alongside orphan reconciliation) is NOT active by default. Failing open
 * here would render any unrecognised state as perpetually "running".
 */
const ACTIVE_STATES: ReadonlySet<string> = new Set(["running", "queued", "blocked", "cancelling"]);

export function isActiveWorkflowState(state: WorkflowStatus): boolean {
  return ACTIVE_STATES.has(state);
}

export function activeWorkflowNodes(state: WorkflowState): WorkflowNode[] {
  return Object.values(state.nodes).filter((node) =>
    isActiveWorkflowState(node.state) &&
    // Scope to the run this session most recently started; a node carrying
    // no runId (or matching the current one) is unaffected.
    (!state.activeRunId || !node.runId || node.runId === state.activeRunId),
  );
}

/**
 * Kinds that read as a "to-do" in the side panel. Deliberately EXCLUDES "tool"
 * (every tool call is a node — noise) AND "agent" (team lanes get their OWN
 * "Team" section via teamLaneNodes below, so they are not double-listed here).
 * What remains are the coarser units of work — a shell step, a validation, a
 * phase — plus "workflow" as the run-level head item. Mirrors TaskKind.
 */
const TODO_KINDS: ReadonlySet<string> = new Set(["workflow", "phase", "shell", "validation"]);

/**
 * A node is "done" (the panel crosses it out) once it reaches any terminal
 * state. Whitelist, not a blacklist — an unrecognised state is NOT terminal, so
 * a future/typo state stays visible rather than being silently struck through
 * (the same fail-closed reasoning as ACTIVE_STATES above). Mirrors
 * agent/task_receipts.py::TERMINAL_STATES.
 */
export function isTerminalWorkflowState(state: WorkflowStatus): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "interrupted";
}

/**
 * Pick the newest durable run represented in a receipt snapshot.
 *
 * Session resume asks the kernel for retained receipts, including prior runs.
 * A right panel scoped to no run would otherwise mix every historical team
 * lane together. Root workflow creation time is the run boundary; it is more
 * stable than a child lane's later completion time, which could make an older
 * slow lane appear newer than the run the operator just resumed.
 */
export function latestWorkflowRunId(nodes: readonly WorkflowNode[]): string | null {
  const roots = nodes.filter((node) => node.kind === "workflow" && Boolean(node.runId));
  const candidates = roots.length > 0
    ? roots
    : nodes.filter((node) => Boolean(node.runId));
  let latest: WorkflowNode | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  let latestSequence = Number.NEGATIVE_INFINITY;
  for (const node of candidates) {
    const timestamp = Date.parse(String(node.createdAt || node.startedAt || node.finishedAt || ""));
    const time = Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
    const sequence = Number(node.sequence) || 0;
    if (
      latest === null
      || time > latestTime
      || (time === latestTime && sequence > latestSequence)
      || (
        time === latestTime
        && sequence === latestSequence
        && String(node.runId).localeCompare(String(latest.runId)) > 0
      )
    ) {
      latest = node;
      latestTime = time;
      latestSequence = sequence;
    }
  }
  return latest?.runId || null;
}

/**
 * The side-panel to-do list: this run's COARSE task nodes in creation order,
 * terminal ones INCLUDED — the panel crosses them out rather than hiding them
 * ("accumulate, don't vanish"). Scoped exactly like activeWorkflowNodes (to the
 * run this session started) so a new run starts the list fresh, and capped so a
 * long run cannot overflow the fixed-height panel (the full tree stays in /tasks).
 */
export function todoNodes(state: WorkflowState, limit = 20): WorkflowNode[] {
  const nodes = Object.values(state.nodes).filter((n) =>
    TODO_KINDS.has(n.kind) &&
    (!state.activeRunId || !n.runId || n.runId === state.activeRunId),
  );
  nodes.sort((a, b) =>
    (Number(a.sequence) || 0) - (Number(b.sequence) || 0) ||
    String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
  );
  return nodes.length > limit ? nodes.slice(nodes.length - limit) : nodes;
}

/**
 * The side-panel "Team" section: this run's agent LANES (one row per parallel
 * team member), in creation order. Each lane is an AGENT node minted on
 * lane_start; the kernel advances it running→succeeded/failed on lane_end
 * (emitting a receipt the reducer merges), so a row goes ▶ → ✓/✗ as the member
 * finishes. Scoped + capped like todoNodes. Empty for a solo run (no lanes) —
 * which is when the panel hides this section.
 */
export function teamLaneNodes(state: WorkflowState, limit = 8): WorkflowNode[] {
  const nodes = Object.values(state.nodes).filter((n) =>
    n.kind === "agent" &&
    (!state.activeRunId || !n.runId || n.runId === state.activeRunId),
  );
  nodes.sort((a, b) =>
    (Number(a.sequence) || 0) - (Number(b.sequence) || 0) ||
    String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
  );
  return nodes.length > limit ? nodes.slice(nodes.length - limit) : nodes;
}

export function workflowReducer(state: WorkflowState, action: WorkflowAction): WorkflowState {
  if (action.type === "clear") return { ...EMPTY_WORKFLOW_STATE, expanded: new Set() };
  if (action.type === "run_start") {
    // No runId means the caller has nothing to scope to yet; never blank out
    // an already-known active run over a malformed/empty event.
    return action.runId ? { ...state, activeRunId: action.runId } : state;
  }
  if (action.type === "snapshot") {
    const nodes = mergeSnapshotNodes(state, action.snapshot.nodes);
    const expanded = new Set(state.expanded);
    for (const n of action.snapshot.nodes) if (!n.parentId && n.state === "running") expanded.add(n.taskId);
    const activeRunId = state.activeRunId || latestWorkflowRunId(action.snapshot.nodes);
    return {
      ...state,
      nodes,
      expanded,
      activeRunId,
      snapshot: { ...action.snapshot, receivedAt: Date.now() },
    };
  }
  if (action.type === "event") {
    const previous = state.nodes[action.event.taskId];
    const next = normalizeAwaitingInputNode({ ...previous, ...action.event } as WorkflowNode);
    // Snapshots and live events share the same monotonic receipt version.
    // A reconnect can deliver an older event after a newer snapshot; applying
    // it would visibly regress a completed lane back to running/queued.  Keep
    // accepting legacy events that carry no version at all, but reject an
    // explicitly-versioned stale event.
    const incomingSequence = Number(next.sequence);
    const incomingUpdatedAt = Date.parse(
      String((next as { updatedAt?: unknown }).updatedAt || ""),
    );
    const hasIncomingVersion = (
      (Number.isFinite(incomingSequence) && incomingSequence > 0)
      || Number.isFinite(incomingUpdatedAt)
    );
    if (
      previous
      && hasIncomingVersion
      && nodeVersion(previous) > nodeVersion(next)
    ) {
      return state;
    }
    return { ...state, nodes: { ...state.nodes, [next.taskId]: next }, snapshot: state.snapshot ? { ...state.snapshot, receivedAt: Date.now() } : null };
  }
  if (action.type === "select") return { ...state, selectedId: action.id };
  if (action.type === "toggle") {
    const expanded = new Set(state.expanded); expanded.has(action.id) ? expanded.delete(action.id) : expanded.add(action.id);
    return { ...state, expanded };
  }
  if (action.type === "filter") return { ...state, filter: action.value };
  return { ...state, view: action.value };
}

export function workflowRoots(state: WorkflowState): WorkflowNode[] {
  const needle = state.filter.trim().toLowerCase();
  return Object.values(state.nodes).filter((n) => !n.parentId && (!needle || JSON.stringify(n).toLowerCase().includes(needle)));
}

export function workflowChildren(state: WorkflowState, parentId: string): WorkflowNode[] {
  return Object.values(state.nodes).filter((n) => n.parentId === parentId);
}

export function flattenWorkflow(state: WorkflowState): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  const visit = (n: WorkflowNode) => { out.push(n); if (state.expanded.has(n.taskId)) workflowChildren(state, n.taskId).forEach(visit); };
  workflowRoots(state).forEach(visit); return out;
}

/**
 * The node update carried by a `receipt` / `task_action` event, or null.
 *
 * The bridge puts taskId in the receipt ENVELOPE and only sometimes in the
 * payload: `task.<kind>.created` sends the whole node dict (which has it), but
 * the lifecycle receipts send just `{state: …}` / `{state: …, ok: …}`. Requiring
 * payload.taskId therefore dropped every state transition — nodes were created
 * QUEUED and never moved, so finished work never retired from the "Active work"
 * banner and its terminal receipts were silently lost. The envelope's taskId is
 * the one that is always present.
 */
export function receiptNodeEvent(ev: Record<string, unknown>): (Record<string, unknown> & { taskId: string }) | null {
  const raw = (ev.payload && typeof ev.payload === "object" ? ev.payload : ev.task) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const fromPayload = typeof raw.taskId === "string" ? raw.taskId : "";
  const fromEnvelope = typeof ev.taskId === "string" ? ev.taskId : "";
  const taskId = fromPayload || fromEnvelope;
  if (!taskId) return null;
  return { ...raw, taskId };
}

export function redactLog(value: unknown): string {
  return String(value ?? "").replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]").replace(/\b(secret|token|password|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 2000);
}
