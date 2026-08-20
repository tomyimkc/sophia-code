export type ProviderHealthState =
  | "ready"
  | "configured"
  | "degraded"
  | "unavailable"
  | "unconfigured"
  | "unknown"
  | "skipped"
  | "probing"
  | "not_probed";

export interface LocalEngineSummary {
  name: string;
  provider: string;
  installed: boolean;
  running: boolean;
  ready: boolean;
  optionalGateway: boolean;
  models: string[];
  /** Bounded, read-only GGUF scan results. Presence does not imply the file is loaded. */
  modelFiles: string[];
}
export interface ProviderHealthSummary {
  provider: string;
  model: string;
  state: ProviderHealthState;
  ok: boolean;
  detail: string;
  paidProbeMade: false;
}

export interface RuntimeSnapshot {
  profile: string;
  os: string;
  machine: string;
  provider: string;
  providerHealth: ProviderHealthSummary[];
  engines: LocalEngineSummary[];
  capabilities: Record<string, unknown> | null;
  imageProvider: {
    name: string;
    ready: boolean;
    detail: string;
  };
  mcp: {
    status: string;
    ok: boolean | null;
    configured: boolean;
    mode: string;
  };
  protocol: {
    version: number | null;
    minimum: number | null;
    bridgeInstanceId: string;
  };
}

export type OnboardingStep = "model" | "permission";

