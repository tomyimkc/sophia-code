/**
 * Standalone projection for AGI-controller workflow observability.
 *
 * The reducer consumes structured runtime receipts only. It deliberately
 * ignores token/thinking/reasoning fields and exposes bounded operational
 * summaries: routing, nodes, workflow barriers, workers, tools, evidence,
 * warm leases, reuse, and terminal/archive state.
 */

export const AGI_WORKFLOW_RECENT_AGENT_LIMIT = 12;

export type AGIWorkflowRoute = "pending" | "solo" | "workflow";

export type AGIWorkflowStatus =
  | "idle"
  | "routing"
  | "running"
  | "awaiting_input"
  | "candidate_complete"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "archived";

export type AGIWorkflowArchiveState = "live" | "terminal" | "archived";

export type AGIWorkflowNodeStatus =
  | "queued"
  | "routing"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "skipped"
  | "awaiting_input"
  | "archived";

export type AGIWorkflowBarrierStatus =
  | "idle"
  | "waiting"
  | "running"
  | "released"
  | "failed";

export type AGIWorkflowAgentStatus =
  | "queued"
  | "queued_for_model"
  | "leased"
  | "spawning"
  | "running"
  | "waiting_input"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost"
  | "skipped"
  | "unstarted"
  | "released"
  | "warm_idle"
  | "evicted"
  | "archived";

export interface AGIWorkflowNode {
  id: string;
  index: number;
  title: string;
  status: AGIWorkflowNodeStatus;
  route: AGIWorkflowRoute;
  evidenceSummary: string;
  startedAt: string;
  endedAt: string;
}

export interface AGIWorkflowBarrier {
  stage: number;
  status: AGIWorkflowBarrierStatus;
  completed: number;
  total: number;
  label: string;
}

export interface AGIWorkflowNestedState {
  id: string;
  pattern: string;
  status: AGIWorkflowStatus;
  currentStage: number;
  maxStages: number;
  barrier: AGIWorkflowBarrier;
  evidenceSummary: string;
  startedAt: string;
  endedAt: string;
}

export interface AGIWorkflowAgent {
  key: string;
  id: string;
  leaseId: string;
  workerId: string;
  name: string;
  role: string;
  nodeId: string;
  stage: number;
  status: AGIWorkflowAgentStatus;
  progress: string;
  currentTool: string;
  currentStatus: string;
  evidenceSummary: string;
  reuseCount: number;
  reuseReason: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string;
}

export interface AGIWorkflowWarmLease {
  key: string;
  leaseId: string;
  workerId: string;
  name: string;
  role: string;
  nodeId: string;
  stage: number;
  reuseCount: number;
  reuseReason: string;
  updatedAt: string;
}

export interface AGIWorkflowArchivedAgent extends AGIWorkflowAgent {
  archiveId: string;
  archivedAt: string;
  archiveReason: string;
}

export interface AGIWorkflowState {
  schemaVersion: 1;
  active: boolean;
  runId: string;
  status: AGIWorkflowStatus;
  route: AGIWorkflowRoute;
  routeReason: string;
  currentNode: AGIWorkflowNode | null;
  workflow: AGIWorkflowNestedState | null;
  activeAgents: AGIWorkflowAgent[];
  warmIdleLeases: AGIWorkflowWarmLease[];
  warmPoolSize: number;
  reuseCount: number;
  lastReuseReason: string;
  recentAgents: AGIWorkflowArchivedAgent[];
  archivedAgentCount: number;
  archiveState: AGIWorkflowArchiveState;
  terminal: boolean;
  terminalStatus: AGIWorkflowStatus | "";
  terminalReason: string;
  endedAt: string;
  candidateOnly: true;
  canClaimAGI: false;
}

export const EMPTY_AGI_WORKFLOW_STATE: AGIWorkflowState = {
  schemaVersion: 1,
  active: false,
  runId: "",
  status: "idle",
  route: "pending",
  routeReason: "",
  currentNode: null,
  workflow: null,
  activeAgents: [],
  warmIdleLeases: [],
  warmPoolSize: 0,
  reuseCount: 0,
  lastReuseReason: "",
  recentAgents: [],
  archivedAgentCount: 0,
  archiveState: "live",
  terminal: false,
  terminalStatus: "",
  terminalReason: "",
  endedAt: "",
  candidateOnly: true,
  canClaimAGI: false,
};

export type AGIWorkflowEvent = { type: string } & Record<string, unknown>;

export interface AGIWorkflowCompactSummary {
  title: string;
  status: string;
  node: string;
  route: string;
  workflow: string;
  agents: string;
  leases: string;
  reuse: string;
  terminal: string;
  safety: string;
  lines: string[];
}

export type AGIWorkflowDetailRowKind =
  | "run"
  | "node"
  | "route"
  | "workflow"
  | "barrier"
  | "agent"
  | "lease"
  | "archive"
  | "terminal"
  | "safety";

