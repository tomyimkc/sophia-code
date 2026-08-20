/**
 * Run-progress phases for the loading indicator.
 * Each phase has a distinct human-readable label.
 */

export type LoadPhase =
  | "idle"
  | "starting"
  | "planning"
  | "thinking"
  | "tool"
  | "streaming"
  | "awaiting_permission"
  | "paused"
  | "finalizing"
  | "done"
  | "error"
  | "cancelled"
  | "cancelling";

export interface ProgressState {
  phase: LoadPhase;
  /** Extra context, e.g. tool name */
  detail: string;
  /** Live stream tail while phase === streaming */
  streamPreview: string;
}

export const IDLE_PROGRESS: ProgressState = {
  phase: "idle",
  detail: "",
  streamPreview: "",
};

export interface SequencedProgressState extends ProgressState {
  protocolSequence: number;
}

export const IDLE_SEQUENCED_PROGRESS: SequencedProgressState = {
  ...IDLE_PROGRESS,
  protocolSequence: 0,
};

/** Stable replacement key for progress snapshots in a headless event buffer. */
export function progressCoalesceKey(
  type: string,
  ev: Record<string, unknown>,
): string | null {
  if (![
    "thinking", "thinking_token", "token", "goal_status",
    "bench_progress", "tbench_progress", "gaia_progress",
    "taubench_progress", "update_progress", "provider_progress",
    "provider_wait", "tool_wait", "dynamic_workflow_stage_progress",
  ].includes(type)) return null;
  return `progress:${String(ev.runId || "")}:${String(ev.lane || "")}:${type}`;
}

/**
 * Sequence-aware pure reducer for headless consumers. v1 events (no protocol
 * sequence) still apply in arrival order; v2 stale snapshots are ignored.
 */
export function reduceProgressEvent(
  current: SequencedProgressState,
  type: string,
  ev: Record<string, unknown>,
): SequencedProgressState {
  const rawSequence = Number(ev.protocolSequence ?? ev.sequence);
  const hasSequence = Number.isFinite(rawSequence) && rawSequence > 0;
  if (hasSequence && rawSequence <= current.protocolSequence) return current;
  const patch = phaseFromBridgeEvent(type, ev);
  if (!patch) {
    return hasSequence ? { ...current, protocolSequence: rawSequence } : current;
  }
  return {
    ...current,
    ...patch,
    protocolSequence: hasSequence ? rawSequence : current.protocolSequence,
  };
}

