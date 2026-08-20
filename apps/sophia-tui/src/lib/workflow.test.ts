import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_WORKFLOW_STATE,
  activeWorkflowNodes,
  flattenWorkflow,
  isTerminalWorkflowState,
  latestWorkflowRunId,
  receiptNodeEvent,
  redactLog,
  teamLaneNodes,
  todoNodes,
  workflowReducer,
} from "./workflow.js";

test("workflow snapshot restores hierarchy and keyboard expansion", () => {
  let state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes: [
    { taskId: "w", name: "workflow", kind: "workflow", state: "running" },
    { taskId: "t", parentId: "w", name: "tool", kind: "tool", state: "succeeded", attempt: 2 },
  ] } });
  assert.equal(flattenWorkflow(state).length, 2);
  state = workflowReducer(state, { type: "toggle", id: "w" });
  assert.equal(flattenWorkflow(state).length, 1);
});

test("workflow log display redacts credentials", () => {
  assert.equal(redactLog("Bearer abc token=secret"), "Bearer [REDACTED] token=[REDACTED]");
});

test("older snapshots cannot overwrite newer live task events", () => {
  let state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "event", event: {
    taskId: "t", name: "task", kind: "tool", state: "succeeded", sequence: 4,
  } });
  state = workflowReducer(state, { type: "snapshot", snapshot: { nodes: [
    { taskId: "t", name: "task", kind: "tool", state: "running", sequence: 3 },
  ] } });
  assert.equal(state.nodes.t.state, "succeeded");
});

test("stale live events cannot regress a newer completed node", () => {
  let state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "event", event: {
    taskId: "lane", name: "lane", kind: "agent", state: "succeeded", sequence: 8,
  } });
  state = workflowReducer(state, { type: "event", event: {
    taskId: "lane", state: "running", sequence: 7,
  } });
  assert.equal(state.nodes.lane.state, "succeeded");
  assert.equal(state.nodes.lane.sequence, 8);
});

test("active workflow includes cancelling and blocked but excludes terminal nodes", () => {
  const state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes: [
    { taskId: "a", name: "a", kind: "tool", state: "cancelling" },
    { taskId: "b", name: "b", kind: "tool", state: "blocked" },
    { taskId: "c", name: "c", kind: "tool", state: "cancelled" },
  ] } });
  assert.deepEqual(activeWorkflowNodes(state).map((node) => node.taskId), ["a", "b"]);
});

// Regression for the reported bug: "Active work: workflow [running] · workflow
// [running] · workflow [running] …" repeated on a NEW prompt. Each entry is a
// root "workflow" node left behind by an earlier run in the same TUI session
// that never reached a terminal state client-side (its terminal event is
// unconditionally dropped by App.tsx's cross-run guard once a newer run is
// live — see App.tsx onEvent's activeRunId check). "event" dispatches alone
// never signal that a run was abandoned, so without run_start being wired up
// (see App.tsx's t === "run_start" handler) they pile up as "active" forever.
test("without run_start wired up, stale running nodes from earlier runs pile up as active work", () => {
  let state = EMPTY_WORKFLOW_STATE;
  for (const runId of ["run-1", "run-2", "run-3"]) {
    state = workflowReducer(state, { type: "event", event: {
      taskId: `w-${runId}`, runId, name: "workflow", kind: "workflow", state: "running",
    } });
  }
  // A brand new prompt starts run-4; nothing has reset the earlier three.
  assert.deepEqual(
    activeWorkflowNodes(state).map((n) => n.taskId).sort(),
    ["w-run-1", "w-run-2", "w-run-3"],
    "this is the bug: three unrelated past runs still render as active work",
  );
});

test("run_start scopes activeWorkflowNodes to the new run without deleting history", () => {
  let state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "event", event: {
    taskId: "w1", runId: "run-1", name: "workflow", kind: "workflow", state: "running",
  } });
  state = workflowReducer(state, { type: "run_start", runId: "run-2" });
  // History is retained (e.g. for /tasks · /workflows), not deleted.
  assert.equal(state.nodes.w1.state, "running");
  // ...but it no longer counts as active work for the new prompt.
  assert.deepEqual(activeWorkflowNodes(state), []);
  // A node that streams in for the new run does count.
  state = workflowReducer(state, { type: "event", event: {
    taskId: "w2", runId: "run-2", name: "workflow", kind: "workflow", state: "running",
  } });
  assert.deepEqual(activeWorkflowNodes(state).map((n) => n.taskId), ["w2"]);
});

