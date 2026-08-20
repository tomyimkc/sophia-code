import type {
  SessionFlowEdge,
  SessionFlowNode,
  SessionFlowNodeStatus,
  SessionFlowState,
} from "./sessionFlow.js";
import type {
  DynamicWorkflowAgent,
  DynamicWorkflowStage,
  DynamicWorkflowState,
} from "./dynamicWorkflowState.js";
import { compoundWorkflowOutputAuthorized } from "./sessionFlow.js";
import type {
  SessionFlowHierarchyNodeMeta,
  SessionFlowHierarchyProjection,
} from "./sessionFlowHierarchy.js";

const ADVERSE_STATUSES = new Set<SessionFlowNodeStatus>([
  "running",
  "blocked",
  "failed",
  "cancelled",
]);

function compareNodes(left: SessionFlowNode, right: SessionFlowNode): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeSegment(value: string): string {
  return encodeURIComponent(value || "unknown");
}

function majorId(
  runId: string,
  role: "harness" | "main" | "workflow" | "output" | "agi",
): string {
  return `session-flow-major:${safeSegment(runId)}:${role}`;
}

function semanticProcessId(runId: string, processId: string): string {
  return `workflow-process:${safeSegment(runId)}:${safeSegment(processId)}`;
}

function compoundAdverseStatus(
  nodes: readonly SessionFlowNode[],
): SessionFlowNodeStatus | null {
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.some((node) => node.status === "cancelled")) return "cancelled";
  return null;
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
    || /(^|_)(result|receipt|end|finish|complete)(ed)?$/.test(node.eventType)
  );
}

function aggregateStatus(
  sources: readonly SessionFlowNode[],
  fallback: SessionFlowNodeStatus = "pending",
): SessionFlowNodeStatus {
  const nodes = [...sources].sort(compareNodes);
  if (nodes.length === 0) return fallback;
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
      statusRank(node.status) > statusRank(current) ? node.status : current,
    fallback,
  );
}

function sourceEventTypes(sources: readonly SessionFlowNode[]): string[] {
  return uniqueStrings([...sources].sort(compareNodes).map((node) => node.eventType));
}

function sourceIds(sources: readonly SessionFlowNode[]): string[] {
  return [...sources].sort(compareNodes).map((node) => node.id);
}

function latestDetail(sources: readonly SessionFlowNode[], fallback: string): string {
  return (
    [...sources]
      .sort(compareNodes)
      .reverse()
      .map((node) => node.detail.trim())
      .find(Boolean)
    || fallback
  );
}

function latestTimestamp(sources: readonly SessionFlowNode[]): string {
  return [...sources].sort(compareNodes).at(-1)?.timestamp || "";
}

function earliestSequence(
  sources: readonly SessionFlowNode[],
  fallback: number,
): number {
  return sources.length
    ? Math.min(...sources.map((node) => node.sequence))
    : fallback;
}

function latestSequence(sources: readonly SessionFlowNode[]): number | null {
  return sources.length
    ? Math.max(...sources.map((node) => node.sequence))
    : null;
}

function outputSource(node: SessionFlowNode): boolean {
  return (
    node.kind === "result"
    || node.kind === "receipt"
    || node.eventType === "result"
    || node.eventType === "final"
    || node.eventType === "assistant_message"
    || node.eventType === "run_finished"
    || node.eventType === "dynamic_workflow_end"
  );
}

function mainSource(node: SessionFlowNode): boolean {
  return (
    node.kind === "run"
    || node.kind === "goal"
    || node.kind === "harness"
    || node.eventType === "run_start"
  );
}

function nodeProvenance(sources: readonly SessionFlowNode[]) {
  const ids = sourceIds(sources);
  return {
    sourceNodeIds: ids,
    sourceEventTypes: sourceEventTypes(sources),
    hiddenEventCount: Math.max(0, ids.length - 1),
  };
}

function metaFor(
  node: SessionFlowNode,
  entityKind: SessionFlowHierarchyNodeMeta["entityKind"],
  sources: readonly SessionFlowNode[],
  options: {
    childEntityIds?: string[];
    childFocusNodeId?: string | null;
    statusLookupId?: string | null;
    hierarchyPath?: string[];
    summary: string;
    drillable?: boolean;
  },
): SessionFlowHierarchyNodeMeta {
  const ids = sourceIds(sources);
  const childEntityIds = uniqueStrings(options.childEntityIds || []);
  const drillable = options.drillable ?? childEntityIds.length > 0;
  return {
    projectedNodeId: node.id,
    entityKind,
    sourceNodeIds: ids,
    hiddenEventCount: Math.max(0, ids.length - 1),
    childEntityIds,
    compound: ids.length > 1 || childEntityIds.length > 0,
    expandable: drillable,
    drillable,
    childFocusNodeId: options.childFocusNodeId || null,
    statusLookupId: options.statusLookupId || null,
    hierarchyPath: uniqueStrings(options.hierarchyPath || [node.id]),
    sourceEventTypes: sourceEventTypes(sources),
    summary: options.summary,
  };
}

function edge(
  source: string,
  target: string,
  runId: string,
  meaning: string,
): SessionFlowEdge {
  return {
    id:
      `major:sequence:${safeSegment(runId)}:${safeSegment(meaning)}:`
      + `${safeSegment(source)}:${safeSegment(target)}`,
    source,
    target,
    kind: "sequence",
  };
}

function runOrder(rawState: SessionFlowState): string[] {
  const byRun = new Map<string, number>();
  for (const node of rawState.nodes) {
    if (!node.runId || node.runId === "session") continue;
    const existing = byRun.get(node.runId);
    if (existing === undefined || node.sequence < existing) {
      byRun.set(node.runId, node.sequence);
    }
  }
  return [...byRun.entries()]
    .sort(([leftId, left], [rightId, right]) =>
      left - right || leftId.localeCompare(rightId)
    )
    .map(([runId]) => runId);
}

