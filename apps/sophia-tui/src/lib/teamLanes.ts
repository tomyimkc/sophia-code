/**
 * Presentation-safe state for Sophia team lanes.
 *
 * This module deliberately models what the UI knows rather than pretending to
 * control execution. A "requested" cancel is not a cancelled lane, an
 * auto-dispatch policy makes a run eligible rather than proving that a kernel
 * launched it, and budget enforcement is only claimed when the kernel reports
 * it explicitly.
 */

export type TeamDispatchPolicy = "off" | "ask-first" | "auto";
export type TeamDispatchPolicySource =
  | "saved"
  | "local-default"
  | "public-default";

export interface ResolvedTeamDispatchPolicy {
  policy: TeamDispatchPolicy;
  source: TeamDispatchPolicySource;
  /** True when the owner must decide before any automatic fan-out. */
  confirmationRequired: boolean;
}

export interface TeamDispatchDefaults {
  savedPolicy?: unknown;
  /**
   * An install-specific default. The current development Mac may pass "auto";
   * public builds should omit this and fall back to off.
   */
  localDefault?: TeamDispatchPolicy | null;
  publicDefault?: TeamDispatchPolicy;
}

const DISPATCH_POLICIES = new Set<TeamDispatchPolicy>([
  "off",
  "ask-first",
  "auto",
]);

function isDispatchPolicy(value: unknown): value is TeamDispatchPolicy {
  return (
    typeof value === "string" &&
    DISPATCH_POLICIES.has(value as TeamDispatchPolicy)
  );
}

/**
 * Resolve a policy without silently opting a public install into team mode.
 * Saved owner choice wins, then an explicit machine-local default, then the
 * public off default.
 */
export function resolveTeamDispatchPolicy(
  defaults: TeamDispatchDefaults = {},
): ResolvedTeamDispatchPolicy {
  if (isDispatchPolicy(defaults.savedPolicy)) {
    return {
      policy: defaults.savedPolicy,
      source: "saved",
      confirmationRequired: defaults.savedPolicy === "ask-first",
    };
  }

  if (isDispatchPolicy(defaults.localDefault)) {
    return {
      policy: defaults.localDefault,
      source: "local-default",
      confirmationRequired: defaults.localDefault === "ask-first",
    };
  }

  const publicDefault = isDispatchPolicy(defaults.publicDefault)
    ? defaults.publicDefault
    : "off";
  return {
    policy: publicDefault,
    source: "public-default",
    confirmationRequired: publicDefault === "ask-first",
  };
}

export type TeamDispatchDecision =
  | "disabled"
  | "not-eligible"
  | "confirmation-required"
  | "eligible";

/**
 * A display decision, not an execution command. "eligible" means the UI may
 * ask the kernel to dispatch; it does not claim that any lane was started.
 */
export function teamDispatchDecision(
  policy: TeamDispatchPolicy,
  taskEligible: boolean,
): TeamDispatchDecision {
  if (policy === "off") return "disabled";
  if (!taskEligible) return "not-eligible";
  if (policy === "ask-first") return "confirmation-required";
  return "eligible";
}

export type TeamLaneLifecycle =
  | "proposed"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "interrupting"
  | "cancelled"
  | "interrupted"
  | "abandoned";

export type LaneControlSignal =
  | "none"
  | "requested"
  | "acknowledged"
  | "rejected"
  | "unsupported"
  | "unknown";

export interface LaneControlState {
  cancel: LaneControlSignal;
  interrupt: LaneControlSignal;
}

export type LaneBudgetSource =
  | "configured"
  | "ui-estimate"
  | "kernel-reported"
  | "unknown";

export interface LaneBudgetMetric {
  /** Null means no limit is known to the UI. */
  limit: number | null;
  /** Null means no usage reading has been reported. */
  used: number | null;
  source: LaneBudgetSource;
  /**
   * Only "kernel-reported" may be presented as enforcement. Everything else
   * is an informational display limit.
   */
  enforcement: "not-reported" | "kernel-reported";
}

export interface LaneBudgets {
  tokens: LaneBudgetMetric;
  timeMs: LaneBudgetMetric;
  tools: LaneBudgetMetric;
}

export type LaneBudgetStatus =
  | "unknown"
  | "ok"
  | "warning"
  | "exhausted"
  | "over";

export interface LaneBudgetReading {
  status: LaneBudgetStatus;
  remaining: number | null;
  ratio: number | null;
  enforcementReported: boolean;
}

function finiteNonNegative(value: number | null): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

