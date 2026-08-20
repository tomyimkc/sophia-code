export type ConscienceMode = "off" | "report" | "floor" | "strict";

export interface ConscienceCommandResult {
  ok: boolean;
  mode: ConscienceMode;
  changed: boolean;
  text: string;
  status: string;
}

/** Parse a persisted/bridge value without guessing on unknown input. */
export function conscienceModeFromBridge(value: unknown): ConscienceMode | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "strict" || raw === "on") return "strict";
  if (raw === "report" || raw === "advisory") return "report";
  if (raw === "default") return "off";
  if (raw === "floor" || raw === "hard-floor") return "floor";
  if (raw === "off") return "off";
  return null;
}

export function conscienceDeliverySummary(mode: ConscienceMode): string {
  if (mode === "off") return "off (no final-text gate)";
  if (mode === "report") return "advisory (checks never withhold)";
  if (mode === "floor") return "hard-floor enforcement";
  return "strict provenance enforcement";
}

function statusLines(mode: ConscienceMode): string[] {
  const common = [
    `Conscience mode: ${mode}`,
    `delivery policy: ${conscienceDeliverySummary(mode)}`,
  ];
  if (mode === "off") {
    return [
      ...common,
      "final-text conscience/provenance evaluation: off",
      "Tool permissions, candidateOnly:true, and canClaimAGI:false remain unchanged.",
    ];
  }
  if (mode === "report") {
    return [
      ...common,
      "final-text conscience/provenance evaluation: on",
      "Verdicts and evaluator errors are reported, but the completed answer is delivered unchanged.",
    ];
  }
  if (mode === "floor") {
    return [
      ...common,
      "hard-prohibition floor: enforced",
      "epistemic/provenance uncertainty tier: evaluated but not enforced",
    ];
  }
  return [
    ...common,
    "hard-prohibition floor: enforced",
    "epistemic/provenance uncertainty tier: enforced; held answers are replaced by a situation report.",
  ];
}

/** Resolve `/conscience off|report|floor|strict|status`. */
export function resolveConscienceCommand(
  args: string,
  current: ConscienceMode,
): ConscienceCommandResult {
  const action = args.trim().toLowerCase();
  if (!action || action === "status") {
    return {
      ok: true,
      mode: current,
      changed: false,
      text: statusLines(current).join("\n"),
      status: `Conscience ${current}`,
    };
  }
  const mode = conscienceModeFromBridge(action);
  if (mode && ["off", "report", "floor", "strict"].includes(mode)) {
    return {
      ok: true,
      mode,
      changed: current !== mode,
      text: statusLines(mode).join("\n"),
      status: `Conscience ${mode}`,
    };
  }
  return {
    ok: false,
    mode: current,
    changed: false,
    text: "usage: /conscience off|report|floor|strict|status",
    status: "invalid Conscience mode",
  };
}
