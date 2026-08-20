/**
 * Rebuildable, local-only session index.
 *
 * The index is a cache, never the source of truth. It is reconstructed from
 * legacy transcript JSON arrays plus hidden metadata/archive sidecars, so
 * deleting or corrupting .session-index.json cannot lose a session.
 */
import { existsSync, readFileSync } from "node:fs";

import {
  LOCAL_ONLY_SESSION_POLICY,
  atomicWriteJsonFile,
  listArchivedSessionsFromDisk,
  listSessionsFromDisk,
  loadSessionMetadata,
  sessionIndexPath,
  type LocalOnlySessionPolicy,
  type SessionListItem,
} from "./sessionStore.js";

export const SESSION_INDEX_SCHEMA = "sophia.tui.session_index.v1" as const;

export interface SessionIndexEntry {
  id: string;
  name: string;
  title: string;
  path: string;
  turns: number;
  createdAt: string;
  updatedAt: number;
  description: string;
  lastPreview: string;
  tags: string[];
  archived: boolean;
  parentSessionId?: string;
  forkedAt?: string;
  checkpointCount: number;
  storagePolicy: LocalOnlySessionPolicy;
}

export interface SessionIndex {
  schema: typeof SESSION_INDEX_SCHEMA;
  generatedAt: string;
  entries: SessionIndexEntry[];
  storagePolicy: LocalOnlySessionPolicy;
  candidateOnly: true;
  canClaimAGI: false;
}

export interface RebuildSessionIndexOptions {
  includeArchived?: boolean;
  persist?: boolean;
  now?: Date;
  limit?: number;
}

export interface SessionIndexFilter {
  query?: string;
  tags?: readonly string[];
  tagMode?: "all" | "any";
  archived?: boolean | "all";
  parentSessionId?: string;
  updatedAfter?: number | Date;
  updatedBefore?: number | Date;
  minTurns?: number;
  maxTurns?: number;
}

function asEntry(row: SessionListItem): SessionIndexEntry {
  const metadata = loadSessionMetadata(row.id);
  return {
    id: row.id,
    name: row.name,
    title: row.title || metadata.title || row.name,
    path: row.path,
    turns: Math.max(0, Math.floor(row.turns)),
    createdAt: metadata.createdAt,
    updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    description: row.description || "",
    lastPreview: row.lastPreview || "",
    tags: [...(row.tags || metadata.tags || [])],
    archived: row.archived === true,
    ...(row.parentSessionId || metadata.parent?.sessionId
      ? { parentSessionId: row.parentSessionId || metadata.parent?.sessionId }
      : {}),
    ...(metadata.parent?.forkedAt ? { forkedAt: metadata.parent.forkedAt } : {}),
    checkpointCount: row.checkpointCount ?? metadata.checkpoints.length,
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
  };
}

function normalizeIndex(value: unknown): SessionIndex | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== SESSION_INDEX_SCHEMA || !Array.isArray(raw.entries)) return null;
  const entries: SessionIndexEntry[] = [];
  for (const valueEntry of raw.entries) {
    if (!valueEntry || typeof valueEntry !== "object" || Array.isArray(valueEntry)) continue;
    const entry = valueEntry as Record<string, unknown>;
    const id = String(entry.id || "").trim();
    if (!id) continue;
    const updatedAt = Number(entry.updatedAt);
    entries.push({
      id,
      name: String(entry.name || id),
      title: String(entry.title || entry.name || id),
      path: String(entry.path || ""),
      turns: Math.max(0, Math.floor(Number(entry.turns) || 0)),
      createdAt: String(entry.createdAt || ""),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      description: String(entry.description || ""),
      lastPreview: String(entry.lastPreview || ""),
      tags: Array.isArray(entry.tags)
        ? [...new Set(entry.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].sort()
        : [],
      archived: entry.archived === true,
      ...(entry.parentSessionId ? { parentSessionId: String(entry.parentSessionId) } : {}),
      ...(entry.forkedAt ? { forkedAt: String(entry.forkedAt) } : {}),
      checkpointCount: Math.max(0, Math.floor(Number(entry.checkpointCount) || 0)),
      storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
    });
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return {
    schema: SESSION_INDEX_SCHEMA,
    generatedAt: String(raw.generatedAt || ""),
    entries,
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
    candidateOnly: true,
    canClaimAGI: false,
  };
}

export function rebuildSessionIndex(options: RebuildSessionIndexOptions = {}): SessionIndex {
  const limit = Math.max(0, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER));
  const active = listSessionsFromDisk(limit);
  const archived = options.includeArchived === false
    ? []
    : listArchivedSessionsFromDisk(limit);
  const byIdentity = new Map<string, SessionIndexEntry>();
  for (const row of [...active, ...archived]) {
    const entry = asEntry(row);
    // Archive and active copies can temporarily coexist after a crash-safe
    // archive commit. The active transcript wins until cleanup completes.
    const key = `${entry.archived ? "archive" : "active"}:${entry.id}`;
    byIdentity.set(key, entry);
  }
  const entries = [...byIdentity.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, limit);
  const index: SessionIndex = {
    schema: SESSION_INDEX_SCHEMA,
    generatedAt: (options.now || new Date()).toISOString(),
    entries,
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
    candidateOnly: true,
    canClaimAGI: false,
  };
  if (options.persist) saveSessionIndex(index);
  return index;
}

