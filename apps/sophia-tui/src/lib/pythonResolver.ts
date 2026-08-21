/**
 * Shared Python interpreter resolution for every TUI subprocess site.
 *
 * The bridge, the SMUX/CMUX helpers, and the ARC campaign flow all launch the
 * Sophia Python kernel. POSIX hosts always had `python3`; a stock Windows box
 * has neither `python3` nor a trustworthy `python` — the WindowsApps alias
 * opens the Microsoft Store instead of running an interpreter. This module
 * centralises one ordered, testable resolution so no spawn site needs to
 * hardcode an interpreter name again.
 *
 * Resolution order (first match wins, explicit values are never probed):
 *
 *   1. `SOPHIA_PYTHON` — operator-chosen interpreter.
 *   2. `PYTHON` — generic override honored by the CMUX/ARC sites.
 *   3. Platform default — `python3` everywhere except win32, where `python`
 *      and then the `py -3` launcher are probed with `--version` so the
 *      Store stub (exit 9009) is rejected before a kernel spawn depends on it.
 *
 * `py` needs its interpreter-selection args (`-3`) *before* the module args,
 * so callers must prepend `launch.preArgs` themselves (see `pythonArgv`).
 *
 * The kernel contract requires Python 3.11+ for `-P` (safe path). The probe
 * records the reported version for diagnostics but does not gate on it.
 */
import { spawnSync } from "node:child_process";

export type PythonLaunchSource = "SOPHIA_PYTHON" | "PYTHON" | "platform-default";

export interface PythonLaunch {
  command: string;
  /** Interpreter-selection args that precede module args (e.g. `["-3"]` for `py`). */
  preArgs: readonly string[];
  source: PythonLaunchSource;
  /** Present when the win32 default probe ran the interpreter. */
  probed?: boolean;
  /** `python --version` output when it was captured (e.g. "Python 3.12.10"). */
  version?: string;
}

/**
 * Minimal env surface this resolver reads. Declared as optional properties
 * (not `Pick<ProcessEnv, …>`, which would make them required after picking)
 * so plain `NodeJS.ProcessEnv` and test literals both assign cleanly.
 */
export interface PythonEnvLookup {
  SOPHIA_PYTHON?: string | undefined;
  PYTHON?: string | undefined;
}

export function pythonLaunchCandidates(
  env: PythonEnvLookup | undefined,
  platform: NodeJS.Platform = process.platform,
): PythonLaunch[] {
  const sophia = env?.SOPHIA_PYTHON?.trim();
  if (sophia) return [{ command: sophia, preArgs: [], source: "SOPHIA_PYTHON" }];
  const generic = env?.PYTHON?.trim();
  if (generic) return [{ command: generic, preArgs: [], source: "PYTHON" }];
  if (platform === "win32") {
    return [
      { command: "python", preArgs: [], source: "platform-default" },
      { command: "py", preArgs: ["-3"], source: "platform-default" },
    ];
  }
  return [{ command: "python3", preArgs: [], source: "platform-default" }];
}

type ProbeSpawn = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; windowsHide: true },
) => { status: number | null; error?: Error; stdout?: string; stderr?: string };

/**
 * Return the first candidate that actually starts. Used only for the win32
 * platform default: `python` may exist solely as the Microsoft Store stub,
 * and probing `--version` is the only reliable way to tell before a kernel
 * spawn hangs on it.
 */
export function probePythonLaunch(
  candidates: readonly PythonLaunch[],
  spawnImpl: ProbeSpawn = spawnSync,
): PythonLaunch | null {
  for (const candidate of candidates) {
    try {
      const result = spawnImpl(candidate.command, [...candidate.preArgs, "--version"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
      });
      if (result.error || result.status !== 0) continue;
      const version = `${result.stdout || ""}${result.stderr || ""}`.trim();
      return { ...candidate, probed: true, ...(version ? { version } : {}) };
    } catch {
      // Try the next candidate (spawnSync throws only on pathological inputs).
    }
  }
  return null;
}

let probedDefaultCache: { key: string; launch: PythonLaunch } | null = null;

/**
 * Resolve the interpreter launch for a spawn site. POSIX keeps the historical
 * zero-cost path (pure lookup, no subprocess); the win32 default probes once
 * per process and memoises the result so repeated commands do not re-probe.
 *
 * The bridge's documented contract honors only `SOPHIA_PYTHON` (not `PYTHON`);
 * it passes a narrowed env view to preserve that.
 */
export function resolvePythonLaunch(
  env?: PythonEnvLookup,
  platform: NodeJS.Platform = process.platform,
): PythonLaunch {
  const candidates = pythonLaunchCandidates(env, platform);
  const first = candidates[0];
  if (candidates.length === 1 || platform !== "win32") return first;
  const key = `${platform}|${first.command}|${candidates[1]?.command ?? ""}`;
  if (probedDefaultCache?.key === key) return probedDefaultCache.launch;
  const probed = probePythonLaunch(candidates) ?? { ...first };
  probedDefaultCache = { key, launch: probed };
  return probed;
}

/** Build a full interpreter argv: `pythonArgv(launch, ["-P", "-m", "agent.x"])`. */
export function pythonArgv(launch: PythonLaunch, args: readonly string[]): string[] {
  return [launch.command, ...launch.preArgs, ...args];
}

/** Human-readable command line for display/copy surfaces (`/arc copy …`). */
export function pythonCommandLine(launch: PythonLaunch, args: readonly string[]): string {
  const command = /\s/.test(launch.command) && !/^".*"$/.test(launch.command)
    ? `"${launch.command}"`
    : launch.command;
  return [command, ...launch.preArgs, ...args].join(" ");
}

/** Test hook: forget the memoised win32 probe. */
export function resetPythonLaunchCache(): void {
  probedDefaultCache = null;
}
