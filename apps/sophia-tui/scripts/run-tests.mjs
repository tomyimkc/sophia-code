#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(packageRoot, "src");

function collectTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(target));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      tests.push(target);
    }
  }
  return tests;
}

const tests = collectTests(srcRoot).sort();
if (tests.length === 0) {
  console.error("No Sophia TUI test files found.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...tests],
  { cwd: packageRoot, stdio: "inherit" },
);

if (result.error) {
  console.error(`Failed to start Sophia TUI tests: ${result.error.message}`);
}
process.exit(result.status ?? 1);
