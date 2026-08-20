import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import { accessibleTheme, type AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  isTerminalWorkflowState,
  teamLaneNodes,
  type WorkflowNode,
  type WorkflowState,
} from "../lib/workflow.js";
import { goalPhaseGlyph, goalPhaseLabel, type GoalState } from "../lib/goalState.js";
import type { TodoItem } from "../lib/todoState.js";
import type { A2AAgent, A2AState } from "../lib/a2aState.js";
import { agiStatusLabel, type AGIState } from "../lib/agiState.js";
import {
  dynamicWorkflowStageProgressLabel,
  dynamicWorkflowStatusLabel,
  type DynamicWorkflowState,
} from "../lib/dynamicWorkflowState.js";
import {
  selectAGIWorkflowCompactSummary,
  type AGIWorkflowState,
} from "../lib/agiWorkflowState.js";
import { ellipsizeEnd } from "../lib/useTerminalSize.js";
import { wrapTextLines } from "../lib/chatLayout.js";
import {
  buildRightPanelHitRegions,
  type RightPanelHitRegion,
  type RightPanelRegionSpec,
  type RightPanelSection,
} from "../lib/rightPanelInteraction.js";
import type { SessionFlowState } from "../lib/sessionFlow.js";
import type {
  SessionFlowHierarchyBreadcrumb,
  SessionFlowHierarchyNodeMeta,
} from "../lib/sessionFlowHierarchy.js";
import type {
  SessionFlowLiveNodeStatus,
} from "../lib/sessionFlowPresentation.js";
import type { SessionFlowLayoutBounds } from "../lib/sessionFlowLayout.js";
import type { SessionFlowWorldBounds } from "../lib/sessionFlowNavigation.js";
import {
  COMPACT_SESSION_FLOW_ROWS,
  CompactSessionFlow,
} from "./SessionFlowPanel.js";
import type { SessionFlowMiniMapGeometryReport } from "./SessionFlowMiniMap.js";
import { SessionFlowDetails } from "./SessionFlowDetails.js";
import { MatrixDigitsText, MatrixText } from "./MatrixText.js";
import {
  AgentStatusBot,
  agentBotState,
  useAgentBotFrame,
} from "./AgentStatusBot.js";
import {
  rightPanelEtaLabel,
  type RightPanelEtaSnapshot,
  type RightPanelGoalRevision,
} from "./RightPanelTelemetry.js";

/**
 * Fixed width of the right-hand goal/todo panel, in columns (border + padding
 * included). The message pane is narrowed by exactly this much when the panel
 * is visible — the same "reserve a fixed right column" contract MessageList
 * uses for its scroll bar (SCROLLBAR_COLS), so wrap/height math stays correct.
 */
export const GOAL_PANEL_COLS = 30;
/**
 * Narrowest content width at which the panel still shows. Below it the panel is
 * hidden entirely rather than crushing the transcript to an unreadable sliver
 * (the chat keeps the full width). 50 keeps the transcript legible beside the
 * 30-column panel on an 80-column terminal.
 */
export const GOAL_PANEL_MIN_CONTENT = GOAL_PANEL_COLS + 50;

// A rounded border is decorative chrome under accessibility.ts's screen-reader
// contract; like WorkflowTree/GraphPanel, this panel owns one and turns it off
// for screen readers.
export function goalPanelBorderStyle(prefs: AccessibilityPrefs): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

// Same glyph vocabulary as WorkflowTree.icon so a task reads identically in the
// tree and in the panel (colour only reinforces — WCAG 1.4.1).
function todoGlyph(state: string): string {
  return ({
    running: "▶",
    queued: "○",
    blocked: "⊘",
    succeeded: "✓",
    failed: "✗",
    unstarted: "✗",
    cancelled: "■",
    interrupted: "⊘",
  } as Record<string, string>)[state] || "·";
}

function todoColor(state: string, t: Theme): string {
  if (state === "running") return t.accent;
  if (state === "blocked" || state === "interrupted") return t.warn;
  if (state === "failed" || state === "unstarted") return t.error;
  if (state === "succeeded") return t.success;
  return t.dim; // queued / cancelled / interrupted
}

const COMPACT_WORKFLOW_TERMINAL = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
  "needs_reconciliation",
  "skipped",
  "unstarted",
] as const;

