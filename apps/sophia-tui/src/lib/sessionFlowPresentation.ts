import type { AGIWorkflowState } from "./agiWorkflowState.js";
import type { DynamicWorkflowState } from "./dynamicWorkflowState.js";
import {
  projectSessionFlowHierarchy,
  type SessionFlowHierarchyOptions,
  type SessionFlowHierarchyProjection,
} from "./sessionFlowHierarchy.js";
import { projectSessionFlowMajorOverview } from "./sessionFlowMajor.js";
import {
  agiWorkflowCompoundStatus,
  dynamicWorkflowCompoundStatus,
  selectAGIWorkflowStageStatuses,
  selectAGIWorkflowWorkerStatuses,
  selectDynamicWorkflowStageStatuses,
  selectDynamicWorkflowWorkerStatuses,
  type SessionFlowCompoundStatus,
  type SessionFlowStageStatus,
  type SessionFlowWorkerStatus,
} from "./sessionFlowLiveStatus.js";
import type { SessionFlowNode, SessionFlowState } from "./sessionFlow.js";

export type SessionFlowLiveNodeStatus =
  | SessionFlowCompoundStatus
  | SessionFlowStageStatus
  | SessionFlowWorkerStatus;

export interface SessionFlowPresentation extends SessionFlowHierarchyProjection {
  rawState: SessionFlowState;
  liveStatusByNodeId: Record<string, SessionFlowLiveNodeStatus>;
}

function statusDetail(status: SessionFlowLiveNodeStatus): string {
  if ("latestActor" in status && status.latestActor && status.latestActivity) {
    return `${status.latestActor} · ${status.latestActivity}`;
  }
  return status.detailLines.slice(0, 2).join(" · ");
}

function enrichedNode(
  node: SessionFlowNode,
  live: SessionFlowLiveNodeStatus | undefined,
): SessionFlowNode {
  if (!live) return node;
  // The parallel overview has semantic labels that are more specific than
  // the generic live-status title (for example, "Barrier · Stage 2" versus
  // "Stage 2"). Keep those operator-facing roles stable while still updating
  // the progress event/detail from the live controller.
  const preserveParallelRole =
    node.eventType === "parallel_barrier"
    || node.eventType === "parallel_critic_review"
    || node.eventType === "parallel_recovery"
    || node.eventType === "parallel_synthesis"
    || node.eventType === "parallel_lane"
    || node.eventType === "parallel_lane_process";
  const preserveParallelDetail =
    node.eventType === "parallel_barrier"
    || node.eventType === "parallel_critic_review"
    || node.eventType === "parallel_recovery"
    || node.eventType === "parallel_synthesis";
  return {
    ...node,
    status: live.status,
    label: preserveParallelRole
      ? node.label
      : (("title" in live ? live.title : live.label) || node.label),
    eventType:
      live.progressLabel
      || ("phase" in live ? live.phase : "")
      || node.eventType,
    detail: preserveParallelDetail
      ? node.detail
      : statusDetail(live) || node.detail,
  };
}

function workflowStageKey(scope: string): string {
  return /:workflow:stage:([^:]+)/i.exec(scope)?.[1] || "";
}

function workflowWorkerKey(scope: string): string {
  return /:workflow:stage:[^:]+:worker:([^:]+)/i.exec(scope)?.[1] || "";
}

function agiStageKey(scope: string): string {
  return /:agi-workflow:node:[^:]+:stage:([^:]+)/i.exec(scope)?.[1] || "";
}

function agiWorkerKey(scope: string): string {
  return /:agi-workflow:node:[^:]+:stage:[^:]+:worker:([^:]+)/i.exec(scope)?.[1]
    || "";
}

function agiNodeKey(scope: string): string {
  return /:agi-workflow:node:([^:]+)/i.exec(scope)?.[1] || "";
}

