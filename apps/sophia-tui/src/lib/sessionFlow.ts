import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BridgeEvent } from "./bridge.js";
import { sanitizeToolText } from "./toolOutput.js";

export type SessionFlowNodeKind =
  | "run"
  | "harness"
  | "goal"
  | "model"
  | "tool"
  | "agent"
  | "workflow"
  | "agi"
  | "approval"
  | "receipt"
  | "result"
  | "system";

export type SessionFlowNodeStatus =
  | "info"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type SessionFlowEdgeKind =
  | "sequence"
  | "contains"
  | "handoff";

export interface SessionFlowNodeIdentity {
  nodeId?: string;
  workflowId?: string;
  stageKey?: string;
  workerKey?: string;
  workerIndex?: string;
  agentKey?: string;
  agentId?: string;
  logicalAgentId?: string;
  workerId?: string;
  leaseId?: string;
  agentName?: string;
  taskId?: string;
}

export interface SessionFlowNodeProvenance {
  sourceNodeIds: string[];
  sourceEventTypes: string[];
  hiddenEventCount: number;
}

/**
 * Allow-listed workflow graph metadata. These fields describe durable graph
 * identity only; payloads, prompts, and artifact contents are never retained.
 */
export interface SessionFlowWorkflowMetadata {
  /** Version of the workflow event contract that supplied this metadata. */
  workflowEventVersion?: number;
  /** Monotonic lifecycle position within one stable process or join. */
  workflowEventSequence?: number;
  /** Runtime attempt observed on a process-start receipt. */
  workflowAttempt?: number;
  /** True when this semantic node was declared by a validated frozen plan. */
  workflowPlanFrozen?: true;
  /** Digest identifying the immutable frozen plan for this run. */
  planDigest?: string;
  /** Explicit terminal producer declared by the immutable frozen plan. */
  outputProcessId?: string;
  /** Stable compound-process identity, scoped to one run. */
  processId?: string;
  processLabel?: string;
  /** Stable fan-out lane identity. Parallel branches use distinct values. */
  branchId?: string;
  /** The one to three workflow members rendered inside the process frame. */
  childWorkflowIds?: string[];
  /** Cumulative serial members durably committed by a progress receipt. */
  completedChildWorkflowIds?: string[];
  /** Process or join nodes that must finish before this process may run. */
  dependsOnNodeIds?: string[];
  /** Stable all-of convergence barrier identity. */
  joinId?: string;
  /** Complete predecessor set required by the all-of barrier. */
  expectedNodeIds?: string[];
  /** Predecessors durably observed complete by the barrier. */
  completedNodeIds?: string[];
  /** Immutable artifact location carried by an output commit receipt. */
  artifactRef?: string;
  /** SHA-256 digest carried by an output commit receipt. */
  digest?: string;
  /** True only for a synthetic child block inside a compound process frame. */
  processMember?: boolean;
  /** True only for the stable semantic process parent/edge endpoint. */
  processNode?: boolean;
}

export interface SessionFlowNode extends SessionFlowWorkflowMetadata {
  id: string;
  runId: string;
  parentId: string | null;
  kind: SessionFlowNodeKind;
  status: SessionFlowNodeStatus;
  label: string;
  detail: string;
  eventType: string;
  /** Causal/topological position used by the graph layout. */
  sequence: number;
  /**
   * Latest underlying receipt position. Synthetic placeholders use null so
   * follow-live does not mistake a future causal role for observed activity.
   */
  observedSequence?: number | null;
  /** Stable semantic group for roles rendered as one run harness. */
  harnessId?: string;
  depth: number;
  timestamp: string;
  scope: string;
  /** Allow-listed runtime identity used for semantic hierarchy joins. */
  identity?: SessionFlowNodeIdentity;
  /** Folded source receipts retained by semantic projections and exports. */
  provenance?: SessionFlowNodeProvenance;
}

export interface SessionFlowEdge {
  id: string;
  source: string;
  target: string;
  kind: SessionFlowEdgeKind;
}

export interface SessionFlowState {
  schemaVersion: 1;
  candidateOnly: true;
  canClaimAGI: false;
  /** Active conversation owning every node in this projection. */
  sessionId?: string;
  nodes: SessionFlowNode[];
  edges: SessionFlowEdge[];
  activeRunId: string;
  eventCount: number;
  nextSequence: number;
  lastNodeByScope: Record<string, string>;
  containerByScope: Record<string, string>;
  runNodeById: Record<string, string>;
  nodeDepthById: Record<string, number>;
  seenEventIds: Record<string, true>;
}

export type SessionFlowAction =
  | { type: "event"; event: BridgeEvent; sessionId?: string }
  | { type: "hydrate"; events: readonly BridgeEvent[]; sessionId: string }
  | { type: "reset"; sessionId?: string }
  | { type: "retarget"; sessionId: string };

export const EMPTY_SESSION_FLOW_STATE: SessionFlowState = {
  schemaVersion: 1,
  candidateOnly: true,
  canClaimAGI: false,
  sessionId: "",
  nodes: [],
  edges: [],
  activeRunId: "",
  eventCount: 0,
  nextSequence: 1,
  lastNodeByScope: {},
  containerByScope: {},
  runNodeById: {},
  nodeDepthById: {},
  seenEventIds: {},
};

const IGNORED_EVENT_TYPES = new Set([
  "",
  "ready",
  "token",
  "thinking_token",
  "provider_wait",
  "heartbeat",
  "log",
  "compound_workflow_status",
]);

