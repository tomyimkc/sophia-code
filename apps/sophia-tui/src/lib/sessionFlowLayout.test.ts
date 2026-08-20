import test from "node:test";
import assert from "node:assert/strict";
import {
  compactSessionFlowLayout,
  layoutSessionFlow,
  type SessionFlowLayoutEdge,
} from "./sessionFlowLayout.js";
import type {
  SessionFlowEdge,
  SessionFlowNode,
  SessionFlowNodeKind,
  SessionFlowState,
} from "./sessionFlow.js";
import {
  EMPTY_SESSION_FLOW_STATE,
  sessionFlowReducer,
} from "./sessionFlow.js";
import type { BridgeEvent } from "./bridge.js";

function node(
  id: string,
  sequence: number,
  kind: SessionFlowNodeKind,
  options: Partial<SessionFlowNode> = {},
): SessionFlowNode {
  const runId = options.runId ?? "run-1";
  return {
    id,
    runId,
    parentId: options.parentId ?? null,
    kind,
    status: options.status ?? "succeeded",
    label: options.label ?? id,
    detail: options.detail ?? "",
    eventType: options.eventType ?? kind,
    sequence,
    depth: options.depth ?? (options.parentId ? 1 : 0),
    timestamp: options.timestamp ?? `2026-08-14T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    scope: options.scope ?? `${runId}:main`,
  };
}

function edge(
  kind: SessionFlowEdge["kind"],
  source: string,
  target: string,
  id = `${kind}:${source}:${target}`,
): SessionFlowEdge {
  return { id, kind, source, target };
}

function state(
  nodes: SessionFlowNode[],
  edges: SessionFlowEdge[],
  activeRunId = "run-1",
): SessionFlowState {
  return {
    schemaVersion: 1,
    candidateOnly: true,
    canClaimAGI: false,
    nodes,
    edges,
    activeRunId,
    eventCount: nodes.length,
    nextSequence: nodes.length + 1,
    lastNodeByScope: {},
    containerByScope: {},
    runNodeById: Object.fromEntries(
      nodes
        .filter((item) => item.kind === "run")
        .map((item) => [item.runId, item.id]),
    ),
    nodeDepthById: Object.fromEntries(
      nodes.map((item) => [item.id, item.depth]),
    ),
    seenEventIds: {},
  };
}

function assertOrthogonal(route: SessionFlowLayoutEdge): void {
  assert.ok(route.points.length >= 2, `${route.id} has a route`);
  for (let index = 1; index < route.points.length; index += 1) {
    const previous = route.points[index - 1];
    const current = route.points[index];
    assert.ok(previous);
    assert.ok(current);
    assert.ok(
      previous.x === current.x || previous.y === current.y,
      `${route.id} segment ${index} is orthogonal`,
    );
  }
}

function serialState(): SessionFlowState {
  const nodes = [
    node("run", 1, "run", { status: "running", eventType: "run_start" }),
    node("harness", 2, "harness", {
      parentId: "run",
      eventType: "harness_context",
    }),
    node("goal", 3, "goal", {
      parentId: "harness",
      eventType: "goal",
    }),
    node("result", 4, "result", {
      parentId: "goal",
      eventType: "result",
    }),
  ];
  return state(nodes, [
    edge("contains", "run", "harness"),
    edge("sequence", "run", "harness"),
    edge("contains", "harness", "goal"),
    edge("sequence", "harness", "goal"),
    edge("contains", "goal", "result"),
    edge("sequence", "goal", "result"),
    edge("handoff", "goal", "result"),
  ]);
}

function compoundGraphState(): SessionFlowState {
  const events: BridgeEvent[] = [
    { type: "run_start", eventId: "run", runId: "compound" },
    {
      type: "workflow_plan_frozen",
      eventId: "plan",
      runId: "compound",
      workflowEventVersion: 1,
      workflowEventSequence: 0,
      schema: "sophia.compound-workflow-plan.v1",
      planDigest: "f".repeat(64),
      outputProcessId: "serial",
      processes: [
        { processId: "seed", processLabel: "Seed", branchId: "main", childWorkflowIds: ["seed-workflow"], dependsOnNodeIds: [] },
        { processId: "left", processLabel: "Left branch", branchId: "left-lane", childWorkflowIds: ["left-collect", "left-check"], dependsOnNodeIds: ["seed"] },
        { processId: "right", processLabel: "Right branch", branchId: "right-lane", childWorkflowIds: ["right-plan", "right-run", "right-check"], dependsOnNodeIds: ["seed"] },
        { processId: "serial", processLabel: "Serial synthesis", branchId: "main", childWorkflowIds: ["synthesize"], dependsOnNodeIds: ["fan-in"] },
      ],
      joins: [
        { joinId: "fan-in", expectedNodeIds: ["left", "right"] },
      ],
    },
    {
      type: "workflow_output_committed",
      eventId: "output",
      runId: "compound",
      workflowEventVersion: 1,
      workflowEventSequence: 1,
      processId: "serial",
      artifactRef: "artifacts/final.json",
      digest: "a".repeat(64),
    },
  ];
  return events.reduce(
    (current, event) => sessionFlowReducer(current, { type: "event", event }),
    EMPTY_SESSION_FLOW_STATE,
  );
}

test("lays out a serial session as a deterministic left-to-right terminal DAG", () => {
  const first = layoutSessionFlow(serialState());
  const second = layoutSessionFlow(serialState());

  assert.deepEqual(second, first);
  assert.deepEqual(
    first.nodes.map((item) => item.id),
    ["run", "harness", "goal", "result"],
  );
  for (let index = 1; index < first.nodes.length; index += 1) {
    assert.ok(first.nodes[index - 1]);
    assert.ok(first.nodes[index]);
    assert.ok(first.nodes[index - 1]!.x < first.nodes[index]!.x);
    assert.equal(first.nodes[index - 1]!.y, first.nodes[index]!.y);
  }
  assert.ok(first.bounds.width > 0);
  assert.ok(first.bounds.height > 0);
  assert.equal(first.activeNodeId, "result");
  assert.equal(first.latestNodeId, "result");
  assert.equal(first.focusNodeId, "result");
  assert.equal(first.nodes.at(-1)?.active, true);
  assert.equal(first.nodes.at(-1)?.latest, true);

  for (const route of first.edges) assertOrthogonal(route);
  assert.equal(
    first.edges.find((item) => item.kind === "sequence")?.lineStyle,
    "solid",
  );
  assert.equal(
    first.edges.find((item) => item.kind === "contains")?.lineStyle,
    "dotted",
  );
  assert.equal(
    first.edges.find((item) => item.kind === "handoff")?.lineStyle,
    "dashed",
  );
  assert.ok(
    first.edges
      .filter((item) => !item.backward)
      .every((item) => item.arrowDirection === "right"),
  );
});

test("stacks parallel A2A lanes vertically and converges the main result to their right", () => {
  const nodes = [
    node("run", 1, "run", { status: "running" }),
    node("chain", 2, "agent", {
      parentId: "run",
      label: "A2A chain",
      eventType: "a2a_chain_start",
    }),
    node("agent-a", 3, "agent", {
      parentId: "chain",
      scope: "run-1:lane:a",
      label: "Agent A",
      eventType: "a2a_agent_start",
    }),
    node("agent-b", 4, "agent", {
      parentId: "chain",
      scope: "run-1:lane:b",
      label: "Agent B",
      eventType: "a2a_agent_start",
    }),
    node("result", 5, "result", {
      parentId: "run",
      eventType: "result",
    }),
  ];
  const flow = state(nodes, [
    edge("sequence", "run", "chain"),
    edge("contains", "run", "chain"),
    edge("contains", "chain", "agent-a"),
    edge("contains", "chain", "agent-b"),
    edge("sequence", "chain", "result"),
  ]);

  const layout = layoutSessionFlow(flow);
  const agentA = layout.nodes.find((item) => item.id === "agent-a");
  const agentB = layout.nodes.find((item) => item.id === "agent-b");
  const result = layout.nodes.find((item) => item.id === "result");
  assert.ok(agentA);
  assert.ok(agentB);
  assert.ok(result);
  assert.equal(agentA.x, agentB.x);
  assert.equal(agentA.layer, agentB.layer);
  assert.notEqual(agentA.y, agentB.y);
  assert.notEqual(agentA.row, agentB.row);
  assert.ok(result.x > agentA.x);
  assert.ok(result.x > agentB.x);
});

test("frames one, two, or three workflow members as transparent compound processes", () => {
  const layout = layoutSessionFlow(compoundGraphState());
  const frameByProcess = new Map(
    layout.processFrames.map((frame) => [frame.processId, frame]),
  );

  assert.equal(frameByProcess.get("seed")?.memberNodeIds.length, 1);
  assert.equal(frameByProcess.get("left")?.memberNodeIds.length, 2);
  assert.equal(frameByProcess.get("right")?.memberNodeIds.length, 3);
  assert.equal(frameByProcess.get("serial")?.memberNodeIds.length, 1);
  assert.match(frameByProcess.get("left")?.id || "", /^process-frame:compound:left$/);

  for (const frame of layout.processFrames) {
    for (const memberId of frame.memberNodeIds) {
      const member = layout.nodes.find((item) => item.id === memberId);
      assert.ok(member);
      assert.ok(member.x > frame.x, `${memberId} is inside the left border`);
      assert.ok(member.y > frame.y, `${memberId} is inside the top border`);
      assert.ok(
        member.x + member.width < frame.x + frame.width,
        `${memberId} is inside the right border`,
      );
      assert.ok(
        member.y + member.height < frame.y + frame.height,
        `${memberId} is inside the bottom border`,
      );
    }
  }
});

test("expanded process parents are selectable frame geometry and collapse as one node", () => {
  const flow = compoundGraphState();
  const expanded = layoutSessionFlow(flow, { detailLevel: "detailed" });
  const frame = expanded.processFrames.find(
    (item) => item.processId === "left",
  )!;
  const process = expanded.nodes.find(
    (item) => item.id === frame.processNodeId,
  )!;

  assert.equal(process.node.processNode, true);
  assert.deepEqual(
    { x: process.x, y: process.y, width: process.width, height: process.height },
    { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
  );
  assert.equal(frame.inputNodeId, process.id);
  assert.equal(frame.outputNodeId, process.id);
  assert.equal(process.visibleChildCount, 2);
  assert.ok(
    expanded.edges
      .filter((item) => item.kind === "contains" && item.source === process.id)
      .every((item) =>
        item.points.every(
          (point) =>
            point.x >= frame.x
            && point.x <= frame.x + frame.width
            && point.y >= frame.y
            && point.y <= frame.y + frame.height,
        )),
    "structural containment routes remain inside the frame",
  );

  const collapsed = layoutSessionFlow(flow, {
    detailLevel: "detailed",
    collapsedIds: [process.id],
  });
  const collapsedProcess = collapsed.nodes.find(
    (item) => item.id === process.id,
  )!;
  assert.equal(collapsedProcess.collapsed, true);
  assert.equal(
    collapsed.processFrames.some((item) => item.processId === "left"),
    false,
  );
  assert.ok(
    frame.memberNodeIds.every((id) => collapsed.hiddenNodeIds.includes(id)),
  );
  assert.ok(
    collapsed.edges.some(
      (item) => item.source === process.id && item.target.includes("fan-in"),
    ),
    "collapsed topology keeps the semantic process endpoint",
  );
});

test("lays out fan-out compounds, an explicit all-of join, and serial continuation left to right", () => {
  const flow = compoundGraphState();
  const layout = layoutSessionFlow(flow);
  const frameByProcess = new Map(
    layout.processFrames.map((frame) => [frame.processId, frame]),
  );
  const seed = frameByProcess.get("seed");
  const left = frameByProcess.get("left");
  const right = frameByProcess.get("right");
  const serial = frameByProcess.get("serial");
  const join = layout.nodes.find((item) => item.node.joinId === "fan-in");
  const output = layout.nodes.find(
    (item) => item.node.eventType === "workflow_output_committed",
  );
  assert.ok(seed);
  assert.ok(left);
  assert.ok(right);
  assert.ok(serial);
  assert.ok(join);
  assert.ok(output);

  const leftInput = layout.nodes.find((item) => item.id === left.inputNodeId)!;
  const rightInput = layout.nodes.find((item) => item.id === right.inputNodeId)!;
  assert.equal(leftInput.layer, rightInput.layer, "parallel branches fan out together");
  assert.notEqual(leftInput.row, rightInput.row, "parallel branches occupy distinct lanes");
  assert.ok(
    left.y + left.height <= right.y || right.y + right.height <= left.y,
    "parallel process frames do not overlap or share a border",
  );
  assert.ok(left.x > seed.x);
  assert.ok(right.x > seed.x);
  assert.ok(join.x > left.x + left.width - 1);
  assert.ok(join.x > right.x + right.width - 1);
  assert.ok(serial.x > join.x + join.width - 1);
  assert.ok(output.x > serial.x + serial.width - 1);
  assert.ok(layout.edges.every((item) => item.arrowDirection === "right"));

  const leftToJoin = layout.edges.find(
    (item) => item.source === left.outputNodeId && item.target === join.id,
  );
  const joinToSerial = layout.edges.find(
    (item) => item.source === join.id && item.target === serial.inputNodeId,
  );
  const serialToOutput = layout.edges.find(
    (item) => item.source === serial.outputNodeId && item.target === output.id,
  );
  assert.ok(leftToJoin);
  assert.ok(joinToSerial);
  assert.ok(serialToOutput);
  assert.equal(
    flow.edges.some((item) =>
      item.target === serial.inputNodeId
      && [left.outputNodeId, right.outputNodeId].includes(item.source)),
    false,
    "parallel branches cannot bypass the explicit all-of join",
  );
  assert.equal(
    flow.edges.some((item) =>
      item.kind === "sequence"
      && item.target === join.id
      && ![left.outputNodeId, right.outputNodeId].includes(item.source)),
    false,
    "no chronology shortcut can bypass declared join predecessors",
  );
  assert.equal(
    flow.edges.some((item) =>
      item.kind === "sequence"
      && item.target === output.id
      && item.source !== serial.outputNodeId),
    false,
    "output can only be committed by its declared process",
  );
  assert.equal(
    flow.edges.some((item) =>
      item.kind === "sequence"
      && item.source === join.id
      && item.target === output.id),
    false,
    "the join cannot bypass the final serial producer to reach Output",
  );
  assert.equal(leftToJoin.points[0]?.x, left.x + left.width - 1);
  assert.equal(joinToSerial.points.at(-1)?.x, serial.x);
  assert.equal(serialToOutput.points[0]?.x, serial.x + serial.width - 1);
});

test("compound frame and member identities stay stable across deterministic hydration", () => {
  const first = layoutSessionFlow(compoundGraphState());
  const second = layoutSessionFlow(compoundGraphState());
  assert.deepEqual(
    second.processFrames.map((frame) => [frame.id, frame.memberNodeIds]),
    first.processFrames.map((frame) => [frame.id, frame.memberNodeIds]),
  );
});

test("auto-collapses model/tool/receipt detail and supports controlled expansion/collapse", () => {
  const nodes = [
    node("run", 1, "run", { status: "running" }),
    node("agent", 2, "agent", {
      parentId: "run",
      eventType: "a2a_agent_start",
    }),
    node("model", 3, "model", {
      parentId: "agent",
      eventType: "model_result",
    }),
    node("tool", 4, "tool", {
      parentId: "model",
      eventType: "tool_call",
    }),
    node("receipt", 5, "receipt", {
      parentId: "agent",
      eventType: "receipt",
    }),
    node("result", 6, "result", {
      parentId: "run",
      eventType: "result",
    }),
  ];
  const flow = state(nodes, [
    edge("sequence", "run", "agent"),
    edge("sequence", "agent", "model"),
    edge("sequence", "model", "tool"),
    edge("sequence", "tool", "receipt"),
    edge("sequence", "receipt", "result"),
  ]);

  const overview = layoutSessionFlow(flow);
  assert.deepEqual(
    overview.nodes.map((item) => item.id),
    ["run", "agent", "result"],
  );
  assert.deepEqual(overview.hiddenNodeIds, ["model", "tool", "receipt"]);
  assert.ok(overview.collapsedIds.includes("agent"));
  assert.equal(
    overview.nodes.find((item) => item.id === "agent")?.hiddenChildCount,
    3,
  );

  const expanded = layoutSessionFlow(flow, {
    detailLevel: "overview",
    collapsedIds: [],
  });
  assert.deepEqual(
    expanded.nodes.map((item) => item.id),
    ["run", "agent", "model", "tool", "receipt", "result"],
  );

  const selectivelyExpanded = layoutSessionFlow(flow, {
    detailLevel: "overview",
    expandedIds: ["agent"],
  });
  assert.deepEqual(
    selectivelyExpanded.nodes.map((item) => item.id),
    ["run", "agent", "model", "tool", "receipt", "result"],
  );

  const controlledOverview = layoutSessionFlow(flow, {
    detailLevel: "overview",
    collapsedIds: [],
    autoCollapseDetails: true,
  });
  assert.deepEqual(
    controlledOverview.nodes.map((item) => item.id),
    ["run", "agent", "result"],
  );

  const collapsed = layoutSessionFlow(flow, {
    detailLevel: "detailed",
    collapsedIds: ["agent"],
  });
  assert.deepEqual(
    collapsed.nodes.map((item) => item.id),
    ["run", "agent", "result"],
  );
  assert.equal(
    collapsed.nodes.find((item) => item.id === "agent")?.explicitlyCollapsed,
    true,
  );
});

test("preserves every existing node position when later nodes append", () => {
  const initial = serialState();
  const initialNodes = initial.nodes.slice(0, 3);
  const initialEdges = initial.edges.filter(
    (item) => item.source !== "result" && item.target !== "result",
  );
  const before = layoutSessionFlow(state(initialNodes, initialEdges));
  const after = layoutSessionFlow(initial, { previous: before });

  for (const previousNode of before.nodes) {
    const nextNode = after.nodes.find((item) => item.id === previousNode.id);
    assert.ok(nextNode);
    assert.deepEqual(
      {
        x: nextNode.x,
        y: nextNode.y,
        width: nextNode.width,
        height: nextNode.height,
        layer: nextNode.layer,
        row: nextNode.row,
      },
      {
        x: previousNode.x,
        y: previousNode.y,
        width: previousNode.width,
        height: previousNode.height,
        layer: previousNode.layer,
        row: previousNode.row,
      },
    );
  }
  assert.equal(after.latestNodeId, "result");
  assert.ok(
    after.nodes.find((item) => item.id === "result")!.x >
      after.nodes.find((item) => item.id === "goal")!.x,
  );
});

test("provides a compact layout API and grid projection for constrained terminals", () => {
  const normal = layoutSessionFlow(serialState());
  const compact = compactSessionFlowLayout(serialState());

  assert.equal(compact.density, "compact");
  assert.ok(compact.nodes.every((item) => item.height === 1));
  assert.ok(compact.nodes[0]!.width < normal.nodes[0]!.width);
  assert.ok(compact.bounds.width < normal.bounds.width);
  assert.equal(compact.compact.columns, 4);
  assert.equal(compact.compact.rows, 1);
  assert.deepEqual(
    compact.compact.nodes.map((item) => [item.id, item.column, item.row]),
    [
      ["run", 0, 0],
      ["harness", 1, 0],
      ["goal", 2, 0],
      ["result", 3, 0],
    ],
  );
});

test("normalizes feedback links into a left-to-right chronological retry lane", () => {
  const nodes = [
    node("run", 1, "run", { status: "running" }),
    node("goal", 2, "goal", {
      parentId: "run",
      eventType: "goal",
    }),
    node("retry", 3, "workflow", {
      parentId: "goal",
      eventType: "workflow_retry",
      label: "Retry goal",
    }),
  ];
  const flow = state(nodes, [
    edge("sequence", "run", "goal"),
    edge("sequence", "goal", "retry"),
    edge("sequence", "retry", "goal", "sequence:retry:goal"),
  ]);
  const layout = layoutSessionFlow(flow);
  const backwards = layout.edges.find(
    (item) => item.originalEdgeIds.includes("sequence:retry:goal"),
  );
  assert.ok(backwards);
  assert.equal(backwards.source, "goal");
  assert.equal(backwards.target, "retry");
  assert.equal(backwards.backward, true);
  assert.equal(backwards.retryLike, true);
  assert.equal(backwards.chronologyNormalized, true);
  assert.equal(backwards.routeKind, "retry");
  assert.equal(backwards.arrowDirection, "right");
  assertOrthogonal(backwards);
  assert.ok(
    Math.max(...backwards.points.map((point) => point.y)) >
      Math.max(...layout.nodes.map((item) => item.y + item.height)),
  );
  assert.ok(layout.edges.every((item) => item.arrowDirection === "right"));
  assert.ok(layout.bounds.minX >= 0);
});

test("live topology growth keeps Output to the right instead of freezing an old column", () => {
  const beforeState = state(
    [
      node("main", 1, "run", { eventType: "major_main_agent" }),
      node("output", 3, "result", { eventType: "major_output" }),
    ],
    [edge("sequence", "main", "output")],
  );
  const before = layoutSessionFlow(beforeState);
  const afterState = state(
    [
      node("main", 1, "run", { eventType: "major_main_agent" }),
      node("workflow", 2, "workflow", { eventType: "major_workflow" }),
      node("output", 3, "result", { eventType: "major_output" }),
    ],
    [
      edge("sequence", "main", "workflow"),
      edge("sequence", "workflow", "output"),
    ],
  );
  const after = layoutSessionFlow(afterState, { previousLayout: before });
  const workflow = after.nodes.find((item) => item.id === "workflow")!;
  const output = after.nodes.find((item) => item.id === "output")!;
  assert.ok(output.x > workflow.x);
  assert.ok(
    output.x > before.nodes.find((item) => item.id === "output")!.x,
    "the terminal output moves right when an intermediate workflow appears",
  );
  assert.ok(after.edges.every((item) => item.arrowDirection === "right"));
});

test("semantic zoom recomputes preserved node dimensions and column spacing", () => {
  const normal = layoutSessionFlow(serialState(), {
    nodeWidth: 24,
    nodeHeight: 5,
    horizontalGap: 8,
  });
  const inspect = layoutSessionFlow(serialState(), {
    previousLayout: normal,
    nodeWidth: 40,
    nodeHeight: 9,
    horizontalGap: 12,
  });

  assert.ok(inspect.nodes.every((item) => item.width === 40));
  assert.ok(inspect.nodes.every((item) => item.height === 9));
  assert.ok(inspect.bounds.width > normal.bounds.width);
  assert.ok(
    inspect.nodes[1]!.x - inspect.nodes[0]!.x
      > normal.nodes[1]!.x - normal.nodes[0]!.x,
  );
});
