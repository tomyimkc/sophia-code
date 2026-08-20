export type RightPanelEtaStatus =
  | "estimating"
  | "active"
  | "waiting"
  | "complete"
  | "unavailable";

/**
 * Honest run-level estimate. The state layer owns the estimate; components only
 * format and display it. `remainingSec=null` means that progress exists but the
 * sample is still too weak to predict a completion time.
 */
export interface RightPanelEtaSnapshot {
  status: RightPanelEtaStatus;
  remainingSec: number | null;
  elapsedSec?: number | null;
  estimatedTotalSec?: number | null;
  confidence?: "low" | "medium" | "high" | null;
  terminalOk?: boolean | null;
  basis?: string;
  updatedAt?: string;
}

/** One model/harness-authored revision of the session's current objective. */
export interface RightPanelGoalRevision {
  revision: number;
  text: string;
  source?: string;
  reason?: string;
  updatedAt?: string;
  stage?: number | null;
  stageCount?: number | null;
  plannedStages?: number | null;
}

export function formatRightPanelDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}

export function rightPanelEtaLabel(
  eta: RightPanelEtaSnapshot | undefined,
): string {
  if (!eta) return "";
  const elapsed = eta.elapsedSec;
  const total = eta.estimatedTotalSec;
  const totalSuffix =
    total != null && Number.isFinite(total)
      ? ` · total ~${formatRightPanelDuration(total)}`
      : "";
  if (eta.status === "complete") {
    const duration =
      total != null && Number.isFinite(total)
        ? ` · ${formatRightPanelDuration(total)} total`
        : "";
    return eta.terminalOk === false
      ? `Finished with errors${duration}`
      : `Done${duration}`;
  }
  if (
    eta.status === "waiting"
    && eta.remainingSec != null
    && Number.isFinite(eta.remainingSec)
  ) {
    return `ETA ~${formatRightPanelDuration(eta.remainingSec)}${totalSuffix} · waiting`;
  }
  if (eta.status === "waiting") {
    return elapsed != null && Number.isFinite(elapsed)
      ? `Elapsed ${formatRightPanelDuration(elapsed)} · ETA waiting`
      : "ETA waiting";
  }
  if (
    eta.status === "unavailable"
    || eta.remainingSec == null
    || !Number.isFinite(eta.remainingSec)
  ) {
    return elapsed != null && Number.isFinite(elapsed)
      ? `Elapsed ${formatRightPanelDuration(elapsed)} · ETA calibrating`
      : "ETA estimating";
  }
  return `ETA ~${formatRightPanelDuration(eta.remainingSec)}${totalSuffix}`;
}
