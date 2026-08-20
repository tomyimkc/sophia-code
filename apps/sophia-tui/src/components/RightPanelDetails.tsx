import React, { useEffect, useMemo } from "react";
import { Box, Text } from "ink";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { accessibleTheme } from "../lib/accessibility.js";
import type { A2AAgent, A2AState } from "../lib/a2aState.js";
import { agiStatusLabel, type AGIState } from "../lib/agiState.js";
import {
  dynamicWorkflowStageProgressLabel,
  dynamicWorkflowStatusLabel,
  formatWorkflowDuration,
  type DynamicWorkflowAgent,
  type DynamicWorkflowState,
} from "../lib/dynamicWorkflowState.js";
import { wrapTextLines } from "../lib/chatLayout.js";
import { goalPhaseGlyph, goalPhaseLabel, type GoalState } from "../lib/goalState.js";
import type { ProgressState } from "../lib/progress.js";
import type {
  RightPanelDetailItemRegion,
  RightPanelSection,
} from "../lib/rightPanelInteraction.js";
import type { TeamLane, TeamLaneState } from "../lib/teamLanes.js";
import type { Theme } from "../lib/theme.js";
import type { TodoItem } from "../lib/todoState.js";
import {
  type WorkflowState,
} from "../lib/workflow.js";
import { laneBudgetSummary, laneLifecycleLabel } from "./TeamLanePanel.js";
import { MatrixDigitsText, MatrixText } from "./MatrixText.js";
import {
  AgentStatusBot,
  agentBotState,
  useAgentBotFrame,
} from "./AgentStatusBot.js";
import {
  formatRightPanelDuration,
  rightPanelEtaLabel,
  type RightPanelEtaSnapshot,
  type RightPanelGoalRevision,
} from "./RightPanelTelemetry.js";

export type RightPanelDetailTone =
  | "heading"
  | "text"
  | "dim"
  | "accent"
  | "success"
  | "warn"
  | "error";

export interface RightPanelDetailRow {
  id: string;
  text: string;
  tone: RightPanelDetailTone;
  bold?: boolean;
  /** Keep prose literal and matrix-decode only independently changing digits. */
  matrixDigitsOnly?: boolean;
  interactiveId?: string;
  parentInteractiveId?: string;
  agentBot?: {
    status: string;
    active: boolean;
  };
}

export interface RightPanelDetailInput {
  section: RightPanelSection;
  goal: GoalState;
  workflow: WorkflowState;
  todoItems: readonly TodoItem[];
  a2a?: A2AState;
  dynamicWorkflow?: DynamicWorkflowState;
  agi?: AGIState;
  team: TeamLaneState;
  progress: ProgressState;
  goalRevision?: number;
  goalUpdatedAt?: string;
  goalSource?: string;
  goalHistory?: readonly RightPanelGoalRevision[];
  eta?: RightPanelEtaSnapshot;
  selectedItemId?: string;
  expandedItemIds?: readonly string[];
}

function row(
  id: string,
  text: string,
  tone: RightPanelDetailTone = "text",
  bold = false,
  matrixDigitsOnly = false,
): RightPanelDetailRow {
  return {
    id,
    text,
    tone,
    bold,
    ...(matrixDigitsOnly ? { matrixDigitsOnly: true } : {}),
  };
}

function agentStatusRow(
  id: string,
  text: string,
  tone: RightPanelDetailTone,
  status: string,
  active = false,
  bold = false,
): RightPanelDetailRow {
  return {
    ...row(id, text, tone, bold),
    agentBot: { status, active },
  };
}

function interactiveGroup(
  interactiveId: string,
  rows: RightPanelDetailRow[],
): RightPanelDetailRow[] {
  return rows.map((item, index) => ({
    ...item,
    ...(index === 0
      ? { interactiveId }
      : { parentInteractiveId: interactiveId }),
  }));
}

function applyProgressiveDisclosure(
  rows: RightPanelDetailRow[],
  input: RightPanelDetailInput,
): RightPanelDetailRow[] {
  // Pure row-builder callers that omit expandedItemIds keep the historical
  // fully expanded output. The interactive TUI always supplies the list and
  // therefore starts with concise summaries.
  if (input.expandedItemIds === undefined) return rows;
  const expanded = new Set(input.expandedItemIds);
  const selected = input.selectedItemId || "";
  return rows.flatMap((item) => {
    if (
      item.parentInteractiveId
      && !expanded.has(item.parentInteractiveId)
    ) {
      return [];
    }
    if (!item.interactiveId) return [item];
    const isExpanded = expanded.has(item.interactiveId);
    const isSelected = item.interactiveId === selected;
    return [{
      ...item,
      text: `${isSelected ? "▸" : " "} ${isExpanded ? "▼" : "▶"} ${item.text}`,
      tone: isSelected && item.tone !== "error" ? "accent" : item.tone,
      bold: item.bold || isSelected,
    }];
  });
}

function detailValue(value: unknown, fallback = "not reported"): string {
  return String(value ?? "").trim() || fallback;
}

