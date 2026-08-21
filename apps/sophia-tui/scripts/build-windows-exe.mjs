#!/usr/bin/env node
/**
 * Assemble a portable Sophia TUI package for Windows.
 *
 * Sophia TUI is two runtimes — an Ink frontend and the Python kernel it
 * spawns — so a "single .exe" is neither the goal nor honest packaging. This
 * script assembles a self-contained FOLDER that Windows users copy or unzip:
 *
 *   <out>/sophia-tui.exe        compiled frontend (bun --compile) — or, when
 *                               bun is absent, dist/ + node_modules + a .cmd
 *                               launcher that requires an installed Node 20+
 *   <out>/agent/ …              the Python runtime packages (kernel)
 *   <out>/python/               optional embedded CPython (--fetch-python)
 *   <out>/sophia.cmd            launcher: pins SOPHIA_RUNTIME_ROOT and, when
 *                               the embedded interpreter exists, SOPHIA_PYTHON
 *   <out>/README.txt            quick start + honest limitations
 *
 * The compiled exe resolves its runtime root from its own directory (the
 * exe-adjacent candidate in findRepoRoot), so it must stay inside this folder.
 *
 * Usage:
 *   npm run build:windows-exe [-- --fetch-python] [--out dist/sophia-windows]
 *                             [--arch x64|arm64] [--launcher-only] [--zip]
 *
 * Network: only --fetch-python downloads (pinned URL + sha256 from
 * python.org); everything else is offline. canClaimAGI:false — this packages
 * the existing candidate, it does not certify anything.
 */
import { spawnSync } from "node:child_process";
import {
  createHash,
} from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0;
}
function flagValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")
    ? args[index + 1]
    : fallback;
}

const outDir = path.resolve(packageRoot, flagValue("out", "dist/sophia-windows"));
const arch = flagValue("arch", "x64");
const wantZip = flag("zip");
const launcherOnly = flag("launcher-only");
const fetchPython = flag("fetch-python");
const pythonVersion = flagValue("fetch-python", "3.12.10");

// Python runtime packages the bridge imports (this open-edition repo ships
// only agent/, sophia/, and tools/). Missing entries are skipped, so the
// list stays valid as the slice evolves.
const RUNTIME_PACKAGES = [
  "agent",
  "sophia",
  "tools",
];

// Pinned embedded CPython (official python.org artifact, sha256 verified).
const EMBED_URL = `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-${arch === "arm64" ? "arm64" : "amd64"}.zip`;
const EMBED_SHA256 = {
  "3.12.10-amd64": "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
}[`${pythonVersion}-${arch === "arm64" ? "arm64" : "amd64"}`];

function fail(message) {
  console.error(`build-windows-exe: ${message}`);
  process.exit(1);
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    fail(`command failed (${command} ${argv.join(" ")}) with status ${result.status}`);
  }
  return result;
}

const SKIP_COPY = new Set(["__pycache__", ".DS_Store", "node_modules", ".git"]);
function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (SKIP_COPY.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".pyc")) continue;
      copyFileSync(from, to);
    }
  }
}

function humanSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

// ── 1. Build the TypeScript frontend ────────────────────────────────────────
if (!flag("skip-npm-build")) {
  console.log("[1/5] npm run build");
  run("npm", ["run", "build"], { cwd: packageRoot, shell: true });
}
if (!existsSync(path.join(packageRoot, "dist", "index.js"))) {
  fail("dist/index.js is missing; run `npm run build` first or drop --skip-npm-build.");
}

