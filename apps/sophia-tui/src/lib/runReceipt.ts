/**
 * Unified, content-minimized run receipts.
 *
 * Receipts aggregate lifecycle/usage/tool/lane/gate telemetry from bridge
 * events and workflow nodes. They intentionally do not retain prompts,
 * assistant answers, tool arguments, reasoning text, or tool output bodies.
 */
import type { WorkflowNode } from "./workflow.js";

export const RUN_RECEIPT_SCHEMA = "sophia.tui.run_receipt.v1" as const;
export const RUN_RECEIPT_COLLECTION_SCHEMA = "sophia.tui.run_receipt_collection.v1" as const;

export type RunReceiptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export interface RunReceiptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  contextTokens?: number;
  contextWindow?: number;
  contextBudget?: number;
}

export interface RunReceiptTools {
  calls: number;
  succeeded: number;
  failed: number;
  pending: number;
  byName: Record<string, { calls: number; succeeded: number; failed: number }>;
}

export interface RunReceiptLanes {
  started: number;
  succeeded: number;
  failed: number;
  abandoned: number;
}

export interface RunReceiptGate {
  checked: boolean;
  verdict?: string;
  delivered?: boolean;
  confidence?: number;
}

export interface RunReceiptParent {
  sessionId: string;
  forkSessionId?: string;
  nodeId?: string;
  nodeTitle?: string;
  checkpointId?: string;
}

export interface RunReceipt {
  schema: typeof RUN_RECEIPT_SCHEMA;
  runId: string;
  sessionId: string;
  status: RunReceiptStatus;
  ok?: boolean;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  model?: string;
  resolvedModel?: string;
  provider?: string;
  mode?: string;
  permission?: string;
  responseStyle?: string;
  executionRuntime: string;
  externalRuntimeVersion?: string;
  executionAuthority: string;
  toolPolicyMode?: string;
  toolPolicyChecked?: boolean;
  toolActionsApprovedBySophia?: boolean;
  outputFloorChecked: boolean;
  strictUncertaintyChecked?: boolean;
  streamingQuarantined?: boolean;
  primeAutonomyExposed?: boolean;
  fallbackUsed: boolean;
  semanticFallbackUsed: boolean;
  semanticFallbackProvider?: string;
  semanticFallbackModel?: string;
  returnedToPrimary: boolean;
  primaryResumeProvider?: string;
  primaryResumeModel?: string;
  primaryResumeDeclined: boolean;
  teamSize: number;
  deepThink: boolean;
  parent?: RunReceiptParent;
  usage: RunReceiptUsage;
  cost: Record<string, number>;
  tools: RunReceiptTools;
  lanes: RunReceiptLanes;
  gate: RunReceiptGate;
  workflow: {
    nodes: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    interrupted: number;
  };
  artifacts: string[];
  errors: string[];
  eventCounts: Record<string, number>;
  localOnly: true;
  candidateOnly: true;
  canClaimAGI: false;
}

export interface AggregateRunReceiptOptions {
  runId?: string;
  sessionId?: string;
  workflowNodes?: readonly WorkflowNode[];
  now?: Date;
}

export interface RunReceiptCollection {
  schema: typeof RUN_RECEIPT_COLLECTION_SCHEMA;
  generatedAt: string;
  receipts: RunReceipt[];
  totals: {
    runs: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    interrupted: number;
    elapsedMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCalls: number;
    toolFailures: number;
  };
  localOnly: true;
  candidateOnly: true;
  canClaimAGI: false;
}

type ReceiptEvent = Readonly<Record<string, unknown>>;

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function nonNegative(value: unknown): number {
  const number = finiteNumber(value);
  return number === undefined ? 0 : Math.max(0, number);
}

function isoTimestamp(value: unknown): string | undefined {
  const text = String(value || "").trim();
  if (!text) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function eventType(event: ReceiptEvent): string {
  return String(event.type || event.event || "").trim();
}

function safeLabel(value: unknown, cap = 160): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

function safeError(value: unknown): string {
  return safeLabel(value, 400)
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b(secret|password|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    );
}

function addNumericMap(target: Record<string, number>, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const number = finiteNumber(raw);
    if (number !== undefined) target[key] = (target[key] || 0) + number;
  }
}

