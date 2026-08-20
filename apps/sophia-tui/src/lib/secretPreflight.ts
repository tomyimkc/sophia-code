import { clientExecutionFor, expandPromptCommand, resolve } from "./slash.js";

export const SECRET_PREFLIGHT_BEST_EFFORT_NOTICE =
  "Best-effort only: this local preflight can miss secrets and can flag harmless text; review the prompt and attachments before sending.";

export type SecretFindingKind =
  | "private-key"
  | "provider-token"
  | "credential-assignment"
  | "authorization-header"
  | "url-credential";

export interface SecretFinding {
  kind: SecretFindingKind;
  severity: "high" | "medium";
  start: number;
  end: number;
  line: number;
  column: number;
  /** Redacted explanation. Never contains the matched credential value. */
  preview: string;
}

export interface SecretPreflightResult {
  status: "no-match" | "review-required";
  findings: SecretFinding[];
  requiresExplicitConfirmation: boolean;
  notice: typeof SECRET_PREFLIGHT_BEST_EFFORT_NOTICE;
}

export interface ModelBoundPrompt {
  source: "plain" | "goal" | "agi-start" | "catalog-prompt" | "queue" | "steer" | "image";
  prompt: string;
}

export interface ModelBoundSecretPreflight {
  action: "proceed" | "confirm";
  modelBound: ModelBoundPrompt | null;
  preflight: SecretPreflightResult | null;
}

function lineColumn(input: string, offset: number): { line: number; column: number } {
  const before = input.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  if (!normalized) return true;
  if (/^(?:x+|\*+|_+|-+|0+|\[?redacted\]?|secret|token|password|passwd|api[_-]?key)$/u.test(normalized)) {
    return true;
  }
  if (
    normalized.includes("example")
    || /^(?:your[-_ ]?)?placeholder(?:[-_ ].*)?$/u.test(normalized)
    || normalized.includes("your_")
    || normalized.includes("your-")
    || normalized.includes("changeme")
    || normalized.startsWith("${")
    || normalized.startsWith("<")
  ) {
    return true;
  }
  return false;
}

function addFinding(
  input: string,
  findings: SecretFinding[],
  finding: Omit<SecretFinding, "line" | "column">,
): void {
  if (findings.some((existing) =>
    existing.kind === finding.kind
    && existing.start === finding.start
    && existing.end === finding.end
  )) return;
  findings.push({ ...finding, ...lineColumn(input, finding.start) });
}

function scanPattern(
  input: string,
  pattern: RegExp,
  onMatch: (match: RegExpExecArray) => Omit<SecretFinding, "line" | "column"> | null,
  findings: SecretFinding[],
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const finding = onMatch(match);
    if (finding) addFinding(input, findings, finding);
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
}

/**
 * Local, deterministic preflight. It deliberately reports possible secrets
 * without echoing them into UI state, logs, snapshots, or error messages.
 *
 * This is not a credential verifier and never returns a guarantee of safety;
 * the `notice` field always carries explicit best-effort wording.
 */
export function runSecretPreflight(input: string): SecretPreflightResult {
  const findings: SecretFinding[] = [];

  scanPattern(
    input,
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    (match) => ({
      kind: "private-key",
      severity: "high",
      start: match.index,
      end: match.index + match[0].length,
      preview: "Private-key material [REDACTED]",
    }),
    findings,
  );

  const providerPatterns: Array<{ label: string; pattern: RegExp }> = [
    { label: "GitHub-style token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
    { label: "OpenAI-style token", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g },
    { label: "Anthropic-style token", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
    { label: "Slack-style token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
    { label: "AWS access-key identifier", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  ];
  for (const { label, pattern } of providerPatterns) {
    scanPattern(
      input,
      pattern,
      (match) => ({
        kind: "provider-token",
        severity: "high",
        start: match.index,
        end: match.index + match[0].length,
        preview: `${label} [REDACTED]`,
      }),
      findings,
    );
  }

  scanPattern(
    input,
    /\b([A-Za-z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*)\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;]+))/gi,
    (match) => {
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      if (looksLikePlaceholder(value) || value.length < 6) return null;
      const relative = match[0].lastIndexOf(value);
      const start = match.index + Math.max(0, relative);
      return {
        kind: "credential-assignment",
        severity: "high",
        start,
        end: start + value.length,
        preview: `${match[1]}=[REDACTED]`,
      };
    },
    findings,
  );

  scanPattern(
    input,
    /\b(?:authorization\s*:\s*)?bearer\s+([A-Za-z0-9._~+/=-]{12,})/gi,
    (match) => {
      const value = match[1];
      if (looksLikePlaceholder(value)) return null;
      const relative = match[0].lastIndexOf(value);
      const start = match.index + relative;
      return {
        kind: "authorization-header",
        severity: "high",
        start,
        end: start + value.length,
        preview: "Authorization: Bearer [REDACTED]",
      };
    },
    findings,
  );

  scanPattern(
    input,
    /\bhttps?:\/\/([^/\s:@]+):([^/\s@]+)@/gi,
    (match) => {
      const credentials = `${match[1]}:${match[2]}`;
      if (looksLikePlaceholder(match[2])) return null;
      const relative = match[0].indexOf(credentials);
      const start = match.index + relative;
      return {
        kind: "url-credential",
        severity: "medium",
        start,
        end: start + credentials.length,
        preview: "URL user information [REDACTED]",
      };
    },
    findings,
  );

  findings.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind));
  return {
    status: findings.length > 0 ? "review-required" : "no-match",
    findings,
    requiresExplicitConfirmation: findings.length > 0,
    notice: SECRET_PREFLIGHT_BEST_EFFORT_NOTICE,
  };
}

