/**
 * Live state for the cloud-only, bounded dynamic `/workflow` controller.
 *
 * This is deliberately separate from lib/workflow.ts, which models durable
 * task/workflow receipts shared by ordinary runs. The dynamic controller owns
 * a sequence of parallel A2A barriers: Main plans a stage, workers run in
 * parallel, Main reviews their reports, and may dispatch another stage.
 */

export type DynamicWorkflowMode = "off" | "auto" | "on";

export type DynamicWorkflowStatus =
  | "idle"
  | "routing"
  | "running"
  | "reviewing"
  | "synthesizing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"
  | "awaiting_input";

export type DynamicWorkflowAgentStatus =
  | "queued"
  | "queued_for_model"
  | "spawning"
  | "running"
  | "waiting_input"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost"
  | "needs_reconciliation"
  | "skipped"
  | "unstarted";

export interface DynamicWorkflowAgent {
  name: string;
  index: number;
  status: DynamicWorkflowAgentStatus;
  active: boolean;
  role: string;
  skills: string[];
  summary: string;
  progress?: string;
  failureReason?: string;
}

export interface DynamicWorkflowStage {
  index: number;
  pattern: string;
  goal: string;
  status: "queued" | "running" | "reviewing" | "succeeded" | "failed";
  maxConcurrency: number | null;
  providerConcurrencyCap?: number | null;
  concurrencyReason?: string;
  controllerRequestedTaskCount?: number;
  deferredTaskCount?: number;
  queued?: number;
  activeCount?: number;
  terminal?: number;
  succeeded?: number;
  failed?: number;
  started?: number;
  unstarted?: number;
  total?: number;
  elapsedSec?: number | null;
  estimatedRemainingSec?: number | null;
  hardDeadlineRemainingSec?: number | null;
  absoluteDeadlineRemainingSec?: number | null;
  deadlineExtensionCount?: number;
  etaBasis?: string;
  currentWave?: number;
  totalWaves?: number;
  agents: DynamicWorkflowAgent[];
}

export interface DynamicWorkflowState {
  runId: string;
  configuredMode: DynamicWorkflowMode;
  eligible: boolean | null;
  selected: boolean;
  active: boolean;
  status: DynamicWorkflowStatus;
  phase: "idle" | "plan" | "workers" | "review" | "synthesis";
  currentStage: number;
  /** Latest controller estimate of the actual workflow length; 0 means unknown. */
  plannedStages: number;
  /** Hard safety/budget ceiling. This is not the workflow's planned length. */
  maxStages: number;
  maxAgents: number;
  totalAgents: number;
  pattern: string;
  reason: string;
  stages: DynamicWorkflowStage[];
  completion?: {
    ok: boolean;
    reason: string;
    endedAt: string;
    subCount: number;
    failedSubs: number;
  };
}

export const EMPTY_DYNAMIC_WORKFLOW_STATE: DynamicWorkflowState = {
  runId: "",
  configuredMode: "off",
  eligible: null,
  selected: false,
  active: false,
  status: "idle",
  phase: "idle",
  currentStage: 0,
  plannedStages: 0,
  maxStages: 0,
  maxAgents: 0,
  totalAgents: 0,
  pattern: "",
  reason: "",
  stages: [],
};

export type DynamicWorkflowEvent = { type: string } & Record<string, unknown>;

function mode(value: unknown): DynamicWorkflowMode {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "auto" || normalized === "on" ? normalized : "off";
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function plannedStageCount(
  event: DynamicWorkflowEvent,
  state: DynamicWorkflowState,
  currentStage = state.currentStage,
): number {
  const explicit = integer(
    event.plannedStages ?? event.stageCount ?? event.totalStages,
  );
  if (explicit <= 0) {
    return Math.max(state.plannedStages, currentStage);
  }
  const ceiling = integer(
    event.maxStages ?? event.workflowMaxStages,
    state.maxStages,
  );
  const bounded = ceiling > 0
    ? Math.min(explicit, ceiling)
    : explicit;
  return Math.max(currentStage, bounded);
}

function agentStatus(value: unknown): DynamicWorkflowAgentStatus {
  const normalized = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (
    !normalized
    || normalized === "unstarted"
    || normalized === "never_started"
    || normalized === "not_started"
    || normalized === "unknown"
  ) {
    return "unstarted";
  }
  const known: DynamicWorkflowAgentStatus[] = [
    "queued",
    "queued_for_model",
    "spawning",
    "running",
    "waiting_input",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "lost",
    "needs_reconciliation",
    "skipped",
    "unstarted",
  ];
  return known.includes(normalized as DynamicWorkflowAgentStatus)
    ? normalized as DynamicWorkflowAgentStatus
    : "unstarted";
}

const FAILED_AGENT_STATUSES = new Set<DynamicWorkflowAgentStatus>([
  "failed",
  "cancelled",
  "timed_out",
  "lost",
  "needs_reconciliation",
  "unstarted",
]);

function genericProgress(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    !normalized
    || normalized === "model result"
    || normalized === "provider progress"
    || normalized === "provider activity"
    || normalized === "worker progress"
  );
}

