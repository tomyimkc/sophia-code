import type {
  SessionFlowNode,
  SessionFlowNodeKind,
  SessionFlowNodeStatus,
} from "./sessionFlow.js";
import type {
  SessionFlowLayoutEdge,
  SessionFlowLineStyle,
} from "./sessionFlowLayout.js";
import type { GraphEdgeTone } from "./terminalGraphCanvas.js";

export type SessionFlowEdgeRelation =
  | "structure"
  | "handoff"
  | "retry"
  | "return"
  | "sequence";

export type SessionFlowEdgeProgress =
  | "observed"
  | "queued"
  | "live"
  | "done"
  | "blocked"
  | "cancelled"
  | "failed";

export interface SessionFlowEdgeSemantics {
  relation: SessionFlowEdgeRelation;
  progress: SessionFlowEdgeProgress;
  shortLabel: string;
  detailedLabel: string;
  tone: GraphEdgeTone;
  lineStyle: SessionFlowLineStyle;
  arrow: boolean;
  drawioColor: string;
  drawioDashPattern?: string;
  strokeWidth: number;
}

const PROGRESS_BY_STATUS: Readonly<
  Record<SessionFlowNodeStatus, SessionFlowEdgeProgress>
> = {
  info: "observed",
  pending: "queued",
  running: "live",
  succeeded: "done",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

const SEQUENCE_LABEL_BY_TARGET_KIND: Readonly<
  Record<SessionFlowNodeKind, string>
> = {
  run: "start",
  harness: "enter",
  goal: "goal",
  model: "invoke",
  tool: "invoke",
  agent: "dispatch",
  workflow: "enter",
  agi: "enter",
  approval: "approval",
  receipt: "receipt",
  result: "result",
  system: "next",
};

const DRAWIO_COLOR_BY_TONE: Readonly<Record<GraphEdgeTone, string>> = {
  edge: "#0288d1",
  "edge-dim": "#00838f",
  "edge-label": "#0288d1",
  "edge-structure": "#00838f",
  "edge-progress": "#0288d1",
  "edge-queued": "#9673a6",
  "edge-live": "#1ba1e2",
  "edge-success": "#82b366",
  "edge-handoff": "#d79b00",
  "edge-retry": "#9673a6",
  "edge-warning": "#d79b00",
  "edge-danger": "#b85450",
};

const EDGE_TONE_PRIORITY: Readonly<Record<GraphEdgeTone, number>> = {
  edge: 10,
  "edge-dim": 5,
  "edge-label": 15,
  "edge-structure": 20,
  "edge-progress": 30,
  "edge-handoff": 35,
  "edge-retry": 40,
  "edge-queued": 50,
  "edge-success": 60,
  "edge-live": 70,
  "edge-warning": 80,
  "edge-danger": 90,
};

function relationForEdge(edge: SessionFlowLayoutEdge): SessionFlowEdgeRelation {
  if (edge.kind === "contains") return "structure";
  if (edge.routeKind === "backward") return "return";
  if (edge.routeKind === "retry" || edge.retryLike) return "retry";
  if (edge.kind === "handoff") return "handoff";
  return "sequence";
}

function relationLabel(
  relation: SessionFlowEdgeRelation,
  targetKind: SessionFlowNodeKind | undefined,
): string {
  if (relation === "structure") return "contains";
  if (relation === "handoff") return "handoff";
  if (relation === "retry") return "retry";
  if (relation === "return") return "return";
  return targetKind ? SEQUENCE_LABEL_BY_TARGET_KIND[targetKind] : "next";
}

function toneFor(
  relation: SessionFlowEdgeRelation,
  progress: SessionFlowEdgeProgress,
): GraphEdgeTone {
  if (relation === "structure") return "edge-structure";
  if (progress === "failed") return "edge-danger";
  if (progress === "blocked" || progress === "cancelled") {
    return "edge-warning";
  }
  if (progress === "live") return "edge-live";
  if (progress === "done") return "edge-success";
  if (progress === "queued") return "edge-queued";
  return "edge-progress";
}

function lineStyleFor(
  relation: SessionFlowEdgeRelation,
): SessionFlowLineStyle {
  if (relation === "structure") return "dotted";
  if (
    relation === "handoff" ||
    relation === "retry" ||
    relation === "return"
  ) {
    return "dashed";
  }
  return "solid";
}

export function sessionFlowEdgeTonePriority(tone: GraphEdgeTone): number {
  return EDGE_TONE_PRIORITY[tone];
}

export function isSessionFlowEdgeTone(
  tone: string | null | undefined,
): tone is GraphEdgeTone {
  return tone != null && Object.hasOwn(EDGE_TONE_PRIORITY, tone);
}

/**
 * Give every rendered link two independent meanings:
 * - shape/label describes the relationship;
 * - colour describes the target's observable progress state.
 *
 * Structural containment is deliberately arrowless because it is hierarchy,
 * not execution direction.
 */
export function sessionFlowEdgeSemantics(
  edge: SessionFlowLayoutEdge,
  targetNode: SessionFlowNode | null | undefined,
): SessionFlowEdgeSemantics {
  const relation = relationForEdge(edge);
  const progress = PROGRESS_BY_STATUS[targetNode?.status ?? "info"];
  const shortLabel = relationLabel(relation, targetNode?.kind);
  const tone = toneFor(relation, progress);
  const lineStyle = lineStyleFor(relation);
  return {
    relation,
    progress,
    shortLabel,
    detailedLabel:
      relation === "structure" ? shortLabel : `${shortLabel}/${progress}`,
    tone,
    lineStyle,
    arrow: relation !== "structure",
    drawioColor: DRAWIO_COLOR_BY_TONE[tone],
    drawioDashPattern:
      lineStyle === "dotted"
        ? "1 4"
        : lineStyle === "dashed"
          ? "8 4"
          : undefined,
    strokeWidth:
      progress === "live" ||
      progress === "failed" ||
      relation === "handoff" ||
      relation === "retry" ||
      relation === "return"
        ? 2
        : 1,
  };
}

export function describeSessionFlowEdge(
  edge: SessionFlowLayoutEdge,
  sourceNode: SessionFlowNode | null | undefined,
  targetNode: SessionFlowNode | null | undefined,
): string {
  const semantics = sessionFlowEdgeSemantics(edge, targetNode);
  const source = sourceNode?.label || edge.source;
  const target = targetNode?.label || edge.target;
  if (semantics.relation === "structure") {
    return `${source} contains ${target}; structural link with no execution arrow`;
  }
  return `${source} ${semantics.shortLabel} to ${target}; ${semantics.progress}`;
}