const EMPTY_RUNTIME: RuntimeSnapshot = {
  profile: "public",
  os: "unknown",
  machine: "unknown",
  provider: "",
  providerHealth: [],
  engines: [],
  capabilities: null,
  imageProvider: { name: "none", ready: false, detail: "image generation is disabled" },
  mcp: { status: "not_probed", ok: null, configured: false, mode: "in_process" },
  protocol: { version: null, minimum: null, bridgeInstanceId: "" },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function healthState(value: unknown): ProviderHealthState {
  const state = text(value, "unknown").toLowerCase();
  return [
    "ready", "configured", "degraded", "unavailable", "unconfigured",
    "unknown", "skipped", "probing", "not_probed",
  ].includes(state)
    ? state as ProviderHealthState
    : "unknown";
}

function healthDetail(report: Record<string, unknown>): string {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const problem = checks
    .map(record)
    .find((check) => !bool(check.ok) && text(check.detail));
  return text(problem?.detail || record(report.error).message);
}

export function parseProviderHealth(value: unknown): ProviderHealthSummary[] {
  const envelope = record(value);
  if (text(envelope.status) === "probing") {
    const requested = Array.isArray(envelope.providers) ? envelope.providers : [];
    return requested.map((provider) => ({
      provider: text(provider),
      model: "",
      state: "probing",
      ok: false,
      detail: "no-spend health probe in progress",
      paidProbeMade: false,
    }));
  }
  const rows = Array.isArray(envelope.providers)
    ? envelope.providers
    : Array.isArray(value)
      ? value
      : [];
  return rows.map(record).map((report) => ({
    provider: text(report.provider),
    model: text(report.model),
    state: healthState(report.state),
    ok: bool(report.ok),
    detail: healthDetail(report),
    paidProbeMade: false,
  }));
}

export function parseReadyRuntime(event: unknown): RuntimeSnapshot {
  const ready = record(event);
  const runtime = record(ready.runtime);
  const profile = record(ready.providerProfile);
  const capabilities = Object.keys(record(ready.providerCapabilities)).length
    ? record(ready.providerCapabilities)
    : null;
  const image = record(ready.imageProvider);
  const imageHealth = record(image.health);
  const mcp = record(ready.mcp);
  const protocol = record(ready.protocolInfo);
  const engines = (Array.isArray(ready.localEngines) ? ready.localEngines : [])
    .map(record)
    .map((engine): LocalEngineSummary => ({
      name: text(engine.name),
      provider: text(engine.provider),
      installed: bool(engine.installed),
      running: bool(engine.running),
      ready: bool(engine.ready),
      optionalGateway: bool(engine.optionalGateway),
      models: Array.isArray(engine.models) ? engine.models.map((model) => text(model)).filter(Boolean) : [],
      modelFiles: Array.isArray(engine.modelFiles)
        ? engine.modelFiles.map((model) => text(model)).filter(Boolean)
        : [],
    }));
  return {
    ...EMPTY_RUNTIME,
    profile: text(profile.name, "public"),
    os: text(runtime.os_name, "unknown"),
    machine: text(runtime.machine, "unknown"),
    provider: text(record(ready.defaults).model),
    engines,
    capabilities,
    imageProvider: {
      name: text(image.name, "none"),
      ready: bool(imageHealth.ready),
      detail: text(imageHealth.detail, "not probed"),
    },
    mcp: {
      status: text(mcp.status, "not_probed"),
      ok: typeof mcp.ok === "boolean" ? mcp.ok : null,
      configured: bool(mcp.configured),
      mode: text(mcp.mode, "in_process"),
    },
    protocol: {
      version: Number.isFinite(Number(protocol.version)) ? Number(protocol.version) : null,
      minimum: Number.isFinite(Number(protocol.minimum)) ? Number(protocol.minimum) : null,
      bridgeInstanceId: text(protocol.bridgeInstanceId),
    },
  };
}

export function applyProviderHealth(
  current: RuntimeSnapshot,
  event: unknown,
): RuntimeSnapshot {
  return { ...current, providerHealth: parseProviderHealth(event) };
}

export function applyMcpHealth(
  current: RuntimeSnapshot,
  event: unknown,
): RuntimeSnapshot {
  const mcp = record(event);
  return {
    ...current,
    mcp: {
      status: text(mcp.status, "unknown"),
      ok: typeof mcp.ok === "boolean" ? mcp.ok : null,
      configured: bool(mcp.configured),
      mode: text(mcp.mode, current.mcp.mode),
    },
  };
}

export function onboardingSteps(event: unknown): OnboardingStep[] {
  const required = record(record(event).onboarding);
  const flags = record(required.required);
  const steps: OnboardingStep[] = [];
  if (bool(flags.provider)) steps.push("model");
  if (bool(flags.permission)) steps.push("permission");
  return steps;
}

export function providerHealthWord(runtime: RuntimeSnapshot): string {
  const report = runtime.providerHealth.find((row) =>
    row.provider === runtime.provider || row.model === runtime.provider
  ) || runtime.providerHealth[0];
  if (!report) return "health?";
  if (report.state === "probing") return "probing";
  if (report.ok) return "healthy";
  return report.state;
}

export function doctorLines(runtime: RuntimeSnapshot, options: {
  bridgeReady: boolean;
  model: string;
  permission: string;
  cwd: string;
  terminal: string;
  commands: number;
}): string[] {
  const readyEngines = runtime.engines.filter((engine) => engine.ready && !engine.optionalGateway);
  const optionalGateways = runtime.engines.filter((engine) => engine.optionalGateway && engine.running);
  const health = runtime.providerHealth.length
    ? runtime.providerHealth.map((row) =>
        `${row.provider || row.model || "provider"}=${row.state}${row.detail ? ` (${row.detail})` : ""}`
      ).join("; ")
    : "not probed";
  return [
    `bridge: ${options.bridgeReady ? "ready" : "down"}`,
    `protocol: ${runtime.protocol.version ?? "?"} (minimum ${runtime.protocol.minimum ?? "?"})`,
    `runtime: ${runtime.os}/${runtime.machine} · profile=${runtime.profile}`,
    `model: ${options.model}`,
    `provider health: ${health} · paidProbeMade=false`,
    `local engines: ${readyEngines.length ? readyEngines.map((engine) => engine.provider).join(", ") : "none ready"}`,
    `optional gateways: ${optionalGateways.length ? optionalGateways.map((engine) => engine.provider).join(", ") : "none running"}`,
    `permission: ${options.permission}`,
    `image provider: ${runtime.imageProvider.name} · ${runtime.imageProvider.ready ? "ready" : runtime.imageProvider.detail}`,
    `MCP: ${runtime.mcp.status} · ${runtime.mcp.mode}`,
    `cwd: ${options.cwd}`,
    `terminal: ${options.terminal}`,
    `slash commands: ${options.commands}`,
    "health checks are metadata-only; no generation request or paid probe is made",
  ];
}
