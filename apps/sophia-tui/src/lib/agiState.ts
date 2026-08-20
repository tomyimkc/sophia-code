/**
 * Observable AGI-mode controller state for the Sophia TUI.
 *
 * This is a receipt projection, not a chain-of-thought surface. It folds the
 * controller's durable phase/action/verification events into compact operator
 * state without exposing hidden planner or verifier reasoning.
 */

export type AGIProfile = "conservative" | "balanced" | "deep";
export type AGIRoute = "auto" | "fast" | "deliberative" | "critical";

export type AGIStatus =
  | "idle"
  | "running"
  | "paused"
  | "interrupted"
  | "candidate_complete"
  | "achieved"
  | "awaiting_input"
  | "unachievable"
  | "bound_hit"
  | "cancelled"
  | "failed";

export interface AGIState {
  enabled: boolean;
  active: boolean;
  runId: string;
  profile: AGIProfile;
  route: AGIRoute;
  routeReason: string;
  status: AGIStatus;
  goal: string;
  phase: string;
  role: string;
  model: string;
  cycle: number;
  maxCycles: number;
  wallClockSec: number;
  maxStepsPerAction: number;
  strategy: string;
  actionId: string;
  actionClass: string;
  action: string;
  prediction: string;
  observation: string;
  discrepancy: string;
  expectationStatus: string;
  correctionAction: string;
  risk: number | null;
  uncertainty: number | null;
  reversibility: number | null;
  authorizationRequired: boolean;
  authorizationGranted: boolean;
  verificationStatus: string;
  verificationReason: string;
  confidence: number | null;
  deterministicEvidence: boolean;
  verifierIndependent: boolean;
  sameModelVerifier: boolean;
  verifiedCriteria: number;
  totalCriteria: number;
  failedCriteria: string[];
  unknownCriteria: string[];
  blockedCriteria: string[];
  currentGapId: string;
  reason: string;
  statePath: string;
  candidatePath: string;
}

export const EMPTY_AGI_STATE: AGIState = {
  enabled: false,
  active: false,
  runId: "",
  profile: "balanced",
  route: "auto",
  routeReason: "",
  status: "idle",
  goal: "",
  phase: "",
  role: "",
  model: "",
  cycle: 0,
  maxCycles: 8,
  wallClockSec: 3600,
  maxStepsPerAction: 12,
  strategy: "",
  actionId: "",
  actionClass: "",
  action: "",
  prediction: "",
  observation: "",
  discrepancy: "",
  expectationStatus: "",
  correctionAction: "",
  risk: null,
  uncertainty: null,
  reversibility: null,
  authorizationRequired: false,
  authorizationGranted: false,
  verificationStatus: "",
  verificationReason: "",
  confidence: null,
  deterministicEvidence: false,
  verifierIndependent: false,
  sameModelVerifier: false,
  verifiedCriteria: 0,
  totalCriteria: 0,
  failedCriteria: [],
  unknownCriteria: [],
  blockedCriteria: [],
  currentGapId: "",
  reason: "",
  statePath: "",
  candidatePath: "",
};

export type AGIEvent = { type: string } & Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function confidence(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : null;
}

function profile(value: unknown, fallback: AGIProfile): AGIProfile {
  const normalized = text(value).toLowerCase();
  return normalized === "conservative" || normalized === "deep"
    ? normalized
    : normalized === "balanced"
      ? "balanced"
      : fallback;
}

function route(value: unknown, fallback: AGIRoute): AGIRoute {
  const normalized = text(value).toLowerCase();
  return normalized === "fast"
    || normalized === "deliberative"
    || normalized === "critical"
    || normalized === "auto"
    ? normalized
    : fallback;
}

function status(value: unknown, fallback: AGIStatus): AGIStatus {
  const normalized = text(value).toLowerCase().replaceAll("-", "_");
  const valid: AGIStatus[] = [
    "idle",
    "running",
    "paused",
    "interrupted",
    "candidate_complete",
    "achieved",
    "awaiting_input",
    "unachievable",
    "bound_hit",
    "cancelled",
    "failed",
  ];
  return valid.includes(normalized as AGIStatus)
    ? normalized as AGIStatus
    : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function summary(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => summary(item)).filter(Boolean).join("; ");
  }
  const row = object(value);
  for (const key of ["outcome", "summary", "detail", "reason", "remaining"]) {
    const found = text(row[key]);
    if (found) return found;
  }
  return "";
}