function normalRunProjection(
  rawState: SessionFlowState,
  hierarchy: SessionFlowHierarchyProjection,
  runId: string,
): {
  nodes: SessionFlowNode[];
  edges: SessionFlowEdge[];
  metadata: Record<string, SessionFlowHierarchyNodeMeta>;
  firstId: string;
  lastId: string;
} {
  const runSources = rawState.nodes.filter((node) => node.runId === runId);
  const mainSources = runSources.filter(mainSource);
  const outputSources = runSources.filter(outputSource);
  const workflowSources = runSources.filter(
    (node) => !mainSource(node) && !outputSource(node),
  );
  const detailedWorkflow = hierarchy.state.nodes.find(
    (node) =>
      node.runId === runId
      && hierarchy.metadataByNodeId[node.id]?.entityKind === "workflow"
      && /:workflow$/i.test(node.scope),
  );
  // Receipt arrival order is provenance, not causal topology. Keep the three
  // harness roles in their semantic order even when late workflow telemetry is
  // recorded after a terminal output receipt.
  const sequenceBase = earliestSequence(runSources, rawState.nextSequence);
  const harnessId = majorId(runId, "harness");
  const mainId = majorId(runId, "main");
  const workflowId = detailedWorkflow?.id || majorId(runId, "workflow");
  const outputId = majorId(runId, "output");
  const runTerminal = runSources.some((node) =>
    node.eventType === "run_finished"
    || node.eventType === "result"
  );
  const main = {
    id: mainId,
    runId,
    parentId: null,
    kind: "run" as const,
    status: aggregateStatus(
      mainSources,
      rawState.activeRunId === runId ? "running" : "pending",
    ),
    label: "Main Agent",
    detail: latestDetail(
      mainSources,
      rawState.activeRunId === runId ? "active session request" : "session request",
    ),
    eventType: "major_main_agent",
    sequence: sequenceBase,
    observedSequence: latestSequence(mainSources),
    harnessId,
    depth: 0,
    timestamp: latestTimestamp(mainSources.length ? mainSources : runSources),
    scope: `${runId}:main-agent`,
    provenance: nodeProvenance(mainSources),
  } satisfies SessionFlowNode;
  const workflow = {
    id: workflowId,
    runId,
    parentId: null,
    kind: "workflow" as const,
    status: aggregateStatus(
      workflowSources,
      runTerminal
        ? "succeeded"
        : rawState.activeRunId === runId
          ? "running"
          : "pending",
    ),
    label: "Workflow",
    detail: latestDetail(
      workflowSources,
      workflowSources.length
        ? `${workflowSources.length} workflow events`
        : "main-agent execution",
    ),
    eventType: "major_workflow",
    sequence: sequenceBase + 0.25,
    observedSequence: latestSequence(workflowSources),
    harnessId,
    depth: 0,
    timestamp: latestTimestamp(workflowSources.length ? workflowSources : runSources),
    scope: `${runId}:workflow`,
    provenance: nodeProvenance(workflowSources),
  } satisfies SessionFlowNode;
  const output = {
    id: outputId,
    runId,
    parentId: null,
    kind: "result" as const,
    status: aggregateStatus(
      outputSources,
      "pending",
    ),
    label: "Output",
    detail: latestDetail(
      outputSources,
      rawState.activeRunId === runId ? "waiting for output" : "no output receipt",
    ),
    eventType: "major_output",
    sequence: sequenceBase + 0.5,
    observedSequence: latestSequence(outputSources),
    harnessId,
    depth: 0,
    timestamp: latestTimestamp(outputSources.length ? outputSources : runSources),
    scope: `${runId}:output`,
    provenance: nodeProvenance(outputSources),
  } satisfies SessionFlowNode;
  const detailedMeta = detailedWorkflow
    ? hierarchy.metadataByNodeId[detailedWorkflow.id]
    : undefined;
  return {
    nodes: [main, workflow, output],
    edges: [
      edge(main.id, workflow.id, runId, "main-to-workflow"),
      edge(workflow.id, output.id, runId, "workflow-to-output"),
    ],
    metadata: {
      [main.id]: metaFor(main, "main-agent", mainSources, {
        hierarchyPath: [harnessId, main.id],
        summary:
          `Merged run harness ${runId}: Main Agent → Workflow → Output; `
          + `Main Agent: ${mainSources.length} source event`
          + `${mainSources.length === 1 ? "" : "s"}; status ${main.status}.`,
      }),
      [workflow.id]: metaFor(workflow, "workflow", workflowSources, {
        childEntityIds: detailedMeta?.childEntityIds,
        childFocusNodeId: detailedMeta?.childFocusNodeId,
        statusLookupId: detailedMeta?.statusLookupId,
        hierarchyPath: [harnessId, workflow.id],
        drillable: detailedMeta?.drillable,
        summary:
          `Merged run harness ${runId}: Main Agent → Workflow → Output; `
          + `Workflow: ${workflowSources.length} source event`
          + `${workflowSources.length === 1 ? "" : "s"} folded into one block; `
          + `status ${workflow.status}.`,
      }),
      [output.id]: metaFor(output, "output", outputSources, {
        hierarchyPath: [harnessId, output.id],
        summary:
          `Merged run harness ${runId}: Main Agent → Workflow → Output; `
          + `Output: ${outputSources.length} terminal receipt`
          + `${outputSources.length === 1 ? "" : "s"}; status ${output.status}.`,
      }),
    },
    firstId: main.id,
    lastId: output.id,
  };
}

function dynamicMajorId(
  runId: string,
  role: string,
): string {
  return `session-flow-parallel:${safeSegment(runId)}:${safeSegment(role)}`;
}

function dynamicAgentStatus(
  agent: DynamicWorkflowAgent,
): SessionFlowNodeStatus {
  switch (agent.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
    case "timed_out":
    case "lost":
    case "needs_reconciliation":
    case "unstarted":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "queued":
    case "queued_for_model":
      return "pending";
    default:
      return "running";
  }
}

function dynamicSourceNodes(
  rawState: SessionFlowState,
  runId: string,
  predicate: (node: SessionFlowNode) => boolean,
): SessionFlowNode[] {
  return rawState.nodes.filter(
    (node) => node.runId === runId && predicate(node),
  );
}

function dynamicStageSources(
  rawState: SessionFlowState,
  runId: string,
  stageIndex: number,
): SessionFlowNode[] {
  const stageKey = String(stageIndex);
  const stageScope = `${runId}:workflow:stage:${stageKey}`;
  return dynamicSourceNodes(rawState, runId, (node) =>
    node.identity?.stageKey === stageKey
    || node.scope === stageScope
    || node.scope.startsWith(`${stageScope}:worker:`)
  );
}

function dynamicWorkerSources(
  rawState: SessionFlowState,
  runId: string,
  stageIndex: number,
  agent: DynamicWorkflowAgent,
): SessionFlowNode[] {
  const stageKey = String(stageIndex);
  const workerKey = String(agent.index);
  return dynamicSourceNodes(rawState, runId, (node) =>
    node.identity?.stageKey === stageKey
    && (
      node.identity?.workerIndex === workerKey
      || node.identity?.workerKey === workerKey
      || node.scope.endsWith(`:worker:${workerKey}`)
    )
  );
}

function dynamicRunStatus(
  workflow: DynamicWorkflowState,
): SessionFlowNodeStatus {
  switch (workflow.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "routing":
    case "running":
    case "reviewing":
    case "synthesizing":
      return "running";
    case "skipped":
      return "blocked";
    default:
      return workflow.active ? "running" : "pending";
  }
}

