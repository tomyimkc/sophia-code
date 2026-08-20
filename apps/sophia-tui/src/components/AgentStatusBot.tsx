import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { accessibleTheme, type AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import type { Theme } from "../lib/theme.js";

export type AgentBotState =
  | "idle"
  | "queued"
  | "working"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unstarted";

export interface AgentBotPresentation {
  face: string;
  label: string;
}

const BOT_FRAMES: Record<AgentBotState, readonly string[]> = {
  idle: ["[._.]"],
  queued: ["[._.]", "[.._]", "[._.]", "[_..]"],
  working: ["[o_o]", "[o>o]", "[o_o]", "[o<o]"],
  waiting: ["[-_-]", "[._.]", "[-_-]", "[._.]"],
  succeeded: ["[^_^]"],
  failed: ["[x_x]"],
  cancelled: ["[-x-]"],
  unstarted: ["[?_?]"],
};

const BOT_LABELS: Record<AgentBotState, string> = {
  idle: "idle",
  queued: "queued",
  working: "working",
  waiting: "waiting",
  succeeded: "done",
  failed: "failed",
  cancelled: "cancelled",
  unstarted: "unstarted",
};

const WORKING_STATUSES = new Set([
  "active",
  "spawning",
  "starting",
  "running",
  "working",
  "verifying",
  "cancelling",
]);

const WAITING_STATUSES = new Set([
  "blocked",
  "interrupted",
  "waiting",
  "waiting_input",
  "auth_required",
  "input_required",
  "awaiting_input",
]);

const FAILED_STATUSES = new Set([
  "failed",
  "timed_out",
  "lost",
  "needs_reconciliation",
]);

const UNSTARTED_STATUSES = new Set([
  "unstarted",
  "never_started",
  "not_started",
  "unknown",
]);

const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "skipped"]);

/**
 * Normalize backend-specific lifecycle vocabulary into the seven visual states
 * used by the compact and expanded agent panels.
 */
export function agentBotState(
  status: string,
  active = false,
): AgentBotState {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized || UNSTARTED_STATUSES.has(normalized)) return "unstarted";
  if (FAILED_STATUSES.has(normalized)) return "failed";
  if (CANCELLED_STATUSES.has(normalized)) return "cancelled";
  if (normalized === "succeeded" || normalized === "completed") {
    return "succeeded";
  }
  if (active || WORKING_STATUSES.has(normalized)) return "working";
  if (WAITING_STATUSES.has(normalized)) return "waiting";
  if (normalized === "queued" || normalized === "queued_for_model") {
    return "queued";
  }
  if (normalized === "idle") return "idle";
  return "unstarted";
}

/**
 * Pure frame projection shared by the Ink component and tests. Screen-reader
 * and reduced-motion modes never churn the face.
 */
export function agentBotPresentation(
  state: AgentBotState,
  frame: number,
  prefs: AccessibilityPrefs,
): AgentBotPresentation {
  const frames = BOT_FRAMES[state];
  const index = prefs.reducedMotion ? 0 : Math.abs(Math.floor(frame)) % frames.length;
  return {
    face: prefs.screenReader ? "" : frames[index] || frames[0] || "[._.]",
    label: BOT_LABELS[state],
  };
}

export function agentBotColor(state: AgentBotState, theme: Theme): string {
  if (state === "working") return theme.accent;
  if (state === "waiting") return theme.warn;
  if (state === "succeeded") return theme.success;
  if (state === "failed" || state === "cancelled" || state === "unstarted") {
    return theme.error;
  }
  return theme.dim;
}

/** One shared animation clock can drive every bot in a panel. */
export function useAgentBotFrame(
  active: boolean,
  intervalMs = 240,
): number {
  const prefs = useAccessibility();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active || prefs.reducedMotion || prefs.screenReader) {
      setFrame(0);
      return;
    }
    const timer = setInterval(() => setFrame((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, prefs.reducedMotion, prefs.screenReader]);
  return frame;
}

export function AgentStatusBot({
  status,
  active = false,
  theme,
  frame = 0,
  showLabel = true,
}: {
  status: string;
  active?: boolean;
  theme: Theme;
  frame?: number;
  showLabel?: boolean;
}): React.ReactElement {
  const prefs = useAccessibility();
  const t = accessibleTheme(theme, prefs);
  const state = agentBotState(status, active);
  const presentation = agentBotPresentation(state, frame, prefs);
  const text = [
    presentation.face,
    showLabel ? presentation.label : "",
  ].filter(Boolean).join(" ");
  return (
    <Text color={agentBotColor(state, t)} bold={state === "working"}>
      {text}
    </Text>
  );
}