export function agiReducer(state: AGIState, ev: AGIEvent): AGIState {
  switch (ev.type) {
    case "run_start":
      if (ev.agiMode !== true) {
        return {
          ...state,
          active: false,
          status: "idle",
          phase: "",
          role: "",
          model: "",
        };
      }
      return {
        ...EMPTY_AGI_STATE,
        enabled: true,
        active: true,
        runId: text(ev.agiRunId || ev.runId),
        profile: profile(ev.agiProfile, state.profile),
        route: route(ev.agiRoute, state.route),
        status: "running",
        goal: text(ev.goal),
      };
    case "agi_mode_start": {
      const config = object(ev.config);
      return {
        ...state,
        enabled: true,
        active: true,
        runId: text(ev.runId) || state.runId,
        profile: profile(ev.profile, state.profile),
        route: route(ev.route || config.route, state.route),
        routeReason: text(ev.routeReason) || state.routeReason,
        status: "running",
        goal: text(ev.goal) || state.goal,
        cycle: 0,
        maxCycles: Math.max(1, Math.floor(number(config.maxCycles, state.maxCycles))),
        wallClockSec: Math.max(1, Math.floor(number(config.wallClockSec, state.wallClockSec))),
        phase: "perceive",
        statePath: text(ev.statePath) || state.statePath,
        sameModelVerifier: ev.sameModelVerifier === true,
        verifierIndependent: ev.sameModelVerifier !== true,
        reason: "",
      };
    }
    case "agi_route_selected": {
      const contract = object(ev.goalContract);
      const budgets = object(contract.budgets);
      return {
        ...state,
        route: route(ev.route, state.route),
        routeReason: text(ev.reason) || state.routeReason,
        maxCycles: Math.max(1, Math.floor(number(budgets.maxCycles, state.maxCycles))),
        wallClockSec: Math.max(1, Math.floor(number(budgets.wallClockSec, state.wallClockSec))),
        maxStepsPerAction: Math.max(
          1,
          Math.floor(number(budgets.maxStepsPerAction, state.maxStepsPerAction)),
        ),
      };
    }
    case "agi_phase_start":
      return {
        ...state,
        active: true,
        status: "running",
        phase: text(ev.phase) || state.phase,
        role: text(ev.role),
        model: text(ev.model),
        cycle: Math.max(state.cycle, Math.floor(number(ev.cycle, state.cycle))),
      };
    case "agi_strategy_selected": {
      const selected = object(ev.strategy);
      return {
        ...state,
        strategy: text(selected.title || selected.id),
        action: text(selected.nextAction || selected.next_action),
        prediction: text(selected.prediction),
        risk: confidence(selected.risk),
        uncertainty: confidence(selected.uncertainty),
        reversibility: confidence(selected.reversibility),
        cycle: Math.max(state.cycle, Math.floor(number(ev.cycle, state.cycle))),
      };
    }
    case "agi_action_contract": {
      const contract = object(ev.contract);
      return {
        ...state,
        actionId: text(contract.actionId),
        actionClass: text(contract.actionClass),
        action: text(contract.action) || state.action,
        risk: confidence(contract.risk),
        uncertainty: confidence(contract.uncertainty),
        reversibility: confidence(contract.reversibility),
        authorizationRequired: contract.authorizationRequired === true,
        authorizationGranted: false,
      };
    }
    case "agi_pre_action_gate":
      return {
        ...state,
        actionId: text(ev.actionId) || state.actionId,
        actionClass: text(ev.actionClass) || state.actionClass,
        authorizationRequired: ev.authorizationRequired === true,
        authorizationGranted: ev.authorized === true,
      };
    case "agi_action_start":
      return {
        ...state,
        phase: "act",
        action: text(ev.action) || state.action,
        prediction: text(ev.prediction) || state.prediction,
        cycle: Math.max(state.cycle, Math.floor(number(ev.cycle, state.cycle))),
      };
    case "agi_observation":
      return {
        ...state,
        phase: "observe",
        observation: summary(ev.observation),
        cycle: Math.max(state.cycle, Math.floor(number(ev.cycle, state.cycle))),
      };
    case "agi_discrepancy":
      return {
        ...state,
        discrepancy: text(ev.detail),
        cycle: Math.max(state.cycle, Math.floor(number(ev.cycle, state.cycle))),
      };
    case "agi_discrepancy_vector": {
      const vector = object(ev.vector);
      const failed = vector.hasFailures === true;
      const unknown = vector.hasUnknowns === true;
      return {
        ...state,
        expectationStatus: failed
          ? "failed"
          : unknown
            ? "unknown"
            : vector.allRequiredPassed === true
              ? "passed"
              : "not reported",
      };
    }
    case "agi_correction_selected":
      return {
        ...state,
        correctionAction: text(ev.action),
      };
    case "agi_replan":
      return {
        ...state,
        phase: "diagnose",
        discrepancy: summary(ev.diagnosis) || state.discrepancy,
      };
    case "agi_verification": {
      const verdict = object(ev.verdict);
      return {
        ...state,
        phase: "verify",
        verificationStatus: text(verdict.status),
        verificationReason: text(verdict.reason || verdict.remaining),
        confidence: confidence(verdict.confidence),
        deterministicEvidence:
          state.deterministicEvidence || ev.deterministicEvidence === true,
        verifierIndependent: ev.verifierIndependent === true,
        sameModelVerifier: ev.sameModelVerifier === true,
      };
    }
    case "completion_contract": {
      const criteria = Array.isArray(ev.criteria) ? ev.criteria : [];
      return {
        ...state,
        totalCriteria: criteria.length,
      };
    }
    case "criterion_ledger": {
      const summaryRow = object(ev.summary);
      return {
        ...state,
        verifiedCriteria: Math.max(0, Math.floor(number(summaryRow.verified))),
        totalCriteria: Math.max(0, Math.floor(number(summaryRow.total, state.totalCriteria))),
        failedCriteria: Array.isArray(summaryRow.failed)
          ? summaryRow.failed.map((item) => text(item)).filter(Boolean)
          : state.failedCriteria,
        unknownCriteria: Array.isArray(summaryRow.unknown)
          ? summaryRow.unknown.map((item) => text(item)).filter(Boolean)
          : state.unknownCriteria,
        blockedCriteria: Array.isArray(summaryRow.blocked)
          ? summaryRow.blocked.map((item) => text(item)).filter(Boolean)
          : state.blockedCriteria,
      };
    }
    case "completion_gap_start": {
      const tasks = Array.isArray(ev.tasks) ? ev.tasks : [];
      const first = object(tasks[0]);
      return {
        ...state,
        currentGapId: text(first.taskId),
        status: "running",
        active: true,
      };
    }
    case "completion_gap_end":
      return {
        ...state,
        currentGapId: "",
      };
    case "agi_memory_update":
    case "agi_update_candidate":
      return {
        ...state,
        candidatePath: text(ev.candidatePath) || state.candidatePath,
      };
    case "agi_mode_paused":
    case "agi_mode_end": {
      const nextStatus = status(ev.status, ev.type === "agi_mode_paused" ? "paused" : "failed");
      return {
        ...state,
        active: false,
        status: nextStatus,
        reason: text(ev.reason),
        cycle: Math.max(state.cycle, Math.floor(number(ev.cycles, state.cycle))),
        statePath: text(ev.statePath) || state.statePath,
        deterministicEvidence:
          state.deterministicEvidence || ev.deterministicEvidence === true,
        verifierIndependent:
          ev.verifierIndependent === true || state.verifierIndependent,
        sameModelVerifier:
          ev.verifierIndependent === false || state.sameModelVerifier,
        phase: "evaluate",
      };
    }
    case "agi_status": {
      const run = object(ev.run);
      const config = object(run.config);
      const nextStatus = status(run.status, state.status);
      return {
        ...state,
        enabled: typeof ev.enabled === "boolean" ? ev.enabled : state.enabled,
        active: nextStatus === "running",
        runId: text(run.runId) || state.runId,
        profile: profile(run.profile || config.profile, state.profile),
        route: route(run.route || ev.route || config.route, state.route),
        routeReason: text(run.routeReason) || state.routeReason,
        status: nextStatus,
        goal: text(run.goal) || state.goal,
        phase: text(run.currentPhase) || state.phase,
        cycle: Math.max(0, Math.floor(number(run.cycle, state.cycle))),
        maxCycles: Math.max(1, Math.floor(number(config.maxCycles, state.maxCycles))),
        wallClockSec: Math.max(1, Math.floor(number(config.wallClockSec, state.wallClockSec))),
        actionId: text(object(run.actionContract).actionId) || state.actionId,
        actionClass: text(object(run.actionContract).actionClass) || state.actionClass,
        correctionAction: text(object(run.correction).action) || state.correctionAction,
        authorizationRequired:
          object(run.pendingAction).authorizationRequired === true
          || state.authorizationRequired,
        reason: text(run.reason) || state.reason,
        statePath: text(run.statePath || ev.statePath) || state.statePath,
        deterministicEvidence:
          run.deterministicEvidence === true || state.deterministicEvidence,
        verifierIndependent:
          run.verifierIndependent === true || state.verifierIndependent,
        sameModelVerifier:
          run.verifierIndependent === false || state.sameModelVerifier,
      };
    }
    case "agi_control_ack":
      return {
        ...state,
        reason: text(ev.message || ev.reason) || state.reason,
      };
    default:
      return state;
  }
}

export function agiStatusLabel(value: AGIStatus): string {
  return value.replaceAll("_", " ");
}
