/**
 * Local-only inspection helpers for Sophia's opt-in personal harness.
 *
 * These functions read the same ~/.sophia files as agent/personal_harness.py.
 * They never decrypt private memory and never contact a model or connector.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PersonalMemoryMatch {
  source: string;
  namespace: string;
  subject: string;
  text: string;
  score: number;
}

interface PromptModuleReceipt {
  name?: string;
  source?: string;
  action?: string;
  estimated_tokens?: number;
}

interface HarnessReceipt {
  timestamp?: string;
  runId?: string;
  profile?: string;
  modelClass?: string;
  workspace?: string;
  selection?: {
    memory?: Array<Record<string, unknown>>;
    pastChats?: Array<Record<string, unknown>>;
    skills?: Array<Record<string, unknown>>;
    research?: Record<string, unknown>;
    connectors?: Array<Record<string, unknown>>;
    memoryWrites?: Array<Record<string, unknown>>;
  };
  prompt?: {
    profile?: string;
    budget_tokens?: number;
    estimated_tokens?: number;
    included?: PromptModuleReceipt[];
    dropped?: PromptModuleReceipt[];
  };
}

function stateDir(): string {
  const configured =
    process.env.SOPHIA_STATE_DIR ||
    process.env.SOPHIA_USER_STATE;
  return configured && configured.trim()
    ? path.resolve(configured.trim())
    : path.join(os.homedir(), ".sophia");
}

export function personalMemoryDir(): string {
  const configured = process.env.SOPHIA_PERSONAL_MEMORY_DIR;
  return configured && configured.trim()
    ? path.resolve(configured.trim())
    : path.join(stateDir(), "personal-memory");
}

function safeSession(session: string): string {
  return String(session || "default")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "") || "default";
}

function receiptPath(session: string): string {
  return path.join(stateDir(), "receipts", safeSession(session), "latest.json");
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return value && typeof value === "object" ? value as T : null;
  } catch {
    return null;
  }
}

function markdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const first = path.join(root, entry);
    let stats;
    try {
      stats = statSync(first);
    } catch {
      continue;
    }
    if (stats.isFile() && entry.endsWith(".md")) {
      files.push(first);
      continue;
    }
    if (!stats.isDirectory()) continue;
    for (const child of readdirSync(first)) {
      const second = path.join(first, child);
      try {
        if (statSync(second).isFile() && child.endsWith(".md")) files.push(second);
      } catch {
        // One unreadable entry must not break local status/recall.
      }
    }
  }
  return files.sort();
}

function words(text: string): Set<string> {
  return new Set(
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9\u3400-\u9fff]+/g) || [],
  );
}

function lexicalScore(query: string, text: string): number {
  const queryTerms = words(query);
  if (!queryTerms.size) return 0;
  const textTerms = words(text);
  let overlap = 0;
  for (const term of queryTerms) if (textTerms.has(term)) overlap += 1;
  if (!overlap) return 0;
  const coverage = overlap / queryTerms.size;
  const phrase = text.toLowerCase().includes(query.toLowerCase()) ? 0.75 : 0;
  return coverage * 4 + overlap * 0.35 + phrase;
}

function canonicalRows(): PersonalMemoryMatch[] {
  const root = personalMemoryDir();
  const rows: PersonalMemoryMatch[] = [];
  for (const filePath of markdownFiles(root)) {
    const rel = path.relative(root, filePath);
    const parts = rel.split(path.sep);
    const namespace = parts.length > 1
      ? parts[0]
      : path.basename(filePath, ".md");
    const subject = path.basename(filePath, ".md");
    for (const line of readText(filePath).split(/\r?\n/)) {
      if (!line.startsWith("- [stated] ")) continue;
      const text = line.slice("- [stated] ".length).trim();
      if (!text) continue;
      rows.push({ source: rel, namespace, subject, text, score: 0 });
    }
  }
  return rows;
}

export function searchPersonalMemory(
  query: string,
  limit = 8,
): PersonalMemoryMatch[] {
  const clean = String(query || "").trim();
  if (!clean) return [];
  return canonicalRows()
    .map((row) => ({
      ...row,
      score: lexicalScore(clean, `${row.namespace} ${row.subject} ${row.text}`),
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.source.localeCompare(right.source) ||
      left.text.localeCompare(right.text),
    )
    .slice(0, Math.max(0, limit));
}

function auditRows(): Array<Record<string, unknown>> {
  return readText(path.join(personalMemoryDir(), "audit.jsonl"))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object"
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function encryptedRowCount(): number {
  return readText(path.join(personalMemoryDir(), "private.enc.jsonl"))
    .split(/\r?\n/)
    .filter(Boolean)
    .length;
}

function configFiles(cwd: string): string[] {
  const files = [
    path.join(stateDir(), "config.toml"),
    path.join(cwd, ".sophia", "config.toml"),
  ];
  if (process.env.SOPHIA_CODE_CONFIG?.trim()) {
    files.push(path.resolve(process.env.SOPHIA_CODE_CONFIG.trim()));
  }
  return files;
}

function tomlSection(content: string, section: string): string {
  const lines = content.split(/\r?\n/);
  const sectionLines: string[] = [];
  let active = false;

  for (const line of lines) {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) {
      if (active) break;
      active = header[1].trim() === section;
      continue;
    }
    if (active) sectionLines.push(line);
  }

  return sectionLines.join("\n");
}

function tomlString(section: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(
    new RegExp(`^\\s*${escaped}\\s*=\\s*["']([^"']+)["']\\s*$`, "mi"),
  );
  return match?.[1]?.trim() || null;
}

function tomlBool(section: string, key: string): boolean | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(
    new RegExp(`^\\s*${escaped}\\s*=\\s*(true|false)\\s*$`, "mi"),
  );
  return match ? match[1].toLowerCase() === "true" : null;
}

export function configuredHarnessProfile(cwd: string): string {
  let profile = "classic";
  for (const filePath of configFiles(cwd)) {
    const value = tomlString(tomlSection(readText(filePath), "prompt"), "profile");
    if (value) profile = value;
  }
  return process.env.SOPHIA_HARNESS_PROFILE?.trim() || profile;
}

function latestReceipt(session: string): HarnessReceipt | null {
  return readJson<HarnessReceipt>(receiptPath(session));
}

export function formatPersonalMemoryStatus(cwd: string): string {
  const root = personalMemoryDir();
  const files = markdownFiles(root);
  const facts = canonicalRows().length;
  const audit = auditRows();
  const review = audit.filter((row) =>
    row.action === "review_required" ||
    row.action === "sensitive_confirmation_required"
  );
  return [
    `personal harness: ${configuredHarnessProfile(cwd)}`,
    `memory root: ${root}`,
    `canonical Markdown: ${files.length} file(s) · ${facts} stated fact(s)`,
    `encrypted private memory: ${encryptedRowCount()} row(s) · never displayed by TUI recall`,
    `review/confirmation audit: ${review.length} event(s)`,
    "ontology: profile · preferences · projects · people · topics · decisions · procedures · custom",
    "index: SQLite is derived/rebuildable; Markdown is canonical",
  ].join("\n");
}

export function formatMemoryReview(): string {
  const pending = auditRows()
    .filter((row) =>
      row.action === "review_required" ||
      row.action === "sensitive_confirmation_required"
    )
    .slice(-8)
    .reverse();
  if (!pending.length) return "personal memory review: no pending audit events";
  return [
    `personal memory review (${pending.length} most recent audit events; facts are not exposed):`,
    ...pending.map((row) =>
      `  ${String(row.timestamp || "?")} · ${String(row.action || "?")} · ` +
      `${String(row.namespace || "?")}/${String(row.subject || "?")} · hash ${String(row.factHash || "?")}`,
    ),
  ].join("\n");
}

export function formatPersonalRecall(query: string): string {
  const clean = String(query || "").trim();
  if (!clean) return "usage: /recall <query>";
  const matches = searchPersonalMemory(clean);
  if (!matches.length) return `no local personal-memory match for: ${clean}`;
  return [
    `personal memory matches (${matches.length}) · local lexical search:`,
    ...matches.map((match, index) =>
      `  ${index + 1}. [${match.namespace}/${match.subject}] ${match.text} · ${match.source}`,
    ),
  ].join("\n");
}

export function formatHarnessReceipt(session: string): string {
  const receipt = latestReceipt(session);
  if (!receipt) {
    return `no personal-harness receipt for session ${session}; run once with prompt.profile = "personal-v2"`;
  }
  const selection = receipt.selection || {};
  const skills = (selection.skills || []).map((row) => String(row.name || "")).filter(Boolean);
  const research = selection.research || {};
  return [
    `harness receipt · ${receipt.timestamp || "unknown time"} · run ${receipt.runId || "?"}`,
    `profile: ${receipt.profile || "?"} · model class: ${receipt.modelClass || "?"}`,
    `memory: ${(selection.memory || []).length} recalled · ${(selection.memoryWrites || []).length} capture decision(s) · past chats: ${(selection.pastChats || []).length}`,
    `skills: ${skills.length ? skills.join(", ") : "none"}`,
    `research: ${String(research.decision || "?")} · ${String(research.reason || "")}`,
    `path: ${receiptPath(session)}`,
    "candidateOnly:true · canClaimAGI:false",
  ].join("\n");
}

export function formatPromptReceipt(session: string): string {
  const prompt = latestReceipt(session)?.prompt;
  if (!prompt) return `no compiled-prompt receipt for session ${session}`;
  const included = prompt.included || [];
  const dropped = prompt.dropped || [];
  return [
    `compiled prompt: ${prompt.profile || "?"} · ${prompt.estimated_tokens ?? "?"}/${prompt.budget_tokens ?? "?"} estimated tokens`,
    "included:",
    ...(included.length
      ? included.map((row) =>
          `  ${row.name || "?"} · ${row.action || "included"} · ${row.estimated_tokens ?? "?"} tok · ${row.source || "?"}`,
        )
      : ["  (none)"]),
    "dropped:",
    ...(dropped.length
      ? dropped.map((row) =>
          `  ${row.name || "?"} · ${row.action || "dropped"} · ${row.source || "?"}`,
        )
      : ["  (none)"]),
  ].join("\n");
}

export function formatArtifacts(session: string): string {
  const root = path.join(stateDir(), "artifacts", safeSession(session));
  if (!existsSync(root)) return `no staged artifacts for session ${session}`;
  const files = readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((filePath) => {
      try {
        return statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      try {
        return statSync(right).mtimeMs - statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });
  if (!files.length) return `no staged artifacts for session ${session}`;
  return [
    `staged artifacts (${files.length}) · local-only:`,
    ...files.map((filePath) => `  ${filePath}`),
  ].join("\n");
}

export function formatConnectorPolicies(cwd: string, session: string): string {
  const fromReceipt = latestReceipt(session)?.selection?.connectors || [];
  if (fromReceipt.length) {
    return [
      "connector policy from latest harness receipt:",
      ...fromReceipt.map((row) =>
        `  ${String(row.name || "?")} · ${row.enabled === false ? "disabled" : "enabled"} · ` +
        `read=${String(row.read || "auto")} · write=${String(row.write || "confirm")}`,
      ),
      "Policy is authority only; an installed connector/tool is still required.",
    ].join("\n");
  }

  const rows: string[] = [];
  for (const name of ["github", "google"]) {
    let enabled = true;
    let read = "auto";
    let write = "confirm";
    for (const filePath of configFiles(cwd)) {
      const section = tomlSection(readText(filePath), `connectors.${name}`);
      enabled = tomlBool(section, "enabled") ?? enabled;
      read = tomlString(section, "read") || read;
      write = tomlString(section, "write") || write;
    }
    rows.push(`  ${name} · ${enabled ? "enabled" : "disabled"} · read=${read} · write=${write}`);
  }
  return [
    "connector policy from layered config:",
    ...rows,
    "Policy is authority only; an installed connector/tool is still required.",
  ].join("\n");
}
