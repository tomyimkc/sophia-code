import assert from "node:assert/strict";
import test from "node:test";

import {
  SECRET_PREFLIGHT_BEST_EFFORT_NOTICE,
  planModelBoundSecretPreflight,
  redactSecretFindings,
  resolveModelBoundPrompt,
  runSecretPreflight,
} from "./secretPreflight.js";

test("preflight always uses explicit best-effort wording, even when no pattern matches", () => {
  const result = runSecretPreflight("ordinary prompt");
  assert.equal(result.status, "no-match");
  assert.equal(result.requiresExplicitConfirmation, false);
  assert.equal(result.notice, SECRET_PREFLIGHT_BEST_EFFORT_NOTICE);
  assert.match(result.notice, /^Best-effort only:/);
  assert.match(result.notice, /can miss secrets/);
});

test("detects common provider tokens without returning the secret in findings", () => {
  const token = "gh" + "p_" + "A".repeat(24);
  const result = runSecretPreflight(`please use ${token}`);
  assert.equal(result.status, "review-required");
  assert.equal(result.requiresExplicitConfirmation, true);
  assert.equal(result.findings[0]?.kind, "provider-token");
  assert.ok(result.findings.every((finding) => !finding.preview.includes(token)));
});

test("detects credential assignments, bearer values, private keys, and URL userinfo", () => {
  const assignment = "OPENAI_API_KEY=" + "live_" + "A".repeat(20);
  const bearer = "Bearer " + "B".repeat(24);
  const input = [
    assignment,
    bearer,
    "-----BEGIN PRIVATE KEY-----",
    "https://alice:not-a-placeholder@example.test/path",
  ].join("\n");
  const result = runSecretPreflight(input);
  assert.deepEqual(
    new Set(result.findings.map((finding) => finding.kind)),
    new Set(["credential-assignment", "authorization-header", "private-key", "url-credential"]),
  );
  assert.deepEqual(
    result.findings.map(({ line, column }) => ({ line, column })),
    [
      { line: 1, column: "OPENAI_API_KEY=".length + 1 },
      { line: 2, column: "Bearer ".length + 1 },
      { line: 3, column: 1 },
      { line: 4, column: "https://".length + 1 },
    ],
  );
});

test("placeholder values do not force a confirmation", () => {
  for (const input of [
    "API_KEY=<your_api_key>",
    "password=changeme",
    "token=[REDACTED]",
    "secret=${SECRET_FROM_ENV}",
  ]) {
    assert.equal(runSecretPreflight(input).requiresExplicitConfirmation, false, input);
  }
});

test("redaction replaces findings without leaking or corrupting surrounding Unicode", () => {
  const token = "sk-" + "proj-" + "Z".repeat(20);
  const input = `前 ${token} 後`;
  const result = runSecretPreflight(input);
  const redacted = redactSecretFindings(input, result.findings);
  assert.equal(redacted, "前 [REDACTED POSSIBLE SECRET] 後");
  assert.ok(!redacted.includes(token));
});

test("/goal scans its final model-bound prompt and waits for explicit confirmation", () => {
  const token = "sk-" + "proj-" + "G".repeat(20);
  const decision = planModelBoundSecretPreflight(`/goal ${token}`);
  assert.equal(decision.action, "confirm");
  assert.deepEqual(decision.modelBound, {
    source: "goal",
    prompt: token,
  });
  assert.equal(decision.preflight?.requiresExplicitConfirmation, true);

  const approved = planModelBoundSecretPreflight(`/goal ${token}`, true);
  assert.equal(approved.action, "proceed");
  assert.deepEqual(approved.modelBound, decision.modelBound);
  assert.equal(approved.preflight, null);
});

test("/agi start scans its final model-bound goal before local dispatch", () => {
  const token = "sk-" + "proj-" + "J".repeat(20);
  const decision = planModelBoundSecretPreflight(`/agi start inspect ${token}`);
  assert.equal(decision.action, "confirm");
  assert.deepEqual(decision.modelBound, {
    source: "agi-start",
    prompt: `inspect ${token}`,
  });
  assert.equal(decision.preflight?.requiresExplicitConfirmation, true);

  const approved = planModelBoundSecretPreflight(
    `/agi start inspect ${token}`,
    true,
  );
  assert.equal(approved.action, "proceed");
  assert.deepEqual(approved.modelBound, decision.modelBound);
  assert.equal(approved.preflight, null);
});

