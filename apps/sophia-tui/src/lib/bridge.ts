/**
 * NDJSON bridge client → python -m agent.code_bridge
 * Same protocol as the macOS / web shells.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ResponseStyle } from "./pickers.js";
import type { ConscienceMode } from "./conscienceMode.js";
import type { FileChanges, ToolRisk } from "./types.js";
import type { PluginCommand } from "./plugins.js";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_STALL_GIVE_UP_MS,
  shouldGiveUpStall,
  shouldTimeoutRun,
} from "./liveness.js";
import { activeEdition } from "./slash.js";
import { resolvePythonLaunch } from "./pythonResolver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pythonRoot(repoRoot: string): string {
  const bundled = path.join(repoRoot, "python");
  return existsSync(path.join(bundled, "agent", "code_bridge.py")) ? bundled : repoRoot;
}

/**
 * Executable paths to try for a kernel binary. win32 builds conventionally
 * carry a `.exe` suffix, so an extensionless reference also probes `…exe`
 * (and the libexec default prefers the suffixed file when both exist).
 */
export function sophiaKernelCandidates(
  repoRoot: string,
  env: { SOPHIA_KERNEL?: string | undefined } = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  // Build paths with the TARGET platform's semantics so a POSIX build host
  // can plan (and test) a win32 runtime layout correctly.
  const targetPath = platform === "win32" ? path.win32 : path.posix;
  const explicit = env.SOPHIA_KERNEL?.trim();
  if (explicit) {
    const resolved = targetPath.resolve(explicit);
    return platform === "win32" && targetPath.extname(resolved) === ""
      ? [resolved, `${resolved}.exe`]
      : [resolved];
  }
  const base = targetPath.join(repoRoot, "libexec", "sophia-kernel");
  return platform === "win32" ? [`${base}.exe`, base] : [base];
}

function bundledKernel(repoRoot: string): string | null {
  const candidates = sophiaKernelCandidates(repoRoot);
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  if (process.env.SOPHIA_KERNEL?.trim()) {
    throw new Error(`invalid SOPHIA_KERNEL executable: ${path.resolve(process.env.SOPHIA_KERNEL)}`);
  }
  return null;
}

function hasSourceRuntime(repoRoot: string): boolean {
  return existsSync(path.join(pythonRoot(repoRoot), "agent", "code_bridge.py"));
}

export function kernelApprovalId(value: unknown): string {
  return String(value || "").trim();
}

const PRIVILEGED_BRIDGE_CMDS = new Set(["approve", "cancel"]);

export function bridgeWriteCommand(line: string): string {
  try {
    const parsed = JSON.parse(line) as { cmd?: unknown };
    return String(parsed?.cmd || "").trim();
  } catch {
    return "";
  }
}

export function isPrivilegedBridgeWrite(line: string): boolean {
  return PRIVILEGED_BRIDGE_CMDS.has(bridgeWriteCommand(line));
}

export function dropOldestNonPrivilegedWrite(queue: string[]): boolean {
  const index = queue.findIndex((item) => !isPrivilegedBridgeWrite(item));
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}

function validateRepoRoot(value: string): string {
  const root = path.resolve(value);
  if (!hasSourceRuntime(root) && !bundledKernel(root)) {
    throw new Error(`invalid Sophia runtime root: ${root}`);
  }
  return root;
}

/**
 * Ordered runtime-root candidates for a given frontend location. Extracted
 * so the compiled-exe layout (runtime root directly beside the binary) is
 * unit-testable without actually compiling an executable.
 */
export function runtimeRootCandidates(
  execPath: string,
  sourceLibDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const targetPath = platform === "win32" ? path.win32 : path.posix;
  return [
    targetPath.dirname(execPath),
    targetPath.resolve(targetPath.dirname(execPath), ".."),
    targetPath.resolve(sourceLibDir, "../../../../"),
  ];
}

export function findRepoRoot(): string {
  const explicit = process.env.SOPHIA_RUNTIME_ROOT || process.env.SOPHIA_REPO_ROOT;
  if (explicit) return validateRepoRoot(explicit);

  // A native/SEA distribution runs from <release>/bin/sophia; a compiled
  // single-file exe sits directly inside its runtime root (agent/ beside the
  // binary). Source and unpacked-JS development still resolve from
  // apps/sophia-tui/src/lib.
  const candidates = runtimeRootCandidates(process.execPath, __dirname);
  for (const candidate of candidates) {
    try {
      return validateRepoRoot(candidate);
    } catch {
      // Try the next runtime layout. The final error includes every expected
      // root rather than silently falling back to an unrelated working tree.
    }
  }
  throw new Error(`Sophia runtime not found; checked: ${candidates.join(", ")}`);
}

export interface BridgeEnvelope<T = unknown> extends Record<string, unknown> {
  type?: string;
  protocol?: number;
  protocolVersion?: number;
  bridgeInstanceId?: string;
  requestId?: string;
  runId?: string;
  session?: string;
  taskId?: string;
  ts?: string;
  eventId?: string;
  callId?: string;
  parentEventId?: string | null;
  sequence?: number;
  protocolSequence?: number;
  attempt?: number;
  protocolAttempt?: number;
  qos?: BridgeQoSClass;
  coalesceKey?: string;
  errorPayload?: BridgeErrorPayload;
  payload?: T;
  // ── Additive kernel-capability fields (agent/code_bridge.py). Every one is
  // optional on the wire — an older kernel simply never sends it — and only
  // meaningful on the specific event types documented in types.ts (e.g. `diff`
  // only ever arrives on `approval_request`). Widened here, not just left to
  // the index signature above, so a handler reading `ev.costUsd` etc. off a
  // generically-typed BridgeEvent gets the real type instead of `unknown`.
  diff?: string;
  risk?: ToolRisk;
  destructive?: true;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  ttftMs?: number;
  tokensPerSec?: number;
  malformedToolCall?: true;
  fileChanges?: FileChanges;
  contextTokensSource?: "reported" | "estimated";
  modelContextWindow?: number | null;
}
export type BridgeEvent = BridgeEnvelope;
export type CancelReason = "user_cancel" | "silent_timeout" | "run_timeout" | "budget_cancel" | "backend_exit";

export type BridgeQoSClass = "critical" | "standard" | "ephemeral";

export interface BridgeErrorPayload extends Record<string, unknown> {
  message: string;
  type: string;
  exitCode?: number | null;
  category?: "protocol" | "availability" | "runtime" | string;
  retryable?: boolean;
  command?: string | null;
  canClaimAGI?: false;
}

export interface TypedBridgeError {
  source: "protocol" | "child";
  message: string;
  type: string;
  category: string;
  retryable: boolean;
  command?: string | null;
  requestId?: string;
  callId?: string;
  attempt?: number;
  event?: BridgeEvent;
  cause?: Error;
}

export interface ReliableBridgeCommand {
  command: Record<string, unknown>;
  requestId: string;
  callId: string;
  attempt: number;
}

export type CompoundWorkflowAction =
  | "run"
  | "resume"
  | "status"
  | "events"
  | "replay";

export interface CompoundWorkflowCommandOptions {
  action: CompoundWorkflowAction;
  session: string;
  workflowRunKey?: string;
  /** Required only for `run`; this is the canonical v1 plan payload. */
  plan?: Record<string, unknown>;
  requestId?: string;
}

const COMPOUND_WORKFLOW_ACTIONS = new Set<CompoundWorkflowAction>([
  "run",
  "resume",
  "status",
  "events",
  "replay",
]);
const COMPOUND_WORKFLOW_RUN_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function validateCompoundWorkflowSession(value: string): string {
  const session = String(value || "").trim() || "tui-default";
  if (
    session.length > 128
    || Buffer.byteLength(session, "utf8") > 512
    // eslint-disable-next-line no-control-regex
    || /[\u0000-\u001f\u007f]/.test(session)
  ) {
    throw new Error("invalid compound workflow session");
  }
  return session;
}

function validateCompoundWorkflowRunKey(value: unknown): string {
  if (typeof value !== "string" || !COMPOUND_WORKFLOW_RUN_KEY.test(value)) {
    throw new Error("invalid compound workflow run key");
  }
  return value;
}

function validateWorkflowResumeRunId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid workflow resume run id");
  }
  const runId = value.trim();
  if (
    !runId
    || runId.length > 160
    || Buffer.byteLength(runId, "utf8") > 640
    // eslint-disable-next-line no-control-regex
    || /[\u0000-\u001f\u007f]/.test(runId)
  ) {
    throw new Error("invalid workflow resume run id");
  }
  return runId;
}

export const HEADLESS_BRIDGE_CONTRACT = Object.freeze({
  protocolVersion: 2,
  minimumProtocolVersion: 1,
  terminalEvents: ["run_finished"] as const,
  restartSafeCommands: [
    "config", "state", "sessions", "tasks", "workflows", "snapshot",
    "diagnostic_snapshot", "receipt_snapshot", "mcp_health", "provider_health",
  ] as const,
  sameInstanceIdempotentCommands: ["steer", "queue_next"] as const,
});

export function isTerminalBridgeEvent(event: BridgeEvent): boolean {
  return event.type === "run_finished";
}

export function prepareBridgeCommand(
  command: Record<string, unknown>,
  metadata: {
    requestId?: string;
    callId?: string;
    attempt?: number;
    parentEventId?: string;
  } = {},
): ReliableBridgeCommand {
  const requestId = String(metadata.requestId || command.requestId || `req-${randomUUID()}`);
  const callId = String(metadata.callId || command.callId || requestId);
  const rawAttempt = Number(metadata.attempt ?? command.attempt ?? 1);
  const attempt = Number.isFinite(rawAttempt) && rawAttempt >= 1 ? Math.floor(rawAttempt) : 1;
  return {
    requestId,
    callId,
    attempt,
    command: {
      ...command,
      protocol: HEADLESS_BRIDGE_CONTRACT.protocolVersion,
      requestId,
      callId,
      attempt,
      ...(metadata.parentEventId ? { parentEventId: metadata.parentEventId } : {}),
    },
  };
}

