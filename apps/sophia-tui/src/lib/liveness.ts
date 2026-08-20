/**
 * Turning the bridge's liveness signals into something an operator can act on.
 *
 * `CodeBridge` has always emitted `stall` and `backpressure`, and until now
 * NOTHING subscribed — so a wedged kernel looked exactly like a slow one. The
 * spinner kept turning and there was no way to tell "still thinking" from
 * "this is never coming back".
 *
 * The policy lives here rather than inline in App.tsx so it can be tested
 * without rendering the app, the same way progress.ts and tokens.ts are.
 */

export interface LivenessEffect {
  /** Status-line text. Always present — this is the quiet channel. */
  status: string;
  /**
   * A transcript row, or null for "say nothing". Populated only on the EDGE
   * into a stall: the detector re-fires every poll while the kernel stays
   * silent, and a row per poll would paper the transcript with duplicates of
   * the one message the operator already read.
   */
  row: { text: string; meta: string; ok: boolean } | null;
}

export type BridgeRestartStage =
  | "cancelling"
  | "terminating"
  | "starting"
  | "ready"
  | "failed";

/**
 * Pure restart-stage presentation for headless/UI consumers. The actual
 * lifecycle is owned by bridge.ts and may only signal the child it spawned.
 */
export function restartStageEffect(stage: BridgeRestartStage, detail = ""): LivenessEffect {
  switch (stage) {
    case "cancelling":
      return { status: "restarting bridge — cancelling active run", row: null };
    case "terminating":
      return { status: "restarting bridge — stopping owned child", row: null };
    case "starting":
      return { status: "restarting bridge — starting child", row: null };
    case "ready":
      return { status: "bridge reconnected", row: null };
    case "failed":
      return {
        status: "bridge restart failed",
        row: {
          text: detail || "the owned bridge child did not restart cleanly",
          meta: "restart",
          ok: false,
        },
      };
  }
}

/**
 * Cancellation escalation policy used by staged restart tests/consumers.
 * A non-positive grace disables escalation; NaN never authorizes a signal.
 */
export function shouldTerminateOwnedChild(
  cancelRequested: boolean,
  elapsedMs: number,
  graceMs: number,
): boolean {
  return cancelRequested
    && graceMs > 0
    && Number.isFinite(elapsedMs)
    && elapsedMs >= graceMs;
}

/** Stable key for replacing repeated liveness snapshots instead of appending. */
export function livenessCoalesceKey(
  kind: "stall" | "backpressure" | "restart",
  runId = "",
): string {
  return `liveness:${runId}:${kind}`;
}

/**
 * @param stalled   what the bridge just reported
 * @param sinceMs   silence duration it reported
 * @param announced whether a row has already been emitted for this wedge
 */
export function stallEffect(stalled: boolean, sinceMs: number, announced: boolean): LivenessEffect {
  if (!stalled) {
    // Recovery clears the warning; it does not celebrate. A row here would
    // double the noise of every transient hiccup.
    return { status: announced ? "kernel responding again" : "", row: null };
  }
  if (announced) return { status: "kernel stalled — no output", row: null };

  const secs = Math.max(0, Math.round((Number.isFinite(sinceMs) ? sinceMs : 0) / 1000));
  return {
    status: "kernel stalled — no output",
    row: {
      meta: "stalled",
      ok: false,
      // Names the remedy, not just the symptom: a warning the operator cannot
      // act on is the kind people learn to ignore.
      text:
        `no output from the kernel for ${secs}s — it may be wedged. ` +
        `Esc or Ctrl+C cancels; the run is still counted as in flight.`,
    },
  };
}

/**
 * Backpressure is routine and usually momentary (a large paste, a busy child),
 * so it stays on the quiet channel: status line only, never a transcript row.
 * Rendering a routine state at alert intensity is how a signal becomes noise
 * people disable — the same reason the epistemic chip keeps its routine states
 * dim (Phase0-Research-Synthesis §5, display by exception).
 */
export function backpressureEffect(active: boolean, queued: number): LivenessEffect {
  const n = Number.isFinite(queued) && queued > 0 ? Math.round(queued) : 0;
  return {
    status: active ? `input queued (${n}) — kernel is not reading` : "input flowing",
    row: null,
  };
}

/**
 * Default silence before a wedged run is auto-cancelled. The stall WARNING
 * fires at DEFAULT_STALL_TIMEOUT_MS (45s, bridge.ts); if the kernel is STILL
 * silent at this threshold the run is almost certainly never coming back, so
 * the bridge cancels it rather than leaving the operator staring at a "writing
 * response…" spinner that never resolves — the failure mode this exists to
 * prevent. A productive long run keeps emitting token/tool events and so never
 * goes silent, so this only ever bites a genuinely wedged run. 0 disables.
 */
export const DEFAULT_STALL_GIVE_UP_MS = 120_000;