export function saveSessionIndex(index: SessionIndex, file = sessionIndexPath()): void {
  const normalized = normalizeIndex(index);
  if (!normalized) throw new Error("invalid session index");
  atomicWriteJsonFile(file, normalized);
}

export function loadSessionIndex(
  file = sessionIndexPath(),
  options: { rebuildIfMissing?: boolean; includeArchived?: boolean } = {},
): SessionIndex | null {
  try {
    if (!existsSync(file)) {
      return options.rebuildIfMissing
        ? rebuildSessionIndex({ includeArchived: options.includeArchived, persist: true })
        : null;
    }
    const bytes = readFileSync(file);
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const normalized = normalizeIndex(parsed);
    if (normalized) return normalized;
  } catch {
    /* A cache fault is recoverable by rebuilding from source files. */
  }
  return options.rebuildIfMissing
    ? rebuildSessionIndex({ includeArchived: options.includeArchived, persist: true })
    : null;
}

function timeValue(value: number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function searchableText(entry: SessionIndexEntry): string {
  return [
    entry.id,
    entry.name,
    entry.title,
    entry.description,
    entry.lastPreview,
    entry.parentSessionId || "",
    ...entry.tags,
  ].join("\n").toLowerCase();
}

/** Deterministic local search/filter; no transcript bodies or network calls. */
export function searchSessionIndex(
  indexOrEntries: SessionIndex | readonly SessionIndexEntry[],
  filter: SessionIndexFilter = {},
): SessionIndexEntry[] {
  const entries = Array.isArray(indexOrEntries)
    ? indexOrEntries as readonly SessionIndexEntry[]
    : (indexOrEntries as SessionIndex).entries;
  const terms = String(filter.query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const tags = [...new Set((filter.tags || []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))];
  const after = timeValue(filter.updatedAfter);
  const before = timeValue(filter.updatedBefore);
  const minTurns = filter.minTurns === undefined ? undefined : Math.max(0, Math.floor(filter.minTurns));
  const maxTurns = filter.maxTurns === undefined ? undefined : Math.max(0, Math.floor(filter.maxTurns));
  return entries
    .filter((entry) => {
      if (filter.archived !== undefined && filter.archived !== "all" && entry.archived !== filter.archived) {
        return false;
      }
      if (filter.parentSessionId && entry.parentSessionId !== filter.parentSessionId) return false;
      if (after !== undefined && entry.updatedAt < after) return false;
      if (before !== undefined && entry.updatedAt > before) return false;
      if (minTurns !== undefined && entry.turns < minTurns) return false;
      if (maxTurns !== undefined && entry.turns > maxTurns) return false;
      const haystack = searchableText(entry);
      if (terms.some((term) => !haystack.includes(term))) return false;
      if (tags.length) {
        const entryTags = new Set(entry.tags.map((tag) => tag.toLowerCase()));
        const matches = tags.map((tag) => entryTags.has(tag));
        if (filter.tagMode === "any" ? !matches.some(Boolean) : !matches.every(Boolean)) return false;
      }
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/** Alias matching command-oriented callers. */
export const filterSessions = searchSessionIndex;