export function retryBridgeCommand(previous: ReliableBridgeCommand): ReliableBridgeCommand {
  return prepareBridgeCommand(previous.command, {
    requestId: previous.requestId,
    callId: previous.callId,
    attempt: previous.attempt + 1,
    parentEventId:
      typeof previous.command.parentEventId === "string"
        ? previous.command.parentEventId
        : undefined,
  });
}

export function bridgeErrorFromEvent(event: BridgeEvent): TypedBridgeError | null {
  const raw = event.errorPayload;
  if (raw && typeof raw === "object") {
    return {
      source: "protocol",
      message: String(raw.message || event.error || event.message || "bridge error"),
      type: String(raw.type || "BridgeError"),
      category: String(raw.category || "runtime"),
      retryable: raw.retryable === true,
      command: typeof raw.command === "string" ? raw.command : null,
      requestId: typeof event.requestId === "string" ? event.requestId : undefined,
      callId: typeof event.callId === "string" ? event.callId : undefined,
      attempt: Number.isFinite(event.protocolAttempt)
        ? Number(event.protocolAttempt)
        : Number.isFinite(event.attempt)
          ? Number(event.attempt)
          : undefined,
      event,
    };
  }
  if (event.type !== "error") return null;
  return {
    source: "protocol",
    message: String(event.error || event.message || "bridge error"),
    type: "BridgeError",
    category: "runtime",
    retryable: false,
    requestId: typeof event.requestId === "string" ? event.requestId : undefined,
    callId: typeof event.callId === "string" ? event.callId : undefined,
    event,
  };
}

/** Keep subprocess diagnostics safe and compact before showing them in the UI. */
export function sanitizeBridgeStderr(value: unknown): string {
  return String(value ?? "")
    // OSC (ESC ] ... BEL/ST) used to pass through INTACT, so a secret carried in
    // a terminal-title sequence was never redacted and its raw ESC/BEL reached
    // the UI. Strip whole sequences, OSC first (its body can contain "[").
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Any remaining control byte: stderr from a subprocess must never be able to
    // drive the terminal.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    // The keyword is usually the TAIL of a longer identifier — OPENAI_API_KEY,
    // GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY. `\b` cannot match between "_" and a
    // letter (both are word characters), so the previous pattern missed every
    // env-var-shaped secret, which is the commonest way one reaches stderr at
    // all. Measured: OPENAI_API_KEY=sk-proj-... came through in full.
    .replace(
      /([A-Za-z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|authorization)[A-Za-z0-9_-]*)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/(?:ssh|https?):\/\/[^\s]+/gi, "[REDACTED_URL]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Convert protocol envelopes to the event shape consumed by the TUI. */
export function normalizeBridgeEvent(value: unknown): BridgeEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = normalizeProtocolAliases(value as BridgeEvent) as Record<string, unknown>;
  if ((event.type === "bridge_event" || event.type === "event") && event.event && typeof event.event === "object") {
    const inner = normalizeBridgeEvent(event.event);
    if (!inner) return null;
    // Preserve outer correlation fields needed to match steering acknowledgements.
    for (const key of [
      "runId", "path", "lane", "requestId", "session", "ts", "protocol",
      "protocolVersion", "bridgeInstanceId", "eventId", "callId",
      "parentEventId", "sequence", "protocolSequence", "attempt",
      "protocolAttempt", "qos", "coalesceKey",
    ]) {
      if (inner[key] === undefined && event[key] !== undefined) inner[key] = event[key];
    }
    return normalizeProtocolAliases(inner);
  }
  // Some bridge/runtime versions wrap the actual result in `payload` while
  // keeping correlation metadata on the envelope. The TUI consumes terminal
  // fields such as `finalText` directly; without flattening this shape a
  // successful run is treated as an answer-less failure and nothing useful is
  // rendered. Merge payload first so the envelope's type/correlation fields
  // remain authoritative.
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const flattened = {
      ...(event.payload as Record<string, unknown>),
      ...event,
    };
    return normalizeProtocolAliases(flattened as BridgeEvent);
  }
  return normalizeProtocolAliases(event as BridgeEvent);
}

