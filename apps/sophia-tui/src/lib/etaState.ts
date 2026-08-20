/**
 * Honest run-level ETA state derived from observed bridge progress.
 *
 * This reducer never invents a duration from the prompt or configured safety
 * budgets. It uses only an explicit full-run ETA supplied by the kernel;
 * worker-stage timing remains scoped to workflow progress. If full-run evidence
 * does not exist yet, the UI says estimating or waiting instead of printing
 * false precision.
 */

export type RunEtaStatus =
  | "idle"
  | "estimating"
  | "waiting"
  | "active"
  | "complete";

export type RunEtaConfidence = "low" | "medium" | "high";

export interface RunEtaState {
  runId: string;
  status: RunEtaStatus;
  startedAtMs: number | null;
  estimatedTotalSec: number | null;
  estimatedRemainingSec: number | null;
  estimateAsOfMs: number | null;
  basis: string;
  confidence: RunEtaConfidence | null;
  stage: number;
  plannedStages: number;
  completedUnits: number;
  totalUnits: number;
  observedStageDurationsSec: number[];
  terminalOk: boolean | null;
}

export const EMPTY_RUN_ETA_STATE: RunEtaState = {
  runId: "",
  status: "idle",
  startedAtMs: null,
  estimatedTotalSec: null,
  estimatedRemainingSec: null,
  estimateAsOfMs: null,
  basis: "",
  confidence: null,
  stage: 0,
  plannedStages: 0,
  completedUnits: 0,
  totalUnits: 0,
  observedStageDurationsSec: [],
  terminalOk: null,
};

export type RunEtaEvent = { type: string } & Record<string, unknown>;

