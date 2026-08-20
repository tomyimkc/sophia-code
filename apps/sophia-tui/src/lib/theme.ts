/**
 * Sophia-native terminal theme tokens.
 * Dark charcoal + warm accent + semantic colors for Ink.
 */
export type ThemeName = "dark" | "light" | "mono";

export interface Theme {
  name: ThemeName;
  text: string;
  dim: string;
  accent: string;
  success: string;
  warn: string;
  error: string;
  tool: string;
  thinking: string;
  user: string;
  border: string;
}

const dark: Theme = {
  name: "dark",
  text: "whiteBright",
  dim: "gray",
  accent: "yellow", // warm stand-in for peach (Ink 16-color)
  success: "green",
  warn: "yellow",
  error: "red",
  tool: "cyan",
  thinking: "magenta",
  user: "blueBright",
  border: "gray",
};

const light: Theme = {
  name: "light",
  text: "black",
  dim: "gray",
  accent: "red",
  success: "green",
  warn: "yellow",
  error: "red",
  tool: "blue",
  thinking: "magenta",
  user: "blue",
  border: "gray",
};

// Empty strings, not "white": the components pass these to Ink's `color` prop,
// and an empty value emits no ANSI code at all. Setting every role to "white"
// still wrote colour — invisible on a light background, and not what NO_COLOR
// asks for. agent/tui_theme.py's mono theme already did it this way; the TUI
// was the one out of step.
const mono: Theme = {
  name: "mono",
  text: "",
  dim: "",
  accent: "",
  success: "",
  warn: "",
  error: "",
  tool: "",
  thinking: "",
  user: "",
  border: "",
};

const THEMES: Record<ThemeName, Theme> = { dark, light, mono };

/** True when the environment asks for no colour, per the NO_COLOR convention. */
export function colorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // https://no-color.org — any non-empty value means "do not emit colour".
  if ((env.NO_COLOR ?? "") !== "") return true;
  if ((env.TERM ?? "").toLowerCase() === "dumb") return true;
  return false;
}

export function resolveTheme(name?: string | null, env: NodeJS.ProcessEnv = process.env): Theme {
  // An explicit NO_COLOR wins over a themed preference: it is an accessibility
  // signal, not a style one.
  if (colorDisabled(env)) return mono;
  const n = (name || env.SOPHIA_THEME || "dark").toLowerCase();
  if (n === "light") return light;
  if (n === "mono" || n === "off" || n === "none") return mono;
  return dark;
}

export function listThemes(): ThemeName[] {
  return Object.keys(THEMES) as ThemeName[];
}