function goalRows(input: RightPanelDetailInput): RightPanelDetailRow[] {
  const phase = goalPhaseLabel(input.goal.phase);
  const etaLabel = rightPanelEtaLabel(input.eta);
  const fallbackHistory: RightPanelGoalRevision[] = input.goal.history.map(
    (revision) => ({
        ...revision,
        stage: revision.stage ?? undefined,
        stageCount: revision.stageCount ?? undefined,
      }),
  );
  const history: RightPanelGoalRevision[] = [
    ...(input.goalHistory || fallbackHistory),
  ].sort(
    (left, right) => right.revision - left.revision,
  );
  const latestRevision =
    input.goalRevision
    ?? input.goal.revision
    ?? history[0]?.revision
    ?? 0;
  const goalSource = input.goalSource ?? input.goal.source;
  const goalUpdatedAt = input.goalUpdatedAt ?? input.goal.updatedAt;
  const rows = [
    row("goal-title", "Current goal", "heading", true),
    row(
      "goal-text",
      detailValue(input.goal.text, "No active goal has been reported."),
      input.goal.text ? "text" : "dim",
    ),
    ...(latestRevision || goalSource || goalUpdatedAt
      ? [
          row(
            "goal-revision",
            `Revision: ${latestRevision ? `r${latestRevision}` : "not reported"}${
              goalSource ? ` · ${goalSource}` : ""
            }${goalUpdatedAt ? ` · ${goalUpdatedAt}` : ""}`,
            "dim" as const,
          ),
        ]
      : []),
    row("goal-spacer-1", "", "dim"),
    row(
      "goal-phase",
      `Phase: ${goalPhaseGlyph(input.goal.phase)} ${phase.label || input.goal.phase}`,
      phase.ok === true ? "success" : phase.ok === false ? "warn" : "accent",
    ),
    row(
      "goal-activity",
      `Latest activity: ${detailValue(input.goal.activity)}`,
      input.goal.activity ? "text" : "dim",
    ),
    row(
      "goal-remaining",
      `Remaining: ${detailValue(input.goal.remaining, "nothing currently reported")}`,
      input.goal.remaining ? "text" : "dim",
    ),
    row(
      "goal-status",
      `Status detail: ${detailValue(input.goal.statusDetail)}`,
      input.goal.statusDetail ? "text" : "dim",
    ),
    row(
      "goal-confidence",
      `Confidence: ${
        input.goal.confidence == null
          ? "not reported"
          : input.goal.confidence.toFixed(2)
      }`,
      input.goal.confidence == null ? "dim" : "text",
    ),
  ];
  if (etaLabel) {
    rows.push(
      row(
        "goal-eta",
        `Estimate: ${etaLabel}`,
        input.eta?.status === "waiting"
          ? "warn"
          : input.eta?.status === "active"
            ? "accent"
            : "dim",
        false,
        true,
      ),
    );
    if (
      input.eta?.elapsedSec != null
      || input.eta?.estimatedTotalSec != null
      || input.eta?.confidence
    ) {
      rows.push(
        row(
          "goal-eta-runtime",
          [
            input.eta?.elapsedSec != null
              ? `elapsed ${formatRightPanelDuration(input.eta.elapsedSec)}`
              : "",
            input.eta?.estimatedTotalSec != null
              ? `estimated full run ${formatRightPanelDuration(input.eta.estimatedTotalSec)}`
              : "",
            input.eta?.confidence
              ? `${input.eta.confidence} confidence`
              : "",
          ].filter(Boolean).join(" · "),
          "dim",
          false,
          true,
        ),
      );
    }
    if (input.eta?.basis || input.eta?.updatedAt) {
      rows.push(
        row(
          "goal-eta-basis",
          `Estimate basis: ${detailValue(input.eta?.basis)}${
            input.eta?.updatedAt ? ` · updated ${input.eta.updatedAt}` : ""
          }`,
          "dim",
          false,
          true,
        ),
      );
    }
  }
  if (history.length > 0) {
    rows.push(
      row("goal-history-spacer", "", "dim"),
      row(
        "goal-history-title",
        `Goal revisions · ${history.length}`,
        "heading",
        true,
      ),
      row(
        "goal-history-help",
        "Each revision is a harness-owned objective update; expand to inspect its source and reason.",
        "dim",
      ),
    );
    history.forEach((revision) => {
      const stage =
        revision.stage && (revision.plannedStages || revision.stageCount)
          ? ` · stage ${revision.stage}/${revision.plannedStages || revision.stageCount}`
          : revision.stage
            ? ` · stage ${revision.stage}`
            : "";
      rows.push(
        ...interactiveGroup(`goal-revision:${revision.revision}`, [
          row(
            `goal-history-${revision.revision}`,
            `r${revision.revision}${stage} · ${revision.text}`,
            revision.revision === latestRevision ? "accent" : "text",
            revision.revision === latestRevision,
          ),
          row(
            `goal-history-${revision.revision}-source`,
            `   source: ${detailValue(revision.source)}${
              revision.updatedAt ? ` · ${revision.updatedAt}` : ""
            }`,
            "dim",
          ),
          row(
            `goal-history-${revision.revision}-reason`,
            `   reason: ${detailValue(revision.reason)}`,
            revision.reason ? "text" : "dim",
          ),
        ]),
      );
    });
  }
  return rows;
}

function explicitTodoRows(items: readonly TodoItem[]): RightPanelDetailRow[] {
  return items.flatMap((item, index) => {
    const done = item.status === "completed";
    const failed = item.status === "failed";
    const glyph = item.status === "in_progress" ? "▶" : done ? "✓" : failed ? "✗" : "○";
    const tone: RightPanelDetailTone =
      item.status === "in_progress" ? "accent" : done ? "success" : failed ? "error" : "text";
    return [
      row(`todo-${item.id}`, `${glyph} ${index + 1}. ${item.content}`, tone),
      row(`todo-${item.id}-status`, `   status: ${item.status.replaceAll("_", " ")}`, "dim"),
    ];
  });
}

function todoRows(input: RightPanelDetailInput): RightPanelDetailRow[] {
  const rows = [
    row("todos-title", "Full To-do list", "heading", true),
    row(
      "todos-count",
      input.todoItems.length
        ? `${input.todoItems.length} assigned item${input.todoItems.length === 1 ? "" : "s"}`
        : "0 assigned items",
      "dim",
    ),
    row("todos-spacer", "", "dim"),
  ];
  if (input.todoItems.length > 0) return rows.concat(explicitTodoRows(input.todoItems));
  return rows.concat(row("todos-empty", "No assigned tasks have been reported.", "dim"));
}