/**
 * Resolve the exact text that will leave the machine for a model/provider, if
 * this submission can reach one. Slash commands are exempt only when the
 * generated catalog proves that the TUI handles them locally, renders
 * information, or rejects them as unsupported. The queue/steer/image commands
 * are locally dispatched but their prompt payloads are provider-bound, so they
 * are classified before the general local-only exemption. Unknown/invalid
 * commands return null because App.tsx never dispatches them to the bridge.
 */
export function resolveModelBoundPrompt(input: string): ModelBoundPrompt | null {
  const line = input.trim();
  if (!line) return null;
  if (!line.startsWith("/")) return { source: "plain", prompt: line };

  const body = line.slice(1);
  const [rawName, ...rawArgs] = body.split(/\s+/);
  const name = (rawName || "").toLowerCase();
  if (name === "goal") {
    const prompt = rawArgs.join(" ").trim();
    return prompt ? { source: "goal", prompt } : null;
  }
  if (name === "agi" && ["start", "run"].includes((rawArgs[0] || "").toLowerCase())) {
    const prompt = rawArgs.slice(1).join(" ").trim();
    return prompt ? { source: "agi-start", prompt } : null;
  }

  const { cmd, args } = resolve(line);
  if (!cmd) return null;
  if (cmd.name === "queue" || cmd.name === "steer") {
    const prompt = args.trim();
    return prompt ? { source: cmd.name, prompt } : null;
  }
  if (cmd.name === "image") {
    const separator = args.indexOf("::");
    const prompt = (separator >= 0 ? args.slice(separator + 2) : args).trim();
    return prompt ? { source: "image", prompt } : null;
  }
  switch (clientExecutionFor(cmd, "tui").execution_state) {
    case "prompt":
      return {
        source: "catalog-prompt",
        prompt: expandPromptCommand(cmd, args),
      };
    case "implemented_local":
    case "info":
    case "unsupported":
      return null;
  }
}

/**
 * Pure submission gate used by App.tsx. `alreadyConfirmed` is true only after
 * the operator approves the queued local confirmation; it skips a duplicate
 * scan while retaining the exact resolved prompt for bridge dispatch.
 */
export function planModelBoundSecretPreflight(
  input: string,
  alreadyConfirmed = false,
): ModelBoundSecretPreflight {
  const modelBound = resolveModelBoundPrompt(input);
  if (!modelBound || alreadyConfirmed) {
    return { action: "proceed", modelBound, preflight: null };
  }
  const preflight = runSecretPreflight(modelBound.prompt);
  return {
    action: preflight.requiresExplicitConfirmation ? "confirm" : "proceed",
    modelBound,
    preflight,
  };
}

export function redactSecretFindings(input: string, findings: readonly SecretFinding[]): string {
  const ordered = [...findings]
    .filter((finding) => finding.start >= 0 && finding.end >= finding.start && finding.end <= input.length)
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let output = input;
  let coveredStart = input.length + 1;
  for (const finding of ordered) {
    if (finding.end > coveredStart) continue;
    output = `${output.slice(0, finding.start)}[REDACTED POSSIBLE SECRET]${output.slice(finding.end)}`;
    coveredStart = finding.start;
  }
  return output;
}