/**
 * Should a stalled run be auto-cancelled? Pure (tested without the bridge):
 * the run must already be flagged stalled and have been silent at least
 * `giveUpMs`. `giveUpMs <= 0` disables auto-cancel entirely (the operator then
 * cancels by hand, the pre-existing behaviour).
 */
export function shouldGiveUpStall(stalled: boolean, sinceMs: number, giveUpMs: number): boolean {
  return stalled && giveUpMs > 0 && Number.isFinite(sinceMs) && sinceMs >= giveUpMs;
}

/**
 * Should an in-flight run be auto-cancelled for exceeding its overall time
 * budget ("overtime")? A safety net for runaway runs that keep emitting (so the
 * silence-based stall never fires) yet never conclude. `timeoutMs <= 0`
 * disables it — the default — because a hard cap would otherwise kill
 * legitimate long autonomous goals; opt in via SOPHIA_RUN_TIMEOUT_MS.
 */
export function shouldTimeoutRun(runInFlight: boolean, elapsedMs: number, timeoutMs: number): boolean {
  return runInFlight && timeoutMs > 0 && Number.isFinite(elapsedMs) && elapsedMs >= timeoutMs;
}

/**
 * Default overall time budget for a single run. 0 = DISABLED: a hard cap would
 * otherwise kill legitimate long autonomous goals, so overtime is strictly
 * opt-in (SOPHIA_RUN_TIMEOUT_MS). Kept here next to DEFAULT_STALL_GIVE_UP_MS so
 * the bridge's two auto-cancel policy defaults live in the policy module, not
 * scattered through bridge.ts.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 0;

/**
 * One-shot announcement that a wedged run was AUTO-CANCELLED (the bridge's
 * give-up fired). Always a transcript row: this is a state change the operator
 * must not miss, and the give-up latches so it happens at most once per run.
 * Names the cause and the recovery so it reads as a handled failure, not a
 * crash — the cancel-persist path (#1735) already kept the partial conversation.
 */
export function stallTimeoutEffect(sinceMs: number): LivenessEffect {
  const secs = Math.max(0, Math.round((Number.isFinite(sinceMs) ? sinceMs : 0) / 1000));
  return {
    status: "run auto-cancelled — kernel wedged",
    row: {
      meta: "stalled",
      ok: false,
      text:
        `no output for ${secs}s — the run was auto-cancelled (the kernel looked wedged). ` +
        `Partial output was kept; resend the prompt to retry.`,
    },
  };
}

/**
 * One-shot announcement that a run was AUTO-CANCELLED for exceeding its overall
 * time budget ("overtime"). Only reachable when SOPHIA_RUN_TIMEOUT_MS opts in,
 * so the message tells the operator exactly which knob to raise.
 */
export function runTimeoutEffect(elapsedMs: number, timeoutMs: number): LivenessEffect {
  const secs = Math.max(0, Math.round((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000));
  const cap = Math.max(0, Math.round((Number.isFinite(timeoutMs) ? timeoutMs : 0) / 1000));
  return {
    status: "run auto-cancelled — over time budget",
    row: {
      meta: "timeout",
      ok: false,
      text:
        `run hit its ${cap}s time budget after ${secs}s and was auto-cancelled. ` +
        `Partial output was kept; raise SOPHIA_RUN_TIMEOUT_MS (0 disables) if this goal needs longer.`,
    },
  };
}

/**
 * Should an inbound bridge event be dropped because its run already terminated?
 *
 * The terminal result/error handler latches the finished run's id (App.tsx's
 * terminalRunsRef). After the kernel's ``run_finished`` boundary the run is
 * OVER. Any malformed/replayed straggler still carries the parent run id. The
 * terminal event has nulled the active-run id by then, so the cross-run
 * MISMATCH guard in App.tsx no longer filters them — and a stray `final`
 * (progress.ts maps it to "finalizing") resurrects an in-flight phase that no
 * terminal event will ever clear, stranding the spinner at "Finalizing answer…"
 * forever. This is the complement to that mismatch guard: drop ANY post-terminal
 * event for a finished run, whatever its type. run_start is exempt because it
 * re-opens a run (and un-latches its id). Events with no runId are exempt: lane
 * events always carry their parent run id, so a no-runId event is command-level
 * (an error, a bench tick) and legitimately not tied to a finished run. Pure so
 * it is testable without rendering the app, like the rest of this module.
 */
export function isPostTerminalStraggler(
  type: string,
  eventRunId: string,
  terminalRunIds: ReadonlySet<string>,
): boolean {
  return type !== "run_start" && eventRunId !== "" && terminalRunIds.has(eventRunId);
}

/**
 * Drop any run-scoped event that belongs to a different active run.
 *
 * Event-type allowlists are unsafe here: every new goal/workflow event would
 * need to be remembered or a delayed prior run could repopulate the current
 * right panel. Events without a run id remain session/command scoped.
 */
export function isCrossRunEvent(
  activeRunId: string | null,
  eventRunId: string,
): boolean {
  return activeRunId != null
    && activeRunId !== ""
    && eventRunId !== ""
    && eventRunId !== activeRunId;
}