function tokenValue(value: unknown, names: readonly string[]): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const raw = value as Record<string, unknown>;
  for (const name of names) {
    const number = finiteNumber(raw[name]);
    if (number !== undefined) return Math.max(0, number);
  }
  return 0;
}

function addUsage(usage: RunReceiptUsage, source: unknown): void {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  usage.inputTokens += tokenValue(source, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  usage.outputTokens += tokenValue(source, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  usage.cacheTokens += tokenValue(source, ["cacheTokens", "cache_tokens", "cacheReadTokens", "cache_read_tokens"]);
  usage.reasoningTokens += tokenValue(source, ["reasoningTokens", "reasoning_tokens"]);
  const explicitTotal = tokenValue(source, ["totalTokens", "total_tokens"]);
  if (explicitTotal) usage.totalTokens += explicitTotal;
}

function normalizeStatus(value: unknown): RunReceiptStatus {
  const status = String(value || "").trim().toLowerCase();
  if (status === "succeeded" || status === "success" || status === "done") return "succeeded";
  if (status === "failed" || status === "failure" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "interrupted") return "interrupted";
  if (status === "running" || status === "queued" || status === "blocked") return "running";
  return "unknown";
}

function toolBucket(tools: RunReceiptTools, nameValue: unknown): { calls: number; succeeded: number; failed: number } {
  const name = safeLabel(nameValue, 80) || "(empty)";
  tools.byName[name] ||= { calls: 0, succeeded: 0, failed: 0 };
  return tools.byName[name];
}

function resultVerdict(event: ReceiptEvent): string | undefined {
  const epistemic = event.epistemic && typeof event.epistemic === "object"
    ? event.epistemic as Record<string, unknown>
    : undefined;
  const certificate = event.certificate && typeof event.certificate === "object"
    ? event.certificate as Record<string, unknown>
    : undefined;
  return safeLabel(
    epistemic?.verdict ??
    epistemic?.status ??
    certificate?.verdict ??
    certificate?.status ??
    event.verdict,
    80,
  ) || undefined;
}

/**
 * Fold normalized bridge events and optional workflow nodes into one receipt.
 * Unknown event fields are ignored rather than copied wholesale.
 */
export function aggregateRunReceipt(
  events: readonly ReceiptEvent[],
  options: AggregateRunReceiptOptions = {},
): RunReceipt {
  const start = events.find((event) => eventType(event) === "run_start");
  const result = [...events].reverse().find((event) => eventType(event) === "result");
  const runId = safeLabel(
    options.runId ||
    start?.runId ||
    result?.runId ||
    events.find((event) => event.runId)?.runId ||
    "unknown-run",
    128,
  ) || "unknown-run";
  const sessionId = safeLabel(
    options.sessionId ||
    start?.session ||
    result?.session ||
    events.find((event) => event.session)?.session ||
    "",
    200,
  );
  const startedAt =
    isoTimestamp(start?.ts || start?.startedAt) ||
    events.map((event) => isoTimestamp(event.ts)).find(Boolean);
  const finishedAt =
    isoTimestamp(result?.ts || result?.finishedAt) ||
    [...events].reverse().map((event) => isoTimestamp(event.ts)).find(Boolean);
  const usage: RunReceiptUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
  const tools: RunReceiptTools = {
    calls: 0,
    succeeded: 0,
    failed: 0,
    pending: 0,
    byName: {},
  };
  const lanes: RunReceiptLanes = { started: 0, succeeded: 0, failed: 0, abandoned: 0 };
  const cost: Record<string, number> = {};
  const artifacts = new Set<string>();
  const errors: string[] = [];
  const eventCounts: Record<string, number> = {};
  const pendingTools = new Map<string, number>();

  let status: RunReceiptStatus = start ? "running" : "unknown";
  let ok: boolean | undefined;
  let gate: RunReceiptGate = { checked: false };

  for (const event of events) {
    const type = eventType(event);
    if (!type) continue;
    eventCounts[type] = (eventCounts[type] || 0) + 1;
    addUsage(usage, event.usage);
    addUsage(usage, event.tokens);
    addUsage(usage, event.tokenCounts);
    addUsage(usage, event);
    addNumericMap(cost, event.cost);

    if (type === "tool_call") {
      tools.calls += 1;
      const bucket = toolBucket(tools, event.tool);
      bucket.calls += 1;
      const name = safeLabel(event.tool, 80) || "(empty)";
      pendingTools.set(name, (pendingTools.get(name) || 0) + 1);
    } else if (type === "tool_result") {
      const bucket = toolBucket(tools, event.tool);
      const name = safeLabel(event.tool, 80) || "(empty)";
      if ((pendingTools.get(name) || 0) > 0) {
        pendingTools.set(name, (pendingTools.get(name) || 0) - 1);
      }
      if (event.ok === false || !name || name === "(empty)") {
        tools.failed += 1;
        bucket.failed += 1;
      } else {
        tools.succeeded += 1;
        bucket.succeeded += 1;
      }
    } else if (type === "lane_start") {
      lanes.started += 1;
    } else if (type === "lane_end") {
      if (event.ok === false) lanes.failed += 1;
      else lanes.succeeded += 1;
    } else if (type === "lanes_abandoned") {
      const count = Array.isArray(event.lanes)
        ? event.lanes.length
        : Math.floor(nonNegative(event.count || event.abandoned));
      lanes.abandoned += Math.max(1, count || 0);
    } else if (type === "result") {
      ok = event.ok !== false;
      status = ok ? "succeeded" : "failed";
      const epistemic =
        event.epistemic && typeof event.epistemic === "object"
          ? event.epistemic as Record<string, unknown>
          : undefined;
      const floorChecked =
        event.outputFloorChecked === true || epistemic?.floorChecked === true;
      gate = {
        checked: floorChecked,
        ...(resultVerdict(event) ? { verdict: resultVerdict(event) } : {}),
        delivered:
          event.gated !== true &&
          typeof event.finalText === "string" &&
          event.finalText.trim().length > 0,
        ...(finiteNumber(
          (event.epistemic as Record<string, unknown> | undefined)?.confidence ??
          event.confidence,
        ) !== undefined
          ? {
              confidence: finiteNumber(
                (event.epistemic as Record<string, unknown> | undefined)?.confidence ??
                event.confidence,
              ),
            }
          : {}),
      };
      const contextTokens = finiteNumber(event.contextTokens);
      const contextWindow = finiteNumber(event.contextWindow);
      const contextBudget = finiteNumber(event.contextBudget);
      if (contextTokens !== undefined) usage.contextTokens = Math.max(0, contextTokens);
      if (contextWindow !== undefined) usage.contextWindow = Math.max(0, contextWindow);
      if (contextBudget !== undefined) usage.contextBudget = Math.max(0, contextBudget);
      if (event.error) errors.push(safeError(event.error));
    } else if (type === "error" && event.runId) {
      status = "failed";
      ok = false;
      errors.push(safeError(event.error || event.message || "run error"));
    } else if (type === "goal_cancelled") {
      status = "cancelled";
      ok = false;
    }

    const eventArtifacts = Array.isArray(event.artifacts) ? event.artifacts : [];
    for (const artifact of eventArtifacts) {
      const value = typeof artifact === "string"
        ? artifact
        : artifact && typeof artifact === "object"
          ? (artifact as Record<string, unknown>).path || (artifact as Record<string, unknown>).uri
          : "";
      const label = safeLabel(value, 500);
      if (label) artifacts.add(label);
    }
  }
  tools.pending = [...pendingTools.values()].reduce((sum, count) => sum + Math.max(0, count), 0);

  const workflow = { nodes: 0, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0 };
  for (const node of options.workflowNodes || []) {
    if (node.runId && node.runId !== runId) continue;
    workflow.nodes += 1;
    const nodeStatus = normalizeStatus(node.state);
    if (nodeStatus === "succeeded") workflow.succeeded += 1;
    else if (nodeStatus === "failed") workflow.failed += 1;
    else if (nodeStatus === "cancelled") workflow.cancelled += 1;
    else if (nodeStatus === "interrupted") workflow.interrupted += 1;
    const raw = node as WorkflowNode & {
      tokenCounts?: Record<string, unknown>;
      tokens?: Record<string, unknown>;
      cost?: Record<string, unknown>;
      artifacts?: unknown[];
    };
    addUsage(usage, raw.tokenCounts);
    addUsage(usage, raw.tokens);
    addNumericMap(cost, raw.cost);
    for (const artifact of raw.artifacts || []) {
      const value = typeof artifact === "string"
        ? artifact
        : artifact && typeof artifact === "object"
          ? (artifact as Record<string, unknown>).path || (artifact as Record<string, unknown>).uri
          : "";
      const label = safeLabel(value, 500);
      if (label) artifacts.add(label);
    }
  }

  if (workflow.interrupted > 0 && status === "running") status = "interrupted";
  else if (workflow.cancelled > 0 && status === "running") status = "cancelled";
  else if (workflow.failed > 0 && status === "running") status = "failed";

  if (usage.totalTokens === 0) {
    usage.totalTokens =
      usage.inputTokens + usage.outputTokens + usage.cacheTokens + usage.reasoningTokens;
  }
  const elapsedFromEvents = finiteNumber(result?.elapsedMs) ??
    (finiteNumber(result?.elapsedSec) !== undefined
      ? (finiteNumber(result?.elapsedSec) as number) * 1000
      : undefined);
  const elapsedFromTimes =
    startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : undefined;
  const elapsedMs = elapsedFromEvents !== undefined
    ? Math.max(0, Math.round(elapsedFromEvents))
    : elapsedFromTimes;

  const branch = start?.branchFrom && typeof start.branchFrom === "object"
    ? start.branchFrom as Record<string, unknown>
    : undefined;
  const parent = branch && safeLabel(branch.session, 200)
    ? {
        sessionId: safeLabel(branch.session, 200),
        ...(safeLabel(branch.fork, 200) ? { forkSessionId: safeLabel(branch.fork, 200) } : {}),
        ...(safeLabel(branch.nodeId, 160) ? { nodeId: safeLabel(branch.nodeId, 160) } : {}),
        ...(safeLabel(branch.nodeTitle, 240) ? { nodeTitle: safeLabel(branch.nodeTitle, 240) } : {}),
        ...(safeLabel(branch.checkpointId, 160)
          ? { checkpointId: safeLabel(branch.checkpointId, 160) }
          : {}),
      }
    : undefined;

  return {
    schema: RUN_RECEIPT_SCHEMA,
    runId,
    sessionId,
    status,
    ...(ok !== undefined ? { ok } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(safeLabel(start?.model, 200) ? { model: safeLabel(start?.model, 200) } : {}),
    ...(safeLabel(result?.resolvedModel, 240)
      ? { resolvedModel: safeLabel(result?.resolvedModel, 240) }
      : {}),
    ...(safeLabel(result?.provider, 120) ? { provider: safeLabel(result?.provider, 120) } : {}),
    ...(safeLabel(start?.mode, 80) ? { mode: safeLabel(start?.mode, 80) } : {}),
    ...(safeLabel(start?.permission, 80)
      ? { permission: safeLabel(start?.permission, 80) }
      : {}),
    ...(safeLabel(start?.responseStyle, 80)
      ? { responseStyle: safeLabel(start?.responseStyle, 80) }
      : {}),
    executionRuntime:
      safeLabel(result?.executionRuntime || start?.executionRuntime, 80) || "sophia",
    ...(safeLabel(result?.externalRuntimeVersion, 80)
      ? { externalRuntimeVersion: safeLabel(result?.externalRuntimeVersion, 80) }
      : {}),
    executionAuthority:
      safeLabel(result?.executionAuthority || start?.executionAuthority, 120) ||
      "sophia-kernel",
    ...(safeLabel(result?.toolPolicyMode || start?.toolPolicyMode, 80)
      ? { toolPolicyMode: safeLabel(result?.toolPolicyMode || start?.toolPolicyMode, 80) }
      : {}),
    ...(typeof result?.toolPolicyChecked === "boolean"
      ? { toolPolicyChecked: result.toolPolicyChecked }
      : {}),
    ...(typeof result?.toolActionsApprovedBySophia === "boolean"
      ? { toolActionsApprovedBySophia: result.toolActionsApprovedBySophia }
      : {}),
    outputFloorChecked:
      result?.outputFloorChecked === true ||
      (
        typeof result?.epistemic === "object" &&
        result.epistemic !== null &&
        (result.epistemic as Record<string, unknown>).floorChecked === true
      ),
    ...(typeof result?.strictUncertaintyChecked === "boolean"
      ? { strictUncertaintyChecked: result.strictUncertaintyChecked }
      : {}),
    ...(typeof result?.streamingQuarantined === "boolean"
      ? { streamingQuarantined: result.streamingQuarantined }
      : {}),
    ...(typeof result?.primeAutonomyExposed === "boolean"
      ? { primeAutonomyExposed: result.primeAutonomyExposed }
      : {}),
    fallbackUsed: result?.fallbackUsed === true,
    semanticFallbackUsed: result?.semanticFallbackUsed === true,
    ...(safeLabel(result?.semanticFallbackProvider, 120)
      ? { semanticFallbackProvider: safeLabel(result?.semanticFallbackProvider, 120) }
      : {}),
    ...(safeLabel(result?.semanticFallbackModel, 240)
      ? { semanticFallbackModel: safeLabel(result?.semanticFallbackModel, 240) }
      : {}),
    returnedToPrimary: result?.returnedToPrimary === true,
    ...(safeLabel(result?.primaryResumeProvider, 120)
      ? { primaryResumeProvider: safeLabel(result?.primaryResumeProvider, 120) }
      : {}),
    ...(safeLabel(result?.primaryResumeModel, 240)
      ? { primaryResumeModel: safeLabel(result?.primaryResumeModel, 240) }
      : {}),
    primaryResumeDeclined: result?.primaryResumeDeclined === true,
    teamSize: Math.max(1, Math.floor(nonNegative(start?.team) || 1)),
    deepThink: start?.deepThink === true,
    ...(parent ? { parent } : {}),
    usage,
    cost,
    tools,
    lanes,
    gate,
    workflow,
    artifacts: [...artifacts].sort(),
    errors: [...new Set(errors.filter(Boolean))],
    eventCounts,
    localOnly: true,
    candidateOnly: true,
    canClaimAGI: false,
  };
}

export function aggregateRunReceipts(
  receipts: readonly RunReceipt[],
  now: Date = new Date(),
): RunReceiptCollection {
  const totals = {
    runs: receipts.length,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    toolFailures: 0,
  };
  for (const receipt of receipts) {
    if (receipt.status === "succeeded") totals.succeeded += 1;
    else if (receipt.status === "failed") totals.failed += 1;
    else if (receipt.status === "cancelled") totals.cancelled += 1;
    else if (receipt.status === "interrupted") totals.interrupted += 1;
    totals.elapsedMs += receipt.elapsedMs || 0;
    totals.inputTokens += receipt.usage.inputTokens;
    totals.outputTokens += receipt.usage.outputTokens;
    totals.totalTokens += receipt.usage.totalTokens;
    totals.toolCalls += receipt.tools.calls;
    totals.toolFailures += receipt.tools.failed;
  }
  return {
    schema: RUN_RECEIPT_COLLECTION_SCHEMA,
    generatedAt: now.toISOString(),
    receipts: [...receipts],
    totals,
    localOnly: true,
    candidateOnly: true,
    canClaimAGI: false,
  };
}
