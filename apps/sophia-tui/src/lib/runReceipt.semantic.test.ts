import test from "node:test";
import assert from "node:assert/strict";

import { aggregateRunReceipt } from "./runReceipt.js";


test("run receipt preserves semantic fallback and return-to-primary provenance", () => {
  const receipt = aggregateRunReceipt([
    {
      type: "run_start",
      runId: "run-semantic",
      session: "pytest",
      model: "020s-terra",
      team: 1,
    },
    {
      type: "result",
      runId: "run-semantic",
      ok: true,
      provider: "020s-terra",
      resolvedModel: "gpt-5.6-terra",
      fallbackUsed: false,
      semanticFallbackUsed: true,
      semanticFallbackProvider: "ollama",
      semanticFallbackModel: "qwen-local",
      returnedToPrimary: true,
      primaryResumeProvider: "020s-terra",
      primaryResumeModel: "gpt-5.6-terra",
      primaryResumeDeclined: false,
    },
  ]);

  assert.equal(receipt.fallbackUsed, false);
  assert.equal(receipt.semanticFallbackUsed, true);
  assert.equal(receipt.semanticFallbackProvider, "ollama");
  assert.equal(receipt.semanticFallbackModel, "qwen-local");
  assert.equal(receipt.returnedToPrimary, true);
  assert.equal(receipt.primaryResumeProvider, "020s-terra");
  assert.equal(receipt.primaryResumeModel, "gpt-5.6-terra");
  assert.equal(receipt.primaryResumeDeclined, false);
  assert.equal(receipt.gate.checked, false, "a result must not invent a floor check");
});

test("Prime receipt records external authority and only claims checks that ran", () => {
  const receipt = aggregateRunReceipt([
    {
      type: "run_start",
      runId: "run-prime",
      session: "prime-session",
      executionRuntime: "prime",
      executionAuthority: "external-user-process",
      model: "prime-agent",
      team: 1,
    },
    {
      type: "result",
      runId: "run-prime",
      ok: true,
      finalText: "checked external answer",
      executionRuntime: "prime",
      externalRuntimeVersion: "0.7.1",
      executionAuthority: "external-user-process",
      toolPolicyMode: "advisory",
      toolPolicyChecked: true,
      toolActionsApprovedBySophia: false,
      outputFloorChecked: true,
      strictUncertaintyChecked: false,
      streamingQuarantined: true,
      primeAutonomyExposed: false,
      epistemic: {
        state: "delivered_external_floor_checked",
        verdict: "retrieve",
        floorChecked: true,
      },
    },
  ]);

  assert.equal(receipt.executionRuntime, "prime");
  assert.equal(receipt.externalRuntimeVersion, "0.7.1");
  assert.equal(receipt.executionAuthority, "external-user-process");
  assert.equal(receipt.toolPolicyMode, "advisory");
  assert.equal(receipt.toolPolicyChecked, true);
  assert.equal(receipt.toolActionsApprovedBySophia, false);
  assert.equal(receipt.outputFloorChecked, true);
  assert.equal(receipt.strictUncertaintyChecked, false);
  assert.equal(receipt.streamingQuarantined, true);
  assert.equal(receipt.primeAutonomyExposed, false);
  assert.equal(receipt.gate.checked, true);
  assert.equal(receipt.gate.delivered, true);
});
