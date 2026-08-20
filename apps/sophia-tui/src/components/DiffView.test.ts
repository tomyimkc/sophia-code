import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiffPreview,
  diffPreviewLineCount,
  isUnifiedDiff,
} from "./DiffView.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const safe = true;",
  "-const token = 'github_pat_abcdefghijklmnopqrstuvwxyz';",
  "+const token = process.env.GITHUB_TOKEN;",
  "+console.log('done');",
].join("\n");

test("recognizes common unified diff forms", () => {
  assert.equal(isUnifiedDiff(DIFF), true);
  assert.equal(isUnifiedDiff("@@ -1 +1 @@\n-old\n+new"), true);
  assert.equal(isUnifiedDiff("ordinary tool output"), false);
});

test("builds sanitized diff rows and exact complete-scan stats", () => {
  const preview = buildDiffPreview(DIFF, { maxLines: 20, maxColumns: 200 });
  assert.equal(preview.files, 1);
  assert.equal(preview.additions, 2);
  assert.equal(preview.deletions, 1);
  assert.equal(preview.statsComplete, true);
  assert.equal(preview.truncated, false);
  assert.equal(preview.lines.some((line) => line.text.includes("github_pat_")), false);
  assert.equal(preview.lines.some((line) => line.text.includes("[REDACTED]")), true);
  assert.equal(diffPreviewLineCount(preview), 1 + preview.lines.length);
});

test("diff preview obeys line, hunk, file, width, and scan bounds", () => {
  const huge = Array.from({ length: 60 }, (_, index) => [
    `diff --git a/f${index}.txt b/f${index}.txt`,
    `--- a/f${index}.txt`,
    `+++ b/f${index}.txt`,
    "@@ -1 +1 @@",
    `-${"x".repeat(120)}`,
    `+${"y".repeat(120)}`,
  ].join("\n")).join("\n");
  const preview = buildDiffPreview(huge, {
    maxLines: 7,
    maxFiles: 2,
    maxHunks: 2,
    maxColumns: 32,
    scanLimit: 2_048,
  });
  assert.ok(preview.lines.length <= 7);
  assert.ok(preview.lines.every((line) => line.text.length <= 32));
  assert.equal(preview.truncated, true);
  assert.equal(preview.statsComplete, false);
  assert.ok(preview.omittedLines > 0);
  assert.equal(diffPreviewLineCount(preview), 1 + preview.lines.length + 1);
});

test("terminal escape sequences never survive into diff rows", () => {
  const preview = buildDiffPreview("diff --git a/a b/a\n@@ -1 +1 @@\n-\x1b[31mbad\x1b[0m\n+good");
  assert.equal(preview.lines.some((line) => line.text.includes("\x1b")), false);
});
