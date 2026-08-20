import test from "node:test";
import assert from "node:assert/strict";

import { resolveAccessibility } from "../lib/accessibility.js";
import {
  approvalRequestFromLegacy,
  scopedApprovalChoices,
} from "../lib/toolState.js";
import {
  buildPermissionDialogViewModel,
  isAlwaysAllowToolKey,
  permissionBorderStyle,
  resolveDisplayRisk,
  wrapCommandForDialog,
} from "./PermissionDialog.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

test("legacy App props become bounded, typed, y/n call-scoped presentation", () => {
  const model = buildPermissionDialogViewModel({
    tool: "exec_command",
    preview: '{"cwd":"/repo","cmd":"npm test","apiKey":"must-not-leak"}',
    width: 80,
  });
  assert.equal(model.request.cwd, "/repo");
  assert.equal(model.request.risk, "medium");
  assert.match(model.toolLine, /exec_command · risk medium/);
  assert.equal(model.previewLine.includes("must-not-leak"), false);
  assert.deepEqual(model.choices.map((choice) => choice.key), ["y", "n"]);
  assert.match(model.choicesLine, /\[y\] allow once · \[n\] deny/);
  assert.ok(model.previewLine.length <= 76);
});

test("explicit scoped choices remain typed and are presented without terminal escapes", () => {
  const request = approvalRequestFromLegacy({
    id: "approval-7",
    tool: "\x1b[31mwrite_file\x1b[0m",
    preview: '{"cwd":"/repo","path":"a.txt"}',
  });
  const choices = scopedApprovalChoices(request);
  const model = buildPermissionDialogViewModel({
    tool: request.tool,
    preview: request.preview,
    request,
    choices,
    width: 200,
  });
  assert.equal(model.toolLine.includes("\x1b"), false);
  assert.deepEqual(model.choices.map((choice) => choice.scope.kind), ["call", "tool", "cwd", "call"]);
  assert.match(model.choicesLine, /\[t\] allow tool for session \(write_file\)/);
  assert.match(model.choicesLine, /\[w\] allow in cwd for session \(\/repo\)/);
});

test("permission chrome is removed for screen readers", () => {
  assert.equal(permissionBorderStyle(resolveAccessibility(["--ax-screen-reader"], NO_ENV)), undefined);
  assert.equal(permissionBorderStyle(resolveAccessibility([], NO_ENV)), "round");
});

test("with no diff/risk/destructive/always-allow supplied, every new field is a harmless no-op default", () => {
  const model = buildPermissionDialogViewModel({
    tool: "read_file",
    preview: '{"path":"a.txt"}',
    width: 80,
  });
  assert.equal(model.diffPreview, null);
  assert.deepEqual(model.commandLines, []);
  assert.equal(model.commandOmittedLines, 0);
  assert.equal(model.destructive, false);
  assert.equal(model.destructiveLine, "");
  assert.equal(model.alwaysAllowLine, "");
  assert.equal(model.riskLabel, model.request.risk);
});

test("a real diff from the kernel replaces the one-line preview, bounded with an explicit more-lines marker", () => {
  const bigDiff = [
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,20 +1,20 @@",
    ...Array.from({ length: 20 }, (_, i) => `+line ${i}`),
  ].join("\n");
  const model = buildPermissionDialogViewModel({
    tool: "write_file",
    preview: '{"path":"f.txt"}',
    width: 80,
    diff: bigDiff,
  });
  assert.ok(model.diffPreview);
  assert.ok(model.diffPreview!.lines.length <= 8, "bounded to a small, on-screen-safe window");
  assert.equal(model.diffPreview!.truncated, true);
  assert.ok(model.diffPreview!.omittedLines > 0);
  // No diff means no command block either — they are mutually exclusive display modes.
  assert.deepEqual(model.commandLines, []);
});

