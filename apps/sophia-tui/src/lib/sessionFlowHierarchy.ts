import type {
  SessionFlowEdge,
  SessionFlowEdgeKind,
  SessionFlowNode,
  SessionFlowNodeKind,
  SessionFlowNodeStatus,
  SessionFlowState,
} from "./sessionFlow.js";

export type SessionFlowHierarchyLevel = "overview" | "stages" | "workers";

export type SessionFlowHierarchyEntityKind =
  | "run"
  | "main-agent"
  | "workflow"
  | "output"
  | "agi-controller"
  | "agi-node"
  | "stage"
  | "worker"
  | "critical";

export interface SessionFlowHierarchyNodeMeta {
  projectedNodeId: string;
  entityKind: SessionFlowHierarchyEntityKind;
  sourceNodeIds: string[];
  hiddenEventCount: number;
  childEntityIds: string[];
  compound: boolean;
  expandable: boolean;
  drillable: boolean;
  childFocusNodeId: string | null;
  /** Exact live-status entity ID when the raw flow retained enough identity. */
  statusLookupId: string | null;
  hierarchyPath: string[];
  sourceEventTypes: string[];
  summary: string;
}

export interface SessionFlowHierarchyBreadcrumb {
  id: string;
  label: string;
  level: SessionFlowHierarchyLevel;
  focusNodeId: string | null;
}

export interface SessionFlowHierarchyProjection {
  /** Preferred rendering surface. */
  state: SessionFlowState;
  /** Explicit alias for callers that want the purpose encoded in the name. */
  projectedState: SessionFlowState;
  metadataByNodeId: Record<string, SessionFlowHierarchyNodeMeta>;
  level: SessionFlowHierarchyLevel;
  focusNodeId: string | null;
  breadcrumbs: SessionFlowHierarchyBreadcrumb[];
}

export interface SessionFlowHierarchyOptions {
  level: SessionFlowHierarchyLevel;
  focusNodeId?: string;
}

type GroupCategory =
  | "standalone"
  | "run"
  | "workflow"
  | "workflow-controller"
  | "workflow-stage"
  | "workflow-worker"
  | "workflow-synthesis"
  | "workflow-result"
  | "agi-controller"
  | "agi-node"
  | "agi-stage"
  | "agi-worker"
  | "agi-result";

interface ProjectionGroup {
  id: string;
  runId: string;
  category: GroupCategory;
  sources: SessionFlowNode[];
  kind: SessionFlowNodeKind;
  baseLabel: string;
  scope: string;
  parentId: string | null;
  childEntityIds: string[];
  hierarchyPath: string[];
  compound: boolean;
  syntheticSequence: number;
}

interface DynamicNodeInfo {
  runId: string;
  category: "root" | "controller" | "stage" | "worker" | "synthesis" | "result";
  stageKey: string;
  workerKey: string;
}

interface AGINodeInfo {
  runId: string;
  category: "controller" | "node" | "stage" | "worker" | "result";
  nodeKey: string;
  stageKey: string;
  workerKey: string;
}

interface FocusContext {
  runId: string;
  family: "run" | "dynamic" | "agi";
  nodeKey: string;
  stageKey: string;
  workerKey: string;
}

const HIERARCHY_PREFIX = "session-flow-hierarchy";

const ADVERSE_STATUSES = new Set<SessionFlowNodeStatus>([
  "running",
  "blocked",
  "failed",
  "cancelled",
]);

function compareNodes(left: SessionFlowNode, right: SessionFlowNode): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function safeSegment(value: string): string {
  return encodeURIComponent(value || "unknown");
}

function hierarchyId(...segments: string[]): string {
  return [HIERARCHY_PREFIX, ...segments.map(safeSegment)].join(":");
}

function dynamicWorkflowId(runId: string): string {
  return hierarchyId("run", runId, "workflow");
}

function dynamicControllerId(runId: string): string {
  return hierarchyId("run", runId, "workflow", "controller");
}

function dynamicStageId(runId: string, stageKey: string): string {
  return hierarchyId("run", runId, "workflow", "stage", stageKey);
}

function dynamicWorkerId(
  runId: string,
  stageKey: string,
  workerKey: string,
): string {
  return hierarchyId(
    "run",
    runId,
    "workflow",
    "stage",
    stageKey,
    "worker",
    workerKey,
  );
}

function dynamicSynthesisId(runId: string): string {
  return hierarchyId("run", runId, "workflow", "synthesis");
}

function dynamicResultId(runId: string): string {
  return hierarchyId("run", runId, "workflow", "result");
}

function agiControllerId(runId: string): string {
  return hierarchyId("run", runId, "agi-workflow");
}

function agiNodeId(runId: string, nodeKey: string): string {
  return hierarchyId("run", runId, "agi-workflow", "node", nodeKey);
}

function agiStageId(
  runId: string,
  nodeKey: string,
  stageKey: string,
): string {
  return hierarchyId(
    "run",
    runId,
    "agi-workflow",
    "node",
    nodeKey,
    "stage",
    stageKey,
  );
}

function agiWorkerId(
  runId: string,
  nodeKey: string,
  stageKey: string,
  workerKey: string,
): string {
  return hierarchyId(
    "run",
    runId,
    "agi-workflow",
    "node",
    nodeKey,
    "stage",
    stageKey,
    "worker",
    workerKey,
  );
}

function agiResultId(runId: string): string {
  return hierarchyId("run", runId, "agi-workflow", "result");
}

function firstMatch(
  text: string,
  patterns: readonly RegExp[],
): string {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return "";
}

function combinedText(node: SessionFlowNode): string {
  return `${node.scope} · ${node.label} · ${node.detail}`;
}

function stageKeyFromNode(node: SessionFlowNode): string {
  if (node.identity?.stageKey) return node.identity.stageKey;
  return firstMatch(combinedText(node), [
    /:workflow:stage:([a-z0-9._-]+)/i,
    /\bworkflowStage\s*[:=]\s*([a-z0-9._-]+)/i,
    /\bstage\s+([a-z0-9._-]+)/i,
  ]);
}

function workerKeyFromNode(node: SessionFlowNode): string {
  const identity = node.identity;
  if (node.eventType.startsWith("dynamic_workflow_")) {
    const dynamicKey = identity?.workerIndex || identity?.workerKey;
    if (dynamicKey) return dynamicKey;
  }
  const structuredKey =
    identity?.agentKey
    || identity?.logicalAgentId
    || identity?.agentId
    || identity?.workerId
    || identity?.leaseId
    || identity?.workerKey
    || identity?.agentName
    || identity?.taskId;
  if (structuredKey) return structuredKey;
  return firstMatch(combinedText(node), [
    /:worker:([a-z0-9._-]+)/i,
    /\bworkerId\s*[:=]\s*([a-z0-9._-]+)/i,
    /\bworker\s+([a-z0-9._-]+)/i,
    /\btask\s+([a-z0-9._-]+)/i,
    /\blane\s+([a-z0-9._-]+)/i,
  ]);
}

