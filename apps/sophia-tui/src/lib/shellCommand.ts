export type ShellInvocation =
  | { ok: true; command: string; source: "bang" | "slash" }
  | { ok: false; error: string; source: "bang" | "slash" }
  | null;

/**
 * Detect an operator-typed in-TUI shell request.
 *
 * Claude Code-style: `!git status` or `/shell git status` / `/bash git status`.
 * This is a local dispatch to the kernel bash tool, not a model prompt.
 */
export function parseShellInvocation(raw: string): ShellInvocation {
  const line = String(raw || "").trim();
  if (!line) return null;
  if (line.startsWith("!")) {
    const command = line.slice(1).trim();
    if (!command) {
      return { ok: false, error: "usage: !<command>   example: !git status", source: "bang" };
    }
    return { ok: true, command, source: "bang" };
  }
  if (!line.startsWith("/")) return null;
  const body = line.slice(1);
  const separator = body.search(/\s/);
  const name = (separator < 0 ? body : body.slice(0, separator)).toLowerCase();
  if (name !== "shell" && name !== "bash") return null;
  const command = separator < 0 ? "" : body.slice(separator).trim();
  if (!command) {
    return {
      ok: false,
      error: "usage: /shell <command>   aliases: /bash, !<command>",
      source: "slash",
    };
  }
  return { ok: true, command, source: "slash" };
}

export function formatShellTranscript(args: {
  command: string;
  output?: string;
  error?: string;
  ok: boolean;
}): string {
  const body = String(args.output || args.error || "").trim() || "(no output)";
  return `$ ${args.command}\n${body}`;
}
