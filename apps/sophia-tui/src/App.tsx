import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SOPHIA_VERSION } from "./lib/version.js";
import { Box, Text, useApp, useInput, useStdin, type Key } from "ink";
import { MessageList, type MessageHitRegion } from "./components/MessageList.js";
import {
  LoadingIndicator,
  loadingIndicatorHeight,
} from "./components/LoadingIndicator.js";
import { MatrixText } from "./components/MatrixText.js";
import { isAlwaysAllowToolKey, PermissionDialog } from "./components/PermissionDialog.js";
import { PromptInput } from "./components/PromptInput.js";
import { SlashSuggest, slashRowDescription } from "./components/SlashSuggest.js";
import {
  controlStatusRows,
  resolveOrchestrationStatus,
  StatusLine,
} from "./components/StatusLine.js";
import { WorkspaceContextLine } from "./components/WorkspaceContextLine.js";
import { epistemicDetailLines, type EpistemicStatus } from "./components/EpistemicChip.js";
import { applyTranscriptBudget } from "./lib/transcriptBudget.js";
import { shouldAutoResume } from "./lib/sessionResume.js";
import {
  explicitSettingKeys,
  initialPromptCanStart,
  operatorOwnedSettingsPatch,
  permissionFromBridge,
  readySettingValue,
  reconcileWorkflowRoutingModes,
  selectedStartupPluginProfile,
  settingIsOwned,
  settingsPatchMatchesSnapshot,
  type SettingKey,
} from "./lib/cliSettings.js";
import {
  conscienceDeliverySummary,
  conscienceModeFromBridge,
  resolveConscienceCommand,
  type ConscienceMode,
} from "./lib/conscienceMode.js";
import { matchPickerOption, OptionPicker, type PickerOption } from "./components/OptionPicker.js";
import { SessionBrowser, statusHeaderLines } from "./components/SessionBrowser.js";
import {
  effortLabel,
  groupModelOptions,
  mergeModelOptions,
  MODEL_OPTIONS,
  modelPickerSelectionIndex,
  moveSelection,
  normalizeEffort,
  optionsFor,
  toggleModelGroup,
  titleFor,
  type ModelGroupId,
  type ModelPickerRow,
  type PickerKind,
  type ResponseStyle,
} from "./lib/pickers.js";
import {
  INITIAL_MODEL_CONNECTIONS_STATE,
  MODEL_CONNECTION_FORM_ROWS,
  MODEL_CONNECTION_TEMPLATES,
  buildModelConnectionCommand,
  draftFromConnection,
  maskCredentialReference,
  modelConnectionStatusLabel,
  modelConnectionsReducer,
  parseModelConnectionBridgeEvent,
  type ModelConnectionAction,
  type ModelConnectionDraft,
  type ModelConnectionsState,
} from "./lib/modelConnections.js";
import { CodeBridge, bridgeEventText, kernelApprovalId, type BridgeEvent } from "./lib/bridge.js";
import { formatShellTranscript, parseShellInvocation } from "./lib/shellCommand.js";
import {
  browserLoginProviderForModel,
  formatProviderLoginEvent,
} from "./lib/providerAuth.js";
import {
  allCommands,
  commandBadges,
  editionAllowsCommand,
  editionUnavailableMessage,
  pickerKindFor,
  planSlashCommandPaste,
  resolve,
  suggest,
  unsupportedMessage,
  chooseSlashSubmission,
  type SlashCommand,
} from "./lib/slash.js";
import { didYouMean, groupByCategory, type CategoryMeta } from "./lib/slashDiscovery.js";
import { resolveTheme, type Theme } from "./lib/theme.js";
import {
  type ChatMessage,
  classifyToolResult,
  formatLiveToolStatus,
  uid,
  type AdapterStatusEvent,
  type CheckpointResultEvent,
  type FileCheckpointEntry,
  type HookConfigSummary,
  type HookDispatchRecord,
  type LocalEngineReportEvent,
  type ModelPreflightEvent,
} from "./lib/types.js";
import { PromptHistory } from "./lib/promptHistory.js";
import {
  archiveSession,
  checkpointSession,
  createSession,
  exportSession,
  findExactSessionIdFromDisk,
  forkSession,
  formatResumeDriftWarnings,
  loadSessionFromDisk,
  listSessionsFromDisk,
  lookupSessionsFromDiskAsync,
  renameSession,
  resetSession,
  resumeLookupIntent,
  tagSession,
  type SessionListItem,
} from "./lib/sessionStore.js";
import { useTerminalSize } from "./lib/useTerminalSize.js";
import {
  IDLE_PROGRESS,
  phaseFromBridgeEvent,
  phaseLabel,
  type ProgressState,
} from "./lib/progress.js";
import { contextFillPercent, describeContextUsage, formatTokens } from "./lib/tokens.js";
import {
  copyToClipboard,
  selectAllMessageAndCopy,
  selectCopyTarget,
} from "./lib/clipboard.js";
import { wrapTextLines } from "./lib/chatLayout.js";
import { backpressureEffect, isCrossRunEvent, isPostTerminalStraggler, runTimeoutEffect, stallEffect, stallTimeoutEffect } from "./lib/liveness.js";
import {
  formatLanesAbandonedMessage,
  formatRuntimeSourceWarning,
  formatTeamStartMessage,
} from "./lib/teamRouting.js";
import { TerminalInputDecoder } from "./lib/mouse.js";
import { appendTuiDebug, tuiDebugText } from "./lib/debug.js";
import { WorkflowTree } from "./components/WorkflowTree.js";
import { GraphPanel } from "./components/GraphPanel.js";
import {
  GOAL_PANEL_COLS,
  GOAL_PANEL_MIN_CONTENT,
  GoalTodoPanel,
  type SessionFlowMiniMapScreenReport,
  type SessionFlowViewportSnapshot,
} from "./components/GoalTodoPanel.js";
import { RightPanelDetails } from "./components/RightPanelDetails.js";
import type { RightPanelEtaSnapshot } from "./components/RightPanelTelemetry.js";
import {
  SessionFlowPanel,
  sessionFlowDrawioGeometry,
  sessionFlowDrawioProjection,
  sessionFlowNodeAtScreen,
  type SessionFlowPanelLayoutReport,
} from "./components/SessionFlowPanel.js";
import {
  EMPTY_RIGHT_PANEL_DETAIL,
  isInsideRightPanel,
  resolveRightPanelKey,
  rightPanelDetailItemAt,
  rightPanelDetailReducer,
  rightPanelSectionAt,
  type RightPanelDetailItemRegion,
  type RightPanelHitRegion,
  type RightPanelSection,
} from "./lib/rightPanelInteraction.js";
import {
  EMPTY_SESSION_FLOW_STATE,
  sessionFlowReducer,
  writeSessionFlowDrawio,
  type SessionFlowState,
} from "./lib/sessionFlow.js";
import {
  currentHierarchyFocusId,
  EMPTY_SESSION_FLOW_INTERACTION,
  firstSessionFlowNodeId,
  lastSessionFlowNodeId,
  nearestSessionFlowNodeId,
  nextSessionFlowDetailLevel,
  previousSessionFlowDetailLevel,
  sessionFlowInteractionReducer,
} from "./lib/sessionFlowInteraction.js";
import { presentSessionFlowHierarchy } from "./lib/sessionFlowPresentation.js";
import {
  retargetFlowRunSessions,
  sessionForFlowEvent,
} from "./lib/sessionFlowSession.js";
import {
  anchorSessionFlowPanAcrossLayouts,
  fitSessionFlowLayout,
  layoutSessionFlowForInteraction,
  resolveSessionFlowMiniMapNavigation,
} from "./lib/sessionFlowNavigation.js";
import {
  isSessionFlowDrag,
  sessionFlowPointerDelta,
} from "./lib/sessionFlowViewport.js";
import { sessionFlowWheelGesture } from "./lib/sessionFlowGesture.js";
import {
  getSessionFlowZoomPreset,
  nextSessionFlowZoomLevel,
  previousSessionFlowZoomLevel,
  type SessionFlowZoomLevel,
} from "./lib/sessionFlowZoom.js";
import { sessionFlowMiniMapNavigationAtCell } from "./lib/sessionFlowMiniMap.js";
import { useAccessibility } from "./lib/AccessibilityContext.js";
import {
  activeExchangeAssistantTexts,
  displayFinalText,
  pinMessageToEnd,
  preferBestFinalText,
  resolveFinalRow,
  TRANSCRIPT_ROW_CHAR_CAP,
} from "./lib/finalAnswer.js";
import {
  createStreamGrowth,
  flushStreamGrowth,
  pushStreamGrowth,
  type StreamGrowthState,
} from "./lib/streamGrowth.js";
import {
  boundedProviderVisibleReasoning,
  liveThinkingTokenSource,
  liveThinkingTokensVisible,
  parseThinkingVisibility,
  providerReportedReasoningSource,
  providerReasoningScope,
  providerVisibleReasoningCallStarted,
  providerVisibleReasoningMeta,
  providerVisibleReasoningSource,
  sameProviderVisibleReasoningSource,
  settledProviderReasoningGrowth,
  type ProviderReasoningScope,
  type ProviderVisibleReasoningSource,
  type ThinkingVisibility,
} from "./lib/visibleReasoning.js";
import { normalizeResponseStyle } from "./lib/responseStyle.js";
import {
  EMPTY_WORKFLOW_STATE,
  activeWorkflowNodes,
  flattenWorkflow,
  latestWorkflowRunId,
  receiptNodeEvent,
  teamLaneNodes,
  workflowReducer,
  type WorkflowState,
} from "./lib/workflow.js";
import { resolveWorkflowRouting } from "./lib/workflowRouting.js";
import {
  EMPTY_GOAL_STATE,
  goalReducer,
  isGoalLifecycleEvent,
  isTerminalGoalLifecycleEvent,
  type GoalEvent,
} from "./lib/goalState.js";
import {
  a2aReducer,
  EMPTY_A2A_STATE,
  type A2AEvent,
  type A2AState,
} from "./lib/a2aState.js";
import {
  dynamicWorkflowReducer,
  formatWorkflowDuration,
  EMPTY_DYNAMIC_WORKFLOW_STATE,
  type DynamicWorkflowEvent,
  type DynamicWorkflowMode,
  type DynamicWorkflowState,
} from "./lib/dynamicWorkflowState.js";
import {
  EMPTY_RUN_ETA_STATE,
  runEtaElapsedSec,
  runEtaEstimatedTotalSec,
  runEtaReducer,
  runEtaRemainingSec,
  type RunEtaEvent,
} from "./lib/etaState.js";
import {
  agiReducer,
  EMPTY_AGI_STATE,
  type AGIEvent,
  type AGIProfile,
  type AGIRoute,
  type AGIState,
} from "./lib/agiState.js";
import {
  agiWorkflowReducer,
  EMPTY_AGI_WORKFLOW_STATE,
  selectAGIWorkflowDetailRows,
  type AGIWorkflowDetailRow,
  type AGIWorkflowEvent,
  type AGIWorkflowState,
} from "./lib/agiWorkflowState.js";
import { EMPTY_TODO_STATE, todoReducer, type TodoEvent } from "./lib/todoState.js";
import { EMPTY_GRAPH_PROJECTION_STATE, graphProjectionReducer, visibleNodes, type GraphProjectionState } from "./lib/graphProjection.js";
import {
  applyMcpHealth,
  applyProviderHealth,
  doctorLines,
  onboardingSteps,
  parseReadyRuntime,
  providerHealthWord,
  type OnboardingStep,
  type RuntimeSnapshot,
} from "./lib/providerRuntime.js";
import {
  formatArtifacts,
  formatConnectorPolicies,
  formatHarnessReceipt,
  formatMemoryReview,
  formatPersonalMemoryStatus,
  formatPersonalRecall,
  formatPromptReceipt,
} from "./lib/personalHarness.js";
import {
  arcCampaignViewLines,
  arcContestLabel,
  arcOperatorCommands,
  loadArcCampaignPanel,
  loadingArcCampaignPanel,
  parseArcSlashArgs,
  type ArcCampaignPanelState,
} from "./lib/arc-campaign.js";
import {
  createDraftSnapshot,
  draftKeyForWorkspace,
  DraftAutosave,
  FileDraftStore,
} from "./lib/draftStore.js";
import { parseAttachmentReferences } from "./lib/attachments.js";
import {
  planModelBoundSecretPreflight,
  type ModelBoundPrompt,
} from "./lib/secretPreflight.js";
import {
  formatContinualHarnessPreview,
  formatContinualHarnessStatus,
  parseRefineSlash,
  previewContinualRefinement,
  proposeContinualRefinement,
  readContinualHarness,
} from "./lib/continualHarness.js";
import {
  INITIAL_PLUGIN_MANAGER_STATE,
  formatPluginResult,
  normalizePluginSettingsPatch,
  parsePluginSlash,
  pluginManagerActivityLine,
  pluginManagerReducer,
  pluginManagerTabForAction,
  selectedPluginManagerEntry,
  type PluginManagerAction,
} from "./lib/plugins.js";
import type { KeymapMode } from "./lib/keybindings.js";
import { detectTerminalCapabilities } from "./lib/terminalCapabilities.js";
import { verboseTranscriptEnabled } from "./lib/transcriptVisibility.js";
import {
  dispatchTerminalNotification,
  planNotification,
  resolveNotificationSettings,
  type NotificationRequest,
} from "./lib/notifications.js";
import { AccessibilityPanel } from "./components/AccessibilityPanel.js";
import {
  PluginManagerPanel,
  resolvePluginManagerKey,
} from "./components/PluginManagerPanel.js";
import { NotificationToast } from "./components/NotificationToast.js";
import { TeamLanePanel } from "./components/TeamLanePanel.js";
import {
  emptyLaneBudgets,
  resolveTeamDispatchPolicy,
  type TeamLaneLifecycle,
  type TeamLaneState,
} from "./lib/teamLanes.js";
import { PlanPanel, resolvePlanPanelKey } from "./components/PlanPanel.js";
import {
  activePlanStep,
  createPlanModeState,
  transitionPlanMode,
  type PlanModeState,
} from "./lib/planMode.js";
import { aggregateRunReceipt, type RunReceipt } from "./lib/runReceipt.js";
import { writeSupportBundle } from "./lib/supportBundle.js";
import { rebuildSessionIndex } from "./lib/sessionIndex.js";
import {
  dragAutoScrollAtRow,
  hitRegionAtRow,
  nearestHitRegion,
  selectedMessageIds as selectionMessageIds,
  selectedTranscriptText,
  type TranscriptSelection,
} from "./lib/transcriptSelection.js";
import {
  approvePlanModel,
  createPlanModel,
  rejectPlanModel,
  revisePlanModel,
  type PlanModel,
  type PlanRevisionDiff,
} from "./lib/planModel.js";
import { summarizeFileChanges, type FileChangeSummary } from "./lib/toolTransparency.js";
import { contextPressure, type MemoryFitRefusal } from "./lib/localOps.js";
import { LocalEnginePanel } from "./components/LocalEnginePanel.js";
import {
  formatNativeToolCatalog,
  parseNativeTools,
  type NativeToolSummary,
} from "./lib/toolCatalog.js";
import { localModelIdentityAnswer } from "./lib/localAnswers.js";
import {
  fallbackWorkspaceContext,
  inspectWorkspaceContext,
  type WorkspaceContext,
} from "./lib/workspaceContext.js";

const PRIME_POLICY_MODE =
  String(process.env.SOPHIA_PRIME_POLICY || "advisory").trim().toLowerCase() === "full"
    ? "full"
    : "advisory";
const VERBOSE_TRANSCRIPT = verboseTranscriptEnabled();

export interface AppProps {
  model: string;
  mode: string;
  permission: "auto" | "manual" | "readonly";
  session: string;
  cwd: string;
  themeName?: string;
  mock?: boolean;
  initialPrompt?: string;
  mouseMode?: boolean;
  conscienceMode?: ConscienceMode;
  agiWorkflowMode?: "off" | "auto" | "on";
  /** True only when launch argv/env explicitly owns agiWorkflowMode. */
  agiWorkflowOwned?: boolean;
  workflowMode?: DynamicWorkflowMode;
  workflowMaxStages?: number;
  workflowMaxAgents?: number;
  /** Provider-visible event detail only; hidden chain-of-thought is ineligible. */
  thinkingVisibility?: ThinkingVisibility;
  /** Exit the Ink process only after the kernel's run_finished boundary. */
  once?: boolean;
  onRunFinished?: (payload: BridgeEvent) => void;
}

interface TranscriptDragState extends TranscriptSelection {
  startX: number;
  startY: number;
  dragging: boolean;
}

interface VisibleReasoningStreamState {
  scope: ProviderReasoningScope;
  source: ProviderVisibleReasoningSource | null;
  growth: StreamGrowthState;
  draftId: string | null;
  shown: string;
}

const MAX_VISIBLE_REASONING_SCOPES = 64;

type AGIWorkflowMode = "off" | "auto" | "on";

function normalizeAGIWorkflowMode(
  value: unknown,
  fallback: AGIWorkflowMode = "off",
): AGIWorkflowMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "off" || normalized === "auto" || normalized === "on"
    ? normalized
    : fallback;
}

function agiWorkflowRowColor(
  row: AGIWorkflowDetailRow,
  theme: Theme,
): string {
  const status = row.status.toLowerCase();
  if (row.kind === "safety") return theme.dim;
  if (["failed", "cancelled", "interrupted", "evicted", "lost"].includes(status)) {
    return theme.error;
  }
  if (["succeeded", "released"].includes(status)) return theme.success;
  if (
    ["running", "routing", "waiting", "awaiting input", "leased", "verifying"].includes(
      status,
    )
  ) {
    return theme.accent;
  }
  return theme.text;
}

function AGIWorkflowInspector({
  state,
  mode,
  scrollOffset,
  theme,
  width,
  height,
  selectedItemId,
  expandedItemIds,
  mouseMode = false,
  paneTopRow = 1,
  screenLeft = 1,
  onLayout,
  onInteractiveLayout,
}: {
  state: AGIWorkflowState;
  mode: AGIWorkflowMode;
  scrollOffset: number;
  theme: Theme;
  width: number;
  height: number;
  selectedItemId?: string;
  expandedItemIds?: readonly string[];
  mouseMode?: boolean;
  paneTopRow?: number;
  screenLeft?: number;
  onLayout?: (maxScroll: number) => void;
  onInteractiveLayout?: (
    itemIds: string[],
    regions: RightPanelDetailItemRegion[],
  ) => void;
}): React.ReactElement {
  const innerWidth = Math.max(8, width - 4);
  const viewportRows = Math.max(1, height - 5);
  const rows = useMemo(
    () => selectAGIWorkflowDetailRows(state),
    [state],
  );
  const expanded = useMemo(
    () => new Set(expandedItemIds || []),
    [expandedItemIds],
  );
  const visualRows = useMemo(
    () =>
      rows.flatMap((row) => {
        const isSelected = row.id === selectedItemId;
        const isExpanded = expanded.has(row.id);
        const header =
          `${isSelected ? "▸" : " "} ${isExpanded ? "▼" : "▶"} ` +
          `${row.label} · ${row.status}`;
        const lines = [
          { text: header, detail: false },
          ...(isExpanded && row.detail
            ? [{ text: `  ${row.detail}`, detail: true }]
            : []),
        ];
        return lines.flatMap(({ text, detail }) =>
            wrapTextLines(text, innerWidth).map((line) => ({
              id: row.id,
              kind: row.kind,
              color: agiWorkflowRowColor(row, theme),
              bold:
                isSelected
                ||
                row.kind === "run"
                || (row.kind === "agent" && row.status === "running"),
              detail,
              text: line,
            })),
          );
      }),
    [expanded, innerWidth, rows, selectedItemId, theme],
  );
  const maxScroll = Math.max(0, visualRows.length - viewportRows);
  const safeOffset = Math.max(0, Math.min(maxScroll, scrollOffset));
  const visible = visualRows.slice(safeOffset, safeOffset + viewportRows);

  useEffect(() => {
    onLayout?.(maxScroll);
  }, [maxScroll, onLayout]);

  useEffect(() => {
    const itemIds = rows.map((row) => row.id);
    const byId = new Map<string, RightPanelDetailItemRegion>();
    visible.forEach((row, index) => {
      const screenRow = paneTopRow + 3 + index;
      const existing = byId.get(row.id);
      if (existing) {
        existing.screenEndRow = screenRow;
      } else {
        byId.set(row.id, {
          id: row.id,
          screenRow,
          screenEndRow: screenRow,
          screenLeft,
          screenRight: screenLeft + width - 1,
        });
      }
    });
    onInteractiveLayout?.(itemIds, [...byId.values()]);
  }, [
    onInteractiveLayout,
    paneTopRow,
    rows,
    screenLeft,
    visible,
    width,
  ]);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      overflow="hidden"
    >
      <Text color={theme.accent} bold wrap="truncate-end">
        AGI workflow inspector · mode {mode}
      </Text>
      <Text color={theme.dim} wrap="truncate-end">
        Observable agents, tools, statuses, evidence, leases, reuse, and bounded archives only.
      </Text>
      {visible.map((row, index) => (
        <Text
          key={`${row.id}:${safeOffset + index}`}
          color={row.color}
          bold={row.bold}
          wrap="truncate-end"
        >
          {row.text}
        </Text>
      ))}
      <Text color={theme.dim} wrap="truncate-end">
        {maxScroll > 0
          ? `${safeOffset + 1}-${Math.min(
              visualRows.length,
              safeOffset + viewportRows,
            )}/${visualRows.length} · `
          : ""}
        n/p item · Enter/Space expand
        {mouseMode ? " · click/wheel" : ""} · ↑↓ scroll · Esc close ·{" "}
        candidateOnly:true · canClaimAGI:false · hidden reasoning excluded
      </Text>
    </Box>
  );
}

const TRANSCRIPT_DRAG_SCROLL_INTERVAL_MS = 60;
const SESSION_FLOW_WHEEL_BATCH_MS = 16;
const SESSION_FLOW_ZOOM_WHEEL_INTERVAL_MS = 80;

interface SessionFlowPointerDragState {
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  nodeId: string | null;
  dragging: boolean;
}

interface SessionFlowWheelAccumulator {
  dx: number;
  dy: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PendingApproval {
  kind: "tool" | "local";
  id: string;
  tool: string;
  preview: string;
  /** Unified diff of the pending write/edit, when the kernel supplied one (see agent/diff_preview.py). */
  diff?: string;
  /** Kernel-authoritative "safe"|"write"|"exec", preferred over any client-side guess when present. */
  risk?: string;
  destructive?: boolean;
}

export type ApprovalQueueAction =
  | { type: "enqueue"; approval: PendingApproval }
  | { type: "resolve"; id: string }
  | { type: "clear" };

/**
 * FIFO approval queue keyed by bridge/local request id.
 *
 * Replayed bridge events update their existing row in place instead of adding
 * duplicate prompts; distinct concurrent requests retain arrival order.
 */
export function approvalQueueReducer(
  state: PendingApproval[],
  action: ApprovalQueueAction,
): PendingApproval[] {
  if (action.type === "clear") return [];
  if (action.type === "resolve") {
    return state.filter((approval) => approval.id !== action.id);
  }
  const existing = state.findIndex((approval) => approval.id === action.approval.id);
  if (existing < 0) return [...state, action.approval];
  const next = [...state];
  next[existing] = action.approval;
  return next;
}

export interface SessionTransitionPresentation {
  epistemic: null;
  contextUsage: string;
  lastCost: string;
  running: false;
  cancelling: false;
  progress: ProgressState;
  status: string;
}

/** Pure presentation baseline shared by every successful session transition. */
export function createSessionTransitionPresentation(
  status: string,
): SessionTransitionPresentation {
  return {
    epistemic: null,
    contextUsage: "",
    lastCost: "",
    running: false,
    cancelling: false,
    progress: { ...IDLE_PROGRESS },
    status,
  };
}

export function sessionSelectionSettings(result: { ok: boolean; session: string }): {
  session: string;
  selectedSessionID: string;
} | null {
  return result.ok
    ? { session: result.session, selectedSessionID: result.session }
    : null;
}

export function isCoalescedSessionNavigationEnter(raw: string): boolean {
  if (!/[\r\n]$/.test(raw)) return false;
  return /(?:\x1b\[|\x9b)[0-9;?]*[AB]/.test(raw.slice(0, -1));
}

export interface ImageExecutionPolicy {
  delegated: boolean;
  allowed: boolean;
  disclosure: string;
}

/** UI-side guard for providers that delegate execution to an autonomous CLI. */
export function imageExecutionPolicy(
  permission: AppProps["permission"],
  provider: string,
): ImageExecutionPolicy {
  const delegated = provider.trim().toLowerCase().endsWith("-cli");
  return {
    delegated,
    // Every image provider writes an output file, so readonly blocks both
    // delegated CLIs and direct APIs. Delegation only changes the disclosure.
    allowed: permission !== "readonly",
    disclosure: delegated
      ? "Delegated CLI providers may use autonomous filesystem, network, and tool authority."
      : "This may invoke a paid or external image provider.",
  };
}

// Bounds an interactive session's in-memory transcript. Generous on purpose:
// the layout pass has been O(1) amortised since #1555, so this exists to stop
// unbounded RSS growth over a long session, not to keep the UI fast. The full
// run always remains on disk.
const TRANSCRIPT_BUDGET = { maxMessages: 2000, maxChars: 4_000_000 };

// Resolved once from the raw argv the user typed, before flag defaults are
// applied (see lib/sessionResume.ts for why that distinction is load-bearing).
/** Show at most this many unreadable bridge lines before suppressing the rest. */
const UNPARSED_LOG_CAP = 5;
const AUTO_RESUME = shouldAutoResume(process.argv.slice(2), process.env);
/** Settings the operator stated at launch; the ready snapshot must not override them. */
const EXPLICIT_CLI_KEYS = explicitSettingKeys(process.argv.slice(2), process.env);

function laneLifecycle(value: unknown): TeamLaneLifecycle {
  const state = String(value || "").toLowerCase();
  if (state === "queued") return "queued";
  if (state === "running") return "running";
  if (state === "blocked") return "waiting";
  if (state === "succeeded") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "cancelled" || state === "canceled") return "cancelled";
  if (state === "interrupted") return "interrupted";
  if (state === "abandoned") return "abandoned";
  if (state === "cancelling") return "cancelling";
  if (state === "interrupting") return "interrupting";
  return "proposed";
}

function finiteMetric(source: Record<string, unknown> | undefined, names: string[]): number | null {
  if (!source) return null;
  for (const name of names) {
    const value = Number(source[name]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * `/help`'s category grouping needs the catalog's own category id → label
 * list. slash.ts exposes a label per id (categoryLabel) and per-command
 * (help.category_label) but not the ordered list itself, so this derives one
 * from first-appearance order in the generated catalog rather than keeping a
 * second hardcoded copy of agent/slash_catalog.py's CATEGORY_METADATA here —
 * a category renamed or reordered on the Python side is picked up with no
 * change needed in this file.
 */
function helpCategoriesFromCatalog(commands: SlashCommand[]): CategoryMeta[] {
  const seen = new Set<string>();
  const categories: CategoryMeta[] = [];
  for (const command of commands) {
    const id = command.category || "";
    if (seen.has(id)) continue;
    seen.add(id);
    categories.push({ id, label: command.help?.category_label || id });
  }
  return categories;
}

function ModelConnectionsPanel(props: {
  state: ModelConnectionsState;
  theme: Theme;
  width: number;
  height: number;
}): React.ReactElement {
  const { state, theme, width, height } = props;
  const target = state.connections.find((connection) => connection.id === state.removeTargetId);
  const draft = state.draft;
  const valueFor = (field: string): string => {
    if (!draft) return "";
    if (field === "credentialRef") return maskCredentialReference(draft.credentialRef);
    return String(draft[field as keyof ModelConnectionDraft] || "");
  };

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      overflow="hidden"
    >
      <Text color={theme.accent} bold>Custom model endpoints</Text>
      <Text color={theme.dim}>
        Profiles save only env:NAME, keychain:service/account, or none. A masked one-time entry can store a key in the OS keyring.
      </Text>

      {state.view === "list" ? (
        <>
          <Text color={state.selected === 0 ? theme.accent : undefined}>
            {state.selected === 0 ? "› " : "  "}Add custom endpoint…
          </Text>
          {state.connections.map((connection, index) => {
            const active = state.selected === index + 1;
            return (
              <Box key={connection.id} flexDirection="column">
                <Text color={active ? theme.accent : undefined}>
                  {active ? "› " : "  "}{connection.displayName} · {connection.protocol}
                </Text>
                <Text color={theme.dim}>
                  {"    "}{connection.baseUrl} · {connection.model} · {maskCredentialReference(connection.credentialRef)}
                </Text>
                <Text color={theme.dim}>
                  {"    "}connectivity {modelConnectionStatusLabel(connection.checks.connectivity)}
                  {" · "}format {modelConnectionStatusLabel(connection.checks.responseFormat)}
                </Text>
              </Box>
            );
          })}
          {!state.connections.length && !state.pending ? (
            <Text color={theme.dim}>No saved custom endpoints returned by the backend.</Text>
          ) : null}
          <Text color={theme.dim}>
            ↑↓ select · Enter add/edit · c check · f format probe · d remove · r refresh · Esc close
          </Text>
        </>
      ) : state.view === "templates" ? (
        <>
          <Text bold>Select a provider template</Text>
          {MODEL_CONNECTION_TEMPLATES.map((template, index) => (
            <Box key={template.id} flexDirection="column">
              <Text color={state.templateSelected === index ? theme.accent : undefined}>
                {state.templateSelected === index ? "› " : "  "}{template.label}
              </Text>
              <Text color={theme.dim}>    {template.description}</Text>
            </Box>
          ))}
          <Text color={theme.dim}>↑↓ select · Enter continue · Esc back</Text>
        </>
      ) : state.view === "form" && draft ? (
        <>
          <Text bold>{state.editingId ? "Edit endpoint" : "Add custom endpoint"}</Text>
          {MODEL_CONNECTION_FORM_ROWS.map((row, index) => {
            const active = state.formSelected === index;
            return row.kind === "field" ? (
              <Text key={`${row.kind}-${row.field}`} color={active ? theme.accent : undefined}>
                {active ? "› " : "  "}{row.label}: {valueFor(row.field) || "—"}
              </Text>
            ) : (
              <Text key={`${row.kind}-${row.action}`} color={active ? theme.accent : undefined}>
                {active ? "› " : "  "}[{row.label}
                {row.action === "toggle_private_network"
                  ? `: ${draft.allowPrivateNetwork ? "on" : "off"}`
                  : ""}
                ]
              </Text>
            );
          })}
          <Text color={theme.dim}>
            connectivity {modelConnectionStatusLabel(draft.checks.connectivity)}
            {" · "}format {modelConnectionStatusLabel(draft.checks.responseFormat)}
          </Text>
          <Text color={theme.dim}>
            ↑↓/Tab move · type to edit · Backspace delete · Space cycles protocol · Enter activate · Esc discard
          </Text>
        </>
      ) : state.view === "credential_entry" && draft ? (
        <>
          <Text bold>Store API key in the OS keyring</Text>
          <Text>
            Target: {maskCredentialReference(draft.credentialRef)}
          </Text>
          <Text>
            API key: {"•".repeat(Math.min(48, state.credentialInput.length))}
            {state.credentialInput.length > 48 ? "…" : ""}
          </Text>
          <Text color={theme.dim}>
            Paste/type once · Enter store securely · Esc cancel. The value is not written to Sophia config.
          </Text>
        </>
      ) : state.view === "remove_confirm" ? (
        <>
          <Text bold>Remove {target?.displayName || "this endpoint"}?</Text>
          <Text>This deletes the backend-saved connection. y remove · n/Esc cancel</Text>
        </>
      ) : state.view === "repair_consent" ? (
        <>
          <Text bold>Optional repair suggestion</Text>
          <Text>{state.notice || "The endpoint check failed."}</Text>
          <Text>
            Sophia may generate a suggestion only. It will not modify code or saved configuration.
          </Text>
          <Text color={state.repairConsent === "no" ? theme.accent : undefined}>
            {state.repairConsent === "no" ? "› " : "  "}No (default)
          </Text>
          <Text color={state.repairConsent === "yes" ? theme.accent : undefined}>
            {state.repairConsent === "yes" ? "› " : "  "}Yes, request a preview
          </Text>
          <Text color={theme.dim}>↑↓ choose · Enter confirm · n/Esc decline</Text>
        </>
      ) : state.view === "repair_pending" ? (
        <>
          <Text bold>Requesting repair preview…</Text>
          <Text>No code, draft, or saved configuration is being modified.</Text>
        </>
      ) : state.view === "repair_preview" && state.repairSuggestion ? (
        <>
          <Text bold>Repair suggestion preview</Text>
          <Text>{state.repairSuggestion.summary}</Text>
          {Object.entries(state.repairSuggestion.changes).map(([field, value]) => (
            <Text key={field}>
              {field}: {field === "credentialRef" ? maskCredentialReference(value) : String(value)}
            </Text>
          ))}
          <Text>Apply this suggestion to the unsaved draft for review?</Text>
          <Text color={state.repairPreviewApproval === "no" ? theme.accent : undefined}>
            {state.repairPreviewApproval === "no" ? "› " : "  "}No (default)
          </Text>
          <Text color={state.repairPreviewApproval === "yes" ? theme.accent : undefined}>
            {state.repairPreviewApproval === "yes" ? "› " : "  "}Yes, update unsaved draft
          </Text>
          <Text color={theme.dim}>↑↓ choose · Enter confirm · n/Esc close without changes</Text>
        </>
      ) : null}

      {state.pending && state.view !== "repair_pending" ? (
        <Text color={theme.dim}>{state.pending.action.replaceAll("_", " ")} pending…</Text>
      ) : null}
      {state.notice && state.view !== "repair_consent" ? (
        <Text color={state.secretInputRejected ? "yellow" : theme.dim}>{state.notice}</Text>
      ) : null}
    </Box>
  );
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { internal_eventEmitter: inputEvents } = useStdin();
  const accessibility = useAccessibility();
  // Live size — re-renders on terminal resize (wide / tall expansion).
  const { columns: cols, rows, contentWidth } = useTerminalSize(1);

  const [themeName, setThemeName] = useState(props.themeName || "dark");
  const theme: Theme = useMemo(() => resolveTheme(themeName), [themeName]);
  const terminalCapabilities = useMemo(
    () => detectTerminalCapabilities({
      columns: cols,
      isTTY: !!process.stdout.isTTY,
    }),
    [cols],
  );

  const [model, setModel] = useState(props.mock ? "mock" : props.model);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [executionRuntime, setExecutionRuntime] = useState<"sophia" | "prime">("sophia");
  // Models the bridge discovered (local MLX/Ollama/vLLM + cloud options).
  // The /model picker merges these with the static MODEL_OPTIONS presets so
  // locally-cached models like mlx:mlx-community/Qwen3.6-35B-A3B-4bit actually
  // appear as selectable rows — previously the picker showed only the hardcoded
  // preset list and silently threw away the bridge's discovered models array.
  const [bridgeModels, setBridgeModels] = useState<{
    alias: string;
    label?: string;
    setup?: string;
    group?: ModelGroupId;
  }[]>([]);
  const [mode, setMode] = useState(props.mode);
  const [permission, setPermission] = useState(props.permission);
  const initialAGIWorkflowMode = normalizeAGIWorkflowMode(
    props.agiWorkflowMode,
  );
  const [agiWorkflowMode, setAgiWorkflowMode] =
    useState<AGIWorkflowMode>(initialAGIWorkflowMode);
  const agiWorkflowModeRef =
    useRef<AGIWorkflowMode>(initialAGIWorkflowMode);
  agiWorkflowModeRef.current = agiWorkflowMode;
  const agiWorkflowOwnedRef = useRef(!!props.agiWorkflowOwned);
  const [agiWorkflow, setAgiWorkflow] =
    useState<AGIWorkflowState>(EMPTY_AGI_WORKFLOW_STATE);
  const agiWorkflowRef = useRef<AGIWorkflowState>(EMPTY_AGI_WORKFLOW_STATE);
  agiWorkflowRef.current = agiWorkflow;
  const dispatchAgiWorkflow = useCallback((ev: AGIWorkflowEvent) => {
    setAgiWorkflow((prev) => {
      const next = agiWorkflowReducer(prev, ev);
      agiWorkflowRef.current = next;
      return next;
    });
  }, []);
  const initialAGIWorkflowEnabled = initialAGIWorkflowMode !== "off";
  // Legacy Team mode is retired from the TUI. Keep the wire values pinned off
  // while older kernels/config files still understand them.
  const [autoTeam, setAutoTeam] = useState<boolean | undefined>(false);
  const autoTeamRef = useRef<boolean | undefined>(false);
  autoTeamRef.current = autoTeam;
  const initialWorkflowMode = initialAGIWorkflowEnabled
    ? "off"
    : props.workflowMode ?? "off";
  const [workflowMode, setWorkflowMode] = useState<DynamicWorkflowMode>(
    initialWorkflowMode,
  );
  const workflowModeRef = useRef<DynamicWorkflowMode>(initialWorkflowMode);
  workflowModeRef.current = workflowMode;
  const [workflowMaxStages, setWorkflowMaxStages] = useState(
    Math.max(1, Math.floor(props.workflowMaxStages ?? 6)),
  );
  const workflowMaxStagesRef = useRef(workflowMaxStages);
  workflowMaxStagesRef.current = workflowMaxStages;
  const [workflowMaxAgents, setWorkflowMaxAgents] = useState(
    Math.max(2, Math.floor(props.workflowMaxAgents ?? 24)),
  );
  const workflowMaxAgentsRef = useRef(workflowMaxAgents);
  workflowMaxAgentsRef.current = workflowMaxAgents;
  const [dynamicWorkflow, setDynamicWorkflow] =
    useState<DynamicWorkflowState>(() => ({
      ...EMPTY_DYNAMIC_WORKFLOW_STATE,
      configuredMode: initialWorkflowMode,
      maxStages: Math.max(1, Math.floor(props.workflowMaxStages ?? 6)),
      maxAgents: Math.max(2, Math.floor(props.workflowMaxAgents ?? 24)),
    }));
  const dispatchDynamicWorkflow = useCallback((ev: DynamicWorkflowEvent) => {
    setDynamicWorkflow((prev) => dynamicWorkflowReducer(prev, ev));
  }, []);
  const [runEta, dispatchRunEta] = React.useReducer(
    runEtaReducer,
    EMPTY_RUN_ETA_STATE,
  );
  const [runEtaClockMs, setRunEtaClockMs] = useState(() => Date.now());
  useEffect(() => {
    if (
      runEta.status === "idle"
      || runEta.status === "complete"
    ) {
      return;
    }
    setRunEtaClockMs(Date.now());
    const timer = setInterval(() => setRunEtaClockMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [
    runEta.status,
    runEta.estimatedRemainingSec,
    runEta.estimateAsOfMs,
  ]);
  const rightPanelEta = useMemo<RightPanelEtaSnapshot>(() => {
    const status =
      runEta.status === "idle" ? "unavailable" : runEta.status;
    const remainingSec = runEtaRemainingSec(runEta, runEtaClockMs);
    const estimatedTotalSec = runEtaEstimatedTotalSec(runEta, runEtaClockMs);
    return {
      status,
      remainingSec,
      elapsedSec: runEtaElapsedSec(runEta, runEtaClockMs),
      estimatedTotalSec,
      confidence:
        remainingSec == null && estimatedTotalSec == null
          ? null
          : runEta.confidence,
      terminalOk: runEta.terminalOk,
      basis: runEta.basis,
      updatedAt:
        runEta.estimateAsOfMs == null
          ? undefined
          : new Date(runEta.estimateAsOfMs).toISOString(),
    };
  }, [runEta, runEtaClockMs]);
  /** A2A chain length: 0 = off, -1 = auto, ≥2 fixed legacy total. */
  const initialWorkflowA2a =
    initialAGIWorkflowEnabled || initialWorkflowMode !== "off" ? -1 : 0;
  const [a2aAgents, setA2aAgents] = useState(initialWorkflowA2a);
  const a2aAgentsRef = useRef(initialWorkflowA2a);
  a2aAgentsRef.current = a2aAgents;
  const [a2aExecution, setA2aExecution] = useState<"embedded" | "terminal" | "headless">(
    initialAGIWorkflowEnabled || initialWorkflowMode !== "off"
      ? "terminal"
      : "embedded",
  );
  const a2aExecutionRef = useRef<"embedded" | "terminal" | "headless">(
    initialAGIWorkflowEnabled || initialWorkflowMode !== "off"
      ? "terminal"
      : "embedded",
  );
  a2aExecutionRef.current = a2aExecution;
  const [a2aConcurrency, setA2aConcurrency] = useState<number | null>(null);
  const [terminalLayout, setTerminalLayout] = useState<"off" | "auto" | "splits" | "windows" | "headless">("auto");
  const terminalLayoutRef = useRef<"off" | "auto" | "splits" | "windows" | "headless">("auto");
  terminalLayoutRef.current = terminalLayout;
  const [a2a, setA2a] = useState<A2AState>(EMPTY_A2A_STATE);
  const dispatchA2a = useCallback((ev: A2AEvent) => {
    setA2a((prev) => a2aReducer(prev, ev));
  }, []);
  const [agiMode, setAgiMode] = useState(initialAGIWorkflowEnabled);
  const agiModeRef = useRef(initialAGIWorkflowEnabled);
  agiModeRef.current = agiMode;
  const [agiProfile, setAgiProfile] = useState<AGIProfile>("balanced");
  const agiProfileRef = useRef<AGIProfile>("balanced");
  agiProfileRef.current = agiProfile;
  const [agiRoute, setAgiRoute] = useState<AGIRoute>("auto");
  const agiRouteRef = useRef<AGIRoute>("auto");
  agiRouteRef.current = agiRoute;
  const [agiPlannerModel, setAgiPlannerModel] = useState("");
  const agiPlannerModelRef = useRef("");
  agiPlannerModelRef.current = agiPlannerModel;
  const [agiWorkerModel, setAgiWorkerModel] = useState("");
  const agiWorkerModelRef = useRef("");
  agiWorkerModelRef.current = agiWorkerModel;
  const [agiVerifierModel, setAgiVerifierModel] = useState("");
  const agiVerifierModelRef = useRef("");
  agiVerifierModelRef.current = agiVerifierModel;
  const [agi, setAgi] = useState<AGIState>(EMPTY_AGI_STATE);
  const agiRef = useRef<AGIState>(EMPTY_AGI_STATE);
  agiRef.current = agi;
  const dispatchAgi = useCallback((ev: AGIEvent) => {
    setAgi((prev) => agiReducer(prev, ev));
  }, []);
  const [semanticFallbackModel, setSemanticFallbackModel] = useState<string | null>(null);
  const [semanticFallbackPolicy, setSemanticFallbackPolicy] =
    useState<"off" | "confirm">("off");
  const [semanticReturnToPrimary, setSemanticReturnToPrimary] = useState(true);
  const [conscienceMode, setConscienceMode] = useState<ConscienceMode>(
    props.conscienceMode ?? "off",
  );
  const conscienceModeRef = useRef<ConscienceMode>(conscienceMode);
  conscienceModeRef.current = conscienceMode;
  const [thinkingVisibility, setThinkingVisibility] = useState<ThinkingVisibility>(
    props.thinkingVisibility || "full",
  );
  const thinkingVisibilityRef = useRef(thinkingVisibility);
  thinkingVisibilityRef.current = thinkingVisibility;
  const [keymap, setKeymap] = useState<KeymapMode>("default");
  const [imageProvider, setImageProvider] = useState("none");
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const notificationsEnabledRef = useRef(notificationsEnabled);
  notificationsEnabledRef.current = notificationsEnabled;
  const [notificationToast, setNotificationToast] = useState<NotificationRequest | null>(null);
  const notificationDeliveredAtRef = useRef<number | null>(null);
  const [showAccessibility, setShowAccessibility] = useState(false);
  const [showPluginManager, setShowPluginManager] = useState(false);
  const [pluginManager, dispatchPluginManager] = React.useReducer(
    pluginManagerReducer,
    INITIAL_PLUGIN_MANAGER_STATE,
  );
  const pluginManagerRef = useRef(pluginManager);
  pluginManagerRef.current = pluginManager;
  const updatePluginManager = useCallback(
    (action: PluginManagerAction) => {
      const next = pluginManagerReducer(pluginManagerRef.current, action);
      pluginManagerRef.current = next;
      dispatchPluginManager(action);
      return next;
    },
    [],
  );
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeSnapshot>(
    () => parseReadyRuntime({}),
  );
  const runtimeSnapshotRef = useRef(runtimeSnapshot);
  runtimeSnapshotRef.current = runtimeSnapshot;
  const terminalCapabilitiesRef = useRef(terminalCapabilities);
  terminalCapabilitiesRef.current = terminalCapabilities;
  const [availableSkills, setAvailableSkills] = useState<Record<string, unknown>[]>([]);
  const [availableTools, setAvailableTools] = useState<NativeToolSummary[]>([]);
  const [imageProviderOptions, setImageProviderOptions] = useState<string[]>([]);
  const [lastCost, setLastCost] = useState("");
  const bridgeEventsRef = useRef<Record<string, unknown>[]>([]);
  const runReceiptsRef = useRef<RunReceipt[]>([]);
  const [effort, setEffort] = useState(
    () => normalizeEffort(process.env.SOPHIA_REASONING_EFFORT) ?? "medium",
  );
  const [deepMode, setDeepMode] = useState(false);
  const [responseStyle, setResponseStyle] = useState<ResponseStyle>("adaptive");
  const responseStyleRef = useRef<ResponseStyle>(responseStyle);
  responseStyleRef.current = responseStyle;
  const applyResponseStyle = useCallback((style: ResponseStyle) => {
    // Update synchronously as well as through React state: `ready` can arrive in
    // the same tick as /style, and its process-scoped callback otherwise sees
    // the boot-time "adaptive" closure and writes that stale value back.
    responseStyleRef.current = style;
    setResponseStyle(style);
  }, []);
  const [activePicker, setActivePicker] = useState<{
    kind: PickerKind;
    selected: number;
  } | null>(null);
  const activePickerRef = useRef<typeof activePicker>(null);
  const openPickerRef = useRef<(kind: PickerKind) => void>(() => undefined);
  /** Type-to-filter text for the currently open OptionPicker. Reset to ""
   *  wherever a picker is (re)opened with a new kind — see openPicker below —
   *  so a leftover query from the previous picker never silently hides rows
   *  in the next one. */
  const [pickerFilterQuery, setPickerFilterQuery] = useState("");
  const pickerFilterQueryRef = useRef("");
  pickerFilterQueryRef.current = pickerFilterQuery;
  const [expandedModelGroups, setExpandedModelGroups] = useState<ModelGroupId[]>([]);
  const expandedModelGroupsRef = useRef(expandedModelGroups);
  expandedModelGroupsRef.current = expandedModelGroups;
  const modelGroupToggleRef = useRef({ value: "", at: 0 });
  const onboardingQueueRef = useRef<OnboardingStep[]>([]);
  const pickerReadyRef = useRef(false);
  // Bench multi-pick loop: non-null while `/bench` (with no args) is collecting
  // model specs through the model picker. `benchPickAtRef` de-dupes the twin
  // delivery of a single Enter — Ink's `useInput` (→ handlePickerInput) and the
  // raw `inputEvents` fallback (→ confirmPicker) BOTH fire on the same keypress.
  // The normal picker flow is idempotent only because it NULLS the picker; this
  // loop re-opens it instead, so the timestamp guard is what keeps one Enter
  // from adding a model twice.
  const benchPickRef = useRef<string[] | null>(null);
  const benchPickAtRef = useRef(0);
  // Which benchmark the /bench flow runs: 'knowledge' (prose Q&A corpus) or
  // 'tool-use' (drive each model through the real Sophia tool loop, score S1-S6
  // + speed). Chosen via the benchMode picker before models are collected.
  const benchModeRef = useRef<"knowledge" | "tool-use" | "trigger">("knowledge");
  const lastCtrlCRef = useRef(0);
  const [exitHint, setExitHint] = useState(false);
  const [session, setSession] = useState(props.session);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [cwd] = useState(props.cwd);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext>(
    () => fallbackWorkspaceContext(props.cwd),
  );
  useEffect(() => {
    let active = true;
    void inspectWorkspaceContext(cwd).then((next) => {
      if (active) setWorkspaceContext(next);
    });
    return () => {
      active = false;
    };
  }, [cwd]);
  const [sessionOptions, setSessionOptions] = useState<{ value: string; label: string; hint?: string }[]>([]);
  // Rich rows behind the full-screen SessionBrowser (topic · turns · recency ·
  // id). Kept alongside sessionOptions so the compact OptionPicker paths and the
  // browser share one disk read.
  const [sessionRows, setSessionRows] = useState<SessionListItem[]>([]);
  const [sessionPicker, setSessionPicker] = useState<{ selected: number } | null>(null);
  const sessionPickerRef = useRef<typeof sessionPicker>(null);
  // Arms the raw-stdin Enter backup once ↑↓ navigates the browser (see
  // confirmSessionBrowser); mirrors pickerReadyRef for the model/effort picker.
  const sessionPickerReadyRef = useRef(false);
  const sessionRowsRef = useRef(sessionRows);
  sessionRowsRef.current = sessionRows;
  // Run-status header lines drawn above the SessionBrowser when it is opened by
  // /status (null for /resume, which shows the list without a header).
  const [sessionBrowserHeader, setSessionBrowserHeader] = useState<string[] | null>(null);
  const [sessionBrowserQuery, setSessionBrowserQuery] = useState<string | null>(null);
  const sessionBrowserQueryRef = useRef<string | null>(null);
  const [sessionBrowserTotalMatches, setSessionBrowserTotalMatches] = useState(0);
  const sessionSearchRequestRef = useRef(0);
  /** Legacy bridge field, pinned to one lane; Workflow/A2A own fan-out. */
  const [teamAgents, setTeamAgents] = useState<number | undefined>(1);
  const teamRef = useRef<number | undefined>(1);
  teamRef.current = teamAgents;
  /**
   * Whether a stall has already been announced for the current wedge.
   *
   * A ref, not state: the stall detector re-fires on every poll while the
   * kernel stays silent, and this only exists to make the transcript row an
   * EDGE event. Holding it in state would re-render the whole app on a signal
   * that changes nothing visible after the first one.
   */
  /** Latest "context N% of 500k" line, appended to the status after a run. */
  const contextUsageRef = useRef("");
  const stalledRef = useRef(false);
  const activeRunIdRef = useRef<string | null>(null);
  const steerPendingRef = useRef<{ text: string; requestId: string } | null>(null);
  // A steer typed after a run is submitted but before its run_start confirms the
  // new runId must not be sent with the previous run's id (the bridge would
  // reject it as a run/session mismatch). Hold it here and flush on run_start.
  const bufferedSteerRef = useRef<{ text: string; session: string; requestId: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  // A positional startup prompt must not race a selected plugin profile. The
  // bridge's ready payload names the selection, then the TUI re-applies that
  // reference through CodeBridge so the policy-validated settings patch lands
  // before submitLine reads workflowMaxStages/workflowMaxAgents refs.
  const [startupProfileApplied, setStartupProfileApplied] = useState(
    !props.initialPrompt,
  );
  const [status, setStatus] = useState("starting bridge…");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [epistemic, setEpistemic] = useState<EpistemicStatus | null>(null);
  const epistemicRef = useRef<EpistemicStatus | null>(null);
  // True once the named session file has been hydrated into the message list
  // (or confirmed empty). Until then the UI must not look "ready with no history"
  // and must not fire initialPrompt over an unhydrated transcript.
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [input, setInput] = useState("");
  const inputRef = useRef("");
  inputRef.current = input;
  const draftKey = useMemo(() => draftKeyForWorkspace(cwd, session), [cwd, session]);
  const draftAutosaveRef = useRef<DraftAutosave | null>(null);
  const draftLoadedRef = useRef(false);
  // Prompt history: arrow-up/down recall using the standard shell convention.
  // Persists across TUI restarts via prompt_history.jsonl.
  const historyRef = useRef<PromptHistory | null>(null);
  if (historyRef.current === null) {
    historyRef.current = new PromptHistory({ loadFromDisk: true });
  }
  const setInputFromHistory = useCallback((text: string) => {
    inputRef.current = text;
    setInput(text);
  }, []);
  const onHistoryPrev = useCallback((): string | null => {
    const h = historyRef.current;
    if (!h) return null;
    const prev = h.up(inputRef.current);
    if (prev === null) return null;
    setInputFromHistory(prev);
    return prev;
  }, [setInputFromHistory]);
  const onHistoryNext = useCallback((currentDraft?: string): string | null => {
    const h = historyRef.current;
    if (!h) return null;
    // Forward what is actually in the box. Without this the history model
    // cannot tell an untouched recall from one the user edited, and the edit is
    // silently discarded on the next Up/Down.
    const next = h.down(currentDraft ?? inputRef.current);
    if (next === null) return null;
    setInputFromHistory(next);
    return next;
  }, [setInputFromHistory]);
  const onReverseSearch = useCallback((currentValue: string): string | null => {
    const query = currentValue.trim().toLowerCase();
    const entries = historyRef.current?.entries || [];
    return [...entries].reverse().find((entry) =>
      entry.toLowerCase().includes(query) && entry !== currentValue
    ) || null;
  }, []);
  const [slashSelected, setSlashSelected] = useState(0);
  const [approvalQueue, dispatchApprovalQueue] = React.useReducer(approvalQueueReducer, []);
  const approvalQueueRef = useRef<PendingApproval[]>(approvalQueue);
  approvalQueueRef.current = approvalQueue;
  const updateApprovalQueue = useCallback((action: ApprovalQueueAction): PendingApproval[] => {
    const next = approvalQueueReducer(approvalQueueRef.current, action);
    approvalQueueRef.current = next;
    dispatchApprovalQueue(action);
    return next;
  }, []);
  const pendingApproval = approvalQueue[0] || null;
  const pendingLocalActionsRef = useRef(new Map<string, () => void>());
  /** Tools the operator granted "always allow ... for this session" for, via
   *  PermissionDialog's [a] affordance. In-memory only (a plain ref, never
   *  written to disk, never restored) — it MUST NOT survive a restart, and it
   *  MUST NOT auto-approve a destructive request even for a tool already in
   *  this set (see the approval_request handler and the [a] key branch
   *  below, both of which check `!destructive` before honouring it). */
  const sessionAllowedToolsRef = useRef<Set<string>>(new Set());
  const handleAlwaysAllowTool = useCallback((tool: string) => {
    sessionAllowedToolsRef.current.add(tool);
  }, []);
  const [workflow, dispatchWorkflow] = React.useReducer(workflowReducer, EMPTY_WORKFLOW_STATE);
  const workflowRef = useRef<WorkflowState>(workflow);
  workflowRef.current = workflow;
  const teamLaneState = useMemo<TeamLaneState>(() => {
    const nodes = teamLaneNodes(workflow);
    const lanes = nodes.map((node) => {
      const detail = node.detail || {};
      const timings = node.timings || {};
      const tokens = node.tokens || {};
      const lifecycle = laneLifecycle(node.state);
      const budgets = emptyLaneBudgets();
      budgets.tokens.used = finiteMetric(tokens, [
        "totalTokens", "total_tokens", "outputTokens", "output_tokens",
      ]);
      budgets.tokens.limit = finiteMetric(detail, ["tokenBudget", "tokenLimit"]);
      budgets.timeMs.used = finiteMetric(timings, ["elapsedMs", "durationMs"]);
      budgets.timeMs.limit = finiteMetric(detail, ["timeBudgetMs", "timeoutMs"]);
      budgets.tools.used = finiteMetric(detail, ["toolCalls", "toolsUsed"]);
      budgets.tools.limit = finiteMetric(detail, ["toolBudget", "toolLimit"]);
      if (detail.budgetEnforced === true) {
        for (const metric of [budgets.tokens, budgets.timeMs, budgets.tools]) {
          metric.source = "kernel-reported";
          metric.enforcement = "kernel-reported";
        }
      }
      return {
        id: node.taskId,
        title: node.title || node.name || node.taskId,
        role: String(detail.role || node.name || ""),
        division:
          typeof detail.division === "string" ? detail.division : undefined,
        source: typeof detail.source === "string" ? detail.source : undefined,
        skills: Array.isArray(detail.skills)
          ? detail.skills
              .map((skill) => String(skill || "").trim())
              .filter(Boolean)
          : undefined,
        lifecycle,
        control: {
          cancel: lifecycle === "cancelling" ? "acknowledged" as const : "none" as const,
          interrupt: lifecycle === "interrupting" ? "acknowledged" as const : "none" as const,
        },
        budgets,
        result: {
          state:
            lifecycle === "succeeded"
              ? "ready" as const
              : lifecycle === "failed"
                ? "failed" as const
                : lifecycle === "abandoned"
                  ? "excluded" as const
                  : "none" as const,
          summary: typeof detail.summary === "string" ? detail.summary : undefined,
        },
        detail: typeof node.blockedReason === "string" ? node.blockedReason : undefined,
        startedAt: node.startedAt || undefined,
        endedAt: node.finishedAt || undefined,
      };
    });
    const active = lanes.some((lane) =>
      !["succeeded", "failed", "cancelled", "interrupted", "abandoned"].includes(lane.lifecycle)
    );
    const failed = lanes.some((lane) => lane.lifecycle === "failed");
    return {
      storage: "local-only",
      dispatch: resolveTeamDispatchPolicy({
        savedPolicy: autoTeam ? "auto" : "off",
      }),
      taskEligible: lanes.length > 1,
      lanes,
      merge: {
        state: !lanes.length ? "idle" : active ? "collecting" : failed ? "failed" : "ready",
        includedLaneIds: lanes.filter((lane) => lane.result.state !== "excluded").map((lane) => lane.id),
        excludedLaneIds: lanes.filter((lane) => lane.result.state === "excluded").map((lane) => lane.id),
        conflicts: [],
      },
      selectedLaneId: workflow.selectedId,
    };
  }, [autoTeam, workflow]);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const workflowCursorRef = useRef(0);
  /** Correlation ids for task snapshots the user explicitly asked to see. */
  const workflowRequestRef = useRef(new Set<string>());
  /** Snapshots requested after a successful /resume, used to report durable team recovery once. */
  const teamResumeRequestRef = useRef(new Set<string>());
  // OKF graph projection panel (/graph). Fed from a MOCK projection until it
  // subscribes to the `sophia_dump_graph` bridge event — see the /graph handler.
  const [graph, dispatchGraph] = React.useReducer(graphProjectionReducer, EMPTY_GRAPH_PROJECTION_STATE);
  const graphRef = useRef<GraphProjectionState>(graph);
  graphRef.current = graph;
  const [showGraph, setShowGraph] = useState(false);
  const graphCursorRef = useRef(0);
  const [planModeState, setPlanModeState] = useState<PlanModeState | null>(null);
  const planModeRef = useRef<PlanModeState | null>(planModeState);
  planModeRef.current = planModeState;
  const [showPlanMode, setShowPlanMode] = useState(false);
  const planCursorRef = useRef(0);
  // Local-engine operations panel (LocalEnginePanel.tsx) — a full-pane
  // takeover of the same slot GraphPanel/AccessibilityPanel use. /local (or
  // /engines) opens it and kicks off a fresh runtime/adapter probe.
  const [showLocalEngine, setShowLocalEngine] = useState(false);
  const [modelConnections, dispatchModelConnections] = React.useReducer(
    modelConnectionsReducer,
    INITIAL_MODEL_CONNECTIONS_STATE,
  );
  const modelConnectionsRef = useRef(modelConnections);
  modelConnectionsRef.current = modelConnections;
  // Read-only ARC2/ARC3 operator view. The helper executes only the explicit
  // status/plan JSON commands; this panel has no submit, public-eval, or
  // sealed-run stop action.
  const [arcCampaignPanel, setArcCampaignPanel] =
    useState<ArcCampaignPanelState | null>(null);
  const [showArcCampaign, setShowArcCampaign] = useState(false);
  const arcCampaignRequestRef = useRef(0);
  // Goal/todo side panel. `goal` folds the kernel's goal_* / run_start / result
  // events into a persistent "current goal" (see lib/goalState.ts); the to-do
  // list is derived from the workflow nodes already reduced above. Default
  // VISIBLE — the operator wants goal+progress in view at a glance; /panel and
  // Esc toggle it, and it auto-hides on narrow terminals (see the render tree).
  const [goal, dispatchGoal] = React.useReducer(goalReducer, EMPTY_GOAL_STATE);
  const [todo, dispatchTodo] = React.useReducer(todoReducer, EMPTY_TODO_STATE);
  const [sessionFlow, dispatchSessionFlow] = React.useReducer(
    sessionFlowReducer,
    { ...EMPTY_SESSION_FLOW_STATE, sessionId: props.session },
  );
  const sessionFlowRunSessionsRef = useRef(new Map<string, string>());
  const sessionFlowRef = useRef<SessionFlowState>(sessionFlow);
  sessionFlowRef.current = sessionFlow;
  const [sessionFlowInteraction, dispatchSessionFlowInteraction] =
    React.useReducer(
      sessionFlowInteractionReducer,
      EMPTY_SESSION_FLOW_INTERACTION,
    );
  const sessionFlowInteractionRef = useRef(sessionFlowInteraction);
  sessionFlowInteractionRef.current = sessionFlowInteraction;
  const sessionFlowFocusNodeId =
    currentHierarchyFocusId(sessionFlowInteraction);
  const sessionFlowProjectionKey =
    `${sessionFlowInteraction.detailLevel}:${sessionFlowFocusNodeId || "root"}`;
  const sessionFlowPresentation = useMemo(
    () =>
      presentSessionFlowHierarchy(
        sessionFlow,
        {
          level: sessionFlowInteraction.detailLevel,
          ...(sessionFlowFocusNodeId
            ? { focusNodeId: sessionFlowFocusNodeId }
            : {}),
        },
        dynamicWorkflow,
        agiWorkflow,
      ),
    [
      agiWorkflow,
      dynamicWorkflow,
      sessionFlow,
      sessionFlowFocusNodeId,
      sessionFlowInteraction.detailLevel,
    ],
  );
  const sessionFlowPresentationRef = useRef(sessionFlowPresentation);
  sessionFlowPresentationRef.current = sessionFlowPresentation;
  const sessionFlowProjectionKeyRef = useRef(sessionFlowProjectionKey);
  sessionFlowProjectionKeyRef.current = sessionFlowProjectionKey;
  const sessionFlowPanelLayoutRef =
    useRef<SessionFlowPanelLayoutReport | null>(null);
  const [sessionFlowViewportSnapshot, setSessionFlowViewportSnapshot] =
    useState<SessionFlowViewportSnapshot | null>(null);
  const [sessionFlowPanelSelectedId, setSessionFlowPanelSelectedId] =
    useState<string | null>(null);
  const sessionFlowMiniMapLayoutRef =
    useRef<SessionFlowMiniMapScreenReport | null>(null);
  const sessionFlowPointerDragRef =
    useRef<SessionFlowPointerDragState | null>(null);
  const sessionFlowLastClickRef =
    useRef<{ nodeId: string; at: number } | null>(null);
  const sessionFlowWheelRef = useRef<SessionFlowWheelAccumulator>({
    dx: 0,
    dy: 0,
    timer: null,
  });
  const sessionFlowZoomWheelAtRef = useRef(0);
  const [showPanel, setShowPanel] = useState(true);
  // Ref mirror so the (memoized) /panel handler toggles the LIVE value, not a
  // stale closure — same pattern as workflowRef/graphRef just above.
  const showPanelRef = useRef(showPanel);
  showPanelRef.current = showPanel;
  const [rightPanelDetail, dispatchRightPanelDetail] = React.useReducer(
    rightPanelDetailReducer,
    EMPTY_RIGHT_PANEL_DETAIL,
  );
  const rightPanelDetailRef = useRef(rightPanelDetail);
  rightPanelDetailRef.current = rightPanelDetail;
  const [rightPanelMaxScroll, setRightPanelMaxScroll] = useState(0);
  const rightPanelMaxScrollRef = useRef(rightPanelMaxScroll);
  rightPanelMaxScrollRef.current = rightPanelMaxScroll;
  const rightPanelHitRegionsRef = useRef<RightPanelHitRegion[]>([]);
  const rightPanelDetailItemIdsRef = useRef<string[]>([]);
  const rightPanelDetailItemRegionsRef =
    useRef<RightPanelDetailItemRegion[]>([]);
  const rightPanelMouseDownRef = useRef(false);
  // Every full-pane panel (WorkflowTree/GraphPanel/AccessibilityPanel/
  // PluginManager/PlanPanel/LocalEnginePanel/ModelConnections/ARC campaign) shares one pane,
  // but each used to be opened
  // by its own `setShowX(true)` call with no idea any sibling was already
  // showing — the global key handler then closed them via a SEQUENCE of
  // independent `if (showX) {...; return;}` blocks, so Escape closed
  // whichever one that sequence reached first, never necessarily the one on
  // screen (reproduced: /tasks then /graph needs two Escapes). Every opener
  // below now runs this first so at most one of the five is ever true.
  const closeOtherFullPanePanels = useCallback(
    (
      keep:
        | "workflow"
        | "graph"
        | "accessibility"
        | "pluginManager"
        | "plan"
        | "localEngine"
        | "modelConnections"
        | "arcCampaign"
        | "rightPanel",
    ) => {
      if (keep !== "workflow") setShowWorkflow(false);
      if (keep !== "graph") setShowGraph(false);
      if (keep !== "accessibility") setShowAccessibility(false);
      if (keep !== "pluginManager") setShowPluginManager(false);
      if (keep !== "plan") setShowPlanMode(false);
      if (keep !== "localEngine") setShowLocalEngine(false);
      if (keep !== "modelConnections") dispatchModelConnections({ type: "close" });
      if (keep !== "arcCampaign") setShowArcCampaign(false);
      if (keep !== "rightPanel") {
        dispatchRightPanelDetail({ type: "close" });
      }
    },
    [],
  );

  // Chat scroll + collapse
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollOffsetRef = useRef(scrollOffset);
  scrollOffsetRef.current = scrollOffset;
  const [maxScroll, setMaxScroll] = useState(0);
  const [focusedMsgId, setFocusedMsgId] = useState<string | null>(null);
  const focusedMsgIdRef = useRef<string | null>(null);
  focusedMsgIdRef.current = focusedMsgId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [transcriptSelection, setTranscriptSelection] =
    useState<TranscriptSelection | null>(null);
  const transcriptSelectionRef = useRef<TranscriptSelection | null>(null);
  transcriptSelectionRef.current = transcriptSelection;
  const [transcriptDragActive, setTranscriptDragActive] = useState(false);
  const transcriptDragRef = useRef<TranscriptDragState | null>(null);
  const transcriptLastMouseRef = useRef<{ x: number; y: number } | null>(null);
  const transcriptDragAutoScrollRef = useRef<{ delta: number } | null>(null);
  /** Double-click detect for select-all + auto-copy of one chat row. */
  const lastClickRef = useRef<{ id: string; at: number } | null>(null);
  const [progress, setProgress] = useState<ProgressState>(IDLE_PROGRESS);
  const hitRegionsRef = useRef<MessageHitRegion[]>([]);
  const stickBottomRef = useRef(true);
  const mouseDecoderRef = useRef(new TerminalInputDecoder());
  const highlightedMessageIds = useMemo(
    () => selectionMessageIds(messages, transcriptSelection),
    [messages, transcriptSelection],
  );

  /** Select-all for one message (or multi-row selection text) and copy to clipboard. */
  const copyTranscriptSelection = useCallback(
    (selection: TranscriptSelection | null, label?: string) => {
      const msgs = messagesRef.current;
      const text = selectedTranscriptText(msgs, selection);
      const ids = selectionMessageIds(msgs, selection);
      if (!text) {
        setStatus("selection contained no copyable transcript text");
        return false;
      }
      const copied = copyToClipboard(text);
      const count = ids.size;
      setStatus(
        copied.ok
          ? `${copied.message} · ${label || `${count} message${count === 1 ? "" : "s"}`} selected · Esc clears`
          : `${count} message${count === 1 ? "" : "s"} selected · ${copied.message}`,
      );
      return copied.ok;
    },
    [],
  );

  const selectAllAndCopyMessage = useCallback(
    (messageId: string) => {
      const out = selectAllMessageAndCopy(messagesRef.current, messageId);
      if (out.selection) {
        transcriptSelectionRef.current = out.selection;
        setTranscriptSelection(out.selection);
        setFocusedMsgId(messageId);
        focusedMsgIdRef.current = messageId;
      }
      setStatus(
        out.result.ok
          ? `${out.result.message} · select-all ${out.label} · Esc clears`
          : `select-all failed · ${out.result.message}`,
      );
      return out.result.ok;
    },
    [],
  );

  // ── Frontier kernel-capability state ───────────────────────────────────
  // Every field below is populated by a bridge event an older kernel build
  // never sends, so each starts null/empty and stays that way until the
  // matching event actually arrives — never a fabricated default. None of
  // this changes render output yet; it exists so the next wiring pass has a
  // real value to pass into StatusLine/PermissionDialog/LocalEnginePanel/
  // PlanPanel instead of another round of event-shape archaeology.

  /** Latest per-turn telemetry sample from the `result` event (tokens/ttft/
   *  tok-per-sec/cost), plus a running per-session cost total kept separate
   *  from `lastCost` (that stays a display string reset independently on a
   *  session transition — see resetSessionTransitionState). */
  const [runTelemetry, setRunTelemetry] = useState<{
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    ttftMs?: number;
    tokensPerSec?: number;
  } | null>(null);
  const runTelemetryRef = useRef(runTelemetry);
  runTelemetryRef.current = runTelemetry;
  const [sessionCostUsd, setSessionCostUsd] = useState(0);
  const sessionCostUsdRef = useRef(0);

  /** Real (kernel-reported) context usage, alongside contextUsageRef's display
   *  string above. `window` is seeded as soon as `ready`/`config`/`state`
   *  reports the model's modelContextWindow, then `used`/`budget`/`source`
   *  are filled in per turn once a `result` arrives — `source` says whether
   *  `used` is a real provider-reported count or a char/4 estimate, so a
   *  future renderer can show that honestly instead of implying precision
   *  the kernel does not have. */
  const [contextTelemetry, setContextTelemetry] = useState<{
    used?: number;
    window?: number | null;
    budget?: number;
    source?: "reported" | "estimated";
  } | null>(null);
  const contextTelemetryRef = useRef(contextTelemetry);
  contextTelemetryRef.current = contextTelemetry;

  /** Local-engine operational state: the machine-wide runtime report, the
   *  active LoRA/adapter, and preflight results keyed by the spec they were
   *  checked against (a stale reply for a spec the operator already switched
   *  away from must never overwrite a newer one). `memoryFitRefusal` has no
   *  live producer yet — no kernel build attaches those fields to an error
   *  event today (see lib/types.ts's own MemoryFitRefusal doc comment) — so
   *  it stays null until one does; the slot exists so that wiring is a
   *  one-line change rather than another type-and-state change together. */
  const [localEngineRuntimeReport, setLocalEngineRuntimeReport] =
    useState<LocalEngineReportEvent | null>(null);
  const [localAdapterStatus, setLocalAdapterStatus] = useState<AdapterStatusEvent | null>(null);
  const [modelPreflightBySpec, setModelPreflightBySpec] =
    useState<Record<string, ModelPreflightEvent>>({});
  const [memoryFitRefusal, setMemoryFitRefusal] =
    useState<(MemoryFitRefusal & { modelId?: string }) | null>(null);

  /** Loaded hook config (`{"cmd":"hooks"}`'s reply) plus a bounded, newest-
   *  first dispatch log fed by both that reply's own `recent` history and the
   *  live `hook_dispatch` push event that fires on every PreToolUse/
   *  PostToolUse/Stop match. */
  const [hookConfig, setHookConfig] = useState<HookConfigSummary | null>(null);
  const [hookDispatchLog, setHookDispatchLog] = useState<HookDispatchRecord[]>([]);
  const HOOK_DISPATCH_LOG_LIMIT = 50;

  /** File checkpoints (agent/edit_backup.py) known for the current session,
   *  as the kernel reported them, plus the outcome of the last undo/restore
   *  request — kept in the kernel's own wire shape rather than re-derived,
   *  since nothing here needs the display projection lib/fileCheckpoints.ts
   *  builds for a picker that does not exist yet. */
  const [fileCheckpointItems, setFileCheckpointItems] = useState<FileCheckpointEntry[]>([]);
  const [lastCheckpointResult, setLastCheckpointResult] = useState<CheckpointResultEvent | null>(null);

  /** Per-turn file-change summary (path + added/removed line counts) from the
   *  `result` event's filesTouched/fileChanges fields. */
  const [fileChangeSummary, setFileChangeSummary] = useState<FileChangeSummary | null>(null);

  /** Parallel PlanModel projection (lib/planModel.ts) of whatever /plan-mode's
   *  task text currently is, kept alongside the legacy planModeState FSM
   *  below. A revision (re-running /plan-mode while one is already showing)
   *  goes through revisePlanModel so a step already marked done/failed/
   *  skipped survives the revision instead of the whole plan resetting to
   *  pending — planMode.ts's own FSM cannot do that (its `revise` action
   *  intentionally resets every step). Rendered by PlanPanel.tsx (its
   *  `model`/`diff` props) once `showPlanMode` is true — see the render tree.
   */
  const [planModel, setPlanModel] = useState<PlanModel | null>(null);
  const planModelRef = useRef<PlanModel | null>(null);
  planModelRef.current = planModel;
  const [planModelDiff, setPlanModelDiff] = useState<PlanRevisionDiff | undefined>(undefined);
  // PlanPanel's model view is presentation-only (see its own doc comment): it
  // never reads stdin itself, so these callbacks are what the global key
  // handler below reports an approve/reject/select/close decision through —
  // the same forward-declared-callback shape GraphPanel's onToggle/onSelect
  // already uses for this panel family. They are invoked FROM the existing
  // planModeRef-driven intent handlers (not a second, parallel key resolver)
  // so an 'a'/'r'/Esc keystroke updates exactly one FSM pairing, not two
  // independently-resolved ones racing on the same key.
  const handlePlanModelApprove = useCallback(() => {
    setPlanModel((prev) => (prev ? approvePlanModel(prev) : prev));
  }, []);
  const handlePlanModelReject = useCallback((reason?: string) => {
    setPlanModel((prev) => (prev ? rejectPlanModel(prev, reason) : prev));
  }, []);
  const handlePlanModelSelectStep = useCallback((stepId: string) => {
    const steps = planModelRef.current?.steps;
    if (!steps) return;
    const index = steps.findIndex((step) => step.id === stepId);
    if (index >= 0) planCursorRef.current = index;
  }, []);
  const handlePlanModelClose = useCallback(() => {
    setShowPlanMode(false);
  }, []);

  const bridgeRef = useRef<CodeBridge | null>(null);
  const sendModelConnectionRequest = useCallback(
    (
      action: ModelConnectionAction,
      options: {
        draft?: ModelConnectionDraft | null;
        connectionId?: string | null;
        credentialRef?: string | null;
        credentialValue?: string | null;
      } = {},
    ) => {
      const requestId = uid(`model-connection-${action}`);
      if (action === "repair_plan") {
        dispatchModelConnections({ type: "repair_requested", requestId });
      } else {
        dispatchModelConnections({
          type: "request_started",
          action,
          requestId,
          ...(options.connectionId ? { connectionId: options.connectionId } : {}),
        });
      }
      try {
        // A format probe sends a bounded set of generation requests. It is never
        // folded into the no-spend connectivity check and carries explicit
        // per-action consent on the bridge command.
        const command = buildModelConnectionCommand({
          action,
          requestId,
          draft: options.draft,
          connectionId: options.connectionId,
          credentialRef: options.credentialRef,
          credentialValue: options.credentialValue,
        });
        const bridge = bridgeRef.current;
        if (!bridge) throw new Error("Sophia bridge is not available.");
        if (action === "store_credential") {
          bridge.sendOneShotSecret(command as unknown as Record<string, unknown>);
        } else {
          bridge.send(command as unknown as Record<string, unknown>);
        }
        setStatus(`custom endpoint ${action.replaceAll("_", " ")} requested`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        dispatchModelConnections({ type: "request_failed", requestId, detail });
        setStatus(`custom endpoint request failed: ${detail}`);
      }
    },
    [],
  );
  const openModelConnections = useCallback(() => {
    closeOtherFullPanePanels("modelConnections");
    dispatchModelConnections({ type: "open", start: "list" });
    sendModelConnectionRequest("list");
    setStatus("custom model endpoints · Enter add/edit · Esc close");
  }, [closeOtherFullPanePanels, sendModelConnectionRequest]);
  const handleModelConnectionsInput = useCallback(
    (inputKey: string, key: Key) => {
      const state = modelConnectionsRef.current;
      if (!state.open) return;

      if (state.view === "list") {
        if (key.escape) {
          dispatchModelConnections({ type: "close" });
          setStatus("custom endpoint panel closed");
          return;
        }
        if (key.upArrow || key.downArrow) {
          dispatchModelConnections({ type: "move", delta: key.downArrow ? 1 : -1 });
          return;
        }
        const connection = state.selected > 0
          ? state.connections[state.selected - 1]
          : undefined;
        if (key.return) {
          dispatchModelConnections(
            connection ? { type: "edit", id: connection.id } : { type: "start_add" },
          );
          return;
        }
        if (connection && inputKey.toLowerCase() === "e") {
          dispatchModelConnections({ type: "edit", id: connection.id });
          return;
        }
        if (connection && (inputKey.toLowerCase() === "c" || inputKey.toLowerCase() === "f")) {
          const action = inputKey.toLowerCase() === "c" ? "check" : "format_probe";
          const draft = draftFromConnection(connection);
          dispatchModelConnections({ type: "edit", id: connection.id });
          sendModelConnectionRequest(action, { draft, connectionId: connection.id });
          return;
        }
        if (connection && inputKey.toLowerCase() === "d") {
          dispatchModelConnections({ type: "request_remove", id: connection.id });
          return;
        }
        if (inputKey.toLowerCase() === "r" && !state.pending) {
          sendModelConnectionRequest("list");
        }
        return;
      }

      if (state.view === "templates") {
        if (key.escape) {
          dispatchModelConnections({ type: "open", start: "list" });
          return;
        }
        if (key.upArrow || key.downArrow) {
          dispatchModelConnections({ type: "move", delta: key.downArrow ? 1 : -1 });
          return;
        }
        if (key.return) dispatchModelConnections({ type: "select_template" });
        return;
      }

      if (state.view === "form") {
        if (key.escape) {
          dispatchModelConnections({ type: "discard_draft" });
          return;
        }
        if (state.pending) return;
        if (key.upArrow || key.downArrow || key.tab) {
          dispatchModelConnections({
            type: "move",
            delta: key.upArrow || (key.tab && key.shift) ? -1 : 1,
          });
          return;
        }
        const row = MODEL_CONNECTION_FORM_ROWS[state.formSelected];
        if (!row) return;
        if (row.kind === "field") {
          if (row.field === "protocol" && (key.return || inputKey === " ")) {
            dispatchModelConnections({ type: "toggle_protocol" });
            return;
          }
          if (key.return) {
            dispatchModelConnections({ type: "move", delta: 1 });
            return;
          }
          if (key.backspace || key.delete) {
            dispatchModelConnections({ type: "delete_field", field: row.field });
            return;
          }
          if (
            row.field !== "protocol" &&
            inputKey &&
            !key.ctrl &&
            !key.meta &&
            !key.escape
          ) {
            dispatchModelConnections({
              type: "append_field",
              field: row.field,
              value: inputKey,
            });
          }
          return;
        }
        if (!key.return && inputKey !== " ") return;
        if (row.action === "cancel") {
          dispatchModelConnections({ type: "discard_draft" });
        } else if (row.action === "toggle_private_network") {
          dispatchModelConnections({ type: "toggle_private_network" });
        } else if (row.action === "store_credential") {
          dispatchModelConnections({ type: "start_credential_entry" });
        } else if (row.action === "save" || row.action === "check" || row.action === "format_probe") {
          sendModelConnectionRequest(row.action, {
            draft: state.draft,
            connectionId: state.editingId,
          });
        }
        return;
      }

      if (state.view === "credential_entry") {
        if (key.escape) {
          dispatchModelConnections({ type: "cancel_credential_entry" });
          return;
        }
        if (state.pending) return;
        if (key.backspace || key.delete) {
          dispatchModelConnections({ type: "delete_credential_input" });
          return;
        }
        if (key.return) {
          if (!state.draft || !state.credentialInput) {
            setStatus("API key is required");
            return;
          }
          sendModelConnectionRequest("store_credential", {
            credentialRef: state.draft.credentialRef,
            credentialValue: state.credentialInput,
          });
          return;
        }
        if (
          inputKey &&
          !key.ctrl &&
          !key.meta &&
          !key.escape
        ) {
          dispatchModelConnections({
            type: "append_credential_input",
            value: inputKey,
          });
        }
        return;
      }

      if (state.view === "remove_confirm") {
        if (key.escape || inputKey.toLowerCase() === "n") {
          dispatchModelConnections({ type: "cancel_remove" });
        } else if (
          inputKey.toLowerCase() === "y" &&
          state.removeTargetId &&
          !state.pending
        ) {
          sendModelConnectionRequest("remove", {
            connectionId: state.removeTargetId,
          });
        }
        return;
      }

      if (state.view === "repair_consent") {
        if (key.escape || inputKey.toLowerCase() === "n") {
          dispatchModelConnections({ type: "decline_repair" });
          return;
        }
        if (key.upArrow || key.downArrow) {
          dispatchModelConnections({ type: "move", delta: 1 });
          return;
        }
        if (inputKey.toLowerCase() === "y") {
          dispatchModelConnections({ type: "set_repair_consent", value: "yes" });
          return;
        }
        if (key.return) {
          if (state.repairConsent === "yes" && state.draft) {
            sendModelConnectionRequest("repair_plan", {
              draft: state.draft,
              connectionId: state.editingId,
            });
          } else {
            dispatchModelConnections({ type: "decline_repair" });
          }
        }
        return;
      }

      if (state.view === "repair_pending") {
        if (key.escape) setStatus("repair suggestion is pending; no changes will be applied automatically");
        return;
      }

      if (state.view === "repair_preview") {
        if (key.escape || inputKey.toLowerCase() === "n") {
          dispatchModelConnections({
            type: "set_repair_preview_approval",
            value: "no",
          });
          dispatchModelConnections({ type: "finish_repair_preview" });
          return;
        }
        if (key.upArrow || key.downArrow) {
          dispatchModelConnections({ type: "move", delta: 1 });
          return;
        }
        if (inputKey.toLowerCase() === "y") {
          dispatchModelConnections({
            type: "set_repair_preview_approval",
            value: "yes",
          });
          return;
        }
        if (key.return) dispatchModelConnections({ type: "finish_repair_preview" });
      }
    },
    [sendModelConnectionRequest],
  );
  const submitLineRef = useRef<(
    raw: string,
    options?: { secretConfirmed?: boolean },
  ) => Promise<void>>(async () => undefined);
  const exitPromiseRef = useRef<Promise<void> | null>(null);
  const assistantBuf = useRef("");
  const visibleReasoningStreamsRef = useRef(
    new Map<string, VisibleReasoningStreamState>(),
  );
  const submitLockRef = useRef(false);
  const initialPromptSentRef = useRef(false);
  const startupProfileBootstrapRef = useRef<string | null>(null);
  const startupProfileSettingsRef = useRef<Record<string, unknown> | null>(null);
  const finalKeysRef = useRef(new Set<string>());
  /** Unparseable bridge stdout lines seen this session (see UNPARSED_LOG_CAP). */
  const unparsedRef = useRef(0);
  /** Mirrors `running` for stable callbacks that must not close over it. */
  const runningRef = useRef(false);
  /** Answer payloads already rendered; completion is tracked separately. */
  const resultRunsRef = useRef(new Set<string>());
  const terminalRunsRef = useRef(new Set<string>());
  /** Runs for which the runtime/workspace mismatch was already surfaced. */
  const runtimeSourceWarningRunsRef = useRef(new Set<string>());
  const progressResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref so arrow handlers always see latest selection/matches
  const slashSelectedRef = useRef(0);
  const slashMatchesRef = useRef<SlashCommand[]>([]);
  /** Settings the operator established, which the bridge's boot snapshot must
   *  not override: typed at launch, or changed in-session (including BEFORE
   *  `ready` arrives — the prompt box and slash commands are live by then). */
  const explicitKeysRef = useRef<Set<SettingKey>>(EXPLICIT_CLI_KEYS);
  const userChangedRef = useRef<Set<SettingKey>>(new Set<SettingKey>());
  const noteUserChanged = useCallback((key: SettingKey) => {
    userChangedRef.current.add(key);
  }, []);

  const resetVisibleReasoningStreams = useCallback(() => {
    visibleReasoningStreamsRef.current.clear();
  }, []);

  /** setSettings that cannot take the TUI down with it.
   *
   * `bridgeRef.current?.setSettings(...)` guards a null REF, not a dead CHILD:
   * CodeBridge.send throws "bridge not running" once the child exits, and the
   * app deliberately stays alive after that ("bridge exited; restart the TUI").
   * Several of these calls sit in Ink input handlers and slash commands, where
   * React cannot contain a throw — so pressing Shift+Tab or running /model
   * after the bridge died killed the whole TUI instead of printing an error.
   * Settings are best-effort by nature; a dead bridge just means nowhere to
   * persist them.
   */
  const pushSettings = useCallback((patch: Record<string, unknown>) => {
    try {
      bridgeRef.current?.setSettings(patch);
    } catch {
      /* bridge is gone; the status line already says so */
    }
  }, []);

  /** Remove every queued approval, optionally denying bridge-owned requests. */
  const clearApprovalQueue = useCallback((denyTools = false) => {
    if (denyTools) {
      for (const approval of approvalQueueRef.current) {
        if (approval.kind !== "tool") continue;
        try {
          bridgeRef.current?.approve(approval.id, false);
        } catch {
          /* cancellation/exit continues even if the bridge is already gone */
        }
      }
    }
    pendingLocalActionsRef.current.clear();
    updateApprovalQueue({ type: "clear" });
  }, [updateApprovalQueue]);

  /** Drop every piece of state that belongs to the PREVIOUS run.
   *
   * Both submit paths reset the run id, `running` and `phase`, but state that
   * only a completed run sets was left standing until the next run happened to
   * overwrite it — and some of it never gets overwritten at all:
   *
   *  - the epistemic/delivery-gate verdict is set on `result` and cleared ONLY
   *    in applyDiskSession, so the previous answer's gate chip stays pinned to
   *    the status line while the new answer streams and after it lands. A chip
   *    reading "not gated" against an answer that WAS gated (or the reverse) is
   *    a correctness bug: it is the one affordance that says whether to trust
   *    what is on screen.
   *  - the 1200 ms "show Done, then idle" timer from the last run is still
   *    armed, so it fires mid-new-run and blanks the progress indicator.
   *  - an approval prompt orphaned by a failed run disables the input.
   */
  const resetRunState = useCallback(() => {
    activeRunIdRef.current = null;
    resetVisibleReasoningStreams();
    setEpistemic(null);
    epistemicRef.current = null;
    if (progressResetTimerRef.current) {
      clearTimeout(progressResetTimerRef.current);
      progressResetTimerRef.current = null;
    }
    clearApprovalQueue();
    setRunning(true);
    setPhase({ phase: "starting", detail: "", streamPreview: "" });
  }, [clearApprovalQueue, resetVisibleReasoningStreams]);

  /**
   * Clear session-scoped presentation before a successful /new, /archive,
   * /fork, /resume, picker restore, or bridge-driven session load is shown.
   */
  const resetSessionTransitionState = useCallback((
    nextStatus: string,
    nextSessionId = sessionRef.current,
  ) => {
    const next = createSessionTransitionPresentation(nextStatus);
    activeRunIdRef.current = null;
    bufferedSteerRef.current = null;
    steerPendingRef.current = null;
    assistantBuf.current = "";
    resetVisibleReasoningStreams();
    submitLockRef.current = false;
    contextUsageRef.current = next.contextUsage;
    bridgeEventsRef.current = [];
    runtimeSourceWarningRunsRef.current.clear();
    if (progressResetTimerRef.current) {
      clearTimeout(progressResetTimerRef.current);
      progressResetTimerRef.current = null;
    }
    clearApprovalQueue(true);
    setEpistemic(next.epistemic);
    epistemicRef.current = next.epistemic;
    setLastCost(next.lastCost);
    setRunning(next.running);
    runningRef.current = next.running;
    setCancelling(next.cancelling);
    setProgress(next.progress);
    setStatus(next.status);
    setFocusedMsgId(null);
    dispatchWorkflow({ type: "clear" });
    dispatchGoal({ type: "run_start", goal: "" });
    dispatchGoal({ type: "result" });
    dispatchSessionFlow({ type: "reset", sessionId: nextSessionId });
    dispatchSessionFlowInteraction({ type: "reset" });
    sessionFlowPanelLayoutRef.current = null;
    setSessionFlowViewportSnapshot(null);
    setSessionFlowPanelSelectedId(null);
    sessionFlowMiniMapLayoutRef.current = null;
    sessionFlowPointerDragRef.current = null;
    sessionFlowLastClickRef.current = null;
    const nextAgi = {
      ...EMPTY_AGI_STATE,
      enabled: agiModeRef.current,
      profile: agiProfileRef.current,
      route: agiRouteRef.current,
    };
    setAgi(nextAgi);
    agiRef.current = nextAgi;
    setAgiWorkflow(EMPTY_AGI_WORKFLOW_STATE);
    agiWorkflowRef.current = EMPTY_AGI_WORKFLOW_STATE;
    setPlanModeState(null);
    setShowPlanMode(false);
    // Session-scoped frontier state: telemetry, file checkpoints and the plan
    // model all belong to the conversation being left, not the one being
    // entered — carrying them across would show a resumed/forked/new session
    // the PREVIOUS session's cost total, hook activity or checkpoint list.
    setRunTelemetry(null);
    setSessionCostUsd(0);
    sessionCostUsdRef.current = 0;
    setContextTelemetry(null);
    setHookDispatchLog([]);
    setFileCheckpointItems([]);
    setLastCheckpointResult(null);
    setFileChangeSummary(null);
    setPlanModel(null);
    setPlanModelDiff(undefined);
  }, [clearApprovalQueue, resetVisibleReasoningStreams]);

  const push = useCallback((msg: Omit<ChatMessage, "id"> & { id?: string }) => {
    setMessages((prev) => {
      const next = [...prev, { ...msg, id: msg.id || uid() }];
      // Append is the only growth site, so it is the only place the bound has
      // to be applied. applyTranscriptBudget returns the SAME array identity
      // when nothing is evicted and never rewrites a kept message — both
      // matter, because chatLayout's height cache is keyed on message identity.
      const bounded = applyTranscriptBudget(next, TRANSCRIPT_BUDGET);
      if (bounded.evictedCount > 0) {
        // Losing transcript silently would be a data-loss bug wearing a memory
        // optimisation's clothes. Say it, in the transcript itself.
        return [
          {
            id: uid(),
            role: "system" as const,
            text: `[${bounded.evictedCount} older message(s) dropped to bound memory; the full run remains on disk in the session transcript]`,
          },
          ...bounded.messages,
        ];
      }
      return bounded.messages;
    });
    // New messages: stick to bottom unless user scrolled up
    if (stickBottomRef.current) setScrollOffset(0);
  }, []);

  const notifyTerminal = useCallback((request: NotificationRequest) => {
    if (!notificationsEnabledRef.current) return;
    const settings = resolveNotificationSettings(process.env, {
      enabled: true,
      channel: "auto",
      showToast: true,
    });
    const plan = planNotification(
      request,
      terminalCapabilitiesRef.current,
      settings,
      {
        focused: false,
        lastDeliveredAt: notificationDeliveredAtRef.current,
      },
    );
    if (plan.sequence) dispatchTerminalNotification(plan);
    if (plan.deliveredAt !== null) notificationDeliveredAtRef.current = plan.deliveredAt;
    if (plan.showToast) {
      setNotificationToast(plan.request);
      const timer = setTimeout(() => setNotificationToast(null), 5000);
      timer.unref?.();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    draftLoadedRef.current = false;
    const store = new FileDraftStore();
    const autosave = new DraftAutosave(store, {
      delayMs: 500,
      onError: () => setStatus("draft autosave unavailable; composer remains usable"),
    });
    draftAutosaveRef.current = autosave;
    void store.load(draftKey).then((draft) => {
      if (cancelled) return;
      draftLoadedRef.current = true;
      if (draft?.text && !inputRef.current && !props.initialPrompt) {
        inputRef.current = draft.text;
        setInput(draft.text);
        setStatus("restored local draft");
      }
    });
    return () => {
      cancelled = true;
      if (draftAutosaveRef.current === autosave) draftAutosaveRef.current = null;
      void autosave.dispose({ flush: true });
    };
  }, [draftKey, props.initialPrompt]);

  useEffect(() => {
    if (!draftLoadedRef.current || !draftAutosaveRef.current) return;
    if (!input) {
      void draftAutosaveRef.current.clear(draftKey);
      return;
    }
    draftAutosaveRef.current.schedule(
      createDraftSnapshot(draftKey, input, {
        metadata: { session, localOnly: true },
      }),
    );
  }, [draftKey, input, session]);

  /** Load session transcript from ~/.sophia/.../conversations/<name>.json into the UI. */
  // Keep runningRef in step with the state it mirrors.
  React.useEffect(() => { runningRef.current = running; }, [running]);

  const applyDiskSession = useCallback(
    (name: string, opts?: { quiet?: boolean }) => {
      if (runningRef.current) {
        // Swapping the transcript mid-run leaves the in-flight answer to land in
        // a session it does not belong to, and the turn the user is watching
        // disappears from under them. Refuse rather than guess which they meant.
        push({
          role: "system",
          text: `cannot switch to ${name} while a run is in flight — cancel it first (Esc)`,
          ok: false,
        });
        return {
          ok: false as const,
          session: name,
          path: "",
          turns: 0,
          messages: [],
          flowEvents: [],
          topic: "",
          error: "run in flight",
        };
      }
      const result = loadSessionFromDisk(name);
      const banner: ChatMessage = {
        id: uid(),
        role: "system",
        text: !result.ok
          ? `resume failed · ${result.session} · ${result.error || "unknown error"} · ${result.path}`
          : result.messages.length
            ? `resumed · ${result.session} · ${result.turns} turn${result.turns === 1 ? "" : "s"} · ${result.path}`
            : `session · ${result.session} · no prior turns · ${result.path}`,
        ok: result.ok && result.messages.length > 0 ? true : result.ok ? undefined : false,
      };
      if (!result.ok) {
        // A FAILED resume must not destroy what is on screen. loadSessionFromDisk
        // returns messages:[] on error (EACCES, a corrupt JSON array, a decode
        // failure), so replacing the transcript wiped the entire live
        // conversation because an unrelated file could not be read. Append the
        // error and leave the session as it was.
        push(banner);
        setStatus(`resume failed · ${result.session}`);
        return result;
      }
      sessionRef.current = result.session;
      resetSessionTransitionState(`loading ${result.session}…`, result.session);
      dispatchSessionFlow({
        type: "hydrate",
        sessionId: result.session,
        events: result.flowEvents,
      });
      const warnings = [
        ...(result.provenanceWarning ? [result.provenanceWarning] : []),
        ...formatResumeDriftWarnings(result.provenance, {
          modelAlias: modelRef.current,
          workspace: cwd,
        }),
      ].map((text) => ({
        id: uid(),
        role: "system" as const,
        text,
        ok: false,
      }));
      setMessages([...result.messages, ...warnings, banner]);
      setSession(result.session);
      // A conversation transcript and task receipts have separate durable
      // stores. Hydrate the latter too so a crash/restart restores the latest
      // team's lane states in the right panel instead of looking like no team
      // was ever dispatched. The kernel reconciles a dead owner process to
      // `interrupted`; we display that truth and never replay tool work
      // automatically (replay could duplicate a side effect).
      const bridge = bridgeRef.current;
      if (bridge) {
        const requestId = uid("resume-tasks");
        teamResumeRequestRef.current.add(requestId);
        bridge.listTasks(undefined, result.session, undefined, requestId);
        if (editionAllowsCommand("workflow")) {
          bridge.replayCompoundWorkflows(result.session);
        }
      }
      setStatus(
        !result.ok
          ? `resume failed · ${result.session}`
          : result.messages.length
            ? `ready · resumed ${result.session} (${result.turns} turns)`
            : `ready · ${result.session} (empty)`,
      );
      stickBottomRef.current = true;
      setScrollOffset(0);
      sessionPickerRef.current = null;
      setSessionPicker(null);
      if (!opts?.quiet && !result.ok) {
        /* banner already carries the error */
      }
      return result;
    },
    [push, resetSessionTransitionState],
  );
  const selectDiskSession = useCallback((target: string): boolean => {
    const result = applyDiskSession(target);
    const settings = sessionSelectionSettings(result);
    if (!settings) return false;
    try {
      pushSettings(settings);
    } catch {
      /* kernel still loads the file by session name on the next run */
    }
    return true;
  }, [applyDiskSession, pushSettings]);
  // Stable ref for the raw-stdin coalesced-Enter fallback below.
  const selectDiskSessionRef = useRef(selectDiskSession);
  selectDiskSessionRef.current = selectDiskSession;

  // Single source of truth for the session-picker option list: ALWAYS disk.
  // The bridge `sessions` event used to populate this from its own payload,
  // which diverged from `/session list` (disk) when SOPHIA_CONVERSATIONS_DIR
  // was set. Both callers now go through here, so the picker is deterministic
  // regardless of which path opened it. Returns the built options so callers
  // can drive their own picker/status side effects.
  const refreshSessionOptionsFromDisk = useCallback((
    currentSession: string,
    view: { rows?: SessionListItem[]; query?: string | null; totalMatches?: number } = {},
  ) => {
    const rows = view.rows ?? listSessionsFromDisk(50);
    const pickerOptions = rows.map((item) => ({
      value: item.id,
      label: item.name,
      // Description-led (the session's topic = its first user message), then
      // turn count and recency — so the picker reads like a session browser
      // list, not just an opaque session id.
      hint: `${item.match?.preview || item.description || item.lastPreview || "…"} · ${item.turns} turn${item.turns === 1 ? "" : "s"} · ${item.recency}`,
    }));
    setSessionOptions(pickerOptions);
    setSessionRows(rows);
    const query = view.query?.trim() || null;
    sessionBrowserQueryRef.current = query;
    setSessionBrowserQuery(query);
    setSessionBrowserTotalMatches(view.totalMatches ?? rows.length);
    const next = {
      selected: Math.max(0, pickerOptions.findIndex((item) => item.value === currentSession)),
    };
    sessionPickerRef.current = next;
    setSessionPicker(next);
    // Not navigated yet: the raw-stdin Enter backup arms only once ↑↓ moves the
    // selection, so the very next Enter (a clean resume of the highlighted row)
    // is handled by handleSessionBrowserInput alone, never double-fired.
    sessionPickerReadyRef.current = false;
    return { rows, options: pickerOptions };
  }, []);

  // Session-browser input, routed through PromptInput's STABLE handleInput via
  // onModalInput (the same path the model/effort OptionPicker uses). Driving it
  // from the inline global useInput made Ink drop the keystroke after every ↑↓
  // (PTYs coalesce arrow+Enter into one "\x1b[B\r" read and Ink parses only the
  // first key), so you could open the browser but never resume. Stable callback
  // reading from refs so it never re-subscribes; sessionPickerReadyRef feeds the
  // raw-stdin Enter backup in the confirmPicker effect below.
  const handleSessionBrowserInput = useCallback(
    (inputKey: string, key: Key) => {
      const picker = sessionPickerRef.current;
      if (!picker) return;
      const rows = sessionRowsRef.current;
      if (key.upArrow || key.downArrow) {
        sessionPickerReadyRef.current = true;
        const n = rows.length;
        const next = { selected: n ? (((picker.selected + (key.upArrow ? -1 : 1)) % n) + n) % n : 0 };
        sessionPickerRef.current = next;
        setSessionPicker(next);
      } else if (key.return || inputKey === "\n" || inputKey === "\r") {
        const row = rows[picker.selected];
        if (!row) {
          setStatus(sessionBrowserQueryRef.current ? "no matching sessions · Esc close" : "no saved sessions · Esc close");
          return;
        }
        if (!selectDiskSession(row.id)) return;
        sessionPickerReadyRef.current = false;
      } else if (key.escape) {
        sessionPickerRef.current = null;
        setSessionPicker(null);
        sessionPickerReadyRef.current = false;
        setStatus("session picker cancelled");
      }
    },
    [selectDiskSession],
  );

  const toggleCollapse = useCallback((id: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id && m.role === "assistant"
          ? { ...m, collapsed: m.collapsed === false ? true : false }
          : m,
      ),
    );
    setFocusedMsgId(id);
  }, []);

  const clearTranscriptSelection = useCallback(() => {
    transcriptDragRef.current = null;
    transcriptLastMouseRef.current = null;
    transcriptDragAutoScrollRef.current = null;
    transcriptSelectionRef.current = null;
    setTranscriptDragActive(false);
    setTranscriptSelection(null);
  }, []);

  const scrollBy = useCallback((delta: number) => {
    setScrollOffset((o) => {
      const next = Math.max(0, Math.min(maxScroll, o + delta));
      stickBottomRef.current = next === 0;
      return next;
    });
  }, [maxScroll]);

  const scrollToLatest = useCallback(() => {
    setScrollOffset(0);
    stickBottomRef.current = true;
  }, []);

  const openRightPanelDetail = useCallback((section: RightPanelSection) => {
    showPanelRef.current = true;
    setShowPanel(true);
    closeOtherFullPanePanels("rightPanel");
    dispatchRightPanelDetail({ type: "select", section });
    setStatus(
      section === "flow"
        ? "Flow diagram · arrows/hjkl select blocks · Space fold · F follow · Tab sections · Esc close"
        : `${section === "todos" ? "To-do" : section[0].toUpperCase() + section.slice(1)} details · ↑↓/PgUp/PgDn scroll · Tab sections · Esc close`,
    );
  }, [closeOtherFullPanePanels]);

  const scrollRightPanelDetail = useCallback((delta: number) => {
    dispatchRightPanelDetail({
      type: "scroll",
      delta,
      maxScroll: rightPanelMaxScrollRef.current,
    });
  }, []);

  const onRightPanelDetailLayout = useCallback((nextMaxScroll: number) => {
    const normalized = Math.max(0, Math.floor(nextMaxScroll));
    rightPanelMaxScrollRef.current = normalized;
    setRightPanelMaxScroll(normalized);
    dispatchRightPanelDetail({ type: "clamp", maxScroll: normalized });
  }, []);

  const onRightPanelInteractiveLayout = useCallback((
    itemIds: string[],
    regions: RightPanelDetailItemRegion[],
  ) => {
    rightPanelDetailItemIdsRef.current = itemIds;
    rightPanelDetailItemRegionsRef.current = regions;
    dispatchRightPanelDetail({ type: "set_items", ids: itemIds });
  }, []);

  const onSessionFlowGraphLayout = useCallback(
    (report: SessionFlowPanelLayoutReport) => {
      if (report.projectionKey !== sessionFlowProjectionKeyRef.current) return;
      sessionFlowPanelLayoutRef.current = report;
      setSessionFlowViewportSnapshot((current) => {
        const next: SessionFlowViewportSnapshot = {
          layoutBounds: { ...report.layout.bounds },
          viewportWorldBounds: { ...report.viewportWorldBounds },
        };
        return current &&
          current.layoutBounds.minX === next.layoutBounds.minX &&
          current.layoutBounds.minY === next.layoutBounds.minY &&
          current.layoutBounds.maxX === next.layoutBounds.maxX &&
          current.layoutBounds.maxY === next.layoutBounds.maxY &&
          current.viewportWorldBounds.minX === next.viewportWorldBounds.minX &&
          current.viewportWorldBounds.minY === next.viewportWorldBounds.minY &&
          current.viewportWorldBounds.maxX === next.viewportWorldBounds.maxX &&
          current.viewportWorldBounds.maxY === next.viewportWorldBounds.maxY
          ? current
          : next;
      });
      setSessionFlowPanelSelectedId((current) =>
        current === report.selectedNodeId ? current : report.selectedNodeId,
      );
      const interaction = sessionFlowInteractionRef.current;
      if (
        !interaction.followLive &&
        (interaction.panX !== report.panX || interaction.panY !== report.panY)
      ) {
        // Persist the renderer's edge clamp. Without this normalization,
        // repeated input can accumulate a large invisible overscroll and make
        // the canvas feel stuck when the operator reverses direction.
        dispatchSessionFlowInteraction({
          type: "set_pan",
          panX: report.panX,
          panY: report.panY,
        });
      }
    },
    [],
  );
  const onSessionFlowMiniMapLayout = useCallback(
    (report: SessionFlowMiniMapScreenReport | null) => {
      sessionFlowMiniMapLayoutRef.current = report;
    },
    [],
  );
  const seedManualSessionFlowPan = useCallback(
    (report: SessionFlowPanelLayoutReport) => {
      if (!sessionFlowInteractionRef.current.followLive) return;
      dispatchSessionFlowInteraction({
        type: "set_pan",
        panX: report.panX,
        panY: report.panY,
      });
      dispatchSessionFlowInteraction({
        type: "pan",
        dx: 0,
        dy: 0,
        activeNodeId: report.layout.activeNodeId,
        latestNodeId: report.layout.latestNodeId,
      });
    },
    [],
  );
  const queueSessionFlowPan = useCallback(
    (dx: number, dy: number) => {
      const accumulator = sessionFlowWheelRef.current;
      accumulator.dx += dx;
      accumulator.dy += dy;
      if (accumulator.timer) return;
      accumulator.timer = setTimeout(() => {
        const pending = sessionFlowWheelRef.current;
        const panX = pending.dx;
        const panY = pending.dy;
        pending.dx = 0;
        pending.dy = 0;
        pending.timer = null;
        const report = sessionFlowPanelLayoutRef.current;
        if (
          !report ||
          !rightPanelDetailRef.current.open ||
          rightPanelDetailRef.current.section !== "flow" ||
          (panX === 0 && panY === 0)
        ) {
          return;
        }
        seedManualSessionFlowPan(report);
        dispatchSessionFlowInteraction({
          type: "pan",
          dx: panX,
          dy: panY,
          activeNodeId: report.layout.activeNodeId,
          latestNodeId: report.layout.latestNodeId,
        });
      }, SESSION_FLOW_WHEEL_BATCH_MS);
    },
    [seedManualSessionFlowPan],
  );
  useEffect(
    () => () => {
      const pending = sessionFlowWheelRef.current;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
      pending.dx = 0;
      pending.dy = 0;
    },
    [],
  );
  const setSessionFlowZoom = useCallback(
    (
      zoomLevel: SessionFlowZoomLevel,
      anchorScreen?: { x: number; y: number },
    ) => {
      const report = sessionFlowPanelLayoutRef.current;
      const current = sessionFlowInteractionRef.current;
      if (zoomLevel === current.zoomLevel) return;
      if (!report) {
        dispatchSessionFlowInteraction({ type: "set_zoom", zoomLevel });
        setStatus(
          `session flow zoom · ${getSessionFlowZoomPreset(zoomLevel).percentage}%`,
        );
        return;
      }

      const targetLayout = layoutSessionFlowForInteraction(
        sessionFlowPresentationRef.current.state,
        current,
        { zoomLevel },
      );
      const anchorInsideCanvas = Boolean(
        anchorScreen &&
          anchorScreen.x >= report.canvasScreenLeft &&
          anchorScreen.x < report.canvasScreenLeft + report.viewportWidth &&
          anchorScreen.y >= report.canvasScreenTop &&
          anchorScreen.y < report.canvasScreenTop + report.viewportHeight,
      );
      const anchorCell = anchorInsideCanvas && anchorScreen
        ? {
            x: anchorScreen.x - report.canvasScreenLeft,
            y: anchorScreen.y - report.canvasScreenTop,
          }
        : {
            x: Math.floor(report.viewportWidth / 2),
            y: Math.floor(report.viewportHeight / 2),
          };
      const pointerNodeId = anchorInsideCanvas && anchorScreen
        ? sessionFlowNodeAtScreen(report, anchorScreen.x, anchorScreen.y)
        : null;
      const anchoredPan = anchorSessionFlowPanAcrossLayouts({
        sourceLayout: report.layout,
        targetLayout,
        sourcePan: { panX: report.panX, panY: report.panY },
        viewport: {
          width: report.viewportWidth,
          height: report.viewportHeight,
        },
        anchorCell,
        anchorNodeId: pointerNodeId,
      });

      seedManualSessionFlowPan(report);
      dispatchSessionFlowInteraction({ type: "set_zoom", zoomLevel });
      dispatchSessionFlowInteraction({
        type: "set_pan",
        panX: anchoredPan.panX,
        panY: anchoredPan.panY,
      });
      setStatus(
        `session flow zoom · ${getSessionFlowZoomPreset(zoomLevel).percentage}%`,
      );
    },
    [seedManualSessionFlowPan],
  );
  const fitSessionFlowToViewport = useCallback(() => {
    const report = sessionFlowPanelLayoutRef.current;
    if (!report) return;
    const fit = fitSessionFlowLayout(
      sessionFlowPresentationRef.current.state,
      sessionFlowInteractionRef.current,
      {
        width: report.viewportWidth,
        height: report.viewportHeight,
      },
    );
    seedManualSessionFlowPan(report);
    dispatchSessionFlowInteraction({
      type: "set_zoom",
      zoomLevel: fit.zoomLevel,
    });
    dispatchSessionFlowInteraction({
      type: "set_pan",
      panX: fit.panX,
      panY: fit.panY,
    });
    setStatus(
      `session flow fit · ${getSessionFlowZoomPreset(fit.zoomLevel).percentage}%`,
    );
  }, [seedManualSessionFlowPan]);

  // Grok-style continuous edge scrolling: mouse protocols only emit a finite
  // drag report when the pointer reaches the pane boundary. Keep ticking while
  // the button remains held so a selection can cross arbitrarily many screens.
  useEffect(() => {
    if (!transcriptDragActive) return;
    const timer = setInterval(() => {
      const drag = transcriptDragRef.current;
      const auto = transcriptDragAutoScrollRef.current;
      if (!drag?.dragging || !auto) return;
      scrollBy(auto.delta);
    }, TRANSCRIPT_DRAG_SCROLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [scrollBy, transcriptDragActive]);

  const setPhase = useCallback((patch: Partial<ProgressState>) => {
    setProgress((p) => {
      const next = { ...p, ...patch };
      const label = phaseLabel(next.phase, next.detail);
      if (label && next.phase !== "idle") setStatus(label);
      return next;
    });
  }, []);

  const cancelActiveRun = useCallback(() => {
    // Deny every outstanding request before cancelling so neither the TUI nor
    // the bridge keeps an approval wait alive after the run is abandoned.
    clearApprovalQueue(true);
    bridgeRef.current?.cancel();
    setCancelling(true);
    setRunning(true);
    setPhase({ phase: "cancelling", detail: "waiting for terminal result", streamPreview: "" });
  }, [clearApprovalQueue, setPhase]);

  const requestExit = useCallback((): Promise<void> => {
    if (exitPromiseRef.current) return exitPromiseRef.current;
    clearApprovalQueue(true);
    setStatus("shutting down…");
    exitPromiseRef.current = (async () => {
      await draftAutosaveRef.current?.flush();
      await bridgeRef.current?.stop();
      exit();
    })();
    return exitPromiseRef.current;
  }, [clearApprovalQueue, exit]);

  /** True while the first token is a slash command being typed (no trailing space yet). */
  const slashOpen = useMemo(() => {
    if (!input.startsWith("/")) return false;
    // Still editing the command name (no space after first token)
    const sp = input.indexOf(" ");
    return sp === -1;
  }, [input]);

  const slashMatches: SlashCommand[] = useMemo(() => {
    if (!slashOpen) return [];
    const token = input.split(/\s+/)[0] || "/";
    return suggest(token, 0); // full filtered catalog; UI windows around selection
  }, [input, slashOpen]);
  const ghostHintCandidates = useMemo(
    () => [
      ...allCommands().map((command) => ({
        value: command.slash,
        source: "slash" as const,
        priority: 10,
        scope: "token" as const,
        caseSensitive: false,
      })),
      ...["@file(", "@dir(", "@image("].map((value) => ({
        value,
        source: "attachment" as const,
        priority: 8,
        scope: "token" as const,
        caseSensitive: false,
      })),
    ],
    [],
  );

  useEffect(() => {
    slashMatchesRef.current = slashMatches;
  }, [slashMatches]);

  useEffect(() => {
    slashSelectedRef.current = slashSelected;
  }, [slashSelected]);

  // activePickerRef is the synchronous input source of truth. A delayed render
  // must not overwrite a newer arrow-key selection before Enter or Escape.

  // Reset selection only when the typed token changes, not on every key that
  // only moves selection — compare previous token via ref.
  const prevTokenRef = useRef("");
  useEffect(() => {
    const token = input.startsWith("/")
      ? input.split(/\s+/)[0] || "/"
      : "";
    if (token !== prevTokenRef.current) {
      prevTokenRef.current = token;
      setSlashSelected(0);
      slashSelectedRef.current = 0;
    }
  }, [input]);

  // ── Bridge ──────────────────────────────────────────────────────────
  useEffect(() => {
    // The bridge's constructor argument is the Sophia RUNTIME root (where
    // agent/code_bridge.py lives), not the user's workspace. Passing `cwd` here
    // only worked while the TUI was launched from inside the checkout; in a
    // relocated release artifact started from any other directory it threw
    // "invalid Sophia runtime root". The workspace is already sent per run via
    // bridge.run({ cwd }), so let the bridge resolve its own root.
    const bridge = new CodeBridge();
    bridgeRef.current = bridge;
    bridge.start();

    const surfaceVisibleReasoning = (
      stream: VisibleReasoningStreamState,
      text: string,
      source: ProviderVisibleReasoningSource,
    ) => {
      const shown = boundedProviderVisibleReasoning(
        text,
        thinkingVisibilityRef.current,
      );
      if (!shown || shown === stream.shown) return;
      stream.shown = shown;
      const existingId = stream.draftId;
      if (!existingId) {
        const id = uid("thinking");
        stream.draftId = id;
        push({
          id,
          role: "thinking",
          meta: providerVisibleReasoningMeta(source, stream.scope),
          text: shown,
        });
        return;
      }
      setMessages((prev) => prev.map((message) =>
        message.id === existingId
          ? {
              ...message,
              meta: providerVisibleReasoningMeta(source, stream.scope),
              text: shown,
            }
          : message
      ));
      if (stickBottomRef.current) setScrollOffset(0);
    };

    const flushVisibleReasoningStream = (
      stream: VisibleReasoningStreamState,
    ) => {
      const source = stream.source;
      if (!source) return;
      const update = flushStreamGrowth(stream.growth, Date.now());
      stream.growth = update.state;
      if (update.changed) surfaceVisibleReasoning(stream, update.text, source);
    };

    const flushVisibleReasoningStreams = () => {
      for (const stream of visibleReasoningStreamsRef.current.values()) {
        flushVisibleReasoningStream(stream);
      }
    };

    const visibleReasoningStreamFor = (
      ev: BridgeEvent,
      create: boolean,
    ): VisibleReasoningStreamState | null => {
      const scope = providerReasoningScope(
        ev as Readonly<Record<string, unknown>>,
        activeRunIdRef.current || "",
      );
      const existing = visibleReasoningStreamsRef.current.get(scope.key);
      if (existing) return existing;
      if (
        !create
        || visibleReasoningStreamsRef.current.size >= MAX_VISIBLE_REASONING_SCOPES
      ) {
        return null;
      }
      const next: VisibleReasoningStreamState = {
        scope,
        source: null,
        growth: createStreamGrowth(),
        draftId: null,
        shown: "",
      };
      visibleReasoningStreamsRef.current.set(scope.key, next);
      return next;
    };

    const flushVisibleReasoningForEvent = (ev: BridgeEvent) => {
      const stream = visibleReasoningStreamFor(ev, false);
      if (stream) flushVisibleReasoningStream(stream);
    };

    const observeReasoningSource = (ev: BridgeEvent) => {
      const reportedProvider = String(ev.provider || "").trim();
      if (!reportedProvider) return;
      const next = providerVisibleReasoningSource(
        ev as Readonly<Record<string, unknown>>,
      );
      const stream = visibleReasoningStreamFor(ev, next !== null);
      if (!stream) return;
      const current = stream.source;
      if (
        current?.provider === next?.provider
        && current?.model === next?.model
        && !providerVisibleReasoningCallStarted(
          ev as Readonly<Record<string, unknown>>,
        )
      ) {
        return;
      }
      // Finish the last allowed provider-visible event before changing source.
      // The completed lane-scoped row remains as an observable transcript
      // receipt; a sibling lane's independently published text is untouched.
      flushVisibleReasoningStream(stream);
      stream.source = next;
      stream.growth = createStreamGrowth();
      stream.draftId = null;
      stream.shown = "";
      if (!next) visibleReasoningStreamsRef.current.delete(stream.scope.key);
    };

    const handleKernelEvent = (ev: BridgeEvent) => {
      const t = String(ev.type || "");
      if (t === "provider_progress") observeReasoningSource(ev);
      if (t === "todo_update") {
        dispatchTodo(ev as TodoEvent);
        dispatchGoal(ev as GoalEvent);
        return;
      }
      const phasePatch = phaseFromBridgeEvent(t, ev as Record<string, unknown>);
      if (phasePatch) setPhase(phasePatch);

      // Autonomous goal-continuation events (kernel run_goal_loop). Glyph/word
      // status, display-by-exception; the terminal row carries ok for ✓/✗.
      if (isGoalLifecycleEvent(t)) {
        const e = ev as Record<string, unknown>;
        // Feed the persistent goal panel (lib/goalState.ts). These events are
        // upstream of model-format concerns, so the panel works identically for
        // every 020s model and omlx — nothing here is provider-specific.
        dispatchGoal(e as GoalEvent);
        if (t === "goal_update") {
          const revisedGoal = String(e.goal || "").trim();
          const revision = Number(e.revision) || 0;
          const stage = Number(e.currentStage ?? e.stage) || 0;
          const plannedStages = Number(e.plannedStages) || 0;
          if (VERBOSE_TRANSCRIPT) {
            push({
              role: "system",
              meta: "goal",
              text:
                `goal revised · r${revision || "?"}` +
                (stage
                  ? ` · stage ${stage}/${plannedStages || "?"}`
                  : "") +
                (revisedGoal ? ` · ${revisedGoal}` : ""),
            });
          }
          setStatus(
            stage
              ? `goal r${revision || "?"} · stage ${stage}/${plannedStages || "?"}`
              : `goal revised · r${revision || "?"}`,
          );
          return;
        }
        if (t === "goal_triage") {
          // Automatic long-horizon routing result. Display-by-exception: an
          // ordinary bounded task stays in the inner loop silently; only surface
          // a row when explicit persistence intent selects the outer goal loop.
          if (e.isGoal === true) {
            const conf = Number(e.confidence) || 0;
            const willLoop = e.willLoop === true;
            push({ role: "system", meta: "goal", text: `auto-detected goal · ${String(e.goal || "")} (${conf.toFixed(2)}) · ${willLoop ? "running autonomously" : "low confidence — single answer"}` });
            if (willLoop) setStatus("goal: running autonomously…");
          }
          return;
        }
        if (t === "goal_accumulated") {
          // The new prompt was merged into the session's running goal (which
          // compounds across prompts). Show the accumulated goal so the user can
          // see what the autonomous loop is now working toward.
          const acc = String(e.accumulatedGoal || "");
          const continues = e.continuesPrior === true;
          push({ role: "system", meta: "goal", text: `goal accumulated · ${acc}${continues ? " (extends prior goal)" : " (new goal)"}` });
          setStatus("goal: running autonomously…");
          return;
        }
        if (t === "goal_mode_start") {
          push({ role: "system", meta: "goal", text: `goal mode · ${String(e.goal || "")} (max ${Number(e.maxContinuations) || 8} continuations · achieved≥${e.achievedThreshold ?? 0.8})` });
          setStatus("goal: working…");
        } else if (t === "goal_start") {
          // goal_harness emits this immediately after goal_mode_start. It is a
          // nonterminal execution boundary, not a failed terminal verdict.
          setStatus("goal: working…");
        } else if (t === "goal_status") {
          const conf = Number(e.confidence) || 0;
          const rem = String(e.remaining || "");
          push({ role: "system", meta: "goal", text: `attempt ${Number(e.attempt) || "?"} · ${String(e.status || "")} (${conf.toFixed(2)})${rem ? ` · ${rem}` : ""}` });
          setStatus(`goal · ${String(e.status || "")} (${conf.toFixed(2)})`);
        } else if (t === "goal_continuation") {
          const rem = String(e.remaining || "");
          push({ role: "system", meta: "goal", text: `↻ continuing → attempt ${Number(e.nextAttempt) || "?"}${rem ? ` · ${rem}` : ""}` });
          setStatus(`goal · continuing → attempt ${Number(e.nextAttempt) || "?"}`);
        } else if (isTerminalGoalLifecycleEvent(t)) {
          const st = String(e.status || t.replace("goal_", ""));
          const reason = String(e.reason || "");
          push({
            role: "system",
            meta: "goal",
            text: `goal ${st.replaceAll("_", " ")}${reason ? ` — ${reason}` : ""}`,
            ok: st === "achieved" ? true : st === "awaiting_input" ? undefined : false,
          });
          setStatus(st === "awaiting_input" ? "goal · awaiting your input" : `goal ${st}`);
        }
        return;
      }

      if (t === "tool_call") {
        // Plain bounded runs do not enter the autonomous goal loop, so their
        // progress arrives as ordinary tool events. Fold them into the Goal
        // panel instead of leaving its title/status frozen until `result`.
        dispatchGoal(ev as GoalEvent);
        // Empty parallel slots (Qwen/vLLM artifact) must not linger as a vague
        // ⏺ "tool" row — classify them now so they show ✗ (empty) immediately,
        // matching the disk-resume projection. Same classifier as sessionStore.
        const rawName = String(ev.tool || "");
        const { failed, meta } = classifyToolResult({
          toolName: rawName,
          body: JSON.stringify(ev.args || {}).slice(0, 160),
        });
        push({
          role: "tool",
          meta,
          text: formatLiveToolStatus({
            toolName: rawName,
            phase: "running",
            body: JSON.stringify(ev.args || {}),
          }),
          // An in-flight call with a real name is still pending (⏺, ok unset);
          // an empty/schema-bad slot is already a failure (✗).
          ok: failed ? false : undefined,
        });
        return;
      }
      if (t === "tool_wait") {
        dispatchGoal(ev as GoalEvent);
        const rawName = String(ev.tool || "");
        const elapsed = Math.max(0, Math.floor(Number(ev.elapsedSec) || 0));
        const { failed, meta } = classifyToolResult({
          toolName: rawName,
          body: "",
        });
        const text = formatLiveToolStatus({
          toolName: rawName,
          phase: "waiting",
          body: `${elapsed}s`,
        });
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            const row = prev[i];
            if (row.role === "tool" && row.meta === meta && row.ok === undefined) {
              const next = prev.slice();
              next[i] = { ...row, text };
              return next;
            }
          }
          return [
            ...prev,
            {
              id: uid(),
              role: "tool" as const,
              meta,
              text,
              ok: failed ? false : undefined,
            },
          ];
        });
        return;
      }
      if (t === "skill") {
        // Skill attach (operator /skill, or A2A auto/pin). Render as a tool-row
        // so it shows in the same stream as read_file / git_status instead of
        // vanishing into silent system_extra injection.
        const name = String(ev.name || "").trim() || "(unnamed)";
        const found = ev.found !== false;
        const via = String(ev.via || "").trim();
        const agent = String(ev.agent || "").trim();
        const phase = String(ev.phase || "").trim();
        const when = String(ev.whenToUse || "").trim();
        const steps = Number(ev.steps);
        const bits = [
          found ? "attached" : "not found",
          via ? `via=${via}` : "",
          agent ? `agent=${agent}` : "",
          phase ? `phase=${phase}` : "",
          Number.isFinite(steps) && steps > 0 ? `steps=${steps}` : "",
          when ? when.slice(0, 120) : "",
        ].filter(Boolean);
        push({
          role: "tool",
          meta: `skill:${name}`,
          text: bits.join(" · ") || (found ? "attached" : "missing"),
          ok: found,
        });
        setStatus(found ? `skill · ${name}` : `skill missing · ${name}`);
        return;
      }
      if (t === "orchestration_plan") {
        // One local, deterministic plan chosen before the first provider call.
        // Display by exception: trivial one-shot requests stay quiet, while
        // substantive/team runs disclose the route and bounded read concurrency.
        const e = ev as Record<string, unknown>;
        const substantiveTask = e.substantiveTask === true;
        const goalCandidate = e.goalCandidate === true;
        const teamCandidate = e.teamCandidate === true;
        if (substantiveTask || goalCandidate || teamCandidate) {
          const lanes = Math.max(1, Number(e.teamLanes) || 1);
          const parallel = Math.max(1, Number(e.maxParallelTools) || 1);
          const route = teamCandidate ? `${lanes} parallel agent lanes` : "solo dependency plan";
          push({
            role: "system",
            meta: "plan",
            text:
              `orchestrated before tools · ${route} · up to ${parallel} independent reads in parallel` +
              ` · ${Number(e.plannerModelCalls) || 0} planner model calls`,
          });
          setStatus(`planned · ${route}`);
        }
        return;
      }
      if (t === "team_triage") {
        // Compatibility-only event from older kernels. New TUI routing uses
        // Workflow + A2A; historical receipts are labelled without presenting
        // retired Team mode as an available controller.
        const e = ev as Record<string, unknown>;
        if (e.willTeam === true) {
          const teamN = Number(e.team) || 0;
          const conf = Number(e.confidence) || 0;
          const reason = String(e.reason || "");
          push({ role: "system", meta: "parallel", text: `legacy parallel dispatch receipt · ${teamN} lanes (${conf.toFixed(2)})${reason ? ` · ${reason}` : ""}` });
          setStatus(`parallel receipt · ${teamN} lanes`);
        } else if (e.candidate === true && e.modelCapable === false) {
          const resolvedModel = String(e.model || model);
          const reason = String(e.capabilityReason || "selected transport does not expose Sophia native tools");
          const text = `parallel candidate kept solo · ${resolvedModel} · ${reason}\nUse /a2a auto or /workflow auto for supervised parallel work.`;
          push({ role: "system", meta: "parallel", text });
          setStatus("parallel candidate kept solo");
        }
        return;
      }
      if (t === "team_start") {
        // Kernel (#1645) already chose roles via SwarmRouter or TEAM_ROLES.
        // Say so in the transcript — /workflows shows agent nodes but not why.
        const eventRunId = String(ev.runId || activeRunIdRef.current || "");
        const alreadyWarned = Boolean(
          eventRunId
          && runtimeSourceWarningRunsRef.current.has(eventRunId)
        );
        const text = formatTeamStartMessage(
          ev as Record<string, unknown>,
          {
            includeRuntimeWarning: VERBOSE_TRANSCRIPT && !alreadyWarned,
            verbose: VERBOSE_TRANSCRIPT,
          },
        );
        if (
          VERBOSE_TRANSCRIPT
          &&
          !alreadyWarned
          && ev.runtimeSourceMatchesWorkspace === false
          && eventRunId
        ) {
          runtimeSourceWarningRunsRef.current.add(eventRunId);
        }
        push({ role: "system", meta: "team", text });
        setStatus(text.length > 80 ? `${text.slice(0, 77)}…` : text);
        return;
      }
      if (t === "lanes_abandoned") {
        // Drain budget dropped one or more lanes. Without this row the run
        // still looks ok=True with full agent nodes and a coordinator-only
        // answer — the failure mode #1605's kernel event exists to catch.
        const text = formatLanesAbandonedMessage(ev as Record<string, unknown>);
        push({ role: "system", meta: "team", text, ok: false });
        setStatus("lanes abandoned · synthesis without them");
        return;
      }
      if (t === "synthesis_start") {
        // Progress phase already set above; no transcript spam — the answer
        // that follows is the synthesis.
        return;
      }
      if (t === "compact") {
        // Manual /compact. Same row shape as the automatic path so the two read
        // identically — the operator should not have to learn two formats for
        // the same event.
        if (ev.compacted === false) {
          push({ role: "system", meta: "context", text: `nothing to compact — ${String(ev.reason || "already minimal")}` });
          setStatus("context already minimal");
          return;
        }
        const b = Number(ev.beforeTokens) || 0;
        const a = Number(ev.afterTokens) || 0;
        const w = ev.contextWindow == null ? null : Number(ev.contextWindow);
        const fill = contextFillPercent(a, w);
        const saved = b > a ? Math.round(((b - a) / b) * 100) : 0;
        push({
          role: "system",
          meta: "context",
          text:
            `compacted ${formatTokens(b)} \u2192 ${formatTokens(a)} tokens` +
            (saved ? ` (\u2212${saved}%)` : "") +
            (fill !== null ? ` \u00b7 now ${fill}% of ${formatTokens(w as number)}` : "") +
            (ev.foldedTurns ? ` \u00b7 ${Number(ev.foldedTurns)} older turns folded` : ""),
        });
        setStatus(fill !== null ? `compacted \u2192 ${fill}% of ${formatTokens(w as number)}` : `compacted \u2192 ${formatTokens(a)}`);
        return;
      }
      if (t === "auto_compact") {
        // The kernel compacts history before a model call when it approaches
        // the model's window (agent/agent_loop.py). It has always emitted this
        // event and nothing ever listened, so the transcript silently changed
        // shape underneath the operator — older turns folded into a single
        // "[auto-compacted …]" entry with no indication it had happened.
        const before = Number(ev.beforeTokens) || 0;
        const after = Number(ev.afterTokens) || 0;
        const saved = before > after ? Math.round(((before - after) / before) * 100) : 0;
        // Null unless the model declared a window — never a percentage of a guess.
        const window = ev.contextWindow == null ? null : Number(ev.contextWindow);
        const fill = contextFillPercent(after, window);
        push({
          role: "system",
          meta: "context",
          text:
            `compacted ${formatTokens(before)} → ${formatTokens(after)} tokens` +
            (saved ? ` (−${saved}%)` : "") +
            (fill !== null ? ` · now ${fill}% of ${formatTokens(window as number)}` : "") +
            (ev.mode ? ` · ${String(ev.mode)}` : ""),
        });
        setStatus(
          fill !== null
            ? `context compacted → ${fill}% of ${formatTokens(window as number)}`
            : `context compacted → ${formatTokens(after)}`,
        );
        return;
      }
      if (t === "tool_result") {
        dispatchGoal(ev as GoalEvent);
        const rawName = String(ev.tool || "");
        const body = String(ev.output || "");
        const { failed, meta } = classifyToolResult({
          toolName: rawName,
          body: body.split("\n")[0] || "",
        });
        push({
          role: "tool",
          meta,
          text: formatLiveToolStatus({
            toolName: rawName,
            phase: ev.ok === false || failed ? "failed" : "done",
            body,
          }),
          // Strict: a row is ok only if the envelope says so AND the shared
          // predicate finds no error signature in the body/name.
          ok: ev.ok !== false && !failed,
        });
        return;
      }
      if (t === "thinking") {
        const source = providerReportedReasoningSource(
          ev as Readonly<Record<string, unknown>>,
        );
        const visibility = thinkingVisibilityRef.current;
        if (!source || visibility === "hidden") return;
        const shown = boundedProviderVisibleReasoning(
          String(ev.text || ""),
          visibility,
        );
        if (!shown) return;
        const scope = providerReasoningScope(
          ev as Readonly<Record<string, unknown>>,
          activeRunIdRef.current || "",
        );
        const liveStream = visibleReasoningStreamFor(ev, false);
        if (
          liveStream
          && sameProviderVisibleReasoningSource(liveStream.source, source)
        ) {
          flushVisibleReasoningStream(liveStream);
          liveStream.source = source;
          surfaceVisibleReasoning(liveStream, shown, source);
          liveStream.growth = settledProviderReasoningGrowth(shown, Date.now());
          return;
        }
        push({
          role: "thinking",
          meta: providerVisibleReasoningMeta(source, scope),
          text: shown,
        });
        return;
      }
      if (t === "log") {
        // bridge.ts turns a stdout line it cannot JSON-parse into {type:"log"}.
        // Nothing consumed it, so a corrupted or truncated protocol line — which
        // could be the RESULT — vanished with no trace at all. Surface it, but
        // capped: a child spewing non-protocol output must not flood the
        // transcript and push the real conversation out of the budget.
        const text = String(ev.text || "").trim();
        if (!text) return;
        unparsedRef.current += 1;
        if (unparsedRef.current <= UNPARSED_LOG_CAP) {
          push({ role: "system", text: `bridge sent an unreadable line: ${text.slice(0, 200)}`, ok: false });
        } else if (unparsedRef.current === UNPARSED_LOG_CAP + 1) {
          push({ role: "system", text: "further unreadable bridge lines suppressed", ok: false });
        }
        return;
      }
      if (t === "thinking_token") return;
      if (t === "assistant_message") {
        // Mid-loop prose emitted when the model returns text + tools without
        // streaming tokens (common on DS4). Without this, the transcript is
        // only tool cards and the operator thinks the run produced no answer.
        const text = String(ev.text || bridgeEventText(ev) || "").trim();
        if (!text) return;
        const id = uid();
        push({
          id,
          role: "assistant",
          text: displayFinalText(text, {
            exactOutput: false,
            cap: TRANSCRIPT_ROW_CHAR_CAP,
          }),
          ok: ev.ok !== false,
          collapsed: false,
        });
        setFocusedMsgId(id);
        if (stickBottomRef.current) setTimeout(scrollToLatest, 0);
        return;
      }
      if (t === "final") {
        // Kernel `final` is a capped preview. Keep it off-screen and wait for
        // the bridge `result`, which carries the authoritative completed body.
        // This preserves the StreamFloorGuard/delivery-gate boundary; the
        // accepted result itself renders immediately (MessageList does not
        // replay assistant text at an artificial presentation TPS).
        flushVisibleReasoningForEvent(ev);
        return;
      }
    };

    const onEvent = (ev: BridgeEvent) => {
      const t = String(ev.type || "");
      const modelConnectionEvent =
        t === "model_connection"
          ? parseModelConnectionBridgeEvent(ev as Record<string, unknown>)
          : null;
      // Never retain an unprojected custom-endpoint event: the contract parser
      // allow-lists fields and strips accidental raw credential material.
      if (t !== "model_connection") {
        bridgeEventsRef.current.push(ev as Record<string, unknown>);
      } else if (modelConnectionEvent) {
        bridgeEventsRef.current.push(modelConnectionEvent as unknown as Record<string, unknown>);
      }
      if (bridgeEventsRef.current.length > 2000) {
        bridgeEventsRef.current.splice(0, bridgeEventsRef.current.length - 2000);
      }
      const eventRunId = String(ev.runId || ((ev.payload && typeof ev.payload === "object" && (ev.payload as any).runId) || ""));
      const activeRunId = activeRunIdRef.current;
      if (isCrossRunEvent(activeRunId, eventRunId)) {
        return;
      }
      // The mismatch guard above only fires while a run is active. Once the
      // run_finished has nulled activeRunIdRef it goes quiet, so a
      // finished run's own stragglers slip through — most often a team lane
      // abandoned at the drain timeout whose `delegate` sub-loop reaches its
      // iteration ceiling AFTER synthesis delivered the answer. A stray `final`
      // then maps to "finalizing" and strands the spinner forever. The kernel
      // now delays run_finished until those calls return; terminalRunsRef still
      // latches every finished run's
      // id, so drop any post-terminal event for a finished run. See liveness.ts.
      if (isPostTerminalStraggler(t, eventRunId, terminalRunsRef.current)) {
        return;
      }
      if (t !== "event") {
        dispatchRunEta({
          ...(ev as Record<string, unknown>),
          type: t,
          receivedAtMs: Date.now(),
        } as RunEtaEvent);
      }
      const orchestrationSnapshot =
        ev.orchestration && typeof ev.orchestration === "object"
          ? ev.orchestration
          : ev.a2aOrchestration && typeof ev.a2aOrchestration === "object"
            ? ev.a2aOrchestration
            : null;
      if (orchestrationSnapshot) {
        const orchestrationRunId = String(
          (orchestrationSnapshot as Record<string, unknown>).runId
          || eventRunId
          || "",
        );
        if (
          activeRunId
          && orchestrationRunId
          && orchestrationRunId !== activeRunId
          && t !== "ready"
          && t !== "session"
        ) {
          return;
        }
        dispatchA2a({
          type: "a2a_orchestration_snapshot",
          orchestration: orchestrationSnapshot,
        });
      }
      if (t === "model_connection") {
        if (!modelConnectionEvent) {
          setStatus("invalid custom endpoint response ignored");
          return;
        }
        dispatchModelConnections({ type: "backend_event", event: modelConnectionEvent });
        setStatus(
          modelConnectionEvent.ok
            ? `custom endpoint ${modelConnectionEvent.action.replaceAll("_", " ")} complete`
            : `custom endpoint ${modelConnectionEvent.action.replaceAll("_", " ")} failed`,
        );
        return;
      }
      if (t === "plugin_progress" || t === "plugin_compat_event") {
        const next = updatePluginManager({
          type: "bridge_event",
          event: ev as Record<string, unknown>,
        });
        const compact = pluginManagerActivityLine(next.activity);
        if (compact) setStatus(compact);
        // Structured compatibility notifications are high-frequency activity,
        // not chat turns. Keep them in the manager/status projection only.
        return;
      }
      if (t === "plugin_result") {
        updatePluginManager({
          type: "bridge_event",
          event: ev as Record<string, unknown>,
        });
        const pendingLeaseApproval = (
          ev.action === "use"
          && ev.activated !== true
          && ev.leaseEnded !== true
        );
        const patch = normalizePluginSettingsPatch(
          pendingLeaseApproval ? {} : ev.settingsPatch,
        );
        const pluginSettingOwned = (key: SettingKey) =>
          settingIsOwned(key, explicitKeysRef.current, userChangedRef.current);
        const applyWorkflowMode = Boolean(
          patch.workflowMode
          && !pluginSettingOwned("workflowMode"),
        );
        const applyWorkflowMaxStages = Boolean(
          patch.workflowMaxStages !== undefined
          && !pluginSettingOwned("workflowMaxStages"),
        );
        const applyWorkflowMaxAgents = Boolean(
          patch.workflowMaxAgents !== undefined
          && !pluginSettingOwned("workflowMaxAgents"),
        );
        const applyA2aAgents = Boolean(
          patch.a2aAgents !== undefined
          && !pluginSettingOwned("a2aAgents"),
        );
        const applyA2aExecution = Boolean(
          patch.a2aExecution
          && !pluginSettingOwned("a2aExecution"),
        );
        const applyTerminalLayout = Boolean(
          patch.terminalLayout
          && !pluginSettingOwned("terminalLayout"),
        );
        const applyDeepMode = Boolean(
          patch.deepMode !== undefined
          && !pluginSettingOwned("deepMode"),
        );
        const applyAgiMode = Boolean(
          patch.agiMode === false
          && !pluginSettingOwned("agiMode"),
        );
        if (patch.workflowMode && applyWorkflowMode) {
          setWorkflowMode(patch.workflowMode);
          workflowModeRef.current = patch.workflowMode;
        }
        if (patch.workflowMaxStages !== undefined && applyWorkflowMaxStages) {
          setWorkflowMaxStages(patch.workflowMaxStages);
          workflowMaxStagesRef.current = patch.workflowMaxStages;
        }
        if (patch.workflowMaxAgents !== undefined && applyWorkflowMaxAgents) {
          setWorkflowMaxAgents(patch.workflowMaxAgents);
          workflowMaxAgentsRef.current = patch.workflowMaxAgents;
        }
        if (patch.a2aAgents !== undefined && applyA2aAgents) {
          setA2aAgents(patch.a2aAgents);
          a2aAgentsRef.current = patch.a2aAgents;
        }
        if (patch.a2aExecution && applyA2aExecution) {
          setA2aExecution(patch.a2aExecution);
          a2aExecutionRef.current = patch.a2aExecution;
        }
        if (patch.terminalLayout && applyTerminalLayout) {
          setTerminalLayout(patch.terminalLayout);
          terminalLayoutRef.current = patch.terminalLayout;
        }
        // autoTeam/team are retired TUI settings. Older plugins may still
        // return them, but the active surface deliberately ignores them.
        if (patch.deepMode !== undefined && applyDeepMode) {
          setDeepMode(patch.deepMode);
        }
        if (patch.agiMode === false && applyAgiMode) {
          setAgiMode(false);
          agiModeRef.current = false;
        }
        if (
          patch.responseStyle
          && !pluginSettingOwned("responseStyle")
        ) {
          applyResponseStyle(patch.responseStyle);
        }
        if (Object.keys(patch).length) {
          setDynamicWorkflow((prev) => ({
            ...prev,
            configuredMode: (
              applyWorkflowMode && patch.workflowMode
                ? patch.workflowMode
                : workflowModeRef.current
            ),
            maxStages: (
              applyWorkflowMaxStages && patch.workflowMaxStages !== undefined
                ? patch.workflowMaxStages
                : workflowMaxStagesRef.current
            ),
            maxAgents: (
              applyWorkflowMaxAgents && patch.workflowMaxAgents !== undefined
                ? patch.workflowMaxAgents
                : workflowMaxAgentsRef.current
            ),
            active: false,
          }));
        }
        const appliedSelections =
          ev.appliedSelections && typeof ev.appliedSelections === "object"
            ? ev.appliedSelections as Record<string, unknown>
            : {};
        const selectedPluginRuntime =
          (
            String(ev.action || "") === "runtime_use"
            && typeof ev.selection === "string"
            && !!ev.selection
          )
          || (
            String(ev.action || "") === "profile_use"
            && typeof appliedSelections.runtime === "string"
            && !!appliedSelections.runtime
          )
          || (
            String(ev.action || "") === "use"
            && ev.activated === true
            && typeof appliedSelections.runtime === "string"
            && !!appliedSelections.runtime
          );
        if (selectedPluginRuntime) {
          // Plugin runtimes are selected inside Sophia's plugin host, not the
          // historical Prime lane. Keep the visible built-in runtime on Sophia
          // so disabling the plugin returns to the native authority by default.
          setExecutionRuntime("sophia");
          pushSettings({ runtime: "sophia" });
        }
        push({
          role: "system",
          meta: "plugin",
          text: formatPluginResult(ev as Record<string, unknown>),
          ok: ev.ok !== false,
        });
        setStatus(
          ev.ok === false
            ? `plugin ${String(ev.action || "command")} failed`
            : `plugin ${String(ev.action || "status").replaceAll("_", " ")}`,
        );
        const ownedPluginPatch = operatorOwnedSettingsPatch({
          ...(patch.workflowMode === undefined
            ? {}
            : { workflowMode: workflowModeRef.current }),
          ...(patch.workflowMaxStages === undefined
            ? {}
            : { workflowMaxStages: workflowMaxStagesRef.current }),
          ...(patch.workflowMaxAgents === undefined
            ? {}
            : { workflowMaxAgents: workflowMaxAgentsRef.current }),
          ...(patch.a2aAgents === undefined
            ? {}
            : { a2aAgents: a2aAgentsRef.current }),
          ...(patch.a2aExecution === undefined
            ? {}
            : { a2aExecution: a2aExecutionRef.current }),
          ...(patch.terminalLayout === undefined
            ? {}
            : { terminalLayout: terminalLayoutRef.current }),
          ...(patch.deepMode === undefined
            ? {}
            : { deepMode }),
          ...(patch.responseStyle === undefined
            ? {}
            : { responseStyle: responseStyleRef.current }),
          ...(patch.agiMode === undefined
            ? {}
            : { agiMode: agiModeRef.current }),
        }, explicitKeysRef.current, userChangedRef.current);
        const startupProfile = startupProfileBootstrapRef.current;
        if (
          startupProfile
          && String(ev.action || "") === "profile_use"
          && (
            ev.ok === false
            || String(ev.profile || "") === startupProfile
          )
        ) {
          startupProfileBootstrapRef.current = null;
          if (ev.ok === false) {
            // Fail closed: running with generic limits would be less visible
            // than refusing the automation and telling the operator why.
            setStartupProfileApplied(false);
            setStatus("startup plugin profile failed — initial prompt held");
          } else {
            // CodeBridge persisted the profile patch before emitting this
            // result. Live refs above preserve operator-owned values, but the
            // durable defaults still need the same precedence. Reassert only
            // keys this profile proposed and the operator explicitly owns,
            // then keep the initial prompt gated until the matching state ack.
            const ownedPatch = ownedPluginPatch;
            if (!Object.keys(ownedPatch).length) {
              setStartupProfileApplied(true);
            } else {
              try {
                const activeBridge = bridgeRef.current;
                if (!activeBridge) throw new Error("bridge not running");
                startupProfileSettingsRef.current = ownedPatch;
                activeBridge.setSettings(ownedPatch);
                setStatus("startup plugin profile applied · restoring operator settings…");
              } catch (error) {
                startupProfileSettingsRef.current = null;
                setStartupProfileApplied(false);
                push({
                  role: "system",
                  meta: "plugin",
                  text:
                    `startup plugin profile settings could not be restored: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  ok: false,
                });
                setStatus("startup operator settings restore failed — initial prompt held");
              }
            }
          }
        } else if (
          ev.ok !== false
          && (
            String(ev.action || "") === "profile_use"
            || String(ev.action || "") === "workflow_use"
          )
          && Object.keys(ownedPluginPatch).length
        ) {
          // Interactive plugin applications must obey the same durable
          // precedence as startup automation. CodeBridge persisted the plugin
          // proposal before this result arrived, so immediately reassert the
          // overlapping settings the operator already owns.
          pushSettings(ownedPluginPatch);
        }
        return;
      }
      if (t === "error") {
        if (
          startupProfileSettingsRef.current
          && String(ev.cmd || ev.command || "") === "settings"
        ) {
          startupProfileSettingsRef.current = null;
          setStartupProfileApplied(false);
          push({
            role: "system",
            meta: "plugin",
            text:
              `startup plugin profile settings could not be restored: ${
                String(ev.error || ev.message || "settings update failed")
              }`,
            ok: false,
          });
          setStatus("startup operator settings restore failed — initial prompt held");
          return;
        }
        const pending = modelConnectionsRef.current.pending;
        const requestId = String(ev.requestId || "");
        if (pending && requestId && requestId === pending.requestId) {
          const detail = String(ev.error || ev.message || "custom endpoint request failed");
          dispatchModelConnections({ type: "request_failed", requestId, detail });
          setStatus("custom endpoint command unavailable or rejected");
          return;
        }
      }
      // Canonical live-flow projection. The reducer retains only allow-listed
      // labels and receipt metadata — never raw tool arguments/output or hidden
      // model reasoning — while still covering every accepted harness step.
      dispatchSessionFlow({
        type: "event",
        event: ev,
        sessionId: sessionForFlowEvent(
          ev,
          sessionRef.current,
          sessionFlowRunSessionsRef.current,
        ),
      });
      if (t.startsWith("agi_workflow_")) {
        dispatchAgiWorkflow(ev as AGIWorkflowEvent);
        if (t === "agi_workflow_start") {
          push({
            role: "system",
            meta: "agi-workflow",
            text:
              `AGI workflow started · mode=${agiWorkflowModeRef.current} · ` +
              "candidateOnly:true · canClaimAGI:false",
          });
        } else if (t === "agi_workflow_route") {
          setStatus(
            `AGI workflow · route ${String(ev.execution || ev.route || "pending")}`,
          );
        } else if (t === "agi_workflow_node_start") {
          const node = ev.node && typeof ev.node === "object"
            ? ev.node as Record<string, unknown>
            : {};
          setStatus(
            `AGI workflow · ${String(node.title || ev.title || node.id || ev.nodeId || "node")} · running`,
          );
        } else if (t === "agi_workflow_workflow_start") {
          setStatus("AGI workflow · supervised parallel agents running");
        } else if (
          t === "agi_workflow_worker_lease"
          || t === "agi_workflow_warm_pool"
          || t === "agi_workflow_evicted"
        ) {
          setStatus("AGI workflow · worker lease/reuse state updated");
        } else if (t === "agi_workflow_workflow_end") {
          setStatus(
            `AGI workflow · nested workflow ${ev.ok === false ? "failed" : "complete"}`,
          );
        } else if (t === "agi_workflow_node_end") {
          setStatus(
            `AGI workflow · node ${String(ev.status || "complete").replaceAll("_", " ")}`,
          );
        } else if (t === "agi_workflow_end") {
          const terminalStatus = String(ev.status || "ended").replaceAll("_", " ");
          push({
            role: "system",
            meta: "agi-workflow",
            text:
              `AGI workflow ${terminalStatus} · archived operational receipts remain available in the AGI inspector\n` +
              "candidateOnly:true · canClaimAGI:false",
            ok: terminalStatus === "succeeded" || terminalStatus === "candidate complete",
          });
        }
        return;
      }
      dispatchAgi(ev as AGIEvent);
      if (t.startsWith("agi_")) {
        if (t === "agi_mode_start") {
          push({
            role: "system",
            meta: "agi",
            text:
              `AGI mode started · ${String(ev.profile || "balanced")} profile · ` +
              `${String(ev.route || "auto")} route · experimental, bounded, resumable, ` +
              "candidateOnly · canClaimAGI=false",
          });
        } else if (t === "agi_route_selected") {
          setStatus(
            `AGI route · ${String(ev.route || "auto")} · ${String(ev.reason || "classified")}`,
          );
        } else if (t === "agi_phase_start") {
          setStatus(
            `AGI · cycle ${Number(ev.cycle || 0)} · ${String(ev.phase || "phase")} · ${String(ev.role || "agent")}`,
          );
        } else if (t === "agi_discrepancy") {
          push({
            role: "system",
            meta: "agi:discrepancy",
            text: `AGI discrepancy · ${String(ev.detail || "unspecified")}`,
            ok: false,
          });
        } else if (t === "agi_pre_action_gate" && ev.authorized !== true) {
          push({
            role: "system",
            meta: "agi:authorization",
            text:
              `AGI action awaiting approval · ${String(ev.actionClass || "unclassified")} · ` +
              `${String(ev.actionId || "unknown action")}\nUse /agi approve after reviewing the AGI panel.`,
            ok: false,
          });
        } else if (t === "agi_correction_selected") {
          setStatus(`AGI correction · ${String(ev.action || "continue")}`);
        } else if (t === "agi_verification") {
          const verdict = ev.verdict && typeof ev.verdict === "object"
            ? ev.verdict as Record<string, unknown>
            : {};
          setStatus(
            `AGI verify · ${String(verdict.status || "in progress")} · ${
              ev.sameModelVerifier === true ? "same-model/non-independent" : "independent"
            }`,
          );
        } else if (t === "agi_mode_paused" || t === "agi_mode_end") {
          push({
            role: "system",
            meta: "agi",
            text:
              `AGI mode ${String(ev.status || "ended").replaceAll("_", " ")} · ` +
              `${String(ev.reason || "")}\nDurable state: ${String(ev.statePath || "not reported")}`,
            ok: String(ev.status || "") === "achieved",
          });
        } else if (t === "agi_control_ack") {
          setStatus(`AGI · ${String(ev.action || "control")} acknowledged`);
        }
        if (t !== "agi_status") return;
      }
      // ── /bench (see kernel _handle_bench) ────────────────────────────────
      // These are TOP-LEVEL custom events with no runId, so they intentionally
      // bypass the cross-run guard above (their type is not in its list). Do
      // NOT wrap them in an `event` envelope or they would be dropped.
      if (t === "bench_start") {
        const models = Array.isArray(ev.models) ? ev.models : [];
        const total = Number(ev.totalCases || 0);
        push({ role: "system", meta: "bench", text: `benchmarking ${models.length} model(s) × ${total} case(s)…` });
        setStatus(`benchmarking ${models.length} model(s)…`);
        return;
      }
      if (t === "bench_progress") {
        const modelName = String(ev.model || "model");
        const caseIdx = Number(ev.case_idx ?? -1);
        if (caseIdx < 0) {
          // Smoke-probe failure for one model (case_idx === -1): it was skipped.
          push({ role: "system", meta: "bench", ok: false, text: `${modelName}: ${String(ev.error || "not ready — skipped")}` });
        } else {
          const total = Number(ev.total || 0);
          const passed = ev.passed === true;
          const latency = ev.latency_s == null ? "" : ` (${Number(ev.latency_s).toFixed(1)}s)`;
          const caseId = ev.id ? ` ${String(ev.id)}` : "";
          const called = Array.isArray(ev.called) && ev.called.length > 0 ? ` → ${ev.called.join(", ")}` : "";
          const expected = ev.expected ? ` (want: ${String(ev.expected)})` : "";
          push({ role: "system", meta: "bench", ok: passed, text: `${modelName} ·${caseId} ${caseIdx + 1}/${total} · ${passed ? "✓" : "✗"}${latency}${called}${passed ? "" : expected}` });
        }
        return;
      }
      if (t === "bench_result") {
        if (ev.ok === false) {
          push({ role: "system", ok: false, text: `bench failed: ${String(ev.error || "unknown")}` });
          setStatus("bench failed");
          return;
        }
        const table = String(ev.table || "");
        if (table) {
          // Split scorecard from failure prompt log — render as separate messages
          // so the scorecard stays compact and the failure log is easy to find/copy.
          const failIdx = table.indexOf("### Failure prompt log");
          if (failIdx > 0) {
            const scorecard = table.slice(0, failIdx).trimEnd();
            const failLog = table.slice(failIdx);
            push({ role: "assistant", text: scorecard, collapsed: false });
            push({ role: "system", meta: "bench", ok: false, text: failLog });
          } else {
            push({ role: "assistant", text: table, collapsed: false });
          }
        }
        const report = ev.report ? ` · saved ${String(ev.report)}` : "";
        // The comparability caveat is not optional: it MUST ride with any
        // rendered score so the table never reads as a capability claim.
        push({ role: "system", meta: "bench", text: `${String(ev.comparability || "candidateOnly")}${report}` });
        setStatus("ready");
        return;
      }
      // ── /tbench (see kernel _handle_tbench) ─────────────────────────────
      // Same TOP-LEVEL runId-less pattern as bench_* so the cross-run guard is
      // bypassed (the comment at the guard explains why). Each task is a bubble;
      // the result carries the markdown scorecard + the comparability caveat.
      if (t === "tbench_start") {
        const model = String(ev.model || "model");
        const total = Number(ev.totalTasks || 0);
        const scoring = String(ev.scoring || "host") === "container"
          ? "FAITHFUL container scoring" : "host-best-effort scoring";
        push({ role: "system", meta: "tbench",
               text: `terminal-bench 2.1 · ${model} · ${total} task(s) · ${scoring}…` });
        setStatus(`tbench: ${model} · 0/${total}`);
        return;
      }
      if (t === "tbench_progress") {
        const taskName = String(ev.task || "task");
        const idx = Number(ev.case_idx ?? -1);
        const total = Number(ev.total || 0);
        const deferred = ev.deferred === true;
        const passed = ev.passed === true;
        const mark = deferred ? "·" : (passed ? "✓" : "✗");
        const lat = ev.latency_s == null ? "" : ` (${Number(ev.latency_s)}s)`;
        const err = (!passed && !deferred && ev.error) ? ` · ${String(ev.error).slice(0, 70)}` : "";
        const suf = deferred ? " · deferred to Docker" : "";
        push({ role: "system", meta: "tbench", ok: passed,
               text: `${taskName} · ${idx + 1}/${total} · ${mark}${lat}${suf}${err}` });
        setStatus(`tbench: ${idx + 1}/${total}`);
        return;
      }
      if (t === "tbench_result") {
        if (ev.ok === false) {
          push({ role: "system", ok: false, text: `tbench failed: ${String(ev.error || "unknown")}` });
          setStatus("tbench failed");
          return;
        }
        const table = String(ev.table || "");
        if (table) push({ role: "assistant", text: table, collapsed: false });
        push({ role: "system", meta: "tbench",
               text: `${String(ev.comparability || "candidateOnly")}` });
        setStatus("ready");
        return;
      }
      // ── /gaia (see kernel _handle_gaia) ─────────────────────────────────
      // Per-level harness diagnostic. Each question is a bubble; the result carries
      // the per-level breakdown + the weakness-gradient diagnosis.
      if (t === "gaia_start") {
        const lvl = ev.level == null ? "all levels" : `Level ${ev.level}`;
        push({ role: "system", meta: "gaia",
               text: `GAIA · ${lvl} · ${Number(ev.totalQuestions || 0)} questions · running…` });
        setStatus(`gaia: 0/${Number(ev.totalQuestions || 0)}`);
        return;
      }
      if (t === "gaia_progress") {
        const idx = Number(ev.case_idx ?? -1);
        const total = Number(ev.total || 0);
        const passed = ev.passed === true;
        const lat = ev.latency_s == null ? "" : ` (${Number(ev.latency_s)}s)`;
        push({ role: "system", meta: "gaia", ok: passed,
               text: `L${ev.level} q${idx + 1}/${total} · ${passed ? "✓" : "✗"}${lat}` });
        setStatus(`gaia: ${idx + 1}/${total}`);
        return;
      }
      if (t === "gaia_result") {
        if (ev.ok === false) {
          push({ role: "system", ok: false, text: `gaia failed: ${String(ev.error || "unknown")}` });
          setStatus("gaia failed");
          return;
        }
        // The diagnosis payload is an opaque JSON object from the kernel
        // ({levels, overall, diagnosis}); cast to a typed local so the renderer
        // can read its fields without TS object-index errors.
        const diag = ev.diagnosis as
          | { levels?: Record<string, { passed?: number; n?: number; rate?: number }>;
              overall?: { passed?: number; n?: number; rate?: number };
              diagnosis?: string[] }
          | undefined;
        if (diag && typeof diag === "object") {
          const lv = diag.levels || {};
          const lines = ["## GAIA per-level harness diagnostic"];
          for (const lvl of Object.keys(lv).sort()) {
            const d = lv[lvl] || {};
            lines.push(`- **Level ${lvl}**: ${d.passed ?? 0}/${d.n ?? 0} (${Math.round((d.rate || 0) * 100)}%)`);
          }
          const ov = diag.overall || {};
          lines.push(`\n**Overall**: ${ov.passed ?? 0}/${ov.n ?? 0} (${Math.round((ov.rate || 0) * 100)}%)`);
          if (Array.isArray(diag.diagnosis) && diag.diagnosis.length) {
            lines.push("");
            for (const f of diag.diagnosis) lines.push(`- ${f}`);
          }
          push({ role: "assistant", text: lines.join("\n"), collapsed: false });
        }
        push({ role: "system", meta: "gaia",
               text: `${String(ev.comparability || "candidateOnly")}` });
        setStatus("ready");
        return;
      }
      // ── /taubench (see kernel _handle_taubench) ─────────────────────────
      // pass^k reliability — the harness-flakiness metric.
      if (t === "taubench_start") {
        push({ role: "system", meta: "taubench",
               text: `τ-bench · ${String(ev.domain || "?")} · ${Number(ev.numTrials || 0)} trials/task · running…` });
        setStatus(`taubench: ${ev.domain}…`);
        return;
      }
      if (t === "taubench_progress") {
        const passed = (Number(ev.reward || 0) > 0.5);
        push({ role: "system", meta: "taubench", ok: passed,
               text: `task ${ev.task_id} · trial ${Number(ev.trial || 0) + 1}/${Number(ev.numTrials || 0)} · ${passed ? "✓" : "✗"}` });
        return;
      }
      if (t === "taubench_result") {
        if (ev.ok === false) {
          push({ role: "system", ok: false, text: `taubench failed: ${String(ev.error || "unknown")}` });
          setStatus("taubench failed");
          return;
        }
        const passk = (ev.passk || {}) as Record<string, number>;
        const curve = Object.keys(passk).sort((a, b) => Number(a) - Number(b))
          .map((k) => `pass^${k}=${Math.round((Number(passk[k]) || 0) * 100)}%`).join(" · ");
        const lines = ["## τ-bench reliability (pass^k)",
                       `**pass@1**: ${Math.round((Number(ev.passAt1) || 0) * 100)}%`,
                       `**curve**: ${curve}`,
                       `**n**: ${ev.nTasks} tasks × ${ev.numTrials} trials`];
        const tbDiag = ev.diagnosis;
        if (Array.isArray(tbDiag)) for (const f of tbDiag) lines.push(`- ${f}`);
        push({ role: "assistant", text: lines.join("\n"), collapsed: false });
        push({ role: "system", meta: "taubench",
               text: `${String(ev.comparability || "candidateOnly")}` });
        setStatus("ready");
        return;
      }
      // ── /update (see kernel _handle_update) ────────────────────────────
      if (t === "update_start") {
        push({ role: "system", meta: "update", text: `updating from ${String(ev.repo || "repo")}…` });
        setStatus("updating…");
        return;
      }
      if (t === "update_progress") {
        push({ role: "system", meta: "update", text: `update: ${String(ev.step || "…")}` });
        setStatus(`Update · ${String(ev.step || "working").slice(0, 48)}`);
        return;
      }
      if (t === "update_result") {
        if (ev.ok === false) {
          push({ role: "system", ok: false, text: `update failed: ${String(ev.error || "unknown")}` });
          setStatus("update failed");
          return;
        }
        push({ role: "system", meta: "update", ok: true, text: `updated to ${String(ev.version || "latest")} — restart sophia-tui to use the new build` });
        setStatus("ready");
        return;
      }
      if (t === "workflows") {
        const nodes = Array.isArray(ev.nodes) ? ev.nodes : [];
        const capabilities = ev.capabilities && typeof ev.capabilities === "object" ? ev.capabilities as { cancel?: boolean; retry?: boolean; logs?: boolean } : {};
        dispatchWorkflow({ type: "snapshot", snapshot: { nodes: nodes as any[], trees: Array.isArray(ev.trees) ? ev.trees : [], capabilities, retention: { retainCompleted: true } } });
        // The overlay owns Return/space/e while visible, so only a snapshot the
        // user actually requested (/tasks, /workflows) may raise it. The startup
        // reconnect restore populates state silently; auto-raising it there made
        // the prompt unsubmittable until Escape.
        const requestedId = String(ev.requestId || "");
        if (requestedId && workflowRequestRef.current.has(requestedId)) {
          workflowRequestRef.current.delete(requestedId);
          closeOtherFullPanePanels("workflow");
          setShowWorkflow(true);
        }
        if (requestedId && teamResumeRequestRef.current.has(requestedId)) {
          teamResumeRequestRef.current.delete(requestedId);
          const restoredRunId = latestWorkflowRunId(nodes as any[]);
          const lanes = (nodes as Array<Record<string, unknown>>).filter((node) =>
            node.kind === "agent" &&
            (restoredRunId ? node.runId === restoredRunId : true),
          );
          if (lanes.length > 0) {
            const count = (state: string) => lanes.filter((node) => String(node.state) === state).length;
            const summary = [
              `restored team progress · ${lanes.length} lane${lanes.length === 1 ? "" : "s"}`,
              `${count("running")} running`,
              `${count("queued")} queued`,
              `${count("succeeded")} succeeded`,
              `${count("failed")} failed`,
              `${count("interrupted")} interrupted`,
            ].join(" · ");
            const interrupted = count("interrupted");
            push({
              role: "system",
              meta: "team",
              ok: interrupted ? false : undefined,
              text: interrupted
                ? `${summary}\nInterrupted lanes were not restarted automatically because replay could duplicate tool work. Review the right-panel rows, then ask Sophia to retry the remaining work.`
                : summary,
            });
          }
        }
        return;
      }
      if (t === "graph_projection") {
        // Read-only OKF projection for the /graph audit panel (kernel _handle_graph).
        // Fail-closed: an ok:false reply (kernel build/import error) is surfaced as a
        // system line and the panel is left on its prior/empty state — never a partial
        // graph. A successful snapshot goes through the reducer, which itself rejects
        // malformed projections and stale (out-of-order sequence) reads.
        if (ev.ok === false) {
          push({ role: "system", ok: false, meta: "graph", text: `graph projection failed: ${String(ev.error || "unknown")}` });
          setStatus("graph projection failed");
          return;
        }
        dispatchGraph({
          type: "snapshot",
          projection: ev.projection,
          sequence: typeof ev.sequence === "number" ? (ev.sequence as number) : undefined,
        });
        setStatus("graph projection (candidateOnly)");
        return;
      }
      if (t === "receipt" || t === "task_action") {
        const nodeEvent = receiptNodeEvent(ev as Record<string, unknown>);
        if (nodeEvent) dispatchWorkflow({ type: "event", event: nodeEvent as any });
        if (t === "task_action" && String(ev.action) === "cancel" && String(ev.status) === "cancelling") {
          setCancelling(true);
          setRunning(true);
          setStatus("cancelling… waiting for terminal result");
          setPhase({ phase: "cancelling", detail: "waiting for terminal result", streamPreview: "" });
        }
        return;
      }
      if (t === "task_log") {
        const node = workflowRef.current.nodes[String(ev.taskId)];
        const detail = ev.detail && typeof ev.detail === "object" ? ev.detail as Record<string, unknown> : {};
        if (node) dispatchWorkflow({ type: "event", event: { ...node, logs: Array.isArray(detail.logs) ? detail.logs as string[] : node.logs, artifacts: Array.isArray(ev.artifacts) ? ev.artifacts as string[] : node.artifacts } });
        return;
      }
      if (t === "provider_login") {
        const text = formatProviderLoginEvent(ev as Record<string, unknown>);
        const ready = ev.ready === true;
        const modelSpec = String(ev.modelSpec || "").trim();
        push({
          role: "system",
          meta: "login",
          text,
          ok: ev.ok !== false,
        });
        if (ready && modelSpec) {
          setModel(modelSpec);
          noteUserChanged("model");
          pushSettings({ model: modelSpec, onboarding: { providerConfirmed: true } });
          setStatus(`signed in · model → ${modelSpec}`);
        } else if (String(ev.status || "") === "starting") {
          setStatus("waiting for browser sign-in…");
        } else {
          setStatus(ready ? "signed in" : "login needs attention");
        }
        return;
      }
      if (t === "provider_health") {
        setRuntimeSnapshot((current) => applyProviderHealth(current, ev));
        if (String(ev.status || "") === "probing") {
          setStatus("ready · checking provider health (no-spend metadata probe)…");
        } else {
          const rows = Array.isArray(ev.providers) ? ev.providers : [];
          setStatus(
            rows.length
              ? `ready · provider health · ${rows.map((row) => {
                  const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
                  return `${String(item.provider || item.model || "provider")}=${String(item.state || "unknown")}`;
                }).join(" · ")} · ready ·`
              : "ready · provider health unavailable · ready ·",
          );
        }
        return;
      }
      if (t === "image_start") {
        push({
          role: "system",
          meta: "image",
          text: `image generation started · provider=${String(ev.provider || "unknown")} · output=${String(ev.outputPath || "")}${ev.delegated === true ? " · delegated" : ""}`,
        });
        setStatus("image generation running…");
        return;
      }
      if (t === "image_result") {
        const ok = ev.ok === true;
        push({
          role: "system",
          meta: "image",
          text: [
            `image ${ok ? "created" : "failed"} · ${String(ev.outputPath || "")}`,
            `provider=${String(ev.provider || "unknown")} · status=${String(ev.status || "unknown")}`,
            String(ev.detail || ""),
          ].filter(Boolean).join("\n"),
          ok,
        });
        setStatus(ok ? "image created" : "image generation failed");
        notifyTerminal({
          kind: ok ? "success" : "error",
          title: ok ? "Sophia image created" : "Sophia image failed",
          body: String(ev.outputPath || ev.detail || ""),
        });
        return;
      }
      if (t === "shell_start") {
        setStatus(`shell · ${String(ev.command || "").slice(0, 60)}`);
        return;
      }
      if (t === "shell_result") {
        const ok = ev.ok === true;
        push({
          role: "system",
          meta: "shell",
          text: formatShellTranscript({
            command: String(ev.command || ""),
            output: String(ev.output || ""),
            error: String(ev.error || ""),
            ok,
          }),
          ok,
        });
        setStatus(ok ? "shell complete" : "shell failed");
        return;
      }
      if (t === "mcp_health") {
        setRuntimeSnapshot((current) => applyMcpHealth(current, ev));
        setStatus(`MCP · ${String(ev.status || (ev.ok === false ? "unhealthy" : "ready"))}`);
        return;
      }
      if (t === "diagnostic_snapshot") {
        const mcp = ev.mcp && typeof ev.mcp === "object" ? ev.mcp : null;
        if (mcp) setRuntimeSnapshot((current) => applyMcpHealth(current, mcp));
        const active = ev.active && typeof ev.active === "object"
          ? ev.active as Record<string, unknown>
          : null;
        const queued = Array.isArray(ev.queueNext) ? ev.queueNext.length : 0;
        push({
          role: "system",
          meta: "doctor",
          text: [
            `bridge instance: ${String((ev.protocolInfo as Record<string, unknown> | undefined)?.bridgeInstanceId || "unknown")}`,
            `active run: ${active ? String(active.runId || "yes") : "none"}`,
            `queued prompts: ${queued}`,
            `MCP: ${String((mcp as Record<string, unknown> | null)?.status || "not probed")}`,
          ].join("\n"),
        });
        return;
      }
      if (t === "ready") {
        setBridgeReady(true);
        updatePluginManager({ type: "seed", payload: ev.plugins });
        const startupProfile = props.initialPrompt
          ? selectedStartupPluginProfile(ev.plugins)
          : null;
        startupProfileBootstrapRef.current = startupProfile;
        startupProfileSettingsRef.current = null;
        setStartupProfileApplied(!startupProfile);
        const parsedRuntime = parseReadyRuntime(ev);
        setRuntimeSnapshot(parsedRuntime);
        setStatus("ready · Sophia harness · fullscreen");
        setProgress(IDLE_PROGRESS);
        // Capture the bridge's discovered model list (local MLX/Ollama/vLLM/DS4
        // caches + cloud options) so the /model picker can offer them. The
        // static MODEL_OPTIONS presets cover the named aliases; this adds the
        // machine-specific models the bridge detected at startup.
        const discovered = Array.isArray(ev.models) ? ev.models as {
          alias: string;
          label?: string;
          setup?: string;
          group?: ModelGroupId;
        }[] : [];
        if (discovered.length) setBridgeModels(discovered);
        if (Array.isArray(ev.skills)) {
          setAvailableSkills(
            ev.skills.filter((skill): skill is Record<string, unknown> =>
              !!skill && typeof skill === "object" && !Array.isArray(skill)
            ),
          );
        }
        if (Array.isArray(ev.tools)) setAvailableTools(parseNativeTools(ev.tools));
        if (Array.isArray(ev.imageProviders)) {
          setImageProviderOptions(
            ev.imageProviders.map((value) => String(value || "").trim()).filter(Boolean),
          );
        }
        // The bridge's ready event carries the resolved default model (which
        // honors ~/.sophia/config.toml via _load_state). Adopt it BEFORE pushing
        // settings back, so we don't clobber the operator's config choice with
        // the TUI's own startup default (props.model, which is "mock" until
        // corrected). Same for mode/permission/effort where the bridge knows
        // better (the persisted session state).
        const readyState = ev.state && typeof ev.state === "object"
          ? (ev.state as Record<string, unknown>)
          : ev;
        const readyDefaults = readyState.defaults && typeof readyState.defaults === "object"
          ? (readyState.defaults as Record<string, unknown>)
          : readyState;
        // `ready` carries a boot SNAPSHOT of the persisted defaults. Adopting it
        // unconditionally overrode what the operator had already established —
        // a flag they typed (`--model grok` showed grok, then silently became
        // the persisted model) or a setting they changed while the bridge was
        // still starting (the prompt box and every local slash command are live
        // before `ready`). Worse, the echo below then wrote the snapshot to
        // disk, so the choice was destroyed rather than merely ignored.
        // A value the operator stated outranks a snapshot; everything else is
        // still adopted, which is what makes the snapshot useful at all.
        const owned = (key: SettingKey) =>
          explicitKeysRef.current.has(key) || userChangedRef.current.has(key);
        const readyRuntime =
          String(readyDefaults.runtime || "sophia").trim().toLowerCase() === "prime"
            ? "prime"
            : "sophia";
        const activeExecutionRuntime = readySettingValue(
          owned("runtime"),
          executionRuntime,
          readyRuntime,
        );
        if (activeExecutionRuntime !== executionRuntime) {
          setExecutionRuntime(activeExecutionRuntime);
        }
        if (!owned("model") && typeof readyDefaults.model === "string" && readyDefaults.model.trim()) {
          setModel(readyDefaults.model);
        }
        if (!owned("mode") && typeof readyDefaults.mode === "string") setMode(readyDefaults.mode);
        const readyPermission = permissionFromBridge(readyDefaults.permission);
        if (!owned("permission") && readyPermission) setPermission(readyPermission);
        const reconciledWorkflowModes = reconcileWorkflowRoutingModes({
          currentWorkflow: workflowModeRef.current,
          currentAgiWorkflow: agiWorkflowModeRef.current,
          snapshotWorkflow: readyDefaults.workflowMode,
          snapshotAgiWorkflow: readyDefaults.agiWorkflowMode,
          workflowOwned: owned("workflowMode"),
          agiWorkflowOwned: agiWorkflowOwnedRef.current,
        });
        // Kernel defaults workflowMode to "auto". Open edition has no workflow
        // controller; adopting that snapshot dispatched `/workflow` and drew
        // the Progress map over the coding CLI.
        const openEditionSolo = !editionAllowsCommand("workflow");
        const activeAgiWorkflowMode = openEditionSolo
          ? "off"
          : reconciledWorkflowModes.agiWorkflowMode;
        const activeWorkflowMode = openEditionSolo
          ? "off"
          : reconciledWorkflowModes.workflowMode as DynamicWorkflowMode;
        setAgiWorkflowMode(activeAgiWorkflowMode);
        agiWorkflowModeRef.current = activeAgiWorkflowMode;
        setWorkflowMode(activeWorkflowMode);
        workflowModeRef.current = activeWorkflowMode;
        if (activeAgiWorkflowMode !== "off") {
          setDynamicWorkflow((prev) => ({
            ...prev,
            configuredMode: "off",
            active: false,
          }));
        }
        const workflowRouting = resolveWorkflowRouting(activeWorkflowMode, {
          autoTeam: false,
          team: 1,
          a2aAgents: a2aAgentsRef.current,
          a2aExecution: a2aExecutionRef.current,
          terminalLayout: terminalLayoutRef.current,
          agiMode: agiModeRef.current,
        });
        const workflowOwnsRouting = activeWorkflowMode !== "off";
        setAutoTeam(false);
        autoTeamRef.current = false;
        setTeamAgents(1);
        teamRef.current = 1;
        if (workflowOwnsRouting) {
          // A CLI/config-selected workflow must be as self-contained as
          // `/workflow on`: stale persisted Team/AGI settings cannot silently
          // win the kernel's mutually-exclusive routing check and turn the
          // requested workflow back off before the initial prompt runs.
          setAutoTeam(workflowRouting.autoTeam);
          autoTeamRef.current = workflowRouting.autoTeam;
          teamRef.current = workflowRouting.team;
          setTeamAgents(workflowRouting.team);
        }
        // A2A defaults come from config.toml / bridge state (e.g. a2a=-1).
        // TUI used to hardcode useState(0) and never adopt ready — every run then
        // sent a2aAgents:0 and overwrote the operator's "a2a on" default.
        const readyA2aRaw = readyDefaults.a2aAgents ?? readyDefaults.a2a;
        if (
          activeWorkflowMode === "off" &&
          !owned("a2aAgents") &&
          readyA2aRaw !== undefined &&
          readyA2aRaw !== null &&
          readyA2aRaw !== ""
        ) {
          const n = Number(readyA2aRaw);
          if (Number.isFinite(n)) {
            // Mirror bridge normalize: true/"on"/"auto" → -1 handled by Number(true)=1
            // so accept explicit -1, 0, or >=2; also bool true via string "true".
            let nextA2a = Math.trunc(n);
            if (readyA2aRaw === true || readyA2aRaw === "true" || readyA2aRaw === "on" || readyA2aRaw === "auto") {
              nextA2a = -1;
            } else if (readyA2aRaw === false || readyA2aRaw === "false" || readyA2aRaw === "off") {
              nextA2a = 0;
            } else if (nextA2a < 0) {
              nextA2a = -1;
            } else if (nextA2a === 1) {
              nextA2a = 0;
            }
            setA2aAgents(nextA2a);
            a2aAgentsRef.current = nextA2a;
          }
        } else if (activeWorkflowMode !== "off") {
          setA2aAgents(workflowRouting.a2aAgents);
          a2aAgentsRef.current = workflowRouting.a2aAgents;
        }
        const readyA2aExecution = String(readyDefaults.a2aExecution || "").trim().toLowerCase();
        if (
          activeWorkflowMode === "off" &&
          !owned("a2aExecution") &&
          (readyA2aExecution === "embedded" || readyA2aExecution === "terminal" || readyA2aExecution === "headless")
        ) {
          setA2aExecution(readyA2aExecution);
          a2aExecutionRef.current = readyA2aExecution;
        } else if (activeWorkflowMode !== "off") {
          setA2aExecution(workflowRouting.a2aExecution);
          a2aExecutionRef.current = workflowRouting.a2aExecution;
        }
        const readyTerminalLayout = String(readyDefaults.terminalLayout || "").trim().toLowerCase();
        if (
          activeWorkflowMode === "off" &&
          !owned("terminalLayout") &&
          (readyTerminalLayout === "off" || readyTerminalLayout === "auto" || readyTerminalLayout === "splits" || readyTerminalLayout === "windows" || readyTerminalLayout === "headless")
        ) {
          setTerminalLayout(readyTerminalLayout);
          terminalLayoutRef.current = readyTerminalLayout;
        } else if (activeWorkflowMode !== "off") {
          setTerminalLayout(workflowRouting.terminalLayout);
          terminalLayoutRef.current = workflowRouting.terminalLayout;
        }
        if (!owned("workflowMaxStages")) {
          const nextMaxStages = Number(readyDefaults.workflowMaxStages);
          if (Number.isFinite(nextMaxStages)) {
            const normalized = Math.max(1, Math.floor(nextMaxStages));
            setWorkflowMaxStages(normalized);
            workflowMaxStagesRef.current = normalized;
          }
        }
        if (!owned("workflowMaxAgents")) {
          const nextMaxAgents = Number(readyDefaults.workflowMaxAgents);
          if (Number.isFinite(nextMaxAgents)) {
            const normalized = Math.max(2, Math.floor(nextMaxAgents));
            setWorkflowMaxAgents(normalized);
            workflowMaxAgentsRef.current = normalized;
          }
        }
        if (workflowOwnsRouting) {
          setAgiMode(workflowRouting.agiMode);
          agiModeRef.current = workflowRouting.agiMode;
        } else if (!owned("agiMode") && typeof readyDefaults.agiMode === "boolean") {
          setAgiMode(readyDefaults.agiMode);
          agiModeRef.current = readyDefaults.agiMode;
        }
        if (!owned("agiProfile")) {
          const nextProfile = String(readyDefaults.agiProfile || "").trim().toLowerCase();
          if (nextProfile === "conservative" || nextProfile === "balanced" || nextProfile === "deep") {
            setAgiProfile(nextProfile);
            agiProfileRef.current = nextProfile;
          }
        }
        if (!owned("agiRoute")) {
          const nextRoute = String(readyDefaults.agiRoute || "").trim().toLowerCase();
          if (nextRoute === "auto" || nextRoute === "fast" || nextRoute === "deliberative" || nextRoute === "critical") {
            setAgiRoute(nextRoute);
            agiRouteRef.current = nextRoute;
          }
        }
        const adoptAgiModel = (
          key: "agiPlannerModel" | "agiWorkerModel" | "agiVerifierModel",
          setter: (value: string) => void,
          ref: { current: string },
        ) => {
          if (owned(key)) return;
          const value = typeof readyDefaults[key] === "string"
            ? String(readyDefaults[key]).trim()
            : "";
          setter(value);
          ref.current = value;
        };
        adoptAgiModel("agiPlannerModel", setAgiPlannerModel, agiPlannerModelRef);
        adoptAgiModel("agiWorkerModel", setAgiWorkerModel, agiWorkerModelRef);
        adoptAgiModel("agiVerifierModel", setAgiVerifierModel, agiVerifierModelRef);
        if (activeAgiWorkflowMode !== "off") {
          setAutoTeam(false);
          autoTeamRef.current = false;
          setTeamAgents(1);
          teamRef.current = 1;
          setA2aAgents(-1);
          a2aAgentsRef.current = -1;
          setA2aExecution("terminal");
          a2aExecutionRef.current = "terminal";
          setTerminalLayout("auto");
          terminalLayoutRef.current = "auto";
          setAgiMode(true);
          agiModeRef.current = true;
        }
        if (!owned("semanticFallbackModel")) {
          const fallbackModel = typeof readyDefaults.semanticFallbackModel === "string"
            ? readyDefaults.semanticFallbackModel.trim()
            : "";
          setSemanticFallbackModel(fallbackModel || null);
        }
        if (!owned("semanticFallbackPolicy")) {
          const fallbackPolicy = String(readyDefaults.semanticFallbackPolicy || "off")
            .trim()
            .toLowerCase();
          setSemanticFallbackPolicy(fallbackPolicy === "confirm" ? "confirm" : "off");
        }
        if (
          !owned("semanticReturnToPrimary")
          && typeof readyDefaults.semanticReturnToPrimary === "boolean"
        ) {
          setSemanticReturnToPrimary(readyDefaults.semanticReturnToPrimary);
        }
        const readyConscienceMode = conscienceModeFromBridge(readyDefaults.conscienceMode);
        const activeConscienceMode = readySettingValue(
          owned("conscienceMode"),
          conscienceModeRef.current,
          readyConscienceMode,
        );
        if (activeConscienceMode !== conscienceModeRef.current) {
          conscienceModeRef.current = activeConscienceMode;
          setConscienceMode(activeConscienceMode);
        }
        const readyEffort = owned("effort") ? null : normalizeEffort(readyDefaults.effort);
        if (readyEffort) setEffort(readyEffort);
        const readyThinking = parseThinkingVisibility(readyDefaults.thinkingVisibility);
        const activeThinking = readySettingValue(
          owned("thinkingVisibility"),
          thinkingVisibilityRef.current,
          readyThinking,
        );
        if (activeThinking !== thinkingVisibilityRef.current) {
          thinkingVisibilityRef.current = activeThinking;
          setThinkingVisibility(activeThinking);
        }
        const readyKeymap = String(readyDefaults.keymap || "").trim().toLowerCase();
        if (["default", "emacs", "vim"].includes(readyKeymap)) {
          setKeymap(readyKeymap as KeymapMode);
        }
        if (typeof readyDefaults.imageProvider === "string" && readyDefaults.imageProvider.trim()) {
          setImageProvider(readyDefaults.imageProvider.trim());
        }
        if (typeof readyDefaults.notifications === "boolean") {
          setNotificationsEnabled(readyDefaults.notifications);
        }
        const readyResponseStyle = normalizeResponseStyle(readyDefaults.responseStyle);
        const activeResponseStyle = readySettingValue(
          owned("responseStyle"), responseStyleRef.current, readyResponseStyle);
        if (activeResponseStyle !== responseStyleRef.current) {
          applyResponseStyle(activeResponseStyle);
        }
        // Acknowledge what the app is ACTUALLY using, so the bridge's persisted
        // state converges on that rather than on the snapshot it just sent.
        bridge.setSettings({
          runtime: activeExecutionRuntime,
          model: !owned("model") && typeof readyDefaults.model === "string" && readyDefaults.model.trim() ? readyDefaults.model : model,
          mode: !owned("mode") && typeof readyDefaults.mode === "string" ? readyDefaults.mode : mode,
          permission: !owned("permission") && readyPermission ? readyPermission : permission,
          // `session` is deliberately absent: for a bare launch resolveSessionName
          // mints a throwaway `sess-<date>-<time>`, and echoing it here persisted
          // that per-launch id as the durable cross-client defaults.session — so
          // the macOS app and the next TUI launch inherited a dead session name.
          // An explicit --session/-s or /session still writes it through its own
          // handler, which is the only place that IS a request to change it.
          effort: readyEffort || effort,
          responseStyle: activeResponseStyle,
          conscienceMode: activeConscienceMode,
          thinkingVisibility: activeThinking,
          // Persist adopted A2A so the next run is not force-zeroed by TUI state 0.
          a2aAgents: a2aAgentsRef.current,
          a2aExecution: a2aExecutionRef.current,
          terminalLayout: terminalLayoutRef.current,
          agiWorkflowMode: agiWorkflowModeRef.current,
          workflowMode: workflowModeRef.current,
          workflowMaxStages: workflowMaxStagesRef.current,
          workflowMaxAgents: workflowMaxAgentsRef.current,
          autoTeam: false,
          team: 1,
          agiMode: agiModeRef.current,
          agiProfile: agiProfileRef.current,
          agiRoute: agiRouteRef.current,
          agiPlannerModel: agiPlannerModelRef.current,
          agiWorkerModel: agiWorkerModelRef.current,
          agiVerifierModel: agiVerifierModelRef.current,
          onboarding: {
            ...(owned("model") ? { providerConfirmed: true } : {}),
            ...(owned("permission") ? { permissionConfirmed: true } : {}),
          },
        });
        if (startupProfile) {
          try {
            // The launcher may have selected a profile directly in the plugin
            // registry before the TUI existed. Re-apply it through CodeBridge:
            // that is the boundary which validates and persists settingsPatch.
            // This command is queued after the initial settings write. Any
            // profile-overlapping CLI/slash values are restored after the
            // result and acknowledged before the initial prompt can run.
            bridge.plugin({
              action: "profile_use",
              reference: startupProfile,
            }, cwd);
          } catch (error) {
            startupProfileBootstrapRef.current = null;
            setStartupProfileApplied(false);
            push({
              role: "system",
              meta: "plugin",
              text:
                `startup plugin profile could not be applied: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ok: false,
            });
            setStatus("startup plugin profile failed — initial prompt held");
          }
        }
        const selectedModel =
          !owned("model") && typeof readyDefaults.model === "string" && readyDefaults.model.trim()
            ? readyDefaults.model
            : model;
        try {
          bridge.providerHealth({
            providers: [String(selectedModel)],
            allowRemoteMetadata: false,
            includeModels: true,
          });
        } catch {
          /* provider health is optional diagnostics, never a startup blocker */
        }
        // No retainCompleted: the bridge's own default hides finished work for
        // an unscoped "what is running now" query. Forcing true here is what
        // surfaced every past session's tasks on startup.
        bridge.listTasks(undefined, sessionRef.current);
        // Restore only durable compound graph receipts. This deliberately does
        // not call session_load: transcript resume remains an explicit user
        // action, while a bridge restart can reconstruct the right-side graph.
        // Open edition has no workflow controller; replaying here used to
        // surface `Error · /workflow is not part of Sophia Code`.
        if (editionAllowsCommand("workflow")) {
          bridge.replayCompoundWorkflows(sessionRef.current || "tui-default");
        }
        // Hydrate UI from disk directly (not via giant NDJSON session_load).
        // Kernel still reads the same file for history= on the next run.
        // A new session starts EMPTY. Auto-hydrating the previous transcript
        // made every launch silently inherit the last conversation, which is
        // both surprising and expensive (it is replayed into the model's
        // history on the next run). Resuming is now an explicit act: SOPHIA_RESUME=1,
        // an explicit --session, or /resume.
        // NOT `!!session`: --session is declared with default:"tui-default", so
        // the parsed value is always truthy and that guard disabled nothing.
        // The question is whether the USER asked, which only argv can answer.
        if (AUTO_RESUME) {
          applyDiskSession(sessionRef.current || "tui-default", { quiet: false });
        }
        setSessionHydrated(true);
        const firstRunSteps = onboardingSteps(ev).filter((step) =>
          step === "model"
            ? !owned("model")
            : step === "permission"
              ? !owned("permission")
              : true
        );
        if (firstRunSteps.length) {
          onboardingQueueRef.current = firstRunSteps;
          setTimeout(() => openPickerRef.current(firstRunSteps[0]), 0);
        }
        // Seed the real context window as soon as it is known, rather than
        // waiting for the first `result` — a resumed session should show a
        // real denominator immediately, not "unknown" until the first reply.
        if ("modelContextWindow" in ev) {
          const window = ev.modelContextWindow;
          setContextTelemetry((prev) => ({ ...(prev || {}), window: typeof window === "number" ? window : null }));
        }
        return;
      }
      if (t === "sessions") {
        // Disk is the single source of truth for the picker (matches /session
        // list). The bridge payload is ignored — it diverged from disk when
        // SOPHIA_CONVERSATIONS_DIR was set, and the payload's flash/blank risk
        // is exactly what PR #1539's disk-first resume removed.
        const { options } = refreshSessionOptionsFromDisk(sessionRef.current);
        setStatus(options.length ? "Select session · ↑↓ Enter · Esc cancel" : "no saved sessions");
        return;
      }
      if (t === "config" || t === "state") {
        if (Array.isArray(ev.tools)) setAvailableTools(parseNativeTools(ev.tools));
        if (permission === "auto" && process.env.SOPHIA_TUI_DEBUG === "1") {
          setStatus("permission auto · acknowledged");
          appendTuiDebug({ lifecycle: "permission_state", state: "auto", correlationId: String(ev.requestId || "") });
        }
        const state = ev.state && typeof ev.state === "object"
          ? ev.state as Record<string, unknown>
          : ev;
        const defaults = state.defaults && typeof state.defaults === "object"
          ? state.defaults as Record<string, unknown>
          : state;
        // This is the bridge ACKNOWLEDGING a settings write, so it echoes the
        // full defaults snapshot — including keys this client never sent. It is
        // therefore the same overwrite hazard as `ready`: a partial write (say
        // Shift+Tab -> permission) came back carrying model/mode/effort too.
        // Honor the operator's own choices over the echo, same rule as above.
        const ackOwned = (key: SettingKey) =>
          explicitKeysRef.current.has(key) || userChangedRef.current.has(key);
        if (!ackOwned("runtime")) {
          setExecutionRuntime(
            String(defaults.runtime || "sophia").trim().toLowerCase() === "prime"
              ? "prime"
              : "sophia",
          );
        }
        if (!ackOwned("model") && typeof defaults.model === "string") setModel(defaults.model);
        if (!ackOwned("mode") && typeof defaults.mode === "string") setMode(defaults.mode);
        const ackPermission = permissionFromBridge(defaults.permission);
        if (!ackOwned("permission") && ackPermission) setPermission(ackPermission);
        const acknowledgedEffort = ackOwned("effort") ? null : normalizeEffort(defaults.effort);
        if (acknowledgedEffort) setEffort(acknowledgedEffort);
        const reconciledWorkflowModes = reconcileWorkflowRoutingModes({
          currentWorkflow: workflowModeRef.current,
          currentAgiWorkflow: agiWorkflowModeRef.current,
          snapshotWorkflow: defaults.workflowMode,
          snapshotAgiWorkflow: defaults.agiWorkflowMode,
          workflowOwned: ackOwned("workflowMode"),
          agiWorkflowOwned: agiWorkflowOwnedRef.current,
        });
        const acknowledgedAgiWorkflowMode =
          reconciledWorkflowModes.agiWorkflowMode;
        const acknowledgedWorkflowMode =
          reconciledWorkflowModes.workflowMode as DynamicWorkflowMode;
        setAgiWorkflowMode(acknowledgedAgiWorkflowMode);
        agiWorkflowModeRef.current = acknowledgedAgiWorkflowMode;
        setWorkflowMode(acknowledgedWorkflowMode);
        workflowModeRef.current = acknowledgedWorkflowMode;
        if (acknowledgedAgiWorkflowMode !== "off") {
          setDynamicWorkflow((prev) => ({
            ...prev,
            configuredMode: "off",
            active: false,
          }));
        }
        const workflowRouting = resolveWorkflowRouting(acknowledgedWorkflowMode, {
          autoTeam: false,
          team: 1,
          a2aAgents: a2aAgentsRef.current,
          a2aExecution: a2aExecutionRef.current,
          terminalLayout: terminalLayoutRef.current,
          agiMode: agiModeRef.current,
        });
        const workflowOwnsRouting = acknowledgedWorkflowMode !== "off";
        setAutoTeam(false);
        autoTeamRef.current = false;
        setTeamAgents(1);
        teamRef.current = 1;
        if (workflowOwnsRouting) {
          setAutoTeam(workflowRouting.autoTeam);
          autoTeamRef.current = workflowRouting.autoTeam;
          teamRef.current = workflowRouting.team;
          setTeamAgents(workflowRouting.team);
        }
        if (
          acknowledgedWorkflowMode === "off" &&
          !ackOwned("a2aAgents") &&
          defaults.a2aAgents !== undefined &&
          defaults.a2aAgents !== null &&
          defaults.a2aAgents !== ""
        ) {
          const n = Number(defaults.a2aAgents);
          if (Number.isFinite(n)) {
            let nextA2a = Math.trunc(n);
            if (nextA2a < 0) nextA2a = -1;
            else if (nextA2a === 1) nextA2a = 0;
            setA2aAgents(nextA2a);
            a2aAgentsRef.current = nextA2a;
          }
        } else if (acknowledgedWorkflowMode !== "off") {
          setA2aAgents(workflowRouting.a2aAgents);
          a2aAgentsRef.current = workflowRouting.a2aAgents;
        }
        const acknowledgedA2aExecution = String(defaults.a2aExecution || "").trim().toLowerCase();
        if (
          acknowledgedWorkflowMode === "off" &&
          !ackOwned("a2aExecution") &&
          (acknowledgedA2aExecution === "embedded" || acknowledgedA2aExecution === "terminal" || acknowledgedA2aExecution === "headless")
        ) {
          setA2aExecution(acknowledgedA2aExecution);
          a2aExecutionRef.current = acknowledgedA2aExecution;
        } else if (acknowledgedWorkflowMode !== "off") {
          setA2aExecution(workflowRouting.a2aExecution);
          a2aExecutionRef.current = workflowRouting.a2aExecution;
        }
        const acknowledgedTerminalLayout = String(defaults.terminalLayout || "").trim().toLowerCase();
        if (
          acknowledgedWorkflowMode === "off" &&
          !ackOwned("terminalLayout") &&
          (acknowledgedTerminalLayout === "off" || acknowledgedTerminalLayout === "auto" || acknowledgedTerminalLayout === "splits" || acknowledgedTerminalLayout === "windows" || acknowledgedTerminalLayout === "headless")
        ) {
          setTerminalLayout(acknowledgedTerminalLayout);
          terminalLayoutRef.current = acknowledgedTerminalLayout;
        } else if (acknowledgedWorkflowMode !== "off") {
          setTerminalLayout(workflowRouting.terminalLayout);
          terminalLayoutRef.current = workflowRouting.terminalLayout;
        }
        if (!ackOwned("workflowMaxStages")) {
          const nextMaxStages = Number(defaults.workflowMaxStages);
          if (Number.isFinite(nextMaxStages)) {
            const normalized = Math.max(1, Math.floor(nextMaxStages));
            setWorkflowMaxStages(normalized);
            workflowMaxStagesRef.current = normalized;
          }
        }
        if (!ackOwned("workflowMaxAgents")) {
          const nextMaxAgents = Number(defaults.workflowMaxAgents);
          if (Number.isFinite(nextMaxAgents)) {
            const normalized = Math.max(2, Math.floor(nextMaxAgents));
            setWorkflowMaxAgents(normalized);
            workflowMaxAgentsRef.current = normalized;
          }
        }
        if (workflowOwnsRouting) {
          setAgiMode(workflowRouting.agiMode);
          agiModeRef.current = workflowRouting.agiMode;
        } else if (!ackOwned("agiMode") && typeof defaults.agiMode === "boolean") {
          setAgiMode(defaults.agiMode);
          agiModeRef.current = defaults.agiMode;
        }
        if (!ackOwned("agiProfile")) {
          const nextProfile = String(defaults.agiProfile || "").trim().toLowerCase();
          if (nextProfile === "conservative" || nextProfile === "balanced" || nextProfile === "deep") {
            setAgiProfile(nextProfile);
            agiProfileRef.current = nextProfile;
          }
        }
        if (!ackOwned("agiRoute")) {
          const nextRoute = String(defaults.agiRoute || "").trim().toLowerCase();
          if (nextRoute === "auto" || nextRoute === "fast" || nextRoute === "deliberative" || nextRoute === "critical") {
            setAgiRoute(nextRoute);
            agiRouteRef.current = nextRoute;
          }
        }
        const acknowledgeAgiModel = (
          key: "agiPlannerModel" | "agiWorkerModel" | "agiVerifierModel",
          setter: (value: string) => void,
          ref: { current: string },
        ) => {
          if (ackOwned(key)) return;
          const value = typeof defaults[key] === "string"
            ? String(defaults[key]).trim()
            : "";
          setter(value);
          ref.current = value;
        };
        acknowledgeAgiModel("agiPlannerModel", setAgiPlannerModel, agiPlannerModelRef);
        acknowledgeAgiModel("agiWorkerModel", setAgiWorkerModel, agiWorkerModelRef);
        acknowledgeAgiModel("agiVerifierModel", setAgiVerifierModel, agiVerifierModelRef);
        if (acknowledgedAgiWorkflowMode !== "off") {
          setAutoTeam(false);
          autoTeamRef.current = false;
          setTeamAgents(1);
          teamRef.current = 1;
          setA2aAgents(-1);
          a2aAgentsRef.current = -1;
          setA2aExecution("terminal");
          a2aExecutionRef.current = "terminal";
          setTerminalLayout("auto");
          terminalLayoutRef.current = "auto";
          setAgiMode(true);
          agiModeRef.current = true;
        }
        if (!ackOwned("semanticFallbackModel")) {
          const fallbackModel = typeof defaults.semanticFallbackModel === "string"
            ? defaults.semanticFallbackModel.trim()
            : "";
          setSemanticFallbackModel(fallbackModel || null);
        }
        if (!ackOwned("semanticFallbackPolicy")) {
          const fallbackPolicy = String(defaults.semanticFallbackPolicy || "off")
            .trim()
            .toLowerCase();
          setSemanticFallbackPolicy(fallbackPolicy === "confirm" ? "confirm" : "off");
        }
        if (
          !ackOwned("semanticReturnToPrimary")
          && typeof defaults.semanticReturnToPrimary === "boolean"
        ) {
          setSemanticReturnToPrimary(defaults.semanticReturnToPrimary);
        }
        const acknowledgedConscienceMode = conscienceModeFromBridge(defaults.conscienceMode);
        if (!ackOwned("conscienceMode") && acknowledgedConscienceMode) {
          conscienceModeRef.current = acknowledgedConscienceMode;
          setConscienceMode(acknowledgedConscienceMode);
        }
        const acknowledgedThinking = ackOwned("thinkingVisibility")
          ? null
          : parseThinkingVisibility(defaults.thinkingVisibility);
        if (acknowledgedThinking) {
          thinkingVisibilityRef.current = acknowledgedThinking;
          setThinkingVisibility(acknowledgedThinking);
        }
        const acknowledgedKeymap = String(defaults.keymap || "").trim().toLowerCase();
        if (["default", "emacs", "vim"].includes(acknowledgedKeymap)) {
          setKeymap(acknowledgedKeymap as KeymapMode);
        }
        if (typeof defaults.imageProvider === "string" && defaults.imageProvider.trim()) {
          setImageProvider(defaults.imageProvider.trim());
        }
        if (typeof defaults.notifications === "boolean") {
          setNotificationsEnabled(defaults.notifications);
        }
        const acknowledgedStyle = ackOwned("responseStyle") ? null : normalizeResponseStyle(defaults.responseStyle);
        if (acknowledgedStyle) applyResponseStyle(acknowledgedStyle);
        const pendingStartupSettings = startupProfileSettingsRef.current;
        if (
          pendingStartupSettings
          && settingsPatchMatchesSnapshot(pendingStartupSettings, defaults)
        ) {
          startupProfileSettingsRef.current = null;
          setStartupProfileApplied(true);
          setStatus("startup plugin profile applied · operator settings restored");
        }
        // Present only when this settings write just changed the model (see
        // types.ts's ModelContextWindowField doc comment) — an unrelated
        // settings ack must not blank out the window a prior switch reported.
        if ("modelContextWindow" in ev) {
          const window = ev.modelContextWindow;
          setContextTelemetry((prev) => ({ ...(prev || {}), window: typeof window === "number" ? window : null }));
        }
        return;
      }
      if (t === "run_start" || t === "lane_start") {
        if (t === "run_start") {
          activeRunIdRef.current = String(ev.runId || "");
          if (activeRunIdRef.current) terminalRunsRef.current.delete(activeRunIdRef.current);
          if (activeRunIdRef.current) resultRunsRef.current.delete(activeRunIdRef.current);
          setA2aConcurrency(null);
          // Tell the reducer which run is current. Without this the workflow
          // fix is INERT: nodes from earlier runs whose terminal event was
          // dropped by the cross-run guard below stay non-terminal forever and
          // keep rendering in the "Active work" banner.
          if (activeRunIdRef.current) {
            dispatchWorkflow({ type: "run_start", runId: activeRunIdRef.current });
          }
          const runtimeWarning = formatRuntimeSourceWarning(
            ev as Record<string, unknown>,
          );
          if (runtimeWarning && VERBOSE_TRANSCRIPT) {
            if (activeRunIdRef.current) {
              runtimeSourceWarningRunsRef.current.add(activeRunIdRef.current);
            }
            push({
              role: "system",
              meta: "runtime",
              text: runtimeWarning,
              ok: false,
            });
          }
          if (runtimeWarning) {
            appendTuiDebug({
              lifecycle: "runtime_source_mismatch",
              runId: activeRunIdRef.current,
              tracePath: String(ev.runtimeSourceAnchor || ""),
              state:
                `runtime=${String(ev.runtimeSourceSha256 || "").slice(0, 12)}` +
                ` workspace=${String(ev.workspaceSourceSha256 || "").slice(0, 12)}`,
            });
          }
          // Baseline the goal panel for this run (run_start carries the goal =
          // the prompt, or the accumulated goal when the goal loop replaced it).
          dispatchGoal(ev as GoalEvent);
          dispatchA2a({ type: "run_start" });
          dispatchDynamicWorkflow({
            type: "run_start",
            runId: activeRunIdRef.current,
            workflowMode: ev.workflowMode ?? workflowModeRef.current,
            workflowMaxStages:
              ev.workflowMaxStages ?? workflowMaxStagesRef.current,
            workflowMaxAgents:
              ev.workflowMaxAgents ?? workflowMaxAgentsRef.current,
          });
          const debugMeta = { lifecycle: "run_start", runId: activeRunIdRef.current, path: Array.isArray(ev.path) ? ev.path as string[] : undefined, ts: String(ev.ts || "") };
          appendTuiDebug(debugMeta);
          if (process.env.SOPHIA_TUI_DEBUG === "1") setStatus(tuiDebugText(debugMeta));
          // A steer typed before the bridge confirmed this run's id was buffered
          // rather than sent against the previous run. Flush it now that the id
          // is known, so steering lands at the first safe boundary of this run.
          const buffered = bufferedSteerRef.current;
          if (buffered && activeRunIdRef.current && buffered.session) {
            bufferedSteerRef.current = null;
            steerPendingRef.current = { text: buffered.text, requestId: buffered.requestId };
            bridgeRef.current?.steer(
              buffered.text,
              activeRunIdRef.current,
              buffered.session,
              buffered.requestId,
            );
            setStatus("steering… awaiting acknowledgement");
          }
        }
        setRunning(true);
        assistantBuf.current = "";
        resetVisibleReasoningStreams();
        setPhase({ phase: "starting", detail: "", streamPreview: "" });
        scrollToLatest();
        return;
      }
      if (t === "event") {
        const kernelEvent = (ev.event || ev) as BridgeEvent;
        dispatchRunEta({
          ...(kernelEvent as Record<string, unknown>),
          type: String(kernelEvent.type || ""),
          receivedAtMs: Date.now(),
        } as RunEtaEvent);
        handleKernelEvent(kernelEvent);
        return;
      }
      if (
        t === "dynamic_workflow_route" ||
        t === "dynamic_workflow_start" ||
        t === "dynamic_workflow_controller_start" ||
        t === "dynamic_workflow_controller_end" ||
        t === "dynamic_workflow_stage_start" ||
        t === "dynamic_workflow_stage_progress" ||
        t === "dynamic_workflow_stage_deadline_extended" ||
        t === "dynamic_workflow_worker_progress" ||
        t === "dynamic_workflow_worker_timeout" ||
        t === "dynamic_workflow_stage_end" ||
        t === "dynamic_workflow_synthesis_start" ||
        t === "dynamic_workflow_end"
      ) {
        dispatchDynamicWorkflow(ev as DynamicWorkflowEvent);
        if (t === "dynamic_workflow_route") {
          const eligible = ev.eligible === true;
          const configured = String(ev.configuredMode || "off");
          const reason = String(ev.reason || "").trim();
          setStatus(
            eligible
              ? `Workflow ${configured} · Main deciding whether to dispatch`
              : `Workflow ${configured} · unavailable${reason ? ` · ${reason}` : ""}`,
          );
        } else if (t === "dynamic_workflow_stage_start") {
          const stage = Number(ev.stage) || 0;
          const pattern = String(ev.pattern || "adaptive");
          const count = Number(ev.taskCount) || 0;
          const concurrency = Number(ev.maxConcurrency) || 0;
          const providerCap = Number(ev.providerConcurrencyCap) || concurrency;
          const waves = Math.max(
            1,
            Math.ceil(count / Math.max(1, concurrency || count || 1)),
          );
          const deferred = Number(ev.deferredTaskCount) || 0;
          const concurrencyReason = String(ev.concurrencyReason || "").trim();
          setA2aConcurrency(concurrency > 0 ? concurrency : null);
          push({
            role: "system",
            meta: "workflow",
            text: VERBOSE_TRANSCRIPT
              ? (
                `Workflow stage ${stage} · ${pattern} · ` +
                `${count} sub-agents · concurrency ${concurrency || "auto"}` +
                ` · ${waves} wave${waves === 1 ? "" : "s"}` +
                (providerCap
                  ? ` · provider cap ${providerCap}`
                  : "") +
                (concurrencyReason ? ` (${concurrencyReason})` : "") +
                (deferred
                  ? ` · ${deferred} task${deferred === 1 ? "" : "s"} deferred to a later stage`
                  : "")
              )
              : (
                `Workflow · stage ${stage}` +
                (count ? ` · ${count} agent${count === 1 ? "" : "s"}` : "")
              ),
          });
          setStatus(`Workflow stage ${stage} · ${pattern} · workers running`);
        } else if (t === "dynamic_workflow_stage_progress") {
          const stage = Number(ev.stage) || 0;
          const active = Number(ev.active) || 0;
          const terminal = Number(ev.terminal) || 0;
          const queued = Number(ev.queued) || 0;
          const total = Number(ev.total) || active + terminal + queued;
          const currentWave = Number(ev.currentWave) || 0;
          const totalWaves = Number(ev.totalWaves) || 0;
          const eta = formatWorkflowDuration(
            Number.isFinite(Number(ev.estimatedRemainingSec))
              ? Number(ev.estimatedRemainingSec)
              : null,
          );
          setStatus(
            `Workflow stage ${stage} · ${terminal}/${total} done · ${active} active` +
              (queued ? ` · ${queued} queued` : "") +
              (totalWaves > 1
                ? ` · wave ${currentWave || 1}/${totalWaves}`
                : "") +
              (eta ? ` · worker ETA ${eta}` : ""),
          );
        } else if (t === "dynamic_workflow_stage_deadline_extended") {
          const stage = Number(ev.stage) || 0;
          const extension = formatWorkflowDuration(
            Number.isFinite(Number(ev.extensionSec))
              ? Number(ev.extensionSec)
              : null,
          );
          const count = Number(ev.deadlineExtensionCount) || 1;
          push({
            role: "system",
            meta: "workflow-progress",
            text:
              `Workflow stage ${stage} deadline extended` +
              (extension ? ` by ${extension}` : "") +
              ` after recent worker progress · extension ${count}`,
          });
          setStatus(
            `Workflow stage ${stage} · workers still progressing · bounded deadline extended`,
          );
        } else if (t === "dynamic_workflow_worker_progress") {
          const stage = Number(ev.stage) || 0;
          setStatus(
            `Workflow stage ${stage} · ${String(ev.progress || "worker progressing")}`,
          );
        } else if (t === "dynamic_workflow_worker_timeout") {
          const stage = Number(ev.stage) || 0;
          push({
            role: "system",
            meta: "workflow-timeout",
            text: `Workflow stage ${stage} worker timed out · ${String(ev.reason || "no progress")}`,
            ok: false,
          });
          setStatus(`Workflow stage ${stage} · worker timeout · barrier draining`);
        } else if (t === "dynamic_workflow_stage_end") {
          const stage = Number(ev.stage) || 0;
          const succeeded = Number(ev.succeeded) || 0;
          const failed = Number(ev.failed) || 0;
          const elapsed = formatWorkflowDuration(
            Number.isFinite(Number(ev.elapsedSec))
              ? Number(ev.elapsedSec)
              : null,
          );
          setStatus(
            `Workflow stage ${stage} complete · ${succeeded} succeeded` +
              (failed ? ` · ${failed} failed` : "") +
              (elapsed ? ` · ${elapsed} elapsed` : "") +
              " · Main reviewing",
          );
        } else if (t === "dynamic_workflow_controller_start") {
          const phase = String(ev.phase || "plan");
          const stage = Number(ev.stage) || 0;
          setStatus(
            phase === "review"
              ? `Workflow stage ${stage} · Main reviewing packet · tools off`
              : "Workflow · Main planning the first parallel stage",
          );
        } else if (t === "dynamic_workflow_synthesis_start") {
          setStatus("Workflow · Main final synthesis");
        } else if (t === "dynamic_workflow_end") {
          const status = String(ev.status || "failed");
          const stages = Number(ev.stages) || 0;
          const total = Number(ev.totalAgents) || 0;
          push({
            role: "system",
            meta: "workflow",
            text:
              `Workflow ${status} · ${stages} stage${stages === 1 ? "" : "s"} · ` +
              `${total} sub-agent${total === 1 ? "" : "s"}` +
              (ev.reason ? `\n${String(ev.reason)}` : ""),
            ok: status === "succeeded" || status === "skipped",
          });
        }
        return;
      }
      if (
        t === "a2a_chain_start" ||
        t === "a2a_agent_start" ||
        t === "a2a_agent_end" ||
        t === "a2a_handoff" ||
        t === "a2a_dispatch" ||
        t === "a2a_dispatch_parse" ||
        t === "a2a_harness_select" ||
        t === "a2a_task_state" ||
        t === "a2a_chain_end"
      ) {
        dispatchA2a(ev as A2AEvent);
        if (t === "a2a_task_state" && Number(ev.workflowStage) > 0) {
          dispatchDynamicWorkflow(ev as DynamicWorkflowEvent);
        }
        if (t === "a2a_agent_start") {
          const name = String(ev.name || "agent");
          const phase = String(ev.phase || "").trim();
          const persona = String(ev.persona || "").trim();
          const skills = Array.isArray(ev.skills)
            ? ev.skills.map((s) => String(s || "").trim()).filter(Boolean)
            : [];
          setStatus(phase ? `A2A · ${name} · ${phase}` : `A2A · ${name} active`);
          if (persona || skills.length) {
            push({
              role: "tool",
              meta: `harness:${name}`,
              text: [
                phase ? `phase=${phase}` : "start",
                persona ? `role=${persona}` : "",
                skills.length ? `skills=${skills.join(",")}` : "",
              ].filter(Boolean).join(" · "),
              ok: true,
            });
          }
        } else if (t === "a2a_dispatch") {
          const n = Number(ev.subCount);
          push({
            role: "system",
            meta: "a2a",
            text: Number.isFinite(n)
              ? `A2A DISPATCH · Main Agent requested ${n} sub-agent${n === 1 ? "" : "s"}`
              : "A2A DISPATCH · plan received",
          });
          // One tool-style row per planned sub so role/skill pins are visible
          // next to later native tool_call rows.
          const tasks = Array.isArray(ev.tasks) ? ev.tasks : [];
          tasks.forEach((raw, i) => {
            const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
            const name = String(row.name || `Sub Agent ${i + 1}`).trim();
            const task = String(row.task || "").trim();
            const persona = String(row.personaId || row.persona || "").trim();
            const skills = Array.isArray(row.skills)
              ? row.skills.map((s) => String(s || "").trim()).filter(Boolean)
              : [];
            const via = String(row.personaVia || "").trim();
            push({
              role: "tool",
              meta: `skill-plan:${name}`,
              text: [
                persona ? `role=${persona}` : "role=auto/none",
                via ? `role_via=${via}` : "",
                skills.length ? `skills=${skills.join(",")}` : "skills=none",
                task ? task.slice(0, 140) : "",
              ].filter(Boolean).join(" · "),
              ok: true,
            });
          });
        } else if (t === "a2a_harness_select") {
          const sub = String(ev.subName || "sub").trim();
          const persona = String(ev.personaId || "").trim();
          const personaVia = String(ev.personaVia || "").trim();
          const skills = Array.isArray(ev.skills)
            ? ev.skills.map((s) => String(s || "").trim()).filter(Boolean)
            : [];
          const skillVia = Array.isArray(ev.skillVia)
            ? ev.skillVia.map((s) => String(s || "").trim()).filter(Boolean)
            : [];
          push({
            role: "tool",
            meta: `skill:${sub}`,
            text: [
              persona ? `role=${persona}` : "role=none",
              personaVia ? `role_via=${personaVia}` : "",
              skills.length ? `skills=${skills.join(",")}` : "skills=none",
              skillVia.length ? `skill_via=${skillVia.join(",")}` : "",
            ].filter(Boolean).join(" · "),
            ok: true,
          });
          setStatus(`harness · ${sub}${persona ? ` · ${persona}` : ""}`);
        } else if (t === "a2a_dispatch_parse") {
          const n = Number(ev.subCount);
          const used = ev.usedTranscript === true;
          push({
            role: "system",
            meta: "a2a",
            text: Number.isFinite(n)
              ? `A2A parse · ${n} task${n === 1 ? "" : "s"} · source=${String(ev.source || "?")}${used ? " · from transcript" : ""}`
              : "A2A parse · no tasks",
            ok: Number.isFinite(n) && n > 0,
          });
        } else if (t === "a2a_handoff") {
          const from = String(ev.from || "prior");
          const to = String(ev.to || "next");
          const persona = String(ev.personaId || "").trim();
          const skills = Array.isArray(ev.skills)
            ? ev.skills.map((s) => String(s || "").trim()).filter(Boolean)
            : [];
          push({
            role: "system",
            meta: "a2a",
            text: [
              `A2A handoff · ${from} → ${to}`,
              persona ? `role=${persona}` : "",
              skills.length ? `skills=${skills.join(",")}` : "",
            ].filter(Boolean).join(" · "),
          });
        }
        return;
      }
      if (
        t === "a2a_supervisor_start" ||
        t === "a2a_supervisor_end" ||
        t === "a2a_supervisor_detached" ||
        t === "terminal_surface_created" ||
        t === "terminal_output"
      ) {
        if (t === "a2a_supervisor_start") {
          setA2aConcurrency(Math.max(1, Math.floor(Number(ev.maxConcurrency) || 1)));
          push({
            role: "system",
            meta: "sessiond",
            text: `A2A supervisor · ${String(ev.execution || "terminal")} · concurrency ${String(ev.maxConcurrency || 1)} · layout ${String(ev.terminalLayout || "auto")}`,
          });
        } else if (t === "terminal_surface_created") {
          push({
            role: "tool",
            meta: "terminal",
            text: `terminal created · ${String(ev.name || ev.taskId || "sub-agent")} · ${String(ev.state || "queued")}`,
            ok: true,
          });
        } else if (t === "a2a_supervisor_detached") {
          push({
            role: "system",
            meta: "sessiond",
            text: "bridge detached · supervised workers continue headlessly · Main verification remains pending",
          });
        } else if (t === "a2a_supervisor_end") {
          push({
            role: "system",
            meta: "sessiond",
            text: `A2A supervisor finished · ${String(ev.state || "unknown")}`,
            ok: ev.state === "succeeded",
          });
        }
        // PTY output is intentionally not copied into chat. The native Sophia
        // Code terminal workspace consumes it; the TUI keeps the transcript
        // concise and uses task-state events for progress.
        return;
      }
      if (
        t === "tool_call" ||
        t === "tool_wait" ||
        t === "tool_result" ||
        t === "provider_progress" ||
        t === "provider_wait" ||
        t === "thinking" ||
        t === "final" ||
        t === "assistant_message" ||
        t === "goal" ||
        isGoalLifecycleEvent(t) ||
        t === "compact" ||
        t === "auto_compact" ||
        t === "todo_update"
      ) {
        handleKernelEvent(ev);
        return;
      }
      if (t === "thinking_token") {
        const chunk = String(ev.text || ev.token || "");
        const visibility = thinkingVisibilityRef.current;
        const live = liveThinkingTokensVisible(visibility);
        const stream = visibleReasoningStreamFor(ev, live && Boolean(chunk));
        const source = liveThinkingTokenSource(
          ev as Readonly<Record<string, unknown>>,
          stream?.source || null,
        );
        if (stream && source && !stream.source) stream.source = source;
        const firstChunk = stream?.growth.rawChars === 0;
        if (stream && source && live && chunk) {
          const update = pushStreamGrowth(
            stream.growth,
            chunk,
            Date.now(),
          );
          stream.growth = update.state;
          if (update.changed) {
            surfaceVisibleReasoning(stream, update.text, source);
          }
        }
        if (source && live && firstChunk && chunk) {
          setPhase({ phase: "thinking", streamPreview: "" });
        }
        appendTuiDebug({ lifecycle: "thinking_token", runId: String(ev.runId || activeRunIdRef.current || ""), path: Array.isArray(ev.path) ? ev.path as string[] : undefined });
        return;
      }
      if (t === "token") {
        const chunk = String(ev.text || ev.token || "");
        const firstChunk = assistantBuf.current.length === 0;
        assistantBuf.current += chunk;
        // Backend streaming is transport only. Do not append or update a chat
        // row per token. Completed assistant transcript rows paint at arrival;
        // the authoritative `result` remains the only terminal answer.
        if (firstChunk && chunk) {
          setPhase({ phase: "streaming", streamPreview: "" });
        }
        return;
      }
      if (t === "stream_withheld") {
        // The bridge stopped forwarding text because the streamed output
        // tripped the hard floor. Say so plainly, rather than letting the
        // preview freeze mid-sentence and read like a hang. The authoritative
        // verdict is still the end-of-loop delivery gate's.
        assistantBuf.current = "";
        flushVisibleReasoningStreams();
        resetVisibleReasoningStreams();
        setPhase({
          phase: "streaming",
          detail: String(ev.reason || "output withheld by the conscience floor"),
          streamPreview: "",
        });
        return;
      }
      if (t === "semantic_refusal_detected") {
        const primary = [ev.primaryProvider, ev.primaryModel].filter(Boolean).join(" · ");
        push({
          role: "system",
          meta: "fallback",
          text:
            `primary returned a non-substantive policy refusal${primary ? ` · ${primary}` : ""}\n` +
            `${String(ev.reason || "semantic refusal detected")} · checking configured local recovery`,
          ok: false,
        });
        setStatus("primary refusal detected · local recovery check…");
        return;
      }
      if (t === "semantic_fallback_skipped") {
        push({
          role: "system",
          meta: "fallback",
          text:
            `local recovery not run · ${String(ev.reason || "not configured")}\n` +
            "Use /fallback-model <local-provider:model> to configure confirmed recovery.",
          ok: false,
        });
        setStatus("local recovery skipped");
        return;
      }
      if (t === "semantic_fallback_start") {
        // The primary refusal is no longer the answer being streamed. Clear its
        // preview before local tokens arrive so the progress surface never
        // stitches two authorities into one apparent response.
        assistantBuf.current = "";
        flushVisibleReasoningStreams();
        resetVisibleReasoningStreams();
        const fallback = [ev.fallbackProvider, ev.fallbackModel].filter(Boolean).join(" · ");
        push({
          role: "system",
          meta: "fallback",
          text:
            `approved authority transition · cloud → local${fallback ? ` · ${fallback}` : ""}\n` +
            `same tool permission · final Conscience policy: ${conscienceDeliverySummary(conscienceModeRef.current)}`,
        });
        setPhase({ phase: "starting", detail: "running approved local recovery", streamPreview: "" });
        setStatus("local recovery running…");
        return;
      }
      if (t === "semantic_fallback_complete") {
        const fallback = [ev.provider, ev.model].filter(Boolean).join(" · ");
        const eventConscienceMode =
          conscienceModeFromBridge(ev.conscienceMode) ?? conscienceModeRef.current;
        const reviewedCandidateLabel =
          eventConscienceMode === "off"
            ? "candidate ready · final-text gate off"
            : eventConscienceMode === "report"
              ? "candidate ready · advisory reviewed"
              : "gate-cleared candidate ready";
        push({
          role: "system",
          meta: "fallback",
          text:
            `local recovery complete${fallback ? ` · ${fallback}` : ""} · ` +
            `${ev.gated === true
              ? "gate held"
              : ev.ok === false
                ? "failed"
                : ev.semanticRefusal === true
                  ? "local model also returned a non-substantive refusal"
                  : reviewedCandidateLabel}`,
          ok: ev.ok !== false && ev.gated !== true && ev.semanticRefusal !== true,
        });
        setStatus(ev.gated === true ? "local result held by gate" : "local recovery complete");
        return;
      }
      if (t === "semantic_primary_resume_start") {
        assistantBuf.current = "";
        flushVisibleReasoningStreams();
        resetVisibleReasoningStreams();
        const primary = [ev.primaryProvider, ev.primaryModel].filter(Boolean).join(" · ");
        push({
          role: "system",
          meta: "fallback",
          text:
            `returning the local candidate to the selected primary${primary ? ` · ${primary}` : ""}\n` +
            "candidate is marked untrusted · primary must verify, continue, and avoid repeated side effects",
        });
        setPhase({ phase: "starting", detail: "primary verification and continuation", streamPreview: "" });
        setStatus("primary continuing from local candidate…");
        return;
      }
      if (t === "semantic_primary_resume_complete") {
        const primary = [ev.provider, ev.model].filter(Boolean).join(" · ");
        push({
          role: "system",
          meta: "fallback",
          text:
            `primary continuation complete${primary ? ` · ${primary}` : ""} · ` +
            `${ev.gated === true ? "final gate held" : ev.ok === false ? "failed" : "authoritative answer ready"}`,
          ok: ev.ok !== false && ev.gated !== true,
        });
        setStatus(ev.gated === true ? "primary continuation held by gate" : "primary continuation complete");
        return;
      }
      if (t === "semantic_primary_resume_declined") {
        assistantBuf.current = "";
        flushVisibleReasoningStreams();
        resetVisibleReasoningStreams();
        push({
          role: "system",
          meta: "fallback",
          text:
            `primary continuation did not produce a usable answer · ${String(ev.reason || "declined")}\n` +
            "No retry loop was started; retaining the local result under the selected final-answer policy.",
          ok: false,
        });
        setStatus("primary declined continuation · local result retained");
        return;
      }
      if (t === "approval_request") {
        const approvalTool = String(ev.tool || "tool");
        const approvalId = kernelApprovalId(ev.id);
        if (!approvalId) {
          push({
            role: "system",
            meta: "approval",
            text: "approval request missing kernel id · denied",
            ok: false,
          });
          setStatus("approval request missing kernel id");
          return;
        }
        const approvalDestructive = ev.destructive === true;
        // "Always allow <tool> for this session" (PermissionDialog's [a]
        // affordance) short-circuits a LATER matching request client-side —
        // still telling the bridge so its own ledger/gate stays authoritative
        // — but never for a destructive match, even for a tool already
        // granted: a blanket "always allow write_file" must not wave through
        // the one write_file call that happens to be `rm`-shaped.
        if (!approvalDestructive && sessionAllowedToolsRef.current.has(approvalTool)) {
          bridgeRef.current?.approve(approvalId, true);
          push({
            role: "system",
            meta: "approval",
            text: `auto-approved · ${approvalTool} · always-allow this session`,
            ok: true,
          });
          return;
        }
        const wasEmpty = approvalQueueRef.current.length === 0;
        const next = updateApprovalQueue({ type: "enqueue", approval: {
          kind: "tool",
          id: approvalId,
          tool: approvalTool,
          preview: String(ev.preview || ""),
          // Additive kernel fields (agent/diff_preview.py + the approval-real-diff
          // work): a real diff/authoritative risk/destructive flag when the
          // kernel sent one, so PermissionDialog's diff/risk/destructive props
          // (already built) receive real data instead of staying permanently
          // undefined. Every field is optional on the wire — an older kernel
          // build simply never sends it.
          ...(typeof ev.diff === "string" && ev.diff ? { diff: ev.diff } : {}),
          ...(typeof ev.risk === "string" && ev.risk ? { risk: ev.risk } : {}),
          ...(ev.destructive === true ? { destructive: true } : {}),
        } });
        if (wasEmpty) {
          setPhase({
            phase: "awaiting_permission",
            detail: String(ev.tool || "tool"),
          });
        } else {
          setStatus(`approval queued · ${next.length} pending`);
        }
        return;
      }
      if (t === "approval_decision") {
        // Today an approval leaves only a transient status line, so scrollback
        // has no record of what was authorised — the operator cannot answer
        // "did I actually approve that rm -rf" by scrolling up. A durable
        // system row fixes that; this is additive to the y/n handling in the
        // key-input loop, which still resolves the pending queue itself.
        const tool = String(ev.tool || "tool");
        const allowed = ev.allow !== false;
        const risk = typeof ev.risk === "string" && ev.risk ? ` · risk ${ev.risk}` : "";
        push({
          role: "system",
          meta: "approval",
          text: `${allowed ? "approved" : "denied"} · ${tool}${risk}`,
          ok: allowed,
        });
        return;
      }
      if (t === "hook_dispatch") {
        // A hook decision fires on every matching PreToolUse/PostToolUse/Stop
        // call; keep a bounded recent log for a future /hooks view and — the
        // important part — never let a BLOCK pass silently. A hook that
        // denies a tool call with no visible reason just looks like the tool
        // vanished.
        const record: HookDispatchRecord = {
          runId: typeof ev.runId === "string" ? ev.runId : undefined,
          event: typeof ev.event === "string" ? ev.event : undefined,
          tool: typeof ev.tool === "string" ? ev.tool : null,
          allowed: ev.allowed !== false,
          blockedBy: typeof ev.blockedBy === "string" ? ev.blockedBy : null,
          reason: typeof ev.reason === "string" ? ev.reason : undefined,
          outcomes: Array.isArray(ev.outcomes) ? (ev.outcomes as HookDispatchRecord["outcomes"]) : undefined,
          ts: typeof ev.ts === "string" ? ev.ts : undefined,
        };
        setHookDispatchLog((prev) => [record, ...prev].slice(0, HOOK_DISPATCH_LOG_LIMIT));
        if (record.allowed === false) {
          push({
            role: "system",
            meta: "hook",
            text: `hook blocked ${record.tool || "a tool call"}` +
              `${record.blockedBy ? ` · ${record.blockedBy}` : ""}` +
              `${record.reason ? ` · ${record.reason}` : ""}`,
            ok: false,
          });
        }
        return;
      }
      if (t === "hooks") {
        // Reply to {"cmd":"hooks"} — real loaded config + recent dispatch
        // history, requested by the /hooks branch below. Rendered here (not
        // just stored) so a user sees what will run BEFORE it runs, per that
        // command's whole point.
        const config = ev.config && typeof ev.config === "object" ? (ev.config as HookConfigSummary) : null;
        setHookConfig(config);
        const recent = Array.isArray(ev.recent) ? (ev.recent as HookDispatchRecord[]) : [];
        if (recent.length) setHookDispatchLog(recent);
        const rules = config?.rules || [];
        const ruleLines = rules.length
          ? rules.map((rule) =>
              `  ${rule.event || "?"} · matches "${rule.matcher || "*"}" · runs: ${(rule.command || []).join(" ") || "?"}` +
              `${typeof rule.timeoutSec === "number" ? ` · timeout ${rule.timeoutSec}s` : ""}`,
            )
          : ["  (no hooks configured — add .sophia/hooks.toml to define one)"];
        const dispatchLine = recent.length
          ? `${recent.length} recent dispatch(es) · most recent: ${recent[0].event || "?"} on ${recent[0].tool || "a tool"} · ${recent[0].allowed === false ? "blocked" : "allowed"}`
          : "no dispatches recorded yet this session";
        push({
          role: "system",
          meta: "hooks",
          text: [
            `hooks: ${config?.enabled ? "enabled" : "disabled"}${config?.source ? ` · ${config.source}` : ""}` +
              `${config?.error ? ` · error: ${config.error}` : ""}`,
            ...ruleLines,
            dispatchLine,
          ].join("\n"),
        });
        return;
      }
      if (t === "checkpoints") {
        // Reply to {"cmd":"checkpoints"}, requested by /checkpoints and by
        // /rewind's no-argument form. Rendered as a readable, most-recent-first
        // list (the kernel returns oldest-first) so a checkpoint id is
        // immediately copy-pasteable into /rewind <id>.
        const items = Array.isArray(ev.items) ? (ev.items as FileCheckpointEntry[]) : [];
        setFileCheckpointItems(items);
        if (!items.length) {
          push({
            role: "system",
            meta: "checkpoint",
            text: "no file checkpoints recorded for this run yet — one is captured automatically before each approved write_file/edit_file.",
          });
          return;
        }
        const mostRecentFirst = [...items].reverse();
        const rows = mostRecentFirst.map((item, index) => {
          const kind = item.existed === false ? "created — /undo or /rewind deletes it" : "modified — /undo or /rewind restores its prior bytes";
          return `  ${index + 1}. ${item.path || "?"} · ${kind} · id ${item.id || "?"}${item.ts ? ` · ${item.ts}` : ""}`;
        });
        push({
          role: "system",
          meta: "checkpoint",
          text: `${items.length} file checkpoint(s) for this run, most recent first (/undo reverts #1):\n${rows.join("\n")}`,
        });
        return;
      }
      if (t === "checkpoint_result") {
        const ok = ev.ok !== false;
        const action = ev.action === "undo" || ev.action === "restore" ? ev.action : undefined;
        const detail = typeof ev.detail === "string" ? ev.detail : "";
        setLastCheckpointResult({
          type: "checkpoint_result",
          ok,
          action,
          session: typeof ev.session === "string" ? ev.session : undefined,
          detail: detail || null,
          errorType: typeof ev.errorType === "string" ? ev.errorType : null,
        });
        // `detail` is already the kernel's own human-readable line naming
        // exactly which file (and checkpoint id) was reverted, or exactly why
        // the restore failed — no client-side reconstruction needed.
        push({
          role: "system",
          meta: "checkpoint",
          text: `${action || "checkpoint"} ${ok ? "complete" : "failed"}${detail ? ` · ${detail}` : ""}`,
          ok,
        });
        return;
      }
      if (t === "local_engine_report") {
        setLocalEngineRuntimeReport(ev as LocalEngineReportEvent);
        // Clear the "loading…" line the /local command set. Without this the
        // status row keeps claiming the probe is still running while the panel
        // beside it is already showing the finished report — the one place a
        // user looks to find out whether a slow local probe finished says the
        // opposite of the truth.
        setStatus("local engines · ↑↓ Enter · Esc close");
        return;
      }
      if (t === "adapter_status") {
        setLocalAdapterStatus(ev as AdapterStatusEvent);
        return;
      }
      if (t === "model_preflight") {
        const preflight = ev as ModelPreflightEvent;
        const specKey = String(preflight.spec || preflight.model || "");
        if (specKey) {
          setModelPreflightBySpec((prev) => ({ ...prev, [specKey]: preflight }));
        }
        if (preflight.ready === false) {
          // Auto-emitted right before a run would otherwise fail against an
          // unreachable/not-ready local model. Say what to do about it —
          // the kernel's own `fix` text — instead of letting the operator
          // watch the run fail with a generic, unexplained error next.
          push({
            role: "system",
            meta: "model",
            text: `selected model not ready · ${preflight.reason || "unavailable"}` +
              `${preflight.fix ? ` · ${preflight.fix}` : ""}`,
            ok: false,
          });
          setStatus("selected model not ready — see the note above");
        }
        return;
      }
      if (t === "steer_ack" || t === "steer_applied") {
        const pending = steerPendingRef.current;
        if (pending && (!ev.requestId || ev.requestId === pending.requestId)) {
          steerPendingRef.current = null;
          setInput("");
          inputRef.current = "";
          push({ role: "system", text: `steer accepted · ${pending.text}`, ok: true });
        }
        return;
      }
      if (t === "steer_rejected") {
        steerPendingRef.current = null;
        setStatus(`steer rejected · ${String(ev.reason || "not accepted").slice(0, 80)}`);
        return;
      }
      if (t === "queue_next_ack") {
        const queueStatus = String(ev.status || "unknown");
        if (ev.ok === false || queueStatus === "rejected") {
          push({
            role: "system",
            meta: "queue",
            text: `queued prompt rejected · ${String(ev.reason || "not accepted")}`,
            ok: false,
          });
          setStatus("queue rejected");
        } else if (queueStatus === "starting") {
          push({ role: "system", meta: "queue", text: "queued prompt is starting now" });
          setStatus("queued prompt starting…");
        } else {
          setStatus(`queued · position ${Number(ev.position) || 1}`);
        }
        return;
      }
      if (t === "sessions") {
        // Disk is the single source of truth for the picker (matches /session
        // list). The bridge payload is ignored — it diverged from disk when
        // SOPHIA_CONVERSATIONS_DIR was set, and the payload's flash/blank risk
        // is exactly what PR #1539's disk-first resume removed.
        const { options } = refreshSessionOptionsFromDisk(sessionRef.current);
        setStatus(options.length ? "Select session · ↑↓ Enter · Esc cancel" : "no saved sessions");
        return;
      }
      if (t === "session") {
        // Prefer disk load (reliable). Bridge payload is huge and used to flash/blank.
        const loaded = String(ev.session || sessionRef.current || "tui-default");
        applyDiskSession(loaded, { quiet: false });
        try {
          bridge.setSettings({ session: loaded, selectedSessionID: loaded });
        } catch {
          /* best-effort */
        }
        setSessionHydrated(true);
        sessionPickerRef.current = null;
        setSessionPicker(null);
        return;
      }
      if (t === "result") {
        flushVisibleReasoningStreams();
        // What the gate actually checked this turn. Kept even when the answer
        // was delivered: "delivered" and "checked" are not the same claim.
        setEpistemic((ev.epistemic as EpistemicStatus) || null);
        epistemicRef.current = (ev.epistemic as EpistemicStatus) || null;
        // How full the window is NOW. Compaction reported before/after, but
        // only at the moment it fired, so between compactions there was no way
        // to tell 5% from 79% — which is exactly the number that decides
        // whether to /compact. Rendered as status text rather than a new
        // status-line field: layoutStatusLine's width ladder exists because
        // an unbudgeted field once corrupted the row mid-word, and telemetry
        // is not worth re-opening that.
        contextUsageRef.current = describeContextUsage(
          ev.contextTokens as number | undefined,
          ev.contextWindow as number | undefined,
          ev.contextBudget as number | undefined,
        );
        // Real state alongside the display string above, for a future
        // StatusLine to render directly rather than re-parsing that string —
        // `source` says whether `used` is the provider's own reported count
        // or a char/4 estimate, so a renderer never implies precision the
        // kernel does not actually have.
        {
          const nextContextTelemetry = {
            used: typeof ev.contextTokens === "number" ? ev.contextTokens : undefined,
            window: typeof ev.contextWindow === "number" ? ev.contextWindow : undefined,
            budget: typeof ev.contextBudget === "number" ? ev.contextBudget : undefined,
            source: ev.contextTokensSource === "reported" || ev.contextTokensSource === "estimated"
              ? ev.contextTokensSource
              : undefined,
          };
          setContextTelemetry(nextContextTelemetry);
          contextTelemetryRef.current = nextContextTelemetry;
        }
        if (ev.cost && typeof ev.cost === "object" && !Array.isArray(ev.cost)) {
          const parts = Object.entries(ev.cost as Record<string, unknown>)
            .filter(([, value]) => Number.isFinite(Number(value)))
            .map(([key, value]) => `${key}=${Number(value).toFixed(4)}`);
          setLastCost(parts.join(", "));
        } else if (Number.isFinite(Number(ev.costUsd))) {
          setLastCost(`$${Number(ev.costUsd).toFixed(4)}`);
        } else {
          setLastCost("");
        }
        // Per-turn telemetry (local-model-telemetry): tokens/ttft/tok-per-sec/
        // cost, all optional — an older kernel build simply omits them. Costs
        // accumulate into a running session total distinct from `lastCost`'s
        // display string above.
        {
          const nextTelemetry = {
            promptTokens: typeof ev.promptTokens === "number" ? ev.promptTokens : undefined,
            completionTokens: typeof ev.completionTokens === "number" ? ev.completionTokens : undefined,
            costUsd: typeof ev.costUsd === "number" ? ev.costUsd : undefined,
            ttftMs: typeof ev.ttftMs === "number" ? ev.ttftMs : undefined,
            tokensPerSec: typeof ev.tokensPerSec === "number" ? ev.tokensPerSec : undefined,
          };
          setRunTelemetry(nextTelemetry);
          runTelemetryRef.current = nextTelemetry;
          if (typeof nextTelemetry.costUsd === "number") {
            const nextTotal = sessionCostUsdRef.current + nextTelemetry.costUsd;
            sessionCostUsdRef.current = nextTotal;
            setSessionCostUsd(nextTotal);
          }
        }
        // Per-turn file-change summary (tool-call-transparency): folds
        // filesTouched + optional per-file line counts into one headline plus
        // a per-file breakdown, tolerating every shape the kernel might (or
        // might not, on an older build) send.
        setFileChangeSummary(summarizeFileChanges(ev.filesTouched, ev.fileChanges));
        const terminalKey = String(ev.runId || ev.id || activeRunIdRef.current || "");
        if (terminalKey && resultRunsRef.current.has(terminalKey)) return;
        if (terminalKey) resultRunsRef.current.add(terminalKey);
        // Terminal results always pin the answer to the bottom of the chat and
        // force the viewport there (see pinMessageToEnd + multi-frame
        // scrollToLatest below). Mid-run scroll preservation made completed
        // DS4 tool loops look like "only tool cards" with the report above.
        if (terminalKey) {
          const receipt = aggregateRunReceipt(
            bridgeEventsRef.current.filter((event) =>
              String(event.runId || "") === terminalKey
            ),
            {
              runId: terminalKey,
              sessionId: String(ev.session || sessionRef.current || ""),
              workflowNodes: Object.values(workflowRef.current.nodes).filter((node) =>
                !node.runId || node.runId === terminalKey
              ),
            },
          );
          runReceiptsRef.current.push(receipt);
          if (runReceiptsRef.current.length > 200) {
            runReceiptsRef.current.splice(0, runReceiptsRef.current.length - 200);
          }
        }
        // Say so when something other than the selected model answered.
        // SOPHIA_MODEL_FALLBACKS lets a failed primary be satisfied by another
        // provider, and the status line only ever showed the picked alias — so
        // "I chose grok" could be answered by a local model with nothing on
        // screen to say so. Which model produced an answer is not a detail.
        if (ev.fallbackUsed === true) {
          const served = [ev.provider, ev.resolvedModel].filter(Boolean).join(" · ");
          push({
            role: "system",
            text: `⚠ ${model} did not answer — served by ${served || "a fallback provider"} `
              + `(SOPHIA_MODEL_FALLBACKS)`,
            ok: false,
          });
        }
        if (ev.semanticFallbackUsed === true) {
          const local = [ev.semanticFallbackProvider, ev.semanticFallbackModel]
            .filter(Boolean)
            .join(" · ");
          const primary = [ev.primaryResumeProvider, ev.primaryResumeModel]
            .filter(Boolean)
            .join(" · ");
          const outcome = ev.returnedToPrimary === true
            ? `local candidate verified/continued by ${primary || "the selected primary"}`
            : ev.primaryResumeDeclined === true
              ? "primary continuation declined; local answer retained"
              : "local answer retained";
          push({
            role: "system",
            meta: "fallback",
            text:
              `semantic recovery provenance · ${local || "configured local model"}\n` +
              `${outcome} · final Conscience policy: ${conscienceDeliverySummary(
                conscienceModeFromBridge(ev.conscienceMode) ?? conscienceModeRef.current,
              )}`,
            ok: ev.gated !== true,
          });
        }
        if (ev.executionRuntime === "prime") {
          const reportedPolicyMode =
            String(ev.toolPolicyMode || PRIME_POLICY_MODE).trim().toLowerCase() === "full"
              ? "full"
              : "advisory";
          push({
            role: "system",
            meta: "runtime",
            text: [
              `execution provenance · Prime Agent ${String(ev.externalRuntimeVersion || "version unknown")}`,
              "authority: external user-level process; Sophia did not retroactively approve tool actions",
              `${reportedPolicyMode} tool policy checked: ${ev.toolPolicyChecked === true ? "yes" : "NO"}`,
              `final output floor checked: ${ev.outputFloorChecked === true ? "yes" : "NO"}`,
              "Prime autonomy surfaces exposed: no · candidateOnly · canClaimAGI:false",
            ].join("\n"),
            ok: ev.ok === true && ev.outputFloorChecked === true,
          });
        }
        setPhase({ phase: "finalizing", detail: "" });
        if (ev.cancelled === true) {
          const reason = String(ev.error || ev.reason || "cancelled by operator").slice(0, 200);
          const partial = assistantBuf.current.trim();
          assistantBuf.current = "";
          resetVisibleReasoningStreams();
          // Cancellation is a completed backend boundary too. If the provider
          // produced a partial answer before stopping, mount it once now rather
          // than having streamed it through the prompt's redraw path.
          if (partial) {
            push({
              role: "assistant",
              text: displayFinalText(partial, {
                exactOutput: false,
                cap: TRANSCRIPT_ROW_CHAR_CAP,
              }),
              collapsed: false,
            });
          }
          push({
            role: "system",
            meta: "cancelled",
            text: `run cancelled · ${reason} · partial tool output and the local receipt were kept`,
          });
          stickBottomRef.current = true;
          setTimeout(scrollToLatest, 0);
          setStatus("cancellation answer received · waiting for kernel completion");
          setPhase({ phase: "finalizing", detail: "cancellation received", streamPreview: "" });
          return;
        }
        const text = bridgeEventText(ev) || assistantBuf.current;
        const awaitingInput =
          ev.awaitingInput === true
          || String(ev.goalStatus || "") === "awaiting_input"
          || ["paused", "awaiting_input", "interrupted"].includes(
            String(ev.agiStatus || "").toLowerCase(),
          );
        const incomplete = ev.incomplete === true || awaitingInput;
        const incompleteReason = String(
          ev.incompleteReason || "execution slice ended before the objective completed",
        ).replaceAll("_", " ").slice(0, 200);
        const awaitingReason = String(
          ev.goalReason || ev.incompleteReason || "operator action is required",
        ).replaceAll("_", " ").slice(0, 500);
        const resultKey = String(ev.id || ev.runId || activeRunIdRef.current || text);
        // Prefer the fullest assistant body from this exchange when the terminal
        // recap is shorter than a mid-run report (common on DS4 after a stray
        // tool + force-conclusion). Then PIN that body as the last chat row so
        // it sits at the bottom — upgrade-in-place left it buried above tools.
        const decision = resolveFinalRow({
          text,
          alreadyDelivered: finalKeysRef.current.has(resultKey),
        });
        if (decision.action === "error") {
          // A run that FAILED for a stated reason is not a malformed result, and
          // calling it one buries the only sentence that tells the operator what
          // to do — "workspace folder not found … pass --cwd <dir>" was arriving
          // here, being relabelled as a protocol defect, and then clipped at 160
          // characters so the recovery instruction itself was cut off. That reads
          // as "the app is broken" rather than "this folder is gone", which is
          // the difference between a user fixing it in one step and not knowing
          // where to look. Report the kernel's own words, and keep enough of
          // them to act on; only fall back to the protocol wording when the
          // result genuinely carries no reason at all.
          const reason = String(ev.error || ev.message || "").trim();
          push({
            role: "system",
            text: reason
              ? `run failed · ${reason.slice(0, TRANSCRIPT_ROW_CHAR_CAP)}`
              : "run failed · the bridge returned no answer and no reason",
            ok: false,
          });
        } else if (decision.action === "upgrade" || decision.action === "push") {
          finalKeysRef.current.add(resultKey);
          const pinId = decision.action === "upgrade" ? decision.id : uid();
          setMessages((prev) => {
            const preferred = preferBestFinalText(
              text,
              activeExchangeAssistantTexts(prev),
            );
            const shown = displayFinalText(preferred, {
              exactOutput: ev.exactOutput === true,
              cap: TRANSCRIPT_ROW_CHAR_CAP,
            });
            const existing = prev.find((m) => m.id === pinId);
            const row = {
              id: pinId,
              role: "assistant" as const,
              text: shown,
              ok: awaitingInput ? undefined : ev.ok !== false,
              collapsed: false,
              ...(existing?.meta ? { meta: existing.meta } : {}),
            };
            // Drop the preview row + any earlier copy of the same preferred body
            // so the pinned answer is the unique bottom row.
            const removeIds = prev
              .filter(
                (m) =>
                  m.role === "assistant"
                  && m.id !== pinId
                  && ((preferred.length > 200 && m.text === preferred)
                    || (m.text === text && text.length > 0)),
              )
              .map((m) => m.id);
            return pinMessageToEnd(prev, row, removeIds);
          });
          setFocusedMsgId(pinId);
        }
        // Terminal answers always pin the viewport to the bottom. Operators
        // expect the final report at the lowest chat position; preserving
        // mid-run scroll left the answer above tool cards and looked empty.
        stickBottomRef.current = true;
        setTimeout(scrollToLatest, 0);
        setTimeout(scrollToLatest, 32);
        setTimeout(scrollToLatest, 120);
        if (text.trim()) {
          setStatus(
            incomplete
              ? "run incomplete · final answer at bottom"
              : "answer received · verifying run completion",
          );
        }
        if (incomplete) {
          push({
            role: "system",
            meta: awaitingInput ? "awaiting-input" : "incomplete",
            text: awaitingInput
              ? `awaiting your input · ${awaitingReason} · type resume after completing the requested action`
              : `run incomplete · ${incompleteReason} · type resume to continue from the saved checkpoint`,
            ok: awaitingInput ? undefined : false,
          });
        }
        assistantBuf.current = "";
        resetVisibleReasoningStreams();
        if (awaitingInput) {
          // An AGI approval/input checkpoint is intentionally not
          // run_finished. Release the prompt for operator intervention while
          // leaving automation waiters blocked on the durable run boundary.
          setRunning(false);
          setCancelling(false);
          submitLockRef.current = false;
          activeRunIdRef.current = null;
          bufferedSteerRef.current = null;
          steerPendingRef.current = null;
          clearApprovalQueue();
          setPhase({
            phase: "paused",
            detail: "resumable",
            streamPreview: "",
          });
          notifyTerminal({
            kind: "warning",
            title: "Sophia is awaiting your input",
            body: awaitingReason,
          });
        } else {
          setPhase({
            phase: "finalizing",
            detail: ev.ok === false || !text.trim()
              ? "failed answer received · closing run"
              : "answer received · closing run",
            streamPreview: "",
          });
        }
        if (ev.ok !== false && text.trim() && planModeRef.current?.phase === "running") {
          let completedPlan = planModeRef.current;
          for (let index = 0; index < completedPlan.steps.length; index += 1) {
            const active = activePlanStep(completedPlan);
            if (!active) break;
            const next = transitionPlanMode(completedPlan, {
              type: "set_step_status",
              stepId: active.id,
              status: "completed",
            });
            if (!next.accepted) break;
            completedPlan = next.state;
          }
          setPlanModeState(completedPlan);
          if (completedPlan.phase === "completed") {
            push({ role: "system", meta: "plan", text: "approved local plan completed · verification result received" });
          }
        }
        // Empty when the kernel could not estimate it — see describeContextUsage.
        // Do not overwrite the "final answer at bottom" status with context %
        // immediately — operators use that status as confirmation the pin worked.
        if (incomplete) {
          setStatus("run incomplete · final answer at bottom · type resume to continue");
        } else if (!text.trim()) {
          setStatus(
            ev.ok === false
              ? "run failed · see system error above"
              : (contextUsageRef.current || "run complete"),
          );
        }
        return;
      }
      if (t === "run_finished") {
        const terminalKey = String(ev.runId || ev.id || activeRunIdRef.current || "");
        if (terminalKey && terminalRunsRef.current.has(terminalKey)) return;
        if (terminalKey) terminalRunsRef.current.add(terminalKey);
        dispatchA2a(ev as A2AEvent);
        dispatchDynamicWorkflow(ev as DynamicWorkflowEvent);
        dispatchGoal({ type: "result", ok: ev.ok });
        setRunning(false);
        setCancelling(false);
        submitLockRef.current = false;
        activeRunIdRef.current = null;
        bufferedSteerRef.current = null;
        steerPendingRef.current = null;
        clearApprovalQueue();
        const reason = String(ev.reason || (ev.ok === true ? "verified" : "error"));
        setPhase({
          phase: reason === "cancel" ? "cancelled" : ev.ok === true ? "done" : "error",
          detail: ev.ok === true ? "" : reason,
          streamPreview: "",
        });
        setStatus(
          ev.ok === true
            ? "run complete · final answer at bottom"
            : reason === "cancel"
              ? "run cancelled · details at bottom"
              : `run finished · ${reason}`,
        );
        notifyTerminal({
          kind: ev.ok === true ? "success" : reason === "cancel" ? "warning" : "error",
          title: ev.ok === true
            ? "Sophia run complete"
            : reason === "cancel"
              ? "Sophia run cancelled"
              : "Sophia run failed",
          body:
            `${String(ev.mode || "solo")} · `
            + `${String(ev.session || sessionRef.current || "session")}`,
        });
        if (progressResetTimerRef.current) clearTimeout(progressResetTimerRef.current);
        progressResetTimerRef.current = setTimeout(() => {
          progressResetTimerRef.current = null;
          setProgress(IDLE_PROGRESS);
        }, 1200);
        props.onRunFinished?.(ev);
        return;
      }
      if (t === "error") {
        // Every bridge `error` is a COMMAND-level failure (bad shape, unknown
        // cmd, rejected steer, "a run is already active"), and it carries no
        // runId. A run that dies reports through `result` with ok:false.
        //
        // So tearing the run down here was wrong whenever a run was genuinely
        // executing: an unrelated rejected command nulled the live run's id and
        // cleared `running`, after which the run's own events no longer matched
        // and its answer was pushed against whatever the user typed next.
        // A live run is exactly the case where activeRunIdRef is set; when it is
        // null the run never started (e.g. the `run` command itself was
        // rejected) and the UI must still be released.
        const runInFlight = !!activeRunIdRef.current;
        push({
          role: "system",
          text: `error: ${String(ev.error || ev.message || "unknown")}`,
          ok: false,
        });
        if (runInFlight) {
          // Leave running/phase/approval alone — the run owns them and is still
          // going. Only the submit lock must be released so the input is usable.
          submitLockRef.current = false;
          return;
        }
        submitLockRef.current = false;
        setRunning(false);
        setCancelling(false);
        activeRunIdRef.current = null;
        bufferedSteerRef.current = null;
        steerPendingRef.current = null;
        // No run in flight: release the goal panel too (running→idle). A command
        // error while a run IS in flight returned above and leaves it untouched.
        dispatchGoal({ type: "error" });
        // The run that raised this approval is over, so no answer can ever come.
        // Leaving it up disables the prompt input against a dead run — only the
        // `result` path cleared it, and an errored run never reaches `result`.
        clearApprovalQueue();
        setPhase({
          phase: "error",
          detail: String(ev.error || ev.message || "unknown").slice(0, 80),
          streamPreview: "",
        });
      }
    };

    bridge.on("event", onEvent);
    bridge.on("stderr", (s: string) => {
      if (s.trim()) setStatus(s.trim());
    });
    bridge.on("error", (error: Error) => {
      submitLockRef.current = false;
      setRunning(false);
      setBridgeReady(false);
      clearApprovalQueue();
      setStatus(`bridge error: ${error.message}`);
      // The status line is transient and easy to miss; a bridge that failed to
      // start (e.g. SOPHIA_PYTHON pointing at a deleted venv) otherwise leaves
      // the operator with an app that simply never answers.
      push({ role: "system", text: `bridge error: ${error.message}`, ok: false });
    });
    bridge.on("exit", () => {
      submitLockRef.current = false;
      setRunning(false);
      setBridgeReady(false);
      clearApprovalQueue();
      setStatus("bridge exited; restart the TUI to recover");
    });
    // Liveness. The bridge has always emitted both of these and NOTHING
    // subscribed, so a wedged kernel looked exactly like a slow one: the
    // spinner kept turning and the operator had no way to tell "thinking" from
    // "this will never come back".
    //
    // Display by exception (Phase0-Research-Synthesis §5): a stall is rare and
    // actionable, so it earns a transcript row the operator cannot scroll past
    // — but only on the EDGE, never repeated while it persists, or a long wedge
    // would paper the transcript with duplicates. Recovery is status-line only:
    // it needs to clear the warning, not celebrate.
    bridge.on("stall", (info: { stalled: boolean; sinceMs: number }) => {
      const effect = stallEffect(!!info.stalled, Number(info.sinceMs), stalledRef.current);
      stalledRef.current = !!info.stalled;
      if (effect.row) push({ role: "system", ...effect.row });
      if (effect.status) setStatus(effect.status);
    });
    bridge.on("backpressure", (info: { active: boolean; queued: number }) => {
      setStatus(backpressureEffect(!!info.active, Number(info.queued)).status);
    });
    // Auto-cancel announcements. The bridge now escalates a wedged/over-budget
    // run to a cancel instead of spinning forever; these name WHY the spinner
    // stopped so a handled failure does not read as a crash. Each latches in
    // the bridge, so each is at most one row per run.
    bridge.on("stall_timeout", (info: { sinceMs: number }) => {
      const effect = stallTimeoutEffect(Number(info.sinceMs));
      // The stall is over (we cancelled); clear the edge so a future wedge in a
      // later run still earns its own first-row warning.
      stalledRef.current = false;
      if (effect.row) push({ role: "system", ...effect.row });
      if (effect.status) setStatus(effect.status);
    });
    bridge.on("run_timeout", (info: { elapsedMs: number; timeoutMs: number }) => {
      const effect = runTimeoutEffect(Number(info.elapsedMs), Number(info.timeoutMs));
      if (effect.row) push({ role: "system", ...effect.row });
      if (effect.status) setStatus(effect.status);
    });

    return () => {
      bridge.off("event", onEvent);
      bridge.stop();
    };
    // The bridge is process-scoped: its runtime root is fixed by the install
    // location, and the workspace travels per run. Create/stop it exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialPromptCanStart({
      initialPrompt: props.initialPrompt,
      bridgeReady,
      sessionHydrated,
      startupProfileApplied,
      alreadySent: initialPromptSentRef.current,
    })) {
      initialPromptSentRef.current = true;
      void submitLine(props.initialPrompt!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeReady, sessionHydrated, startupProfileApplied]);

  // ── Interactive pickers (model / effort / mode / …) ─────────────────
  // The /model picker's option list is the static MODEL_OPTIONS presets
  // PLUS whatever the bridge discovered locally (MLX/Ollama/vLLM/DS4 caches).
  // Computed once via useMemo so the render site and the input handler see
  // the SAME list — otherwise arrow-key wrap and selection resolve against
  // different lengths and a discovered-model row indexes into undefined.
  const modelOptions = useMemo<PickerOption[]>(
    () => mergeModelOptions(MODEL_OPTIONS, bridgeModels).map((option) => {
      const provider = option.value.split(":", 1)[0];
      const engine = runtimeSnapshot.engines.find((candidate) => candidate.provider === provider);
      const health = runtimeSnapshot.providerHealth.find((candidate) =>
        candidate.provider === option.value ||
        candidate.provider === provider ||
        candidate.model === option.value
      );
      const runtimeHint = engine
        ? engine.ready
          ? "local engine ready"
          : engine.installed
            ? "installed but not ready"
            : "not installed"
        : health
          ? `health: ${health.state}`
          : "";
      return {
        ...option,
        hint: [option.hint, runtimeHint].filter(Boolean).join(" · "),
      };
    }),
    [bridgeModels, runtimeSnapshot],
  );
  const modelOptionsRef = useRef(modelOptions);
  modelOptionsRef.current = modelOptions;
  const modelPickerOptions = useMemo<ModelPickerRow[]>(
    () => groupModelOptions(modelOptions, expandedModelGroups),
    [expandedModelGroups, modelOptions],
  );
  const modelPickerOptionsRef = useRef(modelPickerOptions);
  modelPickerOptionsRef.current = modelPickerOptions;
  const imagePickerOptions = useMemo<PickerOption[]>(
    () => mergeModelOptions(
      optionsFor("imageProvider"),
      imageProviderOptions.map((alias) => ({
        alias,
        label: alias,
        setup: alias === "grok-cli"
          ? "delegated local CLI; generation still requires explicit approval"
          : "configured image provider",
      })),
    ),
    [imageProviderOptions],
  );
  const imagePickerOptionsRef = useRef(imagePickerOptions);
  imagePickerOptionsRef.current = imagePickerOptions;

  const pickerOptionsFor = useCallback((kind: PickerKind): PickerOption[] => {
    if (kind === "model") return modelPickerOptionsRef.current;
    if (kind === "imageProvider") return imagePickerOptionsRef.current;
    return optionsFor(kind);
  }, []);
  const pickerOptionsForRef = useRef(pickerOptionsFor);
  pickerOptionsForRef.current = pickerOptionsFor;

  const openPicker = useCallback((kind: PickerKind) => {
    // Use the merged model list so a discovered model (e.g. an MLX-cached
    // Qwen) that is the current selection is highlighted on open, not lost
    // because the static preset list doesn't contain it.
    const opts = pickerOptionsForRef.current(kind);
    let selected = 0;
    const current =
      kind === "model"
        ? model
        : kind === "effort"
          ? effort
          : kind === "mode"
            ? mode
            : kind === "permission"
              ? permission
              : kind === "thinking"
                  ? thinkingVisibility
                  : kind === "keymap"
                    ? keymap
                    : kind === "imageProvider"
                      ? imageProvider
              : kind === "benchMode"
                ? benchModeRef.current
                : themeName;
    const idx = kind === "model"
      ? modelPickerSelectionIndex(opts as ModelPickerRow[], current)
      : opts.findIndex((o) => o.value === current);
    if (idx >= 0) selected = idx;
    if (kind === "model" && onboardingQueueRef.current[0] === "model") {
      const recommended = runtimeSnapshotRef.current.engines.find(
        (engine) => engine.ready && !engine.optionalGateway,
      )?.provider;
      const recommendedOption = recommended
        ? modelOptionsRef.current.find((option) =>
            option.value === recommended || option.value.startsWith(`${recommended}:`)
          )
        : undefined;
      const recommendedIndex = recommendedOption
        ? modelPickerSelectionIndex(opts as ModelPickerRow[], recommendedOption.value)
        : -1;
      if (recommendedIndex >= 0) selected = recommendedIndex;
    }
    const next = { kind, selected };
    pickerReadyRef.current = false;
    activePickerRef.current = next;
    setActivePicker(next);
    // A leftover query from whatever picker was open before this one must
    // never silently hide rows in a picker the operator hasn't typed into
    // yet — every fresh open starts unfiltered.
    pickerFilterQueryRef.current = "";
    setPickerFilterQuery("");
    setStatus(`${titleFor(kind)} — ↑↓ Enter · Esc cancel`);
  }, [effort, imageProvider, keymap, model, mode, permission, themeName, thinkingVisibility]);
  openPickerRef.current = openPicker;

  const startProviderLogin = useCallback((provider: string) => {
    const spec = browserLoginProviderForModel(provider) || provider.trim().toLowerCase();
    push({
      role: "system",
      meta: "login",
      text: `Starting ${spec} browser sign-in via the official CLI…`,
    });
    try {
      bridgeRef.current?.providerLogin({ action: spec });
      setStatus(`waiting for ${spec} browser sign-in…`);
    } catch {
      push({
        role: "system",
        text: "bridge is down — cannot start provider login",
        ok: false,
      });
    }
  }, [push]);

  const applyPickerValue = useCallback(
    (kind: PickerKind, value: string) => {
      if (kind === "model") {
        const row = modelPickerOptionsRef.current.find((option) => option.value === value);
        if (row?.kind === "group") {
          const now = Date.now();
          if (modelGroupToggleRef.current.value === value && now - modelGroupToggleRef.current.at < 80) {
            return;
          }
          modelGroupToggleRef.current = { value, at: now };
          const nextExpanded = toggleModelGroup(expandedModelGroupsRef.current, row.groupId);
          expandedModelGroupsRef.current = nextExpanded;
          setExpandedModelGroups(nextExpanded);
          const nextRows = groupModelOptions(modelOptionsRef.current, nextExpanded);
          modelPickerOptionsRef.current = nextRows;
          const next = {
            kind,
            selected: Math.max(0, nextRows.findIndex((option) => option.value === value)),
          };
          activePickerRef.current = next;
          setActivePicker(next);
          // `selected` above is an index into the FULL (unfiltered) row list;
          // a query typed before expanding/collapsing this group would then
          // point at the wrong row once the filtered list is re-derived from
          // it. Clearing it keeps the just-toggled group's own row correct
          // rather than trying to re-resolve a stale query against a
          // structurally different option list.
          pickerFilterQueryRef.current = "";
          setPickerFilterQuery("");
          setStatus(`${row.label} ${nextExpanded.includes(row.groupId) ? "expanded" : "collapsed"}`);
          return;
        }
      }
      // Bench mode picker: record the chosen benchmark, then start the model
      // multi-pick loop (Esc in handlePickerInput runs it in that mode).
      if (kind === "benchMode") {
        benchModeRef.current = value === "tool-use" ? "tool-use" : "knowledge";
        activePickerRef.current = null;
        setActivePicker(null);
        benchPickRef.current = [];
        benchPickAtRef.current = 0;
        const label = benchModeRef.current;
        push({ role: "system", meta: "bench", text: `bench mode → ${label} · pick model 1 · Enter add · Esc run` });
        openPicker("model");
        setStatus(`bench (${label}): pick model 1 · Enter add · Esc run`);
        return;
      }
      // Bench multi-pick loop: collect model specs WITHOUT touching the active
      // model, then re-open the picker for the next pick. Esc (handled in
      // handlePickerInput) ends the loop and runs the benchmark. The 80ms guard
      // drops the twin delivery of one Enter (see benchPickRef declaration).
      if (kind === "model" && benchPickRef.current !== null) {
        const now = Date.now();
        if (now - benchPickAtRef.current < 80) return;
        benchPickAtRef.current = now;
        // Reject a duplicate: benchmarking the same spec twice yields two
        // identical table rows and a confusing report, so a repeat Enter on an
        // already-picked model re-opens the picker WITHOUT adding it again.
        if (benchPickRef.current.includes(value)) {
          const picked = benchPickRef.current.length;
          push({ role: "system", meta: "bench", text: `bench: ${value} already picked (${picked} total) · choose a different model · Esc to run` });
          openPicker("model");
          setStatus(`bench: ${picked} picked · Enter a different model · Esc run`);
          return;
        }
        benchPickRef.current.push(value);
        const n = benchPickRef.current.length;
        push({ role: "system", meta: "bench", text: `bench: added ${value} (${n} picked) · Enter for another · Esc to run` });
        openPicker("model");
        setStatus(`bench: pick model ${n + 1} · Enter add · Esc run`);
        return;
      }
      if (kind === "model") {
        setModel(value);
        noteUserChanged("model");
        pushSettings({ model: value, onboarding: { providerConfirmed: true } });
        try {
          bridgeRef.current?.providerHealth({
            providers: [value],
            allowRemoteMetadata: false,
            includeModels: true,
          });
        } catch {
          /* health is advisory */
        }
        push({ role: "system", text: `model → ${value}` });
        const loginProvider = browserLoginProviderForModel(value);
        if (loginProvider) startProviderLogin(loginProvider);
      } else if (kind === "login") {
        startProviderLogin(value);
      } else if (kind === "effort") {
        const eff = normalizeEffort(value);
        if (!eff) {
          push({ role: "system", text: `invalid effort: ${value}`, ok: false });
          setStatus("effort unchanged");
          return;
        }
        setEffort(eff);
        process.env.SOPHIA_REASONING_EFFORT = eff;
        if (eff === "ultramode") process.env.SOPHIA_ULTRAMODE = "1";
        else delete process.env.SOPHIA_ULTRAMODE;
        noteUserChanged("effort");
        pushSettings({ effort: eff });
        push({
          role: "system",
          text:
            eff === "ultramode"
              ? "effort → ultra (Sophia Ultramode active for all models)"
              : `effort → ${eff}`,
        });
      } else if (kind === "responseStyle") {
        const style = normalizeResponseStyle(value);
        if (!style) {
          push({ role: "system", text: `invalid response style: ${value}`, ok: false });
          setStatus("response style unchanged");
          return;
        }
        applyResponseStyle(style);
        noteUserChanged("responseStyle");
        pushSettings({ responseStyle: style });
        push({ role: "system", text: `response style → ${style}` });
      } else if (kind === "mode") {
        setMode(value);
        noteUserChanged("mode");
        pushSettings({ mode: value });
        push({ role: "system", text: `mode → ${value}` });
      } else if (kind === "permission") {
        const mapped = value as "auto" | "manual" | "readonly";
        setPermission(mapped);
        noteUserChanged("permission");
        pushSettings({
          permission: mapped === "manual" ? "manual" : mapped,
          onboarding: { permissionConfirmed: true },
        });
        push({ role: "system", text: `permission → ${mapped}` });
      } else if (kind === "thinking") {
        const visibility = value as ThinkingVisibility;
        thinkingVisibilityRef.current = visibility;
        setThinkingVisibility(visibility);
        noteUserChanged("thinkingVisibility");
        pushSettings({ thinkingVisibility: visibility });
        push({
          role: "system",
          text:
            `thinking visibility → ${visibility} · provider-visible events only` +
            " · hidden chain-of-thought is never displayed",
        });
      } else if (kind === "keymap") {
        const nextKeymap = value as KeymapMode;
        setKeymap(nextKeymap);
        pushSettings({ keymap: nextKeymap });
        push({ role: "system", text: `keymap → ${nextKeymap}` });
      } else if (kind === "imageProvider") {
        setImageProvider(value);
        pushSettings({
          imageProvider: value,
          onboarding: { imageProviderConfirmed: true },
        });
        push({
          role: "system",
          text: `image provider → ${value} · image generation remains approval-gated`,
        });
      } else if (kind === "theme") {
        setThemeName(value);
        process.env.SOPHIA_THEME = value;
        push({ role: "system", text: `theme → ${value}` });
      }
      activePickerRef.current = null;
      setActivePicker(null);
      if (onboardingQueueRef.current[0] === kind) {
        onboardingQueueRef.current = onboardingQueueRef.current.slice(1);
        const next = onboardingQueueRef.current[0];
        if (next) {
          setStatus("First-run setup · choose the next required setting");
          setTimeout(() => openPickerRef.current(next), 0);
          return;
        }
        push({
          role: "system",
          text: editionAllowsCommand("workflow")
            ? "First-run setup saved locally. Change choices later with /model, /login, /permissions, /a2a, or /workflow."
            : "First-run setup saved locally. Change the model later with /model or /login.",
        });
      }
      setStatus("ready");
    },
    [applyResponseStyle, push, openPicker, startProviderLogin],
  );

  const applyPickerValueRef = useRef(applyPickerValue);
  applyPickerValueRef.current = applyPickerValue;
  const handlePickerInput = useCallback((inputKey: string, key: Key) => {
    const picker = activePickerRef.current;
    if (!picker) return;
    // Use the merged model list (static presets + bridge-discovered models)
    // for the model picker so arrow-key wrap and Enter resolve against the
    // same list the render site drew.
    const opts = pickerOptionsForRef.current(picker.kind);
    const filterQuery = pickerFilterQueryRef.current;
    // Arrows/Enter below MUST resolve against this same filtered slice the
    // render site computes (see pickerOpts) — resolving against the full,
    // unfiltered `opts` while the picker shows a filtered list would move
    // the highlight to, and let Enter select, a different row than the one
    // actually on screen.
    const filteredOpts = filterQuery.trim()
      ? opts.filter((option) => matchPickerOption(option, filterQuery).length > 0)
      : opts;
    if (key.upArrow || key.downArrow) {
      pickerReadyRef.current = true;
      const delta = key.upArrow ? -1 : 1;
      const next = {
        ...picker,
        selected: moveSelection(picker.selected, delta, filteredOpts.length),
      };
      activePickerRef.current = next;
      setActivePicker(next);
    } else if (key.return || inputKey === "\n" || inputKey === "\r") {
      const selected = filteredOpts[picker.selected];
      if (selected) applyPickerValueRef.current(picker.kind, selected.value);
    } else if (key.backspace || key.delete) {
      if (filterQuery) {
        const nextQuery = filterQuery.slice(0, -1);
        pickerFilterQueryRef.current = nextQuery;
        setPickerFilterQuery(nextQuery);
        const next = { ...picker, selected: 0 };
        activePickerRef.current = next;
        setActivePicker(next);
      }
    } else if (
      !key.ctrl &&
      !key.meta &&
      inputKey.length > 0 &&
      !/[\x00-\x1f\x7f]/.test(inputKey)
    ) {
      // Type-to-filter: any other printable keystroke (or a short pasted
      // burst — onModalInput bypasses the composer's own paste decoding, so
      // a multi-character chunk can arrive in one call) narrows the option
      // list. Selection resets to the top match rather than trying to
      // preserve a position that may no longer exist in the narrower list.
      const nextQuery = filterQuery + inputKey;
      pickerFilterQueryRef.current = nextQuery;
      setPickerFilterQuery(nextQuery);
      const next = { ...picker, selected: 0 };
      activePickerRef.current = next;
      setActivePicker(next);
    } else if (key.escape) {
      if (onboardingQueueRef.current[0] === picker.kind) {
        setStatus("This first-run choice is required; select an option with Enter");
        return;
      }
      // Bench multi-pick loop: Esc ends collection and runs the benchmark with
      // the models picked so far (see runLocalSlash "bench" + kernel
      // _handle_bench). Esc reaches only this handler (confirmPicker acts on
      // Enter alone), so there is no twin-delivery to guard against here.
      if (picker.kind === "model" && benchPickRef.current !== null) {
        const specs = benchPickRef.current;
        benchPickRef.current = null;
        activePickerRef.current = null;
        setActivePicker(null);
        if (specs.length >= 1) {
          const bm = benchModeRef.current;
          bridgeRef.current?.bench(specs, bm, 20, true);
          const where = bm === "tool-use" ? "tool-use benchmark" : "knowledge corpus";
          push({ role: "system", meta: "bench", text: `benchmarking ${specs.length} model(s) on the ${where}…` });
          setStatus("benchmarking…");
        } else {
          push({ role: "system", meta: "bench", text: "bench cancelled — no models picked" });
          setStatus("bench cancelled");
        }
        return;
      }
      activePickerRef.current = null;
      setActivePicker(null);
      setStatus("picker cancelled");
    }
  }, [push]);
  useEffect(() => {
    const confirmPicker = (chunk: Buffer | string) => {
      const picker = activePickerRef.current;
      if (!picker || !pickerReadyRef.current) return;
      const raw = String(chunk);
      // PTYs may coalesce a final arrow sequence and Enter into one read
      // (for example "\x1b[B\r"). Ink parses only the first key in that chunk.
      if (!isCoalescedSessionNavigationEnter(raw)) return;
      // `picker.selected` is an index into the FILTERED list (see
      // handlePickerInput, which is what drove it there) — resolving it
      // against the full unfiltered options here would apply whichever
      // option happens to sit at that index in the wrong list.
      const rawOpts = pickerOptionsForRef.current(picker.kind);
      const query = pickerFilterQueryRef.current;
      const filtered = query.trim()
        ? rawOpts.filter((option) => matchPickerOption(option, query).length > 0)
        : rawOpts;
      const selected = filtered[picker.selected];
      if (selected) applyPickerValueRef.current(picker.kind, selected.value);
    };
    // Same coalesced-Enter backup for the session browser: when ↑↓ navigated it
    // (sessionPickerReadyRef), a following Enter that Ink dropped (arrow+Enter
    // arrived as one "\x1b[B\r" read) still ends the raw chunk in \r, so resume
    // the highlighted session here. handleSessionBrowserInput nulls the picker
    // on a clean Enter, so the two paths never double-resume.
    const confirmSessionBrowser = (chunk: Buffer | string) => {
      const picker = sessionPickerRef.current;
      if (!picker || !sessionPickerReadyRef.current) return;
      const raw = String(chunk);
      if (!isCoalescedSessionNavigationEnter(raw)) return;
      const row = sessionRowsRef.current[picker.selected];
      if (!row) {
        setStatus(sessionBrowserQueryRef.current ? "no matching sessions · Esc close" : "no saved sessions · Esc close");
        return;
      }
      if (!selectDiskSessionRef.current(row.id)) return;
      sessionPickerReadyRef.current = false;
    };
    inputEvents.on("input", confirmPicker);
    inputEvents.on("input", confirmSessionBrowser);
    return () => {
      inputEvents.removeListener("input", confirmPicker);
      inputEvents.removeListener("input", confirmSessionBrowser);
    };
  }, [inputEvents]);

  // ── Slash apply helpers ─────────────────────────────────────────────
  const applySlashSelection = useCallback((): string => {
    const matches = slashMatchesRef.current;
    const idx = slashSelectedRef.current;
    const c = matches[idx] || matches[0];
    const currentInput = inputRef.current;
    if (!c) return currentInput;
    const slash = c.slash || "/" + c.name;
    const rest = currentInput.includes(" ") ? currentInput.slice(currentInput.indexOf(" ")) : "";
    const needsSpace = !rest && !!(c.hint && (c.hint.includes("[") || c.hint.includes("<") || c.hint.includes("|")));
    const next = slash + (rest || (needsSpace ? " " : ""));
    inputRef.current = next;
    setInput(next);
    return next;
  }, []);

  const runLocalSlash = useCallback(
    (
      cmd: SlashCommand,
      args: string,
      modelBound: ModelBoundPrompt | null = null,
    ): boolean => {
      const name = cmd.name;
      const confirmLocalAction = (
        title: string,
        preview: string,
        action: () => void,
      ): boolean => {
        const id = uid("confirm");
        pendingLocalActionsRef.current.set(id, action);
        updateApprovalQueue({ type: "enqueue", approval: {
          kind: "local",
          id,
          tool: title,
          preview,
        } });
        setStatus(`${title} requires confirmation · y allow · n deny`);
        return true;
      };

      const rejectSessionTransitionWhileRunning = (target: string): boolean => {
        if (!runningRef.current) return false;
        push({
          role: "system",
          text: `cannot switch to ${target} while a run is in flight — cancel it first (Esc)`,
          ok: false,
        });
        return true;
      };

      const loadSessionSlash = (target: string): boolean => {
        // Disk-first: do not depend on bridge NDJSON for the transcript body.
        selectDiskSession(target);
        return true;
      };

      if (name === "help") {
        // Grouped by the catalog's own category order with a per-row
        // availability badge ([local]/[agent]/[info]/[unavailable]) instead of
        // one flat 100+ line dump — a new user's first /help should read as a
        // map of the product, not a raw table.
        const commands = allCommands();
        const groups = groupByCategory(commands, helpCategoriesFromCatalog(commands));
        const body = groups
          .map((group) => {
            const rows = group.commands.map((c) => {
              const badge = commandBadges(c)[0] || "info";
              return `  ${(c.slash || "/" + c.name).padEnd(18)} [${badge.padEnd(11)}] ${slashRowDescription(c)}`;
            });
            return `${group.label}:\n${rows.join("\n")}`;
          })
          .join("\n\n");
        push({
          role: "system",
          text: `Slash commands (${commands.length}):\n\n${body}\n\nType / then ↑↓ through ALL commands · type to filter · Enter runs highlighted · Tab completes`,
        });
        return true;
      }
      if (name === "clear") {
        setMessages([]);
        setStatus("cleared");
        return true;
      }
      if (name === "harness") {
        void readContinualHarness(cwd).then((state) => {
          push({ role: "system", text: formatContinualHarnessStatus(state) });
          setStatus(state ? "continual harness loaded" : "continual harness not initialized");
        });
        return true;
      }
      if (name === "refine") {
        const intent = parseRefineSlash(args);
        if (intent.action === "help") {
          push({
            role: "system",
            meta: "refine",
            text: [
              "Candidate-only continual-harness refinement",
              "  /refine propose <lesson> :: <evidence>",
              "  /refine preview <query>",
              "",
              "propose appends PENDING state only; preview reads APPLIED supplemental lessons only",
              "no TUI apply · no weight update · no model-uplift claim · no auto-promotion",
            ].join("\n"),
          });
          setStatus("refine help · candidate-only");
          return true;
        }
        if (intent.action === "invalid") {
          push({
            role: "system",
            meta: "refine",
            text: `${intent.reason}\nNo state was changed.`,
            ok: false,
          });
          setStatus("refine command refused");
          return true;
        }
        if (intent.action === "propose") {
          setStatus("appending pending refinement proposal…");
          void proposeContinualRefinement(
            cwd,
            intent.lesson,
            intent.evidence,
          ).then((proposal) => {
            push({
              role: "system",
              meta: "refine",
              text: [
                `refinement proposal ${proposal.id} appended as PENDING`,
                `lesson: ${proposal.lesson}`,
                `evidence: ${proposal.evidence}`,
                "candidate-only · not applied · no weight update · no auto-promotion",
              ].join("\n"),
            });
            setStatus("pending refinement proposal recorded");
          }).catch((error) => {
            push({
              role: "system",
              meta: "refine",
              text: `refinement proposal was not written: ${error instanceof Error ? error.message : String(error)}`,
              ok: false,
            });
            setStatus("refinement proposal write failed");
          });
          return true;
        }
        setStatus("previewing applied refinement lessons…");
        void previewContinualRefinement(cwd, intent.query).then((lessons) => {
          push({
            role: "system",
            meta: "refine",
            text: formatContinualHarnessPreview(intent.query, lessons),
          });
          setStatus(
            lessons.length > 0
              ? `${lessons.length} applied refinement lesson(s) previewed`
              : "no relevant applied refinement lessons",
          );
        }).catch((error) => {
          push({
            role: "system",
            meta: "refine",
            text: `refinement preview failed: ${error instanceof Error ? error.message : String(error)}`,
            ok: false,
          });
          setStatus("refinement preview failed");
        });
        return true;
      }
      if (name === "arc") {
        const intent = parseArcSlashArgs(args);
        if (intent.action === "invalid") {
          push({
            role: "system",
            meta: "arc",
            text: `${intent.reason}\n\n/arc is read-only: it cannot submit, start public evaluation, or stop a sealed run.`,
            ok: false,
          });
          setStatus("ARC command refused · read-only flow");
          return true;
        }
        if (intent.action === "help") {
          push({
            role: "system",
            meta: "arc",
            text: [
              "ARC campaign operator flow (read-only)",
              "  /arc status",
              "  /arc plan arc2",
              "  /arc plan arc3",
              "  /arc copy status",
              "  /arc copy plan arc2|arc3",
              "  /arc close",
              "",
              ...arcOperatorCommands().map((command) => `  ${command}`),
              "",
              "candidate-only · submission-gated · no auto-submit/public-eval/stop",
            ].join("\n"),
          });
          setStatus("ARC operator help");
          return true;
        }
        if (intent.action === "close") {
          setShowArcCampaign(false);
          setStatus("ARC campaign view closed");
          return true;
        }
        if (intent.action === "copy") {
          const copied = copyToClipboard(intent.command);
          if (copied.ok) {
            push({
              role: "system",
              meta: "arc",
              text: `copied ARC command · ${copied.message}\n${intent.command}`,
            });
            setStatus("ARC command copied");
          } else {
            push({
              role: "system",
              meta: "arc",
              text: `${copied.message}\n\n${intent.command}`,
              ok: false,
            });
            setStatus("ARC copy failed · command shown");
          }
          return true;
        }

        const request = ++arcCampaignRequestRef.current;
        closeOtherFullPanePanels("arcCampaign");
        setArcCampaignPanel(loadingArcCampaignPanel(intent.query));
        setShowArcCampaign(true);
        setStatus(
          intent.query.kind === "status"
            ? "ARC2/ARC3 status loading…"
            : `${arcContestLabel(intent.query.contest!)} plan loading…`,
        );
        void loadArcCampaignPanel(intent.query, cwd).then((panel) => {
          if (arcCampaignRequestRef.current !== request) return;
          setArcCampaignPanel(panel);
          setStatus(
            panel.phase === "ready"
              ? `${panel.query.kind === "status" ? "ARC2/ARC3 status" : `${arcContestLabel(panel.query.contest!)} plan`} loaded · candidate-only`
              : `ARC campaign query failed · ${panel.error || "no diagnostic"}`,
          );
        });
        return true;
      }
      if (name === "memory") {
        const action = args.trim().toLowerCase();
        push({
          role: "system",
          meta: "memory",
          text: action === "review"
            ? formatMemoryReview()
            : formatPersonalMemoryStatus(cwd),
        });
        setStatus(action === "review" ? "personal memory review" : "personal memory status");
        return true;
      }
      if (name === "recall") {
        push({
          role: "system",
          meta: "memory",
          text: formatPersonalRecall(args),
        });
        setStatus("personal memory recall · local-only");
        return true;
      }
      if (name === "receipt") {
        push({
          role: "system",
          meta: "harness",
          text: formatHarnessReceipt(session),
        });
        setStatus("latest personal-harness receipt");
        return true;
      }
      if (name === "prompt") {
        push({
          role: "system",
          meta: "harness",
          text: formatPromptReceipt(session),
        });
        setStatus("compiled prompt modules");
        return true;
      }
      if (name === "artifact") {
        push({
          role: "system",
          meta: "artifact",
          text: formatArtifacts(session),
        });
        setStatus("staged artifacts · local-only");
        return true;
      }
      if (name === "new") {
        const requested = args.trim();
        const generated = `sess-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
        if (rejectSessionTransitionWhileRunning(requested || generated)) return true;
        try {
          const created = createSession(requested || generated);
          sessionRef.current = created.sessionId;
          resetSessionTransitionState(
            `opening ${created.sessionId}…`,
            created.sessionId,
          );
          setMessages([]);
          setSession(created.sessionId);
          pushSettings({
            session: created.sessionId,
            selectedSessionID: created.sessionId,
          });
          push({
            role: "system",
            text: `new local session · ${created.sessionId} · ${created.path}`,
          });
          setStatus(`session ${created.sessionId}`);
        } catch (error) {
          push({ role: "system", text: `new session failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
        }
        return true;
      }
      if (name === "fork") {
        const target = args.trim();
        if (!target) {
          push({ role: "system", text: "usage: /fork <new-session-name>", ok: false });
          return true;
        }
        if (rejectSessionTransitionWhileRunning(target)) return true;
        try {
          const forked = forkSession(session, target);
          applyDiskSession(forked.sessionId);
          pushSettings({
            session: forked.sessionId,
            selectedSessionID: forked.sessionId,
          });
          push({
            role: "system",
            text: `forked ${session} → ${forked.sessionId} · local-only`,
          });
        } catch (error) {
          push({ role: "system", text: `fork failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
        }
        return true;
      }
      if (name === "checkpoint") {
        try {
          const result = checkpointSession(session, { label: args.trim() || undefined });
          push({
            role: "system",
            text: `checkpoint created · ${result.checkpoint.id} · ${result.checkpoint.turns} turn(s) · local-only`,
          });
          setStatus("checkpoint saved");
        } catch (error) {
          push({ role: "system", text: `checkpoint failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
        }
        return true;
      }
      if (name === "checkpoints") {
        // File-level checkpoints (agent_tools.list_checkpoints), distinct from
        // /checkpoint's transcript snapshot above. The reply renders the list
        // itself (see the "checkpoints" bridge-event handler) — this only has
        // to ask for it.
        bridgeRef.current?.checkpoints(session);
        setStatus("loading file checkpoints…");
        return true;
      }
      if (name === "undo") {
        if (runningRef.current) {
          push({ role: "system", text: "cannot undo a file checkpoint while a run is in flight — cancel it first (Esc)", ok: false });
          return true;
        }
        const raw = args.trim();
        const requested = raw ? Number.parseInt(raw, 10) : 1;
        if (raw && (!Number.isInteger(requested) || requested < 1)) {
          push({ role: "system", text: "usage: /undo [n] — n is a positive count of the most recent file checkpoints to revert (default 1)", ok: false });
          return true;
        }
        const UNDO_MAX = 20;
        const count = Math.min(requested || 1, UNDO_MAX);
        // Each checkpoint_undo restores exactly the single most-recently
        // captured checkpoint; the bridge's stdin reader processes commands
        // strictly in order (undo/restore are not backgrounded to a worker
        // thread), so N requests sent back to back correctly revert the N
        // most recent checkpoints one at a time, each reporting its own
        // reverted file via the existing checkpoint_result handler.
        for (let i = 0; i < count; i += 1) bridgeRef.current?.checkpointUndo(session);
        setStatus(
          count === 1
            ? "reverting the most recent file checkpoint…"
            : `reverting the last ${count} file checkpoints${requested > count ? ` (capped at ${UNDO_MAX})` : ""}…`,
        );
        return true;
      }
      if (name === "rewind") {
        const id = args.trim();
        if (!id) {
          // No id yet: show the same list /checkpoints renders so an id is
          // right there to copy, rather than sending the user to a second
          // command first.
          bridgeRef.current?.checkpoints(session);
          push({
            role: "system",
            meta: "checkpoint",
            text: "usage: /rewind <checkpoint-id> — restores exactly the one file that checkpoint recorded, to its state before that write/edit. Not a full workspace-wide rewind. Ids are listed below (also shown by /checkpoints); /undo reverts only the single most recent one.",
          });
          setStatus("loading file checkpoints…");
          return true;
        }
        if (runningRef.current) {
          push({ role: "system", text: "cannot rewind a file while a run is in flight — cancel it first (Esc)", ok: false });
          return true;
        }
        return confirmLocalAction(
          `Rewind checkpoint ${id}`,
          `Restore the file recorded by checkpoint ${id} to its state before that write/edit? This overwrites the file's CURRENT on-disk content with the checkpointed bytes.`,
          () => {
            bridgeRef.current?.checkpointRestore(id, session);
            setStatus(`restoring checkpoint ${id}…`);
          },
        );
      }
      if (name === "reset") {
        return confirmLocalAction(
          "Reset session memory",
          `Clear ${session}'s saved transcript after creating a local checkpoint?`,
          () => {
            try {
              const result = resetSession(session, { checkpoint: true });
              resetSessionTransitionState("resetting session…", session);
              setMessages([]);
              push({
                role: "system",
                text: `session reset · checkpoint ${result.checkpoint?.id || "created"} · local-only`,
              });
              setStatus("session reset");
            } catch (error) {
              push({ role: "system", text: `reset failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
            }
          },
        );
      }
      if (name === "export") {
        const destination = args.trim() || `${cwd}/${session}.export.json`;
        try {
          const result = exportSession(session, destination);
          push({
            role: "system",
            text: `session exported · ${result.exportPath} · transcriptIncluded=${result.transcriptIncluded} · local-only`,
          });
          setStatus("session exported");
        } catch (error) {
          push({ role: "system", text: `export failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
        }
        return true;
      }
      if (name === "archive") {
        if (rejectSessionTransitionWhileRunning("a new session")) return true;
        return confirmLocalAction(
          "Archive session",
          `Move ${session} from the active session list into local archive storage?`,
          () => {
            try {
              const result = archiveSession(session);
              const next = createSession(`sess-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`);
              sessionRef.current = next.sessionId;
              resetSessionTransitionState(
                `opening ${next.sessionId}…`,
                next.sessionId,
              );
              setMessages([]);
              setSession(next.sessionId);
              pushSettings({ session: next.sessionId, selectedSessionID: next.sessionId });
              push({
                role: "system",
                text: `archived ${result.sessionId} · ${result.archivePath}\nnew session · ${next.sessionId}`,
              });
              setStatus("session archived");
            } catch (error) {
              push({ role: "system", text: `archive failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
            }
          },
        );
      }
      if (name === "rename") {
        const target = args.trim();
        if (!target) {
          push({ role: "system", text: "usage: /rename <new-session-name>", ok: false });
          return true;
        }
        try {
          const previousSession = session;
          const result = renameSession(session, target);
          sessionRef.current = result.sessionId;
          setSession(result.sessionId);
          retargetFlowRunSessions(
            sessionFlowRunSessionsRef.current,
            previousSession,
            result.sessionId,
          );
          dispatchSessionFlow({
            type: "retarget",
            sessionId: result.sessionId,
          });
          pushSettings({ session: result.sessionId, selectedSessionID: result.sessionId });
          push({ role: "system", text: `session renamed → ${result.sessionId}` });
          setStatus(`session ${result.sessionId}`);
        } catch (error) {
          push({ role: "system", text: `rename failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
        }
        return true;
      }
      if (name === "tag") {
        const tags = args.split(",").map((tag) => tag.trim()).filter(Boolean);
        if (!tags.length) {
          push({ role: "system", text: "usage: /tag label[,label...]", ok: false });
          return true;
        }
        try {
          const result = tagSession(session, tags);
          push({ role: "system", text: `session tags → ${result.metadata.tags.join(", ") || "(none)"}` });
        } catch (error) {
          push({ role: "system", text: `tag failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
        }
        return true;
      }
      if (name === "share") {
        const loaded = loadSessionFromDisk(session);
        push({
          role: "system",
          text: `local-only session path: ${loaded.path}\nNo remote share or sync was performed.`,
        });
        return true;
      }
      if (name === "context") {
        // Same numbers and wording StatusLine renders (lib/localOps' own
        // contextPressure), not a re-derived string — and an explicit "window
        // unknown" state for a local model that never declared a context
        // window, instead of silently omitting the line.
        const telemetry = contextTelemetryRef.current;
        const used = telemetry && typeof telemetry.used === "number" ? telemetry.used : null;
        const win = telemetry && typeof telemetry.window === "number" ? telemetry.window : null;
        const sourceNote =
          telemetry?.source === "reported" ? " · provider-reported"
            : telemetry?.source === "estimated" ? " · estimated from characters"
            : "";
        const usageLine =
          used === null
            ? "context usage: unknown until a provider reports tokens"
            : win === null
              ? `context: ${formatTokens(used)} used · window unknown — this model never declared a context window${sourceNote}`
              : `context: ${formatTokens(used)} used of ${formatTokens(win)} · ${contextPressure(used, win).label}${sourceNote}`;
        push({
          role: "system",
          text: [`cwd: ${cwd}`, `session: ${session}`, `model: ${model}`, usageLine].join("\n"),
        });
        return true;
      }
      if (name === "tasks" || name === "workflows") {
        dispatchWorkflow({ type: "view", value: name as "tasks" | "workflows" });
        closeOtherFullPanePanels("workflow");
        setShowWorkflow(true);
        const requestId = uid("tasks");
        workflowRequestRef.current.add(requestId);
        // retainCompleted omitted on purpose: this call names a session, so the
        // kernel's own rule already resolves it to true. Passing it explicitly
        // pinned the policy client-side and made the unscoped branch dead.
        bridgeRef.current?.listTasks(undefined, session, undefined, requestId);
        setStatus(`loading ${name}…`);
        return true;
      }
      if (name === "compact") {
        // Folds older turns in the SAVED conversation, so the next run sends
        // less. Distinct from /clear, which throws the conversation away.
        bridgeRef.current?.compact(session, model);
        setStatus("compacting context…");
        return true;
      }
      if (name === "bench") {
        // Head-to-head model benchmark (see kernel _handle_bench). Two modes:
        // knowledge corpus (prose Q&A) or tool-use (S1-S6 tool loop). Forms:
        //  • /bench                       → pick mode, then models (Esc runs)
        //  • /bench grok,qwen             → knowledge mode, immediate
        //  • /bench tool-use grok,qwen    → tool-use mode, immediate
        // Methodology tooling only: results are candidateOnly, canClaimAGI:false.
        const parts = args.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        let benchMode: "knowledge" | "tool-use" | "trigger" = "knowledge";
        if (parts[0] && ["tool-use", "tooluse", "tools"].includes(parts[0].toLowerCase())) {
          benchMode = "tool-use";
          parts.shift();
        } else if (parts[0] && parts[0].toLowerCase() === "knowledge") {
          parts.shift();
        } else if (parts[0] && ["trigger", "triggers"].includes(parts[0].toLowerCase())) {
          // trigger benchmark: does the model auto-trigger the right tool/skill?
          // (MCP + skill surfacing diagnostic). Requires surfacing ON for skill cases.
          benchMode = "trigger";
          parts.shift();
        }
        const specs = [...new Set(parts)];
        if (specs.length >= 1) {
          bridgeRef.current?.bench(specs, benchMode, 20, true);
          const where = benchMode === "tool-use" ? "tool-use benchmark"
                      : benchMode === "trigger" ? "trigger benchmark (auto-trigger recognition)"
                      : "knowledge corpus";
          push({ role: "system", meta: "bench", text: `benchmarking ${specs.length} model(s) on the ${where}…` });
          setStatus("benchmarking…");
          return true;
        }
        // No args → pick the benchmark mode first, then collect models via the
        // picker until Esc (see applyPickerValue's benchMode + model branches).
        benchModeRef.current = "knowledge";
        openPicker("benchMode");
        setStatus("bench: choose mode · ↑↓ Enter");
        return true;
      }
      if (name === "tbench") {
        // terminal-bench 2.1 through the agent loop (see kernel _handle_tbench).
        // Forms:
        //  • /tbench                       → smoke (5 diverse tasks, host scoring)
        //  • /tbench smoke                 → same, explicit
        //  • /tbench subset 20             → first 20 tasks (representative scorecard)
        //  • /tbench list                  → enumerate all task names
        //  • /tbench task <name>           → run one task by name
        //  • /tbench docker task regex-log → FAITHFUL: agent works INSIDE the task
        //    image (Apple container + Rosetta), scored by tests/test.sh → reward.txt
        //  • /tbench subset 20 omlx        → pin the model
        // Errors are auto-recorded as OKF memory; a fix-capture pass writes a
        // structured lesson back so the next run recalls it. candidateOnly,
        // canClaimAGI:false. `docker` mode is faithful container scoring; without
        // it, scoring is host-best-effort (NOT Docker-faithful).
        const parts = args.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        // Leading "docker" flag → faithful container scoring (agent inside image).
        let docker = false;
        if (parts[0] && parts[0].toLowerCase() === "docker") {
          docker = true;
          parts.shift();
        }
        let tmode: "list" | "smoke" | "subset" | "task" = "smoke";
        let tn = 5;
        const names: string[] = [];
        let modelArg: string | undefined;
        if (parts.length >= 1) {
          const m = parts[0].toLowerCase();
          if (m === "list") { tmode = "list"; parts.shift(); }
          else if (m === "smoke") { tmode = "smoke"; parts.shift(); }
          else if (m === "subset") {
            tmode = "subset";
            parts.shift();
            if (parts.length && /^\d+$/.test(parts[0])) {
              tn = Math.max(1, parseInt(parts.shift()!, 10));
            }
          } else if (m === "task") {
            tmode = "task";
            parts.shift();
            if (parts.length) names.push(parts.shift()!);
          }
        }
        // Optional trailing model pin: "omlx" / "vllm" / "openai:..." etc.
        if (parts.length && /^[a-z]/i.test(parts[0]) && !/^\d+$/.test(parts[0])) {
          modelArg = parts[0];
        }
        if (tmode === "list") {
          bridgeRef.current?.tbench("list", 0);
          push({ role: "system", meta: "tbench", text: "enumerating terminal-bench 2.1 tasks…" });
          setStatus("tbench: listing…");
        } else {
          bridgeRef.current?.tbench(tmode, tn,
            { docker, ...(names.length ? { names } : {}), ...(modelArg ? { models: modelArg } : {}) });
          const scoring = docker ? "FAITHFUL container scoring (Apple container + Rosetta)"
                                 : "host-best-effort scoring";
          const label = tmode === "task" ? `task ${names[0] || "?"}` :
                        tmode === "subset" ? `subset of ${tn}` : "smoke set";
          push({ role: "system", meta: "tbench",
                 text: `terminal-bench 2.1 · ${label} · ${scoring} · running through the agent loop…` });
          setStatus(`tbench: ${docker ? "container" : "host"} running…`);
        }
        return true;
      }
      if (name === "gaia") {
        // GAIA benchmark — per-level harness diagnostic (see kernel _handle_gaia).
        // Forms: /gaia | /gaia level 2 | /gaia level 1 n 10 | /gaia omlx
        // The per-level gradient (single-step → multi-step → long-horizon) isolates
        // WHERE the harness breaks. candidateOnly, canClaimAGI:false.
        const parts = args.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        let level: number | undefined;
        let n: number | undefined;
        let modelArg: string | undefined;
        for (let i = 0; i < parts.length; i++) {
          if (/^[123]$/.test(parts[i]) && level === undefined) level = parseInt(parts[i], 10);
          else if (/^\d+$/.test(parts[i]) && n === undefined) n = parseInt(parts[i], 10);
          else if (/^[a-z]/i.test(parts[i]) && !modelArg) modelArg = parts[i];
        }
        bridgeRef.current?.gaia({ level, n, ...(modelArg ? { models: modelArg } : {}) });
        const lvlLabel = level ? `Level ${level}` : "all levels";
        push({ role: "system", meta: "gaia",
               text: `GAIA · ${lvlLabel} · per-level harness diagnostic · running…` });
        setStatus("gaia: running…");
        return true;
      }
      if (name === "taubench") {
        // τ-bench reliability (pass^k) — measures harness flakiness (see kernel
        // _handle_taubench). Forms: /taubench | /taubench airline | /taubench retail k 5
        // pass^k = p^k decays with per-trial flakiness; a steep pass@1→pass^k drop
        // flags non-determinism. candidateOnly, canClaimAGI:false.
        const parts = args.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        let domain = "retail";
        let numTrials: number | undefined;
        let modelArg: string | undefined;
        if (parts.length && ["retail", "airline"].includes(parts[0].toLowerCase())) {
          domain = parts.shift()!.toLowerCase();
        }
        for (let i = 0; i < parts.length; i++) {
          if (/^\d+$/.test(parts[i]) && numTrials === undefined) numTrials = parseInt(parts[i], 10);
          else if (/^[a-z]/i.test(parts[i]) && !modelArg) modelArg = parts[i];
        }
        bridgeRef.current?.taubench({ domain, numTrials, ...(modelArg ? { models: modelArg } : {}) });
        push({ role: "system", meta: "taubench",
               text: `τ-bench · ${domain} · pass^k reliability (k=${numTrials ?? 3}) · running…` });
        setStatus("taubench: running…");
        return true;
      }
      if (name === "update") {
        const repo = args.trim() || undefined;
        bridgeRef.current?.update(repo);
        push({ role: "system", meta: "update", text: "updating sophia CLI…" });
        setStatus("updating…");
        return true;
      }
      if (name === "plan-mode" || name === "plan") {
        // /plan is the short, discoverable front door onto the identical
        // approval-gated flow /plan-mode already implements — two catalog
        // entries sharing one handler rather than one aliasing the other,
        // because the terminal REPL's help table needs /plan's own row (see
        // agent/slash_catalog.py's comment on these two commands).
        const task = args.trim();
        if (!task) {
          push({ role: "system", text: `usage: /${name} <task>`, ok: false });
          return true;
        }
        const draft = createPlanModeState({
          planId: uid("plan"),
          title: task,
          steps: [
            {
              id: "inspect",
              title: "Inspect relevant state and constraints",
              detail: "Read the necessary files and diagnostics before changing anything.",
            },
            {
              id: "implement",
              title: "Implement the approved task",
              detail: "Apply only the approved scope with normal permission gates.",
            },
            {
              id: "verify",
              title: "Verify and report",
              detail: "Run focused checks and report receipts, limitations, and remaining risks.",
            },
          ],
        });
        const submitted = transitionPlanMode(draft, { type: "submit_for_approval" });
        setPlanModeState(submitted.state);
        planCursorRef.current = 0;
        closeOtherFullPanePanels("plan");
        setShowPlanMode(true);
        // Parallel PlanModel projection (lib/planModel.ts) of the same step
        // text, kept alongside the FSM above — see this state's own doc
        // comment. A plan already showing is REVISED, not reset: a step's
        // done/failed/skipped status survives a second /plan-mode call
        // instead of silently returning to pending on every call the way the
        // FSM's own `draft` above unconditionally does.
        const rawPlanText = [
          "1. Inspect relevant state and constraints",
          "Read the necessary files and diagnostics before changing anything.",
          "2. Implement the approved task",
          "Apply only the approved scope with normal permission gates.",
          "3. Verify and report",
          "Run focused checks and report receipts, limitations, and remaining risks.",
        ].join("\n");
        if (planModelRef.current) {
          const revised = revisePlanModel(planModelRef.current, rawPlanText);
          setPlanModel(revised.model);
          setPlanModelDiff(revised.diff);
        } else {
          setPlanModel(createPlanModel(rawPlanText));
          setPlanModelDiff(undefined);
        }
        push({
          role: "system",
          meta: "plan",
          text: "approval-gated local plan created · press a to approve, then s to execute · experimental",
        });
        setStatus("plan awaiting approval");
        return true;
      }
      if (name === "agi") {
        if (executionRuntime === "prime") {
          push({
            role: "system",
            meta: "runtime",
            text:
              "AGI mode is a Sophia-kernel controller and is unavailable in the Prime backend. " +
              "Switch with /runtime sophia first.",
            ok: false,
          });
          return true;
        }
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const action = (parts.shift() || "status").toLowerCase();
        const sendAgi = (
          nextAction: "status" | "pause" | "stop" | "approve" | "resume" | "start",
          extra: { runId?: string; actionId?: string; prompt?: string } = {},
        ) => {
          bridgeRef.current?.agi({
            action: nextAction,
            session,
            ...extra,
            profile: agiProfileRef.current,
            route: agiRouteRef.current,
            model: modelRef.current,
            mode,
            permission: permission === "manual" ? "manual" : permission,
            cwd,
            effort,
            reasoningEffort: effort,
            responseStyle: responseStyleRef.current,
            conscienceMode: conscienceModeRef.current,
            plannerModel: agiPlannerModelRef.current || undefined,
            workerModel: agiWorkerModelRef.current || undefined,
            verifierModel: agiVerifierModelRef.current || undefined,
          });
        };
        if (action === "status") {
          sendAgi("status");
          const current = agiRef.current;
          push({
            role: "system",
            meta: "agi",
            text: [
              `AGI routing: ${agiModeRef.current ? "on" : "off"} · profile=${agiProfileRef.current} · requested route=${agiRouteRef.current}`,
              `resolved route=${current.route}${current.routeReason ? ` · ${current.routeReason}` : ""}`,
              `run: ${current.runId || "none"} · status=${current.status} · cycle=${current.cycle}/${current.maxCycles} · phase=${current.phase || "idle"}`,
              `planner=${agiPlannerModelRef.current || modelRef.current} · worker=${agiWorkerModelRef.current || modelRef.current} · verifier=${agiVerifierModelRef.current || modelRef.current}`,
              current.sameModelVerifier
                ? "same-model verifier is non-independent: semantic completion cannot exceed candidate_complete without deterministic evidence"
                : "independent verifier model is configured or not yet resolved",
              "candidateOnly · canClaimAGI=false · permissions and hard gates are inherited",
            ].join("\n"),
          });
          return true;
        }
        if (action === "route") {
          const value = String(parts.shift() || "").toLowerCase();
          if (value !== "auto" && value !== "fast" && value !== "deliberative" && value !== "critical") {
            push({ role: "system", text: "usage: /agi route auto|fast|deliberative|critical", ok: false });
            return true;
          }
          const next = value as AGIRoute;
          noteUserChanged("agiRoute");
          setAgiRoute(next);
          agiRouteRef.current = next;
          bridgeRef.current?.agi({ action: "route", route: next, session });
          push({
            role: "system",
            meta: "agi",
            text:
              `AGI route → ${next}\n` +
              (next === "auto"
                ? "The deterministic classifier chooses fast, deliberative, or critical and never downgrades detected risk."
                : next === "fast"
                  ? "Fast is only a request; non-trivial or critical tasks are automatically raised to a safer route."
                  : next === "critical"
                    ? "Every bounded action requires explicit /agi approve before execution."
                    : "Multiple strategies, critique, typed predictions, discrepancy scoring, and replanning are required."),
          });
          return true;
        }
        if (action === "on" || action === "off") {
          const enabled = action === "on";
          noteUserChanged("agiMode");
          setAgiMode(enabled);
          agiModeRef.current = enabled;
          const agiWorkflowWasEnabled =
            !enabled && agiWorkflowModeRef.current !== "off";
          if (agiWorkflowWasEnabled) {
            agiWorkflowOwnedRef.current = true;
            setAgiWorkflowMode("off");
            agiWorkflowModeRef.current = "off";
            pushSettings({ agiWorkflowMode: "off" });
          }
          if (enabled && workflowModeRef.current !== "off") {
            setWorkflowMode("off");
            workflowModeRef.current = "off";
            setDynamicWorkflow((prev) => ({
              ...prev,
              configuredMode: "off",
              active: false,
            }));
            pushSettings({ workflowMode: "off" });
          }
          bridgeRef.current?.agi({ action, session });
          push({
            role: "system",
            meta: "agi",
            text: enabled
              ? "AGI routing → on for future Sophia prompts. Dynamic /workflow routing was turned off; existing /a2a preferences are preserved but suspended while AGI routing is active."
              : "AGI routing → off for future prompts. Any active AGI run continues until paused, stopped, or terminal." +
                (agiWorkflowWasEnabled
                  ? "\nAGI workflow routing also turned off because it requires AGI routing."
                  : ""),
          });
          return true;
        }
        if (action === "profile") {
          const value = String(parts.shift() || "").toLowerCase();
          if (value !== "conservative" && value !== "balanced" && value !== "deep") {
            push({ role: "system", text: "usage: /agi profile conservative|balanced|deep", ok: false });
            return true;
          }
          const next = value as AGIProfile;
          noteUserChanged("agiProfile");
          setAgiProfile(next);
          agiProfileRef.current = next;
          bridgeRef.current?.agi({ action: "profile", profile: next, session });
          push({
            role: "system",
            meta: "agi",
            text:
              `AGI profile → ${next}\n` +
              (next === "conservative"
                ? "4 cycles · 2 strategies · 2 critics/subagents per cycle · 20 minute bound"
                : next === "deep"
                  ? "16 cycles · 5 strategies · 8 critics/subagents per cycle · 4 hour bound"
                  : "8 cycles · 3 strategies · 4 critics/subagents per cycle · 60 minute bound"),
          });
          return true;
        }
        if (action === "model") {
          const role = String(parts.shift() || "").toLowerCase();
          const requested = parts.join(" ").trim();
          if (!["planner", "worker", "verifier"].includes(role) || !requested) {
            push({
              role: "system",
              text: "usage: /agi model planner|worker|verifier <model|default>",
              ok: false,
            });
            return true;
          }
          const value = requested.toLowerCase() === "default" ? "" : requested;
          if (role === "planner") {
            noteUserChanged("agiPlannerModel");
            setAgiPlannerModel(value);
            agiPlannerModelRef.current = value;
            pushSettings({ agiPlannerModel: value });
          } else if (role === "worker") {
            noteUserChanged("agiWorkerModel");
            setAgiWorkerModel(value);
            agiWorkerModelRef.current = value;
            pushSettings({ agiWorkerModel: value });
          } else {
            noteUserChanged("agiVerifierModel");
            setAgiVerifierModel(value);
            agiVerifierModelRef.current = value;
            pushSettings({ agiVerifierModel: value });
          }
          push({
            role: "system",
            meta: "agi",
            text: `AGI ${role} model → ${value || `selected model (${modelRef.current})`}`,
          });
          return true;
        }
        if (action === "pause" || action === "stop") {
          sendAgi(action);
          setStatus(`AGI ${action} requested · applies at next safe phase boundary`);
          return true;
        }
        if (action === "approve") {
          if (runningRef.current) {
            push({ role: "system", text: "cannot approve an AGI action while another run is in flight", ok: false });
            return true;
          }
          const current = agiRef.current;
          if (!current.actionId || !current.authorizationRequired) {
            push({ role: "system", text: "no authorization-gated AGI action is pending", ok: false });
            return true;
          }
          const requestedActionId = String(parts.shift() || "").trim();
          if (requestedActionId && requestedActionId !== current.actionId) {
            push({
              role: "system",
              text:
                `approval action id ${requestedActionId} does not match the pending action ` +
                current.actionId,
              ok: false,
            });
            return true;
          }
          const actionId = requestedActionId || current.actionId;
          push({
            role: "system",
            meta: "agi",
            text:
              `Approving bounded action ${actionId}\n` +
              `${current.actionClass || "unclassified"} · risk=${current.risk?.toFixed(2) ?? "not reported"} · ${current.action || "action text not reported"}`,
          });
          resetRunState();
          scrollToLatest();
          sendAgi("approve", {
            runId: current.runId || undefined,
            actionId,
          });
          return true;
        }
        if (action === "resume") {
          if (runningRef.current) {
            push({ role: "system", text: "cannot resume an AGI run while another run is in flight", ok: false });
            return true;
          }
          resetRunState();
          scrollToLatest();
          sendAgi("resume", { runId: parts.join(" ").trim() || undefined });
          return true;
        }
        if (action === "start") {
          if (modelBound?.source !== "agi-start" || !modelBound.prompt) {
            push({ role: "system", text: "usage: /agi start <goal>", ok: false });
            return true;
          }
          const prompt = modelBound.prompt;
          if (runningRef.current) {
            push({ role: "system", text: "cannot start AGI mode while another run is in flight", ok: false });
            return true;
          }
          push({ role: "user", text: prompt, meta: "(AGI mode · bounded autonomous goal)" });
          resetRunState();
          scrollToLatest();
          sendAgi("start", { prompt });
          return true;
        }
        push({
          role: "system",
          text:
            "usage: /agi on|off|status|profile <name>|route <auto|fast|deliberative|critical>|model <role> <model>|pause|stop|approve|resume [run-id]|start <goal>",
          ok: false,
        });
        return true;
      }
      if (name === "agents") {
        if (agiRef.current.active) {
          push({
            role: "system",
            meta: "agi",
            text:
              "/agents is unavailable during an active AGI run because the controller owns bounded dispatch and verification. " +
              "Use /agi pause or /agi stop first. Your existing lane preference was not changed.",
            ok: false,
          });
          return true;
        }
        if (executionRuntime === "prime") {
          push({
            role: "system",
            meta: "runtime",
            text:
              "Prime backend v1 does not expose Sophia A2A routing. " +
              "Switch to /runtime sophia before changing /agents.",
            ok: false,
          });
          setStatus("agents unavailable in prime runtime");
          return true;
        }
        const raw = args.trim();
        if (!raw) {
          const current = a2aAgentsRef.current;
          push({
            role: "system",
            text: [
              `agents shortcut: ${current < 0 ? "A2A auto" : current >= 2 ? `A2A fixed total ${current}` : "off"}`,
              "/agents 1 turns A2A off.",
              "/agents <n>, n >= 2, is a legacy shortcut for /a2a <n>.",
              "Use /a2a auto or /workflow auto for Main-controlled parallel routing.",
            ].join("\n"),
          });
          setStatus("agents shortcut · A2A");
          return true;
        }
        if (agiWorkflowModeRef.current !== "off") {
          push({
            role: "system",
            meta: "agi-workflow",
            text:
              "/agents is owned by enabled /agi-workflow routing. " +
              "Use /agi-workflow off before changing A2A.",
            ok: false,
          });
          return true;
        }
        if (!/^\d+$/.test(raw) || Number(raw) < 1) {
          push({ role: "system", text: `/agents needs a whole number ≥ 1 (got "${raw}")`, ok: false });
          setStatus("agents: bad argument");
          return true;
        }
        const next = Number(raw) === 1 ? 0 : Number(raw);
        const workflowWasEnabled = workflowModeRef.current !== "off";
        noteUserChanged("a2aAgents");
        if (workflowWasEnabled) {
          noteUserChanged("workflowMode");
          setWorkflowMode("off");
          workflowModeRef.current = "off";
          setDynamicWorkflow((prev) => ({
            ...prev,
            configuredMode: "off",
            active: false,
          }));
        }
        setA2aAgents(next);
        a2aAgentsRef.current = next;
        setA2a(EMPTY_A2A_STATE);
        setAutoTeam(false);
        autoTeamRef.current = false;
        setTeamAgents(1);
        teamRef.current = 1;
        pushSettings({
          a2aAgents: next,
          autoTeam: false,
          team: 1,
          ...(workflowWasEnabled ? { workflowMode: "off" as const } : {}),
        });
        push({
          role: "system",
          text:
            next === 0
              ? "agents shortcut → A2A off"
              : `agents shortcut → A2A fixed total ${next}` +
                (workflowWasEnabled ? "\nDynamic /workflow routing turned off." : ""),
        });
        setStatus(next === 0 ? "A2A off" : `A2A fixed ${next}`);
        return true;
      }
      if (name === "queue") {
        const prompt = args.trim();
        if (!prompt) {
          push({ role: "system", text: "usage: /queue <prompt>", ok: false });
          return true;
        }
        try {
          bridgeRef.current?.queueNext(prompt, {
            runtime: executionRuntime,
            model,
            mode,
            permission,
            session,
            cwd,
            deepThink: executionRuntime === "sophia" && (effort === "ultramode" || effort === "high"),
            deepMode: executionRuntime === "sophia" && deepMode,
            effort,
            reasoningEffort: effort,
            responseStyle,
            autoGoal:
              executionRuntime === "sophia"
              && !agiModeRef.current
              && agiWorkflowModeRef.current === "off",
            team: 1,
            autoTeam: false,
            a2aAgents:
              executionRuntime === "prime"
                ? 0
                : agiWorkflowModeRef.current !== "off"
                  ? -1
                  : a2aAgentsRef.current,
            a2aExecution:
              agiWorkflowModeRef.current !== "off"
                ? "terminal"
                : a2aExecutionRef.current,
            terminalLayout:
              agiWorkflowModeRef.current !== "off"
                ? "auto"
                : terminalLayoutRef.current,
            workflowMode:
              executionRuntime === "sophia"
              && agiWorkflowModeRef.current === "off"
                ? workflowModeRef.current
                : "off",
            workflowMaxStages: workflowMaxStagesRef.current,
            workflowMaxAgents: workflowMaxAgentsRef.current,
            agiMode:
              executionRuntime === "sophia"
              && (agiModeRef.current || agiWorkflowModeRef.current !== "off"),
            agiWorkflowMode:
              executionRuntime === "sophia"
                ? agiWorkflowModeRef.current
                : "off",
            agiProfile: agiProfileRef.current,
            agiRoute: agiRouteRef.current,
            agiPlannerModel: agiPlannerModelRef.current || undefined,
            agiWorkerModel: agiWorkerModelRef.current || undefined,
            agiVerifierModel: agiVerifierModelRef.current || undefined,
            requestId: uid("queue"),
          });
          push({ role: "user", text: prompt, meta: "(queued after active run)" });
          setStatus("prompt queued · awaiting queue acknowledgement");
        } catch (error) {
          push({ role: "system", text: `queue failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
        }
        return true;
      }
      if (name === "steer") {
        const instruction = args.trim();
        if (!instruction) {
          push({ role: "system", text: "usage: /steer <instruction>", ok: false });
          return true;
        }
        const runId = activeRunIdRef.current;
        if (!runId || !running) {
          push({ role: "system", text: "steer rejected: no active run; use /queue to schedule another prompt", ok: false });
          return true;
        }
        const requestId = uid("steer");
        steerPendingRef.current = { text: instruction, requestId };
        bridgeRef.current?.steer(instruction, runId, session, requestId);
        setStatus("steering… awaiting acknowledgement");
        return true;
      }
      if (name === "session") {
        const sessionArgs = args.trim();
        if (!sessionArgs || sessionArgs === "list") {
          // Disk is the single source of truth — same helper the bridge
          // `sessions` event uses, so both entry points show the same list.
          const { rows } = refreshSessionOptionsFromDisk(session);
          if (!rows.length) {
            push({
              role: "system",
              text: `no saved sessions under ${loadSessionFromDisk("tui-default").path.replace(/tui-default\\.json$/, "")}`,
            });
            setStatus("no saved sessions");
            return true;
          }
          setStatus("Select session · ↑↓ Enter · Esc cancel");
          return true;
        }
        const selected = sessionArgs.replace(/^select\s+/i, "").trim();
        if (!selected) {
          push({ role: "system", text: "usage: /session list | /session <name>", ok: false });
          return true;
        }
        return loadSessionSlash(selected);
      }
      if (name === "resume") {
        // Args may be an exact session, legacy "select <session>", a local
        // transcript query, or empty.
        const intent = resumeLookupIntent(args);
        if (!intent.query) {
          // No name -> open the descriptive Sophia session picker:
          // browse past sessions (topic · turns · recency), pick one with ↑↓ Enter,
          // and restore its full history. `/resume <name>` still loads directly.
          // /resume shows the list WITHOUT the /status run-status header.
          setSessionBrowserHeader(null);
          const { rows } = refreshSessionOptionsFromDisk(session);
          if (!rows.length) {
            push({
              role: "system",
              text: `no saved sessions under ${loadSessionFromDisk("tui-default").path.replace(/tui-default\.json$/, "")}`,
            });
            setStatus("no saved sessions");
            return true;
          }
          setStatus("Resume session · ↑↓ Enter · Esc cancel");
          return true;
        }
        for (const candidate of intent.exactCandidates) {
          const exact = findExactSessionIdFromDisk(candidate);
          if (exact) return loadSessionSlash(exact);
        }
        const request = sessionSearchRequestRef.current;
        setSessionBrowserHeader(null);
        sessionPickerRef.current = null;
        setSessionPicker(null);
        setStatus("searching local session transcripts…");
        void lookupSessionsFromDiskAsync(intent.query, 50).then((lookup) => {
          if (request !== sessionSearchRequestRef.current) return;
          const { rows } = refreshSessionOptionsFromDisk(session, {
            rows: lookup.matches,
            query: lookup.query,
            totalMatches: lookup.totalMatches,
          });
          setStatus(
            lookup.truncated
              ? `top ${rows.length} of ${lookup.totalMatches} session matches · ↑↓ Enter · Esc cancel`
              : rows.length
                ? `${rows.length} session match${rows.length === 1 ? "" : "es"} · ↑↓ Enter · Esc cancel`
                : "no matching local sessions · Esc close",
          );
        }).catch((error) => {
          if (request !== sessionSearchRequestRef.current) return;
          push({
            role: "system",
            text: `session search failed: ${error instanceof Error ? error.message : String(error)}`,
            ok: false,
          });
          setStatus("session search failed");
        });
        return true;
      }
      if (name === "continue") {
        // Fast path: reopen the MOST RECENT Sophia session, no picker
        // (the CLI --continue/-c does the same at launch; this is the in-session
        // equivalent). Disk is the source of truth, newest-first.
        const recent = listSessionsFromDisk(1)[0];
        if (!recent) {
          push({ role: "system", text: "no saved sessions to continue yet" });
          setStatus("no saved sessions");
          return true;
        }
        return loadSessionSlash(recent.id);
      }
      if (name === "debug") {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (parts[0] === "bundle" || parts[0] === "support-bundle") {
          const destination =
            parts.slice(1).join(" ") ||
            `${cwd}/sophia-support-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.json`;
          try {
            const index = rebuildSessionIndex({ includeArchived: true, persist: true });
            const bundle = writeSupportBundle(
              destination,
              {
                app: {
                  name: "Sophia Code TUI",
                  version: SOPHIA_VERSION,
                  model,
                  permission,
                  session,
                },
                runtime: runtimeSnapshot as unknown as Record<string, unknown>,
                diagnostics: {
                  bridgeReady,
                  status,
                  terminal: terminalCapabilities.evidence,
                },
                sessionIndex: index,
                runReceipts: runReceiptsRef.current,
                logs: bridgeEventsRef.current,
              },
              {
                includeTranscriptBodies: false,
                cwd,
              },
            );
            push({
              role: "system",
              text: `redacted local support bundle · ${destination}\ntranscriptBodiesIncluded=${bundle.privacy.transcriptBodiesIncluded} · redactions=${bundle.privacy.redactionCount}`,
            });
          } catch (error) {
            push({ role: "system", text: `support bundle failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
          }
          return true;
        }
        bridgeRef.current?.diagnosticSnapshot({ session, requestId: uid("debug") });
        push({
          role: "system",
          text: tuiDebugText({
            lifecycle: "snapshot",
            runId: activeRunIdRef.current || "none",
            path: [],
            ts: new Date().toISOString(),
          }),
        });
        return true;
      }
      if (name === "exit" || name === "quit") {
        void requestExit();
        return true;
      }
      if (name === "statusline") {
        // Keep the catalog honest: /statusline promises the compact chrome
        // configuration, while /status owns the richer session browser below.
        const headerLines = statusHeaderLines({
          model, effort: effortLabel(effort), mode, permission, session, cwd,
        });
        push({ role: "system", text: headerLines.join("  ") });
        setStatus("status line shown");
        return true;
      }
      if (name === "status") {
        // Run status (model/effort/mode/permission/session/cwd) as a header,
        // then the same session-details browser as /resume (topic · turns ·
        // recency, ↑↓ to move, Enter to restore). The header is what tells it
        // apart from /resume; the browser machinery is shared wholesale.
        const headerLines = statusHeaderLines({
          model, effort: effortLabel(effort), mode, permission, session, cwd,
        });
        setSessionBrowserHeader(headerLines);
        const { rows } = refreshSessionOptionsFromDisk(session);
        if (!rows.length) {
          // No browser to attach the header to — surface the run status as a
          // transcript row instead so /status never shows nothing.
          push({ role: "system", text: headerLines.join("  ") });
          setStatus("status · no saved sessions to browse");
          return true;
        }
        setStatus("Status · session details · ↑↓ browse · Enter restore · Esc close");
        return true;
      }
      if (name === "a2a") {
        const value = args.trim().toLowerCase();
        if (!value || value === "status") {
          const modeLabel =
            a2aAgents < 0
              ? "on · auto (Main Agent chooses sub-agent count)"
              : a2aAgents >= 2
                ? `on · fixed total ${a2aAgents} (legacy)`
                : "off";
          push({
            role: "system",
            text: [
              `A2A harness: ${modeLabel}`,
              `worker execution: ${a2aExecution} · terminal layout: ${terminalLayout}`,
              "When on (auto): Main Agent plans and DISPATCHes N sub-agents (you need not name N).",
              "After all subs finish, Main Agent (verify) checks each output and synthesizes the operator answer.",
              "Right panel → Agents shows Main Agent, Sub Agent 1…, Main Agent (verify).",
              "Use /terminals auto|splits|windows|headless|off to choose supervised PTYs or embedded execution.",
              "usage: /a2a on|off|status|auto|2|3|…  (numbers = legacy fixed total)",
              "Dynamic /workflow routing uses this A2A path for parallel stages.",
            ].join("\n"),
          });
          return true;
        }
        if (
          agiWorkflowModeRef.current !== "off"
          && value !== "on"
          && value !== "auto"
        ) {
          push({
            role: "system",
            meta: "agi-workflow",
            text:
              "A2A stays in supervised auto mode while /agi-workflow is enabled. " +
              "Use /agi-workflow off before changing A2A routing.",
            ok: false,
          });
          return true;
        }
        if (value === "off") {
          noteUserChanged("a2aAgents");
          setA2aAgents(0);
          a2aAgentsRef.current = 0;
          setA2a(EMPTY_A2A_STATE);
          const workflowWasEnabled = workflowModeRef.current !== "off";
          if (workflowWasEnabled) {
            noteUserChanged("workflowMode");
            setWorkflowMode("off");
            workflowModeRef.current = "off";
            setDynamicWorkflow((prev) => ({
              ...prev,
              configuredMode: "off",
              active: false,
            }));
          }
          pushSettings({
            a2aAgents: 0,
            ...(workflowWasEnabled ? { workflowMode: "off" as const } : {}),
          });
          push({
            role: "system",
            text:
              "A2A harness → off" +
              (workflowWasEnabled
                ? "\nDynamic /workflow routing also turned off because it requires parallel A2A."
                : ""),
          });
          return true;
        }
        if (value === "on" || value === "auto") {
          // -1 = auto: Main Agent decides how many sub-agents to dispatch.
          noteUserChanged("a2aAgents");
          noteUserChanged("autoTeam");
          setA2aAgents(-1);
          a2aAgentsRef.current = -1;
          setAutoTeam(false);
          autoTeamRef.current = false;
          pushSettings({ a2aAgents: -1, autoTeam: false });
          push({
            role: "system",
            text:
              "A2A harness → on · auto\n" +
              "Main Agent chooses sub-agent count via DISPATCH; then verifies and synthesizes.",
          });
          return true;
        }
        const n = Number(value);
        if (!Number.isInteger(n) || n < 2) {
          push({
            role: "system",
            text: "usage: /a2a on|off|status|auto|2|3|…  (on/auto = Main chooses N)",
            ok: false,
          });
          return true;
        }
        noteUserChanged("a2aAgents");
        noteUserChanged("autoTeam");
        setA2aAgents(n);
        a2aAgentsRef.current = n;
        setAutoTeam(false);
        autoTeamRef.current = false;
        pushSettings({ a2aAgents: n, autoTeam: false });
        push({
          role: "system",
          text: `A2A harness → fixed total ${n} agents (legacy Main+subs hint)`,
        });
        return true;
      }
      if (name === "workflow") {
        const rawWorkflowArgs = args.trim();
        const resumeMatch = rawWorkflowArgs.match(
          /^resume(?:\s+(.+))?$/i,
        );
        if (resumeMatch) {
          const sourceRunId = String(resumeMatch[1] || "").trim();
          if (!sourceRunId) {
            push({
              role: "system",
              meta: "workflow",
              text: "usage: /workflow resume <run-id>",
              ok: false,
            });
            return true;
          }
          if (executionRuntime === "prime") {
            push({
              role: "system",
              meta: "workflow",
              text:
                "Workflow resume is owned by the Sophia kernel and is unavailable in the Prime backend. " +
                "Switch with /runtime sophia first.",
              ok: false,
            });
            return true;
          }
          if (runningRef.current) {
            push({
              role: "system",
              meta: "workflow",
              text:
                "Cannot resume while another run is active. Cancel it first with Esc.",
              ok: false,
            });
            return true;
          }
          if (!bridgeRef.current?.isReady()) {
            push({
              role: "system",
              meta: "workflow",
              text: "bridge not ready — wait a moment before resuming",
              ok: false,
            });
            return true;
          }
          const resumePrompt = [
            "Resume the sophia.tui.parallel-barrier-smoke.v1 read-only workflow.",
            "Recover the four independent specialist lanes: backend durability,",
            "bridge authority, TUI graph and reducer, and test evidence.",
            "Use a separate recovery barrier when required, then run the critic",
            "barrier before Main synthesis. Treat this as read-only; do not edit",
            "files, execute project commands or tests, use network tools, or claim",
            "production readiness. candidateOnly: true; canClaimAGI: false.",
          ].join(" ");
          push({
            role: "user",
            text: `/workflow resume ${sourceRunId}`,
            meta: "workflow resume · explicit source run",
          });
          resetRunState();
          scrollToLatest();
          bridgeRef.current.resumeWorkflow(
            {
              prompt: resumePrompt,
              runtime: executionRuntime,
              model,
              mode,
              permission: permission === "manual" ? "manual" : permission,
              session,
              cwd,
              deepThink:
                executionRuntime === "sophia"
                && (effort === "ultramode" || effort === "high"),
              deepMode: executionRuntime === "sophia" && deepMode,
              effort,
              reasoningEffort: effort,
              responseStyle,
              conscienceMode,
              team: 1,
              autoTeam: false,
              a2aAgents: -1,
              a2aExecution: "terminal",
              terminalLayout: "auto",
              workflowMode: "on",
              workflowMaxStages: workflowMaxStagesRef.current,
              workflowMaxAgents: workflowMaxAgentsRef.current,
              agiMode: false,
              agiWorkflowMode: "off",
            },
            sourceRunId,
          );
          setStatus(`workflow resume dispatched · source=${sourceRunId}`);
          return true;
        }
        if (executionRuntime === "prime") {
          push({
            role: "system",
            meta: "workflow",
            text:
              "Dynamic workflow is owned by the Sophia kernel and is unavailable in the Prime backend. " +
              "Switch with /runtime sophia first.",
            ok: false,
          });
          return true;
        }
        const value = args.trim().toLowerCase() || "status";
        if (value === "status") {
          push({
            role: "system",
            meta: "workflow",
            text: [
              `Workflow routing: ${workflowModeRef.current}`,
              `live state: ${dynamicWorkflow.status} · phase=${dynamicWorkflow.phase} · stage=${dynamicWorkflow.currentStage}/${workflowMaxStagesRef.current}`,
              `budget: ${workflowMaxAgentsRef.current} total sub-agents · ${dynamicWorkflow.totalAgents} used in the latest run`,
              `A2A: ${a2aAgentsRef.current === 0 ? "off" : "on"} · execution=${a2aExecutionRef.current} · terminals=${terminalLayoutRef.current}`,
              "auto: Main decides whether the task needs a bounded multi-stage workflow and may combine, adapt, or invent workflow patterns.",
              "on: require workflow routing; ineligible local/self-hosted models or missing parallel A2A fail closed.",
              "Each stage is a parallel barrier; Main reviews every stage before choosing the next stage or final synthesis.",
              "Explicit recovery: /workflow resume <run-id> reconciles only that durable source run; resume never selects the newest run implicitly.",
              "Cloud models only · candidateOnly · canClaimAGI=false.",
            ].join("\n"),
          });
          return true;
        }
        if (value !== "off" && value !== "auto" && value !== "on") {
          push({
            role: "system",
            text: "usage: /workflow off|auto|on|status|resume <run-id>",
            ok: false,
          });
          return true;
        }
        const next = value as DynamicWorkflowMode;
        if (next !== "off" && agiRef.current.active) {
          push({
            role: "system",
            meta: "workflow",
            text:
              "/workflow cannot be enabled during an active AGI controller run. " +
              "Use /agi pause or /agi stop first; workflow settings were not changed.",
            ok: false,
          });
          return true;
        }
        noteUserChanged("workflowMode");
        const agiWorkflowWasEnabled =
          next !== "off" && agiWorkflowModeRef.current !== "off";
        if (agiWorkflowWasEnabled) {
          agiWorkflowOwnedRef.current = true;
          setAgiWorkflowMode("off");
          agiWorkflowModeRef.current = "off";
        }
        setWorkflowMode(next);
        workflowModeRef.current = next;
        setDynamicWorkflow((prev) => ({
          ...prev,
          configuredMode: next,
          maxStages: workflowMaxStagesRef.current,
          maxAgents: workflowMaxAgentsRef.current,
          active: false,
        }));
        if (next !== "off") {
          // Workflow is a multi-stage extension of supervised PARALLEL A2A.
          // Configure the safe prerequisite surface in one atomic settings
          // write rather than requiring three manual slash commands.
          noteUserChanged("a2aAgents");
          noteUserChanged("a2aExecution");
          noteUserChanged("terminalLayout");
          noteUserChanged("autoTeam");
          noteUserChanged("team");
          noteUserChanged("agiMode");
          setA2aAgents(-1);
          a2aAgentsRef.current = -1;
          setA2aExecution("terminal");
          a2aExecutionRef.current = "terminal";
          setTerminalLayout("auto");
          terminalLayoutRef.current = "auto";
          setAutoTeam(false);
          autoTeamRef.current = false;
          setAgiMode(false);
          agiModeRef.current = false;
          setTeamAgents(1);
          teamRef.current = 1;
          pushSettings({
            workflowMode: next,
            workflowMaxStages: workflowMaxStagesRef.current,
            workflowMaxAgents: workflowMaxAgentsRef.current,
            a2aAgents: -1,
            a2aExecution: "terminal",
            terminalLayout: "auto",
            autoTeam: false,
            agiMode: false,
            ...(agiWorkflowWasEnabled
              ? { agiWorkflowMode: "off" as const }
              : {}),
            team: 1,
          });
          push({
            role: "system",
            meta: "workflow",
            text:
              `Workflow routing → ${next}\n` +
              "Parallel A2A and the terminal supervisor were enabled automatically; Team and AGI routing were suspended.\n" +
              (agiWorkflowWasEnabled
                ? "AGI workflow routing was turned off because the outer workflow now owns routing.\n"
                : "") +
              (next === "auto"
                ? "Main will use a workflow only when the prompt benefits from multiple parallel stages."
                : "Main must attempt a bounded workflow; unsupported local/self-hosted models fail closed."),
          });
        } else {
          pushSettings({ workflowMode: "off" });
          setDynamicWorkflow((prev) => ({
            ...prev,
            configuredMode: "off",
            active: false,
          }));
          push({
            role: "system",
            meta: "workflow",
            text:
              "Workflow routing → off\nA2A/terminal preferences are preserved; use /a2a off or /terminals off separately if desired.",
          });
        }
        return true;
      }
      if (name === "terminals") {
        const value = args.trim().toLowerCase();
        if (!value || value === "status") {
          push({
            role: "system",
            text: [
              `A2A worker execution: ${a2aExecution}`,
              `terminal layout: ${terminalLayout}`,
              "auto/splits/windows use the durable local PTY supervisor; headless keeps the same supervisor without requiring visible panes.",
              "Workers can continue if the TUI exits. Main verification resumes only while the controlling bridge remains attached.",
              "usage: /terminals off|auto|splits|windows|headless|status",
            ].join("\n"),
          });
          return true;
        }
        if (!["off", "auto", "splits", "windows", "headless"].includes(value)) {
          push({
            role: "system",
            text: "usage: /terminals off|auto|splits|windows|headless|status",
            ok: false,
          });
          return true;
        }
        if (
          agiWorkflowModeRef.current !== "off"
          && value !== "auto"
        ) {
          push({
            role: "system",
            meta: "agi-workflow",
            text:
              "Terminal supervision stays terminal/auto while /agi-workflow is enabled. " +
              "Use /agi-workflow off before changing terminal layout.",
            ok: false,
          });
          return true;
        }
        const nextLayout = value as "off" | "auto" | "splits" | "windows" | "headless";
        const nextExecution: "embedded" | "terminal" | "headless" =
          nextLayout === "off"
            ? "embedded"
            : nextLayout === "headless"
              ? "headless"
              : "terminal";
        noteUserChanged("terminalLayout");
        noteUserChanged("a2aExecution");
        setTerminalLayout(nextLayout);
        terminalLayoutRef.current = nextLayout;
        setA2aExecution(nextExecution);
        a2aExecutionRef.current = nextExecution;
        const workflowWasEnabled =
          nextLayout === "off" && workflowModeRef.current !== "off";
        if (workflowWasEnabled) {
          noteUserChanged("workflowMode");
          setWorkflowMode("off");
          workflowModeRef.current = "off";
          setDynamicWorkflow((prev) => ({
            ...prev,
            configuredMode: "off",
            active: false,
          }));
        }
        pushSettings({
          terminalLayout: nextLayout,
          a2aExecution: nextExecution,
          ...(workflowWasEnabled ? { workflowMode: "off" as const } : {}),
        });
        push({
          role: "system",
          text:
            nextLayout === "off"
              ? "A2A terminal supervisor → off · sub-agents run embedded" +
                (workflowWasEnabled
                  ? "\nDynamic /workflow routing also turned off because it requires the parallel supervisor."
                  : "")
              : `A2A terminal supervisor → ${nextLayout} · execution=${nextExecution}`,
        });
        return true;
      }
      if (name === "fallback-model") {
        const value = args.trim();
        const normalized = value.toLowerCase();
        const statusText = () => [
          `semantic fallback model: ${semanticFallbackModel || "not configured"}`,
          `policy: ${semanticFallbackPolicy}`,
          `return to selected primary: ${semanticReturnToPrimary ? "on" : "off"}`,
          "authority crossing: explicit confirmation required",
          `final Conscience policy: ${conscienceDeliverySummary(conscienceModeRef.current)}`,
        ].join("\n");
        if (!value || normalized === "status") {
          push({ role: "system", meta: "fallback", text: statusText() });
          setStatus(semanticFallbackModel ? "semantic fallback configured" : "semantic fallback off");
          return true;
        }
        if (normalized === "off") {
          setSemanticFallbackModel(null);
          setSemanticFallbackPolicy("off");
          noteUserChanged("semanticFallbackModel");
          noteUserChanged("semanticFallbackPolicy");
          pushSettings({
            semanticFallbackModel: null,
            semanticFallbackPolicy: "off",
          });
          push({
            role: "system",
            meta: "fallback",
            text:
              "semantic local-model recovery → off\n" +
              `No model was contacted; final Conscience policy: ${conscienceDeliverySummary(conscienceModeRef.current)}.`,
          });
          setStatus("semantic fallback off");
          return true;
        }
        const returnMain = normalized.match(/^return-main\s+(on|off)$/);
        if (returnMain) {
          const enabled = returnMain[1] === "on";
          setSemanticReturnToPrimary(enabled);
          noteUserChanged("semanticReturnToPrimary");
          pushSettings({ semanticReturnToPrimary: enabled });
          push({
            role: "system",
            meta: "fallback",
            text:
              `semantic fallback return-to-primary → ${enabled ? "on" : "off"}\n` +
              (enabled
                ? "A local candidate accepted by the selected final-answer policy will be sent back as untrusted data for verification and continuation."
                : "A local result accepted by the selected final-answer policy will be returned directly after the one approved local run.") +
              `\nFinal Conscience policy: ${conscienceDeliverySummary(conscienceModeRef.current)}.`,
          });
          setStatus(`return to primary ${enabled ? "on" : "off"}`);
          return true;
        }
        if (normalized.startsWith("return-main")) {
          push({
            role: "system",
            text: "usage: /fallback-model return-main on|off",
            ok: false,
          });
          return true;
        }
        setSemanticFallbackModel(value);
        setSemanticFallbackPolicy("confirm");
        noteUserChanged("semanticFallbackModel");
        noteUserChanged("semanticFallbackPolicy");
        pushSettings({
          semanticFallbackModel: value,
          semanticFallbackPolicy: "confirm",
        });
        push({
          role: "system",
          meta: "fallback",
          text:
            `semantic fallback model → ${value}\n` +
            "The bridge will fail closed unless this resolves to a local/self-hosted model. " +
            "Each primary-refusal retry requires explicit confirmation. Final Conscience " +
            `policy: ${conscienceDeliverySummary(conscienceModeRef.current)}.`,
        });
        setStatus("semantic fallback configured · confirm on use");
        return true;
      }
      if (name === "conscience") {
        const result = resolveConscienceCommand(args, conscienceMode);
        if (!result.ok) {
          push({ role: "system", text: result.text, ok: false });
          setStatus(result.status);
          return true;
        }
        const action = args.trim().toLowerCase();
        if (action && action !== "status") {
          conscienceModeRef.current = result.mode;
          setConscienceMode(result.mode);
          noteUserChanged("conscienceMode");
          pushSettings({ conscienceMode: result.mode });
        }
        push({ role: "system", meta: "conscience", text: result.text });
        setStatus(result.status);
        return true;
      }
      if (name === "thinking") {
        const value = args.trim().toLowerCase();
        if (!value) {
          openPicker("thinking");
          return true;
        }
        if (value === "status") {
          push({
            role: "system",
            text:
              `thinking visibility: ${thinkingVisibility} · provider-visible events only` +
              " · hidden chain-of-thought is never displayed",
          });
          return true;
        }
        const mapped = value === "on" ? "stream" : value === "off" ? "hidden" : value;
        const visibility = parseThinkingVisibility(mapped);
        if (!visibility) {
          push({ role: "system", text: "usage: /thinking hidden|summary|stream|full", ok: false });
          return true;
        }
        thinkingVisibilityRef.current = visibility;
        setThinkingVisibility(visibility);
        noteUserChanged("thinkingVisibility");
        pushSettings({ thinkingVisibility: visibility });
        push({
          role: "system",
          text:
            `thinking visibility → ${visibility} · provider-visible events only` +
            " · hidden chain-of-thought is never displayed",
        });
        return true;
      }
      if (name === "image-provider") {
        const value = args.trim();
        if (!value) {
          openPicker("imageProvider");
          return true;
        }
        if (!imagePickerOptionsRef.current.some((option) => option.value === value)) {
          push({
            role: "system",
            text: `unknown image provider: ${value}\navailable: ${imagePickerOptionsRef.current.map((option) => option.value).join(", ")}`,
            ok: false,
          });
          return true;
        }
        setImageProvider(value);
        pushSettings({ imageProvider: value, onboarding: { imageProviderConfirmed: true } });
        push({ role: "system", text: `image provider → ${value} · execution requires confirmation` });
        return true;
      }
      if (name === "image") {
        if (imageProvider === "none") {
          push({
            role: "system",
            text: "no image provider is configured · use /image-provider first",
            ok: false,
          });
          return true;
        }
        const separator = args.indexOf("::");
        const output = separator >= 0 ? args.slice(0, separator).trim() : "";
        const prompt = (separator >= 0 ? args.slice(separator + 2) : args).trim();
        if (!prompt) {
          push({ role: "system", text: "usage: /image [output-path ::] <prompt>", ok: false });
          return true;
        }
        const imagePolicy = imageExecutionPolicy(permission, imageProvider);
        if (!imagePolicy.allowed) {
          push({
            role: "system",
            text: `readonly permission blocks image generation because it writes an output file · change /permissions to continue`,
            ok: false,
          });
          setStatus("image generation blocked by readonly permission");
          return true;
        }
        return confirmLocalAction(
          "Generate image",
          [
            `provider: ${imageProvider}`,
            `output: ${output || "automatic workspace filename"}`,
            `prompt length: ${prompt.length} characters`,
            imagePolicy.disclosure,
          ].join("\n"),
          () => {
            try {
              bridgeRef.current?.image({
                prompt,
                output: output || undefined,
                provider: imageProvider,
                cwd,
                permission,
                confirm: true,
                requestId: uid("image"),
              });
              setStatus("starting image generation…");
            } catch (error) {
              push({ role: "system", text: `image request failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
            }
          },
        );
      }
      if (name === "fast") {
        setEffort("low");
        applyResponseStyle("concise");
        pushSettings({ effort: "low", responseStyle: "concise" });
        push({ role: "system", text: "fast mode → low effort + concise response style" });
        return true;
      }
      if (name === "brief") {
        applyResponseStyle("concise");
        pushSettings({ responseStyle: "concise" });
        push({ role: "system", text: "brief mode → concise response style" });
        return true;
      }
      if (name === "color") {
        const value = args.trim().toLowerCase();
        const enabled = value === "on" ? true : value === "off" ? false : themeName === "mono";
        const nextTheme = enabled ? (themeName === "mono" ? "dark" : themeName) : "mono";
        setThemeName(nextTheme);
        process.env.SOPHIA_THEME = nextTheme;
        push({ role: "system", text: `color → ${enabled ? "on" : "off"} (${nextTheme})` });
        return true;
      }
      if (name === "vim") {
        const next = keymap === "vim" ? "default" : "vim";
        setKeymap(next);
        pushSettings({ keymap: next });
        push({ role: "system", text: `keymap → ${next}` });
        return true;
      }
      if (name === "keybindings") {
        if (!args.trim()) {
          openPicker("keymap");
          return true;
        }
        push({
          role: "system",
          text: [
            "Keybindings",
            "Shift+Enter / Alt+Enter: newline",
            "Ctrl+R: reverse search when integrated by the active keymap",
            "PgUp/PgDn: transcript scroll",
            "Esc: cancel active run or close panels",
            "Ctrl+C: clear input draft; cancel active run; press twice on empty input to exit",
            "Chat copy: drag-select messages → auto-copy on release; double-click a row → select-all + copy",
            "Empty input: y or Ctrl+Shift+C copies selection / focused row / last reply",
            "/copy [reply|prompt|selection|focused|N]",
            `current keymap: ${keymap}`,
          ].join("\n"),
        });
        return true;
      }
      if (name === "notifications") {
        const value = args.trim().toLowerCase();
        if (!value || value === "status") {
          push({
            role: "system",
            text: `notifications: ${notificationsEnabled ? "on" : "off"} · terminal capability=${terminalCapabilities.notifications ? terminalCapabilities.notificationProtocol : terminalCapabilities.bell ? "bell" : "toast only"}`,
          });
          return true;
        }
        if (!["on", "off"].includes(value)) {
          push({ role: "system", text: "usage: /notifications on|off|status", ok: false });
          return true;
        }
        const enabled = value === "on";
        setNotificationsEnabled(enabled);
        pushSettings({ notifications: enabled });
        push({
          role: "system",
          text: `notifications → ${value} · unsupported external channels fall back to a local toast`,
        });
        return true;
      }
      if (name === "accessibility") {
        closeOtherFullPanePanels("accessibility");
        setShowAccessibility(true);
        setStatus("Accessibility & terminal capabilities · Esc closes");
        return true;
      }
      if (name === "config") {
        push({
          role: "system",
          text: [
            `profile: ${runtimeSnapshot.profile}`,
            `execution runtime: ${executionRuntime}`,
            `model: ${model}`,
            `permission: ${permission}`,
            `A2A: ${a2aAgents < 0 ? "auto" : a2aAgents >= 2 ? `fixed ${a2aAgents}` : "off"}`,
            `workflow: ${workflowMode}`,
            `thinking: ${thinkingVisibility}`,
            `keymap: ${keymap}`,
            `image provider: ${imageProvider}`,
            `settings: ~/.sophia/config.toml + local code_bridge_state.json`,
            "loopback gateways are optional unless you explicitly select them",
          ].join("\n"),
        });
        return true;
      }
      if (name === "local") {
        // Entry point to the local-LLM operations view: open the panel and
        // kick off a fresh runtime/adapter probe rather than showing whatever
        // (possibly stale, possibly never-fetched) report happened to be
        // cached from an earlier /doctor or /local call.
        closeOtherFullPanePanels("localEngine");
        setShowLocalEngine(true);
        bridgeRef.current?.localEngineReport();
        bridgeRef.current?.adapterStatus();
        setStatus("loading local engine report…");
        return true;
      }
      if (name === "mcp") {
        bridgeRef.current?.mcpHealth({ probe: true, timeoutMs: 5000, requestId: uid("mcp") });
        setStatus("probing MCP health…");
        return true;
      }
      if (name === "connectors") {
        push({
          role: "system",
          meta: "mcp",
          text: formatConnectorPolicies(cwd, session),
        });
        setStatus("personal connector policy");
        return true;
      }
      if (name === "tools") {
        push({ role: "system", meta: "tools", text: formatNativeToolCatalog(availableTools) });
        setStatus(availableTools.length ? `native tools · ${availableTools.length}` : "native tools unavailable");
        return true;
      }
      if (name === "shell" || name === "bash") {
        const invocation = parseShellInvocation(`/${name} ${args}`.trim());
        if (!invocation || invocation.ok === false) {
          push({
            role: "system",
            meta: "shell",
            text: invocation && "error" in invocation
              ? invocation.error
              : "usage: /shell <command>",
            ok: false,
          });
          return true;
        }
        if (running) {
          push({
            role: "system",
            meta: "shell",
            text: "shell is unavailable while a run is in flight",
            ok: false,
          });
          return true;
        }
        bridgeRef.current?.shell({
          command: invocation.command,
          cwd,
          permission,
          session,
          requestId: uid("shell"),
        });
        setStatus("running shell…");
        return true;
      }
      if (name === "hooks") {
        // The reply renders the loaded config + recent dispatches itself (see
        // the "hooks" bridge-event handler) so a user sees what will run
        // before it runs, instead of the old static catalog-description echo.
        bridgeRef.current?.hooks(cwd);
        setStatus("loading hook configuration…");
        return true;
      }
      if (name === "plugin" || name === "reload-plugins") {
        const parsed = parsePluginSlash(args, name);
        if (!parsed.ok || !parsed.command) {
          push({
            role: "system",
            meta: "plugin",
            text: parsed.error || "invalid plugin command",
            ok: false,
          });
          return true;
        }
        closeOtherFullPanePanels("pluginManager");
        setShowPluginManager(true);
        updatePluginManager({
          type: "set_tab",
          tab: (
            name === "plugin" && !args.trim()
              ? "discover"
              : pluginManagerTabForAction(parsed.command.action)
          ),
        });
        const pluginCommand = parsed.command.action === "use"
          ? { ...parsed.command, session }
          : parsed.command;
        const send = () => {
          updatePluginManager({
            type: "request_started",
            action: pluginCommand.action,
          });
          bridgeRef.current?.plugin(pluginCommand, cwd);
          setStatus(`plugin ${pluginCommand.action.replaceAll("_", " ")}…`);
        };
        if (
          pluginCommand.action === "use"
          && (
            pluginCommand.approvePermissions
            || pluginCommand.approveSettings
          )
        ) {
          const leaseScope = pluginCommand.lease || "task";
          const approvalStage = pluginCommand.approveSettings
            ? "returned settings"
            : "plugin authority";
          return confirmLocalAction(
            `Approve ${approvalStage} for this ${leaseScope}`,
            [
              `Approve ${pluginCommand.reference || "the selected contribution"} for this ${leaseScope}?`,
              `Single-use challenge: ${pluginCommand.approvalToken || "(missing — command will fail closed)"}`,
              pluginCommand.approveSettings
                ? "This approves only the settings, proposal hash, plugin digest, executable hashes, permissions, contribution, scope, session, and authorization epoch bound to the displayed challenge."
                : "This approves only the plugin digest, executable hashes, permissions, contribution, scope, session, authorization epoch, and static settings or proposal request bound to the displayed challenge.",
              "This does not install the plugin, persist enablement, or change durable safe mode. Install approval remains separate.",
              "Executable contributions run as external processes. Requested sandbox enforcement follows the manifest policy and local provider: required mode fails closed, while mode off or optional fallback may run under your OS-user authority. Owned sidecars are stopped automatically when the lease ends.",
            ].join("\n"),
            send,
          );
        }
        if (
          pluginCommand.action === "compat_install"
          && pluginCommand.approveInstall
        ) {
          return confirmLocalAction(
            `Install DSH compatibility plugin from ${pluginCommand.source || "source"}`,
            [
              `Approve installation from ${pluginCommand.source || "the requested source"}?`,
              "Installation makes external plugin code present on disk; it does not enable it, approve runtime permissions, or disable Sophia plugin safe mode.",
              "Inspect the source and compatibility record before enabling any executable host.",
            ].join("\n"),
            send,
          );
        }
        if (pluginCommand.action === "compat_tool_call") {
          const namespacedTool = `${pluginCommand.compatibilityId || "plugin"}/${pluginCommand.tool || "tool"}`;
          const jsonArgs = JSON.stringify(pluginCommand.input || {}, null, 2);
          return confirmLocalAction(
            `Call external DSH tool ${namespacedTool}`,
            [
              `Namespaced tool: ${namespacedTool}`,
              `JSON arguments:\n${jsonArgs}`,
              "The external DSH plugin executes under your OS-user authority and may write files or access the network according to its code.",
              "Sophia safe mode, plugin enablement, and existing executable approvals remain in force. The plugin manager never auto-calls tools.",
            ].join("\n"),
            send,
          );
        }
        if (pluginCommand.action === "enable" && pluginCommand.approvePermissions) {
          return confirmLocalAction(
            `Enable executable plugin ${pluginCommand.pluginId || ""}`,
            [
              `Approve all permissions declared by ${pluginCommand.pluginId || "this plugin"}?`,
              "Executable plugins run as supervised external processes, and Sophia quarantines final text.",
              "Sandbox enforcement follows each manifest policy and the local provider: required mode fails closed, while mode off or optional fallback may run under your OS-user authority.",
              "Inspect the exact manifest permissions first with /plugin permissions <plugin-id>.",
            ].join("\n"),
            send,
          );
        }
        if (
          pluginCommand.action === "safe_mode"
          && pluginCommand.enabled === false
        ) {
          return confirmLocalAction(
            "Disable plugin safe mode",
            [
              "Disabling safe mode permits explicitly approved tier-4 plugin runtimes to start as supervised external processes.",
              "Safe mode does not replace manifest sandbox policy: required mode still fails closed, while mode off or optional fallback may run under your OS-user authority.",
              "Only continue after inspecting enabled executable plugins with /plugin list and /plugin permissions <plugin-id>.",
            ].join("\n"),
            send,
          );
        }
        if (
          pluginCommand.action === "profile_use"
          || pluginCommand.action === "workflow_use"
        ) {
          return confirmLocalAction(
            `Apply plugin ${pluginCommand.action === "profile_use" ? "profile" : "workflow"}`,
            [
              `Apply ${pluginCommand.reference || "the selected plugin contribution"}?`,
              "The plugin may propose routing, worker-count, terminal-layout, and response-style settings.",
              "Settings already chosen explicitly at launch or in this session remain operator-owned and will be restored after validation.",
            ].join("\n"),
            send,
          );
        }
        send();
        return true;
      }
      if (name === "skills") {
        if (!availableSkills.length) {
          push({ role: "system", text: "no skills were reported by the bridge; optional skills can be configured later" });
          return true;
        }
        push({
          role: "system",
          text: `Available skills (${availableSkills.length}):\n${availableSkills.map((skill) =>
            `  ${String(skill.name || skill.id || "skill")} · ${String(skill.whenToUse || skill.description || "")}`
          ).join("\n")}`,
        });
        return true;
      }
      if (name === "bridge") {
        const action = args.trim().toLowerCase();
        if (action === "restart" || action === "reconnect") {
          setStatus("restarting owned Sophia bridge…");
          void bridgeRef.current?.restart().then(() => {
            setBridgeReady(true);
            setStatus("bridge reconnected");
          }).catch((error) => {
            setBridgeReady(false);
            push({ role: "system", text: `bridge restart failed: ${error instanceof Error ? error.message : String(error)}`, ok: false });
          });
          return true;
        }
        bridgeRef.current?.diagnosticSnapshot({ session, requestId: uid("diag") });
        setStatus("loading bridge diagnostics…");
        return true;
      }
      const pickerKind = pickerKindFor(name);
      if (pickerKind && !args) {
        openPicker(pickerKind);
        return true;
      }
      if (name === "output-style" || name === "response-style" || name === "style") {
        const value = args.trim();
        if (!value) {
          openPicker("responseStyle");
          return true;
        }
        const style = normalizeResponseStyle(value);
        if (!style) {
          push({ role: "system", text: `invalid response style: ${value} (use adaptive, concise, explanatory, or structured)`, ok: false });
          return true;
        }
        applyResponseStyle(style);
        noteUserChanged("responseStyle");
        pushSettings({ responseStyle: style });
        push({ role: "system", text: `response style → ${style}` });
        return true;
      }
      if (name === "theme") {
        const t = args.trim().toLowerCase();
        if (!optionsFor("theme").some((option) => option.value === t)) {
          push({ role: "system", text: `invalid theme: ${args}`, ok: false });
          return true;
        }
        setThemeName(t);
        process.env.SOPHIA_THEME = t;
        push({ role: "system", text: `theme → ${t}` });
        return true;
      }
      if (name === "model") {
        const nextModel = args.trim();
        if (
          nextModel.toLowerCase() === "connections" ||
          nextModel.toLowerCase() === "connection" ||
          nextModel.toLowerCase() === "custom"
        ) {
          openModelConnections();
          return true;
        }
        if (!nextModel) {
          openPicker("model");
          return true;
        }
        setModel(nextModel);
        noteUserChanged("model");
        pushSettings({ model: nextModel, onboarding: { providerConfirmed: true } });
        try {
          bridgeRef.current?.providerHealth({
            providers: [nextModel],
            allowRemoteMetadata: false,
            includeModels: true,
          });
        } catch {
          /* health is advisory */
        }
        push({ role: "system", text: `model → ${nextModel}` });
        const loginProvider = browserLoginProviderForModel(nextModel);
        if (loginProvider) startProviderLogin(loginProvider);
        return true;
      }
      if (name === "setup") {
        openPicker("model");
        return true;
      }
      if (name === "login") {
        const provider = args.trim().toLowerCase();
        if (!provider) {
          try {
            bridgeRef.current?.providerLogin({ action: "status" });
          } catch { /* status is advisory */ }
          openPicker("login");
          return true;
        }
        if (provider === "status") {
          try {
            bridgeRef.current?.providerLogin({ action: "status" });
          } catch {
            push({ role: "system", text: "login status unavailable (bridge down)", ok: false });
          }
          return true;
        }
        startProviderLogin(provider);
        return true;
      }
      if (name === "runtime") {
        const value = args.trim().toLowerCase();
        if (!value || value === "status") {
          push({
            role: "system",
            meta: "runtime",
            text:
              executionRuntime === "prime"
                ? [
                    "execution runtime: prime",
                    "authority: external user-level process (not a Sophia sandbox)",
                    PRIME_POLICY_MODE === "full"
                      ? "tool policy: full external authority under your OS user permissions"
                      : "tool policy: advisory read/grep/find/ls only",
                    "delivery: text stays quarantined until Sophia's hard-prohibition floor runs",
                    "Prime schedules/goals/subagents: not exposed by Sophia v1",
                    "candidateOnly · canClaimAGI:false",
                  ].join("\n")
                : [
                    "execution runtime: sophia",
                    "authority: Sophia kernel permission and approval controls",
                    "candidateOnly · canClaimAGI:false",
                  ].join("\n"),
          });
          return true;
        }
        if (value !== "sophia" && value !== "prime") {
          push({
            role: "system",
            text: "usage: /runtime sophia|prime|status",
            ok: false,
          });
          return true;
        }
        if (runningRef.current) {
          push({
            role: "system",
            text: "cannot switch execution runtime while a run is active — cancel or wait",
            ok: false,
          });
          return true;
        }
        const nextRuntime = value as "sophia" | "prime";
        setExecutionRuntime(nextRuntime);
        noteUserChanged("runtime");
        pushSettings({ runtime: nextRuntime });
        push({
          role: "system",
          meta: "runtime",
          text:
            nextRuntime === "prime"
              ? [
                  "runtime → prime (optional external backend)",
                  "⚠ Prime runs with your OS user authority; this is not equivalent to Sophia's tool approval gate.",
                  PRIME_POLICY_MODE === "full"
                    ? "Sophia v1 forces one external lane and quarantined final text, but full policy leaves Prime tools under your OS user authority."
                    : "Sophia v1 forces one external lane, advisory read-only tools, no Prime schedules/goals, and quarantined final text.",
                  "Switch back with /runtime sophia.",
                ].join("\n")
              : "runtime → sophia · native permission, orchestration, and delivery controls restored",
        });
        setStatus(`runtime ${nextRuntime}`);
        return true;
      }
      if (name === "effort") {
        const eff = normalizeEffort(args);
        if (!eff) {
          push({
            role: "system",
            text: `invalid effort: ${args} (use low, medium, high, or ultra)`,
            ok: false,
          });
          return true;
        }
        setEffort(eff);
        process.env.SOPHIA_REASONING_EFFORT = eff;
        if (eff === "ultramode") process.env.SOPHIA_ULTRAMODE = "1";
        else delete process.env.SOPHIA_ULTRAMODE;
        noteUserChanged("effort");
        pushSettings({ effort: eff });
        push({
          role: "system",
          text:
            eff === "ultramode"
              ? "effort → ultra (Sophia Ultramode active)"
              : `effort → ${eff}`,
        });
        return true;
      }
      if (name === "ultramode" || name === "ultra") {
        setEffort("ultramode");
        process.env.SOPHIA_REASONING_EFFORT = "ultramode";
        process.env.SOPHIA_ULTRAMODE = "1";
        noteUserChanged("effort");
        pushSettings({ effort: "ultramode" });
        push({
          role: "system",
          text: "ULTRAMODE on — Sophia's maximum-effort operating profile is active.",
        });
        return true;
      }
      if (name === "deepmode") {
        const arg = args.trim().toLowerCase();
        if (arg === "status") {
          push({ role: "system", text: `deepmode=${deepMode ? "on" : "off"} · high-exploration sampling, independent of effort` });
          return true;
        }
        const next = arg === "on" ? true : arg === "off" ? false : !deepMode;
        noteUserChanged("deepMode");
        setDeepMode(next);
        pushSettings({ deepMode: next });
        push({
          role: "system",
          text: next
            ? "deep-mode sampling ON — high-exploration temperature/top-p/top-k (independent of effort)."
            : "deep-mode sampling OFF — mode-default sampling.",
        });
        return true;
      }
      if (name === "mode") {
        const nextMode = args.trim().toLowerCase();
        if (!optionsFor("mode").some((option) => option.value === nextMode)) {
          push({ role: "system", text: `invalid mode: ${args}`, ok: false });
          return true;
        }
        setMode(nextMode);
        noteUserChanged("mode");
        pushSettings({ mode: nextMode });
        push({ role: "system", text: `mode → ${nextMode}` });
        return true;
      }
      if (name === "permissions" || name === "permission") {
        const p = args.trim().toLowerCase();
        const mapped =
          p === "manual" || p === "approve"
            ? "manual"
            : p === "readonly"
              ? "readonly"
              : p === "auto" || p === "full"
                ? "auto"
                : "";
        if (!mapped) {
          push({ role: "system", text: `invalid permission: ${args}`, ok: false });
          return true;
        }
        setPermission(mapped);
        noteUserChanged("permission");
        pushSettings({
          permission: mapped === "manual" ? "manual" : mapped,
        });
        push({ role: "system", text: mapped === "auto" && p === "full"
          ? "permission → auto (full-access alias; destructive commands still require confirmation)"
          : `permission → ${mapped}` });
        return true;
      }
      if (name === "version") {
        push({ role: "system", text: `Sophia Code TUI ${SOPHIA_VERSION} · canClaimAGI:false` });
        return true;
      }
      if (name === "doctor") {
        try {
          bridgeRef.current?.providerHealth({
            providers: [model],
            allowRemoteMetadata: false,
            includeModels: true,
            requestId: uid("provider-health"),
          });
          bridgeRef.current?.diagnosticSnapshot({ session, requestId: uid("doctor") });
          // Also refresh the local-runtime/adapter report so the lines below
          // reflect the machine's CURRENT state, not whatever an earlier
          // /local or /doctor call happened to leave cached.
          bridgeRef.current?.localEngineReport();
          bridgeRef.current?.adapterStatus();
        } catch {
          /* local snapshot below still renders if the bridge is down */
        }
        const report = localEngineRuntimeReport;
        const localRuntimeLines = !report
          ? ["local runtime: requesting a fresh report… run /doctor again in a moment, or /local to watch it arrive"]
          : report.error
            ? [`local runtime: detection failed · ${report.error}`]
            : [
                `local runtime: ${report.osName || "?"}/${report.machine || "?"} · ${
                  report.isAppleSilicon ? "Apple Silicon" : report.hasNvidia ? "NVIDIA GPU" : "no GPU acceleration detected"
                }`,
                `local models: ollama=${report.modelCounts?.ollama ?? 0} · huggingFace=${report.modelCounts?.huggingFace ?? 0} · mlx=${report.modelCounts?.mlx ?? 0} · ds4GGUF=${
                  report.modelCounts?.gguf ??
                  ((report.modelCounts?.ds4 ?? 0) + (report.modelCounts?.pulsar ?? 0))
                }`,
                `recommendation: ${report.recommendation || "none reported"}`,
              ];
        const adapter = localAdapterStatus;
        const adapterLine = !adapter
          ? "adapter: requesting status…"
          : `adapter: ${adapter.configured ? (adapter.name || adapter.path || "configured") : "none configured"}` +
            `${adapter.configured && adapter.exists === false ? " (file missing)" : ""}`;
        // Literal, copy-pasteable setup commands — never run without a
        // separate, explicit confirmation from the operator.
        const setupLines = report?.setupSuggestions?.length
          ? ["guided setup — nothing below runs without your separate confirmation:", ...report.setupSuggestions.map((line) => `  ${line}`)]
          : [];
        push({
          role: "system",
          meta: "doctor",
          text: [
            `execution runtime: ${executionRuntime}`,
            ...doctorLines(runtimeSnapshot, {
              bridgeReady,
              model,
              permission,
              cwd,
              terminal: `${cols}x${rows} ${terminalCapabilities.platform}/${terminalCapabilities.widthClass}`,
              commands: allCommands().length,
            }),
            ...localRuntimeLines,
            adapterLine,
            ...setupLines,
          ].join("\n"),
        });
        return true;
      }
      if (name === "cost" || name === "stats" || name === "usage") {
        push({
          role: "system",
          text: [
            contextUsageRef.current || "context usage: provider did not report token totals",
            lastCost ? `last reported cost: ${lastCost}` : "last reported cost: unavailable",
            `local run receipts in this process: ${runReceiptsRef.current.length}`,
            "Run receipts are local-only and do not imply benchmark comparability or capability uplift.",
          ].join("\n"),
        });
        return true;
      }
      if (name === "contract") {
        push({
          role: "system",
          text:
            "Sophia uses a compact core runtime policy for normal runs. " +
            "The legacy Fable-derived contract is archived and is not loaded. " +
            "canClaimAGI:false.",
        });
        return true;
      }
      if (name === "okf") {
        push({
          role: "system",
          text: "OKF process logs: wiki/drafts/ or .sophia/okf-process-log/ (pageType: memory).",
        });
        return true;
      }
      if (name === "copy") {
        // /copy — clipboard copy of last reply (default), last prompt, active
        // selection, focused row, or message #N. Uses OSC 52 and/or host tools
        // (wl-copy/xclip). On total failure we print the text inline.
        const sel = selectCopyTarget(messages, args, {
          selection: transcriptSelectionRef.current,
          focusedId: focusedMsgIdRef.current,
        });
        if (!sel.ok) {
          push({ role: "system", text: sel.reason, ok: false });
          setStatus("copy: nothing copied");
          return true;
        }
        const res = copyToClipboard(sel.text);
        if (res.ok) {
          push({
            role: "system",
            text: `copied ${sel.label} · ${res.message}${res.method ? ` · via ${res.method}` : ""}`,
          });
          setStatus("copied");
        } else {
          push({ role: "system", text: `${res.message}\n\n— ${sel.label} —\n${sel.text}` });
          setStatus("copy: failed — text shown above for manual select");
        }
        return true;
      }
      if (cmd.kind === "prompt") return false;
      push({
        role: "system",
        text: `/${name}: ${cmd.description}${args ? ` · args=${args}` : ""}`,
      });
      return true;
    },
    [
      applyDiskSession,
      applyResponseStyle,
      autoTeam,
      availableSkills,
      bridgeReady,
      closeOtherFullPanePanels,
      cols,
      conscienceMode,
      cwd,
      deepMode,
      effort,
      executionRuntime,
      imageProvider,
      keymap,
      lastCost,
      localAdapterStatus,
      localEngineRuntimeReport,
      messages,
      mode,
      notificationsEnabled,
      openModelConnections,
      openPicker,
      permission,
      push,
      requestExit,
      resetSessionTransitionState,
      responseStyle,
      rows,
      runtimeSnapshot,
      session,
      startProviderLogin,
      status,
      terminalCapabilities,
      themeName,
      thinkingVisibility,
      semanticFallbackModel,
      semanticFallbackPolicy,
      semanticReturnToPrimary,
      updateApprovalQueue,
    ],
  );

  const submitLine = useCallback(
    async (raw: string, options: { secretConfirmed?: boolean } = {}) => {
      const slashPaste = planSlashCommandPaste(raw);
      if (slashPaste?.kind === "reject") {
        push({
          role: "system",
          meta: "slash-batch",
          text: `Pasted slash-command block was not run: ${slashPaste.reason}.`,
          ok: false,
        });
        setStatus("slash-command block needs review");
        return;
      }
      if (slashPaste?.kind === "batch") {
        setInput("");
        inputRef.current = "";
        void draftAutosaveRef.current?.clear(draftKey);
        push({
          role: "system",
          meta: "slash-batch",
          text: `Applying ${slashPaste.commands.length} pasted local settings in order…`,
        });
        for (const command of slashPaste.commands) {
          await submitLineRef.current(command);
        }
        push({
          role: "system",
          meta: "slash-batch",
          text: `Applied ${slashPaste.commands.length} pasted local settings.`,
        });
        setStatus(`settings batch applied · ${slashPaste.commands.length} commands`);
        return;
      }
      const line = raw.trim();
      if (!line) return;
      sessionSearchRequestRef.current += 1;
      const attachmentResult = line.startsWith("/")
        ? { attachments: [], issues: [] }
        : parseAttachmentReferences(line);
      if (attachmentResult.issues.length) {
        push({
          role: "system",
          text: `attachment reference needs review:\n${attachmentResult.issues.map((issue) => `  ${issue.message}`).join("\n")}`,
          ok: false,
        });
        setStatus("attachment reference not sent");
        return;
      }
      const secretDecision = planModelBoundSecretPreflight(
        line,
        options.secretConfirmed === true,
      );
      if (secretDecision.action === "confirm" && secretDecision.preflight) {
        const preflight = secretDecision.preflight;
        const id = uid("secret-review");
        pendingLocalActionsRef.current.set(id, () => {
          void submitLineRef.current(line, { secretConfirmed: true });
        });
        updateApprovalQueue({ type: "enqueue", approval: {
          kind: "local",
          id,
          tool: "Send possible secret",
          preview: [
            `${preflight.findings.length} possible secret pattern(s) detected.`,
            ...preflight.findings.slice(0, 5).map((finding) =>
              `${finding.preview} at line ${finding.line}, column ${finding.column}`
            ),
            preflight.notice,
          ].join("\n"),
        } });
        setStatus("possible secret detected · y send · n keep draft");
        return;
      }
      // Record into prompt history (both real prompts and slash commands — matches
      // Shell convention: ↑ recalls whatever you last submitted.
      historyRef.current?.push(line);
      const shellInvocation = parseShellInvocation(line);
      if (shellInvocation) {
        if (shellInvocation.ok === false) {
          push({
            role: "system",
            meta: "shell",
            text: shellInvocation.error,
            ok: false,
          });
          return;
        }
        if (running) {
          push({
            role: "system",
            meta: "shell",
            text: "shell is unavailable while a run is in flight",
            ok: false,
          });
          return;
        }
        push({
          role: "user",
          text: `$ ${shellInvocation.command}`,
          meta: "shell",
        });
        bridgeRef.current?.shell({
          command: shellInvocation.command,
          cwd,
          permission,
          session,
          requestId: uid("shell"),
        });
        setStatus("running shell…");
        return;
      }
      if (running && !line.startsWith("/")) {
        if (!session) {
          push({ role: "system", text: "steer rejected: no active run", ok: false });
          return;
        }
        const requestId = uid("steer");
        const runId = activeRunIdRef.current;
        // The UI can show "running" from an optimistic submit before the bridge's
        // run_start confirms the new run id. Steering with the previous run's id
        // would be rejected as a run/session mismatch, so buffer until run_start
        // lands and flush it there against the confirmed id.
        if (!runId) {
          steerPendingRef.current = { text: line, requestId };
          bufferedSteerRef.current = { text: line, session, requestId };
          setStatus("steering… awaiting run start");
          return;
        }
        steerPendingRef.current = { text: line, requestId };
        bridgeRef.current?.steer(line, runId, session, requestId);
        setStatus("steering… awaiting acknowledgement");
        return;
      }
      if (cancelling) {
        push({ role: "system", text: "run is cancelling; wait for the terminal result", ok: false });
        return;
      }
      if (submitLockRef.current) {
        // Never silent-drop: a prior throw used to leave the lock wedged, which
        // made /resume (and every later slash) look completely dead.
        push({
          role: "system",
          text: "submit busy — retrying after unlock",
          ok: false,
        });
        submitLockRef.current = false;
      }
      submitLockRef.current = true;
      setInput("");
      inputRef.current = "";
      void draftAutosaveRef.current?.clear(draftKey);

      try {
        // Interactive TUI questions can be answered immediately from visible
        // state. Keep --once on its documented kernel run_finished boundary.
        if (!props.once && !line.startsWith("/")) {
          const localAnswer = localModelIdentityAnswer(line, {
            model,
            runtime: executionRuntime,
          });
          if (localAnswer) {
            push({ role: "user", text: line });
            push({ role: "assistant", text: localAnswer });
            setStatus("model identity shown from active TUI state");
            return;
          }
        }
        if (line.startsWith("/")) {
          // Local /graph [entity] — the OKF provenance-graph audit panel. Not in
          // the generated slash catalog, so it is matched on the raw head token
          // before resolve() (which would otherwise report "Unknown command").
          // Live feed: ask the kernel for a scoped projection (sophia_dump_graph).
          // The snapshot arrives asynchronously as a `graph_projection` event and
          // is dispatched by the onEvent handler (fail-closed + stale-rejecting);
          // we open the panel now, which renders the honest empty state until the
          // event lands (or an ok:false error line is pushed). candidateOnly.
          const graphHead = line.slice(1).split(/\s+/)[0]?.toLowerCase() || "";
          if (!editionAllowsCommand(graphHead)) {
            push({
              role: "system",
              text: editionUnavailableMessage(graphHead),
              ok: false,
            });
            return;
          }
          if (graphHead === "agi-workflow") {
            if (executionRuntime === "prime") {
              push({
                role: "system",
                meta: "runtime",
                text:
                  "/agi-workflow is owned by the Sophia kernel and is unavailable in the Prime backend. " +
                  "Switch with /runtime sophia first.",
                ok: false,
              });
              return;
            }
            const value =
              line.slice(1).split(/\s+/).slice(1).join(" ").trim().toLowerCase()
              || "status";
            if (value === "status") {
              const current = agiWorkflowRef.current;
              const currentNode = current.currentNode;
              const currentWorkflow = current.workflow;
              push({
                role: "system",
                meta: "agi-workflow",
                text: [
                  `AGI workflow routing: ${agiWorkflowModeRef.current}`,
                  `live state: ${current.status} · run=${current.runId || "none"} · archive=${current.archiveState}`,
                  currentNode
                    ? `node: ${currentNode.index || "?"} · ${currentNode.title} · ${currentNode.status} · route=${currentNode.route}`
                    : "node: none reported",
                  currentWorkflow
                    ? `nested workflow: ${currentWorkflow.pattern || currentWorkflow.id} · stage=${currentWorkflow.currentStage}/${currentWorkflow.maxStages || "?"} · barrier=${currentWorkflow.barrier.status}`
                    : `nested workflow: ${current.route === "solo" ? "solo route" : "none reported"}`,
                  `workers: ${current.activeAgents.length} active · ${current.warmPoolSize} warm-idle leases · ${current.reuseCount} reuse${current.reuseCount === 1 ? "" : "s"} · ${current.archivedAgentCount} archived`,
                  agiWorkflowModeRef.current === "off"
                    ? "off: ordinary AGI, A2A, and /workflow preferences apply."
                    : "enabled: AGI on · supervised parallel A2A terminal/auto · outer /workflow off.",
                  "candidateOnly:true · canClaimAGI:false · hidden reasoning is never displayed",
                ].join("\n"),
              });
              return;
            }
            if (value !== "off" && value !== "auto" && value !== "on") {
              push({
                role: "system",
                text: "usage: /agi-workflow off|auto|on|status",
                ok: false,
              });
              return;
            }
            const next = value as AGIWorkflowMode;
            agiWorkflowOwnedRef.current = true;
            setAgiWorkflowMode(next);
            agiWorkflowModeRef.current = next;
            if (next !== "off") {
              setAgiMode(true);
              agiModeRef.current = true;
              setAutoTeam(false);
              autoTeamRef.current = false;
              setTeamAgents(1);
              teamRef.current = 1;
              setA2aAgents(-1);
              a2aAgentsRef.current = -1;
              setA2aExecution("terminal");
              a2aExecutionRef.current = "terminal";
              setTerminalLayout("auto");
              terminalLayoutRef.current = "auto";
              setWorkflowMode("off");
              workflowModeRef.current = "off";
              setDynamicWorkflow((prev) => ({
                ...prev,
                configuredMode: "off",
                active: false,
              }));
              pushSettings({
                agiWorkflowMode: next,
                agiMode: true,
                autoTeam: false,
                team: 1,
                a2aAgents: -1,
                a2aExecution: "terminal",
                terminalLayout: "auto",
                workflowMode: "off",
              });
              push({
                role: "system",
                meta: "agi-workflow",
                text:
                  `AGI workflow routing → ${next}\n` +
                  "AGI on · supervised parallel A2A terminal/auto · outer /workflow off.\n" +
                  "candidateOnly:true · canClaimAGI:false",
              });
            } else {
              pushSettings({ agiWorkflowMode: "off" });
              push({
                role: "system",
                meta: "agi-workflow",
                text:
                  "AGI workflow routing → off\n" +
                  "Existing AGI, A2A, terminal, and lane preferences are preserved; change them separately if desired.\n" +
                  "candidateOnly:true · canClaimAGI:false",
              });
            }
            setStatus(`AGI workflow ${next}`);
            return;
          }
          if (graphHead === "graph") {
            const entity = line.slice(1).split(/\s+/).slice(1).join(" ");
            bridgeRef.current?.graphProjection(entity ? { root: entity, depth: 2 } : {});
            dispatchGraph({ type: "select", id: entity || null });
            graphCursorRef.current = 0;
            closeOtherFullPanePanels("graph");
            setShowGraph(true);
            setStatus(entity ? `Knowledge Graph: ${entity} · ↑↓ browse · Enter expand · Esc close` : "Knowledge Graph · ↑↓ browse · Enter expand · Esc close");
            return;
          }
          // Local /goal <text> — autonomous goal-continuation mode. The kernel
          // (run_goal_loop) keeps self-generating continuation prompts that
          // restate the goal until it is achieved, confidently unachievable, or
          // a safety bound trips. Matched on the raw head token (like /graph).
          if (graphHead === "goal") {
            const goalText = line.slice(1).split(/\s+/).slice(1).join(" ").trim();
            if (!goalText) {
              push({
                role: "system",
                text: "usage: /goal <what you want achieved> — the agent keeps working until the goal is achieved or confidently unachievable (bounded; candidateOnly)",
                ok: false,
              });
              return;
            }
            if (executionRuntime === "prime") {
              push({
                role: "system",
                meta: "runtime",
                text:
                  "/goal is intentionally unavailable in the Prime backend v1. " +
                  "Sophia remains the outer autonomy authority; switch with " +
                  "/runtime sophia for bounded goal continuation.",
                ok: false,
              });
              return;
            }
            if (!bridgeRef.current?.isReady()) {
              push({ role: "system", text: "bridge not ready yet" });
              return;
            }
            if (secretDecision.modelBound?.source !== "goal") {
              push({ role: "system", text: "goal preflight could not resolve the final prompt; nothing was sent", ok: false });
              setStatus("goal not sent");
              return;
            }
            const goalPrompt = secretDecision.modelBound.prompt;
            push({
              role: "user",
              text: line,
              meta: agiModeRef.current
                ? "(goal · AGI mode · bounded autonomous)"
                : "(goal · autonomous)",
            });
            resetRunState();
            scrollToLatest();
            if (agiModeRef.current) {
              bridgeRef.current.agi({
                action: "start",
                prompt: goalPrompt,
                session,
                profile: agiProfileRef.current,
                route: agiRouteRef.current,
                model,
                mode,
                permission: permission === "manual" ? "manual" : permission,
                cwd,
                effort,
                reasoningEffort: effort,
                responseStyle,
                conscienceMode,
                plannerModel: agiPlannerModelRef.current || undefined,
                workerModel: agiWorkerModelRef.current || undefined,
                verifierModel: agiVerifierModelRef.current || undefined,
              });
            } else {
              bridgeRef.current.goal({
                prompt: goalPrompt,
                runtime: "sophia",
                model,
                mode,
                permission: permission === "manual" ? "manual" : permission,
                session,
                cwd,
                deepThink: effort === "ultramode" || effort === "high",
                deepMode,
                effort,
                reasoningEffort: effort,
                responseStyle,
                conscienceMode,
              });
            }
            return;
          }
          // Local /panel — compact visibility plus keyboard-accessible detail
          // views for Goal, Workflow, Agents, To-do, AGI, and the live Session
          // Flow. Mouse users can click the same compact section headings; the
          // slash route keeps the interaction
          // available when mouse tracking is disabled or a screen reader is on.
          if (graphHead === "panel") {
            const panelArg =
              line.slice(1).split(/\s+/).slice(1).join(" ").trim().toLowerCase();
            if (
              panelArg === "goal" ||
              panelArg === "agents" ||
              panelArg === "team" ||
              panelArg === "todo" ||
              panelArg === "todos" ||
              panelArg === "workflow" ||
              panelArg === "agi" ||
              panelArg === "flow" ||
              panelArg === "details"
            ) {
              const section: RightPanelSection =
                panelArg === "agents" || panelArg === "team"
                  ? "agents"
                  : panelArg === "todo" || panelArg === "todos"
                    ? "todos"
                    : panelArg === "workflow"
                      ? "workflow"
                    : panelArg === "agi"
                      ? "agi"
                      : panelArg === "flow"
                        ? "flow"
                        : panelArg === "details"
                          ? rightPanelDetailRef.current.section
                          : "goal";
              openRightPanelDetail(section);
              return;
            }
            if (panelArg === "close" || panelArg === "compact") {
              dispatchRightPanelDetail({ type: "close" });
              setStatus("panel details closed · compact panel remains visible");
              return;
            }
            if (panelArg === "show" || panelArg === "on") {
              showPanelRef.current = true;
              setShowPanel(true);
              setStatus("panel shown · click Goal, Workflow, Agents, To-do, AGI, or Flow for details");
              return;
            }
            if (panelArg === "hide" || panelArg === "off") {
              showPanelRef.current = false;
              setShowPanel(false);
              dispatchRightPanelDetail({ type: "close" });
              setStatus("panel hidden — /panel show to restore");
              return;
            }
            if (panelArg === "status") {
              push({
                role: "system",
                meta: "panel",
                text: [
                  `right panel: ${showPanelRef.current ? "visible" : "hidden"}`,
                  `details: ${rightPanelDetailRef.current.open ? rightPanelDetailRef.current.section : "closed"}`,
                  "click a compact section to expand; ordinary details use ↑↓/PgUp/PgDn/wheel; Flow uses block navigation and pan; Tab changes section; Esc closes details",
                ].join("\n"),
              });
              return;
            }
            if (panelArg) {
              push({
                role: "system",
                text:
                  "usage: /panel [show|hide|goal|workflow|agents|todo|agi|flow|details|compact|status]",
                ok: false,
              });
              return;
            }
            const next = !showPanelRef.current;
            showPanelRef.current = next;
            setShowPanel(next);
            if (!next) dispatchRightPanelDetail({ type: "close" });
            setStatus(
              next
                ? "panel shown · click a section for full details"
                : "panel hidden — /panel to restore",
            );
            return;
          }
          const { cmd, name, args } = resolve(line);
          if (!cmd) {
            const guesses = suggest("/" + name, 6);
            if (guesses.length) {
              push({
                role: "system",
                text: `Unknown command: /${name}\nDid you mean:\n` +
                  guesses.map((g) => `  ${g.slash}  ${g.description}`).join("\n"),
              });
              return;
            }
            // suggest()'s substring tiers found nothing (e.g. a transposed or
            // missing-letter typo like /reusme or /mdoel) — fall back to
            // edit-distance recovery instead of a dead-end "Type /help".
            const typo = didYouMean(allCommands(), name);
            push({
              role: "system",
              text: typo
                ? `Unknown command: /${name}\nDid you mean /${typo.command.name}? — ${typo.command.description}\nType /help for the full list.`
                : `Unknown command: /${name}\nType /help for the full list.`,
            });
            return;
          }
          if (cmd.execution_state === "unsupported" || cmd.support_state === "unsupported") {
            push({ role: "system", text: unsupportedMessage(cmd.name) });
            return;
          }
          if (secretDecision.modelBound?.source === "catalog-prompt") {
            const goal = secretDecision.modelBound.prompt;
            push({ role: "user", text: line, meta: `(agent · /${cmd.name})` });
            if (!bridgeRef.current?.isReady()) {
              push({ role: "system", text: "bridge not ready yet" });
              return;
            }
            // A new run's id is not known until the bridge emits run_start; clear
            // the previous run's id so a steer typed in this window buffers instead
            // of targeting the stale run and being rejected as a mismatch.
            resetRunState();
            scrollToLatest();
            bridgeRef.current.run({
              prompt: goal,
              runtime: executionRuntime,
              model,
              mode,
              permission: permission === "manual" ? "manual" : permission,
              session,
              cwd,
              deepThink: executionRuntime === "sophia" && (effort === "ultramode" || effort === "high"),
              deepMode: executionRuntime === "sophia" && deepMode,
              effort,
              reasoningEffort: effort,
              responseStyle,
              conscienceMode,
              autoGoal:
                executionRuntime === "sophia"
                && !agiModeRef.current
                && agiWorkflowModeRef.current === "off",
              team: 1,
              autoTeam: false,
              a2aAgents:
                executionRuntime === "prime"
                  ? 0
                  : agiWorkflowModeRef.current !== "off"
                    ? -1
                    : a2aAgentsRef.current,
              a2aExecution:
                agiWorkflowModeRef.current !== "off"
                  ? "terminal"
                  : a2aExecutionRef.current,
              terminalLayout:
                agiWorkflowModeRef.current !== "off"
                  ? "auto"
                  : terminalLayoutRef.current,
              workflowMode:
                executionRuntime === "sophia"
                && agiWorkflowModeRef.current === "off"
                  ? workflowModeRef.current
                  : "off",
              workflowMaxStages: workflowMaxStagesRef.current,
              workflowMaxAgents: workflowMaxAgentsRef.current,
              agiMode:
                executionRuntime === "sophia"
                && (agiModeRef.current || agiWorkflowModeRef.current !== "off"),
              agiWorkflowMode:
                executionRuntime === "sophia"
                  ? agiWorkflowModeRef.current
                  : "off",
              agiProfile: agiProfileRef.current,
              agiRoute: agiRouteRef.current,
              agiPlannerModel: agiPlannerModelRef.current || undefined,
              agiWorkerModel: agiWorkerModelRef.current || undefined,
              agiVerifierModel: agiVerifierModelRef.current || undefined,
            });
            return;
          }
          if (runLocalSlash(cmd, args, secretDecision.modelBound)) {
            return;
          }
          // Local command fell through without handling — do not send bare
          // "/resume" to the model as a goal (that looks like "resume does nothing").
          push({
            role: "system",
            text: `/${name} is catalogued but not wired in this TUI build. Try /session list.`,
            ok: false,
          });
          return;
        }

        if (secretDecision.modelBound?.source !== "plain") {
          push({ role: "system", text: "prompt preflight could not resolve the final prompt; nothing was sent", ok: false });
          setStatus("prompt not sent");
          return;
        }
        const prompt = secretDecision.modelBound.prompt;
        push({
          role: "user",
          text: line,
          meta: attachmentResult.attachments.length
            ? `(${attachmentResult.attachments.length} attachment reference${attachmentResult.attachments.length === 1 ? "" : "s"})`
            : undefined,
        });
        if (!bridgeRef.current?.isReady()) {
          push({ role: "system", text: "bridge not ready — wait a moment" });
          return;
        }
        // See above: the new run's id is unknown until run_start, so drop the
        // stale id to make an immediate steer buffer rather than mismatch.
        resetRunState();
        scrollToLatest();
        bridgeRef.current.run({
          prompt,
          runtime: executionRuntime,
          model,
          mode,
          permission: permission === "manual" ? "manual" : permission,
          session,
          cwd,
          deepThink: executionRuntime === "sophia" && (effort === "ultramode" || effort === "high"),
          deepMode: executionRuntime === "sophia" && deepMode,
          effort,
          reasoningEffort: effort,
          responseStyle,
          conscienceMode,
          autoGoal:
            executionRuntime === "sophia"
            && !agiModeRef.current
            && agiWorkflowModeRef.current === "off",
          team: 1,
          autoTeam: false,
          a2aAgents:
            executionRuntime === "prime"
              ? 0
              : agiWorkflowModeRef.current !== "off"
                ? -1
                : a2aAgentsRef.current,
          a2aExecution:
            agiWorkflowModeRef.current !== "off"
              ? "terminal"
              : a2aExecutionRef.current,
          terminalLayout:
            agiWorkflowModeRef.current !== "off"
              ? "auto"
              : terminalLayoutRef.current,
          workflowMode:
            executionRuntime === "sophia"
            && agiWorkflowModeRef.current === "off"
              ? workflowModeRef.current
              : "off",
          workflowMaxStages: workflowMaxStagesRef.current,
          workflowMaxAgents: workflowMaxAgentsRef.current,
          agiMode:
            executionRuntime === "sophia"
            && (agiModeRef.current || agiWorkflowModeRef.current !== "off"),
          agiWorkflowMode:
            executionRuntime === "sophia"
              ? agiWorkflowModeRef.current
              : "off",
          agiProfile: agiProfileRef.current,
          agiRoute: agiRouteRef.current,
          agiPlannerModel: agiPlannerModelRef.current || undefined,
          agiWorkerModel: agiWorkerModelRef.current || undefined,
          agiVerifierModel: agiVerifierModelRef.current || undefined,
        });
      } catch (error) {
        push({
          role: "system",
          text: `command failed: ${error instanceof Error ? error.message : String(error)}`,
          ok: false,
        });
        setStatus("command failed");
        // resetRunState() has already set running/phase, and bridge.run() throws
        // before the bridge ever sees the prompt — so no result/error event is
        // coming to clear them. Leaving `running` true made the TUI treat every
        // later prompt as a steer for a run that does not exist: the input
        // appeared to work and silently did nothing until restart.
        setRunning(false);
        setCancelling(false);
        activeRunIdRef.current = null;
        setPhase({ phase: "error", detail: "command failed", streamPreview: "" });
      } finally {
        // Always release — a throw here used to permanently mute every slash.
        submitLockRef.current = false;
      }
    },
    [conscienceMode, cwd, deepMode, draftKey, effort, executionRuntime, model, mode, permission, push, responseStyle, runLocalSlash, running, session, setPhase, scrollToLatest, updateApprovalQueue],
  );
  submitLineRef.current = submitLine;

  // Global keys: scroll, expand, mouse, approval, exit.
  useInput((inputKey, key) => {
    const shiftTab = (key.shift && key.tab) || inputKey === "[Z";
    if (
      shiftTab &&
      !rightPanelDetailRef.current.open &&
      !showPluginManager &&
      !activePickerRef.current &&
      !sessionPickerRef.current
    ) {
      noteUserChanged("permission");
      pushSettings({ permission: "auto" });
      push({ role: "system", text: "permission → auto (Shift+Tab)" });
      setStatus("permission auto · requested");
      return;
    }
    // Ctrl+C remains a global lifecycle chord even while the workflow overlay
    // owns navigation; otherwise the overlay's early return swallows it.
    // Claude Code / Grok Build style: non-empty composer → clear draft first;
    // idle empty composer → double-tap exit; active run → cancel.
    const globalExitChord =
      (key.ctrl && (inputKey === "c" || inputKey === "\x03")) ||
      inputKey === "\x03" ||
      (key.meta && inputKey.toLowerCase() === "c");
    if (globalExitChord && !activePickerRef.current && !sessionPickerRef.current) {
      if (running) {
        cancelActiveRun();
        lastCtrlCRef.current = 0;
      } else if (inputRef.current.length > 0 || input.length > 0) {
        setInput("");
        inputRef.current = "";
        void draftAutosaveRef.current?.clear(draftKey);
        lastCtrlCRef.current = 0;
        setExitHint(false);
        setStatus("input cleared · Ctrl+C again to exit");
      } else {
        const now = Date.now();
        if (now - lastCtrlCRef.current < 1500) void requestExit();
        else {
          lastCtrlCRef.current = now;
          setExitHint(true);
          setStatus("Press Ctrl+C / Cmd+C again to exit");
          setTimeout(() => setExitHint(false), 1500);
        }
      }
      return;
    }
    if (
      modelConnectionsRef.current.open &&
      !activePickerRef.current &&
      !sessionPickerRef.current
    ) {
      handleModelConnectionsInput(inputKey, key);
      return;
    }
    if (
      showPluginManager
      && !pendingApproval
      && !activePickerRef.current
      && !sessionPickerRef.current
    ) {
      const intent = resolvePluginManagerKey(inputKey, key);
      if (intent === "close") {
        setShowPluginManager(false);
        setStatus("plugin manager closed");
        return;
      }
      if (intent === "next_tab" || intent === "previous_tab") {
        updatePluginManager({
          type: "cycle_tab",
          direction: intent === "previous_tab" ? -1 : 1,
        });
        setStatus("plugin manager tab changed");
        return;
      }
      if (intent === "move_up" || intent === "move_down") {
        updatePluginManager({
          type: "move",
          delta: intent === "move_down" ? 1 : -1,
        });
        return;
      }
      const selected = selectedPluginManagerEntry(pluginManagerRef.current);
      if (intent === "reload") {
        updatePluginManager({ type: "request_started", action: "reload" });
        bridgeRef.current?.plugin({ action: "reload" }, cwd);
        setStatus("plugin reload…");
        return;
      }
      if (intent === "permissions") {
        updatePluginManager({ type: "set_tab", tab: "permissions" });
        if (!selected) {
          setStatus("no plugin selected for permission inspection");
          return;
        }
        const command = selected.kind === "compat"
          ? {
              action: "compat_inspect" as const,
              compatibilityId: selected.compatibilityId || selected.id,
            }
          : {
              action: "permissions" as const,
              pluginId: selected.id,
            };
        updatePluginManager({ type: "request_started", action: command.action });
        bridgeRef.current?.plugin(command, cwd);
        setStatus(`plugin permissions · ${selected.id}…`);
        return;
      }
      if (intent === "health") {
        updatePluginManager({ type: "set_tab", tab: "health" });
        if (selected?.kind === "compat") {
          const compatibilityId = selected.compatibilityId || selected.id;
          updatePluginManager({ type: "probe_started", compatibilityId });
          bridgeRef.current?.plugin({
            action: "compat_health",
            compatibilityId,
          }, cwd);
          setStatus(`explicit plugin health probe · ${compatibilityId}…`);
        } else {
          const reference = pluginManagerRef.current.selections.runtime;
          updatePluginManager({ type: "request_started", action: "runtime_status" });
          bridgeRef.current?.plugin({
            action: "runtime_status",
            ...(reference ? { reference } : {}),
          }, cwd);
          setStatus("explicit selected plugin runtime probe…");
        }
        return;
      }
      if (intent === "inspect") {
        if (!selected) {
          setStatus("no plugin selected to inspect");
          return;
        }
        const command = selected.kind === "compat"
          ? {
              action: "compat_inspect" as const,
              compatibilityId: selected.compatibilityId || selected.id,
            }
          : {
              action: "inspect" as const,
              pluginId: selected.id,
            };
        updatePluginManager({ type: "request_started", action: command.action });
        bridgeRef.current?.plugin(command, cwd);
        setStatus(`plugin inspect · ${selected.id}…`);
        return;
      }
      // The panel owns all keys while open so hidden composer/transcript
      // shortcuts cannot trigger plugin execution or mutate the session.
      return;
    }
    if (showPlanMode && planModeRef.current && !activePickerRef.current && !sessionPickerRef.current) {
      const plan = planModeRef.current;
      if (key.escape && plan.phase === "completed") {
        handlePlanModelClose();
        setStatus("plan panel closed");
        return;
      }
      const intent = resolvePlanPanelKey(inputKey, key, plan.phase);
      if (intent === "move_up" || intent === "move_down") {
        const count = plan.steps.length;
        if (count) {
          planCursorRef.current =
            (planCursorRef.current + (intent === "move_down" ? 1 : -1) + count) % count;
        }
        return;
      }
      if (intent === "approve") {
        const next = transitionPlanMode(plan, { type: "approve" });
        setPlanModeState(next.state);
        // Mirror onto the PlanModel gate too — PlanPanel renders `model` in
        // preference to `state` once one exists (see the render site), so
        // the richer view must track the same approve/reject decision this
        // legacy FSM already gated on, or its "Awaiting approval" label would
        // stay stuck after a real approval.
        if (next.accepted) handlePlanModelApprove();
        setStatus(next.accepted ? "plan approved · press s to execute" : next.reason || "plan approval rejected");
        return;
      }
      if (intent === "reject") {
        const next = transitionPlanMode(plan, { type: "reject" });
        setPlanModeState(next.state);
        if (next.accepted) handlePlanModelReject();
        setStatus(next.accepted ? "plan returned to draft" : next.reason || "plan transition rejected");
        return;
      }
      if (intent === "start") {
        const next = transitionPlanMode(plan, { type: "start" });
        setPlanModeState(next.state);
        if (!next.accepted) {
          setStatus(next.reason || "plan cannot start");
          return;
        }
        const executionPrompt = [
          "Execute this operator-approved Sophia plan.",
          `Task: ${next.state.title}`,
          "Approved steps:",
          ...next.state.steps.map((step, index) => `${index + 1}. ${step.title}${step.detail ? ` — ${step.detail}` : ""}`),
          "Stay within the approved scope. Use normal tool permission gates. Verify before concluding.",
        ].join("\n");
        setShowPlanMode(false);
        void submitLineRef.current(executionPrompt);
        setStatus("approved plan starting…");
        return;
      }
      if (intent === "complete_step") {
        const active = activePlanStep(plan);
        if (!active) return;
        const next = transitionPlanMode(plan, {
          type: "set_step_status",
          stepId: active.id,
          status: "completed",
        });
        setPlanModeState(next.state);
        setStatus(next.state.phase === "completed" ? "plan completed" : "plan advanced");
        return;
      }
      if (intent === "request_exit") {
        setPlanModeState(transitionPlanMode(plan, { type: "request_exit" }).state);
        return;
      }
      if (intent === "confirm_exit") {
        const next = transitionPlanMode(plan, { type: "confirm_exit" });
        setPlanModeState(next.state);
        handlePlanModelClose();
        setStatus("plan exited · resumable locally");
        return;
      }
      if (intent === "cancel_exit") {
        setPlanModeState(transitionPlanMode(plan, { type: "cancel_exit" }).state);
        return;
      }
      if (intent === "resume") {
        setPlanModeState(transitionPlanMode(plan, { type: "resume" }).state);
        setStatus("local plan resumed");
        return;
      }
      // Enter reaches here (a "select" per resolvePlanModelPanelKey's own
      // smaller vocabulary) only when the legacy FSM above found no
      // phase-specific meaning for it (e.g. the gate is still pending, so
      // neither "submit_for_approval" nor "start" applied) — report it to
      // the PlanModel view as focusing the highlighted step's detail rather
      // than silently dropping the keystroke.
      if (!intent && key.return && planModelRef.current) {
        const step = planModelRef.current.steps[planCursorRef.current];
        if (step) {
          handlePlanModelSelectStep(step.id);
          setStatus(step.detail || step.title);
        }
      }
      return;
    }
    if (showAccessibility && !activePickerRef.current && !sessionPickerRef.current) {
      if (key.escape) {
        setShowAccessibility(false);
        setStatus("accessibility panel closed");
      }
      return;
    }
    if (showWorkflow && !activePickerRef.current && !sessionPickerRef.current) {
      const rows = flattenWorkflow(workflowRef.current);
      if (key.escape) { setShowWorkflow(false); dispatchWorkflow({ type: "view", value: "hidden" }); return; }
      if (key.upArrow || key.downArrow) {
        if (rows.length) workflowCursorRef.current = (workflowCursorRef.current + (key.downArrow ? 1 : -1) + rows.length) % rows.length;
        const selected = rows[workflowCursorRef.current]; if (selected) dispatchWorkflow({ type: "select", id: selected.taskId }); return;
      }
      if (key.return || inputKey === "e" || inputKey === " ") {
        const selected = rows[workflowCursorRef.current]; if (selected) dispatchWorkflow({ type: "toggle", id: selected.taskId }); return;
      }
      if (key.ctrl && inputKey === "c") { const selected = rows[workflowCursorRef.current]; if (selected?.canCancel && workflowRef.current.snapshot?.capabilities?.cancel) bridgeRef.current?.taskAction(selected.runId || "", selected.taskId, "cancel"); return; }
      if (key.ctrl && inputKey === "r") { const selected = rows[workflowCursorRef.current]; if (selected?.canRetry && workflowRef.current.snapshot?.capabilities?.retry === true) bridgeRef.current?.taskAction(selected.runId || "", selected.taskId, "retry"); else setStatus("retry unsupported by backend"); return; }
      if (key.ctrl && inputKey === "l") { const selected = rows[workflowCursorRef.current]; if (selected && workflowRef.current.snapshot?.capabilities?.logs) bridgeRef.current?.taskLog(selected.runId || "", selected.taskId); return; }
      return;
    }
    if (showGraph && !activePickerRef.current && !sessionPickerRef.current) {
      const rows = visibleNodes(graphRef.current);
      if (key.escape) { setShowGraph(false); return; }
      if (key.upArrow || key.downArrow) {
        if (rows.length) graphCursorRef.current = (graphCursorRef.current + (key.downArrow ? 1 : -1) + rows.length) % rows.length;
        const selected = rows[graphCursorRef.current]; if (selected) dispatchGraph({ type: "select", id: selected.id }); return;
      }
      if (key.return || inputKey === "e" || inputKey === " ") {
        const selected = rows[graphCursorRef.current]; if (selected) dispatchGraph({ type: "toggle", id: selected.id }); return;
      }
      return;
    }
    if (showLocalEngine && !activePickerRef.current && !sessionPickerRef.current) {
      // Presentation-only, same as GraphPanel/AccessibilityPanel — no rows to
      // navigate here yet, so Esc is the only owned key.
      if (key.escape) {
        setShowLocalEngine(false);
        setStatus("local engine panel closed");
      }
      return;
    }
    if (showArcCampaign && !activePickerRef.current && !sessionPickerRef.current) {
      if (key.escape) {
        setShowArcCampaign(false);
        setStatus("ARC campaign view closed");
        return;
      }
      if (inputKey.toLowerCase() === "c" && arcCampaignPanel?.command) {
        const copied = copyToClipboard(arcCampaignPanel.command);
        setStatus(copied.ok ? "ARC command copied" : "ARC copy failed · use /arc copy");
      }
      // Presentation-only modal: swallow every other key so it cannot edit the
      // hidden composer or mutate a campaign.
      return;
    }
    if (sessionPickerRef.current) {
      // The SessionBrowser owns its own ↑↓/Enter/Esc through a STABLE useInput
      // (see SessionBrowser.tsx). Driving navigation from this global handler
      // used setSessionPicker on every arrow, which re-rendered App and
      // re-subscribed this inline useInput — dropping the next keystroke (you
      // could open the browser but never resume once you moved). Guarding here
      // leaves input to the browser and also keeps the mouse feed below from
      // firing while the browser is open.
      return;
    }
    if (activePickerRef.current) return;

    // ── Optional application mouse: wheel + click to expand ──────────
    if (props.mouseMode) {
      const decoded = mouseDecoderRef.current.feed(inputKey, true);
      if (decoded.mouse) {
        for (const me of decoded.events) {
          const panelSection = rightPanelSectionAt(
            rightPanelHitRegionsRef.current,
            me.x,
            me.y,
          );
          const insidePanel = isInsideRightPanel(
            rightPanelHitRegionsRef.current,
            me.x,
            me.y,
          ) || (
            panelVisible &&
            me.x >= rightPanelScreenLeft &&
            me.x < rightPanelScreenLeft + GOAL_PANEL_COLS &&
            me.y >= paneTopRow &&
            me.y < paneTopRow + msgMax
          );
          if (
            rightPanelDetailRef.current.open &&
            rightPanelDetailRef.current.section === "flow"
          ) {
            const report = sessionFlowPanelLayoutRef.current;
            const miniMap = sessionFlowMiniMapLayoutRef.current;
            const insideMiniMap = Boolean(
              miniMap &&
                me.x >= miniMap.canvasScreenLeft &&
                me.x < miniMap.canvasScreenLeft + miniMap.canvasWidth &&
                me.y >= miniMap.canvasScreenTop &&
                me.y < miniMap.canvasScreenTop + miniMap.canvasHeight,
            );
            if (
              me.kind === "click" &&
              me.button === 0 &&
              insideMiniMap &&
              miniMap &&
              report &&
              miniMap.projectionKey === report.projectionKey
            ) {
              const target = sessionFlowMiniMapNavigationAtCell(
                miniMap.projection,
                me.x - miniMap.canvasScreenLeft,
                me.y - miniMap.canvasScreenTop,
                report.layout.bounds,
              );
              if (target?.world) {
                const navigation = resolveSessionFlowMiniMapNavigation(
                  { nodeId: target.nodeId, world: target.world },
                  {
                    width: report.viewportWidth,
                    height: report.viewportHeight,
                  },
                  report.layout,
                );
                if (navigation.hiddenNodeId) {
                  setStatus(
                    "flow block is hidden in the current view · press d or expand its parent",
                  );
                  continue;
                }
                if (!navigation.pan) continue;
                seedManualSessionFlowPan(report);
                if (navigation.selectedNodeId) {
                  dispatchSessionFlowInteraction({
                    type: "select",
                    nodeId: navigation.selectedNodeId,
                  });
                }
                dispatchSessionFlowInteraction({
                  type: "set_pan",
                  panX: navigation.pan.panX,
                  panY: navigation.pan.panY,
                });
                setStatus(
                  navigation.selectedNodeId
                    ? `flow minimap selected · ${
                        report.layout.nodes.find(
                          (node) => node.id === navigation.selectedNodeId,
                        )?.node.label ?? navigation.selectedNodeId
                      }`
                    : "flow minimap recentered",
                );
              }
              continue;
            }
            if (
              me.kind === "wheel_up" ||
              me.kind === "wheel_down" ||
              me.kind === "wheel_left" ||
              me.kind === "wheel_right"
            ) {
              const gesture = sessionFlowWheelGesture(me);
              if (report && gesture?.kind === "zoom") {
                const now = Date.now();
                if (
                  now - sessionFlowZoomWheelAtRef.current >=
                  SESSION_FLOW_ZOOM_WHEEL_INTERVAL_MS
                ) {
                  sessionFlowZoomWheelAtRef.current = now;
                  const currentZoom =
                    sessionFlowInteractionRef.current.zoomLevel;
                  setSessionFlowZoom(
                    gesture.step > 0
                      ? nextSessionFlowZoomLevel(currentZoom)
                      : previousSessionFlowZoomLevel(currentZoom),
                    { x: me.x, y: me.y },
                  );
                }
                continue;
              }
              if (gesture?.kind === "pan") {
                queueSessionFlowPan(gesture.dx, gesture.dy);
              }
              continue;
            }
            const insideCanvas = Boolean(
              report &&
                me.x >= report.canvasScreenLeft &&
                me.x < report.canvasScreenLeft + report.viewportWidth &&
                me.y >= report.canvasScreenTop &&
                me.y < report.canvasScreenTop + report.viewportHeight,
            );
            if (
              me.kind === "click" &&
              (me.button === 0 || me.button === 1) &&
              insideCanvas &&
              !me.shift
            ) {
              sessionFlowPointerDragRef.current = {
                button: me.button,
                startX: me.x,
                startY: me.y,
                lastX: me.x,
                lastY: me.y,
                nodeId:
                  me.button === 0
                    ? sessionFlowNodeAtScreen(report, me.x, me.y)
                    : null,
                dragging: false,
              };
              continue;
            }
            if (me.kind === "drag") {
              const drag = sessionFlowPointerDragRef.current;
              if (drag && report) {
                const currentPoint = { x: me.x, y: me.y };
                if (
                  drag.dragging ||
                  isSessionFlowDrag(
                    { x: drag.startX, y: drag.startY },
                    currentPoint,
                  )
                ) {
                  if (!drag.dragging) {
                    drag.dragging = true;
                    seedManualSessionFlowPan(report);
                  }
                  const delta = sessionFlowPointerDelta(
                    { x: drag.lastX, y: drag.lastY },
                    currentPoint,
                  );
                  drag.lastX = me.x;
                  drag.lastY = me.y;
                  dispatchSessionFlowInteraction({
                    type: "pan",
                    dx: delta.panX,
                    dy: delta.panY,
                    activeNodeId: report.layout.activeNodeId,
                    latestNodeId: report.layout.latestNodeId,
                  });
                }
                continue;
              }
            }
            if (me.kind === "release" && sessionFlowPointerDragRef.current) {
              const drag = sessionFlowPointerDragRef.current;
              sessionFlowPointerDragRef.current = null;
              if (!drag.dragging && drag.button === 0 && report) {
                const nodeId =
                  sessionFlowNodeAtScreen(report, me.x, me.y) ?? drag.nodeId;
                if (nodeId) {
                  const now = Date.now();
                  const previousClick = sessionFlowLastClickRef.current;
                  const doubleClick = Boolean(
                    previousClick
                    && previousClick.nodeId === nodeId
                    && now - previousClick.at <= 350,
                  );
                  sessionFlowLastClickRef.current = doubleClick
                    ? null
                    : { nodeId, at: now };
                  const metadata = report.metadataByNodeId[nodeId];
                  if (
                    doubleClick
                    && metadata?.drillable
                    && sessionFlowInteractionRef.current.detailLevel !== "workers"
                  ) {
                    const nextLevel = nextSessionFlowDetailLevel(
                      sessionFlowInteractionRef.current.detailLevel,
                    );
                    dispatchSessionFlowInteraction({
                      type: "enter_hierarchy",
                      nodeId: metadata.childFocusNodeId || nodeId,
                    });
                    dispatchSessionFlowInteraction({
                      type: "set_detail",
                      detailLevel: nextLevel,
                    });
                    setStatus(
                      `flow portal entered · ${
                        report.layout.nodes.find((node) => node.id === nodeId)
                          ?.node.label ?? nodeId
                      } · ${nextLevel}`,
                    );
                    continue;
                  }
                  seedManualSessionFlowPan(report);
                  dispatchSessionFlowInteraction({ type: "select", nodeId });
                  setStatus(
                    `flow block selected · ${
                      report.layout.nodes.find((node) => node.id === nodeId)
                        ?.node.label ?? nodeId
                    }`,
                  );
                }
              } else if (drag.dragging) {
                setStatus("session flow canvas panned");
              }
              continue;
            }
            if (me.kind === "click" && me.button === 0) {
              // The expanded graph owns the replaced transcript pane even
              // when the click lands on an edge or empty canvas cell.
              if (
                me.x < rightPanelScreenLeft &&
                me.y >= paneTopRow &&
                me.y < paneTopRow + msgMax
              ) {
                continue;
              }
              const nodeId = sessionFlowNodeAtScreen(report, me.x, me.y);
              if (nodeId && report) {
                seedManualSessionFlowPan(report);
                dispatchSessionFlowInteraction({ type: "select", nodeId });
                setStatus(
                  `flow block selected · ${
                    report.layout.nodes.find((node) => node.id === nodeId)
                      ?.node.label ?? nodeId
                  }`,
                );
              }
            }
          }
          if (
            rightPanelDetailRef.current.open &&
            (me.kind === "wheel_up" || me.kind === "wheel_down")
          ) {
            scrollRightPanelDetail(me.kind === "wheel_up" ? -3 : 3);
            continue;
          }
          if (
            rightPanelDetailRef.current.open
            && rightPanelDetailRef.current.section !== "flow"
            && me.kind === "click"
            && me.button === 0
            && me.x < rightPanelScreenLeft
            && me.y >= paneTopRow
            && me.y < paneTopRow + msgMax
          ) {
            const itemId = rightPanelDetailItemAt(
              rightPanelDetailItemRegionsRef.current,
              me.x,
              me.y,
            );
            if (itemId) {
              dispatchRightPanelDetail({ type: "toggle_item", id: itemId });
              setStatus(`detail ${itemId} toggled`);
            }
            // The expanded detail pane owns this screen region even when the
            // click lands on a non-interactive line.
            continue;
          }
          if (me.kind === "click" && me.button === 0 && panelSection) {
            rightPanelMouseDownRef.current = true;
            showPanelRef.current = true;
            setShowPanel(true);
            closeOtherFullPanePanels("rightPanel");
            dispatchRightPanelDetail({ type: "toggle", section: panelSection });
            const opening =
              !rightPanelDetailRef.current.open ||
              rightPanelDetailRef.current.section !== panelSection;
            setStatus(
              opening
                ? panelSection === "flow"
                  ? "Flow diagram opened · drag or four-way wheel to pan · +/- zoom · 0 fit · Esc close"
                  : `${panelSection === "todos" ? "To-do" : panelSection[0].toUpperCase() + panelSection.slice(1)} details opened · wheel/↑↓ scroll · Esc close`
                : "panel details closed",
            );
            continue;
          }
          if (me.kind === "release" && me.button === 0 && rightPanelMouseDownRef.current) {
            rightPanelMouseDownRef.current = false;
            continue;
          }
          // The compact panel is not part of the transcript hit surface. Never
          // let a click/drag in it toggle or select a same-row chat message.
          if (insidePanel) continue;
          // While details replace the transcript pane, stale transcript hit
          // regions from the previous render must not receive mouse gestures.
          if (rightPanelDetailRef.current.open) continue;
          if (me.kind === "wheel_up") {
            scrollBy(3);
            continue;
          }
          if (me.kind === "wheel_down") {
            scrollBy(-3);
            continue;
          }
          if (me.kind === "click" && me.button === 0) {
            const hit = hitRegionAtRow(hitRegionsRef.current, me.y);
            if (!hit) continue;
            const now = Date.now();
            const prev = lastClickRef.current;
            // Double-click same row within 400ms → select-all that message + auto-copy.
            if (prev && prev.id === hit.id && now - prev.at < 400) {
              lastClickRef.current = null;
              transcriptDragRef.current = null;
              setTranscriptDragActive(false);
              selectAllAndCopyMessage(hit.id);
              continue;
            }
            lastClickRef.current = { id: hit.id, at: now };
            transcriptSelectionRef.current = null;
            setTranscriptSelection(null);
            transcriptDragRef.current = {
              anchorId: hit.id,
              headId: hit.id,
              startX: me.x,
              startY: me.y,
              dragging: false,
            };
            transcriptLastMouseRef.current = { x: me.x, y: me.y };
            transcriptDragAutoScrollRef.current = null;
            setTranscriptDragActive(false);
            setFocusedMsgId(hit.id);
            focusedMsgIdRef.current = hit.id;
            continue;
          }
          if (
            (me.kind === "drag" && me.button === 0) ||
            (me.kind === "move" && transcriptDragRef.current !== null)
          ) {
            let drag = transcriptDragRef.current;
            if (!drag) {
              const anchor = nearestHitRegion(hitRegionsRef.current, me.y);
              if (!anchor) continue;
              drag = {
                anchorId: anchor.id,
                headId: anchor.id,
                startX: me.x,
                startY: me.y,
                dragging: false,
              };
            }
            const moved =
              Math.abs(me.x - drag.startX) + Math.abs(me.y - drag.startY) > 0;
            const head = nearestHitRegion(hitRegionsRef.current, me.y);
            const next: TranscriptDragState = {
              ...drag,
              headId: head?.id || drag.headId,
              dragging: drag.dragging || moved,
            };
            transcriptDragRef.current = next;
            transcriptLastMouseRef.current = { x: me.x, y: me.y };
            transcriptDragAutoScrollRef.current = next.dragging
              ? dragAutoScrollAtRow(me.y, paneTopRow, msgMax)
              : null;
            if (next.dragging) {
              setTranscriptDragActive(true);
              const selection = {
                anchorId: next.anchorId,
                headId: next.headId,
              };
              transcriptSelectionRef.current = selection;
              setTranscriptSelection(selection);
              setFocusedMsgId(next.headId);
            }
            continue;
          }
          if (me.kind === "release" && me.button === 0) {
            transcriptDragAutoScrollRef.current = null;
            setTranscriptDragActive(false);
            const drag = transcriptDragRef.current;
            transcriptDragRef.current = null;
            transcriptLastMouseRef.current = null;
            if (!drag) continue;
            if (!drag.dragging) {
              const hit =
                hitRegionAtRow(hitRegionsRef.current, me.y) ??
                hitRegionsRef.current.find((region) => region.id === drag.anchorId) ??
                null;
              if (hit?.role === "assistant") toggleCollapse(hit.id);
              continue;
            }
            const selection = {
              anchorId: drag.anchorId,
              headId: drag.headId,
            };
            transcriptSelectionRef.current = selection;
            setTranscriptSelection(selection);
            // Auto-copy on selection release (select-all of spanned messages).
            copyTranscriptSelection(selection);
          }
        }
        return;
      }
    }

    if (rightPanelDetailRef.current.open) {
      if (rightPanelDetailRef.current.section === "flow") {
        const report = sessionFlowPanelLayoutRef.current;
        const layoutNodes = report?.layout.nodes ?? [];
        const activeNodeId = report?.layout.activeNodeId ?? null;
        const latestNodeId = report?.layout.latestNodeId ?? null;
        const selectedNodeId =
          report?.selectedNodeId ??
          sessionFlowInteractionRef.current.selectedNodeId;
        const selectedNode =
          layoutNodes.find((node) => node.id === selectedNodeId) ?? null;
        const selectedMetadata =
          selectedNodeId
            ? report?.metadataByNodeId[selectedNodeId]
            : undefined;
        const normalized = inputKey.toLowerCase();
        if (
          (key.escape || key.backspace)
          && sessionFlowInteractionRef.current.hierarchyPath.length > 0
        ) {
          const currentLevel =
            sessionFlowInteractionRef.current.detailLevel;
          const nextLevel = previousSessionFlowDetailLevel(currentLevel);
          dispatchSessionFlowInteraction({ type: "exit_hierarchy" });
          dispatchSessionFlowInteraction({
            type: "set_detail",
            detailLevel: nextLevel,
          });
          setStatus(
            `session flow hierarchy · ${nextLevel}${
              sessionFlowInteractionRef.current.hierarchyPath.length > 1
                ? " · parent capsule"
                : " · all runs"
            }`,
          );
          return;
        }
        if (
          report &&
          !accessibility.screenReader &&
          key.shift &&
          (key.leftArrow ||
            key.rightArrow ||
            key.upArrow ||
            key.downArrow)
        ) {
          seedManualSessionFlowPan(report);
          dispatchSessionFlowInteraction({
            type: "pan",
            dx: key.leftArrow ? 4 : key.rightArrow ? -4 : 0,
            dy: key.upArrow ? 2 : key.downArrow ? -2 : 0,
            activeNodeId,
            latestNodeId,
          });
          return;
        }
        const directionalKeyAllowed =
          accessibility.screenReader || !key.shift;
        const direction =
          directionalKeyAllowed && (key.leftArrow || normalized === "h")
            ? "left"
            : directionalKeyAllowed && (key.rightArrow || normalized === "l")
              ? "right"
              : directionalKeyAllowed && (key.upArrow || normalized === "k")
                ? "up"
                : directionalKeyAllowed && (key.downArrow || normalized === "j")
                  ? "down"
                  : null;
        if (direction && report) {
          const targetId = nearestSessionFlowNodeId(
            selectedNodeId,
            direction,
            layoutNodes,
          );
          if (!accessibility.screenReader) {
            seedManualSessionFlowPan(report);
          }
          dispatchSessionFlowInteraction({
            type: "navigate",
            direction,
            nodes: layoutNodes,
            activeNodeId,
            latestNodeId,
          });
          const targetNode =
            layoutNodes.find((node) => node.id === targetId) ?? null;
          if (targetNode && !accessibility.screenReader) {
            dispatchSessionFlowInteraction({
              type: "center",
              node: targetNode,
              viewport: {
                width: report.viewportWidth,
                height: report.viewportHeight,
              },
            });
          }
          return;
        }
        if (key.return && selectedNodeId) {
          if (
            selectedMetadata?.drillable
            && sessionFlowInteractionRef.current.detailLevel !== "workers"
          ) {
            const nextLevel = nextSessionFlowDetailLevel(
              sessionFlowInteractionRef.current.detailLevel,
            );
            dispatchSessionFlowInteraction({
              type: "enter_hierarchy",
              nodeId: selectedMetadata.childFocusNodeId || selectedNodeId,
            });
            dispatchSessionFlowInteraction({
              type: "set_detail",
              detailLevel: nextLevel,
            });
            setStatus(
              `flow portal entered · ${
                selectedNode?.node.label ?? selectedNodeId
              } · ${nextLevel}`,
            );
            return;
          }
          dispatchSessionFlowInteraction({
            type: "select",
            nodeId: selectedNodeId,
          });
          setStatus(
            `flow inspector focused · ${selectedNode?.node.label ?? selectedNodeId}`,
          );
          return;
        }
        if (inputKey === " " && selectedNodeId) {
          if (
            !selectedNode ||
            selectedNode.hiddenChildCount + selectedNode.visibleChildCount === 0
          ) {
            setStatus("selected flow block has no child blocks to fold");
            return;
          }
          dispatchSessionFlowInteraction({
            type: selectedNode?.collapsed ? "expand" : "collapse",
            nodeId: selectedNodeId,
          });
          setStatus(
            `${selectedNode?.collapsed ? "flow block expanded" : "flow block folded"} · ${
              selectedNode?.node.label ?? selectedNodeId
            }`,
          );
          return;
        }
        if (inputKey === "F" || (normalized === "f" && key.shift)) {
          const nextFollow =
            !sessionFlowInteractionRef.current.followLive;
          dispatchSessionFlowInteraction({
            type: "toggle_follow",
            activeNodeId,
            latestNodeId,
          });
          if (!nextFollow && selectedNode && report) {
            dispatchSessionFlowInteraction({
              type: "center",
              node: selectedNode,
              viewport: {
                width: report.viewportWidth,
                height: report.viewportHeight,
              },
            });
          }
          setStatus(
            nextFollow
              ? "flow follow-live enabled"
              : "flow follow-live paused · manual navigation",
          );
          return;
        }
        if (
          normalized === "c" &&
          selectedNode &&
          report &&
          !accessibility.screenReader
        ) {
          seedManualSessionFlowPan(report);
          dispatchSessionFlowInteraction({
            type: "center",
            node: selectedNode,
            viewport: {
              width: report.viewportWidth,
              height: report.viewportHeight,
            },
          });
          setStatus("selected flow block centered");
          return;
        }
        if (normalized === "r") {
          dispatchSessionFlowInteraction({ type: "relayout" });
          setStatus("session flow layout refreshed");
          return;
        }
        if (inputKey === "+" || inputKey === "=") {
          setSessionFlowZoom(
            nextSessionFlowZoomLevel(
              sessionFlowInteractionRef.current.zoomLevel,
            ),
          );
          return;
        }
        if (inputKey === "-") {
          setSessionFlowZoom(
            previousSessionFlowZoomLevel(
              sessionFlowInteractionRef.current.zoomLevel,
            ),
          );
          return;
        }
        if (normalized === "d") {
          const currentLevel =
            sessionFlowInteractionRef.current.detailLevel;
          const nextLevel =
            currentLevel === "workers"
              ? "overview"
              : nextSessionFlowDetailLevel(currentLevel);
          if (nextLevel === "overview") {
            dispatchSessionFlowInteraction({ type: "clear_hierarchy" });
          }
          dispatchSessionFlowInteraction({
            type: "set_detail",
            detailLevel: nextLevel,
          });
          setStatus(
            `session flow hierarchy · ${nextLevel}`,
          );
          return;
        }
        if (inputKey === "0") {
          fitSessionFlowToViewport();
          return;
        }
        if (inputKey === "1") {
          setSessionFlowZoom("normal");
          return;
        }
        if (key.home && report) {
          const targetId = firstSessionFlowNodeId(layoutNodes);
          dispatchSessionFlowInteraction({
            type: "home",
            nodes: layoutNodes,
          });
          const targetNode =
            layoutNodes.find((node) => node.id === targetId) ?? null;
          if (targetNode && !accessibility.screenReader) {
            dispatchSessionFlowInteraction({
              type: "center",
              node: targetNode,
              viewport: {
                width: report.viewportWidth,
                height: report.viewportHeight,
              },
            });
          }
          return;
        }
        if (key.end && report) {
          const targetId = lastSessionFlowNodeId(
            layoutNodes,
            activeNodeId,
            latestNodeId,
          );
          dispatchSessionFlowInteraction({
            type: "end",
            nodes: layoutNodes,
            activeNodeId,
            latestNodeId,
          });
          const targetNode =
            layoutNodes.find((node) => node.id === targetId) ?? null;
          if (targetNode && !accessibility.screenReader) {
            dispatchSessionFlowInteraction({
              type: "center",
              node: targetNode,
              viewport: {
                width: report.viewportWidth,
                height: report.viewportHeight,
              },
            });
          }
          return;
        }
        if ((key.pageUp || key.pageDown) && report) {
          const direction = key.pageUp ? 1 : -1;
          if (accessibility.screenReader) {
            scrollRightPanelDetail(
              direction * -Math.max(3, Math.floor(msgMax / 2)),
            );
            return;
          }
          seedManualSessionFlowPan(report);
          dispatchSessionFlowInteraction({
            type: "pan",
            dx: key.shift
              ? direction * Math.max(6, Math.floor(report.viewportWidth / 2))
              : 0,
            dy: key.shift
              ? 0
              : direction *
                Math.max(3, Math.floor(report.viewportHeight / 2)),
            activeNodeId,
            latestNodeId,
          });
          return;
        }
      }
      if (
        rightPanelDetailRef.current.section === "flow" &&
        inputKey.toLowerCase() === "e" &&
        !key.ctrl &&
        !key.meta
      ) {
        try {
          const report = sessionFlowPanelLayoutRef.current;
          const fullHierarchy = key.shift || inputKey === "E";
          const currentPresentation = sessionFlowPresentationRef.current;
          const currentInteraction = sessionFlowInteractionRef.current;
          const reportIsCurrent =
            report?.projectionKey === sessionFlowProjectionKeyRef.current
            && report.state === currentPresentation.state;
          const fullPresentation = fullHierarchy
            ? presentSessionFlowHierarchy(
                sessionFlowRef.current,
                { level: "workers" },
                dynamicWorkflow,
                agiWorkflowRef.current,
              )
            : null;
          const fullInteraction = fullHierarchy
            ? {
                ...sessionFlowInteractionRef.current,
                detailLevel: "workers" as const,
                hierarchyPath: [],
                collapsedIds: [],
                expandedIds: [],
              }
            : null;
          const exportLayout =
            fullPresentation && fullInteraction
              ? layoutSessionFlowForInteraction(
                  fullPresentation.state,
                  fullInteraction,
                  { previousLayout: null },
                )
              : reportIsCurrent && report
                ? report.layout
                : layoutSessionFlowForInteraction(
                    currentPresentation.state,
                    currentInteraction,
                    { previousLayout: null },
                  );
          const geometry = exportLayout
            ? sessionFlowDrawioGeometry(exportLayout)
            : {};
          const exportState =
            fullPresentation && exportLayout
              ? sessionFlowDrawioProjection(
                  fullPresentation.state,
                  exportLayout,
                )
              : exportLayout
                ? sessionFlowDrawioProjection(
                    currentPresentation.state,
                    exportLayout,
                  )
                : currentPresentation.state;
          const target = writeSessionFlowDrawio(exportState, {
            sessionId:
              `${session}-${fullHierarchy ? "full-hierarchy" : "major"}`,
            ...geometry,
          });
          setStatus(
            `session flow ${fullHierarchy ? "full hierarchy" : "major view"} exported · ${target}`,
          );
        } catch (error) {
          setStatus(
            `session flow export failed · ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        return;
      }
      if (
        rightPanelDetailRef.current.section !== "flow"
        && (inputKey.toLowerCase() === "n" || inputKey.toLowerCase() === "p")
        && !key.ctrl
        && !key.meta
      ) {
        dispatchRightPanelDetail({
          type: "move_item",
          delta: inputKey.toLowerCase() === "n" ? 1 : -1,
          ids: rightPanelDetailItemIdsRef.current,
        });
        return;
      }
      if (
        rightPanelDetailRef.current.section !== "flow"
        && (key.return || inputKey === " ")
      ) {
        dispatchRightPanelDetail({ type: "toggle_item" });
        return;
      }
      const intent = resolveRightPanelKey(inputKey, key);
      const page = Math.max(3, Math.floor(msgMax / 2));
      if (intent === "close") {
        dispatchRightPanelDetail({ type: "close" });
        setStatus("panel details closed · compact panel remains visible");
        return;
      }
      if (intent === "previous_section" || intent === "next_section") {
        dispatchRightPanelDetail({
          type: "cycle",
          delta: intent === "next_section" ? 1 : -1,
        });
        return;
      }
      if (
        intent === "goal" ||
        intent === "agents" ||
        intent === "todos" ||
        intent === "workflow" ||
        intent === "agi" ||
        intent === "flow"
      ) {
        dispatchRightPanelDetail({ type: "select", section: intent });
        return;
      }
      if (intent === "scroll_up" || intent === "scroll_down") {
        scrollRightPanelDetail(intent === "scroll_up" ? -1 : 1);
        return;
      }
      if (intent === "page_up" || intent === "page_down") {
        scrollRightPanelDetail(intent === "page_up" ? -page : page);
        return;
      }
      if (intent === "scroll_top" || intent === "scroll_bottom") {
        dispatchRightPanelDetail({
          type: "scroll_to",
          offset: intent === "scroll_top" ? 0 : rightPanelMaxScrollRef.current,
          maxScroll: rightPanelMaxScrollRef.current,
        });
        return;
      }
      // Detail view owns focus while open. Swallow unrelated keys so typing
      // cannot silently edit the hidden composer underneath it.
      return;
    }

    // ── Chat scroll (always available; doesn't require empty input) ───
    if (key.pageUp) {
      scrollBy(Math.max(3, Math.floor(rows / 2)));
      return;
    }
    if (key.pageDown) {
      scrollBy(-Math.max(3, Math.floor(rows / 2)));
      return;
    }
    // Ctrl+G — the gate report the status chip advertises. Kept as a real
    // transcript entry rather than a transient banner so it can be scrolled
    // back to and copied, which is the point of an audit affordance.
    //
    // Match the BEL control character too: several terminals/key parsers deliver
    // Ctrl+G as "\x07" (sometimes without setting key.ctrl), so keying only off
    // inputKey === "g" would silently drop the handler on those terminals — the
    // chip would advertise ^g and again do nothing. Same shape as the Ctrl+C
    // matcher above, which already accepts its "\x03" form.
    if ((key.ctrl && (inputKey === "g" || inputKey === "\x07")) || inputKey === "\x07") {
      push({
        role: "system",
        text: ["Gate report", ...epistemicDetailLines(epistemicRef.current)].join("\n"),
      });
      return;
    }
    // Ctrl+U / Ctrl+D (vim-style half-page)
    if (key.ctrl && inputKey === "u") {
      scrollBy(Math.max(3, Math.floor(rows / 2)));
      return;
    }
    if (key.ctrl && inputKey === "d") {
      scrollBy(-Math.max(3, Math.floor(rows / 2)));
      return;
    }
    // Jump oldest / latest (Ctrl+Home style via Ctrl+B / Ctrl+N when input empty)
    if (key.ctrl && inputKey === "b" && input.length === 0) {
      setScrollOffset(maxScroll);
      stickBottomRef.current = false;
      return;
    }
    if (key.ctrl && inputKey === "n" && input.length === 0) {
      scrollToLatest();
      return;
    }

    // Expand/collapse focused (or latest) assistant when input empty
    if (
      input.length === 0 &&
      !activePicker &&
      !slashOpen &&
      (inputKey === "e" || inputKey === "o" || inputKey === " ")
    ) {
      const assistants = messages.filter((m) => m.role === "assistant");
      const target =
        (focusedMsgId && assistants.find((m) => m.id === focusedMsgId)) ||
        assistants[assistants.length - 1];
      if (target) {
        toggleCollapse(target.id);
        return;
      }
    }

    // Shift+↑/↓ scroll when slash menu is closed
    if (!slashOpen && !activePicker && key.shift && key.upArrow) {
      scrollBy(1);
      return;
    }
    if (!slashOpen && !activePicker && key.shift && key.downArrow) {
      scrollBy(-1);
      return;
    }

    // No-mouse fallback: when mouse tracking is OFF the wheel arrives as bare
    // ↑/↓, so an empty box scrolls the transcript (PromptInput skips recall on
    // empty in this mode). With mouse tracking ON (the default) the wheel is a
    // real mouse event handled above and keyboard ↑/↓ on empty recall history
    // instead, so this branch must stay inert to avoid scrolling AND recalling
    // at once.
    if (!slashOpen && !activePicker && !props.mouseMode && input.length === 0 && key.upArrow) {
      scrollBy(3);
      return;
    }
    if (!slashOpen && !activePicker && !props.mouseMode && input.length === 0 && key.downArrow) {
      scrollBy(-3);
      return;
    }

    if (pendingApproval) {
      if (inputKey.toLowerCase() === "y") {
        if (pendingApproval.kind === "tool") {
          bridgeRef.current?.approve(pendingApproval.id, true);
        } else {
          const action = pendingLocalActionsRef.current.get(pendingApproval.id);
          pendingLocalActionsRef.current.delete(pendingApproval.id);
          action?.();
        }
        const next = updateApprovalQueue({ type: "resolve", id: pendingApproval.id });
        if (next[0]) {
          setProgress((current) => ({
            ...current,
            phase: "awaiting_permission",
            detail: next[0].tool,
            streamPreview: "",
          }));
          setStatus(`approved · ${next.length} approval${next.length === 1 ? "" : "s"} pending`);
        } else {
          setStatus("approved");
        }
        return;
      }
      // "Always allow this tool for this session" — offered (and honoured)
      // only for a non-destructive tool request; a destructive one always
      // requires an explicit y/n on every occurrence, even if the same tool
      // already carries a grant from an earlier, non-destructive call.
      if (
        isAlwaysAllowToolKey(
          inputKey,
          pendingApproval.kind === "tool" && !pendingApproval.destructive,
        )
      ) {
        handleAlwaysAllowTool(pendingApproval.tool);
        bridgeRef.current?.approve(pendingApproval.id, true);
        const next = updateApprovalQueue({ type: "resolve", id: pendingApproval.id });
        if (next[0]) {
          setProgress((current) => ({
            ...current,
            phase: "awaiting_permission",
            detail: next[0].tool,
            streamPreview: "",
          }));
          setStatus(`approved · always allow ${pendingApproval.tool} this session · ${next.length} pending`);
        } else {
          setStatus(`approved · always allow ${pendingApproval.tool} this session`);
        }
        return;
      }
      if (inputKey.toLowerCase() === "n") {
        if (pendingApproval.kind === "tool") {
          bridgeRef.current?.approve(pendingApproval.id, false);
        } else {
          pendingLocalActionsRef.current.delete(pendingApproval.id);
        }
        const next = updateApprovalQueue({ type: "resolve", id: pendingApproval.id });
        if (next[0]) {
          setProgress((current) => ({
            ...current,
            phase: "awaiting_permission",
            detail: next[0].tool,
            streamPreview: "",
          }));
          setStatus(`denied · ${next.length} approval${next.length === 1 ? "" : "s"} pending`);
        } else {
          setStatus(pendingApproval.kind === "tool" ? "denied" : "cancelled; draft kept");
        }
        return;
      }
    }
    if (
      key.escape &&
      (transcriptSelectionRef.current || transcriptDragRef.current)
    ) {
      clearTranscriptSelection();
      setStatus("transcript selection cleared");
      return;
    }
    // Empty composer: y or Ctrl+Shift+C → auto-copy selection / focused (select-all) / last reply.
    // Does not steal approval 'y' (pendingApproval handled above).
    if (
      !slashOpen &&
      !activePicker &&
      !pendingApproval &&
      input.length === 0 &&
      (
        (key.ctrl && key.shift && inputKey.toLowerCase() === "c") ||
        (inputKey.toLowerCase() === "y" && !key.ctrl && !key.meta && !key.shift)
      )
    ) {
      const sel = transcriptSelectionRef.current;
      if (sel) {
        copyTranscriptSelection(sel, "selection");
        return;
      }
      if (focusedMsgIdRef.current) {
        selectAllAndCopyMessage(focusedMsgIdRef.current);
        return;
      }
      const target = selectCopyTarget(messagesRef.current, "");
      if (!target.ok) {
        setStatus(target.reason);
        return;
      }
      const res = copyToClipboard(target.text);
      setStatus(
        res.ok
          ? `${res.message} · ${target.label}`
          : res.message,
      );
      return;
    }
    if (key.escape && running) {
      cancelActiveRun();
      return;
    }
    if (key.escape && slashOpen) {
      setInput("");
      setStatus("slash menu closed");
      return;
    }
    // NOTE: Esc deliberately does NOT hide the goal/todo panel. It did briefly,
    // but Esc is pressed for many reasons (close menu, cancel, clear input) and
    // a stray Esc silently hid a panel the operator expected to stay visible —
    // "where did my panel go?" The panel is "always visible, /panel-toggleable",
    // so /panel is now the ONLY toggle (see the submit path).
    // Double Ctrl+C or Cmd+C within 1.5s to exit (prevent accidental quit)
    const isExitChord =
      (key.ctrl && (inputKey === "c" || inputKey === "\x03")) ||
      inputKey === "\x03" ||
      (key.meta && inputKey.toLowerCase() === "c");
    if (isExitChord) {
      if (input.length > 0) {
        setInput("");
        inputRef.current = "";
        lastCtrlCRef.current = 0;
        setExitHint(false);
        setStatus(running ? "input cleared; run continues" : "input cleared");
        return;
      }
      if (running) {
        cancelActiveRun();
        lastCtrlCRef.current = 0;
        return;
      }
      const now = Date.now();
      if (now - lastCtrlCRef.current < 1500) {
        void requestExit();
        return;
      }
      lastCtrlCRef.current = now;
      setExitHint(true);
      setStatus("Press Ctrl+C / Cmd+C again to exit");
      setTimeout(() => setExitHint(false), 1500);
      return;
    }
  }, { isActive: process.stdin.isTTY });

  const onSlashUp = useCallback(() => {
    const n = slashMatchesRef.current.length;
    if (!n) return;
    setSlashSelected((s) => {
      const next = (s - 1 + n) % n;
      slashSelectedRef.current = next;
      return next;
    });
  }, []);

  const onSlashDown = useCallback(() => {
    const n = slashMatchesRef.current.length;
    if (!n) return;
    setSlashSelected((s) => {
      const next = (s + 1) % n;
      slashSelectedRef.current = next;
      return next;
    });
  }, []);

  const onSlashTab = useCallback((): string => {
    // Tab = complete highlighted command into the input (do not run yet)
    const completed = applySlashSelection();
    setStatus(`completed ${completed.trim()} — Enter to run`);
    return completed;
  }, [applySlashSelection]);

  /**
   * Enter while slash menu open:
   * Prefer the *typed* line when it already resolves to a known command
   * (preserves args: `/resume tui-default`). Otherwise run the highlighted match.
   */
  const onSlashEnterSelect = useCallback((): boolean => {
    // Decision logic lives in slash.ts:chooseSlashSubmission (pure, unit-tested)
    // so the "typed /resume name is preserved" contract is locked without
    // rendering <App>, which spawns a real bridge subprocess.
    const line = chooseSlashSubmission(
      inputRef.current || "",
      slashMatchesRef.current,
      slashSelectedRef.current,
    );
    if (line === null) return false;
    setInput("");
    inputRef.current = "";
    void submitLine(line);
    return true;
  }, [submitLine]);

  const onSubmit = useCallback(
    (value: string) => {
      void submitLine(value);
    },
    [submitLine],
  );

  // Effective next-run routing state belongs in the compact TOP chrome.
  // Session/repository identity is deliberately kept out of this row and
  // rendered beside the prompt instead.
  const {
    agiEnabled: agiStatusOn,
    a2aMode: a2aStatusMode,
    workflowMode: workflowStatusMode,
  } = resolveOrchestrationStatus({
    executionRuntime,
    agiMode: agiMode || agiWorkflowMode !== "off",
    a2aAgents,
    a2aConcurrency,
    workflowMode,
    workflowActive: dynamicWorkflow.active,
  });
  const loadH = loadingIndicatorHeight(progress);
  const backendHealth = providerHealthWord(runtimeSnapshot);
  const backendAlert = ["degraded", "unavailable", "unconfigured"].includes(backendHealth)
    ? `Provider · ${backendHealth}`
    : "";
  const idleStatus = status.trim().toLowerCase() === "ready" ? "" : status;
  const topStatusText = exitHint
    ? "Press Ctrl+C / Cmd+C again to exit"
    : [
        backendAlert,
        loadH === 0 ? idleStatus : "",
      ].filter(Boolean).join(" · ");
  const footerHint = sessionPicker
    ? "↑↓ select session · Enter load · Esc cancel"
    : activePicker
      ? "↑↓ select option · Enter confirm · Esc cancel"
      : showArcCampaign
        ? "ARC campaign · c copy shown command · Esc close · read-only"
        : rightPanelDetail.open
          ? "Right panel details · g/a/t/w/i/f or 1-6 · ↑↓/PgUp/PgDn/wheel scroll · Esc close"
          : slashOpen
            ? slashMatches.length
              ? `↑↓ ${slashSelected + 1}/${slashMatches.length} · Tab complete · Enter run highlighted · type to filter`
              : "No command match · keep typing or Esc to close"
            : "";

  // ── Responsive layout ────────────────────────────────────────────────
  // Chrome heights scale with terminal size so the message pane always
  // absorbs leftover rows when the window grows tall, and overlays
  // (slash / model picker) claim a fraction of height rather than a fixed
  // cap that overflows a short terminal.
  const compact = rows < 18;
  const statusH =
    1
    + controlStatusRows({
      width: contentWidth,
      permission,
      agiEnabled: agiStatusOn,
      a2aMode: a2aStatusMode,
      workflowMode: workflowStatusMode,
    }).length
    + (topStatusText ? 1 : 0);
  const promptVisibleLines = Math.min(
    compact ? 2 : 4,
    Math.max(1, input.split("\n").length),
  );
  const promptH = promptVisibleLines;
  const workspaceH = 1;
  const hintH = footerHint ? 1 : 0;
  const marginH = 0;
  const permH = pendingApproval ? Math.min(8, Math.max(5, Math.floor(rows * 0.2))) : 0;

  // Overlay list windows scale with available height.
  const overlayBudget = Math.max(
    4,
    rows - statusH - promptH - hintH - loadH - marginH - permH - 2,
  );
  const pickerOpts = (() => {
    const base = (() => {
      if (!activePicker) return sessionOptions;
      // The model picker uses the merged static+discovered list (see
      // modelPickerOptions above) so locally-cached models appear as rows.
      if (activePicker.kind === "model") return modelPickerOptions;
      if (activePicker.kind === "imageProvider") return imagePickerOptions;
      return optionsFor(activePicker.kind);
    })();
    // Type-to-filter only applies to the OptionPicker (activePicker) path —
    // the session browser has its own query mechanism. Must filter with the
    // exact same predicate handlePickerInput's arrow/Enter handling uses, or
    // the highlighted row and what Enter selects would disagree with what is
    // rendered here.
    if (!activePicker || !pickerFilterQuery.trim()) return base;
    return base.filter((option) => matchPickerOption(option, pickerFilterQuery).length > 0);
  })();
  const pickerVisible = (activePicker || sessionPicker)
    ? Math.min(pickerOpts.length, Math.max(4, Math.min(18, Math.floor(overlayBudget * 0.7))))
    : 0;
  // Chrome height reserved for an overlay picker. Only the model/effort/etc.
  // OptionPicker lives in the chrome; the session browser takes over the
  // message pane instead, so it reserves no chrome height (msgMax stays large
  // and the browser fills the transcript area).
  const pickerH = activePicker ? pickerVisible + 4 : 0; // title + help + borders

  // Dropped `slashMatches.length > 0`: a typo like "/reusme" used to leave
  // SlashSuggest unmounted entirely (no feedback at all) even though the
  // component itself already renders a "did you mean /resume" empty state —
  // App.tsx's own render gate was the only thing keeping it unreachable.
  const slashVis = !activePicker && slashOpen;
  const slashVisible = slashVis
    ? Math.min(
        slashMatches.length,
        Math.max(4, Math.min(20, Math.floor(overlayBudget * 0.65))),
      )
    : 0;
  // SlashSuggest prints one extra header line each time a visible row's
  // category differs from the row before it (its own showHeader logic) — a
  // flat "+4" budget (title + help + top/bottom border) under-reserves
  // whenever the visible window spans more than one category, which used to
  // clip the last row or the "N more below" line. Reserve one row per
  // category boundary the visible window can contain (a bounded, order-
  // preserving heuristic over the same slice SlashSuggest itself windows to).
  // The zero-match ("did you mean") state renders 3 text lines (title, warn
  // message, tab hint) instead of 2, so its fixed overhead is one row taller.
  const slashCategoryHeaders = slashMatches.length
    ? new Set(slashMatches.slice(0, slashVisible).map((c) => c.category)).size
    : 0;
  const slashH = slashVis
    ? (slashMatches.length ? slashVisible + slashCategoryHeaders + 4 : 5)
    : 0;

  const chromeH =
    statusH + promptH + workspaceH + hintH + loadH + marginH + permH + pickerH + slashH +
    (showWorkflow ? (teamLaneState.lanes.length ? 14 : 8) : 0);
  const msgMax = Math.max(3, rows - chromeH);
  // 1-based screen row where the message pane starts.
  const paneTopRow = statusH + 1;

  const onMessageLayout = useCallback(
    (hits: MessageHitRegion[], ms: number) => {
      hitRegionsRef.current = hits;
      setMaxScroll(ms);
      setScrollOffset((o) => {
        if (stickBottomRef.current) return 0;
        return Math.min(o, ms);
      });
      const drag = transcriptDragRef.current;
      const pointer = transcriptLastMouseRef.current;
      if (drag?.dragging && pointer) {
        const head = nearestHitRegion(hits, pointer.y);
        if (head && head.id !== drag.headId) {
          const next = { ...drag, headId: head.id };
          transcriptDragRef.current = next;
          const selection = {
            anchorId: next.anchorId,
            headId: next.headId,
          };
          transcriptSelectionRef.current = selection;
          setTranscriptSelection(selection);
          setFocusedMsgId(next.headId);
        }
      }
    },
    [],
  );
  const onRightPanelLayout = useCallback((regions: RightPanelHitRegion[]) => {
    rightPanelHitRegionsRef.current = regions;
  }, []);

  // Goal/todo side panel visibility. Hidden when the operator toggled it off
  // (/panel or Esc), when the session browser OR the knowledge-graph panel owns
  // the pane (both are full-pane takeovers, like /resume), or when the terminal
  // is too narrow to keep the transcript legible beside a 30-column panel. The
  // transcript then keeps the full width (paneWidth == contentWidth).
  const panelVisible =
    editionAllowsCommand("panel") &&
    showPanel &&
    !sessionPicker &&
    !showGraph &&
    !showAccessibility &&
    !showPluginManager &&
    !showPlanMode &&
    !showLocalEngine &&
    !modelConnections.open &&
    !showArcCampaign &&
    contentWidth >= GOAL_PANEL_MIN_CONTENT;
  const paneWidth = panelVisible ? contentWidth - GOAL_PANEL_COLS : contentWidth;
  // Root has paddingX=1, so its content begins at terminal column 2. The
  // compact panel begins immediately after the left pane.
  const rightPanelScreenLeft = 2 + paneWidth;
  // Sophia session browser. When the picker is open it replaces the
  // transcript in the message pane (the top status chrome stays mounted). It is
  // deliberately NOT a wholesale full-screen swap: re-rendering a swapped-in
  // full-screen root on every ↑↓ dropped the following keystroke (Ink lost the
  // next input event), so you could open the browser but never resume once you
  // moved. Rendering inside the stable tree keeps navigation input intact.
  // ↑↓/Enter/Esc are handled by the sessionPicker key handler above.
  return (
    <Box flexDirection="column" width={cols} height={rows} paddingX={1}>
      <StatusLine
        theme={theme}
        model={model}
        permission={permission}
        mode={mode}
        session={session}
        running={running && loadH === 0}
        bridgeReady={bridgeReady}
        status={topStatusText}
        epistemic={epistemic}
        width={contentWidth}
        effort={effortLabel(effort)}
        contextUsage={
          contextTelemetry && typeof contextTelemetry.used === "number"
            ? { used: contextTelemetry.used, window: contextTelemetry.window ?? null }
            : null
        }
        throughput={
          runTelemetry && (runTelemetry.tokensPerSec !== undefined || runTelemetry.ttftMs !== undefined)
            ? { tokensPerSec: runTelemetry.tokensPerSec, ttftMs: runTelemetry.ttftMs }
            : null
        }
        agiEnabled={agiStatusOn}
        a2aMode={a2aStatusMode}
        workflowMode={workflowStatusMode}
        showBrand
        showSession={false}
      />

      {activeWorkflowNodes(workflow).length > 0 ? (
        <Box width={contentWidth} paddingX={1}>
          <Text color={theme.accent} wrap="truncate-end">
            Active work:{" "}
            <MatrixText
              text={activeWorkflowNodes(workflow)
                .map((n) => `${n.title || n.name} [${n.state}]`)
                .join(" · ")}
              animateOnMount
              seed={1021}
            />
          </Text>
        </Box>
      ) : null}
      {fileChangeSummary && fileChangeSummary.fileCount > 0 ? (
        // Per-turn file-change headline (tool-call-transparency): the kernel
        // already computes filesTouched/fileChanges every turn and it used to
        // be discarded entirely. The per-tool expandable-output view and
        // per-call cost this same backlog item calls for live inside
        // MessageList's ToolBatchGroup, a file this pass does not own — this
        // headline is the piece reachable from here.
        <Box width={contentWidth} paddingX={1}>
          <Text color={theme.dim} wrap="truncate-end">
            <MatrixText
              text={fileChangeSummary.headline}
              animateOnMount
              seed={1031}
            />
          </Text>
        </Box>
      ) : null}
      {showWorkflow && teamLaneState.lanes.length ? (
        <TeamLanePanel state={teamLaneState} theme={theme} width={contentWidth} />
      ) : null}
      {showWorkflow ? <WorkflowTree theme={theme} state={workflow} width={contentWidth} onToggle={(id) => dispatchWorkflow({ type: "toggle", id })} onSelect={(id) => dispatchWorkflow({ type: "select", id })} /> : null}

      <Box
        flexDirection="row"
        flexGrow={1}
        height={msgMax}
        width={contentWidth}
        overflow="hidden"
      >
        <Box flexDirection="column" height={msgMax} width={paneWidth} overflow="hidden">
          {showPluginManager ? (
            <PluginManagerPanel
              state={pluginManager}
              theme={theme}
              width={paneWidth}
              height={msgMax}
            />
          ) : showPlanMode && planModeState ? (
            <PlanPanel
              state={planModeState}
              model={planModel ?? undefined}
              diff={planModelDiff}
              theme={theme}
              width={paneWidth}
              height={msgMax}
              selectedStep={planCursorRef.current}
              onApprove={handlePlanModelApprove}
              onReject={handlePlanModelReject}
              onSelectStep={handlePlanModelSelectStep}
              onClose={handlePlanModelClose}
            />
          ) : showArcCampaign && arcCampaignPanel ? (
            <Box
              flexDirection="column"
              width={paneWidth}
              height={msgMax}
              paddingX={1}
              overflow="hidden"
            >
              <Box justifyContent="space-between">
                <Text color={theme.accent} bold>ARC campaign operator</Text>
                <Text color={theme.dim}>
                  {arcCampaignPanel.query.kind === "status"
                    ? "ARC2 + ARC3 status"
                    : `${arcContestLabel(arcCampaignPanel.query.contest!)} plan`}
                </Text>
              </Box>
              <Text color={theme.warn} bold wrap="truncate-end">
                [CANDIDATE-ONLY] [SUBMISSION-GATED] read-only · no auto-submit/public-eval/stop
              </Text>
              <Text color={theme.dim} wrap="truncate-end">
                command: {arcCampaignPanel.command}
              </Text>
              <Text color={theme.dim} wrap="truncate-end">
                c copy command · Esc close · a live PID is never treated as success
              </Text>
              <Box height={1} />
              {arcCampaignPanel.phase === "loading" ? (
                <Text color={theme.accent}>Loading bounded JSON view…</Text>
              ) : arcCampaignPanel.phase === "error" ? (
                <>
                  <Text color={theme.error} bold>ARC query failed</Text>
                  <Text color={theme.error} wrap="wrap">{arcCampaignPanel.error}</Text>
                  <Text color={theme.dim} wrap="wrap">
                    No campaign action was taken. Copy the command and run it from a trusted repo checkout if needed.
                  </Text>
                </>
              ) : (
                <Box flexDirection="column">
                  {arcCampaignPanel.views.map((view, viewIndex) => (
                    <Box
                      key={`${view.kind}-${view.contest}`}
                      flexDirection="column"
                      marginTop={viewIndex ? 1 : 0}
                    >
                      {arcCampaignViewLines(view).map((line, lineIndex) => (
                        <Text
                          key={`${view.contest}-${lineIndex}`}
                          color={
                            lineIndex === 0
                              ? theme.accent
                              : line.startsWith("stall:") || line.includes("POLICY INVALID")
                                ? theme.warn
                                : theme.text
                          }
                          bold={lineIndex === 0}
                          wrap="truncate-end"
                        >
                          {line}
                        </Text>
                      ))}
                    </Box>
                  ))}
                  <Box height={1} />
                  <Text color={theme.dim} wrap="truncate-end">
                    Copyable commands:
                  </Text>
                  {arcOperatorCommands().map((command) => (
                    <Text key={command} color={theme.dim} wrap="truncate-end">
                      {command}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          ) : showAccessibility ? (
            <AccessibilityPanel
              capabilities={terminalCapabilities}
              theme={theme}
              width={paneWidth}
              interactive={false}
            />
          ) : showGraph ? (
            // SessionBrowser-style knowledge-graph panel: takes over the
            // transcript pane (like /resume). ↑↓/Enter/Esc are owned by the
            // showGraph key handler above; this component is presentation-only.
            <GraphPanel
              theme={theme}
              state={graph}
              width={paneWidth}
              height={msgMax}
              onToggle={(id) => dispatchGraph({ type: "toggle", id })}
              onSelect={(id) => dispatchGraph({ type: "select", id })}
            />
          ) : showLocalEngine ? (
            // Full-pane local-engine operations view, same takeover pattern as
            // GraphPanel/AccessibilityPanel above. /local opens this AND fires a
            // fresh local_engine_report/adapter_status request; before that first
            // reply lands it still shows its own honest not-probed defaults.
            <LocalEnginePanel
              theme={theme}
              width={paneWidth}
              engines={runtimeSnapshot.engines}
              probed={bridgeReady}
              runtimeReport={localEngineRuntimeReport}
              adapterStatus={localAdapterStatus}
              memoryFitRefusal={memoryFitRefusal}
            />
          ) : modelConnections.open ? (
            <ModelConnectionsPanel
              state={modelConnections}
              theme={theme}
              width={paneWidth}
              height={msgMax}
            />
          ) : sessionPicker ? (
            // Full-pane Sophia session browser: takes over the
            // transcript pane. Input is routed through PromptInput's stable
            // handleInput (onModalInput) + a raw-stdin Enter backup, so it does
            // NOT depend on this component's own re-render — that dependency is
            // what used to drop the keystroke after every ↑↓.
            <SessionBrowser
              theme={theme}
              rows={sessionRows}
              selected={sessionPicker.selected}
              current={session}
              width={paneWidth}
              height={msgMax}
              header={sessionBrowserHeader ?? undefined}
              query={sessionBrowserQuery ?? undefined}
              totalMatches={sessionBrowserTotalMatches}
            />
          ) : rightPanelDetail.open ? (
            rightPanelDetail.section === "flow" ? (
              <SessionFlowPanel
                state={sessionFlowPresentation.state}
                rawNodeCount={sessionFlow.nodes.length}
                metadataByNodeId={sessionFlowPresentation.metadataByNodeId}
                breadcrumbs={sessionFlowPresentation.breadcrumbs}
                liveStatusByNodeId={sessionFlowPresentation.liveStatusByNodeId}
                projectionKey={sessionFlowProjectionKey}
                interaction={sessionFlowInteraction}
                dispatchInteraction={dispatchSessionFlowInteraction}
                scrollOffset={rightPanelDetail.scrollOffset}
                theme={theme}
                width={paneWidth}
                height={msgMax}
                mouseMode={!!props.mouseMode}
                paneTopRow={paneTopRow}
                screenLeft={1}
                onScrollLayout={onRightPanelDetailLayout}
                onGraphLayout={onSessionFlowGraphLayout}
              />
            ) : rightPanelDetail.section === "agi"
              && (
                agiWorkflowMode !== "off"
                || agiWorkflow.active
                || !!agiWorkflow.runId
              ) ? (
              <AGIWorkflowInspector
                state={agiWorkflow}
                mode={agiWorkflowMode}
                scrollOffset={rightPanelDetail.scrollOffset}
                theme={theme}
                width={paneWidth}
                height={msgMax}
                selectedItemId={rightPanelDetail.selectedItemId}
                expandedItemIds={rightPanelDetail.expandedItemIds}
                mouseMode={!!props.mouseMode}
                paneTopRow={paneTopRow}
                screenLeft={1}
                onLayout={onRightPanelDetailLayout}
                onInteractiveLayout={onRightPanelInteractiveLayout}
              />
            ) : (
              <RightPanelDetails
                section={rightPanelDetail.section}
                scrollOffset={rightPanelDetail.scrollOffset}
                theme={theme}
                width={paneWidth}
                height={msgMax}
                goal={goal}
                workflow={workflow}
                todoItems={todo.items}
                a2a={a2a}
                dynamicWorkflow={dynamicWorkflow}
                agi={agi}
                team={teamLaneState}
                progress={progress}
                goalRevision={goal.revision}
                goalUpdatedAt={goal.updatedAt}
                goalSource={goal.source}
                goalHistory={goal.history}
                eta={rightPanelEta}
                selectedItemId={rightPanelDetail.selectedItemId}
                expandedItemIds={rightPanelDetail.expandedItemIds}
                mouseMode={!!props.mouseMode}
                paneTopRow={paneTopRow}
                screenLeft={1}
                onLayout={onRightPanelDetailLayout}
                onInteractiveLayout={onRightPanelInteractiveLayout}
              />
            )
          ) : (
            <MessageList
              theme={theme}
              messages={messages}
              width={paneWidth}
              height={msgMax}
              scrollOffset={scrollOffset}
              focusedId={focusedMsgId}
              paneTopRow={paneTopRow}
              onLayout={onMessageLayout}
              mouseMode={!!props.mouseMode}
              selectedMessageIds={highlightedMessageIds}
            />
          )}
        </Box>
        {panelVisible ? (
          // Persistent right column: the session's current goal (folded from
          // the kernel's goal_* events) over a coarse, self-crossing-out to-do
          // list (the run's task nodes). Mirrors MessageList's content+scrollbar
          // split — a fixed-width flexShrink-0 column beside a flexible pane.
          <GoalTodoPanel
            theme={theme}
            width={GOAL_PANEL_COLS}
            height={msgMax}
            goal={goal}
            goalRevision={goal.revision}
            goalUpdatedAt={goal.updatedAt}
            goalSource={goal.source}
            goalHistory={goal.history}
            eta={rightPanelEta}
            workflow={workflow}
            todoItems={todo.items}
            a2a={a2a}
            dynamicWorkflow={dynamicWorkflow}
            agi={agi}
            agiWorkflow={agiWorkflow}
            agiWorkflowMode={agiWorkflowMode}
            flow={sessionFlowPresentation.state}
            flowRawState={sessionFlow}
            flowMetadataByNodeId={sessionFlowPresentation.metadataByNodeId}
            flowLiveStatusByNodeId={sessionFlowPresentation.liveStatusByNodeId}
            flowBreadcrumbs={sessionFlowPresentation.breadcrumbs}
            flowProjectionKey={sessionFlowProjectionKey}
            flowSelectedId={sessionFlowPanelSelectedId}
            flowViewportSnapshot={sessionFlowViewportSnapshot}
            selectedSection={
              rightPanelDetail.open ? rightPanelDetail.section : null
            }
            paneTopRow={paneTopRow}
            screenLeft={rightPanelScreenLeft}
            onLayout={onRightPanelLayout}
            onFlowMiniMapLayout={onSessionFlowMiniMapLayout}
          />
        ) : null}
      </Box>

      <LoadingIndicator theme={theme} progress={progress} width={contentWidth} />

      {notificationToast ? (
        <NotificationToast
          notification={notificationToast}
          capabilities={terminalCapabilities}
          theme={theme}
          width={contentWidth}
        />
      ) : null}

      {pendingApproval ? (
        <PermissionDialog
          theme={theme}
          tool={pendingApproval.tool}
          preview={pendingApproval.preview}
          width={contentWidth}
          diff={pendingApproval.diff}
          risk={pendingApproval.risk}
          destructive={pendingApproval.destructive}
          onAlwaysAllowTool={
            pendingApproval.kind === "tool" && !pendingApproval.destructive
              ? handleAlwaysAllowTool
              : undefined
          }
        />
      ) : null}

      <Box flexDirection="column" flexShrink={0} width={contentWidth}>
        {activePicker ? (
          <OptionPicker
            theme={theme}
            title={titleFor(activePicker.kind)}
            options={pickerOpts}
            selected={activePicker.selected}
            maxVisible={pickerVisible}
            width={contentWidth}
            filterQuery={pickerFilterQuery}
            current={
              activePicker.kind === "model"
                ? model
                : activePicker.kind === "effort"
                  ? effort
                  : activePicker.kind === "mode"
                    ? mode
                : activePicker.kind === "permission"
                      ? permission
                      : activePicker.kind === "thinking"
                          ? thinkingVisibility
                          : activePicker.kind === "keymap"
                            ? keymap
                            : activePicker.kind === "imageProvider"
                              ? imageProvider
                      : themeName
            }
          />
        ) : null}
        {slashVis ? (
          <SlashSuggest
            theme={theme}
            matches={slashMatches}
            selected={slashSelected}
            filter={input.split(/\s+/)[0] || "/"}
            width={contentWidth}
            maxVisible={slashVisible}
          />
        ) : null}
        <WorkspaceContextLine
          context={workspaceContext}
          session={session}
          theme={theme}
          width={contentWidth}
        />
        <PromptInput
          theme={theme}
          value={input}
          onChange={(value) => {
            inputRef.current = value;
            setInput(value);
          }}
          onSubmit={onSubmit}
          onHistoryPrev={onHistoryPrev}
          onHistoryNext={onHistoryNext}
          onReverseSearch={onReverseSearch}
          keymap={keymap}
          maxVisibleLines={promptVisibleLines}
          ghostHintCandidates={ghostHintCandidates}
          onPasteReviewChange={(review) => {
            setStatus(review ? "paste inserted · review, then press Enter twice to send" : "paste reviewed · Enter sends");
          }}
          disabled={
            !!pendingApproval ||
            !!activePicker ||
            !!sessionPicker ||
            showAccessibility ||
            showPluginManager ||
            showPlanMode ||
            modelConnections.open ||
            showArcCampaign ||
            rightPanelDetail.open
          }
          disabledPlaceholder={
            pendingApproval
              ? "approval required · use the dialog above"
              : sessionPicker
                ? "session browser open · ↑↓ Enter · Esc"
                : activePicker
                  ? "option picker open · ↑↓ Enter · Esc"
                  : showAccessibility
                    ? "accessibility panel open · Esc to close"
                  : showPluginManager
                    ? "plugin manager open · Tab/↑↓/r/p/h/Enter · Esc close"
                  : showPlanMode
                    ? "plan panel open · use the controls above"
                    : modelConnections.open
                      ? "custom endpoint panel open · use the controls above"
                    : showArcCampaign
                      ? "ARC campaign view open · c copy command · Esc close"
                    : rightPanelDetail.open
                      ? "right-panel details open · ↑↓/PgUp/PgDn/Tab · Esc"
                      : undefined
          }
          slashOpen={!activePicker && slashOpen && slashMatches.length > 0}
          onSlashUp={onSlashUp}
          onSlashDown={onSlashDown}
          onSlashTab={onSlashTab}
          onSlashEnterSelect={onSlashEnterSelect}
          onModalInput={
            sessionPicker
              ? handleSessionBrowserInput
              : activePicker
                ? handlePickerInput
                : undefined
          }
          width={contentWidth}
          mouseMode={!!props.mouseMode}
          platform={terminalCapabilities.platform}
        />
        {footerHint ? (
          <Text color={theme.dim} wrap="truncate-end">{footerHint}</Text>
        ) : null}
      </Box>
    </Box>
  );
}
