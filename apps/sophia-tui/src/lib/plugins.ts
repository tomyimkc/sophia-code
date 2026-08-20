import { sanitizeTerminalText } from "./chatLayout.js";

export type PluginAction =
  | "list"
  | "inspect"
  | "permissions"
  | "use"
  | "enable"
  | "disable"
  | "reload"
  | "safe_mode"
  | "profile_use"
  | "workflow_use"
  | "skill_use"
  | "agent_use"
  | "runtime_use"
  | "runtime_status"
  | "lock_export"
  | "lock_import"
  | "catalog_status"
  | "catalog_search"
  | "catalog_inspect"
  | "catalog_select"
  | "compat_list"
  | "compat_discover"
  | "compat_install"
  | "compat_uninstall"
  | "compat_rollback"
  | "compat_transactions"
  | "compat_inspect"
  | "compat_test"
  | "compat_health"
  | "compat_tool_list"
  | "compat_tool_call"
  | "compat_skill_list"
  | "compat_skill_use";

const PLUGIN_ACTIONS = new Set<PluginAction>([
  "list",
  "inspect",
  "permissions",
  "use",
  "enable",
  "disable",
  "reload",
  "safe_mode",
  "profile_use",
  "workflow_use",
  "skill_use",
  "agent_use",
  "runtime_use",
  "runtime_status",
  "lock_export",
  "lock_import",
  "catalog_status",
  "catalog_search",
  "catalog_inspect",
  "catalog_select",
  "compat_list",
  "compat_discover",
  "compat_install",
  "compat_uninstall",
  "compat_rollback",
  "compat_transactions",
  "compat_inspect",
  "compat_test",
  "compat_health",
  "compat_tool_list",
  "compat_tool_call",
  "compat_skill_list",
  "compat_skill_use",
]);

export interface PluginCommand {
  action: PluginAction;
  pluginId?: string;
  reference?: string;
  source?: string;
  path?: string;
  compatibilityId?: string;
  tool?: string;
  input?: Record<string, unknown>;
  approvePermissions?: boolean;
  approveSettings?: boolean;
  approvalToken?: string;
  approveInstall?: boolean;
  enabled?: boolean;
  query?: string;
  contribution?: string[];
  capability?: string[];
  protocol?: string[];
  hostProtocols?: string[];
  platform?: string;
  architecture?: string;
  version?: string;
  eligibleOnly?: boolean;
  allowStale?: boolean;
  allowPrerelease?: boolean;
  lease?: "task" | "session";
  session?: string;
}

export interface PluginSettingsPatch {
  workflowMode?: "off" | "auto" | "on";
  workflowMaxStages?: number;
  workflowMaxAgents?: number;
  a2aAgents?: number;
  a2aExecution?: "embedded" | "terminal" | "headless";
  terminalLayout?: "off" | "auto" | "splits" | "windows" | "headless";
  deepMode?: boolean;
  agiMode?: false;
  responseStyle?: "adaptive" | "concise" | "explanatory" | "structured";
}

export interface PluginParseResult {
  ok: boolean;
  command?: PluginCommand;
  error?: string;
}

const USAGE = [
  "usage:",
  "  /plugin list",
  "  /plugin inspect <plugin-id>",
  "  /plugin permissions <plugin-id>",
  "  /plugin use <plugin-id>[/<contribution-id>] [--task|--session]",
  "  /plugin use <plugin-id>/<contribution-id> [--task|--session] --approve <challenge-token>",
  "  /plugin use <plugin-id>/<contribution-id> [--task|--session] --approve-settings <challenge-token>",
  "  /plugin use off",
  "  /plugin enable <plugin-id> [--approve]",
  "  /plugin disable <plugin-id>",
  "  /plugin profile use <plugin-id>/<profile-id>",
  "  /plugin workflow use <plugin-id>/<workflow-id>",
  "  /plugin skill use <plugin-id>/<skill-id>|off",
  "  /plugin agent use <plugin-id>/<agent-id>|off",
  "  /plugin runtime use <plugin-id>/<runtime-id>|off",
  "  /plugin runtime status [plugin-id/runtime-id]",
  "  /plugin safe-mode on|off",
  "  /plugin lock export <path>  (quote paths containing whitespace)",
  "  /plugin lock import <path>  (quote paths containing whitespace)",
  "  /plugin catalog status",
  "  /plugin catalog search [query] [--contribution <kind>] [--capability <name>] [--protocol <name>] [--host-protocol <name>] [--platform <os>] [--architecture <arch>] [--eligible-only]",
  "  /plugin catalog inspect <plugin-id> [--host-protocol <name>] [--platform <os>] [--architecture <arch>]",
  "  /plugin catalog select <plugin-id> [--version <semver>] [--protocol <name>] [--host-protocol <name>] [--platform <os>] [--architecture <arch>] [--allow-stale] [--allow-prerelease]",
  "  /plugin compat list",
  "  /plugin compat discover <source>",
  "  /plugin compat install <source> [--approve]",
  "  /plugin compat uninstall <id>",
  "  /plugin compat rollback <id>",
  "  /plugin compat transactions",
  "  /plugin compat inspect <id>",
  "  /plugin compat test <id>",
  "  /plugin compat health [id]",
  "  /plugin compat tools <id>",
  "  /plugin compat call <plugin>/<tool> [JSON]",
  "  /plugin compat skills <id>",
  "  /plugin compat skill use <id> <skill>",
  "  /plugin compat skill off",
  "  /reload-plugins",
].join("\n");

export function pluginUsage(): string {
  return USAGE;
}

function invalidUsage(message?: string): PluginParseResult {
  return {
    ok: false,
    error: message ? `${message}\n${USAGE}` : USAGE,
  };
}

function parseSinglePathArgument(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const quote = text[0];
  if (quote === "'" || quote === "\"") {
    if (text.length < 2 || text[text.length - 1] !== quote) return null;
    const inner = text.slice(1, -1);
    if (!inner || inner.includes(quote) || inner.includes("\u0000")) return null;
    return inner;
  }
  return /\s/.test(text) || text.includes("\u0000") ? null : text;
}

