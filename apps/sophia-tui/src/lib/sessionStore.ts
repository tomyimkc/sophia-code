/**
 * Local session transcripts for resume — read from disk in the TUI process.
 *
 * Why not only via the code_bridge NDJSON `session_load` event?
 * The bridge used to emit the *entire* conversation as one JSON line (50–100KB+).
 * That single-line payload is fragile over the pipe (parse failures become type:"log")
 * and freezes Ink when rehydrating every tool dump. Kernel still loads the same files
 * for history= on the next run; the TUI only needs a scannable UI projection.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  readFile as readFileAsync,
  readdir as readdirAsync,
  stat as statAsync,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { BridgeEvent } from "./bridge.js";
import { sanitizeTerminalText } from "./chatLayout.js";
import { type ChatMessage, classifyToolResult, shouldAutoCollapse, uid } from "./types.js";
import { TRANSCRIPT_ROW_CHAR_CAP } from "./finalAnswer.js";

const RESUME_UI_MAX_TURNS = 60;
const SESSION_SEARCH_QUERY_MAX_CHARS = 256;
const SESSION_SEARCH_QUERY_MAX_TERMS = 12;
const SESSION_SEARCH_PREVIEW_MAX_CHARS = 160;
const SESSION_SEARCH_BATCH_SIZE = 8;

export function conversationsDir(): string {
  const override = process.env.SOPHIA_CONVERSATIONS_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  const state =
    process.env.SOPHIA_STATE_DIR ||
    process.env.SOPHIA_USER_STATE ||
    path.join(os.homedir(), ".sophia");
  return path.join(state, "agent_runs", "agent_loop", "conversations");
}

/**
 * The conversation file for a session name — byte-identical to the kernel's.
 *
 * agent/cli.py::_conversation_path is the source of truth: the bridge loads
 * history from THAT file and replays it into the model. This helper diverged
 * from it three ways, so the pane could show one transcript while the model was
 * fed another (or an empty one):
 *
 *   "Feature #7"  kernel Feature__7.json   was  Feature_7.json   (run collapsing)
 *   "café"        kernel café.json         was  caf.json         (Unicode alnum)
 *   "  spaced  "  kernel __spaced__.json   was  spaced.json      (edge trimming)
 *
 * The kernel maps each character INDIVIDUALLY, keeps any Unicode letter/digit
 * (python's str.isalnum is Unicode-aware), and trims nothing. Mirror it exactly
 * rather than "improving" it — a prettier name here is a silently split
 * conversation.
 */
export function conversationPath(session: string): string {
  const raw = String(session || "tui-default");
  let safe = "";
  for (const ch of raw) {
    safe += /\p{L}|\p{N}/u.test(ch) || ch === "-" || ch === "_" || ch === "." ? ch : "_";
  }
  return path.join(conversationsDir(), `${safe || "default"}.json`);
}

export function provenanceDir(session: string): string {
  const conversation = conversationPath(session);
  return path.join(path.dirname(conversation), ".provenance", path.basename(conversation, ".json"));
}

export interface DiskTurn {
  role?: string;
  content?: string;
}

interface SessionHistoryExchange {
  prompt: string;
  assistant: string;
  tools: Array<{ name: string; failed: boolean }>;
}

export type SessionSearchField =
  | "id"
  | "title"
  | "topic"
  | "last-user"
  | "user"
  | "assistant"
  | "tool"
  | "system";

export interface SessionContentMatch {
  field: SessionSearchField;
  preview: string;
  occurrences: number;
  score: number;
}

export interface SessionListItem {
  id: string;
  name: string;
  path: string;
  turns: number;
  updatedAt: number;
  lastPreview: string;
  /** First real user message — what the session is *about* (its topic/goal). */
  description: string;
  /** Relative last-activity time, e.g. "2h ago" / "3d ago". */
  recency: string;
  /** Optional operator title stored outside the legacy transcript JSON array. */
  title?: string;
  /** Local-only labels; absent for legacy sessions with no metadata sidecar. */
  tags?: string[];
  /** Parent session id when this session was created as a fork. */
  parentSessionId?: string;
  /** Number of durable transcript checkpoints retained for this session. */
  checkpointCount?: number;
  /** Active rows are false; archived rows returned by listArchivedSessionsFromDisk are true. */
  archived?: boolean;
  /** Ephemeral local search evidence; never written to the session index or support bundle. */
  match?: SessionContentMatch;
}

/** Human relative time ("just now", "5m ago", "2h ago", "3d ago") for the picker. */
export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clip(text: string, cap = TRANSCRIPT_ROW_CHAR_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + "\n… [truncated for display — full turn on disk]";
}

/** Match the kernel's exact-paragraph repetition circuit breaker for resume UI. */
export function isDegenerateRepeatedResponse(text: string): boolean {
  const raw = String(text || "").trim();
  if (raw.length < 800) return false;
  const units = raw
    .split(/\n\s*\n+/)
    .map((part) => part.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((part) => part.length >= 60);
  if (units.length < 4) return false;
  const counts = new Map<string, number>();
  for (const unit of units) counts.set(unit, (counts.get(unit) || 0) + 1);
  let maxRepeat = 1;
  let repeatedChars = 0;
  let unitChars = 0;
  for (const [unit, count] of counts) {
    maxRepeat = Math.max(maxRepeat, count);
    repeatedChars += Math.max(0, count - 1) * unit.length;
  }
  for (const unit of units) unitChars += unit.length;
  return maxRepeat >= 3 && repeatedChars >= 400 && repeatedChars / Math.max(1, unitChars) >= 0.25;
}

/**
 * Kernel often packs several tool results into ONE user turn:
 *   [tool:read_file]\n...\n\n[tool:outline]\n...\n\n[tool:]\nERROR...
 * Split them so each gets its own ✓/✗ mark (otherwise one ERROR taints the batch).
 */
function pushToolFeedbackBlocks(out: ChatMessage[], content: string): void {
  const parts = content.split(/\n(?=\[tool(?::[^\]]*)?\])/);
  for (const part of parts) {
    const block = part.trim();
    if (!block) continue;
    if (block.startsWith("[tool_call_skipped]")) {
      out.push({
        id: uid(),
        role: "tool",
        meta: "skipped",
        text: clip(block.replace(/^\[tool_call_skipped\]\s*/, ""), 400),
        ok: false,
      });
      continue;
    }
    if (!block.startsWith("[tool")) continue;
    const m = block.match(/^\[tool:([^\]]*)\]/);
    const rawName = (m ? m[1] : "").trim();
    const body = block.includes("\n") ? block.split("\n").slice(1).join("\n") : "";
    // Shared classifier with the live-run path (App.tsx) so a tool row shows
    // the same ✓/✗ during the run and after resume. Fail only when THIS block
    // is an error payload — not when a sibling tool failed.
    const { failed, meta } = classifyToolResult({ toolName: rawName, body });
    out.push({
      id: uid(),
      role: "tool",
      meta,
      text: clip(body || (failed ? "(failed)" : "(ok)"), 600),
      ok: !failed,
    });
  }
}

