import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  fallbackWorkspaceContext,
  inspectWorkspaceContext,
  parsePullRequestStatus,
  type ReadOnlyCommandRunner,
} from "./workspaceContext.js";

test("fallback workspace identity uses the active folder without inventing git state", () => {
  const context = fallbackWorkspaceContext("/Users/tom/Documents/GitHub/sophia-agi");
  assert.equal(context.repo, "sophia-agi");
  assert.equal(context.branch, null);
  assert.equal(context.worktree, null);
  assert.equal(context.pr, "checking…");
  assert.equal(context.isGit, false);
});

test("pull request projection distinguishes open, draft, none, and invalid output", () => {
  assert.equal(
    parsePullRequestStatus('[{"number":2166,"state":"OPEN","isDraft":false}]'),
    "#2166 open",
  );
  assert.equal(
    parsePullRequestStatus('[{"number":2167,"state":"OPEN","isDraft":true}]'),
    "#2167 draft",
  );
  assert.equal(parsePullRequestStatus("[]"), "none");
  assert.equal(parsePullRequestStatus("not-json"), "unavailable");
});

test("workspace inspection reports canonical repo, linked worktree, branch, and PR", async () => {
  const root = "/private/tmp/sophia-ui";
  const common = "/Users/tom/Documents/GitHub/sophia-agi/.git";
  const run: ReadOnlyCommandRunner = async (executable, args) => {
    const key = `${executable} ${args.join(" ")}`;
    const values: Record<string, string> = {
      "git rev-parse --show-toplevel": root,
      "git rev-parse --git-common-dir": common,
      "git branch --show-current": "fix/tui-compact-status",
      "git rev-parse --short HEAD": "abc1234",
      "gh pr list --head fix/tui-compact-status --state all --limit 1 --json number,state,isDraft":
        '[{"number":2200,"state":"OPEN","isDraft":false}]',
    };
    return key in values
      ? { ok: true, stdout: values[key]! }
      : { ok: false, stdout: "" };
  };

  const context = await inspectWorkspaceContext(root, run);
  assert.deepEqual(context, {
    repo: "sophia-agi",
    branch: "fix/tui-compact-status",
    worktree: path.basename(root),
    pr: "#2200 open",
    isGit: true,
  });
});

test("workspace inspection degrades cleanly outside git", async () => {
  const run: ReadOnlyCommandRunner = async () => ({ ok: false, stdout: "" });
  const context = await inspectWorkspaceContext("/tmp/plain-folder", run);
  assert.equal(context.repo, "plain-folder");
  assert.equal(context.isGit, false);
  assert.equal(context.pr, "not a git repo");
});