test("a bash-style command is wrapped and shown in full, never a hard single-line cut", () => {
  const longCommand = "npm run build && npm test && echo " + "x".repeat(200);
  const model = buildPermissionDialogViewModel({
    tool: "bash",
    preview: JSON.stringify({ command: longCommand }),
    width: 60,
  });
  assert.ok(model.commandLines.length > 1, "a 200+ char command must wrap, not truncate to one line");
  assert.equal(model.commandLines.join("").includes("x".repeat(200)), true);
  assert.equal(model.diffPreview, null);
});

test("an unusually long command is bounded with an explicit omitted-line count, never silently cut", () => {
  const hugeCommand = Array.from({ length: 30 }, (_, i) => `echo step-${i}`).join(" && ");
  const { lines, omittedLines } = wrapCommandForDialog(hugeCommand, 20, 4);
  assert.equal(lines.length, 4);
  assert.ok(omittedLines > 0);
});

test("command args unrelated to a shell invocation (write_file's path/content) are never mistaken for a command", () => {
  const model = buildPermissionDialogViewModel({
    tool: "write_file",
    preview: '{"path":"a.txt","content":"run this: rm -rf /"}',
    width: 80,
  });
  assert.deepEqual(model.commandLines, []);
});

test("the kernel's authoritative risk overrides the client-side guess", () => {
  const guessedFromArgsAlone = buildPermissionDialogViewModel({
    tool: "custom_tool",
    preview: '{"path":"a.txt"}',
    width: 80,
  });
  assert.equal(guessedFromArgsAlone.riskLabel, "unknown");

  const kernelSupplied = buildPermissionDialogViewModel({
    tool: "custom_tool",
    preview: '{"path":"a.txt"}',
    width: 80,
    risk: "exec",
  });
  assert.equal(kernelSupplied.riskLabel, "exec");
  assert.match(kernelSupplied.toolLine, /risk exec/);
});

test("resolveDisplayRisk falls back to the guess only when the kernel sent nothing", () => {
  assert.equal(resolveDisplayRisk("medium", "write"), "write");
  assert.equal(resolveDisplayRisk("medium", ""), "medium");
  assert.equal(resolveDisplayRisk("medium", undefined), "medium");
  assert.equal(resolveDisplayRisk("medium", "  EXEC  "), "exec");
});

test("a destructive invocation gets a plain-language warning that survives no-colour rendering", () => {
  const model = buildPermissionDialogViewModel({
    tool: "bash",
    preview: '{"command":"rm -rf --force ./build"}',
    width: 80,
    destructive: true,
  });
  assert.equal(model.destructive, true);
  assert.match(model.destructiveLine, /DESTRUCTIVE/);
  assert.match(model.destructiveLine, /cannot be undone/);
});

test("always-allow hint is offered only when wired, and never duplicates an existing tool-scoped choice", () => {
  const withoutCallback = buildPermissionDialogViewModel({
    tool: "grep",
    preview: '{"pattern":"x"}',
    width: 80,
  });
  assert.equal(withoutCallback.alwaysAllowLine, "");

  const withCallback = buildPermissionDialogViewModel({
    tool: "grep",
    preview: '{"pattern":"x"}',
    width: 80,
    onAlwaysAllowTool: () => {},
  });
  assert.match(withCallback.alwaysAllowLine, /\[a\] always allow grep/);

  const request = approvalRequestFromLegacy({ tool: "grep", preview: '{"pattern":"x"}' });
  const alreadyScoped = buildPermissionDialogViewModel({
    tool: "grep",
    preview: '{"pattern":"x"}',
    width: 80,
    request,
    choices: scopedApprovalChoices(request),
    onAlwaysAllowTool: () => {},
  });
  assert.equal(
    alreadyScoped.alwaysAllowLine,
    "",
    "scopedApprovalChoices already offers a tool-scoped choice — do not advertise the same action twice",
  );
});

test("isAlwaysAllowToolKey is a pure predicate the App's own input loop can drive", () => {
  assert.equal(isAlwaysAllowToolKey("a", true), true);
  assert.equal(isAlwaysAllowToolKey("A", true), true);
  assert.equal(isAlwaysAllowToolKey("a", false), false);
  assert.equal(isAlwaysAllowToolKey("y", true), false);
});
