import assert from "node:assert/strict";
import test from "node:test";

import {
  fuzzySessionScore,
  includedInWorkspaceFilter,
  proposeForkedSessionName,
  rankSessionsByQuery,
  sessionWorkspaceScope,
  sessionWorkspaceScopeLabel,
  validateSessionName,
  type SessionScopeCandidate,
} from "./sessionScope.js";

// ---------------------------------------------------------------------------
// validateSessionName — security boundary.
//
// Control characters below are built with String.fromCharCode rather than a
// \u escape literal in source, so the test itself never has to carry a raw
// control byte on disk.
const NUL = String.fromCharCode(0);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);
const DEL = String.fromCharCode(0x7f);

test("accepts an ordinary session name unchanged (after trimming)", () => {
  const result = validateSessionName("  my-cool-session  ");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.name, "my-cool-session");
});

test("rejects a relative path-traversal attempt", () => {
  const result = validateSessionName("../../etc/passwd");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /path separator/);
  // The suggestion must itself be a legal name — an operator stuck without a
  // usable alternative is worse than an opinionated cleanup.
  const revalidated = validateSessionName(result.suggestion);
  assert.equal(revalidated.ok, true);
});

test("rejects an absolute POSIX path", () => {
  const result = validateSessionName("/etc/passwd");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /path separator/);
  assert.equal(validateSessionName(result.suggestion).ok, true);
});

test("rejects an absolute Windows path and a UNC path", () => {
  const drive = validateSessionName("C:\\Users\\bob\\secret");
  assert.equal(drive.ok, false);
  if (!drive.ok) assert.equal(validateSessionName(drive.suggestion).ok, true);

  const unc = validateSessionName("\\\\server\\share\\repo");
  assert.equal(unc.ok, false);
  if (!unc.ok) assert.equal(validateSessionName(unc.suggestion).ok, true);
});

test("rejects a name containing NUL (and other control characters)", () => {
  const withNul = validateSessionName(`bad${NUL}name`);
  assert.equal(withNul.ok, false);
  if (!withNul.ok) {
    assert.match(withNul.reason, /control character/);
    assert.equal(validateSessionName(withNul.suggestion).ok, true);
    // The suggestion must not still contain the NUL it was cleaning up.
    assert.ok(!withNul.suggestion.includes(NUL));
  }

  assert.equal(validateSessionName(`x${UNIT_SEPARATOR}y`).ok, false);
  assert.equal(validateSessionName(`x${DEL}y`).ok, false);
});

test("rejects an empty or whitespace-only name", () => {
  for (const candidate of ["", "   ", "\t\n"]) {
    const result = validateSessionName(candidate);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /empty/);
      assert.equal(validateSessionName(result.suggestion).ok, true);
    }
  }
});

test("rejects an absurdly long (500-character) name and truncates the suggestion", () => {
  const huge = "a".repeat(500);
  const result = validateSessionName(huge);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /too long/);
  const revalidated = validateSessionName(result.suggestion);
  assert.equal(revalidated.ok, true);
  assert.ok(result.suggestion.length <= 200);
});

test("rejects home-directory shorthand and bare '.' / '..'", () => {
  assert.equal(validateSessionName("~/secrets").ok, false);
  assert.equal(validateSessionName(".").ok, false);
  assert.equal(validateSessionName("..").ok, false);
});

test("coerces non-string input rather than throwing", () => {
  assert.equal(validateSessionName(null).ok, false);
  assert.equal(validateSessionName(undefined).ok, false);
  const numeric = validateSessionName(12345);
  assert.equal(numeric.ok, true);
  if (numeric.ok) assert.equal(numeric.name, "12345");
});

// ---------------------------------------------------------------------------
// proposeForkedSessionName.

test("proposes '<parent>-fork' when it does not collide", () => {
  assert.equal(proposeForkedSessionName("investigate-bug"), "investigate-bug-fork");
});

test("de-duplicates against existing sessions by numbering the suffix", () => {
  const existing = ["investigate-bug-fork", "investigate-bug-fork-2"];
  assert.equal(proposeForkedSessionName("investigate-bug", existing), "investigate-bug-fork-3");
});

test("a forked name derived from a hostile/illegal parent id is still itself valid", () => {
  const proposed = proposeForkedSessionName("../../etc/passwd");
  assert.equal(validateSessionName(proposed).ok, true);
});

test("a forked name never exceeds the length cap even for a very long parent id", () => {
  const proposed = proposeForkedSessionName("a".repeat(500));
  assert.equal(validateSessionName(proposed).ok, true);
});

test("terminates and finds a free name even with many pre-existing numbered forks", () => {
  const existing = ["p-fork", ...Array.from({ length: 20 }, (_, i) => `p-fork-${i + 2}`)];
  const proposed = proposeForkedSessionName("p", existing);
  assert.ok(!existing.includes(proposed));
  assert.equal(validateSessionName(proposed).ok, true);
});

// ---------------------------------------------------------------------------
// sessionWorkspaceScope.