function a2aAgentRows(
  agent: A2AAgent,
  index: number,
  input: RightPanelDetailInput,
  groupPrefix = "agent",
): RightPanelDetailRow[] {
  const activeStates = ["spawning", "running", "waiting_input", "auth_required", "verifying", "cancelling"];
  const failedStates = [
    "failed",
    "cancelled",
    "timed_out",
    "lost",
    "needs_reconciliation",
    "skipped",
    "unstarted",
  ];
  const active = agent.active || activeStates.includes(agent.status);
  const terminal = agent.status === "succeeded" || failedStates.includes(agent.status);
  const tone: RightPanelDetailTone = active
    ? "accent"
    : failedStates.includes(agent.status)
      ? "error"
      : agent.status === "succeeded"
        ? "success"
        : terminal
          ? "dim"
          : "text";
  const skills = agent.skills?.length ? agent.skills.join(", ") : "none reported";
  const persona = agent.persona || agent.role || "none reported";
  const tools = agent.allowedTools?.length
    ? agent.allowedTools.join(", ")
    : "none reported";
  const capabilities = agent.capabilities
    ? Object.entries(agent.capabilities)
        .filter(([, value]) => value === true || (value !== false && value != null))
        .map(([key, value]) => value === true ? key : `${key}=${String(value)}`)
        .join(", ")
    : "";
  const tokens = agent.tokenUsage
    ? Object.entries(agent.tokenUsage)
        .map(([key, value]) => `${key}:${value}`)
        .join(" ")
    : "";
  const interfaces = (agent.supportedInterfaces || [])
    .map((item) =>
      [
        item.protocolBinding || "interface",
        item.protocolVersion,
        item.url,
      ].filter(Boolean).join(" · ")
    )
    .filter(Boolean);
  const key = `${groupPrefix}-${agent.id || agent.index}`;
  const rows = [
    agentStatusRow(
      `${key}-title`,
      `${index + 1}. ${agent.name}`,
      tone,
      agent.status,
      active,
      active,
    ),
    row(`${key}-role`, `   role: ${persona}`, "dim"),
    ...(agent.personaName || agent.personaVia
      ? [
          row(
            `${key}-persona-provenance`,
            `   persona: ${agent.personaName || persona} · via ${agent.personaVia || "unknown"}`,
            "dim",
          ),
        ]
      : []),
    row(`${key}-skills`, `   skills: ${skills}`, "dim"),
    ...(agent.skillVia?.length
      ? [row(`${key}-skill-via`, `   skill selection: ${agent.skillVia.join(", ")}`, "dim")]
      : []),
    row(`${key}-tools`, `   native tools: ${tools}`, "dim"),
    ...(agent.toolScopeVia
      ? [row(`${key}-tool-via`, `   tool scope: ${agent.toolScopeVia}`, "dim")]
      : []),
    ...(agent.workflowStage
      ? [row(`${key}-stage`, `   workflow stage: ${agent.workflowStage}`, "dim")]
      : []),
    ...(agent.source || agent.protocol
      ? [
          row(
            `${key}-source`,
            `   source: ${agent.source || "unknown"} · protocol: ${agent.protocol || "unknown"} · ${
              agent.connected === false ? "disconnected" : "connected"
            }`,
            agent.connected === false ? "warn" : "dim",
          ),
        ]
      : []),
    ...(agent.description
      ? [row(`${key}-description`, `   description: ${agent.description}`, "dim")]
      : []),
    ...(agent.version || agent.endpoint
      ? [
          row(
            `${key}-endpoint`,
            `   remote: ${agent.version ? `v${agent.version}` : "version not reported"}${
              agent.endpoint ? ` · ${agent.endpoint}` : ""
            }`,
            "dim",
          ),
        ]
      : []),
    ...(capabilities
      ? [row(`${key}-capabilities`, `   capabilities: ${capabilities}`, "dim")]
      : []),
    ...interfaces.map((item, interfaceIndex) =>
      row(`${key}-interface-${interfaceIndex}`, `   interface: ${item}`, "dim")
    ),
    ...(agent.securitySchemes?.length
      ? [
          row(
            `${key}-security`,
            `   security: ${agent.securitySchemes.join(", ")}`,
            "dim",
          ),
        ]
      : []),
    ...(agent.currentTaskId
      ? [row(`${key}-task-id`, `   task id: ${agent.currentTaskId}`, "dim")]
      : []),
    ...(agent.currentTool
      ? [row(`${key}-tool`, `   current tool: ${agent.currentTool}`, "accent")]
      : []),
    ...(tokens
      ? [row(`${key}-tokens`, `   tokens: ${tokens}`, "dim")]
      : []),
    ...(agent.lastActivityAt
      ? [row(`${key}-last`, `   last activity: ${agent.lastActivityAt}`, "dim")]
      : []),
    row(
      `${key}-summary`,
      `   task/report: ${detailValue(agent.summary)}`,
      agent.summary ? "text" : "dim",
    ),
    ...(agent.failureReason
      ? [
          row(
            `${key}-failure`,
            `   failure: ${agent.failureReason}`,
            "error",
          ),
        ]
      : []),
  ];
  if (active && input.progress.streamPreview) {
    rows.push(
      row(
        `${key}-live`,
        `   observable output preview: ${input.progress.streamPreview}`,
        "accent",
      ),
    );
  } else if (active && input.progress.detail) {
    rows.push(
      row(
        `${key}-activity`,
        `   observable activity: ${input.progress.detail}`,
        "accent",
      ),
    );
  }
  return interactiveGroup(`${groupPrefix}:${agent.id || agent.index}`, rows);
}

function orchestrationTaskRows(input: RightPanelDetailInput): RightPanelDetailRow[] {
  const tasks = input.a2a?.orchestration?.tasks || [];
  if (!tasks.length) return [];
  const agentName = new Map(
    (input.a2a?.orchestration?.agents || []).map((agent) => [
      agent.id,
      agent.name,
    ]),
  );
  return [
    row("a2a-task-board-spacer", "", "dim"),
    row("a2a-task-board-title", `Task board · ${tasks.length}`, "heading", true),
    ...tasks.flatMap((task, index) => {
      const failed = [
        "failed",
        "canceled",
        "cancelled",
        "timed_out",
        "lost",
        "needs_reconciliation",
        "skipped",
        "unstarted",
      ].includes(task.state);
      const active = ["spawning", "working", "running", "waiting_input", "auth_required", "verifying"].includes(task.state);
      const tone: RightPanelDetailTone = failed
        ? "error"
        : active
          ? "accent"
          : task.terminal
            ? "success"
            : task.state === "blocked"
              ? "warn"
              : "text";
      const owner = agentName.get(task.ownerId) || task.ownerId || "unassigned";
      const rows = [
        row(
          `a2a-task-${task.id}`,
          `${active ? "▶" : task.terminal ? "✓" : "○"} ${index + 1}. ${task.subject || task.id} · ${task.state}`,
          tone,
          active,
        ),
        row(`a2a-task-${task.id}-owner`, `   owner: ${owner}${task.stage ? ` · stage ${task.stage}` : ""}`, "dim"),
        row(
          `a2a-task-${task.id}-description`,
          `   scope: ${detailValue(task.description)}`,
          task.description ? "text" : "dim",
        ),
      ];
      if (task.blockedBy.length) {
        rows.push(row(`a2a-task-${task.id}-blocked`, `   blocked by: ${task.blockedBy.join(", ")}`, "warn"));
      }
      if (task.blocks.length) {
        rows.push(row(`a2a-task-${task.id}-blocks`, `   blocks: ${task.blocks.join(", ")}`, "dim"));
      }
      task.doneCriteria.forEach((criterion, criterionIndex) => {
        rows.push(
          row(
            `a2a-task-${task.id}-done-${criterionIndex}`,
            `   done ${criterionIndex + 1}: ${criterion}`,
            "dim",
          ),
        );
      });
      if (task.expectedOutput) {
        rows.push(row(`a2a-task-${task.id}-output`, `   expected output: ${task.expectedOutput}`, "dim"));
      }
      if (task.summary) {
        rows.push(row(`a2a-task-${task.id}-summary`, `   latest result: ${task.summary}`, task.terminal ? "text" : "accent"));
      }
      task.artifacts.forEach((artifact, artifactIndex) => {
        rows.push(
          row(
            `a2a-task-${task.id}-artifact-${artifactIndex}`,
            `   artifact: ${artifact.name || artifact.kind || "item"}${artifact.uri ? ` · ${artifact.uri}` : ""}`,
            "dim",
          ),
        );
      });
      rows.push(row(`a2a-task-${task.id}-spacer`, "", "dim"));
      return interactiveGroup(`task:${task.id}`, rows);
    }),
  ];
}