/** Project disk turns into TUI messages (tool rows truncated, newest kept). */
export function turnsToChatMessages(turns: DiskTurn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const item = turns[index];
    const content = String(item.content || "");
    if (!content.trim()) continue;
    const rawRole = String(item.role || "user");
    if (rawRole === "assistant") {
      const next = turns[index + 1];
      const rejectedByKernelNudge =
        String(next?.role || "") === "user" &&
        isAgentContinuationNudge(String(next?.content || ""));
      // Assistant prose followed immediately by a kernel continuation nudge was
      // explicitly rejected as a final answer. It belongs in the audit file,
      // not as a user-visible chat answer after resume.
      if (rejectedByKernelNudge) continue;
      if (isDegenerateRepeatedResponse(content)) {
        out.push({
          id: uid(),
          role: "system",
          text: "[repetitive model response hidden in the UI — full rejected turn remains on disk]",
          ok: false,
        });
        continue;
      }
      if (/^\[native tool calls/.test(content.trim()) || /^\[incomplete native/.test(content.trim())) {
        out.push({ id: uid(), role: "system", text: clip(content, 200) });
        continue;
      }
      out.push({
        id: uid(),
        role: "assistant",
        text: clip(content),
        collapsed: shouldAutoCollapse(content),
      });
      continue;
    }
    if (rawRole === "user" && isAgentContinuationNudge(content)) {
      // These are harness steering prompts, not operator-authored chat turns.
      continue;
    }
    if (rawRole === "system") {
      out.push({ id: uid(), role: "system", text: clip(content, 600) });
      continue;
    }
    // Multi-tool feedback blob (kernel packs parallel results into one user turn)
    if (content.includes("[tool:") || content.startsWith("[tool") || content.startsWith("[tool_call_skipped]")) {
      pushToolFeedbackBlocks(out, content);
      continue;
    }
    if (content.startsWith("[native tool calls") || content.startsWith("[incomplete native")) {
      out.push({ id: uid(), role: "system", text: clip(content, 200) });
      continue;
    }
    // Real user goals
    out.push({ id: uid(), role: "user", text: clip(content) });
  }
  let projected: ChatMessage[];
  if (out.length > RESUME_UI_MAX_TURNS) {
    const dropped = out.length - RESUME_UI_MAX_TURNS;
    projected = [
      {
        id: uid(),
        role: "system",
        text: `… ${dropped} earlier turn(s) hidden in UI (still on disk for the model)`,
      },
      ...out.slice(-RESUME_UI_MAX_TURNS),
    ];
  } else {
    projected = out;
  }
  // On resume, the LAST assistant turn is the most relevant content — auto-
  // collapse is fine for the rest (keeps a long transcript scannable), but the
  // final answer should be visible without an extra keypress. Live runs set
  // `collapsed` inline at the push site and are unaffected.
  for (let i = projected.length - 1; i >= 0; i--) {
    if (projected[i].role === "assistant") {
      projected[i] = { ...projected[i], collapsed: false };
      break;
    }
  }
  return projected;
}

function flowSummary(value: string, max = 120): string {
  const text = sanitizeTerminalText(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function toolBlocksForHistory(content: string): Array<{ name: string; failed: boolean }> {
  const blocks = content.split(/\n(?=\[tool(?::[^\]]*)?\])/);
  const tools: Array<{ name: string; failed: boolean }> = [];
  for (const part of blocks) {
    const block = part.trim();
    if (!block.startsWith("[tool")) continue;
    if (block.startsWith("[tool_call_skipped]")) {
      tools.push({ name: "skipped", failed: true });
      continue;
    }
    const match = block.match(/^\[tool:([^\]]*)\]/);
    const name = String(match?.[1] || "").trim();
    const body = block.includes("\n")
      ? block.split("\n").slice(1).join("\n")
      : "";
    tools.push({
      name: name || "(empty)",
      failed: classifyToolResult({ toolName: name, body }).failed,
    });
  }
  return tools;
}

/**
 * Rebuild the durable, high-level flow for one resumed conversation.
 *
 * Conversation JSON stores transcript turns rather than the live bridge event
 * stream. This produces a bounded protocol-compatible replay: one main-agent
 * run, one workflow summary (plus safe tool names), and one output receipt per
 * genuine user exchange. It never copies raw tool bodies or hidden reasoning.
 */
export function sessionFlowEventsFromTurns(
  sessionId: string,
  turns: readonly DiskTurn[],
): BridgeEvent[] {
  const exchanges: SessionHistoryExchange[] = [];
  let currentIndex = -1;
  const startExchange = (prompt: string): SessionHistoryExchange => {
    const exchange: SessionHistoryExchange = {
      prompt: flowSummary(prompt),
      assistant: "",
      tools: [],
    };
    exchanges.push(exchange);
    currentIndex = exchanges.length - 1;
    return exchange;
  };

  for (const turn of turns) {
    const role = String(turn.role || "user");
    const content = String(turn.content || "");
    const trimmed = content.trim();
    if (!trimmed) continue;
    const toolBlocks = toolBlocksForHistory(trimmed);
    if (toolBlocks.length > 0) {
      if (currentIndex >= 0) exchanges[currentIndex]!.tools.push(...toolBlocks);
      continue;
    }
    if (
      trimmed.startsWith("[native tool calls")
      || trimmed.startsWith("[incomplete native")
    ) {
      if (currentIndex >= 0) {
        exchanges[currentIndex]!.tools.push({
          name: "native tools",
          failed: false,
        });
      }
      continue;
    }
    if (role === "user") {
      if (isAgentContinuationNudge(trimmed)) continue;
      startExchange(trimmed);
      continue;
    }
    if (role === "assistant") {
      const exchange =
        currentIndex >= 0
          ? exchanges[currentIndex]!
          : startExchange("Recovered conversation turn");
      exchange.assistant = flowSummary(trimmed);
    }
  }

  const safeSession = flowSummary(sessionId, 80) || "session";
  const events: BridgeEvent[] = [];
  exchanges.forEach((exchange, index) => {
    const ordinal = index + 1;
    const runId = `history:${safeSession}:${ordinal}`;
    const timestamp = (offset: number) =>
      new Date((index * 100 + offset) * 1000).toISOString();
    const eventId = (suffix: string) =>
      `history:${safeSession}:${ordinal}:${suffix}`;
    events.push({
      type: "run_start",
      eventId: eventId("main"),
      runId,
      session: sessionId,
      ts: timestamp(1),
      goal: exchange.prompt || `Conversation turn ${ordinal}`,
      status: "succeeded",
      history: true,
    });
    events.push({
      type: "workflow_history",
      eventId: eventId("workflow"),
      runId,
      session: sessionId,
      ts: timestamp(2),
      status: exchange.assistant ? "succeeded" : "cancelled",
      detail:
        exchange.tools.length > 0
          ? `${exchange.tools.length} recorded tool step${
              exchange.tools.length === 1 ? "" : "s"
            }`
          : "main-agent execution",
      history: true,
    });
    exchange.tools.forEach((tool, toolIndex) => {
      events.push({
        type: "tool_result",
        eventId: eventId(`tool:${toolIndex}`),
        runId,
        session: sessionId,
        ts: timestamp(3 + toolIndex),
        tool: tool.name,
        ok: !tool.failed,
        history: true,
      });
    });
    if (exchange.assistant) {
      events.push({
        type: "result",
        eventId: eventId("output"),
        runId,
        session: sessionId,
        ts: timestamp(80),
        ok: true,
        detail: exchange.assistant,
        history: true,
      });
    }
    events.push({
      type: "run_finished",
      eventId: eventId("finished"),
      runId,
      session: sessionId,
      ts: timestamp(90),
      status: exchange.assistant ? "succeeded" : "cancelled",
      history: true,
    });
  });
  return events;
}

export interface RunProvenance {
  runId: string;
  modelAlias: string;
  workspace: string;
  mode: string;
  startedAt: string;
  status: "succeeded" | "failed" | "cancelled";
  provider: string;
  resolvedModel: string;
  fallbackUsed: boolean;
  cancelReason?: string;
  finishedAt: string;
}

export interface LoadSessionResult {
  ok: boolean;
  session: string;
  path: string;
  turns: number;
  messages: ChatMessage[];
  /** Safe major-step replay for the active session flow graph. */
  flowEvents: BridgeEvent[];
  /** First genuine user prompt from the FULL transcript (see pickTopic) — what
   *  the session is about. Computed before the UI turn-cap drops the opening
   *  goal, so the resume picker can label long autonomous sessions correctly. */
  topic: string;
  provenance?: RunProvenance;
  provenanceWarning?: string;
  error?: string;
}

interface StartProvenanceRecord {
  schema: "sophia.execution-provenance.v1";
  type: "run_start";
  runId: string;
  session: string;
  timestamp: string;
  modelAlias: string;
  workspace: string;
  mode: string;
  canClaimAGI: false;
}

interface TerminalProvenanceRecord {
  schema: "sophia.execution-provenance.v1";
  type: "run_terminal";
  runId: string;
  session: string;
  timestamp: string;
  status: "succeeded" | "failed" | "cancelled";
  provider: string;
  resolvedModel: string;
  fallbackUsed: boolean;
  cancelReason?: string;
  canClaimAGI: false;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readProvenance(session: string): {
  provenance?: RunProvenance;
  warning?: string;
} {
  const dir = provenanceDir(session);
  if (!existsSync(dir)) return {};
  try {
    const names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse();
    const starts = new Map<string, StartProvenanceRecord>();
    const terminals = new Map<string, TerminalProvenanceRecord>();
    for (const name of names) {
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path.join(dir, name)));
      const record = objectRecord(JSON.parse(raw));
      if (!record || record.schema !== "sophia.execution-provenance.v1" || record.session !== session
        || typeof record.runId !== "string" || typeof record.timestamp !== "string"
        || record.canClaimAGI !== false) {
        throw new Error("invalid execution provenance record");
      }
      if (record.type === "run_start") {
        if (typeof record.modelAlias !== "string" || typeof record.workspace !== "string"
          || typeof record.mode !== "string") {
          throw new Error("invalid run-start provenance record");
        }
        starts.set(record.runId, record as unknown as StartProvenanceRecord);
      } else if (record.type === "run_terminal") {
        if (!(["succeeded", "failed", "cancelled"] as unknown[]).includes(record.status)
          || typeof record.provider !== "string" || typeof record.resolvedModel !== "string"
          || typeof record.fallbackUsed !== "boolean"
          || (record.cancelReason !== undefined && typeof record.cancelReason !== "string")) {
          throw new Error("invalid terminal provenance record");
        }
        terminals.set(record.runId, record as unknown as TerminalProvenanceRecord);
      } else {
        throw new Error("unknown execution provenance record type");
      }
    }
    const complete = [...starts.values()]
      .filter((start) => terminals.has(start.runId))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (!complete) return {};
    const terminal = terminals.get(complete.runId)!;
    return {
      provenance: {
        runId: complete.runId,
        modelAlias: complete.modelAlias,
        workspace: complete.workspace,
        mode: complete.mode,
        startedAt: complete.timestamp,
        status: terminal.status,
        provider: terminal.provider,
        resolvedModel: terminal.resolvedModel,
        fallbackUsed: terminal.fallbackUsed,
        ...(terminal.cancelReason ? { cancelReason: terminal.cancelReason } : {}),
        finishedAt: terminal.timestamp,
      },
    };
  } catch {
    return { warning: "execution provenance is unreadable; dialogue resumed without identity checks" };
  }
}

