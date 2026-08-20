import { resolveAccessibility, type AccessibilityPrefs } from "./accessibility.js";

export type TerminalPlatform = "macos" | "windows" | "linux" | "other";
export type TerminalColorLevel = "none" | "ansi16" | "ansi256" | "truecolor";
export type TerminalWidthClass = "narrow" | "compact" | "standard" | "wide";
export type NotificationOscProtocol = "osc9" | "osc777";

export interface TerminalAccessibilityPreferences extends AccessibilityPrefs {
  /**
   * Restrict presentation to a small semantic palette and always pair colour
   * with words or glyphs. Screen-reader mode implies low-colour presentation.
   */
  lowColor: boolean;
}

export interface TerminalCapabilities {
  platform: TerminalPlatform;
  isTTY: boolean;
  isRemote: boolean;
  term: string;
  columns: number;
  widthClass: TerminalWidthClass;
  color: boolean;
  colorLevel: TerminalColorLevel;
  unicode: boolean;
  hyperlinks: boolean;
  mouse: boolean;
  clipboard: boolean;
  notifications: boolean;
  notificationProtocol: NotificationOscProtocol | null;
  bell: boolean;
  accessibility: TerminalAccessibilityPreferences;
  /**
   * Stable, terminal-brand-neutral diagnostics suitable for `/doctor`.
   * These describe inputs and degradations, not guarantees about a terminal.
   */
  evidence: string[];
}

export interface TerminalCapabilityProbe {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  isTTY?: boolean;
  columns?: number;
  accessibility?: Partial<TerminalAccessibilityPreferences>;
}

export const TERMINAL_WIDTH_BREAKPOINTS = Object.freeze({
  narrowMax: 47,
  compactMax: 79,
  standardMax: 119,
});

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function booleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const valueLower = normalized(value);
  if (["1", "true", "yes", "on", "enable", "enabled"].includes(valueLower)) return true;
  if (["0", "false", "no", "off", "disable", "disabled"].includes(valueLower)) return false;
  return undefined;
}

function envBoolean(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  return booleanValue(env[key]);
}