function unnamedAgent(index: number): DynamicWorkflowAgent {
  return {
    name: `Unnamed agent ${index + 1}`,
    index,
    status: "unstarted",
    active: false,
    role: "",
    skills: [],
    summary: "",
    progress: "",
    failureReason: "nameless or malformed agent row",
  };
}

function parseAgents(raw: unknown): DynamicWorkflowAgent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, fallbackIndex) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return unnamedAgent(fallbackIndex);
    }
    const row = item as Record<string, unknown>;
    const named = String(row.name || "").trim();
    if (!named) {
      return unnamedAgent(fallbackIndex);
    }
    const name = named;
    const status = agentStatus(row.status);
    const summary = String(row.summary || "").trim();
    const progress = String(row.progress || "").trim();
    const explicitFailure = String(
      row.failureReason || row.error || row.reason || "",
    ).trim();
    const failureReason = FAILED_AGENT_STATUSES.has(status)
      ? explicitFailure
        || (!genericProgress(summary) ? summary : "")
        || (!genericProgress(progress) ? progress : "")
      : "";
    const skills = Array.isArray(row.skills)
      ? row.skills.map((skill) => String(skill || "").trim()).filter(Boolean)
      : [];
    return {
      name,
      index: integer(row.index, fallbackIndex),
      status,
      active:
        row.active === true ||
        ["spawning", "running", "waiting_input", "verifying"].includes(status),
      role: String(row.persona || row.role || "").trim(),
      skills,
      summary,
      progress,
      failureReason: failureReason || undefined,
    };
  });
}

function agentCounts(agents: readonly DynamicWorkflowAgent[]): {
  queued: number;
  activeCount: number;
  terminal: number;
  succeeded: number;
  failed: number;
  started: number;
  unstarted: number;
  total: number;
} {
  const terminalStates = new Set<DynamicWorkflowAgentStatus>([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "lost",
    "needs_reconciliation",
    "skipped",
    "unstarted",
  ]);
  let queued = 0;
  let activeCount = 0;
  let terminal = 0;
  let succeeded = 0;
  let failed = 0;
  let unstarted = 0;
  for (const agent of agents) {
    if (agent.status === "unstarted") {
      unstarted += 1;
      terminal += 1;
      failed += 1;
    } else if (agent.status === "queued" || agent.status === "queued_for_model") {
      queued += 1;
    } else if (terminalStates.has(agent.status)) {
      terminal += 1;
      if (agent.status === "succeeded") succeeded += 1;
      else failed += 1;
    } else {
      activeCount += 1;
    }
  }
  return {
    queued,
    activeCount,
    terminal,
    succeeded,
    failed,
    unstarted,
    started: Math.max(0, agents.length - queued - unstarted),
    total: agents.length,
  };
}

function replaceStage(
  stages: readonly DynamicWorkflowStage[],
  next: DynamicWorkflowStage,
): DynamicWorkflowStage[] {
  const index = stages.findIndex((stage) => stage.index === next.index);
  if (index < 0) {
    return [...stages, next].sort((a, b) => a.index - b.index);
  }
  const copy = [...stages];
  copy[index] = next;
  return copy;
}

function updateStageAgents(
  stages: readonly DynamicWorkflowStage[],
  stageIndex: number,
  agents: DynamicWorkflowAgent[],
): DynamicWorkflowStage[] {
  const current = stages.find((stage) => stage.index === stageIndex);
  if (!current) return stages.slice();
  return replaceStage(stages, {
    ...current,
    agents: agents.length ? agents : current.agents,
    ...(agents.length ? agentCounts(agents) : {}),
  });
}

