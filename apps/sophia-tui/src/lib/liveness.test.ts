import test from "node:test";
import assert from "node:assert/strict";
import {
  backpressureEffect,
  isCrossRunEvent,
  isPostTerminalStraggler,
  livenessCoalesceKey,
  restartStageEffect,
  runTimeoutEffect,
  shouldGiveUpStall,
  shouldTerminateOwnedChild,
  shouldTimeoutRun,
  stallEffect,
  stallTimeoutEffect,
} from "./liveness.js";

test("the first stall earns a transcript row, and names what to do about it", () => {
  const first = stallEffect(true, 45_000, false);
  assert.ok(first.row, "a wedged kernel must not be status-line-only; that is missable");
  assert.equal(first.row?.meta, "stalled");
  assert.equal(first.row?.ok, false);
  assert.match(first.row!.text, /45s/);
  // A warning with no remedy is one people learn to ignore.
  assert.match(first.row!.text, /Ctrl\+C|Esc/);
  assert.equal(first.status, "kernel stalled — no output");
});

test("a persisting stall repeats the status but NOT the row", () => {
  // The detector re-fires every poll while the kernel is silent. Without the
  // edge guard a 10-minute wedge papers the transcript with the same sentence.
  const again = stallEffect(true, 90_000, true);
  assert.equal(again.row, null, "a stall row must be an edge event, not a heartbeat");
  assert.equal(again.status, "kernel stalled — no output");
});

test("recovery clears the warning without adding noise", () => {
  const recovered = stallEffect(false, 0, true);
  assert.equal(recovered.row, null);
  assert.equal(recovered.status, "kernel responding again");

  // Never stalled in the first place: say nothing at all. Otherwise every
  // healthy poll would overwrite whatever the status line was actually showing.
  const neverStalled = stallEffect(false, 0, false);
  assert.equal(neverStalled.row, null);
  assert.equal(neverStalled.status, "");
});

test("a nonsense duration degrades to 0s rather than NaN", () => {
  assert.match(stallEffect(true, Number.NaN, false).row!.text, /for 0s/);
  assert.match(stallEffect(true, -5, false).row!.text, /for 0s/);
});

test("backpressure stays on the quiet channel", () => {
  // Routine and usually momentary. A transcript row here would train the
  // operator to ignore transcript rows.
  const active = backpressureEffect(true, 12);
  assert.equal(active.row, null);
  assert.match(active.status, /queued \(12\)/);

  assert.equal(backpressureEffect(false, 0).status, "input flowing");
  // A negative/NaN queue depth must not render as "queued (NaN)".
  assert.match(backpressureEffect(true, Number.NaN).status, /queued \(0\)/);
});

test("restart stages are actionable and only escalate after the grace budget", () => {
  assert.match(restartStageEffect("cancelling").status, /cancelling active run/);
  assert.match(restartStageEffect("terminating").status, /owned child/);
  assert.equal(restartStageEffect("ready").row, null);
  assert.equal(restartStageEffect("failed", "did not exit").row?.ok, false);
  assert.equal(shouldTerminateOwnedChild(false, 10_000, 1_000), false);
  assert.equal(shouldTerminateOwnedChild(true, 999, 1_000), false);
  assert.equal(shouldTerminateOwnedChild(true, 1_000, 1_000), true);
  assert.equal(shouldTerminateOwnedChild(true, Number.NaN, 1_000), false);
  assert.equal(livenessCoalesceKey("stall", "run-1"), "liveness:run-1:stall");
});

test("give-up needs an actual stall AND the full silence budget", () => {
  // Not stalled → never give up, however long the silence: the give-up is an
  // ESCALATION of a stall, not an independent timer.
  assert.equal(shouldGiveUpStall(false, 999_999, 120_000), false);
  // Stalled but not yet long enough → keep waiting (a slow kernel is not a
  // wedged one).
  assert.equal(shouldGiveUpStall(true, 119_999, 120_000), false);
  // Stalled AND past the threshold → cancel.
  assert.equal(shouldGiveUpStall(true, 120_000, 120_000), true);
  assert.equal(shouldGiveUpStall(true, 120_001, 120_000), true);
});

test("give-up <= 0 disables auto-cancel entirely (the pre-existing behaviour)", () => {
  // 0 is the documented opt-out: the operator cancels by hand. A negative or
  // NaN budget must disable too, never fire on a nonsense value.
  assert.equal(shouldGiveUpStall(true, 999_999, 0), false);
  assert.equal(shouldGiveUpStall(true, 999_999, -1), false);
  // A NaN silence duration (should not happen, but degrade safe) never fires.
  assert.equal(shouldGiveUpStall(true, Number.NaN, 120_000), false);
});

