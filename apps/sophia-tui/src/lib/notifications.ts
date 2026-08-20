import stringWidth from "string-width";

import type {
  NotificationOscProtocol,
  TerminalCapabilities,
} from "./terminalCapabilities.js";

const ESC = "\x1b";
const BEL = "\x07";
const DEFAULT_MAX_TEXT = 180;

export type NotificationKind = "info" | "success" | "warning" | "error";
export type NotificationChannel = "off" | "toast" | "bell" | "osc" | "auto";
export type DeliveredNotificationChannel = "none" | "toast" | "bell" | "osc";

export interface NotificationRequest {
  id?: string;
  kind: NotificationKind;
  title: string;
  body?: string;
}

export interface NotificationSettings {
  /** Master setting. Off by default. */
  enabled: boolean;
  channel: NotificationChannel;
  /** External terminal effects still require detected capabilities. */
  allowBell: boolean;
  allowOsc: boolean;
  /** External effects are suppressed for screen readers unless explicitly set. */
  allowExternalInScreenReader: boolean;
  /** Avoid background alerts while the terminal already has attention. */
  notifyWhenFocused: boolean;
  /** Keep a local, non-animated receipt when an external effect is emitted. */
  showToast: boolean;
  minimumIntervalMs: number;
  maxTextLength: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: Readonly<NotificationSettings> = Object.freeze({
  enabled: false,
  channel: "off",
  allowBell: true,
  allowOsc: true,
  allowExternalInScreenReader: false,
  notifyWhenFocused: false,
  showToast: true,
  minimumIntervalMs: 3_000,
  maxTextLength: DEFAULT_MAX_TEXT,
});

export interface NotificationContext {
  focused?: boolean;
  now?: number;
  lastDeliveredAt?: number | null;
}

export type NotificationPlanReason =
  | "disabled"
  | "focused"
  | "rate-limited"
  | "toast"
  | "bell"
  | "osc"
  | "capability-fallback"
  | "screen-reader-fallback";

export interface NotificationPlan {
  request: NotificationRequest;
  channel: DeliveredNotificationChannel;
  reason: NotificationPlanReason;
  showToast: boolean;
  sequence: string | null;
  deliveredAt: number | null;
}

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return undefined;
}

function notificationChannel(value: string | undefined): NotificationChannel | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (["off", "toast", "bell", "osc", "auto"].includes(normalized)) {
    return normalized as NotificationChannel;
  }
  return undefined;
}

export function resolveNotificationSettings(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<NotificationSettings> = {},
): NotificationSettings {
  const envChannel =
    notificationChannel(env.SOPHIA_NOTIFICATION_MODE) ??
    (envBoolean(env.SOPHIA_NOTIFICATIONS) ? "auto" : undefined);
  const channel = overrides.channel ?? envChannel ?? DEFAULT_NOTIFICATION_SETTINGS.channel;
  const enabled =
    overrides.enabled ??
    envBoolean(env.SOPHIA_NOTIFICATIONS) ??
    (envChannel !== undefined && envChannel !== "off");
  const interval = Number(env.SOPHIA_NOTIFICATION_INTERVAL_MS);
  const maxText = Number(env.SOPHIA_NOTIFICATION_MAX_TEXT);

  return {
    enabled: enabled && channel !== "off",
    channel,
    allowBell:
      overrides.allowBell ??
      envBoolean(env.SOPHIA_NOTIFICATION_BELL) ??
      DEFAULT_NOTIFICATION_SETTINGS.allowBell,
    allowOsc:
      overrides.allowOsc ??
      envBoolean(env.SOPHIA_NOTIFICATION_OSC_ENABLED) ??
      DEFAULT_NOTIFICATION_SETTINGS.allowOsc,
    allowExternalInScreenReader:
      overrides.allowExternalInScreenReader ??
      envBoolean(env.SOPHIA_NOTIFICATION_SCREEN_READER_EXTERNAL) ??
      DEFAULT_NOTIFICATION_SETTINGS.allowExternalInScreenReader,
    notifyWhenFocused:
      overrides.notifyWhenFocused ??
      envBoolean(env.SOPHIA_NOTIFICATION_WHEN_FOCUSED) ??
      DEFAULT_NOTIFICATION_SETTINGS.notifyWhenFocused,
    showToast:
      overrides.showToast ??
      envBoolean(env.SOPHIA_NOTIFICATION_TOAST) ??
      DEFAULT_NOTIFICATION_SETTINGS.showToast,
    minimumIntervalMs:
      overrides.minimumIntervalMs ??
      (Number.isFinite(interval) && interval >= 0
        ? Math.floor(interval)
        : DEFAULT_NOTIFICATION_SETTINGS.minimumIntervalMs),
    maxTextLength:
      overrides.maxTextLength ??
      (Number.isFinite(maxText) && maxText > 0
        ? Math.floor(maxText)
        : DEFAULT_NOTIFICATION_SETTINGS.maxTextLength),
  };
}

/**
 * Remove terminal controls and bidi overrides before text enters a toast or
 * OSC payload. Whitespace is flattened because desktop notifications are
 * single compact messages on many platforms.
 */
export function sanitizeNotificationText(text: string, maxLength = DEFAULT_MAX_TEXT): string {
  const safeMax = Number.isFinite(maxLength) ? Math.max(1, Math.floor(maxLength)) : DEFAULT_MAX_TEXT;
  const clean = text
    .replace(
      // CSI, OSC, DCS, PM and APC sequences, including BEL/ST terminators.
      /(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\|\x1b\^[\s\S]*?\x1b\\|\x1b_[\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~])/g,
      " ",
    )
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return graphemes(clean).slice(0, safeMax).join("");
}

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

