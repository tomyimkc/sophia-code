/**
 * Read-only presentation helpers for the native tool inventory the Python
 * bridge reports on startup.  This is not a capability probe: it reflects the
 * registry exposed to a normal solo Sophia run and keeps optional integration
 * prerequisites explicit instead of fabricating readiness.
 */

export interface NativeToolSummary {
  name: string;
  risk: string;
  description: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseNativeTools(value: unknown): NativeToolSummary[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tools: NativeToolSummary[] = [];
  for (const entry of value) {
    const row = asRecord(entry);
    const name = String(row?.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tools.push({
      name,
      risk: String(row?.risk || "unknown").trim().toLowerCase() || "unknown",
      description: String(row?.description || "").trim(),
    });
  }
  return tools;
}

function namesForRisk(tools: NativeToolSummary[], risk: string): string[] {
  return tools.filter((tool) => tool.risk === risk).map((tool) => tool.name);
}

function line(label: string, names: string[]): string | null {
  return names.length ? `${label}: ${names.join(", ")}` : null;
}

export function formatNativeToolCatalog(tools: NativeToolSummary[]): string {
  if (!tools.length) {
    return [
      "Native tool catalog has not arrived from the Sophia bridge yet.",
      "Wait for the ready status or run /bridge restart, then try /tools again.",
    ].join("\n");
  }
  const safe = namesForRisk(tools, "safe");
  const write = namesForRisk(tools, "write");
  const exec = namesForRisk(tools, "exec");
  const known = new Set(["safe", "write", "exec"]);
  const other = tools.filter((tool) => !known.has(tool.risk));
  const lines = [
    `Native tools exposed to a solo Sophia run (${tools.length}):`,
    line("safe — available in all permission modes", safe),
    line("write — blocked in read-only; Manual asks before execution", write),
    line("exec — blocked in read-only; Manual asks; Auto destructive calls fail closed without a GUI prompt", exec),
    ...other.map((tool) => `${tool.risk}: ${tool.name}`),
    "",
    "Git inspection: git_status, git_diff, and git_log are read-only native tools.",
    "Git mutations (commit, push, checkout, reset, configuration) remain behind Bash and the normal permission gates.",
    "Delegated or auto-team lanes may intentionally receive a smaller tool scope.",
    "Optional integrations report their own configuration prerequisite when called; credential values are never shown here.",
  ].filter((value): value is string => value !== null);
  return lines.join("\n");
}