/** Compute a bounded meter while preserving unknown/invalid readings. */
export function readLaneBudget(metric: LaneBudgetMetric): LaneBudgetReading {
  const limit = finiteNonNegative(metric.limit);
  const used = finiteNonNegative(metric.used);
  const enforcementReported = metric.enforcement === "kernel-reported";

  if (limit === null || limit === 0 || used === null) {
    return {
      status: "unknown",
      remaining: null,
      ratio: null,
      enforcementReported,
    };
  }

  const ratio = used / limit;
  const remaining = Math.max(0, limit - used);
  const status: LaneBudgetStatus =
    used > limit
      ? "over"
      : used === limit
        ? "exhausted"
        : ratio >= 0.8
          ? "warning"
          : "ok";
  return { status, remaining, ratio, enforcementReported };
}

export type LaneResultState =
  | "none"
  | "partial"
  | "ready"
  | "merged"
  | "excluded"
  | "conflict"
  | "failed";

export interface LaneResult {
  state: LaneResultState;
  summary?: string;
  localArtifactIds?: string[];
  conflictIds?: string[];
}

export interface TeamLane {
  id: string;
  title: string;
  role?: string;
  division?: string;
  source?: string;
  skills?: string[];
  lifecycle: TeamLaneLifecycle;
  control: LaneControlState;
  budgets: LaneBudgets;
  result: LaneResult;
  detail?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface TeamMergeConflict {
  id: string;
  laneIds: string[];
  summary: string;
  state: "open" | "resolved" | "excluded";
}

export type TeamMergeState =
  | "idle"
  | "collecting"
  | "ready"
  | "merging"
  | "merged"
  | "conflict"
  | "failed";

export interface TeamMerge {
  state: TeamMergeState;
  includedLaneIds: string[];
  excludedLaneIds: string[];
  conflicts: TeamMergeConflict[];
  detail?: string;
}

export interface TeamLaneState {
  /** Team-lane UI state and receipts are never uploaded by this module. */
  storage: "local-only";
  dispatch: ResolvedTeamDispatchPolicy;
  taskEligible: boolean;
  lanes: TeamLane[];
  merge: TeamMerge;
  selectedLaneId?: string | null;
}

export const EMPTY_LANE_CONTROL: LaneControlState = Object.freeze({
  cancel: "none",
  interrupt: "none",
});

export function emptyLaneBudgets(): LaneBudgets {
  const metric = (): LaneBudgetMetric => ({
    limit: null,
    used: null,
    source: "unknown",
    enforcement: "not-reported",
  });
  return { tokens: metric(), timeMs: metric(), tools: metric() };
}

const TERMINAL_LIFECYCLES = new Set<TeamLaneLifecycle>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "abandoned",
]);

export function isTerminalLane(lane: TeamLane): boolean {
  return TERMINAL_LIFECYCLES.has(lane.lifecycle);
}

export function canRequestLaneCancel(lane: TeamLane): boolean {
  return (
    !isTerminalLane(lane) &&
    lane.lifecycle !== "proposed" &&
    lane.lifecycle !== "cancelling" &&
    lane.control.cancel !== "requested" &&
    lane.control.cancel !== "acknowledged" &&
    lane.control.cancel !== "unsupported"
  );
}

export function canRequestLaneInterrupt(lane: TeamLane): boolean {
  return (
    !isTerminalLane(lane) &&
    (lane.lifecycle === "starting" ||
      lane.lifecycle === "running" ||
      lane.lifecycle === "waiting") &&
    lane.control.interrupt !== "requested" &&
    lane.control.interrupt !== "acknowledged" &&
    lane.control.interrupt !== "unsupported"
  );
}

export interface TeamLaneCounts {
  total: number;
  active: number;
  terminal: number;
  succeeded: number;
  failed: number;
  conflicts: number;
  controlPending: number;
}

export function countTeamLanes(lanes: readonly TeamLane[]): TeamLaneCounts {
  let active = 0;
  let terminal = 0;
  let succeeded = 0;
  let failed = 0;
  let conflicts = 0;
  let controlPending = 0;

  for (const lane of lanes) {
    if (isTerminalLane(lane)) terminal += 1;
    else if (lane.lifecycle !== "proposed") active += 1;
    if (lane.lifecycle === "succeeded") succeeded += 1;
    if (lane.lifecycle === "failed") failed += 1;
    if (lane.result.state === "conflict") conflicts += 1;
    if (
      lane.control.cancel === "requested" ||
      lane.control.cancel === "acknowledged" ||
      lane.control.interrupt === "requested" ||
      lane.control.interrupt === "acknowledged"
    ) {
      controlPending += 1;
    }
  }

  return {
    total: lanes.length,
    active,
    terminal,
    succeeded,
    failed,
    conflicts,
    controlPending,
  };
}