function featureTokens(env: NodeJS.ProcessEnv): Set<string> {
  const raw = [env.SOPHIA_TERMINAL_CAPABILITIES, env.TERM_FEATURES]
    .filter((value): value is string => Boolean(value))
    .join(",");
  return new Set(
    raw
      .split(/[\s,;]+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function tokenEnabled(tokens: Set<string>, names: readonly string[]): boolean | undefined {
  for (const name of names) {
    if (tokens.has(`-${name}`) || tokens.has(`no-${name}`)) return false;
  }
  for (const name of names) {
    if (tokens.has(name)) return true;
  }
  return undefined;
}

function capabilityFlag(
  env: NodeJS.ProcessEnv,
  tokens: Set<string>,
  envKey: string,
  tokenNames: readonly string[],
  fallback: boolean,
): boolean {
  return envBoolean(env, envKey) ?? tokenEnabled(tokens, tokenNames) ?? fallback;
}

export function detectTerminalPlatform(
  platform: NodeJS.Platform | string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalPlatform {
  const platformName = normalized(platform);
  const osName = normalized(env.OS);
  const osType = normalized(env.OSTYPE);

  if (platformName === "darwin" || osType.startsWith("darwin")) return "macos";
  if (platformName === "win32" || osName === "windows_nt" || osType.startsWith("msys")) {
    return "windows";
  }
  if (
    platformName === "linux" ||
    osType.startsWith("linux") ||
    Boolean(env.WSL_DISTRO_NAME)
  ) {
    return "linux";
  }
  return "other";
}

export function terminalWidthClass(columns: number): TerminalWidthClass {
  const safeColumns = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  if (safeColumns <= TERMINAL_WIDTH_BREAKPOINTS.narrowMax) return "narrow";
  if (safeColumns <= TERMINAL_WIDTH_BREAKPOINTS.compactMax) return "compact";
  if (safeColumns <= TERMINAL_WIDTH_BREAKPOINTS.standardMax) return "standard";
  return "wide";
}

export function resolveTerminalAccessibility(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<TerminalAccessibilityPreferences> = {},
): TerminalAccessibilityPreferences {
  const inherited = resolveAccessibility([], env);
  const screenReader = overrides.screenReader ?? inherited.screenReader;
  const reducedMotion =
    screenReader ||
    (overrides.reducedMotion ??
      inherited.reducedMotion ??
      envBoolean(env, "SOPHIA_REDUCED_MOTION") ??
      false);
  const lowColor =
    screenReader ||
    (overrides.lowColor ??
      envBoolean(env, "SOPHIA_LOW_COLOR") ??
      envBoolean(env, "SOPHIA_REDUCED_COLOR") ??
      false);

  return { screenReader, reducedMotion, lowColor };
}

function explicitColorLevel(value: string | undefined): TerminalColorLevel | undefined {
  const color = normalized(value);
  if (!color || color === "auto") return undefined;
  if (["0", "off", "none", "false"].includes(color)) return "none";
  if (["1", "on", "basic", "16", "ansi", "ansi16", "true"].includes(color)) return "ansi16";
  if (["2", "256", "ansi256"].includes(color)) return "ansi256";
  if (["3", "24bit", "truecolor", "millions"].includes(color)) return "truecolor";
  return undefined;
}

function detectColorLevel(
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
  accessibility: TerminalAccessibilityPreferences,
): TerminalColorLevel {
  if (accessibility.screenReader) return "none";
  if ((env.NO_COLOR ?? "") !== "") return "none";

  const sophiaColor = explicitColorLevel(env.SOPHIA_COLOR);
  if (sophiaColor) {
    if (accessibility.lowColor && sophiaColor !== "none") return "ansi16";
    return sophiaColor;
  }

  const forcedColor = explicitColorLevel(env.FORCE_COLOR);
  if (forcedColor === "none") return "none";
  if (!isTTY && forcedColor === undefined) return "none";
  if (normalized(env.TERM) === "dumb") return "none";
  if (accessibility.lowColor) return "ansi16";
  if (forcedColor) return forcedColor;

  const colorTerm = normalized(env.COLORTERM);
  if (colorTerm.includes("truecolor") || colorTerm.includes("24bit")) return "truecolor";
  if (normalized(env.TERM).includes("256color")) return "ansi256";
  return isTTY ? "ansi16" : "none";
}

function localeSupportsUnicode(env: NodeJS.ProcessEnv, platform: TerminalPlatform): boolean {
  const locale = normalized(env.LC_ALL || env.LC_CTYPE || env.LANG);
  if (locale === "c" || locale === "posix") return false;
  if (locale.includes("utf-8") || locale.includes("utf8")) return true;
  // Unix terminals are normally UTF-8 even when a launcher omits locale vars.
  // Windows has multiple active console encodings, so an absent declaration
  // stays conservative there and can be overridden with SOPHIA_UNICODE=1.
  return platform !== "windows";
}

function detectNotificationProtocol(
  env: NodeJS.ProcessEnv,
  tokens: Set<string>,
): NotificationOscProtocol | null {
  const declared = normalized(env.SOPHIA_NOTIFICATION_OSC);
  if (declared === "9" || declared === "osc9") return "osc9";
  if (declared === "777" || declared === "osc777") return "osc777";
  if (tokens.has("notify-osc9") || tokens.has("notification-osc9")) return "osc9";
  if (tokens.has("notify-osc777") || tokens.has("notification-osc777")) return "osc777";
  return null;
}

/**
 * Detect only generic terminal protocols and explicit declarations. This does
 * not maintain a list of terminal brands, versions, or proprietary products:
 * uncertain protocols (OSC 8, OSC 52, notification OSC) remain off until the
 * environment or Sophia settings declare them.
 */
export function detectTerminalCapabilities(
  probe: TerminalCapabilityProbe = {},
): TerminalCapabilities {
  const env = probe.env ?? process.env;
  const isTTY = probe.isTTY ?? Boolean(process.stdout.isTTY);
  const platform = detectTerminalPlatform(probe.platform ?? process.platform, env);
  const accessibility = resolveTerminalAccessibility(env, probe.accessibility);
  const tokens = featureTokens(env);
  const term = env.TERM ?? "";
  const dumb = normalized(term) === "dumb";
  const usableTTY = isTTY && !dumb;
  const columnsRaw = probe.columns ?? process.stdout.columns ?? 80;
  const columns =
    Number.isFinite(columnsRaw) && columnsRaw > 0 ? Math.floor(columnsRaw) : 80;
  const colorLevel = detectColorLevel(env, isTTY, accessibility);

  const unicodeOverride =
    envBoolean(env, "SOPHIA_UNICODE") ?? tokenEnabled(tokens, ["unicode", "utf8"]);
  const unicode =
    !accessibility.screenReader &&
    usableTTY &&
    (unicodeOverride ?? localeSupportsUnicode(env, platform));

  const hyperlinks =
    !accessibility.screenReader &&
    usableTTY &&
    capabilityFlag(env, tokens, "SOPHIA_HYPERLINKS", ["hyperlinks", "osc8"], false);
  const mouse =
    !accessibility.screenReader &&
    usableTTY &&
    capabilityFlag(env, tokens, "SOPHIA_MOUSE", ["mouse", "sgr-mouse"], true);
  const clipboard =
    usableTTY &&
    capabilityFlag(env, tokens, "SOPHIA_CLIPBOARD", ["clipboard", "osc52"], false);
  const notificationProtocol = detectNotificationProtocol(env, tokens);
  const notifications =
    usableTTY &&
    notificationProtocol !== null &&
    capabilityFlag(
      env,
      tokens,
      "SOPHIA_NOTIFICATION_CAPABLE",
      ["notifications", "notification"],
      true,
    );
  const bell =
    usableTTY &&
    capabilityFlag(env, tokens, "SOPHIA_BELL", ["bell", "audible-bell"], true);

  const evidence = [
    `platform:${platform}`,
    `tty:${isTTY ? "yes" : "no"}`,
    `term:${term || "unset"}`,
    `width:${columns}/${terminalWidthClass(columns)}`,
    `color:${colorLevel}`,
  ];
  if (accessibility.screenReader) evidence.push("screen-reader:protocol-chrome-disabled");
  if (accessibility.reducedMotion) evidence.push("motion:reduced");
  if (accessibility.lowColor) evidence.push("color:reduced");
  if (notificationProtocol) evidence.push(`notification:${notificationProtocol}`);
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) evidence.push("transport:remote");

  return {
    platform,
    isTTY,
    isRemote: Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT),
    term,
    columns,
    widthClass: terminalWidthClass(columns),
    color: colorLevel !== "none",
    colorLevel,
    unicode,
    hyperlinks,
    mouse,
    clipboard,
    notifications,
    notificationProtocol: notifications ? notificationProtocol : null,
    bell,
    accessibility,
    evidence,
  };
}
