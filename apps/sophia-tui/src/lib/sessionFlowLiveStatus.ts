import type {
  DynamicWorkflowAgent,
  DynamicWorkflowAgentStatus,
  DynamicWorkflowStage,
  DynamicWorkflowState,
} from "./dynamicWorkflowState.js";
import type {
  AGIWorkflowAgent,
  AGIWorkflowAgentStatus,
  AGIWorkflowState,
} from "./agiWorkflowState.js";
import { sanitizeToolText } from "./toolOutput.js";

const MAX_DETAIL_LINES = 6;
const MAX_LINE_LENGTH = 112;
const MAX_ACTIVITY_LENGTH = 84;

const NON_OPERATIONAL_TEXT =
  /(?:chain[\s_-]*of[\s_-]*thought|hidden reasoning|private reasoning|reasoning tokens?|thinking tokens?|raw tokens?|<\s*think(?:ing)?\b|\[\s*(?:thinking|reasoning)\s*\])/i;

export type SessionFlowCompoundTone =
  | "dim"
  | "accent"
  | "warning"
  | "success"
  | "danger";

/**
 * Kept structurally aligned with SessionFlowNodeStatus without importing the
 * session-flow reducer (and its bridge/UI dependency graph) into this pure
 * projection module.
 */
export type SessionFlowLiveNodeStatus =
  | "info"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export interface SessionFlowStatusCounts {
  activeCount: number;
  queuedCount: number;
  waitingCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
}

export interface SessionFlowCompoundStatus extends SessionFlowStatusCounts {
  status: SessionFlowLiveNodeStatus;
  tone: SessionFlowCompoundTone;
  title: string;
  phase: string;
  progressCurrent: number;
  progressTotal: number;
  barrierCurrent: number;
  barrierTotal: number;
  reportCount: number;
  latestActor: string;
  latestActivity: string;
  progressLabel: string;
  detailLines: string[];
  expandable: boolean;
}

export interface SessionFlowStageStatus extends SessionFlowCompoundStatus {
  id: string;
  index: number;
  label: string;
  pattern: string;
  workerCount: number;
}

export interface SessionFlowWorkerStatus {
  id: string;
  label: string;
  status: SessionFlowLiveNodeStatus;
  tone: SessionFlowCompoundTone;
  stageIndex: number;
  active: boolean;
  queued: boolean;
  archived: boolean;
  warmLease: boolean;
  role: string;
  reuseCount: number;
  latestActivity: string;
  progressLabel: string;
  detailLines: string[];
  expandable: false;
}

interface AgentCounts extends SessionFlowStatusCounts {
  resolvedCount: number;
  reportCount: number;
}

interface DynamicAgentEntry {
  stage: DynamicWorkflowStage;
  agent: DynamicWorkflowAgent;
}