function observableText(value: unknown, max = 96): string {
  if (value == null) return "";
  const text = sanitizeToolText(value, false, Math.max(512, max * 4))
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function eventValue(
  event: BridgeEvent,
  ...keys: string[]
): string {
  for (const key of keys) {
    const direct = event[key];
    if (
      direct != null &&
      (typeof direct === "string" ||
        typeof direct === "number" ||
        typeof direct === "boolean")
    ) {
      const value = observableText(direct);
      if (value) return value;
    }
    if (event.payload && typeof event.payload === "object") {
      const nested = (event.payload as Record<string, unknown>)[key];
      if (
        nested != null &&
        (typeof nested === "string" ||
          typeof nested === "number" ||
          typeof nested === "boolean")
      ) {
        const value = observableText(nested);
        if (value) return value;
      }
    }
  }
  return "";
}

function eventNumber(event: BridgeEvent, ...keys: string[]): number | null {
  for (const key of keys) {
    const directValue = event[key];
    if (directValue != null && directValue !== "") {
      const direct = Number(directValue);
      if (Number.isFinite(direct)) return direct;
    }
    if (event.payload && typeof event.payload === "object") {
      const nestedValue = (event.payload as Record<string, unknown>)[key];
      if (nestedValue != null && nestedValue !== "") {
        const nested = Number(nestedValue);
        if (Number.isFinite(nested)) return nested;
      }
    }
  }
  return null;
}

function normalizedIdList(value: unknown, limit: number): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const output: string[] = [];
  for (const item of values) {
    if (
      typeof item !== "string"
      && typeof item !== "number"
      && typeof item !== "boolean"
    ) {
      continue;
    }
    const normalized = observableText(item, 120);
    if (!normalized || output.includes(normalized)) continue;
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function eventIdList(
  event: BridgeEvent,
  keys: readonly string[],
  limit = 64,
): string[] {
  const roots = [
    event as Record<string, unknown>,
    objectRecord(event.payload),
  ];
  for (const root of roots) {
    for (const key of keys) {
      const normalized = normalizedIdList(root[key], limit);
      if (normalized.length > 0) return normalized;
    }
  }
  return [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedEventValue(
  event: BridgeEvent,
  containers: readonly string[],
  keys: readonly string[],
): string {
  const roots = [
    event as Record<string, unknown>,
    objectRecord(event.payload),
  ];
  for (const root of roots) {
    for (const container of containers) {
      const nested = objectRecord(root[container]);
      for (const key of keys) {
        const value = nested[key];
        if (
          value != null
          && (
            typeof value === "string"
            || typeof value === "number"
            || typeof value === "boolean"
          )
        ) {
          const normalized = observableText(value, 120);
          if (normalized) return normalized;
        }
      }
    }
  }
  return "";
}

function workflowMetadata(event: BridgeEvent): SessionFlowWorkflowMetadata {
  const workflowEventVersion = eventNumber(
    event,
    "workflowEventVersion",
    "workflow_event_version",
    "workflowSchemaVersion",
    "workflow_schema_version",
    "schemaVersion",
    "schema_version",
  );
  const workflowEventSequence = eventNumber(
    event,
    "workflowEventSequence",
    "workflow_event_sequence",
  );
  const workflowAttempt = eventNumber(event, "attempt");
  const processId = eventValue(event, "processId", "process_id");
  const processLabel = eventValue(event, "processLabel", "process_label");
  const branchId = eventValue(event, "branchId", "branch_id");
  const joinId = eventValue(event, "joinId", "join_id");
  const childWorkflowIds = eventIdList(
    event,
    ["childWorkflowIds", "child_workflow_ids"],
    3,
  );
  const completedChildWorkflowIds = eventIdList(
    event,
    ["completedChildWorkflowIds", "completed_child_workflow_ids"],
    3,
  );
  const dependsOnNodeIds = eventIdList(
    event,
    ["dependsOnNodeIds", "depends_on_node_ids"],
    128,
  );
  const expectedNodeIds = eventIdList(
    event,
    ["expectedNodeIds", "expected_node_ids"],
    128,
  );
  const completedNodeIds = eventIdList(
    event,
    ["completedNodeIds", "completed_node_ids"],
    128,
  );
  const artifactRef = eventValue(event, "artifactRef", "artifact_ref");
  const digest = eventValue(event, "digest");
  return {
    ...(workflowEventVersion == null
      ? {}
      : { workflowEventVersion: Math.max(0, Math.floor(workflowEventVersion)) }),
    ...(workflowEventSequence == null
      ? {}
      : { workflowEventSequence: Math.max(0, Math.floor(workflowEventSequence)) }),
    ...(workflowAttempt == null
      ? {}
      : { workflowAttempt: Math.max(0, Math.floor(workflowAttempt)) }),
    ...(processId ? { processId } : {}),
    ...(processLabel ? { processLabel } : {}),
    ...(branchId ? { branchId } : {}),
    ...(childWorkflowIds.length > 0 ? { childWorkflowIds } : {}),
    ...(completedChildWorkflowIds.length > 0
      ? { completedChildWorkflowIds }
      : {}),
    ...(dependsOnNodeIds.length > 0 ? { dependsOnNodeIds } : {}),
    ...(joinId ? { joinId } : {}),
    ...(expectedNodeIds.length > 0
      ? { expectedNodeIds }
      : {}),
    ...(completedNodeIds.length > 0
      ? { completedNodeIds }
      : {}),
    ...(artifactRef ? { artifactRef } : {}),
    ...(digest ? { digest } : {}),
  };
}

function eventIdentity(event: BridgeEvent): SessionFlowNodeIdentity | undefined {
  const nodeId =
    eventValue(event, "nodeId", "node_id")
    || nestedEventValue(event, ["node"], ["nodeId", "node_id", "id"])
    || nestedEventValue(
      event,
      ["agent", "lease", "worker"],
      ["nodeId", "node_id"],
    );
  const workflowId =
    eventValue(event, "workflowId", "workflow_id")
    || nestedEventValue(
      event,
      ["workflow"],
      ["workflowId", "workflow_id", "id"],
    );
  const stageKey =
    eventValue(
      event,
      "workflowStage",
      "workflow_stage",
      "stage",
      "currentStage",
      "current_stage",
    )
    || nestedEventValue(
      event,
      ["workflow", "barrier", "agent", "lease", "worker"],
      [
        "workflowStage",
        "workflow_stage",
        "stage",
        "currentStage",
        "current_stage",
      ],
    );
  const workerIndex =
    eventValue(
      event,
      "index",
      "workerIndex",
      "worker_index",
      "agentIndex",
      "agent_index",
    )
    || nestedEventValue(
      event,
      ["agent", "lease", "worker"],
      ["index", "workerIndex", "worker_index", "agentIndex", "agent_index"],
    );
  const agentKey =
    eventValue(event, "agentKey", "agent_key")
    || nestedEventValue(
      event,
      ["agent", "lease", "worker"],
      ["agentKey", "agent_key", "key"],
    );
  const agentId =
    eventValue(event, "agentId", "agent_id")
    || nestedEventValue(
      event,
      ["agent", "lease", "worker"],
      ["agentId", "agent_id", "id"],
    );
  const logicalAgentId =
    eventValue(event, "logicalAgentId", "logical_agent_id")
    || nestedEventValue(
      event,
      ["agent", "lease", "worker"],
      ["logicalAgentId", "logical_agent_id"],
    );
  const workerId =
    eventValue(event, "workerId", "worker_id", "runtimeId", "runtime_id")
    || nestedEventValue(
      event,
      ["agent", "lease", "worker"],
      ["workerId", "worker_id", "runtimeId", "runtime_id"],
    );
  const leaseId =
    eventValue(event, "leaseId", "lease_id")
    || nestedEventValue(
      event,
      ["agent", "lease", "worker"],
      ["leaseId", "lease_id"],
    );
  const agentName =
    eventValue(event, "agentName", "agent_name", "workerName", "worker_name")
    || nestedEventValue(
      event,
      ["agent", "lease", "worker"],
      ["name", "agentName", "agent_name", "workerName", "worker_name"],
    );
  const taskId = eventValue(event, "taskId", "task_id");
  const workerKey =
    workerIndex
    || agentKey
    || logicalAgentId
    || agentId
    || workerId
    || leaseId
    || agentName
    || taskId;
  const identity: SessionFlowNodeIdentity = {
    ...(nodeId ? { nodeId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(stageKey ? { stageKey } : {}),
    ...(workerKey ? { workerKey } : {}),
    ...(workerIndex ? { workerIndex } : {}),
    ...(agentKey ? { agentKey } : {}),
    ...(agentId ? { agentId } : {}),
    ...(logicalAgentId ? { logicalAgentId } : {}),
    ...(workerId ? { workerId } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(agentName ? { agentName } : {}),
    ...(taskId ? { taskId } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function titleCaseEvent(type: string): string {
  return type
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function eventKind(type: string): SessionFlowNodeKind {
  if (type === "run_start") return "run";
  if (type.startsWith("harness_") || type === "prompt_receipt" || type === "skill") {
    return "harness";
  }
  if (type === "goal" || type.startsWith("goal_")) return "goal";
  if (
    type.startsWith("model_") ||
    type === "provider_progress" ||
    type === "thinking" ||
    type === "final" ||
    type === "assistant_message"
  ) {
    return "model";
  }
  if (type.startsWith("tool_")) return "tool";
  if (
    type.startsWith("a2a_") ||
    type.startsWith("team_") ||
    type.startsWith("lane_") ||
    type.startsWith("synthesis_") ||
    type === "orchestration_plan"
  ) {
    return "agent";
  }
  if (
    type === "workflow_output_committed"
  ) {
    return "result";
  }
  if (
    type === "workflows" ||
    type.startsWith("workflow_") ||
    type.startsWith("dynamic_workflow_") ||
    type.startsWith("task_")
  ) {
    return "workflow";
  }
  if (type.startsWith("agi_")) return "agi";
  if (type.startsWith("approval_")) return "approval";
  if (type === "receipt" || type.endsWith("_receipt")) return "receipt";
  if (
    type === "result" ||
    type === "run_finished" ||
    type.endsWith("_result") ||
    type.endsWith("_complete") ||
    type.endsWith("_completed")
  ) {
    return "result";
  }
  return "system";
}

function eventStatus(
  type: string,
  event: BridgeEvent,
): SessionFlowNodeStatus {
  const explicit = eventValue(event, "status", "state").toLowerCase();
  if (
    event.ok === false ||
    /(^|_)(error|failed|failure|refused|abandoned)(_|$)/.test(type) ||
    ["failed", "error", "rejected", "lost", "unachievable"].includes(explicit)
  ) {
    return "failed";
  }
  if (
    /(^|_)(cancelled|canceled|interrupted)(_|$)/.test(type) ||
    ["cancelled", "canceled", "interrupted"].includes(explicit)
  ) {
    return "cancelled";
  }
  if (
    type === "approval_request" ||
    /(^|_)(blocked|awaiting_input|delivery_gated)(_|$)/.test(type) ||
    [
      "blocked",
      "awaiting_input",
      "paused",
      "bound_hit",
      "candidate_complete",
      "candidate_only",
      "delivery_gated",
      "held",
      "needs_reconciliation",
      "unknown",
    ].includes(explicit)
  ) {
    return "blocked";
  }
  if (
    /(^|_)(start|started|call|dispatch|triage|plan|planning|thinking|wait|waiting)(_|$)/.test(type) ||
    ["running", "active", "starting", "spawning", "verifying"].includes(explicit)
  ) {
    return "running";
  }
  if (
    event.ok === true ||
    type === "result" ||
    type === "tool_result" ||
    /(^|_)(end|ended|finished|success|succeeded|complete|completed|ack)(_|$)/.test(type) ||
    ["succeeded", "completed", "achieved"].includes(explicit)
  ) {
    return "succeeded";
  }
  if (type === "run_start") return "running";
  if (type === "run_finished") return event.ok === false ? "failed" : "succeeded";
  return "info";
}

function eventLabel(
  type: string,
  event: BridgeEvent,
): string {
  const tool = eventValue(event, "tool", "toolName", "name");
  const model = eventValue(event, "model", "provider");
  const harness = eventValue(event, "harnessName", "harness", "route", "mode");
  const phase = eventValue(event, "phase", "action", "status");
  const lane = eventValue(event, "lane", "laneId", "agentName", "agent", "role");

  switch (type) {
    case "run_start":
      return "Run started";
    case "run_finished":
      return "Run finished";
    case "goal":
      return "Goal updated";
    case "harness_context":
      return harness ? `Harness · ${harness}` : "Harness selected";
    case "prompt_receipt":
      return "Prompt receipt";
    case "skill":
      return tool ? `Skill · ${tool}` : "Skill loaded";
    case "tool_protocol":
      return phase ? `Tool protocol · ${phase}` : "Tool protocol";
    case "model_result":
      return event.ok === false
        ? model ? `Model failed · ${model}` : "Model failed"
        : model ? `Model · ${model}` : "Model result";
    case "model_preflight":
      return model ? `Model preflight · ${model}` : "Model preflight";
    case "provider_progress": {
      const provider = eventValue(event, "provider");
      const providerModel = eventValue(event, "model");
      const activity = eventValue(event, "phase");
      const status = eventValue(event, "status", "state").toLowerCase();
      const failed =
        event.ok === false
        || ["failed", "error", "timed_out", "timeout"].includes(status)
        || Boolean(eventValue(event, "error"));
      const identity = [provider, providerModel].filter(Boolean).join(":");
      return [
        failed
          ? identity ? `Provider failed · ${identity}` : "Provider failed"
          : identity ? `Provider · ${identity}` : "Provider activity",
        activity ? activity.replaceAll("_", " ") : "",
      ].filter(Boolean).join(" · ");
    }
    case "thinking":
      return "Model activity";
    case "final":
    case "assistant_message":
      return "Answer draft observed";
    case "tool_call":
      return tool ? `Tool · ${tool}` : "Tool call";
    case "tool_wait":
      return tool ? `Tool wait · ${tool}` : "Tool wait";
    case "tool_result":
      return tool ? `Tool result · ${tool}` : "Tool result";
    case "approval_request":
      return tool ? `Approval · ${tool}` : "Approval requested";
    case "approval_decision":
      return phase ? `Approval · ${phase}` : "Approval decision";
    case "orchestration_plan":
      return "Orchestration plan";
    case "team_start":
      return "Legacy parallel dispatch";
    case "synthesis_start":
      return "Parallel synthesis";
    case "a2a_dispatch":
      return "A2A dispatch";
    case "a2a_handoff":
      return "A2A handoff";
    case "a2a_chain_start":
    case "a2a_start":
      return "A2A chain";
    case "a2a_chain_end":
    case "a2a_complete":
      return "A2A chain complete";
    case "lane_start":
      return lane ? `Lane · ${lane}` : "Lane started";
    case "lane_end":
      return lane ? `Lane complete · ${lane}` : "Lane complete";
    case "a2a_agent_start":
      return lane ? `Agent · ${lane}` : "Agent started";
    case "a2a_agent_end":
      return lane ? `Agent complete · ${lane}` : "Agent complete";
    case "workflows":
      return "Workflow snapshot";
    case "workflow_process_start":
      return "Workflow process";
    case "workflow_process_progress":
      return "Workflow process progress";
    case "workflow_process_end":
      return event.ok === false ? "Workflow process failed" : "Workflow process complete";
    case "workflow_join_wait":
      return "All-of join waiting";
    case "workflow_join_released":
      return "All-of join released";
    case "workflow_join_failed":
      return "All-of join failed";
    case "workflow_output_committed":
      return "Workflow output committed";
    case "dynamic_workflow_route":
      return "Workflow routing";
    case "dynamic_workflow_start":
      return "Dynamic workflow";
    case "dynamic_workflow_controller_start":
      return phase ? `Main workflow · ${phase}` : "Main workflow controller";
    case "dynamic_workflow_controller_end":
      return phase ? `Main workflow complete · ${phase}` : "Main workflow decision";
    case "dynamic_workflow_stage_start": {
      const stage = eventNumber(event, "stage");
      return stage == null ? "Workflow stage" : `Workflow stage ${stage}`;
    }
    case "dynamic_workflow_stage_progress": {
      const stage = eventNumber(event, "stage");
      return stage == null ? "Workflow stage progress" : `Workflow stage ${stage} progress`;
    }
    case "dynamic_workflow_stage_deadline_extended": {
      const stage = eventNumber(event, "stage");
      return stage == null
        ? "Workflow stage deadline extended"
        : `Workflow stage ${stage} deadline extended`;
    }
    case "dynamic_workflow_stage_end": {
      const stage = eventNumber(event, "stage");
      return stage == null ? "Workflow stage complete" : `Workflow stage ${stage} complete`;
    }
    case "dynamic_workflow_worker_progress": {
      const index = eventNumber(event, "index");
      return index == null ? "Workflow worker progress" : `Workflow worker ${index + 1} progress`;
    }
    case "dynamic_workflow_worker_timeout": {
      const index = eventNumber(event, "index");
      return index == null ? "Workflow worker timeout" : `Workflow worker ${index + 1} timeout`;
    }
    case "dynamic_workflow_synthesis_start":
      return "Workflow synthesis";
    case "dynamic_workflow_end":
      return "Dynamic workflow complete";
    case "receipt":
      return phase ? `Receipt · ${phase}` : "Receipt";
    case "result":
      return event.ok === false ||
        [
          "blocked",
          "delivery_gated",
          "held",
          "candidate_complete",
          "candidate_only",
        ].includes(eventValue(event, "status", "state").toLowerCase())
        ? "Result gated"
        : "Result delivered";
    default:
      if (type.startsWith("agi_")) {
        return phase
          ? `AGI · ${titleCaseEvent(type.slice(4))} · ${phase}`
          : `AGI · ${titleCaseEvent(type.slice(4))}`;
      }
      if (type.startsWith("a2a_") && lane) {
        return `${titleCaseEvent(type)} · ${lane}`;
      }
      if ((type.startsWith("team_") || type.startsWith("lane_")) && lane) {
        return `${titleCaseEvent(type)} · ${lane}`;
      }
      return titleCaseEvent(type) || "Runtime event";
  }
}

function eventDetail(type: string, event: BridgeEvent): string {
  if (type === "thinking" || type === "thinking_token" || type === "token") {
    return "";
  }
  const details: string[] = [];
  const goal = eventValue(event, "goal");
  const route = eventValue(event, "route");
  const phase = eventValue(event, "phase");
  const pattern = eventValue(event, "pattern");
  const cycle = eventNumber(event, "cycle");
  const stage = eventNumber(event, "workflowStage", "stage");
  const lane = eventValue(event, "lane", "laneId");
  const role = eventValue(event, "role");
  const task = eventValue(event, "taskId", "task", "title");
  const model = eventValue(event, "model");
  const provider = eventValue(event, "provider");
  const detail = eventValue(event, "detail");
  const tool = eventValue(event, "tool", "toolName");
  const status = eventValue(event, "status", "state", "verdict");
  const reason = eventValue(event, "reason", "error");
  const elapsed = eventNumber(event, "elapsedSec", "elapsed_s", "durationSec");
  const count = eventNumber(event, "count", "total", "taskCount", "agentCount");
  const processId = eventValue(event, "processId", "process_id");
  const processLabel = eventValue(event, "processLabel", "process_label");
  const joinId = eventValue(event, "joinId", "join_id");
  const artifactRef = eventValue(event, "artifactRef", "artifact_ref");
  const digest = eventValue(event, "digest");

  if ((type === "run_start" || type === "goal") && goal) details.push(goal);
  if (route) details.push(`route ${route}`);
  if (phase) details.push(`phase ${phase}`);
  if (pattern) details.push(`pattern ${pattern}`);
  if (cycle != null) details.push(`cycle ${cycle}`);
  if (stage != null) details.push(`stage ${stage}`);
  if (lane) details.push(`lane ${lane}`);
  if (role) details.push(`role ${role}`);
  if (task) details.push(`task ${task}`);
  if (model && type !== "model_result" && type !== "model_preflight") {
    details.push(`model ${model}`);
  }
  if (provider) details.push(`provider ${provider}`);
  if (tool && type === "provider_progress") details.push(`provider tool ${tool}`);
  if (detail) details.push(detail);
  if (status) details.push(status.replaceAll("_", " "));
  if (count != null) details.push(`${count} item${count === 1 ? "" : "s"}`);
  if (elapsed != null) details.push(`${elapsed.toFixed(2)}s`);
  if (reason) details.push(reason);
  if (processLabel) details.push(`process ${processLabel}`);
  else if (processId) details.push(`process ${processId}`);
  if (joinId) details.push(`join ${joinId}`);
  if (artifactRef) details.push(`artifact ${artifactRef}`);
  if (digest) details.push(`digest ${digest}`);
  return observableText(details.join(" · "), 160);
}

function eventRunId(event: BridgeEvent, state: SessionFlowState): string {
  return (
    eventValue(event, "runId") ||
    state.activeRunId ||
    "session"
  );
}

function eventScope(event: BridgeEvent, runId: string): string {
  const workflowStage = eventNumber(event, "workflowStage", "stage");
  const workflowWorker = eventNumber(event, "index");
  if (
    workflowStage != null &&
    workflowWorker != null &&
    String(event.type || "").startsWith("dynamic_workflow_worker_")
  ) {
    return `${runId}:workflow:stage:${workflowStage}:worker:${workflowWorker}`;
  }
  const lane = eventValue(
    event,
    "lane",
    "laneId",
    "agentIndex",
    "agentName",
    "agent",
  );
  return lane ? `${runId}:lane:${lane}` : `${runId}:main`;
}

function edgeId(
  kind: SessionFlowEdgeKind,
  source: string,
  target: string,
): string {
  return `${kind}:${source}:${target}`;
}

function addEdge(
  edges: SessionFlowEdge[],
  kind: SessionFlowEdgeKind,
  source: string | null | undefined,
  target: string,
): void {
  if (!source || source === target) return;
  const id = edgeId(kind, source, target);
  if (edges.some((edge) => edge.id === id)) return;
  edges.push({ id, source, target, kind });
}

function containerClass(type: string): "run" | "a2a" | "team" | "lane" | "agi" | null {
  if (type === "run_start") return "run";
  if (type === "a2a_chain_start" || type === "a2a_start" || type === "a2a_dispatch") {
    return "a2a";
  }
  if (type === "team_start" || type === "orchestration_plan") return "team";
  if (type === "lane_start" || type === "a2a_agent_start") return "lane";
  if (type === "agi_mode_start" || type === "agi_mode_started") return "agi";
  return null;
}

function parentForEvent(
  type: string,
  runId: string,
  scope: string,
  event: BridgeEvent,
  state: SessionFlowState,
): string | null {
  const runNode = state.runNodeById[runId] || null;
  if (type === "run_start") return null;
  const workflowRoot = state.containerByScope[`${runId}:workflow`] || null;
  const workflowStage = eventNumber(event, "workflowStage", "stage");
  const workflowStageRoot =
    workflowStage == null
      ? null
      : state.containerByScope[`${runId}:workflow:stage:${workflowStage}`] || null;
  if (type.startsWith("dynamic_workflow_")) {
    if (type === "dynamic_workflow_start") return runNode;
    if (type === "dynamic_workflow_stage_start") return workflowRoot || runNode;
    return workflowStageRoot || workflowRoot || runNode;
  }
  if (workflowStageRoot) {
    return workflowStageRoot;
  }
  if (type.startsWith("agi_")) {
    return state.containerByScope[`${runId}:agi`] || runNode;
  }
  if (type.startsWith("a2a_")) {
    const a2aContainer = state.containerByScope[`${runId}:a2a`];
    return (
      (scope === `${runId}:main` ? a2aContainer : state.containerByScope[scope]) ||
      a2aContainer ||
      runNode
    );
  }
  if (
    type.startsWith("team_") ||
    type.startsWith("lane_") ||
    type.startsWith("synthesis_")
  ) {
    const teamContainer = state.containerByScope[`${runId}:team`];
    return (
      (scope === `${runId}:main` ? teamContainer : state.containerByScope[scope]) ||
      teamContainer ||
      runNode
    );
  }
  return state.containerByScope[scope] || runNode;
}

function ensureRunNode(
  state: SessionFlowState,
  runId: string,
  timestamp: string,
): SessionFlowState {
  if (state.runNodeById[runId]) return state;
  const sequence = state.nextSequence;
  const nodeId = `run-${sequence}`;
  const node: SessionFlowNode = {
    id: nodeId,
    runId,
    parentId: null,
    kind: "run",
    status: runId === "session" ? "info" : "running",
    label: runId === "session" ? "Session diagnostics" : `Run · ${observableText(runId, 42)}`,
    detail:
      runId === "session"
        ? "startup and diagnostic events observed before any prompt run"
        : "runtime events observed after the TUI attached",
    eventType: "run_observed",
    sequence,
    depth: 0,
    timestamp,
    scope: `${runId}:main`,
  };
  return {
    ...state,
    nodes: [...state.nodes, node],
    nextSequence: sequence + 1,
    runNodeById: { ...state.runNodeById, [runId]: nodeId },
    nodeDepthById: { ...state.nodeDepthById, [nodeId]: 0 },
    lastNodeByScope: {
      ...state.lastNodeByScope,
      [`${runId}:main`]: nodeId,
    },
    containerByScope: {
      ...state.containerByScope,
      [`${runId}:main`]: nodeId,
    },
  };
}

const WORKFLOW_PROCESS_EVENT_TYPES = new Set([
  "workflow_process_start",
  "workflow_process_progress",
  "workflow_process_end",
]);

const WORKFLOW_JOIN_EVENT_TYPES = new Set([
  "workflow_join_wait",
  "workflow_join_released",
  "workflow_join_failed",
]);

const COMPOUND_PLAN_SCHEMA = "sophia.compound-workflow-plan.v1";
const MAX_COMPOUND_GRAPH_NODES = 128;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface FrozenProcessDeclaration {
  processId: string;
  processLabel: string;
  branchId: string;
  childWorkflowIds: string[];
  dependsOnNodeIds: string[];
}

interface FrozenJoinDeclaration {
  joinId: string;
  expectedNodeIds: string[];
}

interface FrozenPlanDeclaration {
  schema: string;
  planDigest: string;
  outputProcessId: string;
  processes: FrozenProcessDeclaration[];
  joins: FrozenJoinDeclaration[];
}

function rawEventField(event: BridgeEvent, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(event, key)) return event[key];
  const payload = objectRecord(event.payload);
  return Object.prototype.hasOwnProperty.call(payload, key)
    ? payload[key]
    : undefined;
}

function strictNodeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value || value !== value.trim() || value.length > 120) return null;
  return value;
}

function strictNodeIds(
  value: unknown,
  minimum: number,
  maximum = MAX_COMPOUND_GRAPH_NODES,
): string[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return null;
  }
  const ids: string[] = [];
  for (const candidate of value) {
    const id = strictNodeId(candidate);
    if (!id || ids.includes(id)) return null;
    ids.push(id);
  }
  return ids;
}

function parseFrozenPlan(event: BridgeEvent): FrozenPlanDeclaration | null {
  if (
    rawEventField(event, "workflowEventVersion") !== 1
    || rawEventField(event, "workflowEventSequence") !== 0
    || rawEventField(event, "schema") !== COMPOUND_PLAN_SCHEMA
  ) {
    return null;
  }
  const planDigest = rawEventField(event, "planDigest");
  const outputProcessId = strictNodeId(rawEventField(event, "outputProcessId"));
  const rawProcesses = rawEventField(event, "processes");
  const rawJoins = rawEventField(event, "joins");
  if (
    typeof planDigest !== "string"
    || !SHA256_HEX.test(planDigest)
    || !outputProcessId
    || !Array.isArray(rawProcesses)
    || rawProcesses.length < 1
    || !Array.isArray(rawJoins)
    || rawProcesses.length + rawJoins.length > MAX_COMPOUND_GRAPH_NODES
  ) {
    return null;
  }

  const processes: FrozenProcessDeclaration[] = [];
  const workflowIds = new Set<string>();
  for (const value of rawProcesses) {
    const item = objectRecord(value);
    const processId = strictNodeId(item.processId);
    const processLabel = typeof item.processLabel === "string"
      ? observableText(item.processLabel, 256)
      : "";
    const branchId = strictNodeId(item.branchId);
    const childWorkflowIds = strictNodeIds(item.childWorkflowIds, 1, 3);
    const dependsOnNodeIds = strictNodeIds(item.dependsOnNodeIds, 0, 1);
    if (
      !processId
      || !processLabel
      || !branchId
      || !childWorkflowIds
      || !dependsOnNodeIds
      || childWorkflowIds.some((id) => workflowIds.has(id))
    ) {
      return null;
    }
    childWorkflowIds.forEach((id) => workflowIds.add(id));
    processes.push({
      processId,
      processLabel,
      branchId,
      childWorkflowIds,
      dependsOnNodeIds,
    });
  }

  const joins: FrozenJoinDeclaration[] = [];
  for (const value of rawJoins) {
    const item = objectRecord(value);
    const joinId = strictNodeId(item.joinId);
    const expectedNodeIds = strictNodeIds(
      item.expectedNodeIds,
      2,
      MAX_COMPOUND_GRAPH_NODES,
    );
    if (!joinId || !expectedNodeIds) return null;
    joins.push({ joinId, expectedNodeIds });
  }

  const graphIds = [
    ...processes.map((process) => process.processId),
    ...joins.map((join) => join.joinId),
  ];
  if (new Set(graphIds).size !== graphIds.length) return null;
  const known = new Set(graphIds);
  const dependencies = new Map<string, string[]>([
    ...processes.map((process) =>
      [process.processId, process.dependsOnNodeIds] as const),
    ...joins.map((join) => [join.joinId, join.expectedNodeIds] as const),
  ]);
  for (const [id, dependencyIds] of dependencies) {
    if (dependencyIds.includes(id) || dependencyIds.some((item) => !known.has(item))) {
      return null;
    }
  }
  if (!processes.some((process) => process.processId === outputProcessId)) {
    return null;
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependencyId of dependencies.get(id) || []) {
      if (!visit(dependencyId)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  if (graphIds.some((id) => !visit(id))) return null;

  const ancestors = new Set<string>();
  const collect = (id: string): void => {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    for (const dependencyId of dependencies.get(id) || []) collect(dependencyId);
  };
  collect(outputProcessId);
  if (ancestors.size !== graphIds.length) return null;
  if (
    graphIds.some((id) =>
      id !== outputProcessId
      && ![...dependencies.values()].some((items) => items.includes(id)))
  ) {
    return null;
  }
  if ([...dependencies.values()].some((items) => items.includes(outputProcessId))) {
    return null;
  }
  return {
    schema: COMPOUND_PLAN_SCHEMA,
    planDigest,
    outputProcessId,
    processes,
    joins,
  };
}

function stableFlowIdPart(value: string): string {
  return encodeURIComponent(value);
}

function workflowProcessMemberId(
  runId: string,
  processId: string,
  workflowId: string,
): string {
  return [
    "workflow-process",
    stableFlowIdPart(runId),
    stableFlowIdPart(processId),
    stableFlowIdPart(workflowId),
  ].join(":");
}

function workflowProcessNodeId(runId: string, processId: string): string {
  return `workflow-process:${stableFlowIdPart(runId)}:${stableFlowIdPart(processId)}`;
}

function workflowJoinNodeId(runId: string, joinId: string): string {
  return `workflow-join:${stableFlowIdPart(runId)}:${stableFlowIdPart(joinId)}`;
}

function dependencyEndpoint(
  nodes: readonly SessionFlowNode[],
  runId: string,
  dependencyId: string,
): SessionFlowNode | undefined {
  return nodes.find((node) =>
    node.runId === runId
    && node.id === workflowProcessNodeId(runId, dependencyId))
    ?? nodes.find((node) =>
      node.runId === runId
      && node.id === workflowJoinNodeId(runId, dependencyId));
}

function semanticProcessNode(
  nodes: readonly SessionFlowNode[],
  runId: string,
  processId: string,
): SessionFlowNode | undefined {
  return nodes.find((node) =>
    node.runId === runId
    && node.id === workflowProcessNodeId(runId, processId)
    && node.processNode === true);
}

function processMembers(
  nodes: readonly SessionFlowNode[],
  runId: string,
  processId: string,
): SessionFlowNode[] {
  return nodes
    .filter(
      (node) =>
        node.runId === runId
        && node.processId === processId
        && node.processMember === true,
    )
    .sort((left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function processReceiptStatus(
  type: string,
  event: BridgeEvent,
): SessionFlowNodeStatus {
  const status = eventStatus(type, event);
  if (status !== "info") return status;
  if (type === "workflow_process_end") return "succeeded";
  return "running";
}

function joinReceiptStatus(
  type: string,
  event: BridgeEvent,
): SessionFlowNodeStatus {
  if (type === "workflow_join_failed") return "failed";
  if (type === "workflow_join_released") return "succeeded";
  if (
    type === "workflow_join_wait"
    && eventValue(event, "status", "state").toLowerCase() === "pending"
  ) {
    return "pending";
  }
  const status = eventStatus(type, event);
  return status === "info" ? "running" : status;
}

function withSeenEvent(
  state: SessionFlowState,
  eventId: string,
): Record<string, true> {
  return eventId
    ? { ...state.seenEventIds, [eventId]: true }
    : state.seenEventIds;
}

function frozenPlanNode(
  nodes: readonly SessionFlowNode[],
  runId: string,
): SessionFlowNode | undefined {
  return nodes.find((node) =>
    node.runId === runId
    && node.workflowPlanFrozen === true
    && Boolean(node.planDigest)
    && Boolean(node.outputProcessId));
}

function reduceWorkflowPlanFrozen(
  state: SessionFlowState,
  event: BridgeEvent,
  runId: string,
  timestamp: string,
  eventId: string,
): SessionFlowState {
  const declaration = parseFrozenPlan(event);
  if (!declaration) {
    return { ...state, seenEventIds: withSeenEvent(state, eventId) };
  }
  const existingHeader = frozenPlanNode(state.nodes, runId);
  if (existingHeader) {
    // A run has one immutable plan. Replays are no-ops; a conflicting digest
    // is rejected instead of silently replacing the topology.
    return {
      ...state,
      seenEventIds: withSeenEvent(state, eventId),
    };
  }

  const planMetadata = {
    workflowEventVersion: 1,
    workflowPlanFrozen: true as const,
    planDigest: declaration.planDigest,
    outputProcessId: declaration.outputProcessId,
  };
  const parentId = state.runNodeById[runId] || null;
  const existingById = new Map(state.nodes.map((node) => [node.id, node]));
  const replacements = new Map<string, SessionFlowNode>();
  const additions: SessionFlowNode[] = [];
  let nextSequence = state.nextSequence;

  const replaceOrAdd = (node: SessionFlowNode): void => {
    if (existingById.has(node.id)) replacements.set(node.id, node);
    else {
      additions.push(node);
      existingById.set(node.id, node);
    }
  };

  for (const declared of declaration.processes) {
    const id = workflowProcessNodeId(runId, declared.processId);
    const observed = semanticProcessNode(state.nodes, runId, declared.processId);
    const prior = observed
      && exactIds(observed.childWorkflowIds || [], declared.childWorkflowIds)
      && exactIds(observed.dependsOnNodeIds || [], declared.dependsOnNodeIds)
      && observed.processLabel === declared.processLabel
      && observed.branchId === declared.branchId
      ? observed
      : undefined;
    const sequence = prior?.sequence ?? nextSequence++;
    const depth = parentId
      ? Math.min(5, (state.nodeDepthById[parentId] ?? 0) + 1)
      : 0;
    const completed = (prior?.completedChildWorkflowIds || []).filter((item) =>
      declared.childWorkflowIds.includes(item));
    const process: SessionFlowNode = {
      ...(prior ?? {}),
      id,
      runId,
      parentId,
      kind: "workflow",
      status: prior?.status ?? "pending",
      label: `Process · ${declared.processLabel}`,
      detail: prior?.detail || `${declared.childWorkflowIds.length} serial workflow member${declared.childWorkflowIds.length === 1 ? "" : "s"} planned`,
      eventType: prior?.eventType ?? "workflow_process_planned",
      sequence,
      observedSequence: prior?.observedSequence ?? null,
      depth,
      timestamp: prior?.timestamp || timestamp,
      scope: declared.branchId !== "main"
        ? `${runId}:workflow:branch:${declared.branchId}`
        : `${runId}:main`,
      identity: { ...(prior?.identity ?? {}), nodeId: declared.processId },
      ...planMetadata,
      ...(prior?.workflowEventSequence == null
        ? { workflowEventSequence: 0 }
        : { workflowEventSequence: prior.workflowEventSequence }),
      processId: declared.processId,
      processLabel: declared.processLabel,
      branchId: declared.branchId,
      childWorkflowIds: [...declared.childWorkflowIds],
      ...(completed.length > 0 ? { completedChildWorkflowIds: completed } : {}),
      dependsOnNodeIds: [...declared.dependsOnNodeIds],
      processNode: true,
    };
    replaceOrAdd(process);

    const priorMembers = new Map(
      (prior ? processMembers(state.nodes, runId, declared.processId) : []).map((member) => [
        member.identity?.workflowId || "",
        member,
      ]),
    );
    for (const workflowId of declared.childWorkflowIds) {
      const memberId = workflowProcessMemberId(runId, declared.processId, workflowId);
      const priorMember = priorMembers.get(workflowId);
      const memberSequence = priorMember?.sequence ?? nextSequence++;
      replaceOrAdd({
        ...(priorMember ?? {}),
        id: memberId,
        runId,
        parentId: id,
        kind: "workflow",
        status: priorMember?.status
          ?? (process.status === "succeeded" ? "succeeded" : "pending"),
        label: declared.childWorkflowIds.length === 1
          ? `Workflow · ${declared.processLabel}`
          : `Workflow · ${workflowId}`,
        detail: priorMember?.detail || "planned serial workflow member",
        eventType: priorMember?.eventType ?? "workflow_process_planned",
        sequence: memberSequence,
        observedSequence: priorMember?.observedSequence ?? null,
        depth: Math.min(5, depth + 1),
        timestamp: priorMember?.timestamp || timestamp,
        scope: process.scope,
        identity: { ...(priorMember?.identity ?? {}), workflowId },
        ...planMetadata,
        ...(priorMember?.workflowEventSequence == null
          ? { workflowEventSequence: 0 }
          : { workflowEventSequence: priorMember.workflowEventSequence }),
        processId: declared.processId,
        processLabel: declared.processLabel,
        branchId: declared.branchId,
        childWorkflowIds: [...declared.childWorkflowIds],
        ...(completed.length > 0 ? { completedChildWorkflowIds: completed } : {}),
        dependsOnNodeIds: [...declared.dependsOnNodeIds],
        processMember: true,
      });
    }
  }

  for (const declared of declaration.joins) {
    const id = workflowJoinNodeId(runId, declared.joinId);
    const observed = state.nodes.find((node) => node.id === id && node.joinId);
    const prior = observed
      && exactIds(observed.expectedNodeIds || [], declared.expectedNodeIds)
      ? observed
      : undefined;
    const sequence = prior?.sequence ?? nextSequence++;
    const completed = (prior?.completedNodeIds || []).filter((item) =>
      declared.expectedNodeIds.includes(item));
    replaceOrAdd({
      ...(prior ?? {}),
      id,
      runId,
      parentId,
      kind: "workflow",
      status: prior?.status ?? "pending",
      label: prior?.label || "All-of join waiting",
      detail: prior?.detail || `0/${declared.expectedNodeIds.length} predecessors complete`,
      eventType: prior?.eventType ?? "workflow_join_planned",
      sequence,
      observedSequence: prior?.observedSequence ?? null,
      depth: parentId
        ? Math.min(5, (state.nodeDepthById[parentId] ?? 0) + 1)
        : 0,
      timestamp: prior?.timestamp || timestamp,
      scope: `${runId}:main`,
      identity: { ...(prior?.identity ?? {}), nodeId: declared.joinId },
      ...planMetadata,
      ...(prior?.workflowEventSequence == null
        ? { workflowEventSequence: 0 }
        : { workflowEventSequence: prior.workflowEventSequence }),
      joinId: declared.joinId,
      expectedNodeIds: [...declared.expectedNodeIds],
      ...(completed.length > 0 ? { completedNodeIds: completed } : {}),
    });
  }

  const planNodeIds = new Set<string>();
  for (const process of declaration.processes) {
    planNodeIds.add(workflowProcessNodeId(runId, process.processId));
    for (const workflowId of process.childWorkflowIds) {
      planNodeIds.add(workflowProcessMemberId(runId, process.processId, workflowId));
    }
  }
  for (const join of declaration.joins) {
    planNodeIds.add(workflowJoinNodeId(runId, join.joinId));
  }
  let nodes = state.nodes
    .filter((node) =>
      node.runId !== runId
      || (
        node.processNode !== true
        && node.processMember !== true
        && !node.joinId
      )
      || planNodeIds.has(node.id))
    .map((node) => replacements.get(node.id) ?? node);
  nodes.push(...additions);
  if (parentId) {
    nodes = nodes.map((node) =>
      node.id === parentId ? { ...node, ...planMetadata } : node);
  }

  const retainedNodeIds = new Set(nodes.map((node) => node.id));
  const edges = state.edges.filter((edge) =>
    retainedNodeIds.has(edge.source)
    && retainedNodeIds.has(edge.target)
    && !(
      (edge.kind === "contains" && planNodeIds.has(edge.target))
      || (
        edge.kind === "sequence"
        && planNodeIds.has(edge.source)
        && planNodeIds.has(edge.target)
      )
    ));
  const graphEndpoint = (nodeId: string) =>
    declaration.processes.some((process) => process.processId === nodeId)
      ? workflowProcessNodeId(runId, nodeId)
      : workflowJoinNodeId(runId, nodeId);
  for (const process of declaration.processes) {
    const processNodeId = workflowProcessNodeId(runId, process.processId);
    addEdge(edges, "contains", parentId, processNodeId);
    if (process.dependsOnNodeIds.length === 0) {
      addEdge(edges, "sequence", parentId, processNodeId);
    } else {
      addEdge(
        edges,
        "sequence",
        graphEndpoint(process.dependsOnNodeIds[0]!),
        processNodeId,
      );
    }
    const memberIds = process.childWorkflowIds.map((workflowId) =>
      workflowProcessMemberId(runId, process.processId, workflowId));
    for (const memberId of memberIds) addEdge(edges, "contains", processNodeId, memberId);
    for (let index = 1; index < memberIds.length; index += 1) {
      addEdge(edges, "sequence", memberIds[index - 1], memberIds[index]!);
    }
  }
  for (const join of declaration.joins) {
    const joinNodeId = workflowJoinNodeId(runId, join.joinId);
    addEdge(edges, "contains", parentId, joinNodeId);
    for (const predecessorId of join.expectedNodeIds) {
      addEdge(edges, "sequence", graphEndpoint(predecessorId), joinNodeId);
    }
  }

  const nodeDepthById = { ...state.nodeDepthById };
  for (const node of nodes) {
    if (planNodeIds.has(node.id)) nodeDepthById[node.id] = node.depth;
  }
  const reduced: SessionFlowState = {
    ...state,
    nodes,
    edges,
    activeRunId: runId === "session" ? state.activeRunId : runId,
    eventCount: state.eventCount + 1,
    nextSequence,
    nodeDepthById,
    seenEventIds: withSeenEvent(state, eventId),
  };
  return compoundWorkflowOutputAuthorized(reduced, runId)
    ? { ...reduced, activeRunId: "" }
    : reduced;
}

function reduceWorkflowProcessEvent(
  state: SessionFlowState,
  event: BridgeEvent,
  type: string,
  runId: string,
  timestamp: string,
  eventId: string,
  incoming: SessionFlowWorkflowMetadata,
): SessionFlowState | null {
  const processId = incoming.processId;
  if (!processId) return null;

  const id = workflowProcessNodeId(runId, processId);
  const existingProcess = semanticProcessNode(state.nodes, runId, processId);
  const existingMembers = processMembers(state.nodes, runId, processId);
  if (
    incoming.workflowEventSequence != null
    && existingProcess?.workflowEventSequence != null
    && incoming.workflowEventSequence <= existingProcess.workflowEventSequence
  ) {
    return {
      ...state,
      seenEventIds: withSeenEvent(state, eventId),
    };
  }
  const targetedWorkflowId = eventValue(
    event,
    "childWorkflowId",
    "child_workflow_id",
    "workflowId",
    "workflow_id",
  );
  const existingWorkflowIds = existingMembers
    .map((node) => node.identity?.workflowId || "")
    .filter(Boolean);
  const childWorkflowIds = (
    existingProcess?.workflowPlanFrozen && existingProcess.childWorkflowIds?.length
      ? existingProcess.childWorkflowIds
      : incoming.childWorkflowIds?.length
      ? incoming.childWorkflowIds
      : existingProcess?.childWorkflowIds?.length
        ? existingProcess.childWorkflowIds
      : existingWorkflowIds.length
        ? existingWorkflowIds
        : [targetedWorkflowId || processId]
  ).slice(0, 3);
  const processLabel =
    (existingProcess?.workflowPlanFrozen ? existingProcess.processLabel : incoming.processLabel)
    || existingProcess?.processLabel
    || existingMembers[0]?.processLabel
    || processId;
  const branchId =
    (existingProcess?.workflowPlanFrozen ? existingProcess.branchId : incoming.branchId)
    || existingProcess?.branchId
    || existingMembers[0]?.branchId;
  const dependsOnNodeIds = (
    existingProcess?.workflowPlanFrozen
      ? existingProcess.dependsOnNodeIds || []
      : incoming.dependsOnNodeIds
  )
    || existingProcess?.dependsOnNodeIds
    || existingMembers[0]?.dependsOnNodeIds
    || [];
  const completedChildWorkflowIds =
    incoming.completedChildWorkflowIds
    || existingProcess?.completedChildWorkflowIds
    || existingMembers[0]?.completedChildWorkflowIds
    || [];
  const completedChildSet = new Set(completedChildWorkflowIds);
  const workflowEventVersion =
    incoming.workflowEventVersion
    ?? existingProcess?.workflowEventVersion
    ?? existingMembers[0]?.workflowEventVersion;
  const workflowEventSequence =
    incoming.workflowEventSequence
    ?? existingProcess?.workflowEventSequence
    ?? existingMembers[0]?.workflowEventSequence;
  const workflowAttempt =
    incoming.workflowAttempt
    ?? existingProcess?.workflowAttempt
    ?? existingMembers[0]?.workflowAttempt;
  const parentId = state.runNodeById[runId] || null;
  const scope = branchId && branchId !== "main"
    ? `${runId}:workflow:branch:${branchId}`
    : `${runId}:main`;
  const receiptStatus = processReceiptStatus(type, event);
  const receiptDetail = eventDetail(type, event);
  const identity = eventIdentity(event);
  const processSequence = existingProcess?.sequence ?? state.nextSequence;
  const processDepth = parentId
    ? Math.min(5, (state.nodeDepthById[parentId] ?? 0) + 1)
    : 0;
  const process: SessionFlowNode = {
    ...(existingProcess ?? {}),
    id,
    runId,
    parentId,
    kind: "workflow",
    status: receiptStatus,
    label: `Process · ${processLabel}`,
    detail: receiptDetail,
    eventType: type,
    sequence: processSequence,
    observedSequence: state.nextSequence,
    depth: processDepth,
    timestamp,
    scope,
    identity: {
      ...(existingProcess?.identity ?? {}),
      ...(identity ?? {}),
      nodeId: processId,
    },
    ...(workflowEventVersion == null ? {} : { workflowEventVersion }),
    ...(workflowEventSequence == null ? {} : { workflowEventSequence }),
    ...(workflowAttempt == null ? {} : { workflowAttempt }),
    processId,
    processLabel,
    ...(branchId ? { branchId } : {}),
    childWorkflowIds: [...childWorkflowIds],
    ...(completedChildWorkflowIds.length > 0
      ? { completedChildWorkflowIds: [...completedChildWorkflowIds] }
      : {}),
    dependsOnNodeIds: [...dependsOnNodeIds],
    processNode: true,
  };
  const existingById = new Map(
    existingMembers.map((node) => [node.id, node]),
  );
  const changedById = new Map<string, SessionFlowNode>();
  let nextSequence = existingProcess
    ? state.nextSequence
    : state.nextSequence + 1;

  for (const workflowId of childWorkflowIds) {
    const id = workflowProcessMemberId(runId, processId, workflowId);
    const prior = existingById.get(id);
    const sequence = prior?.sequence ?? nextSequence++;
    const targeted = type === "workflow_process_start"
      && targetedWorkflowId === workflowId;
    const status = type === "workflow_process_end" && receiptStatus === "succeeded"
      ? "succeeded"
      : completedChildSet.has(workflowId)
        ? "succeeded"
        : targeted
          ? receiptStatus
          : prior?.status === "succeeded"
            ? "succeeded"
            : "pending";
    const observed = targeted || completedChildSet.has(workflowId);
    const label = childWorkflowIds.length === 1 && workflowId === processId
      ? `Workflow · ${processLabel}`
      : `Workflow · ${workflowId}`;
    changedById.set(id, {
      ...(prior ?? {}),
      id,
      runId,
      parentId: process.id,
      kind: "workflow",
      status,
      label,
      detail: observed ? receiptDetail : prior?.detail ?? "",
      eventType: observed ? type : prior?.eventType ?? type,
      sequence,
      observedSequence: observed
        ? prior
          ? state.nextSequence
          : sequence
        : prior?.observedSequence ?? null,
      depth: Math.min(5, processDepth + 1),
      timestamp: observed ? timestamp : prior?.timestamp ?? timestamp,
      scope,
      identity: {
        ...(prior?.identity ?? {}),
        ...(identity ?? {}),
        workflowId,
      },
      ...(workflowEventVersion == null ? {} : { workflowEventVersion }),
      ...(workflowEventSequence == null ? {} : { workflowEventSequence }),
      ...(workflowAttempt == null ? {} : { workflowAttempt }),
      processId,
      processLabel,
      ...(branchId ? { branchId } : {}),
      childWorkflowIds: [...childWorkflowIds],
      ...(completedChildWorkflowIds.length > 0
        ? { completedChildWorkflowIds: [...completedChildWorkflowIds] }
        : {}),
      dependsOnNodeIds: [...dependsOnNodeIds],
      processMember: true,
    });
  }

  // A lifecycle update consumes an observed receipt position even when it
  // updates stable semantic members instead of appending another block.
  nextSequence = Math.max(nextSequence, state.nextSequence + 1);
  const nodes = state.nodes.map((node) =>
    node.id === process.id ? process : changedById.get(node.id) ?? node);
  if (!existingProcess) nodes.push(process);
  for (const [id, member] of changedById) {
    if (!existingById.has(id)) nodes.push(member);
  }
  const members = processMembers(nodes, runId, processId);
  const edges = [...state.edges];
  if (!existingProcess) addEdge(edges, "contains", parentId, process.id);
  for (const member of members) {
    if (!existingById.has(member.id)) {
      addEdge(edges, "contains", process.id, member.id);
    }
  }
  for (let index = 1; index < members.length; index += 1) {
    addEdge(edges, "sequence", members[index - 1]?.id, members[index]!.id);
  }
  for (const dependencyId of dependsOnNodeIds) {
    const dependency = dependencyEndpoint(nodes, runId, dependencyId);
    addEdge(edges, "sequence", dependency?.id, process.id);
  }
  if (!existingProcess) {
    const priorMain = state.lastNodeByScope[`${runId}:main`];
    if (dependsOnNodeIds.length === 0 && priorMain) {
      const priorMainNode = nodes.find((node) => node.id === priorMain);
      if (priorMainNode?.processId !== processId) {
        // A barrier normally announces that it is waiting before root
        // branches start. Receipt chronology must not make that join their
        // causal parent; dependency-free processes are dispatched by the run.
        addEdge(
          edges,
          "sequence",
          priorMainNode?.joinId ? state.runNodeById[runId] : priorMain,
          process.id,
        );
      }
    }
  }

  // Dependency receipts are allowed to arrive out of causal order. When this
  // process is the late predecessor, materialize every already-declared edge
  // to dependent processes and joins without relying on receipt chronology.
  for (const candidate of nodes) {
    if (
      candidate.runId !== runId
      || candidate.id === process.id
    ) {
      continue;
    }
    if (
      candidate.processNode === true
      && candidate.dependsOnNodeIds?.includes(processId)
    ) {
      addEdge(edges, "sequence", process.id, candidate.id);
    }
    if (
      candidate.joinId
      && candidate.expectedNodeIds?.includes(processId)
    ) {
      addEdge(edges, "sequence", process.id, candidate.id);
    }
  }

  const lastNodeByScope = { ...state.lastNodeByScope };
  lastNodeByScope[scope] = process.id;
  const nodeDepthById = { ...state.nodeDepthById };
  nodeDepthById[process.id] = process.depth;
  for (const member of members) nodeDepthById[member.id] = member.depth;

  return {
    ...state,
    nodes,
    edges,
    activeRunId: runId === "session" ? state.activeRunId : runId,
    eventCount: state.eventCount + 1,
    nextSequence,
    lastNodeByScope,
    nodeDepthById,
    seenEventIds: withSeenEvent(state, eventId),
  };
}

function reduceWorkflowJoinEvent(
  state: SessionFlowState,
  event: BridgeEvent,
  type: string,
  runId: string,
  timestamp: string,
  eventId: string,
  incoming: SessionFlowWorkflowMetadata,
): SessionFlowState | null {
  const joinId = incoming.joinId;
  if (!joinId) return null;
  const id = workflowJoinNodeId(runId, joinId);
  const prior = state.nodes.find((node) => node.id === id);
  if (
    incoming.workflowEventSequence != null
    && prior?.workflowEventSequence != null
    && incoming.workflowEventSequence <= prior.workflowEventSequence
  ) {
    return {
      ...state,
      seenEventIds: withSeenEvent(state, eventId),
    };
  }
  const predecessors =
    prior?.workflowPlanFrozen
      ? prior.expectedNodeIds || []
      : incoming.expectedNodeIds
    || prior?.expectedNodeIds
    || [];
  const completed =
    incoming.completedNodeIds
    || prior?.completedNodeIds
    || [];
  const parentId = state.runNodeById[runId] || null;
  const sequence = prior?.sequence ?? state.nextSequence;
  const status = joinReceiptStatus(type, event);
  const label = type === "workflow_join_released"
    ? "All-of join released"
    : type === "workflow_join_failed"
      ? "All-of join failed"
      : "All-of join waiting";
  const node: SessionFlowNode = {
    ...(prior ?? {}),
    id,
    runId,
    parentId,
    kind: "workflow",
    status,
    label,
    detail: [
      predecessors.length > 0
        ? `${completed.length}/${predecessors.length} predecessors complete`
        : "waiting for predecessor membership",
      eventDetail(type, event),
    ].filter(Boolean).join(" · "),
    eventType: type,
    sequence,
    observedSequence: state.nextSequence,
    depth: parentId
      ? Math.min(5, (state.nodeDepthById[parentId] ?? 0) + 1)
      : 0,
    timestamp,
    scope: `${runId}:main`,
    identity: {
      ...(prior?.identity ?? {}),
      ...(eventIdentity(event) ?? {}),
      nodeId: joinId,
    },
    ...(incoming.workflowEventVersion == null
      ? prior?.workflowEventVersion == null
        ? {}
        : { workflowEventVersion: prior.workflowEventVersion }
      : { workflowEventVersion: incoming.workflowEventVersion }),
    ...(incoming.workflowEventSequence == null
      ? prior?.workflowEventSequence == null
        ? {}
        : { workflowEventSequence: prior.workflowEventSequence }
      : { workflowEventSequence: incoming.workflowEventSequence }),
    joinId,
    ...(predecessors.length > 0
      ? { expectedNodeIds: [...predecessors] }
      : {}),
    ...(completed.length > 0
      ? { completedNodeIds: [...completed] }
      : {}),
  };
  const nodes = prior
    ? state.nodes.map((item) => item.id === id ? node : item)
    : [...state.nodes, node];
  const edges = [...state.edges];
  if (!prior) addEdge(edges, "contains", parentId, id);
  for (const predecessorId of predecessors) {
    const predecessor = dependencyEndpoint(nodes, runId, predecessorId);
    addEdge(edges, "sequence", predecessor?.id, id);
  }
  const priorMain = state.lastNodeByScope[`${runId}:main`];
  if (!prior && predecessors.length === 0 && priorMain) {
    addEdge(edges, "sequence", priorMain, id);
  }

  // A join may itself be a predecessor, and join/process receipts can be
  // observed in either order during replay or reconnect hydration.
  for (const candidate of nodes) {
    if (candidate.runId !== runId || candidate.id === id) continue;
    if (
      candidate.processNode === true
      && candidate.dependsOnNodeIds?.includes(joinId)
    ) {
      addEdge(edges, "sequence", id, candidate.id);
    }
    if (
      candidate.joinId
      && candidate.expectedNodeIds?.includes(joinId)
    ) {
      addEdge(edges, "sequence", id, candidate.id);
    }
  }

  return {
    ...state,
    nodes,
    edges,
    activeRunId: runId === "session" ? state.activeRunId : runId,
    eventCount: state.eventCount + 1,
    nextSequence: Math.max(state.nextSequence + 1, sequence + 1),
    lastNodeByScope: {
      ...state.lastNodeByScope,
      [`${runId}:main`]: id,
    },
    nodeDepthById: {
      ...state.nodeDepthById,
      [id]: node.depth,
    },
    seenEventIds: withSeenEvent(state, eventId),
  };
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validWorkflowLifecycleEvent(
  state: SessionFlowState,
  event: BridgeEvent,
  type: string,
  runId: string,
): boolean {
  const version = rawEventField(event, "workflowEventVersion");
  const sequence = rawEventField(event, "workflowEventSequence");
  if (
    version !== 1
    || typeof sequence !== "number"
    || !Number.isInteger(sequence)
    || sequence < 1
  ) {
    return false;
  }
  const header = frozenPlanNode(state.nodes, runId);

  if (WORKFLOW_PROCESS_EVENT_TYPES.has(type)) {
    const processId = strictNodeId(rawEventField(event, "processId"));
    const processLabel = rawEventField(event, "processLabel");
    const branchId = strictNodeId(rawEventField(event, "branchId"));
    const childWorkflowIds = strictNodeIds(
      rawEventField(event, "childWorkflowIds"),
      1,
      3,
    );
    const dependsOnNodeIds = strictNodeIds(
      rawEventField(event, "dependsOnNodeIds"),
      0,
      1,
    );
    if (
      !processId
      || typeof processLabel !== "string"
      || !observableText(processLabel, 256)
      || !branchId
      || !childWorkflowIds
      || !dependsOnNodeIds
    ) {
      return false;
    }
    const planned = semanticProcessNode(state.nodes, runId, processId);
    if (header) {
      if (
        planned?.workflowPlanFrozen !== true
        || planned.planDigest !== header.planDigest
        || planned.processLabel !== observableText(processLabel, 256)
        || planned.branchId !== branchId
        || !exactIds(planned.childWorkflowIds || [], childWorkflowIds)
        || !exactIds(planned.dependsOnNodeIds || [], dependsOnNodeIds)
      ) {
        return false;
      }
    }
    if (type === "workflow_process_start") {
      const workflowId = strictNodeId(rawEventField(event, "workflowId"));
      const attempt = rawEventField(event, "attempt");
      return Boolean(
        workflowId
        && childWorkflowIds.includes(workflowId)
        && typeof attempt === "number"
        && Number.isInteger(attempt)
        && attempt >= 1
        && rawEventField(event, "state") === "running"
      );
    }
    if (type === "workflow_process_progress") {
      const completed = strictNodeIds(
        rawEventField(event, "completedChildWorkflowIds"),
        1,
        3,
      );
      return Boolean(
        completed
        && completed.every((workflowId) => childWorkflowIds.includes(workflowId))
      );
    }
    return ["succeeded", "failed", "blocked", "needs_reconciliation"].includes(
      rawEventField(event, "state") as string,
    );
  }

  if (WORKFLOW_JOIN_EVENT_TYPES.has(type)) {
    const joinId = strictNodeId(rawEventField(event, "joinId"));
    const expectedNodeIds = strictNodeIds(
      rawEventField(event, "expectedNodeIds"),
      2,
      MAX_COMPOUND_GRAPH_NODES,
    );
    const completedNodeIds = strictNodeIds(
      rawEventField(event, "completedNodeIds"),
      0,
      MAX_COMPOUND_GRAPH_NODES,
    );
    if (
      !joinId
      || !expectedNodeIds
      || !completedNodeIds
      || completedNodeIds.some((id) => !expectedNodeIds.includes(id))
    ) {
      return false;
    }
    const planned = state.nodes.find((node) =>
      node.runId === runId && node.joinId === joinId);
    if (
      header
      && (
        planned?.workflowPlanFrozen !== true
        || planned.planDigest !== header.planDigest
        || !exactIds(planned.expectedNodeIds || [], expectedNodeIds)
      )
    ) {
      return false;
    }
    if (type === "workflow_join_wait") {
      return ["pending", "blocked"].includes(rawEventField(event, "state") as string);
    }
    if (type === "workflow_join_failed") {
      return rawEventField(event, "state") === "failed";
    }
    return completedNodeIds.length === expectedNodeIds.length;
  }

  if (type === "workflow_output_committed") {
    const processId = strictNodeId(rawEventField(event, "processId"));
    const artifactRef = rawEventField(event, "artifactRef");
    const digest = rawEventField(event, "digest");
    if (
      !processId
      || typeof artifactRef !== "string"
      || !artifactRef.trim()
      || typeof digest !== "string"
      || !SHA256_HEX.test(digest)
    ) {
      return false;
    }
    return !header || Boolean(
      semanticProcessNode(state.nodes, runId, processId)?.workflowPlanFrozen,
    );
  }
  return false;
}

export function compoundWorkflowOutputAuthorized(
  state: SessionFlowState,
  runId: string,
): boolean {
  const header = frozenPlanNode(state.nodes, runId);
  const outputProcessId = header?.outputProcessId;
  const planDigest = header?.planDigest;
  if (!header || !outputProcessId || !planDigest || !SHA256_HEX.test(planDigest)) {
    return false;
  }
  const endpointByGraphId = new Map<string, SessionFlowNode>();
  for (const node of state.nodes) {
    if (
      node.runId !== runId
      || node.workflowPlanFrozen !== true
      || node.planDigest !== planDigest
      || node.outputProcessId !== outputProcessId
      || node.processMember === true
    ) {
      continue;
    }
    const graphId = node.processNode === true ? node.processId : node.joinId;
    if (graphId) endpointByGraphId.set(graphId, node);
  }
  const outputProcess = endpointByGraphId.get(outputProcessId);
  if (outputProcess?.processNode !== true) return false;

  const visited = new Set<string>();
  const positivelyComplete = (graphId: string): boolean => {
    if (visited.has(graphId)) return true;
    const node = endpointByGraphId.get(graphId);
    if (!node || node.status !== "succeeded") return false;
    visited.add(graphId);
    const dependencies = node.processNode === true
      ? node.dependsOnNodeIds || []
      : node.expectedNodeIds || [];
    return dependencies.every(positivelyComplete);
  };
  if (!positivelyComplete(outputProcessId)) return false;

  return state.nodes.some((node) =>
    node.runId === runId
    && node.eventType === "workflow_output_committed"
    && node.processId === outputProcessId
    && Boolean(node.artifactRef?.trim())
    && Boolean(node.digest && SHA256_HEX.test(node.digest)));
}

function reduceEvent(
  inputState: SessionFlowState,
  event: BridgeEvent,
): SessionFlowState {
  const type = observableText(event.type, 80);
  if (IGNORED_EVENT_TYPES.has(type)) return inputState;
  const eventId = eventValue(event, "eventId");
  if (eventId && inputState.seenEventIds[eventId]) return inputState;

  const timestamp = eventValue(event, "ts", "timestamp") || new Date().toISOString();
  const runId = eventRunId(event, inputState);
  let state =
    type === "run_start"
      ? inputState
      : ensureRunNode(inputState, runId, timestamp);
  if (type === "workflow_plan_frozen") {
    return reduceWorkflowPlanFrozen(
      state,
      event,
      runId,
      timestamp,
      eventId,
    );
  }
  const metadata = workflowMetadata(event);
  if (
    WORKFLOW_PROCESS_EVENT_TYPES.has(type)
    || WORKFLOW_JOIN_EVENT_TYPES.has(type)
    || type === "workflow_output_committed"
  ) {
    if (!validWorkflowLifecycleEvent(state, event, type, runId)) {
      return { ...state, seenEventIds: withSeenEvent(state, eventId) };
    }
  }
  if (WORKFLOW_PROCESS_EVENT_TYPES.has(type)) {
    const reduced = reduceWorkflowProcessEvent(
      state,
      event,
      type,
      runId,
      timestamp,
      eventId,
      metadata,
    );
    if (reduced) {
      return compoundWorkflowOutputAuthorized(reduced, runId)
        ? { ...reduced, activeRunId: "" }
        : reduced;
    }
    return { ...state, seenEventIds: withSeenEvent(state, eventId) };
  }
  if (WORKFLOW_JOIN_EVENT_TYPES.has(type)) {
    const reduced = reduceWorkflowJoinEvent(
      state,
      event,
      type,
      runId,
      timestamp,
      eventId,
      metadata,
    );
    if (reduced) {
      return compoundWorkflowOutputAuthorized(reduced, runId)
        ? { ...reduced, activeRunId: "" }
        : reduced;
    }
    return { ...state, seenEventIds: withSeenEvent(state, eventId) };
  }
  const scope = eventScope(event, runId);
  const sequence = state.nextSequence;
  const nodeId =
    type === "run_start" && !state.runNodeById[runId]
      ? `run-${sequence}`
      : `flow-${sequence}`;
  const parentId = parentForEvent(type, runId, scope, event, state);
  const node: SessionFlowNode = {
    id: nodeId,
    runId,
    parentId,
    kind: eventKind(type),
    status: eventStatus(type, event),
    label: eventLabel(type, event),
    detail: eventDetail(type, event),
    eventType: type,
    sequence,
    depth: parentId
      ? Math.min(5, (state.nodeDepthById[parentId] ?? 0) + 1)
      : 0,
    timestamp,
    scope,
    identity: eventIdentity(event),
    ...metadata,
  };
  const edges = [...state.edges];
  addEdge(edges, "contains", parentId, nodeId);
  if (type === "workflow_output_committed" && metadata.processId) {
    addEdge(
      edges,
      "sequence",
      semanticProcessNode(state.nodes, runId, metadata.processId)?.id,
      nodeId,
    );
  } else {
    addEdge(edges, "sequence", state.lastNodeByScope[scope], nodeId);
  }
  if (type === "a2a_handoff") {
    addEdge(
      edges,
      "handoff",
      state.lastNodeByScope[`${runId}:main`],
      nodeId,
    );
  }

  const runNodeById = { ...state.runNodeById };
  const containerByScope = { ...state.containerByScope };
  const lastNodeByScope = {
    ...state.lastNodeByScope,
    [scope]: nodeId,
  };
  if (type === "run_start") {
    runNodeById[runId] = nodeId;
    containerByScope[`${runId}:main`] = nodeId;
  }
  const container = containerClass(type);
  if (container === "a2a") containerByScope[`${runId}:a2a`] = nodeId;
  if (container === "team") containerByScope[`${runId}:team`] = nodeId;
  if (container === "agi") containerByScope[`${runId}:agi`] = nodeId;
  if (container === "lane") containerByScope[scope] = nodeId;
  if (type === "dynamic_workflow_start") {
    containerByScope[`${runId}:workflow`] = nodeId;
  }
  if (type === "dynamic_workflow_stage_start") {
    const workflowStage = eventNumber(event, "workflowStage", "stage");
    if (workflowStage != null) {
      containerByScope[`${runId}:workflow:stage:${workflowStage}`] = nodeId;
    }
  }

  const reduced: SessionFlowState = {
    ...state,
    nodes: [...state.nodes, node],
    edges,
    // Startup diagnostics have no runId and are grouped under the synthetic
    // "session" root. They must not make an idle TUI look like an execution is
    // running forever.
    activeRunId:
      type === "run_finished"
        ? ""
        : runId === "session"
          ? state.activeRunId
          : runId,
    eventCount: state.eventCount + 1,
    nextSequence: sequence + 1,
    lastNodeByScope,
    containerByScope,
    runNodeById,
    nodeDepthById: {
      ...state.nodeDepthById,
      [nodeId]: node.depth,
    },
    seenEventIds: eventId
      ? { ...state.seenEventIds, [eventId]: true }
      : state.seenEventIds,
  };
  return compoundWorkflowOutputAuthorized(reduced, runId)
    ? { ...reduced, activeRunId: "" }
    : reduced;
}

export function sessionFlowReducer(
  state: SessionFlowState,
  action: SessionFlowAction,
): SessionFlowState {
  if (action.type === "reset") {
    return action.sessionId
      ? { ...EMPTY_SESSION_FLOW_STATE, sessionId: action.sessionId }
      : EMPTY_SESSION_FLOW_STATE;
  }
  if (action.type === "retarget") {
    return { ...state, sessionId: action.sessionId };
  }
  if (action.type === "hydrate") {
    return action.events.reduce<SessionFlowState>(
      (current, event) => reduceEvent(current, event),
      { ...EMPTY_SESSION_FLOW_STATE, sessionId: action.sessionId },
    );
  }
  const actionSession = String(action.sessionId || "").trim();
  const stateSession = String(state.sessionId || "").trim();
  if (actionSession && stateSession && actionSession !== stateSession) {
    return state;
  }
  const scopedState =
    actionSession && !stateSession
      ? { ...state, sessionId: actionSession }
      : state;
  return reduceEvent(scopedState, action.event);
}

export function recentSessionFlowNodes(
  state: SessionFlowState,
  limit = 4,
): SessionFlowNode[] {
  const normalized = Math.max(0, Math.floor(limit));
  if (normalized === 0) return [];
  return state.nodes.slice(-normalized);
}

export function sessionFlowRunCount(state: SessionFlowState): number {
  // "session" is a synthetic root for startup health/snapshot events, not an
  // LLM prompt run. Excluding it keeps the compact panel honest when the user
  // has not submitted anything yet.
  return Object.keys(state.runNodeById).filter((runId) => runId !== "session").length;
}

export function sessionFlowDepth(
  _state: SessionFlowState,
  node: SessionFlowNode,
): number {
  return Math.max(0, Math.min(5, node.depth));
}

export function sessionFlowStatusGlyph(status: SessionFlowNodeStatus): string {
  if (status === "running") return "▶";
  if (status === "succeeded") return "✓";
  if (status === "failed") return "✗";
  if (status === "blocked") return "⊘";
  if (status === "cancelled") return "■";
  if (status === "pending") return "○";
  return "·";
}

export interface SessionFlowDrawioPoint {
  x: number;
  y: number;
}

export interface SessionFlowDrawioNodeGeometry
  extends SessionFlowDrawioPoint {
  width: number;
  height: number;
}

export interface SessionFlowDrawioLayoutNode
  extends SessionFlowDrawioNodeGeometry {
  id: string;
}

export interface SessionFlowDrawioProcessGroup
  extends SessionFlowDrawioNodeGeometry {
  /** Terminal frame identity, retained for audit/debugging. */
  id: string;
  /** Semantic process vertex used by all external topology edges. */
  processNodeId: string;
  memberNodeIds: string[];
  label?: string;
}

export interface SessionFlowDrawioEdgeStyle {
  startArrow?: string;
  endArrow?: string;
  dashed?: boolean;
  dashPattern?: string;
  planned?: boolean;
  strokeColor?: string;
  statusColor?: string;
  strokeWidth?: number;
  rounded?: boolean;
}

export interface SessionFlowDrawioEdgeRoute {
  label?: string;
  waypoints?: readonly SessionFlowDrawioPoint[];
  style?: SessionFlowDrawioEdgeStyle;
}

export interface SessionFlowDrawioLayoutEdge
  extends SessionFlowDrawioEdgeRoute {
  id: string;
}

export type SessionFlowDrawioNodeGeometryInput =
  | Readonly<Record<string, SessionFlowDrawioNodeGeometry>>
  | readonly SessionFlowDrawioLayoutNode[];

export type SessionFlowDrawioEdgeRouteInput =
  | Readonly<Record<string, SessionFlowDrawioEdgeRoute>>
  | readonly SessionFlowDrawioLayoutEdge[];

export interface SessionFlowDrawioOptions {
  title?: string;
  generatedAt?: string;
  nodeGeometry?: SessionFlowDrawioNodeGeometryInput;
  edgeRoutes?: SessionFlowDrawioEdgeRouteInput;
  processGroups?: readonly SessionFlowDrawioProcessGroup[];
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function drawioNodeStyle(node: SessionFlowNode): string {
  const palette: Record<SessionFlowNodeKind, [string, string]> = {
    run: ["#dae8fc", "#6c8ebf"],
    harness: ["#fff2cc", "#d6b656"],
    goal: ["#e1d5e7", "#9673a6"],
    model: ["#f5f5f5", "#666666"],
    tool: ["#d5e8d4", "#82b366"],
    agent: ["#ffe6cc", "#d79b00"],
    workflow: ["#d0cee2", "#56517e"],
    agi: ["#f8cecc", "#b85450"],
    approval: ["#fff2cc", "#d6b656"],
    receipt: ["#e1d5e7", "#9673a6"],
    result: ["#d5e8d4", "#82b366"],
    system: ["#f5f5f5", "#666666"],
  };
  let [fill, stroke] = palette[node.kind];
  if (node.status === "failed") [fill, stroke] = ["#f8cecc", "#b85450"];
  if (node.status === "blocked") [fill, stroke] = ["#fff2cc", "#d6b656"];
  if (node.status === "running") stroke = "#1ba1e2";
  return [
    "rounded=1",
    "whiteSpace=wrap",
    "html=1",
    `fillColor=${fill}`,
    `strokeColor=${stroke}`,
    "fontSize=12",
    "spacing=8",
  ].join(";");
}

function drawioProcessGroupStyle(node: SessionFlowNode): string {
  const stroke = node.status === "failed"
    ? "#b85450"
    : node.status === "blocked" || node.status === "cancelled"
      ? "#d6b656"
      : node.status === "running"
        ? "#1ba1e2"
        : "#56517e";
  return [
    "container=1",
    "collapsible=1",
    "recursiveResize=0",
    "rounded=1",
    "whiteSpace=wrap",
    "html=1",
    "fillColor=none",
    `strokeColor=${stroke}`,
    "verticalAlign=top",
    "align=left",
    "spacingTop=4",
    "spacingLeft=8",
    "fontStyle=1",
    "fontSize=12",
  ].join(";");
}

function finiteDrawioNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Object.is(value, -0) ? 0 : value;
}

function drawioStyleValue(value: string, fallback: string): string {
  const normalized = value
    .replace(/[;=&"'<>]/g, "")
    .trim();
  return normalized || fallback;
}

function drawioNodeGeometryById(
  input: SessionFlowDrawioNodeGeometryInput | undefined,
): Map<string, SessionFlowDrawioNodeGeometry> {
  if (!input) return new Map();
  if (Array.isArray(input)) {
    return new Map(
      (input as readonly SessionFlowDrawioLayoutNode[]).map((node) => [
        node.id,
        node,
      ]),
    );
  }
  return new Map(
    Object.entries(
      input as Readonly<Record<string, SessionFlowDrawioNodeGeometry>>,
    ),
  );
}

function drawioEdgeRouteById(
  input: SessionFlowDrawioEdgeRouteInput | undefined,
): Map<string, SessionFlowDrawioEdgeRoute> {
  if (!input) return new Map();
  if (Array.isArray(input)) {
    return new Map(
      (input as readonly SessionFlowDrawioLayoutEdge[]).map((edge) => [
        edge.id,
        edge,
      ]),
    );
  }
  return new Map(
    Object.entries(
      input as Readonly<Record<string, SessionFlowDrawioEdgeRoute>>,
    ),
  );
}

function drawioEdgeStyle(
  edge: SessionFlowEdge,
  explicit: SessionFlowDrawioEdgeStyle | undefined,
): string {
  const defaultDashed =
    edge.kind === "contains" || edge.kind === "handoff";
  const dashed =
    explicit?.dashed ??
    (explicit?.planned == null ? defaultDashed : explicit.planned);
  const defaultColor =
    edge.kind === "contains"
      ? "#00838f"
      : edge.kind === "handoff"
        ? "#d79b00"
        : "#0288d1";
  const strokeColor =
    explicit?.statusColor ||
    explicit?.strokeColor ||
    defaultColor;
  const startArrow = drawioStyleValue(explicit?.startArrow || "none", "none");
  const defaultEndArrow = edge.kind === "contains" ? "none" : "classic";
  const endArrow = drawioStyleValue(
    explicit?.endArrow || defaultEndArrow,
    defaultEndArrow,
  );
  const dashPattern = explicit?.dashPattern
    ? drawioStyleValue(explicit.dashPattern, "")
    : edge.kind === "contains"
      ? "1 4"
      : edge.kind === "handoff"
        ? "8 4"
        : "";
  const strokeWidth =
    explicit?.strokeWidth != null && Number.isFinite(explicit.strokeWidth)
      ? Math.max(0, explicit.strokeWidth)
      : null;
  const parts = [
    "edgeStyle=orthogonalEdgeStyle",
    `rounded=${explicit?.rounded ? 1 : 0}`,
    "orthogonalLoop=1",
    "jettySize=auto",
    "html=1",
    `startArrow=${startArrow}`,
    `endArrow=${endArrow}`,
    `dashed=${dashed ? 1 : 0}`,
  ];
  if (strokeColor) {
    parts.push(
      `strokeColor=${drawioStyleValue(strokeColor, defaultColor || "#666666")}`,
    );
  }
  if (dashPattern) parts.push(`dashPattern=${dashPattern}`);
  if (strokeWidth != null) parts.push(`strokeWidth=${strokeWidth}`);
  return `${parts.join(";")};`;
}

function drawioEdgeGeometry(route: SessionFlowDrawioEdgeRoute | undefined): string {
  const waypoints = (route?.waypoints ?? []).filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
  );
  if (waypoints.length === 0) {
    return '<mxGeometry relative="1" as="geometry"/>';
  }
  const points = waypoints
    .map(
      (point) =>
        `<mxPoint x="${finiteDrawioNumber(point.x, 0)}" ` +
        `y="${finiteDrawioNumber(point.y, 0)}"/>`,
    )
    .join("");
  return (
    '<mxGeometry relative="1" as="geometry">' +
    `<Array as="points">${points}</Array>` +
    "</mxGeometry>"
  );
}

export function sessionFlowToDrawioXml(
  state: SessionFlowState,
  options: SessionFlowDrawioOptions = {},
): string {
  const title = observableText(options.title || "Sophia TUI Session Flow", 120);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const explicitNodeGeometry = drawioNodeGeometryById(options.nodeGeometry);
  const explicitEdgeRoutes = drawioEdgeRouteById(options.edgeRoutes);
  const processGroupByNodeId = new Map(
    (options.processGroups ?? []).map((group) => [group.processNodeId, group]),
  );
  const processGroupByMemberId = new Map<string, SessionFlowDrawioProcessGroup>();
  for (const group of options.processGroups ?? []) {
    for (const memberId of group.memberNodeIds) {
      processGroupByMemberId.set(memberId, group);
    }
  }
  const nodeIds = new Map<string, string>();
  state.nodes.forEach((node, index) => {
    nodeIds.set(node.id, `n${index + 2}`);
  });
  const cells = state.nodes
    .map((node, index) => {
      const depth = sessionFlowDepth(state, node);
      const fallback = {
        x: 40 + depth * 250,
        y: 40 + index * 88,
        width: 210,
        height: 58,
      };
      const processGroup = processGroupByNodeId.get(node.id);
      const explicit = explicitNodeGeometry.get(node.id) ?? processGroup;
      const parentGroup = processGroupByMemberId.get(node.id);
      const absoluteX = finiteDrawioNumber(
        explicit?.x ?? fallback.x,
        fallback.x,
      );
      const absoluteY = finiteDrawioNumber(
        explicit?.y ?? fallback.y,
        fallback.y,
      );
      const x = parentGroup ? absoluteX - parentGroup.x : absoluteX;
      const y = parentGroup ? absoluteY - parentGroup.y : absoluteY;
      const width = Math.max(
        0,
        finiteDrawioNumber(explicit?.width ?? fallback.width, fallback.width),
      );
      const height = Math.max(
        0,
        finiteDrawioNumber(explicit?.height ?? fallback.height, fallback.height),
      );
      const value = [
        `${sessionFlowStatusGlyph(node.status)} ${node.label}`,
        node.detail,
      ]
        .filter(Boolean)
        .join("\n");
      const sourceNodeIds = node.provenance?.sourceNodeIds.join(",") || node.id;
      const sourceEventTypes =
        node.provenance?.sourceEventTypes.join(",") || node.eventType;
      const hiddenEventCount = node.provenance?.hiddenEventCount || 0;
      const parentCellId = parentGroup
        ? nodeIds.get(parentGroup.processNodeId) || "1"
        : "1";
      return (
        `<mxCell id="${nodeIds.get(node.id)}" value="${xmlEscape(value).replaceAll("\n", "&#xa;")}" ` +
        `sophiaSourceNodeIds="${xmlEscape(sourceNodeIds)}" ` +
        `sophiaSourceEventTypes="${xmlEscape(sourceEventTypes)}" ` +
        `sophiaHiddenEventCount="${hiddenEventCount}" ` +
        `style="${processGroup ? drawioProcessGroupStyle(node) : drawioNodeStyle(node)}" ` +
        `vertex="1" parent="${parentCellId}"${processGroup ? ' collapsed="0"' : ""}>` +
        `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/>` +
        "</mxCell>"
      );
    })
    .join("");
  const edges = state.edges
    .map((edge, index) => {
      const source = nodeIds.get(edge.source);
      const target = nodeIds.get(edge.target);
      if (!source || !target) return "";
      const route = explicitEdgeRoutes.get(edge.id);
      const label = observableText(route?.label || edge.kind, 80);
      return (
        `<mxCell id="e${index + 2}" value="${xmlEscape(label)}" ` +
        `style="${xmlEscape(drawioEdgeStyle(edge, route?.style))}" ` +
        `edge="1" parent="1" source="${source}" target="${target}">` +
        drawioEdgeGeometry(route) +
        "</mxCell>"
      );
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<mxfile host="app.diagrams.net" modified="${xmlEscape(generatedAt)}" ` +
    'agent="Sophia TUI" version="1" type="device">' +
    `<diagram id="sophia-session-flow" name="${xmlEscape(title)}">` +
    '<mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" ' +
    'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" ' +
    'pageHeight="827" math="0" shadow="0" candidateOnly="true" ' +
    'canClaimAGI="false"><root><mxCell id="0"/>' +
    '<mxCell id="1" parent="0"/>' +
    `${cells}${edges}</root></mxGraphModel></diagram></mxfile>`
  );
}

function safeFilePart(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "session";
}

export function writeSessionFlowDrawio(
  state: SessionFlowState,
  options: {
    sessionId?: string;
    outDir?: string;
    generatedAt?: string;
    nodeGeometry?: SessionFlowDrawioNodeGeometryInput;
    edgeRoutes?: SessionFlowDrawioEdgeRouteInput;
    processGroups?: readonly SessionFlowDrawioProcessGroup[];
  } = {},
): string {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const outDir =
    options.outDir ||
    path.join(os.homedir(), ".sophia", "exports", "session-flows");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const fileName = `${safeFilePart(options.sessionId || "session")}-${stamp}.drawio`;
  const target = path.join(outDir, fileName);
  const temporary = `${target}.tmp`;
  writeFileSync(
    temporary,
    sessionFlowToDrawioXml(state, {
      title: `Sophia Session ${options.sessionId || "Flow"}`,
      generatedAt,
      nodeGeometry: options.nodeGeometry,
      edgeRoutes: options.edgeRoutes,
      processGroups: options.processGroups,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporary, target);
  return target;
}