test("a session recorded under the current cwd is 'current-project'", () => {
  assert.equal(sessionWorkspaceScope("/home/op/proj", "/home/op/proj"), "current-project");
  // Trailing slash differences should not create a false "other project".
  assert.equal(sessionWorkspaceScope("/home/op/proj/", "/home/op/proj"), "current-project");
});

test("a session recorded under a different cwd is 'other-project'", () => {
  assert.equal(sessionWorkspaceScope("/home/op/other-repo", "/home/op/proj"), "other-project");
});

test("a legacy session with no recorded cwd is 'unscoped', not 'other-project'", () => {
  assert.equal(sessionWorkspaceScope(undefined, "/home/op/proj"), "unscoped");
  assert.equal(sessionWorkspaceScope(null, "/home/op/proj"), "unscoped");
  assert.equal(sessionWorkspaceScope("", "/home/op/proj"), "unscoped");
});

test("includedInWorkspaceFilter hides only 'other-project', keeps current and unscoped", () => {
  assert.equal(includedInWorkspaceFilter("current-project"), true);
  assert.equal(includedInWorkspaceFilter("unscoped"), true);
  assert.equal(includedInWorkspaceFilter("other-project"), false);
});

test("sessionWorkspaceScopeLabel is blank only for unscoped", () => {
  assert.equal(sessionWorkspaceScopeLabel("current-project"), "this project");
  assert.equal(sessionWorkspaceScopeLabel("other-project"), "other project");
  assert.equal(sessionWorkspaceScopeLabel("unscoped"), "");
});

// ---------------------------------------------------------------------------
// fuzzySessionScore / rankSessionsByQuery.

test("fuzzySessionScore requires an in-order subsequence, not just shared letters", () => {
  assert.notEqual(fuzzySessionScore("brg", "bridge-panel-redesign"), null);
  // "gbr" is not a subsequence of "bridge" in that order.
  assert.equal(fuzzySessionScore("gbr", "bridge"), null);
});

test("fuzzySessionScore is case- and width-form-insensitive", () => {
  assert.notEqual(fuzzySessionScore("GRAPH", "graph-panel"), null);
});

test("fuzzySessionScore penalizes a wide match span, holding boundary context fixed", () => {
  // Both haystacks match 'm' and 'p' in a non-boundary position (immediately
  // after another letter, never after a separator) — isolating span from the
  // separate word-boundary bonus, which a naive "matched near the end of a
  // long string looks scattered" check would otherwise confound.
  const tight = fuzzySessionScore("mp", "xxxmpxxxxxxxxxxxxxxxxxxx");
  const scattered = fuzzySessionScore("mp", "xxxmxxxxxxxxxxxxxxxxxxxpx");
  assert.ok(tight !== null && scattered !== null);
  assert.ok(tight! > scattered!);
});

function candidate(overrides: Partial<SessionScopeCandidate>): SessionScopeCandidate {
  return { id: "sess-1", updatedAt: 0, ...overrides };
}

test("rankSessionsByQuery with an empty query sorts purely by recency", () => {
  const rows = [
    candidate({ id: "old", updatedAt: 1000 }),
    candidate({ id: "new", updatedAt: 5000 }),
    candidate({ id: "mid", updatedAt: 3000 }),
  ];
  const ranked = rankSessionsByQuery(rows, "", 9999);
  assert.deepEqual(ranked.map((r) => r.id), ["new", "mid", "old"]);
});

test("rankSessionsByQuery excludes candidates that do not match at all", () => {
  const rows = [
    candidate({ id: "graph", title: "graph panel redesign", updatedAt: 1 }),
    candidate({ id: "unrelated", title: "totally different topic", updatedAt: 2 }),
  ];
  const ranked = rankSessionsByQuery(rows, "graph", 100);
  assert.deepEqual(ranked.map((r) => r.id), ["graph"]);
});

test("rankSessionsByQuery: a strong title match beats a weak id-only match regardless of recency", () => {
  const rows = [
    candidate({ id: "s1", title: "unrelated topic entirely", updatedAt: 100 }),
    candidate({ id: "checkpoint-restore-work", title: "misc", updatedAt: 1 }),
  ];
  const ranked = rankSessionsByQuery(rows, "checkpoint-restore", 200);
  assert.equal(ranked[0].id, "checkpoint-restore-work");
});

test("rankSessionsByQuery: recency breaks ties between equally strong matches", () => {
  const rows = [
    candidate({ id: "older", title: "graph panel", updatedAt: 1000 }),
    candidate({ id: "newer", title: "graph panel", updatedAt: 9000 }),
  ];
  const ranked = rankSessionsByQuery(rows, "graph panel", 10_000);
  assert.deepEqual(ranked.map((r) => r.id), ["newer", "older"]);
});

test("rankSessionsByQuery also matches against topic when title is absent", () => {
  const rows = [candidate({ id: "s1", topic: "fix the graph panel redesign", updatedAt: 1 })];
  const ranked = rankSessionsByQuery(rows, "panel redesign", 10);
  assert.equal(ranked.length, 1);
});