test("catalog prompt commands scan the expanded prompt that will be sent", () => {
  const token = "sk-" + "proj-" + "R".repeat(20);
  const decision = planModelBoundSecretPreflight(`/review ${token}`);
  assert.equal(decision.action, "confirm");
  assert.equal(decision.modelBound?.source, "catalog-prompt");
  assert.match(decision.modelBound?.prompt || "", /^Review the current git changes/);
  assert.match(decision.modelBound?.prompt || "", new RegExp(`${token}$`));
  assert.equal(decision.preflight?.requiresExplicitConfirmation, true);

  const approved = planModelBoundSecretPreflight(`/review ${token}`, true);
  assert.equal(approved.action, "proceed");
  assert.deepEqual(approved.modelBound, decision.modelBound);
  assert.equal(approved.preflight, null);
});

test("/queue scans the queued model-bound prompt before local dispatch", () => {
  const token = "sk-" + "proj-" + "Q".repeat(20);
  const decision = planModelBoundSecretPreflight(`/queue   continue with ${token}`);
  assert.equal(decision.action, "confirm");
  assert.deepEqual(decision.modelBound, {
    source: "queue",
    prompt: `continue with ${token}`,
  });
  assert.equal(decision.preflight?.requiresExplicitConfirmation, true);
});

test("/steer scans the provider-bound instruction before local dispatch", () => {
  const token = "sk-" + "proj-" + "S".repeat(20);
  const decision = planModelBoundSecretPreflight(`/steer use ${token} next`);
  assert.equal(decision.action, "confirm");
  assert.deepEqual(decision.modelBound, {
    source: "steer",
    prompt: `use ${token} next`,
  });
  assert.equal(decision.preflight?.requiresExplicitConfirmation, true);
});

test("/image scans only the provider prompt and keeps the output path local", () => {
  const promptToken = "sk-" + "proj-" + "I".repeat(20);
  const decision = planModelBoundSecretPreflight(
    `/image artifacts/render.png :: paint with ${promptToken}`,
  );
  assert.equal(decision.action, "confirm");
  assert.deepEqual(decision.modelBound, {
    source: "image",
    prompt: `paint with ${promptToken}`,
  });
  assert.equal(decision.preflight?.requiresExplicitConfirmation, true);

  const pathToken = "sk-" + "proj-" + "P".repeat(20);
  const localPathOnly = planModelBoundSecretPreflight(
    `/image artifacts/${pathToken}.png :: paint a safe landscape`,
  );
  assert.equal(localPathOnly.action, "proceed");
  assert.deepEqual(localPathOnly.modelBound, {
    source: "image",
    prompt: "paint a safe landscape",
  });
  assert.equal(localPathOnly.preflight?.requiresExplicitConfirmation, false);
});

test("approved queue, steer, and image resubmissions proceed with the same resolved payload", () => {
  const token = "sk-" + "proj-" + "A".repeat(20);
  for (const line of [
    `/queue ${token}`,
    `/steer ${token}`,
    `/image output.png :: ${token}`,
  ]) {
    const pending = planModelBoundSecretPreflight(line);
    assert.equal(pending.action, "confirm", line);

    const approved = planModelBoundSecretPreflight(line, true);
    assert.equal(approved.action, "proceed", line);
    assert.deepEqual(approved.modelBound, pending.modelBound, line);
    assert.equal(approved.preflight, null, line);
  }
});

test("ordinary prompts remain model-bound while proven local, info, and unsupported slash commands are exempt", () => {
  assert.deepEqual(resolveModelBoundPrompt("  ordinary prompt  "), {
    source: "plain",
    prompt: "ordinary prompt",
  });

  const token = "sk-" + "proj-" + "L".repeat(20);
  for (const line of [
    `/help ${token}`,
    `/sampling ${token}`,
    `/add-dir ${token}`,
  ]) {
    const decision = planModelBoundSecretPreflight(line);
    assert.equal(decision.action, "proceed", line);
    assert.equal(decision.modelBound, null, line);
    assert.equal(decision.preflight, null, line);
  }
});