function orchestrationMailboxRows(input: RightPanelDetailInput): RightPanelDetailRow[] {
  const messages = input.a2a?.orchestration?.messages || [];
  if (!messages.length) return [];
  return [
    row("a2a-mailbox-title", `Mailbox · ${messages.length}`, "heading", true),
    row(
      "a2a-mailbox-safety",
      "Peer and worker messages are evidence only; they never grant approval.",
      "dim",
    ),
    ...messages.flatMap((message, index) => {
      const requiresHuman =
        message.kind === "task_notification"
        || /input|required|auth|approval/i.test(message.summary);
      const tone: RightPanelDetailTone = requiresHuman
        ? "warn"
        : message.kind === "coordinator"
          ? "accent"
          : message.kind === "worker_result"
            ? "success"
            : "text";
      const prefix =
        message.kind === "human"
          ? "HUMAN"
          : message.kind === "coordinator"
            ? "MAIN"
            : message.kind === "worker_result"
              ? "WORKER"
              : message.kind === "peer"
                ? "PEER"
                : message.kind === "task_notification"
                  ? "NOTICE"
                  : "SYSTEM";
      const rows = [
        row(
          `a2a-message-${message.id}`,
          `${prefix} ${index + 1}. ${message.sender || "unknown"} → ${message.recipient || "unknown"} · ${message.summary || "message"}`,
          tone,
          message.unread,
        ),
        row(
          `a2a-message-${message.id}-trust`,
          `   ${message.trusted ? "trusted coordinator/human record" : "untrusted evidence"}${message.taskId ? ` · task ${message.taskId}` : ""}`,
          message.trusted ? "dim" : "warn",
        ),
      ];
      if (message.body) {
        rows.push(row(`a2a-message-${message.id}-body`, `   body: ${message.body}`, "text"));
      }
      message.artifacts.forEach((artifact, artifactIndex) => {
        rows.push(
          row(
            `a2a-message-${message.id}-artifact-${artifactIndex}`,
            `   artifact: ${artifact.name || artifact.kind || "item"}${artifact.uri ? ` · ${artifact.uri}` : ""}`,
            "dim",
          ),
        );
      });
      rows.push(row(`a2a-message-${message.id}-spacer`, "", "dim"));
      return interactiveGroup(`message:${message.id}`, rows);
    }),
  ];
}

function teamLaneRows(lane: TeamLane, index: number): RightPanelDetailRow[] {
  const tone: RightPanelDetailTone =
    lane.lifecycle === "failed"
      ? "error"
      : lane.lifecycle === "abandoned" ||
          lane.lifecycle === "cancelled" ||
          lane.lifecycle === "interrupted"
        ? "warn"
        : lane.lifecycle === "succeeded"
          ? "success"
          : lane.lifecycle === "running" ||
              lane.lifecycle === "starting" ||
              lane.lifecycle === "waiting"
            ? "accent"
            : "text";
  const titleContainsRole =
    Boolean(lane.role) &&
    lane.title.toLocaleLowerCase().includes(
      String(lane.role).toLocaleLowerCase(),
    );
  const identity = titleContainsRole
    ? lane.division
      ? `   division: ${lane.division}`
      : lane.source
        ? `   source: ${lane.source}`
        : ""
    : `   role: ${detailValue(lane.role || "")}`;
  const rows = [
    agentStatusRow(
      `team-${lane.id}-title`,
      `${index + 1}. ${lane.title} · ${laneLifecycleLabel(lane)}`,
      tone,
      lane.lifecycle,
      ["running", "starting"].includes(lane.lifecycle),
      lane.lifecycle === "running",
    ),
    ...(identity
      ? [row(`team-${lane.id}-identity`, identity, "dim")]
      : []),
    ...(lane.skills?.length
      ? [
          row(
            `team-${lane.id}-skills`,
            `   skills: ${lane.skills.join(", ")}`,
            "dim",
          ),
        ]
      : []),
    row(`team-${lane.id}-budget`, `   ${laneBudgetSummary(lane)}`, "dim"),
    row(
      `team-${lane.id}-result`,
      `   result: ${lane.result.state}${
        lane.result.summary ? ` · ${lane.result.summary}` : ""
      }`,
      lane.result.state === "failed" || lane.result.state === "conflict"
        ? "error"
        : "text",
    ),
  ];
  if (lane.detail) {
    rows.push(row(`team-${lane.id}-detail`, `   detail: ${lane.detail}`, "warn"));
  }
  return rows;
}

function agentRows(input: RightPanelDetailInput): RightPanelDetailRow[] {
  const a2aAgents = input.a2a?.enabled ? input.a2a.agents : [];
  const archivedAgents = input.a2a?.enabled
    ? input.a2a.archivedAgents || []
    : [];
  const orchestrationTasks = input.a2a?.orchestration?.tasks || [];
  const orchestrationMessages = input.a2a?.orchestration?.messages || [];
  const lanes = input.team.lanes;
  const rows: RightPanelDetailRow[] = [
    row("agents-title", "Agent activity", "heading", true),
    row(
      "agents-honesty",
      "Shows observable task, tool/lifecycle, output-preview, and report receipts; it does not expose hidden reasoning.",
      "dim",
    ),
  ];

  if (a2aAgents.length > 0) {
    rows.push(
      row("a2a-spacer", "", "dim"),
      row("a2a-title", `A2A dispatch · ${a2aAgents.length} agent${a2aAgents.length === 1 ? "" : "s"}`, "accent", true),
    );
    if (input.a2a?.activeName) {
      rows.push(row("a2a-active", `Active: ${input.a2a.activeName}`, "accent"));
    }
    if (input.a2a?.handoffPreview) {
      rows.push(row("a2a-handoff", `Handoff: ${input.a2a.handoffPreview}`, "dim"));
    }
    if (input.a2a?.dispatchManifest) {
      const manifest = input.a2a.dispatchManifest;
      rows.push(
        row(
          "a2a-dispatch-manifest-status",
          `Live dispatch manifest: ${manifest.status || "unknown"} · ${manifest.phase || "unknown"} · v${manifest.version}`,
          "dim",
        ),
      );
      if (manifest.path) {
        rows.push(
          row(
            "a2a-dispatch-manifest-path",
            `Manifest path: ${manifest.path}`,
            "dim",
          ),
        );
      }
    }
    a2aAgents.forEach((agent, index) => {
      rows.push(...a2aAgentRows(agent, index, input));
      if (index < a2aAgents.length - 1) {
        rows.push(row(`a2a-${agent.index}-spacer`, "", "dim"));
      }
    });
  }
  if (archivedAgents.length > 0) {
    rows.push(
      row("a2a-archived-spacer", "", "dim"),
      row(
        "a2a-archived-title",
        `Prior workflow stages · ${archivedAgents.length} archived agent${archivedAgents.length === 1 ? "" : "s"}`,
        "heading",
        true,
      ),
      row(
        "a2a-archived-help",
        "Completed prior-stage workers are removed from the live roster but remain expandable here and in the flow/task history.",
        "dim",
      ),
    );
    archivedAgents.forEach((agent, index) => {
      rows.push(...a2aAgentRows(agent, index, input, "archived-agent"));
    });
  }
  rows.push(...orchestrationTaskRows(input));
  rows.push(...orchestrationMailboxRows(input));

  if (lanes.length > 0) {
    rows.push(
      row("team-spacer", "", "dim"),
      row("team-title", `Parallel agents · ${lanes.length} lane${lanes.length === 1 ? "" : "s"}`, "accent", true),
    );
    lanes.forEach((lane, index) => {
      rows.push(...teamLaneRows(lane, index));
      if (index < lanes.length - 1) {
        rows.push(row(`team-${lane.id}-spacer`, "", "dim"));
      }
    });
  }

  if (
    a2aAgents.length === 0
    && archivedAgents.length === 0
    && lanes.length === 0
    && orchestrationTasks.length === 0
    && orchestrationMessages.length === 0
  ) {
    rows.push(
      row("agents-empty-spacer", "", "dim"),
      row("agents-empty", "No A2A agents or parallel lanes have been reported.", "dim"),
    );
  }
  return rows;
}

