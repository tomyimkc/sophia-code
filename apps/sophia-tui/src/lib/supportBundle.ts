/**
 * Redacted local support bundles.
 *
 * Transcript bodies, prompts, model answers, reasoning, tool args/results, and
 * message previews are excluded by default. Callers must explicitly opt in to
 * transcript bodies, and even then secret/path/control-character redaction is
 * still applied.
 */
import os from "node:os";
import path from "node:path";

import {
  LOCAL_ONLY_SESSION_POLICY,
  atomicWriteJsonFile,
  type DiskTurn,
  type SessionMetadata,
} from "./sessionStore.js";
import type { SessionIndex, SessionIndexEntry } from "./sessionIndex.js";
import type { RunReceipt, RunReceiptCollection } from "./runReceipt.js";

export const SUPPORT_BUNDLE_SCHEMA = "sophia.tui.support_bundle.v1" as const;

export interface SupportBundleSession {
  id: string;
  path?: string;
  metadata?: SessionMetadata;
  transcript?: readonly DiskTurn[];
  turns?: number;
}

export interface SupportBundleInput {
  app?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  config?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
  sessionIndex?: SessionIndex | readonly SessionIndexEntry[];
  sessions?: readonly SupportBundleSession[];
  runReceipts?: readonly RunReceipt[] | RunReceiptCollection;
  logs?: readonly unknown[];
}

export interface SupportBundleOptions {
  includeTranscriptBodies?: boolean;
  now?: Date;
  homeDir?: string;
  cwd?: string;
  maxLogs?: number;
  maxStringLength?: number;
}

export interface SupportBundle {
  schema: typeof SUPPORT_BUNDLE_SCHEMA;
  generatedAt: string;
  storagePolicy: typeof LOCAL_ONLY_SESSION_POLICY;
  privacy: {
    transcriptBodiesIncluded: boolean;
    transcriptBodiesDefault: false;
    redactionCount: number;
    omittedTranscriptBodies: number;
  };
  app?: unknown;
  runtime?: unknown;
  config?: unknown;
  diagnostics?: unknown;
  sessionIndex?: unknown;
  sessions: unknown[];
  runReceipts?: unknown;
  logs: unknown[];
  localOnly: true;
  candidateOnly: true;
  canClaimAGI: false;
}

interface RedactionContext {
  count: number;
  omittedTranscriptBodies: number;
  includeTranscriptBodies: boolean;
  homeDir: string;
  cwd: string;
  maxStringLength: number;
}

const SECRET_KEY =
  /(?:secret|password|passwd|credential|cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)/i;
const BODY_KEY =
  /^(?:body|content|prompt|rawPrompt|effectiveRequest|finalText|response|reasoning|thinking|messages?|transcript|toolArgs|toolResult|output|status)$/i;

function redactText(value: string, ctx: RedactionContext): string {
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  const before = text;
  text = text
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b(secret|password|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  // Replace the more specific workspace first. When cwd lives under HOME,
  // replacing HOME first would leave "~/repo" and prevent the intended
  // "<cwd>" marker from ever matching.
  // Never use a filesystem root as a replacement needle: "/" would rewrite
  // every URL/path separator, while a Windows drive/UNC root would rewrite
  // every absolute path on that volume/share.
  if (ctx.cwd && path.parse(ctx.cwd).root !== ctx.cwd) {
    text = text.split(ctx.cwd).join("<cwd>");
  }
  if (ctx.homeDir && path.parse(ctx.homeDir).root !== ctx.homeDir) {
    text = text.split(ctx.homeDir).join("~");
  }
  if (text !== before) ctx.count += 1;
  if (text.length > ctx.maxStringLength) {
    ctx.count += 1;
    text = `${text.slice(0, ctx.maxStringLength)}…[truncated]`;
  }
  return text;
}

function redactValue(value: unknown, ctx: RedactionContext, key = ""): unknown {
  if (key && SECRET_KEY.test(key)) {
    ctx.count += 1;
    return "[REDACTED]";
  }
  if (key && BODY_KEY.test(key) && !ctx.includeTranscriptBodies) {
    ctx.count += 1;
    ctx.omittedTranscriptBodies += 1;
    if (Array.isArray(value)) return { excluded: true, items: value.length };
    return { excluded: true };
  }
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]";
  if (typeof value === "string") return redactText(value, ctx);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, ctx, key));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactValue(child, ctx, childKey);
    }
    return out;
  }
  ctx.count += 1;
  return "[REDACTED]";
}