test("overtime needs an in-flight run AND the full budget, and is opt-in", () => {
  // No run in flight → nothing to time out.
  assert.equal(shouldTimeoutRun(false, 999_999, 60_000), false);
  // In flight but under budget → keep going.
  assert.equal(shouldTimeoutRun(true, 59_999, 60_000), false);
  // In flight and over budget → cancel.
  assert.equal(shouldTimeoutRun(true, 60_000, 60_000), true);
  // timeoutMs <= 0 DISABLES (the default): a hard cap would otherwise kill
  // legitimate long autonomous goals, so it must be strictly opt-in.
  assert.equal(shouldTimeoutRun(true, 999_999, 0), false);
  assert.equal(shouldTimeoutRun(true, 999_999, -1), false);
  assert.equal(shouldTimeoutRun(true, Number.NaN, 60_000), false);
});

test("the stall auto-cancel announcement names the cause, the kept output, and the retry", () => {
  const effect = stallTimeoutEffect(120_000);
  assert.ok(effect.row, "an auto-cancel is a state change the operator must not miss");
  assert.equal(effect.row?.ok, false);
  assert.match(effect.row!.text, /120s/);
  assert.match(effect.row!.text, /auto-cancelled/);
  // The cancel-persist path (#1735) kept the partial conversation — say so, so
  // this reads as a handled failure rather than lost work.
  assert.match(effect.row!.text, /Partial output was kept/);
  assert.match(effect.row!.text, /resend/i);
  assert.match(effect.status, /auto-cancelled/);
});

test("the overtime announcement points at the exact knob that controls it", () => {
  const effect = runTimeoutEffect(300_000, 300_000);
  assert.ok(effect.row);
  assert.equal(effect.row?.meta, "timeout");
  assert.match(effect.row!.text, /300s time budget/);
  assert.match(effect.row!.text, /SOPHIA_RUN_TIMEOUT_MS/);
});

test("auto-cancel announcements degrade nonsense durations to 0, never NaN", () => {
  assert.match(stallTimeoutEffect(Number.NaN).row!.text, /for 0s/);
  assert.match(runTimeoutEffect(Number.NaN, Number.NaN).row!.text, /0s time budget after 0s/);
});

test("a finished run's late events are dropped — the stuck-at-Finalizing fix", () => {
  // The regression this exists to prevent: a team run delivers its answer
  // (terminal result latches the run id, nulls the active run), then an
  // abandoned lane's `delegate` sub-loop reaches its iteration ceiling and
  // emits a late `final`. progress.ts maps `final` → "finalizing", and with no
  // active run the cross-run mismatch guard no longer filters it — so the
  // spinner is stranded at "Finalizing answer…" forever. Every post-terminal
  // event for that finished run must be dropped, whatever its type.
  const finished = new Set(["run-b9d5f53b"]);
  assert.equal(isPostTerminalStraggler("final", "run-b9d5f53b", finished), true);
  // Not just `final` — any straggler type from the finished run is stale.
  assert.equal(isPostTerminalStraggler("thinking", "run-b9d5f53b", finished), true);
  assert.equal(isPostTerminalStraggler("token", "run-b9d5f53b", finished), true);
  assert.equal(isPostTerminalStraggler("tool_call", "run-b9d5f53b", finished), true);
  // A duplicate terminal result is a straggler too (the dedupe guard agrees).
  assert.equal(isPostTerminalStraggler("result", "run-b9d5f53b", finished), true);
});

test("post-terminal drop exempts run_start, no-runId events, and live runs", () => {
  const finished = new Set(["run-b9d5f53b"]);
  // run_start re-opens a run (and un-latches its id), so it must never be
  // dropped here even if the id was seen before — ids are unique per run, but
  // the exemption keeps the guard from ever blocking a fresh start.
  assert.equal(isPostTerminalStraggler("run_start", "run-b9d5f53b", finished), false);
  // No runId → command-level (an error, a bench tick), not tied to a finished
  // run; lane events always carry their parent run id, so this is safe.
  assert.equal(isPostTerminalStraggler("final", "", finished), false);
  assert.equal(isPostTerminalStraggler("error", "", finished), false);
  // A run still in flight has not latched its id yet — its events flow normally.
  assert.equal(isPostTerminalStraggler("final", "run-live", finished), false);
  // An unrelated run id (e.g. a different session's event) is not our concern.
  assert.equal(isPostTerminalStraggler("final", "run-other", finished), false);
  // Empty terminal set (no run has finished yet) drops nothing.
  assert.equal(isPostTerminalStraggler("final", "run-b9d5f53b", new Set()), false);
});

test("cross-run isolation rejects every mismatched run-scoped event", () => {
  assert.equal(isCrossRunEvent("run-b", "run-a"), true);
  assert.equal(isCrossRunEvent("run-b", "run-b"), false);
  assert.equal(isCrossRunEvent("run-b", ""), false);
  assert.equal(isCrossRunEvent("", "run-a"), false);
});