function boundedText(value: unknown, max = MAX_LINE_LENGTH): string {
  const text = sanitizeToolText(
    value,
    false,
    Math.max(512, max * 4),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!text || NON_OPERATIONAL_TEXT.test(text)) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function boundedLines(values: readonly unknown[]): string[] {
  return values
    .map((value) => boundedText(value))
    .filter(Boolean)
    .slice(0, MAX_DETAIL_LINES);
}

function displayStatus(value: string): string {
  return boundedText(value.replaceAll("_", " "), 48);
}

function toneForStatus(
  status: SessionFlowLiveNodeStatus,
): SessionFlowCompoundTone {
  if (status === "running") return "accent";
  if (status === "blocked") return "warning";
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  return "dim";
}

function dynamicAgentIsActive(agent: DynamicWorkflowAgent): boolean {
  return ["spawning", "running", "verifying"].includes(agent.status)
    || (agent.active && agent.status !== "waiting_input");
}

function dynamicAgentIsQueued(status: DynamicWorkflowAgentStatus): boolean {
  return status === "queued" || status === "queued_for_model";
}

function dynamicAgentIsFailed(status: DynamicWorkflowAgentStatus): boolean {
  return [
    "failed",
    "cancelled",
    "timed_out",
    "lost",
    "needs_reconciliation",
    "skipped",
    "unstarted",
  ].includes(status);
}

function dynamicAgentIsResolved(status: DynamicWorkflowAgentStatus): boolean {
  return [
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "lost",
    "needs_reconciliation",
    "skipped",
  ].includes(status);
}

function agiAgentIsActive(status: AGIWorkflowAgentStatus): boolean {
  return ["leased", "spawning", "running", "verifying"].includes(status);
}

function agiAgentIsQueued(status: AGIWorkflowAgentStatus): boolean {
  return status === "queued" || status === "queued_for_model";
}

function agiAgentIsFailed(status: AGIWorkflowAgentStatus): boolean {
  return ["failed", "timed_out", "lost", "unstarted"].includes(status);
}

function agiAgentIsResolved(status: AGIWorkflowAgentStatus): boolean {
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

function emptyCounts(): AgentCounts {
  return {
    activeCount: 0,
    queuedCount: 0,
    waitingCount: 0,
    succeededCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    resolvedCount: 0,
    reportCount: 0,
  };
}

function countDynamicAgents(
  agents: readonly DynamicWorkflowAgent[],
): AgentCounts {
  const counts = emptyCounts();
  for (const agent of agents) {
    if (dynamicAgentIsActive(agent)) counts.activeCount += 1;
    if (dynamicAgentIsQueued(agent.status)) counts.queuedCount += 1;
    if (agent.status === "waiting_input") counts.waitingCount += 1;
    if (agent.status === "succeeded") {
      counts.succeededCount += 1;
      counts.reportCount += 1;
    }
    if (dynamicAgentIsFailed(agent.status)) counts.failedCount += 1;
    if (agent.status === "cancelled") counts.cancelledCount += 1;
    if (dynamicAgentIsResolved(agent.status)) counts.resolvedCount += 1;
  }
  return counts;
}

function countAGIAgents(agents: readonly AGIWorkflowAgent[]): AgentCounts {
  const counts = emptyCounts();
  for (const agent of agents) {
    if (agiAgentIsActive(agent.status)) counts.activeCount += 1;
    if (agiAgentIsQueued(agent.status)) counts.queuedCount += 1;
    if (agent.status === "waiting_input") counts.waitingCount += 1;
    if (agent.status === "succeeded") {
      counts.succeededCount += 1;
      counts.reportCount += 1;
    }
    if (agiAgentIsFailed(agent.status)) counts.failedCount += 1;
    if (agent.status === "cancelled") counts.cancelledCount += 1;
    if (agiAgentIsResolved(agent.status)) counts.resolvedCount += 1;
  }
  return counts;
}

function addCounts(a: AgentCounts, b: AgentCounts): AgentCounts {
  return {
    activeCount: a.activeCount + b.activeCount,
    queuedCount: a.queuedCount + b.queuedCount,
    waitingCount: a.waitingCount + b.waitingCount,
    succeededCount: a.succeededCount + b.succeededCount,
    failedCount: a.failedCount + b.failedCount,
    cancelledCount: a.cancelledCount + b.cancelledCount,
    resolvedCount: a.resolvedCount + b.resolvedCount,
    reportCount: a.reportCount + b.reportCount,
  };
}

function dynamicEntries(
  state: DynamicWorkflowState,
): DynamicAgentEntry[] {
  return state.stages.flatMap((stage) =>
    stage.agents.map((agent) => ({ stage, agent }))
  );
}

function dynamicEntryActivity(entry: DynamicAgentEntry): string {
  return boundedText(
    entry.agent.progress || entry.agent.summary || displayStatus(entry.agent.status),
    MAX_ACTIVITY_LENGTH,
  );
}

function selectLatestDynamicEntry(
  entries: readonly DynamicAgentEntry[],
): DynamicAgentEntry | null {
  const candidates = entries.filter((entry) =>
    dynamicEntryActivity(entry) || boundedText(entry.agent.name, 64)
  );
  return candidates.slice().sort((a, b) => {
    const active = Number(dynamicAgentIsActive(b.agent))
      - Number(dynamicAgentIsActive(a.agent));
    if (active) return active;
    const meaningful = Number(Boolean(dynamicEntryActivity(b)))
      - Number(Boolean(dynamicEntryActivity(a)));
    if (meaningful) return meaningful;
    const stage = b.stage.index - a.stage.index;
    if (stage) return stage;
    const agent = b.agent.index - a.agent.index;
    if (agent) return agent;
    return a.agent.name.localeCompare(b.agent.name);
  })[0] ?? null;
}

function timestampRank(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function agiAgentActivity(agent: AGIWorkflowAgent): string {
  const progress = boundedText(agent.progress, MAX_ACTIVITY_LENGTH);
  if (progress) return progress;
  const tool = boundedText(agent.currentTool, 56);
  if (tool) return `tool ${tool}`;
  return boundedText(
    agent.currentStatus || displayStatus(agent.status),
    MAX_ACTIVITY_LENGTH,
  );
}

function selectLatestAGIAgent(
  activeAgents: readonly AGIWorkflowAgent[],
  recentAgents: readonly AGIWorkflowAgent[],
): AGIWorkflowAgent | null {
  const active = activeAgents.map((agent) => ({ agent, active: true }));
  const recent = recentAgents.map((agent) => ({ agent, active: false }));
  return [...active, ...recent].sort((a, b) => {
    const activeOrder = Number(b.active) - Number(a.active);
    if (activeOrder) return activeOrder;
    const meaningful = Number(Boolean(agiAgentActivity(b.agent)))
      - Number(Boolean(agiAgentActivity(a.agent)));
    if (meaningful) return meaningful;
    const time = timestampRank(b.agent.updatedAt || b.agent.endedAt)
      - timestampRank(a.agent.updatedAt || a.agent.endedAt);
    if (time) return time;
    const stage = b.agent.stage - a.agent.stage;
    if (stage) return stage;
    return (
      a.agent.key || a.agent.id || a.agent.name
    ).localeCompare(b.agent.key || b.agent.id || b.agent.name);
  })[0]?.agent ?? null;
}

function dynamicOverallStatus(
  state: DynamicWorkflowState,
  counts: AgentCounts,
): SessionFlowLiveNodeStatus {
  if (state.status === "failed" || counts.failedCount > 0) return "failed";
  if (state.status === "awaiting_input" || counts.waitingCount > 0) {
    return "blocked";
  }
  if (state.status === "succeeded") return "succeeded";
  if (
    counts.cancelledCount > 0
    && counts.activeCount === 0
    && counts.queuedCount === 0
  ) {
    return "cancelled";
  }
  if (
    state.active
    || ["routing", "running", "reviewing", "synthesizing"].includes(state.status)
    || counts.activeCount > 0
  ) {
    return "running";
  }
  if (counts.queuedCount > 0) return "pending";
  return "info";
}

function dynamicStageStatus(
  stage: DynamicWorkflowStage,
  counts: AgentCounts,
): SessionFlowLiveNodeStatus {
  if (stage.status === "failed" || counts.failedCount > 0) return "failed";
  if (counts.waitingCount > 0) return "blocked";
  if (
    counts.cancelledCount > 0
    && counts.activeCount === 0
    && counts.queuedCount === 0
  ) {
    return "cancelled";
  }
  if (stage.status === "succeeded") return "succeeded";
  if (
    stage.status === "running"
    || stage.status === "reviewing"
    || counts.activeCount > 0
  ) {
    return "running";
  }
  return "pending";
}

function agiOverallStatus(
  state: AGIWorkflowState,
  counts: AgentCounts,
): SessionFlowLiveNodeStatus {
  const terminalStatus = state.terminalStatus || state.status;
  if (state.terminal) {
    if (terminalStatus === "succeeded") return "succeeded";
    if (terminalStatus === "failed") return "failed";
    if (terminalStatus === "cancelled" || terminalStatus === "interrupted") {
      return "cancelled";
    }
    if (
      terminalStatus === "awaiting_input"
      || terminalStatus === "candidate_complete"
    ) {
      return "blocked";
    }
  }
  if (
    state.status === "failed"
    || state.currentNode?.status === "failed"
    || state.workflow?.status === "failed"
    || state.workflow?.barrier.status === "failed"
    || counts.failedCount > 0
  ) {
    return "failed";
  }
  if (
    state.status === "cancelled"
    || state.status === "interrupted"
    || state.currentNode?.status === "cancelled"
    || state.currentNode?.status === "interrupted"
  ) {
    return "cancelled";
  }
  if (
    state.status === "awaiting_input"
    || state.currentNode?.status === "awaiting_input"
    || counts.waitingCount > 0
  ) {
    return "blocked";
  }
  if (state.status === "succeeded") return "succeeded";
  if (
    state.active
    || state.status === "routing"
    || state.status === "running"
    || counts.activeCount > 0
  ) {
    return "running";
  }
  if (counts.queuedCount > 0 || state.route === "pending") return "pending";
  return "info";
}

function dynamicProgressLabel(
  state: DynamicWorkflowState,
  currentStage: DynamicWorkflowStage | null,
  stageCounts: AgentCounts,
): string {
  if (state.status === "synthesizing") return "Final synthesis";
  if (!currentStage) {
    return state.status === "routing" ? "Planning first stage" : "No stage dispatched";
  }
  const max = state.maxStages > 0 ? `/${state.maxStages}` : "";
  if (currentStage.agents.length === 0) {
    return `Stage ${currentStage.index}${max} · barrier pending`;
  }
  return `Stage ${currentStage.index}${max} · barrier ${stageCounts.resolvedCount}/${currentStage.agents.length}`;
}

function dynamicWorkerStatus(
  agent: DynamicWorkflowAgent,
): SessionFlowLiveNodeStatus {
  if (agent.status === "cancelled") return "cancelled";
  if (dynamicAgentIsFailed(agent.status)) return "failed";
  if (agent.status === "waiting_input") return "blocked";
  if (agent.status === "succeeded") return "succeeded";
  if (dynamicAgentIsActive(agent)) return "running";
  if (dynamicAgentIsQueued(agent.status)) return "pending";
  return "info";
}

function agiWorkerStatus(
  agent: AGIWorkflowAgent,
): SessionFlowLiveNodeStatus {
  if (agiAgentIsFailed(agent.status)) return "failed";
  if (agent.status === "waiting_input") return "blocked";
  if (agent.status === "cancelled") return "cancelled";
  if (agent.status === "succeeded") return "succeeded";
  if (agiAgentIsActive(agent.status)) return "running";
  if (agiAgentIsQueued(agent.status)) return "pending";
  return "info";
}

function stableIdPart(value: string, fallback: string): string {
  const normalized = boundedText(value, 96)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function countLine(counts: SessionFlowStatusCounts): string {
  return [
    `${counts.activeCount} active`,
    `${counts.queuedCount} queued`,
    counts.waitingCount > 0 ? `${counts.waitingCount} waiting` : "",
    `${counts.succeededCount} succeeded`,
    `${counts.failedCount} failed`,
    counts.cancelledCount > 0 ? `${counts.cancelledCount} cancelled` : "",
  ].filter(Boolean).join(" · ");
}

export function dynamicWorkflowCompoundStatus(
  state: DynamicWorkflowState,
): SessionFlowCompoundStatus {
  const entries = dynamicEntries(state);
  const counts = countDynamicAgents(entries.map((entry) => entry.agent));
  const currentStage = state.stages.find(
    (stage) => stage.index === state.currentStage,
  ) ?? state.stages.slice().sort((a, b) => b.index - a.index)[0] ?? null;
  const stageCounts = countDynamicAgents(currentStage?.agents ?? []);
  const latest = selectLatestDynamicEntry(entries);
  const status = dynamicOverallStatus(state, counts);
  const progressCurrent = Math.max(0, state.currentStage);
  const progressTotal = Math.max(0, state.maxStages);
  const latestActor = boundedText(latest?.agent.name, 64);
  const latestActivity = latest ? dynamicEntryActivity(latest) : "";
  const stageLabel = currentStage
    ? `Stage ${currentStage.index}${state.maxStages > 0 ? `/${state.maxStages}` : ""}`
    : "Stage pending";
  const barrierLine = currentStage && currentStage.agents.length > 0
    ? `Barrier ${stageCounts.resolvedCount}/${currentStage.agents.length} resolved · ${stageCounts.reportCount} report${stageCounts.reportCount === 1 ? "" : "s"} succeeded`
    : "Barrier pending";
  return {
    status,
    tone: toneForStatus(status),
    title: "Workflow",
    phase: boundedText(displayStatus(state.phase || state.status), 64),
    progressCurrent,
    progressTotal,
    barrierCurrent: stageCounts.resolvedCount,
    barrierTotal: currentStage?.agents.length ?? 0,
    reportCount: stageCounts.reportCount,
    activeCount: counts.activeCount,
    queuedCount: counts.queuedCount,
    waitingCount: counts.waitingCount,
    succeededCount: counts.succeededCount,
    failedCount: counts.failedCount,
    cancelledCount: counts.cancelledCount,
    latestActor,
    latestActivity,
    progressLabel: boundedText(
      dynamicProgressLabel(state, currentStage, stageCounts),
      96,
    ),
    detailLines: boundedLines([
      `${stageLabel} · ${displayStatus(state.status)}`,
      currentStage?.pattern || state.pattern
        ? `Pattern ${currentStage?.pattern || state.pattern}`
        : "",
      barrierLine,
      `Workers ${countLine(counts)}`,
      latestActor && latestActivity
        ? `Latest ${latestActor} · ${latestActivity}`
        : "",
      state.reason ? `Detail ${state.reason}` : "",
    ]),
    expandable: state.stages.length > 0,
  };
}

export function selectDynamicWorkflowStageStatuses(
  state: DynamicWorkflowState,
): SessionFlowStageStatus[] {
  return state.stages
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((stage) => {
      const counts = countDynamicAgents(stage.agents);
      const latest = selectLatestDynamicEntry(
        stage.agents.map((agent) => ({ stage, agent })),
      );
      const status = dynamicStageStatus(stage, counts);
      const label = `Stage ${stage.index}`;
      const latestActor = boundedText(latest?.agent.name, 64);
      const latestActivity = latest ? dynamicEntryActivity(latest) : "";
      return {
        id: `dynamic-workflow-stage:${stage.index}`,
        index: stage.index,
        label,
        pattern: boundedText(stage.pattern, 64),
        workerCount: stage.agents.length,
        status,
        tone: toneForStatus(status),
        title: label,
        phase: boundedText(displayStatus(stage.status), 64),
        progressCurrent: counts.resolvedCount,
        progressTotal: stage.agents.length,
        barrierCurrent: counts.resolvedCount,
        barrierTotal: stage.agents.length,
        reportCount: counts.reportCount,
        activeCount: counts.activeCount,
        queuedCount: counts.queuedCount,
        waitingCount: counts.waitingCount,
        succeededCount: counts.succeededCount,
        failedCount: counts.failedCount,
        cancelledCount: counts.cancelledCount,
        latestActor,
        latestActivity,
        progressLabel: boundedText(
          stage.agents.length > 0
            ? `Barrier ${counts.resolvedCount}/${stage.agents.length} · ${counts.reportCount} reports`
            : "Barrier pending",
          96,
        ),
        detailLines: boundedLines([
          stage.pattern ? `Pattern ${stage.pattern}` : "",
          stage.goal ? `Goal ${stage.goal}` : "",
          `Workers ${countLine(counts)}`,
          stage.maxConcurrency != null
            ? `Concurrency ${stage.maxConcurrency}`
            : "",
          latestActor && latestActivity
            ? `Latest ${latestActor} · ${latestActivity}`
            : "",
        ]),
        expandable: stage.agents.length > 0,
      };
    });
}

export function selectDynamicWorkflowWorkerStatuses(
  state: DynamicWorkflowState,
  stageIndex?: number,
): SessionFlowWorkerStatus[] {
  return state.stages
    .slice()
    .sort((a, b) => a.index - b.index)
    .filter((stage) => stageIndex == null || stage.index === stageIndex)
    .flatMap((stage) =>
      stage.agents
        .slice()
        .sort((a, b) => a.index - b.index || a.name.localeCompare(b.name))
        .map((agent) => {
          const status = dynamicWorkerStatus(agent);
          const activity = boundedText(
            agent.progress || agent.summary || displayStatus(agent.status),
            MAX_ACTIVITY_LENGTH,
          );
          const label = boundedText(agent.name, 64)
            || `Worker ${agent.index + 1}`;
          return {
            id: `dynamic-workflow-worker:${stage.index}:${agent.index}:${stableIdPart(label, "worker")}`,
            label,
            status,
            tone: toneForStatus(status),
            stageIndex: stage.index,
            active: dynamicAgentIsActive(agent),
            queued: dynamicAgentIsQueued(agent.status),
            archived: false,
            warmLease: false,
            role: boundedText(agent.role, 64),
            reuseCount: 0,
            latestActivity: activity,
            progressLabel: boundedText(
              agent.progress || displayStatus(agent.status),
              96,
            ),
            detailLines: boundedLines([
              agent.role ? `Role ${agent.role}` : "",
              agent.skills.length > 0
                ? `Skills ${agent.skills.join(", ")}`
                : "",
              agent.progress ? `Progress ${agent.progress}` : "",
              agent.summary ? `Summary ${agent.summary}` : "",
            ]),
            expandable: false as const,
          };
        })
    );
}

export function agiWorkflowCompoundStatus(
  state: AGIWorkflowState,
): SessionFlowCompoundStatus {
  const activeCounts = countAGIAgents(state.activeAgents);
  const recentCounts = countAGIAgents(state.recentAgents);
  const counts = addCounts(activeCounts, recentCounts);
  const latest = selectLatestAGIAgent(state.activeAgents, state.recentAgents);
  const status = agiOverallStatus(state, activeCounts);
  const workflow = state.workflow;
  const nodeTitle = boundedText(state.currentNode?.title, 64);
  const title = nodeTitle || "AGI workflow";
  const stage = workflow?.currentStage || workflow?.barrier.stage || 0;
  const maxStages = workflow?.maxStages || 0;
  const barrierCurrent = workflow?.barrier.completed || 0;
  const barrierTotal = workflow?.barrier.total || 0;
  const latestActor = boundedText(latest?.name || latest?.workerId, 64);
  const latestActivity = latest ? agiAgentActivity(latest) : "";
  const nodeLine = state.currentNode
    ? `Node ${state.currentNode.index || "?"} · ${state.currentNode.title || state.currentNode.id} · route ${state.route}`
    : `Node pending · route ${state.route}`;
  const workflowLine = workflow
    ? `${workflow.pattern || "Nested workflow"} · stage ${stage || "?"}${maxStages > 0 ? `/${maxStages}` : ""} · barrier ${barrierCurrent}/${barrierTotal || "?"} ${displayStatus(workflow.barrier.status)}`
    : state.route === "solo"
      ? "Solo execution"
      : "Nested workflow pending";
  const terminalLine = state.terminal
    ? `Terminal ${displayStatus(state.terminalStatus || state.status)}${
        state.terminalReason ? ` · ${state.terminalReason}` : ""
      }`
    : "";
  const phase = state.terminal
    ? `terminal · ${displayStatus(state.terminalStatus || state.status)}`
    : state.currentNode
      ? `node ${state.currentNode.index || "?"} · ${displayStatus(state.currentNode.status)}`
      : displayStatus(state.status);
  return {
    status,
    tone: toneForStatus(status),
    title,
    phase: boundedText(phase, 64),
    progressCurrent: stage || Math.max(0, state.currentNode?.index || 0),
    progressTotal: maxStages,
    barrierCurrent,
    barrierTotal,
    reportCount: recentCounts.reportCount,
    activeCount: activeCounts.activeCount,
    queuedCount: activeCounts.queuedCount,
    waitingCount: activeCounts.waitingCount,
    succeededCount: counts.succeededCount,
    failedCount: counts.failedCount,
    cancelledCount: counts.cancelledCount,
    latestActor,
    latestActivity,
    progressLabel: boundedText(
      workflow
        ? `Stage ${stage || "?"}${maxStages > 0 ? `/${maxStages}` : ""} · barrier ${barrierCurrent}/${barrierTotal || "?"}`
        : state.currentNode
          ? `Node ${state.currentNode.index || "?"} · route ${state.route}`
          : `Route ${state.route}`,
      96,
    ),
    detailLines: boundedLines([
      nodeLine,
      workflowLine,
      `Workers ${countLine(activeCounts)} · ${state.warmPoolSize} warm lease${state.warmPoolSize === 1 ? "" : "s"}`,
      state.reuseCount > 0
        ? `Reuse ${state.reuseCount}${state.lastReuseReason ? ` · ${state.lastReuseReason}` : ""}`
        : "",
      latestActor && latestActivity
        ? `Latest ${latestActor} · ${latestActivity}`
        : "",
      terminalLine,
    ]),
    expandable: Boolean(
      state.currentNode
      || state.workflow
      || state.activeAgents.length
      || state.warmIdleLeases.length
      || state.recentAgents.length
      || state.terminal
    ),
  };
}

export function selectAGIWorkflowStageStatuses(
  state: AGIWorkflowState,
): SessionFlowStageStatus[] {
  const workflow = state.workflow;
  if (!workflow) return [];
  const stageIndex = workflow.currentStage || workflow.barrier.stage;
  const currentNodeId = state.currentNode?.id || "";
  const belongsToCurrentNode = (nodeId: string): boolean =>
    currentNodeId ? nodeId === currentNodeId : true;
  const currentAgents = state.activeAgents.filter(
    (agent) => agent.stage === 0 || agent.stage === stageIndex,
  );
  const recentAgents = state.recentAgents.filter(
    (agent) =>
      belongsToCurrentNode(agent.nodeId)
      && (agent.stage === 0 || agent.stage === stageIndex),
  );
  const activeCounts = countAGIAgents(currentAgents);
  const recentCounts = countAGIAgents(recentAgents);
  const counts = addCounts(activeCounts, recentCounts);
  const latest = selectLatestAGIAgent(currentAgents, recentAgents);
  const failed = workflow.barrier.status === "failed"
    || workflow.status === "failed"
    || counts.failedCount > 0;
  const waiting = counts.waitingCount > 0;
  const terminalSucceeded = workflow.status === "succeeded";
  const status: SessionFlowLiveNodeStatus = failed
    ? "failed"
    : waiting
      ? "blocked"
      : terminalSucceeded
        ? "succeeded"
        : workflow.status === "cancelled" || workflow.status === "interrupted"
          ? "cancelled"
          : workflow.status === "running"
              || workflow.barrier.status === "running"
              || activeCounts.activeCount > 0
            ? "running"
            : "pending";
  const label = stageIndex > 0 ? `Stage ${stageIndex}` : "Workflow stage";
  const latestActor = boundedText(latest?.name || latest?.workerId, 64);
  const latestActivity = latest ? agiAgentActivity(latest) : "";
  return [{
    id: `agi-workflow-stage:${stableIdPart(workflow.id, "workflow")}:${stageIndex}`,
    index: stageIndex,
    label,
    pattern: boundedText(workflow.pattern, 64),
    workerCount: currentAgents.length + recentAgents.length,
    status,
    tone: toneForStatus(status),
    title: label,
    phase: boundedText(displayStatus(workflow.barrier.status), 64),
    progressCurrent: workflow.barrier.completed,
    progressTotal: workflow.barrier.total,
    barrierCurrent: workflow.barrier.completed,
    barrierTotal: workflow.barrier.total,
    reportCount: recentCounts.reportCount,
    activeCount: activeCounts.activeCount,
    queuedCount: activeCounts.queuedCount,
    waitingCount: activeCounts.waitingCount,
    succeededCount: counts.succeededCount,
    failedCount: counts.failedCount,
    cancelledCount: counts.cancelledCount,
    latestActor,
    latestActivity,
    progressLabel: boundedText(
      `Barrier ${workflow.barrier.completed}/${workflow.barrier.total || "?"} · ${displayStatus(workflow.barrier.status)}`,
      96,
    ),
    detailLines: boundedLines([
      workflow.pattern ? `Pattern ${workflow.pattern}` : "",
      `Barrier ${workflow.barrier.completed}/${workflow.barrier.total || "?"} · ${displayStatus(workflow.barrier.status)}`,
      `Workers ${countLine(activeCounts)}`,
      latestActor && latestActivity
        ? `Latest ${latestActor} · ${latestActivity}`
        : "",
      workflow.evidenceSummary
        ? `Evidence ${workflow.evidenceSummary}`
        : "",
    ]),
    expandable: currentAgents.length + recentAgents.length > 0,
  }];
}

function agiWorkerProjection(
  agent: AGIWorkflowAgent,
  options: {
    archived: boolean;
    index: number;
  },
): SessionFlowWorkerStatus {
  const status = agiWorkerStatus(agent);
  const label = boundedText(agent.name || agent.workerId || agent.id, 64)
    || `Worker ${options.index + 1}`;
  const identity = agent.key || agent.id || agent.workerId || agent.leaseId || label;
  const activity = agiAgentActivity(agent);
  return {
    id: `agi-workflow-${options.archived ? "archive" : "worker"}:${stableIdPart(identity, String(options.index))}`,
    label,
    status,
    tone: toneForStatus(status),
    stageIndex: agent.stage,
    active: !options.archived && agiAgentIsActive(agent.status),
    queued: agiAgentIsQueued(agent.status),
    archived: options.archived,
    warmLease: false,
    role: boundedText(agent.role, 64),
    reuseCount: agent.reuseCount,
    latestActivity: activity,
    progressLabel: boundedText(
      agent.progress
        || (agent.currentTool ? `Tool ${agent.currentTool}` : displayStatus(agent.status)),
      96,
    ),
    detailLines: boundedLines([
      agent.role ? `Role ${agent.role}` : "",
      agent.progress ? `Progress ${agent.progress}` : "",
      agent.currentTool ? `Tool ${agent.currentTool}` : "",
      agent.currentStatus ? `Status ${agent.currentStatus}` : "",
      agent.evidenceSummary ? `Evidence ${agent.evidenceSummary}` : "",
      agent.reuseCount > 0
        ? `Reused ${agent.reuseCount}x${agent.reuseReason ? ` · ${agent.reuseReason}` : ""}`
        : "",
    ]),
    expandable: false,
  };
}

export function selectAGIWorkflowWorkerStatuses(
  state: AGIWorkflowState,
  options: {
    stageIndex?: number;
    includeWarmLeases?: boolean;
    includeRecent?: boolean;
    recentLimit?: number;
  } = {},
): SessionFlowWorkerStatus[] {
  const currentNodeId = state.currentNode?.id || "";
  const nodeMatches = (nodeId: string): boolean =>
    currentNodeId ? nodeId === currentNodeId : true;
  const stageMatches = (stage: number): boolean =>
    options.stageIndex == null
    || stage === 0
    || stage === options.stageIndex;
  const workers = state.activeAgents
    .filter((agent) => stageMatches(agent.stage))
    .slice()
    .sort((a, b) =>
      a.stage - b.stage
      || (a.key || a.id || a.name).localeCompare(b.key || b.id || b.name)
    )
    .map((agent, index) => agiWorkerProjection(agent, {
      archived: false,
      index,
    }));

  if (options.includeWarmLeases !== false) {
    state.warmIdleLeases
      .filter((lease) => nodeMatches(lease.nodeId) && stageMatches(lease.stage))
      .slice()
      .sort((a, b) =>
        a.stage - b.stage
        || (a.key || a.leaseId || a.name).localeCompare(
          b.key || b.leaseId || b.name,
        )
      )
      .forEach((lease, index) => {
        const label = boundedText(
          lease.name || lease.workerId || lease.leaseId,
          64,
        ) || `Warm worker ${index + 1}`;
        const identity = lease.key || lease.leaseId || lease.workerId || label;
        workers.push({
          id: `agi-workflow-lease:${stableIdPart(identity, String(index))}`,
          label,
          status: "info",
          tone: "dim",
          stageIndex: lease.stage,
          active: false,
          queued: false,
          archived: false,
          warmLease: true,
          role: boundedText(lease.role, 64),
          reuseCount: lease.reuseCount,
          latestActivity: "warm idle",
          progressLabel: "Warm idle",
          detailLines: boundedLines([
            lease.role ? `Role ${lease.role}` : "",
            `Warm lease ${lease.leaseId || lease.key}`,
            lease.reuseCount > 0
              ? `Reused ${lease.reuseCount}x${lease.reuseReason ? ` · ${lease.reuseReason}` : ""}`
              : "",
          ]),
          expandable: false,
        });
      });
  }

  if (options.includeRecent === true) {
    const limit = Math.max(
      0,
      Math.min(state.recentAgents.length, Math.floor(options.recentLimit ?? 6)),
    );
    state.recentAgents
      .filter((agent) => nodeMatches(agent.nodeId) && stageMatches(agent.stage))
      .slice(0, limit)
      .forEach((agent, index) => {
        workers.push(agiWorkerProjection(agent, {
          archived: true,
          index,
        }));
      });
  }
  return workers;
}

export const dynamicWorkflowStageStatuses =
  selectDynamicWorkflowStageStatuses;
export const dynamicWorkflowWorkerStatuses =
  selectDynamicWorkflowWorkerStatuses;
export const agiWorkflowStageStatuses = selectAGIWorkflowStageStatuses;
export const agiWorkflowWorkerStatuses = selectAGIWorkflowWorkerStatuses;
