/**
 * Format the kernel's team-mode bridge events for the transcript.
 *
 * Since #1645 the kernel emits `team_start.routing` (SwarmRouter decision or
 * TEAM_ROLES fallback) and `lanes_abandoned` when the drain budget drops
 * lanes. Nothing in the TUI listened, so the operator saw agent nodes in
 * /workflows with no explanation of *why* those roles, and a silent
 * coordinator-only answer when lanes were abandoned.
 *
 * Pure string formatters — no React — so they unit-test without Ink.
 */

export interface TeamRouting {
  mode?: string;
  source?: string;
  rationale?: string;
  roles?: string[];
  estCostSteps?: number;
  nAgents?: number;
}

/** Dedicated warning for a packaged runtime whose bridge differs from cwd. */
export function formatRuntimeSourceWarning(
  ev: Record<string, unknown>,
): string | null {
  if (ev.runtimeSourceMatchesWorkspace !== false) return null;
  const anchor = String(ev.runtimeSourceAnchor || "agent/code_bridge.py").trim();
  const runtimeHash = String(ev.runtimeSourceSha256 || "").trim().slice(0, 12);
  const workspaceHash = String(ev.workspaceSourceSha256 || "").trim().slice(0, 12);
  const hashes = runtimeHash && workspaceHash
    ? ` · runtime ${runtimeHash} ≠ workspace ${workspaceHash}`
    : "";
  return (
    `⚠ executing runtime differs from workspace at ${anchor}${hashes}` +
    " · backend claims must use runtime-source tools"
  );
}

/** One-line transcript row for a `team_start` event. */
export function formatTeamStartMessage(
  ev: Record<string, unknown>,
  options: { includeRuntimeWarning?: boolean; verbose?: boolean } = {},
): string {
  const n = Number(ev.team);
  const team = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const roles = Array.isArray(ev.roles)
    ? ev.roles.map((r) => String(r)).filter(Boolean)
    : [];
  const routing =
    ev.routing && typeof ev.routing === "object"
      ? (ev.routing as TeamRouting)
      : {};
  const source = String(routing.source || "").trim();
  const mode = String(routing.mode || "").trim();
  const rationale = String(routing.rationale || "").trim();
  const workerModel = String(ev.workerModel || "").trim();

  if (options.verbose !== true) {
    return team > 0
      ? `Agents · ${team} active`
      : "Agents · active";
  }

  const parts: string[] = [];
  parts.push(
    team > 0
      ? `team · ${team} lane${team === 1 ? "" : "s"}`
      : "team · lanes started",
  );
  if (roles.length) {
    parts.push(`roles: ${roles.join(", ")}`);
  }
  if (workerModel) {
    parts.push(`workers: ${workerModel}`);
  }
  if (
    options.includeRuntimeWarning !== false
    && ev.runtimeSourceMatchesWorkspace === false
  ) {
    parts.push("runtime bundle differs from workspace; backend lanes use runtime-source tools");
  }

  if (source === "swarm_router") {
    parts.push("routed by SwarmRouter");
    if (rationale) parts.push(rationale);
  } else if (source === "team_roles") {
    // Operator forced fan-out on a prompt the router would have answered solo.
    parts.push(
      mode === "solo"
        ? "forced roles (router said solo)"
        : "roles from TEAM_ROLES fallback",
    );
    if (rationale && mode === "solo") {
      // Keep rationale short — solo floor text is long.
      const short = rationale.length > 80 ? `${rationale.slice(0, 77)}…` : rationale;
      parts.push(short);
    }
  } else if (rationale) {
    parts.push(rationale);
  }

  return parts.join(" · ");
}

/** Warning row when the drain budget abandoned one or more lanes. */
export function formatLanesAbandonedMessage(ev: Record<string, unknown>): string {
  const lanes = Array.isArray(ev.lanes) ? ev.lanes.map((l) => String(l)) : [];
  const detail = String(ev.detail || "").trim();
  const n = lanes.length;
  const who = n ? lanes.join(", ") : "lane(s)";
  if (detail) {
    return `⚠ ${n || "?"} lane(s) abandoned · ${detail}`;
  }
  return (
    `⚠ ${n || "?"} lane(s) abandoned (${who}) — their output is NOT in the final answer`
  );
}

/** Short status-line detail for synthesis. */
export function formatSynthesisDetail(ev: Record<string, unknown>): string {
  const n = Number(ev.lanes);
  if (Number.isFinite(n) && n > 0) {
    return `synthesizing ${Math.floor(n)} lanes`;
  }
  return "synthesizing lanes";
}