export function formatWorkflowDuration(seconds: unknown): string {
  if (seconds == null) return "";
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric < 0) return "";
  if (numeric < 60) return `${Math.max(0, Math.ceil(numeric))}s`;
  if (numeric < 3600) return `~${Math.ceil(numeric / 60)}m`;
  const hours = Math.floor(numeric / 3600);
  const minutes = Math.ceil((numeric % 3600) / 60);
  return minutes > 0 ? `~${hours}h ${minutes}m` : `~${hours}h`;
}

export function dynamicWorkflowStageProgressLabel(
  stage: DynamicWorkflowStage,
): string {
  const total = integer(stage.total, stage.agents.length) || stage.agents.length;
  const terminal = Math.min(total, integer(stage.terminal));
  const activeCount = integer(stage.activeCount);
  const queued = integer(stage.queued);
  const totalWaves = integer(stage.totalWaves);
  const parts = [
    `${terminal}/${total} done`,
    `${activeCount} active`,
  ];
  if (queued > 0) parts.push(`${queued} queued`);
  if (totalWaves > 1) {
    parts.push(`wave ${integer(stage.currentWave) || 1}/${totalWaves}`);
  }
  const eta = formatWorkflowDuration(stage.estimatedRemainingSec);
  if (eta) parts.push(`ETA ${eta}`);
  return parts.join(" · ");
}

