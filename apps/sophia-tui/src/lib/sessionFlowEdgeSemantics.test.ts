import test from "node:test";
import assert from "node:assert/strict";
import type {
  SessionFlowNode,
  SessionFlowNodeKind,
  SessionFlowNodeStatus,
} from "./sessionFlow.js";
import type { SessionFlowLayoutEdge } from "./sessionFlowLayout.js";
import {
  describeSessionFlowEdge,
  sessionFlowEdgeSemantics,
} from "./sessionFlowEdgeSemantics.js";

function node(
  id: string,
  kind: SessionFlowNodeKind,
  status: SessionFlowNodeStatus,
): SessionFlowNode {
  return {
    id,
    runId: "run-1",
    parentId: null,
    kind,
    status,
    label: id,
    detail: "",
    eventType: `${kind}_event`,
    sequence: id === "source" ? 1 : 2,
    depth: 0,
    timestamp: "2026-08-14T00:00:00.000Z",
    scope: "run-1:main",
  };
}

function edge(
  over: Partial<SessionFlowLayoutEdge> = {},
): SessionFlowLayoutEdge {
  return {
    id: "edge-1",
    edge: {
      id: "edge-1",
      source: "source",
      target: "target",
      kind: "sequence",
    },
    source: "source",
    target: "target",
    kind: "sequence",
    originalEdgeIds: ["edge-1"],
    points: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ],
    arrowDirection: "right",
    routeKind: "forward",
    backward: false,
    retryLike: false,
    lineStyle: "solid",
    ...over,
  };
}

test("structural containment is labeled, dotted, cyan, and arrowless", () => {
  const layoutEdge = edge({
    kind: "contains",
    edge: {
      id: "edge-1",
      source: "source",
      target: "target",
      kind: "contains",
    },
    lineStyle: "dotted",
  });
  const semantics = sessionFlowEdgeSemantics(
    layoutEdge,
    node("target", "workflow", "running"),
  );

  assert.deepEqual(
    {
      relation: semantics.relation,
      progress: semantics.progress,
      shortLabel: semantics.shortLabel,
      detailedLabel: semantics.detailedLabel,
      tone: semantics.tone,
      lineStyle: semantics.lineStyle,
      arrow: semantics.arrow,
      drawioColor: semantics.drawioColor,
      drawioDashPattern: semantics.drawioDashPattern,
    },
    {
      relation: "structure",
      progress: "live",
      shortLabel: "contains",
      detailedLabel: "contains",
      tone: "edge-structure",
      lineStyle: "dotted",
      arrow: false,
      drawioColor: "#00838f",
      drawioDashPattern: "1 4",
    },
  );
});

test("execution labels name the target operation while color tracks progress", () => {
  const live = sessionFlowEdgeSemantics(
    edge(),
    node("target", "agent", "running"),
  );
  assert.equal(live.shortLabel, "dispatch");
  assert.equal(live.detailedLabel, "dispatch/live");
  assert.equal(live.tone, "edge-live");
  assert.equal(live.lineStyle, "solid");
  assert.equal(live.arrow, true);

  const failed = sessionFlowEdgeSemantics(
    edge(),
    node("target", "tool", "failed"),
  );
  assert.equal(failed.shortLabel, "invoke");
  assert.equal(failed.detailedLabel, "invoke/failed");
  assert.equal(failed.tone, "edge-danger");
  assert.equal(failed.drawioColor, "#b85450");
});

test("handoff, retry, and return retain distinct relation labels and dashed shape", () => {
  const target = node("target", "system", "info");
  const handoff = sessionFlowEdgeSemantics(
    edge({
      kind: "handoff",
      edge: {
        id: "edge-1",
        source: "source",
        target: "target",
        kind: "handoff",
      },
      lineStyle: "dashed",
    }),
    target,
  );
  const retry = sessionFlowEdgeSemantics(
    edge({ routeKind: "retry", retryLike: true }),
    target,
  );
  const returned = sessionFlowEdgeSemantics(
    edge({ routeKind: "backward", backward: true }),
    target,
  );

  assert.deepEqual(
    [handoff.shortLabel, retry.shortLabel, returned.shortLabel],
    ["handoff", "retry", "return"],
  );
  assert.deepEqual(
    [handoff.tone, retry.tone, returned.tone],
    ["edge-progress", "edge-progress", "edge-progress"],
  );
  assert.ok(
    [handoff, retry, returned].every(
      (item) => item.lineStyle === "dashed" && item.arrow,
    ),
  );
});

test("accessible descriptions explain structural and directional meaning", () => {
  const source = node("source", "workflow", "succeeded");
  const target = node("target", "agent", "running");
  assert.equal(
    describeSessionFlowEdge(edge(), source, target),
    "source dispatch to target; live",
  );
  assert.equal(
    describeSessionFlowEdge(
      edge({
        kind: "contains",
        edge: {
          id: "edge-1",
          source: "source",
          target: "target",
          kind: "contains",
        },
      }),
      source,
      target,
    ),
    "source contains target; structural link with no execution arrow",
  );
});
