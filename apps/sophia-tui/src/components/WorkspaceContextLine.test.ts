import test from "node:test";
import assert from "node:assert/strict";
import { displayWidth } from "./PromptInput.js";
import { workspaceContextText } from "./WorkspaceContextLine.js";
import type { WorkspaceContext } from "../lib/workspaceContext.js";

const CONTEXT: WorkspaceContext = {
  repo: "sophia-agi",
  worktree: "sophia-tui-compact-status-chrome-20260814",
  branch: "fix/tui-compact-status-chrome-20260814",
  pr: "#2200 open",
  isGit: true,
};

test("wide prompt context shows repo, worktree, branch, PR, and session", () => {
  const text = workspaceContextText(CONTEXT, "session-42", 160);
  assert.match(text, /repo:sophia-agi/);
  assert.match(text, /wt:.*status-chrome-20260814/);
  assert.match(text, /git:fix\/tui/);
  assert.match(text, /PR:#2200 open/);
  assert.match(text, /session:session-42/);
  assert.ok(displayWidth(text) <= 160);
});

test("ordinary prompt context keeps repo, branch, PR, and session on one row", () => {
  const text = workspaceContextText(CONTEXT, "session-42", 100);
  assert.match(text, /repo:/);
  assert.match(text, /git:/);
  assert.match(text, /PR:#2200 open/);
  assert.match(text, /session:/);
  assert.ok(displayWidth(text) <= 100);
});

test("narrow prompt context never wraps or exceeds its terminal budget", () => {
  for (const width of [28, 40, 52, 67]) {
    const text = workspaceContextText(CONTEXT, "session-42", width);
    assert.ok(displayWidth(text) <= width, `width=${width}: ${text}`);
    assert.doesNotMatch(text, /wisdom gate|canclaimagi/i);
  }
});