const COMPACT_WORKFLOW_FAILED = [
  "failed",
  "cancelled",
  "timed_out",
  "lost",
  "needs_reconciliation",
  "skipped",
  "unstarted",
] as const;

export function compactWorkflowBarrierChrome(
  agents: ReadonlyArray<{ status: string }>,
): { terminal: number; succeeded: number; failed: number } {
  return {
    terminal: agents.filter((agent) =>
      COMPACT_WORKFLOW_TERMINAL.includes(
        agent.status as (typeof COMPACT_WORKFLOW_TERMINAL)[number],
      )
    ).length,
    succeeded: agents.filter((agent) => agent.status === "succeeded").length,
    failed: agents.filter((agent) =>
      COMPACT_WORKFLOW_FAILED.includes(
        agent.status as (typeof COMPACT_WORKFLOW_FAILED)[number],
      )
    ).length,
  };
}

function goalColor(phase: GoalState["phase"], t: Theme): string {
  if (phase === "achieved") return t.success;
  if (
    phase === "awaiting_input" ||
    phase === "unachievable" ||
    phase === "bound_hit" ||
    phase === "cancelled"
  ) {
    return t.warn;
  }
  if (phase === "running") return t.accent;
  return t.dim;
}

function TodoLine({
  node,
  t,
  botFrame = 0,
  animateOnMount = false,
}: {
  node: WorkflowNode;
  t: Theme;
  botFrame?: number;
  animateOnMount?: boolean;
}): React.ReactElement {
  const done = isTerminalWorkflowState(node.state);
  // Team rows are a live per-agent progress surface, so make their exact
  // receipt state visible rather than relying on a glyph alone (especially
  // useful for an honestly restored "interrupted" lane after a crash).
  const stateText =
    node.kind === "agent" ? ` · ${node.state.replaceAll("_", " ")}` : "";
  if (node.kind === "agent") {
    return (
      <Text wrap="truncate-end">
        <AgentStatusBot
          status={node.state}
          active={node.state === "running"}
          theme={t}
          frame={botFrame}
        />
        {" "}
        <Text color={done ? t.dim : t.text}>
          <MatrixText
            text={node.title || node.name}
            animateOnMount={animateOnMount}
          />
        </Text>
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text color={todoColor(node.state, t)}>{todoGlyph(node.state)}</Text>
      {" "}
      <Text color={done ? t.dim : t.text} strikethrough={done}>
        <MatrixText
          text={`${node.title || node.name}${stateText}`}
          animateOnMount={animateOnMount}
        />
      </Text>
    </Text>
  );
}

function ExplicitTodoLine({
  item,
  t,
  animateOnMount = false,
}: {
  item: TodoItem;
  t: Theme;
  animateOnMount?: boolean;
}): React.ReactElement {
  const done = item.status === "completed";
  const failed = item.status === "failed";
  const glyph = item.status === "in_progress" ? "▶" : done ? "✓" : failed ? "✗" : "○";
  const color =
    item.status === "in_progress" ? t.accent : done ? t.success : failed ? t.error : t.text;
  return (
    <Text wrap="truncate-end">
      <Text color={color}>{glyph}</Text>
      {" "}
      <Text color={done ? t.dim : t.text} strikethrough={done}>
        <MatrixText text={item.content} animateOnMount={animateOnMount} />
      </Text>
    </Text>
  );
}

function a2aAgentKey(agent: A2AAgent): string {
  return agent.id || `${agent.index}:${agent.name}`;
}

function A2AAgentLine({
  agent,
  t,
  botFrame = 0,
  animateOnMount = false,
}: {
  agent: A2AAgent;
  t: Theme;
  botFrame?: number;
  animateOnMount?: boolean;
}): React.ReactElement {
  const done =
    agent.status === "succeeded" ||
    agent.status === "failed" ||
    agent.status === "cancelled" ||
    agent.status === "timed_out" ||
    agent.status === "lost" ||
    agent.status === "needs_reconciliation" ||
    agent.status === "skipped";
  return (
    <Text wrap="truncate-end">
      <AgentStatusBot
        status={agent.status}
        active={agent.active}
        theme={t}
        frame={botFrame}
      />
      {" "}
      <Text
        color={done && !agent.active ? t.dim : t.text}
      >
        <MatrixText
          text={agent.name}
          animateOnMount={animateOnMount}
        />
      </Text>
    </Text>
  );
}

function SectionHeading({
  title,
  section,
  selectedSection,
  t,
}: {
  title: string;
  section: RightPanelSection;
  selectedSection?: RightPanelSection | null;
  t: Theme;
}): React.ReactElement {
  const selected = selectedSection === section;
  return (
    <Text color={t.accent} bold wrap="truncate-end">
      {selected ? "▾" : "▸"} {title}
      <Text color={t.dim} bold={false}>
        {selected ? " · open" : " · click"}
      </Text>
    </Text>
  );
}

const COMPACT_AGENT_PREVIEW = 3;
const COMPACT_TODO_PREVIEW = 4;
const COMPACT_AGI_WORKFLOW_ROWS = 4;

export function agiWorkflowCompactPanelLines(
  state: AGIWorkflowState,
  mode: "off" | "auto" | "on",
): string[] {
  if (
    mode === "off"
    && !state.active
    && !state.runId
    && state.status === "idle"
  ) {
    return [];
  }
  const summary = selectAGIWorkflowCompactSummary(state);
  return [
    `mode ${mode} · ${summary.status}`,
    summary.node,
    `${summary.route} · ${summary.workflow}`,
    `${summary.agents} · ${summary.leases} · ${summary.reuse}`,
  ].slice(0, COMPACT_AGI_WORKFLOW_ROWS);
}

export function dynamicWorkflowPlannedStageCount(
  state: DynamicWorkflowState | undefined,
): number | null {
  if (!state) return null;
  const raw = (state as DynamicWorkflowState & { plannedStages?: unknown })
    .plannedStages;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.max(state.currentStage, Math.floor(parsed));
}

export function dynamicWorkflowStageCounter(
  state: DynamicWorkflowState | undefined,
): string {
  if (!state || state.currentStage < 1) return "";
  return `${state.currentStage}/${dynamicWorkflowPlannedStageCount(state) ?? "?"}`;
}

export interface SessionFlowMiniMapScreenReport
  extends SessionFlowMiniMapGeometryReport {
  canvasScreenLeft: number;
  canvasScreenTop: number;
}

export interface SessionFlowViewportSnapshot {
  layoutBounds: SessionFlowLayoutBounds;
  viewportWorldBounds: SessionFlowWorldBounds;
}

export function GoalTodoPanel({
  theme,
  width,
  height,
  goal,
  goalRevision,
  eta,
  workflow,
  todoItems = [],
  a2a,
  dynamicWorkflow,
  agi,
  agiWorkflow,
  agiWorkflowMode = "off",
  flow,
  flowRawState = flow,
  flowMetadataByNodeId = {},
  flowLiveStatusByNodeId = {},
  flowBreadcrumbs = [],
  flowProjectionKey = "current",
  flowSelectedId = null,
  flowViewportSnapshot = null,
  selectedSection = null,
  paneTopRow = 1,
  screenLeft = 1,
  onLayout,
  onFlowMiniMapLayout,
}: {
  theme: Theme;
  width: number;
  height: number;
  goal: GoalState;
  goalRevision?: number;
  goalUpdatedAt?: string;
  goalSource?: string;
  goalHistory?: readonly RightPanelGoalRevision[];
  eta?: RightPanelEtaSnapshot;
  workflow: WorkflowState;
  todoItems?: TodoItem[];
  a2a?: A2AState;
  dynamicWorkflow?: DynamicWorkflowState;
  agi?: AGIState;
  agiWorkflow?: AGIWorkflowState;
  agiWorkflowMode?: "off" | "auto" | "on";
  flow: SessionFlowState;
  flowRawState?: SessionFlowState;
  flowMetadataByNodeId?: Readonly<Record<string, SessionFlowHierarchyNodeMeta>>;
  flowLiveStatusByNodeId?: Readonly<Record<string, SessionFlowLiveNodeStatus>>;
  flowBreadcrumbs?: readonly SessionFlowHierarchyBreadcrumb[];
  flowProjectionKey?: string;
  flowSelectedId?: string | null;
  flowViewportSnapshot?: SessionFlowViewportSnapshot | null;
  selectedSection?: RightPanelSection | null;
  /** Absolute 1-based terminal row where the bordered panel begins. */
  paneTopRow?: number;
  /** Absolute 1-based terminal column where the bordered panel begins. */
  screenLeft?: number;
  onLayout?: (regions: RightPanelHitRegion[]) => void;
  onFlowMiniMapLayout?: (
    report: SessionFlowMiniMapScreenReport | null,
  ) => void;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const lanes = teamLaneNodes(workflow);
  const a2aAgents = a2a?.enabled ? a2a.agents : [];
  const archivedA2aAgents = a2a?.enabled ? a2a.archivedAgents || [] : [];
  const orchestrationTaskCount = a2a?.orchestration?.tasks.length || 0;
  const orchestrationUnreadCount =
    a2a?.orchestration?.messages.filter((message) => message.unread).length || 0;
  const compactLanes = lanes.slice(0, COMPACT_AGENT_PREVIEW);
  const compactA2aAgents = a2aAgents.slice(0, COMPACT_AGENT_PREVIEW);
  const compactTodoItems = todoItems.slice(0, COMPACT_TODO_PREVIEW);
  const laneOverflow = Math.max(0, lanes.length - compactLanes.length);
  const a2aOverflow = Math.max(0, a2aAgents.length - compactA2aAgents.length);
  const todoOverflow = Math.max(0, todoItems.length - compactTodoItems.length);
  const workflowVisible = Boolean(
    dynamicWorkflow &&
      (dynamicWorkflow.configuredMode !== "off" ||
        dynamicWorkflow.status !== "idle" ||
        dynamicWorkflow.stages.length > 0),
  );
  const currentWorkflowStage =
    dynamicWorkflow?.stages.find(
      (stage) => stage.index === dynamicWorkflow.currentStage,
    ) ?? dynamicWorkflow?.stages.at(-1);
  const currentWorkflowChrome = compactWorkflowBarrierChrome(
    currentWorkflowStage?.agents ?? [],
  );
  const currentWorkflowTerminalCount = currentWorkflowChrome.terminal;
  const currentWorkflowSucceededCount = currentWorkflowChrome.succeeded;
  const currentWorkflowFailedCount = currentWorkflowChrome.failed;
  const phase = goalPhaseLabel(goal.phase);
  const displayedGoalRevision = goalRevision ?? goal.revision;
  const etaLabel = rightPanelEtaLabel(eta);
  const workflowStageCounter = dynamicWorkflowStageCounter(dynamicWorkflow);
  const animateAgentBots = Boolean(
    lanes.some((node) =>
      ["queued", "running", "blocked", "interrupted"].includes(node.state)
    )
    || a2aAgents.some((agent) =>
      ["queued", "working", "waiting"].includes(
        agentBotState(agent.status, agent.active),
      )
    ),
  );
  const agentBotFrame = useAgentBotFrame(animateAgentBots);
  const agiWorkflowLines = agiWorkflow
    ? agiWorkflowCompactPanelLines(agiWorkflow, agiWorkflowMode)
    : [];

  // Compact view intentionally remains bounded. Clicking a section opens the
  // full detail viewport, where the unabridged content can be scrolled.
  const goalBudget = Math.max(24, (width - 4) * 3);
  const goalText = goal.text ? ellipsizeEnd(goal.text, goalBudget) : "";
  const goalLines = goalText
    ? wrapTextLines(goalText, Math.max(1, width - 4)).slice(0, 3)
    : [];
  const phaseVisible = Boolean(phase.label);
  const seenLaneIdsRef = React.useRef<Set<string>>(
    new Set(lanes.map((node) => node.taskId)),
  );
  const seenTodoIdsRef = React.useRef<Set<string>>(
    new Set(todoItems.map((item) => item.id)),
  );
  const seenA2aAgentIdsRef = React.useRef<Set<string>>(
    new Set(a2aAgents.map(a2aAgentKey)),
  );
  const newLaneIds = new Set(
    lanes
      .filter((node) => !seenLaneIdsRef.current.has(node.taskId))
      .map((node) => node.taskId),
  );
  const newTodoIds = new Set(
    todoItems
      .filter((item) => !seenTodoIdsRef.current.has(item.id))
      .map((item) => item.id),
  );
  const newA2aAgentIds = new Set(
    a2aAgents
      .filter((agent) => !seenA2aAgentIdsRef.current.has(a2aAgentKey(agent)))
      .map(a2aAgentKey),
  );
  const hadGoalRef = React.useRef(Boolean(goal.text));
  const hadActivityRef = React.useRef(Boolean(goal.activity));
  const hadRemainingRef = React.useRef(Boolean(goal.remaining));
  const hadWorkflowRef = React.useRef(workflowVisible);
  const hadAgiRef = React.useRef(Boolean(agi?.enabled || agi?.runId));
  const animateGoalMount = Boolean(goal.text) && !hadGoalRef.current;
  const animateActivityMount = Boolean(goal.activity) && !hadActivityRef.current;
  const animateRemainingMount = Boolean(goal.remaining) && !hadRemainingRef.current;
  const animateWorkflowMount = workflowVisible && !hadWorkflowRef.current;
  const animateAgiMount =
    Boolean(agi?.enabled || agi?.runId) && !hadAgiRef.current;

  React.useEffect(() => {
    for (const node of lanes) seenLaneIdsRef.current.add(node.taskId);
    for (const item of todoItems) seenTodoIdsRef.current.add(item.id);
    for (const agent of a2aAgents) {
      seenA2aAgentIdsRef.current.add(a2aAgentKey(agent));
    }
    hadGoalRef.current = Boolean(goal.text);
    hadActivityRef.current = Boolean(goal.activity);
    hadRemainingRef.current = Boolean(goal.remaining);
    hadWorkflowRef.current = workflowVisible;
    hadAgiRef.current = Boolean(agi?.enabled || agi?.runId);
  }, [
    a2aAgents,
    agi?.enabled,
    agi?.runId,
    goal.activity,
    goal.remaining,
    goal.text,
    lanes,
    todoItems,
    workflowVisible,
  ]);

  const regions = React.useMemo(() => {
    const bordered = !ax.screenReader;
    const fullBottom = paneTopRow + height - (ax.screenReader ? 1 : 2);
    const flowStart = Math.max(
      paneTopRow + (bordered ? 1 : 0),
      fullBottom - COMPACT_SESSION_FLOW_ROWS + 1,
    );
    const flowRegion: RightPanelHitRegion = {
      section: "flow",
      screenRow: flowStart,
      screenEndRow: fullBottom,
      screenLeft,
      screenRight: screenLeft + width - 1,
    };
    // The ordinary compact sections are replaced by the selected-block
    // inspector while Flow is open. Do not leave their invisible hit regions
    // active behind that inspector.
    if (selectedSection === "flow") return [flowRegion];

    const specs: RightPanelRegionSpec[] = [{
      section: "goal",
      rowCount:
        1 +
        Math.max(1, goalLines.length) +
        (goal.activity ? 1 : 0) +
        (goal.remaining ? 1 : 0) +
        (phaseVisible ? 1 : 0) +
        (etaLabel ? 1 : 0),
    }];
    // Workflow is intentionally placed directly below Goal. Long agent and
    // To-do lists previously pushed it below the clipped compact viewport,
    // which made active workflow progress neither visible nor clickable.
    if (workflowVisible) {
      specs.push({ section: "workflow", rowCount: 4, marginTop: 1 });
    }
    if (lanes.length > 0) {
      specs.push({
        section: "agents",
        rowCount: 1 + compactLanes.length + (laneOverflow > 0 ? 1 : 0),
        marginTop: 1,
      });
    }
    if (a2aAgents.length > 0) {
      specs.push({
        section: "agents",
        rowCount:
          1 +
          compactA2aAgents.length +
          (a2aOverflow > 0 ? 1 : 0) +
          (a2a?.handoffPreview ? 1 : 0),
        marginTop: 1,
      });
    }
    specs.push({
      section: "todos",
      rowCount:
        1 +
        Math.max(
          1,
          compactTodoItems.length +
            (todoOverflow > 0 ? 1 : 0),
        ),
      marginTop: 1,
    });
    specs.push({
      section: "agi",
      rowCount:
        1
        + agiWorkflowLines.length
        + (agi?.enabled || agi?.runId ? 3 : agiWorkflowLines.length ? 0 : 1),
      marginTop: 1,
    });
    const contentHeight = Math.max(
      1,
      flowStart - paneTopRow + (bordered ? 1 : 0),
    );
    const out = buildRightPanelHitRegions({
      specs,
      paneTopRow,
      height: contentHeight,
      screenLeft,
      width,
      bordered,
    });
    out.push(flowRegion);
    return out;
  }, [
    a2a?.handoffPreview,
    a2aOverflow,
    a2aAgents.length,
    agi?.enabled,
    agi?.runId,
    agiWorkflowLines.length,
    ax.screenReader,
    goal.activity,
    goal.remaining,
    goalLines.length,
    etaLabel,
    height,
    laneOverflow,
    lanes.length,
    paneTopRow,
    phaseVisible,
    screenLeft,
    selectedSection,
    todoOverflow,
    todoItems.length,
    width,
    workflowVisible,
  ]);

  React.useEffect(() => {
    onLayout?.(regions);
    return () => onLayout?.([]);
  }, [onLayout, regions]);
  const flowRegion = regions.find((region) => region.section === "flow") ?? null;
  const onCompactMiniMapGeometry = React.useCallback(
    (report: SessionFlowMiniMapGeometryReport) => {
      if (!flowRegion) {
        onFlowMiniMapLayout?.(null);
        return;
      }
      onFlowMiniMapLayout?.({
        ...report,
        // Root panel border+padding and compact-card border+padding account
        // for four columns. Vertically, the compact border and minimap title
        // put the first canvas row two cells below the flow hit-region top.
        canvasScreenLeft:
          screenLeft + (ax.screenReader ? 1 : 4),
        canvasScreenTop:
          flowRegion.screenRow + (ax.screenReader ? 1 : 2),
      });
    },
    [ax.screenReader, flowRegion, onFlowMiniMapLayout, screenLeft],
  );
  React.useEffect(
    () => () => onFlowMiniMapLayout?.(null),
    [onFlowMiniMapLayout],
  );

  return (
    <Box
      position="relative"
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={goalPanelBorderStyle(ax)}
      borderColor={selectedSection ? t.accent : t.dim}
      paddingX={1}
      overflow="hidden"
    >
      <Box
        position="relative"
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
      >
      {selectedSection === "flow" ? (
        <SessionFlowDetails
          state={flow}
          rawState={flowRawState}
          metadataByNodeId={flowMetadataByNodeId}
          liveStatusByNodeId={flowLiveStatusByNodeId}
          selectedId={flowSelectedId}
          theme={t}
          width={Math.max(8, width - 4)}
        />
      ) : (
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <SectionHeading
        title={`Goal${displayedGoalRevision ? ` · r${displayedGoalRevision}` : ""}`}
        section="goal"
        selectedSection={selectedSection}
        t={t}
      />
      {goalLines.length ? (
        goalLines.map((line, index) => (
          <Text
            key={`goal-${index}`}
            color={goalColor(goal.phase, t)}
            wrap="truncate-end"
          >
            <MatrixText
              text={line}
              animateOnMount={animateGoalMount}
              seed={index * 41}
            />
          </Text>
        ))
      ) : (
        <Text color={t.dim} wrap="truncate-end">
          <MatrixText text="no active goal" />
        </Text>
      )}
      {goal.activity ? (
        <Text color={t.dim} wrap="truncate-end">
          ↳{" "}
          <MatrixText
            text={ellipsizeEnd(goal.activity, width - 4)}
            animateOnMount={animateActivityMount}
          />
        </Text>
      ) : null}
      {goal.remaining ? (
        <Text color={t.dim} wrap="truncate-end">
          ↳{" "}
          <MatrixText
            text={ellipsizeEnd(goal.remaining, width - 4)}
            animateOnMount={animateRemainingMount}
          />
        </Text>
      ) : null}
      {phase.label ? (
        <Text
          color={
            goal.phase === "awaiting_input"
              ? t.warn
              : phase.ok === true
                ? t.success
                : phase.ok === false
                  ? t.warn
                  : t.dim
          }
          wrap="truncate-end"
        >
          {goalPhaseGlyph(goal.phase)}{" "}
          <MatrixText
            text={`${phase.label}${
              goal.confidence != null ? ` · ${goal.confidence.toFixed(2)}` : ""
            }`}
          />
        </Text>
      ) : null}
      {etaLabel ? (
        <Text
          color={
            eta?.status === "waiting"
              ? t.warn
              : eta?.status === "active"
                ? t.accent
                : t.dim
          }
          wrap="truncate-end"
        >
          ↳ <MatrixDigitsText text={etaLabel} />
        </Text>
      ) : null}

      {workflowVisible && dynamicWorkflow ? (
        <Box marginTop={1} flexDirection="column" overflow="hidden">
          <SectionHeading
            title={`Workflow${workflowStageCounter ? ` · ${workflowStageCounter}` : ""}`}
            section="workflow"
            selectedSection={selectedSection}
            t={t}
          />
          <Text
            color={
              dynamicWorkflow.active
                ? t.warn
                : dynamicWorkflow.status === "succeeded"
                  ? t.success
                  : dynamicWorkflow.status === "failed" ||
                      dynamicWorkflow.status === "awaiting_input"
                    ? t.error
                    : t.dim
            }
            bold={dynamicWorkflow.active}
            wrap="truncate-end"
          >
            {dynamicWorkflow.active ? "◆" : "·"}{" "}
            <MatrixText
              text={dynamicWorkflowStatusLabel(dynamicWorkflow)}
              animateOnMount={animateWorkflowMount}
            />
          </Text>
          <Text color={t.dim} wrap="truncate-end">
            <MatrixText
              text={`${
                currentWorkflowStage?.pattern
                || dynamicWorkflow.pattern
                || dynamicWorkflow.configuredMode
              } · ${dynamicWorkflow.totalAgents}/${
                dynamicWorkflow.maxAgents || "?"
              } agents`}
              animateOnMount={animateWorkflowMount}
            />
          </Text>
          <Text color={t.dim} wrap="truncate-end">
            <MatrixText
              text={
                currentWorkflowStage
                  ? `${dynamicWorkflowStageProgressLabel(currentWorkflowStage)} · ${currentWorkflowStage.status} · ${currentWorkflowTerminalCount}/${currentWorkflowStage.agents.length} terminal · ${currentWorkflowSucceededCount} reports${
                      currentWorkflowFailedCount ? ` · ${currentWorkflowFailedCount} failed` : ""
                    }`
                  : "Main decides and dispatches bounded parallel stages"
              }
              animateOnMount={animateWorkflowMount}
            />
          </Text>
        </Box>
      ) : null}

      {lanes.length > 0 ? (
        // Historical parallel dispatch in flight (or just finished): one row
        // per lane member.
        <Box marginTop={1} flexDirection="column" overflow="hidden">
          <SectionHeading
            title={`Team · ${lanes.length}`}
            section="agents"
            selectedSection={selectedSection}
            t={t}
          />
          {compactLanes.map((node) => (
            <TodoLine
              key={node.taskId}
              node={node}
              t={t}
              botFrame={agentBotFrame}
              animateOnMount={newLaneIds.has(node.taskId)}
            />
          ))}
          {laneOverflow > 0 ? (
            <Text color={t.dim} wrap="truncate-end">
              <MatrixText text={`… +${laneOverflow} more · click Agents`} />
            </Text>
          ) : null}
        </Box>
      ) : null}

      {a2aAgents.length > 0 ? (
        // A2A dispatch (Main Agent → supervised/embedded sub-agents → verify). Distinct from
        // parallel Team lanes above.
        <Box marginTop={1} flexDirection="column" overflow="hidden">
          <SectionHeading
            title={`Agents · ${a2aAgents.length}${
              a2a?.activeName ? ` · ${a2a.activeName}` : ""
            }${archivedA2aAgents.length ? ` · ${archivedA2aAgents.length} archived` : ""}${
              orchestrationTaskCount ? ` · ${orchestrationTaskCount} tasks` : ""
            }${
              orchestrationUnreadCount ? ` · ${orchestrationUnreadCount} inbox` : ""
            }`}
            section="agents"
            selectedSection={selectedSection}
            t={t}
          />
          {compactA2aAgents.map((agent) => (
            <A2AAgentLine
              key={`${agent.index}:${agent.name}`}
              agent={agent}
              t={t}
              botFrame={agentBotFrame}
              animateOnMount={newA2aAgentIds.has(a2aAgentKey(agent))}
            />
          ))}
          {a2aOverflow > 0 ? (
            <Text color={t.dim} wrap="truncate-end">
              <MatrixText text={`… +${a2aOverflow} more · click Agents`} />
            </Text>
          ) : null}
          {a2a?.handoffPreview ? (
            <Text color={t.dim} wrap="truncate-end">
              ↳ handoff ·{" "}
              <MatrixText
                text={ellipsizeEnd(
                  a2a.handoffPreview,
                  Math.max(12, width - 6),
                )}
              />
            </Text>
          ) : null}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column" overflow="hidden">
        <SectionHeading
          title="To-do"
          section="todos"
          selectedSection={selectedSection}
          t={t}
        />
        {todoItems.length > 0 ? (
          compactTodoItems.map((item) => (
            <ExplicitTodoLine
              key={item.id}
              item={item}
              t={t}
              animateOnMount={newTodoIds.has(item.id)}
            />
          ))
        ) : (
          <Text color={t.dim} wrap="truncate-end">
            <MatrixText text="no tasks yet" />
          </Text>
        )}
        {todoOverflow > 0 ? (
          <Text color={t.dim} wrap="truncate-end">
            <MatrixText text={`… +${todoOverflow} more · click To-do`} />
          </Text>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column" overflow="hidden">
        <SectionHeading
          title={agiWorkflowLines.length ? "AGI workflow" : "AGI"}
          section="agi"
          selectedSection={selectedSection}
          t={t}
        />
        {agiWorkflowLines.map((line, index) => (
          <Text
            key={`agi-workflow-${index}`}
            color={
              index === 0 && agiWorkflow?.active
                ? t.accent
                : index === 0 && agiWorkflow?.terminalStatus === "succeeded"
                  ? t.success
                  : index === 0 && agiWorkflow?.terminal
                    ? t.warn
                    : t.dim
            }
            bold={index === 0 && !!agiWorkflow?.active}
            wrap="truncate-end"
          >
            {index === 0 && agiWorkflow?.active ? "▶ " : "· "}
            <MatrixText
              text={ellipsizeEnd(line, Math.max(12, width - 4))}
              seed={index * 43}
            />
          </Text>
        ))}
        {agi?.enabled || agi?.runId ? (
          <>
            <Text
              color={
                agi.active
                  ? t.accent
                  : agi.status === "achieved"
                    ? t.success
                    : agi.status === "failed" || agi.status === "unachievable"
                      ? t.error
                      : t.warn
              }
              wrap="truncate-end"
            >
              {agi.active ? "▶" : "·"}{" "}
              <MatrixText
                text={`${agiStatusLabel(agi.status)} · ${agi.route}`}
                animateOnMount={animateAgiMount}
              />
            </Text>
            <Text color={t.dim} wrap="truncate-end">
              <MatrixText
                text={`${agi.profile} · cycle ${agi.cycle}/${agi.maxCycles} · ${
                  agi.phase || "idle"
                }`}
                animateOnMount={animateAgiMount}
              />
            </Text>
            <Text color={t.dim} wrap="truncate-end">
              <MatrixText
                text={
                  agi.authorizationRequired && !agi.authorizationGranted
                    ? "approval required · /agi approve"
                    : agi.correctionAction && agi.correctionAction !== "continue"
                      ? `correction: ${agi.correctionAction}`
                      : agi.sameModelVerifier
                        ? "same-model verify"
                        : "independent verify"
                }
                animateOnMount={animateAgiMount}
              />
            </Text>
          </>
        ) : (
          <Text color={t.dim} wrap="truncate-end">
            <MatrixText text="off · /agi on" />
          </Text>
        )}
      </Box>
      </Box>
      )}

      <CompactSessionFlow
        state={flow}
        theme={t}
        width={Math.max(8, width - 4)}
        selected={selectedSection === "flow"}
        selectedNodeId={flowSelectedId}
        layoutBounds={
          selectedSection === "flow"
            ? flowViewportSnapshot?.layoutBounds
            : null
        }
        viewportWorldBounds={
          selectedSection === "flow"
            ? flowViewportSnapshot?.viewportWorldBounds
            : null
        }
        contextLabel={
          flowBreadcrumbs.map((item) => item.label).join(" / ")
          || "major overview"
        }
        projectionKey={flowProjectionKey}
        rawNodeCount={flowRawState.nodes.length}
        onMiniMapGeometry={onCompactMiniMapGeometry}
      />
      </Box>
    </Box>
  );
}
