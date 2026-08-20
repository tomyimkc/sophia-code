import test from "node:test";
import assert from "node:assert/strict";
import {
  isModelIdentityQuestion,
  localModelIdentityAnswer,
} from "./localAnswers.js";

test("recognizes direct model identity questions without catching broader prompts", () => {
  assert.equal(isModelIdentityQuestion("what model are you using?"), true);
  assert.equal(isModelIdentityQuestion("Which LLM is active now?"), true);
  assert.equal(isModelIdentityQuestion("what model architecture should I use?"), false);
});

test("answers from visible runtime state without invoking or inventing a backend model", () => {
  assert.equal(
    localModelIdentityAnswer("what model are you using?", {
      model: "grok",
      runtime: "sophia",
    }),
    "Active model: grok · runtime: Sophia.",
  );
  assert.equal(
    localModelIdentityAnswer("explain this model", {
      model: "grok",
      runtime: "sophia",
    }),
    null,
  );
});
