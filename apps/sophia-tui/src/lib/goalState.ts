/**
 * Persistent "current goal" state for the goal/todo side panel.
 *
 * The kernel's goal-continuation harness (agent/goal_harness.py) already emits
 * a rich stream of `goal_*` bridge events; until now the TUI rendered them only
 * as ephemeral transcript rows + a status-line string (App.tsx's goal handler),
 * so there was no durable "what is this session working toward right now?" to
 * pin a panel to. This module folds those events into one small state object.
 *
 * Pure (no React/Ink) so the fold is unit-tested without spawning a bridge, the
 * same way progress.ts and liveness.ts are. It is also WHY the panel is
 * model-agnostic for free: every model (020s cloud, omlx local) produces these
 * same upstream events — automatic long-horizon routing happens in the kernel,
 * before provider-specific model output — so nothing here knows or cares which
 * model answered.
 */

export type GoalPhase =
  | "idle"         // no goal in flight (fresh session, or a plain run finished)
  | "running"      // a run/goal is actively in flight
  | "achieved"     // goal loop concluded: achieved
  | "awaiting_input" // paused until the operator supplies input or takes an owner-only action
  | "unachievable" // goal loop concluded: confidently unachievable
  | "bound_hit"    // goal loop stopped on a safety bound (max continuations / no progress)
  | "cancelled";   // goal loop cancelled

export interface GoalRevision {
  revision: number;
  text: string;
  source: string;
  reason: string;
  updatedAt: string;
  stage: number | null;
  stageCount: number | null;
}

export interface GoalState {
  phase: GoalPhase;
  /** Current harness-owned goal text. The raw prompt is never treated as this. */
  text: string;
  /** Original operator prompt, retained separately for inspectable provenance. */
  prompt: string;
  /** Monotonic harness revision number for the current displayed goal. */
  revision: number;
  /** Highest explicit bridge revision observed, including semantic replays. */
  backendRevision: number;
  /** Source/reason metadata for the current harness revision. */
  source: string;
  reason: string;
  updatedAt: string;
  /** Optional workflow position associated with the current goal revision. */
  stage: number | null;
  stageCount: number | null;
  /** Bounded revision history for right-panel progressive disclosure. */
  history: GoalRevision[];
  /** Latest concrete work item reported by the normal tool loop. */
  activity: string;
  /** Live "what's left" sub-line from goal_status.remaining. */
  remaining: string;
  /** Last reported confidence (0..1), or null if never reported. */
  confidence: number | null;
  /** Last status word (goal_status.status / terminal reason), for the sub-line. */
  statusDetail: string;
}

export const EMPTY_GOAL_STATE: GoalState = {
  phase: "idle",
  text: "",
  prompt: "",
  revision: 0,
  backendRevision: 0,
  source: "",
  reason: "",
  updatedAt: "",
  stage: null,
  stageCount: null,
  history: [],
  activity: "",
  remaining: "",
  confidence: null,
  statusDetail: "",
};

/** A bridge event, loosely typed — the reducer reads only the fields it needs. */
export type GoalEvent = { type: string } & Record<string, unknown>;

/**
 * Bridge event types that own the persistent Goal projection.
 *
 * Keep this predicate shared with App.tsx: bridge envelopes are normalised to
 * their inner event before the app routes them, so checking only the legacy
 * outer `event` type silently drops every `goal_*` receipt.
 */
const GOAL_LIFECYCLE_EVENT_TYPES = new Set([
  "goal_update",
  "goal_triage",
  "goal_accumulated",
  "goal_mode_start",
  "goal_start",
  "goal_status",
  "goal_continuation",
  "goal_achieved",
  "goal_awaiting_input",
  "goal_unachievable",
  "goal_bound_hit",
  "goal_cancelled",
]);
const TERMINAL_GOAL_LIFECYCLE_EVENT_TYPES = new Set([
  "goal_achieved",
  "goal_awaiting_input",
  "goal_unachievable",
  "goal_bound_hit",
  "goal_cancelled",
]);

export function isGoalLifecycleEvent(type: string): boolean {
  return GOAL_LIFECYCLE_EVENT_TYPES.has(type);
}

export function isTerminalGoalLifecycleEvent(type: string): boolean {
  return TERMINAL_GOAL_LIFECYCLE_EVENT_TYPES.has(type);
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  return v == null ? "" : String(v);
}

