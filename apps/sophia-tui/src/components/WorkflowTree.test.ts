import test from "node:test";
import assert from "node:assert/strict";
import { resolveAccessibility } from "../lib/accessibility.js";
import { workflowBorderStyle } from "./WorkflowTree.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

test("the workflow tree drops its rounded border in screen-reader mode", () => {
  const reader = resolveAccessibility(["--ax-screen-reader"], NO_ENV);
  assert.equal(workflowBorderStyle(reader), undefined);
});

test("the workflow tree keeps its border outside screen-reader mode", () => {
  const normal = resolveAccessibility([], NO_ENV);
  assert.equal(workflowBorderStyle(normal), "round");
  const motionOnly = resolveAccessibility(["--reduced-motion"], NO_ENV);
  assert.equal(workflowBorderStyle(motionOnly), "round");
});