export function dynamicWorkflowReducer(
  state: DynamicWorkflowState,
  event: DynamicWorkflowEvent,
): DynamicWorkflowState {
  switch (event.type) {
    case "run_start":
      return {
        ...EMPTY_DYNAMIC_WORKFLOW_STATE,
        runId: String(event.runId || "").trim(),
        configuredMode: mode(event.workflowMode),
        maxStages: integer(event.workflowMaxStages),
        maxAgents: integer(event.workflowMaxAgents),
        completion: undefined,
      };
    case "dynamic_workflow_route":
      return {
        ...state,
        configuredMode: mode(event.configuredMode),
        eligible: event.eligible === true,
        active: event.eligible === true,
        status: "routing",
        phase: "plan",
        maxStages: integer(event.maxStages, state.maxStages),
        plannedStages: plannedStageCount(event, state),
        maxAgents: integer(event.maxAgents, state.maxAgents),
        reason: String(event.reason || "").trim(),
      };
    case "dynamic_workflow_start":
      return {
        ...state,
        configuredMode: mode(event.configuredMode),
        selected: true,
        active: true,
        status: "running",
        phase: "plan",
        maxStages: integer(event.maxStages, state.maxStages),
        plannedStages: plannedStageCount(event, state),
        maxAgents: integer(event.maxAgents, state.maxAgents),
        reason: "",
        completion: undefined,
      };
    case "dynamic_workflow_controller_start": {
      const controllerPhase = String(event.phase || "").toLowerCase();
      const stage = integer(event.stage, state.currentStage);
      return {
        ...state,
        active: true,
        selected: state.selected || controllerPhase !== "plan",
        status: controllerPhase === "review" ? "reviewing" : "routing",
        phase: controllerPhase === "review" ? "review" : "plan",
        currentStage: Math.max(state.currentStage, stage),
        plannedStages: plannedStageCount(
          event,
          state,
          Math.max(state.currentStage, stage),
        ),
        stages:
          controllerPhase === "review" && stage > 0
            ? state.stages.map((item) =>
                item.index === stage ? { ...item, status: "reviewing" } : item
              )
            : state.stages,
      };
    }
    case "dynamic_workflow_controller_end":
      return {
        ...state,
        active: true,
        selected:
          state.selected ||
          String(event.action || "").toLowerCase() === "dispatch",
        status:
          String(event.phase || "").toLowerCase() === "review"
            ? "reviewing"
            : state.status,
        pattern: String(event.pattern || state.pattern).trim(),
        reason: String(event.reason || state.reason).trim(),
        plannedStages: plannedStageCount(event, state),
      };
    case "dynamic_workflow_stage_start": {
      const stageIndex = integer(event.stage, state.currentStage + 1);
      const agents = parseAgents(event.agents);
      const counts = agentCounts(agents);
      const taskCount = integer(event.taskCount, counts.total);
      const maxConcurrency =
        Number.isFinite(Number(event.maxConcurrency))
          ? Math.max(1, Math.floor(Number(event.maxConcurrency)))
          : null;
      const stage: DynamicWorkflowStage = {
        index: stageIndex,
        pattern: String(event.pattern || "adaptive").trim() || "adaptive",
        goal: String(event.goal || "").trim(),
        status: "running",
        maxConcurrency,
        providerConcurrencyCap: nullableNumber(event.providerConcurrencyCap),
        concurrencyReason: String(event.concurrencyReason || "").trim(),
        controllerRequestedTaskCount: integer(
          event.controllerRequestedTaskCount,
          taskCount,
        ),
        deferredTaskCount: integer(event.deferredTaskCount),
        ...counts,
        queued: counts.queued,
        unstarted: counts.unstarted,
        total: taskCount || counts.total,
        elapsedSec: nullableNumber(event.elapsedSec),
        estimatedRemainingSec: nullableNumber(event.estimatedRemainingSec),
        hardDeadlineRemainingSec: nullableNumber(
          event.hardDeadlineRemainingSec,
        ),
        etaBasis: String(event.etaBasis || "").trim(),
        currentWave: integer(event.currentWave),
        totalWaves: integer(
          event.totalWaves,
          maxConcurrency && taskCount
            ? Math.max(1, Math.ceil(taskCount / maxConcurrency))
            : 1,
        ),
        agents,
      };
      return {
        ...state,
        selected: true,
        active: true,
        status: "running",
        phase: "workers",
        currentStage: stageIndex,
        plannedStages: plannedStageCount(event, state, stageIndex),
        pattern: stage.pattern,
        totalAgents: Math.max(
          state.totalAgents,
          state.stages
            .filter((item) => item.index !== stageIndex)
            .reduce((sum, item) => sum + item.agents.length, 0) + agents.length,
        ),
        stages: replaceStage(state.stages, stage),
      };
    }
    case "a2a_task_state": {
      const stageIndex = integer(event.workflowStage);
      if (!stageIndex) return state;
      return {
        ...state,
        active: true,
        status: "running",
        phase: "workers",
        currentStage: Math.max(state.currentStage, stageIndex),
        plannedStages: plannedStageCount(
          event,
          state,
          Math.max(state.currentStage, stageIndex),
        ),
        stages: updateStageAgents(
          state.stages,
          stageIndex,
          parseAgents(event.agents),
        ),
      };
    }
    case "dynamic_workflow_worker_progress":
    case "dynamic_workflow_worker_timeout": {
      const stageIndex = integer(event.stage, state.currentStage);
      if (!stageIndex) return state;
      return {
        ...state,
        active: true,
        status: "running",
        phase: "workers",
        currentStage: Math.max(state.currentStage, stageIndex),
        plannedStages: plannedStageCount(
          event,
          state,
          Math.max(state.currentStage, stageIndex),
        ),
        stages: updateStageAgents(
          state.stages,
          stageIndex,
          parseAgents(event.agents),
        ),
      };
    }
    case "dynamic_workflow_stage_progress": {
      const stageIndex = integer(event.stage, state.currentStage);
      if (!stageIndex) return state;
      const current = state.stages.find((stage) => stage.index === stageIndex);
      if (!current) return state;
      const agents = parseAgents(event.agents);
      const counts = agentCounts(agents.length ? agents : current.agents);
      return {
        ...state,
        active: true,
        status: "running",
        phase: "workers",
        currentStage: Math.max(state.currentStage, stageIndex),
        plannedStages: plannedStageCount(
          event,
          state,
          Math.max(state.currentStage, stageIndex),
        ),
        stages: replaceStage(state.stages, {
          ...current,
          agents: agents.length ? agents : current.agents,
          queued: counts.queued,
          activeCount: counts.activeCount,
          terminal: counts.terminal,
          succeeded: counts.succeeded,
          failed: counts.failed,
          unstarted: counts.unstarted,
          started: counts.started,
          total: integer(event.total, counts.total),
          elapsedSec: nullableNumber(event.elapsedSec),
          estimatedRemainingSec: nullableNumber(event.estimatedRemainingSec),
          hardDeadlineRemainingSec: nullableNumber(
            event.hardDeadlineRemainingSec,
          ),
          absoluteDeadlineRemainingSec: nullableNumber(
            event.absoluteDeadlineRemainingSec,
          ),
          deadlineExtensionCount: integer(
            event.deadlineExtensionCount,
            current.deadlineExtensionCount,
          ),
          etaBasis: String(event.etaBasis || current.etaBasis).trim(),
          currentWave: integer(event.currentWave, current.currentWave),
          totalWaves: integer(event.totalWaves, current.totalWaves),
        }),
      };
    }
    case "dynamic_workflow_stage_deadline_extended": {
      const stageIndex = integer(event.stage, state.currentStage);
      const current = state.stages.find((stage) => stage.index === stageIndex);
      if (!current) return state;
      return {
        ...state,
        active: true,
        status: "running",
        phase: "workers",
        currentStage: Math.max(state.currentStage, stageIndex),
        plannedStages: plannedStageCount(
          event,
          state,
          Math.max(state.currentStage, stageIndex),
        ),
        stages: replaceStage(state.stages, {
          ...current,
          hardDeadlineRemainingSec: nullableNumber(
            event.hardDeadlineRemainingSec,
          ),
          absoluteDeadlineRemainingSec: nullableNumber(
            event.absoluteDeadlineRemainingSec,
          ),
          deadlineExtensionCount: integer(
            event.deadlineExtensionCount,
            current.deadlineExtensionCount,
          ),
          etaBasis: String(
            event.reason || "recent worker progress",
          ).trim(),
        }),
      };
    }
    case "dynamic_workflow_stage_end": {
      const stageIndex = integer(event.stage, state.currentStage);
      const current = state.stages.find((stage) => stage.index === stageIndex);
      const agents = parseAgents(event.agents);
      const finalAgents = agents.length
        ? agents
        : current?.agents ?? [];
      const counts = agentCounts(finalAgents);
      const failClosed = counts.failed > 0 || counts.unstarted > 0;
      const sealed: DynamicWorkflowStage = {
        ...(current ?? {
          index: stageIndex,
          pattern: String(event.pattern || "adaptive").trim() || "adaptive",
          goal: String(event.goal || "").trim(),
          maxConcurrency: null,
          agents: [],
        }),
        status: event.ok === false || failClosed ? "failed" : "succeeded",
        agents: finalAgents,
        ...counts,
        succeeded: counts.succeeded,
        failed: counts.failed,
        unstarted: counts.unstarted,
        terminal: counts.terminal,
        queued: 0,
        activeCount: 0,
        started: counts.started,
        total: integer(
          event.requestedAgentCount,
          counts.total || current?.total,
        ),
        elapsedSec: nullableNumber(event.elapsedSec),
        estimatedRemainingSec: 0,
        hardDeadlineRemainingSec: 0,
        totalWaves: integer(event.totalWaves, current?.totalWaves),
      };
      return {
        ...state,
        active: true,
        status: "reviewing",
        phase: "review",
        currentStage: Math.max(state.currentStage, stageIndex),
        plannedStages: plannedStageCount(
          event,
          state,
          Math.max(state.currentStage, stageIndex),
        ),
        stages: replaceStage(state.stages, sealed),
      };
    }
    case "dynamic_workflow_synthesis_start":
      return {
        ...state,
        active: true,
        selected: true,
        status: "synthesizing",
        phase: "synthesis",
        totalAgents: integer(event.totalAgents, state.totalAgents),
        plannedStages: plannedStageCount(event, state),
      };
    case "dynamic_workflow_end": {
      const rawStatus = String(event.status || "").trim().toLowerCase();
      const status: DynamicWorkflowStatus =
        rawStatus === "succeeded" ||
        rawStatus === "failed" ||
        rawStatus === "cancelled" ||
        rawStatus === "skipped" ||
        rawStatus === "awaiting_input"
          ? rawStatus
          : event.selected === false
            ? "skipped"
            : "failed";
      return {
        ...state,
        selected: event.selected !== false && state.selected,
        active: false,
        status,
        phase: status === "skipped" ? "idle" : state.phase,
        pattern: String(event.pattern || state.pattern).trim(),
        reason: String(event.reason || state.reason).trim(),
        currentStage: integer(event.stages, state.currentStage),
        plannedStages: plannedStageCount(
          event,
          state,
          integer(event.stages, state.currentStage),
        ),
        totalAgents: integer(event.totalAgents, state.totalAgents),
      };
    }
    case "run_finished": {
      const runMode = String(event.mode || "").trim().toLowerCase();
      const runReason = String(event.reason || "").trim().toLowerCase();
      const workflowCancelled = runMode === "workflow" && runReason === "cancel";
      const workflowReceipt =
        event.workflowReceipt &&
        typeof event.workflowReceipt === "object" &&
        !Array.isArray(event.workflowReceipt)
          ? event.workflowReceipt as Record<string, unknown>
          : {};
      const workflowController =
        workflowReceipt.controller &&
        typeof workflowReceipt.controller === "object" &&
        !Array.isArray(workflowReceipt.controller)
          ? workflowReceipt.controller as Record<string, unknown>
          : {};
      const cancellationReason = String(
        workflowController.reason ||
        workflowController.reasonCode ||
        "operator cancelled workflow",
      ).trim();
      const subs = Array.isArray(event.subs)
        ? event.subs.filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
          )
        : [];
      const subByName = new Map(
        subs.map((item) => [String(item.name || "").trim(), item]),
      );
      const ok = event.ok === true;
      const nextStages = state.stages.map((stage) => {
        const agents = stage.agents.map((agent) => {
          const receipt = subByName.get(agent.name);
          if (!receipt) return { ...agent, active: false };
          const status = agentStatus(receipt.status);
          const reasonCode = String(receipt.reasonCode || "").trim();
          const fallback =
            reasonCode && genericProgress(agent.summary)
              ? `worker ${status.replaceAll("_", " ")} · ${reasonCode}`
              : agent.summary;
          return {
            ...agent,
            active: false,
            status,
            summary: fallback,
            failureReason:
              FAILED_AGENT_STATUSES.has(status)
                ? agent.failureReason || fallback
                : agent.failureReason,
          };
        });
        const counts = agentCounts(agents);
        const failClosed = counts.failed > 0 || counts.unstarted > 0;
        const isOpenCurrent =
          stage.index === state.currentStage
          && ["queued", "running", "reviewing"].includes(stage.status);
        return {
          ...stage,
          ...counts,
          agents,
          status: isOpenCurrent
            ? ok && !failClosed ? "succeeded" as const : "failed" as const
            : stage.status,
        };
      });
      const failClosed = nextStages.some(
        (stage) => (stage.failed || 0) > 0 || (stage.unstarted || 0) > 0,
      );
      return {
        ...state,
        active: false,
        status:
          workflowCancelled
            ? "cancelled"
            : state.selected && !["succeeded", "failed", "skipped", "awaiting_input"].includes(state.status)
              ? ok && !failClosed ? "succeeded" : "failed"
            : failClosed && state.status === "succeeded"
              ? "failed"
            : state.status,
        reason: workflowCancelled ? cancellationReason : state.reason,
        stages: nextStages,
        completion: {
          ok: !workflowCancelled && ok && !failClosed,
          reason: workflowCancelled
            ? cancellationReason
            : String(event.reason || (ok ? "verified" : "error")).trim(),
          endedAt: String(event.endedAt || "").trim(),
          subCount: subs.length,
          failedSubs: subs.filter((item) =>
            FAILED_AGENT_STATUSES.has(agentStatus(item.status))
          ).length,
        },
      };
    }
    case "error":
      return { ...state, active: false };
    default:
      return state;
  }
}

export function dynamicWorkflowStatusLabel(
  state: DynamicWorkflowState,
): string {
  if (state.configuredMode === "off" && state.status === "idle") return "off";
  if (state.status === "routing") return "Main routing";
  if (state.status === "running") return `stage ${dynamicWorkflowStageCounter(state)} workers`;
  if (state.status === "reviewing") return `stage ${dynamicWorkflowStageCounter(state)} review`;
  if (state.status === "synthesizing") return "final synthesis";
  return state.status.replaceAll("_", " ");
}

export function dynamicWorkflowStageCounter(
  state: Pick<DynamicWorkflowState, "currentStage" | "plannedStages">,
): string {
  const current = Math.max(0, Math.floor(Number(state.currentStage) || 0));
  const planned = Math.max(current, Math.floor(Number(state.plannedStages) || 0));
  return `${current || "?"}/${planned || "?"}`;
}
