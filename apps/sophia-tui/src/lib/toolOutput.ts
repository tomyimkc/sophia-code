import { sanitizeTerminalText } from "./chatLayout.js";
import { truncateToWidth } from "./textWidth.js";

const REDACTED = "[REDACTED]";
const DEFAULT_SCAN_LIMIT = 256 * 1024;

export type ToolArtifactKind = "file" | "directory" | "url" | "diff" | "log" | "unknown";

export interface ToolArtifact {
  id: string;
  label: string;
  kind: ToolArtifactKind;
  path?: string;
  uri?: string;
  sizeBytes?: number;
}

export interface ToolOutputOptions {
  maxLines?: number;
  maxChars?: number;
  maxColumns?: number;
  artifactThresholdChars?: number;
  artifactThresholdLines?: number;
  scanLimit?: number;
  artifacts?: unknown;
}

export interface PreparedToolOutput {
  lines: string[];
  totalLines: number;
  /** False means totalLines/omittedLines are lower bounds from the bounded scan. */
  lineCountComplete: boolean;
  totalChars: number;
  omittedLines: number;
  omittedChars: number;
  truncated: boolean;
  large: boolean;
  artifacts: ToolArtifact[];
  retentionNote: string;
}

function clipInput(input: string, limit: number): string {
  if (input.length <= limit) return input;
  // Avoid ending a bounded scan on the high half of a surrogate pair.
  let end = Math.max(0, limit);
  const code = input.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return input.slice(0, end);
}

function redactSecrets(input: string): string {
  return input
    // Complete and clipped PEM private-key blocks.
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
      REDACTED,
    )
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/gi, REDACTED)
    // Authorization headers and common provider token formats.
    .replace(
      /\b(Authorization\s*:\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|npm_[A-Za-z0-9_]{12,}|(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{12,})\b/gi,
      REDACTED,
    )
    // JSON, env, and config key/value pairs. Keep the key so the preview
    // remains useful while replacing only the value.
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|auth(?:orization)?|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret|cookie)\b(\s*["']?\s*[:=]\s*["']?)([^\s,;}\]"']{4,})/gi,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
    )
    // CLI arguments use whitespace rather than ':' or '='.
    .replace(
      /(--(?:api-key|access-token|authorization|password|secret|token)\s+)([^\s]+)/gi,
      `$1${REDACTED}`,
    );
}

/**
 * Terminal-safe, secret-redacted text for every tool/approval presentation.
 *
 * The scan is capped before regex work so a tool returning hundreds of
 * megabytes cannot block the Ink render loop. Callers that need to disclose
 * truncation use prepareToolOutput(), which retains the original sizes.
 */
export function sanitizeToolText(
  input: unknown,
  allowNewline = true,
  scanLimit = DEFAULT_SCAN_LIMIT,
): string {
  const raw = clipInput(String(input ?? ""), Math.max(0, scanLimit));
  return redactSecrets(sanitizeTerminalText(raw, allowNewline));
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|^token$|authorization|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret|cookie)/i.test(
    key,
  );
}

function boundedValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "string") return sanitizeToolText(value, false, 8_192);
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value !== "object") return String(value);
  if (depth >= 4) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const rows = value.slice(0, 24).map((item) => boundedValue(item, seen, depth + 1));
    if (value.length > rows.length) rows.push(`… ${value.length - rows.length} more`);
    return rows;
  }

  const out: Record<string, unknown> = {};
  const source = value as Record<string, unknown>;
  const keys: string[] = [];
  let hasMoreKeys = false;
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (keys.length >= 32) {
      hasMoreKeys = true;
      break;
    }
    keys.push(key);
  }
  keys.sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    let item: unknown;
    try {
      item = source[key];
    } catch {
      item = "[unreadable property]";
    }
    out[sanitizeToolText(key, false, 128)] = isSensitiveKey(key)
      ? REDACTED
      : boundedValue(item, seen, depth + 1);
  }
  if (hasMoreKeys) out["…"] = "more keys omitted";
  return out;
}

/** Stable, bounded argument formatting that tolerates cycles and getters. */
export function formatToolArgs(args: unknown, maxColumns = 180): string {
  if (args === undefined || args === null || args === "") return "";
  let text = "";
  try {
    if (typeof args === "string") {
      text = sanitizeToolText(args, true, 16_384);
    } else {
      text = JSON.stringify(boundedValue(args, new WeakSet<object>(), 0));
    }
  } catch {
    text = "[unprintable arguments]";
  }
  return truncateToWidth(sanitizeToolText(text, true, 16_384).replace(/\s+/g, " ").trim(), Math.max(8, maxColumns));
}