function workflowKeyFromNode(node: SessionFlowNode): string {
  if (node.identity?.workflowId) return node.identity.workflowId;
  return firstMatch(combinedText(node), [
    /\bworkflowId\s*[:=]\s*([a-z0-9._-]+)/i,
    /\bworkflow\s+id\s*[:=]?\s*([a-z0-9._-]+)/i,
  ]);
}

function agiWorkerIdentityFromNode(node: SessionFlowNode): string {
  const identity = node.identity;
  const structured =
    identity?.agentKey
    || identity?.logicalAgentId
    || identity?.agentId
    || identity?.workerId
    || identity?.leaseId
    || identity?.workerKey
    || identity?.agentName;
  if (structured) return structured;
  return firstMatch(combinedText(node), [
    /\bagentKey\s*[:=]\s*([a-z0-9._-]+)/i,
    /\blogicalAgentId\s*[:=]\s*([a-z0-9._-]+)/i,
    /\bagentId\s*[:=]\s*([a-z0-9._-]+)/i,
    /\bworkerId\s*[:=]\s*([a-z0-9._-]+)/i,
    /\bleaseId\s*[:=]\s*([a-z0-9._-]+)/i,
  ]);
}

function explicitAGINodeKey(node: SessionFlowNode): string {
  if (node.identity?.nodeId) return node.identity.nodeId;
  return firstMatch(combinedText(node), [
    /:agi(?::workflow)?:node:([a-z0-9._-]+)/i,
    /\bnodeId\s*[:=]\s*([a-z0-9._-]+)/i,
    /\bnode\s+id\s*[:=]?\s*([a-z0-9._-]+)/i,
    /\btask\s+([a-z0-9._-]+)/i,
  ]);
}

function normalizedStageKey(node: SessionFlowNode): string {
  return stageKeyFromNode(node) || "unscoped";
}

function normalizedWorkerKey(node: SessionFlowNode): string {
  return workerKeyFromNode(node) || "unscoped";
}

function dynamicInfoFor(node: SessionFlowNode): DynamicNodeInfo | null {
  if (!node.eventType.startsWith("dynamic_workflow_")) return null;
  const stageKey = normalizedStageKey(node);
  const workerKey =
    workerKeyFromNode(node)
    || (
      node.eventType.startsWith("dynamic_workflow_worker_")
        ? `source-${node.id}`
        : "unscoped"
    );
  if (node.eventType.startsWith("dynamic_workflow_synthesis_")) {
    return {
      runId: node.runId,
      category: "synthesis",
      stageKey,
      workerKey,
    };
  }
  if (node.eventType === "dynamic_workflow_end") {
    return {
      runId: node.runId,
      category: "result",
      stageKey,
      workerKey,
    };
  }
  if (node.eventType.startsWith("dynamic_workflow_controller_")) {
    return {
      runId: node.runId,
      category: "controller",
      stageKey,
      workerKey,
    };
  }
  if (node.eventType.startsWith("dynamic_workflow_worker_")) {
    return {
      runId: node.runId,
      category: "worker",
      stageKey,
      workerKey,
    };
  }
  if (node.eventType.startsWith("dynamic_workflow_stage_")) {
    return {
      runId: node.runId,
      category: "stage",
      stageKey,
      workerKey,
    };
  }
  return {
    runId: node.runId,
    category: "root",
    stageKey,
    workerKey,
  };
}

function buildAGIInfo(
  nodes: readonly SessionFlowNode[],
): Map<string, AGINodeInfo> {
  const result = new Map<string, AGINodeInfo>();
  const activeNodeByRun = new Map<string, string>();

  for (const node of nodes) {
    if (!node.eventType.startsWith("agi_workflow_")) continue;
    const type = node.eventType;
    if (type === "agi_workflow_end") {
      result.set(node.id, {
        runId: node.runId,
        category: "result",
        nodeKey: "",
        stageKey: "",
        workerKey: "",
      });
      activeNodeByRun.delete(node.runId);
      continue;
    }

    let nodeKey = explicitAGINodeKey(node);
    if (type === "agi_workflow_node_start" && !nodeKey) {
      nodeKey = `source-${node.id}`;
    }
    if (!nodeKey) nodeKey = activeNodeByRun.get(node.runId) || "";
    if (type === "agi_workflow_node_start" && nodeKey) {
      activeNodeByRun.set(node.runId, nodeKey);
    }

    const stageKey = normalizedStageKey(node);
    let workerKey = normalizedWorkerKey(node);
    let category: AGINodeInfo["category"] = "controller";
    if (nodeKey) {
      category = "node";
      if (type.startsWith("agi_workflow_workflow_")) category = "stage";
      if (
        type === "agi_workflow_worker_lease"
        || type === "agi_workflow_warm_pool"
        || type === "agi_workflow_evicted"
      ) {
        category = "worker";
      }
    }
    if (category === "worker" && workerKey === "unscoped") {
      workerKey = `source-${node.id}`;
    }
    result.set(node.id, {
      runId: node.runId,
      category,
      nodeKey,
      stageKey,
      workerKey,
    });

    if (type === "agi_workflow_node_end") {
      activeNodeByRun.delete(node.runId);
    }
  }
  return result;
}

function statusRank(status: SessionFlowNodeStatus): number {
  switch (status) {
    case "failed":
      return 7;
    case "blocked":
      return 6;
    case "cancelled":
      return 5;
    case "running":
      return 4;
    case "succeeded":
      return 3;
    case "pending":
      return 2;
    default:
      return 1;
  }
}

function isTerminalSuccess(node: SessionFlowNode): boolean {
  if (node.status !== "succeeded") return false;
  return (
    node.eventType === "result"
    || node.eventType === "run_finished"
    || node.eventType === "dynamic_workflow_end"
    || node.eventType === "agi_workflow_end"
    || node.eventType === "agi_workflow_node_end"
    || node.eventType === "agi_workflow_workflow_end"
    || /(^|_)(result|receipt|end|ended|finish|finished|complete|completed)$/.test(
      node.eventType,
    )
  );
}

