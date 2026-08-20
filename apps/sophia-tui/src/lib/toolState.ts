import type { ChatMessage } from "./types.js";
import {
  formatToolArgs,
  normalizeToolArtifacts,
  sanitizeToolText,
  type ToolArtifact,
} from "./toolOutput.js";

export type ToolStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";

export type ToolRisk = "unknown" | "low" | "medium" | "high" | "critical";

export interface ToolCallState {
  /** Stable across call/result rows; explicit bridge IDs win, call-row ID is the fallback. */
  stableId: string;
  name: string;
  status: ToolStatus;
  risk: ToolRisk;
  args?: unknown;
  cwd?: string;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  output?: string;
  diff?: string;
  artifacts: ToolArtifact[];
  batchId: string;
  sourceMessageIds: string[];
  callMessageId?: string;
  resultMessageId?: string;
}

export interface ToolBatch {
  id: string;
  parallel: boolean;
  tools: ToolCallState[];
}

export type ToolTimelineItem =
  | { kind: "message"; id: string; message: ChatMessage }
  | { kind: "tool_batch"; id: string; batch: ToolBatch };

export type ApprovalDecision = "allow" | "deny";

export type ApprovalScope =
  | { kind: "call"; callId: string }
  | { kind: "tool"; tool: string; sessionOnly: true }
  | { kind: "cwd"; cwd: string; sessionOnly: true }
  | { kind: "session"; sessionId?: string };

export interface ApprovalChoice {
  id: string;
  key: string;
  label: string;
  decision: ApprovalDecision;
  scope: ApprovalScope;
  description: string;
}

export interface PermissionRequest {
  id: string;
  tool: string;
  preview: string;
  args?: unknown;
  cwd?: string;
  risk: ToolRisk;
  reason?: string;
}

interface ToolMessageEvent {
  message: ChatMessage;
  kind: "call" | "result";
  explicitStableId: string;
  explicitBatchId: string;
  name: string;
  status: ToolStatus;
  risk: ToolRisk;
  args?: unknown;
  cwd?: string;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  output?: string;
  diff?: string;
  artifacts: ToolArtifact[];
}