function artifactKind(value: string): ToolArtifactKind {
  if (/^https?:\/\//i.test(value)) return "url";
  if (/\.diff$|\.patch$/i.test(value)) return "diff";
  if (/\.log$|\.txt$/i.test(value)) return "log";
  if (value.endsWith("/")) return "directory";
  if (value.includes("/") || value.includes("\\")) return "file";
  return "unknown";
}

/** Normalize bridge/session artifact variants without trusting labels or paths. */
export function normalizeToolArtifacts(value: unknown, limit = 8): ToolArtifact[] {
  if (!Array.isArray(value)) return [];
  const out: ToolArtifact[] = [];
  for (const item of value.slice(0, Math.max(0, limit))) {
    if (typeof item === "string") {
      const safe = sanitizeToolText(item, false, 2_048).trim();
      if (!safe) continue;
      const kind = artifactKind(safe);
      out.push({
        id: `artifact-${out.length + 1}`,
        label: safe.split(/[\\/]/).filter(Boolean).pop() || safe,
        kind,
        ...(kind === "url" ? { uri: safe } : { path: safe }),
      });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const path = sanitizeToolText(row.path ?? row.file ?? "", false, 2_048).trim();
    const uri = sanitizeToolText(row.uri ?? row.url ?? "", false, 2_048).trim();
    const label = sanitizeToolText(
      row.label ?? row.name ?? (path || uri).split(/[\\/]/).filter(Boolean).pop() ?? "",
      false,
      512,
    ).trim();
    if (!label && !path && !uri) continue;
    const declaredKind = String(row.kind ?? "").toLowerCase();
    const kind = (
      ["file", "directory", "url", "diff", "log", "unknown"].includes(declaredKind)
        ? declaredKind
        : artifactKind(path || uri || label)
    ) as ToolArtifactKind;
    const size = Number(row.sizeBytes ?? row.size ?? Number.NaN);
    out.push({
      id: sanitizeToolText(row.id ?? `artifact-${out.length + 1}`, false, 256),
      label: label || path || uri,
      kind,
      ...(path ? { path } : {}),
      ...(uri ? { uri } : {}),
      ...(Number.isFinite(size) && size >= 0 ? { sizeBytes: size } : {}),
    });
  }
  return out;
}

function countLines(input: string, scanLimit: number): { lines: number; complete: boolean } {
  if (!input) return { lines: 0, complete: true };
  let lines = 1;
  const end = Math.min(input.length, Math.max(0, scanLimit));
  for (let i = 0; i < end; i += 1) {
    if (input.charCodeAt(i) === 10) lines += 1;
  }
  return { lines, complete: input.length <= end };
}

function takeCodePoints(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return Array.from(input).slice(0, Math.max(0, maxChars)).join("");
}

/**
 * Produce a small render payload for arbitrarily large tool output.
 *
 * Full output is never silently implied to be present: when the preview is
 * truncated, retentionNote says whether a caller supplied a durable artifact.
 */
export function prepareToolOutput(
  output: unknown,
  options: ToolOutputOptions = {},
): PreparedToolOutput {
  const raw = String(output ?? "");
  const maxLines = Math.max(1, options.maxLines ?? 4);
  const maxChars = Math.max(32, options.maxChars ?? 1_600);
  const maxColumns = Math.max(12, options.maxColumns ?? 180);
  const scanLimit = Math.max(maxChars, options.scanLimit ?? DEFAULT_SCAN_LIMIT);
  const totalChars = raw.length;
  const lineCount = countLines(raw, scanLimit);
  const totalLines = lineCount.lines;
  const artifacts = normalizeToolArtifacts(options.artifacts);
  const source = clipInput(raw, Math.min(scanLimit, Math.max(maxChars * 4, maxChars)));
  const safe = sanitizeToolText(source, true, scanLimit);
  const lines: string[] = [];
  let consumedChars = 0;

  for (const rawLine of safe.split("\n")) {
    if (lines.length >= maxLines || consumedChars >= maxChars) break;
    const remaining = Math.max(0, maxChars - consumedChars);
    const clippedByChars = takeCodePoints(rawLine, remaining);
    const clipped = truncateToWidth(clippedByChars, maxColumns);
    lines.push(clipped);
    consumedChars += clippedByChars.length + 1;
  }

  // Empty output has no preview row; ToolCard can remain a one-line status.
  if (raw.length === 0) lines.length = 0;

  const omittedLines = Math.max(0, totalLines - lines.length);
  const omittedChars = Math.max(0, totalChars - Math.min(totalChars, maxChars));
  const truncated =
    raw.length > source.length ||
    omittedLines > 0 ||
    omittedChars > 0 ||
    lines.some((line) => line.endsWith("…"));
  const large =
    totalChars > (options.artifactThresholdChars ?? 12_000) ||
    totalLines > (options.artifactThresholdLines ?? 80);
  const retentionNote = !truncated
    ? ""
    : artifacts.length > 0
      ? `preview truncated · full output in ${artifacts.length === 1 ? "artifact" : `${artifacts.length} artifacts`}`
      : large
        ? "large output preview only · no artifact path supplied"
        : "output preview truncated";

  return {
    lines,
    totalLines,
    lineCountComplete: lineCount.complete,
    totalChars,
    omittedLines,
    omittedChars,
    truncated,
    large,
    artifacts,
    retentionNote,
  };
}

export function formatArtifact(artifact: ToolArtifact, maxColumns = 120): string {
  const location = artifact.path || artifact.uri || artifact.label;
  const size =
    artifact.sizeBytes === undefined
      ? ""
      : artifact.sizeBytes < 1024
        ? ` · ${artifact.sizeBytes} B`
        : artifact.sizeBytes < 1024 * 1024
          ? ` · ${(artifact.sizeBytes / 1024).toFixed(1)} KiB`
          : ` · ${(artifact.sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
  return truncateToWidth(`${artifact.label}${location !== artifact.label ? ` → ${location}` : ""}${size}`, maxColumns);
}