export function formatResumeDriftWarnings(
  prior: RunProvenance | undefined,
  current: { modelAlias: string; workspace: string },
): string[] {
  if (!prior) return [];
  const warnings: string[] = [];
  if (prior.modelAlias !== current.modelAlias) {
    const resolved = prior.resolvedModel && prior.resolvedModel !== prior.modelAlias
      ? ` (resolved ${prior.resolvedModel})`
      : "";
    warnings.push(`resume warning · model changed: ${prior.modelAlias}${resolved} → ${current.modelAlias}`);
  }
  if (path.resolve(prior.workspace) !== path.resolve(current.workspace)) {
    warnings.push(`resume warning · workspace changed: ${prior.workspace} → ${current.workspace}`);
  }
  return warnings;
}

export function loadSessionFromDisk(session: string): LoadSessionResult {
  const name = String(session || "tui-default").trim() || "tui-default";
  const file = conversationPath(name);
  const empty = (): LoadSessionResult => ({
    ok: true,
    session: name,
    path: file,
    turns: 0,
    messages: [],
    flowEvents: [],
    topic: "",
    error: undefined,
  });
  try {
    // Read raw bytes (not readFileSync(file, "utf8")) so we can decode with a
    // FATAL TextDecoder below. Node's built-in "utf8" string decode is lossy —
    // it silently substitutes U+FFFD for invalid byte sequences instead of
    // throwing — so a bit-flipped or mid-multibyte-truncated transcript would
    // parse "successfully" with mojibake baked into chat history forever. The
    // Python writer's reader (agent/cli.py _load_conversation) decodes strict
    // UTF-8 and quarantines on failure; matching that here means both surfaces
    // agree on what counts as a corrupt transcript instead of diverging.
    const bytes = readFileSync(file);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) {
      return {
        ok: false,
        session: name,
        path: file,
        turns: 0,
        messages: [],
        flowEvents: [],
        topic: "",
        error: "conversation file is not a JSON array",
      };
    }
    const turns = data.filter((x): x is DiskTurn => !!x && typeof x === "object") as DiskTurn[];
    const messages = turnsToChatMessages(turns);
    const flowEvents = sessionFlowEventsFromTurns(name, turns);
    const provenance = readProvenance(name);
    return {
      ok: true,
      session: name,
      path: file,
      turns: turns.length,
      messages,
      flowEvents,
      topic: pickTopic(turns),
      provenance: provenance.provenance,
      provenanceWarning: provenance.warning,
    };
  } catch (error) {
    // ENOENT covers both "never had a session by this name" AND the narrow
    // race where the file existed a moment ago but the Python kernel's own
    // quarantine (agent/cli.py _quarantine_corrupt_conversation) renamed it
    // aside between us and here — that rename already preserved the bytes and
    // warned on the kernel side, so from this reader's vantage point the
    // session is simply gone, same as one that never existed. Anything else
    // (EACCES, EISDIR, decode failure, JSON syntax error, …) is a real fault
    // and must be surfaced, not swallowed.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return empty();
    return {
      ok: false,
      session: name,
      path: file,
      turns: 0,
      messages: [],
      flowEvents: [],
      topic: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Agent-loop continuation nudges the kernel injects as ``role:"user"`` turns
 * (agent/agent_loop.py: auto-continue boundary / recover / use_data / intent /
 * narration / conclusion_pass / iteration-ceiling). They are system-generated
 * steering, NEVER the user's opening goal — but because they carry the "user"
 * role, a naive "first user message" topic picker surfaces them as the session's
 * description (e.g. a row reading "[auto-continue 2/3] You completed 24
 * iterations using…" or "You just received output from `write_file`…"). Match
 * the stable leading text of each template so the resume picker can skip them
 * and show the real topic. Tool-feedback blobs ("[tool:…]") are already
 * projected to role:"tool" by turnsToChatMessages, so they never reach the
 * user-message filter and need no entry here.
 */
const AGENT_CONTINUATION_NUDGE_PATTERNS: readonly RegExp[] = [
  /^\[auto-continue \d+\//i, // auto-continuation boundary
  /^You just received output from `/i, // use_data
  /^The last tool `[^`]*` FAILED:/i, // recover
  /^You announced an action but did not call a tool\b/i, // intent
  /^STOP NARRATING\b/i, // narration
  /^You executed \d+ tool calls?\b/i, // conclusion_pass
  /^Active request:[\s\S]*\nYou executed \d+ tool calls?\b/i, // conclusion_pass with request
  /^\(reached \d+-iteration ceiling\b/i, // iteration ceiling
];

export function isAgentContinuationNudge(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true; // a blank turn is never a useful topic either
  return AGENT_CONTINUATION_NUDGE_PATTERNS.some((re) => re.test(t));
}

/**
 * Pick a session's topic from the FULL transcript: the first genuine user
 * prompt, skipping kernel continuation nudges (isAgentContinuationNudge) and
 * the packed tool-feedback / native-call blobs the kernel also stores under
 * role:"user". This reads the whole conversation, NOT the RESUME_UI_MAX_TURNS
 * UI projection — a long autonomous session opens with its goal at turn 0,
 * which the 60-turn projection drops, so a projection-based topic would surface
 * a later nudge instead of what the session is actually about. Falls back to the
 * first user turn (nudge or blob) so the picker row is never blank.
 */
export function pickTopic(turns: DiskTurn[]): string {
  const isToolBlob = (c: string): boolean =>
    c.startsWith("[tool") ||
    c.startsWith("[tool_call_skipped]") ||
    c.startsWith("[native tool calls") ||
    c.startsWith("[incomplete native");
  let firstUser = "";
  for (const t of turns) {
    if (String(t.role || "user") !== "user") continue;
    const c = String(t.content || "").trim();
    if (!c) continue;
    if (!firstUser) firstUser = c;
    if (!isToolBlob(c) && !isAgentContinuationNudge(c)) return c;
  }
  return firstUser;
}

function diskTurns(value: unknown): DiskTurn[] {
  if (!Array.isArray(value)) throw new Error("conversation file is not a JSON array");
  return value.filter((item): item is DiskTurn => !!item && typeof item === "object");
}

function activeConversationNames(options: { strict?: boolean } = {}): string[] {
  const dir = conversationsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    if (options.strict) throw error;
    return [];
  }
}

async function activeConversationNamesAsync(): Promise<string[]> {
  try {
    const names = await readdirAsync(conversationsDir());
    return names.filter((name) => name.endsWith(".json") && !name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

function sessionListItemFromTurns(
  id: string,
  file: string,
  turns: DiskTurn[],
  updatedAt: number,
): SessionListItem {
  const messages = turnsToChatMessages(turns);
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const description = (pickTopic(turns) || lastUser?.text || "")
    .replace(/\s+/g, " ").trim().slice(0, 80);
  const metadata = loadSessionMetadata(id);
  return {
    id,
    name: id,
    path: file,
    turns: turns.length,
    updatedAt,
    lastPreview: (lastUser?.text || "").replace(/\s+/g, " ").slice(0, 120),
    description,
    recency: relativeTime(updatedAt),
    title: metadata.title,
    tags: [...metadata.tags],
    parentSessionId: metadata.parent?.sessionId,
    checkpointCount: metadata.checkpoints.length,
    archived: false,
  };
}

function exactSessionRowFromDisk(selected: string): SessionListItem | null {
  const id = findExactSessionIdFromDisk(selected);
  if (!id) return null;
  const file = conversationPath(id);
  let updatedAt = 0;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    updatedAt = stat.mtimeMs;
    return sessionListItemFromTurns(id, file, diskTurns(strictJson(file)), updatedAt);
  } catch {
    // Existence still makes this an exact identity. Returning a minimal row
    // lets the normal resume loader surface the corruption/read error instead
    // of silently reinterpreting the name as a search query.
    const metadata = loadSessionMetadata(id);
    return {
      id,
      name: id,
      path: file,
      turns: 0,
      updatedAt,
      lastPreview: "",
      description: "",
      recency: relativeTime(updatedAt),
      title: metadata.title,
      tags: [...metadata.tags],
      parentSessionId: metadata.parent?.sessionId,
      checkpointCount: metadata.checkpoints.length,
      archived: false,
    };
  }
}

/** Resolve only an existing active transcript identity; never enumerate siblings. */
export function findExactSessionIdFromDisk(selected: string): string | null {
  const value = safeSessionIdentity(selected);
  if (!value) return null;
  const id = canonicalSessionId(value);
  const file = conversationPath(id);
  try {
    return statSync(file).isFile() ? id : null;
  } catch {
    return null;
  }
}

export function listSessionsFromDisk(limit = 50): SessionListItem[] {
  const dir = conversationsDir();
  const items: SessionListItem[] = [];
  for (const name of activeConversationNames()) {
    const file = path.join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      const id = name.replace(/\.json$/i, "");
      items.push(sessionListItemFromTurns(id, file, diskTurns(strictJson(file)), st.mtimeMs));
    } catch {
      /* skip unreadable */
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items.slice(0, Math.max(0, limit));
}

export interface SessionLookupResult {
  query: string;
  exact: SessionListItem | null;
  matches: SessionListItem[];
  totalMatches: number;
  truncated: boolean;
}

function safeSessionIdentity(value: unknown): string {
  return sanitizeTerminalText(String(value || ""), true)
    .trim();
}

function safeSearchText(value: unknown): string {
  return safeSessionIdentity(value).replace(/\s+/g, " ");
}

function normalizedSearchText(value: unknown): string {
  return safeSearchText(value)
    .normalize("NFKC")
    .toLowerCase();
}

export function normalizeSessionSearchQuery(value: unknown): {
  query: string;
  terms: string[];
} {
  const bounded = Array.from(safeSearchText(value))
    .slice(0, SESSION_SEARCH_QUERY_MAX_CHARS)
    .join("");
  const terms = bounded
    .normalize("NFKC")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .slice(0, SESSION_SEARCH_QUERY_MAX_TERMS);
  return { query: terms.join(" "), terms };
}

export function resumeLookupIntent(input: string): {
  exactCandidates: string[];
  query: string;
} {
  const identity = safeSessionIdentity(input);
  const query = safeSearchText(identity);
  if (!identity) return { exactCandidates: [], query: "" };
  const legacySelect = identity.match(/^select\s+([\s\S]+)$/i);
  return {
    exactCandidates: [legacySelect ? legacySelect[1].trim() : identity],
    // Search the operator's words verbatim. `select` is stripped only when its
    // remainder resolves as the legacy exact-session syntax.
    query,
  };
}

function searchPreview(
  value: unknown,
  terms: readonly string[],
  maxChars = SESSION_SEARCH_PREVIEW_MAX_CHARS,
): string {
  const text = safeSearchText(value);
  if (text.length <= maxChars) return text;
  const normalized = normalizedSearchText(text);
  const offsets = terms.map((term) => normalized.indexOf(term)).filter((offset) => offset >= 0);
  const anchor = offsets.length ? Math.min(...offsets) : 0;
  const start = Math.max(0, Math.min(anchor - 40, text.length - maxChars));
  const prefix = start > 0 ? "… " : "";
  const suffix = start + maxChars < text.length ? " …" : "";
  const available = Math.max(1, maxChars - prefix.length - suffix.length);
  return `${prefix}${text.slice(start, start + available)}${suffix}`;
}

function turnSearchField(turn: DiskTurn): "user" | "assistant" | "tool" | "system" {
  const content = String(turn.content || "").trimStart();
  if (content.startsWith("[tool") || content.startsWith("[native tool")) return "tool";
  const role = String(turn.role || "user").toLowerCase();
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "user";
}

/** Pure matcher used by the on-demand disk lookup; all query terms must share one field/turn. */
export function matchSessionContent(
  row: SessionListItem,
  turns: readonly DiskTurn[],
  query: string,
): SessionContentMatch | null {
  const { query: normalizedQuery, terms } = normalizeSessionSearchQuery(query);
  if (!terms.length) return null;

  const candidates: Array<{ field: SessionSearchField; text: string; score: number }> = [];
  candidates.push({
    field: "id",
    text: row.id,
    score: normalizedSearchText(row.id) === normalizedQuery ? 0 : 5,
  });
  if (normalizedSearchText(row.title) && normalizedSearchText(row.title) !== normalizedSearchText(row.id)) {
    candidates.push({ field: "title", text: row.title || "", score: 10 });
  }
  const topic = normalizedSearchText(row.description);
  const lastUser = normalizedSearchText(row.lastPreview);
  let topicAssigned = false;
  let lastUserAssigned = false;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const baseField = turnSearchField(turn);
    const normalizedTurn = normalizedSearchText(turn.content);
    let field: SessionSearchField = baseField;
    let score = baseField === "user" ? 30 : baseField === "assistant" ? 35 : baseField === "tool" ? 40 : 45;
    if (baseField === "user" && !lastUserAssigned && lastUser && normalizedTurn.startsWith(lastUser)) {
      field = "last-user";
      score = 25;
      lastUserAssigned = true;
    }
    if (baseField === "user" && topic && normalizedTurn.startsWith(topic)) {
      field = "topic";
      score = 20;
      topicAssigned = true;
    }
    candidates.push({
      field,
      text: String(turn.content || ""),
      score,
    });
  }
  if (topic && !topicAssigned) candidates.push({ field: "topic", text: row.description, score: 20 });
  if (lastUser && !lastUserAssigned && lastUser !== topic) {
    candidates.push({ field: "last-user", text: row.lastPreview, score: 25 });
  }

  const matches = candidates.filter((candidate) => {
    const haystack = normalizedSearchText(candidate.text);
    return !!haystack && terms.every((term) => haystack.includes(term));
  });
  if (!matches.length) return null;
  matches.sort((left, right) => {
    const leftPhrase = normalizedSearchText(left.text).includes(normalizedQuery) ? 0 : 1;
    const rightPhrase = normalizedSearchText(right.text).includes(normalizedQuery) ? 0 : 1;
    return left.score - right.score || leftPhrase - rightPhrase;
  });
  const best = matches[0];
  return {
    field: best.field,
    preview: searchPreview(best.text, terms),
    occurrences: matches.length,
    score: best.score + (normalizedSearchText(best.text).includes(normalizedQuery) ? 0 : 1),
  };
}

function finalizeSessionMatches(
  query: string,
  matches: SessionListItem[],
  limit: number,
): SessionLookupResult {
  matches.sort((left, right) =>
    (left.match?.score ?? Number.MAX_SAFE_INTEGER) - (right.match?.score ?? Number.MAX_SAFE_INTEGER) ||
    right.updatedAt - left.updatedAt ||
    left.id.localeCompare(right.id)
  );
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
  return {
    query,
    exact: null,
    matches: matches.slice(0, cap),
    totalMatches: matches.length,
    truncated: matches.length > cap,
  };
}

/**
 * Resolve an exact active-session identity or search canonical local transcript
 * arrays on demand. Match snippets remain in memory and are never persisted.
 */
export function lookupSessionsFromDisk(query: string, limit = 50): SessionLookupResult {
  const selected = safeSessionIdentity(query);
  const normalized = normalizeSessionSearchQuery(selected);
  if (!normalized.terms.length) {
    return { query: "", exact: null, matches: [], totalMatches: 0, truncated: false };
  }
  const exact = exactSessionRowFromDisk(selected);
  if (exact) {
    return { query: normalized.query, exact, matches: [exact], totalMatches: 1, truncated: false };
  }

  const matches: SessionListItem[] = [];
  for (const name of activeConversationNames({ strict: true })) {
    const id = name.replace(/\.json$/i, "");
    const file = path.join(conversationsDir(), name);
    try {
      const turns = diskTurns(strictJson(file));
      const row = sessionListItemFromTurns(id, file, turns, statSync(file).mtimeMs);
      const match = matchSessionContent(row, turns, normalized.query);
      if (match) matches.push({ ...row, match });
    } catch {
      // A search must not turn one corrupt sibling into a global failure.
    }
  }
  return finalizeSessionMatches(normalized.query, matches, limit);
}

/**
 * Async, yielding variant used by Ink. Files are read in small batches and
 * parsed once each; corrupt siblings are isolated to their own result slot.
 */
export async function lookupSessionsFromDiskAsync(
  query: string,
  limit = 50,
): Promise<SessionLookupResult> {
  const selected = safeSessionIdentity(query);
  const normalized = normalizeSessionSearchQuery(selected);
  if (!normalized.terms.length) {
    return { query: "", exact: null, matches: [], totalMatches: 0, truncated: false };
  }
  const exact = exactSessionRowFromDisk(selected);
  if (exact) {
    return { query: normalized.query, exact, matches: [exact], totalMatches: 1, truncated: false };
  }

  const names = await activeConversationNamesAsync();
  const matches: SessionListItem[] = [];
  for (let offset = 0; offset < names.length; offset += SESSION_SEARCH_BATCH_SIZE) {
    const batch = names.slice(offset, offset + SESSION_SEARCH_BATCH_SIZE);
    const records = await Promise.all(batch.map(async (name) => {
      const id = name.replace(/\.json$/i, "");
      const file = path.join(conversationsDir(), name);
      try {
        const [bytes, stat] = await Promise.all([readFileAsync(file), statAsync(file)]);
        if (!stat.isFile()) return null;
        const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
        const turns = diskTurns(raw);
        const row = sessionListItemFromTurns(id, file, turns, stat.mtimeMs);
        const match = matchSessionContent(row, turns, normalized.query);
        return match ? { ...row, match } : null;
      } catch {
        return null;
      }
    }));
    for (const record of records) if (record) matches.push(record);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return finalizeSessionMatches(normalized.query, matches, limit);
}

// ---------------------------------------------------------------------------
// Local-only session lifecycle metadata and atomic file operations.
//
// The transcript itself deliberately remains the legacy top-level JSON ARRAY
// consumed by agent/cli.py. Metadata lives in a hidden sidecar directory so an
// older Sophia build still sees byte-compatible transcripts and never mistakes
// a metadata object for a conversation.

export const SESSION_METADATA_SCHEMA = "sophia.tui.session.v1" as const;
export const SESSION_EXPORT_SCHEMA = "sophia.tui.session_export.v1" as const;
export const SESSION_ARCHIVE_SCHEMA = "sophia.tui.session_archive.v1" as const;

export interface LocalOnlySessionPolicy {
  scope: "local-only";
  remoteSync: false;
  supportBundleTranscriptDefault: false;
}

export const LOCAL_ONLY_SESSION_POLICY: Readonly<LocalOnlySessionPolicy> = Object.freeze({
  scope: "local-only",
  remoteSync: false,
  supportBundleTranscriptDefault: false,
});

export interface SessionParentMetadata {
  sessionId: string;
  forkedAt: string;
  checkpointId?: string;
  nodeId?: string;
  nodeTitle?: string;
  turn?: number;
}

export interface SessionCheckpointMetadata {
  id: string;
  createdAt: string;
  label?: string;
  turns: number;
  sha256: string;
  /** Path relative to conversationsDir(); never an absolute machine path. */
  relativePath: string;
}

export interface SessionMetadata {
  schema: typeof SESSION_METADATA_SCHEMA;
  sessionId: string;
  name: string;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  parent?: SessionParentMetadata;
  checkpoints: SessionCheckpointMetadata[];
  storagePolicy: LocalOnlySessionPolicy;
  candidateOnly: true;
  canClaimAGI: false;
}

export interface CreateSessionOptions {
  title?: string;
  tags?: readonly string[];
  parentSessionId?: string;
  /** Defaults true when parentSessionId is supplied. */
  copyParentTranscript?: boolean;
  parentCheckpointId?: string;
  forkNodeId?: string;
  forkNodeTitle?: string;
  forkTurn?: number;
  turns?: readonly DiskTurn[];
  now?: Date;
}

export interface SessionOperationResult {
  ok: true;
  sessionId: string;
  path: string;
  metadata: SessionMetadata;
}

export interface SessionCheckpointResult extends SessionOperationResult {
  checkpoint: SessionCheckpointMetadata;
  checkpointPath: string;
}

export interface SessionArchiveResult extends SessionOperationResult {
  archivePath: string;
}

export interface SessionExportResult extends SessionOperationResult {
  exportPath: string;
  transcriptIncluded: boolean;
}

function isoNow(now: Date = new Date()): string {
  return now.toISOString();
}

/** Canonical on-disk id. This intentionally delegates to conversationPath. */
export function canonicalSessionId(session: string): string {
  return path.basename(conversationPath(session), ".json");
}

/** Stable safe segment shared by metadata/checkpoint/archive paths. */
export function sessionStorageKey(session: string): string {
  const id = canonicalSessionId(session);
  return `s-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24)}`;
}

export function sessionMetadataDir(root = conversationsDir()): string {
  return path.join(root, ".session-meta");
}

export function sessionMetadataPath(session: string, root = conversationsDir()): string {
  return path.join(sessionMetadataDir(root), `${sessionStorageKey(session)}.json`);
}

export function sessionCheckpointDir(session: string, root = conversationsDir()): string {
  return path.join(sessionMetadataDir(root), "checkpoints", sessionStorageKey(session));
}

export function sessionArchiveDir(root = conversationsDir()): string {
  return path.join(root, ".archive");
}

export function sessionIndexPath(root = conversationsDir()): string {
  return path.join(root, ".session-index.json");
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    /* Some platforms/filesystems do not support fsync on directories. */
  }
}

function tempSibling(file: string): string {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

export function atomicWriteTextFile(file: string, text: string): void {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = tempSibling(file);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(tmp); } catch { /* successful rename or failed create */ }
  }
}

/** Atomic create-without-clobber (hard-link commit from a fully-flushed temp). */
export function atomicCreateTextFile(file: string, text: string): void {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = tempSibling(file);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // linkSync is the portable POSIX no-replace primitive available in Node:
    // the destination appears atomically and EEXIST never overwrites it.
    linkSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

export function atomicWriteJsonFile(file: string, value: unknown): void {
  atomicWriteTextFile(file, JSON.stringify(value, null, 2) + "\n");
}

export function atomicCreateJsonFile(file: string, value: unknown): void {
  atomicCreateTextFile(file, JSON.stringify(value, null, 2) + "\n");
}

function strictJson(file: string): unknown {
  const bytes = readFileSync(file);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function transcriptArray(file: string): unknown[] {
  const value = strictJson(file);
  if (!Array.isArray(value)) throw new Error("conversation file is not a JSON array");
  return value;
}

function transcriptCreatedAt(file: string): string {
  try {
    const st = statSync(file);
    const ms = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
    return new Date(ms).toISOString();
  } catch {
    return isoNow();
  }
}

function normalizeTags(tags: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const value of tags) {
    const tag = String(value ?? "").trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > 64) throw new Error("session tag must be at most 64 characters");
    if (/[\u0000-\u001f\u007f]/u.test(tag)) throw new Error("session tag contains control characters");
    out.add(tag);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function normalizeCheckpoint(value: unknown): SessionCheckpointMetadata | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id || "").trim();
  const relativePath = String(raw.relativePath || "").trim();
  if (!id || !relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    return null;
  }
  return {
    id,
    createdAt: String(raw.createdAt || isoNow()),
    ...(raw.label ? { label: String(raw.label).slice(0, 120) } : {}),
    turns: Math.max(0, Math.floor(Number(raw.turns) || 0)),
    sha256: String(raw.sha256 || ""),
    relativePath,
  };
}

function synthesizedMetadata(session: string): SessionMetadata {
  const sessionId = canonicalSessionId(session);
  const file = conversationPath(sessionId);
  const createdAt = transcriptCreatedAt(file);
  let updatedAt = createdAt;
  try { updatedAt = new Date(statSync(file).mtimeMs).toISOString(); } catch { /* missing new session */ }
  return {
    schema: SESSION_METADATA_SCHEMA,
    sessionId,
    name: sessionId,
    title: sessionId,
    tags: [],
    createdAt,
    updatedAt,
    checkpoints: [],
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
    candidateOnly: true,
    canClaimAGI: false,
  };
}

function normalizeMetadata(session: string, value: unknown): SessionMetadata {
  const fallback = synthesizedMetadata(session);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const raw = value as Record<string, unknown>;
  const sessionId = canonicalSessionId(String(raw.sessionId || fallback.sessionId));
  const checkpoints = Array.isArray(raw.checkpoints)
    ? raw.checkpoints.map(normalizeCheckpoint).filter((x): x is SessionCheckpointMetadata => x !== null)
    : [];
  const parentRaw = raw.parent && typeof raw.parent === "object"
    ? raw.parent as Record<string, unknown>
    : null;
  const parent = parentRaw && String(parentRaw.sessionId || "").trim()
    ? {
        sessionId: canonicalSessionId(String(parentRaw.sessionId)),
        forkedAt: String(parentRaw.forkedAt || fallback.createdAt),
        ...(parentRaw.checkpointId ? { checkpointId: String(parentRaw.checkpointId) } : {}),
        ...(parentRaw.nodeId ? { nodeId: String(parentRaw.nodeId).slice(0, 160) } : {}),
        ...(parentRaw.nodeTitle ? { nodeTitle: String(parentRaw.nodeTitle).slice(0, 240) } : {}),
        ...(Number.isFinite(Number(parentRaw.turn))
          ? { turn: Math.max(0, Math.floor(Number(parentRaw.turn))) }
          : {}),
      }
    : undefined;
  return {
    schema: SESSION_METADATA_SCHEMA,
    sessionId,
    name: String(raw.name || sessionId),
    title: String(raw.title || raw.name || sessionId).trim().slice(0, 240) || sessionId,
    tags: normalizeTags(Array.isArray(raw.tags) ? raw.tags : []),
    createdAt: String(raw.createdAt || fallback.createdAt),
    updatedAt: String(raw.updatedAt || fallback.updatedAt),
    ...(raw.archivedAt ? { archivedAt: String(raw.archivedAt) } : {}),
    ...(parent ? { parent } : {}),
    checkpoints,
    // The policy is invariant, not caller-controlled metadata.
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
    candidateOnly: true,
    canClaimAGI: false,
  };
}

export function loadSessionMetadata(session: string): SessionMetadata {
  const file = sessionMetadataPath(session);
  try {
    return normalizeMetadata(session, strictJson(file));
  } catch {
    return synthesizedMetadata(session);
  }
}

function saveSessionMetadata(metadata: SessionMetadata): void {
  atomicWriteJsonFile(sessionMetadataPath(metadata.sessionId), metadata);
}

function relativeToConversations(file: string): string {
  const root = path.resolve(conversationsDir());
  const target = path.resolve(file);
  const relative = path.relative(root, target);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("session artifact escaped the conversations directory");
  }
  return relative.split(path.sep).join("/");
}

function pathFromRelativeSessionArtifact(relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error("unsafe session artifact path");
  }
  const root = path.resolve(conversationsDir());
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error("session artifact escaped the conversations directory");
  }
  return target;
}

export function createSession(session: string, options: CreateSessionOptions = {}): SessionOperationResult {
  const sessionId = canonicalSessionId(session);
  const file = conversationPath(sessionId);
  const now = isoNow(options.now);
  let turns: unknown[] = options.turns ? [...options.turns] : [];
  let parent: SessionParentMetadata | undefined;
  if (options.parentSessionId) {
    const parentId = canonicalSessionId(options.parentSessionId);
    const parentFile = conversationPath(parentId);
    if (!existsSync(parentFile)) throw new Error(`parent session does not exist: ${parentId}`);
    if (options.copyParentTranscript !== false && !options.turns) turns = transcriptArray(parentFile);
    parent = {
      sessionId: parentId,
      forkedAt: now,
      ...(options.parentCheckpointId ? { checkpointId: options.parentCheckpointId } : {}),
      ...(options.forkNodeId ? { nodeId: options.forkNodeId.slice(0, 160) } : {}),
      ...(options.forkNodeTitle ? { nodeTitle: options.forkNodeTitle.slice(0, 240) } : {}),
      ...(Number.isFinite(options.forkTurn)
        ? { turn: Math.max(0, Math.floor(options.forkTurn as number)) }
        : {}),
    };
  }
  const metadata: SessionMetadata = {
    schema: SESSION_METADATA_SCHEMA,
    sessionId,
    name: sessionId,
    title: String(options.title || sessionId).trim().slice(0, 240) || sessionId,
    tags: normalizeTags(options.tags || []),
    createdAt: now,
    updatedAt: now,
    ...(parent ? { parent } : {}),
    checkpoints: [],
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
    candidateOnly: true,
    canClaimAGI: false,
  };
  atomicCreateTextFile(file, JSON.stringify(turns, null, 2) + "\n");
  try {
    atomicCreateJsonFile(sessionMetadataPath(sessionId), metadata);
  } catch (error) {
    try { unlinkSync(file); } catch { /* rollback best effort */ }
    throw error;
  }
  return { ok: true, sessionId, path: file, metadata };
}

/** Friendly alias for callers whose command surface calls this operation "new". */
export const newSession = createSession;

export function forkSession(
  parentSession: string,
  newSessionName: string,
  options: Omit<CreateSessionOptions, "parentSessionId"> = {},
): SessionOperationResult {
  const checkpoint = checkpointSession(parentSession, {
    label: `fork:${canonicalSessionId(newSessionName)}`,
    now: options.now,
  });
  return createSession(newSessionName, {
    ...options,
    parentSessionId: checkpoint.sessionId,
    parentCheckpointId: checkpoint.checkpoint.id,
  });
}

export function tagSession(
  session: string,
  change: readonly string[] | {
    add?: readonly string[];
    remove?: readonly string[];
    replace?: readonly string[];
  },
  now: Date = new Date(),
): SessionOperationResult {
  const sessionId = canonicalSessionId(session);
  const file = conversationPath(sessionId);
  if (!existsSync(file)) throw new Error(`session does not exist: ${sessionId}`);
  const metadata = loadSessionMetadata(sessionId);
  const patch = Array.isArray(change)
    ? null
    : change as {
        add?: readonly string[];
        remove?: readonly string[];
        replace?: readonly string[];
      };
  const next = patch === null
    ? normalizeTags(change as readonly string[])
    : (() => {
        if (patch.replace) return normalizeTags(patch.replace);
        const tags = new Set(metadata.tags);
        for (const value of normalizeTags(patch.add || [])) tags.add(value);
        for (const value of normalizeTags(patch.remove || [])) tags.delete(value);
        return [...tags].sort((a, b) => a.localeCompare(b));
      })();
  const updated = { ...metadata, tags: next, updatedAt: isoNow(now) };
  saveSessionMetadata(updated);
  return { ok: true, sessionId, path: file, metadata: updated };
}

export function checkpointSession(
  session: string,
  options: { label?: string; now?: Date } = {},
): SessionCheckpointResult {
  const sessionId = canonicalSessionId(session);
  const file = conversationPath(sessionId);
  const turns = transcriptArray(file);
  const raw = readFileSync(file);
  const createdAt = isoNow(options.now);
  const id =
    `cp-${createdAt.replace(/\D/g, "").slice(0, 17)}-` +
    createHash("sha256").update(raw).digest("hex").slice(0, 10);
  const checkpointPath = path.join(sessionCheckpointDir(sessionId), `${id}.json`);
  atomicCreateTextFile(checkpointPath, raw.toString("utf8"));
  const checkpoint: SessionCheckpointMetadata = {
    id,
    createdAt,
    ...(options.label ? { label: String(options.label).trim().slice(0, 120) } : {}),
    turns: turns.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
    relativePath: relativeToConversations(checkpointPath),
  };
  const metadata = loadSessionMetadata(sessionId);
  const updated = {
    ...metadata,
    updatedAt: createdAt,
    checkpoints: [...metadata.checkpoints.filter((item) => item.id !== id), checkpoint],
  };
  try {
    saveSessionMetadata(updated);
  } catch (error) {
    try { unlinkSync(checkpointPath); } catch { /* rollback best effort */ }
    throw error;
  }
  return { ok: true, sessionId, path: file, metadata: updated, checkpoint, checkpointPath };
}

function moveIfPresent(source: string, destination: string, moved: Array<[string, string]>): void {
  if (!existsSync(source)) return;
  if (existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
  ensurePrivateDir(path.dirname(destination));
  renameSync(source, destination);
  moved.push([source, destination]);
}

function projectionPaths(sessionId: string): {
  markdown: string;
  rag: string;
  okf: string;
} {
  const transcript = conversationPath(sessionId);
  return {
    markdown: transcript.replace(/\.json$/i, ".md"),
    rag: path.join(conversationsDir(), "rag", `${sessionId}.jsonl`),
    okf: path.join(conversationsDir(), "okf", sessionId),
  };
}

export function renameSession(session: string, newName: string, now: Date = new Date()): SessionOperationResult {
  const sourceId = canonicalSessionId(session);
  const destinationId = canonicalSessionId(newName);
  if (sourceId === destinationId) {
    const metadata = loadSessionMetadata(sourceId);
    return { ok: true, sessionId: sourceId, path: conversationPath(sourceId), metadata };
  }
  const source = conversationPath(sourceId);
  const destination = conversationPath(destinationId);
  if (!existsSync(source)) throw new Error(`session does not exist: ${sourceId}`);
  if (existsSync(destination)) throw new Error(`session already exists: ${destinationId}`);

  // First publish a no-clobber hard link. Until the final unlink, both names
  // resolve to the exact same inode, so interruption cannot lose the transcript.
  linkSync(source, destination);
  const moved: Array<[string, string]> = [];
  const sourceProjection = projectionPaths(sourceId);
  const destinationProjection = projectionPaths(destinationId);
  const sourceCheckpointDir = sessionCheckpointDir(sourceId);
  const destinationCheckpointDir = sessionCheckpointDir(destinationId);
  try {
    moveIfPresent(sourceProjection.markdown, destinationProjection.markdown, moved);
    moveIfPresent(sourceProjection.rag, destinationProjection.rag, moved);
    moveIfPresent(sourceProjection.okf, destinationProjection.okf, moved);
    moveIfPresent(sourceCheckpointDir, destinationCheckpointDir, moved);

    const prior = loadSessionMetadata(sourceId);
    const checkpointPrefix = relativeToConversations(destinationCheckpointDir).replace(/\/$/, "");
    const updated: SessionMetadata = {
      ...prior,
      sessionId: destinationId,
      name: destinationId,
      title: prior.title === sourceId ? destinationId : prior.title,
      updatedAt: isoNow(now),
      checkpoints: prior.checkpoints.map((item) => ({
        ...item,
        relativePath: `${checkpointPrefix}/${path.posix.basename(item.relativePath)}`,
      })),
    };
    atomicCreateJsonFile(sessionMetadataPath(destinationId), updated);
    unlinkSync(source);
    try { unlinkSync(sessionMetadataPath(sourceId)); } catch { /* synthesized legacy metadata */ }
    fsyncDirectory(path.dirname(source));
    return { ok: true, sessionId: destinationId, path: destination, metadata: updated };
  } catch (error) {
    for (const [oldPath, newPath] of moved.reverse()) {
      try { renameSync(newPath, oldPath); } catch { /* rollback best effort */ }
    }
    try { unlinkSync(destination); } catch { /* rollback best effort */ }
    try { unlinkSync(sessionMetadataPath(destinationId)); } catch { /* rollback best effort */ }
    throw error;
  }
}

function removeDerivedSessionArtifacts(sessionId: string): void {
  const projections = projectionPaths(sessionId);
  for (const file of [projections.markdown, projections.rag]) {
    try { unlinkSync(file); } catch { /* absent/best effort */ }
  }
  try { rmSync(projections.okf, { recursive: true, force: true }); } catch { /* best effort */ }
}

export function resetSession(
  session: string,
  options: { checkpoint?: boolean; checkpointLabel?: string; now?: Date } = {},
): SessionOperationResult & { checkpoint?: SessionCheckpointMetadata } {
  const sessionId = canonicalSessionId(session);
  const file = conversationPath(sessionId);
  if (!existsSync(file)) throw new Error(`session does not exist: ${sessionId}`);
  const checkpoint = options.checkpoint === false
    ? undefined
    : checkpointSession(sessionId, { label: options.checkpointLabel || "before-reset", now: options.now });
  atomicWriteTextFile(file, "[]\n");
  removeDerivedSessionArtifacts(sessionId);
  const metadata = loadSessionMetadata(sessionId);
  const updated = { ...metadata, updatedAt: isoNow(options.now) };
  saveSessionMetadata(updated);
  return {
    ok: true,
    sessionId,
    path: file,
    metadata: updated,
    ...(checkpoint ? { checkpoint: checkpoint.checkpoint } : {}),
  };
}

export function archiveSession(session: string, now: Date = new Date()): SessionArchiveResult {
  const sessionId = canonicalSessionId(session);
  const file = conversationPath(sessionId);
  if (!existsSync(file)) throw new Error(`session does not exist: ${sessionId}`);
  const archivedAt = isoNow(now);
  const archiveName =
    `${archivedAt.replace(/\D/g, "").slice(0, 17)}-${sessionStorageKey(sessionId)}`;
  const root = sessionArchiveDir();
  ensurePrivateDir(root);
  const finalDir = path.join(root, archiveName);
  if (existsSync(finalDir)) throw new Error(`session archive already exists: ${archiveName}`);
  const tempDir = path.join(root, `.${archiveName}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  ensurePrivateDir(tempDir);
  try {
    linkSync(file, path.join(tempDir, "transcript.json"));
    const projections = projectionPaths(sessionId);
    if (existsSync(projections.markdown)) {
      linkSync(projections.markdown, path.join(tempDir, "transcript.md"));
    }
    const prior = loadSessionMetadata(sessionId);
    const checkpointDir = path.join(tempDir, "checkpoints");
    const archivedCheckpoints: SessionCheckpointMetadata[] = [];
    for (const item of prior.checkpoints) {
      try {
        const sourceCheckpoint = pathFromRelativeSessionArtifact(item.relativePath);
        ensurePrivateDir(checkpointDir);
        const name = path.basename(sourceCheckpoint);
        linkSync(sourceCheckpoint, path.join(checkpointDir, name));
        archivedCheckpoints.push({ ...item, relativePath: `checkpoints/${name}` });
      } catch {
        // A missing checkpoint does not invalidate the transcript archive; omit
        // the broken pointer rather than publishing a manifest that cannot load.
      }
    }
    const metadata: SessionMetadata = {
      ...prior,
      archivedAt,
      updatedAt: archivedAt,
      checkpoints: archivedCheckpoints,
    };
    atomicWriteJsonFile(path.join(tempDir, "metadata.json"), metadata);
    atomicWriteJsonFile(path.join(tempDir, "archive.json"), {
      schema: SESSION_ARCHIVE_SCHEMA,
      archivedAt,
      session: metadata,
      transcript: "transcript.json",
      storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
      candidateOnly: true,
      canClaimAGI: false,
    });
    renameSync(tempDir, finalDir);
    unlinkSync(file);
    try { unlinkSync(sessionMetadataPath(sessionId)); } catch { /* synthesized legacy metadata */ }
    removeDerivedSessionArtifacts(sessionId);
    try { rmSync(sessionCheckpointDir(sessionId), { recursive: true, force: true }); } catch { /* best effort */ }
    fsyncDirectory(root);
    return { ok: true, sessionId, path: path.join(finalDir, "transcript.json"), metadata, archivePath: finalDir };
  } catch (error) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export function exportSession(
  session: string,
  destination: string,
  options: { includeTranscript?: boolean; overwrite?: boolean; now?: Date } = {},
): SessionExportResult {
  const sessionId = canonicalSessionId(session);
  const source = conversationPath(sessionId);
  if (!existsSync(source)) throw new Error(`session does not exist: ${sessionId}`);
  const includeTranscript = options.includeTranscript !== false;
  let output = path.resolve(destination);
  if (existsSync(output) && statSync(output).isDirectory()) {
    output = path.join(output, `${sessionStorageKey(sessionId)}.export.json`);
  }
  if (path.resolve(output) === path.resolve(source) || path.resolve(output) === path.resolve(sessionMetadataPath(sessionId))) {
    throw new Error("export destination must not overwrite live session storage");
  }
  const metadata = loadSessionMetadata(sessionId);
  const value = {
    schema: SESSION_EXPORT_SCHEMA,
    exportedAt: isoNow(options.now),
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
    session: metadata,
    transcriptIncluded: includeTranscript,
    ...(includeTranscript ? { transcript: transcriptArray(source) } : {}),
    candidateOnly: true,
    canClaimAGI: false,
  };
  if (options.overwrite) atomicWriteJsonFile(output, value);
  else atomicCreateJsonFile(output, value);
  return {
    ok: true,
    sessionId,
    path: source,
    metadata,
    exportPath: output,
    transcriptIncluded: includeTranscript,
  };
}

export function listArchivedSessionsFromDisk(limit = 50): SessionListItem[] {
  const root = sessionArchiveDir();
  if (!existsSync(root)) return [];
  const items: SessionListItem[] = [];
  let names: string[] = [];
  try { names = readdirSync(root).filter((name) => !name.startsWith(".")); } catch { return []; }
  for (const name of names) {
    const archive = path.join(root, name);
    const transcript = path.join(archive, "transcript.json");
    try {
      if (!statSync(archive).isDirectory()) continue;
      const metadata = normalizeMetadata(
        name,
        strictJson(path.join(archive, "metadata.json")),
      );
      const rawTurns = transcriptArray(transcript);
      const turns = rawTurns.filter((item): item is DiskTurn => !!item && typeof item === "object");
      const messages = turnsToChatMessages(turns);
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const topic = pickTopic(turns);
      const updatedAt = Date.parse(metadata.updatedAt) || statSync(transcript).mtimeMs;
      items.push({
        id: metadata.sessionId,
        name: metadata.name,
        path: transcript,
        turns: rawTurns.length,
        updatedAt,
        lastPreview: (lastUser?.text || "").replace(/\s+/g, " ").slice(0, 120),
        description: (topic || lastUser?.text || "").replace(/\s+/g, " ").trim().slice(0, 80),
        recency: relativeTime(updatedAt),
        title: metadata.title,
        tags: [...metadata.tags],
        parentSessionId: metadata.parent?.sessionId,
        checkpointCount: metadata.checkpoints.length,
        archived: true,
      });
    } catch {
      /* skip incomplete archives; active transcript was never deleted first */
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items.slice(0, Math.max(0, limit));
}
