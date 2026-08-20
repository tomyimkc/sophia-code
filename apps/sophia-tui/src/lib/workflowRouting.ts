/**
 * Resolve the mutually-exclusive controller settings for dynamic workflow.
 *
 * A launch-time `--workflow on|auto` must behave exactly like the in-session
 * `/workflow` command: it owns routing, enables supervised parallel A2A, and
 * suspends retired legacy dispatch and AGI mode for that run. Keeping this pure makes the boot/ACK paths
 * share one testable contract instead of drifting independently.
 */
export interface WorkflowRoutingSettings {
  autoTeam: boolean;
  team: number;
  a2aAgents: number;
  a2aExecution: "embedded" | "terminal" | "headless";
  terminalLayout: "off" | "auto" | "splits" | "windows" | "headless";
  agiMode: boolean;
}

export function workflowOwnsRouting(mode: unknown): boolean {
  const normalized = String(mode ?? "").trim().toLowerCase();
  return normalized === "auto" || normalized === "on";
}

export function resolveWorkflowRouting(
  mode: unknown,
  current: WorkflowRoutingSettings,
): WorkflowRoutingSettings {
  if (!workflowOwnsRouting(mode)) return { ...current };
  return {
    autoTeam: false,
    team: 1,
    a2aAgents: -1,
    a2aExecution: "terminal",
    terminalLayout: "auto",
    agiMode: false,
  };
}
