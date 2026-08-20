export type MessageRole = "user" | "assistant" | "system" | "tool" | "thinking";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  meta?: string;
  ok?: boolean;
  /**
   * Assistant replies start collapsed. User expands via click / Enter / `e`.
   * Undefined → treat as expanded for non-assistant roles.
   */
  collapsed?: boolean;
}

export interface AppState {
  model: string;
  mode: string;
  permission: "auto" | "manual" | "readonly";
  session: string;
  cwd: string;
  theme: string;
  running: boolean;
  bridgeReady: boolean;
  status: string;
  messages: ChatMessage[];
  pendingApproval: { id: string; tool: string; preview: string } | null;
  input: string;
  slashSelected: number;
}

export function uid(prefix = "m"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Auto-collapse policy for finished LLM replies. */
export function shouldAutoCollapse(text: string): boolean {
  // Replies arrive EXPANDED. Collapsing every one by default optimised for a
  // scannable transcript at the cost of the thing people actually came for:
  // the answer. It hid the full text behind a keypress on every single turn,
  // and a one-line preview of a 900-line analysis is not a summary — it is the
  // first sentence, which is usually "I'll start by…".
  //
  // Collapsing stays available per message (click the header, or `e`), so a
  // long reply can still be folded away once read. That is the direction that
  // matches how the operator works: read, then tidy — not tidy, then dig.
  return false;
}

/**
 * Unified tool-result classifier — the SINGLE source of truth for whether a
 * tool row renders ✓ / ✗ / ⏺ and what `meta` label it gets.
 *
 * Both the live-run bridge-event path (App.tsx tool_call/tool_result) and the
 * disk-resume projection (sessionStore.pushToolFeedbackBlocks) MUST go through
 * this helper. Before it existed, the two paths diverged: the live path only
 * failed on an explicit envelope `ok: false`, while the disk path also failed
 * on empty tool names, `ERROR` bodies, embedded JSON `"ok": false`, and
 * schema/unknown-tool substrings. The result was a tool that showed ✓ during
 * the run but ✗ after resume (or an empty parallel slot that lingered as a
 * dangling ⏺ live but showed ✗ (empty) on disk). Strict (disk) semantics win.
 *
 * `toolName` is the raw name (may be "" for an empty parallel slot);
 * `body` is the tool's output/error text (may be ""). Returns the normalized
 * display `meta` (empty → "(empty)") and the `failed` flag.
 */
export function classifyToolResult(args: { toolName: string; body: string }): {
  failed: boolean;
  meta: string;
} {
  const rawName = String(args.toolName || "").trim();
  const meta = rawName || "(empty)";
  const body = String(args.body || "");
  const failed =
    !rawName ||
    /^ERROR\b/m.test(body) ||
    /"ok"\s*:\s*false/.test(body) ||
    /unknown tool|missing required property|schema_missing|schema_invalid/i.test(body);
  return { failed, meta };
}

export type LiveToolPhase = "running" | "waiting" | "done" | "failed";

/** Chat-row text for a live tool_call / tool_wait / tool_result. */
export function formatLiveToolStatus(args: {
  toolName: string;
  phase: LiveToolPhase;
  body?: string;
  maxChars?: number;
}): string {
  const name = String(args.toolName || "").trim() || "tool";
  const body = String(args.body || "");
  const maxChars = args.maxChars
    ?? (args.phase === "running" || args.phase === "waiting" ? 4000 : 8000);
  return [name, args.phase, body].filter(Boolean).join(" · ").slice(0, maxChars);
}

// ─────────────────────────────────────────────────────────────────────────
// Kernel wire-protocol payload types (agent/code_bridge.py). Everything below
// describes JSON shapes the kernel puts on the NDJSON stream; it never runs
// any I/O itself. See bridge.ts for the client methods that request these
// (hooks/checkpoints/checkpointUndo/checkpointRestore/localEngineReport/
// adapterStatus/modelPreflight) and BridgeEvent for the generic envelope
// they arrive in.
//
// EVERY field here is optional and must be treated as "not yet known", not
// just "absent by choice": a kernel build that predates one of these
// commands never sends the field at all, and local_engine_report/
// model_preflight resolve on a background thread, so a reply can arrive
// after other events already have.
// ─────────────────────────────────────────────────────────────────────────

/** `risk` as reported by the kernel's own ToolSpec (agent/agent_tools.py RISK_*), not a client-side guess. */
export type ToolRisk = "safe" | "write" | "exec" | "";

/** New optional fields on the existing `approval_request` bridge event. */
export interface ApprovalDiffFields {
  /** Unified diff of the pending write/edit — already redacted and capped ~4000 chars. */
  diff?: string;
  risk?: ToolRisk;
  /** Present (always `true`) only when the pending call matches a destructive pattern; omitted otherwise. */
  destructive?: true;
}

/** New optional field on the existing `approval_decision` bridge event. */
export interface ApprovalDecisionFields {
  risk?: ToolRisk;
}

/** Per-file added/removed line counts, as carried in a `result` event's `fileChanges` map. */
export interface FileChangeLineCounts {
  added: number;
  removed: number;
}

/**
 * `result.fileChanges`: always present (may be `{}`), keyed by path relative
 * to the workspace root. Mirrors toolTransparency.ts's `FileChangeCount`
 * shape (added/removed) so the two line up for whoever wires this into
 * `summarizeFileChanges`.
 */
export type FileChanges = Record<string, FileChangeLineCounts>;

/** New optional per-turn telemetry fields on the existing `result` bridge event. */
export interface RunTelemetryFields {
  promptTokens?: number;
  completionTokens?: number;
  /** US dollars, 6dp. */
  costUsd?: number;
  /** Time to first token, milliseconds, 1dp. */
  ttftMs?: number;
  /** Completion tokens / generation seconds, 2dp; only present when both were measurable. */
  tokensPerSec?: number;
  /** Present (always `true`) only when this run saw a malformed tool call; omitted otherwise. */
  malformedToolCall?: true;
  fileChanges?: FileChanges;
  /** Whether `contextTokens` came from the provider's own usage report or a char/4 estimate. */
  contextTokensSource?: "reported" | "estimated";
  contextTokens?: number;
  contextWindow?: number;
  contextBudget?: number;
}

/**
 * New optional field on `config`/`ready` (always resolved, may be `null`)
 * and on `state` (only present when the `settings` command just changed the
 * model).
 */
export interface ModelContextWindowField {
  modelContextWindow?: number | null;
}

// ── /hooks: real loaded PreToolUse/PostToolUse/Stop config + recent dispatch ──

export type HookLifecycleEvent = "PreToolUse" | "PostToolUse" | "Stop";

export interface HookRule {
  event?: string;
  matcher?: string;
  command?: string[];
  timeoutSec?: number;
}

export interface HookConfigSummary {
  enabled?: boolean;
  source?: string | null;
  error?: string | null;
  rules?: HookRule[];
}

export interface HookDispatchOutcome {
  command?: string;
  matcher?: string;
  ok?: boolean;
  returncode?: number | null;
  timedOut?: boolean;
  reason?: string;
}

/** One row of hook-dispatch history — the shape of both `hooks.recent[]` entries and the live `hook_dispatch` event's body. */
export interface HookDispatchRecord {
  runId?: string;
  event?: HookLifecycleEvent | string;
  tool?: string | null;
  allowed?: boolean;
  blockedBy?: string | null;
  reason?: string;
  outcomes?: HookDispatchOutcome[];
  ts?: string;
}

/**
 * Live bridge event `{"type":"hook_dispatch",...}` — only emitted when a rule
 * actually matched or one blocked (a disabled config or a no-match dispatch
 * fires on every tool call and would otherwise flood the transcript).
 */
export interface HookDispatchEvent extends HookDispatchRecord {
  type: "hook_dispatch";
}

/** Response to `{"cmd":"hooks"}`. */
export interface HooksStatusEvent {
  type: "hooks";
  ok?: boolean;
  config?: HookConfigSummary;
  preToolUseScope?: string;
  recent?: HookDispatchRecord[];
}

// ── File checkpoints: list / undo / restore ─────────────────────────────────

export interface FileCheckpointEntry {
  id?: string;
  path?: string;
  existed?: boolean;
  backupPath?: string | null;
  ts?: string;
  tool?: string;
}

/** Response to `{"cmd":"checkpoints"}` / `{"cmd":"checkpoint_list"}`. */
export interface CheckpointsEvent {
  type: "checkpoints";
  ok?: boolean;
  session?: string;
  items?: FileCheckpointEntry[];
}

/** Response to `{"cmd":"checkpoint_undo"}` / `{"cmd":"checkpoint_restore"}`. */
export interface CheckpointResultEvent {
  type: "checkpoint_result";
  ok?: boolean;
  action?: "undo" | "restore";
  session?: string;
  /** The restored path + checkpoint id on success, or the failure reason on error — one human-readable line either way. */
  detail?: string | null;
  errorType?: string | null;
}

// ── Local-engine operations ─────────────────────────────────────────────────

export interface LocalEngineEndpoint {
  name?: string;
  provider?: string;
  baseUrl?: string;
  installed?: boolean;
  running?: boolean;
  /** Bounded GGUF paths found for this engine; scanned does not mean loaded. */
  modelFiles?: string[];
}

export interface LocalModelFilesByProvider {
  ds4?: string[];
  pulsar?: string[];
  gguf?: string[];
}

/** Response to `{"cmd":"local_engine_report"}` — async, resolves on a kernel background thread. */
export interface LocalEngineReportEvent {
  type: "local_engine_report";
  ok?: boolean;
  requestId?: string;
  osName?: string;
  machine?: string;
  isAppleSilicon?: boolean;
  hasNvidia?: boolean;
  mlxImportable?: boolean;
  ollamaInstalled?: boolean;
  ollamaRunning?: boolean;
  endpoints?: LocalEngineEndpoint[];
  modelCounts?: {
    ollama?: number;
    huggingFace?: number;
    mlx?: number;
    /** DS4-only count, when the kernel reports providers separately. */
    ds4?: number;
    pulsar?: number;
    /** Combined bounded GGUF scan count, when the kernel reports one total. */
    gguf?: number;
  };
  /** Older/newer kernels may report one flat list or provider-keyed lists. */
  modelFiles?: string[] | LocalModelFilesByProvider;
  recommendation?: string;
  setupSuggestions?: string[];
  /** Present only when runtime detection itself failed; every other field then falls back to a safe default. */
  error?: string;
}

/** Response to `{"cmd":"adapter_status"}`. */
export interface AdapterStatusEvent {
  type: "adapter_status";
  ok?: boolean;
  configured?: boolean;
  path?: string | null;
  name?: string | null;
  exists?: boolean;
  cachedAdapters?: string[];
}

/**
 * Response to `{"cmd":"model_preflight"}` (async, background thread), and
 * the same shape the bridge auto-emits at run start — unprompted, no
 * matching request — when a preflight comes back not ready right before a
 * run would otherwise fail confusingly.
 */
export interface ModelPreflightEvent {
  type: "model_preflight";
  ok?: boolean;
  model?: string;
  requestId?: string;
  spec?: string;
  ready?: boolean;
  reason?: string;
  transport?: string;
  endpoint?: string | null;
  /** A one-line actionable fix, or `null`/absent when `ready` is true. */
  fix?: string | null;
}

/**
 * Mirrors `agent.runtime_config.classify_memory_fit()`'s return shape.
 * NOT YET threaded onto any bridge event by this kernel build — no error
 * event carries it yet. Defined ahead of that wiring so a consumer can adopt
 * the type the moment `code_bridge.py` starts attaching it to an
 * out-of-memory error event, instead of a second round of type changes
 * landing later.
 */
export interface MemoryFitRefusal {
  isMemoryFit?: boolean;
  message?: string | null;
  suggestion?: string | null;
}
