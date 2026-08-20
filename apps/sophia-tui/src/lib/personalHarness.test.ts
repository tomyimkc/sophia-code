import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configuredHarnessProfile,
  formatArtifacts,
  formatConnectorPolicies,
  formatHarnessReceipt,
  formatMemoryReview,
  formatPersonalMemoryStatus,
  formatPersonalRecall,
  formatPromptReceipt,
  searchPersonalMemory,
} from "./personalHarness.js";

function withHarnessState<T>(fn: (state: string) => T): T {
  const state = path.join(
    os.tmpdir(),
    `sophia-personal-harness-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(state, { recursive: true });
  const priorState = process.env.SOPHIA_STATE_DIR;
  const priorMemory = process.env.SOPHIA_PERSONAL_MEMORY_DIR;
  const priorConfig = process.env.SOPHIA_CODE_CONFIG;
  process.env.SOPHIA_STATE_DIR = state;
  process.env.SOPHIA_PERSONAL_MEMORY_DIR = path.join(state, "personal-memory");
  delete process.env.SOPHIA_CODE_CONFIG;
  try {
    return fn(state);
  } finally {
    if (priorState === undefined) delete process.env.SOPHIA_STATE_DIR;
    else process.env.SOPHIA_STATE_DIR = priorState;
    if (priorMemory === undefined) delete process.env.SOPHIA_PERSONAL_MEMORY_DIR;
    else process.env.SOPHIA_PERSONAL_MEMORY_DIR = priorMemory;
    if (priorConfig === undefined) delete process.env.SOPHIA_CODE_CONFIG;
    else process.env.SOPHIA_CODE_CONFIG = priorConfig;
    rmSync(state, { recursive: true, force: true });
  }
}

test("personal memory status and recall read canonical Markdown only", () => {
  withHarnessState((state) => {
    const memory = path.join(state, "personal-memory");
    mkdirSync(path.join(memory, "projects"), { recursive: true });
    writeFileSync(
      path.join(memory, "projects", "sophia-tui.md"),
      [
        "---",
        "name: sophia-tui",
        "description: Sophia TUI preferences.",
        "sources: [chat]",
        "---",
        "",
        "- [stated] The harness should work well with local LLMs.",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(memory, "private.enc.jsonl"),
      '{"ciphertext":"local LLM secret must never be searched"}\n',
      "utf8",
    );
    const hits = searchPersonalMemory("local LLMs");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].subject, "sophia-tui");
    assert.match(formatPersonalRecall("local LLMs"), /work well with local LLMs/);
    assert.doesNotMatch(formatPersonalRecall("secret"), /ciphertext/);
    assert.match(formatPersonalMemoryStatus(process.cwd()), /1 stated fact/);
  });
});

test("review output exposes hashes and actions, not fact plaintext", () => {
  withHarnessState((state) => {
    const memory = path.join(state, "personal-memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(
      path.join(memory, "audit.jsonl"),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00Z",
        action: "review_required",
        namespace: "preferences",
        subject: "communication",
        factHash: "deadbeef",
      }) + "\n",
      "utf8",
    );
    const output = formatMemoryReview();
    assert.match(output, /review_required/);
    assert.match(output, /deadbeef/);
  });
});

test("receipt, prompt, connector, and artifact views use local receipts", () => {
  withHarnessState((state) => {
    writeFileSync(
      path.join(state, "config.toml"),
      [
        "[prompt]",
        'profile = "personal-v2"',
        "",
        "[connectors.github]",
        "enabled = true",
        'read = "auto"',
        'write = "confirm"',
      ].join("\n"),
      "utf8",
    );
    const receiptDir = path.join(state, "receipts", "test-session");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(
      path.join(receiptDir, "latest.json"),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00Z",
        runId: "run-1",
        profile: "personal-v2",
        modelClass: "local",
        selection: {
          memory: [{ source: "profile.md" }],
          memoryWrites: [{ namespace: "preferences", status: "saved" }],
          pastChats: [],
          skills: [{ name: "code-review" }],
          research: { decision: "direct", reason: "stable" },
          connectors: [
            { name: "github", enabled: true, read: "auto", write: "confirm" },
          ],
        },
        prompt: {
          profile: "local",
          budget_tokens: 4500,
          estimated_tokens: 1200,
          included: [
            { name: "identity", source: "core", action: "included", estimated_tokens: 20 },
          ],
          dropped: [],
        },
      }),
      "utf8",
    );
    const artifacts = path.join(state, "artifacts", "test-session");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, "report.md"), "# Report\n", "utf8");

    assert.equal(configuredHarnessProfile(process.cwd()), "personal-v2");
    assert.match(formatHarnessReceipt("test-session"), /code-review/);
    assert.match(formatHarnessReceipt("test-session"), /1 capture decision/);
    assert.match(formatPromptReceipt("test-session"), /1200\/4500/);
    assert.match(formatConnectorPolicies(process.cwd(), "test-session"), /write=confirm/);
    assert.match(formatArtifacts("test-session"), /report\.md/);
  });
});