/** Extract answer text across current and legacy terminal envelope shapes. */
export function bridgeEventText(event: BridgeEvent): string {
  const record = event as Record<string, unknown>;
  const payload =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const certificate = record.certificate;
  const certificateText =
    certificate && typeof certificate === "object" && !Array.isArray(certificate)
      ? (certificate as Record<string, unknown>).finalText
      : undefined;
  for (const candidate of [
    record.finalText,
    record.text,
    record.content,
    record.answer,
    record.output,
    certificateText,
    payload?.finalText,
    payload?.text,
    payload?.content,
    payload?.answer,
    payload?.output,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

function normalizeProtocolAliases(event: BridgeEvent): BridgeEvent {
  const aliases: Array<[string, string]> = [
    ["event_id", "eventId"],
    ["call_id", "callId"],
    ["parent_event_id", "parentEventId"],
    ["parent_id", "parentEventId"],
    ["request_id", "requestId"],
    ["run_id", "runId"],
    ["protocol_sequence", "protocolSequence"],
    ["protocol_attempt", "protocolAttempt"],
    ["bridge_instance_id", "bridgeInstanceId"],
    ["coalesce_key", "coalesceKey"],
  ];
  for (const [legacy, current] of aliases) {
    if (event[current] === undefined && event[legacy] !== undefined) {
      event[current] = event[legacy];
    }
  }
  if (event.protocol === undefined && typeof event.protocolVersion === "number") {
    event.protocol = event.protocolVersion;
  }
  return event;
}

export function bridgeEventQoS(event: BridgeEvent): {
  class: BridgeQoSClass;
  coalesceKey?: string;
} {
  if (event.qos === "critical" || event.qos === "standard" || event.qos === "ephemeral") {
    return {
      class: event.qos,
      ...(typeof event.coalesceKey === "string" ? { coalesceKey: event.coalesceKey } : {}),
    };
  }
  const type = String(event.type || "");
  if ([
    "ready", "bye", "error", "result", "receipt", "approval_request",
    "approval_decision", "cancel_ack", "steer_ack", "steer_applied",
    "steer_rejected", "queue_next_ack", "diagnostic_snapshot",
    "mcp_health", "mcp_timeouts", "provider_health", "image_start", "image_result",
    // One-shot correlated replies to an explicit request, same category as
    // diagnostic_snapshot/mcp_health/provider_health above — must never be
    // silently evicted by the ephemeral-event cap in coalesceBridgeEvents.
    "hooks", "checkpoints", "checkpoint_result", "local_engine_report",
    "adapter_status", "model_preflight",
    "shell_start", "shell_result",
  ].includes(type)) {
    return { class: "critical" };
  }
  if ([
    "token", "thinking_token", "bench_progress", "tbench_progress",
    "gaia_progress", "taubench_progress", "update_progress",
    "provider_wait", "tool_wait",
  ].includes(type)) {
    return {
      class: "ephemeral",
      coalesceKey:
        typeof event.coalesceKey === "string"
          ? event.coalesceKey
          : `${String(event.runId || "")}:${String(event.lane || "")}:${type}`,
    };
  }
  return { class: "standard" };
}

/**
 * Coalesce bursty event streams without ever dropping critical protocol state.
 * Token/thinking chunks are concatenated; progress-like events keep only their
 * newest snapshot per run/lane/type. The returned list preserves event order.
 */
export function coalesceBridgeEvents(events: readonly BridgeEvent[], maxEvents = 256): BridgeEvent[] {
  const output: BridgeEvent[] = [];
  const coalescedIndex = new Map<string, number>();
  for (const event of events) {
    const qos = bridgeEventQoS(event);
    if (qos.class !== "ephemeral" || !qos.coalesceKey) {
      output.push({ ...event });
      continue;
    }
    const index = coalescedIndex.get(qos.coalesceKey);
    if (index === undefined) {
      coalescedIndex.set(qos.coalesceKey, output.length);
      output.push({ ...event, qos: "ephemeral", coalesceKey: qos.coalesceKey });
      continue;
    }
    const previous = output[index];
    if ((event.type === "token" || event.type === "thinking_token") && previous.type === event.type) {
      const priorIds = Array.isArray(previous.coalescedFrom)
        ? previous.coalescedFrom.map(String)
        : [previous.eventId].filter((id): id is string => typeof id === "string");
      output[index] = {
        ...previous,
        ...event,
        text: String(previous.text || "") + String(event.text || ""),
        qos: "ephemeral",
        coalesceKey: qos.coalesceKey,
        coalescedFrom: [
          ...priorIds,
          ...(typeof event.eventId === "string" ? [event.eventId] : []),
        ],
      };
    } else {
      output[index] = { ...event, qos: "ephemeral", coalesceKey: qos.coalesceKey };
    }
  }
  const cap = Number.isFinite(maxEvents) && maxEvents > 0 ? Math.floor(maxEvents) : 256;
  while (output.length > cap) {
    const ephemeral = output.findIndex((event) => bridgeEventQoS(event).class === "ephemeral");
    output.splice(ephemeral >= 0 ? ephemeral : 0, 1);
  }
  return output;
}

export function validateBridgeCwd(repoRoot: string, cwd: string): string {
  const candidate = path.resolve(cwd || repoRoot);
  // A single statSync wrapped in try/catch (rather than a separate existsSync
  // check followed by statSync) avoids a TOCTOU gap: if the path is deleted or
  // becomes unreadable between the two calls, statSync would otherwise throw a
  // raw Node fs error (ENOENT/EACCES) that bypasses the friendly message below
  // and propagates as an uncaught exception instead.
  let isDirectory = false;
  try {
    isDirectory = statSync(candidate).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    // Lead with the cause and the recovery, and put the path on its OWN line.
    // A transcript row truncates at the pane edge, so a message shaped
    // "<label>: <long absolute path>" showed the operator exactly the half that
    // carries no information — the observed row was "command failed: invalid
    // bridge cwd:" with the path clipped away entirely. The usual trigger is a
    // remembered workspace that has since been deleted, or one on a cloud mount
    // that is not currently materialised; it surfaces as a run that never
    // starts, which reads as "tools stopped working" rather than "that folder
    // is gone".
    throw new Error(
      "workspace folder is missing — relaunch from the directory you want "
        + "(cd <dir> && sophia) or pass --cwd <dir>\n"
        + `missing path: ${candidate}`,
    );
  }
  return candidate;
}

export interface RunOptions {
  prompt: string;
  /** Execution backend. Sophia is default; Prime is an explicit external lane. */
  runtime?: "sophia" | "prime";
  model?: string;
  mode?: string;
  permission?: string;
  session?: string;
  maxSteps?: number;
  cwd?: string;
  deepThink?: boolean;
  /** Deep-mode sampling toggle (/deepmode): high-exploration sampling, independent of effort. */
  deepMode?: boolean;
  /** low|medium|high|ultramode — ultramode loads the Sophia harness profile */
  effort?: string;
  reasoningEffort?: string;
  /**
   * Automatic long-horizon goal detection (default true): ordinary substantive
   * tasks use the normal inner agent loop; explicit persistence/retry/resume
   * intent uses the outer goal-continuation loop without needing `/goal`.
   * Set false to disable automatic outer goal mode.
   */
  autoGoal?: boolean;
  /**
   * Automatic team detection. Omit this tri-state value to preserve the
   * persisted kernel policy; `/team on` enables a local deterministic
   * worthiness check that fans eligible native-tool transports out to 2..4
   * lanes. Unsupported transports, uncertain classification, and goal mode
   * fail closed to solo. Explicit `/agents N` remains the operator override.
   */
  autoTeam?: boolean;
  /** A2A chain length (0 = off, -1 = auto, ≥2 = fixed legacy total). */
  a2aAgents?: number;
  /** Embedded keeps workers in-process; terminal/headless use sessiond PTYs. */
  a2aExecution?: "embedded" | "terminal" | "headless";
  /** Native terminal presentation policy. */
  terminalLayout?: "off" | "auto" | "splits" | "windows" | "headless";
  /**
   * Bounded dynamic workflow routing. `auto` lets Main decide whether the
   * prompt benefits from a multi-stage parallel A2A harness; `on` requires an
   * eligible cloud/supervisor setup and otherwise fails closed.
   */
  workflowMode?: "off" | "auto" | "on";
  /** Maximum Main→parallel-stage→review barriers for one workflow run. */
  workflowMaxStages?: number;
  /** Maximum total sub-agents dispatched across every workflow stage. */
  workflowMaxAgents?: number;
  /**
   * Explicit source workflow run whose durable A2A manifest should be
   * reconciled and resumed. Omitted means a fresh workflow; resume never
   * happens implicitly from the newest session snapshot.
   */
  workflowResumeRunId?: string;
  /** Opt-in bounded AGI-shaped controller. It supersedes goal/team/A2A routing for this run. */
  agiMode?: boolean;
  /**
   * AGI-owned node workflow routing. When enabled, the kernel may execute each
   * bounded AGI node either solo or through supervised parallel A2A while the
   * outer dynamic workflow controller remains off.
   */
  agiWorkflowMode?: "off" | "auto" | "on";
  /** Controller safety/effort envelope. */
  agiProfile?: "conservative" | "balanced" | "deep";
  /** Adaptive controller route. `auto` may raise the route but never downgrade safety. */
  agiRoute?: "auto" | "fast" | "deliberative" | "critical";
  /** Optional role-specific model overrides; omitted means use the selected model. */
  agiPlannerModel?: string;
  agiWorkerModel?: string;
  agiVerifierModel?: string;
  /** Durable run id used only when resuming an existing AGI run. */
  agiResumeRunId?: string;
  /** Response presentation preference; omitted to preserve the kernel default. */
  responseStyle?: ResponseStyle;
  /** Optional strict epistemic tier; the mandatory hard floor is always active. */
  conscienceMode?: ConscienceMode;
  /**
   * Parallel agent lanes for this run, or `undefined` to not express an
   * opinion. The kernel clamps to 1..4 (`agent/code_bridge.py::_normalize_team`).
   *
   * `undefined` and `1` are NOT the same thing on the wire, and conflating
   * them is a bug. `team` is a PERSISTED kernel default: a run that omits the
   * key inherits whatever the last run used, across restarts. Measured:
   * run(team:3) then run() with no key still produced three lanes. So
   * `undefined` omits the key (a client that never mentions lanes keeps the
   * pre-team wire format byte-for-byte), while an explicit `1` is SENT, so
   * "go back to solo" actually overrides the stored default instead of
   * silently inheriting it. See `run()`.
   */
  team?: number;
}

export interface BridgeOptions {
  /**
   * Explicit child-process override for hermetic bridge adapters/tests.
   * Production callers omit these. Source checkouts retain the
   * SOPHIA_PYTHON/python3 `-P -m agent.code_bridge` contract, while signed
   * binary releases launch <runtime>/libexec/sophia-kernel app-bridge.
   */
  spawnCommand?: string;
  spawnArgs?: readonly string[];
  /**
   * Cap on stdin lines held in our own outbound queue before we start
   * dropping the oldest. The channel carries discrete control commands
   * (run/approve/cancel/steer/settings/...), not a per-token stream, so a
   * generous default is safe — it only bites once the child is stalled
   * (see stallTimeoutMs) and the operator keeps acting anyway.
   */
  writeQueueCap?: number;
  /**
   * Milliseconds of zero stdout/stderr activity during an in-flight run
   * before a "stall" event is surfaced. Overrides SOPHIA_BRIDGE_STALL_MS.
   */
  stallTimeoutMs?: number;
  /**
   * Milliseconds of continuous stall (silence past stallTimeoutMs) before the
   * bridge AUTO-CANCELS the wedged run instead of waiting forever — the "writing
   * response…" spinner that never resolves. Overrides
   * SOPHIA_BRIDGE_STALL_GIVE_UP_MS. 0 disables auto-cancel (the operator then
   * cancels by hand — the pre-existing behaviour). Default 120s.
   */
  stallGiveUpMs?: number;
  /**
   * Hard overall time budget ("overtime") for a single run, measured from run
   * start regardless of activity. A safety net for a runaway run that keeps
   * emitting (so the silence-based stall never fires) yet never concludes.
   * Overrides SOPHIA_RUN_TIMEOUT_MS. 0 disables — the DEFAULT — because a hard
   * cap would otherwise kill legitimate long autonomous goals; opt in.
   */
  runTimeoutMs?: number;
}

/** Outbound queue bound — see BridgeOptions.writeQueueCap doc. */
const DEFAULT_WRITE_QUEUE_CAP = 64;
/**
 * Default stall threshold. Interactive runs stream token/thinking_token/
 * tool_call/tool_result events near-continuously; 45s of total silence on
 * both stdout and stderr while a run is in flight is well past normal
 * inter-event gaps and matches the "no progress" framing tools/pod_heartbeat.py
 * uses for GPU jobs, scaled down for an interactive TUI instead of a
 * multi-hour training run.
 */
const DEFAULT_STALL_TIMEOUT_MS = 45_000;
/**
 * Ceiling on how often the liveness check runs. Scaled down (with a floor,
 * so it never busy-loops) for callers that configure a small stallTimeoutMs
 * — e.g. tests — so detection latency stays proportional to the threshold
 * instead of waiting up to a fixed 2s regardless of how short the timeout is.
 */
const STALL_POLL_MS_CEILING = 2_000;
const STALL_POLL_MS_FLOOR = 50;
/** Force-flush a stderr line this long even without a newline. */
const STDERR_LINE_CAP = 8192;

export class CodeBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private readyEvent: BridgeEvent | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly ownedChildren = new WeakSet<object>();
  readonly repoRoot: string;

  // Outbound flow control — see writeLine() doc for the chosen policy.
  private readonly writeQueueCap: number;
  private pendingWrites: string[] = [];
  private backpressured = false;

  // Liveness / stall detection — see checkStall() doc.
  private readonly stallTimeoutMs: number;
  private readonly stallGiveUpMs: number;
  private readonly runTimeoutMs: number;
  private lastActivityAt = 0;
  /** Wall-clock run start; the basis for the overtime budget (see checkStall). */
  private runStartedAt = 0;
  private runInFlight = false;
  private stalled = false;
  /** Latched so a wedged run is auto-cancelled AT MOST once (see checkStall). */
  private gaveUp = false;
  /** Latched so an over-budget run is auto-cancelled AT MOST once. */
  private timedOut = false;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** Partial stderr line held until its newline, so redaction sees whole lines. */
  private stderrBuf = "";
  private readonly spawnCommand?: string;
  private readonly spawnArgs?: readonly string[];

  constructor(repoRoot?: string, options: BridgeOptions = {}) {
    super();
    this.repoRoot = validateRepoRoot(repoRoot || findRepoRoot());
    this.spawnCommand = options.spawnCommand;
    this.spawnArgs = options.spawnArgs ? [...options.spawnArgs] : undefined;
    this.writeQueueCap = options.writeQueueCap ?? DEFAULT_WRITE_QUEUE_CAP;
    const envStall = Number(process.env.SOPHIA_BRIDGE_STALL_MS);
    this.stallTimeoutMs =
      options.stallTimeoutMs ?? (Number.isFinite(envStall) && envStall > 0 ? envStall : DEFAULT_STALL_TIMEOUT_MS);
    // 0 is a meaningful "disable auto-cancel" for both of these (unlike the
    // stall WARNING threshold above, where 0 would mean "warn on every poll"),
    // so the env override accepts >= 0; an unset/invalid var falls back to the
    // default. SOPHIA_RUN_TIMEOUT_MS defaults to 0 = off (opt-in overtime).
    const envGiveUp = Number(process.env.SOPHIA_BRIDGE_STALL_GIVE_UP_MS);
    this.stallGiveUpMs =
      options.stallGiveUpMs ?? (Number.isFinite(envGiveUp) && envGiveUp >= 0 ? envGiveUp : DEFAULT_STALL_GIVE_UP_MS);
    const envRunTimeout = Number(process.env.SOPHIA_RUN_TIMEOUT_MS);
    this.runTimeoutMs =
      options.runTimeoutMs ?? (Number.isFinite(envRunTimeout) && envRunTimeout >= 0 ? envRunTimeout : DEFAULT_RUN_TIMEOUT_MS);
  }

  start(): void {
    if (this.proc) return;
    const kernel = bundledKernel(this.repoRoot);
    // The bridge contract honors only SOPHIA_PYTHON (never bare PYTHON), so a
    // narrowed env view is passed; on win32 the resolver may probe `python`
    // then `py -3` once per process to dodge the Microsoft Store stub.
    const launch = resolvePythonLaunch({ SOPHIA_PYTHON: process.env.SOPHIA_PYTHON });
    const command =
      this.spawnCommand
      || kernel
      || launch.command;
    const args = this.spawnArgs
      ? [...this.spawnArgs]
      : kernel
        ? ["app-bridge"]
        : [...launch.preArgs, "-P", "-m", "agent.code_bridge"];
    const pyRoot = pythonRoot(this.repoRoot);
    const sourceRuntime = hasSourceRuntime(this.repoRoot);
    this.pendingWrites = [];
    this.backpressured = false;
    this.runInFlight = false;
    this.stalled = false;
    const proc = spawn(command, args, {
      cwd: this.repoRoot,
      env: {
        ...process.env,
        SOPHIA_EDITION: activeEdition(),
        SOPHIA_RUNTIME_ROOT: this.repoRoot,
        ...(sourceRuntime
          ? {
              PYTHONPATH: [pyRoot, process.env.PYTHONPATH || ""]
                .filter(Boolean)
                .join(path.delimiter),
            }
          : {}),
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.ownedChildren.add(proc);
    this.readyEvent = null;
    this.noteActivity();
    const pollMs = Math.max(
      STALL_POLL_MS_FLOOR,
      Math.min(STALL_POLL_MS_CEILING, Math.floor(this.stallTimeoutMs / 4)),
    );
    // unref: the poll timer must never keep the event loop alive on its own —
    // process lifetime is owned by the child's stdio pipes, this is just a check.
    this.stallTimer = setInterval(() => this.checkStall(), pollMs);
    this.stallTimer.unref?.();

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      // Any line at all — even a blank one — is proof the child is alive
      // and the pipe is flowing, so clear/reset the stall clock first.
      this.noteActivity();
      const s = line.trim();
      if (!s) return;
      try {
        const ev = normalizeBridgeEvent(JSON.parse(s));
        if (!ev) return;
        if (ev.type === "ready") {
          this.ready = true;
          this.readyEvent = ev;
        }
        // ``run_finished`` is the sole run-terminal boundary. A result carries
        // the answer but a supervised provider may still be unwinding. A
        // paused AGI result is idle pending operator input, without being
        // terminal for automation.
        if (
          ev.type === "run_finished"
          || (
            ev.type === "result"
            && (
              ev.awaitingInput === true
              || ev.goalStatus === "awaiting_input"
              || ["paused", "awaiting_input", "interrupted"].includes(
                String(ev.agiStatus || "").toLowerCase(),
              )
            )
          )
        ) {
          this.runInFlight = false;
        }
        const typed = bridgeErrorFromEvent(ev);
        if (typed) this.emit("typed_error", typed);
        this.emit("event", ev);
      } catch {
        this.emit("event", { type: "log", text: s });
      }
    });

    // Redact per LINE, not per chunk. A pipe hands over arbitrary byte
    // boundaries, so "OPENAI_API_KEY=sk-" and "proj-abc" can arrive as two
    // chunks; sanitising each in isolation matches neither pattern and the
    // secret is reassembled on screen. Buffering to newlines makes redaction
    // see whole lines, which is the unit the patterns are written against.
    // A ChildProcess "error" (commonly ENOENT: SOPHIA_PYTHON points at a venv
    // that has since been deleted) is an EventEmitter error. With no listener
    // Node RETHROWS it, and an ordinary misconfiguration took the whole TUI
    // down with an uncaught exception instead of showing a message. Verified:
    // SOPHIA_PYTHON=/nonexistent -> "Error: spawn ... ENOENT" at the top level.
    proc.on("error", (err: Error) => {
      this.ready = false;
      this.runInFlight = false;
      this.readyEvent = null;
      const enoentHint = /ENOENT/i.test(err.message) && !kernel
        ? " (Python not found: install Python 3.11+ from python.org, or set SOPHIA_PYTHON to an interpreter path)"
        : "";
      this.emit("typed_error", {
        source: "child",
        message: `${err.message}${enoentHint}`,
        type: "BridgeChildError",
        category: "availability",
        retryable: true,
        cause: err,
      } satisfies TypedBridgeError);
      this.emit("error", err);
    });

    // Writing to a child that has already died raises EPIPE on the stream. The
    // write path is best-effort by nature (attemptWrite already tolerates a
    // full buffer), so an unlistened EPIPE must not become a fatal throw.
    proc.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err && err.code === "EPIPE") return;   // the child is gone; exit handles it
      this.emit("typed_error", {
        source: "child",
        message: err.message,
        type: "BridgePipeError",
        category: "availability",
        retryable: true,
        cause: err,
      } satisfies TypedBridgeError);
      this.emit("error", err);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      this.noteActivity();
      this.stderrBuf += chunk.toString("utf8");
      // A runaway line with no newline must not grow without bound; flush it
      // once it is longer than any redaction could still be widened by.
      if (this.stderrBuf.length > STDERR_LINE_CAP) {
        const forced = sanitizeBridgeStderr(this.stderrBuf);
        this.stderrBuf = "";
        if (forced) this.emit("stderr", forced);
        return;
      }
      let idx: number;
      while ((idx = this.stderrBuf.indexOf("\n")) >= 0) {
        const line = this.stderrBuf.slice(0, idx);
        this.stderrBuf = this.stderrBuf.slice(idx + 1);
        const text = sanitizeBridgeStderr(line);
        if (text) this.emit("stderr", text);
      }
    });

    proc.on("exit", (code) => {
      // Flush a trailing partial stderr line; a crash message with no final
      // newline would otherwise be swallowed exactly when it matters most.
      if (this.stderrBuf) {
        const tail = sanitizeBridgeStderr(this.stderrBuf);
        this.stderrBuf = "";
        if (tail) this.emit("stderr", tail);
      }
      if (this.proc === proc) {
        this.ready = false;
        this.readyEvent = null;
        this.proc = null;
        this.runInFlight = false;
        this.stalled = false;
        this.pendingWrites = [];
        this.backpressured = false;
        if (this.stallTimer) {
          clearInterval(this.stallTimer);
          this.stallTimer = null;
        }
      }
      this.emit("exit", code);
    });
  }

  /**
   * Flow-control policy for the outbound command channel: BLOCK-until-drain,
   * bounded, drop-OLDEST on overflow.
   *
   * `stdin.write()` returning false means the kernel pipe (or Node's own
   * internal buffer) is full. The old code ignored that signal entirely and
   * kept calling write() on every send() — Node buffers those calls without
   * limit, so a slow or wedged python side turned into unbounded memory
   * growth on our side with zero user-visible signal.
   *
   * We don't drop by default: this channel carries discrete operator
   * actions (run/approve/cancel/steer/settings/...), not a token stream, so
   * silently losing one (e.g. a `cancel`) would be a correctness bug, not a
   * cosmetic one. New lines queue in our own bounded buffer and only reach
   * `stdin.write()` again once Node's "drain" event fires. The cap exists
   * only for the pathological case where the child is genuinely wedged (see
   * stall detection below) and the operator keeps acting regardless; past
   * the cap we drop the oldest *non-privileged* queued line. Approve and
   * cancel are never dropped: a wedged session may overflow those two
   * rather than fail-open by discarding an allow/deny.
   */
  private writeLine(line: string): void {
    if (this.backpressured || this.pendingWrites.length > 0) {
      this.pendingWrites.push(line);
      while (this.pendingWrites.length > this.writeQueueCap) {
        if (!dropOldestNonPrivilegedWrite(this.pendingWrites)) {
          if (!isPrivilegedBridgeWrite(line)) this.pendingWrites.pop();
          break;
        }
      }
      return;
    }
    this.attemptWrite(line, /* rethrow */ true);
  }

  private attemptWrite(line: string, rethrow: boolean): void {
    if (!this.proc) return;
    let ok: boolean;
    try {
      ok = this.proc.stdin.write(line);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("error", err);
      if (rethrow) throw err;
      return;
    }
    if (!ok) this.beginBackpressure();
  }

  private beginBackpressure(): void {
    if (this.backpressured) return;
    this.backpressured = true;
    this.emit("backpressure", { active: true, queued: this.pendingWrites.length });
    this.proc?.stdin.once("drain", () => this.drainQueue());
  }

  private drainQueue(): void {
    this.backpressured = false;
    while (this.pendingWrites.length > 0) {
      const line = this.pendingWrites.shift() as string;
      // Errors here have no synchronous caller to catch them (we're inside
      // a "drain" listener), so attemptWrite reports via the "error" event
      // instead of throwing.
      this.attemptWrite(line, false);
      if (this.backpressured) return; // re-entered backpressure; next "drain" resumes
    }
    this.emit("backpressure", { active: false, queued: 0 });
  }

  isBackpressured(): boolean {
    return this.backpressured;
  }

  /**
   * Liveness check for an in-flight run. There was previously no timeout or
   * stall detection outside of stop() — if the python bridge wedged mid-run,
   * the TUI waited forever with no signal, the same class of failure
   * tools/pod_heartbeat.py exists to catch for GPU training jobs. We poll
   * rather than use a single setTimeout so the threshold re-arms on every
   * sign of life (see noteActivity) instead of firing once and going stale.
   */
  private checkStall(): void {
    if (!this.proc || !this.runInFlight) return;
    const now = Date.now();
    const since = now - this.lastActivityAt;
    if (since >= this.stallTimeoutMs) {
      this.stalled = true;
      this.emit("stall", { stalled: true, sinceMs: since });
    }
    // Escalation 1 — give-up: a stall that has persisted past stallGiveUpMs means
    // the kernel is almost certainly never coming back, so auto-cancel rather
    // than leave the operator staring at a "writing response…" spinner that
    // never resolves (the failure mode this exists to prevent). A productive
    // long run keeps emitting and so never goes silent, so this only ever bites
    // a genuinely wedged run. Latched (gaveUp): fires once, the cancel it sends
    // ends the run, runInFlight drops on the terminal event, and this branch
    // stops being reached — so a still-dead kernel never gets cancel-spammed.
    if (!this.gaveUp && shouldGiveUpStall(this.stalled, since, this.stallGiveUpMs)) {
      this.gaveUp = true;
      this.emit("stall_timeout", { sinceMs: since, giveUpMs: this.stallGiveUpMs });
      this.autoCancel("silent_timeout");
      return;
    }
    // Escalation 2 — overtime: a hard overall budget from run start, opt-in
    // (runTimeoutMs defaults to 0 = off). Catches a runaway run that keeps
    // emitting (so the silence-based stall above never fires) yet never
    // concludes. Measured from runStartedAt, NOT lastActivityAt — activity does
    // not extend the budget, that is the whole point.
    const elapsed = now - this.runStartedAt;
    if (!this.timedOut && shouldTimeoutRun(this.runInFlight, elapsed, this.runTimeoutMs)) {
      this.timedOut = true;
      this.emit("run_timeout", { elapsedMs: elapsed, timeoutMs: this.runTimeoutMs });
      this.autoCancel("run_timeout");
    }
  }

  /**
   * Send a best-effort cancel from inside the liveness poll. A wedged kernel
   * may already have a broken pipe, in which case send() throws; that must not
   * become an uncaught exception inside the setInterval callback (it would take
   * the whole TUI down at exactly the moment we are trying to recover). The
   * child's "exit" handler cleans up regardless.
   */
  private autoCancel(reason: Exclude<CancelReason, "user_cancel">): void {
    try {
      this.cancel(undefined, reason);
    } catch {
      /* the child is likely already gone; "exit" will clean up */
    }
  }

  /**
   * Arm/reset the per-run liveness state for a freshly accepted run. Both run()
   * and goal() call this so the stall clock is measured from "we asked" and the
   * auto-cancel latches cannot leak across runs. Kept in one place because the
   * fields MUST reset together — forgetting one at a call site is a latent bug.
   */
  private beginRun(): void {
    this.runInFlight = true;
    this.runStartedAt = Date.now();
    this.gaveUp = false;
    this.timedOut = false;
    this.noteActivity();
  }

  private noteActivity(): void {
    this.lastActivityAt = Date.now();
    if (this.stalled) {
      this.stalled = false;
      this.emit("stall", { stalled: false, sinceMs: 0 });
    }
  }

  isStalled(): boolean {
    return this.stalled;
  }

  send(cmd: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin.writable) {
      const err = new Error("bridge not running");
      this.emit("error", err);
      // Prefer soft-fail for local slash commands (resume/session) so a dead
      // bridge never leaves the TUI submit lock wedged and silent.
      throw err;
    }
    this.writeLine(JSON.stringify(cmd) + "\n");
  }

  /**
   * Send one non-retryable secret-bearing command without retaining it in
   * Sophia's application-level backpressure queue.
   *
   * Node/the OS may still buffer the single write until the local Python
   * process reads it, but Sophia never stores a replayable copy. If another
   * command already filled the pipe, fail visibly and let the operator retry
   * after drain rather than queueing credential material in memory.
   */
  sendOneShotSecret(cmd: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin.writable) {
      const err = new Error("bridge not running");
      this.emit("error", err);
      throw err;
    }
    if (this.backpressured || this.pendingWrites.length > 0) {
      throw new Error(
        "bridge is busy; credential was not queued or sent. Retry after pending commands drain.",
      );
    }
    this.attemptWrite(JSON.stringify(cmd) + "\n", /* rethrow */ true);
  }

  sendReliable(
    command: Record<string, unknown>,
    metadata: {
      requestId?: string;
      callId?: string;
      attempt?: number;
      parentEventId?: string;
    } = {},
  ): ReliableBridgeCommand {
    const prepared = prepareBridgeCommand(command, metadata);
    this.send(prepared.command);
    return prepared;
  }

  resend(previous: ReliableBridgeCommand): ReliableBridgeCommand {
    const retried = retryBridgeCommand(previous);
    this.send(retried.command);
    return retried;
  }

  waitForEvent(
    predicate: (event: BridgeEvent) => boolean,
    timeoutMs = 5_000,
  ): Promise<BridgeEvent> {
    if (this.readyEvent && predicate(this.readyEvent)) return Promise.resolve(this.readyEvent);
    return new Promise<BridgeEvent>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", onEvent);
        this.off("exit", onExit);
      };
      const finish = (event: BridgeEvent) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(event);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onEvent = (event: BridgeEvent) => {
        if (predicate(event)) finish(event);
      };
      const onExit = (code: number | null) => {
        fail(new Error(`bridge child exited before expected event (code ${String(code)})`));
      };
      const timer = setTimeout(
        () => fail(new Error(`timed out after ${timeoutMs}ms waiting for bridge event`)),
        Math.max(1, timeoutMs),
      );
      this.on("event", onEvent);
      this.on("exit", onExit);
    });
  }

  /** Idempotent connect for headless clients and reconnecting shells. */
  connect(timeoutMs = 5_000): Promise<BridgeEvent> {
    if (this.ready && this.readyEvent) return Promise.resolve(this.readyEvent);
    const ready = this.waitForEvent((event) => event.type === "ready", timeoutMs);
    this.start();
    return ready;
  }

  reconnect(timeoutMs = 5_000): Promise<BridgeEvent> {
    return this.connect(timeoutMs);
  }

  /**
   * Staged restart of this instance's own child only:
   * cancel active run -> grace -> SIGTERM owned child -> fresh ready handshake.
   * No PID lookup and no arbitrary/force kill is used.
   */
  async restart(options: {
    cancelGraceMs?: number;
    terminateGraceMs?: number;
    readyTimeoutMs?: number;
  } = {}): Promise<BridgeEvent> {
    const cancelGraceMs = Math.max(0, options.cancelGraceMs ?? 1_000);
    const terminateGraceMs = Math.max(1, options.terminateGraceMs ?? 1_000);
    const readyTimeoutMs = Math.max(1, options.readyTimeoutMs ?? 5_000);
    const proc = this.proc;
    if (proc) {
      if (!this.ownedChildren.has(proc)) {
        throw new Error("refusing to restart a bridge child not owned by this client");
      }
      this.emit("restart_stage", { stage: "cancelling", runInFlight: this.runInFlight });
      if (this.runInFlight) {
        try {
          this.cancel(`restart-${randomUUID()}`);
        } catch {
          // A broken pipe is handled by the owned-child termination stage.
        }
        await this.waitForTerminalOrExit(proc, cancelGraceMs);
      }
      if (this.proc === proc) {
        this.emit("restart_stage", { stage: "terminating" });
        try {
          proc.kill("SIGTERM");
        } catch {
          // The process may have exited between the identity check and signal.
        }
        await this.waitForOwnedExit(proc, terminateGraceMs);
      }
      if (this.proc === proc) {
        const error = new Error("owned bridge child did not exit after SIGTERM");
        const typed: TypedBridgeError = {
          source: "child",
          message: error.message,
          type: "BridgeRestartTimeout",
          category: "availability",
          retryable: true,
          cause: error,
        };
        this.emit("restart_stage", { stage: "failed", error: error.message });
        this.emit("typed_error", typed);
        throw error;
      }
    }
    this.emit("restart_stage", { stage: "starting" });
    const ready = await this.connect(readyTimeoutMs);
    this.emit("restart_stage", {
      stage: "ready",
      bridgeInstanceId: ready.bridgeInstanceId,
    });
    return ready;
  }

  private waitForTerminalOrExit(
    proc: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<void> {
    if (!this.runInFlight || this.proc !== proc || timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off("event", onEvent);
        proc.off("exit", finish);
        resolve();
      };
      const onEvent = (event: BridgeEvent) => {
        if (isTerminalBridgeEvent(event)) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.on("event", onEvent);
      proc.once("exit", finish);
    });
  }

  private waitForOwnedExit(
    proc: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<void> {
    if (this.proc !== proc) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.off("exit", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      proc.once("exit", finish);
    });
  }

  onTypedError(handler: (error: TypedBridgeError) => void): () => void {
    this.on("typed_error", handler);
    return () => this.off("typed_error", handler);
  }

  run(opts: RunOptions): void {
    const effort = opts.reasoningEffort || opts.effort || process.env.SOPHIA_REASONING_EFFORT || "medium";
    // Only an explicit, usable number reaches the wire. Garbage (NaN, 0,
    // negative, non-numeric) is treated as "no opinion" and omitted rather
    // than throwing — an unusable lane count must never be the reason a
    // prompt is lost — but it also must not silently mean 1, because the
    // kernel's stored default would then decide instead.
    const wantsTeam = Number.isFinite(opts.team) && (opts.team as number) >= 1;
    const team = wantsTeam ? Math.floor(opts.team as number) : undefined;
    this.send({
      cmd: "run",
      prompt: opts.prompt,
      // Preserve the established Sophia wire shape. The kernel already
      // defaults an omitted runtime to Sophia; only the opt-in external
      // runtime needs a protocol field.
      ...(opts.runtime === "prime" ? { runtime: "prime" as const } : {}),
      model: opts.model || "mock",
      mode: opts.mode || "balanced",
      permission: opts.permission || "manual",
      session: opts.session || "tui-default",
      maxSteps: opts.maxSteps ?? 12,
      cwd: validateBridgeCwd(this.repoRoot, opts.cwd || this.repoRoot),
      deepThink: !!opts.deepThink || effort === "ultramode" || effort === "high",
      deepMode: !!opts.deepMode,
      reasoningEffort: effort,
      effort,
      // Automatic long-horizon goal detection: ordinary substantive tasks stay
      // in the normal inner agent loop; explicit persistence/retry/resume intent
      // uses the outer goal-continuation loop (no /goal needed). Default ON for
      // the TUI; pass autoGoal:false to disable automatic outer goal mode.
      autoGoal: opts.autoGoal ?? true,
      // Automatic team detection is an EXPLICIT tri-state kernel setting.
      // Omit it when the caller has no opinion so a first-use install remains
      // solo and the persisted/config.toml choice stays authoritative. Explicit
      // /agents still travels separately through `team` and always wins.
      ...(typeof opts.autoTeam === "boolean" ? { autoTeam: opts.autoTeam } : {}),
      ...(Number.isFinite(opts.a2aAgents) && (opts.a2aAgents as number) >= -1
        ? { a2aAgents: Math.floor(opts.a2aAgents as number) }
        : {}),
      ...(opts.a2aExecution ? { a2aExecution: opts.a2aExecution } : {}),
      ...(opts.terminalLayout ? { terminalLayout: opts.terminalLayout } : {}),
      ...(opts.workflowMode ? { workflowMode: opts.workflowMode } : {}),
      ...(Number.isFinite(opts.workflowMaxStages)
        ? { workflowMaxStages: Math.floor(Number(opts.workflowMaxStages)) }
        : {}),
      ...(Number.isFinite(opts.workflowMaxAgents)
        ? { workflowMaxAgents: Math.floor(Number(opts.workflowMaxAgents)) }
        : {}),
      ...(opts.workflowResumeRunId
        ? {
            workflowResumeRunId: validateWorkflowResumeRunId(
              opts.workflowResumeRunId,
            ),
          }
        : {}),
      ...(opts.agiMode === undefined ? {} : { agiMode: opts.agiMode }),
      ...(opts.agiWorkflowMode ? { agiWorkflowMode: opts.agiWorkflowMode } : {}),
      ...(opts.agiProfile ? { agiProfile: opts.agiProfile } : {}),
      ...(opts.agiRoute ? { agiRoute: opts.agiRoute } : {}),
      ...(opts.agiPlannerModel ? { agiPlannerModel: opts.agiPlannerModel } : {}),
      ...(opts.agiWorkerModel ? { agiWorkerModel: opts.agiWorkerModel } : {}),
      ...(opts.agiVerifierModel ? { agiVerifierModel: opts.agiVerifierModel } : {}),
      ...(opts.agiResumeRunId ? { agiResumeRunId: opts.agiResumeRunId } : {}),
      ...(opts.responseStyle === undefined ? {} : { responseStyle: opts.responseStyle }),
      ...(opts.conscienceMode === undefined ? {} : { conscienceMode: opts.conscienceMode }),
      // Spread LAST, and only when the caller actually asked. Omitted, this
      // contributes no key at all, so JSON.stringify emits the exact same
      // bytes as before team mode was reachable from this client. Present —
      // including an explicit 1 — it overrides the kernel's persisted
      // default, which is the only way "back to solo" is honoured.
      ...(team === undefined ? {} : { team }),
    });
    // A run was just accepted onto the wire — arm/reset the liveness clocks so
    // a wedge is measured from "we asked" rather than stale prior activity.
    this.beginRun();
  }

  /** Explicitly resume a workflow from its durable stage manifest. */
  resumeWorkflow(opts: RunOptions, sourceRunId: string): void {
    this.run({
      ...opts,
      workflowResumeRunId: validateWorkflowResumeRunId(sourceRunId),
    });
  }

  /**
   * Autonomous goal-continuation mode (kernel `_handle_goal` -> `run_goal_loop`).
   * The kernel keeps self-generating continuation prompts (restating the goal)
   * until the goal is achieved, confidently unachievable, or a safety bound
   * trips (max continuations / no-progress / budget). Bounded + fail-closed;
   * candidateOnly, canClaimAGI:false. See docs/09-Agent/Goal-Continuation-Harness.md.
   */
  goal(opts: {
    prompt: string; model?: string; mode?: string; permission?: string;
    runtime?: "sophia" | "prime";
    session?: string; maxSteps?: number; cwd?: string; deepThink?: boolean;
    deepMode?: boolean; effort?: string; reasoningEffort?: string;
    responseStyle?: ResponseStyle;
    conscienceMode?: ConscienceMode;
    maxContinuations?: number; maxNoProgress?: number;
    achievedThreshold?: number; unachievableThreshold?: number;
  }): void {
    const effort = opts.reasoningEffort || opts.effort || process.env.SOPHIA_REASONING_EFFORT || "medium";
    this.send({
      cmd: "goal",
      prompt: opts.prompt,
      ...(opts.runtime === "prime" ? { runtime: "prime" as const } : {}),
      model: opts.model || "mock",
      mode: opts.mode || "balanced",
      permission: opts.permission || "manual",
      session: opts.session || "tui-default",
      maxSteps: opts.maxSteps ?? 12,
      cwd: validateBridgeCwd(this.repoRoot, opts.cwd || this.repoRoot),
      deepThink: !!opts.deepThink || effort === "ultramode" || effort === "high",
      deepMode: !!opts.deepMode,
      reasoningEffort: effort,
      effort,
      ...(opts.conscienceMode === undefined ? {} : { conscienceMode: opts.conscienceMode }),
      ...(opts.responseStyle === undefined ? {} : { responseStyle: opts.responseStyle }),
      maxContinuations: opts.maxContinuations ?? 8,
      maxNoProgress: opts.maxNoProgress ?? 3,
      achievedThreshold: opts.achievedThreshold ?? 0.8,
      unachievableThreshold: opts.unachievableThreshold ?? 0.8,
    });
    this.beginRun();
  }

  /**
   * Control or start the durable AGI-shaped controller. Enabling/disabling only
   * changes future routing; pause/stop are observed at the next safe phase
   * boundary and never signal arbitrary PIDs.
   */
  agi(opts: {
    action: "on" | "off" | "profile" | "route" | "status" | "pause" | "stop" | "approve" | "resume" | "start";
    session?: string;
    runId?: string;
    actionId?: string;
    prompt?: string;
    profile?: "conservative" | "balanced" | "deep";
    route?: "auto" | "fast" | "deliberative" | "critical";
    model?: string;
    mode?: string;
    permission?: string;
    cwd?: string;
    effort?: string;
    reasoningEffort?: string;
    responseStyle?: ResponseStyle;
    conscienceMode?: ConscienceMode;
    plannerModel?: string;
    workerModel?: string;
    verifierModel?: string;
  }): void {
    const effort =
      opts.reasoningEffort
      || opts.effort
      || process.env.SOPHIA_REASONING_EFFORT
      || "medium";
    this.send({
      cmd: "agi",
      action: opts.action,
      ...(opts.session ? { session: opts.session } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.actionId ? { actionId: opts.actionId } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(opts.profile ? { profile: opts.profile, agiProfile: opts.profile } : {}),
      ...(opts.route ? { route: opts.route, agiRoute: opts.route } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.permission ? { permission: opts.permission } : {}),
      ...(opts.cwd ? { cwd: validateBridgeCwd(this.repoRoot, opts.cwd) } : {}),
      reasoningEffort: effort,
      effort,
      ...(opts.responseStyle ? { responseStyle: opts.responseStyle } : {}),
      ...(opts.conscienceMode ? { conscienceMode: opts.conscienceMode } : {}),
      ...(opts.plannerModel ? { agiPlannerModel: opts.plannerModel } : {}),
      ...(opts.workerModel ? { agiWorkerModel: opts.workerModel } : {}),
      ...(opts.verifierModel ? { agiVerifierModel: opts.verifierModel } : {}),
    });
    if (opts.action === "start" || opts.action === "resume" || opts.action === "approve") this.beginRun();
  }

  approve(id: string, allow: boolean): void {
    this.send({ cmd: "approve", id, allow });
  }

  /** Compact this session's stored history now (see kernel _handle_compact). */
  compact(session?: string, model?: string): void {
    this.send({ cmd: "compact", ...(session ? { session } : {}), ...(model ? { model } : {}) });
  }

  /**
   * Request a read-only OKF belief-graph projection for the /graph audit panel.
   * The kernel replies with a single `graph_projection` event carrying the
   * `sophia.graph_projection.v1` document plus a monotonic `sequence` (the
   * reducer's isStaleSnapshot drops out-of-order reads). Omitted scope fields
   * are left off the wire so the kernel applies its own defaults (root-scoped
   * depth 2 when an entity is given, else unscoped). Provenance tooling only:
   * candidateOnly, canClaimAGI:false (also enforced globally by emit()).
   */
  graphProjection(opts: { root?: string; domain?: string; depth?: number } = {}): void {
    this.send({
      cmd: "graph",
      ...(opts.root ? { root: opts.root } : {}),
      ...(opts.domain ? { domain: opts.domain } : {}),
      ...(typeof opts.depth === "number" ? { depth: opts.depth } : {}),
    });
  }

  /**
   * Run agent.model_bench head-to-head across `models`, streaming per-case
   * progress as top-level `bench_progress` events and a final `bench_result`
   * carrying the markdown comparison table (see kernel _handle_bench).
   * Methodology tooling only: candidateOnly, canClaimAGI:false.
   */
  bench(models: string[], corpus: "knowledge" | "tool-use" | "trigger" = "knowledge",
        maxCases = 20, warmup = true): void {
    this.send({ cmd: "bench", models: models.join(","), corpus, maxCases, warmup });
  }

  /**
   * Run terminal-bench 2.1 tasks through the agent loop against the current
   * model (oMLX by default). Streams `tbench_progress` per task and a final
   * `tbench_result` with the scorecard. Errors are auto-recorded as OKF memory
   * and a fix-capture pass writes a structured lesson back so the next run
   * recalls it. Methodology tooling only: candidateOnly, canClaimAGI:false.
   *
   * ``opts.docker`` switches to FAITHFUL container scoring: the agent works
   * INSIDE the task's image (Apple `container` + Rosetta on Apple Silicon) and is
   * scored by tests/test.sh → reward.txt — the terminal-bench contract. Without
   * it, scoring is host-best-effort.
   */
  tbench(mode: "list" | "smoke" | "subset" | "task" = "smoke", n = 5,
         opts?: { models?: string; names?: string[]; maxSteps?: number; docker?: boolean }): void {
    this.send({ cmd: "tbench", mode, n,
      ...(opts?.docker ? { docker: true } : {}),
      ...(opts?.models ? { models: opts.models } : {}),
      ...(opts?.names ? { names: opts.names } : {}),
      ...(opts?.maxSteps ? { maxSteps: opts.maxSteps } : {}) });
  }

  /**
   * Pull latest origin/main, rebuild the TUI + release, and reinstall the CLI.
   * Streams `update_progress` per step and a final `update_result`.
   */
  update(repo?: string): void {
    this.send({ cmd: "update", ...(repo ? { repo } : {}) });
  }

  /**
   * GAIA benchmark — per-level harness diagnostic. Streams `gaia_progress` per
   * question and a final `gaia_result` with the per-level breakdown + weakness
   * diagnosis. candidateOnly, canClaimAGI:false. level=undefined=all, n=per-level cap.
   */
  gaia(opts?: { level?: number; n?: number; models?: string; maxSteps?: number }): void {
    this.send({ cmd: "gaia",
      ...(opts?.level != null ? { level: opts.level } : {}),
      ...(opts?.n != null ? { n: opts.n } : {}),
      ...(opts?.models ? { models: opts.models } : {}),
      ...(opts?.maxSteps != null ? { maxSteps: opts.maxSteps } : {}) });
  }

  /**
   * τ-bench reliability (pass^k) — measures harness flakiness, not peak score.
   * Streams `taubench_progress` per (task,trial) and a final `taubench_result`
   * with the pass^k curve + reliability diagnosis. candidateOnly, canClaimAGI:false.
   */
  taubench(opts?: { domain?: string; numTrials?: number; n?: number; taskIds?: number[];
                    userModel?: string; models?: string; maxSteps?: number }): void {
    this.send({ cmd: "taubench",
      ...(opts?.domain ? { domain: opts.domain } : {}),
      ...(opts?.numTrials != null ? { numTrials: opts.numTrials } : {}),
      ...(opts?.n != null ? { n: opts.n } : {}),
      ...(opts?.taskIds ? { taskIds: opts.taskIds } : {}),
      ...(opts?.userModel ? { userModel: opts.userModel } : {}),
      ...(opts?.models ? { models: opts.models } : {}),
      ...(opts?.maxSteps != null ? { maxSteps: opts.maxSteps } : {}) });
  }

  /** requestId is opt-in and triggers the reliable/idempotent dispatch path (see sendReliable). */
  cancel(requestId?: string, reason: CancelReason = "user_cancel"): ReliableBridgeCommand | void {
    if (!requestId) {
      this.send({ cmd: "cancel", reason });
      return;
    }
    return this.sendReliable({ cmd: "cancel", reason }, { requestId });
  }

  setSettings(patch: Record<string, unknown>): void {
    this.send({ cmd: "settings", ...patch });
  }

  plugin(command: PluginCommand, cwd?: string): void {
    this.send({
      cmd: "plugin",
      action: command.action,
      ...(command.pluginId ? { pluginId: command.pluginId } : {}),
      ...(command.reference ? { reference: command.reference } : {}),
      ...(command.source ? { source: command.source } : {}),
      ...(command.path ? { path: command.path } : {}),
      ...(command.compatibilityId
        ? { compatibilityId: command.compatibilityId }
        : {}),
      ...(command.tool ? { tool: command.tool } : {}),
      ...(command.input ? { input: command.input } : {}),
      ...(command.query ? { query: command.query } : {}),
      ...(command.contribution?.length
        ? { contribution: command.contribution }
        : {}),
      ...(command.capability?.length
        ? { capability: command.capability }
        : {}),
      ...(command.protocol?.length ? { protocol: command.protocol } : {}),
      ...(command.hostProtocols?.length
        ? { hostProtocols: command.hostProtocols }
        : {}),
      ...(command.platform ? { platform: command.platform } : {}),
      ...(command.architecture ? { architecture: command.architecture } : {}),
      ...(command.version ? { version: command.version } : {}),
      ...(command.eligibleOnly ? { eligibleOnly: true } : {}),
      ...(command.allowStale ? { allowStale: true } : {}),
      ...(command.allowPrerelease ? { allowPrerelease: true } : {}),
      ...(command.approvePermissions
        ? { approvePermissions: true }
        : {}),
      ...(command.approveSettings
        ? { approveSettings: true }
        : {}),
      ...(command.approvalToken
        ? { approvalToken: command.approvalToken }
        : {}),
      ...(command.approveInstall
        ? { approveInstall: true }
        : {}),
      ...(typeof command.enabled === "boolean"
        ? { enabled: command.enabled }
        : {}),
      ...(command.lease ? { lease: command.lease } : {}),
      ...(command.session ? { session: command.session } : {}),
      ...(cwd ? { cwd: validateBridgeCwd(this.repoRoot, cwd) } : {}),
    });
  }

  listSessions(limit = 50): void {
    this.send({ cmd: "sessions", limit });
  }

  loadSession(session: string): void {
    const name = String(session || "").trim() || "tui-default";
    this.send({ cmd: "session_load", session: name });
  }

  /**
   * Dispatch one explicit versioned compound-workflow command.
   *
   * Replay is deliberately a different authority surface: it is session
   * scoped, has no run key or plan, and never executes an operation. Run,
   * resume, status, and events address one stable run key; only run carries a
   * canonical plan.
   */
  compoundWorkflow(
    options: CompoundWorkflowCommandOptions,
  ): ReliableBridgeCommand {
    if (!COMPOUND_WORKFLOW_ACTIONS.has(options.action)) {
      throw new Error("invalid compound workflow action");
    }
    const session = validateCompoundWorkflowSession(options.session);
    const command: Record<string, unknown> = {
      cmd: "compound_workflow",
      action: options.action,
      workflowCommandVersion: 1,
      session,
    };
    if (options.action === "replay") {
      if (options.workflowRunKey !== undefined || options.plan !== undefined) {
        throw new Error("replay cannot include a workflow run key or plan");
      }
    } else {
      command.workflowRunKey = validateCompoundWorkflowRunKey(options.workflowRunKey);
      if (options.action === "run") {
        if (!options.plan || typeof options.plan !== "object" || Array.isArray(options.plan)) {
          throw new Error("run requires a compound workflow plan");
        }
        command.plan = options.plan;
      } else if (options.plan !== undefined) {
        throw new Error("only run may include a compound workflow plan");
      }
    }
    return this.sendReliable(
      command,
      options.requestId ? { requestId: options.requestId } : {},
    );
  }

  runCompoundWorkflow(
    session: string,
    workflowRunKey: string,
    plan: Record<string, unknown>,
    requestId?: string,
  ): ReliableBridgeCommand {
    return this.compoundWorkflow({
      action: "run",
      session,
      workflowRunKey,
      plan,
      requestId,
    });
  }

  resumeCompoundWorkflow(
    session: string,
    workflowRunKey: string,
    requestId?: string,
  ): ReliableBridgeCommand {
    return this.compoundWorkflow({
      action: "resume",
      session,
      workflowRunKey,
      requestId,
    });
  }

  statusCompoundWorkflow(
    session: string,
    workflowRunKey: string,
    requestId?: string,
  ): ReliableBridgeCommand {
    return this.compoundWorkflow({
      action: "status",
      session,
      workflowRunKey,
      requestId,
    });
  }

  eventsCompoundWorkflow(
    session: string,
    workflowRunKey: string,
    requestId?: string,
  ): ReliableBridgeCommand {
    return this.compoundWorkflow({
      action: "events",
      session,
      workflowRunKey,
      requestId,
    });
  }

  /**
   * Replay only durable compound-graph events for one session namespace.
   * This never loads a transcript and never invokes a workflow operation, so
   * it is safe on bridge ready/reconnect without silently resuming a chat.
   */
  replayCompoundWorkflows(
    session: string,
    requestId?: string,
  ): ReliableBridgeCommand {
    return this.compoundWorkflow({
      action: "replay",
      session,
      requestId,
    });
  }

  /** Non-throwing session load for slash handlers — returns false if bridge is down. */
  tryLoadSession(session: string): { ok: true } | { ok: false; error: string } {
    try {
      this.loadSession(session);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  steer(prompt: string, runId: string, session: string, requestId?: string): ReliableBridgeCommand {
    return this.sendReliable(
      { cmd: "steer", prompt, runId, session },
      requestId ? { requestId } : {},
    );
  }

  /**
   * Queue a distinct next run. Unlike steer(), this never mutates the active
   * run; the kernel acknowledges queue position and starts it after the current
   * terminal boundary (or immediately when idle).
   */
  queueNext(
    prompt: string,
    options: Omit<RunOptions, "prompt"> & { requestId?: string } = {},
  ): ReliableBridgeCommand {
    const effort =
      options.reasoningEffort
      || options.effort
      || process.env.SOPHIA_REASONING_EFFORT
      || "medium";
    return this.sendReliable({
      cmd: "queue_next",
      prompt,
      ...(options.runtime ? { runtime: options.runtime } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.permission ? { permission: options.permission } : {}),
      ...(options.session ? { session: options.session } : {}),
      ...(options.maxSteps != null ? { maxSteps: options.maxSteps } : {}),
      ...(options.cwd ? { cwd: validateBridgeCwd(this.repoRoot, options.cwd) } : {}),
      ...(options.deepThink != null ? { deepThink: options.deepThink } : {}),
      ...(options.deepMode != null ? { deepMode: options.deepMode } : {}),
      reasoningEffort: effort,
      effort,
      ...(options.autoGoal != null ? { autoGoal: options.autoGoal } : {}),
      ...(options.autoTeam != null ? { autoTeam: options.autoTeam } : {}),
      ...(Number.isFinite(options.a2aAgents) && Number(options.a2aAgents) >= -1
        ? { a2aAgents: Math.floor(Number(options.a2aAgents)) }
        : {}),
      ...(options.a2aExecution ? { a2aExecution: options.a2aExecution } : {}),
      ...(options.terminalLayout ? { terminalLayout: options.terminalLayout } : {}),
      ...(options.workflowMode ? { workflowMode: options.workflowMode } : {}),
      ...(Number.isFinite(options.workflowMaxStages)
        ? { workflowMaxStages: Math.floor(Number(options.workflowMaxStages)) }
        : {}),
      ...(Number.isFinite(options.workflowMaxAgents)
        ? { workflowMaxAgents: Math.floor(Number(options.workflowMaxAgents)) }
        : {}),
      ...(options.agiMode == null ? {} : { agiMode: options.agiMode }),
      ...(options.agiWorkflowMode
        ? { agiWorkflowMode: options.agiWorkflowMode }
        : {}),
      ...(options.agiProfile ? { agiProfile: options.agiProfile } : {}),
      ...(options.agiRoute ? { agiRoute: options.agiRoute } : {}),
      ...(options.agiPlannerModel ? { agiPlannerModel: options.agiPlannerModel } : {}),
      ...(options.agiWorkerModel ? { agiWorkerModel: options.agiWorkerModel } : {}),
      ...(options.agiVerifierModel ? { agiVerifierModel: options.agiVerifierModel } : {}),
      ...(options.agiResumeRunId ? { agiResumeRunId: options.agiResumeRunId } : {}),
      ...(options.responseStyle != null ? { responseStyle: options.responseStyle } : {}),
      ...(Number.isFinite(options.team) && Number(options.team) >= 1
        ? { team: Math.floor(Number(options.team)) }
        : {}),
    }, options.requestId ? { requestId: options.requestId } : {});
  }

  diagnosticSnapshot(options: {
    runId?: string;
    session?: string;
    retainCompleted?: boolean;
    requestId?: string;
  } = {}): ReliableBridgeCommand {
    return this.sendReliable({
      cmd: "snapshot",
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.session ? { session: options.session } : {}),
      ...(options.retainCompleted === undefined
        ? {}
        : { retainCompleted: options.retainCompleted }),
    }, options.requestId ? { requestId: options.requestId } : {});
  }

  mcpHealth(options: {
    probe?: boolean;
    timeoutMs?: number;
    requestId?: string;
  } = {}): ReliableBridgeCommand {
    return this.sendReliable({
      cmd: "mcp_health",
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
    }, options.requestId ? { requestId: options.requestId } : {});
  }

  providerLogin(options: {
    action?: string;
    provider?: string;
    requestId?: string;
  } = {}): ReliableBridgeCommand {
    const action = options.action || options.provider || "status";
    return this.sendReliable(
      {
        cmd: "provider_login",
        action,
        provider: action,
      },
      options.requestId ? { requestId: options.requestId } : {},
    );
  }

  providerHealth(options: {
    providers?: string[];
    includeModels?: boolean;
    allowRemoteMetadata?: boolean;
    timeoutSec?: number;
    requestId?: string;
    callId?: string;
    attempt?: number;
  } = {}): ReliableBridgeCommand {
    return this.sendReliable(
      {
        cmd: "provider_health",
        ...(options.providers?.length ? { providers: options.providers } : {}),
        ...(options.includeModels === undefined ? {} : { includeModels: options.includeModels }),
        ...(options.allowRemoteMetadata === undefined
          ? {}
          : { allowRemoteMetadata: options.allowRemoteMetadata }),
        ...(options.timeoutSec === undefined ? {} : { timeoutSec: options.timeoutSec }),
      },
      {
        requestId: options.requestId,
        callId: options.callId,
        attempt: options.attempt,
      },
    );
  }

  /**
   * Manage user-defined model endpoint profiles. Credential storage is
   * intentionally excluded from this retryable helper: the one-time secret
   * command must travel through sendOneShotSecret() so it is retained in
   * neither the reliable retry surface nor the application backpressure queue.
   */
  modelConnection(
    command: Record<string, unknown>,
    metadata: { requestId?: string; callId?: string; attempt?: number } = {},
  ): ReliableBridgeCommand {
    if (command.action === "store_credential" || "credentialValue" in command) {
      throw new Error(
        "credential storage is non-retryable; send the one-time command directly",
      );
    }
    return this.sendReliable(
      { cmd: "model_connection", ...command },
      metadata,
    );
  }

  /**
   * `/hooks`-status: the real loaded PreToolUse/PostToolUse/Stop config plus
   * recent dispatch outcomes (kernel `_handle_hooks`), replacing a client-side
   * echo of the slash catalog's own description. `cwd` selects which
   * workspace's `.sophia/hooks.toml` to resolve; omitted uses the bridge's own
   * root.
   */
  hooks(cwd?: string): void {
    this.send({ cmd: "hooks", ...(cwd ? { cwd } : {}) });
  }

  /**
   * Operator-typed workspace shell. Kernel ``execute_tool("bash")`` owns
   * permission, hooks, and destructive confirmation. The TUI never spawns a
   * local child.
   */
  shell(options: {
    command: string;
    cwd: string;
    permission: "auto" | "manual" | "readonly";
    session?: string;
    requestId?: string;
  }): ReliableBridgeCommand {
    return this.sendReliable(
      {
        cmd: "shell",
        command: options.command,
        cwd: validateBridgeCwd(this.repoRoot, options.cwd),
        permission: options.permission,
        ...(options.session ? { session: options.session } : {}),
      },
      options.requestId ? { requestId: options.requestId } : {},
    );
  }

  /**
   * List this run/session's captured file checkpoints, oldest first (kernel
   * `_handle_checkpoints`). `session` omitted resolves to the bridge's most
   * recently active tool context.
   */
  checkpoints(session?: string): void {
    this.send({ cmd: "checkpoints", ...(session ? { session } : {}) });
  }

  /**
   * Restore the most recently captured file checkpoint for a session. The
   * kernel refuses this (an `error` event, not `checkpoint_result`) while a
   * run is active.
   */
  checkpointUndo(session?: string): void {
    this.send({ cmd: "checkpoint_undo", ...(session ? { session } : {}) });
  }

  /**
   * Restore one specific file checkpoint by id. Same active-run refusal as
   * checkpointUndo().
   */
  checkpointRestore(id: string, session?: string): void {
    this.send({ cmd: "checkpoint_restore", id, ...(session ? { session } : {}) });
  }

  /**
   * Machine-wide local-runtime report (installed/running engines, model
   * counts, a setup recommendation) for a `/config status|recommend`-style
   * view. Resolves on a kernel background thread (`_handle_local_engine_report`),
   * so the reply may arrive after later events — pass requestId to correlate it.
   */
  localEngineReport(options: { requestId?: string } = {}): ReliableBridgeCommand {
    return this.sendReliable(
      { cmd: "local_engine_report" },
      options.requestId ? { requestId: options.requestId } : {},
    );
  }

  /** What SOPHIA_MLX_ADAPTER currently points at, plus cached adapter names (kernel `_handle_adapter_status`). */
  adapterStatus(): void {
    this.send({ cmd: "adapter_status" });
  }

  /**
   * On-demand readiness check for a model spec, without starting a run — the
   * same check `_run_guarded` runs automatically at run start (see the
   * auto-emitted `model_preflight` event), exposed directly for a `/model`
   * picker to show readiness before the operator commits to switching.
   * `model` omitted resolves to the persisted default. Resolves on a kernel
   * background thread — pass requestId to correlate the reply.
   */
  modelPreflight(options: { model?: string; requestId?: string } = {}): ReliableBridgeCommand {
    return this.sendReliable(
      { cmd: "model_preflight", ...(options.model ? { model: options.model } : {}) },
      options.requestId ? { requestId: options.requestId } : {},
    );
  }

  image(options: {
    prompt: string;
    output?: string;
    provider?: string;
    cwd: string;
    permission: "auto" | "manual" | "readonly";
    confirm: boolean;
    timeoutSec?: number;
    requestId?: string;
  }): ReliableBridgeCommand {
    return this.sendReliable(
      {
        cmd: "image",
        prompt: options.prompt,
        cwd: validateBridgeCwd(this.repoRoot, options.cwd),
        permission: options.permission,
        confirm: options.confirm,
        ...(options.output ? { output: options.output } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.timeoutSec === undefined ? {} : { timeoutSec: options.timeoutSec }),
      },
      options.requestId ? { requestId: options.requestId } : {},
    );
  }

  mcpTimeouts(options: {
    connectMs?: number;
    requestMs?: number;
    requestId?: string;
  } = {}): ReliableBridgeCommand {
    return this.sendReliable({
      cmd: "mcp_timeouts",
      ...(options.connectMs == null ? {} : { connectMs: options.connectMs }),
      ...(options.requestMs == null ? {} : { requestMs: options.requestMs }),
    }, options.requestId ? { requestId: options.requestId } : {});
  }

  /**
   * List task/workflow nodes.
   *
   * `retainCompleted` is OPTIONAL and omitted from the wire when undefined, so
   * the kernel's context-sensitive default can actually be reached. It picks
   * `bool(runId or session)` (agent/code_bridge.py::_handle_tasks): a caller
   * naming a target wants that target's finished nodes too, while an unscoped
   * "what is happening right now" call should not be handed every run this
   * machine ever recorded. Defaulting the parameter to `true` here serialized
   * it on every call and made that branch unreachable — the client silently
   * decided a policy the kernel is the authority on.
   */
  listTasks(runId?: string, session?: string, retainCompleted?: boolean, requestId?: string): void {
    this.send({
      cmd: "tasks",
      ...(runId ? { runId } : {}),
      ...(session ? { session } : {}),
      ...(retainCompleted === undefined ? {} : { retainCompleted }),
      ...(requestId ? { requestId } : {}),
    });
  }

  taskAction(runId: string, taskId: string, action: "cancel" | "retry", requestId?: string): void {
    this.send({ cmd: "task_action", runId, taskId, action, ...(requestId ? { requestId } : {}) });
  }

  taskLog(runId: string, taskId: string, requestId?: string): void {
    this.send({ cmd: "task_log", runId, taskId, ...(requestId ? { requestId } : {}) });
  }

  stop(timeoutMs = 1000): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    this.stopPromise = (async () => {
      try {
        this.send({ cmd: "shutdown" });
      } catch {
        /* process may already be gone */
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          if (this.ownedChildren.has(proc)) {
            try { proc.kill("SIGTERM"); } catch { /* ignore */ }
          }
          finish();
        }, timeoutMs);
        proc.once("exit", finish);
      });
      if (this.proc === proc) {
        this.proc = null;
        this.ready = false;
        this.readyEvent = null;
      }
    })().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  isReady(): boolean {
    return this.ready;
  }
}