function dynamicWorkflowAgentRows(
  agent: DynamicWorkflowAgent,
  stageIndex: number,
  input: RightPanelDetailInput,
): RightPanelDetailRow[] {
  const active =
    agent.active ||
    ["queued_for_model", "spawning", "running", "waiting_input", "verifying"].includes(
      agent.status,
    );
  const failed = [
    "failed",
    "cancelled",
    "timed_out",
    "lost",
    "needs_reconciliation",
    "skipped",
    "unstarted",
  ].includes(agent.status);
  const tone: RightPanelDetailTone = active
    ? "warn"
    : agent.status === "succeeded"
      ? "success"
      : failed
        ? "error"
        : "dim";
  const key = `dynamic-workflow-${stageIndex}-${agent.index}`;
  const orchestrationAgent = input.a2a?.orchestration?.agents.find(
    (item) =>
      item.name === agent.name
      || (
        item.workflowStage === stageIndex
        && item.index === agent.index
      ),
  );
  const stageTasks = input.a2a?.orchestration?.tasks.filter(
    (item) => item.stage === stageIndex,
  ) || [];
  const task = stageTasks.find(
    (item) =>
      (orchestrationAgent?.id && item.ownerId === orchestrationAgent.id)
      || (orchestrationAgent?.currentTaskId && item.id === orchestrationAgent.currentTaskId)
  ) || stageTasks[agent.index];
  const workerResult = input.a2a?.orchestration?.messages.slice().reverse().find(
    (message) =>
      message.kind === "worker_result"
      && (
        (task?.id && message.taskId === task.id)
        || message.sender === agent.name
      ),
  );
  const generic = (value: string): boolean =>
    ["", "model result", "provider progress", "provider activity", "worker progress"].includes(
      value.trim().toLowerCase(),
    );
  const actionableDetail = [
    task?.summary || "",
    workerResult?.body || "",
    orchestrationAgent?.failureReason || "",
    agent.failureReason || "",
    agent.summary,
  ].find((value) => !generic(value)) || "";
  const titleDetail = failed && actionableDetail
    ? ` · ${actionableDetail.split("\n", 1)[0]}`
    : "";
  const displayProgress =
    failed && generic(agent.progress || "") && actionableDetail
      ? actionableDetail
      : agent.progress || "";
  return interactiveGroup(`workflow-agent:${stageIndex}:${agent.index}`, [
    agentStatusRow(
      `${key}-title`,
      `   ${agent.name}${titleDetail}`,
      tone,
      agent.status,
      active,
      active,
    ),
    row(
      `${key}-role`,
      `      role: ${detailValue(agent.role, "auto-selected")}`,
      "dim",
    ),
    row(
      `${key}-skills`,
      `      skills: ${agent.skills.length ? agent.skills.join(", ") : "auto-selected or none reported"}`,
      "dim",
    ),
    row(
      `${key}-progress`,
      `      progress: ${detailValue(displayProgress, agent.active ? "waiting for worker activity" : "terminal")}`,
      failed ? "error" : agent.active ? "warn" : "dim",
    ),
    row(
      `${key}-summary`,
      `      report: ${detailValue(actionableDetail || agent.summary)}`,
      actionableDetail || agent.summary ? failed ? "error" : "text" : "dim",
    ),
    ...(task
      ? [
          row(
            `${key}-task`,
            `      task: ${task.subject || task.id} · ${task.state}`,
            failed ? "error" : "dim",
          ),
        ]
      : []),
  ]);
}