function dynamicBarrierStatus(
  stage: DynamicWorkflowStage,
  agents: readonly DynamicWorkflowAgent[],
): SessionFlowNodeStatus {
  const statuses = agents.map(dynamicAgentStatus);
  if (stage.status === "failed" || statuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (statuses.some((status) => status === "cancelled")) return "cancelled";
  if (stage.status === "succeeded" || (
    statuses.length > 0
    && statuses.every((status) => status === "succeeded")
  )) {
    return "succeeded";
  }
  if (stage.status === "running" || statuses.some((status) => status === "running")) {
    return "running";
  }
  return "pending";
}

function dynamicReviewStatus(
  workflow: DynamicWorkflowState,
  stage: DynamicWorkflowStage,
): SessionFlowNodeStatus {
  if (stage.status === "failed") return "failed";
  if (
    workflow.status === "reviewing"
    && workflow.currentStage === stage.index
  ) {
    return "running";
  }
  if (
    stage.status === "succeeded"
    && (
      workflow.status === "synthesizing"
      || workflow.status === "succeeded"
      || workflow.currentStage > stage.index
    )
  ) {
    return "succeeded";
  }
  return "pending";
}

/**
 * Fast fan-out overview for the bounded TUI parallel template:
 *
 *   Main Agent · Plan & Dispatch
 *       ↓
 *   every declared specialist lane
 *       ↓
 *   Barrier · Stage N
 *       ↓
 *   Synthesis · Main Agent
 *       ↓
 *   Output · Receipt
 *
 * The projection still does not invent critic lanes or review blocks. It does
 * mint the all-of barrier so a silent/never-started lane cannot look like a
 * clean fan-in on the operator overview.
 */
function dynamicFanoutProjection(
  rawState: SessionFlowState,
  runId: string,
  workflow: DynamicWorkflowState,
): {
  nodes: SessionFlowNode[];
  edges: SessionFlowEdge[];
  metadata: Record<string, SessionFlowHierarchyNodeMeta>;
  firstId: string;
  lastId: string;
} {
  const runSources = rawState.nodes.filter((node) => node.runId === runId);
  const mainSources = runSources.filter((node) =>
    node.eventType === "run_start"
    || node.eventType === "dynamic_workflow_route"
    || node.eventType === "dynamic_workflow_start"
    || node.eventType === "dynamic_workflow_controller_start"
    || node.eventType === "dynamic_workflow_controller_end"
  );
  const outputSources = runSources.filter((node) =>
    node.eventType === "dynamic_workflow_end"
    || node.eventType === "run_finished"
    || node.eventType === "result"
    || node.eventType === "final"
  );
  const firstSequence = earliestSequence(runSources, rawState.nextSequence);
  const mainId = dynamicMajorId(runId, "main");
  const main = {
    id: mainId,
    runId,
    parentId: null,
    kind: "run" as const,
    status: dynamicRunStatus(workflow),
    label: "Main Agent · Plan & Dispatch",
    detail:
      "Fan out every declared specialist lane, then synthesize once"
      + (workflow.reason ? ` · ${workflow.reason}` : ""),
    eventType: "parallel_main_agent",
    sequence: firstSequence,
    observedSequence: latestSequence(mainSources),
    harnessId: dynamicMajorId(runId, "harness"),
    depth: 0,
    timestamp: latestTimestamp(mainSources.length ? mainSources : runSources),
    scope: `${runId}:main`,
    provenance: nodeProvenance(mainSources),
  } satisfies SessionFlowNode;

  const nodes: SessionFlowNode[] = [main];
  const edges: SessionFlowEdge[] = [];
  const metadata: Record<string, SessionFlowHierarchyNodeMeta> = {
    [main.id]: metaFor(main, "main-agent", mainSources, {
      hierarchyPath: [main.harnessId!, main.id],
      summary:
        `Fast parallel workflow ${runId}: every declared lane fans out `
        + "from Main, waits at the stage barrier, then synthesizes.",
    }),
  };
  const processIds: string[] = [];
  const orderedStages = [...workflow.stages].sort(
    (left, right) => left.index - right.index,
  );
  let latestSequenceValue = firstSequence;
  let previousBarrierId: string | null = null;

  for (const stage of orderedStages) {
    const stageSources = dynamicStageSources(rawState, runId, stage.index);
    const stageSequence = earliestSequence(
      stageSources,
      firstSequence + stage.index,
    );
    latestSequenceValue = Math.max(latestSequenceValue, stageSequence);
    const agents = stage.agents.length
      ? stage.agents
      : [{
          name: `Stage ${stage.index} controller`,
          index: 0,
          status: stage.status === "failed" ? "failed" : "unstarted",
          active: false,
          role: "lane inventory",
          skills: [],
          summary: stage.goal || "No worker inventory was reported",
          failureReason: stage.status === "failed"
            ? "stage failed without a worker inventory"
            : "worker inventory missing",
        } satisfies DynamicWorkflowAgent];
    const stageProcessIds: string[] = [];
    const completedProcessIds: string[] = [];

    for (const agent of agents) {
      const status = dynamicAgentStatus(agent);
      const processId = dynamicMajorId(
        runId,
        `stage-${stage.index}-lane-${agent.index}`,
      );
      const memberId = `${processId}:lane`;
      const sources = dynamicWorkerSources(rawState, runId, stage.index, agent);
      const sequence = stageSequence + 0.1 + agent.index / 1000;
      const label = agent.name || `Stage ${stage.index} lane ${agent.index + 1}`;
      const detail = [
        agent.role,
        agent.summary || agent.progress,
        agent.failureReason,
      ].filter(Boolean).join(" · ") || "parallel specialist lane";
      const identity = {
        stageKey: String(stage.index),
        workerKey: String(agent.index),
        workerIndex: String(agent.index),
        agentName: label,
      };
      const process = {
        id: processId,
        runId,
        parentId: null,
        kind: "workflow" as const,
        status,
        label: `Stage ${stage.index} · ${label}`,
        detail,
        eventType: "parallel_lane_process",
        sequence,
        observedSequence: latestSequence(sources),
        harnessId: main.harnessId,
        depth: 0,
        timestamp: latestTimestamp(sources) || latestTimestamp(stageSources),
        scope: `${runId}:workflow:stage:${stage.index}:worker:${agent.index}`,
        identity,
        processId,
        processLabel: `Stage ${stage.index} · ${label}`,
        branchId: `stage-${stage.index}`,
        processNode: true as const,
        provenance: nodeProvenance(sources),
      } satisfies SessionFlowNode;
      const member = {
        id: memberId,
        runId,
        parentId: processId,
        kind: "agent" as const,
        status,
        label,
        detail,
        eventType: "parallel_lane",
        sequence: sequence + 0.001,
        observedSequence: latestSequence(sources),
        harnessId: main.harnessId,
        depth: 1,
        timestamp: latestTimestamp(sources) || process.timestamp,
        scope: process.scope,
        identity,
        processId,
        processLabel: process.processLabel,
        branchId: process.branchId,
        processMember: true as const,
        provenance: nodeProvenance(sources),
      } satisfies SessionFlowNode;
      nodes.push(process, member);
      processIds.push(processId);
      stageProcessIds.push(processId);
      if (status === "succeeded") completedProcessIds.push(processId);
      metadata[process.id] = metaFor(process, "worker", sources, {
        hierarchyPath: [main.harnessId!, process.id],
        summary: `Parallel lane ${label}; ${detail}; status ${status}.`,
      });
      metadata[member.id] = metaFor(member, "worker", sources, {
        hierarchyPath: [main.harnessId!, process.id, member.id],
        summary: `Worker lane ${label}; ${detail}; status ${status}.`,
        drillable: false,
      });
      edges.push(
        edge(
          previousBarrierId || main.id,
          process.id,
          runId,
          `dispatch-${processId}`,
        ),
      );
      edges.push(edge(process.id, member.id, runId, `contains-${processId}`));
    }

    const barrierId = dynamicMajorId(runId, `stage-${stage.index}-barrier`);
    const barrierStatus = dynamicBarrierStatus(stage, agents);
    const barrier = {
      id: barrierId,
      runId,
      parentId: null,
      kind: "workflow" as const,
      status: barrierStatus,
      label: `Barrier · Stage ${stage.index}`,
      detail:
        `${completedProcessIds.length}/${stageProcessIds.length} lanes complete`
        + (stage.goal ? ` · ${stage.goal}` : ""),
      eventType: "parallel_barrier",
      sequence: stageSequence + 0.8,
      observedSequence: latestSequence(stageSources),
      harnessId: main.harnessId,
      depth: 0,
      timestamp: latestTimestamp(stageSources) || main.timestamp,
      scope: `${runId}:workflow:stage:${stage.index}:barrier`,
      identity: { stageKey: String(stage.index) },
      joinId: `stage-${stage.index}-barrier`,
      expectedNodeIds: stageProcessIds,
      completedNodeIds: completedProcessIds,
      provenance: nodeProvenance(stageSources),
    } satisfies SessionFlowNode;
    nodes.push(barrier);
    metadata[barrier.id] = metaFor(barrier, "stage", stageSources, {
      hierarchyPath: [main.harnessId!, barrier.id],
      summary:
        `All-of barrier for Stage ${stage.index}; `
        + `${completedProcessIds.length}/${stageProcessIds.length} lanes complete; `
        + `status ${barrier.status}.`,
      drillable: false,
    });
    if (stageProcessIds.length === 0) {
      edges.push(
        edge(
          previousBarrierId || main.id,
          barrier.id,
          runId,
          `empty-stage-${stage.index}`,
        ),
      );
    }
    for (const processId of stageProcessIds) {
      edges.push(edge(processId, barrier.id, runId, `lane-${processId}-to-barrier`));
    }
    previousBarrierId = barrier.id;
  }

  const synthesisSources = runSources.filter((node) =>
    node.eventType === "dynamic_workflow_synthesis_start"
    || node.eventType === "dynamic_workflow_controller_start"
    || node.eventType === "dynamic_workflow_controller_end"
  );
  const synthesisStatus: SessionFlowNodeStatus =
    workflow.status === "succeeded"
      ? "succeeded"
      : workflow.status === "failed"
        ? "failed"
        : workflow.status === "cancelled"
          ? "cancelled"
          : workflow.status === "synthesizing"
            ? "running"
            : "pending";
  const synthesisId = dynamicMajorId(runId, "synthesis");
  const synthesis = {
    id: synthesisId,
    runId,
    parentId: null,
    kind: "workflow" as const,
    status: synthesisStatus,
    label: "Synthesis · Main Agent",
    detail:
      `Consolidate ${processIds.length} parallel specialist lane`
      + `${processIds.length === 1 ? "" : "s"} into one report`,
    eventType: "parallel_synthesis",
    sequence: latestSequenceValue + 1,
    observedSequence: latestSequence(synthesisSources),
    harnessId: main.harnessId,
    depth: 0,
    timestamp: latestTimestamp(synthesisSources) || main.timestamp,
    scope: `${runId}:workflow:synthesis`,
    provenance: nodeProvenance(synthesisSources),
  } satisfies SessionFlowNode;
  nodes.push(synthesis);
  metadata[synthesis.id] = metaFor(synthesis, "workflow", synthesisSources, {
    hierarchyPath: [main.harnessId!, synthesis.id],
    summary:
      "Main synthesizes after the declared parallel lanes clear the stage barrier; "
      + `status ${synthesis.status}.`,
    drillable: false,
  });
  edges.push(
    edge(
      previousBarrierId || main.id,
      synthesis.id,
      runId,
      previousBarrierId ? "barrier-to-synthesis" : "main-to-synthesis",
    ),
  );

  const outputStatus: SessionFlowNodeStatus = dynamicRunStatus(workflow);
  const outputId = dynamicMajorId(runId, "output");
  const output = {
    id: outputId,
    runId,
    parentId: null,
    kind: "result" as const,
    status: outputStatus,
    label: "Output · Receipt",
    detail:
      workflow.completion?.reason
      || (outputStatus === "succeeded"
        ? "Synthesis receipt"
        : "Waiting for a terminal workflow receipt"),
    eventType: "parallel_output",
    sequence: latestSequence(outputSources) ?? latestSequenceValue + 2,
    observedSequence: latestSequence(outputSources),
    harnessId: main.harnessId,
    depth: 0,
    timestamp: latestTimestamp(outputSources) || synthesis.timestamp,
    scope: `${runId}:output`,
    provenance: nodeProvenance(outputSources),
  } satisfies SessionFlowNode;
  nodes.push(output);
  metadata[output.id] = metaFor(output, "output", outputSources, {
    hierarchyPath: [main.harnessId!, output.id],
    summary:
      "Terminal receipt for the fast parallel workflow; "
      + `status ${output.status}.`,
    drillable: false,
  });
  edges.push(edge(synthesis.id, output.id, runId, "synthesis-to-output"));

  return {
    nodes: nodes.sort(compareNodes),
    edges,
    metadata,
    firstId: main.id,
    lastId: output.id,
  };
}

function dynamicRunProjection(
  rawState: SessionFlowState,
  runId: string,
  workflow: DynamicWorkflowState,
): {
  nodes: SessionFlowNode[];
  edges: SessionFlowEdge[];
  metadata: Record<string, SessionFlowHierarchyNodeMeta>;
  firstId: string;
  lastId: string;
} {
  const runSources = rawState.nodes.filter((node) => node.runId === runId);
  const mainSources = runSources.filter((node) =>
    node.eventType === "run_start"
    || node.eventType === "dynamic_workflow_route"
    || node.eventType === "dynamic_workflow_start"
    || node.eventType === "dynamic_workflow_controller_start"
    || node.eventType === "dynamic_workflow_controller_end"
  );
  const outputSources = runSources.filter((node) =>
    node.eventType === "dynamic_workflow_end"
    || node.eventType === "run_finished"
    || node.eventType === "result"
    || node.eventType === "final"
  );
  const stageSources = (stage: DynamicWorkflowStage) =>
    dynamicStageSources(rawState, runId, stage.index);
  const firstSequence = earliestSequence(runSources, rawState.nextSequence);
  const mainId = dynamicMajorId(runId, "main");
  const main = {
    id: mainId,
    runId,
    parentId: null,
    kind: "run" as const,
    status: dynamicRunStatus(workflow),
    label: "Main Agent · Plan & Dispatch",
    detail: workflow.pattern
      ? `${workflow.pattern}${workflow.reason ? ` · ${workflow.reason}` : ""}`
      : "Fan-out parallel stages with explicit barriers",
    eventType: "parallel_main_agent",
    sequence: firstSequence,
    observedSequence: latestSequence(mainSources),
    harnessId: dynamicMajorId(runId, "harness"),
    depth: 0,
    timestamp: latestTimestamp(mainSources.length ? mainSources : runSources),
    scope: `${runId}:main`,
    provenance: nodeProvenance(mainSources),
  } satisfies SessionFlowNode;

  const nodes: SessionFlowNode[] = [main];
  const edges: SessionFlowEdge[] = [];
  const metadata: Record<string, SessionFlowHierarchyNodeMeta> = {
    [main.id]: metaFor(main, "main-agent", mainSources, {
      hierarchyPath: [main.harnessId!, main.id],
      summary:
        `Parallel workflow ${runId}: Main Agent fans work out into `
        + `${workflow.stages.length} stage${workflow.stages.length === 1 ? "" : "s"} `
        + "and joins every lane before synthesis.",
    }),
  };
  const reviewIds: string[] = [];
  let previousBarrierId: string | null = null;
  let previousBarrierJoinId: string | null = null;
  let previousReviewId: string | null = null;
  let latestSequenceValue = firstSequence;
  let failedBarrierId: string | null = null;

  const orderedStages = [...workflow.stages].sort(
    (left, right) => left.index - right.index,
  );
  for (const stage of orderedStages) {
    const stageSourcesForRun = stageSources(stage);
    const stageSequence = earliestSequence(
      stageSourcesForRun,
      firstSequence + stage.index,
    );
    latestSequenceValue = Math.max(latestSequenceValue, stageSequence);
    const agents = stage.agents.length
      ? stage.agents
      : [{
          name: `Stage ${stage.index} controller`,
          index: 0,
          status: stage.status === "failed" ? "failed" : "unstarted",
          active: false,
          role: "lane inventory",
          skills: [],
          summary: stage.goal || "No worker inventory was reported",
          failureReason: stage.status === "failed"
            ? "stage failed without a worker inventory"
            : "worker inventory missing",
        } satisfies DynamicWorkflowAgent];
    const processIds: string[] = [];
    const completedProcessIds: string[] = [];

    for (const agent of agents) {
      const status = dynamicAgentStatus(agent);
      const processId = dynamicMajorId(
        runId,
        `stage-${stage.index}-lane-${agent.index}`,
      );
      const memberId = `${processId}:lane`;
      const sources = dynamicWorkerSources(rawState, runId, stage.index, agent);
      const sequence = stageSequence + 0.1 + agent.index / 1000;
      const dependencyIds = previousBarrierJoinId ? [previousBarrierJoinId] : [];
      const label = agent.name || `Stage ${stage.index} lane ${agent.index + 1}`;
      const detail = [
        agent.role,
        agent.summary || agent.progress,
        agent.failureReason,
      ].filter(Boolean).join(" · ") || "parallel lane";
      const identity = {
        stageKey: String(stage.index),
        workerKey: String(agent.index),
        workerIndex: String(agent.index),
        agentName: label,
      };
      const process = {
        id: processId,
        runId,
        parentId: null,
        kind: "workflow" as const,
        status,
        label: `Stage ${stage.index} · ${label}`,
        detail,
        eventType: "parallel_lane_process",
        sequence,
        observedSequence: latestSequence(sources),
        harnessId: main.harnessId,
        depth: 0,
        timestamp: latestTimestamp(sources) || latestTimestamp(stageSourcesForRun),
        scope: `${runId}:workflow:stage:${stage.index}:worker:${agent.index}`,
        identity,
        processId,
        processLabel: `Stage ${stage.index} · ${label}`,
        branchId: `stage-${stage.index}`,
        dependsOnNodeIds: dependencyIds,
        processNode: true as const,
        provenance: nodeProvenance(sources),
      } satisfies SessionFlowNode;
      const member = {
        id: memberId,
        runId,
        parentId: processId,
        kind: "agent" as const,
        status,
        label,
        detail,
        eventType: "parallel_lane",
        sequence: sequence + 0.001,
        observedSequence: latestSequence(sources),
        harnessId: main.harnessId,
        depth: 1,
        timestamp: latestTimestamp(sources) || process.timestamp,
        scope: process.scope,
        identity,
        processId,
        processLabel: process.processLabel,
        branchId: process.branchId,
        processMember: true as const,
        dependsOnNodeIds: dependencyIds,
        provenance: nodeProvenance(sources),
      } satisfies SessionFlowNode;
      nodes.push(process, member);
      processIds.push(processId);
      if (status === "succeeded") completedProcessIds.push(processId);
      metadata[process.id] = metaFor(process, "worker", sources, {
        hierarchyPath: [main.harnessId!, process.id],
        statusLookupId: null,
        summary: `Parallel lane ${label}; ${detail}; status ${status}.`,
      });
      metadata[member.id] = metaFor(member, "worker", sources, {
        hierarchyPath: [main.harnessId!, process.id, member.id],
        statusLookupId: null,
        summary: `Worker lane ${label}; ${detail}; status ${status}.`,
        drillable: false,
      });
    }

    const barrierId = dynamicMajorId(runId, `stage-${stage.index}-barrier`);
    const barrierStatus = dynamicBarrierStatus(stage, agents);
    const barrierSources = stageSourcesForRun;
    const barrier = {
      id: barrierId,
      runId,
      parentId: null,
      kind: "workflow" as const,
      status: barrierStatus,
      label: `Barrier · Stage ${stage.index}`,
      detail:
        `${completedProcessIds.length}/${processIds.length} lanes complete`
        + (stage.goal ? ` · ${stage.goal}` : ""),
      eventType: "parallel_barrier",
      sequence: stageSequence + 0.8,
      observedSequence: latestSequence(barrierSources),
      harnessId: main.harnessId,
      depth: 0,
      timestamp: latestTimestamp(barrierSources) || latestTimestamp(stageSourcesForRun),
      scope: `${runId}:workflow:stage:${stage.index}:barrier`,
      identity: { stageKey: String(stage.index) },
      joinId: `stage-${stage.index}-barrier`,
      expectedNodeIds: processIds,
      completedNodeIds: completedProcessIds,
      provenance: nodeProvenance(barrierSources),
    } satisfies SessionFlowNode;
    nodes.push(barrier);
    metadata[barrier.id] = metaFor(barrier, "stage", barrierSources, {
      hierarchyPath: [main.harnessId!, barrier.id],
      statusLookupId: null,
      summary:
        `All-of barrier for Stage ${stage.index}; `
        + `${completedProcessIds.length}/${processIds.length} lanes complete; `
        + `status ${barrier.status}.`,
      drillable: false,
    });
    if (barrierStatus === "failed" || barrierStatus === "cancelled") {
      failedBarrierId = barrier.id;
    }

    const reviewId = dynamicMajorId(runId, `stage-${stage.index}-review`);
    const review = {
      id: reviewId,
      runId,
      parentId: null,
      kind: "workflow" as const,
      status: dynamicReviewStatus(workflow, stage),
      label: `Review · Stage ${stage.index}`,
      detail:
        `Main reviews ${processIds.length} lane report${processIds.length === 1 ? "" : "s"}`
        + (stage.pattern ? ` · ${stage.pattern}` : ""),
      eventType: "parallel_critic_review",
      sequence: stageSequence + 0.9,
      observedSequence: latestSequence(stageSourcesForRun),
      harnessId: main.harnessId,
      depth: 0,
      timestamp: latestTimestamp(stageSourcesForRun) || barrier.timestamp,
      scope: `${runId}:workflow:stage:${stage.index}:review`,
      identity: { stageKey: String(stage.index) },
      provenance: nodeProvenance(stageSourcesForRun),
    } satisfies SessionFlowNode;
    nodes.push(review);
    reviewIds.push(review.id);
    metadata[review.id] = metaFor(review, "critical", stageSourcesForRun, {
      hierarchyPath: [main.harnessId!, review.id],
      summary:
        `Critic/review checkpoint after Stage ${stage.index}; `
        + `status ${review.status}.`,
      drillable: false,
    });

    for (const processId of processIds) {
      if (!previousBarrierId) {
        edges.push(edge(main.id, processId, runId, `dispatch-${processId}`));
      }
      edges.push(edge(processId, `${processId}:lane`, runId, `contains-${processId}`));
      edges.push(edge(processId, barrier.id, runId, `lane-${processId}-to-barrier`));
      if (previousReviewId) {
        if (previousBarrierId) {
          edges.push(
            edge(
              previousBarrierId,
              processId,
              runId,
              `barrier-to-${processId}`,
            ),
          );
        }
        edges.push({
          id: `parallel:handoff:${safeSegment(runId)}:${safeSegment(previousReviewId)}:${safeSegment(processId)}`,
          source: previousReviewId,
          target: processId,
          kind: "handoff",
        });
      }
    }
    if (processIds.length === 0) {
      edges.push(
        edge(
          previousBarrierId || main.id,
          barrier.id,
          runId,
          `empty-stage-${stage.index}`,
        ),
      );
    }
    for (const processId of processIds) {
      if (previousBarrierJoinId) {
        // The explicit barrier dependency is what keeps the next fan-out
        // from bypassing a missing/failed lane. The review handoff above is a
        // second, visibly dashed checkpoint for the human operator.
        const processNode = nodes.find((node) => node.id === processId);
        if (processNode) {
          processNode.dependsOnNodeIds = [previousBarrierJoinId];
        }
      }
    }
    edges.push(edge(barrier.id, review.id, runId, `barrier-${stage.index}-review`));
    previousBarrierId = barrier.id;
    previousBarrierJoinId = barrier.joinId || null;
    previousReviewId = review.id;
  }

  const lastStage = orderedStages.at(-1);
  const lastReviewId = reviewIds.at(-1) || previousBarrierId || main.id;
  const synthesisId = dynamicMajorId(runId, "synthesis");
  const synthesisSources = runSources.filter((node) =>
    node.eventType === "dynamic_workflow_synthesis_start"
    || node.eventType === "dynamic_workflow_controller_start"
    || node.eventType === "dynamic_workflow_controller_end"
  );
  const synthesisStatus: SessionFlowNodeStatus =
    workflow.status === "succeeded"
      ? "succeeded"
      : workflow.status === "failed"
        ? "failed"
        : workflow.status === "cancelled"
          ? "cancelled"
          : workflow.status === "synthesizing"
            ? "running"
            : "pending";
  const synthesis = {
    id: synthesisId,
    runId,
    parentId: null,
    kind: "workflow" as const,
    status: synthesisStatus,
    label: "Synthesis · Main Agent",
    detail: lastStage?.goal
      ? `Consolidate verified stage reports · ${lastStage.goal}`
      : "Consolidate verified parallel reports",
    eventType: "parallel_synthesis",
    sequence: latestSequenceValue + 1,
    observedSequence: latestSequence(synthesisSources),
    harnessId: main.harnessId,
    depth: 0,
    timestamp: latestTimestamp(synthesisSources) || main.timestamp,
    scope: `${runId}:workflow:synthesis`,
    provenance: nodeProvenance(synthesisSources),
  } satisfies SessionFlowNode;
  nodes.push(synthesis);
  metadata[synthesis.id] = metaFor(synthesis, "workflow", synthesisSources, {
    hierarchyPath: [main.harnessId!, synthesis.id],
    summary:
      "Final synthesis is downstream of the last barrier and critic review; "
      + `status ${synthesis.status}.`,
    drillable: false,
  });
  edges.push({
    id: `parallel:handoff:${safeSegment(runId)}:${safeSegment(lastReviewId)}:${safeSegment(synthesis.id)}`,
    source: lastReviewId,
    target: synthesis.id,
    kind: "handoff",
  });

  if (failedBarrierId) {
    const recoveryId = dynamicMajorId(runId, "recovery");
    const recoveryStatus: SessionFlowNodeStatus =
      workflow.status === "failed" || workflow.status === "cancelled"
        ? dynamicRunStatus(workflow)
        : "running";
    const recovery = {
      id: recoveryId,
      runId,
      parentId: null,
      kind: "workflow" as const,
      status: recoveryStatus,
      label: "Recovery · Retry branch",
      detail: workflow.reason || "A failed lane requires explicit reconciliation",
      eventType: "parallel_recovery",
      sequence: latestSequenceValue + 0.5,
      observedSequence: latestSequence(runSources),
      harnessId: main.harnessId,
      depth: 0,
      timestamp: latestTimestamp(runSources),
      scope: `${runId}:workflow:recovery`,
      provenance: nodeProvenance(runSources),
    } satisfies SessionFlowNode;
    nodes.push(recovery);
    metadata[recovery.id] = metaFor(recovery, "workflow", runSources, {
      hierarchyPath: [main.harnessId!, recovery.id],
      summary:
        "Dashed conditional branch: recover/retry is shown only after an "
        + `observable failed Stage barrier; status ${recovery.status}.`,
      drillable: false,
    });
    edges.push({
      id: `parallel:handoff:${safeSegment(runId)}:${safeSegment(failedBarrierId)}:${safeSegment(recovery.id)}`,
      source: failedBarrierId,
      target: recovery.id,
      kind: "handoff",
    });
  }

  const outputStatus: SessionFlowNodeStatus = dynamicRunStatus(workflow);
  const outputId = dynamicMajorId(runId, "output");
  const output = {
    id: outputId,
    runId,
    parentId: null,
    kind: "result" as const,
    status: outputStatus,
    label: "Output · Receipt",
    detail:
      workflow.completion?.reason
      || (outputStatus === "succeeded"
        ? "Verified synthesis receipt"
        : "Waiting for a terminal workflow receipt"),
    eventType: "parallel_output",
    sequence: latestSequence(outputSources) ?? latestSequenceValue + 2,
    observedSequence: latestSequence(outputSources),
    harnessId: main.harnessId,
    depth: 0,
    timestamp: latestTimestamp(outputSources) || synthesis.timestamp,
    scope: `${runId}:output`,
    provenance: nodeProvenance(outputSources),
  } satisfies SessionFlowNode;
  nodes.push(output);
  metadata[output.id] = metaFor(output, "output", outputSources, {
    hierarchyPath: [main.harnessId!, output.id],
    summary:
      "Terminal receipt for the parallel workflow; output status is copied "
      + `from the controller state (${output.status}).`,
    drillable: false,
  });
  edges.push(edge(synthesis.id, output.id, runId, "synthesis-to-output"));

  return {
    nodes: nodes.sort(compareNodes),
    edges,
    metadata,
    firstId: main.id,
    lastId: output.id,
  };
}

function compoundMemberOrder(
  left: SessionFlowNode,
  right: SessionFlowNode,
): number {
  const declared = left.childWorkflowIds || right.childWorkflowIds || [];
  const leftWorkflow = left.identity?.workflowId || "";
  const rightWorkflow = right.identity?.workflowId || "";
  const leftIndex = declared.indexOf(leftWorkflow);
  const rightIndex = declared.indexOf(rightWorkflow);
  return (
    (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
    - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
    || compareNodes(left, right)
  );
}

/**
 * Compound telemetry already carries the process DAG. The major overview must
 * keep that causal graph instead of folding it into the ordinary three-block
 * capsule, while still synthesizing the operator-facing input/output ports.
 */
function compoundRunProjection(
  rawState: SessionFlowState,
  runId: string,
): {
  nodes: SessionFlowNode[];
  edges: SessionFlowEdge[];
  metadata: Record<string, SessionFlowHierarchyNodeMeta>;
  firstId: string;
  lastId: string;
} {
  const runSources = rawState.nodes.filter((node) => node.runId === runId);
  const mainSources = runSources.filter(mainSource);
  const outputSources = runSources.filter(outputSource);
  const frozenHeader = runSources.find((node) =>
    node.workflowPlanFrozen === true
    && Boolean(node.planDigest?.match(/^[0-9a-f]{64}$/))
    && Boolean(node.outputProcessId));
  const headerPlanDigest = frozenHeader?.planDigest;
  const headerOutputProcessId = frozenHeader?.outputProcessId;
  const inFrozenPlan = (node: SessionFlowNode) =>
    Boolean(
      frozenHeader
      && node.workflowPlanFrozen === true
      && node.planDigest === headerPlanDigest
      && node.outputProcessId === headerOutputProcessId
    );
  const processSources = runSources.filter(
    (node) =>
      node.processNode === true
      && Boolean(node.processId)
      && (!frozenHeader || inFrozenPlan(node)),
  );
  const memberSources = runSources.filter(
    (node) =>
      node.processMember === true
      && Boolean(node.processId)
      && (!frozenHeader || inFrozenPlan(node)),
  );
  const joinSources = runSources.filter((node) =>
    Boolean(node.joinId) && (!frozenHeader || inFrozenPlan(node)));
  const sequenceBase = earliestSequence(runSources, rawState.nextSequence);
  const harnessId = majorId(runId, "harness");
  const mainId = majorId(runId, "main");
  const outputId = majorId(runId, "output");

  const main = {
    id: mainId,
    runId,
    parentId: null,
    kind: "run" as const,
    status: aggregateStatus(
      mainSources,
      rawState.activeRunId === runId ? "running" : "pending",
    ),
    label: "Main Agent",
    detail: latestDetail(
      mainSources,
      rawState.activeRunId === runId ? "active session request" : "session request",
    ),
    eventType: "major_main_agent",
    sequence: sequenceBase,
    observedSequence: latestSequence(mainSources),
    depth: 0,
    timestamp: latestTimestamp(mainSources.length ? mainSources : runSources),
    // Main-lane processes, joins, and the terminal output share this row.
    scope: `${runId}:main`,
    provenance: nodeProvenance(mainSources),
  } satisfies SessionFlowNode;

  const graphNodes = [...processSources, ...memberSources, ...joinSources]
    .sort(compareNodes)
    .map((source): SessionFlowNode => ({
      ...source,
      parentId: source.processMember === true
        ? semanticProcessId(runId, source.processId!)
        : null,
      depth: source.processMember === true ? 1 : 0,
      provenance: source.provenance || nodeProvenance([source]),
    }));
  const membersByProcess = new Map<string, SessionFlowNode[]>();
  for (const member of graphNodes.filter((node) => node.processMember === true)) {
    const members = membersByProcess.get(member.processId!) || [];
    members.push(member);
    membersByProcess.set(member.processId!, members);
  }
  for (const members of membersByProcess.values()) {
    members.sort(compoundMemberOrder);
  }
  const processById = new Map(
    graphNodes
      .filter((node) => node.processNode === true && Boolean(node.processId))
      .map((node) => [node.processId!, node] as const),
  );

  // State schema v1 made compound fields optional. Preserve compatibility for
  // a hydrated older projection by synthesizing the now-required process
  // parent from its stable member identity.
  for (const [processId, members] of membersByProcess) {
    if (processById.has(processId)) continue;
    const first = members[0]!;
    const process: SessionFlowNode = {
      ...first,
      id: semanticProcessId(runId, processId),
      parentId: null,
      kind: "workflow",
      status: aggregateStatus(members),
      label: `Process · ${first.processLabel || processId}`,
      eventType: "workflow_process_observed",
      sequence: Math.max(0, first.sequence - 0.125),
      depth: 0,
      identity: { ...(first.identity || {}), nodeId: processId },
      processMember: undefined,
      processNode: true,
      provenance: nodeProvenance(members),
    };
    graphNodes.push(process);
    processById.set(processId, process);
    for (const member of members) member.parentId = process.id;
  }
  const joinById = new Map(
    graphNodes
      .filter((node) => Boolean(node.joinId))
      .map((node) => [node.joinId!, node] as const),
  );
  const topologyEdges: SessionFlowEdge[] = [];
  const topologyEdgeIds = new Set<string>();
  const addTopologyEdge = (
    source: SessionFlowNode | undefined,
    target: SessionFlowNode | undefined,
    meaning: string,
    kind: SessionFlowEdge["kind"] = "sequence",
  ): void => {
    if (!source || !target || source.id === target.id) return;
    const key = `${kind}\u0000${source.id}\u0000${target.id}`;
    if (topologyEdgeIds.has(key)) return;
    topologyEdgeIds.add(key);
    topologyEdges.push(
      kind === "sequence"
        ? edge(source.id, target.id, runId, meaning)
        : {
            id:
              `major:${kind}:${safeSegment(runId)}:${safeSegment(meaning)}:`
              + `${safeSegment(source.id)}:${safeSegment(target.id)}`,
            source: source.id,
            target: target.id,
            kind,
          },
    );
  };
  const dependencyEndpoint = (dependencyId: string): SessionFlowNode | undefined =>
    processById.get(dependencyId) || joinById.get(dependencyId);

  // A process frame contains a serial list of one to three workflow members.
  for (const [processId, members] of membersByProcess) {
    const process = processById.get(processId);
    for (const member of members) {
      addTopologyEdge(
        process,
        member,
        `process-${processId}-contains-${member.identity?.workflowId || member.id}`,
        "contains",
      );
    }
    for (let index = 1; index < members.length; index += 1) {
      addTopologyEdge(
        members[index - 1],
        members[index],
        `process-${processId}-member-${index}-to-${index + 1}`,
      );
    }
    for (const dependencyId of process?.dependsOnNodeIds || []) {
      addTopologyEdge(
        dependencyEndpoint(dependencyId),
        process,
        `dependency-${dependencyId}-to-${processId}`,
      );
    }
  }

  // An all-of join has exactly its declared predecessor set: no chronology
  // shortcut is allowed to visually bypass an unfinished branch.
  for (const [joinId, join] of joinById) {
    for (const predecessorId of join.expectedNodeIds || []) {
      addTopologyEdge(
        dependencyEndpoint(predecessorId),
        join,
        `predecessor-${predecessorId}-to-join-${joinId}`,
      );
    }
  }

  // Only causally root processes are dispatched by Main Agent. A process with
  // an unresolved declared dependency remains visibly disconnected/fail-closed.
  for (const [processId, process] of processById) {
    if ((process.dependsOnNodeIds || []).length === 0) {
      addTopologyEdge(main, process, `main-to-root-process-${processId}`);
    }
  }
  for (const [joinId, join] of joinById) {
    if ((join.expectedNodeIds || []).length === 0) {
      addTopologyEdge(main, join, `main-to-root-join-${joinId}`);
    }
  }

  // Output identity is declared by the immutable header. Receipt-order sink
  // inference is intentionally forbidden because a dropped branch receipt can
  // otherwise make a partial graph look terminal.
  const canonicalTerminalProcess = headerOutputProcessId
    ? processById.get(headerOutputProcessId)
    : undefined;
  const validFrozenTopology = Boolean(
    frozenHeader
    && canonicalTerminalProcess
    && processSources.length + joinSources.length > 0
    && [...processById.values(), ...joinById.values()].every(inFrozenPlan)
  );
  const terminalOutputSources = outputSources.filter(
    (node) =>
      node.eventType !== "workflow_output_committed"
      || node.processId === headerOutputProcessId,
  );
  const matchingOutputCommitted = terminalOutputSources.some(
    (node) =>
      node.eventType === "workflow_output_committed"
      && node.processId === headerOutputProcessId
      && Boolean(node.artifactRef?.trim())
      && Boolean(node.digest?.match(/^[0-9a-f]{64}$/)),
  );
  const adverseStatus = compoundAdverseStatus([
    ...processById.values(),
    ...joinById.values(),
  ]);
  const outputAuthorized = Boolean(
    validFrozenTopology
    && canonicalTerminalProcess?.status === "succeeded"
    && matchingOutputCommitted
    && compoundWorkflowOutputAuthorized(rawState, runId)
  );
  if (outputAuthorized) main.status = "succeeded";
  else if (adverseStatus) main.status = adverseStatus;
  const output = {
    id: outputId,
    runId,
    parentId: null,
    kind: "result" as const,
    status:
      adverseStatus
      || (outputAuthorized
        ? "succeeded"
        : "pending"),
    label: "Output",
    detail: latestDetail(
      terminalOutputSources,
      rawState.activeRunId === runId ? "waiting for output" : "no output receipt",
    ),
    eventType: "major_output",
    sequence: Math.max(
      sequenceBase,
      ...runSources.map((node) => node.sequence),
    ) + 0.5,
    observedSequence: latestSequence(terminalOutputSources),
    depth: 0,
    timestamp: latestTimestamp(
      terminalOutputSources.length ? terminalOutputSources : runSources,
    ),
    scope: `${runId}:main`,
    provenance: nodeProvenance(outputSources),
  } satisfies SessionFlowNode;
  if (validFrozenTopology) {
    addTopologyEdge(
      canonicalTerminalProcess,
      output,
      `declared-output-${headerOutputProcessId}-to-output`,
    );
  }

  const metadata: Record<string, SessionFlowHierarchyNodeMeta> = {
    [main.id]: metaFor(main, "main-agent", mainSources, {
      hierarchyPath: [harnessId, main.id],
      summary:
        `Compound run ${runId}: Main Agent dispatches `
        + `${membersByProcess.size} process${membersByProcess.size === 1 ? "" : "es"}; `
        + `status ${main.status}.`,
    }),
    [output.id]: metaFor(output, "output", outputSources, {
      hierarchyPath: [harnessId, output.id],
      summary:
        `Compound run ${runId}: one terminal Output folds `
        + `${outputSources.length} output receipt${outputSources.length === 1 ? "" : "s"}; `
        + `status ${output.status}.`,
    }),
  };
  for (const node of graphNodes) {
    const processChildren = node.processNode === true && node.processId
      ? membersByProcess.get(node.processId) || []
      : [];
    const processSummary = node.processId
      ? `Process ${node.processLabel || node.processId}`
      : `All-of join ${node.joinId}`;
    metadata[node.id] = metaFor(node, "workflow", [node], {
      childEntityIds: processChildren.map((child) => child.id),
      childFocusNodeId: processChildren[0]?.id || null,
      drillable: node.processNode === true,
      hierarchyPath: [
        harnessId,
        node.processId
          ? `process:${safeSegment(node.processId)}`
          : `join:${safeSegment(node.joinId || node.id)}`,
        node.id,
      ],
      summary: `${processSummary}; status ${node.status}.`,
    });
  }

  return {
    nodes: [main, ...graphNodes.sort(compareNodes), output],
    edges: topologyEdges,
    metadata,
    firstId: main.id,
    lastId: output.id,
  };
}

function agiStepLabel(node: SessionFlowNode, index: number): string {
  const label = node.label
    .replace(/^AGI node\s*·\s*/i, "")
    .replace(/\s*·\s*\d+\s+events?$/i, "")
    .trim();
  return `AGI Step ${index + 1} · ${label || node.identity?.nodeId || "running"}`;
}

function agiRunProjection(
  rawState: SessionFlowState,
  hierarchy: SessionFlowHierarchyProjection,
  runId: string,
): {
  nodes: SessionFlowNode[];
  edges: SessionFlowEdge[];
  metadata: Record<string, SessionFlowHierarchyNodeMeta>;
  firstId: string;
  lastId: string;
} {
  const rawSources = rawState.nodes.filter((node) => node.runId === runId);
  const hierarchyNodes = hierarchy.state.nodes
    .filter(
      (node) =>
        node.runId === runId
        && hierarchy.metadataByNodeId[node.id]?.entityKind === "agi-node",
    )
    .sort(compareNodes);
  if (hierarchyNodes.length === 0) {
    const id = majorId(runId, "agi");
    const node = {
      id,
      runId,
      parentId: null,
      kind: "agi" as const,
      status: aggregateStatus(
        rawSources,
        rawState.activeRunId === runId ? "running" : "pending",
      ),
      label: "AGI Step · routing",
      detail: "Merged plugin · Main Agent → Workflow → Output",
      eventType: "major_agi_capsule",
      sequence: earliestSequence(rawSources, rawState.nextSequence),
      depth: 0,
      timestamp: latestTimestamp(rawSources),
      scope: `${runId}:agi-workflow:node:routing`,
      provenance: nodeProvenance(rawSources),
    } satisfies SessionFlowNode;
    return {
      nodes: [node],
      edges: [],
      metadata: {
        [id]: metaFor(node, "agi-node", rawSources, {
          summary:
            "Merged AGI plugin: Main Agent → Workflow → Output; "
            + `${rawSources.length} source events; status ${node.status}.`,
        }),
      },
      firstId: id,
      lastId: id,
    };
  }

  const metadata: Record<string, SessionFlowHierarchyNodeMeta> = {};
  const nodes = hierarchyNodes.map((source, index): SessionFlowNode => {
    const sourceMeta = hierarchy.metadataByNodeId[source.id]!;
    const sources = rawState.nodes.filter((node) =>
      sourceMeta.sourceNodeIds.includes(node.id)
    );
    const node: SessionFlowNode = {
      ...source,
      parentId: null,
      label: agiStepLabel(source, index),
      detail:
        `Merged plugin · Main Agent → Workflow → Output · `
        + `${sourceMeta.sourceNodeIds.length} source event`
        + `${sourceMeta.sourceNodeIds.length === 1 ? "" : "s"}`,
      eventType: "major_agi_capsule",
      depth: 0,
      provenance: nodeProvenance(sources),
    };
    metadata[node.id] = {
      ...sourceMeta,
      projectedNodeId: node.id,
      entityKind: "agi-node",
      compound: true,
      expandable: sourceMeta.drillable,
      summary:
        `Merged AGI plugin: Main Agent → Workflow → Output; `
        + `${sourceMeta.sourceNodeIds.length} source event`
        + `${sourceMeta.sourceNodeIds.length === 1 ? "" : "s"}; `
        + `status ${node.status}.`,
    };
    return node;
  });
  return {
    nodes,
    edges: nodes.slice(1).map((node, index) =>
      edge(nodes[index]!.id, node.id, runId, `agi-step-${index + 1}-to-${index + 2}`)
    ),
    metadata,
    firstId: nodes[0]!.id,
    lastId: nodes.at(-1)!.id,
  };
}

/**
 * Operator overview:
 * - ordinary runs retain the compact Main Agent → Workflow → Output capsule;
 * - dynamic parallel runs become an explicit stage DAG with fan-out lanes,
 *   all-of barriers, review checkpoints, conditional recovery, synthesis, and
 *   a terminal receipt;
 * - compound and AGI runs retain their existing provenance-aware projections.
 *
 * The raw event graph and the detailed hierarchy remain available for audit
 * inspection and drill-down. The parallel projection is a rendering model,
 * not a claim about hidden reasoning or model capability.
 */
export function projectSessionFlowMajorOverview(
  rawState: SessionFlowState,
  hierarchy: SessionFlowHierarchyProjection,
  dynamicWorkflow?: DynamicWorkflowState,
): SessionFlowHierarchyProjection {
  const nodes: SessionFlowNode[] = [];
  const edges: SessionFlowEdge[] = [];
  const metadataByNodeId: Record<string, SessionFlowHierarchyNodeMeta> = {};
  let previousLastId = "";
  let previousRunId = "";
  let previousWasCompound = false;

  for (const runId of runOrder(rawState)) {
    const isAGI = rawState.nodes.some(
      (node) => node.runId === runId && node.eventType.startsWith("agi_workflow_"),
    );
    const isCompound = rawState.nodes.some(
      (node) =>
        node.runId === runId
        && (
          node.processNode === true
          || node.processMember === true
          || Boolean(node.joinId)
        ),
    );
    const isDynamic = rawState.nodes.some(
      (node) =>
        node.runId === runId
        && node.eventType.startsWith("dynamic_workflow_"),
    ) && dynamicWorkflow?.runId === runId
      && dynamicWorkflow.stages.length > 0;
    const projected = isAGI
      ? agiRunProjection(rawState, hierarchy, runId)
      : isCompound
        ? compoundRunProjection(rawState, runId)
        : isDynamic
          && dynamicWorkflow?.pattern === "tui-parallel-barrier-smoke"
          ? dynamicFanoutProjection(rawState, runId, dynamicWorkflow)
        : isDynamic
          ? dynamicRunProjection(rawState, runId, dynamicWorkflow)
          : normalRunProjection(rawState, hierarchy, runId);
    nodes.push(...projected.nodes);
    edges.push(...projected.edges);
    Object.assign(metadataByNodeId, projected.metadata);
    if (previousLastId && !previousWasCompound && !isCompound) {
      edges.push(
        edge(
          previousLastId,
          projected.firstId,
          `${previousRunId}->${runId}`,
          "previous-output-to-next-main",
        ),
      );
    }
    previousLastId = projected.lastId;
    previousRunId = runId;
    previousWasCompound = isCompound;
  }

  const orderedNodes = nodes.sort(compareNodes);
  const state: SessionFlowState = {
    schemaVersion: 1,
    candidateOnly: true,
    canClaimAGI: false,
    ...(rawState.sessionId ? { sessionId: rawState.sessionId } : {}),
    nodes: orderedNodes,
    edges,
    activeRunId: rawState.activeRunId,
    eventCount: rawState.eventCount,
    nextSequence: rawState.nextSequence,
    lastNodeByScope: Object.fromEntries(
      orderedNodes.map((node) => [node.scope, node.id]),
    ),
    containerByScope: Object.fromEntries(
      orderedNodes
        .filter((node) => node.kind === "workflow" || node.kind === "agi")
        .map((node) => [node.scope, node.id]),
    ),
    runNodeById: Object.fromEntries(
      orderedNodes
        .filter((node) =>
          metadataByNodeId[node.id]?.entityKind === "main-agent"
          || metadataByNodeId[node.id]?.entityKind === "agi-node"
        )
        .map((node) => [node.runId, node.id]),
    ),
    nodeDepthById: Object.fromEntries(orderedNodes.map((node) => [node.id, 0])),
    seenEventIds: { ...rawState.seenEventIds },
  };
  return {
    ...hierarchy,
    state,
    projectedState: state,
    metadataByNodeId,
    level: "overview",
    focusNodeId: null,
  };
}
