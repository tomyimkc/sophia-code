import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface TuiDebugMetadata {
  lifecycle: string;
  correlationId?: string;
  runId?: string;
  path?: string[];
  lane?: string;
  requestId?: string;
  session?: string;
  tracePath?: string;
  ts?: string;
  state?: string;
  error?: string;
}

export function tuiDebugRecord(meta: TuiDebugMetadata): Record<string, unknown> {
  const safe: Record<string, unknown> = { lifecycle: meta.lifecycle };
  for (const key of ["correlationId", "runId", "lane", "requestId", "session", "tracePath", "ts", "state", "error"] as const) {
    const value = meta[key];
    if (value) safe[key] = String(value).slice(0, key === "tracePath" ? 512 : 128);
  }
  if (meta.path) safe.path = meta.path.slice(0, 16).map((item) => item.slice(0, 80));
  return safe;
}

/** Structured, opt-in lifecycle diagnostics; never includes prompts or payloads. */
export function tuiDebugText(meta: TuiDebugMetadata): string {
  return `[tui-debug] ${JSON.stringify(tuiDebugRecord(meta))}`;
}

export function tuiDebugLogPath(explicit = process.env.SOPHIA_TUI_DEBUG_LOG): string {
  return explicit || path.join(process.env.HOME || homedir(), ".sophia", "tui-debug.jsonl");
}

/** Best-effort restrictive JSONL append. Debug logging never affects the UI. */
export function appendTuiDebug(meta: TuiDebugMetadata, filePath?: string): void {
  if (process.env.SOPHIA_TUI_DEBUG !== "1" && !filePath) return;
  try {
    const target = tuiDebugLogPath(filePath);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    appendFileSync(target, JSON.stringify(tuiDebugRecord(meta)) + "\n", { mode: 0o600 });
    try { chmodSync(target, 0o600); } catch { /* fail-open */ }
  } catch { /* fail-open: debug must never disrupt the TUI */ }
}