export function truncateTerminalText(
  text: string,
  maxColumns: number,
  ellipsis = "…",
): string {
  const width = Number.isFinite(maxColumns) ? Math.max(0, Math.floor(maxColumns)) : 0;
  if (width === 0) return "";
  if (stringWidth(text) <= width) return text;

  const suffix = stringWidth(ellipsis) <= width ? ellipsis : "";
  const budget = Math.max(0, width - stringWidth(suffix));
  let result = "";
  for (const unit of graphemes(text)) {
    if (stringWidth(result + unit) > budget) break;
    result += unit;
  }
  return result + suffix;
}

function oscField(text: string, maxLength: number): string {
  // Semicolons delimit OSC 777 fields; replacing rather than escaping keeps a
  // payload unable to create extra protocol fields.
  return sanitizeNotificationText(text, maxLength).replace(/;/g, ",");
}

export function buildOscNotification(
  protocol: NotificationOscProtocol,
  request: NotificationRequest,
  maxTextLength = DEFAULT_MAX_TEXT,
): string {
  const title = oscField(request.title, maxTextLength);
  const body = oscField(request.body ?? "", maxTextLength);
  const message = body ? `${title}: ${body}` : title;
  if (protocol === "osc9") return `${ESC}]9;${message}${BEL}`;
  return `${ESC}]777;notify;${title};${body}${BEL}`;
}

function normalizedRequest(
  request: NotificationRequest,
  maxTextLength: number,
): NotificationRequest {
  return {
    ...request,
    title: sanitizeNotificationText(request.title, maxTextLength) || "Sophia",
    body: sanitizeNotificationText(request.body ?? "", maxTextLength),
  };
}

function noDelivery(
  request: NotificationRequest,
  reason: NotificationPlanReason,
): NotificationPlan {
  return {
    request,
    channel: "none",
    reason,
    showToast: false,
    sequence: null,
    deliveredAt: null,
  };
}

/**
 * Pure notification policy. Bell/OSC are impossible unless all three are true:
 * notifications are enabled, the selected channel permits the effect, and the
 * capability detector reports support. Unsupported explicit channels fall
 * back to a local toast rather than writing speculative control sequences.
 */
export function planNotification(
  request: NotificationRequest,
  capabilities: TerminalCapabilities,
  settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS },
  context: NotificationContext = {},
): NotificationPlan {
  const clean = normalizedRequest(request, settings.maxTextLength);
  if (!settings.enabled || settings.channel === "off") return noDelivery(clean, "disabled");
  if (context.focused && !settings.notifyWhenFocused) return noDelivery(clean, "focused");

  const now = context.now ?? Date.now();
  if (
    context.lastDeliveredAt !== undefined &&
    context.lastDeliveredAt !== null &&
    now - context.lastDeliveredAt < settings.minimumIntervalMs
  ) {
    return noDelivery(clean, "rate-limited");
  }

  const externalAllowed =
    !capabilities.accessibility.screenReader || settings.allowExternalInScreenReader;
  const oscAvailable =
    externalAllowed &&
    settings.allowOsc &&
    capabilities.notifications &&
    capabilities.notificationProtocol !== null;
  const bellAvailable = externalAllowed && settings.allowBell && capabilities.bell;

  let channel: DeliveredNotificationChannel;
  let reason: NotificationPlanReason;
  if (settings.channel === "toast") {
    channel = "toast";
    reason = "toast";
  } else if (settings.channel === "osc" && oscAvailable) {
    channel = "osc";
    reason = "osc";
  } else if (settings.channel === "bell" && bellAvailable) {
    channel = "bell";
    reason = "bell";
  } else if (settings.channel === "auto" && oscAvailable) {
    channel = "osc";
    reason = "osc";
  } else if (settings.channel === "auto" && bellAvailable) {
    channel = "bell";
    reason = "bell";
  } else {
    channel = "toast";
    reason = capabilities.accessibility.screenReader
      ? "screen-reader-fallback"
      : "capability-fallback";
  }

  const sequence =
    channel === "bell"
      ? BEL
      : channel === "osc" && capabilities.notificationProtocol
        ? buildOscNotification(capabilities.notificationProtocol, clean, settings.maxTextLength)
        : null;

  return {
    request: clean,
    channel,
    reason,
    showToast: channel === "toast" || settings.showToast,
    sequence,
    deliveredAt: now,
  };
}

export interface NotificationDispatchResult {
  ok: boolean;
  wrote: boolean;
  reason: string;
}

export function dispatchTerminalNotification(
  plan: NotificationPlan,
  stream: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean } = process.stdout,
): NotificationDispatchResult {
  if (!plan.sequence) return { ok: true, wrote: false, reason: "no terminal effect planned" };
  if (stream.isTTY === false) return { ok: false, wrote: false, reason: "stdout is not a TTY" };
  try {
    stream.write(plan.sequence);
    return { ok: true, wrote: true, reason: plan.channel };
  } catch {
    return { ok: false, wrote: false, reason: "terminal notification write failed" };
  }
}

export function notificationAnnouncement(request: NotificationRequest): string {
  const title = sanitizeNotificationText(request.title) || "Sophia";
  const body = sanitizeNotificationText(request.body ?? "");
  return body ? `Notification: ${title}. ${body}` : `Notification: ${title}`;
}
