export type PlanStepStatus = "pending" | "in_progress" | "completed";

export type PlanPhase =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "completed"
  | "exit_requested"
  | "exited";

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status: PlanStepStatus;
}

export interface PlanStepInput {
  id: string;
  title: string;
  detail?: string;
}

type ExitReturnPhase = Exclude<PlanPhase, "exit_requested" | "exited" | "completed">;

export interface PlanModeState {
  planId: string;
  title: string;
  phase: PlanPhase;
  steps: PlanStep[];
  revision: number;
  approvedRevision: number | null;
  exitReturnPhase: ExitReturnPhase | null;
  exitReason?: string;
  updatedAt: string;
}

export type PlanAction =
  | { type: "revise"; title?: string; steps?: PlanStepInput[]; at?: string }
  | { type: "submit_for_approval"; at?: string }
  | { type: "approve"; at?: string }
  | { type: "reject"; at?: string }
  | { type: "start"; at?: string }
  | { type: "set_step_status"; stepId: string; status: PlanStepStatus; at?: string }
  | { type: "request_exit"; reason?: string; at?: string }
  | { type: "cancel_exit"; at?: string }
  | { type: "confirm_exit"; at?: string }
  | { type: "resume"; at?: string };

export type PlanTransitionCode =
  | "invalid_state"
  | "invalid_action"
  | "empty_plan"
  | "approval_required"
  | "already_active"
  | "step_not_found"
  | "invalid_step_transition";

export interface PlanTransition {
  state: PlanModeState;
  accepted: boolean;
  code?: PlanTransitionCode;
  reason?: string;
}

export interface PlanValidationIssue {
  code: "duplicate_step" | "empty_step_id" | "empty_step_title" | "multiple_active_steps" | "approval_revision_mismatch";
  message: string;
  stepId?: string;
}

function timestamp(at?: string): string {
  return at || new Date().toISOString();
}

function cleanStepInput(step: PlanStepInput): PlanStep {
  return {
    id: String(step.id || "").trim(),
    title: String(step.title || "").trim(),
    ...(step.detail?.trim() ? { detail: step.detail.trim() } : {}),
    status: "pending",
  };
}

function rejected(
  state: PlanModeState,
  code: PlanTransitionCode,
  reason: string,
): PlanTransition {
  return { state, accepted: false, code, reason };
}

function accepted(state: PlanModeState): PlanTransition {
  return { state, accepted: true };
}

function withTime(state: PlanModeState, at?: string): PlanModeState {
  return { ...state, updatedAt: timestamp(at) };
}

export function createPlanModeState(input: {
  planId: string;
  title: string;
  steps?: PlanStepInput[];
  at?: string;
}): PlanModeState {
  const state: PlanModeState = {
    planId: String(input.planId || "").trim(),
    title: String(input.title || "").trim() || "Sophia plan",
    phase: "draft",
    steps: (input.steps || []).map(cleanStepInput),
    revision: 1,
    approvedRevision: null,
    exitReturnPhase: null,
    updatedAt: timestamp(input.at),
  };
  const issues = validatePlanModeState(state);
  if (issues.length) {
    throw new TypeError(`Invalid Sophia plan: ${issues.map((issue) => issue.message).join("; ")}`);
  }
  return state;
}

/**
 * Validate state restored from a local session before allowing it to drive UI
 * or execution. The central safety invariant is at most one in-progress step.
 */