function dynamicWorkflowRows(
  input: RightPanelDetailInput,
): RightPanelDetailRow[] {
  const workflow = input.dynamicWorkflow;
  if (!workflow) {
    return [
      row("dynamic-workflow-title", "Dynamic Workflow", "heading", true),
      row(
        "dynamic-workflow-empty",
        "No dynamic-workflow controller state has been reported.",
        "dim",
      ),
    ];
  }
  const statusTone: RightPanelDetailTone = workflow.active
    ? "warn"
    : workflow.status === "succeeded"
      ? "success"
      : workflow.status === "failed" ||
          workflow.status === "awaiting_input"
        ? "error"
        : "dim";
  const plannedRaw = Number(
    (workflow as DynamicWorkflowState & { plannedStages?: unknown })
      .plannedStages,
  );
  const plannedStages =
    Number.isFinite(plannedRaw) && plannedRaw >= 1
      ? Math.max(workflow.currentStage, Math.floor(plannedRaw))
      : null;
  const rows: RightPanelDetailRow[] = [
    row(
      "dynamic-workflow-title",
      "Dynamic Workflow · bounded parallel A2A",
      "heading",
      true,
    ),
    row(
      "dynamic-workflow-scope",
      "Main plans each stage, workers run concurrently behind a barrier, then Main reviews before another stage or final synthesis. Observable receipts only; hidden reasoning is not exposed.",
      "dim",
    ),
    row(
      "dynamic-workflow-status",
      `Status: ${dynamicWorkflowStatusLabel(workflow)} · phase: ${workflow.phase}`,
      statusTone,
      workflow.active,
    ),
    row(
      "dynamic-workflow-mode",
      `Configured mode: ${workflow.configuredMode} · selected: ${workflow.selected ? "yes" : "no"} · eligible: ${
        workflow.eligible == null ? "not reported" : workflow.eligible ? "yes" : "no"
      }`,
      "text",
    ),
    row(
      "dynamic-workflow-progress",
      `Progress: stage ${workflow.currentStage}/${plannedStages ?? "?"} planned · agents ${workflow.totalAgents}/${workflow.maxAgents || "?"}`,
      workflow.active ? "accent" : "dim",
    ),
    row(
      "dynamic-workflow-budget",
      `Safety budget: max ${workflow.maxStages || "?"} stages · max ${workflow.maxAgents || "?"} agents`,
      "dim",
    ),
    row(
      "dynamic-workflow-pattern",
      `Current pattern: ${detailValue(workflow.pattern, "adaptive / not selected yet")}`,
      workflow.pattern ? "accent" : "dim",
    ),
    row(
      "dynamic-workflow-safety",
      "Cloud-only routing · parallel A2A required · candidateOnly=true · canClaimAGI=false.",
      "dim",
    ),
  ];
  if (workflow.reason) {
    rows.push(
      row(
        "dynamic-workflow-reason",
        `Routing/review detail: ${workflow.reason}`,
        workflow.status === "failed" || workflow.status === "awaiting_input"
          ? "warn"
          : "text",
      ),
    );
  }
  if (workflow.completion) {
    rows.push(
      row(
        "dynamic-workflow-completion",
        `Run finished: ${workflow.completion.ok ? "succeeded" : "failed"} · ${
          workflow.completion.reason || "reason not reported"
        } · ${workflow.completion.failedSubs}/${workflow.completion.subCount} sub-agents failed${
          workflow.completion.endedAt ? ` · ${workflow.completion.endedAt}` : ""
        }`,
        workflow.completion.ok ? "success" : "error",
        true,
      ),
    );
  }
  if (workflow.stages.length === 0) {
    rows.push(
      row(
        "dynamic-workflow-no-stages",
        "No stage has been dispatched yet.",
        "dim",
      ),
    );
    return rows;
  }
  workflow.stages.forEach((stage) => {
    const terminalCount = stage.agents.filter((agent) =>
      [
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "lost",
        "needs_reconciliation",
        "skipped",
        "unstarted",
      ].includes(agent.status)
    ).length;
    const succeededCount = stage.agents.filter(
      (agent) => agent.status === "succeeded",
    ).length;
    const failedCount = stage.agents.filter((agent) =>
      [
        "failed",
        "cancelled",
        "timed_out",
        "lost",
        "needs_reconciliation",
        "skipped",
        "unstarted",
      ].includes(agent.status)
    ).length;
    const archived =
      stage.index < workflow.currentStage
      && ["succeeded", "failed"].includes(stage.status);
    const stageTone: RightPanelDetailTone =
      stage.status === "failed"
        ? "error"
        : stage.status === "succeeded"
          ? "success"
          : stage.status === "running" || stage.status === "reviewing"
            ? "warn"
            : "dim";
    rows.push(
      row(`dynamic-workflow-stage-${stage.index}-spacer`, "", "dim"),
      row(
        `dynamic-workflow-stage-${stage.index}`,
        `${archived ? "Archived " : ""}Stage ${stage.index} · ${stage.pattern} · ${stage.status}`,
        stageTone,
        stage.index === workflow.currentStage,
      ),
      row(
        `dynamic-workflow-stage-${stage.index}-goal`,
        `   goal: ${detailValue(stage.goal)}`,
        stage.goal ? "text" : "dim",
      ),
      row(
        `dynamic-workflow-stage-${stage.index}-barrier`,
        `   barrier: ${terminalCount}/${stage.agents.length} terminal · ${succeededCount} succeeded · ${failedCount} failed · concurrency ${
          stage.maxConcurrency ?? "not reported"
        } · provider cap ${stage.providerConcurrencyCap ?? "not reported"}`,
        "dim",
      ),
      row(
        `dynamic-workflow-stage-${stage.index}-concurrency`,
        `   scheduling: ${detailValue(stage.concurrencyReason, "provider-safe cap")} · requested ${stage.controllerRequestedTaskCount || stage.total}${
          stage.deferredTaskCount
            ? ` · ${stage.deferredTaskCount} deferred`
            : ""
        }`,
        stage.deferredTaskCount
          ? "warn"
          : failedCount
            ? "error"
            : terminalCount === stage.agents.length
              ? "success"
              : "dim",
      ),
      row(
        `dynamic-workflow-stage-${stage.index}-progress`,
        `   progress: ${dynamicWorkflowStageProgressLabel(stage)}`,
        stage.status === "running" ? "warn" : "dim",
      ),
      row(
        `dynamic-workflow-stage-${stage.index}-timing`,
        `   timing: elapsed ${formatWorkflowDuration(stage.elapsedSec) || "not reported"} · hard deadline ${
          formatWorkflowDuration(stage.hardDeadlineRemainingSec) || "not active"
        }${stage.etaBasis ? ` · ${stage.etaBasis}` : ""}`,
        "dim",
      ),
    );
    if (archived) {
      rows.push(
        row(
          `dynamic-workflow-stage-${stage.index}-archived`,
          "   archived from the live Agents roster; expand workers below or inspect Task board / Flow for retained history.",
          "dim",
        ),
      );
    }
    stage.agents.forEach((agent) => {
      rows.push(...dynamicWorkflowAgentRows(agent, stage.index, input));
    });
  });
  return rows;
}

