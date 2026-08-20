/**
 * Subscription-provider login helpers for the TUI.
 * Official CLI login only; never display credential values.
 */

export const BROWSER_LOGIN_PROVIDERS = ["grok", "codex"] as const;

export type BrowserLoginProvider = (typeof BROWSER_LOGIN_PROVIDERS)[number];

export function browserLoginProviderForModel(spec: string): BrowserLoginProvider | null {
  const value = String(spec || "").trim().toLowerCase();
  if (value === "grok" || value === "grok-cli" || value.startsWith("grok:")) return "grok";
  if (value === "codex" || value.startsWith("codex:") || value === "chatgpt") return "codex";
  return null;
}

export function formatProviderLoginEvent(event: Record<string, unknown>): string {
  const status = String(event.status || "").trim();
  const label = String(event.label || event.provider || "provider");
  const detail = String(event.detail || "").trim();
  const urls = Array.isArray(event.urls) ? event.urls.map((url) => String(url)).filter(Boolean) : [];
  if (status === "starting") {
    return `${label}: opening the official browser sign-in page`;
  }
  if (status === "status") {
    const rows = Array.isArray(event.providers) ? event.providers : [];
    if (!rows.length) return detail || "no subscription providers reported";
    return rows.map((row) => {
      const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
      const name = String(item.label || item.provider || "provider");
      const ready = item.ready === true ? "signed in" : "needs sign-in";
      return `${name}: ${ready} · ${String(item.detail || "").trim()}`.trim();
    }).join("\n");
  }
  const urlLine = urls[0] ? `\n${urls[0]}` : "";
  return `${label}: ${detail || status}${urlLine}`;
}