function record(message: ChatMessage): Record<string, unknown> {
  return message as unknown as Record<string, unknown>;
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstDefined(rows: readonly Record<string, unknown>[], keys: readonly string[]): unknown {
  for (const row of rows) {
    for (const key of keys) {
      if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
    }
  }
  return undefined;
}

function safeIdentifier(value: unknown, fallback = ""): string {
  const safe = sanitizeToolText(value, false, 256).trim();
  return safe || fallback;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function timestamp(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined) return numeric;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseArgsText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizeStatus(value: unknown, fallback: ToolStatus): ToolStatus {
  const status = String(value ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["queued", "pending"].includes(status)) return "queued";
  if (["running", "started", "in_progress", "calling"].includes(status)) return "running";
  if (["awaiting_approval", "approval", "blocked_for_approval"].includes(status)) return "awaiting_approval";
  if (["succeeded", "success", "completed", "complete", "ok"].includes(status)) return "succeeded";
  if (["failed", "failure", "error"].includes(status)) return "failed";
  if (["denied", "rejected"].includes(status)) return "denied";
  if (["cancelled", "canceled", "aborted"].includes(status)) return "cancelled";
  return fallback;
}

function normalizeRisk(value: unknown): ToolRisk | null {
  const risk = String(value ?? "").toLowerCase();
  if (risk === "critical" || risk === "severe") return "critical";
  if (risk === "high" || risk === "dangerous") return "high";
  if (risk === "medium" || risk === "moderate") return "medium";
  if (risk === "low" || risk === "safe") return "low";
  if (risk === "unknown" || risk === "unclassified") return "unknown";
  return null;
}

export function inferToolRisk(name: string, args?: unknown): ToolRisk {
  const tool = name.toLowerCase().replace(/[_-]+/g, " ");
  const detail = formatToolArgs(args, 2_000).toLowerCase();
  const joined = `${tool} ${detail}`;

  if (
    /\brm\s+-rf\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b/.test(
      joined,
    )
  ) return "critical";
  if (
    /\b(delete|destroy|terminate|force[-_ ]?push|deploy|publish|release|chmod|chown)\b/.test(joined) ||
    /\bcurl\b[^|]{0,200}\|\s*(?:sh|bash|zsh)\b/.test(joined)
  ) return "high";
  if (
    /\b(exec|shell|bash|command|write|edit|patch|move|rename|commit|push|approve|install)\b/.test(joined)
  ) return "medium";
  if (/\b(read|list|find|search|view|open|inspect|status|diff)\b/.test(joined)) return "low";
  return "unknown";
}

/** Structural adapter: enriched future messages and today's ChatMessage both work. */
export function adaptChatMessageToToolEvent(message: ChatMessage): ToolMessageEvent | null {
  if (message.role !== "tool") return null;
  const raw = record(message);
  const toolData = nestedRecord(raw.toolState ?? raw.tool ?? raw.data);
  const timing = nestedRecord(toolData.timing ?? raw.timing);
  const rows = [toolData, raw];
  const explicitStatus = firstDefined(rows, ["status", "state", "phase"]);
  const explicitKind = String(firstDefined(rows, ["event", "eventType", "toolEvent", "kind"]) ?? "").toLowerCase();
  const kind: "call" | "result" =
    explicitKind.includes("result") ||
    explicitKind.includes("output") ||
    ["succeeded", "failed", "denied", "cancelled", "canceled"].includes(String(explicitStatus ?? "").toLowerCase()) ||
    message.ok !== undefined
      ? "result"
      : "call";
  const name = safeIdentifier(
    firstDefined(rows, ["name", "toolName", "tool_name"]) ??
      (typeof raw.tool === "string" ? raw.tool : undefined) ??
      message.meta,
    "(empty)",
  );
  const argsValue = firstDefined(rows, ["args", "arguments", "input"]);
  const args = argsValue !== undefined
    ? argsValue
    : kind === "call" && message.text
      ? parseArgsText(message.text)
      : undefined;
  const cwd = safeIdentifier(
    firstDefined(rows, ["cwd", "workdir", "workingDirectory"]) ??
      (args && typeof args === "object" ? firstDefined([args as Record<string, unknown>], ["cwd", "workdir"]) : undefined),
  );
  const outputValue = firstDefined(rows, ["output", "result", "stdout", "stderr"]);
  const output = outputValue !== undefined
    ? String(outputValue)
    : kind === "result"
      ? message.text
      : undefined;
  const diffValue = firstDefined(rows, ["diff", "patch"]);
  const startedAt = timestamp(firstDefined([timing, toolData, raw], ["startedAt", "started_at", "startTime"]));
  const endedAt = timestamp(firstDefined([timing, toolData, raw], ["endedAt", "ended_at", "endTime"]));
  const declaredDuration = finiteNumber(
    firstDefined([timing, toolData, raw], ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms"]),
  );
  const durationMs =
    declaredDuration ??
    (startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
      ? endedAt - startedAt
      : undefined);
  const fallbackStatus: ToolStatus =
    kind === "call"
      ? name === "(empty)" || message.ok === false
        ? "failed"
        : "running"
      : message.ok === false
        ? "failed"
        : "succeeded";
  const risk =
    normalizeRisk(firstDefined(rows, ["risk", "riskLevel", "risk_level"])) ??
    inferToolRisk(name, args);

  return {
    message,
    kind,
    explicitStableId: safeIdentifier(firstDefined(rows, [
      "toolCallId",
      "tool_call_id",
      "callId",
      "call_id",
      "correlationId",
      "correlation_id",
      "requestId",
      "request_id",
    ])),
    explicitBatchId: safeIdentifier(firstDefined(rows, [
      "batchId",
      "batch_id",
      "parallelGroupId",
      "parallel_group_id",
      "groupId",
      "group_id",
    ])),
    name,
    status: normalizeStatus(explicitStatus, fallbackStatus),
    risk,
    ...(args !== undefined ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(diffValue !== undefined ? { diff: String(diffValue) } : {}),
    artifacts: normalizeToolArtifacts(firstDefined(rows, ["artifacts", "files", "attachments"])),
  };
}

function mergeArtifacts(left: ToolArtifact[], right: ToolArtifact[]): ToolArtifact[] {
  const seen = new Set<string>();
  const out: ToolArtifact[] = [];
  for (const artifact of [...left, ...right]) {
    const key = `${artifact.kind}:${artifact.path || artifact.uri || artifact.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(artifact);
  }
  return out.slice(0, 8);
}

function updateState(state: ToolCallState, event: ToolMessageEvent, batchId: string): void {
  state.name = event.name !== "(empty)" ? event.name : state.name;
  state.status = event.status;
  state.risk = event.risk !== "unknown" ? event.risk : state.risk;
  state.batchId = state.batchId || batchId;
  if (event.args !== undefined) state.args = event.args;
  if (event.cwd) state.cwd = event.cwd;
  if (event.durationMs !== undefined) state.durationMs = event.durationMs;
  if (event.startedAt !== undefined) state.startedAt = event.startedAt;
  if (event.endedAt !== undefined) state.endedAt = event.endedAt;
  if (event.output !== undefined) state.output = event.output;
  if (event.diff !== undefined) state.diff = event.diff;
  state.artifacts = mergeArtifacts(state.artifacts, event.artifacts);
  if (!state.sourceMessageIds.includes(event.message.id)) state.sourceMessageIds.push(event.message.id);
  if (event.kind === "call") state.callMessageId = event.message.id;
  else state.resultMessageId = event.message.id;
}

function removePending(queue: string[] | undefined, stableId: string): void {
  if (!queue) return;
  const index = queue.indexOf(stableId);
  if (index >= 0) queue.splice(index, 1);
}

/**
 * Fold call/result ChatMessage rows into stable-ID cards and parallel batches.
 *
 * Explicit call IDs give exact correlation. The legacy App.tsx path does not
 * preserve those IDs, so the compatibility adapter uses a per-tool FIFO:
 * current `tool_call` rows have `ok === undefined`, current `tool_result` rows
 * have a boolean `ok`, and repeated/parallel calls remain deterministic.
 */
export function projectToolTimeline(messages: readonly ChatMessage[]): ToolTimelineItem[] {
  const states = new Map<string, ToolCallState>();
  const pendingByName = new Map<string, string[]>();
  const firstPosition = new Map<string, number>();
  let implicitBatch = "";
  let implicitBatchCounter = 0;
  let previousWasCall = false;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const event = adaptChatMessageToToolEvent(message);
    if (!event) {
      previousWasCall = false;
      implicitBatch = "";
      continue;
    }

    if (event.kind === "call") {
      if (!previousWasCall || !implicitBatch) {
        implicitBatchCounter += 1;
        implicitBatch = `batch:${message.id}:${implicitBatchCounter}`;
      }
      const stableId = event.explicitStableId || `tool:${message.id}`;
      const batchId = event.explicitBatchId || implicitBatch;
      let state = states.get(stableId);
      if (!state) {
        state = {
          stableId,
          name: event.name,
          status: event.status,
          risk: event.risk,
          artifacts: [],
          batchId,
          sourceMessageIds: [],
        };
        states.set(stableId, state);
        firstPosition.set(stableId, index);
      }
      updateState(state, event, batchId);
      const queue = pendingByName.get(event.name) ?? [];
      if (!queue.includes(stableId)) queue.push(stableId);
      pendingByName.set(event.name, queue);
      previousWasCall = true;
      continue;
    }

    previousWasCall = false;
    implicitBatch = "";
    const queue = pendingByName.get(event.name);
    const correlatedId =
      (event.explicitStableId && states.has(event.explicitStableId) ? event.explicitStableId : "") ||
      queue?.[0] ||
      event.explicitStableId ||
      `tool:${message.id}`;
    let state = states.get(correlatedId);
    if (!state) {
      const batchId = event.explicitBatchId || `batch:${message.id}:result`;
      state = {
        stableId: correlatedId,
        name: event.name,
        status: event.status,
        risk: event.risk,
        artifacts: [],
        batchId,
        sourceMessageIds: [],
      };
      states.set(correlatedId, state);
      firstPosition.set(correlatedId, index);
    }
    updateState(state, event, event.explicitBatchId || state.batchId);
    removePending(queue, correlatedId);
  }

  const batches = new Map<string, ToolBatch>();
  const batchPosition = new Map<string, number>();
  for (const state of states.values()) {
    const batch = batches.get(state.batchId) ?? {
      id: state.batchId,
      parallel: false,
      tools: [],
    };
    batch.tools.push(state);
    batches.set(state.batchId, batch);
    const position = firstPosition.get(state.stableId) ?? messages.length;
    batchPosition.set(state.batchId, Math.min(batchPosition.get(state.batchId) ?? position, position));
  }
  for (const batch of batches.values()) {
    batch.tools.sort(
      (a, b) => (firstPosition.get(a.stableId) ?? 0) - (firstPosition.get(b.stableId) ?? 0),
    );
    batch.parallel = batch.tools.length > 1;
  }

  const batchesAt = new Map<number, ToolBatch[]>();
  for (const batch of batches.values()) {
    const position = batchPosition.get(batch.id) ?? messages.length;
    const at = batchesAt.get(position) ?? [];
    at.push(batch);
    batchesAt.set(position, at);
  }

  const items: ToolTimelineItem[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const here = batchesAt.get(index);
    if (here) {
      for (const batch of here.sort((a, b) => a.id.localeCompare(b.id))) {
        items.push({ kind: "tool_batch", id: batch.id, batch });
      }
    }
    const message = messages[index];
    if (message.role !== "tool") {
      items.push({ kind: "message", id: message.id, message });
    }
  }
  return items;
}

export function approvalRequestFromLegacy(args: {
  id?: string;
  tool: string;
  preview: string;
  cwd?: string;
  risk?: ToolRisk;
}): PermissionRequest {
  const parsed = parseArgsText(args.preview);
  const parsedRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const cwd = safeIdentifier(args.cwd ?? parsedRecord.cwd ?? parsedRecord.workdir);
  const tool = safeIdentifier(args.tool, "tool");
  return {
    id: safeIdentifier(args.id, "legacy-approval"),
    tool,
    preview: String(args.preview ?? ""),
    ...(parsed !== "" ? { args: parsed } : {}),
    ...(cwd ? { cwd } : {}),
    risk: args.risk ?? inferToolRisk(tool, parsed),
  };
}

/** The choices today's App.tsx can actually submit: y/n, both call-scoped. */
export function legacyApprovalChoices(request: PermissionRequest): ApprovalChoice[] {
  return [
    {
      id: "allow-once",
      key: "y",
      label: "allow once",
      decision: "allow",
      scope: { kind: "call", callId: request.id },
      description: "Allow only this tool call.",
    },
    {
      id: "deny-once",
      key: "n",
      label: "deny",
      decision: "deny",
      scope: { kind: "call", callId: request.id },
      description: "Deny this tool call.",
    },
  ];
}

/**
 * Typed foundations for a future picker/bridge that can submit scoped grants.
 * PermissionDialog accepts these today, but defaults to legacyApprovalChoices
 * so it never advertises keys App.tsx does not yet handle.
 */
export function scopedApprovalChoices(request: PermissionRequest): ApprovalChoice[] {
  const choices = legacyApprovalChoices(request);
  choices.splice(1, 0, {
    id: "allow-tool-session",
    key: "t",
    label: "allow tool for session",
    decision: "allow",
    scope: { kind: "tool", tool: request.tool, sessionOnly: true },
    description: `Allow ${request.tool} for the current session.`,
  });
  if (request.cwd) {
    choices.splice(2, 0, {
      id: "allow-cwd-session",
      key: "w",
      label: "allow in cwd for session",
      decision: "allow",
      scope: { kind: "cwd", cwd: request.cwd, sessionOnly: true },
      description: `Allow calls in ${request.cwd} for the current session.`,
    });
  }
  return choices;
}