/** Spinner frames (braille) */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function conciseDetail(detail: string, max = 52): string {
  const clean = detail.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function phaseLabel(phase: LoadPhase, detail = ""): string {
  const short = conciseDetail(detail);
  switch (phase) {
    case "idle":
      return "";
    case "starting":
      return short.startsWith("Agents ·")
        ? short
        : short
          ? `Starting · ${short}`
          : "Starting…";
    case "planning":
      return /^(?:Workflow|Goal|Agents)\b/.test(short)
        ? short
        : short
          ? `Planning · ${short}`
          : "Planning…";
    case "thinking":
      if (/^Workflow\b/.test(short)) return short;
      if (/\bretry\b/i.test(short)) return `Retrying · ${short}`;
      return "Thinking…";
    case "tool":
      return short ? `Tool · ${short}` : "Tool…";
    case "streaming":
      return "Writing…";
    case "awaiting_permission":
      return short ? `Approval · ${short}` : "Approval needed";
    case "paused":
      return short ? `Waiting · ${short}` : "Waiting for input";
    case "finalizing":
      return /^Workflow\b/.test(short) ? "Workflow · finalizing" : "Finalizing…";
    case "done":
      return "Done";
    case "error":
      return short ? `Error · ${short}` : "Error";
    case "cancelled":
      return "Cancelled";
    case "cancelling":
      return "Cancelling…";
    default:
      return "Working…";
  }
}

/** Map bridge event type → progress phase */
export function phaseFromBridgeEvent(
  type: string,
  ev: Record<string, unknown>,
): Partial<ProgressState> | null {
  switch (type) {
    case "run_start":
    case "lane_start":
      return { phase: "starting", detail: "", streamPreview: "" };
    case "dynamic_workflow_route":
      return {
        phase: "planning",
        detail: "Workflow · routing",
        streamPreview: "",
      };
    case "dynamic_workflow_start":
      return {
        phase: "planning",
        detail: "Workflow · planning",
        streamPreview: "",
      };
    case "dynamic_workflow_controller_start": {
      const stage = Math.max(0, Math.floor(Number(ev.stage) || 0));
      const review = String(ev.phase || "").toLowerCase() === "review";
      return {
        phase: "planning",
        detail: review
          ? `Workflow ${stage} · review`
          : "Workflow · planning",
        streamPreview: "",
      };
    }
    case "dynamic_workflow_controller_end":
      return {
        phase: "planning",
        detail: `Workflow · ${String(ev.action || "decision")}`,
        streamPreview: "",
      };
    case "dynamic_workflow_stage_start": {
      const stage = Math.max(0, Math.floor(Number(ev.stage) || 0));
      const count = Math.max(0, Math.floor(Number(ev.taskCount) || 0));
      return {
        phase: "thinking",
        detail: `Workflow ${stage} · ${count} agents`,
        streamPreview: "",
      };
    }
    case "dynamic_workflow_stage_progress": {
      const stage = Math.max(0, Math.floor(Number(ev.stage) || 0));
      const terminal = Math.max(0, Math.floor(Number(ev.terminal) || 0));
      const total = Math.max(
        terminal,
        Math.floor(
          Number(ev.total)
          || terminal
            + (Number(ev.active) || 0)
            + (Number(ev.queued) || 0),
        ),
      );
      const eta = Number(ev.estimatedRemainingSec);
      const etaText = Number.isFinite(eta) && eta >= 0
        ? eta < 60
          ? ` · ETA ${Math.ceil(eta)}s`
          : ` · ETA ~${Math.ceil(eta / 60)}m`
        : "";
      return {
        phase: "thinking",
        detail: `Workflow ${stage} · ${terminal}/${total}${etaText}`,
        streamPreview: "",
      };
    }
    case "dynamic_workflow_stage_deadline_extended": {
      const stage = Math.max(0, Math.floor(Number(ev.stage) || 0));
      return {
        phase: "thinking",
        detail: `Workflow ${stage} · active`,
        streamPreview: "",
      };
    }
    case "dynamic_workflow_worker_progress": {
      const stage = Math.max(0, Math.floor(Number(ev.stage) || 0));
      return {
        phase: "thinking",
        detail: stage > 0 ? `Workflow ${stage} · active` : "Workflow · active",
        streamPreview: "",
      };
    }
    case "dynamic_workflow_worker_timeout":
      return {
        phase: "planning",
        detail: "Workflow · worker timeout",
        streamPreview: "",
      };
    case "dynamic_workflow_stage_end": {
      const stage = Math.max(0, Math.floor(Number(ev.stage) || 0));
      return {
        phase: "planning",
        detail: `Workflow ${stage} · review`,
        streamPreview: "",
      };
    }
    case "dynamic_workflow_synthesis_start":
      return {
        phase: "finalizing",
        detail: "Workflow · synthesis",
        streamPreview: "",
      };
    case "dynamic_workflow_end":
      return {
        phase: "finalizing",
        detail: "Workflow · complete",
        streamPreview: "",
      };
    case "orchestration_plan": {
      const lanes = Math.max(1, Math.floor(Number(ev.teamLanes) || 1));
      const detail = ev.teamCandidate === true
        ? `Agents · ${lanes}`
        : ev.substantiveTask === true || ev.goalCandidate === true
          ? ""
          : "";
      return ev.teamCandidate === true
        || ev.substantiveTask === true
        || ev.goalCandidate === true
        ? { phase: "planning", detail, streamPreview: "" }
        : null;
    }
    case "team_start": {
      const n = Number(ev.team);
      const detail = Number.isFinite(n) && n > 0
        ? `Agents · ${Math.floor(n)}`
        : "Agents · active";
      return { phase: "starting", detail, streamPreview: "" };
    }
    case "synthesis_start": {
      const n = Number(ev.lanes);
      const detail =
        Number.isFinite(n) && n > 0
          ? `synthesizing ${Math.floor(n)} lanes`
          : "synthesizing lanes";
      return { phase: "finalizing", detail, streamPreview: "" };
    }
    case "team_drain_extended": {
      const role = String(ev.role || ev.lane || "lane");
      return {
        phase: "finalizing",
        detail: `${role} final report · bounded wait`,
        streamPreview: "",
      };
    }
    case "lanes_abandoned":
      // Still a run in progress — synthesis may continue without the dropped
      // lanes. The transcript row carries the full warning; progress just flags it.
      return {
        phase: "planning",
        detail: "lanes abandoned — synthesis without them",
        streamPreview: "",
      };
    case "goal":
      return { phase: "planning", detail: String(ev.text || "").slice(0, 60) };
    case "thinking":
      return {
        phase: "thinking",
        detail: [ev.provider, ev.model].filter(Boolean).join(":") || "",
      };
    case "thinking_token":
      return { phase: "thinking" };
    case "tool_call":
      return { phase: "tool", detail: String(ev.tool || "tool") };
    case "tool_wait": {
      const elapsed = Math.max(0, Math.floor(Number(ev.elapsedSec) || 0));
      return {
        phase: "tool",
        detail: `${String(ev.tool || "tool")} · ${elapsed}s`,
      };
    }
    case "provider_wait": {
      const elapsed = Math.max(0, Math.floor(Number(ev.elapsedSec) || 0));
      return { phase: "thinking", detail: `provider · ${elapsed}s` };
    }
    case "provider_progress": {
      const provider = [ev.provider, ev.model].filter(Boolean).join(":");
      const activity = String(ev.phase || "activity").toLowerCase();
      const detail = String(ev.detail || "").trim();
      const prefix = provider || "provider";
      const visible = detail ? `${prefix} · ${detail}` : prefix;
      if (activity === "provider_tool" || activity === "tool") {
        return {
          phase: "tool",
          detail: String(ev.tool || detail || "delegated-provider tool"),
        };
      }
      if (activity === "planning" || activity === "compacting") {
        return { phase: "planning", detail: visible, streamPreview: "" };
      }
      if (activity === "retrying" || activity === "fallback") {
        const delay = Number(ev.delaySec);
        return {
          phase: "thinking",
          detail:
            Number.isFinite(delay) && delay > 0
              ? `${visible} · retry in ${delay.toFixed(1)}s`
              : visible,
          streamPreview: "",
        };
      }
      if (activity === "finalizing") {
        return { phase: "finalizing", detail: visible, streamPreview: "" };
      }
      if (activity === "error") {
        return { phase: "error", detail: visible, streamPreview: "" };
      }
      if (activity === "completed") {
        // The provider is done, but Sophia may still need to parse tools,
        // synthesize lanes, or emit run_finished. Do not mark the run done.
        return {
          phase: "finalizing",
          detail: `${prefix} response received`,
          streamPreview: "",
        };
      }
      if (activity === "generating") {
        return { phase: "streaming", detail: visible };
      }
      if (
        activity === "requesting" ||
        activity === "connecting" ||
        activity === "reasoning" ||
        activity === "activity"
      ) {
        return { phase: "thinking", detail: visible, streamPreview: "" };
      }
      return { phase: "thinking", detail: visible, streamPreview: "" };
    }
    case "tool_result":
      return { phase: "planning", detail: String(ev.tool || "tool") + " done" };
    case "token":
      return { phase: "streaming" };
    case "approval_request":
      return {
        phase: "awaiting_permission",
        detail: String(ev.tool || "tool"),
      };
    case "final":
      return { phase: "finalizing", detail: "" };
    case "steer_ack":
      return { phase: "planning", detail: "steering queued", streamPreview: "" };
    case "steer_applied":
      return { phase: "planning", detail: "steering applied", streamPreview: "" };
    case "queue_next_ack":
      // Queue-next is deliberately NOT steering the active run, so its ack must
      // not overwrite that run's phase.
      return null;
    case "cancel_ack":
      return ev.status === "cancelling"
        ? { phase: "cancelling", detail: String(ev.stage || "requested"), streamPreview: "" }
        : null;
    case "restart_stage": {
      const stage = String(ev.stage || "");
      if (stage === "cancelling") {
        return { phase: "cancelling", detail: "bridge restart", streamPreview: "" };
      }
      if (stage === "terminating" || stage === "starting") {
        return { phase: "starting", detail: `bridge ${stage}`, streamPreview: "" };
      }
      if (stage === "failed") {
        return { phase: "error", detail: "bridge restart failed", streamPreview: "" };
      }
      if (stage === "ready") {
        return { phase: "idle", detail: "", streamPreview: "" };
      }
      return null;
    }
    case "result":
      return ev.awaitingInput === true
        || String(ev.goalStatus || "") === "awaiting_input"
        || ["paused", "awaiting_input", "interrupted"].includes(
          String(ev.agiStatus || "").toLowerCase(),
        )
        ? {
            phase: "paused",
            detail: String(ev.goalReason || ev.incompleteReason || "operator action required").slice(0, 80),
            streamPreview: "",
          }
        : {
            phase: "finalizing",
            detail: "answer received · verifying completion",
            streamPreview: "",
          };
    case "run_finished":
      return {
        phase:
          ev.reason === "cancel"
            ? "cancelled"
            : ev.ok === false
              ? "error"
              : "done",
        detail: ev.ok === false ? String(ev.reason || "failed") : "",
        streamPreview: "",
      };
    case "error":
      return {
        phase: "error",
        detail: String(ev.error || ev.message || "unknown").slice(0, 80),
        streamPreview: "",
      };
    // Autonomous goal-continuation (run_goal_loop). The terminal `result` event
    // still fires afterwards and finalises; these give live per-attempt status.
    case "goal_triage":
      // Only mark a phase when explicit long-horizon intent selected the outer
      // loop; ordinary bounded tasks leave the phase untouched here.
      return ev.willLoop === true
        ? { phase: "planning", detail: "Goal · starting", streamPreview: "" }
        : null;
    case "goal_accumulated":
      // The prompt was merged into the session's running (accumulated) goal.
      return { phase: "planning", detail: "Goal · updated", streamPreview: "" };
    case "goal_mode_start":
      return { phase: "planning", detail: "Goal · active", streamPreview: "" };
    case "goal_status":
      return { phase: "planning", detail: `Goal · attempt ${String(ev.attempt || "?")}`, streamPreview: "" };
    case "goal_continuation":
      return { phase: "planning", detail: `Goal · attempt ${String(ev.nextAttempt || "?")}`, streamPreview: "" };
    case "goal_awaiting_input":
      return {
        phase: "paused",
        detail: String(ev.reason || ev.remaining || "operator action required").slice(0, 80),
        streamPreview: "",
      };
    case "goal_achieved":
      return { phase: "done", detail: "goal achieved", streamPreview: "" };
    case "goal_unachievable":
    case "goal_bound_hit":
    case "goal_cancelled":
      return { phase: "error", detail: String(ev.reason || type).slice(0, 80), streamPreview: "" };
    default:
      return null;
  }
}
