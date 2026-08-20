import test from "node:test";
import assert from "node:assert/strict";
import {
  compoundWorkflowOutputAuthorized,
  EMPTY_SESSION_FLOW_STATE,
  recentSessionFlowNodes,
  sessionFlowReducer,
  sessionFlowRunCount,
  sessionFlowToDrawioXml,
  type SessionFlowState,
} from "./sessionFlow.js";
import type { BridgeEvent } from "./bridge.js";

function fold(events: BridgeEvent[]): SessionFlowState {
  return events.reduce(
    (state, event) => sessionFlowReducer(state, { type: "event", event }),
    EMPTY_SESSION_FLOW_STATE,
  );
}

const PLAN_DIGEST = "f".repeat(64);
const OUTPUT_DIGEST = "a".repeat(64);

interface TestProcessPlan {
  processId: string;
  processLabel: string;
  branchId: string;
  childWorkflowIds: string[];
  dependsOnNodeIds: string[];
}

interface TestJoinPlan {
  joinId: string;
  expectedNodeIds: string[];
}

function frozenPlan(
  runId: string,
  processes: TestProcessPlan[],
  joins: TestJoinPlan[],
  outputProcessId: string,
  eventId = `${runId}:plan`,
): BridgeEvent {
  return {
    type: "workflow_plan_frozen",
    eventId,
    runId,
    workflowEventVersion: 1,
    workflowEventSequence: 0,
    schema: "sophia.compound-workflow-plan.v1",
    planDigest: PLAN_DIGEST,
    outputProcessId,
    processes,
    joins,
  };
}

test("projects accepted harness, A2A, tool, and result events into one session graph", () => {
  const state = fold([
    { type: "run_start", runId: "run-1", goal: "Inspect the repository" },
    { type: "harness_context", runId: "run-1", harnessName: "a2a" },
    { type: "a2a_chain_start", runId: "run-1" },
    {
      type: "a2a_agent_start",
      runId: "run-1",
      agentName: "repo-reviewer",
      lane: "lane-1",
    },
    {
      type: "tool_call",
      runId: "run-1",
      lane: "lane-1",
      tool: "read_file",
      callId: "call-1",
    },
    {
      type: "tool_result",
      runId: "run-1",
      lane: "lane-1",
      tool: "read_file",
      callId: "call-1",
      ok: true,
    },
    { type: "result", runId: "run-1", ok: true },
    { type: "run_finished", runId: "run-1", ok: true },
  ]);

  assert.equal(sessionFlowRunCount(state), 1);
  assert.equal(state.nodes.length, 8);
  assert.equal(state.eventCount, 8);
  assert.equal(state.activeRunId, "");
  assert.equal(state.nodes[0]?.kind, "run");
  assert.equal(state.nodes[1]?.kind, "harness");
  assert.equal(state.nodes[2]?.label, "A2A chain");
  assert.equal(state.nodes[3]?.parentId, state.nodes[2]?.id);
  assert.equal(state.nodes[4]?.label, "Tool · read_file");
  assert.equal(state.nodes[4]?.parentId, state.nodes[3]?.id);
  assert.equal(state.nodes[5]?.status, "succeeded");
  assert.ok(state.edges.some((edge) => edge.kind === "contains"));
  assert.ok(state.edges.some((edge) => edge.kind === "sequence"));
  assert.deepEqual(
    recentSessionFlowNodes(state, 2).map((node) => node.eventType),
    ["result", "run_finished"],
  );
});

test("coalesces token noise by omission and never retains hidden reasoning or raw tool payloads", () => {
  const state = fold([
    { type: "run_start", runId: "run-secret" },
    {
      type: "thinking",
      runId: "run-secret",
      text: "private chain of thought",
      reason: "private chain of thought",
    },
    { type: "thinking_token", runId: "run-secret", text: "private token" },
    {
      type: "tool_call",
      runId: "run-secret",
      tool: "shell",
      args: { apiKey: "sk-top-secret-value", command: "dangerous private input" },
    },
    {
      type: "tool_result",
      runId: "run-secret",
      tool: "shell",
      ok: false,
      output: "private command output",
      error: "authorization=sk-another-secret-value",
    },
  ]);

  const serialized = JSON.stringify(state);
  assert.equal(state.nodes.length, 4);
  assert.doesNotMatch(serialized, /private chain of thought/);
  assert.doesNotMatch(serialized, /private token/);
  assert.doesNotMatch(serialized, /dangerous private input/);
  assert.doesNotMatch(serialized, /private command output/);
  assert.doesNotMatch(serialized, /sk-(?:top|another)-secret-value/);
  assert.match(serialized, /\[REDACTED\]/);
});

test("retains safe provider progress while excluding provider tool payloads", () => {
  const state = fold([
    { type: "run_start", runId: "run-provider" },
    {
      type: "provider_progress",
      runId: "run-provider",
      provider: "grok",
      model: "grok-4.6",
      phase: "provider_tool",
      status: "in_progress",
      tool: "read_file",
      toolCallId: "call-1",
      detail: "read_file · delegated-provider tool",
      rawInput: { path: "/private/secret.txt" },
      rawOutput: "secret contents",
    },
  ]);

  const providerNode = state.nodes.find(
    (node) => node.eventType === "provider_progress",
  );
  assert.equal(providerNode?.kind, "model");
  assert.match(providerNode?.label || "", /Provider · grok:grok-4\.6/);
  assert.match(providerNode?.detail || "", /provider tool read_file/);
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /private\/secret/);
  assert.doesNotMatch(serialized, /secret contents/);
});

