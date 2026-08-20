#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(packageRoot, "dist");
const distLibDir = path.join(distDir, "lib");

mkdirSync(distLibDir, { recursive: true });
copyFileSync(
  path.join(packageRoot, "src", "lib", "slash-commands.json"),
  path.join(distLibDir, "slash-commands.json"),
);

// Executable mode is meaningful on POSIX and unsupported/irrelevant on Windows.
if (process.platform !== "win32") {
  chmodSync(path.join(distDir, "index.js"), 0o755);
}