export function validatePlanModeState(state: PlanModeState): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const seen = new Set<string>();
  let active = 0;
  for (const step of state.steps) {
    if (!step.id.trim()) {
      issues.push({ code: "empty_step_id", message: "Plan steps require a stable id." });
    } else if (seen.has(step.id)) {
      issues.push({ code: "duplicate_step", stepId: step.id, message: `Duplicate plan step id: ${step.id}` });
    }
    seen.add(step.id);
    if (!step.title.trim()) {
      issues.push({ code: "empty_step_title", stepId: step.id, message: `Plan step ${step.id || "(unknown)"} has no title.` });
    }
    if (step.status === "in_progress") active += 1;
  }
  if (active > 1) {
    issues.push({
      code: "multiple_active_steps",
      message: `Plan has ${active} in-progress steps; Sophia permits at most one.`,
    });
  }
  if (
    (state.phase === "approved" || state.phase === "running") &&
    state.approvedRevision !== state.revision
  ) {
    issues.push({
      code: "approval_revision_mismatch",
      message: "The executable plan revision is not the approved revision.",
    });
  }
  return issues;
}

export function activePlanStep(state: PlanModeState): PlanStep | null {
  return state.steps.find((step) => step.status === "in_progress") || null;
}

export function planProgress(state: PlanModeState): { completed: number; total: number; percent: number } {
  const total = state.steps.length;
  const completed = state.steps.filter((step) => step.status === "completed").length;
  return { completed, total, percent: total ? Math.round((completed / total) * 100) : 0 };
}

export function planCanExecute(state: PlanModeState): boolean {
  return (
    (state.phase === "approved" || state.phase === "running") &&
    state.approvedRevision === state.revision &&
    validatePlanModeState(state).length === 0
  );
}

export function planExitNeedsConfirmation(state: PlanModeState): boolean {
  return state.phase !== "completed" && state.phase !== "exited";
}

function startNextPending(steps: PlanStep[], afterIndex = -1): PlanStep[] {
  let nextIndex = steps.findIndex((step, index) => index > afterIndex && step.status === "pending");
  if (nextIndex < 0) nextIndex = steps.findIndex((step) => step.status === "pending");
  return nextIndex < 0
    ? steps
    : steps.map((step, index) => index === nextIndex ? { ...step, status: "in_progress" } : step);
}