function aggregateStatus(
  sourceNodes: readonly SessionFlowNode[],
): SessionFlowNodeStatus {
  const nodes = [...sourceNodes].sort(compareNodes);
  if (nodes.length === 0) return "info";

  const lastTerminalSuccess = [...nodes].reverse().find(isTerminalSuccess);
  const lastAdverse = [...nodes]
    .reverse()
    .find((node) => ADVERSE_STATUSES.has(node.status));
  if (
    lastTerminalSuccess
    && (!lastAdverse || lastTerminalSuccess.sequence >= lastAdverse.sequence)
  ) {
    return "succeeded";
  }

  return nodes.reduce<SessionFlowNodeStatus>(
    (current, node) =>
      statusRank(node.status) > statusRank(current)
        ? node.status
        : current,
    "info",
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function eventCountLabel(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}

function readableKey(value: string, prefix: string): string {
  const normalized = value.replace(/^source-/, "");
  if (prefix === "worker" && /^\d+$/.test(normalized)) {
    return String(Number(normalized) + 1);
  }
  return normalized === "unscoped" ? "unscoped" : normalized.replaceAll("_", " ");
}

function sourceDetail(nodes: readonly SessionFlowNode[]): string {
  const details = uniqueStrings(
    [...nodes]
      .sort(compareNodes)
      .map((node) => node.detail.trim())
      .filter(Boolean),
  );
  return details.at(-1) || "";
}

function groupLabel(group: ProjectionGroup): string {
  if (group.category === "standalone" || group.category === "run") {
    return group.baseLabel;
  }
  return `${group.baseLabel} · ${eventCountLabel(group.sources.length)}`;
}

function groupDetail(group: ProjectionGroup): string {
  const hidden = Math.max(0, group.sources.length - 1);
  const detail = sourceDetail(group.sources);
  const counts = `${eventCountLabel(group.sources.length)} source · ${hidden} hidden`;
  return detail ? `${detail} · ${counts}` : counts;
}

function groupSequence(group: ProjectionGroup): number {
  if (group.sources.length === 0) return group.syntheticSequence;
  return Math.min(...group.sources.map((node) => node.sequence));
}

function groupTimestamp(group: ProjectionGroup): string {
  return [...group.sources].sort(compareNodes).at(-1)?.timestamp || "";
}

function addSource(
  groups: Map<string, ProjectionGroup>,
  group: Omit<ProjectionGroup, "sources">,
  node: SessionFlowNode,
  representativeByRawId: Map<string, string>,
): void {
  const existing = groups.get(group.id);
  if (existing) {
    existing.sources.push(node);
    existing.childEntityIds = uniqueStrings([
      ...existing.childEntityIds,
      ...group.childEntityIds,
    ]);
  } else {
    groups.set(group.id, { ...group, sources: [node] });
  }
  representativeByRawId.set(node.id, group.id);
}

function addSyntheticGroup(
  groups: Map<string, ProjectionGroup>,
  group: ProjectionGroup,
): void {
  if (!groups.has(group.id)) groups.set(group.id, group);
}

function shouldPreserveStandalone(node: SessionFlowNode): boolean {
  if (
    node.kind === "run"
    || node.kind === "goal"
    || node.kind === "harness"
    || node.kind === "approval"
    || node.kind === "receipt"
    || node.kind === "result"
  ) {
    return true;
  }
  if (
    node.eventType === "final"
    || node.eventType === "assistant_message"
    || node.eventType === "run_finished"
    || node.eventType.startsWith("synthesis_")
  ) {
    return true;
  }
  return ["blocked", "failed", "cancelled"].includes(node.status);
}

function groupCategoryOrder(category: GroupCategory): number {
  switch (category) {
    case "run":
      return 0;
    case "standalone":
      return 1;
    case "workflow":
    case "agi-controller":
      return 2;
    case "workflow-controller":
    case "agi-node":
      return 3;
    case "workflow-stage":
    case "agi-stage":
      return 4;
    case "workflow-worker":
    case "agi-worker":
      return 5;
    case "workflow-synthesis":
      return 6;
    case "workflow-result":
    case "agi-result":
      return 7;
  }
}

function entityKindFor(
  group: ProjectionGroup,
): SessionFlowHierarchyEntityKind {
  switch (group.category) {
    case "run":
      return "run";
    case "workflow":
    case "workflow-controller":
      return "workflow";
    case "agi-controller":
      return "agi-controller";
    case "agi-node":
      return "agi-node";
    case "workflow-stage":
    case "agi-stage":
      return "stage";
    case "workflow-worker":
    case "agi-worker":
      return "worker";
    case "workflow-synthesis":
    case "workflow-result":
    case "agi-result":
      return "critical";
    case "standalone":
      if (
        group.sources.some((source) =>
          source.processNode || source.processMember || source.joinId)
      ) {
        return "workflow";
      }
      return group.kind === "run" ? "run" : "critical";
  }
}

function liveStatusIdPart(value: string, fallback: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function statusLookupIdFor(group: ProjectionGroup): string | null {
  const source = [...group.sources].sort(compareNodes)[0];
  if (!source) return null;
  const stageKey = stageKeyFromNode(source);
  const workerKey = workerKeyFromNode(source);
  switch (group.category) {
    case "workflow-stage":
      return stageKey ? `dynamic-workflow-stage:${stageKey}` : null;
    case "workflow-worker": {
      if (!stageKey || !workerKey || !/^\d+$/.test(workerKey)) return null;
      return `dynamic-workflow-worker:${stageKey}:${workerKey}`;
    }
    case "agi-stage": {
      const workflowKey = group.sources
        .map(workflowKeyFromNode)
        .find(Boolean);
      return workflowKey && stageKey
        ? `agi-workflow-stage:${liveStatusIdPart(workflowKey, "workflow")}:${stageKey}`
        : null;
    }
    case "agi-worker": {
      const identity = group.sources
        .map(agiWorkerIdentityFromNode)
        .find(Boolean);
      return identity
        ? `agi-workflow-worker:${liveStatusIdPart(identity, "worker")}`
        : null;
    }
    default:
      return null;
  }
}

function phaseLabel(nodes: readonly SessionFlowNode[]): string {
  for (const node of nodes) {
    const phase = firstMatch(node.detail, [/\bphase\s+([a-z0-9._-]+)/i]);
    if (phase) return phase.replaceAll("_", " ");
  }
  return "";
}

function focusFromInputs(
  focusNodeId: string | undefined,
  rawById: ReadonlyMap<string, SessionFlowNode>,
  dynamicByRawId: ReadonlyMap<string, DynamicNodeInfo>,
  agiByRawId: ReadonlyMap<string, AGINodeInfo>,
  knownContexts: ReadonlyMap<string, FocusContext>,
): FocusContext | null {
  if (!focusNodeId) return null;
  const raw = rawById.get(focusNodeId);
  if (raw) {
    const dynamic = dynamicByRawId.get(raw.id);
    if (dynamic) {
      return {
        runId: dynamic.runId,
        family: "dynamic",
        nodeKey: "",
        stageKey: dynamic.stageKey,
        workerKey: dynamic.workerKey,
      };
    }
    const agi = agiByRawId.get(raw.id);
    if (agi) {
      return {
        runId: agi.runId,
        family: "agi",
        nodeKey: agi.nodeKey,
        stageKey: agi.stageKey,
        workerKey: agi.workerKey,
      };
    }
    return {
      runId: raw.runId,
      family: "run",
      nodeKey: "",
      stageKey: "",
      workerKey: "",
    };
  }
  return knownContexts.get(focusNodeId) || null;
}

function makeKnownFocusContexts(
  nodes: readonly SessionFlowNode[],
  dynamicByRawId: ReadonlyMap<string, DynamicNodeInfo>,
  agiByRawId: ReadonlyMap<string, AGINodeInfo>,
): Map<string, FocusContext> {
  const contexts = new Map<string, FocusContext>();
  for (const node of nodes) {
    contexts.set(node.id, {
      runId: node.runId,
      family: "run",
      nodeKey: "",
      stageKey: "",
      workerKey: "",
    });
    const dynamic = dynamicByRawId.get(node.id);
    if (dynamic) {
      const rootContext: FocusContext = {
        runId: node.runId,
        family: "dynamic",
        nodeKey: "",
        stageKey: "",
        workerKey: "",
      };
      contexts.set(dynamicWorkflowId(node.runId), rootContext);
      if (dynamic.stageKey) {
        contexts.set(dynamicStageId(node.runId, dynamic.stageKey), {
          ...rootContext,
          stageKey: dynamic.stageKey,
        });
      }
      if (dynamic.workerKey) {
        contexts.set(
          dynamicWorkerId(
            node.runId,
            dynamic.stageKey,
            dynamic.workerKey,
          ),
          {
            ...rootContext,
            stageKey: dynamic.stageKey,
            workerKey: dynamic.workerKey,
          },
        );
      }
    }
    const agi = agiByRawId.get(node.id);
    if (agi) {
      const controllerContext: FocusContext = {
        runId: node.runId,
        family: "agi",
        nodeKey: "",
        stageKey: "",
        workerKey: "",
      };
      contexts.set(agiControllerId(node.runId), controllerContext);
      if (agi.nodeKey) {
        contexts.set(agiNodeId(node.runId, agi.nodeKey), {
          ...controllerContext,
          nodeKey: agi.nodeKey,
        });
      }
      if (agi.nodeKey && agi.stageKey) {
        contexts.set(agiStageId(node.runId, agi.nodeKey, agi.stageKey), {
          ...controllerContext,
          nodeKey: agi.nodeKey,
          stageKey: agi.stageKey,
        });
      }
      if (agi.nodeKey && agi.stageKey && agi.workerKey) {
        contexts.set(
          agiWorkerId(
            node.runId,
            agi.nodeKey,
            agi.stageKey,
            agi.workerKey,
          ),
          {
            ...controllerContext,
            nodeKey: agi.nodeKey,
            stageKey: agi.stageKey,
            workerKey: agi.workerKey,
          },
        );
      }
    }
  }
  return contexts;
}

function runShouldExpand(
  focus: FocusContext | null,
  runId: string,
  family: FocusContext["family"],
): boolean {
  if (!focus) return true;
  return (
    focus.runId === runId
    && (focus.family === family || focus.family === "run")
  );
}

function stageShouldExpand(
  focus: FocusContext | null,
  runId: string,
  family: FocusContext["family"],
  nodeKey: string,
  stageKey: string,
): boolean {
  if (!runShouldExpand(focus, runId, family)) return false;
  if (!focus) return true;
  if (family === "agi" && focus.nodeKey && focus.nodeKey !== nodeKey) {
    return false;
  }
  return !focus.stageKey || focus.stageKey === stageKey;
}

function lastSourceLabel(
  nodes: readonly SessionFlowNode[],
  fallback: string,
): string {
  return [...nodes].sort(compareNodes).at(-1)?.label || fallback;
}

function addProjectedEdge(
  edges: SessionFlowEdge[],
  seen: Set<string>,
  kind: SessionFlowEdgeKind,
  source: string | null | undefined,
  target: string | null | undefined,
): void {
  if (!source || !target || source === target) return;
  const id = `${kind}:${source}:${target}`;
  if (seen.has(id)) return;
  seen.add(id);
  edges.push({ id, source, target, kind });
}

function rebuildState(
  rawState: SessionFlowState,
  groups: readonly ProjectionGroup[],
  representativeByRawId: ReadonlyMap<string, string>,
  rawById: ReadonlyMap<string, SessionFlowNode>,
): {
  state: SessionFlowState;
  metadataByNodeId: Record<string, SessionFlowHierarchyNodeMeta>;
} {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  for (const group of groups) {
    if (group.parentId) continue;
    let cursor = group.sources[0]?.parentId || null;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const representative = representativeByRawId.get(cursor);
      if (
        representative
        && representative !== group.id
        && groupById.has(representative)
      ) {
        group.parentId = representative;
        break;
      }
      cursor = rawById.get(cursor)?.parentId || null;
    }
  }
  const projectedEdges: SessionFlowEdge[] = [];
  const seenEdges = new Set<string>();

  for (const edge of rawState.edges) {
    addProjectedEdge(
      projectedEdges,
      seenEdges,
      edge.kind,
      representativeByRawId.get(edge.source),
      representativeByRawId.get(edge.target),
    );
  }
  for (const group of groups) {
    addProjectedEdge(
      projectedEdges,
      seenEdges,
      "contains",
      group.parentId,
      group.id,
    );
  }

  const parentByNodeId = new Map<string, string>();
  for (const edge of projectedEdges) {
    if (edge.kind === "contains" && !parentByNodeId.has(edge.target)) {
      parentByNodeId.set(edge.target, edge.source);
    }
  }

  const depthCache = new Map<string, number>();
  function depthFor(id: string, visiting = new Set<string>()): number {
    const cached = depthCache.get(id);
    if (cached != null) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parent = parentByNodeId.get(id);
    const depth = parent && groupById.has(parent)
      ? Math.min(5, depthFor(parent, visiting) + 1)
      : 0;
    depthCache.set(id, depth);
    return depth;
  }

  const projectedNodes = groups
    .map((group): SessionFlowNode => {
      const sortedSources = [...group.sources].sort(compareNodes);
      const firstSource = sortedSources[0];
      const sourceNodeIds = sortedSources.map((source) => source.id);
      const sourceEventTypes = uniqueStrings(
        sortedSources.map((source) => source.eventType),
      );
      const observedSequences = sortedSources
        .map((source) =>
          source.observedSequence === undefined
            ? source.sequence
            : source.observedSequence
        )
        .filter((sequence): sequence is number => sequence !== null);
      const harnessIds = uniqueStrings(
        sortedSources
          .map((source) => source.harnessId || "")
          .filter(Boolean),
      );
      const workflowSource = firstSource && sortedSources.every((source) =>
        source.workflowEventVersion === firstSource.workflowEventVersion
        && source.workflowEventSequence === firstSource.workflowEventSequence
        && source.processId === firstSource.processId
        && source.joinId === firstSource.joinId
        && source.processMember === firstSource.processMember
        && source.processNode === firstSource.processNode)
        ? firstSource
        : undefined;
      return {
        id: group.id,
        runId: group.runId,
        parentId: parentByNodeId.get(group.id) || null,
        kind: group.kind,
        status: aggregateStatus(group.sources),
        label: groupLabel(group),
        detail: groupDetail(group),
        eventType:
          group.category === "standalone" || group.category === "run"
            ? firstSource?.eventType || "run_observed"
            : `hierarchy_${group.category.replaceAll("-", "_")}`,
        sequence: groupSequence(group),
        observedSequence: observedSequences.length
          ? Math.max(...observedSequences)
          : null,
        harnessId: harnessIds.length === 1 ? harnessIds[0] : undefined,
        depth: depthFor(group.id),
        timestamp: groupTimestamp(group),
        scope: group.scope,
        identity: firstSource?.identity,
        ...(workflowSource?.workflowEventVersion == null
          ? {}
          : { workflowEventVersion: workflowSource.workflowEventVersion }),
        ...(workflowSource?.workflowEventSequence == null
          ? {}
          : { workflowEventSequence: workflowSource.workflowEventSequence }),
        ...(workflowSource?.processId
          ? { processId: workflowSource.processId }
          : {}),
        ...(workflowSource?.processLabel
          ? { processLabel: workflowSource.processLabel }
          : {}),
        ...(workflowSource?.branchId
          ? { branchId: workflowSource.branchId }
          : {}),
        ...(workflowSource?.childWorkflowIds
          ? { childWorkflowIds: [...workflowSource.childWorkflowIds] }
          : {}),
        ...(workflowSource?.completedChildWorkflowIds
          ? {
              completedChildWorkflowIds: [
                ...workflowSource.completedChildWorkflowIds,
              ],
            }
          : {}),
        ...(workflowSource?.dependsOnNodeIds
          ? { dependsOnNodeIds: [...workflowSource.dependsOnNodeIds] }
          : {}),
        ...(workflowSource?.joinId ? { joinId: workflowSource.joinId } : {}),
        ...(workflowSource?.expectedNodeIds
          ? {
              expectedNodeIds: [
                ...workflowSource.expectedNodeIds,
              ],
            }
          : {}),
        ...(workflowSource?.completedNodeIds
          ? {
              completedNodeIds: [
                ...workflowSource.completedNodeIds,
              ],
            }
          : {}),
        ...(workflowSource?.workflowAttempt == null
          ? {}
          : { workflowAttempt: workflowSource.workflowAttempt }),
        ...(workflowSource?.workflowPlanFrozen === true
          ? { workflowPlanFrozen: true as const }
          : {}),
        ...(workflowSource?.planDigest
          ? { planDigest: workflowSource.planDigest }
          : {}),
        ...(workflowSource?.outputProcessId
          ? { outputProcessId: workflowSource.outputProcessId }
          : {}),
        ...(workflowSource?.artifactRef
          ? { artifactRef: workflowSource.artifactRef }
          : {}),
        ...(workflowSource?.digest
          ? { digest: workflowSource.digest }
          : {}),
        ...(workflowSource?.processMember === true
          ? { processMember: true }
          : {}),
        ...(workflowSource?.processNode === true
          ? { processNode: true }
          : {}),
        provenance: {
          sourceNodeIds,
          sourceEventTypes,
          hiddenEventCount: Math.max(0, sourceNodeIds.length - 1),
        },
      };
    })
    .sort((left, right) =>
      left.sequence - right.sequence
      || groupCategoryOrder(groupById.get(left.id)?.category || "standalone")
        - groupCategoryOrder(groupById.get(right.id)?.category || "standalone")
      || left.id.localeCompare(right.id)
    );

  const projectedIds = new Set(projectedNodes.map((node) => node.id));
  const edges = projectedEdges
    .filter((edge) =>
      projectedIds.has(edge.source)
      && projectedIds.has(edge.target)
      && edge.source !== edge.target
    )
    .sort((left, right) =>
      left.kind.localeCompare(right.kind)
      || left.source.localeCompare(right.source)
      || left.target.localeCompare(right.target)
    );

  const metadataByNodeId: Record<string, SessionFlowHierarchyNodeMeta> = {};
  for (const node of projectedNodes) {
    const group = groupById.get(node.id);
    if (!group) continue;
    const sourceNodeIds = [...group.sources].sort(compareNodes).map((source) => source.id);
    const hiddenEventCount = Math.max(0, sourceNodeIds.length - 1);
    const sourceEventTypes = uniqueStrings(
      [...group.sources]
        .sort(compareNodes)
        .map((source) => source.eventType),
    );
    metadataByNodeId[node.id] = {
      projectedNodeId: node.id,
      entityKind: entityKindFor(group),
      sourceNodeIds,
      hiddenEventCount,
      childEntityIds: uniqueStrings(group.childEntityIds),
      compound:
        group.compound
        || sourceNodeIds.length > 1
        || group.childEntityIds.length > 0,
      expandable: group.childEntityIds.length > 0,
      drillable: group.childEntityIds.length > 0,
      childFocusNodeId: group.childEntityIds[0] || null,
      statusLookupId: statusLookupIdFor(group),
      hierarchyPath: uniqueStrings(group.hierarchyPath),
      sourceEventTypes,
      summary:
        `${group.baseLabel}: ${eventCountLabel(sourceNodeIds.length)} source, `
        + `${hiddenEventCount} hidden; status ${node.status}.`,
    };
  }

  const runNodeById: Record<string, string> = {};
  const nodeDepthById: Record<string, number> = {};
  const lastNodeByScope: Record<string, string> = {};
  const containerByScope: Record<string, string> = {};
  for (const node of projectedNodes) {
    nodeDepthById[node.id] = node.depth;
    lastNodeByScope[node.scope] = node.id;
    const group = groupById.get(node.id);
    if (group?.category === "run") runNodeById[node.runId] = node.id;
    if (
      group
      && group.category !== "standalone"
      && group.category !== "workflow-result"
      && group.category !== "agi-result"
    ) {
      containerByScope[node.scope] = node.id;
    }
  }

  return {
    state: {
      schemaVersion: 1,
      candidateOnly: true,
      canClaimAGI: false,
      ...(rawState.sessionId ? { sessionId: rawState.sessionId } : {}),
      nodes: projectedNodes,
      edges: edges.sort((left, right) =>
        left.kind.localeCompare(right.kind)
        || left.source.localeCompare(right.source)
        || left.target.localeCompare(right.target)
      ),
      activeRunId: rawState.activeRunId,
      eventCount: rawState.eventCount,
      nextSequence: rawState.nextSequence,
      lastNodeByScope,
      containerByScope,
      runNodeById,
      nodeDepthById,
      seenEventIds: { ...rawState.seenEventIds },
    },
    metadataByNodeId,
  };
}

function breadcrumbLabelFor(
  id: string,
  groups: ReadonlyMap<string, ProjectionGroup>,
): string {
  return groups.get(id)?.baseLabel || id;
}

/**
 * Produce a read-only rendering projection without changing or annotating the
 * raw SessionFlowState. The projection is deterministic for the same input:
 * semantic compound IDs, node order, source order, and edge order are stable.
 */
export function projectSessionFlowHierarchy(
  state: SessionFlowState,
  options: SessionFlowHierarchyOptions,
): SessionFlowHierarchyProjection {
  const level = options.level;
  const rawNodes = [...state.nodes].sort(compareNodes);
  const rawById = new Map(rawNodes.map((node) => [node.id, node]));
  const dynamicByRawId = new Map<string, DynamicNodeInfo>();
  for (const node of rawNodes) {
    const info = dynamicInfoFor(node);
    if (info) dynamicByRawId.set(node.id, info);
  }
  const agiByRawId = buildAGIInfo(rawNodes);
  const knownContexts = makeKnownFocusContexts(
    rawNodes,
    dynamicByRawId,
    agiByRawId,
  );
  const focus = focusFromInputs(
    options.focusNodeId,
    rawById,
    dynamicByRawId,
    agiByRawId,
    knownContexts,
  );

  const groups = new Map<string, ProjectionGroup>();
  const representativeByRawId = new Map<string, string>();
  const runGroupIdByRun = new Map<string, string>();
  const runFirstSequence = new Map<string, number>();
  for (const node of rawNodes) {
    const previous = runFirstSequence.get(node.runId);
    if (previous == null || node.sequence < previous) {
      runFirstSequence.set(node.runId, node.sequence);
    }
    if (node.kind !== "run") continue;
    runGroupIdByRun.set(node.runId, node.id);
    addSource(
      groups,
      {
        id: node.id,
        runId: node.runId,
        category: "run",
        kind: "run",
        baseLabel: node.label,
        scope: node.scope,
        parentId: null,
        childEntityIds: [],
        hierarchyPath: [node.id],
        compound: false,
        syntheticSequence: node.sequence,
      },
      node,
      representativeByRawId,
    );
  }

  for (const runId of uniqueStrings(rawNodes.map((node) => node.runId))) {
    if (runGroupIdByRun.has(runId)) continue;
    const id = hierarchyId("run", runId);
    runGroupIdByRun.set(runId, id);
    addSyntheticGroup(groups, {
      id,
      runId,
      category: "run",
      sources: [],
      kind: "run",
      baseLabel: runId === "session" ? "Session diagnostics" : `Run · ${runId}`,
      scope: `${runId}:main`,
      parentId: null,
      childEntityIds: [],
      hierarchyPath: [id],
      compound: false,
      syntheticSequence: runFirstSequence.get(runId) || 0,
    });
  }

  const dynamicStagesByRun = new Map<string, Set<string>>();
  const dynamicWorkersByStage = new Map<string, Set<string>>();
  for (const info of dynamicByRawId.values()) {
    if (info.category === "stage" || info.category === "worker") {
      const stages = dynamicStagesByRun.get(info.runId) || new Set<string>();
      stages.add(info.stageKey);
      dynamicStagesByRun.set(info.runId, stages);
    }
    if (info.category === "worker") {
      const key = `${info.runId}\u0000${info.stageKey}`;
      const workers = dynamicWorkersByStage.get(key) || new Set<string>();
      workers.add(info.workerKey);
      dynamicWorkersByStage.set(key, workers);
    }
  }

  const agiStagesByNode = new Map<string, Set<string>>();
  const agiWorkersByStage = new Map<string, Set<string>>();
  const agiNodesByRun = new Map<string, Set<string>>();
  for (const info of agiByRawId.values()) {
    if (info.nodeKey) {
      const nodes = agiNodesByRun.get(info.runId) || new Set<string>();
      nodes.add(info.nodeKey);
      agiNodesByRun.set(info.runId, nodes);
    }
    if (
      info.nodeKey
      && (info.category === "stage" || info.category === "worker")
    ) {
      const key = `${info.runId}\u0000${info.nodeKey}`;
      const stages = agiStagesByNode.get(key) || new Set<string>();
      stages.add(info.stageKey);
      agiStagesByNode.set(key, stages);
    }
    if (info.nodeKey && info.category === "worker") {
      const key = `${info.runId}\u0000${info.nodeKey}\u0000${info.stageKey}`;
      const workers = agiWorkersByStage.get(key) || new Set<string>();
      workers.add(info.workerKey);
      agiWorkersByStage.set(key, workers);
    }
  }

  for (const node of rawNodes) {
    const runParent = runGroupIdByRun.get(node.runId) || null;
    if (node.processNode === true || node.processMember === true || node.joinId) {
      const processChildren = node.processNode === true
        ? rawNodes
          .filter((candidate) => candidate.parentId === node.id)
          .map((candidate) => candidate.id)
        : [];
      addSource(
        groups,
        {
          id: node.id,
          runId: node.runId,
          category: "standalone",
          kind: node.kind,
          baseLabel: node.label,
          scope: node.scope,
          parentId:
            node.processMember === true && node.parentId
              ? node.parentId
              : runParent,
          childEntityIds: processChildren,
          hierarchyPath: [
            runParent || "",
            ...(node.processMember === true && node.parentId
              ? [node.parentId]
              : []),
            node.id,
          ],
          compound: node.processNode === true,
          syntheticSequence: node.sequence,
        },
        node,
        representativeByRawId,
      );
      continue;
    }
    const dynamic = dynamicByRawId.get(node.id);
    if (dynamic) {
      const workflowId = dynamicWorkflowId(node.runId);
      const stageIds = [...(dynamicStagesByRun.get(node.runId) || [])]
        .sort()
        .map((stageKey) => dynamicStageId(node.runId, stageKey));
      const expandStages =
        level !== "overview"
        && runShouldExpand(focus, node.runId, "dynamic");

      if (dynamic.category === "synthesis") {
        addSource(
          groups,
          {
            id: dynamicSynthesisId(node.runId),
            runId: node.runId,
            category: "workflow-synthesis",
            kind: "agent",
            baseLabel: "Workflow synthesis",
            scope: `${node.runId}:workflow:synthesis`,
            parentId: workflowId,
            childEntityIds: [],
            hierarchyPath: [runParent || "", workflowId, dynamicSynthesisId(node.runId)],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
        continue;
      }
      if (dynamic.category === "result") {
        addSource(
          groups,
          {
            id: dynamicResultId(node.runId),
            runId: node.runId,
            category: "workflow-result",
            kind: "result",
            baseLabel: lastSourceLabel([node], "Dynamic workflow complete"),
            scope: `${node.runId}:workflow:result`,
            parentId: workflowId,
            childEntityIds: [],
            hierarchyPath: [runParent || "", workflowId, dynamicResultId(node.runId)],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
        continue;
      }

      if (!expandStages) {
        addSource(
          groups,
          {
            id: workflowId,
            runId: node.runId,
            category: "workflow",
            kind: "workflow",
            baseLabel: "Dynamic workflow",
            scope: `${node.runId}:workflow`,
            parentId: runParent,
            childEntityIds: stageIds,
            hierarchyPath: [runParent || "", workflowId],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
        continue;
      }

      if (dynamic.category === "root") {
        addSource(
          groups,
          {
            id: workflowId,
            runId: node.runId,
            category: "workflow",
            kind: "workflow",
            baseLabel: "Dynamic workflow",
            scope: `${node.runId}:workflow`,
            parentId: runParent,
            childEntityIds: [
              dynamicControllerId(node.runId),
              ...stageIds,
              dynamicSynthesisId(node.runId),
              dynamicResultId(node.runId),
            ],
            hierarchyPath: [runParent || "", workflowId],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
        continue;
      }
      if (dynamic.category === "controller") {
        addSource(
          groups,
          {
            id: dynamicControllerId(node.runId),
            runId: node.runId,
            category: "workflow-controller",
            kind: "workflow",
            baseLabel: "Workflow controller",
            scope: `${node.runId}:workflow:controller`,
            parentId: workflowId,
            childEntityIds: [],
            hierarchyPath: [runParent || "", workflowId, dynamicControllerId(node.runId)],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
        continue;
      }

      const stageId = dynamicStageId(node.runId, dynamic.stageKey);
      const workerIds = [
        ...(dynamicWorkersByStage.get(
          `${node.runId}\u0000${dynamic.stageKey}`,
        ) || []),
      ]
        .sort()
        .map((workerKey) =>
          dynamicWorkerId(node.runId, dynamic.stageKey, workerKey)
        );
      const expandWorkers =
        level === "workers"
        && stageShouldExpand(
          focus,
          node.runId,
          "dynamic",
          "",
          dynamic.stageKey,
        );
      if (dynamic.category === "worker" && expandWorkers) {
        addSource(
          groups,
          {
            id: dynamicWorkerId(
              node.runId,
              dynamic.stageKey,
              dynamic.workerKey,
            ),
            runId: node.runId,
            category: "workflow-worker",
            kind: "agent",
            baseLabel:
              `Workflow worker ${readableKey(dynamic.workerKey, "worker")}`,
            scope:
              `${node.runId}:workflow:stage:${dynamic.stageKey}:worker:${dynamic.workerKey}`,
            parentId: stageId,
            childEntityIds: [],
            hierarchyPath: [
              runParent || "",
              workflowId,
              stageId,
              dynamicWorkerId(
                node.runId,
                dynamic.stageKey,
                dynamic.workerKey,
              ),
            ],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
      } else {
        addSource(
          groups,
          {
            id: stageId,
            runId: node.runId,
            category: "workflow-stage",
            kind: "workflow",
            baseLabel:
              `Workflow stage ${readableKey(dynamic.stageKey, "stage")}`,
            scope: `${node.runId}:workflow:stage:${dynamic.stageKey}`,
            parentId: workflowId,
            childEntityIds: workerIds,
            hierarchyPath: [runParent || "", workflowId, stageId],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
      }
      continue;
    }

    const agi = agiByRawId.get(node.id);
    if (agi) {
      const controllerId = agiControllerId(node.runId);
      if (agi.category === "result") {
        addSource(
          groups,
          {
            id: agiResultId(node.runId),
            runId: node.runId,
            category: "agi-result",
            kind: "result",
            baseLabel: lastSourceLabel([node], "AGI workflow complete"),
            scope: `${node.runId}:agi-workflow:result`,
            parentId: controllerId,
            childEntityIds: [],
            hierarchyPath: [runParent || "", controllerId, agiResultId(node.runId)],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
        continue;
      }
      if (!agi.nodeKey) {
        const childNodeIds = [...(agiNodesByRun.get(node.runId) || [])]
          .sort()
          .map((nodeKey) => agiNodeId(node.runId, nodeKey));
        addSource(
          groups,
          {
            id: controllerId,
            runId: node.runId,
            category: "agi-controller",
            kind: "agi",
            baseLabel: "AGI workflow controller",
            scope: `${node.runId}:agi-workflow`,
            parentId: runParent,
            childEntityIds: childNodeIds,
            hierarchyPath: [runParent || "", controllerId],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
        continue;
      }

      const nodeId = agiNodeId(node.runId, agi.nodeKey);
      const stageIds = [
        ...(agiStagesByNode.get(`${node.runId}\u0000${agi.nodeKey}`) || []),
      ]
        .sort()
        .map((stageKey) => agiStageId(node.runId, agi.nodeKey, stageKey));
      const expandStages =
        level !== "overview"
        && runShouldExpand(focus, node.runId, "agi")
        && (!focus?.nodeKey || focus.nodeKey === agi.nodeKey);
      if (!expandStages || agi.category === "node") {
        addSource(
          groups,
          {
            id: nodeId,
            runId: node.runId,
            category: "agi-node",
            kind: "agi",
            baseLabel:
              `AGI node · ${phaseLabel([node]) || readableKey(agi.nodeKey, "node")}`,
            scope: `${node.runId}:agi-workflow:node:${agi.nodeKey}`,
            parentId: controllerId,
            childEntityIds: stageIds,
            hierarchyPath: [runParent || "", controllerId, nodeId],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
        continue;
      }

      const stageId = agiStageId(node.runId, agi.nodeKey, agi.stageKey);
      const workerIds = [
        ...(agiWorkersByStage.get(
          `${node.runId}\u0000${agi.nodeKey}\u0000${agi.stageKey}`,
        ) || []),
      ]
        .sort()
        .map((workerKey) =>
          agiWorkerId(node.runId, agi.nodeKey, agi.stageKey, workerKey)
        );
      const expandWorkers =
        level === "workers"
        && stageShouldExpand(
          focus,
          node.runId,
          "agi",
          agi.nodeKey,
          agi.stageKey,
        );
      if (agi.category === "worker" && expandWorkers) {
        addSource(
          groups,
          {
            id: agiWorkerId(
              node.runId,
              agi.nodeKey,
              agi.stageKey,
              agi.workerKey,
            ),
            runId: node.runId,
            category: "agi-worker",
            kind: "agent",
            baseLabel: `AGI worker ${readableKey(agi.workerKey, "worker")}`,
            scope:
              `${node.runId}:agi-workflow:node:${agi.nodeKey}:stage:${agi.stageKey}:worker:${agi.workerKey}`,
            parentId: stageId,
            childEntityIds: [],
            hierarchyPath: [
              runParent || "",
              controllerId,
              nodeId,
              stageId,
              agiWorkerId(
                node.runId,
                agi.nodeKey,
                agi.stageKey,
                agi.workerKey,
              ),
            ],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
      } else {
        addSource(
          groups,
          {
            id: stageId,
            runId: node.runId,
            category: "agi-stage",
            kind: "workflow",
            baseLabel: `AGI stage ${readableKey(agi.stageKey, "stage")}`,
            scope:
              `${node.runId}:agi-workflow:node:${agi.nodeKey}:stage:${agi.stageKey}`,
            parentId: nodeId,
            childEntityIds: workerIds,
            hierarchyPath: [runParent || "", controllerId, nodeId, stageId],
            compound: true,
            syntheticSequence: node.sequence,
          },
          node,
          representativeByRawId,
        );
      }
      continue;
    }

    if (node.kind === "run") continue;
    if (!shouldPreserveStandalone(node)) continue;
    addSource(
      groups,
      {
        id: node.id,
        runId: node.runId,
        category: "standalone",
        kind: node.kind,
        baseLabel: node.label,
        scope: node.scope,
        parentId: null,
        childEntityIds: [],
        hierarchyPath: [runParent || "", node.id],
        compound: false,
        syntheticSequence: node.sequence,
      },
      node,
      representativeByRawId,
    );
  }

  // Every omitted minor event still needs a representative so its raw edges
  // can be projected. Prefer its nearest visible ancestor, then the run root.
  for (const node of rawNodes) {
    if (representativeByRawId.has(node.id)) continue;
    let cursor = node.parentId;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const representative = representativeByRawId.get(cursor);
      if (representative) {
        representativeByRawId.set(node.id, representative);
        break;
      }
      cursor = rawById.get(cursor)?.parentId || null;
    }
    if (!representativeByRawId.has(node.id)) {
      const runId = runGroupIdByRun.get(node.runId);
      if (runId) representativeByRawId.set(node.id, runId);
    }
    const representative = representativeByRawId.get(node.id);
    const group = representative ? groups.get(representative) : undefined;
    if (group && !group.sources.some((source) => source.id === node.id)) {
      group.sources.push(node);
    }
  }

  const orderedGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      sources: [...group.sources].sort(compareNodes),
      childEntityIds: uniqueStrings(group.childEntityIds),
      hierarchyPath: uniqueStrings(group.hierarchyPath),
    }))
    .sort((left, right) =>
      groupSequence(left) - groupSequence(right)
      || groupCategoryOrder(left.category) - groupCategoryOrder(right.category)
      || left.id.localeCompare(right.id)
    );
  const rebuilt = rebuildState(
    state,
    orderedGroups,
    representativeByRawId,
    rawById,
  );
  const groupById = new Map(orderedGroups.map((group) => [group.id, group]));

  let normalizedFocusNodeId: string | null = null;
  if (options.focusNodeId) {
    if (groupById.has(options.focusNodeId)) {
      normalizedFocusNodeId = options.focusNodeId;
    } else {
      normalizedFocusNodeId =
        representativeByRawId.get(options.focusNodeId) || null;
    }
  }

  const breadcrumbs: SessionFlowHierarchyBreadcrumb[] = [
    {
      id: hierarchyId("overview"),
      label: "All runs",
      level: "overview",
      focusNodeId: null,
    },
  ];
  if (level !== "overview" && focus) {
    const workflowFocusId =
      focus.family === "agi"
        ? focus.nodeKey
          ? agiNodeId(focus.runId, focus.nodeKey)
          : agiControllerId(focus.runId)
        : dynamicWorkflowId(focus.runId);
    breadcrumbs.push({
      id: workflowFocusId,
      label: breadcrumbLabelFor(workflowFocusId, groupById),
      level: "stages",
      focusNodeId: workflowFocusId,
    });
    if (level === "workers" && focus.stageKey) {
      const stageFocusId =
        focus.family === "agi" && focus.nodeKey
          ? agiStageId(focus.runId, focus.nodeKey, focus.stageKey)
          : dynamicStageId(focus.runId, focus.stageKey);
      breadcrumbs.push({
        id: stageFocusId,
        label: breadcrumbLabelFor(stageFocusId, groupById),
        level: "workers",
        focusNodeId: stageFocusId,
      });
    }
  }

  return {
    state: rebuilt.state,
    projectedState: rebuilt.state,
    metadataByNodeId: rebuilt.metadataByNodeId,
    level,
    focusNodeId: normalizedFocusNodeId,
    breadcrumbs,
  };
}