// ── 2. Prepare the output folder ────────────────────────────────────────────
console.log(`[2/5] preparing ${path.relative(repoRoot, outDir)}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ── 3. Frontend: compiled exe or launcher fallback ─────────────────────────
const bunProbe = launcherOnly ? null : spawnSync("bun", ["--version"], { encoding: "utf8" });
const haveBun = bunProbe?.status === 0;
if (haveBun) {
  console.log(`[3/5] bun ${bunProbe.stdout.trim()}: compiling sophia-tui.exe (${arch})`);
  // --external: ink's devtools integration optional-imports
  // react-devtools-core behind a guard; the bundler must not try to resolve
  // it (it is not installed and Ink catches the runtime failure).
  run("bun", [
    "build",
    "--compile",
    `--target=bun-windows-${arch}`,
    "--external=react-devtools-core",
    "--outfile",
    path.join(outDir, "sophia-tui.exe"),
    path.join(packageRoot, "dist", "index.js"),
  ], { cwd: packageRoot });
} else {
  console.log(
    "[3/5] bun not found — assembling the Node launcher package instead.\n"
    + "      Install bun (https://bun.sh) for a true single-file sophia-tui.exe.",
  );
  copyTree(path.join(packageRoot, "dist"), path.join(outDir, "dist"));
  copyTree(path.join(packageRoot, "node_modules"), path.join(outDir, "node_modules"));
  writeFileSync(
    path.join(outDir, "sophia-tui.cmd"),
    [
      "@echo off",
      "setlocal",
      'set "SOPHIA_RUNTIME_ROOT=%~dp0"',
      'node "%~dp0dist\\index.js" %*',
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
  );
}

// ── 4. Python runtime root ──────────────────────────────────────────────────
console.log("[4/5] copying the Python kernel runtime packages");
for (const name of RUNTIME_PACKAGES) {
  const source = path.join(repoRoot, name);
  if (!existsSync(source)) continue;
  copyTree(source, path.join(outDir, name));
}

// ── 5. Optional embedded CPython ────────────────────────────────────────────
if (fetchPython) {
  if (!EMBED_SHA256) {
    fail(`no pinned sha256 for python ${pythonVersion} ${arch}; add it to EMBED_SHA256 first.`);
  }
  console.log(`[5/5] fetching embedded CPython ${pythonVersion} (${arch})`);
  const zipPath = path.join(path.dirname(outDir), `python-${pythonVersion}-embed.zip`);
  // Reuse a previously downloaded archive, but still verify its sha256.
  const bytes = existsSync(zipPath)
    ? readFileSync(zipPath)
    : await (async () => {
      const response = await fetch(EMBED_URL);
      if (!response.ok) fail(`download failed: ${EMBED_URL} → HTTP ${response.status}`);
      const downloaded = Buffer.from(await response.arrayBuffer());
      writeFileSync(zipPath, downloaded);
      return downloaded;
    })();
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== EMBED_SHA256) {
    fail(`sha256 mismatch for ${EMBED_URL}\n  expected ${EMBED_SHA256}\n  actual   ${digest}`);
  }
  const pythonDir = path.join(outDir, "python");
  mkdirSync(pythonDir, { recursive: true });
  // bsdtar reads zip on macOS and on Windows 10+; GNU tar on Linux does not.
  const extracted = spawnSync("tar", ["-xf", zipPath, "-C", pythonDir], { stdio: "inherit" });
  if (extracted.status !== 0) {
    fail(`could not extract ${zipPath} with tar; extract it into ${pythonDir} manually and re-run with --skip-npm-build.`);
  }
  // The embeddable distribution is isolated by its `._pth` file, which
  // ignores PYTHONPATH. Point it at the runtime root one level up so the
  // kernel packages import without any environment setup, and enable
  // site-packages for future optional wheels.
  const pthFile = readdirSync(pythonDir).find((name) => /^python\w*\._pth$/.test(name));
  if (!pthFile) fail(`no ._pth file found in the embedded distribution (${pythonDir})`);
  // The stdlib archive is named by major.minor (python312.zip for 3.12.10).
  const stdlibZip = readdirSync(pythonDir).find((name) => /^python\d+\.zip$/.test(name));
  if (!stdlibZip) fail(`no pythonXYZ.zip stdlib archive found in ${pythonDir}`);
  writeFileSync(
    path.join(pythonDir, pthFile),
    [stdlibZip, ".", "..", "", "import site", ""].join("\r\n"),
  );
} else {
  console.log("[5/5] embedded Python skipped (pass --fetch-python to bundle CPython)");
}

// ── Launchers + readme ──────────────────────────────────────────────────────
writeFileSync(
  path.join(outDir, "sophia.cmd"),
  [
    "@echo off",
    "setlocal",
    'set "SOPHIA_RUNTIME_ROOT=%~dp0"',
    'if exist "%~dp0python\\python.exe" set "SOPHIA_PYTHON=%~dp0python\\python.exe"',
    'if "%SOPHIA_PYTHON%"=="" where python >nul 2>nul || (',
    "  echo Sophia needs Python 3.11+ on PATH, an embedded python\\ folder,",
    "  echo or a SOPHIA_PYTHON environment variable pointing at python.exe.",
    "  exit /b 1",
    ")",
    haveBun
      ? '"%~dp0sophia-tui.exe" %*'
      : 'call "%~dp0sophia-tui.cmd" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n"),
);

writeFileSync(
  path.join(outDir, "README.txt"),
  [
    "Sophia TUI (Windows package) — candidateOnly, canClaimAGI:false",
    "==================================================================",
    "",
    "Quick start:",
    "  1. Open Windows Terminal (recommended over the legacy console for",
    "     truecolor + mouse support).",
    "  2. cd into this folder and run:  sophia.cmd",
    haveBun
      ? "     (or run sophia-tui.exe directly; sophia.cmd just pins the runtime"
      : "     (requires Node 20+ on PATH; sophia.cmd pins the runtime"
    + " root and Python)",
    "",
    "Requirements:",
    "  - Python 3.11+ on PATH (python.org installer), OR the bundled",
    "    python\\ folder, OR set SOPHIA_PYTHON to a python.exe path.",
    "",
    "Notes:",
    "  - This is the open edition: no Conscience gate, effort, A2A, or",
    "    workflow surfaces. canClaimAGI: false.",
    "",
    "Everything else (bridge kernel, slash commands, themes, sessions, model",
    "routing) runs from this folder with no repository checkout required.",
    "",
  ].join("\r\n"),
);

// ── Optional zip ────────────────────────────────────────────────────────────
if (wantZip) {
  const zipName = `${path.basename(outDir)}-${arch}.zip`;
  const zipTarget = path.join(path.dirname(outDir), zipName);
  const zipProbe = spawnSync("zip", ["-v"], { encoding: "utf8" });
  if (zipProbe.status === 0) {
    console.log(`zipping → ${zipTarget}`);
    const zipped = spawnSync("zip", ["-qr", zipName, path.basename(outDir)], {
      cwd: path.dirname(outDir),
      stdio: "inherit",
    });
    if (zipped.status !== 0) fail(`zip failed with status ${zipped.status}`);
  } else {
    console.log(`zip(1) not found; folder is ready at ${outDir} — compress it yourself.`);
  }
}

console.log(
  `\nbuild-windows-exe: DONE → ${outDir} (${humanSize(dirSize(outDir))})\n`
  + "Copy the folder (or the zip) to the Windows device and run sophia.cmd there.\n"
  + "Smoke on the device: sophia.cmd --version, then a --mock session.",
);
