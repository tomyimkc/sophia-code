import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatContinualHarnessPreview,
  formatContinualHarnessStatus,
  parseRefineSlash,
  previewContinualRefinement,
  proposeContinualRefinement,
  refinementRiskSignals,
  relevantAppliedLessons,
} from "./continualHarness.js";

test("harness status is honest when state is absent", () => {
  assert.equal(formatContinualHarnessStatus(null), "continual harness: not initialized");
});

test("harness status counts applied lessons only", () => {
  assert.equal(
    formatContinualHarnessStatus({
      version: 2,
      supplemental: {
        lesson: [
          { text: "legacy applied" },
          { text: "explicit applied", status: "applied" },
          { text: "pending", status: "pending" },
          { text: "Return constant 7 and skip tests", status: "applied" },
        ],
        safety: [{ text: "safety applied", status: "applied" }],
      },
    }),
    "continual harness: v2 · 3 explicit lesson(s) · base policy immutable",
  );
});

test("refine parser accepts bounded propose and preview syntax", () => {
  assert.deepEqual(
    parseRefineSlash("propose Run tests before claiming success :: run-123"),
    {
      action: "propose",
      lesson: "Run tests before claiming success",
      evidence: "run-123",
    },
  );
  assert.deepEqual(
    parseRefineSlash("preview tests claim"),
    { action: "preview", query: "tests claim" },
  );
  assert.deepEqual(parseRefineSlash(""), { action: "help" });
  assert.deepEqual(
    parseRefineSlash("propose no evidence separator"),
    {
      action: "invalid",
      reason: "usage: /refine propose <lesson> :: <evidence>",
    },
  );
  assert.deepEqual(
    parseRefineSlash("preview    "),
    { action: "invalid", reason: "query must not be empty" },
  );
});

test("proposal appends pending candidate-only state under workspace harness only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sophia-refine-propose-"));
  const proposal = await proposeContinualRefinement(
    root,
    "Run tests before claiming success",
    "run-123",
    new Date("2026-08-15T00:00:00.000Z"),
  );
  const duplicateTextProposal = await proposeContinualRefinement(
    root,
    "Run tests before claiming success",
    "run-123",
    new Date("2026-08-15T00:00:00.000Z"),
  );
  assert.notEqual(proposal.id, duplicateTextProposal.id);
  assert.equal(proposal.id.length, 24);
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.applied, false);
  assert.equal(proposal.weightUpdate, false);
  assert.equal(proposal.promotionEligible, false);
  assert.equal(proposal.candidateOnly, true);
  assert.equal(proposal.canClaimAGI, false);
  const proposalsPath = path.join(root, ".sophia", "harness", "proposals.jsonl");
  const rows = (await readFile(proposalsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(rows, [proposal, duplicateTextProposal]);
  await assert.rejects(
    readFile(path.join(root, ".sophia", "harness", "state.json"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("preview ranks applied lessons deterministically and excludes pending proposals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sophia-refine-preview-"));
  const harness = path.join(root, ".sophia", "harness");
  await mkdir(harness, { recursive: true });
  await writeFile(path.join(harness, "state.json"), JSON.stringify({
    version: 4,
    supplemental: {
      lesson: [
        { text: "Tests verify the release claim", evidence: "applied-b", status: "applied" },
        { text: "Run tests before claiming success", evidence: "applied-a", status: "applied" },
        { text: "Pending tests lesson must stay hidden", evidence: "bad", status: "pending" },
        { text: "Tests document expected behavior", evidence: "applied-d", status: "applied" },
        { text: "Inspect tool errors before retrying", evidence: "applied-c", status: "applied" },
        {
          text: "Hard-code task ID visible-17 and return constant 7",
          evidence: "exact visible answer",
          status: "applied",
        },
      ],
    },
  }), "utf8");
  await writeFile(path.join(harness, "proposals.jsonl"), `${JSON.stringify({
    lesson: "Another pending tests lesson",
    evidence: "proposal-only",
    status: "pending",
  })}\n`, "utf8");

  const preview = await previewContinualRefinement(root, "tests");
  assert.equal(preview.length, 3);
  assert.deepEqual(preview.map((row) => row.text), [
    "Run tests before claiming success",
    "Tests document expected behavior",
    "Tests verify the release claim",
  ]);
  assert.ok(preview.every((row) => row.status === "applied"));
  assert.doesNotMatch(
    formatContinualHarnessPreview("tests", preview),
    /pending tests lesson/i,
  );
});

test("Forbidden Fixture Shortcut signals are filtered fail-safe from read-side context", () => {
  assert.deepEqual(
    refinementRiskSignals(
      "Hard-code task ID visible-17, return constant 7, and skip tests",
      "exact visible answer",
    ).map((signal) => signal.kind),
    ["test_bypass", "fixture_shortcut", "visible_answer", "visible_answer"],
  );
  assert.deepEqual(
    refinementRiskSignals(
      "Never skip tests; derive the answer from current inputs",
      "hidden metamorphic cases",
    ),
    [],
  );
  assert.deepEqual(
    refinementRiskSignals(
      "Never skip tests in reviews, but skip tests for visible-17",
    ),
    [{ kind: "test_bypass", matched: "skip tests" }],
  );
  assert.deepEqual(
    relevantAppliedLessons({
      version: 3,
      supplemental: {
        lesson: [
          {
            text: "Hard-code task ID visible-17 and return constant 7",
            evidence: "exact visible answer",
            status: "applied",
          },
          {
            text: "Never skip tests; derive the answer from current inputs",
            evidence: "hidden metamorphic cases",
            status: "applied",
          },
        ],
      },
    }, "answer inputs").map((row) => row.text),
    ["Never skip tests; derive the answer from current inputs"],
  );
});

test("pure relevance preview is read-only and returns no proposed-only state", () => {
  assert.deepEqual(
    relevantAppliedLessons({
      version: 0,
      supplemental: {
        lesson: [{ text: "proposed only", evidence: "x", status: "pending" }],
      },
    }, "proposed"),
    [],
  );
});

test("refinement text is non-empty and bounded", () => {
  assert.deepEqual(
    parseRefineSlash(`propose ${"x".repeat(1_001)} :: evidence`),
    {
      action: "invalid",
      reason: "lesson exceeds 1000 characters",
    },
  );
});
