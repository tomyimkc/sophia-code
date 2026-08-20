import assert from "node:assert/strict";
import test from "node:test";

import {
  armFileRestore,
  confirmFileRestore,
  fileCheckpointRow,
  formatCheckpointAge,
  groupFileCheckpointsByRun,
  normalizeFileCheckpointEntries,
  normalizeFileCheckpointEntry,
  turnCheckpointSummary,
  type FileCheckpointEntry,
} from "./fileCheckpoints.js";

test("normalizeFileCheckpointEntry drops an entry with no path — nothing to show a row for", () => {
  assert.equal(normalizeFileCheckpointEntry({}), null);
  assert.equal(normalizeFileCheckpointEntry({ path: "" }), null);
  assert.equal(normalizeFileCheckpointEntry({ path: "   " }), null);
  assert.equal(normalizeFileCheckpointEntry(null), null);
  assert.equal(normalizeFileCheckpointEntry(undefined), null);
});

test("an entry with a backupPath is 'modified'; one without is 'created'", () => {
  const modified = normalizeFileCheckpointEntry({
    path: "/proj/src/a.ts",
    backupPath: "/backups/a-1.bak",
    ts: 1000,
    runId: "r1",
    turn: 2,
    tool: "edit_file",
  });
  assert.ok(modified);
  assert.equal(modified!.kind, "modified");
  assert.equal(modified!.tool, "edit_file");
  assert.equal(modified!.runId, "r1");
  assert.equal(modified!.turn, 2);

  const created = normalizeFileCheckpointEntry({
    path: "/proj/src/new.ts",
    ts: 1000,
  });
  assert.ok(created);
  assert.equal(created!.kind, "created");
  assert.equal(created!.backupPath, "");
  // Untrusted-boundary defaults: no tool name given still yields something sane.
  assert.equal(created!.tool, "edit");
  assert.equal(created!.runId, "");
  assert.equal(created!.turn, null);
});

test("every field on the raw event is treated as untrusted and coerced defensively", () => {
  const entry = normalizeFileCheckpointEntry({
    path: 42 as unknown as string,
    backupPath: {} as unknown as string,
    ts: "not a date",
    tool: 7 as unknown as string,
    runId: [] as unknown as string,
    turn: "not a number" as unknown as string,
  });
  // A non-string path is not usable — coerced to "" and dropped, same as missing.
  assert.equal(entry, null);
});

test("workspace-relative display path, and an out-of-workspace file keeps its absolute path", () => {
  const inWorkspace = normalizeFileCheckpointEntry(
    { path: "/home/op/proj/src/a.ts", backupPath: "/backups/a.bak", ts: 1 },
    { workspaceRoot: "/home/op/proj" },
  );
  assert.equal(inWorkspace!.displayPath, "src/a.ts");

  const outsideWorkspace = normalizeFileCheckpointEntry(
    { path: "/etc/hosts", backupPath: "/backups/hosts.bak", ts: 1 },
    { workspaceRoot: "/home/op/proj" },
  );
  assert.equal(outsideWorkspace!.displayPath, "/etc/hosts");

  const noRoot = normalizeFileCheckpointEntry({ path: "/home/op/proj/src/a.ts", ts: 1 });
  assert.equal(noRoot!.displayPath, "/home/op/proj/src/a.ts");
});

test("ts accepts both epoch milliseconds and an ISO-8601 string; anything else falls back to 0", () => {
  const epoch = normalizeFileCheckpointEntry({ path: "/a", ts: 1700000000000 });
  assert.equal(epoch!.ts, 1700000000000);

  const iso = normalizeFileCheckpointEntry({ path: "/a", ts: "2023-11-14T22:13:20.000Z" });
  assert.equal(iso!.ts, 1700000000000);

  const garbage = normalizeFileCheckpointEntry({ path: "/a", ts: "not-a-timestamp" });
  assert.equal(garbage!.ts, 0);

  const missing = normalizeFileCheckpointEntry({ path: "/a" });
  assert.equal(missing!.ts, 0);
});

test("the same raw event always folds to the same id — idempotent across a resumed replay", () => {
  const raw = { path: "/proj/a.ts", backupPath: "/b/a.bak", ts: 5000, runId: "r1", turn: 3 };
  const first = normalizeFileCheckpointEntry(raw);
  const second = normalizeFileCheckpointEntry({ ...raw });
  assert.equal(first!.id, second!.id);

  const differentTurn = normalizeFileCheckpointEntry({ ...raw, turn: 4 });
  assert.notEqual(first!.id, differentTurn!.id);
});

test("normalizeFileCheckpointEntries skips unusable entries without throwing", () => {
  const entries = normalizeFileCheckpointEntries([
    { path: "/a", ts: 1 },
    {},
    null,
    undefined,
    { path: "/b", backupPath: "/backups/b", ts: 2 },
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.path), ["/a", "/b"]);
});