function agiRows(input: RightPanelDetailInput): RightPanelDetailRow[] {
  const agi = input.agi;
  if (!agi) {
    return [
      row("agi-title", "AGI mode", "heading", true),
      row("agi-empty", "No AGI-mode controller state has been reported.", "dim"),
    ];
  }
  const terminalTone: RightPanelDetailTone =
    agi.status === "achieved"
      ? "success"
      : agi.status === "failed" || agi.status === "unachievable"
        ? "error"
        : agi.status === "paused" ||
            agi.status === "awaiting_input" ||
            agi.status === "bound_hit" ||
            agi.status === "candidate_complete"
          ? "warn"
          : agi.active
            ? "accent"
            : "dim";
  const rows = [
    row("agi-title", "AGI Mode · experimental controller", "heading", true),
    row(
      "agi-scope",
      "Adaptive, verifier-gated A2A-derived control loop; candidateOnly and canClaimAGI=false.",
      "dim",
    ),
    row("agi-status", `Status: ${agiStatusLabel(agi.status)}`, terminalTone, agi.active),
    row(
      "agi-profile",
      `Profile/route: ${agi.profile} · ${agi.route}${
        agi.routeReason ? ` · ${agi.routeReason}` : ""
      }`,
      agi.route === "critical" ? "warn" : "text",
    ),
    row(
      "agi-cycle",
      `Cycle: ${agi.cycle}/${agi.maxCycles} · phase: ${detailValue(agi.phase, "idle")}`,
      agi.active ? "accent" : "text",
    ),
    row(
      "agi-budget",
      `Budgets: ${agi.wallClockSec}s wall clock · ${agi.maxStepsPerAction} tool steps/action`,
      "dim",
    ),
    row("agi-role", `Role/model: ${detailValue([agi.role, agi.model].filter(Boolean).join(" · "))}`, "dim"),
    row("agi-run", `Run: ${detailValue(agi.runId)}`, agi.runId ? "dim" : "text"),
  ];
  if (agi.totalCriteria > 0) {
    rows.push(
      row(
        "agi-criteria",
        `Criteria: ${agi.verifiedCriteria}/${agi.totalCriteria} verified`,
        agi.verifiedCriteria === agi.totalCriteria ? "success" : "warn",
      ),
    );
    if (agi.failedCriteria.length > 0) {
      rows.push(
        row("agi-criteria-failed", `Failed: ${agi.failedCriteria.join(", ")}`, "error"),
      );
    }
    if (agi.unknownCriteria.length > 0) {
      rows.push(
        row("agi-criteria-unknown", `Unknown: ${agi.unknownCriteria.join(", ")}`, "warn"),
      );
    }
    if (agi.blockedCriteria.length > 0) {
      rows.push(
        row("agi-criteria-blocked", `Blocked: ${agi.blockedCriteria.join(", ")}`, "warn"),
      );
    }
    if (agi.currentGapId) {
      rows.push(row("agi-current-gap", `Current gap: ${agi.currentGapId}`, "accent", true));
    }
  }
  if (agi.goal) rows.push(row("agi-goal", `Goal: ${agi.goal}`, "text"));
  if (agi.strategy) rows.push(row("agi-strategy", `Strategy: ${agi.strategy}`, "accent"));
  if (agi.action) {
    rows.push(
      row(
        "agi-action",
        `Action: ${agi.actionClass || "unclassified"} · ${agi.action}`,
        "text",
      ),
    );
  }
  if (agi.actionId) rows.push(row("agi-action-id", `Action ID: ${agi.actionId}`, "dim"));
  if (agi.risk != null || agi.uncertainty != null || agi.reversibility != null) {
    rows.push(
      row(
        "agi-action-scores",
        `Risk/reversibility/uncertainty: ${
          agi.risk?.toFixed(2) ?? "n/a"
        } / ${agi.reversibility?.toFixed(2) ?? "n/a"} / ${
          agi.uncertainty?.toFixed(2) ?? "n/a"
        }`,
        agi.risk != null && agi.risk >= 0.5 ? "warn" : "dim",
      ),
    );
  }
  if (agi.authorizationRequired) {
    rows.push(
      row(
        "agi-authorization",
        agi.authorizationGranted
          ? "Pre-action authorization: granted for this bounded action"
          : "Pre-action authorization: required · use /agi approve after review",
        agi.authorizationGranted ? "success" : "warn",
        !agi.authorizationGranted,
      ),
    );
  }
  if (agi.prediction) rows.push(row("agi-prediction", `Prediction: ${agi.prediction}`, "dim"));
  if (agi.observation) rows.push(row("agi-observation", `Observation: ${agi.observation}`, "text"));
  if (agi.expectationStatus) {
    rows.push(
      row(
        "agi-expectations",
        `Expected observations: ${agi.expectationStatus}`,
        agi.expectationStatus === "passed"
          ? "success"
          : agi.expectationStatus === "failed"
            ? "error"
            : "warn",
      ),
    );
  }
  if (agi.discrepancy) rows.push(row("agi-discrepancy", `Discrepancy: ${agi.discrepancy}`, "warn"));
  if (agi.correctionAction) {
    rows.push(
      row(
        "agi-correction",
        `Correction: ${agi.correctionAction} · mutations require a new gated action contract`,
        agi.correctionAction === "continue" ? "dim" : "warn",
      ),
    );
  }
  if (agi.verificationStatus || agi.verificationReason) {
    rows.push(
      row(
        "agi-verification",
        `Verification: ${detailValue(agi.verificationStatus)}${
          agi.confidence == null ? "" : ` · ${agi.confidence.toFixed(2)}`
        }${agi.verificationReason ? ` · ${agi.verificationReason}` : ""}`,
        agi.verificationStatus === "achieved" ? "success" : "warn",
      ),
    );
  }
  rows.push(
    row(
      "agi-independence",
      agi.sameModelVerifier
        ? "Verifier: same model · semantic completion alone is candidate_complete"
        : agi.verifierIndependent
          ? "Verifier: independently configured model"
          : "Verifier independence: not yet reported",
      agi.sameModelVerifier ? "warn" : "dim",
    ),
    row(
      "agi-evidence",
      `Deterministic completion receipt: ${agi.deterministicEvidence ? "present" : "not present"}`,
      agi.deterministicEvidence ? "success" : "dim",
    ),
  );
  if (agi.reason) rows.push(row("agi-reason", `Terminal detail: ${agi.reason}`, terminalTone));
  if (agi.statePath) rows.push(row("agi-state-path", `Durable state: ${agi.statePath}`, "dim"));
  if (agi.candidatePath) rows.push(row("agi-candidate", `Update candidate: ${agi.candidatePath}`, "dim"));
  return rows;
}

export function buildRightPanelDetailRows(
  input: RightPanelDetailInput,
): RightPanelDetailRow[] {
  let rows: RightPanelDetailRow[];
  if (input.section === "goal") rows = goalRows(input);
  else if (input.section === "todos") rows = todoRows(input);
  else if (input.section === "workflow") rows = dynamicWorkflowRows(input);
  else if (input.section === "agi") rows = agiRows(input);
  else if (input.section === "flow") {
    rows = [
      row("flow-title", "Session Flow", "heading", true),
      row(
        "flow-owned-view",
        "The Flow section is rendered by the dedicated live graph panel.",
        "dim",
      ),
    ];
  } else {
    rows = agentRows(input);
  }
  return applyProgressiveDisclosure(rows, input);
}

interface VisualDetailRow extends RightPanelDetailRow {
  visualId: string;
}

export function wrapRightPanelDetailRows(
  rows: readonly RightPanelDetailRow[],
  width: number,
): VisualDetailRow[] {
  const columns = Math.max(1, width);
  return rows.flatMap((item) =>
    wrapTextLines(
      item.text,
      Math.max(1, columns - (item.agentBot ? 13 : 0)),
    ).map((text, index) => ({
      ...item,
      text,
      visualId: `${item.id}:${index}`,
      agentBot: index === 0 ? item.agentBot : undefined,
    })),
  );
}

