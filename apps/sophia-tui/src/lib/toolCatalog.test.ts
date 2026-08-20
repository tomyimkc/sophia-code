import test from "node:test";
import assert from "node:assert/strict";

import { formatNativeToolCatalog, parseNativeTools } from "./toolCatalog.js";

test("parseNativeTools keeps valid unique bridge rows in registry order", () => {
  assert.deepEqual(
    parseNativeTools([
      { name: "read_file", risk: "safe", description: "read" },
      { name: "bash", risk: "exec", description: "run" },
      { name: "read_file", risk: "write", description: "duplicate" },
      null,
      { name: "  ", risk: "safe" },
      { name: "git_status", risk: "SAFE" },
    ]),
    [
      { name: "read_file", risk: "safe", description: "read" },
      { name: "bash", risk: "exec", description: "run" },
      { name: "git_status", risk: "safe", description: "" },
    ],
  );
});

test("formatNativeToolCatalog explains permission boundaries and Git safety", () => {
  const text = formatNativeToolCatalog([
    { name: "read_file", risk: "safe", description: "read" },
    { name: "git_status", risk: "safe", description: "status" },
    { name: "write_file", risk: "write", description: "write" },
    { name: "bash", risk: "exec", description: "exec" },
  ]);
  assert.match(text, /Native tools exposed to a solo Sophia run \(4\)/);
  assert.match(text, /safe — available in all permission modes: read_file, git_status/);
  assert.match(text, /write — blocked in read-only; Manual asks before execution: write_file/);
  assert.match(text, /exec — blocked in read-only; Manual asks; Auto destructive calls fail closed without a GUI prompt: bash/);
  assert.match(text, /Git mutations .* remain behind Bash and the normal permission gates/);
  assert.match(text, /Delegated or auto-team lanes may intentionally receive a smaller tool scope/);
});

test("formatNativeToolCatalog is honest before the bridge has supplied a catalog", () => {
  assert.match(formatNativeToolCatalog([]), /has not arrived from the Sophia bridge yet/);
});