function asConfidence(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asPositiveInteger(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * An explicit operator-provided Goal title is already concise enough to show
 * before Main publishes its first harness revision. Other prompts remain only
 * in `state.prompt`; copying them into `state.text` made the Goal panel look
 * like a frozen transcript rather than a live execution contract.
 */
function explicitGoalTitle(value: unknown): string {
  const text = asString(value).trim();
  const named = /\b(?:create|publish)\s+(?:a\s+)?goal\s+(?:titled|named)\s+(?:["“]([^"”\n]+)["”]|`([^`\n]+)`|([^\n.]+))/i.exec(text);
  const title = named?.slice(1).find((part) => typeof part === "string" && part.trim());
  // A sentence-ending period conventionally falls inside closing quotes in
  // English prose. It belongs to the instruction, not the Goal title.
  return (title || "").trim().replace(/[.!?。！？]+$/, "");
}

function goalRevision(
  state: GoalState,
  event: GoalEvent,
  fallback: {
    text?: unknown;
    source: string;
    reason?: string;
    updatedAt?: unknown;
  },
): GoalState {
  const text = asString(
    event.goal ?? event.text ?? event.currentGoal ?? fallback.text,
  ).trim();
  if (!text) return state;

  const requestedRevision = asPositiveInteger(event.revision);
  if (
    requestedRevision != null
    && requestedRevision <= state.backendRevision
  ) {
    return state;
  }
  const revision = requestedRevision != null
    ? Math.max(state.revision + 1, requestedRevision)
    : state.revision + 1;
  const source = asString(event.source).trim() || fallback.source;
  const reason = asString(event.reason).trim() || fallback.reason || "";
  const updatedAt = asString(
    event.updatedAt ?? event.endedAt ?? event.ts ?? fallback.updatedAt,
  ).trim();
  const stage = asPositiveInteger(event.stage ?? event.currentStage);
  const rawStageCount = asPositiveInteger(
    event.stageCount ?? event.plannedStages ?? event.totalStages,
  );
  const stageCount = rawStageCount == null
    ? state.stageCount
    : Math.max(stage ?? state.stage ?? 0, rawStageCount);
  const nextRevision: GoalRevision = {
    revision,
    text,
    source,
    reason,
    updatedAt,
    stage: stage ?? state.stage,
    stageCount,
  };
  const last = state.history[state.history.length - 1];
  const duplicate = Boolean(
    last
    && last.text === nextRevision.text
    && last.source === nextRevision.source
    && last.reason === nextRevision.reason
    && last.stage === nextRevision.stage
    && last.stageCount === nextRevision.stageCount,
  );
  if (duplicate) {
    return requestedRevision == null
      ? state
      : { ...state, backendRevision: requestedRevision };
  }
  return {
    ...state,
    phase: state.phase === "idle" ? "running" : state.phase,
    text,
    revision,
    backendRevision: requestedRevision ?? state.backendRevision,
    source,
    reason,
    updatedAt,
    stage: nextRevision.stage,
    stageCount,
    history: [...state.history, nextRevision].slice(-32),
  };
}

function toolLabel(value: unknown): string {
  const tool = asString(value).trim();
  if (tool === "todo_write") return "To-do";
  return tool ? tool.replaceAll("_", " ") : "Tool";
}

function todoActivity(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const items = value.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
  if (items.length === 0) return "";
  const completed = items.filter((item) => item.status === "completed").length;
  const active = items.filter((item) => item.status === "in_progress").length;
  if (completed === items.length) return `To-do · ${completed}/${items.length} complete`;
  if (active > 0) return `To-do · ${active}/${items.length} in progress`;
  return `To-do · ${completed}/${items.length} complete`;
}

/**
 * Fold one bridge event into the goal state. Unknown events are a no-op, so this
 * can be fed the whole event stream without pre-filtering. Terminal goal phases
 * (achieved/awaiting_input/unachievable/bound_hit/cancelled) are STICKY across
 * a run's terminal `result`/`error` event — a plain run ending must not blank
 * "achieved" back to idle and lose the verdict the loop just reached; the NEXT
 * run_start resets everything.
 */
export function goalReducer(state: GoalState, ev: GoalEvent): GoalState {
  switch (ev.type) {
    case "run_start": {
      const prompt = asString(ev.goal).trim();
      const title = explicitGoalTitle(prompt);
      const base: GoalState = {
        ...EMPTY_GOAL_STATE,
        phase: "running",
        prompt,
        statusDetail: title ? "operator goal" : "Main is defining the goal",
      };
      return title
        ? goalRevision(base, { type: "goal_update", goal: title }, {
            source: "operator-title",
            reason: "explicit Goal title",
          })
        : base;
    }
    case "goal_update":
      return goalRevision(state, ev, {
        source: "main-harness",
        reason: "goal revised during execution",
      });
    case "goal_triage":
      if (ev.isGoal !== true) return state;
      return goalRevision({
        ...state,
        phase: "running",
        confidence: asConfidence(ev.confidence) ?? state.confidence,
        statusDetail: ev.willLoop === true ? "running autonomously" : "single answer",
      }, ev, {
        text: ev.goal,
        source: "goal-triage",
        reason: ev.willLoop === true ? "selected for goal mode" : "bounded goal",
      });
    case "goal_accumulated":
      return goalRevision({
        ...state,
        phase: "running",
        confidence: asConfidence(ev.confidence) ?? state.confidence,
        statusDetail: ev.continuesPrior === true ? "extends prior goal" : "new goal",
      }, {
        ...ev,
        goal: ev.accumulatedGoal,
      }, {
        text: ev.accumulatedGoal,
        source: "goal-accumulator",
        reason: ev.continuesPrior === true ? "extended prior goal" : "new accumulated goal",
      });
    case "goal_mode_start":
    case "goal_start":
      return goalRevision({ ...state, phase: "running" }, ev, {
        text: ev.goal,
        source: ev.type.replaceAll("_", "-"),
      });
    case "goal_status":
      return {
        ...state,
        phase: "running",
        remaining: asString(ev.remaining),
        confidence: asConfidence(ev.confidence) ?? state.confidence,
        statusDetail: asString(ev.status) || state.statusDetail,
      };
    case "todo_update": {
      const activity = todoActivity(ev.items);
      return activity ? { ...state, activity } : state;
    }
    case "tool_call":
      // A stale/cross-run tool event must not manufacture an active Goal after
      // the panel has been reset. Legitimate events always follow run_start.
      if (state.phase === "idle" && !state.text) return state;
      return {
        ...state,
        activity: `${toolLabel(ev.tool)} running`,
      };
    case "tool_result":
      if (state.phase === "idle" && !state.text) return state;
      return {
        ...state,
        activity: `${toolLabel(ev.tool)} ${ev.ok === false ? "failed" : "complete"}`,
      };
    case "goal_continuation":
      return {
        ...state,
        phase: "running",
        remaining: asString(ev.remaining) || state.remaining,
        statusDetail: `continuing → attempt ${asString(ev.nextAttempt) || "?"}`,
      };
    case "goal_achieved":
      return { ...state, phase: "achieved", confidence: asConfidence(ev.confidence) ?? state.confidence, statusDetail: asString(ev.reason) || "achieved", remaining: "" };
    case "goal_awaiting_input":
      return {
        ...state,
        phase: "awaiting_input",
        confidence: asConfidence(ev.confidence) ?? state.confidence,
        statusDetail: asString(ev.reason) || "awaiting operator input",
        remaining: asString(ev.remaining) || state.remaining,
      };
    case "goal_unachievable":
      return { ...state, phase: "unachievable", statusDetail: asString(ev.reason) || "unachievable", remaining: "" };
    case "goal_bound_hit":
      return { ...state, phase: "bound_hit", statusDetail: asString(ev.reason) || "bound hit", remaining: "" };
    case "goal_cancelled":
      return { ...state, phase: "cancelled", statusDetail: asString(ev.reason) || "cancelled", remaining: "" };
    case "result":
    case "error":
      // The run ended. A plain run (still "running") goes idle but KEEPS its text
      // so the panel shows the last goal greyed, not blank. A terminal goal
      // verdict is sticky (see doc) — never downgrade it here.
      if (state.phase === "running" || state.phase === "idle") {
        return {
          ...state,
          phase: "idle",
          activity: ev.type === "error"
            ? "run ended with an error"
            : state.activity || "completed",
          remaining: "",
        };
      }
      return { ...state, remaining: "" };
    default:
      return state;
  }
}

/** Short human label + ok-flag for a phase, for the panel sub-line. */
export function goalPhaseLabel(phase: GoalPhase): { label: string; ok: boolean | null } {
  switch (phase) {
    case "achieved": return { label: "achieved", ok: true };
    case "awaiting_input": return { label: "awaiting your input", ok: null };
    case "unachievable": return { label: "unachievable", ok: false };
    case "bound_hit": return { label: "stopped (safety bound)", ok: false };
    case "cancelled": return { label: "cancelled", ok: false };
    case "running": return { label: "working…", ok: null };
    default: return { label: "", ok: null };
  }
}

/** Glyph-before-colour marker for the phase (WCAG 1.4.1), matching epistemicGlyphs style. */
export function goalPhaseGlyph(phase: GoalPhase): string {
  switch (phase) {
    case "achieved": return "✓";
    case "awaiting_input": return "?";
    case "unachievable": return "✗";
    case "bound_hit": return "⊘";
    case "cancelled": return "■";
    case "running": return "▶";
    default: return "·";
  }
}
