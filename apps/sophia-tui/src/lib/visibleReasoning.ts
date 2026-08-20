/**
 * Provider-visible reasoning policy for the transcript.
 *
 * `hidden` fails closed: no thinking rows. `summary` / `stream` / `full` show
 * live `thinking_token` chunks and completed `thinking` events that carry
 * text. `full` has no character cap. This never invents text. AGI session-flow
 * chrome still omits raw thinking tokens.
 */
import {
  createStreamGrowth,
  pushStreamGrowth,
  type StreamGrowthState,
} from "./streamGrowth.js";

export type ThinkingVisibility = "hidden" | "summary" | "stream" | "full";

export interface ProviderVisibleReasoningSource {
  provider: string;
  model: string;
}

export interface ProviderReasoningScope {
  /** Stable routing key. It is never rendered. */
  key: string;
  /** Bounded, control-character-free label safe for transcript metadata. */
  label: string;
}

const MAX_SCOPE_SEGMENTS = 12;
const MAX_SCOPE_SEGMENT_CHARS = 64;

function boundedScopeSegment(value: unknown, fallback = ""): string {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_")
    .slice(0, MAX_SCOPE_SEGMENT_CHARS) || fallback;
}

/**
 * Route provider-visible chunks by their bridge correlation envelope. Team
 * lanes share callbacks, so run-wide buffering would splice independently
 * published `thought` records together according to thread scheduling.
 */
export function providerReasoningScope(
  event: Readonly<Record<string, unknown>>,
  fallbackRunId = "",
): ProviderReasoningScope {
  const runId = boundedScopeSegment(event.runId ?? fallbackRunId, "unscoped");
  const path = (Array.isArray(event.path) ? event.path : [])
    .slice(0, MAX_SCOPE_SEGMENTS)
    .map((part) => boundedScopeSegment(part))
    .filter(Boolean);
  const lane = boundedScopeSegment(event.lane);
  const route = path.length > 0 ? path : lane ? [lane] : [];
  const labelParts = [
    route.length > 0 ? `path ${route.join("/")}` : "main",
    lane && route.at(-1) !== lane ? `lane ${lane}` : "",
  ].filter(Boolean);
  return {
    key: JSON.stringify([runId, route, lane]),
    label: labelParts.join(" · ").slice(0, 180),
  };
}

const VISIBLE_REASONING_LIMITS: Readonly<Record<ThinkingVisibility, number>> = {
  hidden: 0,
  summary: 240,
  stream: 800,
  // Operator-requested full live chain-of-thought. 0 means no display cap.
  full: 0,
};

export function parseThinkingVisibility(value: unknown): ThinkingVisibility | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "hidden"
    || normalized === "summary"
    || normalized === "stream"
    || normalized === "full"
    ? normalized
    : null;
}

/**
 * Establish the source of subsequent thinking-token events from a safe
 * provider-progress envelope. Unknown providers fail closed.
 */
export function providerVisibleReasoningSource(
  event: Readonly<Record<string, unknown>>,
): ProviderVisibleReasoningSource | null {
  if (String(event.type || "") !== "provider_progress") return null;
  if (String(event.provider || "").trim().toLowerCase() !== "grok") return null;
  return {
    provider: "grok",
    model: String(event.model || "").trim().slice(0, 120),
  };
}

/** Grok preflight is emitted once at the start of each paid model call. */
export function providerVisibleReasoningCallStarted(
  event: Readonly<Record<string, unknown>>,
): boolean {
  return providerVisibleReasoningSource(event) !== null
    && String(event.phase || "").trim().toLowerCase() === "preflight"
    && String(event.status || "").trim().toLowerCase() === "in_progress";
}

/**
 * Completed `thinking` events need text. A missing provider is labelled
 * `model` so live chain-of-thought still paints when visibility is not hidden.
 */
export function providerReportedReasoningSource(
  event: Readonly<Record<string, unknown>>,
): ProviderVisibleReasoningSource | null {
  if (String(event.type || "") !== "thinking") return null;
  const text = typeof event.text === "string" ? event.text : "";
  if (!text) return null;
  const provider = String(event.provider || "").trim().slice(0, 120) || "model";
  return {
    provider,
    model: String(event.model || "").trim().slice(0, 120),
  };
}

export function sameProviderVisibleReasoningSource(
  left: ProviderVisibleReasoningSource | null | undefined,
  right: ProviderVisibleReasoningSource | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.provider.trim().toLowerCase() === right.provider.trim().toLowerCase()
    && left.model.trim().toLowerCase() === right.model.trim().toLowerCase();
}

/**
 * Make a completed provider report the authoritative base for any later
 * chunks in the same call. Without this, the older live accumulator can
 * resurrect text that the completed report replaced.
 */
export function settledProviderReasoningGrowth(
  text: string,
  now: number,
): StreamGrowthState {
  if (!text) return createStreamGrowth();
  return pushStreamGrowth(createStreamGrowth(), text, now).state;
}

/** Apply the operator-selected display bound to provider-visible event text. */
export function boundedProviderVisibleReasoning(
  text: string,
  visibility: ThinkingVisibility,
): string {
  if (!text) return "";
  if (visibility === "hidden") return "";
  const cap = VISIBLE_REASONING_LIMITS[visibility];
  if (visibility === "full" || cap <= 0) return text;
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… [provider-visible thinking truncated for ${visibility} mode]`;
}

export function liveThinkingTokensVisible(visibility: ThinkingVisibility): boolean {
  return visibility !== "hidden";
}

/** Live thinking_token source. Does not invent text. */
export function liveThinkingTokenSource(
  event: Readonly<Record<string, unknown>>,
  authorized: ProviderVisibleReasoningSource | null = null,
): ProviderVisibleReasoningSource | null {
  const text = typeof event.text === "string"
    ? event.text
    : typeof event.token === "string"
      ? event.token
      : "";
  if (!text) return null;
  if (authorized) return authorized;
  const provider = String(event.provider || "").trim().slice(0, 120) || "model";
  return {
    provider,
    model: String(event.model || "").trim().slice(0, 120),
  };
}

export function providerVisibleReasoningMeta(
  source: ProviderVisibleReasoningSource,
  scope?: ProviderReasoningScope,
): string {
  return [
    "provider-visible",
    `${source.provider}${source.model ? `:${source.model}` : ""}`,
    scope?.label || "",
  ].filter(Boolean).join(" · ");
}