export interface AGIWorkflowDetailRow {
  id: string;
  kind: AGIWorkflowDetailRowKind;
  label: string;
  status: string;
  detail: string;
  progress?: string;
  tool?: string;
  currentStatus?: string;
  evidenceSummary?: string;
  archived?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function eventData(event: AGIWorkflowEvent): Record<string, unknown> {
  return {
    ...record(event.payload),
    ...event,
    type: event.type,
  };
}

function safeText(value: unknown, max = 240): string {
  if (
    value == null
    || (typeof value !== "string"
      && typeof value !== "number"
      && typeof value !== "boolean")
  ) {
    return "";
  }
  const compact = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(
      /\b(secret|token|password|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .trim();
  return compact.length <= max
    ? compact
    : `${compact.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function firstText(
  source: Record<string, unknown>,
  keys: readonly string[],
  max = 240,
): string {
  for (const key of keys) {
    const value = safeText(source[key], max);
    if (value) return value;
  }
  return "";
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function firstInteger(
  source: Record<string, unknown>,
  keys: readonly string[],
  fallback = 0,
): number {
  for (const key of keys) {
    if (source[key] == null || source[key] === "") continue;
    const parsed = Number(source[key]);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return fallback;
}

function timestamp(source: Record<string, unknown>, fallback = ""): string {
  return firstText(
    source,
    [
      "timestamp",
      "ts",
      "at",
      "updatedAt",
      "endedAt",
      "startedAt",
      "requestedAt",
      "evictedAt",
    ],
    80,
  ) || fallback;
}

function evidenceSummary(source: Record<string, unknown>): string {
  const direct = firstText(source, [
    "evidenceSummary",
    "evidence_summary",
    "verificationSummary",
    "verification_summary",
    "resultSummary",
    "result_summary",
  ]);
  if (direct) return direct;
  const evidence = record(source.evidence);
  return firstText(evidence, ["summary", "status", "verdict"]);
}

function workflowRoute(
  source: Record<string, unknown>,
  fallback: AGIWorkflowRoute = "pending",
): AGIWorkflowRoute {
  if (
    source.workflowSelected === true
    || source.selectedWorkflow === true
    || source.useWorkflow === true
    || source.selected === true
  ) {
    return "workflow";
  }
  if (
    source.soloSelected === true
    || source.selectedSolo === true
    || source.useWorkflow === false
    || source.selected === false
  ) {
    return "solo";
  }
  const value = firstText(
    source,
    ["execution", "route", "choice", "selectedRoute", "selected_route", "mode"],
    40,
  ).toLowerCase().replaceAll("-", "_");
  if (["workflow", "multi_agent", "dynamic_workflow", "team"].includes(value)) {
    return "workflow";
  }
  if (["solo", "single", "single_pass", "direct", "simple", "agent"].includes(value)) {
    return "solo";
  }
  return fallback;
}

function workflowStatus(
  value: unknown,
  fallback: AGIWorkflowStatus,
): AGIWorkflowStatus {
  const normalized = safeText(value, 60).toLowerCase().replaceAll("-", "_");
  const aliases: Record<string, AGIWorkflowStatus> = {
    complete: "succeeded",
    completed: "succeeded",
    success: "succeeded",
    achieved: "succeeded",
    error: "failed",
    canceled: "cancelled",
    awaiting_user_input: "awaiting_input",
  };
  const candidate = aliases[normalized] || normalized;
  const known: AGIWorkflowStatus[] = [
    "idle",
    "routing",
    "running",
    "awaiting_input",
    "candidate_complete",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "archived",
  ];
  return known.includes(candidate as AGIWorkflowStatus)
    ? candidate as AGIWorkflowStatus
    : fallback;
}

function nodeStatus(
  value: unknown,
  fallback: AGIWorkflowNodeStatus,
): AGIWorkflowNodeStatus {
  const normalized = safeText(value, 60).toLowerCase().replaceAll("-", "_");
  const aliases: Record<string, AGIWorkflowNodeStatus> = {
    complete: "succeeded",
    completed: "succeeded",
    success: "succeeded",
    error: "failed",
    canceled: "cancelled",
    awaiting_user_input: "awaiting_input",
  };
  const candidate = aliases[normalized] || normalized;
  const known: AGIWorkflowNodeStatus[] = [
    "queued",
    "routing",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "skipped",
    "awaiting_input",
    "archived",
  ];
  return known.includes(candidate as AGIWorkflowNodeStatus)
    ? candidate as AGIWorkflowNodeStatus
    : fallback;
}

function agentStatus(
  value: unknown,
  fallback: AGIWorkflowAgentStatus = "unstarted",
): AGIWorkflowAgentStatus {
  const normalized = safeText(value, 60).toLowerCase().replaceAll("-", "_");
  if (
    !normalized
    || normalized === "unknown"
    || normalized === "never_started"
    || normalized === "not_started"
  ) {
    return "unstarted";
  }
  const aliases: Record<string, AGIWorkflowAgentStatus> = {
    active: "running",
    working: "running",
    waiting: "waiting_input",
    complete: "succeeded",
    completed: "succeeded",
    success: "succeeded",
    error: "failed",
    canceled: "cancelled",
    warm: "warm_idle",
    idle_warm: "warm_idle",
  };
  const candidate = aliases[normalized] || normalized;
  const known: AGIWorkflowAgentStatus[] = [
    "queued",
    "queued_for_model",
    "leased",
    "spawning",
    "running",
    "waiting_input",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "lost",
    "skipped",
    "unstarted",
    "released",
    "warm_idle",
    "evicted",
    "archived",
  ];
  return known.includes(candidate as AGIWorkflowAgentStatus)
    ? candidate as AGIWorkflowAgentStatus
    : "unstarted";
}

function barrierStatus(
  value: unknown,
  fallback: AGIWorkflowBarrierStatus,
): AGIWorkflowBarrierStatus {
  const normalized = safeText(value, 60).toLowerCase().replaceAll("-", "_");
  const aliases: Record<string, AGIWorkflowBarrierStatus> = {
    blocked: "waiting",
    open: "released",
    complete: "released",
    completed: "released",
    succeeded: "released",
  };
  const candidate = aliases[normalized] || normalized;
  const known: AGIWorkflowBarrierStatus[] = [
    "idle",
    "waiting",
    "running",
    "released",
    "failed",
  ];
  return known.includes(candidate as AGIWorkflowBarrierStatus)
    ? candidate as AGIWorkflowBarrierStatus
    : fallback;
}

function isTerminalAgentStatus(status: AGIWorkflowAgentStatus): boolean {
  return [
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "lost",
    "skipped",
    "released",
    "evicted",
    "archived",
  ].includes(status);
}

function agentKey(source: Record<string, unknown>, fallbackName: string): string {
  return (
    firstText(
      source,
      [
        "leaseId",
        "lease_id",
        "agentId",
        "agent_id",
        "logicalAgentId",
        "logical_agent_id",
        "workerId",
        "worker_id",
        "runtimeId",
        "runtime_id",
        "id",
      ],
      120,
    )
    || fallbackName
  );
}

function parseAgent(
  raw: unknown,
  context: {
    nodeId: string;
    stage: number;
    timestamp: string;
    fallbackStatus?: AGIWorkflowAgentStatus;
  },
): AGIWorkflowAgent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const leaseId = firstText(source, ["leaseId", "lease_id"], 120);
  const workerId = firstText(
    source,
    ["workerId", "worker_id", "runtimeId", "runtime_id"],
    120,
  );
  const id = firstText(
    source,
    ["agentId", "agent_id", "logicalAgentId", "logical_agent_id", "id"],
    120,
  );
  const name = firstText(
    source,
    [
      "name",
      "agentName",
      "agent_name",
      "workerName",
      "worker_name",
      "logicalAgentId",
      "logical_agent_id",
      "role",
    ],
    120,
  ) || workerId || id || leaseId;
  if (!name) return null;
  const status = agentStatus(
    source.status
      ?? source.state
      ?? source.leaseStatus
      ?? source.lease_state
      ?? source.runtimeState
      ?? source.runtime_state,
    context.fallbackStatus || "unstarted",
  );
  const nodeId = firstText(source, ["nodeId", "node_id"], 120) || context.nodeId;
  const stage = firstInteger(source, ["stage", "workflowStage", "workflow_stage"], context.stage);
  const updatedAt = timestamp(source, context.timestamp);
  return {
    key: agentKey(source, `${nodeId}:${stage}:${name}`),
    id,
    leaseId,
    workerId,
    name,
    role: firstText(source, ["role", "persona", "personaId", "persona_id"], 120),
    nodeId,
    stage,
    status,
    progress: firstText(source, ["progress", "progressLabel", "progress_label"]),
    currentTool: firstText(source, ["currentTool", "current_tool", "tool", "toolName", "tool_name"], 120),
    currentStatus: firstText(
      source,
      ["currentStatus", "current_status", "statusLabel", "status_label"],
    ),
    evidenceSummary: evidenceSummary(source),
    reuseCount: firstInteger(source, ["reuseCount", "reuse_count"], 0),
    reuseReason: firstText(source, ["reuseReason", "reuse_reason"], 180),
    startedAt: firstText(source, ["startedAt", "started_at"], 80) || updatedAt,
    updatedAt,
    endedAt: firstText(source, ["endedAt", "ended_at"], 80),
  };
}

function parseAgents(
  raw: unknown,
  context: Parameters<typeof parseAgent>[1],
): AGIWorkflowAgent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const agent = parseAgent(item, context);
    return agent ? [agent] : [];
  });
}

function mergeAgent(previous: AGIWorkflowAgent | undefined, next: AGIWorkflowAgent): AGIWorkflowAgent {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    id: next.id || previous.id,
    leaseId: next.leaseId || previous.leaseId,
    workerId: next.workerId || previous.workerId,
    name: next.name || previous.name,
    role: next.role || previous.role,
    nodeId: next.nodeId || previous.nodeId,
    progress: next.progress || previous.progress,
    currentTool: next.currentTool || previous.currentTool,
    currentStatus: next.currentStatus || previous.currentStatus,
    evidenceSummary: next.evidenceSummary || previous.evidenceSummary,
    reuseCount: Math.max(previous.reuseCount, next.reuseCount),
    reuseReason: next.reuseReason || previous.reuseReason,
    startedAt: previous.startedAt || next.startedAt,
    updatedAt: next.updatedAt || previous.updatedAt,
    endedAt: next.endedAt || previous.endedAt,
  };
}

function upsertAgent(
  agents: readonly AGIWorkflowAgent[],
  next: AGIWorkflowAgent,
): AGIWorkflowAgent[] {
  const index = agents.findIndex((agent) => agent.key === next.key);
  if (index < 0) return [...agents, next];
  const copy = [...agents];
  copy[index] = mergeAgent(copy[index], next);
  return copy;
}

function mergeAgentSnapshot(
  current: readonly AGIWorkflowAgent[],
  incoming: readonly AGIWorkflowAgent[],
): AGIWorkflowAgent[] {
  let merged = current.slice();
  for (const agent of incoming) merged = upsertAgent(merged, agent);
  return merged;
}

function warmLeaseFromAgent(agent: AGIWorkflowAgent): AGIWorkflowWarmLease {
  return {
    key: agent.key,
    leaseId: agent.leaseId,
    workerId: agent.workerId,
    name: agent.name,
    role: agent.role,
    nodeId: agent.nodeId,
    stage: agent.stage,
    reuseCount: agent.reuseCount,
    reuseReason: agent.reuseReason,
    updatedAt: agent.updatedAt,
  };
}

function upsertWarmLease(
  leases: readonly AGIWorkflowWarmLease[],
  next: AGIWorkflowWarmLease,
): AGIWorkflowWarmLease[] {
  const index = leases.findIndex((lease) => lease.key === next.key);
  if (index < 0) return [...leases, next];
  const copy = [...leases];
  copy[index] = {
    ...copy[index],
    ...next,
    leaseId: next.leaseId || copy[index].leaseId,
    workerId: next.workerId || copy[index].workerId,
    name: next.name || copy[index].name,
    role: next.role || copy[index].role,
    nodeId: next.nodeId || copy[index].nodeId,
    reuseCount: Math.max(copy[index].reuseCount, next.reuseCount),
    reuseReason: next.reuseReason || copy[index].reuseReason,
    updatedAt: next.updatedAt || copy[index].updatedAt,
  };
  return copy;
}

function archiveId(agent: AGIWorkflowAgent): string {
  return `${agent.nodeId}:${agent.stage}:${agent.key}`;
}

function archiveAgents(
  state: AGIWorkflowState,
  agents: readonly AGIWorkflowAgent[],
  options: {
    at: string;
    reason: string;
    defaultStatus?: AGIWorkflowAgentStatus;
  },
): Pick<AGIWorkflowState, "recentAgents" | "archivedAgentCount"> {
  if (agents.length === 0) {
    return {
      recentAgents: state.recentAgents,
      archivedAgentCount: state.archivedAgentCount,
    };
  }
  let history = state.recentAgents.slice();
  let added = 0;
  for (const raw of agents) {
    const status = isTerminalAgentStatus(raw.status)
      ? raw.status
      : options.defaultStatus || "archived";
    const archived: AGIWorkflowArchivedAgent = {
      ...raw,
      status,
      endedAt: raw.endedAt || options.at,
      archiveId: archiveId(raw),
      archivedAt: options.at || raw.updatedAt || raw.endedAt,
      archiveReason: options.reason,
    };
    const existing = history.findIndex((item) => item.archiveId === archived.archiveId);
    if (existing >= 0) {
      history.splice(existing, 1);
    } else {
      added += 1;
    }
    history.unshift(archived);
  }
  return {
    recentAgents: history.slice(0, AGI_WORKFLOW_RECENT_AGENT_LIMIT),
    archivedAgentCount: state.archivedAgentCount + added,
  };
}

function nodeSource(data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, ...record(data.node) };
}

function workflowSource(data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, ...record(data.workflow) };
}

function leaseSource(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    ...record(data.worker),
    ...record(data.agent),
    ...record(data.lease),
  };
}

function eventAgentArray(data: Record<string, unknown>): unknown {
  if (Array.isArray(data.agents)) return data.agents;
  if (Array.isArray(data.workers)) return data.workers;
  if (Array.isArray(data.leases)) return data.leases;
  if (Array.isArray(data.warmLeases)) return data.warmLeases;
  if (Array.isArray(data.warm_leases)) return data.warm_leases;
  return [];
}

function parseNode(
  data: Record<string, unknown>,
  previous: AGIWorkflowNode | null,
  fallbackStatus: AGIWorkflowNodeStatus,
): AGIWorkflowNode {
  const source = nodeSource(data);
  const index = firstInteger(source, ["index", "nodeIndex", "node_index"], previous?.index || 0);
  const id = firstText(source, ["nodeId", "node_id", "id", "phase"], 120)
    || previous?.id
    || (index > 0 ? `node-${index}` : "node");
  return {
    id,
    index,
    title:
      firstText(source, ["title", "name", "label", "phase", "nodeType", "node_type"], 160)
      || previous?.title
      || id,
    status: nodeStatus(source.status ?? source.state, fallbackStatus),
    route: workflowRoute(source, previous?.route || "pending"),
    evidenceSummary: evidenceSummary(source) || previous?.evidenceSummary || "",
    startedAt:
      firstText(source, ["startedAt", "started_at"], 80)
      || previous?.startedAt
      || timestamp(source),
    endedAt: firstText(source, ["endedAt", "ended_at"], 80) || previous?.endedAt || "",
  };
}

function parseBarrier(
  source: Record<string, unknown>,
  previous: AGIWorkflowBarrier | null,
  fallbackStatus: AGIWorkflowBarrierStatus,
): AGIWorkflowBarrier {
  const barrier = { ...source, ...record(source.barrier) };
  return {
    stage: firstInteger(
      barrier,
      ["stage", "currentStage", "current_stage", "workflowStage", "workflow_stage"],
      previous?.stage || 0,
    ),
    status: barrierStatus(
      barrier.barrierStatus ?? barrier.barrier_status ?? barrier.status,
      fallbackStatus,
    ),
    completed: firstInteger(
      barrier,
      ["completed", "completedAgents", "completed_agents", "done"],
      previous?.completed || 0,
    ),
    total: firstInteger(
      barrier,
      ["total", "totalAgents", "total_agents", "expected"],
      previous?.total || 0,
    ),
    label:
      firstText(barrier, ["barrierLabel", "barrier_label", "label"], 160)
      || previous?.label
      || "",
  };
}

function parseWorkflow(
  data: Record<string, unknown>,
  previous: AGIWorkflowNestedState | null,
  fallbackStatus: AGIWorkflowStatus,
  fallbackBarrierStatus: AGIWorkflowBarrierStatus,
): AGIWorkflowNestedState {
  const source = workflowSource(data);
  const barrier = parseBarrier(source, previous?.barrier || null, fallbackBarrierStatus);
  return {
    id:
      firstText(source, ["workflowId", "workflow_id", "id"], 120)
      || previous?.id
      || "workflow",
    pattern:
      firstText(source, ["pattern", "workflowPattern", "workflow_pattern"], 160)
      || previous?.pattern
      || "adaptive",
    status: workflowStatus(source.status ?? source.state, fallbackStatus),
    currentStage: firstInteger(
      source,
      ["currentStage", "current_stage", "stage", "workflowStage", "workflow_stage"],
      previous?.currentStage || barrier.stage,
    ),
    maxStages: firstInteger(
      source,
      ["maxStages", "max_stages"],
      previous?.maxStages || 0,
    ),
    barrier,
    evidenceSummary: evidenceSummary(source) || previous?.evidenceSummary || "",
    startedAt:
      firstText(source, ["startedAt", "started_at"], 80)
      || previous?.startedAt
      || timestamp(source),
    endedAt: firstText(source, ["endedAt", "ended_at"], 80) || previous?.endedAt || "",
  };
}

function withSafety(state: AGIWorkflowState): AGIWorkflowState {
  return {
    ...state,
    candidateOnly: true,
    canClaimAGI: false,
  };
}

function terminalAgentFallback(data: Record<string, unknown>): AGIWorkflowAgentStatus {
  if (data.ok === false) return "failed";
  const status = workflowStatus(data.status ?? data.state, "succeeded");
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted") return "cancelled";
  return "succeeded";
}

function reuseUpdate(
  state: AGIWorkflowState,
  previous: AGIWorkflowAgent | undefined,
  next: AGIWorkflowAgent,
  data: Record<string, unknown>,
): Pick<AGIWorkflowState, "reuseCount" | "lastReuseReason"> {
  const explicitlyReused =
    data.reused === true
    || data.reuse === true
    || data.allowed === true
    || data.directContinuation === true
    || data.direct_continuation === true
    || safeText(data.action, 40).toLowerCase() === "reuse";
  const reportedTotal = firstInteger(
    data,
    ["totalReuseCount", "total_reuse_count"],
    state.reuseCount,
  );
  const previousCount = previous?.reuseCount || 0;
  const inferredCount = next.reuseCount > 0
    ? next.reuseCount
    : previousCount + (explicitlyReused ? 1 : 0);
  next.reuseCount = Math.max(previousCount, inferredCount);
  const delta = Math.max(0, next.reuseCount - previousCount);
  const reason =
    firstText(data, ["reuseReason", "reuse_reason", "reason"], 180)
    || next.reuseReason;
  if (reason) next.reuseReason = reason;
  return {
    reuseCount: Math.max(reportedTotal, state.reuseCount + delta),
    lastReuseReason: reason || state.lastReuseReason,
  };
}

export function agiWorkflowReducer(
  state: AGIWorkflowState,
  event: AGIWorkflowEvent,
): AGIWorkflowState {
  const data = eventData(event);
  const at = timestamp(data);
  const incomingRunId = firstText(
    data,
    ["runId", "run_id", "agiRunId", "agi_run_id"],
    120,
  );
  if (
    event.type !== "agi_workflow_start"
    && state.runId
    && incomingRunId
    && incomingRunId !== state.runId
  ) {
    return withSafety(state);
  }
  if (event.type !== "agi_workflow_start" && state.terminal) {
    // A terminal receipt is an immutable latch for its run. Late provider,
    // lease, node, or warm-pool events must not resurrect completed UI state.
    return withSafety(state);
  }
  switch (event.type) {
    case "agi_workflow_start": {
      if (
        state.terminal
        && state.runId
        && incomingRunId
        && incomingRunId === state.runId
      ) {
        return withSafety(state);
      }
      const currentNode = Object.keys(record(data.node)).length > 0
        ? parseNode(data, null, "queued")
        : null;
      return withSafety({
        ...EMPTY_AGI_WORKFLOW_STATE,
        active: true,
        runId: firstText(data, ["runId", "run_id", "agiRunId", "agi_run_id"], 120),
        status: "running",
        route: workflowRoute(data),
        routeReason: firstText(data, ["routeReason", "route_reason", "reason"], 180),
        currentNode,
      });
    }
    case "agi_workflow_route": {
      const route = workflowRoute(data, state.route);
      const currentNode = state.currentNode
        ? {
            ...state.currentNode,
            route,
            status: state.currentNode.status === "queued"
              ? "routing" as AGIWorkflowNodeStatus
              : state.currentNode.status,
          }
        : null;
      return withSafety({
        ...state,
        active: state.terminal ? state.active : true,
        status: state.terminal ? state.status : "routing",
        route,
        routeReason: firstText(data, ["routeReason", "route_reason", "reason"], 180)
          || state.routeReason,
        currentNode,
      });
    }
    case "agi_workflow_node_start": {
      const archived = archiveAgents(state, state.activeAgents, {
        at,
        reason: "node advanced",
        defaultStatus: "archived",
      });
      const currentNode = parseNode(data, null, "running");
      return withSafety({
        ...state,
        ...archived,
        active: true,
        status: "running",
        route: currentNode.route,
        routeReason: firstText(data, ["routeReason", "route_reason"], 180),
        currentNode,
        workflow: null,
        activeAgents: [],
        archiveState: "live",
        terminal: false,
        terminalStatus: "",
        terminalReason: "",
        endedAt: "",
      });
    }
    case "agi_workflow_node_end": {
      const finalAgents = mergeAgentSnapshot(
        state.activeAgents,
        parseAgents(eventAgentArray(data), {
          nodeId: state.currentNode?.id || "",
          stage: state.workflow?.currentStage || 0,
          timestamp: at,
          fallbackStatus: terminalAgentFallback(data),
        }),
      );
      const archived = archiveAgents(state, finalAgents, {
        at,
        reason: "node completed",
        defaultStatus: terminalAgentFallback(data),
      });
      const currentNode = parseNode(
        data,
        state.currentNode,
        data.ok === false ? "failed" : "succeeded",
      );
      return withSafety({
        ...state,
        ...archived,
        active: true,
        status: "running",
        route: currentNode.route,
        currentNode: {
          ...currentNode,
          endedAt: currentNode.endedAt || at,
        },
        workflow: state.workflow
          ? {
              ...state.workflow,
              status: workflowStatus(
                data.workflowStatus ?? data.workflow_status,
                state.workflow.status,
              ),
              endedAt: state.workflow.endedAt || at,
            }
          : null,
        activeAgents: [],
      });
    }
    case "agi_workflow_workflow_start": {
      const workflow = parseWorkflow(data, state.workflow, "running", "waiting");
      const agents = parseAgents(eventAgentArray(data), {
        nodeId: state.currentNode?.id || "",
        stage: workflow.currentStage,
        timestamp: at,
        fallbackStatus: "unstarted",
      }).filter((agent) => !isTerminalAgentStatus(agent.status) && agent.status !== "warm_idle");
      return withSafety({
        ...state,
        active: true,
        status: "running",
        route: "workflow",
        currentNode: state.currentNode
          ? { ...state.currentNode, route: "workflow", status: "running" }
          : state.currentNode,
        workflow,
        activeAgents: agents,
      });
    }
    case "agi_workflow_workflow_end": {
      const finalAgents = mergeAgentSnapshot(
        state.activeAgents,
        parseAgents(eventAgentArray(data), {
          nodeId: state.currentNode?.id || "",
          stage: state.workflow?.currentStage || 0,
          timestamp: at,
          fallbackStatus: terminalAgentFallback(data),
        }),
      );
      const archived = archiveAgents(state, finalAgents, {
        at,
        reason: "workflow completed",
        defaultStatus: terminalAgentFallback(data),
      });
      const workflow = parseWorkflow(
        data,
        state.workflow,
        data.ok === false ? "failed" : "succeeded",
        data.ok === false ? "failed" : "released",
      );
      return withSafety({
        ...state,
        ...archived,
        active: true,
        status: "running",
        route: "workflow",
        workflow: {
          ...workflow,
          endedAt: workflow.endedAt || at,
          barrier: {
            ...workflow.barrier,
            status: data.ok === false ? "failed" : "released",
          },
        },
        activeAgents: [],
      });
    }
    case "agi_workflow_worker_lease": {
      if (data.allowed === false) {
        return withSafety({
          ...state,
          lastReuseReason:
            firstText(data, ["reuseReason", "reuse_reason", "reason"], 180)
            || state.lastReuseReason,
        });
      }
      const source = leaseSource(data);
      const parsed = parseAgent(source, {
        nodeId: state.currentNode?.id || "",
        stage: state.workflow?.currentStage || 0,
        timestamp: at,
        fallbackStatus: "leased",
      });
      if (!parsed) {
        return withSafety({
          ...state,
          lastReuseReason:
            firstText(data, ["reuseReason", "reuse_reason", "reason"], 180)
            || state.lastReuseReason,
        });
      }
      const previous = state.activeAgents.find((agent) => agent.key === parsed.key);
      const next = mergeAgent(previous, parsed);
      const reuse = reuseUpdate(state, previous, next, data);
      const warmIdle =
        next.status === "warm_idle"
        || source.warmIdle === true
        || source.warm_idle === true;
      const evicted =
        next.status === "evicted"
        || safeText(source.action, 40).toLowerCase() === "evicted";
      const terminal = isTerminalAgentStatus(next.status);
      if (warmIdle) {
        const warmIdleLeases = upsertWarmLease(
          state.warmIdleLeases.filter((lease) => lease.key !== next.key),
          warmLeaseFromAgent({ ...next, status: "warm_idle" }),
        );
        return withSafety({
          ...state,
          ...reuse,
          activeAgents: state.activeAgents.filter((agent) => agent.key !== next.key),
          warmIdleLeases,
          warmPoolSize: Math.max(warmIdleLeases.length, state.warmPoolSize),
        });
      }
      if (terminal || evicted) {
        const archived = archiveAgents(state, [{ ...next, status: evicted ? "evicted" : next.status }], {
          at,
          reason: evicted ? "lease evicted" : "lease completed",
          defaultStatus: evicted ? "evicted" : next.status,
        });
        return withSafety({
          ...state,
          ...reuse,
          ...archived,
          activeAgents: state.activeAgents.filter((agent) => agent.key !== next.key),
          warmIdleLeases: state.warmIdleLeases.filter((lease) => lease.key !== next.key),
          warmPoolSize: Math.max(
            0,
            Math.min(
              state.warmPoolSize,
              state.warmIdleLeases.filter((lease) => lease.key !== next.key).length,
            ),
          ),
        });
      }
      return withSafety({
        ...state,
        ...reuse,
        active: true,
        activeAgents: upsertAgent(state.activeAgents, next),
        warmIdleLeases: state.warmIdleLeases.filter((lease) => lease.key !== next.key),
        warmPoolSize: Math.max(
          0,
          Math.min(
            state.warmPoolSize,
            state.warmIdleLeases.filter((lease) => lease.key !== next.key).length,
          ),
        ),
      });
    }
    case "agi_workflow_warm_pool": {
      const context = {
        nodeId: state.currentNode?.id || "",
        stage: state.workflow?.currentStage || 0,
        timestamp: at,
        fallbackStatus: "warm_idle" as AGIWorkflowAgentStatus,
      };
      const rawLeases = eventAgentArray(data);
      const snapshotAgents = parseAgents(rawLeases, context);
      const single = snapshotAgents.length === 0
        ? parseAgent(leaseSource(data), context)
        : null;
      const candidates = snapshotAgents.length > 0
        ? snapshotAgents
        : single
          ? [single]
          : [];
      const hasSnapshot =
        Array.isArray(data.leases)
        || Array.isArray(data.workers)
        || Array.isArray(data.agents)
        || Array.isArray(data.warmLeases)
        || Array.isArray(data.warm_leases);
      let warmIdleLeases = hasSnapshot ? [] : state.warmIdleLeases.slice();
      let reuseCount = state.reuseCount;
      let lastReuseReason = state.lastReuseReason;
      for (const candidate of candidates) {
        if (candidate.status === "evicted") continue;
        const warm = warmLeaseFromAgent({ ...candidate, status: "warm_idle" });
        warmIdleLeases = upsertWarmLease(warmIdleLeases, warm);
        reuseCount = Math.max(reuseCount, candidate.reuseCount);
        lastReuseReason = candidate.reuseReason || lastReuseReason;
      }
      const reportedSize = firstInteger(
        data,
        ["warmIdle", "warm_idle", "size", "count", "poolSize", "pool_size"],
        warmIdleLeases.length,
      );
      const warmKeys = new Set(warmIdleLeases.map((lease) => lease.key));
      return withSafety({
        ...state,
        warmIdleLeases,
        warmPoolSize: Math.max(warmIdleLeases.length, reportedSize),
        activeAgents: state.activeAgents.filter((agent) => !warmKeys.has(agent.key)),
        reuseCount: Math.max(
          reuseCount,
          firstInteger(data, ["totalReuseCount", "total_reuse_count"], reuseCount),
        ),
        lastReuseReason:
          firstText(data, ["reuseReason", "reuse_reason", "reason"], 180)
          || lastReuseReason,
      });
    }
    case "agi_workflow_evicted": {
      const source = leaseSource(data);
      const parsed = parseAgent(source, {
        nodeId: state.currentNode?.id || "",
        stage: state.workflow?.currentStage || 0,
        timestamp: at,
        fallbackStatus: "evicted",
      });
      const key = parsed?.key || agentKey(source, "");
      if (!key) return withSafety(state);
      const active = state.activeAgents.find((agent) => agent.key === key);
      const warm = state.warmIdleLeases.find((lease) => lease.key === key);
      const evictedAgent = active
        ? { ...active, ...parsed, status: "evicted" as AGIWorkflowAgentStatus }
        : parsed
          ? { ...parsed, status: "evicted" as AGIWorkflowAgentStatus }
          : warm
            ? {
                key: warm.key,
                id: "",
                leaseId: warm.leaseId,
                workerId: warm.workerId,
                name: warm.name,
                role: warm.role,
                nodeId: warm.nodeId,
                stage: warm.stage,
                status: "evicted" as AGIWorkflowAgentStatus,
                progress: "",
                currentTool: "",
                currentStatus: "evicted from warm pool",
                evidenceSummary: evidenceSummary(source),
                reuseCount: warm.reuseCount,
                reuseReason: warm.reuseReason,
                startedAt: "",
                updatedAt: at || warm.updatedAt,
                endedAt: at,
              }
            : null;
      const archived = evictedAgent
        ? archiveAgents(state, [evictedAgent], {
            at,
            reason: firstText(data, ["evictionReason", "eviction_reason", "reason"], 180)
              || "warm lease evicted",
            defaultStatus: "evicted",
          })
        : {
            recentAgents: state.recentAgents,
            archivedAgentCount: state.archivedAgentCount,
          };
      const warmIdleLeases = state.warmIdleLeases.filter((lease) => lease.key !== key);
      return withSafety({
        ...state,
        ...archived,
        activeAgents: state.activeAgents.filter((agent) => agent.key !== key),
        warmIdleLeases,
        warmPoolSize: Math.max(0, Math.min(state.warmPoolSize - 1, warmIdleLeases.length)),
      });
    }
    case "agi_workflow_end": {
      const finalAgents = mergeAgentSnapshot(
        state.activeAgents,
        parseAgents(eventAgentArray(data), {
          nodeId: state.currentNode?.id || "",
          stage: state.workflow?.currentStage || 0,
          timestamp: at,
          fallbackStatus: terminalAgentFallback(data),
        }),
      );
      const archived = archiveAgents(state, finalAgents, {
        at,
        reason: "AGI workflow ended",
        defaultStatus: terminalAgentFallback(data),
      });
      const terminalStatus = workflowStatus(
        data.status ?? data.state,
        data.ok === false ? "failed" : "succeeded",
      );
      const explicitlyArchived =
        data.archived === true
        || safeText(data.archiveState ?? data.archive_state, 40).toLowerCase() === "archived"
        || terminalStatus === "archived";
      const terminalNodeStatus: AGIWorkflowNodeStatus =
        terminalStatus === "failed"
          ? "failed"
          : terminalStatus === "cancelled"
            ? "cancelled"
            : terminalStatus === "interrupted"
              ? "interrupted"
              : terminalStatus === "awaiting_input"
                ? "awaiting_input"
                : terminalStatus === "archived"
                  ? "archived"
                  : "succeeded";
      const terminalWorkflowStatus: AGIWorkflowStatus =
        terminalStatus === "failed"
        || terminalStatus === "cancelled"
        || terminalStatus === "interrupted"
        || terminalStatus === "awaiting_input"
        || terminalStatus === "archived"
          ? terminalStatus
          : workflowStatus(
              data.workflowStatus ?? data.workflow_status,
              terminalStatus,
            );
      return withSafety({
        ...state,
        ...archived,
        active: false,
        status: explicitlyArchived ? "archived" : terminalStatus,
        activeAgents: [],
        archiveState: explicitlyArchived ? "archived" : "terminal",
        terminal: true,
        terminalStatus,
        terminalReason: firstText(data, ["terminalReason", "terminal_reason", "reason"], 200),
        endedAt: at,
        currentNode: state.currentNode
          ? {
              ...state.currentNode,
              status: nodeStatus(
                data.nodeStatus ?? data.node_status,
                terminalNodeStatus,
              ),
              endedAt: state.currentNode.endedAt || at,
              evidenceSummary: evidenceSummary(nodeSource(data))
                || state.currentNode.evidenceSummary,
            }
          : null,
        workflow: state.workflow
          ? {
              ...state.workflow,
              status: terminalWorkflowStatus,
              endedAt: state.workflow.endedAt || at,
            }
          : null,
      });
    }
    default:
      return withSafety(state);
  }
}

function displayStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function stageLabel(workflow: AGIWorkflowNestedState | null): string {
  if (!workflow) return "";
  const stage = workflow.currentStage > 0 ? `stage ${workflow.currentStage}` : "stage pending";
  const max = workflow.maxStages > 0 ? `/${workflow.maxStages}` : "";
  return `${stage}${max} · barrier ${displayStatus(workflow.barrier.status)}`;
}

export function selectAGIWorkflowCompactSummary(
  state: AGIWorkflowState,
): AGIWorkflowCompactSummary {
  const node = state.currentNode
    ? [
        state.currentNode.index > 0 ? `node ${state.currentNode.index}` : "node",
        state.currentNode.title,
        displayStatus(state.currentNode.status),
      ].filter(Boolean).join(" · ")
    : "node pending";
  const route = state.route === "pending"
    ? "route pending"
    : `route ${state.route}`;
  const workflow = state.workflow
    ? [
        state.workflow.pattern || "workflow",
        stageLabel(state.workflow),
      ].filter(Boolean).join(" · ")
    : state.route === "solo"
      ? "solo execution"
      : "workflow pending";
  const agents = state.activeAgents.length === 1
    ? `1 active agent`
    : `${state.activeAgents.length} active agents`;
  const leases = state.warmPoolSize === 1
    ? "1 warm-idle lease"
    : `${state.warmPoolSize} warm-idle leases`;
  const reuse = state.reuseCount > 0
    ? `${state.reuseCount} reuse${state.reuseCount === 1 ? "" : "s"}${
        state.lastReuseReason ? ` · ${state.lastReuseReason}` : ""
      }`
    : "no worker reuse";
  const terminal = state.terminal
    ? `${state.archiveState} · ${displayStatus(state.terminalStatus || state.status)}`
    : state.archiveState;
  const safety = "candidateOnly:true · canClaimAGI:false";
  return {
    title: "AGI workflow",
    status: displayStatus(state.status),
    node,
    route,
    workflow,
    agents,
    leases,
    reuse,
    terminal,
    safety,
    lines: [
      `${displayStatus(state.status)} · ${node}`,
      `${route} · ${workflow}`,
      `${agents} · ${leases}`,
      reuse,
      safety,
    ],
  };
}

function agentDetail(agent: AGIWorkflowAgent): string {
  return [
    agent.progress ? `progress ${agent.progress}` : "",
    agent.currentTool ? `tool ${agent.currentTool}` : "",
    agent.currentStatus ? `status ${agent.currentStatus}` : "",
    agent.evidenceSummary ? `evidence ${agent.evidenceSummary}` : "",
    agent.reuseCount > 0 ? `reused ${agent.reuseCount}x` : "",
    agent.reuseReason ? `reuse reason ${agent.reuseReason}` : "",
  ].filter(Boolean).join(" · ");
}

function agentRow(
  agent: AGIWorkflowAgent,
  kind: "agent" | "archive",
  suffix = "",
): AGIWorkflowDetailRow {
  return {
    id: `${kind}:${kind === "archive" ? archiveId(agent) : agent.key}${suffix}`,
    kind,
    label: agent.name || agent.workerId || agent.id || agent.key,
    status: displayStatus(agent.status),
    detail: agentDetail(agent),
    progress: agent.progress || undefined,
    tool: agent.currentTool || undefined,
    currentStatus: agent.currentStatus || undefined,
    evidenceSummary: agent.evidenceSummary || undefined,
    archived: kind === "archive",
  };
}

export function selectAGIWorkflowDetailRows(
  state: AGIWorkflowState,
  options: { recentLimit?: number } = {},
): AGIWorkflowDetailRow[] {
  const rows: AGIWorkflowDetailRow[] = [{
    id: "run",
    kind: "run",
    label: state.runId ? `AGI workflow · ${state.runId}` : "AGI workflow",
    status: displayStatus(state.status),
    detail: state.active ? "active" : state.archiveState,
  }];
  if (state.currentNode) {
    rows.push({
      id: `node:${state.currentNode.id}`,
      kind: "node",
      label: state.currentNode.title || state.currentNode.id,
      status: displayStatus(state.currentNode.status),
      detail: [
        state.currentNode.index > 0 ? `node ${state.currentNode.index}` : "",
        `route ${state.currentNode.route}`,
        state.currentNode.evidenceSummary
          ? `evidence ${state.currentNode.evidenceSummary}`
          : "",
      ].filter(Boolean).join(" · "),
      evidenceSummary: state.currentNode.evidenceSummary || undefined,
    });
  }
  rows.push({
    id: "route",
    kind: "route",
    label: `Route · ${state.route}`,
    status: state.route === "pending" ? "pending" : "selected",
    detail: state.routeReason,
  });
  if (state.workflow) {
    rows.push({
      id: `workflow:${state.workflow.id}`,
      kind: "workflow",
      label: state.workflow.pattern || state.workflow.id,
      status: displayStatus(state.workflow.status),
      detail: [
        state.workflow.currentStage > 0 ? `stage ${state.workflow.currentStage}` : "",
        state.workflow.maxStages > 0 ? `max ${state.workflow.maxStages}` : "",
        state.workflow.evidenceSummary
          ? `evidence ${state.workflow.evidenceSummary}`
          : "",
      ].filter(Boolean).join(" · "),
      evidenceSummary: state.workflow.evidenceSummary || undefined,
    });
    rows.push({
      id: `barrier:${state.workflow.id}:${state.workflow.barrier.stage}`,
      kind: "barrier",
      label: state.workflow.barrier.stage > 0
        ? `Stage ${state.workflow.barrier.stage} barrier`
        : "Workflow barrier",
      status: displayStatus(state.workflow.barrier.status),
      detail: [
        state.workflow.barrier.total > 0
          ? `${state.workflow.barrier.completed}/${state.workflow.barrier.total} complete`
          : "",
        state.workflow.barrier.label,
      ].filter(Boolean).join(" · "),
    });
  }
  for (const agent of state.activeAgents) rows.push(agentRow(agent, "agent"));
  for (const lease of state.warmIdleLeases) {
    rows.push({
      id: `lease:${lease.key}`,
      kind: "lease",
      label: lease.name || lease.workerId || lease.leaseId || lease.key,
      status: "warm idle",
      detail: [
        lease.reuseCount > 0 ? `reused ${lease.reuseCount}x` : "",
        lease.reuseReason ? `reason ${lease.reuseReason}` : "",
      ].filter(Boolean).join(" · "),
    });
  }
  const recentLimit = Math.max(
    0,
    Math.min(
      AGI_WORKFLOW_RECENT_AGENT_LIMIT,
      integer(options.recentLimit, AGI_WORKFLOW_RECENT_AGENT_LIMIT),
    ),
  );
  state.recentAgents.slice(0, recentLimit).forEach((agent, index) => {
    const row = agentRow(agent, "archive", `:${index}`);
    row.detail = [
      agent.nodeId ? `node ${agent.nodeId}` : "",
      agent.stage > 0 ? `stage ${agent.stage}` : "",
      row.detail,
      agent.archiveReason ? `archive ${agent.archiveReason}` : "",
    ].filter(Boolean).join(" · ");
    rows.push(row);
  });
  if (state.terminal) {
    rows.push({
      id: "terminal",
      kind: "terminal",
      label: state.archiveState === "archived" ? "Archived result" : "Terminal result",
      status: displayStatus(state.terminalStatus || state.status),
      detail: state.terminalReason,
    });
  }
  rows.push({
    id: "safety",
    kind: "safety",
    label: "Claim boundary",
    status: "candidate only",
    detail: "candidateOnly:true · canClaimAGI:false",
  });
  return rows;
}

export const agiWorkflowCompactSummary = selectAGIWorkflowCompactSummary;
export const agiWorkflowDetailedRows = selectAGIWorkflowDetailRows;
