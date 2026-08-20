import test from "node:test";
import assert from "node:assert/strict";
import { createStreamGrowth, pushStreamGrowth } from "./streamGrowth.js";
import {
  boundedProviderVisibleReasoning,
  liveThinkingTokenSource,
  liveThinkingTokensVisible,
  parseThinkingVisibility,
  providerReportedReasoningSource,
  providerReasoningScope,
  providerVisibleReasoningCallStarted,
  providerVisibleReasoningMeta,
  providerVisibleReasoningSource,
  sameProviderVisibleReasoningSource,
  settledProviderReasoningGrowth,
} from "./visibleReasoning.js";

test("only Grok provider-progress envelopes authorize visible reasoning", () => {
  assert.deepEqual(
    providerVisibleReasoningSource({
      type: "provider_progress",
      provider: "GROK",
      model: "grok-4.6",
      phase: "preflight",
    }),
    { provider: "grok", model: "grok-4.6" },
  );
  assert.equal(
    providerVisibleReasoningSource({
      type: "provider_progress",
      provider: "openai",
      model: "example",
      phase: "reasoning",
    }),
    null,
  );
});

test("completed provider-reported reasoning requires the explicit producer shape", () => {
  assert.deepEqual(
    providerReportedReasoningSource({
      type: "thinking",
      provider: "anthropic",
      model: "claude-example",
      text: "provider-supplied summary",
    }),
    { provider: "anthropic", model: "claude-example" },
  );
  assert.deepEqual(
    providerReportedReasoningSource({ type: "thinking", text: "unlabelled" }),
    { provider: "model", model: "" },
  );
  assert.deepEqual(
    liveThinkingTokenSource({ type: "thinking_token", text: "step", token: "step" }),
    { provider: "model", model: "" },
  );
  assert.equal(
    providerReportedReasoningSource({
      type: "log",
      provider: "anthropic",
      text: "not a reasoning event",
    }),
    null,
  );
});

test("live and completed reasoning reuse requires normalized provider and model identity", () => {
  assert.equal(
    sameProviderVisibleReasoningSource(
      { provider: " Grok ", model: "GROK-4.6" },
      { provider: "grok", model: "grok-4.6" },
    ),
    true,
  );
  assert.equal(
    sameProviderVisibleReasoningSource(
      { provider: "grok", model: "grok-4.6" },
      { provider: "grok", model: "grok-4.5" },
    ),
    false,
  );
});

test("same-lane model calls reset growth and completed text becomes the new base", () => {
  const outputs: string[] = [];
  let growth = createStreamGrowth();
  const append = (chunk: string, now: number) => {
    const update = pushStreamGrowth(growth, chunk, now, {
      minIntervalMs: 0,
      minChars: 0,
    });
    growth = update.state;
    outputs.push(update.text);
  };

  append("A", 1);
  append("B", 2);
  const nextCall = {
    type: "provider_progress",
    provider: "grok",
    model: "grok-4.6",
    phase: "preflight",
    status: "in_progress",
  };
  assert.equal(providerVisibleReasoningCallStarted(nextCall), true);
  if (providerVisibleReasoningCallStarted(nextCall)) growth = createStreamGrowth();
  append("B", 3);
  growth = settledProviderReasoningGrowth("B", 4);
  append("C", 5);

  assert.deepEqual(outputs, ["A", "AB", "B", "BC"]);
  assert.notEqual(outputs.at(-1), "ABC");
  assert.equal(
    providerVisibleReasoningCallStarted({
      ...nextCall,
      status: "succeeded",
    }),
    false,
  );
});

test("thinking modes bound only provider-visible text and hidden fails closed", () => {
  const text = "x".repeat(5000);
  assert.equal(boundedProviderVisibleReasoning(text, "hidden"), "");
  assert.match(boundedProviderVisibleReasoning(text, "summary"), /^x{240}\n… /);
  assert.match(boundedProviderVisibleReasoning(text, "stream"), /^x{800}\n… /);
  assert.equal(boundedProviderVisibleReasoning(text, "full"), text);
  assert.equal(
    boundedProviderVisibleReasoning("provider event", "summary"),
    "provider event",
  );
  assert.equal(liveThinkingTokensVisible("hidden"), false);
  assert.equal(liveThinkingTokensVisible("full"), true);
  assert.equal(liveThinkingTokensVisible("stream"), true);
});

test("thinking visibility parsing and labels keep the provider-visible boundary explicit", () => {
  assert.equal(parseThinkingVisibility(" STREAM "), "stream");
  assert.equal(parseThinkingVisibility("private"), null);
  assert.equal(
    providerVisibleReasoningMeta({ provider: "grok", model: "grok-4.6" }),
    "provider-visible · grok:grok-4.6",
  );
});

test("interleaved team reasoning receives deterministic run-and-lane scopes", () => {
  const laneOne = providerReasoningScope({
    runId: "run-1",
    path: ["team-1", "lane-1"],
    lane: "lane-1",
  });
  const laneTwo = providerReasoningScope({
    runId: "run-1",
    path: ["team-1", "lane-2"],
    lane: "lane-2",
  });
  assert.notEqual(laneOne.key, laneTwo.key);

  const routed = new Map<string, string>();
  for (const [scope, chunk] of [
    [laneOne, "one-a"],
    [laneTwo, "two-a"],
    [laneOne, "one-b"],
    [laneTwo, "two-b"],
  ] as const) {
    routed.set(scope.key, `${routed.get(scope.key) || ""}${chunk}`);
  }
  assert.deepEqual(
    [...routed.entries()],
    [
      [laneOne.key, "one-aone-b"],
      [laneTwo.key, "two-atwo-b"],
    ],
  );
  assert.equal(
    providerVisibleReasoningMeta(
      { provider: "grok", model: "grok-4.6" },
      laneOne,
    ),
    "provider-visible · grok:grok-4.6 · path team-1/lane-1",
  );
});

test("reasoning scope labels are bounded and strip terminal control text", () => {
  const scope = providerReasoningScope({
    runId: "run-1",
    path: [`lane\u001b[31m${"x".repeat(200)}`],
    lane: "lane\n2",
  });
  assert.ok(scope.label.length <= 180);
  assert.doesNotMatch(scope.label, /[\u001b\n]/);
  assert.match(scope.label, /^path lane_31m/);
});
