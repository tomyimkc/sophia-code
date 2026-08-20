import test from "node:test";
import assert from "node:assert/strict";
import {
  formatShellTranscript,
  parseShellInvocation,
} from "./shellCommand.js";

test("bang and slash forms dispatch a kernel shell command", () => {
  assert.deepEqual(parseShellInvocation("!git status"), {
    ok: true,
    command: "git status",
    source: "bang",
  });
  assert.deepEqual(parseShellInvocation("/shell ls -la"), {
    ok: true,
    command: "ls -la",
    source: "slash",
  });
  assert.deepEqual(parseShellInvocation("/bash pwd"), {
    ok: true,
    command: "pwd",
    source: "slash",
  });
});

test("empty shell invocations fail closed instead of becoming a model prompt", () => {
  assert.equal(parseShellInvocation("hello"), null);
  assert.equal(parseShellInvocation("/tools"), null);
  assert.equal(parseShellInvocation("!")?.ok, false);
  assert.equal(parseShellInvocation("/shell")?.ok, false);
});

test("shell transcript looks like a terminal block", () => {
  assert.equal(
    formatShellTranscript({ command: "pwd", output: "/tmp/repo", ok: true }),
    "$ pwd\n/tmp/repo",
  );
});
