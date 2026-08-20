import { execFile } from "node:child_process";
import path from "node:path";

export interface WorkspaceContext {
  repo: string;
  branch: string | null;
  worktree: string | null;
  pr: string;
  isGit: boolean;
}

export interface ReadOnlyCommandResult {
  ok: boolean;
  stdout: string;
}

export type ReadOnlyCommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<ReadOnlyCommandResult>;

const COMMAND_TIMEOUT_MS = 1_500;

function cleanLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function fallbackWorkspaceContext(cwd: string): WorkspaceContext {
  const resolved = path.resolve(cwd || ".");
  return {
    repo: path.basename(resolved) || resolved,
    branch: null,
    worktree: null,
    pr: "checking…",
    isGit: false,
  };
}

export function parsePullRequestStatus(stdout: string): string {
  try {
    const rows = JSON.parse(stdout) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return "none";
    const row = rows[0] as Record<string, unknown>;
    const number = Number(row.number);
    if (!Number.isInteger(number) || number <= 0) return "unavailable";
    const state = cleanLine(String(row.state || "unknown")).toLowerCase();
    const label = row.isDraft === true ? "draft" : state || "unknown";
    return `#${number} ${label}`;
  } catch {
    return "unavailable";
  }
}

export const runReadOnlyCommand: ReadOnlyCommandRunner = (
  executable,
  args,
  options,
) => new Promise((resolve) => {
  execFile(
    executable,
    args,
    {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 128 * 1024,
      encoding: "utf8",
    },
    (error, stdout) => {
      resolve({
        ok: !error,
        stdout: cleanLine(String(stdout || "")),
      });
    },
  );
});

/**
 * Best-effort, read-only workspace identity for the prompt chrome.
 *
 * Git metadata is local. PR discovery uses the authenticated `gh` CLI when it
 * is available, but it is asynchronous and time-bounded so an offline GitHub
 * session never delays or disables the composer.
 */
export async function inspectWorkspaceContext(
  cwd: string,
  run: ReadOnlyCommandRunner = runReadOnlyCommand,
): Promise<WorkspaceContext> {
  const fallback = fallbackWorkspaceContext(cwd);
  const git = async (args: string[]): Promise<ReadOnlyCommandResult> =>
    run("git", args, { cwd, timeoutMs: COMMAND_TIMEOUT_MS });

  const [rootResult, commonResult, branchResult, commitResult] = await Promise.all([
    git(["rev-parse", "--show-toplevel"]),
    git(["rev-parse", "--git-common-dir"]),
    git(["branch", "--show-current"]),
    git(["rev-parse", "--short", "HEAD"]),
  ]);

  if (!rootResult.ok || !rootResult.stdout) {
    return { ...fallback, pr: "not a git repo" };
  }

  const root = path.resolve(rootResult.stdout);
  const commonGitDir = commonResult.ok && commonResult.stdout
    ? path.resolve(root, commonResult.stdout)
    : path.join(root, ".git");
  const canonicalRepoRoot =
    path.basename(commonGitDir) === ".git" ? path.dirname(commonGitDir) : root;
  const branch =
    (branchResult.ok && branchResult.stdout)
      ? branchResult.stdout
      : commitResult.ok && commitResult.stdout
        ? `detached@${commitResult.stdout}`
        : "unknown";
  const linkedWorktree = path.resolve(root) !== path.resolve(canonicalRepoRoot);

  const prResult = await run(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,state,isDraft",
    ],
    { cwd: root, timeoutMs: COMMAND_TIMEOUT_MS },
  );

  return {
    repo: path.basename(canonicalRepoRoot) || path.basename(root) || root,
    branch,
    worktree: linkedWorktree ? path.basename(root) || root : null,
    pr: prResult.ok ? parsePullRequestStatus(prResult.stdout) : "unavailable",
    isGit: true,
  };
}