test("run_start hides every earlier run's stale active nodes, not just the immediately previous one", () => {
  let state = EMPTY_WORKFLOW_STATE;
  for (const runId of ["run-1", "run-2", "run-3"]) {
    state = workflowReducer(state, { type: "event", event: {
      taskId: `w-${runId}`, runId, name: "workflow", kind: "workflow", state: "running",
    } });
  }
  state = workflowReducer(state, { type: "run_start", runId: "run-4" });
  assert.deepEqual(activeWorkflowNodes(state), []);
  assert.equal(Object.keys(state.nodes).length, 3, "old nodes stay in history");
});

test("run_start with an empty/missing runId is a no-op (never blanks the active scope)", () => {
  let state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "event", event: {
    taskId: "w1", runId: "run-1", name: "workflow", kind: "workflow", state: "running",
  } });
  const before = state;
  state = workflowReducer(state, { type: "run_start", runId: "" });
  assert.equal(state, before);
});

test("a resumed snapshot before any run_start in this session is not scoped away", () => {
  // Startup/reconnect hydration (App.tsx's bridge.listTasks on ready) can
  // legitimately restore a task that is still running server-side, before
  // this client session has ever seen its own run_start. With no active-run
  // scope yet, that genuinely-active node must still surface.
  const state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes: [
    { taskId: "w1", runId: "run-old", name: "workflow", kind: "workflow", state: "running" },
  ] } });
  assert.deepEqual(activeWorkflowNodes(state).map((n) => n.taskId), ["w1"]);
});

test("a resumed snapshot scopes the right panel to the newest workflow run", () => {
  // A retained session can contain many finished runs. Root creation time, not
  // a late receipt from an older lane, chooses the run to render in the side
  // panel after /resume.
  const state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes: [
    { taskId: "old-root", runId: "run-old", name: "workflow", kind: "workflow", state: "succeeded", createdAt: "2026-08-10T08:00:00.000Z", sequence: 1 },
    { taskId: "old-lane", runId: "run-old", parentId: "old-root", name: "reviewer", kind: "agent", state: "succeeded", finishedAt: "2026-08-10T10:00:00.000Z", sequence: 40 },
    { taskId: "new-root", runId: "run-new", name: "workflow", kind: "workflow", state: "interrupted", createdAt: "2026-08-10T09:00:00.000Z", sequence: 2 },
    { taskId: "new-lane", runId: "run-new", parentId: "new-root", name: "tester", kind: "agent", state: "interrupted", sequence: 3 },
  ] } });
  assert.equal(state.activeRunId, "run-new");
  assert.equal(latestWorkflowRunId(Object.values(state.nodes)), "run-new");
  assert.deepEqual(teamLaneNodes(state).map((node) => node.taskId), ["new-lane"]);
});

test("clear resets the run scope along with all nodes", () => {
  let state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "run_start", runId: "run-1" });
  state = workflowReducer(state, { type: "clear" });
  assert.equal(state.activeRunId, null);
});

test("activeWorkflowNodes fails closed: unrecognized states (including the terminal 'interrupted') are never active", () => {
  const state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes: [
    { taskId: "a", name: "a", kind: "tool", state: "interrupted" },
    { taskId: "b", name: "b", kind: "tool", state: "some-brand-new-state-the-client-has-never-seen" },
  ] } });
  assert.deepEqual(activeWorkflowNodes(state), []);
});

// Renders the literal "Active work: …" banner exactly as App.tsx:1649 does
// (`activeWorkflowNodes(workflow).map((n) => \`${n.title || n.name} [${n.state}]\`).join(" · ")`),
// to pin down the reported symptom text end-to-end: three abandoned runs each
// contributing a "workflow [running]" segment, repeated verbatim in the
// screenshot ("Active work: workflow [running] · workflow [running] ·
// workflow [running]"), collapsing to nothing once run_start scopes them out.
function renderActiveWorkBanner(state: ReturnType<typeof workflowReducer>): string {
  return activeWorkflowNodes(state).map((n) => `${n.title || n.name} [${n.state}]`).join(" · ");
}