function toneColor(tone: RightPanelDetailTone, theme: Theme): string {
  if (tone === "heading" || tone === "accent") return theme.accent;
  if (tone === "dim") return theme.dim;
  if (tone === "success") return theme.success;
  if (tone === "warn") return theme.warn;
  if (tone === "error") return theme.error;
  return theme.text;
}

const SECTION_LABELS: Record<RightPanelSection, string> = {
  goal: "Goal",
  agents: "Agents",
  todos: "To-do",
  workflow: "Workflow",
  agi: "AGI",
  flow: "Flow",
};

export function RightPanelDetails({
  section,
  scrollOffset,
  theme,
  width,
  height,
  goal,
  goalRevision,
  goalUpdatedAt,
  goalSource,
  goalHistory,
  eta,
  workflow,
  todoItems,
  a2a,
  dynamicWorkflow,
  agi,
  team,
  progress,
  selectedItemId,
  expandedItemIds,
  mouseMode = false,
  paneTopRow = 1,
  screenLeft = 1,
  onLayout,
  onInteractiveLayout,
}: RightPanelDetailInput & {
  scrollOffset: number;
  theme: Theme;
  width: number;
  height: number;
  mouseMode?: boolean;
  paneTopRow?: number;
  screenLeft?: number;
  onLayout?: (maxScroll: number) => void;
  onInteractiveLayout?: (
    itemIds: string[],
    regions: RightPanelDetailItemRegion[],
  ) => void;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const borderRows = ax.screenReader ? 0 : 2;
  const innerWidth = Math.max(8, width - (ax.screenReader ? 0 : 4));
  const viewportRows = Math.max(1, height - borderRows - 3);
  const logicalRows = useMemo(
    () =>
      buildRightPanelDetailRows({
        section,
        goal,
        goalRevision,
        goalUpdatedAt,
        goalSource,
        goalHistory,
        eta,
        workflow,
        todoItems,
        a2a,
        dynamicWorkflow,
        agi,
        team,
        progress,
        selectedItemId,
        expandedItemIds,
      }),
    [
      section,
      goal,
      goalRevision,
      goalUpdatedAt,
      goalSource,
      goalHistory,
      eta,
      workflow,
      todoItems,
      a2a,
      dynamicWorkflow,
      agi,
      team,
      progress,
      selectedItemId,
      expandedItemIds,
    ],
  );
  const visualRows = useMemo(
    () => wrapRightPanelDetailRows(logicalRows, innerWidth),
    [logicalRows, innerWidth],
  );
  const maxScroll = Math.max(0, visualRows.length - viewportRows);
  const safeOffset = Math.max(0, Math.min(maxScroll, scrollOffset));
  const visible = visualRows.slice(safeOffset, safeOffset + viewportRows);
  const animateBots = visible.some((item) => {
    if (!item.agentBot) return false;
    return ["working", "waiting", "queued"].includes(
      agentBotState(item.agentBot.status, item.agentBot.active),
    );
  });
  const agentBotFrame = useAgentBotFrame(animateBots);
  const seenVisualRowIdsRef = React.useRef<Set<string>>(
    new Set(visualRows.map((item) => item.visualId)),
  );
  const newVisualRowIds = new Set(
    visualRows
      .filter((item) => !seenVisualRowIdsRef.current.has(item.visualId))
      .map((item) => item.visualId),
  );
  useEffect(() => {
    for (const item of visualRows) {
      seenVisualRowIdsRef.current.add(item.visualId);
    }
  }, [visualRows]);
  const itemIds = useMemo(
    () =>
      logicalRows
        .map((item) => item.interactiveId || "")
        .filter(Boolean),
    [logicalRows],
  );
  const interactiveRegions = useMemo(() => {
    const byId = new Map<string, RightPanelDetailItemRegion>();
    visible.forEach((item, index) => {
      if (!item.interactiveId) return;
      const screenRow = paneTopRow + (ax.screenReader ? 2 : 3) + index;
      const existing = byId.get(item.interactiveId);
      if (existing) {
        existing.screenEndRow = screenRow;
      } else {
        byId.set(item.interactiveId, {
          id: item.interactiveId,
          screenRow,
          screenEndRow: screenRow,
          screenLeft,
          screenRight: screenLeft + width - 1,
        });
      }
    });
    return [...byId.values()];
  }, [
    visible,
    paneTopRow,
    ax.screenReader,
    screenLeft,
    width,
  ]);

  useEffect(() => {
    onLayout?.(maxScroll);
  }, [maxScroll, onLayout]);
  useEffect(() => {
    onInteractiveLayout?.(itemIds, interactiveRegions);
  }, [itemIds, interactiveRegions, onInteractiveLayout]);

  return (
    <Box
      position="relative"
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={ax.screenReader ? undefined : "round"}
      borderColor={t.accent}
      paddingX={ax.screenReader ? 0 : 1}
      overflow="hidden"
    >
      <Box
        position="relative"
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
      >
      <Text color={t.accent} bold wrap="truncate-end">
        {SECTION_LABELS[section]} details · g/a/t/w/i/f or 1/2/3/4/5/6 · Tab sections · Esc close
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        ↑↓ line · n/p item · Enter/Space expand · PgUp/PgDn page
        {mouseMode ? " · click/wheel" : ""} · Home/End
      </Text>
      {visible.map((item, index) => (
        <Text
          key={item.visualId}
          color={toneColor(item.tone, t)}
          bold={item.bold}
          wrap="truncate-end"
        >
          {item.agentBot ? (
            <>
              <AgentStatusBot
                status={item.agentBot.status}
                active={item.agentBot.active}
                theme={t}
                frame={agentBotFrame}
              />
              {" "}
            </>
          ) : null}
          {item.matrixDigitsOnly ? (
            <MatrixDigitsText
              text={item.text || " "}
              animateOnMount={newVisualRowIds.has(item.visualId)}
              seed={index * 97 + safeOffset}
            />
          ) : (
            <MatrixText
              text={item.text || " "}
              animateOnMount={newVisualRowIds.has(item.visualId)}
              seed={index * 97 + safeOffset}
            />
          )}
        </Text>
      ))}
      <Text color={t.dim} wrap="truncate-end">
        {visualRows.length === 0
          ? "No detail rows."
          : `${safeOffset + 1}-${Math.min(visualRows.length, safeOffset + viewportRows)} of ${visualRows.length}${
              maxScroll > 0 ? ` · scroll ${safeOffset}/${maxScroll}` : ""
            }`}
      </Text>
      </Box>
    </Box>
  );
}
