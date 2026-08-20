import type { ResponseStyle } from "./pickers.js";

const RESPONSE_STYLES = new Set<ResponseStyle>([
  "adaptive",
  "concise",
  "explanatory",
  "structured",
]);

export function normalizeResponseStyle(value: unknown): ResponseStyle | null {
  const normalized = String(value ?? "").trim().toLowerCase() as ResponseStyle;
  return RESPONSE_STYLES.has(normalized) ? normalized : null;
}

export type ResponseStyleCommand =
  | { kind: "picker" }
  | { kind: "apply"; responseStyle: ResponseStyle }
  | { kind: "error"; value: string };

/** Parse only response-style commands; unrelated commands are deliberately untouched. */
export function parseResponseStyleCommand(input: string): ResponseStyleCommand | null {
  const match = /^\s*\/(?:response-style|style)(?:\s+(.*?))?\s*$/i.exec(input);
  if (!match) return null;
  const value = String(match[1] ?? "").trim();
  if (!value) return { kind: "picker" };
  const responseStyle = normalizeResponseStyle(value);
  return responseStyle ? { kind: "apply", responseStyle } : { kind: "error", value };
}

export interface ResponseStyleApplication {
  handled: boolean;
  responseStyle: ResponseStyle;
  openPicker: boolean;
  error: string | null;
}

/** Pure App integration seam: parse and apply without intercepting /continue. */
export function applyResponseStyleCommand(
  input: string,
  current: ResponseStyle,
): ResponseStyleApplication {
  const command = parseResponseStyleCommand(input);
  if (!command) return { handled: false, responseStyle: current, openPicker: false, error: null };
  if (command.kind === "picker") {
    return { handled: true, responseStyle: current, openPicker: true, error: null };
  }
  if (command.kind === "error") {
    return {
      handled: true,
      responseStyle: current,
      openPicker: false,
      error: `Unknown response style: ${command.value}`,
    };
  }
  return { handled: true, responseStyle: command.responseStyle, openPicker: false, error: null };
}