function comparable(value: string): string {
  return decodeURIComponent(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function sameKey(left: string, right: string): boolean {
  const a = comparable(left);
  const b = comparable(right);
  return Boolean(a && b && (a === b || a.endsWith(b) || b.endsWith(a)));
}

function findDynamicStage(
  statuses: readonly SessionFlowStageStatus[],
  lookupId: string | null,
  scope: string,
): SessionFlowStageStatus | undefined {
  if (lookupId) {
    const exact = statuses.find((status) => status.id === lookupId);
    return exact;
  }
  const stageKey = workflowStageKey(scope);
  return statuses.find(
    (status) =>
      sameKey(String(status.index), stageKey)
      || sameKey(status.id.split(":").at(-1) || "", stageKey),
  );
}

function findDynamicWorker(
  statuses: readonly SessionFlowWorkerStatus[],
  lookupId: string | null,
  scope: string,
): SessionFlowWorkerStatus | undefined {
  if (lookupId) {
    const exact = statuses.find(
      (status) =>
        status.id === lookupId
        || status.id.startsWith(`${lookupId}:`),
    );
    if (exact) return exact;
  }
  const stageKey = workflowStageKey(scope);
  const workerKey = workflowWorkerKey(scope);
  const stageCandidates = statuses.filter(
    (status) => !stageKey || sameKey(String(status.stageIndex), stageKey),
  );
  const keyed = stageCandidates.find(
    (status) =>
      sameKey(status.id.split(":")[3] || "", workerKey)
      || sameKey(status.id.split(":").at(-1) || "", workerKey)
      || sameKey(status.label, workerKey),
  );
  return keyed ?? (stageCandidates.length === 1 ? stageCandidates[0] : undefined);
}

function findAGIStage(
  statuses: readonly SessionFlowStageStatus[],
  lookupId: string | null,
  scope: string,
): SessionFlowStageStatus | undefined {
  if (lookupId) {
    return statuses.find((status) => status.id === lookupId);
  }
  const stageKey = agiStageKey(scope);
  return statuses.find(
    (status) =>
      sameKey(String(status.index), stageKey)
      || sameKey(status.id.split(":").at(-1) || "", stageKey),
  );
}

function findAGIWorker(
  statuses: readonly SessionFlowWorkerStatus[],
  lookupId: string | null,
  scope: string,
): SessionFlowWorkerStatus | undefined {
  if (lookupId) {
    const exact = statuses.find((status) => status.id === lookupId);
    return exact;
  }
  const workerKey = agiWorkerKey(scope);
  return statuses.find(
    (status) =>
      sameKey(status.id.split(":").at(-1) || "", workerKey)
      || sameKey(status.label, workerKey),
  );
}

/**
 * Build the graph operators see while keeping the immutable raw event graph
 * available for audit inspection and full Draw.io export.
 */
export function presentSessionFlowHierarchy(
  rawState: SessionFlowState,
  options: SessionFlowHierarchyOptions,
  dynamicWorkflow: DynamicWorkflowState,
  agiWorkflow: AGIWorkflowState,
): SessionFlowPresentation {
  const hierarchy = projectSessionFlowHierarchy(rawState, options);
  const projection =
    options.level === "overview"
      ? projectSessionFlowMajorOverview(rawState, hierarchy, dynamicWorkflow)
      : hierarchy;
  const dynamicCompound = dynamicWorkflowCompoundStatus(dynamicWorkflow);
  const dynamicStages = selectDynamicWorkflowStageStatuses(dynamicWorkflow);
  const dynamicWorkers = selectDynamicWorkflowWorkerStatuses(dynamicWorkflow);
  const agiCompound = agiWorkflowCompoundStatus(agiWorkflow);
  const agiStages = selectAGIWorkflowStageStatuses(agiWorkflow);
  const agiWorkers = selectAGIWorkflowWorkerStatuses(agiWorkflow);
  const liveStatusByNodeId: Record<string, SessionFlowLiveNodeStatus> = {};

  for (const node of projection.state.nodes) {
    const meta = projection.metadataByNodeId[node.id];
    if (!meta) continue;
    const dynamicRun =
      Boolean(dynamicWorkflow.runId)
      && node.runId === dynamicWorkflow.runId;
    const agiRun =
      Boolean(agiWorkflow.runId)
      && node.runId === agiWorkflow.runId;
    let live: SessionFlowLiveNodeStatus | undefined;

    if (
      dynamicRun
      && meta.entityKind === "workflow"
      && /:workflow$/i.test(node.scope)
    ) {
      live = dynamicCompound;
    } else if (
      (/:agi-workflow:/i.test(node.scope) ? agiRun : dynamicRun)
      && meta.entityKind === "stage"
    ) {
      live = /:agi-workflow:/i.test(node.scope)
        ? findAGIStage(agiStages, meta.statusLookupId, node.scope)
        : findDynamicStage(dynamicStages, meta.statusLookupId, node.scope);
    } else if (
      (/:agi-workflow:/i.test(node.scope) ? agiRun : dynamicRun)
      && meta.entityKind === "worker"
    ) {
      live = /:agi-workflow:/i.test(node.scope)
        ? findAGIWorker(agiWorkers, meta.statusLookupId, node.scope)
        : findDynamicWorker(dynamicWorkers, meta.statusLookupId, node.scope);
    } else if (agiRun && meta.entityKind === "agi-controller") {
      live = agiCompound;
    } else if (
      agiRun
      && meta.entityKind === "agi-node"
      && agiWorkflow.currentNode
      && sameKey(agiNodeKey(node.scope), agiWorkflow.currentNode.id)
    ) {
      live = agiCompound;
    }

    if (live) liveStatusByNodeId[node.id] = live;
  }

  const state: SessionFlowState = {
    ...projection.state,
    nodes: projection.state.nodes.map((node) =>
      enrichedNode(node, liveStatusByNodeId[node.id])
    ),
  };
  return {
    ...projection,
    state,
    projectedState: state,
    rawState,
    liveStatusByNodeId,
  };
}