test("labels provider and model failures explicitly instead of generic progress", () => {
  const state = fold([
    { type: "run_start", runId: "run-timeout" },
    {
      type: "provider_progress",
      runId: "run-timeout",
      provider: "grok",
      model: "grok-4.6",
      status: "failed",
      error: "grok CLI timed out after 300s",
    },
    {
      type: "model_result",
      runId: "run-timeout",
      provider: "grok",
      model: "grok-4.6",
      ok: false,
      error: "grok CLI timed out after 300s",
    },
  ]);
  const provider = state.nodes.find(
    (node) => node.eventType === "provider_progress",
  );
  const model = state.nodes.find(
    (node) => node.eventType === "model_result",
  );
  assert.equal(provider?.label, "Provider failed · grok:grok-4.6");
  assert.equal(provider?.status, "failed");
  assert.match(provider?.detail || "", /grok CLI timed out after 300s/);
  assert.equal(model?.label, "Model failed · grok-4.6");
  assert.equal(model?.status, "failed");
  assert.match(model?.detail || "", /grok CLI timed out after 300s/);
});

test("exports editable uncompressed Draw.io mxGraphModel XML with escaped labels and linked cells", () => {
  const state = fold([
    { type: "run_start", runId: "run-xml", goal: "A & B < C" },
    { type: "agi_mode_start", runId: "run-xml", phase: "plan" },
    { type: "agi_phase_end", runId: "run-xml", phase: "plan", ok: true },
  ]);
  const xml = sessionFlowToDrawioXml(state, {
    title: 'Flow "audit"',
    generatedAt: "2026-08-13T12:00:00.000Z",
  });

  assert.match(xml, /^<\?xml version="1\.0"/);
  assert.match(xml, /<mxfile host="app\.diagrams\.net"/);
  assert.match(xml, /<mxGraphModel /);
  assert.match(xml, /vertex="1"/);
  assert.match(xml, /edge="1"/);
  assert.match(xml, /source="n\d+" target="n\d+"/);
  assert.match(xml, /A &amp; B &lt; C/);
  assert.match(xml, /Flow &quot;audit&quot;/);
  assert.doesNotMatch(xml, /canClaimAGI="true"/);
});