function parseCompatSlash(args: string): PluginParseResult {
  const match = args.trim().match(/^compat(?:\s+([\s\S]*))?$/i);
  const rest = (match?.[1] || "").trim();
  if (!rest) return invalidUsage();
  const parts = rest.split(/\s+/).filter(Boolean);
  const subcommand = (parts[0] || "").toLowerCase();

  if (subcommand === "list") {
    return parts.length === 1
      ? { ok: true, command: { action: "compat_list" } }
      : invalidUsage("compat list does not accept arguments");
  }
  if (subcommand === "transactions") {
    return parts.length === 1
      ? { ok: true, command: { action: "compat_transactions" } }
      : invalidUsage("compat transactions does not accept arguments");
  }
  if (subcommand === "discover") {
    if (parts.length !== 2) return invalidUsage("compat discover requires exactly one source");
    return {
      ok: true,
      command: { action: "compat_discover", source: parts[1] },
    };
  }
  if (subcommand === "install") {
    if (!parts[1]) return invalidUsage("compat install requires a source");
    const flags = parts.slice(2);
    const unknown = flags.find((flag) => flag !== "--approve");
    if (unknown) return invalidUsage(`unknown compat install flag: ${unknown}`);
    if (flags.filter((flag) => flag === "--approve").length > 1) {
      return invalidUsage("compat install accepts --approve at most once");
    }
    return {
      ok: true,
      command: {
        action: "compat_install",
        source: parts[1],
        approveInstall: flags.includes("--approve"),
      },
    };
  }
  if (
    subcommand === "uninstall"
    || subcommand === "rollback"
    || subcommand === "inspect"
    || subcommand === "test"
    || subcommand === "tools"
    || subcommand === "skills"
  ) {
    if (parts.length !== 2) {
      return invalidUsage(`compat ${subcommand} requires exactly one compatibility id`);
    }
    const action = {
      uninstall: "compat_uninstall",
      rollback: "compat_rollback",
      inspect: "compat_inspect",
      test: "compat_test",
      tools: "compat_tool_list",
      skills: "compat_skill_list",
    }[subcommand] as PluginAction;
    return {
      ok: true,
      command: {
        action,
        compatibilityId: parts[1],
      },
    };
  }
  if (subcommand === "skill") {
    if (parts.length === 2 && parts[1]?.toLowerCase() === "off") {
      return {
        ok: true,
        command: {
          action: "compat_skill_use",
          reference: "off",
        },
      };
    }
    if (
      parts.length === 4
      && parts[1]?.toLowerCase() === "use"
    ) {
      return {
        ok: true,
        command: {
          action: "compat_skill_use",
          compatibilityId: parts[2],
          reference: parts[3],
        },
      };
    }
    return invalidUsage(
      "compat skill requires 'use <compatibility-id> <skill>' or 'off'",
    );
  }
  if (subcommand === "health") {
    if (parts.length > 2) return invalidUsage("compat health accepts at most one compatibility id");
    return {
      ok: true,
      command: {
        action: "compat_health",
        ...(parts[1] ? { compatibilityId: parts[1] } : {}),
      },
    };
  }
  if (subcommand === "call") {
    const callMatch = rest.match(/^call\s+([^\s/]+)\/([^\s/]+)(?:\s+([\s\S]+))?$/i);
    if (!callMatch) return invalidUsage("compat call requires <plugin>/<tool> followed by optional JSON");
    let input: Record<string, unknown> = {};
    if (callMatch[3]) {
      try {
        const parsed = JSON.parse(callMatch[3]) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return invalidUsage("compat call JSON must be an object");
        }
        input = parsed as Record<string, unknown>;
      } catch (error) {
        return invalidUsage(
          `invalid compat call JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      ok: true,
      command: {
        action: "compat_tool_call",
        compatibilityId: callMatch[1],
        tool: callMatch[2],
        input,
      },
    };
  }
  return invalidUsage(`unknown compat action: ${subcommand || "(missing)"}`);
}

function parseCatalogSlash(args: string): PluginParseResult {
  const match = args.trim().match(/^catalog(?:\s+([\s\S]*))?$/i);
  const rest = (match?.[1] || "").trim();
  if (!rest) return invalidUsage("catalog requires an action");
  const parts = rest.split(/\s+/).filter(Boolean);
  const subcommand = (parts.shift() || "").toLowerCase();
  if (subcommand === "status") {
    return parts.length === 0
      ? { ok: true, command: { action: "catalog_status" } }
      : invalidUsage("catalog status does not accept arguments");
  }
  if (!["search", "inspect", "select"].includes(subcommand)) {
    return invalidUsage(`unknown catalog action: ${subcommand || "(missing)"}`);
  }

  const allowedByAction: Record<string, Set<string>> = {
    search: new Set([
      "--contribution",
      "--capability",
      "--protocol",
      "--host-protocol",
      "--platform",
      "--architecture",
      "--eligible-only",
    ]),
    inspect: new Set([
      "--host-protocol",
      "--platform",
      "--architecture",
    ]),
    select: new Set([
      "--version",
      "--protocol",
      "--host-protocol",
      "--platform",
      "--architecture",
      "--allow-stale",
      "--allow-prerelease",
    ]),
  };
  const repeatedFlags = new Map<string, string[]>([
    ["--contribution", []],
    ["--capability", []],
    ["--protocol", []],
    ["--host-protocol", []],
  ]);
  const singletonFlags = new Map<string, string>();
  const booleanFlags = new Set<string>();
  const positionals: string[] = [];
  const allowed = allowedByAction[subcommand];

  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!allowed.has(token)) {
      return invalidUsage(`catalog ${subcommand} does not accept ${token}`);
    }
    if (["--eligible-only", "--allow-stale", "--allow-prerelease"].includes(token)) {
      if (booleanFlags.has(token)) {
        return invalidUsage(`catalog ${subcommand} accepts ${token} at most once`);
      }
      booleanFlags.add(token);
      continue;
    }
    const value = parts[index + 1];
    if (!value || value.startsWith("--")) {
      return invalidUsage(`catalog ${subcommand} flag ${token} requires a value`);
    }
    index += 1;
    if (repeatedFlags.has(token)) {
      repeatedFlags.get(token)?.push(value);
      continue;
    }
    if (singletonFlags.has(token)) {
      return invalidUsage(`catalog ${subcommand} accepts ${token} at most once`);
    }
    singletonFlags.set(token, value);
  }

  const common = {
    ...(repeatedFlags.get("--protocol")?.length
      ? { protocol: repeatedFlags.get("--protocol") }
      : {}),
    ...(repeatedFlags.get("--host-protocol")?.length
      ? { hostProtocols: repeatedFlags.get("--host-protocol") }
      : {}),
    ...(singletonFlags.get("--platform")
      ? { platform: singletonFlags.get("--platform") }
      : {}),
    ...(singletonFlags.get("--architecture")
      ? { architecture: singletonFlags.get("--architecture") }
      : {}),
  };
  if (subcommand === "search") {
    return {
      ok: true,
      command: {
        action: "catalog_search",
        ...(positionals.length ? { query: positionals.join(" ") } : {}),
        ...(repeatedFlags.get("--contribution")?.length
          ? { contribution: repeatedFlags.get("--contribution") }
          : {}),
        ...(repeatedFlags.get("--capability")?.length
          ? { capability: repeatedFlags.get("--capability") }
          : {}),
        ...common,
        ...(booleanFlags.has("--eligible-only") ? { eligibleOnly: true } : {}),
      },
    };
  }
  if (positionals.length !== 1) {
    return invalidUsage(`catalog ${subcommand} requires exactly one plugin id`);
  }
  if (subcommand === "inspect") {
    return {
      ok: true,
      command: {
        action: "catalog_inspect",
        pluginId: positionals[0],
        ...common,
      },
    };
  }
  return {
    ok: true,
    command: {
      action: "catalog_select",
      pluginId: positionals[0],
      ...common,
      ...(singletonFlags.get("--version")
        ? { version: singletonFlags.get("--version") }
        : {}),
      ...(booleanFlags.has("--allow-stale") ? { allowStale: true } : {}),
      ...(booleanFlags.has("--allow-prerelease")
        ? { allowPrerelease: true }
        : {}),
    },
  };
}

export function parsePluginSlash(args: string, commandName = "plugin"): PluginParseResult {
  if (commandName === "reload-plugins") {
    return { ok: true, command: { action: "reload" } };
  }
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts[0] === "list" || parts[0] === "status") {
    return { ok: true, command: { action: "list" } };
  }
  const action = parts[0].toLowerCase();
  if (action === "catalog") return parseCatalogSlash(args);
  if (action === "compat") return parseCompatSlash(args);
  if (action === "use") {
    if (!parts[1]) return invalidUsage("plugin use requires a contribution reference or off");
    const reference = parts[1];
    const args = parts.slice(2);
    let lease: "task" | "session" = "task";
    let sawLease = false;
    let approvalStage: "permissions" | "settings" | null = null;
    let approvalToken = "";
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (value === "--task" || value === "--session") {
        if (sawLease) {
          return invalidUsage("plugin use lease must be either --task or --session");
        }
        sawLease = true;
        lease = value === "--session" ? "session" : "task";
        continue;
      }
      if (value === "--approve" || value === "--approve-settings") {
        if (approvalStage !== null) {
          return invalidUsage("plugin use accepts one approval stage at a time");
        }
        const token = args[index + 1];
        if (!token || token.startsWith("--")) {
          return invalidUsage(`${value} requires a single-use challenge token`);
        }
        approvalStage = value === "--approve" ? "permissions" : "settings";
        approvalToken = token;
        index += 1;
        continue;
      }
      return invalidUsage(`unknown plugin use flag: ${value}`);
    }
    if (reference.toLowerCase() === "off" && args.length) {
      return invalidUsage("plugin use off does not accept flags");
    }
    if (
      approvalStage !== null
      && !approvalToken
    ) {
      return invalidUsage("plugin use approval requires a challenge token");
    }
    if (
      approvalStage === "permissions"
      && args.filter((value) => value === "--approve").length !== 1
    ) {
      return invalidUsage("plugin use accepts --approve at most once");
    }
    if (
      approvalStage === "settings"
      && args.filter((value) => value === "--approve-settings").length !== 1
    ) {
      return invalidUsage("plugin use accepts --approve-settings at most once");
    }
    if (args.includes("--task") && args.includes("--session")) {
      return invalidUsage("plugin use lease must be either --task or --session");
    }
    return {
      ok: true,
      command: {
        action: "use",
        reference,
        ...(reference.toLowerCase() === "off"
          ? {}
          : {
              lease,
              approvePermissions: approvalStage === "permissions",
              ...(approvalStage === "settings"
                ? { approveSettings: true }
                : {}),
              ...(approvalToken ? { approvalToken } : {}),
            }),
      },
    };
  }
  if (action === "inspect" || action === "permissions" || action === "disable") {
    if (!parts[1] || parts.length !== 2) return invalidUsage();
    return {
      ok: true,
      command: { action, pluginId: parts[1] } as PluginCommand,
    };
  }
  if (action === "enable") {
    if (!parts[1]) return invalidUsage();
    const flags = new Set(parts.slice(2));
    const unknown = [...flags].filter((flag) => flag !== "--approve");
    if (unknown.length) {
      return invalidUsage(`unknown plugin enable flag: ${unknown[0]}`);
    }
    return {
      ok: true,
      command: {
        action: "enable",
        pluginId: parts[1],
        approvePermissions: flags.has("--approve"),
      },
    };
  }
  if (action === "safe-mode" || action === "safe_mode") {
    const value = (parts[1] || "").toLowerCase();
    if ((value !== "on" && value !== "off") || parts.length !== 2) return invalidUsage();
    return {
      ok: true,
      command: { action: "safe_mode", enabled: value === "on" },
    };
  }
  if (action === "lock") {
    const match = args.trim().match(/^lock\s+(export|import)\s+([\s\S]+)$/i);
    const operation = (match?.[1] || "").toLowerCase();
    const path = parseSinglePathArgument(match?.[2] || "");
    if (!path) {
      return invalidUsage("plugin lock requires export|import and exactly one path");
    }
    return {
      ok: true,
      command: {
        action: operation === "export" ? "lock_export" : "lock_import",
        path,
      },
    };
  }
  if (["profile", "workflow", "skill", "agent", "runtime"].includes(action)) {
    const sub = (parts[1] || "").toLowerCase();
    if (action === "runtime" && sub === "status") {
      if (parts.length > 3) return invalidUsage();
      return {
        ok: true,
        command: {
          action: "runtime_status",
          ...(parts[2] ? { reference: parts[2] } : {}),
        },
      };
    }
    if (sub !== "use" || !parts[2] || parts.length !== 3) return invalidUsage();
    return {
      ok: true,
      command: {
        action: `${action}_use` as PluginAction,
        reference: parts[2],
      },
    };
  }
  return invalidUsage();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedText(value: unknown, fallback = "", maximum = 240): string {
  const text = sanitizeTerminalText(String(value ?? ""), true)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return fallback;
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function boundedStringArray(value: unknown, maximum = 50): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .slice(0, maximum)
      .map((item) => boundedText(item, "", 160))
      .filter(Boolean),
  )];
}

function boundedJson(value: unknown, maximum = 2_000): string {
  try {
    return sanitizeTerminalText(
      JSON.stringify(sanitizePluginResultValue(value)),
      true,
    ).slice(0, maximum);
  } catch {
    return boundedText(value, "{}", maximum);
  }
}

function sanitizePluginResultValue(
  value: unknown,
  seen = new WeakSet<object>(),
  budget = { nodes: 0 },
  depth = 0,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > 1_000) return "[display limit]";
  if (typeof value === "string") {
    return sanitizeTerminalText(value, true).slice(0, 8_000);
  }
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.description ? `[symbol ${value.description}]` : "[symbol]";
  if (typeof value !== "object") return sanitizeTerminalText(String(value), false);
  if (depth >= 6) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) =>
      sanitizePluginResultValue(item, seen, budget, depth + 1)
    );
    if (value.length > items.length) items.push(`[${value.length - items.length} more items]`);
    return items;
  }
  const sanitized: Record<string, unknown> = {};
  let entries: [string, unknown][] = [];
  try {
    entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
  } catch {
    return "[unreadable object]";
  }
  for (const [rawKey, item] of entries) {
    const key = sanitizeTerminalText(rawKey, false).slice(0, 160) || "field";
    try {
      sanitized[key] = sanitizePluginResultValue(item, seen, budget, depth + 1);
    } catch {
      sanitized[key] = "[unreadable value]";
    }
  }
  return sanitized;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export const PLUGIN_MANAGER_TABS = [
  "discover",
  "installed",
  "permissions",
  "health",
] as const;

export type PluginManagerTab = typeof PLUGIN_MANAGER_TABS[number];
export type PluginManagerKind = "native" | "compat";
export type PluginStructuralHealth =
  | "ready"
  | "warning"
  | "blocked"
  | "invalid"
  | "unknown";
export type PluginRuntimeHealthStatus =
  | "not_probed"
  | "probing"
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "unavailable"
  | "unknown";

export interface PluginRuntimeHealth {
  status: PluginRuntimeHealthStatus;
  detail: string;
  /** Runtime status is evidence only when an explicit compat_health/runtime_status reply set this. */
  probed: boolean;
}

export interface PluginManagerEntry {
  key: string;
  id: string;
  compatibilityId?: string;
  name: string;
  version: string;
  description: string;
  publisher: string;
  source: string;
  kind: PluginManagerKind;
  present: boolean;
  enabled: boolean;
  approvalRequired: boolean;
  approved: boolean;
  locked: boolean;
  lockState: "locked" | "unlocked" | "mismatch" | "unknown";
  selected: boolean;
  selectedKinds: string[];
  executable: boolean;
  trustTier: number | null;
  requestedPermissions: string[];
  approvedPermissions: string[];
  structuralHealth: PluginStructuralHealth;
  structuralDetail: string;
  runtimeHealth: PluginRuntimeHealth;
  tools: string[];
}

export interface PluginManagerActivity {
  kind: "progress" | "event";
  method: string;
  executionId: string;
  seq: number | null;
  state: string;
  progress: number | null;
  completed: number | null;
  total: number | null;
  etaSeconds: number | null;
  eventType: string;
  subjectKind: string;
  name: string;
  tool: string;
  workflow: string;
  jobId: string;
  artifactId: string;
  status: string;
  timestamp: string;
}

export interface PluginManagerState {
  tab: PluginManagerTab;
  cursor: Record<PluginManagerTab, number>;
  entries: PluginManagerEntry[];
  safeMode: boolean;
  issues: string[];
  selections: Record<string, string>;
  pendingAction: PluginAction | null;
  lastAction: PluginAction | null;
  lastError: string;
  activity: PluginManagerActivity | null;
}

export const INITIAL_PLUGIN_MANAGER_STATE: PluginManagerState = {
  tab: "discover",
  cursor: {
    discover: 0,
    installed: 0,
    permissions: 0,
    health: 0,
  },
  entries: [],
  safeMode: true,
  issues: [],
  selections: {},
  pendingAction: null,
  lastAction: null,
  lastError: "",
  activity: null,
};

export type PluginManagerAction =
  | { type: "seed"; payload: unknown }
  | { type: "bridge_event"; event: unknown }
  | { type: "set_tab"; tab: PluginManagerTab }
  | { type: "cycle_tab"; direction?: 1 | -1 }
  | { type: "move"; delta: number }
  | { type: "probe_started"; compatibilityId?: string }
  | { type: "request_started"; action: PluginAction };

function runtimeNotProbed(): PluginRuntimeHealth {
  return {
    status: "not_probed",
    detail: "runtime not probed",
    probed: false,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePluginActivity(
  value: unknown,
  kind: PluginManagerActivity["kind"],
): PluginManagerActivity {
  const raw = objectValue(value);
  const progress = finiteNumber(raw.progress);
  return {
    kind,
    method: boundedText(raw.method, "", 80),
    executionId: boundedText(raw.executionId, "", 160),
    seq: finiteNumber(raw.seq),
    state: boundedText(raw.state ?? raw.stage, "", 80),
    progress: progress === null ? null : Math.max(0, Math.min(1, progress)),
    completed: finiteNumber(raw.completed),
    total: finiteNumber(raw.total),
    etaSeconds: finiteNumber(raw.etaSeconds),
    eventType: boundedText(raw.eventType, "", 80),
    subjectKind: boundedText(raw.kind, "", 80),
    name: boundedText(raw.name, "", 160),
    tool: boundedText(raw.tool, "", 160),
    workflow: boundedText(raw.workflow, "", 160),
    jobId: boundedText(raw.jobId, "", 160),
    artifactId: boundedText(raw.artifactId, "", 160),
    status: boundedText(raw.status, "", 80),
    timestamp: boundedText(raw.timestamp, "", 80),
  };
}

export function pluginManagerActivityLine(
  activity: PluginManagerActivity | null,
): string {
  if (!activity) return "";
  if (activity.kind === "progress") {
    const progress = activity.completed !== null && activity.total !== null
      ? ` · ${activity.completed}/${activity.total}`
      : activity.progress !== null
        ? ` · ${Math.round(activity.progress * 100)}%`
        : "";
    const eta = activity.etaSeconds !== null
      ? ` · ETA ${Math.max(0, Math.round(activity.etaSeconds))}s`
      : "";
    const execution = activity.executionId ? ` · ${activity.executionId}` : "";
    return `plugin progress · ${activity.state || activity.method || "active"}${progress}${eta}${execution}`;
  }
  const subject = activity.tool
    || activity.workflow
    || activity.jobId
    || activity.artifactId
    || (
      activity.subjectKind && activity.name
        ? `${activity.subjectKind}/${activity.name}`
        : activity.name || activity.subjectKind
    );
  return [
    "plugin event",
    activity.eventType || activity.method || "update",
    activity.status,
    subject,
  ].filter(Boolean).join(" · ");
}

function normalizeSelections(value: unknown): Record<string, string> {
  const raw = objectValue(value);
  const selections: Record<string, string> = {};
  for (const key of [
    "profile",
    "workflow",
    "skill",
    "compatSkill",
    "agent",
    "runtime",
  ]) {
    const selected = boundedText(raw[key], "", 200);
    if (selected) selections[key] = selected;
  }
  return selections;
}

function structuralHealthFromRaw(
  raw: Record<string, unknown>,
): { status: PluginStructuralHealth; detail: string } {
  const explicit = boundedText(
    raw.structuralStatus ?? raw.structuralHealth ?? raw.validationStatus,
  ).toLowerCase();
  if (raw.lockMismatch === true) {
    return { status: "blocked", detail: "lock digest mismatch" };
  }
  if (
    raw.valid === false
    || raw.compatible === false
    || ["invalid", "failed", "error"].includes(explicit)
  ) {
    return {
      status: "invalid",
      detail: boundedText(
        raw.structuralDetail ?? raw.reason ?? raw.error,
        "manifest or compatibility validation failed",
      ),
    };
  }
  if (
    raw.blocked === true
    || ["blocked", "denied"].includes(explicit)
  ) {
    return {
      status: "blocked",
      detail: boundedText(raw.structuralDetail ?? raw.reason, "blocked by policy"),
    };
  }
  if (
    raw.warning === true
    || ["warning", "degraded"].includes(explicit)
  ) {
    return {
      status: "warning",
      detail: boundedText(raw.structuralDetail ?? raw.reason, "structural warning"),
    };
  }
  if (
    raw.valid === true
    || raw.compatible === true
    || ["ready", "valid", "compatible", "ok", "pass", "passed"].includes(explicit)
  ) {
    return {
      status: "ready",
      detail: boundedText(raw.structuralDetail, "manifest and lock structure accepted"),
    };
  }
  return {
    status: "unknown",
    detail: boundedText(raw.structuralDetail, "structural status not reported"),
  };
}

function runtimeHealthFromRaw(value: unknown): PluginRuntimeHealth {
  const raw = typeof value === "string"
    ? { status: value }
    : objectValue(value);
  const statusText = boundedText(
    raw.status ?? raw.runtimeStatus ?? raw.state,
  ).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  let status: PluginRuntimeHealthStatus = "unknown";
  if (raw.available === false || statusText === "unavailable") {
    status = "unavailable";
  } else if (
    raw.healthy === true
    || ["healthy", "ready", "ok", "pass", "passed"].includes(statusText)
  ) {
    status = "healthy";
  } else if (
    raw.healthy === false
    || ["unhealthy", "failed", "error"].includes(statusText)
  ) {
    status = "unhealthy";
  } else if (["degraded", "warning"].includes(statusText)) {
    status = "degraded";
  }
  return {
    status,
    detail: boundedText(
      raw.detail ?? raw.reason ?? raw.error ?? raw.message,
      status === "unknown" ? "probe completed without a recognized runtime status" : status,
    ),
    probed: true,
  };
}

function normalizePluginEntry(
  value: unknown,
  kind: PluginManagerKind,
  options: {
    defaultPresent: boolean;
    allowRuntimeHealth?: boolean;
    overlays?: Record<string, unknown>;
  },
): PluginManagerEntry | null {
  const raw = { ...objectValue(value), ...objectValue(options.overlays) };
  const id = boundedText(
    kind === "compat"
      ? raw.compatibilityId ?? raw.pluginId ?? raw.id ?? raw.name
      : raw.id ?? raw.pluginId ?? raw.name,
    "",
    160,
  );
  if (!id) return null;
  const compatibilityId = kind === "compat"
    ? boundedText(raw.compatibilityId ?? raw.id ?? raw.pluginId ?? id, id, 160)
    : undefined;
  const requestedPermissions = boundedStringArray(
    raw.requestedPermissions ?? raw.permissions,
  );
  const approvedPermissions = boundedStringArray(raw.approvedPermissions);
  const executable = raw.executable === true
    || boundedText(raw.kind).toLowerCase() === "executable";
  const approvalRequired = booleanValue(
    raw.requiresExplicitApproval,
    raw.approvalRequired,
  ) ?? (executable || requestedPermissions.length > 0);
  const explicitlyApproved = booleanValue(
    raw.approved,
    raw.permissionsApproved,
    raw.installApproved,
  );
  const approved = explicitlyApproved ?? (
    !approvalRequired
    || (
      requestedPermissions.length > 0
      && requestedPermissions.every((permission) =>
        approvedPermissions.includes(permission)
      )
    )
  );
  const lockMismatch = raw.lockMismatch === true
    || boundedText(raw.lockStatus).toLowerCase() === "mismatch";
  const locked = raw.locked === true && !lockMismatch;
  const lockState: PluginManagerEntry["lockState"] = lockMismatch
    ? "mismatch"
    : locked
      ? "locked"
      : raw.locked === false
        ? "unlocked"
        : "unknown";
  const structural = structuralHealthFromRaw(raw);
  const trustTierValue = Number(raw.trustTier);
  const runtimeCandidate = raw.runtimeHealth ?? raw.health ?? raw.status;
  return {
    key: `${kind}:${id}`,
    id,
    ...(compatibilityId ? { compatibilityId } : {}),
    name: boundedText(raw.displayName ?? raw.label ?? raw.name, id, 160),
    version: boundedText(raw.version, "?", 80),
    description: boundedText(raw.description ?? raw.summary, "", 360),
    publisher: boundedText(raw.publisher ?? raw.author, "unknown", 160),
    source: boundedText(raw.source ?? raw.origin, kind === "compat" ? "compat" : "local", 240),
    kind,
    present: booleanValue(raw.present, raw.installed) ?? options.defaultPresent,
    enabled: raw.enabled === true,
    approvalRequired,
    approved,
    locked,
    lockState,
    selected: raw.selected === true,
    selectedKinds: boundedStringArray(raw.selectedKinds, 10),
    executable,
    trustTier: Number.isFinite(trustTierValue) ? trustTierValue : null,
    requestedPermissions,
    approvedPermissions,
    structuralHealth: structural.status,
    structuralDetail: structural.detail,
    runtimeHealth: options.allowRuntimeHealth
      ? runtimeHealthFromRaw(runtimeCandidate)
      : runtimeNotProbed(),
    tools: boundedStringArray(raw.tools ?? raw.toolNames, 100),
  };
}

function extractArray(
  raw: Record<string, unknown>,
  keys: readonly string[],
): unknown[] {
  for (const key of keys) {
    if (Array.isArray(raw[key])) return (raw[key] as unknown[]).slice(0, 200);
  }
  return [];
}

function mergePluginEntries(
  current: readonly PluginManagerEntry[],
  incoming: readonly PluginManagerEntry[],
  replaceKind?: PluginManagerKind,
): PluginManagerEntry[] {
  const byKey = new Map<string, PluginManagerEntry>();
  for (const entry of current) {
    if (entry.kind !== replaceKind) byKey.set(entry.key, entry);
  }
  for (const entry of incoming) {
    const previous = current.find((candidate) => candidate.key === entry.key);
    byKey.set(entry.key, {
      ...previous,
      ...entry,
      structuralHealth:
        entry.structuralHealth === "unknown" && previous
          ? previous.structuralHealth
          : entry.structuralHealth,
      structuralDetail:
        entry.structuralHealth === "unknown" && previous
          ? previous.structuralDetail
          : entry.structuralDetail,
      runtimeHealth: entry.runtimeHealth.probed
        ? entry.runtimeHealth
        : previous?.runtimeHealth ?? entry.runtimeHealth,
    });
  }
  return [...byKey.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
  );
}

function applySelections(
  entries: readonly PluginManagerEntry[],
  selections: Record<string, string>,
): PluginManagerEntry[] {
  return entries.map((entry) => {
    const selectedKinds = Object.entries(selections)
      .filter(([, reference]) =>
        reference === entry.id
        || reference.startsWith(`${entry.id}/`)
        || (!!entry.compatibilityId && (
          reference === entry.compatibilityId
          || reference.startsWith(`${entry.compatibilityId}/`)
          || reference.startsWith(`${entry.compatibilityId}::`)
        ))
      )
      .map(([kind]) => kind);
    return {
      ...entry,
      selected: selectedKinds.length > 0,
      selectedKinds: [...new Set(selectedKinds)],
    };
  });
}

function issueLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    const issue = objectValue(item);
    const path = boundedText(issue.path ?? issue.id, "plugin", 160);
    const error = boundedText(issue.error ?? issue.message ?? item, "unknown issue", 320);
    return `${path}: ${error}`;
  });
}

export function pluginManagerEntriesForTab(
  state: PluginManagerState,
  tab = state.tab,
): PluginManagerEntry[] {
  if (tab === "installed") return state.entries.filter((entry) => entry.present);
  if (tab === "permissions") return state.entries.filter((entry) => entry.present);
  if (tab === "health") return state.entries.filter((entry) => entry.present);
  return state.entries;
}

export function selectedPluginManagerEntry(
  state: PluginManagerState,
): PluginManagerEntry | null {
  const entries = pluginManagerEntriesForTab(state);
  if (!entries.length) return null;
  const cursor = Math.max(0, Math.min(state.cursor[state.tab], entries.length - 1));
  return entries[cursor] ?? null;
}

function clampPluginManagerCursors(state: PluginManagerState): PluginManagerState {
  const cursor = { ...state.cursor };
  for (const tab of PLUGIN_MANAGER_TABS) {
    const count = pluginManagerEntriesForTab(state, tab).length;
    cursor[tab] = count ? Math.max(0, Math.min(cursor[tab], count - 1)) : 0;
  }
  return { ...state, cursor };
}

function seedNativePlugins(
  state: PluginManagerState,
  payload: unknown,
): PluginManagerState {
  const raw = objectValue(payload);
  const selections = normalizeSelections(raw.selections);
  const entries = extractArray(raw, ["plugins", "items"])
    .map((item) => normalizePluginEntry(item, "native", { defaultPresent: true }))
    .filter((item): item is PluginManagerEntry => item !== null);
  const merged = applySelections(
    mergePluginEntries(state.entries, entries, "native"),
    selections,
  );
  let seeded = clampPluginManagerCursors({
    ...state,
    entries: merged,
    safeMode: typeof raw.safeMode === "boolean" ? raw.safeMode : state.safeMode,
    issues: issueLines(raw.issues),
    selections,
  });
  const compatibility = objectValue(raw.dshCompatibility);
  const compatValues = extractArray(compatibility, [
    "plugins",
    "catalog",
    "items",
    "results",
  ]);
  const compatEntries = compatValues
    .map((item) => normalizePluginEntry(item, "compat", { defaultPresent: false }))
    .filter((item): item is PluginManagerEntry => item !== null);
  if (Object.prototype.hasOwnProperty.call(raw, "dshCompatibility")) {
    seeded = clampPluginManagerCursors({
      ...seeded,
      entries: applySelections(
        mergePluginEntries(seeded.entries, compatEntries, "compat"),
        selections,
      ),
      issues: [
        ...seeded.issues,
        ...issueLines(compatibility.issues),
      ].slice(0, 20),
    });
  }
  return seeded;
}

function updateEntryRuntimeHealth(
  entries: readonly PluginManagerEntry[],
  id: string,
  health: PluginRuntimeHealth,
  kind?: PluginManagerKind,
): PluginManagerEntry[] {
  return entries.map((entry) =>
    (!kind || entry.kind === kind)
    && (
      entry.id === id
      || entry.compatibilityId === id
      || id.startsWith(`${entry.id}/`)
    )
      ? { ...entry, runtimeHealth: health }
      : entry
  );
}

function normalizedAction(value: unknown): PluginAction | null {
  const action = boundedText(value, "", 80)
    .toLowerCase()
    .replaceAll("-", "_");
  return PLUGIN_ACTIONS.has(action as PluginAction)
    ? action as PluginAction
    : null;
}

function reduceCompatEvent(
  state: PluginManagerState,
  raw: Record<string, unknown>,
  action: PluginAction,
): PluginManagerState {
  const defaultPresent = action === "compat_install";
  const compatibility = objectValue(raw.compatibility);
  const container = Object.keys(compatibility).length ? compatibility : raw;
  const arrayValues = extractArray(container, [
    "compatibilityPlugins",
    "compatPlugins",
    "catalog",
    "plugins",
    "items",
    "results",
  ]);
  let incoming = arrayValues
    .map((item) => normalizePluginEntry(item, "compat", {
      defaultPresent,
      allowRuntimeHealth: action === "compat_health",
    }))
    .filter((item): item is PluginManagerEntry => item !== null);
  const singularOuter = objectValue(
    container.plugin ?? container.item ?? (
      Array.isArray(container.plugins) ? undefined : container
    ) ?? raw.result,
  );
  if (Object.keys(singularOuter).length) {
    const singular = normalizePluginEntry(singularOuter, "compat", {
      defaultPresent,
      allowRuntimeHealth: action === "compat_health",
      overlays: {
        compatibilityId: raw.compatibilityId
          ?? container.compatibilityId
          ?? singularOuter.compatibilityId,
        ...(action === "compat_tool_list"
          ? { tools: raw.tools ?? container.tools ?? singularOuter.tools }
          : {}),
      },
    });
    if (singular) incoming = [...incoming, singular];
  }

  let entries = mergePluginEntries(state.entries, incoming);
  const compatibilityId = boundedText(
    raw.compatibilityId
      ?? container.compatibilityId
      ?? raw.pluginId
      ?? singularOuter.compatibilityId
      ?? singularOuter.id,
    "",
    160,
  );
  if (action === "compat_uninstall" && compatibilityId) {
    entries = entries.map((entry) =>
      entry.kind === "compat"
      && (entry.compatibilityId === compatibilityId || entry.id === compatibilityId)
        ? {
            ...entry,
            present: false,
            enabled: false,
            selected: false,
            selectedKinds: [],
            runtimeHealth: runtimeNotProbed(),
          }
        : entry
    );
  }
  if (action === "compat_test" && compatibilityId) {
    const testPayload = objectValue(
      container.conformance ?? raw.test ?? raw.status ?? raw.result,
    );
    const passed = booleanValue(testPayload.passed, testPayload.ok, raw.ok);
    entries = entries.map((entry) =>
      entry.kind === "compat"
      && (entry.compatibilityId === compatibilityId || entry.id === compatibilityId)
        ? {
            ...entry,
            structuralHealth: passed === true
              ? "ready"
              : passed === false
                ? "invalid"
                : entry.structuralHealth,
            structuralDetail: boundedText(
              testPayload.detail ?? testPayload.reason ?? testPayload.error,
              passed === true
                ? "compatibility structure test passed"
                : passed === false
                  ? "compatibility structure test failed"
                  : entry.structuralDetail,
            ),
          }
        : entry
    );
  }
  if (action === "compat_health") {
    const healthValues = extractArray(container, ["health", "statuses", "results", "plugins"]);
    for (const value of healthValues) {
      const healthRaw = objectValue(value);
      const id = boundedText(
        healthRaw.compatibilityId ?? healthRaw.pluginId ?? healthRaw.id,
        "",
        160,
      );
      if (id) {
        entries = updateEntryRuntimeHealth(
          entries,
          id,
          runtimeHealthFromRaw(healthRaw.runtimeHealth ?? healthRaw),
          "compat",
        );
      }
    }
    if (compatibilityId) {
      const healthRaw = objectValue(
        container.health ?? container.status ?? raw.health ?? raw.status ?? raw.result ?? container,
      );
      entries = updateEntryRuntimeHealth(
        entries,
        compatibilityId,
        runtimeHealthFromRaw(healthRaw.runtimeHealth ?? healthRaw),
        "compat",
      );
    }
    if (!compatibilityId) {
      const probing = entries.filter(
        (entry) =>
          entry.kind === "compat"
          && entry.runtimeHealth.status === "probing",
      );
      if (probing.length) {
        const healthValue =
          container.health ?? container.status ?? raw.health ?? raw.status ?? raw.result ?? container;
        const health = runtimeHealthFromRaw(
          typeof healthValue === "string"
            ? {
                status: healthValue,
                detail: container.detail ?? raw.detail,
              }
            : healthValue,
        );
        for (const entry of probing) {
          entries = updateEntryRuntimeHealth(
            entries,
            entry.compatibilityId || entry.id,
            health,
            "compat",
          );
        }
      }
    }
  }
  if (action === "compat_tool_list" && compatibilityId) {
    const tools = boundedStringArray(
      raw.tools ?? objectValue(raw.result).tools ?? singularOuter.tools,
      100,
    );
    entries = entries.map((entry) =>
      entry.kind === "compat"
      && (entry.compatibilityId === compatibilityId || entry.id === compatibilityId)
        ? { ...entry, tools }
        : entry
    );
  }
  return clampPluginManagerCursors({
    ...state,
    entries,
    pendingAction: null,
    lastAction: action,
    lastError: raw.ok === false
      ? boundedText(raw.error ?? raw.message, "compatibility command failed", 500)
      : "",
    issues: raw.issues === undefined && container.issues === undefined
      ? state.issues
      : issueLines(raw.issues ?? container.issues),
  });
}

export function pluginManagerReducer(
  state: PluginManagerState,
  action: PluginManagerAction,
): PluginManagerState {
  if (action.type === "seed") return seedNativePlugins(state, action.payload);
  if (action.type === "set_tab") {
    return { ...state, tab: action.tab };
  }
  if (action.type === "cycle_tab") {
    const index = PLUGIN_MANAGER_TABS.indexOf(state.tab);
    const direction = action.direction ?? 1;
    const tab = PLUGIN_MANAGER_TABS[
      (index + direction + PLUGIN_MANAGER_TABS.length) % PLUGIN_MANAGER_TABS.length
    ];
    return { ...state, tab };
  }
  if (action.type === "move") {
    const entries = pluginManagerEntriesForTab(state);
    if (!entries.length) return state;
    const current = state.cursor[state.tab];
    const next = (current + action.delta + entries.length) % entries.length;
    return {
      ...state,
      cursor: { ...state.cursor, [state.tab]: next },
    };
  }
  if (action.type === "request_started") {
    return { ...state, pendingAction: action.action, lastError: "" };
  }
  if (action.type === "probe_started") {
    const target = boundedText(action.compatibilityId, "", 160);
    return {
      ...state,
      pendingAction: "compat_health",
      entries: state.entries.map((entry) =>
        entry.kind === "compat"
        && (!target || entry.compatibilityId === target || entry.id === target)
          ? {
              ...entry,
              runtimeHealth: {
                status: "probing",
                detail: "explicit runtime health probe in progress",
                probed: false,
              },
            }
          : entry
      ),
    };
  }

  const raw = objectValue(action.event);
  const eventType = boundedText(raw.type, "", 80);
  if (eventType === "plugin_progress") {
    return {
      ...state,
      activity: normalizePluginActivity(raw, "progress"),
    };
  }
  if (eventType === "plugin_compat_event") {
    return {
      ...state,
      activity: normalizePluginActivity(raw, "event"),
    };
  }
  const pluginAction = normalizedAction(raw.action);
  if (!pluginAction) return state;
  if (pluginAction.startsWith("compat_")) {
    return reduceCompatEvent(state, raw, pluginAction);
  }

  let next = state;
  if (Array.isArray(raw.plugins)) {
    next = seedNativePlugins(next, raw);
  }
  if (pluginAction === "inspect" || pluginAction === "permissions") {
    const outer = objectValue(raw.plugin);
    const plugin = pluginAction === "permissions" ? objectValue(outer.plugin) : outer;
    const normalized = normalizePluginEntry(plugin, "native", {
      defaultPresent: true,
      overlays: pluginAction === "permissions"
        ? {
            requestedPermissions: outer.requestedPermissions,
            approvedPermissions: outer.approvedPermissions,
            requiresExplicitApproval: outer.requiresExplicitApproval,
          }
        : undefined,
    });
    if (normalized) {
      next = {
        ...next,
        entries: mergePluginEntries(next.entries, [normalized]),
      };
    }
  }
  if (pluginAction === "runtime_status") {
    const runtime = boundedText(raw.runtime, "", 200);
    if (runtime) {
      next = {
        ...next,
        entries: updateEntryRuntimeHealth(
          next.entries,
          runtime,
          runtimeHealthFromRaw(raw.status),
          "native",
        ),
      };
    }
  }
  return clampPluginManagerCursors({
    ...next,
    pendingAction: null,
    lastAction: pluginAction,
    lastError: raw.ok === false
      ? boundedText(raw.error ?? raw.message, "plugin command failed", 500)
      : "",
  });
}

export function pluginManagerTabForAction(
  action: PluginAction,
): PluginManagerTab {
  if (action === "permissions") return "permissions";
  if (action === "runtime_status" || action === "compat_health") return "health";
  if (action.startsWith("catalog_")) return "discover";
  if (action === "compat_list" || action === "compat_discover") return "discover";
  if (action.startsWith("compat_")) {
    return action === "compat_install"
      || action === "compat_uninstall"
      || action === "compat_rollback"
      ? "installed"
      : "discover";
  }
  return action === "list" || action === "reload" || action === "use" || action === "enable" || action === "disable"
    ? "installed"
    : "discover";
}

export function normalizePluginSettingsPatch(value: unknown): PluginSettingsPatch {
  const raw = objectValue(value);
  const patch: PluginSettingsPatch = {};
  if (["off", "auto", "on"].includes(String(raw.workflowMode || ""))) {
    patch.workflowMode = raw.workflowMode as PluginSettingsPatch["workflowMode"];
  }
  if (Number.isInteger(raw.workflowMaxStages)) {
    patch.workflowMaxStages = Number(raw.workflowMaxStages);
  }
  if (Number.isInteger(raw.workflowMaxAgents)) {
    patch.workflowMaxAgents = Number(raw.workflowMaxAgents);
  }
  if (Number.isInteger(raw.a2aAgents)) patch.a2aAgents = Number(raw.a2aAgents);
  if (["embedded", "terminal", "headless"].includes(String(raw.a2aExecution || ""))) {
    patch.a2aExecution = raw.a2aExecution as PluginSettingsPatch["a2aExecution"];
  }
  if (["off", "auto", "splits", "windows", "headless"].includes(String(raw.terminalLayout || ""))) {
    patch.terminalLayout = raw.terminalLayout as PluginSettingsPatch["terminalLayout"];
  }
  if (typeof raw.deepMode === "boolean") patch.deepMode = raw.deepMode;
  if (raw.agiMode === false) patch.agiMode = false;
  if (["adaptive", "concise", "explanatory", "structured"].includes(String(raw.responseStyle || ""))) {
    patch.responseStyle = raw.responseStyle as PluginSettingsPatch["responseStyle"];
  }
  return patch;
}

function pluginLine(value: unknown): string {
  const plugin = normalizePluginEntry(value, "native", { defaultPresent: true });
  if (!plugin) return "  invalid plugin record";
  const executable = plugin.executable ? "executable" : "declarative";
  const tier = plugin.trustTier === null ? "tier ?" : `tier ${plugin.trustTier}`;
  return [
    `  ${plugin.id}@${plugin.version}`,
    plugin.present ? "present" : "catalog only",
    plugin.enabled ? "enabled" : "disabled",
    plugin.approvalRequired
      ? plugin.approved ? "approved" : "approval required"
      : "no approval required",
    plugin.lockState === "mismatch" ? "LOCK MISMATCH" : plugin.lockState,
    plugin.selected ? "selected" : "",
    executable,
    tier,
    `structural ${plugin.structuralHealth}`,
    "runtime not probed",
  ].filter(Boolean).join(" · ");
}

function formatPluginLockResult(
  event: Record<string, unknown>,
  action: string,
): string {
  const lock = objectValue(event.lock);
  const path = boundedText(lock.path ?? event.lockPath, "not reported", 400);
  const rawCount = lock.pluginCount ?? lock.count ?? event.pluginCount
    ?? event.count;
  const count = typeof rawCount === "number" && Number.isInteger(rawCount)
    && rawCount >= 0
    ? String(rawCount)
    : "unreported";
  const matched = booleanValue(
    lock.matched,
    lock.match,
    event.matched,
    event.match,
  );
  const authorityImported = booleanValue(
    lock.authorityImported,
    event.authorityImported,
  );
  return [
    `Plugin lock ${action === "lock_export" ? "export" : "import"} complete`,
    `path: ${path}`,
    `plugins: ${count}`,
    action === "lock_import"
      ? `match: ${matched === true ? "yes" : matched === false ? "no" : "unreported"}`
      : "",
    action === "lock_import"
      ? `authority imported: ${
        authorityImported === true
          ? "yes"
          : authorityImported === false
            ? "no"
            : "unreported"
      }`
      : "",
  ].filter(Boolean).join("\n");
}

function formatCompatTransactions(event: Record<string, unknown>): string {
  const transactions = objectValue(event.transactions);
  const fullHistory = Array.isArray(transactions.history)
    ? transactions.history
    : [];
  const pending = fullHistory.length
    ? fullHistory.filter(
      (item) => objectValue(item).status === "pending",
    ).length
    : 0;
  const priority = fullHistory.filter((item) => {
    const status = objectValue(item).status;
    return status === "pending" || status === "rolled-back";
  }).slice(-10);
  const history: unknown[] = [];
  const seen = new Set<string>();
  for (const item of [...priority, ...fullHistory.slice(-20)]) {
    const raw = objectValue(item);
    const key = boundedText(
      raw.operationId,
      `${boundedText(raw.pluginId)}:${boundedText(raw.action)}:${boundedText(raw.status)}`,
      200,
    );
    if (!seen.has(key)) {
      seen.add(key);
      history.push(item);
    }
    if (history.length >= 20) break;
  }
  const rollbackAvailable = boundedStringArray(
    transactions.rollbackAvailable,
    20,
  );
  const lines = [
    "Plugin compatibility transactions",
    `pending: ${pending}`,
    `rollback available: ${
      rollbackAvailable.length ? rollbackAvailable.join(", ") : "(none)"
    }`,
  ];
  for (const value of history) {
    const item = objectValue(value);
    const status = boundedText(item.status, "unknown", 40)
      .replaceAll("-", " ");
    const error = boundedText(item.error, "", 300);
    lines.push(
      [
        `  ${boundedText(item.operationId, "unknown", 40)}`,
        boundedText(item.pluginId, "unknown", 160),
        boundedText(item.action, "unknown", 40),
        status,
        error,
      ].filter(Boolean).join(" · "),
    );
  }
  return lines.join("\n").slice(0, 4800);
}

function formatCatalogResult(
  action: string,
  event: Record<string, unknown>,
): string {
  const lines: string[] = [];
  if (action === "catalog_status") {
    const catalog = objectValue(event.catalog);
    lines.push(
      "Plugin catalog status",
      `catalog: ${boundedText(catalog.catalogId, "unknown", 160)} · sequence ${boundedText(catalog.sequence, "?", 40)} · ${boundedText(catalog.cacheStatus, "unknown", 80)}`,
      `generated: ${boundedText(catalog.generatedAt, "unreported", 80)} · expires: ${boundedText(catalog.expiresAt, "unreported", 80)}`,
      `plugins: ${boundedText(catalog.pluginCount, "0", 40)} · publishers: ${boundedText(catalog.publisherCount, "0", 40)} · revocations: ${boundedText(catalog.revocationCount, "0", 40)}`,
    );
  } else if (action === "catalog_search") {
    const catalog = objectValue(event.catalog);
    const results = Array.isArray(event.results) ? event.results : [];
    lines.push(
      `Plugin catalog search (${Math.min(results.length, 30)}${results.length > 30 ? ` of ${results.length}` : ""})`,
      `catalog: ${boundedText(catalog.catalogId, "unknown", 160)} · ${boundedText(catalog.cacheStatus, "unknown", 80)}`,
    );
    for (const value of results.slice(0, 30)) {
      const plugin = objectValue(value);
      const release = objectValue(plugin.bestRelease);
      const publisher = objectValue(release.publisher);
      const compatibility = objectValue(release.compatibility);
      const quarantine = objectValue(release.quarantine);
      lines.push([
        `  ${boundedText(plugin.id, "unknown", 160)}@${boundedText(release.version, "?", 80)}`,
        boundedText(plugin.name, "", 160),
        `compat ${boundedText(compatibility.status, "unknown", 80)}`,
        `trust ${boundedText(publisher.trustStatus, "unknown", 80)}`,
        `quarantine ${boundedText(quarantine.status, "unknown", 80)}`,
      ].filter(Boolean).join(" · "));
    }
  } else if (action === "catalog_inspect") {
    const plugin = objectValue(event.catalog);
    const releases = Array.isArray(plugin.releases) ? plugin.releases : [];
    lines.push(
      `Plugin catalog inspect: ${boundedText(plugin.id, "unknown", 160)}`,
      `${boundedText(plugin.name, "", 160)}${plugin.publisherId ? ` · publisher ${boundedText(plugin.publisherId, "unknown", 160)}` : ""}`,
    );
    for (const value of releases.slice(0, 30)) {
      const release = objectValue(value);
      const compatibility = objectValue(release.compatibility);
      const publisher = objectValue(release.publisher);
      const signature = objectValue(release.publisherSignature);
      const quarantine = objectValue(release.quarantine);
      const revocation = objectValue(release.revocation);
      lines.push([
        `  ${boundedText(release.version, "?", 80)}`,
        `compat ${boundedText(compatibility.status, "unknown", 80)}`,
        `trust ${boundedText(publisher.trustStatus, "unknown", 80)}`,
        `signature ${boundedText(signature.status, "unknown", 80)}`,
        `quarantine ${boundedText(quarantine.status, "unknown", 80)}`,
        `revocation ${boundedText(revocation.status, "unknown", 80)}`,
      ].join(" · "));
    }
  } else if (action === "catalog_select") {
    const selection = objectValue(event.selection);
    const artifact = objectValue(selection.artifact);
    const environment = objectValue(selection.evaluatedEnvironment);
    const requestedProtocols = boundedStringArray(
      selection.requestedProtocols,
      64,
    );
    const environmentProtocols = boundedStringArray(environment.protocols, 64);
    lines.push(
      `Plugin catalog selection: ${boundedText(selection.pluginId, "unknown", 160)}@${boundedText(selection.version, "?", 80)}`,
      `mode: ${boundedText(selection.selectionMode, "unknown", 80)} · explicit version: ${boundedText(selection.explicitVersion, "none", 80)}`,
      `requested protocols: ${requestedProtocols.length ? requestedProtocols.join(", ") : "(none)"}`,
      `environment: ${boundedText(environment.platform, "unknown", 80)}/${boundedText(environment.architecture, "unknown", 80)} · Sophia API ${boundedText(environment.sophiaApi, "?", 40)} · protocols ${environmentProtocols.length ? environmentProtocols.join(", ") : "(none)"}`,
      `artifact: ${boundedText(artifact.kind, "unknown", 40)} · ${boundedText(artifact.reference, "unreported", 500)} · ${boundedText(artifact.sha256, "unreported", 96)}`,
      `allow stale: ${selection.allowStale === true ? "yes" : "no"} · allow prerelease: ${selection.allowPrerelease === true ? "yes" : "no"}`,
      "install approval: no · execution approval: no",
    );
  }
  lines.push(
    "discovery only: no package was fetched, installed, imported, enabled, approved, or executed.",
  );
  return sanitizeTerminalText(lines.join("\n"), true).slice(0, 12_000);
}

export function formatPluginResult(event: Record<string, unknown>): string {
  if (event.ok === false) {
    const action = boundedText(event.action, "command", 80);
    const approval = event.needsApproval === true
      ? action === "compat_install"
        ? "\nReview the source, then repeat with --approve; the TUI will require confirmation."
        : "\nReview with /plugin permissions <id>, then repeat with --approve."
      : "";
    return `plugin ${action} failed: ${boundedText(event.error, "unknown error", 800)}${approval}`;
  }
  const action = boundedText(event.action, "status", 80);
  if (action === "lock_export" || action === "lock_import") {
    return formatPluginLockResult(event, action);
  }
  if (action === "compat_transactions") {
    return formatCompatTransactions(event);
  }
  if (action.startsWith("catalog_")) {
    return formatCatalogResult(action, event);
  }
  if (action === "use") {
    const disclosure = objectValue(event.authorityDisclosure);
    const disclosedPlugin = objectValue(disclosure.plugin);
    const approvalBinding = objectValue(disclosure.approvalBinding);
    const challenge = objectValue(event.approvalChallenge);
    const activeLease = objectValue(event.activeLease);
    const endedLease = objectValue(event.endedLease);
    const lease = Object.keys(activeLease).length ? activeLease : endedLease;
    const permissions = boundedStringArray(
      disclosure.requestedPermissions ?? lease.permissions,
      50,
    );
    const reference = boundedText(
      disclosure.reference ?? lease.reference,
      "none",
      240,
    );
    const scope = boundedText(
      disclosure.leaseScope ?? lease.scope,
      "task",
      40,
    );
    const executable = disclosure.executable === true;
    const execution = executable
      ? boundedText(
        disclosure.isolationPolicy,
        "external process; sandbox enforcement is conditional on the manifest policy and local provider",
        500,
      )
      : "declarative narrowing-only contributions";
    const session = boundedText(
      disclosure.session ?? approvalBinding.session ?? lease.session,
      "",
      160,
    );
    const digest = boundedText(
      disclosure.digest ?? disclosedPlugin.digest ?? approvalBinding.digest,
      "",
      160,
    );
    const bindingHash = boundedText(
      disclosure.bindingHash ?? challenge.bindingHash ?? lease.bindingHash,
      "",
      160,
    );
    const proposalHash = boundedText(
      disclosure.proposalHash ?? approvalBinding.proposalHash ?? lease.proposalHash,
      "",
      160,
    );
    const authorizationEpoch = finiteNumber(
      disclosure.authorizationEpoch
        ?? approvalBinding.authorizationEpoch
        ?? challenge.authorizationEpoch,
    );
    const settings = objectValue(
      approvalBinding.settingsPatch
        ?? disclosure.settingsPatch
        ?? event.settingsPatch
        ?? lease.settingsPatch,
    );
    const executableIdentities = Array.isArray(disclosure.executableIdentities)
      ? disclosure.executableIdentities
        .slice(0, 20)
        .map((value) => objectValue(value))
        .map((identity) => {
          const kind = boundedText(identity.kind, "executable", 80);
          const path = boundedText(identity.path, "(path unavailable)", 320);
          const sha256 = boundedText(identity.sha256, "(hash unavailable)", 160);
          return `${kind} ${path} sha256 ${sha256}`;
        })
      : [];
    const boundLines = [
      ...(session ? [`session: ${session}`] : []),
      ...(digest ? [`digest: ${digest}`] : []),
      ...(bindingHash ? [`binding hash: ${bindingHash}`] : []),
      ...(authorizationEpoch !== null
        ? [`authorization epoch: ${authorizationEpoch}`]
        : []),
      ...(proposalHash ? [`proposal hash: ${proposalHash}`] : []),
      ...executableIdentities,
      `settings: ${boundedJson(settings)}`,
    ];
    const challengeToken = boundedText(challenge.token, "", 512);
    if (event.needsSettingsApproval === true && event.activated !== true) {
      return [
        `Plugin settings proposal · ${reference}`,
        `lease: ${scope} · process-local · exact reviewed authority`,
        `permissions: ${permissions.length ? permissions.join(", ") : "(none)"}`,
        ...boundLines,
        `execution: ${execution}`,
        "No lease is active yet. Review the returned settings and proposal hash.",
        challengeToken
          ? `Approve exactly these returned settings with: /plugin use ${reference} --${scope} --approve-settings ${challengeToken}`
          : "No settings approval challenge was returned; do not activate this proposal.",
      ].join("\n");
    }
    if (event.needsApproval === true && event.activated !== true) {
      return [
        `Plugin lease preview · ${reference}`,
        `lease: ${scope} · process-local · exact digest`,
        `permissions: ${permissions.length ? permissions.join(", ") : "(none)"}`,
        ...boundLines,
        `execution: ${execution}`,
        `durable safe mode remains ${disclosure.safeModeCurrently === false ? "off" : "on"}`,
        "This does not install the plugin, persist enablement, or reuse install approval.",
        challengeToken
          ? `Approve exactly this disclosure with: /plugin use ${reference} --${scope} --approve ${challengeToken}`
          : "No approval challenge was returned; do not activate this contribution.",
      ].join("\n");
    }
    if (event.activated === true) {
      return [
        `Plugin lease active · ${reference}`,
        `lease: ${scope} · process-local · exact digest`,
        `permissions: ${permissions.length ? permissions.join(", ") : "(none)"}`,
        `execution: ${execution}`,
        "Install state, durable enablement, and durable safe mode were not changed.",
        scope === "session"
          ? "Contributions and owned sidecars will be retired when this session changes, the bridge closes, or /plugin use off is run."
          : "Contributions and owned sidecars will be retired when the next task ends, the bridge closes, or /plugin use off is run.",
      ].join("\n");
    }
    return event.leaseEnded === true
      ? [
          `Plugin lease ended · ${reference}`,
          `reason: ${boundedText(event.reason, "lease boundary reached", 160).replaceAll("_", " ")}`,
          "Plugin contributions are inactive, owned sidecars were retired, and the prior validated settings were offered for restoration.",
          `durable safe mode: ${event.safeMode === false ? "off" : "on"}`,
        ].join("\n")
      : "No plugin lease was active; durable plugin state was unchanged.";
  }
  if (action.startsWith("compat_")) {
    const compatibility = objectValue(event.compatibility);
    const compatibilityId = boundedText(
      event.compatibilityId
        ?? compatibility.compatibilityId
        ?? compatibility.id,
      "",
      160,
    );
    const values = extractArray(compatibility, ["plugins", "catalog", "items", "results"]);
    const entries = values
      .map((item) => normalizePluginEntry(item, "compat", {
        defaultPresent: action === "compat_install",
        allowRuntimeHealth: action === "compat_health",
      }))
      .filter((item): item is PluginManagerEntry => item !== null);
    const lines = [
      `Plugin compatibility ${action.replace(/^compat_/, "").replaceAll("_", " ")} complete`,
    ];
    if (compatibilityId) lines.push(`compatibility id: ${compatibilityId}`);
    for (const entry of entries.slice(0, 30)) {
      lines.push([
        `  ${entry.id}@${entry.version}`,
        entry.present ? "present" : "catalog only",
        entry.enabled ? "enabled" : "disabled",
        entry.approvalRequired
          ? entry.approved ? "approved" : "approval required"
          : "no approval required",
        entry.lockState,
        entry.selected ? "selected" : "",
        `structural ${entry.structuralHealth}`,
        `runtime ${entry.runtimeHealth.status.replaceAll("_", " ")}`,
      ].filter(Boolean).join(" · "));
    }
    const tools = boundedStringArray(
      event.tools ?? compatibility.tools ?? objectValue(event.result).tools,
      100,
    );
    if (tools.length) lines.push(`tools: ${tools.join(", ")}`);
    if (action === "compat_tool_call" && event.result !== undefined) {
      let rendered = "";
      try {
        rendered = JSON.stringify(
          sanitizePluginResultValue(event.result),
          null,
          2,
        );
      } catch {
        rendered = boundedText(event.result, "(unrenderable result)", 2000);
      }
      lines.push(`result:\n${sanitizeTerminalText(rendered, true).slice(0, 4000)}`);
    }
    lines.push(
      action === "compat_health"
        ? "runtime health shown above comes only from this explicit probe."
        : "structural compatibility is not runtime health; use /plugin compat health [id] to probe.",
    );
    lines.push("external DSH plugins remain subject to Sophia safe mode, enablement, approval, and OS-user authority warnings.");
    return lines.join("\n");
  }
  if (action === "inspect" || action === "permissions") {
    const outer = objectValue(event.plugin);
    const plugin = action === "permissions" ? objectValue(outer.plugin) : outer;
    const lines = [
      `${boundedText(plugin.id, "plugin")}@${boundedText(plugin.version, "?")} · ${boundedText(plugin.kind, "unknown")}`,
      boundedText(plugin.description),
      `publisher: ${boundedText(plugin.publisher, "unknown")} · trust tier ${boundedText(plugin.trustTier, "?")} · ${plugin.executable === true ? "executable" : "declarative"}`,
      `enabled: ${plugin.enabled === true ? "yes" : "no"} · digest: ${String(plugin.digest || "unreported")}`,
    ].filter(Boolean);
    if (action === "permissions") {
      const requested = Array.isArray(outer.requestedPermissions) ? outer.requestedPermissions : [];
      const approved = Array.isArray(outer.approvedPermissions) ? outer.approvedPermissions : [];
      const executionPlan = objectValue(outer.executionPlan);
      const entrypoint = objectValue(executionPlan.entrypoint);
      const runtimes = Array.isArray(executionPlan.runtimes) ? executionPlan.runtimes : [];
      lines.push(`requested permissions: ${requested.length ? requested.join(", ") : "(none)"}`);
      lines.push(`approved permissions: ${approved.length ? approved.join(", ") : "(none)"}`);
      lines.push(`explicit approval required: ${outer.requiresExplicitApproval === true ? "yes" : "no"}`);
      if (Object.keys(entrypoint).length) {
        const command = Array.isArray(entrypoint.command) ? entrypoint.command.join(" ") : "(none)";
        const envAllow = Array.isArray(entrypoint.envAllow) ? entrypoint.envAllow.join(", ") : "(none)";
        lines.push(`entrypoint: ${command}`);
        lines.push(`entrypoint env allow-list: ${envAllow || "(none)"}`);
      }
      for (const value of runtimes) {
        const runtime = objectValue(value);
        const command = Array.isArray(runtime.command) ? runtime.command.join(" ") : "(adapter default)";
        lines.push(
          `runtime ${String(runtime.id || "?")}: adapter=${String(runtime.adapter || "?")} · command=${command} · permission=${String(runtime.permissionMode || "plugin-defined")}`,
        );
      }
    }
    return lines.join("\n");
  }
  if (action === "runtime_status") {
    const status = objectValue(event.status);
    return [
      `plugin runtime: ${boundedText(event.runtime, "none")}`,
      `available: ${status.available === true ? "yes" : "no"}`,
      status.version ? `version: ${boundedText(status.version)}` : "",
      status.profile ? `profile: ${boundedText(status.profile)}` : "",
      status.reason ? `reason: ${boundedText(status.reason)}` : "",
      status.error ? `error: ${boundedText(status.error)}` : "",
      "external runtime · read-only requested · output quarantined · candidateOnly",
      "runtime status comes from this explicit probe; structural validity alone is not runtime health.",
    ].filter(Boolean).join("\n");
  }
  const plugins = Array.isArray(event.plugins) ? event.plugins : [];
  const selections = objectValue(event.selections);
  const issues = Array.isArray(event.issues) ? event.issues : [];
  const header =
    action === "list"
      ? `Plugins (${plugins.length})`
      : `Plugin ${action.replaceAll("_", " ")} complete`;
  const lines = [
    header,
    ...(typeof event.safeMode === "boolean"
      ? [`safe mode: ${event.safeMode ? "on" : "off"}`]
      : []),
    ...plugins.map(pluginLine),
    `selections: profile=${boundedText(selections.profile, "none")} · workflow=${boundedText(selections.workflow, "none")} · skill=${boundedText(selections.skill, "none")} · agent=${boundedText(selections.agent, "none")} · runtime=${boundedText(selections.runtime, "sophia")}`,
    `lock: ${boundedText(event.lockPath, "not reported", 400)}`,
  ];
  if (issues.length) {
    lines.push("issues:");
    for (const issue of issues.slice(0, 10)) {
      const item = objectValue(issue);
      lines.push(`  ${boundedText(item.path, "plugin")}: ${boundedText(item.error, "unknown", 400)}`);
    }
  }
  lines.push("plugins propose/contribute; Sophia validates, authorizes, executes, records, and gates.");
  return lines.join("\n");
}
