import test from "node:test";
import assert from "node:assert/strict";
import { resolveAccessibility } from "../lib/accessibility.js";
import type { WorkflowPickerEntry } from "../lib/workflows.js";
import {
  resolveWorkflowPickerKey,
  workflowPickerBadge,
  workflowPickerBorderStyle,
  workflowPickerDetail,
} from "./WorkflowPicker.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

const ready: WorkflowPickerEntry = {
  id: "inspect",
  kind: "workflow",
  label: "Inspect repository",
  summary: "Build a local inventory.",
  badge: "ready",
  selectable: true,
  capabilities: [{ id: "files.read", label: "Read files", risk: "read" }],
};

const blocked: WorkflowPickerEntry = {
  id: "change",
  kind: "workflow",
  label: "Implement change",
  summary: "Apply a reviewed change.",
  badge: "blocked",
  selectable: false,
  reason: "Choose a permission mode.",
  capabilities: [{ id: "shell.execute", label: "Run commands", risk: "execute" }],
};

test("workflow rows expose capabilities and unavailable reasons in text, not color alone", () => {
  assert.equal(workflowPickerBadge(ready), "ready");
  assert.equal(workflowPickerBadge(blocked), "blocked · unavailable");
  assert.match(workflowPickerDetail(ready), /Capabilities: Read files/);
  assert.match(workflowPickerDetail(blocked), /Choose a permission mode/);
});

test("picker keyboard contract supports navigation, search, tabs, selection, and cancellation", () => {
  assert.equal(resolveWorkflowPickerKey("", { upArrow: true }, ready), "move_up");
  assert.equal(resolveWorkflowPickerKey("", { downArrow: true }, ready), "move_down");
  assert.equal(resolveWorkflowPickerKey("", { return: true }, ready), "select");
  assert.equal(resolveWorkflowPickerKey("", { return: true }, blocked), null);
  assert.equal(resolveWorkflowPickerKey("", { tab: true }, ready), "focus_search");
  assert.equal(resolveWorkflowPickerKey("/", {}, ready), "focus_search");
  assert.equal(resolveWorkflowPickerKey("1", {}, ready), "show_workflows");
  assert.equal(resolveWorkflowPickerKey("2", {}, ready), "show_skills");
  assert.equal(resolveWorkflowPickerKey("", { escape: true }, ready), "cancel");
});

test("screen-reader mode removes decorative workflow picker borders", () => {
  assert.equal(workflowPickerBorderStyle(resolveAccessibility(["--ax-screen-reader"], NO_ENV)), undefined);
  assert.equal(workflowPickerBorderStyle(resolveAccessibility([], NO_ENV)), "round");
});