function indexEntries(index: SessionIndex | readonly SessionIndexEntry[]): readonly SessionIndexEntry[] {
  return Array.isArray(index)
    ? index as readonly SessionIndexEntry[]
    : (index as SessionIndex).entries;
}

function projectIndexEntry(entry: SessionIndexEntry, ctx: RedactionContext): Record<string, unknown> {
  return {
    id: redactText(entry.id, ctx),
    name: redactText(entry.name, ctx),
    title: redactText(entry.title, ctx),
    path: redactText(entry.path, ctx),
    turns: entry.turns,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags.map((tag) => redactText(tag, ctx)),
    archived: entry.archived,
    ...(entry.parentSessionId ? { parentSessionId: redactText(entry.parentSessionId, ctx) } : {}),
    ...(entry.forkedAt ? { forkedAt: entry.forkedAt } : {}),
    checkpointCount: entry.checkpointCount,
    // description and lastPreview intentionally omitted: both are transcript excerpts.
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
  };
}

function projectSession(session: SupportBundleSession, ctx: RedactionContext): Record<string, unknown> {
  const turns = session.transcript?.length ?? session.turns ?? 0;
  const projected: Record<string, unknown> = {
    id: redactText(session.id, ctx),
    ...(session.path ? { path: redactText(session.path, ctx) } : {}),
    turns: Math.max(0, Math.floor(Number(turns) || 0)),
    ...(session.metadata ? { metadata: redactValue(session.metadata, ctx, "metadata") } : {}),
    transcriptIncluded: ctx.includeTranscriptBodies && Array.isArray(session.transcript),
  };
  if (ctx.includeTranscriptBodies && session.transcript) {
    projected.transcript = redactValue(session.transcript, ctx, "transcriptIncludedBodies");
  } else if (session.transcript) {
    ctx.omittedTranscriptBodies += session.transcript.length;
    projected.transcript = { excluded: true, turns: session.transcript.length };
  }
  return projected;
}

export function generateSupportBundle(
  input: SupportBundleInput,
  options: SupportBundleOptions = {},
): SupportBundle {
  const ctx: RedactionContext = {
    count: 0,
    omittedTranscriptBodies: 0,
    includeTranscriptBodies: options.includeTranscriptBodies === true,
    homeDir: path.resolve(options.homeDir || process.env.HOME || os.homedir()),
    cwd: path.resolve(options.cwd || process.cwd()),
    maxStringLength: Math.max(128, Math.floor(options.maxStringLength ?? 4000)),
  };
  const sessions = (input.sessions || []).map((session) => projectSession(session, ctx));
  const maxLogs = Math.max(0, Math.floor(options.maxLogs ?? 200));
  const logs = (input.logs || []).slice(-maxLogs).map((entry) => redactValue(entry, ctx, "log"));
  const sessionIndex = input.sessionIndex
    ? indexEntries(input.sessionIndex).map((entry) => projectIndexEntry(entry, ctx))
    : undefined;
  const runReceipts = input.runReceipts
    ? redactValue(input.runReceipts, ctx, "runReceipts")
    : undefined;
  const bundle: SupportBundle = {
    schema: SUPPORT_BUNDLE_SCHEMA,
    generatedAt: (options.now || new Date()).toISOString(),
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
    privacy: {
      transcriptBodiesIncluded: ctx.includeTranscriptBodies,
      transcriptBodiesDefault: false,
      // Filled after every projection below has incremented the counters.
      redactionCount: 0,
      omittedTranscriptBodies: 0,
    },
    ...(input.app ? { app: redactValue(input.app, ctx, "app") } : {}),
    ...(input.runtime ? { runtime: redactValue(input.runtime, ctx, "runtime") } : {}),
    ...(input.config ? { config: redactValue(input.config, ctx, "config") } : {}),
    ...(input.diagnostics
      ? { diagnostics: redactValue(input.diagnostics, ctx, "diagnostics") }
      : {}),
    ...(sessionIndex ? { sessionIndex } : {}),
    sessions,
    ...(runReceipts ? { runReceipts } : {}),
    logs,
    localOnly: true,
    candidateOnly: true,
    canClaimAGI: false,
  };
  bundle.privacy.redactionCount = ctx.count;
  bundle.privacy.omittedTranscriptBodies = ctx.omittedTranscriptBodies;
  return bundle;
}

export function writeSupportBundle(
  destination: string,
  input: SupportBundleInput,
  options: SupportBundleOptions = {},
): SupportBundle {
  const bundle = generateSupportBundle(input, options);
  atomicWriteJsonFile(path.resolve(destination), bundle);
  return bundle;
}
