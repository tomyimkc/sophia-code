import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DraftAutosave,
  FileDraftStore,
  MemoryDraftStore,
  createDraftSnapshot,
  defaultDraftDirectory,
  draftKeyForWorkspace,
  parseDraftSnapshot,
  type DraftSnapshot,
  type DraftStore,
} from "./draftStore.js";

test("draft keys are deterministic and do not expose the workspace path", () => {
  const workspace = String.raw`C:\Users\Tom\repo`;
  const first = draftKeyForWorkspace(workspace);
  assert.equal(first, draftKeyForWorkspace(workspace));
  assert.notEqual(first, draftKeyForWorkspace(workspace, "review"));
  assert.ok(!first.includes("Users"));
});

test("default local draft directory honors state env on every platform", () => {
  assert.equal(
    defaultDraftDirectory({ SOPHIA_STATE_DIR: path.join("tmp", "state") }, path.join("home", "x")),
    path.join("tmp", "state", "drafts"),
  );
  assert.equal(
    defaultDraftDirectory({}, path.join("home", "x")),
    path.join("home", "x", ".sophia", "drafts"),
  );
});

test("snapshot creation normalizes multiline text and round-trips validation", () => {
  const snapshot = createDraftSnapshot("k", "one\r\ntwo", {
    cursor: 3,
    now: "2026-07-30T00:00:00.000Z",
    metadata: { mode: "vim", reviewed: false },
  });
  assert.equal(snapshot.text, "one\ntwo");
  assert.deepEqual(parseDraftSnapshot(JSON.stringify(snapshot), "k"), snapshot);
  assert.equal(parseDraftSnapshot("{bad json", "k"), null);
  assert.equal(parseDraftSnapshot(JSON.stringify(snapshot), "another-key"), null);
});

test("memory store clones values so callers cannot mutate persisted state", async () => {
  const store = new MemoryDraftStore();
  const snapshot = createDraftSnapshot("k", "hello", { now: 0 });
  await store.save(snapshot);
  snapshot.text = "mutated";
  assert.equal((await store.load("k"))?.text, "hello");
  await store.remove("k");
  assert.equal(await store.load("k"), null);
});

test("file store writes restricted JSON, loads it, tolerates corruption, and removes it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sophia-drafts-"));
  try {
    const store = new FileDraftStore(directory);
    const snapshot = createDraftSnapshot("workspace", "多行\n👩‍💻", {
      cursor: 4,
      now: "2026-07-30T01:02:03.000Z",
    });
    await store.save(snapshot);
    assert.deepEqual(await store.load("workspace"), snapshot);
    assert.match(await readFile(store.fileForKey("workspace"), "utf8"), /"version":1/);

    await writeFile(store.fileForKey("workspace"), "not json", "utf8");
    assert.equal(await store.load("workspace"), null);
    await store.remove("workspace");
    assert.equal(await store.load("workspace"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("autosave coalesces scheduled drafts and flushes only the latest snapshot", async () => {
  const saved: DraftSnapshot[] = [];
  const store: DraftStore = {
    async load() { return null; },
    async save(snapshot) { saved.push(structuredClone(snapshot)); },
    async remove() {},
  };
  const autosave = new DraftAutosave(store, { delayMs: 60_000 });
  autosave.schedule(createDraftSnapshot("k", "one", { now: 1 }));
  autosave.schedule(createDraftSnapshot("k", "two", { now: 2 }));
  autosave.schedule(createDraftSnapshot("k", "three", { now: 3 }));
  await autosave.flush();
  assert.deepEqual(saved.map((snapshot) => snapshot.text), ["three"]);
  await autosave.dispose();
});

test("autosave serializes slow writes so newer content wins deterministically", async () => {
  const completed: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const store: DraftStore = {
    async load() { return null; },
    async save(snapshot) {
      calls += 1;
      if (calls === 1) await firstGate;
      completed.push(snapshot.text);
    },
    async remove() {},
  };
  const autosave = new DraftAutosave(store, { delayMs: 60_000 });
  autosave.schedule(createDraftSnapshot("k", "old"));
  const firstFlush = autosave.flush();
  autosave.schedule(createDraftSnapshot("k", "new"));
  const secondFlush = autosave.flush();
  releaseFirst?.();
  await Promise.all([firstFlush, secondFlush]);
  assert.deepEqual(completed, ["old", "new"]);
  await autosave.dispose();
});
