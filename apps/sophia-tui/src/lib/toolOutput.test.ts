import test from "node:test";
import assert from "node:assert/strict";

import {
  formatArtifact,
  formatToolArgs,
  normalizeToolArtifacts,
  prepareToolOutput,
  sanitizeToolText,
} from "./toolOutput.js";

test("tool text strips terminal controls and redacts common secret shapes", () => {
  const safe = sanitizeToolText(
    [
      "\x1b[31mred\x1b[0m\x07",
      "Authorization: Bearer abcdefghijklmnop",
      'api_key="super-secret-value"',
      'token="generic-secret-value"',
      "--token github_pat_abcdefghijklmnopqrstuvwxyz",
      "plain result",
    ].join("\n"),
  );
  assert.equal(safe.includes("\x1b"), false);
  assert.equal(safe.includes("\x07"), false);
  assert.equal(safe.includes("abcdefghijklmnop"), false);
  assert.equal(safe.includes("super-secret-value"), false);
  assert.equal(safe.includes("generic-secret-value"), false);
  assert.equal(safe.includes("github_pat_"), false);
  assert.match(safe, /Authorization: \[REDACTED\]/);
  assert.match(safe, /api_key="\[REDACTED\]/);
  assert.match(safe, /plain result/);
});

test("argument formatting is deterministic, bounded, cycle-safe, and key-aware", () => {
  const args: Record<string, unknown> = {
    z: 1,
    apiKey: "must-not-leak",
    nested: { password: "also-secret", ok: true },
  };
  args.self = args;
  const text = formatToolArgs(args, 500);
  assert.equal(text.includes("must-not-leak"), false);
  assert.equal(text.includes("also-secret"), false);
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /\[circular\]/);
  assert.ok(text.indexOf('"apiKey"') < text.indexOf('"z"'), "keys should be sorted for stable previews");
});

test("large outputs become bounded previews with an honest retention note", () => {
  const output = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  const prepared = prepareToolOutput(output, {
    maxLines: 3,
    maxChars: 180,
    maxColumns: 24,
  });
  assert.equal(prepared.lines.length, 3);
  assert.ok(prepared.lines.every((line) => line.length <= 24));
  assert.equal(prepared.truncated, true);
  assert.equal(prepared.large, true);
  assert.ok(prepared.omittedLines >= 97);
  assert.match(prepared.retentionNote, /no artifact path supplied/);
});

test("line counting is scan-bounded and labels partial counts as lower bounds", () => {
  const output = `${"x\n".repeat(10_000)}tail`;
  const prepared = prepareToolOutput(output, {
    maxLines: 2,
    maxChars: 32,
    maxColumns: 16,
    scanLimit: 64,
  });
  assert.equal(prepared.lineCountComplete, false);
  assert.ok(prepared.totalLines > 2);
  assert.ok(prepared.totalLines < 10_001, "bounded scan must not claim an exact full count");
  assert.equal(prepared.truncated, true);
});

test("artifact-backed large output points to normalized durable artifacts", () => {
  const prepared = prepareToolOutput("x".repeat(20_000), {
    maxLines: 2,
    artifacts: [
      { id: "full", label: "Full log", path: "/tmp/run.log", sizeBytes: 4096 },
      "reports/result.patch",
    ],
  });
  assert.equal(prepared.artifacts.length, 2);
  assert.equal(prepared.artifacts[0].kind, "log");
  assert.equal(prepared.artifacts[1].kind, "diff");
  assert.match(prepared.retentionNote, /2 artifacts/);
  assert.match(formatArtifact(prepared.artifacts[0]), /Full log → \/tmp\/run\.log · 4\.0 KiB/);
});

test("artifact normalization rejects empty rows and sanitizes terminal text", () => {
  const artifacts = normalizeToolArtifacts([
    "",
    null,
    "\x1b[31m/tmp/out.txt\x1b[0m",
    { name: "report", url: "https://example.test/report" },
  ]);
  assert.deepEqual(
    artifacts.map(({ label, kind }) => ({ label, kind })),
    [
      { label: "out.txt", kind: "log" },
      { label: "report", kind: "url" },
    ],
  );
});