test("reproduces and resolves the exact reported banner text across three abandoned runs", () => {
  let state = EMPTY_WORKFLOW_STATE;
  for (const runId of ["run-1", "run-2", "run-3"]) {
    state = workflowReducer(state, { type: "event", event: {
      taskId: `w-${runId}`, runId, name: "workflow", kind: "workflow", state: "running",
    } });
  }
  assert.equal(
    renderActiveWorkBanner(state),
    "workflow [running] · workflow [running] · workflow [running]",
    "matches the user's reported banner before run_start is wired up",
  );
  state = workflowReducer(state, { type: "run_start", runId: "run-4" });
  assert.equal(renderActiveWorkBanner(state), "", "a new prompt shows only its own run's work");
});

test("a lifecycle receipt is not dropped just because its payload omits taskId", () => {
  // The bridge puts taskId in the ENVELOPE; only `task.<kind>.created` repeats
  // it in the payload. Requiring payload.taskId dropped every state transition,
  // so nodes were created QUEUED and never retired from "Active work".
  const started = receiptNodeEvent({
    type: "receipt", kind: "workflow.started", taskId: "t-1", payload: { state: "running" },
  });
  assert.deepEqual(started, { state: "running", taskId: "t-1" });

  const finished = receiptNodeEvent({
    type: "receipt", kind: "workflow.finished", taskId: "t-1",
    payload: { state: "succeeded", ok: true },
  });
  assert.deepEqual(finished, { state: "succeeded", ok: true, taskId: "t-1" });
});

test("a payload taskId still wins, and a receipt with neither is ignored", () => {
  assert.equal(
    receiptNodeEvent({ taskId: "envelope", payload: { taskId: "payload", state: "running" } })?.taskId,
    "payload",
  );
  assert.equal(receiptNodeEvent({ payload: { state: "running" } }), null);
  assert.equal(receiptNodeEvent({ taskId: "t-1" }), null);
});

test("todoNodes keeps coarse work units but drops per-tool-call noise", () => {
  const state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes: [
    { taskId: "w", name: "run", kind: "workflow", state: "running", sequence: 1 },
    { taskId: "a", parentId: "w", name: "agent lane", kind: "agent", state: "running", sequence: 2 },
    { taskId: "tc1", parentId: "a", name: "read_file", kind: "tool", state: "succeeded", sequence: 3 },
    { taskId: "tc2", parentId: "a", name: "grep", kind: "tool", state: "running", sequence: 4 },
    { taskId: "s", parentId: "w", name: "npm test", kind: "shell", state: "queued", sequence: 5 },
    { taskId: "v", parentId: "w", name: "lint", kind: "validation", state: "succeeded", sequence: 6 },
  ] } });
  // The "tool" nodes AND the "agent" lane are excluded (lanes live in the
  // panel's Team section via teamLaneNodes); workflow/shell/validation remain,
  // in creation (sequence) order.
  assert.deepEqual(todoNodes(state).map((n) => n.taskId), ["w", "s", "v"]);
  // The lane the to-do list dropped is exactly what teamLaneNodes returns.
  assert.deepEqual(teamLaneNodes(state).map((n) => n.taskId), ["a"]);
});

test("todoNodes keeps terminal nodes (the panel crosses them out, not hides them)", () => {
  const state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes: [
    { taskId: "b", name: "running", kind: "shell", state: "running", sequence: 2 },
    { taskId: "c", name: "failed", kind: "validation", state: "failed", sequence: 3 },
  ] } });
  // Unlike activeWorkflowNodes (live subset), the to-do list accumulates ALL of
  // them so completed/failed work stays visible and can be struck through.
  assert.deepEqual(todoNodes(state).map((n) => n.taskId), ["b", "c"]);
});

