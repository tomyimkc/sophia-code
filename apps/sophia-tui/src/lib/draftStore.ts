import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DraftSnapshot {
  version: 1;
  key: string;
  text: string;
  /** Grapheme caret offset, when the caller tracks it. */
  cursor?: number;
  updatedAt: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DraftStore {
  load(key: string): Promise<DraftSnapshot | null>;
  save(snapshot: DraftSnapshot): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DraftAutosaveOptions {
  delayMs?: number;
  onError?: (error: unknown) => void;
}

const DRAFT_VERSION = 1;
const MAX_DRAFT_BYTES = 4 * 1024 * 1024;

export function defaultDraftDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const stateRoot = env.SOPHIA_STATE_DIR || env.SOPHIA_USER_STATE || path.join(homeDirectory, ".sophia");
  return path.join(stateRoot, "drafts");
}

/** Stable, path-spelling-sensitive key; no workspace path leaks into filenames. */
export function draftKeyForWorkspace(workspace: string, slot = "prompt"): string {
  return createHash("sha256")
    .update(`${workspace}\u0000${slot}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function createDraftSnapshot(
  key: string,
  text: string,
  options: {
    cursor?: number;
    now?: Date | number | string;
    metadata?: DraftSnapshot["metadata"];
  } = {},
): DraftSnapshot {
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.now ?? Date.now());
  const snapshot: DraftSnapshot = {
    version: DRAFT_VERSION,
    key,
    text: text.replace(/\r\n?/g, "\n"),
    updatedAt: now.toISOString(),
  };
  if (options.cursor !== undefined) snapshot.cursor = Math.max(0, Math.trunc(options.cursor));
  if (options.metadata) snapshot.metadata = { ...options.metadata };
  return snapshot;
}

export function parseDraftSnapshot(raw: string, expectedKey?: string): DraftSnapshot | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_DRAFT_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Partial<DraftSnapshot>;
    if (
      value.version !== DRAFT_VERSION
      || typeof value.key !== "string"
      || typeof value.text !== "string"
      || typeof value.updatedAt !== "string"
      || Number.isNaN(Date.parse(value.updatedAt))
      || (expectedKey !== undefined && value.key !== expectedKey)
      || (value.cursor !== undefined && (!Number.isInteger(value.cursor) || value.cursor < 0))
    ) {
      return null;
    }
    return {
      version: DRAFT_VERSION,
      key: value.key,
      text: value.text.replace(/\r\n?/g, "\n"),
      updatedAt: value.updatedAt,
      ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
      ...(value.metadata && typeof value.metadata === "object" ? { metadata: value.metadata } : {}),
    };
  } catch {
    return null;
  }
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, DraftSnapshot>();

  async load(key: string): Promise<DraftSnapshot | null> {
    const value = this.drafts.get(key);
    return value ? structuredClone(value) : null;
  }

  async save(snapshot: DraftSnapshot): Promise<void> {
    this.drafts.set(snapshot.key, structuredClone(snapshot));
  }

  async remove(key: string): Promise<void> {
    this.drafts.delete(key);
  }
}

export class FileDraftStore implements DraftStore {
  readonly directory: string;
  private sequence = 0;

  constructor(directory = defaultDraftDirectory()) {
    this.directory = directory;
  }

  fileForKey(key: string): string {
    const safe = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 40);
    return path.join(this.directory, `${safe}.json`);
  }

  async load(key: string): Promise<DraftSnapshot | null> {
    try {
      const raw = await readFile(this.fileForKey(key), "utf8");
      return parseDraftSnapshot(raw, key);
    } catch {
      // Drafts are convenience state. Missing, corrupt, or unreadable state
      // must never prevent the composer from opening.
      return null;
    }
  }

  async save(snapshot: DraftSnapshot): Promise<void> {
    const serialized = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_DRAFT_BYTES) {
      throw new Error(`draft exceeds ${MAX_DRAFT_BYTES} byte local autosave limit`);
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.fileForKey(snapshot.key);
    const temporary = `${destination}.${process.pid}.${this.sequence++}.tmp`;
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch {
      // Windows and some network filesystems can refuse replace-on-rename.
      // Fall back to a direct restricted write; never leave the temp payload.
      try {
        await writeFile(destination, serialized, { encoding: "utf8", mode: 0o600 });
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.fileForKey(key), { force: true });
  }
}

/**
 * Debounced latest-wins autosave queue. Writes are serialized so a slow older
 * save can never finish after (and overwrite) a newer snapshot.
 */
export class DraftAutosave {
  private readonly store: DraftStore;
  private readonly delayMs: number;
  private readonly onError: (error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: DraftSnapshot | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(store: DraftStore, options: DraftAutosaveOptions = {}) {
    this.store = store;
    this.delayMs = Math.max(0, Math.trunc(options.delayMs ?? 500));
    this.onError = options.onError ?? (() => undefined);
  }

  schedule(snapshot: DraftSnapshot): void {
    if (this.disposed) return;
    this.pending = structuredClone(snapshot);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(this.onError);
    }, this.delayMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot) {
      await this.writeChain;
      return;
    }
    this.writeChain = this.writeChain.then(() => this.store.save(snapshot));
    await this.writeChain;
  }

  async clear(key: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending?.key === key) this.pending = null;
    await this.writeChain;
    await this.store.remove(key);
  }

  async dispose(options: { flush?: boolean } = {}): Promise<void> {
    if (options.flush ?? true) await this.flush();
    else if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.disposed = true;
  }
}