export function transitionPlanMode(state: PlanModeState, action: PlanAction): PlanTransition {
  const issues = validatePlanModeState(state);
  if (issues.length) {
    return rejected(state, "invalid_state", issues.map((issue) => issue.message).join(" "));
  }

  if (action.type === "revise") {
    if (state.phase === "running" || state.phase === "completed" || state.phase === "exit_requested") {
      return rejected(state, "invalid_action", "Exit or finish the active plan before revising it.");
    }
    const steps = action.steps ? action.steps.map(cleanStepInput) : state.steps.map((step) => ({ ...step, status: "pending" as const }));
    const next = withTime({
      ...state,
      title: action.title?.trim() || state.title,
      phase: "draft",
      steps,
      revision: state.revision + 1,
      approvedRevision: null,
      exitReturnPhase: null,
      exitReason: undefined,
    }, action.at);
    const nextIssues = validatePlanModeState(next);
    return nextIssues.length
      ? rejected(state, "invalid_action", nextIssues.map((issue) => issue.message).join(" "))
      : accepted(next);
  }

  if (action.type === "submit_for_approval") {
    if (state.phase !== "draft") {
      return rejected(state, "invalid_action", "Only a draft plan can be submitted for approval.");
    }
    if (!state.steps.length) {
      return rejected(state, "empty_plan", "Add at least one step before requesting approval.");
    }
    return accepted(withTime({ ...state, phase: "awaiting_approval" }, action.at));
  }

  if (action.type === "approve") {
    if (state.phase !== "awaiting_approval") {
      return rejected(state, "invalid_action", "Approval is only accepted while the current revision is awaiting approval.");
    }
    return accepted(withTime({
      ...state,
      phase: "approved",
      approvedRevision: state.revision,
    }, action.at));
  }

  if (action.type === "reject") {
    if (state.phase !== "awaiting_approval") {
      return rejected(state, "invalid_action", "Only a plan awaiting approval can be returned for revision.");
    }
    return accepted(withTime({
      ...state,
      phase: "draft",
      approvedRevision: null,
    }, action.at));
  }

  if (action.type === "start") {
    if (state.phase !== "approved" || state.approvedRevision !== state.revision) {
      return rejected(state, "approval_required", "The current plan revision must be approved before execution.");
    }
    if (!state.steps.length) {
      return rejected(state, "empty_plan", "An empty plan cannot start.");
    }
    const steps = startNextPending(state.steps);
    const phase: PlanPhase = steps.every((step) => step.status === "completed") ? "completed" : "running";
    return accepted(withTime({ ...state, phase, steps }, action.at));
  }

  if (action.type === "set_step_status") {
    if (state.phase !== "running") {
      return rejected(state, "invalid_action", "Step status can change only while an approved plan is running.");
    }
    const index = state.steps.findIndex((step) => step.id === action.stepId);
    if (index < 0) return rejected(state, "step_not_found", `Unknown plan step: ${action.stepId}`);
    const current = state.steps[index];
    if (current.status === action.status) return accepted(state);

    if (action.status === "in_progress") {
      if (current.status !== "pending") {
        return rejected(state, "invalid_step_transition", "Only a pending step can become in progress.");
      }
      const active = activePlanStep(state);
      if (active) {
        return rejected(state, "already_active", `Complete or pause ${active.id} before starting another step.`);
      }
      const steps = state.steps.map((step, i) => i === index ? { ...step, status: "in_progress" as const } : step);
      return accepted(withTime({ ...state, steps }, action.at));
    }

    if (action.status === "pending") {
      if (current.status !== "in_progress") {
        return rejected(state, "invalid_step_transition", "Only the in-progress step can be paused.");
      }
      const steps = state.steps.map((step, i) => i === index ? { ...step, status: "pending" as const } : step);
      return accepted(withTime({ ...state, steps }, action.at));
    }

    if (current.status !== "in_progress") {
      return rejected(state, "invalid_step_transition", "Only the in-progress step can be completed.");
    }
    let steps = state.steps.map((step, i) => i === index ? { ...step, status: "completed" as const } : step);
    if (steps.every((step) => step.status === "completed")) {
      return accepted(withTime({ ...state, phase: "completed", steps }, action.at));
    }
    steps = startNextPending(steps, index);
    return accepted(withTime({ ...state, steps }, action.at));
  }

  if (action.type === "request_exit") {
    if (!planExitNeedsConfirmation(state) || state.phase === "exit_requested") {
      return rejected(state, "invalid_action", "This plan does not require an exit confirmation.");
    }
    return accepted(withTime({
      ...state,
      phase: "exit_requested",
      exitReturnPhase: state.phase as ExitReturnPhase,
      exitReason: action.reason?.trim() || undefined,
    }, action.at));
  }

  if (action.type === "cancel_exit") {
    if (state.phase !== "exit_requested" || !state.exitReturnPhase) {
      return rejected(state, "invalid_action", "There is no pending plan exit to cancel.");
    }
    return accepted(withTime({
      ...state,
      phase: state.exitReturnPhase,
      exitReturnPhase: null,
      exitReason: undefined,
    }, action.at));
  }

  if (action.type === "confirm_exit") {
    if (state.phase !== "exit_requested") {
      return rejected(state, "invalid_action", "Request plan exit before confirming it.");
    }
    return accepted(withTime({
      ...state,
      phase: "exited",
      steps: state.steps.map((step) => step.status === "in_progress" ? { ...step, status: "pending" } : step),
      exitReturnPhase: null,
    }, action.at));
  }

  if (state.phase !== "exited") {
    return rejected(state, "invalid_action", "Only an exited local plan can be resumed.");
  }
  const phase: PlanPhase = state.steps.every((step) => step.status === "completed")
    ? "completed"
    : state.approvedRevision === state.revision
      ? "approved"
      : "draft";
  return accepted(withTime({
    ...state,
    phase,
    exitReason: undefined,
    exitReturnPhase: null,
  }, action.at));
}

export function planModeReducer(state: PlanModeState, action: PlanAction): PlanModeState {
  return transitionPlanMode(state, action).state;
}