test("Draw.io export preserves terminal node geometry and routed edge styles", () => {
  const state = fold([
    { type: "run_start", runId: "run-layout" },
    { type: "tool_call", runId: "run-layout", tool: "read_file" },
    {
      type: "tool_result",
      runId: "run-layout",
      tool: "read_file",
      ok: true,
    },
  ]);
  const routedEdge = state.edges.find((edge) => edge.kind === "sequence");
  assert.ok(routedEdge);

  const xml = sessionFlowToDrawioXml(state, {
    generatedAt: "2026-08-14T08:00:00.000Z",
    nodeGeometry: [
      { id: state.nodes[0]!.id, x: 12, y: 24, width: 180, height: 64 },
      { id: state.nodes[1]!.id, x: 320, y: 24, width: 220, height: 72 },
      { id: state.nodes[2]!.id, x: 620, y: 140, width: 200, height: 60 },
    ],
    edgeRoutes: {
      [routedEdge.id]: {
        waypoints: [
          { x: 210, y: 56 },
          { x: 270, y: 56 },
          { x: 270, y: 60 },
        ],
        style: {
          startArrow: "oval",
          endArrow: "block",
          planned: true,
          statusColor: "#b85450",
          strokeWidth: 3,
        },
      },
    },
  });

  assert.match(
    xml,
    /<mxGeometry x="12" y="24" width="180" height="64" as="geometry"\/>/,
  );
  assert.match(
    xml,
    /<mxGeometry x="320" y="24" width="220" height="72" as="geometry"\/>/,
  );
  assert.match(xml, /edgeStyle=orthogonalEdgeStyle/);
  assert.match(xml, /startArrow=oval/);
  assert.match(xml, /endArrow=block/);
  assert.match(xml, /dashed=1/);
  assert.match(xml, /strokeColor=#b85450/);
  assert.match(xml, /strokeWidth=3/);
  assert.match(
    xml,
    /<Array as="points"><mxPoint x="210" y="56"\/><mxPoint x="270" y="56"\/><mxPoint x="270" y="60"\/><\/Array>/,
  );
  assert.match(xml, /candidateOnly="true"/);
  assert.match(xml, /canClaimAGI="false"/);
});

test("Draw.io defaults make containment arrowless and every relation non-gray", () => {
  const state = fold([
    { type: "run_start", runId: "run-semantic-drawio" },
    {
      type: "a2a_chain_start",
      runId: "run-semantic-drawio",
      chainId: "chain-1",
    },
    {
      type: "a2a_agent_start",
      runId: "run-semantic-drawio",
      chainId: "chain-1",
      agent: "reviewer",
      index: 0,
    },
  ]);
  const xml = sessionFlowToDrawioXml(state, {
    generatedAt: "2026-08-14T12:00:00.000Z",
  });

  assert.match(
    xml,
    /value="contains" style="[^"]*endArrow=none[^"]*strokeColor=#00838f[^"]*dashPattern=1 4/,
  );
  assert.match(xml, /strokeColor=#0288d1|strokeColor=#d79b00/);
  assert.doesNotMatch(xml, /strokeColor=#666666/);
});

test("reset drops prior session flow state", () => {
  const populated = fold([{ type: "run_start", runId: "run-1" }]);
  const reset = sessionFlowReducer(populated, { type: "reset" });
  assert.deepEqual(reset, EMPTY_SESSION_FLOW_STATE);
});

test("startup diagnostics do not masquerade as a running prompt", () => {
  const state = fold([
    { type: "provider_health", status: "probing", ok: true },
    { type: "workflows", ok: true, nodes: [] },
    {
      type: "provider_health",
      status: "complete",
      ok: false,
      providers: [],
    },
  ]);

  assert.equal(sessionFlowRunCount(state), 0);
  assert.equal(state.activeRunId, "");
  assert.equal(state.nodes[0]?.eventType, "run_observed");
  assert.equal(state.nodes[0]?.label, "Session diagnostics");
  assert.equal(state.nodes[0]?.status, "info");
  assert.match(state.nodes[0]?.detail || "", /before any prompt run/);
});

test("AGI terminal receipts preserve candidate and unachievable claim ceilings", () => {
  const state = fold([
    { type: "run_start", runId: "run-agi" },
    {
      type: "agi_mode_end",
      runId: "run-agi",
      status: "candidate_complete",
    },
    {
      type: "agi_mode_end",
      runId: "run-agi",
      status: "unachievable",
    },
  ]);

  assert.equal(state.nodes[1]?.status, "blocked");
  assert.equal(state.nodes[2]?.status, "failed");
  assert.equal(state.canClaimAGI, false);
  assert.equal(state.candidateOnly, true);
});

test("replayed protocol events with the same eventId do not duplicate a flow step", () => {
  const event: BridgeEvent = {
    type: "tool_call",
    eventId: "event-1",
    runId: "run-1",
    tool: "read_file",
  };
  const state = fold([event, event]);

  assert.equal(state.nodes.length, 2, "synthetic run root plus one tool step");
  assert.equal(state.eventCount, 1);
});

test("a zero-run compound replay summary cannot create a phantom session row", () => {
  const state = fold([
    {
      type: "compound_workflow_status",
      eventId: "replay-summary",
      durableRunCount: 0,
    },
  ]);

  assert.deepEqual(state.nodes, []);
  assert.deepEqual(state.edges, []);
  assert.equal(state.eventCount, 0);
  assert.equal(state.activeRunId, "");
});

test("projects versioned compound processes and all-of joins onto stable semantic node ids", () => {
  const processes: TestProcessPlan[] = [
    {
      processId: "p1",
      processLabel: "Evidence pair",
      branchId: "left",
      childWorkflowIds: ["collect", "verify"],
      dependsOnNodeIds: [],
    },
    {
      processId: "p2",
      processLabel: "Independent review",
      branchId: "right",
      childWorkflowIds: ["review"],
      dependsOnNodeIds: [],
    },
    {
      processId: "terminal",
      processLabel: "Synthesis",
      branchId: "main",
      childWorkflowIds: ["synthesize"],
      dependsOnNodeIds: ["join-1"],
    },
  ];
  const events: BridgeEvent[] = [
    { type: "run_start", eventId: "run", runId: "compound-run" },
    frozenPlan(
      "compound-run",
      processes,
      [{ joinId: "join-1", expectedNodeIds: ["p1", "p2"] }],
      "terminal",
    ),
    {
      type: "workflow_process_start",
      eventId: "p1-start",
      runId: "compound-run",
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      processId: "p1",
      processLabel: "Evidence pair",
      branchId: "left",
      childWorkflowIds: ["collect", "verify"],
      dependsOnNodeIds: [],
      workflowId: "collect",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_process_progress",
      eventId: "p1-progress",
      runId: "compound-run",
      workflowEventVersion: 1,
      workflowEventSequence: 2,
      processId: "p1",
      processLabel: "Evidence pair",
      branchId: "left",
      childWorkflowIds: ["collect", "verify"],
      dependsOnNodeIds: [],
      completedChildWorkflowIds: ["collect"],
    },
    {
      type: "workflow_process_end",
      eventId: "p1-end",
      runId: "compound-run",
      workflowEventVersion: 1,
      workflowEventSequence: 3,
      processId: "p1",
      processLabel: "Evidence pair",
      branchId: "left",
      childWorkflowIds: ["collect", "verify"],
      dependsOnNodeIds: [],
      state: "succeeded",
    },
    {
      type: "workflow_join_wait",
      eventId: "join-wait",
      runId: "compound-run",
      workflowEventVersion: 1,
      workflowEventSequence: 4,
      joinId: "join-1",
      expectedNodeIds: ["p1", "p2"],
      completedNodeIds: ["p1"],
      state: "pending",
    },
    {
      type: "workflow_join_released",
      eventId: "join-release",
      runId: "compound-run",
      workflowEventVersion: 1,
      workflowEventSequence: 5,
      joinId: "join-1",
      expectedNodeIds: ["p1", "p2"],
      completedNodeIds: ["p1", "p2"],
    },
  ];
  const first = fold(events);
  const replayed = fold([...events, events.at(-1)!]);
  const members = first.nodes.filter(
    (node) => node.processMember && node.processId === "p1",
  );
  const process = first.nodes.find(
    (node) => node.processNode && node.processId === "p1",
  );
  const join = first.nodes.find((node) => node.joinId === "join-1");

  assert.equal(process?.id, "workflow-process:compound-run:p1");
  assert.equal(process?.processId, "p1");
  assert.equal(process?.status, "succeeded");
  assert.deepEqual(
    members.map((node) => node.identity?.workflowId),
    ["collect", "verify"],
  );
  assert.equal(new Set(members.map((node) => node.processId)).size, 1);
  assert.ok(members.every((node) => node.processLabel === "Evidence pair"));
  assert.ok(members.every((node) => node.branchId === "left"));
  assert.ok(members.every((node) => node.status === "succeeded"));
  assert.ok(members.every((node) => node.parentId === process?.id));
  assert.deepEqual(members[0]?.childWorkflowIds, ["collect", "verify"]);
  assert.deepEqual(members[0]?.dependsOnNodeIds, []);
  assert.equal(join?.status, "succeeded");
  assert.deepEqual(join?.expectedNodeIds, ["p1", "p2"]);
  assert.deepEqual(join?.completedNodeIds, ["p1", "p2"]);
  assert.ok(
    first.edges.some(
      (edge) => edge.source === process?.id && edge.target === join?.id,
    ),
    "join dependencies attach to the semantic process endpoint",
  );
  assert.deepEqual(
    replayed.nodes.map((node) => node.id),
    first.nodes.map((node) => node.id),
  );
  assert.equal(
    replayed.eventCount,
    first.eventCount,
    "a duplicate released receipt is ignored by eventId",
  );
});

test("an explicit pending all-of wait remains pending", () => {
  const processes: TestProcessPlan[] = [
    { processId: "left", processLabel: "Left", branchId: "left", childWorkflowIds: ["left-workflow"], dependsOnNodeIds: [] },
    { processId: "right", processLabel: "Right", branchId: "right", childWorkflowIds: ["right-workflow"], dependsOnNodeIds: [] },
    { processId: "terminal", processLabel: "Terminal", branchId: "main", childWorkflowIds: ["finish"], dependsOnNodeIds: ["join"] },
  ];
  const state = fold([
    { type: "run_start", eventId: "run", runId: "pending-join" },
    frozenPlan(
      "pending-join",
      processes,
      [{ joinId: "join", expectedNodeIds: ["left", "right"] }],
      "terminal",
    ),
    {
      type: "workflow_join_wait",
      eventId: "join-wait",
      runId: "pending-join",
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      joinId: "join",
      expectedNodeIds: ["left", "right"],
      completedNodeIds: [],
      state: "pending",
    },
  ]);

  assert.equal(
    state.nodes.find((node) => node.joinId === "join")?.status,
    "pending",
  );
});

test("workflow lifecycle sequence rejects stale process and join regressions", () => {
  const processes: TestProcessPlan[] = [
    { processId: "process", processLabel: "Current label", branchId: "main", childWorkflowIds: ["one", "two"], dependsOnNodeIds: [] },
    { processId: "peer", processLabel: "Peer", branchId: "peer", childWorkflowIds: ["peer-workflow"], dependsOnNodeIds: [] },
    { processId: "terminal", processLabel: "Terminal", branchId: "main", childWorkflowIds: ["finish"], dependsOnNodeIds: ["join"] },
  ];
  const state = fold([
    { type: "run_start", eventId: "run", runId: "sequenced" },
    frozenPlan(
      "sequenced",
      processes,
      [{ joinId: "join", expectedNodeIds: ["process", "peer"] }],
      "terminal",
    ),
    {
      type: "workflow_process_start",
      eventId: "process-start",
      runId: "sequenced",
      workflowEventVersion: 1,
      processId: "process",
      processLabel: "Current label",
      branchId: "main",
      childWorkflowIds: ["one", "two"],
      dependsOnNodeIds: [],
      workflowEventSequence: 10,
      workflowId: "one",
      attempt: 2,
      state: "running",
    },
    {
      type: "workflow_process_end",
      eventId: "process-end",
      runId: "sequenced",
      workflowEventVersion: 1,
      processId: "process",
      processLabel: "Current label",
      branchId: "main",
      childWorkflowIds: ["one", "two"],
      dependsOnNodeIds: [],
      state: "succeeded",
      workflowEventSequence: 12,
    },
    {
      type: "workflow_process_start",
      eventId: "late-process-start",
      runId: "sequenced",
      workflowEventVersion: 1,
      processId: "process",
      processLabel: "Current label",
      branchId: "main",
      childWorkflowIds: ["one", "two"],
      dependsOnNodeIds: [],
      workflowEventSequence: 11,
      workflowId: "one",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_join_wait",
      eventId: "join-wait",
      runId: "sequenced",
      workflowEventVersion: 1,
      joinId: "join",
      expectedNodeIds: ["process", "peer"],
      completedNodeIds: ["process"],
      state: "pending",
      workflowEventSequence: 20,
    },
    {
      type: "workflow_join_released",
      eventId: "join-release",
      runId: "sequenced",
      workflowEventVersion: 1,
      joinId: "join",
      expectedNodeIds: ["process", "peer"],
      completedNodeIds: ["process", "peer"],
      workflowEventSequence: 22,
    },
    {
      type: "workflow_join_wait",
      eventId: "late-join-wait",
      runId: "sequenced",
      workflowEventVersion: 1,
      joinId: "join",
      expectedNodeIds: ["process", "peer"],
      completedNodeIds: [],
      state: "pending",
      workflowEventSequence: 21,
    },
  ]);
  const process = state.nodes.find(
    (node) => node.processNode && node.processId === "process",
  );
  const members = state.nodes.filter(
    (node) => node.processMember && node.processId === "process",
  );
  const join = state.nodes.find((node) => node.joinId === "join");

  assert.equal(process?.status, "succeeded");
  assert.equal(process?.eventType, "workflow_process_end");
  assert.equal(process?.processLabel, "Current label");
  assert.equal(process?.workflowEventSequence, 12);
  assert.equal(process?.workflowAttempt, 2);
  assert.deepEqual(
    members.map((node) => [node.identity?.workflowId, node.status]),
    [["one", "succeeded"], ["two", "succeeded"]],
  );
  assert.ok(members.every((node) => node.workflowEventSequence === 12));
  assert.equal(join?.status, "succeeded");
  assert.equal(join?.eventType, "workflow_join_released");
  assert.equal(join?.workflowEventSequence, 22);
  assert.equal(state.seenEventIds["late-process-start"], true);
  assert.equal(state.seenEventIds["late-join-wait"], true);
});

test("materializes process and nested-join dependencies independent of receipt order", () => {
  const processes: TestProcessPlan[] = [
    { processId: "late-process", processLabel: "Late", branchId: "main", childWorkflowIds: ["late-workflow"], dependsOnNodeIds: [] },
    { processId: "peer", processLabel: "Peer", branchId: "peer", childWorkflowIds: ["peer-workflow"], dependsOnNodeIds: [] },
    { processId: "extra", processLabel: "Extra", branchId: "extra", childWorkflowIds: ["extra-workflow"], dependsOnNodeIds: [] },
    { processId: "dependent", processLabel: "Dependent", branchId: "main", childWorkflowIds: ["dependent-workflow"], dependsOnNodeIds: ["late-join"] },
  ];
  const joins: TestJoinPlan[] = [
    { joinId: "early-join", expectedNodeIds: ["late-process", "peer"] },
    { joinId: "nested-first", expectedNodeIds: ["early-join", "extra"] },
    { joinId: "nested-second", expectedNodeIds: ["nested-first", "peer"] },
    { joinId: "late-join", expectedNodeIds: ["nested-second", "late-process"] },
  ];
  const state = fold([
    { type: "run_start", eventId: "run", runId: "ordered" },
    {
      type: "workflow_join_wait",
      eventId: "early-join",
      runId: "ordered",
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      joinId: "early-join",
      expectedNodeIds: ["late-process", "peer"],
      completedNodeIds: [],
      state: "pending",
    },
    {
      type: "workflow_process_start",
      eventId: "dependent",
      runId: "ordered",
      workflowEventVersion: 1,
      workflowEventSequence: 2,
      processId: "dependent",
      processLabel: "Dependent",
      branchId: "main",
      childWorkflowIds: ["dependent-workflow"],
      dependsOnNodeIds: ["late-join"],
      workflowId: "dependent-workflow",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_join_wait",
      eventId: "nested-second",
      runId: "ordered",
      workflowEventVersion: 1,
      workflowEventSequence: 3,
      joinId: "nested-second",
      expectedNodeIds: ["nested-first", "peer"],
      completedNodeIds: [],
      state: "pending",
    },
    {
      type: "workflow_process_start",
      eventId: "late-process",
      runId: "ordered",
      workflowEventVersion: 1,
      workflowEventSequence: 4,
      processId: "late-process",
      processLabel: "Late",
      branchId: "main",
      childWorkflowIds: ["late-workflow"],
      dependsOnNodeIds: [],
      workflowId: "late-workflow",
      attempt: 1,
      state: "running",
    },
    {
      type: "workflow_join_wait",
      eventId: "late-join",
      runId: "ordered",
      workflowEventVersion: 1,
      workflowEventSequence: 5,
      joinId: "late-join",
      expectedNodeIds: ["nested-second", "late-process"],
      completedNodeIds: [],
      state: "pending",
    },
    {
      type: "workflow_join_wait",
      eventId: "nested-first",
      runId: "ordered",
      workflowEventVersion: 1,
      workflowEventSequence: 6,
      joinId: "nested-first",
      expectedNodeIds: ["early-join", "extra"],
      completedNodeIds: [],
      state: "pending",
    },
    frozenPlan("ordered", processes, joins, "dependent"),
  ]);
  const process = (processId: string) =>
    state.nodes.find(
      (node) => node.processNode === true && node.processId === processId,
    )!;
  const join = (joinId: string) =>
    state.nodes.find((node) => node.joinId === joinId)!;
  const semanticEdges = state.edges.filter((edge) => edge.kind === "sequence");
  const edgeCount = (source: string, target: string) =>
    semanticEdges.filter(
      (edge) => edge.source === source && edge.target === target,
    ).length;

  assert.equal(edgeCount(process("late-process").id, join("early-join").id), 1);
  assert.equal(edgeCount(process("late-process").id, join("late-join").id), 1);
  assert.equal(edgeCount(join("late-join").id, process("dependent").id), 1);
  assert.equal(edgeCount(join("nested-first").id, join("nested-second").id), 1);
  assert.ok(
    state.nodes
      .filter((node) => node.processMember)
      .every((member) => member.parentId === process(member.processId!).id),
  );
});

test("tracks completed serial children without marking later process members running", () => {
  const processPlan: TestProcessPlan = {
    processId: "process",
    processLabel: "Three steps",
    branchId: "main",
    childWorkflowIds: ["one", "two", "three"],
    dependsOnNodeIds: [],
  };
  const state = fold([
    { type: "run_start", eventId: "run", runId: "serial-members" },
    frozenPlan("serial-members", [processPlan], [], "process"),
    {
      type: "workflow_process_progress",
      eventId: "progress",
      runId: "serial-members",
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      processId: "process",
      processLabel: "Three steps",
      branchId: "main",
      childWorkflowIds: ["one", "two", "three"],
      dependsOnNodeIds: [],
      completedChildWorkflowIds: ["one"],
    },
  ]);
  const members = state.nodes.filter((node) => node.processMember);

  assert.deepEqual(
    members.map((node) => [node.identity?.workflowId, node.status]),
    [
      ["one", "succeeded"],
      ["two", "pending"],
      ["three", "pending"],
    ],
  );
  assert.ok(
    members.every((node) =>
      node.completedChildWorkflowIds?.join(",") === "one"),
  );
});

test("a late frozen plan preserves matching lifecycle completion and authorizes exactly once", () => {
  const runId = "late-header";
  const processes: TestProcessPlan[] = [
    { processId: "left", processLabel: "Left", branchId: "left", childWorkflowIds: ["left-workflow"], dependsOnNodeIds: [] },
    { processId: "right", processLabel: "Right", branchId: "right", childWorkflowIds: ["right-workflow"], dependsOnNodeIds: [] },
    { processId: "terminal", processLabel: "Terminal", branchId: "main", childWorkflowIds: ["finish"], dependsOnNodeIds: ["join"] },
  ];
  const joins = [{ joinId: "join", expectedNodeIds: ["left", "right"] }];
  const lifecycle: BridgeEvent[] = [
    { type: "run_start", eventId: "run", runId },
    { type: "workflow_process_end", eventId: "left-end", runId, workflowEventVersion: 1, workflowEventSequence: 1, processId: "left", processLabel: "Left", branchId: "left", childWorkflowIds: ["left-workflow"], dependsOnNodeIds: [], state: "succeeded" },
    { type: "workflow_process_end", eventId: "right-end", runId, workflowEventVersion: 1, workflowEventSequence: 2, processId: "right", processLabel: "Right", branchId: "right", childWorkflowIds: ["right-workflow"], dependsOnNodeIds: [], state: "succeeded" },
    { type: "workflow_join_released", eventId: "join-release", runId, workflowEventVersion: 1, workflowEventSequence: 3, joinId: "join", expectedNodeIds: ["left", "right"], completedNodeIds: ["left", "right"] },
    { type: "workflow_process_end", eventId: "terminal-end", runId, workflowEventVersion: 1, workflowEventSequence: 4, processId: "terminal", processLabel: "Terminal", branchId: "main", childWorkflowIds: ["finish"], dependsOnNodeIds: ["join"], state: "succeeded" },
    { type: "workflow_output_committed", eventId: "output", runId, workflowEventVersion: 1, workflowEventSequence: 5, processId: "terminal", artifactRef: "artifacts/final.json", digest: OUTPUT_DIGEST },
  ];
  const beforeHeader = fold(lifecycle);
  const header = frozenPlan(runId, processes, joins, "terminal");
  const completed = fold([...lifecycle, header]);
  const replayed = sessionFlowReducer(completed, { type: "event", event: header });

  assert.equal(compoundWorkflowOutputAuthorized(beforeHeader, runId), false);
  assert.equal(compoundWorkflowOutputAuthorized(completed, runId), true);
  assert.equal(completed.activeRunId, "");
  assert.equal(
    completed.nodes.some((node) => node.eventType === "workflow_plan_frozen"),
    false,
    "the header is topology metadata, not a generic graph node",
  );
  assert.ok(
    completed.nodes
      .filter((node) => node.runId === runId && (node.processNode || node.joinId))
      .every(
        (node) =>
          node.workflowPlanFrozen === true
          && node.outputProcessId === "terminal"
          && node.planDigest === PLAN_DIGEST,
      ),
  );
  assert.deepEqual(replayed.nodes, completed.nodes);
  assert.deepEqual(replayed.edges, completed.edges);
  assert.equal(replayed.eventCount, completed.eventCount);
});

test("an authoritative late header removes undeclared provisional compound nodes", () => {
  const runId = "late-mismatch";
  const state = fold([
    { type: "run_start", eventId: "run", runId },
    {
      type: "workflow_process_start",
      eventId: "phantom-start",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      processId: "phantom",
      processLabel: "Phantom",
      branchId: "wrong",
      childWorkflowIds: ["phantom-workflow"],
      dependsOnNodeIds: [],
      workflowId: "phantom-workflow",
      attempt: 1,
      state: "running",
    },
    frozenPlan(
      runId,
      [{ processId: "actual", processLabel: "Actual", branchId: "main", childWorkflowIds: ["actual-workflow"], dependsOnNodeIds: [] }],
      [],
      "actual",
    ),
  ]);

  assert.equal(state.nodes.some((node) => node.processId === "phantom"), false);
  assert.deepEqual(
    state.nodes
      .filter((node) => node.processNode)
      .map((node) => [node.processId, node.status]),
    [["actual", "pending"]],
  );
  assert.deepEqual(
    state.nodes
      .filter((node) => node.processMember)
      .map((node) => node.identity?.workflowId),
    ["actual-workflow"],
  );
});

test("v1 lifecycle validation rejects missing versions, future versions, bad receipts, and unknown plan ids", () => {
  const runId = "strict-v1";
  const header = frozenPlan(
    runId,
    [{ processId: "actual", processLabel: "Actual", branchId: "main", childWorkflowIds: ["work"], dependsOnNodeIds: [] }],
    [],
    "actual",
  );
  const startFields = {
    type: "workflow_process_start",
    runId,
    processId: "actual",
    processLabel: "Actual",
    branchId: "main",
    childWorkflowIds: ["work"],
    dependsOnNodeIds: [],
    workflowId: "work",
    attempt: 1,
    state: "running",
  };
  const state = fold([
    { type: "run_start", eventId: "run", runId },
    header,
    { ...startFields, eventId: "missing-version", workflowEventSequence: 1 },
    { ...startFields, eventId: "future-version", workflowEventVersion: 2, workflowEventSequence: 2 },
    { ...startFields, eventId: "bad-sequence", workflowEventVersion: 1, workflowEventSequence: -1 },
    { ...startFields, eventId: "unknown-id", workflowEventVersion: 1, workflowEventSequence: 3, processId: "unknown", processLabel: "Unknown", childWorkflowIds: ["unknown-work"], workflowId: "unknown-work" },
    { type: "workflow_output_committed", eventId: "bad-output", runId, workflowEventVersion: 1, workflowEventSequence: 4, processId: "actual", artifactRef: "", digest: "short" },
  ] as BridgeEvent[]);
  const actual = state.nodes.find(
    (node) => node.processNode && node.processId === "actual",
  );

  assert.equal(actual?.status, "pending");
  assert.equal(actual?.workflowEventSequence, 0);
  assert.equal(state.nodes.some((node) => node.processId === "unknown"), false);
  assert.equal(
    state.nodes.some((node) => node.eventType === "workflow_output_committed"),
    false,
  );
  assert.equal(compoundWorkflowOutputAuthorized(state, runId), false);
});

test("a frozen header rejects an outputProcessId absent from its declared graph", () => {
  const runId = "absent-output";
  const state = fold([
    { type: "run_start", eventId: "run", runId },
    frozenPlan(
      runId,
      [{ processId: "actual", processLabel: "Actual", branchId: "main", childWorkflowIds: ["work"], dependsOnNodeIds: [] }],
      [],
      "missing",
    ),
  ]);

  assert.equal(state.nodes.some((node) => node.workflowPlanFrozen), false);
  assert.equal(state.nodes.some((node) => node.processNode), false);
});

test("workflow plan and join contracts accept fan-in above the generic 64-id event limit", () => {
  const runId = "fan-in-65";
  const predecessors: TestProcessPlan[] = Array.from({ length: 65 }, (_, index) => ({
    processId: `branch-${index}`,
    processLabel: `Branch ${index}`,
    branchId: `lane-${index}`,
    childWorkflowIds: [`workflow-${index}`],
    dependsOnNodeIds: [],
  }));
  const expectedNodeIds = predecessors.map((process) => process.processId);
  const terminal: TestProcessPlan = {
    processId: "terminal",
    processLabel: "Terminal",
    branchId: "main",
    childWorkflowIds: ["finish"],
    dependsOnNodeIds: ["fan-in"],
  };
  const state = fold([
    frozenPlan(
      runId,
      [...predecessors, terminal],
      [{ joinId: "fan-in", expectedNodeIds }],
      "terminal",
    ),
    {
      type: "workflow_join_released",
      eventId: "join-release",
      runId,
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      joinId: "fan-in",
      expectedNodeIds,
      completedNodeIds: expectedNodeIds,
    },
  ]);
  const join = state.nodes.find((node) => node.joinId === "fan-in");

  assert.equal(join?.expectedNodeIds?.length, 65);
  assert.equal(join?.completedNodeIds?.length, 65);
  assert.equal(join?.status, "succeeded");
});

test("a stale blocked receipt cannot regress a newer running attempt", () => {
  const runId = "attempt-order";
  const plan = { processId: "process", processLabel: "Process", branchId: "main", childWorkflowIds: ["work"], dependsOnNodeIds: [] };
  const state = fold([
    frozenPlan(runId, [plan], [], "process"),
    { type: "workflow_process_start", eventId: "attempt-2", runId, workflowEventVersion: 1, workflowEventSequence: 10, ...plan, workflowId: "work", attempt: 2, state: "running" },
    { type: "workflow_process_end", eventId: "stale-blocked", runId, workflowEventVersion: 1, workflowEventSequence: 9, ...plan, state: "blocked" },
  ]);
  const process = state.nodes.find((node) => node.processNode);

  assert.equal(process?.status, "running");
  assert.equal(process?.workflowAttempt, 2);
  assert.equal(process?.workflowEventSequence, 10);
});

test("nests dynamic workflow stages, worker progress, and supervisor events in the live flow", () => {
  const state = fold([
    { type: "run_start", runId: "run-workflow", goal: "Review launch readiness" },
    {
      type: "dynamic_workflow_start",
      runId: "run-workflow",
      configuredMode: "on",
      maxStages: 3,
      maxAgents: 8,
    },
    {
      type: "dynamic_workflow_stage_start",
      runId: "run-workflow",
      stage: 1,
      pattern: "fan-out-and-synthesize",
      maxConcurrency: 3,
    },
    {
      type: "a2a_supervisor_start",
      runId: "run-workflow",
      workflowStage: 1,
      maxConcurrency: 3,
    },
    {
      type: "dynamic_workflow_worker_progress",
      runId: "run-workflow",
      stage: 1,
      index: 0,
      progress: "tool call · read_file",
    },
    {
      type: "dynamic_workflow_stage_end",
      runId: "run-workflow",
      stage: 1,
      pattern: "fan-out-and-synthesize",
      ok: true,
    },
    {
      type: "dynamic_workflow_synthesis_start",
      runId: "run-workflow",
      stages: 1,
      totalAgents: 3,
    },
    {
      type: "dynamic_workflow_end",
      runId: "run-workflow",
      status: "succeeded",
      stages: 1,
      totalAgents: 3,
      ok: true,
    },
  ]);

  const workflow = state.nodes.find(
    (node) => node.eventType === "dynamic_workflow_start",
  );
  const stage = state.nodes.find(
    (node) => node.eventType === "dynamic_workflow_stage_start",
  );
  const supervisor = state.nodes.find(
    (node) => node.eventType === "a2a_supervisor_start",
  );
  const worker = state.nodes.find(
    (node) => node.eventType === "dynamic_workflow_worker_progress",
  );
  const synthesis = state.nodes.find(
    (node) => node.eventType === "dynamic_workflow_synthesis_start",
  );

  assert.equal(workflow?.kind, "workflow");
  assert.equal(stage?.kind, "workflow");
  assert.equal(stage?.parentId, workflow?.id);
  assert.equal(supervisor?.parentId, stage?.id);
  assert.equal(worker?.parentId, stage?.id);
  assert.equal(synthesis?.parentId, workflow?.id);
  assert.match(worker?.label || "", /Workflow worker 1 progress/);
  assert.match(stage?.detail || "", /pattern fan-out-and-synthesize/);
});

test("rejects late events from the previous active session", () => {
  let state = sessionFlowReducer(EMPTY_SESSION_FLOW_STATE, {
    type: "reset",
    sessionId: "session-a",
  });
  state = sessionFlowReducer(state, {
    type: "event",
    sessionId: "session-a",
    event: { type: "run_start", runId: "run-a" },
  });
  assert.equal(state.nodes.length, 1);

  state = sessionFlowReducer(state, {
    type: "reset",
    sessionId: "session-b",
  });
  state = sessionFlowReducer(state, {
    type: "event",
    sessionId: "session-a",
    event: { type: "run_finished", runId: "run-a", ok: true },
  });
  assert.equal(state.nodes.length, 0);
  assert.equal(state.sessionId, "session-b");

  state = sessionFlowReducer(state, {
    type: "event",
    sessionId: "session-b",
    event: { type: "run_start", runId: "run-b" },
  });
  assert.equal(state.nodes.length, 1);
  assert.equal(state.nodes[0]?.runId, "run-b");
});

test("hydrates one selected session history and retargets it on rename", () => {
  const state = sessionFlowReducer(EMPTY_SESSION_FLOW_STATE, {
    type: "hydrate",
    sessionId: "selected-session",
    events: [
      {
        type: "run_start",
        runId: "history:1",
        session: "selected-session",
      },
      {
        type: "result",
        runId: "history:1",
        session: "selected-session",
        ok: true,
      },
    ],
  });
  assert.equal(state.sessionId, "selected-session");
  assert.deepEqual(
    [...new Set(state.nodes.map((node) => node.runId))],
    ["history:1"],
  );

  const renamed = sessionFlowReducer(state, {
    type: "retarget",
    sessionId: "renamed-session",
  });
  assert.equal(renamed.sessionId, "renamed-session");
  assert.equal(renamed.nodes, state.nodes);
});