function nonNegativeNumber(value: unknown): number | null {
  if (
    value == null
    || typeof value === "boolean"
    || (typeof value === "string" && !value.trim())
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : fallback;
}

function eventTimeMs(event: RunEtaEvent): number | null {
  const receivedAt = nonNegativeNumber(event.receivedAtMs);
  if (receivedAt != null) return receivedAt;
  for (const candidate of [event.updatedAt, event.endedAt, event.ts]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function plannedStageCount(
  event: RunEtaEvent,
  state: RunEtaState,
  stage = state.stage,
): number {
  const explicit = integer(
    event.plannedStages ?? event.stageCount ?? event.totalStages,
  );
  return Math.max(stage, explicit || state.plannedStages);
}

function stageProgressEstimate(
  state: RunEtaState,
  event: RunEtaEvent,
  observedAtMs: number | null,
): Pick<
  RunEtaState,
  "estimatedRemainingSec" | "confidence" | "basis" | "status"
> {
  const explicitRunEta = nonNegativeNumber(
    event.workflowEstimatedRemainingSec ?? event.runEstimatedRemainingSec,
  );
  if (explicitRunEta != null) {
    return {
      estimatedRemainingSec: explicitRunEta,
      confidence: "high",
      basis: String(event.etaBasis || "kernel run estimate").trim(),
      status: "active",
    };
  }

  const retainedRunEta = observedAtMs == null
    ? state.estimatedRemainingSec
    : runEtaRemainingSec(state, observedAtMs);
  if (retainedRunEta != null) {
    return {
      estimatedRemainingSec: retainedRunEta,
      confidence: state.confidence,
      basis: state.basis,
      status: "active",
    };
  }

  const stageEta = nonNegativeNumber(event.estimatedRemainingSec);
  const active = integer(event.active);
  const queued = integer(event.queued);
  const terminal = integer(event.terminal);
  return {
    estimatedRemainingSec: null,
    confidence: null,
    basis: stageEta != null
      ? "worker ETA observed; full-run ETA recalibrating"
      : terminal === 0 && active + queued > 0
        ? "waiting for the first measured completion"
        : "waiting for a full-run estimate",
    status: active + queued > 0 ? "waiting" : "estimating",
  };
}

function revisedFullRunEstimate(
  state: RunEtaState,
  observedAtMs: number | null,
  remainingSec: number | null,
): number | null {
  if (observedAtMs == null || remainingSec == null) {
    return state.estimatedTotalSec;
  }
  const elapsedSec = runEtaElapsedSec(state, observedAtMs);
  return elapsedSec == null
    ? state.estimatedTotalSec
    : elapsedSec + remainingSec;
}

export function runEtaReducer(
  state: RunEtaState,
  event: RunEtaEvent,
): RunEtaState {
  const observedAt = eventTimeMs(event);
  switch (event.type) {
    case "run_start":
      return {
        ...EMPTY_RUN_ETA_STATE,
        runId: String(event.runId || "").trim(),
        status: "estimating",
        startedAtMs: observedAt,
        estimateAsOfMs: observedAt,
        basis: "waiting for measured progress",
      };
    case "run_eta": {
      const remaining = nonNegativeNumber(event.estimatedRemainingSec);
      const total = nonNegativeNumber(event.estimatedTotalSec);
      const elapsed = nonNegativeNumber(event.elapsedSec);
      const confidence = String(event.confidence || "").trim();
      return {
        ...state,
        status: remaining == null && total == null ? "estimating" : "active",
        startedAtMs:
          state.startedAtMs
          ?? (
            observedAt != null && elapsed != null
              ? observedAt - elapsed * 1_000
              : observedAt
          ),
        estimatedTotalSec: total,
        estimatedRemainingSec:
          remaining ?? (
            total != null && elapsed != null
              ? Math.max(0, total - elapsed)
              : null
          ),
        estimateAsOfMs: observedAt,
        basis: String(event.etaBasis || "kernel run history").trim(),
        confidence:
          confidence === "high" || confidence === "medium" || confidence === "low"
            ? confidence
            : null,
      };
    }
    case "goal_update": {
      const stage = integer(event.stage ?? event.currentStage, state.stage);
      return {
        ...state,
        status: state.status === "idle" ? "estimating" : state.status,
        stage,
        plannedStages: plannedStageCount(event, state, stage),
        basis: state.basis || "waiting for measured progress",
      };
    }
    case "dynamic_workflow_route":
    case "dynamic_workflow_start":
    case "dynamic_workflow_controller_end": {
      const stage = integer(event.stage, state.stage);
      const retainedRunEta = observedAt == null
        ? state.estimatedRemainingSec
        : runEtaRemainingSec(state, observedAt);
      return {
        ...state,
        status: retainedRunEta == null ? "estimating" : "active",
        stage,
        plannedStages: plannedStageCount(event, state, stage),
        estimatedTotalSec: revisedFullRunEstimate(
          state,
          observedAt,
          retainedRunEta,
        ),
        estimatedRemainingSec: retainedRunEta,
        estimateAsOfMs:
          retainedRunEta == null ? state.estimateAsOfMs : observedAt,
        basis: retainedRunEta == null
          ? "Main is refining the workflow plan"
          : state.basis,
      };
    }
    case "dynamic_workflow_controller_start": {
      const stage = integer(event.stage, state.stage);
      const reviewing = String(event.phase || "").toLowerCase() === "review";
      const retainedRunEta = observedAt == null
        ? state.estimatedRemainingSec
        : runEtaRemainingSec(state, observedAt);
      return {
        ...state,
        status: retainedRunEta == null
          ? reviewing ? "waiting" : "estimating"
          : "active",
        stage,
        plannedStages: plannedStageCount(event, state, stage),
        estimatedTotalSec: revisedFullRunEstimate(
          state,
          observedAt,
          retainedRunEta,
        ),
        estimatedRemainingSec: retainedRunEta,
        estimateAsOfMs:
          retainedRunEta == null ? state.estimateAsOfMs : observedAt,
        basis: reviewing && retainedRunEta == null
          ? `reviewing stage ${stage || "?"} evidence`
          : state.basis || "Main is refining the workflow plan",
      };
    }
    case "dynamic_workflow_stage_start": {
      const stage = integer(event.stage, state.stage + 1);
      const retainedRunEta = observedAt == null
        ? state.estimatedRemainingSec
        : runEtaRemainingSec(state, observedAt);
      return {
        ...state,
        status: retainedRunEta == null ? "waiting" : "active",
        stage,
        plannedStages: plannedStageCount(event, state, stage),
        estimatedTotalSec: revisedFullRunEstimate(
          state,
          observedAt,
          retainedRunEta,
        ),
        estimatedRemainingSec: retainedRunEta,
        estimateAsOfMs:
          retainedRunEta == null ? state.estimateAsOfMs : observedAt,
        completedUnits: integer(event.terminal),
        totalUnits: integer(event.taskCount ?? event.total),
        basis: retainedRunEta == null
          ? "waiting for the first measured completion"
          : state.basis,
      };
    }
    case "a2a_task_state":
    case "dynamic_workflow_worker_progress":
    case "dynamic_workflow_worker_timeout": {
      const stage = integer(
        event.stage ?? event.workflowStage,
        state.stage,
      );
      const retainedRunEta = observedAt == null
        ? state.estimatedRemainingSec
        : runEtaRemainingSec(state, observedAt);
      return {
        ...state,
        status: retainedRunEta == null ? "waiting" : "active",
        stage,
        plannedStages: plannedStageCount(event, state, stage),
        estimatedTotalSec: revisedFullRunEstimate(
          state,
          observedAt,
          retainedRunEta,
        ),
        estimatedRemainingSec: retainedRunEta,
        estimateAsOfMs:
          retainedRunEta == null ? state.estimateAsOfMs : observedAt,
        basis: retainedRunEta == null
          ? "workers active; waiting for measured throughput"
          : state.basis,
      };
    }
    case "dynamic_workflow_stage_progress": {
      const stage = integer(event.stage, state.stage);
      const estimate = stageProgressEstimate(state, event, observedAt);
      return {
        ...state,
        ...estimate,
        stage,
        plannedStages: plannedStageCount(event, state, stage),
        estimatedTotalSec: revisedFullRunEstimate(
          state,
          observedAt,
          estimate.estimatedRemainingSec,
        ),
        estimateAsOfMs: estimate.estimatedRemainingSec == null
          ? state.estimateAsOfMs
          : observedAt,
        completedUnits: integer(event.terminal, state.completedUnits),
        totalUnits: integer(event.total, state.totalUnits),
      };
    }
    case "dynamic_workflow_stage_deadline_extended": {
      const retainedRunEta = observedAt == null
        ? state.estimatedRemainingSec
        : runEtaRemainingSec(state, observedAt);
      return {
        ...state,
        status: retainedRunEta == null ? "waiting" : "active",
        estimatedTotalSec: revisedFullRunEstimate(
          state,
          observedAt,
          retainedRunEta,
        ),
        estimatedRemainingSec: retainedRunEta,
        estimateAsOfMs:
          retainedRunEta == null ? state.estimateAsOfMs : observedAt,
        basis: retainedRunEta == null
          ? "stage deadline extended; full-run ETA unavailable"
          : state.basis,
      };
    }
    case "provider_wait": {
      return {
        ...state,
        // A wait heartbeat changes the lifecycle label only. It is not new ETA
        // evidence, so preserve both the full-run anchor and its provenance.
        status: "waiting",
      };
    }
    case "dynamic_workflow_stage_end": {
      const stage = integer(event.stage, state.stage);
      const elapsed = nonNegativeNumber(event.elapsedSec);
      const durations = elapsed != null && elapsed > 0
        ? [...state.observedStageDurationsSec, elapsed].slice(-8)
        : state.observedStageDurationsSec;
      const plannedStages = plannedStageCount(event, state, stage);
      const retainedEstimate = observedAt == null
        ? state.estimatedRemainingSec
        : runEtaRemainingSec(state, observedAt);
      return {
        ...state,
        status: retainedEstimate == null ? "waiting" : "active",
        stage,
        plannedStages,
        estimatedTotalSec: revisedFullRunEstimate(
          state,
          observedAt,
          retainedEstimate,
        ),
        estimatedRemainingSec: retainedEstimate,
        estimateAsOfMs:
          retainedEstimate == null ? state.estimateAsOfMs : observedAt,
        confidence: retainedEstimate == null ? null : state.confidence,
        completedUnits: stage,
        totalUnits: plannedStages,
        observedStageDurationsSec: durations,
        basis: retainedEstimate == null
          ? "stage complete; full-run ETA recalibrating"
          : state.basis,
      };
    }
    case "dynamic_workflow_synthesis_start": {
      const explicit = nonNegativeNumber(
        event.workflowEstimatedRemainingSec ?? event.runEstimatedRemainingSec,
      );
      const retainedRunEta = explicit ?? (
        observedAt == null
          ? state.estimatedRemainingSec
          : runEtaRemainingSec(state, observedAt)
      );
      return {
        ...state,
        status: retainedRunEta == null ? "estimating" : "active",
        estimatedTotalSec: revisedFullRunEstimate(
          state,
          observedAt,
          retainedRunEta,
        ),
        estimatedRemainingSec: retainedRunEta,
        estimateAsOfMs:
          retainedRunEta == null ? state.estimateAsOfMs : observedAt,
        confidence: explicit == null ? state.confidence : "high",
        basis: explicit == null
          ? state.basis || "final synthesis duration not yet measured"
          : String(event.etaBasis || "kernel synthesis full-run estimate").trim(),
      };
    }
    // Bridge `error` records are command-level and intentionally carry no
    // runId. They may describe a rejected steer or malformed slash command
    // while the active run continues, so they are not ETA lifecycle evidence.
    case "error":
      return state;
    case "run_finished": {
      const duration = nonNegativeNumber(event.durationSec);
      const elapsed = duration ?? (
        observedAt == null ? null : runEtaElapsedSec(state, observedAt)
      );
      return {
        ...state,
        status: "complete",
        estimatedTotalSec: elapsed ?? state.estimatedTotalSec,
        estimatedRemainingSec: 0,
        estimateAsOfMs: observedAt,
        basis: String(event.reason || "run finished").trim(),
        confidence: "high",
        terminalOk: event.ok === true,
      };
    }
    default:
      return state;
  }
}

/**
 * Count an event-based estimate down without mutating reducer state. `nowMs`
 * comes from the UI clock, keeping the reducer and tests deterministic.
 */
export function runEtaRemainingSec(
  state: RunEtaState,
  nowMs: number,
): number | null {
  if (state.status === "complete") return 0;
  if (state.estimatedRemainingSec == null) return null;
  // A non-terminal countdown reaching zero is evidence that the estimate has
  // expired, not that the run is about to finish. Drop the number until the
  // kernel or measured progress recalibrates it instead of pinning a false 0s.
  if (state.estimatedRemainingSec <= 0) return null;
  if (
    state.estimateAsOfMs == null
    || !Number.isFinite(nowMs)
    || nowMs <= state.estimateAsOfMs
  ) {
    return Math.max(0, state.estimatedRemainingSec);
  }
  const elapsed = (nowMs - state.estimateAsOfMs) / 1000;
  const remaining = state.estimatedRemainingSec - elapsed;
  return remaining > 0 ? remaining : null;
}

export function runEtaElapsedSec(
  state: RunEtaState,
  nowMs: number,
): number | null {
  if (
    state.startedAtMs == null
    || !Number.isFinite(nowMs)
    || nowMs < state.startedAtMs
  ) {
    return null;
  }
  return Math.max(0, (nowMs - state.startedAtMs) / 1_000);
}

export function runEtaEstimatedTotalSec(
  state: RunEtaState,
  nowMs: number,
): number | null {
  if (state.status !== "complete" && runEtaRemainingSec(state, nowMs) == null) {
    return null;
  }
  if (state.estimatedTotalSec != null) {
    return Math.max(0, state.estimatedTotalSec);
  }
  const elapsed = runEtaElapsedSec(state, nowMs);
  const remaining = runEtaRemainingSec(state, nowMs);
  if (elapsed == null || remaining == null) return null;
  return elapsed + remaining;
}

function approximateDuration(seconds: number): string {
  if (seconds <= 30) return "under 1m";
  if (seconds < 90) return "~1m";
  if (seconds < 600) return `~${Math.ceil(seconds / 60)}m`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 300) * 5}m`;
  const roundedHalfHours = Math.ceil(seconds / 1800) / 2;
  return `~${roundedHalfHours}h`;
}

export function runEtaLabel(state: RunEtaState, nowMs: number): string {
  if (state.status === "idle") return "";
  if (state.status === "complete") {
    return state.terminalOk === false ? "Finished with errors" : "Done";
  }
  const remaining = runEtaRemainingSec(state, nowMs);
  if (remaining != null) {
    const label = `ETA ${approximateDuration(remaining)}`;
    return state.status === "waiting" ? `${label} · waiting` : label;
  }
  if (state.status === "waiting") return "ETA waiting";
  return "ETA estimating";
}