test("awaiting-input receipt detail renders a failed run as blocked/resumable", () => {
  let state = workflowReducer(EMPTY_WORKFLOW_STATE, {
    type: "snapshot",
    snapshot: {
      nodes: [{
        taskId: "w",
        name: "workflow",
        kind: "workflow",
        state: "failed",
        detail: { awaitingInput: true, incompleteReason: "awaiting_user_input" },
      }],
    },
  });
  assert.equal(state.nodes.w.state, "blocked");
  assert.equal(state.nodes.w.blockedReason, "awaiting user input");
  assert.equal(isTerminalWorkflowState(state.nodes.w.state), false);

  state = workflowReducer(state, {
    type: "event",
    event: {
      taskId: "w",
      state: "failed",
      awaitingInput: true,
      incompleteReason: "awaiting_user_input",
    } as never,
  });
  assert.equal(state.nodes.w.state, "blocked");
});

test("teamLaneNodes returns this run's agent lanes in order, capped", () => {
  const nodes = [];
  for (let i = 0; i < 10; i++) nodes.push({ taskId: `lane-${i}`, runId: "run-2", name: `worker ${i}`, kind: "agent" as const, state: "running", sequence: i });
  nodes.push({ taskId: "old-lane", runId: "run-1", name: "stale", kind: "agent" as const, state: "running", sequence: 0 });
  nodes.push({ taskId: "shell-1", runId: "run-2", name: "npm test", kind: "shell" as const, state: "running", sequence: 99 });
  let state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes } });
  state = workflowReducer(state, { type: "run_start", runId: "run-2" });
  const lanes = teamLaneNodes(state); // default limit 8
  assert.equal(lanes.length, 8, "capped so a big team cannot overflow the panel");
  assert.ok(lanes.every((n) => n.kind === "agent" && n.runId === "run-2"), "only this run's agent lanes");
  assert.deepEqual(lanes.map((n) => n.taskId), ["lane-2", "lane-3", "lane-4", "lane-5", "lane-6", "lane-7", "lane-8", "lane-9"], "keeps the most recent lanes");
});

test("teamLaneNodes is empty for a solo run (panel hides the Team section)", () => {
  const state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes: [
    { taskId: "w", name: "run", kind: "workflow", state: "running", sequence: 1 },
    { taskId: "s", parentId: "w", name: "npm test", kind: "shell", state: "running", sequence: 2 },
  ] } });
  assert.deepEqual(teamLaneNodes(state), []);
});

test("todoNodes scopes to the active run and caps length", () => {
  const nodes = [];
  for (let i = 0; i < 25; i++) nodes.push({ taskId: `cur-${i}`, runId: "run-2", name: `t${i}`, kind: "shell" as const, state: "running", sequence: i });
  for (let i = 0; i < 5; i++) nodes.push({ taskId: `old-${i}`, runId: "run-1", name: `o${i}`, kind: "shell" as const, state: "running", sequence: i });
  let state = workflowReducer(EMPTY_WORKFLOW_STATE, { type: "snapshot", snapshot: { nodes } });
  state = workflowReducer(state, { type: "run_start", runId: "run-2" });
  const todos = todoNodes(state); // default limit 20
  assert.equal(todos.length, 20, "capped so a long run cannot overflow the fixed-height panel");
  assert.ok(todos.every((n) => n.runId === "run-2"), "scoped to the active run");
  assert.deepEqual(todos.map((n) => n.taskId), ["cur-5", "cur-6", "cur-7", "cur-8", "cur-9", "cur-10", "cur-11", "cur-12", "cur-13", "cur-14", "cur-15", "cur-16", "cur-17", "cur-18", "cur-19", "cur-20", "cur-21", "cur-22", "cur-23", "cur-24"], "keeps the MOST RECENT entries when capping");
});

test("isTerminalWorkflowState is a fail-closed whitelist", () => {
  for (const s of ["succeeded", "failed", "cancelled", "interrupted"]) assert.equal(isTerminalWorkflowState(s), true, s);
  for (const s of ["running", "queued", "blocked", "cancelling", "some-future-state"]) assert.equal(isTerminalWorkflowState(s), false, s);
});