test("formatCheckpointAge buckets: just now / Nm ago / Nh ago / Nd ago / unknown", () => {
  const now = 1_000_000_000;
  assert.equal(formatCheckpointAge(now - 10_000, now), "just now");
  assert.equal(formatCheckpointAge(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatCheckpointAge(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(formatCheckpointAge(now - 2 * 86_400_000, now), "2d ago");
  assert.equal(formatCheckpointAge(0, now), "unknown time");
  assert.equal(formatCheckpointAge(Number.NaN, now), "unknown time");
});

test("fileCheckpointRow: restorable only for a modified row with a real backupPath", () => {
  const modified = normalizeFileCheckpointEntry({ path: "/a", backupPath: "/b/a.bak", ts: 1 })!;
  const created = normalizeFileCheckpointEntry({ path: "/a", ts: 1 })!;
  assert.equal(fileCheckpointRow(modified, 2).restorable, true);
  assert.equal(fileCheckpointRow(created, 2).restorable, false);
});

test("turnCheckpointSummary reads naturally for 0, 1, and mixed rows", () => {
  assert.equal(turnCheckpointSummary([]), "no file changes recorded");
  const modified = fileCheckpointRow(
    normalizeFileCheckpointEntry({ path: "/a", backupPath: "/b/a.bak", ts: 1 })!,
    2,
  );
  assert.equal(turnCheckpointSummary([modified]), "1 file changed (1 modified)");
  const created = fileCheckpointRow(normalizeFileCheckpointEntry({ path: "/b", ts: 1 })!, 2);
  assert.equal(turnCheckpointSummary([modified, created]), "2 files changed (1 modified, 1 created)");
});

function entry(overrides: Partial<Record<string, unknown>>): FileCheckpointEntry {
  return normalizeFileCheckpointEntry({ path: "/proj/x.ts", ts: 1, ...overrides })!;
}

test("groupFileCheckpointsByRun: runs newest-first, turns ascending, rows newest-edit-first", () => {
  const entries: FileCheckpointEntry[] = [
    entry({ path: "/proj/a.ts", backupPath: "/b/a", ts: 1000, runId: "r1", turn: 1 }),
    entry({ path: "/proj/b.ts", ts: 2000, runId: "r1", turn: 1 }), // created, no backup
    entry({ path: "/proj/c.ts", backupPath: "/b/c", ts: 3000, runId: "r1", turn: 2 }),
    entry({ path: "/proj/d.ts", backupPath: "/b/d", ts: 5000, runId: "r2", turn: 1 }),
  ];
  const groups = groupFileCheckpointsByRun(entries, 6000);
  assert.equal(groups.length, 2);

  // r2's only edit is more recent than anything in r1, so r2 sorts first.
  assert.equal(groups[0].runId, "r2");
  assert.equal(groups[1].runId, "r1");

  const r1 = groups[1];
  assert.equal(r1.turns.length, 2);
  assert.equal(r1.turns[0].turn, 1);
  assert.equal(r1.turns[1].turn, 2);

  // Within turn 1, b.ts (ts 2000) was edited after a.ts (ts 1000) — newest first.
  assert.deepEqual(r1.turns[0].rows.map((row) => row.path), ["/proj/b.ts", "/proj/a.ts"]);
  assert.equal(r1.turns[0].summary, "2 files changed (1 modified, 1 created)");
  assert.equal(r1.turns[1].summary, "1 file changed (1 modified)");
});

test("groupFileCheckpointsByRun buckets entries with no run attribution under one '' group", () => {
  const entries = [entry({ path: "/proj/a.ts", ts: 1 }), entry({ path: "/proj/b.ts", ts: 2 })];
  const groups = groupFileCheckpointsByRun(entries, 3);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].runId, "");
  assert.equal(groups[0].turns.length, 1);
  assert.equal(groups[0].turns[0].turn, null);
  assert.equal(groups[0].turns[0].rows.length, 2);
});

test("groupFileCheckpointsByRun on an empty list returns no groups", () => {
  assert.deepEqual(groupFileCheckpointsByRun([], 0), []);
});

// ---------------------------------------------------------------------------
// Destructive-restore two-step confirmation.

test("armFileRestore refuses a 'created' row — there are no prior bytes to restore", () => {
  const created = fileCheckpointRow(entry({ path: "/proj/new.ts", ts: 1 }), 2);
  const result = armFileRestore(created);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /nothing to restore/);
});

test("armFileRestore refuses a row that claims 'modified' but somehow has no backupPath", () => {
  const result = armFileRestore({ id: "x", path: "/a", kind: "modified", backupPath: "" });
  assert.equal(result.ok, false);
});

test("armFileRestore arms a restorable row; confirmFileRestore requires the SAME entry id", () => {
  const row = fileCheckpointRow(entry({ path: "/proj/a.ts", backupPath: "/b/a.bak", ts: 1 }), 2);
  const armed = armFileRestore(row);
  assert.equal(armed.ok, true);
  if (!armed.ok) return;
  assert.equal(armed.intent.stage, "armed");
  assert.equal(armed.intent.entryId, row.id);
  assert.equal(armed.intent.backupPath, row.backupPath);

  // Confirming a DIFFERENT id than the one armed is rejected, not silently
  // applied to whatever the intent happens to hold.
  const wrongConfirm = confirmFileRestore(armed.intent, "some-other-row-id");
  assert.equal(wrongConfirm.ok, false);

  const confirmed = confirmFileRestore(armed.intent, row.id);
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) assert.equal(confirmed.intent.stage, "confirmed");
});

test("confirmFileRestore refuses to fire twice on the same intent", () => {
  const row = fileCheckpointRow(entry({ path: "/proj/a.ts", backupPath: "/b/a.bak", ts: 1 }), 2);
  const armed = armFileRestore(row);
  assert.equal(armed.ok, true);
  if (!armed.ok) return;
  const first = confirmFileRestore(armed.intent, row.id);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = confirmFileRestore(first.intent, row.id);
  assert.equal(second.ok, false);
});
